import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Load the repo's .env (git-ignored) when present. Variables already in the environment win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  /* no .env file: rely on the real environment */
}

export const DATABASE_URL = process.env.DATABASE_URL;
/** The Engine keeps its tables in this schema, so it can share any Postgres database without touching other projects' tables. */
export const SCHEMA = "billing_engine";

export type Db = pg.Pool;

export function makePool(url = DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env and point it at your Postgres.");
  return new pg.Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
}

export async function migrate(db: Db) {
  // ponytail: one idempotent schema file, no migration tool. Add one when the schema starts changing under live data.
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await db.query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
}

/** Run fn inside a transaction on one connection. */
export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
