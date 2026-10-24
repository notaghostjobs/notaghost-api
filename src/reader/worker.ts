// The reader worker: its own process. Resolves employers, reads feeds, harvests boards. Reports what it is doing in reader_control.
import { db } from "../lib/db.js";
import { resolveBatch } from "./resolve.js";
import { readDue, recordFeed } from "./read.js";
import { harvestNaukri } from "./harvest/naukri.js";
import { byId } from "./systems/index.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[reader]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setControl(key: string, value: unknown) { await db.from("reader_control").upsert({ key, value, updated_at: new Date().toISOString() }); }
async function getControl<T = any>(key: string): Promise<T | null> { const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; }

let busy: string | null = null;
async function status(doing: string, extra: Record<string, unknown> = {}) { busy = doing === "idle" ? null : doing; await setControl("status", { doing, ...extra, at: new Date().toISOString() }); }

/** Prove each reader against an employer we know uses that system. Stored for the admin page. */
async function selfTest() {
  const probes: [string, string][] = [["greenhouse", "razorpaysoftwareprivatelimited"], ["lever", "spotify"], ["lever", "netflix"], ["ashby", "ashby"], ["smartrecruiters", "BoschGroup"], ["workday", "walmart/wd5/WalmartExternal"], ["workday", "adobe/wd5/external_experienced"]];
  const out: Record<string, unknown>[] = [];
  for (const [sys, ref] of probes) {
    const t0 = Date.now();
    try { const f = await byId(sys)!.read(ref); out.push({ system: sys, ref, ok: !!f && f.jobs.length > 0, jobs: f?.jobs.length ?? 0, company: f?.company_name ?? null, sample: f?.jobs[0] ? `${f.jobs[0].title} — ${f.jobs[0].location}` : null, ms: Date.now() - t0 }); }
    catch (e) { out.push({ system: sys, ref, ok: false, error: (e as Error).message, ms: Date.now() - t0 }); }
  }
  await setControl("selftest", { at: new Date().toISOString(), results: out });
  log("selftest", out.map((o) => `${o.system}:${o.ok ? o.jobs : "FAIL"}`).join(" "));
}

async function runResolve(n: number) {
  await status("resolve", { batch: n });
  const r = await resolveBatch(n, 4, async (key, res) => { if (res.feed && res.ats !== "none") { const { data: e } = await db.from("employers").select("key, name, ats, ats_ref").eq("key", key).single(); if (e) await recordFeed(e, res.feed).catch((err) => log("record", key, err.message)); } });
  log("resolve", JSON.stringify(r)); return r;
}
async function runRead(n: number) { await status("read", { batch: n }); const r = await readDue(n); log("read", JSON.stringify(r)); return r; }
async function runHarvest(maxPages: number) {
  await status("harvest", { source: "naukri", maxPages });
  const r = await harvestNaukri({ maxPages, onPage: (s) => { if (s.pages % 10 === 0) void status("harvest", { source: "naukri", ...s }); } });
  log("harvest naukri", JSON.stringify(r)); return r;
}

/** One command from the admin page: {step, n}. */
async function runCommand(cmd: { step: string; n?: number }) {
  const n = cmd.n ?? 0;
  if (cmd.step === "resolve") return runResolve(n || 20);
  if (cmd.step === "read") return runRead(n || 200);
  if (cmd.step === "harvest") return runHarvest(n || 50);
  if (cmd.step === "selftest") return selfTest();
  return { error: `unknown step ${cmd.step}` };
}

/** The daily pass, 06:00 IST: harvest the board (new employers + listings), resolve everything new, re-read every feed. */
async function daily() {
  const t0 = Date.now();
  const h = await runHarvest(1000);
  let resolved = { done: 0, found: 0, none: 0, errors: 0 };
  for (let i = 0; i < 400; i++) { const r = await runResolve(20); if (!r.done) break; resolved = { done: resolved.done + r.done, found: resolved.found + r.found, none: resolved.none + r.none, errors: resolved.errors + r.errors }; }
  let read = { employers: 0, jobs: 0, blr: 0, gone: 0, errors: 0 };
  for (let i = 0; i < 50; i++) { const r = await runRead(500); if (!r.employers) break; read = { employers: read.employers + r.employers, jobs: read.jobs + r.jobs, blr: read.blr + r.blr, gone: read.gone + r.gone, errors: read.errors + r.errors }; }
  await setControl("last_daily", { at: new Date().toISOString(), minutes: Math.round((Date.now() - t0) / 60000), harvest: h, resolved, read });
}

const istHour = () => (new Date().getUTCHours() + 5.5) % 24;
let lastDaily = "";

async function main() {
  log("worker up");
  await selfTest();
  await status("idle");
  for (;;) {
    try {
      // 1. an explicit command from the admin page
      const cmd = await getControl<{ step: string; n?: number }>("command");
      if (cmd?.step) { await setControl("command", {}); const r = await runCommand(cmd); await setControl("last_run", { cmd, result: r, at: new Date().toISOString() }); await status("idle"); continue; }
      // 2. the daily pass
      const today = new Date().toISOString().slice(0, 10);
      if (istHour() >= 6 && istHour() < 7 && lastDaily !== today) { lastDaily = today; await daily(); await status("idle"); continue; }
      // 3. otherwise keep resolving whatever is unresolved, then keep feeds fresh
      const { count } = await db.from("employers").select("key", { count: "exact", head: true }).is("resolved_at", null);
      if ((count ?? 0) > 0) { await runResolve(20); await status("idle", { unresolved: (count ?? 0) - 20 }); continue; }
      const r = await runRead(50); await status("idle");
      if (!r.employers) await sleep(30000);
    } catch (e) { log("loop error", (e as Error).message); await status("idle", { error: (e as Error).message }); await sleep(10000); }
  }
}
main();
