import PDFDocument from "pdfkit";
import type { Rewrite, ResumeProfile } from "./sharpen.js";

const A4 = { w: 595.28, h: 841.89 };
const M = { top: 50, bottom: 50, left: 56, right: 56 };
const W = A4.w - M.left - M.right;
const INK = "#111111", MID = "#444444", FAINT = "#777777", RULE = "#B8B8B8";

/**
 * Clean one-column résumé. Auto-fits: scales type and spacing so the content
 * fills the target page count (same as the original) without spilling.
 */
export async function resumePdf(r: Rewrite, orig: ResumeProfile): Promise<Buffer> {
  const targetPages = Math.max(1, orig.pages || 1);
  // find the largest scale that still fits in targetPages
  let best = 1, endY = 0;
  for (let s = 1.0; s <= 1.5; s += 0.02) {
    const m = await render(r, orig, s, true);
    if (m.pages > targetPages) break;
    best = s; endY = m.endY;
  }
  // spread any leftover on the last page across the section gaps (4 sections), capped so it never looks airy
  const leftover = A4.h - M.bottom - endY;
  const extra = Math.max(0, Math.min(leftover / 4, 22 * best));
  const check = await render(r, orig, best, true, extra);
  return render(r, orig, best, false, check.pages > targetPages ? 0 : extra) as Promise<Buffer>;
}

export function render(r: Rewrite, orig: ResumeProfile, s: number, measure: true, extra?: number): Promise<{ pages: number; endY: number }>;
export function render(r: Rewrite, orig: ResumeProfile, s: number, measure: false, extra?: number): Promise<Buffer>;
export function render(r: Rewrite, orig: ResumeProfile, s: number, measure: boolean, extra = 0): Promise<{ pages: number; endY: number } | Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margins: M, bufferPages: true, info: { Title: `${orig.name} — Résumé`, Author: orig.name } });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    let pageCount = 0, endY = 0;
    doc.on("end", () => resolve(measure ? { pages: pageCount, endY } : Buffer.concat(chunks)));

    // type scale
    const F = {
      name: 21 * s, head: 11 * s, contact: 9 * Math.min(s, 1.15), sec: 8.6 * s, role: 10.5 * s, body: 10 * s, date: 9 * s,
    };
    const gap = (n: number) => doc.moveDown(n * s);
    const lineGap = 2.2 * s;

    // ---- header ----
    doc.font("Helvetica-Bold").fontSize(F.name).fillColor(INK).text(orig.name, { width: W });
    doc.moveDown(0.12);
    doc.font("Helvetica").fontSize(F.head).fillColor(MID).text(r.headline, { width: W });
    const contact = [orig.contact.email, orig.contact.phone, orig.contact.city, ...(orig.contact.links ?? [])]
      .filter(Boolean).join("   ·   ");
    if (contact) { doc.moveDown(0.25); doc.fontSize(F.contact).fillColor(FAINT).text(contact, { width: W }); }

    // ---- section heading: title, rule tight beneath, then one line of air ----
    const section = (t: string) => {
      gap(1.15);
      if (extra) doc.y += extra;
      doc.font("Helvetica-Bold").fontSize(F.sec).fillColor(INK).text(t.toUpperCase(), M.left, doc.y, { width: W, characterSpacing: 1.4 * s });
      const y = doc.y + 2.5 * s;
      doc.moveTo(M.left, y).lineTo(M.left + W, y).lineWidth(0.6).strokeColor(RULE).stroke();
      doc.y = y + 7 * s;
    };

    const bullet = (b: string) => {
      const x = M.left + 10 * s;
      const yTop = doc.y;
      doc.font("Helvetica").fontSize(F.body).fillColor(INK);
      doc.text("•", M.left, yTop, { width: 10 * s, lineBreak: false });
      doc.text(b, x, yTop, { width: W - 10 * s, lineGap });
      doc.moveDown(0.18);
    };

    // ---- summary ----
    section("Summary");
    doc.font("Helvetica").fontSize(F.body).fillColor(INK).text(r.summary, M.left, doc.y, { width: W, lineGap });

    // ---- experience ----
    section("Experience");
    r.roles.forEach((role, i) => {
      const y = doc.y;
      const date = `${role.start} – ${role.end}`;
      doc.font("Helvetica").fontSize(F.date).fillColor(FAINT);
      const dw = doc.widthOfString(date) + 6;
      doc.text(date, M.left + W - dw, y + (F.role - F.date) * 0.6, { width: dw, align: "right", lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(F.role).fillColor(INK)
        .text(role.title, M.left, y, { width: W - dw - 8, continued: true })
        .font("Helvetica").fillColor(MID).text(`  ·  ${role.company}`, { continued: false });
      doc.moveDown(0.35);
      role.bullets.forEach(bullet);
      if (i < r.roles.length - 1) gap(0.55);
    });

    // ---- skills ----
    if (r.skills.length) {
      section("Skills");
      doc.font("Helvetica").fontSize(F.body).fillColor(INK).text(r.skills.join("\u00A0 ·   "), M.left, doc.y, { width: W, lineGap });
    }

    // ---- education ----
    if (r.education.length) {
      section("Education");
      for (const e of r.education) {
        const y = doc.y;
        if (e.year) {
          doc.font("Helvetica").fontSize(F.date).fillColor(FAINT);
          const dw = doc.widthOfString(e.year) + 6;
          doc.text(e.year, M.left + W - dw, y + (F.body - F.date) * 0.6, { width: dw, align: "right", lineBreak: false });
        }
        doc.font("Helvetica-Bold").fontSize(F.body).fillColor(INK).text(e.degree, M.left, y, { width: W - 70, continued: true })
          .font("Helvetica").fillColor(MID).text(`  ·  ${e.school}`, { continued: false });
        doc.moveDown(0.2);
      }
    }

    pageCount = doc.bufferedPageRange().count; endY = doc.y;
    doc.end();
  });
}
