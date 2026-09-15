-- =====================================================================
-- PHCL Asset Intake — thresholds and counter initialisation
-- Hand-maintained. The master-data files 02a..02f are generated from the
-- Beetrack templates by scripts/genseed.ps1.
-- Run after 01_schema.sql. Safe to re-run.
-- =====================================================================

insert into am_setting (key, value, note) values
  ('unique_threshold', '5000000',
   'Unit price >= this => Unique asset: one row per unit, quantity always 1'),
  ('capex_threshold',  '30000000',
   'Unit price > this => a tools & supplies (CCDC) category code is not allowed'),
  ('default_company',  '"SOF"',
   'Default member company on new assets. Real asset rows use SOF for the hotel and CEN for Central Plaza.'),
  ('barcode_prefix',   '"JVC."', 'Barcode prefix')
on conflict (key) do update
  set value = excluded.value, note = excluded.note, updated_at = now();

-- Two separate barcode ranges:
--   unique : 'JVC.'  + 9 digits, first digit 0-8
--   low    : 'JVC.9' + 8 digits (next_val is the part AFTER the 9)
insert into am_barcode_seq (kind, next_val, max_val) values
  ('unique', 1, 899999999),
  ('low',    1, 99999999)
on conflict (kind) do nothing;

insert into am_alr_seq (singleton, next_val) values (true, 1)
on conflict (singleton) do nothing;
