// One polite HTTP client for every reader. It says who it is, honours robots.txt, spaces requests per host,
// and backs off on 429/5xx. Nothing here pretends to be a browser.
export const UA = "GhostedReader/1.0 (+https://notaghost.jobs/reader/; hello@notaghost.jobs)";
const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HttpOpts { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; gapMs?: number; retries?: number }

/** Thrown when robots.txt disallows the path for us. Callers that return {ok,status} report it as status -1. */
export class RobotsDisallowed extends Error { constructor(url: string) { super(`disallowed by robots.txt: ${url}`); this.name = "RobotsDisallowed"; } }
export const ROBOTS_STATUS = -1;

// ---- robots.txt (RFC 9309): one group per host, cached 24h; our own name wins over "*"; longest rule wins; wildcards * and $ ----
interface Rules { allow: string[]; disallow: string[]; delayMs: number }
const robots = new Map<string, { at: number; rules: Rules | null }>();
const ROBOTS_TTL = 24 * 3600 * 1000;
export const robotsStats = { checked: 0, blocked: 0 };

function parseRobots(text: string): Rules {
  const groups: { agents: string[]; allow: string[]; disallow: string[]; delay: number }[] = [];
  let cur: (typeof groups)[number] | null = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim(); if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false; if (!cur) continue;
    if (key === "allow" && val) cur.allow.push(val);
    else if (key === "disallow") { if (val) cur.disallow.push(val); }
    else if (key === "crawl-delay") { const n = parseFloat(val); if (n > 0) cur.delay = Math.min(n, 30) * 1000; }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a === "ghostedreader" || a.startsWith("ghostedreader/")));
  const star = groups.filter((g) => g.agents.includes("*"));
  const use = mine.length ? mine : star;
  return { allow: use.flatMap((g) => g.allow), disallow: use.flatMap((g) => g.disallow), delayMs: Math.max(0, ...use.map((g) => g.delay)) };
}

const toRe = (p: string) => new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$"));
function allowed(rules: Rules, path: string): boolean {
  let best: { len: number; allow: boolean } = { len: -1, allow: true };
  for (const p of rules.allow) if (toRe(p).test(path) && p.length > best.len) best = { len: p.length, allow: true };
  for (const p of rules.disallow) if (toRe(p).test(path) && p.length > best.len) best = { len: p.length, allow: false };
  return best.allow;
}

async function rulesFor(origin: string): Promise<Rules | null> {
  const hit = robots.get(origin); if (hit && Date.now() - hit.at < ROBOTS_TTL) return hit.rules;
  let rules: Rules | null = null;
  try {
    const r = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": UA, accept: "text/plain,*/*;q=0.5" }, signal: AbortSignal.timeout(10000), redirect: "follow" });
    if (r.ok) { const ct = r.headers.get("content-type") ?? ""; const t = await r.text(); if (!/html/i.test(ct) && !/^\s*</.test(t)) rules = parseRobots(t); }
    // 4xx / 5xx / no file → nothing is disallowed (RFC 9309 §2.3.1.3–4)
  } catch { /* unreachable → treat as no rules */ }
  robots.set(origin, { at: Date.now(), rules });
  return rules;
}

/** True when robots.txt lets us fetch this URL. Cheap after the first call per host. */
export async function robotsAllows(url: string): Promise<boolean> {
  const u = new URL(url); const rules = await rulesFor(u.origin); robotsStats.checked++;
  if (!rules) return true;
  const ok = allowed(rules, u.pathname + u.search); if (!ok) robotsStats.blocked++;
  return ok;
}

/** Fetch with robots.txt, per-host spacing (default 400ms, or the site's Crawl-delay if longer) and up to `retries` backoffs on 429/503. Throws on final failure. */
export async function http(url: string, o: HttpOpts = {}): Promise<Response> {
  const u = new URL(url); const host = u.host;
  const rules = await rulesFor(u.origin); robotsStats.checked++;
  if (rules && !allowed(rules, u.pathname + u.search)) { robotsStats.blocked++; throw new RobotsDisallowed(url); }
  const gap = Math.max(o.gapMs ?? 400, rules?.delayMs ?? 0);
  const wait = (lastHit.get(host) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  const headers: Record<string, string> = { "user-agent": UA, accept: "application/json, text/html;q=0.9, */*;q=0.8", "accept-language": "en-IN,en;q=0.9", ...(o.headers ?? {}) };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  let last: Response | null = null;
  for (let attempt = 0; attempt <= (o.retries ?? 2); attempt++) {
    const r = await fetch(url, { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: AbortSignal.timeout(o.timeoutMs ?? 15000), redirect: "follow" });
    if (r.status !== 429 && r.status < 500) return r;
    last = r;
    await sleep(1500 * 2 ** attempt);
    lastHit.set(host, Date.now());
  }
  return last!;
}

export async function getJson<T = any>(url: string, o: HttpOpts = {}): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const r = await http(url, o);
    if (!r.ok) return { ok: false, status: r.status, data: null };
    const text = await r.text();
    try { return { ok: true, status: r.status, data: JSON.parse(text) as T }; } catch { return { ok: false, status: r.status, data: null }; }
  } catch (e) { return { ok: false, status: e instanceof RobotsDisallowed ? ROBOTS_STATUS : 0, data: null }; }
}

export async function getText(url: string, o: HttpOpts = {}): Promise<{ ok: boolean; status: number; text: string; url: string }> {
  try { const r = await http(url, o); return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : "", url: r.url }; }
  catch (e) { return { ok: false, status: e instanceof RobotsDisallowed ? ROBOTS_STATUS : 0, text: "", url }; }
}
