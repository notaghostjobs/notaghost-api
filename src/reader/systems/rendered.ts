// Custom portals that only exist after JavaScript runs (Goldman, IBM, Flipkart, Microsoft...).
// One shared browser, one page at a time (see page.ts). Each reader opens the Bengaluru-filtered search, lets it render,
// scrolls / pages until no new jobs appear, and reads the cards. Location is Bengaluru by construction of the URL.
import type { Feed, FeedJob, System } from "./types.js";
import { renderAndCollect } from "./page.js";

interface Spec { id: string; url: string; company: string; link: RegExp; idFrom: RegExp; next?: "scroll" | "page"; pageParam?: string; maxPages?: number; location?: string }

const SPECS: Spec[] = [
  { id: "goldman", company: "Goldman Sachs", url: "https://higher.gs.com/roles?LOCATION=Bengaluru", link: /higher\.gs\.com\/roles\/(\d+)/i, idFrom: /\/roles\/(\d+)/, next: "scroll", location: "Bengaluru" },
  { id: "ibm", company: "IBM", url: "https://www.ibm.com/careers/search?field_keyword_18[0]=India&field_keyword_05[0]=Bangalore", link: /ibm\.com\/careers\/job\/|ibm\.com\/[a-z-]+\/careers\/job\//i, idFrom: /\/job\/([^/?#]+)/, next: "page", pageParam: "p", maxPages: 60, location: "Bangalore, India" },
  { id: "flipkart", company: "Flipkart", url: "https://www.flipkartcareers.com/#!/joblist?location=Bangalore", link: /flipkartcareers\.com\/#!\/job-view\//i, idFrom: /job-view\/([^/?#]+)/, next: "scroll", location: "Bangalore" },
  { id: "hcltech", company: "HCLTech", url: "https://careers.hcltech.com/search/?q=&locationsearch=Bengaluru", link: /careers\.hcltech\.com\/job\/[^/]+\/\d{4,}/i, idFrom: /\/(\d{4,})\/?$/, next: "page", pageParam: "startrow", maxPages: 80, location: "Bengaluru" },
  { id: "wipro", company: "Wipro", url: "https://careers.wipro.com/search/?q=&locationsearch=Bengaluru", link: /careers\.wipro\.com\/job\/[^/]+\/\d{4,}/i, idFrom: /\/(\d{4,})\/?$/, next: "page", pageParam: "startrow", maxPages: 80, location: "Bengaluru" },
  { id: "microsoft", company: "Microsoft", url: "https://jobs.careers.microsoft.com/global/en/search?lc=Bengaluru%2C%20Karnataka%2C%20India&pgSz=20&o=Recent", link: /careers\.microsoft\.com\/[a-z]+\/[a-z]+\/job\//i, idFrom: /\/job\/([^/?#]+)/, next: "page", pageParam: "pg", maxPages: 60, location: "Bengaluru, Karnataka, India" },
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
