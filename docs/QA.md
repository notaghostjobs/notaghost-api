# Ghosted — QA environment

A separate copy of Ghosted for independent testing with synthetic candidates. It runs the real product code and the
real model against invented people, invented employers and simulated messaging. It shares nothing with production.

Branch: `qa` in both repositories. `main` is untouched and `qa` is never merged into it.

---

## 1. What is isolated, and how it is enforced

| Thing | Production | QA | Enforced by |
|---|---|---|---|
| Database + file storage | project `vviporiiqwykfcetusta` | a new Supabase project | The service refuses to start on production's project, or on any project other than the one named in `QA_SUPABASE_REF`. Every outbound call to production's project is refused at the network boundary. The QA database rejects any phone number that is not a QA identity (check constraint). At start the service exits unless the database carries the QA mark for this same project, or if it finds a non-QA account. |
| API | `notaghost-api.onrender.com` | a new Render service on branch `qa` | Separate service, separate settings. QA cannot call production's API (boundary answers 599). |
| Site | `notaghost.jobs` | a new Cloudflare Pages project on branch `qa` | `npm run build:qa` refuses a production API address and fails if one is left in the output. In the browser, the QA build refuses calls to production and stops if the service does not report `env: qa`. |
| AI | production key | a key from a separate Anthropic workspace | The service counts the cost of every call and stops at `QA_AI_BUDGET_INR` (max 1000). The workspace spend limit is the outer backstop. **The service cannot verify the key is a different key** — that is declared with `QA_AI_KEY_IS_SEPARATE=yes` and is the operator's responsibility. |
| Payments | Razorpay live | Razorpay test mode, or none | A key that does not start `rzp_test_` stops the service at start. |
| WhatsApp | Meta Cloud API | simulator | `WA_TOKEN` and `WA_PHONE_ID` must be the literal `qa-simulated`. Calls to Meta are answered by a simulator that writes to the QA outbox. Nothing is sent. |
| SMS, email | MSG91 | none | Their keys must be absent; calls to those providers are refused. |
| Other websites | fetched | refused | Any host that is not QA's own database, QA's own address or the AI provider is refused — for `fetch`, for direct connections, and inside the page-opening browser. Real hosts can be allowed one by one with `QA_REAL_FETCH_HOSTS`. |
| Scheduled jobs | run by the clock | off | Morning Radar, nudges and automatic checks start only from the QA tools. |
| Access | public | access code, expiring | Every request needs the `x-qa-access` code or a QA session. `QA_ACCESS_EXPIRES` must be within 31 days; after it, everything is refused and the service will not restart. |

Admin and tester back doors do not exist in QA: `ADMIN_SECRET`, `RADAR_TESTERS`, `OTP_DEV_CODE`, `OTP_TEST_PHONES` must be unset or the service will not start.

## 2. Evidence the environment produces about itself

`GET {QA_API}/qa/report` — readable without the access code; contains pass/fail lines and synthetic results only.

- `isolation`: run at every start, and from the QA start page. No AI call. Each line is something actually attempted
  (reach production's API, reach production's database, send SMS, send email, send WhatsApp, sign in with a real
  number, store a real number, open an outside site in the browser, bad payment signature, no access code…).
- `pilot`: the ten candidates through résumé upload → Record → Radar → Sharpen fit → Sharpen document, plus every
  Ghost Meter page, with the real model. Expected values come from the fixture catalogue; mismatches are shown.

Checks that run without infrastructure (already run on this branch):

- `npm run build` → includes `QA safety self-check` (configuration guard, access gate, budget arithmetic) and checks `qa-database.sql` still matches the migrations.
- `npx tsx scripts/qa-boundary-check.ts` → the network boundary, with placeholder settings.
- Site: `npm run build:qa` with a production address → refused.

## 3. Setting it up (operator)

Nothing here touches production. Secrets go into the dashboards only — never into chat or Git.

### A. Supabase — new project
Nothing is run in production. The QA structure comes from this repository's migrations.
1. supabase.com → **New project**. Name `ghosted-qa`. Region: Mumbai. Generate a database password and keep it in your password manager.
2. Project Settings → General → copy the **Reference ID** (20 letters). It is not a secret.
3. Open `supabase/qa/qa-database.sql`. Replace `PASTE_QA_PROJECT_REF` (one place, near the top) with that Reference ID.
4. In the **QA** project → SQL Editor → paste the whole file → Run. Expect `QA database ready: 16 tables, marked for project <your reference>`.
   - It checks first that the project is new and empty (no tables, no types, no storage buckets, no sign-in users) and that the reference is not production's. If any check fails it says `STOP: …` and nothing is changed.
   - It is one transaction: if anything fails part-way, nothing is kept.
   - It can only be run once. A second run stops at the first check.
