import type { Db } from "./db.ts";

/**
 * Expired lease, no commit intent  -> back to queued (nothing was saved), or failed after 3 attempts.
 * Expired lease, commit intent set -> needs_review (a person checks; never re-run).
 */
export async function sweepOnce(db: Db): Promise<number> {
  const r = await db.query(`
    UPDATE runs SET
      status = CASE WHEN commit_started_at IS NOT NULL THEN 'needs_review'
                    WHEN attempt >= 3 THEN 'failed' ELSE 'queued' END,
      error = CASE WHEN commit_started_at IS NOT NULL THEN 'agent lost after commit intent; outcome unknown'
                   WHEN attempt >= 3 THEN 'retry cap reached' END,
      finished_at = CASE WHEN commit_started_at IS NOT NULL OR attempt >= 3 THEN now() END,
      lease_expires_at = NULL
    WHERE status = 'running' AND lease_expires_at < now()`);
  return r.rowCount ?? 0;
}

export function startSweeper(db: Db, everyMs = 30_000) {
  const t = setInterval(() => sweepOnce(db).catch((e) => console.error("sweep failed", e)), everyMs);
  return () => clearInterval(t);
}
