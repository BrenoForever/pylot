import { useState, useRef, useEffect, memo } from "react";
import { Terminal, Plus, X, Pencil } from "lucide-react";

export interface TerminalInstance {
  id: string;
  label: string;
  cwd: string | null;
  type: "shell" | "agent";
  agent?: string;
  agentArgs?: string[];
}

interface Props {
  instances: TerminalInstance[];
  activeId: string;
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, label: string) => void;
}

export const TerminalTabBar = memo(function TerminalTabBar({
  instances,
  activeId,
  onSwitch,
  onClose,
  onNew,
  onRename,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

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

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const startRename = (id: string, currentLabel: string) => {
    setContextMenu(null);
    setEditingId(id);
    setEditValue(currentLabel);
  };

  return (
    <div className="terminal-tab-bar">
      {instances.map((inst, idx) => (
        <div
          key={inst.id}
          className={`pty-tab ${activeId === inst.id ? "active" : ""}`}
          onClick={() => onSwitch(inst.id)}
          onDoubleClick={() => startRename(inst.id, inst.label)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, id: inst.id });
          }}
        >
          {inst.type === "shell" ? (
            <Terminal size={12} />
          ) : (
            <StatusDot status="running" />
          )}

          {editingId === inst.id ? (
            <input
              ref={inputRef}
              className="pty-tab-rename-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="pty-tab-label">{inst.label}</span>
          )}

          {/* First shell tab can't be closed */}
          {(idx > 0 || instances.length > 1) && (
            <span
              className="pty-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(inst.id);
              }}
            >
              <X size={10} />
            </span>
          )}
        </div>
      ))}

      <button className="pty-tab-add" onClick={onNew} title="New Terminal (⌘N)">
        <Plus size={13} />
      </button>

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x, position: "fixed" }}
        >
          <button
            className="context-menu-item"
            onClick={() => {
              const inst = instances.find((i) => i.id === contextMenu.id);
              if (inst) startRename(inst.id, inst.label);
            }}
          >
            <Pencil size={13} />
            Rename
          </button>
          <button
            className="context-menu-item danger"
            onClick={() => {
              onClose(contextMenu.id);
              setContextMenu(null);
            }}
          >
            <X size={13} />
            Close
          </button>
        </div>
      )}
    </div>
  );
});

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "running"
      ? "running"
      : status === "waiting"
        ? "waiting"
        : "idle";
  return <span className={`pty-tab-dot ${cls}`} />;
}
