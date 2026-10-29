import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit random token, URL-safe. */
export const generateToken = () => randomBytes(32).toString("base64url");

/**
 * Tokens are high-entropy random values, so a fast hash (SHA-256) is sufficient:
 * there is nothing to brute-force that a slow KDF would protect.
 */
export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const looksLikeToken = (s: string) => /^[A-Za-z0-9_-]{40,64}$/.test(s);
