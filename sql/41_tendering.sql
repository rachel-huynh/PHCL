-- =====================================================================
-- 41_tendering.sql — GỌI BÁO GIÁ (TENDERING), GỬI PO, NHẬN TEM TRÊN MÁY TÍNH BẢNG (28/09/2026)
--
-- Chạy SAU 40_asset_dashboard.sql (cần 25_pm_tender, 26_alr_project, 27_liquidation,
-- 35_vendor_photo_count). Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE trên CSDL thật.
--
-- Quy trình mới (quyết định của người dùng 28/09/2026):
--
--   1. GỌI BÁO GIÁ nằm dưới Dự án (màn Tendering), không còn nằm trong QC:
--      bộ PR (+RR +PA) duyệt xong → Thu mua được báo "gọi báo giá" → Thu mua mở
--      đợt gọi báo giá TỪ DỰ ÁN (hạng mục lấy từ PR), đính kèm hồ sơ mời thầu cho
--      nhà thầu tải về, mời nhà thầu → theo dõi số báo giá đã nộp; tới hạn mà chưa
--      đủ 3 báo giá thì GIA HẠN → ba người đồng ý mở (như 25) → "Đưa vào QC": QC
--      được lập (hoặc mở lại) với toàn bộ nội dung nhà thầu đã nhập.
--   2. Cổng nhà thầu thêm: đơn vị tính + số lượng chào (cả dòng chi phí khác),
--      lịch thanh toán theo đợt (% + thời điểm: đặt cọc / giao hàng / nghiệm thu…),
--      in thư báo giá để ký đóng dấu rồi tải lên, hướng dẫn nộp hợp lệ và hướng
--      dẫn nhập liệu, YÊU CẦU KHẢO SÁT HIỆN TRƯỜNG (ngày giờ đề xuất, người đến +
--      CCCD + SĐT, email liên hệ) và HỎI ĐÁP LÀM RÕ (trả lời hiện trên cổng; email
--      soạn sẵn bằng mailto — app chưa có máy gửi thư).
--   3. PO duyệt xong → Thu mua GỬI PO cho nhà cung cấp (PO hiện trên cổng của nhà
--      thầu, nhà thầu xác nhận đã nhận) → dự án "chờ hợp đồng (CT)". Đồng thời AM
--      Coordinator được báo "sinh mã tài sản" → lập ALR (AM Coordinator → AM
--      Executive → Kế toán trưởng). ALR duyệt xong → báo Thu mua và Hotel Asset
--      Manager. Hotel AM dán tem, quét mã, chụp ảnh, nhập SỐ LƯỢNG THỰC NHẬN trên
--      điện thoại / máy tính bảng và chọn đưa vào AH đợt này hay để đợt sau → AH
--      nháp được cập nhật → Hotel AM kiểm tra trên web rồi gửi duyệt.
--   (Hợp đồng và đề nghị thanh toán: 42_payment_request.sql.)
--
-- Thay pm_notify_trg của 27_liquidation.sql (thêm báo sau PO / sau ALR): chạy lại 27
-- về sau thì phải chạy lại file này.
--
-- Chỉ đụng vào bảng / hàm có tên của app này (am_*, app_*, pm_*, vp_*); chính sách
-- Storage chỉ áp cho bucket "pm-tender". Cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. CÀI ĐẶT, CỘT MỚI
-- =====================================================================

insert into am_setting (key, value, note) values
  ('td_min_bids', '3'::jsonb,
   'Gọi báo giá: số báo giá tối thiểu trước khi mở (chưa đủ thì Thu mua được nhắc gia hạn)'),
  ('td_hotel_info', '{"company": "PLAZA HOTEL COMPANY LIMITED", "address": "17 Lê Duẩn, Phường Sài Gòn, TP.HCM", "dept": "Phòng Thu mua / Purchasing Department", "email": "", "phone": ""}'::jsonb,
   'Gọi báo giá: thông tin bên mời thầu in trên cổng nhà thầu và thư báo giá (nơi nộp bản gốc có đóng dấu)')
on conflict (key) do nothing;

alter table pm_tender add column if not exists pr_doc_id bigint references pm_doc(id) on delete set null;
alter table pm_tender add column if not exists doc_key   uuid not null default gen_random_uuid();
alter table pm_tender add column if not exists files     jsonb not null default '[]';   -- hồ sơ mời thầu cho nhà thầu tải: [{path, name, size}]
alter table pm_tender add column if not exists address   text;                          -- nơi nộp bản gốc thư báo giá
alter table pm_tender add column if not exists min_bids  int not null default 3;
comment on column pm_tender.doc_key is
  'Thư mục ngẫu nhiên của hồ sơ mời thầu trong bucket pm-tender (doc/<doc_key>/…): nhà thầu được mời tải về qua cổng.';

-- Thông báo: kind mới + tham chiếu chung (đợt gọi báo giá, đề nghị thanh toán…).
alter table pm_notice add column if not exists ref_id bigint;
alter table pm_notice drop constraint if exists pm_notice_kind_check;
alter table pm_notice add constraint pm_notice_kind_check
  check (kind in ('todo', 'approved', 'returned', 'rejected', 'cancelled', 'next', 'tender', 'info', 'pay'));


-- =====================================================================
-- 2. BẢNG MỚI (RLS bật; hỏi đáp / khảo sát / gửi PO chỉ đọc ghi qua hàm)
-- =====================================================================

-- Hỏi đáp làm rõ hồ sơ mời thầu. invitee_id null = thông báo của khách sạn gửi mọi nhà thầu.
create table if not exists pm_tender_qa (
  id            bigserial primary key,
  tender_id     bigint not null references pm_tender(id) on delete cascade,
  invitee_id    bigint references pm_tender_invitee(id) on delete cascade,
  question      text,
  asked_at      timestamptz not null default now(),
  answer        text,
  shared        boolean not null default false,      -- câu trả lời gửi mọi nhà thầu được mời (không nêu tên người hỏi)
  answered_by   uuid,
  answered_name text,
  answered_at   timestamptz
);
create index if not exists pm_tender_qa_idx on pm_tender_qa (tender_id);

