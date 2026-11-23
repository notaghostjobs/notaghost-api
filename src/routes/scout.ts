// Scout (a test, kept apart from everything else): an employer gives one order — a role, years, a place — and gets back a
// shortlist of people whose public professional pages a web search returns for it. Nothing is crawled and no data is bought:
// it reads search results, the way a recruiter's X-ray search does. Orders and their results live in reader_control
// (scout:o:<id>), so no table is added. A daily cap keeps a stray link from spending money.
import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../lib/db.js";
import { env } from "../lib/env.js";
import { MODEL } from "../engine/claude.js";
import { withMeter, record } from "../engine/meter.js";

const client = new Anthropic({ apiKey: env.anthropicKey });
const DAILY_CAP = Number(process.env.SCOUT_DAILY_CAP ?? 20);
const MAX_SEARCHES = 8;

export type ScoutOrder = { role: string; years_min: number | null; years_max: number | null; location: string; must: string };
export type ScoutPerson = { name: string; headline: string | null; company: string | null; location: string | null; url: string; experience: string | null; evidence: string | null; fit: "strong" | "possible" };

const SYSTEM = `You source candidates for ONE job order by searching the public web, the way a recruiter runs an X-ray search.

How to search: run search-engine queries limited to public professional profile pages, e.g. site:linkedin.com/in "<job title>" "<city>". Vary them: synonym titles, the city and its metro area, seniority words, the must-have skill. The site: operator is not always honoured, so also try plain queries such as "<job title>" <city> LinkedIn, and queries for company team pages or speaker pages that name people in this role. Use every search you are allowed before answering.

Rules, without exception:
- List only people who appear in your search results. Never invent a person, a name, a company or a URL.
- Copy each URL exactly as the result gives it.
- name, headline, company, location: only what the result shows. Use null when it is not shown.
- experience: years of experience ONLY if the result states it or states dates you can count from; otherwise null. Do not guess.
- evidence: the few words from the result that made you include the person.
- fit: "strong" when title AND location both match the order; otherwise "possible".
- Leave out recruiters, agencies, job adverts, and people plainly in another country or another line of work.
- Up to 25 people, strongest first. Fewer real ones are better than padding.

Answer with a single JSON object and nothing else:
{"people":[{"name","headline","company","location","url","experience","evidence","fit"}],"queries":["each search you ran"],"note":"one sentence on how good the coverage was"}`;

/** The search itself. Exported so it can be tried from a probe without the HTTP layer. */
export async function scout(o: ScoutOrder): Promise<{ people: ScoutPerson[]; queries: string[]; note: string | null; searches: number }> {
  const years = o.years_min != null || o.years_max != null ? `${o.years_min ?? 0}${o.years_max != null ? "–" + o.years_max : "+"} years` : "any";
  const r: any = await client.messages.create({
    model: MODEL, max_tokens: 8000, thinking: { type: "adaptive" }, output_config: { effort: "medium" },
    system: SYSTEM + "\n\nToday is " + new Date().toDateString() + ".",
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
    messages: [{ role: "user", content: `Job order\nRole: ${o.role}\nExperience: ${years}\nLocation: ${o.location}\nMust have: ${o.must || "nothing further"}` }],
  } as any);
  if (r.usage) record(MODEL, r.usage);
  const text: string = r.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  let out: any = null;
  const end = text.lastIndexOf("}");
  for (let s = text.indexOf("{"); s !== -1 && s < end; s = text.indexOf("{", s + 1)) { try { out = JSON.parse(text.slice(s, end + 1)); break; } catch { /* next */ } }
  const seen = new Set<string>();
  const people: ScoutPerson[] = (Array.isArray(out?.people) ? out.people : []).flatMap((p: any) => {
    const url = String(p?.url ?? "").trim(), name = String(p?.name ?? "").trim();
    if (!/^https?:\/\/\S+$/i.test(url) || !name) return [];
    const key = url.toLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) return [];
    seen.add(key);
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 240) : null);
    return [{ name: name.slice(0, 120), headline: s(p.headline), company: s(p.company), location: s(p.location), url, experience: s(p.experience), evidence: s(p.evidence), fit: p.fit === "strong" ? "strong" as const : "possible" as const }];
  }).slice(0, 25);
  return { people, queries: (Array.isArray(out?.queries) ? out.queries : []).map((q: any) => String(q).slice(0, 200)).slice(0, 12), note: typeof out?.note === "string" ? out.note.slice(0, 300) : null, searches: Number(r.usage?.server_tool_use?.web_search_requests ?? 0) };
}

export const scoutRoute = new Hono();
const key = (id: string) => `scout:o:${id}`;
const save = (id: string, value: unknown) => db.from("reader_control").upsert({ key: key(id), value });

scoutRoute.post("/orders", async (c) => {
  const b = z.object({ role: z.string().trim().min(3).max(90), years_min: z.number().int().min(0).max(40).nullable().optional(), years_max: z.number().int().min(0).max(45).nullable().optional(),
    location: z.string().trim().min(2).max(90), must: z.string().trim().max(160).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Give a role and a location." }, 400);
  const day = `scout:day:${new Date().toISOString().slice(0, 10)}`;
  const { data: d } = await db.from("reader_control").select("value").eq("key", day).maybeSingle();
  const n = Number((d?.value as any)?.n ?? 0);
  if (n >= DAILY_CAP) return c.json({ error: `Today's ${DAILY_CAP} test orders are used. It opens again tomorrow.` }, 429);
  await db.from("reader_control").upsert({ key: day, value: { n: n + 1 } });
  const id = randomBytes(6).toString("hex");
  const order: ScoutOrder = { role: b.data.role, years_min: b.data.years_min ?? null, years_max: b.data.years_max ?? null, location: b.data.location, must: b.data.must ?? "" };
  const at = new Date().toISOString();
  await save(id, { id, status: "running", order, at });
  // the search takes a minute or so: it runs after the reply, and the page asks for the result
  void (async () => {
    const acc = { paise: 0 };
    try {
      const res = await withMeter({ tag: "scout", acc } as any, () => scout(order));
      await save(id, { id, status: "done", order, at, done_at: new Date().toISOString(), ...res, paise: Math.round(acc.paise) });
    } catch (e) {
      console.error("[scout] failed", (e as Error).message);
      await save(id, { id, status: "failed", order, at, error: "The search didn’t finish. Try the order again." });
    }
  })();
  return c.json({ id });
});

scoutRoute.get("/orders/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-f0-9]{12}$/.test(id)) return c.json({ error: "No such order." }, 404);
  const { data } = await db.from("reader_control").select("value").eq("key", key(id)).maybeSingle();
  if (!data) return c.json({ error: "No such order." }, 404);
  // an order still "running" long after it began was lost to a restart: say so rather than spin forever
  const v: any = data.value;
  if (v.status === "running" && Date.now() - Date.parse(v.at) > 6 * 60e3) return c.json({ ...v, status: "failed", error: "The search was interrupted. Try the order again." });
  return c.json(v);
});

scoutRoute.get("/orders", async (c) => {
  const { data } = await db.from("reader_control").select("value").like("key", "scout:o:%").limit(60);
  const list = (data ?? []).map((r: any) => r.value).sort((a: any, b: any) => String(b.at).localeCompare(String(a.at))).slice(0, 12)
    .map((v: any) => ({ id: v.id, status: v.status, at: v.at, order: v.order, count: Array.isArray(v.people) ? v.people.length : null }));
  return c.json({ orders: list });
});
