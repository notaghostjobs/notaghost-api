// A company's own name and mark, taken from its own website (20 Nov).
// On Open, a hiring manager proves a work email on the company's domain. From that domain alone we read what the company
// calls itself and the icon it publishes for phones and browser tabs, so nobody is asked to type a website or upload a
// file. The rule for the mark is "the right one or none": a clean, square image of real size, or nothing at all.
// We never take a mark for a company whose employee has not come to us, and never from a logo database.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { db } from "./db.js";
import { UA, robotsAllows } from "../reader/http.js";

export type Brand = { domain: string; name: string; source: "confirmed" | "known" | "site" | "domain"; logo: string | null; at: string; confirmed?: boolean };
type Img = { mime: "image/png" | "image/jpeg"; buf: Buffer; w: number; h: number };

const now = () => new Date().toISOString();
const KEY = (d: string) => `open:brand:${d}`, LOGO = (d: string) => `open:logo:${d}`;
const MIN_SIDE = 96, MAX_BYTES = 400 * 1024, HTML_MAX = 600 * 1024, BUDGET_MS = 9000;

// ---- the network, swappable so the tests never leave the machine ----
type Net = { fetch: typeof fetch; lookup: (host: string) => Promise<string[]>; robots: (url: string) => Promise<boolean> };
const real: Net = { fetch: (...a) => fetch(...a), lookup: async (h) => (await dnsLookup(h, { all: true })).map((x) => x.address), robots: robotsAllows };
let net: Net = real;
export const __setNet = (n: Partial<Net> | null) => { net = n ? { ...real, ...n } : real; };

/** an address we must never fetch on someone's say-so: this machine, a private network, a cloud's own metadata */
function privateAddr(a: string): boolean {
  const v = isIP(a);
  if (v === 4) { const [p, q] = a.split(".").map(Number) as [number, number]; return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224; }
  if (v === 6) { const x = a.toLowerCase(); if (x.startsWith("::ffff:")) return privateAddr(x.slice(7)); return x === "::1" || x === "::" || /^f[cd]/.test(x) || /^fe[89ab]/.test(x); }
  return true;
}
async function safeHost(host: string): Promise<boolean> {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) || isIP(host) || !/[a-z]/i.test(host.split(".").pop() ?? "")) return false;
  try { const as = await net.lookup(host); return as.length > 0 && as.every((a) => !privateAddr(a)); } catch { return false; }
}
/** One polite GET: says who we are, honours robots.txt, follows a few redirects checking each host, and stops at a size. */
async function get(url: string, accept: string, max: number, until: number): Promise<{ buf: Buffer; type: string; url: string } | null> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    let u: URL; try { u = new URL(at); } catch { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.port && u.port !== "443" && u.port !== "80") return null;
    if (!(await safeHost(u.hostname))) return null;
    if (!(await net.robots(at).catch(() => true))) return null;
    const left = until - Date.now(); if (left < 300) return null;
    let r: Response;
    try { r = await net.fetch(at, { headers: { "user-agent": UA, accept, "accept-language": "en-IN,en;q=0.9" }, redirect: "manual", signal: AbortSignal.timeout(Math.min(left, 6000)) }); } catch { return null; }
    if (r.status >= 300 && r.status < 400) { const to = r.headers.get("location"); if (!to) return null; try { at = new URL(to, at).toString(); } catch { return null; } continue; }
    if (!r.ok) return null;
    if (Number(r.headers.get("content-length") ?? 0) > max) return null;
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > max || buf.length === 0) return null;
    return { buf, type: (r.headers.get("content-type") ?? "").toLowerCase(), url: at };
  }
  return null;
}

// ---- reading an image's real size from its own bytes ----
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function sizeOf(b: Buffer): Img | null {
  if (b.length > 24 && b.subarray(0, 8).equals(PNG)) return { mime: "image/png", buf: b, w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!; if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: "image/jpeg", buf: b, w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  // an .ico is a small folder of images; a modern one keeps its large size as a PNG, which we can lift out whole
  if (b.length > 22 && b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1) {
    const n = Math.min(b.readUInt16LE(4), 20); let best: Img | null = null;
    for (let k = 0; k < n; k++) {
      const e = 6 + k * 16; if (e + 16 > b.length) break;
      const len = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12); if (off + len > b.length || len < 24) continue;
      const part = b.subarray(off, off + len); if (!part.subarray(0, 8).equals(PNG)) continue;
      const im = sizeOf(Buffer.from(part)); if (im && (!best || im.w > best.w)) best = im;
    }
    return best;
  }
  return null;
}
/** "the right one or none": a real PNG or JPEG, at least 96px a side, close to square, and not heavy */
export function goodMark(b: Buffer): Img | null {
  const im = sizeOf(b); if (!im) return null;
  if (im.buf.length > MAX_BYTES || im.w < MIN_SIDE || im.h < MIN_SIDE || im.w > 2048 || im.h > 2048) return null;
  const k = im.w / im.h; if (k < 0.8 || k > 1.25) return null;
  return im;
}

