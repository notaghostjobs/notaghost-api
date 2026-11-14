// QA safety self-check: runs on every build of the qa branch (npm run build). It proves, without a database or a network,
// that an unsafe QA configuration is refused and that QA's network boundary sends no message and reaches no stranger.
process.env.GHOSTED_ENV = "qa"; process.env.WA_TOKEN = "qa-simulated"; process.env.QA_PUBLIC_URL = "https://ghosted-qa-api.example"; process.env.SUPABASE_URL = "https://qaqaqaqaqaqaqaqaqaqa.supabase.co";
const { qaProblems, isQa, qaPhone, qaIdOf, qaNumber, QA_PHONE, PROD_SUPABASE_REFS } = await import("../qa/guard.js");
const { installQaNetwork } = await import("../qa/net.js");
const { hasQaAccess } = await import("../qa/routes.js");

let failed = 0; const ok = (name: string, pass: boolean, detail = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : ` — ${detail}`}`); if (!pass) failed++; };
const NOW = Date.parse("2026-11-14T10:00:00Z");
const good: Record<string, string> = { GHOSTED_ENV: "qa", SUPABASE_URL: "https://qaqaqaqaqaqaqaqaqaqa.supabase.co", QA_SUPABASE_REF: "qaqaqaqaqaqaqaqaqaqa", RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "x", RAZORPAY_WEBHOOK_SECRET: "y", WA_TOKEN: "qa-simulated", WA_PHONE_ID: "qa-simulated", OTP_PROVIDER: "whatsapp",
  QA_ACCESS_TOKEN: "a".repeat(40), QA_ACCESS_EXPIRES: "2026-11-28T00:00:00Z", QA_AI_KEY_IS_SEPARATE: "yes", QA_AI_BUDGET_INR: "1000", QA_PUBLIC_URL: "https://ghosted-qa-api.example", APP_ORIGIN: "https://ghosted-qa.example" };
const bad = (patch: Record<string, string | undefined>, re: RegExp) => qaProblems({ ...good, ...patch }, NOW).some((p) => re.test(p));
console.log("QA safety self-check");
ok("a correct QA configuration is accepted", qaProblems(good, NOW).length === 0, qaProblems(good, NOW).join(" | "));
ok("the production database is refused", bad({ SUPABASE_URL: `https://${PROD_SUPABASE_REFS[0]}.supabase.co`, QA_SUPABASE_REF: PROD_SUPABASE_REFS[0] }, /PRODUCTION/));
ok("a database that was not declared as QA's is refused", bad({ QA_SUPABASE_REF: "someotherproject0000" }, /QA_SUPABASE_REF/) && bad({ QA_SUPABASE_REF: undefined }, /QA_SUPABASE_REF/));
ok("a live Razorpay key is refused", bad({ RAZORPAY_KEY_ID: "rzp_live_abc123" }, /test-mode/));
ok("a real WhatsApp token is refused", bad({ WA_TOKEN: "EAAG-real-token" }, /WhatsApp/) && bad({ WA_PHONE_ID: "104857600000000" }, /WhatsApp/));
ok("an SMS or email provider key is refused", bad({ MSG91_AUTHKEY: "k" }, /SMS and email/) && bad({ RESEND_API_KEY: "re_x" }, /SMS and email/));
ok("a real OTP provider is refused", bad({ OTP_PROVIDER: "msg91" }, /OTP_PROVIDER/) && bad({ OTP_PROVIDER: "dev" }, /OTP_PROVIDER/));
ok("a fixed sign-in code, test phones or an admin secret are refused", bad({ OTP_DEV_CODE: "123456" }, /OTP_DEV_CODE/) && bad({ OTP_TEST_PHONES: "+919999999999" }, /OTP_TEST_PHONES/) && bad({ ADMIN_SECRET: "s" }, /ADMIN_SECRET/));
ok("a short, missing, expired or never-expiring access token is refused", bad({ QA_ACCESS_TOKEN: "short" }, /32 characters/) && bad({ QA_ACCESS_EXPIRES: "2026-11-01T00:00:00Z" }, /expired/) && bad({ QA_ACCESS_EXPIRES: "2027-06-01T00:00:00Z" }, /31 days/) && bad({ QA_ACCESS_EXPIRES: undefined }, /must be a date/));
ok("an undeclared AI key or a budget over ₹1,000 is refused", bad({ QA_AI_KEY_IS_SEPARATE: undefined }, /dedicated QA key/) && bad({ QA_AI_BUDGET_INR: "5000" }, /between 1 and 1000/));
ok("an address that points at production is refused", bad({ APP_ORIGIN: "https://notaghost.jobs" }, /production/) && bad({ QA_PUBLIC_URL: "https://notaghost-api.onrender.com" }, /production/));
ok("QA is off unless switched on", isQa({}) === false && isQa({ GHOSTED_ENV: "production" }) === false && isQa({ GHOSTED_ENV: "qa" }) === true);
ok("QA identities are numbers no phone can have", qaPhone(1) === "+910000001001" && qaPhone(100) === "+910000001100" && qaIdOf("+910000001007") === "QA007" && qaIdOf("+919952037479") === null && qaNumber("qa010") === 10 && qaNumber("QA101") === 0 && QA_PHONE.test(qaPhone(55)) && !/^\+91[6-9]/.test(qaPhone(55)));

