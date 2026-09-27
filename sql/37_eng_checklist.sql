-- =====================================================================
-- 37_eng_checklist.sql — HỆ THỐNG KỸ THUẬT, CHECKLIST CA, ĐÁNH GIÁ HIỆN TRẠNG (27/09/2026)
--
-- Chạy SAU 36_demo_mode.sql (dùng am_asset, am_incident / am_inc_report của 31,
-- am_notify của 31). Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE trên live.
--
-- Quyết định của user (27/09/2026): làm checklist ngay trong app (Beetrack chưa
-- dùng); tầng "hệ thống" = danh mục ST01–ST20 của bộ phận Kỹ thuật (file
-- facility-eng-system.xlsx) — không dùng Uniformat; thí điểm đánh giá hiện trạng
-- với ST04 Chiller (khu phòng máy trung tâm).
--
--   am_sys         HỆ THỐNG: ST04 Chiller… gắn một TÀI SẢN CHA trên sổ
--                  (vd ENG.C2112.MES.1998.00017).
--   am_sys_item    HẠNG MỤC: ST04.01 Chiller 1, ST04.04 bơm CHWP-1… Có tài sản
--                  riêng thì gắn asset_id; FCU / đèn / đầu báo thì theo số lượng.
--                  Năm lắp, tuổi thọ thiết kế, mức quan trọng → tính tuổi / rủi ro.
--   am_chk         CHECKLIST (DCL0001…): một hệ thống, các ca Sáng / Chiều / Đêm.
--   am_chk_point   ĐIỂM KIỂM: trạng thái (Auto / On / Off / Battery…) và / hoặc
--                  tới 2 số đo (áp suất, nhiệt độ Set / Actual, mức nước…), đơn
--                  vị, ngưỡng min / max, trạng thái được coi là bình thường.
--   am_chk_run     MỘT LẦN KIỂM: checklist × ngày × ca (ca đêm tính theo ngày bắt
--                  đầu ca). Mở → hoàn tất; đếm số điểm bất thường.
--   am_chk_val     GIÁ TRỊ ghi được; ok tính ở server; bất thường có thể "báo sự
--                  cố" → am_incident trên tài sản (lịch sử bảo trì dùng chung).
--   am_cond        ĐÁNH GIÁ HIỆN TRẠNG một hạng mục (giữ lịch sử): điểm 1–5,
--                  tuổi thọ còn lại, hướng xử lý (theo dõi / sửa / đại tu / thay),
--                  năm dự kiến, chi phí ước tính, lý do → danh sách đề xuất đầu tư.
--
-- Quyền: khu "eng". Mọi vai trò XEM; ghi checklist (C) = nhân viên / trưởng bộ
-- phận (phạm vi phải bao phòng ban của hệ thống, mặc định ENG) + nhóm QLTS;
-- đánh giá hiện trạng (E) = trưởng bộ phận + QLTS; cấu hình / nạp danh mục (A) =
-- trưởng bộ phận + điều phối QLTS + quản trị.
--
-- Mọi bảng chỉ ghi qua hàm. Chỉ đụng vào bảng / hàm am_ / app_ của app này;
-- cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. KHU QUYỀN + CÀI ĐẶT
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('eng', 'Building systems & checklists', 'Hệ thống kỹ thuật & checklist', 45)
on conflict (code) do update set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select r.code, 'eng', true,
       r.code in ('DEPT_STAFF', 'DEPT_HEAD', 'AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       r.code in ('DEPT_HEAD', 'AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       false,
       r.code in ('DEPT_HEAD', 'AM_COORD', 'SYS_ADMIN')
from   app_role r
on conflict (role_code, module_code) do nothing;

insert into am_setting (key, value, note) values
  ('eng_shifts', '{"S": ["06:00", "14:00"], "C": ["14:00", "22:00"], "D": ["22:00", "06:00"]}'::jsonb,
   'Giờ các ca checklist: S = Sáng, C = Chiều, D = Đêm (ca đêm tính theo ngày bắt đầu ca)'),
  ('eng_backfill_days', '2'::jsonb, 'Nhân viên được ghi bù checklist trễ tối đa bao nhiêu ngày (trưởng bộ phận / QLTS không giới hạn)'),
  ('eng_notify_roles', '["DEPT_HEAD"]'::jsonb, 'Vai trò nhận thông báo khi một lần kiểm hoàn tất có điểm bất thường'),
  ('eng_pilot', '["ST04"]'::jsonb, 'Hệ thống thí điểm đánh giá hiện trạng (màn Hiện trạng mở sẵn các hệ thống này)'),
  ('eng_default_life', '20'::jsonb, 'Tuổi thọ thiết kế mặc định (năm) khi hạng mục chưa khai báo')
on conflict (key) do nothing;


-- =====================================================================
-- 2. BẢNG
-- =====================================================================

create table if not exists am_sys (
  code         text primary key,                      -- ST04
  name_en      text not null,
  name_vi      text,
  dept_code    text not null default 'ENG' references am_org(code) on update cascade,
  parent_code  text,                                  -- mã tài sản cha như trong file
  asset_id     bigint references am_asset(id) on delete set null,
  sort         int not null default 0,
  active       boolean not null default true,
  note         text
);
comment on table am_sys is 'Hệ thống kỹ thuật của toà nhà (danh mục ST của bộ phận Kỹ thuật), gắn tài sản cha trên sổ.';

create table if not exists am_sys_item (
  id           bigserial primary key,
  code         text not null unique,                  -- ST04.01
  sys_code     text not null references am_sys(code) on update cascade on delete cascade,
  name         text not null,
  location_code text,
  asset_id     bigint references am_asset(id) on delete set null,
  qty          numeric(12, 2) not null default 1,
  install_year int check (install_year between 1900 and 2100),
  life_years   int check (life_years between 1 and 100),
  criticality  smallint not null default 3 check (criticality between 1 and 5),
  sort         int not null default 0,
  active       boolean not null default true,
  note         text
);
create index if not exists am_sys_item_sys_idx on am_sys_item (sys_code);
comment on column am_sys_item.criticality is '1 = ít ảnh hưởng … 5 = dừng hoạt động khách sạn / an toàn tính mạng.';

create table if not exists am_chk (
  code         text primary key,                      -- DCL0002
  name         text not null,
  sys_code     text references am_sys(code) on update cascade on delete set null,
  dept_code    text not null default 'ENG' references am_org(code) on update cascade,
  shifts       text[] not null default '{S,C,D}',
  sort         int not null default 0,
  active       boolean not null default true,
  note         text
);

create table if not exists am_chk_point (
  id           bigserial primary key,
  chk_code     text not null references am_chk(code) on update cascade on delete cascade,
  seq          int not null default 0,
  task         text not null,
  location_code text,
  floor        text,
  item_id      bigint references am_sys_item(id) on delete set null,
  options      text[],                                -- trạng thái chọn: {Auto,On,Off,Battery}; null = chỉ có số đo
  ok_states    text[] not null default '{Auto,On}',   -- trạng thái coi là bình thường
  num_labels   text[],                                -- nhãn các số đo: {Kg/cm2} · {Set,Actual} · {Line 1,Line 2}; null = không đo
  unit         text,
  min_ok       numeric,
  max_ok       numeric,
  active       boolean not null default true,
  unique (chk_code, task)
);
create index if not exists am_chk_point_item_idx on am_chk_point (item_id);

create table if not exists am_chk_run (
  id           bigserial primary key,
  chk_code     text not null references am_chk(code) on update cascade on delete cascade,
  run_date     date not null,
  shift        text not null check (shift in ('S', 'C', 'D')),
  status       text not null default 'open' check (status in ('open', 'done')),
  abn          int not null default 0,                -- số điểm bất thường
  filled       int not null default 0,                -- số điểm đã ghi
  note         text,
  started_by   uuid default auth.uid(),
  started_name text,
  started_at   timestamptz not null default now(),
  done_name    text,
  done_at      timestamptz,
  unique (chk_code, run_date, shift)
);
create index if not exists am_chk_run_date_idx on am_chk_run (run_date desc);

create table if not exists am_chk_val (
  run_id       bigint not null references am_chk_run(id) on delete cascade,
  point_id     bigint not null references am_chk_point(id) on delete cascade,
  state        text,
  num1         numeric,
  num2         numeric,
  ok           boolean,
  note         text,
  incident_id  bigint references am_incident(id) on delete set null,
  by_name      text,
  at           timestamptz not null default now(),
  primary key (run_id, point_id)
);
create index if not exists am_chk_val_point_idx on am_chk_val (point_id);

create table if not exists am_cond (
  id              bigserial primary key,
  item_id         bigint not null references am_sys_item(id) on delete cascade,
  assessed_on     date not null default current_date,
  score           smallint not null check (score between 1 and 5),
  remaining_years numeric(5, 1),
  action          text not null default 'monitor' check (action in ('none', 'monitor', 'repair', 'overhaul', 'replace')),
  target_year     int check (target_year between 2000 and 2100),
  est_cost        numeric(18, 0),
  reason          text,
  created_by      uuid default auth.uid(),
  created_name    text,
  created_at      timestamptz not null default now()
);
create index if not exists am_cond_item_idx on am_cond (item_id, assessed_on desc, id desc);
comment on column am_cond.score is '5 = như mới · 4 = tốt · 3 = trung bình, còn dùng · 2 = kém, cần sửa lớn / lên kế hoạch thay · 1 = hỏng / nguy hiểm, thay ngay.';


-- =====================================================================
-- 3. HÀM
-- =====================================================================

create or replace function am_eng_need(p_action text, p_dept text default 'ENG')
returns void language plpgsql stable security definer set search_path = public as $$
begin
  perform app_require('eng', p_action);
  if not am_in_scope(coalesce(p_dept, 'ENG')) then
    raise exception 'Phòng ban % nằm ngoài phạm vi của bạn.', p_dept using errcode = '42501';
  end if;
end $$;

-- Một điểm kiểm có bình thường không (null = chưa ghi gì).
create or replace function am_chk_ok(p am_chk_point, p_state text, p_n1 numeric, p_n2 numeric)
returns boolean language sql immutable as $$
  select case when p_state is null and p_n1 is null and p_n2 is null then null
              else (p_state is null or p.options is null or p_state = any (p.ok_states))
               and (p_n1 is null or ((p.min_ok is null or p_n1 >= p.min_ok) and (p.max_ok is null or p_n1 <= p.max_ok)))
               and (p_n2 is null or ((p.min_ok is null or p_n2 >= p.min_ok) and (p.max_ok is null or p_n2 <= p.max_ok)))
         end
$$;

-- Mảng JSON → text[]; null / không phải mảng / mảng rỗng → null (app gửi "options": null cho điểm chỉ có số đo).
create or replace function am_jarr(j jsonb)
returns text[] language sql immutable as $$
  select case when jsonb_typeof(j) = 'array' and jsonb_array_length(j) > 0 then array(select jsonb_array_elements_text(j)) end
$$;

/* Nạp danh mục từ hai file của bộ phận Kỹ thuật (app đọc Excel, gửi JSON):
     p_sys    [{code, name_en, name_vi, parent_code, dept_code, sort}]
     p_items  [{code, sys_code, name, location_code, qty, sort}]
     p_chk    [{code, name, sys_code, shifts, sort}]
     p_points [{chk_code, seq, task, location_code, floor, item_code, options, ok_states, num_labels, unit}]
   Cập nhật theo mã; KHÔNG ghi đè năm lắp / tuổi thọ / mức quan trọng / ngưỡng
   min–max đã chỉnh trong app. */
create or replace function am_eng_import(p_sys jsonb, p_items jsonb, p_chk jsonb, p_points jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x jsonb; n_s int := 0; n_i int := 0; n_c int := 0; n_p int := 0; v_dept text;
begin
  perform am_eng_need('admin');
  for x in select * from jsonb_array_elements(coalesce(p_sys, '[]')) loop
    v_dept := coalesce(nullif(x ->> 'dept_code', ''), 'ENG');
    perform am_eng_need('admin', v_dept);
    insert into am_sys (code, name_en, name_vi, dept_code, parent_code, asset_id, sort)
    values (upper(trim(x ->> 'code')), trim(x ->> 'name_en'), nullif(trim(x ->> 'name_vi'), ''), v_dept, nullif(trim(x ->> 'parent_code'), ''),
            (select id from am_asset where asset_code = nullif(trim(x ->> 'parent_code'), '')), coalesce((x ->> 'sort')::int, 0))
    on conflict (code) do update set name_en = excluded.name_en, name_vi = coalesce(excluded.name_vi, am_sys.name_vi),
      parent_code = coalesce(excluded.parent_code, am_sys.parent_code),
      asset_id = case when excluded.parent_code is not null then excluded.asset_id else am_sys.asset_id end,   -- mã mới không có trên sổ: bỏ liên kết cũ
      sort = excluded.sort, active = true;
    n_s := n_s + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    insert into am_sys_item (code, sys_code, name, location_code, qty, sort)
    values (upper(trim(x ->> 'code')), upper(trim(x ->> 'sys_code')), trim(x ->> 'name'), nullif(trim(x ->> 'location_code'), ''),
            coalesce(nullif(x ->> 'qty', '')::numeric, 1), coalesce((x ->> 'sort')::int, 0))
    on conflict (code) do update set sys_code = excluded.sys_code, name = excluded.name,
      location_code = coalesce(excluded.location_code, am_sys_item.location_code), sort = excluded.sort, active = true;
    n_i := n_i + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_chk, '[]')) loop
    insert into am_chk (code, name, sys_code, shifts, sort)
    values (upper(trim(x ->> 'code')), trim(x ->> 'name'), nullif(upper(trim(x ->> 'sys_code')), ''),
            coalesce(am_jarr(x -> 'shifts'), '{S,C,D}'), coalesce((x ->> 'sort')::int, 0))
    on conflict (code) do update set name = excluded.name, sys_code = coalesce(excluded.sys_code, am_chk.sys_code),
      shifts = excluded.shifts, sort = excluded.sort, active = true;
    n_c := n_c + 1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p_points, '[]')) loop
    insert into am_chk_point (chk_code, seq, task, location_code, floor, item_id, options, ok_states, num_labels, unit)
    values (upper(trim(x ->> 'chk_code')), coalesce((x ->> 'seq')::int, 0), trim(x ->> 'task'), nullif(trim(x ->> 'location_code'), ''),
            nullif(trim(x ->> 'floor'), ''), (select id from am_sys_item where code = upper(trim(x ->> 'item_code'))),
            am_jarr(x -> 'options'),
            coalesce(am_jarr(x -> 'ok_states'), '{Auto,On}'),
            am_jarr(x -> 'num_labels'), nullif(trim(x ->> 'unit'), ''))
    on conflict (chk_code, task) do update set seq = excluded.seq, location_code = excluded.location_code, floor = excluded.floor,
      item_id = coalesce(excluded.item_id, am_chk_point.item_id), options = excluded.options,
      num_labels = excluded.num_labels, unit = coalesce(am_chk_point.unit, excluded.unit), active = true;
    n_p := n_p + 1;
  end loop;
  return jsonb_build_object('systems', n_s, 'items', n_i, 'checklists', n_c, 'points', n_p);