// ---- reading the page ----
const ent = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;|&rsquo;/g, "’").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, " ").trim();
const attr = (tag: string, name: string) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag); return m ? ent(m[2] ?? m[3] ?? m[4] ?? "") : ""; };
export const normName = (s: string) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/&/g, " and ").replace(/\b(pvt|private|ltd|limited|inc|llc|llp|plc|corp|corporation|company|co|india|technologies|technology|solutions|group|the)\b\.?/g, " ").replace(/[^a-z0-9]+/g, "");
/** the same company said two ways: "Amazon" and "Amazon India", "Ninjacart" and "NinjaCart Pvt Ltd" */
export const sameName = (a: string, b: string) => { const x = normName(a), y = normName(b); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x)))); };
const label = (domain: string) => domain.split(".")[0] ?? domain;
const cap = (s: string) => s.replace(/(^|[-\s])([a-z])/g, (_, a, c) => (a === "-" ? " " : a) + c.toUpperCase());
function tidyName(raw: string, domain: string): string {
  let s = ent(raw).replace(/^(welcome to|home\s*[|:–-])\s*/i, "").trim();
  if (s.length < 2 || s.length > 48 || /https?:|[<>{}]/.test(s)) return "";
  // "Amazon.com" is a web address standing in for a name
  if (s.toLowerCase().replace(/^www\./, "") === domain || /^[a-z0-9-]+\.(com|in|co|io|ai|net|org|co\.in)$/i.test(s)) s = cap(s.replace(/^www\./i, "").split(".")[0]!);
  return s;
}
export function readPage(html: string, domain: string, base: string): { name: string; icons: string[] } {
  const head = html.slice(0, 200_000);
  const metas = head.match(/<meta\b[^>]*>/gi) ?? [], links = head.match(/<link\b[^>]*>/gi) ?? [];
  const meta = (k: string) => { for (const t of metas) if ((attr(t, "property") || attr(t, "name")).toLowerCase() === k) { const v = attr(t, "content"); if (v) return v; } return ""; };
  const lab = normName(label(domain));
  let name = "";
  for (const c of [meta("og:site_name"), meta("application-name"), meta("apple-mobile-web-app-title")]) { const t = tidyName(c, domain); if (t) { name = t; break; } }
  if (!name) {
    // a page title is usually "Brand | what we do": keep the part that is the brand, told by the domain
    const title = ent((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? ""));
    for (const part of title.split(/\s+[|–—·•:-]\s+|\s*[|•]\s*/)) { const t = tidyName(part, domain); const n = normName(t); if (t && n && lab && (n.includes(lab) || lab.includes(n)) && n.length >= 3) { name = t; break; } }
  }
  const abs = (h: string) => { try { return new URL(h, base).toString(); } catch { return ""; } };
  const scored: { url: string; s: number }[] = [];
  for (const t of links) {
    const rel = attr(t, "rel").toLowerCase(), href = attr(t, "href"); if (!href || /^data:/i.test(href) || /\.svg(\?|$)/i.test(href)) continue;
    const side = Math.max(0, ...(attr(t, "sizes").match(/\d+/g) ?? []).map(Number));
    if (/apple-touch-icon/.test(rel)) scored.push({ url: abs(href), s: 1000 + (side || 180) });
    else if (/\bicon\b/.test(rel) && !/mask/.test(rel)) scored.push({ url: abs(href), s: side >= MIN_SIDE ? 500 + side : /\.png(\?|$)/i.test(href) ? 100 : 10 });
  }
  const origin = (() => { try { return new URL(base).origin; } catch { return `https://${domain}`; } })();
  scored.push({ url: `${origin}/apple-touch-icon.png`, s: 90 }, { url: `${origin}/favicon.ico`, s: 5 });
  const icons = [...new Set(scored.filter((x) => x.url).sort((a, b) => b.s - a.s).map((x) => x.url))].slice(0, 6);
  return { name, icons };
}

