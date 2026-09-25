-- =====================================================================
-- 24_ui_feedback.sql — THAY ĐỔI THEO GÓP Ý GIAO DIỆN VÀ FORM (25/09/2026)
--
-- Chạy SAU 23_pm_pkg_merge.sql. Chạy lại nhiều lần vô hại.
--
--   1. Nhà cung cấp: thêm cột e-mail.
--   2. Dự án NGOÀI ngân sách: đổi mã bộ phận / số dự án / năm ngay trên PR thì
--      mã dự án đổi theo (FFE.KIT.05.2026 → FFE.ENG.07.2026), số hiệu mọi
--      chứng từ của dự án cũng đổi theo (PR.KIT.05.2026 → PR.ENG.07.2026).
--      Chỉ khi chưa có chứng từ nào gửi duyệt.
--   3. Công tắc (Cài đặt, người sửa được cấu hình hệ thống): hiện hay ẩn mục
--      Lịch sử ở màn hình chứng từ.
--
-- Chỉ đụng tới bảng được nêu tên ở dưới — project Supabase dùng chung với các
-- app khác, không quét bảng theo mẫu tên.
-- =====================================================================

-- 1. ------------------------------------------------------------------
alter table pm_vendor add column if not exists email text;
comment on column pm_vendor.email is 'E-mail liên hệ của nhà cung cấp.';

-- 2. ------------------------------------------------------------------
/* Đổi mã một dự án ngoài ngân sách. Mã mới = đoạn đầu cũ (FFE) . bộ phận .
   số (2 chữ số) . năm [. đoạn con cũ nếu có]. Các bảng tham chiếu mã dự án bằng
   khoá ngoại (chứng từ, bộ hồ sơ, điểm nhà thầu, phân bổ thanh toán) đổi theo
   nhờ ON UPDATE CASCADE; số hiệu chứng từ và thông báo được sửa ở đây. */
create or replace function pm_project_recode(p_code text, p_dept text, p_no int, p_year int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p     pm_project;
  v_seg text[];
  v_new text;
  v_mid text;
  v_tail_old text;
  v_tail_new text;
begin
  select * into p from pm_project where code = p_code for update;
  if p.code is null then raise exception 'Không có dự án %.', p_code; end if;
  if p.budgeted then
    raise exception 'Chỉ đổi mã được với dự án ngoài ngân sách — mã dự án trong ngân sách theo file ngân sách.';
  end if;
  if not (app_trusted() or app_can('project', 'admin') or pm_can_prepare('PR', p.dept_code)) then
    raise exception 'Bạn không có quyền đổi mã dự án %.', p.code using errcode = '42501';
  end if;
  if exists (select 1 from pm_doc where project_code = p.code and status not in ('draft', 'returned', 'cancelled')) then
    raise exception 'Dự án % đã có chứng từ gửi duyệt — không đổi mã được nữa.', p.code;
  end if;
  if not exists (select 1 from am_org where code = upper(trim(p_dept)) and is_department) then
    raise exception 'Không có bộ phận %.', p_dept;
  end if;
  if p_no is null or p_no < 1 or p_no > 999 then raise exception 'Số dự án không hợp lệ.'; end if;
  if p_year is null or p_year < 2000 or p_year > 2099 then raise exception 'Năm không hợp lệ.'; end if;

  v_seg := string_to_array(p.code, '.');
  v_mid := v_seg[1] || '.' || upper(trim(p_dept)) || '.' || lpad(p_no::text, 2, '0') || '.' || p_year;
  v_new := v_mid || coalesce('.' || v_seg[5], '');
  if v_new = p.code then return v_new; end if;
  if exists (select 1 from pm_project where code = v_new) then
    raise exception 'Mã % đã có dự án khác dùng.', v_new;
  end if;

  update pm_project
     set code = v_new,
         main_code = case when main_code = p.code or array_length(v_seg, 1) = 4 then v_mid else main_code end,
         dept_code = upper(trim(p_dept)), year = p_year
   where code = p.code;

  -- Số hiệu chứng từ: tiền tố loại + phần sau đoạn đầu của mã dự án (+ "/n" nếu có).
  v_tail_old := substring(p.code from position('.' in p.code));
  v_tail_new := substring(v_new from position('.' in v_new));
  update pm_doc
     set doc_no = replace(doc_no, v_tail_old, v_tail_new), updated_at = now()
   where project_code = v_new;
  update pm_notice
     set doc_no = replace(doc_no, v_tail_old, v_tail_new), project_code = v_new
   where project_code = p.code;
  return v_new;
end $$;

revoke all on function pm_project_recode(text, text, int, int) from public;
grant execute on function pm_project_recode(text, text, int, int) to authenticated;

-- 3. ------------------------------------------------------------------
insert into am_setting (key, value, note) values
  ('pm_show_history', 'true', 'true = màn hình chứng từ hiện mục Lịch sử dưới form; false = ẩn.')
on conflict (key) do nothing;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- KIỂM CHỨNG
-- =====================================================================

select 'Cột e-mail của nhà cung cấp' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.columns
where  table_schema = 'public' and table_name = 'pm_vendor' and column_name = 'email'
union all
select 'Hàm đổi mã dự án ngoài ngân sách', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_project_recode'
union all
select 'Công tắc Lịch sử (pm_show_history)', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   am_setting where key = 'pm_show_history'
union all
select 'Khách (anon) gọi được hàm đổi mã (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_project_recode' and has_function_privilege('anon', oid, 'execute');
