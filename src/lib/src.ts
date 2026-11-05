import type { Context } from "hono";
import { db } from "./db.js";

/**
 * Where a person came from, carried with the person rather than the link.
 *
 * A tag arrives on a link (?src=tg-internfreak, or a /go/<tag> short link), the page stores the first one it ever saw and
 * the latest one, and sends both on every call. The API writes them down at every stage — click, check, sign-in, preview,
 * shot, order, paid — so the funnel can be read per channel from the first click to the rupee.
 *
 * first = the channel that brought the person; last = the channel of this visit. Payments are attributed to first.
 */
export type Src = { first: string | null; last: string | null };

const TAG = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
export const cleanTag = (s: string | null | undefined) => { const t = (s ?? "").trim().toLowerCase(); return TAG.test(t) ? t : null; };

export function srcOf(c: Context): Src {
  return { first: cleanTag(c.req.header("x-ghosted-src-first") ?? c.req.query("src")), last: cleanTag(c.req.header("x-ghosted-src-last") ?? c.req.query("src")) };
}

export type EventKind = "click" | "check" | "signin" | "preview" | "shot" | "order" | "paid" | "wa_in";

let eventsMissing = false;   // before migration 0010 the table does not exist; say so once, never fail a request over it
export async function logEvent(kind: EventKind, e: { src?: Src | null; anon?: string | null; userId?: string | null; meta?: Record<string, unknown> }) {
  if (eventsMissing) return;
  const { error } = await db.from("events").insert({ kind, src_first: e.src?.first ?? null, src_last: e.src?.last ?? null, anon: e.anon ?? null, user_id: e.userId ?? null, meta: e.meta ?? null });
  if (error) { if (/relation .*events.* does not exist/i.test(error.message)) { eventsMissing = true; console.error("[events] table missing — run migration 0010"); } else console.error("[events]", error.message); }
}

/** Stamp a user: the first source sticks for good; the last source follows them. */
export async function stampUser(userId: string, src: Src | null | undefined) {
  if (!src || (!src.first && !src.last)) return;
  const { data } = await db.from("users").select("src_first").eq("id", userId).maybeSingle();
  const patch: Record<string, unknown> = {};
  if (src.last) patch.src_last = src.last;
  if (!data?.src_first && (src.first || src.last)) { patch.src_first = src.first ?? src.last; patch.src_first_at = new Date().toISOString(); }
  if (Object.keys(patch).length) { const { error } = await db.from("users").update(patch).eq("id", userId); if (error && !/column/i.test(error.message)) console.error("[src] stamp", error.message); }
}

/** The sources on a user row, for stages where the request carries none (WhatsApp, webhooks). */
export async function srcOfUser(userId: string): Promise<Src> {
  const { data } = await db.from("users").select("src_first, src_last").eq("id", userId).maybeSingle();
  return { first: (data as any)?.src_first ?? null, last: (data as any)?.src_last ?? null };
}

/** A WhatsApp message can carry its channel in a trailing bracket: "Is this job real? (IF)". Returns the tag and the text without it. */
export function untagMessage(text: string): { text: string; tag: string | null } {
  // invisible tag: zero-width bits framed by word joiners (U+2060), appended by /<channel> links so the prefilled message reads clean
  const z = text.match(/\u2060([\u200b\u200c]+)\u2060/);
  if (z) {
    const bits = z[1].replace(/\u200b/g, "0").replace(/\u200c/g, "1");
    let code = ""; for (let i = 0; i + 8 <= bits.length; i += 8) code += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
    const clean = text.replace(z[0], "").replace(/[\u200b\u200c\u2060]/g, "").trim();
    if (/^[a-z0-9_-]{1,12}$/i.test(code)) return { text: clean, tag: `wa-${code.toLowerCase()}` };
    return { text: clean, tag: null };
  }
  const m = text.match(/\(([a-z0-9_-]{1,12})\)\s*$/i);
  if (!m) return { text, tag: null };
  return { text: text.slice(0, m.index).trim(), tag: `wa-${m[1].toLowerCase()}` };
}
