-- =====================================================================
-- 32_price_db.sql — CƠ SỞ DỮ LIỆU GIÁ THAM CHIẾU (26/09/2026)
--
-- Chạy SAU 31_asset_ops.sql (đọc pm_doc, pm_tender*, am_shipment, am_asset).
-- Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Mục đích: tra cứu, so sánh giá — KHÁC sổ tài sản. Phạm vi: vật tư kỹ thuật
-- và FF&E như file "Reference Pricing List" (quyết định 26/09/2026).
--
--   pr_source   một NGUỒN giá: báo giá (trúng hay không), market check, hồ sơ
--               dự thầu, QC, PO, phiếu nhận hàng, dữ liệu Excel cũ.
--   pr_line     từng dòng giá của nguồn: tên gốc, tên chuẩn (gán dần), nhóm,
--               hãng, model, thông số, SL, đơn vị gốc / chuẩn, đơn giá vật tư +
--               nhân công, giá quy đổi VND chưa VAT / đơn vị (price_vnd).
--   pr_unit     bảng quy đổi đơn vị (cái/pcs, bộ/set, m²/m2, mét/md …); đơn vị
--               trọn gói (gói / lô / hệ …) đánh dấu lump = không so theo đơn giá.
--   pr_alias    tên gốc (chuẩn hoá) → tên chuẩn, học từ mỗi lần QLTS gán tên,
--               áp lại cho mọi dòng cũ và mới.
--
-- Nguồn tự động (pr_sync): QC (mọi nhà cung cấp; A đã duyệt = trúng), MC (giá
-- lịch sử B, giá thị trường C), PO (giá chốt), hồ sơ dự thầu đã mở niêm phong,
-- phiếu nhận hàng (giá mua thực tế). Nguồn tay: Excel cũ, báo giá nhập bằng
-- JSON (AI trích như phiếu giao hàng).
--
-- Quyền (quyết định 26/09/2026): nhóm QLTS nhập (khu "price": C/E); mọi bộ
-- phận xem giá tham chiếu (V) — KHÔNG thấy tên nhà cung cấp: bảng chỉ đọc được
-- khi có quyền nhập; người chỉ xem tra qua pr_search() (ẩn nhà cung cấp, liên
-- hệ, file). Giá bán thanh lý KHÔNG đưa vào đây (đã có ở module Thanh lý).
--
-- File báo giá: để trên OneDrive, lưu link (file_url) hoặc tên file ghép với
-- đường dẫn thư mục ở am_setting 'pr_quotes_base_url'.
--
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. KHU QUYỀN
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('price', 'Price reference', 'CSDL giá tham chiếu', 88)
on conflict (code) do update set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

