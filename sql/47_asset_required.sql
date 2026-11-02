-- =====================================================================
-- 47_asset_required.sql — THÔNG TIN BẮT BUỘC CỦA TÀI SẢN (user 30/10 và 01/11/2026)
--
-- Bắt buộc (người dùng chốt 01/11/2026): mã danh mục, tên, mã tài sản, mã vạch, mã vị trí,
-- mã tình trạng, mã phòng ban.
--   · mã danh mục, mã phòng ban: cột NOT NULL + khoá ngoại có từ 01_schema.sql;
--   · tên, mã tài sản, mã vạch: NOT NULL từ trước, nay không được để TRỐNG (chuỗi rỗng);
--   · mã vị trí, mã tình trạng: tài sản MỚI phải có; tài sản đang có không được xoá trống.
-- Tài sản cũ đang thiếu mã vị trí / tình trạng được giữ nguyên (sửa các trường khác vẫn được)
-- cho tới khi có người điền — câu kiểm tra cuối file đếm chúng; ở sổ tài sản gõ "-" vào ô lọc
-- của cột Vị trí / Tình trạng để thấy danh sách.
--
-- Mã công ty thành viên KHÔNG còn phải nhập: để trống thì lấy theo phòng ban — chi nhánh
-- (level BRANCH: SOF, CP, JVC) chứa phòng ban đó (am_dept_company). Cột vẫn NOT NULL.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

-- Công ty thành viên của một phòng ban: chính nó nếu là chi nhánh, không thì chi nhánh gần nhất phía trên.
create or replace function am_dept_company(p_dept text)
returns text language sql stable security definer set search_path = public as $$
  with recursive up as (
    select o.code, o.level, o.parent_code, 0 as d from am_org o where o.code = p_dept
    union all
    select o.code, o.level, o.parent_code, up.d + 1 from am_org o join up on o.code = up.parent_code where up.d < 10
  )
  select coalesce((select code from up where level = 'BRANCH' order by d limit 1), 'SOF')
$$;

create or replace function am_asset_required()
returns trigger language plpgsql as $$
declare v_who text := coalesce(nullif(trim(new.asset_code), ''), new.barcode, '');
begin
  -- Công ty: để trống thì theo phòng ban.
  if coalesce(trim(new.company_code), '') = '' and new.dept_code is not null then
    new.company_code := am_dept_company(new.dept_code);
  end if;
  if coalesce(trim(new.name_vi), '') = '' then
    raise exception 'Tài sản % phải có tên. / Asset % needs a name.', v_who, v_who using errcode = '23502';
  end if;
  if coalesce(trim(new.asset_code), '') = '' then
    raise exception 'Tài sản (mã vạch %) phải có mã tài sản. / Asset (barcode %) needs an asset code.', new.barcode, new.barcode using errcode = '23502';
  end if;
  if coalesce(trim(new.barcode), '') = '' then
    raise exception 'Tài sản % phải có mã vạch. / Asset % needs a barcode.', v_who, v_who using errcode = '23502';
  end if;
  if tg_op = 'INSERT' or new.location_code is distinct from old.location_code then
    if coalesce(trim(new.location_code), '') = '' then
      raise exception 'Tài sản % phải có mã vị trí. / Asset % needs a location code.', v_who, v_who using errcode = '23502';
    end if;
  end if;
  if tg_op = 'INSERT' or new.status_code is distinct from old.status_code then
    if coalesce(trim(new.status_code), '') = '' then
      raise exception 'Tài sản % phải có mã tình trạng. / Asset % needs a status code.', v_who, v_who using errcode = '23502';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists am_asset_required on am_asset;
create trigger am_asset_required before insert or update of location_code, status_code, name_vi, asset_code, barcode, company_code on am_asset
  for each row execute function am_asset_required();

comment on function am_asset_required() is
  'Bắt buộc: tên, mã tài sản, mã vạch (không rỗng); tài sản mới phải có location_code, status_code và không được xoá trống; company_code để trống thì theo phòng ban (47_asset_required.sql).';

revoke execute on function am_dept_company(text) from public, anon;
grant execute on function am_dept_company(text) to authenticated;

select app_lock_anon();

-- Kiểm tra: tài sản hiện đang thiếu (cần điền dần).
select count(*) filter (where coalesce(trim(location_code), '') = '') as thieu_ma_vi_tri,
       count(*) filter (where coalesce(trim(status_code), '') = '')   as thieu_ma_tinh_trang,
       count(*) filter (where coalesce(trim(name_vi), '') = '')       as thieu_ten
from   am_asset;
