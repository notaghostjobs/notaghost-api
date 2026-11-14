// Real job discovery in QA — only when authorised (QA_DISCOVERY=authorised). It runs the product's own reader against a
// fixed list of employers whose public hiring-system boards were verified by hand (src/reader/data/known.ts), on five
// systems only. Reading only: no sign-in, no application, no form. No model call. Every listing is stored with its
// source, the system's own job id, its address, when it was read and its description.
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../lib/db.js";
import { companyKey } from "../engine/ghost/canon.js";
import { KNOWN } from "../reader/data/known.js";
import { readEmployer } from "../reader/read.js";
import { enrichDue } from "../reader/enrich.js";
import { getJson, getText } from "../reader/http.js";
import { byId } from "../reader/systems/index.js";
import { DISCOVERY_ON, DISCOVERY_SYSTEMS } from "./guard.js";
import { store, now } from "./state.js";
import { outside } from "./net.js";
import { isFixtureUrl, qaPoolMode, setQaPoolMode } from "./pool.js";

export const SOURCES = KNOWN.filter((k) => (DISCOVERY_SYSTEMS as readonly string[]).includes(k.ats)).map((k) => ({ name: k.names[0], key: companyKey(k.names[0]), ats: k.ats, ref: k.ref, blr_when_verified: k.blr }));
type State = { running: string | null; started: string | null; finished: string | null; read: { employer: string; system: string; ok: boolean; jobs: number; blr: number; gone: number; error: string | null; at: string }[]; enrich: { at: string; tried: number; ok: number; failed: number }[] };
const KEY = "qa:discovery:state"; let busy: string | null = null;
const load = async (): Promise<State> => (await store.get<State>(KEY)) ?? { running: null, started: null, finished: null, read: [], enrich: [] };

/** what QA holds from real sources right now */
export async function realPool() {
  const head = (q: any) => q.then((r: any) => r.count ?? 0);
  const base = () => db.from("sightings").select("id", { count: "exact", head: true }).not("url", "like", `${(process.env.QA_PUBLIC_URL ?? "").replace(/\/$/, "")}/qa/%`);
  const [all, blr, readable, gone] = await Promise.all([head(base()), head(base().eq("blr", true).is("gone_at", null)), head(base().eq("blr", true).is("gone_at", null).not("description", "is", null)), head(base().not("gone_at", "is", null))]);
  const { data: newest } = await db.from("sightings").select("last_seen").not("url", "like", `${(process.env.QA_PUBLIC_URL ?? "").replace(/\/$/, "")}/qa/%`).order("last_seen", { ascending: false }).limit(1);
  return { listings: all, live_bengaluru: blr, live_bengaluru_with_description: readable, closed: gone, last_read: newest?.[0]?.last_seen ?? null };
}

async function runRead(list: typeof SOURCES) {
  busy = "read"; const st = await load(); st.running = "reading employers"; st.started = now(); st.finished = null; st.read = st.read.filter((r) => !list.some((s) => s.name === r.employer)); await store.set(KEY, st);
  const q = [...list];
  const worker = async () => { for (;;) { const s = q.shift(); if (!s) return; let row: State["read"][number];
      try { await db.from("employers").upsert({ key: s.key, name: s.name, ats: s.ats, ats_ref: s.ref, source: "seed", resolved_at: now(), evidence: "QA discovery: hand-verified hiring-system reference" }, { onConflict: "key" });
        const r = await readEmployer({ key: s.key, name: s.name, ats: s.ats, ats_ref: s.ref }); row = { employer: s.name, system: s.ats, ok: !!r, jobs: r?.jobs ?? 0, blr: r?.blr ?? 0, gone: r?.gone ?? 0, error: r ? null : "the board no longer exists", at: now() }; }
      catch (e: any) { row = { employer: s.name, system: s.ats, ok: false, jobs: 0, blr: 0, gone: 0, error: String(e?.message ?? e).slice(0, 200), at: now() }; }
      st.read.push(row); await store.set(KEY, st); } };
  try { await Promise.all([worker(), worker(), worker()]); } finally { st.running = null; st.finished = now(); await store.set(KEY, st); busy = null; }
}
async function runEnrich(limit: number) {
  busy = "enrich"; const st = await load(); st.running = "reading job descriptions"; st.started = now(); st.finished = null; await store.set(KEY, st);
  try { let left = limit; while (left > 0) { const r = await enrichDue(Math.min(200, left), 4); st.enrich.push({ at: now(), ...r }); st.enrich = st.enrich.slice(-40); await store.set(KEY, st); left -= 200; if (r.tried === 0) break; } }
  finally { st.running = null; st.finished = now(); await store.set(KEY, st); busy = null; }
}

