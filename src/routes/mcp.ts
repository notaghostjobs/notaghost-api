// Ghosted's jobs, as tools an AI assistant can call (19 Nov). One small MCP server over the Reader's live inventory, for
// ChatGPT and Claude. It answers three things and nothing else:
//   search_jobs  — live Bengaluru roles for a title, from employers' own hiring systems, each with the employer's own link
//   get_job      — one of those roles in a little more detail, or the fact that the employer has since taken it down
//   about_radar  — what Ghosted Radar is and the page on notaghost.jobs where a person can read about it
//
// What it deliberately is not: it takes no résumé, knows no user, needs no sign-in and writes nothing about a person. It
// reads the same in-memory list Radar reads (routes/radar.ts livePool) and ranks titles with Radar's own title match, so
// there is one inventory and one matching rule. No new crawler, no new table.
//
// Transport: MCP "Streamable HTTP", stateless, JSON replies. POST /mcp/<client> with a JSON-RPC message; GET is 405
// (this server never pushes). <client> is "chatgpt" or "claude": it only decides the tag on links back to us, so a visit
// and a purchase that began in an assistant are attributed to it by the funnel we already have (lib/src.ts).
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../lib/db.js";
import { livePool, titleIdf, titleScore, words, fwords, TITLE_IN, type Sighting } from "./radar.js";
import { statedBand } from "../reader/experience.js";
import { realBand, bandFits } from "../radar/gates.js";
import { logEvent } from "../lib/src.js";

export const mcp = new Hono();

const VERSION = "0.1.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SITE = "https://notaghost.jobs";
type Client = "chatgpt" | "claude" | "mcp";
const clientOf = (c: Context): Client => { const p = c.req.param("client"); return p === "chatgpt" || p === "claude" ? p : "mcp"; };

// ---------------------------------------------------------------- the tools, as the assistant is told about them
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const JOB = { type: "object", properties: {
  job_id: { type: "integer", description: "Ghosted's id for this posting. Pass it to get_job." },
  title: { type: "string" }, company: { type: "string" }, location: { type: "string" },
  apply_url: { type: "string", description: "The posting on the employer's own hiring system." },
  on_employer_site_since: { type: "string", description: "Date Ghosted first saw it there (YYYY-MM-DD)." },
  last_confirmed: { type: "string", description: "Date Ghosted last confirmed it was still up (YYYY-MM-DD)." },
  experience_asked: { type: ["string", "null"], description: "Years of experience the posting states, when it states them." },
}, required: ["job_id", "title", "company", "apply_url"] } as const;
const TOOLS = [
  { name: "search_jobs", title: "Search live Bengaluru jobs",
    description: "Finds jobs that are open right now in Bengaluru, India, taken from employers' own hiring systems and re-checked by Ghosted. Search by job title or function (for example \"category manager\" or \"data analyst\"). Each result carries the employer's own posting link and the date it was last confirmed live. Only Bengaluru roles are covered. Does not use or need a résumé.",
    inputSchema: { type: "object", additionalProperties: false, required: ["role"], properties: {
      role: { type: "string", minLength: 2, maxLength: 80, description: "Job title or function to look for, in the words an employer would use, e.g. \"product manager\", \"backend engineer\", \"category manager\"." },
      years_experience: { type: "number", minimum: 0, maximum: 45, description: "Optional. The person's total years of work experience. Postings that state a band this falls well outside are left out." },
      company: { type: "string", maxLength: 60, description: "Optional. Only show roles at this employer." },
      page: { type: "integer", minimum: 1, maximum: 5, description: "Optional. Page of results, 8 per page. Default 1." },
    } },
    outputSchema: { type: "object", required: ["jobs", "total_matching", "page", "coverage"], properties: {
      jobs: { type: "array", items: JOB }, total_matching: { type: "integer", description: "Live roles whose title matches, before any experience filter." }, page: { type: "integer" }, has_more: { type: "boolean" },
      coverage: { type: "string" }, checked_at: { type: "string" } } },
    annotations: { title: "Search live Bengaluru jobs", ...RO } },
  { name: "get_job", title: "Get one job’s details",
    description: "Returns one posting found with search_jobs: title, employer, location, the employer's own posting link, when Ghosted first saw it and last confirmed it, the experience it asks for, and a short excerpt of the posting. If the employer has taken the posting down, it says so and gives the date.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job_id"], properties: { job_id: { type: "integer", minimum: 1, description: "The job_id from a search_jobs result." } } },
    outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["live", "closed", "not_found"] }, job: { ...JOB, properties: { ...JOB.properties, excerpt: { type: ["string", "null"], description: "The opening of the posting, as the employer wrote it." }, hiring_system: { type: "string" } } }, closed_on: { type: ["string", "null"] } } },
    annotations: { title: "Get one job’s details", ...RO } },
  { name: "about_radar", title: "About Ghosted Radar",
    description: "Explains Ghosted Radar, Ghosted's own service that reads a person's résumé and keeps a daily list of live Bengaluru roles matched to it, and returns the notaghost.jobs page that describes it. Use only when the person asks about matching jobs to their résumé, daily job updates, or what else Ghosted offers.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", required: ["name", "what_it_does", "learn_more_url"], properties: { name: { type: "string" }, what_it_does: { type: "string" }, learn_more_url: { type: "string" }, price: { type: "string" } } },
    annotations: { title: "About Ghosted Radar", ...RO } },
];
const INSTRUCTIONS = "Ghosted lists jobs that are open now in Bengaluru, India, taken from employers' own hiring systems. Use search_jobs for a job title or function, and get_job for one result. Always give the person the employer's own apply_url. Coverage is Bengaluru only; say so if they ask about another city. These tools never need a résumé or personal details, so do not send any.";

