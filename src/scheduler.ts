// In-process scheduler (single instance in v0): refresh due processes, evaluate criteria, dormancy sweep.
import type { Ctx } from "./ctx.ts";
import * as repo from "./repo.ts";
import { refreshProcess } from "./processes.ts";
import { dormancySweep, evaluateAll } from "./engine.ts";

const DORMANCY_EVERY_MS = 60 * 60_000; // checked hourly; questions go dormant after N days

export async function tick(ctx: Ctx) {
  const due = repo.dueProcesses(ctx.db, ctx.now().toISOString());
  for (const p of due) {
    try {
      await refreshProcess(ctx, p.question_id);
    } catch (e) {
      console.error(`refresh ${p.question_id}:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 250)); // be gentle with external APIs
  }
  await evaluateAll(ctx);
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
  const dorm = () => {
    try {
      const n = dormancySweep(ctx);
      if (n) console.log(`dormancy: ${n} question(s) moved to dormant`);
    } catch (e) {
      console.error("dormancy sweep failed:", e);
    }
  };
  setTimeout(run, 2_000);
  setTimeout(dorm, 5_000);
  const t1 = setInterval(run, ctx.config.tickMs);
  const t2 = setInterval(dorm, DORMANCY_EVERY_MS);
  return () => (clearInterval(t1), clearInterval(t2));
}
