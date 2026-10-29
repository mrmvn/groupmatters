// Atom feed of a space's activity (spec §9, optional).
import type { Ctx } from "./ctx.ts";
import type { ActivityEvent, Space } from "./types.ts";
import * as repo from "./repo.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export function describeEvent(e: ActivityEvent, titles: Map<string, string>): string {
  const t = e.question_id ? `“${titles.get(e.question_id) ?? "a question"}”` : "the space";
  const d = e.data as any;
  switch (e.action) {
    case "question.created":
      return `${e.actor} added ${t}`;
    case "question.status_changed":
      return `${t}: ${d.from} → ${d.to}${d.reason ? ` (${d.reason})` : ""}`;
    case "process.state_changed":
      return `${t}: process is now ${d.after?.outcome_summary ?? d.after?.state}`;
    case "resolution.pending":
      return `${t} is ready to resolve`;
    case "resolution.confirmed":
      return `${t} was resolved (${d.record?.outcome ?? "concluded"})`;
    case "objection.raised":
      return `${e.actor} objected to ${t}: ${d.reason}`;
    case "objection.addressed":
      return `${e.actor} addressed an objection on ${t}`;
    case "tool.added":
      return `Tool added: ${d.tool?.name}`;
    case "charter.changed":
      return "The charter was changed";
    case "settings.changed":
      return "Settings were changed";
    default:
      return `${e.actor}: ${e.action.replace(/[._]/g, " ")} ${t}`;
  }
}

export function atomFeed(ctx: Ctx, space: Space, token: string): string {
  const events = repo.listActivity(ctx.db, space.id, { limit: 50 });
  const titles = new Map(repo.listQuestions(ctx.db, space.id).map((q) => [q.id, q.title]));
  const base = `${ctx.config.publicUrl}/s/${token}`;
  const updated = events[0]?.at ?? space.created_at;
  const entries = events
    .map((e) => {
      const link = e.question_id ? `${base}#/q/${e.question_id}` : `${base}#/activity`;
      return `  <entry>
    <id>urn:question-register:${esc(space.id)}:event:${e.id}</id>
    <title>${esc(describeEvent(e, titles))}</title>
    <updated>${e.at}</updated>
    <author><name>${esc(e.actor)}</name></author>
    <link rel="alternate" href="${esc(link)}"/>
  </entry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>urn:question-register:${esc(space.id)}</id>
  <title>${esc(space.name)} — question register</title>
  <updated>${updated}</updated>
  <link rel="alternate" href="${esc(base)}"/>
${entries}
</feed>
`;
}
