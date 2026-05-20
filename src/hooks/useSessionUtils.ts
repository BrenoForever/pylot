import type { Session, SessionGroup, AgentSource } from "../types";

const AGENT_LABELS: Record<AgentSource, string> = {
  ClaudeCode: "Claude Code",
  Codex: "Codex",
  CopilotCli: "Copilot CLI",
};

export function getAgentLabel(source: AgentSource): string {
  return AGENT_LABELS[source];
}

export function getRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function groupSessions(sessions: Session[]): SessionGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const thisWeek = new Date(today.getTime() - 7 * 86400000);
  const lastWeek = new Date(today.getTime() - 14 * 86400000);

  const groups: Record<string, Session[]> = {
    Active: [],
    Today: [],
    Yesterday: [],
    "This Week": [],
    "Last Week": [],
    Older: [],
  };

  for (const session of sessions) {
    if (session.status === "Running" || session.status === "WaitingForInput") {
      groups["Active"].push(session);
      continue;
    }

    const ts = new Date(session.timestamp);
    if (ts >= today) {
      groups["Today"].push(session);
    } else if (ts >= yesterday) {
      groups["Yesterday"].push(session);
    } else if (ts >= thisWeek) {
      groups["This Week"].push(session);
    } else if (ts >= lastWeek) {
      groups["Last Week"].push(session);
    } else {
      groups["Older"].push(session);
    }
  }

  return Object.entries(groups)
    .filter(([, s]) => s.length > 0)
    .map(([label, sessions]) => ({ label, sessions }));
}

export function filterSessions(
  sessions: Session[],
  query: string,
  agentFilter: AgentSource | null
): Session[] {
  let filtered = sessions;

  if (agentFilter) {
    filtered = filtered.filter((s) => s.source === agentFilter);
  }

  if (query.trim()) {
    const q = query.toLowerCase();
    filtered = filtered.filter(
      (s) =>
        s.summary.toLowerCase().includes(q) ||
        s.project_name.toLowerCase().includes(q) ||
        getAgentLabel(s.source).toLowerCase().includes(q)
    );
  }

  return filtered;
}
