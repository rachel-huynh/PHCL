-- =====================================================================
-- asset-intake — KIỂM CHỨNG sau khi chạy ALL_IN_ONE.sql
--
-- ⚠️ Supabase SQL Editor CHỈ hiện kết quả của câu lệnh CUỐI CÙNG.
--    Vì vậy toàn bộ phép kiểm gộp trong MỘT câu select — dán cả file,
--    bấm Run, đọc cột "dat": ✔ là đạt, ✘ là hỏng.
--
-- Không lệnh nào ghi vào database.
-- =====================================================================

with chk(ord, nhom, muc, thuc_te, mong_doi, dat) as (

  -- ---------------- 1. Cấu trúc ----------------
  -- 23 = 22 bảng của 01_schema + am_data_source (07). am_data_source_current
  -- là view nên không nằm trong pg_tables.
  select 1, 'Cấu trúc', 'Số bảng am_*',
         (select count(*) from pg_tables
           where schemaname = 'public' and tablename like 'am\_%')::text,
         '23',
         (select count(*) from pg_tables
           where schemaname = 'public' and tablename like 'am\_%') = 23

  union all select 2, 'Cấu trúc', 'Số hàm am_*',
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'am\_%')::text,
         '15',
         (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'am\_%') = 15

  union all select 3, 'Cấu trúc', 'View am_alr_print (file 05)',
         (select count(*) from information_schema.views
           where table_schema = 'public' and table_name = 'am_alr_print')::text,
         '1',
         (select count(*) from information_schema.views
           where table_schema = 'public' and table_name = 'am_alr_print') = 1

  union all select 4, 'Cấu trúc', 'Số policy RLS am_*',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename like 'am\_%')::text,
         '>= 20',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename like 'am\_%') >= 20

  union all select 5, 'Cấu trúc', 'RLS đã bật trên am_asset',
         (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'am_asset')::text,
         'true',
         (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'am_asset')

  union all select 6, 'Cấu trúc', 'am_asset KHÔNG có policy DELETE',
         (select count(*) from pg_policies where schemaname = 'public'
           and tablename = 'am_asset' and cmd = 'DELETE')::text,
         '0',
         (select count(*) from pg_policies where schemaname = 'public'
           and tablename = 'am_asset' and cmd = 'DELETE') = 0

  -- ---------------- 2. Master data ----------------
  -- Ngưỡng TỐI THIỂU, không phải con số chính xác: master data sửa thêm được
  -- trong giao diện, nên đòi bằng đúng số seed sẽ báo hỏng giả mỗi lần chị
  -- thêm một dòng. Ngưỡng tối thiểu vẫn bắt được lỗi thật là "seed chưa chạy".
  union all select 11, 'Master data', 'am_org (đơn vị/phòng ban)',
         (select count(*) from am_org)::text, '>= 15', (select count(*) from am_org) >= 15
  union all select 12, 'Master data', 'am_org_alias',
         (select count(*) from am_org_alias)::text, '>= 5',
         (select count(*) from am_org_alias) >= 5
  union all select 13, 'Master data', 'am_category_group (mã cha)',
         (select count(*) from am_category_group)::text, '>= 16',
         (select count(*) from am_category_group) >= 16
  union all select 14, 'Master data', 'am_category (mã loại)',
         (select count(*) from am_category)::text, '>= 36',
         (select count(*) from am_category) >= 36
  union all select 15, 'Master data', 'am_unit',
         (select count(*) from am_unit)::text, '>= 16', (select count(*) from am_unit) >= 16
  union all select 16, 'Master data', 'am_origin (ISO 3166-1)',
         (select count(*) from am_origin)::text, '>= 240',
         (select count(*) from am_origin) >= 240
  union all select 17, 'Master data', 'am_origin_alias',
         (select count(*) from am_origin_alias)::text, '>= 50',
         (select count(*) from am_origin_alias) >= 50
  union all select 18, 'Master data', 'am_location (cả 2 toà nhà)',
         (select count(*) from am_location)::text, '>= 675',
         (select count(*) from am_location) >= 675
  union all select 19, 'Master data', 'am_location có office mặc định',
         (select count(*) from am_location where is_dept_office)::text, '>= 9',
         (select count(*) from am_location where is_dept_office) >= 9
  union all select 20, 'Master data', 'am_product (catalogue)',
         (select count(*) from am_product)::text, '>= 420',
         (select count(*) from am_product) >= 420
  union all select 21, 'Master data', 'am_setting (ngưỡng giá)',
         (select count(*) from am_setting)::text, '>= 4', (select count(*) from am_setting) >= 4
  union all select 22, 'Master data', 'am_barcode_seq (2 dải)',
         (select count(*) from am_barcode_seq)::text, '2',
         (select count(*) from am_barcode_seq) = 2
  union all select 23, 'Master data', 'OME thuộc C2112',
         coalesce((select group_code from am_category where code = 'OME'), '(thiếu)'), 'C2112',
         (select group_code from am_category where code = 'OME') = 'C2112'
  union all select 24, 'Master data', 'OEM thuộc C2114 (mã riêng, KHÔNG phải OME)',
         coalesce((select group_code from am_category where code = 'OEM'), '(thiếu)'), 'C2114',
         (select group_code from am_category where code = 'OEM') = 'C2114'
  -- expense_class is read through to_jsonb(g) on purpose. A direct reference
  -- would make this whole file fail to parse on a database that has not had
  -- 02b2 run yet, instead of simply reporting the check as failed.
  union all select 28, 'Master data', 'Nhóm OPEX O4000 + 8 mã con',
         (select count(*) from am_category where group_code = 'O4000')::text
           || ' mã con, expense_class='
           || coalesce((select to_jsonb(g) ->> 'expense_class' from am_category_group g
                         where g.code = 'O4000'), '(chưa chạy 02b2)'),
         '8 mã con, expense_class=OPEX',
         (select count(*) from am_category where group_code = 'O4000') = 8
         and coalesce((select to_jsonb(g) ->> 'expense_class' from am_category_group g
                        where g.code = 'O4000'), '') = 'OPEX'
  union all select 25, 'Master data', 'Cây vị trí: toà nhà CP và SOF',
         (select count(*) from am_location where kind = 'building')::text, '2',
         (select count(*) from am_location where kind = 'building') = 2
  union all select 26, 'Master data', 'Vị trí mồ côi (cha không tồn tại)',
         (select count(*) from am_location l
           where l.parent_code is not null
             and not exists (select 1 from am_location p where p.code = l.parent_code))::text,
         '0',
         (select count(*) from am_location l
           where l.parent_code is not null
             and not exists (select 1 from am_location p where p.code = l.parent_code)) = 0
  union all select 27, 'Master data', 'Sản phẩm có mã danh mục không tồn tại',
         (select count(*) from am_product p
           where p.default_category is not null
             and not exists (select 1 from am_category c where c.code = p.default_category))::text,
         '0',
         (select count(*) from am_product p
           where p.default_category is not null
             and not exists (select 1 from am_category c where c.code = p.default_category)) = 0

  -- ---------------- 3. Quy tắc bỏ hậu tố -QR ----------------
  union all select 31, 'Quy tắc -QR', 'am_letters(''LTG-QR'')',
         am_letters('LTG-QR'), 'LTG', am_letters('LTG-QR') = 'LTG'
  union all select 32, 'Quy tắc -QR', 'LTG và LTG-QR cùng chữ hiển thị',
         (select string_agg(distinct label_letters, ',') from am_category
           where code in ('LTG', 'LTG-QR')), 'LTG',
         (select count(distinct label_letters) from am_category
           where code in ('LTG', 'LTG-QR')) = 1
  union all select 33, 'Quy tắc -QR', 'STG và STG-QR cùng chữ hiển thị',
         (select string_agg(distinct label_letters, ',') from am_category
           where code in ('STG', 'STG-QR')), 'STG',
         (select count(distinct label_letters) from am_category
           where code in ('STG', 'STG-QR')) = 1

  -- ---------------- 4. Ghép mã ----------------
  union all select 41, 'Ghép mã', 'Mã Tài Sản từ LTG-QR',
         am_build_asset_code('FBD', 'C2422', am_letters('LTG-QR'), 2026, 309),
         'FBD.C2422.LTG.2026.00309',
         am_build_asset_code('FBD', 'C2422', am_letters('LTG-QR'), 2026, 309)
           = 'FBD.C2422.LTG.2026.00309'
  union all select 42, 'Ghép mã', 'Mã Vạch dải unique',
         am_format_barcode('unique', 6871), 'JVC.000006871',
         am_format_barcode('unique', 6871) = 'JVC.000006871'
  union all select 43, 'Ghép mã', 'Mã Vạch dải low (bắt đầu bằng 9)',
         am_format_barcode('low', 1), 'JVC.900000001',
         am_format_barcode('low', 1) = 'JVC.900000001'
  union all select 44, 'Ghép mã', 'Số hiệu ALR từ mã dự án',
         am_alr_code_from_project('FFE.KIT.05.2025'), 'AL.KIT.05.2025',
         am_alr_code_from_project('FFE.KIT.05.2025') = 'AL.KIT.05.2025'

  -- ---------------- 5. Phân loại theo đơn giá ----------------
  union all select 51, 'Phân loại', 'Đơn giá 6tr -> Unique asset',
         (select asset_kind from am_classify(6000000, 'ITO', false)), 'unique',
         (select asset_kind from am_classify(6000000, 'ITO', false)) = 'unique'
  union all select 52, 'Phân loại', 'Đơn giá 2tr -> Low-value',
         (select asset_kind from am_classify(2000000, 'LTG', false)), 'low',
         (select asset_kind from am_classify(2000000, 'LTG', false)) = 'low'
  union all select 53, 'Phân loại', 'CCDC 35tr -> BỊ CHẶN',
         (select violates_capex from am_classify(35000000, 'LTU', false))::text, 'true',
         (select violates_capex from am_classify(35000000, 'LTU', false))
  union all select 54, 'Phân loại', 'CCDC 35tr vô hình -> đề xuất CTP',
         coalesce((select suggested_category from am_classify(35000000, 'LTU', true)), '(trống)'),
         'CTP',
         (select suggested_category from am_classify(35000000, 'LTU', true)) = 'CTP'
  union all select 55, 'Phân loại', 'CCDC 35tr hữu hình -> KHÔNG tự chọn mã',
         coalesce((select suggested_category from am_classify(35000000, 'LTU', false)), '(trống)'),
         '(trống)',
         (select suggested_category from am_classify(35000000, 'LTU', false)) is null

  -- ---------------- 6. Xuất xứ ----------------
  union all select 61, 'Xuất xứ', 'Malaysia',
         coalesce((select iso2 from am_resolve_origin('Malaysia')), '(trống)'), 'MY',
         (select iso2 from am_resolve_origin('Malaysia')) = 'MY'
  union all select 62, 'Xuất xứ', 'USA (qua bí danh)',
         coalesce((select iso2 from am_resolve_origin('USA')), '(trống)'), 'US',
         (select iso2 from am_resolve_origin('USA')) = 'US'
  union all select 63, 'Xuất xứ', 'Việt Nam (có dấu)',
         coalesce((select iso2 from am_resolve_origin('Việt Nam')), '(trống)'), 'VN',
         (select iso2 from am_resolve_origin('Việt Nam')) = 'VN'
  union all select 64, 'Xuất xứ', 'USA/Mexico/China/Singapore -> BỎ TRỐNG',
         coalesce((select iso2 from am_resolve_origin('USA/Mexico/China/Singapore')), '(trống)'),
         '(trống)',
         (select iso2 from am_resolve_origin('USA/Mexico/China/Singapore')) is null
  union all select 65, 'Xuất xứ', 'Asia -> BỎ TRỐNG',
         coalesce((select iso2 from am_resolve_origin('Asia')), '(trống)'), '(trống)',
         (select iso2 from am_resolve_origin('Asia')) is null

  -- ---------------- 7. Bộ đếm ----------------
  union all select 71, 'Bộ đếm', 'Khoá (phòng ban × chữ) đã nạp',
         (select count(*) from am_asset_seq)::text,
         '0 khi chưa nạp — phải > 0 TRƯỚC khi cấp mã thật', true
  union all select 72, 'Bộ đếm', 'Tài sản trong sổ',
         (select count(*) from am_asset)::text, '0 ở giai đoạn này', true
  union all select 73, 'Bộ đếm', 'Khoá có bộ đếm TỤT SAU sổ (phải = 0)',
         (select count(*) from am_audit_counters() where gap < 0)::text, '0',
         (select count(*) from am_audit_counters() where gap < 0) = 0

  -- ---------------- 8. Gợi ý danh mục (11_suggest.sql) ----------------
  union all select 81, 'Gợi ý', 'Hàm am_suggest_lines đã tạo',
         (select count(*) from pg_proc where proname = 'am_suggest_lines')::text, '1',
         (select count(*) from pg_proc where proname = 'am_suggest_lines') = 1
  union all select 82, 'Gợi ý', 'Index trên am_norm(name_vi)',
         (select count(*) from pg_indexes
           where tablename = 'am_asset' and indexname = 'am_asset_name_norm_ix')::text, '1',
         (select count(*) from pg_indexes
           where tablename = 'am_asset' and indexname = 'am_asset_name_norm_ix') = 1
  -- Thử trên một tên có thật trong sổ: phải ra danh mục kèm số dòng làm căn cứ.
  union all select 83, 'Gợi ý', 'Thử tra "Ghế" -> danh mục',
         coalesce((select category_code || ' (' || n || ' dòng)'
                     from am_suggest_lines(array['Ghế'])), '(không có)'),
         'ra một mã danh mục nếu sổ đã nạp',
         (select category_code from am_suggest_lines(array['Ghế'])) is not null
)
select nhom       as "Nhóm",
       muc        as "Mục kiểm tra",
       thuc_te    as "Thực tế",
       mong_doi   as "Mong đợi",
       case when dat then '✔' else '✘ HỎNG' end as "dat"
from   chk
order  by ord;
