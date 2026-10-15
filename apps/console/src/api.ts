import { useCallback, useEffect, useRef, useState } from "react";

// Mirrors GET /console/state on the Engine.
export type Step = { action: string; target: string; value?: string; into?: string; commit?: boolean };
export type Locator = { by?: string; name?: string };
export type Params = Record<string, { type: "string" | "number" | "date"; required: boolean }>;

export type Version = {
  id: string; version: number; status: "draft" | "published";
  steps: Step[]; target_map: Record<string, Locator>; parameters: Params;
  outputs: string[]; commit_step: number | null; examples: Record<string, string> | null;
};
export type RunStep = { no: number; action: string; target: string; value?: string; commit: boolean; outcome?: string; value_used?: string | null; duration_ms?: number };
export type Run = {
  run_id: string; status: "queued" | "running" | "succeeded" | "failed" | "needs_review"; attempt: number;
  workflow: string; workflow_version_id: string; version: number; idempotency_key: string;
  parameters: Record<string, unknown>; outputs: Record<string, string> | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null; commit_started: boolean;
  target_map: Record<string, Locator>; steps: RunStep[]; steps_done: number; current_index: number | null;
};
export type Recording = {
  id: string; workflow_name: string; status: "recording" | "done" | "failed" | "cancelled";
  workflow_version_id?: string; error?: string; problems?: string[];
  progress: { filled: string[]; save_pressed: boolean; learning: boolean; notice?: string };
};
export type Agent = { id: string; name: string; last_seen_at: string | null; online: boolean; working_on: string | null };
export type ConsoleState = {
  server_now: string; engine_url: string; recorder: "window" | "tab";
  instance: { id: string; base_url: string | null; concurrency_limit: number; reachable: boolean };
  agent: Agent | null;
  workflow: { name: string; published: Version | null; draft: Version | null };
  recording: Recording | null;
  run: Run | null;
};

export class ApiError extends Error {
  constructor(message: string, public details: string[] = []) { super(message); }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, Array.isArray(data.details) ? data.details : []);
  return data as T;
}

/** Polls the console state. `down` is true while the Engine itself cannot be reached. */
export function useConsoleState(everyMs = 1500) {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [down, setDown] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api<ConsoleState>("/console/state");
      if (alive.current) { setState(s); setDown(false); }
    } catch {
      if (alive.current) setDown(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), everyMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [refresh, everyMs]);

  return { state, down, refresh };
}

/** Seconds-accurate "now" that follows the server's clock, so elapsed timers do not depend on the laptop clock. */
export function useServerNow(serverNow: string | undefined) {
  const offset = useRef(0);
  if (serverNow) offset.current = Date.parse(serverNow) - Date.now();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return Date.now() + offset.current;
}
