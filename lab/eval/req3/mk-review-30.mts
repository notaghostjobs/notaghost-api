// Radar matching validation: 30 blinded cases from the 88-case human-review package (26 Nov 2026).
// Which 30: the cases of the 88 that the matcher (match-req-2 control arm, frozen 24 Nov inventory) puts on the
// candidate's 40-role list, i.e. jobs it would recommend. Every such case in its top 5 first, then ranks 6-40 by a
// fixed hash, at most 3 per candidate. No grade, AI or otherwise, is used to choose. The page shows the job and the
// candidate only: no rank, score, band, AI grade or original code. Résumés are redacted (name, email, phone, links,
// PIN code). The key and the page stay in the workspace scratchpad (the page carries résumé text). No model call.
//   npx tsx lab/eval/req3/mk-review-30.mts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const { postingProblem } = await import("../../../src/lib/textfit.ts"); const { SPEC } = await import("../../../src/lib/ontology.ts");
mkdirSync(`${S}/req3`, { recursive: true });
const key88 = JSON.parse(readFileSync(`${S}/req/audit/audit-key.json`, "utf8"));
const arm = JSON.parse(readFileSync(`${S}/req2/arms-R2.json`, "utf8")).arms["R2:A_control"];
const ans = JSON.parse(readFileSync(`${S}/sim2/answers.json`, "utf8"));
const inv = new Map(readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [String(r.id), r]; }));
const h = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);

// 1. the 30
const rank = new Map<string, number>();
for (const [p, x] of Object.entries<any>(arm)) [...x.top, ...x.next].forEach((id: string, r: number) => rank.set(`${p}|${id}`, r + 1));
const onList = key88.filter((k: any) => rank.has(`${k.profile}|${k.id}`)).map((k: any) => ({ ...k, rank: rank.get(`${k.profile}|${k.id}`)! }));
const byHash = (a: any, b: any) => h(`pick30:${a.code}`) - h(`pick30:${b.code}`);
const ordered = [...onList.filter((x: any) => x.rank <= 5).sort(byHash), ...onList.filter((x: any) => x.rank > 5).sort(byHash)];
const per = new Map<string, number>(), chosen: any[] = [];
for (const x of ordered) { if (chosen.length >= 30) break; if ((per.get(x.profile) ?? 0) >= 3) continue; chosen.push(x); per.set(x.profile, (per.get(x.profile) ?? 0) + 1); }
if (chosen.length !== 30) throw new Error(`only ${chosen.length} cases`);
// shown in an order unrelated to rank, candidate or code
const shown = [...chosen].sort((a, b) => h(`show30:${a.code}`) - h(`show30:${b.code}`)).map((x, i) => ({ ...x, v: `V${String(i + 1).padStart(2, "0")}` }));

