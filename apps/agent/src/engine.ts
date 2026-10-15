import type { Step } from "@lba/shared";

export type Config = {
  engineUrl: string; agentId: string; headless: boolean; pollMs: number; slowMoMs: number; actionTimeoutMs: number;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const headless = env.HEADLESS === "1";
  return {
    engineUrl: (env.ENGINE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, ""),
    agentId: env.AGENT_ID ?? "agent-1",
    headless,
    pollMs: Number(env.POLL_MS ?? 2000),
    slowMoMs: Number(env.SLOWMO_MS ?? (headless ? 0 : 600)), // a pause per step so a person can watch it work
    actionTimeoutMs: Number(env.ACTION_TIMEOUT_MS ?? 5000),
  };
};

export type Locator = { by: string; name: string; role?: string };
export type Claim = {
  run_id: string; attempt: number; target_instance_id: string; parameters: Record<string, unknown>;
  base_url: string | null; lease_expires_at: string;
  workflow: { steps: Step[]; target_map: Record<string, Locator>; commit_step: number | null };
};

/** Another attempt owns this Run now. Stop immediately and report nothing more. */
export class Stale extends Error {}
/** The Engine answered with an error that is not a stale attempt. */
export class EngineError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function engineClient(cfg: Config) {
  const fence = (c: Claim) => ({ agent_id: cfg.agentId, attempt: c.attempt });

  async function call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const res = await fetch(`${cfg.engineUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    if (res.status === 409) throw new Stale(`attempt is stale (${path})`);
    const text = await res.text();
    if (!res.ok) throw new EngineError(res.status, text);
    return text ? (JSON.parse(text) as T) : null;
  }

  return {
    /** Asking for work is also the heartbeat: the Engine records when this Agent last asked. */
    claim: () => call<Claim>("POST", `/agents/${cfg.agentId}/claims`),

    step: (c: Claim, report: { step_no: number; outcome: "ok" | "failed"; duration_ms: number; value_used?: string }) =>
      call("POST", `/runs/${c.run_id}/steps`, { ...fence(c), ...report }),

    async uploadScreenshot(c: Claim, png: Buffer) {
      const slot = (await call<{ key: string; upload_url: string }>("POST", `/runs/${c.run_id}/upload-url`, fence(c)))!;
      const url = slot.upload_url.startsWith("http") ? slot.upload_url : `${cfg.engineUrl}${slot.upload_url}`;
      const res = await fetch(url, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array(png) });
      if (!res.ok) throw new EngineError(res.status, "screenshot upload failed");
      return slot.key;
    },

    /** Report-before-Save. Resolves only on an explicit OK; anything else must mean "do not click". */
    commitIntent: (c: Claim, screenshotKey: string) => call("POST", `/runs/${c.run_id}/commit-intent`, { ...fence(c), screenshot_key: screenshotKey }),

    complete: (c: Claim, result: { status: "succeeded" | "failed"; outputs?: Record<string, string>; error?: string }) =>
      call("POST", `/runs/${c.run_id}/complete`, { ...fence(c), ...result }),
  };
}
