// Ghosted Open (14 Nov, first working build): hiring through one real question.
// A verified employer posts a role with one question. Anyone can read the question and the anonymous answers; only people
// whose Record is relevant to the role can write one. The employer reads answers without names, shortlists, may ask one
// private follow-up, and requests a conversation; the candidate accepts or declines; only then does the employer pay and
// receive the details the candidate chose to share. Closing the role tells everyone who answered how it ended.
//
// Storage: this build keeps Open's records in reader_control (key → json) so it runs without a schema change. The proper
// tables are in supabase/migrations/0011_open.sql; moving to them is a storage swap behind `store` below.
import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { db, type User } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { isRadarTester as isTester } from "../lib/testers.js";
import { json, HOUSEKEEPING } from "../engine/claude.js";
import { withMeter } from "../engine/meter.js";
import { recordFor } from "./radar.js";

export const open = new Hono<{ Variables: { user: User } }>();
export const openPublic = new Hono();
open.use("*", requireUser);

const now = () => new Date().toISOString();
const store = {
  async get<T>(key: string): Promise<T | null> { const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; },
  async set(key: string, value: unknown) { await db.from("reader_control").upsert({ key, value, updated_at: now() }, { onConflict: "key" }); },
  async list<T>(prefix: string): Promise<T[]> { const { data } = await db.from("reader_control").select("value").like("key", `${prefix}%`).order("updated_at", { ascending: false }).limit(500); return (data ?? []).map((r: any) => r.value as T); },
};

export const INTRO_PRICE = 499;
const DAYS_OPEN = 7, REPLY_WINDOW_MS = 15 * 60e3;
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|rediffmail|zoho|gmx|mail|yandex)\./i;
const domainOf = (s: string) => { let d = String(s ?? "").trim().toLowerCase().replace(/^.*@/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0]; return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : ""; };
/** the registrable part, near enough: "careers.acme.co.in" and "acme.co.in" are the same employer */
const baseDomain = (d: string) => { const p = d.split("."); const two = /^(co|com|org|net|ac|gov|edu)$/.test(p[p.length - 2] ?? "") && (p[p.length - 1] ?? "").length === 2; return p.slice(two ? -3 : -2).join("."); };

type Employer = { user: string; company: string; email: string; site: string; domain: string; verified: boolean; how: string; at: string };
type Question = { id: string; owner: string; company: string; domain: string; title: string; pay: string; exp_min: number; exp_max: number; location: string; question: string;
  status: "live" | "closed"; created: string; closes: string; outcome?: "hired" | "not_hired"; note?: string; closed_at?: string; views: number };
type Answer = { id: string; q: string; user: string; n: number; label: string; text: string; at: string; how: { ms: number; pasted: boolean };
  status: "in" | "shortlisted" | "requested" | "accepted" | "declined" | "paid";
  followup?: { q: string; suggested: boolean; asked_at: string; opened_at?: string; reply?: string; replied_at?: string; how?: { ms: number; pasted: boolean }; lapsed?: boolean };
  suggestions?: string[]; share?: { name: boolean; phone: boolean; email: boolean }; requested_at?: string; responded_at?: string; paid_at?: string };

const qKey = (id: string) => `open:q:${id}`, aKey = (q: string, user: string) => `open:a:${q}:${user}`;
const answersOf = (q: string) => store.list<Answer>(`open:a:${q}:`);
const isLive = (q: Question) => q.status === "live" && Date.parse(q.closes) > Date.now();
const FN = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
/** what the employer sees in place of a name: the function and the years, from the Record */
const labelFor = (t: { functions: string[]; years: number; level: string }) => `${FN((t.functions?.[0] ?? "Experienced").trim())} · ${Math.max(0, Math.round(t.years))} ${Math.round(t.years) === 1 ? "year" : "years"}`;
const pubQ = (q: Question, n: number) => ({ id: q.id, company: q.company, title: q.title, pay: q.pay, exp_min: q.exp_min, exp_max: q.exp_max, location: q.location, question: q.question, status: isLive(q) ? "live" : "closed", created: q.created, closes: q.closes, outcome: q.outcome ?? null, closed_at: q.closed_at ?? null, answers: n });
const pubA = (a: Answer) => ({ n: a.n, label: a.label, text: a.text, at: a.at });
const stage = (a: Answer) => ["accepted", "paid"].includes(a.status) ? "conversation" : a.status === "requested" || a.status === "declined" ? "requested" : a.status === "shortlisted" ? "shortlisted" : "in";

