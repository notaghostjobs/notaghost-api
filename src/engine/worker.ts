import { canonicalPostingUrl } from "./ghost/canon.js";
import { notifyDocumentReady } from "../routes/whatsapp.js";
import { db } from "../lib/db.js";
import { extractText, fetchPosting } from "./extract.js";
import { parseResume, runSharpen, type ResumeProfile, type PostingProfile, type Match } from "./sharpen.js";
import { sanitizeProfile, healWraps } from "./refile.js";
import { deliveryGate, repairForGate, evidenceRecord, orderByRelevance, pdfCheck, keepProfileFigures, dedupeProfile, polishTense } from "./gate.js";
import { readingOrder, pdfPages } from "./pdftext.js";
import { resumePdf } from "./pdf.js";
import { createHash } from "node:crypto";
import { fit, target } from "../engine/fit.js";
import { addedFacts } from "./told.js";
import { takeDraft, draftKey } from "./prewarm.js";
import { refileBullets } from "./refile.js";
import { withMeter, charge } from "./meter.js";

/** Called right after upload. Extracts + parses once; stores text and profile. */
export async function processResume(resumeId: string) {
  const { data: row } = await db.from("resumes").select("*").eq("id", resumeId).single();
  if (!row) return;
  const file = await db.storage.from("resumes").download(row.storage_path);
  if (file.error) throw file.error;
  const buf = Buffer.from(await file.data.arrayBuffer());
  let { text, pages, ours, links } = await extractText(buf, row.filename ?? "resume.pdf");
  const isPdf = !/\.docx?$/i.test(row.filename ?? "");
  // a PDF with no text layer (printed to PDF as shapes, a scan, an image export): the clerk reads it from the page itself.
  // Decided 7 Nov (option B): a bounce becomes a customer, and they are told their file is invisible to employer software.
  const fromPage = isPdf && text.length < 300;
  if (!isPdf && text.length < 300) throw Object.assign(new Error("Couldn't read text from that file. Upload it as a PDF, .docx or .doc with real text — not a scan or an image."), { status: 400 });
  let parsed: ResumeProfile;
  if (fromPage) {
    parsed = await parseResume("", pages, buf).catch(() => null as any);
    const got = (parsed?.roles ?? []).reduce((n, r) => n + (r.bullets?.length ?? 0), 0);
    if (!parsed?.name || !(parsed.roles ?? []).length || got < 2)
      throw Object.assign(new Error("This PDF has no text in it — only a picture of the words — and the page is not clear enough to read. Open your résumé in Word or Google Docs, use Save as PDF, and upload that."), { status: 400 });
    // the text on file is what the clerk read, so later checks have something to stand on
    text = textOf(parsed);
    (parsed as any).read_from_page = true;
    (parsed as any).layout_warning = "Your PDF has no text layer — the words are drawn as a picture, so employer screening software can't read it at all. We read it from the page. For your applications, export a text PDF from Word or Google Docs (Save as PDF).";
    (parsed as any).source_is_ghosted = false; (parsed as any).refiled = true;
  } else {
    // the clerk reads the page itself (PDF) so columns and sidebars come out in reading order; the extracted text rides along for exact characters
    parsed = await parseResume(text, pages, isPdf ? buf : undefined);
    (parsed as any).source_is_ghosted = !!ours;   // a document we made, re-uploaded as the source: allowed; noted for diagnosis
    const layout = layoutWarning(text, pages);
    (parsed as any).layout_warning = layout;
    // the parse is checked against the text it came from: a bullet filed under the neighbouring employer goes back to its own
    const tidy = sanitizeProfile(parsed);
    if (tidy.log.length) { parsed = tidy.profile; console.error("[resume] SANITIZED", resumeId, tidy.log); }
    parsed = withLinks(parsed, links ?? []);
    const refiled = refileBullets(parsed, text);
    if (refiled.log.length) { parsed = refiled.profile; console.error("[resume] REFILED", resumeId, refiled.log); }
    // lines that met after the refile (a cut-off copy and its full line) are tidied once more
    // whether the parse could be checked against the page at all (headers found, text in reading order): on record with the parse
    (parsed as any).parse_check = await verifyParse(parsed, refiled.log, text, pages, isPdf ? buf : null);
    if (!(parsed as any).parse_check.verified) console.error("[resume] PARSE UNVERIFIED", resumeId, (parsed as any).parse_check);
    const tidy2 = sanitizeProfile(parsed); if (tidy2.log.length) { parsed = tidy2.profile; console.error("[resume] SANITIZED", resumeId, tidy2.log); }
    (parsed as any).refiled = 6;
  }
  await db.from("resumes").update({ text, parsed }).eq("id", resumeId);
  return parsed;
}

