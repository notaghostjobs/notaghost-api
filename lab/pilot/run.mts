// The AI job-reading pilot client. Sends one posting per request through the QA pass-through (the key never leaves the
// QA service), records tokens and cost, checks every quote against the posting, and writes records. Resumable: a
// posting already done for this model and prompt version is not sent again.
//   BENCH_PROXY=https://.../qa/bench/messages BENCH_TOKEN_FILE=... npx tsx lab/pilot/run.mts <model> <partition[,partition]> <outdir> [limit] [maxInr]
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
import { readFileSync, appendFileSync, existsSync } from "node:fs"; import { createHash } from "node:crypto";
const { postingProblem } = await import("../../src/lib/textfit.js"); const { cleanTitle } = await import("../../src/radar/v2.js");
const { INSTRUCTIONS, JOBREAD_V } = await import("./prompt.js");
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const [model, parts, out, limitS, maxS] = process.argv.slice(2); const limit = Number(limitS ?? 0) || Infinity, maxInr = Number(maxS ?? 999);
const PRICE: any = { "claude-haiku-5-5": { in: 0.10, out: 0.50, cr: 0.01, cw: 0.125 }, "claude-sonnet-5-5": { in: 2, out: 10, cr: 0.10, cw: 2.5 } };
const inr = (u: any) => { const p = PRICE[model]; return (((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + (u.cache_read_input_tokens ?? 0) * p.cr + (u.cache_creation_input_tokens ?? 0) * p.cw) / 1e6) * 90; };
const ont = readFileSync(`${S}/labels7dev/ontology-list.txt`, "utf8"); const system = INSTRUCTIONS + "\n\nThe list:\n" + ont;
const pv = createHash("sha256").update(system).digest("hex").slice(0, 12);
const sample = JSON.parse(readFileSync(`${S}/arch/sample1000.json`, "utf8")).rows.filter((r: any) => parts.split(",").includes(r.partition));
const inv = new Map(readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [String(r.id), r]; }));
const file = `${out}/ai-${model}-${pv}.jsonl`; const done = new Set(existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
let spent = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).reduce((a, l) => a + (JSON.parse(l).inr ?? 0), 0) : 0;
const todo = sample.filter((r: any) => !done.has(r.id)).slice(0, limit);
console.log(`${model} prompt ${pv}: ${todo.length} to do, ${done.size} done, ₹${spent.toFixed(2)} spent so far in this file`);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function one(r: any) {
  const raw: any = inv.get(r.id); const v = postingProblem(raw.title, raw.description); const text = v.text.slice(0, 6000);
  const body = { model, max_tokens: model.includes("haiku") ? 4000 : 1500, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: `Title: ${cleanTitle(raw.title)}\nEmployer: ${raw.company_name}\nLocation: ${raw.location ?? ""}\n\nPosting:\n${text}` }] };
  const t0 = Date.now(); let res: any, status = 0;
  for (let k = 0; k < 3; k++) { const h = await fetch(process.env.BENCH_PROXY!, { method: "POST", headers: { "content-type": "application/json", "x-bench-token": readFileSync(process.env.BENCH_TOKEN_FILE!, "utf8").trim() }, body: JSON.stringify(body) }); status = h.status; res = await h.json().catch(() => null); if (status === 200 || status === 400 || status === 503) break; await new Promise((z) => setTimeout(z, 3000 * (k + 1))); }
  const ms = Date.now() - t0; if (status !== 200) return { id: r.id, partition: r.partition, model, pv, ok: false, status, err: JSON.stringify(res).slice(0, 300), ms, inr: 0 };
  const txt = (res.content ?? []).map((c: any) => c.text ?? "").join(""); let rec: any = null; try { rec = JSON.parse(txt.replace(/^```(json)?|```$/g, "").trim()); } catch {}
  // grounding check: every quote must appear in the posting
  const hay = norm(`${cleanTitle(raw.title)} ${text}`); let quotes = 0, found = 0;
  const walk = (x: any) => { if (!x || typeof x !== "object") return; if (typeof x.quote === "string" && x.quote) { quotes++; if (hay.includes(norm(x.quote))) found++; else x.quote_missing = true; } for (const k in x) walk(x[k]); };
  walk(rec);
  const cost = inr(res.usage ?? {});
  return { id: r.id, partition: r.partition, model, pv, ok: !!rec, ms, usage: res.usage, inr: cost, quotes, quotes_found: found, rec, raw_text: rec ? undefined : txt.slice(0, 500) };
}
let i = 0; const workers = Array.from({ length: 3 }, async () => { while (i < todo.length) { if (spent >= maxInr) { console.log("stop: run limit reached"); return; } const r = todo[i++]; const x = await one(r); spent += x.inr; appendFileSync(file, JSON.stringify(x) + "\n"); if (!x.ok) console.log("fail", r.id, x.status, x.err ?? x.raw_text); } });
await Promise.all(workers);
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ok = rows.filter((x) => x.ok); const sum = (f: (x: any) => number) => ok.reduce((a, x) => a + f(x), 0);
console.log(JSON.stringify({ model, pv, rows: rows.length, ok: ok.length, inr_total: +spent.toFixed(2), inr_per_posting: +(sum((x) => x.inr) / Math.max(1, ok.length)).toFixed(3), in_tokens: Math.round(sum((x) => x.usage.input_tokens) / ok.length), cache_read: Math.round(sum((x) => x.usage.cache_read_input_tokens ?? 0) / ok.length), out_tokens: Math.round(sum((x) => x.usage.output_tokens) / ok.length), thinking: Math.round(sum((x) => x.usage.output_tokens_details?.thinking_tokens ?? 0) / ok.length), quotes_found_pct: +(100 * sum((x) => x.quotes_found) / Math.max(1, sum((x) => x.quotes))).toFixed(1), ms_median: ok.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] }));