// the network boundary, exercised for real: outbound calls made through fetch after it is installed
let reached: string[] = [];
globalThis.fetch = (async (u: any) => { reached.push(String(u)); return new Response("{}", { status: 200 }); }) as any;   // stands in for the real network: records anything that gets through
installQaNetwork();
const wa = await fetch("https://graph.facebook.com/v21.0/qa-simulated/messages", { method: "POST", headers: { Authorization: "Bearer qa-simulated" }, body: JSON.stringify({ messaging_product: "whatsapp", to: "910000001001", type: "template", template: { name: "ghosted_signin_code", components: [{ type: "body", parameters: [{ type: "text", text: "482913" }] }] } }) });
const waBody: any = await wa.json();
ok("a WhatsApp send is answered by the simulator and never leaves", wa.status === 200 && String(waBody.messages?.[0]?.id).startsWith("wamid.QA.") && !reached.some((u) => u.includes("graph.facebook.com")), JSON.stringify([wa.status, waBody, reached]));
let threw = ""; try { await fetch("https://control.msg91.com/api/v5/otp", { method: "POST", body: "{}" }); } catch (e) { threw = (e as Error).message; }
ok("an SMS send is refused", /not allowed/.test(threw) && !reached.some((u) => u.includes("msg91")), threw);
threw = ""; try { await fetch(`https://${PROD_SUPABASE_REFS[0]}.supabase.co/rest/v1/users`); } catch (e) { threw = (e as Error).message; }
ok("a call to the production database is refused at the network", /production database/.test(threw) && !reached.some((u) => u.includes(PROD_SUPABASE_REFS[0])), threw);
const stranger = await fetch("https://www.linkedin.com/jobs/view/1");
ok("a real job site is not reachable from QA", stranger.status === 599 && !reached.some((u) => u.includes("linkedin")), String(stranger.status));
reached = reached.filter((u) => !u.includes("qaqaqaqaqaqaqaqaqaqa.supabase.co"));   // QA's own database is where the outbox is written
await fetch("https://ghosted-qa-api.example/qa/jobs/pm-mid"); await fetch("https://api.anthropic.com/v1/messages");
ok("QA's own pages and the AI provider are reachable, and nothing else got through", reached.length === 2 && reached[0].includes("ghosted-qa-api.example") && reached[1].includes("api.anthropic.com"), JSON.stringify(reached));
process.env.QA_ACCESS_TOKEN = "a".repeat(40); process.env.QA_ACCESS_EXPIRES = new Date(Date.now() + 86400e3).toISOString();
ok("the access token is needed, exact, and expires", hasQaAccess("a".repeat(40)) && !hasQaAccess("a".repeat(39)) && !hasQaAccess("b".repeat(40)) && !hasQaAccess(undefined) && ((process.env.QA_ACCESS_EXPIRES = new Date(Date.now() - 1000).toISOString()), !hasQaAccess("a".repeat(40))));

