import { makePool, migrate } from "./db.ts";
import { seed } from "./seed.ts";
import { buildApp } from "./server.ts";
import { startSweeper } from "./sweeper.ts";

const PORT = Number(process.env.PORT ?? 3000);
const die = (msg: string): never => {
  console.error(`\nengine  ${msg}\n`);
  process.exit(1);
};

let db: ReturnType<typeof makePool>;
try {
  db = makePool();
  await migrate(db);
} catch (e) {
  const code = (e as { code?: string; errors?: { code?: string }[] }).code ?? (e as { errors?: { code?: string }[] }).errors?.[0]?.code;
  if (code === "ECONNREFUSED") die("Can't reach Postgres at the DATABASE_URL in .env. Is the Postgres container running?  (docker start my-postgres)");
  if (e instanceof Error && e.message.startsWith("DATABASE_URL is not set")) die(e.message);
  throw e;
}
await seed(db, { workflow: false });
startSweeper(db);
const app = buildApp(db);
try {
  // 127.0.0.1 by default: the MVP has no auth. Render needs HOST=0.0.0.0.
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: PORT });
} catch (e) {
  if ((e as { code?: string }).code === "EADDRINUSE") die(`Port ${PORT} is already in use. Another Engine may be running; stop it, or set PORT=<another port>.`);
  throw e;
}
