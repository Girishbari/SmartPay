import { SCHEMA, makePool } from "./db.ts";

// Wipes only the Engine's own schema. Anything else in the database is left alone.
const db = makePool();
await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await db.end();
console.log(`engine  dropped schema "${SCHEMA}". The Engine recreates it the next time it starts.`);
