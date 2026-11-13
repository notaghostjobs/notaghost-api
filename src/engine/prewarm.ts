import { createHash } from "node:crypto";
import type { Rewrite, Match } from "./sharpen.js";

/** The first draft is the slow step (~40 s). It depends only on the résumé, the posting and the answers, all fixed by the
 *  time someone opens checkout — so it is started then, while Razorpay is open, and the shot picks it up if nothing changed. */
const drafts = new Map<string, { at: number; p: Promise<Rewrite> }>();
const TTL = 20 * 60e3;
/** A draft is good only for the exact parse and answers it was written from: the key carries both. */
export const draftKey = (previewId: string, matches: Match[], profile?: unknown) => previewId + ":" + createHash("sha256").update(JSON.stringify(matches)).digest("hex").slice(0, 16) + (profile ? ":" + createHash("sha256").update(JSON.stringify((profile as any).roles ?? profile)).digest("hex").slice(0, 12) : "");
export function prewarm(key: string, make: () => Promise<Rewrite>) {
  const now = Date.now();
  for (const [k, v] of drafts) if (now - v.at > TTL) drafts.delete(k);
  if (drafts.has(key)) return false;
  const p = make();
  p.catch(() => drafts.delete(key));
  drafts.set(key, { at: now, p });
  return true;
}
export function takeDraft(key: string): Promise<Rewrite> | null {
  const d = drafts.get(key);
  if (!d || Date.now() - d.at > TTL) return null;
  drafts.delete(key);
  return d.p;
}
