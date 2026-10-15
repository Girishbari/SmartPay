import type { ConsoleState, Locator, Params, Run, Step } from "./api";

export const typeLabel = (t: string) => (t === "string" ? "text" : t);

export type ViewId =
  | "ready" | "recording" | "review" | "curl" | "waiting"
  | "working" | "saving" | "done" | "needs" | "failed";

/** The screen the Engine's state implies. The person can pin another screen by clicking the rail. */
export function deriveView(s: ConsoleState): ViewId {
  if (s.recording?.status === "recording") return "recording";
  const { published, draft } = s.workflow;
  if (draft) return "review";
  if (published) return s.run && s.run.workflow_version_id === published.id ? runView(s.run) : "curl";
  return "ready";
}

export function runView(run: Run): ViewId {
  switch (run.status) {
    case "queued": return "working";
    case "running": return run.commit_started ? "saving" : "working";
    case "succeeded": return "done";
    case "needs_review": return "needs";
    case "failed": return "failed";
  }
}

export const stepOf = (v: ViewId) => (v === "ready" || v === "recording" ? 1 : v === "review" ? 2 : v === "curl" ? 3 : 4);

// ---- wording helpers ----
export const words = (s: string) => {
  const t = s.replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
export const pad2 = (n: number) => String(n).padStart(2, "0");

/** A human label for a Target, from what the recorder saw ("Customer", "Save", "invoice number"). */
export function labelOf(map: Record<string, Locator> | undefined, target: string) {
  const loc = map?.[target];
  if (!loc?.name) return words(target);
  return loc.by === "testid" ? words(loc.name).toLowerCase() : loc.name;
}

export function stepText(step: Pick<Step, "action" | "target">, map: Record<string, Locator> | undefined) {
  const label = labelOf(map, step.target);
  switch (step.action) {
    case "fill": return { verb: "Fill", label };
    case "click": return { verb: "Click", label };
    case "verify": return { verb: "Check", label: `“${label}…” appears`, bare: true };
    default: return { verb: "Read", label: `the ${label}` };
  }
}

export function elapsed(fromIso: string | null, toMs: number, endIso?: string | null) {
  if (!fromIso) return "00:00";
  const end = endIso ? Date.parse(endIso) : toMs;
  const secs = Math.max(0, Math.round((end - Date.parse(fromIso)) / 1000));
  return `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`;
}

export function runSeconds(run: Run) {
  if (!run.started_at || !run.finished_at) return null;
  const secs = (Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000;
  return secs < 10 ? secs.toFixed(1) : String(Math.round(secs));
}

export function durationText(ms?: number) {
  return ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`;
}

/** Resolve "{{customer}}" against the run's parameters for display. */
export function filled(value: string | undefined, params: Record<string, unknown>) {
  if (!value) return "";
  return value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""));
}

// ---- the curl the developer copies ----
export const EXAMPLE_KEY = "ORD-1001";

/** Tab recording: the billing app address that makes the Engine's recorder script start recording in that tab. */
export const recordUrl = (baseUrl: string, recordingId: string) => `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}lba_rec=${encodeURIComponent(recordingId)}`;
export const RECORD_TAB = "lba-recorder";

export function curlText(engineUrl: string, workflow: string, instanceId: string, params: Params, examples: Record<string, string> | null, steps: Step[] = []) {
  const body: Record<string, string | number> = {};
  // The order the person filled the form in (the database does not keep object key order).
  const order = steps.flatMap((s) => s.value?.match(/\{\{(\w+)\}\}/)?.[1] ?? []);
  const names = [...new Set([...order, ...Object.keys(params)])].filter((n) => n in params);
  for (const name of names) {
    const p = params[name];
    const raw = examples?.[name] ?? (p.type === "number" ? "100" : p.type === "date" ? new Date().toISOString().slice(0, 10) : "example");
    body[name] = p.type === "number" ? Number(raw) : raw;
  }
  const json = JSON.stringify({ target_instance_id: instanceId, parameters: body }, null, 2).split("\n").join("\n  ");
  return [
    `curl -X POST ${engineUrl}/workflows/${workflow}/runs \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: ${EXAMPLE_KEY}" \\`,
    `  -d '${json}'`,
  ].join("\n");
}
