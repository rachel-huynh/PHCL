-- =====================================================================
-- asset-intake — Hàm nghiệp vụ: chuẩn hóa, bộ đếm, sinh mã, phân loại
-- Chạy SAU 01_schema.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Chuẩn hóa chuỗi để so khớp (product catalogue, xuất xứ, tên phòng ban)
--
-- Cố tình KHÔNG dùng extension unaccent: trên Supabase nó nằm ở schema
-- "extensions", nên hàm SECURITY DEFINER đặt search_path=public sẽ không
-- thấy. translate() bao trọn bộ dấu tiếng Việt, thật sự IMMUTABLE và
-- không phụ thuộc cài đặt nào.
-- ---------------------------------------------------------------------
create or replace function am_norm(p text)
returns text
language sql
immutable
strict
as $$
  select regexp_replace(
           trim(translate(
             lower(p),
             'áàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ'
             || 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
             'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'
             || 'aaaaaaceeeeiiiinooooouuuuyy'
           )),
           '\s+', ' ', 'g')
$$;
comment on function am_norm(text) is
  'lower + bỏ dấu tiếng Việt + gộp khoảng trắng. Dùng cho am_product.raw_name_norm và am_origin_alias.alias_norm.';

-- ---------------------------------------------------------------------
-- CHỮ hiển thị trong Mã Tài Sản: bỏ hậu tố '-QR'
-- LTG-QR -> LTG, STG-QR -> STG.  Đây là khóa dùng chung dãy số.
-- ---------------------------------------------------------------------
create or replace function am_letters(p_category_code text)
returns text
language sql
immutable
strict
as $$
  select replace(upper(trim(p_category_code)), '-QR', '')
$$;

-- ---------------------------------------------------------------------
-- Định dạng Mã Vạch từ số nguyên của bộ đếm
--   unique : JVC. + 9 chữ số                 (1        -> JVC.000000001)
--   low    : JVC.9 + 8 chữ số                (1        -> JVC.900000001)
-- ---------------------------------------------------------------------
create or replace function am_format_barcode(p_kind text, p_val bigint)
returns text
language plpgsql
immutable
as $$
begin
  if p_kind = 'unique' then
    if p_val < 1 or p_val > 899999999 then
      raise exception 'Số mã vạch unique ngoài dải cho phép: %', p_val;
    end if;
    return 'JVC.' || lpad(p_val::text, 9, '0');
  elsif p_kind = 'low' then
    if p_val < 1 or p_val > 99999999 then
      raise exception 'Số mã vạch low-value ngoài dải cho phép: %', p_val;
    end if;
    return 'JVC.9' || lpad(p_val::text, 8, '0');
  else
    raise exception 'kind không hợp lệ: %', p_kind;
  end if;
end;
$$;

-- Tách ngược: chuỗi mã vạch -> (kind, số nguyên). Dùng khi nạp bộ đếm từ register cũ.
create or replace function am_parse_barcode(p_code text)
returns table (kind text, val bigint)
language plpgsql
immutable
as $$
declare
  d text;
begin
  if p_code !~ '^JVC\.[0-9]{9}$' then
    return;
  end if;
  d := substring(p_code from 5);          -- 9 chữ số
  if left(d, 1) = '9' then
    kind := 'low';
    val  := substring(d from 2)::bigint;  -- 8 chữ số sau số 9
  else
    kind := 'unique';
    val  := d::bigint;
  end if;
  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- Ghép Mã Tài Sản
--   [Mã Phòng Ban].[Nhóm cha].[CHỮ].[Năm mua].[5 chữ số]
-- ---------------------------------------------------------------------
create or replace function am_build_asset_code(
  p_dept text, p_group text, p_letters text, p_year int, p_seq int
)
returns text
language plpgsql
immutable
as $$
begin
  if p_seq < 1 or p_seq > 99999 then
    raise exception 'Số thứ tự vượt 5 chữ số: %', p_seq;
  end if;
  return p_dept || '.' || p_group || '.' || p_letters || '.'
         || p_year::text || '.' || lpad(p_seq::text, 5, '0');
end;
$$;

-- =====================================================================
-- BỘ ĐẾM — cấp phát nguyên tử
-- Tất cả đều SECURITY DEFINER: ứng dụng KHÔNG được ghi thẳng vào bảng đếm.
-- =====================================================================

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
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  if p_count < 1 then
    raise exception 'p_count phải >= 1';
  end if;
  if p_kind not in ('unique', 'low') then
    raise exception 'kind không hợp lệ: %', p_kind;
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

-- Số hiệu ALR kế tiếp: AL.<n>
create or replace function am_alloc_alr_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v int;
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  insert into am_alr_seq (singleton, next_val) values (true, 1)
  on conflict (singleton) do nothing;

  update am_alr_seq set next_val = next_val + 1
   where singleton returning next_val - 1 into v;

  return 'AL.' || v::text;
end;
$$;

