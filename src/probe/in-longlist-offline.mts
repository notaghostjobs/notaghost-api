// Offline check of change 1: the India free list takes its long list from Radar's search (rarity-weighted titles) instead
// of "any title word, newest 1,000". Real open Bengaluru titles and employers, read from our own inventory on 24 Nov 2026
// (titles and employers only; no posting text, no person's data). No network, no model.
process.env.SUPABASE_URL ??= "https://offline.invalid"; process.env.SUPABASE_SERVICE_ROLE_KEY ??= "offline";
const { titleIdf, shortlistFor } = await import("../routes/radar.js");
const { keywords } = await import("../lib/usmatch.js");

const real: [string, string, string][] = [   // first seen, employer, title
  ["2026-11-12", "Myntra", "Deputy Director - Category Management"], ["2026-11-09", "Myntra", "Senior Manager - Category Management"], ["2026-11-09", "Myntra", "Lead Associate - Category Management"],
  ["2026-11-09", "Myntra", "Lead Associate - Marketplace"], ["2026-11-09", "Myntra", "Principal Associate - Hyperlocal - Assortment"], ["2026-11-09", "Myntra", "Senior Manager - Category Marketing"],
  ["2026-11-09", "PHONEPE LIMITED", "Manager, Category Operations"], ["2026-11-20", "CRED", "business category lead – UPI + BBPS"], ["2026-11-09", "Titan Company", "Manager-Category & Site Merchandising"],
  ["2026-11-09", "Titan Company", "Head-Indirect Procurement"], ["2026-11-04", "Quince", "Sourcing Director,Men's Bottoms (Denim & Non-denim)"], ["2026-10-28", "Quince", "Senior Manager, Global Procurement - Men's Apparel"],
  ["2026-10-24", "Amazon", "Manager, Category Management, Home Entertainment"], ["2026-10-24", "Amazon", "Category Manager(GPO), IN GPO"], ["2026-10-24", "Amazon", "Category Manager, Personal Computing and IOT"],
  ["2026-10-24", "Amazon", "Category Manager- IN Apparel, IN Apparel, Category"], ["2026-10-24", "Amazon", "Category Manager , Books (SL-1)"], ["2026-10-24", "Amazon", "Category Manager, International Emerging Stores"],
  ["2026-10-24", "Amazon", "Category Marketing Manager, IN Apparel"], ["2026-10-24", "Amazon", "Head, Linehaul Procurement, Amazon India Operations"], ["2026-11-21", "Thales", "Category manager"],
  ["2026-10-24", "Bosch Global Software Technologies", "Global Category Buyer - Assistant Manager/ Deputy manager"], ["2026-11-10", "Bosch Global Software Technologies", "Marketplace Growth Manager (eCommerce Stack)_MPIN"],
  ["2026-10-29", "Plotline", "Head of Revenue - India"], ["2026-11-09", "Lenskart", "Business Head, Owndays Japan"], ["2026-10-25", "GE Healthcare India", "India SVG National Sales Manager/SVG Business Head"],
  ["2026-11-09", "Mercedes-Benz India", "Deputy General Manager- Procurement & Supplier Management"], ["2026-10-24", "Sigmoid", "Director - RGM Consulting"], ["2026-10-24", "Meesho", "Director - Product"],
  ["2026-11-09", "Titan Company", "Business Manager-IBD (W&W)"], ["2026-11-09", "Amazon", "Business Development Manager, Private Brands, Scale"], ["2026-10-31", "Amazon", "Strategic Account Manager, Amazon Business India"],
  // the newest operations, programme, finance and service roles on the day: what the old search reached first
  ["2026-11-24", "State Street Investment Management", "India Program Office, Vice President - State Street Investment Management"], ["2026-11-24", "Amazon", "Sr. Manager - Easy Ship Operations, IN External Fulfillment"],
  ["2026-11-24", "Airbound Aerospace", "Finance Manager"], ["2026-11-24", "GE Healthcare India", "Lead Service Integrator"], ["2026-11-24", "Cisco", "Business Operations Manager"],
  ["2026-11-23", "Accenture", "Program/Project Management Lead"], ["2026-11-23", "Adecco India", "Team Lead Program - MSP Operations - Night Shift Bengaluru, India"], ["2026-11-23", "Okta", "Senior Manager, Order to Cash & Revenue - Finance Technology"],
  ["2026-11-23", "State Street Investment Management", "Global Billing Operations , Vice President"], ["2026-11-23", "Signify", "Dgital Finance Project Manager"], ["2026-11-23", "Bosch Global Software Technologies", "Area Manager – Sales, Workshop Concepts & Services"],
  ["2026-11-23", "Titan Company", "Retail Services Manager-Costing BOQ (RND)"], ["2026-11-23", "Accenture", "Service Delivery Operations Lead"], ["2026-11-22", "Cisco", "Product Lifecycle New Product Program Manager"],
  ["2026-11-22", "Cisco", "Product Lifecycle Program Manager(12-18 Years)"], ["2026-11-22", "Thermo Fisher Scientific", "Associate Director, CDM Programming"], ["2026-11-22", "HPE Aruba Networking", "Quality Program Manager"],
  ["2026-11-22", "Hitachi", "Cost Accounting Team Lead - Controlling Practice & Operations"], ["2026-11-22", "HPE Aruba Networking", "Culture & Leadership Excellence Program Manager"], ["2026-11-22", "Accenture", "Infra Managed Service Assoc Manager"],
  ["2026-11-22", "Thermo Fisher Scientific", "Manager, Customer Service"], ["2026-11-22", "HPE Aruba Networking", "APJ Technical Infrastructure Program Manager"], ["2026-11-22", "eBay", "PMO Manager - Finance & Accounting"],
  ["2026-11-22", "Nike", "Director of Cyber Defense Operations , ITC"], ["2026-11-22", "eBay", "FP&A COE Finance Manager"], ["2026-11-22", "HPE Aruba Networking", "Commercial Account Manager"],
  ["2026-10-24", "Accenture", "Capital Markets Operations Sr Manager"], ["2026-10-24", "Accenture", "Order to Cash Operations Senior Manager"], ["2026-10-24", "Cargill India", "Director - Plant Operations"],
  ["2026-10-24", "Narayana Nethralaya", "Head of Hospital Operations"], ["2026-10-24", "Scopely", "Director, Corporate Operations - India"], ["2026-10-24", "Conduent", "Senior Manager, Business Operations"],
];
const pool = real.map(([d, c, t], i) => ({ id: i + 1, title: t, company_name: c, location: "Bengaluru", url: "", posted_at: null, first_seen: d + "T00:00:00Z", employer_key: c.toLowerCase(), last_seen: "2026-11-24T00:00:00Z", readable: true }));

