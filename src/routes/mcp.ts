// Ghosted's jobs, as tools an AI assistant can call (19 Nov). One small MCP server over the Reader's live inventory, for
// ChatGPT and Claude. It answers three things and nothing else:
//   search_jobs  — live Bengaluru roles for a title, from employers' own hiring systems, each with the employer's own link
//   get_job      — one of those roles in a little more detail, or the fact that the employer has since taken it down
//   about_radar  — what Ghosted Radar is and the page on notaghost.jobs where a person can read about it
// and, for Ghosted Open (hiring through one real question), three more:
//   list_open_questions / get_open_question — the questions employers have posted, and the anonymous answers so far
//   about_open   — for an employer: what Open is and the page where a question is posted
// Open's tools read through Open's own public routes (routes/open.ts), so they show exactly what its public pages show.
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
import { realBand, bandFits, cityGate } from "../radar/gates.js";
import { logEvent } from "../lib/src.js";
import { openPublic } from "./open.js";

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
    description: "Returns one posting found with search_jobs: title, employer, location, the employer's own posting link, when Ghosted first saw it and last confirmed it, the experience it asks for, and which hiring system it is on. The posting's own text is not reproduced: the link goes to it. If the employer has taken the posting down, it says so and gives the date.",
    inputSchema: { type: "object", additionalProperties: false, required: ["job_id"], properties: { job_id: { type: "integer", minimum: 1, description: "The job_id from a search_jobs result." } } },
    outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["live", "closed", "not_found"] }, job: { ...JOB, properties: { ...JOB.properties, hiring_system: { type: "string" } } }, closed_on: { type: ["string", "null"] } } },
    annotations: { title: "Get one job’s details", ...RO } },
  { name: "about_radar", title: "About Ghosted Radar",
    description: "Explains Ghosted Radar, Ghosted's own service that reads a person's résumé and keeps a daily list of live Bengaluru roles matched to it, and returns the notaghost.jobs page that describes it. Use only when the person asks about matching jobs to their résumé, daily job updates, or what else Ghosted offers.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", required: ["name", "what_it_does", "learn_more_url"], properties: { name: { type: "string" }, what_it_does: { type: "string" }, learn_more_url: { type: "string" }, price: { type: "string" } } },
    annotations: { title: "About Ghosted Radar", ...RO } },
  { name: "list_open_questions", title: "List hiring questions on Ghosted Open",
    description: "Lists roles on Ghosted Open, where a verified employer hires by posting one real question from the job instead of asking for applications. A job seeker answers the question without their name, and the employer learns who they are only if both agree to talk. Returns each open role with its employer, pay band, experience asked, the question itself and the page where it can be answered. Use when someone is looking for jobs, wants to be considered without a résumé screen, or asks which companies are hiring this way.",
    inputSchema: { type: "object", additionalProperties: false, properties: { role: { type: "string", maxLength: 80, description: "Optional. A job title or function to narrow the list, e.g. \"operations\" or \"product manager\"." } } },
    outputSchema: { type: "object", required: ["questions", "total_open"], properties: { total_open: { type: "integer" }, questions: { type: "array", items: { type: "object", required: ["question_id", "company", "role", "question", "answer_url"], properties: {
      question_id: { type: "string" }, company: { type: "string" }, role: { type: "string" }, pay_band: { type: "string" }, experience_asked: { type: "string" }, location: { type: "string" }, question: { type: "string" }, answers_so_far: { type: "integer" }, open_until: { type: "string" }, answer_url: { type: "string", description: "The question's page on notaghost.jobs, where it is answered." } } } } } },
    annotations: { title: "List hiring questions on Ghosted Open", ...RO } },
  { name: "get_open_question", title: "Get one hiring question and its answers",
    description: "Returns one Ghosted Open question found with list_open_questions: the employer, role, pay band, the question, and the answers given so far. Answers are anonymous: each shows only what its writer does and for how long. If the role has closed, it says how it ended.",
    inputSchema: { type: "object", additionalProperties: false, required: ["question_id"], properties: { question_id: { type: "string", pattern: "^[a-f0-9]{6,16}$", description: "The question_id from list_open_questions." } } },
    outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["open", "closed", "not_found"] }, question: { type: "object" }, answers: { type: "array", items: { type: "object", properties: { candidate: { type: "string" }, background: { type: "string" }, answer: { type: "string" } } } }, outcome: { type: ["string", "null"] } } },
    annotations: { title: "Get one hiring question and its answers", ...RO } },
  { name: "about_open", title: "About Ghosted Open, for employers",
    description: "Explains Ghosted Open to someone who is hiring: an employer verifies their company, posts one real question from the job, reads anonymous answers, and is introduced only to the people they choose who also agree. Returns the notaghost.jobs page where a question is posted. Use when someone asks how to hire, shortlist or find candidates in Bengaluru or India without screening résumés.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", required: ["name", "how_it_works", "post_url"], properties: { name: { type: "string" }, how_it_works: { type: "array", items: { type: "string" } }, post_url: { type: "string" }, price: { type: "string" } } },
    annotations: { title: "About Ghosted Open, for employers", ...RO } },
];
const INSTRUCTIONS = "Ghosted has two things. For job seekers: jobs open now in Bengaluru, India, taken from employers' own hiring systems (search_jobs, then get_job; always give the person the employer's own apply_url), and Ghosted Open, where employers hire by asking one real question that is answered without a name (list_open_questions, get_open_question). For employers: about_open explains how to post such a question. Job coverage is Bengaluru only; say so if someone asks about another city. These tools never need a résumé or personal details, so do not send any.";