-- =====================================================================
-- NẠP BỘ ĐẾM TỪ REGISTER CŨ (chỉ NÂNG, không bao giờ hạ)
-- =====================================================================

create or replace function am_seed_asset_seq(
  p_dept text, p_letters text, p_max_seen int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v int;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_dept    := upper(trim(p_dept));
  p_letters := am_letters(p_letters);

  insert into am_asset_seq (dept_code, letters, next_seq)
  values (p_dept, p_letters, p_max_seen + 1)
  on conflict (dept_code, letters) do update
    set next_seq   = greatest(am_asset_seq.next_seq, excluded.next_seq),
        updated_at = now()
  returning next_seq into v;

  return v;
end;
$$;

create or replace function am_seed_barcode(p_kind text, p_max_seen bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v bigint;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
  update am_barcode_seq
     set next_val   = greatest(next_val, p_max_seen + 1),
         updated_at = now()
   where kind = p_kind
  returning next_val into v;

  if v is null then
    raise exception 'Chưa khởi tạo bộ đếm mã vạch cho kind=%', p_kind;
  end if;
  return v;
end;
$$;

-- Nạp hàng loạt từ một mảng chuỗi lấy ra khỏi file register bất kỳ
-- (quét cả Mã Tài Sản lẫn Mã Vạch, bỏ qua chuỗi không đúng định dạng).
-- Trả về bảng tóm tắt để UI hiển thị "đã nâng bộ đếm nào lên bao nhiêu".
create or replace function am_seed_from_codes(p_codes text[])
returns table (scope text, kind text, max_seen bigint, next_val bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
  -- 1) Mã Tài Sản: <DEPT>.<C2xxx>.<LLL>.<YYYY>.<NNNNN>
  for r in
    select  m[1] as dept, m[3] as letters, max(m[5]::int) as mx
    from    unnest(p_codes) c,
            lateral regexp_match(
              upper(trim(c)),
              '^([A-Z]{2,5})\.(C2[0-9]{3})\.([A-Z]{3})\.([0-9]{4})\.([0-9]{5})$'
            ) m
    where   m is not null
    group by m[1], m[3]
  loop
    scope    := r.dept || '|' || r.letters;
    kind     := 'asset_seq';
    max_seen := r.mx;
    next_val := am_seed_asset_seq(r.dept, r.letters, r.mx);
    return next;
  end loop;

  -- 2) Mã Vạch: JVC.<9 chữ số>
  for r in
    select  p.kind as bk, max(p.val) as mx
    from    unnest(p_codes) c,
            lateral am_parse_barcode(upper(trim(c))) p
    group by p.kind
  loop
    scope    := r.bk;
    kind     := 'barcode';
    max_seen := r.mx;
    next_val := am_seed_barcode(r.bk, r.mx);
    return next;
  end loop;
end;
$$;

-- Đối chiếu lại bộ đếm với chính bảng am_asset (dùng khi nghi ngờ lệch).
create or replace function am_audit_counters()
returns table (scope text, counter_next bigint, table_max bigint, gap bigint)
language sql
stable
as $$
  -- Duyệt HỢP của hai phía, không phải chỉ từ bảng bộ đếm ra.
  --
  -- Nếu chỉ duyệt từ am_asset_seq thì khoá nào có tài sản nhưng CHƯA có dòng
  -- bộ đếm sẽ vô hình — mà đó mới là trường hợp nguy hiểm nhất: cấp mã cho
  -- khoá đó bắt đầu từ 1 và đụng ngay mã đã có. Khoá thiếu bộ đếm coi như
  -- next_seq = 0 nên gap ra âm và bị bắt lỗi.
  --
  -- seq = 0 là dòng lịch sử có mã không phân tích được, không được phép kéo
  -- bộ đếm lên nên loại ra.
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
  order by 1
$$;

-- =====================================================================
-- QUY TẮC PHÂN LOẠI
-- =====================================================================

-- Quy tắc 1 + 3. KHÔNG tự sửa dữ liệu — chỉ trả về kết luận + cảnh báo
-- để UI bắt người dùng xác nhận.
--
--   asset_kind : 'unique' nếu đơn giá >= ngưỡng (mặc định 5.000.000),
--                ngược lại 'low'
--   violates_capex : đơn giá > 30.000.000 nhưng mã danh mục là CCDC
--   suggested_category : gợi ý mã thay thế
--        - vô hình (license/phần mềm) -> CTP (nhóm C2135)
--        - hữu hình                   -> null, người dùng CHỌN mã thuộc C2112
--                                        đúng bản chất (vd CNTT -> ITO)
create or replace function am_classify(
  p_unit_price    numeric,
  p_category_code text,
  p_is_intangible boolean default false
)
returns table (
  asset_kind         text,
  violates_capex     boolean,
  suggested_category text,
  warnings           text[]
)
language plpgsql
stable
as $$
declare
  v_unique_threshold numeric := coalesce(
    (select (value #>> '{}')::numeric from am_setting where key = 'unique_threshold'),
    5000000);
  v_capex_threshold numeric := coalesce(
    (select (value #>> '{}')::numeric from am_setting where key = 'capex_threshold'),
    30000000);
  -- Danh sách CCDC bị cấm khi > ngưỡng capex, đúng theo quy tắc nghiệp vụ
  v_banned text[] := array['LTU', 'LTG', 'LTG-QR', 'STG-QR'];
  v_grp    record;
begin
  asset_kind         := case when p_unit_price >= v_unique_threshold then 'unique' else 'low' end;
  violates_capex     := false;
  suggested_category := null;
  warnings           := array[]::text[];

  select g.code, g.is_tools, g.is_intangible,
         coalesce(g.expense_class, 'CAPEX') as expense_class
    into v_grp
    from am_category c join am_category_group g on g.code = c.group_code
   where c.code = upper(trim(p_category_code));

  if not found then
    warnings := warnings || format('Mã danh mục %s không có trong master data', p_category_code);
    return next;
    return;
  end if;

  if p_unit_price > v_capex_threshold then
    if upper(trim(p_category_code)) = any (v_banned) then
      violates_capex := true;
      if p_is_intangible or v_grp.is_intangible then
        suggested_category := 'CTP';
        warnings := warnings || format(
          'Đơn giá %s > %s và là tài sản VÔ HÌNH: phải chuyển sang C2135/CTP. Không được ép vào C2112.',
          to_char(p_unit_price, 'FM999,999,999,999'),
          to_char(v_capex_threshold, 'FM999,999,999,999'));
      else
        warnings := warnings || format(
          'Đơn giá %s > %s: không được để mã CCDC %s. Chọn mã thuộc nhóm C2112 đúng bản chất (vd thiết bị CNTT -> ITO).',
          to_char(p_unit_price, 'FM999,999,999,999'),
          to_char(v_capex_threshold, 'FM999,999,999,999'),
          p_category_code);
      end if;
    elsif v_grp.expense_class = 'OPEX' then
      -- O4000 is operating supplies and carries no accounting code, so it is
      -- never blocked. But an item this expensive is very unlikely to belong
      -- there, so say so and let the buyer decide.
      warnings := warnings || format(
        'Đơn giá %s > %s nhưng mã %s thuộc nhóm OPEX %s (đồ dùng vận hành, không có mã kế toán) — kiểm tra lại xem có phải TSCĐ không.',
        to_char(p_unit_price, 'FM999,999,999,999'),
        to_char(v_capex_threshold, 'FM999,999,999,999'),
        p_category_code, v_grp.code);
    elsif v_grp.is_tools then
      -- STU / STG chưa nằm trong danh sách cấm được nêu rõ, nhưng vẫn là CCDC
      warnings := warnings || format(
        'Đơn giá %s > %s nhưng mã %s vẫn thuộc nhóm CCDC %s — cần kế toán xác nhận.',
        to_char(p_unit_price, 'FM999,999,999,999'),
        to_char(v_capex_threshold, 'FM999,999,999,999'),
        p_category_code, v_grp.code);
    end if;
  end if;

  if p_is_intangible and not v_grp.is_intangible then
    warnings := warnings || format(
      'Đánh dấu VÔ HÌNH nhưng mã %s thuộc nhóm hữu hình %s.', p_category_code, v_grp.code);
  end if;

  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- Xuất xứ: chỉ trả mã khi khớp ĐÚNG MỘT quốc gia thật.
-- Nhiều quốc gia ("USA/Mexico/China/Singapore") hoặc không phải quốc gia
-- ("Asia", "EU") -> trả null kèm lý do, KHÔNG giữ text gốc, KHÔNG chọn đại diện.
-- ---------------------------------------------------------------------
create or replace function am_resolve_origin(p_raw text)
returns table (iso2 char(2), reason text)
language plpgsql
stable
as $$
declare
  v_norm text;
  v_hits int;
begin
  iso2 := null; reason := null;
  if p_raw is null or trim(p_raw) = '' then
    reason := 'empty';
    return next; return;
  end if;

  v_norm := am_norm(p_raw);

  -- Dấu hiệu liệt kê nhiều quốc gia: / , ; & " and " " hoac "
  if v_norm ~ '[/,;&]|\yand\y|\yhoac\y|\yor\y' then
    reason := 'multi_country';
    return next; return;
  end if;

  select a.iso2 into iso2 from am_origin_alias a where a.alias_norm = v_norm;
  if iso2 is not null then
    reason := 'alias';
    return next; return;
  end if;

  select count(*) into v_hits from am_origin o
   where am_norm(o.name_en) = v_norm or am_norm(o.name_vi) = v_norm;

  if v_hits = 1 then
    select o.iso2 into iso2 from am_origin o
     where am_norm(o.name_en) = v_norm or am_norm(o.name_vi) = v_norm;
    reason := 'exact';
  elsif v_hits > 1 then
    reason := 'ambiguous';
  else
    reason := 'not_a_country';
  end if;

  return next;
end;
$$;
