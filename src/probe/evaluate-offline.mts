// The evaluation's rules with made-up postings and a made-up judge. No network, no model.
import { requirementsFor, memoryStore, postingKey, resumeLines, settle, evaluate, shortlist, bandOf, ask, type Posting, type Judged } from "../lib/evaluate.js";
import type { PostingProfile } from "../engine/sharpen.js";
let bad = 0; const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) bad++; console.log(`${ok ? "ok   " : "WRONG"} ${name}${ok ? "" : "  got " + JSON.stringify(got)}`); };
const prof = (must: string[], nice: string[] = [], years = ""): PostingProfile => ({ company: "X", title: "T", location: "Bengaluru", years_required: years, must_have: must, nice_to_have: nice, company_language: [], red_flags: [] });
const post = (id: string, text: string, company = "acme"): Posting => ({ id, title: "Credit Manager", company, text });

// what a posting asks is read once
{ let reads = 0; const store = memoryStore<PostingProfile>(); const read = async (t: string) => { reads++; return prof([`must from ${t.slice(0, 6)}`, "second must"]); };
  const ps = [post("1", "Same  text here"), post("2", "same text HERE"), post("3", "Other text")];
  const a = await requirementsFor(ps, store, read); check("two postings with the same text are read once", reads === 2 && a.readNow === 2 && a.by.size === 3, { reads, n: a.by.size });
  const b = await requirementsFor(ps, store, read); check("nothing already kept is read again", reads === 2 && b.readNow === 0 && b.by.size === 3, reads);
  check("the key is the text, not the id", postingKey("A  b") === postingKey("a b") && postingKey("a b") !== postingKey("a c"));
  const c = await requirementsFor([post("9", "broken")], store, async () => { throw new Error("model down"); }); check("a posting that could not be read is reported, not invented", c.by.size === 0 && c.failed[0] === "9", c.failed);
  const d = await requirementsFor([post("8", "empty")], store, async () => prof([])); check("a reading with no must-haves is not kept", d.by.size === 0 && store.size() === 2, store.size()); }

// evidence is checked in code
const lines = resumeLines("WORK EXPERIENCE\nRegional Credit Head, Vistaar — underwrote LAP and business loans up to 2 Cr\nLed a team of 12 credit managers across 4 states\nSKILLS\nCredit policy, CAM preparation, CIBIL\n\nB.Com, 2014");
check("the résumé becomes numbered lines without blanks", lines.length === 6 && lines[1].startsWith("Regional Credit Head"), lines.length);
const req = prof(["Underwrite secured business loans", "Lead a team of credit managers", "Prepare credit appraisal memos (CAM)", "Experience with SAP FICO"], ["Knowledge of co-lending"], "6-10 years");
const good: Judged["jobs"][0] = { n: 1, same_work: true, seniority: "right", why: "Underwrote LAP and business loans and led 12 credit managers.", r: [["s", 2], ["s", 3], ["k", 5], ["x", 0], ["x", 0]] };
const e1 = settle(post("1", "t"), req, good, lines, 8);
check("verdicts become matches with the résumé's own line as evidence", e1.matches[0].bucket === "said" && e1.matches[0].evidence.includes("underwrote LAP") && e1.matches[2].evidence_kind === "keyword" && e1.unsupported === 0, e1.matches[2]);
check("the score is the engine's fit of those buckets (2 said + 1 keyword of 4 musts, 1 nice missing → 49)", e1.score === 49, e1.score);
check("a role under the bar is not shown, and says why", !e1.shown && e1.reason === "too many of its must-haves are not on the résumé", e1.reason);
check("the gap is the first must-have that is missing", e1.gap === "Experience with SAP FICO");
const cheat = settle(post("1", "t"), req, { ...good, r: [["s", 99], ["s", 1], ["k", 6], ["s", 4], ["x", 0]] }, lines, 8);
check("a line that does not exist, a heading, and a 'keyword' line sharing no word are each counted as missing", cheat.unsupported === 4 && cheat.matches.every((m) => m.bucket === "missing"), [cheat.unsupported, cheat.matches.map((m) => m.bucket)]);
check("when the evidence does not hold up the role is not shown", !cheat.shown && cheat.reason === "the evidence did not hold up", cheat.reason);
const strong = prof(["Underwrite secured business loans", "Lead a team of credit managers"], [], "6-10 years"); const v = { ...good, r: [["s", 2], ["s", 3]] as [string, number][] };
check("a role whose must-haves are all shown is offered", settle(post("1", "t"), strong, v, lines, 8).shown && settle(post("1", "t"), strong, v, lines, 8).score === 97);
check("different kind of work: not shown, whatever the score", settle(post("1", "t"), strong, { ...v, same_work: false }, lines, 8).reason === "it is a different kind of work");
check("out of reach: not shown", settle(post("1", "t"), strong, { ...v, seniority: "out_of_reach" }, lines, 8).reason === "it is out of reach for now");
check("a step back: not shown", settle(post("1", "t"), strong, { ...v, seniority: "junior" }, lines, 8).reason === "it is a step back");
check("a stretch is shown", settle(post("1", "t"), strong, { ...v, seniority: "stretch" }, lines, 8).shown);
check("the posting's years band is applied in code: 14 years against 6–10", settle(post("1", "t"), strong, v, lines, 14).reason === "it asks 6–10 years");
check("…and 3 years against 6–10", settle(post("1", "t"), strong, v, lines, 3).reason === "it asks 6+ years");
check("…one year either side is let through", settle(post("1", "t"), strong, v, lines, 11).shown && settle(post("1", "t"), strong, v, lines, 5).shown);
check("years unknown: the band is not guessed at", settle(post("1", "t"), strong, v, lines, 0).shown);
check("no verdict for a posting: not shown", settle(post("1", "t"), strong, undefined, lines, 8).reason === "it could not be judged");
check("bands are read from the posting's own words", JSON.stringify([bandOf("5-8 years"), bandOf("8+ years of experience"), bandOf("Minimum 3 yrs"), bandOf("not stated")]) === JSON.stringify([{ min: 5, max: 8 }, { min: 8, max: null }, { min: 3, max: null }, null]), [bandOf("5-8 years"), bandOf("8+ years of experience"), bandOf("Minimum 3 yrs"), bandOf("not stated")]);

