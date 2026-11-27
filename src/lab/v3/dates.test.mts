// Employment-date reader tests. Invented people, employers and titles; the date FORMATS are the ones met on real
// résumés (including the three pilot résumés, whose own files are checked privately and never committed).
//   SUPABASE_URL=https://offline.invalid SUPABASE_SERVICE_ROLE_KEY=offline npx tsx src/lab/v3/dates.test.mts
import assert from "node:assert/strict";
const { employment, parseDate, resolveYY, unionYears } = await import("./dates.js"); const { cir } = await import("../cir.js"); const { analyse } = await import("../../lib/career.js");
let n = 0; const t = (name: string, f: () => void) => { f(); n++; console.log("ok", n, name); };
const NOW = new Date("2026-11-27T06:47:00Z"); const near = (a: number | null, b: number, tol = 0.15) => assert.ok(a !== null && Math.abs(a - b) <= tol, `${a} vs ${b}`);
const E = (text: string, now = NOW) => employment(text, now); const counted = (e: any) => e.intervals.filter((x: any) => x.counted);
const INTENT: any = { primary: "product.tpm", secondary: null, level: "leader", years: 14, domain: "any", stretch: true, move: false, transition: false };

// the three pilot date styles, with invented content
const STYLE_A = ["Asha Example", "Technical leader with 11+ years of proven track record in agile software product delivery", "EXPERIENCE",
  "Director Technical Programs , Acme Mart June 22 - Present", "● Led program execution for a B2B launch", "● Bi-Weekly releases moved quarter goals from ~ 62% in 2021-2022 to 85% in the following two quarters of the year",
  "Technical Program Manager , Beta Works April 21 - May’23", "Program Manager, Gamma Labs July’20-April’23", "Engineering Manager- Program , Delta Ride Sep’19-Oct’20", "QA Lead, Epsilon Tech Aug’18-Sep’19", "Senior QA Engineer, Zeta Soft Mar’15 - July’18", "QA Engineer, Eta Systems May’13 - Jan’15",
  "EDUCATION", "Example College of Eng. (Jaipur ) 2008-2012 80.6%"].join("\n");
const STYLE_B = ["Bina Example", "CAREER OBJECTIVE", "To grow in process operations.", "PROFESSIONAL SUMMARY", "Company : Acme Financing", "Feb 11, 2022 to till now", "Designation : Process Specialist", "Handled mortgage loan processing for a US client",
  "Company : Beta Insurance Services", "March 30, 2020 to August 28, 2021", "Roles and Responsibilities: Process Associate (US Insurance)", "Company : Gamma BPO", "Jan-2017 to Mar-2020", "A competent professional with 3.4 yrs of experience in non-voice Process.", "Designation : Senior Process Executive",
  "A competent professional with total 1.3yr of experience in finance and non-voice Process.", "EDUCATION", "M.com from Example university -2014-16", "B.Com from Example university– 2011-14", "PUC -Commerce from Example Board– 2010-11",
  "Master of commerce (M.com) 72%. 2014 To 2016 Example University", "| | | 2010 To 2011", "| 2010 To 2011"].join("\n");
const STYLE_C = ["Chitra Example", "PROGRAMMER ANALYST", "3 years of experience building cloud applications", "EDUCATION", "2018-2022 - Bachelor of Engineering (B.E)", "EXPERIENCE", "2022- Present Programmer Analyst", "Built REST services on AWS"].join("\n");

