// The IBM probe's safeguards, without a database or the network. Run by hand:
//   BENCH_TOKEN_FILE=<file holding the token> npx tsx src/selfcheck/ibmprobe.ts
process.env.GHOSTED_ENV = "qa"; process.env.WA_TOKEN = "qa-simulated"; process.env.QA_PUBLIC_URL = "https://ghosted-qa-api.example"; process.env.SUPABASE_URL = "https://qaqaqaqaqaqaqaqaqaqa.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "selfcheck";
import { readFileSync } from "node:fs";
const { ibmProbeRoutes, measure, PROBE_KEY } = await import("../qa/ibmprobe.js");
let failed = 0; const ok = (n: string, p: boolean, d: unknown = "") => { console.log(`  ${p ? "✓" : "✗"} ${n}${p ? "" : ` — ${JSON.stringify(d)}`}`); if (!p) failed++; };
const tok = readFileSync(process.env.BENCH_TOKEN_FILE!, "utf8").trim();
const full = "<p>Introduction</p><p>Your role and responsibilities</p><p>As a Data Engineer you will design and run pipelines on Azure for clients, own data quality and work with architects.</p><p>Required technical and professional expertise</p><ul><li>5+ years data engineering</li><li>SQL, PySpark, Azure Synapse</li></ul><p>Preferred technical and professional experience</p><p>Databricks certification and experience in banking data platforms, migration of legacy warehouses and streaming with Kafka.</p>";
const resp = (desc: any) => ({ ok: true, status: 200, data: { hits: { total: { value: 2400 }, hits: [{ _id: "x", _source: { url: "https://careers.ibm.com/careers/JobDetail?jobId=138171", title: "Data Engineer", description: desc } }] } } });
console.log("IBM probe self-check");
const m = measure(resp(full)).jobs[0];
ok("a full description is measured as kept, with responsibilities and requirements", m.job_id === "138171" && m.kept_by_fix && m.has_responsibilities && m.has_requirements && m.shell === null, m);
const s = measure(resp("Design data pipelines on Azure…")).jobs[0];
ok("a snippet is not kept and is flagged as cut off", !s.kept_by_fix && s.ends_with_ellipsis, s);
ok("a missing description is reported as missing", measure(resp(undefined)).jobs[0].description_type === "undefined");
let calls = 0; const kv = new Map<string, any>();
const app = ibmProbeRoutes({ search: async () => { calls++; return resp(full); }, get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); } });
const call = (t?: string) => app.request("/ibm-probe", { headers: t ? { "x-bench-token": t } : {} });
ok("no token: 404 and no request", (await call()).status === 404 && calls === 0);
ok("wrong token: 404 and no request", (await call("a".repeat(64))).status === 404 && calls === 0);
const [a, b] = await Promise.all([call(tok), call(tok)]);
ok("two calls at once: one outbound request", a.status === 200 && b.status === 200 && calls === 1, calls);
const again = await (await call(tok)).json();
ok("later calls return the stored result and send nothing", calls === 1 && again.repeat === true && again.result.jobs[0].job_id === "138171");
ok("only the probe's own key is written", [...kv.keys()].join() === PROBE_KEY);
const kv2 = new Map<string, any>([[PROBE_KEY, { claimed_at: "t", result: null }]]); let calls2 = 0;
const app2 = ibmProbeRoutes({ search: async () => { calls2++; return resp(full); }, get: async (k) => kv2.get(k) ?? null, set: async (k, v) => { kv2.set(k, v); } });
ok("a claimed probe that never finished is not retried", (await app2.request("/ibm-probe", { headers: { "x-bench-token": tok } })).status === 200 && calls2 === 0);
console.log(failed ? `${failed} failed` : "all passed"); process.exit(failed ? 1 : 0);
