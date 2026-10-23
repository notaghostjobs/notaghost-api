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

  const skills = r.skills.length ? `<div class="chips">${r.skills.map((s) => `<span>${esc(s)}</span>`).join("")}</div>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.name)}</title>
<style>
${fontCss}
:root{ --s:1; --ink:#15171a; --mid:#4a4f57; --faint:#7d838c; --accent:#6b5d4a; --rule:#2a2d31; --chip:#f1efeb; }
*{box-sizing:border-box;margin:0;padding:0}
@page{ size:A4; margin:0 }
html,body{ width:210mm; }
body{ font-family:Inter,system-ui,sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased;
      font-size:calc(10pt * var(--s)); line-height:1.42; }
.page{ padding:calc(16mm * var(--s)) 17mm calc(14mm * var(--s)); min-height:297mm; }
header .name{ font-size:calc(27pt * var(--s)); font-weight:800; letter-spacing:-0.02em; line-height:1.05; }
header .head{ font-size:calc(11.5pt * var(--s)); color:var(--mid); margin-top:calc(3pt * var(--s)); font-weight:500; }
header .bar{ height:1.6pt; background:var(--accent); margin:calc(8pt * var(--s)) 0 calc(7pt * var(--s)); }
header .contact{ display:flex; flex-wrap:wrap; gap:0 calc(10pt * var(--s)); font-size:calc(8.8pt * var(--s)); color:var(--mid); }
header .contact span + span::before{ content:"|"; color:#c9ccd1; margin-right:calc(10pt * var(--s)); }
section{ margin-top:calc(13pt * var(--s)); }
h2{ font-size:calc(9.6pt * var(--s)); font-weight:700; letter-spacing:0.12em; text-transform:uppercase;
    padding-bottom:calc(3pt * var(--s)); border-bottom:0.9pt solid var(--rule); margin-bottom:calc(7pt * var(--s)); }
p.sum{ color:var(--ink); }
.role + .role{ margin-top:calc(9pt * var(--s)); }
.role-h{ display:flex; justify-content:space-between; align-items:baseline; gap:12pt; }
.role-h .t{ font-weight:700; font-size:calc(11pt * var(--s)); letter-spacing:-0.005em; }
.role-h .c{ color:var(--accent); font-weight:500; font-size:calc(9.6pt * var(--s)); margin-top:1pt; }
.role-h .d{ color:var(--faint); font-size:calc(9pt * var(--s)); white-space:nowrap; font-variant-numeric:tabular-nums; }
ul{ list-style:none; margin-top:calc(4pt * var(--s)); }
li{ position:relative; padding-left:calc(11pt * var(--s)); margin-top:calc(2.2pt * var(--s)); }
li::before{ content:""; position:absolute; left:2pt; top:calc(0.58em - 1.2pt); width:3.2pt; height:3.2pt; border-radius:50%; background:var(--accent); }
.chips{ display:flex; flex-wrap:wrap; gap:calc(5pt * var(--s)) calc(6pt * var(--s)); }
.chips span{ background:var(--chip); padding:calc(3pt * var(--s)) calc(8pt * var(--s)); border-radius:3pt; font-size:calc(9.2pt * var(--s)); font-weight:500; color:var(--ink); }
</style></head><body><div class="page">
<header>
  <div class="name">${esc(o.name)}</div>
  <div class="head">${esc(r.headline)}</div>
  <div class="bar"></div>
  <div class="contact">${contact.map((c) => `<span>${esc(c!)}</span>`).join("")}</div>
</header>
${sec("Profile", `<p class="sum">${esc(r.summary)}</p>`)}
${sec("Experience", roles)}
${r.education.length ? sec("Education", edu) : ""}
${r.skills.length ? sec("Skills", skills) : ""}
</div></body></html>`;
}

/**
 * HTML → PDF. Auto-fits: scales type/spacing (CSS --s) so content fills exactly
 * `pages` A4 pages (default: same as the original résumé).
 */
export async function resumePdf(r: Rewrite, o: ResumeProfile): Promise<Buffer> {
  return htmlToPdf(resumeHtml(r, o), Math.max(1, o.pages || 1));
}

export async function htmlToPdf(html: string, pages = 1): Promise<Buffer> {
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    // passed as a string: tsx/esbuild inject helpers into function bodies that don't exist in the page
    await page.evaluate(`(() => {
      const target = 1122.5 * ${pages};            // 297mm in CSS px, times pages
      const pg = document.querySelector(".page"); pg.style.minHeight = "0";
      const h = () => pg.getBoundingClientRect().height;
      const set = (s) => document.documentElement.style.setProperty("--s", String(s));
      let lo = 0.8, hi = 1.75;
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; set(mid); if (h() <= target) lo = mid; else hi = mid; }
      set(lo);
      const slack = target - h();
      const secs = document.querySelectorAll("section");
      if (slack > 0 && secs.length) {
        const per = Math.min(slack / secs.length, 28);
        secs.forEach((s) => { s.style.marginTop = "calc(" + getComputedStyle(s).marginTop + " + " + per + "px)"; });
      }
      pg.style.minHeight = "0"; pg.style.height = target + "px";
    })()`);
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
