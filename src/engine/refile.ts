// Two deterministic guards that need no model.
//
// 1. refileBullets — the parsed profile is checked against the raw résumé text. A model parse can file a role's bullets under
//    the neighbouring employer (seen 6 Nov: four Unacademy lines parsed under Fashinza, so the fact guard protected the wrong
//    thing). Each role's header is located in the text; every bullet is located too; a bullet that sits in another role's
//    stretch of the text is moved to that role, in text order. Lines in a role's stretch that no bullet covers are added back
//    verbatim. Nothing is reworded.
//
// 2. placeTold — a questionnaire line (what the candidate told us) may sit inside a role ONLY when the line itself names that
//    employer ("… at Ninjacart"). A line that names no employer is the candidate's claim, not that employer's: it lives in the
//    relevant block (or an "Also" block), never under a company it does not mention.

import type { ResumeProfile, Rewrite } from "./sharpen.js";

const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const words = (t: string) => norm(t).split(" ").filter(Boolean);

/** Position of the first run of `n` words of `needle` inside the normalised `hay`, searching from `from`; -1 if absent. */
function locate(hay: string, needle: string, from = 0, n = 8): number {
  const w = words(needle); if (!w.length) return -1;
  for (const k of [Math.min(n, w.length), 6, 5, 4]) {
    if (k > w.length || k < 4) continue;
    const i = hay.indexOf(" " + w.slice(0, k).join(" ") + " ", from);
    if (i >= 0) return i;
  }
  return -1;
}

