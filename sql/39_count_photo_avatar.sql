-- =====================================================================
-- 39_count_photo_avatar.sql — ẢNH KIỂM KÊ MỚI NHẤT LÀM ẢNH ĐẠI DIỆN (28/09/2026)
--
-- Chạy SAU 38_project_offline_avatar.sql. Chạy lại nhiều lần vô hại.
--
-- Quyết định của user (28/09/2026): ảnh kiểm kê MỚI NHẤT là ảnh đại diện; ảnh cũ
-- không bị ghi đè mà giữ nguyên trong lịch sử ảnh của tài sản (có ngày giờ, người
-- chụp, đợt kiểm kê) ở phần thông tin chi tiết. Từ nay app bật sẵn "Ảnh chụp làm
-- ảnh đại diện" khi kiểm kê (có thể bỏ tích cho ảnh chụp cận chỗ hư hỏng).
--
-- SỬA LỖI (28/09/2026): am_count_photo (35) báo 'column reference "found" is
-- ambiguous' mỗi khi gắn ảnh vào một dòng kiểm kê — "found" vừa là cột vừa là
-- biến có sẵn của plpgsql. Hàm được tạo lại dưới đây, cột gọi qua bí danh.
--
-- File này cũng áp quy tắc cho dữ liệu ĐÃ CÓ, một lần: tài sản đang lấy một ảnh
-- kiểm kê cũ làm ảnh đại diện (do app tự đặt) mà đã có ảnh kiểm kê mới hơn thì
-- chuyển sang ảnh mới nhất. Ảnh đại diện người dùng chọn / tải riêng (loại
-- "avatar", ảnh tem, ảnh toàn cảnh…) giữ nguyên. Không xoá ảnh nào.
-- =====================================================================

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
  update am_count_line cl set photo_id = p_photo,
         found = coalesce(cl.found, true), qty_found = coalesce(cl.qty_found, cl.qty_book), loc_found = case when cl.found is null then cl.loc_book else cl.loc_found end,
         by_user = coalesce(cl.by_user, auth.uid()), by_name = coalesce(cl.by_name, am_me_name()), at = coalesce(cl.at, now())
  where cl.id = l.id;
  if p_avatar then update am_asset set avatar_photo_id = p_photo where id = l.asset_id; end if;
end $$;
revoke execute on function am_count_photo(bigint, bigint, boolean) from public, anon;
grant execute on function am_count_photo(bigint, bigint, boolean) to authenticated;

with newest as (
  select distinct on (p.asset_id) p.asset_id, p.id, p.taken_at
  from   am_asset_photo p
  where  p.kind = 'count' and p.source = 'storage'
  order  by p.asset_id, p.taken_at desc, p.id desc
)
update am_asset a set avatar_photo_id = n.id
from   newest n, am_asset_photo cur
where  a.id = n.asset_id
  and  cur.id = a.avatar_photo_id
  and  cur.kind = 'count'
  and  n.id <> cur.id
  and  n.taken_at > cur.taken_at;

select app_lock_anon();

select 'Tài sản có ảnh đại diện là ảnh kiểm kê cũ hơn ảnh kiểm kê mới nhất (phải = 0)' as "Mục", count(*)::text as "Thực tế", '0' as "Mong đợi",
       case when count(*) = 0 then '✔' else '✘ HỎNG' end as "Đạt"
from   am_asset a join am_asset_photo cur on cur.id = a.avatar_photo_id and cur.kind = 'count'
where  exists (select 1 from am_asset_photo p where p.asset_id = a.id and p.kind = 'count' and p.source = 'storage' and p.taken_at > cur.taken_at);
