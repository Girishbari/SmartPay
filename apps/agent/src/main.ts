import { loadConfig } from "./engine.ts";
import { closeActiveBrowser, runNext } from "./run.ts";

const cfg = loadConfig();
console.log(`agent  ${cfg.agentId} asking ${cfg.engineUrl} for work every ${cfg.pollMs} ms (${cfg.headless ? "headless" : "visible browser"})`);

const stop = async () => { await closeActiveBrowser(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Outbound only: the Agent calls the Engine, never the other way round.
for (;;) {
  try {
    if (await runNext(cfg)) continue; // more may be waiting
  } catch (e) {
    console.error("agent  error:", e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, cfg.pollMs));
}
