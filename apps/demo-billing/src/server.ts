import { createServer } from "node:http";
import { handler } from "./app.ts";

// Standalone copy of the billing app (pnpm dev:demo, tests). The Engine also serves it under /demo/.
const PORT = Number(process.env.PORT ?? 4000);
createServer(handler).listen(PORT, "127.0.0.1", () => console.log(`Ledgerline Billing on http://127.0.0.1:${PORT}`));
