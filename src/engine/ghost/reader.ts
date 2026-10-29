// Layer B from the reader: what the employer's OWN hiring system says, read from `employers` + `sightings`. Free.
// This is the strongest evidence the check has: a role that is not on the company's own system is listed on boards only.
import { db } from "../../lib/db.js";
import { matchTitle, type AtsJob } from "./ats.js";
import { strip } from "./canon.js";
import type { PostingFacts } from "./types.js";

export interface ReaderFacts {
  known: boolean;                          // employer row exists
  system: string | null;                   // employers.ats: greenhouse | workday | ... | none | null (unresolved)
  ats: PostingFacts["ats"] | null;         // filled when the system is readable
  openings: number | null;                 // all locations, as the employer's system lists them today
  blr_openings: number | null;
  live: number;                            // live sightings we hold for this employer
  by_url: boolean;                         // the pasted link itself is one of our sightings
  evidence: string;                        // one line for the verdict copy
}

/** Look the employer up in the reader; match the title against its live sightings. Unknown employers are queued for the resolver. */
export async function readerFacts(ckey: string, company: string, title: string, url: string | null): Promise<ReaderFacts> {
  const cols = "key, name, ats, ats_ref, careers_url, openings, blr_openings, resolved_at";
  let { data: e } = await db.from("employers").select(cols).eq("key", ckey).maybeSingle();
  // "Amazon" may be held as "Amazon India" / "Amazon Development Center India" / …: when the exact key has no readable
  // system, take the best-resolved row whose key starts with the name (most Bengaluru openings wins)
  if (ckey.length >= 4 && (!e || !e.ats || e.ats === "none")) {
    const { data: alts } = await db.from("employers").select(cols).like("key", `${ckey} %`).not("ats", "is", null).neq("ats", "none").order("blr_openings", { ascending: false, nullsFirst: false }).limit(1);
    if (alts?.[0]) e = alts[0];
  }
  if (!e) {
    // first time anyone pasted this company: the worker resolves it (priority 1, within the research budget); next check is free
    await db.from("employers").upsert({ key: ckey, name: company, source: "check", priority: 1 }, { onConflict: "key", ignoreDuplicates: true });
    return { known: false, system: null, ats: null, openings: null, blr_openings: null, live: 0, by_url: false, evidence: "company not in the reader yet; queued" };
  }
  if (!e.resolved_at || !e.ats) return { known: true, system: null, ats: null, openings: null, blr_openings: null, live: 0, by_url: false, evidence: "company queued for the reader; system not identified yet" };
  if (e.ats === "none") return { known: true, system: "none", ats: null, openings: null, blr_openings: null, live: 0, by_url: false, evidence: "company publishes no readable hiring list" };
  // a guessed feed that has never produced a sighting is not a read employer: saying "not on their careers page" against it
  // would accuse a posting on the strength of nothing. Treat it as unresolved until the reader actually sees roles there.
  if ((e.openings ?? 0) === 0 && (e.blr_openings ?? 0) === 0) {
    const { count } = await db.from("sightings").select("*", { count: "exact", head: true }).eq("source", e.ats).like("source_id", `${e.ats_ref}:%`);
    if (!count) return { known: true, system: null, ats: null, openings: null, blr_openings: null, live: 0, by_url: false, evidence: `company's hiring system guessed (${e.ats}) but nothing read from it yet` };
  }

  // the feed is the identity, not the employer row: several rows can share one hiring-system feed
  // Big feeds (Amazon ≈ 8k live rows) outrun any single-page fetch, and a cap silently drops the row we need. Narrow the
  // query to titles sharing a word with the posting's title (plus the exact URL match), then page through whatever is left.
  const scols = "source_id, title, location, url, posted_at, first_seen, last_seen, gone_at, blr";
  const stop = new Set(["and", "the", "for", "with", "senior", "sr", "junior", "jr", "lead", "manager", "head", "director", "associate", "assistant", "specialist", "analyst", "engineer", "executive", "officer", "india", "bengaluru", "bangalore"]);
  const words = [...new Set(title.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)))].slice(0, 6);
  const orTitle = words.length ? words.map((w) => `title.ilike.%${w}%`).join(",") : null;
  // Live rows come first (gone_at nulls first), so a cap keeps every live posting of a big feed and drops only the oldest
  // gone ones. 20,000 rows of titles and URLs per check was enough to push the API past its memory on a busy afternoon (29 Oct).
  const all: any[] = [];
  for (let from = 0; from < 5000; from += 1000) {
    let q = db.from("sightings").select(scols).eq("source", e.ats).like("source_id", `${e.ats_ref}:%`);
    if (orTitle) q = q.or(orTitle);
    const { data: page } = await q.order("gone_at", { ascending: true, nullsFirst: true }).order("last_seen", { ascending: false }).range(from, from + 999);
    all.push(...(page ?? []));
    if (!page || page.length < 1000) break;
  }
  if (url) {   // the posting's own link may be one of ours even when the title shares no word
    const { data: byUrl } = await db.from("sightings").select(scols).eq("source", e.ats).like("source_id", `${e.ats_ref}:%`).eq("url", strip(url)).limit(1);
    for (const r of byUrl ?? []) if (!all.some((x) => x.source_id === r.source_id)) all.push(r);
  }
  const live = all.filter((s) => !s.gone_at);
  const jobs: AtsJob[] = live.map((s) => ({ id: s.source_id, title: s.title ?? "", location: s.location ?? "", created_at: s.posted_at ?? s.first_seen, updated_at: s.last_seen, url: s.url ?? "" }));

  // 1. the link itself is one of ours (own-system links)
  const target = url ? strip(url).toLowerCase() : null;
  const direct = target ? live.find((s) => s.url && strip(s.url).toLowerCase() === target) ?? null : null;
  // 2. else by title
  const m = direct ? { best: jobs.find((j) => j.id === direct.source_id)!, copies: jobs.filter((j) => j.title === direct.title).length } : matchTitle(title, jobs);
  const best = m.best;
  // 3. closed-then-reopened: a gone sighting with the same title, and a live one that appeared after it went
  let reopened = false;
  if (best) {
    const core = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const gone = all.filter((s) => s.gone_at && core(s.title ?? "") === core(best.title));
    reopened = gone.some((g) => new Date(best.created_at ?? 0).getTime() > new Date(g.gone_at!).getTime());
  }
  const ats: PostingFacts["ats"] = { system: e.ats, found: !!best, created_at: best?.created_at ?? null, updated_at: best?.updated_at ?? null, copies: m.copies, req_id: best?.id ?? null, req_reopened: reopened, careers_url: e.careers_url ?? null };
  const evidence = best
    ? `${e.name} lists this role on its own hiring system (${e.ats}); first seen ${best.created_at ? new Date(best.created_at).toDateString() : "recently"}; ${e.blr_openings ?? live.filter((s) => s.blr).length} Bengaluru roles open today`
    : `${e.name} lists ${e.blr_openings ?? live.filter((s) => s.blr).length} Bengaluru roles on its own hiring system (${e.ats}) today; this title is not among them`;
  return { known: true, system: e.ats, ats, openings: e.openings ?? live.length, blr_openings: e.blr_openings ?? live.filter((s) => s.blr).length, live: live.length, by_url: !!direct, evidence };
}
