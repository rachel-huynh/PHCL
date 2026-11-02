-- =====================================================================
-- 48_lq_decided_status.sql — TÀI SẢN "ĐÃ THANH LÍ" KHI QUYẾT ĐỊNH ĐƯỢC DUYỆT (user 01/11/2026)
--
-- Trước đây tài sản của một đợt ở "Chờ thanh lí" (8 / 24) tới khi đợt đóng. Nay, khi Quyết định
-- thanh lý (03) được duyệt — đợt sang "decided" — mọi tài sản của đợt chuyển sang đã thanh lý
-- ngay, theo đúng cách đợt đóng ghi (pm_lq_close_do):
--   · tài sản riêng (unique), thanh lý cả món  → 7 "Đã thanh lí";
--   · tài sản gói (low) hoặc theo tỉ lệ        → 23 "Thanh lý một phần".
-- Khi đợt đóng, kết quả cuối vẫn ghi như cũ: món huỷ → 9, món không thấy lúc kiểm kê → 0.
-- Từ "decided" đợt không còn lùi về trước Quyết định (trả về chỉ về "bidding"), nên không cần hoàn tác.
-- Các đợt đang ở sau Quyết định (decided … settling) được bù một lần ở cuối file.
--
-- Chạy SAU 43_liquidation_flow.sql. Chạy lại nhiều lần vô hại.
-- =====================================================================

create or replace function pm_lq_decided_assets(p_batch bigint)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update am_asset a set status_code = case when i.share_pct is not null or a.asset_kind = 'low' then '23' else '7' end
    from pm_lq_item i
   where i.batch_id = p_batch and i.status = 'batched' and a.id = i.asset_id
     and coalesce(i.count_found, true)
     and coalesce(a.status_code, '') not in ('0', '7', '9', '23');
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function pm_lq_batch_decided()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'decided' and old.status is distinct from 'decided'
     and old.status in ('open', 'hotel', 'amcheck', 'committee') then
    perform pm_lq_decided_assets(new.id);
  end if;
  return new;
end $$;

drop trigger if exists pm_lq_batch_decided on pm_lq_batch;
create trigger pm_lq_batch_decided after update of status on pm_lq_batch
  for each row execute function pm_lq_batch_decided();

comment on function pm_lq_decided_assets(bigint) is
  'Tài sản của đợt sang đã thanh lý (7, gói / tỉ lệ: 23) khi Quyết định 03 được duyệt (48_lq_decided_status.sql).';

revoke execute on function pm_lq_decided_assets(bigint) from public, anon, authenticated;
revoke execute on function pm_lq_batch_decided() from public, anon, authenticated;

-- Bù một lần: các đợt đã qua Quyết định mà chưa đóng.
select b.code as dot, pm_lq_decided_assets(b.id) as so_tai_san_chuyen
  from pm_lq_batch b
 where b.status in ('decided', 'bidding', 'awarding', 'settling');

select app_lock_anon();
