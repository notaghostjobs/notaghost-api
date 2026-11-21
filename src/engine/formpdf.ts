import PDFDocument from "pdfkit";

export interface FormResume { name: string; email?: string; city?: string; college: string; degree: string; year: string; score?: string; skills: string;
  projects: { title: string; what: string }[]; experience?: string; extras?: string }

const lines = (t: string) => t.split(/\n|(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim().replace(/^[-•*]\s*/, "")).filter((x) => x.length > 2);

/** A student's typed details as a plain one-page text PDF: the same thing an upload would have been. No model writes any of it. */
export function formPdf(f: FormResume, phone?: string | null): Promise<Buffer> {
  return new Promise<Buffer>((res) => {
    const d = new PDFDocument({ size: "A4", margin: 50 }); const chunks: Buffer[] = [];
    d.on("data", (x) => chunks.push(x)); d.on("end", () => res(Buffer.concat(chunks)));
    const h = (t: string) => { d.moveDown(0.9).font("Helvetica-Bold").fontSize(11).text(t.toUpperCase()); d.moveDown(0.25).font("Helvetica").fontSize(10.5); };
    d.font("Helvetica-Bold").fontSize(20).text(f.name);
    d.font("Helvetica").fontSize(10.5).text([f.city || "Bengaluru", phone, f.email].filter(Boolean).join("  |  "));
    h("Education");
    d.font("Helvetica-Bold").text(f.degree); d.font("Helvetica").text(`${f.college}  |  ${f.year}${f.score ? `  |  ${f.score}` : ""}`);
    h("Skills"); d.text(f.skills);
    h("Projects");
    for (const p of f.projects) { d.font("Helvetica-Bold").text(p.title); d.font("Helvetica"); for (const l of lines(p.what)) d.text(`• ${l}`, { indent: 8 }); d.moveDown(0.3); }
    if (f.experience) { h("Experience"); for (const l of lines(f.experience)) d.text(`• ${l}`, { indent: 8 }); }
    if (f.extras) { h("Achievements"); for (const l of lines(f.extras)) d.text(`• ${l}`, { indent: 8 }); }
    d.end();
  });
}
