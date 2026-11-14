// The résumé self-check. Runs at the end of every build (npm run build); a failure stops the deploy.
//
// Every case here is a fault that reached a real document on 13 Nov, rebuilt with invented content (no one's résumé is in
// this file): a PDF whose stream lists every role header before any bullet; a sidebar layout; a role's lines filed under its
// neighbour; the same line written under two roles; a font's private bullet glyph; "Responsibilities:" labels and education
// lines parsed as bullets; a second copy of the profile; a document that lost or moved the candidate's lines.
// No model and no database: extraction, the parse checks and the delivery gate are all deterministic.
import PDFDocument from "pdfkit";
import { readingOrder } from "../engine/pdftext.js";
import { refileBullets, sanitizeProfile } from "../engine/refile.js";
import { deliveryGate, repairForGate, evidenceRecord, orderByRelevance, pdfCheck, keepProfileFigures, dedupeProfile, polishTense, figures } from "../engine/gate.js";
import { isOwnDocument } from "../engine/own.js";
import { cleanTitle } from "../radar/v2.js";
import { clean } from "../engine/pdftext.js";
import { healWraps } from "../engine/refile.js";
import { bandGate } from "../radar/gates.js";
import { flagOwnership, acceptInto, withdrawFrom, gapsOf } from "../engine/told.js";
import { resumePdf } from "../engine/pdf.js";
import type { ResumeProfile, Rewrite } from "../engine/sharpen.js";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (cond) console.log("  ✓", name); else { failed++; console.error("  ✗", name, detail); } };

const ROLES = [
  { title: "Head of Plant Operations", company: "Northwind Foods", start: "Aug 2023", end: "Present", bullets: ["Run three bottling plants with a combined output of 40 million litres a year.", "Cut changeover time on the main line from ninety minutes to thirty five."] },
  { title: "Production Manager", company: "Blue Harbor Dairy", start: "Feb 2020", end: "Jul 2023", bullets: ["Raised first pass yield from 91 percent to 97 percent across two shifts.", "Introduced a daily loss review with maintenance and quality leads.", "Trained forty operators on the new filling equipment."] },
  { title: "Shift Engineer", company: "Kestrel Beverages", start: "Jun 2016", end: "Jan 2020", bullets: ["Kept unplanned downtime under two percent for eleven consecutive quarters.", "Wrote the standard work for line clearance used at both sites."] },
];
const profile = (roles = ROLES): ResumeProfile => JSON.parse(JSON.stringify({ name: "Asha Verma", headline: "Head of Plant Operations", contact: {}, years_total: 9, roles, skills: [], education: [{ school: "Hillside Institute of Technology", degree: "B.Tech Mechanical Engineering", year: "2016" }], extra_sections: [{ title: "Languages", items: ["English", "Hindi"] }], pages: 1 }));
const counts = (p: { roles: { bullets: string[] }[] }) => p.roles.map((r) => r.bullets.length).join("/");

