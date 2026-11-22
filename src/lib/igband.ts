export type Band = "intern" | "fresher" | "y1_3" | "y4_7" | "y8";
const BANDS: Band[] = ["intern", "fresher", "y1_3", "y4_7", "y8"];
/** Which shelf a role sits on. A band written on the entry wins; otherwise it is read from the role's name and the
 *  "who it is for" line: an internship by its title, then the first number of years asked for, else a fresher role. */
export function bandOf(e: { band?: string; role?: string; who?: string | null }, title = ""): Band {
  if (e.band && (BANDS as string[]).includes(e.band)) return e.band as Band;
  if (/\bintern(ship)?\b/i.test(`${e.role ?? ""} ${title}`)) return "intern";
  const m = /(\d+(?:\.\d+)?)\s*(?:\+|[–-]\s*\d+)?\s*years?/i.exec(e.who ?? "");
  if (!m) return "fresher";
  const n = Number(m[1]);
  return n < 4 ? "y1_3" : n < 8 ? "y4_7" : "y8";
}
