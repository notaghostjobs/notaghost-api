// Finds which employers have a public job board on each hiring system, without crawling anyone: it asks Common Crawl,
// a free public archive of web addresses, for the addresses it holds under each system's job-board host, and keeps the
// employer part of each. Writes us-reader/out/boards.json.
import { get, getJson } from "./lib.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const HOSTS = [["greenhouse", "boards.greenhouse.io"], ["greenhouse", "job-boards.greenhouse.io"], ["lever", "jobs.lever.co"], ["ashby", "jobs.ashbyhq.com"]];
const NOT_A_BOARD = new Set(["embed", "js", "assets", "favicon.ico", "robots.txt", "sitemap.xml", "api", "static", "_next", "images", "fonts", "css", "careers", "jobs", "job", "apply", "login", "signup", "undefined", "null", "www"]);
const MAX_PAGES = Number(process.env.MAX_PAGES ?? 5);
const slug = (u) => { try { const p = new URL(u.startsWith("http") ? u : "https://" + u); const q = p.searchParams.get("for"); const s = (q || p.pathname.split("/").filter(Boolean)[0] || "").trim(); return /^[A-Za-z0-9][A-Za-z0-9._-]{1,60}$/.test(s) && !NOT_A_BOARD.has(s.toLowerCase()) ? s : null; } catch { return null; } };

const info = await getJson("https://index.commoncrawl.org/collinfo.json", { gapMs: 1500, timeoutMs: 40000 });
const idx = (info.data ?? [])[0];
if (!idx) { console.log("Common Crawl did not answer:", info.status, info.error ?? ""); process.exit(2); }
const cdx = idx["cdx-api"]; console.log("archive", idx.id);
const out = { archive: idx.id, at: new Date().toISOString(), greenhouse: new Set(), lever: new Set(), ashby: new Set(), pages: {} };
for (const [system, host] of HOSTS) {
  const q = `${cdx}?url=${encodeURIComponent(host + "/*")}&output=json&fl=url`;
  const n = await getJson(q + "&showNumPages=true", { gapMs: 1500, timeoutMs: 40000 });
  const pages = Number(n.data?.pages ?? 0); out.pages[host] = pages;
  console.log(host, "pages in archive:", pages, "status", n.status);
  for (let p = 0; p < Math.min(pages, MAX_PAGES); p++) {
    const r = await get(`${q}&page=${p}`, { gapMs: 1500, timeoutMs: 60000 });
    if (r.status !== 200) { console.log("  page", p, "status", r.status); continue; }
    for (const line of r.text.split("\n")) { if (!line) continue; try { const s = slug(JSON.parse(line).url); if (s) out[system].add(s); } catch { /* a broken line */ } }
    console.log("  page", p, "boards so far:", out[system].size);
  }
}
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
const json = { archive: out.archive, at: out.at, pages: out.pages, counts: { greenhouse: out.greenhouse.size, lever: out.lever.size, ashby: out.ashby.size }, greenhouse: [...out.greenhouse].sort(), lever: [...out.lever].sort(), ashby: [...out.ashby].sort() };
writeFileSync(new URL("./out/boards.json", import.meta.url), JSON.stringify(json));
console.log("boards found", json.counts);
