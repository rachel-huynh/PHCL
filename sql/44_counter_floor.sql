-- =====================================================================
-- 44_counter_floor.sql — BỘ ĐẾM KHÔNG BAO GIỜ CẤP SỐ ĐÃ CÓ TRONG SỔ (user 14/10/2026)
--
-- Sự cố: nhập tài sản báo "duplicate key … am_asset_barcode_key". Bộ đếm mã vạch
-- (am_barcode_seq) chỉ cộng thêm, không nhìn sổ; tài sản vào sổ không qua bộ đếm
-- (nạp file, thêm tay, dữ liệu cũ) làm sổ đi trước bộ đếm, nên bộ đếm cấp lại một
-- mã vạch đang dán trên tài sản khác. Màn Bộ đếm cũng chỉ đối chiếu số thứ tự của
-- mã tài sản, không đối chiếu mã vạch.
--
--   1. am_alloc_barcode / am_alloc_asset_seq: trước khi cấp, nâng bộ đếm lên
--      ít nhất (số cao nhất đang có trong sổ) + 1 — không thể cấp trùng nữa.
--   2. am_audit_counters / am_reseed_counters: có thêm hai dòng mã vạch
--      (barcode|unique, barcode|low), nên "Kéo mọi bộ đếm về ngang sổ" ở màn
--      Bộ đếm cũng đặt mã vạch kế tiếp = số cao nhất trong sổ + 1.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

-- Số mã vạch cao nhất đang có trong sổ cho một dải (phần số, như next_val của am_barcode_seq).
--   unique : 'JVC.' + 9 chữ số, chữ số đầu 0-8  → phần sau 'JVC.'
--   low    : 'JVC.9' + 8 chữ số                  → phần sau 'JVC.9'
create or replace function am_barcode_max(p_kind text)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(max(case when p_kind = 'unique' then substr(barcode, 5)::bigint else substr(barcode, 6)::bigint end), 0)
  from   am_asset
  where  case when p_kind = 'unique' then barcode ~ '^JVC\.[0-8][0-9]{8}$' else barcode ~ '^JVC\.9[0-9]{8}$' end
$$;