5. Project Settings → API: note the **Project URL** and the **service_role** key for step C.

What the script contains: `create table / index / type / sequence / function` from migrations 0001–0010; one added column (`postings.created_at`); a rule that phone numbers must be QA identities; three private storage buckets; row-level security on every table; removal of the public keys' access; the QA mark. It contains no `drop`, `truncate`, `delete` or `update` of existing data (`scripts/qa-schema.mjs` fails if one appears). 0011 (Open's tables) is left out because production has not applied it.

### B. Anthropic — separate workspace
1. console.anthropic.com → Settings → Workspaces → **Create workspace** `ghosted-qa`.
2. In that workspace → **Spend limits** → set the monthly limit to **$10**.
3. In that workspace → API keys → **Create key**. Keep it for step C.

### C. Render — new service
1. Render → **New → Web Service** → the same API repository → Branch **`qa`** → Runtime Docker → name `ghosted-qa-api` → same instance type as production. Do not touch the existing service.
2. Environment variables (exact names):

| Name | Value |
|---|---|
| `GHOSTED_ENV` | `qa` |
| `SUPABASE_URL` | QA project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | QA service_role key |
| `QA_SUPABASE_REF` | the 20-letter id in the QA project URL |
| `ANTHROPIC_API_KEY` | the QA workspace key |
| `QA_AI_KEY_IS_SEPARATE` | `yes` |
| `QA_AI_BUDGET_INR` | `1000` |
| `QA_AI_CONCURRENCY` | `3` |
| `WA_TOKEN` | `qa-simulated` |
| `WA_PHONE_ID` | `qa-simulated` |
| `OTP_PROVIDER` | `whatsapp` |
| `QA_ACCESS_TOKEN` | a random string of 40+ characters (password manager) |
| `QA_ACCESS_EXPIRES` | a date within 31 days, e.g. `2026-12-10` |
| `QA_PUBLIC_URL` | this service's address, e.g. `https://ghosted-qa-api.onrender.com` |
| `APP_ORIGIN` | the QA site's address from step D |
| `RAZORPAY_WEBHOOK_SECRET` | any random string (needed for the payment scenarios) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | optional: Razorpay **Test Mode** keys (`rzp_test_…`) |

Do **not** set: `ADMIN_SECRET`, `RADAR_TESTERS`, `OTP_DEV_CODE`, `OTP_TEST_PHONES`, `MSG91_*`, `RESEND_API_KEY`.

3. Deploy. If anything is unsafe the log shows `[qa] REFUSING TO START` with the reasons, and nothing is served.

### D. Cloudflare Pages — new project
1. Workers & Pages → **Create → Pages → Connect to Git** → the site repository → project name `ghosted-qa`.
2. Production branch **`qa`**. Build command `npm run build:qa`. Output directory `dist`.
3. Variables: `VITE_GHOSTED_ENV` = `qa`, `VITE_API_URL` = the QA API address.
4. Deploy, then put the resulting `https://ghosted-qa.pages.dev` address into `APP_ORIGIN` on Render (step C).
5. Do not attach a custom domain and do not change the existing project.

### E. First run
1. Open the QA site, enter the access code, press **Seed QA001–QA010 and all fixtures**.
2. Press **Run the isolation self-test**. Every line should pass.
3. Press **Run the 10-candidate pilot**. Results appear under **Self-test and pilot report** and at `/qa/report`.

## 4. Handover for the independent tester

- Site: the QA Pages address. Enter the access code once per browser. A red "QA Environment · build … · QA00x" marker is always on screen.
- Start page: `#/qa`. Candidates, sign-in, codes, messages, fixtures, reset.
- Two ways to sign in: **Sign in** on a candidate row (instant session), or the product's own sign-in with the candidate's number (`00000 01001` for QA001 … `00000 01010` for QA010) and the code shown under **Codes**.
- Résumé files: **Download résumé** on each row (`/qa/files/QA001.pdf`).
- Job links: **Fixtures and expected results** lists every invented role and every Ghost Meter page with what the catalogue expects.
- Every control has a `data-testid` (its element id where one exists, otherwise `btn-…`, `field-…`, `link-…`, `file-…` from its label). QA tools use `qa-…`.
- Every API answer carries `x-request-id`; the same id is on the AI calls, messages and blocked calls it caused.

