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

// 3. holdLines — under Experience the candidate's lines rule. For each role, every original bullet that is not the quoted
//    evidence for a checklist requirement is put back exactly as written (the draft's reworded version is replaced); an
//    evidence bullet may stay reworded or split. Bullets come out in the original order; lines the draft added (owed lines,
//    told lines, unpacked lines) follow, in the draft's order. Decided 6 Nov.
const cwords = (t: string) => norm(t).split(" ").filter((w) => w.length > 3);
const trigrams = (t: string) => { const w = cwords(t); const out: string[] = []; for (let i = 0; i + 2 < w.length; i++) out.push(w.slice(i, i + 3).join(" ")); return out; };
const numsOf = (t: string) => [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
function overlapOf(a: string, b: string): number {
  const wa = cwords(a), wb = new Set(cwords(b)); if (!wa.length) return 0;
  return wa.filter((w) => wb.has(w) || wb.has(w.replace(/s$/, "")) || wb.has(w + "s")).length / wa.length;
}
export function holdLines(rw: Rewrite, resume: ResumeProfile, matches: { bucket: string; evidence?: string; told?: boolean; line?: string }[]): { rewrite: Rewrite; log: string[] } {
  const log: string[] = [];
  const next: Rewrite = JSON.parse(JSON.stringify(rw));
  // owed and told lines are promises: never consumed in place of a candidate's verbatim line
  const promised = new Set(matches.filter((m) => m.bucket === "have_not_said" && (m.line ?? "").trim()).map((m) => norm(m.line!)));
  // the original bullets that are quoted evidence for a have_not_said requirement: the only ones a draft may reword
  const quotes = matches.filter((m) => m.bucket === "have_not_said" && !m.told && (m.evidence ?? "").trim()).map((m) => norm(m.evidence!));
  const isEvidence = (b: string) => { const nb = norm(b); return quotes.some((q) => q.length >= 12 && (nb.includes(q) || q.includes(nb) || overlapOf(q, nb) >= 0.7)); };
  const key = (r: { company: string; title: string }) => norm(r.company) + "|" + norm(r.title);
  for (const orig of resume.roles ?? []) {
    const role = next.roles.find((r) => key(r) === key(orig)) ?? next.roles.find((r) => norm(r.company) === norm(orig.company) && norm(r.start) === norm(orig.start)) ?? next.roles.find((r) => norm(r.company) === norm(orig.company));
    if (!role) continue;
    const pool = role.bullets.map((b) => ({ b, used: false }));
    const out: string[] = [];
    for (const ob of orig.bullets) {
      if (!ob.trim()) continue;
      // the draft's lines that stand for this original (same words, or a split of it)
      const mine = pool.filter((p) => !p.used && (norm(p.b) === norm(ob) || overlapOf(ob, p.b) >= 0.5 || overlapOf(p.b, ob) >= 0.6));
      if (isEvidence(ob)) {
        if (!mine.length) { out.push(ob.trim()); continue; }           // reworded away entirely? the original stands
        // a rewording may carry only this bullet's own numbers: a line that pulls numbers in from the role's other bullets
        // ("managed 1,200 SKUs, 40 suppliers and 14 brands at once") is a merge, not a rewording — the original stands instead
        const own = new Set(numsOf(ob));
        const others = new Set((orig.bullets.filter((x) => x !== ob)).flatMap(numsOf));
        // ...and only this role's own wording: a phrase lifted from ANOTHER employer's lines ("pricing, promotions and
        // assortment" from the BigBasket role, written into a Ninjacart line) is a migration, undone the same way
        // ...nor a phrase from any OTHER bullet, this role's or another employer's ("with supply chain on inventory planning"
        // folded into the marketing line is a merge of two of the candidate's lines, not a rewording of one)
        const ownGrams = new Set(trigrams(ob));
        const foreignGrams = new Set((resume.roles ?? []).flatMap((r) => r.bullets.filter((x) => !(r === orig && x === ob)).flatMap(trigrams)).filter((g) => !ownGrams.has(g)));
        let merged = false;
        const kept: string[] = [];
        for (const p of mine) {
          p.used = true;
          const foreign = numsOf(p.b).filter((n) => !own.has(n) && others.has(n) && !/^(19|20)\d\d$/.test(n));
          const lifted = trigrams(p.b).filter((g) => foreignGrams.has(g));
          if ((foreign.length || lifted.length) && norm(p.b) !== norm(ob)) { if (!merged) { kept.push(ob.trim()); merged = true; log.push(`merge undone: ${orig.company}: ${p.b.slice(0, 60)}${lifted.length ? ` (lifted: ${lifted[0]})` : ""}`); } continue; }
          kept.push(p.b);
        }
        // a rewording REPLACES the line it rewords: when the draft kept the verbatim line beside a rewording that carries
        // all of its numbers and most of its words, the verbatim copy goes (a fact lives in one place)
        const copies = kept.filter((k) => norm(k) === norm(ob));
        const reworded = kept.filter((k) => norm(k) !== norm(ob) && numsOf(ob).every((n) => numsOf(k).includes(n)) && overlapOf(ob, k) >= 0.6);
        const final = copies.length && reworded.length ? kept.filter((k) => norm(k) !== norm(ob)) : kept;
        if (final.length !== kept.length) log.push(`verbatim twin dropped beside its rewording: ${orig.company}: ${ob.slice(0, 50)}`);
        for (const k of final) if (!out.some((o) => norm(o) === norm(k))) out.push(k);
        continue;
      }
      // not evidence: the candidate's line, exactly as written, once (a promised line that merely resembles it stays)
      for (const p of mine) if (!promised.has(norm(p.b))) p.used = true;
      if (mine.some((p) => p.used && norm(p.b) !== norm(ob))) log.push(`verbatim restored: ${orig.company}: ${ob.slice(0, 60)}`);
      out.push(ob.trim());
    }
    // what the draft added (owed lines, told lines): after the candidate's own lines, in the draft's order
    for (const p of pool) if (!p.used && !out.some((o) => norm(o) === norm(p.b))) out.push(p.b);
    const before = role.bullets.map(norm).join("|"), after = out.map(norm).join("|");
    if (before !== after && !log.some((l) => l.includes(orig.company))) log.push(`order held: ${orig.company}`);
    role.bullets = out;
  }
  return { rewrite: next, log };
}

// 4. dedupe — a fact lives in one place. A sentence in the summary, the relevant block or an extras block that repeats an
//    experience line (same numbers, most of the same words) is removed; the role line wins. Two role lines that repeat each
//    other keep the first. Decided 6 Nov.
export function dedupe(rw: Rewrite, prefer: string[] = []): { rewrite: Rewrite; log: string[] } {
  const preferred = (b: string) => prefer.some((p) => norm(p) === norm(b));
  const log: string[] = [];
  const next: Rewrite = JSON.parse(JSON.stringify(rw));
  const nums = (t: string) => [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
  const dup = (a: string, b: string) => { const na = nums(a), nb = new Set(nums(b)); if (na.length && na.some((n) => !nb.has(n))) return false; return overlapOf(a, b) >= 0.6 && cwords(a).length >= 4; };
  const roleLines: string[] = [];
  for (const r of next.roles) {
    const keep: string[] = [];
    for (const b of r.bullets) {
      const twin = keep.findIndex((x) => overlapOf(b, x) >= 0.8 && overlapOf(x, b) >= 0.8);
      if (twin >= 0) {
        // two lines saying the same thing in this role: the owed line (the employer's words) wins over the plain one
        if (preferred(b) && !preferred(keep[twin])) { log.push(`repeat dropped in ${r.company}: ${keep[twin].slice(0, 50)}`); keep[twin] = b; }
        else log.push(`repeat dropped in ${r.company}: ${b.slice(0, 50)}`);
        continue;
      }
      if (roleLines.some((x) => overlapOf(b, x) >= 0.8 && overlapOf(x, b) >= 0.8)) { log.push(`repeat dropped in ${r.company}: ${b.slice(0, 50)}`); continue; }
      keep.push(b);
    }
    r.bullets = keep; roleLines.push(...keep);
  }
  const copies = (line: string) => roleLines.some((b) => dup(line, b));
  next.relevant = (next.relevant ?? []).filter((l) => { const d = copies(l); if (d) log.push(`relevant repeat dropped: ${l.slice(0, 50)}`); return !d; });
  next.extra_sections = (next.extra_sections ?? []).map((sec) => ({ ...sec, items: sec.items.filter((it) => { const d = copies(it); if (d) log.push(`${sec.title} repeat dropped: ${it.slice(0, 50)}`); return !d; }) })).filter((sec) => sec.items.length);
  // the summary is prose: drop a sentence that is a bullet restated
  const sents = (next.summary ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sents.filter((s) => { const d = cwords(s).length >= 6 && copies(s); if (d) log.push(`summary repeat dropped: ${s.slice(0, 50)}`); return !d; });
  if (kept.length !== sents.length && kept.join(" ").split(/\s+/).length >= 12) next.summary = kept.join(" ");
  return { rewrite: next, log };
}
