-- =====================================================================
-- PHCL Asset Intake — provenance of the master data
--
-- Answers two questions the interface has to be able to answer at any time:
--   "which data is in use right now?"  and  "when was it loaded, from what?"
-- Every import writes one row per table it touched; nothing is ever deleted,
-- so the history stays readable.
-- Run after 04_rls.sql. Safe to re-run.
-- =====================================================================

create table if not exists am_data_source (
  id           bigserial primary key,
  table_name   text not null,
  source_file  text,
  source_kind  text not null default 'manual'
               check (source_kind in ('beetrack-template', 'snapshot', 'sql-seed',
                                      'manual', 'register-scan')),
  rows_loaded  int,
  loaded_at    timestamptz not null default now(),
  loaded_by    text,
  note         text
);
comment on table am_data_source is
  'One row per (table, import). Append-only log of where the master data came from.';

create index if not exists am_data_source_latest_idx
  on am_data_source (table_name, loaded_at desc);

-- Most recent import per table — what the Data sources screen reads.
create or replace view am_data_source_current with (security_invoker = true) as
select distinct on (table_name)
       table_name, source_file, source_kind, rows_loaded, loaded_at, loaded_by, note
from   am_data_source
order  by table_name, loaded_at desc;

alter table am_data_source enable row level security;
-- Policies live in 17_auth.sql with every other table's, so that re-running
-- this file can never put back the old open-to-anyone policies. The log stays
-- append-only: 17 grants select + insert, never update or delete.
grant select, insert on am_data_source to authenticated;
grant select on am_data_source_current to authenticated;
grant usage, select on sequence am_data_source_id_seq to authenticated;

-- Record what the SQL seed files themselves loaded, so a fresh install does
-- not show "never loaded" for data that is plainly there.
insert into am_data_source (table_name, source_file, source_kind, rows_loaded, loaded_by, note)
select v.t, v.f, 'sql-seed', v.n, 'sql/ALL_IN_ONE.sql',
       'Initial load from the generated seed files'
from (values
  ('am_org',            '4. department-template-file.xlsx',       (select count(*)::int from am_org)),
  ('am_category_group', '3. category-template-file.xlsx',         (select count(*)::int from am_category_group)),
  ('am_category',       '3. category-template-file.xlsx',         (select count(*)::int from am_category)),
  ('am_unit',           '10. unit-template-file.xlsx',            (select count(*)::int from am_unit)),
  ('am_origin',         '9. origin-country-template-file.xlsx',   (select count(*)::int from am_origin)),
  ('am_location',       '6. location-template-file.xlsx',         (select count(*)::int from am_location)),
  ('am_product',        '8. product-catalogue-template-file.xlsx',(select count(*)::int from am_product))
) as v(t, f, n)
where not exists (select 1 from am_data_source d where d.table_name = v.t);
