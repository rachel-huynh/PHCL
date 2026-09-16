-- =====================================================================
-- 13_suggest_terms.sql — GỢI Ý THEO TỪ KHOÁ, KHÔNG PHẢI KHỚP TÊN CHÍNH XÁC
--
-- VÌ SAO: phiếu giao hàng ghi tên là cả một dòng thông số —
--   "RUCKUS ICX 8200 Switch, 48x10/100/1000 Mbps PoE+ ports, 4x25 GbE..."
-- Khớp tên chính xác với am_product không bao giờ chạm tới từ "Switch".
-- Đo trên 73 dòng thật của đợt Sitek: khớp chính xác ra 0 dòng.
--
-- ⚠️ PHẢI khớp theo RANH GIỚI TỪ (\y), không được khớp chuỗi con. Cùng bộ dữ
-- liệu đó, khớp chuỗi con ra 58 dòng nhưng kèm rác trông rất tự tin:
--   "MiVoice Bus License…" -> Vòi / faucet   ("voi" nằm trong "MiVoice")
--   "WatchDog Advance…"    -> Van / Valve    ("van" nằm trong "Advance")
-- Mã danh mục SAI nguy hiểm hơn ô TRỐNG: ô trống thì người duyệt thấy, mã sai
-- thì trôi thẳng vào sổ. Ranh giới từ ra 45 dòng và sạch rác kiểu đó.
--
-- Mỗi gợi ý đều mang theo NGUỒN và MỨC TIN CẬY để người duyệt tự cân nhắc.
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tách am_product thành các từ khoá tra cứu. "Bàn lạnh/Refrigerated table"
-- cho hai từ khoá: "ban lanh" và "refrigerated table".
-- Bỏ từ ngắn hơn 3 ký tự — chúng khớp bừa.
-- ---------------------------------------------------------------------
-- `words` là dạng CHỈ-CHỮ-SỐ, mọi thứ khác thành một khoảng trắng, có đệm hai
-- đầu. So khớp bằng LIKE trên dạng đó cho đúng ngữ nghĩa "ranh giới từ" mà
-- không phải escape ký tự đặc biệt của regex nằm trong chính tên sản phẩm —
-- am_norm KHÔNG bỏ dấu câu, nên tên thật đầy dấu phẩy, ngoặc và gạch chéo.
create or replace view am_product_term as
  select p.id,
         am_norm(trim(x)) as term,
         ' ' || trim(regexp_replace(am_norm(trim(x)), '[^a-z0-9]+', ' ', 'g')) || ' '
           as term_words,
         length(trim(x))  as term_len,
         p.std_name_vi, p.std_name_en,
         p.default_category, p.default_unit, p.times_used
  from   am_product p,
         lateral regexp_split_to_table(p.raw_name, '/') as x
  where  length(trim(x)) >= 3
    and  trim(regexp_replace(am_norm(trim(x)), '[^a-z0-9]+', ' ', 'g')) <> '';

comment on view am_product_term is
  'am_product tách theo dấu "/" thành từ khoá tra cứu cho am_suggest_lines.';

-- ---------------------------------------------------------------------
-- Gợi ý cho từng tên hàng. Thứ tự ưu tiên, dừng ở nguồn đầu tiên có kết quả:
--   1. am_product khớp CHÍNH XÁC tên     -> cao
--   2. sổ tài sản khớp CHÍNH XÁC tên     -> cao nếu >= 3 dòng làm chứng
--   3. am_product khớp TỪ KHOÁ (dài nhất thắng) -> vừa, hoặc thấp nếu từ ngắn
--   4. không có gì                        -> none, để người dùng tự điền
-- ---------------------------------------------------------------------
-- 11_suggest.sql đã tạo hàm này với BỘ CỘT TRẢ VỀ KHÁC (chưa có std_name,
-- matched_term, confidence). PostgreSQL không cho "create or replace" đổi kiểu
-- trả về — báo 42P13 — nên phải bỏ hàm cũ trước. Bỏ xong là mất quyền đã cấp,
-- vì vậy lệnh grant ở cuối file là bắt buộc, không phải thừa.
drop function if exists am_suggest_lines(text[]);

