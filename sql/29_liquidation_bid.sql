-- =====================================================================
-- 29_liquidation_bid.sql — THANH LÝ TÀI SẢN, GIAI ĐOẠN 3: GỌI BÁO GIÁ, MỞ THẦU,
--                          KẾT QUẢ, ĐÓNG ĐỢT (26/09/2026)
--
-- Chạy SAU 28_liquidation_batch.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
--   Đợt đã đánh giá lại (valued) → AM team MỞ GỌI BÁO GIÁ: hạn nộp, chỉ dẫn; mời
--   từng bên thu mua bằng MỘT ĐƯỜNG LINK RIÊNG (Liquidation.html — mã bí mật, có
--   hạn, thu hồi được; không cần tài khoản). Bên mua điền Thư báo giá: cá nhân
--   (CCCD) hay doanh nghiệp (MST, email nhận hoá đơn), đơn giá từng món, chi phí
--   thu gom; đính kèm thư báo giá đã ký nếu có. Sửa được tới khi hết hạn; đã nộp
--   thì NIÊM PHONG — trong khách sạn không ai xem được giá cho tới khi MỞ THẦU.
--
--   MỞ THẦU: khi đã quá hạn nộp (hoặc mọi bên được mời đã nộp), AM team ghi danh
--   thành viên Hội đồng CÓ MẶT — phải QUÁ 50% số thành viên; ít hơn 3 báo giá thì
--   bắt buộc giải trình. Kết quả: từng món chọn bên mua (app gợi ý giá cao nhất;
--   chọn khác phải ghi lý do) hoặc HUỶ (không bán được).
--
--   ĐÓNG ĐỢT: mỗi bên mua trúng phải có số hoá đơn GTGT và Gate pass đủ 3 chữ ký
--   (bên mua, bảo vệ, trưởng bộ phận). Đóng đợt thì tình trạng tài sản:
--     đã bán   → 7 "Đã thanh lí" (mã vạch duy nhất) · 23 "Thanh lý một phần" (cùng mã vạch)
--     huỷ      → 9 "Đã hủy" (mã vạch duy nhất)      · 23 (cùng mã vạch)
--     kiểm kê không thấy → 0 "Đã mất" (mã vạch duy nhất); cùng mã vạch giữ nguyên
--
-- An toàn cho project Supabase dùng chung (như 25_pm_tender.sql):
--   - bảng pm_lq_* không cấp cho anon (app_lock_anon cuối file), không có chính
--     sách đọc thẳng — người trong khách sạn đọc qua hàm có kiểm tra quyền;
--   - hàm cho bên mua mang tiền tố vq_, mỗi hàm tự kiểm tra mã link; chỉ các hàm
--     vq_ công khai được cấp cho anon;
--   - Storage: bucket riêng "pm-lqbid", chính sách chỉ áp cho bucket đó.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

alter table pm_lq_batch add column if not exists call_deadline timestamptz;
alter table pm_lq_batch add column if not exists call_terms    text;
alter table pm_lq_batch add column if not exists opened_at     timestamptz;
alter table pm_lq_batch add column if not exists open_note     text;
alter table pm_lq_batch add column if not exists closed_at     timestamptz;

alter table pm_lq_item drop constraint if exists pm_lq_item_status_check;
alter table pm_lq_item add constraint pm_lq_item_status_check
  check (status in ('pool', 'batched', 'sold', 'destroyed', 'kept', 'lost'));
alter table pm_lq_item add column if not exists outcome       text;
alter table pm_lq_item add column if not exists sale_quote_id bigint;
alter table pm_lq_item add column if not exists sale_price    numeric(18, 2);
alter table pm_lq_item add column if not exists sale_value    numeric(18, 2);
alter table pm_lq_item add column if not exists sale_cost     numeric(18, 2);
alter table pm_lq_item add column if not exists buyer         text;
alter table pm_lq_item add column if not exists buyer_id      text;
alter table pm_lq_item add column if not exists award_note    text;
alter table pm_lq_item drop constraint if exists pm_lq_item_outcome_check;
alter table pm_lq_item add constraint pm_lq_item_outcome_check check (outcome is null or outcome in ('sale', 'destroy'));

