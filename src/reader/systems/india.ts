// Hiring systems common with Indian employers, each read from the same public endpoint the employer's own careers page
// calls. Refs come from a URL seen on that page (detect), never from a guess. Each reader returns what the board says;
// null when the board does not exist; throws only on refusal or network failure. Shapes checked live on 9 Nov 2026.
//
// Not here, and why (checked the same day):
//   turbohire  — *.turbohire.co/robots.txt is "User-agent: * / Disallow: /" (only Googlebot is let in) and the API host
//                thapi.azurewebsites.net answers 403 to our UA on /api/token/noauth, the bearer step every listing call
//                needs (POST /api/careerpagev2/filteredjobs?orgId=<uuid>&pageType=0). We do not go round that.
//   zwayam     — public.zwayam.com answers 503 "upstream connect error" to every request from our egress (GET or POST),
//                in Chromium as well as here; nothing to verify against. The call is POST /jobs/search, form fields
//                filterCri={"paginationStartNo":0,"selectedCall":"sort","sortCriteria":{"name":"modifiedDate",
//                "isAscending":false},"anyOfTheseWords":""}, domain=<careers host>, companyId=<base64 of the numeric
//                company id, the COMPANYID const in the site's main.*.js>.
import { getJson, getText } from "../http.js";
import { isBlr } from "../blr.js";
import { mode, progress } from "./types.js";
import type { FeedJob, System } from "./types.js";

const iso = (v: unknown): string | null => { if (!v && v !== 0) return null; const d = new Date(typeof v === "number" ? v : String(v)); return isNaN(d.getTime()) ? null : d.toISOString(); };
const H = { accept: "application/json, text/plain, */*" };
const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&#x27;/g, "'").replace(/&quot;|&#34;/g, '"').replace(/\s+/g, " ").trim();
const desc = (html: unknown): string | undefined => { if (typeof html !== "string") return undefined; const t = strip(html); return t.length > 200 ? t : undefined; };

/** PeopleStrong Alt (Altone) candidate portals: {sub}.peoplestrong.com → POST /api/cp/rest/altone/cp/jobs/v1?offset=N&limit=45
 *  with an empty JSON body; the whole board, 45 a page. No server-side city filter, so `location` carries the city. ref: the host. */
