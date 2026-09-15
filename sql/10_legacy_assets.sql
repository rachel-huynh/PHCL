-- =====================================================================
-- PHCL Asset Intake — make room for the legacy Beetrack register
--
-- The 17,036 rows already in Beetrack do not all match the rules this app
-- enforces on NEW assets. That is historical fact, not a data error, so the
-- constraints get an explicit exemption instead of being dropped:
--
--   barcode   10 different formats are in use, not just "JVC.":
--             JVC.######### 13,349 · GR##.##### 1,347 · SOF.######### 853 ·
--             SB###.##### 762 · S###.##### 580 · RT##.##### 96 ·
--             SSP.##### 36 · 14 plain digits 3 · SOFlXR6 / SOFmGD3 1 each.
--   asset_code 5 rows carry a SIX digit sequence (CEN.C2422.LTU.2024.000168),
--             one has a note appended, one cell holds only a number.
--   qty       "Cung Barcode" rows hold the whole batch on one line, up to
--             5,581 pieces, so the one-row-per-unit rule cannot apply.
--
-- is_legacy = true means "imported as it stands from Beetrack; the format
-- rules were not applied". Everything the app issues itself stays false and
-- is still checked in full, so a new asset can never get a stray barcode.
--
-- ⚠️ The constraints are rebuilt inside do $$ ... execute ... $$ because a
-- plain ALTER referencing is_legacy would be parsed before the ADD COLUMN in
-- this same file had run, and fail with 42703.
--
-- Run after 01_schema.sql. Safe to re-run.
-- =====================================================================

alter table am_asset
  add column if not exists is_legacy boolean not null default false;

do $$
begin
  execute 'comment on column am_asset.is_legacy is '
       || '''Imported verbatim from the Beetrack register. Exempt from the '
       || 'barcode / asset-code / quantity format rules, which only bind the '
       || 'codes this app issues itself.''';

  -- Barcode: the app's two ranges, or anything at all on a legacy row.
  execute 'alter table am_asset drop constraint if exists am_asset_barcode_ck';
  execute $c$alter table am_asset add constraint am_asset_barcode_ck check (
      is_legacy
      or (asset_kind = 'unique' and barcode ~ '^JVC\.[0-8][0-9]{8}$')
      or (asset_kind = 'low'    and barcode ~ '^JVC\.9[0-9]{8}$'))$c$;

  -- Asset code must still be rebuildable from its parts -- unless legacy.
  execute 'alter table am_asset drop constraint if exists am_asset_code_ck';
  execute $c$alter table am_asset add constraint am_asset_code_ck check (
      is_legacy
      or asset_code = dept_code || '.' || group_code || '.' || letters || '.'
                      || purchase_year::text || '.' || lpad(seq::text, 5, '0'))$c$;

  -- One row per unit for unique assets -- unless legacy.
  execute 'alter table am_asset drop constraint if exists am_asset_unique_qty_ck';
  execute $c$alter table am_asset add constraint am_asset_unique_qty_ck check (
      is_legacy or asset_kind <> 'unique' or qty = 1)$c$;
end $$;

-- Legacy rows are read-only history: never hand out a code that reuses one.
create index if not exists am_asset_legacy_idx on am_asset (is_legacy);

-- How the import should split the register's "Loai Tai San" column:
--   'Barcode duy nhat' -> asset_kind = 'unique'  (one barcode per unit)
--   'Cung Barcode'     -> asset_kind = 'low'     (one barcode for the batch)
