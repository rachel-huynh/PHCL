-- =====================================================================
-- 16_reset_counters.sql — ĐẶT LẠI BỘ ĐẾM VỀ NGANG SỔ
--
-- Bối cảnh: am_seed_asset_seq() dùng greatest(), nên nút "Đối chiếu với sổ"
-- chỉ ĐẨY LÊN, không bao giờ kéo xuống. Đó là mặc định đúng — nhưng sau khi
-- xoá hàng loạt, bộ đếm đứng cao hơn sổ và dãy số thủng một khoảng.
--
-- Hai hàm ở đây là đường duy nhất để kéo xuống, và cả hai đều bị chặn bởi
-- MỘT luật không thương lượng:
--
--     next_seq KHÔNG BAO GIỜ được đặt thấp hơn max(seq đang có) + 1.
--
-- Hạ thấp hơn mức đó là cấp lại một mã đang nằm trong sổ — đúng thứ toàn bộ
-- ứng dụng này sinh ra để ngăn. Hàm sẽ báo lỗi chứ không im lặng kẹp số.
--
-- ⚠ VẪN CÒN MỘT RỦI RO MÀ CƠ SỞ DỮ LIỆU KHÔNG THẤY ĐƯỢC: nếu một mã đã được
-- IN RA TEM rồi dòng đó bị xoá, sổ không còn dấu vết nào của nó, nên sàn tính
-- ở trên không biết mà tránh. Kéo bộ đếm xuống lúc đó sẽ cấp lại một số đang
-- dán trên hiện vật. Vì thế đây là thao tác THỦ CÔNG, do người biết đợt nào
-- đã in quyết định — không phải việc app tự làm sau mỗi lần xoá.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_set_asset_seq(text, text, int);

-- Đặt tay MỘT khoá. Trả về giá trị cũ, giá trị mới và sàn an toàn.
create or replace function am_set_asset_seq(
  p_dept text, p_letters text, p_next int
)
returns table (dept_code text, letters text, old_next int, new_next int, floor_next int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old   int;
  v_floor int;
begin
  p_dept    := upper(trim(p_dept));
  p_letters := am_letters(p_letters);

  if not exists (select 1 from am_org where code = p_dept and is_department) then
    raise exception 'Mã phòng ban % không có trong danh mục', p_dept;
  end if;
  if p_next is null or p_next < 1 then
    raise exception 'Số kế tiếp phải >= 1';
  end if;

  -- Sàn: ngay sau số cao nhất đang thực sự nằm trong sổ ở khoá này.
  select coalesce(max(a.seq), 0) + 1 into v_floor
  from   am_asset a
  where  a.dept_code = p_dept and a.letters = p_letters and a.seq > 0;

  if p_next < v_floor then
    raise exception
      'Không hạ được bộ đếm (%, %) xuống % — sổ đang có mã tới số %, đặt thấp hơn % sẽ cấp trùng.',
      p_dept, p_letters, p_next, v_floor - 1, v_floor;
  end if;

  -- Đọc giá trị cũ TRƯỚC khi ghi, nếu không thì khoá mới sẽ tự báo là "không đổi".
  select s.next_seq into v_old
  from   am_asset_seq s where s.dept_code = p_dept and s.letters = p_letters;

  insert into am_asset_seq (dept_code, letters, next_seq)
  values (p_dept, p_letters, p_next)
  on conflict (dept_code, letters)
    do update set next_seq = excluded.next_seq, updated_at = now();

  -- Ghi nhật ký kể cả khi kéo xuống: from > to đọc ra ngay là một lần đặt tay.
  if v_old is distinct from p_next then
    insert into am_counter_log (counter, scope, from_val, to_val, actor)
    values ('asset_seq', p_dept || '|' || p_letters,
            coalesce(v_old, 0), p_next, 'set_manual');
  end if;

  return query select p_dept, p_letters, v_old, p_next, v_floor;
end $$;

comment on function am_set_asset_seq(text, text, int) is
  'Đặt tay số kế tiếp của một khoá bộ đếm. Chặn mọi giá trị thấp hơn max(seq trong sổ)+1. Ghi vào am_counter_log.';

-- ---------------------------------------------------------------------
drop function if exists am_reseed_counters(boolean);

-- Nạp lại TOÀN BỘ khoá từ am_asset.
--   p_allow_lower = false : chỉ đẩy lên (giống nút Đối chiếu sẵn có)
--   p_allow_lower = true  : đặt đúng bằng max(seq)+1, kể cả khi phải kéo xuống
create or replace function am_reseed_counters(p_allow_lower boolean default false)
returns table (scope text, old_next int, new_next int, moved text)
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  create temp table if not exists _reseed (
    scope text, old_next int, new_next int, moved text
  ) on commit drop;
  delete from _reseed;

  for r in
    select a.dept_code as d, a.letters as l, max(a.seq) + 1 as want,
           coalesce(s.next_seq, 0) as have
    from   am_asset a
    left join am_asset_seq s
           on s.dept_code = a.dept_code and s.letters = a.letters
    where  a.seq > 0
    group by a.dept_code, a.letters, s.next_seq
  loop
    if r.want = r.have then continue; end if;
    if r.want < r.have and not p_allow_lower then continue; end if;

    insert into am_asset_seq (dept_code, letters, next_seq)
    values (r.d, r.l, r.want)
    on conflict (dept_code, letters)
      do update set next_seq = excluded.next_seq, updated_at = now();

    insert into am_counter_log (counter, scope, from_val, to_val, actor)
    values ('asset_seq', r.d || '|' || r.l, r.have, r.want, 'reseed');

    insert into _reseed values (r.d || '|' || r.l, r.have, r.want,
      case when r.want < r.have then 'down' else 'up' end);
  end loop;

  /* Khoá nào không còn dòng tài sản nào thì max() ở trên không thấy. Nếu bộ đếm
     của nó đang > 1 thì đó là một khoá đã bị xoá sạch — trả về 1 khi được phép. */
  if p_allow_lower then
    for r in
      select s.dept_code as d, s.letters as l, s.next_seq as have
      from   am_asset_seq s
      where  s.next_seq > 1
        and  not exists (select 1 from am_asset a
                         where a.dept_code = s.dept_code
                           and a.letters = s.letters and a.seq > 0)
    loop
      update am_asset_seq s set next_seq = 1, updated_at = now()
       where s.dept_code = r.d and s.letters = r.l;
      insert into am_counter_log (counter, scope, from_val, to_val, actor)
      values ('asset_seq', r.d || '|' || r.l, r.have, 1, 'reseed');
      insert into _reseed values (r.d || '|' || r.l, r.have, 1, 'empty');
    end loop;
  end if;

  return query select x.scope, x.old_next, x.new_next, x.moved
               from _reseed x order by x.moved, x.scope;
end $$;

comment on function am_reseed_counters(boolean) is
  'Nạp lại toàn bộ khoá bộ đếm mã tài sản từ am_asset. p_allow_lower=true cho phép KÉO XUỐNG đúng bằng max(seq)+1 sau khi xoá hàng loạt — chỉ dùng khi chắc chắn không có mã nào đã in tem rồi bị xoá.';

grant execute on function am_set_asset_seq(text, text, int) to anon, authenticated;
grant execute on function am_reseed_counters(boolean) to anon, authenticated;
