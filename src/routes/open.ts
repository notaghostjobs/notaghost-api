// Ghosted Open (14 Nov, first working build): hiring through one real question.
// A verified employer posts a role with one question. Anyone can read the question and the anonymous answers. Anyone with
// a verified number and a résumé can write one (18 Nov: the gate was opened; nobody is turned away); each answer carries
// how close its writer's work is to the role, and the desk reads closest first. The employer shortlists, may ask one
// private follow-up, and requests a conversation; the candidate accepts or declines; only then does the employer pay and
// receive the details the candidate chose to share. Closing the role tells everyone who answered how it ended.
// 20 Nov: the employer gives only a work email. The company's name and mark are read from that domain's own website
// (lib/brand.ts); nothing is uploaded. A corrected name shows where the person was verified and carries no mark.
//
// Storage: this build keeps Open's records in reader_control (key → json) so it runs without a schema change. The proper
// tables are in supabase/migrations/0011_open.sql; moving to them is a storage swap behind `store` below.
import { Hono } from "hono";
import { z } from "zod";
import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from "node:crypto";
import Razorpay from "razorpay";
import { db, type User } from "../lib/db.js";
import { requireUser } from "../lib/auth.js";
import { isRadarTester as isTester } from "../lib/testers.js";
import { json, HOUSEKEEPING } from "../engine/claude.js";
import { withMeter } from "../engine/meter.js";
import { recordFor } from "./radar.js";
import { env } from "../lib/env.js";
import { sendMail, mailReady } from "../lib/mail.js";
import { notifyOpen } from "./whatsapp.js";
import { srcOf, srcOfUser, logEvent } from "../lib/src.js";
import { brandOf, confirmBrand, nameTakenElsewhere, sameName, type Brand } from "../lib/brand.js";

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

/** `typed`: the hiring manager gave a name the domain's own website does not use, so the question says where they were verified
 *  and carries no mark. `hold`: that name belongs to an employer on another domain, so their questions wait for a person. */
type Employer = { user: string; company: string; email: string; site: string; domain: string; verified: boolean; how: string; at: string; logo?: string; site_name?: string; typed?: boolean; hold?: string;
  code?: { hash: string; until: string; tries: number; sent_at: string } };
type Question = { id: string; owner: string; company: string; domain: string; title: string; pay: string; exp_min: number; exp_max: number; location: string; question: string;
  status: "live" | "closed" | "held"; created: string; closes: string; outcome?: "hired" | "not_hired"; note?: string; closed_at?: string; views: number;
  path?: string; told_at?: string; logo?: string; typed?: boolean; hold?: string };
/** how close the writer's own work is to the role: the same craft, a neighbouring one, or a different one */
type Fit = "same" | "near" | "different";
type Answer = { id: string; q: string; user: string; n: number; label: string; text: string; at: string; how: { ms: number; pasted: boolean };
  fit?: Fit; in_band?: boolean;
  status: "in" | "shortlisted" | "requested" | "accepted" | "declined" | "paid";
  followup?: { q: string; suggested: boolean; asked_at: string; opened_at?: string; reply?: string; replied_at?: string; how?: { ms: number; pasted: boolean }; lapsed?: boolean };
  suggestions?: string[]; share?: { name: boolean; phone: boolean; email: boolean }; requested_at?: string; responded_at?: string; paid_at?: string; order_id?: string; payment_id?: string };