-- Yêu cầu khảo sát hiện trường của nhà thầu.
create table if not exists pm_tender_survey (
  id            bigserial primary key,
  tender_id     bigint not null references pm_tender(id) on delete cascade,
  invitee_id    bigint not null references pm_tender_invitee(id) on delete cascade,
  proposed      jsonb not null default '[]',          -- 1–3 thời điểm đề xuất (ISO)
  people        jsonb not null default '[]',          -- [{name, id_no, phone}] — CCCD để khách sạn đăng ký ra vào
  contact_name  text,
  contact_phone text,
  contact_email text,
  note          text,
  status        text not null default 'requested' check (status in ('requested', 'scheduled', 'done', 'cancelled')),
  scheduled_at  timestamptz,
  reply         text,
  handled_by    uuid,
  handled_name  text,
  handled_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists pm_tender_survey_idx on pm_tender_survey (tender_id);

-- PO đã gửi cho nhà cung cấp (hiện trên cổng của nhà thầu nếu gắn với link mời).
create table if not exists pm_po_send (
  id          bigserial primary key,
  doc_id      bigint not null references pm_doc(id) on delete cascade,
  project_code text,
  invitee_id  bigint references pm_tender_invitee(id) on delete set null,
  vendor_name text,
  email       text,
  note        text,
  sent_by     uuid,
  sent_name   text,
  sent_at     timestamptz not null default now(),
  ack_at      timestamptz
);
create index if not exists pm_po_send_doc_idx on pm_po_send (doc_id);

alter table pm_tender_qa     enable row level security;
alter table pm_tender_survey enable row level security;
alter table pm_po_send       enable row level security;
revoke all on pm_tender_qa, pm_tender_survey, pm_po_send from authenticated, anon;

-- Nhận hàng theo ALR trên máy tính bảng: mỗi lần nhận một dòng (tài sản CCDC theo lô
-- có thể nhận nhiều đợt). pick: 'now' = đưa vào AH đợt này, 'next' = để đợt sau.
-- ah_doc_id: AH đã lấy dòng này (AH bị huỷ / từ chối thì dòng lại được lấy lần sau).
create table if not exists am_recv (
  id          bigserial primary key,
  asset_id    bigint not null references am_asset(id) on delete cascade,
  al_doc_id   bigint references pm_doc(id) on delete set null,
  project_code text,
  qty         numeric(14, 3) not null check (qty > 0),
  pick        text not null default 'now' check (pick in ('now', 'next')),
  note        text,
  ah_doc_id   bigint references pm_doc(id) on delete set null,
  scanned_at  timestamptz,
  by_user     uuid default auth.uid(),
  by_name     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists am_recv_asset_idx on am_recv (asset_id);
create index if not exists am_recv_project_idx on am_recv (project_code);
comment on table am_recv is
  'Số lượng thực nhận theo ALR (Hotel Asset Manager, trên máy tính bảng) và AH đã lấy dòng đó. Ghi qua am_recv_set / am_recv_link.';

alter table am_recv enable row level security;
revoke all on am_recv from anon;
revoke insert, update, delete on am_recv from authenticated;
grant select on am_recv to authenticated;
drop policy if exists am_recv_read on am_recv;
create policy am_recv_read on am_recv for select to authenticated
  using ((select app_can('assets', 'view')) or (select app_can('project', 'view')));

do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    execute 'drop trigger if exists app_audit on am_recv';
    execute 'create trigger app_audit after insert or update or delete on am_recv for each row execute function app_audit_row()';
  end if;
end $$;


-- =====================================================================
-- 3. HÀM NỘI BỘ
-- =====================================================================

-- Thông báo cho người quản lý đợt gọi báo giá: người mở đợt + người lập QC của bộ phận.
create or replace function pm_tender_notify(p_tender bigint, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare t pm_tender; p pm_project;
begin
  select * into t from pm_tender where id = p_tender;
  select * into p from pm_project where code = t.project_code;
  insert into pm_notice (user_id, kind, doc_no, doc_type, project_code, comment, ref_id)
  select distinct u.id, 'tender', coalesce(t.title, p.name, t.project_code), 'TD', t.project_code, left(p_text, 300), t.id
  from   app_user u
  where  u.active and (u.id = t.created_by
          or exists (select 1 from pm_chain c where c.entity = pm_entity(p.dept_code) and c.doc_type = 'QC' and c.step = 0
                                                and app_user_role_covers(u.id, c.role_code, p.dept_code)));
end $$;

create or replace function pm_tender_actor()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email', 'sql:' || session_user)
$$;

-- Người trả lời câu hỏi làm rõ: Thu mua (quản lý đợt) hoặc BỘ PHẬN đề xuất — người lập PR của bộ phận
-- (nhân viên bộ phận) hoặc Trưởng bộ phận. AM team, Hotel AM… không trả lời thay.
create or replace function pm_tender_can_answer(p_project text)
returns boolean language sql stable security definer set search_path = public as $$
  select pm_tender_can_manage(p_project)
      or coalesce((select pm_can_prepare('PR', p.dept_code) or app_user_role_covers(auth.uid(), 'DEPT_HEAD', p.dept_code)
                   from pm_project p where p.code = p_project), false)
$$;

-- Storage: hồ sơ mời thầu (doc/<doc_key>/…). Ghi: người quản lý đợt; đọc: người xem dự án.
create or replace function pm_tender_doc_ok(p_name text, p_write boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select split_part(coalesce(p_name, ''), '/', 1) = 'doc' and exists (
    select 1 from pm_tender t
    where t.doc_key::text = split_part(p_name, '/', 2)
      and case when p_write then pm_tender_can_manage(t.project_code) else app_can('project', 'view') end)
$$;

-- Storage (khách): tải hồ sơ mời thầu của một đợt chưa huỷ. Thư mục là mã ngẫu nhiên chỉ
-- lấy được qua vp_session (đúng link mời), như thư mục tải lên của hồ sơ nhà thầu.
create or replace function vp_doc_ok(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select split_part(coalesce(p_name, ''), '/', 1) = 'doc' and exists (
    select 1 from pm_tender t
    where t.doc_key::text = split_part(p_name, '/', 2) and t.status <> 'cancelled'
      and exists (select 1 from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id
                  where i.tender_id = t.id and not v.revoked and v.expires_at >= now()))
$$;


-- =====================================================================
-- 4. MỞ ĐỢT TỪ DỰ ÁN, SỬA, HỒ SƠ MỜI THẦU, GẮN QC
-- =====================================================================

-- p = {title, scope, terms, deadline, items: [{item, qty, unit, spec}], crit: [{label, grp}], address, min_bids}
create or replace function pm_tender_create_prj(p_project text, p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare pr pm_doc; n bigint; v_dl timestamptz := nullif(p ->> 'deadline', '')::timestamptz; v_items jsonb;
begin
  if not pm_tender_can_manage(p_project) then raise exception 'Bạn không có quyền gọi báo giá cho dự án này.' using errcode = '42501'; end if;
  select * into pr from pm_doc where project_code = p_project and doc_type = 'PR' and status = 'approved' order by id desc limit 1;
  if pr.id is null and not (app_trusted() or app_can('project', 'admin')) then
    raise exception 'Bộ PR của dự án % chưa được duyệt xong — chưa gọi báo giá được.', p_project;
  end if;
  if v_dl is null or v_dl <= now() then raise exception 'Hạn nộp phải ở tương lai.'; end if;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('item', trim(i ->> 'item'), 'qty', nullif(i ->> 'qty', '')::numeric,
                                               'unit', nullif(trim(i ->> 'unit'), ''), 'spec', nullif(trim(i ->> 'spec'), '')))), '[]')
    into v_items from jsonb_array_elements(coalesce(p -> 'items', '[]')) i where coalesce(trim(i ->> 'item'), '') <> '';
  if jsonb_array_length(v_items) = 0 then raise exception 'Chưa có hạng mục nào để chào giá.'; end if;
  insert into pm_tender (project_code, pr_doc_id, title, scope, terms, items, crit, deadline, address, min_bids, created_by)
  values (p_project, pr.id, nullif(trim(p ->> 'title'), ''), p ->> 'scope', p ->> 'terms', v_items,
          coalesce(p -> 'crit', '[]'), v_dl, nullif(trim(p ->> 'address'), ''),
          greatest(1, coalesce(nullif(p ->> 'min_bids', '')::int, (select value::text::int from am_setting where key = 'td_min_bids'), 3)), auth.uid())
  returning id into n;
  -- QC đã có (lập trước khi có màn Tendering): gắn luôn.
  update pm_tender set qc_doc_id = (select id from pm_doc where project_code = p_project and doc_type = 'QC' and status not in ('cancelled', 'rejected') order by id desc limit 1)
   where id = n;
  perform pm_tender_log(n, pm_tender_actor(), 'create', to_char(v_dl, 'YYYY-MM-DD HH24:MI'));
  return n;
end $$;

-- Sửa đợt. Hạng mục / tiêu chí chỉ đổi được khi chưa nhà thầu nào nộp ở vòng hiện tại.
create or replace function pm_tender_set(p_id bigint, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_id for update;
  if t.id is null then raise exception 'Không có đợt gọi báo giá %.', p_id; end if;
  if not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền sửa đợt này.' using errcode = '42501'; end if;
  if t.status = 'cancelled' then raise exception 'Đợt đã huỷ.'; end if;
  if (p ? 'items' or p ? 'crit') and exists (select 1 from pm_tender_bid b where b.tender_id = t.id and b.round = t.round and b.status = 'submitted') then
    raise exception 'Đã có nhà thầu nộp báo giá — không đổi hạng mục / tiêu chí được nữa. Muốn đổi: mở vòng mới.';
  end if;
  update pm_tender set
    title    = case when p ? 'title' then nullif(trim(p ->> 'title'), '') else title end,
    scope    = case when p ? 'scope' then p ->> 'scope' else scope end,
    terms    = case when p ? 'terms' then p ->> 'terms' else terms end,
    address  = case when p ? 'address' then nullif(trim(p ->> 'address'), '') else address end,
    min_bids = case when p ? 'min_bids' then greatest(1, coalesce(nullif(p ->> 'min_bids', '')::int, min_bids)) else min_bids end,
    items    = case when p ? 'items' then coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('item', trim(i ->> 'item'),
                         'qty', nullif(i ->> 'qty', '')::numeric, 'unit', nullif(trim(i ->> 'unit'), ''), 'spec', nullif(trim(i ->> 'spec'), ''))))
                         from jsonb_array_elements(p -> 'items') i where coalesce(trim(i ->> 'item'), '') <> ''), items) else items end,
    crit     = case when p ? 'crit' then coalesce(p -> 'crit', crit) else crit end,
    updated_at = now()
  where id = p_id;
  perform pm_tender_log(p_id, pm_tender_actor(), 'edit', null);
end $$;

