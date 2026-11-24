// The evaluation's rules with made-up postings and a made-up judge. No network, no model.
import { requirementsFor, memoryStore, postingKey, readerText, resumeLines, personText, settle, evaluate, shortlist, bandOf, ask, type Posting, type Judged } from "../lib/evaluate.js";
import type { PostingProfile } from "../engine/sharpen.js";
let bad = 0; const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) bad++; console.log(`${ok ? "ok   " : "WRONG"} ${name}${ok ? "" : "  got " + JSON.stringify(got)}`); };
const prof = (must: string[], nice: string[] = [], years = ""): PostingProfile => ({ company: "X", title: "T", location: "Bengaluru", years_required: years, must_have: must, nice_to_have: nice, company_language: [], red_flags: [] });
const post = (id: string, text: string, company = "acme"): Posting => ({ id, title: "Credit Manager", company, text });

// what a posting asks is read once
{ let reads = 0; const store = memoryStore<PostingProfile>(); const read = async (t: string) => { reads++; return prof([`must from ${t.slice(0, 6)}`, "second must"]); };
  const ps = [post("1", "Same  text here"), post("2", "same text HERE"), post("3", "Other text")];
  const a = await requirementsFor(ps, store, read, "m1"); check("two postings with the same text are read once", reads === 2 && a.readNow === 2 && a.by.size === 3, { reads, n: a.by.size });
  const b = await requirementsFor(ps, store, read, "m1"); check("nothing already kept is read again", reads === 2 && b.readNow === 0 && b.by.size === 3, reads);
  const K = (title: string, company: string, text: string, model?: string) => postingKey({ title, company, text }, model ?? "m1");
  check("the key ignores spacing and capitals, and the posting's id", K("Analyst", "Acme", "A  b") === K("analyst", "ACME", "a b"));
  check("a different text is a different key", K("Analyst", "Acme", "a b") !== K("Analyst", "Acme", "a c"));
  check("the same text under a different title is a different key", K("Analyst", "Acme", "a b") !== K("Senior Manager", "Acme", "a b"));
  check("the same text at a different employer is a different key", K("Analyst", "Acme", "a b") !== K("Analyst", "Other", "a b"));
  check("a different model is a different key", K("Analyst", "Acme", "a b", "model-one") !== K("Analyst", "Acme", "a b", "model-two"));
  check("the reader is shown the title and employer with the text", readerText({ title: "Analyst", company: "Acme", text: "body" }) === "Analyst | Acme\n\nbody");
  { let n = 0; const st = memoryStore<PostingProfile>(); const slow = async () => { n++; await new Promise((r) => setTimeout(r, 20)); return prof(["a must have", "another must"]); };
    const same = [post("1", "one text"), post("2", "two text")];
    const [x, y] = await Promise.all([requirementsFor(same, st, slow, "m1"), requirementsFor(same, st, slow, "m1")]);
    check("two requests at the same moment read each posting once between them", n === 2 && x.by.size === 2 && y.by.size === 2 && x.readNow + y.readNow === 2, { n, x: x.readNow, y: y.readNow });
    let f = 0; const st2 = memoryStore<PostingProfile>(); const fail = async () => { f++; await new Promise((r) => setTimeout(r, 10)); throw new Error("down"); };
    const [p1, p2] = await Promise.all([requirementsFor([post("1", "z")], st2, fail, "m1"), requirementsFor([post("1", "z")], st2, fail, "m1")]);
    check("a reading that fails is not kept, and can be tried again later", f === 1 && p1.failed.length === 1 && p2.failed.length === 1 && (await requirementsFor([post("1", "z")], st2, async () => prof(["now it works", "second"]), "m1")).by.size === 1, f); }
  const c = await requirementsFor([post("9", "broken")], store, async () => { throw new Error("model down"); }, "m1"); check("a posting that could not be read is reported, not invented", c.by.size === 0 && c.failed[0] === "9", c.failed);
  const d = await requirementsFor([post("8", "empty")], store, async () => prof([]), "m1"); check("a reading with no must-haves is not kept", d.by.size === 0 && store.size() === 2, store.size()); }

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
const yesToAll = async (items: string) => ({ a: [...items.matchAll(/\[(\d+\.\d+)\]/g)].map((m) => [m[1], "yes"] as [string, string]) });
{ const store = memoryStore<PostingProfile>(); const order: string[] = []; let live = 0, peakFirst = 0;
  const ps = Array.from({ length: 20 }, (_, i) => post(String(i + 1), `posting text ${i + 1}`, i === 8 ? "boom" : `emp${i % 3}`));
  const read = async () => strong;
  const judge = async (text: string, resume: string): Promise<Judged> => { live++; if (order.length === 0) peakFirst = live; order.push(text.slice(0, 12)); await new Promise((r) => setTimeout(r, 5)); live--;
    if (text.includes("| boom")) throw new Error("timeout");
    const n = (text.match(/POSTING \d+/g) ?? []).length; return { years: 8, jobs: Array.from({ length: n }, (_, i) => ({ ...v, n: i + 1 })) }; };
  const r = await evaluate(lines.join("\n"), ps, { store, read, model: "m1", judge, audit: yesToAll });
  check("20 postings are judged in 3 calls of up to 8; the batch that failed is tried again as two halves", r.calls === 5 && r.retries === 1 && r.evals.length === 20, [r.calls, r.retries]);
  check("the first call runs alone, so the résumé is cached before the rest read it", peakFirst === 1);
  check("the half that fails again stays unjudged and unshown, never guessed; the other half is judged", r.evals.slice(8, 12).every((e) => !e.shown && e.reason === "it could not be judged") && r.evals.slice(12, 16).every((e) => e.shown) && r.evals.slice(0, 8).every((e) => e.shown), r.evals.slice(8, 16).map((e) => e.reason));
  check("the person's years come from the judgement", r.years === 8);
  const again = await evaluate(lines.join("\n"), ps, { store, read: async () => { throw new Error("should not be read again"); }, model: "m1", judge, audit: yesToAll });
  check("a second reading takes every posting's requirements from what is kept", again.readNow === 0 && again.evals.filter((e) => e.shown).length === 16, again.readNow);
  const five = shortlist(r.evals, (id) => `emp${(Number(id) - 1) % 3}`);
  check("the list: at most five, at most two from one employer", five.length === 5 && Math.max(...Object.values(five.reduce((m: Record<string, number>, e) => { const k = `emp${(Number(e.id) - 1) % 3}`; m[k] = (m[k] ?? 0) + 1; return m; }, {}))) === 2, five.map((e) => e.id));
  check("only two reasonable roles: a list of two, not five", shortlist(r.evals.map((e, i) => (i < 2 ? e : { ...e, shown: false })), (id) => id).length === 2);
  check("nothing reasonable: an empty list", shortlist(r.evals.map((e) => ({ ...e, shown: false })), (id) => id).length === 0);
  check("what the judge is sent names each requirement as must or nice, with the years asked", /POSTING 1: Credit Manager \| emp0 \| asks: 6-10 years\n1\. M Underwrite/.test(ask(ps.slice(0, 1), new Map([["1", strong]]))), ask(ps.slice(0, 1), new Map([["1", strong]]))); }

