// Offline check of page-shell detection (src/reader/shells.ts). No network, no database.
// Run: npx tsx src/probe/shells-offline.mts            (fixtures only)
//      npx tsx src/probe/shells-offline.mts <inventory.jsonl>   (also every stored description in a snapshot)
import { readFileSync } from "node:fs";
const { shellKind, ibmDescription, greenhouseJob, unescapeHtml } = await import("../reader/shells.js");
const { htmlToText } = await import("../engine/extract.js");
let fail = 0; const ok = (n: string, c: boolean, d = "") => { if (c) console.log("  ✓", n); else { fail++; console.log("  ✗", n, d); } };

// shapes as stored on 24 Nov 2026 (public pages; employer furniture only)
const IBM = "Skip to content\nIBM\nIBM Careers\nLogin\n< Back to search results\nData Engineer-Data Platforms-Azure\nBangalore, Karnataka, India Professional\nEmail\nX\nLinkedIn\nApply now\nJob Title\nData Engineer-Data Platforms-Azure\nJob ID\n138171\nCity / Township / Village\nBangalore\nState / Province\nKarnataka\nCountry\nIndia\nWork arrangement\nHybrid\nArea of work\nSoftware Engineering\nEmployment type\nRegular\nPosition type\nProfessional\nTravel required\nUp to 20% or 1 day a week\nCompany\n(0063) IBM India Private Limited\nShift\nGeneral (daytime)\nIs this role a commissionable/sales incentive based position?\nNo\nApply now\n< Back to search results\nApplication Info\nBe aware: Recruitment Scams\nPrivacy statement\nLearn more about IBM\n\nEnglish\nEspañol\nFrançais";
const IBM_FULL = IBM.replace("Apply now\nJob Title", "Apply now\nIntroduction\nA career in IBM Consulting is rooted in long-term relationships.\nYour role and responsibilities\nAs a Data Engineer you will design, build and run data pipelines on Azure Data Factory and Databricks for enterprise clients, own data quality and work with architects on platform choices.\nRequired technical and professional expertise\n5+ years of data engineering, strong SQL and PySpark, Azure Synapse.\nJob Title");
const GH_FORM = "Job Application for DevOps Engineer II at HackerRank Careers\n\n Apply for this job\n\n *\n\n indicates a required field\n\n First Name *\n\n Last Name *\n\n Email *\n\n Phone Country *\n\n Phone *\n\n Resume/CV *\n Attach Attach\n\n Google Drive\n Enter manually Enter manually\n\n Accepted file types: pdf, doc, docx, txt, rtf\n\n How many years of professional experience do you have in DevOps or Infrastructure Engineering? * Select...";
const GH_REAL = "Job Application for Cluster Manager at Razorpay\n\nBack to jobs\nCluster Manager, Enterprise Sales\nBengaluru\nApply\nRazorpay is one of India's leading payments companies. What you'll do: own a cluster of enterprise accounts, grow revenue, lead a team of four. Requirements: 6+ years in B2B sales.\n\nApply for this job\n* indicates a required field\nFirst Name *";
const WALKIN_REAL = "We are hiring a teller. You will handle cash deposits and withdrawals, maintain records and serve customers at the branch. Requirements: graduate, 1-2 years in banking.";

ok("IBM metadata block is a shell", shellKind(IBM) === "metadata only");
ok("IBM page with its body is not a shell", shellKind(IBM_FULL) === null);
ok("Greenhouse bare form is a shell", shellKind(GH_FORM) === "application form only");
ok("Greenhouse page with posting text before the form is not a shell", shellKind(GH_REAL) === null);
ok("a thin real posting with repeated Apply-now furniture is not a shell", shellKind("Cloud Engineer Job Details | Mastek Apply now » Apply now Apply Now Start applying with LinkedIn Job Title Cloud Engineer Expected Work Experience 5 Years Job Location bangalore Job Summary: Primary Skills: PL/SQL, ETL, Python, Postgres, AWS services (S3, Glue, Lambda), Data Migration experience. Secondary Skills: APIs, PowerBI Apply now » Apply now Apply Now Privacy Notice") === null);
ok("a short real posting is not a shell", shellKind(WALKIN_REAL) === null);
ok("IBM search description: real text kept", (ibmDescription("<p>" + IBM_FULL.split("Introduction")[1] + "</p>", htmlToText) ?? "").includes("Data Engineer you will design"));
ok("IBM search description: a snippet is dropped", ibmDescription("<p>Design data pipelines.</p>", htmlToText) === undefined);
ok("IBM search description: missing or not a string is dropped", ibmDescription(undefined, htmlToText) === undefined && ibmDescription(42, htmlToText) === undefined);
ok("IBM search description: the metadata block itself is dropped", ibmDescription(IBM, htmlToText) === undefined);
ok("Greenhouse URL → board and id", JSON.stringify(greenhouseJob("https://job-boards.greenhouse.io/hackerrank/jobs/7824249")) === '{"board":"hackerrank","id":"7824249"}' && greenhouseJob("https://boards.greenhouse.io/razorpay/jobs/1?gh_src=x")?.id === "1" && greenhouseJob("https://example.com/jobs/1") === null);
ok("Greenhouse content unescapes to readable text", htmlToText(unescapeHtml("&lt;p&gt;You will &lt;strong&gt;own&lt;/strong&gt; R&amp;D&lt;/p&gt;")).includes("You will own R&D"));

if (process.argv[2]) {
  const by: Record<string, number> = {}; const fp: string[] = []; let n = 0;
  for (const l of readFileSync(process.argv[2], "utf8").split("\n")) {
    if (!l) continue; const r = JSON.parse(l); if (!r.description) continue; n++;
    const k = shellKind(r.description); if (!k) continue;
    const key = `${k} · ${r.source}/${r.employer_key}`; by[key] = (by[key] ?? 0) + 1;
    if (!(r.source === "ibm" || (r.source === "greenhouse" && r.employer_key === "hackerrank"))) fp.push(`${r.id} ${r.source}/${r.employer_key} ${r.title}`);
  }
  console.log(`  snapshot: ${n} stored descriptions`, by);
  ok("snapshot: shells only where diagnosed (IBM, Greenhouse/HackerRank)", fp.length === 0, fp.slice(0, 10).join("\n    "));
}
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
