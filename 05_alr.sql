-- =====================================================================
-- asset-intake — Biên bản bàn giao tem nhãn (ALR)
-- Chạy SAU 03_functions.sql. Chạy lại nhiều lần được.
--
-- Số hiệu = 'AL.' + phần ĐUÔI của mã dự án FFE.
--   FFE.CP.28.2023  -> AL.CP.28.2023
--   FFE.KIT.05.2025 -> AL.KIT.05.2025
-- Người lập vẫn sửa tay được; nếu không có mã dự án thì dùng
-- am_alloc_alr_code() để lấy số chạy AL.<n>.
-- =====================================================================

alter table am_alr add column if not exists project_code   text;
alter table am_alr add column if not exists prepared_by    text;
alter table am_alr add column if not exists received_by    text;
alter table am_alr add column if not exists received_dept  text references am_org(code);
alter table am_alr add column if not exists notes_text     text;

comment on column am_alr.project_code is
  'Mã dự án FFE của đợt hàng, vd FFE.KIT.05.2025. Số hiệu biên bản suy ra từ đây.';
comment on column am_alr.notes_text is
  'Phần "Quy trình và lưu ý" in ở cuối biên bản. Lưu theo từng biên bản vì nội dung có thể đổi (bản mẫu 2023 còn nhắc hệ thống Sinnova, nay công ty dùng Beetrack).';

-- ---------------------------------------------------------------------
-- Suy số hiệu biên bản từ mã dự án
-- ---------------------------------------------------------------------
create or replace function am_alr_code_from_project(p_project text)
returns text
language sql
immutable
as $$
  select case
    when p_project is null or btrim(p_project) = '' then null
    when strpos(btrim(p_project), '.') > 0
      then 'AL.' || substring(btrim(p_project) from strpos(btrim(p_project), '.') + 1)
    else 'AL.' || btrim(p_project)
  end
$$;
comment on function am_alr_code_from_project(text) is
  'FFE.CP.28.2023 -> AL.CP.28.2023. Bỏ đúng đoạn đầu tiên, giữ nguyên phần còn lại.';

grant execute on function am_alr_code_from_project(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Dòng tài sản của biên bản, kèm đủ trường để in thẳng ra 8 cột
-- Thứ tự cột in:
--   Stt | Mã tài sản | Tên tài sản | Số lượng | Thông số kỹ thuật
--       | Đơn giá | Vị trí | Tem nhãn
-- ---------------------------------------------------------------------
create or replace view am_alr_print as
select
  l.alr_id,
  l.line_no,
  a.asset_code,
  a.name_vi,
  a.name_en,
  a.qty,
  a.unit_code,
  a.unit_price,
  a.location_code,
  coalesce(loc.name, '') as location_name,
  a.barcode,
  a.asset_kind,
  -- "Thông số kỹ thuật cơ bản": gom ngắn gọn từ các trường spec chi tiết,
  -- bỏ trường rỗng, nối bằng dấu chấm giữa.
  nullif(array_to_string(array_remove(array[
    nullif(btrim(coalesce(a.spec_brand, '')), ''),
    nullif(btrim(coalesce(a.spec_model, '')), ''),
    nullif(btrim(coalesce(a.spec_function, '')), ''),
    nullif(btrim(coalesce(a.spec_capacity, '')), ''),
    case
      when coalesce(a.spec_length, a.spec_width, a.spec_height) is null then null
      else concat_ws(' x ', nullif(btrim(coalesce(a.spec_length, '')), ''),
                            nullif(btrim(coalesce(a.spec_width,  '')), ''),
                            nullif(btrim(coalesce(a.spec_height, '')), ''))
    end,
    nullif(btrim(coalesce(a.spec_material, '')), ''),
    nullif(btrim(coalesce(a.spec_color, '')), ''),
    case when a.serial is null or btrim(a.serial) = '' then null
         else 'S/N ' || btrim(a.serial) end
  ], null), ' · '), '') as spec_summary
from   am_alr_line l
join   am_asset    a   on a.id = l.asset_id
left join am_location loc on loc.code = a.location_code
order by l.alr_id, l.line_no;

grant select on am_alr_print to anon, authenticated;

comment on view am_alr_print is
  'Nguồn in biên bản ALR. spec_summary là bản gom ngắn của các cột spec chi tiết — dùng cho ô "Thông số kỹ thuật cơ bản".';