create or replace function pm_tender_file_add(p_id bigint, p_path text, p_name text, p_size bigint)
returns void language plpgsql security definer set search_path = public as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_id for update;
  if t.id is null then raise exception 'Không có đợt gọi báo giá %.', p_id; end if;
  if not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền với đợt này.' using errcode = '42501'; end if;
  if p_path is null or p_path not like 'doc/' || t.doc_key::text || '/%' or length(p_path) > 300 then raise exception 'Đường dẫn tệp không hợp lệ.'; end if;
  if jsonb_array_length(t.files) >= 20 then raise exception 'Tối đa 20 tệp.'; end if;
  update pm_tender set files = files || jsonb_build_array(jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, ''), 200), 'size', p_size, 'at', now())),
                       updated_at = now()
   where id = p_id;
  perform pm_tender_log(p_id, pm_tender_actor(), 'file', left(coalesce(p_name, ''), 200));
end $$;

create or replace function pm_tender_file_del(p_id bigint, p_path text)
returns void language plpgsql security definer set search_path = public as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_id for update;
  if t.id is null or not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền với đợt này.' using errcode = '42501'; end if;
  update pm_tender set files = coalesce((select jsonb_agg(f) from jsonb_array_elements(files) f where f ->> 'path' <> p_path), '[]'), updated_at = now()
   where id = p_id;
end $$;

-- QC lập từ màn Tendering ("Đưa vào QC"): gắn đợt với QC.
create or replace function pm_tender_link_qc(p_tender bigint, p_qc bigint)
returns void language plpgsql security definer set search_path = public as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_tender for update;
  if t.id is null or not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền với đợt này.' using errcode = '42501'; end if;
  if not exists (select 1 from pm_doc where id = p_qc and doc_type = 'QC' and project_code = t.project_code) then
    raise exception 'QC % không thuộc dự án %.', p_qc, t.project_code;
  end if;
  update pm_tender set qc_doc_id = p_qc, updated_at = now() where id = p_tender;
end $$;


-- =====================================================================
-- 5. HỎI ĐÁP, KHẢO SÁT HIỆN TRƯỜNG (phía khách sạn)
-- =====================================================================

-- Trả lời một câu hỏi; p_shared = gửi câu trả lời cho mọi nhà thầu (không nêu tên người hỏi).
-- Trả về người nhận để app soạn email (mailto).
create or replace function pm_tender_answer(p_qa bigint, p_answer text, p_shared boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q pm_tender_qa; t pm_tender;
begin
  select * into q from pm_tender_qa where id = p_qa for update;
  if q.id is null then raise exception 'Không có câu hỏi %.', p_qa; end if;
  select * into t from pm_tender where id = q.tender_id;
  if not pm_tender_can_answer(t.project_code) then raise exception 'Bạn không có quyền trả lời.' using errcode = '42501'; end if;
  if coalesce(trim(p_answer), '') = '' then raise exception 'Nhập câu trả lời.'; end if;
  update pm_tender_qa set answer = trim(p_answer), shared = coalesce(p_shared, false), answered_by = auth.uid(),
                          answered_name = pm_tender_actor(), answered_at = now()
   where id = q.id;
  perform pm_tender_log(t.id, pm_tender_actor(), 'answer', case when p_shared then 'shared' end);
  return jsonb_build_object('to', (select jsonb_agg(distinct v.email) from pm_tender_invitee v
                                    join pm_tender_invite i on i.invitee_id = v.id and i.tender_id = t.id
                                   where v.email is not null and (p_shared or v.id = q.invitee_id) and not v.revoked),
                            'question', q.question, 'answer', trim(p_answer), 'title', coalesce(t.title, t.project_code));
end $$;

-- Thông báo làm rõ / bổ sung hồ sơ của khách sạn gửi mọi nhà thầu được mời.
create or replace function pm_tender_announce(p_tender bigint, p_text text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_tender;
  if t.id is null or not pm_tender_can_answer(t.project_code) then raise exception 'Bạn không có quyền với đợt này.' using errcode = '42501'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception 'Nhập nội dung thông báo.'; end if;
  insert into pm_tender_qa (tender_id, invitee_id, question, answer, shared, answered_by, answered_name, answered_at)
  values (t.id, null, null, trim(p_text), true, auth.uid(), pm_tender_actor(), now());
  perform pm_tender_log(t.id, pm_tender_actor(), 'announce', left(trim(p_text), 120));
  return jsonb_build_object('to', (select jsonb_agg(distinct v.email) from pm_tender_invitee v
                                    join pm_tender_invite i on i.invitee_id = v.id and i.tender_id = t.id
                                   where v.email is not null and not v.revoked),
                            'answer', trim(p_text), 'title', coalesce(t.title, t.project_code));
end $$;

-- Xếp lịch / trả lời yêu cầu khảo sát. Trả về email người liên hệ để soạn thư.
create or replace function pm_tender_survey_set(p_id bigint, p_status text, p_at timestamptz, p_reply text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s pm_tender_survey; t pm_tender;
begin
  select * into s from pm_tender_survey where id = p_id for update;
  if s.id is null then raise exception 'Không có yêu cầu khảo sát %.', p_id; end if;
  select * into t from pm_tender where id = s.tender_id;
  if not pm_tender_can_answer(t.project_code) then raise exception 'Bạn không có quyền với yêu cầu này.' using errcode = '42501'; end if;
  if p_status not in ('requested', 'scheduled', 'done', 'cancelled') then raise exception 'Trạng thái không hợp lệ.'; end if;
  if p_status = 'scheduled' and p_at is null then raise exception 'Chọn ngày giờ khảo sát.'; end if;
  update pm_tender_survey set status = p_status, scheduled_at = coalesce(p_at, scheduled_at), reply = nullif(trim(p_reply), ''),
                              handled_by = auth.uid(), handled_name = pm_tender_actor(), handled_at = now()
   where id = s.id;
  perform pm_tender_log(t.id, pm_tender_actor(), 'survey', p_status || coalesce(' ' || to_char(p_at, 'YYYY-MM-DD HH24:MI'), ''));
  return jsonb_build_object('to', coalesce(s.contact_email, (select email from pm_tender_invitee where id = s.invitee_id)),
                            'vendor', (select vendor_name from pm_tender_invitee where id = s.invitee_id),
                            'title', coalesce(t.title, t.project_code));
end $$;


-- =====================================================================
-- 6. DANH SÁCH CHO MÀN TENDERING
-- =====================================================================

-- Mọi đợt của một dự án (thay 25): thêm hồ sơ mời thầu, hỏi đáp, khảo sát, PO đã gửi.
-- Nội dung hồ sơ nhà thầu chưa mở vẫn KHÔNG có ở đây.
create or replace function pm_tender_list(p_project text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_mng boolean := pm_tender_can_manage(p_project);
begin
  if not (app_trusted() or app_can('project', 'view')) then raise exception 'Bạn không có quyền xem dự án.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'qc_doc_id', t.qc_doc_id, 'pr_doc_id', t.pr_doc_id, 'title', t.title, 'scope', t.scope, 'terms', t.terms,
    'items', t.items, 'crit', t.crit, 'deadline', t.deadline, 'status', t.status, 'round', t.round, 'open_seq', t.open_seq,
    'created_at', t.created_at, 'doc_key', t.doc_key, 'files', t.files, 'address', t.address, 'min_bids', t.min_bids,
    'can_manage', v_mng, 'can_answer', pm_tender_can_answer(t.project_code),
    'open_roles', to_jsonb(pm_tender_open_roles(t.project_code)),
    'consents', (select coalesce(jsonb_agg(jsonb_build_object('role', c.role_code, 'user', c.user_name, 'at', c.at)), '[]')
                 from pm_tender_consent c where c.tender_id = t.id and c.seq = t.open_seq),
    'invitees', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', v.id, 'vendor_code', v.vendor_code, 'name', v.vendor_name, 'email', v.email, 'expires_at', v.expires_at,
                   'revoked', v.revoked, 'last_seen_at', v.last_seen_at,
                   'bids', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'round', b.round, 'version', b.version, 'status', b.status,
                              'submitted_at', b.submitted_at, 'opened_at', b.opened_at, 'note', case when b.opened_at is not null then b.note end,
                              'data', case when b.opened_at is not null then b.data end,
                              'files', case when b.opened_at is not null then b.files end) order by b.round, b.version), '[]')
                            from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id)) order by v.id), '[]')
                 from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id where i.tender_id = t.id),
    'qa', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'vendor', v.vendor_name, 'email', v.email, 'question', q.question,
                   'asked_at', q.asked_at, 'answer', q.answer, 'shared', q.shared, 'answered_name', q.answered_name, 'answered_at', q.answered_at)
                   order by q.asked_at), '[]')
           from pm_tender_qa q left join pm_tender_invitee v on v.id = q.invitee_id where q.tender_id = t.id),
    -- CCCD / SĐT người đến khảo sát: chỉ người quản lý đợt / người trả lời thấy.
    'surveys', case when pm_tender_can_answer(t.project_code) then (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'vendor', v.vendor_name,
                   'proposed', s.proposed, 'people', s.people, 'contact_name', s.contact_name, 'contact_phone', s.contact_phone,
                   'contact_email', coalesce(s.contact_email, v.email), 'note', s.note, 'status', s.status, 'scheduled_at', s.scheduled_at,
                   'reply', s.reply, 'handled_name', s.handled_name, 'created_at', s.created_at) order by s.created_at), '[]')
                 from pm_tender_survey s join pm_tender_invitee v on v.id = s.invitee_id where s.tender_id = t.id) else '[]'::jsonb end,
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor', e.actor, 'action', e.action, 'detail', e.detail) order by e.at), '[]')
               from pm_tender_event e where e.tender_id = t.id)
  ) order by t.id), '[]') into r
  from pm_tender t where t.project_code = p_project;
  return r;
