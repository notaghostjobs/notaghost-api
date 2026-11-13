// The delivery gate (RESUME_RULES §Truth, master rule 15: "validate before delivery").
//
// Everything before this point tries to make the document right. This is the last look, with no model in it: the finished
// document is compared line by line with the candidate's own résumé, and a document that does not pass is repaired by
// putting the candidate's own lines back — or it is not delivered. Three gates:
//   factual    every claim the independent verifier could not support is gone (or is the candidate's own line, verbatim)
//   attribution every line the candidate wrote is in the document under the role it was written under; none sits under another
//   technical  no stray glyphs, no section labels as lines, no duplicate lines in a role, no second copy of the profile
import type { ResumeProfile, Rewrite } from "./sharpen.js";
import { LABEL } from "./refile.js";

const norm = (t: string) => String(t ?? "").toLowerCase().replace(/[’'ʼ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const content = (t: string) => norm(t).split(" ").filter((w) => w.length >= 4 || /\d/.test(w));
const PUA = /[-�]/;
const SUMMARY_LIKE = /\b(objective|summary|profile|about\s*me|overview|synopsis)\b/i;

/** Share of `a`'s content words that `b` has. */
function covered(a: string, b: string): number { const A = content(a); if (!A.length) return 1; const B = new Set(content(b)); return A.filter((w) => B.has(w)).length / A.length; }
const roleKey = (r: { company: string; title: string }) => norm(r.company) + "|" + norm(r.title);
function roleFor(rw: Rewrite, o: { company: string; title: string; start: string }) {
  return rw.roles.find((r) => roleKey(r) === roleKey(o)) ?? rw.roles.find((r) => norm(r.company) === norm(o.company) && norm(r.start) === norm(o.start)) ?? null;
}

export type GateReport = { ok: boolean; factual: string[]; lost: string[]; moved: string[]; technical: string[] };

export function deliveryGate(rw: Rewrite, orig: ResumeProfile, problems: { claim: string; reason: string }[] = [], told: string[] = []): GateReport {
  const lost: string[] = [], moved: string[] = [], technical: string[] = [], factual: string[] = [];
  const toldN = told.map(norm);
  const isTold = (b: string) => toldN.some((t) => t && (norm(b).includes(t.split(" ").slice(0, 6).join(" ")) || covered(b, t) >= 0.85));

  // attribution, half one: nothing the candidate wrote is missing from its role
  for (const o of orig.roles ?? []) {
    const r = roleFor(rw, o);
    if (!r) { lost.push(`role missing: ${o.title} · ${o.company}`); continue; }
    if ((o.bullets ?? []).length && !r.bullets.length) lost.push(`role emptied: ${o.title} · ${o.company}`);
    const text = r.bullets.join(" ");
    for (const b of o.bullets ?? []) if (covered(b, text) < 0.7) lost.push(`${o.company}: ${b.slice(0, 70)}`);
  }
  // attribution, half two: no line of one role sits under another
  for (const r of rw.roles ?? []) {
    const own = (orig.roles ?? []).find((o) => roleKey(o) === roleKey(r)) ?? (orig.roles ?? []).find((o) => norm(o.company) === norm(r.company) && norm(o.start) === norm(r.start));
    for (const b of r.bullets) {
      if (isTold(b)) continue;
      if ((own?.bullets ?? []).some((ob) => covered(b, ob) >= 0.6 || covered(ob, b) >= 0.6)) continue;   // this role's own line, reworded or not
      const other = (orig.roles ?? []).find((o) => o !== own && (o.bullets ?? []).some((ob) => covered(b, ob) >= 0.8 && content(b).length >= 5));
      if (other) moved.push(`${other.company} → ${r.company}: ${b.slice(0, 70)}`);
    }
  }
  // technical
  const all = JSON.stringify({ h: rw.headline, s: rw.summary, r: rw.relevant, roles: rw.roles, sk: rw.skills, x: rw.extra_sections });
  if (PUA.test(all)) technical.push("a character no font can draw");
  for (const r of rw.roles ?? []) {
    const seen = new Set<string>();
    for (const b of r.bullets) {
      if (LABEL.test(b) && /:/.test(b.slice(0, 50))) technical.push(`section label as a line in ${r.company}: ${b.slice(0, 50)}`);
      if (content(b).length < 2) technical.push(`empty line in ${r.company}`);
      const k = norm(b); if (seen.has(k)) technical.push(`duplicate line in ${r.company}: ${b.slice(0, 50)}`); seen.add(k);
    }
  }
  for (const x of rw.extra_sections ?? []) if (SUMMARY_LIKE.test(x.title || "")) technical.push(`second profile block: ${x.title}`);
  if (!norm(rw.summary ?? "") && !(rw.relevant ?? []).length) technical.push("no profile");
  // factual: what the independent verifier could not support
  for (const p of problems) factual.push(`${String(p.claim).slice(0, 110)} — ${String(p.reason).slice(0, 110)}`);
  return { ok: !lost.length && !moved.length && !technical.length && !factual.length, factual, lost, moved, technical };
}

/** Deterministic repair for a document that failed the gate. Only ever does three things: puts the candidate's own line back
 *  where they wrote it, takes out a line that is not theirs to that role (or that the verifier could not support and that is
 *  not their own wording), and removes debris. Returns the repaired document and the verifier claims it could not settle. */
export function repairForGate(rw0: Rewrite, orig: ResumeProfile, problems: { claim: string; reason: string }[] = [], told: string[] = []): { rewrite: Rewrite; log: string[]; unsettled: { claim: string; reason: string }[] } {
  const rw: Rewrite = JSON.parse(JSON.stringify(rw0)); const log: string[] = [];
  const toldN = told.map(norm);
  const isTold = (b: string) => toldN.some((t) => t && (norm(b).includes(t.split(" ").slice(0, 6).join(" ")) || covered(b, t) >= 0.85));
  const ownOf = (r: { company: string; title: string; start: string }) => (orig.roles ?? []).find((o) => roleKey(o) === roleKey(r)) ?? (orig.roles ?? []).find((o) => norm(o.company) === norm(r.company) && norm(o.start) === norm(r.start));
  const isOwnVerbatim = (r: { company: string; title: string; start: string }, b: string) => (ownOf(r)?.bullets ?? []).some((ob) => norm(ob) === norm(b));

  // debris
  const scrub = (t: string) => String(t ?? "").replace(/[-�]/g, " ").replace(/\s+/g, " ").trim();
  rw.headline = scrub(rw.headline); rw.summary = scrub(rw.summary); rw.relevant = (rw.relevant ?? []).map(scrub).filter(Boolean); rw.skills = (rw.skills ?? []).map(scrub).filter(Boolean);
  rw.extra_sections = (rw.extra_sections ?? []).filter((x) => { const bad = SUMMARY_LIKE.test(x.title || ""); if (bad) log.push(`removed second profile block: ${x.title}`); return !bad; }).map((x) => ({ ...x, items: x.items.map(scrub).filter(Boolean) }));
  for (const r of rw.roles) {
    const seen = new Set<string>();
    r.bullets = r.bullets.map(scrub).map((b) => { const m = b.match(LABEL); return m && /:/.test(m[0]) ? b.slice(m[0].length).trim() : b; }).filter((b) => { const k = norm(b); if (content(b).length < 2 || seen.has(k)) return false; seen.add(k); return true; });
  }
  // a line of another role: out of this one (its own role gets it back below if it is missing there)
  for (const r of rw.roles) {
    const own = ownOf(r);
    r.bullets = r.bullets.filter((b) => {
      if (isTold(b)) return true;
      if ((own?.bullets ?? []).some((ob) => covered(b, ob) >= 0.6 || covered(ob, b) >= 0.6)) return true;
      const other = (orig.roles ?? []).find((o) => o !== own && (o.bullets ?? []).some((ob) => covered(b, ob) >= 0.8 && content(b).length >= 5));
      if (other) { log.push(`taken out of ${r.company} (it is ${other.company}'s): ${b.slice(0, 60)}`); return false; }
      return true;
    });
  }
  // what the verifier could not support: the line goes, unless it is the candidate's own wording in its own role
  const unsettled: { claim: string; reason: string }[] = [];
  for (const p of problems) {
    const quoted = (String(p.claim).match(/[“"]([^”"]{12,})[”"]/) ?? [])[1] ?? String(p.claim).replace(/^[^:]{0,60}:\s*/, "");
    let hit = false, ownLine = false;
    for (const r of rw.roles) {
      r.bullets = r.bullets.filter((b) => {
        if (!(covered(quoted, b) >= 0.8 || covered(b, quoted) >= 0.8)) return true;
        if (isOwnVerbatim(r, b) || isTold(b)) { ownLine = true; return true; }   // the candidate's own words (or what they told us): theirs to stand behind
        hit = true; log.push(`unsupported line removed from ${r.company}: ${b.slice(0, 60)}`); return false;
      });
    }
    const before = (rw.relevant ?? []).length;
    rw.relevant = (rw.relevant ?? []).filter((x) => isTold(x) || !(covered(quoted, x) >= 0.8 || covered(x, quoted) >= 0.8));
    if ((rw.relevant ?? []).length !== before) { hit = true; log.push(`unsupported line removed from the profile block: ${quoted.slice(0, 60)}`); }
    // a sentence of the summary
    const sents = String(rw.summary ?? "").match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [];
    const keep = sents.filter((s) => !(covered(quoted, s) >= 0.8 || (content(s).length >= 4 && covered(s, quoted) >= 0.8)));
    if (keep.length !== sents.length && keep.length) { rw.summary = keep.join("").trim(); hit = true; log.push(`unsupported sentence removed from the summary: ${quoted.slice(0, 60)}`); }
    if (!(hit || ownLine)) unsettled.push(p);
  }
  // the candidate's own lines, back where they wrote them
  for (const o of orig.roles ?? []) {
    let r = roleFor(rw, o);
    if (!r) { r = { company: o.company, title: o.title, start: o.start, end: o.end, bullets: [] }; const at = rw.roles.findIndex((x) => (orig.roles ?? []).findIndex((y) => roleKey(y) === roleKey(x)) > (orig.roles ?? []).indexOf(o)); if (at < 0) rw.roles.push(r); else rw.roles.splice(at, 0, r); log.push(`role restored: ${o.title} · ${o.company}`); }
    for (const b of o.bullets ?? []) if (covered(b, r.bullets.join(" ")) < 0.7) { r.bullets.push(b.trim()); log.push(`line restored to ${o.company}: ${b.slice(0, 60)}`); }
  }
  return { rewrite: rw, log, unsettled };
}