// the whole reading
{ const store = memoryStore<PostingProfile>(); const order: string[] = []; let live = 0, peakFirst = 0;
  const ps = Array.from({ length: 20 }, (_, i) => post(String(i + 1), `posting text ${i + 1}`, i === 8 ? "boom" : `emp${i % 3}`));
  const read = async () => strong;
  const judge = async (text: string, resume: string): Promise<Judged> => { live++; if (order.length === 0) peakFirst = live; order.push(text.slice(0, 12)); await new Promise((r) => setTimeout(r, 5)); live--;
    if (text.includes("| boom")) throw new Error("timeout");
    const n = (text.match(/POSTING \d+/g) ?? []).length; return { years: 8, jobs: Array.from({ length: n }, (_, i) => ({ ...v, n: i + 1 })) }; };
  const r = await evaluate(lines.join("\n"), ps, { store, read, judge });
  check("20 postings are judged in 3 calls of up to 8", r.calls === 3 && r.evals.length === 20, r.calls);
  check("the first call runs alone, so the résumé is cached before the rest read it", peakFirst === 1);
  check("a call that fails leaves its postings unjudged and unshown, never guessed", r.evals.slice(8, 16).every((e) => !e.shown && e.reason === "it could not be judged") && r.evals.slice(0, 8).every((e) => e.shown));
  check("the person's years come from the judgement", r.years === 8);
  const again = await evaluate(lines.join("\n"), ps, { store, read: async () => { throw new Error("should not be read again"); }, judge });
  check("a second reading takes every posting's requirements from what is kept", again.readNow === 0 && again.evals.filter((e) => e.shown).length === 12, again.readNow);
  const five = shortlist(r.evals, (id) => `emp${(Number(id) - 1) % 3}`);
  check("the list: at most five, at most two from one employer", five.length === 5 && Math.max(...Object.values(five.reduce((m: Record<string, number>, e) => { const k = `emp${(Number(e.id) - 1) % 3}`; m[k] = (m[k] ?? 0) + 1; return m; }, {}))) === 2, five.map((e) => e.id));
  check("only two reasonable roles: a list of two, not five", shortlist(r.evals.map((e, i) => (i < 2 ? e : { ...e, shown: false })), (id) => id).length === 2);
  check("nothing reasonable: an empty list", shortlist(r.evals.map((e) => ({ ...e, shown: false })), (id) => id).length === 0);
  check("what the judge is sent names each requirement as must or nice, with the years asked", /POSTING 1: Credit Manager \| emp0 \| asks: 6-10 years\n1\. M Underwrite/.test(ask(ps.slice(0, 1), new Map([["1", strong]]))), ask(ps.slice(0, 1), new Map([["1", strong]]))); }
if (bad) { console.error(`${bad} wrong`); process.exit(1); } console.log("all right");
