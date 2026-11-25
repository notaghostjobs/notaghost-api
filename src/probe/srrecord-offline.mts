// Offline check of the SmartRecruiters record reader (src/reader/srrecord.ts). No network, no database.
// Run: npx tsx src/probe/srrecord-offline.mts                    (fixtures)
//      npx tsx src/probe/srrecord-offline.mts <inventory.jsonl>  (also every stored SmartRecruiters row: what a repair would write, written nowhere)
import { readFileSync } from "node:fs";
const { srRecord } = await import("../reader/srrecord.js");
let fail = 0; const ok = (n: string, c: boolean, d = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, d); } };
const JD = "<p>About the role\n</p><p>We are looking for a Business Development Manager to join our outbound sales team. You will build pipeline through prospecting, qualify opportunities and work with account executives on enterprise deals across India.</p><ul><li>3+ years of B2B sales</li><li>CRM hygiene</li></ul>";
const rec = { uuid: "u", applyUrl: "https://jobs.smartrecruiters.com/Acme/1-bdm", jobAdLanguageCode: "en", jobTitle: "Business Development Manager", jobAdLocation: "Bengaluru, India", employmentType: "Full-time", jobFields: [],
  content: { sections: { companyDescription: { title: "Company Description", text: "<p>Acme builds software.</p>" }, jobDescription: { title: "Job Description", text: JD }, qualifications: { title: "Qualifications", text: "<p>Graduate.</p>" }, additionalInformation: { title: "Additional Information", text: "<p>Hybrid.</p>" } } },
  company: { name: "Acme" }, isApplyAvailable: true, postedBy: { name: "A Recruiter", img: "/x.png" }, postedDate: "2026-10-22T14:34:08.664Z" };
const page = JSON.stringify(rec);
const r1 = srRecord(page)!;
ok("page answer: parsed as JSON", r1?.how === "json");
ok("page answer: job text first, employer blurb last, no tags", r1.text.startsWith("Job Description\nAbout the role") && r1.text.includes("We are looking") && r1.text.trim().endsWith("Acme builds software.") && !/<\/?p>/.test(r1.text));
ok("page answer: the employer's own date", r1.postedAt === "2026-10-22T14:34:08.664Z");
ok("page answer: no JSON keys, no recruiter", !/"uuid"|applyUrl|"postedBy"|A Recruiter/.test(r1.text));
const stored = page.replace(/<[^>]+>/g, " ").replace(/\\n/g, "\n");   // what htmlToText left in the table: tags gone, real line breaks
ok("stored row with real line breaks: tolerant parse, same date", srRecord(stored)?.how === "tolerant" && srRecord(stored)?.postedAt === r1.postedAt);
const broken = stored.replace("Business Development Manager to join", 'Business Development Manager ("BDM") to join');
const r3 = srRecord(broken);
ok("stored row with bare quotes: section fields still read", r3?.how === "fields" && !!r3?.text.includes("outbound sales") && r3?.postedAt === r1.postedAt, JSON.stringify(r3));
ok("not a record: null", srRecord("<html><body>Hello</body></html>") === null && srRecord('{"a":1}') === null);
ok("a record with no real text: null", srRecord(JSON.stringify({ ...rec, content: { sections: { jobDescription: { title: "Job Description", text: "<p>TBD</p>" } } } })) === null);

if (process.argv[2]) {
  const c: Record<string, number> = { rows: 0, read: 0, json: 0, tolerant: 0, fields: 0, dated: 0, jsonKeysLeft: 0, recruiterLeft: 0, short: 0 };
  const ratio: number[] = []; const unread: string[] = [];
  for (const l of readFileSync(process.argv[2], "utf8").split("\n")) {
    if (!l) continue; const r = JSON.parse(l); if (r.source !== "smartrecruiters" || !r.description) continue; c.rows++;
    const x = srRecord(r.description); if (!x) { unread.push(String(r.id)); continue; }
    c.read++; c[x.how]++; if (x.postedAt) c.dated++;
    if (/"(uuid|applyUrl|jobAdLanguageCode|isApplyAvailable)"/.test(x.text)) c.jsonKeysLeft++;
    const pb = r.description.match(/"postedBy":\{"name":"([^"]+)"/)?.[1]; if (pb && x.text.includes(pb)) c.recruiterLeft++;
    if (x.text.length < 400) c.short++; ratio.push(x.text.length / r.description.length);
  }
  ratio.sort((a, b) => a - b);
  console.log("  snapshot:", c, `text/record length median ${ratio[ratio.length >> 1]?.toFixed(2)}`, unread.length ? `unread ids: ${unread.slice(0, 10).join(",")}` : "");
  ok("snapshot: at least 99% of rows read", c.read >= 0.99 * c.rows);
  ok("snapshot: every read row has its date", c.dated === c.read);
  ok("snapshot: no JSON keys and no recruiter names left", c.jsonKeysLeft === 0 && c.recruiterLeft === 0);
}
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
