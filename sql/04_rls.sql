-- =====================================================================
-- asset-intake — RLS & quyền
-- Bối cảnh: app tĩnh trên GitHub Pages PUBLIC, anon key phát qua link
-- #sbcfg (không nhúng trong file). Vì key có thể lọt ra ngoài, thiết kế
-- theo hướng "hỏng thì cũng không mất sổ tài sản":
--   * Bảng bộ đếm: KHÔNG cấp quyền ghi trực tiếp — chỉ qua hàm định sẵn.
--   * am_asset / am_counter_log: KHÔNG cho DELETE.
--   * Master data: đọc thoải mái, sửa được (công cụ nội bộ).
-- Chạy SAU 03_functions.sql.
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_asset_seq','am_barcode_seq','am_counter_log','am_shipment',
    'am_shipment_line','am_asset','am_alr','am_alr_line','am_alr_seq',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 1. Master data + dữ liệu nghiệp vụ: đọc/ghi được, KHÔNG xóa được sổ tài sản
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- Nhóm cho phép đầy đủ (kể cả xóa): master data và dữ liệu nháp
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_shipment','am_shipment_line','am_alr','am_alr_line',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_all', t);
    execute format(
      'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
      t || '_all', t);
    execute format('grant select, insert, update, delete on %I to anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Sổ tài sản: thêm & sửa được, KHÔNG xóa (tránh mất mã đã cấp)
--    Muốn loại bỏ một tài sản thì dùng trạng thái/thanh lý, không DELETE.
-- ---------------------------------------------------------------------
drop policy if exists am_asset_read   on am_asset;
drop policy if exists am_asset_write  on am_asset;
drop policy if exists am_asset_modify on am_asset;

create policy am_asset_read   on am_asset for select to anon, authenticated using (true);
create policy am_asset_write  on am_asset for insert to anon, authenticated with check (true);
create policy am_asset_modify on am_asset for update to anon, authenticated using (true) with check (true);
-- cố tình KHÔNG có policy for delete
grant select, insert, update on am_asset to anon, authenticated;

-- Mọi bảng bigserial cần quyền dùng sequence thì INSERT mới chạy được.
-- Bộ đếm nghiệp vụ (am_asset_seq / am_barcode_seq / am_alr_seq) KHÔNG phải
-- sequence của Postgres nên không bị ảnh hưởng bởi lệnh này.
grant usage, select on all sequences in schema public to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Bộ đếm: chỉ đọc. Mọi thay đổi phải đi qua hàm SECURITY DEFINER.
--    Đây là lý do bộ đếm không thể bị "reset" từ trình duyệt.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['am_asset_seq','am_barcode_seq','am_counter_log','am_alr_seq'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Quyền gọi hàm
-- ---------------------------------------------------------------------
grant execute on function am_norm(text)                                   to anon, authenticated;
grant execute on function am_letters(text)                                to anon, authenticated;
grant execute on function am_format_barcode(text, bigint)                 to anon, authenticated;
grant execute on function am_parse_barcode(text)                          to anon, authenticated;
grant execute on function am_build_asset_code(text, text, text, int, int) to anon, authenticated;
grant execute on function am_alloc_asset_seq(text, text, int, bigint, text) to anon, authenticated;
grant execute on function am_alloc_barcode(text, int, bigint, text)       to anon, authenticated;
grant execute on function am_alloc_alr_code()                             to anon, authenticated;
grant execute on function am_seed_asset_seq(text, text, int)              to anon, authenticated;
grant execute on function am_seed_barcode(text, bigint)                   to anon, authenticated;
grant execute on function am_seed_from_codes(text[])                      to anon, authenticated;
grant execute on function am_audit_counters()                             to anon, authenticated;
grant execute on function am_classify(numeric, text, boolean)             to anon, authenticated;
grant execute on function am_resolve_origin(text)                         to anon, authenticated;

-- Các hàm cấp phát phải thuộc sở hữu của vai trò vượt được RLS
alter function am_alloc_asset_seq(text, text, int, bigint, text) owner to postgres;
alter function am_alloc_barcode(text, int, bigint, text)         owner to postgres;
alter function am_alloc_alr_code()                               owner to postgres;
alter function am_seed_asset_seq(text, text, int)                owner to postgres;
alter function am_seed_barcode(text, bigint)                     owner to postgres;
alter function am_seed_from_codes(text[])                        owner to postgres;
