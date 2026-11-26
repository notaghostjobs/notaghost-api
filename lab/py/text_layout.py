"""Layout record for a résumé that is not a PDF (DOCX converted to text, or TXT): one column, one page, the same
section headings and the same output shape as resume_layout.py, so provenance and the evidence record are built the
same way. Lines are the document's own lines; nothing is rewritten.

  python3 -I lab/py/text_layout.py <in.txt> <out.json>
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resume_layout import heading  # noqa: E402  (same heading rules as the PDF reader)


def read_text(path):
    lines = [l.rstrip() for l in open(path, encoding="utf-8", errors="replace")]
    out = {"pages": [], "lines": [], "layout": [{"page": 1, "two_column": False, "split_x": None}]}
    cur = "unlabelled"
    for ln in lines:
        if not ln.strip():
            continue
        h = heading(ln)
        rec = {"page": 1, "column": "main", "text": ln.strip()}
        if h:
            cur = h; rec["section"] = h; rec["is_heading"] = True
        else:
            rec["section"] = cur
        out["lines"].append(rec)
    return out


if __name__ == "__main__":
    r = read_text(sys.argv[1])
    json.dump(r, open(sys.argv[2], "w"), indent=1)
    secs = {}
    for l in r["lines"]:
        secs[l["section"]] = secs.get(l["section"], 0) + 1
    print(json.dumps({"layout": r["layout"], "sections": secs}))
