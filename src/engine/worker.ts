import { canonicalPostingUrl } from "./ghost/canon.js";
import { notifyDocumentReady } from "../routes/whatsapp.js";
import { db } from "../lib/db.js";
import { extractText, fetchPosting } from "./extract.js";
import { parseResume, runSharpen, type ResumeProfile, type PostingProfile, type Match } from "./sharpen.js";
import { sanitizeProfile } from "./refile.js";
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
  let { text, pages, ours } = await extractText(buf, row.filename ?? "resume.pdf");
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
    const refiled = refileBullets(parsed, text);
    if (refiled.log.length) { parsed = refiled.profile; console.error("[resume] REFILED", resumeId, refiled.log); }
    // lines that met after the refile (a cut-off copy and its full line) are tidied once more
    const tidy2 = sanitizeProfile(parsed); if (tidy2.log.length) { parsed = tidy2.profile; console.error("[resume] SANITIZED", resumeId, tidy2.log); }
    (parsed as any).refiled = 2;
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
async function runShotInner(shotId: string, shot: any) {
  await db.from("shots").update({ status: "running" }).eq("id", shotId);
  try {
    const { data: res } = await db.from("resumes").select("parsed, text, storage_path, filename").eq("id", shot.resume_id).single();
    if (!res?.parsed) throw new Error("Résumé not parsed yet.");
    let profile = res.parsed as ResumeProfile;
    // refiled === 2 is the 13 Nov check (the page read in reading order, roles in the page's order); older parses are checked
    // again on their next shot — against the file read afresh, since the text on record may be in stream order
    if (res.text && (profile as any).refiled !== 2 && !(profile as any).read_from_page) {
      let text: string = res.text;
      try {
        const file = await db.storage.from("resumes").download(res.storage_path);
        if (!file.error) { const again = await extractText(Buffer.from(await file.data.arrayBuffer()), res.filename ?? "resume.pdf"); if (again.text.length > 200) text = again.text; }
      } catch { /* the text on record it is */ }
      const tidy = sanitizeProfile(profile); if (tidy.log.length) console.error("[shot] SANITIZED", shot.resume_id, tidy.log);
      const refiled = refileBullets(tidy.profile, text);
      profile = { ...sanitizeProfile(refiled.profile).profile, refiled: 2 } as ResumeProfile;
      if (refiled.log.length) console.error("[shot] REFILED", shot.resume_id, refiled.log);
      await db.from("resumes").update({ parsed: profile, text }).eq("id", shot.resume_id).then(() => {}, () => {});
    }

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
    const out = await runSharpen(source, postingText, undefined, pre, undefined, pre && input.preview_id ? takeDraft(draftKey(input.preview_id, pre.matches)) : null);
    if (postingId) await db.from("postings").update({ company: out.posting.company, title: out.posting.title, parsed: out.posting }).eq("id", postingId);

    const pdf = await resumePdf(out.rewrite, profile);
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
    }).eq("id", shotId);
    void notifyDocumentReady(shot.user_id, shotId, { title: out.posting?.title ?? pre?.posting?.title ?? "the role", company: out.posting?.company ?? pre?.posting?.company ?? "", before, after, pdf_path, filename: `${String((profile as any)?.name ?? "resume").replace(/\s+/g, "-")}-${String(out.posting?.company ?? "sharpened").replace(/\s+/g, "-")}.pdf` });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error("[shot]", shotId, raw);
    // user sees a plain sentence; the real error stays in the log and in `detail`
    const friendly = (e as { status?: number }).status && (e as { status?: number }).status! < 500
      ? raw
      : "We couldn't finish this one. Nothing was used — try again in a minute.";
    await db.from("shots").update({ status: "failed", error: friendly, output: { detail: raw.slice(0, 500) } }).eq("id", shotId);
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
