// Display names are not verified (see the charter); they are only used to attribute actions.

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
