export const TENANT = process.env.TENANT_ID ?? "demo"; // ponytail: no auth in the MVP; production derives this from the API key
export const LEASE_SECONDS = Number(process.env.LEASE_SECONDS ?? 120);
/** Where Client Apps reach the Engine; shown in the console's curl. Render sets RENDER_EXTERNAL_URL itself. */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
/** "window": the Engine opens its own recorder window (needs a screen). "tab": the person records in their own tab (Render). */
export const RECORDER: "window" | "tab" = process.env.RECORDER === "tab" ? "tab" : "window";
/** The billing app the Agent drives. Default: the copy the Engine itself serves under /demo/. */
export const DEMO_APP_URL = process.env.DEMO_APP_URL ?? `${PUBLIC_URL}/demo/`;
