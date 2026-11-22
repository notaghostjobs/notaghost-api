// Offline check: every role on the Instagram link page lands on the right shelf.
import { bandOf } from "../lib/igband.js";
const cases: [string, string, string][] = [
  ["IT Intern", "Recent graduates", "intern"], ["Tech trainer intern", "Freshers, engineering degree", "intern"],
  ["Management Trainee", "Fresh B.Tech, EEE", "fresher"], ["Data Analyst", "2–5 years in data", "y1_3"],
  ["Payment Lifecycle Specialist", "Graduates, 1 year at a bank", "y1_3"], ["Lead Associate", "3.5+ years, consulting or operations", "y1_3"],
  ["Product Manager II", "4+ years in product", "y4_7"], ["Senior Software Engineer", "7+ years", "y4_7"], ["Senior Product Manager", "7–10 years", "y4_7"],
  ["Lead Technical Product Manager", "8+ years in technical product management", "y8"], ["Head of Product", "15+ years", "y8"],
];
let bad = 0;
for (const [role, who, want] of cases) { const got = bandOf({ role, who }); if (got !== want) { bad++; console.log("WRONG", role, who, got, want); } }
if (bandOf({ role: "Anything", who: "2 years", band: "y8" }) !== "y8") { bad++; console.log("WRONG: a written band must win"); }
console.log(bad ? `${bad} wrong` : `all ${cases.length + 1} right`);
process.exit(bad ? 1 : 0);
