// F4 (ICS calendar) and F11 (web app manifest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeCtx, makeSpace } from "./helpers.ts";
import { route } from "../src/http/server.ts";
import { fold, icsText } from "../src/calendar.ts";
import * as Q from "../src/questions.ts";

const get = (ctx: any, url: string) => route(ctx, { method: "GET", url, headers: { host: "register.test" } });

test("ICS: one event per matter spanning start to end, all-day for days, UTC for moments, view link only, removed left out", async () => {
  const t = makeCtx();
  const { space, editToken, viewToken } = makeSpace(t.ctx);
  const a = await Q.create(t.ctx, space, "Ana", { title: "Budget, 2026; final", fields: { start: "2026-03-01", end: "2026-03-15" } });
  await Q.create(t.ctx, space, "Ana", { title: "Vote opens", fields: { start: "2026-04-02T18:30:00Z" } });
  await Q.create(t.ctx, space, "Ana", { title: "No dates" });
  const gone = await Q.create(t.ctx, space, "Ana", { title: "Removed one", fields: { start: "2026-05-01" } });
  Q.remove(t.ctx, space, gone, "Ana", {});

  assert.equal((await get(t.ctx, `/feed/${editToken}.ics`)).status, 404, "not with the edit link");
  const res = await get(t.ctx, `/feed/${viewToken}.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /^text\/calendar/);
  const ics = res.body.toString();
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.ok(!/[^\r]\n/.test(ics), "CRLF line endings");
  const unfolded = ics.replace(/\r\n /g, "");
  assert.equal(unfolded.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.match(unfolded, /SUMMARY:Budget\\, 2026\\; final/);
  assert.match(unfolded, new RegExp(`UID:${a.id}@test\\r\\nDTSTAMP:\\d{8}T\\d{6}Z\\r\\nLAST-MODIFIED:\\d{8}T\\d{6}Z\\r\\nDTSTART;VALUE=DATE:20260301\\r\\nDTEND;VALUE=DATE:20260316`));
  assert.match(unfolded, /DTSTART:20260402T183000Z\r\nDTEND:\d{8}T\d{6}Z\r\nSUMMARY:Vote opens|DTSTART:20260402T183000Z\r\nSUMMARY:Vote opens/, "start only: runs to now, or a point if still in the future");
  assert.match(unfolded, new RegExp(`URL:http://test/s/${viewToken}#/q/${a.id}`));
  assert.ok(!unfolded.includes("Removed one") && !unfolded.includes("No dates"));
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "folded at 75 octets");
});

test("ICS text escaping and folding keep UTF-8 characters whole", () => {
  assert.equal(icsText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  const line = "SUMMARY:" + "é".repeat(60);
  const folded = fold(line);
  assert.ok(folded.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(folded.replace(/\r\n /g, ""), line);
});

test("web app manifest: served, no start_url or id (default to the space page), icons exist", async () => {
  const t = makeCtx();
  const { editToken } = makeSpace(t.ctx);
  const res = await get(t.ctx, "/assets/manifest.webmanifest");
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/manifest+json");
  const m = JSON.parse(res.body.toString());
  assert.equal(m.start_url, undefined);
  assert.equal(m.id, undefined);
  assert.equal(m.display, "standalone");
  for (const icon of m.icons) assert.equal((await get(t.ctx, icon.src)).status, 200, icon.src);
  assert.ok(m.icons.some((i: any) => i.sizes === "192x192") && m.icons.some((i: any) => i.sizes === "512x512"));
  const shell = (await get(t.ctx, `/s/${editToken}`)).body.toString();
  assert.match(shell, /<link rel="manifest" href="\/assets\/manifest.webmanifest">/);
  assert.match(shell, /<link rel="apple-touch-icon" href="\/assets\/apple-touch-icon.png">/);
  assert.equal(m.scope, "/s/", "every space page, no token");
  assert.ok(!/\/s\/[A-Za-z0-9_-]{20,}/.test(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8")));
});
