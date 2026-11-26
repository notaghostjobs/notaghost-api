// QA validation of the 72-hour freshness gate (26 Nov 2026), behind the pilot token; single use (a repeat returns the
// stored result); closes with the pilot. It runs in QA's own process against QA's own database and sends nothing outside.
//   1. snapshot every sighting's last_seen and gone_at;
//   2. Radar's pool with FRESH_HOURS=0 (gate off) and FRESH_HOURS=72;
//   3. reconfirm one small fixture feed the way a successful read does: the Reader's own recordFeed(), as a partial read
//      (so nothing is marked gone), with the rows' own current fields — the only write to sightings in the whole check;
//   4. the pool again: only the reconfirmed rows come back;
//   5. a stored Radar list (a QA test account, no labels, refreshed now so the morning finds nothing new and makes no
//      model call): what the page shows, then the morning refresh, then the page again;
//   6. MCP get_job for a reconfirmed, a held and a closed row;
//   7. the snapshot again: the rows that changed must be exactly the reconfirmed ones; the test account is removed.
import { Hono } from "hono";
import { allowed } from "./bench.js";
import { store } from "./state.js";
import { db } from "../lib/db.js";
import { createSession } from "../lib/auth.js";
import { recordFeed } from "../reader/read.js";
import { livePool, refreshRadar, radar } from "../routes/radar.js";
import { mcp } from "../routes/mcp.js";
import { qaPoolMode, isFixtureUrl } from "./pool.js";

export const FRESH_KEY = "qa:probe:fresh-gate-2";   // run 1 (qa:probe:fresh-gate) stopped at the test account: resumes.storage_path is required
const TEST_PHONE = "+910000000072";   // QA-only test account, removed at the end
type Snap = Map<number, string>;

async function snapshot(): Promise<Snap> {
  const m: Snap = new Map();
  for (let from = 0; from < 200000; from += 1000) {
    const { data, error } = await db.from("sightings").select("id, last_seen, gone_at").order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`snapshot: ${error.message}`);
    for (const r of data ?? []) m.set(Number((r as any).id), `${(r as any).last_seen}|${(r as any).gone_at}`);
    if (!data || data.length < 1000) break;
  }
  return m;
}
async function poolWith(hours: string) { process.env.FRESH_HOURS = hours; return livePool(); }   // the cache is keyed on the setting

