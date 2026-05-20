import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface FileDiff {
  file_path: string;
  status: string;
  diff: string;
}

interface Props {
  cwd: string | null;
}

export function DiffTab({ cwd }: Props) {
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    invoke<FileDiff[]>("get_git_diffs", { path: cwd })
      .then((result) => {
        setDiffs(result);
        if (result.length > 0 && !selectedFile) {
          setSelectedFile(result[0].file_path);
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [cwd]);

  if (!cwd) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📝</div>
        <div className="empty-state-text">No session selected</div>
        <div className="empty-state-hint">
          Click a session in the sidebar to view its diffs
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">Loading diffs...</div>
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

  if (diffs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">✓</div>
        <div className="empty-state-text">No changes</div>
        <div className="empty-state-hint">Working directory is clean</div>
      </div>
    );
  }

  const activeDiff = diffs.find((d) => d.file_path === selectedFile);

  return (
    <div className="diff-container">
      <div className="diff-file-list">
        {diffs.map((d) => (
          <div
            key={d.file_path}
            className={`diff-file-item ${selectedFile === d.file_path ? "active" : ""}`}
            onClick={() => setSelectedFile(d.file_path)}
          >
            <span
              className={`diff-status ${d.status === "new" ? "new" : "modified"}`}
            >
              {d.status === "new" ? "A" : "M"}
            </span>
            <span className="diff-file-name">{d.file_path}</span>
          </div>
        ))}
      </div>
      <div className="diff-content">
        {activeDiff && <DiffView diff={activeDiff.diff} />}
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="diff-view">
      {lines.map((line, i) => {
        let cls = "diff-line";
        if (line.startsWith("+") && !line.startsWith("+++")) {
          cls += " diff-add";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          cls += " diff-remove";
        } else if (line.startsWith("@@")) {
          cls += " diff-hunk";
        } else if (line.startsWith("diff ")) {
          cls += " diff-header";
        }
        return (
          <div key={i} className={cls}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}
