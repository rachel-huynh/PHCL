-- =====================================================================
-- 28_liquidation_batch.sql — THANH LÝ TÀI SẢN, GIAI ĐOẠN 2: HỘI ĐỒNG VÀ ĐỢT
--                            THANH LÝ (26/09/2026)
--
-- Chạy SAU 27_liquidation.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
--   pm_lq_council  Quyết định thành lập Hội đồng thanh lý (vd L01/2026): số, ngày,
--                  link bản ký. Mỗi lúc một hội đồng ĐANG HIỆU LỰC; có QĐ mới thì
--                  thêm hội đồng mới — đợt cũ vẫn giữ hội đồng của nó.
--   pm_lq_member   Thành viên của từng hội đồng: họ tên, chức vụ (VN / EN), vai
--                  trò (chủ tịch / phó chủ tịch / thành viên thường trực hoặc
--                  không thường trực), tài khoản app (nếu có). Nhập trong app —
--                  tên người KHÔNG nằm trong file này (repo công khai).
--   pm_lq_batch    Đợt thanh lý L0x.yyyy: gom các món trong kho chờ thanh lý,
--                  đi qua các mốc
--                    open     đang lập danh sách, chuẩn bị họp
--                    decided  đã họp & ra Quyết định thanh lý (02, 03) — khoá danh sách
--                    counted  đã kiểm kê thực tế (04)
--                    valued   đã đánh giá lại giá trị còn lại (05) — sẵn sàng gọi báo giá
--                    bidding / closed  giai đoạn 3 (báo giá, mở thầu, kết quả, đóng đợt)
--   pm_lq_item     (27) thêm kết quả kiểm kê, giá trị đánh giá lại, ghi chú giữ lại.
--
-- Mọi thay đổi đợt và món đi qua hàm ở dưới (trình duyệt chỉ đọc hai bảng đó);
-- hội đồng / thành viên sửa thẳng trong app, quyền quản trị khu Thanh lý.
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_lq_council (
  id            bigserial primary key,
  decision_no   text not null unique,
  decision_date date,
  active        boolean not null default true,
  file_url      text check (file_url is null or file_url ~* '^https://'),
  note          text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);
create unique index if not exists pm_lq_council_one_active on pm_lq_council ((true)) where active;
comment on table pm_lq_council is 'Quyết định thành lập Hội đồng thanh lý. Chỉ một hội đồng đang hiệu lực (active).';

create table if not exists pm_lq_member (
  id          bigserial primary key,
  council_id  bigint not null references pm_lq_council(id) on delete cascade,
  sort        int  not null default 0,
  full_name   text not null,
  position_vi text,
  position_en text,
  role        text not null default 'member' check (role in ('chair', 'vice', 'member')),
  permanent   boolean not null default true,
  user_id     uuid references app_user(id) on delete set null
);
create index if not exists pm_lq_member_council_idx on pm_lq_member (council_id, sort);
comment on column pm_lq_member.permanent is 'Thành viên thường trực (true) hay không thường trực — tham gia theo chỉ định của chủ tịch hội đồng (false).';
comment on column pm_lq_member.user_id is 'Tài khoản app của thành viên (nếu có): để xác nhận có mặt / kiểm kê trên tablet.';

