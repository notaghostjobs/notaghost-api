"""Score the founder's exported Radar match check (30 blinded cases) against the approved pass mark.
Run only after real answers exist:   python3 -I lab/eval/req3/score-review-30.py <radar-match-check-answers.json> [pass_mark]
pass_mark defaults to 24 (provisional until the founder approves it). Reads the hidden key from the workspace scratchpad.
Counts only; no model call; writes nothing to the repository.
Pass rule: at least <pass_mark> of the 30 answered "I would apply". "Maybe", "I would not apply", "Can't judge" and
unanswered cases all count as not "I would apply"; "Can't judge" cases are listed for discussion."""
import json, sys, collections
S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"
key = {c["code"]: c for c in json.load(open(f"{S}/req3/review-30-key.json"))["cases"]}
ex = json.load(open(sys.argv[1])); mark = int(sys.argv[2]) if len(sys.argv) > 2 else 24
if ex.get("audit") != "ghosted-review-30-v1": sys.exit("not an export from the Radar match check page")
ans = {c: v for c, v in ex["answers"].items() if v.get("answer")}
bad = [c for c in ans if c not in key]; assert not bad, f"codes not in the key: {bad}"
n = collections.Counter(v["answer"] for v in ans.values()); apply = n["apply"]
print(f"answered {len(ans)}/30   I would apply {apply}   maybe {n['maybe']}   would not apply {n['no']}   can't judge {n['cant']}   unanswered {30 - len(ans)}")
print(f"PASS MARK {mark}/30 -> {'PASS' if apply >= mark else 'NOT MET'}" + ("" if len(ans) == 30 else "   (incomplete: not a final result)"))
top = [c for c in key if key[c]["rank"] <= 5]
print(f"by list position: top 5 {sum(ans.get(c, {}).get('answer') == 'apply' for c in top)}/{len(top)}   ranks 6-40 {sum(ans.get(c, {}).get('answer') == 'apply' for c in key if c not in top)}/{30 - len(top)}")
print("reasons (no / maybe):", dict(collections.Counter(r for v in ans.values() if v["answer"] in ("no", "maybe") for r in v.get("reasons", []))))
print("can't judge:", [c for c, v in ans.items() if v["answer"] == "cant"])
# agreement with the earlier AI grades (shown only now, after grading)
SUIT = {"direct", "adjacent"}
pairs = [(v["answer"], key[c]["ai_grade"]) for c, v in ans.items()]
print("human answer x AI grade:", dict(collections.Counter(pairs)))
both = [(h, a) for h, a in pairs if h in ("apply", "no")]
if both: print(f"apply/not-apply agrees with AI suitable/not on {sum((h == 'apply') == (a in SUIT) for h, a in both)}/{len(both)} decided cases")
