import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import type pg from "pg";
import {
  type Parameters,
  type Step,
  commitStepIndex,
  outputNames,
  validateParameters,
  validateWorkflowBody,
} from "@lba/shared";
import { type Db, tx } from "./db.ts";
import { TENANT, LEASE_SECONDS } from "./config.ts";
import { consoleRoutes } from "./console.ts";
import { HttpError, fail } from "./errors.ts";
import { frontDoor } from "./frontdoor.ts";
import { learnerRoutes } from "./learner/routes.ts";
import { KEY_RE, saveScreenshot, screenshotExists } from "./storage.ts";



// Stable JSON (sorted keys) so the same request always hashes the same.
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);

const fenceBody = {
  type: "object",
  required: ["agent_id", "attempt"],
  properties: { agent_id: { type: "string" }, attempt: { type: "integer" } },
};

/** Fencing: only the current attempt, by the Agent that holds it, on a running Run, may report. Locks the Run row. */
async function fenced(c: pg.PoolClient, runId: string, agentId: string, attempt: number) {
  const { rows } = await c.query(`SELECT * FROM runs WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [runId, TENANT]);
  const run = rows[0] ?? fail(404, "run not found");
  if (run.status !== "running" || run.attempt !== attempt || run.agent_id !== agentId) fail(409, "stale attempt");
  return run;
}

const runView = (r: pg.QueryResultRow, steps?: pg.QueryResultRow[]) => ({
  run_id: r.id,
  status: r.status,
  attempt: r.attempt,
  outputs: r.outputs,
  error: r.error,
  ...(steps && { steps }),
});

export function buildApp(db: Db) {
  const app = Fastify({ bodyLimit: 10 * 1024 * 1024, serverFactory: frontDoor });
  app.addContentTypeParser("image/png", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.setErrorHandler((err: Error & { statusCode?: number; details?: unknown }, _req, reply) => {
    const code = err.statusCode ?? 500;
    if (code >= 500) console.error(`engine  500 on ${_req.method} ${_req.url}:`, err); // Fastify's own logger is off, so say it ourselves
    reply.code(code).send({ error: code >= 500 && !(err instanceof HttpError) ? "internal error" : err.message, details: err.details });
  });

  // ---- Workflow Versions (review + publish) ----
  app.get<{ Params: { id: string } }>("/workflow-versions/:id", async (req) => {
    const { rows } = await db.query(`SELECT * FROM workflow_versions WHERE id = $1`, [req.params.id]);
    return rows[0] ?? fail(404, "workflow version not found");
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/workflow-versions/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { steps: { type: "array" }, target_map: { type: "object" }, parameters: { type: "object" } },
        },
      },
    },
    async (req) =>
      tx(db, async (c) => {
        const { rows } = await c.query(`SELECT * FROM workflow_versions WHERE id = $1 FOR UPDATE`, [req.params.id]);
        const v = rows[0] ?? fail(404, "workflow version not found");
        if (v.status !== "draft") fail(409, "only a draft can be edited; create a new draft instead");
        const next = { steps: v.steps, target_map: v.target_map, parameters: v.parameters, ...req.body };
        const problems = validateWorkflowBody(next);
        if (problems.length) fail(400, "invalid workflow", problems);
        const { rows: out } = await c.query(
          `UPDATE workflow_versions SET steps=$2, target_map=$3, parameters=$4, outputs=$5, commit_step=$6 WHERE id=$1 RETURNING *`,
          [v.id, JSON.stringify(next.steps), JSON.stringify(next.target_map), JSON.stringify(next.parameters),
           JSON.stringify(outputNames(next.steps as Step[])), commitStepIndex(next.steps as Step[])],
        );
        return out[0];
      }),
  );

  app.post<{ Params: { id: string } }>("/workflow-versions/:id/publish", async (req) =>
    tx(db, async (c) => {
      const { rows } = await c.query(`SELECT * FROM workflow_versions WHERE id = $1 FOR UPDATE`, [req.params.id]);
      const v = rows[0] ?? fail(404, "workflow version not found");
      if (v.status !== "draft") fail(409, "already published");
      const problems = validateWorkflowBody({ steps: v.steps, target_map: v.target_map, parameters: v.parameters });
      if (v.commit_step === null) problems.push("no commit step marked");
      if (!(v.steps as { action: string }[]).some((s) => s.action === "verify" || s.action === "read")) problems.push("no success check recorded: the Engine could not tell whether a run worked");
      if (problems.length) fail(422, "cannot publish", problems);
      const { rows: out } = await c.query(`UPDATE workflow_versions SET status='published' WHERE id=$1 RETURNING *`, [v.id]);
      return out[0];
    }),
  );

  // ---- Runs (Client App side) ----
  app.post<{ Params: { name: string }; Body: { target_instance_id: string; parameters: Record<string, unknown> }; Headers: { "idempotency-key": string } }>(
    "/workflows/:name/runs",
    {
      schema: {
        headers: { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", minLength: 1, maxLength: 255 } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["target_instance_id", "parameters"],
          properties: { target_instance_id: { type: "string" }, parameters: { type: "object" } },
        },
      },
    },
    async (req, reply) => {
      const key = req.headers["idempotency-key"];
      const { target_instance_id, parameters } = req.body;

      const { rows: inst } = await db.query(`SELECT * FROM target_instances WHERE id = $1 AND tenant_id = $2`, [target_instance_id, TENANT]);
      if (!inst[0]) fail(404, "target instance not found");

      const { rows: wf } = await db.query(`SELECT id, target_app_id FROM workflows WHERE name = $1`, [req.params.name]);
      if (!wf.length) fail(404, "workflow not found");
      const w = wf.find((x) => x.target_app_id === inst[0].target_app_id) ?? fail(422, "target instance runs a different Target App than this workflow");

      const { rows: ver } = await db.query(
        `SELECT * FROM workflow_versions WHERE workflow_id = $1 AND status = 'published' ORDER BY version DESC LIMIT 1`, [w.id]);
      const v = ver[0] ?? fail(409, "workflow has no published version");

      // Contract check BEFORE anything is stored or any browser is opened.
      const problems = validateParameters(v.id, v.parameters as Parameters, parameters);
      if (problems.length) fail(400, "invalid parameters", problems);

      const hash = createHash("sha256").update(canon({ w: req.params.name, target_instance_id, parameters })).digest("hex");
      const id = `run_${randomUUID()}`;
      const ins = await db.query(
        `INSERT INTO runs (id, tenant_id, target_instance_id, workflow_version_id, idempotency_key, request_hash, parameters)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
        [id, TENANT, target_instance_id, v.id, key, hash, JSON.stringify(parameters)],
      );
      if (ins.rowCount) return reply.code(202).send({ run_id: id, status: "queued" });

      const { rows } = await db.query(`SELECT id, status, request_hash FROM runs WHERE tenant_id = $1 AND idempotency_key = $2`, [TENANT, key]);
      if (rows[0].request_hash !== hash) fail(422, "Idempotency-Key was already used with a different request");
      return reply.code(202).send({ run_id: rows[0].id, status: rows[0].status });
    },
  );

  app.get<{ Params: { id: string } }>("/runs/:id", async (req) => {
    const { rows } = await db.query(`SELECT * FROM runs WHERE id = $1 AND tenant_id = $2`, [req.params.id, TENANT]);
    if (!rows[0]) fail(404, "run not found");
    const { rows: steps } = await db.query(
      `SELECT attempt, step_no, value_used, outcome, screenshot_key, duration_ms FROM run_steps WHERE run_id = $1 ORDER BY attempt, step_no`, [req.params.id]);
    return runView(rows[0], steps);
  });

  // A person settles a needs_review Run after checking the Target App by hand.
  app.post<{ Params: { id: string }; Body: { outcome: "succeeded" | "not_created"; outputs?: Record<string, string> } }>(
    "/runs/:id/resolution",
    { schema: { body: { type: "object", required: ["outcome"], properties: { outcome: { enum: ["succeeded", "not_created"] }, outputs: { type: "object" } } } } },
    async (req) => {
      const ok = req.body.outcome === "succeeded";
      const { rows } = await db.query(
        `UPDATE runs SET status = $3, outputs = $4, error = $5, finished_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'needs_review' RETURNING *`,
        [req.params.id, TENANT, ok ? "succeeded" : "failed", ok ? JSON.stringify(req.body.outputs ?? {}) : null, ok ? null : "reviewed: invoice was not created"]);
      return rows[0] ? runView(rows[0]) : fail(409, "run is not awaiting review");
    },
  );

  // ---- Agent side (outbound-only: the Agent calls us) ----
  app.post<{ Params: { id: string } }>("/agents/:id/claims", async (req, reply) => {
    const { rows: ag } = await db.query(`UPDATE agents SET last_seen_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING id`, [req.params.id, TENANT]);
    if (!ag[0]) fail(404, "agent not found");
    const { rows: insts } = await db.query(`SELECT id, base_url FROM target_instances WHERE agent_id = $1`, [req.params.id]);
    for (const { id: instId, base_url } of insts) {
      const claimed = await tx(db, async (c) => {
        // Lock the Target Instance so two claims cannot both count "0 running" and both start (deep dive 9.1).
        const { rows: [ti] } = await c.query(`SELECT concurrency_limit FROM target_instances WHERE id = $1 FOR UPDATE`, [instId]);
        const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM runs WHERE target_instance_id = $1 AND status = 'running'`, [instId]);
        if (n >= ti.concurrency_limit) return null;
        const { rows } = await c.query(
          `UPDATE runs SET status='running', agent_id=$2, attempt=attempt+1, started_at = COALESCE(started_at, now()), lease_expires_at = now() + make_interval(secs => $3)
           WHERE id = (SELECT id FROM runs WHERE target_instance_id=$1 AND status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING *`, [instId, req.params.id, LEASE_SECONDS]);
        if (!rows[0]) return null;
        const { rows: [v] } = await c.query(`SELECT steps, target_map, commit_step FROM workflow_versions WHERE id = $1`, [rows[0].workflow_version_id]);
        return { run_id: rows[0].id, attempt: rows[0].attempt, target_instance_id: instId, parameters: rows[0].parameters,
                 base_url, lease_expires_at: rows[0].lease_expires_at, workflow: v };
      });
      if (claimed) return claimed;
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { agent_id: string; attempt: number; step_no: number; value_used?: string; outcome: string; screenshot_key?: string; duration_ms: number } }>(
    "/runs/:id/steps",
    {
      schema: {
        body: {
          ...fenceBody,
          required: [...fenceBody.required, "step_no", "outcome", "duration_ms"],
          properties: { ...fenceBody.properties, step_no: { type: "integer" }, value_used: { type: "string" }, outcome: { enum: ["ok", "failed"] },
                        screenshot_key: { type: "string", pattern: KEY_RE.source }, duration_ms: { type: "integer" } },
        },
      },
    },
    async (req, reply) =>
      tx(db, async (c) => {
        const b = req.body;
        await fenced(c, req.params.id, b.agent_id, b.attempt);
        await c.query(
          `INSERT INTO run_steps (run_id, attempt, step_no, value_used, outcome, screenshot_key, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [req.params.id, b.attempt, b.step_no, b.value_used ?? null, b.outcome, b.screenshot_key ?? null, b.duration_ms]);
        await c.query(`UPDATE runs SET lease_expires_at = now() + make_interval(secs => $2) WHERE id = $1`, [req.params.id, LEASE_SECONDS]);
        return reply.code(204).send();
      }),
  );

  // Screenshots: Agent asks for an upload URL and sends the bytes straight to storage, not through the API (deep dive 9.5).
  app.post<{ Params: { id: string }; Body: { agent_id: string; attempt: number } }>(
    "/runs/:id/upload-url", { schema: { body: fenceBody } },
    async (req) =>
      tx(db, async (c) => {
        await fenced(c, req.params.id, req.body.agent_id, req.body.attempt);
        const key = `${req.params.id}-a${req.body.attempt}-${randomUUID().slice(0, 8)}.png`;
        return { key, upload_url: `/uploads/${key}` };
      }),
  );

  // ponytail: stand-in for an S3 pre-signed PUT; unauthenticated, fine because the MVP binds to 127.0.0.1.
  app.put<{ Params: { key: string }; Body: Buffer }>("/uploads/:key", async (req, reply) => {
    if (!KEY_RE.test(req.params.key) || !Buffer.isBuffer(req.body)) fail(400, "bad upload");
    saveScreenshot(req.params.key, req.body);
    return reply.code(204).send();
  });

  // Report-before-Save: the Agent may click the Commit Step only after this returns 200.
  app.post<{ Params: { id: string }; Body: { agent_id: string; attempt: number; screenshot_key: string } }>(
    "/runs/:id/commit-intent",
    { schema: { body: { ...fenceBody, required: [...fenceBody.required, "screenshot_key"], properties: { ...fenceBody.properties, screenshot_key: { type: "string" } } } } },
    async (req) =>
      tx(db, async (c) => {
        const b = req.body;
        await fenced(c, req.params.id, b.agent_id, b.attempt);
        if (!b.screenshot_key.startsWith(req.params.id) || !screenshotExists(b.screenshot_key)) fail(422, "pre-commit screenshot is mandatory");
        await c.query(
          `UPDATE runs SET commit_started_at = COALESCE(commit_started_at, now()), lease_expires_at = now() + make_interval(secs => $2) WHERE id = $1`,
          [req.params.id, LEASE_SECONDS]);
        return { ok: true };
      }),
  );

  app.post<{ Params: { id: string }; Body: { agent_id: string; attempt: number; status: "succeeded" | "failed"; outputs?: Record<string, string>; error?: string } }>(
    "/runs/:id/complete",
    { schema: { body: { ...fenceBody, required: [...fenceBody.required, "status"], properties: { ...fenceBody.properties, status: { enum: ["succeeded", "failed"] }, outputs: { type: "object" }, error: { type: "string" } } } } },
    async (req) =>
      tx(db, async (c) => {
        const b = req.body;
        const run = await fenced(c, req.params.id, b.agent_id, b.attempt);
        // The Agent cannot declare "safe to retry" once commit intent exists: a failure after that point needs a person.
        const status = b.status === "succeeded" ? "succeeded" : run.commit_started_at ? "needs_review" : "failed";
        const { rows: [v] } = await c.query(`SELECT outputs FROM workflow_versions WHERE id = $1`, [run.workflow_version_id]);
        const outputs = b.status === "succeeded" ? Object.fromEntries((v.outputs as string[]).map((k) => [k, b.outputs?.[k] ?? null])) : null;
        const { rows } = await c.query(
          `UPDATE runs SET status=$2, outputs=$3, error=$4, lease_expires_at=NULL, finished_at=now() WHERE id=$1 RETURNING *`,
          [run.id, status, outputs && JSON.stringify(outputs), b.status === "succeeded" ? null : (b.error ?? "failed")]);
        return runView(rows[0]);
      }),
  );

  learnerRoutes(app, db);
  consoleRoutes(app, db);
  return app;
}