/** Runs one Sharpen shot end to end. Fire-and-forget from the route; status is polled. */
export async function runShot(shotId: string) {
  const { data: shot } = await db.from("shots").select("*").eq("id", shotId).single();
  if (!shot || shot.status !== "queued") return;
  // metered under the account; a shot drawn on a Radar plan counts against that plan's ₹600
  const { data: plan } = shot.plan_id ? await db.from("plans").select("product, created_at").eq("id", shot.plan_id).maybeSingle() : { data: null };
  if (plan?.product === "radar") { await charge(shot.user_id, plan.created_at ?? new Date().toISOString(), "sharpen:radar", () => runShotInner(shotId, shot)); return; }
  await withMeter({ tag: `sharpen:${shot.product ?? "sharpen"}`, user: shot.user_id }, () => runShotInner(shotId, shot));
}
/** At boot: a Sharpen the restart cut off is picked up again from the start (the person's screen is still waiting on it),
 *  as long as it began in the last twenty minutes. Nothing is charged twice: the Sharpen was already counted once. */
export async function resumeShots(): Promise<number> {
  const since = new Date(Date.now() - 20 * 60e3).toISOString();
  const { data } = await db.from("shots").select("id").in("status", ["running", "queued"]).gte("created_at", since).limit(20);
  for (const s of data ?? []) {
    await db.from("shots").update({ status: "queued" }).eq("id", s.id);
    void runShot(s.id).catch((e) => console.error("[shots] resume", s.id, (e as Error).message));
  }
  return (data ?? []).length;
}
/** Shots a restart left behind: "running" or "queued" for more than ten minutes will never finish. They are closed as
 *  failed and the Sharpen returned, so nobody watches a timer that cannot end. Runs at boot. */
export async function unstickShots(): Promise<number> {
  const cutoff = new Date(Date.now() - 21 * 60e3).toISOString();   // younger ones were picked up again at boot (resumeShots) and are running
  const { data } = await db.from("shots").select("id, plan_id").in("status", ["running", "queued"]).lt("created_at", cutoff).limit(50);
  for (const s of data ?? []) {
    await db.from("shots").update({ status: "failed", error: "We were interrupted while working on this one. Nothing was used — try again.", output: { detail: "closed at boot: left running by a restart" } }).eq("id", s.id);
    await db.rpc("refund_shot", { p_plan: s.plan_id }).then(() => {}, () => {});
  }
  return (data ?? []).length;
}

/** The contact line's links as URLs. A résumé often shows "LinkedIn Profile" as the words of a link: the parse copies the
 *  words; the URL behind them (from the PDF's link annotations) replaces them, and any embedded profile link not in the
 *  contact line is added. */
