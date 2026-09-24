-- =====================================================================
-- MIGRATE_17 — BẬT ĐĂNG NHẬP BẮT BUỘC cho database đang chạy.
-- Làm theo đúng thứ tự trong phần đầu của 17_auth.sql (tạo tài khoản
-- trước, chạy file này, bootstrap admin, rồi mới push app mới).
-- Chạy lại nhiều lần vô hại.
-- Sinh tự động bởi scripts/build-sql.ps1. Đừng sửa file này — sửa file
-- gốc trong sql/ rồi chạy lại script.
-- =====================================================================


-- ####################################################################
-- ##  03_functions.sql
-- ####################################################################

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


-- ####################################################################
-- ##  04_rls.sql
-- ####################################################################

-- =====================================================================
-- 04_rls.sql — BẬT RLS + QUYỀN NỀN
--
-- Từ 17_auth.sql trở đi app BẮT BUỘC ĐĂNG NHẬP. File này chỉ còn làm ba việc:
--   * bật RLS trên mọi bảng (chưa có policy = không ai đọc được, trừ postgres),
--   * cấp quyền bảng cho vai `authenticated` — RLS quyết định DÒNG nào,
--   * khoá ghi trực tiếp vào bảng bộ đếm (chỉ qua hàm SECURITY DEFINER).
--
-- Mọi POLICY nằm ở 17_auth.sql. File này KHÔNG cấp gì cho `anon`, nên chạy
-- lại nó sau 17 không mở lại hệ thống. (Bản cũ cấp "for all to anon using
-- (true)" cho gần như mọi bảng — ai có link là đọc/sửa được hết.)
--
-- Chạy SAU 03_functions.sql. Chạy lại nhiều lần vô hại.
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_asset_seq','am_barcode_seq','am_counter_log','am_shipment',
    'am_shipment_line','am_asset','am_alr','am_alr_line','am_alr_seq',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 1. Quyền bảng cho người đã đăng nhập. RLS (17_auth.sql) lọc tiếp theo
--    vai trò và phạm vi phòng ban.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_shipment','am_shipment_line','am_alr','am_alr_line',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Sổ tài sản: KHÔNG có DELETE. Xoá chỉ qua am_undo_intake / am_bulk_delete,
-- là những hàm có luật đi kèm (giữ dòng đã nằm trên biên bản, v.v.).
grant select, insert, update on am_asset to authenticated;

-- Mọi bảng bigserial cần quyền dùng sequence thì INSERT mới chạy được.
-- Bộ đếm nghiệp vụ (am_asset_seq / am_barcode_seq / am_alr_seq) KHÔNG phải
-- sequence của Postgres nên không bị ảnh hưởng bởi lệnh này.
grant usage, select on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------
-- 2. Bộ đếm: chỉ đọc. Mọi thay đổi phải đi qua hàm SECURITY DEFINER.
--    Đây là lý do bộ đếm không thể bị "reset" từ trình duyệt.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['am_asset_seq','am_barcode_seq','am_counter_log','am_alr_seq'] loop
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Quyền gọi hàm — chỉ người đã đăng nhập. Hàm nào ghi dữ liệu thì tự
--    kiểm tra vai trò bên trong bằng app_require() (17_auth.sql).
-- ---------------------------------------------------------------------
grant execute on function am_norm(text)                                   to authenticated;
grant execute on function am_letters(text)                                to authenticated;
grant execute on function am_format_barcode(text, bigint)                 to authenticated;
grant execute on function am_parse_barcode(text)                          to authenticated;
grant execute on function am_build_asset_code(text, text, text, int, int) to authenticated;
grant execute on function am_alloc_asset_seq(text, text, int, bigint, text) to authenticated;
grant execute on function am_alloc_barcode(text, int, bigint, text)       to authenticated;
grant execute on function am_alloc_alr_code()                             to authenticated;
grant execute on function am_seed_asset_seq(text, text, int)              to authenticated;
grant execute on function am_seed_barcode(text, bigint)                   to authenticated;
grant execute on function am_seed_from_codes(text[])                      to authenticated;
grant execute on function am_audit_counters()                             to authenticated;
grant execute on function am_classify(numeric, text, boolean)             to authenticated;
grant execute on function am_resolve_origin(text)                         to authenticated;

-- Các hàm cấp phát phải thuộc sở hữu của vai trò vượt được RLS
alter function am_alloc_asset_seq(text, text, int, bigint, text) owner to postgres;
alter function am_alloc_barcode(text, int, bigint, text)         owner to postgres;
alter function am_alloc_alr_code()                               owner to postgres;
alter function am_seed_asset_seq(text, text, int)                owner to postgres;
alter function am_seed_barcode(text, bigint)                     owner to postgres;
alter function am_seed_from_codes(text[])                        owner to postgres;


-- ####################################################################
-- ##  13_suggest_terms.sql
-- ####################################################################

-- =====================================================================
-- 13_suggest_terms.sql — GỢI Ý THEO TỪ KHOÁ, KHÔNG PHẢI KHỚP TÊN CHÍNH XÁC
--
-- VÌ SAO: phiếu giao hàng ghi tên là cả một dòng thông số —
--   "RUCKUS ICX 8200 Switch, 48x10/100/1000 Mbps PoE+ ports, 4x25 GbE..."
-- Khớp tên chính xác với am_product không bao giờ chạm tới từ "Switch".
-- Đo trên 73 dòng thật của đợt Sitek: khớp chính xác ra 0 dòng.
--
-- ⚠️ PHẢI khớp theo RANH GIỚI TỪ (\y), không được khớp chuỗi con. Cùng bộ dữ
-- liệu đó, khớp chuỗi con ra 58 dòng nhưng kèm rác trông rất tự tin:
--   "MiVoice Bus License…" -> Vòi / faucet   ("voi" nằm trong "MiVoice")
--   "WatchDog Advance…"    -> Van / Valve    ("van" nằm trong "Advance")
-- Mã danh mục SAI nguy hiểm hơn ô TRỐNG: ô trống thì người duyệt thấy, mã sai
-- thì trôi thẳng vào sổ. Ranh giới từ ra 45 dòng và sạch rác kiểu đó.
--
-- Mỗi gợi ý đều mang theo NGUỒN và MỨC TIN CẬY để người duyệt tự cân nhắc.
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tách am_product thành các từ khoá tra cứu. "Bàn lạnh/Refrigerated table"
-- cho hai từ khoá: "ban lanh" và "refrigerated table".
-- Bỏ từ ngắn hơn 3 ký tự — chúng khớp bừa.
-- ---------------------------------------------------------------------
-- `words` là dạng CHỈ-CHỮ-SỐ, mọi thứ khác thành một khoảng trắng, có đệm hai
-- đầu. So khớp bằng LIKE trên dạng đó cho đúng ngữ nghĩa "ranh giới từ" mà
-- không phải escape ký tự đặc biệt của regex nằm trong chính tên sản phẩm —
-- am_norm KHÔNG bỏ dấu câu, nên tên thật đầy dấu phẩy, ngoặc và gạch chéo.
create or replace view am_product_term with (security_invoker = true) as
  select p.id,
         am_norm(trim(x)) as term,
         ' ' || trim(regexp_replace(am_norm(trim(x)), '[^a-z0-9]+', ' ', 'g')) || ' '
           as term_words,
         length(trim(x))  as term_len,
         p.std_name_vi, p.std_name_en,
         p.default_category, p.default_unit, p.times_used
  from   am_product p,
         lateral regexp_split_to_table(p.raw_name, '/') as x
  where  length(trim(x)) >= 3
    and  trim(regexp_replace(am_norm(trim(x)), '[^a-z0-9]+', ' ', 'g')) <> '';

comment on view am_product_term is
  'am_product tách theo dấu "/" thành từ khoá tra cứu cho am_suggest_lines.';

-- ---------------------------------------------------------------------
-- Gợi ý cho từng tên hàng. Thứ tự ưu tiên, dừng ở nguồn đầu tiên có kết quả:
--   1. am_product khớp CHÍNH XÁC tên     -> cao
--   2. sổ tài sản khớp CHÍNH XÁC tên     -> cao nếu >= 3 dòng làm chứng
--   3. am_product khớp TỪ KHOÁ (dài nhất thắng) -> vừa, hoặc thấp nếu từ ngắn
--   4. không có gì                        -> none, để người dùng tự điền
-- ---------------------------------------------------------------------
-- 11_suggest.sql đã tạo hàm này với BỘ CỘT TRẢ VỀ KHÁC (chưa có std_name,
-- matched_term, confidence). PostgreSQL không cho "create or replace" đổi kiểu
-- trả về — báo 42P13 — nên phải bỏ hàm cũ trước. Bỏ xong là mất quyền đã cấp,
-- vì vậy lệnh grant ở cuối file là bắt buộc, không phải thừa.
drop function if exists am_suggest_lines(text[]);

create or replace function am_suggest_lines(p_names text[])
returns table (
  name              text,
  std_name_vi       text,
  std_name_en       text,
  category_code     text,
  unit_code         text,
  depreciate_months int,
  n                 int,
  src               text,
  matched_term      text,
  confidence        text
)
language sql
stable
as $$
  with want as (
    select distinct x as name,
           am_norm(x) as nrm,
           ' ' || trim(regexp_replace(am_norm(x), '[^a-z0-9]+', ' ', 'g')) || ' ' as words
    from unnest(p_names) as x
    where coalesce(trim(x), '') <> ''
  ),

  -- 1. Ánh xạ sản phẩm do người xác nhận, khớp nguyên tên.
  exact_prod as (
    select w.name, p.std_name_vi, p.std_name_en,
           p.default_category, p.default_unit, p.times_used
    from want w join am_product p on p.raw_name_norm = w.nrm
  ),

  -- 2. Thống kê trên chính sổ tài sản, khớp nguyên tên.
  --    Chỉ gộp theo category_code — gộp thêm đơn vị/khấu hao làm phân mảnh.
  hist as (
    select w.name, a.category_code,
           mode() within group (order by a.unit_code)         as unit_code,
           mode() within group (order by a.depreciate_months) as depreciate_months,
           count(*)::int as n,
           row_number() over (partition by w.name
                              order by count(*) desc, a.category_code) as rk
    from want w
    join am_asset a on am_norm(a.name_vi) = w.nrm
    where a.category_code is not null
    group by w.name, a.category_code
  ),

  -- 3. Từ khoá, khớp theo RANH GIỚI TỪ (qua dạng chỉ-chữ-số có đệm khoảng
  --    trắng). Từ dài thắng, nên "access point" thắng "point".
  term_hit as (
    select w.name, tm.std_name_vi, tm.std_name_en,
           tm.default_category, tm.default_unit, tm.term, tm.term_len,
           row_number() over (partition by w.name
                              order by tm.term_len desc, tm.term) as rk
    from want w
    join am_product_term tm
      on w.words like '%' || tm.term_words || '%'
  )

  select w.name,
         coalesce(ep.std_name_vi, th.std_name_vi),
         coalesce(ep.std_name_en, th.std_name_en),
         coalesce(ep.default_category, h.category_code, th.default_category),
         coalesce(ep.default_unit, h.unit_code, th.default_unit),
         h.depreciate_months,
         coalesce(h.n, ep.times_used, 0)::int,
         case when ep.name is not null then 'product'
              when h.name  is not null then 'history'
              when th.name is not null then 'term'
              else 'none' end,
         th.term,
         case when ep.name is not null              then 'high'
              when h.name is not null and h.n >= 3  then 'high'
              when h.name is not null               then 'medium'
              when th.name is not null and th.term_len >= 6 then 'medium'
              when th.name is not null              then 'low'
              else 'none' end
  from want w
  left join exact_prod ep on ep.name = w.name
  left join hist h        on h.name  = w.name and h.rk = 1
  left join term_hit th   on th.name = w.name and th.rk = 1;
$$;

comment on function am_suggest_lines(text[]) is
  'Gợi ý tên chuẩn / danh mục / đơn vị cho từng tên hàng. Ưu tiên am_product khớp đúng, rồi sổ tài sản, rồi TỪ KHOÁ theo ranh giới từ. Trả kèm nguồn, từ đã khớp và mức tin cậy.';

grant execute on function am_suggest_lines(text[]) to authenticated;
grant select on am_product_term to authenticated;

-- ---------------------------------------------------------------------
-- Ghi nhớ một dòng người dùng đã sửa tay, để lần sau tự điền.
-- Chạy lại với cùng tên thì cập nhật, không nhân đôi.
-- ---------------------------------------------------------------------
create or replace function am_remember_product(
  p_raw_name text, p_std_vi text, p_std_en text,
  p_category text, p_unit text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v text;
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  if coalesce(trim(p_raw_name), '') = '' then
    raise exception 'tên hàng rỗng';
  end if;
  insert into am_product (raw_name_norm, raw_name, std_name_vi, std_name_en,
                          default_category, default_unit, times_used)
  values (am_norm(p_raw_name), trim(p_raw_name),
          coalesce(nullif(trim(p_std_vi), ''), trim(p_raw_name)),
          nullif(trim(p_std_en), ''), p_category, p_unit, 1)
  on conflict (raw_name_norm) do update
    set std_name_vi      = excluded.std_name_vi,
        std_name_en      = coalesce(excluded.std_name_en, am_product.std_name_en),
        default_category = coalesce(excluded.default_category, am_product.default_category),
        default_unit     = coalesce(excluded.default_unit, am_product.default_unit),
        times_used       = am_product.times_used + 1
  returning raw_name into v;
  return v;
end $$;

grant execute on function am_remember_product(text, text, text, text, text)
  to authenticated;


-- ####################################################################
-- ##  14_undo_intake.sql
-- ####################################################################

-- =====================================================================
-- 14_undo_intake.sql — HOÀN TÁC MỘT ĐỢT VỪA GHI VÀO SỔ
--
-- Vì sao phải là HÀM chứ không phải câu DELETE từ trình duyệt: vai `anon`
-- CỐ Ý không có quyền delete trên am_asset (04_rls.sql chỉ cấp select/insert/
-- update). Xoá tài sản là việc phải có luật đi kèm, và luật nằm ở đây:
--
--   1. Chỉ xoá đúng các id được truyền vào.
--   2. KHÔNG xoá dòng lịch sử (is_legacy) — đợt nhập không bao giờ tạo ra
--      chúng, nên nếu id nào là legacy thì đó là nhầm lẫn, phải chặn.
--   3. KHÔNG xoá tài sản đã nằm trên một biên bản tem nhãn đã lưu. Biên bản
--      là chứng từ đã phát hành; xoá tài sản dưới chân nó sẽ để lại một biên
--      bản trỏ vào hư không. Những dòng đó được GIỮ LẠI và báo về.
--
-- BỘ ĐẾM: lùi lại ĐƯỢC, nhưng chỉ khi chắc chắn an toàn. Điều kiện:
--
--   a) Bộ đếm vẫn đứng đúng chỗ đợt này để lại (next = max(seq đã xoá) + 1).
--      Nếu ai đó đã cấp thêm sau mình thì next đã vượt qua — lùi lúc đó sẽ
--      cấp lại số người khác đang dùng. Trường hợp này GIỮ NGUYÊN.
--   b) Không dòng nào trong đợt đã được đánh dấu ĐÃ IN TEM. Xoá dòng trong
--      cơ sở dữ liệu không bóc được cái tem đã dán lên hiện vật; cấp lại số
--      đó sẽ tạo ra hai vật mang cùng một mã.
--
-- Không đủ điều kiện thì bộ đếm đứng yên và dãy số có một khoảng trống — đó là
-- cái giá đúng, vì trùng mã tệ hơn thủng số rất nhiều.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_undo_intake(bigint[]);

