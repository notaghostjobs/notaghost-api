// The reader worker: its own process. Resolves employers, reads feeds, harvests boards. Reports what it is doing in reader_control.
import { NAUKRI_BLR } from "./data/naukri-blr.js";
import { companyKey } from "../engine/ghost/canon.js";
import { db } from "../lib/db.js";
import { resolveBatch } from "./resolve.js";
import { readDue, recordFeed } from "./read.js";
import { harvestNaukri } from "./harvest/naukri.js";
import { harvestSectors } from "./harvest/sectors.js";
import { byId } from "./systems/index.js";
import { mode } from "./systems/types.js";
import { isBlr } from "./blr.js";
import { seedTier1, checkTier1, type Tier1Row } from "./tier1.js";
import { probeUrl } from "./probe.js";
import { enrichDue } from "./enrich.js";
import { fingerprint, stripFurniture } from "../engine/ghost/canon.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[reader]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setControl(key: string, value: unknown) { await db.from("reader_control").upsert({ key, value, updated_at: new Date().toISOString() }); }
async function getControl<T = any>(key: string): Promise<T | null> { const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; }

let busy: string | null = null;
const boot = new Date().toISOString();
async function status(doing: string, extra: Record<string, unknown> = {}) { busy = doing === "idle" ? null : doing; const mb = Math.round(process.memoryUsage().rss / 1048576); await setControl("status", { doing, ...extra, at: new Date().toISOString(), boot, rss_mb: mb }); }

/** Prove each reader against an employer we know uses that system. Stored for the admin page. */
async function selfTest() {
  const probes: [string, string][] = [["greenhouse", "razorpaysoftwareprivatelimited"], ["lever", "spotify"], ["ashby", "ashby"], ["smartrecruiters", "BoschGroup"],
    ["successfactors", "https://careers.hcltech.com"], ["successfactors", "https://careers.wipro.com"], ["google", "google"], ["goldman", "goldman"], ["ibm", "ibm"], ["microsoft", "microsoft"], ["oracle", "jpmc.fa.oraclecloud.com/CX_1001"], ["workday", "adobe/wd5/external_experienced"], ["workday", "walmart/wd5/WalmartExternal"], ["workday", "infosys/wd103/InfosysCareers"], ["workday", "wipro/wd3/Wipro_Careers"], ["workday", "nvidia/wd5/NVIDIAExternalCareerSite"], ["workday", "salesforce/wd12/External_Career_Site"]];
  const out: Record<string, unknown>[] = [];
  mode.quick = true; // a few pages per reader: enough to prove it reads, not the whole board
  try { for (const [sys, ref] of probes) {
    const t0 = Date.now();
    try { const f = await byId(sys)!.read(ref); const blr = f ? f.jobs.filter((j) => isBlr(j.location)).length : 0; out.push({ system: sys, ref, ok: !!f && f.jobs.length > 0, jobs: f?.jobs.length ?? 0, blr, company: f?.company_name ?? null, sample: f?.jobs[0] ? `${f.jobs[0].title} — ${f.jobs[0].location}` : null, debug: f?.debug ?? null, ms: Date.now() - t0 }); }
    catch (e) { out.push({ system: sys, ref, ok: false, error: (e as Error).message, ms: Date.now() - t0 }); }
  } } finally { mode.quick = false; }
  await setControl("selftest", { at: new Date().toISOString(), results: out });
  log("selftest", out.map((o) => `${o.system}:${o.ok ? o.jobs : "FAIL"}`).join(" "));
}