create table if not exists pm_lq_buyer (
  id           bigserial primary key,
  batch_id     bigint not null references pm_lq_batch(id) on delete cascade,
  token_hash   text not null unique,            -- sha256 của mã trong link; mã gốc không lưu
  name         text not null,
  phone        text,
  email        text,
  expires_at   timestamptz not null,
  revoked      boolean not null default false,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);
create index if not exists pm_lq_buyer_batch_idx on pm_lq_buyer (batch_id);

create table if not exists pm_lq_quote (
  id            bigserial primary key,
  batch_id      bigint not null references pm_lq_batch(id) on delete cascade,
  buyer_id      bigint not null unique references pm_lq_buyer(id) on delete cascade,
  status        text not null default 'draft' check (status in ('draft', 'submitted')),
  version       int  not null default 0,
  data          jsonb not null default '{}'::jsonb,
  files         jsonb not null default '[]'::jsonb,
  upload_key    uuid not null default gen_random_uuid(),
  submitted_at  timestamptz,
  opened_at     timestamptz,
  invoice_no    text,
  invoice_date  date,
  gate_date     date,
  gate_ok       boolean not null default false,
  handover_date date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pm_lq_quote_key_idx on pm_lq_quote (upload_key);
comment on column pm_lq_quote.data is
  'Thư báo giá: kind person|company, name, id_no (CCCD), tax_code (MST), address, phone, email (nhận hoá đơn), representative, prices {item_id: đơn giá}, cost (chi phí thu gom), note, agree.';
comment on column pm_lq_quote.gate_ok is 'Gate pass đã đủ 3 chữ ký: bên mua, bảo vệ, trưởng bộ phận.';

create table if not exists pm_lq_attend (
  batch_id      bigint not null references pm_lq_batch(id) on delete cascade,
  member_id     bigint not null references pm_lq_member(id) on delete cascade,
  present       boolean not null,
  recorded_by   uuid,
  recorded_name text,
  at            timestamptz not null default now(),
  primary key (batch_id, member_id)
);

create table if not exists pm_lq_event (
  id       bigserial primary key,
  batch_id bigint not null references pm_lq_batch(id) on delete cascade,
  at       timestamptz not null default now(),
  actor    text,
  action   text not null,
  detail   text
);
create index if not exists pm_lq_event_batch_idx on pm_lq_event (batch_id, at);

alter table pm_lq_buyer  enable row level security;
alter table pm_lq_quote  enable row level security;
alter table pm_lq_attend enable row level security;
alter table pm_lq_event  enable row level security;
-- Không có chính sách nào: không ai đọc / ghi thẳng được, chỉ qua các hàm dưới.
revoke all on pm_lq_buyer, pm_lq_quote, pm_lq_attend, pm_lq_event from authenticated, anon;


-- =====================================================================
-- 2. HÀM NỘI BỘ
-- =====================================================================

create or replace function pm_lq_log(p_batch bigint, p_actor text, p_action text, p_detail text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into pm_lq_event (batch_id, actor, action, detail) values (p_batch, p_actor, p_action, p_detail)
$$;

create or replace function pm_lq_me()
returns text
language sql
stable
security definer
set search_path = public
as $$ select coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email', 'sql:' || session_user) $$;

-- Mã trong link → bên mua (còn hạn, chưa thu hồi); sai thì báo lỗi chung.
create or replace function vq_buyer(p_token text)
returns pm_lq_buyer
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer;
begin
  select * into v from pm_lq_buyer where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if v.id is null or v.revoked or v.expires_at < now() then
    raise exception 'Đường link không hợp lệ hoặc đã hết hạn. / This link is not valid or has expired.' using errcode = '28000';
  end if;
  update pm_lq_buyer set last_seen_at = now() where id = v.id;
  return v;
end $$;

-- Đợt của bên mua, còn nhận báo giá (đang gọi báo giá, chưa mở thầu, chưa quá hạn).
create or replace function vq_batch(p_buyer pm_lq_buyer, p_write boolean)
returns pm_lq_batch
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  select * into b from pm_lq_batch where id = p_buyer.batch_id;
  if p_write and (b.status <> 'bidding' or b.opened_at is not null or b.call_deadline < now()) then
    raise exception 'Đợt thanh lý đã ngừng nhận báo giá. / This liquidation no longer accepts quotations.';
  end if;
  return b;
end $$;


-- =====================================================================
-- 3. HÀM CHO BÊN MUA (anon, qua link)
-- =====================================================================

-- Mọi thứ bên mua cần: đợt, các món được bán (không có giá sàn), báo giá của CHÍNH MÌNH.
create or replace function vq_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; q pm_lq_quote;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, false);
  select * into q from pm_lq_quote where buyer_id = v.id;
  return jsonb_build_object(
    'buyer', v.name, 'phone', v.phone, 'email', v.email, 'expires_at', v.expires_at,
    'batch', b.code, 'deadline', b.call_deadline, 'terms', b.call_terms,
    'accepting', b.status = 'bidding' and b.opened_at is null and b.call_deadline >= now(),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'name', i.name, 'asset_code', i.asset_code, 'qty', coalesce(i.count_qty, i.qty), 'unit', i.unit,
                'condition', i.condition, 'dept', i.dept_code) order by i.id), '[]')
              from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false),
    'quote', case when q.id is null then null else jsonb_build_object(
                'status', q.status, 'version', q.version, 'data', q.data, 'files', q.files, 'submitted_at', q.submitted_at) end);