-- QLTS nhập / sửa; mọi vai trò khác chỉ xem giá tham chiếu. "do nothing": ô đã chỉnh ở màn Phân quyền giữ nguyên.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select r.code, 'price', true,
       r.code in ('AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       r.code in ('AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       false,
       r.code in ('AM_COORD', 'SYS_ADMIN')
from   app_role r
on conflict (role_code, module_code) do nothing;

insert into am_setting (key, value, note) values
  ('pr_quotes_base_url', '""'::jsonb,
   'CSDL giá: đường dẫn thư mục báo giá trên OneDrive/SharePoint (vd https://…/QUOTES/) — app ghép thêm tên file để mở báo giá gốc')
on conflict (key) do nothing;


-- =====================================================================
-- 2. BẢNG
-- =====================================================================

create table if not exists pr_import (
  id          bigserial primary key,
  kind        text not null,                     -- legacy | json
  file_name   text,
  stats       jsonb,
  created_by  uuid default auth.uid(),
  created_name text,
  created_at  timestamptz not null default now()
);

create table if not exists pr_source (
  id           bigserial primary key,
  kind         text not null check (kind in ('legacy', 'quote', 'qc', 'mc_hist', 'mc_market', 'po', 'tender', 'intake', 'market')),
  origin_key   text unique,                      -- nguồn tự động: qc:<doc>:<i>, po:<doc>, …; legacy: legacy:Báo giá (n)
  ref          text,                             -- "Báo giá (27)", số chứng từ, số phiếu…
  supplier     text,
  contact      text,                             -- email / điện thoại
  quote_date   date,                             -- null = chưa rõ ngày
  project_code text,
  project_name text,
  currency     text not null default 'VND',
  fx_rate      numeric(18, 6) not null default 1,
  vat_included boolean not null default false,
  won          boolean,                          -- true trúng / chốt · false không trúng · null chưa rõ
  delivery_term text,
  install_term  text,
  payment_term  text,
  file_name    text,
  file_url     text,
  note         text,
  import_id    bigint references pr_import(id) on delete set null,
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pr_source_kind_idx on pr_source (kind);

create table if not exists pr_line (
  id           bigserial primary key,
  source_id    bigint not null references pr_source(id) on delete cascade,
  line_no      int,
  section      text,                             -- tiêu đề nhóm phía trên dòng trong báo giá
  name_raw     text not null,
  name_std     text,                             -- tên chuẩn (gán dần, học qua pr_alias)
  category_code text,
  line_kind    text not null default 'goods' check (line_kind in ('goods', 'service', 'lump')),
  brand        text,
  model        text,
  origin       text,
  spec         jsonb not null default '{}'::jsonb,
  qty          numeric(18, 3),
  unit_raw     text,
  unit         text,                             -- đơn vị chuẩn
  unit_price   numeric(18, 2),                   -- đơn giá vật tư (theo tiền tệ nguồn, như ghi trên báo giá)
  labor_price  numeric(18, 2),                   -- đơn giá nhân công / lắp đặt
  vat_rate     numeric(6, 4),
  price_vnd    numeric(18, 2),                   -- (vật tư + nhân công) × tỷ giá, CHƯA VAT, / 1 đơn vị — dùng để so sánh
  note         text,
  uncertain    jsonb not null default '[]'::jsonb,
  search_norm  text                              -- am_norm(tên + tên chuẩn + hãng + model + nhóm): tra cứu không dấu
);
create index if not exists pr_line_source_idx on pr_line (source_id);

create table if not exists pr_unit (
  raw_norm text primary key,
  unit     text not null,
  lump     boolean not null default false
);

create table if not exists pr_alias (
  name_norm  text primary key,
  name_std   text not null,
  category_code text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- Đơn vị gặp trong file cũ (26/09/2026). Sửa / thêm được bằng SQL; "do nothing" giữ phần đã sửa.
insert into pr_unit (raw_norm, unit, lump) values
  ('cai', 'cái', false), ('chiec', 'cái', false), ('pcs', 'cái', false), ('pc', 'cái', false), ('piece', 'cái', false), ('pieces', 'cái', false), ('ea', 'cái', false),
  ('bo', 'bộ', false), ('set', 'bộ', false), ('sets', 'bộ', false),
  ('m2', 'm²', false), ('m²', 'm²', false), ('m^2', 'm²', false), ('met vuong', 'm²', false), ('sqm', 'm²', false),
  ('m', 'm', false), ('met', 'm', false), ('md', 'm', false), ('m dai', 'm', false), ('meter', 'm', false), ('m3', 'm³', false), ('m³', 'm³', false),
  ('kg', 'kg', false), ('tan', 'tấn', false), ('tam', 'tấm', false), ('cuon', 'cuộn', false), ('roll', 'cuộn', false),
  ('lit', 'lít', false), ('lít', 'lít', false), ('l', 'lít', false), ('thung', 'thùng', false), ('hop', 'hộp', false), ('cay', 'cây', false),
  ('cot', 'cột', false), ('khung', 'khung', false), ('o', 'ô', false), ('canh', 'cánh', false), ('phong', 'phòng', false), ('don vi', 'đơn vị', false),
  ('ngay-cong', 'ngày công', false), ('ngay cong', 'ngày công', false), ('cong', 'công', false),
  ('lic', 'license', false), ('license', 'license', false), ('licence', 'license', false), ('user', 'user', false),
  ('goi', 'gói', true), ('tron goi', 'gói', true), ('package', 'gói', true), ('pkg', 'gói', true),
  ('lo', 'lô', true), ('lot', 'lô', true), ('he', 'hệ', true), ('he thong', 'hệ', true), ('system', 'hệ', true),
  ('lan', 'lần', true), ('job', 'lần', true), ('ls', 'gói', true)
on conflict (raw_norm) do nothing;


-- =====================================================================
-- 3. HÀM PHỤ
-- =====================================================================

create or replace function pr_need(p_action text)
returns void language plpgsql stable security definer set search_path = public as $$
begin perform app_require('price', p_action); end $$;

-- Đơn vị chuẩn + trọn gói hay không.
create or replace function pr_unit_of(p_raw text, out unit text, out lump boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(u.unit, nullif(trim(p_raw), '')), coalesce(u.lump, false)
  from   (select 1) x left join pr_unit u on u.raw_norm = am_norm(coalesce(p_raw, ''))
$$;

-- Dịch vụ (lắp đặt, nhân công, vận chuyển, tháo dỡ…) theo tên: không phải hàng hoá để so đơn giá thiết bị.
create or replace function pr_is_service(p_name text)
returns boolean language sql immutable as $$
  select am_norm(coalesce(p_name, '')) ~ '^(lap dat|nhan cong|thi cong|van chuyen|thao do|chi phi|cong lap|phi |dich vu|bao tri|bao duong|installation|labou?r|transport|delivery|service)'
$$;

-- Tính lại cột suy ra của các dòng (đơn vị chuẩn, loại dòng, giá VND, tên chuẩn theo alias, chuỗi tra cứu).
create or replace function pr_refresh_lines(p_source bigint default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update pr_line l set
    unit      = (pr_unit_of(l.unit_raw)).unit,
    line_kind = case when (pr_unit_of(l.unit_raw)).lump then 'lump' when pr_is_service(l.name_raw) then 'service' else 'goods' end,
    name_std  = coalesce(l.name_std, (select a.name_std from pr_alias a where a.name_norm = am_norm(l.name_raw))),
    category_code = coalesce(l.category_code, (select a.category_code from pr_alias a where a.name_norm = am_norm(l.name_raw))),
    price_vnd = case when l.unit_price is null and l.labor_price is null then null
                     else round((coalesce(l.unit_price, 0) + coalesce(l.labor_price, 0)) * s.fx_rate
                                / case when s.vat_included then 1 + coalesce(l.vat_rate, 0.1) else 1 end, 2) end
  from pr_source s
  where s.id = l.source_id and (p_source is null or l.source_id = p_source);
  update pr_line l set search_norm = am_norm(concat_ws(' ', l.name_raw, l.name_std, l.brand, l.model, l.section, l.category_code))
  where p_source is null or l.source_id = p_source;
end $$;

-- Đọc một dòng JSON vào pr_line.
create or replace function pr_put_lines(p_source bigint, p_lines jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into pr_line (source_id, line_no, section, name_raw, name_std, category_code, brand, model, origin, spec, qty, unit_raw,
                       unit_price, labor_price, vat_rate, note, uncertain)
  select p_source, coalesce((x ->> 'line_no')::int, o::int), nullif(x ->> 'section', ''), x ->> 'name', nullif(x ->> 'name_std', ''),
         nullif(x ->> 'category_code', ''), nullif(x ->> 'brand', ''), nullif(x ->> 'model', ''), nullif(x ->> 'origin', ''),
         coalesce(x -> 'spec', '{}'::jsonb), nullif(x ->> 'qty', '')::numeric, nullif(x ->> 'unit', ''),
         nullif(x ->> 'unit_price', '')::numeric, nullif(x ->> 'labor_price', '')::numeric, nullif(x ->> 'vat_rate', '')::numeric,
         nullif(x ->> 'note', ''), coalesce(x -> 'uncertain', '[]'::jsonb)
  from   jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality e(x, o)
  where  coalesce(trim(x ->> 'name'), '') <> '';
  get diagnostics n = row_count;
  return n;
end $$;


-- =====================================================================
-- 4. NHẬP TAY: báo giá (JSON), file Excel cũ, sửa, xoá
-- =====================================================================

-- p_source: {id?, kind, ref, supplier, contact, quote_date, project_code, project_name, currency, fx_rate, vat_included,
--            won, delivery_term, install_term, payment_term, file_name, file_url, note}; p_lines: [{name, qty, unit, unit_price, …}]
create or replace function pr_save_source(p_source jsonb, p_lines jsonb default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p_source ->> 'id', '')::bigint; v_kind text := coalesce(nullif(p_source ->> 'kind', ''), 'quote');
begin
  perform pr_need('create');
  if v_kind not in ('legacy', 'quote', 'market') then raise exception 'Chỉ sửa được nguồn nhập tay (báo giá, giá thị trường, dữ liệu cũ).'; end if;
  if v_id is null then
    insert into pr_source (kind, created_name) values (v_kind, pm_user_name(auth.uid())) returning id into v_id;
  elsif not exists (select 1 from pr_source where id = v_id and kind in ('legacy', 'quote', 'market')) then
    raise exception 'Nguồn tự động (QC, MC, PO, dự thầu, nhận hàng) chỉ đổi được ở chứng từ gốc.';
  end if;
  update pr_source set
    kind = v_kind, ref = p_source ->> 'ref', supplier = nullif(trim(p_source ->> 'supplier'), ''), contact = p_source ->> 'contact',
    quote_date = nullif(p_source ->> 'quote_date', '')::date, project_code = nullif(p_source ->> 'project_code', ''),
    project_name = p_source ->> 'project_name', currency = coalesce(nullif(p_source ->> 'currency', ''), 'VND'),
    fx_rate = coalesce(nullif(p_source ->> 'fx_rate', '')::numeric, 1), vat_included = coalesce((p_source ->> 'vat_included')::boolean, false),
    won = (p_source ->> 'won')::boolean, delivery_term = p_source ->> 'delivery_term', install_term = p_source ->> 'install_term',
    payment_term = p_source ->> 'payment_term', file_name = p_source ->> 'file_name', file_url = nullif(p_source ->> 'file_url', ''),
    note = p_source ->> 'note', updated_at = now()
  where id = v_id;
  if p_lines is not null then
    delete from pr_line where source_id = v_id;
    perform pr_put_lines(v_id, p_lines);
  end if;
  perform pr_refresh_lines(v_id);
  return v_id;
end $$;

create or replace function pr_delete_source(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pr_need('edit');
  delete from pr_source where id = p_id and kind in ('legacy', 'quote', 'market');
  if not found then raise exception 'Chỉ xoá được nguồn nhập tay.'; end if;
end $$;

-- File Excel cũ: gọi nhiều lần (mỗi lần ≤ 500 dòng) với cùng p_import; mỗi phần tử p_sources = một báo giá
-- {ref, supplier, contact, quote_date, project_name, delivery_term, install_term, payment_term, file_name, lines:[…]}.
-- Báo giá đã có (cùng ref) được THAY bằng bản mới — nạp lại file vô hại.
create or replace function pr_import_legacy(p_import bigint, p_file text, p_sources jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_imp bigint := p_import; s jsonb; v_id bigint; n_src int := 0; n_line int := 0;
begin
  perform pr_need('create');
  if v_imp is null then
    insert into pr_import (kind, file_name, created_name) values ('legacy', p_file, pm_user_name(auth.uid())) returning id into v_imp;
  end if;
  for s in select * from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) loop
    insert into pr_source (kind, origin_key, ref, supplier, contact, quote_date, project_name, delivery_term, install_term, payment_term,
                           file_name, import_id, created_name)
    values ('legacy', 'legacy:' || (s ->> 'ref'), s ->> 'ref', nullif(trim(s ->> 'supplier'), ''), s ->> 'contact',
            nullif(s ->> 'quote_date', '')::date, s ->> 'project_name', s ->> 'delivery_term', s ->> 'install_term', s ->> 'payment_term',
            s ->> 'file_name', v_imp, pm_user_name(auth.uid()))
    on conflict (origin_key) do update set supplier = excluded.supplier, contact = excluded.contact,
      quote_date = coalesce(excluded.quote_date, pr_source.quote_date), project_name = excluded.project_name,
      delivery_term = excluded.delivery_term, install_term = excluded.install_term, payment_term = excluded.payment_term,
      file_name = excluded.file_name, import_id = excluded.import_id, updated_at = now()
    returning id into v_id;
    delete from pr_line where source_id = v_id;
    n_line := n_line + pr_put_lines(v_id, s -> 'lines');
    perform pr_refresh_lines(v_id);
    n_src := n_src + 1;
  end loop;
  update pr_import set stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object('sources', coalesce((stats ->> 'sources')::int, 0) + n_src,
                                                                                    'lines', coalesce((stats ->> 'lines')::int, 0) + n_line)
   where id = v_imp;
  return jsonb_build_object('import', v_imp, 'sources', n_src, 'lines', n_line);
end $$;

-- Gán tên chuẩn cho các dòng; ghi nhớ tên gốc → tên chuẩn (áp cho dòng cũ và mọi lần đồng bộ sau).
create or replace function pr_set_std(p_lines bigint[], p_std text, p_category text default null)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform pr_need('edit');
  p_std := nullif(trim(p_std), '');
  if p_std is null then
    update pr_line set name_std = null where id = any(p_lines);
    delete from pr_alias where name_norm in (select am_norm(name_raw) from pr_line where id = any(p_lines));
  else
    update pr_line set name_std = p_std, category_code = coalesce(nullif(p_category, ''), category_code) where id = any(p_lines);
    insert into pr_alias (name_norm, name_std, category_code)
    select distinct am_norm(name_raw), p_std, nullif(p_category, '') from pr_line where id = any(p_lines)
    on conflict (name_norm) do update set name_std = excluded.name_std, category_code = coalesce(excluded.category_code, pr_alias.category_code);
    -- Các dòng khác cùng tên gốc (nguồn khác) nhận luôn tên chuẩn.
    update pr_line set name_std = p_std, category_code = coalesce(nullif(p_category, ''), category_code)
    where name_std is null and am_norm(name_raw) in (select am_norm(name_raw) from pr_line where id = any(p_lines));
  end if;
  n := coalesce(array_length(p_lines, 1), 0);
  update pr_line set search_norm = am_norm(concat_ws(' ', name_raw, name_std, brand, model, section, category_code))
  where am_norm(name_raw) in (select am_norm(name_raw) from pr_line where id = any(p_lines));
  return n;
end $$;


-- =====================================================================
-- 5. ĐỒNG BỘ TỪ APP: QC, MC, PO, dự thầu, nhận hàng
--    Dựng lại toàn bộ nguồn tự động mỗi lần gọi (không ai sửa tay các nguồn này).
-- =====================================================================

create or replace function pr_sync()
returns jsonb language plpgsql security definer set search_path = public as $$
declare d record; v jsonb; i int; v_id bigint; n jsonb := '{}'::jsonb; k text; cnt int;
begin
  perform pr_need('create');
  delete from pr_source where kind in ('qc', 'mc_hist', 'mc_market', 'po', 'tender', 'intake');

  -- QC: mỗi nhà cung cấp một nguồn; nhà cung cấp A của QC đã duyệt = trúng.
  cnt := 0;
  for d in select x.*, p.name as pname from pm_doc x left join pm_project p on p.code = x.project_code
           where x.doc_type = 'QC' and x.status <> 'cancelled' loop
    i := 0;
    for v in select * from jsonb_array_elements(coalesce(d.data -> 'vendors', '[]'::jsonb)) loop
      if coalesce(trim(v ->> 'name'), '') <> '' then
        insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, won, payment_term, created_name)
        values ('qc', 'qc:' || d.id || ':' || i, d.doc_no, v ->> 'name', coalesce(nullif(d.data ->> 'date', '')::date, d.created_at::date),
                d.project_code, d.pname, case when d.status = 'approved' then i = 0 end, v ->> 'pay_term', 'sync')
        returning id into v_id;
        perform pr_put_lines(v_id, (
          select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', q ->> 'item', 'qty', q ->> 'qty', 'unit', q ->> 'unit',
                   'unit_price', v -> 'prices' ->> ((o - 1)::text), 'brand', v -> 'specx' -> ((o - 1)::text) ->> 'brand',
                   'model', v -> 'specx' -> ((o - 1)::text) ->> 'model', 'origin', v -> 'specx' -> ((o - 1)::text) ->> 'origin',
                   'spec', coalesce(v -> 'specx' -> ((o - 1)::text), '{}'::jsonb), 'note', v -> 'specs' ->> ((o - 1)::text))), '[]'::jsonb)
          from jsonb_array_elements(coalesce(d.data -> 'qlines', '[]'::jsonb)) with ordinality e(q, o)
          where v -> 'prices' ->> ((o - 1)::text) is not null));
        perform pr_put_lines(v_id, (
          select coalesce(jsonb_agg(jsonb_build_object('line_no', 1000 + o, 'name', q ->> 'item', 'qty', 1, 'unit', 'gói',
                   'unit_price', v -> 'oprices' ->> ((o - 1)::text))), '[]'::jsonb)
          from jsonb_array_elements(coalesce(d.data -> 'olines', '[]'::jsonb)) with ordinality e(q, o)
          where v -> 'oprices' ->> ((o - 1)::text) is not null));
        cnt := cnt + 1;
      end if;
      i := i + 1;
    end loop;
  end loop;
  n := n || jsonb_build_object('qc', cnt);

  -- MC: giá lịch sử (B, quy về năm của nó) và giá thị trường (C).
  cnt := 0;
  for d in select x.*, p.name as pname from pm_doc x left join pm_project p on p.code = x.project_code
           where x.doc_type = 'MC' and x.status <> 'cancelled' loop
    if exists (select 1 from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) l where nullif(l ->> 'b_pv', '') is not null) then
      -- Đơn giá = giá lịch sử đã quy về ngày MC (b_price, 4,6%/năm như form MC); năm và giá gốc ghi ở ghi chú.
      insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, note, created_name)
      values ('mc_hist', 'mc:' || d.id || ':b', d.doc_no, null, coalesce(nullif(d.data ->> 'date', '')::date, d.created_at::date), d.project_code, d.pname,
              'Giá lịch sử trong Market Check, đã quy về ngày MC', 'sync')
      returning id into v_id;
      perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', l ->> 'item', 'qty', l ->> 'qty', 'unit', l ->> 'unit',
                 'unit_price', coalesce(l ->> 'b_price', l ->> 'b_pv'),
                 'note', concat_ws(' · ', nullif(l ->> 'b_ref', ''), 'giá năm ' || (l ->> 'b_year') || ': ' || (l ->> 'b_pv')))), '[]'::jsonb)
        from jsonb_array_elements(d.data -> 'lines') with ordinality e(l, o) where nullif(l ->> 'b_pv', '') is not null));
      cnt := cnt + 1;
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) l where nullif(l ->> 'c_price', '') is not null) then
      insert into pr_source (kind, origin_key, ref, quote_date, project_code, project_name, note, created_name)
      values ('mc_market', 'mc:' || d.id || ':c', d.doc_no, coalesce(nullif(d.data ->> 'date', '')::date, d.created_at::date), d.project_code, d.pname,
              'Giá thị trường trong Market Check', 'sync')
      returning id into v_id;
      perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', l ->> 'item', 'qty', l ->> 'qty', 'unit', l ->> 'unit',
                 'unit_price', l ->> 'c_price', 'note', nullif(l ->> 'c_spec', ''))), '[]'::jsonb)
        from jsonb_array_elements(d.data -> 'lines') with ordinality e(l, o) where nullif(l ->> 'c_price', '') is not null));
      cnt := cnt + 1;
    end if;
  end loop;
  n := n || jsonb_build_object('mc', cnt);

  -- PO: giá chốt (trúng).
  cnt := 0;
  for d in select x.*, p.name as pname from pm_doc x left join pm_project p on p.code = x.project_code
           where x.doc_type = 'PO' and x.status <> 'cancelled' loop
    insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, won, payment_term, delivery_term, created_name)
    values ('po', 'po:' || d.id, d.doc_no, nullif(d.data ->> 'supplier', ''), coalesce(nullif(d.data ->> 'order_date', '')::date, d.created_at::date),
            d.project_code, d.pname, case when d.status = 'approved' then true end, d.data ->> 'payment_term', d.data ->> 'delivery_term', 'sync')
    returning id into v_id;
    perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', l ->> 'asset_item', 'qty', l ->> 'qty', 'unit', l ->> 'unit',
               'unit_price', l ->> 'unit_price', 'brand', l -> 'spec' ->> 'brand', 'model', l -> 'spec' ->> 'model', 'origin', l ->> 'origin',
               'spec', coalesce(l -> 'spec', '{}'::jsonb))), '[]'::jsonb)
      from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) with ordinality e(l, o) where nullif(l ->> 'unit_price', '') is not null));
    cnt := cnt + 1;
  end loop;
  n := n || jsonb_build_object('po', cnt);

  -- Hồ sơ dự thầu đã mở niêm phong (bản mới nhất mỗi nhà thầu mỗi vòng): trúng = nhà cung cấp A của QC đã duyệt.
  cnt := 0;
  for d in select b.*, tn.items, tn.project_code, tn.qc_doc_id, tn.title, iv.vendor_name, p.name as pname
           from pm_tender_bid b join pm_tender tn on tn.id = b.tender_id join pm_tender_invitee iv on iv.id = b.invitee_id
           left join pm_project p on p.code = tn.project_code
           where b.status = 'submitted' and b.opened_at is not null loop
    insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, won, payment_term, created_name)
    values ('tender', 'tender:' || d.id, coalesce(d.title, 'Tender') || ' · vòng ' || d.round, d.vendor_name, d.submitted_at::date, d.project_code, d.pname,
            (select case when q.status = 'approved' then am_norm(q.data ->> 'chosen_vendor') = am_norm(d.vendor_name) end from pm_doc q where q.id = d.qc_doc_id),
            d.data ->> 'pay_term', 'sync')
    returning id into v_id;
    perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', it ->> 'item', 'qty', it ->> 'qty', 'unit', it ->> 'unit',
               'unit_price', d.data -> 'prices' ->> ((o - 1)::text), 'brand', d.data -> 'specx' -> ((o - 1)::text) ->> 'brand',
               'model', d.data -> 'specx' -> ((o - 1)::text) ->> 'model', 'spec', coalesce(d.data -> 'specx' -> ((o - 1)::text), '{}'::jsonb))), '[]'::jsonb)
      from jsonb_array_elements(coalesce(d.items, '[]'::jsonb)) with ordinality e(it, o) where d.data -> 'prices' ->> ((o - 1)::text) is not null));
    cnt := cnt + 1;
  end loop;
  n := n || jsonb_build_object('tender', cnt);

  -- Phiếu nhận hàng: giá mua thực tế, gộp theo tên chuẩn + đơn vị + đơn giá.
  cnt := 0;
  for d in select s.* from am_shipment s where s.status <> 'cancelled'
           and exists (select 1 from am_asset a where a.shipment_id = s.id and a.unit_price is not null) loop
    insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, won, created_name)
    values ('intake', 'intake:' || d.id, coalesce(d.po_doc_no, d.code, 'Nhận hàng #' || d.id), d.supplier, coalesce(d.delivery_date, d.created_at::date),
            d.project_code, true, 'sync')
    returning id into v_id;
    perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('name', g.nm, 'qty', g.q, 'unit', g.u, 'unit_price', g.p, 'brand', g.b,
               'model', g.m, 'category_code', g.c, 'name_std', g.nm)), '[]'::jsonb)
      from (select a.name_vi || coalesce(' / ' || a.name_en, '') as nm, a.unit_code as u, a.unit_price as p, max(a.spec_brand) as b, max(a.spec_model) as m,
                   max(a.category_code) as c, sum(a.qty) as q
            from am_asset a where a.shipment_id = d.id and a.unit_price is not null
            group by 1, 2, 3) g));
    cnt := cnt + 1;
  end loop;
  n := n || jsonb_build_object('intake', cnt);

  perform pr_refresh_lines(null);
  insert into am_setting (key, value, note) values ('pr_last_sync', to_jsonb(now()), 'CSDL giá: lần đồng bộ gần nhất từ QC / MC / PO / dự thầu / nhận hàng')
  on conflict (key) do update set value = excluded.value;
  return n;
