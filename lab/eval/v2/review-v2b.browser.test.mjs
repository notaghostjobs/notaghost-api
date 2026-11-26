// Integrity tests for the blinded review page, in a real browser with every network request blocked.
//   node lab/eval/v2/review-v2b.browser.test.mjs <path to Radar-v2-review-v2b.html> [chromium|webkit|firefox]
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const pw = createRequire(import.meta.url)("playwright");
const file = process.argv[2], which = process.argv[3] ?? "chromium";
const html = readFileSync(file, "utf8");
const D0 = JSON.parse(/const D=(\{.*?\});const PKG/s.exec(html)[1].replace(/\\u003c/g, "<"));
const SHA = /data_sha:"([0-9a-f]+)"/.exec(html)[1]; const N = D0.cases.length, C = D0.cases.map((c) => c.code);
const dir = mkdtempSync(join(tmpdir(), "rv-"));
const browser = await pw[which].launch();
const ctx = await browser.newContext({ acceptDownloads: true });
let net = 0; await ctx.route(/^(https?|wss?):/, (r) => { net++; return r.abort(); });
const page = await ctx.newPage(); const errors = []; page.on("pageerror", (e) => errors.push(e.message));
const url = "file://" + file;
let n = 0; const t = async (name, f) => { await f(); n++; console.log("ok", n, name); };
const answer = async (s, a, c, p) => { await page.check(`input[name=suitability][value=${s}]`); await page.check(`input[name=apply][value=${a}]`); if (p) await page.check(`input[name=primary][value=${p}]`); await page.check(`input[name=confidence][value=${c}]`); if (c !== "high") await page.fill("#unc", "evidence thin"); };
const exportNow = async () => { const [d] = await Promise.all([page.waitForEvent("download"), page.click("#exp")]); const p = join(dir, d.suggestedFilename()); await d.saveAs(p); return { p, x: JSON.parse(readFileSync(p, "utf8")) }; };
const importFile = async (obj) => { const p = join(dir, "in-" + Math.random().toString(36).slice(2) + ".json"); writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj)); await page.setInputFiles("#imp", p); await page.waitForTimeout(100); };
const pageData = () => page.evaluate(() => JSON.stringify(D));

