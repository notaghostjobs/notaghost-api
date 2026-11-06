import { Hono } from "hono";
import { audit } from "./audit.js";
import { funnel } from "./funnel.js";
import { env } from "../lib/env.js";
import { waTrace, whatsapp as waRoutes } from "./whatsapp.js";
import { db } from "../lib/db.js";
import { selftest } from "./selftest.js";
import { snapshotDue } from "../engine/ghost/index.js";
import { companyKey } from "../engine/ghost/canon.js";
import { fetchPosting } from "../engine/extract.js";
import { asUrl } from "../engine/ghost/canon.js";
import { createHash } from "node:crypto";
import { parsePosting } from "../engine/sharpen.js";

export const admin = new Hono();
// every /reader/<x> route is also served at /r/<secret>/<x>
import type { Context } from "hono";
type H = (c: Context) => Response | Promise<Response>;
const both = (method: "get" | "post") => (path: string, h: H) => { (admin as any)[method](path, h); if (path.startsWith("/reader/")) (admin as any)[method](path.replace("/reader/", "/r/:secret/"), h); return admin; };
const on = { get: both("get"), post: both("post") };
// the secret may come as a header, a ?key= query, or a path segment (/admin/r/<secret>/...) for fetch tools that refuse key-bearing queries
// AUDIT_SECRET is a second, read-only key: it opens GET endpoints only (stats, postings, employers, sightings), never anything that writes or runs the reader
const READ_ONLY = /^\/admin\/(postings|unreadable|diag\/posting|payments|previews|shots|funnel|audit\/signals|whatsapp(\/status|\/templates)?|sharpen\/selftest(\/result)?|reader\/(stats|status|probe|employers|sightings))$/;
admin.use("*", async (c, next) => {
  const fromPath = c.req.path.match(/\/admin\/r\/([^/]+)\//)?.[1];
  const k = c.req.header("x-admin") ?? c.req.query("key") ?? fromPath;
  const full = !!process.env.ADMIN_SECRET && k === process.env.ADMIN_SECRET;
  const audit = !!process.env.AUDIT_SECRET && k === process.env.AUDIT_SECRET && c.req.method === "GET" && READ_ONLY.test(c.req.path);
  if (!full && !audit) return c.json({ error: "no" }, 403);
  await next();
});

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
  const SYSTEMS = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "successfactors", "amazon", "google", "ibm", "microsoft", "goldman", "eightfold", "phenom", "oracle", "keka", "darwinbox", "page", "none"];
  const SOURCES = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "successfactors", "amazon", "google", "ibm", "microsoft", "goldman", "eightfold", "phenom", "oracle", "keka", "darwinbox", "page", "naukri", "linkedin"];
  const systems: Record<string, number> = {}, confidence: Record<string, number> = {}, sources: Record<string, { all: number; blr: number }> = {};
  await Promise.all([
    ...SYSTEMS.map(async (sys) => { const n = await count("employers", (q) => q.eq("ats", sys)); if (n) systems[sys] = n; }),
    ...["link", "page", "search", "guess"].map(async (cf) => { const n = await count("employers", (q) => q.eq("confidence", cf).neq("ats", "none")); if (n) confidence[cf] = n; }),
    ...SOURCES.map(async (src) => { const all = await count("sightings", (q) => q.eq("source", src).is("gone_at", null)); if (!all) return; const b = await count("sightings", (q) => q.eq("source", src).is("gone_at", null).eq("blr", true)); sources[src] = { all, blr: b }; }),
  ]);
  // enrichment, honestly: opened and read / opened and failed (why) / not opened yet — all over live Bengaluru rows
  const liveBlr = (q: any) => q.is("gone_at", null).eq("blr", true);
  const reasons: Record<string, string> = { "robots.txt": "disallowed by robots.txt%", "not readable without a browser": "page has no readable text%", "HTTP 403": "HTTP 403", "HTTP 404": "HTTP 404", "other HTTP": "HTTP %", "no response": "fetch failed%" };
  const failed_by_reason: Record<string, number> = {}, failed_by_source: Record<string, number> = {};
  const [failed, pending] = await Promise.all([
    count("sightings", (q) => liveBlr(q).not("enriched_at", "is", null).is("description", null)),
    count("sightings", (q) => liveBlr(q).is("enriched_at", null).not("url", "is", null)),
    ...Object.entries(reasons).map(async ([label, pat]) => { const n = await count("sightings", (q) => liveBlr(q).is("description", null).like("enrich_error", pat)); if (n) failed_by_reason[label] = n; }),
    ...SOURCES.map(async (src) => { const n = await count("sightings", (q) => liveBlr(q).eq("source", src).not("enriched_at", "is", null).is("description", null)); if (n) failed_by_source[src] = n; }),
  ]);
  if (failed_by_reason["other HTTP"]) failed_by_reason["other HTTP"] -= (failed_by_reason["HTTP 403"] ?? 0) + (failed_by_reason["HTTP 404"] ?? 0);
  if (!failed_by_reason["other HTTP"]) delete failed_by_reason["other HTTP"];
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
  return c.json({ employers: { total: employers, unresolved, resolved: employers - unresolved, with_feed: employers - unresolved - none, none, systems, confidence }, sightings: { total: sightings, live, blr, enriched, by_source: sources, enrich: { done: enriched, failed, pending, failed_by_reason, failed_by_source } }, worker: control, links });
});

