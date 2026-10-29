// Demo space with seed questions covering every status and criterion kind (M6).
import type { Ctx } from "./ctx.ts";
import { createSpace } from "./spaces.ts";
import * as Q from "./questions.ts";
import * as E from "./engine.ts";
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
  await Q.create(ctx, s, "Ben", {
    title: "What do members value most in our meetups?",
    process_url: "https://pol.is/2demo",
    framing: "The Polis conversation maps opinions; it won't produce a single answer.",
  });
  const coc = await Q.create(ctx, s, "Ana", {
    title: "Should we adopt a code of conduct?",
    process_url: "https://www.loomio.com/p/AbCd1234/adopt-a-code-of-conduct",
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }, { kind: "date", at: inDays(21) }] },
    adopt: true,
  });
  P.manualUpdate(ctx, coc, "Ana", { state: "open", raw_state: "Open", outcome_summary: "Voting open: 12 agree, 2 abstain" });

  const thursday = await Q.create(ctx, s, "Chloé", {
    title: "Should we move the weekly call to Thursdays?",
    resolution: { mode: "criteria", criteria: [{ kind: "default_rule" }] },
    adopt: true,
  });
  E.object(ctx, s, thursday, "Ben", { reason: "Thursday clashes with the evening course several of us attend." });

  await Q.create(ctx, s, "Diego", {
    title: "Do we approve the 2025 budget?",
    why_it_matters: "The bank needs the signed budget before March.",
    resolution: { mode: "criteria", criteria: [{ kind: "attested", description: "Majority of members present approve it at the general assembly" }] },
    adopt: true,
  });

  await Q.create(ctx, s, "Ana", {
    title: "Which venue for the spring retreat?",
    resolution: { mode: "criteria", criteria: [{ kind: "date", at: inDays(-1) }] },
    adopt: true,
  }); // date already passed → "Ready to resolve"

  const inclusive = await Q.create(ctx, s, "Chloé", {
    title: "How can we make our decisions more inclusive?",
    resolution: { mode: "open", criteria: [] },
    adopt: true,
  });
  await Q.create(ctx, s, "Ben", { title: "Should meeting notes be translated into Spanish?", parent_id: inclusive.id });

  const license = await Q.create(ctx, s, "Diego", {
    title: "Which license for our documentation?",
    resolution: { mode: "criteria", criteria: [{ kind: "attested", description: "Agreement at the monthly meeting" }] },
    adopt: true,
  });
  await E.attest(ctx, s, license, "Diego", {
    attested: "Agreed unanimously at the 3 March meeting (9 present).",
    synthesis: "Documentation is published under CC BY 4.0.",
  });

  // A real, merged GitHub PR: resolves automatically once fetched (needs network).
  await Q.create(ctx, s, "Ben", {
    title: "Should CI use the newer upload-artifact action?",
    process_url: "https://github.com/nodejs/node/pull/50000",
    resolution: { mode: "criteria", criteria: [{ kind: "process_outcome" }] },
    adopt: true,
  });

  const merch = await Q.create(ctx, s, "Chloé", {
    title: "Should we print t-shirts?",
    resolution: { mode: "open", criteria: [] },
    adopt: true,
  });
  Q.park(ctx, s, merch, "Chloé", { reason: "Not before the budget is approved." });

  const dup = await Q.create(ctx, s, "Diego", { title: "How do new people pick their first task?" });
  Q.drop(ctx, s, dup, "Diego", { reason: "Same question already in the inbox", duplicate_of_id: newcomers.id });

  await Q.create(ctx, s, "Ana", {
    title: "Add Discourse to the tool list",
    why_it_matters: "Our forum runs on Discourse; we'd like to link threads as processes.",
    rules_payload: {
      kind: "add_tool",
      tool: {
        name: "Discourse (our forum)",
        url_patterns: [{ pattern: "https://forum.example.org/t/*", item_type: "topic" }],
        state_map: { Open: "open", Closed: "concluded", "Solved": "accepted" },
      },
    },
    adopt: true,
  });
  return r;
}