end $$;

-- Lưu nháp (sửa được tới khi hết hạn; sửa bản đã nộp thì phải nộp lại).
create or replace function vq_save(p_token text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  if octet_length(coalesce(p_data, '{}')::text) > 200000 then raise exception 'Nội dung quá lớn. / Too much data.'; end if;
  insert into pm_lq_quote (batch_id, buyer_id, data) values (b.id, v.id, coalesce(p_data, '{}'))
  on conflict (buyer_id) do update set data = excluded.data, status = 'draft', updated_at = now();
end $$;

-- Nộp: đủ thông tin bên mua, ít nhất một đơn giá, cam kết. Niêm phong tới khi mở thầu.
create or replace function vq_submit(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; q pm_lq_quote; d jsonb; n int;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  select * into q from pm_lq_quote where buyer_id = v.id;
  if q.id is null then raise exception 'Lưu nháp trước khi nộp. / Save a draft first.'; end if;
  d := q.data;
  if coalesce(d ->> 'kind', '') not in ('person', 'company') then raise exception 'Chọn cá nhân hay doanh nghiệp. / Person or company?'; end if;
  if coalesce(trim(d ->> 'name'), '') = '' or coalesce(trim(d ->> 'phone'), '') = '' or coalesce(trim(d ->> 'address'), '') = '' then
    raise exception 'Nhập họ tên / tên doanh nghiệp, địa chỉ và điện thoại. / Name, address and phone are required.';
  end if;
  if d ->> 'kind' = 'person' and coalesce(trim(d ->> 'id_no'), '') = '' then raise exception 'Nhập số CCCD. / ID number is required.'; end if;
  if d ->> 'kind' = 'company' and (coalesce(trim(d ->> 'tax_code'), '') = '' or coalesce(trim(d ->> 'email'), '') = '') then
    raise exception 'Nhập mã số thuế và email nhận hoá đơn. / Tax code and invoice e-mail are required.';
  end if;
  select count(*) into n from pm_lq_item i
   where i.batch_id = b.id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false
     and coalesce(nullif(d -> 'prices' ->> i.id::text, ''), '0')::numeric > 0;
  if n = 0 then raise exception 'Nhập đơn giá cho ít nhất một món. / Quote at least one item.'; end if;
  if coalesce((d ->> 'agree')::boolean, false) is not true then raise exception 'Xác nhận cam kết trước khi nộp. / Tick the commitment first.'; end if;
  update pm_lq_quote set status = 'submitted', version = version + 1, submitted_at = now(), updated_at = now() where id = q.id;
  perform pm_lq_log(b.id, v.name, 'submit', 'v' || (q.version + 1));
end $$;

create or replace function vq_upload_key(p_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; k uuid;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  select upload_key into k from pm_lq_quote where buyer_id = v.id;
  if k is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  return k::text;
end $$;

create or replace function vq_file_add(p_token text, p_path text, p_name text, p_size bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; q pm_lq_quote;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  select * into q from pm_lq_quote where buyer_id = v.id;
  if q.id is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> q.upload_key::text or length(p_path) > 300 then
    raise exception 'Đường dẫn tệp không hợp lệ. / Invalid file path.';
  end if;
  if jsonb_array_length(q.files) >= 10 then raise exception 'Tối đa 10 tệp. / 10 files at most.'; end if;
  update pm_lq_quote set files = files || jsonb_build_array(jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, ''), 200), 'size', p_size)),
                         status = 'draft', updated_at = now()
   where id = q.id;
end $$;

create or replace function vq_file_remove(p_token text, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  update pm_lq_quote set files = coalesce((select jsonb_agg(f) from jsonb_array_elements(files) f where f ->> 'path' <> p_path), '[]'),
                         status = 'draft', updated_at = now()
   where buyer_id = v.id;
end $$;

-- Chính sách Storage: khách chỉ tải lên vào thư mục của một báo giá còn nhận.
create or replace function vq_upload_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from pm_lq_quote q
    join pm_lq_batch b on b.id = q.batch_id
    join pm_lq_buyer v on v.id = q.buyer_id
    where q.upload_key::text = split_part(coalesce(p_name, ''), '/', 1)
      and b.status = 'bidding' and b.opened_at is null and b.call_deadline >= now()
      and not v.revoked and v.expires_at >= now())
$$;


-- =====================================================================
-- 4. HÀM CHO NGƯỜI TRONG KHÁCH SẠN
-- =====================================================================

-- Mở gọi báo giá (từ "đã đánh giá lại"), hoặc sửa hạn / chỉ dẫn khi chưa mở thầu.
create or replace function pm_lq_call_open(p_batch bigint, p_deadline timestamptz, p_terms text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if not (b.status = 'valued' or (b.status = 'bidding' and b.opened_at is null)) then
    raise exception 'Gọi báo giá khi đợt đã đánh giá lại và chưa mở thầu.';
  end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'Hạn nộp báo giá phải ở tương lai.'; end if;
  update pm_lq_batch set status = 'bidding', call_deadline = p_deadline, call_terms = nullif(trim(p_terms), ''), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), case when b.status = 'valued' then 'call' else 'call_edit' end, to_char(p_deadline, 'DD/MM/YYYY HH24:MI'));