function pdf(draw: (d: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((res) => { const d = new PDFDocument({ size: "A4", margin: 40 }); const chunks: Buffer[] = []; d.on("data", (c) => chunks.push(c)); d.on("end", () => res(Buffer.concat(chunks))); draw(d); d.end(); });
}
const at = (t: string, needle: string) => t.indexOf(needle);

async function main() {
  console.log("résumé self-check");

  // 1. a PDF whose stream is headers first, bullets after: reading order must follow the page, not the stream
  {
    const buf = await pdf((d) => {
      d.fontSize(11);
      const ys = [120, 220, 340];
      ROLES.forEach((r, i) => { d.text(r.title, 40, ys[i]); d.text(r.company, 40, ys[i] + 14); });          // every header first…
      ROLES.forEach((r, i) => r.bullets.forEach((b, j) => d.text(b, 52, ys[i] + 32 + j * 16)));              // …then every bullet
    });
    const t = (await readingOrder(buf)) ?? "";
    ok("headers-first PDF reads in page order", at(t, ROLES[0].bullets[0]) > at(t, ROLES[0].company) && at(t, ROLES[0].bullets[1]) < at(t, ROLES[1].title) && at(t, ROLES[1].bullets[2]) < at(t, ROLES[2].title), t.slice(0, 300));
    // and the parse the old order produced (each role's lines under the role below) is put right against it
    const scrambled = profile([{ ...ROLES[0], bullets: [] }, { ...ROLES[1], bullets: [...ROLES[0].bullets, ...ROLES[1].bullets] }, { ...ROLES[2], bullets: ROLES[2].bullets }]);
    const fixed = refileBullets(sanitizeProfile(scrambled).profile, t).profile;
    ok("lines filed under a neighbour go back to their own role", counts(fixed) === "2/3/2", counts(fixed));
  }

  // 2. a sidebar layout: the main column reads straight through, the sidebar never lands between two roles
  {
    const buf = await pdf((d) => {
      d.fontSize(10);
      ["CONTACT", "asha@example.com", "SKILLS", "Lean manufacturing", "Line balancing", "Root cause analysis", "EDUCATION", "B.Tech Mechanical", "Hillside Institute", "LANGUAGES", "English", "Hindi", "Marathi", "Gujarati"].forEach((s, i) => d.text(s, 40, 100 + i * 34, { width: 130 }));
      let y = 100;
      for (const r of ROLES) { d.text(r.title, 210, y, { width: 340 }); y += 14; d.text(r.company, 210, y, { width: 340 }); y += 16; for (const b of r.bullets) { d.text(b, 220, y, { width: 330 }); y += 28; } y += 10; }
    });
    const t = (await readingOrder(buf)) ?? "";
    const body = t.split("-- sidebar --")[0];
    ok("sidebar résumé: main column in order, sidebar kept apart", t.includes("-- sidebar --") && at(body, ROLES[0].bullets[1]) > 0 && at(body, ROLES[0].bullets[1]) < at(body, ROLES[1].title) && !/Lean manufacturing|Root cause/.test(body), t.slice(0, 400));
  }

  // 3. stream-order text (headers back to back): nothing may be moved on it
  {
    const text = ROLES.map((r) => `${r.title}\n${r.company} | ${r.start} – ${r.end}`).join("\n") + "\n" + ROLES.flatMap((r) => r.bullets).join("\n");
    const r = refileBullets(profile(), text);
    ok("headers back to back: the parse is left alone", counts(r.profile) === "2/3/2" && r.log.some((l) => /not in reading order/.test(l)), r.log.join(" | "));
  }

  // 4. the parse lists two roles in the wrong order
  {
    const text = ROLES.map((r) => `${r.title}\t${r.start} – ${r.end}\n${r.company}\n${r.bullets.join("\n")}`).join("\n");
    const swapped = profile([ROLES[0], { ...ROLES[2], bullets: [] }, { ...ROLES[1], bullets: [...ROLES[1].bullets, ...ROLES[2].bullets] }]);
    const r = refileBullets(swapped, text).profile;
    ok("roles out of the page's order are read in the page's order", r.roles.map((x) => x.company).join(">") === ROLES.map((x) => x.company).join(">") && counts(r) === "2/3/2", counts(r));
  }

  // 5. debris in a parse: glyphs, labels, education lines, duplicates, a second profile
  {
    const p = profile([{ ...ROLES[0], bullets: [" " + ROLES[0].bullets[0], "Responsibilities across the tenure: " + ROLES[0].bullets[1], ROLES[0].bullets[1], "B.Tech Mechanical Engineering, Hillside Institute of Technology (2016)", "Highlights:"] }, ROLES[1], ROLES[2]]);
    p.extra_sections.push({ title: "Profile Summary", items: ["Nine years in beverage manufacturing."] }, { title: "Job Objective", items: ["Seeking a plant leadership role."] });
    const s = sanitizeProfile(p).profile;
    ok("glyphs, labels, education lines and duplicates never reach a role", counts(s) === "2/3/2" && !/[-]/.test(JSON.stringify(s)) && !/Responsibilities/.test(JSON.stringify(s.roles)), JSON.stringify(s.roles[0].bullets));
    ok("the résumé's own objective/summary folds into the summary", s.extra_sections.map((x) => x.title).join(",") === "Languages" && /Nine years/.test(String((s as any).summary)), JSON.stringify(s.extra_sections));
  }

  // 6. the same line written under two roles stays under both
  {
    const shared = "Led the weekly production review with planning and quality.";
    const roles = [ROLES[0], { ...ROLES[1], bullets: [...ROLES[1].bullets, shared] }, { ...ROLES[2], bullets: [...ROLES[2].bullets, shared] }];
    const text = roles.map((r) => `${r.title}\t${r.start} – ${r.end}\n${r.company}\n${r.bullets.join("\n")}`).join("\n");
    const parsed = profile([roles[0], roles[1], { ...roles[2], bullets: ROLES[2].bullets }]);   // the parse kept only the first copy
    const r = refileBullets(sanitizeProfile(parsed).profile, text).profile;
    ok("a line the candidate wrote under two roles is under both", counts(r) === "2/4/3", counts(r));
  }

  // 7. the delivery gate
  {
    const orig = profile();
    const good: Rewrite = { headline: "Head of Plant Operations", summary: "Runs three bottling plants. Nine years in beverage manufacturing.", relevant: [], roles: JSON.parse(JSON.stringify(ROLES)), skills: ["Lean"], education: orig.education, extra_sections: orig.extra_sections, changes: [], referral_note: "", fit_line: "" } as any;
    ok("a faithful document passes", deliveryGate(good, orig).ok, JSON.stringify(deliveryGate(good, orig)));
    const reworded = JSON.parse(JSON.stringify(good)); reworded.roles[1].bullets[0] = "Raised first pass yield from 91 percent to 97 percent across two shifts through structured loss reviews.";
    ok("a reworded line still counts as the candidate's", deliveryGate(reworded, orig).ok);
    const bad = JSON.parse(JSON.stringify(good));
    bad.roles[2].bullets.push(bad.roles[1].bullets.shift());                          // a line moved to another employer
    bad.roles[0].bullets.pop();                                                       // a line lost
    bad.roles[0].bullets.push("Highlights:  " + ROLES[0].bullets[0]);         // debris
    bad.extra_sections.push({ title: "Profile Summary", items: ["Old profile."] });
    bad.roles[1].bullets.push("Led a pricing transformation that doubled margins.");  // unsupported
    const problems = [{ claim: 'Blue Harbor Dairy: "Led a pricing transformation that doubled margins."', reason: "Not in the original." }];
    const g = deliveryGate(bad, orig, problems);
    ok("a document that lost, moved or invented a line is stopped", !g.ok && g.lost.length >= 2 && g.moved.length === 1 && g.technical.length >= 2 && g.factual.length === 1, JSON.stringify(g));
    const fix = repairForGate(bad, orig, problems);
    const g2 = deliveryGate(fix.rewrite, orig, fix.unsettled);
    ok("repair restores the candidate's own lines and removes what isn't theirs", g2.ok && counts(fix.rewrite) === "2/3/2" && !/pricing transformation/.test(JSON.stringify(fix.rewrite)), JSON.stringify(g2) + " " + counts(fix.rewrite));
    const unknown = [{ claim: "The summary implies a decade of leadership.", reason: "Cannot be located." }];
    const g3 = deliveryGate(repairForGate(good, orig, unknown).rewrite, orig, repairForGate(good, orig, unknown).unsettled);
    ok("a claim that cannot be settled holds the document", !g3.ok);
  }

  // 8. order, evidence, the ownership question
  {
    const orig = profile();
    const rw: any = { headline: "", summary: "Runs three bottling plants.", relevant: [], roles: JSON.parse(JSON.stringify(ROLES)), skills: ["Lean"], education: [], extra_sections: [] };
    rw.roles[1].bullets[1] = "Introduced a daily loss review with maintenance and quality leads, cutting repeat stoppages.";
    rw.roles[1].bullets.push("Planned preventive maintenance windows with the engineering team.");
    rw.roles[1].bullets.push("Won a national award for packaging innovation.");
    const matches: any[] = [
      { requirement: "Train and certify line operators", kind: "must", bucket: "said", evidence: ROLES[1].bullets[2] },
      { requirement: "Plan preventive maintenance", kind: "nice", bucket: "have_not_said", evidence: "x", line: "Planned preventive maintenance windows with the engineering team.", told: true },
    ];
    const o = orderByRelevance(rw, matches).rewrite;
    ok("the posting's must-have leads its role; nothing else changes", o.roles[1].bullets[0] === ROLES[1].bullets[2] && o.roles[1].bullets.length === rw.roles[1].bullets.length && JSON.stringify(o.roles[0]) === JSON.stringify(rw.roles[0]), JSON.stringify(o.roles[1].bullets));
    const ev = evidenceRecord(rw, orig, matches).filter((e) => e.role.startsWith("Blue Harbor"));
    ok("every line has its source on record", ev.map((e) => e.kind).join(",") === "yours,reworded,yours,told,new" && ev[1].original === ROLES[1].bullets[1], ev.map((e) => e.kind).join(","));
    const ms: any[] = [
      { requirement: "Own the plant maintenance budget", kind: "must", bucket: "have_not_said", evidence: "Supported the maintenance lead in preparing the annual budget.", line: "Supported preparation of the annual maintenance budget.", sayable: true },
      { requirement: "Lead shift handovers", kind: "must", bucket: "said", evidence: "Led shift handovers across three lines." },
      { requirement: "Manage vendor contracts", kind: "nice", bucket: "have_not_said", evidence: "Worked with procurement on vendor contracts." },
      { requirement: "Own food safety audits", kind: "must", bucket: "missing", evidence: "" },
    ];
    const f = flagOwnership(ms as any) as any[];
    ok("ownership is asked only for an ambiguous must-have", f.filter((m) => m.ownership_asked).map((m) => m.requirement).join("|") === "Own the plant maintenance budget" && gapsOf(f as any).filter((g) => g.ownership).length === 1);
    const back = withdrawFrom(acceptInto(f as any, ms[0].requirement, "I owned the budget", "Owned the plant maintenance budget."), ms[0].requirement) as any[];
    ok("taking an ownership answer back restores what the résumé showed", back[0].evidence === ms[0].evidence && back[0].bucket === "have_not_said" && !back[0].told);
  }

  // 9. the finished PDF, read back
  {
    const orig = profile();
    const rw: any = { headline: "Head of Plant Operations", summary: "Runs three bottling plants with nine years in beverage manufacturing.", relevant: [], roles: JSON.parse(JSON.stringify(ROLES)), skills: ["Lean manufacturing", "Line balancing"], education: orig.education, extra_sections: orig.extra_sections, changes: [] };
    try {
      const buf = await resumePdf(rw, orig);
      const t = (await readingOrder(buf)) ?? "";
      ok("our own PDF reads back complete and in order", pdfCheck(t, 1, rw, orig.name).length === 0, JSON.stringify(pdfCheck(t, 1, rw, orig.name)));
      const more = JSON.parse(JSON.stringify(rw)); more.roles[2].bullets.push("Commissioned the second pasteuriser ahead of schedule.");
      ok("a line missing from the PDF is caught", pdfCheck(t, 1, more, orig.name).length === 1);
      ok("roles out of order in the PDF are caught", pdfCheck(t, 1, { ...rw, roles: [rw.roles[1], rw.roles[0], rw.roles[2]] }, orig.name).some((x: string) => /out of order/.test(x)));
    } catch (e) { console.log("  – PDF read-back skipped here (no browser):", e instanceof Error ? e.message.split("\n")[0] : e); }
  }

  // ---- 13 Nov, evening: the profile lost a figure, said a sentence twice, kept the wrong tense; an upload of our own document was re-scored
  {
    const o = profile(); (o as any).summary = "Runs plants for a living. Attained a 30% YoY growth in output with a 20% margin. Led teams of over 250 members across layers.";
    const rw: Rewrite = JSON.parse(JSON.stringify({ headline: o.headline, summary: "Plant leader with nine years in beverages. Led teams of over 250 members across layers.", relevant: ["Led teams of over 250 members across layers; margin held at 20%."], roles: o.roles, skills: [], education: o.education, extra_sections: [], fit_line: "", referral_note: "", changes: [] }));
    rw.roles[1].bullets = [...rw.roles[1].bullets, "Enhancing uptime through weekly reviews. Devising checklists for every line."];
    const o2 = JSON.parse(JSON.stringify(o)); o2.roles[1].bullets = [...o2.roles[1].bullets, "Enhancing uptime through weekly reviews. Devising checklists for every line."];
    const kept = keepProfileFigures(rw, o2);
    ok("a figure from their own profile is kept", kept.length === 1 && figures(JSON.stringify(rw.relevant)).includes("30%"), JSON.stringify(kept));
    const dd = dedupeProfile(rw);
    ok("a sentence said twice in the profile is said once", dd.length === 1 && !/250/.test(rw.summary) && /nine years/.test(rw.summary), rw.summary);
    const pol = polishTense(rw);
    ok("a finished role is told in the past tense", pol.changed === 2 && pol.rewrite.roles[1].bullets.some((b) => b.startsWith("Enhanced uptime") && b.includes(". Devised checklists")), JSON.stringify(pol.rewrite.roles[1].bullets.slice(-1)));
    ok("the current role's wording is left alone", JSON.stringify(pol.rewrite.roles[0]) === JSON.stringify(rw.roles[0]));
    ok("the polished document passes the same gate", deliveryGate(pol.rewrite, o2, [], []).ok, JSON.stringify(deliveryGate(pol.rewrite, o2, [], [])));
    const rec = evidenceRecord(pol.rewrite, o2, []);
    ok("a polished line is on record as reworded, with their original", rec.some((e) => e.kind === "reworded" && /^Enhancing/.test(e.original ?? "")), JSON.stringify(rec.filter((e) => e.kind !== "yours")));
    // a claim quoted in two places is removed from both
    const two: Rewrite = JSON.parse(JSON.stringify(pol.rewrite)); two.summary = "Plant leader with nine years in beverages. Brings apparel category work at Kestrel Beverages."; two.relevant = ["Fashion: category management and operations at Kestrel Beverages."];
    const fx = repairForGate(two, o2, [{ claim: 'Summary: "apparel category work at Kestrel Beverages"; relevant section: "Fashion: category management and operations at Kestrel Beverages"', reason: "the original never says apparel" }], []);
    ok("a claim quoted in two places is removed from both", !/apparel/i.test(fx.rewrite.summary) && !(fx.rewrite.relevant ?? []).some((x) => /Fashion/.test(x)) && fx.unsettled.length === 0, JSON.stringify([fx.rewrite.summary, fx.rewrite.relevant, fx.unsettled]));
    // Radar: a board's glued title is cut back to the title, and a glued years range is kept as the band
    ok("a glued title is cut to the title", cleanTitle("Director of Strategy & Operations39 days agoBengaluru (Korma") === "Director of Strategy & Operations" && cleanTitle("Performance / Growth Marketing ManagerBangalore - Head Offic") === "Performance / Growth Marketing Manager", cleanTitle("Performance / Growth Marketing ManagerBangalore - Head Offic"));
    ok("a glued years range is kept as the band", cleanTitle("Backend Developer (Golang)176 days agoBangalore2-5 Full Time") === "Backend Developer (Golang) · 2–5 years" && bandGate(0.25, "", cleanTitle("Backend Developer (Golang)176 days agoBangalore2-5 Full Time")) !== null, String(bandGate(0.25, "", "Backend Developer (Golang) · 2–5 years")));
    ok("an ordinary title is untouched", cleanTitle("Senior Manager, Category Management — Bengaluru") === "Senior Manager, Category Management — Bengaluru" && cleanTitle("Program Manager, Bangalore") === "Program Manager, Bangalore");
    // a re-read of our own page: letter-spaced headings are one word, a wrapped ending comes back
    ok("a letter-spaced heading is one word", clean("PR O F I L E\nSome line here\nE X PE R I E N CE\nA B testing on 4 pages") === "PROFILE\nSome line here\nEXPERIENCE\nA B testing on 4 pages", clean("PR O F I L E\nx\nE X PE R I E N CE"));
    const hw = healWraps({ roles: [{ bullets: ["Data-led decisions: daily price benchmarking using SQL, Tableau and", "Ran weekly reviews with the plant team."] }] }, "PROFILE\nData-led decisions: daily price benchmarking using SQL, Tableau and\nAmplitude.\nRan weekly reviews with the plant team.\nSKILLS");
    ok("a wrapped ending is restored", hw.profile.roles![0].bullets![0].endsWith("Tableau and Amplitude.") && hw.profile.roles![0].bullets![1] === "Ran weekly reviews with the plant team." && hw.log.length === 1, JSON.stringify(hw.profile.roles));
    // our own document, uploaded again
    const up = JSON.parse(JSON.stringify(o2)); up.roles = pol.rewrite.roles; up.summary = pol.rewrite.summary + " " + pol.rewrite.relevant.join(" ");
    ok("an upload of the document we delivered is recognised", isOwnDocument(up, pol.rewrite));
    const told = JSON.parse(JSON.stringify(pol.rewrite)); told.roles[0].bullets.push("Launched two private label lines with overseas suppliers.", "Owned the annual operating plan for the region."); told.roles[1].bullets.push("Set up a vendor scorecard used by forty suppliers.");
    ok("their original résumé is not mistaken for it", !isOwnDocument(o2, told));
    // the profile block filed as bullets, a line cut at a wrap: still our document
    const filed = JSON.parse(JSON.stringify(up)); filed.summary = ""; filed.roles[0].bullets = [pol.rewrite.summary, ...pol.rewrite.relevant, ...filed.roles[0].bullets]; filed.roles[1].bullets = filed.roles[1].bullets.map((b: string, i: number) => i === 0 ? b.split(" ").slice(0, -1).join(" ") : b);
    ok("our document is recognised however the profile block was filed", isOwnDocument(filed, pol.rewrite));
  }
  if (failed) { console.error(`résumé self-check: ${failed} failed`); process.exit(1); }
  console.log("résumé self-check: all passed");
}
main().then(() => process.exit(0)).catch((e) => { console.error("résumé self-check crashed", e); process.exit(1); });
