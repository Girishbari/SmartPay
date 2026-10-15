import pg from "pg";
import { DATABASE_URL, makePool, migrate } from "../src/db.ts";

/** A pool on a separate test database (engine_test) beside the one in DATABASE_URL, created on first use. */
export async function testPool() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  const admin = new pg.Client({ connectionString: DATABASE_URL });
  await admin.connect();
  await admin.query("CREATE DATABASE engine_test").catch((e) => {
    if (e.code !== "42P04") throw e; // already exists
  });
  await admin.end();
  const url = new URL(DATABASE_URL);
  url.pathname = "/engine_test";
  const db = makePool(url.toString());
  await migrate(db);
  return db;
}
