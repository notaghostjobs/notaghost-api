# Matching V3 evaluation: known issues

## K1. Reader stores at most 20,000 characters per job description (upstream; not changed)
- Where: `src/reader/enrich.ts` (lines 119 and 174) and `src/reader/read.ts` (line 44) keep `description.slice(0, 20000)`.
- Extent (frozen 24 Nov snapshot): 283 of 31,616 postings (0.9%) sit at the cap; 1 of the 638 postings V3 would judge for the 19 development profiles.
- Effect: for those postings, text after character 20,000 never reaches extraction or the judge. V3 cannot detect what is missing; a posting at exactly the cap may be incomplete.
- Decision (26 Nov 2026): recorded, not fixed. Reader changes are out of scope for the pilot. Revisit before production use.

## K2. Arm A is the offline control matcher, not production Radar
A production-equivalent benchmark is still required before any deployment (specification on Issue #2).

## K3. Candidate record "to present" dates count to 24 Nov 2026
`src/lab/cir.ts` defaults its reference date to 2026-11-24; years for a role "to present" are a few days short.

## K3 (updated 27 Nov 2026). Resolved for evaluation roots
Evaluation roots now pass the snapshot's capture time as the evaluation date and use the V3 employment-date reader
(`src/lab/v3/dates.ts`). The development records keep the original reader and date so they reproduce exactly.

## K4. The product's shared résumé reader misreads common employment-date formats (production; not changed)
- Where: `src/lib/career.ts` (`RANGE`, `jobsOf`, `analyse`), used by the live product.
- What: it reads only "Mon YYYY - Mon YYYY"-style ranges. It misses two-digit years with a curly apostrophe (Sep’19),
  bare two-digit years (June 22 - Present), dates with a day (March 30, 2020 to August 28, 2021), Mon-YYYY, and
  "to till now"; and it counts ranges that are not employment (a bare education table row, a period inside a sentence).
- Found on: 2 of 3 pilot résumés (both read as 1.9 years instead of about 9.5 and 13.5). On the 19 development
  résumés the two readers agree within a year for 16.
- Decision: recorded, not fixed in production. A production change needs separate approval.

## K5. Defects found in the three-candidate pilot (27 Nov 2026) and what was done
Fixed on the V3 branch after the pilot (freeze after `35866128…`; regression tests in `src/lab/v3/pilot-fixes.test.mts`):
- Shortlist took accounting, audit and actuarial postings for a banking/insurance operations candidate. Cause: the
  vocabulary let shared words ("reconciliation", "audit") stand for the accounting craft and had no anchors for
  operations crafts. Now: operations families exist, neighbouring crafts are "neighbour", and a craft named in the
  title that the person has not worked in weighs 0.15 in the shortlist (s3.4).
- Anchor coverage: 56 → 84 anchors, 19 → 30 families (anchors v3.2).
- Validator (val3.1, `src/lab/v3/validate3.ts`; the V2 validator is untouched): quotes compared word for word ignoring
  spacing and punctuation; years of education no longer compared with years of work; a requirement decided by the
  computed years needs no résumé line.
- Gate label (g3v3.3): "adjacent and a step up" was shown for a move from management to a hands-on role.
- Review manifest counted an overlap case in both arms' totals (categories summed to 38 for 36 cases).

Still open after the fixes:
- K5a. The judge sometimes writes a "résumé quote" that is not in the résumé (3 invented, 1 near-paraphrase in 120
  pilot verdicts). The verdict is rejected and the posting dropped; there is no repair or retry (proposal on Issue #2,
  not enabled).
- K5b. A person's craft counts as "demonstrated" when an anchor word appears in a work line. One loose word can still
  place someone in a craft they only worked beside.
- K5c. An adjacent fit that is a move from management to a hands-on role stays "stretch". Whether that is right is a
  product decision, not settled here.
- K5d. The cost model was 18% low in the pilot (₹108.53 per candidate against ₹92).
- K5e. The fixes were written after seeing P01–P03. Those three are development data; the fixes are unvalidated until
  a fresh, untouched candidate set is run.
