-- =====================================================================
-- 25_pm_tender.sql — PORTAL ĐẤU THẦU CHO NHÀ THẦU (26/09/2026)
--
-- Chạy SAU 24_ui_feedback.sql. Chạy lại nhiều lần vô hại.
--
--   Thu mua mở một ĐỢT ĐẤU THẦU cho một QC (hạng mục, số lượng, phạm vi công
--   việc = hồ sơ mời thầu, tiêu chí năng lực phải kê khai, hạn nộp) và gửi cho
--   từng nhà thầu MỘT ĐƯỜNG LINK RIÊNG (mã bí mật, có hạn dùng, thu hồi được;
--   một link có thể gắn với nhiều đợt đấu thầu). Không cần tài khoản.
--
--   Nhà thầu (qua link) điền đơn giá từng hạng mục, spec từng trường, các dòng
--   chi phí khác (overheads), điều khoản, kê khai năng lực, và tải lên báo giá
--   có đóng dấu + tài liệu liên quan. Được LƯU NHÁP và sửa; đã NỘP thì không
--   rút lại được — muốn đổi phải tạo BẢN MỚI (yêu cầu thay thế).
--
--   HỒ SƠ NIÊM PHONG: không ai trong khách sạn xem được nội dung / tệp của hồ
--   sơ đã nộp cho tới khi ĐỦ BA người đồng ý mở trong cùng một lượt: người lập
--   QC (Thu mua), Trưởng bộ phận, Trưởng bộ phận tài chính (theo chuỗi duyệt QC
--   của pháp nhân: bước 0, 1, 2). Bản thay thế (v2…) nộp sau lượt mở chỉ được
--   xem khi có lượt đồng ý mới đủ ba người. QC bị từ chối → Thu mua MỞ LẠI đợt
--   (vòng mới) để nhà thầu nộp lại.
--
--   Tệp: Supabase Storage, bucket riêng "pm-tender", mỗi hồ sơ một thư mục có
--   khoá ngẫu nhiên. Khách chỉ TẢI LÊN được (vào thư mục của hồ sơ nháp còn hạn),
--   không xem / liệt kê / xoá được gì. Người trong khách sạn chỉ xem được tệp của
--   hồ sơ ĐÃ MỞ.
--
-- An toàn cho project Supabase dùng chung:
--   - bảng pm_tender_* không cấp cho anon (app_lock_anon() ở cuối) và KHÔNG cấp
--     SELECT trực tiếp cho authenticated — đọc qua hàm có kiểm tra;
--   - hàm cho nhà thầu mang tiền tố vp_ (app_lock_anon chỉ khoá am_/app_/pm_),
--     mỗi hàm tự kiểm tra mã link; chỉ các hàm vp_ được cấp cho anon;
--   - Storage: chỉ bucket "pm-tender", chính sách chỉ áp cho bucket đó.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_tender (
  id           bigserial primary key,
  project_code text not null references pm_project(code) on update cascade on delete cascade,
  qc_doc_id    bigint references pm_doc(id) on delete set null,
  title        text,
  scope        text,                           -- phạm vi công việc / hồ sơ mời thầu
  terms        text,                           -- chỉ dẫn, điều kiện chào giá
  items        jsonb not null default '[]',    -- [{item, qty, unit}]
  crit         jsonb not null default '[]',    -- tiêu chí kê khai [{label, grp: ability|technique}]
  deadline     timestamptz not null,
  status       text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  round        int  not null default 1,        -- vòng nộp (tăng khi mở lại cho nộp lại)
  open_seq     int  not null default 1,        -- lượt đồng ý mở hiện tại
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pm_tender_project_idx on pm_tender (project_code);

create table if not exists pm_tender_invitee (
  id           bigserial primary key,
  token_hash   text not null unique,           -- sha256 của mã trong link; mã gốc không lưu
  vendor_code  text,
  vendor_name  text not null,
  email        text,
  expires_at   timestamptz not null,
  revoked      boolean not null default false,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists pm_tender_invite (
  invitee_id bigint not null references pm_tender_invitee(id) on delete cascade,
  tender_id  bigint not null references pm_tender(id) on delete cascade,
  primary key (invitee_id, tender_id)
);

create table if not exists pm_tender_bid (
  id           bigserial primary key,
  tender_id    bigint not null references pm_tender(id) on delete cascade,
  invitee_id   bigint not null references pm_tender_invitee(id) on delete cascade,
  round        int  not null,
  version      int  not null,
  status       text not null default 'draft' check (status in ('draft', 'submitted', 'superseded')),
  data         jsonb not null default '{}',
  files        jsonb not null default '[]',    -- [{path, name, size, kind}]
  upload_key   uuid not null default gen_random_uuid(),
  note         text,                           -- lý do bản thay thế
  submitted_at timestamptz,
  opened_at    timestamptz,                    -- null = còn niêm phong
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tender_id, invitee_id, round, version)
);
create index if not exists pm_tender_bid_key_idx on pm_tender_bid (upload_key);

create table if not exists pm_tender_consent (
  tender_id bigint not null references pm_tender(id) on delete cascade,
  seq       int  not null,
  role_code text not null,
  user_id   uuid not null,
  user_name text,
  at        timestamptz not null default now(),
  primary key (tender_id, seq, role_code)
);

-- Nhật ký đợt đấu thầu (không chứa nội dung hồ sơ — hồ sơ niêm phong).
create table if not exists pm_tender_event (
  id        bigserial primary key,
  tender_id bigint not null references pm_tender(id) on delete cascade,
  at        timestamptz not null default now(),
  actor     text,
  action    text not null,
  detail    text
);

alter table pm_tender         enable row level security;
alter table pm_tender_invitee enable row level security;
alter table pm_tender_invite  enable row level security;
alter table pm_tender_bid     enable row level security;
alter table pm_tender_consent enable row level security;
alter table pm_tender_event   enable row level security;
-- Không có chính sách nào: không ai đọc / ghi thẳng được, chỉ qua các hàm dưới.
revoke all on pm_tender, pm_tender_invitee, pm_tender_invite, pm_tender_bid, pm_tender_consent, pm_tender_event
  from authenticated, anon;


-- =====================================================================
-- 2. HÀM DÙNG CHUNG (nội bộ)
-- =====================================================================

-- Ba vai trò phải đồng ý mở hồ sơ: bước 0, 1, 2 của chuỗi duyệt QC của pháp nhân
-- (SSP: Thu mua, Trưởng bộ phận, Trưởng bộ phận tài chính).
create or replace function pm_tender_open_roles(p_project text)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(c.role_code order by c.step), '{}')
  from   pm_project p
  join   pm_chain c on c.entity = pm_entity(p.dept_code) and c.doc_type = 'QC' and c.step <= 2
  where  p.code = p_project
