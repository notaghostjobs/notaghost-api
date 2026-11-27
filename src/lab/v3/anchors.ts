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
  { family: "lending", id: "lend.operations", label: "lending operations", re: /\b(loan (operations|servicing|processing|disbursal|disbursement|documentation|modifications?)|processing of (mortgage |home |personal )?loans|mortgage (processing|servicing|operations|loans?)|disburs\w+|credit operations?|escrow|foreclosure)\b/i },
  { family: "lending", id: "lend.collections", label: "collections", re: /\b(collections?|recovery|delinquen\w*|dpd)\b/i },
  // finance
  { family: "finance", id: "fin.fpa", label: "FP&A / business finance", re: /\b(fp&a|fp & a|financial planning|budgeting and forecasting|forecasting|business finance|variance analysis|annual operating plan|\baop\b)\b/i },
  { family: "finance", id: "fin.accounting", label: "accounting and close", re: /\b(accountants?|accounting (manager|analyst|operations|specialist|associate|executive|lead)|(manager|specialist|analyst|lead|head|director),? (of )?accounting|(financial|general|cost|management|technical|capital assets?) accounting|general ledger|ledger (sme|accountant)|\bgl\b|month[- ]end close|book closure|accounts payable|accounts receivable|record[- ]to[- ]report|\br2r\b|order[- ]to[- ]cash|\bo2c\b|procure[- ]to[- ]pay|\bp2p\b|bookkeep\w+|financial reporting|controllership|legal entity controller|(ledger|gl|intercompany|balance[- ]sheet|account) reconciliations?|statutory reporting|ind as|ifrs)\b/i },
  { family: "finance", id: "fin.audit", label: "audit", re: /\b((internal|statutory|external|it|regulatory|senior|lead) auditors?|internal audit|statutory audit|it audit|regulatory audit|audit (engagements?|planning|manager|associate|senior)|sox testing)\b/i },
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
  { family: "it_ops", id: "ops.app_support", label: "application / production support", re: /\b(application support|production support|l2 support|l3 support|incident management|itil|servicenow)\b/i },
  { family: "ops", id: "ops.customer_service", label: "customer service", re: /\b(customer service|customer support|call cent(re|er)|contact cent(re|er)|voice process)\b/i },
  // data and research
  { family: "data", id: "data.analyst", label: "data / business analysis", re: /\b(data analyst|business analyst|analytics|dashboards?|sql reporting)\b/i },
  { family: "data", id: "data.science", label: "data science", re: /\b(data scientist|applied scientist|machine learning|predictive model(l)?ing|statistical model(l)?ing)\b/i },
  // v3.1 coverage additions (27 Nov 2026, before any fresh-profile run): written from general job-family definitions
  // (standard HR, product, supply-chain, legal, healthcare, IT-infrastructure, customer-success, content, admin and
  // teaching role descriptions) and checked only against synthetic fixtures — not against any candidate outcome.
  { family: "software", id: "eng.devops", label: "DevOps / SRE / cloud infrastructure", re: /\b(devops|site reliability|\bsre\b|kubernetes|terraform|ci\/cd|infrastructure as code)\b/i },
  { family: "software", id: "eng.qa", label: "QA / test engineering", re: /\b(quality assurance engineer|qa engineer|test automation|automation testing|selenium|manual testing|sdet)\b/i },
  { family: "software", id: "eng.security", label: "information security", re: /\b(cyber ?security|information security|\bsoc\b analyst|vapt|penetration test\w*|security operations|\biam\b)\b/i },
  { family: "hr", id: "hr.talent_acquisition", label: "recruitment / talent acquisition", re: /\b(talent acquisition|recruit(er|ment|ing)|sourcing candidates|end[- ]to[- ]end hiring|campus hiring)\b/i },
  { family: "hr", id: "hr.hrbp", label: "HR business partnering / employee relations", re: /\b(hr ?business partner|hrbp|employee relations|people partner|performance management cycle)\b/i },
  { family: "hr", id: "hr.comp_payroll", label: "payroll / compensation and benefits", re: /\b(payroll|compensation (and|&) benefits|c&b|total rewards)\b/i },
  { family: "hr", id: "hr.learning", label: "learning and development", re: /\b(learning (and|&) development|\bl&d\b|training programmes?|training programs?|instructional design)\b/i },
  { family: "product", id: "product.management", label: "product management", re: /\b(product manager|product management|product roadmap|\bprds?\b|product discovery|product owner)\b/i },
  { family: "product", id: "product.design", label: "product / UX design", re: /\b(ux|ui\/ux|user experience|interaction design|user research|figma|product designer)\b/i },
  { family: "product", id: "product.program", label: "programme / project / delivery management", re: /\b(program(me)? manager|technical program|\btpm\b|project (manager|coordinator)|\bpmo\b|\bpmp\b|delivery manager|scrum master)\b/i },
  { family: "scm", id: "scm.procurement", label: "procurement / sourcing", re: /\b(procurement|strategic sourcing|purchase orders?|supplier (management|onboarding|negotiation))\b/i },
  { family: "scm", id: "scm.planning", label: "demand / supply planning", re: /\b(demand planning|supply planning|s&op|inventory planning|replenishment planning)\b/i },
  { family: "legal", id: "legal.counsel", label: "legal counsel / contracts", re: /\b(legal counsel|contract (drafting|negotiation|review)|litigation|corporate law|\bllb\b|advocate)\b/i },
  { family: "legal", id: "legal.compliance", label: "regulatory compliance", re: /\b(regulatory compliance|compliance officer|compliance (monitoring|testing|reviews?)|kyc|aml|anti[- ]money laundering|sanctions screening)\b/i },
  { family: "health", id: "health.clinical", label: "clinical practice", re: /\b(clinical practice|patient care|nursing|physician|\bmbbs\b|staff nurse|clinic(al)? operations)\b/i },
  { family: "health", id: "health.research_reg", label: "clinical research / regulatory affairs", re: /\b(clinical research|clinical trials?|regulatory affairs|pharmacovigilance|medical coding|medical writing)\b/i },
  { family: "cx", id: "cx.customer_success", label: "customer success", re: /\b(customer success|client onboarding|renewals|churn reduction|net revenue retention|\bnrr\b)\b/i },
  { family: "content", id: "content.writing", label: "content / copywriting", re: /\b(content writ\w+|copywrit\w+|content strategy|editorial|technical writ\w+)\b/i },
  { family: "admin", id: "admin.office", label: "executive assistance / office administration", re: /\b(executive assistant|office administration|front office|calendar management|personal assistant)\b/i },
  { family: "education", id: "edu.teaching", label: "teaching / training delivery", re: /\b(teacher|teaching|faculty|lecturer|curriculum|lesson plans?)\b/i },
  // v3.2 coverage additions (27 Nov 2026, after the three-candidate pilot showed whole areas with no anchor). Written
  // from general job-family definitions for areas the vocabulary did not cover, not from any candidate's résumé or
  // result; checked against synthetic fixtures (v3.test.mts).
  { family: "software", id: "eng.general", label: "software engineering", re: /\b(software (engineer\w*|develop\w+)|\bsde\b|full[- ]stack|programmer|application develop\w+|(java|python|\.net|c\+\+|golang) developer)\b/i },
  { family: "software", id: "eng.embedded", label: "embedded / firmware", re: /\b(embedded (systems?|software|c\b|linux)|firmware|\brtos\b|device drivers?|microcontrollers?)\b/i },
  { family: "it_ops", id: "eng.infra_it", label: "networking / IT infrastructure", re: /\b(network (engineer\w*|administrat\w+|operations)|\bccna\b|\bccnp\b|routing and switching|system administrat\w+|linux administrat\w+|windows server|it infrastructure|desktop support|service desk|helpdesk)\b/i },
  { family: "it_ops", id: "eng.dba", label: "database administration", re: /\b(database administrat\w+|\bdba\b)\b/i },
  { family: "hardware", id: "hw.vlsi", label: "chip design / verification", re: /\b(vlsi|rtl design|\basic\b|\bfpga\b|verilog|physical design|design verification|soc design)\b/i },
  { family: "engineering", id: "engg.mechanical", label: "mechanical / manufacturing engineering", re: /\b(mechanical (engineer\w*|design)|solidworks|catia|\bcreo\b|ansys|gd&t|manufacturing engineer\w*|production engineer\w*|tool design)\b/i },
  { family: "engineering", id: "engg.electrical", label: "electrical / controls engineering", re: /\b(electrical (engineer\w*|design)|power systems?|switchgear|\bplc\b|\bscada\b|instrumentation engineer\w*)\b/i },
  { family: "engineering", id: "engg.civil", label: "civil / construction engineering", re: /\b(civil engineer\w*|structural (engineer\w*|design)|site engineer|quantity survey\w+|construction management)\b/i },
  { family: "engineering", id: "engg.quality", label: "manufacturing quality", re: /\b(quality (engineer\w*|control)|iso 9001|\bqms\b|supplier quality|\bapqp\b|\bppap\b)\b/i },
  { family: "insurance", id: "ins.claims", label: "insurance claims", re: /\b(claims? (processing|adjudication|settlements?|handling|management|examiner|adjuster|assessor|supervisor|analyst|operations|department)|\btpa\b)\b/i },
  { family: "insurance", id: "ins.policy_admin", label: "insurance policy administration", re: /\b(policy (administration|admin|servicing|issuance|endorsements?|renewals?)|policy ?holder services|new business processing|insurance (operations|back[- ]office|processing|department))\b/i },
  { family: "actuarial", id: "act.actuarial", label: "actuarial", re: /\b(actuar(y|ial|ies)|\bifoa\b|actuarial (reserving|pricing|valuation))\b/i },
  { family: "banking_ops", id: "bank.payments", label: "payments / cash operations", re: /\b(payments? (operations|processing|investigations?)|(payment|cash|trade|securities) settlements?|\bswift\b|\bnostro\b|remittances?|clearing operations|cash matching)\b/i },
  { family: "banking_ops", id: "bank.markets_ops", label: "trade finance / capital-markets operations", re: /\b(trade finance|letters? of credit|trade (support|operations)|middle office|corporate actions|fund accounting|custody operations|securities operations|derivatives operations|investment operations|nav calculation|investor reporting|trustee operations)\b/i },
  { family: "banking_front", id: "bank.relationship", label: "relationship / branch banking", re: /\b(relationship manager|branch banking|\bcasa\b|wealth management|priority banking|private banking)\b/i },
  { family: "bizops", id: "bizops.service_delivery", label: "service delivery / back-office operations", re: /\b(service delivery|delivery operations|\bbpo\b|business process (outsourcing|services|operations)|back[- ]office operations|operations (team )?(lead|leader|manager|supervisor)|transaction processing|sla (management|adherence))\b/i },
  { family: "bizops", id: "bizops.process_excellence", label: "process excellence / quality", re: /\b(process excellence|lean six sigma|six sigma|black belt|green belt|kaizen|process quality audits?)\b/i },
  { family: "finance", id: "fin.risk", label: "risk management", re: /\b(credit risk|market risk|operational risk|enterprise risk|risk (analyst|manager|modell?ing))\b/i },
  { family: "finance", id: "fin.investment", label: "investment / equity research", re: /\b(equity research|investment (banking|analyst|research)|investment portfolios?|private equity|m&a)\b/i },
  { family: "consulting", id: "consult.management", label: "management consulting", re: /\b(management consult\w+|strategy consult\w+|business consult\w+|consulting engagements?)\b/i },
  { family: "sales", id: "sales.ops", label: "sales / revenue operations", re: /\b(sales operations|revenue operations|\brevops\b|sales enablement|crm administration)\b/i },
  { family: "marketing", id: "mkt.digital", label: "digital / content marketing", re: /\b(digital marketing|social media (marketing|management)|content marketing|\bseo\b|\bsem\b)\b/i },
  { family: "marketing", id: "mkt.product", label: "product marketing", re: /\b(product marketing|go[- ]to[- ]market|\bgtm\b|positioning and messaging)\b/i },
  { family: "hr", id: "hr.operations", label: "HR operations / shared services", re: /\b(hr operations|hr shared services|\bhris\b|workday hcm|successfactors|employee onboarding)\b/i },
  { family: "admin", id: "admin.facilities", label: "facilities / workplace administration", re: /\b(facilit(y|ies) management|workplace services|travel desk|administration manager)\b/i },
  { family: "design", id: "design.graphic", label: "graphic / visual design", re: /\b(graphic design\w*|visual design\w*|adobe (photoshop|illustrator|indesign)|motion graphics|video edit\w+)\b/i },
  { family: "health", id: "health.pharmacy", label: "pharmacy", re: /\b(pharmacists?|pharmacy (operations|practice)|dispensing)\b/i },
  { family: "science", id: "sci.lab", label: "laboratory / R&D science", re: /\b(research scientist|laboratory (analysis|testing|techniques)|analytical chemistry|\bhplc\b|molecular biology|formulation development)\b/i },
];
/** Families whose crafts are near neighbours: a different craft in the same family is "neighbour", not a hard
 *  "sibling_only" (claims and policy administration; payments and markets operations). */
