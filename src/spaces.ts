// Spaces: creation and link rotation (operator actions, spec §6).
import { readFileSync } from "node:fs";
import type { Ctx } from "./ctx.ts";
import type { Role, Space } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import * as repo from "./repo.ts";
import { tx } from "./db.ts";
import { generateToken, hashToken } from "./tokens.ts";
import { SEED_TOOLS } from "./tools.ts";
import { newId, requireText } from "./util.ts";

export const DEFAULT_CHARTER = readFileSync(new URL("../seed/charter.md", import.meta.url), "utf8");

export function createSpace(ctx: Ctx, nameIn: string) {
  const name = requireText(nameIn, "Space name", 120);
  const space: Space = {
    id: newId(),
    name,
    created_at: ctx.now().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    charter_markdown: DEFAULT_CHARTER,
  };
  const editToken = generateToken();
  const viewToken = generateToken();
  tx(ctx.db, () => {
    repo.insertSpace(ctx.db, space, hashToken(editToken), hashToken(viewToken));
    for (const t of SEED_TOOLS) repo.insertTool(ctx.db, space.id, structuredClone(t));
    repo.logEvent(ctx, { space_id: space.id, actor: "operator", action: "space.created", data: { name } });
  });
  return { space, editToken, viewToken };
}

export function rotateLink(ctx: Ctx, spaceId: string, which: Role) {
  const space = repo.getSpace(ctx.db, spaceId);
  if (!space) throw new Error(`No space with id ${spaceId}`);
  const token = generateToken();
  tx(ctx.db, () => {
    repo.setSpaceTokenHash(ctx.db, spaceId, which, hashToken(token));
    repo.logEvent(ctx, { space_id: spaceId, actor: "operator", action: "link.rotated", data: { which } });
  });
  return token;
}

export const spaceLink = (ctx: Ctx, token: string) => `${ctx.config.publicUrl}/s/${token}`;
