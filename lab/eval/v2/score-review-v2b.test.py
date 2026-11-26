#!/usr/bin/env python3
"""Tests for score-review-v2b.py on invented fixtures (no real cases).  python3 lab/eval/v2/score-review-v2b.test.py"""
import json, os, subprocess, sys, tempfile
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), "score-review-v2b.py")
d = tempfile.mkdtemp()
codes = [f"R{i:03d}" for i in range(1, 9)]
man = {"version": "ghosted-review-v2b.1", "data_sha": "f" * 16, "codes": codes}
key = [{"code": c, "profile": ["B01", "B03"][i % 2], "candidate": "x", "job_id": i, "arms": [["v2"], ["control"], ["v2", "control"]][i % 3]} for i, c in enumerate(codes)]
def ans(s, a, conf="high"): return {"suitability": s, "apply": a, "reasons": {"primary": "seniority" if s in ("stretch", "unsuitable", "cannot") else None, "secondary": []}, "confidence": conf, "uncertainty": "" if conf == "high" else "thin", "note": "", "at": "t"}
A = {c: ans("direct", "yes") for c in codes}; B = dict(A); B["R002"] = ans("unsuitable", "no", "low")
def exp(r, a, sha="f" * 16): return {"package": {"name": "ghosted-radar-review", "version": man["version"], "data_sha": sha}, "reviewer": r, "answers": a}
def w(n, o): p = os.path.join(d, n); json.dump(o, open(p, "w")); return p
M, K = w("m.json", man), w("k.json", key); EA, EB = w("a.json", exp("rev-1", A)), w("b.json", exp("rev-2", B))
def run(*a): r = subprocess.run([sys.executable, P, *a], capture_output=True, text=True); return r.returncode, r.stdout + r.stderr
n = 0
def t(name, cond):
    global n; assert cond, name; n += 1; print("ok", n, name)
rc, out = run("agree", M, EA, EB); ag = json.loads(out)["agreement"]
t("agreement counts and kappa", rc == 0 and ag["exact_suitability"]["agree"] == 7 and ag["to_adjudicate"] == ["R002"])
t("same reviewer twice is refused", run("agree", M, EA, EA)[0] != 0)
t("export from another package is refused", run("agree", M, EA, w("x.json", exp("rev-3", A, "0" * 16)))[0] != 0)
t("incomplete export cannot be locked", run("lock", M, EA, w("i.json", exp("rev-2", {**B, "R003": {"suitability": "direct"}})), "--out", os.path.join(d, "l0.json"))[0] != 0)
t("unadjudicated disagreement cannot be locked", run("lock", M, EA, EB, "--out", os.path.join(d, "l1.json"))[0] != 0)
J = w("j.json", {"R002": {"suitability": "stretch", "apply": "maybe", "dispute_type": "intent", "adjudicator": "independent"}})
L = os.path.join(d, "lock.json"); rc, out = run("lock", M, EA, EB, J, "--out", L); lock = json.load(open(L))
t("lock keeps both originals beside the adjudicated label", rc == 0 and lock["final"]["R002"]["suitability"] == "stretch" and lock["final"]["R002"]["original"]["rev-2"]["suitability"] == "unsuitable")
rc, out = run("unblind", L, K, "--boot", "200"); u = json.loads(out)
v = u["arms"]["v2"]["all"]
t("shared cases count in both arms", u["proposed_by_both"]["displayed"] == sum(len(x["arms"]) == 2 for x in key))
t("primary precision counts stretch as not suitable", v["primary_precision"]["k"] == v["displayed"] - (1 if "v2" in key[1]["arms"] else 0))
t("would-apply counts only Yes", v["would_apply_yes"]["k"] == sum(1 for x in key if "v2" in x["arms"] and x["code"] != "R002"))
open(EB, "a").write(" ")
t("a changed export after locking refuses to unblind", run("unblind", L, K)[0] != 0)
key3 = [{**x, "arms": [["v3"], ["control"], ["v3", "control"]][i % 3]} for i, x in enumerate(key)]; K3 = w("k3.json", key3)
SPL = w("sp.json", {"fresh": ["B01", "B03"]}); GRP = w("g.json", {"B01": "finance", "B03": "hr"}); SELF = w("self.json", {"R001": "yes", "R004": "no"})
open(EB, "w").write(json.dumps(exp("rev-2", B))); L2 = os.path.join(d, "lock2.json"); run("lock", M, EA, EB, J, "--out", L2)
rc, out = run("unblind", L2, K3, "--boot", "100", "--splits", SPL, "--groups", GRP, "--self", SELF); u3 = json.loads(out)
t("fresh-set options: named splits, any arm name, per-profession and self-reported would-apply", rc == 0 and "fresh" in u3["arms"]["v3"] and "v3_minus_control" in u3 and set(u3["by_group"]) == {"finance", "hr"} and u3["candidate_reported_would_apply"]["v3"]["answered"] >= 1)
t("zero-match and two-or-more counts are reported", "candidates_zero" in u3["arms"]["v3"]["all"] and "candidates_two_or_more" in u3["arms"]["v3"]["all"])
print(f"{n} tests passed")