export const SOFT_FAMILIES = new Set(["insurance", "banking_ops", "bizops", "it_ops"]);
/** Wrapper crafts: "service delivery" and "operations lead" titles sit on top of any domain (finance delivery, claims
 *  delivery, IT delivery). They count for a person who shows them or a neighbouring craft, and are never held against
 *  one who does not: the domain anchors and the judge decide. */
export const OPEN_ANCHORS = new Set(["bizops.service_delivery"]);
/** Families that are neighbours of one another: back-office operations in financial services. Accounting, audit and
 *  actuarial work (families "finance", "actuarial") are deliberately not in this group: sharing an industry's
 *  vocabulary does not make them the same work. */
export const FAMILY_GROUPS: string[][] = [["lending", "insurance", "banking_ops", "bizops"]];
/** Umbrella crafts: demonstrated by any of the listed specialisms. */
export const IMPLIED_BY: Record<string, string[]> = { "eng.general": ["eng.backend", "eng.frontend", "eng.mobile", "eng.data", "eng.ml", "eng.embedded"] };
const groupOf = (family: string) => FAMILY_GROUPS.find((g) => g.includes(family)) ?? null;
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
  // an umbrella craft is shown by any of its specialisms (a backend engineer is a software engineer), never the reverse
  for (const [umbrella, parts] of Object.entries(IMPLIED_BY)) { if (!demonstrated.has(umbrella)) { const d = parts.find((x) => demonstrated.has(x)); if (d) demonstrated.set(umbrella, demonstrated.get(d)!); } if (!demonstrated.has(umbrella) && !claimed.has(umbrella)) { const cl = parts.find((x) => claimed.has(x)); if (cl) claimed.set(umbrella, claimed.get(cl)!); } }
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

