import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

// Stand-in for legacy billing software: server-rendered pages, invoices in memory, no database, no API, no idempotency.
// Saving twice makes two invoices, on purpose: that is the problem the Engine has to protect against.
// Links are relative so the same pages work standalone (server.ts) and mounted by the Engine under /demo/.

type Invoice = { no: string; customer: string; date: string; due: string; description: string; amount: number };
type Form = { customer: string; date: string; due: string; description: string; amount: string };

const invoices: Invoice[] = []; // starts empty on purpose: every invoice in the list was created through the form
let nextNo = 1001;

// Acceptance check: DRIFT=1 renames the Customer field, so a recorded Workflow must fail before Save.
const CUSTOMER_LABEL = process.env.DRIFT === "1" ? "Client" : "Customer";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso: string) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).toUpperCase() : "";

const isDate = (s: string) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Returns the new invoice, or a map of field -> message. */
function validate(f: Form): { ok: Invoice } | { err: Record<string, string> } {
  const err: Record<string, string> = {};
  const customer = f.customer.trim();
  const amount = Number(f.amount);
  if (!customer) err.customer = `${CUSTOMER_LABEL} is required`;
  if (!isDate(f.date)) err.date = "Invoice date is required (use the date picker)";
  if (f.due && (!isDate(f.due) || f.due < f.date)) err.due = "Due date cannot be before the invoice date";
  if (!f.amount.trim() || !Number.isFinite(amount) || amount <= 0) err.amount = "Amount must be a number above 0";
  if (f.description.length > 200) err.description = "Description is too long (200 max)";
  if (Object.keys(err).length) return { err };
  return { ok: { no: `INV-${nextNo}`, customer, date: f.date, due: f.due, description: f.description.trim(), amount } };
}

function page(opts: { form?: Form; errors?: Record<string, string>; created?: Invoice; head: string }) {
  const f = opts.form ?? { customer: "", date: "", due: "", description: "", amount: "" };
  const errs = opts.errors ?? {};
  const bad = (k: string) => (errs[k] ? ' aria-invalid="true"' : "");
  const rows = [...invoices].reverse().map(
    (i) => `<tr${i.no === opts.created?.no ? ' class="new"' : ""}>
      <td>${i.no}</td><td>${esc(i.customer)}</td><td>${day(i.date)}</td><td>${day(i.due)}</td>
      <td class="num">${money(i.amount)}</td><td><span class="dot" aria-hidden="true"></span>POSTED</td></tr>`,
  );
  const msgs = Object.values(errs);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledgerline Billing 4.02</title><link rel="stylesheet" href="style.css">${opts.head}</head>
<body>
<header class="bar"><span>LEDGERLINE BILLING v4.02 // NODE_01</span><span>${day(new Date().toISOString().slice(0, 10))}</span></header>
<main>
  <section class="win" aria-labelledby="reg">
    <h2 class="title" id="reg">INVOICE_REGISTRY</h2>
    <div class="body scroll"><table>
      <thead><tr><th scope="col">INV_NO</th><th scope="col">CUSTOMER</th><th scope="col">ISSUE_DATE</th><th scope="col">DUE_DATE</th><th scope="col" class="num">AMOUNT_INR</th><th scope="col">STATUS</th></tr></thead>
      <tbody>${rows.length ? rows.join("") : '<tr><td class="empty" colspan="6">No invoices yet. Create the first one with the form.</td></tr>'}</tbody>
    </table></div>
  </section>
  <section class="win" aria-labelledby="new">
    <h2 class="title" id="new">NEW_INVOICE</h2>
    <div class="body">
      ${opts.created ? `<p class="msg ok" role="status">Invoice <strong data-testid="invoice-number">${opts.created.no}</strong> created</p>` : ""}
      ${msgs.length ? `<div class="msg bad" role="alert"><strong>Invoice not saved.</strong><ul>${msgs.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>` : ""}
      <form method="post" action="invoices" novalidate>
        <div><label for="customer">${CUSTOMER_LABEL}</label><input id="customer" name="customer" value="${esc(f.customer)}" autocomplete="off" autofocus${bad("customer")}></div>
        <div class="pair">
          <div><label for="date">Invoice date</label><input id="date" name="date" type="date" value="${esc(f.date)}"${bad("date")}></div>
          <div><label for="due">Due date</label><input id="due" name="due" type="date" value="${esc(f.due)}"${bad("due")}></div>
        </div>
        <div><label for="description">Description</label><input id="description" name="description" value="${esc(f.description)}" autocomplete="off"${bad("description")}></div>
        <div><label for="amount">Amount</label><input id="amount" name="amount" inputmode="decimal" value="${esc(f.amount)}" autocomplete="off"${bad("amount")}></div>
        <div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="reset">Clear</button></div>
      </form>
    </div>
  </section>
</main>
<footer class="status">${invoices.length} INVOICES IN MEMORY // RESETS ON RESTART</footer>
</body></html>`;
}

const send = (res: ServerResponse, code: number, body: string, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) =>
  res.writeHead(code, { "content-type": type, ...headers }).end(body);

async function readForm(req: IncomingMessage): Promise<Form> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const p = new URLSearchParams(raw);
  const get = (k: string) => (p.get(k) ?? "").slice(0, 500);
  return { customer: get("customer"), date: get("date"), due: get("due"), description: get("description"), amount: get("amount") };
}

/** `head` is extra markup for <head>: the Engine adds its recorder script there when it serves this app on Render. */
export async function handler(req: IncomingMessage, res: ServerResponse, head = "") {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/style.css")
    return send(res, 200, readFileSync(new URL("./style.css", import.meta.url), "utf8"), "text/css; charset=utf-8");

  if (req.method === "GET" && url.pathname === "/") {
    const created = invoices.find((i) => i.no === url.searchParams.get("created"));
    return send(res, 200, page({ created, head }));
  }

  if (req.method === "POST" && url.pathname === "/invoices") {
    const form = await readForm(req);
    const result = validate(form);
    if ("ok" in result) {
      invoices.push(result.ok);
      nextNo++;
      return send(res, 303, "", "text/plain", { location: `./?created=${result.ok.no}` }); // post-redirect-get, like a classic form app
    }
    return send(res, 200, page({ form, errors: result.err, head }));
  }

  send(res, 404, "Not found", "text/plain");
}