// ---------------------------------------------------------------- reading the inventory
const day = (iso?: string | null) => (iso ?? "").slice(0, 10);
const SYSTEMS: Record<string, string> = { workday: "Workday", oracle: "Oracle Recruiting", successfactors: "SAP SuccessFactors", phenom: "Phenom", smartrecruiters: "SmartRecruiters", greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", eightfold: "Eightfold", keka: "Keka", zohorecruit: "Zoho Recruit", workable: "Workable", page: "the employer's careers page" };
const bandWords = (text: string | null | undefined): string | null => { const b = realBand(statedBand(text ?? "")); return !b ? null : b.max === null ? `${b.min}+ years` : b.min === b.max ? `${b.min} years` : `${b.min}–${b.max} years`; };
const httpsOnly = (u: string | null | undefined) => /^https:\/\/[^\s]+$/i.test(u ?? "") ? String(u) : null;
type Row = { id: number; source: string; description: string | null; last_seen: string; gone_at: string | null };
async function rowsFor(ids: number[]): Promise<Map<number, Row>> {
  const out = new Map<number, Row>(); if (!ids.length) return out;
  const { data, error } = await db.from("sightings").select("id, source, description, last_seen, gone_at").in("id", ids);
  if (error) throw new Error(error.message);
  for (const r of (data ?? []) as Row[]) out.set(r.id, r);
  return out;
}
// Radar's live list takes several seconds to load from cold, which is too long for someone waiting in a chat. So this
// server answers from the copy it last had and asks for a fresh one behind the answer; only the very first call waits.
let mine: { at: number; rows: Sighting[] } | null = null; let refreshing = false;
/** A title as a person would read it. Some careers pages hand us the title with the page's own furniture glued on
 *  ("Category Manager - CopyBusiness•Bangalore/ Apply now"): everything from the bullet on, and a trailing "Apply now", go. */
export const tidyTitle = (t: string) => String(t ?? "").replace(/\s*[•·|]\s*[^•·|]*$/u, (m) => /apply now|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai|gurugram|gurgaon|noida|kolkata|remote|india/i.test(m) ? "" : m).replace(/[\s/,-]*apply now\s*$/i, "").replace(/\s+/g, " ").trim();
/** What may be shown to the public as open in Bengaluru: an https link on the employer's own system, a title that does
 *  not name another city, and (when we know it) a confirmation within the last week. */
const shown = (rows: Sighting[]): Sighting[] => { const out: Sighting[] = []; const now = Date.now();
  for (const r of rows) { if (!r.title || !/^https:\/\/[^\s]+$/i.test(r.url ?? "")) continue; if (cityGate(r.title)) continue; if (r.last_seen && now - Date.parse(r.last_seen) > 7 * 86400e3) continue; const title = tidyTitle(r.title); if (title.length < 3) continue; out.push(title === r.title ? r : { ...r, title }); }
  return out; };
export async function jobPool(): Promise<Sighting[]> {
  if (!mine) { mine = { at: Date.now(), rows: shown(await livePool()) }; return mine.rows; }
  if (Date.now() - mine.at > 30 * 60e3 && !refreshing) { refreshing = true; void livePool().then((rows) => { mine = { at: Date.now(), rows: shown(rows) }; }).catch((e) => console.error("[mcp] pool", e?.message ?? e)).finally(() => { refreshing = false; }); }
  return mine.rows;
}
/** called once after boot, so the first person to search does not pay for the load */
export const warmJobs = () => { void jobPool().catch(() => { /* the first search will try again */ }); };
const st = (w: string) => w.replace(/ies$/, "y").replace(/(ing|ers?|s)$/, "");
/** "2 Locations (Bengaluru facet)" is the hiring system's own shorthand; a person reads it as one of several places */
const place = (loc: string | null | undefined) => { const l = String(loc ?? "").trim(); const m = /^(\d+) Locations? \(Bengaluru facet\)$/i.exec(l); return m ? `Bengaluru (one of ${m[1]} locations)` : l || "Bengaluru"; };
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
  const pool = await jobPool(); titleIdf(pool);
  let hit = searchCache.get(key);
  if (!hit || Date.now() - hit.at > 10 * 60e3) {
    // the level Radar's title match assumes: the words of the ask decide it, then the years
    const senior = /\b(head|director|vp|vice president|chief)\b/i.test(a.role), junior = /\b(intern|trainee|fresher|junior|graduate)\b/i.test(a.role);
    const level = senior ? "head" : junior || years === undefined || years < 4 ? "ic" : years >= 12 ? "head" : "manager";
    const co = normCo(a.company ?? "");
    const scored: { s: Sighting; sc: number }[] = [];
    // Radar's match decides who is in. Among those, the title that says the asked-for words themselves comes first:
    // "Category Manager" before "Category Buyer" for someone who asked for a category manager.
    const asked = words(a.role).map(st); const phrase = ` ${asked.join(" ")} `;
    for (const s of pool) {
      if (!httpsOnly(s.url) || !s.title) continue;
      if (co && !normCo(s.company_name ?? "").includes(co)) continue;
      const base = titleScore(s.title, [words(a.role)], level, true);
      if (base < TITLE_IN) continue;
      const tw = words(s.title).map(st); const line = ` ${tw.join(" ")} `;
      const sc = base + (line.includes(phrase) ? 1 : asked.every((w) => tw.includes(w)) ? 0.6 : 0);
      scored.push({ s, sc });
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
    return [{ job_id: s.id, title: s.title, company: s.company_name ?? "", location: place(s.location), apply_url: s.url, on_employer_site_since: day(s.posted_at ?? s.first_seen), last_confirmed: day(r.last_seen), experience_asked: bandWords(r.description) }]; });
  return { jobs, total_matching: hit.total, page, has_more: page < MAX_PAGES && hit.ids.length > page * PER_PAGE, coverage: "Bengaluru, India. Roles on employers' own hiring systems that Ghosted checks; not every employer is covered.", checked_at: new Date().toISOString() };
}
async function getJob(id: number) {
  const { data, error } = await db.from("sightings").select("id, source, title, company_name, location, url, posted_at, first_seen, last_seen, gone_at, blr, description").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  const r = data as any;
  if (!r || !r.blr || !httpsOnly(r.url)) return { status: "not_found" as const };
  const job = { job_id: r.id, title: tidyTitle(String(r.title ?? "")), company: r.company_name ?? "", location: place(r.location), apply_url: r.url, on_employer_site_since: day(r.posted_at ?? r.first_seen), last_confirmed: day(r.last_seen), experience_asked: bandWords(r.description), hiring_system: SYSTEMS[r.source] ?? "the employer's own hiring system" };
  return r.gone_at ? { status: "closed" as const, closed_on: day(r.gone_at), job } : { status: "live" as const, closed_on: null, job };
}
function aboutRadar(client: Client) {
  return { name: "Ghosted Radar", what_it_does: "Radar reads your résumé once and keeps a list of live Bengaluru roles that fit it, taken from employers' own hiring systems. Each morning it adds what opened and removes what closed, and tells you on WhatsApp. It is a paid service on notaghost.jobs; the jobs search here is free and does not need it.",
    learn_more_url: `${SITE}/app.html#/v2/radar?src=${client}`,
    // an assistant's own rules decide whether a price may be shown inside it: ChatGPT's do not allow it, so the page carries it there
    ...(client === "claude" ? { price: "₹2,499 for 30 days" } : {}) };
}

