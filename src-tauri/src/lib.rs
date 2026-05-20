mod pty_manager;
mod sessions;

use base64::Engine as _;
use pty_manager::PtyManager;
use sessions::scanner;
use sessions::types::{ActiveAgent, AgentSource, Session};
use std::collections::HashMap;
use std::fs;
use std::process::Command;
use std::sync::{Mutex, RwLock};
use tauri::{Emitter, State};

struct AppState {
    pty_manager: RwLock<PtyManager>,
    renamed_sessions: Mutex<HashMap<String, String>>,
    archived_sessions: Mutex<Vec<String>>,
    deleted_sessions: Mutex<Vec<String>>,
}

fn renames_file_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = home.join(".pylot");
    let _ = fs::create_dir_all(&dir);
    dir.join("renames.json")
}

fn archived_file_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = home.join(".pylot");
    let _ = fs::create_dir_all(&dir);
    dir.join("archived.json")
}

fn deleted_file_path() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = home.join(".pylot");
    let _ = fs::create_dir_all(&dir);
    dir.join("deleted.json")
}

fn load_renames() -> HashMap<String, String> {
    let path = renames_file_path();
    if let Ok(content) = fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    }
}

fn save_renames(renames: &HashMap<String, String>) {
    let path = renames_file_path();
    if let Ok(json) = serde_json::to_string_pretty(renames) {
        let _ = fs::write(path, json);
    }
}

fn load_string_list(path: &std::path::Path) -> Vec<String> {
    if let Ok(content) = fs::read_to_string(path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn save_string_list(path: &std::path::Path, list: &[String]) {
    if let Ok(json) = serde_json::to_string_pretty(list) {
        let _ = fs::write(path, json);
    }
}

#[tauri::command]
async fn get_sessions(state: State<'_, AppState>) -> Result<Vec<Session>, String> {
    let deleted_ids: Vec<String> = state.deleted_sessions.lock()
        .map(|d| d.clone())
        .unwrap_or_default();
    let archived_ids: Vec<String> = state.archived_sessions.lock()
        .map(|a| a.clone())
        .unwrap_or_default();
    let renames: HashMap<String, String> = state.renamed_sessions.lock()
        .map(|r| r.clone())
        .unwrap_or_default();

    // Run heavy IO off the main thread
    let mut sessions = tokio::task::spawn_blocking(move || {
        scanner::scan_all_sessions()
    }).await.map_err(|e| e.to_string())?;

    sessions.retain(|s| !deleted_ids.contains(&s.id) && !archived_ids.contains(&s.id));

    for session in &mut sessions {
        if let Some(name) = renames.get(&session.id) {
            session.summary = name.clone();
        }
    }
    Ok(sessions)
}

#[tauri::command]
fn rename_session(
    session_id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut renames = state.renamed_sessions.lock().map_err(|e| e.to_string())?;
    renames.insert(session_id, new_name);
    save_renames(&renames);
    Ok(())
}

#[tauri::command]
fn archive_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut archived = state.archived_sessions.lock().map_err(|e| e.to_string())?;
    if !archived.contains(&session_id) {
        archived.push(session_id);
        save_string_list(&archived_file_path(), &archived);
    }
    Ok(())
}

#[tauri::command]
fn delete_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut deleted = state.deleted_sessions.lock().map_err(|e| e.to_string())?;
    if !deleted.contains(&session_id) {
        deleted.push(session_id);
        save_string_list(&deleted_file_path(), &deleted);
    }
    Ok(())
}

#[tauri::command]
async fn get_active_agents() -> Result<Vec<ActiveAgent>, String> {
    tokio::task::spawn_blocking(|| {
        let mut agents = Vec::new();
        let own_pid = std::process::id();

        let agent_binaries = [
            ("claude", AgentSource::ClaudeCode),
            ("codex", AgentSource::Codex),
            ("copilot", AgentSource::CopilotCli),
        ];

        for (binary, source) in &agent_binaries {
            if let Ok(output) = Command::new("pgrep").args(["-x", binary]).output() {
                if output.status.success() {
                    let pids = String::from_utf8_lossy(&output.stdout);
                    for pid_str in pids.lines() {
                        if let Ok(pid) = pid_str.trim().parse::<u32>() {
                            if pid == own_pid {
                                continue;
                            }
                            let cwd = get_process_cwd(pid);
                            agents.push(ActiveAgent {
                                pid,
                                source: source.clone(),
                                session_id: None,
                                cwd,
                            });
                        }
                    }
                }
            }
        }

        agents.dedup_by(|a, b| a.source == b.source && a.cwd == b.cwd && a.cwd.is_some());
        agents
    }).await.map_err(|e| e.to_string())
}