export const peoplestrong: System = {
  id: "peoplestrong",
  detect: (u) => u.match(/^https?:\/\/([a-z0-9-]+\.peoplestrong\.com)(?:[/?#]|$)/i)?.[1]?.toLowerCase() ?? null,
  async read(host) {
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const diag: string[] = []; let total = 0;
    const LIMIT = 45;
    for (let offset = 0; offset < 5000; offset += LIMIT) {
      const r = await getJson<any>(`https://${host}/api/cp/rest/altone/cp/jobs/v1?offset=${offset}&limit=${LIMIT}`, { method: "POST", body: {}, headers: { ...H, referer: `https://${host}/job/joblist` }, gapMs: 800, timeoutMs: 20000 });
      if (r.status === 404 || (offset === 0 && r.ok && r.data?.response === null && r.data?.messageCode?.code !== 200)) return null;   // an unknown portal: {"response":null,"messageCode":{"code":201,…}}
      if (!r.ok || !Array.isArray(r.data?.response)) { if (offset === 0) throw new Error(`peoplestrong ${host}: HTTP ${r.status}`); diag.push(`offset ${offset} HTTP ${r.status}`); break; }
      total = Number(r.data.totalRecords ?? total); const list: any[] = r.data.response;
      for (const x of list) {
        const code = String(x.jobCode ?? ""); const id = String(x.jobDetailUrl?.match(/\/job\/detail\/([^/?#]+)/)?.[1] ?? code.replace(/\//g, "_") ?? ""); if (!id || seen.has(id)) continue; seen.add(id);
        jobs.push({ id, title: String(x.jobTitle ?? x.designation ?? ""), location: String(x.locationHierarchy ?? x.locationHierarchyComplete ?? ""), url: String(x.jobDetailUrl ?? `https://${host}/job/detail/${id}`), posted_at: iso(x.jobPostedDate), updated_at: null, posted_text: null, raw: { code, exp: x.expRange ?? null, unit: x.organizationUnit ?? null, closes: x.jobClosureDate ?? null } });
      }
      if (list.length < LIMIT || jobs.length >= total) break;
      if (mode.quick && offset >= LIMIT * 2) { diag.push("quick: stopped early"); break; }
      progress(`peoplestrong ${host}: ${jobs.length}/${total}`);
    }
    diag.push(`total ${total}`);
    return { system: "peoplestrong", ref: host, board_url: `https://${host}/job/joblist`, company_name: null, jobs, debug: diag.join("; ") };
  },
};

/** njoyn (CGI and other CGI-hosted boards): server-rendered HTML, 50 rows a page, GET …/xweb/xweb.asp?page=joblisting&CLID=…&lang=1&pn=N.
 *  The city filter is a POST the server ignores for us, so every page is read and Bengaluru rows kept. Rows carry no date.
 *  ref: "host|site|CLID", e.g. "cgi.njoyn.com|corp|21001". Each page is ~370 KB, so this is a slow, gentle read. */
export const njoyn: System = {
  id: "njoyn",
  detect: (u) => { const m = u.match(/^https?:\/\/([a-z0-9-]+\.njoyn\.com)\/([a-z0-9_-]+)\/xweb\/xweb\.asp\?[^#]*\bclid=(\d+)/i); return m ? `${m[1].toLowerCase()}|${m[2]}|${m[3]}` : null; },
  async read(ref) {
    const [host, site, clid] = ref.split("|"); if (!host || !site || !clid) return null;
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const diag: string[] = []; let pages = 1, rows = 0;
    const list = `https://${host}/${site}/xweb/xweb.asp?page=joblisting&CLID=${clid}&lang=1`;
    for (let pn = 1; pn <= pages && pn <= 200; pn++) {
      const r = await getText(`${list}&pn=${pn}`, { headers: { accept: "text/html" }, gapMs: 900, timeoutMs: 30000 });
      if (r.status === 404) return null;
      if (!r.ok) { if (pn === 1) throw new Error(`njoyn ${host}: HTTP ${r.status}`); diag.push(`pn ${pn} HTTP ${r.status}`); break; }
      if (pn === 1) { if (/Invalid request/i.test(r.text) && !/HasMultipleLocations/.test(r.text)) return null; pages = Number(r.text.match(/Page\s+\d+\s+of\s+(\d+)/i)?.[1] ?? 1); }
      for (const m of r.text.matchAll(/<tr\s+HasMultipleLocations[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]); if (cells.length < 4) continue; rows++;
        const href = cells[0].match(/href=['"]([^'"]+)['"]/i)?.[1]?.replace(/&amp;/g, "&") ?? "";
        const id = strip(cells[0]) || href.match(/Jobid=([^&]+)/i)?.[1] || ""; if (!id || seen.has(id)) continue;
        const city = strip(cells[3] ?? ""), country = strip(cells[4] ?? ""); const location = [city, country].filter(Boolean).join(", ");
        if (!isBlr(location) || !/bengaluru|bangalore|karnataka/i.test(location)) continue;   // the board is worldwide: keep the city, not all of India
        seen.add(id);
        jobs.push({ id, title: strip(cells[1] ?? ""), location, url: href ? new URL(href, `https://${host}/${site}/xweb/`).toString() : list, posted_at: null, updated_at: null, posted_text: null, raw: { category: strip(cells[2] ?? "") } });
      }
      if (mode.quick && pn >= 5) { diag.push("quick: 5 pages"); break; }
      if (pn % 10 === 0) progress(`njoyn ${host}: page ${pn}/${pages}, ${jobs.length} in Bengaluru`);
    }
    diag.push(`${pages} pages, ${rows} rows, ${jobs.length} in Bengaluru`);
    return { system: "njoyn", ref, board_url: list, company_name: null, jobs, debug: diag.join("; ") };
  },
};

/** Zoho Recruit career sites ({sub}.zohorecruit.com / .in, Zoho Corp's own included): the JSON API under /recruit/v2/public/ is
 *  disallowed by their robots.txt, but the careers page itself (/jobs/{pagename}, allowed) embeds the whole published list, with
 *  the description, in <input id="jobs" value="[…]">. ref: "host|pagename" (pagename defaults to Careers). */
export const zohorecruit: System = {
  id: "zohorecruit",
  detect: (u) => { const m = u.match(/^https?:\/\/([a-z0-9-]+\.zohorecruit\.(?:com|in|eu|com\.au|jp|com\.cn|sa|ca|uk))(?:\/jobs\/([A-Za-z0-9_-]+)|\/recruit\/[^?#]*[?&]pagename=([A-Za-z0-9_-]+))?/i); if (!m) return null; const host = m[1].toLowerCase(); if (/^(www|api|accounts|recruit|static|help|cdn)\./.test(host)) return null; return `${host}|${m[2] ?? m[3] ?? "Careers"}`; },
  async read(ref) {
    const [host, pagename = "Careers"] = ref.split("|"); if (!host) return null;
    const r = await getText(`https://${host}/jobs/${pagename}`, { headers: { accept: "text/html" }, gapMs: 800, timeoutMs: 25000 });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`zohorecruit ${host}: HTTP ${r.status}`);
    const m = r.text.match(/<input[^>]+value="([^"]*)"[^>]+id="jobs"/i) ?? r.text.match(/<input[^>]+id="jobs"[^>]+value="([^"]*)"/i);
    if (!m) { if (/<title>\s*Page does not exist|joblist has been removed|page not found/i.test(r.text)) return null; throw new Error(`zohorecruit ${host}: no job list in page`); }   // unknown portals and pages answer 200 "Page does not exist"
    let list: any[]; try { const v = JSON.parse(m[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")); list = Array.isArray(v) ? v : []; } catch { throw new Error(`zohorecruit ${host}: job list not JSON`); }
    const jobs: FeedJob[] = [];
    for (const x of list) {
      if (x.Publish === false) continue;
      const id = String(x.id ?? ""); if (!id) continue;
      const title = String(x.Posting_Title ?? x.Job_Opening_Name ?? "");
      const slug = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
      jobs.push({ id, title, location: [x.City, x.State, x.Country].filter(Boolean).join(", ") + (x.Remote_Job ? " (Remote)" : ""), url: `https://${host}/jobs/${pagename}/${id}/${slug}?source=CareerSite`, posted_at: iso(x.Date_Opened), updated_at: null, posted_text: null, description: desc(x.Job_Description), raw: { type: x.Job_Type ?? null, industry: x.Industry ?? null } });
    }
    const name = r.text.match(/&#34;org_info&#34;:\{[^}]*?&#34;company_name&#34;:&#34;([^&]+)&#34;/)?.[1] ?? r.text.match(/"org_info":\{[^}]*?"company_name":"([^"]+)"/)?.[1] ?? null;
    return { system: "zohorecruit", ref: `${host}|${pagename}`, board_url: `https://${host}/jobs/${pagename}`, company_name: name, jobs, debug: `${list.length} in page` };
  },
};

/** ZingHR career widgets (zingnext.zinghr.com/portal/embed/career-website?CareerClientKey=…): the widget reads
 *  mservices.zinghr.com/recruitment/api/v1/CareerConfig/GetCareerJobPostings?careerClientKey=…&pageIndex=N&pageSize=…
 *  The envelope is {code,data,message}; "No data found" with data:null is what both an empty board (Cloudnine, 9 Nov 2026) and an
 *  unknown key return, so an empty feed is reported rather than null, and the row shape below is read tolerantly: it should be
 *  checked against the first tenant that has postings. ref: the client key. */
export const zinghr: System = {
  id: "zinghr",
  detect: (u) => u.match(/zinghr\.com\/[^#]*[?&]careerClientKey=([A-Za-z0-9-]+)/i)?.[1] ?? null,
  async read(key) {
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const diag: string[] = []; const SIZE = 50; let total = 0;
    for (let page = 1; page <= 40; page++) {
      const r = await getJson<any>(`https://mservices.zinghr.com/recruitment/api/v1/CareerConfig/GetCareerJobPostings?careerClientKey=${encodeURIComponent(key)}&pageIndex=${page}&pageSize=${SIZE}&searchText=`, { headers: { ...H, referer: "https://zingnext.zinghr.com/" }, gapMs: 800, timeoutMs: 20000 });
      if (r.status === 404) return null;
      if (!r.ok || !r.data || typeof r.data !== "object") { if (page === 1) throw new Error(`zinghr ${key}: HTTP ${r.status}`); diag.push(`page ${page} HTTP ${r.status}`); break; }
      const d = r.data.data;
      if (d == null) { diag.push(page === 1 ? `empty: ${r.data.message ?? "no data"}` : `page ${page}: ${r.data.message ?? "no data"}`); break; }
      const list: any[] = Array.isArray(d) ? d : Array.isArray(d.jobPostings) ? d.jobPostings : Array.isArray(d.items) ? d.items : Array.isArray(d.data) ? d.data : Array.isArray(d.result) ? d.result : [];
      total = Number(d.totalCount ?? d.totalRecords ?? d.total ?? r.data.totalCount ?? total);
      for (const x of list) {
        const id = String(x.jobPostingId ?? x.jobId ?? x.requisitionId ?? x.id ?? x.jobCode ?? ""); if (!id || seen.has(id)) continue; seen.add(id);
        const loc = x.location ?? x.jobLocation ?? x.locationName ?? x.city ?? "";
        jobs.push({ id, title: String(x.jobTitle ?? x.title ?? x.designation ?? x.positionName ?? ""), location: Array.isArray(loc) ? loc.map((l: any) => (typeof l === "string" ? l : l?.name ?? l?.locationName ?? "")).filter(Boolean).join(" · ") : String(loc), url: String(x.jobUrl ?? x.applyUrl ?? `https://zingnext.zinghr.com/portal/embed/career-website?CareerClientKey=${key}`), posted_at: iso(x.postedDate ?? x.postedOn ?? x.createdDate ?? x.publishedDate), updated_at: iso(x.modifiedDate ?? x.updatedDate), posted_text: null, description: desc(x.jobDescription ?? x.description) });
      }
      if (!list.length || list.length < SIZE || (total && jobs.length >= total)) break;
      if (mode.quick && page >= 3) break;
    }
    return { system: "zinghr", ref: key, board_url: `https://zingnext.zinghr.com/portal/embed/career-website?CareerClientKey=${key}`, company_name: null, jobs, debug: diag.join("; ") || `total ${total}` };
  },
};

/** Spire2Grow career sites (jobs.myntra.com): the Flutter app reads io.spire2grow.com/ies/v1/p/requisition/_search with the tenant in a
 *  `workspaceid` header; the list carries the description. ref: "workspace|careers host", e.g. "MYNTRA-93as3|jobs.myntra.com"
 *  (the host is only used to build human links; the workspace alone also reads). */
export const spire2grow: System = {
  id: "spire2grow",
  detect: (u) => { const m = u.match(/^https?:\/\/io\.spire2grow\.com\/ies\/v1\/p\/(?:workspace\/(?:theme|static-content)\/|[^?#]*[?&]workspaceId=)([A-Za-z0-9_-]+)/i); return m ? m[1] : null; },
  async read(ref) {
    const [ws, host] = ref.split("|"); if (!ws) return null;
    const jobs: FeedJob[] = []; const seen = new Set<string>(); const diag: string[] = []; const SIZE = 50; let total = 0;
    for (let page = 1; page <= 60; page++) {
      const r = await getJson<any>(`https://io.spire2grow.com/ies/v1/p/requisition/_search?page=${page}&size=${SIZE}&selectedSortOrder=desc&selectedSortField=postedOn`, { headers: { ...H, workspaceid: ws, language: "en" }, gapMs: 800, timeoutMs: 25000 });
      if (r.status === 404 || r.status === 401 && page === 1) return null;   // an unknown workspace is refused with 401
      if (!r.ok || !Array.isArray(r.data?.entities)) { if (page === 1) throw new Error(`spire2grow ${ws}: HTTP ${r.status}`); diag.push(`page ${page} HTTP ${r.status}`); break; }
      total = Number(r.data.total ?? total); const list: any[] = r.data.entities;
      for (const x of list) {
        const id = String(x.displayId ?? x.id ?? ""); if (!id || seen.has(id)) continue; seen.add(id);
        const locs: any[] = Array.isArray(x.jobLocation) ? x.jobLocation : [];
        jobs.push({ id, title: String(x.jobTitle ?? ""), location: locs.map((l) => l.fqLocationName ?? [l.city, l.state, l.country].filter(Boolean).join(", ")).filter(Boolean).join(" · ") + (x.jobType === "REMOTE" ? " (Remote)" : ""), url: host ? `https://${host}/jobs/${id}` : `https://io.spire2grow.com/ies/v1/p/requisition/displayId/${id}`, posted_at: iso(x.jobPosting?.startDate ?? x.createdOn), updated_at: iso(x.updatedOn), posted_text: null, description: desc(x.jobDescription), raw: { dept: x.departmentName ?? null, exp_months: x.requiredExperienceInMonths ?? null, type: x.employmentType ?? null } });
      }
      if (!list.length || list.length < SIZE || (total && jobs.length >= total)) break;
      if (mode.quick && page >= 3) break;
      progress(`spire2grow ${ws}: ${jobs.length}/${total}`);
    }
    // an unknown workspace also searches as [] — the static-content call (which the page makes too) says whether it exists and names the employer
    const sc = await getJson<any>(`https://io.spire2grow.com/ies/v1/p/workspace/static-content/${encodeURIComponent(ws)}`, { headers: { ...H, workspaceid: ws, language: "en" }, gapMs: 800 });
    if (sc.status === 404) return null;
    const name = typeof sc.data?.contentSettings?.general?.name === "string" ? sc.data.contentSettings.general.name : null;
    diag.push(`total ${total}`);
    return { system: "spire2grow", ref, board_url: host ? `https://${host}/jobs` : `https://io.spire2grow.com/ies/v1/p/workspace/static-content/${ws}`, company_name: name, jobs, debug: diag.join("; ") };
  },
};

/** MyNextHire job boards ({sub}.mynexthire.com/employer/jobs/careers, embedded as an iframe): POST /employer/careers/reqlist/get
 *  returns every open requisition with its description. ref: the subdomain. */
export const mynexthire: System = {
  id: "mynexthire",
  detect: (u) => u.match(/^https?:\/\/([a-z0-9-]+)\.mynexthire\.com\/employer\//i)?.[1]?.toLowerCase() ?? null,
  async read(sub) {
    const base = `https://${sub}.mynexthire.com/employer`;
    const r = await getJson<any>(`${base}/careers/reqlist/get`, { method: "POST", body: { source: "careers", code: "", filterByBuId: -1 }, headers: { ...H, referer: `${base}/jobs/careers` }, gapMs: 800, timeoutMs: 25000 });
    if (r.status === 404 || r.status === 417) return null;   // 417 "Invalid company short name"
    if (!r.ok || !Array.isArray(r.data?.reqDetailsBOList)) throw new Error(`mynexthire ${sub}: HTTP ${r.status}`);
    const jobs: FeedJob[] = [];
    for (const x of r.data.reqDetailsBOList) {
      const id = String(x.reqId ?? ""); if (!id) continue;
      const locs: any[] = Array.isArray(x.locationList) ? x.locationList : [];
      jobs.push({ id, title: String(x.reqTitle ?? x.designation ?? ""), location: locs.map((l) => l.office).filter(Boolean).join(" · ") || String(x.location ?? ""), url: `${base}/jobs/careers#?src=careers&page=jd&reqId=${id}`, posted_at: iso(x.approvedOn), updated_at: null, posted_text: null, description: desc(x.jdDisplay), raw: { unit: x.buName ?? null, exp: x.expMin != null ? `${x.expMin}-${x.expMax} yrs` : null, type: x.employmentType ?? null, openings: x.totalPositions ?? null } });
    }
    let name: string | null = null;
    const meta = await getJson<any>(`${base}/jobboard/details_by_shortname/get/${sub}/`, { headers: H, gapMs: 800 });
    if (meta.ok) name = meta.data?.clientName ?? null;
    return { system: "mynexthire", ref: sub, board_url: `${base}/jobs/careers`, company_name: name, jobs, debug: `${jobs.length} open` };
  },
};

// zinghr stays out of the list until a tenant with postings proves its row shape
export const INDIA: System[] = [peoplestrong, njoyn, zohorecruit, spire2grow, mynexthire];
