import { readFileSync, writeFileSync } from "node:fs";
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const { postingProblem } = await import("/home/claude/wt-api/src/lib/textfit.ts"); const { SPEC } = await import("/home/claude/wt-api/src/lib/ontology.ts");
const key = JSON.parse(readFileSync(`${S}/req/audit/audit-key.json`, "utf8")); const ans = JSON.parse(readFileSync(`${S}/sim2/answers.json`, "utf8"));
const inv = new Map(readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [String(r.id), r]; }));
const resumes: Record<string, string> = {}; const dirs: Record<string, string> = {};
for (const k of key) { if (!resumes[k.profile]) { resumes[k.profile] = readFileSync(`${S}/labels/resumes/${k.profile}.txt`, "utf8"); const a = ans[k.profile]; dirs[k.profile] = `${SPEC.get(a.direction_primary)?.label}${a.direction_secondary !== "none" ? `; also ${SPEC.get(a.direction_secondary)?.label}` : ""}. Target level: ${a.level}. Open to related work: ${a.open_to_adjacent}. Changing careers: ${a.transition}.`; } }
const items = key.map((k: any) => { const r: any = inv.get(String(k.id)); return { code: k.code, cand: k.profile, title: r.title, employer: r.company_name, location: r.location ?? "", url: r.url ?? "", posting: postingProblem(r.title, r.description).text }; });
const data = JSON.stringify({ items, resumes, dirs }).replace(/</g, "\\u003c");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ghosted match audit</title>
<style>
:root{--ink:#0C0C10;--body:#2A2A32;--muted:#6E6E7A;--rule:#E3E5EA;--mint:#7BE0A8;--card:#F5F6F8}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:var(--body);background:#fff}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--rule);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:2}
header b{color:var(--ink)}.bar{flex:1;min-width:120px;height:6px;background:var(--rule);border-radius:3px}.bar i{display:block;height:6px;background:var(--ink);border-radius:3px}
main{max-width:1200px;margin:0 auto;padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:900px){main{grid-template-columns:1fr}}
section{border:1px solid var(--rule);border-radius:10px;padding:14px;min-width:0}h2{font-size:15px;margin:0 0 6px;color:var(--ink)}
pre{white-space:pre-wrap;word-wrap:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;max-height:60vh;overflow:auto;background:var(--card);padding:10px;border-radius:8px;margin:0}
.note{color:var(--muted);font-size:13px}.grade{grid-column:1/-1;border:2px solid var(--ink)}
.opts{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.opts label{border:1px solid var(--rule);border-radius:8px;padding:8px 10px;cursor:pointer}
.opts input{margin-right:6px}textarea{width:100%;min-height:60px;font:inherit;border:1px solid var(--rule);border-radius:8px;padding:8px}
button{font:inherit;border:1px solid var(--ink);background:#fff;color:var(--ink);border-radius:8px;padding:8px 14px;cursor:pointer}button.primary{background:var(--ink);color:#fff}
button:focus-visible,label:focus-within{outline:2px solid var(--mint);outline-offset:2px}details summary{cursor:pointer;color:var(--ink);font-weight:600}
.rub dt{font-weight:600;color:var(--ink)}.rub dd{margin:0 0 6px}
</style></head><body>
<header><b>Match audit</b><span id="pos"></span><div class="bar"><i id="prog"></i></div><button id="prev">Previous</button><button id="next" class="primary">Next</button><button id="exp">Export grades</button></header>
<main>
<section style="grid-column:1/-1"><details><summary>How to grade (read once)</summary><dl class="rub">
<dt>Direct fit</dt><dd>The candidate's demonstrated experience closely satisfies the core responsibilities and essential requirements.</dd>
<dt>Adjacent fit</dt><dd>Meaningful transferable experience and a realistic, limited capability gap.</dd>
<dt>Stretch</dt><dd>A possible transition, but with substantial uncertainty or meaningful missing experience.</dd>
<dt>Unsuitable</dt><dd>The core work, seniority, specialisation or essential requirements are not adequately supported.</dd>
<dt>Invalid / ineligible</dt><dd>The posting is invalid, or an explicit mandatory eligibility condition is not met.</dd></dl>
<p class="note">Do not mark someone unsuitable only because their résumé uses different words, their title differs, they lack a <em>preferred</em> skill, or their experience is from a neighbouring industry. Do not invent capabilities either. Treat missing evidence as unknown unless contradicted; if the decision depends on something you cannot tell, tick "needs clarification". The stated direction is a <b>simulated</b> answer used in testing, not something the person said. Your grades stay in this browser until you export them.</p></details></section>
<section><h2 id="jt"></h2><div class="note" id="jm"></div><pre id="jp"></pre></section>
<section><h2>Candidate <span id="cid"></span></h2><div class="note">Stated direction (simulated): <span id="cd"></span></div><pre id="cr"></pre></section>
<section class="grade"><h2>Your grade</h2>
<div class="opts" id="g"></div>
<div class="opts"><span>Within the candidate's intended line of work?</span><label><input type="radio" name="line" value="yes">Yes</label><label><input type="radio" name="line" value="no">No</label></div>
<div class="opts"><label><input type="checkbox" id="clar">Needs clarification (depends on something I can't tell)</label></div>
<textarea id="why" placeholder="Optional: the deciding reason, in a few words"></textarea></section>
</main>
<script>
const D=${data};const KEY="ghosted-audit-v1";const G=[["direct","Direct fit"],["adjacent","Adjacent fit"],["stretch","Stretch"],["unsuitable","Unsuitable"],["invalid","Invalid / ineligible"]];
let st={};try{st=JSON.parse(localStorage.getItem(KEY)||"{}")}catch(e){st={}}let i=0;try{i=Math.min(Number(localStorage.getItem(KEY+":i")||0),D.items.length-1)}catch(e){}
const $=id=>document.getElementById(id);$("g").innerHTML=G.map(([v,l])=>'<label><input type="radio" name="grade" value="'+v+'">'+l+'</label>').join("");
function save(){const it=D.items[i];const g=document.querySelector('input[name=grade]:checked'),ln=document.querySelector('input[name=line]:checked');
 st[it.code]={grade:g?g.value:null,line:ln?ln.value:null,clarify:$("clar").checked,why:$("why").value,at:new Date().toISOString()};try{localStorage.setItem(KEY,JSON.stringify(st));localStorage.setItem(KEY+":i",i)}catch(e){}render()}
function render(){const it=D.items[i],s=st[it.code]||{};$("jt").textContent=it.title;$("jm").textContent=it.employer+(it.location?" · "+it.location:"")+" · "+it.code;$("jp").textContent=it.posting;
 $("cid").textContent=it.cand;$("cd").textContent=D.dirs[it.cand];$("cr").textContent=D.resumes[it.cand];
 document.querySelectorAll('input[name=grade]').forEach(r=>r.checked=r.value===s.grade);document.querySelectorAll('input[name=line]').forEach(r=>r.checked=r.value===s.line);$("clar").checked=!!s.clarify;$("why").value=s.why||"";
 const done=D.items.filter(x=>st[x.code]&&st[x.code].grade).length;$("pos").textContent=(i+1)+" of "+D.items.length+" · "+done+" graded";$("prog").style.width=(100*done/D.items.length)+"%"}
document.addEventListener("change",e=>{if(e.target.closest(".grade"))save()});$("why").addEventListener("input",()=>save());
$("next").onclick=()=>{if(i<D.items.length-1){i++;try{localStorage.setItem(KEY+":i",i)}catch(e){};render();scrollTo(0,0)}};$("prev").onclick=()=>{if(i>0){i--;render();scrollTo(0,0)}};
$("exp").onclick=()=>{const b=new Blob([JSON.stringify({audit:"ghosted-match-audit-v1",exported:new Date().toISOString(),grades:st},null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="ghosted-audit-grades.json";a.click()};
render();
</script></body></html>`;
writeFileSync(`${S}/req/audit/Ghosted-match-audit.html`, html); console.log((html.length / 1024).toFixed(0) + " KB", items.length, "pairs");
