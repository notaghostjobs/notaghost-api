import json, random, os
S="/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"; random.seed(2511)
B=json.load(open(f"{S}/arch/runs/full-B.json")); Cb=json.load(open(f"{S}/arch/runs/full-C-bge50.json")); Cm=json.load(open(f"{S}/arch/runs/full-C-mini50.json"))
arms={}
for run,tag,names in [(B,"",["B_single_vector","B_dense_multi","B_sparse_struct","B_hybrid"]),(Cb,"bge:",["C_rerank","C_rerank_fused"]),(Cm,"mini:",["C_rerank"])]:
    for r in run["runs"]:
        for n in names: arms.setdefault(tag+n,{})[r["p"]]=r["arms"][n]
for p in sorted(arms["B_hybrid"]):
    a=json.load(open(f"{S}/arch/cand/{p}.json"))["A"]; arms.setdefault("A",{})[p]={"top":[x["id"] for x in a["top"]],"next":[x["id"] for x in a["next"]]}
pairs={}
for arm,by in arms.items():
    for p,v in by.items():
        for i,j in enumerate(v["top"]): pairs.setdefault((p,j),[]).append(f"{arm}#{i+1}")
for arm in ["A","B_hybrid"]:
    for p,v in arms[arm].items():
        for j in random.sample(v["next"],min(3,len(v["next"]))): pairs.setdefault((p,j),[]).append(f"{arm}#next")
out=[{"profile":p,"id":j,"arms":a} for (p,j),a in sorted(pairs.items())]
json.dump(out,open(f"{S}/arch/pairs-full.json","w"),indent=1); json.dump(arms,open(f"{S}/arch/arms-full.json","w"))
print(len(out),"unique pairs; arms",list(arms))
