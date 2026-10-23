import PDFDocument from "pdfkit";
import type { Rewrite, ResumeProfile } from "./sharpen.js";

/** Clean one-column résumé PDF. Returns a Buffer. */
export function resumePdf(r: Rewrite, orig: ResumeProfile): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 48, left: 54, right: 54 } });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const W = doc.page.width - 108;
    const contact = [orig.contact.email, orig.contact.phone, orig.contact.city, ...(orig.contact.links ?? [])].filter(Boolean).join("  ·  ");

    doc.font("Helvetica-Bold").fontSize(20).text(orig.name);
    doc.moveDown(0.15).font("Helvetica").fontSize(11).fillColor("#333").text(r.headline);
    if (contact) doc.moveDown(0.15).fontSize(9).fillColor("#666").text(contact);
    doc.moveDown(0.6).fillColor("#000");

    const section = (t: string) => {
      doc.moveDown(0.5).font("Helvetica-Bold").fontSize(9.5).fillColor("#000").text(t.toUpperCase(), { characterSpacing: 1 });
      doc.moveTo(54, doc.y + 2).lineTo(54 + W, doc.y + 2).lineWidth(0.5).strokeColor("#999").stroke();
      doc.moveDown(0.4);
    };

    section("Summary");
    doc.font("Helvetica").fontSize(10).fillColor("#111").text(r.summary, { width: W, lineGap: 1.5 });

    section("Experience");
    for (const role of r.roles) {
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000").text(role.title, { continued: true })
         .font("Helvetica").fillColor("#333").text(`  —  ${role.company}`, { continued: true })
         .fontSize(9).fillColor("#666").text(`   ${role.start} – ${role.end}`, { align: "right" });
      doc.moveDown(0.15);
      for (const b of role.bullets) {
        doc.font("Helvetica").fontSize(10).fillColor("#111").text(`•  ${b}`, { width: W, indent: 0, lineGap: 1.2 });
      }
      doc.moveDown(0.45);
    }

    if (r.skills.length) {
      section("Skills");
      doc.font("Helvetica").fontSize(10).fillColor("#111").text(r.skills.join("  ·  "), { width: W, lineGap: 1.5 });
    }
    if (r.education.length) {
      section("Education");
      for (const e of r.education)
        doc.font("Helvetica").fontSize(10).fillColor("#111").text(`${e.degree}, ${e.school}${e.year ? `  ·  ${e.year}` : ""}`);
    }
    doc.end();
  });
}