export function freshCheckRoutes() {
  const r = new Hono(); let running: Promise<any> | null = null;
  r.get("/fresh-check", async (c) => {
    if (!allowed(c.req.header("x-bench-token"))) return c.json({ error: "not available" }, 404);
    const done = await store.get(FRESH_KEY); if (done) return c.json({ ...done, repeat: true });
    running ??= (async () => {
      await store.set(FRESH_KEY, { claimed_at: new Date().toISOString() });
      const before = process.env.FRESH_HOURS; const out: any = { at: new Date().toISOString(), db_project: (process.env.SUPABASE_URL ?? "").replace(/^https:\/\/([^.]+)\..*$/, "$1"), checks: [] };
      const check = (name: string, pass: boolean, detail: unknown) => out.checks.push({ name, pass, detail });
      let uid: string | null = null;
      try {
        const mode = await qaPoolMode(); out.pool_mode = mode;
        const snap0 = await snapshot(); out.sightings_total = snap0.size;
        // 2. gate off / on
        const off0 = await poolWith("0"), on0 = await poolWith("72");
        const { count: openInMode } = await db.from("sightings").select("*", { count: "exact", head: true }).eq("blr", true).is("gone_at", null);
        out.pool = { gate_off: off0.length, gate_on: on0.length, open_bengaluru_rows_all_modes: openInMode };
        const staleOn = on0.length === 0 ? off0.length : off0.filter((s) => !on0.some((x) => x.id === s.id)).length;
        check("FRESH_HOURS=0: the pool is every open Bengaluru row in this pool mode (the old behaviour)", off0.length > 0, { gate_off: off0.length });
        check("FRESH_HOURS=72: rows not confirmed for 72 h are held (QA's rows were last read on 14 Nov)", on0.length < off0.length, { gate_on: on0.length, held: staleOn });
        // 3. reconfirm one small feed, as a successful read would
        const groups = new Map<string, any[]>();
        const { data: rows } = await db.from("sightings").select("id, source, source_id, employer_key, company_name, title, location, url, posted_at, updated_at_src, posted_text, blr, gone_at").eq("blr", true).is("gone_at", null).eq("source", "greenhouse").limit(5000);
        for (const s of (rows ?? []) as any[]) { if (mode && isFixtureUrl(s.url) !== (mode === "fixtures")) continue; const ref = String(s.source_id).split(":")[0]; const g = groups.get(ref) ?? []; g.push(s); groups.set(ref, g); }
        const pick = [...groups.entries()].filter(([, g]) => g.length >= 3).sort((a, b) => a[1].length - b[1].length)[0];
        if (!pick) throw new Error("no greenhouse feed with 3+ open rows in this pool mode");
        const [ref, feedRows] = pick;
        const { data: emp } = await db.from("employers").select("key, name, ats, ats_ref").eq("ats", "greenhouse").eq("ats_ref", ref).limit(1).maybeSingle();
        const e = { ...(emp ?? { key: feedRows[0].employer_key, ats: "greenhouse", ats_ref: ref }), name: feedRows[0].company_name };   // the rows' own name: recordFeed rewrites nothing but last_seen
        const feed: any = { system: "greenhouse", ref, company_name: feedRows[0].company_name, partial: true,
          jobs: feedRows.map((s) => ({ id: String(s.source_id).slice(ref.length + 1), title: s.title, location: s.location, url: s.url, posted_at: s.posted_at, updated_at: s.updated_at_src, posted_text: s.posted_text })) };
        const rec = await recordFeed(e as any, feed);
        const reIds = feedRows.map((s) => Number(s.id)).sort((a, b) => a - b);
        out.reconfirmed = { feed: `greenhouse:${ref}`, rows: reIds.length, result: rec };
        // 4. the pool again (switching the setting rebuilds the cache)
        await poolWith("0"); const on1 = await poolWith("72");
        const on1Ids = on1.map((s) => s.id).sort((a, b) => a - b);
        check("reconfirmed rows return at once; nothing else becomes eligible", JSON.stringify(on1Ids) === JSON.stringify([...new Set([...on0.map((s) => s.id), ...reIds])].sort((a, b) => a - b)), { gate_on_after: on1.length, reconfirmed: reIds.length });
        const off1 = await poolWith("0");
        check("gate off again: identical to before", off1.length === off0.length, { before: off0.length, after: off1.length });
        // 5. a stored Radar list
        const held = off0.find((s) => !reIds.includes(s.id) && !on1Ids.includes(s.id));
        const { data: goneRow } = await db.from("sightings").select("id, title, company_name, location, url, first_seen").eq("blr", true).not("gone_at", "is", null).limit(50);
        const closed = ((goneRow ?? []) as any[]).find((g) => !mode || isFixtureUrl(g.url) === (mode === "fixtures")) ?? null;
        const fresh = on1.find((s) => reIds.includes(s.id))!; if (!held || !fresh) throw new Error("no held or no fresh row to put on the test list");
        const it = (s: any) => ({ sighting_id: s.id, title: s.title, company: s.company_name ?? "", location: s.location ?? "", url: s.url, posted_at: s.posted_at ?? null, first_seen: s.first_seen, why: "QA freshness check" });
        const { data: u, error: ue } = await db.from("users").upsert({ phone: TEST_PHONE, last_seen_at: new Date().toISOString() }, { onConflict: "phone" }).select("id").single(); if (ue || !u) throw new Error(`test account: ${ue?.message ?? "no row"}`); uid = (u as any).id;
        const { data: res, error: re } = await db.from("resumes").insert({ user_id: uid, storage_path: "qa/fresh-check/none", filename: "qa-fresh.txt", is_current: true, parsed: { name: "QA-FRESH", years_total: 3, roles: [{ title: "Analyst" }] } }).select("id").single(); if (re || !res) throw new Error(`test resume: ${re?.message ?? "no row"}`);
        const nowIso = new Date().toISOString();
        const run = { status: "done", resume_id: (res as any).id, started: nowIso, finished: nowIso, refreshed: nowIso, answers: { titles: ["Analyst"], level: "mid", avoid: [], stretch: false },
          items: [it(fresh), it(held), ...(closed ? [it(closed)] : [])], seen: [fresh.id, held!.id, ...(closed ? [closed.id] : [])] };
        const { error: we } = await db.from("reader_control").upsert([{ key: `radar:run:${uid}`, value: run, updated_at: nowIso }, { key: `radar:unlock:${uid}`, value: { by: "qa fresh-check" }, updated_at: nowIso }], { onConflict: "key" }); if (we) throw new Error(`test list: ${we.message}`);
        const tok = await createSession(uid!);
        const view = async () => { const r = await radar.request("/test/result", { headers: { authorization: `Bearer ${tok}` } }); const j: any = await r.json(); return (j.items ?? []).map((i: any) => i.sighting_id).sort((a: number, b: number) => a - b); };
        const v1 = await view();
        check("stored list, served before any refresh: the held role is hidden at once; the fresh role shows (a closed role is left to the morning, as before)", v1.includes(fresh.id) && !v1.includes(held!.id), { shown: v1, fresh: fresh.id, held: held!.id, closed: closed?.id ?? null });
        process.env.FRESH_HOURS = "72";
        const m = await refreshRadar(uid!);
        const { data: after } = await db.from("reader_control").select("value").eq("key", `radar:run:${uid}`).maybeSingle();
        const av: any = after?.value ?? {}; const byId = new Map((av.items ?? []).map((i: any) => [i.sighting_id, i]));
        check("morning refresh: the held role stays on the list, held, and is not reported gone", (byId.get(held!.id) as any)?.held === true && !(av.gone ?? []).some((g: any) => g.sighting_id === held!.id), { items: (av.items ?? []).map((i: any) => [i.sighting_id, !!i.held]), gone: (av.gone ?? []).map((g: any) => g.sighting_id), refresh: m });
        if (closed) check("morning refresh: the closed role leaves as gone", !byId.has(closed.id) && (av.gone ?? []).some((g: any) => g.sighting_id === closed.id), { gone: (av.gone ?? []).map((g: any) => g.sighting_id) });
        check("morning refresh: the fresh role stays shown", byId.has(fresh.id) && !(byId.get(fresh.id) as any)?.held, { fresh: byId.get(fresh.id) ?? null });
        const v2 = await view();
        check("the page after the morning: fresh role only", JSON.stringify(v2) === JSON.stringify([fresh.id]), { shown: v2 });
        // 6. MCP get_job
        const job = async (id: number) => { const r = await mcp.request("/", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_job", arguments: { job_id: id } } }) }); const t = await r.text(); const mm = t.match(/\{[\s\S]*\}/); const j = mm ? JSON.parse(mm[0]) : null; return { status: j?.result?.structuredContent?.status ?? null, text: (j?.result?.content ?? []).map((x: any) => x.text).join(" ").slice(0, 400) }; };
        const gF = await job(fresh.id), gH = await job(held!.id), gC = closed ? await job(closed.id) : null;
        check("MCP get_job: fresh = live, held = not_confirmed (with the check-the-employer line), closed = closed", gF.status === "live" && gH.status === "not_confirmed" && /check the employer/i.test(gH.text) && (!gC || gC.status === "closed"), { fresh: gF, held: gH, closed: gC });
        // 7. what changed in sightings
        const snap1 = await snapshot(); const changed: number[] = [];
        for (const [id, v] of snap1) if (snap0.get(id) !== v) changed.push(id);
        changed.sort((a, b) => a - b);
        out.sightings_changed = changed.length;
        check("sightings: the only rows changed are the ones the Reader reconfirmed (last_seen); nothing closed, nothing else touched", JSON.stringify(changed) === JSON.stringify(reIds) && snap1.size === snap0.size, { changed: changed.length, reconfirmed: reIds.length, total_before: snap0.size, total_after: snap1.size });
      } catch (e) { out.error = (e as Error).message; }
      finally {
        if (before === undefined) delete process.env.FRESH_HOURS; else process.env.FRESH_HOURS = before;
        if (uid) { await db.from("reader_control").delete().in("key", [`radar:run:${uid}`, `radar:unlock:${uid}`, `radar:seen:${uid}`]); await db.from("sessions").delete().eq("user_id", uid); await db.from("resumes").delete().eq("user_id", uid); await db.from("users").delete().eq("id", uid); out.test_account_removed = true; }
      }
      out.all_passed = !out.error && out.checks.length > 0 && out.checks.every((x: any) => x.pass);
      await store.set(FRESH_KEY, out); return out;
    })();
    return c.json(await running);
  });
  return r;
}
