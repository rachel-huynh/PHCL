-- =====================================================================
-- 26_alr_project.sql — BIÊN BẢN BÀN GIAO TEM (AL) TRONG QUY TRÌNH DỰ ÁN (26/09/2026)
--
-- Chạy SAU 25_pm_tender.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Luồng (quyết định của người dùng 26/09/2026):
--   PO duyệt → NHẬN HÀNG từ PO (Thu mua hoặc Hotel Asset Manager): cấp mã tài
--   sản + mã vạch, tình trạng "Chờ duyệt" (120 tài sản mã vạch duy nhất / 119
--   tài sản cùng mã vạch), mỗi lần nhận là một ĐỢT GIAO HÀNG (am_shipment) gắn
--   với dự án và số PO
--   → AL — biên bản bàn giao tem cho đợt đó: lập bởi AM Coordinator, kiểm tra
--   bởi AM Executive, duyệt bởi Kế toán trưởng JVC, NHẬN bởi Hotel Asset Manager
--   → bộ phận dán tem, chụp 2 ảnh / tài sản (tem cận cảnh + toàn cảnh): ảnh lưu
--   trong app (Supabase Storage, bucket "am-photo") hoặc link OneDrive — cả hai
--   cách cùng dùng được để thử
--   → AH (Hotel Asset Manager lập, dòng hàng lấy từ AL) → AH duyệt: tài sản
--   của AH chuyển "Đang sử dụng" (1) / "Hoạt động" (20); AH cuối cùng còn xử lý
--   tài sản bị thay theo RR: Thanh lý → "Chờ thanh lí" (8 / 24), Dự phòng →
--   "Chưa được sử dụng" (2).
--
-- Chỉ đụng vào bảng / hàm có tên của app này (am_*, app_*, pm_*); không lệnh
-- nào áp cho cả schema. Cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. VAI TRÒ HOTEL ASSET MANAGER, QUYỀN NHẬN HÀNG
-- =====================================================================

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('HOTEL_AM', 'SSP', 'Hotel Asset Manager', 'Quản lý tài sản khách sạn', true, 'SOF', 55)
on conflict (code) do nothing;

-- Hotel Asset Manager: nhận hàng (tạo tài sản), lập AH, ký nhận AL.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'HOTEL_AM', m.code,
       true,
       m.code in ('assets', 'project'),
       m.code in ('assets', 'project'),
       m.code in ('project', 'approval'),
       false
from   app_module m where m.code in ('assets', 'master', 'budget', 'project', 'approval', 'payment', 'report')
on conflict (role_code, module_code) do nothing;

-- Thu mua nhận hàng từ PO: được tạo tài sản (chỉ thêm quyền, không bớt quyền nào đã chỉnh).
update app_permission set can_view = true, can_create = true
 where role_code = 'PURCHASING' and module_code = 'assets';
insert into app_permission (role_code, module_code, can_view, can_create)
values ('PURCHASING', 'assets', true, true)
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 2. LOẠI CHỨNG TỪ AL VÀ CHUỖI KÝ
-- =====================================================================

-- Giữa PO (60) / CT (70) và AH (80). Không bắt buộc (dự án cũ không có), lập
-- nhiều lần (mỗi đợt giao hàng một AL). Là một bộ một chứng từ của riêng nó.
insert into pm_doc_type (code, prefix, side, seq, required, repeatable, name_en, name_vi)
values ('AL', 'AL', 'operator', 75, false, true, 'Asset Label Receipt', 'Biên bản bàn giao tem tài sản')
on conflict (code) do update
  set prefix = excluded.prefix, side = excluded.side, seq = excluded.seq, required = excluded.required,
      repeatable = excluded.repeatable, name_en = excluded.name_en, name_vi = excluded.name_vi;
update pm_doc_type set grp = null where code = 'AL';