create or replace function am_undo_intake(p_ids bigint[])
returns table (deleted int, kept_on_receipt int, kept_legacy int,
               seq_rewound int, seq_held int, barcode_rewound int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_del     int := 0;
  v_receipt int := 0;
  v_legacy  int := 0;
  v_rew     int := 0;
  v_held    int := 0;
  v_bcrew   int := 0;
  v_printed int := 0;
  r         record;
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_ids := app_scope_ids(p_ids);            -- chỉ những dòng trong phạm vi của người gọi
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0, 0, 0, 0, 0;
    return;
  end if;

  -- A printed label cannot be unprinted, so its number must never come back.
  select count(*) into v_printed
  from   am_asset a
  where  a.id = any(p_ids) and a.label_printed;

  -- Snapshot what this batch used, BEFORE deleting it.
  create temp table if not exists _undo_used (
    dept_code text, letters text, seq int, kind text, barcode text
  ) on commit drop;
  delete from _undo_used;
  insert into _undo_used
  select a.dept_code, a.letters, a.seq, a.asset_kind, a.barcode
  from   am_asset a
  where  a.id = any(p_ids)
    and  not a.is_legacy
    and  not exists (select 1 from am_alr_line l where l.asset_id = a.id);

  select count(*) into v_legacy
  from   am_asset a
  where  a.id = any(p_ids) and a.is_legacy;

  select count(distinct l.asset_id) into v_receipt
  from   am_alr_line l
  where  l.asset_id = any(p_ids);

  with gone as (
    delete from am_asset a
    where  a.id = any(p_ids)
      and  not a.is_legacy
      and  not exists (select 1 from am_alr_line l where l.asset_id = a.id)
    returning 1
  )
  select count(*) into v_del from gone;

  /* Rewind each (dept, letters) counter, but ONLY where it still stands exactly
     where this batch left it. If it has moved on, someone allocated after us
     and those numbers are in use — leave it alone and count it as held. */
  if v_printed = 0 then
    for r in
      select u.dept_code, u.letters, min(u.seq) as lo, max(u.seq) as hi
      from   _undo_used u group by u.dept_code, u.letters
    loop
      update am_asset_seq s
         set next_seq = greatest(
               1, coalesce((select max(a.seq) from am_asset a
                            where a.dept_code = r.dept_code
                              and a.letters = r.letters
                              and a.seq > 0), 0) + 1),
             updated_at = now()
       where s.dept_code = r.dept_code
         and s.letters   = r.letters
         and s.next_seq  = r.hi + 1;
      if found then v_rew := v_rew + 1; else v_held := v_held + 1; end if;
    end loop;

    /* Barcodes are one counter per kind. Same test: only rewind when the
       counter is still sitting right after the highest number this batch took. */
    for r in
      select u.kind, count(*) as n,
             max((regexp_replace(u.barcode, '^JVC\.9?', ''))::bigint) as hi
      from   _undo_used u
      where  u.barcode ~ '^JVC\.[0-9]+$'
      group by u.kind
    loop
      update am_barcode_seq b
         set next_val = greatest(1, b.next_val - r.n), updated_at = now()
       where b.kind = r.kind
         and b.next_val = r.hi + 1;
      if found then v_bcrew := v_bcrew + 1; end if;
    end loop;
  else
    select count(distinct (u.dept_code, u.letters)) into v_held from _undo_used u;
  end if;

  return query select v_del, v_receipt, v_legacy, v_rew, v_held, v_bcrew;
end $$;

comment on function am_undo_intake(bigint[]) is
  'Xoá các tài sản vừa ghi bởi một đợt nhập và lùi bộ đếm về nếu an toàn. Giữ lại dòng lịch sử và dòng đã nằm trên biên bản đã lưu. Chỉ lùi bộ đếm khi nó vẫn đứng đúng chỗ đợt này để lại VÀ chưa dòng nào được đánh dấu đã in tem.';

grant execute on function am_undo_intake(bigint[]) to authenticated;


-- ####################################################################
-- ##  15_bulk_edit.sql
-- ####################################################################

-- =====================================================================
-- 15_bulk_edit.sql — SỬA / XOÁ HÀNG LOẠT TRONG SỔ TÀI SẢN
--
-- Vì sao là HÀM chứ không phải PATCH/DELETE thẳng từ trình duyệt:
--
--   * Vai `anon` CỐ Ý không có quyền delete trên am_asset (04_rls.sql).
--   * Đổi PHÒNG BAN không phải là đổi một ô. Ràng buộc am_asset_code_ck bắt
--     buộc  asset_code = dept_code.group.letters.year.seq  — nên một lệnh
--     UPDATE dept_code trần sẽ bị cơ sở dữ liệu ném ra ngay. Mã tài sản MANG
--     mã phòng ban; đổi phòng ban là phải cấp lại mã.
--
-- Do đó hàm này làm đúng việc phải làm, chứ không làm việc dễ:
--
--   1. Vị trí / tình trạng: đổi thẳng, không ảnh hưởng mã.
--   2. Phòng ban: cấp SỐ MỚI từ bộ đếm của (phòng ban mới, CHỮ) và dựng lại
--      asset_code. MÃ VẠCH GIỮ NGUYÊN — mã vạch mới là danh tính vĩnh viễn của
--      hiện vật, còn asset_code là chỗ nó đang thuộc về.
--   3. Mã cũ KHÔNG được trả lại bộ đếm cũ. Số đã cấp coi như đã tiêu; trùng mã
--      tệ hơn thủng số rất nhiều.
--   4. Dòng nào đã in tem thì tem đó giờ sai — label_printed bị đặt lại false
--      để nó quay vào hàng đợi in lại. Hàm trả về số lượng cần in lại.
--   5. Dòng lịch sử (is_legacy) KHÔNG đổi được phòng ban: mã của chúng không
--      theo quy tắc của app nên không dựng lại được. Chúng được bỏ qua và báo về.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_bulk_update(bigint[], text, text, text);

create or replace function am_bulk_update(
  p_ids      bigint[],
  p_location text default null,
  p_dept     text default null,
  p_status   text default null
)
returns table (updated int, recoded int, skipped_legacy int, relabel int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_up      int := 0;
  v_recode  int := 0;
  v_legacy  int := 0;
  v_relabel int := 0;
  r         record;
  v_first   int;
begin
  perform app_require('assets', 'edit');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_ids := app_scope_ids(p_ids);            -- chỉ những dòng trong phạm vi của người gọi
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0, 0, 0; return;
  end if;

  -- Thà không đổi gì còn hơn ghi một mã treo.
  if p_location is not null then
    p_location := upper(trim(p_location));
    if not exists (select 1 from am_location where code = p_location) then
      raise exception 'Mã vị trí % không có trong danh mục', p_location;
    end if;
  end if;
  if p_dept is not null then
    p_dept := upper(trim(p_dept));
    if not exists (select 1 from am_org where code = p_dept and is_department) then
      raise exception 'Mã phòng ban % không có trong danh mục', p_dept;
    end if;
    if p_dept not in (select app_scope_orgs()) then
      raise exception 'Phòng ban % nằm ngoài phạm vi của bạn.', p_dept using errcode = '42501';
    end if;
  end if;

  -- --- 1. Vị trí / tình trạng -----------------------------------------
  if p_location is not null or p_status is not null then
    update am_asset a
       set location_code = coalesce(p_location, a.location_code),
           status_code   = coalesce(p_status,   a.status_code)
     where a.id = any(p_ids);
    get diagnostics v_up = row_count;
  end if;

  -- --- 2. Phòng ban: cấp lại mã ----------------------------------------
  if p_dept is not null then
    select count(*) into v_legacy
    from   am_asset a
    where  a.id = any(p_ids) and a.is_legacy and a.dept_code <> p_dept;

    -- Cấp theo từng khối (phòng ban mới, CHỮ) để bộ đếm chỉ nhích một lần mỗi
    -- khối, rồi rải số liên tiếp theo thứ tự id.
    create temp table if not exists _bulk_recode (
      id bigint primary key, letters text, new_seq int
    ) on commit drop;
    delete from _bulk_recode;

    /* am_letters() on both sides: the counter is keyed by the stripped form
       ('MVT', never 'MVT-QR'), and the code has to be built from the same value
       the number came out of, or am_asset_code_ck will disagree with it. */
    for r in
      select am_letters(a.letters) as letters, count(*) as n
      from   am_asset a
      where  a.id = any(p_ids) and not a.is_legacy and a.dept_code <> p_dept
      group by am_letters(a.letters)
    loop
      v_first := am_alloc_asset_seq(p_dept, r.letters, r.n::int, null::bigint, 'bulk_update');
      insert into _bulk_recode (id, letters, new_seq)
      select a.id, r.letters,
             v_first + (row_number() over (order by a.id))::int - 1
      from   am_asset a
      where  a.id = any(p_ids) and not a.is_legacy
        and  a.dept_code <> p_dept and am_letters(a.letters) = r.letters;
    end loop;

    -- Tem đã in mang mã cũ: đếm TRƯỚC khi ghi đè.
    select count(*) into v_relabel
    from   am_asset a join _bulk_recode b on b.id = a.id
    where  a.label_printed;

    update am_asset a
       set dept_code     = p_dept,
           letters       = b.letters,
           seq           = b.new_seq,
           asset_code    = am_build_asset_code(p_dept, a.group_code, b.letters,
                                               a.purchase_year, b.new_seq),
           label_printed = false
      from _bulk_recode b
     where b.id = a.id;
    get diagnostics v_recode = row_count;

    v_up := greatest(v_up, v_recode);
  end if;

  return query select v_up, v_recode, v_legacy, v_relabel;
end $$;

comment on function am_bulk_update(bigint[], text, text, text) is
  'Sửa vị trí / phòng ban / tình trạng cho nhiều tài sản cùng lúc. Bỏ qua tham số null. Đổi phòng ban sẽ CẤP LẠI mã tài sản (giữ nguyên mã vạch) và đặt lại cờ đã in tem; dòng lịch sử được bỏ qua.';

-- ---------------------------------------------------------------------
-- XOÁ HÀNG LOẠT
--
-- Khác am_undo_intake ở hai chỗ, đều có lý do:
--   * CÓ xoá dòng lịch sử — đây chính là chỗ người dùng dọn các dòng trùng của
--     sổ Beetrack cũ.
--   * KHÔNG lùi bộ đếm. Undo chỉ lùi được vì nó biết chắc đợt vừa ghi là phần
--     đuôi của dãy số; một nhóm dòng chọn tay giữa sổ thì không có gì bảo đảm đó.
-- Vẫn giữ nguyên một luật: không xoá tài sản đã nằm trên biên bản tem nhãn đã
-- lưu, vì biên bản là chứng từ đã phát hành.
-- ---------------------------------------------------------------------
drop function if exists am_bulk_delete(bigint[]);

create or replace function am_bulk_delete(p_ids bigint[])
returns table (deleted int, kept_on_receipt int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_del  int := 0;
  v_keep int := 0;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_ids := app_scope_ids(p_ids);            -- chỉ những dòng trong phạm vi của người gọi
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0; return;
  end if;

  select count(distinct l.asset_id) into v_keep
  from   am_alr_line l where l.asset_id = any(p_ids);

  with gone as (
    delete from am_asset a
    where  a.id = any(p_ids)
      and  not exists (select 1 from am_alr_line l where l.asset_id = a.id)
    returning 1
  )
  select count(*) into v_del from gone;

  return query select v_del, v_keep;
end $$;

comment on function am_bulk_delete(bigint[]) is
  'Xoá nhiều tài sản cùng lúc. Giữ lại dòng đã nằm trên biên bản tem nhãn đã lưu. KHÔNG lùi bộ đếm — số đã cấp coi như đã tiêu.';

grant execute on function am_bulk_update(bigint[], text, text, text) to authenticated;
grant execute on function am_bulk_delete(bigint[]) to authenticated;


-- ####################################################################
-- ##  16_reset_counters.sql
-- ####################################################################

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
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
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

  /* UPDATE rồi INSERT chứ không dùng "on conflict (dept_code, letters)": phần
     RETURNS TABLE ở trên đã biến dept_code và letters thành BIẾN PL/pgSQL, mà
     ô suy diễn chỉ mục của ON CONFLICT lại được đọc như một biểu thức — nên
     Postgres không biết đó là biến hay là cột và báo "column reference is
     ambiguous". Ở đây mọi tham chiếu đều có tiền tố bảng, còn danh sách cột
     của INSERT thì không bao giờ bị đọc là biến. */
  update am_asset_seq s
     set next_seq = p_next, updated_at = now()
   where s.dept_code = p_dept and s.letters = p_letters;

  if not found then
    insert into am_asset_seq (dept_code, letters, next_seq)
    values (p_dept, p_letters, p_next);
  end if;

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

  return query select x.scope, x.old_next, x.new_next, x.moved
               from _reseed x order by x.moved, x.scope;
end $$;

comment on function am_reseed_counters(boolean) is
  'Nạp lại toàn bộ khoá bộ đếm mã tài sản từ am_asset. p_allow_lower=true cho phép KÉO XUỐNG đúng bằng max(seq)+1 sau khi xoá hàng loạt — chỉ dùng khi chắc chắn không có mã nào đã in tem rồi bị xoá.';

grant execute on function am_set_asset_seq(text, text, int) to authenticated;
grant execute on function am_reseed_counters(boolean) to authenticated;


-- ####################################################################
-- ##  17_auth.sql
-- ####################################################################

-- =====================================================================
-- 17_auth.sql — ĐĂNG NHẬP, VAI TRÒ, MA TRẬN QUYỀN, NHẬT KÝ THAY ĐỔI
--
-- Từ file này trở đi app BẮT BUỘC ĐĂNG NHẬP (Supabase Auth, email + mật khẩu).
-- Người chưa đăng nhập (vai `anon`) không đọc, không ghi, không gọi được gì.
--
-- Mô hình:
--   app_user       một dòng cho mỗi tài khoản Auth (tự tạo bằng trigger)
--   app_role       14 vai trò cố định theo pháp nhân SSP / CP / JVC / SYS
--   app_user_role  người × vai trò × PHẠM VI (một nút trong am_org). Một người
--                  giữ được nhiều vai trò, mỗi vai trò một phạm vi riêng.
--   app_module     các khu chức năng của app
--   app_permission vai trò × khu chức năng × 5 quyền, SỬA ĐƯỢC TRONG APP
--   app_audit      mọi thay đổi dữ liệu: ai, lúc nào, bảng nào, trước/sau
--
-- Phạm vi: người dùng thấy các phòng ban nằm DƯỚI nút phạm vi của mình trong
-- cây am_org. Cây giữ nguyên theo cấu trúc pháp lý (PHCL → CP / JVC / SOF);
-- việc JVC quản lý SOF và CP thể hiện bằng phạm vi (vai trò JVC → PHCL),
-- không phải bằng cách dời nút trong cây.
--
-- Kết nối trực tiếp vào database (SQL Editor, migration) luôn được tin cậy —
-- muốn vào đó phải có mật khẩu database. Đó cũng là đường thoát nếu lỡ khoá
-- hết mọi người: không bao giờ có chuyện bị nhốt ngoài dữ liệu của chính mình.
--
-- ⚠ TRIỂN KHAI — đúng thứ tự, không thì app đứng:
--   1. Supabase → Authentication → Users → Add user → Create new user:
--      email công ty + mật khẩu, TICK "Auto Confirm User". Làm cho chính mình
--      trước.
--   2. Chạy file này (và các file 03, 04, 05, 07, 13, 14, 15, 16 đã sửa — hoặc
--      chạy một file gộp MIGRATE_17.sql là đủ).
--   3. Chạy:  select app_bootstrap_admin('email-cua-ban@jvcplaza.vn');
--      → tài khoản đó thành System Admin + AM Coordinator, phạm vi PHCL.
--   4. Commit + push bản app có màn hình đăng nhập. Bản app CŨ (dùng anon key)
--      sẽ không đọc được gì nữa sau bước 2 — nên bước 2 và 4 làm liền nhau.
--   5. Authentication → Sign In / Providers: TẮT "Allow new users to sign up".
--      Tài khoản chỉ do quản trị tạo ở bước 1.
--   6. Authentication → URL Configuration → Site URL:
--      https://rachel-huynh.github.io/PHCL/AssetManagement.html
--      (để link "quên mật khẩu" trong email quay về đúng app).
--
-- Chạy lại nhiều lần vô hại. Ma trận quyền đã sửa trong app KHÔNG bị ghi đè.
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists app_module (
  code     text primary key,
  name_en  text not null,
  name_vi  text not null,
  sort     int  not null default 0
);
comment on table app_module is
  'Khu chức năng của app. Ma trận quyền là vai trò × khu chức năng.';

create table if not exists app_role (
  code          text primary key,
  entity        text not null check (entity in ('SSP', 'CP', 'JVC', 'SYS')),
  name_en       text not null,
  name_vi       text not null,
  prepares      boolean not null default false,
  default_scope text references am_org(code) on update cascade,
  sort          int  not null default 0
);
comment on column app_role.prepares is
  'Vai trò LẬP chứng từ. Người lập không bao giờ tự duyệt chứng từ của chính mình.';
comment on column app_role.default_scope is
  'Phạm vi gợi ý khi gán vai trò. Để trống = phải chọn phòng ban cụ thể (vd nhân viên / trưởng bộ phận).';

create table if not exists app_permission (
  role_code   text not null references app_role(code)   on delete cascade on update cascade,
  module_code text not null references app_module(code) on delete cascade on update cascade,
  can_view    boolean not null default false,
  can_create  boolean not null default false,
  can_edit    boolean not null default false,
  can_approve boolean not null default false,
  can_admin   boolean not null default false,
  primary key (role_code, module_code)
);

create table if not exists app_user (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  full_name  text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table app_user is
  'Một dòng cho mỗi tài khoản Supabase Auth, tạo tự động. active = false là khoá tài khoản mà không xoá lịch sử của người đó.';

create table if not exists app_user_role (
  user_id   uuid not null references app_user(id) on delete cascade,
  role_code text not null references app_role(code) on update cascade,
  scope_org text not null references am_org(code) on update cascade,
  primary key (user_id, role_code, scope_org)
);
comment on column app_user_role.scope_org is
  'Người này thấy mọi phòng ban nằm dưới nút này trong cây am_org (tính cả chính nút đó).';

create table if not exists app_audit (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  user_id  uuid,
  email    text,
  tbl      text not null,
  op       text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  pk       text,
  old_data jsonb,
  new_data jsonb
);
comment on table app_audit is
  'Nhật ký thay đổi. UPDATE chỉ lưu các cột thực sự đổi (old_data/new_data cùng tập khoá). email bắt đầu bằng "sql:" = thay đổi chạy thẳng từ SQL Editor.';
create index if not exists app_audit_at_idx  on app_audit (at desc);
create index if not exists app_audit_tbl_idx on app_audit (tbl, at desc);


-- =====================================================================
-- 2. DỮ LIỆU GỐC
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('assets',   'Assets',                'Tài sản',                  10),
  ('master',   'Master data',           'Danh mục',                 20),
  ('system',   'System',                'Hệ thống',                 30),
  ('security', 'Users & permissions',   'Người dùng & phân quyền',  40),
  -- Các khu của module Quản lý dự án (giai đoạn 2–5). Có sẵn từ bây giờ để
  -- ma trận quyền cấu hình trước được.
  ('budget',   'Budget',                'Ngân sách',                50),
  ('project',  'Projects',              'Dự án',                    60),
  ('approval', 'Approvals',             'Phê duyệt',                70),
  ('payment',  'Payments',              'Thanh toán',               80),
  ('report',   'Reports',               'Báo cáo',                  90)
on conflict (code) do update
  set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('DEPT_STAFF', 'SSP', 'Dept Staff',              'Nhân viên bộ phận',           true,  null,   10),
  ('DEPT_HEAD',  'SSP', 'Dept Head',               'Trưởng bộ phận',              false, null,   20),
  ('DOF',        'SSP', 'Director of Finance',     'Trưởng bộ phận tài chính',    false, 'SOF',  30),
  ('HOTEL_GM',   'SSP', 'Hotel GM',                'GM khách sạn',                false, 'SOF',  40),
  ('PURCHASING', 'SSP', 'Purchasing',              'Thu mua',                     true,  'SOF',  50),
  ('CP_ADMIN',   'CP',  'Office Building Admin',   'Admin cao ốc văn phòng',      true,  'CP',   60),
  ('CP_MAINT',   'CP',  'Maintenance Manager',     'Quản lý bảo trì',             false, 'CP',   70),
  ('CP_HEAD',    'CP',  'Head of Office Building', 'Trưởng cao ốc văn phòng',     false, 'CP',   80),
  ('JVC_ADMIN',  'JVC', 'JVC Admin',               'Admin văn phòng JVC',         true,  'PHCL', 90),
  ('AM_COORD',   'JVC', 'AM Coordinator',          'Điều phối quản lý tài sản',   true,  'PHCL', 100),
  ('AM_EXEC',    'JVC', 'AM Executive',            'Chuyên viên quản lý tài sản', false, 'PHCL', 110),
  ('CHIEF_ACC',  'JVC', 'Chief Accountant',        'Kế toán trưởng',              false, 'PHCL', 120),
  ('JVC_GM',     'JVC', 'JVC GM',                  'GM văn phòng JVC',            false, 'PHCL', 130),
  ('SYS_ADMIN',  'SYS', 'System Admin',            'Quản trị hệ thống',           false, 'PHCL', 900)
on conflict (code) do update
  set entity = excluded.entity, name_en = excluded.name_en, name_vi = excluded.name_vi,
      prepares = excluded.prepares, default_scope = excluded.default_scope, sort = excluded.sort;

/* Ma trận quyền MẶC ĐỊNH. Mỗi chữ là một quyền:
     V xem · C tạo · E sửa · A duyệt · M quản trị (thao tác phá huỷ: xoá hàng
     loạt, đặt lại bộ đếm, sửa quyền...)
   "on conflict do nothing": chạy lại file này KHÔNG ghi đè những gì quản trị
   đã chỉnh trong app. Chỉ thêm ô còn thiếu. */
with grp(role_code, g) as (values
  ('DEPT_STAFF','prep'), ('PURCHASING','prep'), ('CP_ADMIN','prep'), ('JVC_ADMIN','prep'),
  ('DEPT_HEAD','appr'),  ('DOF','appr'),        ('HOTEL_GM','appr'),
  ('CP_MAINT','appr'),   ('CP_HEAD','appr'),    ('CHIEF_ACC','appr'), ('JVC_GM','appr'),
  ('AM_COORD','am'),     ('AM_EXEC','amx')
),
def(g, module_code, f) as (values
  -- Người lập đề xuất
  ('prep','assets','V'),   ('prep','master','V'),   ('prep','budget','VCE'),
  ('prep','project','VCE'),('prep','approval','V'), ('prep','payment','V'),  ('prep','report','V'),
  -- Người duyệt
  ('appr','assets','V'),   ('appr','master','V'),   ('appr','budget','VA'),
  ('appr','project','VA'), ('appr','approval','VA'),('appr','payment','V'),  ('appr','report','V'),
  -- AM Coordinator: vận hành sổ tài sản hằng ngày, lập PA/MC, là bước duyệt
  -- đầu tiên phía JVC, nạp file kế toán
  ('am','assets','VCEM'),  ('am','master','VCE'),   ('am','system','VCE'),
  ('am','budget','VCEA'),  ('am','project','VCEA'), ('am','approval','VA'),
  ('am','payment','VCE'),  ('am','report','V'),
  -- AM Executive: đánh giá và duyệt, sửa được sổ tài sản
  ('amx','assets','VCE'),  ('amx','master','VCE'),  ('amx','system','V'),
  ('amx','budget','VA'),   ('amx','project','VA'),  ('amx','approval','VA'),
  ('amx','payment','V'),   ('amx','report','V')
)
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select grp.role_code, def.module_code,
       def.f like '%V%', def.f like '%C%', def.f like '%E%', def.f like '%A%', def.f like '%M%'
from   grp join def using (g)
on conflict (role_code, module_code) do nothing;

-- System Admin: mọi quyền trên mọi khu.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'SYS_ADMIN', m.code, true, true, true, true, true from app_module m
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 3. HÀM KIỂM TRA QUYỀN
-- =====================================================================

-- Claims của JWT trong request hiện tại; {} khi không có (SQL Editor).
-- nullif vì biến có thể là chuỗi rỗng, mà ''::jsonb là lỗi.
create or replace function app_claims()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

/* Được tin cậy tuyệt đối khi:
     * kết nối thẳng vào database (SQL Editor, migration): mọi request qua
       API đều đăng nhập bằng vai `authenticator`, nên session_user khác nó
       nghĩa là có người cầm mật khẩu database;
     * hoặc request mang service key (chỉ dùng phía server, không bao giờ ở
       trình duyệt).
   session_user KHÔNG đổi bên trong hàm SECURITY DEFINER — current_user mới
   đổi — nên kiểm tra này đúng ở mọi chỗ gọi. */
create or replace function app_trusted()
returns boolean
language sql
stable
as $$
  select session_user <> 'authenticator'
      or app_claims() ->> 'role' = 'service_role'
$$;

-- Tài khoản đang hoạt động và có ít nhất một vai trò.
create or replace function app_is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or exists (select 1
                 from   app_user u
                 join   app_user_role ur on ur.user_id = u.id
                 where  u.id = auth.uid() and u.active)
$$;

-- Có quyền p_action trên khu p_module qua BẤT KỲ vai trò nào không.
create or replace function app_can(p_module text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or exists (
           select 1
           from   app_user u
           join   app_user_role ur on ur.user_id = u.id
           join   app_permission p on p.role_code = ur.role_code
                                  and p.module_code = p_module
           where  u.id = auth.uid()
             and  u.active
             and  case p_action
                    when 'view'    then p.can_view
                    when 'create'  then p.can_create
                    when 'edit'    then p.can_edit
                    when 'approve' then p.can_approve
                    when 'admin'   then p.can_admin
                    else false
                  end)
$$;

-- Dòng đầu tiên của mọi hàm SECURITY DEFINER có ghi dữ liệu.
create or replace function app_require(p_module text, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app_can(p_module, p_action) then
    raise exception 'Không có quyền "%" trên "%". / Permission "%" on "%" is required.',
      p_action, p_module, p_action, p_module
      using errcode = '42501';
  end if;
end $$;

/* Mọi mã phòng ban/đơn vị nằm trong phạm vi của người dùng: các nút phạm vi
   của mọi vai trò, cộng toàn bộ con cháu của chúng trong am_org. */
create or replace function app_scope_orgs()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  with recursive s(code) as (
    select o.code from am_org o where app_trusted()
    union
    select ur.scope_org
    from   app_user_role ur
    join   app_user u on u.id = ur.user_id
    where  u.id = auth.uid() and u.active
    union
    select o.code from am_org o join s on o.parent_code = s.code
  )
  select code from s
$$;

/* Lọc một danh sách id tài sản về những dòng nằm trong phạm vi. Các hàm
   SECURITY DEFINER (sửa/xoá hàng loạt, hoàn tác) chạy vượt RLS, nên phải tự
   lọc — nếu không, người có quyền sửa ở phòng KIT sẽ sửa được tài sản của
   phòng khác chỉ bằng cách gửi id của nó. */
create or replace function app_scope_ids(p_ids bigint[])
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(a.id), '{}'::bigint[])
  from   am_asset a
  where  a.id = any(p_ids)
    and  a.dept_code in (select app_scope_orgs())
$$;

-- Mọi thứ app cần biết về người đang đăng nhập, trong một lần gọi.
create or replace function app_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id',        u.id,
    'email',     u.email,
    'full_name', u.full_name,
    'active',    u.active,
    'roles', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'role', ur.role_code, 'scope', ur.scope_org,
                 'name_en', r.name_en, 'name_vi', r.name_vi, 'entity', r.entity)
               order by r.sort, ur.scope_org)
        from   app_user_role ur join app_role r on r.code = ur.role_code
        where  ur.user_id = u.id), '[]'::jsonb),
    'perms', coalesce((
        select jsonb_object_agg(x.module_code, x.a)
        from (select p.module_code,
                     jsonb_build_object(
                       'view',    bool_or(p.can_view),
                       'create',  bool_or(p.can_create),
                       'edit',    bool_or(p.can_edit),
                       'approve', bool_or(p.can_approve),
                       'admin',   bool_or(p.can_admin)) as a
              from   app_user_role ur
              join   app_permission p on p.role_code = ur.role_code
              where  ur.user_id = u.id and u.active
              group  by p.module_code) x), '{}'::jsonb))
  from app_user u
  where u.id = auth.uid()
