// The benchmark pass-through's safeguards, without a database, a network or a model. Run by hand:
//   BENCH_TOKEN_FILE=<file holding the token> npx tsx src/selfcheck/bench.ts
process.env.GHOSTED_ENV = "qa"; process.env.WA_TOKEN = "qa-simulated"; process.env.QA_PUBLIC_URL = "https://ghosted-qa-api.example"; process.env.SUPABASE_URL = "https://qaqaqaqaqaqaqaqaqaqa.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "selfcheck";
import { readFileSync } from "node:fs";
const { refuse, gate, worstCase, allowed, benchRoutes, MAX_OUT, AT_ONCE } = await import("../qa/bench.js"); const { MODEL } = await import("../engine/claude.js");
let failed = 0; const ok = (name: string, pass: boolean, detail: unknown = "") => { console.log(`  ${pass ? "✓" : "✗"} ${name}${pass ? "" : ` — ${JSON.stringify(detail)}`}`); if (!pass) failed++; };
const good = () => ({ model: MODEL, max_tokens: 2600, system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }, { type: "text", text: "pinned résumé", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "postings" }] });
const but = (f: (b: any) => void) => { const b: any = good(); f(b); return refuse(b); };
console.log("Benchmark pass-through self-check");
ok("the engine's own request is accepted, with or without the pinned block", refuse(good()) === null && but((b) => b.system.pop()) === null);
ok("an unexpected top-level field is refused (tools, stream, metadata, temperature, tool_choice, thinking)", ["tools", "stream", "metadata", "temperature", "tool_choice", "thinking", "mcp_servers", "container"].every((k) => but((b) => (b[k] = k === "stream" ? true : [])) === "unexpected field"));
ok("another model is refused", but((b) => (b.model = "claude-opus-5-5")) === "model not allowed");
ok(`a reply allowance over ${MAX_OUT}, zero, or not a whole number is refused`, [MAX_OUT + 1, 0, -5, 2.5, "2600"].every((n) => but((b) => (b.max_tokens = n)) === "max_tokens not allowed"));
ok("system as a plain string, empty, or three blocks is refused", [(b: any) => (b.system = "x"), (b: any) => (b.system = []), (b: any) => b.system.push({ type: "text", text: "third" })].every((f) => but(f) !== null));
ok("a system block that is not text, or carries an extra field, is refused", but((b) => (b.system[0] = { type: "image", source: {} })) !== null && but((b) => (b.system[0].citations = [])) !== null && but((b) => (b.system[1].cache_control = { type: "ephemeral", ttl: "1h" })) !== null);
ok("more than one message, an assistant turn, or a system role is refused", but((b) => b.messages.push({ role: "assistant", content: "{" })) !== null && but((b) => (b.messages[0].role = "assistant")) !== null && but((b) => (b.messages[0].role = "system")) !== null);
ok("content that is not plain text is refused: a document, an image, a tool result, a block list", [[{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }], [{ type: "image", source: {} }], [{ type: "tool_result", tool_use_id: "x" }], [{ type: "text", text: "x" }]].every((c) => but((b) => (b.messages[0].content = c)) !== null));
ok("an extra field on the message is refused", but((b) => (b.messages[0].name = "x")) !== null);
ok("not an object at all is refused", refuse(null) !== null && refuse([]) !== null && refuse("x") !== null);
ok("the worst-case cost is above what such a call can really cost", worstCase(good()) > 0 && worstCase({ ...good(), max_tokens: 5200 }) > worstCase(good()));

// three at a time, and the budget is checked when a call starts, with what running calls may still cost set aside
{ let left = 1000; const g = gate(async () => left); let running = 0, peak = 0; const order: number[] = [];
  const call = async (i: number, cost: number, real: number) => { if (!(await g.enter(cost))) return false; running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); left -= real; running--; order.push(i); g.leave(cost); return true; };
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => call(i, 100, 60)));
  ok(`twelve calls at once: never more than ${AT_ONCE} running`, peak === AT_ONCE, peak);
  ok("every call the budget could cover ran, and the gate is empty afterwards", res.every(Boolean) && JSON.stringify(g.state()) === JSON.stringify({ active: 0, held: 0, waiting: 0 }), g.state());
  left = 250; peak = 0; const res2 = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i, 100, 90)));
  ok("with ₹2.50 left and calls that may cost ₹1 each, two run and eight are refused: the cap cannot be passed by calls in flight", res2.filter(Boolean).length === 2 && left === 70 && g.state().active === 0, { ran: res2.filter(Boolean).length, left });
  left = 100; const late = await Promise.all([call(1, 100, 100), call(2, 100, 100), call(3, 100, 100), call(4, 100, 100)]);
  ok("a call that waited in the queue is checked again when its turn comes", late.filter(Boolean).length === 1 && left === 0, { ran: late.filter(Boolean).length, left }); }

// the route itself, with a stand-in model
{ const token = process.env.BENCH_TOKEN_FILE ? readFileSync(process.env.BENCH_TOKEN_FILE, "utf8").trim() : "";
  let made = 0, after = 0, left = 100000; const seen: any[] = [];
  const app = benchRoutes({ create: async (b: any) => { made++; seen.push(Object.keys(b).sort().join(",")); await new Promise((r) => setTimeout(r, 5)); return { id: "msg", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } }; }, left: async () => left, before: async () => {}, after: async () => { after++; } });
  const post = (headers: Record<string, string>, body: unknown) => app.request("/messages", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  ok("no token, a wrong token, and a token of the right length but wrong value all get 404 and no call", (await post({}, good())).status === 404 && (await post({ "x-bench-token": "nope" }, good())).status === 404 && (await post({ "x-bench-token": "a".repeat(64) }, good())).status === 404 && made === 0, made);
  ok("after the closing time the right token is refused too", !token || (allowed(token) && !allowed(token, Date.parse("2026-11-26T00:00:01+05:30"))));
  if (token) {
    const h = { "x-bench-token": token };
    const r = await post(h, good()); ok("the right token and the right request are forwarded, with only the four fields", r.status === 200 && made === 1 && seen[0] === "max_tokens,messages,model,system" && after === 1, [r.status, seen[0]]);
    ok("a request with a tool is refused before any call", (await post(h, { ...good(), tools: [] })).status === 400 && made === 1);
    ok("a body that is not JSON, or too large, is refused before any call", (await post(h, "{oops")).status === 400 && (await post(h, JSON.stringify({ ...good(), messages: [{ role: "user", content: "x".repeat(210000) }] }))).status === 413 && made === 1);
    left = 0; const no = await post(h, good()); ok("with the budget spent the call is refused (503) and nothing is sent", no.status === 503 && made === 1 && (await no.json()).error.type === "qa_budget");
  } else console.log("  (token file not given: route checks with the real token skipped)"); }
if (failed) { console.error(`${failed} failed`); process.exit(1); } console.log("Benchmark pass-through self-check: all passed");
