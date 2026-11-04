import { Hono } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../lib/db.js";

/** Short-lived, signed links to a delivered PDF on our own domain (api.notaghost.jobs/d/…), so a phone's address bar
 *  shows notaghost, not a storage bucket. The key lives only in this process; a restart retires old links, which is fine:
 *  links last an hour and WhatsApp fetches the file the moment it is sent. */
const KEY = randomBytes(32);
const BASE = "https://api.notaghost.jobs";
const sig = (id: string, exp: number) => createHmac("sha256", KEY).update(`${id}.${exp}`).digest("base64url").slice(0, 32);

export function docLink(shotId: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${BASE}/d/${shotId}?e=${exp}&s=${sig(shotId, exp)}`;
}

export const doc = new Hono();
doc.get("/:id", async (c) => {
  const id = c.req.param("id"), exp = Number(c.req.query("e") ?? 0), s = c.req.query("s") ?? "";
  const want = sig(id, exp);
  if (!exp || exp < Date.now() / 1000 || s.length !== want.length || !timingSafeEqual(Buffer.from(s), Buffer.from(want))) return c.text("This link has expired. Open the document again from Ghosted.", 410);
  const { data } = await db.from("shots").select("output").eq("id", id).maybeSingle();
  const out = data?.output as { pdf_path?: string; posting?: { company?: string; title?: string } } | null;
  if (!out?.pdf_path) return c.text("Not ready.", 404);
  const f = await db.storage.from("outputs").download(out.pdf_path);
  if (f.error) return c.text("Could not open the document.", 500);
  const name = `Resume-${String(out.posting?.company ?? "sharpened").replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
  return new Response(f.data, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}"`, "cache-control": "private, max-age=600" } });
});
