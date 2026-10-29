import { loadConfig, type Ctx } from "./ctx.ts";
import { openDb } from "./db.ts";
import { createApp } from "./http/server.ts";
import { startScheduler } from "./scheduler.ts";

const config = loadConfig();
const ctx: Ctx = { db: openDb(config.dbPath), now: () => new Date(), fetch: (u, i) => fetch(u, i), config };

const server = createApp(ctx);
server.listen(config.port, config.host, () => {
  console.log(`Question register listening on http://${config.host}:${config.port} (public URL ${config.publicUrl})`);
  console.log(`Database: ${config.dbPath}`);
});
const stop = startScheduler(ctx);

const shutdown = () => {
  stop();
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
