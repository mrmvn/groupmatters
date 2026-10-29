import { randomBytes } from "node:crypto";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bad = (message: string, code = "invalid") => new HttpError(400, code, message);
export const forbidden = (message: string) => new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

/** Short random id, URL-safe (96 bits). Not a secret. */
export const newId = () => randomBytes(12).toString("base64url");

export const DAY_MS = 24 * 60 * 60 * 1000;

export function trimOrUndef(v: unknown, max = 10_000): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad("Expected a string");
  const t = v.trim();
  if (t.length > max) throw bad(`Text too long (max ${max} characters)`);
  return t === "" ? undefined : t;
}

export function requireText(v: unknown, field: string, max = 10_000): string {
  const t = trimOrUndef(v, max);
  if (!t) throw bad(`${field} is required`);
  return t;
}

export function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "tool"
  );
}