export function withLinks(profile: ResumeProfile, links: string[]): ResumeProfile {
  if (!links.length) return profile;
  const isUrl = (x: string) => /^(https?:\/\/|www\.)|\.[a-z]{2,}\//i.test(x) || /\b[a-z0-9-]+\.(com|in|io|dev|me|co|org|net)\b/i.test(x);
  const cur = (profile.contact?.links ?? []).map((x) => String(x).trim()).filter(Boolean);
  const out: string[] = [];
  const used = new Set<string>();
  for (const x of cur) {
    if (isUrl(x)) { out.push(x); continue; }
    // the words of a link ("LinkedIn Profile", "Portfolio", "GitHub") → the matching URL
    const key = x.toLowerCase();
    const hit = links.find((u) => !used.has(u) && ((/linkedin/.test(key) && /linkedin\.com/i.test(u)) || (/github/.test(key) && /github\.com/i.test(u)) || (/portfolio|website|site|blog/.test(key) && !/linkedin|github|mailto/i.test(u))));
    if (hit) { out.push(hit); used.add(hit); } else out.push(x);
  }
  // a profile link embedded in the page but nowhere in the contact line
  for (const u of links) if (/linkedin\.com\/in\//i.test(u) && !out.some((x) => x.toLowerCase().includes("linkedin"))) out.push(u);
  return { ...profile, contact: { ...(profile.contact ?? {}), links: out } };
}

/** Whether a parse's role-by-role attribution can be stood behind — and the fallback when the first check cannot say.
 *  First: the deterministic check against the page's text (refile). If that could not run (headers not found, text not in
 *  reading order), the page is read a second time, independently and from the page alone, and the two readings are compared
 *  line by line: the same lines under the same roles means the attribution is not an accident of one reading. If they
 *  disagree, the parse is unverified — and nothing is sold on it (the preview stops and asks for a simpler file). */
export async function verifyParse(parsed: ResumeProfile, refileLog: string[], text: string, pages: number, buf: Buffer | null): Promise<{ verified: boolean; by: string; notes: string[] }> {
  const skipped = refileLog.filter((l) => /skipped/.test(l));
  if (!skipped.length) return { verified: true, by: "page text", notes: [] };
  if (!(parsed.roles ?? []).some((r) => (r.bullets ?? []).length)) return { verified: true, by: "no lines to attribute", notes: skipped };
  try {
    const second = sanitizeProfile(await parseResume(buf ? "" : text, pages, buf ?? undefined)).profile;
    const n = (t: string) => String(t ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const key = (r: { company: string; start: string }) => n(r.company) + "|" + n(r.start).replace(/\D/g, "").slice(-2);
    const where = new Map<string, string>();
    for (const r of second.roles ?? []) for (const b of r.bullets ?? []) where.set(n(b).split(" ").slice(0, 8).join(" "), key(r));
    let total = 0, same = 0, seen = 0;
    for (const r of parsed.roles ?? []) for (const b of r.bullets ?? []) { total++; const w = where.get(n(b).split(" ").slice(0, 8).join(" ")); if (w) { seen++; if (w === key(r)) same++; } }
    const agree = total ? same / total : 0;
    const notes = [...skipped, `second reading: ${same} of ${total} lines under the same role (${seen} found)`];
    return { verified: (second.roles ?? []).length === (parsed.roles ?? []).length && agree >= 0.95, by: "second reading", notes };
  } catch (e) { return { verified: false, by: "second reading failed", notes: [...skipped, e instanceof Error ? e.message : String(e)] }; }
}

/** The résumé's parse as every reader must see it. A parse made before the 13 Nov check (marker 6) is checked once against
 *  the file read afresh — the text on record may be in stream order — and the corrected parse is kept. The prewarm and the
 *  shot both go through here, so a draft is never written from a parse the shot will no longer use. */
export async function checkedProfile(resumeId: string, tag = "shot"): Promise<ResumeProfile | null> {
  const { data: res } = await db.from("resumes").select("parsed, text, storage_path, filename").eq("id", resumeId).single();
  if (!res?.parsed) return null;
  let profile = res.parsed as ResumeProfile;
  if (res.text && (profile as any).refiled !== 6 && !(profile as any).read_from_page) {
    let text: string = res.text; let buf: Buffer | null = null; let pages = Number((profile as any).pages) || 1;
    try {
      const file = await db.storage.from("resumes").download(res.storage_path);
      if (!file.error) { buf = Buffer.from(await file.data.arrayBuffer()); const again = await extractText(buf, res.filename ?? "resume.pdf"); if (again.text.length > 200) text = again.text; pages = again.pages || pages; profile = withLinks(profile, again.links ?? []); }
    } catch { buf = null; /* the text on record it is */ }
    const tidy = sanitizeProfile(profile); if (tidy.log.length) console.error(`[${tag}] SANITIZED`, resumeId, tidy.log);
    const refiled = refileBullets(tidy.profile, text);
    const isPdf = !/\.docx?$/i.test(res.filename ?? "");
    profile = { ...sanitizeProfile(refiled.profile).profile, refiled: 6 } as ResumeProfile;
    (profile as any).parse_check = await verifyParse(profile, refiled.log, text, pages, isPdf ? buf : null);
    if (!(profile as any).parse_check.verified) console.error(`[${tag}] PARSE UNVERIFIED`, resumeId, (profile as any).parse_check);
    if (refiled.log.length) console.error(`[${tag}] REFILED`, resumeId, refiled.log);
    await db.from("resumes").update({ parsed: profile, text }).eq("id", resumeId).then(() => {}, () => {});
  }
  // a reading made before wrapped endings were restored gets them back from the text on record: no model, once
  if (res.text && (profile as any).healed !== 1 && !(profile as any).read_from_page) {
    const h = healWraps(profile, res.text);
    profile = { ...h.profile, healed: 1 } as ResumeProfile;
    if (h.log.length) console.error(`[${tag}] HEALED`, resumeId, h.log);
    await db.from("resumes").update({ parsed: profile }).eq("id", resumeId).then(() => {}, () => {});
  }
  return profile;
}

/** No shot runs past this: a step that never returns must not leave someone watching a timer. */
const SHOT_LIMIT_MS = 6 * 60e3;
async function runShotInner(shotId: string, shot: any) {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("shot exceeded its time limit")), SHOT_LIMIT_MS); });
  try { await Promise.race([runShotBody(shotId, shot), limit]); }
  catch (e) {
    const { data: cur } = await db.from("shots").select("status, output").eq("id", shotId).maybeSingle();
    if (cur?.status === "running") {
      console.error("[shot] TIME LIMIT", shotId, (cur.output as any)?.stage);
      await db.from("shots").update({ status: "failed", error: "This one took too long and we stopped it. Nothing was used — try again.", output: { detail: `${e instanceof Error ? e.message : e} at stage: ${(cur.output as any)?.stage ?? "?"}` } }).eq("id", shotId);
      await db.rpc("refund_shot", { p_plan: shot.plan_id }).then(() => {}, () => {});
    }
  } finally { if (timer) clearTimeout(timer); }
}
async function runShotBody(shotId: string, shot: any) {
  await db.from("shots").update({ status: "running" }).eq("id", shotId);
  try {
    // where the shot is, on its own row: a shot that stops is then seen to have stopped somewhere
    const stage = (st: string) => db.from("shots").update({ output: { stage: st, at: new Date().toISOString() } }).eq("id", shotId).eq("status", "running").then(() => {}, () => {});
    await stage("résumé");
    const profile = await checkedProfile(shot.resume_id);
    if (!profile) throw new Error("Résumé not parsed yet.");
    await stage("posting");

    // posting: fetch or pasted; cache by url hash
    const input = shot.input as { posting_url?: string; posting_text?: string; preview_id?: string; fresh?: boolean };
    let pre: { posting: PostingProfile; matches: Match[] } | undefined;
    let shownPromise: number | null = null;   // the number the user actually saw at preview — the one we are held to
    if (input.preview_id) {
      const { data: pv } = await db.from("previews").select("posting, matches, posting_text, score_after").eq("id", input.preview_id).eq("user_id", shot.user_id).maybeSingle();
      if (pv?.posting && pv?.matches) { pre = { posting: pv.posting as PostingProfile, matches: pv.matches as Match[] }; if (!input.posting_text && pv.posting_text) input.posting_text = pv.posting_text; shownPromise = typeof pv.score_after === "number" ? pv.score_after : null; }
      // Already sharpened (rule book §5, decided 2 Nov): the fit page shows the prior document and offers "Sharpen anyway".
      // A shot that arrives without fresh=true for a pair that already has a document is a client that didn't see the offer:
      // it returns the existing document and does NOT consume the shot (nothing new was produced). fresh=true runs anew and is spent.
      if (!input.fresh) {
        const { data: prev } = await db.from("shots").select("output").eq("user_id", shot.user_id).eq("status", "done").contains("input", { preview_id: input.preview_id }).neq("id", shotId).order("done_at", { ascending: false }).limit(1).maybeSingle();
        if (prev?.output && (prev.output as any).pdf_path) {
          await db.rpc("refund_shot", { p_plan: shot.plan_id }).then(() => {}, () => {});
          await db.from("shots").update({ status: "done", done_at: new Date().toISOString(), output: { ...(prev.output as any), repeat: true } }).eq("id", shotId);
          return;
        }
      }
    }
    let postingId: string | null = null;
    let postingText = input.posting_text ?? "";
    if (input.posting_url) {
      const url_hash = createHash("sha256").update(canonicalPostingUrl(input.posting_url).trim().toLowerCase()).digest("hex");
      const { data: cached } = await db.from("postings").select("id, raw_text").eq("url_hash", url_hash).maybeSingle();
      if (cached) { postingId = cached.id; postingText = cached.raw_text; }
      else {
        postingText = await fetchPosting(input.posting_url);
        const { data: p } = await db.from("postings")
          .insert({ url: input.posting_url, url_hash, source: sourceOf(input.posting_url), raw_text: postingText })
          .select("id").single();
        postingId = p?.id ?? null;
      }
    }
    if (postingText.length < 80) throw new Error("That posting is too short to work with. Paste the full description.");

    // what the candidate told us for requirements the résumé lacked is part of the original for every audit — the
    // rewrite may state it (verbatim, as the vetted line), the verifier and the number rule accept it, and nothing else changes
    const told = pre ? addedFacts(pre.matches) : [];
    const source: ResumeProfile = told.length ? { ...profile, candidate_added_facts: told } : profile;
    await stage("writing");
    const out = await runSharpen(source, postingText, (st) => { void stage("writing: " + st); }, pre, undefined, pre && input.preview_id ? takeDraft(draftKey(input.preview_id, pre.matches, profile)) : null);
    await stage("gate");
    if (postingId) await db.from("postings").update({ company: out.posting.company, title: out.posting.title, parsed: out.posting }).eq("id", postingId);

    // THE DELIVERY GATE (master rule 15). No model here: the finished document against the candidate's own résumé, line by
    // line. A failing document is repaired with the candidate's own lines; one that still fails is not delivered — the
    // Sharpen goes back, and the hold is on record for us to read.
    const toldLines = pre ? pre.matches.filter((m) => m.told && m.line).map((m) => String(m.line)) : [];
    // within each role, what the posting asks for comes first (master rule 8): order only — no line changes, none changes role
    const ordered = orderByRelevance(out.rewrite, out.matches as any);
    out.rewrite = ordered.rewrite;
    // a line with nothing behind it — not theirs, not reworded from theirs, not added for a requirement on quoted evidence,
    // not told to us — does not go out, whatever the verifier thought of it
    {
      const rec = evidenceRecord(out.rewrite, profile, out.matches as any);
      const orphans = rec.filter((e) => e.kind === "new" && e.role !== "Profile");
      if (orphans.length) {
        for (const r of out.rewrite.roles) r.bullets = r.bullets.filter((b) => !orphans.some((o) => o.line === b && o.role === `${r.company} · ${r.title}`));
        console.error("[shot] UNSOURCED LINES REMOVED", shotId, orphans.map((o) => `${o.role}: ${o.line.slice(0, 70)}`));
      }
    }
    // their own profile: a figure they stated is not lost, and nothing is said twice
    const profileLog = [...keepProfileFigures(out.rewrite, profile), ...dedupeProfile(out.rewrite)];
    if (profileLog.length) console.error("[shot] PROFILE", shotId, profileLog);
    let gate = deliveryGate(out.rewrite, profile, out.verification?.problems ?? [], toldLines);
    let gateLog: string[] = [];
    if (!gate.ok) {
      const fix = repairForGate(out.rewrite, profile, out.verification?.problems ?? [], toldLines);
      out.rewrite = fix.rewrite; gateLog = fix.log;
      const first = gate;
      gate = deliveryGate(out.rewrite, profile, fix.unsettled, toldLines);
      console.error("[shot] GATE", shotId, { first, repaired: fix.log, after: gate });
      if (!gate.ok) {
        await db.from("reader_control").upsert({ key: `sharpen_fail:hold:${shotId}`, value: { at: new Date().toISOString(), user: shot.user_id, resume: shot.resume_id, url: input.posting_url ?? null, first, repaired: fix.log, after: gate }, updated_at: new Date().toISOString() }).then(() => {}, () => {});
        throw Object.assign(new Error("We held this one back: the finished résumé did not pass our accuracy check, and we don’t send a document we can’t stand behind. Your Sharpen has been returned, and we’ve been told. Try again — or write to human@notaghost.jobs and we’ll look at it today."), { status: 422 });
      }
    }
    // wording that changes no fact (a finished role in the past tense), kept only if the document still passes the same gate
    let polished = 0;
    { const pol = polishTense(out.rewrite); if (pol.changed && deliveryGate(pol.rewrite, profile, [], toldLines).ok) { out.rewrite = pol.rewrite; polished = pol.changed; } }
    // what the verifier flagged has been taken out by the gate (it would have held the document otherwise): the record says so
    if (gateLog.length && out.verification && out.verification.ok === false) out.verification = { ...out.verification, ok: true, problems: [], settled: out.verification.problems } as any;
    (out as any).gate = { ok: true, repaired: [...gateLog, ...profileLog], reordered: ordered.moved, polished };
    // the evidence record: where every line of the document comes from (kept with the shot; the page shows it)
    (out as any).evidence = evidenceRecord(out.rewrite, profile, out.matches as any);
    await stage("pdf");

    let pdf = await resumePdf(out.rewrite, profile);
    // THE PDF, READ BACK: what a screener's software will see, against the document it was made from. One re-render; a PDF
    // that still does not read true is not sent.
    {
      const read = async (buf: Buffer) => { try { const t = await readingOrder(buf); const pg = await pdfPages(buf); return pdfCheck(t ?? "", pg, out.rewrite, profile.name ?? ""); } catch (e) { return [`the PDF could not be read back: ${e instanceof Error ? e.message : e}`]; } };
      let bad = await read(pdf);
      if (bad.length) { pdf = await resumePdf(out.rewrite, profile); bad = await read(pdf); }
      (out as any).gate.pdf = bad.length ? bad : "ok";
      if (bad.length) {
        console.error("[shot] PDF CHECK", shotId, bad);
        await db.from("reader_control").upsert({ key: `sharpen_fail:hold:${shotId}`, value: { at: new Date().toISOString(), user: shot.user_id, resume: shot.resume_id, pdf: bad }, updated_at: new Date().toISOString() }).then(() => {}, () => {});
        throw Object.assign(new Error("We held this one back: the finished PDF did not read back correctly, and we don’t send a document we can’t stand behind. Your Sharpen has been returned, and we’ve been told. Try again — or write to human@notaghost.jobs and we’ll look at it today."), { status: 422 });
      }
    }
    const pdf_path = `${shot.user_id}/${shotId}.pdf`;
    const up = await db.storage.from("outputs").upload(pdf_path, pdf, { contentType: "application/pdf" });
    if (up.error) throw up.error;

    // one scorer for all three numbers: what the résumé scored, what we promised, what the document scores now
    const before = fit(out.matches), after = fit(out.after_matches), promised = shownPromise ?? target(out.matches);
    // a shot spent is a promise kept: every promised line is in the document by construction (placeLines), so after ≥ promised.
    // If it is ever not, that is an engine fault to be fixed, not a refund to be given — it is logged loudly and shown as delivered.
    const short = after < promised;
    if (short) console.error("[shot] PROMISE NOT MET", shotId, { before, after, promised, timing: out.timing, problems: out.verification?.problems, broken: out.broken });
    await db.from("shots").update({
      status: "done", posting_id: postingId, done_at: new Date().toISOString(),
      output: { ...out, before, after, promised, pdf_path, told: told.length ? pre!.matches.filter((m) => m.told).map((m) => ({ requirement: m.requirement, line: m.line, fact: m.evidence })) : undefined },
    }).eq("id", shotId).eq("status", "running");
    void notifyDocumentReady(shot.user_id, shotId, { title: out.posting?.title ?? pre?.posting?.title ?? "the role", company: out.posting?.company ?? pre?.posting?.company ?? "", before, after, pdf_path, filename: `${String((profile as any)?.name ?? "resume").replace(/\s+/g, "-")}-${String(out.posting?.company ?? "sharpened").replace(/\s+/g, "-")}.pdf` });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error("[shot]", shotId, raw);
    // user sees a plain sentence; the real error stays in the log and in `detail`
    const friendly = (e as { status?: number }).status && (e as { status?: number }).status! < 500
      ? raw
      : "We couldn't finish this one. Nothing was used — try again in a minute.";
    await db.from("shots").update({ status: "failed", error: friendly, output: { detail: raw.slice(0, 500), foreign: (e as any)?.foreign ?? undefined } }).eq("id", shotId);
    // refund the shot
    await db.rpc("refund_shot", { p_plan: shot.plan_id }).then(() => {}, () => {});
  }
}

