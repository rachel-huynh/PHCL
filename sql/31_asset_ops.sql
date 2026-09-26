-- =====================================================================
-- 31_asset_ops.sql — QUẢN LÝ TÀI SẢN CHI TIẾT (26/09/2026)
--
-- Chạy SAU 30_acc_reconcile.sql (dùng cột fin_* của 30, bảng pm_lq_item của
-- 27–29, am_asset_photo của 26, pm_notice của 20). Chạy lại nhiều lần vô hại.
-- KHÔNG chạy ALL_IN_ONE.
--
--   am_transfer / am_transfer_line   PHIẾU ĐIỀU CHUYỂN có chuỗi duyệt:
--        bên giao (trưởng BP) → bên nhận (trưởng BP nhận, nếu đổi phòng ban)
--        → TGĐ JVC (nếu đổi pháp nhân SSP / CP / JVC) → nhóm QLTS xác nhận.
--        Bước cuối cập nhật sổ: vị trí; phòng ban → CẤP LẠI MÃ tài sản (giữ mã
--        vạch, đặt lại "đã in tem"); CCDC chuyển một phần → tách dòng mới (mã
--        + mã vạch mới). Tài sản Beetrack (is_legacy) giữ mã cũ, chỉ đổi phòng ban.
--   am_incident   SỰ CỐ: hỏng cần sửa · bảo dưỡng · vỡ (B&L) · mất. Tình trạng
--        tài sản đổi theo: báo hỏng → 3 / 25, đang sửa → 5 (bảo dưỡng 6),
--        sửa xong → tình trạng cũ, không sửa được → 4 / 25 (chờ lập LR),
--        mất → 0 (CCDC: trừ số lượng).
--   am_count / am_count_line   KIỂM KÊ ĐỊNH KỲ theo bộ phận / vị trí: chụp danh
--        sách sổ khi mở đợt, quét mã vạch trên máy tính bảng, thừa / thiếu /
--        sai vị trí / tình trạng; đóng đợt → (tuỳ chọn) cập nhật vị trí, lập sự
--        cố "mất" cho tài sản không thấy, "hỏng" cho tài sản hư.
--   am_report() + am_report_snap   BÁO CÁO ĐỊNH KỲ: tổng hợp theo bộ phận /
--        nhóm / tình trạng, biến động trong kỳ, việc tồn; "chốt kỳ" lưu lại số
--        liệu để so sánh về sau.
--   am_asset_history()   DÒNG ĐỜI một tài sản: nhật ký thay đổi + nhận hàng,
--        tem, ảnh, điều chuyển, sự cố, kiểm kê, thanh lý, đối chiếu kế toán.
--   am_asset.warranty_until   hạn bảo hành.
--
-- Quyền: khu "assets" (không thêm khu mới). Người có assets.view thao tác
-- trong phạm vi phòng ban của mình (lập phiếu điều chuyển, báo sự cố, kiểm
-- kê bộ phận mình); assets.edit (nhóm QLTS) mở / đóng đợt kiểm kê, xử lý sự cố.
-- Duyệt điều chuyển theo VAI TRÒ bao phòng ban (như chuỗi phê duyệt).
--
-- Mọi bảng chỉ ghi qua hàm (không cấp insert/update/delete cho trình duyệt).
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

alter table am_asset add column if not exists warranty_until date;
comment on column am_asset.warranty_until is 'Hạn bảo hành (nhập tay hoặc theo hợp đồng / PO).';

create table if not exists am_transfer (
  id           bigserial primary key,
  no           text not null unique,                     -- TF.<BP giao>.<nnn>.<năm>
  from_dept    text not null,
  to_dept      text not null,
  to_location  text,
  reason       text,
  tf_date      date not null default current_date,
  status       text not null default 'draft'
               check (status in ('draft', 'pending', 'returned', 'done', 'rejected', 'cancelled')),
  steps        jsonb not null default '[]'::jsonb,       -- [{key, roles[], dept, by, name, at, action, comment}]
  cur          int,                                      -- bước đang chờ (0-based)
  relabel      int,                                      -- số tem phải in lại khi hoàn tất
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  done_at      timestamptz
);
create index if not exists am_transfer_status_idx on am_transfer (status);

create table if not exists am_transfer_line (
  id           bigserial primary key,
  transfer_id  bigint not null references am_transfer(id) on delete cascade,
  asset_id     bigint not null references am_asset(id),
  qty          numeric(18, 3),                           -- CCDC: số lượng chuyển (trống = cả dòng)
  old_code     text,                                     -- mã trước khi chuyển (điền lúc hoàn tất)
  new_code     text,
  new_asset_id bigint,                                   -- dòng mới khi tách CCDC
  note         text
);
create index if not exists am_transfer_line_tf_idx on am_transfer_line (transfer_id);
create index if not exists am_transfer_line_asset_idx on am_transfer_line (asset_id);

create table if not exists am_incident (
  id            bigserial primary key,
  no            text unique,                             -- SC.<năm>.<nnnnn>
  asset_id      bigint not null references am_asset(id),
  dept_code     text,
  kind          text not null check (kind in ('repair', 'maintenance', 'breakage', 'loss')),
  qty           numeric(18, 3),                          -- CCDC: số lượng bị ảnh hưởng
  status        text not null default 'open' check (status in ('open', 'in_progress', 'closed', 'cancelled')),
  reported_at   date not null default current_date,
  description   text,
  cause         text,
  wo_no         text,                                    -- số work order
  vendor        text,
  warranty      boolean,                                 -- còn bảo hành?
  cost          numeric(18, 2),
  outcome       text check (outcome in ('fixed', 'no_fault', 'replace', 'liquidate', 'lost')),
  outcome_note  text,
  lr_doc_no     text,
  prev_status   text,                                    -- tình trạng trước khi báo (để trả lại)
  count_id      bigint,                                  -- sinh từ đợt kiểm kê
  created_by    uuid default auth.uid(),
  created_name  text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  closed_at     timestamptz,
  closed_by     uuid,
  closed_name   text
);
create index if not exists am_incident_asset_idx on am_incident (asset_id);
create index if not exists am_incident_status_idx on am_incident (status);

create table if not exists am_count (
  id           bigserial primary key,
  code         text not null unique,                     -- KK.<năm>.<nn>
  title        text,
  depts        text[] not null,
  locations    text[],                                   -- trống = mọi vị trí của các bộ phận
  count_date   date not null default current_date,
  status       text not null default 'draft' check (status in ('draft', 'open', 'closed', 'cancelled')),
  members      jsonb not null default '[]'::jsonb,       -- [{name, position, user_id}]
  note         text,
  summary      jsonb,
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now(),
  opened_at    timestamptz,
  closed_at    timestamptz,
  closed_by    uuid,
  closed_name  text
);

create table if not exists am_count_line (
  id           bigserial primary key,
  count_id     bigint not null references am_count(id) on delete cascade,
  asset_id     bigint references am_asset(id),
  barcode      text,
  asset_code   text,
  name         text,
  kind         text,
  dept_code    text,
  loc_book     text,
  qty_book     numeric(18, 3),
  status_book  text,
  extra        boolean not null default false,           -- quét được nhưng không có trong danh sách đợt
  found        boolean,                                  -- null = chưa kiểm
  qty_found    numeric(18, 3),
  loc_found    text,
  cond         text check (cond in ('good', 'poor', 'damaged')),
  note         text,
  by_user      uuid,
  by_name      text,
  at           timestamptz,
  action       text                                      -- việc đã làm khi đóng đợt (moved / incident:…)
);
create index if not exists am_count_line_count_idx on am_count_line (count_id);
create index if not exists am_count_line_asset_idx on am_count_line (asset_id);

create table if not exists am_report_snap (
  id           bigserial primary key,
  period       text not null unique,                     -- 2026-09, 2026-Q3, 2026 …
  p_from       date,
  p_to         date,
  data         jsonb not null,
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now()
);

