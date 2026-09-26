-- =====================================================================
-- 35_vendor_photo_count.sql — NHÀ CUNG CẤP TỪ KẾ TOÁN · ẢNH ĐẠI DIỆN TÀI SẢN
--                               · KIỂM KÊ CÓ ẢNH VÀ THỐNG KÊ (27/09/2026)
--
-- Chạy SAU 34_contracts.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
--   1. pm_vendor nhận danh sách nhà cung cấp xuất từ phần mềm kế toán
--      ("Danh_sach_nha_cung_cap - <ngày>.xlsx": mã, tên, địa chỉ, MST, điện
--      thoại). Nhập theo MÃ; giữ nguyên e-mail, tên khác, ghi chú đã sửa trong app.
--      Bỏ ràng buộc MST duy nhất: kế toán có vài mã cùng MST (chi nhánh, công
--      đoàn dùng MST công ty) — vẫn giữ chỉ mục để khớp hoá đơn theo MST.
--   2. Ảnh đại diện tài sản: am_asset.avatar_photo_id. Tự đặt khi tài sản chưa
--      có ảnh đại diện và có ảnh toàn cảnh (biên bản tem / bàn giao), ảnh kiểm
--      kê hoặc ảnh tải lên làm đại diện. Mỗi ảnh trong app có thêm bản thu nhỏ
--      (thumb_path) để sổ tài sản hiện nhanh. Kích thước ảnh chỉnh ở am_setting
--      photo_max_px / photo_quality / photo_thumb_px.
--   3. Kiểm kê: ảnh chụp tại dòng kiểm (am_count_line.photo_id), nhóm / danh
--      mục của tài sản chép vào dòng khi mở đợt để thống kê theo vị trí, bộ
--      phận, danh mục; tiến độ xem trực tiếp trên app (tự làm mới).
--
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. NHÀ CUNG CẤP TỪ KẾ TOÁN
-- =====================================================================

alter table pm_vendor add column if not exists address       text;
alter table pm_vendor add column if not exists phone         text;
alter table pm_vendor add column if not exists acc_synced_at timestamptz;
comment on column pm_vendor.acc_synced_at is 'Lần cuối dòng này được cập nhật từ danh sách nhà cung cấp của kế toán.';

alter table pm_vendor drop constraint if exists pm_vendor_tax_code_key;
create index if not exists pm_vendor_tax_idx on pm_vendor (tax_code);