// ---------------- public: anyone can read ----------------
openPublic.get("/live", async (c) => {
  const qs = (await store.list<Question>("open:q:")).filter(isLive).slice(0, 40);
  const out = await Promise.all(qs.map(async (q) => pubQ(q, (await answersOf(q.id)).length)));
  return c.json({ questions: out });
});
openPublic.get("/q/:id", async (c) => {
  const q = await store.get<Question>(qKey(c.req.param("id")));
  if (!q) return c.json({ error: "This question isn’t on Ghosted Open." }, 404);
  const as = (await answersOf(q.id)).sort((a, b) => a.at.localeCompare(b.at));
  if (isLive(q)) { q.views = (q.views ?? 0) + 1; void store.set(qKey(q.id), q); }
  // a closed role: the outcome, and which answers went forward — what everyone who answered is told
  const closed = !isLive(q) ? { outcome: q.outcome ?? "not_hired", note: q.note ?? null, shortlisted: as.filter((a) => stage(a) !== "in").map((a) => a.n), conversation: as.filter((a) => stage(a) === "conversation").map((a) => a.n) } : null;
  return c.json({ question: pubQ(q, as.length), answers: as.map(pubA), closed });
});

// ---------------- the employer ----------------
open.get("/employer", async (c) => c.json({ employer: await store.get<Employer>(`open:emp:${c.get("user").id}`) }));
/** Verification, first version: a work email on the company's own domain (not a free mailbox), matching the company site.
 *  It proves the address is shaped right, not that the person owns it — an emailed code is the next step (no mail sender yet). */
