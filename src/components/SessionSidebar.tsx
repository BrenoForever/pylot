import { useState, useMemo, useCallback, useRef, useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, ActiveAgent, SidebarTab, StatusFilter } from "../types";
import { useSessions } from "../hooks/useSessions";
import {
  getAgentLabel,
  getRelativeTime,
} from "../hooks/useSessionUtils";
import { Plus, Archive, Trash2, Pencil, Play, ChevronLeft } from "lucide-react";

interface Props {
  selectedSession: Session | null;
  managedSessionIds: Set<string>;
  onSelectSession: (session: Session) => void;
  onResumeSession: (session: Session) => void;
  onNewSession: () => void;
  getSessionStatus: (sessionId: string) => string | null;
}

export const SessionSidebar = memo(function SessionSidebar({
  selectedSession,
  managedSessionIds,
  onSelectSession,
  onResumeSession,
  onNewSession,
  getSessionStatus,
}: Props) {
  const { sessions, loading, refresh } = useSessions();
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("active");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [activeAgents, setActiveAgents] = useState<ActiveAgent[]>([]);

  // Poll for active agents; only update state if data changed
  const prevAgentsRef = useRef<ActiveAgent[]>([]);
  useEffect(() => {
    const poll = () => {
      invoke<ActiveAgent[]>("get_active_agents")
        .then((agents) => {
          const changed =
            agents.length !== prevAgentsRef.current.length ||
            agents.some((a, i) => a.pid !== prevAgentsRef.current[i]?.pid);
          if (changed) {
            prevAgentsRef.current = agents;
            setActiveAgents(agents);
            refresh();
          }
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Active sessions: managed via UI OR detected as running on system
  const activeSessions = useMemo(() => {
    // Match active agents to sessions by CWD and source
    const agentMatchedIds = new Set<string>();
    for (const agent of activeAgents) {
      if (!agent.cwd) continue;
      for (const session of sessions) {
        if (
          session.source === agent.source &&
          session.cwd &&
          (session.cwd === agent.cwd ||
            agent.cwd.startsWith(session.cwd + "/") ||
            session.cwd.startsWith(agent.cwd + "/"))
        ) {
          agentMatchedIds.add(session.id);
          break;
        }
      }
    }

    return sessions.filter(
      (s) => managedSessionIds.has(s.id) || agentMatchedIds.has(s.id)
    );
  }, [sessions, managedSessionIds, activeAgents]);

  const historySessions = useMemo(() => {
    const activeIds = new Set(activeSessions.map((s) => s.id));
    return sessions.filter((s) => !activeIds.has(s.id));
  }, [sessions, activeSessions]);

  // Filter by search and status
  const filteredSessions = useMemo(() => {
    const base = sidebarTab === "active" ? activeSessions : historySessions;
    let filtered = base;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.summary.toLowerCase().includes(q) ||
          s.project_name.toLowerCase().includes(q) ||
          getAgentLabel(s.source).toLowerCase().includes(q)
      );
    }

    if (statusFilter !== "all" && sidebarTab === "active") {
      filtered = filtered.filter((s) => {
        const status = getSessionStatus(s.id);
        if (statusFilter === "waiting") return status === "WaitingForInput";
        if (statusFilter === "running") return status === "Running";
        if (statusFilter === "new") return status === "Idle" || !status;
        return true;
      });
    }

    // Limit history tab to 20 items max
    if (sidebarTab === "history") {
      filtered = filtered.slice(0, 20);
    }

    return filtered;
  }, [sidebarTab, activeSessions, historySessions, searchQuery, statusFilter, getSessionStatus]);

  const handleDoubleClick = useCallback(
    (session: Session) => {
      onResumeSession(session);
    },
    [onResumeSession]
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-top">
          <h1>Sessions</h1>
          <span className="session-count">{sessions.length} total</span>
        </div>
        <div className="sidebar-actions">
          <ChevronLeft size={16} className="sidebar-collapse-btn" />
          <button className="sidebar-add-btn" onClick={onNewSession} title="New session">
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="search-container">
        <input
          type="text"
          className="search-input"
          placeholder="Search sessions... (Cmd+K)"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Active / History tabs */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${sidebarTab === "active" ? "active" : ""}`}
          onClick={() => setSidebarTab("active")}
        >
          Active ({activeSessions.length})
        </button>
        <button
          className={`sidebar-tab ${sidebarTab === "history" ? "active" : ""}`}
          onClick={() => setSidebarTab("history")}
        >
          History ({historySessions.length > 20 ? "20+" : historySessions.length})
        </button>
      </div>

      {/* Status filters (only for active tab) */}
      {sidebarTab === "active" && activeSessions.length > 0 && (
        <div className="status-filters">
          <button
            className={`status-filter-pill ${statusFilter === "new" ? "active new" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "new" ? "all" : "new")}
          >
            <span className="sf-dot new" />
            New
          </button>
          <button
            className={`status-filter-pill ${statusFilter === "waiting" ? "active waiting" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "waiting" ? "all" : "waiting")}
          >
            <span className="sf-dot waiting" />
            Waiting
          </button>
          <button
            className={`status-filter-pill ${statusFilter === "running" ? "active running" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "running" ? "all" : "running")}
          >
            <span className="sf-dot running" />
            Running
          </button>
          <button className="sidebar-add-btn small" onClick={onNewSession}>
            <Plus size={12} />
          </button>
        </div>
      )}

      <div className="session-list">
        {loading && (
          <div className="empty-state">
            <div className="empty-state-text">Loading sessions...</div>
          </div>
        )}

        {!loading && filteredSessions.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-text">
              {sidebarTab === "active"
                ? "No active sessions"
                : "No sessions found"}
            </div>
            <div className="empty-state-hint">
              {sidebarTab === "active"
                ? "Double-click a session from History to start it"
                : "Start a Claude, Codex, or Copilot session"}
            </div>
          </div>
        )}

        {filteredSessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            isActive={selectedSession?.id === session.id}
            isManaged={managedSessionIds.has(session.id)}
            isSystemActive={sidebarTab === "active" && !managedSessionIds.has(session.id)}
            onClick={() => onSelectSession(session)}
            onDoubleClick={() => handleDoubleClick(session)}
            onResumeSession={() => onResumeSession(session)}
            onRefresh={refresh}
          />
        ))}
      </div>
    </aside>
  );
});

