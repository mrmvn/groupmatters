import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, makeCtx } from "./helpers.ts";
import { github, normalizeIssue as ghIssue, normalizePull } from "../src/adapters/github.ts";
import { gitlab, normalizeIssue as glIssue, normalizeMergeRequest } from "../src/adapters/gitlab.ts";
import { matchUrl, SEED_TOOLS } from "../src/tools.ts";

test("GitHub PR normalization (recorded fixtures)", () => {
  const merged = normalizePull(fixture("github_pr_merged.json"));
  assert.equal(merged.state, "accepted");
  assert.equal(merged.terminal, true);
  assert.equal(merged.outcome_summary, "Merged");
  assert.ok(merged.dates?.resolved_at);
  assert.ok(merged.title);

  const closed = normalizePull(fixture("github_pr_closed_unmerged.json"));
  assert.equal(closed.state, "rejected");
  assert.equal(closed.terminal, true);

  const open = normalizePull(fixture("github_pr_open.json"));
  assert.equal(open.terminal, false);
  assert.ok(open.state === "open" || open.state === "not_started");

  assert.equal(normalizePull({ ...fixture("github_pr_open.json"), draft: true }).state, "not_started");
});

test("GitHub issue normalization uses state_reason", () => {
  assert.equal(ghIssue(fixture("github_issue_completed.json")).state, "accepted");
  assert.equal(ghIssue(fixture("github_issue_not_planned.json")).state, "rejected");
  assert.equal(ghIssue({ state: "closed", state_reason: "duplicate" }).state, "withdrawn");
  assert.equal(ghIssue({ state: "closed", state_reason: null }).state, "concluded");
  assert.equal(ghIssue({ state: "open" }).terminal, false);
});

test("GitLab normalization (recorded fixtures)", () => {
  assert.equal(normalizeMergeRequest(fixture("gitlab_mr_merged.json")).state, "accepted");
  assert.equal(normalizeMergeRequest(fixture("gitlab_mr_closed.json")).state, "rejected");
  assert.equal(normalizeMergeRequest(fixture("gitlab_mr_open.json")).terminal, false);
  assert.equal(glIssue(fixture("gitlab_issue_closed.json")).state, "concluded");
  assert.equal(glIssue(fixture("gitlab_issue_open.json")).state, "open");
  assert.equal(glIssue({ state: "closed", moved_to_id: 3 }).state, "withdrawn");
});

test("GitHub parse and fetch only call api.github.com built from ids", async () => {
  const { ctx, calls } = makeCtx({
    "https://api.github.com/repos/acme/widgets/pulls/7": { body: fixture("github_pr_merged.json"), headers: { etag: '"abc"' } },
  });
  const parsed = github.parse("https://github.com/acme/widgets/pull/7/files?x=1", ctx)!;
  assert.deepEqual(parsed, { item_type: "pull_request", ids: { owner: "acme", repo: "widgets", number: "7" } });
  const r = await github.fetch(parsed, ctx);
  assert.ok(!r.notModified && r.fetched.state === "accepted" && r.etag === '"abc"');
  assert.deepEqual(calls, ["https://api.github.com/repos/acme/widgets/pulls/7"]);
  assert.equal(github.parse("https://github.com/acme/widgets/pulls", ctx), null);
  assert.equal(github.parse("https://evil.example/acme/widgets/pull/7", ctx), null);
});

test("GitHub issue URL pointing to a PR is normalized as a PR", async () => {
  const { ctx } = makeCtx({
    "https://api.github.com/repos/a/b/issues/3": { body: { state: "closed", pull_request: {} } },
    "https://api.github.com/repos/a/b/pulls/3": { body: { state: "closed", merged: true, merged_at: "2025-01-01T00:00:00Z" } },
  });
  const r = await github.fetch(github.parse("https://github.com/a/b/issues/3", ctx)!, ctx);
  assert.ok(!r.notModified && r.fetched.state === "accepted");
});

