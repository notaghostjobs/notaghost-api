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
import { deliveryGate, repairForGate } from "../engine/gate.js";
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

  if (failed) { console.error(`résumé self-check: ${failed} failed`); process.exit(1); }
  console.log("résumé self-check: all passed");
}
main().catch((e) => { console.error("résumé self-check crashed", e); process.exit(1); });