$$;

/* Cấp quyền quản trị cho TÀI KHOẢN ĐẦU TIÊN. Chỉ chạy được từ SQL Editor —
   không ai gọi được qua API, kể cả người đã đăng nhập. */
create or replace function app_bootstrap_admin(p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if session_user = 'authenticator' then
    raise exception 'Chỉ chạy được từ SQL Editor của Supabase.' using errcode = '42501';
  end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'Chưa có tài khoản %. Tạo trước ở Authentication → Users → Add user (tick Auto Confirm User).', p_email;
  end if;

  insert into app_user (id, email, full_name)
  values (v_id, lower(trim(p_email)), split_part(lower(trim(p_email)), '@', 1))
  on conflict (id) do update set active = true;

  insert into app_user_role (user_id, role_code, scope_org) values
    (v_id, 'SYS_ADMIN', 'PHCL'),
    (v_id, 'AM_COORD',  'PHCL')
  on conflict do nothing;

  return 'OK: ' || lower(trim(p_email)) || ' = System Admin + AM Coordinator, phạm vi PHCL';
end $$;


-- =====================================================================
-- 4. TÀI KHOẢN AUTH → app_user
-- =====================================================================

create or replace function app_on_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Không có email (vd đăng nhập bằng số điện thoại) thì bỏ qua: nếu để lệnh
  -- insert dưới đây lỗi thì chính việc TẠO TÀI KHOẢN trong Auth cũng hỏng theo.
  if new.email is null then
    return new;
  end if;
  insert into app_user (id, email, full_name)
  values (new.id, lower(new.email),
          coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''),
                   split_part(lower(new.email), '@', 1)))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists app_on_auth_user on auth.users;
