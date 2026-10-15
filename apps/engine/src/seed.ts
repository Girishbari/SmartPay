import { DEMO_APP_URL } from "./config.ts";
import type { Db } from "./db.ts";

export const SEED_STEPS = [
  { action: "fill", target: "customer", value: "{{customer}}" },
  { action: "fill", target: "invoice-date", value: "{{invoice_date}}" },
  { action: "fill", target: "amount", value: "{{amount}}" },
  { action: "click", target: "save", commit: true },
  { action: "verify", target: "invoice-created" },
  { action: "read", target: "invoice-number", into: "invoice_number" },
];

/** Demo data: one tenant, one Target Instance (limit 1) with its Agent, and a Published create-invoice. Safe to re-run. */
export async function seed(db: Db, opts: { workflow?: boolean } = {}) {
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p);
  await q(`INSERT INTO tenants VALUES ('demo','Demo Tenant') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO client_apps VALUES ('client-1','demo','Demo Client App') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO agents VALUES ('agent-1','demo','Agent-1') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO target_apps VALUES ('demo-billing','Demo Billing') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO target_instances (id, tenant_id, target_app_id, concurrency_limit, agent_id, base_url) VALUES ('demo','demo','demo-billing',1,'agent-1',$1) ON CONFLICT (id) DO UPDATE SET base_url = EXCLUDED.base_url`, [DEMO_APP_URL]);
  if (opts.workflow === false) return; // a real install starts empty: the person teaches it
  await q(`INSERT INTO workflows VALUES ('wf-create-invoice','demo-billing','create-invoice') ON CONFLICT DO NOTHING`);
  await q(
    `INSERT INTO workflow_versions VALUES ('wfv-1','wf-create-invoice',1,'published',$1,$2,$3,$4,3,NULL) ON CONFLICT DO NOTHING`,
    [
      JSON.stringify(SEED_STEPS),
      // ponytail: placeholder locators; the Learner will produce real ones from a Demonstration.
      JSON.stringify({
        customer: { by: "label", name: "Customer" },
        "invoice-date": { by: "label", name: "Invoice date" },
        amount: { by: "label", name: "Amount" },
        save: { by: "role", role: "button", name: "Save" },
        "invoice-created": { by: "text", name: "Invoice INV-" },
        "invoice-number": { by: "testid", name: "invoice-number" },
      }),
      JSON.stringify({
        customer: { type: "string", required: true },
        invoice_date: { type: "date", required: true },
        amount: { type: "number", required: true },
      }),
      JSON.stringify(["invoice_number"]),
    ],
  );
  await q(`UPDATE workflow_versions SET examples = $1 WHERE id = 'wfv-1'`, [JSON.stringify({ customer: "Acme Ltd", invoice_date: "2026-10-12", amount: "50000" })]);
}
