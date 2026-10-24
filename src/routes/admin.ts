import { Hono } from "hono";
import { db } from "../lib/db.js";
import { snapshotDue } from "../engine/ghost/index.js";
import { companyKey } from "../engine/ghost/canon.js";

export const admin = new Hono();
// every /reader/<x> route is also served at /r/<secret>/<x>
import type { Context } from "hono";
type H = (c: Context) => Response | Promise<Response>;
const both = (method: "get" | "post") => (path: string, h: H) => { (admin as any)[method](path, h); if (path.startsWith("/reader/")) (admin as any)[method](path.replace("/reader/", "/r/:secret/"), h); return admin; };
const on = { get: both("get"), post: both("post") };
// the secret may come as a header, a ?key= query, or a path segment (/admin/r/<secret>/...) for fetch tools that refuse key-bearing queries
admin.use("*", async (c, next) => { const fromPath = c.req.path.match(/\/admin\/r\/([^/]+)\//)?.[1]; const k = c.req.header("x-admin") ?? c.req.query("key") ?? fromPath; if (!process.env.ADMIN_SECRET || k !== process.env.ADMIN_SECRET) return c.json({ error: "no" }, 403); await next(); });

admin.post("/snapshot", async (c) => c.json({ rechecked: await snapshotDue(Number(c.req.query("limit") ?? 200)) }));

/** Seed employers from "Name | hint" lines. Hint may be "greenhouse:slug", a careers URL, or nothing. */
on.post("/reader/seed", async (c) => {
  const lines = (await c.req.text()).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  const rows = lines.map((line) => {
    const [name, hint] = line.split("|").map((s) => s.trim());
    const m = hint?.match(/^([a-z]+):(.+)$/i);
    return { key: companyKey(name), name, source: "seed", ats: m ? m[1].toLowerCase() : null, ats_ref: m ? m[2] : null, careers_url: hint && /^https?:/i.test(hint) ? hint : null };
  }).filter((r) => r.key);
  const { error, data } = await db.from("employers").upsert(rows, { onConflict: "key", ignoreDuplicates: true }).select("key");
  return c.json(error ? { error: error.message } : { added: data?.length ?? 0, given: rows.length });
});

/** Ask the worker to run a step now: resolve | read | harvest | selftest, with n. */
const runHandler: H = async (c) => {
  const step = c.req.query("step"); const n = Number(c.req.query("n") ?? 0) || undefined; const url = c.req.query("url") || undefined;
  if (!step) return c.json({ error: "step?" }, 400);
  await db.from("reader_control").upsert({ key: "command", value: { step, n, url }, updated_at: new Date().toISOString() });
  return c.json({ queued: { step, n, url } });
};
on.post("/reader/run", runHandler);
on.get("/reader/run", runHandler);   // so a read-only fetch tool can queue a probe

/** The last probe result on its own. */
on.get("/reader/probe", async (c) => { const { data } = await db.from("reader_control").select("value").eq("key", "probe").maybeSingle(); return c.json(data?.value ?? null); });
/** Current status + last run on their own (small). */
on.get("/reader/status", async (c) => { const { data } = await db.from("reader_control").select("key, value").in("key", ["status", "last_run", "command"]); const o: Record<string, unknown> = {}; for (const r of data ?? []) o[r.key] = r.value; return c.json(o); });

/** The truth, in numbers. */
on.get("/reader/stats", async (c) => {
  const count = async (table: string, f: (q: any) => any) => { const { count } = await f(db.from(table).select("*", { count: "exact", head: true })); return count ?? 0; };
  const [employers, unresolved, none, sightings, live, blr, enriched, ctl] = await Promise.all([
    count("employers", (q) => q), count("employers", (q) => q.is("resolved_at", null)), count("employers", (q) => q.eq("ats", "none")),
    count("sightings", (q) => q), count("sightings", (q) => q.is("gone_at", null)), count("sightings", (q) => q.is("gone_at", null).eq("blr", true)),
    count("sightings", (q) => q.is("gone_at", null).eq("blr", true).not("description", "is", null)),
    db.from("reader_control").select("key, value, updated_at"),
  ]);
  // PostgREST caps a select at 1000 rows, so count per known value instead of fetching rows
  const SYSTEMS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "keka", "darwinbox", "page", "none"];
  const SOURCES = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "keka", "darwinbox", "page", "naukri", "linkedin"];
  const systems: Record<string, number> = {}, confidence: Record<string, number> = {}, sources: Record<string, { all: number; blr: number }> = {};
  await Promise.all([
    ...SYSTEMS.map(async (sys) => { const n = await count("employers", (q) => q.eq("ats", sys)); if (n) systems[sys] = n; }),
    ...["link", "page", "search", "guess"].map(async (cf) => { const n = await count("employers", (q) => q.eq("confidence", cf).neq("ats", "none")); if (n) confidence[cf] = n; }),
    ...SOURCES.map(async (src) => { const all = await count("sightings", (q) => q.eq("source", src).is("gone_at", null)); if (!all) return; const b = await count("sightings", (q) => q.eq("source", src).is("gone_at", null).eq("blr", true)); sources[src] = { all, blr: b }; }),
  ]);
  const control: Record<string, unknown> = {}; for (const r of ctl.data ?? []) control[r.key] = r.value;
  // recent ops results, in full
  const recent = (control.ops_recent as { ids?: string[] } | undefined)?.ids ?? [];
  if (recent.length) { const { data: ops } = await db.from("reader_control").select("key, value").in("key", recent.map((id) => `ops:${id}`)); control.ops = Object.fromEntries((ops ?? []).map((o) => [o.key.slice(4), o.value])); }
  for (const k of Object.keys(control)) if (k.startsWith("ops:") || k.startsWith("once:")) delete control[k];
  // links a fetch-only client can follow (it may only open URLs it has already seen)
  const base = new URL(c.req.url); const key = c.req.query("key") ?? ""; const self = `${base.protocol}//${base.host}/admin/r/${process.env.ADMIN_SECRET}`;
  const probeTargets: Record<string, string> = { infosys: "https://career.infosys.com/jobs?companyhiringtype=IL&countrycode=IN&location=Bangalore", tcs: "https://ibegin.tcs.com/iBegin/jobs/search", wipro: "https://careers.wipro.com/careers-home/jobs?location=Bengaluru", hcltech: "https://www.hcltech.com/careers/careers-in-india", ibm: "https://www.ibm.com/careers/search?field_keyword_18[0]=India", google: "https://www.google.com/about/careers/applications/jobs/results/?location=Bengaluru%2C%20Karnataka%2C%20India", microsoft: "https://jobs.careers.microsoft.com/global/en/search?lc=Bengaluru%2C%20Karnataka%2C%20India", flipkart: "https://www.flipkartcareers.com/#!/joblist", techmahindra: "https://careers.techmahindra.com/", goldman: "https://higher.gs.com/roles?LOCATION=Bengaluru", dell: "https://jobs.dell.com/en/search-jobs/Bengaluru", capgemini: "https://www.capgemini.com/in-en/careers/join-capgemini/job-search/?location=Bengaluru", sap: "https://jobs.sap.com", siemens: "https://jobs.siemens.com", ltimindtree: "https://careers.ltimindtree.com", oracle: "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions?keyword=Bengaluru" };
  void key;
  const links: Record<string, string> = { status: `${self}/status`, probe_result: `${self}/probe`, employers: `${self}/employers?limit=100`, sightings: `${self}/sightings?limit=50`, tier1: `${self}/run?step=tier1`, selftest: `${self}/run?step=selftest`, resolve20: `${self}/run?step=resolve&n=20`, enrich60: `${self}/run?step=enrich&n=60` };
  for (const [k, u] of Object.entries(probeTargets)) links[`probe_${k}`] = `${self}/run?step=probe&url=${encodeURIComponent(u)}`;
  return c.json({ employers: { total: employers, unresolved, resolved: employers - unresolved, with_feed: employers - unresolved - none, none, systems, confidence }, sightings: { total: sightings, live, blr, enriched, by_source: sources }, worker: control, links });
});

/** Employers with what we decided and why; filter by system. */
on.get("/reader/employers", async (c) => {
  let q = db.from("employers").select("name, ats, ats_ref, confidence, evidence, careers_url, openings, blr_openings, read_error, resolve_error, source").order("blr_openings", { ascending: false, nullsFirst: false }).limit(Number(c.req.query("limit") ?? 200));
  if (c.req.query("ats")) q = q.eq("ats", c.req.query("ats")!);
  const { data } = await q; return c.json(data ?? []);
});

/** A sample of live Bengaluru sightings, newest first; filter by source. */
on.get("/reader/sightings", async (c) => {
  let q = db.from("sightings").select("source, company_name, title, location, url, posted_at, posted_text, first_seen").is("gone_at", null).eq("blr", true).order("first_seen", { ascending: false }).limit(Number(c.req.query("limit") ?? 100));
  if (c.req.query("source")) q = q.eq("source", c.req.query("source")!);
  const { data } = await q; return c.json(data ?? []);
});
