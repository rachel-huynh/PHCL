-- =====================================================================
-- 34_contracts.sql — SỔ HỢP ĐỒNG MUA SẮM (27/09/2026)
--
-- Chạy SAU 33_meetings.sql (dùng pm_project, pm_vendor, pm_doc của 18–19,
-- pm_notice của 20, am_actors / am_is_actor / am_notify / am_me_name của 31).
-- Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Hợp đồng liên quan mua sắm (quyết định 27/09/2026): hợp đồng của dự án Capex
-- VÀ hợp đồng dịch vụ / bảo trì hằng năm không gắn dự án. Pháp chế có sổ hợp
-- đồng tổng; hợp đồng mua sắm nằm ở đây và chia sẻ sang Legal Portal (cùng
-- project Supabase) qua hàm pm_contract_register().
--
--   pm_contract        một hợp đồng: số HĐ, loại, pháp nhân / bộ phận, dự án,
--                      nhà cung cấp, ngày ký / hiệu lực / hết hạn / hạn giao,
--                      giá trị trước / sau VAT, các đợt thanh toán, bảo hành,
--                      bảo lãnh (tạm ứng / thực hiện / bảo hành) và giữ lại,
--                      phạt chậm, tự gia hạn / báo trước; trang chứa mỗi điều
--                      khoản (terms_pages) để mở đúng trang của văn bản gốc.
--   pm_contract_file   văn bản: hợp đồng, phụ lục, sửa đổi, bảo lãnh… lưu
--                      trong app (bucket riêng "pm-contract") HOẶC link OneDrive
--                      (cả hai — quyết định 27/09/2026); chữ đọc được (OCR) theo trang.
--
-- Đọc điều khoản (quyết định 27/09/2026 — ba cách, chọn khi dùng):
--   A. Claude chat: app soạn prompt, người dùng đưa PDF vào Claude, dán JSON về.
--   B. OCR trong trình duyệt (Tesseract) CHỈ các trang được chọn + quy tắc nhận diện.
--   C. Claude API gọi thẳng từ trình duyệt bằng khoá riêng của người dùng (không lưu ở CSDL).
--   Kết quả luôn là bản nháp để người dùng xác nhận.
--
-- Duyệt ký (quyết định 27/09/2026): giá trị < hạn mức khách sạn (am_setting
-- ct_hotel_limit, mặc định 1 tỷ VND) → khách sạn ký (Trưởng BP → DOF → Hotel GM);
-- từ hạn mức trở lên → khách sạn xem xét trước, rồi Pháp chế (vai trò LEGAL)
-- rồi JVC (AM Coordinator → Kế toán trưởng → JVC GM). Tuyến sửa ở am_setting ct_route.
--
-- Quyền (quyết định 27/09/2026): khu "contract". Xem: Thu mua, Trưởng BP (chỉ hợp
-- đồng bộ phận mình), DOF, Hotel GM, Trưởng cao ốc, nhóm QLTS, JVC, Pháp chế.
-- Lập / sửa: nhóm QLTS, Thu mua. Quản trị: AM Coordinator.
--
-- Nhắc hạn (điều chỉnh ở am_setting ct_alert_days): hết hạn hợp đồng / bảo lãnh
-- 60 ngày, hết bảo hành 30 ngày, hạn giao hàng đã qua.
--
-- Mọi bảng chỉ ghi qua hàm (không cấp insert/update/delete cho trình duyệt).
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. VAI TRÒ, KHU QUYỀN, CÀI ĐẶT
-- =====================================================================

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('LEGAL', 'JVC', 'Legal', 'Pháp chế', false, 'PHCL', 140)
on conflict (code) do update set name_en = excluded.name_en, name_vi = excluded.name_vi, default_scope = excluded.default_scope, sort = excluded.sort;

insert into app_module (code, name_en, name_vi, sort) values
  ('contract', 'Contracts', 'Hợp đồng', 86)
on conflict (code) do update set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

