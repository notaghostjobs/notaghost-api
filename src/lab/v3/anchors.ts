// Matching v3, improvement 2: specialist requirement anchors. An anchor is a capability that defines the job itself
// (SAP ABAP, Salesforce Marketing Cloud, FP&A, modern trade…). Anchors are kept apart from generic supporting skills:
// a defining anchor that the person has not demonstrated is flagged, and shared generic terms cannot make up for it.
// Vocabulary written from general domain knowledge, grouped by family; siblings in one family are different crafts.

export type Anchor = { id: string; family: string; re: RegExp; label: string };
export const ANCHORS: Anchor[] = [
  // SAP
  { family: "sap", id: "sap.abap", label: "SAP ABAP development", re: /\babap\b|\bricef\b|\bbapi\b|\bbadi\b|\bcds views?\b/i },
  { family: "sap", id: "sap.fiori_ui5", label: "SAP Fiori/UI5", re: /\bfiori\b|\b(sap)?ui5\b|\bopenui5\b/i },
  { family: "sap", id: "sap.integration", label: "SAP CPI/BTP integration", re: /\bcpi\b|\bbtp\b|\bpi\/po\b|\bsap p[io]\b|\bintegration suite\b/i },
  { family: "sap", id: "sap.fico", label: "SAP FICO", re: /\bfico\b|\bfi\/co\b|\bsap fi\b/i },
  { family: "sap", id: "sap.logistics", label: "SAP MM/SD/PP", re: /\bsap (mm|sd|pp|wm|ewm)\b|\bmm\/sd\b/i },
  { family: "sap", id: "sap.basis", label: "SAP Basis", re: /\bsap basis\b|\bbasis (admin|consultant)/i },
  // Salesforce
  { family: "salesforce", id: "sf.dev", label: "Salesforce platform development", re: /\bapex\b|\blwc\b|\blightning web components?\b|\bvisualforce\b|\bsalesforce (developer|development)\b/i },
  { family: "salesforce", id: "sf.marketing_cloud", label: "Salesforce Marketing Cloud", re: /\bmarketing cloud\b|\bsfmc\b|\bampscript\b|\bjourney builder\b/i },
  { family: "salesforce", id: "sf.cpq", label: "Salesforce CPQ / quote-to-cash", re: /\bcpq\b|\bquote[- ]to[- ]cash\b|\brevenue cloud\b/i },
  // software
  { family: "software", id: "eng.backend", label: "backend engineering", re: /\b(backend|back-end|server-side|spring boot|microservices?|golang|django|fastapi|nestjs)\b/i },
  { family: "software", id: "eng.frontend", label: "frontend engineering", re: /\b(react(\.js)?|angular|vue(\.js)?|next\.js|frontend|front-end)\b/i },
  { family: "software", id: "eng.mobile", label: "mobile engineering", re: /\b(android|ios|kotlin|swift|flutter|react native)\b/i },
  { family: "software", id: "eng.data", label: "data engineering", re: /\b(data engineer\w*|etl|elt|airflow|spark|data pipelines?)\b/i },
  { family: "software", id: "eng.ml", label: "machine learning", re: /\b(machine learning|deep learning|ml models?|llms?|nlp|computer vision|pytorch|tensorflow)\b/i },
  // lending and credit
  { family: "lending", id: "lend.underwriting", label: "credit underwriting", re: /\b(underwrit\w*|credit appraisal|credit assessment|credit analysis|credit memo|\bcam\b)/i },
  { family: "lending", id: "lend.operations", label: "lending operations", re: /\b(loan (operations|servicing|processing|disbursal|disbursement|documentation)|disburs\w+|credit operations?)\b/i },
  { family: "lending", id: "lend.collections", label: "collections", re: /\b(collections?|recovery|delinquen\w*|dpd)\b/i },
  // finance
  { family: "finance", id: "fin.fpa", label: "FP&A / business finance", re: /\b(fp&a|fp & a|financial planning|budgeting and forecasting|forecasting|business finance|variance analysis|annual operating plan|\baop\b)\b/i },
  { family: "finance", id: "fin.accounting", label: "accounting and close", re: /\b(general ledger|\bgl\b|month[- ]end close|book closure|accounts payable|accounts receivable|reconciliations?|statutory reporting|ind as|ifrs)\b/i },
  { family: "finance", id: "fin.audit", label: "audit", re: /\b(internal audit|statutory audit|audit (engagements?|planning)|sox testing)\b/i },
  { family: "finance", id: "fin.tax", label: "tax", re: /\b(direct tax|indirect tax|gst (filing|compliance)|transfer pricing|tax (compliance|returns))\b/i },
  { family: "finance", id: "fin.treasury", label: "treasury", re: /\b(treasury|cash management|liquidity management|fx hedging)\b/i },
  // sales and accounts
  { family: "sales", id: "sales.kam", label: "key account management", re: /\b(key accounts?|account management|account manager|client retention|upsell|cross[- ]sell|kam)\b/i },
  { family: "sales", id: "sales.new_business", label: "new-business sales", re: /\b(new business|business development|hunting|lead generation|enterprise sales|acquisition of (new )?clients|closing deals|quota)\b/i },
  { family: "sales", id: "sales.technical", label: "technical / pre-sales", re: /\b(pre[- ]?sales|solutions? (engineer|consultant|architect)|technical sales|sales engineer|proof of concept|\bpoc\b|rfp)\b/i },
  // marketing
  { family: "marketing", id: "mkt.ops", label: "marketing operations / automation", re: /\b(marketing (operations|automation)|campaign (management|operations|execution)|marketo|eloqua|hubspot|braze|clevertap|moengage)\b/i },
  { family: "marketing", id: "mkt.growth", label: "growth / performance marketing", re: /\b(growth marketing|performance marketing|user acquisition|cac|retention marketing|paid (media|social|search))\b/i },
  { family: "marketing", id: "mkt.brand", label: "brand marketing", re: /\b(brand (management|marketing|strategy)|atl|btl|brand campaigns?)\b/i },
  // retail, category and trade
  { family: "retail", id: "retail.category", label: "category management", re: /\b(category (management|manager)|assortment|merchandis\w+|vendor (management|negotiations?)|buying)\b/i },
  { family: "retail", id: "retail.modern_trade", label: "modern trade", re: /\bmodern trade\b|\bkey retail accounts\b|\b(large format|hypermarket|supermarket) (chains?|accounts?)\b/i },
  { family: "retail", id: "retail.general_trade", label: "general trade / distribution", re: /\b(general trade|distributor management|distribution network|retail outlets|beat plan)\b/i },
  // operations and support
  { family: "ops", id: "ops.warehouse", label: "warehouse / logistics operations", re: /\b(warehouse|fulfil?ment cent(re|er)|inventory control|last[- ]mile|logistics operations)\b/i },
  { family: "ops", id: "ops.app_support", label: "application / production support", re: /\b(application support|production support|l2 support|l3 support|incident management|itil|servicenow)\b/i },
  { family: "ops", id: "ops.customer_service", label: "customer service", re: /\b(customer service|customer support|call cent(re|er)|contact cent(re|er)|voice process)\b/i },
  // data and research
  { family: "data", id: "data.analyst", label: "data / business analysis", re: /\b(data analyst|business analyst|analytics|dashboards?|sql reporting)\b/i },
  { family: "data", id: "data.science", label: "data science", re: /\b(data scientist|applied scientist|machine learning|predictive model(l)?ing|statistical model(l)?ing)\b/i },
];
const NOT_ML_MODELLING = /\bfinancial model(l)?ing\b/gi;   // "financial modelling" is FP&A, not data science
const byId = new Map(ANCHORS.map((a) => [a.id, a]));
export const anchorsIn = (text: string) => ANCHORS.filter((a) => a.re.test(text.replace(NOT_ML_MODELLING, "financial planning"))).map((a) => a.id);