let resolvedThisRun = 0;
async function runResolve(n: number) {
  await status("resolve", { batch: n, done_since_boot: resolvedThisRun });
  // 3 at a time, not 6: six big feeds (thousands of jobs each) decoding at once pushed the worker past its memory on 29 Oct
  const r = await resolveBatch(n, 3,
    async (key, res) => { if (res.feed && res.ats !== "none") { const { data: e } = await db.from("employers").select("key, name, ats, ats_ref").eq("key", key).single(); if (e) await recordFeed(e, res.feed).catch((err) => log("record", key, err.message)); } },
    (name, res, err) => { resolvedThisRun++; const last = err ? `${name} → error: ${err.slice(0, 80)}` : `${name} → ${res!.ats}${res!.feed ? ` (${res!.feed.jobs.length} jobs)` : ""}`; log("resolved", last); void status("resolve", { batch: n, done_since_boot: resolvedThisRun, last }); });
  log("resolve", JSON.stringify(r)); return r;
}
async function runRead(n: number) { await status("read+enrich", { read_batch: n }); const r = await readDue(n); log("read", JSON.stringify(r)); return r; }
async function runHarvest(maxPages: number) {
  await status("harvest", { source: "naukri", maxPages });
  const r = await harvestNaukri({ maxPages, onPage: (s) => { if (s.pages % 10 === 0) void status("harvest", { source: "naukri", ...s }); } });
  log("harvest naukri", JSON.stringify(r)); return r;
}

async function runSectors(n: number, set: 1 | 2 = 1) {
  await status("sectors", { of: n || "all", set });
  const r = await harvestSectors({ limit: n || undefined, set, onSector: (done, total, added) => void status("sectors", { done, total, set, employers_new: added }) });
  log("sectors", JSON.stringify(r)); return r;
}

/** The twenty largest employers, one row each: system, Bengaluru openings, how. Stored as it goes so the page updates live. */
async function runTier1() {
  await status("tier1", { of: 20 });
  await seedTier1();
  const rows: Tier1Row[] = [];
  mode.progress = (line) => void status("tier1", { done: rows.length, of: 20, now: line });
  const r = await checkTier1(async (row) => { rows.push(row); log("tier1", `${row.name} → ${row.ats ?? "?"} blr ${row.blr}/${row.jobs}${row.error ? " ERR " + row.error : ""}`); await setControl("tier1", { at: new Date().toISOString(), done: rows.length, rows }); void status("tier1", { done: rows.length, of: 20, last: `${row.name} → ${row.ats ?? "?"} (${row.blr} BLR)` }); });
  mode.progress = null;
  await setControl("tier1", { at: new Date().toISOString(), done: r.length, rows: r });
  return { companies: r.length, with_feed: r.filter((x) => x.ats && x.ats !== "none").length, blr: r.reduce((a, x) => a + x.blr, 0) };
}

async function runEnrich(n: number) { const r = await enrichDue(n); log("enrich", JSON.stringify(r)); return r; }

/** One command from the admin page: {step, n, url}. */
async function runCommand(cmd: { step: string; n?: number; url?: string }) {
  if (cmd.step === "probe" && cmd.url) { await status("probe", { url: cmd.url }); const r = await probeUrl(cmd.url).catch((e) => ({ error: (e as Error).message })); await setControl("probe", r); return r; }
  const n = cmd.n ?? 0;
  if (cmd.step === "resolve") return runResolve(n || 20);
  if (cmd.step === "read") return runRead(n || 200);
  if (cmd.step === "harvest") return runHarvest(n || 50);
  if (cmd.step === "sectors") return runSectors(n);
  if (cmd.step === "sectors2") return runSectors(n, 2);
  if (cmd.step === "selftest") return selfTest();
  if (cmd.step === "tier1") return runTier1();
  if (cmd.step === "enrich") return runEnrich(n || 300);
  return { error: `unknown step ${cmd.step}` };
}