// 2. redaction
// a street address: a PIN code, a house number, "5th cross", "main road", a layout or apartment, or "<Name> Road/Street/Nagar"
const ADDR = /\[pin\]|\bno\.\s?#?\d|#\s?\d|\b\d+(st|nd|rd|th)\s+(cross|main)\b|\b(main road|layout|apartments?|flat no|premier)\b|\b[A-Z][a-z]+\s(Road|Street|Nagar)\b/i;
const NOT_NAME = /^(resume|résumé|curriculum|vitae|cv|profile|summary|contact|personal|details)$/i;
function redact(text: string): { text: string; nameTokens: number } {
  const lines = text.split("\n"); const first = lines.map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const toks = first.replace(/[^A-Za-z .'-]/g, " ").split(/\s+/).filter((t) => t.length >= 2 && !NOT_NAME.test(t));
  const looksName = toks.length >= 1 && toks.length <= 5 && first.length <= 60 && !/[|@:]/.test(first);
  const nameToks = looksName ? toks.map((t) => t.replace(/[.'-]+$/g, "")).filter((t) => t.length >= 3) : [];
  let t = text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\b(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|medium\.com)\/\S*/gi, "[link]")
    .replace(/(?:\+?\s?91[\s-]*)?(?:\(?\d{3,5}\)?[\s-]*){2,4}\d{2,5}/g, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m))
    .replace(/\b\d{6}\b/g, "[pin]")
    .replace(/\b(linkedin|github|gitlab|portfolio|behance)(\s*(profile|id|url|handle))?\s*[:\-]\s*\S+/gi, "$1: [link]");
  for (const n of nameToks) t = t.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  // the name line itself goes whole (initials included); in the header, a line with a PIN code or a street address goes too
  const out = t.split("\n"); let seen = 0;
  for (let k = 0; k < out.length && seen < 10; k++) {
    if (!out[k].trim()) continue; seen++;
    if (looksName && seen === 1) { out[k] = out[k].replace(/\S.*\S|\S/, "[name]"); continue; }
    if (out[k].length < 200 && ADDR.test(out[k])) out[k] = out[k].split("|").map((seg) => (ADDR.test(seg) ? " [address] " : seg)).join("|");
  }
  return { text: out.join("\n"), nameTokens: nameToks.length };
}
const resumes: Record<string, string> = {}, dirs: Record<string, string> = {}, redactLog: Record<string, number> = {};
for (const p of new Set(shown.map((x) => x.profile))) {
  const r = redact(readFileSync(`${S}/labels/resumes/${p}.txt`, "utf8")); resumes[p] = r.text; redactLog[p] = r.nameTokens;
  const a = ans[p]; dirs[p] = `${SPEC.get(a.direction_primary)?.label}${a.direction_secondary !== "none" ? `; also ${SPEC.get(a.direction_secondary)?.label}` : ""}. Target level: ${a.level}. Open to related work: ${a.open_to_adjacent}. Changing careers: ${a.transition}.`;
}
const candCode = new Map([...new Set(shown.map((x) => x.profile))].sort((a, b) => h(`cand30:${a}`) - h(`cand30:${b}`)).map((p, i) => [p, `Candidate ${String.fromCharCode(65 + i)}`]));
const job = (id: string) => { const r: any = inv.get(String(id)); return { title: r.title, employer: r.company_name, location: r.location ?? "", posting: postingProblem(r.title, r.description).text }; };
const cases = shown.map((x) => ({ code: x.v, cand: x.profile, ...job(x.id) }));
const pub = { cases: cases.map((c) => ({ ...c, cand: candCode.get(c.cand)! })), resumes: Object.fromEntries([...candCode].map(([p, c]) => [c, resumes[p]])), dirs: Object.fromEntries([...candCode].map(([p, c]) => [c, dirs[p]])) };
writeFileSync(`${S}/req3/review-30-key.json`, JSON.stringify({ made: new Date().toISOString(), rule: "88-case package ∩ control arm 40-role list; top 5 first, then ranks 6-40 by hash; ≤3 per candidate",
  cases: shown.map((x) => ({ code: x.v, r_code: x.code, profile: x.profile, candidate: candCode.get(x.profile), job_id: x.id, rank: x.rank, ai_grade: x.grade, fn: x.fn, level: x.level })), redaction_name_tokens: redactLog }, null, 1));

// 3. the page
const data = JSON.stringify(pub).replace(/</g, "\\u003c");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Radar match check</title>
<style>
:root{--ink:#16111a;--body:#2c2630;--muted:#6f6875;--rule:#e6e2e8;--card:#f6f4f7;--go:#1f7a4d;--goBg:#e3f4ea;--mid:#8a5a00;--midBg:#fbf0d9;--no:#9b2c2c;--noBg:#f8e3e3}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,"Segoe UI",Inter,Arial,sans-serif;color:var(--body);background:#fff}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--rule);padding:10px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:2}
header b{color:var(--ink)}#pos{font-variant-numeric:tabular-nums}.bar{flex:1;min-width:100px;height:6px;background:var(--rule);border-radius:3px}.bar i{display:block;height:6px;background:var(--ink);border-radius:3px}
main{max-width:1280px;margin:0 auto;padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){main{grid-template-columns:1fr}}
section{border:1px solid var(--rule);border-radius:10px;padding:14px;min-width:0}.full{grid-column:1/-1}h2{font-size:16px;margin:0 0 4px;color:var(--ink)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,Menlo,monospace;max-height:62vh;overflow:auto;background:var(--card);padding:10px;border-radius:8px;margin:8px 0 0}
.note{color:var(--muted);font-size:13px}.ask{border:2px solid var(--ink)}
.opts{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0;align-items:center}.opts label{border:1px solid var(--rule);border-radius:8px;padding:9px 12px;cursor:pointer;min-height:44px;display:flex;align-items:center}
.opts input{margin:0 8px 0 0}.opts label:has(input[value=apply]:checked){background:var(--goBg);border-color:var(--go)}.opts label:has(input[value=maybe]:checked){background:var(--midBg);border-color:var(--mid)}
.opts label:has(input[value=no]:checked){background:var(--noBg);border-color:var(--no)}.opts label:has(input[value=cant]:checked),.opts label:has(input[type=checkbox]:checked){background:var(--card);border-color:var(--ink)}
textarea{width:100%;min-height:56px;font:inherit;border:1px solid var(--rule);border-radius:8px;padding:8px}
button{font:inherit;border:1px solid var(--ink);background:#fff;color:var(--ink);border-radius:8px;padding:8px 12px;cursor:pointer;min-height:40px}button.primary{background:var(--ink);color:#fff}
:focus-visible{outline:2px solid #6b4bd6;outline-offset:2px}details summary{cursor:pointer;color:var(--ink);font-weight:600}dl dt{font-weight:600;color:var(--ink)}dl dd{margin:0 0 8px}
@media(max-width:700px){header{position:static}pre{max-height:none}.navlow{display:flex}}.navlow{display:none;gap:8px;margin-top:10px}.navlow button{flex:1}#why-box[hidden]{display:none}#out{width:100%;min-height:120px;font:12px ui-monospace,Menlo,monospace}#done{color:var(--muted);font-size:13px}
</style></head><body>
<header><b>Radar match check</b><span id="pos"></span><div class="bar"><i id="prog"></i></div>
<button id="prev">Previous</button><button id="next" class="primary">Next</button><button id="nextOpen">Next unanswered</button><button id="exp">Export answers</button><span id="done"></span></header>
<main id="m"></main>
<script>
const D=${data};const KEY="ghosted-review-30-v1";
const A=[["apply","I would apply"],["maybe","Maybe: I'd want to know more first"],["no","I would not apply"],["cant","Can't judge"]];
const R=[["work","Different kind of work"],["level","Wrong seniority"],["must","Missing a must-have"],["field","Wrong industry or domain"],["posting","Posting unclear or not a real job"],["other","Something else"]];
const HOW='<details open><summary>How to answer (read once, then collapse)</summary><p>Each screen is one job that Radar would recommend to one candidate. Read the candidate\\'s résumé and their stated direction, then the job. Answer one question: <b>if you were this candidate, would you apply to this job?</b></p><dl><dt>I would apply</dt><dd>It\\'s the kind of work they do or are aiming for, at a sensible level, and nothing essential is plainly missing. You\\'d spend the time on the application.</dd><dt>Maybe</dt><dd>Plausible, but you\\'d want an answer first (a requirement, the level, the team) before applying.</dd><dt>I would not apply</dt><dd>Wrong kind of work, wrong level, or a must-have they clearly don\\'t have. Tick the main reason.</dd><dt>Can\\'t judge</dt><dd>The posting is unreadable or not a real job, or the résumé doesn\\'t let you tell.</dd></dl><p class="note">Judge the fit, not the wording: a different job title, a missing <em>nice-to-have</em> or a neighbouring industry is not a reason to say no. Don\\'t assume skills the résumé doesn\\'t show either. The stated direction is a simulated answer used in testing. Names and contact details are hidden on purpose. The cases are in no particular order. Answers stay in this browser until you export them.</p></details>';
let st={};try{st=JSON.parse(localStorage.getItem(KEY)||"{}")||{}}catch(e){st={}}
let i=0;const $=id=>document.getElementById(id);const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const radios=(name,opts,cur,type)=>opts.map(([v,l])=>'<label><input type="'+(type||"radio")+'" name="'+name+'" value="'+v+'"'+((type?(cur||[]).includes(v):cur===v)?" checked":"")+'>'+l+'</label>').join("");
const complete=s=>!!(s&&s.answer);function persist(){try{localStorage.setItem(KEY,JSON.stringify(st))}catch(e){}}
function render(){const c=D.cases[i],s=st[c.code]||{};
 let h='<section class="full">'+HOW+'</section>';
 h+='<section><h2>'+esc(c.title)+'</h2><div class="note">'+esc(c.employer)+(c.location?" · "+esc(c.location):"")+'</div><pre>'+esc(c.posting)+'</pre></section>';
 h+='<section><h2>'+esc(c.cand)+'</h2><div class="note">Stated direction (simulated): '+esc(D.dirs[c.cand])+'</div><pre>'+esc(D.resumes[c.cand])+'</pre></section>';
 h+='<section class="full ask"><h2>'+esc(c.code)+': if you were '+esc(c.cand)+', would you apply?</h2><div class="opts" role="radiogroup">'+radios("answer",A,s.answer)+'</div>';
 h+='<div id="why-box"'+(s.answer==="no"||s.answer==="maybe"?"":" hidden")+'><div class="note">Main reason (tick any that apply)</div><div class="opts">'+radios("reason",R,s.reasons,"checkbox")+'</div></div>';
 h+='<textarea id="note" placeholder="Optional: the deciding reason, in a few words">'+esc(s.note||"")+'</textarea><div class="navlow"><button id="prev2">Previous</button><button id="next2" class="primary">Next unanswered</button></div></section>';
 h+='<section class="full"><details><summary>Export answers / restore</summary><p class="note">Export downloads a file. If the download doesn\\'t work here, copy the text below instead and send it. To continue on another device, paste an earlier export here and press Restore.</p><textarea id="out"></textarea><div class="opts"><button id="copy">Copy</button><button id="restore">Restore from pasted text</button></div></details></section>';
 $("m").innerHTML=h;$("prev2").onclick=()=>$("prev").click();$("next2").onclick=()=>$("nextOpen").click();$("out").value=dump();$("copy").onclick=()=>{$("out").select();try{navigator.clipboard.writeText($("out").value)}catch(e){document.execCommand&&document.execCommand("copy")}};
 $("restore").onclick=()=>{try{const x=JSON.parse($("out").value);if(x.audit!=="ghosted-review-30-v1")throw 0;st=x.answers||{};persist();render()}catch(e){$("out").value="That isn't an export from this page."}};counts()}
function dump(){return JSON.stringify({audit:"ghosted-review-30-v1",exported:new Date().toISOString(),answers:st},null,1)}
function save(){const c=D.cases[i],a=document.querySelector("input[name=answer]:checked");
 st[c.code]={answer:a?a.value:null,reasons:[...document.querySelectorAll("input[name=reason]:checked")].map(x=>x.value),note:$("note").value,at:new Date().toISOString()};
 $("why-box").hidden=!(a&&(a.value==="no"||a.value==="maybe"));persist();$("out").value=dump();counts()}
function counts(){const c=D.cases[i],n=D.cases.filter(x=>complete(st[x.code])).length;$("pos").textContent=c.code+" · "+(i+1)+" of "+D.cases.length;$("prog").style.width=(100*n/D.cases.length)+"%";$("done").textContent=n+" of "+D.cases.length+" answered"}
document.addEventListener("change",e=>{if(e.target.closest(".ask"))save()});document.addEventListener("input",e=>{if(e.target.id==="note")save()});
const go=n=>{i=n;render();scrollTo(0,0)};$("next").onclick=()=>{if(i<D.cases.length-1)go(i+1)};$("prev").onclick=()=>{if(i>0)go(i-1)};
$("nextOpen").onclick=()=>{for(let k=1;k<=D.cases.length;k++){const n=(i+k)%D.cases.length;if(!complete(st[D.cases[n].code]))return go(n)}};
$("exp").onclick=()=>{try{const b=new Blob([dump()],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="radar-match-check-answers.json";document.body.appendChild(a);a.click();a.remove()}catch(e){}const d=document.querySelector("section.full:last-child details");if(d)d.open=true};
render();
</script></body></html>`;
writeFileSync(`${S}/req3/Radar-match-check.html`, html);
console.log(`${(html.length / 1024).toFixed(0)} KB · ${cases.length} cases · ${candCode.size} candidates · top-5 cases ${shown.filter((x) => x.rank <= 5).length} · name tokens per résumé ${JSON.stringify(Object.values(redactLog))}`);
