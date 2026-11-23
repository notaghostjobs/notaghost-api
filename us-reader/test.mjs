// Offline checks: what counts as a US role, and that each system's feed is turned into the same shape. No network.
import { isUS, isRemote, plain, fromGreenhouse, fromLever, fromAshby } from "./lib.mjs";
import { curate, visa, level, func } from "./curate.mjs";
let bad = 0; const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log("WRONG", name, "got", got, "want", want); } };
for (const s of ["San Francisco, CA", "New York, NY, United States", "Remote - US", "US Remote", "United States", "Remote (USA)", "NYC", "SF; NYC; London", "Austin, Texas", "Remote, U.S.", "Seattle, WA or Remote", "Washington, DC", "London, UK | Boston, MA", "Atlanta, GA"]) eq("US: " + s, isUS(s), true);
for (const s of ["London, UK", "Bengaluru, India", "Toronto, ON, Canada", "Remote - EMEA", "Remote", "", "Dublin, Ireland", "Tbilisi, Georgia, the country", "Sydney, Australia", "Vancouver, Canada", "Bangalore", "Remote (Europe)", "Business Development"]) eq("not US: " + s, isUS(s), false);
eq("country field", isUS("Remote", "US"), true);
eq("remote", [isRemote("Remote - US"), isRemote("Austin, TX")], [true, false]);
eq("plain", plain("&lt;p&gt;Build &amp;amp; ship.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;"), "Build & ship.\n• Python\n• SQL");
const gh = fromGreenhouse({ jobs: [{ id: 1, title: " Data Analyst ", location: { name: "Remote" }, offices: [{ name: "NYC", location: "New York, NY, United States" }], absolute_url: "https://boards.greenhouse.io/x/jobs/1", updated_at: "2026-11-20T00:00:00Z", content: "&lt;p&gt;Hi&lt;/p&gt;" }, { id: 2, title: "Eng", location: { name: "Berlin, Germany" }, absolute_url: "u2", content: "" }] }, "x");
eq("greenhouse", gh.map((j) => [j.id, j.title, j.us, j.remote, j.text]), [["1", "Data Analyst", true, true, "Hi"], ["2", "Eng", false, false, ""]]);
const lv = fromLever([{ id: "a", text: "PM", categories: { location: "Remote", allLocations: ["Remote"] }, country: "US", workplaceType: "remote", hostedUrl: "h", createdAt: 1763596800000, descriptionPlain: "About", lists: [{ text: "You", content: "<li>5 years</li>" }], additionalPlain: "Perks" }], "y");
eq("lever", [lv[0].us, lv[0].remote, lv[0].text, lv[0].posted_at?.slice(0, 4)], [true, true, "About\n\nYou\n• 5 years\n\nPerks", "2025"]);
const ab = fromAshby({ jobs: [{ id: "q", title: "SWE", location: "London", secondaryLocations: [{ location: "New York" }], isRemote: false, jobUrl: "j", publishedAt: "2026-11-01", descriptionPlain: "Do things", isListed: true }, { id: "h", title: "Hidden", isListed: false }] }, "z");
eq("ashby", ab.map((j) => [j.id, j.us, j.location]), [["q", true, "London; New York"]]);
// curation
const T = "x".repeat(420), day = 86400e3, now = Date.parse("2026-11-23T00:00:00Z");
const J = (o) => ({ us: true, title: "Data Analyst", text: T, posted_at: new Date(now - 5 * day).toISOString(), ...o });
const c1 = curate([J({}), J({ title: "Data Analyst - Austin" }), J({ title: "Data Analyst (Remote)" }), J({ title: "Old one", posted_at: new Date(now - 60 * day).toISOString() }), J({ title: "Thin", text: "short" }), J({ title: "Agent", text: T + " This is a commission-only role." }), J({ title: "Not US", us: false })], { now });
eq("curate keeps", c1.keep.map((j) => [j.title, j.places]), [["Data Analyst", 3]]);
eq("curate why", c1.why, { not_fresh: 1, thin_text: 1, same_role_elsewhere: 2, middleman: 0, commission: 1 });
const c2 = curate(Array.from({ length: 6 }, (_, i) => J({ title: "Role " + i, text: T + (i < 3 ? " Our client is a leading bank." : "") })), { now });
eq("middleman board", [c2.middleman, c2.keep.length], [true, 0]);
eq("visa", [visa("We are unable to sponsor visas for this role."), visa("Visa sponsorship is available."), visa("Great team."), visa("Must be a US citizen.")], ["no", "yes", "unstated", "no"]);
eq("level", ["Software Engineering Intern", "Junior Analyst", "Senior Engineer", "Director of Sales", "Product Designer", "Software Engineer II"].map(level), ["intern", "entry", "senior", "leader", "mid", "mid"]);
eq("func", ["Staff Software Engineer", "Data Analyst", "Account Executive", "Registered Nurse", "Barista"].map(func), ["engineering", "data", "sales", "healthcare", "other"]);
console.log(bad ? `${bad} wrong` : "all right"); process.exit(bad ? 1 : 0);
