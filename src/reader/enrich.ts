// Enrich: open each live Bengaluru job once. Description, a real posting date when the list did not give one,
// salary/experience when the page states them, and a fingerprint for the repost signal.
import { db } from "../lib/db.js";
import { getText } from "./http.js";
import { htmlToText } from "../engine/extract.js";
import { fingerprint } from "../engine/ghost/canon.js";

const iso = (v: unknown): string | null => { if (!v) return null; const d = new Date(String(v)); return isNaN(d.getTime()) ? null : d.toISOString(); };

/** JSON-LD JobPosting on the page, when present — the most reliable source of date and salary. */
function jsonLd(html: string): { datePosted?: string; salary?: string; description?: string; validThrough?: string } | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      for (const x of [j, ...(j?.["@graph"] ?? []), ...(Array.isArray(j) ? j : [])].flat(2)) if (x?.["@type"] === "JobPosting") {
        const bs = x.baseSalary?.value; const salary = bs ? [bs.minValue ?? bs.value, bs.maxValue].filter(Boolean).join("–") + (bs.unitText ? ` per ${bs.unitText.toLowerCase()}` : "") + (x.baseSalary?.currency ? ` ${x.baseSalary.currency}` : "") : undefined;
        return { datePosted: x.datePosted, validThrough: x.validThrough, salary, description: typeof x.description === "string" ? htmlToText(x.description) : undefined };
      }
    } catch { /* next */ }
  }
  return null;
}

/** Salary / experience phrases in plain text, when the page states them. */
function pick(text: string) {
  const salary = text.match(/(?:₹|INR|Rs\.?)\s?[\d,.]+\s?(?:L|LPA|lakh|lakhs|Lac|k|K|CR|crore)?(?:\s?(?:-|–|to)\s?(?:₹|INR|Rs\.?)?\s?[\d,.]+\s?(?:L|LPA|lakh|lakhs|Lac|k|K)?)?(?:\s?(?:per|\/)\s?(?:annum|year|month|yr|p\.?a\.?))?/i)?.[0] ?? null;
  const exp = text.match(/\b(\d{1,2})\s?(?:\+|-|–|to)\s?(\d{1,2})?\s?(?:\+)?\s?years?\b/i)?.[0] ?? null;
  return { salary, exp };
}

export async function enrichOne(s: { id: number; url: string; posted_at: string | null; salary_text: string | null; raw: any }) {
  const r = await getText(s.url, { timeoutMs: 20000, gapMs: 800 });
  if (!r.ok) { await db.from("sightings").update({ enriched_at: new Date().toISOString(), enrich_error: `HTTP ${r.status}` }).eq("id", s.id); return false; }
  const ld = jsonLd(r.text);
  const text = (ld?.description && ld.description.length > 300 ? ld.description : htmlToText(r.text)).slice(0, 20000);
  if (text.length < 200) { await db.from("sightings").update({ enriched_at: new Date().toISOString(), enrich_error: "page has no readable text (likely rendered by script)" }).eq("id", s.id); return false; }
  const p = pick(text);
  const upd: Record<string, unknown> = { description: text, fingerprint: fingerprint(text), enriched_at: new Date().toISOString(), enrich_error: null };
  if (!s.posted_at && ld?.datePosted) upd.posted_at = iso(ld.datePosted);
  if (!s.salary_text && (ld?.salary || p.salary)) upd.salary_text = ld?.salary ?? p.salary;
  upd.raw = { ...(s.raw ?? {}), ...(p.exp ? { exp: s.raw?.exp ?? p.exp } : {}), ...(ld?.validThrough ? { valid_through: ld.validThrough } : {}) };
  const { error } = await db.from("sightings").update(upd).eq("id", s.id);
  if (error) throw new Error(error.message);
  return true;
}

/** Enrich a batch of live Bengaluru sightings that have not been opened yet. Gentle: 3 at a time, per-host spacing from http(). */
export async function enrichDue(limit = 300, concurrency = 6) {
  const { data } = await db.from("sightings").select("id, url, posted_at, salary_text, raw, employer_key").eq("blr", true).is("gone_at", null).is("enriched_at", null).not("url", "is", null).order("first_seen", { ascending: false }).limit(limit);
  // spread the batch across employers: the per-host pacing in http() then runs in parallel instead of serialising one big employer
  type Row = NonNullable<typeof data>[number];
  const byHost = new Map<string, Row[]>(); for (const s of data ?? []) { const k = s.employer_key ?? "?"; if (!byHost.has(k)) byHost.set(k, []); byHost.get(k)!.push(s); }
  const q: Row[] = []; const lists = [...byHost.values()]; for (let i = 0; q.length < (data ?? []).length; i++) for (const l of lists) if (l[i]) q.push(l[i]);
  const stats = { tried: 0, ok: 0, failed: 0 };
  async function worker() {
    for (;;) {
      const s = q.shift(); if (!s) return;
      stats.tried++;
      try { (await enrichOne(s)) ? stats.ok++ : stats.failed++; }
      catch (e) { stats.failed++; await db.from("sightings").update({ enriched_at: new Date().toISOString(), enrich_error: (e as Error).message.slice(0, 200) }).eq("id", s.id); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}
