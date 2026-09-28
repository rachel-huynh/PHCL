-- =====================================================================
-- 40_asset_dashboard.sql — BẢNG ĐIỀU KHIỂN TÀI SẢN (28/09/2026)
--
-- Chạy SAU 39_count_photo_avatar.sql. Chạy lại nhiều lần vô hại. Không tạo bảng.
--
-- Menu Tổng quan → Bảng điều khiển → Tài sản (user 28/09/2026). Một hàm tổng hợp
-- sẵn ở server (sổ có ~16.000 tài sản — không kéo từng dòng về trình duyệt):
--   · sổ tài sản còn trên sổ: số tài sản, số lượng, giá trị (đơn giá × SL), theo
--     tình trạng, bộ phận, nhóm tài sản, tuổi; tài sản đã mất / thanh lý / huỷ
--   · chất lượng dữ liệu: có ảnh đại diện, đã in tem, cần rà soát, thiếu vị trí /
--     tình trạng; mới thêm 30 ngày
--   · vận hành: sự cố đang mở, 12 tháng qua theo tháng (mở / đóng / chi phí), tài
--     sản sửa nhiều nhất; điều chuyển đang chờ; kiểm kê đang mở + tiến độ; chờ
--     thanh lý; sắp hết bảo hành (90 ngày)
--   · hệ thống kỹ thuật (37): phân bố điểm hiện trạng mới nhất
-- Lọc: p_depts (null = mọi bộ phận trong phạm vi), p_kind ('unique' / 'low' / null).
-- Phạm vi người dùng như sổ tài sản: chỉ bộ phận nằm trong phạm vi của người gọi.
-- =====================================================================