create trigger app_on_auth_user
  after insert or update of email on auth.users
  for each row execute function app_on_auth_user();

-- Tài khoản đã tạo TRƯỚC khi có trigger.
insert into app_user (id, email, full_name)
select id, lower(email), split_part(lower(email), '@', 1)
from   auth.users
where  email is not null
on conflict (id) do nothing;


-- =====================================================================
-- 5. NHẬT KÝ THAY ĐỔI
-- =====================================================================

create or replace function app_audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o jsonb;
  n jsonb;
  r jsonb;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new);
    r := n;
  elsif tg_op = 'DELETE' then
    o := to_jsonb(old);
    r := o;
  else
    r := to_jsonb(new);
    o := to_jsonb(old);
    -- Chỉ giữ các cột thực sự đổi. Một lần nạp lại sổ cũ đụng 16.000 dòng mà
    -- phần lớn không đổi gì — những dòng đó không để lại dấu vết nào.
    select jsonb_object_agg(e.key, e.value) into n
    from   jsonb_each(r) e
    where  o -> e.key is distinct from e.value;
    if n is null then
      return null;
    end if;
    select jsonb_object_agg(k, o -> k) into o from jsonb_object_keys(n) k;
  end if;

  insert into app_audit (user_id, email, tbl, op, pk, old_data, new_data)
  values (auth.uid(),
          coalesce(app_claims() ->> 'email',
                   case when app_trusted() then 'sql:' || session_user end),
          tg_table_name,
          tg_op,
          coalesce(r ->> 'id', r ->> 'code', r ->> 'iso2', r ->> 'alias_norm',
                   r ->> 'raw_norm', r ->> 'alias', r ->> 'key',
                   nullif(concat_ws('|', r ->> 'dept_code', r ->> 'letters', r ->> 'kind',
                                         r ->> 'user_id', r ->> 'role_code',
                                         r ->> 'module_code', r ->> 'scope_org'), '')),
          o, n);
  return null;
