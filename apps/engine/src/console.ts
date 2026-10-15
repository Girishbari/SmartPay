import type { FastifyInstance } from "fastify";
import { PUBLIC_URL, RECORDER, TENANT } from "./config.ts";
import type { Db } from "./db.ts";
import { fail } from "./errors.ts";
import { latestRecording } from "./learner/routes.ts";
import { agentState, latestRunId, runDetail } from "./views.ts";

async function reachable(url: string | null) {
  if (!url) return false;
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) }); // any HTTP answer means the billing app is up
    return true;
  } catch {
    return false;
  }
}

/** One read for the whole console page: connections, the workflow's latest draft and published version, the recording, the latest run. */
export function consoleRoutes(app: FastifyInstance, db: Db) {
  app.get<{ Querystring: { workflow?: string } }>("/console/state", async (req) => {
    const name = req.query.workflow ?? "create-invoice";
    const { rows: [inst] } = await db.query(`SELECT * FROM target_instances WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [TENANT]);
    if (!inst) fail(404, "no target instance configured");

    const { rows: versions } = await db.query(
      `SELECT v.id, v.version, v.status, v.steps, v.target_map, v.parameters, v.outputs, v.commit_step, v.examples
         FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
        WHERE w.target_app_id = $1 AND w.name = $2 ORDER BY v.version DESC`,
      [inst.target_app_id, name],
    );
    const published = versions.find((v) => v.status === "published") ?? null;
    const draft = versions.find((v) => v.status === "draft" && (!published || v.version > published.version)) ?? null;
    const runId = await latestRunId(db, inst.id);

    return {
      server_now: new Date().toISOString(),
      engine_url: PUBLIC_URL,
      recorder: RECORDER,
      instance: { id: inst.id, base_url: inst.base_url, concurrency_limit: inst.concurrency_limit, reachable: await reachable(inst.base_url) },
      agent: await agentState(db, inst.agent_id),
      workflow: { name, published, draft },
      recording: latestRecording(),
      run: runId ? await runDetail(db, runId) : null,
    };
  });
}
