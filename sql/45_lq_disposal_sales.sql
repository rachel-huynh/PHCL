-- =====================================================================
-- 45_lq_disposal_sales.sql — BẢNG BÁN TRÊN DISPOSAL FORM SAU KHI ĐÓNG ĐỢT (user 14/10/2026)
--
-- Trang 2 của LR (Asset Disposal Form) có bảng "Sales": đơn giá, thành tiền, bên mua,
-- CCCD / MST — đọc từ các dòng của LR (data.lines[].sale_price / buyer / buyer_id).
-- Kết quả bán nằm ở pm_lq_item (pm_lq_award ghi: sale_price là ĐƠN GIÁ, buyer, buyer_id)
-- nhưng không ai chép về LR, nên bảng luôn trống. Nay khi đợt đóng (pm_lq_close_do),
-- mỗi dòng đã bán của đợt được ghi kết quả vào đúng dòng LR của nó (theo line_key);
-- dòng của đợt khác, dòng huỷ / mất giữ nguyên. Các đợt đã đóng trước đó được bù một lần.
--
-- Chạy SAU 43_liquidation_flow.sql. Chạy lại nhiều lần vô hại.
-- =====================================================================

-- Chép kết quả bán của một đợt về các LR của nó. Trả về số dòng LR đã ghi.
create or replace function pm_lq_lr_sales(p_batch bigint)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  with x as (
    select d.id, jsonb_agg(case when i.id is not null
                                then l || jsonb_build_object('sale_price', i.sale_price, 'buyer', i.buyer, 'buyer_id', i.buyer_id)
                                else l end order by t.ord) lines,
           count(i.id) hit
      from pm_doc d
      cross join lateral jsonb_array_elements(case when jsonb_typeof(d.data -> 'lines') = 'array' then d.data -> 'lines' else '[]'::jsonb end)
                 with ordinality t(l, ord)
      left join pm_lq_item i on i.lr_doc_id = d.id and i.line_key = t.l ->> 'key' and i.batch_id = p_batch
                            and i.outcome = 'sale' and i.status = 'sold'
     where d.id in (select lr_doc_id from pm_lq_item where batch_id = p_batch)
     group by d.id)
  update pm_doc d set data = jsonb_set(d.data, '{lines}', x.lines), updated_at = now()
    from x where d.id = x.id and x.hit > 0;
  select count(*) into n from pm_lq_item where batch_id = p_batch and outcome = 'sale' and status = 'sold';
  return n;
end $$;

/* Đóng đợt (nội bộ, khi AM + Kế toán + KTT duyệt đủ): kết quả vào kho, tình trạng tài sản.
   Theo tỉ lệ của tài sản gói: "Thanh lý một phần" (23), tài sản gói vẫn trên sổ.
   Cuối cùng: kết quả bán về các dòng LR, cho bảng Sales của Disposal Form (45). */
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
  perform pm_lq_lr_sales(b.id);
  perform pm_lq_log(b.id, pm_lq_me(), 'close', null);
end $$;

revoke execute on function pm_lq_lr_sales(bigint), pm_lq_close_do(bigint) from public, anon, authenticated;

-- Bù một lần cho các đợt đã đóng trước file này.
do $$
declare r record; n int := 0;
begin
  for r in select id from pm_lq_batch where status = 'closed' loop
    n := n + pm_lq_lr_sales(r.id);
  end loop;
  raise notice 'Disposal Form: % dòng bán đã ghi về LR.', n;
end $$;

select app_lock_anon();