// the second reader: every role that would be shown has its evidence read again on its own
{ const store = memoryStore<PostingProfile>(); const ps = [post("1", "p one", "e1"), post("2", "p two", "e2"), post("3", "p three", "e3"), post("4", "p four", "e4")];
  const three = prof(["Underwrite secured business loans", "Lead a team of credit managers", "Prepare credit appraisal memos"], [], "6-10 years");
  const judge = async (text: string): Promise<Judged> => ({ years: 8, jobs: (text.match(/POSTING \d+/g) ?? []).map((_, i) => ({ n: i + 1, same_work: i !== 3, seniority: "right" as const, why: "w", r: [["s", 2], ["s", 3], ["s", 5]] as [string, number][] })) });
  let seen = ""; const audit = async (items: string) => { seen = items; return { a: [["1.1", "yes"], ["1.2", "yes"], ["1.3", "yes"], ["2.1", "yes"], ["2.2", "no"], ["2.3", "no"], ["3.1", "partial"], ["3.2", "partial"] /* 3.3 not answered */] as [string, string][] }; };
  const r = await evaluate(lines.join("\n"), ps, { store, read: async () => three, model: "m1", judge, audit });
  check("the auditor sees only requirement and line: no posting, no first verdict", /^\[1\.1\] REQUIREMENT: Underwrite secured business loans\nLINE: Regional Credit Head/.test(seen) && !/POSTING|"s"|same_work/.test(seen), seen.slice(0, 120));
  check("a role the first reader turned down is not sent to the auditor", !seen.includes("[4.") && r.audited === 3 && r.auditCalls === 1, [r.audited, r.auditCalls]);
  check("evidence the auditor confirms stands", r.evals[0].shown && r.evals[0].score === 97 && r.evals[0].audited);
  check("evidence the auditor rejects is counted as missing, and the role drops out", !r.evals[1].shown && r.evals[1].unsupported === 2 && r.evals[1].matches[1].bucket === "missing", [r.evals[1].reason, r.evals[1].unsupported]);
  check("'partial' counts one step lower; an item the auditor skipped is not taken on trust", r.evals[2].weakened === 2 && r.evals[2].matches[0].evidence_kind === "line" && r.evals[2].matches[2].bucket === "missing" && !r.evals[2].shown, [r.evals[2].weakened, r.evals[2].matches.map((m) => m.bucket)]);
  const none = await evaluate(lines.join("\n"), ps, { store, read: async () => three, model: "m1", judge, audit: undefined as any });
  check("there is no way round the audit: called without an auditor, nothing is shown", none.evals.every((e) => !e.shown) && none.evals[0].reason === "its evidence could not be checked" && none.audited === 0, none.evals.map((e) => e.reason));
  const down = await evaluate(lines.join("\n"), ps, { store, read: async () => three, model: "m1", judge, audit: async () => { throw new Error("timeout"); } });
  check("if the audit cannot run, nothing unaudited is shown", down.evals.every((e) => !e.shown) && down.evals[0].reason === "its evidence could not be checked", down.evals.map((e) => e.reason)); }

