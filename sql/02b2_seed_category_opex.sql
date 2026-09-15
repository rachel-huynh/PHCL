-- =====================================================================
-- PHCL Asset Intake — OPEX group O4000 (operating supplies & equipment)
--
-- HAND-MAINTAINED. This group is NOT in "3. category-template-file.xlsx",
-- so scripts/genseed.ps1 cannot produce it — but 853 live assets in the
-- Beetrack register already use it (SOF.O4000.OBA.2019.00001 and so on).
-- Without these rows those assets cannot be loaded: am_asset.group_code and
-- am_asset.category_code are both foreign keys.
--
-- Evidence from "Danh sach tai san (up to Sep 15 - Beetrack).xlsx":
--   853 rows, all department SOF, all "Cung Barcode" (one shared barcode for
--   the whole batch), all unit pcs, quantities up to 5,581 per row, and the
--   accounting-code column empty on every single one — which is why these are
--   OPEX rather than CAPEX.
--
-- ⚠️ WHY THE do $$ ... execute ... $$ BLOCKS BELOW
-- When several statements are submitted together, PostgreSQL resolves column
-- names while it parses — before the earlier ALTER has run. So a plain
-- "insert ... (expense_class)" in this same file fails with
--   ERROR 42703: column "expense_class" does not exist
-- even though the ALTER sits right above it. Putting those statements inside
-- execute '...' defers parsing to run time, after the column exists.
-- Do not "simplify" them back into plain statements.
--
-- Run after 02b_seed_category.sql. Safe to re-run.
-- =====================================================================

-- Tell CAPEX groups apart from OPEX ones. A fresh install already has the
-- column from 01_schema.sql; an existing database gets it here.
alter table am_category_group
  add column if not exists expense_class text not null default 'CAPEX';

do $$
begin
  execute 'alter table am_category_group drop constraint if exists am_category_group_class_ck';
  execute 'alter table am_category_group add constraint am_category_group_class_ck '
       || 'check (expense_class in (''CAPEX'', ''OPEX''))';
  execute 'comment on column am_category_group.expense_class is '
       || '''CAPEX = the C2xxx accounting groups. OPEX = operating supplies (O4000), '
       || 'which carry no accounting code.''';
  -- Everything generated from the Beetrack category template is CAPEX: the
  -- source workbook lists all of them under its "CAPEX:" heading.
  execute 'update am_category_group set expense_class = ''CAPEX'' where code like ''C2%''';
end $$;

-- Inserted without expense_class so this statement parses on a database that
-- has not run the ALTER yet; the value is set in the do-block that follows.
insert into am_category_group (code, name_vi, name_en, is_intangible, is_tools, sort_order)
values ('O4000', 'Đồ dùng vận hành khách sạn',
        'Operating supplies & equipment (OS&E)', false, false, 90)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en,
      sort_order = excluded.sort_order;

do $$
begin
  execute 'update am_category_group set expense_class = ''OPEX'' where code = ''O4000''';
end $$;

-- All eight are managed by quantity and share one barcode per batch
-- ("Cung Barcode" in Beetrack), the same handling as the -QR codes.
insert into am_category (code, group_code, name_vi, name_en, label_letters,
                         manage_by, note) values
  ('OBA', 'O4000', 'Đồ dùng quầy bar',          'Bar equipment',       'OBA', 'quantity', null),
  ('OCN', 'O4000', 'Đồ gốm, sứ',                'Chinaware',           'OCN', 'quantity', null),
  ('OES', 'O4000', 'Công cụ, dụng cụ kỹ thuật', 'Engineering tools',   'OES', 'quantity', null),
  ('OFL', 'O4000', 'Đồ dùng ăn uống',           'Flatware & cutlery',  'OFL', 'quantity', null),
  ('OGL', 'O4000', 'Đồ thủy tinh',              'Glassware',           'OGL', 'quantity', null),
  ('OKU', 'O4000', 'Dụng cụ làm bếp',           'Kitchen utensils',    'OKU', 'quantity', null),
  ('OLI', 'O4000', 'Hàng vải',                  'Linen',               'OLI', 'quantity', null),
  ('OPS', 'O4000', 'Công cụ vận hành',          'Operating equipment', 'OPS', 'quantity', null)
on conflict (code) do update
  set group_code = excluded.group_code, name_vi = excluded.name_vi,
      name_en = excluded.name_en, label_letters = excluded.label_letters,
      manage_by = excluded.manage_by;