end $$;

-- Màn Tendering: các dự án đã duyệt bộ PR mà QC chưa duyệt xong (cần gọi báo giá / đang gọi),
-- và các dự án có đợt gọi báo giá mà QC mới duyệt trong 90 ngày (đã xong). Theo phạm vi người xem.
create or replace function pm_tender_board()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb; v_min int := coalesce((select value::text::int from am_setting where key = 'td_min_bids'), 3);
begin
  if not (app_trusted() or app_can('project', 'view')) then raise exception 'Bạn không có quyền xem dự án.' using errcode = '42501'; end if;
  with pr as (
    select distinct on (d.project_code) d.project_code, d.id, d.doc_no, d.decided_at
    from pm_doc d where d.doc_type = 'PR' and d.status = 'approved' order by d.project_code, d.id desc),
  qc as (
    select distinct on (d.project_code) d.project_code, d.id, d.doc_no, d.status, d.decided_at
    from pm_doc d where d.doc_type = 'QC' and d.status not in ('cancelled', 'rejected') order by d.project_code, d.id desc),
  pp as (
    select p.*, pr.id pr_id, pr.doc_no pr_no, pr.decided_at pr_at, qc.id qc_id, qc.doc_no qc_no, qc.status qc_status, qc.decided_at qc_at
    from pm_project p join pr on pr.project_code = p.code left join qc on qc.project_code = p.code
    where not coalesce(p.wf_offline, false) and p.status not in ('cancelled')
      and (app_trusted() or app_scope_root() or p.dept_code in (select app_scope_orgs()))
      and (coalesce(qc.status, '') <> 'approved'
           or (qc.decided_at >= now() - interval '90 days' and exists (select 1 from pm_tender t where t.project_code = p.code))))
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', pp.code, 'name', pp.name, 'dept_code', pp.dept_code, 'year', pp.year, 'estimated_value', pp.estimated_value,
    'pr', jsonb_build_object('id', pp.pr_id, 'doc_no', pp.pr_no, 'at', pp.pr_at),
    'qc', case when pp.qc_id is not null then jsonb_build_object('id', pp.qc_id, 'doc_no', pp.qc_no, 'status', pp.qc_status) end,
    'can_manage', pm_tender_can_manage(pp.code),
    'tenders', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'title', t.title, 'deadline', t.deadline, 'status', t.status, 'round', t.round, 'min_bids', t.min_bids,
        'invited', (select count(*) from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id where i.tender_id = t.id and not v.revoked),
        'started', (select count(distinct b.invitee_id) from pm_tender_bid b where b.tender_id = t.id and b.round = t.round),
        'submitted', (select count(distinct b.invitee_id) from pm_tender_bid b where b.tender_id = t.id and b.round = t.round and b.status = 'submitted'),
        'sealed', (select count(*) from pm_tender_bid b where b.tender_id = t.id and b.submitted_at is not null and b.opened_at is null and b.status <> 'draft'),
        'opened', (select count(distinct b.invitee_id) from pm_tender_bid b where b.tender_id = t.id and b.opened_at is not null),
        'consents', (select count(*) from pm_tender_consent c where c.tender_id = t.id and c.seq = t.open_seq),
        'roles', coalesce(array_length(pm_tender_open_roles(t.project_code), 1), 3),
        'q_open', (select count(*) from pm_tender_qa q where q.tender_id = t.id and q.answer is null),
        's_open', (select count(*) from pm_tender_survey s where s.tender_id = t.id and s.status = 'requested'),
        'files', jsonb_array_length(t.files)) order by t.id), '[]')
      from pm_tender t where t.project_code = pp.code and t.status <> 'cancelled')
  ) order by pp.pr_at desc nulls last), '[]') into r
  from pp;
  return jsonb_build_object('min_bids', v_min, 'rows', r);
end $$;


-- =====================================================================
-- 7. CỔNG NHÀ THẦU (anon, qua link) — thay vp_session / vp_submit của 25, thêm hỏi đáp,
--    khảo sát, xác nhận PO
-- =====================================================================

create or replace function vp_session(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v pm_tender_invitee; r jsonb;
begin
  v := vp_invitee(p_token);
  select jsonb_build_object(
    'vendor', v.vendor_name, 'email', v.email, 'expires_at', v.expires_at,
    'hotel', coalesce((select value from am_setting where key = 'td_hotel_info'), '{}'::jsonb),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('code', u.code, 'vi', u.name_vi, 'en', u.name_en) order by u.sort_order, u.code), '[]') from am_unit u),
    'tenders', coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'project_code', t.project_code, 'project_name', p.name,
      'scope', t.scope, 'terms', t.terms, 'items', t.items, 'crit', t.crit, 'address', t.address, 'min_bids', t.min_bids,
      'deadline', t.deadline, 'status', t.status, 'round', t.round, 'doc_key', t.doc_key, 'files', t.files,
      'accepting', t.status = 'open' and t.deadline >= now(),
      'bids', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', b.id, 'round', b.round, 'version', b.version, 'status', b.status,
                  'data', b.data, 'files', b.files, 'note', b.note, 'submitted_at', b.submitted_at)
                  order by b.round, b.version), '[]')
               from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id),
      -- Câu hỏi của chính mình + câu trả lời / thông báo gửi mọi nhà thầu (không nêu tên người hỏi).
      'qa', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'mine', q.invitee_id = v.id, 'question', q.question, 'asked_at', q.asked_at,
                     'answer', q.answer, 'answered_at', q.answered_at) order by q.asked_at), '[]')
             from pm_tender_qa q where q.tender_id = t.id and (q.invitee_id = v.id or (q.shared and q.answer is not null))),
      'surveys', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'proposed', s.proposed, 'people', s.people, 'contact_name', s.contact_name,
                     'contact_phone', s.contact_phone, 'contact_email', s.contact_email, 'note', s.note, 'status', s.status,
                     'scheduled_at', s.scheduled_at, 'reply', s.reply, 'created_at', s.created_at) order by s.created_at), '[]')
                  from pm_tender_survey s where s.tender_id = t.id and s.invitee_id = v.id)
    ) order by t.deadline), '[]'),
    -- Đơn đặt hàng khách sạn đã gửi cho nhà thầu này.
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'doc_no', d.doc_no, 'project_code', d.project_code,
                   'project_name', (select name from pm_project where code = d.project_code),
                   'sent_at', s.sent_at, 'ack_at', s.ack_at, 'note', s.note, 'total', d.total_value,
                   'data', d.data - 'hide_cols' - 'evidence') order by s.sent_at desc), '[]')
               from pm_po_send s join pm_doc d on d.id = s.doc_id where s.invitee_id = v.id and d.status = 'approved'))
  into r
  -- Hàm gộp không GROUP BY luôn trả một dòng, kể cả khi nhà thầu không còn gói nào.
  from pm_tender_invite i join pm_tender t on t.id = i.tender_id join pm_project p on p.code = t.project_code
  where i.invitee_id = v.id and t.status <> 'cancelled';
  return r;
end $$;