// what the person told us is kept apart from the résumé
{ const person = personText(lines.join("\n"), [{ ask: "Have you underwritten unsecured business loans?", answer: "Yes, up to 50 lakh at my last two employers" }, { ask: "ignored", answer: "" }]);
  check("answers are shown to the judge apart from the résumé, numbered on from it", person.answersFrom === 7 && /ANSWERS THE PERSON GAVE US \(their own statements; NOT on the résumé\)\n7\| Asked: Have you/.test(person.text) && person.lines.length === 7, person.answersFrom);
  const rq = prof(["Underwrite unsecured business loans", "Lead a team of credit managers"]);
  const e = settle(post("1", "t"), rq, { n: 1, same_work: true, seniority: "right", why: "you told us …", r: [["s", 7], ["s", 3]] }, person.lines, 8, { answersFrom: person.answersFrom });
  check("evidence from an answer is never 'said': it is marked as told, with the person's own words", e.matches[0].bucket === "have_not_said" && e.matches[0].told === true && e.matches[0].evidence.startsWith("Asked: Have you") && e.from_answers === 1, e.matches[0]);
  check("evidence from the résumé is not marked as told", e.matches[1].bucket === "said" && e.matches[1].told === undefined);
  check("an answer counts as a line that could say it, not as a résumé line (1 said + 1 told of 2 musts → 75, not 97)", e.score === 75, e.score);
  check("no answers: nothing is attributed to answers", settle(post("1", "t"), rq, { n: 1, same_work: true, seniority: "right", why: "", r: [["s", 2], ["s", 3]] }, lines, 8).from_answers === 0); }
if (bad) { console.error(`${bad} wrong`); process.exit(1); } console.log("all right");