end $$;

-- Mời một bên mua: trả về mã (chỉ MỘT lần — không lưu mã gốc).
create or replace function pm_lq_buyer_add(p_batch bigint, p_name text, p_phone text, p_email text, p_days int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_tok text;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Chỉ mời bên mua khi đang gọi báo giá (chưa mở thầu).'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nhập tên bên mua.'; end if;
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into pm_lq_buyer (batch_id, token_hash, name, phone, email, expires_at, created_by)
  values (b.id, encode(extensions.digest(v_tok, 'sha256'), 'hex'), trim(p_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''),
          greatest(b.call_deadline, now()) + make_interval(days => greatest(1, least(coalesce(p_days, 7), 60))), auth.uid());
  perform pm_lq_log(b.id, pm_lq_me(), 'invite', trim(p_name));
  return v_tok;
end $$;

-- Gia hạn / thu hồi link; tạo mã mới (link cũ hết hiệu lực).
create or replace function pm_lq_buyer_set(p_buyer bigint, p_days int, p_revoke boolean, p_new_token boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_tok text;
begin
  perform pm_lq_need_edit();
  if not exists (select 1 from pm_lq_buyer where id = p_buyer) then raise exception 'Không có bên mua %', p_buyer; end if;
  if p_new_token then v_tok := encode(extensions.gen_random_bytes(24), 'hex'); end if;
  update pm_lq_buyer
     set expires_at = case when p_days is not null then now() + make_interval(days => greatest(1, least(p_days, 60))) else expires_at end,
         revoked = coalesce(p_revoke, revoked),
         token_hash = case when v_tok is not null then encode(extensions.digest(v_tok, 'sha256'), 'hex') else token_hash end
   where id = p_buyer;
  return v_tok;
end $$;

-- Tình hình gọi báo giá của một đợt: bên mua, báo giá (giá / tệp chỉ khi đã mở thầu), điểm danh, nhật ký.
create or replace function pm_lq_bid_list(p_batch bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r jsonb;
begin
  if not (app_trusted() or app_can('liquidation', 'view')) then raise exception 'Bạn không có quyền xem thanh lý.' using errcode = '42501'; end if;
  select jsonb_build_object(
    'buyers', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', v.id, 'name', v.name, 'phone', v.phone, 'email', v.email, 'expires_at', v.expires_at, 'revoked', v.revoked,
                 'last_seen_at', v.last_seen_at,
                 'quote', (select jsonb_build_object('id', q.id, 'status', q.status, 'version', q.version, 'submitted_at', q.submitted_at,
                             'opened_at', q.opened_at, 'invoice_no', q.invoice_no, 'invoice_date', q.invoice_date, 'gate_date', q.gate_date,
                             'gate_ok', q.gate_ok, 'handover_date', q.handover_date,
                             'data', case when q.opened_at is not null then q.data end,
                             'files', case when q.opened_at is not null then q.files end)
                           from pm_lq_quote q where q.buyer_id = v.id)) order by v.id), '[]')
               from pm_lq_buyer v where v.batch_id = p_batch),
    'attend', (select coalesce(jsonb_agg(jsonb_build_object('member_id', a.member_id, 'present', a.present, 'by', a.recorded_name, 'at', a.at)), '[]')
               from pm_lq_attend a where a.batch_id = p_batch),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor', e.actor, 'action', e.action, 'detail', e.detail) order by e.at), '[]')
               from pm_lq_event e where e.batch_id = p_batch)) into r;
  return r;