fn get_process_cwd(pid: u32) -> Option<String> {
    // On macOS, use lsof to get cwd (-a is critical to AND the filters)
    if let Ok(output) = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-Fn", "-d", "cwd"])
        .output()
    {
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if let Some(path) = line.strip_prefix('n') {
                if !path.is_empty() && path != "/" {
                    return Some(path.to_string());
                }
            }
        }
    }
    // Fallback: try parent process CWD (agent binaries often chdir to /)
    if let Ok(ppid_out) = Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
    {
        let ppid_str = String::from_utf8_lossy(&ppid_out.stdout).trim().to_string();
        if let Ok(ppid) = ppid_str.parse::<u32>() {
            if ppid > 1 {
                if let Ok(output) = Command::new("lsof")
                    .args(["-a", "-p", &ppid.to_string(), "-Fn", "-d", "cwd"])
                    .output()
                {
                    let text = String::from_utf8_lossy(&output.stdout);
                    for line in text.lines() {
                        if let Some(path) = line.strip_prefix('n') {
                            if !path.is_empty() && path != "/" {
                                return Some(path.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
fn spawn_pty(
    id: String,
    cwd: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let pty = state.pty_manager.read().map_err(|e| e.to_string())?;

    let app_output = app.clone();
    let app_exit = app.clone();
    let pty_id_output = id.clone();
    let pty_id_exit = id.clone();

    pty.spawn_shell(
        id.as_str(),
        cwd.as_deref(),
        move |data| {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            let _ = app_output.emit(&format!("pty-output-{}", pty_id_output), b64);
        },
        move || {
            let _ = app_exit.emit(&format!("pty-exit-{}", pty_id_exit), ());
        },
    )?;

    Ok(())
}

#[tauri::command]
fn spawn_agent_pty(
    id: String,
    agent: String,
    args: Vec<String>,
    cwd: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let pty = state.pty_manager.read().map_err(|e| e.to_string())?;

    let app_output = app.clone();
    let app_exit = app.clone();
    let pty_id_output = id.clone();
    let pty_id_exit = id.clone();

    pty.spawn_command(
        id.as_str(),
        &agent,
        &args,
        cwd.as_deref(),
        move |data| {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
            let _ = app_output.emit(&format!("pty-output-{}", pty_id_output), b64);
        },
        move || {
            let _ = app_exit.emit(&format!("pty-exit-{}", pty_id_exit), ());
        },
    )?;

    Ok(())
}

#[tauri::command]
fn write_pty(id: String, data: String, state: State<'_, AppState>) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let pty = state.pty_manager.read().map_err(|e| e.to_string())?;
    pty.write_to_pty(&id, &bytes)
}

#[tauri::command]
fn resize_pty(id: String, rows: u16, cols: u16, state: State<'_, AppState>) -> Result<(), String> {
    let pty = state.pty_manager.read().map_err(|e| e.to_string())?;
    pty.resize_pty(&id, rows, cols)
}

#[tauri::command]
fn close_pty(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let pty = state.pty_manager.read().map_err(|e| e.to_string())?;
    pty.close_pty(&id);
    Ok(())
}

#[tauri::command]
fn resume_session(source: String, session_id: String) -> Result<(String, Vec<String>), String> {
    let (cmd, args) = match source.as_str() {
        "ClaudeCode" => (
            "claude".to_string(),
            vec!["--resume".to_string(), session_id],
        ),
        "Codex" => ("codex".to_string(), vec!["resume".to_string(), session_id]),
        "CopilotCli" => (
            "copilot".to_string(),
            vec![format!("--resume={}", session_id)],
        ),
        _ => return Err(format!("Unknown agent source: {}", source)),
    };

    Ok((cmd, args))
}

#[derive(serde::Serialize)]
struct WorkspaceInfo {
    branch: Option<String>,
    worktree: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

#[tauri::command]
async fn get_workspace_info(cwd: String, source: String, session_id: String) -> WorkspaceInfo {
    tokio::task::spawn_blocking(move || {
        get_workspace_info_sync(&cwd, &source, &session_id)
    }).await.unwrap_or(WorkspaceInfo {
        branch: None,
        worktree: None,
        model: None,
        effort: None,
    })
}

fn get_workspace_info_sync(cwd: &str, source: &str, session_id: &str) -> WorkspaceInfo {
    use std::path::Path;

    let dir = Path::new(cwd);

    // Get git branch
    let branch = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
            } else {
                None
            }
        });

    // Get git worktree path (if different from main)
    let worktree = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(dir)
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                // Only show if it's a worktree (not the main repo)
                let common = Command::new("git")
                    .args(["rev-parse", "--git-common-dir"])
                    .current_dir(dir)
                    .output()
                    .ok();
                if let Some(common_out) = common {
                    let common_str = String::from_utf8_lossy(&common_out.stdout).trim().to_string();
                    if common_str != ".git" {
                        return Some(path);
                    }
                }
                None
            } else {
                None
            }
        });

    // Detect model from session data
    let (model, effort) = detect_model_info(&source, &session_id, &cwd);

    WorkspaceInfo {
        branch,
        worktree,
        model,
        effort,
    }
}

fn detect_model_info(source: &str, session_id: &str, _cwd: &str) -> (Option<String>, Option<String>) {
    match source {
        "ClaudeCode" => {
            // Claude Code: model is in assistant messages at message.model
            let home = dirs::home_dir().unwrap_or_default();
            let projects_dir = home.join(".claude").join("projects");
            if let Ok(dirs) = std::fs::read_dir(&projects_dir) {
                for dir_entry in dirs.flatten() {
                    let session_file = dir_entry.path().join(format!("{}.jsonl", session_id));
                    if session_file.exists() {
                        if let Ok(content) = std::fs::read_to_string(&session_file) {
                            let mut model = None;
                            // Read last 100 lines to find most recent assistant message
                            let lines: Vec<&str> = content.lines().collect();
                            for line in lines.iter().rev().take(100) {
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
                                    if val.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                                        // Model is nested: message.model
                                        if let Some(m) = val.get("message")
                                            .and_then(|msg| msg.get("model"))
                                            .and_then(|m| m.as_str())
                                        {
                                            model = Some(m.to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                            return (model, None);
                        }
                    }
                }
            }
            (None, None)
        }
        "Codex" => {
            // Codex uses config.toml with model and model_reasoning_effort
            let home = dirs::home_dir().unwrap_or_default();
            let config_path = home.join(".codex").join("config.toml");
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                // Try TOML parsing first, fall back to line-by-line for invalid TOML (duplicate keys)
                let (raw_model, explicit_effort) = if let Ok(val) = content.parse::<toml::Value>() {
                    let m = val.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
                    let e = val.get("model_reasoning_effort").and_then(|e| e.as_str()).map(|s| s.to_string());
                    (m, e)
                } else {
                    // Fallback: parse first occurrence of top-level model= and model_reasoning_effort=
                    let mut model_str = String::new();
                    let mut effort_str: Option<String> = None;
                    let mut in_section = false;
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.starts_with('[') {
                            in_section = true;
                            continue;
                        }
                        if in_section { continue; }
                        if trimmed.starts_with("model") && trimmed.contains('=') && model_str.is_empty() {
                            if let Some(val) = trimmed.split('=').nth(1) {
                                model_str = val.trim().trim_matches('"').to_string();
                            }
                        }
                        if trimmed.starts_with("model_reasoning_effort") && trimmed.contains('=') && effort_str.is_none() {
                            if let Some(val) = trimmed.split('=').nth(1) {
                                effort_str = Some(val.trim().trim_matches('"').to_string());
                            }
                        }
                    }
                    (model_str, effort_str)
                };

                let (model_name, embedded_effort) = parse_model_string(&raw_model);
                let effort = explicit_effort.or(embedded_effort);
                let model = if model_name.is_empty() { None } else { Some(model_name) };
                return (model, effort);
            }
            (None, None)
        }
        "CopilotCli" => {
            // Copilot CLI - model info not stored in session-store.db
            // Return a default based on what the tool uses
            (None, None)
        }
        _ => (None, None),
    }
}

/// Parse a model string that may contain an embedded effort level
/// e.g. "gpt-5.4-mini high" -> ("gpt-5.4-mini", Some("high"))
/// e.g. "claude-sonnet-4-6" -> ("claude-sonnet-4-6", None)
fn parse_model_string(raw: &str) -> (String, Option<String>) {
    let effort_levels = ["xhigh", "high", "medium", "low"];
    let trimmed = raw.trim();
    
    for effort in effort_levels {
        if trimmed.ends_with(&format!(" {}", effort)) {
            let model = trimmed[..trimmed.len() - effort.len() - 1].to_string();
            return (model, Some(effort.to_string()));
        }
    }
    
    (trimmed.to_string(), None)
}

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    modified: bool,
}

#[tauri::command]
fn get_file_tree(path: String) -> Result<Vec<FileEntry>, String> {
    use std::fs;
    use std::path::Path;

    let dir = Path::new(&path);
    if !dir.exists() || !dir.is_dir() {
        return Err(format!("Directory not found: {}", path));
    }

    // Get git modified files for this directory
    let modified_files: std::collections::HashSet<String> = Command::new("git")
        .args(["status", "--porcelain", "--short"])
        .current_dir(dir)
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| {
                    if line.len() > 3 {
                        Some(line[3..].trim().to_string())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let mut entries: Vec<FileEntry> = Vec::new();

    // Check .gitignore patterns
    let gitignore_entries: std::collections::HashSet<String> = Command::new("git")
        .args(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"])
        .current_dir(dir)
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(|l| l.trim_end_matches('/').to_string())
                .collect()
        })
        .unwrap_or_default();

    if let Ok(read_dir) = fs::read_dir(dir) {
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            // Skip hidden files and common ignored dirs
            if name.starts_with('.') {
                continue;
            }
            if gitignore_entries.contains(&name) {
                continue;
            }

            let file_path = entry.path();
            let relative = file_path
                .strip_prefix(dir)
                .unwrap_or(&file_path)
                .to_string_lossy()
                .to_string();

            let is_modified = modified_files.iter().any(|f| f.starts_with(&relative));

            entries.push(FileEntry {
                name: name.clone(),
                path: file_path.to_string_lossy().to_string(),
                is_dir: file_path.is_dir(),
                modified: is_modified,
            });
        }
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name))
    });

    Ok(entries)
}

