const { chromium } = require('playwright'); const fs = require('fs');
(async () => { const b = await chromium.launch(); const ctx = await b.newContext({ acceptDownloads: true }); const p = await ctx.newPage();
await p.goto('file://' + __dirname + '/Ghosted-match-audit.html');
const D = await p.evaluate(() => D); const key = JSON.parse(fs.readFileSync(__dirname + '/audit-key.json', 'utf8'));
let mismatch = 0; const inv = new Map(fs.readFileSync(__dirname + '/../../bench/prod/inventory.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return [String(r.id), r]; }));
for (const k of key) { const it = D.items.find((x) => x.code === k.code); const r = inv.get(String(k.id)); if (!it || it.cand !== k.profile || it.title !== r.title || !D.resumes[k.profile]) mismatch++; }
console.log('items', D.items.length, 'key', key.length, 'mismatches (code→candidate, code→job title, résumé present):', mismatch);
await p.click('input[value=direct]'); await p.click('#next'); await p.click('input[value=unsuitable]'); await p.click('#clar');
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exp')]); await dl.saveAs(__dirname + '/test-export.json');
await p.reload(); const kept = await p.textContent('#pos'); console.log('after reload:', kept); await b.close(); })();