/** Ops channel: commands.json on the public `ops` branch (no deploy involved). Each command runs once; results land in reader_control. */
const OPS_URL = "https://raw.githubusercontent.com/notaghostjobs/notaghost-api/ops/commands.json";
async function pollOps() {
  try {
    const r = await fetch(`${OPS_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(10000), headers: { "cache-control": "no-cache" } });
    if (!r.ok) return;
    const j = await r.json() as { commands?: { id: string; step: string; n?: number; url?: string }[] };
    const seen = (await getControl<{ ids: string[] }>("ops_seen"))?.ids ?? [];
    for (const cmd of j.commands ?? []) {
      if (!cmd?.id || seen.includes(cmd.id)) continue;
      seen.push(cmd.id); await setControl("ops_seen", { ids: seen.slice(-200) });
      log("ops", cmd.id, cmd.step, cmd.url ?? cmd.n ?? "");
      const res = await runCommand(cmd).catch((e) => ({ error: (e as Error).message }));
      await setControl(`ops:${cmd.id}`, { cmd, result: res, at: new Date().toISOString() });
      const recent = (await getControl<{ ids: string[] }>("ops_recent"))?.ids ?? [];
      await setControl("ops_recent", { ids: [...recent, cmd.id].slice(-8) });
      await status("idle");
    }
  } catch { /* offline or no file yet */ }
}

/** The daily pass, 06:00 IST: harvest the board (new employers + listings), resolve everything new, re-read every feed. */
async function daily() {
  const t0 = Date.now();
  const h = await runHarvest(1000);
  let resolved = { done: 0, found: 0, none: 0, errors: 0 };
  for (let i = 0; i < 400; i++) { const r = await runResolve(20); if (!r.done) break; resolved = { done: resolved.done + r.done, found: resolved.found + r.found, none: resolved.none + r.none, errors: resolved.errors + r.errors }; }
  let read = { employers: 0, jobs: 0, blr: 0, gone: 0, errors: 0 };
  for (let i = 0; i < 50; i++) { const r = await runRead(500); if (!r.employers) break; read = { employers: read.employers + r.employers, jobs: read.jobs + r.jobs, blr: read.blr + r.blr, gone: read.gone + r.gone, errors: read.errors + r.errors }; }
  let enriched = { tried: 0, ok: 0, failed: 0 };
  for (let i = 0; i < 200; i++) { const e = await runEnrich(60); if (!e.tried) break; enriched = { tried: enriched.tried + e.tried, ok: enriched.ok + e.ok, failed: enriched.failed + e.failed }; }
  await setControl("last_daily", { at: new Date().toISOString(), minutes: Math.round((Date.now() - t0) / 60000), harvest: h, resolved, read, enriched });
}

const istHour = () => (new Date().getUTCHours() + 5.5) % 24;
let lastDaily = "";
let batches = 0;

const BIG = ["IT services and outsourcing", "global capability centres (GCCs) of foreign companies", "US tech companies with Bengaluru engineering centres", "European and Japanese companies with Bengaluru centres", "large Indian conglomerates with Bengaluru operations", "banks and NBFCs", "consulting and professional services (big four, strategy)", "semiconductor and chip design", "networking, telecom and 5G", "unicorns and large startups", "e-commerce and marketplaces", "fintech and payments"];
/** One-time migrations of queue state, keyed in reader_control so a restart never repeats them. */
async function onceOnly(key: string, fn: () => Promise<void>) {
  const done = await getControl<{ at: string }>(`once:${key}`);
  if (done?.at) return;
  await fn();
  await setControl(`once:${key}`, { at: new Date().toISOString() });
}
async function setPriorities() {
  await onceOnly("priorities-v1", async () => {
    const { error } = await db.from("employers").update({ priority: 1 }).in("source", BIG.map((b) => `sector:${b.slice(0, 40)}`)).eq("priority", 5);
    if (error) log("priority column missing? run 0007_priority.sql —", error.message);
  });
  // Workday employers read with the old crawl; "page" employers before the Phenom/Eightfold probe existed — each re-queued exactly once.
  await onceOnly("workday-facet-reread-v1", async () => { await db.from("employers").update({ read_at: null }).eq("ats", "workday"); });
  await onceOnly("page-reresolve-v1", async () => { await db.from("employers").update({ resolved_at: null, ats: null, ats_ref: null }).eq("ats", "page"); });
  // Workday job pages failed as "no readable text" before the JSON detail reader existed — queue them again, once.
  // 25 Oct night: readers that were refused returned empty feeds and the loop marked whole employers gone. Undo exactly that:
  // employers with nothing live now whose rows were marked gone after that deploy get them back, and a fresh read.
  await onceOnly("restore-empty-reads-v1", async () => {
    const since = "2026-10-25T16:27:00Z"; let restored = 0, employers = 0;
    const { data: es } = await db.from("employers").select("key, ats").not("ats", "is", null).not("ats", "in", '("none")').limit(2000);
    for (const e of es ?? []) {
      const { count: live } = await db.from("sightings").select("*", { count: "exact", head: true }).eq("employer_key", e.key).is("gone_at", null);
      if ((live ?? 0) > 0) continue;
      const { data } = await db.from("sightings").update({ gone_at: null }).eq("employer_key", e.key).gte("gone_at", since).select("id");
      if (data?.length) { restored += data.length; employers++; await db.from("employers").update({ read_at: null, read_error: "restored after an empty read; re-reading" }).eq("key", e.key); }
    }
    log("restore", `${restored} sightings across ${employers} employers`);
    await setControl("restore_v1", { at: new Date().toISOString(), restored, employers });
  });
  // 27 Oct: LinkedIn's split view leaked its "compare / Premium / about the company" panels into the stored postings; every
  // such posting then looked like a near-copy of every other and signal 7 fired on all of them. Re-fingerprint from the
  // posting alone, and let any row whose fingerprint moved be re-scored on its next check.
  await onceOnly("refingerprint-furniture-v1", async () => {
    let changed = 0, seen = 0;
    const { data: rows } = await db.from("postings").select("id, raw_text, fingerprint").not("raw_text", "is", null).limit(5000);
    for (const p of rows ?? []) {
      seen++;
      const clean = stripFurniture(p.raw_text);
      const fp = fingerprint(clean);
      if (fp === p.fingerprint) continue;
      changed++;
      await db.from("postings").update({ raw_text: clean, fingerprint: fp, scored_at: null, next_check: null }).eq("id", p.id);
    }
    log("refingerprint", `${changed} of ${seen} postings changed`);
  });
  // 27 Oct: the extension read LinkedIn's split view before the pane repainted, filing one job's text under another job's id.
  // Those rows (LinkedIn, first seen today IST) cannot be trusted at all: blank their text and fingerprint so they neither
  // match other postings nor feed the panel; the next check on each re-reads the page properly.
  await onceOnly("purge-crossfiled-splitview-v1", async () => {
    const { data, error } = await db.from("postings").update({ raw_text: "", fingerprint: null, scored_at: null, next_check: null, signals: null, score: null, verdict: null })
      .eq("source", "linkedin").gte("first_seen_at", "2026-10-26T18:30:00Z").select("id");
    log("purge cross-filed", error ? error.message : `${data?.length ?? 0} rows`);
  });
  // 28 Oct: employers that real checks hit today, which the resolver either timed out on (cheap path) or guessed with no
  // sightings. Priority 1 so the browser path runs; resolution cleared so they are retried; a careers URL where we know it.
  await onceOnly("reresolve-checked-employers-v1", async () => {
    const hints: Record<string, string | null> = {
      "myntra": "https://careers.myntra.com/", "zepto": "https://www.zeptonow.com/careers", "takeda": "https://jobs.takeda.com/",
      "takeda pharmaceutical india": "https://jobs.takeda.com/", "harman connected services": "https://jobs.harman.com/",
      "pine labs": "https://www.pinelabs.com/careers", "april": null, "zeiss india": "https://www.zeiss.com/corporate/en/careers.html",
      "carl zeiss india": "https://www.zeiss.com/corporate/en/careers.html", "godrej industries": "https://careers.godrejindustries.com/",
      "scapia": "https://scapia.app/careers", "curefoods": "https://curefoods.in/careers", "the souled store": "https://www.thesouledstore.com/careers",
      "klay": null, "alpha school": "https://alpha.school/careers", "godrej consumer products": "https://www.godrejcp.com/careers",
    };
    let n = 0;
    for (const [key, url] of Object.entries(hints)) {
      const patch: Record<string, unknown> = { priority: 1, resolved_at: null, resolve_error: null, ats: null, ats_ref: null, confidence: null };
      if (url) patch.careers_url = url;
      const { data } = await db.from("employers").update(patch).eq("key", key).select("key");
      n += data?.length ?? 0;
    }
    log("reresolve", `${n} employers queued at priority 1`);
  });
  // 29 Oct: Naukri's employer facet for Bengaluru — 499 employers, 32,410 open postings, of which we could read the employer for
  // 14,405 (44%) — plus its sales & BD facet. Every one we can't read is queued: known rows re-resolved at priority 1 (resolution cleared so the
  // browser path runs), unknown ones inserted, and a careers URL given where we know it. The resolver verifies every hint.
  await onceOnly("reresolve-naukri-blr-v2", async () => {
    const list = NAUKRI_BLR;
    let updated = 0, inserted = 0;
    for (const e of list) {
      if (e.found && e.ats && e.ats !== "none") continue;   // already readable
      if (e.found && e.match) {
        const patch: Record<string, unknown> = { priority: 1, resolved_at: null, resolve_error: null, ats: null, ats_ref: null, confidence: null };
        if (e.careers_url) patch.careers_url = e.careers_url;
        const { data } = await db.from("employers").update(patch).eq("name", e.match).select("key");
        updated += data?.length ?? 0;
      } else {
        const row: Record<string, unknown> = { key: companyKey(e.name), name: e.name, source: "naukri:employer-facet blr", priority: 1 };
        if (e.careers_url) row.careers_url = e.careers_url;
        const { error } = await db.from("employers").upsert(row, { onConflict: "key", ignoreDuplicates: true });
        if (!error) inserted++;
      }
    }
    log("reresolve naukri", `${updated} employers re-queued, ${inserted} added, all at priority 1`);
  });
  await onceOnly("enrich-retry-workday-v1", async () => { const { error } = await db.from("sightings").update({ enriched_at: null, enrich_error: null }).eq("source", "workday").is("gone_at", null).eq("blr", true).is("description", null).not("enriched_at", "is", null); if (error) log("enrich retry", error.message); });
}

async function main() {
  log("worker up");
  await setControl("heartbeat", { boot, at: new Date().toISOString(), build: "f051051+" });
  setInterval(() => void setControl("heartbeat", { boot, at: new Date().toISOString(), build: "f051051+", rss_mb: Math.round(process.memoryUsage().rss / 1048576) }), 60000);
  // these three already ran earlier tonight; mark them done so this boot does not repeat them
  for (const k of ["workday-facet-reread-v1", "page-reresolve-v1", "tier1-first-run-v1"]) { const d = await getControl<{ at: string }>(`once:${k}`); if (!d?.at) await setControl(`once:${k}`, { at: "2026-10-24T17:30:00.000Z", note: "already done before onceOnly existed" }); }
  await setPriorities();
  await selfTest();
  await onceOnly("tier1-first-run-v1", async () => { await runTier1().catch((e) => log("tier1", (e as Error).message)); });
  await status("idle");
  for (;;) {
    try {
      // 0. ops channel (GitHub)
      await pollOps();
      // 1. an explicit command from the admin page
      const cmd = await getControl<{ step: string; n?: number; url?: string }>("command");
      if (cmd?.step) { await setControl("command", {}); const r = await runCommand(cmd); await setControl("last_run", { cmd, result: r, at: new Date().toISOString() }); await status("idle"); continue; }
      // 2. the daily pass
      const today = new Date().toISOString().slice(0, 10);
      if (istHour() >= 6 && istHour() < 7 && lastDaily !== today) { lastDaily = today; await daily(); await status("idle"); continue; }
      // 3. otherwise keep resolving whatever is unresolved, then keep feeds fresh
      const { count } = await db.from("employers").select("key", { count: "exact", head: true }).is("resolved_at", null);
      if ((count ?? 0) > 0) { await runResolve(20); if (++batches % 3 === 0) await runRead(20); await runEnrich(120); await status("idle", { unresolved: (count ?? 0) - 20 }); continue; }
      // feed re-reads and page enrichment hit different servers: run them together so a slow feed never starves enrichment
      const [r, e] = await Promise.all([runRead(50), runEnrich(300)]); await status("idle", { read: r, enrich: e });
      if (!r.employers && !e.tried) await sleep(30000);
    } catch (e) { log("loop error", (e as Error).message); await status("idle", { error: (e as Error).message }); await sleep(10000); }
  }
}
main();
