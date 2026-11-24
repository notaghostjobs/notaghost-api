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
console.log(bad ? `${bad} wrong` : "all right"); if (bad) process.exit(1);
// the "where" card offers a city only when it is certain
import { homeCity } from "../lib/usmatch.js";
{
  let bad2 = 0; const ok2 = (c: boolean, m: string) => { if (!c) { bad2++; console.error("WRONG:", m); } };
  const P = (city: string | null, state: string | null, country: string | null = "US") => (city ? { city, state, country } : null);
  const cv = "Maya Chen\nAustin, TX · maya@example.com · 555-0100\n\nEXPERIENCE\nSenior Designer, Acme — New York, NY (2019–2022)\nDesigner, Foo — Chicago, IL";
  ok2(homeCity(P("Austin", "TX"), cv) === "Austin", "the city in the contact line is offered");
  ok2(homeCity(P("New York", "NY"), cv) === null, "a city from a job entry is never offered");
  ok2(homeCity(P("Chicago", "IL"), cv) === null, "a city further down is never offered");
  ok2(homeCity(P("Austin", "CA"), cv) === null, "a state that does not match the line is refused");
  ok2(homeCity(P(null, null), cv) === null, "no city read, nothing offered");
  ok2(homeCity(P("Bengaluru", null, "IN"), "Ravi Kumar\nBengaluru, India · ravi@example.com\n\nExperience\n...") === null, "a city outside the US is not offered");
  ok2(homeCity(P("Austin", "TX"), "Maya Chen\nmaya@example.com\n\nSUMMARY\nDesigner.\n\nEXPERIENCE\nAcme, Austin, TX") === null, "no contact city: a job's city is not used");
  console.log(bad2 ? `${bad2} wrong (home city)` : "home city: all right"); if (bad2) process.exit(1);
}
