// The US job-search service (a pilot, kept apart): the public page's live count, and the "send me a sample" form.
// The count is the roles we already hold for employers we check that also hire in the United States. People who ask for a
// sample are kept in reader_control (us:lead:<id>) until the pilot earns a table of its own.
import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { db } from "../lib/db.js";

export const us = new Hono();

// what marks a location as in the United States: the country by name, a state code after a comma, or a large US city
const US_OR = [
  "location.ilike.*united states*", "location.ilike.*, USA*", "location.ilike.*(US)*", "location.ilike.*remote - us*", "location.ilike.*remote, us*",
  ...["CA", "NY", "TX", "WA", "MA", "IL", "CO", "GA", "NC", "VA", "FL", "NJ", "PA", "OH", "AZ", "OR", "UT", "MN", "MI", "DC"].map((s) => `location.like.*, ${s}*`),
  ...["san francisco", "new york", "seattle", "austin", "boston", "chicago"].map((c) => `location.ilike.*${c}*`),
].join(",");

let cache: { at: number; roles: number; employers: number } | null = null;
us.get("/stats", async (c) => {
  if (!cache || Date.now() - cache.at > 30 * 60e3) {
    const since = new Date(Date.now() - 48 * 3600e3).toISOString();
    const keys = new Set<string>(); let roles = 0;
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await db.from("sightings").select("employer_key").is("gone_at", null).eq("blr", false).gt("last_seen", since).or(US_OR).range(from, from + 999);
      if (error || !data?.length) break;
      roles += data.length; for (const r of data as any[]) if (r.employer_key) keys.add(r.employer_key);
      if (data.length < 1000) break;
    }
    if (roles > 0 || !cache) cache = { at: Date.now(), roles, employers: keys.size };
  }
  c.header("cache-control", "public, max-age=600");
  return c.json({ roles: cache!.roles, employers: cache!.employers, window_hours: 48 });
});

us.post("/sample", async (c) => {
  const b = z.object({ email: z.string().trim().email().max(160), role: z.string().trim().min(2).max(90), years: z.string().trim().max(20).optional(),
    where: z.string().trim().max(90).optional(), visa: z.enum(["citizen_or_gc", "opt", "h1b", "other"]).optional(), link: z.string().trim().max(300).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Give your email and the role you want." }, 400);
  const day = `us:day:${new Date().toISOString().slice(0, 10)}`;
  const { data: d } = await db.from("reader_control").select("value").eq("key", day).maybeSingle();
  const n = Number((d?.value as any)?.n ?? 0);
  if (n >= 300) return c.json({ error: "We’ve taken as many requests as we can check properly today. Try again tomorrow." }, 429);
  await db.from("reader_control").upsert({ key: day, value: { n: n + 1 } });
  const id = randomBytes(6).toString("hex");
  await db.from("reader_control").upsert({ key: `us:lead:${id}`, value: { id, at: new Date().toISOString(), ...b.data, status: "new" } });
  return c.json({ ok: true });
});