$$;

create or replace function pm_tender_log(p_tender bigint, p_actor text, p_action text, p_detail text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into pm_tender_event (tender_id, actor, action, detail) values (p_tender, p_actor, p_action, p_detail)
$$;

-- Người trong khách sạn được quản lý đợt đấu thầu của dự án: người lập QC hoặc quản trị dự án.
create or replace function pm_tender_can_manage(p_project text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted() or app_can('project', 'admin')
      or coalesce((select pm_can_prepare('QC', p.dept_code) from pm_project p where p.code = p_project), false)
$$;

-- Mã trong link → người được mời (còn hạn, chưa thu hồi); sai thì báo lỗi chung.
create or replace function vp_invitee(p_token text)
returns pm_tender_invitee
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee;
begin
  select * into v from pm_tender_invitee
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if v.id is null or v.revoked or v.expires_at < now() then
    raise exception 'Đường link không hợp lệ hoặc đã hết hạn. / This link is not valid or has expired.' using errcode = '28000';
  end if;
  update pm_tender_invitee set last_seen_at = now() where id = v.id;
  return v;
end $$;

-- Đợt đấu thầu mà người được mời có quyền vào, còn nhận hồ sơ (đang mở, chưa quá hạn).
create or replace function vp_tender_for(p_inv bigint, p_tender bigint, p_write boolean)
returns pm_tender
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender;
begin
  select t2.* into t from pm_tender t2 join pm_tender_invite i on i.tender_id = t2.id
   where t2.id = p_tender and i.invitee_id = p_inv;
  if t.id is null then raise exception 'Không có đợt đấu thầu này. / No such tender.'; end if;
  if p_write and (t.status <> 'open' or t.deadline < now()) then
    raise exception 'Đợt đấu thầu đã đóng hoặc quá hạn nộp. / The tender is closed or past its deadline.';
  end if;
  return t;
end $$;


-- =====================================================================
-- 3. HÀM CHO NHÀ THẦU (anon, qua link)
-- =====================================================================

-- Mọi thứ nhà thầu cần thấy: các đợt được mời, hồ sơ của CHÍNH MÌNH.
create or replace function vp_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; r jsonb;
begin
  v := vp_invitee(p_token);
  select jsonb_build_object(
    'vendor', v.vendor_name, 'email', v.email, 'expires_at', v.expires_at,
    'tenders', coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'project_code', t.project_code, 'project_name', p.name,
      'scope', t.scope, 'terms', t.terms, 'items', t.items, 'crit', t.crit,
      'deadline', t.deadline, 'status', t.status, 'round', t.round,
      'accepting', t.status = 'open' and t.deadline >= now(),
      'bids', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', b.id, 'round', b.round, 'version', b.version, 'status', b.status,
                  'data', b.data, 'files', b.files, 'note', b.note, 'submitted_at', b.submitted_at)
                  order by b.round, b.version), '[]')
               from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id)
    ) order by t.deadline), '[]'))
  into r
  from pm_tender_invite i join pm_tender t on t.id = i.tender_id join pm_project p on p.code = t.project_code
  where i.invitee_id = v.id and t.status <> 'cancelled';
  return r;