end $$;

/* Bảng bộ đếm KHÔNG gắn: mỗi lần cấp số đã ghi vào am_counter_log rồi, gắn
   thêm chỉ nhân đôi. am_data_source cũng vậy — bản thân nó đã là nhật ký. */
do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_shipment','am_shipment_line','am_asset','am_alr','am_alr_line',
    'am_xls_template','am_xls_column',
    'app_module','app_role','app_permission','app_user','app_user_role'
  ] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I '
                   'for each row execute function app_audit_row()', t);
  end loop;
end $$;


-- =====================================================================
-- 6. RLS — XOÁ SẠCH POLICY CŨ, DỰNG LẠI TỪ ĐẦU
--
-- Xoá TẤT CẢ policy hiện có trên bảng am_* / app_* thay vì xoá theo tên:
-- chỉ cần sót một policy "for all to anon using (true)" của bản cũ là cả hệ
-- thống mở, vì các policy được OR với nhau.
--
-- Lệnh gọi hàm được bọc trong (select ...) để Postgres tính MỘT lần cho cả
-- câu truy vấn, không phải một lần cho mỗi dòng trong 16.000 dòng.
-- =====================================================================

do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from   pg_policies
    where  schemaname = 'public'
      -- KHÔNG dùng 'app_%': Legal Portal cùng project có bảng app_settings.
      and  (tablename like 'am\_%'
            or tablename in ('app_module', 'app_role', 'app_permission', 'app_user',
                             'app_user_role', 'app_audit'))
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

