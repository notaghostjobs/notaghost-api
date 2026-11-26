// Late-requirement tests: what reaches extraction and the judge when a posting's decisive requirement sits after
// character 6,000, and what the gate then shows. Uses the frozen code paths (extractUser, validateCJR, judgeUser,
// validateVerdict, eligibility, gate). The "judge" here is an idealised reader limited to its own request text (not a
// model): it shows the best any judge could do with the input it is given. No network, no spend.
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/eval/late-req.test.mts
import assert from "node:assert/strict";
const { extractUser, validateCJR, EXTRACT_SYSTEM } = await import("../../v2/cjr.js"); const { judgeUser, validateVerdict, eligibility, JUDGE_SYSTEM, candidateBlock } = await import("../../v2/pipeline.js");
const G = await import("../gate.js"); const MK = await import("./mock.js"); const J3 = await import("../judge3.js"); const A = await import("../api3.js");
let n = 0; const t = async (name: string, f: () => any) => { await f(); n++; console.log("ok", n, name); };

const OPEN = "Fable Software is hiring a Senior Backend Engineer in Bengaluru.\nWhat you will do\n" + "• Build and run payment services in Java and Spring Boot for millions of customers across India.\n".repeat(70) + "Requirements\n• 3+ years of Java and Spring Boot microservices experience.\n";
const LATE_CKA = "Certified Kubernetes Administrator (CKA) certification is mandatory for this role.";
const LATE_YRS = "Minimum 8 years of backend engineering experience is mandatory.";
const LATE_CA = "Must be a qualified Chartered Accountant (ICAI member).";
const posting = (late: string[]) => `${OPEN}\nAdditional requirements\n${late.map((x) => `• ${x}`).join("\n")}\n`;
const cand = { years_total: { value: 5, basis: "dated_roles" }, level_read: "senior", roles: [{ title: "Senior Software Engineer", from: 2021, to: 2026 }], work_lines: ["Built Java and Spring Boot microservices for payment APIs", "Designed REST APIs and Kafka consumers"], achievement_lines: [], project_lines: [], summary_lines: [], listed_lines: ["Java, Spring Boot, Kafka"], education_lines: ["B.Tech Computer Science, 2019"], led_lines: [], skills: [], target: { functions: [["Backend engineering", 1]], level: "senior", open_to_adjacent: "yes", transition: "no", exclusions: [], source: "candidate" } };
const block = candidateBlock(cand as any);
const job = (text: string) => ({ id: "J1", title: "Senior Backend Engineer", company: "Fable Software", text });
/** Requirement record as an extractor would return it: every quoted line, or only those `keep` accepts (simulated omission). */
function record(text: string, keep: (q: string) => boolean = () => true, years: { min: number | null; quote: string | null } = { min: 3, quote: "3+ years of Java and Spring Boot microservices experience" }) {
  const lines = text.split("\n").map((l) => l.replace(/^•\s*/, "").trim()).filter((l) => /\b(years|mandatory|must|certification)\b/i.test(l) && l.length >= 12);
  const raw = { function: "backend engineering", specialisation: "Java payments", responsibilities: [], mandatory: lines.filter(keep).map((q) => ({ text: q, quote: q, kind: /certif|chartered/i.test(q) ? "credential" : "experience", alternatives: [] })), secondary: [], preferred: [], years: { ...years, max: null }, seniority: "senior", manages_people: false, location: { city: null, work_mode: "unknown", quote: null }, credentials: [], usable: true, usable_reason: null };
  const v = validateCJR(raw, { id: "J1", text, title: "Senior Backend Engineer" }, "claude-sonnet-5-5"); assert.ok(v.ok, JSON.stringify((v as any).errors)); return (v as any).cjr;
}
/** Idealised judge limited to its request: credentials and the strictest stated years must be shown; conflicting minimums → cannot judge. */
function idealJudge(request: string, evidence: string) {
  const reqJson = JSON.parse(/REQUIREMENTS \(extracted, each with its source text\):\n(.*)\nJOB TEXT:/s.exec(request)![1]); const text = request.split("\nJOB TEXT:\n")[1] ?? "";
  const quotes: string[] = [...reqJson.mandatory.map((m: any) => m.quote), ...(reqJson.years?.quote ? [reqJson.years.quote] : [])];
  const visible = `${quotes.join("\n")}\n${text}`;
  const mins = [...visible.matchAll(/(?:minimum\s+)?(\d{1,2})\s*\+?\s*years/gi)].map((m) => +m[1]); const distinct = [...new Set(mins)];
  const core: any[] = reqJson.mandatory.map((m: any) => {
    if (/\bcertif|chartered\b/i.test(m.quote)) return { requirement: m.text, job_quote: m.quote, status: /\bCKA\b|Kubernetes Administrator|Chartered Accountant/i.test(evidence) ? "demonstrated" : "confirmed_gap", resume_quote: null };
    return { requirement: m.text, job_quote: m.quote, status: "demonstrated", resume_quote: "Built Java and Spring Boot microservices for payment APIs" }; });
  const textOnlyCred = /certification is mandatory|qualified Chartered Accountant/i.test(text) && !quotes.some((q) => /certif|chartered/i.test(q));
  if (textOnlyCred) core.push({ requirement: "credential stated in the posting", job_quote: /([^.\n]*(certification is mandatory|qualified Chartered Accountant)[^.\n]*)/i.exec(text)![1].trim(), status: "confirmed_gap", resume_quote: null });
  const fit = distinct.length > 1 ? "cannot_judge" : core.some((k) => k.status === "confirmed_gap") ? "unsuitable" : "direct";
  return { verdicts: [{ job_id: "J1", fit, function: "same", specialisation: "same", seniority: "right", core, gaps: [], unverified: [], why: distinct.length > 1 ? `conflicting minimum years: ${distinct.join(" vs ")}` : "x", confidence: "high" }] };
}
const evidence = block;
/** judgeText "frozen" = V2's judgeUser (first 6,000 characters); "full" = V3's judgeUserFull (approved Option A, now in use). */
function outcome(text: string, cjr: any, judgeText = "full") {
  const b = [{ ...job(text), cjr }]; const request = judgeText === "full" ? J3.judgeUserFull(b) : judgeUser(b);
  const raw = idealJudge(request, evidence).verdicts[0]; const v = validateVerdict(raw, job(text), block, block);
  const d = G.decide(v as any, { compat: { verdict: "fit", reasons: [] }, anchors: { status: "met", detail: [] }, eligible: !eligibility({ id: "J1", title: "Senior Backend Engineer", location: "Bengaluru", text, invalid: false, closed: false }, cand as any, block).excluded, employer: "Fable Software", title: "Senior Backend Engineer" });
  return { request, verdict: v, tier: d.tier, reasons: d.reasons };
}

