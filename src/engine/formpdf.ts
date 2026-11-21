import { resumeHtml, htmlToPdf } from "./pdf.js";
import type { ResumeProfile, Rewrite } from "./sharpen.js";

export interface FormResume { name: string; email?: string; city?: string; links?: string; college: string; degree: string; year: string; score?: string; skills: string;
  projects: { title: string; what: string }[]; experience?: string; extras?: string }

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** What a person typed in a box, as the lines of a résumé: one per line or sentence, no stray bullet marks, a full stop on each. */
export const lines = (t: string) => t.split(/\n|(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim().replace(/^[-•*]\s*/, "")).filter((x) => x.length > 2).map((x) => (/[.!?]$/.test(x) ? x : `${x}.`));
const list = (t: string) => t.split(/[,\n;]+/).map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 40).slice(0, 24);
const cap = (s: string) => s.trim().replace(/\s+/g, " ");

/** A student's typed details set out in the design a Sharpen delivers (the same page, the same type, the same rules under
 *  the headings), as HTML. Their own words throughout: no model writes or rewords anything here. The header comes from
 *  the Sharpen template itself, so the two documents cannot drift apart. */
export function studentHtml(f: FormResume, phone?: string | null): string {
  const o: ResumeProfile = { name: cap(f.name), headline: "", contact: { email: f.email || undefined, phone: phone ? phone.replace(/^\+?91(\d{5})(\d{5})$/, "+91 $1 $2") : undefined, city: f.city || "Bengaluru", links: (f.links ?? "").split(/[\s,]+/).filter((x) => /\./.test(x)).slice(0, 2) },
    years_total: 0, roles: [], skills: [], education: [], extra_sections: [], pages: 1 };
  const r: Rewrite = { headline: `${cap(f.degree)} student, ${cap(f.college)}`, summary: "", roles: [], skills: [], education: [], relevant: [], extra_sections: [], changes: [], referral_note: "", fit_line: "" };
  const shell = resumeHtml(r, o);
  const a = shell.indexOf("<section>"), b = shell.lastIndexOf("</div></body>");
  const sec = (title: string, body: string) => `<section><h2>${esc(title)}</h2>${body}</section>`;
  const ul = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const projects = f.projects.map((p) => `<div class="role"><div class="role-h"><div><div class="t">${esc(cap(p.title))}</div></div></div>${ul(lines(p.what))}</div>`).join("");
  const edu = `<div class="role"><div class="role-h"><div><div class="t">${esc(cap(f.degree))}</div><div class="c">${esc(cap(f.college))}${f.score ? ` · ${esc(cap(f.score))}` : ""}</div></div><div class="d">${esc(f.year)}</div></div></div>`;
  const body = [
    sec("Education", edu),
    sec("Projects", projects),
    f.experience ? sec("Experience", ul(lines(f.experience))) : "",
    sec("Skills", `<div class="chips">${list(f.skills).map((s) => `<span>${esc(s)}</span>`).join("")}</div>`),
    f.extras ? sec("Achievements", ul(lines(f.extras))) : "",
  ].join("\n");
  return shell.slice(0, a) + body + "\n" + shell.slice(b);
}

/** The same, as a one-page text PDF: what they download, and what goes on file as their résumé. */
export async function formPdf(f: FormResume, phone?: string | null): Promise<Buffer> {
  const out = await htmlToPdf(studentHtml(f, phone), { target: 1 });
  return out.pdf;
}
