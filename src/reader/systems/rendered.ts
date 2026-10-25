// Custom portals that only exist after JavaScript runs (Goldman). IBM/Microsoft/HCL/Wipro have JSON endpoints (portals.ts, successfactors.ts); Flipkart lists 6 roles on TurboHire — not read.
// One shared browser, one page at a time (see page.ts). Each reader opens the Bengaluru-filtered search, lets it render,
// scrolls / pages until no new jobs appear, and reads the cards. Location is Bengaluru by construction of the URL.
import type { Feed, FeedJob, System } from "./types.js";
import { renderAndCollect } from "./page.js";

interface Spec { id: string; url: string; company: string; link: RegExp; idFrom: RegExp; next?: "scroll" | "page"; pageParam?: string; maxPages?: number; location?: string }

const SPECS: Spec[] = [
  { id: "goldman", company: "Goldman Sachs", url: "https://higher.gs.com/roles?LOCATION=Bengaluru", link: /higher\.gs\.com\/roles\/(\d+)/i, idFrom: /\/roles\/(\d+)/, next: "scroll", location: "Bengaluru" },
];

function make(spec: Spec): System {
  return {
    id: spec.id,
    detect: (u) => (spec.link.test(u) || new RegExp(spec.id, "i").test(u) ? spec.id : null),
    async read() {
      const r = await renderAndCollect(spec.url, spec.link, { next: spec.next ?? "scroll", pageParam: spec.pageParam, maxPages: spec.maxPages ?? 40 });
      const jobs: FeedJob[] = r.links.map((l) => ({ id: l.h.match(spec.idFrom)?.[1] ?? l.h, title: l.t, location: l.loc || spec.location || "", url: l.h, posted_at: null, updated_at: null, posted_text: null }));
      return { system: spec.id, ref: spec.id, board_url: spec.url, company_name: spec.company, jobs, debug: r.debug };
    },
  };
}

export const RENDERED: System[] = SPECS.map(make);
export type { Feed };
