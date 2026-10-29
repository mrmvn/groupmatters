// Search, filters, presets and duplicate hints (spec §7). Spaces are small: filtering in memory is enough.
import type { Ctx } from "./ctx.ts";
import type { Question, Space } from "./types.ts";
import * as repo from "./repo.ts";

export type ListedQuestion = Question & { open_objections: number };

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const STOP = new Set(
  (
    "the a an of to in on for and or is are be we our us it this that what how why who when which should do does can " +
    "le la les de des du un une et ou est sont nous notre que qui quoi comment pourquoi quand " +
    "el los las del una y o es son nosotros que como por cuando " +
    "der die das und oder ist sind wir wie was warum wann"
  ).split(" "),
);

const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

export function list(ctx: Ctx, space: Space, f: Record<string, string | undefined>): ListedQuestion[] {
  const objections = repo.openObjectionCounts(ctx.db, space.id);
  let qs: ListedQuestion[] = repo.listQuestions(ctx.db, space.id).map((q) => ({ ...q, open_objections: objections.get(q.id) ?? 0 }));
  const multi = (v?: string) => (v ? v.split(",").filter(Boolean) : undefined);

  const statuses = multi(f.status);
  if (statuses) qs = qs.filter((q) => statuses.includes(q.status));
  if (f.section) qs = qs.filter((q) => q.section === f.section);
  const tools = multi(f.tool);
  if (tools) qs = qs.filter((q) => q.process && tools.includes(q.process.tool_id));
  if (f.item_type) qs = qs.filter((q) => q.process?.item_type === f.item_type);
  const states = multi(f.state);
  if (states) qs = qs.filter((q) => q.process?.fetched && states.includes(q.process.fetched.state));
  if (f.mode) qs = qs.filter((q) => q.resolution.mode === f.mode);
  if (f.has_process === "yes") qs = qs.filter((q) => !!q.process);
  if (f.has_process === "no") qs = qs.filter((q) => !q.process);
  if (f.steward) qs = qs.filter((q) => q.steward && fold(q.steward) === fold(f.steward!));
  if (f.parent) qs = qs.filter((q) => q.parent_id === f.parent);

  switch (f.preset) {
    case "no_process":
      qs = qs.filter((q) => !q.process && ["inbox", "active", "standing"].includes(q.status));
      break;
    case "criteria_tbd":
      qs = qs.filter((q) => q.resolution.mode === "tbd" && !["dropped", "resolved"].includes(q.status));
      break;
    case "ready":
      qs = qs.filter((q) => !!q.pending_resolution);
      break;
    case "objections":
      qs = qs.filter((q) => q.open_objections > 0);
      break;
  }

  if (f.q?.trim()) {
    const terms = fold(f.q).split(/\s+/).filter(Boolean);
    qs = qs.filter((q) => {
      const hay = fold(
        [q.title, q.why_it_matters, q.process?.framing, q.process?.fetched?.title, q.resolution_record?.synthesis].filter(Boolean).join(" \n "),
      );
      return terms.every((t) => hay.includes(t));
    });
  }
  return qs;
}

/** Up to 5 existing questions similar to a draft title. */
export function similar(ctx: Ctx, space: Space, title: string, excludeId?: string) {
  const w = new Set(words(title));
  const ft = fold(title).trim();
  if (w.size === 0 && ft.length < 4) return [];
  const scored: { q: Question; score: number }[] = [];
  for (const q of repo.listQuestions(ctx.db, space.id)) {
    if (q.id === excludeId) continue;
    const qw = new Set(words(q.title));
    let common = 0;
    for (const x of w) if (qw.has(x) || [...qw].some((y) => y.length > 4 && x.length > 4 && (y.startsWith(x) || x.startsWith(y)))) common++;
    let score = w.size && qw.size ? common / Math.min(w.size, qw.size) : 0;
    if (ft.length >= 4 && fold(q.title).includes(ft)) score = Math.max(score, 0.9);
    if (score >= 0.5 && common + (score >= 0.9 ? 1 : 0) >= 1) scored.push({ q, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ q }) => ({ id: q.id, title: q.title, status: q.status, section: q.section }));
}
