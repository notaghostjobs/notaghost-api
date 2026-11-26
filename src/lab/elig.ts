// Shared eligibility gate, prototype (26 Nov 2026). Offline lab code; not wired to any route. No model call.
// A job is offered only if it passes three explicit checks; eligible jobs are then ranked by evidence. Nothing is
// padded to a fixed count. Every threshold below was set before any result was seen and is not tuned on the labels.
//   1. function: the job's specialisation agrees with what the person wants (ontology transfer, MIN_AGREE 0.5).
//      An unclassified job is not excluded for that; it is marked unverified.
//   2. experience: stated minimum years, with flexibility (short by at most max(1 year, 25%)); a step back only when
//      the person exceeds a stated upper bound by more than 3 years. Seniority tags decide only when no years are
//      stated, and only when two or more rungs apart (tags are inferred and noisy).
//   3. specialist must-haves (tools, platforms, standards, regulation, credentials) on must-have lines only:
//      - explicitly missing: a required credential or degree level absent from a résumé that lists its education, or a
//        specialist tool named in the job title that the résumé never mentions → not eligible;
//      - unverified: a specialist tool the résumé does not mention → eligible, ranked lower; not eligible only when two
//        or more are unverified and none of the job's specialist must-haves is shown.
import { transfer } from "../lib/ontology.js";
import { levelFit, MIN_AGREE } from "../lib/career.js";
import { SKILLS } from "./skills.js";

const MUSTY = /\b(must|required|requirement|mandatory|essential|minimum|at least|should have|need to have|proven|strong|hands[- ]on|proficien|expert|solid|in[- ]depth|\d+\+? ?(years|yrs))/i;
const NICE = /\b(prefer|nice to have|a plus|plus\b|good to have|bonus|desirable|added advantage|advantageous|familiarity|exposure to|optional|ideally)\b/i;
const ANY_OF = /\b(or|any (one )?of|one of|either|such as|e\.g\.|like|etc)\b|\//i;

