-- =====================================================================
-- 14_undo_intake.sql — HOÀN TÁC MỘT ĐỢT VỪA GHI VÀO SỔ
--
-- Vì sao phải là HÀM chứ không phải câu DELETE từ trình duyệt: vai `anon`
-- CỐ Ý không có quyền delete trên am_asset (04_rls.sql chỉ cấp select/insert/
-- update). Xoá tài sản là việc phải có luật đi kèm, và luật nằm ở đây:
--
--   1. Chỉ xoá đúng các id được truyền vào.
--   2. KHÔNG xoá dòng lịch sử (is_legacy) — đợt nhập không bao giờ tạo ra
--      chúng, nên nếu id nào là legacy thì đó là nhầm lẫn, phải chặn.
--   3. KHÔNG xoá tài sản đã nằm trên một biên bản tem nhãn đã lưu. Biên bản
--      là chứng từ đã phát hành; xoá tài sản dưới chân nó sẽ để lại một biên
--      bản trỏ vào hư không. Những dòng đó được GIỮ LẠI và báo về.
--
-- BỘ ĐẾM: lùi lại ĐƯỢC, nhưng chỉ khi chắc chắn an toàn. Điều kiện:
--
--   a) Bộ đếm vẫn đứng đúng chỗ đợt này để lại (next = max(seq đã xoá) + 1).
--      Nếu ai đó đã cấp thêm sau mình thì next đã vượt qua — lùi lúc đó sẽ
--      cấp lại số người khác đang dùng. Trường hợp này GIỮ NGUYÊN.
--   b) Không dòng nào trong đợt đã được đánh dấu ĐÃ IN TEM. Xoá dòng trong
--      cơ sở dữ liệu không bóc được cái tem đã dán lên hiện vật; cấp lại số
--      đó sẽ tạo ra hai vật mang cùng một mã.
--
-- Không đủ điều kiện thì bộ đếm đứng yên và dãy số có một khoảng trống — đó là
-- cái giá đúng, vì trùng mã tệ hơn thủng số rất nhiều.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_undo_intake(bigint[]);

create or replace function am_undo_intake(p_ids bigint[])
returns table (deleted int, kept_on_receipt int, kept_legacy int,
               seq_rewound int, seq_held int, barcode_rewound int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_del     int := 0;
  v_receipt int := 0;
  v_legacy  int := 0;
  v_rew     int := 0;
  v_held    int := 0;
  v_bcrew   int := 0;
  v_printed int := 0;
  r         record;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0, 0, 0, 0, 0;
    return;
  end if;

  -- A printed label cannot be unprinted, so its number must never come back.
  select count(*) into v_printed
  from   am_asset a
  where  a.id = any(p_ids) and a.label_printed;

  -- Snapshot what this batch used, BEFORE deleting it.
  create temp table if not exists _undo_used (
    dept_code text, letters text, seq int, kind text, barcode text
  ) on commit drop;
  delete from _undo_used;
  insert into _undo_used
  select a.dept_code, a.letters, a.seq, a.asset_kind, a.barcode
  from   am_asset a
  where  a.id = any(p_ids)
    and  not a.is_legacy
    and  not exists (select 1 from am_alr_line l where l.asset_id = a.id);

  select count(*) into v_legacy
  from   am_asset a
  where  a.id = any(p_ids) and a.is_legacy;

  select count(distinct l.asset_id) into v_receipt
  from   am_alr_line l
  where  l.asset_id = any(p_ids);

  with gone as (
    delete from am_asset a
    where  a.id = any(p_ids)
      and  not a.is_legacy
      and  not exists (select 1 from am_alr_line l where l.asset_id = a.id)
    returning 1
  )
  select count(*) into v_del from gone;

  /* Rewind each (dept, letters) counter, but ONLY where it still stands exactly
     where this batch left it. If it has moved on, someone allocated after us
     and those numbers are in use — leave it alone and count it as held. */
  if v_printed = 0 then
    for r in
      select u.dept_code, u.letters, min(u.seq) as lo, max(u.seq) as hi
      from   _undo_used u group by u.dept_code, u.letters
    loop
      update am_asset_seq s
         set next_seq = greatest(
               1, coalesce((select max(a.seq) from am_asset a
                            where a.dept_code = r.dept_code
                              and a.letters = r.letters
                              and a.seq > 0), 0) + 1),
             updated_at = now()
       where s.dept_code = r.dept_code
         and s.letters   = r.letters
         and s.next_seq  = r.hi + 1;
      if found then v_rew := v_rew + 1; else v_held := v_held + 1; end if;
    end loop;

    /* Barcodes are one counter per kind. Same test: only rewind when the
       counter is still sitting right after the highest number this batch took. */
    for r in
      select u.kind, count(*) as n,
             max((regexp_replace(u.barcode, '^JVC\.9?', ''))::bigint) as hi
      from   _undo_used u
      where  u.barcode ~ '^JVC\.[0-9]+$'
      group by u.kind
    loop
      update am_barcode_seq b
         set next_val = greatest(1, b.next_val - r.n), updated_at = now()
       where b.kind = r.kind
         and b.next_val = r.hi + 1;
      if found then v_bcrew := v_bcrew + 1; end if;
    end loop;
  else
    select count(distinct (u.dept_code, u.letters)) into v_held from _undo_used u;
  end if;

  return query select v_del, v_receipt, v_legacy, v_rew, v_held, v_bcrew;
end $$;

comment on function am_undo_intake(bigint[]) is
  'Xoá các tài sản vừa ghi bởi một đợt nhập và lùi bộ đếm về nếu an toàn. Giữ lại dòng lịch sử và dòng đã nằm trên biên bản đã lưu. Chỉ lùi bộ đếm khi nó vẫn đứng đúng chỗ đợt này để lại VÀ chưa dòng nào được đánh dấu đã in tem.';

grant execute on function am_undo_intake(bigint[]) to anon, authenticated;
