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
-- Run after 02b_seed_category.sql. Safe to re-run.
-- =====================================================================

-- Tell CAPEX groups apart from OPEX ones. Older databases get the column
-- added here; a fresh install already has it from 01_schema.sql.
alter table am_category_group
  add column if not exists expense_class text not null default 'CAPEX';

alter table am_category_group drop constraint if exists am_category_group_class_ck;
alter table am_category_group add constraint am_category_group_class_ck
  check (expense_class in ('CAPEX', 'OPEX'));

comment on column am_category_group.expense_class is
  'CAPEX = the C2xxx accounting groups. OPEX = operating supplies (O4000), which carry no accounting code.';

-- Everything generated from the Beetrack category template is CAPEX; the
-- source workbook lists all of them under its "CAPEX:" heading.
update am_category_group set expense_class = 'CAPEX' where code like 'C2%';

insert into am_category_group (code, name_vi, name_en, is_intangible, is_tools,
                               expense_class, sort_order) values
  ('O4000', 'Đồ dùng vận hành khách sạn', 'Operating supplies & equipment (OS&E)',
   false, false, 'OPEX', 90)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en,
      expense_class = excluded.expense_class, sort_order = excluded.sort_order;

-- All eight are managed by quantity and share one barcode per batch
-- ("Cung Barcode" in Beetrack), the same handling as the -QR codes.
insert into am_category (code, group_code, name_vi, name_en, label_letters,
                         manage_by, note) values
  ('OBA', 'O4000', 'Đồ dùng quầy bar',            'Bar equipment',        'OBA', 'quantity', null),
  ('OCN', 'O4000', 'Đồ gốm, sứ',                  'Chinaware',            'OCN', 'quantity', null),
  ('OES', 'O4000', 'Công cụ, dụng cụ kỹ thuật',   'Engineering tools',    'OES', 'quantity', null),
  ('OFL', 'O4000', 'Đồ dùng ăn uống',             'Flatware & cutlery',   'OFL', 'quantity', null),
  ('OGL', 'O4000', 'Đồ thủy tinh',                'Glassware',            'OGL', 'quantity', null),
  ('OKU', 'O4000', 'Dụng cụ làm bếp',             'Kitchen utensils',     'OKU', 'quantity', null),
  ('OLI', 'O4000', 'Hàng vải',                    'Linen',                'OLI', 'quantity', null),
  ('OPS', 'O4000', 'Công cụ vận hành',            'Operating equipment',  'OPS', 'quantity', null)
on conflict (code) do update
  set group_code = excluded.group_code, name_vi = excluded.name_vi,
      name_en = excluded.name_en, label_letters = excluded.label_letters,
      manage_by = excluded.manage_by;