### Tools (header `x-qa-access: <code>` on each)

| Call | Does |
|---|---|
| `GET /qa/status` | build, database, providers, AI spend, active faults |
| `GET /qa/identities` · `POST /qa/login {id}` | candidates · a session for one |
| `GET /qa/otp?id=QA001` | codes captured for that number |
| `GET /qa/outbox[?id=]` · `GET /qa/blocked` | simulated messages · refused outbound calls |
| `GET /qa/ai` | every model call: model, prompt version, step, tokens, cost, request id |
| `GET /qa/fixtures` | candidates, employers, roles, Ghost Meter pages, expected results |
| `GET /qa/inspect/QA001` | Record, Radar run, fits, Sharpen outputs and checks, plans, payments, messages |
| `POST /qa/seed {to}` · `POST /qa/reset {id \| all, records}` | create/refresh identities and fixtures · wipe a candidate's data |
| `POST /qa/entitlement {id, state, product}` | `free` `paid` `exhausted` `expired` for `sharpen` or `radar` |
| `POST /qa/pay {id, product, scenario}` | `success` `failed` `cancelled` `pending` `duplicate_webhook` `delayed_webhook`, through the real webhook handler with a real signature |
| `POST /qa/clock {id, action, days}` | `radar_morning` `expire_plan` `plan_days_left` `expire_session` `expire_otp` |
| `POST /qa/fault {kind, times}` | `ai_timeout` `ai_rate_limit` `ai_malformed` `parse_fail` `page_unavailable` `wa_fail` — faults produce errors, never results |
| `POST /qa/selftest` · `POST /qa/pilot {from, to, sharpen, meter}` | run the isolation checks · run candidates through the real product |

The AI log and total are never reset: the budget is cumulative.

## 5. Fixtures

- **Candidates QA001–QA010** — one per case: entry level; mid-level reference; senior three-page; career switcher; two-year gap; three roles at one employer; two-column; unusual format; contradictory dates and years; sparse. Each has `expected_radar` (roles that must be "for you", roles that must never appear) and notes on what Sharpen must not do.
- **10 invented employers, 60 roles** — ten functions × four levels, plus an adjacent and a closed role per function.
- **17 Ghost Meter pages** — live and strong, legitimate but thin, contradictory dates, stale, not on the employer's system, closed, duplicate text, scam tells, pages that fail to load, and others; each with the acceptable verdicts.

Ghost Meter signals, as numbered in the product: 2 templated description · 3 catch-all location · 4 evergreen language · 5 kitchen-sink requirements · 6 apply route off the employer's system · 7 same description under another employer · 8 first seen long ago · 9 not on the employer's own hiring system · 10 many copies of one title · 11 stale in their system · 12 requisition closed and reopened · 13 reposted · 14 open more than 60/90 days · 15 posted by an agency · 16 many applicants and still open · 17 public "never heard back" record · 18 layoffs or hiring freeze in the last 90 days · 19 openings out of proportion · 20 asks for money or documents · 21 disappeared then returned with a fresh date · 22 reply rate. Signals 2, 5 and 7 are currently switched off in the product; the duplicate-text fixture documents that.

## 6. Known limitations

- The QA structure is built from the repository's migrations, not copied from production. Every table and column the code names was checked against it (16 tables, 154 columns; one missing column added). A difference in production that the code does not name — a type, a default, an index — would not be reproduced.
- The AI key's separateness is declared, not verifiable from inside the service.
- Links inside simulated WhatsApp messages are built for the production site's address; read the message in the outbox rather than following it.
- `payment.failed` is not a webhook event the product handles; the `failed` scenario shows the payment staying unpaid.
- Ghost Meter's company research runs through the AI provider's own web search, so it does search the real web — for invented employer names, where it finds nothing. Signals 17 and 18 therefore do not fire in QA. Search fees are counted in the budget.
- The budget is checked before each call. Calls already in flight when the cap is reached (at most `QA_AI_CONCURRENCY`) still finish, so the total can end a few rupees over.
- Radar reads only the invented employers. Real listings need a host added to `QA_REAL_FETCH_HOSTS`, one at a time.
- The pilot records what the product produced; whether a rewrite is *good* is for the independent tester to judge.
- QA001–QA010 exist as files. QA011–QA100 are identities only until their résumés are generated (phase 6).

## 7. Taking it down

Delete the Render service, the Pages project, the Supabase project and the Anthropic workspace key. Nothing else refers to them.
