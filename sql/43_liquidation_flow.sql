-- =====================================================================
-- 43_liquidation_flow.sql — QUY TRÌNH THANH LÝ MỚI (29/09/2026)
--
-- Chạy SAU 27, 28, 29 (và 42 — vai trò ACCOUNTANT). Chạy lại nhiều lần vô hại.
-- KHÔNG chạy ALL_IN_ONE trên DB thật.
--
--  1. Đề nghị thanh lý của bộ phận (LR) chỉ còn Trưởng BP → DOF → GM khách sạn
--     (Văn phòng CP: CP_ADMIN → CP_MAINT → CP_HEAD; JVC: JVC_ADMIN → JVC_DGM).
--     Duyệt xong: các dòng vào kho chờ thanh lý như trước.
--  2. Quản lý tài sản khách sạn (HOTEL_AM) lập DANH SÁCH THANH LÝ (một đợt L0x.yyyy)
--     từ các đề nghị đã duyệt — nhiều bộ phận trong một danh sách — và gán mã tài sản
--     (tài sản của gói xây dựng ban đầu: gán mã gói + TỈ LỆ %). Gửi:
--        hotel      DOF → GM khách sạn ký
--        amcheck    AM Coordinator → AM Executive kiểm tra, được sửa mã / tỉ lệ
--                   (giá trị theo sổ kế toán và khấu hao tự lấy lại)
--        committee  Hội đồng thanh lý: MỌI thành viên (tài khoản app của từng người)
--                   ký biên bản họp (mẫu 02); Chủ tịch ký Quyết định (mẫu 03).
--                   Bản giấy đã ký tải lên được.
--        decided    song song: AM kiểm kê thực tế (04, kèm biên bản kiểm tra hiện
--                   trường đã ký) → đánh giá lại (05); và gọi báo giá (bidding).
--        bidding    mở thầu, AM đề xuất kết quả → gửi Hội đồng
--        awarding   mọi thành viên Hội đồng ký duyệt giá trúng → mẫu 06
--        settling   HOTEL_AM tải biên bản giao nhận + gate pass đã ký của từng bên
--                   mua; Kế toán ghi số hoá đơn; rồi AM, Kế toán, Kế toán trưởng
--                   cùng duyệt (thứ tự nào cũng được) → đóng đợt: sổ tài sản và
--                   đối chiếu kế toán cập nhật tự động.
--  Trả về: ghi lý do; đợt lùi một bước, các chữ ký của vòng trước hết hiệu lực.
--
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. CHUỖI DUYỆT CỦA ĐỀ NGHỊ THANH LÝ (một lần)
-- =====================================================================

do $$
begin
  if not exists (select 1 from am_setting where key = 'lq_flow_v2') then
    create temp table _lq_chain on commit drop as
      select entity, doc_type, role_code, kind, row_number() over (partition by entity order by step) - 1 as step
      from   pm_chain
      where  doc_type = 'LR'
        and  not (entity in ('SSP', 'CP') and role_code in ('AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM'))
        and  not (entity = 'JVC' and role_code in ('AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_GM'));
    delete from pm_chain where doc_type = 'LR';
    insert into pm_chain (entity, doc_type, step, role_code, kind) select entity, doc_type, step, role_code, kind from _lq_chain;
    insert into am_setting (key, value) values ('lq_flow_v2', 'true'::jsonb) on conflict (key) do nothing;
  end if;
end $$;


-- =====================================================================
-- 2. BẢNG
-- =====================================================================

alter table pm_lq_batch add column if not exists round integer not null default 1;
alter table pm_lq_batch add column if not exists files jsonb   not null default '[]'::jsonb;
alter table pm_lq_batch add column if not exists submitted_at timestamptz;
alter table pm_lq_batch drop constraint if exists pm_lq_batch_status_check;
alter table pm_lq_batch add constraint pm_lq_batch_status_check check (status in
  ('open', 'hotel', 'amcheck', 'committee', 'decided', 'counted', 'valued', 'bidding', 'awarding', 'settling', 'closed', 'cancelled'));
comment on column pm_lq_batch.files is
  'Bản giấy đã ký: [{kind: minutes|decision|sitecheck|reval|award|gatepass|handover|invoice|other, path, name, size, quote_id, by, at}].';
-- Mốc cũ: kiểm kê / đánh giá lại nay là cờ (count_date / valuation_date) trong bước "decided".
update pm_lq_batch set status = 'decided' where status in ('counted', 'valued');

alter table pm_lq_item add column if not exists share_pct  numeric(7, 3) check (share_pct is null or (share_pct > 0 and share_pct <= 100));
alter table pm_lq_item add column if not exists val_source text check (val_source is null or val_source in ('fin', 'price', 'manual'));
alter table pm_lq_item add column if not exists mapped_name text;
alter table pm_lq_item add column if not exists mapped_at   timestamptz;
comment on column pm_lq_item.share_pct is 'Tài sản của gói (vd gói xây dựng ban đầu, không tách chi tiết): tỉ lệ % nguyên giá / khấu hao của tài sản gói được ghi giảm.';

create table if not exists pm_lq_sign (
  id        bigserial primary key,
  batch_id  bigint not null references pm_lq_batch(id) on delete cascade,
  round     integer not null,
  stage     text not null check (stage in ('hotel', 'amcheck', 'minutes', 'decision', 'award', 'final')),
  slot      text not null,
  action    text not null check (action in ('approve', 'return')),
  user_id   uuid,
  name      text,
  sig       jsonb,
  comment   text,
  at        timestamptz not null default now()
);
create index if not exists pm_lq_sign_batch_idx on pm_lq_sign (batch_id, round, stage);
comment on table pm_lq_sign is 'Chữ ký của danh sách thanh lý theo bước: hotel (DOF, GM), amcheck (AM), minutes / decision / award (Hội đồng), final (AM, Kế toán, KTT).';