export type CandidateAnchors = { demonstrated: Map<string, string>; claimed: Map<string, string> };
/** Anchors the person shows in work, achievement or project lines and role titles (demonstrated), versus skills lists
 *  and summary claims only (claimed). Each carries the line it was read from. */
export function candidateAnchors(c: { roles: { title: string }[]; work_lines: string[]; achievement_lines: string[]; project_lines: string[]; listed_lines: string[]; summary_lines: string[] }): CandidateAnchors {
  const demonstrated = new Map<string, string>(), claimed = new Map<string, string>();
  for (const l of [...c.roles.map((r) => r.title || ""), ...c.work_lines, ...c.achievement_lines, ...c.project_lines]) for (const id of anchorsIn(l)) if (!demonstrated.has(id)) demonstrated.set(id, l);
  for (const l of [...c.listed_lines, ...c.summary_lines]) for (const id of anchorsIn(l)) if (!demonstrated.has(id) && !claimed.has(id)) claimed.set(id, l);
  return { demonstrated, claimed };
}

export type JobAnchors = { defining: { id: string; source: "title" | "specialisation" | "mandatory"; quote: string }[] };
/** Anchors that define the job: those in the title first; then the extracted specialisation; then mandatory
 *  tool/domain requirements. Supporting skills elsewhere in the posting are not anchors. */
