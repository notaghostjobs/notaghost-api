-- GHOSTED QA · step 2 of 2 · run this in the QA project's SQL editor, AFTER pasting and running the text from step 1.
-- It stops by itself if it finds anything that looks like real data, so it cannot do harm in the wrong project.
do $$ begin
  if exists (select 1 from public.users where phone !~ '^\+9100000\d{5}$') then
    raise exception 'STOP: this project already holds non-QA users. This is not the empty QA project.';
  end if;
  if exists (select 1 from public.payments) then
    raise exception 'STOP: this project already holds payments. This is not the empty QA project.';
  end if;
end $$;
-- the QA database can never hold a real phone number: only the synthetic +91 00000 0xxxx identities fit
alter table public.users drop constraint if exists qa_identities_only;
alter table public.users add constraint qa_identities_only check (phone ~ '^\+9100000\d{5}$');
alter table public.otp_codes drop constraint if exists qa_identities_only;
alter table public.otp_codes add constraint qa_identities_only check (phone ~ '^\+9100000\d{5}$');
-- private file storage for uploaded résumés and delivered PDFs
insert into storage.buckets (id, name, public) values ('resumes', 'resumes', false), ('outputs', 'outputs', false) on conflict (id) do nothing;
-- the service key (used only by the QA service) may use everything; the public key may use nothing
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
revoke all on all tables in schema public from anon, authenticated;
select 'QA project ready: ' || count(*) || ' tables' as result from pg_tables where schemaname = 'public';
