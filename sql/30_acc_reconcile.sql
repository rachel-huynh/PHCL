-- =====================================================================
-- 30_acc_reconcile.sql — ĐỐI CHIẾU SỔ TÀI SẢN VỚI SỔ KHẤU HAO KẾ TOÁN (26/09/2026)
--
-- Chạy SAU 29_liquidation_bid.sql (không phụ thuộc thanh lý; chỉ cần 01–17).
-- Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Hai sổ RIÊNG, nối bằng một bảng liên kết (quyết định 26/09/2026):
--   sổ tài sản  = hiện vật: mã, mã vạch, tên chuẩn hoá, vị trí, tình trạng (am_asset);
--   sổ kế toán  = tài chính: nguyên giá, kỳ khấu hao, luỹ kế, giá trị còn lại —
--                 nạp mỗi tháng từ 3 file kế toán gửi (TSCĐ, CCDC dài hạn 2422,
--                 trả trước ngắn hạn 2421 — chỉ dòng dụng cụ).
--
--   am_acc_import  mỗi lần nạp một file (kỳ, loại, tên file, thống kê)
--   am_acc_stage   các dòng của lần nạp đang dở
--   am_acc_line    dòng kế toán, trạng thái MỚI NHẤT (khoá ổn định line_key);
--                  so với lần nạp trước: mới / đổi / không còn; đổi → am_acc_change
--   am_acc_link    liên kết NHIỀU–NHIỀU dòng kế toán ↔ tài sản. share (tỷ lệ phân
--                  bổ) để trống: "liên kết trước, phân bổ sau khi đủ thông tin"
--   am_acc_alias   từ điển tên: mô tả của kế toán (đã chuẩn hoá) → tên chuẩn trong
--                  sổ tài sản, học từ mỗi lần AM xác nhận liên kết
--   am_asset.fin_* giá trị CHÍNH THỨC lấy từ kế toán (nguyên giá, ngày bắt đầu
--                  khấu hao, kỳ, tài khoản, GTCL tại kỳ nạp). unit_price (giá tạm
--                  từ PO / nhận hàng) KHÔNG bị ghi đè.
--   fin_status     null = chưa đối chiếu (tài sản tạm) · linked = đã liên kết, chưa
--                  phân bổ được giá trị · booked = đã ghi nhận chính thức ·
--                  off = không có trên sổ kế toán (ghi lý do)
--
-- Cột "Mã TS mới" trong file kế toán: kế toán dán mã tài sản app xuất ra (đồng ý
-- 26/09/2026). Lần nạp sau, dòng có mã được TỰ LIÊN KẾT.
--
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

alter table am_asset add column if not exists fin_status  text;
alter table am_asset add column if not exists fin_cost    numeric(18, 2);
alter table am_asset add column if not exists fin_start   date;
alter table am_asset add column if not exists fin_term    int;
alter table am_asset add column if not exists fin_account text;
alter table am_asset add column if not exists fin_nbv     numeric(18, 2);
alter table am_asset add column if not exists fin_as_of   date;
alter table am_asset add column if not exists fin_note    text;
alter table am_asset add column if not exists no_label    boolean not null default false;
alter table am_asset drop constraint if exists am_asset_fin_status_ck;
alter table am_asset add constraint am_asset_fin_status_ck check (fin_status is null or fin_status in ('linked', 'booked', 'off'));
comment on column am_asset.fin_status is 'Đối chiếu kế toán: null = tạm / chưa đối chiếu · linked = đã liên kết, chưa phân bổ · booked = đã ghi nhận chính thức · off = không có trên sổ kế toán.';
comment on column am_asset.no_label is 'Tài sản không dán tem (phần mềm, cải tạo, chi phí di dời gắn với dự án…): có trong sổ tài sản để khớp sổ kế toán, không in tem.';

create table if not exists am_acc_import (
  id          bigserial primary key,
  kind        text not null check (kind in ('fa', 'ccdc', 'st')),
  period      date not null,
  file_name   text,
  sheet       text,
  status      text not null default 'loading' check (status in ('loading', 'done', 'failed')),
  rows_in     int  not null default 0,
  stats       jsonb not null default '{}'::jsonb,
  imported_by uuid default auth.uid(),
  imported_name text,
  imported_at timestamptz not null default now()
);

