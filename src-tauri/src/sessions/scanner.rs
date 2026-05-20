use crate::sessions::types::{AgentSource, Session};
use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Scan all agent session sources and return a unified list
pub fn scan_all_sessions() -> Vec<Session> {
    let mut sessions = Vec::new();
    sessions.extend(scan_claude_code());
    sessions.extend(scan_codex());
    sessions.extend(scan_copilot_cli());
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    sessions
}

/// Scan Claude Code sessions from ~/.claude/projects/
fn scan_claude_code() -> Vec<Session> {
    let mut sessions = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return sessions,
    };

    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return sessions;
    }

    let entries = match fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return sessions,
    };

    for entry in entries.flatten() {
        let project_path = entry.path();
        if !project_path.is_dir() {
            continue;
        }

        let project_dir_name = project_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Decode project path: "-Users-brenojorri-IdeaProjects-Foo" → last segment
        let decoded_path = project_dir_name.replacen('-', "/", 1).replace('-', "/");
        let display_name = decoded_path
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or(&project_dir_name)
            .to_string();

        let cwd_path = if decoded_path.starts_with('/') {
            Some(decoded_path.clone())
        } else {
            None
        };

        // Each project dir contains .jsonl files (one per session)
        let jsonl_files = match fs::read_dir(&project_path) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for file_entry in jsonl_files.flatten() {
            let file_path = file_entry.path();
            if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }

            if let Some(session) =
                parse_claude_session(&file_path, &display_name, cwd_path.as_deref())
            {
                sessions.push(session);
            }
        }
    }

    sessions
}

