// Layers C + D: live web research per company (+ title), via Claude's web search tool. Cached in `companies`.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../lib/env.js";
import { FAST, MODEL } from "../claude.js";

const client = new Anthropic({ apiKey: env.anthropicKey });

async function ask<T>(instructions: string, question: string, maxUses = 4, model = FAST): Promise<T | null> {
  const r = await client.messages.create({
    model, max_tokens: 2500,
    system: instructions + "\n\nSearch the web as needed, then respond with a single JSON object and nothing else. Report only what the results say; use null when unknown. Today is " + new Date().toDateString() + ".",
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses } as any],
    messages: [{ role: "user", content: question }],
  });
  const text = r.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  const a = text.lastIndexOf("{"), b = text.lastIndexOf("}");
  // the final JSON is usually the last object; find the outermost one that parses
  for (let start = text.indexOf("{"); start !== -1 && start <= a; start = text.indexOf("{", start + 1)) {
    try { return JSON.parse(text.slice(start, b + 1)) as T; } catch { /* try next */ }
  }
  return null;
}

export interface BoardResearch {
  listings: { board: string; posted_days: number | null; url: string; applicants: number | null; posted_text: string | null }[];
  agency_posts: number;
  never_heard_back: boolean;
  evidence: string[];
}
export interface CompanyNews { layoffs_90d: boolean; freeze_90d: boolean; funding_90d: boolean; items: { title: string; url: string; date: string | null }[] }
export interface CompanySize { headcount: number | null; openings: number | null; source: string | null }

export const research = {
  /** Where is this exact job listed, with what dates? (signals 13–17) */
  boards: (company: string, title: string, city: string) => ask<BoardResearch>(
    `You find every listing of ONE specific job across job boards. Search LinkedIn, Naukri, Indeed, Glassdoor, Foundit, Instahyre, Cutshort for the title at the company (city helps). For each listing you actually find, record the board, URL, "posted" text and days, applicants if shown. Also search Glassdoor interview reviews for the company and note whether reviewers say they never heard back / no response after applying. Count listings that are from staffing agencies rather than the employer.`,
    `Company: ${company}\nTitle: ${title}\nCity: ${city || "Bengaluru"}\n\nReturn: {listings:[{board, posted_days, url, applicants, posted_text}], agency_posts, never_heard_back, evidence:[short quotes]}`, 5),

  /** Layoffs / freeze / funding in the last 90 days (signal 18) */
  news: (company: string) => ask<CompanyNews>(
    `You check recent news about ONE company for hiring-relevant events in the LAST 90 DAYS only: layoffs or job cuts, hiring freeze, major funding/acquisition. Ignore older news. Cite the article titles and dates.`,
    `Company: ${company}\n\nReturn: {layoffs_90d, freeze_90d, funding_90d, items:[{title, url, date}]}`, 3),

  /** Employee count and number of open roles (signal 19) */
  size: (company: string) => ask<CompanySize>(
    `Find the approximate employee headcount of ONE company (LinkedIn company page "employees", Tracxn, Crunchbase, or the company's own site) and how many open roles it currently lists (its careers page or LinkedIn jobs count).`,
    `Company: ${company}\n\nReturn: {headcount, openings, source}`, 3),

  /** The company's official careers page URL and website domain */
  careersPage: (company: string, hintDomain: string | null) => ask<{ url: string | null; domain: string | null; ats_hint: string | null }>(
    `Find the OFFICIAL careers/jobs page of ONE company (its own domain, or its page on Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Darwinbox, Keka). Not LinkedIn, not Naukri, not Glassdoor. Return the URL exactly as found.`,
    `Company: ${company}${hintDomain ? `\nKnown domain: ${hintDomain}` : ""}\n\nReturn: {url, domain, ats_hint}`, 3),
};
export { MODEL };
