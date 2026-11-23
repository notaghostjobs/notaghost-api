// Finds which employers have a public job board on each hiring system, without crawling anyone: it reads Common Crawl,
// a free public archive of web addresses, for the addresses it holds under each system's job-board host, and keeps the
// employer part of each. It reads the archive's index files directly (the archive's query server is often too busy to answer).
// Writes us-reader/out/boards.json.
import { getJson, UA } from "./lib.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const HOSTS = [["greenhouse", "boards.greenhouse.io"], ["greenhouse", "job-boards.greenhouse.io"], ["lever", "jobs.lever.co"], ["ashby", "jobs.ashbyhq.com"]];
const NOT_A_BOARD = new Set(["embed", "js", "assets", "favicon.ico", "robots.txt", "sitemap.xml", "api", "static", "_next", "images", "fonts", "css", "careers", "jobs", "job", "apply", "login", "signup", "undefined", "null", "www"]);
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? 400);   // per host; each block holds about 3,000 addresses
const slug = (u) => { try { const p = new URL(u.startsWith("http") ? u : "https://" + u); const q = p.searchParams.get("for"); const s = (q || p.pathname.split("/").filter(Boolean)[0] || "").trim(); return /^[A-Za-z0-9][A-Za-z0-9._-]{1,60}$/.test(s) && !NOT_A_BOARD.has(s.toLowerCase()) ? s : null; } catch { return null; } };
const surt = (host) => host.split(".").reverse().join(",") + ")/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const info = await getJson("https://index.commoncrawl.org/collinfo.json", { gapMs: 1500, timeoutMs: 40000 });
const idx = (info.data ?? [])[0];
const out = { archive: idx?.id ?? null, at: new Date().toISOString(), greenhouse: new Set(), lever: new Set(), ashby: new Set(), blocks: {}, notes: [] };
// "OpenAI" and "openai" are one board: one entry per name whatever its capitals, the all-lower-case form when there is one
const one = (set) => { const m = new Map(); for (const v of [...set].sort()) { const k = v.toLowerCase(); if (!m.has(k) || v === k) m.set(k, v); } return [...m.values()].sort(); };
const done = () => {
  mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
  const json = { archive: out.archive, at: out.at, blocks: out.blocks, notes: out.notes, counts: { greenhouse: out.greenhouse.size, lever: out.lever.size, ashby: out.ashby.size }, greenhouse: one(out.greenhouse), lever: one(out.lever), ashby: one(out.ashby) };
  json.counts = { greenhouse: json.greenhouse.length, lever: json.lever.length, ashby: json.ashby.length };
  writeFileSync(new URL("./out/boards.json", import.meta.url), JSON.stringify(json));
  console.log("boards found", json.counts);
};
if (!idx) { out.notes.push({ step: "collinfo", status: info.status, error: info.error ?? null }); done(); process.exit(0); }
const base = `https://data.commoncrawl.org/cc-index/collections/${idx.id}/indexes/`;

// 1. one pass over the index of the index: which blocks hold each host's addresses
const want = HOSTS.map(([system, host]) => ({ system, host, key: surt(host), blocks: [], prev: null, seen: false }));
const r = await fetch(base + "cluster.idx", { headers: { "user-agent": UA } });
if (!r.ok || !r.body) { out.notes.push({ step: "cluster.idx", status: r.status }); done(); process.exit(0); }
let tail = "", prevLine = null, lines = 0;
const dec = new TextDecoder();
const take = (line) => { lines++;
  const k = line.slice(0, line.indexOf(" "));
  for (const w of want) { if (k.startsWith(w.key)) { if (!w.seen && prevLine) w.blocks.push(prevLine); w.seen = true; w.blocks.push(line); } else if (!w.seen && k < w.key) w.prev = line; }
  // the block that begins just before a host's first address may hold its first few
  prevLine = line; };
for await (const chunk of r.body) { const text = tail + dec.decode(chunk, { stream: true }); const parts = text.split("\n"); tail = parts.pop() ?? ""; for (const l of parts) if (l) take(l); }
if (tail) take(tail);
for (const w of want) if (!w.seen && w.prev) w.blocks.push(w.prev);   // a small host can sit wholly inside one block
out.notes.push({ step: "cluster.idx", lines });

// 2. read those blocks and keep the employer part of each address
for (const w of want) {
  out.blocks[w.host] = w.blocks.length; let read = 0;
  for (const line of w.blocks.slice(0, MAX_BLOCKS)) {
    const [, file, offset, length] = line.split("\t");
    try {
      const b = await fetch(base + file, { headers: { "user-agent": UA, range: `bytes=${offset}-${Number(offset) + Number(length) - 1}` }, signal: AbortSignal.timeout(60000) });
      if (b.status !== 206 && b.status !== 200) { out.notes.push({ host: w.host, step: "block", status: b.status }); await sleep(1000); continue; }
      const text = gunzipSync(Buffer.from(await b.arrayBuffer())).toString("utf8");
      for (const l of text.split("\n")) { if (!l.startsWith(w.key)) continue; const j = l.indexOf("{"); if (j < 0) continue; try { const s = slug(JSON.parse(l.slice(j)).url); if (s) out[w.system].add(s); } catch { /* a broken line */ } }
      read++;
    } catch (e) { out.notes.push({ host: w.host, step: "block", error: String(e?.message ?? e).slice(0, 80) }); }
    await sleep(150);
  }
  console.log(w.host, "blocks", w.blocks.length, "read", read, "boards so far", out[w.system].size);
}
done();
