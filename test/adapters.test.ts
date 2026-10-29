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
  assert.equal(m("https://www.kialo.com/should-we-x-1234"), "kialo:discussion");
  assert.equal(m("http://github.com/a/b/pull/1"), undefined, "http is refused");
  assert.equal(m("https://example.com/whatever"), undefined);
  assert.equal(m("https://git.example.org/a/b/-/merge_requests/1"), undefined, "unlisted GitLab host");
});
