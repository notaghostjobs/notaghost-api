// The QA Workday-pause check, without a network: run by hand.
//   BENCH_TOKEN_FILE=<file holding the token> npx tsx src/selfcheck/wdpause.ts
process.env.GHOSTED_ENV = "qa"; process.env.WA_TOKEN = "qa-simulated"; process.env.QA_PUBLIC_URL = "https://ghosted-qa-api.example"; process.env.SUPABASE_URL = "https://qaqaqaqaqaqaqaqaqaqa.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "selfcheck";
import { readFileSync } from "node:fs";
const sent: string[] = []; globalThis.fetch = (async (u: any) => { sent.push(String(u?.url ?? u)); return new Response("{}", { status: 200 }); }) as any;
const { installWorkdayPause } = await import("../lib/workdayPause.js"); installWorkdayPause();
const { wdPauseRoutes } = await import("../qa/wdpause.js");
const tok = readFileSync(process.env.BENCH_TOKEN_FILE!, "utf8").trim(); const app = wdPauseRoutes();
let failed = 0; const ok = (n: string, c: boolean, d: unknown = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${c ? "" : " — " + JSON.stringify(d)}`); if (!c) failed++; };
console.log("Workday pause QA check self-check");
ok("no token: 404", (await app.request("/workday-pause-check")).status === 404);
delete process.env.WORKDAY_PAUSED; ok("switch unset: refuses to run (409)", (await app.request("/workday-pause-check", { headers: { "x-bench-token": tok } })).status === 409 && sent.length === 0);
process.env.WORKDAY_PAUSED = "true"; const j: any = await (await app.request("/workday-pause-check", { headers: { "x-bench-token": tok } })).json();
ok("switch set: every path passes, nothing sent", j.all_passed === true && sent.filter((u) => /myworkday/.test(u)).length === 0, j);
console.log(failed ? `${failed} failed` : "all passed"); process.exit(failed ? 1 : 0);
