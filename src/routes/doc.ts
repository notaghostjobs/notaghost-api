import { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";
import { db } from "../lib/db.js";

/** Short-lived, signed links to a delivered PDF on our own domain (api.notaghost.jobs/d/…), so a phone's address bar
 *  shows notaghost, not a storage bucket. The key lives only in this process; a restart retires old links, which is fine:
 *  links last an hour and WhatsApp fetches the file the moment it is sent. */
// derived from a secret that already lives in the environment, so links survive a restart
const KEY = createHash("sha256").update("ghosted-doc-links:" + (process.env.DOC_LINK_SECRET || env.anthropicKey || "dev")).digest();
const BASE = "https://api.notaghost.jobs";
const sig = (id: string, exp: number) => createHmac("sha256", KEY).update(`${id}.${exp}`).digest("base64url").slice(0, 32);

/** The token the WhatsApp "Open document" button carries: id.exp.sig (the template's URL suffix). Thirty days. */
export function docToken(shotId: string, ttlSec = 30 * 86400) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${shotId}.${exp}.${sig(shotId, exp)}`;
}
/** Signed token for a receipt (WhatsApp "View receipt" button): id.exp.sig, namespaced so a doc token can't open a receipt. */
export function receiptToken(paymentId: string, ttlSec = 365 * 86400) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${paymentId}.${exp}.${sig("r:" + paymentId, exp)}`;
}
export function readReceiptToken(tok: string): string | null {
  const [id, e, s] = tok.split("."); const exp = Number(e);
  if (!id || !exp || !s || exp < Date.now() / 1000) return null;
  const want = sig("r:" + id, exp);
  return s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)) ? id : null;
}
export function docLink(shotId: string, ttlSec = 3600, filename?: string) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  // the last path segment is what a phone saves the file as
  return `${BASE}/d/${shotId}${filename ? "/" + encodeURIComponent(filename) : ""}?e=${exp}&s=${sig(shotId, exp)}`;
}

export const doc = new Hono();
doc.get("/:id/:file?", async (c) => {
  const id = c.req.param("id"), exp = Number(c.req.query("e") ?? 0), s = c.req.query("s") ?? "";
  const want = sig(id, exp);
  if (!exp || exp < Date.now() / 1000 || s.length !== want.length || !timingSafeEqual(Buffer.from(s), Buffer.from(want))) return c.text("This link has expired. Open the document again from Ghosted.", 410);
  const { data } = await db.from("shots").select("output").eq("id", id).maybeSingle();
  const out = data?.output as { pdf_path?: string; posting?: { company?: string; title?: string } } | null;
  if (!out?.pdf_path) return c.text("Not ready.", 404);
  const f = await db.storage.from("outputs").download(out.pdf_path);
  if (f.error) return c.text("Could not open the document.", 500);
  const asked = (c.req.param("file") ?? "").replace(/[^A-Za-z0-9._-]+/g, "-");
  const name = /\.pdf$/i.test(asked) ? asked : `Resume-${String(out.posting?.company ?? "sharpened").replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
  return new Response(f.data, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}"`, "cache-control": "private, max-age=600" } });
});
