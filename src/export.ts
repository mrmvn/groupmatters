// Full-space JSON export (spec §11). Format documented in docs/EXPORT.md.
import type { Ctx } from "./ctx.ts";
import type { Space } from "./types.ts";
import * as repo from "./repo.ts";

export const EXPORT_FORMAT = "question-register/v1";

export function exportSpace(ctx: Ctx, space: Space) {
  const fresh = repo.getSpace(ctx.db, space.id)!;
  return {
    format: EXPORT_FORMAT,
    exported_at: ctx.now().toISOString(),
    space: fresh,
    tools: repo.listTools(ctx.db, space.id),
    questions: repo
      .listQuestions(ctx.db, space.id)
      .reverse()
      .map((q) => ({ ...q, objections: repo.listObjections(ctx.db, q.id) })),
    activity: repo.allActivity(ctx.db, space.id),
  };
}
