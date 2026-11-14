# Ghosted QA — Radar test with original résumés (restricted)

This is a separate, switched-off area of the QA environment for running real, unmodified résumés through Radar.
It is on `qa` (never `main`). It does nothing until the QA API is deployed with the founder's authorisation set.

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
- With the pool on fixtures, QA holds only invented roles; a real-résumé run is refused in that state unless forced.
- Radar leaves out the person's current employer by design.
- Image-only PDFs: the product may or may not read them; the page shows the error if it cannot.

## Real job discovery

Radar in QA can look at real, current Bengaluru listings instead of invented fixtures. Off unless `QA_DISCOVERY=authorised`.

- **Sources**: the employers in `src/reader/data/known.ts` (hiring-system references verified by hand on 9 Nov 2026) that are on Greenhouse, Lever, Ashby, SmartRecruiters or Workday — listed at `GET /qa/discovery/sources`. Read with the product's own reader.
- **Rule at the network boundary** (fixed in code, not configurable): hosts `*.greenhouse.io`, `*.lever.co`, `*.ashbyhq.com`, `*.smartrecruiters.com`, `*.myworkdayjobs.com`; `GET`/`HEAD` only, plus the one `POST` Workday's own job search uses; never an apply, sign-in or candidate path; no cookies. `robots.txt` is honoured by the reader. Every other outside host stays refused.
- **No model call** in reading listings or their descriptions.
- **Stored for every listing**: source system, the system's own job id, address, the system's posted date, first and last time QA read it, the description and when it was read.
- **Fixtures and real listings never mix**: one switch (`pool`) decides which Radar sees. A real-résumé run is refused while the switch is on fixtures. Every recommendation that is a fixture is reported as `invented_fixture` and fails.
- **Verification**: when a run finishes, and again on request, each recommended listing is asked for at its own source at that moment: `verified_active` (Greenhouse/Lever job API or Workday posting answers for that id; SmartRecruiters/Ashby board re-read and the id is in it), `closed` (the source answers 404/410 or the id is gone from the board), `unverifiable` (the source could not be asked), `invented_fixture`. A role the source dates over 90 days, or "30+ days", is flagged as open but old.
- **Coverage**: this is not everything production reads. Employers on other systems or their own portals are not read in QA. A role QA never read cannot be recommended and is not a Radar miss.

## Sharpen against a Radar role

On a résumé's page, each recommendation confirmed open has **Sharpen against this role**. It runs the product's own fit step and Sharpen, then shows:
- backend status, error, times, the product's own before/after score and its own gate/verification output (shown, not relied on)
- the delivered PDF (restricted route) and the text extracted from it
- the comparison: roles, titles, dates and education against the Record; every figure against the original file; skills not in the résumé and whether they came from the posting; lines whose substance is not in the résumé; the PDF's readability

Sharpen refuses a role that is not `verified_active` unless forced. No money moves: the entitlement is a QA database row.

## AI budget
The running total is a database row (`qa:ai:total`), read when the process starts, so it survives restarts. A call is refused once the total reaches the cap. Tested in the build: a process starting with ₹1,000 recorded refuses the next call. Shown live in the readiness report (database total = process total). Calls already in flight when the cap is reached (at most 3) finish.

## Deployment configuration (nothing is deployed until you do this)

`qa-real-radar` is merged into `qa` (not `main`). The QA site rebuilt itself from `qa`; its new pages answer "not authorised" until the API is deployed and configured.

Render → `ghosted-qa-api` → Environment. Add these eight; change nothing else:

| Name | Value |
|---|---|
| `QA_REAL_RESUMES` | `authorised` |
| `QA_REAL_ACCESS_TOKEN` | a new random string of 40+ characters (not the QA access code) |
| `QA_REAL_AUTHORISED_BY` | the founder's name |
| `QA_REAL_AUTHORISED_ON` | the date, e.g. `2026-11-14` |
| `QA_REAL_RETENTION_DAYS` | `7` (1–14) |
| `QA_DISCOVERY` | `authorised` |
| `QA_DISCOVERY_AUTHORISED_BY` | the founder's name |
| `QA_DISCOVERY_AUTHORISED_ON` | the date |

Do not set `QA_PAID_RUNS`. Then **Manual Deploy → Deploy latest commit**. A wrong value shows `[qa] REFUSING TO START` in the log with the reason.

To deploy the code without switching anything on, deploy with none of the eight set: both areas stay closed.

## Readiness checks (in this order; each is a button on the QA start page)

1. **Run the isolation self-test** — 0 failed. New lines: real résumés closed unless authorised and never opened by the ordinary code; outside hiring systems read-only; AI budget read from the database; automated paid run off.
2. **Real job discovery → Read 5 employers (trial)** → **Status**. Each feed shows jobs read or the error. If Workday feeds fail from Render, see the blockers.
3. **Read every employer**, then **Read job descriptions**. Status shows live Bengaluru roles and how many have descriptions.
4. **Point Radar at real listings**.
5. **Readiness for the real-résumé run** — `ready_for_real_resume_run: true`, or the list of what is not.

## Running the 21

1. QA site → **Real résumés (restricted)** → second code → choose the 21 PDFs → **Upload** (R001–R021).
2. Type `R001, R002` → **Run**. Read both pages and the spend.
3. Empty box → **Run** for the rest.
4. On each page: recommendations with source, job id, read times, description and status at source; rejected roles with Radar's reason; possibly missed roles. **Ask every source again, now** repeats the check.
5. Choose a role confirmed open → **Sharpen against this role**. The result appears on the same page.
6. Record the tester's verdict. The consolidated table links every page.
7. Finish: **Delete everything**; **Point Radar back at fixtures**; remove the eight settings and deploy.

Tool equivalents (headers `x-qa-access`, plus `x-qa-real-access` for `/qa/real/*`): `GET /qa/readiness` · `GET /qa/discovery/status` · `GET /qa/discovery/sources` · `POST /qa/discovery/read {systems?, limit?, only_unread?}` · `POST /qa/discovery/descriptions {limit}` · `POST /qa/discovery/pool {mode}` · `GET /qa/real/status` · `POST /qa/real/upload` · `POST /qa/real/run {ids?, rerun?}` · `GET /qa/real/report` · `GET /qa/real/R001` · `GET /qa/real/R001/original` · `POST /qa/real/R001/verify` · `POST /qa/real/R001/sharpen {url}` · `GET /qa/real/R001/sharpen/<shot>/pdf` · `POST /qa/real/R001/review` · `POST /qa/real/delete {id | all}` · `GET /qa/real/audit`.