end $$;

/* MỞ THẦU. p_present: các thành viên hội đồng có mặt — phải QUÁ 50% số thành viên
   của hội đồng của đợt. Chỉ khi đã quá hạn nộp, hoặc mọi bên được mời (còn hiệu
   lực) đã nộp. Ít hơn 3 báo giá: bắt buộc giải trình (p_note). */
create or replace function pm_lq_open(p_batch bigint, p_present bigint[], p_note text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_total int; v_here int; v_sub int; v_wait int;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Đợt không ở bước gọi báo giá, hoặc đã mở thầu.'; end if;
  select count(*) into v_sub from pm_lq_quote where batch_id = b.id and status = 'submitted';
  if v_sub = 0 then raise exception 'Chưa có báo giá nào đã nộp.'; end if;
  select count(*) into v_wait from pm_lq_buyer v where v.batch_id = b.id and not v.revoked
     and not exists (select 1 from pm_lq_quote q where q.buyer_id = v.id and q.status = 'submitted');
  if b.call_deadline > now() and v_wait > 0 then
    raise exception 'Chưa tới hạn nộp và còn % bên mua chưa nộp — chưa mở được.', v_wait;
  end if;
  select count(*) into v_total from pm_lq_member where council_id = b.council_id;
  select count(*) into v_here from pm_lq_member where council_id = b.council_id and id = any(coalesce(p_present, '{}'));
  if v_total = 0 then raise exception 'Hội đồng của đợt chưa có thành viên.'; end if;
  if v_here * 2 <= v_total then
    raise exception 'Cần QUÁ 50%% thành viên hội đồng có mặt: mới có % / %.', v_here, v_total;
  end if;
  if v_sub < 3 and coalesce(trim(p_note), '') = '' then
    raise exception 'Có % báo giá (ít hơn 3) — ghi giải trình trước khi mở.', v_sub;
  end if;
  delete from pm_lq_attend where batch_id = b.id;
  insert into pm_lq_attend (batch_id, member_id, present, recorded_by, recorded_name)
  select b.id, m.id, m.id = any(coalesce(p_present, '{}')), auth.uid(), pm_lq_me() from pm_lq_member m where m.council_id = b.council_id;
  update pm_lq_quote set opened_at = now() where batch_id = b.id and status = 'submitted';
  update pm_lq_batch set opened_at = now(), open_note = nullif(trim(p_note), ''), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'open', v_sub || ' báo giá · ' || v_here || '/' || v_total || ' thành viên');
  return v_sub;
