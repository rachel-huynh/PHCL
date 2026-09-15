-- =====================================================================
-- ⛔ XOÁ SẠCH — CHỈ DÙNG KHI MUỐN LÀM LẠI TỪ ĐẦU
--
-- File này XOÁ VĨNH VIỄN mọi bảng, view và hàm có tên bắt đầu bằng "am_",
-- KÈM TOÀN BỘ DỮ LIỆU: sổ tài sản, bộ đếm, nhật ký cấp phát, biên bản.
-- KHÔNG CÓ CÁCH HOÀN TÁC.
--
-- ⚠️ Mất bộ đếm nghĩa là mất dấu những số đã cấp. Nếu đã từng cấp mã cho
--    tài sản thật, sau khi chạy file này PHẢI nạp lại bộ đếm từ sổ đầy đủ
--    trước khi cấp mã tiếp, nếu không sẽ cấp TRÙNG mã với tài sản cũ.
--
-- Bình thường KHÔNG cần file này: ALL_IN_ONE.sql chạy lại được nhiều lần
-- mà không xoá dữ liệu (if not exists / on conflict do update).
--
-- Chỉ dùng khi: muốn thử lại trên project trống, hoặc schema đã hỏng nặng.
--
-- CÁCH DÙNG: bỏ dấu chú thích của khối DO bên dưới rồi chạy.
-- =====================================================================

/*
do $$
declare r record;
begin
  -- view trước (phụ thuộc vào bảng)
  for r in
    select table_name from information_schema.views
     where table_schema = 'public' and table_name like 'am\_%'
  loop
    execute format('drop view if exists %I cascade', r.table_name);
  end loop;

  -- rồi tới bảng
  for r in
    select tablename from pg_tables
     where schemaname = 'public' and tablename like 'am\_%'
  loop
    execute format('drop table if exists %I cascade', r.tablename);
  end loop;

  -- cuối cùng là hàm (phải kèm chữ ký vì có hàm trùng tên khác tham số)
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'am\_%'
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;
*/

-- Kiểm tra sau khi xoá — cả ba số phải bằng 0
select
  (select count(*) from pg_tables
    where schemaname = 'public' and tablename like 'am\_%')          as con_bang,
  (select count(*) from information_schema.views
    where table_schema = 'public' and table_name like 'am\_%')       as con_view,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'am\_%')           as con_ham;