await t("effective inputs: extraction gets the complete text; the judge gets the extracted record plus the first 6,000 characters", () => {
  const text = posting([LATE_CKA, LATE_YRS]); assert.ok(text.indexOf(LATE_CKA) > 6000 && text.indexOf(LATE_YRS) > 6000, "fixture: both decisive lines after character 6,000");
  const xu = extractUser("Senior Backend Engineer", "Fable Software", text); assert.ok(xu.includes(LATE_CKA) && xu.includes(LATE_YRS), "extraction request carries the whole posting");
  const ju = judgeUser([{ ...job(text), cjr: record(text) }]); const jt = ju.split("\nJOB TEXT:\n")[1]; assert.equal(jt.length, 6000, "judge text is cut at 6,000"); assert.ok(!jt.includes(LATE_CKA) && !jt.includes(LATE_YRS));
  assert.ok(ju.includes(LATE_CKA) && ju.includes(LATE_YRS), "…but the extracted record carries both late requirements, with their quotes");
  assert.ok(!/"preferred"|"responsibilities"|"location"/.test(ju.split("\nJOB TEXT:")[0]), "preferred items, responsibilities and location are not passed to the judge");
  assert.ok(EXTRACT_SYSTEM.includes("Read the WHOLE posting"));
});
await t("1. late requirement captured by extraction → the unsuitable candidate is rejected", () => { const text = posting([LATE_CKA]); const o = outcome(text, record(text)); assert.equal(o.tier, "rejected"); assert.match(o.reasons.join(), /judged unsuitable|confirmed gap/); });
await t("2. [frozen V2 judge input] late requirement omitted by extraction → the judge cannot see it → a strong match is shown (the defect)", () => {
  const text = posting([LATE_CKA]); const o = outcome(text, record(text, (q) => !/CKA/.test(q)), "frozen"); assert.equal(o.tier, "strong"); assert.ok(!o.request.includes("CKA"), "nothing in the judge's input mentions the requirement");
});
await t("2c. [V3 judgeUserFull] same omission: the judge reads the late requirement in the text → rejected", () => { const text = posting([LATE_CKA]); const o = outcome(text, record(text, (q) => !/CKA/.test(q)), "full"); assert.equal(o.tier, "rejected"); });
await t("3. conflicting opening and closing requirements, both extracted → the case is not judgeable (not shown)", () => { const text = posting([LATE_YRS]); const o = outcome(text, record(text)); assert.notEqual(o.tier, "strong"); assert.equal(o.verdict.fit, "cannot_judge"); });
await t("3b. [frozen V2 judge input] conflict where extraction keeps only the opening value → a strong match is shown (the defect)", () => { const text = posting([LATE_YRS]); const o = outcome(text, record(text, (q) => !/Minimum 8 years/.test(q)), "frozen"); assert.equal(o.tier, "strong"); });
await t("3c. [V3 judgeUserFull] same conflict: both values visible → not shown", () => { const text = posting([LATE_YRS]); const o = outcome(text, record(text, (q) => !/Minimum 8 years/.test(q)), "full"); assert.notEqual(o.tier, "strong"); });
await t("4. extraction fails or is truncated → no record → cannot judge, never shown", () => { const text = posting([LATE_CKA]); const d = G.decide({ job_id: "J1", fit: "cannot_judge", failed: "no extracted requirements", core: [] } as any, { compat: { verdict: "fit", reasons: [] }, anchors: { status: "met", detail: [] }, eligible: true, employer: "x", title: "y" }); assert.equal(d.tier, "rejected"); });
await t("5. a stated licence after character 6,000 (CA, MBBS, advocate) is caught by deterministic eligibility on the full text, whatever extraction does", () => { const text = posting([LATE_CA]); const o = outcome(text, record(text, (q) => !/Chartered/.test(q))); assert.equal(o.tier, "rejected"); assert.match(o.reasons.join(), /not eligible/); });
await t("6. the mock extractor (line-based, complete text) records late requirements: the plumbing carries them", async () => {
  const text = posting([LATE_CKA, LATE_YRS]); const f = MK.mockFetch(); const r = await f("x", { body: JSON.stringify({ system: [{ text: EXTRACT_SYSTEM }], messages: [{ content: extractUser("Senior Backend Engineer", "Fable Software", text) }], max_tokens: 4000 }) } as any);
  const body: any = await (r as any).json(); const raw = JSON.parse(body.content[0].text); const v = validateCJR(raw, { id: "J1", text, title: "Senior Backend Engineer" }, "m"); assert.ok(v.ok); assert.ok((v as any).cjr.mandatory.some((m: any) => /CKA/.test(m.quote)) && (v as any).cjr.mandatory.some((m: any) => /Minimum 8 years/.test(m.quote)));
});
await t("7. [V3] judgeUserFull keeps the j3 format and the complete text; late requirements sit in JOB TEXT", () => {
  const text = posting([LATE_CKA, LATE_YRS]); const cj = record(text); const full = J3.judgeUserFull([{ ...job(text), cjr: cj }]), old = judgeUser([{ ...job(text), cjr: cj }]);
  assert.equal(full.split("\nJOB TEXT:\n")[0], old.split("\nJOB TEXT:\n")[0], "same header and requirement record as frozen j3"); assert.equal(full.split("\nJOB TEXT:\n")[1], text, "the complete text");
  assert.ok(full.split("\nJOB TEXT:\n")[1].includes(LATE_CKA) && full.split("\nJOB TEXT:\n")[1].includes(LATE_YRS));
});
await t("8. [V3] every outcome case is safe with the full-text judge (no strong match for the unsuitable candidate)", () => {
  for (const late of [[LATE_CKA], [LATE_YRS], [LATE_CKA, LATE_YRS], [LATE_CA]]) { const text = posting(late);
    for (const keep of [() => true, (q: string) => !late.some((l) => q.includes(l.slice(0, 25)))]) assert.notEqual(outcome(text, record(text, keep)).tier, "strong", late.join(" + ")); }
});
await t("9. oversized judge requests: never cut; batches shrink to fit; a job that cannot fit alone is not judged", () => {
  const big = (i: number, chars: number) => ({ ...job("x".repeat(chars)), id: `J${i}`, cjr: record(posting([LATE_CKA])) });
  assert.throws(() => J3.judgeUserFull([big(1, 60001)]), /must be flagged oversized, not cut/);
  const five = [1, 2, 3, 4, 5].map((i) => big(i, 60000)); const b1 = J3.batchJobs(five, 12000); assert.equal(b1.batches.length, 1, "five maximum-size postings fit one request within the 150k-token budget"); assert.ok(J3.estTokens(12000 + J3.judgeUserFull(b1.batches[0]).length) <= J3.JUDGE_INPUT_TOKEN_BUDGET);
  const b2 = J3.batchJobs(five, 12000, { inputBudget: 60000 }); assert.ok(b2.batches.length > 1 && b2.batches.every((b) => J3.estTokens(12000 + J3.judgeUserFull(b).length) <= 60000), "a smaller budget splits batches instead of cutting text"); assert.equal(b2.batches.flat().length, 5);
  const b3 = J3.batchJobs([big(9, 60000)], 12000, { inputBudget: 10000 }); assert.deepEqual(b3.tooLarge.map((x) => x.id), ["J9"]); assert.equal(b3.batches.length, 0);
  assert.ok(b1.maxTokens(b1.batches[0]) <= J3.MODEL_MAX_OUTPUT_TOKENS && b1.maxTokens(b1.batches[0]) >= 10000); assert.ok(J3.JUDGE_INPUT_TOKEN_BUDGET + b1.maxTokens(b1.batches[0]) < J3.MODEL_CONTEXT_TOKENS);
});
await t("10. the guard reserves for the larger request: worst case grows with the full text and covers full max_tokens", () => {
  const text = posting([LATE_CKA]); const cj = record(text); const sys = JUDGE_SYSTEM(block); const oldU = judgeUser([{ ...job(text), cjr: cj }]), newU = J3.judgeUserFull([{ ...job(text), cjr: cj }]);
  assert.ok(A.worstCase3(sys.length, newU.length, 10000) > A.worstCase3(sys.length, oldU.length, 10000)); assert.ok(A.worstCase3(sys.length, newU.length, 10000) >= ((Math.ceil((sys.length + newU.length) / 2.5) * A.PRICE.in + 10000 * A.PRICE.out) / 1e6) * A.INR_PER_USD);
});
console.log(`${n} tests passed`);