// the targets our own engine wrote for the category director whose list went wrong on 24 Nov (from his list's record)
const titles = ["Director of Operations", "Head of Category Management", "Business Unit Head", "Head of Business Operations", "General Manager"];

// before: any title word, newest first, the first N. With 30,000 roles N was 1,000 of 1,963 matches; here the same half.
const kw = keywords(titles);
const matches = pool.filter((r) => kw.some((w) => r.title.toLowerCase().includes(w))).sort((a, b) => b.first_seen.localeCompare(a.first_seen));
const before = matches.slice(0, Math.ceil(matches.length / 2));
// after: Radar's long list
titleIdf(pool as any);
const after = shortlistFor(pool as any, { roles: [] } as any, { titles, level: "head", stretch: false, avoid: [] });

const cat = (r: { title: string }) => /category/i.test(r.title);
const all = pool.filter(cat).length;
console.log(`search words before: ${kw.join(", ")}`);
console.log(`before: ${before.length} of ${matches.length} title matches reached; category roles among them: ${before.filter(cat).length} of ${all}`);
console.log(`after:  ${after.length} in the long list; category roles among them: ${after.filter(cat).length} of ${all}`);
console.log("after, in order:\n  " + after.map((r: any) => `${r.title} · ${r.company_name}`).join("\n  "));
const stillOut = pool.filter((r) => /procurement|sourcing|merchandis|assortment|marketplace/i.test(r.title) && !after.some((a: any) => a.id === r.id));
console.log("not reached by titles alone (needs the posting-text search, a later change):\n  " + stillOut.map((r) => `${r.title} · ${r.company_name}`).join("\n  "));

let bad: string[] = [];
if (after.filter(cat).length < all) bad.push("a category role is missing from the long list");
if (after.some((r: any) => /^(Finance Manager|Quality Program Manager|Manager, Customer Service|FP&A COE Finance Manager)$/.test(r.title))) bad.push("an unrelated manager role is in the long list");
if (before.filter(cat).length >= after.filter(cat).length) bad.push("the long list reaches no more category roles than the old search");
if (bad.length) { console.error("FAILED\n" + bad.join("\n")); process.exit(1); }
console.log("all right");
