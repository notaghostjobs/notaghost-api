// WORKDAY_PAUSED (25 Nov 2026): while it is set to true, Ghosted sends nothing to Workday. Since 22 Nov every request to
// Workday's careers sites has been answered with a Cloudflare challenge; we do not work around a refusal, so we stop
// asking. The switch changes no data: Workday job rows keep exactly what they hold (nothing is marked gone, tried or
// failed), and Workday employers keep their system and reference. Unset it and the next pass behaves as before.
//
// Two layers:
//   1. each Workday path checks `workdayPaused()` and steps aside without writing anything (reader, enrichment, Radar's
//      live check, resolver, Ghost Meter, Sharpen's link reader);
//   2. a guard on the process's fetch and on every headless browser refuses any Workday address while paused, so a path
//      missed in layer 1 still cannot reach Workday.
import { chromium } from "playwright-core";

/** Workday's own hosts: tenants' careers sites and Workday's site. */
export const WORKDAY_HOST = /(^|\.)(myworkdayjobs|myworkdaysite|myworkday|workday)\.com$/i;
export const workdayPaused = (env: NodeJS.ProcessEnv = process.env) => /^(1|true|yes|on)$/i.test(String(env.WORKDAY_PAUSED ?? "").trim());
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
export const isWorkdayUrl = (u: string | null | undefined) => !!u && WORKDAY_HOST.test(hostOf(u));

export class WorkdayPaused extends Error {
  status = 503;
  constructor(what: string) { super(`Workday is paused (WORKDAY_PAUSED): ${what}`); this.name = "WorkdayPaused"; }
}

/** What the guard refused since this process started, per host: for the status line and the QA check. */
export const refusedByPause = new Map<string, number>();
const note = (u: string) => { const h = hostOf(u) || "?"; refusedByPause.set(h, (refusedByPause.get(h) ?? 0) + 1); };

let installed = false;
/** Layer 2. Call once at process start, after any other fetch wrapper. Does nothing to non-Workday addresses. */
export function installWorkdayPause() {
  if (installed) return; installed = true;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input);
    if (workdayPaused() && isWorkdayUrl(url)) { note(url); throw new WorkdayPaused(hostOf(url)); }
    return inner(input, init);
  }) as typeof fetch;
  const launch = chromium.launch.bind(chromium);
  (chromium as any).launch = async (o: any = {}) => guardBrowser(await launch(o));
}

/** Every page of this browser refuses Workday addresses while paused (navigation and sub-requests alike). */
export function guardBrowser<B>(b: B): B {
  const x: any = b; if (x.__workdayGuard) return b; x.__workdayGuard = true;
  const newContext = x.newContext.bind(x);
  x.newContext = async (...a: any[]) => {
    const ctx = await newContext(...a);
    await ctx.route("**/*", (route: any) => { const u = route.request().url(); if (workdayPaused() && isWorkdayUrl(u)) { note(u); return route.abort("blockedbyclient"); } return route.fallback(); });
    return ctx;
  };
  x.newPage = async (...a: any[]) => { const ctx = await x.newContext(...a); const page = await ctx.newPage(); page.on("close", () => { void ctx.close().catch(() => {}); }); return page; };
  return b;
}
