-- =====================================================================
-- 49_lq_bid_rounds.sql — MỞ THẦU THANH LÝ: TỈ LỆ CÓ MẶT, CHÀO THẦU LẠI, BÁO GIÁ THEO LÔ (user 01/11/2026)
--
-- 1. Tỉ lệ thành viên Hội đồng có mặt khi mở thầu: cài đặt am_setting 'lq_open_quorum'
--    ("half" = quá 1/2 — như trước; "all" = tất cả), đổi trong Công cụ quản trị → Thông số.
-- 2. Chào thầu lại: một đợt có thể có NHIỀU vòng gọi báo giá. Vòng đã mở thầu mà không thành
--    (giá thấp, ít bên mua…) được đóng lại với lý do (pm_lq_rebid): link của vòng đó bị thu hồi,
--    điểm danh và báo giá của vòng được giữ làm hồ sơ (pm_lq_batch.bid_history, các báo giá giữ
--    số vòng), rồi gọi báo giá vòng mới. Mỗi vòng có Biên bản mở thầu (08) riêng.
-- 3. Báo giá theo LÔ hoặc TỪNG MÓN, chọn cho từng đợt / từng vòng (pm_lq_bid_mode) trước khi có
--    báo giá: theo lô thì bên mua chào MỘT giá cho cả lô (data.lot_price) và cả lô về một bên mua;
--    khi mở thầu, giá lô được phân bổ cho từng món theo giá đánh giá lại (data.prices) để hoá đơn,
--    gate pass, biên bản giao nhận vẫn tính theo món như cũ.
--
-- Chạy SAU 29_liquidation_bid.sql và 43_liquidation_flow.sql. Chạy lại nhiều lần vô hại.
-- =====================================================================

insert into am_setting (key, value, note)
values ('lq_open_quorum', '"half"'::jsonb, 'Mở thầu thanh lý: "half" = quá 1/2 thành viên Hội đồng có mặt; "all" = tất cả thành viên')
on conflict (key) do nothing;

alter table pm_lq_batch add column if not exists bid_round   int   not null default 1;
alter table pm_lq_batch add column if not exists bid_mode    text  not null default 'item';
alter table pm_lq_batch add column if not exists bid_history jsonb not null default '[]'::jsonb;
alter table pm_lq_batch drop constraint if exists pm_lq_batch_bid_mode_check;
alter table pm_lq_batch add constraint pm_lq_batch_bid_mode_check check (bid_mode in ('item', 'lot'));
alter table pm_lq_buyer add column if not exists round int not null default 1;
alter table pm_lq_quote add column if not exists round int not null default 1;
comment on column pm_lq_batch.bid_mode is 'Báo giá: item = từng món (data.prices), lot = trọn lô (data.lot_price) — 49_lq_bid_rounds.sql.';
comment on column pm_lq_batch.bid_history is
  'Các vòng gọi báo giá đã đóng (chào thầu lại): [{round, mode, deadline, opened_at, open_note, reason, attend: [{member_id, present}], at, by}].';

-- Tỉ lệ có mặt theo cài đặt.
create or replace function pm_lq_quorum()
returns text language sql stable security definer set search_path = public as $$
  select case when (select value #>> '{}' from am_setting where key = 'lq_open_quorum') = 'all' then 'all' else 'half' end
$$;

-- Đợt của bên mua, còn nhận báo giá: link thuộc vòng đang mở, chưa mở thầu, chưa quá hạn.
create or replace function vq_batch(p_buyer pm_lq_buyer, p_write boolean)
returns pm_lq_batch language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  select * into b from pm_lq_batch where id = p_buyer.batch_id;
  if p_write and (b.status <> 'bidding' or b.opened_at is not null or b.call_deadline < now() or p_buyer.round <> b.bid_round) then
    raise exception 'Đợt thanh lý đã ngừng nhận báo giá. / This liquidation no longer accepts quotations.';
  end if;
  return b;
end $$;

create or replace function vq_session(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v pm_lq_buyer; b pm_lq_batch; q pm_lq_quote;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, false);
  select * into q from pm_lq_quote where buyer_id = v.id;
  return jsonb_build_object(
    'buyer', v.name, 'phone', v.phone, 'email', v.email, 'expires_at', v.expires_at,
    'batch', b.code, 'deadline', b.call_deadline, 'terms', b.call_terms, 'mode', b.bid_mode, 'round', v.round,
    'accepting', b.status = 'bidding' and b.opened_at is null and b.call_deadline >= now() and v.round = b.bid_round,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'name', i.name, 'asset_code', i.asset_code, 'qty', coalesce(i.count_qty, i.qty), 'unit', i.unit,
                'condition', i.condition, 'dept', i.dept_code) order by i.id), '[]')
              from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false),
    'quote', case when q.id is null then null else jsonb_build_object(
                'status', q.status, 'version', q.version, 'data', q.data, 'files', q.files, 'submitted_at', q.submitted_at) end);