const store = {
  async get<T>(key: string): Promise<T | null> { const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; },
  async set(key: string, value: unknown) { await db.from("reader_control").upsert({ key, value, updated_at: now() }, { onConflict: "key" }); },
};
const hostOf = (s: string) => String(s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0] ?? "";
const baseOf = (d: string) => { const p = d.split("."); const two = /^(co|com|org|net|ac|gov|edu)$/.test(p[p.length - 2] ?? "") && (p[p.length - 1] ?? "").length === 2; return p.slice(two ? -3 : -2).join("."); };

/** an employer we already follow, by its own website's domain */
export async function knownByDomain(domain: string): Promise<string | null> {
  const { data } = await db.from("employers").select("name,website").ilike("website", `%${domain}%`).limit(8);
  const hit = (data ?? []).filter((r: any) => baseOf(hostOf(r.website)) === domain && String(r.name ?? "").trim().length >= 2).sort((a: any, b: any) => String(a.name).length - String(b.name).length)[0];
  return hit ? String(hit.name).trim() : null;
}
/** an employer we already follow, or one already on Open, that carries this name on a different domain */
export async function nameTakenElsewhere(name: string, domain: string): Promise<string | null> {
  const n = normName(name); if (n.length < 3) return null;
  const first = name.trim().split(/\s+/)[0]!.replace(/[%_,()]/g, "").slice(0, 30); if (first.length < 2) return null;
  const { data } = await db.from("employers").select("name,website").ilike("name", `%${first}%`).limit(60);
  for (const r of data ?? []) { const d = baseOf(hostOf((r as any).website)); if (normName((r as any).name) === n && d && d !== domain) return d; }
  const { data: bs } = await db.from("reader_control").select("value").like("key", "open:brand:%").limit(500);
  for (const r of bs ?? []) { const b = r.value as Brand; if (b?.domain && b.domain !== domain && normName(b.name) === n && (b.confirmed || b.source !== "domain")) return b.domain; }
  return null;
}

const busy = new Map<string, Promise<Brand>>();
/** The company at this domain: what it calls itself, and its mark if it publishes a good one. Kept once per company. */
export async function brandOf(domain: string, opts: { fresh?: boolean } = {}): Promise<Brand> {
  const had = await store.get<Brand>(KEY(domain));
  const age = had ? Date.now() - Date.parse(had.at) : Infinity;
  if (had && !opts.fresh && (had.confirmed || age < (had.logo ? 30 : 1) * 86400e3)) return had;
  const going = busy.get(domain); if (going) return going;
  const p = (async (): Promise<Brand> => {
    const until = Date.now() + BUDGET_MS;
    let site = "", icons: string[] = [];
    for (const start of [`https://${domain}/`, `https://www.${domain}/`]) {
      const page = await get(start, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", HTML_MAX, until);
      if (!page) continue;
      const r = readPage(page.buf.toString("utf8"), domain, page.url); site = r.name; icons = r.icons; break;
    }
    if (!icons.length) icons = [`https://${domain}/apple-touch-icon.png`, `https://www.${domain}/apple-touch-icon.png`];
    let mark: Img | null = null;
    for (const u of icons) { if (Date.now() > until - 500) break; const f = await get(u, "image/png,image/jpeg,image/*;q=0.8", MAX_BYTES * 2, until); if (!f) continue; mark = goodMark(f.buf); if (mark) break; }
    const known = await knownByDomain(domain).catch(() => null);
    const b: Brand = had?.confirmed
      ? { ...had, at: now() }
      : { domain, name: known ?? (site || cap(label(domain))), source: known ? "known" : site ? "site" : "domain", logo: null, at: now() };
    if (mark) { b.logo = Date.now().toString(36); await store.set(LOGO(domain), { mime: mark.mime, b64: mark.buf.toString("base64"), at: now(), by: "site", w: mark.w, h: mark.h }); }
    else if (had?.logo) b.logo = had.logo;   // a mark we already hold stays; one bad day on their site does not take it away
    await store.set(KEY(domain), b);
    return b;
  })().finally(() => busy.delete(domain));
  busy.set(domain, p);
  return p;
}
/** once a person has confirmed what a domain is called, it stays that way for the next hiring manager from there */
export async function confirmBrand(domain: string, name: string): Promise<Brand> {
  const had = await store.get<Brand>(KEY(domain));
  const b: Brand = { domain, name, source: "confirmed", logo: had?.logo ?? null, at: now(), confirmed: true };
  await store.set(KEY(domain), b); return b;
}