create table if not exists am_acc_stage (
  import_id bigint not null references am_acc_import(id) on delete cascade,
  n         int not null,
  row       jsonb not null,
  done      boolean not null default false,
  primary key (import_id, n)
);
alter table am_acc_stage add column if not exists done boolean not null default false;
create index if not exists am_acc_stage_key_idx on am_acc_stage (import_id, (row ->> 'line_key'));

create table if not exists am_acc_line (
  id             bigserial primary key,
  kind           text not null check (kind in ('fa', 'ccdc', 'st')),
  line_key       text not null,
  src_row        int,                        -- số dòng trong file kế toán (lần nạp mới nhất)
  acc_code       text,                       -- cột "Mã TS mới" trong file kế toán
  entity         text,                       -- S / C / J
  dept           text,                       -- Tổ chức
  grp            text,                       -- Nhóm (T, I, E, O…)
  loai           text,
  acct_debit     text, acct_credit text, acct_cost text,
  description    text not null,
  qty            numeric(18, 3),
  unit           text,
  unit_price     numeric(18, 2),
  cost           numeric(18, 2),             -- nguyên giá (VND)
  start_date     date,                       -- ngày đưa vào sử dụng / bắt đầu phân bổ
  term_months    int,
  monthly        numeric(18, 2),
  accum          numeric(18, 2),
  nbv            numeric(18, 2),             -- giá trị còn lại tại kỳ nạp
  docs           text,                       -- số chứng từ / mã dự án
  project_code   text,                       -- mã dự án FFE… tách từ chứng từ / dự án / hợp đồng
  tax_code       text, supplier text, contract text, location text,
  liquidation_no text,
  first_seen     date not null,
  last_seen      date not null,
  status         text not null default 'active' check (status in ('active', 'gone')),
  scope          text not null default 'in' check (scope in ('in', 'skip')),
  skip_reason    text,
  updated_at     timestamptz not null default now(),
  unique (kind, line_key)
);
create index if not exists am_acc_line_project_idx on am_acc_line (project_code);
create index if not exists am_acc_line_code_idx on am_acc_line (acc_code) where acc_code is not null;

create table if not exists am_acc_change (
  id       bigserial primary key,
  line_id  bigint not null references am_acc_line(id) on delete cascade,
  period   date not null,
  field    text not null,
  old_val  text,
  new_val  text,
  at       timestamptz not null default now()
);
create index if not exists am_acc_change_line_idx on am_acc_change (line_id, period);

create table if not exists am_acc_link (
  line_id    bigint not null references am_acc_line(id) on delete cascade,
  asset_id   bigint not null references am_asset(id) on delete cascade,
  share      numeric(9, 6) check (share is null or (share >= 0 and share <= 1)),
  method     text not null default 'manual' check (method in ('manual', 'code', 'intake')),
  note       text,
  linked_by  uuid default auth.uid(),
  linked_name text,
  linked_at  timestamptz not null default now(),
  primary key (line_id, asset_id)
);
create index if not exists am_acc_link_asset_idx on am_acc_link (asset_id);

create table if not exists am_acc_alias (
  desc_norm text primary key,
  name      text not null,
  hits      int not null default 1,
  updated_at timestamptz not null default now()
);


-- =====================================================================
-- 2. HÀM PHỤ
-- =====================================================================

