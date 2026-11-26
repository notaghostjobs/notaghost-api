// Matching v2 vocabulary (deterministic). Written from general domain knowledge before any v2 result; not per candidate.
import { SKILLS } from "../skills.js";

const TOOL_FAMILIES = new Set(["lang", "sap", "salesforce", "backend", "arch", "frontend", "mobile", "db_sql", "db_nosql", "bigdata", "warehouse", "pipeline", "bi", "cloud", "devops", "itsm", "itsm_tool", "testing", "erp", "hris", "martech", "embedded", "vlsi"]);
export const TOOL_FAMILY_IDS = new Set(SKILLS.filter((s: any) => TOOL_FAMILIES.has(s.family)).map((s: any) => s.id));

/** Shared terms that say little about the role on their own; they may add a little, never decide. */
export const GENERIC = new Set(["sql", "excel", "agile", "project_mgmt", "stakeholder", "cloud", "aws", "azure", "gcp", "statistics", "customer_service", "rest", "microservices", "linux", "html_css", "powerbi", "tableau", "crm_tools"]);
export const GENERIC_WORDS = /\b(sql|excel|stakeholder(s| management)?|cloud|analytics|operations|communication|team player|problem solving|ms office|reporting|documentation)\b/gi;

/** Sub-specialisations inside one family. A job and a person in the same family but different sub-specialisations
 *  are "different specialisation", not "same function". Each marker is matched on text, whole word. */
export const SUBSPEC: { family: string; id: string; re: RegExp }[] = [
  { family: "sap", id: "sap.abap", re: /\babap\b|\bricef\b|\bbapi\b|\bbadi\b|\bcds views?\b|\bodata\b(?=.*abap)/i },
  { family: "sap", id: "sap.fiori_ui5", re: /\bfiori\b|\bui5\b|\bsapui5\b|\bopenui5\b/i },
  { family: "sap", id: "sap.integration", re: /\bcpi\b|\bbtp\b|\bpi\/po\b|\bsap pi\b|\bsap po\b|\bintegration suite\b|\bcloud integration\b/i },
  { family: "sap", id: "sap.functional_fico", re: /\bfico\b|\bfi\/co\b|\bs\/?4 ?hana finance\b|\bsap fi\b/i },
  { family: "sap", id: "sap.functional_logistics", re: /\bsap (mm|sd|pp|wm|ewm)\b|\bmm\/sd\b/i },
  { family: "sap", id: "sap.basis", re: /\bbasis\b(?= (admin|consultant|engineer))|\bsap basis\b/i },
  { family: "salesforce", id: "sf.dev", re: /\bapex\b|\blwc\b|\blightning web components?\b|\bvisualforce\b|\bsalesforce develop/i },
  { family: "salesforce", id: "sf.marketing_cloud", re: /\bmarketing cloud\b|\bsfmc\b|\bampscript\b|\bjourney builder\b|\bdata cloud\b|\bmarketing cloud next\b/i },
  { family: "salesforce", id: "sf.admin", re: /\bsalesforce admin(istrator)?\b|\bflows?\b(?= builder)|\bservice cloud\b(?= admin)/i },
  { family: "software", id: "eng.frontend", re: /\b(react(\.js)?|angular|vue(\.js)?|next\.js|frontend|front-end|ui engineer)\b/i },
  { family: "software", id: "eng.backend", re: /\b(backend|back-end|server-side|spring boot|node\.?js|nestjs|django|fastapi|golang|microservices?|apis?)\b/i },
  { family: "software", id: "eng.mobile", re: /\b(android|ios|kotlin|swift|flutter|react native)\b/i },
  { family: "lending", id: "lend.underwriting", re: /\b(credit underwrit\w*|underwrit\w*|credit appraisal|credit assessment|cam\b|credit analyst|risk assessment of (loan|borrower))/i },
  { family: "lending", id: "lend.operations", re: /\b(loan (operations|servicing|processing|disbursal|disbursement)|disbursal|disbursement|credit operations?|loan documentation|lms\b|los\b)/i },
  { family: "lending", id: "lend.collections", re: /\b(collections?|recovery|delinquen\w*|bucket|dpd)\b/i },
  { family: "data", id: "data.analyst", re: /\b(data analyst|business analyst|analytics|dashboards?|reporting|insights)\b/i },
  { family: "data", id: "data.scientist", re: /\b(data scientist|applied scientist|research scientist|machine learning|ml models?|modelling|modeling)\b/i },
  { family: "data", id: "data.engineer", re: /\b(data engineer\w*|etl|elt|pipelines?|airflow|spark|data platform)\b/i },
];
/** Full-stack means hands-on on both sides; a backend person is not full-stack because a posting says "full stack". */
export const FULLSTACK = /\bfull[- ]?stack\b/i;

/** Title rungs: what a title says about level and scope. */
export const RUNG: [RegExp, number, string][] = [
  [/\b(intern|trainee|apprentice|fresher|graduate engineer trainee)\b/i, 0, "entry"],
  [/\b(associate|junior|jr\.?|analyst\b(?! ii| iii)|executive)\b/i, 1, "junior"],
  [/\b(senior|sr\.?|ii\b|iii\b|specialist|consultant)\b/i, 2, "mid-senior"],
  [/\b(lead|staff|principal|architect|manager)\b/i, 3, "lead"],
  [/\b(senior manager|head|director|principal scientist|distinguished)\b/i, 4, "head"],
  [/\b(vp|vice president|chief|cxo|cto|cfo|coo|general manager)\b/i, 5, "executive"],
];
export function rungOf(title: string): { rung: number | null; word: string | null } {
  let best: { rung: number | null; word: string | null } = { rung: null, word: null };
  for (const [re, r, w] of RUNG) if (re.test(title) && (best.rung === null || r > best.rung)) best = { rung: r, word: w };
  return best;
}
/** Manager versus hands-on: a posting that manages people; a person who has led people (not just "led a project"). */
export const MANAGES = /\b(manage (a|the)? ?team|team of \d+|people manager|direct reports|line manage|lead (a|the) team of|build and lead (a|the)? ?team)\b/i;
export const HANDS_ON_ONLY = /\b(hands[- ]on|individual contributor|ic role|write code|coding)\b/i;

export function subspecs(text: string): string[] { return SUBSPEC.filter((s) => s.re.test(text)).map((s) => s.id); }