end $$;

-- Lưu nháp. Chỉ sửa được bản NHÁP của vòng hiện tại; chưa có thì tạo bản 1.
create or replace function vp_save(p_token text, p_tender bigint, p_data jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  if octet_length(coalesce(p_data, '{}')::text) > 500000 then raise exception 'Nội dung quá lớn. / Too much data.'; end if;
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round
   order by version desc limit 1;
  if b.id is null then
    insert into pm_tender_bid (tender_id, invitee_id, round, version, data)
    values (t.id, v.id, t.round, 1, coalesce(p_data, '{}')) returning * into b;
    perform pm_tender_log(t.id, v.vendor_name, 'draft', 'v1');
    return b.id;
  end if;
  if b.status <> 'draft' then
    raise exception 'Hồ sơ đã nộp không sửa được — hãy tạo bản thay thế. / A submitted bid cannot be changed — create a replacement.';
  end if;
  update pm_tender_bid set data = coalesce(p_data, '{}'), updated_at = now() where id = b.id;
  return b.id;
end $$;

-- Bản thay thế: sau khi đã nộp, tạo bản nháp mới (chép nội dung và tệp của bản đã nộp).
create or replace function vp_new_version(p_token text, p_tender bigint, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid; n bigint;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round
   order by version desc limit 1;
  if b.id is null or b.status <> 'submitted' then
    raise exception 'Chỉ tạo bản thay thế sau khi đã nộp. / A replacement follows a submitted bid.';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Ghi lý do thay thế. / Give the reason for the replacement.'; end if;
  insert into pm_tender_bid (tender_id, invitee_id, round, version, data, files, note)
  values (t.id, v.id, t.round, b.version + 1, b.data, b.files, trim(p_reason)) returning id into n;
  perform pm_tender_log(t.id, v.vendor_name, 'replace', 'v' || (b.version + 1) || ': ' || trim(p_reason));
  return n;
end $$;

-- Nộp bản nháp: khoá lại, không rút được. Cần đủ đơn giá và báo giá có đóng dấu.
create or replace function vp_submit(p_token text, p_tender bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid; n int; i int;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if b.id is null then raise exception 'Chưa có bản nháp để nộp. / There is no draft to submit.'; end if;
  n := jsonb_array_length(t.items);
  for i in 0 .. n - 1 loop
    if coalesce(nullif(b.data -> 'prices' ->> i::text, ''), '0')::numeric <= 0 then
      raise exception 'Thiếu đơn giá hạng mục %. / Unit price missing for item %.', i + 1, i + 1;
    end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'quotation') then
    raise exception 'Tải lên báo giá có đóng dấu trước khi nộp. / Upload the stamped quotation before submitting.';
  end if;
  update pm_tender_bid set status = 'submitted', submitted_at = now(), updated_at = now() where id = b.id;
  -- Bản trước (đã nộp) của cùng vòng: được thay thế.
  update pm_tender_bid set status = 'superseded', updated_at = now()
   where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'submitted' and id <> b.id;
  perform pm_tender_log(t.id, v.vendor_name, 'submit', 'v' || b.version);
end $$;

-- Tệp đã tải lên Storage: ghi vào hồ sơ nháp (đường dẫn phải nằm trong thư mục của hồ sơ).
create or replace function vp_file_add(p_token text, p_tender bigint, p_path text, p_name text, p_size bigint, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if b.id is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> b.upload_key::text or length(p_path) > 300 then
    raise exception 'Đường dẫn tệp không hợp lệ. / Invalid file path.';
  end if;
  if jsonb_array_length(b.files) >= 20 then raise exception 'Tối đa 20 tệp. / 20 files at most.'; end if;
  update pm_tender_bid
     set files = files || jsonb_build_array(jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, ''), 200),
                          'size', p_size, 'kind', case when p_kind = 'quotation' then 'quotation' else 'other' end)),
         updated_at = now()
   where id = b.id;
