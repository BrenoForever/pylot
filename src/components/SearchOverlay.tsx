import { useEffect, useRef, useState, useCallback } from "react";
import type { Session } from "../types";
import { useSessions } from "../hooks/useSessions";
import { filterSessions, getAgentLabel, getRelativeTime } from "../hooks/useSessionUtils";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectSession: (session: Session) => void;
}

export function SearchOverlay({ isOpen, onClose, onSelectSession }: Props) {
  const { sessions } = useSessions();
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = filterSessions(sessions, query, null).slice(0, 10);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setHighlightedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results.length > 0) {
        onSelectSession(results[highlightedIndex]);
        onClose();
      }
    },
    [results, highlightedIndex, onClose, onSelectSession]
  );

  if (!isOpen) return null;

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-modal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="search-modal-input"
          placeholder="Search sessions by name, project, or agent..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlightedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="search-results">
          {results.length === 0 && query && (
            <div className="empty-state" style={{ padding: "20px" }}>
              <div className="empty-state-text">No results found</div>
            </div>
          )}
          {results.map((session, index) => (
            <div
              key={session.id}
              className={`search-result-item ${index === highlightedIndex ? "highlighted" : ""}`}
              onClick={() => {
                onSelectSession(session);
                onClose();
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              <div className="session-card-header">
                <div className="session-agent">
                  <span className="session-agent-name">
                    {getAgentLabel(session.source)}
                  </span>
                </div>
                <span className="session-time">
                  {getRelativeTime(session.timestamp)}
                </span>
              </div>
              <div className="session-project">{session.project_name}</div>
              <div className="session-summary">{session.summary}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