export function jobAnchors(job: { title: string; cjr?: any; det?: any }): JobAnchors {
  const out: JobAnchors["defining"] = []; const add = (id: string, source: JobAnchors["defining"][number]["source"], quote: string) => { if (!out.some((x) => x.id === id)) out.push({ id, source, quote }); };
  for (const id of anchorsIn(job.title)) add(id, "title", job.title);
  const spec = job.cjr ? `${job.cjr.function ?? ""}; ${job.cjr.specialisation ?? ""}` : (job.det?.specialisation?.evidence ?? []).map((e: any) => e.quote ?? e).join("; ");
  if (!out.length) for (const id of anchorsIn(spec)) add(id, "specialisation", spec.slice(0, 200));
  if (job.cjr) for (const m of job.cjr.mandatory) if (m.kind === "tool" || m.kind === "domain") for (const id of anchorsIn(m.quote ?? m.text)) if (!out.length || out.some((x) => byId.get(x.id)!.family === byId.get(id)!.family)) add(id, "mandatory", (m.quote ?? m.text).slice(0, 200));
  return { defining: out };
}

export type AnchorCheck = { status: "met" | "partial" | "claimed_only" | "sibling_only" | "missing" | "none"; detail: { id: string; label: string; status: string; quote: string | null }[] };
/** Every defining anchor is checked on its own. "sibling_only": the person works in the same family but a different
 *  craft (ABAP for a Fiori job). Generic overlap never changes these statuses. */
export function checkAnchors(ja: JobAnchors, ca: CandidateAnchors): AnchorCheck {
  if (!ja.defining.length) return { status: "none", detail: [] };
  const fams = new Set([...ca.demonstrated.keys()].map((id) => byId.get(id)!.family));
  const detail = ja.defining.map((d) => { const a = byId.get(d.id)!; const q = ca.demonstrated.get(d.id) ?? null;
    const status = q ? "met" : ca.claimed.has(d.id) ? "claimed_only" : fams.has(a.family) ? "sibling_only" : "missing"; return { id: d.id, label: a.label, status, quote: q ?? ca.claimed.get(d.id) ?? null }; });
  // all met → met; some met, others not → partial (soft: e.g. a full-stack posting for a backend engineer);
  // none met → the best of the rest decides (claimed only > sibling craft only > missing)
  const met = detail.filter((d) => d.status === "met").length;
  if (met === detail.length) return { status: "met", detail };
  if (met > 0) return { status: "partial", detail };
  const rank = ["missing", "sibling_only", "claimed_only"]; const best = detail.reduce((b, d) => (rank.indexOf(d.status) > rank.indexOf(b) ? d.status : b), "missing");
  return { status: best as AnchorCheck["status"], detail };
}
export const anchorLabel = (id: string) => byId.get(id)?.label ?? id;