end $$;

create or replace function vp_file_remove(p_token text, p_tender bigint, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if b.id is null then raise exception 'Hồ sơ đã nộp không sửa được. / A submitted bid cannot be changed.'; end if;
  update pm_tender_bid set files = coalesce((select jsonb_agg(f) from jsonb_array_elements(files) f where f ->> 'path' <> p_path), '[]'),
                           updated_at = now()
   where id = b.id;
end $$;

-- Thư mục tải lên của hồ sơ nháp (khoá ngẫu nhiên, chỉ trả cho đúng nhà thầu).
create or replace function vp_upload_key(p_token text, p_tender bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; k uuid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select upload_key into k from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if k is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  return k::text;
end $$;

-- Dùng trong chính sách Storage: khách chỉ tải lên vào thư mục của một hồ sơ NHÁP còn nhận hồ sơ.
create or replace function vp_upload_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from pm_tender_bid b
    join pm_tender t on t.id = b.tender_id
    join pm_tender_invitee v on v.id = b.invitee_id
    where b.upload_key::text = split_part(coalesce(p_name, ''), '/', 1)
      and b.status = 'draft' and t.status = 'open' and t.deadline >= now()
      and not v.revoked and v.expires_at >= now())
$$;


-- =====================================================================
-- 4. HÀM CHO NGƯỜI TRONG KHÁCH SẠN (authenticated, tự kiểm tra quyền)
-- =====================================================================

-- Mở đợt đấu thầu từ một QC: hạng mục và tiêu chí lấy từ QC.
create or replace function pm_tender_create(p_qc bigint, p_deadline timestamptz, p_title text, p_scope text, p_terms text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; n bigint; v_items jsonb; v_crit jsonb;
begin
  select * into d from pm_doc where id = p_qc and doc_type = 'QC';
  if d.id is null then raise exception 'Không có QC %.', p_qc; end if;
  if not pm_tender_can_manage(d.project_code) then raise exception 'Bạn không có quyền mở đấu thầu cho dự án này.' using errcode = '42501'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'Hạn nộp phải ở tương lai.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('item', l ->> 'item', 'qty', l -> 'qty', 'unit', l ->> 'unit')), '[]') into v_items
    from jsonb_array_elements(coalesce(d.data -> 'qlines', '[]')) l where coalesce(l ->> 'item', '') <> '';
  if jsonb_array_length(v_items) = 0 then raise exception 'QC chưa có hạng mục nào.'; end if;
  select coalesce(jsonb_agg(x), '[]') into v_crit from (
    select jsonb_build_object('label', s ->> 'label', 'grp', 'ability') x from jsonb_array_elements(coalesce(d.data -> 'sub_ability', '[]')) s where coalesce(s ->> 'label', '') <> ''
    union all
    select jsonb_build_object('label', s ->> 'label', 'grp', 'technique') from jsonb_array_elements(coalesce(d.data -> 'sub_technique', '[]')) s where coalesce(s ->> 'label', '') <> '') q;
  insert into pm_tender (project_code, qc_doc_id, title, scope, terms, items, crit, deadline, created_by)
  values (d.project_code, d.id, nullif(trim(p_title), ''), p_scope, p_terms, v_items, v_crit, p_deadline, auth.uid())
  returning id into n;
  perform pm_tender_log(n, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'create', to_char(p_deadline, 'YYYY-MM-DD HH24:MI'));
  return n;
end $$;

-- Sửa đợt: hạn nộp (gia hạn để làm rõ), phạm vi, chỉ dẫn, đóng / huỷ.
create or replace function pm_tender_update(p_id bigint, p_deadline timestamptz, p_scope text, p_terms text, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_id for update;
  if t.id is null then raise exception 'Không có đợt đấu thầu %.', p_id; end if;
  if not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền sửa đợt đấu thầu này.' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('open', 'closed', 'cancelled') then raise exception 'Trạng thái không hợp lệ.'; end if;
  update pm_tender set deadline = coalesce(p_deadline, deadline), scope = coalesce(p_scope, scope), terms = coalesce(p_terms, terms),
                       status = coalesce(p_status, status), updated_at = now()
   where id = p_id;
  perform pm_tender_log(p_id, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'update',
                        concat_ws(' · ', to_char(p_deadline, 'YYYY-MM-DD HH24:MI'), p_status));
end $$;

-- Mở lại cho nộp lại (QC bị từ chối / lần 1 thất bại): vòng mới, hạn mới.
create or replace function pm_tender_reopen(p_id bigint, p_deadline timestamptz, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_id for update;
  if t.id is null then raise exception 'Không có đợt đấu thầu %.', p_id; end if;
  if not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền mở lại đợt đấu thầu này.' using errcode = '42501'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'Hạn nộp phải ở tương lai.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Ghi lý do mở lại.'; end if;
  update pm_tender set round = round + 1, status = 'open', deadline = p_deadline, updated_at = now() where id = p_id;
  perform pm_tender_log(p_id, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'reopen', trim(p_reason));
end $$;

-- Mời một nhà thầu vào một hoặc nhiều đợt: trả về mã (chỉ MỘT lần — không lưu mã gốc).
create or replace function pm_tender_invite_add(p_tenders bigint[], p_vendor_code text, p_name text, p_email text, p_days int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_tok text; n bigint; t bigint;
begin
  if coalesce(array_length(p_tenders, 1), 0) = 0 then raise exception 'Chọn ít nhất một đợt đấu thầu.'; end if;
  foreach t in array p_tenders loop
    if not exists (select 1 from pm_tender x where x.id = t and x.status = 'open' and pm_tender_can_manage(x.project_code)) then
      raise exception 'Đợt đấu thầu % không mở hoặc bạn không có quyền.', t using errcode = '42501';
    end if;
  end loop;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nhập tên nhà thầu.'; end if;
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into pm_tender_invitee (token_hash, vendor_code, vendor_name, email, expires_at, created_by)
  values (encode(extensions.digest(v_tok, 'sha256'), 'hex'), nullif(trim(p_vendor_code), ''), trim(p_name), nullif(trim(p_email), ''),
          now() + make_interval(days => greatest(1, least(coalesce(p_days, 14), 90))), auth.uid())
  returning id into n;
  insert into pm_tender_invite (invitee_id, tender_id) select n, unnest(p_tenders) on conflict do nothing;
  foreach t in array p_tenders loop
    perform pm_tender_log(t, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'invite', trim(p_name));
  end loop;
  return v_tok;
end $$;

-- Gia hạn / thu hồi link; tạo link mới (mã mới, link cũ hết hiệu lực).
create or replace function pm_tender_invite_set(p_invitee bigint, p_days int, p_revoke boolean, p_new_token boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_tok text;
begin
  if not exists (select 1 from pm_tender_invite i join pm_tender t on t.id = i.tender_id
                  where i.invitee_id = p_invitee and pm_tender_can_manage(t.project_code)) then
    raise exception 'Bạn không có quyền với link này.' using errcode = '42501';
  end if;
  if p_new_token then v_tok := encode(extensions.gen_random_bytes(24), 'hex'); end if;
  update pm_tender_invitee
     set expires_at = case when p_days is not null then now() + make_interval(days => greatest(1, least(p_days, 90))) else expires_at end,
         revoked = coalesce(p_revoke, revoked),
         token_hash = case when v_tok is not null then encode(extensions.digest(v_tok, 'sha256'), 'hex') else token_hash end
   where id = p_invitee;
  return v_tok;
end $$;

-- Đợt đấu thầu của một dự án, cho màn hình QC: KHÔNG có nội dung hồ sơ chưa mở.
create or replace function pm_tender_list(p_project text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r jsonb;
begin
  if not (app_trusted() or app_can('project', 'view')) then raise exception 'Bạn không có quyền xem dự án.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'qc_doc_id', t.qc_doc_id, 'title', t.title, 'scope', t.scope, 'terms', t.terms, 'items', t.items, 'crit', t.crit,
    'deadline', t.deadline, 'status', t.status, 'round', t.round, 'open_seq', t.open_seq, 'created_at', t.created_at,
    'can_manage', pm_tender_can_manage(t.project_code),
    'open_roles', to_jsonb(pm_tender_open_roles(t.project_code)),
    'consents', (select coalesce(jsonb_agg(jsonb_build_object('role', c.role_code, 'user', c.user_name, 'at', c.at)), '[]')
                 from pm_tender_consent c where c.tender_id = t.id and c.seq = t.open_seq),
    'invitees', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', v.id, 'vendor_code', v.vendor_code, 'name', v.vendor_name, 'email', v.email, 'expires_at', v.expires_at,
                   'revoked', v.revoked, 'last_seen_at', v.last_seen_at,
                   'bids', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'round', b.round, 'version', b.version, 'status', b.status,
                              'submitted_at', b.submitted_at, 'opened_at', b.opened_at, 'note', case when b.opened_at is not null then b.note end,
                              -- nội dung và tệp chỉ khi đã mở
                              'data', case when b.opened_at is not null then b.data end,
                              'files', case when b.opened_at is not null then b.files end) order by b.round, b.version), '[]')
                            from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id)) order by v.id), '[]')
                 from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id where i.tender_id = t.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor', e.actor, 'action', e.action, 'detail', e.detail) order by e.at), '[]')
               from pm_tender_event e where e.tender_id = t.id)
  ) order by t.id), '[]') into r
  from pm_tender t where t.project_code = p_project;
  return r;
