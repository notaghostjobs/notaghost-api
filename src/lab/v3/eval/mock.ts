// A deterministic stand-in for the provider, for setup tests only. It answers the two request types the evaluation
// sends (requirement extraction and judging) with replies built from the request text itself, so the whole pipeline
// can run end to end with no network. Faults can be injected per job or per candidate to exercise every failure path.
// It is not a model and its "verdicts" say nothing about matching quality.
export type Fault = "fabricated_quote" | "schema" | "truncated" | "http_error" | "wrong_model" | "not_json";
export type MockOpts = { faults?: Record<string, Fault>; model?: string };
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").split(" ").filter((w) => w.length >= 4 && !STOP.has(w)));
const STOP = new Set(["with", "and", "the", "for", "from", "that", "this", "have", "will", "your", "years", "year", "experience", "strong", "skills", "ability", "knowledge", "working", "must", "required", "minimum", "role", "team", "teams", "good", "excellent"]);
const REQ = /\b(must|required|requirement|minimum|mandatory|essential|need to have|you have|\d+\s*\+?\s*(?:-\s*\d+\s*)?years)\b/i;
function extract(user: string) {
  const title = /^TITLE: (.*)$/m.exec(user)?.[1] ?? ""; const posting = user.split("\nPOSTING:\n")[1] ?? "";
  const lines = posting.split(/\n|(?<=\.)\s+/).map((l) => l.replace(/^[•\-*]\s*/, "").trim()).filter((l) => l.length >= 12);
  const mand = lines.filter((l) => REQ.test(l)).slice(0, 10).map((l) => { const q = l.slice(0, 200); return { text: q, quote: q, kind: /\byears\b/i.test(q) ? "experience" : /\b(degree|certif|qualified|chartered|mba|b\.?tech|llb|mbbs)\b/i.test(q) ? "credential" : "tool", alternatives: [] }; });
  const y = /(\d{1,2})\s*\+?\s*(?:-\s*(\d{1,2}))?\s*years/i.exec(posting);
  const usable = posting.length >= 300 && mand.length > 0;
  return { function: title.slice(0, 80), specialisation: title.slice(0, 80), responsibilities: lines.filter((l) => !REQ.test(l)).slice(0, 6), mandatory: usable ? mand : [], secondary: [], preferred: [],
    years: y ? { min: +y[1], max: y[2] ? +y[2] : null, quote: y[0] } : { min: null, max: null, quote: null }, seniority: /\b(senior|sr)\b/i.test(title) ? "senior" : /\b(lead|manager)\b/i.test(title) ? "lead" : /\b(associate|junior|executive)\b/i.test(title) ? "junior" : "mid",
    manages_people: /\bmanage (a|the)? ?team\b/i.test(posting), location: { city: null, work_mode: "unknown", quote: null }, credentials: [], usable, usable_reason: usable ? null : "too little job content" };
}
function judge(system: string, user: string, faults: Record<string, Fault>) {
  const ev = (system.split("CANDIDATE EVIDENCE")[1] ?? "").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter((l) => l.length >= 10);
  const jobs = user.split("\n\n=====\n\n");
  return { verdicts: jobs.map((j) => {
    const id = /^JOB (\S+):/.exec(j)?.[1] ?? ""; const req = JSON.parse(/REQUIREMENTS \(extracted, each with its source text\):\n(.*)\nJOB TEXT:/s.exec(j)?.[1] ?? "{}");
    const core = (req.mandatory ?? []).slice(0, 6).map((m: any) => { const need = words(`${m.text} ${m.quote}`); let best: string | null = null, bs = 0;
      for (const l of ev) { const n = [...words(l)].filter((w) => need.has(w)).length; if (n > bs) { bs = n; best = l; } }
      const status = bs >= 2 ? "demonstrated" : bs === 1 ? "transferable" : "unverified";
      return { requirement: m.text, job_quote: m.quote, status, resume_quote: status === "unverified" ? null : faults[id] === "fabricated_quote" ? "Led a 40-person team at a global bank for ten years" : best }; });
    const dem = core.filter((k: any) => k.status === "demonstrated").length, ok = core.filter((k: any) => k.status !== "unverified").length; const r = core.length ? ok / core.length : 0;
    const fit = !core.length ? "cannot_judge" : dem / core.length >= 0.6 ? "direct" : r >= 0.6 ? "adjacent" : r >= 0.3 ? "stretch" : "unsuitable";
    return { job_id: id, fit: faults[id] === "schema" ? "excellent" : fit, function: "same", specialisation: fit === "direct" ? "same" : "neighbour", seniority: "right", core, gaps: [], unverified: core.filter((k: any) => k.status === "unverified").map((k: any) => k.requirement), why: "Mock verdict built from word overlap; not a model judgement.", confidence: r >= 0.8 ? "high" : "medium" };
  }) };
}
/** A fetch-compatible function. Token usage is derived from text length so the ledger and guard behave realistically. */
export function mockFetch(o: MockOpts = {}): typeof fetch {
  const faults = o.faults ?? {};
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body); const system = body.system[0].text as string, user = body.messages[0].content as string;
    const isExtract = system.startsWith("You extract"); const key = isExtract ? `title:${/^TITLE: (.*)$/m.exec(user)?.[1] ?? ""}` : (/^JOB (\S+):/m.exec(user)?.[1] ?? "");
    const f = faults[key];   // extraction faults are keyed "title:<posting title>", judge faults by job id
    const inTok = Math.ceil((system.length + user.length) / 2.9);
    if (f === "http_error") return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "mock overload" } }), { status: 529 });
    const reply = isExtract ? extract(user) : judge(system, user, faults);
    const text = f === "not_json" ? "I cannot answer that." : JSON.stringify(reply); const outTok = Math.ceil(text.length / 3);
    return new Response(JSON.stringify({ model: f === "wrong_model" ? "claude-other-1" : (o.model ?? "claude-sonnet-5-5-20261101"), stop_reason: f === "truncated" ? "max_tokens" : "end_turn",
      usage: { input_tokens: inTok, output_tokens: f === "truncated" ? body.max_tokens : outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: f === "truncated" ? text.slice(0, text.length / 2) : text }] }), { status: 200 });
  }) as any;
}
