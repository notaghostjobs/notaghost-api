"""Where judged-suitable jobs are found and lost, stage by stage, full inventory. Pooled judged relevance only."""
import json, collections
S="/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"
L=json.load(open(f"{S}/req/labels-merged-all.json")); R=json.load(open(f"{S}/req/arms-C-full.json")); arms={**json.load(open(f"{S}/arch/arms-full.json")),**R["arms"]}
cand={f"B{i:02d}":json.load(open(f"{S}/arch/cand/B{i:02d}.json")) for i in range(1,20)}; ids=json.load(open(f"{S}/arch/cand/job-ids.json")); pos={j:i for i,j in enumerate(ids)}
suit=collections.defaultdict(set)
for k,v in L.items():
    p,j=k.split("|")
    if v["grade"] in ("direct","adjacent"): suit[p].add(j)
tot=sum(len(v) for v in suit.values()); c=collections.Counter(); lost=collections.Counter()
for p,tr in R["track"].items():
    S_=suit[p]; fused=tr["fused_pool"]; ev=set(tr["evaluated"])
    for K in (50,100,200): c[f"fused pool top {K}"]+=len(S_&set(fused[:K]))
    c["evaluated by requirement layer"]+=len(S_&ev)
    for ch,lst in tr["channels"].items(): c[f"channel {ch} top 200"]+=len(S_&set(lst))
    for a in ["A","B_hybrid","C:req"]: c[f"final top 40, {a}"]+=len(S_&set(arms[a][p]["top"]+arms[a][p]["next"])); c[f"final top 5, {a}"]+=len(S_&set(arms[a][p]["top"]))
    for j in S_:
        sig=cand[p]["sig"][pos[j]] if j in pos else None
        if sig is None: lost["not a valid posting in the snapshot"]+=1
        elif sig[0]!=1: lost["removed by existing eligibility (city, language, years band)"]+=1
        elif sig[2]==0: lost["removed: two levels from target"]+=1
        elif j not in ev: lost["eligible but outside every retrieval channel's pool"]+=1
print(f"judged-suitable jobs (pooled over all arms ever graded): {tot} across {len(suit)} profiles")
for k,v in c.items(): print(f"  {k:55s} {v:4d}  ({v/tot:.0%})")
print("lost before the requirement layer:", dict(lost))
