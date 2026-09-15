-- =====================================================================
-- asset-intake — Nạp Master Data gốc
-- Nguồn: "Asset code.xlsx" và sheet "3. Asset Code" / "4. Org Code"
--        trong "Asset Template File - Beetrack.xlsx"
-- Chạy SAU 01_schema.sql. Chạy lại nhiều lần được (idempotent).
-- Các điểm dữ liệu gốc mâu thuẫn: xem docs/data-issues.md
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Cấu hình
-- ---------------------------------------------------------------------
insert into am_setting (key, value, note) values
  ('unique_threshold', '5000000',  'Đơn giá >= mức này -> Unique asset, mỗi đơn vị 1 dòng, Số Lượng = 1'),
  ('capex_threshold',  '30000000', 'Đơn giá > mức này -> không được gán mã danh mục CCDC'),
  ('default_company',  '"SOF"',    'Mã Công Ty Thành Viên mặc định'),
  ('barcode_prefix',   '"JVC."',   'Tiền tố mã vạch')
on conflict (key) do update
  set value = excluded.value, note = excluded.note, updated_at = now();

-- ---------------------------------------------------------------------
-- 1. Mã đơn vị quản lý
--    JVC / CEN / SOF vừa là công ty thành viên, vừa xuất hiện ở vị trí #1
--    của Mã Tài Sản (bằng chứng thật: CEN.C2112.MES.2024.00001)
--    => is_company = true VÀ is_department = true.
-- ---------------------------------------------------------------------
insert into am_org (code, name_vi, name_en, level, is_company, is_department, parent_code, note) values
  ('PHCL', 'Công ty TNHH Liên Doanh Khách Sạn Plaza', 'Plaza Hotel Ltd.', 'TCT',    true,  false, null,   null),
  ('JVC',  'Văn phòng đại diện chủ đầu tư',           'JVC Office',       'BRANCH', true,  true,  'PHCL', 'Dùng được ở vị trí #1 của Mã Tài Sản'),
  ('CEN',  'Cao ốc văn phòng Central Plaza',          'Central Plaza',    'BRANCH', true,  true,  'PHCL', 'Dùng được ở vị trí #1 của Mã Tài Sản'),
  ('SOF',  'Khách sạn Sofitel SG Plaza',              'Sofitel Saigon Plaza', 'BRANCH', true, true, 'PHCL', 'Dùng được ở vị trí #1 của Mã Tài Sản'),
  ('FOD',  'Bộ phận tiền sảnh',              'Front Office Department',    'DEPT1', false, true, 'SOF', null),
  ('HKD',  'Bộ phận quản gia',               'House Keeping Department',   'DEPT1', false, true, 'SOF', 'Beetrack ghi là HKP — xem am_org_alias'),
  ('FBD',  'Bộ phận F&B',                    'Food & Beverage Department', 'DEPT1', false, true, 'SOF', null),
  ('KIT',  'Bộ phận bếp',                    'Kitchen Department',         'DEPT1', false, true, 'SOF', null),
  ('ENG',  'Bộ phận kỹ thuật',               'Engineering Department',     'DEPT1', false, true, 'SOF', null),
  ('ADM',  'Bộ phận hành chính, nhân sự',    'Administration & Human Resource Department', 'DEPT1', false, true, 'SOF', null),
  ('SMD',  'Bộ phận quảng cáo, bán hàng',    'Sale & Marketing Department', 'DEPT1', false, true, 'SOF', null),
  ('FIN',  'Bộ phận tài chính, kế toán',     'Finance Department',          'DEPT1', false, true, 'SOF', null),
  ('ITD',  'Bộ phận IT',                     'IT Department',               'DEPT2', false, true, 'FIN', 'Beetrack ghi là IT — xem am_org_alias'),
  ('SEC',  'Bộ phận an ninh',                'Security Department',         'DEPT2', false, true, 'ADM', null)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en, level = excluded.level,
      is_company = excluded.is_company, is_department = excluded.is_department,
      parent_code = excluded.parent_code, note = excluded.note;

insert into am_org_alias (alias, code, source) values
  ('HKP',      'HKD', 'Beetrack "4. Org Code" / "1. Area Code" / KiemKe-HKP'),
  ('IT',       'ITD', 'Beetrack "4. Org Code" / KiemKe-IT'),
  ('Security', 'SEC', 'Beetrack "1. Area Code"'),
  ('S&M',      'SMD', 'KiemKe-S&M'),
  ('A&G',      'ADM', 'KiemKe-A&G (Administration & General)')
on conflict (alias) do update set code = excluded.code, source = excluded.source;

