import { useState, useCallback, useRef, useEffect, memo } from "react";
import { TerminalTab } from "./TerminalTab";
import { TerminalTabBar, type TerminalInstance } from "./TerminalTabBar";

export type TerminalStatus = "Running" | "WaitingForInput";

interface Props {
  visible: boolean;
  initialCwd: string | null;
  onStatusChange?: (ptyId: string, status: TerminalStatus) => void;
  onTabClosed?: (ptyId: string) => void;
}

let idCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++idCounter}`;
}

// Inactivity timeout before marking as "WaitingForInput"
const IDLE_TIMEOUT_MS = 3000;

export const TerminalPanel = memo(function TerminalPanel({ visible, initialCwd, onStatusChange, onTabClosed }: Props) {
  const [instances, setInstances] = useState<TerminalInstance[]>(() => [
    {
      id: nextId("shell"),
      label: "zsh",
      cwd: initialCwd,
      type: "shell",
    },
  ]);
  const [activeId, setActiveId] = useState(instances[0].id);
  const cwdRef = useRef(initialCwd);
  const statusTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const statusRef = useRef<Map<string, TerminalStatus>>(new Map());

  // Update CWD ref for new terminals (doesn't affect existing ones)
  useEffect(() => {
    cwdRef.current = initialCwd;
  }, [initialCwd]);

  // Handle output from a terminal tab — mark as Running, set idle timer
  const handleOutput = useCallback(
    (ptyId: string) => {
      const prev = statusRef.current.get(ptyId);
      if (prev !== "Running") {
        statusRef.current.set(ptyId, "Running");
        onStatusChange?.(ptyId, "Running");
      }

      // Reset idle timer
      const existing = statusTimersRef.current.get(ptyId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        statusRef.current.set(ptyId, "WaitingForInput");
        onStatusChange?.(ptyId, "WaitingForInput");
      }, IDLE_TIMEOUT_MS);
      statusTimersRef.current.set(ptyId, timer);
    },
    [onStatusChange]
  );

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      statusTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  const handleNew = useCallback(() => {
    const newInst: TerminalInstance = {
      id: nextId("shell"),
      label: `zsh`,
      cwd: cwdRef.current,
      type: "shell",
    };
    setInstances((prev) => [...prev, newInst]);
    setActiveId(newInst.id);
  }, []);

  const handleClose = useCallback(
    (id: string) => {
      // Clear status timer
      const timer = statusTimersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        statusTimersRef.current.delete(id);
      }
      statusRef.current.delete(id);

      // Notify parent so managed session is released
      onTabClosed?.(id);

      setInstances((prev) => {
        const filtered = prev.filter((i) => i.id !== id);
        if (id === activeId && filtered.length > 0) {
          setActiveId(filtered[filtered.length - 1].id);
        }
        if (filtered.length === 0) {
          const fresh: TerminalInstance = {
            id: nextId("shell"),
            label: "zsh",
            cwd: cwdRef.current,
            type: "shell",
          };
          setActiveId(fresh.id);
          return [fresh];
        }
        return filtered;
      });
    },
    [activeId, onTabClosed]
  );

  const handleSwitch = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const handleRename = useCallback((id: string, label: string) => {
    setInstances((prev) =>
      prev.map((i) => (i.id === id ? { ...i, label } : i))
    );
  }, []);

  // Expose addAgent for external use (resume session)
  const addAgentTab = useCallback(
    (agent: string, agentArgs: string[], cwd: string | null, label?: string) => {
      const newInst: TerminalInstance = {
        id: nextId("agent"),
        label: label || agent.split("/").pop() || agent,
        cwd,
        type: "agent",
        agent,
        agentArgs,
      };
      setInstances((prev) => [...prev, newInst]);
      setActiveId(newInst.id);
      return newInst.id;
    },
    []
  );

  // Store the functions so App.tsx can call them
  const panelRef = useRef({ addAgentTab, newShell: handleNew });
  panelRef.current.addAgentTab = addAgentTab;
  panelRef.current.newShell = handleNew;

  useEffect(() => {
    (window as any).__pylotTerminalPanel = panelRef.current;
    return () => {
      delete (window as any).__pylotTerminalPanel;
    };
  }, []);

  // Keyboard: Cmd+[ / Cmd+] to cycle tabs, Cmd+N new terminal
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (!visible) return;
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === "n") {
        e.preventDefault();
        handleNew();
      }
      if (isMod && e.key === "[") {
        e.preventDefault();
        setInstances((prev) => {
          const idx = prev.findIndex((i) => i.id === activeId);
          const newIdx = (idx - 1 + prev.length) % prev.length;
          setActiveId(prev[newIdx].id);
          return prev;
        });
      }
      if (isMod && e.key === "]") {
        e.preventDefault();
        setInstances((prev) => {
          const idx = prev.findIndex((i) => i.id === activeId);
          const newIdx = (idx + 1) % prev.length;
          setActiveId(prev[newIdx].id);
          return prev;
        });
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [visible, activeId, handleNew]);

  return (
    <div className="terminal-panel" style={{ display: visible ? "flex" : "none" }}>
      <TerminalTabBar
        instances={instances}
        activeId={activeId}
        onSwitch={handleSwitch}
        onClose={handleClose}
        onNew={handleNew}
        onRename={handleRename}
      />
      <div className="terminal-instances">
        {instances.map((inst) => (
          <TerminalTab
            key={inst.id}
            ptyId={inst.id}
            cwd={inst.cwd}
            agent={inst.agent}
            agentArgs={inst.agentArgs}
            visible={visible && activeId === inst.id}
            onOutput={() => handleOutput(inst.id)}
            onExit={() => {}}
          />
        ))}
      </div>
    </div>
  );
});