-- Nộp (thay 25): thêm kiểm tra lịch thanh toán (nếu có thì cộng đủ 100%) và số lượng chào.
create or replace function vp_submit(p_token text, p_tender bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid; n int; i int; v_sum numeric;
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
    if nullif(b.data -> 'qtys' ->> i::text, '') is not null and (b.data -> 'qtys' ->> i::text)::numeric <= 0 then
      raise exception 'Số lượng hạng mục % phải lớn hơn 0. / Quantity of item % must be above 0.', i + 1, i + 1;
    end if;
  end loop;
  if jsonb_typeof(b.data -> 'pay_sched') = 'array' and jsonb_array_length(b.data -> 'pay_sched') > 0 then
    select coalesce(sum(nullif(x ->> 'pct', '')::numeric), 0) into v_sum from jsonb_array_elements(b.data -> 'pay_sched') x;
    if abs(v_sum - 100) > 0.01 then
      raise exception 'Các đợt thanh toán phải cộng đủ 100%% (hiện là % / 100). / Payment instalments must add up to 100%% (now % / 100).', v_sum, v_sum;
    end if;
  end if;
  if not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'quotation') then
    raise exception 'Tải lên thư báo giá có ký tên, đóng dấu trước khi nộp. / Upload the signed and stamped quotation letter before submitting.';
  end if;
  update pm_tender_bid set status = 'submitted', submitted_at = now(), updated_at = now() where id = b.id;
  update pm_tender_bid set status = 'superseded', updated_at = now()
   where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'submitted' and id <> b.id;
  perform pm_tender_log(t.id, v.vendor_name, 'submit', 'v' || b.version);
  perform pm_tender_notify(t.id, v.vendor_name || ': đã nộp báo giá (v' || b.version || ') / bid submitted');
end $$;

-- Câu hỏi làm rõ (trước hạn nộp, đợt còn mở).
create or replace function vp_ask(p_token text, p_tender bigint, p_question text)
returns void language plpgsql security definer set search_path = public as $$
declare v pm_tender_invitee; t pm_tender;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  if coalesce(trim(p_question), '') = '' then raise exception 'Nhập câu hỏi. / Type your question.'; end if;
  if length(p_question) > 4000 then raise exception 'Câu hỏi quá dài (tối đa 4.000 ký tự). / Question too long (4,000 characters at most).'; end if;
  if (select count(*) from pm_tender_qa where tender_id = t.id and invitee_id = v.id) >= 30 then
    raise exception 'Tối đa 30 câu hỏi cho một gói. / 30 questions at most per tender.';
  end if;
  insert into pm_tender_qa (tender_id, invitee_id, question) values (t.id, v.id, trim(p_question));
  perform pm_tender_log(t.id, v.vendor_name, 'question', left(trim(p_question), 120));
  perform pm_tender_notify(t.id, v.vendor_name || ' hỏi / asks: ' || left(trim(p_question), 200));
end $$;

-- Yêu cầu khảo sát hiện trường: p = {proposed: [iso…], people: [{name, id_no, phone}], contact_name, contact_phone, contact_email, note}
create or replace function vp_survey(p_token text, p_tender bigint, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v pm_tender_invitee; t pm_tender; v_prop jsonb; v_people jsonb;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select coalesce(jsonb_agg(to_jsonb(x::timestamptz)), '[]') into v_prop
    from jsonb_array_elements_text(case when jsonb_typeof(p -> 'proposed') = 'array' then p -> 'proposed' else '[]' end) x where x <> '';
  if jsonb_array_length(v_prop) = 0 or jsonb_array_length(v_prop) > 3 then
    raise exception 'Đề xuất từ 1 đến 3 thời điểm khảo sát. / Propose 1 to 3 times for the visit.';
  end if;
  if exists (select 1 from jsonb_array_elements_text(v_prop) x where x::timestamptz < now()) then
    raise exception 'Thời điểm đề xuất phải ở tương lai. / Proposed times must be in the future.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', left(trim(x ->> 'name'), 120), 'id_no', left(trim(coalesce(x ->> 'id_no', '')), 20),
                                               'phone', left(trim(coalesce(x ->> 'phone', '')), 30))), '[]')
    into v_people from jsonb_array_elements(case when jsonb_typeof(p -> 'people') = 'array' then p -> 'people' else '[]' end) x
   where coalesce(trim(x ->> 'name'), '') <> '';
  if jsonb_array_length(v_people) = 0 then raise exception 'Nhập ít nhất một người đến khảo sát. / List at least one visitor.'; end if;
  if jsonb_array_length(v_people) > 10 then raise exception 'Tối đa 10 người. / 10 visitors at most.'; end if;
  if exists (select 1 from jsonb_array_elements(v_people) x where x ->> 'id_no' = '' or x ->> 'phone' = '') then
    raise exception 'Mỗi người đến cần số CCCD và số điện thoại. / Each visitor needs an ID number and a phone number.';
  end if;
  if coalesce(trim(p ->> 'contact_email'), '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Nhập email liên hệ hợp lệ. / Give a valid contact e-mail.';
  end if;
  if (select count(*) from pm_tender_survey where tender_id = t.id and invitee_id = v.id and status = 'requested') >= 3 then
    raise exception 'Đã có yêu cầu đang chờ xếp lịch. / A request is already waiting to be scheduled.';
  end if;
  insert into pm_tender_survey (tender_id, invitee_id, proposed, people, contact_name, contact_phone, contact_email, note)
  values (t.id, v.id, v_prop, v_people, left(trim(coalesce(p ->> 'contact_name', '')), 120), left(trim(coalesce(p ->> 'contact_phone', '')), 30),
          lower(trim(p ->> 'contact_email')), left(coalesce(p ->> 'note', ''), 2000));
  perform pm_tender_log(t.id, v.vendor_name, 'survey_req', jsonb_array_length(v_people) || ' người');
  perform pm_tender_notify(t.id, v.vendor_name || ': xin khảo sát hiện trường / requests a site visit');
end $$;

-- Nhà thầu xác nhận đã nhận PO.
create or replace function vp_po_ack(p_token text, p_send bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v pm_tender_invitee; s pm_po_send;
begin
  v := vp_invitee(p_token);
  select * into s from pm_po_send where id = p_send and invitee_id = v.id;
  if s.id is null then raise exception 'Không có đơn hàng này. / No such order.'; end if;
  update pm_po_send set ack_at = coalesce(ack_at, now()) where id = s.id;
  insert into pm_notice (user_id, kind, doc_id, doc_no, doc_type, project_code, comment)
  select s.sent_by, 'info', s.doc_id, (select doc_no from pm_doc where id = s.doc_id), 'PO', s.project_code, 'po_ack: ' || v.vendor_name
  where  exists (select 1 from app_user where id = s.sent_by);
end $$;


-- =====================================================================
-- 8. GỬI PO CHO NHÀ CUNG CẤP
-- =====================================================================

-- PO đã duyệt → gửi: nếu nhà cung cấp là nhà thầu đã chào qua cổng (p_invitee), PO hiện trên cổng
-- của họ (link được gia hạn ít nhất 60 ngày). Email do app soạn sẵn (mailto) kèm PDF người gửi đính.
create or replace function pm_po_send_do(p_doc bigint, p_invitee bigint, p_email text, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare d pm_doc; p pm_project; n bigint; v pm_tender_invitee;
begin
  select * into d from pm_doc where id = p_doc and doc_type = 'PO';
  if d.id is null then raise exception 'Không có PO %.', p_doc; end if;
  if d.status <> 'approved' then raise exception 'PO % chưa được duyệt xong.', d.doc_no; end if;
  select * into p from pm_project where code = d.project_code;
  if not (app_trusted() or app_can('project', 'admin') or pm_can_prepare('PO', p.dept_code)) then
    raise exception 'Chỉ người lập PO (Thu mua) gửi được PO.' using errcode = '42501';
  end if;
  if p_invitee is not null then
    select * into v from pm_tender_invitee where id = p_invitee;
    if v.id is null or not exists (select 1 from pm_tender_invite i join pm_tender t on t.id = i.tender_id
                                    where i.invitee_id = v.id and t.project_code = d.project_code) then
      raise exception 'Link mời không thuộc dự án này.';
    end if;
    update pm_tender_invitee set expires_at = greatest(expires_at, now() + interval '60 days'), revoked = false where id = v.id;
  end if;
  insert into pm_po_send (doc_id, project_code, invitee_id, vendor_name, email, note, sent_by, sent_name)
  values (d.id, d.project_code, v.id, coalesce(v.vendor_name, nullif(d.data ->> 'supplier', '')), nullif(trim(coalesce(p_email, v.email)), ''),
          nullif(trim(p_note), ''), auth.uid(), pm_tender_actor())
  returning id into n;
  perform pm_doc_log(d.id, 'po_sent', d.status, d.status, null, coalesce(v.vendor_name, d.data ->> 'supplier'));
  return n;
end $$;

create or replace function pm_po_sends(p_project text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (app_trusted() or app_can('project', 'view')) then raise exception 'Bạn không có quyền xem dự án.' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'doc_id', s.doc_id, 'vendor', s.vendor_name, 'email', s.email, 'note', s.note,
                   'sent_name', s.sent_name, 'sent_at', s.sent_at, 'ack_at', s.ack_at, 'portal', s.invitee_id is not null) order by s.sent_at), '[]')
          from pm_po_send s where s.project_code = p_project);