export function refileBullets(profile: ResumeProfile, text: string): { profile: ResumeProfile; log: string[] } {
  const log: string[] = [];
  if ((profile as any).layout_warning && /two columns|sidebar/i.test(String((profile as any).layout_warning))) return { profile, log: ["refile skipped: multi-column layout"] };
  const roles = profile.roles ?? [];
  if (roles.length < 2 || !text) return { profile, log };
  const hay = " " + norm(text) + " ";
  // header position of each role: title then company (or company then title) in reading order, after the previous header
  const heads: number[] = []; let from = 0;
  for (const r of roles) {
    const a = locate(hay, r.title || "", from, 4), b = locate(hay, r.company || "", from, 4);
    let pos = -1;
    if (a >= 0 && b >= 0) pos = Math.min(a, b); else pos = Math.max(a, b);
    if (pos < 0 && r.company) { const i = hay.indexOf(" " + words(r.company).slice(0, 2).join(" ") + " ", from); pos = i; }
    if (pos < 0) return { profile, log: ["refile skipped: header not found for " + r.company] };   // layout we don't understand: leave the parse alone
    heads.push(pos); from = pos + 1;
  }
  // text order must match role order, or the headers were mis-located
  for (let i = 1; i < heads.length; i++) if (heads[i] <= heads[i - 1]) return { profile, log: ["refile skipped: headers out of order"] };
  const segOf = (pos: number) => { let s = 0; for (let i = 0; i < heads.length; i++) if (pos >= heads[i]) s = i; return s; };
  const next: ResumeProfile = JSON.parse(JSON.stringify(profile));
  const moved: { to: number; pos: number; b: string }[] = [];
  next.roles.forEach((r, i) => {
    const keep: string[] = [];
    for (const b of r.bullets ?? []) {
      const pos = locate(hay, b, heads[0]);
      if (pos < 0) { keep.push(b); continue; }
      const s = segOf(pos);
      if (s === i) keep.push(b); else { moved.push({ to: s, pos, b }); log.push(`bullet refiled: ${r.company} → ${roles[s].company}: ${b.slice(0, 60)}`); }
    }
    r.bullets = keep;
  });
  for (const m of moved.sort((x, y) => x.pos - y.pos)) next.roles[m.to].bullets.push(m.b);
  // a bullet's own role lost it entirely? lines in the stretch that nothing covers come back verbatim (from the raw text)
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const all = " " + norm(JSON.stringify(next)) + " ";
  // a section heading ("VENTURES", "E X P E R T I S E", "SKILLS & TOOLS"): no lowercase, short; the experience block ends at the first one after the last role
  const isHeading = (l: string) => { const t = l.replace(/\s+/g, ""); return t.length >= 3 && t.length <= 30 && /^[A-Z][A-Z&\/]*$/.test(t); };
  const dated = (l: string) => /(?:(?:19|20)\d\d|['’]\d\d)\s*(?:[–-]|to)\s*(?:[A-Za-z]{3,9}\.?\s*)?['’]?(?:(?:19|20)\d\d|\d\d\b|present)/i.test(l);
  let expEnd = Infinity;
  for (const l of lines) { const p = locate(hay, l, 0, 4); if (p > heads[heads.length - 1] && isHeading(l)) { expEnd = p; break; } }
  if (expEnd === Infinity) { for (const l of lines) { if (!isHeading(l)) continue; const p = " " + norm(l.replace(/\s+/g, "")) + " "; const i = hay.indexOf(p); if (i > heads[heads.length - 1]) { expEnd = i; break; } } }
  // résumés that mark bullets with a glyph: only glyph lines can be recovered (a company blurb or a sub-heading is not a bullet)
  const GLYPH = /^[•●▪◦‣■□➢➤►▶\-–—*·]\s*/;
  const glyphs = lines.filter((l) => GLYPH.test(l)).length >= 3;
  next.roles.forEach((r, i) => {
    const start = heads[i], end = i + 1 < heads.length ? heads[i + 1] : expEnd;
    // join wrapped lines into sentences: a line that ends without a full stop continues on the next; a glyph starts a new one
    const sents: { text: string; glyph: boolean }[] = []; let cur = ""; let curGlyph = false;
    const flush = () => { if (cur) sents.push({ text: cur, glyph: curGlyph }); cur = ""; curGlyph = false; };
    for (const l of lines) {
      if (isHeading(l) || dated(l) || /^-- \d+ of \d+ --$/.test(l)) { flush(); continue; }
      const p = locate(hay, l, 0, 4); if (p < start || p >= end) { flush(); continue; }
      const g = GLYPH.test(l); if (g) flush();
      cur = cur ? cur + " " + l.replace(GLYPH, "") : l.replace(GLYPH, ""); curGlyph = curGlyph || g;
      if (/[.!?]$/.test(l)) flush();
    }
    flush();
    const found: string[] = [];
    for (const { text: s, glyph } of sents) {
      if (glyphs && !glyph) continue;
      const w = words(s); if (w.length < 7) continue;                                   // headers, one-word lines
      if (norm(s).includes(norm(r.company)) && w.length < 10) continue;                  // the company line itself
      if (norm(s).includes(norm(r.title))) continue;                                      // the title line
      if (all.includes(" " + w.slice(0, 6).join(" ") + " ")) continue;                   // already somewhere in the parse
      if (/@|\bemail\b|\bmobile\b|\bphone\b/i.test(s)) continue;                        // contact lines of a jumbled layout
      found.push(s.replace(/\s+/g, " "));
    }
    // more than a handful of uncovered sentences means the text is not laid out the way we read it (columns, sidebars):
    // then nothing is recovered, because we cannot tell whose lines they are
    if (found.length > 5) { log.push(`recovery skipped for ${r.company}: ${found.length} uncovered lines (layout)`); return; }
    for (const s of found) { r.bullets.push(s); log.push(`bullet recovered: ${r.company}: ${s.slice(0, 60)}`); }
  });
  return { profile: next, log };
}

export function placeTold(rw: Rewrite, told: { line?: string; fact?: string }[], resume: ResumeProfile): { rewrite: Rewrite; log: string[] } {
  const log: string[] = [];
  const lines = told.map((t) => (t.line ?? "").trim()).filter((l) => l.length > 8);
  if (!lines.length) return { rewrite: rw, log };
  const next: Rewrite = JSON.parse(JSON.stringify(rw));
  const companies = (resume.roles ?? []).map((r) => norm(r.company)).filter(Boolean);
  const named = (line: string) => companies.filter((c) => norm(line).includes(c) || norm(line).includes(c.split(" ")[0]) && c.split(" ")[0].length > 4);
  for (const line of lines) {
    const core = " " + words(line).slice(0, 6).join(" ") + " ";
    const allowed = named(line);
    let present = (next.relevant ?? []).some((x) => (" " + norm(x) + " ").includes(core));
    for (const r of next.roles) {
      const before = r.bullets.length;
      const ok = allowed.some((c) => norm(r.company).includes(c) || c.includes(norm(r.company)));
      if (ok) { if (r.bullets.some((b) => (" " + norm(b) + " ").includes(core))) present = true; continue; }
      r.bullets = r.bullets.filter((b) => !(" " + norm(b) + " ").includes(core));
      if (r.bullets.length !== before) log.push(`told line pulled out of ${r.company}: ${line.slice(0, 60)}`);
    }
    for (const sec of next.extra_sections ?? []) if (sec.items.some((x) => (" " + norm(x) + " ").includes(core))) present = true;
    if (present) continue;
    if ((next.relevant ?? []).length < 5) { next.relevant = [...(next.relevant ?? []), line]; log.push(`told line placed in relevant: ${line.slice(0, 60)}`); }
    else {
      let sec = (next.extra_sections ?? []).find((x) => norm(x.title) === "also");
      if (!sec) { sec = { title: "Also", items: [] }; next.extra_sections = [sec, ...(next.extra_sections ?? [])]; }
      sec.items.push(line); log.push(`told line placed in Also: ${line.slice(0, 60)}`);
    }
  }
  next.extra_sections = (next.extra_sections ?? []).filter((x) => x.items.length);
  return { rewrite: next, log };
}