// ---------------------------------------------------------------- reading the inventory
const day = (iso?: string | null) => (iso ?? "").slice(0, 10);
const SYSTEMS: Record<string, string> = { workday: "Workday", oracle: "Oracle Recruiting", successfactors: "SAP SuccessFactors", phenom: "Phenom", smartrecruiters: "SmartRecruiters", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", eightfold: "Eightfold", keka: "Keka", zohorecruit: "Zoho Recruit", workable: "Workable", page: "the employer's careers page" };
const bandWords = (text: string | null | undefined): string | null => { const b = realBand(statedBand(text ?? "")); return !b ? null : b.max === null ? `${b.min}+ years` : b.min === b.max ? `${b.min} years` : `${b.min}–${b.max} years`; };
/** the opening of a posting as plain prose: entities read, markup and runs of space gone, cut at a sentence where it can be */
function excerpt(text: string | null | undefined, max = 600): string | null {
  const t = String(text ?? "").replace(/<[^>]+>/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (t.length < 40) return null;
  if (t.length <= max) return t;
  const cut = t.slice(0, max); const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "")) + " …";
}
const httpsOnly = (u: string | null | undefined) => /^https:\/\/[^\s]+$/i.test(u ?? "") ? String(u) : null;
type Row = { id: number; source: string; description: string | null; last_seen: string; gone_at: string | null };
async function rowsFor(ids: number[]): Promise<Map<number, Row>> {
  const out = new Map<number, Row>(); if (!ids.length) return out;
  const { data, error } = await db.from("sightings").select("id, source, description, last_seen, gone_at").in("id", ids);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Row[]) out.set(r.id, r);
  return out;
}
const PER_PAGE = 8;
const STALE_MS = 7 * 86400e3;   // a posting we have not been able to confirm for a week is not offered as live
const MAX_PAGES = 5;
const searchCache = new Map<string, { at: number; ids: number[]; total: number }>();
const normCo = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function searchJobs(a: { role: string; years_experience?: number; company?: string; page?: number }) {
  const want = fwords(a.role);
  if (!want.length) return { error: `“${a.role}” is too general to search on. Name the job itself, for example “category manager”, “data analyst” or “backend engineer”.` };
  const years = a.years_experience; const page = a.page ?? 1;
  const key = JSON.stringify([words(a.role), years ?? null, normCo(a.company ?? "")]);
  const pool = await livePool(); titleIdf(pool);
  let hit = searchCache.get(key);
  if (!hit || Date.now() - hit.at > 10 * 60e3) {
    // the level Radar's title match assumes: the words of the ask decide it, then the years
    const senior = /\b(head|director|vp|vice president|chief)\b/i.test(a.role), junior = /\b(intern|trainee|fresher|junior|graduate)\b/i.test(a.role);
    const level = senior ? "head" : junior || years === undefined || years < 4 ? "ic" : years >= 12 ? "head" : "manager";
    const co = normCo(a.company ?? "");
    const scored: { s: Sighting; sc: number }[] = [];
    for (const s of pool) {
      if (!httpsOnly(s.url) || !s.title) continue;
      if (co && !normCo(s.company_name ?? "").includes(co)) continue;
      const sc = titleScore(s.title, [words(a.role)], level, true);
      if (sc >= TITLE_IN) scored.push({ s, sc });
    }
    // closest title first, the newest among equals; no employer takes more than two places in any eight
    scored.sort((x, y) => (Math.round(y.sc * 20) - Math.round(x.sc * 20)) || y.s.first_seen.localeCompare(x.s.first_seen));
    let ids: number[] = []; const later: number[] = []; let per = new Map<string, number>();
    for (const x of scored) { const k = normCo(x.s.company_name ?? "") || String(x.s.id); const n = per.get(k) ?? 0; if (co || n < 2) { ids.push(x.s.id); per.set(k, n + 1); if (ids.length % PER_PAGE === 0) per = new Map(); } else later.push(x.s.id); }
    ids = [...ids, ...later];
    // the years a posting asks for are in its own text: read for the front of the list only, once, and a posting whose
    // stated band the person falls well outside is left out. One that states no band stays in.
    if (years !== undefined) {
      const front = ids.slice(0, PER_PAGE * MAX_PAGES * 2); const keep: number[] = [];
      for (let k = 0; k < front.length && keep.length < PER_PAGE * MAX_PAGES; k += 20) { const rows = await rowsFor(front.slice(k, k + 20)); for (const id of front.slice(k, k + 20)) { const band = realBand(statedBand(rows.get(id)?.description ?? "")); if (!band || bandFits(band, years)) keep.push(id); } }
      ids = keep;
    }
    hit = { at: Date.now(), ids: ids.slice(0, PER_PAGE * MAX_PAGES), total: scored.length };
    if (searchCache.size > 400) searchCache.clear();
    searchCache.set(key, hit);
  }
  const byId = new Map(pool.map((s) => [s.id, s]));
  const slice = hit.ids.slice((page - 1) * PER_PAGE, page * PER_PAGE); const rows = await rowsFor(slice);
  const jobs = slice.flatMap((id) => { const s = byId.get(id), r = rows.get(id); if (!s || !r || r.gone_at || Date.now() - Date.parse(r.last_seen) > STALE_MS) return [];   // not confirmed lately: not shown as open
    return [{ job_id: s.id, title: s.title, company: s.company_name ?? "", location: s.location ?? "Bengaluru", apply_url: s.url, on_employer_site_since: day(s.posted_at ?? s.first_seen), last_confirmed: day(r.last_seen), experience_asked: bandWords(r.description) }]; });
  return { jobs, total_matching: hit.total, page, has_more: page < MAX_PAGES && hit.ids.length > page * PER_PAGE, coverage: "Bengaluru, India. Roles on employers' own hiring systems that Ghosted checks; not every employer is covered.", checked_at: new Date().toISOString() };
}
async function getJob(id: number) {
  const { data, error } = await db.from("sightings").select("id, source, title, company_name, location, url, posted_at, first_seen, last_seen, gone_at, blr, description").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  const r = data as any;
  if (!r || !r.blr || !httpsOnly(r.url)) return { status: "not_found" as const };
  const job = { job_id: r.id, title: String(r.title ?? ""), company: r.company_name ?? "", location: r.location ?? "Bengaluru", apply_url: r.url, on_employer_site_since: day(r.posted_at ?? r.first_seen), last_confirmed: day(r.last_seen), experience_asked: bandWords(r.description), excerpt: excerpt(r.description), hiring_system: SYSTEMS[r.source] ?? "the employer's own hiring system" };
  return r.gone_at ? { status: "closed" as const, closed_on: day(r.gone_at), job } : { status: "live" as const, closed_on: null, job };
}
function aboutRadar(client: Client) {
  return { name: "Ghosted Radar", what_it_does: "Radar reads your résumé once and keeps a list of live Bengaluru roles that fit it, taken from employers' own hiring systems. Each morning it adds what opened and removes what closed, and tells you on WhatsApp. It is a paid service on notaghost.jobs; the jobs search here is free and does not need it.",
    learn_more_url: `${SITE}/app.html#/v2/radar?src=${client}`,
    // an assistant's own rules decide whether a price may be shown inside it: ChatGPT's do not allow it, so the page carries it there
    ...(client === "claude" ? { price: "₹2,499 for 30 days" } : {}) };
}