export type AnchorCheck = { status: "met" | "partial" | "claimed_only" | "neighbour" | "sibling_only" | "missing" | "unrecognised" | "none"; detail: { id: string; label: string; status: string; quote: string | null; source?: string }[] };
/** Every defining anchor is checked on its own. "sibling_only": the person works in the same family but a different
 *  craft (ABAP for a Fiori job). Generic overlap never changes these statuses. */
export function checkAnchors(ja: JobAnchors, ca: CandidateAnchors): AnchorCheck {
  if (!ja.defining.length) return { status: "none", detail: [] };
  // a vocabulary gap is not a capability gap: when none of the person's own work maps to any anchor, the anchors say
  // nothing about them and the judge's evidence decides (v3.1)
  if (!ca.demonstrated.size && !ca.claimed.size) return { status: "unrecognised", detail: ja.defining.map((d) => ({ id: d.id, label: byId.get(d.id)!.label, status: "unrecognised", quote: null })) };
  const fams = new Set([...ca.demonstrated.keys()].map((id) => byId.get(id)!.family));
  // for "is this a neighbouring craft" the person's claimed crafts count too: a claim places them in a field, it does
  // not show the craft itself (a claimed craft is never "met")
  const field = new Set([...fams, ...[...ca.claimed.keys()].map((id) => byId.get(id)!.family)]);
  const detail: AnchorCheck["detail"] = ja.defining.map((d) => { const a = byId.get(d.id)!; const q = ca.demonstrated.get(d.id) ?? null;
    // same family, different craft: a hard sibling, except in families of near-neighbour crafts; a neighbouring
    // family in the same group is "neighbour" too (v3.2)
    const g = groupOf(a.family); const near = (field.has(a.family) && SOFT_FAMILIES.has(a.family)) || (!fams.has(a.family) && !!g && [...field].some((f) => g.includes(f)));
    const status = q ? "met" : ca.claimed.has(d.id) ? "claimed_only" : near ? "neighbour" : fams.has(a.family) ? "sibling_only" : "missing"; return { id: d.id, label: a.label, status, quote: q ?? ca.claimed.get(d.id) ?? null, source: d.source }; });
  for (let i = detail.length - 1; i >= 0; i--) if (OPEN_ANCHORS.has(detail[i].id) && (detail[i].status === "missing" || detail[i].status === "sibling_only")) detail.splice(i, 1);
  if (!detail.length) return { status: "none", detail: [] };
  // all met → met; some met, others not → partial (soft: e.g. a full-stack posting for a backend engineer);
  // none met → the best of the rest decides (claimed only > sibling craft only > missing)
  const met = detail.filter((d) => d.status === "met").length;
  if (met === detail.length) return { status: "met", detail };
  if (met > 0) return { status: "partial", detail };
  const rank = ["missing", "sibling_only", "neighbour", "claimed_only"]; const best = detail.reduce((b, d) => (rank.indexOf(d.status) > rank.indexOf(b) ? d.status : b), "missing");
  return { status: best as AnchorCheck["status"], detail };
}
export const anchorLabel = (id: string) => byId.get(id)?.label ?? id;
