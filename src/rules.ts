// The Rules page's actions: the tool list and the space's status labels. Direct actions by anyone
// with edit access, logged in the activity log (no proposals or votes).
import type { Ctx } from "./ctx.ts";
import type { NormalizedState, Space, StatusLabel, Tool } from "./types.ts";
import { CUSTOM_TOOL_ID, isQuestionState } from "./types.ts";
import * as repo from "./repo.ts";
import { INSTANCE_KINDS, validatePattern, validateStateMap } from "./tools.ts";
import { tx } from "./db.ts";
import { bad, requireText, slugify } from "./util.ts";

type ToolInput = { name: string; description?: string; url_patterns: { pattern: string; item_type: string }[]; state_map?: Record<string, NormalizedState> };

/** "What is it useful for?": optional plain text. Empty means none. */
export function validateDescription(d: unknown): string | undefined {
  if (d == null) return undefined;
  if (typeof d !== "string") throw bad("The description must be text");
  const t = d.trim().replace(/[ \t]+/g, " ");
  if (t.length > 400) throw bad("Keep the description under 400 characters");
  return t || undefined;
}

export function validateToolInput(t: any): ToolInput {
  if (!t || typeof t !== "object") throw bad("Invalid tool");
  const name = requireText(t.name, "Tool name", 60);
  if (!Array.isArray(t.url_patterns) || t.url_patterns.length === 0) throw bad("Add at least one URL pattern");
  if (t.url_patterns.length > 10) throw bad("At most 10 URL patterns");
  const url_patterns = t.url_patterns.map((p: any) => ({
    pattern: validatePattern(p?.pattern),
    item_type: slugify(requireText(p?.item_type, "Item type", 40)).replace(/-/g, "_"),
  }));
  const state_map = validateStateMap(t.state_map) ?? { Open: "open", Closed: "concluded" };
  return { name, description: validateDescription(t.description), url_patterns, state_map };
}

/** `{kind: "consul", base_url, name?}`: an instance of a supported platform, fetched automatically. */
function instanceToolInput(input: any): Omit<Tool, "id" | "enabled"> {
  const kind = INSTANCE_KINDS[String(input.kind)];
  if (!kind) throw bad("Unknown kind of tool");
  let u: URL;
  try {
    u = new URL(String(input.base_url ?? "").trim());
  } catch {
    throw bad("Give the instance's address, like https://participa.example.org");
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw bad("The address must be a plain https:// address");
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw bad("That doesn't look like a public web address");
  const name = input.name ? requireText(input.name, "Tool name", 60) : `${kind.name} (${host})`;
  const description = input.description === undefined ? kind.description : validateDescription(input.description);
  return { name, description, url_patterns: kind.patterns(host), fetch_mode: "auto", adapter: kind.adapter, state_map: kind.state_map };
}

/** Add a tool directly: a manual tool (patterns + states), or an instance of a supported platform. */
export function addToolDirect(ctx: Ctx, space: Space, actor: string, input: any): Tool {
  const t = input?.kind && input.kind !== "manual" ? instanceToolInput(input) : { ...validateToolInput(input), fetch_mode: "manual" as const };
  return tx(ctx.db, () => {
    const existing = new Set([CUSTOM_TOOL_ID, ...repo.listTools(ctx.db, space.id).map((x) => x.id)]);
    const root = slugify(t.name);
    let id = root;
    for (let i = 2; existing.has(id); i++) id = `${root}-${i}`;
    const tool: Tool = { id, ...t, enabled: true };
    repo.insertTool(ctx.db, space.id, tool);
    repo.logEvent(ctx, { space_id: space.id, actor, action: "tool.added", data: { tool } });
    return tool;
  });
}

/**
 * Edit a tool. Manual tools: name, description, URL patterns, states. Automatic tools are tied to their
 * adapter: only the name and description can change. A missing `description` keeps the current one.
 */
export function editToolDirect(ctx: Ctx, space: Space, actor: string, toolId: string, input: any): Tool {
  const tool = repo.getTool(ctx.db, space.id, String(toolId));
  if (!tool) throw bad("Unknown tool");
  if (!input || typeof input !== "object") throw bad("Invalid tool");
  const keepDescription = !("description" in input);
  let t: ToolInput;
  if (tool.adapter) {
    const same = (k: "url_patterns" | "state_map") => !(k in input) || JSON.stringify(input[k]) === JSON.stringify(tool[k]);
    if (!same("url_patterns") || !same("state_map")) throw bad(`${tool.name} is updated automatically; only its name and description can be edited`);
    t = { name: requireText(input.name, "Tool name", 60), description: validateDescription(input.description), url_patterns: tool.url_patterns, state_map: tool.state_map };
  } else t = validateToolInput(input);
  if (keepDescription) t.description = tool.description;
  const pick = (x: ToolInput) => ({ name: x.name, description: x.description, url_patterns: x.url_patterns, state_map: x.state_map });
  const before = pick(tool);
  const after = pick(t);
  if (JSON.stringify(before) === JSON.stringify(after)) return tool;
  const updated: Tool = { ...tool, ...after };
  tx(ctx.db, () => {
    repo.updateTool(ctx.db, space.id, updated);
    repo.logEvent(ctx, { space_id: space.id, actor, action: "tool.edited", data: { tool_id: tool.id, before, after } });
  });
  return updated;
}

/** Enable or disable a tool directly. */
export function setToolEnabledDirect(ctx: Ctx, space: Space, actor: string, toolId: string, enabled: unknown) {
  const tool = repo.getTool(ctx.db, space.id, String(toolId ?? ""));
  if (!tool) throw bad("Unknown tool");
  if (typeof enabled !== "boolean") throw bad("enabled must be true or false");
  if (tool.enabled === enabled) throw bad(`${tool.name} is already ${tool.enabled ? "enabled" : "disabled"}`);
  tx(ctx.db, () => {
    repo.setToolEnabled(ctx.db, space.id, tool.id, enabled);
    repo.logEvent(ctx, { space_id: space.id, actor, action: enabled ? "tool.enabled" : "tool.disabled", data: { tool_id: tool.id } });
  });
}

export function validateStatusLabels(input: unknown): StatusLabel[] {
  if (!Array.isArray(input) || input.length === 0) throw bad("Add at least one status");
  if (input.length > 30) throw bad("At most 30 statuses");
  const seen = new Set<string>();
  const out = input.map((l: any) => {
    const label = requireText(l?.label, "Status label", 80);
    if (!isQuestionState(l?.state)) throw bad(`Unknown category for "${label}"`);
    const key = label.toLowerCase();
    if (seen.has(key)) throw bad(`"${label}" appears twice`);
    seen.add(key);
    return { label, state: l.state };
  });
  if (!out.some((l) => l.state === "not_started")) throw bad("Keep at least one status in the “Not started” category (used for new questions)");
  return out;
}

/** Replace the space's hand-set status labels. Questions keep their current label text. */
export function setStatusLabels(ctx: Ctx, space: Space, actor: string, input: unknown) {
  const status_labels = validateStatusLabels(input);
  const fresh = repo.getSpace(ctx.db, space.id)!;
  const before = fresh.settings.status_labels;
  if (JSON.stringify(before) === JSON.stringify(status_labels)) return fresh;
  fresh.settings = { ...fresh.settings, status_labels };
  tx(ctx.db, () => {
    repo.updateSpace(ctx.db, fresh);
    repo.logEvent(ctx, { space_id: space.id, actor, action: "settings.changed", data: { before: { status_labels: before }, after: { status_labels } } });
  });
  Object.assign(space, fresh);
  return fresh;
}
