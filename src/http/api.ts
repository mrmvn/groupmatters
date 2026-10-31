// JSON API. All UI actions go through here, authenticated by the space token in the path.
import type { Ctx } from "../ctx.ts";
import type { Role, Space } from "../types.ts";
import { CUSTOM_TOOL_ID } from "../types.ts";
import * as repo from "../repo.ts";
import * as Q from "../questions.ts";
import * as P from "../processes.ts";
import { list, similar } from "../search.ts";
import { addToolDirect, editToolDirect, setStatusLabels, setToolEnabledDirect } from "../rules.ts";
import { exportSpace } from "../export.ts";
import { timeline } from "../timeline.ts";
import { arrange, roleOf, ROLES } from "../relations.ts";
import { dashboard } from "../dashboard.ts";
import { withFields } from "../fields.ts";
import { adapterIds, getAdapter } from "../adapters/index.ts";
import { forbidden, HttpError, notFound, bad } from "../util.ts";

export type ApiReq = {
  method: string;
  path: string[]; // segments after /api/s/:token/
  query: URLSearchParams;
  body: any;
  actor?: string;
  space: Space;
  role: Role;
};

const MAX_ACTIVITY_LIMIT = 500;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function counts(ctx: Ctx, space: Space) {
  const rows = ctx.db.prepare("SELECT status, COUNT(*) AS n FROM questions WHERE space_id = ? AND removed_at IS NULL GROUP BY status").all(space.id) as { status: string; n: number }[];
  const out: Record<string, number> = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  out.removed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE space_id = ? AND removed_at IS NOT NULL").get(space.id) as { n: number }).n;
  return out;
}

type Usage = { questions: number; in_progress: number };

/**
 * How many (non-removed) questions use each tool, and how many of them are in progress (status open).
 * Custom processes (not on the tool list) are counted by their typed kind.
 */
function usage(ctx: Ctx, space: Space) {
  const tools = new Map<string, Usage>();
  const custom = new Map<string, Usage>();
  for (const q of repo.listQuestions(ctx.db, space.id)) {
    const p = q.process;
    if (!p) continue;
    const key = p.tool_id === CUSTOM_TOOL_ID ? (q.typed.kind?.value as string | undefined) : p.tool_id;
    if (!key) continue;
    const map = p.tool_id === CUSTOM_TOOL_ID ? custom : tools;
    const u = map.get(key) ?? { questions: 0, in_progress: 0 };
    u.questions++;
    if (q.status === "open") u.in_progress++;
    map.set(key, u);
  }
  const customKinds = [...custom].map(([kind, u]) => ({ kind, ...u })).sort((a, b) => b.questions - a.questions || a.kind.localeCompare(b.kind));
  return { tools, custom: customKinds };
}

/** Tools as the UI needs them: `fetch_mode` is the effective mode on this server, plus `usage`. */
function toolsView(ctx: Ctx, space: Space, used = usage(ctx, space).tools) {
  return repo.listTools(ctx.db, space.id).map((t) => {
    const a = t.adapter ? getAdapter(t.adapter) : undefined;
    const usable = t.fetch_mode === "auto" && !!a && (!a.available || a.available(ctx));
    const u = used.get(t.id) ?? { questions: 0, in_progress: 0 };
    return t.fetch_mode === "auto" && !usable ? { ...t, fetch_mode: "manual" as const, auto_unavailable: true, usage: u } : { ...t, usage: u };
  });
}

/**
 * The list, each question with `links` (what the questions it's related to are to it: parent, child,
 * related, duplicate_of, duplicated_by; removed ones left out). With `hierarchy=1` children follow their
 * parent and duplicates their original (`depth`, `parent_id`, `nested_as`), and related questions at the
 * same level are kept together (`cluster`, `cluster_prev`); see relations.ts `arrange`.
 */
function listView(ctx: Ctx, space: Space, query: Record<string, string | undefined>) {
  let qs = list(ctx, space, query) as ReturnType<typeof list>[number][];
  const relations = repo.listRelations(ctx.db, space.id);
  if (query.hierarchy === "1") qs = arrange(qs, relations, { cluster: true });
  const byId = new Map(repo.listQuestions(ctx.db, space.id).map((x) => [x.id, x]));
  return qs.map((q) => {
    const links = relations
      .filter((r) => r.from_id === q.id || r.to_id === q.id)
      .flatMap((r) => {
        const other = byId.get(r.from_id === q.id ? r.to_id : r.from_id);
        return other ? [{ id: other.id, title: other.title, status: other.status, role: roleOf(r, q.id) }] : [];
      })
      .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
    return { ...q, links };
  });
}

function questionDetail(ctx: Ctx, space: Space, id: string) {
  const q = Q.load(ctx, space, id);
  const all = repo.listQuestions(ctx.db, space.id);
  const byId = new Map(all.map((x) => [x.id, x]));
  // Every relation is shown on both questions; `direction` says which side this question is on.
  const related = repo.relationsOf(ctx.db, q.id).flatMap((r) => {
    const outgoing = r.from_id === q.id;
    const other = byId.get(outgoing ? r.to_id : r.from_id);
    return other
      ? [{ id: other.id, title: other.title, status: other.status, kind: r.kind, direction: outgoing ? "to" : "from", role: roleOf(r, q.id), created_at: r.created_at, created_by: r.created_by }]
      : [];
  });
  // Parents, children, related, then duplicates; the oldest first within each.
  related.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  return {
    question: withFields(q),
    related,
    activity: repo.listActivity(ctx.db, space.id, { questionId: q.id, limit: 200 }),
    tool: q.process && q.process.tool_id !== CUSTOM_TOOL_ID ? repo.getTool(ctx.db, space.id, q.process.tool_id) : undefined,
  };
}

