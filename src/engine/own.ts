// A résumé that is one of our own delivered documents. Uploading the document we wrote for a posting and asking for the same
// posting again is not a new fit: the answer is the document's delivered number, and nothing is scored or sold a second time.
import { db } from "../lib/db.js";

const norm = (s: string) => (s ?? "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]+/g, " ").trim();
const toks = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 2));
const linesOf = (p: any): string[] => ((p?.roles ?? []) as any[]).flatMap((r) => (r?.bullets ?? []) as string[]).map(norm).filter((l) => l.length > 12);
/** share of a's lines that are in b */
const share = (a: string[], b: string[]) => { if (!a.length) return 0; const set = new Set(b); return a.filter((l) => set.has(l)).length / a.length; };
const contained = (a: string, b: string) => { const A = [...toks(a)], B = toks(b); return A.length ? A.filter((w) => B.has(w)).length / A.length : 0; };

/** true when the profile read from an upload is the document `rewrite` (same lines both ways, same summary) */
export function isOwnDocument(profile: any, rewrite: any): boolean {
  const up = linesOf(profile), ours = linesOf(rewrite);
  if (up.length < 4 || ours.length < 4) return false;
  if (share(up, ours) < 0.9 || share(ours, up) < 0.9) return false;
  const sum = String(rewrite?.summary ?? "");
  if (sum.trim().length < 30) return true;
  // our summary must be in the upload — in its summary, or wherever the reader filed it
  const hay = [profile?.summary, profile?.headline, JSON.stringify(profile?.extra_sections ?? [])].filter(Boolean).join(" ");
  return contained(sum, hay) >= 0.75;
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
