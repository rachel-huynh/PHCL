-- =====================================================================
-- 22_admin_tools.sql — CÔNG CỤ QUẢN TRỊ CHO GIAI ĐOẠN THỬ NGHIỆM
--
-- Chạy SAU 21_pm_payment.sql. Chạy lại nhiều lần vô hại.
--
--   Khu quyền mới "override" (Quyền quản trị dữ liệu) trong ma trận quyền:
--     Xem   = mở màn hình Công cụ quản trị
--     Sửa   = sửa MỌI nội dung: chứng từ ở bất kỳ trạng thái nào (đã gửi, đã
--             duyệt, bị từ chối), mở lại chứng từ thành nháp. Mỗi lần sửa ghi
--             vào lịch sử chứng từ và nhật ký thay đổi.
--     Quản trị = ĐẶT LẠI (xoá) dữ liệu thử theo từng nhóm.
--   System Admin có đủ ba quyền.
--
--   Vai trò mới CONTENT_EDITOR "Người sửa nội dung": gán cho người cụ thể ở
--   Người dùng → vai trò. Có quyền Xem + Sửa ở khu override và Xem + Sửa ở
--   các khu dữ liệu (tài sản, danh mục, ngân sách, dự án, thanh toán) — nhưng
--   KHÔNG đặt lại dữ liệu, KHÔNG duyệt, KHÔNG phân quyền.
--
-- Project Supabase DÙNG CHUNG với các app khác: hàm đặt lại chỉ đụng tới các
-- bảng am_/pm_/app_audit liệt kê tên ở dưới — không bao giờ quét theo mẫu tên.
-- Sổ tài sản cũ nạp từ Beetrack (is_legacy) và mọi danh mục KHÔNG bị xoá.
-- =====================================================================


-- =====================================================================
-- 1. KHU QUYỀN + VAI TRÒ
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('override', 'Admin override (edit any content, reset test data)', 'Quyền quản trị dữ liệu (sửa mọi nội dung, đặt lại dữ liệu thử)', 100)
on conflict (code) do update
  set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('CONTENT_EDITOR', 'SYS', 'Content editor', 'Người sửa nội dung', false, 'PHCL', 990)
on conflict (code) do update
  set name_en = excluded.name_en, name_vi = excluded.name_vi, default_scope = excluded.default_scope, sort = excluded.sort;

-- System Admin: mọi quyền trên khu mới. "do nothing": quyền đã chỉnh trong app giữ nguyên.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
values ('SYS_ADMIN', 'override', true, true, true, true, true)
on conflict (role_code, module_code) do nothing;

-- Người sửa nội dung: xem + sửa, không tạo / xoá / duyệt / quản trị.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'CONTENT_EDITOR', m, true, false, true, false, false
from   unnest(array['override', 'assets', 'master', 'budget', 'project', 'payment']) m
on conflict (role_code, module_code) do nothing;
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'CONTENT_EDITOR', m, true, false, false, false, false
from   unnest(array['approval', 'report']) m
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 2. SỬA CHỨNG TỪ Ở MỌI TRẠNG THÁI
-- =====================================================================

/* Lưu nội dung chứng từ bất kể trạng thái (trừ đã huỷ). Không đổi trạng thái,
   bước duyệt hay chữ ký — chỉ nội dung. Ghi "admin_edit" vào lịch sử; bảng
   pm_doc có trigger nhật ký nên bản trước / sau cũng được giữ. */
