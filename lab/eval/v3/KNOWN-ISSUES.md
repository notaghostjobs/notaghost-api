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
