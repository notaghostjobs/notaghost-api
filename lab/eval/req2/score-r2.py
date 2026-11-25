import json, math, collections, re
S="/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"
SUIT={"direct","adjacent"}; GAIN={"direct":3,"adjacent":2,"stretch":1}
TECH=re.compile(r"\b(java|javascript|react|angular|node|python|spring|golang|go\b|\.net|c#|c\+\+|kotlin|swift|scala|terraform|kubernetes|sap|abap|salesforce|apex|sql|aws|azure|gcp|spark|databricks|tableau|power bi|selenium|verilog|embedded)\b",2)
raw={}
for pack in ["arch/lab-full","arch/lab-sub","req/lab-req","req2/lab-r2"]:
    key=json.load(open(f"{S}/{pack}/key.json"))
    for b in sorted({k["batch"] for k in key}):
        A={x["pair"]:x for x in json.load(open(f"{S}/{pack}/b{b}/a/labels.json"))}; B={x["pair"]:x for x in json.load(open(f"{S}/{pack}/b{b}/b/labels.json"))}
        for k in key:
            if k["batch"]==b: raw[(k["profile"],k["id"])]=(A[k["pair"]],B[k["pair"]])
def merged(a,b):
    ga,gb=a["grade"],b["grade"]; sa,sb=ga in SUIT,gb in SUIT
    if sa and sb: return "adjacent" if "adjacent" in (ga,gb) else "direct"
    if not sa and not sb: return ga if ga==gb else ("invalid" if {ga,gb}<= {"invalid","unsuitable"} else ("stretch" if "stretch" in (ga,gb) else "unsuitable"))
    return "stretch" if (gb if sa else ga)=="stretch" else "conflict"
lab={k:merged(*v) for k,v in raw.items()}
R=json.load(open(f"{S}/req2/arms-R2.json"))["arms"]; arms={"B_hybrid (Phase 1)":json.load(open(f"{S}/arch/arms-full.json"))["B_hybrid"],"C:req (Phase 2)":json.load(open(f"{S}/req/arms-req.json"))["C:req"],**R}
ideal=collections.defaultdict(list); suit=collections.defaultdict(set)
for (p,j),g in lab.items():
    ideal[p].append(GAIN.get(g,0))
    if g in SUIT: suit[p].add(j)
dcg=lambda gs: sum(g/math.log2(i+2) for i,g in enumerate(gs))
print(f"{'arm':22s} suitable  direct adjacent  NDCG@5  covered  wrong-fn  stack-mismatch  seniority-mismatch  invalid  judged-suitable-in-top40  unlabelled")
per={}
for arm,by in arms.items():
    t=collections.Counter(); nd=[]; cov=0
    for p,v in by.items():
        gs=[lab.get((p,j),"?") for j in v["top"]]; t["n"]+=5; t["s"]+=sum(g in SUIT for g in gs); t["d"]+=gs.count("direct"); t["a"]+=gs.count("adjacent"); t["inv"]+=gs.count("invalid"); t["?"]+=gs.count("?")
        for j,g in zip(v["top"],gs):
            if (p,j) not in raw: continue
            a,b=raw[(p,j)]
            if not a["same_work"] and not b["same_work"]: t["wf"]+=1
            if g not in SUIT and (TECH.search(" ".join(a["missing"]+[a["reason"]])) and TECH.search(" ".join(b["missing"]+[b["reason"]]))): t["stack"]+=1
            if g not in SUIT and a["level"] in ("too_far","one_up","below") and b["level"] in ("too_far","one_up","below"): t["sen"]+=1
        cov+=any(g in SUIT for g in gs); idl=dcg(sorted(ideal[p],reverse=True)[:5]); nd.append(dcg([GAIN.get(g,0) for g in gs])/idl if idl else 0)
        t["rel"]+=len(suit[p]); t["r40"]+=len(suit[p]&set(v["top"]+v["next"]))
        per.setdefault(p,{})[arm]=sum(g in SUIT for g in gs)
    print(f"{arm:22s} {t['s']:2d}/95     {t['d']:3d}    {t['a']:3d}      {sum(nd)/len(nd):.2f}    {cov}/19     {t['wf']:3d}         {t['stack']:3d}               {t['sen']:3d}            {t['inv']}         {t['r40']}/{t['rel']}               {t['?']}")
print("per profile suitable picks:")
for p in sorted(per): print(" ",p, {k.split(" ")[0]:v for k,v in per[p].items()})
