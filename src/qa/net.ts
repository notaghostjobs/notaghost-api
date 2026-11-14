// QA's network boundary. Every outbound request the server makes goes through here. WhatsApp's Graph API is replaced by
// a simulator that writes to the QA outbox; SMS and email providers are refused; anything that is not QA's own database,
// QA's own pages, or the AI provider is refused unless its host was explicitly allowed for a bounded real-listing check.
// This is what makes "no real message" and "not the production database" true for background jobs too, not only routes.
import { QA, SIMULATED, supabaseRef, qaIdOf, PROD_SUPABASE_REFS } from "./guard.js";
import { store, takeFault } from "./state.js";
import http from "node:http";
import https from "node:https";
import { chromium } from "playwright-core";

const hostOf = (u: string) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
export function installQaNetwork() {
  if (!QA) return;
  const real = globalThis.fetch.bind(globalThis);
  const own = hostOf(process.env.QA_PUBLIC_URL ?? ""), supa = `${supabaseRef(process.env.SUPABASE_URL)}.supabase.co`;
  const extra = (process.env.QA_REAL_FETCH_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const allowed = (h: string) => h === supa || h === own || h === "api.anthropic.com" || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h) || extra.includes(h);
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const h = hostOf(url);
    if (PROD_SUPABASE_REFS.some((r) => h.startsWith(r))) { await store.log("blocked", { host: h, why: "production database" }); throw new Error("QA: a call to the production database was refused"); }
    if (h === "graph.facebook.com") return simulateWhatsApp(url, init);
    if (/msg91\.com$|resend\.com$|twilio\.com$|sendgrid\.(com|net)$/.test(h)) { await store.log("outbox", { channel: /msg91/.test(h) ? "sms" : "email", status: "blocked", host: h, body: String(init?.body ?? "").slice(0, 2000) }); throw new Error(`QA: sending through ${h} is not allowed`); }
    if (!allowed(h)) {
      await store.log("blocked", { host: h, url: url.slice(0, 300), why: "not an allowed host in QA" });
      return new Response("QA: this host is not reachable from the QA environment", { status: 599 });
    }
    return real(input, init);
  }) as typeof fetch;

  // Libraries that do not use fetch (the payment SDK) go through Node's own http/https. Same rule there: QA's own hosts,
  // plus Razorpay's API when — and only when — the key is a test-mode key. Anything else never leaves the machine.
  const testPay = /^rzp_test_/.test(process.env.RAZORPAY_KEY_ID ?? "");
  const nodeAllowed = (h: string) => allowed(h) || (testPay && h === "api.razorpay.com");
  for (const mod of [http, https] as any[]) for (const fn of ["request", "get"] as const) {
    const orig = mod[fn].bind(mod);
    mod[fn] = (...a: any[]) => {
      const o = a[0]; const h = String(typeof o === "string" ? hostOf(o) : o instanceof URL ? o.host : `${o?.hostname ?? o?.host ?? ""}${o?.port && ![80, 443, "80", "443"].includes(o.port) && !String(o?.host ?? "").includes(":") && /^(localhost|127\.0\.0\.1)$/.test(String(o?.hostname ?? o?.host ?? "")) ? `:${o.port}` : ""}`).toLowerCase();
      if (!nodeAllowed(h) && !nodeAllowed(h.replace(/:\d+$/, ""))) { void store.log("blocked", { host: h, why: "not an allowed host in QA (direct connection)" }).catch(() => {}); throw new Error(`QA: a direct connection to ${h || "an unknown host"} was refused`); }
      return orig(...a);
    };
  }
  // The headless browser that opens job pages and prints PDFs resolves QA's own hosts only: every other name fails to
  // resolve inside the browser, so a page cannot be opened on the real internet from QA unless its host was allowed.
  const names = [own, ...extra, "localhost", "127.0.0.1"].filter(Boolean).map((h) => h.replace(/:\d+$/, ""));
  const launch = chromium.launch.bind(chromium);
  const inside = (u: string) => /^(data|about|blob):/.test(u) || names.includes(hostOf(u).replace(/:\d+$/, ""));
  (chromium as any).launch = async (o: any = {}) => {
    const b: any = await launch({ ...o, args: [...(o.args ?? []), `--host-resolver-rules=MAP * ~NOTFOUND, ${names.map((n) => `EXCLUDE ${n}`).join(", ")}`] });
    // and, whatever the machine's network settings are, every request a page makes is checked against the same list
    const newContext = b.newContext.bind(b);
    b.newContext = async (...a: any[]) => { const ctx = await newContext(...a);
      await ctx.route("**/*", (route: any) => { const u = route.request().url(); if (inside(u)) return route.continue();
        if (route.request().isNavigationRequest()) void store.log("blocked", { host: hostOf(u), why: "the page-opening browser may only open QA's own pages" }).catch(() => {});
        return route.abort("namenotresolved"); });
      return ctx; };
    b.newPage = async (...a: any[]) => { const ctx = await b.newContext(...a); const page = await ctx.newPage(); page.on("close", () => { void ctx.close().catch(() => {}); }); return page; };
    return b;
  };
}

/** WhatsApp, simulated: the message a real send would carry is written to the outbox; Graph's success shape comes back. */
async function simulateWhatsApp(url: string, init?: any): Promise<Response> {
  const method = String(init?.method ?? "GET").toUpperCase();
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (!String(init?.headers?.Authorization ?? init?.headers?.authorization ?? "").includes(SIMULATED) && process.env.WA_TOKEN !== SIMULATED) { await store.log("blocked", { host: "graph.facebook.com", why: "a non-simulated token reached the WhatsApp boundary" }); return json({ error: { message: "QA: refused" } }, 403); }
  if (method === "GET") return json({ data: [] });
  let b: any = {}; try { b = JSON.parse(String(init?.body ?? "{}")); } catch { /* not json: recorded raw */ }
  const to = String(b.to ?? "").replace(/^(\d)/, "+$1");
  const params = (b.template?.components ?? []).flatMap((c: any) => (c.parameters ?? []).map((x: any) => x.text ?? x.payload ?? x.document?.filename ?? x.type));
  const failed = takeFault("wa_fail");
  await store.log("outbox", { channel: "whatsapp", to, identity: qaIdOf(to), kind: b.type ?? (url.includes("message_templates") ? "template-admin" : "other"), template: b.template?.name ?? null, params, text: b.text?.body ?? b.interactive?.body?.text ?? null, document: b.document?.filename ?? null, status: failed ? "failed" : "captured", delivered: false, path: new URL(url).pathname });
  if (failed) return json({ error: { message: "QA simulated provider failure", code: 131000 } }, 500);
  return json({ messaging_product: "whatsapp", contacts: [{ input: b.to, wa_id: b.to }], messages: [{ id: `wamid.QA.${Date.now()}` }], id: `qa.${Date.now()}`, success: true });
}
