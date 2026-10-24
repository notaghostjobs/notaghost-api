#!/usr/bin/env python3
"""Build the quality-batch sheet (markdown) from results.json (+ optional my_scores.json {id: {score, note}})."""
import json, os, sys
root = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(f"{root}/results.json"))
my = json.load(open(f"{root}/my_scores.json")) if os.path.exists(f"{root}/my_scores.json") else {}
v1 = {r["id"]: r for r in json.load(open(f"{root}/v1/results.json"))} if os.path.exists(f"{root}/v1/results.json") else {}
out = ["| # | Candidate | Posting | Before | Promised | Delivered | Gate | Verified | Time | My 1–10 | Note |", "|---|---|---|---|---|---|---|---|---|---|---|"]
for i, r in enumerate(rows, 1):
    if "error" in r:
        out.append(f"| {i} | {r['id']} | | | | | | FAIL | | | {r['error'][:60]} |"); continue
    m = my.get(r["id"], {})
    gate = "not your profile" if r["mismatch"] else ""
    ver = "ok" if r["verified"] else "✗ facts"
    out.append(f"| {i} | {r['name']} | {r['jd']} | {r['before']}% | {r['promised']}% | {r['after']}% | {gate} | {ver} | {r['secs']}s | {m.get('score','')} | {m.get('note','')} |")
print("\n".join(out))
