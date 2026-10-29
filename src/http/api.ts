// JSON API (spec §11). All UI actions go through here, authenticated by the space token in the path.
import type { Ctx } from "../ctx.ts";
import type { Role, Space } from "../types.ts";
import * as repo from "../repo.ts";
import * as Q from "../questions.ts";
import * as E from "../engine.ts";
import * as P from "../processes.ts";
import { list, similar } from "../search.ts";
import { addToolDirect, setToolEnabledDirect } from "../rules.ts";
import { exportSpace } from "../export.ts";
import { adapterIds } from "../adapters/index.ts";
import { bad, forbidden, HttpError, notFound } from "../util.ts";

export type ApiReq = {
  method: string;
  path: string[]; // segments after /api/s/:token/
  query: URLSearchParams;
  body: any;
  actor?: string;
  space: Space;
  role: Role;
};

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function counts(ctx: Ctx, space: Space) {
  const rows = ctx.db
    .prepare("SELECT section, status, COUNT(*) AS n FROM questions WHERE space_id = ? GROUP BY section, status")
    .all(space.id) as { section: string; status: string; n: number }[];
  const out: Record<string, Record<string, number>> = { main: {}, rules: {} };
  for (const r of rows) out[r.section][r.status] = r.n;
  return out;
}

function questionDetail(ctx: Ctx, space: Space, id: string) {
  const q = Q.load(ctx, space, id);
  const all = repo.listQuestions(ctx.db, space.id);
  const brief = (x: { id: string; title: string; status: string; section: string }) => ({ id: x.id, title: x.title, status: x.status, section: x.section });
  const parent = q.parent_id ? all.find((x) => x.id === q.parent_id) : undefined;
  const dup = q.duplicate_of_id ? all.find((x) => x.id === q.duplicate_of_id) : undefined;
  return {
    question: q,
    objections: repo.listObjections(ctx.db, q.id),
    parent: parent && brief(parent),
    duplicate_of: dup && brief(dup),
    children: all.filter((x) => x.parent_id === q.id).map(brief),
    duplicates: all.filter((x) => x.duplicate_of_id === q.id).map(brief),
    activity: repo.listActivity(ctx.db, space.id, { questionId: q.id, limit: 200 }),
    steward_inactive: E.stewardInactive(ctx, space, q),
    tool: q.process ? repo.getTool(ctx.db, space.id, q.process.tool_id) : undefined,
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
    return {
      space: repo.getSpace(ctx.db, space.id),
      role: r.role,
      tools: repo.listTools(ctx.db, space.id),
      adapters: adapterIds(),
      counts: counts(ctx, space),
      active_count: repo.countActive(ctx.db, space.id),
      now: ctx.now().toISOString(),
    };
  }
  if (method === "GET" && a === "activity" && !id) {
    const before = Number(r.query.get("before")) || undefined;
    return { activity: repo.listActivity(ctx.db, space.id, { before, limit: Number(r.query.get("limit")) || 100 }) };
  }
  if (method === "GET" && a === "export" && !id) return exportSpace(ctx, space);
  if (method === "GET" && a === "similar" && !id) {
    return { similar: similar(ctx, space, r.query.get("title") ?? "", r.query.get("exclude") ?? undefined) };
  }
  if (method === "POST" && a === "resolve-url" && !id) {
    if (typeof r.body?.url !== "string") throw bad("url is required");
    return P.previewUrl(ctx, space, r.body.url);
  }

  // ---- tools: added and toggled directly, no proposal or voting ----
  if (a === "tools") {
    if (method === "POST" && !id) {
      addToolDirect(ctx, space, actor, r.body);
      return { tools: repo.listTools(ctx.db, space.id) };
    }
    if (method === "POST" && id && b === "enabled") {
      setToolEnabledDirect(ctx, space, actor, id, r.body?.enabled);
      return { tools: repo.listTools(ctx.db, space.id) };
    }
    throw notFound();
  }

  // ---- questions ----
  if (a !== "questions") throw notFound();
  if (!id) {
    if (method === "GET") return { questions: list(ctx, space, Object.fromEntries(r.query.entries())) };
    if (method === "POST") {
      const q = await Q.create(ctx, space, actor, r.body);
      return questionDetail(ctx, space, q.id);
    }
    throw notFound();
  }

  if (!b) {
    if (method === "GET") return questionDetail(ctx, space, id);
    if (method === "PATCH") {
      Q.edit(ctx, space, Q.load(ctx, space, id), actor, r.body);
      return questionDetail(ctx, space, id);
    }
    throw notFound();
  }

  const q = Q.load(ctx, space, id);

  if (b === "resolution" && method === "PUT") {
    await Q.setResolution(ctx, space, q, actor, r.body);
    return questionDetail(ctx, space, id);
  }

  if (b === "process") {
    if (!c && method === "PUT") await Q.attachProcess(ctx, space, q, actor, r.body);
    else if (!c && method === "PATCH") P.setFraming(ctx, q, actor, r.body?.framing);
    else if (!c && method === "DELETE") P.removeProcess(ctx, space, q, actor);
    else if (c === "refresh" && method === "POST") {
      const res = await P.refreshProcess(ctx, q.id, { onDemand: true });
      await E.evaluateQuestion(ctx, space, q.id);
      return { ...questionDetail(ctx, space, id), refresh: res };
    } else if (c === "manual" && method === "POST") {
      P.manualUpdate(ctx, q, actor, r.body);
      await E.evaluateQuestion(ctx, space, q.id);
    } else throw notFound();
    return questionDetail(ctx, space, id);
  }

  if (method !== "POST" || c) throw notFound();
  const body = r.body ?? {};
  switch (b) {
    case "adopt":
      await Q.adopt(ctx, space, q, actor, body);
      break;
    case "activate":
      await Q.activate(ctx, space, q, actor, body);
      break;
    case "park":
      Q.park(ctx, space, q, actor, body);
      break;
    case "revive":
      Q.revive(ctx, space, q, actor);
      break;
    case "drop":
      Q.drop(ctx, space, q, actor, body);
      break;
    case "restore":
      Q.restore(ctx, space, q, actor, body);
      break;
    case "reopen":
      await Q.reopen(ctx, space, q, actor, body);
      break;
    case "hand_over":
      Q.handOver(ctx, space, q, actor, body);
      break;
    case "take_over":
      Q.takeOver(ctx, space, q, actor);
      break;
    case "object":
      E.object(ctx, space, q, actor, body);
      break;
    case "address":
      E.address(ctx, space, q, actor, body);
      await E.evaluateQuestion(ctx, space, q.id);
      break;
    case "attest":
      await E.attest(ctx, space, q, actor, body);
      break;
    case "confirm":
      await E.confirm(ctx, space, q, actor, body);
      break;
    default:
      throw notFound();
  }
  return questionDetail(ctx, space, id);
}