-- Chuỗi duyệt điều chuyển: sửa được ở Hệ thống → Cài đặt (am_setting).
insert into am_setting (key, value, note) values
  ('am_transfer_heads', '{"SSP": ["DEPT_HEAD"], "CP": ["CP_HEAD"], "JVC": ["JVC_GM", "JVC_DGM"]}'::jsonb,
   'Điều chuyển tài sản: vai trò trưởng bộ phận ký bên giao / bên nhận, theo pháp nhân'),
  ('am_transfer_confirm', '["AM_EXEC", "AM_COORD"]'::jsonb,
   'Điều chuyển tài sản: vai trò xác nhận cuối (cập nhật sổ, cấp lại mã)')
on conflict (key) do nothing;


-- =====================================================================
-- 2. HÀM PHỤ
-- =====================================================================

create or replace function am_me_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email', 'sql:' || session_user)
$$;

-- Phòng ban có nằm trong phạm vi của người gọi không.
create or replace function am_in_scope(p_dept text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or p_dept in (select app_scope_orgs())
$$;

-- Công ty (pháp nhân) gần nhất phía trên một phòng ban: cột company_code của tài sản.
create or replace function am_company_of(p_dept text)
returns text language sql stable security definer set search_path = public as $$
  with recursive up(code, parent_code, is_company, depth) as (
    select o.code, o.parent_code, o.is_company, 0 from am_org o where o.code = p_dept
    union all
    select o.code, o.parent_code, o.is_company, u.depth + 1 from am_org o join up u on o.code = u.parent_code where u.depth < 12
  )
  select code from up where is_company order by depth limit 1
$$;

-- Người dùng đang hoạt động giữ một trong các vai trò, phạm vi bao phòng ban.
create or replace function am_actors(p_roles jsonb, p_dept text)
returns setof uuid language sql stable security definer set search_path = public as $$
  select u.id from app_user u
  where  u.active and exists (select 1 from jsonb_array_elements_text(p_roles) r where app_user_role_covers(u.id, r, p_dept))
$$;

create or replace function am_is_actor(p_roles jsonb, p_dept text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or exists (select 1 from jsonb_array_elements_text(p_roles) r where app_user_role_covers(auth.uid(), r, p_dept))
$$;

-- Thông báo trong app (chuông) — dùng lại pm_notice, doc_type 'TF' / 'SC' / 'KK'.
create or replace function am_notify(p_users uuid[], p_kind text, p_no text, p_type text, p_dept text, p_comment text default null)
returns void language sql security definer set search_path = public as $$
  insert into pm_notice (user_id, kind, doc_no, doc_type, project_code, actor_email, comment)
  select distinct u, p_kind, p_no, p_type, p_dept, coalesce(app_claims() ->> 'email', 'sql'), p_comment
  from   unnest(p_users) u
  where  u is not null and u is distinct from auth.uid()
$$;

-- Tình trạng "còn trên sổ" (không tính đã mất / đã thanh lý / đã huỷ / CCDC đã thanh lý).
create or replace function am_alive(p_status text)
returns boolean language sql immutable as $$
  select coalesce(p_status, '') not in ('0', '7', '9', '23')
$$;


-- =====================================================================
-- 3. ĐIỀU CHUYỂN
-- =====================================================================

create or replace function am_tf_steps(p_from text, p_to text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  heads jsonb := coalesce((select value from am_setting where key = 'am_transfer_heads'),
                          '{"SSP": ["DEPT_HEAD"], "CP": ["CP_HEAD"], "JVC": ["JVC_GM", "JVC_DGM"]}'::jsonb);
  conf  jsonb := coalesce((select value from am_setting where key = 'am_transfer_confirm'), '["AM_EXEC", "AM_COORD"]'::jsonb);
  ef    text := pm_entity(p_from);
  et    text := pm_entity(p_to);
  s     jsonb;
begin
  s := jsonb_build_array(jsonb_build_object('key', 'from', 'roles', coalesce(heads -> ef, '["DEPT_HEAD"]'::jsonb), 'dept', p_from));
  if p_to <> p_from then
    s := s || jsonb_build_array(jsonb_build_object('key', 'to', 'roles', coalesce(heads -> et, '["DEPT_HEAD"]'::jsonb), 'dept', p_to));
  end if;
  if ef is distinct from et then
    s := s || jsonb_build_array(jsonb_build_object('key', 'jvc', 'roles', '["JVC_GM"]'::jsonb, 'dept', p_from));
  end if;
  return s || jsonb_build_array(jsonb_build_object('key', 'am', 'roles', conf, 'dept', p_from));
end $$;

-- Tạo / sửa phiếu nháp. p_data: {from_dept, to_dept, to_location, reason, tf_date, lines:[{asset_id, qty, note}]}
create or replace function am_tf_save(p_id bigint, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  t      am_transfer;
  v_from text := upper(trim(p_data ->> 'from_dept'));
  v_to   text := upper(trim(coalesce(nullif(p_data ->> 'to_dept', ''), p_data ->> 'from_dept')));
  v_loc  text := nullif(upper(trim(coalesce(p_data ->> 'to_location', ''))), '');
  v_date date := coalesce(nullif(p_data ->> 'tf_date', '')::date, current_date);
  v_n    int;
  l      jsonb;
  a      record;
begin
  perform app_require('assets', 'view');
  if not am_in_scope(v_from) then raise exception 'Phòng ban % nằm ngoài phạm vi của bạn.', v_from using errcode = '42501'; end if;
  if not exists (select 1 from am_org where code = v_to and is_department) then raise exception 'Mã phòng ban nhận % không có trong danh mục.', v_to; end if;
  if v_loc is not null and not exists (select 1 from am_location where code = v_loc) then raise exception 'Mã vị trí % không có trong danh mục.', v_loc; end if;
  if v_to = v_from and v_loc is null then raise exception 'Chọn phòng ban nhận khác hoặc vị trí mới.'; end if;
  if jsonb_array_length(coalesce(p_data -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Phiếu chưa có tài sản nào.'; end if;

  if p_id is null then
    lock table am_transfer in share row exclusive mode;
    select coalesce(max(split_part(no, '.', 3)::int), 0) + 1 into v_n
    from   am_transfer where split_part(no, '.', 2) = v_from and split_part(no, '.', 4) = extract(year from v_date)::text;
    insert into am_transfer (no, from_dept, to_dept, to_location, reason, tf_date, created_name)
    values ('TF.' || v_from || '.' || lpad(v_n::text, 3, '0') || '.' || extract(year from v_date)::int,
            v_from, v_to, v_loc, p_data ->> 'reason', v_date, am_me_name())
    returning * into t;
  else
    select * into t from am_transfer where id = p_id for update;
    if not found then raise exception 'Không có phiếu %.', p_id; end if;
    if t.status not in ('draft', 'returned') then raise exception 'Phiếu % đã gửi — không sửa được.', t.no; end if;
    if t.created_by is distinct from auth.uid() and not app_can('assets', 'edit') then raise exception 'Chỉ người lập sửa được phiếu.' using errcode = '42501'; end if;
    if v_from <> t.from_dept then raise exception 'Không đổi được phòng ban giao của phiếu đã lập.'; end if;
    update am_transfer set to_dept = v_to, to_location = v_loc, reason = p_data ->> 'reason', tf_date = v_date where id = t.id;
    delete from am_transfer_line where transfer_id = t.id;
  end if;

  for l in select * from jsonb_array_elements(p_data -> 'lines') loop
    select x.id, x.asset_code, x.asset_kind, x.qty, x.dept_code, x.status_code into a from am_asset x where x.id = (l ->> 'asset_id')::bigint;
    if not found then raise exception 'Không có tài sản id %.', l ->> 'asset_id'; end if;
    if a.dept_code <> v_from then raise exception 'Tài sản % thuộc phòng ban %, không phải %.', a.asset_code, a.dept_code, v_from; end if;
    if not am_alive(a.status_code) then raise exception 'Tài sản % đã mất / thanh lý / huỷ.', a.asset_code; end if;
    if exists (select 1 from am_transfer_line tl join am_transfer x on x.id = tl.transfer_id
               where tl.asset_id = a.id and x.id <> t.id and x.status in ('draft', 'pending', 'returned')) then
      raise exception 'Tài sản % đang nằm trên một phiếu điều chuyển khác.', a.asset_code;
    end if;
    if a.asset_kind = 'low' and nullif(l ->> 'qty', '') is not null
       and ((l ->> 'qty')::numeric <= 0 or (l ->> 'qty')::numeric > a.qty) then
      raise exception 'Số lượng chuyển của % phải từ 0 đến %.', a.asset_code, a.qty;
    end if;
    insert into am_transfer_line (transfer_id, asset_id, qty, note)
    values (t.id, a.id, case when a.asset_kind = 'low' then nullif(l ->> 'qty', '')::numeric end, l ->> 'note');
  end loop;
  return t.id;
end $$;

create or replace function am_tf_submit(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare t am_transfer; s jsonb;
begin
  perform app_require('assets', 'view');
  select * into t from am_transfer where id = p_id for update;
  if not found then raise exception 'Không có phiếu %.', p_id; end if;
  if t.status not in ('draft', 'returned') then raise exception 'Phiếu % không ở trạng thái nháp.', t.no; end if;
  if t.created_by is distinct from auth.uid() and not app_can('assets', 'edit') then raise exception 'Chỉ người lập gửi được phiếu.' using errcode = '42501'; end if;
  if not exists (select 1 from am_transfer_line where transfer_id = t.id) then raise exception 'Phiếu chưa có tài sản nào.'; end if;
  s := am_tf_steps(t.from_dept, t.to_dept);
  update am_transfer set status = 'pending', steps = s, cur = 0, submitted_at = now() where id = t.id;
  perform am_notify(array(select am_actors(s -> 0 -> 'roles', s -> 0 ->> 'dept')), 'todo', t.no, 'TF', t.from_dept, t.reason);
end $$;

-- Cập nhật sổ khi bước cuối xác nhận. Nội bộ (không cấp cho trình duyệt).
create or replace function am_tf_apply(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare
  t       am_transfer;
  l       record;
  a       am_asset;
  n       am_asset;
  v_mv    numeric;
  v_seq   int;
  v_co    text;
  v_rel   int := 0;
  v_new   boolean;
begin
  select * into t from am_transfer where id = p_id;
  v_new := t.to_dept <> t.from_dept;
  v_co  := case when v_new then am_company_of(t.to_dept) end;
  for l in select * from am_transfer_line where transfer_id = p_id order by id loop
    select * into a from am_asset where id = l.asset_id for update;
    if a.dept_code <> t.from_dept then raise exception 'Tài sản % đã đổi phòng ban (%) từ khi lập phiếu.', a.asset_code, a.dept_code; end if;
    v_mv := case when a.asset_kind = 'low' then coalesce(l.qty, a.qty) else 1 end;

    if a.asset_kind = 'low' and v_mv < a.qty then
      -- CCDC chuyển một phần: phần chuyển thành dòng mới (mã + mã vạch mới), dòng cũ giảm số lượng.
      update am_asset set qty = qty - v_mv where id = a.id;
      n := a;
      n.id            := nextval(pg_get_serial_sequence('am_asset', 'id'));
      n.qty           := v_mv;
      n.barcode       := am_format_barcode('low', am_alloc_barcode('low', 1, null, 'transfer ' || t.no));
      n.dept_code     := t.to_dept;
      n.company_code  := coalesce(v_co, a.company_code);
      n.letters       := am_letters(a.letters);
      n.seq           := am_alloc_asset_seq(t.to_dept, am_letters(a.letters), 1, null, 'transfer ' || t.no);
      n.asset_code    := am_build_asset_code(t.to_dept, a.group_code, am_letters(a.letters), a.purchase_year, n.seq);
      n.location_code := coalesce(t.to_location, a.location_code);
      n.is_legacy     := false;
      n.label_printed := false;
      n.created_at    := now();
      n.needs_review  := '[]'::jsonb;
      n.fin_status := null; n.fin_cost := null; n.fin_nbv := null; n.fin_start := null;
      n.fin_term := null; n.fin_account := null; n.fin_as_of := null; n.fin_note := null;
      n.note          := trim(both ' ' from coalesce(a.note, '') || ' [tách từ ' || a.asset_code || ' theo ' || t.no || ']');
      insert into am_asset select n.*;
      update am_transfer_line set old_code = a.asset_code, new_code = n.asset_code, new_asset_id = n.id where id = l.id;
      v_rel := v_rel + 1;
    elsif v_new and not a.is_legacy then
      -- Đổi phòng ban: cấp lại mã (mã mang mã phòng ban), mã vạch giữ nguyên, tem phải in lại.
      v_seq := am_alloc_asset_seq(t.to_dept, am_letters(a.letters), 1, null, 'transfer ' || t.no);
      update am_asset
         set dept_code = t.to_dept, company_code = coalesce(v_co, company_code), letters = am_letters(a.letters), seq = v_seq,
             asset_code = am_build_asset_code(t.to_dept, a.group_code, am_letters(a.letters), a.purchase_year, v_seq),
             location_code = coalesce(t.to_location, location_code), label_printed = false
       where id = a.id
      returning asset_code into n.asset_code;
      update am_transfer_line set old_code = a.asset_code, new_code = n.asset_code where id = l.id;
      if a.label_printed then v_rel := v_rel + 1; end if;
    else
      -- Chỉ đổi vị trí, hoặc tài sản Beetrack (mã cũ không dựng lại được): giữ mã.
      update am_asset set dept_code = t.to_dept, company_code = coalesce(v_co, company_code),
                          location_code = coalesce(t.to_location, location_code)
       where id = a.id;
      update am_transfer_line set old_code = a.asset_code, new_code = a.asset_code where id = l.id;
    end if;
  end loop;
  return v_rel;
end $$;

-- approve | return | reject. Người lập không tự duyệt (trừ khi bật pm_allow_self_approve).
create or replace function am_tf_act(p_id bigint, p_action text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t   am_transfer;
  s   jsonb;
  st  jsonb;
  v_last boolean;
  v_rel  int;
begin
  perform app_require('assets', 'view');
  select * into t from am_transfer where id = p_id for update;
  if not found then raise exception 'Không có phiếu %.', p_id; end if;
  if t.status <> 'pending' then raise exception 'Phiếu % không chờ duyệt.', t.no; end if;
  st := t.steps -> t.cur;
  if not am_is_actor(st -> 'roles', st ->> 'dept') then raise exception 'Bước này không phải của bạn.' using errcode = '42501'; end if;
  if t.created_by = auth.uid() and not pm_self_ok() then raise exception 'Người lập không duyệt phiếu của mình.' using errcode = '42501'; end if;
  if p_action not in ('approve', 'return', 'reject') then raise exception 'Thao tác không hợp lệ: %', p_action; end if;
  if p_action in ('return', 'reject') and coalesce(trim(p_comment), '') = '' then raise exception 'Ghi lý do trả lại / từ chối.'; end if;

  s := jsonb_set(t.steps, array[t.cur::text], st || jsonb_build_object('by', auth.uid(), 'name', am_me_name(), 'at', now(),
                                                                      'action', p_action, 'comment', p_comment));
  v_last := t.cur = jsonb_array_length(t.steps) - 1;
  if p_action = 'return' then
    update am_transfer set status = 'returned', steps = s, cur = null where id = t.id;
    perform am_notify(array[t.created_by], 'returned', t.no, 'TF', t.from_dept, p_comment);
  elsif p_action = 'reject' then
    update am_transfer set status = 'rejected', steps = s, cur = null where id = t.id;
    perform am_notify(array[t.created_by], 'rejected', t.no, 'TF', t.from_dept, p_comment);
  elsif v_last then
    update am_transfer set steps = s where id = t.id;
    v_rel := am_tf_apply(t.id);
    update am_transfer set status = 'done', cur = null, done_at = now(), relabel = v_rel where id = t.id;
    perform am_notify(array[t.created_by], 'approved', t.no, 'TF', t.from_dept, p_comment);
  else
    update am_transfer set steps = s, cur = t.cur + 1 where id = t.id;
    perform am_notify(array(select am_actors(s -> (t.cur + 1) -> 'roles', s -> (t.cur + 1) ->> 'dept')), 'todo', t.no, 'TF', t.from_dept, t.reason);
  end if;
  return jsonb_build_object('status', (select status from am_transfer where id = t.id), 'relabel', v_rel);
end $$;

create or replace function am_tf_cancel(p_id bigint, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t am_transfer;
begin
  perform app_require('assets', 'view');
  select * into t from am_transfer where id = p_id for update;
  if not found then raise exception 'Không có phiếu %.', p_id; end if;
  if t.status not in ('draft', 'pending', 'returned') then raise exception 'Phiếu % đã kết thúc.', t.no; end if;
  if t.created_by is distinct from auth.uid() and not app_can('assets', 'admin') then raise exception 'Chỉ người lập huỷ được phiếu.' using errcode = '42501'; end if;
  update am_transfer set status = 'cancelled', cur = null,
         steps = steps || jsonb_build_array(jsonb_build_object('key', 'cancel', 'by', auth.uid(), 'name', am_me_name(), 'at', now(), 'action', 'cancel', 'comment', p_comment))
   where id = t.id;
end $$;

-- Việc chờ tôi: phiếu đang ở bước mà tôi giữ vai trò.
create or replace function am_tf_inbox()
returns setof am_transfer language sql stable security definer set search_path = public as $$
  select t.* from am_transfer t
  where  t.status = 'pending'
    and  am_is_actor(t.steps -> t.cur -> 'roles', t.steps -> t.cur ->> 'dept')
    and  (t.created_by is distinct from auth.uid() or pm_self_ok())
  order by t.submitted_at
$$;


-- =====================================================================
-- 4. SỰ CỐ — hỏng / bảo dưỡng / vỡ (B&L) / mất
-- =====================================================================

-- p_data: {asset_id, kind, qty, reported_at, description, cause, wo_no, vendor, warranty}
create or replace function am_inc_report(p_data jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare a am_asset; v_id bigint; v_kind text := p_data ->> 'kind'; v_st text;
begin
  perform app_require('assets', 'view');
  select * into a from am_asset where id = (p_data ->> 'asset_id')::bigint for update;
  if not found then raise exception 'Không có tài sản.'; end if;
  if not am_in_scope(a.dept_code) then raise exception 'Tài sản % nằm ngoài phạm vi của bạn.', a.asset_code using errcode = '42501'; end if;
  if not am_alive(a.status_code) then raise exception 'Tài sản % đã mất / thanh lý / huỷ.', a.asset_code; end if;
  if v_kind not in ('repair', 'maintenance', 'breakage', 'loss') then raise exception 'Loại sự cố không hợp lệ: %', v_kind; end if;
  if exists (select 1 from am_incident where asset_id = a.id and status in ('open', 'in_progress') and kind = v_kind) then
    raise exception 'Tài sản % đang có sự cố cùng loại chưa đóng.', a.asset_code;
  end if;
  insert into am_incident (asset_id, dept_code, kind, qty, reported_at, description, cause, wo_no, vendor, warranty, prev_status, created_name, count_id)
  values (a.id, a.dept_code, v_kind, case when a.asset_kind = 'low' then coalesce(nullif(p_data ->> 'qty', '')::numeric, a.qty) end,
          coalesce(nullif(p_data ->> 'reported_at', '')::date, current_date), p_data ->> 'description', p_data ->> 'cause',
          p_data ->> 'wo_no', p_data ->> 'vendor', nullif(p_data ->> 'warranty', '')::boolean, a.status_code, am_me_name(),
          nullif(p_data ->> 'count_id', '')::bigint)
  returning id into v_id;
  update am_incident set no = 'SC.' || extract(year from reported_at)::int || '.' || lpad(v_id::text, 5, '0') where id = v_id;
  -- Hỏng / vỡ: "chờ sửa". Bảo dưỡng và mất không đổi tình trạng lúc báo.
  if v_kind in ('repair', 'breakage') and coalesce(a.status_code, '') not in ('3', '4', '5', '6', '25', '8', '24') then
    v_st := case when a.asset_kind = 'unique' then '3' else '25' end;
    update am_asset set status_code = v_st where id = a.id;
  end if;
  perform am_notify(array(select am_actors((select value from am_setting where key = 'am_transfer_confirm'), a.dept_code)),
                    'todo', (select no from am_incident where id = v_id), 'SC', a.dept_code, p_data ->> 'description');
  return v_id;
end $$;

-- Cập nhật khi đang xử lý: {wo_no, vendor, warranty, cost, description, cause, lr_doc_no, start:true}
create or replace function am_inc_update(p_id bigint, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare i am_incident; a am_asset;
begin
  perform app_require('assets', 'view');
  select * into i from am_incident where id = p_id for update;
  if not found then raise exception 'Không có sự cố %.', p_id; end if;
  if not (app_can('assets', 'edit') or (i.created_by = auth.uid() and i.status = 'open')) then
    raise exception 'Chỉ nhóm QLTS (hoặc người báo, khi chưa xử lý) sửa được.' using errcode = '42501';
  end if;
  if i.status in ('closed', 'cancelled') and not (p_data ? 'lr_doc_no') then raise exception 'Sự cố % đã đóng.', i.no; end if;
  update am_incident set
    wo_no       = case when p_data ? 'wo_no'       then p_data ->> 'wo_no'       else wo_no end,
    vendor      = case when p_data ? 'vendor'      then p_data ->> 'vendor'      else vendor end,
    warranty    = case when p_data ? 'warranty'    then nullif(p_data ->> 'warranty', '')::boolean else warranty end,
    cost        = case when p_data ? 'cost'        then nullif(p_data ->> 'cost', '')::numeric else cost end,
    description = case when p_data ? 'description' then p_data ->> 'description' else description end,
    cause       = case when p_data ? 'cause'       then p_data ->> 'cause'       else cause end,
    lr_doc_no   = case when p_data ? 'lr_doc_no'   then p_data ->> 'lr_doc_no'   else lr_doc_no end
  where id = i.id;
  if coalesce((p_data ->> 'start')::boolean, false) and i.status = 'open' then
    if not app_can('assets', 'edit') then raise exception 'Chỉ nhóm QLTS chuyển sang "đang xử lý".' using errcode = '42501'; end if;
    update am_incident set status = 'in_progress', started_at = now() where id = i.id;
    select * into a from am_asset where id = i.asset_id for update;
    if a.asset_kind = 'unique' and i.kind in ('repair', 'breakage', 'maintenance') and a.status_code not in ('4', '8') then
      update am_asset set status_code = case when i.kind = 'maintenance' then '6' else '5' end where id = a.id;
    end if;
  end if;
end $$;

-- Đóng: fixed | no_fault → tình trạng cũ · replace | liquidate → 4 / 25 (chờ LR) · lost → 0 (CCDC trừ số lượng)
create or replace function am_inc_close(p_id bigint, p_outcome text, p_note text default null, p_cost numeric default null)
returns void language plpgsql security definer set search_path = public as $$
declare i am_incident; a am_asset; v_back text;
begin
  perform app_require('assets', 'edit');
  select * into i from am_incident where id = p_id for update;
  if not found then raise exception 'Không có sự cố %.', p_id; end if;
  if i.status in ('closed', 'cancelled') then raise exception 'Sự cố % đã đóng.', i.no; end if;
  if p_outcome not in ('fixed', 'no_fault', 'replace', 'liquidate', 'lost') then raise exception 'Kết quả không hợp lệ: %', p_outcome; end if;
  select * into a from am_asset where id = i.asset_id for update;
  v_back := case when am_alive(i.prev_status) and coalesce(i.prev_status, '') not in ('3', '4', '5', '6', '25', '')
                 then i.prev_status when a.asset_kind = 'unique' then '1' else '20' end;
  if p_outcome in ('fixed', 'no_fault') then
    if coalesce(a.status_code, '') in ('3', '5', '6', '25') then update am_asset set status_code = v_back where id = a.id; end if;
  elsif p_outcome in ('replace', 'liquidate') then
    if coalesce(a.status_code, '') not in ('8', '24') then
      update am_asset set status_code = case when a.asset_kind = 'unique' then '4' else '25' end where id = a.id;
    end if;
  else  -- lost
    if a.asset_kind = 'unique' then update am_asset set status_code = '0' where id = a.id;
    else
      update am_asset set qty = greatest(qty - coalesce(i.qty, qty), 0),
                          status_code = case when qty - coalesce(i.qty, qty) <= 0 then '21' else status_code end
       where id = a.id;
    end if;
  end if;
  update am_incident set status = 'closed', outcome = p_outcome, outcome_note = p_note, cost = coalesce(p_cost, cost),
         closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name()
   where id = i.id;
  perform am_notify(array[i.created_by], 'approved', i.no, 'SC', i.dept_code, p_note);
end $$;

create or replace function am_inc_cancel(p_id bigint, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare i am_incident; a am_asset;
begin
  perform app_require('assets', 'view');
  select * into i from am_incident where id = p_id for update;
  if not found then raise exception 'Không có sự cố %.', p_id; end if;
  if i.status in ('closed', 'cancelled') then raise exception 'Sự cố % đã đóng.', i.no; end if;
  if not (app_can('assets', 'edit') or (i.created_by = auth.uid() and i.status = 'open')) then raise exception 'Không huỷ được sự cố này.' using errcode = '42501'; end if;
  select * into a from am_asset where id = i.asset_id for update;
  if coalesce(a.status_code, '') in ('3', '5', '6', '25') and i.prev_status is not null then
    update am_asset set status_code = i.prev_status where id = a.id;
  end if;
  update am_incident set status = 'cancelled', outcome_note = p_note, closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name() where id = i.id;
end $$;


-- =====================================================================
-- 5. KIỂM KÊ ĐỊNH KỲ
-- =====================================================================

-- Người được kiểm: QLTS (assets.edit), thành viên có tài khoản, hoặc người có
-- assets.view mà phạm vi bao mọi bộ phận của đợt.
create or replace function am_count_can(p_count bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or app_can('assets', 'edit')
      or exists (select 1 from am_count c, jsonb_array_elements(c.members) m
                 where c.id = p_count and m ->> 'user_id' = auth.uid()::text)
      or (app_can('assets', 'view')
          and not exists (select 1 from am_count c, unnest(c.depts) d where c.id = p_count and not am_in_scope(d)))
$$;

-- p_data: {title, depts[], locations[], count_date, members[{name, position, user_id}], note}
create or replace function am_count_save(p_id bigint, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare c am_count; v_n int; v_d date := coalesce(nullif(p_data ->> 'count_date', '')::date, current_date);
        v_depts text[] := array(select upper(trim(x)) from jsonb_array_elements_text(coalesce(p_data -> 'depts', '[]'::jsonb)) x where trim(x) <> '');
        v_locs text[]  := nullif(array(select upper(trim(x)) from jsonb_array_elements_text(coalesce(p_data -> 'locations', '[]'::jsonb)) x where trim(x) <> ''), '{}');
begin
  perform app_require('assets', 'edit');
  if coalesce(array_length(v_depts, 1), 0) = 0 then raise exception 'Chọn ít nhất một bộ phận.'; end if;
  if p_id is null then
    lock table am_count in share row exclusive mode;
    select coalesce(max(split_part(code, '.', 3)::int), 0) + 1 into v_n from am_count where split_part(code, '.', 2) = extract(year from v_d)::text;
    insert into am_count (code, title, depts, locations, count_date, members, note, created_name)
    values ('KK.' || extract(year from v_d)::int || '.' || lpad(v_n::text, 2, '0'), p_data ->> 'title', v_depts, v_locs, v_d,
            coalesce(p_data -> 'members', '[]'::jsonb), p_data ->> 'note', am_me_name())
    returning * into c;
  else
    select * into c from am_count where id = p_id for update;
    if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
    if c.status in ('closed', 'cancelled') then raise exception 'Đợt % đã kết thúc.', c.code; end if;
    if c.status = 'open' and (v_depts is distinct from c.depts or v_locs is distinct from c.locations) then
      raise exception 'Đợt đã mở — không đổi phạm vi được (huỷ và lập đợt mới).';
    end if;
    update am_count set title = p_data ->> 'title', depts = v_depts, locations = v_locs, count_date = v_d,
                        members = coalesce(p_data -> 'members', '[]'::jsonb), note = p_data ->> 'note'
     where id = c.id;
  end if;
  return c.id;
end $$;

-- Mở đợt: chụp danh sách sổ tại lúc mở.
create or replace function am_count_open(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare c am_count; v_n int;
begin
  perform app_require('assets', 'edit');
  select * into c from am_count where id = p_id for update;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'draft' then raise exception 'Đợt % đã mở.', c.code; end if;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book)
  select c.id, a.id, a.barcode, a.asset_code, concat_ws(' / ', a.name_vi, nullif(a.name_en, '')), a.asset_kind, a.dept_code,
         a.location_code, a.qty, a.status_code
  from   am_asset a
  where  a.dept_code = any(c.depts)
    and  (c.locations is null or a.location_code = any(c.locations))
    and  am_alive(a.status_code)
    and  (a.asset_kind = 'unique' or a.qty > 0)
  order by a.location_code nulls last, a.asset_code;
  get diagnostics v_n = row_count;
  update am_count set status = 'open', opened_at = now() where id = c.id;
  return v_n;
end $$;

-- Quét một mã (mã vạch hoặc mã tài sản) tại vị trí p_loc. Trả về dòng (jsonb).
create or replace function am_count_scan(p_id bigint, p_code text, p_loc text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c am_count; l am_count_line; a am_asset; q text := upper(trim(p_code)); v_loc text := nullif(upper(trim(coalesce(p_loc, ''))), '');
begin
  select * into c from am_count where id = p_id;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if not am_count_can(p_id) then raise exception 'Bạn không kiểm được đợt này.' using errcode = '42501'; end if;
  select * into l from am_count_line where count_id = p_id and (upper(barcode) = q or upper(asset_code) = q) order by extra limit 1 for update;
  if found then
    update am_count_line set found = true, qty_found = coalesce(qty_found, qty_book), loc_found = coalesce(v_loc, loc_found, loc_book),
                             by_user = auth.uid(), by_name = am_me_name(), at = now()
     where id = l.id returning * into l;
    return to_jsonb(l) || jsonb_build_object('hit', 'list');
  end if;
  -- Không có trong danh sách: tài sản của bộ phận / vị trí khác, hoặc chưa có trên sổ.
  select * into a from am_asset where upper(barcode) = q or upper(asset_code) = q limit 1;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book,
                             extra, found, qty_found, loc_found, by_user, by_name, at)
  values (p_id, a.id, coalesce(a.barcode, q), a.asset_code, concat_ws(' / ', a.name_vi, nullif(a.name_en, '')), a.asset_kind, a.dept_code,
          a.location_code, a.qty, a.status_code, true, true, coalesce(a.qty, 1), v_loc, auth.uid(), am_me_name(), now())
  returning * into l;
  return to_jsonb(l) || jsonb_build_object('hit', case when a.id is null then 'unknown' else 'extra' end);
end $$;

-- Ghi tay một dòng: p_found null = trả về chưa kiểm.
create or replace function am_count_mark(p_line bigint, p_found boolean, p_qty numeric default null, p_loc text default null,
                                         p_cond text default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare l am_count_line; c am_count;
begin
  select * into l from am_count_line where id = p_line for update;
  if not found then raise exception 'Không có dòng %.', p_line; end if;
  select * into c from am_count where id = l.count_id;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if not am_count_can(c.id) then raise exception 'Bạn không kiểm được đợt này.' using errcode = '42501'; end if;
  if p_found is null and l.extra then delete from am_count_line where id = l.id; return; end if;
  update am_count_line set
    found     = p_found,
    qty_found = case when p_found is null then null when not p_found then 0 when kind = 'unique' then 1 else coalesce(p_qty, qty_found, qty_book) end,
    loc_found = case when p_found then coalesce(nullif(upper(trim(coalesce(p_loc, ''))), ''), loc_found, loc_book) end,
    cond      = case when p_found then p_cond end,
    note      = case when p_found is null then null else p_note end,
    by_user   = case when p_found is null then null else auth.uid() end,
    by_name   = case when p_found is null then null else am_me_name() end,
    at        = case when p_found is null then null else now() end
  where id = l.id;
end $$;

-- Đóng đợt. p_apply: {move: bool, lost: bool, damaged: bool, pending_missing: bool}
--   move    tài sản thấy ở vị trí khác → cập nhật vị trí trên sổ
--   lost    tài sản không thấy → lập sự cố "mất" (chờ QLTS xử lý, KHÔNG tự đổi 0)
--   damaged tài sản tình trạng "hỏng" → lập sự cố "hỏng"
--   pending_missing  dòng chưa kiểm coi như không thấy (mặc định true)
create or replace function am_count_close(p_id bigint, p_apply jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c am_count; l record; v jsonb; n_move int := 0; n_lost int := 0; n_dmg int := 0; v_inc bigint;
begin
  perform app_require('assets', 'edit');
  select * into c from am_count where id = p_id for update;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if coalesce((p_apply ->> 'pending_missing')::boolean, true) then
    update am_count_line set found = false, qty_found = 0, note = coalesce(note, 'Chưa kiểm khi đóng đợt') where count_id = c.id and found is null;
  end if;
  for l in select cl.*, a.status_code as cur_status, a.dept_code as cur_dept from am_count_line cl left join am_asset a on a.id = cl.asset_id
           where cl.count_id = c.id and cl.asset_id is not null order by cl.id loop
    if coalesce((p_apply ->> 'move')::boolean, false) and l.found and l.loc_found is not null
       and l.loc_found is distinct from l.loc_book and exists (select 1 from am_location where code = l.loc_found) then
      update am_asset set location_code = l.loc_found where id = l.asset_id;
      update am_count_line set action = 'moved' where id = l.id;
      n_move := n_move + 1;
    end if;
    if coalesce((p_apply ->> 'lost')::boolean, false) and l.found = false and not l.extra and am_alive(l.cur_status)
       and not exists (select 1 from am_incident where asset_id = l.asset_id and kind = 'loss' and status in ('open', 'in_progress')) then
      v_inc := am_inc_report(jsonb_build_object('asset_id', l.asset_id, 'kind', 'loss', 'reported_at', c.count_date,
               'qty', case when l.kind = 'low' then l.qty_book - coalesce(l.qty_found, 0) end,
               'description', 'Không thấy khi kiểm kê ' || c.code, 'count_id', c.id));
      update am_count_line set action = 'incident:' || v_inc where id = l.id;
      n_lost := n_lost + 1;
    elsif coalesce((p_apply ->> 'lost')::boolean, false) and l.found and l.kind = 'low' and l.qty_found < l.qty_book and am_alive(l.cur_status)
       and not exists (select 1 from am_incident where asset_id = l.asset_id and kind = 'loss' and status in ('open', 'in_progress')) then
      v_inc := am_inc_report(jsonb_build_object('asset_id', l.asset_id, 'kind', 'loss', 'reported_at', c.count_date,
               'qty', l.qty_book - l.qty_found, 'description', 'Thiếu ' || (l.qty_book - l.qty_found) || ' khi kiểm kê ' || c.code, 'count_id', c.id));
      update am_count_line set action = 'incident:' || v_inc where id = l.id;
      n_lost := n_lost + 1;
    end if;
    if coalesce((p_apply ->> 'damaged')::boolean, false) and l.found and l.cond = 'damaged' and am_alive(l.cur_status)
       and not exists (select 1 from am_incident where asset_id = l.asset_id and kind in ('repair', 'breakage') and status in ('open', 'in_progress')) then
      v_inc := am_inc_report(jsonb_build_object('asset_id', l.asset_id, 'kind', 'repair', 'reported_at', c.count_date,
               'description', coalesce(l.note, 'Hư hỏng phát hiện khi kiểm kê ' || c.code), 'count_id', c.id));
      update am_count_line set action = coalesce(action || ' ', '') || 'incident:' || v_inc where id = l.id;
      n_dmg := n_dmg + 1;
    end if;
  end loop;
  select jsonb_build_object(
           'total',   count(*) filter (where not extra),
           'found',   count(*) filter (where not extra and found),
           'missing', count(*) filter (where not extra and found = false),
           'short',   count(*) filter (where not extra and found and kind = 'low' and qty_found < qty_book),
           'moved',   count(*) filter (where found and loc_found is distinct from loc_book and not extra),
           'extra',   count(*) filter (where extra),
           'unknown', count(*) filter (where extra and asset_id is null),
           'damaged', count(*) filter (where found and cond = 'damaged'),
           'applied', jsonb_build_object('moved', n_move, 'lost', n_lost, 'damaged', n_dmg))
    into v from am_count_line where count_id = c.id;
  update am_count set status = 'closed', closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name(), summary = v where id = c.id;
  return v;
end $$;

create or replace function am_count_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_require('assets', 'edit');
  update am_count set status = 'cancelled', closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name()
   where id = p_id and status in ('draft', 'open');
  if not found then raise exception 'Đợt đã kết thúc hoặc không có.'; end if;
end $$;


-- =====================================================================
-- 6. BÁO CÁO ĐỊNH KỲ
-- =====================================================================

-- Số liệu hiện tại của sổ (trong phạm vi người gọi) + biến động trong [p_from, p_to].
-- Giá trị: nguyên giá kế toán khi đã ghi nhận, còn lại giá tạm (đơn giá × SL).
create or replace function am_report(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; s text[];
begin
  perform app_require('assets', 'view');
  s := array(select app_scope_orgs());
  with a as (
    select x.*, case when x.fin_status = 'booked' and x.fin_cost is not null then x.fin_cost else coalesce(x.unit_price, 0) * coalesce(x.qty, 1) end as val,
           x.fin_status = 'booked' as booked
    from am_asset x where x.dept_code = any(s)
  ), live as (select * from a where am_alive(status_code))
  select jsonb_build_object(
    'as_of', now(), 'from', p_from, 'to', p_to,
    'totals', (select jsonb_build_object('rows', count(*), 'unique', count(*) filter (where asset_kind = 'unique'),
                                         'low_rows', count(*) filter (where asset_kind = 'low'), 'low_qty', coalesce(sum(qty) filter (where asset_kind = 'low'), 0),
                                         'value', coalesce(sum(val), 0), 'booked', count(*) filter (where booked),
                                         'booked_cost', coalesce(sum(fin_cost) filter (where booked), 0), 'nbv', coalesce(sum(fin_nbv) filter (where booked), 0),
                                         'temp', count(*) filter (where fin_status is null and not is_legacy),
                                         'temp_value', coalesce(sum(val) filter (where fin_status is null and not is_legacy), 0),
                                         'no_label', count(*) filter (where not label_printed and not coalesce(no_label, false) and not is_legacy))
               from live),
    'by_dept', (select coalesce(jsonb_agg(r order by r ->> 'dept'), '[]'::jsonb) from (
                 select jsonb_build_object('dept', dept_code, 'unique', count(*) filter (where asset_kind = 'unique'),
                                           'low_rows', count(*) filter (where asset_kind = 'low'), 'low_qty', coalesce(sum(qty) filter (where asset_kind = 'low'), 0),
                                           'value', coalesce(sum(val), 0), 'booked_cost', coalesce(sum(fin_cost) filter (where booked), 0),
                                           'nbv', coalesce(sum(fin_nbv) filter (where booked), 0), 'temp', count(*) filter (where fin_status is null and not is_legacy),
                                           'repair', count(*) filter (where status_code in ('3', '4', '5', '6', '25')),
                                           'awaiting', count(*) filter (where status_code in ('8', '24'))) r
                 from live group by dept_code) q),
    'by_group', (select coalesce(jsonb_agg(r order by r ->> 'group'), '[]'::jsonb) from (
                 select jsonb_build_object('group', group_code, 'rows', count(*), 'qty', coalesce(sum(qty), 0), 'value', coalesce(sum(val), 0)) r
                 from live group by group_code) q),
    'by_status', (select coalesce(jsonb_agg(r order by r ->> 'status'), '[]'::jsonb) from (
                 select jsonb_build_object('status', coalesce(status_code, ''), 'rows', count(*), 'qty', coalesce(sum(qty), 0), 'value', coalesce(sum(val), 0)) r
                 from a group by status_code) q),
    'movement', jsonb_build_object(
       'new', (select count(*) from a where created_at::date between p_from and p_to),
       'new_value', (select coalesce(sum(val), 0) from a where created_at::date between p_from and p_to),
       'status', (select coalesce(jsonb_object_agg(st, n), '{}'::jsonb) from (
                    select au.new_data ->> 'status_code' as st, count(*) as n from app_audit au
                    where au.tbl = 'am_asset' and au.op = 'UPDATE' and au.new_data ? 'status_code'
                      and au.at::date between p_from and p_to and au.pk in (select id::text from a)
                    group by 1) q),
       'transfers', (select count(*) from am_transfer where status = 'done' and done_at::date between p_from and p_to
                       and (from_dept = any(s) or to_dept = any(s))),
       'transfer_lines', (select count(*) from am_transfer_line tl join am_transfer t on t.id = tl.transfer_id
                            where t.status = 'done' and t.done_at::date between p_from and p_to and (t.from_dept = any(s) or t.to_dept = any(s))),
       'inc_opened', (select count(*) from am_incident where reported_at between p_from and p_to and dept_code = any(s)),
       'inc_closed', (select count(*) from am_incident where status = 'closed' and closed_at::date between p_from and p_to and dept_code = any(s)),
       'repair_cost', (select coalesce(sum(cost), 0) from am_incident where status = 'closed' and closed_at::date between p_from and p_to and dept_code = any(s)),
       'counts', (select count(*) from am_count where status = 'closed' and closed_at::date between p_from and p_to)),
    'pending', jsonb_build_object(
       'temp_old', (select count(*) from live where fin_status is null and not is_legacy and created_at < p_to - 90),
       'repair', (select count(*) from live where status_code in ('3', '5', '6', '25')),
       'beyond', (select count(*) from live where status_code = '4'),
       'awaiting', (select count(*) from live where status_code in ('8', '24')),
       'inc_open', (select count(*) from am_incident where status in ('open', 'in_progress') and dept_code = any(s)),
       'tf_open', (select count(*) from am_transfer where status = 'pending' and (from_dept = any(s) or to_dept = any(s))),
       'warranty_30', (select count(*) from live where warranty_until between p_to and p_to + 30)),
    'counts', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'title', title, 'depts', depts, 'date', count_date, 'summary', summary)
                                         order by closed_at desc), '[]'::jsonb)
               from (select * from am_count where status = 'closed' and depts && s order by closed_at desc limit 12) q))
  into v;
  return v;
end $$;

create or replace function am_report_snap_save(p_period text, p_from date, p_to date)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform app_require('assets', 'edit');
  if coalesce(trim(p_period), '') = '' then raise exception 'Ghi tên kỳ (vd 2026-09).'; end if;
  insert into am_report_snap (period, p_from, p_to, data, created_name)
  values (trim(p_period), p_from, p_to, am_report(p_from, p_to), am_me_name())
  on conflict (period) do update set p_from = excluded.p_from, p_to = excluded.p_to, data = excluded.data,
                                     created_by = auth.uid(), created_name = excluded.created_name, created_at = now()
  returning id into v_id;
  return v_id;
end $$;


-- =====================================================================
-- 7. DÒNG ĐỜI MỘT TÀI SẢN
-- =====================================================================

create or replace function am_asset_history(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a am_asset; v jsonb;
begin
  perform app_require('assets', 'view');
  select * into a from am_asset where id = p_id;
  if not found then raise exception 'Không có tài sản %.', p_id; end if;
  if not am_in_scope(a.dept_code) then raise exception 'Tài sản nằm ngoài phạm vi của bạn.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(e order by e ->> 'at' desc), '[]'::jsonb) into v from (
    -- Nhật ký thay đổi (app_audit): tạo, và các cột có ý nghĩa với dòng đời.
    select jsonb_build_object('at', au.at, 'kind', case au.op when 'INSERT' then 'created' else 'change' end, 'who', au.email,
             'data', case au.op when 'INSERT' then jsonb_build_object('asset_code', au.new_data ->> 'asset_code', 'dept_code', au.new_data ->> 'dept_code',
                                                                      'location_code', au.new_data ->> 'location_code', 'status_code', au.new_data ->> 'status_code')
                          else (select jsonb_object_agg(k, jsonb_build_object('o', au.old_data -> k, 'n', au.new_data -> k))
                                from jsonb_object_keys(au.new_data) k
                                where k in ('status_code', 'dept_code', 'location_code', 'asset_code', 'qty', 'unit_price', 'label_printed',
                                            'fin_status', 'fin_cost', 'warranty_until', 'name_vi')) end) e
    from app_audit au where au.tbl = 'am_asset' and au.pk = p_id::text
      and (au.op = 'INSERT' or exists (select 1 from jsonb_object_keys(au.new_data) k
                                       where k in ('status_code', 'dept_code', 'location_code', 'asset_code', 'qty', 'unit_price', 'label_printed',
                                                   'fin_status', 'fin_cost', 'warranty_until', 'name_vi')))
    union all
    select jsonb_build_object('at', s.created_at, 'kind', 'intake', 'data', jsonb_build_object('shipment', s.id, 'project_code', to_jsonb(s) ->> 'project_code',
             'po', to_jsonb(s) ->> 'po_doc_no', 'supplier', to_jsonb(s) ->> 'supplier'))
    from am_shipment s where s.id = a.shipment_id
    union all
    select jsonb_build_object('at', r.created_at, 'kind', 'label',
             'data', jsonb_build_object('no', r.code))
    from am_alr_line l join am_alr r on r.id = l.alr_id where l.asset_id = p_id
    union all
    select jsonb_build_object('at', p.taken_at, 'kind', 'photo', 'who', p.taken_name, 'data', jsonb_build_object('photo_kind', p.kind))
    from am_asset_photo p where p.asset_id = p_id
    union all
    select jsonb_build_object('at', coalesce(t.done_at, t.submitted_at, t.created_at), 'kind', 'transfer', 'who', t.created_name,
             'data', jsonb_build_object('id', t.id, 'no', t.no, 'status', t.status, 'from', t.from_dept, 'to', t.to_dept, 'loc', t.to_location,
                                        'old_code', tl.old_code, 'new_code', tl.new_code, 'qty', tl.qty))
    from am_transfer_line tl join am_transfer t on t.id = tl.transfer_id where (tl.asset_id = p_id or tl.new_asset_id = p_id) and t.status <> 'cancelled'
    union all
    select jsonb_build_object('at', i.created_at, 'kind', 'incident', 'who', i.created_name,
             'data', jsonb_build_object('id', i.id, 'no', i.no, 'type', i.kind, 'status', i.status, 'outcome', i.outcome, 'cost', i.cost, 'text', i.description))
    from am_incident i where i.asset_id = p_id
    union all
    select jsonb_build_object('at', coalesce(cl.at, c.closed_at, c.opened_at), 'kind', 'count', 'who', cl.by_name,
             'data', jsonb_build_object('code', c.code, 'found', cl.found, 'qty', cl.qty_found, 'loc', cl.loc_found, 'cond', cl.cond, 'note', cl.note))
    from am_count_line cl join am_count c on c.id = cl.count_id where cl.asset_id = p_id and c.status <> 'cancelled' and cl.found is not null
    union all
    select jsonb_build_object('at', q.approved_at, 'kind', 'liquidation',
             'data', jsonb_build_object('status', q.status, 'lr', d.doc_no, 'batch', b.code, 'outcome', q.outcome, 'buyer', q.buyer, 'price', q.sale_value))
    from pm_lq_item q left join pm_doc d on d.id = q.lr_doc_id left join pm_lq_batch b on b.id = q.batch_id where q.asset_id = p_id
    union all
    select jsonb_build_object('at', ln.first_seen::date, 'kind', 'accounting',
             'data', jsonb_build_object('line', ln.description, 'cost', ln.cost, 'share', k.share, 'kind_acc', ln.kind, 'status', ln.status))
    from am_acc_link k join am_acc_line ln on ln.id = k.line_id where k.asset_id = p_id
  ) q;
  return jsonb_build_object('asset', to_jsonb(a), 'events', v,
    'incidents', (select coalesce(jsonb_agg(to_jsonb(i) order by i.id desc), '[]'::jsonb) from am_incident i where i.asset_id = p_id),
    'transfers', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'no', t.no, 'status', t.status, 'from', t.from_dept, 'to', t.to_dept) order by t.id desc), '[]'::jsonb)
                  from am_transfer t where exists (select 1 from am_transfer_line tl where tl.transfer_id = t.id and (tl.asset_id = p_id or tl.new_asset_id = p_id))));
end $$;


-- =====================================================================
-- 8. QUYỀN
-- =====================================================================

alter table am_transfer      enable row level security;
alter table am_transfer_line enable row level security;
alter table am_incident      enable row level security;
alter table am_count         enable row level security;
alter table am_count_line    enable row level security;
alter table am_report_snap   enable row level security;

revoke all on am_transfer, am_transfer_line, am_incident, am_count, am_count_line, am_report_snap from anon, authenticated;
grant select on am_transfer, am_transfer_line, am_incident, am_count, am_count_line, am_report_snap to authenticated;

drop policy if exists am_transfer_read on am_transfer;
create policy am_transfer_read on am_transfer for select to authenticated
  using ((select app_can('assets', 'view')) and (am_in_scope(from_dept) or am_in_scope(to_dept) or created_by = auth.uid()));
drop policy if exists am_transfer_line_read on am_transfer_line;
create policy am_transfer_line_read on am_transfer_line for select to authenticated
  using (exists (select 1 from am_transfer t where t.id = transfer_id));
drop policy if exists am_incident_read on am_incident;
create policy am_incident_read on am_incident for select to authenticated
  using ((select app_can('assets', 'view')) and (am_in_scope(dept_code) or created_by = auth.uid()));
drop policy if exists am_count_read on am_count;
create policy am_count_read on am_count for select to authenticated
  using ((select app_can('assets', 'view')) and (depts && array(select app_scope_orgs()) or am_count_can(id)));
drop policy if exists am_count_line_read on am_count_line;
create policy am_count_line_read on am_count_line for select to authenticated
  using (exists (select 1 from am_count c where c.id = count_id));
drop policy if exists am_report_snap_read on am_report_snap;
create policy am_report_snap_read on am_report_snap for select to authenticated
  using ((select app_can('assets', 'view')));

-- Nhật ký thay đổi cho các bảng mới.
do $$
declare t text;
begin
  foreach t in array array['am_transfer', 'am_transfer_line', 'am_incident', 'am_count', 'am_report_snap'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke execute on function
  am_me_name(), am_in_scope(text), am_company_of(text), am_actors(jsonb, text), am_is_actor(jsonb, text),
  am_notify(uuid[], text, text, text, text, text), am_alive(text), am_tf_steps(text, text), am_tf_apply(bigint),
  am_count_can(bigint),
  am_tf_save(bigint, jsonb), am_tf_submit(bigint), am_tf_act(bigint, text, text), am_tf_cancel(bigint, text), am_tf_inbox(),
  am_inc_report(jsonb), am_inc_update(bigint, jsonb), am_inc_close(bigint, text, text, numeric), am_inc_cancel(bigint, text),
  am_count_save(bigint, jsonb), am_count_open(bigint), am_count_scan(bigint, text, text),
  am_count_mark(bigint, boolean, numeric, text, text, text), am_count_close(bigint, jsonb), am_count_cancel(bigint),
  am_report(date, date), am_report_snap_save(text, date, date), am_asset_history(bigint)
  from public, anon;
grant execute on function
  am_tf_save(bigint, jsonb), am_tf_submit(bigint), am_tf_act(bigint, text, text), am_tf_cancel(bigint, text), am_tf_inbox(),
  am_inc_report(jsonb), am_inc_update(bigint, jsonb), am_inc_close(bigint, text, text, numeric), am_inc_cancel(bigint, text),
  am_count_save(bigint, jsonb), am_count_open(bigint), am_count_scan(bigint, text, text),
  am_count_mark(bigint, boolean, numeric, text, text, text), am_count_close(bigint, jsonb), am_count_cancel(bigint),
  am_report(date, date), am_report_snap_save(text, date, date), am_asset_history(bigint),
  -- dùng trong policy đọc (chạy bằng quyền người đọc):
  am_in_scope(text), am_count_can(bigint)
  to authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 9. KIỂM CHỨNG
-- =====================================================================

select 'Bảng quản lý tài sản có RLS' as "Mục", count(*)::text as "Thực tế", '6' as "Mong đợi",
       case when count(*) = 6 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('am_transfer', 'am_transfer_line', 'am_incident', 'am_count', 'am_count_line', 'am_report_snap') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng các bảng mới (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name in ('am_transfer', 'am_transfer_line', 'am_incident', 'am_count', 'am_count_line', 'am_report_snap')
  and  privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Hàm điều chuyển / sự cố / kiểm kê / báo cáo / dòng đời', count(*)::text, '18', case when count(*) = 18 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('am_tf_save', 'am_tf_submit', 'am_tf_act', 'am_tf_cancel', 'am_tf_inbox', 'am_inc_report', 'am_inc_update',
                                 'am_inc_close', 'am_inc_cancel', 'am_count_save', 'am_count_open', 'am_count_scan', 'am_count_mark',
                                 'am_count_close', 'am_count_cancel', 'am_report', 'am_report_snap_save', 'am_asset_history')
union all
select 'Cột hạn bảo hành', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   information_schema.columns where table_name = 'am_asset' and column_name = 'warranty_until';