do $$
declare t text;
begin
  -- Bật RLS trên mọi bảng của app (04 đã bật cho am_*; đây là lưới an toàn).
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_asset_seq','am_barcode_seq','am_counter_log','am_shipment',
    'am_shipment_line','am_asset','am_alr','am_alr_line','am_alr_seq',
    'am_xls_template','am_xls_column','am_data_source',
    'app_module','app_role','app_permission','app_user','app_user_role','app_audit'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;

  -- Danh mục: mọi thành viên đọc được (form nào cũng cần), sửa cần quyền master.
  foreach t in array array[
    'am_org','am_org_alias','am_category_group','am_category','am_unit',
    'am_origin','am_origin_alias','am_origin_rejected','am_location','am_product'
  ] loop
    execute format('create policy %I on %I for select to authenticated using ((select app_is_member()))',
                   t || '_read', t);
    execute format('create policy %I on %I for all to authenticated '
                   'using ((select app_can(''master'', ''edit''))) '
                   'with check ((select app_can(''master'', ''edit'')))',
                   t || '_write', t);
  end loop;

  -- Cấu hình hệ thống: đọc được, sửa cần quyền system.
  foreach t in array array['am_setting','am_xls_template','am_xls_column'] loop
    execute format('create policy %I on %I for select to authenticated using ((select app_is_member()))',
                   t || '_read', t);
    execute format('create policy %I on %I for all to authenticated '
                   'using ((select app_can(''system'', ''edit''))) '
                   'with check ((select app_can(''system'', ''edit'')))',
                   t || '_write', t);
  end loop;

  -- Bộ đếm: chỉ đọc. Ghi chỉ qua hàm SECURITY DEFINER.
  foreach t in array array['am_asset_seq','am_barcode_seq','am_counter_log','am_alr_seq'] loop
    execute format('create policy %I on %I for select to authenticated '
                   'using ((select app_can(''assets'', ''view'')))',
                   t || '_read', t);
  end loop;

  -- Vai trò, khu chức năng, ma trận quyền: ai cũng đọc được (app cần để vẽ
  -- menu), chỉ quản trị sửa.
  foreach t in array array['app_module','app_role','app_permission'] loop
    execute format('create policy %I on %I for select to authenticated using ((select app_is_member()))',
                   t || '_read', t);
    execute format('create policy %I on %I for all to authenticated '
                   'using ((select app_can(''security'', ''admin''))) '
                   'with check ((select app_can(''security'', ''admin'')))',
                   t || '_write', t);
  end loop;