export type Evidence = { sighting_id: number; checked_at: string; status: "verified_active" | "closed" | "unverifiable" | "invented_fixture"; how: string; http: number | null; source: string | null; job_id: string | null; board: string | null; url: string; title_now: string | null; posted_at: string | null; posted_text: string | null; first_read: string | null; last_read: string | null; description_read_at: string | null; description_chars: number; age_note: string | null };
/** Is this listing open right now? Asked of the hiring system itself, at this moment — not taken from what QA stored. */
export async function verifyListing(s: { id: number; source: string | null; source_id: string | null; url: string; title?: string | null; posted_at?: string | null; posted_text?: string | null; first_seen?: string | null; last_seen?: string | null; enriched_at?: string | null; description?: string | null; gone_at?: string | null }): Promise<Evidence> {
  const cut = (s.source_id ?? "").indexOf(":"); const ref = cut > 0 ? s.source_id!.slice(0, cut) : null; const id = cut > 0 ? s.source_id!.slice(cut + 1) : null;
  const days = s.posted_at ? Math.floor((Date.now() - Date.parse(s.posted_at)) / 86400e3) : null;
  const base: Evidence = { sighting_id: s.id, checked_at: now(), status: "unverifiable", how: "", http: null, source: s.source, job_id: id, board: ref, url: s.url, title_now: null, posted_at: s.posted_at ?? null, posted_text: s.posted_text ?? null, first_read: s.first_seen ?? null, last_read: s.last_seen ?? null, description_read_at: s.enriched_at ?? null, description_chars: (s.description ?? "").length,
    age_note: days != null && days > 90 ? `the employer's system dates it ${days} days ago` : /30\+\s*days/i.test(s.posted_text ?? "") ? "the employer's system says “posted 30+ days ago”" : null };
  if (isFixtureUrl(s.url)) return { ...base, status: "invented_fixture", how: "this is a QA fixture, not a real listing" };
  if (!DISCOVERY_ON) return { ...base, how: "reading public listings is not authorised, so nothing was checked" };
  try {
    if (s.source === "greenhouse" && ref && id) { const r = await getJson<any>(`https://boards-api.greenhouse.io/v1/boards/${ref}/jobs/${id}`); return { ...base, http: r.status, status: r.ok ? "verified_active" : r.status === 404 ? "closed" : "unverifiable", how: "asked Greenhouse's public job API for this job id", title_now: r.data?.title ?? null }; }
    if (s.source === "lever" && ref && id) { const r = await getJson<any>(`https://api.lever.co/v0/postings/${ref}/${id}`); return { ...base, http: r.status, status: r.ok ? "verified_active" : r.status === 404 ? "closed" : "unverifiable", how: "asked Lever's public postings API for this job id", title_now: r.data?.text ?? null }; }
    if (s.source === "workday") { const m = s.url.match(/^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([^/?#]+)(\/job\/[^?#]+)/i);
      if (m) { const [, tenant, wd, site, path] = m; const b = `https://${tenant}.${wd}.myworkdayjobs.com`; const r = await getJson<any>(`${b}/wday/cxs/${tenant}/${site}${path}`, { headers: { accept: "application/json", referer: `${b}/${site}` } }); const info = r.data?.jobPostingInfo;
        return { ...base, http: r.status, status: r.ok && info ? "verified_active" : r.status === 404 || r.status === 410 ? "closed" : "unverifiable", how: "asked the employer's Workday site for this posting", title_now: info?.title ?? null }; } }
    if ((s.source === "ashby" || s.source === "smartrecruiters") && ref && id) { const f = await byId(s.source)!.read(ref); if (f) { const j = f.jobs.find((x) => String(x.id) === id); if (j || !f.partial) return { ...base, http: 200, status: j ? "verified_active" : "closed", how: `re-read the employer's ${s.source} board and looked for this job id among ${f.jobs.length} open roles`, title_now: j?.title ?? null }; } }
    const r = await getText(s.url); const dead = /no longer (accepting|available|open)|position (has been )?(filled|closed)|job (has )?expired|page not found/i.test(r.text.slice(0, 6000));
    return { ...base, http: r.status, status: r.status === 404 || r.status === 410 || dead ? "closed" : r.ok ? "unverifiable" : "unverifiable", how: r.ok && !dead ? "the page opened, but this source gives no way to confirm the role is still open" : "opened the job page" };
  } catch (e: any) { return { ...base, how: `the check could not be made: ${String(e?.message ?? e).slice(0, 140)}` }; }
}

export function discoveryRoutes() {
  const r = new Hono();
  r.get("/status", async (c) => { const st = await load(); const okFeeds = st.read.filter((x) => x.ok);
    return c.json({ authorised: DISCOVERY_ON, authorised_by: process.env.QA_DISCOVERY_AUTHORISED_BY ?? null, authorised_on: process.env.QA_DISCOVERY_AUTHORISED_ON ?? null, pool_mode: await qaPoolMode(), running: busy ?? st.running, started: st.started, finished: st.finished,
      rules: { systems: DISCOVERY_SYSTEMS, hosts: "*.greenhouse.io, *.lever.co, *.ashbyhq.com, *.smartrecruiters.com, *.myworkdayjobs.com", methods: "GET and HEAD; POST only to Workday's own job search", never: "sign-in, apply, forms, cookies, any other host", robots_txt: "honoured by the reader", model_calls: 0 },
      sources: { listed: SOURCES.length, by_system: Object.fromEntries(DISCOVERY_SYSTEMS.map((s) => [s, SOURCES.filter((x) => x.ats === s).length])), read_ok: okFeeds.length, read_failed: st.read.length - okFeeds.length, not_read_yet: SOURCES.length - st.read.length },
      held: await realPool(), requests_since_start: Object.fromEntries(outside), feeds: st.read.sort((a, b) => a.employer.localeCompare(b.employer)), descriptions: st.enrich.slice(-5),
      coverage_note: `This is ${SOURCES.length} employers on five hiring systems. Production also reads employers on other systems and their own portals; a role QA never read cannot be recommended, and is not a Radar miss.` }); });
  r.get("/sources", (c) => c.json({ sources: SOURCES }));
  r.post("/pool", async (c, next) => { const m = (await c.req.json().catch(() => ({})))?.mode; if (m !== "fixtures") return next(); await setQaPoolMode("fixtures", String(c.req.header("x-qa-tester") ?? "")); return c.json({ ok: true, pool_mode: "fixtures" }); });   // going back to fixtures is always allowed
  r.use("*", async (c, next) => { if (c.req.method !== "POST") return next(); if (!DISCOVERY_ON) return c.json({ error: "Reading public job listings is not authorised in this QA environment.", authorised: false }, 403); return next(); });
  r.post("/read", async (c) => { const b = z.object({ systems: z.array(z.enum(DISCOVERY_SYSTEMS)).optional(), limit: z.number().int().min(1).max(200).optional(), only_unread: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "systems (optional), limit (optional), only_unread (optional)" }, 400);
    if (busy) return c.json({ ok: true, already_running: busy }); const st = await load();
    let list = SOURCES.filter((s) => !b.data.systems || b.data.systems.includes(s.ats as any)); if (b.data.only_unread) list = list.filter((s) => !st.read.some((x) => x.employer === s.name && x.ok)); if (b.data.limit) list = list.slice(0, b.data.limit);
    void runRead(list).catch((e) => console.error("[qa-discovery] read", e?.message ?? e)); return c.json({ ok: true, reading: list.length, note: "Runs in the background, three employers at a time. Read /qa/discovery/status." }); });
  r.post("/descriptions", async (c) => { const b = z.object({ limit: z.number().int().min(1).max(20000).default(2000) }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "limit (1–20000)" }, 400);
    if (busy) return c.json({ ok: true, already_running: busy }); void runEnrich(b.data.limit).catch((e) => console.error("[qa-discovery] descriptions", e?.message ?? e)); return c.json({ ok: true, up_to: b.data.limit, note: "Reads the newest Bengaluru listings' own pages for their text, in the background. Read /qa/discovery/status." }); });
  r.post("/pool", async (c) => { const b = z.object({ mode: z.enum(["fixtures", "real"]) }).safeParse(await c.req.json().catch(() => ({}))); if (!b.success) return c.json({ error: "mode: fixtures | real" }, 400);
    if (b.data.mode === "real" && (await realPool()).live_bengaluru_with_description === 0) return c.json({ error: "No real listing with a description is held yet. Read the sources and their descriptions first." }, 409);
    await setQaPoolMode(b.data.mode, String(c.req.header("x-qa-tester") ?? "")); return c.json({ ok: true, pool_mode: b.data.mode, note: "Radar's list of roles switches within two minutes." }); });
  return r;
}