test("GitLab only allows configured hosts (SSRF guard)", async () => {
  const { ctx, calls } = makeCtx({
    "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests/5": { body: fixture("gitlab_mr_merged.json") },
  });
  const parsed = gitlab.parse("https://gitlab.com/group/sub/proj/-/merge_requests/5/diffs", ctx)!;
  assert.deepEqual(parsed.ids, { host: "gitlab.com", project: "group/sub/proj", iid: "5" });
  const r = await gitlab.fetch(parsed, ctx);
  assert.ok(!r.notModified && r.fetched.state === "accepted");
  assert.equal(calls.length, 1);
  assert.equal(gitlab.parse("https://169.254.169.254/a/b/-/merge_requests/1", ctx), null);
  assert.equal(gitlab.parse("https://internal.example/a/b/-/issues/1", ctx), null);
  ctx.config.gitlabHosts.push("internal.example");
  assert.ok(gitlab.parse("https://internal.example/a/b/-/issues/1", ctx));
  assert.ok(gitlab.parse("https://internal.example/a/b/-/work_items/1", ctx));
});

test("URL matching against the seed registry", () => {
  const { ctx } = makeCtx();
  const m = (u: string) => {
    const r = matchUrl(ctx, SEED_TOOLS, u);
    return r && `${r.tool.id}:${r.item_type}`;
  };
  assert.equal(m("https://github.com/a/b/pull/1"), "github:pull_request");
  assert.equal(m("https://github.com/a/b/issues/1#issuecomment-2"), "github:issue");
  assert.equal(m("https://gitlab.com/a/b/-/merge_requests/1"), "gitlab:merge_request");
  assert.equal(m("https://www.metaculus.com/questions/12345/some-slug/"), "metaculus:question");
  assert.equal(m("https://www.loomio.com/p/AbC12/my-poll"), "loomio:poll");
  assert.equal(m("https://pol.is/2demo"), "polis:conversation");
  assert.equal(m("https://pol.is/report/r7suad4c8dxcprhxbfdfh"), "polis:conversation");
  assert.equal(m("https://www.loomio.com/d/GhC8oEcK/title"), "loomio:discussion");
  assert.equal(m("https://www.kialo.com/should-we-x-1234"), "kialo:discussion");
  assert.equal(m("http://github.com/a/b/pull/1"), undefined, "http is refused");
  assert.equal(m("https://example.com/whatever"), undefined);
  assert.equal(m("https://git.example.org/a/b/-/merge_requests/1"), undefined, "unlisted GitLab host");
});

// ---- Loomio, Polis, Metaculus ----
import { normalizePoll, normalizeDiscussion, loomio } from "../src/adapters/loomio.ts";
import { normalizeConversation, polis } from "../src/adapters/polis.ts";
import { normalizePost, metaculus } from "../src/adapters/metaculus.ts";
import { iso } from "../src/adapters/common.ts";
import { normalizeItem, opavote } from "../src/adapters/opavote.ts";

test("Loomio poll normalization (recorded fixture): closed → concluded, results summary, last activity from the thread", () => {
  const f = normalizePoll(fixture("loomio_poll_closed.json"), new Date("2026-10-01T00:00:00Z"));
  assert.equal(f.state, "concluded");
  assert.equal(f.terminal, true);
  assert.equal(f.title, "Do you support adopting this list of expectations and processes for Working Group operation?");
  assert.equal(f.outcome_summary, "Looks good 19 · Could be better 6 · Needs a rethink 1 (26 of 489 voted)");
  assert.equal(f.dates?.updated_at, "2026-09-24T13:59:24.811Z");
  assert.equal(f.dates?.resolved_at, "2026-09-24T14:00:17.677Z");
  assert.equal(f.extra?.eligible_voters, 489);
});

test("Loomio poll variants: open, not yet open, deleted, pass test, outcome statement", () => {
  const base = fixture("loomio_poll_closed.json");
  const now = new Date("2026-09-20T00:00:00Z");
  const variant = (patch: any) => {
    const d = structuredClone(base);
    Object.assign(d.polls[0], patch);
    return d;
  };
  const open = normalizePoll(variant({ closed_at: null }), now);
  assert.equal(open.state, "open");
  assert.match(open.outcome_summary!, /^Open: Looks good 19/);
  assert.equal(normalizePoll(variant({ closed_at: null, hide_results: "until_closed" }), now).outcome_summary, "Open");
  assert.equal(normalizePoll(variant({ closed_at: null, opened_at: null, opening_at: "2026-12-01T00:00:00Z" }), now).state, "not_started");
  assert.equal(normalizePoll(variant({ discarded_at: "2026-09-25T00:00:00Z" }), now).state, "withdrawn");
  const passed = variant({});
  passed.polls[0].results[0].test_result = true;
  assert.equal(normalizePoll(passed, now).state, "accepted");
  passed.polls[0].results[1].test_result = false;
  assert.equal(normalizePoll(passed, now).state, "rejected");
  const withOutcome = variant({ current_outcome_id: 7 });
  withOutcome.outcomes = [{ id: 7, statement: "<p>We adopt it, with   the amendments.</p>" }];
  assert.equal(normalizePoll(withOutcome, now).outcome_summary, "We adopt it, with the amendments.");
});

