// Read-only audit of the page-read signals against the stored page text. For each posting: the lines the card showed,
// what the rule extractor says now, and an independent model read of the page. A disagreement is a defect to fix.
import { Hono } from "hono";
import { db } from "../lib/db.js";
import { json, FAST } from "../engine/claude.js";
import { extractFactsRules, payStated } from "../engine/ghost/read.js";

export const audit = new Hono();

const PAGE_SIGNALS: Record<number, string> = { 1: "pay band stated (a salary/CTC figure or range for THIS role)", 2: "templated description (could be any company; no product, team, manager or specific work named)", 3: "catch-all location (three or more cities, or remote plus cities, on this ONE posting)", 4: "evergreen language (talent community/pool, future opportunities, always looking, multiple openings across levels)", 5: "kitchen-sink requirements (unrelated stacks lumped together, 15+ must-haves, or a senior title asking ≤2 years)", 6: "off-system apply route (email a CV, DM/WhatsApp/Telegram, or an unrelated external form)", 15: "posted by an agency / staffing firm for an unnamed client", 20: "asks for money, fees, deposits or personal documents (Aadhaar, PAN, passport) to apply" };

audit.get("/signals", async (c) => {
  const limit = Math.min(300, Number(c.req.query("limit") ?? 200));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const { data: rows } = await db.from("postings").select("id, url, title, company, raw_text, facts, signals, verdict, scored_at").not("scored_at", "is", null).not("raw_text", "is", null).order("scored_at", { ascending: false }).range(offset, offset + limit - 1);
  const out: any[] = [];
  const stats: Record<string, { shown: number; disagree: number; examples: any[] }> = {};
  const bump = (k: string, bad: boolean, ex: any) => { const s = (stats[k] ??= { shown: 0, disagree: 0, examples: [] }); s.shown++; if (bad) { s.disagree++; if (s.examples.length < 5) s.examples.push(ex); } };
  // independent read: ask the model yes/no per signal from the text alone, 8 postings per call
  const batches: any[][] = []; for (let i = 0; i < (rows ?? []).length; i += 8) batches.push(rows!.slice(i, i + 8));
  for (const b of batches) {
    let reads: Record<string, Record<string, boolean>> = {};
    try {
      const r = await json<{ items: { id: string; s1: boolean; s2: boolean; s3: boolean; s4: boolean; s5: boolean; s6: boolean; s15: boolean; s20: boolean }[] }>(
        `You read job postings and answer yes/no questions about what is LITERALLY in the text. Never infer. For each posting answer: s1 ${PAGE_SIGNALS[1]}; s2 ${PAGE_SIGNALS[2]}; s3 ${PAGE_SIGNALS[3]}; s4 ${PAGE_SIGNALS[4]}; s5 ${PAGE_SIGNALS[5]}; s6 ${PAGE_SIGNALS[6]}; s15 ${PAGE_SIGNALS[15]}; s20 ${PAGE_SIGNALS[20]}. Revenue, GMV, order counts or funding amounts are NOT pay. Answer every id.`,
        `POSTINGS:\n${JSON.stringify(b.map((p: any) => ({ id: p.id, text: String(p.raw_text).slice(0, 6000) })))}\n\nReturn: {items:[{id,s1,s2,s3,s4,s5,s6,s15,s20}]}`, 2000, FAST);
      for (const it of r.items ?? []) reads[it.id] = { 1: !!it.s1, 2: !!it.s2, 3: !!it.s3, 4: !!it.s4, 5: !!it.s5, 6: !!it.s6, 15: !!it.s15, 20: !!it.s20 } as any;
    } catch (e) { console.error("[audit] model", (e as Error).message); }
    for (const p of b) {
      const shown: Record<number, string> = {};
      for (const s of (p.signals ?? []) as any[]) if (PAGE_SIGNALS[s.n]) shown[s.n] = `${s.kind}:${[s.text, s.strong, s.tail].filter(Boolean).join(" ")}`;
      const rules = extractFactsRules({ text: p.raw_text, title: p.title, company: p.company } as any, p.url ?? "");
      const nowFired: Record<number, boolean> = { 1: payStated(p.raw_text), 2: rules.templated, 3: rules.locations_count >= 3, 4: rules.evergreen, 5: rules.kitchen_sink, 6: rules.apply_route === "email" || rules.apply_route === "dm" || rules.apply_route === "external_form", 15: rules.agency, 20: (rules.scam_tells ?? []).length > 0 };
      const read = reads[p.id] ?? {};
      const row: any = { id: p.id, title: p.title, company: p.company, verdict: p.verdict, lines: {} };
      for (const n of Object.keys(PAGE_SIGNALS).map(Number)) {
        if (!shown[n]) continue;
        // what the card asserted: for signal 1 "ok" means pay stated; for the rest "bad" means the flag fired
        const cardSays = n === 1 ? shown[n].startsWith("ok") : shown[n].startsWith("bad");
        const modelSays = (read as any)[n];
        const disagree = typeof modelSays === "boolean" && modelSays !== cardSays;
        row.lines[n] = { card: shown[n], card_asserts: cardSays, rules_now: nowFired[n], model_read: modelSays, disagree };
        bump(`s${n}`, disagree, { id: p.id, title: p.title, company: p.company, card: shown[n], model_read: modelSays });
      }
      out.push(row);
    }
  }
  const summary = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { label: PAGE_SIGNALS[Number(k.slice(1))], shown: v.shown, disagree: v.disagree, rate: v.shown ? Math.round((100 * v.disagree) / v.shown) : 0, examples: v.examples }]));
  return c.json({ postings: out.length, summary, detail: c.req.query("detail") ? out : undefined });
});