const slugOf = (t: string) => String(t ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
/** A question's own address: <company>/<role>. The company part comes from the verified domain ("amazon.com" → "amazon"),
 *  so nobody else can take it. The same role posted again takes the city, then the month, then a count — never a random tail. */
async function claimPath(q: { id: string; domain: string; company: string; title: string; location: string }): Promise<string> {
  const co = slugOf(q.domain.split(".")[0] ?? "") || slugOf(q.company) || "company";
  const role = slugOf(q.title) || "role";
  const mon = new Date().toLocaleDateString("en-GB", { month: "short", timeZone: "Asia/Kolkata" }).toLowerCase();
  const tries = [role, `${role}-${slugOf(q.location)}`, `${role}-${slugOf(q.location)}-${mon}`, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${role}-${slugOf(q.location)}-${mon}-${n}`)];
  for (const r of tries) { const path = `${co}/${r}`; if (!(await store.get<string>(`open:path:${path}`))) { await store.set(`open:path:${path}`, q.id); return path; } }
  const path = `${co}/${role}-${q.id}`; await store.set(`open:path:${path}`, q.id); return path;
}
const qKey = (id: string) => `open:q:${id}`, aKey = (q: string, user: string) => `open:a:${q}:${user}`;
const answersOf = (q: string) => store.list<Answer>(`open:a:${q}:`);
const isLive = (q: Question) => q.status === "live" && Date.parse(q.closes) > Date.now();
const FN = (s: string) => s.replace(/\b\w/g, (m) => m.toUpperCase());
/** what the employer sees in place of a name: the function and the years, from the Record */
const labelFor = (t: { functions: string[]; years: number; level: string }) => `${FN((t.functions?.[0] ?? "Experienced").trim())} · ${Math.max(0, Math.round(t.years))} ${Math.round(t.years) === 1 ? "year" : "years"}`;
const pubQ = (q: Question, n: number) => ({ id: q.id, company: q.company, title: q.title, pay: q.pay, exp_min: q.exp_min, exp_max: q.exp_max, location: q.location, question: q.question, status: q.status === "held" ? "held" : isLive(q) ? "live" : "closed", created: q.created, closes: q.closes, outcome: q.outcome ?? null, closed_at: q.closed_at ?? null, answers: n, path: q.path ?? null, logo: q.typed ? null : logoUrl(q.domain, q.logo), verified_at: q.typed ? q.domain : null });
/** the employer's own mark, served by us; the stamp changes when they change it, so a browser never shows a stale one */
const logoUrl = (domain: string, stamp?: string) => stamp ? `/open/public/logo/${domain}?v=${stamp}` : null;
const FIT_WORDS: Record<Fit, string> = { same: "Same function", near: "Near function", different: "Different function" };
/** closest first: the same craft inside the years asked, then the same craft outside them, then near, then different */
const fitRank = (a: Answer) => a.fit === "same" ? (a.in_band === false ? 1 : 0) : a.fit === "near" ? 2 : a.fit === "different" ? 3 : 1;
const pubA = (a: Answer) => ({ n: a.n, label: a.label, text: a.text, at: a.at, fit: a.fit ?? null, fit_label: a.fit ? FIT_WORDS[a.fit] : null });
const stage = (a: Answer) => ["accepted", "paid"].includes(a.status) ? "conversation" : a.status === "requested" || a.status === "declined" ? "requested" : a.status === "shortlisted" ? "shortlisted" : "in";

// ---------------- public: anyone can read ----------------
openPublic.get("/live", async (c) => {
  const qs = (await store.list<Question>("open:q:")).filter(isLive).slice(0, 40);
  const out = await Promise.all(qs.map(async (q) => pubQ(q, (await answersOf(q.id)).length)));
  return c.json({ questions: out });
});
/** the readable address of a question (notaghost.jobs/open/<company>/<role>) → its id */
openPublic.get("/at/:co/:role", async (c) => {
  const id = await store.get<string>(`open:path:${slugOf(c.req.param("co"))}/${slugOf(c.req.param("role"))}`);
  if (!id) return c.json({ error: "This question isn’t on Ghosted Open." }, 404);
  return c.json({ id });
});
openPublic.get("/q/:id", async (c) => {
  const q = await store.get<Question>(qKey(c.req.param("id")));
  if (!q || q.status === "held") return c.json({ error: "This question isn’t on Ghosted Open." }, 404);
  const as = (await answersOf(q.id)).sort((a, b) => a.at.localeCompare(b.at));
  if (isLive(q)) { q.views = (q.views ?? 0) + 1; void store.set(qKey(q.id), q); }
  // a closed role: the outcome, and which answers went forward — what everyone who answered is told
  const closed = !isLive(q) ? { outcome: q.outcome ?? "not_hired", note: q.note ?? null, shortlisted: as.filter((a) => stage(a) !== "in").map((a) => a.n), conversation: as.filter((a) => stage(a) === "conversation").map((a) => a.n) } : null;
  return c.json({ question: pubQ(q, as.length), answers: as.map(pubA), closed });
});

// ---------------- the employer ----------------
const pubE = (e: Employer | null) => e ? { company: e.company, email: e.email, domain: e.domain, verified: e.verified, pending: !e.verified && !!e.code, logo: e.typed ? null : logoUrl(e.domain, e.logo), verified_at: e.typed ? e.domain : null, held: !!e.hold } : null;
const CODE_MIN = 15, CODE_TRIES = 5, RESEND_GAP_MS = 60e3;
const codeHash = (user: string, code: string) => createHash("sha256").update(`${user}:${code}`).digest("hex");
async function mailCode(e: Employer): Promise<boolean> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  e.code = { hash: codeHash(e.user, code), until: new Date(Date.now() + CODE_MIN * 60e3).toISOString(), tries: 0, sent_at: now() };
  await store.set(`open:emp:${e.user}`, e);
  return sendMail({ to: e.email, subject: `${code} is your Ghosted Open code`, code,
    lines: [`Your code to verify ${e.company} on Ghosted Open:`, `It is good for ${CODE_MIN} minutes. Enter it on the page you have open.`, "If you did not ask for this, ignore this email. Nobody can post as your company without the code."] });
}
open.get("/employer", async (c) => c.json({ employer: pubE(await store.get<Employer>(`open:emp:${c.get("user").id}`)) }));
/** Who a work email belongs to, before any code is sent: the company at that domain, by its own website's name and mark.
 *  The hiring manager sees it and says yes, or corrects the name. */
const lookups = new Map<string, number[]>();
open.post("/employer/lookup", async (c) => {
  const u = c.get("user");
  const b = z.object({ email: z.string().trim().email().max(120) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Enter your work email." }, 400);
  const ed = domainOf(b.data.email);
  if (!ed) return c.json({ error: "That email doesn’t look right." }, 400);
  if (FREE_MAIL.test(ed)) return c.json({ error: "Use your work email, on the company’s own domain. A personal mailbox can’t verify a company." }, 400);
  const hits = (lookups.get(u.id) ?? []).filter((t) => Date.now() - t < 10 * 60e3);
  if (hits.length >= 12) return c.json({ error: "That’s a lot of tries. Give it a few minutes." }, 429);
  hits.push(Date.now()); lookups.set(u.id, hits); if (lookups.size > 2000) lookups.clear();
  const domain = baseDomain(ed);
  const br = await brandOf(domain).catch((): Brand => ({ domain, name: "", source: "domain", logo: null, at: now() }));
  return c.json({ domain, name: br.name, logo: logoUrl(domain, br.logo ?? undefined), read: br.source !== "domain" });
});
/** Verification: a work email on the company's own domain (not a free mailbox) — and then a code sent to that address,
 *  which only its owner can read. The domain is the one thing proved. The company's name and mark come from that domain's
 *  own website; a hiring manager may correct the name, and then the question says where they were verified and shows no
 *  mark. A name that belongs to an employer on another domain is held for a person to look at.
 *  The automated walk's account and testers skip the code. */
open.post("/employer", async (c) => {
  const u = c.get("user");
  const b = z.object({ company: z.string().trim().max(80).optional(), email: z.string().trim().email().max(120), site: z.string().trim().max(160).optional(), real: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Enter your work email." }, 400);
  const ed = domainOf(b.data.email), sd = b.data.site ? domainOf(b.data.site) : "";
  if (!ed || (b.data.site && !sd)) return c.json({ error: "That email or website doesn’t look right." }, 400);
  if (FREE_MAIL.test(ed)) return c.json({ error: "Use your work email, on the company’s own domain. A personal mailbox can’t verify a company." }, 400);
  if (sd && baseDomain(ed) !== baseDomain(sd)) return c.json({ error: `Your email is on ${baseDomain(ed)} and the website is ${baseDomain(sd)}. They need to be the same company domain.` }, 400);
  const domain = baseDomain(ed), email = b.data.email.toLowerCase();
  const br = await brandOf(domain).catch((): Brand => ({ domain, name: "", source: "domain", logo: null, at: now() }));
  const typedName = (b.data.company ?? "").trim();
  const company = typedName.length >= 2 ? typedName : br.name;
  if (company.length < 2) return c.json({ error: "Tell us your company’s name." }, 400);
  // the name differs only when we did read what the company calls itself and this is not it
  const typed = br.source !== "domain" && !sameName(company, br.name);
  // a name is checked against other employers only when it is not this domain's own: neither what its site says nor its own word
  const own = (br.source !== "domain" && !typed) || sameName(company, domain.split(".")[0] ?? "");
  const taken = own ? null : await nameTakenElsewhere(company, domain).catch(() => null);
  const had = await store.get<Employer>(`open:emp:${u.id}`);
  const shape = { company, site: sd || domain, domain, site_name: br.name || undefined, typed: typed || !!taken || undefined, hold: taken ? `“${company}” is the name of an employer at ${taken}` : undefined, logo: br.logo ?? (had?.domain === domain ? had.logo : undefined) };
  if (br.logo && had?.logo !== br.logo) void stampLogo(domain, br.logo).catch(() => {});
  if (typed || taken) void noteMismatch({ domain, typed: company, site_name: br.name, held: !!taken, taken_by: taken, user: u.id });
  if (had?.verified && had.email === email && had.domain === domain) { const e2: Employer = { ...had, ...shape }; await store.set(`open:emp:${u.id}`, e2); return c.json({ employer: pubE(e2) }); }
  const e: Employer = { user: u.id, email, verified: false, how: "", at: now(), ...shape };
  // a tester is verified at once, unless they ask to walk the real path (the code by email) with real: true
  if (isTester(u) && !b.data.real) { e.verified = true; e.how = "tester account, no code sent"; await store.set(`open:emp:${u.id}`, e); return c.json({ employer: pubE(e), tester: true }); }
  if (!mailReady()) return c.json({ error: "We can’t send verification emails just yet. Please try again shortly." }, 503);
  if (had?.code && had.email === email && Date.now() - Date.parse(had.code.sent_at) < RESEND_GAP_MS) { const e2: Employer = { ...had, ...shape }; await store.set(`open:emp:${u.id}`, e2); return c.json({ employer: pubE(e2), sent_to: email }); }
  if (!(await mailCode(e))) return c.json({ error: `We couldn’t send a code to ${email}. Check the address and try again.` }, 502);
  return c.json({ employer: pubE(e), sent_to: email });
});
/** every time a typed name and a domain's own name part ways, one line is kept for a person to read */
type Mismatch = { at: string; domain: string; typed: string; site_name: string; held: boolean; taken_by: string | null; user: string };
async function noteMismatch(m: Omit<Mismatch, "at">) {
  const list = (await store.get<Mismatch[]>("open:brand:log")) ?? [];
  if (list.some((x) => x.domain === m.domain && x.typed === m.typed)) return;
  await store.set("open:brand:log", [{ at: now(), ...m }, ...list].slice(0, 100));
}
open.post("/employer/confirm", async (c) => {
  const u = c.get("user"); const e = await store.get<Employer>(`open:emp:${u.id}`);
  const b = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "The code is six digits." }, 400);
  if (!e) return c.json({ error: "Start with your company details." }, 409);
  if (e.verified) return c.json({ employer: pubE(e) });
  if (!e.code || Date.parse(e.code.until) < Date.now()) return c.json({ error: "That code has run out. Ask for a new one." }, 410);
  if (e.code.tries >= CODE_TRIES) return c.json({ error: "Too many tries. Ask for a new code." }, 429);
  const want = Buffer.from(e.code.hash), got = Buffer.from(codeHash(u.id, b.data.code));
  if (want.length !== got.length || !timingSafeEqual(want, got)) { e.code.tries += 1; await store.set(`open:emp:${u.id}`, e); return c.json({ error: "That isn’t the code we sent." }, 400); }
  e.verified = true; e.how = "code sent to the work email"; e.at = now(); delete e.code;
  await store.set(`open:emp:${u.id}`, e);
  return c.json({ employer: pubE(e) });
});
open.post("/employer/resend", async (c) => {
  const u = c.get("user"); const e = await store.get<Employer>(`open:emp:${u.id}`);
  if (!e || e.verified) return c.json({ employer: pubE(e) });
  if (e.code && Date.now() - Date.parse(e.code.sent_at) < RESEND_GAP_MS) return c.json({ error: "A code was sent a moment ago. Give it a minute." }, 429);
  if (!mailReady() || !(await mailCode(e))) return c.json({ error: `We couldn’t send a code to ${e.email}.` }, 502);
  return c.json({ employer: pubE(e), sent_to: e.email });
});
const ask = z.object({ title: z.string().trim().min(3).max(90), pay: z.string().trim().min(2).max(40), exp_min: z.number().int().min(0).max(40), exp_max: z.number().int().min(0).max(45), location: z.string().trim().min(2).max(60), question: z.string().trim().min(40).max(400) });
// ---------------- the company's mark ----------------
// The mark comes from the company's own website, read once when its first hiring manager is looked up (lib/brand.ts): the
// right one or none. Nobody uploads anything. It is kept beside Open's other records, one per company domain; questions
// carry a stamp of it, so every page of that company shows the same mark.
const logoCache = new Map<string, { at: number; mime: string; buf: Buffer } | null>();
async function stampLogo(domain: string, stamp: string | null) {
  const { data } = await db.from("reader_control").select("key,value").like("key", "open:q:%").limit(500);
  for (const r of data ?? []) { const q = r.value as Question; if (q.domain !== domain) continue; if (stamp) q.logo = stamp; else delete q.logo; await store.set(qKey(q.id), q); }
  const { data: es } = await db.from("reader_control").select("value").like("key", "open:emp:%").limit(500);
  for (const r of es ?? []) { const e = r.value as Employer; if (e.domain !== domain) continue; if (stamp) e.logo = stamp; else delete e.logo; await store.set(`open:emp:${e.user}`, e); }
  logoCache.delete(domain);
}
// ---------------- held names: a person looks ----------------
// Tester accounts (ours) see the questions waiting on a name, and the list of names that parted from their domain's own.
open.get("/review", async (c) => {
  if (!isTester(c.get("user"))) return c.json({ error: "Not available on this account." }, 403);
  const held = (await store.list<Question>("open:q:")).filter((q) => q.status === "held").map((q) => ({ id: q.id, company: q.company, domain: q.domain, title: q.title, question: q.question, why: q.hold ?? null, created: q.created }));
  return c.json({ held, names: (await store.get<Mismatch[]>("open:brand:log")) ?? [] });
});
open.post("/review/:id", async (c) => {
  if (!isTester(c.get("user"))) return c.json({ error: "Not available on this account." }, 403);
  const b = z.object({ ok: z.boolean() }).safeParse(await c.req.json().catch(() => ({})));
  const q = await store.get<Question>(qKey(c.req.param("id")));
  if (!b.success || !q || q.status !== "held") return c.json({ error: "Nothing is waiting under that id." }, 404);
  const e = await store.get<Employer>(`open:emp:${q.owner}`);
  if (b.data.ok) {
    // the name is right for this domain: it stays that way for the next hiring manager from there, with the domain's mark
    const br = await confirmBrand(q.domain, q.company);
    q.status = "live"; q.closes = new Date(Date.now() + DAYS_OPEN * 86400e3).toISOString(); delete q.hold; delete q.typed; if (br.logo) q.logo = br.logo;
    if (e && e.domain === q.domain) { delete e.hold; delete e.typed; e.site_name = q.company; if (br.logo) e.logo = br.logo; await store.set(`open:emp:${e.user}`, e); }
  } else {
    q.status = "closed"; q.closed_at = now(); q.note = "This question was not published: the company name could not be confirmed for the verified email’s domain.";
  }
  await store.set(qKey(q.id), q);
  return c.json({ ok: true, status: q.status });
});
openPublic.get("/logo/:domain", async (c) => {
  const domain = domainOf(c.req.param("domain")); if (!domain) return c.text("", 404);
  let hit = logoCache.get(domain);
  if (hit === undefined || (hit && Date.now() - hit.at > 10 * 60e3) || (hit === null)) {
    const r = await store.get<{ mime: string; b64: string }>(`open:logo:${domain}`);
    hit = r && (r.mime === "image/png" || r.mime === "image/jpeg") ? { at: Date.now(), mime: r.mime, buf: Buffer.from(r.b64, "base64") } : null;
    if (logoCache.size > 500) logoCache.clear();
    logoCache.set(domain, hit);
  }
  if (!hit) return c.text("", 404);
  return new Response(new Uint8Array(hit.buf), { headers: { "content-type": hit.mime, "cache-control": "public, max-age=86400, immutable", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "cross-origin" } });
});

open.post("/questions", async (c) => {
  const u = c.get("user");
  const e = await store.get<Employer>(`open:emp:${u.id}`);
  if (!e?.verified) return c.json({ error: "Verify your company first." }, 403);
  const b = ask.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Role, pay band, experience, location, and one question of at least a sentence." }, 400);
  if (b.data.exp_max < b.data.exp_min) return c.json({ error: "The experience range runs the wrong way." }, 400);
  const mine = (await store.list<Question>("open:q:")).filter((q) => q.owner === u.id && isLive(q));
  if (mine.length >= 5) return c.json({ error: "Five live questions at a time. Close one first." }, 429);
  const q: Question = { id: randomBytes(5).toString("hex"), owner: u.id, company: e.company, domain: e.domain, ...b.data, status: e.hold ? "held" : "live", created: now(), closes: new Date(Date.now() + DAYS_OPEN * 86400e3).toISOString(), views: 0, ...(e.logo ? { logo: e.logo } : {}), ...(e.typed ? { typed: true } : {}), ...(e.hold ? { hold: e.hold } : {}) };
  q.path = await claimPath(q);
  await store.set(qKey(q.id), q);
  return c.json({ question: pubQ(q, 0) });
});
/** the employer's desk: their questions, with every answer and where it stands */
open.get("/desk", async (c) => {
  const u = c.get("user");
  const qs = (await store.list<Question>("open:q:")).filter((q) => q.owner === u.id).sort((a, b) => b.created.localeCompare(a.created));
  const out = await Promise.all(qs.map(async (q) => { const as = (await answersOf(q.id)).sort((a, b) => fitRank(a) - fitRank(b) || a.at.localeCompare(b.at)); return { ...pubQ(q, as.length), views: q.views ?? 0, answers_list: await Promise.all(as.map((a) => deskA(a))) }; }));
  return c.json({ employer: pubE(await store.get<Employer>(`open:emp:${u.id}`)), questions: out, tester: isTester(u), price: INTRO_PRICE });
});
async function deskA(a: Answer) {
  const base: any = { id: a.id, n: a.n, label: a.label, text: a.text, at: a.at, how: a.how, status: a.status, fit: a.fit ?? null, fit_label: a.fit ? FIT_WORDS[a.fit] : null, in_band: a.in_band ?? null,
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
  void notifyOpen(m.a.user, "followup", { company: m.q.company, title: m.q.title });
  return c.json({ answer: await deskA(m.a) });
});
open.post("/answers/:id/request", async (c) => {
  const m = await mineAnswer(c.get("user"), c.req.param("id")); if (!m) return c.json({ error: "Not your answer to act on." }, 404);
  if (!isLive(m.q)) return c.json({ error: "This role is closed." }, 409);
  if (["in", "shortlisted"].includes(m.a.status)) { m.a.status = "requested"; m.a.requested_at = now(); await save(m.a); void notifyOpen(m.a.user, "invite", { company: m.q.company, title: m.q.title }); }
  return c.json({ answer: await deskA(m.a) });
});
const rzp = () => new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
/** The one place an introduction becomes paid: the browser's confirmation, Razorpay's webhook and the tester path all land here. */
async function markPaid(a: Answer, ref: { order_id?: string; payment_id?: string }) {
  if (a.status === "paid") return;
  a.status = "paid"; a.paid_at = now(); Object.assign(a, ref); await save(a);
}
/** Called by the payments settle step when a ₹499 Open order is confirmed paid. Idempotent. */
export async function settleOpenIntro(orderId: string, paymentId?: string | null): Promise<boolean> {
  const m = await store.get<{ q: string; user: string }>(`open:pay:${orderId}`); if (!m) return false;
  const a = await store.get<Answer>(aKey(m.q, m.user)); if (!a) return false;
  if (!["accepted", "paid"].includes(a.status)) return false;
  await markPaid(a, { order_id: orderId, ...(paymentId ? { payment_id: paymentId } : {}) });
  return true;
}
/** Payment for an accepted introduction: ₹499, and only now. Returns a Razorpay order for the browser's checkout; the
 *  payments confirm step (or the webhook) then marks it paid and the contact appears on the desk. A tester account
 *  marks it paid without money moving, and says so — unless it asks for the real path with ?real=1. */
open.post("/answers/:id/pay", async (c) => {
  const u = c.get("user"); const m = await mineAnswer(u, c.req.param("id")); if (!m) return c.json({ error: "Not your answer to act on." }, 404);
  if (m.a.status === "paid") return c.json({ answer: await deskA(m.a) });
  if (m.a.status !== "accepted") return c.json({ error: "You pay only after the candidate accepts." }, 409);
  if (isTester(u) && c.req.query("real") !== "1") { await markPaid(m.a, {}); return c.json({ answer: await deskA(m.a), test_payment: true }); }
  if (!env.razorpayKeyId || !env.razorpayKeySecret) return c.json({ error: "Payments aren’t available right now. The candidate’s acceptance is held for you." }, 503);
  try {
    const here = srcOf(c); const src = await srcOfUser(u.id);
    const attributed = { first: src.first ?? here.first ?? here.last ?? null, last: here.last ?? src.last ?? null };
    const order = await rzp().orders.create({ amount: INTRO_PRICE * 100, currency: "INR", notes: { user_id: u.id, product: "open_intro", answer: m.a.id, src_first: attributed.first ?? "direct", src_last: attributed.last ?? "direct" } });
    const { error } = await db.from("payments").insert({ user_id: u.id, product: "open_intro", amount_paise: INTRO_PRICE * 100, razorpay_order_id: order.id, raw: order, src_first: attributed.first, src_last: attributed.last });
    if (error) { console.error("[open] pay: payments row", error.message); return c.json({ error: "Payments for Open aren’t switched on yet. The candidate’s acceptance is held for you." }, 503); }
    await store.set(`open:pay:${order.id}`, { q: m.a.q, user: m.a.user, answer: m.a.id, owner: u.id });
    m.a.order_id = order.id; await save(m.a);
    void logEvent("order", { src: attributed, userId: u.id, meta: { order_id: order.id, product: "open_intro", amount_paise: INTRO_PRICE * 100 } });
    return c.json({ order: { order_id: order.id, amount: INTRO_PRICE * 100, key_id: env.razorpayKeyId, phone: u.phone } });
  } catch (e) { console.error("[open] pay", (e as Error).message); return c.json({ error: "We couldn’t start the payment. Nothing was charged; try again." }, 502); }
});
open.post("/questions/:id/close", async (c) => {
  const u = c.get("user"); const q = await store.get<Question>(qKey(c.req.param("id")));
  if (!q || q.owner !== u.id) return c.json({ error: "Not your question." }, 404);
  const b = z.object({ outcome: z.enum(["hired", "not_hired"]), note: z.string().trim().max(160).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Say how it ended: hired, or closed without a hire." }, 400);
  q.status = "closed"; q.outcome = b.data.outcome; q.note = b.data.note; q.closed_at = now();
  await store.set(qKey(q.id), q);
  const as = await answersOf(q.id);
  for (const a of as) void notifyOpen(a.user, "closed", { company: q.company, title: q.title, id: q.id });
  return c.json({ question: pubQ(q, as.length), notified: as.length });
});

// ---------------- the candidate ----------------
/** How close is this person's own work to the role? Their Record against it: the craft, and the years asked. Nobody is
 *  turned away on the answer (18 Nov); this is what the employer reads beside each one, and what the desk sorts by. */
async function relevance(u: User, q: Question) {
  const rec = await recordFor(u.id);
  if (!rec) return { state: "no_resume" as const };
  const t = rec.targets; const years = Math.round(Number(t.years ?? 0));
  const key = `open:rel:${q.id}:${u.id}:${rec.resume.id}`;
  let v = await store.get<{ same: string; why: string }>(key);
  if (!v) try {
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
  } catch (e: any) {
    // the comparison could not be made just now: the answer still goes in, read as a neighbouring craft, and is not kept so it is tried again
    console.error("[open] fit", e?.message ?? e); v = { same: "adjacent", why: "" };
  }
  const inBand = years >= q.exp_min - 1 && years <= q.exp_max + 3;
  const fit: Fit = v.same === "yes" ? "same" : v.same === "adjacent" ? "near" : "different";
  const checks = [
    { ok: v.same === "yes", label: FN(t.functions?.[0] ?? "Your function"), note: v.same === "yes" ? "the role’s function" : v.same === "adjacent" ? "near this role’s function, not the same" : "a different function from this role" },
    { ok: inBand, label: `${years} ${years === 1 ? "year" : "years"}`, note: `asks for ${q.exp_min}–${q.exp_max}` },
  ];
  // `relevant` stays in the reply, always true, for a page loaded before this change: it must not tell anyone the box is closed
  return { state: "ok" as const, relevant: true, fit, fit_label: FIT_WORDS[fit], in_band: inBand, checks, why: v.why, label: labelFor(t), record: { name: rec.resume.parsed.name, one_line: t.one_line, level: t.level, years, functions: t.functions, strengths: t.strengths, titles: t.titles } };
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
  if (r.state !== "ok") return c.json({ error: "Add your résumé to publish your answer. The employer sees the answer, never the résumé.", need: "resume" }, 403);
  const taken = new Set((await answersOf(q.id)).map((a) => a.n)); let n = 0;
  do { n = 100 + Math.floor(Math.random() * 900); } while (taken.has(n));
  const a: Answer = { id: `${q.id}-${n}`, q: q.id, user: u.id, n, label: r.label, text: b.data.text, at: now(), how: { ms: b.data.ms, pasted: b.data.pasted }, status: "in", fit: r.fit, in_band: r.in_band };
  await save(a);
  // the employer hears about the first answer at once, and after that at most once every three hours
  if (!q.told_at || Date.now() - Date.parse(q.told_at) > 3 * 3600e3) { q.told_at = now(); await store.set(qKey(q.id), q); void notifyOpen(q.owner, "answer", { title: q.title, count: taken.size + 1 }); }
  return c.json({ answer: candA(a, q) });
});
/** an answer as its own writer sees it */
function candA(a: Answer, q: Question) {
  const f = a.followup;
  return { id: a.id, n: a.n, label: a.label, text: a.text, at: a.at, status: a.status, stage: stage(a), fit: a.fit ?? null, fit_label: a.fit ? FIT_WORDS[a.fit] : null,
    question: { id: q.id, company: q.company, title: q.title, question: q.question, logo: logoUrl(q.domain, q.logo), status: isLive(q) ? "live" : "closed", outcome: q.outcome ?? null },
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
  void notifyOpen(m.q.owner, "reply", { n: m.a.n, title: m.q.title });
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
  void notifyOpen(m.q.owner, b.data.accept ? "accepted" : "declined", { n: m.a.n, title: m.q.title });
  return c.json({ answer: candA(m.a, m.q) });
});