// Specialist items beyond the 91-skill dictionary: platforms, standards, regulation. Written from general domain
// knowledge before any result was seen; matched whole-word, case-insensitive.
const EXTRA: [string, string][] = [
  ["sap_fico", String.raw`sap fico|sap fi(?:\/| )?co|s\/?4 ?hana finance`], ["sap_mm", String.raw`sap mm|sap sd|sap pp|sap ewm|sap wm`],
  ["oracle_ebs", String.raw`oracle ebs|oracle e-business|oracle fusion|oracle financials`], ["hyperion", String.raw`hyperion|oracle epm|essbase`],
  ["anaplan", "anaplan"], ["blackline", "blackline"], ["netsuite", "netsuite"], ["workday_fin", String.raw`workday financials`],
  ["murex", "murex"], ["calypso", "calypso"], ["bloomberg", String.raw`bloomberg terminal|bloomberg`], ["alfa_actuarial", String.raw`\balfa\b|integrate \(fis\)|prophet|axis actuarial|moses`],
  ["finacle", "finacle"], ["flexcube", "flexcube"], ["temenos", String.raw`temenos|t24`], ["swift_msg", String.raw`swift mt|mt103|iso 20022`],
  ["ifrs", String.raw`ifrs(?: ?\d+)?|ind ?as`], ["us_gaap", String.raw`us ?gaap`], ["sox", String.raw`\bsox\b|sarbanes`], ["basel", String.raw`basel (ii|iii|iv)|\bbasel\b|crr|icaap`],
  ["aml_kyc", String.raw`\baml\b|\bkyc\b|anti[- ]money laundering|transaction monitoring`], ["rbi_reg", String.raw`rbi (returns|regulations|reporting)|xbrl|regulatory returns`],
  ["sas", String.raw`\bsas\b`], ["stata", "stata"], ["matlab", "matlab"], ["autocad", String.raw`autocad|solidworks|catia|creo`],
  ["sfmc", String.raw`salesforce marketing cloud|\bsfmc\b|marketo|eloqua|responsys|braze|moengage|clevertap`], ["hubspot", "hubspot"],
  ["servicenow", "servicenow"], ["itil", String.raw`\bitil\b`], ["splunk", "splunk"], ["guidewire", "guidewire"], ["pega", String.raw`\bpega\b`],
  ["veeva", "veeva"], ["gxp", String.raw`\bgxp\b|\bgmp\b|21 cfr`], ["six_sigma", String.raw`six sigma|lean six`],
];
// Only tools and platforms are specialist must-haves. Domain knowledge (finance, payments, supply chain, sales…),
// generic skills (Excel, project management, agile) and broad topics (ML, LLMs) inform ranking, never eligibility.
const TOOL_FAMILIES = new Set(["lang", "sap", "salesforce", "backend", "arch", "frontend", "mobile", "db_sql", "db_nosql", "bigdata", "warehouse", "pipeline", "bi", "cloud", "devops", "itsm", "itsm_tool", "testing", "erp", "hris", "martech", "embedded", "vlsi"]);
const NOT_TOOL = new Set(["microservices", "rest", "manual_testing"]);
const SPECIALIST: { id: string; re: RegExp }[] = [
  ...SKILLS.filter((s) => TOOL_FAMILIES.has(s.family) && !NOT_TOOL.has(s.id)).map((s) => ({ id: s.id, re: s.re })),
  ...EXTRA.map(([id, src]) => ({ id, re: new RegExp(`(?<![a-z0-9])(?:${src})(?![a-z0-9])`, "i") })),
];
// Credentials and degree levels: required ones can be explicitly missing.
const CREDS: { id: string; need: RegExp; have: RegExp }[] = [
  { id: "ca", need: /\b(chartered accountant|qualified ca|\bca\b(?= ?(\/|or|qualified|mandatory|required|,)))/i, have: /\bchartered accountant|\bca\b(?= ?(\(|final|qualified|inter|,|\s))|\bicai\b/i },
  { id: "cpa", need: /\bcpa\b/i, have: /\bcpa\b/i }, { id: "cfa", need: /\bcfa\b/i, have: /\bcfa\b/i }, { id: "frm", need: /\bfrm\b/i, have: /\bfrm\b/i },
  { id: "acca", need: /\bacca\b/i, have: /\bacca\b/i }, { id: "cma", need: /\b(cma|icwa|cost accountant)\b/i, have: /\b(cma|icwa|cost accountant)\b/i },
  { id: "cs", need: /\bcompany secretary\b/i, have: /\bcompany secretary|\bacs\b|\bicsi\b/i },
  { id: "llb", need: /\b(llb|ll\.b|enrolled (advocate|with the bar)|qualified (lawyer|attorney))\b/i, have: /\bllb\b|\bll\.b\b|\badvocate\b|bar council/i },
  { id: "mbbs", need: /\bmbbs\b/i, have: /\bmbbs\b/i }, { id: "actuarial_exams", need: /\b(ifoa|iai|soa) (exams?|papers?)|actuarial exams?/i, have: /\b(ifoa|iai|soa)\b|actuarial exam|\bct\d\b|\bcs\d\b|\bcm\d\b/i },
  { id: "phd", need: /\bph\.?d\b/i, have: /\bph\.?d\b|doctorate/i },
  { id: "masters", need: /\b(master'?s degree|masters degree|\bm\.?tech\b|\bm\.?s\.? in\b|post[- ]?graduat(e|ion)) (is )?(required|mandatory|must)|\b(must|should) (have|hold) (a )?(master'?s|post[- ]?graduate)/i, have: /\bmaster|\bm\.?tech\b|\bm\.?sc?\b|\bmba\b|\bpgdm\b|post[- ]?graduat|\bm\.?com\b|\bma\b(?= in)/i },
];
const EDU = /\b(education|academic|qualification)s?\b/i;

export type Job = { id: string; title: string; specs: string[]; yearsMin: number | null; yearsMax: number | null; level: string; mustLines: string[]; allReq: string };
export type Person = { want: [string, number][]; level: string; years: number; stretch: boolean; resume: string; experience: string };
export type Item = { id: string; status: "demonstrated" | "listed" | "unverified" | "missing"; kind: "tool" | "credential" | "title-tool" };
export type Verdict = { eligible: boolean; why: string[]; agree: number | null; yearsFit: number; specialist: Item[]; unverified: number; shown: number };

export function jobFromDet(j: any): Job {
  const req = String(j.text?.requirements ?? ""), ess = (j.capabilities_essential?.value ?? []).map(String);
  const lines = [...req.split("\n"), ...ess].map((s) => s.trim()).filter(Boolean);
  const mustLines = [...new Set(lines.filter((l) => !NICE.test(l) && (MUSTY.test(l) || ess.includes(l))))];
  const band = String(req).match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(?:\+\s*)?(?:years|yrs)/i);
  const yMin = j.years_min?.basis === "stated" && Number.isFinite(j.years_min?.value) ? Number(j.years_min.value) : band ? Number(band[1]) : null;
  const yMax = band && Number(band[2]) >= Number(band[1]) && Number(band[2]) <= 40 ? Number(band[2]) : null;
  return { id: String(j.posting.id), title: String(j.posting.title ?? ""), specs: (j.specialisation?.value ?? []).map(String), yearsMin: yMin, yearsMax: yMax, level: j.seniority?.value ?? "mid", mustLines, allReq: req + "\n" + ess.join("\n") };
}