end $$;

create or replace function vq_save(p_token text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v pm_lq_buyer; b pm_lq_batch;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  if octet_length(coalesce(p_data, '{}')::text) > 200000 then raise exception 'Nội dung quá lớn. / Too much data.'; end if;
  insert into pm_lq_quote (batch_id, buyer_id, data, round) values (b.id, v.id, coalesce(p_data, '{}'), v.round)
  on conflict (buyer_id) do update set data = excluded.data, status = 'draft', updated_at = now();
end $$;

-- Nộp: như trước; theo lô thì cần giá trọn lô, theo món thì ít nhất một đơn giá.
create or replace function vq_submit(p_token text)
returns void language plpgsql security definer set search_path = public as $$
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
  if b.bid_mode = 'lot' then
    if coalesce(nullif(d ->> 'lot_price', '')::numeric, 0) <= 0 then raise exception 'Nhập giá chào cho cả lô. / Enter your price for the whole lot.'; end if;
  else
    select count(*) into n from pm_lq_item i
     where i.batch_id = b.id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false
       and coalesce(nullif(d -> 'prices' ->> i.id::text, ''), '0')::numeric > 0;
    if n = 0 then raise exception 'Nhập đơn giá cho ít nhất một món. / Quote at least one item.'; end if;
  end if;
  if coalesce((d ->> 'agree')::boolean, false) is not true then raise exception 'Xác nhận cam kết trước khi nộp. / Tick the commitment first.'; end if;
  update pm_lq_quote set status = 'submitted', version = version + 1, submitted_at = now(), updated_at = now() where id = q.id;
  perform pm_lq_log(b.id, v.name, 'submit', 'v' || (q.version + 1) || case when b.bid_round > 1 then ' · vòng ' || b.bid_round else '' end);
end $$;

-- Mời bên mua: thuộc vòng đang mở.
create or replace function pm_lq_buyer_add(p_batch bigint, p_name text, p_phone text, p_email text, p_days int)
returns text language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch; v_tok text;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Chỉ mời bên mua khi đang gọi báo giá (chưa mở thầu).'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nhập tên bên mua.'; end if;
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into pm_lq_buyer (batch_id, token_hash, name, phone, email, expires_at, created_by, round)
  values (b.id, encode(extensions.digest(v_tok, 'sha256'), 'hex'), trim(p_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''),
          greatest(b.call_deadline, now()) + make_interval(days => greatest(1, least(coalesce(p_days, 7), 60))), auth.uid(), b.bid_round);
  perform pm_lq_log(b.id, pm_lq_me(), 'invite', trim(p_name));
  return v_tok;
end $$;

-- Lô hay từng món: chọn trước khi vòng đang mở có báo giá nộp.
create or replace function pm_lq_bid_mode(p_batch bigint, p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if p_mode not in ('item', 'lot') then raise exception 'Chế độ báo giá không hợp lệ: %', p_mode; end if;
  if b.status not in ('open', 'hotel', 'amcheck', 'committee', 'decided', 'bidding') or b.opened_at is not null then
    raise exception 'Chỉ đổi cách báo giá trước khi mở thầu. / Change it before the opening.';
  end if;
  if exists (select 1 from pm_lq_quote where batch_id = b.id and round = b.bid_round and status = 'submitted') then
    raise exception 'Đã có báo giá nộp ở vòng này — không đổi được cách báo giá. / Quotations are already in.';
  end if;
  update pm_lq_batch set bid_mode = p_mode, updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'bid_mode', p_mode);
end $$;

-- Giá trọn lô → đơn giá từng món, theo giá đánh giá lại (hoặc giá trị còn lại, hoặc số lượng); phần lẻ vào món cuối.
create or replace function pm_lq_lot_alloc(p_quote bigint)
returns void language plpgsql security definer set search_path = public as $$
declare q pm_lq_quote; v_lot numeric; v_sum numeric; v_left numeric; r record; v_prices jsonb := '{}'::jsonb; v_n int; k int := 0; v_part numeric;
begin
  select * into q from pm_lq_quote where id = p_quote;
  v_lot := nullif(q.data ->> 'lot_price', '')::numeric;
  if coalesce(v_lot, 0) <= 0 then return; end if;
  select count(*), sum(w) into v_n, v_sum from (
    select coalesce(nullif(i.reval_value, 0), nullif(i.nbv, 0), coalesce(i.count_qty, i.qty, 1)) w
      from pm_lq_item i where i.batch_id = q.batch_id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false) x;
  if coalesce(v_n, 0) = 0 or coalesce(v_sum, 0) = 0 then return; end if;
  v_left := v_lot;
  for r in select i.id, coalesce(nullif(i.count_qty, 0), nullif(i.qty, 0), 1) qty,
                  coalesce(nullif(i.reval_value, 0), nullif(i.nbv, 0), coalesce(i.count_qty, i.qty, 1)) w
             from pm_lq_item i where i.batch_id = q.batch_id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false
            order by i.id loop
    k := k + 1;
    v_part := case when k = v_n then v_left else round(v_lot * r.w / v_sum) end;
    v_left := v_left - v_part;
    v_prices := v_prices || jsonb_build_object(r.id::text, round(v_part / r.qty, 2));
  end loop;
  update pm_lq_quote set data = data || jsonb_build_object('prices', v_prices, 'lot_alloc', true) where id = q.id;
end $$;

/* MỞ THẦU (thay 29): chỉ báo giá / bên mua của vòng đang mở; tỉ lệ có mặt theo cài đặt
   (quá 1/2 hoặc tất cả); ít hơn 3 báo giá phải giải trình; theo lô thì phân bổ giá lô. */
create or replace function pm_lq_open(p_batch bigint, p_present bigint[], p_note text default null)
returns int language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch; v_total int; v_here int; v_sub int; v_wait int; v_q text := pm_lq_quorum(); r record;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Đợt không ở bước gọi báo giá, hoặc đã mở thầu.'; end if;
  select count(*) into v_sub from pm_lq_quote where batch_id = b.id and round = b.bid_round and status = 'submitted';
  if v_sub = 0 then raise exception 'Chưa có báo giá nào đã nộp.'; end if;
  select count(*) into v_wait from pm_lq_buyer v where v.batch_id = b.id and v.round = b.bid_round and not v.revoked
     and not exists (select 1 from pm_lq_quote q where q.buyer_id = v.id and q.status = 'submitted');
  if b.call_deadline > now() and v_wait > 0 then
    raise exception 'Chưa tới hạn nộp và còn % bên mua chưa nộp — chưa mở được.', v_wait;
  end if;
  select count(*) into v_total from pm_lq_member where council_id = b.council_id;
  select count(*) into v_here from pm_lq_member where council_id = b.council_id and id = any(coalesce(p_present, '{}'));
  if v_total = 0 then raise exception 'Hội đồng của đợt chưa có thành viên.'; end if;
  if v_q = 'all' and v_here < v_total then
    raise exception 'Cần TẤT CẢ thành viên hội đồng có mặt: mới có % / %.', v_here, v_total;
  elsif v_q = 'half' and v_here * 2 <= v_total then
    raise exception 'Cần QUÁ 50%% thành viên hội đồng có mặt: mới có % / %.', v_here, v_total;
  end if;
  if v_sub < 3 and coalesce(trim(p_note), '') = '' then
    raise exception 'Có % báo giá (ít hơn 3) — ghi giải trình trước khi mở.', v_sub;
  end if;
  delete from pm_lq_attend where batch_id = b.id;
  insert into pm_lq_attend (batch_id, member_id, present, recorded_by, recorded_name)
  select b.id, m.id, m.id = any(coalesce(p_present, '{}')), auth.uid(), pm_lq_me() from pm_lq_member m where m.council_id = b.council_id;
  update pm_lq_quote set opened_at = now() where batch_id = b.id and round = b.bid_round and status = 'submitted';
  if b.bid_mode = 'lot' then
    for r in select id from pm_lq_quote where batch_id = b.id and round = b.bid_round and status = 'submitted' loop perform pm_lq_lot_alloc(r.id); end loop;
  end if;
  update pm_lq_batch set opened_at = now(), open_note = nullif(trim(p_note), ''), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'open', v_sub || ' báo giá · ' || v_here || '/' || v_total || ' thành viên'
                                          || case when b.bid_round > 1 then ' · vòng ' || b.bid_round else '' end);
  return v_sub;