/** Employers with what we decided and why; filter by system. */
on.get("/reader/employers", async (c) => {
  let q = db.from("employers").select("name, ats, ats_ref, confidence, evidence, careers_url, openings, blr_openings, read_error, resolve_error, source").order("blr_openings", { ascending: false, nullsFirst: false }).limit(Number(c.req.query("limit") ?? 200));
  if (c.req.query("ats")) q = q.eq("ats", c.req.query("ats")!);
  if (c.req.query("q")) q = q.ilike("name", `%${c.req.query("q")}%`);
  const { data } = await q; return c.json(data ?? []);
});

/** Every scored posting since a time, for audits: verdict, score, signals, company, title, what was read. */
on.get("/postings", async (c) => {
  const since = c.req.query("since") ?? new Date(Date.now() - 86400e3).toISOString();
  let q = db.from("postings").select("id, job_key, source, company, title, url, score, verdict, signals, scored_at, checks, closed_at, sighting_source, sighting_id, system_first_seen, raw_text, first_seen_at")
    .not("scored_at", "is", null).gte("scored_at", since).order("scored_at", { ascending: false }).limit(Number(c.req.query("limit") ?? 500));
  if (c.req.query("source")) q = q.eq("source", c.req.query("source")!);
  if (c.req.query("verdict")) q = q.eq("verdict", c.req.query("verdict")!);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  const full = c.req.query("text") === "1";
  return c.json((data ?? []).map((p) => ({ ...p, raw_chars: p.raw_text?.length ?? 0, raw_text: full ? p.raw_text : undefined })));
});

/** A sample of live Bengaluru sightings, newest first; filter by source. */
on.get("/reader/sightings", async (c) => {
  let q = db.from("sightings").select("source, company_name, title, location, url, posted_at, posted_text, first_seen").is("gone_at", null).eq("blr", true).order("first_seen", { ascending: false }).limit(Number(c.req.query("limit") ?? 100));
  if (c.req.query("source")) q = q.eq("source", c.req.query("source")!);
  if (c.req.query("q")) q = q.or(`company_name.ilike.%${c.req.query("q")}%,title.ilike.%${c.req.query("q")}%`);
  const { data } = await q; return c.json(data ?? []);
});

/** Read-only diagnostic: what the Sharpen path reads and parses for a posting link, step by step (no DB writes). */
admin.get("/diag/posting", async (c) => {
  const url = c.req.query("url"); if (!url) return c.json({ error: "url" }, 400);
  const out: any = { url };
  const t0 = Date.now();
  // exactly what POST /preview sees for this link: the row by url_hash and its stored parse
  try {
    const canon = asUrl(url); const url_hash = createHash("sha256").update(canon.trim().toLowerCase()).digest("hex");
    const { data: row } = await db.from("postings").select("id, raw_text, parsed, created_at").eq("url_hash", url_hash).maybeSingle();
    out.preview_row = row ? { id: row.id, created_at: row.created_at, raw_len: (row.raw_text ?? "").length, parsed_must: row.parsed?.must_have?.length ?? null, parsed_nice: row.parsed?.nice_to_have?.length ?? null, parsed_title: row.parsed?.title ?? null } : null;
    out.canonical = canon;
  } catch (e) { out.preview_row = { error: (e as Error).message }; }
  try { const cached = await fetchPosting(url); out.cached = { len: cached.length, head: cached.slice(0, 240) }; } catch (e) { out.cached = { error: (e as Error).message }; }
  try { const fresh = await fetchPosting(url, { bypassCache: true }); out.fresh = { len: fresh.length, head: fresh.slice(0, 240) };
    const p = await parsePosting(fresh); out.parsed = { title: p.title, company: p.company, must: p.must_have?.length ?? 0, nice: p.nice_to_have?.length ?? 0, sample: (p.must_have ?? []).slice(0, 3) };
  } catch (e) { out.fresh = { ...(out.fresh ?? {}), error: (e as Error).message }; }
  out.ms = Date.now() - t0;
  return c.json(out);
});

/** The last pages the reader refused as unreadable: what the extension sent, and what was left after furniture stripping. */
admin.get("/unreadable", async (c) => {
  const { data } = await db.from("reader_control").select("key,value,updated_at").or("key.like.unreadable:%,key.like.sharpen_fail:%").order("updated_at", { ascending: false }).limit(40);
  return c.json(data ?? []);
});

/** The last payments and plans, for checking a test or live payment end to end (no card data is ever stored). */
admin.get("/payments", async (c) => {
  const { data: pays } = await db.from("payments").select("id, user_id, product, amount_paise, status, razorpay_order_id, razorpay_payment_id, created_at, paid_at").order("created_at", { ascending: false }).limit(10);
  const { data: plans } = await db.from("plans").select("id, user_id, product, shots_total, shots_used, expires_at, created_at").order("created_at", { ascending: false }).limit(10);
  return c.json({ payments: (pays ?? []).map((p: any) => ({ ...p, user_id: String(p.user_id).slice(0, 8) })), plans: (plans ?? []).map((p: any) => ({ ...p, user_id: String(p.user_id).slice(0, 8) })) });
});

