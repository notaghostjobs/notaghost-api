// Offline check of the India short list's free pass, on real open titles from 24 Nov (titles and employers only).
// A category-management director must get the category, merchandising and sourcing leadership roles to read closely,
// and never an associate-grade role. No network.
import { closest, keywords, levelOf, near, type Row } from "../lib/usmatch.js";

const open: [string, string][] = [
  ["Deputy Director - Category Management", "Myntra"], ["Deputy Director - Category Management (Beauty & Personal Care)", "Myntra"], ["Deputy Director - Central Revenue Planning", "Myntra"],
  ["Senior Manager - Category Management", "Myntra"], ["Senior Manager - Category Marketing", "Myntra"], ["Lead Associate - Category Management", "Myntra"], ["Lead Associate - Marketplace", "Myntra"],
  ["Principal Associate - Category Demand Management (Project)", "Myntra"], ["Associate Director - Product Strategy & Marketing", "Myntra"],
  ["Senior Manager, Category Management", "PhonePe"], ["Business Analytics Lead (7+ Years) - Consumer", "PhonePe"],
  ["Category & Merchandising Head – Sarees & Ethnic Wear", "Titan Company"], ["Head-Indirect Procurement", "Titan Company"],
  ["Sourcing Director,Men's Bottoms (Denim & Non-denim)", "Quince"], ["Senior Manager, Global Procurement - Men's Apparel", "Quince"], ["Senior Manager, Global Procurement - Women Knits & Woven Tops", "Quince"],
  ["business category lead – UPI + BBPS", "CRED"], ["issuance growth lead", "CRED"], ["Business Head, Owndays Japan", "Lenskart"],
  ["Director - Small and Medium Businesses , Retail Business Services SPEG", "Amazon"], ["Head, Linehaul Procurement, Amazon India Operations", "Amazon"], ["Team Lead, Operations", "Amazon"], ["FBA Operations Lead, IN FBA", "Amazon"], ["Sr. Manager - Easy Ship Operations, IN External Fulfillment", "Amazon"],
  ["Capital Markets Operations Sr Manager", "Accenture"], ["Order to Cash Operations Senior Manager", "Accenture"], ["Corporate Strategy Senior Manager", "Accenture"], ["Delivery Operations Team Lead", "Accenture"], ["Service Delivery Operations Lead", "Accenture"], ["Business Transformation Senior Manager", "Accenture"],
  ["Senior Manager, Business Operations", "Conduent"], ["Director, Business Intelligence Services", "Conduent"], ["Director - Plant Operations", "Cargill India"], ["Head of Hospital Operations", "Narayana Nethralaya"],
  ["Billing Operations Vice President", "JPMorgan Chase Bank"], ["Global Billing Operations , Vice President", "State Street"], ["Operations Team Lead (Night Shift)", "Stripe"], ["Director, Corporate Operations - India", "Scopely"],
  ["Sr. Manager, Strategy and Business Operations", "Smartsheet"], ["Director of Cyber Defense Operations , ITC", "Nike"], ["Senior Manager, Total Rewards Operations", "GitLab"], ["Customer Operations Lead", "Ethos Life"],
  ["Managed Services - GFF Operations - Director", "PwC"], ["PROJECT OPERATIONS LEAD L1", "Wipro"], ["Process Excellence Lead Banking Operations", "Wipro"], ["Senior Manager - Ad Operations", "Amagi"], ["Head of Revenue - India", "Plotline"],
];
// a few hundred unrelated "manager" and "operations" titles, as the real pool has
for (let i = 0; i < 400; i++) open.push([`${["Operations", "Program", "Delivery", "Service", "Finance", "Engineering"][i % 6]} Manager ${i}`, `Employer ${i % 90}`]);

const titles = ["Director of Operations", "Head of Category Management", "Business Unit Head", "Head of Business Operations", "General Manager"];
const domain = ["category", "merchandising", "sourcing", "procurement", "marketplace", "assortment", "pricing"];
const level = "leader" as const;

const lv = (t: string) => levelOf(t);
const checks: [string, string][] = [["Principal Associate - Category Demand Management (Project)", "mid"], ["Lead Associate - Category Management", "mid"], ["Associate Director - Product Strategy & Marketing", "leader"], ["Deputy Director - Category Management", "leader"], ["Team Lead, Operations", "mid"], ["Senior Manager, Category Management", "senior"], ["Associate Product Manager", "senior"], ["Software Engineer I", "entry"]];
let bad = checks.filter(([t, want]) => lv(t) !== want).map(([t, want]) => `${t}: ${lv(t)} (want ${want})`);
console.log("search words:", keywords(titles, 10, domain).join(", "));
const rows: Row[] = open.filter(([t]) => near(level).includes(lv(t))).map(([t, c], i) => ({ system: "in", ref: c, job_id: String(i), title: t, location: "Bengaluru", remote: false, url: "", posted_at: new Date(Date.now() - 20 * 864e5).toISOString(), level: lv(t), func: null }));
const top = closest(rows, titles, level, 40, Date.now(), domain);
const names = top.map((r) => `${r.title} · ${r.ref}`);
console.log(names.slice(0, 14).join("\n"));
const must = ["Deputy Director - Category Management · Myntra", "Category & Merchandising Head – Sarees & Ethnic Wear · Titan Company", "Sourcing Director,Men's Bottoms (Denim & Non-denim) · Quince", "Senior Manager, Category Management · PhonePe", "business category lead – UPI + BBPS · CRED", "Head, Linehaul Procurement, Amazon India Operations · Amazon"];
const first12 = names.slice(0, 14);
for (const m of must) if (!first12.includes(m)) bad.push(`not in the first fourteen: ${m}`);
if (names.some((n) => /Associate - /.test(n) && !/Associate Director/.test(n))) bad.push("an associate-grade role was kept");
if (bad.length) { console.error("FAILED\n" + bad.join("\n")); process.exit(1); }
console.log("all right");