const SessionCard = memo(function SessionCard({
  session,
  isActive,
  isManaged,
  isSystemActive,
  onClick,
  onDoubleClick,
  onResumeSession,
  onRefresh,
}: {
  session: Session;
  isActive: boolean;
  isManaged: boolean;
  isSystemActive: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onResumeSession: () => void;
  onRefresh: () => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.summary);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const startRename = () => {
    setContextMenu(null);
    setRenameValue(session.summary);
    setIsRenaming(true);
    setTimeout(() => inputRef.current?.select(), 50);
  };

  const commitRename = async () => {
    if (!isRenaming) return;
    setIsRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed) {
      try {
        await invoke("rename_session", {
          sessionId: session.id,
          newName: trimmed,
        });
        onRefresh();
      } catch {}
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") commitRename();
    else if (e.key === "Escape") setIsRenaming(false);
  };

  const handleArchive = async () => {
    setContextMenu(null);
    try {
      await invoke("archive_session", { sessionId: session.id });
      onRefresh();
    } catch {}
  };

  const handleDelete = async () => {
    setContextMenu(null);
    try {
      await invoke("delete_session", { sessionId: session.id });
      onRefresh();
    } catch {}
  };

  const handleResume = () => {
    setContextMenu(null);
    onResumeSession();
  };

  // Status display — simplified: managed = "Active", system-detected = "Active"
  const effectiveStatusLabel = isManaged
    ? "Active"
    : isSystemActive
      ? "Active"
      : null;
  const statusClass = (isManaged || isSystemActive) ? "waiting" : "idle";

  // Short path
  const shortPath = session.cwd
    ? session.cwd.replace(/^\/Users\/[^/]+/, "~")
    : "";

  return (
    <>
      <div
        className={`session-card ${isActive ? "active" : ""}`}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={handleContextMenu}
      >
        <div className="session-card-top">
          {isRenaming ? (
            <input
              ref={inputRef}
              className="rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="session-name">{session.summary}</span>
          )}
          {effectiveStatusLabel && (
            <span className={`session-status-badge ${statusClass}`}>
              <span className="session-status-dot" />
              {effectiveStatusLabel}
            </span>
          )}
        </div>
        <div className="session-card-path">{shortPath}</div>
        <div className="session-card-bottom">
          <span className="session-card-meta">
            {getAgentLabel(session.source)}
          </span>
          <span className="session-card-meta">·</span>
          <span className="session-card-meta">
            {getRelativeTime(session.timestamp)}
          </span>
        </div>
      </div>

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button className="context-menu-item" onClick={handleResume}>
            <Play size={13} />
            Resume
          </button>
          <button className="context-menu-item" onClick={startRename}>
            <Pencil size={13} />
            Rename
          </button>
          <div className="context-menu-separator" />
          <button className="context-menu-item" onClick={handleArchive}>
            <Archive size={13} />
            Archive
          </button>
          <button className="context-menu-item danger" onClick={handleDelete}>
            <Trash2 size={13} />
            Delete
          </button>
        </div>
      )}
    </>
  );
});

