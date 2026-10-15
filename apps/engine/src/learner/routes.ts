import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { commitStepIndex, outputNames, validateWorkflowBody } from "@lba/shared";
import { RECORDER, TENANT } from "../config.ts";
import { type Db, tx } from "../db.ts";
import { HttpError, fail } from "../errors.ts";
import { convertRecording } from "./convert.ts";
import { type Analysis, type Ev, type Progress, type Recorder, type TabRecorder, startRecorder, startTabRecorder } from "./recorder.ts";

/** Recording text -> Demonstration + Draft Workflow Version. Nothing is stored if the recording has problems. */
export async function createDraft(db: Db, targetAppId: string, workflowName: string, recording: string) {
  const draft = convertRecording(recording);
  if (draft.problems.length) fail(422, "the recording could not be learned", draft.problems);
  const problems = validateWorkflowBody({ steps: draft.steps, target_map: draft.target_map, parameters: draft.parameters });
  if (problems.length) fail(422, "the learned workflow is invalid", problems);

  return tx(db, async (c) => {
    const { rows: apps } = await c.query(`SELECT 1 FROM target_apps WHERE id = $1`, [targetAppId]);
    if (!apps[0]) fail(404, "target app not found");
    const demoId = `demo_${randomUUID()}`;
    await c.query(`INSERT INTO demonstrations (id, target_app_id, recording, workflow_name) VALUES ($1,$2,$3,$4)`, [demoId, targetAppId, recording, workflowName]);
    const wfId = `wf_${targetAppId}_${workflowName}`;
    await c.query(`INSERT INTO workflows (id, target_app_id, name) VALUES ($1,$2,$3) ON CONFLICT (target_app_id, name) DO NOTHING`, [wfId, targetAppId, workflowName]);
    const { rows: [wf] } = await c.query(`SELECT id FROM workflows WHERE target_app_id = $1 AND name = $2 FOR UPDATE`, [targetAppId, workflowName]); // serialises version numbers
    const { rows: [{ v }] } = await c.query(`SELECT COALESCE(max(version), 0) + 1 AS v FROM workflow_versions WHERE workflow_id = $1`, [wf.id]);
    const versionId = `wfv_${randomUUID()}`;
    await c.query(
      `INSERT INTO workflow_versions (id, workflow_id, version, status, steps, target_map, parameters, outputs, commit_step, demonstration_id, examples)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10)`,
      [versionId, wf.id, v, JSON.stringify(draft.steps), JSON.stringify(draft.target_map), JSON.stringify(draft.parameters),
       JSON.stringify(outputNames(draft.steps)), commitStepIndex(draft.steps), demoId, JSON.stringify(draft.examples)],
    );
    return { demonstration_id: demoId, workflow_version_id: versionId, version: v as number };
  });
}

// ---- Recording: the person creates one invoice (in the Engine's window, or in their own tab on Render); Save ends it and makes a Draft ----
type Rec = {
  id: string; workflow_name: string; recorder?: Recorder; tab?: TabRecorder;
  status: "recording" | "done" | "failed" | "cancelled"; workflow_version_id?: string; error?: string; problems?: unknown;
};
const recordings = new Map<string, Rec>(); // ponytail: in memory; a restart forgets in-flight recordings

const EMPTY: Progress = { filled: [], save_pressed: false, learning: false };

export function latestRecording() {
  const r = [...recordings.values()].at(-1);
  if (!r) return null;
  const { id, workflow_name, status, workflow_version_id, error, problems } = r;
  return { id, workflow_name, status, workflow_version_id, error, problems, progress: (r.recorder ?? r.tab)?.progress() ?? EMPTY };
}
/** For tests: the live recorder window of a recording. */
export const recorderOf = (id: string) => recordings.get(id)?.recorder;

