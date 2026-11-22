import { Hono } from "hono";
import { db } from "../lib/db.js";
import { bandOf } from "../lib/igband.js";

/** The roles from our Instagram reels, for the page behind the link in the bio. The list is one row in reader_control
 *  (ig:roles → { roles: [{ slug, id, company, role, at }] }), newest first, so a reel adds a role without a deploy.
 *  A role the employer has closed drops off by itself: only sightings still open are returned. */
export const ig = new Hono();
type Entry = { slug: string; id: number; company?: string; role?: string; who?: string; at?: string; band?: string };
ig.get("/roles", async (c) => {
  const { data: row } = await db.from("reader_control").select("value").eq("key", "ig:roles").maybeSingle();
  const list: Entry[] = Array.isArray((row?.value as any)?.roles) ? (row!.value as any).roles : [];
  const ids = list.map((e) => Number(e.id)).filter((n) => Number.isFinite(n)).slice(0, 60);
  if (!ids.length) return c.json({ roles: [] });
  const { data: rows } = await db.from("sightings").select("id, company_name, title, url, last_seen, gone_at").in("id", ids);
  const by = new Map((rows ?? []).map((r: any) => [Number(r.id), r]));
  const roles = list.flatMap((e) => {
    const s: any = by.get(Number(e.id));
    if (!s || s.gone_at || !s.url) return [];
    return [{ slug: String(e.slug), company: e.company || s.company_name, role: e.role || s.title, who: e.who ?? null, band: bandOf(e, s.title ?? ""), url: s.url as string, checked_at: s.last_seen as string, added_at: e.at ?? null }];
  });
  c.header("cache-control", "public, max-age=120");
  return c.json({ roles });
});
