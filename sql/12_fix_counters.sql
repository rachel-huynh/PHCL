-- =====================================================================
-- 12_fix_counters.sql — KÉO BỘ ĐẾM LÊN NGANG SỔ
--
-- VÌ SAO LỆCH: 08_seed_counters.sql nạp bộ đếm bằng cách quét MÃ TÀI SẢN
-- trong file Beetrack, còn 10_legacy_assets.sql lại lấy `letters` từ DANH MỤC
-- (vì 860 mã không phân tích được, mà cột letters thì NOT NULL). Dòng nào có
-- mã ghi `LTU` nhưng danh mục ánh xạ sang `FUR` sẽ nằm ở khoá (dept, FUR) với
-- số thứ tự của mã cũ — vượt qua bộ đếm của chính khoá đó.
--
-- Hậu quả nếu không sửa: mã cấp tiếp theo cho khoá đó TRÙNG mã đã có. Đúng
-- thứ mà toàn bộ ứng dụng này sinh ra để ngăn.
--
-- CÁCH SỬA: nạp lại bộ đếm từ chính am_asset — nay nó mới là nơi biết chắc
-- mã nào đã tồn tại. am_seed_asset_seq() dùng greatest() nên KHÔNG BAO GIỜ
-- kéo lùi bộ đếm; chạy lại nhiều lần vô hại.
--
-- Chạy SAU 10_legacy_assets.sql, và chạy lại mỗi lần nạp thêm sổ cũ.
-- =====================================================================

do $$
declare
  r   record;
  n   int := 0;
  nnew int := 0;
begin
  for r in
    select a.dept_code,
           a.letters,
           max(a.seq) as mx,
           (s.dept_code is null) as missing
    from   am_asset a
    left join am_asset_seq s
           on s.dept_code = a.dept_code and s.letters = a.letters
    where  a.seq > 0
    group by a.dept_code, a.letters, (s.dept_code is null)
  loop
    perform am_seed_asset_seq(r.dept_code, r.letters, r.mx);
    n := n + 1;
    if r.missing then nnew := nnew + 1; end if;
  end loop;
  raise notice 'Đã nạp lại % khoá bộ đếm (% khoá trước đó chưa hề có dòng bộ đếm).', n, nnew;
end $$;

-- Supabase SQL Editor chỉ hiện kết quả của câu lệnh CUỐI CÙNG, nên gộp toàn
-- bộ phần kiểm chứng vào một select.
with a as (select * from am_audit_counters())
select 'Tổng số khoá bộ đếm'                  as "Mục", count(*)::text as "Thực tế",
       '> 0'                                  as "Mong đợi",
       case when count(*) > 0 then '✔' else '✘ HỎNG' end as "dat"
from a
union all
select 'Khoá TỤT SAU sổ (phải = 0)',
       count(*) filter (where gap < 0)::text, '0',
       case when count(*) filter (where gap < 0) = 0 then '✔' else '✘ HỎNG' end
from a
union all
select 'Khoá chưa có dòng bộ đếm (phải = 0)',
       count(*) filter (where counter_next = 0)::text, '0',
       case when count(*) filter (where counter_next = 0) = 0 then '✔' else '✘ HỎNG' end
from a
union all
select 'Khoá tụt xa nhất còn lại',
       coalesce(min(gap)::text, '—'), '>= 0',
       case when coalesce(min(gap), 0) >= 0 then '✔' else '✘ HỎNG' end
from a;