#[derive(serde::Serialize)]
struct FileDiff {
    file_path: String,
    status: String,
    diff: String,
}

#[tauri::command]
fn get_git_diffs(path: String) -> Result<Vec<FileDiff>, String> {
    use std::path::Path;

    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(format!("Directory not found: {}", path));
    }

    let mut diffs = Vec::new();

    // Get staged + unstaged diffs
    let output = Command::new("git")
        .args(["diff", "--no-color"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    let staged_output = Command::new("git")
        .args(["diff", "--cached", "--no-color"])
        .current_dir(dir)
        .output()
        .map_err(|e| format!("Failed to run git diff --cached: {}", e))?;

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&staged_output.stdout)
    );

    // Parse diff output into per-file chunks
    let mut current_file = String::new();
    let mut current_diff = String::new();

    for line in combined.lines() {
        if line.starts_with("diff --git") {
            if !current_file.is_empty() {
                diffs.push(FileDiff {
                    file_path: current_file.clone(),
                    status: "modified".to_string(),
                    diff: current_diff.clone(),
                });
            }
            // Extract filename: "diff --git a/path b/path"
            current_file = line
                .split(" b/")
                .nth(1)
                .unwrap_or("unknown")
                .to_string();
            current_diff = format!("{}\n", line);
        } else {
            current_diff.push_str(line);
            current_diff.push('\n');
        }
    }

    if !current_file.is_empty() {
        diffs.push(FileDiff {
            file_path: current_file,
            status: "modified".to_string(),
            diff: current_diff,
        });
    }

    // Also get untracked files
    let untracked = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(dir)
        .output()
        .ok();

    if let Some(out) = untracked {
        for file in String::from_utf8_lossy(&out.stdout).lines() {
            if !file.is_empty() {
                diffs.push(FileDiff {
                    file_path: file.to_string(),
                    status: "new".to_string(),
                    diff: format!("(new file: {})", file),
                });
            }
        }
    }

    Ok(diffs)
}

#[tauri::command]
fn kill_agent(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        Command::new("kill")
            .arg(pid.to_string())
            .output()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
    }

    #[cfg(windows)]
    {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map_err(|e| format!("Failed to kill process {}: {}", pid, e))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            pty_manager: RwLock::new(PtyManager::new()),
            renamed_sessions: Mutex::new(load_renames()),
            archived_sessions: Mutex::new(load_string_list(&archived_file_path())),
            deleted_sessions: Mutex::new(load_string_list(&deleted_file_path())),
        })
        .invoke_handler(tauri::generate_handler![
            get_sessions,
            get_active_agents,
            rename_session,
            archive_session,
            delete_session,
            spawn_pty,
            spawn_agent_pty,
            write_pty,
            resize_pty,
            close_pty,
            resume_session,
            get_workspace_info,
            get_file_tree,
            get_git_diffs,
            kill_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
