-- =====================================================================
-- PHCL Asset Intake -- seed the counters from the Beetrack asset register
-- Source: "Danh sach tai san (up to Sep 15 - Beetrack).xlsx", 17,036 rows.
--
-- Keyed on (department, letters) only. In that register 11 keys appear
-- under SEVERAL parent groups -- HKD|FUR alone spans C2111, C2112, C2113
-- and C2422 -- so keying on the group as well would hand out duplicate
-- asset codes.
--
-- am_seed_asset_seq only ever RAISES a counter, so re-running is harmless.
-- Run after 03_functions.sql. Re-run whenever a newer register export arrives.
-- =====================================================================

select v.dept, v.letters, v.max_seen,
       am_seed_asset_seq(v.dept, v.letters, v.max_seen) as next_seq
from (values
  ('ADM', 'FUR', 507),
  ('ADM', 'ITM', 1),
  ('ADM', 'KME', 2),
  ('ADM', 'LTG', 49),
  ('ADM', 'LTU', 464),
  ('ADM', 'MES', 1),
  ('ADM', 'OIA', 3),
  ('ADM', 'OME', 47),
  ('CEN', 'BUL', 1),
  ('CEN', 'INF', 2),
  ('CEN', 'LTG', 1337),
  ('CEN', 'LTU', 238),
  ('CEN', 'MES', 3),
  ('CEN', 'OIA', 23),
  ('CEN', 'OTA', 91),
  ('CEN', 'STR', 11),
  ('ENG', 'FFP', 383),
  ('ENG', 'FUR', 458),
  ('ENG', 'ITM', 5),
  ('ENG', 'ITO', 679),
  ('ENG', 'KME', 3),
  ('ENG', 'LTG', 849),
  ('ENG', 'LTU', 1277),
  ('ENG', 'MES', 857),
  ('ENG', 'OIA', 21),
  ('ENG', 'OME', 10),
  ('ENG', 'SME', 237),
  ('ENG', 'STR', 13),
  ('FBD', 'FUR', 614),
  ('FBD', 'ITO', 238),
  ('FBD', 'KME', 219),
  ('FBD', 'LTG', 4),
  ('FBD', 'LTU', 481),
  ('FBD', 'MES', 18),
  ('FBD', 'OME', 592),
  ('FIN', 'CTP', 4),
  ('FIN', 'FFP', 2),
  ('FIN', 'FUR', 299),
  ('FIN', 'ITM', 1),
  ('FIN', 'ITO', 505),
  ('FIN', 'LTG', 281),
  ('FIN', 'LTU', 447),
  ('FIN', 'MES', 120),
  ('FIN', 'OIA', 5),
  ('FIN', 'OME', 59),
  ('FIN', 'STR', 1),
  ('FOD', 'FUR', 6024),
  ('FOD', 'ITO', 1),
  ('FOD', 'KME', 41),
  ('FOD', 'LTU', 6010),
  ('FOD', 'MES', 2),
  ('FOD', 'OME', 1005),
  ('HKD', 'FUR', 4210),
  ('HKD', 'ITO', 947),
  ('HKD', 'KME', 78),
  ('HKD', 'LTG', 844),
  ('HKD', 'LTU', 2268),
  ('HKD', 'MES', 320),
  ('HKD', 'OME', 68),
  ('HKD', 'SME', 613),
  ('ITD', 'CTP', 3),
  ('ITD', 'ITO', 30),
  ('ITD', 'LTG', 171),
  ('ITD', 'LTU', 328),
  ('ITD', 'MES', 2),
  ('ITD', 'STG', 8),
  ('JVC', 'CTP', 1),
  ('JVC', 'INF', 19),
  ('JVC', 'ITO', 54),
  ('JVC', 'LTG', 44),
  ('JVC', 'LTU', 102),
  ('JVC', 'OIA', 7),
  ('JVC', 'OME', 4),
  ('JVC', 'OTA', 10),
  ('JVC', 'STR', 3),
  ('KIT', 'FUR', 349),
  ('KIT', 'ITO', 197),
  ('KIT', 'KME', 1551),
  ('KIT', 'LTU', 633),
  ('KIT', 'OME', 3001),
  ('KIT', 'SME', 23),
  ('SMD', 'FUR', 21),
  ('SMD', 'ITO', 1),
  ('SMD', 'OME', 39),
  ('SOF', 'OBA', 77),
  ('SOF', 'OCN', 172),
  ('SOF', 'OES', 109),
  ('SOF', 'OFL', 115),
  ('SOF', 'OGL', 141),
  ('SOF', 'OKU', 127),
  ('SOF', 'OLI', 76),
  ('SOF', 'OPS', 36)
) as v(dept, letters, max_seen)
order by v.dept, v.letters;

select am_seed_barcode('unique', 105076) as next_unique,
       am_seed_barcode('low',    2213)    as next_low;

-- Check: every gap must be >= 0.
select * from am_audit_counters() where gap < 0;
