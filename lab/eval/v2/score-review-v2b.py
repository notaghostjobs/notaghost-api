#!/usr/bin/env python3
"""Two-reviewer scoring for the blinded review package (ghosted-review-v2b). Standard library only.

Stages, in order; each refuses to run out of order:
  agree   python3 score-review-v2b.py agree  MANIFEST EXPORT_A EXPORT_B
          Checks both exports belong to this package and are complete, then reports inter-reviewer agreement
          (exact, binary suitable/not, would-apply Yes/not, Cohen's kappa) and lists disagreements for adjudication.
          Uses no system information.
  lock    python3 score-review-v2b.py lock   MANIFEST EXPORT_A EXPORT_B [ADJUDICATION] --out LOCK
          Freezes the labels: records sha256 of both exports and of the adjudication file, and the final label per
          case (agreed label, or the adjudicated one). Originals are never edited; adjudication is a separate file:
          {"R007": {"suitability": "...", "apply": "...", "dispute_type": "suitability|intent|missing_data|rubric",
                    "adjudicator": "independent|founder", "note": "evidence that settled it"}}. Every disagreement must be
          adjudicated. Both reviewers' original answers are kept in the lock beside the final label.
  unblind python3 score-review-v2b.py unblind LOCK KEY [--boot 10000]
          Only now reads the hidden key. Re-hashes the exports named in the lock and refuses if any changed.
          Reports, per system arm and per split (development / held-out / all):
            primary precision   = (Direct + Strong adjacent) / all cases, Cannot judge counted as not suitable
            sensitivity         = the same with Cannot judge cases excluded
            would-apply         = Yes / all cases (Maybe is not counted)
          with Wilson 95% intervals and candidate-clustered bootstrap 95% intervals (candidates resampled).
          The 12 cases proposed by both systems count once in each arm, and are also reported separately.
"""
import json, sys, hashlib, math, random, collections, re

SUITABLE = {"direct", "adjacent"}
NEED_REASON = {"stretch", "unsuitable", "cannot"}
DEV = {"B01", "B02", "B08", "B11", "B12", "B13", "B15", "B16", "B17", "B19"}
HELD = {"B03", "B04", "B05", "B06", "B07", "B09", "B10", "B14", "B18"}


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def load_export(path, manifest):
    x = json.load(open(path))
    if x.get("package", {}).get("data_sha") != manifest["data_sha"] or x["package"].get("version") != manifest["version"]:
        sys.exit(f"{path}: export belongs to another package ({x.get('package')}); refusing")
    codes = manifest["codes"]
    unknown = set(x["answers"]) - set(codes)
    if unknown:
        sys.exit(f"{path}: unknown case IDs {sorted(unknown)[:5]}; refusing")
    missing = [c for c in codes if not complete(x["answers"].get(c))]
    return x, missing


def complete(a):
    return bool(a and a.get("suitability") and a.get("apply") and a.get("confidence")
                and (a["suitability"] not in NEED_REASON or (a.get("reasons") or {}).get("primary"))
                and (a["confidence"] == "high" or (a.get("uncertainty") or "").strip()))


def kappa(pairs):
    n = len(pairs)
    if not n:
        return None
    po = sum(a == b for a, b in pairs) / n
    ca, cb = collections.Counter(a for a, _ in pairs), collections.Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / (n * n)
    return None if pe == 1 else (po - pe) / (1 - pe)


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(c - h, 3), round(c + h, 3))


def agreement(manifest, ea, eb):
    A, B = ea["answers"], eb["answers"]
    codes = [c for c in manifest["codes"] if complete(A.get(c)) and complete(B.get(c))]
    out = {"cases_compared": len(codes)}
    for name, f in [("exact_suitability", lambda a: a["suitability"]),
                    ("binary_suitable", lambda a: a["suitability"] in SUITABLE),
                    ("would_apply_yes", lambda a: a["apply"] == "yes"),
                    ("would_apply_exact", lambda a: a["apply"])]:
        pairs = [(f(A[c]), f(B[c])) for c in codes]
        agree = sum(a == b for a, b in pairs)
        k = kappa(pairs)
        out[name] = {"agree": agree, "of": len(pairs), "rate": round(agree / len(pairs), 3) if pairs else None,
                     "cohen_kappa": None if k is None else round(k, 3)}
    out["to_adjudicate"] = [c for c in codes if A[c]["suitability"] != B[c]["suitability"] or A[c]["apply"] != B[c]["apply"]]
    out["cannot_judge"] = {ea["reviewer"]: sum(A[c]["suitability"] == "cannot" for c in codes),
                          eb["reviewer"]: sum(B[c]["suitability"] == "cannot" for c in codes)}
    return out