end $$;


-- =====================================================================
-- 9. NHẬN TEM, SỐ LƯỢNG THỰC NHẬN (máy tính bảng) → AH NHÁP
-- =====================================================================

-- Người nhận: người lập AH của bộ phận (Hotel Asset Manager) hoặc người sửa được tài sản.
create or replace function am_recv_can(p_project text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or app_can('assets', 'edit')
      or coalesce((select pm_can_prepare('AH', p.dept_code) from pm_project p where p.code = p_project), false)
$$;

-- Ghi / sửa dòng nhận ĐANG CHỜ (chưa vào AH còn hiệu lực) của một tài sản. p_qty null hoặc 0 = xoá dòng chờ.
create or replace function am_recv_set(p_asset bigint, p_qty numeric, p_pick text, p_note text, p_scanned boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a am_asset; v_al bigint; v_prj text; v_done numeric; v_row am_recv;
begin
  select * into a from am_asset where id = p_asset;
  if a.id is null then raise exception 'Không có tài sản %.', p_asset; end if;
  -- ALR đã duyệt chứa tài sản này.
  select d.id, d.project_code into v_al, v_prj from pm_doc d
   where d.doc_type = 'AL' and d.status = 'approved' and d.data -> 'asset_ids' @> to_jsonb(a.id)
   order by d.id desc limit 1;
  if v_al is null then raise exception 'Tài sản % chưa nằm trong ALR nào đã duyệt.', a.asset_code; end if;
  if not am_recv_can(v_prj) then raise exception 'Bạn không phải người nhận tài sản của dự án này.' using errcode = '42501'; end if;
  if p_pick is not null and p_pick not in ('now', 'next') then raise exception 'Lựa chọn không hợp lệ.'; end if;
  -- Đã nhận ở các AH còn hiệu lực.
  select coalesce(sum(r.qty), 0) into v_done from am_recv r join pm_doc h on h.id = r.ah_doc_id
   where r.asset_id = a.id and h.status not in ('cancelled', 'rejected', 'draft', 'returned');
  select r.* into v_row from am_recv r left join pm_doc h on h.id = r.ah_doc_id
   where r.asset_id = a.id and (r.ah_doc_id is null or h.status in ('cancelled', 'rejected', 'draft', 'returned'))
   order by r.id desc limit 1;
  if coalesce(p_qty, 0) <= 0 then
    delete from am_recv where id = v_row.id;
    return jsonb_build_object('asset_id', a.id, 'qty', 0, 'done', v_done, 'ordered', coalesce(a.qty, 1));
  end if;
  if a.asset_kind = 'unique' and p_qty <> 1 then raise exception 'Tài sản mã vạch riêng nhận đúng 1.'; end if;
  if v_done + p_qty > coalesce(a.qty, 1) then
    raise exception 'Nhận % + % vượt số lượng đặt % của %.', v_done, p_qty, coalesce(a.qty, 1), a.asset_code;
  end if;
  if v_row.id is null then
    insert into am_recv (asset_id, al_doc_id, project_code, qty, pick, note, scanned_at, by_name)
    values (a.id, v_al, v_prj, p_qty, coalesce(p_pick, 'now'), nullif(trim(p_note), ''), case when p_scanned then now() end, pm_tender_actor())
    returning * into v_row;
  else
    update am_recv set qty = p_qty, pick = coalesce(p_pick, pick), note = coalesce(nullif(trim(p_note), ''), note), ah_doc_id = case when p_pick = 'next' then null
                                                                                                            when (select status from pm_doc where id = v_row.ah_doc_id) in ('draft', 'returned') then ah_doc_id end,
                       scanned_at = case when p_scanned then now() else scanned_at end, by_user = auth.uid(), by_name = pm_tender_actor(), updated_at = now()
     where id = v_row.id returning * into v_row;
  end if;
  return jsonb_build_object('asset_id', a.id, 'id', v_row.id, 'qty', v_row.qty, 'pick', v_row.pick, 'done', v_done, 'ordered', coalesce(a.qty, 1));
end $$;

-- Chọn đợt cho nhiều dòng một lúc ("đưa tất cả vào AH đợt này" / "để đợt sau").
create or replace function am_recv_pick(p_ids bigint[], p_pick text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_pick not in ('now', 'next') then raise exception 'Lựa chọn không hợp lệ.'; end if;
  if exists (select 1 from am_recv r where r.id = any(p_ids) and not am_recv_can(r.project_code)) then
    raise exception 'Bạn không phải người nhận tài sản của dự án này.' using errcode = '42501';
  end if;
  -- "Để đợt sau" gỡ dòng khỏi AH nháp đang lấy nó; AH đã gửi duyệt thì không đổi.
  update am_recv set pick = p_pick, updated_at = now(), ah_doc_id = case when p_pick = 'next' then null else ah_doc_id end
   where id = any(p_ids)
     and (ah_doc_id is null or ah_doc_id in (select id from pm_doc where status in ('draft', 'returned', 'cancelled', 'rejected')));
  get diagnostics n = row_count;
  return n;
end $$;

-- AH nháp đã lấy các dòng nhận này (app lập / cập nhật AH rồi gọi hàm này).
create or replace function am_recv_link(p_ah bigint, p_ids bigint[])
returns int language plpgsql security definer set search_path = public as $$
declare h pm_doc; n int;
begin
  select * into h from pm_doc where id = p_ah and doc_type = 'AH';
  if h.id is null then raise exception 'Không có AH %.', p_ah; end if;
  if h.status not in ('draft', 'returned') then raise exception 'AH % đã gửi duyệt — không thêm dòng nhận được.', h.doc_no; end if;
  if not am_recv_can(h.project_code) then raise exception 'Bạn không phải người lập AH của dự án này.' using errcode = '42501'; end if;
  -- Các dòng AH này từng lấy mà nay không còn trong danh sách: về lại hàng chờ.
  update am_recv set ah_doc_id = null, updated_at = now() where ah_doc_id = h.id and not (id = any(p_ids));
  update am_recv set ah_doc_id = h.id, pick = 'now', updated_at = now()
   where id = any(p_ids) and project_code = h.project_code
     and (ah_doc_id is null or ah_doc_id = h.id or ah_doc_id in (select id from pm_doc where status in ('cancelled', 'rejected')));
  get diagnostics n = row_count;
  return n;
end $$;

-- AH cuối cùng duyệt xong: CCDC theo lô nhận thiếu → số lượng trên sổ = tổng thực nhận.
create or replace function am_recv_on_ah()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.doc_type <> 'AH' or new.status <> 'approved' or old.status = 'approved'
     or not coalesce((new.data ->> 'final')::boolean, false) then return new; end if;
  update am_asset a set qty = x.got
    from (select r.asset_id, sum(r.qty) got from am_recv r join pm_doc h on h.id = r.ah_doc_id
          where r.project_code = new.project_code and h.status = 'approved' group by r.asset_id) x
   where a.id = x.asset_id and a.asset_kind = 'low' and x.got > 0 and x.got < coalesce(a.qty, 1);
  return new;
end $$;
drop trigger if exists am_recv_on_ah on pm_doc;
create trigger am_recv_on_ah after update of status on pm_doc for each row execute function am_recv_on_ah();


-- =====================================================================
-- 10. ALR: AM Coordinator → AM Executive → Kế toán trưởng (bỏ bước "nhận" cuối —
--     Hotel AM nhận bằng cách quét tem trên máy tính bảng). Chỉ bỏ khi vẫn là mặc định.
-- =====================================================================

delete from pm_chain where doc_type = 'AL' and step = 3 and role_code in ('HOTEL_AM', 'CP_ADMIN', 'JVC_ADMIN')
   and not exists (select 1 from pm_chain c2 where c2.doc_type = 'AL' and c2.step > 3);


-- =====================================================================
-- 11. THÔNG BÁO (thay pm_notify_trg của 27_liquidation.sql)
--     PO duyệt → AM Coordinator "sinh mã tài sản / lập ALR" (thay vì AH).
--     ALR duyệt → Hotel AM "nhận tem, quét, chụp ảnh" (doc_type RV) + Thu mua "đã có ALR".
--     Bộ PR duyệt → Thu mua "gọi báo giá" (như cũ: next QC — app mở màn Tendering).
-- =====================================================================

create or replace function pm_notify_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare k pm_pkg; p pm_project; s pm_pkg_step; v_dept text; v_nos text; v_lead text; v_first bigint; v_next text;
begin
  select * into k from pm_pkg where id = new.pkg_id;
  if k.id is null then return null; end if;
  select * into p from pm_project where code = k.project_code;
  v_dept := coalesce(p.dept_code, k.dept_code);
  select string_agg(x.doc_no, ' + ' order by t.seq), (array_agg(x.id order by t.seq))[1]
    into v_nos, v_first
    from pm_doc x join pm_doc_type t on t.code = x.doc_type
   where x.pkg_id = k.id and x.status not in ('cancelled');
  v_lead := pm_grp_lead(k.grp);

  update pm_notice set read_at = now()
   where pkg_id = k.id and kind = 'todo' and read_at is null;

  if k.status = 'in_review' then
    select * into s from pm_pkg_step where pkg_id = k.id and step = k.current_step;
    insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email, comment)
    select u.id, v_first, k.id, 'todo', v_nos, v_lead, k.project_code, new.actor_email,
           case when new.action = 'return_am' then new.comment end
    from   app_user u
    where  u.active and (u.id is distinct from k.created_by or pm_self_ok())
      and  app_user_role_covers(u.id, s.role_code, v_dept)
      and  exists (select 1 from app_user_role ur
                   join app_permission ap on ap.role_code = ur.role_code
                   where ur.user_id = u.id and ap.module_code = 'approval' and ap.can_approve);
  end if;

  if k.status in ('approved', 'returned', 'rejected', 'cancelled') and new.to_status = k.status
     and k.created_by is not null and k.created_by is distinct from new.actor
     and exists (select 1 from app_user where id = k.created_by) then
    insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email, comment)
    values (k.created_by, v_first, k.id, k.status, v_nos, v_lead, k.project_code, new.actor_email, new.comment);
  end if;

  if k.status = 'approved' and new.to_status = 'approved' and k.project_code is not null then
    if v_lead = 'PO' and exists (select 1 from pm_doc_type where code = 'AL') then
      v_next := 'AL';
    elsif v_lead = 'AL' then
      v_next := null;
    else
      select t.code into v_next from pm_doc_type t
       where t.required and t.side = 'operator'
         and t.seq > (select max(x.seq) from pm_doc_type x where x.code = v_lead or x.grp = k.grp)
       order by t.seq limit 1;
    end if;
    if v_next is not null then
      insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email)
      select distinct u.id, v_first, k.id, 'next', v_nos, v_next, k.project_code, new.actor_email
      from   app_user u
      join   pm_chain c on c.entity = pm_entity(v_dept) and c.doc_type = v_next and c.step = 0
      where  u.active and app_user_role_covers(u.id, c.role_code, v_dept);
    end if;
    if v_lead = 'AL' then
      -- Hotel AM (người lập AH): nhận tem, dán, quét, chụp ảnh, nhập số lượng thực nhận.
      insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email)
      select distinct u.id, v_first, k.id, 'next', v_nos, 'RV', k.project_code, new.actor_email
      from   app_user u
      join   pm_chain c on c.entity = pm_entity(v_dept) and c.doc_type = 'AH' and c.step = 0
      where  u.active and app_user_role_covers(u.id, c.role_code, v_dept);
      -- Thu mua (người lập PO): đã có ALR.
      insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email, comment)
      select distinct u.id, v_first, k.id, 'info', v_nos, 'AL', k.project_code, new.actor_email, 'alr_ready'
      from   app_user u
      join   pm_chain c on c.entity = pm_entity(v_dept) and c.doc_type = 'PO' and c.step = 0
      where  u.active and app_user_role_covers(u.id, c.role_code, v_dept);
    end if;
  end if;
  return null;