// ---------------------------------------------------------------- Ghosted Open, through its own public routes
const openGet = async (path: string): Promise<{ s: number; j: any }> => { const r = await openPublic.request(path); return { s: r.status, j: await r.json().catch(() => ({})) }; };
const clip = (t: string, max: number) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length <= max ? x : x.slice(0, max).replace(/\s+\S*$/, "") + " …"; };
const openUrl = (client: Client, hash: string) => `${SITE}/app.html?src=${client}#${hash}`;
const openQ = (client: Client, q: any) => ({ question_id: q.id, company: q.company, role: q.title, pay_band: q.pay, experience_asked: `${q.exp_min}–${q.exp_max} years`, location: q.location, question: q.question, answers_so_far: q.answers ?? 0, open_until: day(q.closes), answer_url: openUrl(client, `/v2/open/q/${q.id}`) });
async function listOpen(client: Client, role?: string) {
  const { j } = await openGet("/live"); const all: any[] = j.questions ?? [];
  const want = role ? fwords(role) : [];
  const qs = !want.length ? all : all.filter((q) => { const have = new Set(fwords(`${q.title} ${q.question}`)); return want.some((w) => have.has(w)); });
  return { total_open: all.length, questions: qs.slice(0, 12).map((q) => openQ(client, q)) };
}
async function getOpen(client: Client, id: string) {
  const { s, j } = await openGet(`/q/${id}`);
  if (s !== 200 || !j.question) return { status: "not_found" as const };
  const answers = (j.answers ?? []).slice(0, 10).map((a: any) => ({ candidate: `Candidate ${a.n}`, background: [a.label, a.fit_label].filter(Boolean).join(" · "), answer: clip(a.text, 700) }));
  const closed = j.question.status !== "live";
  return { status: closed ? "closed" as const : "open" as const, question: openQ(client, j.question), answers, outcome: closed ? (j.closed?.outcome === "hired" ? "An offer was made." : "Closed without a hire.") : null };
}
function aboutOpen(client: Client) {
  return { name: "Ghosted Open", how_it_works: ["Verify your company with a code sent to your work email.", "Post the role, its pay band and one real question from the job.", "Read the answers without names or résumés. Each shows how close that person's experience is to the role.", "Ask one follow-up, then invite the people you want to talk to. You are introduced only to those who accept."],
    post_url: openUrl(client, "/v2/open/post"),
    ...(client === "claude" ? { price: "Posting is free. ₹499 per candidate, only when a candidate you invite agrees to talk." } : {}) };
}

