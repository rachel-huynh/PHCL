-- =====================================================================
-- asset-intake — KIỂM CHỨNG sau khi chạy 01 → 02 → 02b → 02c → 03 → 04
--
-- Supabase SQL Editor không hiện gì khi chạy lệnh DDL (CREATE TABLE không
-- trả về dòng nào), và đôi khi panel Results báo "Failed to get project's
-- logs" — đó là lỗi của dashboard, KHÔNG phải lỗi SQL.
-- Chạy file này để biết chắc thứ gì đã được tạo.
-- =====================================================================

-- 1) Tổng quan: phải ra 22 bảng và 14 hàm
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name like 'am\_%')        as so_bang,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'am\_%')            as so_ham,
  (select count(*) from pg_policies where schemaname = 'public'
    and tablename like 'am\_%')                                      as so_policy;

-- 2) Danh sách bảng + số dòng thực tế
select c.relname as bang, c.reltuples::bigint as uoc_so_dong,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policies,
       c.relrowsecurity as rls_bat
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relkind = 'r' and c.relname like 'am\_%'
order  by c.relname;

-- 3) Danh sách hàm
select p.proname as ham, pg_get_function_identity_arguments(p.oid) as tham_so,
       case p.prosecdef when true then 'SECURITY DEFINER' else '' end as quyen
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and p.proname like 'am\_%'
order  by p.proname;

-- 4) Master data đã nạp đủ chưa (số kỳ vọng ghi ở cột mong_doi)
select 'am_org' as bang, count(*) as thuc_te, 14 as mong_doi from am_org
union all select 'am_org_alias',      count(*),   5 from am_org_alias
union all select 'am_category_group', count(*),  15 from am_category_group
union all select 'am_category',       count(*),  27 from am_category
union all select 'am_unit',           count(*),  15 from am_unit
union all select 'am_origin',         count(*), 249 from am_origin
union all select 'am_origin_alias',   count(*),  55 from am_origin_alias
union all select 'am_location',       count(*),  82 from am_location
union all select 'am_setting',        count(*),   4 from am_setting
union all select 'am_barcode_seq',    count(*),   2 from am_barcode_seq
order by 1;

-- 5) Thử nhanh các quy tắc — không ghi gì vào database
select 'CCDC 35tr, hữu hình' as tinh_huong, * from am_classify(35000000, 'LTU', false)
union all
select 'CCDC 35tr, vô hình',              * from am_classify(35000000, 'LTU', true)
union all
select 'Thiết bị 6tr',                    * from am_classify(6000000,  'ITO', false)
union all
select 'Vật dụng 2tr',                    * from am_classify(2000000,  'LTG', false);

select 'Malaysia' as goc, * from am_resolve_origin('Malaysia')
union all select 'USA',                    * from am_resolve_origin('USA')
union all select 'USA/Mexico/China/Singapore', * from am_resolve_origin('USA/Mexico/China/Singapore')
union all select 'Asia',                   * from am_resolve_origin('Asia');

-- 6) Bỏ hậu tố -QR: LTG-QR và LTG PHẢI cùng ra chữ 'LTG'
select code, label_letters, group_code, manage_by
from   am_category
where  code in ('LTG', 'LTG-QR', 'STG', 'STG-QR')
order  by label_letters, code;

-- 7) Ghép mã thử (không cấp số thật)
select am_build_asset_code('FBD', 'C2422', am_letters('LTG-QR'), 2026, 309) as ma_thu,
       am_format_barcode('unique', 6871) as ma_vach_unique,
       am_format_barcode('low', 1)       as ma_vach_low;