export async function handleApi(ctx: Ctx, r: ApiReq): Promise<unknown> {
  const { method, path, space } = r;
  const isWrite = WRITE_METHODS.has(method);
  if (isWrite && r.role !== "edit") throw forbidden("This is a view-only link");
  if (isWrite && !r.actor && !(method === "POST" && path[0] === "resolve-url"))
    throw new HttpError(400, "name_required", "Please set your display name first");
  const actor = r.actor ?? "anonymous";
  const [a, id, b, c] = path;

  // ---- space-level ----
  if (method === "GET" && a === "space" && !id) {
    const used = usage(ctx, space);
    return {
      space: repo.getSpace(ctx.db, space.id),
      role: r.role,
      tools: toolsView(ctx, space, used.tools),
      custom_kinds: used.custom,
      adapters: adapterIds(),
      counts: counts(ctx, space),
      now: ctx.now().toISOString(),
    };
  }
  if (method === "GET" && a === "activity" && !id) {
    const before = Number(r.query.get("before")) || undefined;
    const limit = Math.min(Number(r.query.get("limit")) || 100, MAX_ACTIVITY_LIMIT);
    return { activity: repo.listActivity(ctx.db, space.id, { before, limit }) };
  }
  if (method === "GET" && a === "export" && !id) return exportSpace(ctx, space);
  if (method === "GET" && a === "timeline" && !id) {
    return { ...timeline(ctx, space, Object.fromEntries(r.query.entries())), now: ctx.now().toISOString() };
  }
  if (method === "GET" && a === "dashboard" && !id) {
    return dashboard(ctx, space, { you: r.query.get("you") ?? undefined, since: r.query.get("since") ?? undefined });
  }
  if (method === "GET" && a === "similar" && !id) {
    return { similar: similar(ctx, space, r.query.get("title") ?? "", r.query.get("exclude") ?? undefined) };
  }
  if (method === "POST" && a === "resolve-url" && !id) {
    if (typeof r.body?.url !== "string") throw bad("url is required");
    return P.previewUrl(ctx, space, r.body.url);
  }
  if (method === "PUT" && a === "settings" && id === "status-labels" && !b) {
    return { space: setStatusLabels(ctx, space, actor, r.body?.status_labels) };
  }

  // ---- tools: added, edited and toggled directly ----
  if (a === "tools") {
    if (method === "POST" && !id) {
      // Links already in the register that the new tool recognises start being retrieved.
      const { matched } = addToolDirect(ctx, space, actor, r.body);
      for (const qid of matched) await P.refreshProcess(ctx, qid);
    } else if (method === "PATCH" && id && !b) editToolDirect(ctx, space, actor, id, r.body);
    else if (method === "POST" && id && b === "enabled") setToolEnabledDirect(ctx, space, actor, id, r.body?.enabled);
    else throw notFound();
    return { tools: toolsView(ctx, space) };
  }

  // ---- questions ----
  if (a !== "questions") throw notFound();
  if (!id) {
    if (method === "GET") return { questions: listView(ctx, space, Object.fromEntries(r.query.entries())) };
    if (method === "POST") {
      const q = await Q.create(ctx, space, actor, r.body);
      return questionDetail(ctx, space, q.id);
    }
    throw notFound();
  }

  const q = Q.load(ctx, space, id);
  // A removed question is read-only until restored.
  if (isWrite && q.removed_at && b !== "restore") throw new HttpError(409, "removed", "This matter was removed. Restore it first.");

  if (!b) {
    if (method === "GET") return questionDetail(ctx, space, id);
    if (method === "PATCH") {
      Q.edit(ctx, space, q, actor, r.body);
      return questionDetail(ctx, space, id);
    }
    throw notFound();
  }

  if (!c && method === "POST" && (b === "remove" || b === "restore")) {
    if (b === "remove") Q.remove(ctx, space, q, actor, r.body);
    else Q.restore(ctx, space, q, actor);
    return questionDetail(ctx, space, id);
  }

  if (b === "fields" && !c && method === "PUT") {
    Q.updateFields(ctx, space, q, actor, r.body);
    return questionDetail(ctx, space, id);
  }

  if (b === "process") {
    if (!c && method === "PUT") await Q.attachProcess(ctx, space, q, actor, r.body);
    else if (!c && method === "DELETE") P.removeProcess(ctx, space, q, actor);
    else if (c === "refresh" && method === "POST") {
      const res = await P.refreshProcess(ctx, q.id, { onDemand: true });
      return { ...questionDetail(ctx, space, id), refresh: res };
    } else throw notFound();
    return questionDetail(ctx, space, id);
  }

  if (b === "related") {
    if (!c && method === "POST") Q.relate(ctx, space, q, actor, r.body);
    else if (c && method === "DELETE") Q.unrelate(ctx, space, q, actor, c);
    else throw notFound();
    return questionDetail(ctx, space, id);
  }

  throw notFound();
}
