// Timeline: the questions that have a start date, from their start to their end (see fields.ts).
// Same filters as the list. Questions without a start date aren't drawn.
import type { Ctx } from "./ctx.ts";
import type { QuestionState, Space } from "./types.ts";
import { effectiveDates, lowerBound } from "./fields.ts";

type EffectiveDate = { value: string; source: "typed" | "retrieved" };
import { list } from "./search.ts";

export type TimelineItem = {
  id: string;
  title: string;
  status: QuestionState;
  status_label?: string;
  process?: { tool_id: string; kind?: string };
  start: EffectiveDate;
  /** Absent: not known yet (a running question is drawn up to today; an ended one with an "end unknown" mark). */
  end?: EffectiveDate;
};

export function timeline(ctx: Ctx, space: Space, filters: Record<string, string | undefined>): { items: TimelineItem[]; undated: number } {
  const items: TimelineItem[] = [];
  let undated = 0;
  for (const q of list(ctx, space, filters)) {
    const { start, end } = effectiveDates(q);
    if (!start) {
      undated++;
      continue;
    }
    const p = q.process;
    items.push({
      id: q.id,
      title: q.title,
      status: q.status,
      ...(q.status_label ? { status_label: q.status_label } : {}),
      ...(p ? { process: { tool_id: p.tool_id, ...(q.fields.kind.value ? { kind: q.fields.kind.value as string } : {}) } } : {}),
      start,
      ...(end ? { end } : {}),
    });
  }
  items.sort((a, b) => {
    const x = lowerBound(a.start.value), y = lowerBound(b.start.value);
    return x < y ? -1 : x > y ? 1 : a.title.localeCompare(b.title);
  });
  return { items, undated };
}