// ---------------------------------------------------------------- what the person reads
const line = (j: any, n: number) => `${n}. ${j.title} · ${j.company}\n   ${[j.location, j.experience_asked ? `asks ${j.experience_asked}` : null, j.last_confirmed ? `confirmed live ${j.last_confirmed}` : null].filter(Boolean).join(" · ")}\n   Apply on the employer's site: ${j.apply_url}\n   job_id ${j.job_id}`;
function say(tool: string, out: any): string {
  if (out.error) return out.error;
  if (tool === "search_jobs") return !out.jobs.length ? `No live Bengaluru role matched that on the employers Ghosted checks. Try the title an employer would use, or a broader one. (${out.coverage})`
    : `${out.total_matching} live Bengaluru ${out.total_matching === 1 ? "role has" : "roles have"} a matching title. Page ${out.page}:\n\n${out.jobs.map((j: any, k: number) => line(j, (out.page - 1) * PER_PAGE + k + 1)).join("\n\n")}\n\n${out.has_more ? "More are available on the next page. " : ""}${out.coverage}`;
  if (tool === "get_job") return out.status === "not_found" ? "No Bengaluru posting has that job_id. Use a job_id from search_jobs."
    : `${out.job.title} · ${out.job.company}\n${out.job.location}${out.job.experience_asked ? ` · asks ${out.job.experience_asked}` : ""}\n${out.status === "closed" ? `The employer took this posting down around ${out.closed_on}. It is no longer open.` : `On the employer's site since ${out.job.on_employer_site_since}; last confirmed live ${out.job.last_confirmed}.`}\n${out.status === "closed" ? "Posting (now closed)" : "Apply on the employer's site"}: ${out.job.apply_url}\nSource: ${out.job.hiring_system}${out.job.excerpt ? `\n\nFrom the posting: ${out.job.excerpt}` : ""}`;
  return `${out.name}: ${out.what_it_does}${out.price ? ` Price: ${out.price}.` : ""}\nRead about it: ${out.learn_more_url}`;
}