admin.route("/sharpen/selftest", selftest);

/** The last previews: the matched list with the auditor's verdict on each proposed line. For tuning the audit; no résumé text beyond the quoted evidence. */
/** The last shots, as an audit reads them: the three numbers, what was owed and whether each owed line is in the document, what the verifier and the rules said, where the time went. No document text. */
/** Read-only: what Meta says about our number and the app's webhook subscription — the first place to look when messages don't arrive. */
admin.route("/audit", audit);
admin.route("/funnel", funnel);

admin.get("/whatsapp/templates", (c) => waRoutes.request(new Request(new URL("/templates", c.req.url), { headers: c.req.raw.headers })));
admin.post("/whatsapp/templates", (c) => waRoutes.request(new Request(new URL("/templates", c.req.url), { method: "POST", headers: c.req.raw.headers })));

admin.get("/whatsapp/status", async (c) => {
  const H = { authorization: `Bearer ${env.waToken}` };
  const get = async (p: string) => { try { const r = await fetch(`https://graph.facebook.com/v21.0/${p}`, { headers: H }); return { status: r.status, body: await r.json() }; } catch (e) { return { error: String(e) }; } };
  const [phone, subs, waba] = await Promise.all([
    get(`${env.waPhoneId}?fields=display_phone_number,verified_name,quality_rating,platform_type,status,name_status,code_verification_status,is_official_business_account,account_mode,webhook_configuration`),
    get(`${c.req.query("waba") ?? "1137231462108125"}/subscribed_apps`),
    get(`${c.req.query("waba") ?? "1137231462108125"}?fields=name,account_review_status,business_verification_status,message_template_namespace,ownership_type`),
  ]);
  // the WABA the number actually belongs to, from the business side (the "messaging account id" on the console is not always it)
  // which WABAs can this token see at all? (debug_token lists the granular scopes with their target ids)
  const dbg = await get(`debug_token?input_token=${encodeURIComponent(env.waToken)}`);
  const scopes = (dbg as any)?.body?.data?.granular_scopes ?? [];
  const wabaIds: string[] = Array.from(new Set(scopes.flatMap((g: any) => g.target_ids ?? [])));
  const perWaba = await Promise.all(wabaIds.map(async (id) => ({ id, info: await get(`${id}?fields=id,name,account_review_status`), subscribed_apps: await get(`${id}/subscribed_apps`), phones: await get(`${id}/phone_numbers?fields=id,display_phone_number,status`) })));
  return c.json({ phone, subscribed_apps: subs, waba, token_scopes: scopes, wabas: perWaba });
});

admin.get("/whatsapp", (c) => c.json({ configured: { token: !!env.waToken, phone_id: !!env.waPhoneId, verify: !!env.waVerifyToken, app_secret: !!env.waAppSecret }, trace: waTrace }));

admin.get("/shots", async (c) => {
  const { data } = await db.from("shots").select("id, created_at, done_at, status, error, output").order("created_at", { ascending: false }).limit(Number(c.req.query("limit") ?? 3));
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return c.json((data ?? []).map((s: any) => {
    const o = s.output ?? {};
    const doc = o.rewrite ? norm(JSON.stringify({ h: o.rewrite.headline, s: o.rewrite.summary, r: o.rewrite.relevant, roles: o.rewrite.roles, sk: o.rewrite.skills, x: o.rewrite.extra_sections })) : "";
    const owed = (o.matches ?? []).filter((m: any) => m.bucket === "have_not_said" && m.sayable && m.line);
    return { id: s.id, at: s.created_at, status: s.status, error: s.error, before: o.before, promised: o.promised, after: o.after, repeat: o.repeat, timing: o.timing,
      owed: owed.map((m: any) => { const core = norm(m.line).split(" ").slice(0, 10).join(" "); const now = (o.after_matches ?? []).find((x: any) => x.requirement === m.requirement); return { req: String(m.requirement).slice(0, 80), told: !!m.told, in_doc: !!doc && doc.includes(core), counted: now?.bucket === "said", line: String(m.line).slice(0, 140) }; }),
      problems: o.verification?.problems, broken: o.broken, needs_review: o.needs_review };
  }));
});

admin.get("/previews", async (c) => {
  const { data } = await db.from("previews").select("id, created_at, posting_id, score_before, score_after, matches").order("created_at", { ascending: false }).limit(Number(c.req.query("limit") ?? 5));
  return c.json((data ?? []).map((p: any) => ({ id: p.id, at: p.created_at, before: p.score_before, promised: p.score_after,
    lines: (p.matches ?? []).map((m: any) => ({ bucket: m.bucket, kind: m.kind, req: String(m.requirement).slice(0, 90), ev: String(m.evidence ?? "").slice(0, 120), line: String(m.line ?? "").slice(0, 160), sayable: m.sayable, why: m.vet_reason })) })));
});
