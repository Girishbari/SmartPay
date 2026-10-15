import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkflowBody } from "@lba/shared";
import { convertRecording } from "../src/learner/convert.ts";

// What `playwright codegen --target playwright-test` writes for one invoice on the demo app.
const RECORDING = `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('http://127.0.0.1:4000/');
  await page.getByRole('textbox', { name: 'Customer' }).click();
  await page.getByRole('textbox', { name: 'Customer' }).fill('Acme Ltd');
  await page.getByRole('textbox', { name: 'Invoice date' }).fill('2026-10-12');
  await page.getByRole('textbox', { name: 'Amount' }).click();
  await page.getByRole('textbox', { name: 'Amount' }).fill('50000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Invoice INV-1004 created')).toBeVisible();
  await expect(page.getByTestId('invoice-number')).toHaveText('INV-1004');
});`;

test("a codegen recording becomes a valid Draft with typed parameters and a commit step", () => {
  const d = convertRecording(RECORDING);
  assert.deepEqual(d.problems, []);
  assert.deepEqual(d.parameters, {
    customer: { type: "string", required: true },
    invoice_date: { type: "date", required: true },
    amount: { type: "number", required: true },
  });
  assert.deepEqual(d.steps, [
    { action: "fill", target: "customer", value: "{{customer}}" },
    { action: "fill", target: "invoice-date", value: "{{invoice_date}}" },
    { action: "fill", target: "amount", value: "{{amount}}" },
    { action: "click", target: "save", commit: true },
    { action: "verify", target: "invoice-inv" },
    { action: "read", target: "invoice-number", into: "invoice_number" },
  ]);
  assert.deepEqual(d.target_map["invoice-inv"], { by: "text", name: "Invoice INV-" }); // dynamic number is not baked in
  assert.deepEqual(validateWorkflowBody({ steps: d.steps, target_map: d.target_map, parameters: d.parameters }), []);
});

test("anything outside the approved actions is reported, never executed or guessed", () => {
  const d = convertRecording(`test('t', async ({ page }) => {
  await page.getByLabel('Customer').press('Enter');
  await page.evaluate(() => alert(1));
  await page.getByRole('button', { name: 'Save' }).click();
});`);
  assert.equal(d.problems.length, 2);
  assert.match(d.problems[0], /not an approved action/);
});