// ---------------------------------------------------------------- counting, with nothing about a person
// One row per tool call in the funnel's own table: which assistant, which tool, how many results, and the role searched
// (a job title, never free text about a person). Written in batches so a burst of searches is one small insert.
const pending: { client: Client; tool: string; n: number; role?: string }[] = [];
let flushing: ReturnType<typeof setTimeout> | null = null;
function count(client: Client, tool: string, n: number, role?: string) {
  if (pending.length < 500) pending.push({ client, tool, n, ...(role ? { role: words(role).slice(0, 6).join(" ").slice(0, 60) } : {}) });
  if (!flushing) flushing = setTimeout(async () => { flushing = null; const batch = pending.splice(0); for (const e of batch) await logEvent("mcp", { src: { first: e.client, last: e.client }, meta: { tool: e.tool, results: e.n, ...(e.role ? { role: e.role } : {}) } }); }, 30e3);
  if (flushing && typeof (flushing as any).unref === "function") (flushing as any).unref();
}
// a ceiling per caller and for everyone together: the list is in memory, but get_job and the years check read the database
const hits = new Map<string, { at: number; n: number }>(); let all = { at: 0, n: 0 };
function allowed(c: Context): boolean {
  const now = Date.now(); if (now - all.at > 60e3) all = { at: now, n: 0 }; if (++all.n > 1500) return false;
  const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || "ip";
  const h = hits.get(ip); if (!h || now - h.at > 60e3) { if (hits.size > 5000) hits.clear(); hits.set(ip, { at: now, n: 1 }); return true; }
  return ++h.n <= 300;
}

