-- =====================================================================
-- 33_meetings.sql — BIÊN BẢN HỌP DỰ ÁN CAPEX (26/09/2026)
--
-- Chạy SAU 32_price_db.sql (dùng pm_project của 18, pm_notice của 20,
-- am_notify() của 31). Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Họp định kỳ hai tuần một lần giữa Chủ đầu tư (nhóm QLTS / JVC) và Operator
-- về các dự án Capex. Thay file "Meeting Recap - CAPEX Tracker": ghi theo DỰ ÁN
-- (chủ đề) xuyên suốt các cuộc họp, để tra lại bất cứ lúc nào.
--
--   pm_mt_topic     CHỦ ĐỀ: một dự án (gắn mã pm_project nếu có) hoặc một chủ
--                   đề tự do ("CAPEX 2026", "Quy trình thẩm định"…). Đang theo
--                   dõi (open) thì tự vào chương trình họp kế tiếp.
--   pm_mt_meeting   CUỘC HỌP: ngày, địa điểm, thành phần (người dùng app hoặc
--                   tên tự do, bên Chủ đầu tư / Operator), nháp → đã phát hành.
--   pm_mt_entry     NỘI DUNG một chủ đề trong một cuộc họp: hạng mục / giai
--                   đoạn, tiến độ, thảo luận, KẾT LUẬN / CHỈ ĐẠO (ô riêng để tìm
--                   lại quyết định), ghi chú.
--   pm_mt_action    VIỆC CẦN LÀM: nội dung, người phụ trách (người dùng app
--                   và/hoặc tên tự do), hạn (ngày hoặc chữ "8/2024 - 9/2024"),
--                   mở → xong / bỏ. Việc còn mở tự theo sang các cuộc họp sau
--                   đến khi đóng; đóng ở cuộc họp nào thì ghi lại cuộc họp đó.
--                   Việc nhập từ file cũ: "historical" (đã đóng — lịch sử).
--
-- Song ngữ (quyết định 26/09/2026): gõ MỘT ngôn ngữ, app soạn prompt để Claude
-- dịch, dán kết quả JSON về → lưu cả hai (cột _vi / _en). Không dùng Claude API.
--
-- Quyền (quyết định 26/09/2026): khu "meeting". Mọi vai trò XEM (Operator:
-- Hotel GM, DOE, ENG, IT… đọc biên bản); nhóm QLTS ghi (C/E). Người phụ trách
-- một việc tự đánh dấu xong / mở lại việc của mình (mt_action_set).
-- Phát hành biên bản: thông báo trong app (chuông) cho người dự họp và người
-- phụ trách; PDF song ngữ tải về / gửi e-mail từ máy người dùng.
--
-- Mọi bảng chỉ ghi qua hàm (không cấp insert/update/delete cho trình duyệt).
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. KHU QUYỀN
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('meeting', 'Project meetings', 'Họp dự án', 87)
on conflict (code) do update set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

