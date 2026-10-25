// The twenty largest Bengaluru employers. Seeded by name with their real careers address, resolved first, and checked one by one.
import { db } from "../lib/db.js";
import { companyKey } from "../engine/ghost/canon.js";
import { resolveEmployer } from "./resolve.js";
import { readEmployer, recordFeed } from "./read.js";

export const TIER1: { name: string; careers: string; website: string; note?: string }[] = [
  { name: "Infosys", careers: "https://www.infosys.com/careers/apply.html", website: "https://www.infosys.com" },
  { name: "Wipro", careers: "https://careers.wipro.com/search/?q=&locationsearch=Bengaluru", website: "https://www.wipro.com" },
  { name: "Accenture", careers: "https://www.accenture.com/in-en/careers/jobsearch?location=Bengaluru", website: "https://www.accenture.com", note: "own search; Workday behind apply" },
  { name: "Tata Consultancy Services", careers: "https://www.tcs.com/careers/india", website: "https://www.tcs.com", note: "own portal (iBegin)" },
  { name: "IBM", careers: "https://www.ibm.com/careers/search?q=Bangalore", website: "https://www.ibm.com", note: "own search API" },
  { name: "Capgemini", careers: "https://www.capgemini.com/in-en/careers/join-capgemini/job-search/?location=Bengaluru", website: "https://www.capgemini.com" },
  { name: "Cognizant", careers: "https://careers.cognizant.com/global-en/jobs/?location=Bengaluru", website: "https://www.cognizant.com", note: "Phenom" },
  { name: "HCLTech", careers: "https://careers.hcltech.com/search/?q=&locationsearch=Bengaluru", website: "https://www.hcltech.com" },
  { name: "Tech Mahindra", careers: "https://careers.techmahindra.com/", website: "https://www.techmahindra.com", note: "own portal" },
  { name: "Amazon", careers: "https://www.amazon.jobs/en/locations/bangalore-india", website: "https://www.amazon.in" },
  { name: "Flipkart", careers: "https://flipkart.turbohire.co/careerpage/4d757ba0-3d57-448a-b82c-238ed87ac90f", website: "https://www.flipkart.com", note: "own portal" },
  { name: "Google", careers: "https://www.google.com/about/careers/applications/jobs/results/?location=Bengaluru%2C%20Karnataka%2C%20India", website: "https://www.google.com" },
  { name: "Microsoft", careers: "https://apply.careers.microsoft.com/careers?location=Bengaluru", website: "https://www.microsoft.com" },
  { name: "Dell Technologies", careers: "https://jobs.dell.com/en/search-jobs/Bengaluru", website: "https://www.dell.com", note: "Phenom" },
  { name: "Oracle", careers: "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions?keyword=Bengaluru", website: "https://www.oracle.com" },
  { name: "Cisco", careers: "https://jobs.cisco.com/jobs/SearchJobs/Bengaluru", website: "https://www.cisco.com", note: "own portal" },
  { name: "Intel", careers: "https://jobs.intel.com/en/search-jobs/Bengaluru", website: "https://www.intel.com", note: "Phenom" },
  { name: "Walmart Global Tech", careers: "https://careers.walmart.com/results?q=&page=1&sort=rank&jobCity=Bengaluru", website: "https://www.walmart.com", note: "own front; Workday behind" },
  { name: "Goldman Sachs", careers: "https://higher.gs.com/roles?LOCATION=Bengaluru", website: "https://www.goldmansachs.com", note: "own portal" },
  { name: "JPMorgan Chase", careers: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/requisitions?keyword=Bengaluru", website: "https://www.jpmorganchase.com" },
];

/** Make sure all twenty exist, carry their careers address, and go first. Idempotent. */
export async function seedTier1() {
  for (const t of TIER1) {
    const key = companyKey(t.name);
    const { data } = await db.from("employers").select("key, ats").eq("key", key).maybeSingle();
    const direct: Record<string, [string, string]> = { "goldman sachs": ["goldman", "goldman"], "ibm": ["ibm", "ibm"], "microsoft": ["microsoft", "microsoft"], "google": ["google", "google"], "amazon": ["amazon", "amazon"], "hcltech": ["successfactors", "https://careers.hcltech.com"], "wipro": ["successfactors", "https://careers.wipro.com"], "flipkart": ["none", "flipkart.turbohire.co"] };
    const d = direct[key];
    if (!data) await db.from("employers").insert({ key, name: t.name, website: t.website, careers_url: t.careers, source: "tier1", priority: 0, ...(d ? { ats: d[0], ats_ref: d[1], confidence: "link", evidence: "own reader", resolved_at: new Date().toISOString() } : {}) });
    else if (d) await db.from("employers").update({ careers_url: t.careers, website: t.website, priority: 0, ats: d[0], ats_ref: d[1], confidence: "link", evidence: d[0] === "none" ? "verified 25 Oct: public page lists 6 roles in total" : "own reader", resolved_at: new Date().toISOString(), read_at: null }).eq("key", key);
    else await db.from("employers").update({ careers_url: t.careers, website: t.website, priority: 0, ...(data.ats === "none" || data.ats === "page" ? { resolved_at: null, ats: null, ats_ref: null } : {}) }).eq("key", key);
  }
}

export interface Tier1Row { name: string; ats: string | null; ref: string | null; jobs: number; blr: number; evidence: string | null; error: string | null; ms: number }

/** Resolve (if needed) and read each of the twenty; one row each. This is the coverage table. */
export async function checkTier1(onRow?: (r: Tier1Row) => void): Promise<Tier1Row[]> {
  const rows: Tier1Row[] = [];
  for (const t of TIER1) {
    const key = companyKey(t.name); const t0 = Date.now();
    try {
      let { data: e } = await db.from("employers").select("key, name, website, careers_url, ats, ats_ref, evidence").eq("key", key).single();
      if (!e) throw new Error("not seeded");
      if (e.ats === "none" && /^verified/.test(e.evidence ?? "")) { /* checked by hand; nothing to read */ }
      else if (!e.ats || e.ats === "none" || e.ats === "page") {
        const r = await resolveEmployer({ key: e.key, name: e.name, website: e.website, careers_url: e.careers_url, ats: null, ats_ref: null });
        await db.from("employers").update({ ats: r.ats, ats_ref: r.ats_ref, careers_url: r.careers_url ?? e.careers_url, confidence: r.confidence, evidence: r.evidence, resolved_at: new Date().toISOString(), resolve_error: null }).eq("key", key);
        if (r.feed && r.ats !== "none") await recordFeed({ key, name: e.name, ats: r.ats, ats_ref: r.ats_ref }, r.feed);
        ({ data: e } = await db.from("employers").select("key, name, website, careers_url, ats, ats_ref, evidence").eq("key", key).single());
      } else {
        await readEmployer({ key: e.key, name: e.name, ats: e.ats, ats_ref: e.ats_ref });
      }
      const { data: fresh } = await db.from("employers").select("ats, ats_ref, openings, blr_openings, evidence, read_error").eq("key", key).single();
      const row: Tier1Row = { name: t.name, ats: fresh?.ats ?? null, ref: fresh?.ats_ref ?? null, jobs: fresh?.openings ?? 0, blr: fresh?.blr_openings ?? 0, evidence: fresh?.evidence ?? null, error: fresh?.read_error ?? null, ms: Date.now() - t0 };
      rows.push(row); onRow?.(row);
    } catch (err) { const row: Tier1Row = { name: t.name, ats: null, ref: null, jobs: 0, blr: 0, evidence: null, error: (err as Error).message.slice(0, 200), ms: Date.now() - t0 }; rows.push(row); onRow?.(row); }
  }
  return rows;
}
