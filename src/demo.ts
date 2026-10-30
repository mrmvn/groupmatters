// Demo space: questions covering each status category, status sources and kinds of process.
import type { Ctx } from "./ctx.ts";
import { createSpace } from "./spaces.ts";
import * as Q from "./questions.ts";
import * as P from "./processes.ts";
import { DAY_MS } from "./util.ts";

export async function seedDemo(ctx: Ctx) {
  const r = createSpace(ctx, "Demo collective");
  const s = r.space;
  const inDays = (d: number) => new Date(ctx.now().getTime() + d * DAY_MS).toISOString();

  const newcomers = await Q.create(ctx, s, "Ana", {
    title: "How do newcomers find a first task?",
    why_it_matters: "Three people asked this month and none of them stayed.",
  });
  const dup = await Q.create(ctx, s, "Diego", { title: "How do new people pick their first task?", status: { state: "withdrawn" } });
  Q.relate(ctx, s, dup, "Diego", { id: newcomers.id, kind: "duplicate" });

  // Real public items: their state is fetched (needs network).
  await Q.create(ctx, s, "Chloé", {
    title: "Should working groups adopt shared expectations and processes?",
    process_url: "https://www.loomio.com/p/irvWwUHt",
    framing: "A sense check on Social.coop's Loomio, used here as an example.",
  });
  await Q.create(ctx, s, "Ben", {
    title: "Should CI use the newer upload-artifact action?",
    process_url: "https://github.com/nodejs/node/pull/50000",
  });

  // Custom processes: no tool, described by hand.
  await Q.create(ctx, s, "Diego", {
    title: "Do we approve the 2025 budget?",
    why_it_matters: "The bank needs the signed budget before March.",
    process: { custom: { kind: "General assembly", title: "Spring general assembly", when: inDays(14) } },
  });
  const license = await Q.create(ctx, s, "Diego", {
    title: "Which license for our documentation?",
    process: { custom: { kind: "Monthly meeting", title: "March meeting" } },
  });
  P.manualUpdate(ctx, license, "Diego", { state: "accepted", raw_state: "Agreed", outcome_summary: "CC BY 4.0, agreed unanimously (9 present)" });

  // A manual tool: the state is set by hand.
  const remote = await Q.create(ctx, s, "Ana", {
    title: "Should we allow fully remote membership?",
    process_url: "https://www.kialo.com/should-membership-be-possible-fully-remote-12345",
    framing: "The argument map collects pros and cons; it won't decide.",
  });
  P.manualUpdate(ctx, remote, "Ana", { state: "open", raw_state: "Open", outcome_summary: "34 claims so far" });

  // Statuses set by hand.
  await Q.create(ctx, s, "Chloé", { title: "Should we move the weekly call to Thursdays?", status: { label: "Being discussed" } });
  const inclusive = await Q.create(ctx, s, "Chloé", { title: "How can we make our decisions more inclusive?", status: { label: "Being discussed" } });
  await Q.create(ctx, s, "Ben", { title: "Should meeting notes be translated into Spanish?", related_id: inclusive.id });
  await Q.create(ctx, s, "Chloé", { title: "Should we print t-shirts?", status: { label: "Not agreed" } });
  return r;
}
