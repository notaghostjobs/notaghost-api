# Résumé rules · v0.1

The output of a Sharpen shot must satisfy every rule below. The rules are enforced in
`src/engine/rules.ts`; a rewrite that breaks a HARD rule is regenerated, and if it still
breaks one it goes to the review queue and the shot is refunded. SOFT rules are scored by
the judge pass. This file is the source of truth — change it first, then the code.

## Truth (HARD)
1. Nothing invented. Every employer, title, date, degree, tool, number and outcome must be
   traceable to the original résumé. (verifier pass)
2. The title under the name is the candidate's real current or most recent title. Never the
   posting's title.
3. "Relevant to this role" lines come only from requirements the candidate can evidence.
   A missing requirement is never dressed up.
4. The fit line is honest: it names the gaps.

## Shape (HARD)
5. Title ≤ 6 words. No pipes, no lists.
6. Summary 2–3 sentences, 35–80 words.
7. "Relevant to this role": 3–4 lines, each ≤ 30 words.
8. Bullets: 4–6 on each of the two most recent roles, 2–4 on older ones; each ≤ 30 words
   (≈ 2 lines); each starts with a verb; no bullet repeated within or across roles
   (≥ 70% word overlap = repeat).
9. Skills: 6–14 items, posting-relevant first.
10. No personal details: DOB, age, marital status, religion, caste, photo, full address.
11. Banned words: passionate, results-driven, dynamic, synergy, go-getter, hardworking,
    detail-oriented, team player, seasoned, guru, ninja, rockstar.
12. Section order: Profile → Relevant → Experience → Skills → Extras → Education.
    Extras keep the résumé's own blocks (ventures, certifications, languages) when they serve the role.

## Page (HARD)
13. Pages out = pages the content needs, never a page with a short spill: shrink into fewer
    pages when the overflow is small, otherwise fill the extra page. (auto-fit in pdf.ts)
14. One template, fixed type, fixed spacing. The user cannot end up with a page that looks
    different from any other user's.
15. No heading at the foot of a page; roles don't split across pages.

## Time (HARD)
16. Résumé upload → parsed profile: ≤ 20 s. Shot → PDF ready: ≤ 60 s, with progress shown.

## Taste (SOFT — judge pass, 1–10, regenerate < 8)
17. Reads like a strong candidate wrote it, not a tool: concrete, specific, no filler.
18. The employer's language is used only where it is true of the candidate.
19. Numbers kept exactly as the original (no rounding, no "~" added or removed).
20. Older roles are shorter than recent ones.