// ---------- import format, personal-data screen, and the independent evaluation ----------
{
  const { readFileSync } = await import("node:fs"); const { extractText } = await import("../engine/extract.js");
  const { checkPackage, checkJobs, screen, builtInSlugs } = await import("../qa/truth.js"); const { evaluate, evalMeter } = await import("../qa/evaluate.js");
  console.log("QA import and evaluation self-check");
  const clean = "Leela Varghese · +91 00000 01001 · leela@example.com · grew GMV to ₹1,400 crore, 200,000 sq ft, 2019-2021, 1,20,000 orders, www.example.com/work";
  ok("the screen accepts QA contact details, money, areas and date ranges", screen(clean, "t").length === 0, screen(clean, "t").join(" | "));
  const dirty = ["call +91 98765 43210", "9876543210", "mail me at someone@gmail.com", "linkedin.com/in/someone", "https://myportfolio.io/me", "PAN ABCDE1234F", "1234 5678 9012", "Date of birth: 1 Jan 1990"];
  ok("the screen stops real-looking phones, e-mails, profile links, identity numbers and personal particulars", dirty.every((d) => screen(d, "t").length > 0), dirty.filter((d) => !screen(d, "t").length).join(" | "));
  const buf = readFileSync("seed/qa/example/QA001.pdf"); const x = await extractText(buf, "QA001.pdf"); const raw = JSON.parse(readFileSync("seed/qa/example/QA001.truth.json", "utf8")); const jobsRaw = JSON.parse(readFileSync("seed/qa/example/jobs.json", "utf8"));
  const pdf = { text: x.text, pages: x.pages, bytes: buf.length, isPdf: true }; const known = new Set([...builtInSlugs(), ...jobsRaw.roles.map((r: any) => r.slug)]);
  const pk = checkPackage(raw, pdf, "QA001", known);
  ok("the worked example package passes the import checks with no warning", pk.ok && pk.warnings.length === 0, [...pk.errors, ...pk.warnings].join(" | "));
  const refuse = (patch: (t: any) => void, re: RegExp, p2: any = pdf, id = "QA001") => { const t = structuredClone(raw); patch(t); return checkPackage(t, p2, id, known).errors.some((e) => re.test(e)); };
  ok("import refuses: not declared synthetic", refuse((t) => { t.synthetic = false; }, /synthetic/));
  ok("import refuses: derived from a real résumé but not fictionalised", refuse((t) => { t.provenance = { basis: "derived_from_real", fictionalised: false, permission: "obtained" }; }, /fictionalised/));
  ok("import refuses: ground truth and PDF are different people", refuse((t) => { t.person.name = "Someone Else"; }, /not in the PDF/));
  ok("import refuses: submitted under another id", refuse(() => {}, /submitted as QA002/, pdf, "QA002"));
  ok("import refuses: a real-looking phone number in the PDF", refuse(() => {}, /phone number/, { ...pdf, text: `${pdf.text}\nMobile 98450 12345` }));
  ok("import refuses: a real-looking e-mail in the ground truth", refuse((t) => { t.person.email = "leela@outlook.com"; }, /e-mail/));
  ok("import refuses: a file that is not a PDF, and a PDF with no text", refuse(() => {}, /must be a PDF/, { ...pdf, isPdf: false }) && refuse(() => {}, /almost no readable text/, { ...pdf, text: "x" }));
  ok("import warns when a ground-truth figure is not in the PDF", (() => { const t = structuredClone(raw); t.roles[0].achievements[0].numbers.push("77%"); return checkPackage(t, pdf, "QA001", known).warnings.some((w) => /figure 77/.test(w)); })());
  const jb = checkJobs(jobsRaw); ok("the example job fixtures are accepted; a clash with a built-in fixture is refused", jb.ok && !checkJobs({ ...jobsRaw, roles: [{ ...jobsRaw.roles[0], slug: "cat-head" }] }).ok, jb.errors.join(" | "));

  const t = pk.truth!; const U = (s: string) => `https://ghosted-qa-api.example/qa/jobs/${s}`;
  const jobs = [["cat-head", "head", "Bengaluru, Karnataka, India", "live"], ["cat-mid", "mid", "Bengaluru, Karnataka, India", "live"], ["x-cat-head-singapore", "head", "Singapore", "live"], ["cat-closed", "mid", "Bengaluru, Karnataka, India", "gone"]].map(([slug, level, location, state]) => ({ slug, url: U(slug), title: slug, employer: "E", fn: "category management", level, location, state, text: "Own the P&L, pricing, vendor terms and private label. 12–18 years." }));
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]; const d = (v: string) => (v === "present" ? "Present" : `${mon[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}`);
  const roles = () => t.roles.map((r) => ({ company: r.employer, title: r.title, start: d(r.start), end: d(r.end), bullets: [...r.achievements.map((a) => a.text), ...(r.pnl ? [`P&L: ${r.pnl}`] : []), ...(r.cross_functional.length ? [`Worked across ${r.cross_functional.join(", ")}`] : [])] }));
  const record = () => ({ name: t.person.name, years_total: 16, roles: roles(), skills: t.skills.map((name) => ({ name })), education: t.education.map((e) => ({ school: e.institution, degree: e.degree })), extra_sections: [{ title: "Worked in", items: ["India", "Singapore", "United Kingdom"] }], contact: { email: "leela.varghese@example.com", phone: "+910000001001" } });
  const radar = (items: [string, string][]) => ({ status: "done", items: items.map(([slug, label]) => ({ url: U(slug), title: slug, company: "E", label, why: "16 years in category management with a ₹1,400 crore P&L" })), targets: null });
  const rewrite = () => ({ headline: "Category leader", summary: "Owns a ₹1,400 crore GMV business at an 11% contribution margin; team of 46.", roles: roles(), skills: [...t.skills], education: t.education.map((e) => ({ school: e.institution, degree: e.degree })), relevant: ["P&L of ₹1,400 crore", "Private label at 13% of category revenue", "Pricing in 27 cities", "Vendor terms with 140 brands", "Team of 46"], extra_sections: [] });
  const pdfOf = (rw: any) => ({ pages: 2, text: [t.person.name, "leela.varghese@example.com", "+91 00000 01001", "Experience", ...rw.roles.flatMap((r: any) => [r.title, r.company, ...r.bullets]), "Education", "Skills"].join("\n") });
  const shot = (rw: any, over: any = {}) => ({ id: "shot-1", status: "done", job_url: U("cat-head"), before: 60, after: 80, rewrite: rw, pdf: rw ? pdfOf(rw) : null, ...over });
  const run = (o: any) => evaluate({ truth: t, source: x.text, record: null, radar: null, jobs: jobs as any, sharpens: [], journeys: [], ...o });
  const fails = (e: any) => [e.record, e.radar, ...e.sharpen, e.journeys].flatMap((s: any) => s.checks.filter((k: any) => k.status === "fail").map((k: any) => k.check));
  const anyPass = (e: any) => [e.record, e.radar, ...e.sharpen, e.journeys].some((s: any) => s.checks.some((k: any) => k.status === "pass"));

  const none = run({}); ok("nothing produced → not_run, with not one check marked pass", none.verdict === "not_run" && !anyPass(none), `${none.verdict}`);
  const rw = rewrite(); const faithful = run({ record: record(), radar: radar([["cat-head", "for_you"]]), sharpens: [shot(rw)] });
  ok("faithful output → no failure, but the verdict is needs_review, never an automatic pass", fails(faithful).length === 0 && faithful.verdict === "needs_review", `${faithful.verdict}: ${fails(faithful).join(" | ")}`);
  const empty = run({ record: record(), radar: radar([["cat-head", "for_you"]]), sharpens: [shot(null)] }); ok("a Sharpen that “finished” with no document is not a pass", empty.sharpen[0].verdict !== "pass" && empty.verdict !== "pass", empty.sharpen[0].verdict);
  const errored = run({ record: record(), sharpens: [shot(null, { status: "failed", error: "model timeout" })], journeys: [{ at: "t", what: "POST /shots → 500", detail: "boom" }] }); ok("a failed Sharpen and a failed request are recorded as failures", errored.verdict === "fail" && errored.sharpen[0].verdict === "fail" && errored.journeys.verdict === "fail");

  const badRec = record(); badRec.roles = badRec.roles.filter((r) => r.company !== "Halden Foods" && r.title !== "Director, Category Management"); badRec.roles[2].start = "Feb 2016"; badRec.roles[0].bullets = badRec.roles[0].bullets.filter((b) => !/820/.test(b)); badRec.years_total = 9;
  const fr = fails(run({ record: badRec }));
  ok("Record: a dropped concurrent role, a merged promotion, a changed date, a lost achievement and wrong years are each caught", [/every role/, /Promotions/, /Overlapping/, /dates unchanged/, /Achievements captured/, /Total years/].every((re) => fr.some((f: string) => re.test(f))), fr.join(" | "));
  const frd = fails(run({ record: record(), radar: radar([["cat-mid", "for_you"], ["x-cat-head-singapore", "for_you"], ["cat-closed", "adjacent"]]) }));
  ok("Radar: a missed role, an excluded role, a wrong level, a wrong city and a closed role are each caught", [/Missed opportunities/, /Exclusions/, /Seniority/, /Location/, /closed role/].every((re) => frd.some((f: string) => re.test(f))), frd.join(" | "));
  const noWhy = radar([["cat-head", "for_you"]]); noWhy.items[0].why = "Led 300 people"; ok("Radar: an explanation with a figure from nowhere is caught", fails(run({ record: record(), radar: noWhy })).some((f: string) => /Role explanations/.test(f)));
  const bad = rewrite(); bad.roles[0].title = "Chief Growth Officer"; bad.roles[1].end = "Dec 2022"; bad.roles = bad.roles.filter((r) => r.company !== "Okapi Consulting"); bad.roles[0].bullets = ["Grew revenue 45% with machine learning pricing", "Led quick commerce launch"]; bad.summary = "Six Sigma certified category leader."; bad.relevant = []; bad.skills = ["Quick commerce"]; bad.education.push({ school: "Harvard Business School", degree: "AMP" });
  const fs2 = fails(run({ record: record(), sharpens: [shot(bad, { pdf: { pages: 2, text: "E X P E R I E N C E\nZentara" } })] }));
  ok("Sharpen: a changed title, a changed date, a dropped role, added education, a lost must-keep fact, an invented figure, an unsupported claim, lost JD terms and an unreadable PDF are each caught",
    [/job titles unchanged/, /dates unchanged/, /every role/, /education unchanged/, /must-keep/, /Numerical accuracy/, /nothing the person never did/, /JD relevance/, /headings are plain words/, /roles read in order/].every((re) => fs2.some((f: string) => re.test(f))), fs2.join(" | "));
  const cases = [{ slug: "a", url: U("a"), what: "", expected: "", verdicts: ["Caution"], fire: [14], never: [20] }, { slug: "b", url: U("b"), what: "", expected: "", verdicts: ["error"], fire: [], never: [] }, { slug: "c", url: U("c"), what: "", expected: "", verdicts: ["Real"], fire: [], never: [] }];
  const res = new Map<string, any[]>([[U("a"), [{ at: "t", status: 200, verdict: "Real", signals: [{ n: 20, kind: "bad", text: "asks for money" }, { n: 14, kind: "ok" }] }]], [U("b"), [{ at: "t", status: 422, verdict: null, signals: [], error: "couldn’t read" }]]]);
  const m = evalMeter(cases, res); const st = (i: number, re: RegExp) => m.pages[i].checks.find((k) => re.test(k.check))?.status;
  ok("Ghost Meter: wrong verdict, a signal that should have fired, and one that should not, are each caught; an expected refusal passes; an unchecked page is not_run", st(0, /Verdict/) === "fail" && st(0, /must fire/) === "fail" && st(0, /must not fire/) === "fail" && st(1, /Verdict/) === "pass" && m.pages[2].verdict === "not_run", JSON.stringify(m.pages.map((p) => p.checks.map((k) => `${k.check}:${k.status}`))));
}
if (failed) { console.error(`QA safety self-check: ${failed} failed`); process.exit(1); }
console.log("QA safety self-check: all passed"); process.exit(0);