def cmd_agree(mp, a, b):
    m = json.load(open(mp))
    ea, ma = load_export(a, m)
    eb, mb = load_export(b, m)
    if ea["reviewer"] == eb["reviewer"]:
        sys.exit("both exports carry the same reviewer ID; two independent reviewers are required")
    print(json.dumps({"package": m["version"], "data_sha": m["data_sha"], "missing": {ea["reviewer"]: ma, eb["reviewer"]: mb},
                      "agreement": agreement(m, ea, eb)}, indent=1))


def cmd_lock(mp, a, b, adj, out):
    m = json.load(open(mp))
    ea, ma = load_export(a, m)
    eb, mb = load_export(b, m)
    if ma or mb:
        sys.exit(f"cannot lock: missing answers ({len(ma)} and {len(mb)})")
    if ea["reviewer"] == eb["reviewer"]:
        sys.exit("both exports carry the same reviewer ID")
    J = json.load(open(adj)) if adj else {}
    ag = agreement(m, ea, eb)
    DT = {"suitability", "intent", "missing_data", "rubric"}
    undone = [c for c in ag["to_adjudicate"] if c not in J or not J[c].get("suitability") or not J[c].get("apply") or J[c].get("dispute_type") not in DT]
    if undone:
        sys.exit(f"cannot lock: {len(undone)} disagreements not adjudicated: {undone[:10]}")
    final = {}
    for c in m["codes"]:
        A, B = ea["answers"][c], eb["answers"][c]
        reasons = sorted({r for x in (A, B) for r in [(x.get("reasons") or {}).get("primary")] + list((x.get("reasons") or {}).get("secondary") or []) if r})
        orig = {ea["reviewer"]: A, eb["reviewer"]: B}
        conf = [A["confidence"], B["confidence"]]
        if c in ag["to_adjudicate"]:
            final[c] = {"suitability": J[c]["suitability"], "apply": J[c]["apply"], "source": "adjudicated", "dispute_type": J[c]["dispute_type"],
                        "adjudicator": J[c].get("adjudicator", "unspecified"), "adjudication_note": J[c].get("note", ""), "reasons_cited": reasons, "confidence": conf, "original": orig}
        else:
            final[c] = {"suitability": A["suitability"], "apply": A["apply"], "source": "agreed", "reasons_cited": reasons, "confidence": conf, "original": orig}
    lock = {"package": m["version"], "data_sha": m["data_sha"], "exports": {a: sha(a), b: sha(b)},
            "adjudication": {adj: sha(adj)} if adj else {}, "reviewers": [ea["reviewer"], eb["reviewer"]],
            "agreement": ag, "final": final}
    json.dump(lock, open(out, "w"), indent=1)
    print(f"locked {len(final)} labels -> {out} (sha256 {sha(out)[:16]})")