end $$;
revoke execute on function pm_notify_trg() from public, anon, authenticated;


-- =====================================================================
-- 11b. VIỆC CẦN LÀM (To-do list) của quy trình mới, theo người đang đăng nhập
--   td_new    Thu mua: bộ PR duyệt xong — gọi báo giá
--   td_q      câu hỏi làm rõ chưa trả lời          td_sv   yêu cầu khảo sát chờ xếp lịch
--   td_due    quá hạn mà chưa đủ số báo giá (gia hạn?)
--   td_open   có hồ sơ niêm phong chờ tôi đồng ý mở
--   po_send   PO duyệt xong chưa gửi nhà cung cấp  ct_upload PO duyệt, chưa có hợp đồng
--   codes     AM Coordinator: PO duyệt, chưa sinh mã tài sản / lập ALR
--   recv      Hotel AM: ALR duyệt, còn tài sản chưa nhận / chưa vào AH
-- =====================================================================

create or replace function pm_todo_proc()
returns table (kind text, project_code text, project_name text, dept_code text, ref_id bigint, ref_no text, at timestamptz, n int, detail text)
language sql stable security definer set search_path = public as $$
  with prj as (
    select p.* from pm_project p
    where  p.status not in ('completed', 'cancelled') and not coalesce(p.wf_offline, false)
      and  (app_trusted() or app_scope_root() or p.dept_code in (select app_scope_orgs()))),
  pr as (select distinct on (d.project_code) d.* from pm_doc d where d.doc_type = 'PR' and d.status = 'approved' order by d.project_code, d.id desc),
  po as (select distinct on (d.project_code) d.* from pm_doc d where d.doc_type = 'PO' and d.status = 'approved' order by d.project_code, d.id desc),
  fin as (select distinct d.project_code from pm_doc d where d.doc_type = 'AH' and d.status = 'approved' and coalesce((d.data ->> 'final')::boolean, false))
  select 'td_new'::text, p.code, p.name, p.dept_code, pr.id, pr.doc_no, pr.decided_at, null::int, null::text
  from   prj p join pr on pr.project_code = p.code
  where  pm_tender_can_manage(p.code)
    and  not exists (select 1 from pm_tender t where t.project_code = p.code and t.status <> 'cancelled')
    and  not exists (select 1 from pm_doc q where q.project_code = p.code and q.doc_type = 'QC' and q.status not in ('cancelled', 'rejected'))
  union all
  select 'td_q', p.code, p.name, p.dept_code, t.id, coalesce(t.title, p.name), min(q.asked_at), count(*)::int, null
  from   prj p join pm_tender t on t.project_code = p.code and t.status <> 'cancelled'
  join   pm_tender_qa q on q.tender_id = t.id and q.answer is null and q.invitee_id is not null
  where  pm_tender_can_answer(p.code)
  group  by p.code, p.name, p.dept_code, t.id, t.title
  union all
  select 'td_sv', p.code, p.name, p.dept_code, t.id, coalesce(t.title, p.name), min(s.created_at), count(*)::int, null
  from   prj p join pm_tender t on t.project_code = p.code and t.status <> 'cancelled'
  join   pm_tender_survey s on s.tender_id = t.id and s.status = 'requested'
  where  pm_tender_can_answer(p.code)
  group  by p.code, p.name, p.dept_code, t.id, t.title
  union all
  select 'td_due', p.code, p.name, p.dept_code, t.id, coalesce(t.title, p.name), t.deadline, x.n, t.min_bids::text
  from   prj p join pm_tender t on t.project_code = p.code and t.status = 'open' and t.deadline < now()
  cross  join lateral (select count(distinct b.invitee_id)::int n from pm_tender_bid b
                       where b.tender_id = t.id and b.round = t.round and b.status = 'submitted') x
  where  pm_tender_can_manage(p.code) and x.n < t.min_bids
    and  not exists (select 1 from pm_tender_bid b where b.tender_id = t.id and b.round = t.round and b.opened_at is not null)
  union all
  select 'td_open', p.code, p.name, p.dept_code, t.id, coalesce(t.title, p.name), t.deadline, x.n, null
  from   prj p join pm_tender t on t.project_code = p.code and t.status <> 'cancelled'
  cross  join lateral (select count(*)::int n from pm_tender_bid b
                       where b.tender_id = t.id and b.status in ('submitted', 'superseded') and b.opened_at is null) x
  where  x.n > 0
    and  (t.deadline <= now() or not exists (select 1 from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id
                                             where i.tender_id = t.id and not v.revoked
                                               and not exists (select 1 from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id
                                                                                               and b.round = t.round and b.status = 'submitted')))
    and  exists (select 1 from unnest(pm_tender_open_roles(p.code)) r(role)
                 where app_user_role_covers(auth.uid(), r.role, p.dept_code)
                   and not exists (select 1 from pm_tender_consent c where c.tender_id = t.id and c.seq = t.open_seq and c.role_code = r.role))
    and  (pm_self_ok() or not exists (select 1 from pm_tender_consent c where c.tender_id = t.id and c.seq = t.open_seq and c.user_id = auth.uid()))
  union all
  select 'po_send', p.code, p.name, p.dept_code, po.id, po.doc_no, po.decided_at, null, po.data ->> 'supplier'
  from   prj p join po on po.project_code = p.code
  where  pm_can_prepare('PO', p.dept_code) and not exists (select 1 from pm_po_send s where s.doc_id = po.id)
  union all
  select 'ct_upload', p.code, p.name, p.dept_code, po.id, po.doc_no, po.decided_at, null, po.data ->> 'supplier'
  from   prj p join po on po.project_code = p.code
  where  pm_can_prepare('PO', p.dept_code) and app_can('contract', 'create')
    and  not exists (select 1 from pm_contract c where c.project_code = p.code and c.status not in ('cancelled', 'rejected'))
    and  not exists (select 1 from pm_doc c where c.project_code = p.code and c.doc_type = 'CT' and c.status not in ('cancelled', 'rejected'))
  union all
  select 'codes', p.code, p.name, p.dept_code, po.id, po.doc_no, po.decided_at, jsonb_array_length(coalesce(po.data -> 'lines', '[]'))::int, null
  from   prj p join po on po.project_code = p.code
  where  pm_can_prepare('AL', p.dept_code)
    and  not exists (select 1 from am_asset a where a.purpose_code = p.code and a.status_code in ('119', '120'))
    and  not exists (select 1 from pm_doc a where a.project_code = p.code and a.doc_type = 'AL' and a.status not in ('cancelled', 'rejected'))
  union all
  select 'recv', p.code, p.name, p.dept_code, al.id, al.doc_no, al.decided_at, x.n, null
  from   prj p join pm_doc al on al.project_code = p.code and al.doc_type = 'AL' and al.status = 'approved'
  cross  join lateral (select count(*)::int n from jsonb_array_elements_text(coalesce(al.data -> 'asset_ids', '[]')) e
                       join am_asset a on a.id = e::bigint
                       where coalesce((select sum(r.qty) from am_recv r join pm_doc h on h.id = r.ah_doc_id
                                       where r.asset_id = a.id and h.status not in ('cancelled', 'rejected')), 0) < coalesce(a.qty, 1)) x
  where  pm_can_prepare('AH', p.dept_code) and x.n > 0 and p.code not in (select project_code from fin)
