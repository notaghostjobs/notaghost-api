// The US reader: a separate checker, sharing nothing with the Bengaluru one. It asks employers' own hiring systems,
// through the public job-board feeds those systems publish, which roles are open in the United States.
// Rules it keeps: it says who it is, it only asks the employer's own system, it waits between requests, and it never
// disguises itself or works around a refusal.
export const UA = "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = new Map();   // host -> time of our last request to it

/** One polite GET. A gap is kept between requests to the same host; a 429 or 5xx is retried once after a wait; a 403/404 is an answer, not something to push past. */
export async function get(url, { gapMs = 250, timeoutMs = 25000, accept = "application/json" } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = (last.get(host) ?? 0) + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(host, Date.now());
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, accept }, signal: AbortSignal.timeout(timeoutMs) });
      if ((r.status === 429 || r.status >= 500) && attempt === 0) { await sleep(Number(r.headers.get("retry-after")) * 1000 || 4000); continue; }
      return { status: r.status, text: r.ok ? await r.text() : "" };
    } catch (e) { if (attempt === 1) return { status: 0, text: "", error: String(e?.message ?? e) }; await sleep(1500); }
  }
  return { status: 0, text: "" };
}
export async function getJson(url, o) { const r = await get(url, o); try { return { ...r, data: r.text ? JSON.parse(r.text) : null }; } catch { return { ...r, data: null }; } }

// ---- is this role in the United States?
const STATES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" ");
const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const CITIES = /\b(san francisco|sf bay|bay area|new york|nyc|seattle|austin|boston|chicago|los angeles|san diego|san jose|palo alto|mountain view|sunnyvale|menlo park|redwood city|santa clara|denver|atlanta|dallas|houston|miami|washington,? d\.?c\.?|philadelphia|phoenix|portland|salt lake city|minneapolis|detroit|pittsburgh|raleigh|charlotte|nashville|brooklyn|manhattan|boulder|irvine|bellevue)\b/i;
const ELSEWHERE = /\b(canada|united kingdom|\buk\b|england|ireland|germany|france|spain|netherlands|india|singapore|australia|japan|brazil|mexico|poland|israel|emea|apac|latam|europe|london|dublin|berlin|paris|toronto|vancouver|bengaluru|bangalore|sydney|tokyo|amsterdam|tel aviv|georgia, (?:tbilisi|the country))\b/i;
const US_NAME = /\b(?:united states|usa)\b|\bu\.s\.(?:a\.?)?/i, US_CODE = /(?:^|[\s(\-–,/])US(?:$|[\s)\-–,/])/;   // "US" only in capitals: "us" is a word
/** A location line names one place or several ("SF; NYC; London"). The role is a US role when any one of them is in the US. */
export function isUS(location, country) {
  if (country && /^(us|usa|united states)$/i.test(String(country).trim())) return true;
  const s = String(location ?? "").trim();
  if (!s) return false;
  return s.split(/\s*(?:;|\||\bor\b|\/(?!\w{1,2}\b))\s*/i).some((part) => {
    if (US_NAME.test(part) || US_CODE.test(part)) return true;
    const elsewhere = ELSEWHERE.test(part);
    if (!elsewhere && STATES.some((st) => new RegExp(`,\\s*${st}(?:\\b|$)`).test(part))) return true;
    if (!elsewhere && (CITIES.test(part) || STATE_NAMES.test(part))) return true;
    return false;
  });
}
export const isRemote = (s) => /\bremote\b|work from home|\bwfh\b|distributed/i.test(String(s ?? ""));

// ---- plain text out of a posting's HTML
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", bull: "•" };
const unent = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (m, k) => ENT[k.toLowerCase()] ?? (k[0] === "#" ? String.fromCodePoint(k[1].toLowerCase() === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)) : m));
export function plain(html) {
  let s = unent(String(html ?? ""));               // Greenhouse sends its HTML escaped once
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|li|h\d|tr|ul|ol)>|<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, " ");
  return unent(s).replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- one shape for a role, whatever system it came from
const job = (system, ref, x) => ({ system, ref, id: String(x.id), title: String(x.title ?? "").trim(), location: x.location ?? "", us: x.us, remote: x.remote, url: x.url, posted_at: x.posted_at ?? null, text: x.text ?? "" });

// A Greenhouse role also lists the offices it belongs to. They decide only when the location itself names no place
// ("Remote", "Hybrid", blank): a role located in "EU & UK" is not a US role because the company has a US office.
const VAGUE = /^(|remote|hybrid|anywhere|distributed|flexible|multiple locations?|various|global|worldwide|tbd|n\/a)$/i;
export function fromGreenhouse(data, ref) {
  return (data?.jobs ?? []).map((j) => { const loc = j.location?.name ?? "", offices = (j.offices ?? []).map((o) => o.location || o.name).filter(Boolean).join("; ");
    return job("greenhouse", ref, { id: j.id, title: j.title, location: loc, us: isUS(loc) || (VAGUE.test(loc.trim()) && isUS(offices)), remote: isRemote(loc), url: j.absolute_url, posted_at: j.first_published ?? j.updated_at, text: plain(j.content) }); });
}
export function fromLever(data, ref) {
  return (Array.isArray(data) ? data : []).map((j) => { const all = (j.categories?.allLocations ?? []).join("; "), loc = all || j.categories?.location || "";
    return job("lever", ref, { id: j.id, title: j.text, location: loc, us: isUS(loc, j.country), remote: j.workplaceType === "remote" || isRemote(loc), url: j.hostedUrl,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null, text: [j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text}\n${plain(l.content)}`), j.additionalPlain].filter(Boolean).join("\n\n").trim() }); });
}
export function fromAshby(data, ref) {
  return (data?.jobs ?? []).filter((j) => j.isListed !== false).map((j) => { const more = (j.secondaryLocations ?? []).map((l) => l.location).filter(Boolean), loc = [j.location, ...more].filter(Boolean).join("; ");
    const country = j.address?.postalAddress?.addressCountry;
    return job("ashby", ref, { id: j.id, title: j.title, location: loc, us: isUS(loc, country), remote: !!j.isRemote || isRemote(loc), url: j.jobUrl, posted_at: j.publishedAt ?? null, text: String(j.descriptionPlain ?? "").trim() || plain(j.descriptionHtml) }); });
}

/** Ask one employer's board for its open roles. `ok:false` with a status means the board did not answer or no longer exists. */
export async function readBoard(system, ref) {
  const e = encodeURIComponent(ref);
  const url = system === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${e}/jobs?content=true` : system === "lever" ? `https://api.lever.co/v0/postings/${e}?mode=json` : `https://api.ashbyhq.com/posting-api/job-board/${e}`;
  const r = await getJson(url);
  if (r.status !== 200 || r.data == null) return { ok: false, status: r.status, jobs: [] };
  const jobs = system === "greenhouse" ? fromGreenhouse(r.data, ref) : system === "lever" ? fromLever(r.data, ref) : fromAshby(r.data, ref);
  return { ok: true, status: 200, jobs };
}
