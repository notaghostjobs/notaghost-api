import { PDFDocument } from "pdf-lib";
/** Every document we make says so in its metadata, so an upload of one is recognised and refused as a source:
 *  a Ghosted document is never the "original" another document is checked against. */
export const GHOSTED_MARK = "Ghosted · notaghost.jobs · sharpened document";
async function stamp(pdf: Buffer, name: string): Promise<Buffer> {
  try {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    doc.setTitle(name); doc.setProducer(GHOSTED_MARK); doc.setCreator(GHOSTED_MARK); doc.setKeywords(["ghosted-sharpened"]); doc.setSubject("Résumé sharpened with Ghosted (notaghost.jobs)");
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  } catch { return pdf; }
}
import { chromium, type Browser } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Rewrite, ResumeProfile } from "./sharpen.js";

const require = createRequire(import.meta.url);

// ---------- fonts (Inter, embedded as data URIs so the PDF is self-contained) ----------
const fontCss = (() => {
  const dir = require.resolve("@fontsource/inter/package.json").replace(/package\.json$/, "files/");
  return [400, 500, 600, 700, 800]
    .map((w) => {
      const b64 = readFileSync(`${dir}inter-latin-${w}-normal.woff2`).toString("base64");
      return `@font-face{font-family:Inter;font-weight:${w};font-style:normal;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
    })
    .join("\n");
})();

// ---------- browser (one per process) ----------
let browserP: Promise<Browser> | null = null;
function browser() {
  if (!browserP) {
    const candidates = [process.env.CHROMIUM_PATH, "/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean) as string[];
    const executablePath = candidates.find((p) => existsSync(p)); // undefined -> playwright default (Docker image)
    browserP = chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  }
  return browserP;
}

// inline SVG icons (currentColor, 1em)
const ICON: Record<string, string> = {
  mail: '<svg viewBox="0 0 24 24"><path d="M3 5h18v14H3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 7l9 6 9-6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M6.6 10.8a15 15 0 006.6 6.6l2.2-2.2a1 1 0 011-.25c1.1.37 2.3.57 3.6.57a1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1z" fill="currentColor"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-7.1 7-12a7 7 0 10-14 0c0 4.9 7 12 7 12z" fill="currentColor"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>',
  in: '<svg viewBox="0 0 24 24"><path d="M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zm3.5 6.5v8h2.6v-8zm1.3-4a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM11.5 9.5v8h2.6v-4.2c0-1.2.5-1.9 1.6-1.9s1.5.7 1.5 1.9v4.2h2.6v-4.9c0-2.4-1.3-3.4-3-3.4-1.3 0-2.2.6-2.7 1.4v-1.1z" fill="currentColor"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.5 1.5M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.5-1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const iconFor = (v: string) => /@/.test(v) ? "mail" : /^\+?\d[\d\s-]{7,}$/.test(v) ? "phone" : /linkedin/i.test(v) ? "in" : /\.[a-z]{2,}(\/|$)/i.test(v) ? "link" : "pin";

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// ---------- template: "Morton" — editorial, left-aligned, rule under headings, skill chips ----------
export function resumeHtml(r: Rewrite, o: ResumeProfile) {
  const contact = [o.contact.email, o.contact.phone, o.contact.city, ...(o.contact.links ?? [])].filter(Boolean);
  const sec = (title: string, body: string) => `<section><h2>${esc(title)}</h2>${body}</section>`;

  const roles = r.roles.map((ro) => `
    <div class="role">
      <div class="role-h"><div><div class="t">${esc(ro.title)}</div><div class="c">${esc(ro.company)}</div></div><div class="d">${esc(ro.start)} – ${esc(ro.end)}</div></div>
      <ul>${ro.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
    </div>`).join("");

  const edu = r.education.map((e) => `
    <div class="role">
      <div class="role-h"><div><div class="t">${esc(e.degree)}</div><div class="c">${esc(e.school)}</div></div>${e.year ? `<div class="d">${esc(e.year)}</div>` : ""}</div>
    </div>`).join("");

  const relevant = r.relevant?.length ? `<ul class="rel">${r.relevant.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const extras = (r.extra_sections ?? []).filter((x) => x.items?.length).map((x) =>
    sec(x.title, `<ul>${x.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`)).join("");
  const groupedSkills = r.skills.length >= 2 && r.skills.filter((s) => /^[^:]{2,40}:\s.+,/.test(s)).length >= Math.ceil(r.skills.length / 2);
  const skills = !r.skills.length ? "" : groupedSkills
    ? `<div class="skgroups">${r.skills.map((s) => { const i = s.indexOf(":"); return i > 0 ? `<div class="skg"><b>${esc(s.slice(0, i).trim())}</b><span>${esc(s.slice(i + 1).trim())}</span></div>` : `<div class="skg"><span>${esc(s)}</span></div>`; }).join("")}</div>`
    : `<div class="chips">${r.skills.map((s) => `<span>${esc(s)}</span>`).join("")}</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.name)}</title>
<style>
${fontCss}
:root{ --s:1; --g:1; --ink:#15171a; --mid:#4a4f57; --faint:#7d838c; --accent:#6b5d4a; --rule:#2a2d31; --chip:#f1efeb; }
*{box-sizing:border-box;margin:0;padding:0}
@page{ size:A4; margin:16mm 0 15mm }
html,body{ width:210mm; }
body{ font-family:Inter,system-ui,sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased;
      font-size:calc(10pt * var(--s)); line-height:calc(1.42 - 0.12 * (1 - var(--g))); }
.page{ padding:0 17mm; }
header .name{ font-size:calc(27pt * var(--s)); font-weight:800; letter-spacing:-0.02em; line-height:1.05; }
header .head{ font-size:calc(11.5pt * var(--s)); color:var(--mid); margin-top:calc(3pt * var(--s)); font-weight:500; }
header .bar{ height:1.6pt; background:var(--accent); margin:calc(8pt * var(--s)) 0 calc(7pt * var(--s)); }
header .contact{ display:flex; flex-wrap:wrap; gap:calc(2pt * var(--s)) calc(14pt * var(--s)); font-size:calc(8.8pt * var(--s)); color:var(--mid); }
header .contact span{ display:inline-flex; align-items:center; gap:calc(4pt * var(--s)); }
header .contact i{ display:inline-flex; width:1.05em; height:1.05em; color:var(--accent); }
header .contact i svg{ width:100%; height:100%; }
section{ margin-top:calc(13pt * var(--s) * var(--g)); }
h2{ break-after:avoid; }
.role-h, li{ break-inside:avoid; }
.role-h{ break-after:avoid; }
.role ul li:first-child{ break-before:avoid; }
h2{ font-size:calc(8.2pt * var(--s)); font-weight:600; letter-spacing:0.14em; text-transform:uppercase; color:var(--mid);
    padding-bottom:calc(3pt * var(--s)); border-bottom:0.9pt solid var(--rule); margin-bottom:calc(7pt * var(--s)); }
p.sum{ color:var(--ink); }
.role + .role{ margin-top:calc(9pt * var(--s) * var(--g)); }
.role-h{ display:flex; justify-content:space-between; align-items:baseline; gap:12pt; }
.role-h .t{ font-weight:700; font-size:calc(11.6pt * var(--s)); letter-spacing:-0.005em; }
.role-h .c{ color:var(--accent); font-weight:500; font-size:calc(9.6pt * var(--s)); margin-top:1pt; }
.role-h .d{ color:var(--faint); font-size:calc(9pt * var(--s)); white-space:nowrap; font-variant-numeric:tabular-nums; }
ul{ list-style:none; margin-top:calc(4pt * var(--s)); }
ul.rel{ margin-top:calc(6pt * var(--s)); }
ul.rel li{ font-weight:500; }
li{ position:relative; padding-left:calc(11pt * var(--s)); margin-top:calc(2.2pt * var(--s) * var(--g)); }
li::before{ content:""; position:absolute; left:2pt; top:calc(0.58em - 1.2pt); width:3.2pt; height:3.2pt; border-radius:50%; background:var(--accent); }
.chips{ display:flex; flex-wrap:wrap; gap:calc(5pt * var(--s)) calc(6pt * var(--s)); }
.chips span{ background:var(--chip); padding:calc(3pt * var(--s)) calc(8pt * var(--s)); border-radius:3pt; font-size:calc(9.2pt * var(--s)); font-weight:500; color:var(--ink); }
.skgroups{ display:grid; gap:calc(3pt * var(--s) * var(--g)); }
.skg{ display:grid; grid-template-columns:calc(118pt * var(--s)) 1fr; gap:calc(10pt * var(--s)); font-size:calc(9.4pt * var(--s)); line-height:1.4; }
.skg b{ font-weight:650; color:var(--ink); } .skg span{ color:var(--mid); }
</style></head><body><div class="page">
<header>
  <div class="name">${esc(o.name === o.name.toUpperCase() ? o.name.toLowerCase().replace(/(^|\s|-)\S/g, (c) => c.toUpperCase()) : o.name)}</div>
  <div class="head">${esc(r.headline)}</div>
  <div class="bar"></div>
  <div class="contact">${contact.map((c) => `<span><i>${ICON[iconFor(c!)]}</i>${esc(c!.replace(/^https?:\/\/(www\.)?/, ""))}</span>`).join("")}</div>
</header>
${sec("Profile", `<p class="sum">${esc(r.summary)}</p>${relevant}`)}
${sec("Experience", roles)}
${r.skills.length ? sec("Skills", skills) : ""}
${extras}
${r.education.length ? sec("Education", edu) : ""}
</div></body></html>`;
}

/**
 * HTML → PDF. Auto-fits: picks the page count so the last page is never a short spill
 * (shrinks into fewer pages when the overflow is small, otherwise fills the extra page),
 * then scales type/spacing (CSS --s) so the pages end near the bottom margin.
 */
/** The document keeps the original's page count and never exceeds two pages (decided 6 Nov). Fitting order: spacing, then
 *  type scale within the range that still looks right, then the summary and relevant block give — experience lines never do. */
export async function resumePdf(r: Rewrite, o: ResumeProfile): Promise<Buffer> {
  const target = Math.min(2, Math.max(1, Number(o.pages) || 1));
  let doc = r;
  let out = await htmlToPdf(resumeHtml(doc, o), { target });
  if (out.pages > target) {
    // still long at the tightest acceptable setting: the summary and the relevant block give way, never a bullet
    const trimmed: Rewrite = { ...doc, relevant: [], summary: firstWords(doc.summary ?? "", 45) };
    const again = await htmlToPdf(resumeHtml(trimmed, o), { target });
    if (again.pages <= out.pages) { doc = trimmed; out = again; }
  }
  if (out.pages > 2) {
    // last resort, never three pages: a tighter floor on type scale
    const last = await htmlToPdf(resumeHtml(doc, o), { target: 2, floor: 0.74 });
    if (last.pages <= out.pages) out = last;
  }
  if (out.pages > 2) console.error("[pdf] still over two pages at the floor", { name: o.name, pages: out.pages });
  return stamp(out.pdf, o.name);
}
function firstWords(t: string, n: number): string {
  const sents = t.split(/(?<=[.!?])\s+/).filter(Boolean); let out = "";
  for (const s of sents) { if ((out + " " + s).trim().split(/\s+/).length > n && out) break; out = (out + " " + s).trim(); }
  return out || t.split(/\s+/).slice(0, n).join(" ");
}

export async function htmlToPdf(html: string, opts: { target?: number; floor?: number } = {}): Promise<{ pdf: Buffer; pages: number }> {
  const TARGET = opts.target ?? 0;          // 0 = natural page count (other documents)
  const FLOOR = opts.floor ?? 0.84;         // smallest type scale that still reads as the same design
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    // passed as a string: tsx/esbuild inject helpers into function bodies that don't exist in the page
    const PAGE = 1122.5 - 117.2;                     // printable height per A4 page in CSS px
    const chosen: number = await page.evaluate(`(() => {
      const PAGE = ${PAGE};
      const pg = document.querySelector(".page");
      const h = () => pg.getBoundingClientRect().height;
      const set = (s) => document.documentElement.style.setProperty("--s", String(s));
      const slackFor = (n) => n > 1 ? 0.94 : 0.985;  // page breaks lose a little height
      const fits = (s, n) => { set(s); return h() <= PAGE * n * slackFor(n); };

      const TARGET = ${TARGET}, FLOOR = ${FLOOR};
      const gap = (g) => document.documentElement.style.setProperty("--g", String(g));
      // 1. How many pages does it naturally need at scale 1?
      gap(1); set(1); const natural = Math.max(1, Math.ceil(h() / (PAGE * 0.985)));
      // 2. If the last page would be mostly empty, try to shrink into one fewer page (down to 0.86).
      let pages = natural;
      const lastFrac = (h() - PAGE * (natural - 1)) / PAGE;
      if (natural > 1 && lastFrac < 0.45 && fits(0.86, natural - 1)) pages = natural - 1;
      // 2b. A target page count (the original's, at most two): spacing gives first, then type scale down to the floor.
      if (TARGET && pages > TARGET) {
        let done = false;
        for (const g of [0.85, 0.7, 0.55]) { gap(g); if (fits(1, TARGET)) { done = true; break; } }
        if (!done) for (const g of [0.7, 0.55]) { gap(g); if (fits(FLOOR, TARGET)) { done = true; break; } }
        if (done) pages = TARGET; else gap(0.55);
      }
      // 3. Largest scale that fits in the chosen page count.
      let lo = Math.min(0.86, FLOOR), hi = 1.6;
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (fits(mid, pages)) lo = mid; else hi = mid; }
      set(lo);
      // 4. Spread remaining slack across section gaps so pages end near the margin.
      const slack = PAGE * pages * slackFor(pages) - h();
      const secs = document.querySelectorAll("section");
      if (slack > 0 && secs.length) {
        const per = Math.min(slack / secs.length, 28);
        secs.forEach((s) => { s.style.marginTop = "calc(" + getComputedStyle(s).marginTop + " + " + per + "px)"; });
      }
      return pages;
    })()`);
    // the measured height ignores page-break gaps; print, count, and tighten until the printed pages match the plan
    const countPages = (b: Uint8Array) => (Buffer.from(b).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    let pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    for (let i = 0; i < 8 && countPages(pdf) > chosen; i++) {
      const ok = await page.evaluate(`(() => { const r = document.documentElement; const s = parseFloat(getComputedStyle(r).getPropertyValue("--s")) || 1; if (s <= ${FLOOR} - 0.02) return false;
        r.style.setProperty("--s", String(s - 0.03)); document.querySelectorAll("section").forEach((x) => { x.style.marginTop = ""; }); return true; })()`);
      if (!ok) break;
      pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    }
    return { pdf: Buffer.from(pdf), pages: countPages(pdf) };
  } finally {
    await page.close();
  }
}
