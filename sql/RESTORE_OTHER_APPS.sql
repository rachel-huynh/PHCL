-- =====================================================================
-- RESTORE_OTHER_APPS.sql — TRẢ LẠI QUYỀN CHO CÁC APP KHÁC DÙNG CHUNG PROJECT
--
-- Bản MIGRATE_17 đầu tiên tước quyền của anon trên TOÀN BỘ schema public và
-- xoá mọi policy của bảng tên app_*. Project này dùng chung với:
--   * Công đoàn        cd_phieu, cd_unc, cd_tham_vieng, cd_kv, cd_file  (KHÔNG đăng nhập — sống nhờ anon)
--   * Budget Tracker   bt_doc, bt_blob                                  (KHÔNG đăng nhập — sống nhờ anon)
--   * SSP Dashboard    dashboard_store                                  (anon đọc)
--   * Legal Portal     legal_docs, memos, sops, ..., app_settings       (policy của app_settings bị xoá)
--   * Đối chiếu HĐ     hd_*
-- File này đưa quyền của các app đó về như trước: Legal Portal (schema.sql
-- dòng 13–19) đã cấp ALL cho anon/authenticated/service_role trên mọi bảng,
-- hàm, sequence và đặt default privileges như vậy. Dòng dữ liệu vẫn do policy
-- RLS riêng của từng app quyết định — file này không đổi policy nào của chúng,
-- chỉ dựng lại hai policy của app_settings.
--
-- KHÔNG đụng vào đồ của app tài sản (am_* / pm_* / 6 bảng app_*): chúng vẫn
-- khoá với anon.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

do $$
declare r record;
begin
  -- 1. Bảng, view, sequence của app khác.
  for r in
    select c.oid::regclass::text as n, c.relkind
    from   pg_class c join pg_namespace s on s.oid = c.relnamespace
    where  s.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and  c.relname !~ '^(am|pm)_'
      and  c.relname not in ('app_module', 'app_role', 'app_permission', 'app_user',
                             'app_user_role', 'app_audit')
  loop
    execute format(case when r.relkind = 'S'
                        then 'grant all on sequence %s to anon, authenticated, service_role'
                        else 'grant all on table %s to anon, authenticated, service_role' end, r.n);
  end loop;

  -- 2. Hàm của app khác (chỉ hàm do chính tài khoản này tạo; hàm của extension
  --    không bị bản cũ đụng tới nên không cần trả).
  for r in
    select p.oid::regprocedure::text as n
    from   pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where  s.nspname = 'public' and p.proname !~ '^(am|app|pm)_'
      and  p.proowner = (select oid from pg_roles where rolname = current_user)
  loop
    execute format('grant execute on function %s to public, anon, authenticated, service_role', r.n);
  end loop;
end $$;

-- 3. Default privileges: bảng/hàm mới của các app khác lại tự có quyền như cũ.
--    App tài sản tự tước lại cho đồ của nó bằng app_lock_anon() (17/18/19).
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to public;

-- 4. Legal Portal: hai policy của app_settings (định nghĩa y hệt schema.sql).
do $$
begin
  if to_regclass('public.app_settings') is not null
     and to_regprocedure('public.fn_is_admin()') is not null
     and exists (select 1 from pg_proc where proname = 'fn_has_perm') then
    execute 'drop policy if exists settings_read on public.app_settings';
    execute 'create policy settings_read on public.app_settings for select to authenticated '
            'using (fn_has_perm(''legal'', ''review'') or fn_is_admin())';
    execute 'drop policy if exists settings_write on public.app_settings';
    execute 'create policy settings_write on public.app_settings for all to authenticated '
            'using (fn_is_admin()) with check (fn_is_admin())';
  end if;
end $$;

-- 5. Kiểm tra: mỗi bảng của app khác — RLS, số policy, anon đọc được không.
--    Bảng có "anon đọc" = ✔ và policy như cũ là đã trở lại bình thường.
select c.relname as "Bảng",
       case when c.relrowsecurity then 'bật' else 'tắt' end as "RLS",
       (select count(*) from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname)::text as "Số policy",
       case when has_table_privilege('anon', c.oid, 'select') then '✔' else '✘' end as "Anon đọc",
       case when has_table_privilege('authenticated', c.oid, 'select') then '✔' else '✘' end as "Đăng nhập đọc"
from   pg_class c join pg_namespace s on s.oid = c.relnamespace
where  s.nspname = 'public' and c.relkind in ('r', 'p')
  and  c.relname !~ '^(am|pm)_'
  and  c.relname not in ('app_module', 'app_role', 'app_permission', 'app_user',
                         'app_user_role', 'app_audit')
order  by 1;