-- ---------------------------------------------------------------------
-- 2. Nhóm tài sản (mã cha kế toán)
-- ---------------------------------------------------------------------
insert into am_category_group (code, name_vi, name_en, is_intangible, is_tools, sort_order) values
  ('C2111', 'Nhà cửa, vật kiến trúc',                         'Buildings and structures',                     false, false, 10),
  ('C2112', 'Máy móc và thiết bị',                            'Machinery and equipment',                      false, false, 20),
  ('C2113', 'Trang thiết bị và phương tiện vận tải',          'Transportation and transmission vehicles',     false, false, 30),
  ('C2114', 'Thiết bị, công cụ quản lý',                      'Office equipment, management tools',           false, false, 40),
  ('C2115', 'Cây lâu năm, súc vật làm việc và cho sản phẩm',  'Perennial trees, working and producing animals', false, false, 50),
  ('C2118', 'Tài sản cố định hữu hình khác',                  'Other tangible asset',                         false, false, 60),
  ('C2131', 'Quyền sử dụng đất',                              'Land use rights',                              true,  false, 70),
  ('C2132', 'Quyền phát hành',                                'Copyrights',                                   true,  false, 71),
  ('C2133', 'Bản quyền, quyền phát hành, bằng sáng chế',      'Patent',                                       true,  false, 72),
  ('C2134', 'Nhãn hiệu độc quyền, tên thương mại, quyền SHTT','Trademarks, trade names',                      true,  false, 73),
  ('C2135', 'Chương trình, phần mềm',                         'Computer software',                            true,  false, 74),
  ('C2136', 'Giấy phép và giấy phép nhượng quyền',            'License and right concession permits',         true,  false, 75),
  ('C2138', 'Tài sản cố định vô hình khác',                   'Other intangible asset',                       true,  false, 76),
  ('C2421', 'Thiết bị, CCDC ngắn hạn (không đủ đk ghi nhận TSCĐ)', 'Short-term tools & supplies',             false, true,  80),
  ('C2422', 'Thiết bị, CCDC dài hạn (không đủ đk ghi nhận TSCĐ)',  'Long-term tools & supplies',              false, true,  81)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en,
      is_intangible = excluded.is_intangible, is_tools = excluded.is_tools,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- 3. Mã loại tài sản (mã con 3 ký tự, + biến thể -QR)
