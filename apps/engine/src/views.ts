import { TENANT } from "./config.ts";
import type { Db } from "./db.ts";

// Read-side queries for the console. The Run detail is what the Working / Done / Needs-review screens draw.

export type RunStep = { no: number; action: string; target: string; value?: string; commit: boolean; outcome?: string; value_used?: string | null; duration_ms?: number };

export async function runDetail(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT r.*, w.name AS workflow, v.version, v.steps AS defs, v.target_map
       FROM runs r
       JOIN workflow_versions v ON v.id = r.workflow_version_id
       JOIN workflows w ON w.id = v.workflow_id
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [id, TENANT],
  );
  const r = rows[0];
  if (!r) return null;
  const { rows: done } = await db.query(
    `SELECT step_no, value_used, outcome, duration_ms FROM run_steps WHERE run_id = $1 AND attempt = $2 ORDER BY step_no`,
    [id, r.attempt],
  );
  const steps: RunStep[] = (r.defs as { action: string; target: string; value?: string; commit?: boolean }[]).map((s, i) => {
    const d = done.find((x) => x.step_no === i);
    return { no: i + 1, action: s.action, target: s.target, value: s.value, commit: !!s.commit, outcome: d?.outcome, value_used: d?.value_used, duration_ms: d?.duration_ms };
  });
  const firstOpen = steps.findIndex((s) => s.outcome !== "ok");
  return {
    run_id: r.id as string,
    status: r.status as string,
    attempt: r.attempt as number,
    workflow: r.workflow as string,
    workflow_version_id: r.workflow_version_id as string,
    version: r.version as number,
    idempotency_key: r.idempotency_key as string,
    parameters: r.parameters as Record<string, unknown>,
    outputs: r.outputs as Record<string, string> | null,
    error: r.error as string | null,
    created_at: r.created_at as string,
    started_at: r.started_at as string | null,
    finished_at: r.finished_at as string | null,
    commit_started: r.commit_started_at !== null,
    target_map: r.target_map as Record<string, { by?: string; name?: string }>,
    steps,
    steps_done: steps.filter((s) => s.outcome === "ok").length,
    current_index: firstOpen < 0 ? null : firstOpen,
  };
}

export async function latestRunId(db: Db, targetInstanceId: string) {
  const { rows } = await db.query(
    `SELECT id FROM runs WHERE tenant_id = $1 AND target_instance_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [TENANT, targetInstanceId],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

export async function agentState(db: Db, agentId: string | null) {
  if (!agentId) return null;
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.last_seen_at,
            COALESCE(a.last_seen_at > now() - interval '15 seconds', false) AS online,
            (SELECT r.id FROM runs r WHERE r.agent_id = a.id AND r.status = 'running' LIMIT 1) AS working_on
       FROM agents a WHERE a.id = $1 AND a.tenant_id = $2`,
    [agentId, TENANT],
  );
  return (rows[0] as { id: string; name: string; last_seen_at: string | null; online: boolean; working_on: string | null } | undefined) ?? null;
}
