"""Import the founder's exported audit grades and compare with the hidden AI key. Run only once real grades exist.
   python3 import-audit.py <ghosted-audit-grades.json>"""
import json, sys, collections
S = "/tmp/claude-0/-home-claude/e75d385d-3415-5d05-84bc-8c909535d0ed/scratchpad"
key = {k["code"]: k for k in json.load(open(f"{S}/req/audit/audit-key.json"))}
g = json.load(open(sys.argv[1])); assert g.get("audit") == "ghosted-match-audit-v1", "not an audit export"
grades = {c: v for c, v in g["grades"].items() if v.get("grade")}
unknown = [c for c in grades if c not in key]; assert not unknown, f"codes not in the key: {unknown}"
SUIT = {"direct", "adjacent"}; cm = collections.Counter(); agree = 0
for c, v in grades.items():
    ai = key[c]["grade"]; h = v["grade"]; cm[(h, ai)] += 1; agree += h == ai
n = len(grades); po = sum(v for (h, a), v in cm.items() if (h in SUIT) == (a in SUIT)) / n if n else 0
ph = sum(v for (h, a), v in cm.items() if h in SUIT) / n if n else 0; pa = sum(v for (h, a), v in cm.items() if a in SUIT) / n if n else 0
pe = ph * pa + (1 - ph) * (1 - pa); kappa = (po - pe) / (1 - pe) if n and pe < 1 else float("nan")
print(f"human grades imported: {n} of {len(key)}; exact agreement with AI {agree}/{n}; suitable-vs-not agreement {po:.0%}, kappa {kappa:.2f}")
print("needs clarification:", sum(1 for v in grades.values() if v.get("clarify")))
for (h, a), v in sorted(cm.items()): print(f"  human {h:10s} vs AI {a:10s}: {v}")
