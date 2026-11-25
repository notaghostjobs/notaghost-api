import json, random, collections
S="/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"; random.seed(20261125)
L=json.load(open(f"{S}/arch/labels-merged.json")); arms={**json.load(open(f"{S}/arch/arms-full.json")),**json.load(open(f"{S}/arch/arms-sub.json"))}
raw={}
for pack in ["lab-full","lab-sub"]:
    key=json.load(open(f"{S}/arch/{pack}/key.json"))
    for b in sorted({k["batch"] for k in key}):
        A={x["pair"]:x for x in json.load(open(f"{S}/arch/{pack}/b{b}/a/labels.json"))}; B={x["pair"]:x for x in json.load(open(f"{S}/arch/{pack}/b{b}/b/labels.json"))}
        for k in key:
            if k["batch"]==b: raw[(k["profile"],k["id"])]=(A[k["pair"]],B[k["pair"]])
tags={str(t["id"]):t for t in json.load(open(f"{S}/bench/prod/tags-v2.json"))}
def inA(p,j,k="top"): return j in arms["A"][p][k]
def inB(p,j,k="top"): return j in arms["B_hybrid"][p][k]
TECH=__import__("re").compile(r"\b(java|javascript|react|angular|node|python|spring|sql|aws|azure|kubernetes|\.net|c\+\+|golang|salesforce|sap|abap|tableau|power bi)\b",2)
MGMT=__import__("re").compile(r"\b(team|manage|lead|p&l|ownership|own|head|director|reports)\b",2)
pairs=[]
for (p,j),(a,b) in raw.items():
    g=L[f"{p}|{j}"]["grade"]; t=tags.get(j,{})
    f={"grade":g,"disputed":a["grade"]!=b["grade"] and ((a["grade"] in ("direct","adjacent"))!=(b["grade"] in ("direct","adjacent"))),
       "fn":t.get("fn") or "untagged","level":t.get("level","?"),
       "tech":bool(TECH.search(" ".join(a["missing"]+b["missing"]+[a["reason"],b["reason"]]))),
       "mgmt":bool(MGMT.search(" ".join([a["reason"],b["reason"]]))),
       "engines_disagree":inA(p,j)!=inB(p,j),
       "recovered": (inB(p,j) or inB(p,j,"next")) and not (inA(p,j) or inA(p,j,"next")) and g in ("direct","adjacent")}
    pairs.append(((p,j),f))
random.shuffle(pairs)
chosen=[]; seen=set()
def take(pred,n):
    c=0
    for k,f in pairs:
        if c>=n: break
        if k in seen or not pred(f): continue
        # spread across candidates and functions
        if sum(1 for x in chosen if x[0][0]==k[0])>=6: continue
        chosen.append((k,f)); seen.add(k); c+=1
take(lambda f:f["grade"]=="direct",12); take(lambda f:f["grade"]=="adjacent",14); take(lambda f:f["grade"]=="stretch",14); take(lambda f:f["grade"]=="unsuitable",14)
take(lambda f:f["disputed"],8); take(lambda f:f["tech"],6); take(lambda f:f["mgmt"],6); take(lambda f:f["engines_disagree"],6); take(lambda f:f["recovered"],6)
take(lambda f:f["grade"]=="invalid",2)
random.shuffle(chosen)
key=[{"code":f"R{i+1:03d}","profile":k[0],"id":k[1],**f} for i,(k,f) in enumerate(chosen)]
json.dump(key,open(f"{S}/req/audit/audit-key.json","w"),indent=1)
c=collections.Counter(x["grade"] for x in key); print(len(key),"pairs",dict(c),"profiles",len({x['profile'] for x in key}),"functions",len({x['fn'] for x in key}),
 "disputed",sum(x["disputed"] for x in key),"tech",sum(x["tech"] for x in key),"mgmt",sum(x["mgmt"] for x in key),"engines disagree",sum(x["engines_disagree"] for x in key),"recovered",sum(x["recovered"] for x in key))