def metrics(rows, boot, rng, universe):
    n = len(rows)
    k = sum(r["suitability"] in SUITABLE for r in rows)
    nj = [r for r in rows if r["suitability"] != "cannot"]
    ks = sum(r["suitability"] in SUITABLE for r in nj)
    ya = sum(r["apply"] == "yes" for r in rows)

    def cluster_ci(f):
        if not rows or not boot:
            return (None, None)
        by = collections.defaultdict(list)
        for r in rows:
            by[r["cand"]].append(r)
        cands = list(by)
        vals = []
        for _ in range(boot):
            s = [r for c in (rng.choice(cands) for _ in cands) for r in by[c]]
            v = f(s)
            if v is not None:
                vals.append(v)
        vals.sort()
        return (round(vals[int(0.025 * len(vals))], 3), round(vals[int(0.975 * len(vals)) - 1], 3)) if vals else (None, None)

    def prec(s): return sum(r["suitability"] in SUITABLE for r in s) / len(s) if s else None
    def sens(s):
        t = [r for r in s if r["suitability"] != "cannot"]
        return sum(r["suitability"] in SUITABLE for r in t) / len(t) if t else None
    def wa(s): return sum(r["apply"] == "yes" for r in s) / len(s) if s else None

    by = collections.Counter(r["cand"] for r in rows)
    per = [by.get(c, 0) for c in universe]
    cw = [sum(r["suitability"] in SUITABLE for r in rows if r["cand"] == c) / by[c] for c in by]
    reasons = collections.Counter(x for r in rows for x in r.get("reasons_cited", []))
    return {"displayed": n, "reviewed": sum(r["suitability"] is not None for r in rows),
            "candidate_coverage": f"{len(by)}/{len(universe)}", "per_candidate_mean": round(sum(per) / len(per), 2) if per else None,
            "per_candidate_median": sorted(per)[len(per) // 2] if per else None,
            "candidate_weighted_precision": round(sum(cw) / len(cw), 3) if cw else None,
            "candidates_zero": sum(1 for x in per if x == 0), "candidates_two_or_more": sum(1 for x in per if x >= 2),
            "precision_among_candidates_with_recommendations": round(k / n, 3) if n else None,
            "would_apply_breakdown": dict(collections.Counter(r["apply"] for r in rows)),
            "not_high_confidence_share": round(sum(any(c != "high" for c in r.get("confidence", [])) for r in rows) / n, 3) if n else None,
            "failure_reasons_cited_by_either_reviewer": {k: reasons.get(k, 0) for k in ["function", "subspec", "seniority", "ic_mgmt", "technical", "credential", "domain", "location", "preference", "resume_incomplete", "jd_incomplete", "jd_unclear", "other"]},
            "primary_precision": {"k": k, "n": n, "rate": round(k / n, 3) if n else None, "wilson95": wilson(k, n), "cluster95": cluster_ci(prec)},
            "excluding_cannot_judge": {"k": ks, "n": len(nj), "rate": round(ks / len(nj), 3) if nj else None, "wilson95": wilson(ks, len(nj)), "cluster95": cluster_ci(sens)},
            "would_apply_yes": {"k": ya, "n": n, "rate": round(ya / n, 3) if n else None, "wilson95": wilson(ya, n), "cluster95": cluster_ci(wa)},
            "labels": dict(collections.Counter(r["suitability"] for r in rows))}


def paired(rows, ps, boot, rng, arm="v2"):
    """Candidate-level paired comparison: per candidate with both arms shown, the arm's precision minus control precision."""
    d = []
    for c in sorted(ps):
        v = [r for r in rows if r["cand"] == c and arm in r["arms"]]
        k = [r for r in rows if r["cand"] == c and "control" in r["arms"]]
        if v and k:
            d.append(sum(r["suitability"] in SUITABLE for r in v) / len(v) - sum(r["suitability"] in SUITABLE for r in k) / len(k))
    if not d:
        return None
    bs = sorted(sum(rng.choice(d) for _ in d) / len(d) for _ in range(boot or 1))
    return {"candidates": len(d), "mean_difference": round(sum(d) / len(d), 3), "bootstrap95": (round(bs[int(.025 * len(bs))], 3), round(bs[int(.975 * len(bs)) - 1], 3)),
            f"{arm}_better": sum(x > 0 for x in d), "control_better": sum(x < 0 for x in d), "tied": sum(x == 0 for x in d)}


def cmd_single(mp, exp, out):
    """Single-reviewer package (false-negative audit only): validated like any export, never used for primary precision."""
    m = json.load(open(mp)); x, miss = load_export(exp, m)
    if miss:
        sys.exit(f"cannot record: {len(miss)} cases unanswered")
    json.dump({"package": m["version"], "reviewer": x["reviewer"], "export_sha256": sha(exp), "labels": {c: {"suitability": a["suitability"], "apply": a["apply"], "reasons": a.get("reasons", {})} for c, a in x["answers"].items()}}, open(out, "w"), indent=1)
    print(f"recorded {len(x['answers'])} single-review labels -> {out}")


def opt(a, name, default=None):
    return a[a.index(name) + 1] if name in a else default


def cmd_unblind(lockp, keyp, boot, splits=None, groups=None, selfrep=None, explain=None, fresh=None, audit_single=None):
    """splits: {name: [profile ids]} (default: the V2 development / held-out split); groups: {profile: profession};
    selfrep: {case code: yes|maybe|no|cannot} from the candidates themselves (kept apart from reviewer would-apply)."""
    L = json.load(open(lockp))
    for p, h in {**L["exports"], **L["adjudication"]}.items():
        if sha(p) != h:
            sys.exit(f"{p} changed after locking; refusing to unblind")
    keyall = {x["code"]: x for x in json.load(open(keyp))}
    missing = set(L["final"]) - set(keyall)
    if missing:
        sys.exit(f"locked labels for cases not in the key ({sorted(missing)[:5]}); refusing")
    pkg = L["package"].rsplit("-", 1)[-1] if any("package" in x for x in keyall.values()) else None
    if pkg is None and set(keyall) != set(L["final"]):
        sys.exit("key and locked labels cover different cases; refusing")
    if pkg is not None and {c for c, x in keyall.items() if x.get("package") == pkg} != set(L["final"]):
        sys.exit(f"package {pkg}: key cases and locked labels differ; refusing")
    key = {c: keyall[c] for c in L["final"]}
    profs = {x["profile"] for x in key.values()}; dev = {p for p in profs if re.fullmatch(r"B\d\d", p)}
    if dev and dev != profs:
        sys.exit("development profiles (Bnn) and fresh profiles in one key: populations are never combined; refusing")
    rng = random.Random(20261126)
    rows = [{**{k: v for k, v in L["final"][c].items() if k != "original"}, "code": c, "cand": key[c]["profile"], "arms": key[c]["arms"]} for c in sorted(L["final"])]
    SP = {k: set(v) for k, v in json.load(open(splits)).items()} if splits else {"development": DEV, "held_out": HELD}
    SP["all"] = set().union(*SP.values())
    arms = sorted({a for r in rows for a in r["arms"]}); primary = [a for a in arms if a != "control"]
    out = {"package": L["package"], "lock_sha": sha(lockp)[:16], "agreement": L["agreement"], "arms": {}}
    for arm in arms:
        out["arms"][arm] = {}
        for split, ps in SP.items():
            out["arms"][arm][split] = metrics([r for r in rows if arm in r["arms"] and r["cand"] in ps], boot, rng, sorted(ps))
    out["proposed_by_both"] = metrics([r for r in rows if len(r["arms"]) > 1], boot, rng, sorted(SP["all"]))
    if "control" in arms:
        for arm in primary:
            for split, ps in SP.items():
                a, b = out["arms"][arm][split]["primary_precision"]["rate"], out["arms"]["control"][split]["primary_precision"]["rate"]
                out.setdefault(f"{arm}_minus_control", {})[split] = {"absolute": None if a is None or b is None else round(a - b, 3), "relative": None if not a or not b else round(a / b - 1, 3),
                    "candidate_paired": paired(rows, ps, boot, rng, arm)}
    if groups:   # per profession: never hidden inside the aggregate
        G = json.load(open(groups)); out["by_group"] = {}
        for g in sorted(set(G.values())):
            ps = {p for p, x in G.items() if x == g}
            out["by_group"][g] = {arm: metrics([r for r in rows if arm in r["arms"] and r["cand"] in ps], boot, rng, sorted(ps)) for arm in arms}
    if selfrep:  # the candidates' own would-apply answers, for the cases they were shown
        Sr = json.load(open(selfrep)); Sr = {c: (v["apply"] if isinstance(v, dict) else v) for c, v in (Sr.get("answers", Sr) if isinstance(Sr, dict) else {}).items()}; out["candidate_reported_would_apply"] = {}
        for arm in arms:
            got = [Sr[r["code"]] for r in rows if arm in r["arms"] and r["code"] in Sr]
            n = len([r for r in rows if arm in r["arms"]])
            out["candidate_reported_would_apply"][arm] = {"answered": len(got), "of": n, "yes": got.count("yes"), "maybe": got.count("maybe"), "no": got.count("no"), "cannot": got.count("cannot"),
                                                          "yes_rate_of_answered": round(got.count("yes") / len(got), 3) if got else None, "wilson95": wilson(got.count("yes"), len(got))}
    out["disagreements_by_candidate"] = dict(collections.Counter(r["cand"] for r in rows if r["source"] == "adjudicated"))
    for arm in arms:   # failure rates among displayed cases, from the reasons either reviewer cited
        d = [r for r in rows if arm in r["arms"]]; n = len(d)
        rate = lambda keys: {"k": sum(1 for r in d if set(r.get("reasons_cited", [])) & keys), "n": n, "rate": round(sum(1 for r in d if set(r.get("reasons_cited", [])) & keys) / n, 3) if n else None}
        out["arms"][arm]["failure_rates"] = {"specialisation_mismatch": rate({"subspec"}), "seniority_mismatch": rate({"seniority", "ic_mgmt"}), "missing_mandatory_capability": rate({"technical", "credential"}), "function_mismatch": rate({"function"})}
    if explain:   # explanation accuracy (V3 displays only; audited after the lock by one reviewer)
        E = json.load(open(explain)); got = [E[r["code"]] for r in rows if "v3" in r["arms"] and r["code"] in E]
        out["explanation_accuracy"] = {"audited": len(got), "of": sum(1 for r in rows if "v3" in r["arms"]), "supported": sum(1 for g in got if g.get("supported")), "wilson95": wilson(sum(1 for g in got if g.get("supported")), len(got))}
    if fresh:     # open status of every displayed job on review day
        Fr = json.load(open(fresh)); out["freshness"] = {}
        for arm in arms:
            d = [r for r in rows if arm in r["arms"]]; chk = [Fr[r["code"]] for r in d if r["code"] in Fr]
            out["freshness"][arm] = {"displayed": len(d), "checked": len(chk), "closed_or_invalid": sum(1 for x in chk if not x.get("open")), "unchecked": len(d) - len(chk)}
    aud = [r for r in rows if not r["arms"]]; single = json.load(open(audit_single))["labels"] if audit_single else {}
    allaud = [{"code": r["code"], "strata": keyall[r["code"]].get("strata", []), "suitability": r["suitability"], "review": "double"} for r in aud] + [{"code": c, "strata": keyall[c].get("strata", []), "suitability": v["suitability"], "review": "single"} for c, v in single.items() if c in keyall]
    if allaud:
        out["false_negative_audit"] = {}
        for st in sorted({s for a in allaud for s in a["strata"]}):
            xs = [a for a in allaud if st in a["strata"]]; k = sum(1 for a in xs if a["suitability"] in SUITABLE)
            out["false_negative_audit"][st] = {"sampled": len(xs), "suitable_missed": k, "rate": round(k / len(xs), 3), "wilson95": wilson(k, len(xs)), "double_reviewed": sum(1 for a in xs if a["review"] == "double")}
    audit_codes = [c for c, x in keyall.items() if not x.get("arms")]
    out["denominator_audit"] = {arm: {"displayed_in_key": sum(1 for x in keyall.values() if arm in x.get("arms", [])), "labelled": sum(1 for r in rows if arm in r["arms"])} for arm in arms}
    out["denominator_audit"]["audit_cases"] = {"in_key": len(audit_codes), "labelled_double": len(aud), "labelled_single": len([c for c in single if c in keyall]), "unlabelled": len([c for c in audit_codes if c not in L["final"] and c not in single])}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == "agree" and len(a) == 4:
        cmd_agree(*a[1:])
    elif a[0] == "lock" and "--out" in a:
        i = a.index("--out")
        rest = a[1:i]
        cmd_lock(rest[0], rest[1], rest[2], rest[3] if len(rest) > 3 else None, a[i + 1])
    elif a[0] == "unblind" and len(a) >= 3:
        cmd_unblind(a[1], a[2], int(opt(a, "--boot", 10000)), opt(a, "--splits"), opt(a, "--groups"), opt(a, "--self"), opt(a, "--explain"), opt(a, "--fresh"), opt(a, "--audit-single"))
    elif a[0] == "single" and "--out" in a:
        cmd_single(a[1], a[2], opt(a, "--out"))
    else:
        sys.exit(__doc__)