open.post("/employer", async (c) => {
  const b = z.object({ company: z.string().trim().min(2).max(80), email: z.string().trim().email().max(120), site: z.string().trim().min(4).max(160) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Company name, your work email and the company website." }, 400);
  const ed = domainOf(b.data.email), sd = domainOf(b.data.site);
  if (!ed || !sd) return c.json({ error: "That email or website doesn’t look right." }, 400);
  if (FREE_MAIL.test(ed)) return c.json({ error: "Use your work email, on the company’s own domain. A personal mailbox can’t verify a company." }, 400);
  if (baseDomain(ed) !== baseDomain(sd)) return c.json({ error: `Your email is on ${baseDomain(ed)} and the website is ${baseDomain(sd)}. They need to be the same company domain.` }, 400);
  const e: Employer = { user: c.get("user").id, company: b.data.company, email: b.data.email.toLowerCase(), site: sd, domain: baseDomain(sd), verified: true, how: "work email on the company domain", at: now() };
  await store.set(`open:emp:${e.user}`, e);
  return c.json({ employer: e });
});
const ask = z.object({ title: z.string().trim().min(3).max(90), pay: z.string().trim().min(2).max(40), exp_min: z.number().int().min(0).max(40), exp_max: z.number().int().min(0).max(45), location: z.string().trim().min(2).max(60), question: z.string().trim().min(40).max(400) });
open.post("/questions", async (c) => {
  const u = c.get("user");
  const e = await store.get<Employer>(`open:emp:${u.id}`);
  if (!e?.verified) return c.json({ error: "Verify your company first." }, 403);
  const b = ask.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Role, pay band, experience, location, and one question of at least a sentence." }, 400);
  if (b.data.exp_max < b.data.exp_min) return c.json({ error: "The experience range runs the wrong way." }, 400);
  const mine = (await store.list<Question>("open:q:")).filter((q) => q.owner === u.id && isLive(q));
  if (mine.length >= 5) return c.json({ error: "Five live questions at a time. Close one first." }, 429);
  const q: Question = { id: randomBytes(5).toString("hex"), owner: u.id, company: e.company, domain: e.domain, ...b.data, status: "live", created: now(), closes: new Date(Date.now() + DAYS_OPEN * 86400e3).toISOString(), views: 0 };
  await store.set(qKey(q.id), q);
  return c.json({ question: pubQ(q, 0) });
});
/** the employer's desk: their questions, with every answer and where it stands */
open.get("/desk", async (c) => {
  const u = c.get("user");
  const qs = (await store.list<Question>("open:q:")).filter((q) => q.owner === u.id).sort((a, b) => b.created.localeCompare(a.created));
  const out = await Promise.all(qs.map(async (q) => { const as = (await answersOf(q.id)).sort((a, b) => a.at.localeCompare(b.at)); return { ...pubQ(q, as.length), views: q.views ?? 0, answers_list: await Promise.all(as.map((a) => deskA(a))) }; }));
  return c.json({ employer: await store.get<Employer>(`open:emp:${u.id}`), questions: out, tester: isTester(u), price: INTRO_PRICE });
});
async function deskA(a: Answer) {
  const base: any = { id: a.id, n: a.n, label: a.label, text: a.text, at: a.at, how: a.how, status: a.status,
    followup: a.followup ? { q: a.followup.q, asked_at: a.followup.asked_at, opened: !!a.followup.opened_at, reply: a.followup.reply ?? null, replied_at: a.followup.replied_at ?? null, lapsed: lapsed(a), how: a.followup.how ?? null } : null };
  if (a.status === "paid") base.contact = await contactOf(a);
  return base;
}
const lapsed = (a: Answer) => !!a.followup?.opened_at && !a.followup.reply && Date.now() - Date.parse(a.followup.opened_at) > REPLY_WINDOW_MS;
async function contactOf(a: Answer) {
  const { data: u } = await db.from("users").select("phone").eq("id", a.user).maybeSingle();
  const rec = await recordFor(a.user).catch(() => null);
  const p: any = rec?.resume.parsed ?? {}; const sh = a.share ?? { name: true, phone: true, email: true };
  return { name: sh.name ? (p.name ?? null) : null, phone: sh.phone ? (u?.phone ?? p.contact?.phone ?? null) : null, email: sh.email ? (p.contact?.email ?? null) : null };
}
/** an answer of one of MY questions */
async function mineAnswer(u: User, id: string): Promise<{ q: Question; a: Answer } | null> {
  const [qid, n] = id.split("-"); const q = await store.get<Question>(qKey(qid ?? ""));
  if (!q || q.owner !== u.id) return null;
  const a = (await answersOf(q.id)).find((x) => String(x.n) === n);
  return a ? { q, a } : null;
}
const save = (a: Answer) => store.set(aKey(a.q, a.user), a);

open.post("/answers/:id/shortlist", async (c) => {
  const m = await mineAnswer(c.get("user"), c.req.param("id")); if (!m) return c.json({ error: "Not your answer to act on." }, 404);
  if (m.a.status === "in") { m.a.status = "shortlisted"; await save(m.a); }
  return c.json({ answer: await deskA(m.a) });
});
/** two follow-ups Ghosted suggests from the answer itself — the employer can take one or write their own */
open.get("/answers/:id/suggest", async (c) => {
  const u = c.get("user"); const m = await mineAnswer(u, c.req.param("id")); if (!m) return c.json({ error: "Not your answer to act on." }, 404);
  if (!m.a.suggestions?.length) {
    try {
      const r = await withMeter({ tag: "open:suggest", user: u.id }, () => json<{ questions: string[] }>(
        "An employer asked candidates one question for a job. You read ONE candidate's answer and write two short follow-up questions the employer could ask that candidate. Each must be about something this answer actually says (a choice it made, an order of steps, a claim), must make the candidate explain their own reasoning or experience, and must be answerable in a few sentences. Under 18 words each. No yes/no questions, no generic interview questions, nothing about salary or personal details. Return {\"questions\": [\"…\", \"…\"]}.",
        `ROLE: ${m.q.title}\nTHE QUESTION: ${m.q.question}\nTHE ANSWER: ${m.a.text}`, 400, HOUSEKEEPING));
      m.a.suggestions = (r.questions ?? []).map((x) => String(x).trim()).filter((x) => x.length > 12 && x.length < 160).slice(0, 2);
      if (m.a.suggestions.length) await save(m.a);
    } catch (e) { console.error("[open] suggest", (e as Error).message); }
  }
  return c.json({ suggestions: m.a.suggestions ?? [] });
});
open.post("/answers/:id/followup", async (c) => {
  const m = await mineAnswer(c.get("user"), c.req.param("id")); if (!m) return c.json({ error: "Not your answer to act on." }, 404);
  const b = z.object({ question: z.string().trim().min(12).max(240) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "One question, a sentence long." }, 400);
  if (!isLive(m.q)) return c.json({ error: "This role is closed." }, 409);
  if (m.a.followup) return c.json({ error: "One follow-up per answer. It has been asked." }, 409);
  if (!["shortlisted", "in"].includes(m.a.status)) return c.json({ error: "A follow-up comes before the conversation request." }, 409);
  m.a.status = "shortlisted";
  m.a.followup = { q: b.data.question, suggested: (m.a.suggestions ?? []).includes(b.data.question), asked_at: now() };
  await save(m.a);
  return c.json({ answer: await deskA(m.a) });
});
open.post("/answers/:id/request", async (c) => {
  const m = await mineAnswer(c.get("user"), c.req.param("id")); if (!m) return c.json({ error: "Not your answer to act on." }, 404);
  if (!isLive(m.q)) return c.json({ error: "This role is closed." }, 409);
  if (["in", "shortlisted"].includes(m.a.status)) { m.a.status = "requested"; m.a.requested_at = now(); await save(m.a); }
  return c.json({ answer: await deskA(m.a) });
});
/** Payment for an accepted introduction. The payments table has no Open product yet (it needs migration 0011), so the
 *  only path open today is the tester's: it marks the introduction paid without money moving, and says so. */
open.post("/answers/:id/pay", async (c) => {
  const u = c.get("user"); const m = await mineAnswer(u, c.req.param("id")); if (!m) return c.json({ error: "Not your answer to act on." }, 404);
  if (m.a.status === "paid") return c.json({ answer: await deskA(m.a) });
  if (m.a.status !== "accepted") return c.json({ error: "You pay only after the candidate accepts." }, 409);
  if (!isTester(u)) return c.json({ error: "Payments for Open aren’t switched on yet. The candidate’s acceptance is held for you." }, 402);
  m.a.status = "paid"; m.a.paid_at = now(); await save(m.a);
  return c.json({ answer: await deskA(m.a), test_payment: true });
});
open.post("/questions/:id/close", async (c) => {
  const u = c.get("user"); const q = await store.get<Question>(qKey(c.req.param("id")));
  if (!q || q.owner !== u.id) return c.json({ error: "Not your question." }, 404);
  const b = z.object({ outcome: z.enum(["hired", "not_hired"]), note: z.string().trim().max(160).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Say how it ended: hired, or closed without a hire." }, 400);
  q.status = "closed"; q.outcome = b.data.outcome; q.note = b.data.note; q.closed_at = now();
  await store.set(qKey(q.id), q);
  const as = await answersOf(q.id);
  return c.json({ question: pubQ(q, as.length), notified: as.length });
});

// ---------------- the candidate ----------------
/** Can this person answer this question? Their Record against the role: the same function, and years near the band asked. */
async function relevance(u: User, q: Question) {
  const rec = await recordFor(u.id);
  if (!rec) return { state: "no_resume" as const };
  const t = rec.targets; const years = Math.round(Number(t.years ?? 0));
  const key = `open:rel:${q.id}:${u.id}:${rec.resume.id}`;
  let v = await store.get<{ same: string; why: string }>(key);
  if (!v) {
    // Open has no job description: the role's title and the question itself say what the work is
    const r = await withMeter({ tag: "open:relevance", user: u.id }, () => json<{ same: string; why: string }>(
      `An employer has posted a role on a hiring platform with ONE question for candidates instead of a job description. You are a fair recruiter answering one thing: is this role the same FUNCTION (craft) as the candidate's own work?
"yes" — the day-to-day work this role and its question describe is what the candidate has done for most of their recent years (product management for a product manager; category management for a category manager; backend engineering for a backend engineer). The industry may differ; the craft must not.
"adjacent" — a neighbouring craft a recruiter would still consider, but not the same one (program management for a product manager; key accounts for a category manager).
"no" — a different craft, however similar the title words (a "Category Manager" in procurement is not e-commerce category management; a Technical Program Manager is not a product manager; a chef is not a kitchen-equipment product manager).
Judge from the role title and what the question asks a person to actually do. Years and seniority are checked elsewhere; do not judge them. "why": at most 15 words, plain, naming the craft of the role. Return {"same": "yes"|"adjacent"|"no", "why": "…"}.`,
      `CANDIDATE: ${t.one_line}\nFunctions: ${(t.functions ?? []).join("; ")}. Recent titles: ${(t.titles ?? []).slice(0, 5).join("; ")}.\n\nROLE: ${q.title} — ${q.company}, ${q.location}\nTHE QUESTION CANDIDATES ANSWER: ${q.question}`, 300));
    v = { same: ["yes", "adjacent"].includes(String(r.same)) ? String(r.same) : "no", why: String(r.why ?? "").replace(/\s+/g, " ").slice(0, 140) };
    await store.set(key, v);
  }
  const inBand = years >= q.exp_min - 1 && years <= q.exp_max + 3;
  const relevant = v.same === "yes" && inBand;
  const checks = [
    { ok: v.same === "yes", label: FN(t.functions?.[0] ?? "Your function"), note: v.same === "yes" ? "the role’s function" : v.same === "adjacent" ? "near this role’s function, not the same" : "a different function from this role" },
    { ok: inBand, label: `${years} ${years === 1 ? "year" : "years"}`, note: `asks for ${q.exp_min}–${q.exp_max}` },
  ];
  return { state: "ok" as const, relevant, checks, why: v.why, label: labelFor(t), record: { name: rec.resume.parsed.name, one_line: t.one_line, level: t.level, years, functions: t.functions, strengths: t.strengths, titles: t.titles } };
}
open.get("/q/:id/me", async (c) => {
  const u = c.get("user"); const q = await store.get<Question>(qKey(c.req.param("id")));
  if (!q) return c.json({ error: "This question isn’t on Ghosted Open." }, 404);
  // a tester walks both sides on one number: "as=candidate" lets them answer their own question
  const both = isTester(u) && c.req.query("as") === "candidate";
  if (q.owner === u.id && !both) return c.json({ owner: true, tester: isTester(u) });
  const mine = await store.get<Answer>(aKey(q.id, u.id));
  const r = await relevance(u, q);
  return c.json({ owner: false, ...r, answer: mine ? candA(mine, q) : null });
});
open.post("/q/:id/answers", async (c) => {
  const u = c.get("user"); const q = await store.get<Question>(qKey(c.req.param("id")));
  if (!q) return c.json({ error: "This question isn’t on Ghosted Open." }, 404);
  if (!isLive(q)) return c.json({ error: "This role has closed." }, 409);
  if (q.owner === u.id && !(isTester(u) && c.req.query("as") === "candidate")) return c.json({ error: "This is your own question." }, 403);
  const b = z.object({ text: z.string().trim().min(80).max(1500), ms: z.number().min(0).max(36e5).default(0), pasted: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "An answer is between a few sentences and about 250 words." }, 400);
  if (await store.get<Answer>(aKey(q.id, u.id))) return c.json({ error: "You’ve already answered this one." }, 409);
  const r = await relevance(u, q);
  if (r.state !== "ok") return c.json({ error: "Upload your résumé first — your Record decides who can answer." }, 403);
  if (!r.relevant) return c.json({ error: "Your Record isn’t relevant to this role, so the answer box stays closed. You can still read the question and the answers." }, 403);
  const taken = new Set((await answersOf(q.id)).map((a) => a.n)); let n = 0;
  do { n = 100 + Math.floor(Math.random() * 900); } while (taken.has(n));
  const a: Answer = { id: `${q.id}-${n}`, q: q.id, user: u.id, n, label: r.label, text: b.data.text, at: now(), how: { ms: b.data.ms, pasted: b.data.pasted }, status: "in" };
  await save(a);
  return c.json({ answer: candA(a, q) });
});
/** an answer as its own writer sees it */
function candA(a: Answer, q: Question) {
  const f = a.followup;
  return { id: a.id, n: a.n, label: a.label, text: a.text, at: a.at, status: a.status, stage: stage(a),
    question: { id: q.id, company: q.company, title: q.title, question: q.question, status: isLive(q) ? "live" : "closed", outcome: q.outcome ?? null },
    followup: f ? { asked_at: f.asked_at, opened_at: f.opened_at ?? null, q: f.opened_at ? f.q : null, reply: f.reply ?? null, lapsed: lapsed(a), ms_left: f.opened_at && !f.reply ? Math.max(0, REPLY_WINDOW_MS - (Date.now() - Date.parse(f.opened_at))) : null, window_min: REPLY_WINDOW_MS / 60e3 } : null,
    invited: a.status === "requested", share: a.share ?? null };
}
/** everything of mine on Open: answers, a follow-up waiting, an invitation waiting, outcomes */
open.get("/me", async (c) => {
  const u = c.get("user");
  const { data } = await db.from("reader_control").select("value").like("key", `open:a:%:${u.id}`).order("updated_at", { ascending: false }).limit(60);
  const out = [];
  for (const r of data ?? []) { const a = r.value as Answer; const q = await store.get<Question>(qKey(a.q)); if (q) out.push(candA(a, q)); }
  return c.json({ answers: out });
});
async function myAnswer(u: User, id: string) { const [qid] = id.split("-"); const a = await store.get<Answer>(aKey(qid ?? "", u.id)); if (!a || a.id !== id) return null; const q = await store.get<Question>(qKey(a.q)); return q ? { a, q } : null; }
/** opening the follow-up starts the reply window — they pick their moment, then it is their own thinking against the clock */
open.post("/answers/:id/open", async (c) => {
  const m = await myAnswer(c.get("user"), c.req.param("id")); if (!m?.a.followup) return c.json({ error: "No follow-up here." }, 404);
  if (!m.a.followup.opened_at) { m.a.followup.opened_at = now(); await save(m.a); }
  return c.json({ answer: candA(m.a, m.q) });
});
open.post("/answers/:id/reply", async (c) => {
  const m = await myAnswer(c.get("user"), c.req.param("id")); if (!m?.a.followup?.opened_at) return c.json({ error: "Open the follow-up first." }, 409);
  const b = z.object({ text: z.string().trim().min(30).max(900), ms: z.number().min(0).max(36e5).default(0), pasted: z.boolean().default(false) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "A reply is a few sentences." }, 400);
  if (m.a.followup.reply) return c.json({ error: "One reply. It has been sent." }, 409);
  if (lapsed(m.a)) return c.json({ error: "The reply window has closed." }, 410);
  m.a.followup.reply = b.data.text; m.a.followup.replied_at = now(); m.a.followup.how = { ms: b.data.ms, pasted: b.data.pasted };
  await save(m.a);
  return c.json({ answer: candA(m.a, m.q) });
});
open.post("/answers/:id/respond", async (c) => {
  const m = await myAnswer(c.get("user"), c.req.param("id")); if (!m) return c.json({ error: "Not your answer." }, 404);
  const b = z.object({ accept: z.boolean(), share: z.object({ name: z.boolean(), phone: z.boolean(), email: z.boolean() }).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Accept or decline." }, 400);
  if (m.a.status !== "requested") return c.json({ error: "There is no invitation waiting on this answer." }, 409);
  const share = b.data.share ?? { name: true, phone: true, email: true };
  if (b.data.accept && !share.phone && !share.email) return c.json({ error: "Share at least a phone number or an email, or they can’t reach you." }, 400);
  m.a.status = b.data.accept ? "accepted" : "declined"; m.a.responded_at = now(); if (b.data.accept) m.a.share = share;
  await save(m.a);
  return c.json({ answer: candA(m.a, m.q) });
});