-- p_rows: [{code, name, address, tax_code, phone}] — nhiều lần, mỗi lần ≤ 500 dòng.
-- p_deactivate (chỉ dùng ở lần cuối, kèm p_all_codes): mã không còn trong file → active = false.
create or replace function pm_vendor_import(p_rows jsonb, p_all_codes text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_code text; v_old pm_vendor; na int := 0; nu int := 0; ns int := 0; nd int := 0;
begin
  if not (app_can('project', 'edit') or app_can('master', 'edit')) then
    raise exception 'Không có quyền sửa danh sách nhà cung cấp.' using errcode = '42501';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_code := upper(trim(r ->> 'code'));
    if coalesce(v_code, '') = '' or coalesce(trim(r ->> 'name'), '') = '' then ns := ns + 1; continue; end if;
    select * into v_old from pm_vendor where code = v_code;
    if not found then
      insert into pm_vendor (code, name, tax_code, address, phone, active, acc_synced_at)
      values (v_code, trim(r ->> 'name'), nullif(trim(r ->> 'tax_code'), ''), nullif(trim(r ->> 'address'), ''), nullif(trim(r ->> 'phone'), ''), true, now());
      na := na + 1;
    elsif v_old.name is distinct from trim(r ->> 'name') or v_old.tax_code is distinct from nullif(trim(r ->> 'tax_code'), '')
       or v_old.address is distinct from nullif(trim(r ->> 'address'), '') or v_old.phone is distinct from nullif(trim(r ->> 'phone'), '') or not v_old.active then
      update pm_vendor set name = trim(r ->> 'name'), tax_code = nullif(trim(r ->> 'tax_code'), ''), address = nullif(trim(r ->> 'address'), ''),
                           phone = nullif(trim(r ->> 'phone'), ''), active = true, acc_synced_at = now()
      where code = v_code;
      nu := nu + 1;
    else
      update pm_vendor set acc_synced_at = now() where code = v_code;
    end if;
  end loop;
  if p_all_codes is not null then
    update pm_vendor set active = false
    where active and acc_synced_at is not null and code <> all (select upper(trim(x)) from unnest(p_all_codes) x);
    get diagnostics nd = row_count;
  end if;
  return jsonb_build_object('added', na, 'updated', nu, 'skipped', ns, 'deactivated', nd);
end $$;


-- =====================================================================
-- 2. ẢNH: LOẠI MỚI, BẢN THU NHỎ, ẢNH ĐẠI DIỆN
-- =====================================================================

alter table am_asset_photo drop constraint if exists am_asset_photo_kind_check;
alter table am_asset_photo add constraint am_asset_photo_kind_check check (kind in ('label', 'overall', 'condition', 'count', 'avatar'));
alter table am_asset_photo add column if not exists thumb_path text;
alter table am_asset_photo add column if not exists count_line_id bigint;
comment on column am_asset_photo.thumb_path is 'Bản thu nhỏ (≈ 240 px) trong bucket am-photo, để sổ tài sản hiện ảnh nhanh.';

alter table am_asset add column if not exists avatar_photo_id bigint references am_asset_photo(id) on delete set null;
comment on column am_asset.avatar_photo_id is 'Ảnh đại diện của tài sản (hiện ở sổ tài sản). Tự đặt từ ảnh toàn cảnh / kiểm kê khi chưa có.';

insert into am_setting (key, value, note) values
  ('photo_max_px', '1600'::jsonb, 'Ảnh tài sản: cạnh dài tối đa (px) khi thu nhỏ trên máy trước khi tải lên (1000–2400)'),
  ('photo_quality', '0.82'::jsonb, 'Ảnh tài sản: chất lượng JPEG khi thu nhỏ (0.5–0.95)'),
  ('photo_thumb_px', '240'::jsonb, 'Ảnh tài sản: cạnh dài của bản thu nhỏ hiện ở sổ tài sản (120–480)')
on conflict (key) do nothing;

-- Ảnh mới của một tài sản chưa có ảnh đại diện → làm ảnh đại diện (ảnh toàn cảnh, kiểm kê, ảnh đại diện;
-- không lấy ảnh tem cận cảnh). Ảnh tải lên với kind "avatar" luôn thay ảnh đại diện hiện tại.
create or replace function am_photo_avatar_auto()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.asset_id is null or new.source <> 'storage' or new.kind not in ('overall', 'count', 'avatar') then return new; end if;
  update am_asset set avatar_photo_id = new.id
  where  id = new.asset_id and (avatar_photo_id is null or new.kind = 'avatar');
  return new;
end $$;
drop trigger if exists am_photo_avatar_auto on am_asset_photo;
create trigger am_photo_avatar_auto after insert on am_asset_photo for each row execute function am_photo_avatar_auto();

-- Chọn một ảnh đã có làm ảnh đại diện (hoặc bỏ: p_photo null).
create or replace function am_asset_set_avatar(p_asset bigint, p_photo bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (app_can('assets', 'edit') or exists (select 1 from am_asset a where a.id = p_asset and am_in_scope(a.dept_code) and app_can('assets', 'view'))) then
    raise exception 'Không có quyền đổi ảnh đại diện của tài sản này.' using errcode = '42501';
  end if;
  if p_photo is not null and not exists (select 1 from am_asset_photo where id = p_photo and asset_id = p_asset and source = 'storage') then
    raise exception 'Ảnh không thuộc tài sản này.';
  end if;
  update am_asset set avatar_photo_id = p_photo where id = p_asset;
end $$;

-- Tài sản đã có ảnh toàn cảnh / kiểm kê trong app nhưng chưa có ảnh đại diện: đặt ảnh mới nhất.
update am_asset a set avatar_photo_id = p.id
from  (select distinct on (asset_id) id, asset_id from am_asset_photo
       where asset_id is not null and source = 'storage' and kind in ('overall', 'count', 'avatar')
       order by asset_id, (kind = 'avatar') desc, taken_at desc) p
where  a.id = p.asset_id and a.avatar_photo_id is null;


-- =====================================================================
-- 3. KIỂM KÊ: ẢNH, DANH MỤC, THỐNG KÊ
-- =====================================================================

alter table am_count_line add column if not exists photo_id      bigint references am_asset_photo(id) on delete set null;
alter table am_count_line add column if not exists group_code    text;
alter table am_count_line add column if not exists category_code text;
create index if not exists am_count_line_group_idx on am_count_line (count_id, group_code);

-- Dòng đã có: chép nhóm / danh mục từ sổ.
update am_count_line l set group_code = a.group_code, category_code = a.category_code
from   am_asset a
where  a.id = l.asset_id and l.group_code is null;

-- Mở đợt: chụp danh sách sổ tại lúc mở (kèm nhóm / danh mục để thống kê).
create or replace function am_count_open(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare c am_count; v_n int;
begin
  perform app_require('assets', 'edit');
  select * into c from am_count where id = p_id for update;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'draft' then raise exception 'Đợt % đã mở.', c.code; end if;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book, group_code, category_code)
  select c.id, a.id, a.barcode, a.asset_code, concat_ws(' / ', a.name_vi, nullif(a.name_en, '')), a.asset_kind, a.dept_code,
         a.location_code, a.qty, a.status_code, a.group_code, a.category_code
  from   am_asset a
  where  a.dept_code = any(c.depts)
    and  (c.locations is null or a.location_code = any(c.locations))
    and  am_alive(a.status_code)
    and  (a.asset_kind = 'unique' or a.qty > 0)
  order by a.location_code nulls last, a.asset_code;
  get diagnostics v_n = row_count;
  update am_count set status = 'open', opened_at = now() where id = c.id;
  return v_n;
end $$;

-- Quét một mã (mã vạch hoặc mã tài sản) tại vị trí p_loc. Trả về dòng (jsonb).
create or replace function am_count_scan(p_id bigint, p_code text, p_loc text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c am_count; l am_count_line; a am_asset; q text := upper(trim(p_code)); v_loc text := nullif(upper(trim(coalesce(p_loc, ''))), '');
begin
  select * into c from am_count where id = p_id;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if not am_count_can(p_id) then raise exception 'Bạn không kiểm được đợt này.' using errcode = '42501'; end if;
  select * into l from am_count_line where count_id = p_id and (upper(barcode) = q or upper(asset_code) = q) order by extra limit 1 for update;
  if found then
    update am_count_line set found = true, qty_found = coalesce(qty_found, qty_book), loc_found = coalesce(v_loc, loc_found, loc_book),
                             by_user = auth.uid(), by_name = am_me_name(), at = now()
     where id = l.id returning * into l;
    return to_jsonb(l) || jsonb_build_object('hit', 'list');
  end if;
  select * into a from am_asset where upper(barcode) = q or upper(asset_code) = q limit 1;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book,
                             extra, found, qty_found, loc_found, by_user, by_name, at, group_code, category_code)
  values (p_id, a.id, coalesce(a.barcode, q), a.asset_code, concat_ws(' / ', a.name_vi, nullif(a.name_en, '')), a.asset_kind, a.dept_code,
          a.location_code, a.qty, a.status_code, true, true, coalesce(a.qty, 1), v_loc, auth.uid(), am_me_name(), now(), a.group_code, a.category_code)
  returning * into l;
  return to_jsonb(l) || jsonb_build_object('hit', case when a.id is null then 'unknown' else 'extra' end);
end $$;

-- Ảnh chụp khi kiểm một dòng. p_avatar = true: dùng luôn làm ảnh đại diện của tài sản.
-- Chụp ảnh cũng tính là đã thấy tài sản (nếu dòng còn chưa kiểm).
create or replace function am_count_photo(p_line bigint, p_photo bigint, p_avatar boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare l am_count_line; c am_count;
begin
  select * into l from am_count_line where id = p_line for update;
  if not found then raise exception 'Không có dòng %.', p_line; end if;
  select * into c from am_count where id = l.count_id;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if not am_count_can(c.id) then raise exception 'Bạn không kiểm được đợt này.' using errcode = '42501'; end if;
  if not exists (select 1 from am_asset_photo where id = p_photo and asset_id = l.asset_id) then raise exception 'Ảnh không thuộc tài sản của dòng này.'; end if;
  update am_asset_photo set count_line_id = l.id where id = p_photo;
  update am_count_line set photo_id = p_photo,
         found = coalesce(found, true), qty_found = coalesce(qty_found, qty_book), loc_found = case when found is null then loc_book else loc_found end,
         by_user = coalesce(by_user, auth.uid()), by_name = coalesce(by_name, am_me_name()), at = coalesce(at, now())
  where id = l.id;
  if p_avatar then update am_asset set avatar_photo_id = p_photo where id = l.asset_id; end if;
end $$;

-- Tiến độ một đợt theo vị trí / bộ phận / nhóm tài sản (cho màn hình theo dõi trực tiếp).
create or replace function am_count_stats(p_id bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  with l as (select * from am_count_line where count_id = p_id and am_count_can(p_id)),
  agg as (
    select k, key, count(*) filter (where not extra) total, count(*) filter (where not extra and found is not null) done,
           count(*) filter (where found = false) missing, count(*) filter (where extra) extra,
           count(*) filter (where found and cond = 'damaged') damaged, count(*) filter (where photo_id is not null) photos,
           max(at) last_at
    from (select 'loc' k, coalesce(loc_found, loc_book, '—') key, * from l
          union all select 'dept', coalesce(dept_code, '—'), * from l
          union all select 'group', coalesce(group_code, '—'), * from l) x
    group by k, key)
  select jsonb_build_object(
    'total', (select count(*) filter (where not extra) from l), 'done', (select count(*) filter (where not extra and found is not null) from l),
    'photos', (select count(*) filter (where photo_id is not null) from l), 'last_at', (select max(at) from l),
    'by', coalesce((select jsonb_agg(to_jsonb(agg) order by k, key) from agg), '[]'::jsonb))
$$;


-- =====================================================================
-- 4. QUYỀN
-- =====================================================================

revoke execute on function pm_vendor_import(jsonb, text[]), am_photo_avatar_auto(), am_asset_set_avatar(bigint, bigint),
  am_count_photo(bigint, bigint, boolean), am_count_stats(bigint) from public, anon;
grant execute on function pm_vendor_import(jsonb, text[]), am_asset_set_avatar(bigint, bigint), am_count_photo(bigint, bigint, boolean),
  am_count_stats(bigint) to authenticated;

select app_lock_anon();


-- =====================================================================
-- 5. KIỂM CHỨNG
-- =====================================================================

select 'Cột mới (vendor.address, asset.avatar_photo_id, photo.thumb_path, count_line.photo_id / group_code)' as "Mục",
       count(*)::text as "Thực tế", '5' as "Mong đợi", case when count(*) = 5 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.columns
where  table_schema = 'public' and ((table_name = 'pm_vendor' and column_name = 'address') or (table_name = 'am_asset' and column_name = 'avatar_photo_id')
   or (table_name = 'am_asset_photo' and column_name = 'thumb_path') or (table_name = 'am_count_line' and column_name in ('photo_id', 'group_code')))
union all
select 'MST nhà cung cấp không còn bắt buộc duy nhất', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_constraint where conname = 'pm_vendor_tax_code_key'
union all
select 'Hàm mới', count(*)::text, '4', case when count(*) = 4 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pm_vendor_import', 'am_asset_set_avatar', 'am_count_photo', 'am_count_stats');
