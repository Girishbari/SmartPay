import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// MVP: local folder. Production swaps these two functions for S3 pre-signed PUT + HEAD; routes do not change.
const DIR = process.env.SCREENSHOT_DIR ?? "./screenshots";
export const KEY_RE = /^[\w.-]+$/;

export function saveScreenshot(key: string, bytes: Buffer) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, key), bytes);
}
export const screenshotExists = (key: string) => KEY_RE.test(key) && existsSync(join(DIR, key));
