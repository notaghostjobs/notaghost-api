// Ghosted's public pages about the Bengaluru job market (19 Nov). Until now nothing Ghosted knows could be found by a
// search engine, or by an AI assistant answering "product manager jobs in Bengaluru". These pages say what is true today:
//   /jobs/bengaluru                 the hub: which roles and employers have openings
//   /jobs/bengaluru/<role>          how many are open, at whom, when they were last confirmed, and five examples
//   /jobs/bengaluru/at/<employer>   how many that employer has open, in which roles, and five examples
// They are deliberately not a job board. Ghosted's point is that a long list is the problem: a page states the market
// and shows a handful, and the list that fits one person is Radar's work, not a page to scroll.
//
// What is deliberately absent (19 Nov): "opened this week" and "taken down this week". Checked against the Reader's
// records, a third of the week's 4,670 closings had the same title still open at the same employer (a posting re-listed
// under a new id reads as one closed and one opened), and a fifth closed within three days of first being seen. Until
// the Reader can tell a re-listing from a closing, those are not numbers to publish. What is published is what holds:
// how many are open now, at whom, and when each was last confirmed.
//   /jobs/bengaluru/roles, /employers, and /jobs/sitemap.xml
//
// One inventory: the pages are drawn from the same in-memory list Radar and the assistants' tools read (mcp.ts jobPool).
// Facts only: a title, an employer, a place, two dates and the employer's own link. The Reader's promise stands — a
// posting's own text is never republished here; the link goes to it.
// The site serves these under notaghost.jobs through one forwarding rule on its host, so every link here is site-relative.
import { Hono, type Context } from "hono";
import { jobPool } from "./mcp.js";
import { words, type Sighting } from "./radar.js";

export const jobs = new Hono();

