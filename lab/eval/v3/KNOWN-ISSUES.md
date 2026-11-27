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
