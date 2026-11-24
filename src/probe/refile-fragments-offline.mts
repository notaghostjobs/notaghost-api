// Offline check for the 24 Nov defect: two roles whose lines open with the same words, on a résumé with no bullet marks.
// The recovery step must not add a cut-off piece of one employer's line under the other. No network, no customer data.
import { refileBullets, sanitizeProfile } from "../engine/refile.js";

const text = `Asha Rao
Operations Professional
EXPERIENCE
Operations Lead\tMar 2025 – Jun 2025
Northwind Traders, Pune
Planned weekly dispatch schedules across three warehouses and two
transport partners.
Negotiated quarterly rates with carriers while keeping to the
agreed budget for each lane.
Trained four new coordinators on the dispatch tool and the
escalation steps.
Operations Executive\tJul 2024 – Feb 2025
Bluepeak Logistics, Pune
Managed daily and weekly counts, overseeing supplier returns,
the damaged-goods register, and low-cost storage options
to keep stock accurate while reducing costs.
Beat a team of 15 in the last quarter by
closing the highest number of open tickets.
Operations Intern\tNov 2023 – Jun 2024
Kestrel Supply Pvt. Ltd
Ran dispatch for several clients, including domestic routes for
two retailers and international routes for three exporters.
Managed daily and weekly counts through the partner
portal, site visits, and direct supplier calls.
Named top performer among a team of 4, for 4
months in a row.
SKILLS
Excel
`;
const profile: any = { roles: [
  { company: "Northwind Traders, Pune", title: "Operations Lead", start: "Mar 2025", end: "Jun 2025", bullets: ["Planned weekly dispatch schedules across three warehouses and two transport partners.", "Negotiated quarterly rates with carriers while keeping to the agreed budget for each lane.", "Trained four new coordinators on the dispatch tool and the escalation steps."] },
  { company: "Bluepeak Logistics, Pune", title: "Operations Executive", start: "Jul 2024", end: "Feb 2025", bullets: ["Managed daily and weekly counts, overseeing supplier returns, the damaged-goods register, and low-cost storage options to keep stock accurate while reducing costs.", "Beat a team of 15 in the last quarter by closing the highest number of open tickets."] },
  { company: "Kestrel Supply Pvt. Ltd", title: "Operations Intern", start: "Nov 2023", end: "Jun 2024", bullets: ["Ran dispatch for several clients, including domestic routes for two retailers and international routes for three exporters.", "Managed daily and weekly counts through the partner portal, site visits, and direct supplier calls.", "Named top performer among a team of 4, for 4 months in a row."] },
] };
const before = profile.roles.map((r: any) => r.bullets.length);
const out = sanitizeProfile(refileBullets(profile, text).profile).profile as any;
const after = out.roles.map((r: any) => r.bullets.length);
const bad = out.roles.flatMap((r: any) => r.bullets).filter((b: string) => !/[.!?]$/.test(b.trim()) || /^Kestrel Supply/.test(b));
console.log("lines per role", before.join(","), "→", after.join(","));
if (bad.length || before.join() !== after.join()) { console.error("FAILED", bad, refileBullets(profile, text).log); process.exit(1); }
// a line the reading really lost is still recovered, whole
const lost = JSON.parse(JSON.stringify(profile)); lost.roles[2].bullets.pop();
const back = refileBullets(lost, text).profile as any;
const got = back.roles[2].bullets.some((b: string) => /^Named top performer among a team of 4, for 4 months in a row\.$/.test(b));
console.log("lost line recovered whole:", got);
if (!got) process.exit(1);
// a cut-off copy of another role's line already in a reading is dropped
const dirty = JSON.parse(JSON.stringify(profile)); dirty.roles[1].bullets.push("Managed daily and weekly counts through the partner");
const clean = sanitizeProfile(dirty).profile as any;
console.log("cut-off copy dropped:", clean.roles[1].bullets.length === 2);
if (clean.roles[1].bullets.length !== 2) process.exit(1);
console.log("all right");