// ---------------------------------------------------------------- what the person reads
const line = (j: any, n: number) => `${n}. ${j.title} · ${j.company}\n   ${[j.location, j.experience_asked ? `asks ${j.experience_asked}` : null, j.last_confirmed ? `confirmed live ${j.last_confirmed}` : null].filter(Boolean).join(" · ")}\n   Apply on the employer's site: ${j.apply_url}\n   job_id ${j.job_id}`;
function say(tool: string, out: any): string {
  if (out.error) return out.error;
  if (tool === "search_jobs") return !out.jobs.length ? `No live Bengaluru role matched that on the employers Ghosted checks. Try the title an employer would use, or a broader one. (${out.coverage})`
    : `${out.total_matching} live Bengaluru ${out.total_matching === 1 ? "role has" : "roles have"} a matching title. Page ${out.page}:\n\n${out.jobs.map((j: any, k: number) => line(j, (out.page - 1) * PER_PAGE + k + 1)).join("\n\n")}\n\n${out.has_more ? "More are available on the next page. " : ""}${out.coverage}`;
  if (tool === "get_job") return out.status === "not_found" ? "No Bengaluru posting has that job_id. Use a job_id from search_jobs."
    : `${out.job.title} · ${out.job.company}\n${out.job.location}${out.job.experience_asked ? ` · asks ${out.job.experience_asked}` : ""}\n${out.status === "closed" ? `The employer took this posting down around ${out.closed_on}. It is no longer open.` : `On the employer's site since ${out.job.on_employer_site_since}; last confirmed live ${out.job.last_confirmed}.`}\n${out.status === "closed" ? "Posting (now closed)" : "Apply on the employer's site"}: ${out.job.apply_url}\nSource: ${out.job.hiring_system}`;
  if (tool === "list_open_questions") return !out.questions.length ? (out.total_open ? `None of the ${out.total_open} questions open on Ghosted Open matches that. Leave the role out to see them all.` : "No employer has a question open on Ghosted Open right now.")
    : `${out.questions.length} open on Ghosted Open:\n\n${out.questions.map((q: any, k: number) => `${k + 1}. ${q.role} · ${q.company}\n   ${q.pay_band} · ${q.experience_asked} · ${q.location} · ${q.answers_so_far} ${q.answers_so_far === 1 ? "answer" : "answers"} so far · open until ${q.open_until}\n   “${q.question}”\n   Answer it, without your name: ${q.answer_url}\n   question_id ${q.question_id}`).join("\n\n")}`;
  if (tool === "get_open_question") return out.status === "not_found" ? "No Ghosted Open question has that question_id. Use one from list_open_questions."
    : `${out.question.role} · ${out.question.company}\n${out.question.pay_band} · ${out.question.experience_asked} · ${out.question.location}\n“${out.question.question}”\n${out.status === "closed" ? `This role has closed. ${out.outcome}` : `Answer it, without your name: ${out.question.answer_url}`}\n\n${out.answers.length ? out.answers.map((a: any) => `${a.candidate} (${a.background}): ${a.answer}`).join("\n\n") : "No answers yet."}`;
  if (tool === "about_open") return `${out.name}: hire through one real question.\n${out.how_it_works.map((x: string, k: number) => `${k + 1}. ${x}`).join("\n")}${out.price ? `\n${out.price}` : ""}\nPost a question: ${out.post_url}`;
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
const listArgs = z.object({ role: z.string().trim().max(80).optional() }).strict();
const qArgs = z.object({ question_id: z.string().regex(/^[a-f0-9]{6,16}$/) }).strict();
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
        if (name === "list_open_questions") { const a = listArgs.safeParse(args); if (!a.success) return ok(m.id, toolResult(name, { error: "list_open_questions takes one optional field: role, a job title or function." })); const out = await listOpen(client, a.data.role); count(client, name, out.questions.length, a.data.role); return ok(m.id, toolResult(name, out)); }
        if (name === "get_open_question") { const a = qArgs.safeParse(args); if (!a.success) return ok(m.id, toolResult(name, { error: "get_open_question needs question_id, the id from a list_open_questions result." })); const out = await getOpen(client, a.data.question_id); count(client, name, out.status === "not_found" ? 0 : 1); return ok(m.id, toolResult(name, out)); }
        if (name === "about_open") { count(client, name, 1); return ok(m.id, toolResult(name, aboutOpen(client))); }
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