-- Cấp p_count số thứ tự liên tiếp cho (phòng ban, CHỮ). Trả về số ĐẦU TIÊN.
create or replace function am_alloc_asset_seq(
  p_dept        text,
  p_letters     text,
  p_count       int default 1,
  p_shipment_id bigint default null,
  p_actor       text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first int;
  v_floor int;
  v_old   int;
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  if p_count < 1 then
    raise exception 'p_count phải >= 1';
  end if;
  p_dept    := upper(trim(p_dept));
  p_letters := am_letters(p_letters);   -- phòng khi gọi nhầm bằng mã có -QR

  insert into am_asset_seq (dept_code, letters, next_seq)
  values (p_dept, p_letters, 1)
  on conflict (dept_code, letters) do nothing;

  -- Sàn: ngay sau số cao nhất đang có trong sổ ở khoá này (44_counter_floor.sql).
  select coalesce(max(a.seq), 0) + 1 into v_floor
  from   am_asset a where a.dept_code = p_dept and a.letters = p_letters and a.seq > 0;
  select s.next_seq into v_old from am_asset_seq s where s.dept_code = p_dept and s.letters = p_letters for update;
  if v_old < v_floor then
    update am_asset_seq set next_seq = v_floor, updated_at = now() where dept_code = p_dept and letters = p_letters;
    insert into am_counter_log (counter, scope, from_val, to_val, shipment_id, actor)
    values ('asset_seq', p_dept || '|' || p_letters, v_old, v_floor, p_shipment_id, 'floor');
  end if;

  update am_asset_seq
     set next_seq = next_seq + p_count,
         updated_at = now()
   where dept_code = p_dept and letters = p_letters
  returning next_seq - p_count into v_first;

  if v_first is null then
    raise exception 'Không cấp được số thứ tự cho (%, %)', p_dept, p_letters;
  end if;
  if v_first + p_count - 1 > 99999 then
    raise exception 'Dãy số của (%, %) đã vượt 5 chữ số', p_dept, p_letters;
  end if;

  insert into am_counter_log (counter, scope, from_val, to_val, shipment_id, actor)
  values ('asset_seq', p_dept || '|' || p_letters,
          v_first, v_first + p_count - 1, p_shipment_id, p_actor);

  return v_first;
end;
$$;

-- Cấp p_count mã vạch liên tiếp. Trả về số ĐẦU TIÊN (chưa định dạng).
create or replace function am_alloc_barcode(
  p_kind        text,
  p_count       int default 1,
  p_shipment_id bigint default null,
  p_actor       text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first bigint;
  v_max   bigint;
  v_old   bigint;
  v_floor bigint;
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  if p_count < 1 then
    raise exception 'p_count phải >= 1';
  end if;
  if p_kind not in ('unique', 'low') then
    raise exception 'kind không hợp lệ: %', p_kind;
  end if;

  -- Sàn: ngay sau mã vạch cao nhất đang có trong sổ của dải này (44_counter_floor.sql).
  select next_val into v_old from am_barcode_seq where kind = p_kind for update;
  v_floor := am_barcode_max(p_kind) + 1;
  if v_old < v_floor then
    update am_barcode_seq set next_val = v_floor, updated_at = now() where kind = p_kind;
    insert into am_counter_log (counter, scope, from_val, to_val, shipment_id, actor)
    values ('barcode', p_kind, v_old, v_floor, p_shipment_id, 'floor');
  end if;

  update am_barcode_seq
     set next_val = next_val + p_count,
         updated_at = now()
   where kind = p_kind
  returning next_val - p_count, max_val into v_first, v_max;

  if v_first is null then
    raise exception 'Chưa khởi tạo bộ đếm mã vạch cho kind=%', p_kind;
  end if;
  if v_first + p_count - 1 > v_max then
    raise exception 'Dải mã vạch % đã cạn (max %)', p_kind, v_max;
  end if;

  insert into am_counter_log (counter, scope, from_val, to_val, shipment_id, actor)
  values ('barcode', p_kind, v_first, v_first + p_count - 1, p_shipment_id, p_actor);

  return v_first;
end;
$$;

-- Đối chiếu lại bộ đếm với chính bảng am_asset — nay gồm cả hai dải mã vạch.
create or replace function am_audit_counters()
returns table (scope text, counter_next bigint, table_max bigint, gap bigint)
language sql
stable
as $$
  -- Duyệt HỢP của hai phía, không phải chỉ từ bảng bộ đếm ra: khoá có tài sản mà
  -- chưa có dòng bộ đếm coi như next_seq = 0, gap ra âm và bị bắt lỗi.
  -- seq = 0 là dòng lịch sử có mã không phân tích được, loại ra.
  with k as (
    select dept_code, letters from am_asset_seq
    union
    select dept_code, letters from am_asset where seq > 0
  ),
  mx as (
    select dept_code, letters, max(seq) mx
    from am_asset where seq > 0 group by 1, 2
  )
  select  k.dept_code || '|' || k.letters,
          coalesce(s.next_seq, 0)::bigint,
          coalesce(a.mx, 0)::bigint,
          coalesce(s.next_seq, 0)::bigint - coalesce(a.mx, 0)::bigint - 1
  from    k
  left join am_asset_seq s using (dept_code, letters)
  left join mx a           using (dept_code, letters)
  union all
  select  'barcode|' || b.kind, b.next_val, am_barcode_max(b.kind), b.next_val - am_barcode_max(b.kind) - 1
  from    am_barcode_seq b
  order by 1
$$;

-- Nạp lại TOÀN BỘ khoá từ am_asset — nay gồm cả hai dải mã vạch.
--   p_allow_lower = false : chỉ đẩy lên
--   p_allow_lower = true  : đặt đúng bằng số cao nhất trong sổ + 1, kể cả khi phải kéo xuống
drop function if exists am_reseed_counters(boolean);
create or replace function am_reseed_counters(p_allow_lower boolean default false)
returns table (scope text, old_next int, new_next int, moved text)
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
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

  -- Hai dải mã vạch: số cao nhất trong sổ + 1 (44_counter_floor.sql).
  for r in select b.kind as k, b.next_val as have, am_barcode_max(b.kind) + 1 as want from am_barcode_seq b loop
    if r.want = r.have then continue; end if;
    if r.want < r.have and not p_allow_lower then continue; end if;
    update am_barcode_seq set next_val = r.want, updated_at = now() where kind = r.k;
    insert into am_counter_log (counter, scope, from_val, to_val, actor)
    values ('barcode', r.k, r.have, r.want, 'reseed');
    insert into _reseed values ('barcode|' || r.k, r.have::int, r.want::int,
      case when r.want < r.have then 'down' else 'up' end);
  end loop;

  return query select x.scope, x.old_next, x.new_next, x.moved
               from _reseed x order by x.moved, x.scope;
end $$;

comment on function am_reseed_counters(boolean) is
  'Nạp lại mọi bộ đếm từ am_asset (số thứ tự mã tài sản và hai dải mã vạch). p_allow_lower=true cho phép kéo xuống đúng max+1. Ghi vào am_counter_log.';

revoke execute on function am_barcode_max(text) from public, anon;
grant execute on function am_barcode_max(text), am_audit_counters(), am_reseed_counters(boolean) to authenticated;
grant execute on function am_alloc_asset_seq(text, text, int, bigint, text), am_alloc_barcode(text, int, bigint, text) to authenticated;

select app_lock_anon();

-- Kiểm tra: dòng mã vạch có gap âm = bộ đếm đang đứng sau sổ (lần cấp kế tiếp tự nâng lên).
select * from am_audit_counters() where scope like 'barcode|%';
