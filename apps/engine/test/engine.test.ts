// Prototype acceptance checks from Lesson 0004. Needs Postgres reachable through DATABASE_URL (see .env.example).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";

process.env.SCREENSHOT_DIR = mkdtempSync(join(tmpdir(), "shots-")); // storage.ts reads this at import time
const { testPool } = await import("./helpers.ts");
const { seed } = await import("../src/seed.ts");
const { buildApp } = await import("../src/server.ts");
const { sweepOnce } = await import("../src/sweeper.ts");

let db: pg.Pool;
let app: ReturnType<typeof buildApp>;

before(async () => {
  db = await testPool();
  app = buildApp(db);
});
after(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await db.query("TRUNCATE tenants, target_apps CASCADE");
  await seed(db);
});

const good = { customer: "Acme Ltd", invoice_date: "2026-10-12", amount: 50000 };
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload: payload as object, headers });
const startRun = (key: string | null, parameters: unknown = good) =>
  post("/workflows/create-invoice/runs", { target_instance_id: "demo", parameters }, key ? { "idempotency-key": key } : {});
const claim = () => post("/agents/agent-1/claims", {});
const fence = (c: { run_id: string; attempt: number }) => ({ agent_id: "agent-1", attempt: c.attempt });
const expireLease = (runId: string) => db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [runId]);
const status = async (runId: string) => (await app.inject({ url: `/runs/${runId}` })).json();

async function uploadShot(c: { run_id: string; attempt: number }) {
  const { key, upload_url } = (await post(`/runs/${c.run_id}/upload-url`, fence(c))).json();
  const put = await app.inject({ method: "PUT", url: upload_url, payload: Buffer.from("png"), headers: { "content-type": "image/png" } });
  assert.equal(put.statusCode, 204);
  return key as string;
}
const commitIntent = async (c: { run_id: string; attempt: number }) =>
  post(`/runs/${c.run_id}/commit-intent`, { ...fence(c), screenshot_key: await uploadShot(c) });

test("same Idempotency-Key twice -> same run_id, one Run; different body -> 422; no key -> 400", async () => {
  const a = await startRun("ORD-1");
  const b = await startRun("ORD-1");
  assert.equal(a.statusCode, 202);
  assert.equal(b.json().run_id, a.json().run_id);
  assert.equal((await db.query("SELECT count(*)::int n FROM runs")).rows[0].n, 1);
  assert.equal((await startRun("ORD-1", { ...good, amount: 1 })).statusCode, 422);
  assert.equal((await startRun(null)).statusCode, 400);
});

test("simultaneous retries with one key create exactly one Run", async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, () => startRun("ORD-RACE")));
  assert.equal(new Set(rs.map((r) => r.json().run_id)).size, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM runs")).rows[0].n, 1);
});

test("bad parameters -> 400 and nothing is queued", async () => {
  for (const p of [{ ...good, amount: "five hundred" }, { customer: "x" }, { ...good, extra: 1 }, { ...good, invoice_date: "12/10/2026" }])
    assert.equal((await startRun(`bad-${JSON.stringify(p)}`, p)).statusCode, 400);
  assert.equal((await db.query("SELECT count(*)::int n FROM runs")).rows[0].n, 0);
});

test("unknown instance 404, unknown workflow 404", async () => {
  assert.equal((await post("/workflows/create-invoice/runs", { target_instance_id: "nope", parameters: good }, { "idempotency-key": "k" })).statusCode, 404);
  assert.equal((await post("/workflows/nope/runs", { target_instance_id: "demo", parameters: good }, { "idempotency-key": "k" })).statusCode, 404);
});

test("Agent dies BEFORE Save -> sweeper re-queues; stale attempt is rejected; retry succeeds", async () => {
  const { run_id } = (await startRun("ORD-2")).json();
  const c1 = (await claim()).json();
  assert.equal(c1.attempt, 1);
  await expireLease(run_id);
  assert.equal(await sweepOnce(db), 1);
  assert.equal((await status(run_id)).status, "queued");

  const c2 = (await claim()).json();
  assert.equal(c2.attempt, 2);
  const stale = await post(`/runs/${run_id}/complete`, { ...fence(c1), status: "succeeded" });
  assert.equal(stale.statusCode, 409);

  const done = await post(`/runs/${run_id}/complete`, { ...fence(c2), status: "succeeded", outputs: { invoice_number: "INV-1001" } });
  assert.deepEqual([done.json().status, done.json().outputs], ["succeeded", { invoice_number: "INV-1001" }]);
});