end $$;

/* Kết quả từng món: p_items = [{item_id, outcome: 'sale'|'destroy'|null, quote_id, price, cost, note}].
   Bán: báo giá đã mở của đợt, đơn giá > 0; không phải giá cao nhất của món thì
   bắt buộc ghi lý do. Huỷ: không bán được (hoặc phương án huỷ). Món kiểm kê không
   thấy không có kết quả (đóng đợt ghi "đã mất"). */
create or replace function pm_lq_award(p_batch bigint, p_items jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; x jsonb; i pm_lq_item; q pm_lq_quote; v_max numeric; v_price numeric; n int := 0;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status not in ('valued', 'bidding') then raise exception 'Đợt đã đóng hoặc chưa đánh giá lại.'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into i from pm_lq_item where id = (x ->> 'item_id')::bigint and batch_id = b.id and status = 'batched' for update;
    if i.id is null then raise exception 'Món % không thuộc đợt.', x ->> 'item_id'; end if;
    if i.count_found is false then raise exception '% không thấy khi kiểm kê — không có kết quả bán / huỷ.', coalesce(i.asset_code, i.name); end if;
    if coalesce(x ->> 'outcome', '') = '' then
      update pm_lq_item set outcome = null, sale_quote_id = null, sale_price = null, sale_value = null, sale_cost = null,
                            buyer = null, buyer_id = null, award_note = null where id = i.id;
    elsif x ->> 'outcome' = 'destroy' then
      update pm_lq_item set outcome = 'destroy', sale_quote_id = null, sale_price = null, sale_value = null,
                            sale_cost = nullif(x ->> 'cost', '')::numeric, buyer = null, buyer_id = null,
                            award_note = nullif(trim(x ->> 'note'), '') where id = i.id;
    elsif x ->> 'outcome' = 'sale' then
      if b.opened_at is null then raise exception 'Mở thầu trước khi chọn bên mua.'; end if;
      select * into q from pm_lq_quote where id = (x ->> 'quote_id')::bigint and batch_id = b.id and opened_at is not null;
      if q.id is null then raise exception 'Báo giá không hợp lệ cho %.', coalesce(i.asset_code, i.name); end if;
      v_price := coalesce(nullif(x ->> 'price', '')::numeric, nullif(q.data -> 'prices' ->> i.id::text, '')::numeric);
      if coalesce(v_price, 0) <= 0 then raise exception 'Đơn giá bán của % phải > 0.', coalesce(i.asset_code, i.name); end if;
      select max(nullif(o.data -> 'prices' ->> i.id::text, '')::numeric) into v_max
        from pm_lq_quote o where o.batch_id = b.id and o.opened_at is not null;
      if v_price < coalesce(v_max, 0) and coalesce(trim(x ->> 'note'), '') = '' then
        raise exception '% không chọn giá cao nhất (%) — ghi lý do.', coalesce(i.asset_code, i.name), v_max;
      end if;
      update pm_lq_item set outcome = 'sale', sale_quote_id = q.id, sale_price = v_price,
                            sale_value = round(v_price * coalesce(i.count_qty, i.qty), 2), sale_cost = nullif(x ->> 'cost', '')::numeric,
                            buyer = q.data ->> 'name',
                            buyer_id = case when q.data ->> 'kind' = 'company' then q.data ->> 'tax_code' else q.data ->> 'id_no' end,
                            award_note = nullif(trim(x ->> 'note'), '') where id = i.id;
    else raise exception 'Kết quả không hợp lệ: %', x ->> 'outcome';
    end if;
    n := n + 1;
  end loop;
  perform pm_lq_log(b.id, pm_lq_me(), 'award', n || ' món');
  return n;
end $$;

-- Hồ sơ của bên mua trúng: hoá đơn GTGT, Gate pass (đủ 3 chữ ký), biên bản giao nhận.
create or replace function pm_lq_buyer_doc(p_quote bigint, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare q pm_lq_quote; b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into q from pm_lq_quote where id = p_quote for update;
  select * into b from pm_lq_batch where id = q.batch_id;
  if q.id is null or b.status <> 'bidding' then raise exception 'Báo giá không thuộc đợt đang gọi báo giá.'; end if;
  update pm_lq_quote set
    invoice_no    = case when p_patch ? 'invoice_no' then nullif(trim(p_patch ->> 'invoice_no'), '') else invoice_no end,
    invoice_date  = case when p_patch ? 'invoice_date' then nullif(p_patch ->> 'invoice_date', '')::date else invoice_date end,
    gate_date     = case when p_patch ? 'gate_date' then nullif(p_patch ->> 'gate_date', '')::date else gate_date end,
    gate_ok       = case when p_patch ? 'gate_ok' then coalesce((p_patch ->> 'gate_ok')::boolean, false) else gate_ok end,
    handover_date = case when p_patch ? 'handover_date' then nullif(p_patch ->> 'handover_date', '')::date else handover_date end,
    updated_at = now()
  where id = q.id;
end $$;

/* ĐÓNG ĐỢT: mọi món tìm thấy có kết quả; mỗi bên mua trúng có số hoá đơn GTGT và
   Gate pass đủ 3 chữ ký. Rồi ghi kết quả vào kho và tình trạng tài sản. */
create or replace function pm_lq_close(p_batch bigint, p_date date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_left int; v_bad text;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status not in ('valued', 'bidding') then raise exception 'Đợt % không đóng được ở mốc "%".', b.code, b.status; end if;
  select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and count_found is not false and outcome is null;
  if v_left > 0 then raise exception 'Còn % món chưa có kết quả (bán / huỷ).', v_left; end if;
  select string_agg(distinct coalesce(q.data ->> 'name', v.name), ', ') into v_bad
    from pm_lq_item i join pm_lq_quote q on q.id = i.sale_quote_id join pm_lq_buyer v on v.id = q.buyer_id
   where i.batch_id = b.id and i.status = 'batched' and i.outcome = 'sale' and (coalesce(q.invoice_no, '') = '' or not q.gate_ok);
  if v_bad is not null then
    raise exception 'Thiếu số hoá đơn GTGT hoặc Gate pass chưa đủ 3 chữ ký: %.', v_bad;
  end if;
  -- Tình trạng tài sản.
  update am_asset a set status_code = case when a.asset_kind = 'low' then '23' when i.outcome = 'sale' then '7' else '9' end
    from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.outcome in ('sale', 'destroy') and a.id = i.asset_id;
  update am_asset a set status_code = '0'
    from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.count_found is false and a.id = i.asset_id and a.asset_kind = 'unique';
  update pm_lq_item set status = case when count_found is false then 'lost' when outcome = 'sale' then 'sold' else 'destroyed' end
   where batch_id = b.id and status = 'batched';
  update pm_lq_batch set status = 'closed', liquidation_date = coalesce(p_date, liquidation_date, current_date), closed_at = now(), updated_at = now()
   where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'close', null);
end $$;

-- Chính sách Storage: người trong khách sạn chỉ xem tệp của báo giá ĐÃ MỞ.
create or replace function pm_lq_file_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_can('liquidation', 'view') and exists (
    select 1 from pm_lq_quote q where q.upload_key::text = split_part(coalesce(p_name, ''), '/', 1) and q.opened_at is not null)
$$;

-- Đợt 'bidding' lùi được về 'valued' khi chưa mời ai (mở gọi báo giá nhầm).
create or replace function pm_lq_call_cancel(p_batch bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Chỉ huỷ gọi báo giá khi chưa mở thầu.'; end if;
  if exists (select 1 from pm_lq_buyer where batch_id = b.id) then raise exception 'Đã mời bên mua — thu hồi link thay vì huỷ.'; end if;
  update pm_lq_batch set status = 'valued', call_deadline = null, updated_at = now() where id = b.id;
end $$;


-- =====================================================================
-- 5. QUYỀN GỌI HÀM, STORAGE
-- =====================================================================

revoke execute on function pm_lq_log(bigint, text, text, text), pm_lq_me(), vq_buyer(text), vq_batch(pm_lq_buyer, boolean)
  from public, anon, authenticated;
grant execute on function pm_lq_call_open(bigint, timestamptz, text), pm_lq_buyer_add(bigint, text, text, text, int),
                          pm_lq_buyer_set(bigint, int, boolean, boolean), pm_lq_bid_list(bigint), pm_lq_open(bigint, bigint[], text),
                          pm_lq_award(bigint, jsonb), pm_lq_buyer_doc(bigint, jsonb), pm_lq_close(bigint, date), pm_lq_file_ok(text),
                          pm_lq_call_cancel(bigint)
  to authenticated;
-- Chỉ các hàm vq_ công khai được cấp cho khách (anon): mỗi hàm tự kiểm tra mã link.
revoke execute on function vq_session(text), vq_save(text, jsonb), vq_submit(text), vq_upload_key(text),
                           vq_file_add(text, text, text, bigint), vq_file_remove(text, text), vq_upload_ok(text) from public;
grant execute on function vq_session(text), vq_save(text, jsonb), vq_submit(text), vq_upload_key(text),
                          vq_file_add(text, text, text, bigint), vq_file_remove(text, text), vq_upload_ok(text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pm-lqbid', 'pm-lqbid', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pm_lqbid_upload on storage.objects;
create policy pm_lqbid_upload on storage.objects for insert to anon
  with check (bucket_id = 'pm-lqbid' and vq_upload_ok(name));
drop policy if exists pm_lqbid_read on storage.objects;
create policy pm_lqbid_read on storage.objects for select to authenticated
  using (bucket_id = 'pm-lqbid' and pm_lq_file_ok(name));

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Bảng gọi báo giá thanh lý có RLS' as "Mục", count(*)::text as "Thực tế", '4' as "Mong đợi",
       case when count(*) = 4 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pm_lq_buyer', 'pm_lq_quote', 'pm_lq_attend', 'pm_lq_event') and relrowsecurity
union all
select 'Chính sách đọc thẳng các bảng đó (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'public' and tablename in ('pm_lq_buyer', 'pm_lq_quote', 'pm_lq_attend', 'pm_lq_event')
union all
select 'Khách (anon) đọc / ghi thẳng bảng thanh lý (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants where grantee = 'anon' and table_name like 'pm\_lq%'
union all
select 'Khách gọi được hàm pm_ / hàm nội bộ (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where (proname like 'pm\_lq%' or proname in ('vq_buyer', 'vq_batch')) and has_function_privilege('anon', oid, 'execute')
union all
select 'Hàm vq_ công khai cho bên mua', count(*)::text, '7', case when count(*) = 7 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('vq_session', 'vq_save', 'vq_submit', 'vq_upload_key', 'vq_file_add', 'vq_file_remove', 'vq_upload_ok')
  and  has_function_privilege('anon', oid, 'execute')
union all
select 'Bucket pm-lqbid (riêng tư) + 2 chính sách', (select count(*) from storage.buckets where id = 'pm-lqbid' and not public)::text || ' + ' || count(*)::text,
       '1 + 2', case when count(*) = 2 and exists (select 1 from storage.buckets where id = 'pm-lqbid' and not public) then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('pm_lqbid_upload', 'pm_lqbid_read');