const SITE = "https://notaghost.jobs", API = "https://api.notaghost.jobs", CITY = "Bengaluru", BASE = "/jobs/bengaluru";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const slugOf = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (iso?: string | null) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso ?? ""); return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : ""; };
const dm = (iso?: string | null) => dmy(iso).replace(/ \d{4}$/, "");
const place = (loc: string | null | undefined) => { const l = String(loc ?? "").trim(); const m = /^(\d+) Locations? \((?:Bengaluru facet|incl\. Bengaluru)\)$/i.exec(l); return m ? `${CITY} (one of ${m[1]} locations)` : l || CITY; };
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- the index: roles and employers, from the titles themselves
/** Words that say how senior a seat is, never what the job is. Taken out before a role is named. */
const LEVEL = new Set("senior sr jr junior lead principal staff associate assistant asst chief head deputy trainee intern apprentice graduate fresher i ii iii iv v vi l1 l2 l3 l4 l5 l6 level grade".split(" "));
/** The noun a role name ends on. A phrase that does not end on one of these is a department or a product, not a role. */
const HEAD = new Set("manager engineer analyst developer designer scientist architect consultant specialist executive representative accountant recruiter administrator tester writer partner officer coordinator technician advisor programmer strategist planner auditor counsel buyer trainer editor researcher director nurse pharmacist teacher lawyer underwriter".split(" "));
/** Words that turn up between two titles or name a vendor, never part of a role's own name. */
const GLUE = new Set("google microsoft amazon aws oracle ibm meta apple accenture deloitte projects services service role roles job jobs opening openings hiring required urgent immediate".split(" "));
const UP: Record<string, string> = { qa: "QA", hr: "HR", ui: "UI", ux: "UX", sre: "SRE", it: "IT", ai: "AI", ml: "ML", sap: "SAP", devops: "DevOps", seo: "SEO", crm: "CRM", erp: "ERP", bi: "BI", sql: "SQL", aws: "AWS", ios: "iOS", api: "API", pmo: "PMO", fp: "FP", ar: "AR", ap: "AP", gtm: "GTM", sdet: "SDET", netsuite: "NetSuite", servicenow: "ServiceNow", salesforce: "Salesforce", java: "Java" };
const nameOf = (phrase: string) => phrase.split(" ").map((w) => UP[w] ?? w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const roleTokens = (title: string) => words(title).filter((w) => !LEVEL.has(w) && !/^\d+$/.test(w));

type Role = { slug: string; name: string; phrase: string; ids: number[] };
type Emp = { slug: string; name: string; ids: number[] };
type Index = { pool: Sighting[]; byId: Map<number, Sighting>; roles: Role[]; roleBy: Map<string, Role>; emps: Emp[]; empBy: Map<string, Emp>; empOf: Map<number, Emp>; checked: string };
let index: Index | null = null;
const MIN_ROLE = 6, MAX_ROLES = 400;

function build(pool: Sighting[]): Index {
  const byId = new Map(pool.map((s) => [s.id, s]));
  // every two- and three-word phrase a title carries that ends on a role noun, counted once per posting
  const grams = new Map<string, number[]>();
  for (const s of pool) {
    const t = roleTokens(s.title); const seen = new Set<string>();
    for (let i = 0; i < t.length; i++) for (const n of [2, 3]) {
      if (i + n > t.length || !HEAD.has(t[i + n - 1])) continue;
      if (t.slice(i, i + n - 1).some((w) => HEAD.has(w) || GLUE.has(w))) continue;   // "manager director", "service google consultant": two titles run together, or an employer's name in the middle
      const g = t.slice(i, i + n).join(" "); if (seen.has(g) || g.length > 48) continue; seen.add(g);
      let a = grams.get(g); if (!a) grams.set(g, a = []); a.push(s.id);
    }
  }
  // a two-word phrase that is almost always the tail of one three-word role ("development engineer" inside "software
  // development engineer") is not a role of its own
  const drop = new Set<string>();
  for (const [g, ids] of grams) { if (g.split(" ").length !== 3 || ids.length < MIN_ROLE) continue; const tail = g.split(" ").slice(1).join(" "); const t = grams.get(tail); if (t && ids.length >= t.length * 0.8) drop.add(tail); }
  const roles = [...grams].filter(([g, ids]) => ids.length >= MIN_ROLE && !drop.has(g)).sort((a, b) => b[1].length - a[1].length).slice(0, MAX_ROLES)
    .map(([g, ids]) => ({ slug: g.replace(/ /g, "-"), name: nameOf(g), phrase: g, ids }));
  // employers: by the Reader's own key, shown under the name most of their postings carry
  const groups = new Map<string, Sighting[]>();
  for (const s of pool) { const k = s.employer_key || (s.company_name ?? "").toLowerCase().trim(); if (!k) continue; let a = groups.get(k); if (!a) groups.set(k, a = []); a.push(s); }
  const emps: Emp[] = []; const used = new Set<string>(); const empOf = new Map<number, Emp>();
  for (const [k, rows] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const names = new Map<string, number>(); for (const r of rows) { const n = (r.company_name ?? "").trim(); if (n) names.set(n, (names.get(n) ?? 0) + 1); }
    const name = [...names].sort((a, b) => b[1] - a[1])[0]?.[0]; if (!name) continue;
    let slug = slugOf(name) || slugOf(k); if (!slug) continue; for (let n = 2; used.has(slug); n++) slug = `${slugOf(name)}-${n}`; used.add(slug);
    const e = { slug, name, ids: rows.map((r) => r.id) }; emps.push(e); for (const r of rows) empOf.set(r.id, e);
  }
  const checked = pool.reduce((m, s) => (s.last_seen && s.last_seen > m ? s.last_seen : m), "");
  return { pool, byId, roles, roleBy: new Map(roles.map((r) => [r.slug, r])), emps, empBy: new Map(emps.map((e) => [e.slug, e])), empOf, checked: checked || new Date().toISOString() };
}
async function idx(): Promise<Index> { const pool = await jobPool(); if (!index || index.pool !== pool) index = build(pool); return index; }

// ---------------------------------------------------------------- the page
const CSS = `
@font-face{font-family:'Inter Tight';font-weight:800;font-display:swap;src:url(/fonts/inter-tight-800.woff2) format('woff2')}
@font-face{font-family:'Inter';font-weight:400;font-display:swap;src:url(/fonts/inter-400.woff2) format('woff2')}
@font-face{font-family:'Inter';font-weight:600;font-display:swap;src:url(/fonts/inter-600.woff2) format('woff2')}
@font-face{font-family:'Newsreader';font-style:italic;font-weight:400;font-display:swap;src:url(/fonts/newsreader-400-italic.woff2) format('woff2')}
:root{--ink:#0c0c10;--ink-2:#2b2b33;--ink-3:#4e4e58;--mute:#8b8b98;--line:#e7e7ec;--paper-2:#f3f3f6;--mint:#7be0a8;--green:#0f7a50;--n1:#0a0d16;--n2:#161a2a}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:var(--ink);font:16px/1.5 'Inter',system-ui,-apple-system,'Segoe UI',sans-serif}
a{color:inherit}.w{max-width:860px;margin:0 auto;padding:0 20px}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.brand{display:flex;align-items:center;gap:9px;text-decoration:none;font:800 19px/1 'Inter Tight','Inter',sans-serif;letter-spacing:-.02em}
.brand img{width:28px;height:28px}
header nav a{font-size:14px;color:var(--ink-3);text-decoration:none;margin-left:18px}
.crumb{font-size:13px;color:var(--mute);margin:8px 0 0}.crumb a{color:var(--ink-3)}
h1{font:800 clamp(30px,6vw,46px)/1.04 'Inter Tight','Inter',sans-serif;letter-spacing:-.035em;margin:14px 0 0}
h1 em{font:400 1.08em/1 'Newsreader',Georgia,serif;font-style:italic;letter-spacing:-.01em}
.sum{font-size:17px;line-height:1.5;color:var(--ink-2);margin:14px 0 0;max-width:62ch}
h2{font:800 20px/1.2 'Inter Tight','Inter',sans-serif;letter-spacing:-.02em;margin:34px 0 10px}
.radar{margin:22px 0 0;border-radius:20px;padding:18px 20px;color:#fff;background:linear-gradient(135deg,var(--n1),var(--n2));display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.radar b{display:block;font:800 18px/1.2 'Inter Tight','Inter',sans-serif;letter-spacing:-.02em}.radar span{display:block;font-size:14px;color:#c9cbd6;margin-top:3px;max-width:46ch}
.btn{display:inline-block;background:var(--mint);color:var(--ink);font-weight:600;font-size:15px;text-decoration:none;border-radius:999px;padding:11px 18px;white-space:nowrap}
ol.jobs{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
ol.jobs li{padding:14px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:1fr auto;gap:4px 16px;align-items:start}
.jt{font-weight:600;font-size:16.5px;line-height:1.3;text-decoration:none}.jt:hover{text-decoration:underline}
.jm{grid-column:1;font-size:14px;color:var(--ink-3)}.jm a{color:var(--ink-2)}
.jd{grid-column:1;font-size:13px;color:var(--mute)}
.ja{grid-row:1/span 3;grid-column:2;display:grid;gap:6px;justify-items:end;font-size:13.5px}
.ja a.go{background:var(--ink);color:#fff;border-radius:999px;padding:8px 14px;text-decoration:none;font-weight:600;white-space:nowrap}
.ja a.fit{color:var(--green);font-weight:600;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.chips a{display:block;border:1px solid var(--line);border-radius:999px;padding:7px 13px;font-size:14px;text-decoration:none}.chips a:hover{border-color:var(--ink)}.chips small{color:var(--mute);margin-left:5px}
.note{background:var(--paper-2);border-radius:16px;padding:16px 18px;font-size:14.5px;color:var(--ink-2);margin:30px 0 0}.note b{color:var(--ink)}
.more{font-size:14px;color:var(--ink-3);margin:14px 0 0}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:22px 0 0;padding:0;list-style:none}.facts li{background:var(--paper-2);border-radius:16px;padding:14px 16px}.facts b{display:block;font:800 30px/1 'Inter Tight','Inter',sans-serif;letter-spacing:-.03em}.facts span{display:block;font-size:13px;line-height:1.35;color:var(--ink-3);margin-top:6px}
footer{margin:44px 0 0;padding:22px 0 40px;border-top:1px solid var(--line);font-size:13px;color:var(--mute);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}footer a{color:var(--ink-3);margin-left:14px}
@media(max-width:560px){ol.jobs li{grid-template-columns:1fr}.ja{grid-row:auto;grid-column:1;display:flex;gap:14px;align-items:center;justify-items:start;margin-top:6px}header nav a.hide{display:none}}
`.replace(/\n/g, "");
// Where this visitor came from, kept the way the app keeps it (same site, same storage), so a visit that began in an
// assistant's answer or a search result is counted through to a purchase. Nothing here identifies the person.
const TRACK = `(function(){try{var q=new URLSearchParams(location.search),u=(q.get('utm_source')||'').toLowerCase(),r=document.referrer||'',h='';try{h=new URL(r).hostname}catch(e){}var k=u+' '+h,t=(q.get('src')||'').toLowerCase()||(/chatgpt|openai/.test(k)?'chatgpt':/claude|anthropic/.test(k)?'claude':/perplexity/.test(k)?'perplexity':/gemini|bard/.test(k)?'gemini':/copilot|bing/.test(k)?'bing':/google\\./.test(h)?'google':/duckduckgo/.test(h)?'duckduckgo':h&&h.indexOf('notaghost.jobs')<0?'web':'');if(h.indexOf('notaghost.jobs')>=0&&!q.get('src')&&!u)t='';if(t&&!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(t))t='';var L=localStorage,f=L.getItem('ng.src.first');if(!t&&!f)t='jobs';if(t){if(!f){L.setItem('ng.src.first',t);L.setItem('ng.src.at',new Date().toISOString());f=t}L.setItem('ng.src.last',t);fetch('${API}/events/click',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({src:t,first:f,path:location.pathname,ref:r.slice(0,200)}),keepalive:true}).catch(function(){})}var g=t||L.getItem('ng.src.last')||'jobs';document.querySelectorAll('a[data-g]').forEach(function(a){a.href=a.href.replace('src=jobs','src='+g)})}catch(e){}})();`;

type Page = { path: string; title: string; desc: string; h1: string; sum: string; body: string; crumbs: [string, string][]; ld?: object[]; noindex?: boolean };
function html(p: Page): string {
  const crumbLd = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [["Ghosted", "/"], ...p.crumbs].map(([n, u], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: SITE + u })) };
  const ld = [crumbLd, ...(p.ld ?? [])].map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("");
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)}</title><meta name="description" content="${esc(p.desc)}">${p.noindex ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${SITE}${p.path}">`}<meta property="og:type" content="website"><meta property="og:site_name" content="Ghosted"><meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.desc)}"><meta property="og:url" content="${SITE}${p.path}"><meta property="og:image" content="${SITE}/og.png"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${CSS}</style>${ld}</head><body><div class="w"><header><a class="brand" href="/"><img src="/favicon.svg" alt="" width="28" height="28">Ghosted</a><nav><a class="hide" href="${BASE}/roles">Roles</a><a class="hide" href="${BASE}/employers">Employers</a><a data-g href="/app.html?src=jobs#/v2/radar">Radar</a></nav></header><main><p class="crumb">${p.crumbs.map(([n, u], i) => i === p.crumbs.length - 1 ? esc(n) : `<a href="${u}">${esc(n)}</a>`).join(" › ")}</p><h1>${p.h1}</h1><p class="sum">${p.sum}</p>${p.body}</main><footer><span>© ${new Date().getFullYear()} notaghost.jobs</span><span><a href="/reader/">How Ghosted checks employers</a><a href="/terms/">Terms</a><a href="/privacy/">Privacy</a></span></footer></div><script>${TRACK}</script></body></html>`;
}
const radar = (line: string) => `<aside class="radar"><div><b>${line}</b><span>A long list is not the same as a real chance. Radar reads your résumé and shows the roles you are a real shot at, every morning.</span></div><a class="btn" data-g href="/app.html?src=jobs#/v2/radar">See how Radar works</a></aside>`;
const HOW = `<p class="note"><b>Where these numbers come from.</b> Ghosted checks employers’ own hiring systems, not job boards. A role is counted while it is open on the employer’s own site and stops being counted when the employer takes it down. The dates say when Ghosted last confirmed it there. Coverage is ${CITY} only, and not every employer is covered. Ghosted is not a job board: these pages show a few examples, and each links to the employer’s own posting.</p>`;
const facts = (items: [string | number, string][]) => `<ul class="facts">${items.map(([n, l]) => `<li><b>${typeof n === "number" ? n.toLocaleString("en-IN") : esc(n)}</b><span>${esc(l)}</span></li>`).join("")}</ul>`;
const EXAMPLES = 5;
/** a handful to make the numbers concrete: the newest, one per employer */
const examples = (list: Sighting[]) => pick(list, EXAMPLES, 1);
const newest = (a: Sighting, b: Sighting) => (b.posted_at ?? b.first_seen).localeCompare(a.posted_at ?? a.first_seen);
function rows(ix: Index, list: Sighting[], showCompany: boolean): string {
  return `<ol class="jobs">${list.map((s) => { const e = ix.empOf.get(s.id); const since = dmy(s.posted_at ?? s.first_seen), seen = dmy(s.last_seen);
    return `<li><a class="jt" href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.title)}</a><span class="jm">${showCompany ? (e ? `<a href="${BASE}/at/${e.slug}">${esc(e.name)}</a>` : esc(s.company_name ?? "")) + " · " : ""}${esc(place(s.location))}</span><span class="jd">${since ? `On the employer’s site since ${since}` : ""}${since && seen ? " · " : ""}${seen ? `confirmed open ${seen}` : ""}</span><span class="ja"><a class="go" href="${esc(s.url)}" rel="noopener" target="_blank">Employer’s posting</a><a class="fit" data-g href="/app.html?src=jobs#/v2/sharpen?u=${encodeURIComponent(s.url)}">See how your résumé fits</a></span></li>`; }).join("")}</ol>`;
}
const itemList = (name: string, list: Sighting[]) => ({ "@context": "https://schema.org", "@type": "ItemList", name, numberOfItems: list.length, itemListElement: list.slice(0, 50).map((s, i) => ({ "@type": "ListItem", position: i + 1, name: `${s.title} · ${s.company_name ?? ""}`, url: s.url })) });
const span = (list: Sighting[]) => { const d = list.map((s) => s.last_seen ?? "").filter(Boolean).sort(); return d.length ? (d[0].slice(0, 10) === d[d.length - 1].slice(0, 10) ? `on ${dmy(d[0])}` : `between ${dm(d[0])} and ${dmy(d[d.length - 1])}`) : ""; };
/** the newest first, and no employer more than `cap` times in what is shown, so one large employer does not fill the page */
function pick(list: Sighting[], max: number, cap: number): Sighting[] {
  const out: Sighting[] = [], held: Sighting[] = [], per = new Map<string, number>();
  for (const s of [...list].sort(newest)) { const k = s.employer_key ?? s.company_name ?? ""; const n = per.get(k) ?? 0; if (n < cap) { out.push(s); per.set(k, n + 1); } else held.push(s); if (out.length >= max) break; }
  return out.length < max ? [...out, ...held.slice(0, max - out.length)] : out;
}
const chips = (items: { href: string; name: string; n: number }[]) => `<ul class="chips">${items.map((x) => `<li><a href="${x.href}">${esc(x.name)}<small>${x.n.toLocaleString("en-IN")}</small></a></li>`).join("")}</ul>`;
const send = (c: Context, body: string, status: 200 | 404 = 200) => c.html(body, status, { "cache-control": status === 200 ? "public, max-age=900, s-maxage=1800" : "no-store", "x-content-type-options": "nosniff" });
const missing = (c: Context, what: string) => send(c, html({ path: BASE, noindex: true, title: `Not found · Ghosted`, desc: "", h1: `Nothing open <em>under that name.</em>`, sum: `${esc(what)} Roles come and go as employers open and close them.`, crumbs: [["Jobs in " + CITY, BASE], ["Not found", ""]], body: `<p class="more"><a href="${BASE}">See the roles open in ${CITY} now</a></p>` }), 404);

// ---------------------------------------------------------------- routes
jobs.get("/", (c) => c.redirect(BASE, 302));
jobs.get("/bengaluru", async (c) => {
  const ix = await idx(); const when = dmy(ix.checked);
  return send(c, html({ path: BASE, crumbs: [["Jobs in " + CITY, BASE]],
    title: `The ${CITY} job market today, from employers’ own sites · Ghosted`,
    desc: `Which roles and employers have openings in ${CITY} today. Counted on ${ix.emps.length} employers’ own hiring systems, last checked ${when}.`,
    h1: `Jobs in ${CITY}, <em>as they stand today.</em>`,
    sum: `${plural(ix.emps.length, "employer has", "employers have")} roles open in ${CITY} right now, across ${ix.roles.length} kinds of role. Counted on employers’ own hiring systems, last checked ${when}.`,
    body: `${facts([[ix.emps.length, "employers with roles open"], [ix.roles.length, "kinds of role with openings"], [when, "last checked"]])}${radar("Thousands are open. A few are yours.")}<h2>Roles with the most openings</h2>${chips(ix.roles.slice(0, 60).map((r) => ({ href: `${BASE}/${r.slug}`, name: r.name, n: r.ids.length })))}<p class="more"><a href="${BASE}/roles">All ${ix.roles.length} roles</a></p><h2>Employers hiring most</h2>${chips(ix.emps.slice(0, 60).map((e) => ({ href: `${BASE}/at/${e.slug}`, name: e.name, n: e.ids.length })))}<p class="more"><a href="${BASE}/employers">All ${ix.emps.length} employers</a></p>${HOW}` }));
});
jobs.get("/bengaluru/roles", async (c) => {
  const ix = await idx(); const az = [...ix.roles].sort((a, b) => a.name.localeCompare(b.name));
  return send(c, html({ path: `${BASE}/roles`, crumbs: [["Jobs in " + CITY, BASE], ["Roles", ""]], title: `Every role open in ${CITY} now · Ghosted`, desc: `${ix.roles.length} kinds of role have openings in ${CITY} today, confirmed on employers’ own hiring systems.`,
    h1: `Every role <em>open now.</em>`, sum: `${ix.roles.length} kinds of role have at least ${MIN_ROLE} openings in ${CITY} today. The number beside each is how many are open on employers’ own sites.`, body: `<h2>A to Z</h2>${chips(az.map((r) => ({ href: `${BASE}/${r.slug}`, name: r.name, n: r.ids.length })))}${HOW}` }));
});
jobs.get("/bengaluru/employers", async (c) => {
  const ix = await idx(); const az = [...ix.emps].sort((a, b) => a.name.localeCompare(b.name));
  return send(c, html({ path: `${BASE}/employers`, crumbs: [["Jobs in " + CITY, BASE], ["Employers", ""]], title: `Employers hiring in ${CITY} now · Ghosted`, desc: `${ix.emps.length} employers have roles open in ${CITY} today, each confirmed on the employer’s own hiring system.`,
    h1: `Employers <em>hiring now.</em>`, sum: `${plural(ix.emps.length, "employer has", "employers have")} at least one role open in ${CITY} today. The number beside each is how many postings are open on its own site.`, body: `<h2>A to Z</h2>${chips(az.map((e) => ({ href: `${BASE}/at/${e.slug}`, name: e.name, n: e.ids.length })))}${HOW}` }));
});
jobs.get("/bengaluru/at/:emp", async (c) => {
  const ix = await idx(); const e = ix.empBy.get(c.req.param("emp")); if (!e) return missing(c, "No employer by that name has a role open here today.");
  const all = e.ids.map((id) => ix.byId.get(id)!).filter(Boolean); const n = all.length; const list = [...all].sort(newest).slice(0, EXAMPLES);
  const kinds = ix.roles.map((r) => ({ r, n: r.ids.reduce((k, id) => k + (ix.empOf.get(id) === e ? 1 : 0), 0) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const path = `${BASE}/at/${e.slug}`;
  return send(c, html({ path, crumbs: [["Jobs in " + CITY, BASE], ["Employers", `${BASE}/employers`], [e.name, ""]],
    title: `${e.name} jobs in ${CITY}: ${n.toLocaleString("en-IN")} open now · Ghosted`, desc: `${e.name} has ${plural(n, "role", "roles")} open in ${CITY}. Counted on ${e.name}’s own hiring site, confirmed ${span(all)}.`,
    h1: `${esc(e.name)}, <em>hiring in ${CITY}.</em>`, sum: `${esc(e.name)} has ${plural(n, "role", "roles")} open in ${CITY} right now. Ghosted counted ${n === 1 ? "it" : "them"} on ${esc(e.name)}’s own hiring site, confirmed ${span(all)}.`,
    ld: [itemList(`${e.name} jobs in ${CITY}`, list)],
    body: `${facts([[n, n === 1 ? "role open now" : "roles open now"], [kinds.length, kinds.length === 1 ? "kind of role" : "kinds of role"], [dm(all.map((x) => x.last_seen ?? "").sort().pop()), "last confirmed"]])}${radar(n > EXAMPLES ? `Not all ${n.toLocaleString("en-IN")} are for you.` : "Is one of these for you?")}${kinds.length ? `<h2>What ${esc(e.name)} is hiring for</h2>${chips(kinds.slice(0, 16).map((x) => ({ href: `${BASE}/${x.r.slug}`, name: x.r.name, n: x.n })))}` : ""}<h2>${n > list.length ? `${list.length} of the newest` : plural(n, "open role", "open roles")}</h2>${rows(ix, list, false)}${HOW}` }));
});
jobs.get("/bengaluru/:role", async (c) => {
  const ix = await idx(); const r = ix.roleBy.get(c.req.param("role")); if (!r) return missing(c, "No role by that name has enough openings here today.");
  const all = r.ids.map((id) => ix.byId.get(id)!).filter(Boolean); const n = all.length; const list = examples(all);
  const emps = new Map<string, number>(); for (const s of all) { const e = ix.empOf.get(s.id); if (e) emps.set(e.slug, (emps.get(e.slug) ?? 0) + 1); }
  const top = [...emps].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([slug, k]) => ({ href: `${BASE}/at/${slug}`, name: ix.empBy.get(slug)!.name, n: k }));
  // roles that share a word with this one, the busiest first
  const mine = new Set(r.phrase.split(" ").filter((w) => !HEAD.has(w))); const head = r.phrase.split(" ").pop()!;
  const near = ix.roles.filter((x) => x !== r && (x.phrase.split(" ").some((w) => mine.has(w)) || x.phrase.endsWith(" " + head))).sort((a, b) => Number(b.phrase.split(" ").some((w) => mine.has(w))) - Number(a.phrase.split(" ").some((w) => mine.has(w))) || b.ids.length - a.ids.length).slice(0, 14);
  const path = `${BASE}/${r.slug}`;
  return send(c, html({ path, crumbs: [["Jobs in " + CITY, BASE], ["Roles", `${BASE}/roles`], [r.name, ""]],
    title: `${r.name} jobs in ${CITY}: ${n.toLocaleString("en-IN")} open now · Ghosted`, desc: `${plural(n, `${r.name} role is`, `${r.name} roles are`)} open in ${CITY} at ${plural(emps.size, "employer", "employers")}. Counted on employers’ own hiring sites, confirmed ${span(all)}.`,
    h1: `${esc(r.name)} jobs <em>in ${CITY}.</em>`, sum: `${plural(n, `${esc(r.name)} role is`, `${esc(r.name)} roles are`)} open in ${CITY} right now, at ${plural(emps.size, "employer", "employers")}. Ghosted counted them on the employers’ own hiring sites, confirmed ${span(all)}.`,
    ld: [itemList(`${r.name} jobs in ${CITY}`, list)],
    body: `${facts([[n, "open now"], [emps.size, emps.size === 1 ? "employer hiring" : "employers hiring"], [dm(all.map((x) => x.last_seen ?? "").sort().pop()), "last confirmed"]])}${radar(n > EXAMPLES ? `Not all ${n.toLocaleString("en-IN")} are for you.` : "Is one of these for you?")}<h2>Who is hiring ${esc(r.name)}s</h2>${chips(top)}<h2>${n > list.length ? `${list.length} of the newest, one per employer` : plural(n, "open role", "open roles")}</h2>${rows(ix, list, true)}${near.length ? `<h2>Related roles</h2>${chips(near.map((x) => ({ href: `${BASE}/${x.slug}`, name: x.name, n: x.ids.length })))}` : ""}${HOW}` }));
});
jobs.get("/sitemap.xml", async (c) => {
  const ix = await idx(); const day = new Date().toISOString().slice(0, 10);
  const urls = [BASE, `${BASE}/roles`, `${BASE}/employers`, ...ix.roles.map((r) => `${BASE}/${r.slug}`), ...ix.emps.map((e) => `${BASE}/at/${e.slug}`)];
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${SITE}${u}</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq></url>`).join("\n")}\n</urlset>\n`, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
});