create or replace function am_acc_need(p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app_can('assets', p_action) then
    raise exception 'Cần quyền "%" của khu Tài sản. / Assets "%" right required.', p_action, p_action using errcode = '42501';
  end if;
end $$;

/* Giá trị chính thức của một tài sản, tính lại từ các liên kết:
   - dòng kế toán chỉ liên kết với tài sản này → cả dòng;
   - dòng liên kết nhiều tài sản → phần share (khi đã phân bổ); chưa phân bổ → chưa biết;
   - nhiều dòng liên kết với tài sản (CCDC tách từng cái) → cộng lại. */
create or replace function am_acc_refresh(p_assets bigint[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare a bigint; r record;
begin
  foreach a in array coalesce(p_assets, '{}') loop
    select count(*) as n,
           bool_or(k.share is null and (select count(*) from am_acc_link x where x.line_id = k.line_id) > 1) as unknown,
           sum(l.cost * case when (select count(*) from am_acc_link x where x.line_id = k.line_id) = 1 then 1 else k.share end) as cost,
           sum(l.nbv  * case when (select count(*) from am_acc_link x where x.line_id = k.line_id) = 1 then 1 else k.share end) as nbv,
           min(l.start_date) as start, max(l.term_months) as term, max(l.last_seen) as as_of,
           string_agg(distinct l.acct_debit, ', ') as acct
      into r
      from am_acc_link k join am_acc_line l on l.id = k.line_id
     where k.asset_id = a;
    update am_asset set
      fin_status  = case when fin_status = 'off' and r.n = 0 then 'off' when r.n = 0 then null when r.unknown then 'linked' else 'booked' end,
      fin_cost    = case when r.n > 0 and not r.unknown then round(r.cost, 2) end,
      fin_nbv     = case when r.n > 0 and not r.unknown then round(r.nbv, 2) end,
      fin_start   = case when r.n > 0 then r.start end,
      fin_term    = case when r.n > 0 then r.term end,
      fin_account = case when r.n > 0 then r.acct end,
      fin_as_of   = case when r.n > 0 then r.as_of end
     where id = a;
  end loop;
end $$;

-- Dòng có cột "Mã TS mới": mỗi mã tài sản / mã vạch trong ô (cách nhau ; , xuống dòng) → liên kết.
create or replace function am_acc_autolink(p_lines bigint[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare l am_acc_line; tok text; n int := 0; v_ids bigint[] := '{}'; v_a bigint;
begin
  for l in select * from am_acc_line where id = any(coalesce(p_lines, '{}')) and coalesce(acc_code, '') <> '' loop
    foreach tok in array regexp_split_to_array(upper(l.acc_code), '[;,\s]+') loop
      continue when tok = '';
      select id into v_a from am_asset where upper(asset_code) = tok or upper(barcode) = tok limit 1;
      continue when v_a is null;
      insert into am_acc_link (line_id, asset_id, method, linked_name) values (l.id, v_a, 'code', 'file kế toán')
      on conflict do nothing;
      if found then n := n + 1; end if;
      v_ids := v_ids || v_a;
    end loop;
  end loop;
  perform am_acc_refresh(v_ids);
  return n;
end $$;


-- =====================================================================
-- 3. NẠP FILE THEO THÁNG
-- =====================================================================

create or replace function am_acc_import_begin(p_kind text, p_period date, p_file text, p_sheet text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v bigint; v_last date;
begin
  perform am_acc_need('edit');
  if p_kind not in ('fa', 'ccdc', 'st') then raise exception 'Loại file không hợp lệ: %', p_kind; end if;
  if p_period is null then raise exception 'Chưa có kỳ của file.'; end if;
  select max(period) into v_last from am_acc_import where kind = p_kind and status = 'done';
  if v_last is not null and p_period < v_last then
    raise exception 'File kỳ % cũ hơn lần nạp gần nhất (%). / Older than the last import.', to_char(p_period, 'MM/YYYY'), to_char(v_last, 'MM/YYYY');
  end if;
  delete from am_acc_import where kind = p_kind and status = 'loading' and imported_at < now() - interval '1 hour';
  insert into am_acc_import (kind, period, file_name, sheet, imported_name)
  values (p_kind, date_trunc('month', p_period)::date + interval '1 month - 1 day', left(p_file, 200), left(p_sheet, 100),
          coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
  returning id into v;
  return v;
end $$;

create or replace function am_acc_import_rows(p_import bigint, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n0 int;
begin
  perform am_acc_need('edit');
  if not exists (select 1 from am_acc_import where id = p_import and status = 'loading') then raise exception 'Lần nạp % không còn mở.', p_import; end if;
  select coalesce(max(n), 0) into n0 from am_acc_stage where import_id = p_import;
  insert into am_acc_stage (import_id, n, row)
  select p_import, n0 + ord::int, r from jsonb_array_elements(p_rows) with ordinality x(r, ord);
  return jsonb_array_length(p_rows);
end $$;

/* Áp lần nạp, TỪNG LÔ (p_limit dòng mỗi lần gọi — một lần gọi phải xong trong
   giới hạn thời gian của API). Trả {more: true, left} khi còn dòng; lần cuối trả
   thống kê. So từng dòng với trạng thái đã có (theo line_key):
   - có rồi: cập nhật; đổi nguyên giá / kỳ / bộ phận / ngày / số thanh lý / mã TS → ghi am_acc_change;
   - chưa có: thử khớp một dòng CŨ không còn trong file này, cùng bộ phận + nguyên giá +
     ngày (kế toán chỉ sửa mô tả) → giữ dòng cũ, đổi khoá, giữ liên kết; không thì thêm mới;
   - lần cuối: dòng cũ không còn trong file → "không còn" (gone); dòng có "Mã TS mới"
     → tự liên kết; giá trị chính thức của tài sản đã liên kết tính lại. */
create or replace function am_acc_import_finish(p_import bigint, p_limit int default 600)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare im am_acc_import; s record; r jsonb; l am_acc_line; v_new int := 0; v_chg int := 0; v_same int := 0; v_rekey int := 0;
        v_gone int := 0; v_auto int := 0; v_left int; f text; o text; nv text; v_diff boolean; st jsonb;
begin
  perform am_acc_need('edit');
  select * into im from am_acc_import where id = p_import for update;
  if im.id is null or im.status <> 'loading' then raise exception 'Lần nạp % không còn mở.', p_import; end if;
  for s in select n, row from am_acc_stage where import_id = im.id and not done order by n limit greatest(50, least(coalesce(p_limit, 600), 2000)) loop
    r := s.row;
    select * into l from am_acc_line where kind = im.kind and line_key = r ->> 'line_key';
    if l.id is null then
      -- Kế toán sửa mô tả: một dòng cũ chưa thấy trong lần nạp này, cùng bộ phận, nguyên giá, ngày.
      select * into l from am_acc_line x
       where x.kind = im.kind and x.last_seen < im.period and x.status = 'active'
         and coalesce(x.dept, '') = coalesce(r ->> 'dept', '') and x.start_date is not distinct from nullif(r ->> 'start_date', '')::date
         and round(coalesce(x.cost, 0)) = round(coalesce(nullif(r ->> 'cost', '')::numeric, 0)) and coalesce(x.cost, 0) <> 0
         and not exists (select 1 from am_acc_stage t where t.import_id = im.id and (t.row ->> 'line_key') = x.line_key)
       order by x.id limit 1;
      if l.id is not null then
        insert into am_acc_change (line_id, period, field, old_val, new_val) values (l.id, im.period, 'description', l.description, r ->> 'description');
        update am_acc_line set line_key = r ->> 'line_key' where id = l.id;
        v_rekey := v_rekey + 1;
      end if;
    end if;
    if l.id is null then
      insert into am_acc_line (kind, line_key, first_seen, last_seen, description, scope, skip_reason)
      values (im.kind, r ->> 'line_key', im.period, im.period, coalesce(r ->> 'description', ''),
              case when coalesce(r ->> 'skip', '') <> '' then 'skip' else 'in' end, nullif(r ->> 'skip', ''))
      returning * into l;
      v_new := v_new + 1;
    else
      v_diff := false;
      foreach f in array array['cost', 'term_months', 'dept', 'start_date', 'liquidation_no', 'acc_code'] loop
        o := case f when 'cost' then round(l.cost)::text when 'term_months' then l.term_months::text when 'dept' then l.dept
                    when 'start_date' then l.start_date::text when 'liquidation_no' then l.liquidation_no else l.acc_code end;
        nv := case f when 'cost' then round(nullif(r ->> 'cost', '')::numeric)::text
                     when 'term_months' then round(nullif(r ->> 'term_months', '')::numeric)::text else nullif(r ->> f, '') end;
        if o is distinct from nv then
          insert into am_acc_change (line_id, period, field, old_val, new_val) values (l.id, im.period, f, o, nv);
          v_diff := true;
        end if;
      end loop;
      if l.status = 'gone' then insert into am_acc_change (line_id, period, field, old_val, new_val) values (l.id, im.period, 'status', 'gone', 'active'); v_diff := true; end if;
      if v_diff then v_chg := v_chg + 1; else v_same := v_same + 1; end if;
    end if;
    update am_acc_line set
      src_row = nullif(r ->> 'src_row', '')::int, acc_code = nullif(r ->> 'acc_code', ''), entity = nullif(r ->> 'entity', ''),
      dept = nullif(r ->> 'dept', ''), grp = nullif(r ->> 'grp', ''), loai = nullif(r ->> 'loai', ''),
      acct_debit = nullif(r ->> 'acct_debit', ''), acct_credit = nullif(r ->> 'acct_credit', ''), acct_cost = nullif(r ->> 'acct_cost', ''),
      description = coalesce(nullif(r ->> 'description', ''), description), qty = nullif(r ->> 'qty', '')::numeric, unit = nullif(r ->> 'unit', ''),
      unit_price = nullif(r ->> 'unit_price', '')::numeric, cost = nullif(r ->> 'cost', '')::numeric,
      start_date = nullif(r ->> 'start_date', '')::date, term_months = round(nullif(r ->> 'term_months', '')::numeric)::int,
      monthly = nullif(r ->> 'monthly', '')::numeric, accum = nullif(r ->> 'accum', '')::numeric, nbv = nullif(r ->> 'nbv', '')::numeric,
      docs = nullif(r ->> 'docs', ''), project_code = nullif(r ->> 'project_code', ''), tax_code = nullif(r ->> 'tax_code', ''),
      supplier = nullif(r ->> 'supplier', ''), contract = nullif(r ->> 'contract', ''), location = nullif(r ->> 'location', ''),
      liquidation_no = nullif(r ->> 'liquidation_no', ''), last_seen = im.period, status = 'active', updated_at = now()
    where id = l.id;
    update am_acc_stage set done = true where import_id = im.id and n = s.n;
  end loop;
  -- Cộng dồn thống kê qua các lô.
  st := jsonb_build_object('new', coalesce((im.stats ->> 'new')::int, 0) + v_new, 'changed', coalesce((im.stats ->> 'changed')::int, 0) + v_chg,
                           'same', coalesce((im.stats ->> 'same')::int, 0) + v_same, 'rekeyed', coalesce((im.stats ->> 'rekeyed')::int, 0) + v_rekey);
  select count(*) into v_left from am_acc_stage where import_id = im.id and not done;
  if v_left > 0 then
    update am_acc_import set stats = st where id = im.id;
    return st || jsonb_build_object('more', true, 'left', v_left);
  end if;
  -- Lô cuối: dòng không còn trong file.
  with g as (
    update am_acc_line set status = 'gone', updated_at = now()
     where kind = im.kind and status = 'active' and last_seen < im.period
    returning id)
  insert into am_acc_change (line_id, period, field, old_val, new_val) select id, im.period, 'status', 'active', 'gone' from g;
  get diagnostics v_gone = row_count;
  v_auto := am_acc_autolink(array(select id from am_acc_line where kind = im.kind and last_seen = im.period and coalesce(acc_code, '') <> ''));
  -- Giá trị chính thức của các tài sản đã liên kết đi theo số liệu mới.
  perform am_acc_refresh(array(select distinct k.asset_id from am_acc_link k join am_acc_line l2 on l2.id = k.line_id where l2.kind = im.kind));
  select count(*) into v_left from am_acc_stage where import_id = im.id;
  delete from am_acc_stage where import_id = im.id;
  st := st || jsonb_build_object('gone', v_gone, 'autolinked', v_auto);
  update am_acc_import set status = 'done', rows_in = v_left, stats = st where id = im.id;
  return st || jsonb_build_object('more', false);
end $$;



-- =====================================================================
-- 4. LIÊN KẾT, PHÂN BỔ, PHẠM VI
-- =====================================================================

-- p_pairs = [{line_id, asset_id}]: liên kết; học từ điển tên (mô tả kế toán → tên chuẩn).
create or replace function am_acc_link_set(p_pairs jsonb, p_method text default 'manual')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare x jsonb; n int := 0; v_ids bigint[] := '{}'; v_name text; v_desc text;
begin
  perform am_acc_need('edit');
  for x in select * from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    insert into am_acc_link (line_id, asset_id, method, linked_name)
    values ((x ->> 'line_id')::bigint, (x ->> 'asset_id')::bigint, case when p_method = 'intake' then 'intake' else 'manual' end,
            coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
    on conflict do nothing;
    if found then n := n + 1; end if;
    v_ids := v_ids || (x ->> 'asset_id')::bigint;
    v_desc := nullif(x ->> 'desc_norm', '');      -- chuẩn hoá bên app (cùng một hàm khi tra lại)
    select concat_ws('/', name_vi, name_en) into v_name from am_asset where id = (x ->> 'asset_id')::bigint;
    if coalesce(v_desc, '') <> '' and coalesce(v_name, '') <> '' then
      insert into am_acc_alias (desc_norm, name) values (v_desc, v_name)
      on conflict (desc_norm) do update set name = excluded.name, hits = am_acc_alias.hits + 1, updated_at = now();
    end if;
  end loop;
  update am_asset set fin_note = null where id = any(v_ids) and fin_status = 'off';
  update am_asset set fin_status = null where id = any(v_ids) and fin_status = 'off';
  perform am_acc_refresh(v_ids);
  return n;
end $$;

create or replace function am_acc_unlink(p_pairs jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare x jsonb; n int := 0; v_ids bigint[] := '{}';
begin
  perform am_acc_need('edit');
  for x in select * from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    delete from am_acc_link where line_id = (x ->> 'line_id')::bigint and asset_id = (x ->> 'asset_id')::bigint;
    if found then n := n + 1; end if;
    v_ids := v_ids || (x ->> 'asset_id')::bigint;
  end loop;
  -- Phân bổ của các dòng bị bỏ bớt tài sản không còn đúng: xoá, phân bổ lại khi cần.
  update am_acc_link set share = null where line_id in (select (x ->> 'line_id')::bigint from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) x);
  perform am_acc_refresh(v_ids || array(select asset_id from am_acc_link where line_id in
    (select (x ->> 'line_id')::bigint from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) x)));
  return n;
end $$;

/* Phân bổ một dòng gộp cho các tài sản đã liên kết (khi đã đủ thông tin):
   p_mode 'price' — theo giá tạm (đơn giá × SL trong sổ tài sản); 'equal' — chia đều;
   'manual' — p_shares {asset_id: tỷ lệ}, cộng lại = 1; 'clear' — bỏ phân bổ. */
create or replace function am_acc_allocate(p_line bigint, p_mode text, p_shares jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_tot numeric; v_n int; v_sum numeric;
begin
  perform am_acc_need('edit');
  select count(*) into v_n from am_acc_link where line_id = p_line;
  if v_n = 0 then raise exception 'Dòng chưa liên kết tài sản nào.'; end if;
  if p_mode = 'clear' then
    update am_acc_link set share = null where line_id = p_line;
  elsif p_mode = 'equal' then
    update am_acc_link set share = round(1.0 / v_n, 6) where line_id = p_line;
  elsif p_mode = 'price' then
    select sum(coalesce(a.unit_price, 0) * coalesce(a.qty, 1)) into v_tot from am_acc_link k join am_asset a on a.id = k.asset_id where k.line_id = p_line;
    if coalesce(v_tot, 0) <= 0 then raise exception 'Các tài sản chưa có giá tạm — chia đều hoặc nhập tỷ lệ.'; end if;
    update am_acc_link k set share = round(coalesce(a.unit_price, 0) * coalesce(a.qty, 1) / v_tot, 6)
      from am_asset a where a.id = k.asset_id and k.line_id = p_line;
  elsif p_mode = 'manual' then
    select sum((value)::numeric) into v_sum from jsonb_each_text(coalesce(p_shares, '{}'::jsonb));
    if abs(coalesce(v_sum, 0) - 1) > 0.001 then raise exception 'Tổng tỷ lệ phải bằng 100%% (đang %).', round(coalesce(v_sum, 0) * 100, 2); end if;
    update am_acc_link k set share = (p_shares ->> k.asset_id::text)::numeric where k.line_id = p_line;
  else raise exception 'Cách phân bổ không hợp lệ: %', p_mode;
  end if;
  perform am_acc_refresh(array(select asset_id from am_acc_link where line_id = p_line));
end $$;

-- Đưa dòng kế toán ra / vào phạm vi đối chiếu (hoa hồng, bảo hiểm, quyền sử dụng đất… thì bỏ qua).
create or replace function am_acc_scope(p_lines bigint[], p_skip boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform am_acc_need('edit');
  if p_skip and coalesce(trim(p_reason), '') = '' then raise exception 'Ghi lý do bỏ qua.'; end if;
  update am_acc_line set scope = case when p_skip then 'skip' else 'in' end, skip_reason = case when p_skip then trim(p_reason) end,
                         updated_at = now()
   where id = any(coalesce(p_lines, '{}'));
end $$;

-- Tài sản KHÔNG có trên sổ kế toán (hạch toán chi phí, dưới ngưỡng…): ghi lý do; p_off = false: bỏ đánh dấu.
create or replace function am_acc_asset_off(p_assets bigint[], p_off boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform am_acc_need('edit');
  if p_off and coalesce(trim(p_note), '') = '' then raise exception 'Ghi lý do tài sản không có trên sổ kế toán.'; end if;
  if p_off and exists (select 1 from am_acc_link where asset_id = any(coalesce(p_assets, '{}'))) then
    raise exception 'Tài sản đã liên kết với sổ kế toán — bỏ liên kết trước.';
  end if;
  update am_asset set fin_status = case when p_off then 'off' end, fin_note = case when p_off then trim(p_note) end
   where id = any(coalesce(p_assets, '{}')) and (p_off or fin_status = 'off');
end $$;


-- =====================================================================
-- 5. RLS, QUYỀN
-- =====================================================================

alter table am_acc_import enable row level security;
alter table am_acc_stage  enable row level security;
alter table am_acc_line   enable row level security;
alter table am_acc_change enable row level security;
alter table am_acc_link   enable row level security;
alter table am_acc_alias  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['am_acc_import', 'am_acc_line', 'am_acc_change', 'am_acc_link', 'am_acc_alias'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using ((select app_can(''assets'', ''view'')))', t || '_read', t);
  end loop;
end $$;

revoke all on am_acc_import, am_acc_stage, am_acc_line, am_acc_change, am_acc_link, am_acc_alias from anon;
revoke all on am_acc_stage from authenticated;
grant select on am_acc_import, am_acc_line, am_acc_change, am_acc_link, am_acc_alias to authenticated;
revoke insert, update, delete on am_acc_import, am_acc_line, am_acc_change, am_acc_link, am_acc_alias from authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    foreach t in array array['am_acc_link'] loop
      execute format('drop trigger if exists app_audit on %I', t);
      execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
    end loop;
  end if;
end $$;

revoke execute on function am_acc_need(text), am_acc_refresh(bigint[]), am_acc_autolink(bigint[]),
                           am_acc_import_begin(text, date, text, text), am_acc_import_rows(bigint, jsonb), am_acc_import_finish(bigint, int),
                           am_acc_link_set(jsonb, text), am_acc_unlink(jsonb), am_acc_allocate(bigint, text, jsonb),
                           am_acc_scope(bigint[], boolean, text), am_acc_asset_off(bigint[], boolean, text)
  from public, anon;
grant execute on function am_acc_import_begin(text, date, text, text), am_acc_import_rows(bigint, jsonb),
                          am_acc_import_finish(bigint, int), am_acc_link_set(jsonb, text), am_acc_unlink(jsonb),
                          am_acc_allocate(bigint, text, jsonb), am_acc_scope(bigint[], boolean, text), am_acc_asset_off(bigint[], boolean, text)
  to authenticated;
-- Nội bộ: tính lại giá trị / tự liên kết chỉ chạy bên trong các hàm trên.
revoke execute on function am_acc_refresh(bigint[]), am_acc_autolink(bigint[]), am_acc_need(text) from authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Bảng đối chiếu kế toán có RLS' as "Mục", count(*)::text as "Thực tế", '6' as "Mong đợi",
       case when count(*) = 6 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('am_acc_import', 'am_acc_stage', 'am_acc_line', 'am_acc_change', 'am_acc_link', 'am_acc_alias') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng đối chiếu (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name like 'am\_acc\_%' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Cột giá trị chính thức trên tài sản (fin_*, no_label)', count(*)::text, '9', case when count(*) = 9 then '✔' else '✘ HỎNG' end
from   information_schema.columns where table_name = 'am_asset' and (column_name like 'fin\_%' or column_name = 'no_label')
union all
select 'Hàm nạp / liên kết / phân bổ', count(*)::text, '8', case when count(*) = 8 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('am_acc_import_begin', 'am_acc_import_rows', 'am_acc_import_finish', 'am_acc_link_set', 'am_acc_unlink',
                                 'am_acc_allocate', 'am_acc_scope', 'am_acc_asset_off');
