// Console + Learner checks. Needs Postgres reachable through DATABASE_URL (see .env.example).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";

process.env.SCREENSHOT_DIR = mkdtempSync(join(tmpdir(), "shots-"));
const { testPool } = await import("./helpers.ts");
const { seed } = await import("../src/seed.ts");
const { buildApp } = await import("../src/server.ts");

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
  await db.query("UPDATE target_instances SET base_url = 'http://127.0.0.1:1'"); // nothing listens on port 1
});

const RECORDING = `test('test', async ({ page }) => {
  await page.goto('http://127.0.0.1:4000/');
  await page.getByRole('textbox', { name: 'Customer' }).click();
  await page.getByRole('textbox', { name: 'Customer' }).fill('Globex');
  await page.getByRole('textbox', { name: 'Invoice date' }).fill('2026-11-01');
  await page.getByRole('textbox', { name: 'Amount' }).fill('1250.5');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Invoice INV-1004 created')).toBeVisible();
  await expect(page.getByTestId('invoice-number')).toHaveText('INV-1004');
});`;

test("console state: seeded published workflow with example values, billing app unreachable, no run yet", async () => {
  const s = (await app.inject({ url: "/console/state" })).json();
  assert.equal(s.instance.reachable, false);
  assert.equal(s.workflow.published.version, 1);
  assert.equal(s.workflow.draft, null);
  assert.deepEqual(s.workflow.published.examples, { customer: "Acme Ltd", invoice_date: "2026-10-12", amount: "50000" });
  assert.equal(s.agent.id, "agent-1");
  assert.equal(s.run, null);
});

test("a recording becomes a Draft, then a Published version that accepts a run; the run shows step detail", async () => {
  const made = await app.inject({ method: "POST", url: "/target-apps/demo-billing/demonstrations", payload: { workflow_name: "create-invoice", recording: RECORDING } });
  assert.equal(made.statusCode, 201);

  let s = (await app.inject({ url: "/console/state" })).json();
  assert.equal(s.workflow.draft.version, 2);
  assert.equal(s.workflow.draft.examples.customer, "Globex");
  assert.equal(s.workflow.draft.commit_step, 3);

  const pub = await app.inject({ method: "POST", url: `/workflow-versions/${s.workflow.draft.id}/publish` });
  assert.equal(pub.statusCode, 200);

  const run = await app.inject({
    method: "POST", url: "/workflows/create-invoice/runs", headers: { "idempotency-key": "K1" },
    payload: { target_instance_id: "demo", parameters: { customer: "Globex", invoice_date: "2026-11-01", amount: 1250.5 } },
  });
  assert.equal(run.statusCode, 202);

  s = (await app.inject({ url: "/console/state" })).json();
  assert.equal(s.workflow.draft, null);
  assert.equal(s.workflow.published.version, 2);
  assert.equal(s.run.status, "queued");
  assert.equal(s.run.steps.length, 6);
  assert.equal(s.run.steps_done, 0);
  assert.equal(s.run.idempotency_key, "K1");
});

test("a recording with an unapproved action is refused and nothing is stored", async () => {
  const r = await app.inject({
    method: "POST", url: "/target-apps/demo-billing/demonstrations",
    payload: { workflow_name: "bad-one", recording: "test('t', async ({ page }) => {\n  await page.evaluate(() => 1);\n  await page.getByRole('button', { name: 'Save' }).click();\n});" },
  });
  assert.equal(r.statusCode, 422);
  assert.equal((await db.query("SELECT count(*)::int n FROM demonstrations")).rows[0].n, 0);
});
