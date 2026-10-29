// Soft permission checks based on (unverified) display names. See charter: names are not verified.
import type { Question } from "./types.ts";

export const sameName = (a?: string, b?: string) =>
  !!a && !!b && a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** The steward, or anyone if there is no steward. */
export const canActAsSteward = (q: Question, actor: string) => !q.steward || sameName(q.steward, actor);

export function validateActorName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name.length > 60) return undefined;
  if (name.toLowerCase() === "system" || name.toLowerCase() === "operator") return undefined; // reserved
  return name;
}
