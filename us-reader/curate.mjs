// Curation: which of the open US roles are worth putting in front of a person. Pure functions, no network.
// The aim is the opposite of "millions of jobs": one entry per real role, fresh, from the employer that is hiring,
// with nothing that is commission-only or reposted by a middleman.

const words = (re, s) => re.test(s);
// A middleman's own words. "Our clients" alone is not enough: law firms and consultancies say it about the people they serve.
const MIDDLEMAN = /\b(on behalf of (?:a|an|our|one of our|its) (?:partner|client|customer)s?(?: compan(?:y|ies))?|posted by \w+ on behalf|(?:we are|is) (?:a|an) (?:staffing|recruit\w+|talent acquisition) (?:agency|firm|partner)|(?:staffing|recruitment) agency|this (?:job|position|role) is (?:posted|sourced|advertised) (?:by|from|on behalf))\b/i;
// Boards known to repost other employers' roles. Their roles are left out whatever the wording.
export const REPOSTERS = new Set(["jobgether"]);
const COMMISSION = /\b(commission[- ]only|100% commission|1099 (?:contractor|position|independent)|be your own boss|unlimited (?:income|earning) potential|no experience (?:needed|necessary|required)[^.]{0,80}(?:sales|agent)|licensed? (?:life|insurance) agent)\b/i;
/** What a posting says about visas, when it says anything. */
export function visa(text) {
  const no = /\b(not|unable to|cannot|can't|won't|will not|do(?:es)? not)\b[^.]{0,60}\b(sponsor\w*|visa)\b|without (?:the need for )?(?:visa )?sponsorship|no (?:visa )?sponsorship|must be (?:a )?(?:u\.?s\.? citizen|us citizen)|u\.?s\.? citizenship (?:is )?required|security clearance/i;
  const yes = /\b(visa sponsorship (?:is )?(?:available|offered|provided)|we (?:do )?sponsor|will sponsor|sponsorship (?:is )?available|h-?1b (?:sponsorship|transfer)s? (?:is |are )?(?:available|welcome|supported))\b/i;
  return no.test(text) ? "no" : yes.test(text) ? "yes" : "unstated";
}
export function level(title) {
  if (/\b(intern|internship|co-?op|apprentice)\b/i.test(title)) return "intern";
  if (/\b(new grad|graduate|entry[- ]level|junior|jr\.?|associate|early career|i\b(?!i))\b/i.test(title) && !/\b(senior|sr\.?|director|manager|lead|principal|staff)\b/i.test(title)) return "entry";
  if (/\b(chief|vp|vice president|head of|director|principal|distinguished|fellow)\b/i.test(title)) return "leader";
  if (/\b(senior|sr\.?|staff|lead|manager|iii|iv)\b/i.test(title)) return "senior";
  return "mid";
}
const FUNCS = [["engineering", /\b(engineer|developer|software|sre|devops|architect|firmware|hardware|qa|security)\b/i], ["data", /\b(data|analyst|analytics|scientist|machine learning|\bml\b|\bai\b|research)\b/i], ["product", /\bproduct (?:manager|owner|lead|director)|\bproduct management\b|\bprogram manager\b|\btpm\b/i],
  ["design", /\b(designer|design|ux|ui|creative)\b/i], ["sales", /\b(sales|account executive|business development|\bbdr\b|\bsdr\b|account manager|partnerships?)\b/i], ["marketing", /\b(marketing|growth|content|brand|communications|seo|social media)\b/i],
  ["finance", /\b(finance|financial|accountant|accounting|controller|fp&a|tax|treasury|audit)\b/i], ["people", /\b(recruit\w*|talent|people|human resources|\bhr\b)\b/i], ["support", /\b(support|customer success|customer service|customer experience|implementation)\b/i],
  ["operations", /\b(operations|logistics|supply chain|warehouse|facilities|procurement)\b/i], ["healthcare", /\b(nurse|physician|therapist|clinical|veterinar\w*|medical|dental|caregiver|pharmac\w*)\b/i], ["legal", /\b(counsel|legal|paralegal|attorney|compliance)\b/i]];
export const func = (title) => (FUNCS.find(([, re]) => re.test(title)) ?? ["other"])[0];

/** One employer's US roles in, the roles worth showing out, with the reason each of the others was left behind. */
export function curate(jobs, { now = Date.now(), freshDays = 60, ref = "" } = {}) {
  const us = jobs.filter((j) => j.us);
  const why = { not_fresh: 0, thin_text: 0, same_role_elsewhere: 0, middleman: 0, commission: 0 };
  // a board where most postings speak of "our client" belongs to a middleman, not to the employer that is hiring
  const mm = us.filter((j) => words(MIDDLEMAN, j.text)).length;
  const middleman = REPOSTERS.has(String(ref).toLowerCase()) || (us.length >= 5 && mm / us.length > 0.3);
  if (middleman) { why.middleman = us.length; return { keep: [], why, middleman: true }; }
  const seen = new Map(), keep = [];
  for (const j of us) {
    const age = j.posted_at ? (now - Date.parse(j.posted_at)) / 86400e3 : Infinity;
    if (!(age <= freshDays)) { why.not_fresh++; continue; }
    if (j.text.length < 400) { why.thin_text++; continue; }
    if (words(MIDDLEMAN, j.text)) { why.middleman++; continue; }
    if (words(COMMISSION, j.text)) { why.commission++; continue; }
    // the same role advertised in forty towns is one role: the first is kept and carries the count of places
    const key = j.title.toLowerCase().replace(/\s*[-–(|,@].*$/, "").replace(/\s+/g, " ").trim();
    const first = seen.get(key);
    if (first) { first.places++; why.same_role_elsewhere++; continue; }
    const one = { ...j, places: 1, level: level(j.title), func: func(j.title), visa: visa(j.text) };
    seen.set(key, one); keep.push(one);
  }
  return { keep, why, middleman: false };
}
