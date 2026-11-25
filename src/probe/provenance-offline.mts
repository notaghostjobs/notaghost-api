// Résumé evidence provenance: behaviour and isolation. Offline, no résumé data. Run: npx tsx src/probe/provenance-offline.mts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const { provenance, whereShown, STRENGTH } = await import("../lab/provenance.js");
let bad = 0; const t = (n: string, c: boolean) => { console.log(c ? "  ✓" : "  ✗", n); if (!c) bad++; };
const lay = { layout: [{ two_column: true }], lines: [
  { page: 1, column: "left", section: "skills", text: "Kubernetes, Terraform, AWS" },
  { page: 1, column: "right", section: "experience", text: "Senior Engineer, Fictional Corp  Jan 2021 - Present" },
  { page: 1, column: "right", section: "experience", text: "Built payment APIs in Node.js on AWS Lambda" },
  { page: 1, column: "right", section: "experience", text: "Supported the team's Kafka upgrade" },
  { page: 1, column: "right", section: "projects", text: "Designed a Python scheduler" },
  { page: 1, column: "right", section: "summary", text: "Familiar with Snowflake" } ] } as any;
const p = provenance(lay);
t("a sidebar skill is listed, its line kept", p.best.get("kubernetes")?.basis === "listed" && !!p.best.get("kubernetes")?.text.includes("Kubernetes"));
t("a skill in a job line is work, hands-on, under its role", p.best.get("nodejs")?.basis === "work" && p.best.get("nodejs")?.ownership === "hands_on" && !!p.best.get("nodejs")?.role?.includes("Fictional Corp"));
t("used at work beats listed", (p.strength.get("aws") ?? 0) >= 0.9);
t("supported is weaker than hands-on work", (p.strength.get("kafka") ?? 1) < 1 && p.best.get("kafka")?.ownership === "supported_or_exposed");
t("project and summary are their own bases", p.best.get("python")?.basis === "project" && p.best.get("snowflake")?.basis === "summary_claim");
t("whereShown gives the line, not a score", (() => { const w: any = whereShown(p, "terraform"); return w?.basis === "listed" && w.text.includes("Terraform") && !("strength" in w); })());
t("whereShown: absent skill is null", whereShown(p, "golang") === null);
t("strength table unchanged from the diagnostic run", JSON.stringify(STRENGTH) === JSON.stringify({ work: 1, achievement: 1, project: 0.7, summary_claim: 0.5, listed: 0.35, education: 0.3, unknown: 0.3 }));
// isolation: nothing outside src/lab and this test may import the module
const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const x = join(d, f); return statSync(x).isDirectory() ? files(x) : /\.(m?ts)$/.test(f) ? [x] : []; });
const users = files("src").filter((f) => !f.startsWith("src/lab/") && !f.endsWith("provenance-offline.mts") && /from ["'][^"']*lab\/provenance/.test(readFileSync(f, "utf8")));
t("no production code imports lab/provenance", users.length === 0);
console.log(bad ? `${bad} failed` : "all passed"); if (bad) process.exit(1);
