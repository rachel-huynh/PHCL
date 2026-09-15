-- =====================================================================
-- asset-intake — Seed vị trí (HỆ MÃ DÀI, theo lựa chọn của user 2026-09-15)
-- Nguồn: dòng "Bộ phận:" trong các file
--   ...\ASSET COUNT\Kiểm kê 07.2025\bien-ban-kiem-ke-{FIN,ADM,SMD}.xlsx
--   ...\ASSET COUNT\BBKK-FIN, SMD, ADM.xlsx
-- Cây suy ra từ chính mã: S -> S<tầng>00 / SB<hầm>00 -> phòng.
-- SINH TỰ ĐỘNG - đừng sửa tay, sửa scripts/genloc.ps1 rồi chạy lại.
-- Chạy SAU 02_seed_master.sql (cần am_org đã có).
-- =====================================================================

insert into am_location (code, name, kind, parent_code, dept_code, is_dept_office) values
  ('S', 'Sofitel Saigon Plaza Building / Toà nhà Sofitel Saigon Plaza', 'building', null, null, false),
  ('S0100', 'The 1st floor/ Lầu 01', 'floor', 'S', null, false),
  ('S0101B0', 'Banquet store', 'room', 'S0100', null, false),
  ('S0103B0', 'It office', 'room', 'S0100', 'ITD', true),
  ('S0104B0', 'Director of Operation office', 'room', 'S0100', null, false),
  ('S0105B0', 'Back office', 'room', 'S0100', null, false),
  ('S0107B0', 'Bakery shop', 'room', 'S0100', null, false),
  ('S0109P0', 'Boudoir bar', 'room', 'S0100', null, false),
  ('S0111B0', 'Kitchen office', 'room', 'S0100', 'KIT', true),
  ('S0112B0', 'Banquet kitchen', 'room', 'S0100', null, false),
  ('S0113B0', 'Pastry kitchen', 'room', 'S0100', null, false),
  ('S0200', 'The 2nd floor/ Lầu 02', 'floor', 'S', null, false),
  ('S0202B1', 'Bistro kitchen', 'room', 'S0200', null, false),
  ('S0203B2', 'Mezz hot kitchen', 'room', 'S0200', null, false),
  ('S0203P0', 'Mezz restaurant', 'room', 'S0200', null, false),
  ('S0300', 'The 3rd floor/ Lầu 03', 'floor', 'S', null, false),
  ('S0301B0', 'GM office', 'room', 'S0300', null, false),
  ('S0302B0', 'Sale office', 'room', 'S0300', 'SMD', true),
  ('S0303P1', 'Business center', 'room', 'S0300', null, false),
  ('S0304G0', 'Turquoise', 'room', 'S0300', null, false),
  ('S0307G0', 'Emerald', 'room', 'S0300', null, false),
  ('S0312P4', 'Female locker fitness', 'room', 'S0300', null, false),
  ('S0313B2', 'Fitness store', 'room', 'S0300', null, false),
  ('S0400', 'The 4th floor/ Lầu 04', 'floor', 'S', null, false),
  ('S0500', 'The 5th floor/ Lầu 05', 'floor', 'S', null, false),
  ('S0600', 'The 6th floor/ Lầu 06', 'floor', 'S', null, false),
  ('S0700', 'The 7th floor/ Lầu 07', 'floor', 'S', null, false),
  ('S0800', 'The 8th floor/ Lầu 08', 'floor', 'S', null, false),
  ('S0900', 'The 9th floor/ Lầu 09', 'floor', 'S', null, false),
  ('S1000', 'The 10th floor/ Lầu 10', 'floor', 'S', null, false),
  ('S1100', 'Lầu 11th floor/ Lầu 11', 'floor', 'S', null, false),
  ('S1200', 'The 12th floor/ Lầu 12', 'floor', 'S', null, false),
  ('S1400', 'The 14th floor/ Lầu 14', 'floor', 'S', null, false),
  ('S1500', 'The 15th floor/ Lầu 15', 'floor', 'S', null, false),
  ('S1600', 'The 16th floor/ Lầu 16', 'floor', 'S', null, false),
  ('S1700', 'The 17th floor/ Lầu 17', 'floor', 'S', null, false),
  ('S1800', 'The 18th floor/ Lầu 18', 'floor', 'S', null, false),
  ('S1809B0', 'Club kitchen', 'room', 'S1800', null, false),
  ('S1809P0', 'Club lounge', 'room', 'S1800', null, false),
  ('S1812', 'Pool bar', 'room', 'S1800', null, false),
  ('S1900', 'The 19th floor/ Lầu 19', 'floor', 'S', null, false),
  ('S1903G0', 'Room 1903', 'room', 'S1900', null, false),
  ('S1905G0', 'Room 1905', 'room', 'S1900', null, false),
  ('S1907G0', 'Room 1907', 'room', 'S1900', null, false),
  ('S1909G0', 'Room 1909', 'room', 'S1900', null, false),
  ('S1912G0', 'Room 1912', 'room', 'S1900', null, false),
  ('S1914G0', 'Room 1914', 'room', 'S1900', null, false),
  ('S1916G0', 'Room 1916', 'room', 'S1900', null, false),
  ('S1918G0', 'Room 1918', 'room', 'S1900', null, false),
  ('S2000', 'The 20th floor/ Lầu 20', 'floor', 'S', null, false),
  ('S2000E3', 'SMATV room / Single Master Antenna Television', 'room', 'S2000', null, false),
  ('S2003G0', 'Room 2003', 'room', 'S2000', null, false),
  ('S2005G0', 'Room 2005', 'room', 'S2000', null, false),
  ('S2006G0', 'Room 2006', 'room', 'S2000', null, false),
  ('S2015G0', 'Room 2015', 'room', 'S2000', null, false),
  ('S203', 'Le 17 Bistro restaurant', 'area', 'S', null, false),
  ('SB100', 'Basement 1/ Tầng hầm 1', 'floor', 'S', null, false),
  ('SB107P0', 'Casual labour locker', 'room', 'SB100', null, false),
  ('SB109B0', 'Reservation office', 'room', 'SB100', null, false),
  ('SB110B0', 'Dail 2 office', 'room', 'SB100', null, false),
  ('SB111B0', 'Cashier office', 'room', 'SB100', null, false),
  ('SB112E0', 'PABX room', 'room', 'SB100', null, false),
  ('SB113E0', 'MDF room', 'room', 'SB100', null, false),
  ('SB115B0', 'Laundry area', 'room', 'SB100', null, false),
  ('SB117B0', 'Housekeeping office', 'room', 'SB100', 'HKD', true),
  ('SB120B0', 'Finance office', 'room', 'SB100', 'FIN', true),
  ('SB121', 'HR office', 'room', 'SB100', 'ADM', true),
  ('SB121B0', 'Receiving office', 'room', 'SB100', null, false),
  ('SB122B0', 'Rreceiving area', 'room', 'SB100', null, false),
  ('SB123E0', 'CCTV room', 'room', 'SB100', null, false),
  ('SB124B0', 'Security office', 'room', 'SB100', 'SEC', true),
  ('SB130B0', 'Empty Bottle Store', 'room', 'SB100', null, false),
  ('SB131B0', 'General Store', 'room', 'SB100', null, false),
  ('SB134B1', 'Canteen kitchen', 'room', 'SB100', null, false),
  ('SB134B2', 'Canteen Store', 'room', 'SB100', null, false),
  ('SB134P0', 'Canteen area', 'room', 'SB100', null, false),
  ('SB138B0', 'Doctor room', 'room', 'SB100', null, false),
  ('SB139B0', 'Engineering Building workshop', 'room', 'SB100', null, false),
  ('SB140B0', 'LPG store', 'room', 'SB100', null, false),
  ('SB141B0', 'Engineering workshop', 'room', 'SB100', 'ENG', true),
  ('SB142B0', 'F&B office', 'room', 'SB100', 'FBD', true),
  ('SB143B0', 'Male locker B1', 'room', 'SB100', null, false)
on conflict (code) do update
  set name = excluded.name, kind = excluded.kind, parent_code = excluded.parent_code;

-- Mã không theo quy luật -> gắn tạm vào toà nhà, cần xác nhận:
--   S203   "Le 17 Bistro restaurant"  (nhiều khả năng là S0203, trùng tầng với
--          S0203P0 "Mezz restaurant")
--   SB121  "HR office" vs SB121B0 "Receiving office" — cùng số phòng, khác hậu tố
-- Phòng ban FOD chưa có office mặc định: danh sách vị trí không có "Front office".