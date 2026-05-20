export type AgentSource = "ClaudeCode" | "Codex" | "CopilotCli";

export type SessionStatus = "Running" | "WaitingForInput" | "Idle";

export interface Session {
  id: string;
  source: AgentSource;
  project_name: string;
  summary: string;
  cwd: string | null;
  timestamp: string;
  status: SessionStatus | null;
}

export interface ActiveAgent {
  pid: number;
  source: AgentSource;
  session_id: string | null;
  cwd: string | null;
}

export type SessionGroup = {
  label: string;
  sessions: Session[];
};

export type TabType = "terminal" | "diff" | "files";

// Multi-session PTY tracking
export interface ManagedSession {
  sessionId: string;
  ptyId: string;
  agent: string;
  agentArgs: string[];
  cwd: string | null;
  startedAt: number;
  status?: SessionStatus;
}

export type SidebarTab = "active" | "history";

export type StatusFilter = "all" | "new" | "waiting" | "running";