function sourceOf(url: string) {
  const h = new URL(url).hostname;
  if (h.includes("linkedin")) return "linkedin";
  if (h.includes("naukri")) return "naukri";
  if (h.includes("greenhouse")) return "greenhouse";
  if (h.includes("lever")) return "lever";
  return "careers";
}


/** What a screener's software would also struggle with: columns, graphics, very little text. Heuristics on the extracted text only. */
/** The profile written back out as plain text, in reading order — the text on file for a résumé the clerk read from the page. */
function textOf(p: ResumeProfile): string {
  const out: string[] = [p.name, p.headline, [p.contact?.email, p.contact?.phone, p.contact?.city].filter(Boolean).join(" · "), "", "EXPERIENCE"];
  for (const r of p.roles ?? []) { out.push("", `${r.title} — ${r.company}`, `${r.start} – ${r.end}`); for (const b of r.bullets ?? []) out.push(b); }
  if ((p.skills ?? []).length) out.push("", "SKILLS", (p.skills ?? []).map((s: any) => s?.name ?? s).join(", "));
  if ((p.education ?? []).length) { out.push("", "EDUCATION"); for (const e of p.education) out.push(`${e.degree} — ${e.school} ${e.year ?? ""}`.trim()); }
  for (const x of p.extra_sections ?? []) { out.push("", x.title.toUpperCase()); out.push(...x.items); }
  return out.join("\n");
}

export function layoutWarning(text: string, pages: number): string | null {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const short = lines.filter((l) => l.split(/\s+/).length <= 3).length / lines.length;     // columns extract as word fragments
  const perPage = text.length / Math.max(1, pages);
  const broken = (text.match(/[a-z]{2,}\s{2,}[a-z]{2,}/g) || []).length / Math.max(1, lines.length);
  if (perPage < 900) return "Very little readable text per page — graphics, a photo or a scanned layout. Screening software reads what we read: a plain text PDF will do better.";
  if (short > 0.55 || broken > 0.6) return "This layout (two columns or a sidebar) comes out jumbled when software reads it — the same thing an employer's screening system sees. A single-column version will do better everywhere.";
  return null;
}
