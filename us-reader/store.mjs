// Where the US reader keeps what it finds: two tables of its own (us_employers, us_roles), written with the server key
// the scheduled job is given. With no key in the environment the reader only counts, and stores nothing.
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const storing = !!(URL_ && KEY);
const H = () => ({ apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" });
async function call(method, path, body, prefer) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: { ...H(), ...(prefer ? { prefer } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
      if (r.ok) return { ok: true, data: r.status === 204 || method !== "GET" ? null : await r.json() };
      if (r.status < 500 && r.status !== 429) return { ok: false, status: r.status, said: (await r.text()).slice(0, 200) };
    } catch (e) { if (attempt === 2) return { ok: false, status: 0, said: String(e?.message ?? e).slice(0, 120) }; }
    await new Promise((s) => setTimeout(s, 1500 * (attempt + 1)));
  }
  return { ok: false, status: 0, said: "no answer" };
}
/** Insert rows, or update the ones already there. Every row in a call must carry the same fields. */
export const upsert = (table, rows, keys) => rows.length ? call("POST", `${table}?on_conflict=${keys}`, rows, "resolution=merge-duplicates,return=minimal") : Promise.resolve({ ok: true });
export const patch = (table, query, body) => call("PATCH", `${table}?${query}`, body, "return=minimal");
/** Every row of a small table, a page at a time. */
export async function all(table, select, query = "") {
  const out = [];
  for (let from = 0; ; from += 1000) { const r = await call("GET", `${table}?select=${select}${query ? "&" + query : ""}&order=system,ref&offset=${from}&limit=1000`); if (!r.ok || !r.data?.length) break; out.push(...r.data); if (r.data.length < 1000) break; }
  return out;
}