end $$;

/* Kết quả từng món (thay 29): chỉ báo giá đã mở của vòng đang mở; theo lô thì mọi món bán
   về CÙNG một bên mua. */
create or replace function pm_lq_award(p_batch bigint, p_items jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch; x jsonb; i pm_lq_item; q pm_lq_quote; v_max numeric; v_price numeric; n int := 0;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status not in ('valued', 'bidding', 'decided') then raise exception 'Đợt đã đóng hoặc chưa tới bước chọn bên mua.'; end if;
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
      select * into q from pm_lq_quote where id = (x ->> 'quote_id')::bigint and batch_id = b.id and round = b.bid_round and opened_at is not null;
      if q.id is null then raise exception 'Báo giá không hợp lệ cho % (không thuộc vòng đang mở).', coalesce(i.asset_code, i.name); end if;
      v_price := coalesce(nullif(x ->> 'price', '')::numeric, nullif(q.data -> 'prices' ->> i.id::text, '')::numeric);
      if coalesce(v_price, 0) <= 0 then raise exception 'Đơn giá bán của % phải > 0.', coalesce(i.asset_code, i.name); end if;
      if b.bid_mode = 'lot' then
        select max(nullif(o.data ->> 'lot_price', '')::numeric) into v_max from pm_lq_quote o where o.batch_id = b.id and o.round = b.bid_round and o.opened_at is not null;
        if nullif(q.data ->> 'lot_price', '')::numeric < coalesce(v_max, 0) and coalesce(trim(x ->> 'note'), '') = '' then
          raise exception 'Không chọn giá trọn lô cao nhất (%) — ghi lý do.', v_max;
        end if;
      else
        select max(nullif(o.data -> 'prices' ->> i.id::text, '')::numeric) into v_max
          from pm_lq_quote o where o.batch_id = b.id and o.round = b.bid_round and o.opened_at is not null;
        if v_price < coalesce(v_max, 0) and coalesce(trim(x ->> 'note'), '') = '' then
          raise exception '% không chọn giá cao nhất (%) — ghi lý do.', coalesce(i.asset_code, i.name), v_max;
        end if;
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
  if b.bid_mode = 'lot' and (select count(distinct sale_quote_id) from pm_lq_item where batch_id = b.id and status = 'batched' and outcome = 'sale') > 1 then
    raise exception 'Báo giá theo lô: cả lô bán cho MỘT bên mua. / Lot quotation: the whole lot goes to one buyer.';
  end if;
  perform pm_lq_log(b.id, pm_lq_me(), 'award', n || ' món');
  return n;
end $$;

/* Chào thầu lại: vòng đã mở thầu nhưng không thành. Lý do bắt buộc. Giữ hồ sơ vòng cũ, thu hồi
   link của vòng đó, xoá lựa chọn bán; đợt quay về "gọi báo giá" của vòng mới (đặt hạn mới,
   mời bên mua mới — có thể là những người cũ). p_mode: cách báo giá của vòng mới (null = như cũ). */
create or replace function pm_lq_rebid(p_batch bigint, p_reason text, p_mode text default null)
returns int language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status <> 'bidding' or b.opened_at is null then raise exception 'Chào thầu lại sau khi đã mở thầu (và trước khi gửi kết quả). / Re-tender after an opening.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Ghi lý do chào thầu lại. / Say why the tender is repeated.'; end if;
  if p_mode is not null and p_mode not in ('item', 'lot') then raise exception 'Chế độ báo giá không hợp lệ: %', p_mode; end if;
  update pm_lq_batch set bid_history = bid_history || jsonb_build_array(jsonb_build_object(
           'round', b.bid_round, 'mode', b.bid_mode, 'deadline', b.call_deadline, 'terms', b.call_terms, 'opened_at', b.opened_at,
           'open_note', b.open_note, 'reason', trim(p_reason), 'at', now(), 'by', pm_lq_me(),
           'attend', (select coalesce(jsonb_agg(jsonb_build_object('member_id', a.member_id, 'present', a.present)), '[]') from pm_lq_attend a where a.batch_id = b.id))),
         bid_round = b.bid_round + 1, bid_mode = coalesce(p_mode, b.bid_mode),
         opened_at = null, open_note = null, call_deadline = null, updated_at = now()
   where id = b.id;
  update pm_lq_buyer set revoked = true where batch_id = b.id and round = b.bid_round;
  delete from pm_lq_attend where batch_id = b.id;
  update pm_lq_item set outcome = null, sale_quote_id = null, sale_price = null, sale_value = null, buyer = null, buyer_id = null, award_note = null
   where batch_id = b.id and status = 'batched' and outcome = 'sale';
  perform pm_lq_log(b.id, pm_lq_me(), 'rebid', 'vòng ' || (b.bid_round + 1) || ' · ' || trim(p_reason));
  return b.bid_round + 1;
end $$;

-- Huỷ gọi báo giá (thay 43): chỉ khi vòng đang mở chưa mời ai.
create or replace function pm_lq_call_cancel(p_batch bigint)
returns void language plpgsql security definer set search_path = public as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_am();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Chỉ huỷ gọi báo giá khi chưa mở thầu.'; end if;
  if exists (select 1 from pm_lq_buyer where batch_id = b.id and round = b.bid_round) then raise exception 'Đã mời bên mua — thu hồi link thay vì huỷ.'; end if;
  update pm_lq_batch set status = 'decided', call_deadline = null, updated_at = now() where id = b.id;
end $$;

-- Tình hình gọi báo giá (thay 29): thêm vòng của mỗi bên mua, vòng / cách báo giá / các vòng cũ của đợt, tỉ lệ có mặt.
create or replace function pm_lq_bid_list(p_batch bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if not (app_trusted() or app_can('liquidation', 'view')) then raise exception 'Bạn không có quyền xem thanh lý.' using errcode = '42501'; end if;
  select jsonb_build_object(
    'round', b.bid_round, 'mode', b.bid_mode, 'history', b.bid_history, 'quorum', pm_lq_quorum(),
    'buyers', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', v.id, 'name', v.name, 'phone', v.phone, 'email', v.email, 'expires_at', v.expires_at, 'revoked', v.revoked,
                 'last_seen_at', v.last_seen_at, 'round', v.round,
                 'quote', (select jsonb_build_object('id', q.id, 'status', q.status, 'version', q.version, 'submitted_at', q.submitted_at, 'round', q.round,
                             'opened_at', q.opened_at, 'invoice_no', q.invoice_no, 'invoice_date', q.invoice_date, 'gate_date', q.gate_date,
                             'gate_ok', q.gate_ok, 'handover_date', q.handover_date,
                             'data', case when q.opened_at is not null then q.data end,
                             'files', case when q.opened_at is not null then q.files end)
                           from pm_lq_quote q where q.buyer_id = v.id)) order by v.round, v.id), '[]')
               from pm_lq_buyer v where v.batch_id = p_batch),
    'attend', (select coalesce(jsonb_agg(jsonb_build_object('member_id', a.member_id, 'present', a.present, 'by', a.recorded_name, 'at', a.at)), '[]')
               from pm_lq_attend a where a.batch_id = p_batch),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor', e.actor, 'action', e.action, 'detail', e.detail) order by e.at), '[]')
               from pm_lq_event e where e.batch_id = p_batch))
    into r from pm_lq_batch b where b.id = p_batch;
  return r;
end $$;

revoke execute on function pm_lq_quorum(), pm_lq_lot_alloc(bigint) from public, anon, authenticated;
revoke execute on function pm_lq_bid_mode(bigint, text), pm_lq_rebid(bigint, text, text) from public, anon;
grant execute on function pm_lq_bid_mode(bigint, text), pm_lq_rebid(bigint, text, text), pm_lq_open(bigint, bigint[], text),
                          pm_lq_award(bigint, jsonb), pm_lq_bid_list(bigint), pm_lq_call_cancel(bigint), pm_lq_buyer_add(bigint, text, text, text, int)
  to authenticated;
grant execute on function vq_session(text), vq_save(text, jsonb), vq_submit(text) to anon, authenticated;
revoke execute on function vq_batch(pm_lq_buyer, boolean) from public, anon, authenticated;

select app_lock_anon();

select 'Cài đặt lq_open_quorum' as "Mục", coalesce((select value #>> '{}' from am_setting where key = 'lq_open_quorum'), '—') as "Giá trị"
union all
select 'Hàm chào thầu lại / cách báo giá', count(*)::text from pg_proc where proname in ('pm_lq_rebid', 'pm_lq_bid_mode', 'pm_lq_lot_alloc', 'pm_lq_quorum');
