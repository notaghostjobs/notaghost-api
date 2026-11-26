"""Compare the shared eligibility gate with the two earlier approaches on the existing labels. Offline, no model call.
  python3 -I lab/eval/elig/score-elig.py <elig.json>
Labels: the 960 double-labelled candidate-job pairs (two independent AI labellers, merged; not human grades).
Suitable = direct or adjacent; not suitable = stretch, unsuitable or invalid ("conflict" pairs are left out).
Universe per candidate: labelled pairs whose job is in that candidate's frozen pool (retrieval pool + fallbacks), so
recall is "of the labelled suitable jobs that retrieval reached". evaluate-1 is compared on its own 121 labelled pairs."""
import json, sys, math, csv, collections
S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"
SUIT = {"direct", "adjacent"}; GAIN = {"direct": 3, "adjacent": 2, "stretch": 1}
L = {tuple(k.split("|")): v["grade"] for k, v in json.load(open(f"{S}/req/labels-merged-all.json")).items() if v["grade"] != "conflict"}
E = json.load(open(sys.argv[1])); gate, verdicts = E["arms"]["E:gate"], E["verdicts"]
ctrl = json.load(open(f"{S}/req2/arms-R2.json"))["arms"]["R2:A_control"]
ret = {r["p"]: r for r in json.load(open(f"{S}/req/full-B2.json"))["runs"]}
pool = {p: set(r["pool"]) | set(r["channels"]["fallback_fulltext"][:50]) | set(r["channels"]["fallback_title"][:50]) for p, r in ret.items()}
U = {k: g for k, g in L.items() if k[1] in pool.get(k[0], ())}

def metrics(name, rec):   # rec: {profile: ordered list of job ids}
    tp = fp = fn = 0; recd = 0
    for (p, j), g in U.items():
        r = j in rec.get(p, ())
        if r: recd += 1; tp += g in SUIT; fp += g not in SUIT
        else: fn += g in SUIT
    t5 = [L.get((p, j)) for p, l in rec.items() for j in l[:5]]; lab5 = [g for g in t5 if g]
    dcg = lambda gs: sum(GAIN.get(g, 0) / math.log2(i + 2) for i, g in enumerate(gs))
    nd = []
    for p, l in rec.items():
        gs = [L.get((p, j), "?") for j in l[:5]]; ideal = sorted([GAIN.get(g, 0) for (q, _), g in U.items() if q == p], reverse=True)[:5]
        if sum(ideal): nd.append(dcg(gs) / dcg([{3: "direct", 2: "adjacent", 1: "stretch"}.get(x, "?") for x in ideal]))
    size = [len(l) for l in rec.values()]
    return {"approach": name, "list size (median, min-max)": f"{sorted(size)[len(size)//2]} ({min(size)}-{max(size)})", "labelled in list": recd,
            "precision": tp / (tp + fp) if tp + fp else float("nan"), "recall": tp / (tp + fn) if tp + fn else float("nan"), "TP": tp, "FP": fp, "FN": fn,
            "top-5 suitable (of labelled)": f"{sum(g in SUIT for g in lab5)}/{len(lab5)}", "top-5 direct": sum(g == "direct" for g in lab5), "top-5 unlabelled": len(t5) - len(lab5),
            "NDCG@5 (unlabelled=0)": sum(nd) / len(nd)}

rows = [metrics("Offline matcher (control, fills 40)", {p: v["top"] + v["next"] for p, v in ctrl.items()}),
        metrics("Eligibility gate (list, at most 40)", {p: v["top"] + v["next"] for p, v in gate.items()}),
        metrics("Eligibility gate (every eligible job)", {p: [j for j, x in verdicts[p].items() if x["eligible"]] for p in verdicts})]
print(f"universe: {len(U)} labelled pairs in pools ({sum(g in SUIT for g in U.values())} suitable) across {len({p for p, _ in U})} candidates\n")
for r in rows:
    print(r["approach"]); [print(f"   {k:30s} {v:.2f}" if isinstance(v, float) else f"   {k:30s} {v}") for k, v in r.items() if k != "approach"]
# what the gate excluded, by reason, against the labels
ex = collections.defaultdict(collections.Counter)
for (p, j), g in U.items():
    v = verdicts.get(p, {}).get(j)
    if v and not v["eligible"]:
        r = v["why"][0]; k = "function" if "function" in r else "experience" if any(w in r for w in ("years", "step back", "seniority")) else "invalid" if "invalid" in r else "specialist"
        ex[k]["suitable" if g in SUIT else "not suitable"] += 1
print("\ngate exclusions among labelled pairs (first reason):", {k: dict(v) for k, v in ex.items()})

# evaluate-1 on its own 121 labelled pairs (labellers: yes / no; disputed left out)
inv = {}
for l in open(f"{S}/bench/prod/inventory.jsonl"):
    r = json.loads(l); inv.setdefault((r["title"].strip().lower(), (r["company_name"] or "").strip().lower()), str(r["id"]))
B = list(csv.DictReader(open(f"{S}/review/benchmark-final-labels.csv")))
def ev1(field_rec):
    tp = fp = fn = tn = 0; n = 0; miss = 0
    for b in B:
        if b["labellers: suitable"] not in ("yes", "no"): continue
        s = b["labellers: suitable"] == "yes"; rec = field_rec(b)
        if rec is None: miss += 1; continue
        n += 1; tp += s and rec; fp += (not s) and rec; fn += s and not rec; tn += (not s) and not rec
    return n, miss, tp, fp, fn, tn
gv = json.load(open(sys.argv[1].replace(".json", "-ev1.json"))) if len(sys.argv) > 2 else None
for name, f in [("evaluate-1 (shown)", lambda b: b["engine shown"] == "True")] + ([("Eligibility gate (eligible)", lambda b: gv.get(f"{b['profile']}|{inv.get((b['job title'].strip().lower(), b['employer'].strip().lower()))}"))] if gv else []):
    n, miss, tp, fp, fn, tn = ev1(f)
    print(f"\n{name} on evaluate-1's labelled pairs: n={n} (unmatched {miss})  precision {tp/(tp+fp) if tp+fp else float('nan'):.2f}  recall {tp/(tp+fn) if tp+fn else float('nan'):.2f}  TP {tp} FP {fp} FN {fn} TN {tn}")