fn parse_claude_session(
    path: &PathBuf,
    project_name: &str,
    project_cwd: Option<&str>,
) -> Option<Session> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};

    let file = fs::File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    if file_len == 0 {
        return None;
    }

    let mut session_id = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let mut summary = String::new();
    let mut timestamp: Option<DateTime<Utc>> = None;
    let mut cwd: Option<String> = project_cwd.map(String::from);

    // Read only first 50 lines to extract summary, cwd, session_id
    let reader = BufReader::new(&file);
    for line in reader.lines().take(50) {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if let Ok(val) = serde_json::from_str::<Value>(&line) {
            let msg_type = val.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match msg_type {
                "user" => {
                    if summary.is_empty() {
                        if let Some(content) = val.get("message").and_then(|m| m.get("content")) {
                            if let Some(text) = content.as_str() {
                                summary = text.chars().take(120).collect();
                            } else if let Some(arr) = content.as_array() {
                                for item in arr {
                                    if let Some(text) =
                                        item.get("text").and_then(|t| t.as_str())
                                    {
                                        summary = text.chars().take(120).collect();
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if cwd.is_none() {
                        if let Some(c) = val.get("cwd").and_then(|v| v.as_str()) {
                            cwd = Some(c.to_string());
                        }
                    }
                    if timestamp.is_none() {
                        if let Some(ts) = val.get("timestamp").and_then(|t| t.as_str()) {
                            if let Ok(dt) = ts.parse::<DateTime<Utc>>() {
                                timestamp = Some(dt);
                            }
                        }
                    }
                    if let Some(sid) = val.get("sessionId").and_then(|s| s.as_str()) {
                        session_id = sid.to_string();
                    }
                }
                "ai-title" => {
                    if let Some(title) = val.get("aiTitle").and_then(|t| t.as_str()) {
                        summary = title.to_string();
                    }
                }
                _ => {}
            }
        }
    }

    // Read last 4KB to find timestamp from recent messages
    if timestamp.is_none() && file_len > 0 {
        let mut file2 = fs::File::open(path).ok()?;
        let seek_pos = if file_len > 4096 { file_len - 4096 } else { 0 };
        file2.seek(SeekFrom::Start(seek_pos)).ok()?;
        let reader2 = BufReader::new(file2);
        for line in reader2.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if let Some(ts) = val.get("timestamp").and_then(|t| t.as_str()) {
                    if let Ok(dt) = ts.parse::<DateTime<Utc>>() {
                        timestamp = Some(dt);
                    }
                }
            }
        }
    }

    if summary.is_empty() {
        summary = "(empty session)".to_string();
    }

    Some(Session {
        id: session_id,
        source: AgentSource::ClaudeCode,
        project_name: project_name.to_string(),
        summary,
        cwd,
        timestamp: timestamp.unwrap_or_else(Utc::now),
        status: None,
    })
}

/// Scan Codex sessions using history.jsonl (primary) and session files (metadata)
fn scan_codex() -> Vec<Session> {
    let mut sessions = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return sessions,
    };

    // Build a map of session_id -> cwd from session files
    let mut session_cwd: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let sessions_dir = home.join(".codex").join("sessions");
    if sessions_dir.exists() {
        let walker = glob::glob(&sessions_dir.join("**/*.jsonl").to_string_lossy());
        if let Ok(paths) = walker {
            for path in paths.flatten() {
                if let Ok(content) = fs::read_to_string(&path) {
                    if let Some(first_line) = content.lines().next() {
                        if let Ok(val) = serde_json::from_str::<Value>(first_line) {
                            if val.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                                if let Some(payload) = val.get("payload") {
                                    let id = payload
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let cwd = payload
                                        .get("cwd")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    if !id.is_empty() && !cwd.is_empty() {
                                        session_cwd.insert(id, cwd);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Parse history.jsonl — format: {"session_id":"...","ts":unix_seconds,"text":"..."}
    let history_file = home.join(".codex").join("history.jsonl");
    if history_file.exists() {
        if let Ok(content) = fs::read_to_string(&history_file) {
            // Group history entries by session_id, take only first message per session
            let mut seen_sessions: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            for line in content.lines() {
                if let Ok(val) = serde_json::from_str::<Value>(line) {
                    let id = val
                        .get("session_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();

                    if id.is_empty() || seen_sessions.contains(&id) {
                        continue;
                    }
                    seen_sessions.insert(id.clone());

                    let summary: String = val
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("(no summary)")
                        .chars()
                        .take(120)
                        .collect();

                    let cwd = session_cwd.get(&id).cloned();

                    let project_name = cwd
                        .as_ref()
                        .and_then(|p| p.rsplit('/').find(|s| !s.is_empty()))
                        .unwrap_or("Codex")
                        .to_string();

                    // ts is in Unix seconds
                    let mut timestamp = Utc::now();
                    if let Some(ts) = val.get("ts").and_then(|t| t.as_i64()) {
                        if let Some(dt) = Utc.timestamp_opt(ts, 0).single() {
                            timestamp = dt;
                        }
                    }

                    sessions.push(Session {
                        id,
                        source: AgentSource::Codex,
                        project_name,
                        summary,
                        cwd,
                        timestamp,
                        status: None,
                    });
                }
            }
        }
    }

    sessions
}

/// Scan Copilot CLI sessions from ~/.copilot/session-store.db
fn scan_copilot_cli() -> Vec<Session> {
    let mut sessions = Vec::new();
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return sessions,
    };

    let db_path = home.join(".copilot").join("session-store.db");
    if !db_path.exists() {
        return sessions;
    }

    let conn = match rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(_) => return sessions,
    };

    let query = "SELECT s.id, s.cwd, s.repository, s.branch, s.summary, s.created_at, s.updated_at \
                 FROM sessions s \
                 WHERE EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id) \
                 ORDER BY s.updated_at DESC";

    let mut stmt = match conn.prepare(query) {
        Ok(s) => s,
        Err(_) => return sessions,
    };

    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let cwd: Option<String> = row.get(1)?;
        let repository: Option<String> = row.get(2)?;
        let _branch: Option<String> = row.get(3)?;
        let summary: Option<String> = row.get(4)?;
        let _created_at: Option<String> = row.get(5)?;
        let updated_at: Option<String> = row.get(6)?;

        Ok((id, cwd, repository, summary, updated_at))
    });

    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let (id, cwd, repository, summary, updated_at) = row;

            let project_name = repository
                .as_ref()
                .and_then(|r| r.rsplit('/').next())
                .or_else(|| cwd.as_ref().and_then(|p| p.rsplit('/').find(|s| !s.is_empty())))
                .unwrap_or("Copilot")
                .to_string();

            let display_summary = summary.unwrap_or_else(|| "(copilot session)".to_string());

            let timestamp = updated_at
                .and_then(|ts| ts.parse::<DateTime<Utc>>().ok())
                .unwrap_or_else(Utc::now);

            sessions.push(Session {
                id,
                source: AgentSource::CopilotCli,
                project_name,
                summary: display_summary.chars().take(120).collect(),
                cwd,
                timestamp,
                status: None,
            });
        }
    }

    sessions
}
