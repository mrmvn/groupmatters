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

/**
 * Put children under their parents. `items` come in the order wanted among siblings (activity, start
 * date…); a question is placed under its first parent (oldest link) that is in `items`, so it appears once.
 * Parents are not shown when filtered out: the child then stands at the top (depth 0, no `parent_id`).
 */
export function arrange<T extends { id: string }>(items: T[], relations: Relation[]): (T & { depth: number; parent_id?: string })[] {
  const present = new Set(items.map((i) => i.id));
  const parents = parentsMap(relations);
  const placed = new Map<string, string>(); // child → the parent it stands under
  for (const i of items) {
    const p = (parents.get(i.id) ?? []).find((x) => present.has(x));
    if (p) placed.set(i.id, p);
  }
  const kids = new Map<string, T[]>();
  for (const i of items) {
    const p = placed.get(i.id);
    if (p) kids.set(p, [...(kids.get(p) ?? []), i]);
  }
  const out: (T & { depth: number; parent_id?: string })[] = [];
  const seen = new Set<string>();
  const visit = (i: T, depth: number) => {
    if (seen.has(i.id)) return;
    seen.add(i.id);
    const parent_id = placed.get(i.id);
    out.push({ ...i, depth, ...(parent_id ? { parent_id } : {}) });
    for (const k of kids.get(i.id) ?? []) visit(k, depth + 1);
  };
  for (const i of items) if (!placed.has(i.id)) visit(i, 0);
  // Only reachable if stored data already loops; never lose an item.
  for (const i of items) if (!seen.has(i.id)) visit(i, 0);
  return out;
}
