// The Greenhouse fallback test's safeguards, without a database or the network. Run by hand:
//   BENCH_TOKEN_FILE=<file holding the token> npx tsx src/selfcheck/ghprobe.ts
process.env.GHOSTED_ENV = "qa"; process.env.WA_TOKEN = "qa-simulated"; process.env.QA_PUBLIC_URL = "https://ghosted-qa-api.example"; process.env.SUPABASE_URL = "https://qaqaqaqaqaqaqaqaqaqa.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "selfcheck";
import { readFileSync } from "node:fs";
const { ghProbeRoutes, measureJob, GH_JOBS, GH_KEY } = await import("../qa/ghprobe.js");
let failed = 0; const ok = (n: string, p: boolean, d: unknown = "") => { console.log(`  ${p ? "✓" : "✗"} ${n}${p ? "" : ` — ${JSON.stringify(d)}`}`); if (!p) failed++; };
const tok = readFileSync(process.env.BENCH_TOKEN_FILE!, "utf8").trim();
const content = "&lt;p&gt;&lt;strong&gt;What you'll do&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Lead the evaluation engineering team, own the roadmap for model evaluation and hire engineers.&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;&lt;strong&gt;Requirements&lt;/strong&gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;8+ years of engineering, 2+ managing teams; Python and distributed systems; R&amp;amp;D experience.&lt;/li&gt;&lt;/ul&gt;";
const ans = (title: string, c: string | null) => ({ ok: true, status: 200, data: { title, content: c, location: { name: "Bangalore" }, updated_at: "2026-11-20T00:00:00Z" } });
console.log("Greenhouse fallback test self-check");
const m = measureJob(GH_JOBS[0], ans("Senior Engineering Manager - Evaluation", content));
ok("real content: measured as text with duties and requirements, no shell, title matches", m.text_length > 150 && m.has_responsibilities && m.has_requirements && m.shell === null && m.title_matches && m.text.includes("R&D"), m);
const f = measureJob(GH_JOBS[1], ans("Other title", "Apply for this job * indicates a required field First Name *"));
ok("a form or another title is reported as such", f.shell === "application form only" && !f.title_matches);
ok("no content is reported as empty", measureJob(GH_JOBS[2], ans("x", null)).text_length === 0);
let calls = 0; const kv = new Map<string, any>();
const app = ghProbeRoutes({ fetchJob: async () => { calls++; return ans("t", content); }, get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); } });
const call = (t?: string) => app.request("/greenhouse-probe", { headers: t ? { "x-bench-token": t } : {} });
ok("no token or a wrong one: 404 and no request", (await call()).status === 404 && (await call("b".repeat(64))).status === 404 && calls === 0);
await Promise.all([call(tok), call(tok)]);
ok("two calls at once: exactly four job requests", calls === 4, calls);
const again = await (await call(tok)).json();
ok("later calls send nothing and return the stored result", calls === 4 && again.repeat === true && again.jobs.length === 4);
ok("only the test's own key is written", [...kv.keys()].join() === GH_KEY);
console.log(failed ? `${failed} failed` : "all passed"); process.exit(failed ? 1 : 0);