const has = (re: RegExp, t: string) => re.test(t);
export function gate(job: Job, p: Person): Verdict {
  const why: string[] = [];
  // 1. function
  let agree: number | null = null;
  if (job.specs.length) { agree = Math.max(...job.specs.map((s) => p.want.reduce((a, [k, w]) => a + w * transfer(k, s), 0))); if (agree < MIN_AGREE) why.push(`different function (${job.specs[0]})`); }
  // 2. experience
  let yearsFit = 1;
  if (job.yearsMin !== null && p.years > 0) {
    const short = job.yearsMin - p.years, slack = Math.max(1, 0.25 * job.yearsMin);
    if (short > slack) { why.push(`asks ${job.yearsMin}+ years, has ${p.years}`); yearsFit = 0; } else if (short > 0) yearsFit = 0.7;
    if (job.yearsMax !== null && p.years > job.yearsMax + 3) { why.push(`a step back (up to ${job.yearsMax} years, has ${p.years})`); yearsFit = 0; }
  } else {
    const lf = levelFit(p.level as any, job.level as any, p.stretch); yearsFit = lf; if (lf === 0) why.push(`seniority ${job.level} vs ${p.level}`);
  }
  // 3. specialist must-haves
  const items: Item[] = []; const resume = p.resume, expText = p.experience;
  const titleTools = SPECIALIST.filter((s) => has(s.re, job.title));
  for (const s of titleTools) if (!has(s.re, resume)) { items.push({ id: s.id, status: "missing", kind: "title-tool" }); why.push(`title asks ${s.id}, not on résumé`); }
  for (const line of job.mustLines) {
    const found = SPECIALIST.filter((s) => has(s.re, line) && !titleTools.some((t) => t.id === s.id));
    if (!found.length) continue;
    const st = found.map((s) => ({ id: s.id, status: (has(s.re, expText) ? "demonstrated" : has(s.re, resume) ? "listed" : "unverified") as Item["status"] }));
    if (ANY_OF.test(line) && found.length > 1) {   // alternatives: one of them is enough
      const best = st.find((x) => x.status === "demonstrated") ?? st.find((x) => x.status === "listed") ?? st[0];
      if (!items.some((i) => i.id === best.id)) items.push({ ...best, kind: "tool" });
    } else for (const x of st) if (!items.some((i) => i.id === x.id)) items.push({ ...x, kind: "tool" });
  }
  const eduListed = EDU.test(resume);
  for (const c of CREDS) for (const line of job.mustLines) {
    if (!has(c.need, line) || items.some((i) => i.id === c.id)) continue;
    if (ANY_OF.test(line) && CREDS.filter((o) => o.id !== c.id && has(o.need, line)).some((o) => has(o.have, resume))) continue;   // "CA or CMA" with CMA held
    const alternative = ANY_OF.test(line) && /\b(mba|pgdm|degree|graduate|post[- ]?graduate|equivalent|bachelor|b\.?com|m\.?com|master)/i.test(line.replace(c.need, ""));   // "CA / MBA Finance", "CPA or equivalent"
    const held = has(c.have, resume);
    const missing = !held && eduListed && !alternative;
    items.push({ id: c.id, status: held ? "demonstrated" : missing ? "missing" : "unverified", kind: "credential" });
    if (missing) why.push(`requires ${c.id}, not held`);
  }
  const tools = items.filter((i) => i.kind === "tool"), unverified = tools.filter((i) => i.status === "unverified").length, shown = items.filter((i) => i.status === "demonstrated" || i.status === "listed").length;
  if (unverified >= 2 && shown === 0) why.push(`${unverified} specialist must-haves not shown, none verified`);
  return { eligible: why.length === 0, why, agree, yearsFit, specialist: items, unverified, shown };
}

/** Evidence of suitability for an eligible job, 0..1: requirement coverage (transferable credited), function agreement,
 *  experience fit, retrieval relevance, share of specialist must-haves verified. Weights set before any result. */
export function rankScore(v: Verdict, ess: number, rel: number): number {
  const spec = v.specialist.filter((i) => i.kind !== "credential"); const verified = spec.length ? spec.filter((i) => i.status !== "unverified").length / spec.length : 0.6;
  return 0.35 * ess + 0.2 * (v.agree ?? 0.5) + 0.15 * v.yearsFit + 0.15 * rel + 0.15 * verified;
}
