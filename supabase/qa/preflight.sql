-- GHOSTED QA · preflight · READ-ONLY. One SELECT; it changes nothing. Run it in the ghosted-qa project's SQL editor.
-- First look at the browser's address bar: it must contain /project/hlkdwqkvhrbrkyydaxxt/
select
  current_database()                                                                          as database,
  current_user                                                                                as running_as,
  split_part(version(), ' ', 2)                                                               as postgres,
  (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind in ('r','p','v','m','S'))                        as public_tables_views_sequences,
  (select count(*) from pg_type t join pg_namespace s on s.oid = t.typnamespace
    where s.nspname = 'public' and t.typtype = 'e')                                           as public_types,
  (select count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public')                                                               as public_functions,
  (select count(*) from storage.buckets)                                                      as storage_buckets,
  (select count(*) from auth.users)                                                           as sign_in_users,
  to_regclass('public.users') is not null or to_regclass('public.payments') is not null       as product_tables_already_here,
  exists (select 1 from pg_roles where rolname = 'service_role' and rolbypassrls)
    and exists (select 1 from pg_roles where rolname = 'anon')
    and exists (select 1 from pg_roles where rolname = 'authenticated')                       as supabase_roles_present,
  case when (select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r','p','v','m','S')) = 0
        and (select count(*) from pg_type t join pg_namespace s on s.oid = t.typnamespace where s.nspname = 'public' and t.typtype = 'e') = 0
        and (select count(*) from storage.buckets) = 0 and (select count(*) from auth.users) = 0
       then 'EMPTY — ready for qa-database.sql' else 'NOT EMPTY — do not run qa-database.sql; tell Claude what this row shows' end as verdict;
