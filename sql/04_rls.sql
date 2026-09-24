-- =====================================================================
-- 04_rls.sql — BẬT RLS + QUYỀN NỀN
--
-- Từ 17_auth.sql trở đi app BẮT BUỘC ĐĂNG NHẬP. File này chỉ còn làm ba việc:
--   * bật RLS trên mọi bảng (chưa có policy = không ai đọc được, trừ postgres),
--   * cấp quyền bảng cho vai `authenticated` — RLS quyết định DÒNG nào,
--   * khoá ghi trực tiếp vào bảng bộ đếm (chỉ qua hàm SECURITY DEFINER).
--
-- Mọi POLICY nằm ở 17_auth.sql. File này KHÔNG cấp gì cho `anon`, nên chạy
-- lại nó sau 17 không mở lại hệ thống. (Bản cũ cấp "for all to anon using
-- (true)" cho gần như mọi bảng — ai có link là đọc/sửa được hết.)
--
-- Chạy SAU 03_functions.sql. Chạy lại nhiều lần vô hại.
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
-- 1. Quyền bảng cho người đã đăng nhập. RLS (17_auth.sql) lọc tiếp theo
--    vai trò và phạm vi phòng ban.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_shipment','am_shipment_line','am_alr','am_alr_line',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Sổ tài sản: KHÔNG có DELETE. Xoá chỉ qua am_undo_intake / am_bulk_delete,
-- là những hàm có luật đi kèm (giữ dòng đã nằm trên biên bản, v.v.).
grant select, insert, update on am_asset to authenticated;

-- Mọi bảng bigserial cần quyền dùng sequence thì INSERT mới chạy được.
-- Bộ đếm nghiệp vụ (am_asset_seq / am_barcode_seq / am_alr_seq) KHÔNG phải
-- sequence của Postgres nên không bị ảnh hưởng bởi lệnh này.
grant usage, select on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------
-- 2. Bộ đếm: chỉ đọc. Mọi thay đổi phải đi qua hàm SECURITY DEFINER.
--    Đây là lý do bộ đếm không thể bị "reset" từ trình duyệt.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['am_asset_seq','am_barcode_seq','am_counter_log','am_alr_seq'] loop
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Quyền gọi hàm — chỉ người đã đăng nhập. Hàm nào ghi dữ liệu thì tự
--    kiểm tra vai trò bên trong bằng app_require() (17_auth.sql).
-- ---------------------------------------------------------------------
grant execute on function am_norm(text)                                   to authenticated;
grant execute on function am_letters(text)                                to authenticated;
grant execute on function am_format_barcode(text, bigint)                 to authenticated;
grant execute on function am_parse_barcode(text)                          to authenticated;
grant execute on function am_build_asset_code(text, text, text, int, int) to authenticated;
grant execute on function am_alloc_asset_seq(text, text, int, bigint, text) to authenticated;
grant execute on function am_alloc_barcode(text, int, bigint, text)       to authenticated;
grant execute on function am_alloc_alr_code()                             to authenticated;
grant execute on function am_seed_asset_seq(text, text, int)              to authenticated;
grant execute on function am_seed_barcode(text, bigint)                   to authenticated;
grant execute on function am_seed_from_codes(text[])                      to authenticated;
grant execute on function am_audit_counters()                             to authenticated;
grant execute on function am_classify(numeric, text, boolean)             to authenticated;
grant execute on function am_resolve_origin(text)                         to authenticated;

-- Các hàm cấp phát phải thuộc sở hữu của vai trò vượt được RLS
alter function am_alloc_asset_seq(text, text, int, bigint, text) owner to postgres;
alter function am_alloc_barcode(text, int, bigint, text)         owner to postgres;
alter function am_alloc_alr_code()                               owner to postgres;
alter function am_seed_asset_seq(text, text, int)                owner to postgres;
alter function am_seed_barcode(text, bigint)                     owner to postgres;
alter function am_seed_from_codes(text[])                        owner to postgres;
