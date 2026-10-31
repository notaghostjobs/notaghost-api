import { db } from "../lib/db.js";
import { extractText, fetchPosting } from "./extract.js";
import { parseResume, runSharpen, type ResumeProfile, type PostingProfile, type Match } from "./sharpen.js";
import { resumePdf } from "./pdf.js";
import { createHash } from "node:crypto";
import { fit, target } from "../engine/fit.js";

/** Called right after upload. Extracts + parses once; stores text and profile. */
export async function processResume(resumeId: string) {
  const { data: row } = await db.from("resumes").select("*").eq("id", resumeId).single();
  if (!row) return;
  const file = await db.storage.from("resumes").download(row.storage_path);
  if (file.error) throw file.error;
  const buf = Buffer.from(await file.data.arrayBuffer());
  const { text, pages } = await extractText(buf, row.filename ?? "resume.pdf");
  if (text.length < 300) throw Object.assign(new Error("Couldn't read text from that file. Export it as a text PDF, not a scan."), { status: 400 });
  const parsed = await parseResume(text, pages);
  const layout = layoutWarning(text, pages);
  (parsed as any).layout_warning = layout;
  await db.from("resumes").update({ text, parsed }).eq("id", resumeId);
  return parsed;
}

/** Runs one Sharpen shot end to end. Fire-and-forget from the route; status is polled. */
export async function runShot(shotId: string) {
  const { data: shot } = await db.from("shots").select("*").eq("id", shotId).single();
  if (!shot || shot.status !== "queued") return;
  await db.from("shots").update({ status: "running" }).eq("id", shotId);
  try {
    const { data: res } = await db.from("resumes").select("parsed, text").eq("id", shot.resume_id).single();
    if (!res?.parsed) throw new Error("Résumé not parsed yet.");
    const profile = res.parsed as ResumeProfile;

    // posting: fetch or pasted; cache by url hash
    const input = shot.input as { posting_url?: string; posting_text?: string; preview_id?: string };
    let pre: { posting: PostingProfile; matches: Match[] } | undefined;
    let shownPromise: number | null = null;   // the number the user actually saw at preview — the one we are held to
    if (input.preview_id) {
      const { data: pv } = await db.from("previews").select("posting, matches, posting_text, score_after").eq("id", input.preview_id).eq("user_id", shot.user_id).maybeSingle();
      if (pv?.posting && pv?.matches) { pre = { posting: pv.posting as PostingProfile, matches: pv.matches as Match[] }; if (!input.posting_text && pv.posting_text) input.posting_text = pv.posting_text; shownPromise = typeof pv.score_after === "number" ? pv.score_after : null; }
      // the same résumé against the same posting was already sharpened: the document and its number are returned as they were.
      // A second shot on the same pair is not a new roll of the dice; it is the same answer (and the shot comes back).
      const { data: prev } = await db.from("shots").select("output").eq("user_id", shot.user_id).eq("status", "done").contains("input", { preview_id: input.preview_id }).neq("id", shotId).order("done_at", { ascending: false }).limit(1).maybeSingle();
      if (prev?.output && (prev.output as any).pdf_path) {
        await db.rpc("refund_shot", { p_plan: shot.plan_id }).then(() => {}, () => {});
        await db.from("shots").update({ status: "done", done_at: new Date().toISOString(), output: { ...(prev.output as any), shot_returned: true, repeat: true } }).eq("id", shotId);
        return;
      }
    }
    let postingId: string | null = null;
    let postingText = input.posting_text ?? "";
    if (input.posting_url) {
      const url_hash = createHash("sha256").update(input.posting_url.trim().toLowerCase()).digest("hex");
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

    const out = await runSharpen(profile, postingText, undefined, pre);
    if (postingId) await db.from("postings").update({ company: out.posting.company, title: out.posting.title, parsed: out.posting }).eq("id", postingId);

    const pdf = await resumePdf(out.rewrite, profile);
    const pdf_path = `${shot.user_id}/${shotId}.pdf`;
    const up = await db.storage.from("outputs").upload(pdf_path, pdf, { contentType: "application/pdf" });
    if (up.error) throw up.error;

    // one scorer for all three numbers: what the résumé scored, what we promised, what the document scores now
    const before = fit(out.matches), after = fit(out.after_matches), promised = shownPromise ?? target(out.matches);
    // the number we delivered is below the number we promised at preview: the document still goes out, the shot comes back
    const short = after < promised;
    if (short) await db.rpc("refund_shot", { p_plan: shot.plan_id }).then(() => {}, () => {});
    await db.from("shots").update({
      status: "done", posting_id: postingId, done_at: new Date().toISOString(),
      output: { ...out, before, after, promised, shot_returned: short, pdf_path },
    }).eq("id", shotId);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error("[shot]", shotId, raw);
    // user sees a plain sentence; the real error stays in the log and in `detail`
    const friendly = (e as { status?: number }).status && (e as { status?: number }).status! < 500
      ? raw
      : "We couldn't finish this one. Your shot is back — try again in a minute.";
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
