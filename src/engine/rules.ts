import type { Rewrite, ResumeProfile, PostingProfile } from "./sharpen.js";

/** Mirrors RESUME_RULES.md. Returns the list of broken HARD rules (empty = pass). */
export function checkRules(r: Rewrite, orig: ResumeProfile, posting: PostingProfile): string[] {
  const bad: string[] = [];
  const words = (s: string) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

  // 2. headline must not be the posting's title
  const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (norm(r.headline) && norm(posting.title) && overlap(norm(r.headline), norm(posting.title)) >= 0.7 &&
      !orig.roles.some((ro) => overlap(norm(ro.title), norm(r.headline)) >= 0.7))
    bad.push("R2 headline is the posting's title, not the candidate's");

  // 5. title length
  if (words(r.headline) > 6 || /\|/.test(r.headline ?? "")) bad.push("R5 headline > 6 words or contains a pipe");

  // 6. summary length
  const sw = words(r.summary);
  if (sw < 35 || sw > 80) bad.push(`R6 summary is ${sw} words (35–80)`);

  // 7. relevant block
  const rel = r.relevant ?? [];
  if (rel.length < 3 || rel.length > 4) bad.push(`R7 relevant has ${rel.length} lines (3–4)`);
  rel.forEach((l, i) => { if (words(l) > 34) bad.push(`R7 relevant line ${i + 1} is ${words(l)} words (≤30)`); });

  // 8. bullets
  const all: string[] = [];
  r.roles.forEach((ro, i) => {
    const n = ro.bullets.length;
    const recent = i < 2;
    if (recent && (n < 4 || n > 6)) bad.push(`R8 ${ro.company}: ${n} bullets (recent roles need 4–6)`);
    if (!recent && (n < 2 || n > 4)) bad.push(`R8 ${ro.company}: ${n} bullets (older roles need 2–4)`);
    ro.bullets.forEach((b) => {
      if (words(b) > 34) bad.push(`R8 bullet too long (${words(b)} words): "${b.slice(0, 50)}…"`);
      if (!/^[A-Z][a-z]+/.test(b.trim())) bad.push(`R8 bullet doesn't start with a verb: "${b.slice(0, 40)}…"`);
      for (const prev of all) if (overlap(norm(b), norm(prev)) >= 0.7) { bad.push(`R8 repeated bullet: "${b.slice(0, 50)}…"`); break; }
      all.push(b);
    });
  });

  // 9. skills
  if (r.skills.length < 6 || r.skills.length > 14) bad.push(`R9 ${r.skills.length} skills (6–14)`);

  // 10. personal details
  const text = JSON.stringify(r).toLowerCase();
  for (const k of ["date of birth", "dob:", "marital", "married", "unmarried", "religion", "caste", "father's name", "passport no"])
    if (text.includes(k)) bad.push(`R10 personal detail present: ${k}`);

  // 11. banned words
  for (const w of ["passionate", "results-driven", "results driven", "dynamic", "synergy", "go-getter", "hardworking", "hard-working", "detail-oriented", "team player", "seasoned", "guru", "ninja", "rockstar"])
    if (new RegExp(`\\b${w.replace("-", "[- ]")}\\b`, "i").test(text)) bad.push(`R11 banned word: ${w}`);

  // 19. numbers preserved exactly: every number in the rewrite must appear in the original
  const nums = (s: string) => new Set((s.replace(/\$\s+/g, "$").replace(/(\d)\s+([kKmM]\b)/g, "$1$2").match(/\d[\d,.]*%?|\$\d[\d,.]*[kKmM]?/g) ?? []).map((x) => x.replace(/[\s,]/g, "").replace(/\.0+$/, "").toLowerCase()));
  const origNums = nums(JSON.stringify(orig));
  for (const n of nums(JSON.stringify({ s: r.summary, rel: r.relevant, roles: r.roles })))
    if (!origNums.has(n) && !/^(19|20)\d\d$/.test(n) && n.length > 1) bad.push(`R19 number not in original: ${n}`);

  return bad;
}

function overlap(a: string, b: string) {
  const A = new Set(a.split(" ")), B = new Set(b.split(" "));
  if (!A.size || !B.size) return 0;
  let common = 0; for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

/** Mechanical fixes that don't need the model: trim skills, drop banned words, shorten over-long lines. */
export function tidy(r: Rewrite): Rewrite {
  const banned = /\b(passionate|results[- ]driven|dynamic|synergy|go-getter|hard-?working|detail-oriented|team player|seasoned|guru|ninja|rockstar)\b/gi;
  const clean = (t: string) => t.replace(banned, "").replace(/\s{2,}/g, " ").replace(/^[,\s]+|[,\s]+$/g, "").replace(/\s,/g, ",");
  const cap = (t: string, n: number) => { const w = t.split(/\s+/); return w.length <= n ? t : w.slice(0, n).join(" ").replace(/[,;:]$/, "") ; };
  return {
    ...r,
    headline: cap(clean(r.headline), 8),
    summary: clean(r.summary),
    relevant: (r.relevant ?? []).slice(0, 4).map(clean),
    roles: r.roles.map((ro) => ({ ...ro, bullets: ro.bullets.map(clean) })),
    skills: (r.skills ?? []).slice(0, 14),
  };
}
