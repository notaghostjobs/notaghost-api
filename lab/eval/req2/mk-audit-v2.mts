// Human review package v2: part 1 is the 88 blinded candidate–job cases (unchanged codes R001–R088); part 2 is the
// employer-distinct proposed replacements, each shown as two jobs in a fixed random order with no ranks, scores or AI
// grades, so the reviewer cannot tell which job the system picked. One page, one export. The key stays in the
// workspace. Output goes to the scratchpad only (the page carries the QA résumés' text).
//   npx tsx lab/eval/req2/mk-audit-v2.mts
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad";
const { postingProblem } = await import("../../../src/lib/textfit.ts"); const { SPEC } = await import("../../../src/lib/ontology.ts");
const key1 = JSON.parse(readFileSync(`${S}/req/audit/audit-key.json`, "utf8"));
const reps = JSON.parse(readFileSync(`${S}/req2/replacements-30.json`, "utf8"));
const labels = JSON.parse(readFileSync(`${S}/req/labels-merged-all.json`, "utf8"));
const ans = JSON.parse(readFileSync(`${S}/sim2/answers.json`, "utf8"));
const inv = new Map(readFileSync(`${S}/bench/prod/inventory.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [String(r.id), r]; }));
const job = (id: string) => { const r: any = inv.get(String(id)); return { title: r.title, employer: r.company_name, location: r.location ?? "", posting: postingProblem(r.title, r.description).text }; };
const resumes: Record<string, string> = {}, dirs: Record<string, string> = {};
const addCand = (p: string) => { if (resumes[p]) return; resumes[p] = readFileSync(`${S}/labels/resumes/${p}.txt`, "utf8"); const a = ans[p]; dirs[p] = `${SPEC.get(a.direction_primary)?.label}${a.direction_secondary !== "none" ? `; also ${SPEC.get(a.direction_secondary)?.label}` : ""}. Target level: ${a.level}. Open to related work: ${a.open_to_adjacent}. Changing careers: ${a.transition}.`; };
const h = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);

const part1 = key1.map((k: any) => { addCand(k.profile); return { code: k.code, cand: k.profile, ...job(k.id) }; });
// part 2: order of pairs shuffled by a fixed hash (not by profile or rank); side of the system's pick by another hash
const pairs = reps.map((r: any) => ({ r, s: h(`pair:${r.profile}:${r.failed_id}:${r.replacement_id}`) })).sort((a: any, b: any) => a.s - b.s).map(({ r }: any, i: number) => {
  addCand(r.profile); const pickFirst = h(`side:${r.profile}:${r.failed_id}`) % 2 === 0;
  const [a, b] = pickFirst ? [r.failed_id, r.replacement_id] : [r.replacement_id, r.failed_id];
  return { pub: { code: `P${String(i + 1).padStart(2, "0")}`, cand: r.profile, j1: job(a), j2: job(b) },
    key: { code: `P${String(i + 1).padStart(2, "0")}`, profile: r.profile, job1: a, job2: b, system_pick: pickFirst ? 1 : 2, failed_id: r.failed_id, replacement_id: r.replacement_id, replacement_pool_rank: r.replacement_pool_rank,
      ai_grade_job1: labels[`${r.profile}|${a}`]?.grade ?? null, ai_grade_job2: labels[`${r.profile}|${b}`]?.grade ?? null,
      also_in_part1: key1.filter((k: any) => k.profile === r.profile && (k.id === a || k.id === b)).map((k: any) => k.code) } };
});
writeFileSync(`${S}/req2/audit-v2-key.json`, JSON.stringify({ part1_key: "req/audit/audit-key.json", pairs: pairs.map((p: any) => p.key) }, null, 1));
const data = JSON.stringify({ part1, part2: pairs.map((p: any) => p.pub), resumes, dirs }).replace(/</g, "\\u003c");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ghosted match review</title>
<style>
:root{--ink:#0C0C10;--body:#2A2A32;--muted:#6E6E7A;--rule:#E3E5EA;--mint:#7BE0A8;--card:#F5F6F8}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,Segoe UI,Inter,Arial,sans-serif;color:var(--body);background:#fff}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--rule);padding:10px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:2}
header b{color:var(--ink)}.bar{flex:1;min-width:120px;height:6px;background:var(--rule);border-radius:3px}.bar i{display:block;height:6px;background:var(--ink);border-radius:3px}
.tabs button[aria-pressed=true]{background:var(--ink);color:#fff}
main{max-width:1280px;margin:0 auto;padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:16px}main.three{grid-template-columns:1fr 1fr 1fr}
@media(max-width:1000px){main,main.three{grid-template-columns:1fr}}
section{border:1px solid var(--rule);border-radius:10px;padding:14px;min-width:0}h2{font-size:15px;margin:0 0 6px;color:var(--ink)}
pre{white-space:pre-wrap;word-wrap:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;max-height:60vh;overflow:auto;background:var(--card);padding:10px;border-radius:8px;margin:0}
.note{color:var(--muted);font-size:13px}.full{grid-column:1/-1}.grade{border:2px solid var(--ink)}
.opts{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;align-items:center}.opts label{border:1px solid var(--rule);border-radius:8px;padding:7px 10px;cursor:pointer}
.opts input{margin-right:6px}textarea{width:100%;min-height:56px;font:inherit;border:1px solid var(--rule);border-radius:8px;padding:8px}
button{font:inherit;border:1px solid var(--ink);background:#fff;color:var(--ink);border-radius:8px;padding:7px 12px;cursor:pointer}button.primary{background:var(--ink);color:#fff}
button:focus-visible,label:focus-within,summary:focus-visible{outline:2px solid var(--mint);outline-offset:2px}details summary{cursor:pointer;color:var(--ink);font-weight:600}
.rub dt{font-weight:600;color:var(--ink)}.rub dd{margin:0 0 6px}#done{color:var(--muted);font-size:13px}
</style></head><body>
<header><b>Match review</b><span class="tabs"><button id="t1" aria-pressed="true">Part 1 · single jobs</button> <button id="t2" aria-pressed="false">Part 2 · two jobs</button></span>
<span id="pos"></span><div class="bar"><i id="prog"></i></div><button id="prev">Previous</button><button id="next" class="primary">Next</button><button id="nextOpen">Next ungraded</button><button id="exp">Export</button><span id="done"></span></header>
<main id="m"></main>
<script>
const D=${data};const KEY="ghosted-review-v2";const G=[["direct","Direct fit"],["adjacent","Adjacent fit"],["stretch","Stretch"],["unsuitable","Unsuitable"],["invalid","Invalid / ineligible"]];
const RUB='<details><summary>How to grade (read once)</summary><dl class="rub"><dt>Direct fit</dt><dd>The candidate\\'s demonstrated experience closely satisfies the core responsibilities and essential requirements.</dd><dt>Adjacent fit</dt><dd>Meaningful transferable experience and a realistic, limited capability gap.</dd><dt>Stretch</dt><dd>A possible transition, but with substantial uncertainty or meaningful missing experience.</dd><dt>Unsuitable</dt><dd>The core work, seniority, specialisation or essential requirements are not adequately supported.</dd><dt>Invalid / ineligible</dt><dd>The posting is invalid, or an explicit mandatory eligibility condition is not met.</dd></dl><p class="note">Do not mark someone unsuitable only because their résumé uses different words, their title differs, they lack a <em>preferred</em> skill, or their experience is from a neighbouring industry. Do not invent capabilities either. Treat missing evidence as unknown unless contradicted; if the decision depends on something you cannot tell, tick "needs clarification". The stated direction is a <b>simulated</b> answer used in testing. In part 2 the two jobs are in no particular order. Your grades stay in this browser until you export them.</p></details>';
let st={p1:{},p2:{}};try{const x=JSON.parse(localStorage.getItem(KEY)||"null");if(x)st=x}catch(e){}
// carry over grades made in the first audit page, if this browser has them
try{const v1=JSON.parse(localStorage.getItem("ghosted-audit-v1")||"{}");for(const c in v1)if(!st.p1[c]&&v1[c]&&v1[c].grade)st.p1[c]=v1[c]}catch(e){}
let part=1,i=0;const $=id=>document.getElementById(id);const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const radios=(name,opts,cur)=>opts.map(([v,l])=>'<label><input type="radio" name="'+name+'" value="'+v+'"'+(cur===v?" checked":"")+'>'+l+'</label>').join("");
const list=()=>part===1?D.part1:D.part2;const store=()=>part===1?st.p1:st.p2;
const complete=(s,p)=>p===1?!!(s&&s.grade):!!(s&&s.g1&&s.g2&&s.prefer);
function persist(){try{localStorage.setItem(KEY,JSON.stringify(st))}catch(e){}}
function jobBox(t,j){return '<section><h2>'+esc(t)+': '+esc(j.title)+'</h2><div class="note">'+esc(j.employer)+(j.location?", "+esc(j.location):"")+'</div><pre>'+esc(j.posting)+'</pre></section>'}
function candBox(c){return '<section><h2>Candidate '+esc(c)+'</h2><div class="note">Stated direction (simulated): '+esc(D.dirs[c])+'</div><pre>'+esc(D.resumes[c])+'</pre></section>'}
function render(){const it=list()[i],s=store()[it.code]||{};const m=$("m");m.className=part===2?"three":"";
 let h='<section class="full">'+RUB+'</section>';
 if(part===1){h+=jobBox("Job",it)+candBox(it.cand)+'<section class="full grade"><h2>Your grade for '+it.code+'</h2><div class="opts">'+radios("grade",G,s.grade)+'</div><div class="opts"><span>Within the candidate\\'s intended line of work?</span>'+radios("line",[["yes","Yes"],["no","No"]],s.line)+'</div>';}
 else{h+=candBox(it.cand)+jobBox("Job 1",it.j1)+jobBox("Job 2",it.j2)+'<section class="full grade"><h2>Your grades for '+it.code+'</h2><div class="opts"><span>Job 1</span>'+radios("g1",G,s.g1)+'</div><div class="opts"><span>Job 2</span>'+radios("g2",G,s.g2)+'</div><div class="opts"><span>If this candidate could be shown only one, which?</span>'+radios("prefer",[["1","Job 1"],["2","Job 2"],["same","Either, equally"],["neither","Neither"]],s.prefer)+'</div>';}
 h+='<div class="opts"><label><input type="checkbox" id="clar"'+(s.clarify?" checked":"")+'>Needs clarification (depends on something I can\\'t tell)</label></div><textarea id="why" placeholder="Optional: the deciding reason, in a few words">'+esc(s.why||"")+'</textarea></section>';
 m.innerHTML=h;counts()}
function save(){const it=list()[i],v=n=>{const r=document.querySelector('input[name='+n+']:checked');return r?r.value:null};
 const base={clarify:$("clar").checked,why:$("why").value,at:new Date().toISOString()};
 store()[it.code]=part===1?{grade:v("grade"),line:v("line"),...base}:{g1:v("g1"),g2:v("g2"),prefer:v("prefer"),...base};persist();
 counts()}
function counts(){const it=list()[i],L=list(),done=L.filter(x=>complete(store()[x.code],part)).length;$("pos").textContent=it.code+" · "+(i+1)+" of "+L.length+" · "+done+" complete";$("prog").style.width=(100*done/L.length)+"%";
 const d1=D.part1.filter(x=>complete(st.p1[x.code],1)).length,d2=D.part2.filter(x=>complete(st.p2[x.code],2)).length;$("done").textContent="Part 1: "+d1+"/"+D.part1.length+" · Part 2: "+d2+"/"+D.part2.length}
document.addEventListener("change",e=>{if(e.target.closest(".grade"))save()});document.addEventListener("input",e=>{if(e.target.id==="why")save()});
const go=n=>{i=n;render();scrollTo(0,0)};$("next").onclick=()=>{if(i<list().length-1)go(i+1)};$("prev").onclick=()=>{if(i>0)go(i-1)};
$("nextOpen").onclick=()=>{const L=list();for(let k=1;k<=L.length;k++){const n=(i+k)%L.length;if(!complete(store()[L[n].code],part))return go(n)}};
const tab=p=>{part=p;i=0;$("t1").setAttribute("aria-pressed",p===1);$("t2").setAttribute("aria-pressed",p===2);render();scrollTo(0,0)};$("t1").onclick=()=>tab(1);$("t2").onclick=()=>tab(2);
$("exp").onclick=()=>{const b=new Blob([JSON.stringify({audit:"ghosted-match-review-v2",exported:new Date().toISOString(),part1:st.p1,part2:st.p2},null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="ghosted-review-grades.json";a.click()};
render();
</script></body></html>`;
writeFileSync(`${S}/req2/Ghosted-match-review.html`, html);
console.log(`${(html.length / 1024).toFixed(0)} KB · part 1 ${part1.length} cases · part 2 ${pairs.length} pairs · system pick shown first in ${pairs.filter((p: any) => p.key.system_pick === 1).length}`);
