-- =====================================================================
-- 38_project_offline_avatar.sql — HỒ SƠ DỰ ÁN LÀM NGOÀI HỆ THỐNG + ẢNH ĐẠI DIỆN TỪ LINK (28/09/2026)
--
-- Chạy SAU 37_eng_checklist.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE trên live.
--
-- 1. Dự án cũ không làm lại các biểu mẫu (PR / PA / QC / PO / AH…) trên hệ thống
--    (user 28/09/2026): người có quyền sửa dự án đánh dấu "hồ sơ đã hoàn tất
--    ngoài hệ thống" (một dự án hoặc nhiều dự án một lúc), kèm ghi chú (vd "hồ sơ
--    giấy lưu tại phòng Thu mua"). Cột "Bước hiện tại" ghi Hoàn tất (ngoài hệ
--    thống); màn hồ sơ không mời lập biểu mẫu nữa. Bỏ đánh dấu được.
-- 2. Ảnh đại diện hàng loạt (Nạp dữ liệu → Ảnh đại diện): ảnh tải lên đi đường
--    thường (bucket am-photo); link ảnh trong file Excel mà trình duyệt không tải
--    về được thì lưu dạng LINK — nay link cũng làm được ảnh đại diện.
--
-- Chỉ đụng vào bảng / hàm am_ / pm_ của app này; cuối file gọi app_lock_anon().
-- =====================================================================

alter table pm_project add column if not exists wf_offline      boolean not null default false;
alter table pm_project add column if not exists wf_offline_note text;
alter table pm_project add column if not exists wf_offline_by   text;
alter table pm_project add column if not exists wf_offline_at   timestamptz;
comment on column pm_project.wf_offline is 'Hồ sơ (PR / PA / QC / PO / AH…) đã hoàn tất NGOÀI hệ thống — dự án cũ không làm lại biểu mẫu trong app.';

-- Đánh dấu / bỏ đánh dấu nhiều dự án; p_complete: đồng thời chuyển trạng thái dự án sang "Hoàn thành".
create or replace function pm_project_wf_offline(p_codes text[], p_on boolean, p_note text default null, p_complete boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform app_require('project', 'edit');
  update pm_project set
    wf_offline      = p_on,
    wf_offline_note = case when p_on then nullif(trim(p_note), '') end,
    wf_offline_by   = case when p_on then am_me_name() end,
    wf_offline_at   = case when p_on then now() end,
    -- status là cột tính từ các mốc ngày; người dùng chốt tay qua status_override.
    status_override = case when p_on and p_complete then 'completed' else status_override end
  where code = any (p_codes)
    and ((select app_scope_root()) or dept_code in (select app_scope_orgs()));
  get diagnostics n = row_count;
  return n;
end $$;

-- Ảnh đại diện: ảnh trong app (storage) như cũ; ảnh LINK chỉ khi đúng loại "avatar" (từ nạp hàng loạt).
create or replace function am_photo_avatar_auto()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.asset_id is null then return new; end if;
  if new.kind = 'avatar' then
    update am_asset set avatar_photo_id = new.id where id = new.asset_id;
  elsif new.source = 'storage' and new.kind in ('overall', 'count') then
    update am_asset set avatar_photo_id = new.id where id = new.asset_id and avatar_photo_id is null;
  end if;
  return new;
end $$;

create or replace function am_asset_set_avatar(p_asset bigint, p_photo bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (app_can('assets', 'edit') or exists (select 1 from am_asset a where a.id = p_asset and am_in_scope(a.dept_code) and app_can('assets', 'view'))) then
    raise exception 'Không có quyền đổi ảnh đại diện của tài sản này.' using errcode = '42501';
  end if;
  if p_photo is not null and not exists (select 1 from am_asset_photo where id = p_photo and asset_id = p_asset
                                         and (source = 'storage' or kind = 'avatar')) then
    raise exception 'Ảnh không thuộc tài sản này.';
  end if;
  update am_asset set avatar_photo_id = p_photo where id = p_asset;
end $$;

revoke execute on function pm_project_wf_offline(text[], boolean, text, boolean) from public, anon;
grant execute on function pm_project_wf_offline(text[], boolean, text, boolean), am_asset_set_avatar(bigint, bigint) to authenticated;

select app_lock_anon();

select 'Cột hồ sơ ngoài hệ thống (pm_project.wf_offline…)' as "Mục", count(*)::text as "Thực tế", '4' as "Mong đợi",
       case when count(*) = 4 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.columns
where  table_schema = 'public' and table_name = 'pm_project' and column_name in ('wf_offline', 'wf_offline_note', 'wf_offline_by', 'wf_offline_at')
union all
select 'Hàm đánh dấu hồ sơ ngoài hệ thống', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_project_wf_offline'
union all
select 'Dự án đang đánh dấu hoàn tất ngoài hệ thống', count(*)::text, '—', '—' from pm_project where wf_offline;