create or replace function pm_doc_admin_save(p_id bigint, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc;
begin
  perform app_require('override', 'edit');
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ % / No document %', p_id, p_id; end if;
  if d.status = 'cancelled' then
    raise exception 'Chứng từ % đã huỷ. / Document % is cancelled.', d.doc_no, d.doc_no;
  end if;
  update pm_doc
     set data = coalesce(p_data, '{}'::jsonb),
         total_value = nullif(p_data ->> 'total', '')::numeric,
         updated_at = now()
   where id = p_id;
  perform pm_doc_log(p_id, 'admin_edit', d.status, d.status, d.current_step, null);
end $$;

/* Mở lại chứng từ thành nháp: xoá chuỗi duyệt của lần gửi này, để người lập
   sửa và gửi lại. Các mốc đã đẩy sang dự án khi duyệt xong KHÔNG tự lùi lại. */
create or replace function pm_doc_admin_reopen(p_id bigint, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc;
begin
  perform app_require('override', 'edit');
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ % / No document %', p_id, p_id; end if;
  if d.status in ('draft', 'cancelled') then
    raise exception 'Chứng từ % đang "%" — không cần mở lại. / Document % is "%".', d.doc_no, d.status, d.doc_no, d.status;
  end if;
  delete from pm_doc_step where doc_id = p_id;
  update pm_doc set status = 'draft', current_step = null, decided_at = null, updated_at = now() where id = p_id;
  perform pm_doc_log(p_id, 'admin_reopen', d.status, 'draft', null, p_comment);
end $$;


-- =====================================================================
-- 3. ĐẶT LẠI DỮ LIỆU THỬ
-- =====================================================================

/* p_groups: những nhóm cần xoá —
     docs        chứng từ mua sắm + chuỗi duyệt + lịch sử + thông báo của chúng
     payments    hoá đơn, thanh toán, phân bổ, lịch sử nạp file kế toán
     projects    dự án (kéo theo chứng từ, điểm nhà thầu, phân bổ thanh toán)
     budget      các vòng ngân sách và dòng ngân sách (giữ thiết lập năm: tỷ giá, trần)
     vendors     danh sách nhà cung cấp
     notices     thông báo (chuông)
     signatures  chữ ký mẫu đã lưu
     assets      tài sản nhập qua app (KHÔNG xoá sổ cũ Beetrack), đợt hàng,
                 biên bản tem nhãn; bộ đếm mã kéo về ngang sổ còn lại
     audit       nhật ký thay đổi (làm cuối cùng)
   p_dry = true: chỉ đếm, không xoá — màn hình dùng để xem trước. */
create or replace function app_reset_data(p_groups text[], p_dry boolean default true)
returns table (grp text, tbl text, n bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  g  text;
  c  bigint;
  ok text[] := array['docs', 'payments', 'projects', 'budget', 'vendors', 'notices', 'signatures', 'assets', 'audit'];
begin
  perform app_require('override', 'admin');
  if exists (select 1 from unnest(p_groups) x where x <> all(ok)) then
    raise exception 'Nhóm không hợp lệ: % / Unknown group', array_to_string(p_groups, ', ');
  end if;

  -- Đếm (và xoá khi p_dry = false), theo thứ tự khoá ngoại cho phép.
  foreach g in array ok loop
    continue when not (g = any(p_groups));
    if g = 'docs' then
      select count(*) into c from pm_doc;               grp := g; tbl := 'pm_doc'; n := c; return next;
      if not p_dry then delete from pm_doc; end if;      -- bước duyệt, lịch sử, thông báo đi theo (on delete cascade)
    elsif g = 'payments' then
      select count(*) into c from pm_pay_alloc;         grp := g; tbl := 'pm_pay_alloc'; n := c; return next;
      select count(*) into c from pm_invoice;           grp := g; tbl := 'pm_invoice'; n := c; return next;
      select count(*) into c from pm_payment;           grp := g; tbl := 'pm_payment'; n := c; return next;
      select count(*) into c from pm_pay_import;        grp := g; tbl := 'pm_pay_import'; n := c; return next;
      if not p_dry then
        delete from pm_pay_alloc; delete from pm_invoice; delete from pm_payment; delete from pm_pay_import;
      end if;
    elsif g = 'projects' then
      select count(*) into c from pm_project;           grp := g; tbl := 'pm_project'; n := c; return next;
      select count(*) into c from pm_vendor_score;      grp := g; tbl := 'pm_vendor_score'; n := c; return next;
      if not p_dry then delete from pm_vendor_score; delete from pm_pay_alloc; delete from pm_doc; delete from pm_project; end if;
    elsif g = 'budget' then
      select count(*) into c from pm_budget_line;       grp := g; tbl := 'pm_budget_line'; n := c; return next;
      select count(*) into c from pm_budget_round;      grp := g; tbl := 'pm_budget_round'; n := c; return next;
      if not p_dry then delete from pm_budget_line; delete from pm_budget_round; end if;
    elsif g = 'vendors' then
      select count(*) into c from pm_vendor;            grp := g; tbl := 'pm_vendor'; n := c; return next;
      if not p_dry then delete from pm_vendor; end if;
    elsif g = 'notices' then
      select count(*) into c from pm_notice;            grp := g; tbl := 'pm_notice'; n := c; return next;
      if not p_dry then delete from pm_notice; end if;
    elsif g = 'signatures' then
      select count(*) into c from pm_signature;         grp := g; tbl := 'pm_signature'; n := c; return next;
      if not p_dry then delete from pm_signature; end if;
    elsif g = 'assets' then
      select count(*) into c from am_asset where not is_legacy; grp := g; tbl := 'am_asset'; n := c; return next;
      select count(*) into c from am_shipment;          grp := g; tbl := 'am_shipment'; n := c; return next;
      select count(*) into c from am_alr;               grp := g; tbl := 'am_alr'; n := c; return next;
      if not p_dry then
        delete from am_alr_line; delete from am_alr;
        update am_asset set shipment_id = null where is_legacy and shipment_id is not null;
        delete from am_asset where not is_legacy;
        delete from am_shipment;                           -- dòng đợt hàng đi theo (on delete cascade)
        perform am_reseed_counters(true);                  -- bộ đếm về ngang sổ còn lại
      end if;
    elsif g = 'audit' then
      select count(*) into c from app_audit;            grp := g; tbl := 'app_audit'; n := c; return next;
      if not p_dry then delete from app_audit; end if;
    end if;
  end loop;
end $$;


-- =====================================================================
-- 4. QUYỀN GỌI HÀM — mỗi hàm tự kiểm tra quyền ở dòng đầu
-- =====================================================================

revoke execute on function pm_doc_admin_save(bigint, jsonb), pm_doc_admin_reopen(bigint, text),
                           app_reset_data(text[], boolean)
  from public, anon;
grant execute on function pm_doc_admin_save(bigint, jsonb), pm_doc_admin_reopen(bigint, text),
                          app_reset_data(text[], boolean)
  to authenticated;
-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 5. KIỂM CHỨNG
-- =====================================================================

select 'Khu quyền override' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   app_module where code = 'override'
union all
select 'System Admin có quyền đặt lại', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   app_permission where role_code = 'SYS_ADMIN' and module_code = 'override' and can_admin
union all
select 'Vai trò Người sửa nội dung', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   app_role where code = 'CONTENT_EDITOR'
union all
select 'Người sửa nội dung KHÔNG đặt lại được (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   app_permission where role_code = 'CONTENT_EDITOR' and module_code = 'override' and can_admin
union all
select 'Khách (anon) gọi được hàm quản trị (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('app_reset_data', 'pm_doc_admin_save', 'pm_doc_admin_reopen')
  and  has_function_privilege('anon', oid, 'execute');