await page.goto(url); await page.fill("#rid", "rev-1"); await page.click("#setrid");
await answer("direct", "yes", "high"); await page.click("#nextOpen"); await answer("unsuitable", "no", "medium", "seniority"); await page.click("#nextOpen"); await page.check("input[name=suitability][value=stretch]");
let exp1;
await t("1 export/import round-trip restores every answer", async () => {
  exp1 = (await exportNow()).x;
  await page.evaluate(() => localStorage.clear()); await page.reload(); await page.fill("#rid", "rev-9"); await page.click("#setrid");
  await importFile(exp1); assert.equal(await page.locator("#okimp").count(), 0, "empty browser: no overwrite prompt");
  const exp2 = (await exportNow()).x; assert.deepEqual(exp2.answers, exp1.answers); assert.equal(exp2.reviewer, "rev-1"); assert.deepEqual(exp2.complete, [C[0], C[1]]);
});
await t("2 an export cannot change the case mapping or the case data", async () => {
  const before = await pageData(); const evil = structuredClone(exp1);
  Object.assign(evil, { cases: [{ code: C[0], cand: "Candidate ZZ" }], mapping: { [C[0]]: "control" }, people: {} });
  evil.answers[C[0]] = { ...evil.answers[C[0]], cand: "Candidate ZZ", arm: "v2", job_id: 1, text: "x" };
  await importFile(evil); await page.click("#okimp");  // the browser now holds answers, so the overwrite prompt appears
  assert.equal(await pageData(), before);
  const out = (await exportNow()).x; assert.deepEqual(Object.keys(out.answers[C[0]]).sort(), ["apply", "at", "confidence", "note", "reasons", "suitability", "uncertainty"]);
  assert.ok(!/control|"arm"|job_id|Candidate ZZ/.test(JSON.stringify(out)));
});
await t("3 an export from a different package is rejected and changes nothing", async () => {
  const before = (await exportNow()).x.answers;
  for (const bad of [{ ...exp1, package: { ...exp1.package, data_sha: "0000000000000000" } }, { ...exp1, package: { ...exp1.package, name: "other" } }, { reviewer: "x" }, "not json"]) {
    await importFile(bad); assert.match(await page.textContent(".banner"), /Rejected|not valid JSON/); }
  assert.deepEqual((await exportNow()).x.answers, before);
});
await t("4 answers cannot overwrite hidden data: unknown case IDs and prototype keys are rejected", async () => {
  const before = await pageData();
  for (const k of ["Z999", "__proto__", "constructor", "D"]) { const bad = JSON.parse(JSON.stringify(exp1).replace(`"${C[0]}":`, `"${k}":`)); await importFile(bad); assert.match(await page.textContent(".banner"), /Rejected/, k); }
  assert.equal(await pageData(), before); assert.equal(await page.evaluate(() => ({}).polluted), undefined);
  assert.ok(!/job_id|"arms"|"profile"|frozen|control_rank|v2_rank/.test(html), "no mapping or system data in the page");
});
await t("5 missing answers are listed explicitly in the export", async () => {
  const x = (await exportNow()).x; assert.equal(x.complete.length + x.missing.length, N); assert.equal(x.missing.length, N - 2); assert.ok(x.missing.includes(C[2]), "a partial answer counts as missing");
  assert.ok(x.answers[C[2]] && !x.complete.includes(C[2]));
});
await t("6 no system identity in the page or the export", async () => {
  await page.click("details summary").catch(() => {});
  const vis = (await page.textContent("body")).toLowerCase(); const exp = JSON.stringify((await exportNow()).x).toLowerCase();
  const shell = html.replace(/const D=\{.*?\};const PKG/s, "");
  for (const w of [/\bv2\b(?!b)/, /\bcontrol\b/, /\barm\b/, /\belig/, /sonnet/, /chatgpt/, /\bsystem [ab]\b/, /\bmodel\b/, /\bscore/, /\brank/]) { assert.ok(!w.test(exp), "export " + w); assert.ok(!w.test(shell.toLowerCase()), "page shell " + w); }
  assert.ok(!/candidate|cand"|B\d\d/.test(exp.replace(/"reviewer"/, "")), "export carries no candidate fields");
  assert.ok(vis.includes(C[0].toLowerCase()), "case IDs are visible");
});
await t("7 answers are recoverable after a reload, and the page still works when storage throws", async () => {
  const a = (await exportNow()).x.answers; await page.reload(); assert.deepEqual((await exportNow()).x.answers, a);
  const p2 = await ctx.newPage(); await p2.addInitScript(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  const errs = []; p2.on("pageerror", (e) => errs.push(e.message)); await p2.goto(url); await p2.fill("#rid", "rev-2"); await p2.click("#setrid");
  await p2.check("input[name=suitability][value=direct]"); assert.match(await p2.textContent("#done"), /reviewer rev-2/); assert.deepEqual(errs, []); await p2.close();
});
await t("8 works offline: zero network requests, no script errors, every case renders with full job text", async () => {
  for (const c of [0, Math.floor(N / 2), N - 1]) { await page.evaluate((k) => { for (let j = 0; j < k; j++) document.getElementById("prev").click(); }, (N - c) % N); }
  const lens = await page.evaluate(() => D.cases.map((c) => c.text.length)); assert.deepEqual(lens, D0.cases.map((c) => c.text.length));
  await page.keyboard.press("ArrowLeft"); assert.match(await page.textContent("#pos"), new RegExp(`of ${N}`));
  assert.equal(net, 0, "network requests"); assert.deepEqual(errors, []);
  const m = await browser.newContext({ viewport: { width: 375, height: 740 } }); const mp = await m.newPage(); await mp.goto(url);
  const sw = await mp.evaluate(() => document.documentElement.scrollWidth); assert.ok(sw <= 375, "no horizontal scroll at phone width: " + sw); await m.close();
});
await t("overwrite warning: importing into a browser that already has answers asks first; Keep current changes nothing", async () => {
  const a = (await exportNow()).x.answers; await importFile({ ...exp1, reviewer: "rev-7", answers: {} });
  assert.match(await page.textContent(".banner"), /will replace/); await page.click("#noimp"); assert.deepEqual((await exportNow()).x.answers, a);
});
console.log(`${n} tests passed in ${which} (package ${SHA}, ${N} cases)`);
await browser.close();
