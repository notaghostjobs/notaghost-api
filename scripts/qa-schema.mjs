// Builds supabase/qa/qa-database.sql from the repository's own migrations (0001–0010): `node scripts/qa-schema.mjs`.
// Nothing is read from production. 0011 (Open's tables) is left out because production has not applied it either.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
const dir = new URL("../supabase/migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => /^00(0[1-9]|10)_.*\.sql$/.test(f)).sort();
const PROD = "vviporiiqwykfcetusta";
// statements that are meaningless or unwanted on a new, empty database are taken out, by exact match, and counted
const DROP = [/^truncate table observations;\s*$/m, /^delete from postings where source = 'ats';\s*$/m, /^truncate table companies;\s*$/m,
  /^insert into storage\.buckets \(id, name, public\) values\n(?:\s+\(.*\),?\n)+on conflict do nothing;\s*$/m];
let body = "", removed = 0;
for (const f of files) { let s = readFileSync(new URL(f, dir), "utf8"); for (const re of DROP) if (re.test(s)) { s = s.replace(re, "-- (a statement that only applies to an existing database was left out here)"); removed++; } body += `\n-- ───────── from supabase/migrations/${f} ─────────\n${s.trim()}\n`; }
if (removed !== 4) { console.error(`expected to leave out 4 statements, left out ${removed}: the migrations changed, review this script`); process.exit(1); }
if (/\b(drop|truncate|delete\s+from)\b/i.test(body.replace(/--.*$/gm, ""))) { console.error("a destructive statement is left in the migrations"); process.exit(1); }

const out = `-- GHOSTED QA DATABASE · run ONCE, in the NEW QA Supabase project's SQL editor. Never in production.
-- Generated from this repository's migrations (${files[0]} … ${files.at(-1)}) by scripts/qa-schema.mjs. Nothing comes from production.
--
-- BEFORE RUNNING: replace PASTE_QA_PROJECT_REF (it appears in two statements: step 1 and step 5) with the QA project's reference — the 20 letters in its address
-- (https://<these 20 letters>.supabase.co, also under Project Settings → General → Reference ID).
-- Or let the script do it: node scripts/qa-schema.mjs --ref=<reference> writes a filled-in copy.
--
-- Everything runs in one transaction. The identity check comes first; if it fails, or anything after it fails,
-- nothing at all is changed.
begin;

-- ═════════ 1 · IDENTITY CHECK — before any change ═════════
do $check$
declare
  qa_ref  text := 'PASTE_QA_PROJECT_REF';
  n       int;
begin
  if qa_ref !~ '^[a-z]{20}$' then
    raise exception 'STOP: put the QA project''s 20-letter reference in place of PASTE_QA_PROJECT_REF. Nothing was changed.';
  end if;
  if qa_ref = '${PROD}' then
    raise exception 'STOP: that is the PRODUCTION project''s reference. Nothing was changed.';
  end if;
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','p','v','m','S');
  if n > 0 then
    raise exception 'STOP: this project already has % object(s) in its public schema. A new QA project has none. This may be production. Nothing was changed.', n;
  end if;
  select count(*) into n from pg_type t join pg_namespace s on s.oid = t.typnamespace where s.nspname = 'public' and t.typtype = 'e';
  if n > 0 then raise exception 'STOP: this project already has custom types. It is not a new project. Nothing was changed.'; end if;
  select count(*) into n from storage.buckets;
  if n > 0 then raise exception 'STOP: this project already has % storage bucket(s). It is not a new project. Nothing was changed.', n; end if;
  select count(*) into n from auth.users;
  if n > 0 then raise exception 'STOP: this project already has sign-in users. It is not a new project. Nothing was changed.'; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls)
     or not exists (select 1 from pg_roles where rolname = 'anon') or not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'STOP: this does not look like a Supabase project (its standard roles are missing). Nothing was changed.';
  end if;
end
$check$;

-- ═════════ 2 · STRUCTURE — the repository's migrations, in order ═════════
${body}
-- ═════════ 3 · QA-ONLY ADDITIONS ═════════
-- a column one internal page reads that the migrations never declared
alter table public.postings add column if not exists created_at timestamptz default now();

-- the QA database can never hold a real phone number: only the synthetic +91 00000 0xxxx identities fit
alter table public.users     add constraint qa_identities_only check (phone ~ '^\\+9100000\\d{5}$');
alter table public.otp_codes add constraint qa_identities_only check (phone ~ '^\\+9100000\\d{5}$');

-- private file storage: uploaded résumés, delivered PDFs, receipts
insert into storage.buckets (id, name, public) values ('resumes', 'resumes', false), ('outputs', 'outputs', false), ('receipts', 'receipts', false);

-- ═════════ 4 · PERMISSIONS — tighter than a default project, never looser ═════════
-- every table is closed to the public keys; only the service key (held by the QA service alone) can use them
do $lock$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end
$lock$;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant usage on schema public to service_role;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- ═════════ 5 · MARK THIS DATABASE AS QA ═════════
-- The QA service starts only if this mark names the same project as its own settings. Production refuses to run on a marked database.
do $mark$
declare qa_ref text := 'PASTE_QA_PROJECT_REF';
begin
  if qa_ref !~ '^[a-z]{20}$' or qa_ref = '${PROD}' then raise exception 'STOP: the project reference in step 5 is not filled in correctly.'; end if;
  insert into public.reader_control (key, value) values ('qa:environment', jsonb_build_object('name', 'qa', 'database', qa_ref, 'created', now()));
end
$mark$;

commit;

select 'QA database ready: ' || count(*) || ' tables, marked for project ' || (select value->>'database' from public.reader_control where key = 'qa:environment') as result
from pg_tables where schemaname = 'public';
`;
const refArg = (process.argv.find((x) => x.startsWith("--ref=")) ?? "").slice(6);
if (refArg) {
  if (!/^[a-z]{20}$/.test(refArg) || refArg === PROD) { console.error("--ref must be the QA project's 20-letter reference, and not production's"); process.exit(1); }
  const places = out.split("'PASTE_QA_PROJECT_REF'").length - 1;
  if (places !== 2) { console.error(`expected the reference in 2 statements, found ${places}`); process.exit(1); }
  const filled = out.replaceAll("'PASTE_QA_PROJECT_REF'", `'${refArg}'`).replace(/^-- BEFORE RUNNING:[\s\S]*?\n--\n/m, `-- Filled in for QA project ${refArg}. Run it only in that project: the address bar must show /project/${refArg}/.\n--\n`);
  writeFileSync(new URL(`../supabase/qa/qa-database.${refArg}.sql`, import.meta.url), filled);
  console.log(`supabase/qa/qa-database.${refArg}.sql written (reference set in ${places} statements)`); process.exit(0);
}
if (process.argv.includes("--check")) { let cur = ""; try { cur = readFileSync(new URL("../supabase/qa/qa-database.sql", import.meta.url), "utf8"); } catch { /* missing */ } if (cur !== out) { console.error("supabase/qa/qa-database.sql is out of date with the migrations: run node scripts/qa-schema.mjs"); process.exit(1); } console.log("supabase/qa/qa-database.sql matches the migrations"); process.exit(0); }
writeFileSync(new URL("../supabase/qa/qa-database.sql", import.meta.url), out);
console.log(`supabase/qa/qa-database.sql written from ${files.length} migrations (${out.split("\n").length} lines)`);
