// Employer names by sector, from the model with web search. Names only — no listings, no board is read.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../lib/env.js";
import { FAST } from "../../engine/claude.js";
import { db } from "../../lib/db.js";
import { companyKey } from "../../engine/ghost/canon.js";

const client = new Anthropic({ apiKey: env.anthropicKey });

export const SECTORS = [
  "fintech and payments", "banks and NBFCs", "insurance and insurtech", "wealth, broking and investment platforms",
  "SaaS and B2B software", "developer tools and cloud infrastructure", "cybersecurity", "AI and machine learning startups", "data analytics and consulting",
  "IT services and outsourcing", "global capability centres (GCCs) of foreign companies", "semiconductor and chip design", "networking, telecom and 5G", "hardware, electronics and IoT",
  "e-commerce and marketplaces", "quick commerce and grocery delivery", "food delivery and cloud kitchens", "D2C consumer brands", "fashion and beauty",
  "edtech and online learning", "healthtech and digital health", "hospitals and healthcare providers", "biotech, pharma and life sciences", "medical devices and diagnostics",
  "logistics, supply chain and mobility", "electric vehicles and automotive", "aerospace and defence", "space tech and drones", "manufacturing and industrial",
  "real estate and proptech", "construction and infrastructure", "hospitality, hotels and travel", "gaming and esports", "media, OTT and content",
  "adtech and martech", "HR tech and recruitment platforms", "legal tech and compliance", "agritech and food processing", "climate tech and clean energy",
  "consulting and professional services (big four, strategy)", "retail chains and supermarkets", "FMCG and consumer goods", "automobile manufacturers and components",
  "venture capital and private equity", "startups funded in the last 12 months", "unicorns and large startups", "large Indian conglomerates with Bengaluru operations",
  "US tech companies with Bengaluru engineering centres", "European and Japanese companies with Bengaluru centres", "government, PSUs and research institutions",
];

interface Found { name: string; website: string | null }

/** Ask for employers in one sector. Returns deduped names with websites when known. */
export async function enumerateSector(sector: string): Promise<Found[]> {
  const system = `You list employers that have offices and hire in Bengaluru (Bangalore), India, for ONE sector. Use web search to be thorough and current. Include large companies, mid-size companies and startups. Only real companies you can name; no placeholders, no duplicates, no staffing agencies. Prefer 60–120 names. Respond with a single JSON object and nothing else: {"companies":[{"name":"...","website":"https://... or null"}]}. Today is ${new Date().toDateString()}.`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Sector: ${sector}\nCity: Bengaluru, India` }];
  // thinking is on by default for this model and eats the budget; cap it, give the answer room, fewer searches
  const req = () => client.messages.create({ model: FAST, max_tokens: 16000, system, thinking: { type: "adaptive" }, output_config: { effort: "low" }, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }], messages } as any);
  let r = await req();
  // a long web-search turn can pause; continue it until the model ends the turn
  for (let i = 0; i < 4 && (r.stop_reason as string) === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: r.content as any });
    r = await req();
  }
  if (r.stop_reason === "max_tokens") console.warn("[sectors] max_tokens for", sector);
  const text = r.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  let list: any[] = [];
  if (a !== -1 && b > a) { try { list = JSON.parse(text.slice(a, b + 1))?.companies ?? []; } catch { /* fall through */ } }
  if (!list.length) {
    // tolerant: pick out every {"name": ..., "website": ...} object even if the wrapper is broken
    for (const m of text.matchAll(/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"website"\s*:\s*(null|"[^"]*")\s*\}/g)) list.push({ name: m[1], website: m[2] === "null" ? null : m[2].slice(1, -1) });
  }
  if (!list.length) console.warn("[sectors] no names parsed for", sector, "stop:", r.stop_reason, "blocks:", r.content.map((b: any) => b.type).join(","), "— text starts:", JSON.stringify(text.slice(0, 200)));
  const out = new Map<string, Found>();
  for (const c of list) {
    const name = String(c?.name ?? "").trim(); if (name.length < 2 || name.length > 80) continue;
    const key = companyKey(name); if (!key || out.has(key)) continue;
    const web = typeof c?.website === "string" && /^https?:\/\//i.test(c.website) ? c.website.trim() : null;
    out.set(key, { name, website: web });
  }
  return [...out.values()];
}

/** Run every sector (or the first n), storing new employers. Concurrency 3. */
export async function harvestSectors(opts: { limit?: number; onSector?: (done: number, total: number, added: number) => void } = {}) {
  const sectors = SECTORS.slice(0, opts.limit ?? SECTORS.length);
  const stats = { sectors: 0, names: 0, employers_new: 0, errors: 0, stopped: "end" };
  const q = [...sectors];
  async function worker() {
    for (;;) {
      const sector = q.shift(); if (!sector) return;
      try {
        const found = await enumerateSector(sector);
        stats.sectors++; stats.names += found.length;
        const rows = found.map((f) => ({ key: companyKey(f.name), name: f.name, website: f.website, source: `sector:${sector.slice(0, 40)}` })).filter((r) => r.key);
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200);
          const { data: have } = await db.from("employers").select("key").in("key", chunk.map((r) => r.key));
          const haveSet = new Set((have ?? []).map((h) => h.key));
          const fresh = chunk.filter((r) => !haveSet.has(r.key));
          if (fresh.length) { const { error } = await db.from("employers").upsert(fresh, { onConflict: "key", ignoreDuplicates: true }); if (error) throw new Error(error.message); stats.employers_new += fresh.length; }
        }
        opts.onSector?.(stats.sectors, sectors.length, stats.employers_new);
      } catch (e) { stats.errors++; console.error("[sectors]", sector, (e as Error).message); }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  return stats;
}