$$;
revoke execute on function pm_todo_proc() from public, anon;
grant execute on function pm_todo_proc() to authenticated;


-- =====================================================================
-- 12. STORAGE — hồ sơ mời thầu trong bucket "pm-tender" (thư mục doc/<doc_key>/)
-- =====================================================================

drop policy if exists pm_tender_doc_up on storage.objects;
create policy pm_tender_doc_up on storage.objects for insert to authenticated
  with check (bucket_id = 'pm-tender' and pm_tender_doc_ok(name, true));
drop policy if exists pm_tender_doc_rd on storage.objects;
create policy pm_tender_doc_rd on storage.objects for select to authenticated
  using (bucket_id = 'pm-tender' and pm_tender_doc_ok(name, false));
drop policy if exists pm_tender_doc_del on storage.objects;
create policy pm_tender_doc_del on storage.objects for delete to authenticated
  using (bucket_id = 'pm-tender' and pm_tender_doc_ok(name, true));
drop policy if exists pm_tender_doc_anon on storage.objects;
create policy pm_tender_doc_anon on storage.objects for select to anon
  using (bucket_id = 'pm-tender' and vp_doc_ok(name));


-- =====================================================================
-- 13. QUYỀN GỌI HÀM
-- =====================================================================

revoke execute on function pm_tender_notify(bigint, text), pm_tender_actor(), am_recv_on_ah() from public, anon, authenticated;
revoke execute on function pm_tender_can_answer(text), pm_tender_doc_ok(text, boolean), pm_tender_create_prj(text, jsonb),
  pm_tender_set(bigint, jsonb), pm_tender_file_add(bigint, text, text, bigint), pm_tender_file_del(bigint, text),
  pm_tender_link_qc(bigint, bigint), pm_tender_answer(bigint, text, boolean), pm_tender_announce(bigint, text),
  pm_tender_survey_set(bigint, text, timestamptz, text), pm_tender_list(text), pm_tender_board(),
  pm_po_send_do(bigint, bigint, text, text), pm_po_sends(text), am_recv_can(text),
  am_recv_set(bigint, numeric, text, text, boolean), am_recv_pick(bigint[], text), am_recv_link(bigint, bigint[]) from public, anon;
grant execute on function pm_tender_can_answer(text), pm_tender_doc_ok(text, boolean), pm_tender_create_prj(text, jsonb),
  pm_tender_set(bigint, jsonb), pm_tender_file_add(bigint, text, text, bigint), pm_tender_file_del(bigint, text),
  pm_tender_link_qc(bigint, bigint), pm_tender_answer(bigint, text, boolean), pm_tender_announce(bigint, text),
  pm_tender_survey_set(bigint, text, timestamptz, text), pm_tender_list(text), pm_tender_board(),
  pm_po_send_do(bigint, bigint, text, text), pm_po_sends(text), am_recv_can(text),
  am_recv_set(bigint, numeric, text, text, boolean), am_recv_pick(bigint[], text), am_recv_link(bigint, bigint[]) to authenticated;
-- Hàm vp_ cho nhà thầu (anon): mỗi hàm tự kiểm tra mã link.
revoke execute on function vp_session(text), vp_submit(text, bigint), vp_ask(text, bigint, text), vp_survey(text, bigint, jsonb),
  vp_po_ack(text, bigint), vp_doc_ok(text) from public;
grant execute on function vp_session(text), vp_submit(text, bigint), vp_ask(text, bigint, text), vp_survey(text, bigint, jsonb),
  vp_po_ack(text, bigint), vp_doc_ok(text) to anon, authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 14. KIỂM CHỨNG
-- =====================================================================

select 'Bảng hỏi đáp / khảo sát / gửi PO / nhận hàng' as "Mục", count(*)::text as "Thực tế", '4' as "Mong đợi",
       case when count(*) = 4 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.tables where table_schema = 'public' and table_name in ('pm_tender_qa', 'pm_tender_survey', 'pm_po_send', 'am_recv')
union all
select 'RLS bật trên các bảng mới', count(*)::text, '4', case when count(*) = 4 then '✔' else '✘ HỎNG' end
from   pg_class where relname in ('pm_tender_qa', 'pm_tender_survey', 'pm_po_send', 'am_recv') and relrowsecurity
union all
select 'Khách (anon) đọc / ghi thẳng bảng mới (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants where grantee = 'anon' and table_name in ('pm_tender_qa', 'pm_tender_survey', 'pm_po_send', 'am_recv')
union all
select 'Chính sách đọc thẳng hỏi đáp / khảo sát / gửi PO (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'public' and tablename in ('pm_tender_qa', 'pm_tender_survey', 'pm_po_send')
union all
select 'Hàm vp_ công khai cho nhà thầu (25 + 41)', count(*)::text, '12', case when count(*) = 12 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('vp_session', 'vp_save', 'vp_new_version', 'vp_submit', 'vp_file_add', 'vp_file_remove', 'vp_upload_key', 'vp_upload_ok',
                                 'vp_ask', 'vp_survey', 'vp_po_ack', 'vp_doc_ok')
  and  has_function_privilege('anon', oid, 'execute')
union all
select 'Khách gọi được hàm pm_ / am_ mới (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pm_tender_notify', 'pm_tender_create_prj', 'pm_tender_set', 'pm_tender_board', 'pm_tender_answer', 'pm_po_send_do',
                                 'am_recv_set', 'am_recv_link', 'pm_tender_survey_set') and has_function_privilege('anon', oid, 'execute')
union all
select 'Chính sách Storage hồ sơ mời thầu', count(*)::text, '4', case when count(*) = 4 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects'
  and  policyname in ('pm_tender_doc_up', 'pm_tender_doc_rd', 'pm_tender_doc_del', 'pm_tender_doc_anon')
union all
select 'Chuỗi ALR (bước cuối là Kế toán trưởng hoặc đã chỉnh)', coalesce(string_agg(role_code, ' → ' order by step), '—'), 'AM_COORD → AM_EXEC → CHIEF_ACC', '✔'
from   pm_chain where entity = 'SSP' and doc_type = 'AL'
union all
select 'Trigger nhận hàng khi AH cuối duyệt', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_trigger where tgname = 'am_recv_on_ah' and not tgisinternal;
