// End to end: Engine (real HTTP) + demo billing app (real process) + Agent (real headless Chromium).
// Needs Postgres reachable through DATABASE_URL (see .env.example) and the Playwright Chromium install.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";

process.env.SCREENSHOT_DIR = mkdtempSync(join(tmpdir(), "agent-shots-")); // the Engine's storage reads this at import time
const { testPool } = await import("../../engine/test/helpers.ts");
const { seed } = await import("../../engine/src/seed.ts");
const { buildApp } = await import("../../engine/src/server.ts");
const { sweepOnce } = await import("../../engine/src/sweeper.ts");
const { loadConfig } = await import("../src/engine.ts");
const { Abort, runNext } = await import("../src/run.ts");

const OK_PORT = 4100;
const DRIFT_PORT = 4101; // the same app with the Customer field renamed
const DEMO_DIR = join(import.meta.dirname, "../../demo-billing");

let db: pg.Pool;
let app: ReturnType<typeof buildApp>;
let engineUrl: string;
let cfg: ReturnType<typeof loadConfig>;
const demos: ChildProcess[] = [];

const startDemo = async (port: number, env: Record<string, string> = {}) => {
  demos.push(spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: DEMO_DIR, env: { ...process.env, PORT: String(port), ...env }, stdio: "ignore" }));
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error(`demo app on ${port} did not start`);
};
const invoiceCount = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/`)).text()).match(/<td>INV-[0-9]+<\/td>/g) ?? []).length;

before(async () => {
  db = await testPool();
  app = buildApp(db);
  engineUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  cfg = loadConfig({ ENGINE_URL: engineUrl, HEADLESS: "1", ACTION_TIMEOUT_MS: "3000", SLOWMO_MS: "0" });
  await Promise.all([startDemo(OK_PORT), startDemo(DRIFT_PORT, { DRIFT: "1" })]);
});
after(async () => {
  demos.forEach((d) => d.kill());
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await db.query("TRUNCATE tenants, target_apps CASCADE");
  await seed(db);
  await db.query("UPDATE target_instances SET base_url = $1", [`http://127.0.0.1:${OK_PORT}`]);
});

const params = { customer: "Acme Ltd", invoice_date: "2026-10-12", amount: 50000 };
const sendRun = async (key: string) => {
  const r = await fetch(`${engineUrl}/workflows/create-invoice/runs`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ target_instance_id: "demo", parameters: params }),
  });
  assert.equal(r.status, 202);
  return ((await r.json()) as { run_id: string }).run_id;
};
const getRun = async (id: string) => (await fetch(`${engineUrl}/runs/${id}`)).json() as Promise<{ status: string; outputs: Record<string, string> | null; error: string | null; steps: unknown[] }>;
const expireLease = (id: string) => db.query("UPDATE runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);

test("a run creates the invoice in the billing app and returns its number", async () => {
  const before = await invoiceCount(OK_PORT);
  const id = await sendRun("A-1");
  assert.equal(await runNext(cfg), true);

  const run = await getRun(id);
  assert.equal(run.status, "succeeded");
  assert.match(run.outputs?.invoice_number ?? "", /^INV-[0-9]+$/);
  assert.equal(run.steps.length, 6);
  assert.equal(await invoiceCount(OK_PORT), before + 1);
  const row = (await db.query("SELECT commit_started_at FROM runs WHERE id = $1", [id])).rows[0];
  assert.notEqual(row.commit_started_at, null); // Save was announced before it was clicked
});

test("the same Idempotency-Key again: same run, nothing for the Agent to do, no second invoice", async () => {
  const id = await sendRun("B-1");
  await runNext(cfg);
  const afterFirst = await invoiceCount(OK_PORT);
  assert.equal(await sendRun("B-1"), id);
  assert.equal(await runNext(cfg), false);
  assert.equal(await invoiceCount(OK_PORT), afterFirst);
});

test("a field renamed in the billing app: the run fails before Save and creates nothing", async () => {
  await db.query("UPDATE target_instances SET base_url = $1", [`http://127.0.0.1:${DRIFT_PORT}`]);
  const before = await invoiceCount(DRIFT_PORT);
  const id = await sendRun("C-1");
  await runNext(cfg);

  const run = await getRun(id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /fill customer/);
  assert.equal(await invoiceCount(DRIFT_PORT), before);
});

test("Agent dies BEFORE announcing Save: the run is re-queued and a second attempt succeeds", async () => {
  const before = await invoiceCount(OK_PORT);
  const id = await sendRun("D-1");
  await assert.rejects(runNext(cfg, { beforeCommitIntent: () => { throw new Abort("simulated crash"); } }), /simulated crash/);

  await expireLease(id);
  await sweepOnce(db);
  assert.equal((await getRun(id)).status, "queued");

  assert.equal(await runNext(cfg), true);
  assert.equal((await getRun(id)).status, "succeeded");
  assert.equal(await invoiceCount(OK_PORT), before + 1); // exactly one invoice, not two
});

test("Agent dies AFTER announcing Save: the run goes to needs_review and is never run again", async () => {
  const id = await sendRun("E-1");
  await assert.rejects(runNext(cfg, { afterCommitIntent: () => { throw new Abort("simulated crash"); } }), /simulated crash/);

  await expireLease(id);
  await sweepOnce(db);
  assert.equal((await getRun(id)).status, "needs_review");
  assert.equal(await runNext(cfg), false); // not claimable again
});
