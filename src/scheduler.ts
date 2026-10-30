// In-process scheduler (single instance): refresh due processes. Questions that follow their
// process are updated as part of each refresh.
import type { Ctx } from "./ctx.ts";
import * as repo from "./repo.ts";
import { refreshProcess } from "./processes.ts";

export async function tick(ctx: Ctx) {
  const due = repo.dueProcesses(ctx.db, ctx.now().toISOString());
  for (const p of due) {
    try {
      await refreshProcess(ctx, p.question_id);
    } catch (e) {
      console.error(`refresh ${p.question_id}:`, (e as Error).message);
    }
    if (due.length > 1) await new Promise((r) => setTimeout(r, 250)); // be gentle with external APIs
  }
}

export function startScheduler(ctx: Ctx) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(ctx);
    } catch (e) {
      console.error("scheduler tick failed:", e);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 2_000);
  const t = setInterval(run, ctx.config.tickMs);
  return () => clearInterval(t);
}
