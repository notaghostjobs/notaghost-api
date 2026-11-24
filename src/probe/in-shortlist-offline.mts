// The cut to the roles read closely (closest) and the final list (lastFive). Made-up rows; no network, no model.
import { closest, lastFive, type Row } from "../lib/usmatch.js";
const now = Date.parse("2026-11-24T12:00:00Z");
const row = (id: number, title: string, ref: string): Row => ({ system: "in", ref, job_id: String(id), title, location: "Bengaluru", remote: false, url: `https://example.test/${id}`, posted_at: "2026-11-20T00:00:00Z", level: "senior", func: null });
let bad = 0; const check = (name: string, ok: boolean, got?: unknown) => { if (!ok) bad++; console.log(`${ok ? "ok   " : "WRONG"} ${name}${ok ? "" : "  got " + JSON.stringify(got)}`); };
const count = (rows: Row[]) => { const m: Record<string, number> = {}; for (const r of rows) m[r.ref] = (m[r.ref] ?? 0) + 1; return m; };

// a narrow field: one bank has 12 credit roles, five other lenders one each
const narrow = [...Array.from({ length: 12 }, (_, i) => row(i + 1, "Credit Manager", "big bank")), ...["a", "b", "c", "d", "e"].map((x, i) => row(100 + i, "Credit Manager", `lender ${x}`))];
const t = ["Credit Manager"];
const strict = closest(narrow, t, "senior", 40, now);
check("without fill: two per employer, as before (7 of 17)", strict.length === 7 && count(strict)["big bank"] === 2, count(strict));
const filled = closest(narrow, t, "senior", 40, now, true);
check("with fill and room: roles turned away come back, up to 8 from one employer (13 of 17)", filled.length === 13 && count(filled)["big bank"] === 8, count(filled));
check("with fill: the first seven are the same seven, in the same order", strict.every((r, i) => filled[i].job_id === r.job_id));
// a broad field: 30 employers with 3 roles each. The list is full at two each; nobody gets a third.
const broad = Array.from({ length: 90 }, (_, i) => row(i + 1, "Credit Manager", `employer ${i % 30}`));
const b1 = closest(broad, t, "senior", 40, now), b2 = closest(broad, t, "senior", 40, now, true);
check("with fill and no room: identical to the list without it", b1.length === 40 && b1.every((r, i) => b2[i].job_id === r.job_id) && Math.max(...Object.values(count(b2))) === 2);
// fill is fair: 3 employers with 10 each, keep 12 → 4 each, not 8+2+2
const three = Array.from({ length: 30 }, (_, i) => row(i + 1, "Credit Manager", `e${i % 3}`));
check("fill goes round the employers one more each time", JSON.stringify(Object.values(count(closest(three, t, "senior", 12, now, true))).sort()) === "[4,4,4]", count(closest(three, t, "senior", 12, now, true)));
check("a title with none of the words is never let in", closest([row(1, "Credit Manager", "x"), row(2, "Chef", "x"), row(3, "Chef", "x")], t, "senior", 40, now, true).length === 1);
// a close match is not turned away for a weaker one: one lender has 6 exact roles, 45 other employers one loosely related role each
const t2 = ["Credit Risk Analyst"];
const mixed = [...Array.from({ length: 6 }, (_, i) => row(i + 1, "Credit Risk Analyst", "lender")), ...Array.from({ length: 45 }, (_, i) => row(100 + i, "Risk Operations Associate", `other ${i}`))];
const m0 = closest(mixed, t2, "senior", 40, now), m1 = closest(mixed, t2, "senior", 40, now, true);
check("without fill: 2 of the 6 exact roles reach the list of 40", m0.filter((r) => r.ref === "lender").length === 2 && m0.length === 40, count(m0).lender);
check("with fill: all 6 exact roles reach it, and they come first", m1.slice(0, 6).every((r) => r.ref === "lender") && m1.length === 40, count(m1).lender);
check("weaker matches stay at two per employer even with room", count(closest(Array.from({ length: 5 }, (_, i) => row(i + 1, "Risk Operations Associate", "x")), t2, "senior", 40, now, true)).x === 2);

// the final list
const rows = [row(1, "A", "one"), row(2, "B", "one"), row(3, "C", "one"), row(4, "D", "two"), row(5, "E", "three"), row(6, "F", "four"), row(7, "G", "five")];
const picks = [{ n: 1, score: 92 }, { n: 2, score: 90 }, { n: 3, score: 88 }, { n: 4, score: 80 }, { n: 4, score: 79 }, { n: 5, score: 59 }, { n: 6, score: 75 }, { n: 7, score: 70 }, { n: 99, score: 95 }, { n: 1.5, score: 99 }];
const five = lastFive(picks, rows);
check("final list: best first, a third role from one employer left out, repeats and unknown postings ignored, under 60 left out", JSON.stringify(five.map((p) => p.n)) === "[1,2,4,6,7]", five);
check("final list: never more than five", lastFive(Array.from({ length: 7 }, (_, i) => ({ n: i + 1, score: 90 - i })), rows.map((r, i) => ({ ...r, ref: `e${i}` }))).length === 5);
check("final list: nothing reasonable gives an empty list, not filler", lastFive([{ n: 1, score: 40 }], rows).length === 0);
if (bad) { console.error(`${bad} wrong`); process.exit(1); } console.log("all right");
