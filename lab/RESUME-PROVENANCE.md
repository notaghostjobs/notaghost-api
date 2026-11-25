# Résumé evidence provenance (experimental, isolated)

Status, 25 Nov 2026: **diagnostic capability only. Not connected to ranking, matching, Sharpen, Radar or any route.**

## What it does
- `lab/py/resume_layout.py` reads a résumé PDF with word positions (pdfplumber, `x_tolerance=1`), finds a sidebar or
  second column by a gutter almost nothing crosses, reads each column separately, and assigns every line a section
  from its heading (including letter-spaced headings such as "W O R K  E X P E R I E N C E").
- `src/lab/provenance.ts` turns that reading into per-skill evidence: the line that shows the skill, its page, column,
  section, the job it sits under, and whether the line says the candidate led, did hands-on, or supported it.
- `whereShown(p, skill)` returns that evidence for explanations ("AWS appears only in your skills list").

## What it must not do yet
- `STRENGTH` (work 1, project 0.7, summary 0.5, listed 0.35 …) is **unvalidated**. In the Phase 3 controlled run it
  lowered AI-graded suitable picks (33 → 29 of 95). No ranking may read it until human audit grades say whether
  listed-only skills should count less, and by how much.
- `src/probe/provenance-offline.mts` fails if any file outside `src/lab/` imports this module.

## Tests
    python3 -I lab/py/test/test_resume_layout.py     # parser, on a generated fixture page with invented lines
    npx tsx src/probe/provenance-offline.mts          # evidence bases, explanation accessor, isolation guard

## Data
No résumé, layout output or excerpt is in this branch. Layout outputs from the authorised QA résumés stay in the
workspace only.

## Provenance
Copied unchanged from `match-req-2` (commit 81b17ef), plus `whereShown`, the tests and this note.
