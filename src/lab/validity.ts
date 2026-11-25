// Offline validity check v2, applied identically to every lab pipeline (production's postingProblem is unchanged and
// still runs first). Catches three page types found in the AI-sample arms on 25 Nov 2026:
//   1. a careers page carrying only the job's metadata (IBM: Job ID, City / Township / Village, Work arrangement …);
//   2. a stored application form with no job text (Greenhouse "Apply for this job * indicates a required field" first);
//   3. a walk-in or registration form listing many profiles, not one job.
import { jobText } from "../lib/tagger2.js";
const META = /\b(job id|city \/ township \/ village|state \/ province|work arrangement|area of work|employment type|position type|travel required|shift general|back to search results|recruitment scams|privacy statement|apply now|login|email x linkedin)\b/gi;
export function validity2(title: string, text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (/^(careers )?apply for this job\s*\*\s*indicates a required field/i.test(t.slice(0, 120))) return "application form only";
  if (/\bwalk-?\s?ins?\b|walk-?in drive/i.test(title) && /\b(register|registration|crf)\b/i.test(t) && !jobText(text).duties) return "walk-in registration form, not a job";
  const metaHits = (t.match(META) ?? []).length; const words = t.replace(META, " ").split(/\s+/).filter((w) => /[a-z]{3,}/i.test(w)).length;
  if (metaHits >= 6 && words < 120 && !jobText(text).duties) return "careers page with metadata only";
  return null;
}