export async function startRecording(db: Db, targetAppId: string, baseUrl: string, workflowName: string, opts: { headless?: boolean; mode?: "window" | "tab" } = {}) {
  if ([...recordings.values()].some((r) => r.status === "recording")) fail(409, "a recording is already running");
  const rec: Rec = { id: `rec_${randomUUID()}`, workflow_name: workflowName, status: "recording" };
  recordings.set(rec.id, rec);
  const hooks = {
    onDone: async (text: string) => {
      try {
        Object.assign(rec, { status: "done", workflow_version_id: (await createDraft(db, targetAppId, workflowName, text)).workflow_version_id });
      } catch (e) {
        const err = e as Error & { details?: unknown };
        Object.assign(rec, { status: "failed", error: err.message, problems: err.details });
      }
    },
    onFail: (message: string) => void Object.assign(rec, { status: "failed", error: message }),
  };
  if ((opts.mode ?? RECORDER) === "tab") {
    rec.tab = startTabRecorder(baseUrl, hooks);
    return rec.id;
  }
  try {
    rec.recorder = await startRecorder(baseUrl, hooks, opts);
  } catch (e) {
    recordings.delete(rec.id);
    throw new HttpError(503, `Could not open the recorder window: ${(e as Error).message.split("\n")[0]}`);
  }
  return rec.id;
}

export function learnerRoutes(app: FastifyInstance, db: Db) {
  const NAME = { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 60 };

  // Hand in a recording you already have (the same text the recorder produces).
  app.post<{ Params: { id: string }; Body: { workflow_name: string; recording: string } }>(
    "/target-apps/:id/demonstrations",
    { schema: { body: { type: "object", additionalProperties: false, required: ["workflow_name", "recording"], properties: { workflow_name: NAME, recording: { type: "string", maxLength: 100_000 } } } } },
    async (req, reply) => reply.code(201).send(await createDraft(db, req.params.id, req.body.workflow_name, req.body.recording)),
  );

  app.post<{ Params: { id: string }; Body: { workflow_name: string } }>(
    "/target-instances/:id/recordings",
    { schema: { body: { type: "object", additionalProperties: false, required: ["workflow_name"], properties: { workflow_name: NAME } } } },
    async (req, reply) => {
      const { rows } = await db.query(`SELECT target_app_id, base_url FROM target_instances WHERE id = $1 AND tenant_id = $2`, [req.params.id, TENANT]);
      if (!rows[0]?.base_url) fail(404, "target instance not found or has no base_url");
      return reply.code(202).send({ recording_id: await startRecording(db, rows[0].target_app_id, rows[0].base_url, req.body.workflow_name) });
    },
  );

  app.post<{ Params: { id: string } }>("/recordings/:id/cancel", async (req, reply) => {
    const r = recordings.get(req.params.id) ?? fail(404, "recording not found");
    if (r.status !== "recording") fail(409, "recording is not running");
    await (r.recorder ?? r.tab)?.close();
    r.status = "cancelled";
    return reply.code(202).send({ ok: true });
  });

  // Tab mode: recorder-page.js in the person's tab reports here. Public on Render, so every string is bounded and single-line
  // (the steps end up in the recording text the converter parses).
  const STR = (max: number) => ({ type: "string", maxLength: max, pattern: "^[^\\r\\n]*$" });
  const LOC = { type: "object", required: ["by", "name"], properties: { by: { enum: ["label", "placeholder", "testid", "role", "text", "css"] }, name: STR(200), role: STR(40) } };
  const STEP = {
    oneOf: [
      { type: "object", required: ["type", "locator", "value"], properties: { type: { const: "fill" }, locator: LOC, value: STR(500) } },
      { type: "object", required: ["type", "locator", "submit", "before"], properties: { type: { const: "click" }, locator: LOC, submit: { type: "boolean" }, before: { type: "array", maxItems: 20, items: STR(1000) } } },
    ],
  };
  const ANALYSIS = {
    type: "object", required: ["kind", "text"],
    properties: { kind: { enum: ["success", "error"] }, text: STR(1000), number: { type: ["object", "null"], required: ["value", "locator"], properties: { value: STR(100), locator: LOC } } },
  };
  app.post<{ Params: { id: string }; Body: { steps: Ev[]; analysis?: Analysis } }>(
    "/recordings/:id/events",
    { schema: { body: { type: "object", required: ["steps"], properties: { steps: { type: "array", maxItems: 200, items: STEP }, analysis: ANALYSIS } } } },
    async (req) => {
      const r = recordings.get(req.params.id) ?? fail(404, "recording not found");
      if (r.status === "recording" && r.tab) await r.tab.receive(req.body.steps, req.body.analysis);
      return { status: r.status }; // anything but "recording" tells the tab to stop
    },
  );
}