end $$;

-- Các đợt đang mở mà người bấm quản lý được: để một link mời vào nhiều đợt cùng lúc.
create or replace function pm_tender_open_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'project_code', t.project_code, 'project_name', p.name,
                                               'title', t.title, 'deadline', t.deadline) order by t.deadline), '[]')
  from pm_tender t join pm_project p on p.code = t.project_code
  where t.status = 'open' and t.deadline >= now() and pm_tender_can_manage(t.project_code)
$$;

-- Đồng ý mở hồ sơ, theo MỘT vai trò của người bấm. Đủ ba vai trò trong lượt → mở mọi
-- hồ sơ đã nộp còn niêm phong, rồi sang lượt mới (bản thay thế nộp sau cần lượt mới).
create or replace function pm_tender_consent_give(p_tender bigint, p_role text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender; p pm_project; v_roles text[]; v_have int; v_sealed int; v_waiting int;
begin
  select * into t from pm_tender where id = p_tender for update;
  if t.id is null then raise exception 'Không có đợt đấu thầu %.', p_tender; end if;
  select * into p from pm_project where code = t.project_code;
  v_roles := pm_tender_open_roles(t.project_code);
  if not (p_role = any(v_roles)) then raise exception 'Vai trò % không thuộc nhóm đồng ý mở hồ sơ.', p_role; end if;
  if not app_user_role_covers(auth.uid(), p_role, p.dept_code) then
    raise exception 'Bạn không giữ vai trò % cho bộ phận %.', p_role, p.dept_code using errcode = '42501';
  end if;
  select count(*) into v_sealed from pm_tender_bid where tender_id = t.id and status in ('submitted', 'superseded') and opened_at is null;
  if v_sealed = 0 then raise exception 'Không có hồ sơ niêm phong nào để mở.'; end if;
  -- Trước hạn nộp chỉ mở được khi mọi nhà thầu được mời đã nộp ở vòng hiện tại.
  select count(*) into v_waiting from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id
   where i.tender_id = t.id and not v.revoked
     and not exists (select 1 from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id and b.round = t.round and b.status = 'submitted');
  if t.deadline > now() and v_waiting > 0 then
    raise exception 'Chưa tới hạn nộp và còn % nhà thầu chưa nộp — chưa mở được.', v_waiting;
  end if;
  -- Ba người khác nhau (trừ khi đang bật tự duyệt để thử nghiệm).
  if not pm_self_ok() and exists (select 1 from pm_tender_consent where tender_id = t.id and seq = t.open_seq and user_id = auth.uid() and role_code <> p_role) then
    raise exception 'Mỗi người chỉ đồng ý theo một vai trò — cần ba người khác nhau.';
  end if;
  insert into pm_tender_consent (tender_id, seq, role_code, user_id, user_name)
  values (t.id, t.open_seq, p_role, auth.uid(), coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
  on conflict (tender_id, seq, role_code) do nothing;
  perform pm_tender_log(t.id, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'consent', p_role);
  select count(distinct role_code) into v_have from pm_tender_consent where tender_id = t.id and seq = t.open_seq and role_code = any(v_roles);
  if v_have >= coalesce(array_length(v_roles, 1), 3) then
    update pm_tender_bid set opened_at = now() where tender_id = t.id and status in ('submitted', 'superseded') and opened_at is null;
    update pm_tender set open_seq = open_seq + 1, updated_at = now() where id = t.id;
    perform pm_tender_log(t.id, 'system', 'opened', v_sealed || ' bid(s)');
    return 'opened';
  end if;
  return 'waiting';
end $$;

-- Dùng trong chính sách Storage: người trong khách sạn chỉ xem tệp của hồ sơ ĐÃ MỞ.
create or replace function pm_tender_file_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_can('project', 'view') and exists (
    select 1 from pm_tender_bid b
    where b.upload_key::text = split_part(coalesce(p_name, ''), '/', 1) and b.opened_at is not null)
$$;


-- =====================================================================
-- 5. QUYỀN GỌI HÀM
-- =====================================================================

revoke execute on function pm_tender_open_roles(text), pm_tender_log(bigint, text, text, text), pm_tender_can_manage(text),
                           vp_invitee(text), vp_tender_for(bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function pm_tender_create(bigint, timestamptz, text, text, text), pm_tender_update(bigint, timestamptz, text, text, text),
                          pm_tender_reopen(bigint, timestamptz, text), pm_tender_invite_add(bigint[], text, text, text, int),
                          pm_tender_invite_set(bigint, int, boolean, boolean), pm_tender_list(text), pm_tender_open_list(),
                          pm_tender_consent_give(bigint, text), pm_tender_file_ok(text) to authenticated;
-- Chỉ các hàm vp_ công khai được cấp cho khách (anon): mỗi hàm tự kiểm tra mã link.
revoke execute on function vp_session(text), vp_save(text, bigint, jsonb), vp_new_version(text, bigint, text),
                           vp_submit(text, bigint), vp_file_add(text, bigint, text, text, bigint, text),
                           vp_file_remove(text, bigint, text), vp_upload_key(text, bigint), vp_upload_ok(text) from public;
grant execute on function vp_session(text), vp_save(text, bigint, jsonb), vp_new_version(text, bigint, text),
                          vp_submit(text, bigint), vp_file_add(text, bigint, text, text, bigint, text),
                          vp_file_remove(text, bigint, text), vp_upload_key(text, bigint), vp_upload_ok(text) to anon, authenticated;


-- =====================================================================
-- 6. STORAGE — bucket riêng "pm-tender", chính sách chỉ áp cho bucket này
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pm-tender', 'pm-tender', false, 20971520,
        array['application/pdf', 'image/png', 'image/jpeg',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
              'application/zip', 'application/x-zip-compressed'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pm_tender_upload on storage.objects;
create policy pm_tender_upload on storage.objects for insert to anon
  with check (bucket_id = 'pm-tender' and vp_upload_ok(name));
drop policy if exists pm_tender_read on storage.objects;
create policy pm_tender_read on storage.objects for select to authenticated
  using (bucket_id = 'pm-tender' and pm_tender_file_ok(name));

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 7. KIỂM CHỨNG
-- =====================================================================

select 'Bảng đấu thầu' as "Mục", count(*)::text as "Thực tế", '6' as "Mong đợi",
       case when count(*) = 6 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.tables
where  table_schema = 'public' and table_name in ('pm_tender', 'pm_tender_invitee', 'pm_tender_invite', 'pm_tender_bid', 'pm_tender_consent', 'pm_tender_event')
union all
select 'Khách (anon) đọc / ghi thẳng bảng đấu thầu (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee = 'anon' and table_name like 'pm\_tender%'
union all
-- Hồ sơ niêm phong: RLS bật và không có chính sách nào → không ai đọc thẳng được, kể cả khi bảng được cấp quyền.
select 'Chính sách đọc thẳng bảng đấu thầu (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'public' and tablename like 'pm\_tender%'
union all
select 'RLS bật trên bảng đấu thầu', count(*)::text, '6',
       case when count(*) = 6 then '✔' else '✘ HỎNG' end
from   pg_class c join pg_namespace s on s.oid = c.relnamespace
where  s.nspname = 'public' and c.relname like 'pm\_tender%' and c.relkind = 'r' and c.relrowsecurity
union all
select 'Khách gọi được hàm nội bộ / hàm pm_ (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where (proname like 'pm\_tender%' or proname in ('vp_invitee', 'vp_tender_for')) and has_function_privilege('anon', oid, 'execute')
union all
select 'Hàm vp_ công khai cho nhà thầu', count(*)::text, '8',
       case when count(*) = 8 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('vp_session', 'vp_save', 'vp_new_version', 'vp_submit', 'vp_file_add', 'vp_file_remove', 'vp_upload_key', 'vp_upload_ok')
  and  has_function_privilege('anon', oid, 'execute')
union all
select 'Bucket pm-tender (riêng tư)', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   storage.buckets where id = 'pm-tender' and not public
union all
select 'Chính sách Storage của bucket', count(*)::text, '2',
       case when count(*) = 2 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('pm_tender_upload', 'pm_tender_read');
