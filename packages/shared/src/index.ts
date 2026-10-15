import { Ajv } from "ajv";

export const ACTIONS = ["fill", "click", "read", "verify"] as const;
export type Action = (typeof ACTIONS)[number];

export type ParamType = "string" | "number" | "date";
export type Parameters = Record<string, { type: ParamType; required: boolean }>;
export type Step = { action: Action; target: string; value?: string; into?: string; commit?: boolean };
export type TargetMap = Record<string, unknown>; // ponytail: locator shape is the Agent's business; the Engine only checks names

export type WorkflowBody = { steps: Step[]; target_map: TargetMap; parameters: Parameters };

const ajv = new Ajv({ allErrors: true });

// Closed shape: unknown keys and unknown actions are rejected, so nothing like "script" or "eval" can be stored.
const validateBody = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["steps", "target_map", "parameters"],
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "target"],
        properties: {
          action: { enum: ACTIONS },
          target: { type: "string", minLength: 1 },
          value: { type: "string" },
          into: { type: "string", pattern: "^[a-z_][a-z0-9_]*$" },
          commit: { type: "boolean" },
        },
      },
    },
    target_map: { type: "object" },
    parameters: {
      type: "object",
      propertyNames: { pattern: "^[a-z_][a-z0-9_]*$" },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["type", "required"],
        properties: { type: { enum: ["string", "number", "date"] }, required: { type: "boolean" } },
      },
    },
  },
});

/** Returns a list of problems; empty means the body is safe to store/publish. */
export function validateWorkflowBody(body: unknown): string[] {
  if (!validateBody(body)) return (validateBody.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  const { steps, target_map, parameters } = body as WorkflowBody;
  const errs: string[] = [];
  steps.forEach((s, i) => {
    const at = `/steps/${i}`;
    if (!(s.target in target_map)) errs.push(`${at} target "${s.target}" not in target_map`);
    if (s.action === "fill" && s.value === undefined) errs.push(`${at} fill needs a value`);
    if (s.action === "read" && !s.into) errs.push(`${at} read needs "into"`);
    if (s.action !== "read" && s.into) errs.push(`${at} only read may use "into"`);
    if (s.commit && s.action !== "click") errs.push(`${at} commit must be on a click`);
    for (const [, name] of (s.value ?? "").matchAll(/\{\{(\w+)\}\}/g))
      if (!(name in parameters)) errs.push(`${at} placeholder {{${name}}} is not a parameter`);
  });
  if (steps.filter((s) => s.commit).length > 1) errs.push("/steps at most one commit step");
  return errs;
}

export const commitStepIndex = (steps: Step[]) => {
  const i = steps.findIndex((s) => s.commit);
  return i < 0 ? null : i;
};
export const outputNames = (steps: Step[]) => steps.filter((s) => s.action === "read").map((s) => s.into!);

/** Workflow Contract: the JSON Schema for a Run request's `parameters`, derived from the Parameters alone. */
export function contractSchema(parameters: Parameters) {
  const properties: Record<string, object> = {};
  for (const [name, p] of Object.entries(parameters))
    // ponytail: date is a shape check only (YYYY-MM-DD); "2026-02-31" passes. Add a real-date check if it bites.
    properties[name] = p.type === "date" ? { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } : { type: p.type };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.entries(parameters).filter(([, p]) => p.required).map(([n]) => n),
    properties,
  };
}

const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
/** Validate Run parameters against the Contract. Returns problems; empty = valid. */
export function validateParameters(cacheKey: string, parameters: Parameters, input: unknown): string[] {
  let v = compiled.get(cacheKey);
  if (!v) compiled.set(cacheKey, (v = ajv.compile(contractSchema(parameters))));
  return v(input) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}
