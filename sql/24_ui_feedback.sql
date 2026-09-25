-- =====================================================================
-- 24_ui_feedback.sql — THAY ĐỔI THEO GÓP Ý GIAO DIỆN (25/09/2026)
--
-- Chạy SAU 23_pm_pkg_merge.sql. Chạy lại nhiều lần vô hại.
--
--   Nhà cung cấp: thêm cột e-mail.
--
-- Chỉ đụng tới bảng được nêu tên ở dưới — project Supabase dùng chung với các
-- app khác, không quét bảng theo mẫu tên.
-- =====================================================================

alter table pm_vendor add column if not exists email text;
comment on column pm_vendor.email is 'E-mail liên hệ của nhà cung cấp.';

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- KIỂM CHỨNG
-- =====================================================================

select 'Cột e-mail của nhà cung cấp' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.columns
where  table_schema = 'public' and table_name = 'pm_vendor' and column_name = 'email';