t("root cause reproduced: the shared reader counts an education table row / a metric period and misses the real roles", () => {
  const a = analyse(STYLE_A, NOW); assert.ok((a.years ?? 0) < 3, "style A: about two years, from the metric period '2021-2022'"); assert.ok(a.jobs.every((j: any) => Math.floor(j.from) === 2021), "the only range it reads is the metric period");
  assert.ok((analyse(STYLE_B, NOW).years ?? 0) < 4, "style B: a stated 3.4 or the bare education row, never the nine years worked");
});
t("style A (two-digit years, curly apostrophes, overlapping roles): union of intervals, metric period ignored", () => {
  const e = E(STYLE_A); near(e.total_years, 13.5); assert.equal(e.basis, "dated_roles"); assert.equal(counted(e).length, 7);
  assert.ok(e.intervals.some((x: any) => x.matched_text === "2021-2022" && !x.counted && /sentence/.test(x.why)), "the metric period is recorded but not counted");
  assert.ok(e.intervals.some((x: any) => x.kind === "education" && x.matched_text === "2008-2012"));
  const sum = counted(e).reduce((a: number, x: any) => a + (x.to - x.from), 0); assert.ok(sum > e.total_years! + 2, "overlapping roles are not double-counted");
  assert.ok(e.flags.some((f: string) => /stated 11 years differs/.test(f)) && e.flags.includes("two_digit_year") && e.flags.includes("two_digit_year_could_be_a_day"));
});
t("style B (full dates, 'to till now', Mon-YYYY, education table rows): gap preserved, education never counted", () => {
  const e = E(STYLE_B); near(e.total_years, 9.5); assert.equal(counted(e).length, 3); assert.equal(e.gaps.length, 1); near(e.gaps[0].years, 0.4);
  assert.ok(e.intervals.filter((x: any) => x.kind === "education").length >= 3 && e.intervals.every((x: any) => x.kind !== "education" || !x.counted));
  assert.deepEqual(e.stated.map((s: any) => s.years).sort(), [1.3, 3.4]); assert.ok(e.flags.some((f: string) => /stated 3.4 years differs/.test(f)));
});
t("style C (year-only start): read as mid-year and flagged; the education range is not work", () => {
  const e = E(STYLE_C); near(e.total_years, 4.4); assert.ok(e.flags.some((f: string) => /year only/.test(f))); assert.equal(counted(e).length, 1); assert.equal(counted(e)[0].ongoing, true);
});
t("every extracted date keeps its exact source line and matched text", () => {
  const e = E(STYLE_A); for (const x of e.intervals) { assert.ok(STYLE_A.split("\n")[x.line_no - 1].includes(x.matched_text)); assert.ok(x.source_line.includes(x.matched_text)); }
});
t("formats: separators, ongoing words, numeric dates, ordinals, since/onwards", () => {
  const one = (line: string) => { const e = E(`Software Engineer, Acme\n${line}\nBuilt services`); assert.equal(counted(e).length, 1, line); return counted(e)[0]; };
  for (const [line, from, to] of [["Jan 2019 - Mar 2021", 2019.0, 2021.25], ["January 2019 – March 2021", 2019.0, 2021.25], ["Jan 2019 — Mar 2021", 2019.0, 2021.25], ["Jan 2019 to Mar 2021", 2019.0, 2021.25], ["Jan 2019 till Mar 2021", 2019.0, 2021.25],
    ["Jan 2019 until Mar 2021", 2019.0, 2021.25], ["Jan, 2019 - Mar, 2021", 2019.0, 2021.25], ["Jan'19 - Mar'21", 2019.0, 2021.25], ["Jan ’19 – Mar ’21", 2019.0, 2021.25], ["01/2019 - 03/2021", 2019.0, 2021.25], ["01-2019 to 03-2021", 2019.0, 2021.25],
    ["15/01/2019 - 20/03/2021", 2019.0, 2021.25], ["1st Jan 2019 to 31st Mar 2021", 2019.0, 2021.25], ["15 Jan 2019 - 20 Mar 2021", 2019.0, 2021.25], ["Jan 15, 2019 - Mar 20, 2021", 2019.0, 2021.25], ["2019 - 2021", 2019.5, 2021.5], ["2019-21", 2019.5, 2021.5]] as const) {
    const x = one(line); near(x.from, from, 0.01); near(x.to, to, 0.01); }
  for (const w of ["Present", "present", "Current", "Currently", "Till Now", "till date", "Now", "Ongoing", "to date", "Today"]) { const x = one(`Jan 2024 - ${w}`); assert.equal(x.ongoing, true, w); near(x.to, 2026.9, 0.05); }
  assert.equal(one("Since Jan 2024").ongoing, true); assert.equal(one("Jan 2024 onwards").ongoing, true);
});
t("ongoing roles end at the evaluation date passed in, never a fixed date", () => {
  const a = E("Analyst, Acme\nJan 2024 - Present", new Date("2026-11-27")), b = E("Analyst, Acme\nJan 2024 - Present", new Date("2027-11-27")); near(b.total_years! - a.total_years!, 1.0, 0.05);
});
t("two-digit years: one fixed rule, flagged; impossible or future dates are flagged and not counted", () => {
  assert.equal(resolveYY(19, NOW), 2019); assert.equal(resolveYY(26, NOW), 2026); assert.equal(resolveYY(27, NOW), 1927); assert.equal(resolveYY(98, NOW), 1998);
  assert.deepEqual(parseDate("June 22", NOW, false)!.flags, ["two_digit_year", "two_digit_year_could_be_a_day"]); assert.deepEqual(parseDate("Sep’19", NOW, false)!.flags, ["two_digit_year"]);
  const fut = E("Analyst, Acme\nJan 2031 - Mar 2032"); assert.equal(counted(fut).length, 0); assert.ok(fut.flags.includes("date_in_the_future")); assert.equal(fut.total_years, null);
  const rev = E("Analyst, Acme\nMar 2021 - Jan 2019"); assert.equal(counted(rev).length, 0); assert.ok(rev.flags.includes("end_before_start"));
  assert.ok(E("Analyst, Acme\n03/04/2019 - 05/06/2021").flags.includes("day_month_order_assumed"));
});
t("overlapping jobs are counted once; gaps are not filled", () => {
  const e = E("EXPERIENCE\nConsultant, Acme\nJan 2018 - Dec 2020\nAdvisor (part-time), Beta\nJun 2019 - Jun 2021\nManager, Gamma\nJan 2023 - Dec 2024"); near(e.total_years, 5.5); assert.equal(e.gaps.length, 1); near(e.gaps[0].years, 1.5);
  assert.equal(unionYears([{ from: 2018, to: 2020 }, { from: 2018, to: 2020 }]).years, 2);
});
t("internships and training are recorded apart, not as professional experience", () => {
  const e = E("EXPERIENCE\nSoftware Engineer, Acme\nJul 2022 - Present\nSummer Intern, Beta Labs\nJan 2022 - Jun 2022"); near(e.total_years, 4.4); near(e.internship_years, 0.5); assert.ok(e.intervals.some((x: any) => x.kind === "internship" && !x.counted));
});
t("education, certifications, personal details and project sections are not employment", () => {
  const e = E("EXPERIENCE\nEngineer, Acme\nJan 2020 - Dec 2022\nEDUCATION\nB.Tech, Example Institute of Technology\n2014 - 2018\nCERTIFICATIONS\nCloud Practitioner 2021 - 2024\nPERSONAL DETAILS\nDate of Birth: 01 Jan 1995 - Present");
  near(e.total_years, 3.0); assert.equal(counted(e).length, 1); assert.ok(e.intervals.filter((x: any) => !x.counted).length >= 2);
  const p = E("PROJECTS\nInventory app\nJan 2023 - Mar 2023"); assert.equal(p.total_years, null); assert.ok(p.flags.includes("only_project_dates_found"));
});
t("missing dates: no guess; the résumé's own statement is used and labelled, or the total is unknown", () => {
  const s = E("Riya Example\nOperations Manager with 7 years of experience in logistics\nOperations Manager, Acme\nManaged a fleet of 40 vehicles"); assert.equal(s.total_years, 7); assert.equal(s.basis, "stated"); assert.ok(s.flags.some((f: string) => /no_dated_employment/.test(f)));
  const u = E("Riya Example\nOperations Manager, Acme\nManaged a fleet of 40 vehicles"); assert.equal(u.total_years, null); assert.equal(u.basis, "none");
});
t("unusual formatting: bullets, pipes, tabs, dates before the title, dates inside prose are ignored", () => {
  const e = E("• Senior Analyst | Acme Corp | Mar 2019 – Present\n\t(Jan 2016 - Feb 2019)\tAnalyst, Beta\nGrew revenue 30% in 2017-2018 through a pricing change across the western region and three new channel partners"); near(e.total_years, 10.9); assert.equal(counted(e).length, 2);
  assert.ok(e.intervals.some((x: any) => x.matched_text === "2017-2018" && !x.counted));
  assert.equal(E("Team size 5-10; budget 2-3 Cr; call 98450 12345; version 2019.2").intervals.length, 0);
});
t("candidate record: V3 years, level and dated roles; total and target-relevant experience kept apart; default behaviour unchanged", () => {
  const v3 = cir("T1", STYLE_A, INTENT, NOW, { dates: "v3" }); near(v3.done.years_read, 13.5); assert.equal(v3.done.years_basis, "dated"); assert.ok(["senior", "leader"].includes(v3.done.level_read)); assert.ok(v3.done.jobs.length >= 6);
  const emp = v3.done.employment; assert.equal(emp.reader, "v3-dates/1"); near(emp.total_years, 13.5); assert.ok(emp.relevant_to_target_years === null || emp.relevant_to_target_years <= emp.total_years); assert.ok("relevance_unknown_years" in emp);
  near(v3.done.jobs[0].to, 2026.9, 0.05); assert.ok(v3.done.jobs.every((j: any) => j.to <= 2026.95));
  const old = cir("T1", STYLE_A, INTENT); assert.ok((old.done.years_read ?? 0) < 3); assert.ok(!("employment" in old.done), "without the option the original reader is used, so the development records do not change");
  const b = cir("T2", STYLE_B, { ...INTENT, primary: "ops.backoffice", level: "senior" }, NOW, { dates: "v3" }); near(b.done.years_read, 9.5); assert.equal(b.done.level_read, "senior");
});
console.log(`${n} tests passed`);
