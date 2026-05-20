use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AgentSource {
    ClaudeCode,
    Codex,
    CopilotCli,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Running,
    WaitingForInput,
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub source: AgentSource,
    pub project_name: String,
    pub summary: String,
    pub cwd: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub status: Option<SessionStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveAgent {
    pub pid: u32,
    pub source: AgentSource,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}