test("Loomio thread normalization: open, closed (locked), last activity", () => {
  const d = fixture("loomio_discussion_open.json");
  const f = normalizeDiscussion(d);
  assert.equal(f.state, "open");
  assert.equal(f.title, "Organizing the Social.Coop Organizing Circle");
  assert.equal(f.dates?.updated_at, "2023-07-29T21:58:24.430Z");
  assert.equal(f.extra?.comments, 25);
  d.topics[0].locked_at = "2023-08-01T00:00:00Z";
  assert.equal(normalizeDiscussion(d).state, "concluded");
});

test("Loomio: parse, fetch only www.loomio.com, private → manual fallback", async () => {
  const { ctx } = makeCtx({
    "https://www.loomio.com/api/v1/polls/irvWwUHt": { body: fixture("loomio_poll_closed.json") },
    "https://www.loomio.com/api/v1/polls/Priv4te1": { status: 403, body: { error: "Not authorized to show Poll." } },
  });
  assert.deepEqual(loomio.parse("https://loomio.com/p/irvWwUHt/some-title", ctx), { item_type: "poll", ids: { key: "irvWwUHt" } });
  assert.equal(loomio.parse("https://www.loomio.com/d/GhC8oEcK", ctx)?.item_type, "discussion");
  assert.equal(loomio.parse("https://www.loomio.com/g/abc", ctx), null);
  const r = await loomio.fetch(loomio.parse("https://www.loomio.com/p/irvWwUHt", ctx)!, ctx);
  assert.ok(!r.notModified && r.fetched.state === "concluded");
  await assert.rejects(() => loomio.fetch({ item_type: "poll", ids: { key: "Priv4te1" } }, ctx), (e: any) => e.manualFallback === true && /isn't public/.test(e.message));
});

test("Polis normalization (recorded fixture) and report links", async () => {
  const f = normalizeConversation(fixture("polis_conversation_open.json"));
  assert.equal(f.state, "open");
  assert.equal(f.title, "Same-sex marriage");
  assert.equal(f.outcome_summary, "Open · 574 participants");
  assert.equal(f.dates?.opens_at, "2023-04-18T03:24:42.521Z");
  assert.equal(f.dates?.updated_at, "2026-09-30T10:43:44.381Z", "modified is in µs");
  assert.equal(normalizeConversation({ ...fixture("polis_conversation_open.json"), is_active: false }).state, "concluded");

  const { ctx, calls } = makeCtx({
    "https://pol.is/api/v3/reports?report_id=r7suad4c8dxcprhxbfdfh": { body: [{ report_id: "r7suad4c8dxcprhxbfdfh", conversation_id: "4jbpxizvxf" }] },
    "https://pol.is/api/v3/conversations?conversation_id=4jbpxizvxf": { body: fixture("polis_conversation_open.json") },
  });
  assert.equal(polis.parse("https://pol.is/home", ctx), null, "site pages aren't conversations");
  const parsed = polis.parse("https://pol.is/report/r7suad4c8dxcprhxbfdfh", ctx)!;
  const r = await polis.fetch(parsed, ctx);
  assert.ok(!r.notModified && r.fetched.extra?.results_url === "https://pol.is/report/r7suad4c8dxcprhxbfdfh");
  assert.ok(calls.every((u) => u.startsWith("https://pol.is/api/v3/")));
});

test("Metaculus: only with a token; status and resolution mapping", async () => {
  const { ctx } = makeCtx();
  assert.equal(metaculus.available!(ctx), false);
  const m = matchUrl(ctx, SEED_TOOLS, "https://www.metaculus.com/questions/3530/slug/");
  assert.equal(m?.fetch_mode, "manual", "no token → updated by hand");
  const withToken = { ...ctx, config: { ...ctx.config, metaculusToken: "t" } };
  assert.equal(matchUrl(withToken, SEED_TOOLS, "https://www.metaculus.com/questions/3530/")?.fetch_mode, "auto");
  const post = (status: string, resolution: string | null = null) => normalizePost({ title: "Will X?", status, nr_forecasters: 5, question: { status, resolution } });
  assert.equal(post("upcoming").state, "not_started");
  assert.equal(post("open").state, "open");
  assert.equal(post("closed").state, "open");
  assert.equal(post("resolved", "yes").state, "accepted");
  assert.equal(post("resolved", "no").state, "rejected");
  assert.equal(post("resolved", "annulled").state, "withdrawn");
  assert.equal(post("resolved", "2027-01-01").outcome_summary, "Resolved: 2027-01-01");
  assert.equal(post("resolved", null).state, "concluded", "resolution hidden for restricted accounts");
});

test("timestamps in s, ms, µs and ISO", () => {
  assert.equal(iso("1681788282521"), "2023-04-18T03:24:42.521Z");
  assert.equal(iso(1681788282), "2023-04-18T03:24:42.000Z");
  assert.equal(iso("1790765024381000"), "2026-09-30T10:43:44.381Z");
  assert.equal(iso("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z");
  assert.equal(iso(null), undefined);
});

// ---- Decidim, Consul ----
import * as D from "../src/adapters/decidim.ts";
import * as C from "../src/adapters/consul.ts";

test("Decidim parse: items in any space type, whole participatory processes, any host", () => {
  const { ctx } = makeCtx();
  assert.deepEqual(D.decidim.parse("https://meta.decidim.org/processes/roadmap/f/122/proposals/12040", ctx), {
    item_type: "proposal",
    ids: { host: "meta.decidim.org", space: "processes", slug: "roadmap", component: "122", id: "12040" },
  });
  assert.equal(D.decidim.parse("https://participa.example.org/assemblies/council/f/9/meetings/31?locale=es", ctx)?.item_type, "meeting");
  assert.equal(D.decidim.parse("https://x.org/initiatives/i-12/f/3/debates/4", ctx)?.item_type, "debate");
  assert.equal(D.decidim.parse("https://meta.decidim.org/processes/roadmap/", ctx)?.item_type, "participatory_process");
  assert.equal(D.decidim.parse("https://meta.decidim.org/assemblies/council", ctx), null, "assemblies have no dates");
  assert.equal(D.decidim.parse("https://meta.decidim.org/processes/roadmap/f/122/proposals", ctx), null, "a list isn't an item");
  const m = (u: string) => matchUrl(ctx, SEED_TOOLS, u);
  assert.equal(m("https://www.decidim.barcelona/processes/pam/f/1/proposals/2")?.tool.id, "decidim");
  assert.equal(m("https://participa.gencat.cat/processes/reforma")?.item_type, "participatory_process");
});

test("Decidim proposals (recorded): custom state once answered → concluded; standard states", () => {
  const p = fixture("decidim_proposal_custom_state.json").data.component.proposal;
  const f = D.normalizeProposal(p);
  assert.equal(f.title, "Reconeixement automàtic de links", "the only translation");
  assert.equal(f.state, "concluded");
  assert.equal(f.raw_state, "Main repo (merged)");
  assert.equal(f.outcome_summary, "Main repo (merged) · 9 supports · 0 comments");
  assert.ok(f.dates?.updated_at);
  const s = (patch: any) => D.normalizeProposal({ ...p, proposalState: null, answeredAt: null, ...patch });
  assert.equal(s({ state: null }).state, "open");
  assert.equal(s({ state: "evaluating" }).raw_state, "Evaluating");
  assert.equal(s({ state: "accepted" }).state, "accepted");
  assert.equal(s({ state: "rejected" }).state, "rejected");
  assert.equal(s({ state: "accepted", withdrawnAt: "2026-01-01T00:00:00Z" }).state, "withdrawn");
  assert.equal(s({ state: "in_progress" }).state, "open", "custom state, not answered");
  assert.equal(D.pickTranslation({ translations: [{ locale: "ca", text: "Hola" }, { locale: "es", text: "Hola ES" }] }), "Hola ES");
});

test("Decidim meetings, debates and processes follow their dates", () => {
  const meeting = fixture("decidim_meeting.json").data.component.meeting;
  assert.equal(D.normalizeMeeting(meeting, new Date("2026-10-01")).raw_state, "Held");
  assert.equal(D.normalizeMeeting(meeting, new Date("2024-05-01")).state, "not_started");
  assert.equal(D.normalizeMeeting(meeting, new Date("2024-06-01")).state, "open");
  assert.equal(D.normalizeMeeting({ ...meeting, closed: true, closingReport: { translations: [{ locale: "en", text: "<p>Agreed: <b>yes</b></p>" }] } }, new Date("2024-06-01")).outcome_summary, "Agreed: yes");
  assert.equal(D.normalizeMeeting({ ...meeting, withdrawnAt: "2024-01-01T00:00:00Z" }, new Date()).state, "withdrawn");
  assert.equal(D.normalizeDebate({ title: { translations: [{ locale: "en", text: "D" }] }, closedAt: "2025-01-01T00:00:00Z" }, new Date()).state, "concluded");
  const proc = fixture("decidim_process.json").data.participatoryProcess;
  const during = D.normalizeProcess(proc, new Date("2026-10-30T00:00:00Z"));
  assert.equal(during.title, "Co-creating the roadmap");
  assert.equal(during.state, "open");
  assert.match(during.outcome_summary!, /^Step \d of \d: /);
  assert.equal(D.normalizeProcess(proc, new Date("2031-01-01")).state, "concluded");
  assert.equal(D.normalizeProcess(proc, new Date("2020-01-01")).state, "not_started");
});

test("Decidim fetch: POST to /api; unknown fields dropped and retried; private → by hand; private address refused", async () => {
  const queries: string[] = [];
  const t = makeCtx({
    "https://old.decidim.example/api": (init) => {
      const q = JSON.parse(String(init?.body)).query as string;
      queries.push(q);
      if (q.includes("proposalState")) return { body: { errors: [{ message: "nope", extensions: { code: "undefinedField", fieldName: "proposalState" } }] } };
      return { body: { data: { component: { proposal: { id: "1", title: { translations: [{ locale: "en", text: "Old one" }] }, state: "accepted" } } } } };
    },
    "https://private.decidim.example/api": { body: { errors: [{ message: "You cannot view", extensions: { code: "UNAUTHORIZED_OBJECT_ERROR" } }], data: { component: { proposal: null } } } },
  });
  const parsed = D.decidim.parse("https://old.decidim.example/processes/p/f/2/proposals/1", t.ctx)!;
  const r = await D.decidim.fetch(parsed, t.ctx);
  assert.ok(!r.notModified && r.fetched.state === "accepted" && r.fetched.title === "Old one");
  assert.equal(queries.length, 2);
  assert.ok(!queries[1].includes("proposalState"));
  await assert.rejects(() => D.decidim.fetch(D.decidim.parse("https://private.decidim.example/processes/p/f/2/proposals/1", t.ctx)!, t.ctx), (e: any) => e.manualFallback === true);
  t.privateHosts.add("intranet.example");
  await assert.rejects(() => D.decidim.fetch(D.decidim.parse("https://intranet.example/processes/p", t.ctx)!, t.ctx), /isn't reachable/);
  assert.ok(!t.calls.some((u) => u.includes("intranet")));
});

test("Consul (recorded): camelCase and snake_case instances, retired reasons, budgets and investments", async () => {
  const camel = C.normalizeProposal(fixture("consul_proposal_camel.json").data.proposal);
  assert.equal(camel.state, "open");
  assert.equal(camel.outcome_summary, "Open · 5 supports · 4 comments");
  assert.equal(camel.dates?.opens_at, "2026-10-29T02:00:00.000Z", "Consul date format with offset");
  const snake = C.normalizeProposal(fixture("consul_proposal_snake.json").data.proposal);
  assert.equal(snake.title, "Her er mit forslag");
  assert.equal(snake.outcome_summary, "Open · 0 supports · 0 comments");
  const retired = (reason: string) => C.normalizeProposal({ title: "x", retiredAt: "2026-01-01 10:00:00 +0100", retiredReason: reason });
  assert.equal(retired("done").state, "accepted");
  assert.equal(retired("unfeasible").state, "rejected");
  assert.equal(retired("duplicated").state, "withdrawn");
  assert.equal(retired("started").state, "open");
  assert.equal(C.normalizeBudget({ name: "PB", phase: "balloting" }).state, "open");
  assert.equal(C.normalizeBudget({ name: "PB", phase: "finished" }).state, "concluded");
  assert.equal(C.normalizeBudget({ name: "PB", phase: "informing" }).state, "not_started");
  const inv = fixture("consul_investment.json").data.budget;
  assert.equal(C.normalizeInvestment(inv.investment, inv).outcome_summary, "Open · feasibility: feasible · price 24000000");
  assert.equal(C.normalizeInvestment({ ...inv.investment, feasibility: "unfeasible" }, inv).state, "rejected");

  const { ctx } = makeCtx();
  assert.deepEqual(C.consul.parse("https://decide.example.es/proposals/123-mas-arboles", ctx), { item_type: "proposal", ids: { host: "decide.example.es", id: "123" } });
  assert.deepEqual(C.consul.parse("https://decide.example.es/budgets/4/investments/56", ctx), { item_type: "investment", ids: { host: "decide.example.es", budget: "4", id: "56" } });
  assert.equal(C.consul.parse("https://decide.example.es/budgets/4", ctx)?.item_type, "budget");
});

test("Consul fetch: tries snake_case when camelCase only returns id/title", async () => {
  const t = makeCtx();
  const snakeBody = fixture("consul_proposal_snake.json");
  // Any query: camelCase fields are "unknown" on this instance; snake_case ones work.
  t.ctx.fetch = async (url: string) => {
    t.calls.push(url);
    const q = decodeURIComponent(url.split("query=")[1]);
    if (/publicCreatedAt|cachedVotesUp|commentsCount|retiredAt|retiredReason|retiredExplanation|milestones/.test(q)) {
      const unknown = ["publicCreatedAt", "cachedVotesUp", "commentsCount", "retiredAt", "retiredReason", "retiredExplanation", "milestones"].filter((f) => q.includes(f));
      return new Response(JSON.stringify({ errors: unknown.map((f) => ({ extensions: { code: "undefinedField", fieldName: f } })) }));
    }
    if (q.includes("public_created_at")) return new Response(JSON.stringify(snakeBody));
    return new Response(JSON.stringify({ data: { proposal: { id: 1, title: "Her er mit forslag" } } }));
  };
  const r = await C.consul.fetch(C.consul.parse("https://www.sammenomaarhus.dk/proposals/1", t.ctx)!, t.ctx);
  assert.ok(!r.notModified && r.fetched.outcome_summary === "Open · 0 supports · 0 comments");
  assert.ok(t.calls.every((u) => u.startsWith("https://www.sammenomaarhus.dk/graphql?query=")));
});

test("OpaVote normalization (recorded fixture), links and errors", async () => {
  const f = normalizeItem(fixture("opavote_poll_voting.json"));
  assert.equal(f.state, "open");
  assert.equal(f.terminal, false);
  assert.equal(f.title, "OpaVote Demonstration Election");
  assert.match(f.outcome_summary!, /^Poll open for voting · 5 contests \(Plurality\/FPTP\/SNTV, Instant Runoff Voting/);
  assert.equal(f.extra?.results_url, "https://opavote.com/results/5654402576678912/1");
  assert.equal(f.dates, undefined);
  const variant = (patch: any) => normalizeItem({ ...fixture("opavote_poll_voting.json"), ...patch });
  assert.equal(variant({ status: "EDITING" }).state, "not_started");
  assert.equal(variant({ status: "END" }).state, "concluded");
  assert.equal(variant({ status: "END" }).terminal, true);
  assert.equal(variant({ status: "WHATEVER" }).state, "unknown");
  assert.equal(variant({ show_results: "no" }).extra?.results_url, undefined);

  const { ctx, calls } = makeCtx({
    "https://opavote.com/api/v1/items/5654402576678912": { body: fixture("opavote_poll_voting.json") },
    "https://opavote.com/api/v1/items/1234567890": { body: { error: true, msg: "This item has been deleted and is no longer available." } },
    "https://opavote.com/api/v1/items/1111111111": { body: { error: true, msg: "Must provide your secret key." } },
  });
  for (const u of ["https://opavote.com/vote/5654402576678912", "https://opavote.com/results/5654402576678912/1", "https://opavote.com/code/5654402576678912?kiosk=1"])
    assert.equal(matchUrl(ctx, SEED_TOOLS, u)?.tool.id, "opavote", u);
  assert.equal(opavote.parse("https://opavote.com/help/api", ctx), null);
  const r = await opavote.fetch(opavote.parse("https://opavote.com/vote/5654402576678912", ctx)!, ctx);
  assert.ok(!r.notModified && r.fetched.state === "open");
  const gone = await opavote.fetch({ item_type: "vote", ids: { eid: "1234567890" } }, ctx);
  assert.ok(!gone.notModified && gone.fetched.state === "withdrawn");
  await assert.rejects(() => opavote.fetch({ item_type: "vote", ids: { eid: "1111111111" } }, ctx), (e: any) => e.manualFallback === true);
  assert.ok(calls.every((u) => u.startsWith("https://opavote.com/api/v1/items/")));
});
