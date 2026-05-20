import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, ManagedSession } from "../types";
import { GitBranch, Gauge, Diamond } from "lucide-react";

interface WorkspaceInfo {
  branch: string | null;
  worktree: string | null;
  model: string | null;
  effort: string | null;
}

interface Props {
  session: Session | null;
  managedSession: ManagedSession | null;
}

export function WorkspaceBar({ session, managedSession }: Props) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [elapsedTime, setElapsedTime] = useState("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!session?.cwd) {
      setInfo(null);
      return;
    }

    const fetchInfo = () => {
      invoke<WorkspaceInfo>("get_workspace_info", {
        cwd: session.cwd,
        source: session.source,
        sessionId: session.id,
      })
        .then(setInfo)
        .catch(() => setInfo(null));
    };

    fetchInfo();
    // Poll every 10s to detect model/branch/effort changes
    const interval = setInterval(fetchInfo, 10000);
    return () => clearInterval(interval);
  }, [session?.id, session?.cwd, session?.source]);

  // Update elapsed time for managed sessions
  useEffect(() => {
    if (!managedSession) {
      setElapsedTime("");
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    const update = () => {
      const ms = Date.now() - managedSession.startedAt;
      setElapsedTime(formatElapsed(ms));
    };

    update();
    intervalRef.current = setInterval(update, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [managedSession?.startedAt]);

  if (!session) {
    return (
      <div className="workspace-bar empty">
        <span className="workspace-bar-hint">Select a session to begin</span>
      </div>
    );
  }

  const projectName = session.project_name || session.cwd?.split("/").pop() || "—";
  const modelDisplay = info?.model ? formatModel(info.model) : null;
  const effortDisplay = info?.effort ? formatEffort(info.effort) : null;

  return (
    <div className="workspace-bar">
      <div className="workspace-bar-left">
        <span className="wb-project">{projectName}</span>

        {info?.branch && (
          <span className="wb-chip branch">
            <GitBranch size={11} />
            {info.worktree ? `worktree-${info.branch}` : info.branch}
          </span>
        )}

        {modelDisplay && (
          <span className="wb-chip model">
            <Diamond size={10} />
            {modelDisplay}
          </span>
        )}

        {effortDisplay && (
          <span className="wb-chip effort">
            <Gauge size={11} />
            {effortDisplay}
          </span>
        )}
      </div>

      <div className="workspace-bar-right">
        {managedSession && (
          <span className="wb-elapsed">
            ⏱ {elapsedTime}
          </span>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatEffort(effort: string): string {
  switch (effort.toLowerCase()) {
    case "xhigh": return "X-High";
    case "high": return "High";
    case "medium": return "Medium";
    case "low": return "Low";
    default: return effort;
  }
}

function formatModel(model: string): string {
  if (model.includes("claude-opus-4-6")) return "Opus 4.6";
  if (model.includes("claude-opus-4-5")) return "Opus 4.5";
  if (model.includes("claude-sonnet-4-6")) return "Sonnet 4.6";
  if (model.includes("claude-sonnet-4-5")) return "Sonnet 4.5";
  if (model.includes("claude-sonnet-4")) return "Sonnet 4";
  if (model.includes("claude-3-5-sonnet")) return "Sonnet 3.5";
  if (model.includes("claude-3-opus")) return "Opus 3";
  if (model.includes("claude-haiku-4")) return "Haiku 4";
  if (model.includes("gpt-5.5")) return "GPT-5.5";
  if (model.includes("gpt-5.4-mini")) return "GPT-5.4 mini";
  if (model.includes("gpt-5.4")) return "GPT-5.4";
  if (model.includes("gpt-5.3-codex")) return "GPT-5.3 Codex";
  if (model.includes("gpt-5.2-codex")) return "GPT-5.2 Codex";
  if (model.includes("gpt-5.2")) return "GPT-5.2";
  if (model.includes("gpt-5-mini")) return "GPT-5 mini";
  if (model.includes("gpt-4o")) return "GPT-4o";
  if (model.includes("gpt-4.1")) return "GPT-4.1";
  if (model.includes("o4-mini")) return "o4-mini";
  if (model.includes("o3")) return "o3";
  if (model.length <= 20) return model;
  return model.split("/").pop() || model;
}
