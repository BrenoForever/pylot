import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, File, ChevronRight, ChevronDown } from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  modified: boolean;
}

interface Props {
  cwd: string | null;
}

export function FileExplorer({ cwd }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, FileEntry[]>>(
    {}
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    invoke<FileEntry[]>("get_file_tree", { path: cwd })
      .then(setEntries)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [cwd]);

  const toggleDir = useCallback(
    async (dirPath: string) => {
      if (expandedDirs[dirPath]) {
        const next = { ...expandedDirs };
        delete next[dirPath];
        setExpandedDirs(next);
      } else {
        try {
          const children = await invoke<FileEntry[]>("get_file_tree", {
            path: dirPath,
          });
          setExpandedDirs((prev) => ({ ...prev, [dirPath]: children }));
        } catch {}
      }
    },
    [expandedDirs]
  );

  if (!cwd) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📂</div>
        <div className="empty-state-text">No session selected</div>
        <div className="empty-state-hint">
          Click a session in the sidebar to browse its files
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">Loading files...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state">
        <div className="empty-state-text" style={{ color: "var(--red)" }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="file-explorer-path">{cwd}</span>
      </div>
      <div className="file-tree">
        {entries.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expandedDirs={expandedDirs}
            onToggleDir={toggleDir}
          />
        ))}
      </div>
    </div>
  );
}

function FileTreeNode({
  entry,
  depth,
  expandedDirs,
  onToggleDir,
}: {
  entry: FileEntry;
  depth: number;
  expandedDirs: Record<string, FileEntry[]>;
  onToggleDir: (path: string) => void;
}) {
  const isExpanded = !!expandedDirs[entry.path];
  const children = expandedDirs[entry.path];

  return (
    <>
      <div
        className={`file-tree-item ${entry.modified ? "modified" : ""}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          if (entry.is_dir) onToggleDir(entry.path);
        }}
      >
        {entry.is_dir ? (
          <>
            {isExpanded ? (
              <ChevronDown size={12} className="file-chevron" />
            ) : (
              <ChevronRight size={12} className="file-chevron" />
            )}
            <FolderOpen size={14} className="file-icon folder" />
          </>
        ) : (
          <>
            <span style={{ width: 12 }} />
            <File size={14} className="file-icon" />
          </>
        )}
        <span className="file-name">{entry.name}</span>
        {entry.modified && <span className="file-modified-dot" />}
      </div>
      {isExpanded &&
        children?.map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            onToggleDir={onToggleDir}
          />
        ))}
    </>
  );
}
