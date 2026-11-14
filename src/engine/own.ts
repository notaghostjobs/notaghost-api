// A résumé that is one of our own delivered documents. Uploading the document we wrote for a posting and asking for the same
// posting again is not a new fit: the answer is the document's delivered number, and nothing is scored or sold a second time.
import { db } from "../lib/db.js";

const norm = (s: string) => (s ?? "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
const linesOf = (p: any): string[] => ((p?.roles ?? []) as any[]).flatMap((r) => (r?.bullets ?? []) as string[]).map(norm).filter((l) => l.length > 12);
const shingles = (t: string, n = 5) => { const w = norm(t).split(" ").filter(Boolean); const out: string[] = []; for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(" ")); return out; };

/** True when the profile read from an upload is the document `rewrite`. Three things must hold, and they are written for
 *  how a re-read really comes back (13 Nov: our profile block was filed as bullets under a role, and a wrapped line lost
 *  its last word):
 *   1. every line we delivered is in the upload — whole, or cut short at a line wrap;
 *   2. the profile WE wrote (summary and its block) is in the upload, phrase for phrase, wherever the reader filed it —
 *      this is what their original résumé never has;
 *   3. the upload has next to nothing else: its lines are ours, or pieces of our profile. */
export function isOwnDocument(profile: any, rewrite: any): boolean {
  const up = linesOf(profile), ours = linesOf(rewrite);
  if (up.length < 4 || ours.length < 4) return false;
  const upSet = new Set(up);
  const cut = (o: string) => up.some((u) => u.length >= 25 && o.startsWith(u));
  const delivered = ours.filter((o) => upSet.has(o) || cut(o)).length / ours.length;
  if (delivered < 0.9) return false;
  const whole = " " + [profile?.headline, profile?.summary, JSON.stringify(profile?.extra_sections ?? []), ...up].map((x) => norm(String(x ?? ""))).join(" | ") + " ";
  const mine = [String(rewrite?.summary ?? ""), ...((rewrite?.relevant ?? []) as string[])].join(" . ");
  const sh = shingles(mine);
  if (sh.length >= 6 && sh.filter((x) => whole.includes(x)).length / sh.length < 0.6) return false;
  const ourSet = new Set(ours); const mineN = " " + norm(mine) + " ";
  const explained = up.filter((u) => ourSet.has(u) || ours.some((o) => u.length >= 25 && o.startsWith(u)) || (() => { const s = shingles(u, 4); return s.length > 0 && s.filter((x) => mineN.includes(x)).length / s.length >= 0.6; })()).length / up.length;
  return explained >= 0.85;
}
const same = (a?: string, b?: string) => !!norm(a ?? "") && norm(a ?? "") === norm(b ?? "");

/** The delivered Sharpen this upload is, when it was written for this same posting. */
export async function ownDocumentFor(userId: string, profile: any, postingId: string | null, posting: { company?: string; title?: string }): Promise<{ id: string; at: string; before: number; after: number } | null> {
  const { data } = await db.from("shots").select("id, done_at, posting_id, output").eq("user_id", userId).eq("status", "done").order("done_at", { ascending: false }).limit(25);
  for (const s of data ?? []) {
    const o = s.output as any;
    if (!o?.rewrite || !o?.pdf_path) continue;
    const here = (postingId && s.posting_id === postingId) || (same(o.posting?.company, posting.company) && same(o.posting?.title, posting.title));
    if (!here || !isOwnDocument(profile, o.rewrite)) continue;
    return { id: s.id, at: s.done_at, before: o.before, after: Math.min(97, o.after) };
  }
  return null;
}