--    label_letters = code sau khi bỏ '-QR'  (ràng buộc CHECK tự kiểm tra)
-- ---------------------------------------------------------------------
insert into am_category (code, group_code, name_vi, name_en, label_letters, manage_by, note) values
  ('BUL',    'C2111', 'Tòa nhà',                        'Building',                          'BUL', 'code', null),
  ('STR',    'C2111', 'Công trình, kiến trúc khác',     'Other structure',                   'STR', 'code', null),
  ('INF',    'C2111', 'Cơ sở hạ tầng kỹ thuật',         'Infrastructure, constructual item', 'INF', 'code', null),
  ('MES',    'C2112', 'Hệ thống điện và cơ khí',        'Mechanical & Electrical Systems',   'MES', 'code', null),
  ('FFP',    'C2112', 'Thiết bị, hệ thống PCCC',        'Fire Fighting & Prevention Equipment/System', 'FFP', 'code', null),
  ('ITO',    'C2112', 'Thiết bị CNTT dùng cho kinh doanh', 'IT Equipment for operation',      'ITO', 'code', null),
  ('KME',    'C2112', 'Thiết bị, vật dụng bếp',         'Kitchen Machinery & Equipment',     'KME', 'code', null),
  ('FUR',    'C2112', 'Thiết bị, vật dụng nội thất',    'Furniture, artworks',               'FUR', 'code', null),
  ('SME',    'C2112', 'Máy móc, thiết bị vệ sinh',      'Sanitary Machinery & Equipment',    'SME', 'code', null),
  -- File gốc liệt kê OME ở CẢ C2112 lẫn C2114. Mã con là khóa chính nên chỉ
  -- được một mã cha; user chốt 2026-09-15 giữ đúng mã OME của file gốc và
  -- chọn C2112, khớp với TOÀN BỘ Mã Tài Sản thật quét được
  -- (ADM.C2112.OME, FIN.C2112.OME, SMD.C2112.OME — không có cái nào C2114).
  ('OME',    'C2112', 'Máy móc, thiết bị khác',         'Other Machinery & Equipment',       'OME', 'code',
             'File gốc liệt kê OME ở cả C2112 và C2114; đã chốt C2112 theo dữ liệu thật. Nhóm C2114 vì vậy chỉ còn ITM.'),
  ('TTV',    'C2113', 'Trang thiết bị và phương tiện vận tải', 'Transportation and transmission vehicles', 'TTV', 'code', null),
  ('ITM',    'C2114', 'Thiết bị CNTT dùng cho quản trị', 'IT Equipment for management',       'ITM', 'code', null),
  ('PWP',    'C2115', 'Cây lâu năm, súc vật làm việc và cho sản phẩm', 'Perennial trees, working and producing animals', 'PWP', 'code', null),
  ('OTA',    'C2118', 'Tài sản cố định hữu hình khác',  'Other tangible asset',              'OTA', 'code', null),
  ('LUR',    'C2131', 'Quyền sử dụng đất',              'Land use rights',                   'LUR', 'code', null),
  ('CPR',    'C2132', 'Quyền phát hành',                'Copyrights',                        'CPR', 'code', null),
  ('PAT',    'C2133', 'Bản quyền, bằng sáng chế',       'Patent',                            'PAT', 'code', null),
  ('TMK',    'C2134', 'Nhãn hiệu độc quyền, tên thương mại', 'Trademarks, trade names',      'TMK', 'code', null),
  ('CTP',    'C2135', 'Chương trình, phần mềm',         'Computer software',                 'CTP', 'code',
             'Đích chuyển đổi cho tài sản VÔ HÌNH có đơn giá > 30 triệu.'),
  ('LRP',    'C2136', 'Giấy phép và giấy phép nhượng quyền', 'License and right concession permits', 'LRP', 'code', null),
  ('OIA',    'C2138', 'Tài sản cố định vô hình khác',   'Other intangible asset',            'OIA', 'code', null),
  ('STU',    'C2421', 'CCDC ngắn hạn - quản lý theo mã',      'Short-term tools, managed by code',     'STU', 'code',     null),
  ('STG',    'C2421', 'CCDC ngắn hạn - quản lý theo số lượng','Short-term tools, managed by quantity', 'STG', 'quantity', null),
  ('STG-QR', 'C2421', 'CCDC ngắn hạn - theo số lượng, dán QR','Short-term tools, by quantity, QR label','STG', 'quantity',
             'Mã Tài Sản hiển thị CHỮ "STG" (bỏ -QR) nên DÙNG CHUNG dãy số với STG.'),
  ('LTU',    'C2422', 'CCDC dài hạn - quản lý theo mã',       'Long-term tools, managed by code',      'LTU', 'code',     null),
  ('LTG',    'C2422', 'CCDC dài hạn - quản lý theo số lượng', 'Long-term tools, managed by quantity',  'LTG', 'quantity', null),
  ('LTG-QR', 'C2422', 'CCDC dài hạn - theo số lượng, dán QR', 'Long-term tools, by quantity, QR label','LTG', 'quantity',
             'Mã Tài Sản hiển thị CHỮ "LTG" (bỏ -QR) nên DÙNG CHUNG dãy số với LTG.')
on conflict (code) do update
  set group_code = excluded.group_code, name_vi = excluded.name_vi, name_en = excluded.name_en,
      label_letters = excluded.label_letters, manage_by = excluded.manage_by, note = excluded.note;

-- ---------------------------------------------------------------------
-- 4. Đơn vị tính
-- ---------------------------------------------------------------------
insert into am_unit (code, name_vi, name_en, sort_order) values
  ('pcs',     'cái',       'piece',   10),
  ('set',     'bộ',        'set',     20),
  ('box',     'hộp',       'box',     30),
  ('package', 'gói/kiện',  'package', 40),
  ('kg',      'kilôgam',   'kilogram',50),
  ('m',       'mét',       'metre',   60),
  ('m2',      'mét vuông', 'square metre', 70),
  ('m3',      'mét khối',  'cubic metre',  80),
  ('litre',   'lít',       'litre',   90),
  ('kwh',     'kWh',       'kilowatt hour', 100),
  ('time',    'lần',       'time',    110),
  ('room',    'phòng',     'room',    120),
  ('floor',   'tầng',      'floor',   130),
  ('pot',     'chậu',      'pot',     140),
  ('tubes',   'tuýp',      'tube',    150)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- 5. Khởi tạo bộ đếm mã vạch (chưa có số nào -> bắt đầu từ 1)
--    Nạp số thật từ register bằng am_seed_from_codes() sau khi import.
-- ---------------------------------------------------------------------
insert into am_barcode_seq (kind, next_val, max_val) values
  ('unique', 1, 899999999),
  ('low',    1, 99999999)
on conflict (kind) do nothing;

insert into am_alr_seq (singleton, next_val) values (true, 1)
on conflict (singleton) do nothing;