-- =====================================================================
-- 3. HÀM
-- =====================================================================

-- Người dùng có (một trong) các vai trò, phạm vi nào cũng được.
create or replace function pm_lq_has_role(p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or exists (select 1 from app_user_role ur join app_user u on u.id = ur.user_id
                                  where ur.user_id = auth.uid() and u.active and ur.role_code = any(p_roles))
$$;
create or replace function pm_lq_role_users(p_roles text[])
returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct ur.user_id from app_user_role ur join app_user u on u.id = ur.user_id where u.active and ur.role_code = any(p_roles)
$$;
-- Người lập / quản lý danh sách: Quản lý tài sản khách sạn, AM team, quản trị khu Thanh lý.
create or replace function pm_lq_is_am()
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or app_can('liquidation', 'admin') or pm_lq_has_role(array['HOTEL_AM', 'AM_COORD', 'AM_EXEC', 'SYS_ADMIN'])
$$;
create or replace function pm_lq_need_am()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not pm_lq_is_am() then raise exception 'Chỉ Quản lý tài sản khách sạn / AM team. / Hotel Asset Manager or AM team only.' using errcode = '42501'; end if;
end $$;

-- Các ô ký của bước hiện tại: seq cùng số = ký song song; số sau mở khi số trước ký đủ.
create or replace function pm_lq_slots(p_batch bigint)
returns table (stage text, slot text, seq int, roles text[], member_id bigint, uid uuid, label text)
language plpgsql stable security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  select * into b from pm_lq_batch where id = p_batch;
  if b.status = 'hotel' then
    return query values ('hotel', 'DOF', 1, array['DOF'], null::bigint, null::uuid, 'DOF'), ('hotel', 'HOTEL_GM', 2, array['HOTEL_GM'], null, null, 'HOTEL_GM');
  elsif b.status = 'amcheck' then
    return query values ('amcheck', 'AM_COORD', 1, array['AM_COORD'], null::bigint, null::uuid, 'AM_COORD'), ('amcheck', 'AM_EXEC', 2, array['AM_EXEC'], null, null, 'AM_EXEC');
  elsif b.status = 'committee' then
    return query
      select 'minutes'::text, 'M' || m.id, 1, null::text[], m.id, m.user_id, m.full_name from pm_lq_member m where m.council_id = b.council_id
      union all
      select 'decision', 'CHAIR', 2, null, m.id, m.user_id, m.full_name from pm_lq_member m where m.council_id = b.council_id and m.role = 'chair';
  elsif b.status = 'awarding' then
    return query select 'award'::text, 'M' || m.id, 1, null::text[], m.id, m.user_id, m.full_name from pm_lq_member m where m.council_id = b.council_id;
  elsif b.status = 'settling' then
    return query values ('final', 'AM', 1, array['AM_COORD', 'AM_EXEC'], null::bigint, null::uuid, 'AM'),
                        ('final', 'ACCOUNTANT', 1, array['ACCOUNTANT'], null, null, 'ACCOUNTANT'),
                        ('final', 'CHIEF_ACC', 1, array['CHIEF_ACC'], null, null, 'CHIEF_ACC');
  end if;
end $$;

-- Ô ký còn chờ (của lượt đang mở).
create or replace function pm_lq_pending(p_batch bigint)
returns table (stage text, slot text, seq int, roles text[], member_id bigint, uid uuid, label text)
language sql stable security definer set search_path = public as $$
  with b as (select * from pm_lq_batch where id = p_batch),
       s as (select x.* from pm_lq_slots(p_batch) x
             where not exists (select 1 from pm_lq_sign g, b where g.batch_id = p_batch and g.round = b.round and g.stage = x.stage
                                                              and g.slot = x.slot and g.action = 'approve'))
  select * from s where seq = (select min(seq) from s)
$$;
create or replace function pm_lq_can_slot(p_roles text[], p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case when p_roles is not null then pm_lq_has_role(p_roles) else app_trusted() or p_uid = auth.uid() end
$$;

create or replace function pm_lq_note(p_batch bigint, p_users uuid[], p_kind text, p_comment text)
returns void language sql security definer set search_path = public as $$
  insert into pm_notice (user_id, kind, doc_no, doc_type, comment, ref_id, actor_email)
  select distinct u, p_kind, b.code, 'LQ', p_comment, b.id, coalesce(app_claims() ->> 'email', 'sql')
  from   pm_lq_batch b, unnest(p_users) u
  where  b.id = p_batch and u is not null and u is distinct from auth.uid()
$$;
-- Báo người phải ký ở bước hiện tại.
create or replace function pm_lq_note_pending(p_batch bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v uuid[];
begin
  select array_agg(distinct u) into v from (
    select case when p.roles is null then p.uid end u from pm_lq_pending(p_batch) p
    union all select r from pm_lq_pending(p_batch) p, pm_lq_role_users(p.roles) r where p.roles is not null) x;
  perform pm_lq_note(p_batch, v, 'todo', (select status from pm_lq_batch where id = p_batch));
end $$;

-- Giá trị theo sổ của tài sản cho một dòng: sổ kế toán (đã ghi nhận) hoặc đơn giá; phần theo tỉ lệ / số lượng.
create or replace function pm_lq_item_map(p_item bigint, p_asset bigint, p_share numeric default null, p_values jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i pm_lq_item; b pm_lq_batch; a am_asset; v_cost numeric; v_nbv numeric; v_f numeric; v_src text; v_orig numeric; v_dep numeric;
begin
  select * into i from pm_lq_item where id = p_item for update;
  if i.id is null then raise exception 'Không có món %', p_item; end if;
  select * into b from pm_lq_batch where id = i.batch_id;
  if not ((b.status = 'open' and pm_lq_is_am())
          or (b.status = 'amcheck' and (app_can('liquidation', 'admin') or pm_lq_has_role(array['AM_COORD', 'AM_EXEC', 'SYS_ADMIN'])))) then
    raise exception 'Gán mã khi Quản lý tài sản khách sạn lập danh sách, hoặc AM team kiểm tra. / Codes are set while the list is drawn up or checked by the AM team.' using errcode = '42501';
  end if;
  if p_share is not null and (p_share <= 0 or p_share > 100) then raise exception 'Tỉ lệ từ 0 tới 100%%. / Share between 0 and 100%%.'; end if;
  if p_asset is not null then
    select * into a from am_asset where id = p_asset;
    if a.id is null then raise exception 'Không có tài sản %', p_asset; end if;
    if a.fin_status = 'booked' and a.fin_cost is not null then v_cost := a.fin_cost; v_nbv := a.fin_nbv; v_src := 'fin';
    else v_cost := coalesce(a.unit_price, 0) * greatest(coalesce(a.qty, 1), 1); v_nbv := null; v_src := 'price'; end if;
    v_f := case when p_share is not null then p_share / 100 else least(coalesce(i.qty, 1) / greatest(coalesce(a.qty, 1), 1), 1) end;
    v_orig := round(v_cost * v_f, 2);
    v_dep := case when v_nbv is not null then round((v_cost - v_nbv) * v_f, 2) end;
  else
    v_orig := i.original_value; v_dep := i.depreciation; v_src := i.val_source;
  end if;
  if p_values ? 'original_value' or p_values ? 'depreciation' then
    v_orig := coalesce(nullif(p_values ->> 'original_value', '')::numeric, v_orig);
    v_dep := coalesce(nullif(p_values ->> 'depreciation', '')::numeric, v_dep);
    v_src := 'manual';
  end if;
  update pm_lq_item set asset_id = a.id, asset_code = case when p_asset is null then asset_code else a.asset_code end,
                        kind = coalesce(a.asset_kind, kind), share_pct = case when p_asset is null then null else p_share end,
                        original_value = v_orig, depreciation = v_dep, nbv = coalesce(v_orig, 0) - coalesce(v_dep, 0), val_source = v_src,
                        mapped_name = pm_lq_me(), mapped_at = now()
   where id = i.id;
  -- Tài sản thanh lý cả món: sang "Chờ thanh lý"; theo tỉ lệ thì tài sản gói vẫn dùng.
  if a.id is not null and p_share is null then
    update am_asset set status_code = case when asset_kind = 'low' then '24' else '8' end where id = a.id and am_alive(status_code) and status_code not in ('8', '24');
  end if;
  return jsonb_build_object('original_value', v_orig, 'depreciation', v_dep, 'source', v_src);
end $$;

-- Hình thức thanh lý (Hội đồng quyết), giữ lại — khi còn lập / kiểm tra / trước khi Hội đồng ký.
create or replace function pm_lq_item_set(p_item bigint, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.status not in ('open', 'amcheck', 'committee')
     or (b.status = 'committee' and exists (select 1 from pm_lq_sign where batch_id = b.id and round = b.round and action = 'approve')) then
    raise exception 'Danh sách đã khoá (Hội đồng đã ký). / The list is locked.';
  end if;
  if p_patch ? 'mode' and p_patch ->> 'mode' not in ('Sale', 'Other') then raise exception 'Hình thức: Sale / Other.'; end if;
  update pm_lq_item set mode = coalesce(p_patch ->> 'mode', mode) where id = i.id;
end $$;

-- Thêm / bớt món (khi Quản lý tài sản khách sạn còn lập danh sách).
create or replace function pm_lq_batch_items(p_id bigint, p_add bigint[] default '{}', p_remove bigint[] default '{}')
returns int language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch; n int := 0; m int;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if b.status <> 'open' then raise exception 'Đợt % đã gửi duyệt. / % is no longer being drawn up.', b.code, b.code; end if;
  update pm_lq_item i set batch_id = b.id, status = 'batched'
    from pm_doc d where d.id = i.lr_doc_id and d.status = 'approved' and i.id = any(coalesce(p_add, '{}')) and i.status = 'pool';
  get diagnostics n = row_count;
  update pm_lq_item set batch_id = null, status = 'pool', count_found = null, count_qty = null, count_note = null,
                        count_by = null, count_name = null, count_at = null, reval_value = null, reval_note = null, keep_note = null
   where batch_id = b.id and id = any(coalesce(p_remove, '{}')) and status in ('batched', 'kept');
  get diagnostics m = row_count;
  update pm_lq_batch set updated_at = now() where id = b.id;
  return n + m;
end $$;

create or replace function pm_lq_keep(p_item bigint, p_keep boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null then raise exception 'Món chưa thuộc đợt nào.'; end if;
  if b.status not in ('open', 'amcheck') then raise exception 'Đợt % đã khoá danh sách.', b.code; end if;
  if p_keep and coalesce(trim(p_note), '') = '' then raise exception 'Ghi lý do giữ lại. / Say why it is kept.'; end if;
  update pm_lq_item set status = case when p_keep then 'kept' else 'batched' end, keep_note = case when p_keep then trim(p_note) end where id = p_item;
end $$;

create or replace function pm_lq_batch_create(p_code text default null, p_data jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_year int; v_code text; v_id bigint;
begin
  perform pm_lq_need_am();
  v_year := coalesce(extract(year from nullif(p_data ->> 'meeting_date', '')::date)::int, extract(year from current_date)::int);
  perform pg_advisory_xact_lock(hashtext('pm_lq_batch.' || v_year));
  v_code := coalesce(nullif(trim(p_code), ''), pm_lq_batch_next(v_year));
  if v_code !~ '^L\d{2,3}\.\d{4}$' then raise exception 'Số đợt phải dạng L02.2026. / Batch number must look like L02.2026.'; end if;
  if exists (select 1 from pm_lq_batch where code = v_code) then raise exception 'Đợt % đã có. / Batch % exists.', v_code, v_code; end if;
  insert into pm_lq_batch (code, year, council_id, meeting_date, meeting_time, meeting_place, data, created_name)
  values (v_code, split_part(v_code, '.', 2)::int, coalesce(nullif(p_data ->> 'council_id', '')::bigint, (select id from pm_lq_council where active limit 1)),
          nullif(p_data ->> 'meeting_date', '')::date, nullif(p_data ->> 'meeting_time', ''), nullif(p_data ->> 'meeting_place', ''),
          coalesce(p_data -> 'data', '{}'::jsonb), pm_lq_me())
  returning id into v_id;
  return v_id;
end $$;

-- Thông tin họp / biên bản: khi chưa đóng; ai quản lý danh sách.
create or replace function pm_lq_batch_save(p_id bigint, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if b.status in ('closed', 'cancelled') then raise exception 'Đợt % đã %.', b.code, b.status; end if;
  if (p_patch ? 'code' and p_patch ->> 'code' <> b.code) or (p_patch ? 'council_id' and nullif(p_patch ->> 'council_id', '')::bigint is distinct from b.council_id) then
    if b.status not in ('open', 'hotel', 'amcheck') then raise exception 'Số đợt / hội đồng chỉ đổi trước khi gửi Hội đồng.'; end if;
  end if;
  if p_patch ? 'code' and p_patch ->> 'code' <> b.code then
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
    liquidation_date = case when p_patch ? 'liquidation_date' then nullif(p_patch ->> 'liquidation_date', '')::date else liquidation_date end,
    data             = case when p_patch ? 'data' then data || (p_patch -> 'data') else data end,
    updated_at       = now()
  where id = p_id;
end $$;

-- Gửi danh sách (Quản lý tài sản khách sạn): → DOF, GM khách sạn.
create or replace function pm_lq_submit(p_batch bigint)
returns text language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status <> 'open' then raise exception 'Đợt % không ở bước lập danh sách.', b.code; end if;
  if not exists (select 1 from pm_lq_item where batch_id = b.id and status = 'batched') then raise exception 'Danh sách chưa có món nào. / The list is empty.'; end if;
  update pm_lq_batch set status = 'hotel', submitted_at = now(), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'submit', null);
  perform pm_lq_note_pending(b.id);
  return 'hotel';
end $$;

/* Đóng đợt (nội bộ, khi AM + Kế toán + KTT duyệt đủ): kết quả vào kho, tình trạng tài sản.
   Theo tỉ lệ của tài sản gói: "Thanh lý một phần" (23), tài sản gói vẫn trên sổ. */
create or replace function pm_lq_close_do(p_batch bigint)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  select * into b from pm_lq_batch where id = p_batch for update;
  update am_asset a set status_code = case when i.share_pct is not null or a.asset_kind = 'low' then '23' when i.outcome = 'sale' then '7' else '9' end
    from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.outcome in ('sale', 'destroy') and a.id = i.asset_id;
  update am_asset a set status_code = '0'
    from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.count_found is false and a.id = i.asset_id
                        and a.asset_kind = 'unique' and i.share_pct is null;
  update pm_lq_item set status = case when count_found is false then 'lost' when outcome = 'sale' then 'sold' else 'destroyed' end
   where batch_id = b.id and status = 'batched';
  update pm_lq_batch set status = 'closed', liquidation_date = coalesce(liquidation_date, current_date), closed_at = now(), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'close', null);
end $$;
-- Đóng tay không còn: đợt đóng khi đủ ba chữ ký cuối.
create or replace function pm_lq_close(p_batch bigint, p_date date default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Đợt đóng khi AM, Kế toán và Kế toán trưởng cùng duyệt. / A batch closes when the AM team, the Accountant and the Chief Accountant have approved.';
end $$;

-- Các bên mua trúng còn thiếu giấy tờ (biên bản giao nhận, gate pass đã ký; số hoá đơn).
create or replace function pm_lq_settle_missing(p_batch bigint)
returns text language sql stable security definer set search_path = public as $$
  select string_agg(distinct v.name || ': ' || concat_ws(', ',
           case when not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'handover' and (f ->> 'quote_id')::bigint = q.id) then 'handover' end,
           case when not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'gatepass' and (f ->> 'quote_id')::bigint = q.id) then 'gate pass' end,
           case when coalesce(q.invoice_no, '') = '' then 'invoice' end), '; ')
  from   pm_lq_batch b join pm_lq_item i on i.batch_id = b.id and i.status = 'batched' and i.outcome = 'sale'
  join   pm_lq_quote q on q.id = i.sale_quote_id join pm_lq_buyer v on v.id = q.buyer_id
  where  b.id = p_batch
    and  (not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'handover' and (f ->> 'quote_id')::bigint = q.id)
          or not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'gatepass' and (f ->> 'quote_id')::bigint = q.id)
          or coalesce(q.invoice_no, '') = '')
$$;

/* Ký / trả về ở bước hiện tại. p_action approve | return; p_sig {png}. Người có quyền ký
   các ô đang chờ (vai trò, hoặc chính thành viên Hội đồng). Đủ chữ ký thì sang bước sau. */
create or replace function pm_lq_act(p_batch bigint, p_action text, p_comment text default null, p_sig jsonb default null)
returns text language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch; p record; v_sig jsonb; n int := 0; v_miss text; v_to text; v_left int;
begin
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status not in ('hotel', 'amcheck', 'committee', 'awarding', 'settling') then raise exception 'Đợt % không chờ ký. / Nothing to sign.', b.code; end if;
  if p_action not in ('approve', 'return') then raise exception 'Thao tác không hợp lệ: %', p_action; end if;
  if not exists (select 1 from pm_lq_pending(b.id) x where pm_lq_can_slot(x.roles, x.uid)) then
    raise exception 'Bạn không có ô ký nào đang chờ ở đợt %. / You have nothing to sign on %.', b.code, b.code using errcode = '42501';
  end if;
  if p_action = 'return' then
    if coalesce(trim(p_comment), '') = '' then raise exception 'Trả về phải ghi lý do. / Say why.'; end if;
    insert into pm_lq_sign (batch_id, round, stage, slot, action, user_id, name, comment)
    select b.id, b.round, x.stage, x.slot, 'return', auth.uid(), pm_lq_me(), trim(p_comment) from pm_lq_pending(b.id) x where pm_lq_can_slot(x.roles, x.uid) limit 1;
    v_to := case b.status when 'hotel' then 'open' when 'amcheck' then 'open' when 'committee' then 'amcheck' when 'awarding' then 'bidding' else 'settling' end;
    update pm_lq_batch set status = v_to, round = round + 1, updated_at = now() where id = b.id;
    perform pm_lq_log(b.id, pm_lq_me(), 'return', trim(p_comment));
    perform pm_lq_note(b.id, array(select pm_lq_role_users(array['HOTEL_AM', 'AM_COORD', 'AM_EXEC'])), 'returned', trim(p_comment));
    return v_to;
  end if;
  if b.status = 'settling' then
    v_miss := pm_lq_settle_missing(b.id);
    if v_miss is not null then raise exception 'Còn thiếu giấy tờ của bên mua: %. / Buyer papers missing: %.', v_miss, v_miss; end if;
  end if;
  v_sig := pm_sig_check(p_sig);
  for p in select * from pm_lq_pending(b.id) x where pm_lq_can_slot(x.roles, x.uid) loop
    insert into pm_lq_sign (batch_id, round, stage, slot, action, user_id, name, sig, comment)
    values (b.id, b.round, p.stage, p.slot, 'approve', auth.uid(), pm_lq_me(), v_sig, nullif(trim(p_comment), ''));
    n := n + 1;
  end loop;
  perform pm_lq_log(b.id, pm_lq_me(), 'sign', b.status);
  -- Bước xong khi không còn ô nào chờ (cả các lượt sau trong bước).
  select count(*) into v_left from pm_lq_slots(b.id) x
   where not exists (select 1 from pm_lq_sign g where g.batch_id = b.id and g.round = b.round and g.stage = x.stage and g.slot = x.slot and g.action = 'approve');
  if v_left = 0 then
    if b.status = 'hotel' then v_to := 'amcheck';
    elsif b.status = 'amcheck' then
      -- Sang Hội đồng: cần hội đồng có Chủ tịch, mọi thành viên có tài khoản app.
      if b.council_id is null then raise exception 'Chọn Hội đồng thanh lý cho đợt trước. / Pick the committee first.'; end if;
      if not exists (select 1 from pm_lq_member where council_id = b.council_id and role = 'chair') then raise exception 'Hội đồng chưa có Chủ tịch. / The committee has no chairman.'; end if;
      if exists (select 1 from pm_lq_member where council_id = b.council_id and user_id is null) then
        raise exception 'Mọi thành viên Hội đồng cần có tài khoản app để ký (Thanh lý → Hội đồng). / Every member needs an app account to sign.';
      end if;
      v_to := 'committee';
    elsif b.status = 'committee' then v_to := 'decided';
    elsif b.status = 'awarding' then v_to := 'settling';
    else perform pm_lq_close_do(b.id); return 'closed';
    end if;
    update pm_lq_batch set status = v_to, updated_at = now(),
                           decision_date = case when v_to = 'decided' then coalesce(decision_date, meeting_date, current_date) else decision_date end
     where id = b.id;
    if v_to = 'decided' then perform pm_lq_note(b.id, array(select pm_lq_role_users(array['HOTEL_AM', 'AM_COORD', 'AM_EXEC'])), 'info', 'decided');
    elsif v_to = 'settling' then perform pm_lq_note(b.id, array(select pm_lq_role_users(array['HOTEL_AM', 'ACCOUNTANT'])), 'info', 'settling');
    else perform pm_lq_note_pending(b.id); end if;
    return v_to;
  end if;
  perform pm_lq_note_pending(b.id);        -- lượt sau của bước (vd GM sau DOF, Chủ tịch sau các thành viên)
  return b.status;
end $$;

-- Kiểm kê (04) và đánh giá lại (05): trong "decided" hoặc song song với gọi báo giá.
create or replace function pm_lq_count(p_item bigint, p_found boolean, p_qty numeric default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null or i.status <> 'batched' then raise exception 'Món không nằm trong danh sách của đợt nào.'; end if;
  if not (pm_lq_is_am() or exists (select 1 from pm_lq_member m where m.council_id = b.council_id and m.user_id = auth.uid())) then
    raise exception 'Chỉ AM team hoặc thành viên hội đồng mới kiểm kê được.' using errcode = '42501';
  end if;
  if b.status not in ('decided', 'bidding') or b.count_date is not null then raise exception 'Kiểm kê sau Quyết định (03) và trước khi chốt kiểm kê. / Count after the decision.'; end if;
  if p_found is null then
    update pm_lq_item set count_found = null, count_qty = null, count_note = null, count_by = null, count_name = null, count_at = null where id = p_item;
    return;
  end if;
  if p_qty is not null and p_qty < 0 then raise exception 'Số lượng không âm.'; end if;
  update pm_lq_item set count_found = p_found, count_qty = case when p_found then coalesce(p_qty, qty) else 0 end, count_note = nullif(trim(p_note), ''),
                        count_by = auth.uid(), count_name = pm_lq_me(), count_at = now()
   where id = p_item;
end $$;
create or replace function pm_lq_reval(p_item bigint, p_value numeric, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null or i.status <> 'batched' then raise exception 'Món không nằm trong danh sách của đợt nào.'; end if;
  if b.status not in ('decided', 'bidding') or b.count_date is null or b.valuation_date is not null then
    raise exception 'Đánh giá lại sau khi chốt kiểm kê và trước khi chốt đánh giá. / Revalue after the count.';
  end if;
  if p_value is not null and p_value < 0 then raise exception 'Giá trị không âm.'; end if;
  update pm_lq_item set reval_value = p_value, reval_note = nullif(trim(p_note), '') where id = p_item;
end $$;
-- Chốt / mở lại kiểm kê (cần biên bản kiểm tra hiện trường đã ký) và đánh giá lại.
create or replace function pm_lq_milestone(p_batch bigint, p_what text, p_done boolean)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch; v_left int;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status not in ('decided', 'bidding') then raise exception 'Kiểm kê / đánh giá lại sau Quyết định và trước khi gửi kết quả cho Hội đồng.'; end if;
  if p_what = 'count' then
    if p_done then
      select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and count_found is null;
      if v_left > 0 then raise exception 'Còn % món chưa kiểm kê. / % item(s) not counted yet.', v_left, v_left; end if;
      if not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'sitecheck') then
        raise exception 'Tải lên biên bản kiểm tra hiện trường đã ký trước. / Upload the signed site-check minutes first.';
      end if;
      update pm_lq_batch set count_date = current_date, updated_at = now() where id = b.id;
    else
      if b.valuation_date is not null then raise exception 'Mở lại đánh giá lại trước. / Reopen the revaluation first.'; end if;
      update pm_lq_batch set count_date = null, updated_at = now() where id = b.id;
    end if;
  elsif p_what = 'reval' then
    if p_done then
      if b.count_date is null then raise exception 'Chốt kiểm kê trước.'; end if;
      select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and count_found is not false and reval_value is null;
      if v_left > 0 then raise exception 'Còn % món chưa có giá trị đánh giá lại. / % item(s) not revalued yet.', v_left, v_left; end if;
      update pm_lq_batch set valuation_date = current_date, updated_at = now() where id = b.id;
    else
      update pm_lq_batch set valuation_date = null, updated_at = now() where id = b.id;
    end if;
  else raise exception 'Mốc không hợp lệ: %', p_what;
  end if;
  perform pm_lq_log(b.id, pm_lq_me(), p_what || case when p_done then '_done' else '_reopen' end, null);
end $$;

-- Gọi báo giá ngay khi Quyết định (03) được ký — song song với kiểm kê / đánh giá lại.
create or replace function pm_lq_call_open(p_batch bigint, p_deadline timestamptz, p_terms text)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if not (b.status = 'decided' or (b.status = 'bidding' and b.opened_at is null)) then raise exception 'Gọi báo giá sau Quyết định (03) và trước khi mở thầu.'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'Hạn nộp báo giá phải ở tương lai.'; end if;
  update pm_lq_batch set status = 'bidding', call_deadline = p_deadline, call_terms = nullif(trim(p_terms), ''), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), case when b.status = 'decided' then 'call' else 'call_edit' end, to_char(p_deadline, 'DD/MM/YYYY HH24:MI'));
end $$;
create or replace function pm_lq_call_cancel(p_batch bigint)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Chỉ huỷ gọi báo giá khi chưa mở thầu.'; end if;
  if exists (select 1 from pm_lq_buyer where batch_id = b.id) then raise exception 'Đã mời bên mua — thu hồi link thay vì huỷ.'; end if;
  update pm_lq_batch set status = 'decided', call_deadline = null, updated_at = now() where id = b.id;
end $$;

-- Gửi kết quả (giá trúng) cho Hội đồng duyệt: đã mở thầu, chốt kiểm kê và đánh giá lại, mọi món thấy có kết quả.
create or replace function pm_lq_award_submit(p_batch bigint)
returns text language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch; v_left int;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status <> 'bidding' or b.opened_at is null then raise exception 'Mở thầu trước. / Open the quotations first.'; end if;
  if b.count_date is null or b.valuation_date is null then raise exception 'Chốt kiểm kê (04) và đánh giá lại (05) trước. / Finish the count and the revaluation first.'; end if;
  select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and count_found is not false and outcome is null;
  if v_left > 0 then raise exception 'Còn % món chưa có kết quả (bán / huỷ).', v_left; end if;
  update pm_lq_batch set status = 'awarding', updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'award_submit', null);
  perform pm_lq_note_pending(b.id);
  return 'awarding';
end $$;

-- Số hoá đơn (Kế toán), ngày gate pass / giao nhận (AM) của bên mua trúng — khi quyết toán đợt.
create or replace function pm_lq_buyer_doc(p_quote bigint, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare q pm_lq_quote; b pm_lq_batch; v_acc boolean := pm_lq_has_role(array['ACCOUNTANT', 'CHIEF_ACC']);
begin
  select * into q from pm_lq_quote where id = p_quote for update;
  select * into b from pm_lq_batch where id = q.batch_id;
  if q.id is null or b.status <> 'settling' then raise exception 'Giấy tờ bên mua ghi khi quyết toán đợt (sau khi Hội đồng duyệt giá). / After the committee approved the prices.'; end if;
  if (p_patch ? 'invoice_no' or p_patch ? 'invoice_date') and not (v_acc or pm_lq_is_am()) then raise exception 'Số hoá đơn do Kế toán ghi.' using errcode = '42501'; end if;
  if (p_patch ? 'gate_date' or p_patch ? 'handover_date') and not pm_lq_is_am() then raise exception 'Ngày gate pass / giao nhận do Quản lý tài sản ghi.' using errcode = '42501'; end if;
  update pm_lq_quote set
    invoice_no    = case when p_patch ? 'invoice_no' then nullif(trim(p_patch ->> 'invoice_no'), '') else invoice_no end,
    invoice_date  = case when p_patch ? 'invoice_date' then nullif(p_patch ->> 'invoice_date', '')::date else invoice_date end,
    gate_date     = case when p_patch ? 'gate_date' then nullif(p_patch ->> 'gate_date', '')::date else gate_date end,
    handover_date = case when p_patch ? 'handover_date' then nullif(p_patch ->> 'handover_date', '')::date else handover_date end,
    updated_at = now()
  where id = q.id;
end $$;

-- Bản giấy đã ký (tải lên bucket pm-lqdoc, thư mục = id đợt). Hoá đơn: Kế toán cũng tải được.
create or replace function pm_lq_file_add(p_batch bigint, p_kind text, p_path text, p_name text, p_size bigint, p_quote bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if p_kind not in ('minutes', 'decision', 'sitecheck', 'reval', 'award', 'gatepass', 'handover', 'invoice', 'other') then raise exception 'Loại tệp không hợp lệ: %', p_kind; end if;
  if not (pm_lq_is_am() or (p_kind = 'invoice' and pm_lq_has_role(array['ACCOUNTANT', 'CHIEF_ACC']))) then raise exception 'Bạn không tải tệp lên đợt này được.' using errcode = '42501'; end if;
  if b.status in ('closed', 'cancelled') then raise exception 'Đợt % đã %.', b.code, b.status; end if;
  if p_path is null or split_part(p_path, '/', 1) <> b.id::text or length(p_path) > 300 then raise exception 'Đường dẫn tệp không hợp lệ.'; end if;
  if p_kind in ('gatepass', 'handover') and not exists (select 1 from pm_lq_quote where id = p_quote and batch_id = b.id) then raise exception 'Chọn bên mua của tệp.'; end if;
  update pm_lq_batch set files = files || jsonb_build_array(jsonb_build_object('kind', p_kind, 'path', p_path, 'name', left(coalesce(p_name, ''), 200),
                                                          'size', p_size, 'quote_id', p_quote, 'by', pm_lq_me(), 'at', now())), updated_at = now()
   where id = b.id;
  if p_kind = 'gatepass' then update pm_lq_quote set gate_ok = true where id = p_quote; end if;
end $$;
create or replace function pm_lq_file_del(p_batch bigint, p_path text)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status in ('closed', 'cancelled') then raise exception 'Đợt % đã %.', b.code, b.status; end if;
  update pm_lq_batch set files = coalesce((select jsonb_agg(f) from jsonb_array_elements(files) f where f ->> 'path' <> p_path), '[]'), updated_at = now() where id = b.id;
end $$;

-- Tình hình ký của một đợt cho màn hình: các ô của bước, ai đã ký, ô nào của tôi.
create or replace function pm_lq_sign_state(p_batch bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'slots', coalesce((select jsonb_agg(jsonb_build_object('stage', x.stage, 'slot', x.slot, 'seq', x.seq, 'roles', x.roles, 'member_id', x.member_id,
               'label', x.label, 'mine', pm_lq_can_slot(x.roles, x.uid) and exists (select 1 from pm_lq_pending(p_batch) y where y.stage = x.stage and y.slot = x.slot),
               'signed', (select jsonb_build_object('name', g.name, 'at', g.at, 'sig', g.sig) from pm_lq_sign g, pm_lq_batch b
                          where b.id = p_batch and g.batch_id = b.id and g.round = b.round and g.stage = x.stage and g.slot = x.slot and g.action = 'approve'
                          order by g.at desc limit 1)) order by x.seq, x.slot) from pm_lq_slots(p_batch) x), '[]'),
    'history', coalesce((select jsonb_agg(jsonb_build_object('round', g.round, 'stage', g.stage, 'slot', g.slot, 'action', g.action, 'name', g.name, 'at', g.at,
               'comment', g.comment, 'sig', g.sig) order by g.at) from pm_lq_sign g where g.batch_id = p_batch), '[]'),
    'missing', pm_lq_settle_missing(p_batch))
$$;

-- Việc của tôi (To-do): ký; lập / gửi danh sách; kiểm kê, đánh giá lại, gọi báo giá; giấy tờ quyết toán; hoá đơn.
create or replace function pm_todo_lq()
returns table (kind text, ref_id bigint, ref_no text, at timestamptz, detail text)
language sql stable security definer set search_path = public as $$
  select 'lq_sign', b.id, b.code, b.updated_at, b.status from pm_lq_batch b
  where  b.status in ('hotel', 'amcheck', 'committee', 'awarding', 'settling')
    and  exists (select 1 from pm_lq_pending(b.id) x where pm_lq_can_slot(x.roles, x.uid))
    and  (b.status <> 'settling' or pm_lq_settle_missing(b.id) is null)
  union all
  select 'lq_' || b.status, b.id, b.code, b.updated_at, null from pm_lq_batch b
  where  pm_lq_is_am() and b.status = 'open'
  union all
  select 'lq_work', b.id, b.code, b.updated_at, concat_ws(' · ', case when b.count_date is null then 'count' end,
                                                         case when b.valuation_date is null then 'reval' end,
                                                         case when b.status = 'decided' then 'call' end,
                                                         case when b.status = 'bidding' and b.opened_at is not null then 'award' end)
  from   pm_lq_batch b where pm_lq_is_am() and b.status in ('decided', 'bidding')
  union all
  select 'lq_papers', b.id, b.code, b.updated_at, pm_lq_settle_missing(b.id) from pm_lq_batch b
  where  b.status = 'settling' and pm_lq_settle_missing(b.id) is not null
    and  (pm_lq_is_am() or pm_lq_has_role(array['ACCOUNTANT', 'CHIEF_ACC']))
$$;

-- Các hàm của 28 / 29 (mời bên mua, mở thầu, kết quả…) nay chỉ cho người quản lý danh sách, không còn
-- mọi ai có quyền sửa khu Thanh lý (nhân viên bộ phận cũng có quyền đó để lập đề nghị).
create or replace function pm_lq_need_edit()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  perform pm_lq_need_am();
end $$;
-- Chuyển mốc tay không còn (các bước đi theo chữ ký); chỉ còn huỷ đợt đang lập.
create or replace function pm_lq_batch_move(p_id bigint, p_to text)
returns text language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if not (b.status = 'open' and p_to = 'cancelled') then
    raise exception 'Các bước của đợt đi theo chữ ký; chỉ huỷ được đợt đang lập. / Steps follow the signatures; only a batch being drawn up can be cancelled.';
  end if;
  update pm_lq_item set batch_id = null, status = 'pool', keep_note = null where batch_id = b.id and status in ('batched', 'kept');
  update pm_lq_batch set status = 'cancelled', updated_at = now() where id = b.id;
  return 'cancelled';
end $$;

-- Món thuộc một đợt: ai xem được khu Thanh lý (Hội đồng, Kế toán…) thấy cả món của phòng ban khác.
drop policy if exists pm_lq_item_read on pm_lq_item;
create policy pm_lq_item_read on pm_lq_item
  for select to authenticated using (pm_lq_can_view(dept_code) or (batch_id is not null and (select app_can('liquidation', 'view'))) or (select pm_lq_is_am()));

alter table pm_lq_sign enable row level security;
drop policy if exists pm_lq_sign_read on pm_lq_sign;
create policy pm_lq_sign_read on pm_lq_sign for select to authenticated using ((select app_can('liquidation', 'view')));
revoke all on pm_lq_sign from anon;
grant select on pm_lq_sign to authenticated;
revoke insert, update, delete on pm_lq_sign from authenticated;

-- Storage: bản giấy đã ký của đợt (thư mục = id đợt).
insert into storage.buckets (id, name, public) values ('pm-lqdoc', 'pm-lqdoc', false) on conflict (id) do nothing;
drop policy if exists pm_lqdoc_read on storage.objects;
create policy pm_lqdoc_read on storage.objects for select to authenticated using (bucket_id = 'pm-lqdoc' and (select app_can('liquidation', 'view')));
drop policy if exists pm_lqdoc_write on storage.objects;
create policy pm_lqdoc_write on storage.objects for insert to authenticated
  with check (bucket_id = 'pm-lqdoc' and ((select pm_lq_is_am()) or (select pm_lq_has_role(array['ACCOUNTANT', 'CHIEF_ACC']))));

do $$
begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    drop trigger if exists app_audit on pm_lq_sign;
    create trigger app_audit after insert or update or delete on pm_lq_sign for each row execute function app_audit_row();
  end if;
end $$;

revoke execute on function pm_lq_has_role(text[]), pm_lq_role_users(text[]), pm_lq_is_am(), pm_lq_need_am(), pm_lq_slots(bigint), pm_lq_pending(bigint),
  pm_lq_can_slot(text[], uuid), pm_lq_note(bigint, uuid[], text, text), pm_lq_note_pending(bigint), pm_lq_item_map(bigint, bigint, numeric, jsonb),
  pm_lq_item_set(bigint, jsonb), pm_lq_submit(bigint), pm_lq_close_do(bigint), pm_lq_settle_missing(bigint), pm_lq_act(bigint, text, text, jsonb),
  pm_lq_milestone(bigint, text, boolean), pm_lq_award_submit(bigint), pm_lq_file_add(bigint, text, text, text, bigint, bigint), pm_lq_file_del(bigint, text),
  pm_lq_sign_state(bigint), pm_todo_lq() from public, anon;
grant execute on function pm_lq_has_role(text[]), pm_lq_is_am(), pm_lq_item_map(bigint, bigint, numeric, jsonb), pm_lq_item_set(bigint, jsonb), pm_lq_submit(bigint),
  pm_lq_act(bigint, text, text, jsonb), pm_lq_milestone(bigint, text, boolean), pm_lq_award_submit(bigint),
  pm_lq_file_add(bigint, text, text, text, bigint, bigint), pm_lq_file_del(bigint, text), pm_lq_sign_state(bigint), pm_todo_lq() to authenticated;
-- Nội bộ: không gọi thẳng.
revoke execute on function pm_lq_close_do(bigint), pm_lq_note(bigint, uuid[], text, text), pm_lq_note_pending(bigint) from authenticated;

select app_lock_anon();


-- =====================================================================
-- 4. KIỂM CHỨNG
-- =====================================================================

select 'Chuỗi đề nghị thanh lý (SSP) dừng ở GM khách sạn' as "Mục",
       coalesce(string_agg(role_code, ' → ' order by step), '—') as "Thực tế", 'DEPT_STAFF → DEPT_HEAD → DOF → HOTEL_GM' as "Mong đợi",
       case when string_agg(role_code, ' → ' order by step) = 'DEPT_STAFF → DEPT_HEAD → DOF → HOTEL_GM' then '✔' else '⚠ đã chỉnh tay ở Chuỗi phê duyệt' end as "Đạt"
from   pm_chain where doc_type = 'LR' and entity = 'SSP'
union all
select 'Bảng chữ ký danh sách thanh lý có RLS', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_class where relname = 'pm_lq_sign' and relrowsecurity
union all
select 'Hàm quy trình mới', count(*)::text, '8', case when count(*) = 8 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pm_lq_submit', 'pm_lq_act', 'pm_lq_item_map', 'pm_lq_milestone', 'pm_lq_award_submit', 'pm_lq_file_add', 'pm_lq_sign_state', 'pm_todo_lq')
union all
select 'Thành viên Hội đồng chưa có tài khoản app (cần để ký)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '⚠ gán tài khoản ở Thanh lý → Hội đồng' end
from   pm_lq_member m join pm_lq_council c on c.id = m.council_id and c.active where m.user_id is null;
