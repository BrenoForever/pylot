import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useCallback, useRef } from "react";
import type { Session, ActiveAgent } from "../types";

function sessionsEqual(a: Session[], b: Session[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].summary !== b[i].summary) return false;
  }
  return true;
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionsRef = useRef<Session[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<Session[]>("get_sessions");
      // Only update state if sessions actually changed
      if (!sessionsEqual(sessionsRef.current, result)) {
        sessionsRef.current = result;
        setSessions(result);
      }
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // No automatic polling — refresh only on mount or explicit call
  }, [refresh]);

  return { sessions, loading, error, refresh };
}

export function useActiveAgents() {
  const [agents, setAgents] = useState<ActiveAgent[]>([]);
  const agentsRef = useRef<ActiveAgent[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<ActiveAgent[]>("get_active_agents");
      // Only update if agents changed
      const changed =
        result.length !== agentsRef.current.length ||
        result.some((a, i) => a.pid !== agentsRef.current[i]?.pid);
      if (changed) {
        agentsRef.current = result;
        setAgents(result);
      }
    } catch {
      // Silently ignore errors
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { agents, refresh };
}
