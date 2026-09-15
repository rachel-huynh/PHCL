-- =====================================================================
-- 11_suggest.sql — GỢI Ý DANH MỤC TỪ LỊCH SỬ
--
-- Phiếu giao hàng KHÔNG chứa mã danh mục, đơn vị tính hay thời gian khấu
-- hao. Trước đây phải điền tay từng dòng. Nhưng sổ cũ đã có ~16.000 dòng,
-- và trong đó "Ghế" luôn là LTU/C2422. Vậy thì tra ngược tên hàng vào sổ
-- là điền sẵn được, kèm số lần đã dùng để người duyệt biết mức tin cậy.
--
-- Hai nguồn, am_product thắng vì đó là ánh xạ do người xác nhận:
--   1. am_product  — bảng ánh xạ tên thô -> danh mục chuẩn.
--   2. am_asset    — thống kê trên chính sổ tài sản.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

-- am_norm() là immutable nên dùng được cho index. Không có index này thì
-- mỗi lần gợi ý là một lần quét toàn bảng.
create index if not exists am_asset_name_norm_ix on am_asset (am_norm(name_vi));

-- ---------------------------------------------------------------------
-- Nhận một mảng tên hàng, trả về gợi ý cho từng tên.
--   n   = số dòng trong sổ đã dùng tổ hợp đó (0 = không có căn cứ)
--   src = 'product' | 'history' | 'none'
-- Không tự ý chọn khi không có căn cứ: trả null và để người dùng điền.
-- ---------------------------------------------------------------------
create or replace function am_suggest_lines(p_names text[])
returns table (
  name              text,
  category_code     text,
  unit_code         text,
  depreciate_months int,
  n                 int,
  src               text
)
language sql
stable
as $$
  with want as (
    select distinct x as name, am_norm(x) as nrm
    from unnest(p_names) as x
    where coalesce(trim(x), '') <> ''
  ),
  prod as (
    select w.name, p.default_category, p.default_unit, p.times_used
    from want w
    join am_product p on p.raw_name_norm = w.nrm
  ),
  -- Danh mục hay gặp nhất cho mỗi tên.
  --
  -- Chỉ gộp nhóm theo category_code. Nếu gộp thêm unit_code / khấu hao thì
  -- thống kê bị phân mảnh: một danh mục dùng 40 lần nhưng rải trên ba đơn vị
  -- tính sẽ thua một danh mục dùng 7 lần nhưng đồng nhất. Đơn vị tính và
  -- khấu hao lấy bằng mode() trong chính nhóm đã thắng.
  hist as (
    select w.name,
           a.category_code,
           mode() within group (order by a.unit_code)         as unit_code,
           mode() within group (order by a.depreciate_months) as depreciate_months,
           count(*)::int as n,
           row_number() over (
             partition by w.name
             order by count(*) desc, a.category_code
           ) as rk
    from want w
    join am_asset a on am_norm(a.name_vi) = w.nrm
    where a.category_code is not null
    group by w.name, a.category_code
  )
  select w.name,
         coalesce(pr.default_category, h.category_code),
         coalesce(pr.default_unit,     h.unit_code),
         h.depreciate_months,
         coalesce(h.n, pr.times_used, 0)::int,
         case
           when pr.name is not null then 'product'
           when h.name  is not null then 'history'
           else 'none'
         end
  from want w
  left join prod pr on pr.name = w.name
  left join hist h  on h.name  = w.name and h.rk = 1;
$$;

comment on function am_suggest_lines(text[]) is
  'Gợi ý mã danh mục / đơn vị tính / khấu hao cho từng tên hàng, học từ am_product và sổ tài sản. Trả n = số dòng làm căn cứ, src = nguồn.';

-- ---------------------------------------------------------------------
-- Các tổ hợp khác cho MỘT tên, để người duyệt xem vì sao lại gợi ý vậy
-- và đổi sang lựa chọn khác nếu cần.
-- ---------------------------------------------------------------------
create or replace function am_suggest_detail(p_name text)
returns table (category_code text, unit_code text, n int)
language sql
stable
as $$
  select a.category_code,
         mode() within group (order by a.unit_code),
         count(*)::int
  from am_asset a
  where am_norm(a.name_vi) = am_norm(p_name)
    and a.category_code is not null
  group by a.category_code
  order by count(*) desc
  limit 20;
$$;

grant execute on function am_suggest_lines(text[]) to anon, authenticated;
grant execute on function am_suggest_detail(text)  to anon, authenticated;
