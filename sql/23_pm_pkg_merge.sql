-- =====================================================================
-- 23_pm_pkg_merge.sql — GỘP BỘ HỒ SƠ BỊ TÁCH
--
-- Chạy SAU 22_admin_tools.sql. Chạy lại nhiều lần vô hại.
--
--   Khi chuyển sang mô hình bộ hồ sơ (19_pm_workflow.sql), mỗi chứng từ lập
--   từ trước được gói thành MỘT BỘ RIÊNG mang tên loại của nó (bộ "RR", bộ
--   "PA"…). Vì vậy PR và RR của cùng một dự án nằm ở hai bộ khác nhau: màn
--   hình chứng từ không có chấm tròn PR · RR · PA để chuyển qua lại, và RR
--   đi duyệt một mình.
--
--   File này gộp chúng lại: với mỗi dự án, mọi bộ còn hiệu lực thuộc cùng
--   nhóm (PR + RR + PA; QC + MC) dồn vào MỘT bộ — bộ đang chứa PR (QC), nếu
--   không có thì bộ lập sớm nhất. Lịch sử của các bộ được gộp giữ lại.
--   Bộ sau khi gộp:
--     - mọi chứng từ đã duyệt xong  → giữ nguyên "đã duyệt";
--     - còn lại (nháp / đang duyệt / trả về) → về NHÁP, người lập gửi lại cả
--       bộ một lần (chuỗi duyệt cũ của RR riêng lẻ không dùng tiếp được).
--
-- Chỉ đụng tới pm_pkg, pm_pkg_step, pm_pkg_event, pm_doc (và thông báo của
-- các bộ bị gộp, xoá theo khoá ngoại). Không quét bảng theo mẫu tên.
-- =====================================================================

do $$
declare
  r      record;
  v_tgt  bigint;
  v_ok   boolean;
  v_n    int := 0;
begin
  -- Các (dự án, nhóm) có bộ mang tên một loại THÀNH VIÊN của nhóm (RR, PA, MC…)
  -- hoặc có nhiều hơn một bộ còn hiệu lực trong cùng nhóm.
  for r in
    select k.project_code, coalesce(t.grp, k.grp) as grp
      from pm_pkg k
      left join pm_doc_type t on t.code = k.grp
     where k.status not in ('cancelled', 'rejected')
       and coalesce(t.grp, k.grp) in (select grp from pm_doc_type where grp is not null)
     group by k.project_code, coalesce(t.grp, k.grp)
    having count(*) > 1 or bool_or(k.grp <> coalesce(t.grp, k.grp))
  loop
    -- Bộ giữ lại: bộ chứa chứng từ dẫn chuỗi (PR / QC), nếu không thì bộ sớm nhất.
    select k.id into v_tgt
      from pm_pkg k
     where k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp))
     order by exists (select 1 from pm_doc d where d.pkg_id = k.id and d.doc_type = pm_grp_lead(r.grp)
                                               and d.status not in ('cancelled', 'rejected')) desc,
              k.id
     limit 1;

    -- Chứng từ và lịch sử của các bộ còn lại chuyển sang bộ giữ lại.
    update pm_doc d set pkg_id = v_tgt
      from pm_pkg k
     where d.pkg_id = k.id and k.id <> v_tgt
       and k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp));
    update pm_pkg_event e set pkg_id = v_tgt
      from pm_pkg k
     where e.pkg_id = k.id and k.id <> v_tgt
       and k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp));
    -- Các bộ đã rỗng (bước duyệt và thông báo của chúng xoá theo khoá ngoại).
    delete from pm_pkg k
     where k.id <> v_tgt
       and k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp))
       and not exists (select 1 from pm_doc d where d.pkg_id = k.id);

    select coalesce(bool_and(d.status = 'approved'), false) into v_ok
      from pm_doc d where d.pkg_id = v_tgt and d.status not in ('cancelled', 'rejected');

    if v_ok then
      update pm_pkg set grp = r.grp, updated_at = now() where id = v_tgt;
    else
      delete from pm_pkg_step where pkg_id = v_tgt;
      update pm_pkg set grp = r.grp, status = 'draft', current_step = null, returned_to = null,
                        submitted_at = null, decided_at = null, updated_at = now()
       where id = v_tgt;
      update pm_doc set status = 'draft', current_step = null
       where pkg_id = v_tgt and status in ('in_review', 'returned');
    end if;

    -- Không ghi to_status: thông báo (20_pm_notify.sql) không bắn ra cho việc gộp.
    insert into pm_pkg_event (pkg_id, actor_email, actor_name, action, comment)
    values (v_tgt, 'sql:' || session_user, 'Hệ thống', 'merged',
            'Gộp các chứng từ của nhóm ' || r.grp || ' vào một bộ hồ sơ (23_pm_pkg_merge.sql).');
    v_n := v_n + 1;
  end loop;
  raise notice 'Đã gộp % bộ hồ sơ.', v_n;
end $$;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- KIỂM CHỨNG
-- =====================================================================

select 'Bộ mang tên loại thành viên (RR, PA, MC…) còn lại (phải = 0)' as "Mục", count(*)::text as "Thực tế", '0' as "Mong đợi",
       case when count(*) = 0 then '✔' else '✘ HỎNG' end as "Đạt"
from   pm_pkg k join pm_doc_type t on t.code = k.grp
where  t.grp is not null and t.grp <> k.grp and k.status not in ('cancelled', 'rejected')
union all
select 'Dự án có hơn một bộ PR / QC còn hiệu lực (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from  (select project_code, grp from pm_pkg
        where status not in ('cancelled', 'rejected') and grp in (select grp from pm_doc_type where grp is not null)
        group by project_code, grp having count(*) > 1) x
union all
select 'Chứng từ không thuộc bộ nào (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pm_doc where pkg_id is null;