create or replace function am_dashboard(p_depts text[] default null, p_kind text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_out jsonb; v_root boolean; v_scope text[]; v_y int := extract(year from current_date)::int; v_cond jsonb := null;
begin
  perform app_require('assets', 'view');
  v_root := app_scope_root();
  v_scope := array(select app_scope_orgs());
  with a as (
    select x.id, x.asset_code, x.name_vi, x.name_en, x.asset_kind, x.dept_code, x.group_code, x.location_code, x.status_code,
           coalesce(x.qty, 1) as qty, coalesce(x.unit_price, 0) * coalesce(x.qty, 1) as val,
           x.avatar_photo_id, x.label_printed, x.no_label, x.needs_review, x.created_at, x.warranty_until,
           nullif(coalesce(extract(year from x.in_use_date)::int, extract(year from x.purchase_date)::int,
                           case when x.purchase_year >= 1950 then x.purchase_year end), 0) as yr
    from   am_asset x
    where  (v_root or x.dept_code = any (v_scope))
      and  (p_depts is null or x.dept_code = any (p_depts))
      and  (p_kind is null or x.asset_kind = p_kind)),
  live as (select * from a where am_alive(status_code)),
  inc as (
    select i.* from am_incident i join a on a.id = i.asset_id where i.status <> 'cancelled'),
  months as (select generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), interval '1 month')::date as m)
  select jsonb_build_object(
    'as_of', now(),
    'n', (select count(*) from live),
    'units', (select coalesce(sum(qty), 0) from live),
    'value', (select coalesce(sum(val), 0) from live),
    'unique_n', (select count(*) from live where asset_kind = 'unique'),
    'low_n', (select count(*) from live where asset_kind = 'low'),
    'gone_n', (select count(*) from a where not am_alive(status_code)),
    'gone_value', (select coalesce(sum(val), 0) from a where not am_alive(status_code)),
    'new30', (select count(*) from live where created_at >= now() - interval '30 days'),
    'photo_n', (select count(*) from live where avatar_photo_id is not null),
    'label_n', (select count(*) from live where label_printed),
    'label_due', (select count(*) from live where not coalesce(label_printed, false) and not coalesce(no_label, false)),
    'review_n', (select count(*) from live where jsonb_typeof(needs_review) = 'array' and jsonb_array_length(needs_review) > 0),
    'noloc_n', (select count(*) from live where location_code is null or location_code = ''),
    'nostatus_n', (select count(*) from live where status_code is null or status_code = ''),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('code', s, 'n', n, 'v', v) order by n desc)
                           from (select coalesce(status_code, '') s, count(*) n, sum(val) v from a group by 1) q), '[]'),
    'by_dept', coalesce((select jsonb_agg(jsonb_build_object('dept', d, 'n', n, 'units', u, 'v', v, 'photo', ph, 'label', lb) order by n desc)
                         from (select dept_code d, count(*) n, sum(qty) u, sum(val) v, count(avatar_photo_id) ph,
                                      count(*) filter (where label_printed) lb
                               from live group by 1) q), '[]'),
    'by_group', coalesce((select jsonb_agg(jsonb_build_object('code', g, 'name_vi', gv, 'name_en', ge, 'n', n, 'v', v) order by v desc)
                          from (select l.group_code g, cg.name_vi gv, cg.name_en ge, count(*) n, sum(l.val) v
                                from live l left join am_category_group cg on cg.code = l.group_code group by 1, 2, 3) q), '[]'),
    'age', coalesce((select jsonb_object_agg(b, jsonb_build_object('n', n, 'v', v))
                     from (select case when yr is null then 'unk' when v_y - yr <= 5 then 'a' when v_y - yr <= 10 then 'b'
                                       when v_y - yr <= 20 then 'c' else 'd' end b, count(*) n, sum(val) v
                           from live group by 1) q), '{}'),
    'liq_wait', (select count(*) from live where status_code in ('8', '24')),
    'repair_now', (select count(*) from live where status_code in ('3', '5', '6', '25')),
    'warranty90', (select count(*) from live where warranty_until between current_date and current_date + 90),
    'warranty_list', coalesce((select jsonb_agg(w order by w ->> 'until') from (
                        select jsonb_build_object('id', id, 'code', asset_code, 'name', coalesce(name_vi, name_en), 'dept', dept_code, 'until', warranty_until) w
                        from live where warranty_until between current_date and current_date + 90 order by warranty_until limit 12) q), '[]'),
    'inc_open', (select count(*) from inc where status = 'open'),
    'inc_prog', (select count(*) from inc where status = 'in_progress'),
    'inc_cost12', (select coalesce(sum(cost), 0) from inc where status = 'closed' and closed_at >= now() - interval '12 months'),
    'inc_months', (select jsonb_agg(jsonb_build_object('m', to_char(m, 'YYYY-MM'),
                            'opened', (select count(*) from inc where date_trunc('month', reported_at) = m),
                            'closed', (select count(*) from inc where status = 'closed' and date_trunc('month', closed_at) = m),
                            'cost', (select coalesce(sum(cost), 0) from inc where status = 'closed' and date_trunc('month', closed_at) = m)) order by m)
                   from months),
    'inc_top', coalesce((select jsonb_agg(r order by (r ->> 'n')::int desc, (r ->> 'cost')::numeric desc) from (
                  select jsonb_build_object('id', a.id, 'code', a.asset_code, 'name', coalesce(a.name_vi, a.name_en), 'dept', a.dept_code,
                                            'n', count(*), 'cost', coalesce(sum(i.cost), 0)) r
                  from inc i join a on a.id = i.asset_id
                  where i.kind in ('repair', 'breakage') and i.reported_at >= current_date - 365
                  group by a.id, a.asset_code, a.name_vi, a.name_en, a.dept_code
                  order by count(*) desc, coalesce(sum(i.cost), 0) desc limit 10) q), '[]'),
    'tf_pending', (select count(*) from am_transfer t where t.status = 'pending'
                     and (v_root or t.from_dept = any (v_scope) or t.to_dept = any (v_scope))
                     and (p_depts is null or t.from_dept = any (p_depts) or t.to_dept = any (p_depts))),
    'counts_open', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'title', c.title, 'date', c.count_date,
                                'total', (select count(*) from am_count_line l where l.count_id = c.id and not l.extra),
                                'done', (select count(*) from am_count_line l where l.count_id = c.id and not l.extra and l.found is not null),
                                'photos', (select count(*) from am_count_line l where l.count_id = c.id and l.photo_id is not null)) order by c.count_date desc)
                             from am_count c where c.status = 'open'
                               and (v_root or c.depts && v_scope) and (p_depts is null or c.depts && p_depts)), '[]'),
    'count_last', (select max(coalesce(c.closed_at, c.count_date::timestamptz)) from am_count c where c.status = 'closed'
                     and (v_root or c.depts && v_scope) and (p_depts is null or c.depts && p_depts))
  ) into v_out
  from (select 1) one;

  -- Hệ thống kỹ thuật (37_eng_checklist.sql): điểm hiện trạng mới nhất của từng hạng mục.
  if to_regclass('public.am_cond') is not null and app_can('eng', 'view') then
    execute $q$
      select jsonb_build_object('items', (select count(*) from am_sys_item where active),
             'assessed', count(*), 'low', count(*) filter (where score <= 2),
             'dist', jsonb_build_object('1', count(*) filter (where score = 1), '2', count(*) filter (where score = 2), '3', count(*) filter (where score = 3),
                                        '4', count(*) filter (where score = 4), '5', count(*) filter (where score = 5)),
             'plan5', coalesce(sum(est_cost) filter (where action in ('repair', 'overhaul', 'replace')
                                                     and (target_year is null or target_year <= extract(year from current_date)::int + 5)), 0))
      from (select distinct on (c.item_id) c.* from am_cond c join am_sys_item i on i.id = c.item_id and i.active
            order by c.item_id, c.assessed_on desc, c.id desc) z $q$ into v_cond;
  end if;
  return v_out || jsonb_build_object('cond', v_cond);
end $$;

revoke execute on function am_dashboard(text[], text) from public, anon;
grant execute on function am_dashboard(text[], text) to authenticated;

select app_lock_anon();

select 'Hàm bảng điều khiển tài sản' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi", case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_proc where proname = 'am_dashboard';
