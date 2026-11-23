// Offline checks: what counts as a US role, and that each system's feed is turned into the same shape. No network.
import { isUS, isRemote, plain, fromGreenhouse, fromLever, fromAshby } from "./lib.mjs";
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
console.log(bad ? `${bad} wrong` : "all right"); process.exit(bad ? 1 : 0);
