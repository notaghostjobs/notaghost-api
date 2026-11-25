"""Import the founder's exported review (v2 page, or the first audit page's export) and compare with the hidden keys.
Run only once real grades exist:   python3 -I lab/eval/req2/import-review-v2.py <ghosted-review-grades.json>
Reads the keys from the workspace scratchpad; prints counts only, writes nothing to the repository."""
import json, sys, collections
S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"
SUIT = {"direct", "adjacent"}
key1 = {k["code"]: k for k in json.load(open(f"{S}/req/audit/audit-key.json"))}
key2 = {k["code"]: k for k in json.load(open(f"{S}/req2/audit-v2-key.json"))["pairs"]}
g = json.load(open(sys.argv[1]))
if g.get("audit") == "ghosted-match-audit-v1": p1, p2 = g["grades"], {}
elif g.get("audit") == "ghosted-match-review-v2": p1, p2 = g.get("part1", {}), g.get("part2", {})
else: sys.exit("not a review export")

def kappa(pairs):
    n = len(pairs)
    if not n: return float("nan"), float("nan")
    po = sum((h in SUIT) == (a in SUIT) for h, a in pairs) / n
    ph = sum(h in SUIT for h, a in pairs) / n; pa = sum(a in SUIT for h, a in pairs) / n
    pe = ph * pa + (1 - ph) * (1 - pa)
    return po, (po - pe) / (1 - pe) if pe < 1 else float("nan")

# part 1
gr = {c: v for c, v in p1.items() if v.get("grade")}
bad = [c for c in gr if c not in key1]; assert not bad, f"codes not in the part 1 key: {bad}"
pairs1 = [(v["grade"], key1[c]["grade"]) for c, v in gr.items()]
po, k = kappa(pairs1)
print(f"PART 1  graded {len(gr)}/{len(key1)}  exact agreement with AI {sum(h == a for h, a in pairs1)}/{len(pairs1)}  suitable-vs-not {po:.0%}  kappa {k:.2f}  needs clarification {sum(1 for v in gr.values() if v.get('clarify'))}")
cm = collections.Counter(pairs1)
for (h, a), n in sorted(cm.items()): print(f"   human {h:10s} AI {a:10s} {n}")
print(f"   human suitable {sum(h in SUIT for h, _ in pairs1)}  AI suitable {sum(a in SUIT for _, a in pairs1)}")

# part 2
done = {c: v for c, v in p2.items() if v.get("g1") and v.get("g2") and v.get("prefer")}
bad = [c for c in done if c not in key2]; assert not bad, f"codes not in the part 2 key: {bad}"
if done:
    pick_s = rep_s = pref_rep = pref_pick = same = neither = 0; ai_pairs = []
    for c, v in done.items():
        k2 = key2[c]; pick, rep = (v["g1"], v["g2"]) if k2["system_pick"] == 1 else (v["g2"], v["g1"])
        pick_s += pick in SUIT; rep_s += rep in SUIT
        pf = v["prefer"]
        if pf == "same": same += 1
        elif pf == "neither": neither += 1
        elif int(pf) == k2["system_pick"]: pref_pick += 1
        else: pref_rep += 1
        ai_pairs += [(v["g1"], k2["ai_grade_job1"]), (v["g2"], k2["ai_grade_job2"])]
    n = len(done); po2, k2v = kappa([(h, a) for h, a in ai_pairs if a])
    print(f"PART 2  complete {n}/{len(key2)}")
    print(f"   human judged suitable: system's pick {pick_s}/{n}, proposed replacement {rep_s}/{n}")
    print(f"   preferred: replacement {pref_rep}, system's pick {pref_pick}, either {same}, neither {neither}")
    print(f"   agreement with AI grades on these {len(ai_pairs)} jobs: suitable-vs-not {po2:.0%}, kappa {k2v:.2f}")
    rep1 = [c for c in done if key2[c]["also_in_part1"]]
    if rep1: print(f"   {len(rep1)} part 2 cases repeat a part 1 job (a consistency check)")
else:
    print("PART 2  no complete cases")
