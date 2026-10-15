import { chromium, type Browser, type Locator as PwLocator, type Page } from "playwright";
import { ACTIONS } from "@lba/shared";
import { type Claim, type Config, EngineError, type Locator, Stale, engineClient } from "./engine.ts";

/**
 * The Agent deliberately stops without reporting. The Run keeps its lease, and when it expires the Engine decides:
 * back to queued if Save was never announced, needs_review if it was. Also how tests simulate a crash.
 */
export class Abort extends Error {}

export type Hooks = { beforeCommitIntent?: () => void | Promise<void>; afterCommitIntent?: () => void | Promise<void> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} agent  ${msg}`);

let active: Browser | null = null;
export const closeActiveBrowser = () => active?.close().catch(() => {});

/** Only Playwright's own locator APIs, built from the learned Target Map. Nothing from a Workflow is ever evaluated as code. */
function locate(page: Page, loc: Locator | undefined): PwLocator {
  if (!loc) throw new Error("this target has no locator");
  switch (loc.by) {
    case "label": return page.getByLabel(loc.name);
    case "role": return page.getByRole(loc.role as Parameters<Page["getByRole"]>[0], { name: loc.name || undefined });
    case "testid": return page.getByTestId(loc.name);
    case "text": return page.getByText(loc.name);
    case "placeholder": return page.getByPlaceholder(loc.name);
    case "css": return page.locator(loc.name);
    default: throw new Error(`unknown locator type "${loc.by}"`);
  }
}

const substitute = (value: string, params: Record<string, unknown>) => value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""));

// The field being touched gets an outline in the Agent's own window, so a person watching can follow along.
const highlight = (loc: PwLocator, color: string) =>
  loc.first().evaluate((el, c) => {
    const e = el as HTMLElement;
    e.style.outline = `3px solid ${c}`;
    e.style.outlineOffset = "2px";
  }, color).catch(() => {});

const GREEN = "#2fd06f";
const AMBER = "#ffb000";

const describe = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

export async function executeRun(cfg: Config, claim: Claim, hooks: Hooks = {}) {
  const eng = engineClient(cfg);
  const { steps, target_map } = claim.workflow;
  const outputs: Record<string, string> = {};

  const failRun = async (error: string) => {
    log(`run ${claim.run_id.slice(0, 12)} failed: ${error}`);
    await eng.complete(claim, { status: "failed", error });
  };

  if (!claim.base_url) return failRun("the target instance has no base_url");
  const browser = await chromium.launch({ headless: cfg.headless });
  active = browser;
  try {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
    page.setDefaultTimeout(cfg.actionTimeoutMs);
    try {
      await page.goto(claim.base_url);
    } catch (e) {
      return await failRun(`could not open the billing app: ${describe(e)}`);
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const t0 = Date.now();
      let valueUsed: string | undefined;
      try {
        if (!(ACTIONS as readonly string[]).includes(step.action)) throw new Error(`unapproved action "${step.action}"`);
        const loc = locate(page, target_map[step.target]);

        if (step.action === "fill") {
          valueUsed = substitute(step.value ?? "", claim.parameters);
          await highlight(loc, GREEN);
          await sleep(cfg.slowMoMs);
          await loc.fill(valueUsed);
        } else if (step.action === "click") {
          if (step.commit) {
            // Report-before-Save: the Engine must acknowledge BEFORE the irreversible click. No OK, no click.
            await hooks.beforeCommitIntent?.();
            let key: string;
            try { key = await eng.uploadScreenshot(claim, await page.screenshot()); }
            catch (e) { if (e instanceof Stale) throw e; throw new Abort(`no pre-commit evidence, not clicking Save: ${describe(e)}`); }
            try { await eng.commitIntent(claim, key); }
            catch (e) {
              if (e instanceof Stale) throw e;
              if (e instanceof EngineError && e.status === 422) throw new Error("the Engine rejected the pre-commit screenshot"); // safe: nothing saved
              throw new Abort(`no commit-intent OK, not clicking Save: ${describe(e)}`);
            }
            await hooks.afterCommitIntent?.();
          }
          await highlight(loc, step.commit ? AMBER : GREEN);
          await sleep(cfg.slowMoMs);
          await loc.click();
        } else if (step.action === "verify") {
          await highlight(loc, GREEN);
          await loc.first().waitFor({ state: "visible" });
          await sleep(cfg.slowMoMs);
        } else {
          valueUsed = (await loc.first().innerText()).trim();
          outputs[step.into!] = valueUsed;
          await highlight(loc, GREEN);
          await sleep(cfg.slowMoMs);
        }
        await eng.step(claim, { step_no: i, outcome: "ok", duration_ms: Date.now() - t0, value_used: valueUsed });
        log(`step ${i + 1}/${steps.length} ${step.action} ${step.target}${valueUsed ? ` = ${valueUsed}` : ""}`);
      } catch (e) {
        if (e instanceof Stale || e instanceof Abort) throw e;
        await eng.step(claim, { step_no: i, outcome: "failed", duration_ms: Date.now() - t0 }).catch((x) => { if (x instanceof Stale) throw x; });
        return await failRun(`${step.action} ${step.target}: ${describe(e)}`);
      }
    }
    await eng.complete(claim, { status: "succeeded", outputs });
    log(`run ${claim.run_id.slice(0, 12)} succeeded ${JSON.stringify(outputs)}`);
  } finally {
    active = null;
    await browser.close().catch(() => {});
  }
}

/** Ask for one Run and execute it. Returns false when there was nothing to do. */
export async function runNext(cfg: Config, hooks: Hooks = {}): Promise<boolean> {
  const claim = await engineClient(cfg).claim();
  if (!claim) return false;
  log(`claimed ${claim.run_id.slice(0, 12)} attempt ${claim.attempt}`);
  try {
    await executeRun(cfg, claim, hooks);
  } catch (e) {
    if (e instanceof Stale) log(`dropped ${claim.run_id.slice(0, 12)}: another attempt owns it now`);
    else if (e instanceof Abort) { log(`stopped ${claim.run_id.slice(0, 12)}: ${e.message}`); if (hooks.beforeCommitIntent || hooks.afterCommitIntent) throw e; }
    else throw e;
  }
  return true;
}