end $$;


-- =====================================================================
-- 6. TRA CỨU — dùng cho màn tra cứu, chatbot và Market Check
--    Người chỉ có quyền xem: KHÔNG trả tên nhà cung cấp, liên hệ, file.
-- =====================================================================

-- p_f: {kinds:[…], year_from, year_to, unit, won_only, goods_only, category, supplier, limit}
create or replace function pr_search(p_q text, p_f jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  w     text[] := array(select x from regexp_split_to_table(am_norm(coalesce(p_q, '')), '\s+') x where length(x) >= 1);
  full_ boolean := app_can('price', 'create');
  lim   int := least(coalesce(nullif(p_f ->> 'limit', '')::int, 200), 1000);
  rate  numeric := 0.046;
  v     jsonb;
begin
  perform pr_need('view');
  select coalesce(jsonb_agg(q.r order by q.rk desc, q.dt desc nulls last), '[]'::jsonb) into v from (
    select s.quote_date as dt, jsonb_build_object(
      'id', l.id, 'source_id', s.id, 'kind', s.kind, 'ref', case when full_ then s.ref end, 'date', s.quote_date, 'won', s.won,
      'project_code', s.project_code, 'project_name', s.project_name,
      'supplier', case when full_ then s.supplier end, 'contact', case when full_ then s.contact end,
      'file_name', case when full_ then s.file_name end, 'file_url', case when full_ then s.file_url end,
      'name', l.name_raw, 'name_std', l.name_std, 'section', l.section, 'category_code', l.category_code, 'line_kind', l.line_kind,
      'brand', l.brand, 'model', l.model, 'origin', l.origin, 'spec', l.spec, 'qty', l.qty, 'unit_raw', l.unit_raw, 'unit', l.unit,
      'unit_price', l.unit_price, 'labor_price', l.labor_price, 'currency', s.currency, 'vat_included', s.vat_included, 'price_vnd', l.price_vnd,
      'price_today', case when l.price_vnd is not null and s.quote_date is not null
                          then round(l.price_vnd * power(1 + rate, greatest(0, extract(year from current_date) - extract(year from s.quote_date))), 0) end,
      'note', l.note) as r,
      (select count(*) from unnest(w) x where position(x in am_norm(coalesce(l.name_std, l.name_raw))) > 0) * 10
        + (select count(*) from unnest(w) x where position(x in coalesce(l.search_norm, '')) > 0) as rk
    from pr_line l join pr_source s on s.id = l.source_id
    where (coalesce(array_length(w, 1), 0) = 0
           or not exists (select 1 from unnest(w) x where position(x in coalesce(l.search_norm, '') || ' ' || am_norm(coalesce(case when full_ then s.supplier end, ''))
                                                                  || ' ' || am_norm(coalesce(s.project_name, ''))) = 0))
      and (p_f -> 'kinds' is null or jsonb_array_length(p_f -> 'kinds') = 0 or s.kind in (select jsonb_array_elements_text(p_f -> 'kinds')))
      and (nullif(p_f ->> 'year_from', '') is null or s.quote_date >= make_date((p_f ->> 'year_from')::int, 1, 1))
      and (nullif(p_f ->> 'year_to', '') is null or s.quote_date <= make_date((p_f ->> 'year_to')::int, 12, 31))
      and (nullif(p_f ->> 'unit', '') is null or l.unit = p_f ->> 'unit')
      and (not coalesce((p_f ->> 'won_only')::boolean, false) or s.won)
      and (not coalesce((p_f ->> 'goods_only')::boolean, false) or l.line_kind = 'goods')
      and (nullif(p_f ->> 'category', '') is null or l.category_code = p_f ->> 'category')
      and (nullif(p_f ->> 'supplier', '') is null or (full_ and position(am_norm(p_f ->> 'supplier') in am_norm(coalesce(s.supplier, ''))) > 0))
    order by rk desc, s.quote_date desc nulls last limit lim) q;
  return v;
end $$;

-- Tổng quan cho màn hình: số nguồn / dòng theo loại, lần đồng bộ, nhà cung cấp (chỉ người nhập).
create or replace function pr_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform pr_need('view');
  return jsonb_build_object(
    'by_kind', (select coalesce(jsonb_object_agg(kind, jsonb_build_object('sources', ns, 'lines', nl)), '{}'::jsonb)
                from (select s.kind, count(distinct s.id) ns, count(l.id) nl from pr_source s left join pr_line l on l.source_id = s.id group by s.kind) q),
    'no_date', (select count(*) from pr_source where quote_date is null and kind in ('legacy', 'quote', 'market')),
    'no_std', (select count(*) from pr_line where name_std is null),
    'suppliers', case when app_can('price', 'create') then (select count(distinct am_norm(supplier)) from pr_source where supplier is not null) end,
    'last_sync', (select value from am_setting where key = 'pr_last_sync'),
    'base_url', (select value from am_setting where key = 'pr_quotes_base_url'));
end $$;


-- =====================================================================
-- 7. QUYỀN
-- =====================================================================

alter table pr_import enable row level security;
alter table pr_source enable row level security;
alter table pr_line   enable row level security;
alter table pr_unit   enable row level security;
alter table pr_alias  enable row level security;
revoke all on pr_import, pr_source, pr_line, pr_unit, pr_alias from anon, authenticated;
grant select on pr_import, pr_source, pr_line, pr_unit, pr_alias to authenticated;

-- Bảng đọc thẳng: chỉ người nhập (thấy nhà cung cấp). Người chỉ xem dùng pr_search().
drop policy if exists pr_import_read on pr_import;
create policy pr_import_read on pr_import for select to authenticated using ((select app_can('price', 'create')));
drop policy if exists pr_source_read on pr_source;
create policy pr_source_read on pr_source for select to authenticated using ((select app_can('price', 'create')));
drop policy if exists pr_line_read on pr_line;
create policy pr_line_read on pr_line for select to authenticated using ((select app_can('price', 'create')));
drop policy if exists pr_unit_read on pr_unit;
create policy pr_unit_read on pr_unit for select to authenticated using ((select app_can('price', 'view')));
drop policy if exists pr_alias_read on pr_alias;
create policy pr_alias_read on pr_alias for select to authenticated using ((select app_can('price', 'create')));

do $$
declare t text;
begin
  foreach t in array array['pr_source', 'pr_alias', 'pr_unit'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke execute on function pr_need(text), pr_unit_of(text), pr_is_service(text), pr_refresh_lines(bigint), pr_put_lines(bigint, jsonb),
  pr_save_source(jsonb, jsonb), pr_delete_source(bigint), pr_import_legacy(bigint, text, jsonb), pr_set_std(bigint[], text, text),
  pr_sync(), pr_search(text, jsonb), pr_overview()
  from public, anon;
grant execute on function pr_save_source(jsonb, jsonb), pr_delete_source(bigint), pr_import_legacy(bigint, text, jsonb),
  pr_set_std(bigint[], text, text), pr_sync(), pr_search(text, jsonb), pr_overview()
  to authenticated;

select app_lock_anon();


-- =====================================================================
-- 8. KIỂM CHỨNG
-- =====================================================================

select 'Bảng CSDL giá có RLS' as "Mục", count(*)::text as "Thực tế", '5' as "Mong đợi", case when count(*) = 5 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pr_import', 'pr_source', 'pr_line', 'pr_unit', 'pr_alias') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng CSDL giá (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name like 'pr\_%' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Khu quyền "price"', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end from app_module where code = 'price'
union all
select 'Hàm CSDL giá', count(*)::text, '7', case when count(*) = 7 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pr_save_source', 'pr_delete_source', 'pr_import_legacy', 'pr_set_std', 'pr_sync', 'pr_search', 'pr_overview');