// ---------------------------------------------------------------- the protocol
const searchArgs = z.object({ role: z.string().trim().min(2).max(80), years_experience: z.number().min(0).max(45).optional(), company: z.string().trim().max(60).optional(), page: z.number().int().min(1).max(5).optional() }).strict();
const jobArgs = z.object({ job_id: z.number().int().min(1) }).strict();
type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const toolResult = (tool: string, out: any) => ({ content: [{ type: "text", text: say(tool, out) }], ...(out.error ? { isError: true } : { structuredContent: out }) });

async function handle(c: Context, m: Rpc): Promise<object | null> {
  const client = clientOf(c);
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(m?.id, -32600, "Not a JSON-RPC 2.0 request.");
  const note = m.id === undefined;   // a notification gets no reply
  switch (m.method) {
    case "initialize": { const asked = String(m.params?.protocolVersion ?? ""); return ok(m.id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ghosted-jobs", title: "Ghosted", version: VERSION, websiteUrl: SITE }, instructions: INSTRUCTIONS }); }
    case "ping": return ok(m.id, {});
    case "tools/list": return ok(m.id, { tools: TOOLS });
    case "resources/list": return ok(m.id, { resources: [] });
    case "resources/templates/list": return ok(m.id, { resourceTemplates: [] });
    case "prompts/list": return ok(m.id, { prompts: [] });
    case "tools/call": {
      const name = String(m.params?.name ?? ""); const args = m.params?.arguments ?? {};
      if (!TOOLS.some((t) => t.name === name)) return fail(m.id, -32602, `Unknown tool: ${name}`);
      if (!allowed(c)) return ok(m.id, toolResult(name, { error: "Ghosted is getting a lot of requests right now. Try again in a minute." }));
      try {
        if (name === "search_jobs") { const a = searchArgs.safeParse(args); if (!a.success) return ok(m.id, toolResult(name, { error: "search_jobs needs a role (a job title or function, 2 to 80 characters). years_experience is a number, company is a name, page is 1 to 5." })); const out: any = await searchJobs(a.data); count(client, name, out.jobs?.length ?? 0, a.data.role); return ok(m.id, toolResult(name, out)); }
        if (name === "get_job") { const a = jobArgs.safeParse(args); if (!a.success) return ok(m.id, toolResult(name, { error: "get_job needs job_id, the whole number from a search_jobs result." })); const out = await getJob(a.data.job_id); count(client, name, out.status === "not_found" ? 0 : 1); return ok(m.id, toolResult(name, out)); }
        count(client, name, 1); return ok(m.id, toolResult(name, aboutRadar(client)));
      } catch (e: any) { console.error("[mcp]", name, e?.message ?? e); return ok(m.id, toolResult(name, { error: "Ghosted couldn’t read its job list just now. Try again in a moment." })); }
    }
    default: return note ? null : fail(m.id, -32601, `Method not found: ${m.method}`);
  }
}
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id", "access-control-max-age": "86400" };
async function post(c: Context) {
  let body: unknown; try { body = await c.req.json(); } catch { return c.json(fail(null, -32700, "The body is not JSON."), 400, CORS); }
  if (Array.isArray(body)) { if (!body.length || body.length > 20) return c.json(fail(null, -32600, "A batch holds 1 to 20 messages."), 400, CORS); const out = (await Promise.all(body.map((m) => handle(c, m as Rpc)))).filter(Boolean); return out.length ? c.json(out, 200, CORS) : c.body(null, 202, CORS); }
  const out = await handle(c, body as Rpc);
  return out ? c.json(out, 200, CORS) : c.body(null, 202, CORS);
}
const no = (c: Context) => c.json(fail(null, -32000, "This server answers POST only."), 405, { ...CORS, allow: "POST, OPTIONS" });
for (const path of ["/", "/:client"]) { mcp.post(path, post); mcp.options(path, (c) => c.body(null, 204, CORS)); mcp.get(path, no); mcp.delete(path, no); }

/** OpenAI checks that we control this host by reading a token it issues, served here as plain text and nothing else. */
export const openaiChallenge = (c: Context) => { const t = (process.env.OPENAI_APPS_CHALLENGE ?? "").trim(); return t ? c.text(t) : c.text("", 404); };
