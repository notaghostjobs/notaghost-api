# Ghosted QA — importing synthetic candidates, and the independent evaluation

Only synthetic documents are imported. A real résumé is never uploaded to QA; a derivative of one must be fictionalised
(names, employers, contact details, dates and figures changed) and declared as such.

Importing makes no model call. Evaluating makes no model call.

## 1. A candidate package = two files

| File | What |
|---|---|
| `QA0xx.pdf` | The synthetic résumé, as a candidate would upload it. PDF, at most 5 MB. Any layout. |
| `QA0xx.truth.json` | The ground truth: what the résumé actually says, and what the product should do with it. Format `ghosted-qa-truth/1`. |

A complete worked example is in `seed/qa/example/` (`QA001.pdf`, `QA001.truth.json`, `jobs.json`).

### Ground truth — fields

```jsonc
{
  "format": "ghosted-qa-truth/1",
  "id": "QA001",                                   // QA001 … QA100; replaces the built-in candidate with that id
  "synthetic": true,                               // must be true
  "provenance": { "basis": "invented" | "derived_from_real", "fictionalised": true, "permission": "not_required" | "obtained", "note": "…" },
  "person": { "name": "…", "city": "Bengaluru", "country": "India",
              "email": "…@example.com",            // example.com / example.org / *.test only
              "phone": "+91 00000 01001",          // the candidate's own QA number (QA001 → 01001 … QA100 → 01100), or omit
              "languages": ["…"] },
  "summary": { "function": "category management", // use a function name from GET /qa/import → functions_in_use
               "other_functions": ["growth marketing"],
               "level": "junior" | "mid" | "senior" | "head",
               "total_years": 16, "countries_worked": ["India", "Singapore"], "covers": "what this case is for" },
  "roles": [ {
      "employer": "…", "title": "…", "start": "YYYY-MM", "end": "YYYY-MM" | "present",
      "location": "…", "country": "…",
      "kind": "full_time" | "contract" | "consulting" | "internship" | "founder" | "board" | "career_break",
      "promoted_from": "previous title at the same employer",     // marks a promotion
      "concurrent": true,                                          // marks a deliberate overlap in time
      "team_size": 46, "pnl": "₹1,400 crore GMV at an 11% contribution margin",
      "cross_functional": ["supply chain", "finance"],
      "responsibilities": ["…"],
      "achievements": [ { "text": "the sentence as written", "numbers": ["820", "1,400", "7%", "11%"] } ]
  } ],
  "education": [ { "degree": "…", "institution": "…", "start": "YYYY", "end": "YYYY" } ],
  "skills": ["…"], "certifications": ["…"],
  "layout": { "pages": 2, "columns": 2, "sidebar": true, "tables": false, "graphics": false, "image_only": false, "notes": "…" },
  "must_keep": ["facts every Sharpen output must still state — matched on their figures"],
  "must_not_claim": ["things this person never did or has — any appearance is an unsupported claim"],
  "expected": {
    "record": { "level": ["head"], "years": [15, 17] },
    "radar": { "for_you": ["job-slug"], "acceptable": ["job-slug"], "never": ["job-slug"],
               "locations": ["Bengaluru"], "exclude_employers": ["…"], "notes": "…" },
    "sharpen": [ { "job": "job-slug", "relevant_terms": ["P&L", "pricing"], "must_keep": ["…"], "must_not_claim": ["…"], "notes": "…" } ]
  }
}
```

### What the import checks

Refused (nothing stored):
- not a PDF, larger than 5 MB, or no readable text (unless `layout.image_only` is true)
- `synthetic` not true; derived from a real résumé without `fictionalised: true`
- the name in the ground truth is not in the PDF; the package was submitted under a different id
- in the PDF or the JSON: an e-mail outside example.com, a phone number that is not a QA number, a LinkedIn/GitHub/personal web address, something shaped like a PAN or Aadhaar number, date of birth / passport / family particulars
- a job named in both `for_you` and `never`

Warned (stored, and shown again in every listing):
- an employer, title or figure in the ground truth that is not in the PDF text
- page count differs; roles overlap in time without `concurrent`
- an expected outcome names a job that is not a fixture yet

What it cannot check: whether a name or employer belongs to a real person or company. That rests on the declaration.

## 2. Job fixtures = one JSON file (`ghosted-qa-jobs/1`)

```jsonc
{ "format": "ghosted-qa-jobs/1",
  "employers": [ { "name": "…", "slug": "…", "hiring_system": "followed" | "none" | "unknown", "about": "…" } ],
  "roles": [ {
      "slug": "x-…", "employer": "…", "title": "…", "function": "…", "level": "junior|mid|senior|head|adjacent", "years": [4, 7],
      "location": "Bengaluru, Karnataka, India", "pay": "₹22–30 LPA" | null, "posted_days": 3, "state": "live" | "gone",
      "text": "the posting, at least 200 characters; lines starting with • become bullets",
      "page":   { "posted_text": "Posted 3 days ago", "closed_notice": false, "http": 200 },     // what the page itself says
      "system": { "listed": true, "first_seen_days": 140 },                                       // what the employer's own system shows
      "ghost_meter": { "verdicts": ["Caution", "Ghost"], "fire": [14], "never": [20], "note": "…" }   // optional: makes it a Ghost Meter test page
  } ] }
```

