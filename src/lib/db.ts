import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// Server-side client. service_role bypasses RLS; this key never leaves Railway.
export const db = createClient(env.supabaseUrl, env.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export type Product = "sharpen" | "build" | "radar";

export interface User {
  id: string;
  phone: string;
  email: string | null;
  name: string | null;
  city: string | null;
}

export interface Plan {
  id: string;
  user_id: string;
  product: Product;
  shots_total: number;
  shots_used: number;
  starts_at: string;
  expires_at: string;
}

/** Active plan = not expired and shots remaining. "25 shots or 30 days, whichever first." */
export async function activePlan(userId: string, product: Product): Promise<Plan | null> {
  const { data } = await db
    .from("plans")
    .select("*")
    .eq("user_id", userId)
    .eq("product", product)
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true })
    .limit(5);
  return (data ?? []).find((p) => p.shots_used < p.shots_total) ?? null;
}
