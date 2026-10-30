// Demo space: questions covering each status category, retrieved and typed fields, kinds of process.
import type { Ctx } from "./ctx.ts";
import { createSpace } from "./spaces.ts";
import * as Q from "./questions.ts";
import { DAY_MS } from "./util.ts";

export async function seedDemo(ctx: Ctx) {
  const r = createSpace(ctx, "Demo collective");
  const s = r.space;
  // Whole days, relative to today.
  const day = (d: number) => new Date(ctx.now().getTime() + d * DAY_MS).toISOString().slice(0, 10);
  const type = (q: { id: string }, set: Record<string, unknown>, by: string) => Q.updateFields(ctx, s, Q.load(ctx, s, q.id), by, { set });

  const newcomers = await Q.create(ctx, s, "Ana", {
    title: "How do newcomers find a first task?",
    why_it_matters: "Three people asked this month and none of them stayed.",
  });
  const dup = await Q.create(ctx, s, "Diego", { title: "How do new people pick their first task?", status: { state: "withdrawn" } });
  Q.relate(ctx, s, dup, "Diego", { id: newcomers.id, kind: "duplicate" });

  // Real public items: their fields are retrieved (needs network).
  await Q.create(ctx, s, "Chloé", {
    title: "Should working groups adopt shared expectations and processes?",
    process_url: "https://www.loomio.com/p/irvWwUHt",
  });
  await Q.create(ctx, s, "Ben", {
    title: "Should CI use the newer upload-artifact action?",
    process_url: "https://github.com/nodejs/node/pull/50000",
  });

  // Custom processes: not on the tool list, so every field is typed.
  const budget = await Q.create(ctx, s, "Diego", {
    title: "Do we approve the 2025 budget?",
    why_it_matters: "The bank needs the signed budget before March.",
    process: { kind: "General assembly" },
  });
  type(budget, { start: `${day(14)}T18:00:00Z`, end: day(14) }, "Diego");
  const license = await Q.create(ctx, s, "Diego", { title: "Which license for our documentation?", process: { kind: "Monthly meeting" } });
  type(license, { status: { label: "Agreed" }, summary: "CC BY 4.0, agreed unanimously (9 present)", start: day(-40), end: day(-40) }, "Diego");
  // A link to a site that isn't on the tool list.
  const pad = await Q.create(ctx, s, "Ben", { title: "Which day for the summer picnic?", process: { url: "https://framadate.org/demo-picnic-poll", kind: "Date poll" } });
  type(pad, { status: { label: "Being discussed" }, start: day(-5), end: day(9) }, "Ben");

  // A tool updated by hand: its kind (and the page title, when there is one) are retrieved; the rest is typed.
  const remote = await Q.create(ctx, s, "Ana", {
    title: "Should we allow fully remote membership?",
    process_url: "https://www.kialo.com/should-membership-be-possible-fully-remote-12345",
  });
  type(remote, { status: { label: "Being discussed" }, summary: "34 claims so far", start: day(-25) }, "Ana");

  // No process: everything typed.
  const call = await Q.create(ctx, s, "Chloé", { title: "Should we move the weekly call to Thursdays?", status: { label: "Being discussed" } });
  type(call, { start: day(-10) }, "Chloé");
  const inclusive = await Q.create(ctx, s, "Chloé", { title: "How can we make our decisions more inclusive?", status: { label: "Being discussed" } });
  type(inclusive, { start: day(-20), end: day(30) }, "Chloé");
  await Q.create(ctx, s, "Ben", { title: "Should meeting notes be translated into Spanish?", related_id: inclusive.id });
  const shirts = await Q.create(ctx, s, "Chloé", { title: "Should we print t-shirts?", status: { label: "Not agreed" } });
  type(shirts, { start: day(-60) }, "Chloé");
  return r;
}
