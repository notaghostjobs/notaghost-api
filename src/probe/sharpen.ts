// The Sharpen flow probe (11 Nov): the product the way a paying person meets it, walked by a machine after every deploy
// and nightly. The probe account (the same +910000000000 Radar's probe uses) carries a real résumé; a live posting that
// Radar put on that account's own list is the job; a plan is written as if paid; then, through the app's own request
// handler exactly as the web does: POST /preview → POST /shots → GET /shots/:id every five seconds until done → the
// checks below on the output. Anything a person would object to on the delivered page is a failure here first.
import { randomUUID } from "node:crypto";
import { db } from "../lib/db.js";
import { createSession } from "../lib/auth.js";

export const PROBE_PHONE = "+910000000000";
export type SharpenProbe = { at: string; ok: boolean; ms: number; status: string; posting: string; before: number | null; after: number | null; problems: string[]; commit?: string | null };
type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

const kv = {
  async get<T>(key: string): Promise<T | null> { const { data } = await db.from("reader_control").select("value").eq("key", key).maybeSingle(); return (data?.value as T) ?? null; },
  async set(key: string, value: unknown) { await db.from("reader_control").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" }); },
};
export const SHARPEN_FLOW_KEY = "sharpen:flow:last";
export async function sharpenFlowLast(): Promise<SharpenProbe | null> { return kv.get<SharpenProbe>(SHARPEN_FLOW_KEY); }

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export async function sharpenProbe(app: App): Promise<SharpenProbe> {
  const t0 = Date.now(); const problems: string[] = []; let posting = "";
  const out = (status: string, before: number | null = null, after: number | null = null): SharpenProbe => ({ at: new Date().toISOString(), ok: problems.length === 0, ms: Date.now() - t0, status, posting, before, after, problems });
  try {
    const { data: u, error: uerr } = await db.from("users").upsert({ phone: PROBE_PHONE, last_seen_at: new Date().toISOString() }, { onConflict: "phone" }).select("id").single();
    if (!u) { problems.push(`probe account: ${uerr?.message ?? "no row"}`); return out("none"); }
    // the résumé: the one the Radar probe left on this account (it copies the newest real résumé); else the newest real one
    let { data: res } = await db.from("resumes").select("id, parsed").eq("user_id", u.id).eq("is_current", true).maybeSingle();
    if (!res?.parsed) {
      const { data: rows } = await db.from("resumes").select("id, parsed, text").not("parsed", "is", null).order("created_at", { ascending: false }).limit(20);
      const src = (rows ?? []).find((r: any) => r.parsed?.roles?.length && r.parsed?.name);
      if (!src) { problems.push("no résumé to probe with"); return out("none"); }
      const ins = await db.from("resumes").insert({ id: randomUUID(), user_id: u.id, storage_path: `probe/${src.id}`, filename: "probe.pdf", parsed: src.parsed, text: src.text ?? null, is_current: true }).select("id, parsed").single();
      if (ins.error || !ins.data) { problems.push(`probe résumé: ${ins.error?.message ?? "not written"}`); return out("none"); }
      res = ins.data;
    }
    // the posting: the first line of the Radar probe's own list (a live posting the account is a fit for), else any live
    // Bengaluru posting with a full description
    const run = await kv.get<{ items?: { url?: string; title?: string; company?: string }[] }>(`radar:run:${u.id}`);
    const first = (run?.items ?? []).find((i) => i.url && i.title);
    let text = "", url = first?.url ?? "";
    if (url) { const { data: s } = await db.from("sightings").select("description, title, company_name").eq("url", url).maybeSingle(); text = String(s?.description ?? ""); posting = `${first!.title} — ${first!.company}`; }
    if (text.length < 800) {
      const { data: s } = await db.from("sightings").select("url, description, title, company_name").eq("blr", true).is("gone_at", null).not("description", "is", null).order("first_seen", { ascending: false }).limit(50);
      const pick = (s ?? []).find((x: any) => String(x.description ?? "").length >= 1500);
      if (!pick) { problems.push("no posting with a full description"); return out("none"); }
      url = pick.url; text = pick.description; posting = `${pick.title} — ${pick.company_name}`;
    }
    // a plan, as if paid: one shot, a day
    await db.from("plans").update({ expires_at: new Date().toISOString() }).eq("user_id", u.id).gt("expires_at", new Date().toISOString());
    const { error: perr } = await db.from("plans").insert({ user_id: u.id, product: "sharpen", shots_total: 1, resume_name: (res.parsed as any)?.name ?? null, expires_at: new Date(Date.now() + 86400e3).toISOString() });
    if (perr) { problems.push(`probe plan: ${perr.message}`); return out("none"); }

    const token = await createSession(u.id);
    const H = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-ghosted-src-first": "probe", "x-ghosted-src-last": "probe" };   // the funnel files these under "probe", never a channel
    const call = async <T,>(path: string, init: RequestInit = {}) => { const r = await app.request(path, { ...init, headers: { ...H, ...(init.headers as any ?? {}) } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path} → HTTP ${r.status} ${(j as any).error ?? ""}`); return j as T; };

    // 1. the preview, as the web asks for it (pasted text: the reader's copy of the live page)
    const pv = await call<{ preview_id: string | null; fits?: string; matches?: any[]; score?: number; posting?: { title: string; company: string } }>("/preview", { method: "POST", body: JSON.stringify({ posting_text: text }) });
    if (!pv.preview_id) problems.push("preview returned no id");
    // 2. the shot
    const sh = await call<{ shot: { id: string } }>("/shots", { method: "POST", body: JSON.stringify({ product: "sharpen", posting_text: text, preview_id: pv.preview_id ?? undefined }) });
    const id = sh.shot?.id; if (!id) { problems.push("no shot id"); return out("error"); }
    let shot: any = { status: "queued" }; const started = Date.now();
    while (Date.now() - started < 8 * 60e3) { await new Promise((r) => setTimeout(r, 5000)); shot = (await call<{ shot: any }>(`/shots/${id}`)).shot; if (shot.status === "done" || shot.status === "failed") break; }
    if (shot.status !== "done") { problems.push(`shot status "${shot.status}" after ${Math.round((Date.now() - started) / 1000)}s${shot.error ? ` (${shot.error})` : ""}`); return out(shot.status); }

    // 3. the delivered page's facts
    const o = shot.output ?? {}; const rw = o.rewrite ?? {};
    const before = typeof o.before === "number" ? o.before : null, after = typeof o.after === "number" ? o.after : null;
    if (!rw.headline || !rw.summary || !Array.isArray(rw.roles) || !rw.roles.length) problems.push("document missing headline, summary or roles");
    if (after !== null && o.promised !== undefined && after < o.promised) problems.push(`delivered ${after} below the promised ${o.promised}`);
    if (o.verification && o.verification.ok === false) problems.push(`verification left ${o.verification.problems?.length ?? "?"} unsupported claims`);
    const note = String(rw.referral_note ?? "");
    if (!note) problems.push("no referral note"); else if (note.length > 200) problems.push(`referral note is ${note.length} characters (LinkedIn stops at 200)`);
    // every "what changed" line must be findable in the document: either its quote-like words are in AFTER, or it names a removal
    const hay = norm(JSON.stringify({ headline: rw.headline, summary: rw.summary, relevant: rw.relevant, roles: rw.roles, skills: rw.skills, extra_sections: rw.extra_sections }));
    const changes: { what: string; why: string }[] = Array.isArray(rw.changes) ? rw.changes : [];
    if (!changes.length) problems.push("no 'what changed' lines");
    for (const ch of changes) {
      const words = norm(ch.what ?? "").split(" ").filter((w) => w.length > 3);
      const quoted = (ch.what ?? "").match(/[“"]([^”"]{12,})[”"]/g) ?? [];
      const quotesOk = quoted.length ? quoted.every((q) => hay.includes(norm(q.slice(1, -1)).split(" ").slice(0, 6).join(" "))) : true;
      const removal = /\b(removed|dropped|cut|deleted|trimmed|took out|left out)\b/i.test(ch.what ?? "");
      if (!quotesOk && !removal) problems.push(`"what changed" line not in the document: ${String(ch.what).slice(0, 90)}`);
      if (!words.length) problems.push("empty 'what changed' line");
    }
    // 4. the PDF link the WhatsApp carries
    const pdf = await app.request(`/shots/${id}/pdf-link`, { headers: H });
    if (!pdf.ok) problems.push(`pdf link HTTP ${pdf.status}`);
    return out("done", before, after);
  } catch (e) { problems.push(`probe error: ${(e as Error).message.slice(0, 200)}`); return out("error"); }
}
