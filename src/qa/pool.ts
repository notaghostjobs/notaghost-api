// Which roles Radar sees in QA: the invented fixtures, or the real listings QA has read — never both at once.
// One switch for the whole environment, kept in the database, changed only with a QA tool.
import { db } from "../lib/db.js";
import { DISCOVERY_ON } from "./guard.js";
const PUBLIC = () => (process.env.QA_PUBLIC_URL ?? "").replace(/\/$/, "");
export type PoolMode = "fixtures" | "real";
export const isFixtureUrl = (url: string | null | undefined) => !!PUBLIC() && String(url ?? "").startsWith(`${PUBLIC()}/qa/`);
let memo: { at: number; mode: PoolMode } | null = null;
export async function qaPoolMode(): Promise<PoolMode> {
  if (!DISCOVERY_ON) return "fixtures";   // without the authorisation there is nothing real to show
  if (memo && Date.now() - memo.at < 10e3) return memo.mode;
  const { data } = await db.from("reader_control").select("value").eq("key", "qa:pool").maybeSingle();
  memo = { at: Date.now(), mode: (data?.value as any)?.mode === "real" ? "real" : "fixtures" }; return memo.mode;
}
export async function setQaPoolMode(mode: PoolMode, by: string) { await db.from("reader_control").upsert({ key: "qa:pool", value: { mode, at: new Date().toISOString(), by }, updated_at: new Date().toISOString() }, { onConflict: "key" }); memo = { at: Date.now(), mode }; }
