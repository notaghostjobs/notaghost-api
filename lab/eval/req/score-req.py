"""Merge two blind graders (plus adjudication where they split on suitability) and score every arm.
   python3 score-arch.py [--adjudicated FILE]"""
import json, math, os, sys, collections
S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"
SUIT = {"direct", "adjacent"}; GAIN = {"direct": 3, "adjacent": 2, "stretch": 1, "unsuitable": 0, "invalid": 0}
adj = {}
if "--adjudicated" in sys.argv:
    for x in json.load(open(sys.argv[sys.argv.index("--adjudicated") + 1])): adj[(x["profile"], x["id"])] = x["grade"]
lab, conflicts, agree, n = {}, [], 0, 0
cm = collections.Counter()
for pack in ["arch/lab-full", "arch/lab-sub", "req/lab-req"]:
    key = json.load(open(f"{S}/{pack}/key.json"))
    for b in sorted({k["batch"] for k in key}):
        try: A = {x["pair"]: x for x in json.load(open(f"{S}/{pack}/b{b}/a/labels.json"))}; B = {x["pair"]: x for x in json.load(open(f"{S}/{pack}/b{b}/b/labels.json"))}
        except Exception: print(f"(not yet graded: {pack} batch {b})"); continue
        for k in key:
            if k["batch"] != b: continue
            a, c = A[k["pair"]], B[k["pair"]]; n += 1; cm[(a["grade"], c["grade"])] += 1
            ga, gb = a["grade"], c["grade"]; sa, sb = ga in SUIT, gb in SUIT
            if ga == gb: agree += 1
            if sa and sb: g = "adjacent" if "adjacent" in (ga, gb) else "direct"
            elif not sa and not sb: g = ga if ga == gb else ("invalid" if "invalid" in (ga, gb) and ga in ("invalid", "unsuitable") and gb in ("invalid", "unsuitable") else ("stretch" if "stretch" in (ga, gb) else "unsuitable"))
            else:
                other = gb if sa else ga
                if other == "stretch": g = "stretch"          # suitable vs stretch: counted as stretch (not suitable), conservative
                else: g = adj.get((k["profile"], k["id"]), "conflict"); conflicts.append({"profile": k["profile"], "id": k["id"], "grades": [ga, gb], "reasons": [a["reason"], c["reason"]], "pack": pack, "batch": b, "pair": k["pair"]})
            lab[(k["profile"], k["id"])] = {"missing_both": bool(a.get("missing")) and bool(c.get("missing")), "grade": g, "wrong_fn": (not a["same_work"]) and (not c["same_work"]), "levels": [a["level"], c["level"]], "reasons": [a["reason"], c["reason"]], "invalid_any": "invalid" in (ga, gb)}
grades = [a for a in ["direct", "adjacent", "stretch", "unsuitable", "invalid"]]
# Cohen's kappa on suitable vs not
pa = sum(v for (x, y), v in cm.items() if x in SUIT) / n; pb = sum(v for (x, y), v in cm.items() if y in SUIT) / n
po = sum(v for (x, y), v in cm.items() if (x in SUIT) == (y in SUIT)) / n; pe = pa * pb + (1 - pa) * (1 - pb)
print(f"graded pairs {n}; exact grade agreement {agree/n:.0%}; suitable-vs-not kappa {(po-pe)/(1-pe):.2f}; conflicts needing adjudication {len([c for c in conflicts if lab[(c['profile'], c['id'])]['grade']=='conflict'])}")
json.dump(conflicts, open(f"{S}/req/conflicts.json", "w"), indent=1)
arms = {**json.load(open(f"{S}/arch/arms-full.json")), **json.load(open(f"{S}/arch/arms-sub.json")), **json.load(open(f"{S}/req/arms-req.json"))}
ONLY = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
if ONLY: arms = {k: v for k, v in arms.items() if any(k.startswith(o) for o in ONLY)}
def dcg(gs): return sum(g / math.log2(i + 2) for i, g in enumerate(gs))
ideal = collections.defaultdict(list); suit_by_p = collections.defaultdict(set)
for (p, j), v in lab.items():
    ideal[p].append(GAIN.get(v["grade"], 0))
    if v["grade"] in SUIT: suit_by_p[p].add(j)
rows = []
for arm, by in arms.items():
    t = collections.Counter(); nd = []; cov = 0; inline_prof = 0
    for p, v in by.items():
        top = v["top"]; gs = [lab.get((p, j), {"grade": "?"})["grade"] for j in top]
        t["n"] += len(top); t["suit"] += sum(g in SUIT for g in gs); t["direct"] += gs.count("direct"); t["inline"] += sum(g in ("direct", "adjacent", "stretch") for g in gs)
        t["conflict"] += gs.count("conflict"); t["unlab"] += gs.count("?"); t["invalid"] += sum(lab.get((p, j), {}).get("invalid_any", False) and lab[(p, j)]["grade"] == "invalid" for j in top)
        t["wrongfn"] += sum(lab.get((p, j), {}).get("wrong_fn", False) for j in top)
        t["reqmis"] += sum(1 for j in top if lab.get((p, j), {}).get("grade") in ("stretch", "unsuitable") and lab[(p, j)].get("missing_both"))
        cov += any(g in SUIT for g in gs); inline_prof += any(g in ("direct", "adjacent", "stretch") for g in gs)
        idl = dcg(sorted(ideal[p], reverse=True)[:5]); nd.append(dcg([GAIN.get(g, 0) for g in gs]) / idl if idl else 0)
        rel = suit_by_p[p]; t["rel"] += len(rel); t["rel40"] += len(rel & set(top + v["next"]))
    rows.append((arm, t, sum(nd) / len(nd), cov, inline_prof, len(by)))
print(f"{'arm':28s} P@5 (n)       direct  in-line  wrong-fn  req-mismatch  NDCG@5  profiles≥1 suitable  judged-suitable in top40  invalid  conflicts")
for arm, t, ndcg, cov, ip, np_ in rows:
    print(f"{arm:28s} {t['suit']/t['n']:.0%} ({t['suit']}/{t['n']})  {t['direct']:3d}    {t['inline']/t['n']:.0%}      {t['wrongfn']:3d}       {t['reqmis']:3d}         {ndcg:.2f}    {cov}/{np_}                {t['rel40']}/{t['rel']}                  {t['invalid']}        {t['conflict']}{'  unlabelled '+str(t['unlab']) if t['unlab'] else ''}")
json.dump({f"{p}|{j}": v for (p, j), v in lab.items()}, open(f"{S}/req/labels-merged-all.json", "w"), indent=0)