end $$;

-- Nguồn dữ liệu: nhật ký chỉ-thêm của các lần nạp master data.
create policy am_data_source_read on am_data_source
  for select to authenticated using ((select app_is_member()));
create policy am_data_source_add on am_data_source
  for insert to authenticated
  with check ((select app_can('master', 'edit')) or (select app_can('system', 'edit')));

-- Sổ tài sản: theo quyền VÀ theo phạm vi phòng ban. Không có policy DELETE —
-- xoá chỉ qua am_undo_intake / am_bulk_delete.
create policy am_asset_read on am_asset
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and dept_code in (select app_scope_orgs()));
create policy am_asset_add on am_asset
  for insert to authenticated
  with check ((select app_can('assets', 'create'))
              and dept_code in (select app_scope_orgs()));
create policy am_asset_edit on am_asset
  for update to authenticated
  using      ((select app_can('assets', 'edit')) and dept_code in (select app_scope_orgs()))
  with check ((select app_can('assets', 'edit')) and dept_code in (select app_scope_orgs()));

-- Đợt giao hàng và biên bản tem nhãn: phòng ban để trống = đợt nhiều phòng,
-- ai có quyền xem tài sản đều thấy.
create policy am_shipment_read on am_shipment
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and (dept_code is null or dept_code in (select app_scope_orgs())));
create policy am_shipment_write on am_shipment
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

create policy am_shipment_line_read on am_shipment_line
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and exists (select 1 from am_shipment s where s.id = shipment_id));
create policy am_shipment_line_write on am_shipment_line
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

create policy am_alr_read on am_alr
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and (dept_code is null or dept_code in (select app_scope_orgs())));
create policy am_alr_write on am_alr
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

create policy am_alr_line_read on am_alr_line
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and exists (select 1 from am_alr a where a.id = alr_id));
create policy am_alr_line_write on am_alr_line
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