test("Agent dies AFTER commit intent -> needs_review, never re-run; a person resolves it", async () => {
  const { run_id } = (await startRun("ORD-3")).json();
  const c = (await claim()).json();
  assert.equal((await commitIntent(c)).statusCode, 200);
  await expireLease(run_id);
  await sweepOnce(db);
  assert.equal((await status(run_id)).status, "needs_review");
  assert.equal((await claim()).statusCode, 204); // not claimable again
  assert.equal((await post(`/runs/${run_id}/resolution`, { outcome: "not_created" })).json().status, "failed");
  assert.equal((await post(`/runs/${run_id}/resolution`, { outcome: "not_created" })).statusCode, 409); // already settled
});

test("failure before commit intent -> failed; failure after -> needs_review", async () => {
  const a = (await startRun("ORD-4a")).json().run_id;
  const ca = (await claim()).json();
  assert.equal((await post(`/runs/${a}/complete`, { ...fence(ca), status: "failed", error: "field renamed" })).json().status, "failed");

  const b = (await startRun("ORD-4b")).json().run_id;
  const cb = (await claim()).json();
  await commitIntent(cb);
  assert.equal((await post(`/runs/${b}/complete`, { ...fence(cb), status: "failed", error: "verify timed out" })).json().status, "needs_review");
});

test("commit intent without a pre-commit screenshot -> 422, nothing recorded", async () => {
  const { run_id } = (await startRun("ORD-5")).json();
  const c = (await claim()).json();
  assert.equal((await post(`/runs/${run_id}/commit-intent`, { ...fence(c), screenshot_key: "missing.png" })).statusCode, 422);
  assert.equal((await db.query("SELECT commit_started_at FROM runs WHERE id = $1", [run_id])).rows[0].commit_started_at, null);
});

test("Concurrency Limit 1: parallel claims over many queued Runs start exactly one", async () => {
  for (let i = 0; i < 5; i++) await startRun(`ORD-C${i}`);
  const rs = await Promise.all(Array.from({ length: 8 }, () => claim()));
  assert.equal(rs.filter((r) => r.statusCode === 200).length, 1);
  assert.equal((await db.query("SELECT count(*)::int n FROM runs WHERE status = 'running'")).rows[0].n, 1);
});

test("retry cap: third lost attempt -> failed", async () => {
  const { run_id } = (await startRun("ORD-6")).json();
  for (let i = 0; i < 3; i++) {
    assert.equal((await claim()).statusCode, 200);
    await expireLease(run_id);
    await sweepOnce(db);
  }
  const s = await status(run_id);
  assert.deepEqual([s.status, s.error], ["failed", "retry cap reached"]);
});

test("Step reports are recorded and renew the lease", async () => {
  const { run_id } = (await startRun("ORD-7")).json();
  const c = (await claim()).json();
  await expireLease(run_id);
  const r = await post(`/runs/${run_id}/steps`, { ...fence(c), step_no: 0, value_used: "Acme Ltd", outcome: "ok", duration_ms: 120 });
  assert.equal(r.statusCode, 204);
  assert.equal(await sweepOnce(db), 0); // lease was renewed by the report
  assert.equal((await status(run_id)).steps.length, 1);
});

test("workflow bodies: unapproved actions and extra keys are rejected; publish needs a commit step; published is frozen", async () => {
  const draft = (steps: unknown[]) =>
    db.query(
      `INSERT INTO workflow_versions (id, workflow_id, version, status, steps, target_map, parameters, outputs, commit_step)
       VALUES ('wfv-d', 'wf-create-invoice', 2, 'draft', $1, '{"x":{}}', '{}', '[]', NULL) ON CONFLICT (id) DO UPDATE SET steps = $1, status = 'draft'`,
      [JSON.stringify(steps)],
    );
  await draft([{ action: "click", target: "x" }]);
  const patch = (payload: unknown) => app.inject({ method: "PATCH", url: "/workflow-versions/wfv-d", payload: payload as object });

  assert.equal((await patch({ steps: [{ action: "eval", target: "x", value: "alert(1)" }] })).statusCode, 400);
  assert.equal((await patch({ steps: [{ action: "click", target: "x", js: "alert(1)" }] })).statusCode, 400);
  assert.equal((await patch({ steps: [{ action: "click", target: "ghost" }] })).statusCode, 400); // target not in target_map
  assert.equal((await patch({ steps: [{ action: "fill", target: "x", value: "{{nope}}" }] })).statusCode, 400);

  assert.equal((await post("/workflow-versions/wfv-d/publish", {})).statusCode, 422); // no commit step
  assert.equal((await patch({ steps: [{ action: "click", target: "x", commit: true }] })).statusCode, 200);
  assert.equal((await post("/workflow-versions/wfv-d/publish", {})).statusCode, 422); // no success check
  assert.equal((await patch({ steps: [{ action: "click", target: "x", commit: true }, { action: "verify", target: "x" }] })).statusCode, 200);
  assert.equal((await post("/workflow-versions/wfv-d/publish", {})).statusCode, 200);
  assert.equal((await patch({ steps: [{ action: "click", target: "x" }] })).statusCode, 409); // frozen
});