create table if not exists pm_lq_batch (
  id               bigserial primary key,
  code             text not null unique check (code ~ '^L\d{2,3}\.\d{4}$'),
  year             int  not null,
  council_id       bigint references pm_lq_council(id),
  status           text not null default 'open'
                   check (status in ('open', 'decided', 'counted', 'valued', 'bidding', 'closed', 'cancelled')),
  meeting_date     date,
  meeting_time     text,
  meeting_place    text,
  decision_date    date,
  count_date       date,
  valuation_date   date,
  liquidation_date date,
  data             jsonb not null default '{}'::jsonb,
  created_by       uuid default auth.uid(),
  created_name     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on column pm_lq_batch.data is
  'Nội dung biên bản họp: causes_vi / causes_en (nguyên nhân), plan_vi / plan_en (phương án), conclusion_vi / conclusion_en (kết luận thêm), note.';

alter table pm_lq_item add column if not exists count_found boolean;
alter table pm_lq_item add column if not exists count_qty   numeric(18, 3);
alter table pm_lq_item add column if not exists count_note  text;
alter table pm_lq_item add column if not exists count_by    uuid;
alter table pm_lq_item add column if not exists count_name  text;
alter table pm_lq_item add column if not exists count_at    timestamptz;
alter table pm_lq_item add column if not exists reval_value numeric(18, 2);
alter table pm_lq_item add column if not exists reval_note  text;
alter table pm_lq_item add column if not exists keep_note   text;
create index if not exists pm_lq_item_batch_idx on pm_lq_item (batch_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pm_lq_item_batch_fk') then
    alter table pm_lq_item add constraint pm_lq_item_batch_fk foreign key (batch_id) references pm_lq_batch(id) on delete set null;
  end if;
end $$;


-- =====================================================================
-- 2. HÀM
-- =====================================================================

create or replace function pm_lq_need_edit()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app_can('liquidation', 'edit') then
    raise exception 'Cần quyền sửa của khu Thanh lý. / Liquidation "edit" right required.' using errcode = '42501';
  end if;
end $$;

/* Số đợt kế tiếp trong năm. Quyết định thành lập hội đồng cũng lấy một số trong
   dãy (QĐ L01.2026 → đợt đầu là L02.2026), nên đếm cả hai. */
create or replace function pm_lq_batch_next(p_year int)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'L' || lpad((coalesce(max(n), 0) + 1)::text, 2, '0') || '.' || p_year
  from (
    select split_part(substr(code, 2), '.', 1)::int as n from pm_lq_batch where year = p_year
    union all
    select (regexp_match(decision_no, '^L(\d{1,3})[./](\d{4})$'))[1]::int
    from   pm_lq_council where (regexp_match(decision_no, '^L(\d{1,3})[./](\d{4})$'))[2] = p_year::text
  ) x
$$;

create or replace function pm_lq_batch_create(p_code text default null, p_data jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_year int; v_code text; v_id bigint;
begin
  perform pm_lq_need_edit();
  v_year := coalesce(extract(year from nullif(p_data ->> 'meeting_date', '')::date)::int, extract(year from current_date)::int);
  perform pg_advisory_xact_lock(hashtext('pm_lq_batch.' || v_year));
  v_code := coalesce(nullif(trim(p_code), ''), pm_lq_batch_next(v_year));
  if v_code !~ '^L\d{2,3}\.\d{4}$' then raise exception 'Số đợt phải dạng L02.2026. / Batch number must look like L02.2026.'; end if;
  if exists (select 1 from pm_lq_batch where code = v_code) then raise exception 'Đợt % đã có. / Batch % exists.', v_code, v_code; end if;
  insert into pm_lq_batch (code, year, council_id, meeting_date, meeting_time, meeting_place, data, created_name)
  values (v_code, split_part(v_code, '.', 2)::int,
          coalesce(nullif(p_data ->> 'council_id', '')::bigint, (select id from pm_lq_council where active limit 1)),
          nullif(p_data ->> 'meeting_date', '')::date, nullif(p_data ->> 'meeting_time', ''), nullif(p_data ->> 'meeting_place', ''),
          coalesce(p_data -> 'data', '{}'::jsonb), coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
  returning id into v_id;
  return v_id;
end $$;

-- Thông tin đợt (họp, các ngày, nội dung biên bản). Số đợt chỉ đổi được khi còn lập danh sách.
create or replace function pm_lq_batch_save(p_id bigint, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if b.status in ('closed', 'cancelled') then raise exception 'Đợt % đã %. / Batch is %.', b.code, b.status, b.status; end if;
  if p_patch ? 'code' and p_patch ->> 'code' <> b.code then
    if b.status <> 'open' then raise exception 'Chỉ đổi số đợt khi còn lập danh sách.'; end if;
    if (p_patch ->> 'code') !~ '^L\d{2,3}\.\d{4}$' then raise exception 'Số đợt phải dạng L02.2026.'; end if;
    if exists (select 1 from pm_lq_batch where code = p_patch ->> 'code') then raise exception 'Đợt % đã có.', p_patch ->> 'code'; end if;
  end if;
  update pm_lq_batch set
    code             = case when p_patch ? 'code' then p_patch ->> 'code' else code end,
    year             = case when p_patch ? 'code' then split_part(p_patch ->> 'code', '.', 2)::int else year end,
    council_id       = case when p_patch ? 'council_id' then nullif(p_patch ->> 'council_id', '')::bigint else council_id end,
    meeting_date     = case when p_patch ? 'meeting_date' then nullif(p_patch ->> 'meeting_date', '')::date else meeting_date end,
    meeting_time     = case when p_patch ? 'meeting_time' then nullif(p_patch ->> 'meeting_time', '') else meeting_time end,
    meeting_place    = case when p_patch ? 'meeting_place' then nullif(p_patch ->> 'meeting_place', '') else meeting_place end,
    decision_date    = case when p_patch ? 'decision_date' then nullif(p_patch ->> 'decision_date', '')::date else decision_date end,
    count_date       = case when p_patch ? 'count_date' then nullif(p_patch ->> 'count_date', '')::date else count_date end,
    valuation_date   = case when p_patch ? 'valuation_date' then nullif(p_patch ->> 'valuation_date', '')::date else valuation_date end,
    liquidation_date = case when p_patch ? 'liquidation_date' then nullif(p_patch ->> 'liquidation_date', '')::date else liquidation_date end,
    data             = case when p_patch ? 'data' then data || (p_patch -> 'data') else data end,
    updated_at       = now()
  where id = p_id;
end $$;

-- Thêm món từ kho (đang chờ, của LR đã duyệt) / trả món về kho. Chỉ khi đợt còn lập danh sách.
create or replace function pm_lq_batch_items(p_id bigint, p_add bigint[] default '{}', p_remove bigint[] default '{}')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; n int := 0; m int;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if b.status <> 'open' then raise exception 'Đợt % đã chốt danh sách. / The list of % is closed.', b.code, b.code; end if;
  update pm_lq_item i set batch_id = b.id, status = 'batched'
    from pm_doc d
   where d.id = i.lr_doc_id and d.status = 'approved'
     and i.id = any(coalesce(p_add, '{}')) and i.status = 'pool';
  get diagnostics n = row_count;
  update pm_lq_item set batch_id = null, status = 'pool', count_found = null, count_qty = null, count_note = null,
                        count_by = null, count_name = null, count_at = null, reval_value = null, reval_note = null, keep_note = null
   where batch_id = b.id and id = any(coalesce(p_remove, '{}')) and status in ('batched', 'kept');
  get diagnostics m = row_count;
  update pm_lq_batch set updated_at = now() where id = b.id;
  return n + m;
end $$;

/* Hội đồng GIỮ LẠI một món (không thanh lý) khi họp — ghi lý do. Món thôi thuộc
   danh sách của đợt; tình trạng tài sản trong sổ KHÔNG tự đổi (AM team đổi tay
   nếu cần). p_keep = false: đưa món lại vào danh sách. */
create or replace function pm_lq_keep(p_item bigint, p_keep boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null then raise exception 'Món chưa thuộc đợt nào.'; end if;
  if b.status <> 'open' then raise exception 'Đợt % đã chốt danh sách.', b.code; end if;
  if p_keep and coalesce(trim(p_note), '') = '' then raise exception 'Ghi lý do giữ lại. / Say why it is kept.'; end if;
  update pm_lq_item set status = case when p_keep then 'kept' else 'batched' end,
                        keep_note = case when p_keep then trim(p_note) end
   where id = p_item;
end $$;

-- Kiểm kê một món: có / không thấy, số lượng thực tế, ghi chú. Khi đợt đã ra QĐ (decided).
create or replace function pm_lq_count(p_item bigint, p_found boolean, p_qty numeric default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null or i.status <> 'batched' then raise exception 'Món không nằm trong danh sách của đợt nào.'; end if;
  if not (app_can('liquidation', 'edit')
          or exists (select 1 from pm_lq_member m where m.council_id = b.council_id and m.user_id = auth.uid())) then
    raise exception 'Chỉ AM team hoặc thành viên hội đồng mới kiểm kê được.' using errcode = '42501';
  end if;
  if b.status <> 'decided' then raise exception 'Kiểm kê khi đợt % đã ra Quyết định và chưa chốt kiểm kê. / Count after the decision.', b.code; end if;
  if p_found is null then
    update pm_lq_item set count_found = null, count_qty = null, count_note = null, count_by = null, count_name = null, count_at = null where id = p_item;
    return;
  end if;
  if p_qty is not null and p_qty < 0 then raise exception 'Số lượng không âm.'; end if;
  update pm_lq_item set count_found = p_found,
                        count_qty = case when p_found then coalesce(p_qty, qty) else 0 end,
                        count_note = nullif(trim(p_note), ''),
                        count_by = auth.uid(), count_name = coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), count_at = now()
   where id = p_item;
end $$;

-- Giá trị còn lại đánh giá lại (giá sàn khi gọi báo giá). Khi đã kiểm kê xong (counted).
create or replace function pm_lq_reval(p_item bigint, p_value numeric, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null or i.status <> 'batched' then raise exception 'Món không nằm trong danh sách của đợt nào.'; end if;
  if b.status <> 'counted' then raise exception 'Đánh giá lại khi đợt % đã kiểm kê xong và chưa chốt đánh giá. / Revalue after the count.', b.code; end if;
  if p_value is not null and p_value < 0 then raise exception 'Giá trị không âm.'; end if;
  update pm_lq_item set reval_value = p_value, reval_note = nullif(trim(p_note), '') where id = p_item;
end $$;

/* Chuyển mốc của đợt. Tiến:
     open → decided   có ít nhất một món, có hội đồng, có ngày họp
     decided → counted  mọi món đã kiểm kê (có / không thấy)
     counted → valued   mọi món có giá trị đánh giá lại
   Lùi một mốc để sửa (valued → counted → decided → open). Huỷ khi còn open:
   các món về kho. bidding / closed là của giai đoạn 3. */
create or replace function pm_lq_batch_move(p_id bigint, p_to text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_left int;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if not ((b.status, p_to) in (('open', 'decided'), ('decided', 'counted'), ('counted', 'valued'),
                               ('decided', 'open'), ('counted', 'decided'), ('valued', 'counted'), ('open', 'cancelled'))) then
    raise exception 'Không chuyển được đợt % từ "%" sang "%".', b.code, b.status, p_to;
  end if;
  if p_to = 'decided' and b.status = 'open' then
    if not exists (select 1 from pm_lq_item where batch_id = b.id and status = 'batched') then raise exception 'Đợt chưa có món nào.'; end if;
    if b.council_id is null then raise exception 'Chọn hội đồng cho đợt trước.'; end if;
    if b.meeting_date is null then raise exception 'Nhập ngày họp hội đồng trước.'; end if;
    update pm_lq_batch set decision_date = coalesce(decision_date, meeting_date) where id = b.id;
  elsif p_to = 'counted' and b.status = 'decided' then
    select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and count_found is null;
    if v_left > 0 then raise exception 'Còn % món chưa kiểm kê. / % item(s) not counted yet.', v_left, v_left; end if;
    update pm_lq_batch set count_date = coalesce(count_date, current_date) where id = b.id;
  elsif p_to = 'valued' then
    select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and reval_value is null;
    if v_left > 0 then raise exception 'Còn % món chưa có giá trị đánh giá lại. / % item(s) not revalued yet.', v_left, v_left; end if;
    update pm_lq_batch set valuation_date = coalesce(valuation_date, current_date) where id = b.id;
  elsif p_to = 'cancelled' then
    update pm_lq_item set batch_id = null, status = 'pool', keep_note = null where batch_id = b.id and status in ('batched', 'kept');
  end if;
  update pm_lq_batch set status = p_to, updated_at = now() where id = b.id;
  return p_to;
end $$;


-- =====================================================================
-- 3. RLS
-- =====================================================================

alter table pm_lq_council enable row level security;
alter table pm_lq_member  enable row level security;
alter table pm_lq_batch   enable row level security;

drop policy if exists pm_lq_council_read on pm_lq_council;
create policy pm_lq_council_read on pm_lq_council for select to authenticated using ((select app_can('liquidation', 'view')));
drop policy if exists pm_lq_council_write on pm_lq_council;
create policy pm_lq_council_write on pm_lq_council for all to authenticated
  using ((select app_can('liquidation', 'admin'))) with check ((select app_can('liquidation', 'admin')));

drop policy if exists pm_lq_member_read on pm_lq_member;
create policy pm_lq_member_read on pm_lq_member for select to authenticated using ((select app_can('liquidation', 'view')));
drop policy if exists pm_lq_member_write on pm_lq_member;
create policy pm_lq_member_write on pm_lq_member for all to authenticated
  using ((select app_can('liquidation', 'admin'))) with check ((select app_can('liquidation', 'admin')));

drop policy if exists pm_lq_batch_read on pm_lq_batch;
create policy pm_lq_batch_read on pm_lq_batch for select to authenticated using ((select app_can('liquidation', 'view')));

-- Món thuộc một đợt: người thấy được đợt (AM team, hội đồng) thấy cả món, kể cả món của phòng ban khác.
drop policy if exists pm_lq_item_read on pm_lq_item;
create policy pm_lq_item_read on pm_lq_item
  for select to authenticated using (pm_lq_can_view(dept_code) or (batch_id is not null and (select app_can('liquidation', 'edit'))));

revoke all on pm_lq_council, pm_lq_member, pm_lq_batch from anon;
grant select, insert, update, delete on pm_lq_council, pm_lq_member to authenticated;
grant select on pm_lq_batch to authenticated;
revoke insert, update, delete on pm_lq_batch from authenticated;
grant usage, select on sequence pm_lq_council_id_seq, pm_lq_member_id_seq to authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    foreach t in array array['pm_lq_council', 'pm_lq_member', 'pm_lq_batch'] loop
      execute format('drop trigger if exists app_audit on %I', t);
      execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
    end loop;
  end if;
end $$;

revoke execute on function pm_lq_need_edit(), pm_lq_batch_next(int), pm_lq_batch_create(text, jsonb), pm_lq_batch_save(bigint, jsonb),
                           pm_lq_batch_items(bigint, bigint[], bigint[]), pm_lq_keep(bigint, boolean, text),
                           pm_lq_count(bigint, boolean, numeric, text), pm_lq_reval(bigint, numeric, text), pm_lq_batch_move(bigint, text)
  from public, anon;
grant execute on function pm_lq_need_edit(), pm_lq_batch_next(int), pm_lq_batch_create(text, jsonb), pm_lq_batch_save(bigint, jsonb),
                          pm_lq_batch_items(bigint, bigint[], bigint[]), pm_lq_keep(bigint, boolean, text),
                          pm_lq_count(bigint, boolean, numeric, text), pm_lq_reval(bigint, numeric, text), pm_lq_batch_move(bigint, text)
  to authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 4. KIỂM CHỨNG
-- =====================================================================

select 'Bảng hội đồng / thành viên / đợt có RLS' as "Mục", count(*)::text as "Thực tế", '3' as "Mong đợi",
       case when count(*) = 3 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pm_lq_council', 'pm_lq_member', 'pm_lq_batch') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng đợt (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name = 'pm_lq_batch' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Cột kiểm kê / đánh giá lại trên kho chờ thanh lý', count(*)::text, '3', case when count(*) = 3 then '✔' else '✘ Chạy 27_liquidation.sql trước' end
from   information_schema.columns where table_name = 'pm_lq_item' and column_name in ('count_found', 'count_qty', 'reval_value')
union all
select 'Hàm của đợt thanh lý', count(*)::text, '6', case when count(*) = 6 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pm_lq_batch_create', 'pm_lq_batch_save', 'pm_lq_batch_items', 'pm_lq_count', 'pm_lq_reval', 'pm_lq_batch_move')
union all
select 'Hội đồng đang hiệu lực (nhập ở app: Thanh lý → Hội đồng)', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '⚠ Chưa có — nhập QĐ thành lập hội đồng trong app' end
from   pm_lq_council where active;