-- Mọi vai trò xem; QLTS ghi. "do nothing": ô đã chỉnh ở màn Phân quyền giữ nguyên.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select r.code, 'meeting', true,
       r.code in ('AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       r.code in ('AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       false,
       r.code in ('AM_COORD', 'SYS_ADMIN')
from   app_role r
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 2. BẢNG
-- =====================================================================

create table if not exists pm_mt_topic (
  id           bigserial primary key,
  title_vi     text not null,
  title_en     text,
  project_code text references pm_project(code) on update cascade on delete set null,
  status       text not null default 'open' check (status in ('open', 'closed')),
  sort         int  not null default 0,
  note         text,
  source       text not null default 'app' check (source in ('app', 'import')),
  created_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pm_mt_topic_project_idx on pm_mt_topic (project_code);
comment on table pm_mt_topic is
  'Chủ đề họp: một dự án Capex (project_code) hoặc chủ đề tự do. open = tự vào chương trình họp kế tiếp.';

create table if not exists pm_mt_meeting (
  id           bigserial primary key,
  no           text not null unique,
  meeting_date date not null,
  title_vi     text,
  title_en     text,
  place        text,
  -- [{user_id, name, side: owner|operator|other, position}]
  attendees    jsonb not null default '[]'::jsonb,
  status       text not null default 'draft' check (status in ('draft', 'issued')),
  issued_at    timestamptz,
  issued_name  text,
  file_url     text,
  note         text,
  source       text not null default 'app' check (source in ('app', 'import')),
  created_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pm_mt_meeting_date_idx on pm_mt_meeting (meeting_date desc);

create table if not exists pm_mt_entry (
  id            bigserial primary key,
  meeting_id    bigint not null references pm_mt_meeting(id) on delete cascade,
  topic_id      bigint not null references pm_mt_topic(id) on delete cascade,
  stage_vi      text, stage_en      text,
  progress_vi   text, progress_en   text,
  discussion_vi text, discussion_en text,
  decision_vi   text, decision_en   text,
  note_vi       text, note_en       text,
  sort          int  not null default 0,
  updated_name  text,
  updated_at    timestamptz not null default now()
);
create index if not exists pm_mt_entry_meeting_idx on pm_mt_entry (meeting_id);
create index if not exists pm_mt_entry_topic_idx on pm_mt_entry (topic_id);

create table if not exists pm_mt_action (
  id                bigserial primary key,
  meeting_id        bigint not null references pm_mt_meeting(id) on delete cascade,
  topic_id          bigint not null references pm_mt_topic(id) on delete cascade,
  entry_id          bigint references pm_mt_entry(id) on delete set null,
  text_vi           text,
  text_en           text,
  pic_user          uuid references app_user(id) on delete set null,
  pic_name          text,
  due_date          date,
  due_text          text,
  status            text not null default 'open' check (status in ('open', 'done', 'dropped', 'historical')),
  done_at           timestamptz,
  done_name         text,
  done_note         text,
  closed_meeting_id bigint references pm_mt_meeting(id) on delete set null,
  sort              int  not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists pm_mt_action_meeting_idx on pm_mt_action (meeting_id);
create index if not exists pm_mt_action_topic_idx on pm_mt_action (topic_id);
create index if not exists pm_mt_action_pic_idx on pm_mt_action (pic_user, status);
comment on column pm_mt_action.status is
  'open = còn phải làm (theo sang các cuộc họp sau); done / dropped = đã đóng; historical = nhập từ file cũ, coi như đã đóng.';


-- =====================================================================
-- 3. HÀM
-- =====================================================================

create or replace function mt_need(p_action text)
returns void language plpgsql stable security definer set search_path = public as $$
begin perform app_require('meeting', p_action); end $$;

-- Người dùng app để chọn người dự họp / người phụ trách (nhóm QLTS không có quyền đọc app_user).
create or replace function mt_people()
returns table (id uuid, name text, email text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform mt_need('create');
  return query select u.id, coalesce(nullif(trim(u.full_name), ''), u.email), u.email
               from app_user u where u.active order by 2;
end $$;

-- Số cuộc họp MT-YYMMDD (như tên sheet của file cũ); hai cuộc cùng ngày: -2, -3…
create or replace function mt_next_no(p_date date)
returns text language plpgsql stable security definer set search_path = public as $$
declare base text := 'MT-' || to_char(p_date, 'YYMMDD'); v text := base; n int := 1;
begin
  while exists (select 1 from pm_mt_meeting where no = v) loop n := n + 1; v := base || '-' || n; end loop;
  return v;
end $$;

create or replace function mt_save_topic(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p ->> 'id', '')::bigint;
begin
  perform mt_need('create');
  if coalesce(trim(p ->> 'title_vi'), '') = '' and coalesce(trim(p ->> 'title_en'), '') = '' then
    raise exception 'Chủ đề cần có tên. / A topic needs a title.';
  end if;
  if v_id is null then
    insert into pm_mt_topic (title_vi, created_name, sort)
    values ('-', pm_user_name(auth.uid()), coalesce((select max(sort) from pm_mt_topic), 0) + 10) returning id into v_id;
  end if;
  update pm_mt_topic set
    title_vi = coalesce(nullif(trim(p ->> 'title_vi'), ''), trim(p ->> 'title_en')),
    title_en = nullif(trim(p ->> 'title_en'), ''),
    project_code = nullif(p ->> 'project_code', ''),
    status = coalesce(nullif(p ->> 'status', ''), status),
    sort = coalesce(nullif(p ->> 'sort', '')::int, sort),
    note = p ->> 'note', updated_at = now()
  where id = v_id;
  if not found then raise exception 'Không thấy chủ đề %.', v_id; end if;
  return v_id;
end $$;

create or replace function mt_save_meeting(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p ->> 'id', '')::bigint; v_date date := nullif(p ->> 'meeting_date', '')::date;
begin
  perform mt_need('create');
  if v_id is null then
    if v_date is null then raise exception 'Cần ngày họp. / The meeting date is required.'; end if;
    insert into pm_mt_meeting (no, meeting_date, created_name) values (mt_next_no(v_date), v_date, pm_user_name(auth.uid()))
    returning id into v_id;
  end if;
  update pm_mt_meeting set
    meeting_date = coalesce(v_date, meeting_date),
    title_vi = p ->> 'title_vi', title_en = p ->> 'title_en', place = p ->> 'place',
    attendees = coalesce(p -> 'attendees', attendees),
    file_url = nullif(trim(p ->> 'file_url'), ''), note = p ->> 'note', updated_at = now()
  where id = v_id;
  if not found then raise exception 'Không thấy cuộc họp %.', v_id; end if;
  return v_id;
end $$;

-- Xoá: nháp thì người ghi xoá được; đã phát hành thì chỉ quản trị khu họp.
create or replace function mt_delete_meeting(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_need('edit');
  if exists (select 1 from pm_mt_meeting where id = p_id and status = 'issued') then perform mt_need('admin'); end if;
  delete from pm_mt_meeting where id = p_id;
end $$;

create or replace function mt_save_entry(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p ->> 'id', '')::bigint; v_m bigint := nullif(p ->> 'meeting_id', '')::bigint;
        v_t bigint := nullif(p ->> 'topic_id', '')::bigint;
begin
  perform mt_need('create');
  if v_id is null then
    if v_m is null or v_t is null then raise exception 'Cần cuộc họp và chủ đề.'; end if;
    insert into pm_mt_entry (meeting_id, topic_id, sort)
    values (v_m, v_t, coalesce((select max(sort) from pm_mt_entry where meeting_id = v_m), 0) + 10) returning id into v_id;
  end if;
  update pm_mt_entry set
    stage_vi = p ->> 'stage_vi', stage_en = p ->> 'stage_en',
    progress_vi = p ->> 'progress_vi', progress_en = p ->> 'progress_en',
    discussion_vi = p ->> 'discussion_vi', discussion_en = p ->> 'discussion_en',
    decision_vi = p ->> 'decision_vi', decision_en = p ->> 'decision_en',
    note_vi = p ->> 'note_vi', note_en = p ->> 'note_en',
    updated_name = pm_user_name(auth.uid()), updated_at = now()
  where id = v_id;
  if not found then raise exception 'Không thấy nội dung %.', v_id; end if;
  return v_id;
end $$;

create or replace function mt_delete_entry(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_need('edit');
  delete from pm_mt_action where entry_id = p_id and status = 'open';
  delete from pm_mt_entry where id = p_id;
end $$;

-- Việc cần làm. Giao cho người dùng app trên biên bản đã phát hành → báo ngay cho người đó.
create or replace function mt_save_action(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p ->> 'id', '')::bigint; v_old uuid; v_pic uuid := nullif(p ->> 'pic_user', '')::uuid;
        m pm_mt_meeting;
begin
  perform mt_need('create');
  if v_id is null then
    insert into pm_mt_action (meeting_id, topic_id, entry_id, sort)
    values ((p ->> 'meeting_id')::bigint, (p ->> 'topic_id')::bigint, nullif(p ->> 'entry_id', '')::bigint,
            coalesce((select max(sort) from pm_mt_action where meeting_id = (p ->> 'meeting_id')::bigint), 0) + 10)
    returning id into v_id;
  else
    select pic_user into v_old from pm_mt_action where id = v_id;
  end if;
  update pm_mt_action set
    text_vi = p ->> 'text_vi', text_en = p ->> 'text_en',
    pic_user = v_pic,
    pic_name = coalesce(nullif(trim(p ->> 'pic_name'), ''), pm_user_name(v_pic)),
    due_date = nullif(p ->> 'due_date', '')::date, due_text = nullif(trim(p ->> 'due_text'), ''),
    updated_at = now()
  where id = v_id;
  if not found then raise exception 'Không thấy việc %.', v_id; end if;
  select mm.* into m from pm_mt_meeting mm join pm_mt_action a on a.meeting_id = mm.id where a.id = v_id;
  if m.status = 'issued' and v_pic is not null and v_pic is distinct from v_old then
    perform am_notify(array[v_pic], 'todo', m.no, 'MA', null, left(coalesce(p ->> 'text_vi', p ->> 'text_en'), 200));
  end if;
  return v_id;
end $$;

create or replace function mt_delete_action(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin perform mt_need('edit'); delete from pm_mt_action where id = p_id; end $$;

-- Đóng / mở lại một việc: nhóm QLTS, hoặc chính người phụ trách.
create or replace function mt_action_set(p_id bigint, p_status text, p_note text default null, p_meeting bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare a pm_mt_action;
begin
  select * into a from pm_mt_action where id = p_id;
  if not found then raise exception 'Không thấy việc %.', p_id; end if;
  if not (app_can('meeting', 'edit') or (a.pic_user = auth.uid() and app_can('meeting', 'view'))) then
    raise exception 'Chỉ nhóm QLTS hoặc người phụ trách mới đổi được việc này. / Only the AM team or the person in charge can change this action.';
  end if;
  if p_status not in ('open', 'done', 'dropped') then raise exception 'Trạng thái không hợp lệ: %', p_status; end if;
  update pm_mt_action set
    status = p_status,
    done_at = case when p_status = 'open' then null else now() end,
    done_name = case when p_status = 'open' then null else pm_user_name(auth.uid()) end,
    done_note = case when p_status = 'open' then null else coalesce(p_note, done_note) end,
    closed_meeting_id = case when p_status = 'open' then null else p_meeting end,
    updated_at = now()
  where id = p_id;
end $$;

-- Phát hành biên bản: khoá trạng thái "đã phát hành", báo cho người dự họp (tài khoản app)
-- và người phụ trách các việc còn mở của cuộc họp.
create or replace function mt_issue(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare m pm_mt_meeting; v_att uuid[]; v_pic uuid[];
begin
  perform mt_need('edit');
  update pm_mt_meeting set status = 'issued', issued_at = now(), issued_name = pm_user_name(auth.uid()), updated_at = now()
  where id = p_id returning * into m;
  if not found then raise exception 'Không thấy cuộc họp %.', p_id; end if;
  select coalesce(array_agg(distinct (x ->> 'user_id')::uuid), '{}') into v_att
  from   jsonb_array_elements(m.attendees) x
  where  nullif(x ->> 'user_id', '') is not null and (x ->> 'user_id')::uuid is distinct from auth.uid();
  select coalesce(array_agg(distinct pic_user), '{}') into v_pic
  from   pm_mt_action where meeting_id = p_id and status = 'open' and pic_user is not null and pic_user is distinct from auth.uid();
  perform am_notify(v_att, 'todo', m.no, 'MT', null, coalesce(m.title_vi, m.title_en));
  perform am_notify(array(select unnest(v_pic) except select unnest(v_att)), 'todo', m.no, 'MA', null, null);
  return coalesce(array_length(v_att, 1), 0) + coalesce(array_length(array(select unnest(v_pic) except select unnest(v_att)), 1), 0);
end $$;

-- Đưa về nháp để sửa lớn (quản trị khu họp).
create or replace function mt_unissue(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform mt_need('admin');
  update pm_mt_meeting set status = 'draft', updated_at = now() where id = p_id;
end $$;

-- Bản dịch Claude trả về: [{t: topic|meeting|entry|action, id, f: cột, v: nội dung}] — chỉ các cột chữ song ngữ.
create or replace function mt_apply_text(p_items jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare x jsonb; n int := 0; v_tbl text; v_col text;
begin
  perform mt_need('create');
  for x in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_col := x ->> 'f';
    v_tbl := case x ->> 't' when 'topic' then 'pm_mt_topic' when 'meeting' then 'pm_mt_meeting'
                            when 'entry' then 'pm_mt_entry' when 'action' then 'pm_mt_action' end;
    if v_tbl is null then continue; end if;
    if not (   (v_tbl = 'pm_mt_topic'   and v_col in ('title_vi', 'title_en'))
            or (v_tbl = 'pm_mt_meeting' and v_col in ('title_vi', 'title_en'))
            or (v_tbl = 'pm_mt_entry'   and v_col in ('stage_vi', 'stage_en', 'progress_vi', 'progress_en', 'discussion_vi', 'discussion_en',
                                                      'decision_vi', 'decision_en', 'note_vi', 'note_en'))
            or (v_tbl = 'pm_mt_action'  and v_col in ('text_vi', 'text_en'))) then continue; end if;
    execute format('update %I set %I = $1, updated_at = now() where id = $2', v_tbl, v_col)
    using nullif(trim(x ->> 'v'), ''), (x ->> 'id')::bigint;
    n := n + 1;
  end loop;
  return n;
end $$;

-- File "Meeting Recap - CAPEX Tracker" cũ. Gọi nhiều lần (mỗi lần ≤ 150 dòng); lần đầu p_reset = true xoá
-- phần đã nhập trước (source = 'import') — nạp lại file vô hại. Mỗi phần tử p_rows = một dòng nội dung:
-- {date, topic_vi, topic_en, stage_vi, stage_en, progress_vi, progress_en, discussion_vi, discussion_en,
--  note_vi, note_en, due_date, due_text, pic, actions: [{vi, en}]}. Việc nhập vào: "historical".
create or replace function mt_import(p_rows jsonb, p_reset boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; a jsonb; v_m bigint; v_t bigint; v_e bigint; v_date date; nm int := 0; ne int := 0; na int := 0; v_name text := pm_user_name(auth.uid());
begin
  perform mt_need('admin');
  if p_reset then
    delete from pm_mt_meeting where source = 'import';
    delete from pm_mt_topic t where source = 'import' and not exists (select 1 from pm_mt_entry e where e.topic_id = t.id);
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_date := nullif(r ->> 'date', '')::date;
    if v_date is null or coalesce(trim(r ->> 'topic_vi'), trim(r ->> 'topic_en'), '') = '' then continue; end if;
    select id into v_m from pm_mt_meeting where meeting_date = v_date and source = 'import' order by id limit 1;
    if v_m is null then
      insert into pm_mt_meeting (no, meeting_date, title_vi, title_en, status, issued_at, issued_name, source, created_name)
      values (mt_next_no(v_date), v_date, 'Họp định kỳ dự án Capex', 'Capex projects progress meeting', 'issued', v_date, v_name, 'import', v_name)
      returning id into v_m;
      nm := nm + 1;
    end if;
    select id into v_t from pm_mt_topic
    where  am_norm(title_vi) = am_norm(coalesce(nullif(trim(r ->> 'topic_vi'), ''), trim(r ->> 'topic_en'))) order by id limit 1;
    if v_t is null then
      insert into pm_mt_topic (title_vi, title_en, sort, source, created_name)
      values (coalesce(nullif(trim(r ->> 'topic_vi'), ''), trim(r ->> 'topic_en')), nullif(trim(r ->> 'topic_en'), ''),
              coalesce(nullif(r ->> 'topic_sort', '')::int, (select coalesce(max(sort), 0) + 10 from pm_mt_topic)), 'import', v_name)
      returning id into v_t;
    end if;
    insert into pm_mt_entry (meeting_id, topic_id, stage_vi, stage_en, progress_vi, progress_en, discussion_vi, discussion_en,
                             note_vi, note_en, sort, updated_name)
    values (v_m, v_t, nullif(r ->> 'stage_vi', ''), nullif(r ->> 'stage_en', ''), nullif(r ->> 'progress_vi', ''), nullif(r ->> 'progress_en', ''),
            nullif(r ->> 'discussion_vi', ''), nullif(r ->> 'discussion_en', ''), nullif(r ->> 'note_vi', ''), nullif(r ->> 'note_en', ''),
            coalesce(nullif(r ->> 'sort', '')::int, 0), v_name)
    returning id into v_e;
    ne := ne + 1;
    for a in select * from jsonb_array_elements(coalesce(r -> 'actions', '[]'::jsonb)) loop
      insert into pm_mt_action (meeting_id, topic_id, entry_id, text_vi, text_en, pic_name, due_date, due_text, status, sort)
      values (v_m, v_t, v_e, nullif(a ->> 'vi', ''), nullif(a ->> 'en', ''), nullif(r ->> 'pic', ''),
              nullif(r ->> 'due_date', '')::date, nullif(r ->> 'due_text', ''), 'historical', na);
      na := na + 1;
    end loop;
  end loop;
  return jsonb_build_object('meetings', nm, 'entries', ne, 'actions', na);
end $$;


-- =====================================================================
-- 4. QUYỀN
-- =====================================================================

alter table pm_mt_topic   enable row level security;
alter table pm_mt_meeting enable row level security;
alter table pm_mt_entry   enable row level security;
alter table pm_mt_action  enable row level security;
revoke all on pm_mt_topic, pm_mt_meeting, pm_mt_entry, pm_mt_action from anon, authenticated;
grant select on pm_mt_topic, pm_mt_meeting, pm_mt_entry, pm_mt_action to authenticated;

drop policy if exists pm_mt_topic_read on pm_mt_topic;
create policy pm_mt_topic_read on pm_mt_topic for select to authenticated using ((select app_can('meeting', 'view')));
drop policy if exists pm_mt_meeting_read on pm_mt_meeting;
create policy pm_mt_meeting_read on pm_mt_meeting for select to authenticated using ((select app_can('meeting', 'view')));
drop policy if exists pm_mt_entry_read on pm_mt_entry;
create policy pm_mt_entry_read on pm_mt_entry for select to authenticated using ((select app_can('meeting', 'view')));
drop policy if exists pm_mt_action_read on pm_mt_action;
create policy pm_mt_action_read on pm_mt_action for select to authenticated using ((select app_can('meeting', 'view')));

do $$
declare t text;
begin
  foreach t in array array['pm_mt_topic', 'pm_mt_meeting', 'pm_mt_entry', 'pm_mt_action'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke execute on function mt_need(text), mt_people(), mt_next_no(date), mt_save_topic(jsonb), mt_save_meeting(jsonb), mt_delete_meeting(bigint),
  mt_save_entry(jsonb), mt_delete_entry(bigint), mt_save_action(jsonb), mt_delete_action(bigint), mt_action_set(bigint, text, text, bigint),
  mt_issue(bigint), mt_unissue(bigint), mt_apply_text(jsonb), mt_import(jsonb, boolean)
  from public, anon;
grant execute on function mt_people(), mt_save_topic(jsonb), mt_save_meeting(jsonb), mt_delete_meeting(bigint),
  mt_save_entry(jsonb), mt_delete_entry(bigint), mt_save_action(jsonb), mt_delete_action(bigint), mt_action_set(bigint, text, text, bigint),
  mt_issue(bigint), mt_unissue(bigint), mt_apply_text(jsonb), mt_import(jsonb, boolean)
  to authenticated;

select app_lock_anon();


-- =====================================================================
-- 5. KIỂM CHỨNG
-- =====================================================================

select 'Bảng họp dự án có RLS' as "Mục", count(*)::text as "Thực tế", '4' as "Mong đợi", case when count(*) = 4 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pm_mt_topic', 'pm_mt_meeting', 'pm_mt_entry', 'pm_mt_action') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng họp (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name like 'pm\_mt\_%' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Khu quyền "meeting"', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end from app_module where code = 'meeting'
union all
select 'Hàm họp dự án', count(*)::text, '13', case when count(*) = 13 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('mt_people', 'mt_save_topic', 'mt_save_meeting', 'mt_delete_meeting', 'mt_save_entry', 'mt_delete_entry',
                                 'mt_save_action', 'mt_delete_action', 'mt_action_set', 'mt_issue', 'mt_unissue', 'mt_apply_text', 'mt_import');
