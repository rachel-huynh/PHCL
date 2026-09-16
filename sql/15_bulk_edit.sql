-- =====================================================================
-- 15_bulk_edit.sql — SỬA / XOÁ HÀNG LOẠT TRONG SỔ TÀI SẢN
--
-- Vì sao là HÀM chứ không phải PATCH/DELETE thẳng từ trình duyệt:
--
--   * Vai `anon` CỐ Ý không có quyền delete trên am_asset (04_rls.sql).
--   * Đổi PHÒNG BAN không phải là đổi một ô. Ràng buộc am_asset_code_ck bắt
--     buộc  asset_code = dept_code.group.letters.year.seq  — nên một lệnh
--     UPDATE dept_code trần sẽ bị cơ sở dữ liệu ném ra ngay. Mã tài sản MANG
--     mã phòng ban; đổi phòng ban là phải cấp lại mã.
--
-- Do đó hàm này làm đúng việc phải làm, chứ không làm việc dễ:
--
--   1. Vị trí / tình trạng: đổi thẳng, không ảnh hưởng mã.
--   2. Phòng ban: cấp SỐ MỚI từ bộ đếm của (phòng ban mới, CHỮ) và dựng lại
--      asset_code. MÃ VẠCH GIỮ NGUYÊN — mã vạch mới là danh tính vĩnh viễn của
--      hiện vật, còn asset_code là chỗ nó đang thuộc về.
--   3. Mã cũ KHÔNG được trả lại bộ đếm cũ. Số đã cấp coi như đã tiêu; trùng mã
--      tệ hơn thủng số rất nhiều.
--   4. Dòng nào đã in tem thì tem đó giờ sai — label_printed bị đặt lại false
--      để nó quay vào hàng đợi in lại. Hàm trả về số lượng cần in lại.
--   5. Dòng lịch sử (is_legacy) KHÔNG đổi được phòng ban: mã của chúng không
--      theo quy tắc của app nên không dựng lại được. Chúng được bỏ qua và báo về.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_bulk_update(bigint[], text, text, text);

