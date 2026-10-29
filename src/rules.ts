// Rules-space templates (spec §8): validation of proposals and application on acceptance.
import type { Ctx } from "./ctx.ts";
import type { Question, RulesPayload, Space, SpaceSettings, Tool } from "./types.ts";
import * as repo from "./repo.ts";
import { validatePattern, validateStateMap } from "./tools.ts";
import { tx } from "./db.ts";
import { bad, requireText, slugify } from "./util.ts";

export function validateSettings(input: any): Partial<SpaceSettings> {
  if (input == null) return {};
  if (typeof input !== "object") throw bad("Invalid settings");
  const out: Partial<SpaceSettings> = {};
  const int = (k: keyof SpaceSettings, min: number, max: number, label: string) => {
    if (input[k] == null || input[k] === "") return;
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number between ${min} and ${max}`);
    (out as any)[k] = n;
  };
  int("active_cap", 1, 100, "Active limit");
  int("dormancy_days", 1, 3650, "Dormancy period");
  int("default_rule_days", 1, 365, "Objection window");
  if (input.auto_confirm_process_outcomes != null) {
    if (typeof input.auto_confirm_process_outcomes !== "boolean") throw bad("auto_confirm_process_outcomes must be true or false");
    out.auto_confirm_process_outcomes = input.auto_confirm_process_outcomes;
  }
  return out;
}

export function validatePayload(ctx: Ctx, space: Space, input: any): RulesPayload {
  if (!input || typeof input !== "object") throw bad("Invalid proposal");
  switch (input.kind) {
    case "add_tool": {
      const t = input.tool ?? {};
      const name = requireText(t.name, "Tool name", 60);
      if (!Array.isArray(t.url_patterns) || t.url_patterns.length === 0) throw bad("Add at least one URL pattern");
      if (t.url_patterns.length > 10) throw bad("At most 10 URL patterns");
      const url_patterns = t.url_patterns.map((p: any) => ({
        pattern: validatePattern(p?.pattern),
        item_type: slugify(requireText(p?.item_type, "Item type", 40)).replace(/-/g, "_"),
      }));
      const state_map = validateStateMap(t.state_map) ?? { Open: "open", Closed: "concluded" };
      return { kind: "add_tool", tool: { name, url_patterns, state_map } };
    }
    case "change_charter": {
      const charter_markdown = input.charter_markdown == null ? undefined : requireText(input.charter_markdown, "Charter", 50_000);
      const settings = validateSettings(input.settings);
      if (!charter_markdown && Object.keys(settings).length === 0) throw bad("Propose a new charter text or at least one setting");
      const p: RulesPayload = { kind: "change_charter" };
      if (charter_markdown) p.charter_markdown = charter_markdown;
      if (Object.keys(settings).length) p.settings = settings;
      return p;
    }
    case "set_tool_enabled": {
      const tool = repo.getTool(ctx.db, space.id, String(input.tool_id ?? ""));
      if (!tool) throw bad("Unknown tool");
      if (typeof input.enabled !== "boolean") throw bad("enabled must be true or false");
      if (tool.enabled === input.enabled) throw bad(`${tool.name} is already ${tool.enabled ? "enabled" : "disabled"}`);
      return { kind: "set_tool_enabled", tool_id: tool.id, enabled: input.enabled };
    }
    default:
      throw bad("Unknown proposal type");
  }
}

/** Apply an accepted Rules proposal. Runs inside the resolution transaction. */
export function applyPayload(ctx: Ctx, space: Space, q: Question) {
  const p = q.rules_payload;
  if (!p) return;
  const base = { space_id: space.id, question_id: q.id, actor: "system" };
  switch (p.kind) {
    case "add_tool":
      insertManualTool(ctx, space, p.tool, "system", q.id);
      break;
    case "change_charter": {
      const fresh = repo.getSpace(ctx.db, space.id)!;
      if (p.charter_markdown) {
        const before = fresh.charter_markdown;
        fresh.charter_markdown = p.charter_markdown;
        repo.logEvent(ctx, { ...base, action: "charter.changed", data: { before, after: p.charter_markdown } });
      }
      if (p.settings) {
        const before = { ...fresh.settings };
        fresh.settings = { ...fresh.settings, ...p.settings };
        repo.logEvent(ctx, { ...base, action: "settings.changed", data: { before, after: fresh.settings } });
      }
      repo.updateSpace(ctx.db, fresh);
      Object.assign(space, fresh);
      break;
    }
    case "set_tool_enabled": {
      repo.setToolEnabled(ctx.db, space.id, p.tool_id, p.enabled);
      repo.logEvent(ctx, { ...base, action: p.enabled ? "tool.enabled" : "tool.disabled", data: { tool_id: p.tool_id } });
      break;
    }
  }
}

type NewTool = Extract<RulesPayload, { kind: "add_tool" }>["tool"];

function insertManualTool(ctx: Ctx, space: Space, input: NewTool, actor: string, questionId?: string) {
  const existing = new Set(repo.listTools(ctx.db, space.id).map((t) => t.id));
  const root = slugify(input.name);
  let id = root;
  for (let i = 2; existing.has(id); i++) id = `${root}-${i}`;
  const tool: Tool = {
    id,
    name: input.name,
    url_patterns: input.url_patterns,
    fetch_mode: "manual",
    state_map: input.state_map,
    added_by_question_id: questionId,
    enabled: true,
  };
  repo.insertTool(ctx.db, space.id, tool);
  repo.logEvent(ctx, { space_id: space.id, question_id: questionId, actor, action: "tool.added", data: { tool } });
  return tool;
}

/** Add a manual tool directly, with no proposal or objection window. */
export function addToolDirect(ctx: Ctx, space: Space, actor: string, input: any): Tool {
  const p = validatePayload(ctx, space, { kind: "add_tool", tool: input });
  if (p.kind !== "add_tool") throw bad("Invalid tool");
  return tx(ctx.db, () => insertManualTool(ctx, space, p.tool, actor));
}

/** Enable or disable a tool directly. */
export function setToolEnabledDirect(ctx: Ctx, space: Space, actor: string, toolId: string, enabled: unknown) {
  const p = validatePayload(ctx, space, { kind: "set_tool_enabled", tool_id: toolId, enabled });
  if (p.kind !== "set_tool_enabled") throw bad("Invalid request");
  tx(ctx.db, () => {
    repo.setToolEnabled(ctx.db, space.id, p.tool_id, p.enabled);
    repo.logEvent(ctx, { space_id: space.id, actor, action: p.enabled ? "tool.enabled" : "tool.disabled", data: { tool_id: p.tool_id } });
  });
}
