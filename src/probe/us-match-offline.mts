// Offline check of the US short list's free pass. Run: npx tsx src/probe/us-match-offline.mts
import { closest, keywords, near, titleScore, pretty, place, type Row } from "../lib/usmatch.js";
const row = (title: string, ref = "a", level = "senior", posted = "2026-11-20"): Row => ({ system: "greenhouse", ref, job_id: title + ref, title, location: "New York, NY", remote: false, url: "u", posted_at: posted, level, func: "design" });
const now = Date.parse("2026-11-23");
let bad = 0; const ok = (c: boolean, m: string) => { if (!c) { bad++; console.error("WRONG:", m); } };
ok(near("intern").join() === "intern,entry", "interns stay near the door");
ok(near("senior").join() === "mid,senior,leader", "one level either side");
ok(near("entry").join() === "entry,mid", "entry does not fall back to intern");
ok(keywords(["Senior Product Designer", "UX Designer"]).join() === "designer,product", "search words drop rank words and two-letter words");
const t = ["Senior Product Designer", "UX Designer"];
ok(titleScore(row("Senior Product Designer"), t, "senior", now) > titleScore(row("Product Manager"), t, "senior", now), "designer beats manager");
ok(titleScore(row("Diesel Mechanic"), t, "senior", now) < 0.21, "an unrelated title is dropped");
const rows = [row("Senior Product Designer", "x"), row("Staff Product Designer", "x"), row("Product Designer, Growth", "x"), row("Lead UX Designer", "y"), row("Diesel Mechanic", "z")];
const c = closest(rows, t, "senior", 40, now);
ok(c.filter((r) => r.ref === "x").length === 2, "no more than two from one employer");
ok(!c.some((r) => r.ref === "z"), "unrelated roles are not read closely");
ok(pretty("people-data-labs") === "People Data Labs", "board name reads as words");
ok(place("Remote", true) === "Remote (US)" && place("New York, NY; Boston, MA", false) === "New York, NY", "one short place");
console.log(bad ? `${bad} wrong` : "all right"); process.exit(bad ? 1 : 0);
