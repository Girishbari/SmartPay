// The recorder: pressing Save ends the recording and the Engine learns the confirmation message by itself.
// Drives a real (headless) recorder window against a throwaway copy of the demo billing app. Needs DATABASE_URL.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type pg from "pg";

process.env.SCREENSHOT_DIR = mkdtempSync(join(tmpdir(), "rec-shots-"));
const { testPool } = await import("./helpers.ts");
const { seed } = await import("../src/seed.ts");
const { convertRecording } = await import("../src/learner/convert.ts");
const { recordingText } = await import("../src/learner/recorder.ts");
const { latestRecording, recorderOf, startRecording } = await import("../src/learner/routes.ts");

const PORT = 4102;
const DEMO_DIR = join(import.meta.dirname, "../../demo-billing");
let db: pg.Pool;
let demo: ChildProcess;

before(async () => {
  db = await testPool();
  demo = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: DEMO_DIR, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/`); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("demo app did not start");
});
after(async () => {
  demo.kill();
  await db.end();
});
beforeEach(async () => {
  await db.query("TRUNCATE tenants, target_apps CASCADE");
  await seed(db, { workflow: false });
});

const waitFor = async (what: string, ok: () => boolean, ms = 20000) => {
  for (let t = 0; t < ms; t += 200) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test("recording text round-trips through the converter into the expected Draft", () => {
  const text = recordingText(
    "http://x/",
    [
      { type: "fill", locator: { by: "label", name: "Customer" }, value: "Acme's Ltd" },
      { type: "fill", locator: { by: "label", name: "Amount" }, value: "50000" },
      { type: "click", locator: { by: "role", name: "Save" }, submit: true, before: [] },
    ],
    { kind: "success", text: "Invoice INV-1004 created", number: { value: "INV-1004", locator: { by: "testid", name: "invoice-number" } } },
  );
  const d = convertRecording(text);
  assert.deepEqual(d.problems, []);
  assert.deepEqual(d.steps.map((s) => `${s.action}:${s.target}`), ["fill:customer", "fill:amount", "click:save", "verify:invoice-inv", "read:invoice-number"]);
  assert.equal(d.examples.customer, "Acme's Ltd"); // quotes survive
  assert.equal(d.steps[2].commit, true);
});

test("pressing Save closes the recorder and saves a Draft with the success check and the invoice number, with no toolbar clicks", async () => {
  const id = await startRecording(db, "demo-billing", `http://127.0.0.1:${PORT}`, "create-invoice", { headless: true });
  const page = recorderOf(id)!.page;

  await page.getByLabel("Customer").fill("Recorder Test Co");
  await page.getByLabel("Invoice date").fill("2026-10-20");
  await page.getByLabel("Amount").fill("4200");
  await waitFor("progress to show three fields", () => latestRecording()!.progress.filled.length === 3);
  assert.equal(latestRecording()!.progress.save_pressed, false);

  await page.getByRole("button", { name: "Save" }).click();
  await waitFor("the recording to finish", () => latestRecording()!.status !== "recording");

  const rec = latestRecording()!;
  assert.equal(rec.status, "done", `recording ended as ${rec.status}: ${rec.error ?? ""}`);
  const { rows } = await db.query("SELECT steps, parameters, commit_step, examples FROM workflow_versions WHERE status = 'draft'");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].steps.map((s: { action: string }) => s.action), ["fill", "fill", "fill", "click", "verify", "read"]);
  assert.equal(rows[0].commit_step, 3);
  assert.deepEqual(rows[0].parameters.amount, { type: "number", required: true });
  assert.equal(rows[0].examples.customer, "Recorder Test Co");
});

test("when the billing app rejects Save, recording keeps going and the corrected Save finishes it", async () => {
  const id = await startRecording(db, "demo-billing", `http://127.0.0.1:${PORT}`, "create-invoice", { headless: true });
  const page = recorderOf(id)!.page;

  await page.getByRole("button", { name: "Save" }).click(); // empty form: the app answers with an error
  await waitFor("the rejection to be noticed", () => !!latestRecording()!.progress.notice);
  assert.equal(latestRecording()!.status, "recording");
  assert.match(latestRecording()!.progress.notice!, /rejected Save/);

  await page.getByLabel("Customer").fill("Second Try Ltd");
  await page.getByLabel("Invoice date").fill("2026-10-21");
  await page.getByLabel("Amount").fill("99");
  await page.getByRole("button", { name: "Save" }).click();
  await waitFor("the recording to finish", () => latestRecording()!.status !== "recording");
  assert.equal(latestRecording()!.status, "done");
});

test("closing the window before Save ends the recording as failed, with a clear reason", async () => {
  const id = await startRecording(db, "demo-billing", `http://127.0.0.1:${PORT}`, "create-invoice", { headless: true });
  await recorderOf(id)!.page.context().browser()!.close();
  await waitFor("the recording to fail", () => latestRecording()!.status !== "recording");
  assert.equal(latestRecording()!.status, "failed");
  assert.match(latestRecording()!.error!, /closed before you pressed Save/);
});
