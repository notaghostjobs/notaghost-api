"""Layout-aware résumé reading, offline lab code. Reads the PDF's words with their positions (pdfplumber), finds a
sidebar or second column by a vertical gutter that no line crosses, reads each column on its own, and splits the text
into sections by their headings. Every line keeps its page, column and section, so a skill can later be traced to the
words that show it. Nothing is rewritten: lines are the document's own words in reading order.

  python3 -I lab/py/resume_layout.py <in.pdf> <out.json>
"""
import json, re, sys
import pdfplumber

HEADS = [
    ("summary", r"(professional |career |profile |executive )?(summary|profile|objective|about me)"),
    ("experience", r"(professional |work |employment |career |executive |relevant )?(experience|history|employment)( \(.*\))?|work history|(key |roles (&|and) )?responsibilit(y|ies)|key result areas?"),
    ("projects", r"(key |academic |personal )?projects?"),
    ("skills", r"(technical |key |core |professional )?(skills|competenc(y|ies)|expertise|tools|technologies|tech stack|skill set|areas of expertise)"),
    ("education", r"education|academics?|qualifications?"),
    ("certifications", r"(training (and|&) )?certifications?|licen[cs]es?|courses?|trainings?"),
    ("achievements", r"(key |notable |leadership |career )?(achievements?|awards?|honou?rs?|accomplishments?|highlights)"),
    ("languages", r"languages?"),
    ("interests", r"interests?|hobbies"),
    ("personal", r"personal (details|information)|declaration|references?|contact"),
]
HEAD_RE = [(n, re.compile(r"^\W*(" + p + r")\s*:?\W*$", re.I)) for n, p in HEADS]


def heading(line):
    t = line.strip()
    if re.fullmatch(r"(\w ){3,}\w( (\w ){1,}\w)*", t):   # letter-spaced headings: "J O B O B J E C T I V E"
        c = t.replace(" ", "").lower()
        for n, kw in [("experience", "experience"), ("summary", "objective"), ("summary", "summary"), ("summary", "profile"), ("skills", "skill"), ("skills", "competenc"),
                      ("education", "education"), ("personal", "contact"), ("achievements", "achievement"), ("achievements", "highlight"), ("certifications", "certif"), ("languages", "language"), ("interests", "interest")]:
            if kw in c:
                return n
    if len(t) > 40 or len(t.split()) > 5:
        return None
    for n, r in HEAD_RE:
        if r.match(t):
            return n
    return None


def columns(words, width):
    """The x where a second column starts, or None: a band at least 12 pt wide, between 20% and 80% of the page, that
    no word crosses, with words on both sides on many lines."""
    if len(words) < 40:
        return None
    cover = [0] * (int(width) + 1)
    for w in words:
        for x in range(max(0, int(w["x0"])), min(int(width), int(w["x1"])) + 1):
            cover[x] += 1
    best, run, start = None, 0, 0
    for x in range(int(width * 0.2), int(width * 0.8)):
        if cover[x] <= 2:   # a name or a rule may span the page; a real column gutter is crossed by almost nothing
            if run == 0:
                start = x
            run += 1
            if run >= 10 and (best is None or run > best[1]):
                best = (start, run)
        else:
            run = 0
    if not best:
        return None
    split = best[0] + best[1] / 2
    left = sum(1 for w in words if w["x1"] < split); right = len(words) - left
    return split if min(left, right) >= 15 else None


def lines_of(words):
    rows = []
    for w in sorted(words, key=lambda w: (round(w["top"] / 3), w["x0"])):
        if rows and abs(rows[-1]["top"] - w["top"]) <= 3:
            rows[-1]["words"].append(w)
        else:
            rows.append({"top": w["top"], "words": [w]})
    return [" ".join(x["text"] for x in sorted(r["words"], key=lambda w: w["x0"])) for r in rows]


def read(path):
    out = {"pages": [], "lines": [], "layout": []}
    with pdfplumber.open(path) as pdf:
        for pi, page in enumerate(pdf.pages):
            words = page.extract_words(use_text_flow=False, keep_blank_chars=False, x_tolerance=1)
            split = columns(words, page.width)
            cols = [("main", words)] if split is None else [("left", [w for w in words if w["x1"] < split]), ("right", [w for w in words if w["x0"] >= split])]
            out["layout"].append({"page": pi + 1, "two_column": split is not None, "split_x": split})
            for name, ws in cols:
                for ln in lines_of(ws):
                    out["lines"].append({"page": pi + 1, "column": name, "text": ln})
    # sections: a heading opens a section until the next heading in the same column; a column with no heading carries
    # the section of the column's first heading-less stretch ("unlabelled")
    cur = {}
    for l in out["lines"]:
        h = heading(l["text"])
        key = (l["page"], l["column"])
        if h:
            cur[l["column"]] = h; l["section"] = h; l["is_heading"] = True; continue
        l["section"] = cur.get(l["column"], "unlabelled")
    return out


if __name__ == "__main__":
    r = read(sys.argv[1])
    json.dump(r, open(sys.argv[2], "w"), indent=1)
    secs = {}
    for l in r["lines"]:
        secs[l["section"]] = secs.get(l["section"], 0) + 1
    print(json.dumps({"layout": r["layout"], "sections": secs}))