create or replace function am_bulk_update(
  p_ids      bigint[],
  p_location text default null,
  p_dept     text default null,
  p_status   text default null
)
returns table (updated int, recoded int, skipped_legacy int, relabel int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_up      int := 0;
  v_recode  int := 0;
  v_legacy  int := 0;
  v_relabel int := 0;
  r         record;
  v_first   int;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0, 0, 0; return;
  end if;

  -- Thà không đổi gì còn hơn ghi một mã treo.
  if p_location is not null then
    p_location := upper(trim(p_location));
    if not exists (select 1 from am_location where code = p_location) then
      raise exception 'Mã vị trí % không có trong danh mục', p_location;
    end if;
  end if;
  if p_dept is not null then
    p_dept := upper(trim(p_dept));
    if not exists (select 1 from am_org where code = p_dept and is_department) then
      raise exception 'Mã phòng ban % không có trong danh mục', p_dept;
    end if;
  end if;

  -- --- 1. Vị trí / tình trạng -----------------------------------------
  if p_location is not null or p_status is not null then
    update am_asset a
       set location_code = coalesce(p_location, a.location_code),
           status_code   = coalesce(p_status,   a.status_code)
     where a.id = any(p_ids);
    get diagnostics v_up = row_count;
  end if;

  -- --- 2. Phòng ban: cấp lại mã ----------------------------------------
  if p_dept is not null then
    select count(*) into v_legacy
    from   am_asset a
    where  a.id = any(p_ids) and a.is_legacy and a.dept_code <> p_dept;

    -- Cấp theo từng khối (phòng ban mới, CHỮ) để bộ đếm chỉ nhích một lần mỗi
    -- khối, rồi rải số liên tiếp theo thứ tự id.
    create temp table if not exists _bulk_recode (
      id bigint primary key, letters text, new_seq int
    ) on commit drop;
    delete from _bulk_recode;

    /* am_letters() on both sides: the counter is keyed by the stripped form
       ('MVT', never 'MVT-QR'), and the code has to be built from the same value
       the number came out of, or am_asset_code_ck will disagree with it. */
    for r in
      select am_letters(a.letters) as letters, count(*) as n
      from   am_asset a
      where  a.id = any(p_ids) and not a.is_legacy and a.dept_code <> p_dept
      group by am_letters(a.letters)
    loop
      v_first := am_alloc_asset_seq(p_dept, r.letters, r.n::int, null::bigint, 'bulk_update');
      insert into _bulk_recode (id, letters, new_seq)
      select a.id, r.letters,
             v_first + (row_number() over (order by a.id))::int - 1
      from   am_asset a
      where  a.id = any(p_ids) and not a.is_legacy
        and  a.dept_code <> p_dept and am_letters(a.letters) = r.letters;
    end loop;

    -- Tem đã in mang mã cũ: đếm TRƯỚC khi ghi đè.
    select count(*) into v_relabel
    from   am_asset a join _bulk_recode b on b.id = a.id
    where  a.label_printed;

    update am_asset a
       set dept_code     = p_dept,
           letters       = b.letters,
           seq           = b.new_seq,
           asset_code    = am_build_asset_code(p_dept, a.group_code, b.letters,
                                               a.purchase_year, b.new_seq),
           label_printed = false
      from _bulk_recode b
     where b.id = a.id;
    get diagnostics v_recode = row_count;

    v_up := greatest(v_up, v_recode);
  end if;

  return query select v_up, v_recode, v_legacy, v_relabel;
end $$;

comment on function am_bulk_update(bigint[], text, text, text) is
  'Sửa vị trí / phòng ban / tình trạng cho nhiều tài sản cùng lúc. Bỏ qua tham số null. Đổi phòng ban sẽ CẤP LẠI mã tài sản (giữ nguyên mã vạch) và đặt lại cờ đã in tem; dòng lịch sử được bỏ qua.';

-- ---------------------------------------------------------------------
-- XOÁ HÀNG LOẠT
--
-- Khác am_undo_intake ở hai chỗ, đều có lý do:
--   * CÓ xoá dòng lịch sử — đây chính là chỗ người dùng dọn các dòng trùng của
--     sổ Beetrack cũ.
--   * KHÔNG lùi bộ đếm. Undo chỉ lùi được vì nó biết chắc đợt vừa ghi là phần
--     đuôi của dãy số; một nhóm dòng chọn tay giữa sổ thì không có gì bảo đảm đó.
-- Vẫn giữ nguyên một luật: không xoá tài sản đã nằm trên biên bản tem nhãn đã
-- lưu, vì biên bản là chứng từ đã phát hành.
-- ---------------------------------------------------------------------
drop function if exists am_bulk_delete(bigint[]);

create or replace function am_bulk_delete(p_ids bigint[])
returns table (deleted int, kept_on_receipt int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_del  int := 0;
  v_keep int := 0;
begin
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0; return;
  end if;

  select count(distinct l.asset_id) into v_keep
  from   am_alr_line l where l.asset_id = any(p_ids);

  with gone as (
    delete from am_asset a
    where  a.id = any(p_ids)
      and  not exists (select 1 from am_alr_line l where l.asset_id = a.id)
    returning 1
  )
  select count(*) into v_del from gone;

  return query select v_del, v_keep;
end $$;

comment on function am_bulk_delete(bigint[]) is
  'Xoá nhiều tài sản cùng lúc. Giữ lại dòng đã nằm trên biên bản tem nhãn đã lưu. KHÔNG lùi bộ đếm — số đã cấp coi như đã tiêu.';

grant execute on function am_bulk_update(bigint[], text, text, text) to anon, authenticated;
grant execute on function am_bulk_delete(bigint[]) to anon, authenticated;
