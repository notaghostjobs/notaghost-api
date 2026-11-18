# Ghosted inside ChatGPT and Claude

One small MCP server (`src/routes/mcp.ts`) over the Reader's live inventory. It reuses Radar's in-memory job list
(`livePool`) and Radar's title match (`titleScore`). There is no new crawler, table or job store.

## Endpoints (once deployed)

| Assistant | URL |
|---|---|
| ChatGPT | `https://api.notaghost.jobs/mcp/chatgpt` |
| Claude  | `https://api.notaghost.jobs/mcp/claude` |

Transport: MCP Streamable HTTP, stateless, JSON replies. No sign-in. `GET` is 405.
The path only decides the tag on links back to notaghost.jobs (`?src=chatgpt` / `?src=claude`), which the existing funnel
(`lib/src.ts`, `payments.src_first`) attributes to the first click, sign-in and payment.

## Tools (all read-only)

- `search_jobs(role, years_experience?, company?, page?)`: live Bengaluru roles, 8 a page, each with the employer's own link.
- `get_job(job_id)`: one posting, or the fact and date that the employer took it down.
- `about_radar()`: what Radar is and the notaghost.jobs page about it. No price inside ChatGPT (its rules forbid it).

## What it never does

Takes a résumé, a name, a phone number or a location. Signs anyone in. Writes anything about a person. Shows a posting
it has not confirmed in seven days. Links to a checkout.

## Counting

Each tool call writes one `events` row: `kind = 'mcp'`, `src_first = chatgpt|claude`, `meta = {tool, results, role}`.
Purchases that began in an assistant: `select count(*), sum(amount_paise)/100 from payments where status='paid' and src_first in ('chatgpt','claude')`.

## Settings

- `OPENAI_APPS_CHALLENGE` (optional): the token OpenAI issues for domain verification. Served as plain text at
  `/.well-known/openai-apps-challenge`.

## Test

`scratch: mcptest/t.mts` connects the official MCP client to the route over HTTP and runs 38 checks: tool metadata and
hints, results, paging, the years filter, closed and unknown postings, attribution tags, protocol errors, CORS, the
domain challenge, reply size and the event rows.
