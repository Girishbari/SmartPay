import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handler as demo } from "../../demo-billing/src/app.ts";
import { RECORDER } from "./config.ts";

// One port for everything (Render gives a web service one): the demo billing app under /demo/,
// the built console (pnpm --filter console build) at /, and the API both un-prefixed (curl, Agent) and under /api (console).
const DIST = new URL("../../console/dist/", import.meta.url);
const RECORDER_JS = new URL("./learner/recorder-page.js", import.meta.url);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", woff2: "font/woff2" };
// Tab recording: the demo pages carry the recorder script. It stays idle unless the console opened this tab to record.
const DEMO_HEAD = RECORDER === "tab" ? '<script src="/recorder-page.js" defer></script>' : "";

async function serveFile(file: URL, res: ServerResponse, cache: string) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[file.pathname.split(".").pop()!] ?? "application/octet-stream", "cache-control": cache }).end(body);
    return true;
  } catch {
    return false; // not built: fall through to the API's 404
  }
}

export const frontDoor = (api: (req: IncomingMessage, res: ServerResponse) => void) =>
  createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/demo") return res.writeHead(301, { location: "/demo/" }).end();
    if (path.startsWith("/demo/")) {
      req.url = req.url!.slice("/demo".length);
      return demo(req, res, DEMO_HEAD);
    }
    if (req.method === "GET") {
      if (path === "/recorder-page.js" && (await serveFile(RECORDER_JS, res, "no-cache"))) return;
      if (path === "/" && (await serveFile(new URL("index.html", DIST), res, "no-cache"))) return;
      // Vite puts a content hash in every asset name, so assets never change under the same name.
      if (/^\/assets\/[\w.-]+$/.test(path) && (await serveFile(new URL(path.slice(1), DIST), res, "public, max-age=31536000, immutable"))) return;
    }
    if (path.startsWith("/api/")) req.url = req.url!.slice("/api".length);
    api(req, res);
  });
