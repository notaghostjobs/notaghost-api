// One polite HTTP client for every reader: real browser UA, timeout, per-host spacing, backoff on 429/5xx.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const lastHit = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HttpOpts { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; gapMs?: number; retries?: number }

/** Fetch with spacing per host (default 400ms) and up to `retries` backoffs on 429/503. Throws on final failure. */
export async function http(url: string, o: HttpOpts = {}): Promise<Response> {
  const host = new URL(url).host;
  const gap = o.gapMs ?? 400;
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
  } catch { return { ok: false, status: 0, data: null }; }
}

export async function getText(url: string, o: HttpOpts = {}): Promise<{ ok: boolean; status: number; text: string; url: string }> {
  try { const r = await http(url, o); return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : "", url: r.url }; }
  catch { return { ok: false, status: 0, text: "", url }; }
}