-- Người dùng: mỗi người thấy chính mình; quản trị thấy và sửa tất cả.
create policy app_user_read on app_user
  for select to authenticated
  using (id = auth.uid() or (select app_can('security', 'view')));
create policy app_user_write on app_user
  for all to authenticated
  using ((select app_can('security', 'admin'))) with check ((select app_can('security', 'admin')));

create policy app_user_role_read on app_user_role
  for select to authenticated
  using (user_id = auth.uid() or (select app_can('security', 'view')));
create policy app_user_role_write on app_user_role
  for all to authenticated
  using ((select app_can('security', 'admin'))) with check ((select app_can('security', 'admin')));

-- Nhật ký: chỉ đọc, chỉ người có quyền xem khu phân quyền. Trigger ghi vào
-- bằng quyền của chủ sở hữu nên không cần policy INSERT.
create policy app_audit_read on app_audit
  for select to authenticated using ((select app_can('security', 'view')));


-- =====================================================================
-- 7. VIEW CHẠY BẰNG QUYỀN NGƯỜI GỌI
--
-- Mặc định view chạy bằng quyền CHỦ SỞ HỮU (postgres) và bỏ qua RLS — tức là
-- mọi policy ở trên sẽ vô nghĩa với ai đọc qua view. Các file 05, 07, 13 cũng
-- đã khai báo sẵn tuỳ chọn này, để chạy lại chúng không xoá mất nó.
-- =====================================================================

alter view am_alr_print           set (security_invoker = true);
alter view am_data_source_current set (security_invoker = true);
alter view am_product_term        set (security_invoker = true);


-- =====================================================================
-- 8. QUYỀN CẤP CHO VAI TRÒ DATABASE
-- =====================================================================

/* ⚠ Project Supabase này DÙNG CHUNG với app khác (Công đoàn cd_*, Budget
   Tracker bt_*, SSP Dashboard dashboard_store, Legal Portal, Đối chiếu hoá đơn
   hd_*). Vài app trong số đó KHÔNG có đăng nhập và sống nhờ quyền của anon.
   Vì vậy mọi lệnh ở đây chỉ đụng vào đồ của app này — tên bắt đầu bằng am_ /
   pm_ / app_ (và riêng 6 bảng app_* bên dưới) — KHÔNG BAO GIỜ "all tables in
   schema public", và không đổi default privileges của cả schema.

   app_lock_anon(): tước mọi quyền của anon (và PUBLIC trên hàm) khỏi đồ của app
   này. Gọi ở cuối 17, 18, 19 và mọi file sau, vì default privileges của
   project vẫn tự cấp quyền cho anon trên bảng/hàm mới tạo. */
create or replace function app_lock_anon()
returns void
language plpgsql
set search_path = public
as $$
declare r record;
begin
  for r in
    select c.oid::regclass::text as n, c.relkind
    from   pg_class c join pg_namespace s on s.oid = c.relnamespace
    where  s.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and  (c.relname ~ '^(am|pm)_'
            or c.relname in ('app_module', 'app_role', 'app_permission', 'app_user',
                             'app_user_role', 'app_audit'))
  loop
    execute format(case when r.relkind = 'S' then 'revoke all on sequence %s from anon'
                        else 'revoke all on table %s from anon' end, r.n);
  end loop;
  for r in
    select p.oid::regprocedure::text as n
    from   pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where  s.nspname = 'public' and p.proname ~ '^(am|app|pm)_'
      and  p.proowner = (select oid from pg_roles where rolname = current_user)
  loop
    execute format('revoke execute on function %s from public, anon', r.n);
  end loop;
end $$;
revoke execute on function app_lock_anon() from public, anon;

-- authenticated: gọi được hàm của app (hàm nào ghi dữ liệu thì tự kiểm tra vai
-- trò), dùng được bảng (RLS lọc dòng). Cấp TRƯỚC khi tước của PUBLIC.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as n
    from   pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where  s.nspname = 'public' and p.proname ~ '^(am|app|pm)_'
      and  p.proowner = (select oid from pg_roles where rolname = current_user)
      -- Hàm nội bộ mà 19_pm_workflow.sql cố ý không cho gọi qua API — chạy lại
      -- file này sau 19 không được mở lại chúng.
      and  p.proname not in ('pm_doc_log', 'pm_doc_apply', 'app_user_role_covers',
                             'pm_sig_check', 'pm_notify_trg',
                             'app_bootstrap_admin', 'app_lock_anon')
  loop
    execute format('grant execute on function %s to authenticated', r.n);
  end loop;
end $$;
revoke execute on function app_bootstrap_admin(text) from authenticated;
revoke execute on function app_lock_anon() from authenticated;
select app_lock_anon();

grant select, insert, update, delete on app_module, app_role, app_permission,
                                        app_user, app_user_role to authenticated;
grant select on app_audit to authenticated;
revoke insert, update, delete on app_audit from authenticated;
revoke update, delete on am_data_source from authenticated;
do $$
declare r record;
begin
  for r in select c.oid::regclass::text as n
           from   pg_class c join pg_namespace s on s.oid = c.relnamespace
           where  s.nspname = 'public' and c.relkind = 'S' and c.relname ~ '^(am|app|pm)_'
  loop
    execute format('grant usage, select on sequence %s to authenticated', r.n);
  end loop;
end $$;


-- =====================================================================
-- 9. KIỂM CHỨNG — Supabase SQL Editor chỉ hiện kết quả câu lệnh CUỐI.
-- =====================================================================

-- Chỉ đếm đồ của app này (am_* / pm_* / 6 bảng app_*). Bảng của app khác trong
-- cùng project có luật riêng của chúng — không phải việc của file này.
select 'Bảng của app chưa bật RLS (phải = 0)' as "Mục",
       count(*)::text as "Thực tế", '0' as "Mong đợi",
       case when count(*) = 0 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_tables
where  schemaname = 'public' and not rowsecurity
  and  (tablename ~ '^(am|pm)_' or tablename in ('app_module', 'app_role', 'app_permission',
                                                 'app_user', 'app_user_role', 'app_audit'))
union all
select 'Policy của app mở cho anon (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies
where  schemaname = 'public' and 'anon' = any (roles)
  and  (tablename ~ '^(am|pm)_' or tablename in ('app_module', 'app_role', 'app_permission',
                                                 'app_user', 'app_user_role', 'app_audit'))
union all
select 'Bảng của app anon còn quyền (phải = 0)', count(distinct table_name)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee = 'anon' and table_schema = 'public'
  and  (table_name ~ '^(am|pm)_' or table_name in ('app_module', 'app_role', 'app_permission',
                                                   'app_user', 'app_user_role', 'app_audit'))
union all
select 'Hàm của app anon còn gọi được (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and p.proname ~ '^(am|app|pm)_'
  and  has_function_privilege('anon', p.oid, 'execute')
union all
select 'View của app bỏ qua RLS (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relkind = 'v' and c.relname ~ '^(am|pm)_'
  and  not coalesce(c.reloptions @> array['security_invoker=true'], false)
union all
select 'Vai trò', count(*)::text, '14',
       case when count(*) = 14 then '✔' else '✘ HỎNG' end
from   app_role
union all
select 'Ô ma trận quyền', count(*)::text, '> 0',
       case when count(*) > 0 then '✔' else '✘ HỎNG' end
from   app_permission
union all
select 'Tài khoản đã đồng bộ', count(*)::text, '> 0',
       case when count(*) > 0 then '✔'
            else '✘ Tạo tài khoản ở Authentication → Users trước' end
from   app_user
union all
select 'System Admin', count(*)::text, '>= 1',
       case when count(*) >= 1 then '✔'
            else '✘ Chạy: select app_bootstrap_admin(''email@jvcplaza.vn'');' end
from   app_user_role
where  role_code = 'SYS_ADMIN';