end $$;

-- Sửa một hệ thống: {code, name_en, name_vi, parent_code, dept_code, active, note} — gắn lại tài sản cha theo mã.
create or replace function am_eng_sys_save(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare s am_sys; v_asset bigint; v_code text := nullif(trim(p ->> 'parent_code'), '');
begin
  select * into s from am_sys where code = p ->> 'code';
  if s.code is null then raise exception 'Không có hệ thống %.', p ->> 'code'; end if;
  perform am_eng_need('admin', s.dept_code);
  perform am_eng_need('admin', coalesce(nullif(p ->> 'dept_code', ''), s.dept_code));
  if v_code is not null then
    select id into v_asset from am_asset where asset_code = v_code;
    if v_asset is null then raise exception 'Không có tài sản mã % trên sổ.', v_code; end if;
  end if;
  update am_sys set name_en = coalesce(nullif(trim(p ->> 'name_en'), ''), name_en), name_vi = nullif(trim(p ->> 'name_vi'), ''),
    parent_code = v_code, asset_id = v_asset, dept_code = coalesce(nullif(p ->> 'dept_code', ''), dept_code),
    active = coalesce((p ->> 'active')::boolean, active), note = nullif(trim(p ->> 'note'), '')
  where code = s.code;
end $$;

-- Sửa một hạng mục: {id, name, location_code, asset_code, qty, install_year, life_years, criticality, active, note}
create or replace function am_eng_item_save(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare i am_sys_item; v_asset bigint;
begin
  select * into i from am_sys_item where id = (p ->> 'id')::bigint;
  if i.id is null then raise exception 'Không có hạng mục.'; end if;
  perform am_eng_need('edit', (select dept_code from am_sys where code = i.sys_code));
  if nullif(trim(p ->> 'asset_code'), '') is not null then
    select id into v_asset from am_asset where asset_code = trim(p ->> 'asset_code');
    if v_asset is null then raise exception 'Không có tài sản mã %.', p ->> 'asset_code'; end if;
  end if;
  update am_sys_item set name = coalesce(nullif(trim(p ->> 'name'), ''), name), location_code = nullif(trim(p ->> 'location_code'), ''),
    asset_id = v_asset, qty = coalesce(nullif(p ->> 'qty', '')::numeric, 1), install_year = nullif(p ->> 'install_year', '')::int,
    life_years = nullif(p ->> 'life_years', '')::int, criticality = coalesce(nullif(p ->> 'criticality', '')::smallint, 3),
    active = coalesce((p ->> 'active')::boolean, true), note = nullif(trim(p ->> 'note'), '')
  where id = i.id;
end $$;

-- Cấu hình một điểm kiểm: {id, ok_states, unit, min_ok, max_ok, active, item_id}
create or replace function am_chk_point_save(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare pt am_chk_point;
begin
  select * into pt from am_chk_point where id = (p ->> 'id')::bigint;
  if pt.id is null then raise exception 'Không có điểm kiểm.'; end if;
  perform am_eng_need('admin', (select dept_code from am_chk where code = pt.chk_code));
  if nullif(p ->> 'min_ok', '')::numeric > nullif(p ->> 'max_ok', '')::numeric then raise exception 'Ngưỡng min lớn hơn max.'; end if;
  update am_chk_point set
    ok_states = case when jsonb_typeof(p -> 'ok_states') = 'array' then coalesce(am_jarr(p -> 'ok_states'), '{}') else ok_states end,
    unit = nullif(trim(p ->> 'unit'), ''), min_ok = nullif(p ->> 'min_ok', '')::numeric, max_ok = nullif(p ->> 'max_ok', '')::numeric,
    active = coalesce((p ->> 'active')::boolean, active),
    item_id = case when p ? 'item_id' then nullif(p ->> 'item_id', '')::bigint else item_id end
  where id = pt.id;
end $$;

/* Mở (hoặc lấy lại) lần kiểm của một checklist trong một ca. Nhân viên chỉ ghi
   bù trễ tối đa eng_backfill_days ngày; không ghi cho ngày tương lai. */
create or replace function am_chk_start(p_chk text, p_date date, p_shift text)
returns bigint language plpgsql security definer set search_path = public as $$
declare c am_chk; v_id bigint; v_back int;
begin
  select * into c from am_chk where code = p_chk;
  if c.code is null or not c.active then raise exception 'Không có checklist %.', p_chk; end if;
  perform am_eng_need('create', c.dept_code);
  if p_shift not in ('S', 'C', 'D') or not (p_shift = any (c.shifts)) then raise exception 'Checklist % không có ca %.', p_chk, p_shift; end if;
  if p_date > current_date then raise exception 'Không ghi checklist cho ngày tương lai.'; end if;
  select id into v_id from am_chk_run where chk_code = p_chk and run_date = p_date and shift = p_shift;
  if v_id is not null then return v_id; end if;
  v_back := coalesce((select (value #>> '{}')::int from am_setting where key = 'eng_backfill_days'), 2);
  if p_date < current_date - v_back and not app_can('eng', 'edit') then
    raise exception 'Chỉ được ghi bù trong % ngày. Nhờ trưởng bộ phận ghi bù.', v_back;
  end if;
  insert into am_chk_run (chk_code, run_date, shift, started_name) values (p_chk, p_date, p_shift, am_me_name()) returning id into v_id;
  return v_id;
end $$;

-- Ghi một điểm; trả ok (true / false / null nếu xoá trắng). Lần kiểm đã hoàn tất chỉ người có quyền E sửa.
create or replace function am_chk_set(p_run bigint, p_point bigint, p_state text, p_num1 numeric, p_num2 numeric, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare r am_chk_run; pt am_chk_point; v_ok boolean; v_state text := nullif(trim(p_state), ''); v_note text := nullif(trim(p_note), '');
begin
  select * into r from am_chk_run where id = p_run for update;
  if r.id is null then raise exception 'Không có lần kiểm.'; end if;
  perform am_eng_need('create', (select dept_code from am_chk where code = r.chk_code));
  if r.status = 'done' and not app_can('eng', 'edit') then raise exception 'Lần kiểm đã hoàn tất — nhờ trưởng bộ phận sửa.'; end if;
  select * into pt from am_chk_point where id = p_point and chk_code = r.chk_code;
  if pt.id is null then raise exception 'Điểm kiểm không thuộc checklist này.'; end if;
  if v_state is not null and pt.options is not null and not (v_state = any (pt.options)) then
    raise exception 'Trạng thái "%" không có trong % .', v_state, array_to_string(pt.options, ' / ');
  end if;
  v_ok := am_chk_ok(pt, v_state, p_num1, p_num2);
  if v_ok is null and v_note is null then
    delete from am_chk_val where run_id = p_run and point_id = p_point and incident_id is null;
  else
    insert into am_chk_val (run_id, point_id, state, num1, num2, ok, note, by_name, at)
    values (p_run, p_point, v_state, p_num1, p_num2, v_ok, v_note, am_me_name(), now())
    on conflict (run_id, point_id) do update set state = excluded.state, num1 = excluded.num1, num2 = excluded.num2,
      ok = excluded.ok, note = excluded.note, by_name = excluded.by_name, at = excluded.at;
  end if;
  update am_chk_run set abn = (select count(*) from am_chk_val v where v.run_id = p_run and v.ok = false),
                        filled = (select count(*) from am_chk_val v where v.run_id = p_run and v.ok is not null)
  where id = p_run;
  return v_ok;
end $$;

-- Hoàn tất; có điểm bất thường thì báo cho trưởng bộ phận (chuông).
create or replace function am_chk_done(p_run bigint, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r am_chk_run; c am_chk; v_txt text;
begin
  select * into r from am_chk_run where id = p_run for update;
  if r.id is null then raise exception 'Không có lần kiểm.'; end if;
  select * into c from am_chk where code = r.chk_code;
  perform am_eng_need('create', c.dept_code);
  update am_chk_run set status = 'done', done_at = now(), done_name = am_me_name(), note = coalesce(nullif(trim(p_note), ''), note)
  where id = p_run returning * into r;
  if r.abn > 0 then
    select string_agg(p.task || coalesce(': ' || v.state, '') || coalesce(' ' || v.num1::text, '') || coalesce('/' || v.num2::text, ''), '; ' order by p.seq)
    into v_txt from am_chk_val v join am_chk_point p on p.id = v.point_id where v.run_id = p_run and v.ok = false;
    perform am_notify(array(select am_actors(coalesce((select value from am_setting where key = 'eng_notify_roles'), '["DEPT_HEAD"]'), c.dept_code)),
                      'todo', r.chk_code || '/' || r.run_date || '/' || r.shift, 'CK', c.dept_code, left(v_txt, 500));
  end if;
  return jsonb_build_object('abn', r.abn, 'filled', r.filled,
    'points', (select count(*) from am_chk_point where chk_code = r.chk_code and active));
end $$;

-- Báo sự cố từ một điểm bất thường: tạo am_incident trên tài sản của hạng mục (hoặc tài sản cha của hệ thống).
create or replace function am_chk_incident(p_run bigint, p_point bigint, p_desc text)
returns bigint language plpgsql security definer set search_path = public as $$
declare r am_chk_run; pt am_chk_point; v_asset bigint; v_id bigint; v am_chk_val;
begin
  select * into r from am_chk_run where id = p_run;
  select * into pt from am_chk_point where id = p_point and chk_code = r.chk_code;
  if pt.id is null then raise exception 'Điểm kiểm không thuộc lần kiểm này.'; end if;
  perform am_eng_need('create', (select dept_code from am_chk where code = r.chk_code));
  select * into v from am_chk_val where run_id = p_run and point_id = p_point;
  if v.incident_id is not null then return v.incident_id; end if;
  select coalesce(i.asset_id, s.asset_id) into v_asset
  from am_chk c left join am_sys s on s.code = c.sys_code left join am_sys_item i on i.id = pt.item_id
  where c.code = r.chk_code;
  if v_asset is null then raise exception 'Hạng mục / hệ thống chưa gắn tài sản trên sổ — gắn mã tài sản cha ở màn Hệ thống trước.'; end if;
  -- Tài sản cha đang có sự cố sửa chữa chưa đóng (vd nhiều bơm cùng một hệ thống): gắn vào sự cố đó.
  select id into v_id from am_incident where asset_id = v_asset and kind = 'repair' and status in ('open', 'in_progress') order by id desc limit 1;
  if v_id is not null then
    update am_incident set description = left(concat_ws(E'\n', description, r.chk_code || ' ' || to_char(r.run_date, 'DD/MM/YYYY') || ' ca ' || r.shift
                                                    || ' — ' || pt.task || coalesce(' — ' || nullif(trim(p_desc), ''), '')), 4000)
    where id = v_id;
  else
  v_id := am_inc_report(jsonb_build_object('asset_id', v_asset, 'kind', 'repair',
            'description', left(concat_ws(' — ', r.chk_code || ' ' || to_char(r.run_date, 'DD/MM/YYYY') || ' ca ' || r.shift, pt.task,
                                          nullif(concat_ws(' ', v.state, v.num1::text, v.num2::text), ''), nullif(trim(p_desc), '')), 1000)));
  end if;
  insert into am_chk_val (run_id, point_id, incident_id, by_name) values (p_run, p_point, v_id, am_me_name())
  on conflict (run_id, point_id) do update set incident_id = excluded.incident_id;
  return v_id;
end $$;

-- Đánh giá hiện trạng: {item_id, assessed_on, score, remaining_years, action, target_year, est_cost, reason}
create or replace function am_cond_save(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare i am_sys_item; v_id bigint;
begin
  select * into i from am_sys_item where id = (p ->> 'item_id')::bigint;
  if i.id is null then raise exception 'Không có hạng mục.'; end if;
  perform am_eng_need('edit', (select dept_code from am_sys where code = i.sys_code));
  if coalesce(nullif(trim(p ->> 'reason'), ''), '') = '' and coalesce((p ->> 'score')::int, 5) <= 2 then
    raise exception 'Điểm 1–2 cần ghi lý do (hiện trạng, rủi ro) để làm căn cứ đề xuất.';
  end if;
  insert into am_cond (item_id, assessed_on, score, remaining_years, action, target_year, est_cost, reason, created_name)
  values (i.id, coalesce(nullif(p ->> 'assessed_on', '')::date, current_date), (p ->> 'score')::smallint,
          nullif(p ->> 'remaining_years', '')::numeric, coalesce(nullif(p ->> 'action', ''), 'monitor'),
          nullif(p ->> 'target_year', '')::int, nullif(p ->> 'est_cost', '')::numeric, nullif(trim(p ->> 'reason'), ''), am_me_name())
  returning id into v_id;
  return v_id;
end $$;

create or replace function am_cond_delete(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare c am_cond;
begin
  select * into c from am_cond where id = p_id;
  if c.id is null then return; end if;
  perform am_eng_need('edit', (select s.dept_code from am_sys_item i join am_sys s on s.code = i.sys_code where i.id = c.item_id));
  if c.created_by is distinct from auth.uid() and not app_can('eng', 'admin') then raise exception 'Chỉ người đánh giá hoặc quản trị được xoá.'; end if;
  delete from am_cond where id = p_id;
end $$;

-- Tổng hợp theo hạng mục cho màn Hệ thống / Hiện trạng: bất thường và sự cố trong kỳ.
create or replace function am_eng_stats(p_from date, p_to date)
returns table (item_id bigint, abn int, readings int, last_abn date, incidents int, open_incidents int)
language sql stable security definer set search_path = public as $$
  with vals as (
    select p.item_id, v.ok, r.run_date from am_chk_val v join am_chk_run r on r.id = v.run_id join am_chk_point p on p.id = v.point_id
    where r.run_date between p_from and p_to and p.item_id is not null and v.ok is not null),
  inc as (
    select i.id as item_id, count(distinct n.id) as n, count(distinct n.id) filter (where n.status in ('open', 'in_progress')) as open_n
    from (-- sự cố trên tài sản riêng của hạng mục + sự cố báo từ điểm kiểm của hạng mục
          select i.id, i.asset_id as inc_asset, null::bigint as inc_id from am_sys_item i where i.asset_id is not null
          union
          select p.item_id, null, v.incident_id from am_chk_val v join am_chk_point p on p.id = v.point_id
          where v.incident_id is not null and p.item_id is not null) i
    join am_incident n on (n.asset_id = i.inc_asset or n.id = i.inc_id) and n.reported_at between p_from and p_to
    group by i.id)
  select i.id, coalesce(count(v.*) filter (where v.ok = false), 0)::int, coalesce(count(v.*), 0)::int,
         max(v.run_date) filter (where v.ok = false), coalesce(max(inc.n), 0)::int, coalesce(max(inc.open_n), 0)::int
  from am_sys_item i left join vals v on v.item_id = i.id left join inc on inc.item_id = i.id
  where app_can('eng', 'view')
  group by i.id
$$;


-- =====================================================================
-- 4. QUYỀN
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array['am_sys', 'am_sys_item', 'am_chk', 'am_chk_point', 'am_chk_run', 'am_chk_val', 'am_cond'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using ((select app_can(''eng'', ''view'')))', t || '_read', t);
    if t <> 'am_chk_val' then   -- giá trị đo: nhiều, đã có dấu người ghi / lúc ghi
      execute format('drop trigger if exists app_audit on %I', t);
      execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
    end if;
  end loop;
end $$;

revoke execute on function am_eng_need(text, text), am_chk_ok(am_chk_point, text, numeric, numeric), am_jarr(jsonb),
  am_eng_import(jsonb, jsonb, jsonb, jsonb), am_eng_sys_save(jsonb), am_eng_item_save(jsonb), am_chk_point_save(jsonb),
  am_chk_start(text, date, text), am_chk_set(bigint, bigint, text, numeric, numeric, text), am_chk_done(bigint, text),
  am_chk_incident(bigint, bigint, text), am_cond_save(jsonb), am_cond_delete(bigint), am_eng_stats(date, date)
  from public, anon;
grant execute on function am_eng_import(jsonb, jsonb, jsonb, jsonb), am_eng_sys_save(jsonb), am_eng_item_save(jsonb), am_chk_point_save(jsonb),
  am_chk_start(text, date, text), am_chk_set(bigint, bigint, text, numeric, numeric, text), am_chk_done(bigint, text),
  am_chk_incident(bigint, bigint, text), am_cond_save(jsonb), am_cond_delete(bigint), am_eng_stats(date, date)
  to authenticated;

select app_lock_anon();


-- =====================================================================
-- 5. KIỂM CHỨNG
-- =====================================================================

select 'Bảng hệ thống / checklist có RLS' as "Mục", count(*)::text as "Thực tế", '7' as "Mong đợi", case when count(*) = 7 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('am_sys', 'am_sys_item', 'am_chk', 'am_chk_point', 'am_chk_run', 'am_chk_val', 'am_cond') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name in ('am_sys', 'am_sys_item', 'am_chk', 'am_chk_point', 'am_chk_run', 'am_chk_val', 'am_cond')
  and  privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Khu quyền "eng"', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end from app_module where code = 'eng'
union all
select 'Hàm hệ thống / checklist', count(*)::text, '11', case when count(*) = 11 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('am_eng_import', 'am_eng_sys_save', 'am_eng_item_save', 'am_chk_point_save', 'am_chk_start', 'am_chk_set', 'am_chk_done',
                                 'am_chk_incident', 'am_cond_save', 'am_cond_delete', 'am_eng_stats');
