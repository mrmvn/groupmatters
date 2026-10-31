// Relations between questions: how a stored `from → to` link reads from each side, the hierarchy
// (`child_of`, which can't loop) and the arrangements built on it (list and timeline).
import type { Relation, RelationKind } from "./types.ts";

/** What the *other* question is to this one. */
export type RelationRole = "parent" | "child" | "duplicate_of" | "duplicated_by" | "related";

export const ROLES: RelationRole[] = ["parent", "child", "related", "duplicate_of", "duplicated_by"];

/** What a relation is called when it's created from a question: "this question is a child of / the parent of…". */
export const RELATION_INPUTS = ["related", "child_of", "parent_of", "duplicate_of", "duplicated_by", "duplicate"] as const;
export type RelationInput = (typeof RELATION_INPUTS)[number];

/** The stored form of an input, as seen from `selfId` (the question the relation is created from). `swap`: self is the `to` side. */
export function storedKind(input: RelationInput): { kind: RelationKind; swap: boolean } {
  switch (input) {
    case "child_of": return { kind: "child_of", swap: false };
    case "parent_of": return { kind: "child_of", swap: true };
    case "duplicate":
    case "duplicate_of": return { kind: "duplicate", swap: false };
    case "duplicated_by": return { kind: "duplicate", swap: true };
    default: return { kind: "related", swap: false };
  }
}

/** What the other question is, seen from `selfId`. */
export function roleOf(r: Pick<Relation, "from_id" | "to_id" | "kind">, selfId: string): RelationRole {
  const outgoing = r.from_id === selfId;
  if (r.kind === "child_of") return outgoing ? "parent" : "child";
  if (r.kind === "duplicate") return outgoing ? "duplicate_of" : "duplicated_by";
  return "related";
}

/** Parent ids of each question (`child_of` links only), oldest link first. */
function parentsMap(relations: Relation[]) {
  const parents = new Map<string, string[]>();
  for (const r of relations) {
    if (r.kind !== "child_of") continue;
    const l = parents.get(r.from_id) ?? [];
    l.push(r.to_id);
    parents.set(r.from_id, l);
  }
  return parents;
}

/**
 * Would making `childId` a child of `parentId` close a loop? That's so when `parentId` is already
 * `childId` or below it. Returns the chain from `parentId` up to `childId` (inclusive), else undefined.
 */
export function hierarchyLoop(relations: Relation[], childId: string, parentId: string): string[] | undefined {
  if (childId === parentId) return [childId];
  const parents = parentsMap(relations);
  // Walk up from the would-be parent; remember the way back so the chain can be shown.
  const via = new Map<string, string>([[parentId, ""]]);
  const queue = [parentId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const p of parents.get(id) ?? []) {
      if (via.has(p)) continue;
      via.set(p, id);
      if (p === childId) {
        const chain = [p];
        for (let x = id; x; x = via.get(x) ?? "") chain.unshift(x);
        return chain;
      }
      queue.push(p);
    }
  }
  return undefined;
}

export type Arranged<T> = T & {
  depth: number;
  /** The question it stands under (a parent, or the original of a duplicate), when that one is in the list. */
  parent_id?: string;
  nested_as?: "child" | "duplicate";
  /** Related questions are kept together: this one follows a related one (same level), and these are the ones in its group. */
  cluster_prev?: true;
  cluster?: string[];
};

/**
 * Put questions where their links say. `items` come in the order wanted among siblings (activity,
 * start date…).
 * - A child stands under its parent, a duplicate under its original, each only once: under the first of
 *   them (parents by oldest link, then originals) that is in `items` and doesn't close a loop. When none
 *   is in `items` (filtered out) the question stands at the top.
 * - With `cluster`, related questions at the same level are moved next to each other (a group goes where
 *   its first member was, members in their own order). Left out of the timeline, where order is the date.
 */
export function arrange<T extends { id: string }>(items: T[], relations: Relation[], opts: { cluster?: boolean } = {}): Arranged<T>[] {
  const present = new Set(items.map((i) => i.id));
  const parents = parentsMap(relations);
  const originals = new Map<string, string[]>(); // a duplicate → what it duplicates
  const related = new Map<string, Set<string>>();
  for (const r of relations) {
    if (r.kind === "duplicate") originals.set(r.from_id, [...(originals.get(r.from_id) ?? []), r.to_id]);
    if (r.kind === "related") {
      for (const [x, y] of [[r.from_id, r.to_id], [r.to_id, r.from_id]]) related.set(x, (related.get(x) ?? new Set()).add(y));
    }
  }

  const placed = new Map<string, { parent: string; as: "child" | "duplicate" }>();
  // Is `id` the ancestor itself, or somewhere below it, in what's placed so far?
  const under = (id: string, ancestor: string) => {
    for (let x: string | undefined = id; x; x = placed.get(x)?.parent) if (x === ancestor) return true;
    return false;
  };
  for (const i of items) {
    const candidates = [
      ...(parents.get(i.id) ?? []).map((parent) => ({ parent, as: "child" as const })),
      ...(originals.get(i.id) ?? []).map((parent) => ({ parent, as: "duplicate" as const })),
    ];
    const hit = candidates.find((c) => present.has(c.parent) && !under(c.parent, i.id));
    if (hit) placed.set(i.id, hit);
  }

  const kids = new Map<string, T[]>();
  for (const i of items) {
    const p = placed.get(i.id)?.parent;
    if (p) kids.set(p, [...(kids.get(p) ?? []), i]);
  }

  const flags = new Map<string, { cluster_prev?: true; cluster?: string[] }>();
  const group = (list: T[]): T[] => {
    if (!opts.cluster) return list;
    const ids = new Set(list.map((i) => i.id));
    const done = new Set<string>();
    const out: T[] = [];
    for (const i of list) {
      if (done.has(i.id)) continue;
      // The group: related questions of this level, directly or through each other.
      const members = new Set([i.id]);
      for (const id of members) for (const o of related.get(id) ?? []) if (ids.has(o)) members.add(o);
      const ordered = list.filter((x) => members.has(x.id));
      ordered.forEach((x, n) => {
        done.add(x.id);
        out.push(x);
        if (ordered.length > 1) flags.set(x.id, { ...(n ? { cluster_prev: true as const } : {}), cluster: ordered.filter((y) => y !== x).map((y) => y.id) });
      });
    }
    return out;
  };

  const out: Arranged<T>[] = [];
  const visit = (i: T, depth: number) => {
    const pl = placed.get(i.id);
    out.push({ ...i, depth, ...(pl ? { parent_id: pl.parent, nested_as: pl.as } : {}), ...flags.get(i.id) });
    for (const k of group(kids.get(i.id) ?? [])) visit(k, depth + 1);
  };
  for (const i of group(items.filter((x) => !placed.has(x.id)))) visit(i, 0);
  return out;
}
