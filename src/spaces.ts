// Spaces: creation and link rotation (operator actions, spec §6).
import type { Ctx } from "./ctx.ts";
import type { Role, Space } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { generateToken, hashToken } from "./tokens.ts";
import { SEED_TOOLS } from "./tools.ts";
import { bad, isHttpsUrl, newId, requireText } from "./util.ts";

const MAX_ABOUT = 5000;

export function createSpace(ctx: Ctx, nameIn: string) {
  const name = requireText(nameIn, "Space name", 120);
  const space: Space = {
    id: newId(),
    name,
    created_at: ctx.now().toISOString(),
    settings: structuredClone(DEFAULT_SETTINGS),
    charter_markdown: "", // the group's own "About this group" text; the app's help is in the UI
  };
  const editToken = generateToken();
  const viewToken = generateToken();
  tx(ctx.db, () => {
    repo.insertSpace(ctx.db, space, hashToken(editToken), viewToken);
    for (const t of SEED_TOOLS) repo.insertTool(ctx.db, space.id, structuredClone(t));
    repo.logEvent(ctx, { space_id: space.id, actor: "operator", action: "space.created", data: { name } });
  });
  return { space, editToken, viewToken };
}

export function rotateLink(ctx: Ctx, spaceId: string, which: Role, actor = "operator") {
  const space = repo.getSpace(ctx.db, spaceId);
  if (!space) throw new Error(`No space with id ${spaceId}`);
  const token = generateToken();
  tx(ctx.db, () => {
    repo.setSpaceToken(ctx.db, spaceId, which, token);
    repo.logEvent(ctx, { space_id: spaceId, actor, action: "link.rotated", data: { which } });
  });
  return token;
}

export const spaceLink = (ctx: Ctx, token: string) => `${ctx.config.publicUrl}/s/${token}`;

/**
 * Replace the space's "About this group" text (stored as `charter_markdown`). Markdown; empty clears it.
 * Logged with the new length and the text it replaced, so nothing is lost. Unchanged text isn't logged.
 */
export function setCharter(ctx: Ctx, spaceId: string, markdown: unknown, actor = "operator", website?: unknown) {
  const space = repo.getSpace(ctx.db, spaceId);
  if (!space) throw new Error(`No space with id ${spaceId}`);
  if (typeof markdown !== "string") throw bad("The text must be a string");
  const text = markdown.replace(/\r\n?/g, "\n").trim();
  if (text.length > MAX_ABOUT) throw bad(`The text is too long (${MAX_ABOUT} characters at most)`);
  // `website`: undefined leaves it alone; "" clears it; otherwise it must be an https:// URL.
  let site: string | undefined;
  if (website !== undefined) {
    if (typeof website !== "string") throw bad("The website must be a string");
    site = website.trim();
    if (site && !isHttpsUrl(site)) throw bad("The website must be an https:// URL");
  }
  const previous = space.charter_markdown.trim();
  const previousSite = space.settings.website ?? "";
  const siteChanged = site !== undefined && site !== previousSite;
  if (text === previous && !siteChanged) return space;
  space.charter_markdown = text ? text + "\n" : "";
  if (siteChanged) {
    if (site) space.settings.website = site;
    else delete space.settings.website;
  }
  tx(ctx.db, () => {
    repo.updateSpace(ctx.db, space);
    repo.logEvent(ctx, { space_id: spaceId, actor, action: "charter.changed", data: { length: text.length, ...(previous && text !== previous ? { previous } : {}), ...(siteChanged ? { website: site, ...(previousSite ? { previous_website: previousSite } : {}) } : {}) } });
  });
  return space;
}
