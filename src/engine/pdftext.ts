// Text out of a PDF by position, with no database or model behind it — so it can be tested on its own.

export function clean(s: string) {
  // a résumé font's own bullet comes out as a private-use character (\ue12c and the like): no other font can draw it,
  // and it would ride into the document as a box
  return s.replace(/[\ue000-\uf8ff\ufffd]/g, " ").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The page's text in reading order — lines rebuilt from glyph positions, top to bottom, left to right. A page laid out
 *  in two columns (a sidebar beside the main column) is read one column at a time: the main column of every page first,
 *  in page order, so a role that continues on the next page keeps its lines; the sidebars after. Null when the page
 *  cannot be read this way at all. */
export async function readingOrder(buf: Buffer): Promise<string | null> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  type It = { x: number; y: number; w: number; h: number; s: string };
  const mains: string[] = [], sides: string[] = [];
  let anyColumns = false;
  // lines: items whose baselines sit within half a line of each other, each line left to right, gaps kept as tabs
  const toLines = (items: It[], width: number) => {
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines: It[][] = [];
    for (const it of items) { const L = lines[lines.length - 1]; if (L && Math.abs(L[0].y - it.y) <= Math.max(2, L[0].h * 0.5)) L.push(it); else lines.push([it]); }
    return lines.map((L) => {
      L.sort((a, b) => a.x - b.x);
      let s = ""; let endX = -1;
      for (const it of L) {
        const gap = endX < 0 ? 0 : it.x - endX;
        if (endX >= 0 && gap > width * 0.08) s += "\t"; else if (endX >= 0 && gap > it.h * 0.15) s += " ";
        s += it.s; endX = it.x + it.w;
      }
      return s.replace(/[ \t]+$/, "");
    });
  };
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items: It[] = tc.items.filter((i: any) => typeof i.str === "string" && i.str.trim()).map((i: any) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10, s: i.str }));
      if (!items.length) { mains.push(""); sides.push(""); continue; }
      // where lines begin: a sidebar layout has many lines starting at the margin and many starting a fifth of the way in or later
      const probe = toLines([...items], vp.width);   // for the count only
      items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
      const starts: number[] = []; { const ls: It[][] = []; for (const it of items) { const L = ls[ls.length - 1]; if (L && Math.abs(L[0].y - it.y) <= Math.max(2, L[0].h * 0.5)) L.push(it); else ls.push([it]); } for (const L of ls) starts.push(Math.min(...L.map((i) => i.x))); }
      const left = starts.filter((x) => x < vp.width * 0.15).length, right = starts.filter((x) => x > vp.width * 0.2 && x < vp.width * 0.6).length;
      const columns = probe.length >= 8 && left / starts.length > 0.25 && right / starts.length > 0.25;
      if (!columns) { mains.push(toLines(items, vp.width).join("\n")); sides.push(""); continue; }
      anyColumns = true;
      // the split sits just before the second column's usual start; each item goes by where it begins
      const rs = starts.filter((x) => x > vp.width * 0.2 && x < vp.width * 0.6).sort((a, b) => a - b);
      const split = rs[Math.floor(rs.length * 0.1)] - 4;
      const L = items.filter((i) => i.x < split), R = items.filter((i) => i.x >= split);
      const lt = toLines(L, vp.width), rt = toLines(R, vp.width);
      const lc = lt.join("").length, rc = rt.join("").length;
      // the main column is the one with more text; the other is the sidebar
      if (rc >= lc) { mains.push(rt.join("\n")); sides.push(lt.join("\n")); } else { mains.push(lt.join("\n")); sides.push(rt.join("\n")); }
    }
  } finally { await doc.destroy().catch(() => {}); }
  const n = mains.length;
  const body = mains.map((t, i) => t + (i < n - 1 ? `\n\n-- ${i + 1} of ${n} --\n\n` : "")).join("");
  const side = sides.filter(Boolean).join("\n\n");
  const text = anyColumns && side ? `${body}\n\n-- sidebar --\n\n${side}` : body;
  return clean(text) || null;
}

/** The http(s) links embedded in the PDF (link annotations), in page order, without duplicates. */
export async function linkAnnotations(buf: Buffer): Promise<string[]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;
  const out: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const anns = await (await doc.getPage(p)).getAnnotations();
      for (const a of anns) { const u = typeof a?.url === "string" ? a.url.trim() : ""; if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u); }
    }
  } finally { await doc.destroy().catch(() => {}); }
  return out.slice(0, 12);
}