-- Lập: AM Coordinator · kiểm tra: AM Executive · duyệt: Kế toán trưởng JVC ·
-- nhận: Hotel Asset Manager (cao ốc: Admin cao ốc; văn phòng JVC: Admin JVC).
-- "do nothing": chuỗi đã chỉnh ở màn Chuỗi phê duyệt thì giữ nguyên.
with chains(entity, roles) as (values
  ('SSP', array['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'HOTEL_AM']),
  ('CP',  array['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'CP_ADMIN']),
  ('JVC', array['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_ADMIN']))
insert into pm_chain (entity, doc_type, step, role_code, kind)
select c.entity, 'AL', r.ord - 1, r.role, case when r.role = 'AM_EXEC' then 'check' else 'approve' end
from   chains c, unnest(c.roles) with ordinality r(role, ord)
on conflict (entity, doc_type, step) do nothing;

-- AH của khách sạn do Hotel Asset Manager lập (chỉ đổi khi vẫn là mặc định cũ).
update pm_chain set role_code = 'HOTEL_AM'
 where entity = 'SSP' and doc_type = 'AH' and step = 0 and role_code = 'DEPT_STAFF';


-- =====================================================================
-- 3. ĐỢT GIAO HÀNG GẮN VỚI DỰ ÁN / PO; ALR GẮN VỚI CHỨNG TỪ AL
-- =====================================================================

alter table am_shipment add column if not exists project_code text;
alter table am_shipment add column if not exists po_doc_no    text;
create index if not exists am_shipment_project_idx on am_shipment (project_code);
comment on column am_shipment.project_code is
  'Dự án của đợt nhận hàng (nhận từ PO). Tài sản của đợt mang am_asset.shipment_id = id và purpose_code = mã dự án.';

alter table am_alr add column if not exists pm_doc_id bigint;
comment on column am_alr.pm_doc_id is
  'Chứng từ AL (pm_doc) sinh ra biên bản này khi được duyệt xong — để màn Biên bản tem thấy cả các AL của dự án.';


-- =====================================================================
-- 4. ẢNH TÀI SẢN SAU KHI DÁN TEM
-- =====================================================================

create table if not exists am_asset_photo (
  id           bigserial primary key,
  asset_id     bigint not null references am_asset(id) on delete cascade,
  kind         text not null check (kind in ('label', 'overall')),   -- tem cận cảnh · toàn cảnh
  source       text not null check (source in ('storage', 'link')),
  storage_path text,                                                 -- bucket am-photo
  url          text,                                                 -- link OneDrive / SharePoint
  pm_doc_id    bigint,                                               -- AL đang chụp cho (tham khảo)
  taken_by     uuid default auth.uid(),
  taken_name   text,
  taken_at     timestamptz not null default now(),
  constraint am_asset_photo_src_ck check ((source = 'storage' and storage_path is not null) or (source = 'link' and url ~* '^https://'))
);
create index if not exists am_asset_photo_asset_idx on am_asset_photo (asset_id);
comment on table am_asset_photo is
  'Ảnh bằng chứng đã dán tem: mỗi tài sản cần 1 ảnh tem cận cảnh (label) và 1 ảnh toàn cảnh (overall). Ảnh trong app hoặc link.';

alter table am_asset_photo enable row level security;
revoke all on am_asset_photo from anon;
grant select, insert, delete on am_asset_photo to authenticated;
grant usage, select on sequence am_asset_photo_id_seq to authenticated;
drop policy if exists am_asset_photo_read on am_asset_photo;
create policy am_asset_photo_read on am_asset_photo for select to authenticated
  using ((select app_can('assets', 'view')) or (select app_can('project', 'view')));
drop policy if exists am_asset_photo_add on am_asset_photo;
create policy am_asset_photo_add on am_asset_photo for insert to authenticated
  with check (((select app_can('assets', 'view')) or (select app_can('project', 'view'))) and taken_by = auth.uid());
drop policy if exists am_asset_photo_del on am_asset_photo;
create policy am_asset_photo_del on am_asset_photo for delete to authenticated
  using (taken_by = auth.uid() or (select app_can('assets', 'edit')));

do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    execute 'drop trigger if exists app_audit on am_asset_photo';
    execute 'create trigger app_audit after insert or update or delete on am_asset_photo for each row execute function app_audit_row()';
  end if;
end $$;

-- Bucket riêng, không công khai; ảnh đã thu nhỏ trong trình duyệt (≤ 8 MB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('am-photo', 'am-photo', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists am_photo_upload on storage.objects;
create policy am_photo_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'am-photo' and ((select app_can('assets', 'view')) or (select app_can('project', 'view'))));
drop policy if exists am_photo_read on storage.objects;
create policy am_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'am-photo' and ((select app_can('assets', 'view')) or (select app_can('project', 'view'))));
drop policy if exists am_photo_delete on storage.objects;
create policy am_photo_delete on storage.objects for delete to authenticated
  using (bucket_id = 'am-photo' and (owner = auth.uid() or (select app_can('assets', 'edit'))));


-- =====================================================================
-- 5. KHI CHỨNG TỪ ĐƯỢC DUYỆT XONG (thay pm_doc_apply của 19_pm_workflow.sql)
-- =====================================================================

create or replace function pm_doc_apply(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; v jsonb; r jsonb; v_alr bigint; v_recv text; v_ids bigint[];
begin
  select * into d from pm_doc where id = p_id;
  if d.doc_type = 'PA' then
    update pm_project set assess_date = current_date where code = d.project_code;
  elsif d.doc_type = 'MC' then
    update pm_project set approve_date = current_date where code = d.project_code;
  elsif d.doc_type = 'QC' then
    update pm_project
       set chosen_vendor = coalesce(nullif(d.data ->> 'chosen_vendor', ''), chosen_vendor),
           procurement_type = coalesce(nullif(d.data ->> 'procurement_type', ''), procurement_type)
     where code = d.project_code;
    delete from pm_vendor_score where project_code = d.project_code;
    for v in select * from jsonb_array_elements(coalesce(d.data -> 'vendors', '[]'::jsonb)) loop
      insert into pm_vendor_score (project_code, vendor_name, check_date, total_amount,
                                   ability, technique, finance, total_score, comment, chosen)
      values (d.project_code, v ->> 'name', current_date, nullif(v ->> 'amount', '')::numeric,
              nullif(v ->> 'ability', '')::numeric, nullif(v ->> 'technique', '')::numeric,
              nullif(v ->> 'finance', '')::numeric, nullif(v ->> 'total', '')::numeric,
              nullif(v ->> 'comment', ''), (v ->> 'name') = (d.data ->> 'chosen_vendor'));
    end loop;
  elsif d.doc_type = 'PO' then
    update pm_project
       set purchase_date = current_date,
           contract_value = case when exists (select 1 from pm_doc c where c.project_code = d.project_code
                                                and c.doc_type = 'CT' and c.status = 'approved')
                                 then contract_value else coalesce(d.total_value, contract_value) end,
           chosen_vendor = coalesce(nullif(d.data ->> 'supplier', ''), chosen_vendor)
     where code = d.project_code;
  elsif d.doc_type = 'CT' then
    update pm_project set contract_value = coalesce(nullif(d.data ->> 'value', '')::numeric, contract_value)
     where code = d.project_code;
  elsif d.doc_type = 'AL' then
    -- Biên bản tem đã được nhận: ghi thành một ALR (màn Biên bản tem thấy nó) và đánh dấu tem đã giao.
    select array_agg(x::bigint) into v_ids from jsonb_array_elements_text(coalesce(d.data -> 'asset_ids', '[]'::jsonb)) x;
    select coalesce(acted_name, acted_email) into v_recv from pm_pkg_step
     where pkg_id = (select pkg_id from pm_doc where id = d.id) order by step desc limit 1;
    if not exists (select 1 from am_alr where code = d.doc_no) then
      insert into am_alr (code, issue_date, project_code, shipment_id, prepared_by, received_by, pm_doc_id, notes_text)
      values (d.doc_no, current_date, d.project_code, nullif(d.data ->> 'shipment_id', '')::bigint,
              (select coalesce(created_name, created_email) from pm_pkg where id = d.pkg_id), v_recv, d.id, d.data ->> 'notes')
      returning id into v_alr;
      insert into am_alr_line (alr_id, line_no, asset_id)
      select v_alr, row_number() over (), a.id from am_asset a where a.id = any(coalesce(v_ids, '{}')) order by a.asset_code
      on conflict do nothing;
    end if;
    update am_asset set label_printed = true where id = any(coalesce(v_ids, '{}')) and not label_printed;
  elsif d.doc_type = 'AH' then
    -- Tài sản của biên bản nghiệm thu: vào sử dụng.
    select array_agg(x::bigint) into v_ids from jsonb_array_elements_text(coalesce(d.data -> 'asset_ids', '[]'::jsonb)) x;
    update am_asset set status_code = case when asset_kind = 'low' then '20' else '1' end
     where id = any(coalesce(v_ids, '{}')) and status_code in ('119', '120');
    if coalesce((d.data ->> 'final')::boolean, false) then
      update pm_project
         set handover_date = coalesce(nullif(d.data ->> 'handover_date', '')::date, current_date),
             evaluation = coalesce(nullif(d.data ->> 'evaluation', ''), evaluation)
       where code = d.project_code;
      -- Mọi tài sản còn "Chờ duyệt" của dự án.
      update am_asset set status_code = case when asset_kind = 'low' then '20' else '1' end
       where purpose_code = d.project_code and status_code in ('119', '120');
      -- Tài sản bị thay theo RR đã duyệt của dự án.
      for r in select l from pm_doc x, jsonb_array_elements(coalesce(x.data -> 'lines', '[]'::jsonb)) l
               where x.project_code = d.project_code and x.doc_type = 'RR' and x.status = 'approved' loop
        if coalesce(r ->> 'asset_code', '') = '' then continue; end if;
        if r ->> 'after' = 'Liquidation' then
          update am_asset set status_code = case when asset_kind = 'low' then '24' else '8' end where asset_code = r ->> 'asset_code';
        elsif r ->> 'after' = 'Spare' then
          update am_asset set status_code = '2' where asset_code = r ->> 'asset_code' and asset_kind = 'unique';
        end if;
      end loop;
    end if;
  end if;
end $$;
revoke execute on function pm_doc_apply(bigint) from public, anon, authenticated;


-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Vai trò Hotel Asset Manager' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   app_role where code = 'HOTEL_AM'
union all
select 'Loại chứng từ AL', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pm_doc_type where code = 'AL' and repeatable and not required
union all
select 'Chuỗi ký AL (SSP · CP · JVC, 4 bước mỗi pháp nhân)', count(*)::text, '12', case when count(*) >= 12 then '✔' else '✘ HỎNG' end
from   pm_chain where doc_type = 'AL'
union all
select 'Người lập AH khách sạn', coalesce(max(role_code), '—'), 'HOTEL_AM (hoặc vai trò đã chỉnh)', '✔'
from   pm_chain where entity = 'SSP' and doc_type = 'AH' and step = 0
union all
select 'Thu mua được nhận hàng (assets: tạo)', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   app_permission where role_code = 'PURCHASING' and module_code = 'assets' and can_create
union all
select 'Bảng ảnh tài sản có RLS', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_class where relname = 'am_asset_photo' and relrowsecurity
union all
select 'Khách (anon) đọc bảng ảnh (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants where table_name = 'am_asset_photo' and grantee = 'anon'
union all
select 'Bucket am-photo (riêng tư)', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   storage.buckets where id = 'am-photo' and not public
union all
select 'Chính sách storage cho am-photo', count(*)::text, '3', case when count(*) = 3 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('am_photo_upload', 'am_photo_read', 'am_photo_delete')
union all
select 'Cột dự án / PO trên đợt giao hàng', count(*)::text, '2', case when count(*) = 2 then '✔' else '✘ HỎNG' end
from   information_schema.columns where table_name = 'am_shipment' and column_name in ('project_code', 'po_doc_no');
