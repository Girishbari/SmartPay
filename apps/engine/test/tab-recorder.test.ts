// Tab recording (Render): the tab sends snapshots of every step so far. No browser and no database needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Ev, startTabRecorder } from "../src/learner/recorder.ts";

const fill = (name: string, value: string): Ev => ({ type: "fill", locator: { by: "label", name }, value });
const save = (before: string[] = []): Ev => ({ type: "click", locator: { by: "role", name: "Save" }, submit: true, before });
const OK = { kind: "success" as const, text: "Invoice INV-1001 created", number: { value: "INV-1001", locator: { by: "testid" as const, name: "invoice-number" } } };

function recorder() {
  const out: { text?: string; failed?: string } = {};
  const r = startTabRecorder("https://x/demo/", { onDone: async (t) => void (out.text = t), onFail: (m) => void (out.failed = m) });
  return { r, out };
}

test("a late, shorter snapshot changes nothing, and the steps stay in the order they happened", async () => {
  const { r, out } = recorder();
  const all = [fill("Customer", "Acme"), fill("Amount", "50"), save()];
  await r.receive(all); // the Save snapshot overtook the one sent for Amount
  await r.receive(all.slice(0, 1));
  await r.receive(all, OK);
  const lines = out.text!.split("\n").filter((l) => l.includes("getBy"));
  assert.deepEqual(lines.slice(0, 3).map((l) => l.trim()), [
    "await page.getByLabel('Customer').fill('Acme');",
    "await page.getByLabel('Amount').fill('50');",
    "await page.getByRole('button', { name: 'Save' }).click();",
  ]);
});

test("a rejected Save keeps recording; the corrected Save finishes it with one Save step", async () => {
  const { r, out } = recorder();
  const steps = [fill("Customer", "Acme"), save()];
  await r.receive(steps, { kind: "error", text: "Amount must be a number above 0" });
  assert.match(r.progress().notice!, /rejected Save/);
  assert.equal(r.progress().learning, false);
  steps.push(fill("Amount", "50"), save(["Invoice not saved."]));
  await r.receive(steps, OK);
  assert.equal(out.failed, undefined);
  assert.equal(out.text!.match(/name: 'Save'/g)!.length, 1);
  assert.match(out.text!, /fill\('50'\)/);
});
