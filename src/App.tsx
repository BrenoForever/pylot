import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SessionSidebar } from "./components/SessionSidebar";
import { TerminalPanel, type TerminalStatus } from "./components/TerminalPanel";
import { DiffTab } from "./components/DiffTab";
import { FileExplorer } from "./components/FileExplorer";
import { SearchOverlay } from "./components/SearchOverlay";
import { WorkspaceBar } from "./components/WorkspaceBar";
import { Terminal, GitCompare, FolderTree } from "lucide-react";
import type { Session, TabType, ManagedSession, SessionStatus } from "./types";
import "./styles/global.css";

function App() {
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("terminal");
  const [searchOpen, setSearchOpen] = useState(false);
  const [managedSessions, setManagedSessions] = useState<ManagedSession[]>([]);

  // Stable set of managed session IDs — only changes when sessions are added/removed
  const managedSessionIds = useMemo(
    () => new Set(managedSessions.map((m) => m.sessionId)),
    [managedSessions]
  );

  // Use a ref to avoid re-rendering the whole tree on status changes
  const managedSessionsRef = useRef(managedSessions);
  managedSessionsRef.current = managedSessions;

  // Stable function — reads from ref, never causes re-render cascade
  const getSessionStatus = useCallback(
    (sessionId: string): SessionStatus | null => {
      const managed = managedSessionsRef.current.find((m) => m.sessionId === sessionId);
      if (!managed) return null;
      return managed.status || "WaitingForInput";
    },
    []
  );

  // Handle terminal status changes — only update state if status actually changed
  const handleTerminalStatusChange = useCallback(
    (ptyId: string, status: TerminalStatus) => {
      setManagedSessions((prev) => {
        const target = prev.find((m) => m.ptyId === ptyId);
        if (!target || target.status === status) return prev;
        return prev.map((m) =>
          m.ptyId === ptyId ? { ...m, status: status as SessionStatus } : m
        );
      });
    },
    []
  );

  // Resume a session — opens a new agent tab in TerminalPanel
  const handleResumeSession = useCallback(
    async (session: Session) => {
      // Check if already managed
      const existing = managedSessionsRef.current.find((m) => m.sessionId === session.id);
      if (existing) {
        setActiveTab("terminal");
        setSelectedSession(session);
        return;
      }

      try {
        const [agent, args] = await invoke<[string, string[]]>("resume_session", {
          source: session.source,
          sessionId: session.id,
        });

        // Add agent tab via TerminalPanel — capture the returned ptyId
        const panel = (window as any).__pylotTerminalPanel;
        let ptyId = "";
        if (panel) {
          ptyId = panel.addAgentTab(
            agent,
            args || [],
            session.cwd || null,
            session.project_name || agent.split("/").pop()
          );
        }

        const newManaged: ManagedSession = {
          sessionId: session.id,
          ptyId,
          agent,
          agentArgs: args || [],
          cwd: session.cwd || null,
          startedAt: Date.now(),
          status: "Running",
        };

        setManagedSessions((prev) => [...prev, newManaged]);
        setSelectedSession(session);
        setActiveTab("terminal");
      } catch (err) {
        console.error("Failed to resume session:", err);
      }
    },
    []
  );

  // Select session — just highlight in sidebar
  const handleSelectSession = useCallback((session: Session) => {
    setSelectedSession(session);
  }, []);

  // Handle tab closed — remove from managed sessions so it can be resumed again
  const handleTabClosed = useCallback((ptyId: string) => {
    setManagedSessions((prev) => prev.filter((m) => m.ptyId !== ptyId));
  }, []);

  // New shell terminal
  const handleNewSession = useCallback(() => {
    const panel = (window as any).__pylotTerminalPanel;
    if (panel?.newShell) {
      panel.newShell();
    }
    setActiveTab("terminal");
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTerminalFocused =
        target.closest(".terminal-container") !== null ||
        target.classList.contains("xterm-helper-textarea");

      if (isTerminalFocused) {
        if (e.metaKey && e.key === "k") {
          e.preventDefault();
          setSearchOpen((prev) => !prev);
        }
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
      if (isMod && e.key === "1") {
        e.preventDefault();
        setActiveTab("terminal");
      }
      if (isMod && e.key === "2") {
        e.preventDefault();
        setActiveTab("diff");
      }
      if (isMod && e.key === "3") {
        e.preventDefault();
        setActiveTab("files");
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen]);

  return (
    <div className="app-layout">
      <SessionSidebar
        selectedSession={selectedSession}
        managedSessionIds={managedSessionIds}
        onSelectSession={handleSelectSession}
        onResumeSession={handleResumeSession}
        onNewSession={handleNewSession}
        getSessionStatus={getSessionStatus}
      />

      <main className="main-panel">
        <div className="tab-bar">
          <button
            className={`tab-item ${activeTab === "terminal" ? "active" : ""}`}
            onClick={() => setActiveTab("terminal")}
          >
            <Terminal size={14} />
            Terminal
          </button>
          <button
            className={`tab-item ${activeTab === "diff" ? "active" : ""}`}
            onClick={() => setActiveTab("diff")}
          >
            <GitCompare size={14} />
            Diff
          </button>
          <button
            className={`tab-item ${activeTab === "files" ? "active" : ""}`}
            onClick={() => setActiveTab("files")}
          >
            <FolderTree size={14} />
            File Explorer
          </button>
        </div>

        <div className="content-area">
          <TerminalPanel
            visible={activeTab === "terminal"}
            initialCwd={selectedSession?.cwd || null}
            onStatusChange={handleTerminalStatusChange}
            onTabClosed={handleTabClosed}
          />

          {activeTab === "diff" && (
            <DiffTab cwd={selectedSession?.cwd ?? null} />
          )}
          {activeTab === "files" && (
            <FileExplorer cwd={selectedSession?.cwd ?? null} />
          )}
        </div>

        <WorkspaceBar
          session={selectedSession}
          managedSession={
            managedSessions.find((m) => m.sessionId === selectedSession?.id) || null
          }
        />
      </main>

      <SearchOverlay
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelectSession={(session) => {
          handleSelectSession(session);
          setSearchOpen(false);
        }}
      />
    </div>
  );
}

export default App;