`page` and `system` may disagree on purpose — that is how contradictory evidence is built. `system.listed: false` on a
followed employer is how ambiguous evidence is built. Signal numbers are listed in `docs/QA.md` section 5.
Roles sent again replace the earlier ones with the same slug. Built-in fixtures cannot be overwritten.

## 3. How to import

On the QA start page, section **Import synthetic candidates and job fixtures**:
1. Job fixtures first (so candidates can refer to them): choose the JSON → **Check only** → **Import**.
2. For each candidate: type the id, choose the PDF and the ground-truth JSON → **Check only**. Read the errors and warnings.
3. **Import**. The candidate's earlier résumé, Record, Radar and Sharpen results are cleared, because they no longer describe this person.

Or with a tool (header `x-qa-access`):

| Call | Does |
|---|---|
| `POST /qa/import/check` · `POST /qa/import` — form fields `id`, `resume` (file), `truth` (file or text) | validate · validate and store |
| `POST /qa/import/jobs?check=1` · `POST /qa/import/jobs` — JSON body | validate · validate, store and list on the employer's system |
| `GET /qa/import` · `GET /qa/import/truth/QA001` · `POST /qa/import/remove {id}` | what is imported · one ground truth · remove (the built-in candidate returns) |

## 4. Testing through the normal product

The evaluation reads whatever the candidate has done, however it was done. To test as a candidate would:
1. QA start page → **Sign in with a number and code** → enter the candidate's number (`00000 01001` for QA001) → the code is under **Codes** on that row.
2. Download that candidate's résumé from the row and upload it in the product.
3. Use Radar, Sharpen and Ghost Meter as a person would.
4. Back on the start page: **Evaluation** on that row.

## 5. The evaluation

| Call | Report |
|---|---|
| `GET /qa/eval/QA001` | one candidate: Record, Radar, each Sharpen, failed steps |
| `GET /qa/eval/QA001/bundle` | side by side for an outside judge: résumé text, ground truth, Record, Radar list with each posting, each Sharpen document and delivered PDF text |
| `GET /qa/eval` | every imported candidate, one line each |
| `GET /qa/eval/meter` | every Ghost Meter page: verdict, signals that must and must not fire, consistency across repeat checks |

Each check is `pass`, `fail`, `review` or `not_run`.
- `pass` — compared with the ground truth and agrees.
- `fail` — disagrees; the detail says where.
- `review` — a judgement a rule cannot make (tone, whether an explanation is true, whether a dropped achievement mattered). The evidence is attached.
- `not_run` — the product has not produced it. Nothing is claimed.

A section's verdict is `fail` if anything failed, `incomplete` if something has not run, `needs_review` if only judgements remain. A candidate reaches `pass` only when every check ran, none failed, and none needs review — in practice a person closes the review items.

The evaluation does not use the product's own scores, gate or verification. They are included in the bundle as `product_self_report`, labelled, for comparison.

**Record** — name; every role present, none invented; titles; dates; promotions kept apart; overlapping roles kept; total years; each achievement's figures under the right role; P&L; cross-functional work; education; skills; certifications; international experience.

**Radar** — missed roles; excluded roles shown; precision of "for you"; function; seniority; location; closed roles and excluded employers; every explanation present and free of figures that are in neither the résumé nor the posting; explanations listed for reading.

**Sharpen** — roles, titles, dates and education unchanged; must-keep facts still stated; other achievements; every figure traceable to the résumé; listed unsupported claims; skills not in the résumé (and whether they came from the posting); the posting's relevant terms before and after; delivered PDF: text extractable, roles in reading order, plain headings, name and contact present, clean characters, no empty role, length.

**Ghost Meter** — verdict within the acceptable set; named signals fired; named signals did not fire; every applicable signal listed as evidence; same answer on repeat checks. Every Ghost Meter answer in QA is recorded, from the site or a tool.

**Failed steps** — every product request that answered with an error, every failed Sharpen and every Radar error is recorded against the candidate and shown as a failure.

### Limits
- Matching is by figures and wording. A fact restated with different numbers of the same meaning ("1.4 thousand crore") reads as lost; such cases surface as `fail` or `review` and need a person.
- Figures in the résumé that the ground truth does not list are accepted as sourced if they are in the PDF text.
- The Record has no field for a role's country, so international experience is checked in the wording only.
- Image-only PDFs cannot be screened for contact details; they rely on the declaration.