create or replace function am_suggest_lines(p_names text[])
returns table (
  name              text,
  std_name_vi       text,
  std_name_en       text,
  category_code     text,
  unit_code         text,
  depreciate_months int,
  n                 int,
  src               text,
  matched_term      text,
  confidence        text
)
language sql
stable
as $$
  with want as (
    select distinct x as name,
           am_norm(x) as nrm,
           ' ' || trim(regexp_replace(am_norm(x), '[^a-z0-9]+', ' ', 'g')) || ' ' as words
    from unnest(p_names) as x
    where coalesce(trim(x), '') <> ''
  ),

  -- 1. Ánh xạ sản phẩm do người xác nhận, khớp nguyên tên.
  exact_prod as (
    select w.name, p.std_name_vi, p.std_name_en,
           p.default_category, p.default_unit, p.times_used
    from want w join am_product p on p.raw_name_norm = w.nrm
  ),

  -- 2. Thống kê trên chính sổ tài sản, khớp nguyên tên.
  --    Chỉ gộp theo category_code — gộp thêm đơn vị/khấu hao làm phân mảnh.
  hist as (
    select w.name, a.category_code,
           mode() within group (order by a.unit_code)         as unit_code,
           mode() within group (order by a.depreciate_months) as depreciate_months,
           count(*)::int as n,
           row_number() over (partition by w.name
                              order by count(*) desc, a.category_code) as rk
    from want w
    join am_asset a on am_norm(a.name_vi) = w.nrm
    where a.category_code is not null
    group by w.name, a.category_code
  ),

  -- 3. Từ khoá, khớp theo RANH GIỚI TỪ (qua dạng chỉ-chữ-số có đệm khoảng
  --    trắng). Từ dài thắng, nên "access point" thắng "point".
  term_hit as (
    select w.name, tm.std_name_vi, tm.std_name_en,
           tm.default_category, tm.default_unit, tm.term, tm.term_len,
           row_number() over (partition by w.name
                              order by tm.term_len desc, tm.term) as rk
    from want w
    join am_product_term tm
      on w.words like '%' || tm.term_words || '%'
  )

  select w.name,
         coalesce(ep.std_name_vi, th.std_name_vi),
         coalesce(ep.std_name_en, th.std_name_en),
         coalesce(ep.default_category, h.category_code, th.default_category),
         coalesce(ep.default_unit, h.unit_code, th.default_unit),
         h.depreciate_months,
         coalesce(h.n, ep.times_used, 0)::int,
         case when ep.name is not null then 'product'
              when h.name  is not null then 'history'
              when th.name is not null then 'term'
              else 'none' end,
         th.term,
         case when ep.name is not null              then 'high'
              when h.name is not null and h.n >= 3  then 'high'
              when h.name is not null               then 'medium'
              when th.name is not null and th.term_len >= 6 then 'medium'
              when th.name is not null              then 'low'
              else 'none' end
  from want w
  left join exact_prod ep on ep.name = w.name
  left join hist h        on h.name  = w.name and h.rk = 1
  left join term_hit th   on th.name = w.name and th.rk = 1;
$$;

comment on function am_suggest_lines(text[]) is
  'Gợi ý tên chuẩn / danh mục / đơn vị cho từng tên hàng. Ưu tiên am_product khớp đúng, rồi sổ tài sản, rồi TỪ KHOÁ theo ranh giới từ. Trả kèm nguồn, từ đã khớp và mức tin cậy.';

grant execute on function am_suggest_lines(text[]) to anon, authenticated;
grant select on am_product_term to anon, authenticated;

-- ---------------------------------------------------------------------
-- Ghi nhớ một dòng người dùng đã sửa tay, để lần sau tự điền.
-- Chạy lại với cùng tên thì cập nhật, không nhân đôi.
-- ---------------------------------------------------------------------
create or replace function am_remember_product(
  p_raw_name text, p_std_vi text, p_std_en text,
  p_category text, p_unit text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v text;
begin
  if coalesce(trim(p_raw_name), '') = '' then
    raise exception 'tên hàng rỗng';
  end if;
  insert into am_product (raw_name_norm, raw_name, std_name_vi, std_name_en,
                          default_category, default_unit, times_used)
  values (am_norm(p_raw_name), trim(p_raw_name),
          coalesce(nullif(trim(p_std_vi), ''), trim(p_raw_name)),
          nullif(trim(p_std_en), ''), p_category, p_unit, 1)
  on conflict (raw_name_norm) do update
    set std_name_vi      = excluded.std_name_vi,
        std_name_en      = coalesce(excluded.std_name_en, am_product.std_name_en),
        default_category = coalesce(excluded.default_category, am_product.default_category),
        default_unit     = coalesce(excluded.default_unit, am_product.default_unit),
        times_used       = am_product.times_used + 1
  returning raw_name into v;
  return v;
end $$;

grant execute on function am_remember_product(text, text, text, text, text)
  to anon, authenticated;