-- "do nothing": ô đã chỉnh ở màn Phân quyền giữ nguyên.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select r.code, 'contract',
       r.code in ('PURCHASING', 'DEPT_HEAD', 'DOF', 'HOTEL_GM', 'CP_HEAD', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM', 'LEGAL', 'SYS_ADMIN'),
       r.code in ('PURCHASING', 'AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       r.code in ('PURCHASING', 'AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       r.code in ('DEPT_HEAD', 'DOF', 'HOTEL_GM', 'CP_HEAD', 'AM_COORD', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM', 'LEGAL', 'SYS_ADMIN'),
       r.code in ('AM_COORD', 'SYS_ADMIN')
from   app_role r
on conflict (role_code, module_code) do nothing;

insert into am_setting (key, value, note) values
  ('ct_hotel_limit', '1000000000'::jsonb,
   'Hợp đồng: hạn mức khách sạn tự ký (VND). Từ mức này trở lên: khách sạn xem xét, rồi Pháp chế và JVC duyệt'),
  ('ct_limit_incl_vat', 'false'::jsonb,
   'Hợp đồng: so hạn mức với giá trị ĐÃ gồm VAT (true) hay trước VAT (false)'),
  ('ct_route', '{"SSP": {"hotel": ["DEPT_HEAD", "DOF", "HOTEL_GM"], "jvc": ["AM_COORD", "CHIEF_ACC", "JVC_GM"]},
                 "CP":  {"hotel": ["CP_HEAD"], "jvc": ["AM_COORD", "CHIEF_ACC", "JVC_GM"]},
                 "JVC": {"hotel": [], "jvc": ["AM_COORD", "CHIEF_ACC", "JVC_GM"]}}'::jsonb,
   'Hợp đồng: tuyến duyệt theo pháp nhân — hotel = xem xét / ký phía khách sạn, jvc = phía JVC (sau Pháp chế) khi vượt hạn mức'),
  ('ct_see_all_roles', '["PURCHASING", "DOF", "HOTEL_GM", "CP_HEAD", "AM_COORD", "AM_EXEC", "CHIEF_ACC", "JVC_DGM", "JVC_GM", "LEGAL", "SYS_ADMIN"]'::jsonb,
   'Hợp đồng: các vai trò thấy MỌI hợp đồng; vai trò khác có quyền xem (Trưởng BP) chỉ thấy hợp đồng của bộ phận mình'),
  ('ct_alert_days', '{"end": 60, "bond": 60, "warranty": 30}'::jsonb,
   'Hợp đồng: số ngày nhắc trước khi hết hạn hợp đồng, bảo lãnh, bảo hành')
on conflict (key) do nothing;


-- =====================================================================
-- 2. BẢNG
-- =====================================================================

create sequence if not exists pm_contract_no_seq;

create table if not exists pm_contract (
  id             bigserial primary key,
  no             text not null unique,                       -- số trong app: HD-2026-0001
  contract_no    text,                                       -- số trên hợp đồng
  title          text,
  kind           text not null default 'supply' check (kind in ('supply', 'service', 'works', 'maintenance', 'framework', 'other')),
  scope          text not null default 'capex' check (scope in ('capex', 'opex')),
  entity         text,                                       -- SSP / CP / JVC
  dept_code      text,
  project_code   text references pm_project(code) on update cascade on delete set null,
  doc_id         bigint references pm_doc(id) on delete set null,   -- phiếu CT của gói hồ sơ
  po_no          text,
  vendor_code    text references pm_vendor(code) on update cascade on delete set null,
  supplier       text,
  supplier_tax   text,
  signed_date    date,
  start_date     date,
  end_date       date,
  delivery_due   date,
  delivery_text  text,
  currency       text not null default 'VND',
  fx_rate        numeric(18, 4) not null default 1,
  value_pre_vat  numeric(18, 2),
  vat_pct        numeric(5, 2),
  value_total    numeric(18, 2),
  -- [{milestone, pct, amount, condition, due}]
  pay_terms      jsonb not null default '[]'::jsonb,
  warranty_months int,
  warranty_start text,                                       -- 'delivery' / 'acceptance' / chữ
  handover_date  date,
  warranty_until date,
  -- [{kind: advance|performance|warranty|retention, pct, amount, expiry, issuer}]
  bonds          jsonb not null default '[]'::jsonb,
  penalty_text   text,
  auto_renew     boolean not null default false,
  notice_days    int,
  terms_pages    jsonb not null default '{}'::jsonb,         -- {field: số trang}
  terms_src      text,                                       -- manual / claude / ocr / api
  summary        text,
  status         text not null default 'draft'
                 check (status in ('draft', 'review', 'returned', 'approved', 'active', 'completed', 'closed', 'cancelled', 'rejected')),
  route          jsonb,
  cur            int,
  needs_legal    boolean not null default false,
  submitted_at   timestamptz,
  approved_at    timestamptz,
  legal_ref      text,
  source         text not null default 'app' check (source in ('app', 'ct', 'import')),
  created_by     uuid default auth.uid(),
  created_name   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists pm_contract_project_idx on pm_contract (project_code);
create index if not exists pm_contract_status_idx on pm_contract (status);
create index if not exists pm_contract_doc_idx on pm_contract (doc_id);
comment on table pm_contract is
  'Sổ hợp đồng mua sắm (Capex + dịch vụ / bảo trì). Ghi qua pm_ct_*; Legal Portal đọc qua pm_contract_register().';

create table if not exists pm_contract_file (
  id            bigserial primary key,
  contract_id   bigint not null references pm_contract(id) on delete cascade,
  kind          text not null default 'contract' check (kind in ('contract', 'annex', 'amendment', 'bond', 'acceptance', 'other')),
  name          text,
  source        text not null check (source in ('storage', 'link')),
  storage_path  text,                                        -- bucket pm-contract: <contract_id>/<tên>
  url           text,
  size_bytes    bigint,
  pages         int,
  ocr           jsonb not null default '{}'::jsonb,          -- {"3": "chữ của trang 3", …}
  uploaded_name text,
  created_at    timestamptz not null default now(),
  check ((source = 'storage' and storage_path is not null) or (source = 'link' and url ~* '^https://'))
);
create index if not exists pm_contract_file_idx on pm_contract_file (contract_id);


-- =====================================================================
-- 3. HÀM PHỤ
-- =====================================================================

create or replace function pm_ct_need(p_action text)
returns void language plpgsql stable security definer set search_path = public as $$
begin perform app_require('contract', p_action); end $$;

-- Người đang đăng nhập thấy hợp đồng của bộ phận này? Vai trò trong ct_see_all_roles thấy mọi hợp đồng;
-- vai trò khác có quyền xem (Trưởng BP) chỉ thấy hợp đồng của bộ phận nằm trong phạm vi của mình.
create or replace function pm_ct_see(p_dept text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted()
      or (app_can('contract', 'view') and (
            exists (select 1 from app_user_role ur join app_user u on u.id = ur.user_id
                    where ur.user_id = auth.uid() and u.active
                      and ur.role_code in (select jsonb_array_elements_text(coalesce((select value from am_setting where key = 'ct_see_all_roles'), '[]'::jsonb))))
         or (p_dept is not null and app_user_role_covers(auth.uid(), 'DEPT_HEAD', p_dept))))
$$;

-- Giá trị để so hạn mức, quy VND.
create or replace function pm_ct_amount(c pm_contract)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(case when coalesce((select value::text from am_setting where key = 'ct_limit_incl_vat'), 'false') = 'true'
                       then coalesce(c.value_total, c.value_pre_vat) else coalesce(c.value_pre_vat, c.value_total) end, 0)
       * coalesce(nullif(c.fx_rate, 0), 1)
$$;

-- Tuyến duyệt: mỗi vai trò một bước. Phía khách sạn luôn xem xét; vượt hạn mức → Pháp chế → JVC.
create or replace function pm_ct_steps(c pm_contract)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  routes jsonb := coalesce((select value from am_setting where key = 'ct_route'), '{}'::jsonb);
  lim    numeric := coalesce((select (value #>> '{}')::numeric from am_setting where key = 'ct_hotel_limit'), 1000000000);
  ent    text := coalesce(c.entity, pm_entity(c.dept_code), 'SSP');
  r      jsonb := coalesce(routes -> ent, routes -> 'SSP', '{}'::jsonb);
  s      jsonb := '[]'::jsonb;
  x      text;
  i      int := 0;
begin
  for x in select jsonb_array_elements_text(coalesce(r -> 'hotel', '[]'::jsonb)) loop
    i := i + 1; s := s || jsonb_build_array(jsonb_build_object('key', 'h' || i, 'side', 'hotel', 'roles', jsonb_build_array(x), 'dept', c.dept_code));
  end loop;
  if pm_ct_amount(c) >= lim or jsonb_array_length(s) = 0 then
    s := s || jsonb_build_array(jsonb_build_object('key', 'legal', 'side', 'legal', 'roles', '["LEGAL"]'::jsonb, 'dept', c.dept_code));
    i := 0;
    for x in select jsonb_array_elements_text(coalesce(r -> 'jvc', '["JVC_GM"]'::jsonb)) loop
      i := i + 1; s := s || jsonb_build_array(jsonb_build_object('key', 'j' || i, 'side', 'jvc', 'roles', jsonb_build_array(x), 'dept', c.dept_code));
    end loop;
  end if;
  return s;
end $$;

-- Số trong app: HD-<năm>-<4 số>.
create or replace function pm_ct_next_no()
returns text language sql security definer set search_path = public as $$
  select 'HD-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0')
$$;

-- Hạn bảo hành = ngày bàn giao + số tháng (khi có đủ).
create or replace function pm_ct_warranty_until(p_from date, p_months int)
returns date language sql immutable as $$
  select case when p_from is not null and p_months is not null then (p_from + make_interval(months => p_months))::date end
$$;


-- =====================================================================
-- 4. LẬP / SỬA / VĂN BẢN
-- =====================================================================

-- Tạo / sửa. Mọi trường điều khoản sửa được ở mọi trạng thái trừ đã huỷ (đọc OCR sau khi ký);
-- trường ảnh hưởng tuyến duyệt (giá trị, pháp nhân, bộ phận) chỉ sửa khi còn nháp / bị trả về.
create or replace function pm_ct_save(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p ->> 'id', '')::bigint; c pm_contract; v_open boolean; v_dept text;
begin
  perform pm_ct_need('create');
  if v_id is null then
    v_dept := nullif(p ->> 'dept_code', '');
    insert into pm_contract (no, created_name, dept_code, entity, source)
    values (pm_ct_next_no(), am_me_name(), v_dept, coalesce(nullif(p ->> 'entity', ''), pm_entity(v_dept)), coalesce(nullif(p ->> 'source', ''), 'app'))
    returning id into v_id;
  end if;
  select * into c from pm_contract where id = v_id for update;
  if not found then raise exception 'Không có hợp đồng %.', v_id; end if;
  if c.status = 'cancelled' then raise exception 'Hợp đồng % đã huỷ.', c.no; end if;
  if not pm_ct_see(c.dept_code) then raise exception 'Không có quyền với hợp đồng này.' using errcode = '42501'; end if;
  v_open := c.status in ('draft', 'returned') or app_can('contract', 'admin');
  update pm_contract set
    contract_no   = nullif(trim(p ->> 'contract_no'), ''),
    title         = nullif(trim(p ->> 'title'), ''),
    kind          = coalesce(nullif(p ->> 'kind', ''), kind),
    scope         = coalesce(nullif(p ->> 'scope', ''), scope),
    project_code  = nullif(p ->> 'project_code', ''),
    doc_id        = coalesce(nullif(p ->> 'doc_id', '')::bigint, doc_id),
    po_no         = nullif(trim(p ->> 'po_no'), ''),
    vendor_code   = nullif(p ->> 'vendor_code', ''),
    supplier      = nullif(trim(p ->> 'supplier'), ''),
    supplier_tax  = nullif(trim(p ->> 'supplier_tax'), ''),
    signed_date   = nullif(p ->> 'signed_date', '')::date,
    start_date    = nullif(p ->> 'start_date', '')::date,
    end_date      = nullif(p ->> 'end_date', '')::date,
    delivery_due  = nullif(p ->> 'delivery_due', '')::date,
    delivery_text = nullif(trim(p ->> 'delivery_text'), ''),
    pay_terms     = coalesce(p -> 'pay_terms', pay_terms),
    warranty_months = nullif(p ->> 'warranty_months', '')::int,
    warranty_start  = nullif(trim(p ->> 'warranty_start'), ''),
    handover_date = nullif(p ->> 'handover_date', '')::date,
    warranty_until = coalesce(nullif(p ->> 'warranty_until', '')::date,
                              pm_ct_warranty_until(nullif(p ->> 'handover_date', '')::date, nullif(p ->> 'warranty_months', '')::int)),
    bonds         = coalesce(p -> 'bonds', bonds),
    penalty_text  = nullif(trim(p ->> 'penalty_text'), ''),
    auto_renew    = coalesce((p ->> 'auto_renew')::boolean, auto_renew),
    notice_days   = nullif(p ->> 'notice_days', '')::int,
    terms_pages   = coalesce(p -> 'terms_pages', terms_pages),
    terms_src     = coalesce(nullif(p ->> 'terms_src', ''), terms_src),
    summary       = nullif(trim(p ->> 'summary'), ''),
    legal_ref     = nullif(trim(p ->> 'legal_ref'), ''),
    updated_at    = now()
  where id = v_id;
  if v_open then
    update pm_contract set
      dept_code     = coalesce(nullif(p ->> 'dept_code', ''), dept_code),
      entity        = coalesce(nullif(p ->> 'entity', ''), pm_entity(coalesce(nullif(p ->> 'dept_code', ''), dept_code)), entity),
      currency      = coalesce(nullif(p ->> 'currency', ''), currency),
      fx_rate       = coalesce(nullif(p ->> 'fx_rate', '')::numeric, fx_rate),
      value_pre_vat = nullif(p ->> 'value_pre_vat', '')::numeric,
      vat_pct       = nullif(p ->> 'vat_pct', '')::numeric,
      value_total   = coalesce(nullif(p ->> 'value_total', '')::numeric,
                               case when nullif(p ->> 'value_pre_vat', '') is not null
                                    then round((p ->> 'value_pre_vat')::numeric * (1 + coalesce(nullif(p ->> 'vat_pct', '')::numeric, 0) / 100), 2) end)
    where id = v_id;
  end if;
  return v_id;
end $$;

-- Văn bản đính kèm: p = {contract_id, kind, name, source, storage_path | url, size_bytes, pages}
create or replace function pm_ct_file_add(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; c pm_contract;
begin
  perform pm_ct_need('create');
  select * into c from pm_contract where id = (p ->> 'contract_id')::bigint;
  if not found or not pm_ct_see(c.dept_code) then raise exception 'Không có hợp đồng này.' using errcode = '42501'; end if;
  insert into pm_contract_file (contract_id, kind, name, source, storage_path, url, size_bytes, pages, uploaded_name)
  values (c.id, coalesce(nullif(p ->> 'kind', ''), 'contract'), nullif(trim(p ->> 'name'), ''), p ->> 'source',
          nullif(p ->> 'storage_path', ''), nullif(trim(p ->> 'url'), ''), nullif(p ->> 'size_bytes', '')::bigint,
          nullif(p ->> 'pages', '')::int, am_me_name())
  returning id into v_id;
  return v_id;
end $$;

create or replace function pm_ct_file_del(p_id bigint)
returns text language plpgsql security definer set search_path = public as $$
declare v_path text;
begin
  perform pm_ct_need('edit');
  delete from pm_contract_file where id = p_id returning storage_path into v_path;
  return v_path;                     -- trình duyệt xoá tệp khỏi bucket (chính sách storage cho phép người có quyền sửa)
end $$;

-- Chữ đọc được của một trang (OCR trong trình duyệt), để tìm trong mọi hợp đồng.
create or replace function pm_ct_ocr_save(p_file bigint, p_pages jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pm_ct_need('create');
  update pm_contract_file set ocr = ocr || coalesce(p_pages, '{}'::jsonb), pages = coalesce(pages, nullif(p_pages ->> '_pages', '')::int)
  where id = p_file;
end $$;


-- =====================================================================
-- 5. DUYỆT KÝ
-- =====================================================================

create or replace function pm_ct_submit(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare c pm_contract; s jsonb;
begin
  perform pm_ct_need('create');
  select * into c from pm_contract where id = p_id for update;
  if not found then raise exception 'Không có hợp đồng %.', p_id; end if;
  if c.status not in ('draft', 'returned') then raise exception 'Hợp đồng % không ở trạng thái nháp.', c.no; end if;
  if c.dept_code is null then raise exception 'Chọn bộ phận của hợp đồng trước khi gửi duyệt.'; end if;
  if coalesce(c.value_pre_vat, c.value_total) is null then raise exception 'Ghi giá trị hợp đồng trước khi gửi duyệt.'; end if;
  s := pm_ct_steps(c);
  update pm_contract set status = 'review', route = s, cur = 0, submitted_at = now(),
         needs_legal = exists (select 1 from jsonb_array_elements(s) x where x ->> 'side' = 'legal'), updated_at = now()
  where id = c.id;
  perform am_notify(array(select am_actors(s -> 0 -> 'roles', s -> 0 ->> 'dept')), 'todo', c.no, 'HD', c.dept_code, c.title);
end $$;

create or replace function pm_ct_act(p_id bigint, p_action text, p_comment text default null)
returns text language plpgsql security definer set search_path = public as $$
declare c pm_contract; s jsonb; st jsonb; v_last boolean;
begin
  perform pm_ct_need('view');
  select * into c from pm_contract where id = p_id for update;
  if not found then raise exception 'Không có hợp đồng %.', p_id; end if;
  if c.status <> 'review' then raise exception 'Hợp đồng % không chờ duyệt.', c.no; end if;
  st := c.route -> c.cur;
  if not am_is_actor(st -> 'roles', st ->> 'dept') then raise exception 'Bước này không phải của bạn.' using errcode = '42501'; end if;
  if c.created_by = auth.uid() and not pm_self_ok() then raise exception 'Người lập không duyệt hợp đồng của mình.' using errcode = '42501'; end if;
  if p_action not in ('approve', 'return', 'reject') then raise exception 'Thao tác không hợp lệ: %', p_action; end if;
  if p_action in ('return', 'reject') and coalesce(trim(p_comment), '') = '' then raise exception 'Ghi lý do trả lại / từ chối.'; end if;
  s := jsonb_set(c.route, array[c.cur::text], st || jsonb_build_object('by', auth.uid(), 'name', am_me_name(), 'at', now(), 'action', p_action, 'comment', p_comment));
  v_last := c.cur = jsonb_array_length(c.route) - 1;
  if p_action = 'return' then
    update pm_contract set status = 'returned', route = s, cur = null, updated_at = now() where id = c.id;
    perform am_notify(array[c.created_by], 'returned', c.no, 'HD', c.dept_code, p_comment);
  elsif p_action = 'reject' then
    update pm_contract set status = 'rejected', route = s, cur = null, updated_at = now() where id = c.id;
    perform am_notify(array[c.created_by], 'rejected', c.no, 'HD', c.dept_code, p_comment);
  elsif v_last then
    update pm_contract set status = 'approved', route = s, cur = null, approved_at = now(), updated_at = now() where id = c.id;
    perform am_notify(array[c.created_by], 'approved', c.no, 'HD', c.dept_code, p_comment);
  else
    update pm_contract set route = s, cur = c.cur + 1, updated_at = now() where id = c.id;
    perform am_notify(array(select am_actors(s -> (c.cur + 1) -> 'roles', s -> (c.cur + 1) ->> 'dept')), 'todo', c.no, 'HD', c.dept_code, c.title);
  end if;
  return (select status from pm_contract where id = c.id);
end $$;

create or replace function pm_ct_inbox()
returns setof pm_contract language sql stable security definer set search_path = public as $$
  select c.* from pm_contract c
  where  c.status = 'review'
    and  am_is_actor(c.route -> c.cur -> 'roles', c.route -> c.cur ->> 'dept')
    and  (c.created_by is distinct from auth.uid() or pm_self_ok())
  order by c.submitted_at
$$;

-- Sau khi duyệt: đã ký / đang hiệu lực → hoàn thành (đã bàn giao, còn bảo hành) → đóng; hoặc huỷ.
-- Hợp đồng cũ nhập vào (source import) đi thẳng tới "đang hiệu lực" không qua tuyến duyệt.
create or replace function pm_ct_set_status(p_id bigint, p_status text, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c pm_contract;
begin
  perform pm_ct_need('edit');
  select * into c from pm_contract where id = p_id for update;
  if not found then raise exception 'Không có hợp đồng %.', p_id; end if;
  if p_status not in ('active', 'completed', 'closed', 'cancelled', 'draft') then raise exception 'Trạng thái không hợp lệ: %', p_status; end if;
  if p_status = 'active' and c.status not in ('approved', 'completed') and not (c.source = 'import' and c.status in ('draft', 'returned')) and not app_can('contract', 'admin') then
    raise exception 'Hợp đồng % chưa được duyệt ký.', c.no;
  end if;
  if p_status = 'draft' and c.status not in ('cancelled', 'rejected') then raise exception 'Chỉ mở lại hợp đồng đã huỷ / bị từ chối.'; end if;
  update pm_contract set status = p_status, updated_at = now(),
         route = case when p_comment is null then route
                      else coalesce(route, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('key', p_status, 'by', auth.uid(), 'name', am_me_name(), 'at', now(), 'action', p_status, 'comment', p_comment)) end,
         cur = case when p_status = 'draft' then null else cur end
  where id = c.id;
end $$;

-- Phiếu CT của gói hồ sơ được duyệt xong → tự tạo hợp đồng trong sổ (nháp, điền sẵn từ phiếu).
create or replace function pm_ct_from_doc()
returns trigger language plpgsql security definer set search_path = public as $$
declare p pm_project; d jsonb := coalesce(new.data, '{}'::jsonb); v_id bigint;
begin
  if new.doc_type <> 'CT' or new.status <> 'approved' or old.status = 'approved' then return new; end if;
  if exists (select 1 from pm_contract where doc_id = new.id) then return new; end if;
  select * into p from pm_project where code = new.project_code;
  insert into pm_contract (no, contract_no, title, kind, scope, entity, dept_code, project_code, doc_id, supplier, signed_date,
                           value_pre_vat, warranty_months, pay_terms, status, source, created_by, created_name)
  values (pm_ct_next_no(), nullif(d ->> 'contract_no', ''), coalesce(p.name, new.doc_no), 'supply', 'capex', pm_entity(p.dept_code), p.dept_code,
          new.project_code, new.id, nullif(d ->> 'supplier', ''), nullif(d ->> 'signed_date', '')::date,
          coalesce(nullif(d ->> 'value', '')::numeric, new.total_value), nullif(d ->> 'warranty_months', '')::int,
          coalesce((select jsonb_agg(jsonb_build_object('milestone', l ->> 'milestone', 'pct', l ->> 'pct', 'amount', l ->> 'amount', 'condition', l ->> 'due'))
                    from jsonb_array_elements(coalesce(d -> 'lines', '[]'::jsonb)) l), '[]'::jsonb),
          'approved', 'ct', new.created_by, new.created_email)
  returning id into v_id;
  -- Link hợp đồng đã ký trên phiếu CT (OneDrive) thành văn bản của hợp đồng.
  if coalesce(d ->> 'file_link', '') ~* '^https://' then
    insert into pm_contract_file (contract_id, kind, name, source, url, uploaded_name)
    values (v_id, 'contract', new.doc_no, 'link', d ->> 'file_link', new.created_email);
  end if;
  return new;
end $$;
drop trigger if exists pm_ct_from_doc on pm_doc;
create trigger pm_ct_from_doc after update of status on pm_doc for each row execute function pm_ct_from_doc();


-- =====================================================================
-- 6. NHẮC HẠN, SỔ CHO PHÁP CHẾ
-- =====================================================================

-- Các mốc sắp tới / đã qua của những hợp đồng người xem thấy được.
create or replace function pm_ct_alerts()
returns table (contract_id bigint, no text, title text, kind text, due date, days int, detail text)
language plpgsql stable security definer set search_path = public as $$
declare a jsonb := coalesce((select value from am_setting where key = 'ct_alert_days'), '{"end": 60, "bond": 60, "warranty": 30}'::jsonb);
begin
  perform pm_ct_need('view');
  return query
  with c as (select * from pm_contract x where x.status in ('approved', 'active', 'completed') and pm_ct_see(x.dept_code)),
  m as (
    select c.id, c.no, c.title, 'end'::text k, c.end_date d, null::text det from c where c.end_date is not null and c.status <> 'completed'
    union all
    select c.id, c.no, c.title, 'warranty', c.warranty_until, null from c where c.warranty_until is not null
    union all
    select c.id, c.no, c.title, 'delivery', c.delivery_due, null from c where c.delivery_due is not null and c.handover_date is null and c.status <> 'completed'
    union all
    select c.id, c.no, c.title, 'bond', nullif(b ->> 'expiry', '')::date, b ->> 'kind' from c, jsonb_array_elements(c.bonds) b where nullif(b ->> 'expiry', '') is not null
    union all
    select c.id, c.no, c.title, 'payment', nullif(t ->> 'due', '')::date, t ->> 'milestone' from c, jsonb_array_elements(c.pay_terms) t
    where  (t ->> 'due') ~ '^\d{4}-\d{2}-\d{2}$' and coalesce((t ->> 'paid')::boolean, false) = false
  )
  select m.id, m.no, m.title, m.k, m.d, (m.d - current_date)::int, m.det from m
  where  m.d - current_date <= case m.k when 'end' then coalesce((a ->> 'end')::int, 60) when 'bond' then coalesce((a ->> 'bond')::int, 60)
                                        when 'warranty' then coalesce((a ->> 'warranty')::int, 30) else 7 end
    and  (m.k in ('delivery', 'payment') or m.d >= current_date - 30)
  order by m.d;
end $$;

-- Sổ hợp đồng mua sắm cho Legal Portal (cùng project Supabase): người có quyền xem hợp đồng ở app này,
-- hoặc người có quyền "legal" ở Legal Portal (fn_has_perm, nếu hàm đó có) — chỉ các trường tổng quát.
create or replace function pm_contract_register()
returns table (id bigint, no text, contract_no text, title text, kind text, scope text, entity text, dept_code text,
               project_code text, supplier text, currency text, value_pre_vat numeric, value_total numeric,
               signed_date date, start_date date, end_date date, warranty_until date, status text, legal_ref text,
               needs_legal boolean, files int, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare ok boolean := app_can('contract', 'view');
begin
  if not ok and to_regprocedure('public.fn_has_perm(text,text)') is not null then
    begin execute 'select public.fn_has_perm(''legal'', ''view'')' into ok; exception when others then ok := false; end;
  end if;
  if not coalesce(ok, false) then raise exception 'Không có quyền xem sổ hợp đồng.' using errcode = '42501'; end if;
  return query
  select c.id, c.no, c.contract_no, c.title, c.kind, c.scope, c.entity, c.dept_code, c.project_code, c.supplier, c.currency,
         c.value_pre_vat, c.value_total, c.signed_date, c.start_date, c.end_date, c.warranty_until, c.status, c.legal_ref,
         c.needs_legal, (select count(*)::int from pm_contract_file f where f.contract_id = c.id), c.updated_at
  from   pm_contract c
  where  c.status <> 'cancelled'
  order by c.id desc;
end $$;


-- =====================================================================
-- 7. QUYỀN, STORAGE
-- =====================================================================

alter table pm_contract      enable row level security;
alter table pm_contract_file enable row level security;
revoke all on pm_contract, pm_contract_file from anon, authenticated;
grant select on pm_contract, pm_contract_file to authenticated;

drop policy if exists pm_contract_read on pm_contract;
create policy pm_contract_read on pm_contract for select to authenticated using (pm_ct_see(dept_code));
drop policy if exists pm_contract_file_read on pm_contract_file;
create policy pm_contract_file_read on pm_contract_file for select to authenticated
  using (exists (select 1 from pm_contract c where c.id = contract_id and pm_ct_see(c.dept_code)));

-- Bucket riêng, không công khai; mỗi hợp đồng một thư mục <id>/.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pm-contract', 'pm-contract', false, 26214400,
        array['application/pdf', 'image/jpeg', 'image/png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Thư mục của tệp = id hợp đồng.
create or replace function pm_ct_path_ok(p_name text, p_action text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_can('contract', p_action)
     and exists (select 1 from pm_contract c
                 where c.id::text = split_part(p_name, '/', 1) and pm_ct_see(c.dept_code))
$$;

drop policy if exists pm_contract_upload on storage.objects;
create policy pm_contract_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'pm-contract' and pm_ct_path_ok(name, 'create'));
drop policy if exists pm_contract_read on storage.objects;
create policy pm_contract_read on storage.objects for select to authenticated
  using (bucket_id = 'pm-contract' and pm_ct_path_ok(name, 'view'));
drop policy if exists pm_contract_delete on storage.objects;
create policy pm_contract_delete on storage.objects for delete to authenticated
  using (bucket_id = 'pm-contract' and pm_ct_path_ok(name, 'edit'));

do $$
declare t text;
begin
  foreach t in array array['pm_contract', 'pm_contract_file'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke execute on function pm_ct_need(text), pm_ct_see(text), pm_ct_amount(pm_contract), pm_ct_steps(pm_contract), pm_ct_next_no(),
  pm_ct_warranty_until(date, int), pm_ct_save(jsonb), pm_ct_file_add(jsonb), pm_ct_file_del(bigint), pm_ct_ocr_save(bigint, jsonb),
  pm_ct_submit(bigint), pm_ct_act(bigint, text, text), pm_ct_inbox(), pm_ct_set_status(bigint, text, text), pm_ct_from_doc(),
  pm_ct_alerts(), pm_contract_register(), pm_ct_path_ok(text, text)
  from public, anon;
grant execute on function pm_ct_see(text), pm_ct_save(jsonb), pm_ct_file_add(jsonb), pm_ct_file_del(bigint), pm_ct_ocr_save(bigint, jsonb),
  pm_ct_submit(bigint), pm_ct_act(bigint, text, text), pm_ct_inbox(), pm_ct_set_status(bigint, text, text), pm_ct_alerts(),
  pm_contract_register(), pm_ct_path_ok(text, text)
  to authenticated;

select app_lock_anon();


-- =====================================================================
-- 8. KIỂM CHỨNG
-- =====================================================================

select 'Bảng hợp đồng có RLS' as "Mục", count(*)::text as "Thực tế", '2' as "Mong đợi", case when count(*) = 2 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pm_contract', 'pm_contract_file') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng hợp đồng (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name in ('pm_contract', 'pm_contract_file') and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Khu quyền "contract" + vai trò LEGAL', (select count(*) from app_module where code = 'contract')::text || ' + ' || (select count(*) from app_role where code = 'LEGAL')::text,
       '1 + 1', case when exists (select 1 from app_module where code = 'contract') and exists (select 1 from app_role where code = 'LEGAL') then '✔' else '✘ HỎNG' end
union all
select 'Bucket pm-contract riêng tư', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   storage.buckets where id = 'pm-contract' and not public
union all
select 'Hàm hợp đồng', count(*)::text, '11', case when count(*) = 11 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pm_ct_save', 'pm_ct_file_add', 'pm_ct_file_del', 'pm_ct_ocr_save', 'pm_ct_submit', 'pm_ct_act', 'pm_ct_inbox',
                                 'pm_ct_set_status', 'pm_ct_alerts', 'pm_contract_register', 'pm_ct_from_doc');
