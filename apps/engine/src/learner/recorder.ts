import { fileURLToPath } from "node:url";
import { type Page, chromium } from "playwright";

// The Learner's recorder: the Engine opens the Target App in its own browser window, watches what the person does,
// and when they press Save it reads the page's confirmation message to learn the success check and the Output.
// No toolbar clicks needed. Pressing Save ends the recording.

export type Loc = { by: "label" | "placeholder" | "testid" | "role" | "text" | "css"; name: string };
export type Ev =
  | { type: "fill"; locator: Loc; value: string }
  | { type: "click"; locator: Loc; submit: boolean; before: string[] };
type Click = Extract<Ev, { type: "click" }>;
export type Analysis =
  | { kind: "success"; text: string; number: { value: string; locator: Loc } | null }
  | { kind: "error"; text: string }
  | { kind: "none" };
export type Progress = { filled: string[]; save_pressed: boolean; learning: boolean; notice?: string };
export type Hooks = { onDone(recordingText: string): Promise<void>; onFail(message: string): void };

const PAGE_SCRIPT = fileURLToPath(new URL("./recorder-page.js", import.meta.url));
const SAVE_WORDS = /^(save|submit|create|post|confirm|ok|done|finish)$/i;
const isFinal = (e: Click) => e.submit || SAVE_WORDS.test(e.locator.name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const locExpr = (l: Loc) => {
  switch (l.by) {
    case "label": return `getByLabel(${lit(l.name)})`;
    case "placeholder": return `getByPlaceholder(${lit(l.name)})`;
    case "testid": return `getByTestId(${lit(l.name)})`;
    case "role": return `getByRole('button', { name: ${lit(l.name)} })`;
    case "text": return `getByText(${lit(l.name)})`;
    default: return `locator(${lit(l.name)})`;
  }
};

/** What was recorded, written as Playwright-style steps. The Learner's converter turns this text into a Draft. */
export function recordingText(baseUrl: string, events: Ev[], result: Extract<Analysis, { kind: "success" }>) {
  const lines = ["test('recorded', async ({ page }) => {", `  await page.goto(${lit(baseUrl)});`];
  for (const e of events) lines.push(e.type === "fill" ? `  await page.${locExpr(e.locator)}.fill(${lit(e.value)});` : `  await page.${locExpr(e.locator)}.click();`);
  lines.push(`  await expect(page.getByText(${lit(result.text)})).toBeVisible();`);
  if (result.number) lines.push(`  await expect(page.${locExpr(result.number.locator)}).toHaveText(${lit(result.number.value)});`);
  lines.push("});");
  return lines.join("\n");
}

/** What one recording has seen so far. Both recorders feed it: the Engine's own window and the person's own tab. */
function session(baseUrl: string, hooks: Hooks, cleanup: () => Promise<unknown>) {
  let events: Ev[] = [];
  let phase: "recording" | "learning" | "finished" = "recording";
  let notice: string | undefined;
  let final: Click | undefined;
  let cancelled = false;

  const finish = async () => {
    phase = "finished";
    await cleanup().catch(() => {});
  };
  const fail = async (message: string) => {
    if (phase === "finished") return;
    await finish();
    if (!cancelled) hooks.onFail(message);
  };

  return {
    phase: () => phase,
    fail,
    /** A step seen in the page. Returns the click when it is the Save that ends the recording. */
    record(e: Ev): Click | undefined {
      if (phase !== "recording") return;
      if (e.type === "fill") {
        const key = JSON.stringify(e.locator);
        events = events.filter((x) => !(x.type === "fill" && JSON.stringify(x.locator) === key)); // the last value typed wins
        events.push(e);
        notice = undefined;
        return;
      }
      events.push(e);
      if (!isFinal(e)) return;
      phase = "learning";
      return (final = e);
    },
    /** What the page said after Save. */
    async conclude(result: Analysis) {
      if (phase !== "learning") return;
      if (result.kind === "error") {
        // The app refused the Save. Keep recording: the person fixes it and presses Save again.
        events = events.filter((e) => e !== final);
        notice = `The billing app rejected Save: ${result.text} Fix it and press Save again.`;
        phase = "recording";
        return;
      }
      if (result.kind === "none") return void (await fail("I couldn't see a confirmation message after Save, so the Engine can't tell what success looks like."));
      await hooks.onDone(recordingText(baseUrl, events, result));
      await finish();
    },
    progress: (): Progress => ({
      filled: [...new Set(events.filter((e) => e.type === "fill").map((e) => e.locator.name))],
      save_pressed: phase !== "recording" && events.some((e) => e.type === "click"),
      learning: phase === "learning",
      notice,
    }),
    close: async () => {
      cancelled = true;
      await finish();
    },
  };
}

/** Local: the Engine opens the Target App in its own browser window and watches it. */
export async function startRecorder(baseUrl: string, hooks: Hooks, opts: { headless?: boolean } = {}) {
  const browser = await chromium.launch({ headless: opts.headless ?? false });
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const s = session(baseUrl, hooks, () => browser.close());

  async function learn(page: Page, final: Click) {
    let result: Analysis = { kind: "none" };
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && s.phase() === "learning") {
      await sleep(250);
      try {
        result = (await page.evaluate(`window.__lbaAnalyze(${JSON.stringify(final.before)})`)) as Analysis;
      } catch {
        continue; // the page is in the middle of navigating
      }
      if (result.kind !== "none") break;
    }
    await s.conclude(result);
  }

  await context.exposeBinding("__lbaRecord", async ({ page }, raw: unknown) => {
    const final = s.record(raw as Ev);
    if (final) void learn(page, final);
  });
  await context.addInitScript({ path: PAGE_SCRIPT });
  browser.on("disconnected", () => void s.fail("The recorder window was closed before you pressed Save."));

  const page = await context.newPage();
  await page.goto(baseUrl);
  return { page, progress: s.progress, close: s.close };
}
export type Recorder = Awaited<ReturnType<typeof startRecorder>>;

/**
 * Render (no screen): the person records in their own browser tab. recorder-page.js in that tab sends every step it has
 * seen so far (a snapshot, so a request that arrives late or out of order changes nothing) and, after Save, what the page said.
 * Works only for pages the Engine serves itself, i.e. the demo billing app under /demo/.
 */
export function startTabRecorder(baseUrl: string, hooks: Hooks) {
  let seen = 0; // how many of the tab's steps are already recorded
  let timer: NodeJS.Timeout | undefined;
  const s = session(baseUrl, hooks, async () => clearTimeout(timer));
  return {
    progress: s.progress,
    close: s.close,
    async receive(steps: Ev[], analysis?: Analysis) {
      for (const e of steps.slice(seen)) {
        if (!s.record(e)) continue;
        clearTimeout(timer);
        timer = setTimeout(() => void s.conclude({ kind: "none" }), 15_000); // the tab never reported what the page said
      }
      seen = Math.max(seen, steps.length);
      if (analysis) await s.conclude(analysis);
    },
  };
}
export type TabRecorder = ReturnType<typeof startTabRecorder>;
