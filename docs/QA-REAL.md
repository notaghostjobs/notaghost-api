# Ghosted QA — Radar test with original résumés (restricted)

This is a separate, switched-off area of the QA environment for running real, unmodified résumés through Radar.
It is on the branch `qa-real-radar`. It is **not** on `qa`, not deployed, and does nothing until the founder authorises it.

## What it does

1. **Upload** — up to 25 PDFs per request, 30 held at most. Each file is stored exactly as uploaded (private storage, QA project), with its SHA-256. Nothing is read, parsed or sent anywhere at this step.
2. **Run** — one résumé at a time, through the product's own code: the normal upload route builds the Record; Radar reads the person and runs against QA's job fixtures. This is the step that uses the AI budget.
3. **Report** — one page per résumé and one consolidated table:
   - the original (opened from storage, hash re-checked) and the text extracted from it
   - the parsed Record
   - recommended jobs, their label and Radar's explanation
   - rejected jobs with Radar's reason; live fixtures sharing a title word or function that were never examined ("possibly missed")
   - findings: Record items not in the file (employer, year, figure), date ranges in the file with no role in the Record, closed or out-of-city roles recommended, explanations with figures from nowhere, every failed step
   - the tester's own verdict: accurate / has issues, parsing errors, incorrect matches, missed jobs, notes

There is no ground truth for a real résumé. The rules catch definite errors; whether a match is *right* is a person's call. Nothing is marked correct automatically.

## Safeguards

| Risk | Control |
|---|---|
| Used without authorisation | Off unless `QA_REAL_RESUMES=authorised` **and** a named authoriser, a date and a retention period are set. Any of them missing or malformed and the service refuses to start. With the switch off every route answers 403. |
| Seen by the wrong tester | A second code (`QA_REAL_ACCESS_TOKEN`), different from the QA access code, on every upload, run, report, file and deletion route. The ordinary QA code alone opens none of them (checked by the self-test at every start). The site keeps the code for the browser tab only. |
| Leaking into ordinary QA tools | Real-résumé placeholders are excluded from the candidate list, sign-in, inspect, outbox, evaluation and reset tools. The public `/qa/report` never contains them. |
| A real person being contacted | Unchanged from QA: WhatsApp is simulated, SMS and e-mail providers are refused, no payment key. The run sends no message at all. |
| A real account | Each résumé runs on a placeholder account on a number no phone can have (`+91 00000 02001…`), named "Real résumé R001". The person's name, phone and e-mail are not put on the account. The session used for the run is deleted when the run ends. |
| Production | Unchanged: production's API and database cannot be reached from QA. No production data is read; the files come only from the upload. |
| Kept too long | Every file is deleted automatically `QA_REAL_RETENTION_DAYS` (1–14) after upload: original, the product's copy, Record, Radar run, placeholder account, simulated messages. "Delete now" per résumé and "Delete everything" do the same at once. Removing the authorisation deletes everything at the next start. |
| Overspend | The existing ₹1,000 budget. Checked before each résumé and inside each model call; the run stops and says so. |
| No trace | An audit list (`/qa/real/audit`): uploads, runs, reports and originals opened, deletions — ids and times, no contents. |

### What the controls do not cover — for the founder to decide
- **The résumé text leaves QA once**: it is sent to the AI provider (through the QA key) to build the Record and the Radar list. That is how the product works.
- The files and Records sit in the QA Supabase project (Sydney) until deleted.
- The Record holds the person's name and whatever contact details are on the résumé, inside the restricted area.
- **Permission**: whether these 21 people's résumés may be used for testing is a legal and ethical decision this tool cannot make. It records who authorised it and when.
- Anyone given the second code can read all of them.

## Limits
- Not yet run against the live QA service. The checks and the authorisation rules are tested in the build; the upload, run and report routes are not.
- The cost of one Radar run in QA is not known yet. Run two first.
- QA holds 60 invented roles in ten functions (plus anything imported). A person outside those functions will get no recommendation; that is a gap in the fixtures, not a Radar miss.
- Radar leaves out the person's current employer by design.
- Image-only PDFs: the product may or may not read them; the page shows the error if it cannot.

## Deploying (only after authorisation)

1. Tell Claude the authorisation is given. Claude merges `qa-real-radar` into `qa` in both repositories (never into `main`). The QA site rebuilds by itself.
2. Render → `ghosted-qa-api` → Environment → add:

| Name | Value |
|---|---|
| `QA_REAL_RESUMES` | `authorised` |
| `QA_REAL_ACCESS_TOKEN` | a new random string of 40+ characters (not the QA access code) |
| `QA_REAL_AUTHORISED_BY` | the founder's name |
| `QA_REAL_AUTHORISED_ON` | the date, e.g. `2026-11-14` |
| `QA_REAL_RETENTION_DAYS` | `7` (1–14) |

3. Render → **Manual Deploy → Deploy latest commit**. If a value is wrong the log shows `[qa] REFUSING TO START` and why.
4. QA start page → **Run the isolation self-test**. The line "Real résumés: closed unless authorised…" must pass and name the authoriser.

## Running the 21

1. QA site → **Real résumés (restricted)** → enter the second code.
2. **Upload**: choose all 21 PDFs → Upload. Each gets an id R001–R021.
3. **Run**: type `R001, R002` → Run. Read both pages and the spend. Then leave the box empty → Run for the rest.
4. The table refreshes by itself. Open each id for its page; record a verdict at the bottom.
5. When finished: **Delete everything**. To close the area, remove `QA_REAL_RESUMES` in Render and deploy.

Tool equivalents (headers `x-qa-access` and `x-qa-real-access`): `GET /qa/real/status` · `POST /qa/real/upload` (form field `files`, repeated) · `POST /qa/real/run {ids?, rerun?}` · `GET /qa/real/report` · `GET /qa/real/R001` · `GET /qa/real/R001/original` · `POST /qa/real/R001/review` · `POST /qa/real/delete {id | all}` · `GET /qa/real/audit`.
