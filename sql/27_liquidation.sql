-- =====================================================================
-- 27_liquidation.sql — THANH LÝ TÀI SẢN, GIAI ĐOẠN 1: ĐỀ XUẤT THANH LÝ (LR)
--                      VÀ KHO CHỜ THANH LÝ (26/09/2026)
--
-- Chạy SAU 26_alr_project.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
-- ⚠ File này THAY các hàm vòng đời bộ hồ sơ của 19 / 20 / 26 (mục 6, 7) và hai
--   chính sách đọc pm_doc / pm_pkg. Sau này lỡ chạy lại 19, 20 hoặc 26 thì chạy
--   lại 27 ngay sau đó, nếu không LR sẽ không gửi / duyệt / thấy được.
--
-- Quyết định của người dùng (26/09/2026):
--   * GỘP LR (Liquidation Request) và Asset Disposal Form: nhập MỘT lần, in ra
--     cả hai mẫu. Số hiệu LID.<bộ phận>.<số>.<năm> (vd LID.KIT.04.2026).
--   * Chuỗi ký như dòng chữ ký trên mẫu LR, AM team KIỂM TRA trước Kế toán
--     trưởng: Người lập → Trưởng BP → DOF → Hotel GM → AM Coordinator (kiểm
--     tra) → AM Executive (kiểm tra) → Kế toán trưởng → Phó TGĐ → TGĐ.
--     Cao ốc / văn phòng JVC theo chuỗi của pháp nhân mình. Sửa ở màn Chuỗi
--     phê duyệt.
--   * Nguyên giá, hao mòn NHẬP TAY (file khấu hao của kế toán nạp sau).
--   * Công cụ dụng cụ (tài sản cùng mã vạch) đi CÙNG quy trình với TSCĐ.
--   * LR duyệt xong: tài sản sang "Chờ thanh lí" (8, mã vạch duy nhất) /
--     "Chờ Thanh lý" (24, cùng mã vạch) và vào KHO CHỜ THANH LÝ (pm_lq_item)
--     — nơi giai đoạn 2 (Hội đồng, đợt thanh lý) lấy ra.
--   * AH cuối của dự án thay thế duyệt xong: các dòng RR ghi "Liquidation"
--     tự thành một LR NHÁP cho người đã lập RR (họ bổ sung rồi gửi).
--
-- Kỹ thuật: LR đi qua đúng cơ chế BỘ HỒ SƠ của dự án (pm_pkg / pm_pkg_step:
-- chuỗi duyệt, chữ ký, Việc cần làm, thông báo, màn ký trên tablet), nhưng bộ
-- hồ sơ gắn với PHÒNG BAN thay vì dự án: pm_pkg.project_code / pm_doc.
-- project_code để trống, dept_code mang phòng ban. Các hàm của vòng đời bộ hồ
-- sơ dưới đây là bản của 19 / 20 / 26 với đúng một thay đổi: phòng ban lấy từ
-- dự án, hoặc từ bộ hồ sơ khi không có dự án.
--
-- Chỉ đụng vào bảng / hàm có tên của app này (am_*, app_*, pm_*); không lệnh
-- nào áp cho cả schema. Cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. KHU QUYỀN "THANH LÝ"
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('liquidation', 'Liquidation', 'Thanh lý', 85)
on conflict (code) do update set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

/* Mặc định (V xem · C lập · E sửa · A duyệt · M quản trị). "do nothing": ô đã
   chỉnh ở màn Phân quyền giữ nguyên. Người duyệt LR cần quyền "duyệt" của khu
   Phê duyệt như mọi bộ hồ sơ; quyền "duyệt" ở đây dành cho Hội đồng (giai đoạn 2). */
with def(role_code, f) as (values
  ('DEPT_STAFF', 'VCE'), ('CP_ADMIN', 'VCE'), ('JVC_ADMIN', 'VCE'), ('HOTEL_AM', 'VCE'), ('PURCHASING', 'V'),
  ('DEPT_HEAD', 'VA'), ('DOF', 'VA'), ('HOTEL_GM', 'VA'), ('CP_MAINT', 'VA'), ('CP_HEAD', 'VA'),
  ('CHIEF_ACC', 'VA'), ('JVC_DGM', 'VA'), ('JVC_GM', 'VA'),
  ('AM_COORD', 'VCEAM'), ('AM_EXEC', 'VCEA'), ('SYS_ADMIN', 'VCEAM'))
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select d.role_code, 'liquidation', d.f like '%V%', d.f like '%C%', d.f like '%E%', d.f like '%A%', d.f like '%M%'
from   def d join app_role r on r.code = d.role_code
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 2. BỘ HỒ SƠ KHÔNG THUỘC DỰ ÁN; LOẠI CHỨNG TỪ LR VÀ CHUỖI KÝ
-- =====================================================================

alter table pm_pkg add column if not exists dept_code text;
alter table pm_doc add column if not exists dept_code text;
alter table pm_pkg alter column project_code drop not null;
alter table pm_doc alter column project_code drop not null;
alter table pm_pkg drop constraint if exists pm_pkg_owner_ck;
alter table pm_pkg add constraint pm_pkg_owner_ck check (project_code is not null or dept_code is not null);
alter table pm_doc drop constraint if exists pm_doc_owner_ck;
alter table pm_doc add constraint pm_doc_owner_ck check (project_code is not null or dept_code is not null);
create index if not exists pm_pkg_dept_idx on pm_pkg (dept_code) where project_code is null;
create index if not exists pm_doc_dept_idx on pm_doc (dept_code) where project_code is null;
comment on column pm_pkg.dept_code is
  'Phòng ban của bộ hồ sơ KHÔNG thuộc dự án (đề xuất thanh lý LR). Bộ hồ sơ của dự án để trống: phòng ban là của dự án.';
comment on column pm_doc.dept_code is 'Như pm_pkg.dept_code.';

-- Sau mọi chứng từ dự án (seq 900), không bắt buộc, lập nhiều lần, bộ riêng.
insert into pm_doc_type (code, prefix, side, seq, required, repeatable, name_en, name_vi)
values ('LR', 'LID', 'operator', 900, false, true, 'Liquidation Request', 'Đề xuất thanh lý tài sản')
on conflict (code) do update
  set prefix = excluded.prefix, side = excluded.side, seq = excluded.seq, required = excluded.required,
      repeatable = excluded.repeatable, name_en = excluded.name_en, name_vi = excluded.name_vi;
update pm_doc_type set grp = null where code = 'LR';

-- "do nothing": chuỗi đã chỉnh ở màn Chuỗi phê duyệt thì giữ nguyên.
with chains(entity, roles) as (values
  ('SSP', array['DEPT_STAFF', 'DEPT_HEAD', 'DOF', 'HOTEL_GM', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM']),
  ('CP',  array['CP_ADMIN', 'CP_MAINT', 'CP_HEAD', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM']),
  ('JVC', array['JVC_ADMIN', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM']))
insert into pm_chain (entity, doc_type, step, role_code, kind)
select c.entity, 'LR', r.ord - 1, r.role, case when r.ord > 1 and r.role in ('AM_COORD', 'AM_EXEC') then 'check' else 'approve' end
from   chains c, unnest(c.roles) with ordinality r(role, ord)
on conflict (entity, doc_type, step) do nothing;


-- =====================================================================
-- 3. KHO CHỜ THANH LÝ
-- =====================================================================

/* Mỗi dòng của một LR đã duyệt là một món chờ thanh lý. Giai đoạn 2 gom các
   món vào đợt thanh lý của Hội đồng (batch_id), giai đoạn 3 ghi kết quả. */
create table if not exists pm_lq_item (
  id             bigserial primary key,
  lr_doc_id      bigint not null references pm_doc(id) on delete cascade,
  line_key       text   not null,
  asset_id       bigint references am_asset(id) on delete set null,
  asset_code     text,
  name           text   not null,
  qty            numeric(18, 3) not null default 1,
  unit           text,
  dept_code      text,
  kind           text check (kind in ('unique', 'low')),
  condition      text,
  reason         text,
  mode           text,
  original_value numeric(18, 2),
  depreciation   numeric(18, 2),
  nbv            numeric(18, 2),
  status         text not null default 'pool' check (status in ('pool', 'batched', 'sold', 'destroyed', 'kept')),
  batch_id       bigint,
  approved_at    timestamptz not null default now(),
  unique (lr_doc_id, line_key)
);
create index if not exists pm_lq_item_status_idx on pm_lq_item (status);
create index if not exists pm_lq_item_asset_idx  on pm_lq_item (asset_id);
comment on table pm_lq_item is
  'Kho chờ thanh lý: mỗi dòng của LR đã duyệt. status pool = chờ vào đợt; batched = đã vào đợt; sold / destroyed = đã xử lý; kept = Hội đồng giữ lại.';


-- =====================================================================
-- 4. ẢNH HIỆN TRẠNG CHO LR (bảng ảnh của 26_alr_project.sql)
-- =====================================================================

/* Ảnh hiện trạng ('condition') là bằng chứng bắt buộc của Disposal Form. Dòng
   LR không có mã tài sản (vd "Mái tôn cũ 399 m2") thì ảnh gắn vào chứng từ +
   dòng (pm_doc_id + line_key) thay vì tài sản. */
alter table am_asset_photo alter column asset_id drop not null;
alter table am_asset_photo add column if not exists line_key text;
alter table am_asset_photo drop constraint if exists am_asset_photo_kind_check;
alter table am_asset_photo add constraint am_asset_photo_kind_check check (kind in ('label', 'overall', 'condition'));
alter table am_asset_photo drop constraint if exists am_asset_photo_owner_ck;
alter table am_asset_photo add constraint am_asset_photo_owner_ck
  check (asset_id is not null or (pm_doc_id is not null and line_key is not null));
create index if not exists am_asset_photo_doc_idx on am_asset_photo (pm_doc_id);

drop policy if exists am_asset_photo_read on am_asset_photo;
create policy am_asset_photo_read on am_asset_photo for select to authenticated
  using ((select app_can('assets', 'view')) or (select app_can('project', 'view')) or (select app_can('liquidation', 'view')));
drop policy if exists am_asset_photo_add on am_asset_photo;
create policy am_asset_photo_add on am_asset_photo for insert to authenticated
  with check (((select app_can('assets', 'view')) or (select app_can('project', 'view')) or (select app_can('liquidation', 'view')))
              and taken_by = auth.uid());

drop policy if exists am_photo_upload on storage.objects;
create policy am_photo_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'am-photo' and ((select app_can('assets', 'view')) or (select app_can('project', 'view'))
                                          or (select app_can('liquidation', 'view'))));
drop policy if exists am_photo_read on storage.objects;
create policy am_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'am-photo' and ((select app_can('assets', 'view')) or (select app_can('project', 'view'))
                                     or (select app_can('liquidation', 'view'))));


-- =====================================================================
-- 5. HÀM PHỤ CỦA THANH LÝ
-- =====================================================================

-- Người đang đăng nhập thấy được hồ sơ thanh lý của phòng ban này không.
create or replace function pm_lq_can_view(p_dept text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or (app_can('liquidation', 'view') and (app_scope_root() or p_dept in (select app_scope_orgs())))
$$;

-- Người lập: khu quyền của loại chứng từ (LR → Thanh lý, còn lại → Dự án) + bước 0 của chuỗi.
create or replace function pm_can_prepare(p_type text, p_dept text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or (app_can(case when p_type = 'LR' then 'liquidation' else 'project' end, 'create')
          and exists (select 1 from pm_chain c
                      where c.entity = pm_entity(p_dept) and c.doc_type = p_type and c.step = 0
                        and app_user_role_covers(auth.uid(), c.role_code, p_dept)))
$$;

-- Số LR kế tiếp của phòng ban trong năm: LID.KIT.04.2026.
create or replace function pm_lq_next_no(p_dept text, p_year int)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'LID.' || p_dept || '.'
      || lpad((coalesce(max(case when split_part(doc_no, '.', 3) ~ '^\d{1,4}$' then split_part(doc_no, '.', 3)::int end), 0) + 1)::text, 2, '0')
      || '.' || p_year
  from   pm_doc
  where  doc_type = 'LR' and split_part(doc_no, '.', 2) = p_dept and split_part(doc_no, '.', 4) = p_year::text
$$;

/* Lập LR (bộ hồ sơ riêng, gắn phòng ban). p_no: số thứ tự muốn dùng (vd tiếp
   theo số LR giấy đã phát hành trong năm); để trống thì lấy số kế tiếp. */
create or replace function pm_lq_create(p_dept text, p_data jsonb default '{}'::jsonb, p_no int default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_year int; v_no text; v_pkg bigint; v_id bigint;
        v_mail text := coalesce(app_claims() ->> 'email', 'sql:' || session_user);
begin
  if not exists (select 1 from am_org where code = p_dept) then
    raise exception 'Không có phòng ban % / No department %', p_dept, p_dept;
  end if;
  if not pm_can_prepare('LR', p_dept) then
    raise exception 'Bạn không phải người lập LR của phòng ban % (xem Chuỗi phê duyệt). / You do not prepare liquidation requests for %.', p_dept, p_dept
      using errcode = '42501';
  end if;
  v_year := coalesce(extract(year from nullif(p_data ->> 'date', '')::date)::int, extract(year from current_date)::int);
  perform pg_advisory_xact_lock(hashtext('pm_lq_no.' || p_dept || '.' || v_year));
  if p_no is not null then
    if p_no < 1 or p_no > 9999 then raise exception 'Số LR không hợp lệ: % / Invalid number', p_no; end if;
    v_no := 'LID.' || p_dept || '.' || lpad(p_no::text, 2, '0') || '.' || v_year;
    if exists (select 1 from pm_doc where doc_type = 'LR' and doc_no = v_no and status <> 'cancelled') then
      raise exception 'Số % đã có trong app. / Number % is already used.', v_no, v_no;
    end if;
  else
    v_no := pm_lq_next_no(p_dept, v_year);
  end if;
  insert into pm_pkg (project_code, dept_code, grp, created_by, created_email, created_name)
  values (null, p_dept, 'LR', auth.uid(), v_mail, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
  returning id into v_pkg;
  perform pm_pkg_log(v_pkg, 'create', null, 'draft');
  insert into pm_doc (project_code, dept_code, doc_type, doc_no, data, total_value, created_by, created_email, pkg_id)
  values (null, p_dept, 'LR', v_no, coalesce(p_data, '{}'::jsonb), nullif(p_data ->> 'total', '')::numeric,
          auth.uid(), v_mail, v_pkg)
  returning id into v_id;
  perform pm_doc_log(v_id, 'create', null, 'draft');
  return v_id;
end $$;

/* Kiểm tra LR trước khi gửi duyệt (lỗi là dừng):
   - có ít nhất một dòng; mỗi dòng có tên, số lượng, hiện trạng, lý do, hình thức;
   - còn giá trị còn lại thì phải giải trình (Disposal Form (**));
   - tài sản trong sổ: chưa thanh lý / huỷ, và không nằm trong một LR khác
     đang duyệt hoặc đã duyệt (trừ khi Hội đồng đã giữ lại). */
create or replace function pm_lq_check(p_pkg bigint)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare d pm_doc; l jsonb; n int := 0; v_bad text; v_dup text; v_nbv numeric;
begin
  select * into d from pm_doc where pkg_id = p_pkg and doc_type = 'LR' and status in ('draft', 'returned') order by id limit 1;
  if d.id is null then raise exception 'Bộ hồ sơ chưa có LR.'; end if;
  for l in select * from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) loop
    n := n + 1;
    if coalesce(trim(l ->> 'name'), '') = '' then raise exception 'Dòng %: thiếu tên tài sản. / Line %: item name missing.', n, n; end if;
    if coalesce(nullif(l ->> 'qty', '')::numeric, 0) <= 0 then raise exception 'Dòng %: số lượng phải > 0. / Line %: quantity.', n, n; end if;
    if coalesce(l ->> 'condition', '') not in ('Like new', 'Poor', 'Damaged') or coalesce(trim(l ->> 'reason'), '') = ''
       or coalesce(l ->> 'mode', '') not in ('Sale', 'Other') then
      raise exception 'Dòng %: cần hiện trạng, lý do và hình thức thanh lý. / Line %: condition, reason and mode are required.', n, n;
    end if;
    v_nbv := coalesce(nullif(l ->> 'original_value', '')::numeric, 0) - coalesce(nullif(l ->> 'depreciation', '')::numeric, 0);
    if v_nbv > 0 and coalesce(trim(l ->> 'nbv_note'), '') = '' then
      raise exception 'Dòng %: còn giá trị còn lại — cần giải trình. / Line %: explain the remaining net book value.', n, n;
    end if;
    if l ->> 'mode' = 'Other' and coalesce(trim(l ->> 'other_note'), '') = '' then
      raise exception 'Dòng %: hình thức "Khác" — nêu lý do không bán được. / Line %: explain why it cannot be sold.', n, n;
    end if;
  end loop;
  if n = 0 then raise exception 'LR chưa có dòng tài sản nào. / The request has no lines.'; end if;

  select string_agg(a.asset_code, ', ') into v_bad
  from   jsonb_array_elements(d.data -> 'lines') l2 join am_asset a on a.id = nullif(l2 ->> 'asset_id', '')::bigint
  where  a.status_code in ('7', '9');
  if v_bad is not null then raise exception 'Tài sản đã thanh lý / đã huỷ: %. / Already liquidated or destroyed: %.', v_bad, v_bad; end if;

  select string_agg(distinct a.asset_code || ' (' || o.doc_no || ')', ', ') into v_dup
  from   jsonb_array_elements(d.data -> 'lines') l2
  join   am_asset a on a.id = nullif(l2 ->> 'asset_id', '')::bigint
  join   pm_doc o on o.doc_type = 'LR' and o.id <> d.id and o.status in ('in_review', 'approved')
  join   lateral jsonb_array_elements(o.data -> 'lines') ol on nullif(ol ->> 'asset_id', '')::bigint = a.id
  where  not exists (select 1 from pm_lq_item i where i.lr_doc_id = o.id and i.asset_id = a.id and i.status = 'kept');
  if v_dup is not null then
    raise exception 'Tài sản đã nằm trong LR khác: %. / Already in another request: %.', v_dup, v_dup;
  end if;
end $$;


-- =====================================================================
-- 6. VÒNG ĐỜI BỘ HỒ SƠ — phòng ban từ dự án, hoặc từ bộ hồ sơ (LR)
-- =====================================================================

create or replace function pm_doc_save(p_id bigint, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; v_dept text;
begin
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ %', p_id; end if;
  v_dept := coalesce((select dept_code from pm_project where code = d.project_code), d.dept_code);
  if d.status not in ('draft', 'returned') then
    raise exception 'Chứng từ % đang ở trạng thái "%" — không sửa được.', d.doc_no, d.status;
  end if;
  if not (d.created_by = auth.uid() or pm_can_prepare(d.doc_type, v_dept)) then
    raise exception 'Chỉ người lập mới sửa được %.', d.doc_no using errcode = '42501';
  end if;
  update pm_doc
     set data = coalesce(p_data, '{}'::jsonb),
         total_value = nullif(p_data ->> 'total', '')::numeric,
         updated_at = now()
   where id = p_id;
end $$;

create or replace function pm_pkg_submit(p_pkg bigint, p_signature jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare k pm_pkg; p pm_project; v_dept text; v_lead text; v_grp text; v_ent text; v_first int; v_from text; v_sig jsonb;
begin
  select * into k from pm_pkg where id = p_pkg for update;
  if k.id is null then raise exception 'Không có bộ hồ sơ % / No package %', p_pkg, p_pkg; end if;
  select * into p from pm_project where code = k.project_code;
  v_dept := coalesce(p.dept_code, k.dept_code);
  v_lead := pm_grp_lead(k.grp);
  v_ent := pm_entity(v_dept);
  if k.status not in ('draft', 'returned') then
    raise exception 'Bộ hồ sơ đang "%" — không gửi được.', k.status;
  end if;
  if not (k.created_by = auth.uid() or pm_can_prepare(v_lead, v_dept)) then
    raise exception 'Chỉ người lập mới gửi được bộ hồ sơ này.' using errcode = '42501';
  end if;
  -- Gửi RR là gửi luôn PR (và ngược lại): chứng từ cùng nhóm của dự án còn nằm
  -- ở bộ khác đang soạn / bị trả về (bộ tách từ trước khi có bộ hồ sơ) được
  -- gộp vào bộ này trước khi gửi.
  v_grp := coalesce((select grp from pm_doc_type where code = k.grp), k.grp);
  if k.project_code is not null and exists (select 1 from pm_doc_type where grp = v_grp) then
    update pm_doc d set pkg_id = k.id
      from pm_pkg o
     where d.pkg_id = o.id and o.id <> k.id and o.project_code = k.project_code
       and o.status in ('draft', 'returned')
       and (o.grp = v_grp or o.grp in (select code from pm_doc_type where grp = v_grp));
    update pm_pkg_event e set pkg_id = k.id
      from pm_pkg o
     where e.pkg_id = o.id and o.id <> k.id and o.project_code = k.project_code
       and o.status in ('draft', 'returned')
       and (o.grp = v_grp or o.grp in (select code from pm_doc_type where grp = v_grp));
    delete from pm_pkg o
     where o.id <> k.id and o.project_code = k.project_code
       and o.status in ('draft', 'returned')
       and (o.grp = v_grp or o.grp in (select code from pm_doc_type where grp = v_grp))
       and not exists (select 1 from pm_doc d where d.pkg_id = o.id);
    if k.grp <> v_grp then
      update pm_pkg set grp = v_grp where id = k.id;
      k.grp := v_grp;
      v_lead := pm_grp_lead(v_grp);
    end if;
  end if;
  if not exists (select 1 from pm_doc where pkg_id = k.id and doc_type = v_lead and status in ('draft', 'returned')) then
    if exists (select 1 from pm_doc d join pm_pkg o on o.id = d.pkg_id
                where o.project_code = k.project_code and d.doc_type = v_lead and o.status = 'in_review') then
      raise exception '% của dự án đang được duyệt ở một bộ khác — không gửi riêng chứng từ này được. Quản trị: chạy 23_pm_pkg_merge.sql.', v_lead;
    end if;
    raise exception 'Bộ hồ sơ chưa có %.', v_lead;
  end if;
  -- Dự án thay thế: RR đi cùng PR.
  if k.grp = 'PR' and p.investment_type ilike '%replace%'
     and not exists (select 1 from pm_doc where pkg_id = k.id and doc_type = 'RR' and status in ('draft', 'returned')) then
    raise exception 'Dự án thay thế: cần lập RR cùng PR trước khi gửi.';
  end if;
  -- Đề xuất thanh lý: các dòng phải đủ và không trùng LR khác.
  if k.grp = 'LR' then perform pm_lq_check(k.id); end if;
  v_sig := pm_sig_check(p_signature);

  delete from pm_pkg_step where pkg_id = k.id;
  insert into pm_pkg_step (pkg_id, step, role_code, kind, owner_prep)
  select k.id, c.step, c.role_code, case when c.kind = 'check' then 'check' else 'approve' end,
         exists (select 1 from pm_doc_type o join pm_chain oc on oc.doc_type = o.code and oc.entity = c.entity and oc.step = 0
                 where o.grp = k.grp and o.side = 'owner' and oc.role_code = c.role_code)
  from   pm_chain c
  where  c.entity = v_ent and c.doc_type = v_lead and c.step > 0;
  select min(step) into v_first from pm_pkg_step where pkg_id = k.id;
  if v_first is null then
    raise exception 'Chưa có chuỗi duyệt cho % của pháp nhân %.', v_lead, coalesce(v_ent, '?');
  end if;

  v_from := k.status;
  update pm_pkg
     set status = 'in_review', current_step = v_first, version = version + 1, prep_signature = v_sig,
         returned_to = null, submitted_at = now(), decided_at = null, updated_at = now(),
         created_name = coalesce(pm_user_name(created_by), created_name)
   where id = k.id;
  update pm_doc d
     set status = case when t.side = 'owner' then 'draft' else 'in_review' end,
         prep_signature = case when t.side = 'owner' then d.prep_signature else v_sig end,
         version = d.version + 1, submitted_at = now(), decided_at = null, updated_at = now()
    from pm_doc_type t
   where t.code = d.doc_type and d.pkg_id = k.id and d.status in ('draft', 'returned');
  -- Ngày đề xuất của dự án = lần đầu PR được gửi đi.
  if k.grp = 'PR' then
    update pm_project set request_date = coalesce(request_date, current_date) where code = p.code;
  end if;
  perform pm_pkg_log(k.id, case when v_from = 'returned' then 'resubmit' else 'submit' end, v_from, 'in_review', v_first);
end $$;

create or replace function pm_pkg_act(p_pkg bigint, p_action text, p_comment text default null,
                                      p_signature jsonb default null, p_target text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  k      pm_pkg;
  p      pm_project;
  s      pm_pkg_step;
  v_dept text;
  v_op   int;
  v_next int;
  v_sig  jsonb;
  v_miss text;
  v_name text := coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email', 'sql:' || session_user);
  v_mail text := coalesce(app_claims() ->> 'email', 'sql:' || session_user);
  d      record;
begin
  select * into k from pm_pkg where id = p_pkg for update;
  if k.id is null then raise exception 'Không có bộ hồ sơ % / No package %', p_pkg, p_pkg; end if;
  if k.status <> 'in_review' then raise exception 'Bộ hồ sơ không ở trạng thái chờ duyệt.'; end if;
  select * into p from pm_project where code = k.project_code;
  v_dept := coalesce(p.dept_code, k.dept_code);
  select * into s from pm_pkg_step where pkg_id = k.id and step = k.current_step;

  if p_action not in ('approve', 'return', 'reject') then
    raise exception 'Thao tác không hợp lệ: %', p_action;
  end if;
  if not app_trusted() then
    if not app_can('approval', 'approve') then
      raise exception 'Bạn không có quyền duyệt.' using errcode = '42501';
    end if;
    if not app_user_role_covers(auth.uid(), s.role_code, v_dept) then
      raise exception 'Bước này cần vai trò % cho phòng ban %.', s.role_code, v_dept using errcode = '42501';
    end if;
    if k.created_by = auth.uid() and not pm_self_ok() then
      raise exception 'Người lập không được tự duyệt bộ hồ sơ của mình.' using errcode = '42501';
    end if;
  end if;
  if p_action in ('return', 'reject') and coalesce(trim(p_comment), '') = '' then
    raise exception 'Trả về hoặc từ chối phải ghi lý do.';
  end if;

  if p_action = 'approve' then
    v_sig := pm_sig_check(p_signature);
    if s.owner_prep then
      -- Mọi PA / MC của nhóm phải được lập rồi.
      select string_agg(o.code, ', ') into v_miss from pm_doc_type o
       where o.grp = k.grp and o.side = 'owner'
         and not exists (select 1 from pm_doc x where x.pkg_id = k.id and x.doc_type = o.code and x.status in ('draft', 'returned'));
      if v_miss is not null then
        raise exception 'Cần lập % trước khi bấm Checked.', v_miss using errcode = '22023';
      end if;
      update pm_doc x set status = 'in_review', prep_signature = v_sig, submitted_at = now(), updated_at = now()
        from pm_doc_type o
       where o.code = x.doc_type and o.side = 'owner' and x.pkg_id = k.id and x.status in ('draft', 'returned');
    end if;
    update pm_pkg_step
       set status = 'approved', acted_by = auth.uid(), acted_email = v_mail, acted_name = v_name,
           acted_at = now(), comment = nullif(trim(p_comment), ''), signature = v_sig
     where id = s.id;
    select min(step) into v_next from pm_pkg_step where pkg_id = k.id and step > s.step and status = 'pending';
    if v_next is not null then
      update pm_pkg set current_step = v_next, updated_at = now() where id = k.id;
      perform pm_pkg_log(k.id, case when s.kind = 'check' then 'check' else 'approve' end, 'in_review', 'in_review', s.step, p_comment);
      return 'in_review';
    end if;
    update pm_pkg set status = 'approved', current_step = null, decided_at = now(), updated_at = now() where id = k.id;
    for d in select x.id from pm_doc x join pm_doc_type o on o.code = x.doc_type
              where x.pkg_id = k.id and x.status = 'in_review' order by o.seq loop
      update pm_doc set status = 'approved', decided_at = now(), updated_at = now() where id = d.id;
      perform pm_doc_apply(d.id);
    end loop;
    perform pm_pkg_log(k.id, case when s.kind = 'check' then 'check' else 'approve' end, 'in_review', 'approved', s.step, p_comment);
    return 'approved';
  end if;

  if p_action = 'return' and coalesce(p_target, 'operator') = 'am' then
    -- Chỉ PA / MC về AM team: lùi về bước kiểm tra-và-lập, bỏ các chữ ký từ đó trở đi.
    select step into v_op from pm_pkg_step where pkg_id = k.id and owner_prep and step < s.step order by step limit 1;
    if v_op is null then
      raise exception 'Chỉ trả về AM team được sau khi AM đã kiểm tra.' using errcode = '22023';
    end if;
    update pm_pkg_step
       set status = 'pending', acted_by = null, acted_email = null, acted_name = null, acted_at = null,
           comment = null, signature = null
     where pkg_id = k.id and step >= v_op;
    update pm_pkg set current_step = v_op, returned_to = 'am', updated_at = now() where id = k.id;
    update pm_doc x set status = 'returned', updated_at = now()
      from pm_doc_type o
     where o.code = x.doc_type and o.side = 'owner' and x.pkg_id = k.id and x.status = 'in_review';
    perform pm_pkg_log(k.id, 'return_am', 'in_review', 'in_review', s.step, p_comment);
    return 'returned_am';
  end if;

  update pm_pkg_step
     set status = case p_action when 'return' then 'returned' else 'rejected' end,
         acted_by = auth.uid(), acted_email = v_mail, acted_name = v_name, acted_at = now(),
         comment = nullif(trim(p_comment), '')
   where id = s.id;
  if p_action = 'return' then
    update pm_pkg set status = 'returned', current_step = null, returned_to = 'operator', updated_at = now() where id = k.id;
    -- Chứng từ phía operator về người lập; PA / MC giữ nội dung, về nháp cho AM.
    update pm_doc x set status = case when o.side = 'owner' then 'draft' else 'returned' end, updated_at = now()
      from pm_doc_type o
     where o.code = x.doc_type and x.pkg_id = k.id and x.status in ('in_review', 'draft', 'returned');
    perform pm_pkg_log(k.id, 'return', 'in_review', 'returned', s.step, p_comment);
    return 'returned';
  end if;
  update pm_pkg set status = 'rejected', current_step = null, decided_at = now(), updated_at = now() where id = k.id;
  update pm_doc set status = 'rejected', decided_at = now(), updated_at = now()
   where pkg_id = k.id and status not in ('cancelled', 'approved');
  perform pm_pkg_log(k.id, 'reject', 'in_review', 'rejected', s.step, p_comment);
  return 'rejected';
end $$;

-- Huỷ cả bộ: người lập khi còn nháp / bị trả về; quản trị dự án (LR: quản trị thanh lý) bất kỳ lúc nào trước khi duyệt xong.
create or replace function pm_pkg_cancel(p_pkg bigint, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare k pm_pkg;
begin
  select * into k from pm_pkg where id = p_pkg for update;
  if k.id is null then raise exception 'Không có bộ hồ sơ %', p_pkg; end if;
  if k.status in ('approved', 'cancelled') then raise exception 'Bộ hồ sơ đã % — không huỷ được.', k.status; end if;
  if not (app_trusted() or app_can(case when k.grp = 'LR' then 'liquidation' else 'project' end, 'admin')
          or (k.created_by = auth.uid() and k.status in ('draft', 'returned'))) then
    raise exception 'Chỉ người lập (khi còn nháp) hoặc quản trị mới huỷ được.' using errcode = '42501';
  end if;
  update pm_pkg set status = 'cancelled', current_step = null, updated_at = now() where id = k.id;
  update pm_doc set status = 'cancelled', updated_at = now() where pkg_id = k.id and status <> 'approved';
  perform pm_pkg_log(k.id, 'cancel', k.status, 'cancelled', null, p_comment);
end $$;

create or replace function pm_inbox()
returns table (pkg_id bigint, doc_id bigint, doc_no text, doc_type text, grp text, project_code text, project_name text,
               dept_code text, total_value numeric, submitted_at timestamptz, step int,
               role_code text, kind text, step_kind text, owner_prep boolean, returned_to text)
language sql
stable
security definer
set search_path = public
as $$
  with docs as (
    select x.pkg_id, string_agg(x.doc_no, ' + ' order by t.seq) as nos,
           (array_agg(x.id order by t.seq))[1] as first_id,
           (array_agg(x.total_value order by t.seq))[1] as total
    from   pm_doc x join pm_doc_type t on t.code = x.doc_type
    where  x.status not in ('cancelled', 'rejected')
    group  by x.pkg_id
  )
  select k.id, dd.first_id, dd.nos, pm_grp_lead(k.grp), k.grp, k.project_code, p.name, coalesce(p.dept_code, k.dept_code), dd.total,
         k.submitted_at, s.step, s.role_code, 'approve', s.kind, s.owner_prep, k.returned_to
  from   pm_pkg k
  join   docs dd       on dd.pkg_id = k.id
  left   join pm_project p on p.code = k.project_code
  join   pm_pkg_step s on s.pkg_id = k.id and s.step = k.current_step
  where  k.status = 'in_review'
    and  (k.project_code is null or p.code is not null)
    and  (k.created_by is distinct from auth.uid() or pm_self_ok())
    and  app_can('approval', 'approve')
    and  app_user_role_covers(auth.uid(), s.role_code, coalesce(p.dept_code, k.dept_code))
  union all
  select k.id, dd.first_id, dd.nos, pm_grp_lead(k.grp), k.grp, k.project_code, p.name, coalesce(p.dept_code, k.dept_code), dd.total,
         k.submitted_at, null, null, 'returned', null, null, k.returned_to
  from   pm_pkg k join docs dd on dd.pkg_id = k.id left join pm_project p on p.code = k.project_code
  where  k.status = 'returned' and k.created_by = auth.uid()
    and  (k.project_code is null or p.code is not null)
  order  by 10 nulls last
$$;

create or replace function pm_next_actors(p_id bigint)
returns table (email text, full_name text)
language sql
stable
security definer
set search_path = public
as $$
  select u.email, u.full_name
  from   pm_doc d
  join   pm_pkg k      on k.id = d.pkg_id
  left   join pm_project p on p.code = k.project_code
  join   pm_pkg_step s on s.pkg_id = k.id and s.step = k.current_step
  join   app_user u    on u.active and (u.id is distinct from k.created_by or pm_self_ok())
  where  d.id = p_id and k.status = 'in_review'
    and  app_user_role_covers(u.id, s.role_code, coalesce(p.dept_code, k.dept_code))
    -- Hàm chạy vượt RLS, nên tự kiểm tra: chỉ trả lời người thấy được dự án / hồ sơ thanh lý.
    and  ((p.code is not null and app_can('project', 'view')
           and (app_scope_root() or p.dept_code in (select app_scope_orgs())))
          or (k.project_code is null and pm_lq_can_view(k.dept_code)))
  order  by u.full_name nulls last, u.email
$$;

create or replace function pm_notify_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare k pm_pkg; p pm_project; s pm_pkg_step; v_dept text; v_nos text; v_lead text; v_first bigint; v_next text;
begin
  select * into k from pm_pkg where id = new.pkg_id;
  if k.id is null then return null; end if;
  select * into p from pm_project where code = k.project_code;
  v_dept := coalesce(p.dept_code, k.dept_code);
  select string_agg(x.doc_no, ' + ' order by t.seq), (array_agg(x.id order by t.seq))[1]
    into v_nos, v_first
    from pm_doc x join pm_doc_type t on t.code = x.doc_type
   where x.pkg_id = k.id and x.status not in ('cancelled');
  v_lead := pm_grp_lead(k.grp);

  -- Việc "chờ duyệt" cũ của bộ này hết đúng rồi: bước đã chuyển, hoặc bộ đã về người lập.
  update pm_notice set read_at = now()
   where pkg_id = k.id and kind = 'todo' and read_at is null;

  if k.status = 'in_review' then
    select * into s from pm_pkg_step where pkg_id = k.id and step = k.current_step;
    insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email, comment)
    select u.id, v_first, k.id, 'todo', v_nos, v_lead, k.project_code, new.actor_email,
           case when new.action = 'return_am' then new.comment end
    from   app_user u
    where  u.active and (u.id is distinct from k.created_by or pm_self_ok())
      and  app_user_role_covers(u.id, s.role_code, v_dept)
      and  exists (select 1 from app_user_role ur
                   join app_permission ap on ap.role_code = ur.role_code
                   where ur.user_id = u.id and ap.module_code = 'approval' and ap.can_approve);
  end if;

  if k.status in ('approved', 'returned', 'rejected', 'cancelled') and new.to_status = k.status
     and k.created_by is not null and k.created_by is distinct from new.actor
     and exists (select 1 from app_user where id = k.created_by) then
    insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email, comment)
    values (k.created_by, v_first, k.id, k.status, v_nos, v_lead, k.project_code, new.actor_email, new.comment);
  end if;

  if k.status = 'approved' and new.to_status = 'approved' and k.project_code is not null then
    select t.code into v_next from pm_doc_type t
     where t.required and t.side = 'operator'
       and t.seq > (select max(x.seq) from pm_doc_type x where x.code = v_lead or x.grp = k.grp)
     order by t.seq limit 1;
    if v_next is not null then
      insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email)
      select u.id, v_first, k.id, 'next', v_nos, v_next, k.project_code, new.actor_email
      from   app_user u
      join   pm_chain c on c.entity = pm_entity(v_dept) and c.doc_type = v_next and c.step = 0
      where  u.active and app_user_role_covers(u.id, c.role_code, v_dept);
    end if;
  end if;
  return null;
end $$;


-- =====================================================================
-- 7. KHI CHỨNG TỪ ĐƯỢC DUYỆT XONG (thay pm_doc_apply của 26_alr_project.sql)
--    Thêm: LR duyệt → kho chờ thanh lý + tình trạng 8 / 24;
--          AH cuối → LR nháp từ các dòng RR "Liquidation".
-- =====================================================================

create or replace function pm_doc_apply(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; v jsonb; r jsonb; v_alr bigint; v_recv text; v_ids bigint[];
        v_rr pm_doc; v_lines jsonb; v_dept text; v_no text; v_pkg bigint; v_lr bigint;
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
  elsif d.doc_type = 'LR' then
    -- Đề xuất thanh lý đã duyệt: mỗi dòng vào kho chờ thanh lý; tài sản trong sổ sang "Chờ thanh lí".
    delete from pm_lq_item where lr_doc_id = d.id and status = 'pool';
    insert into pm_lq_item (lr_doc_id, line_key, asset_id, asset_code, name, qty, unit, dept_code, kind,
                            condition, reason, mode, original_value, depreciation, nbv)
    select d.id, coalesce(nullif(l ->> 'key', ''), n::text), a.id, coalesce(a.asset_code, nullif(l ->> 'asset_code', '')),
           coalesce(nullif(l ->> 'name', ''), '?'), coalesce(nullif(l ->> 'qty', '')::numeric, 1), nullif(l ->> 'unit', ''),
           coalesce(nullif(l ->> 'dept_code', ''), a.dept_code, d.dept_code),
           coalesce(a.asset_kind, case when l ->> 'kind' in ('unique', 'low') then l ->> 'kind' end),
           l ->> 'condition', l ->> 'reason', l ->> 'mode',
           nullif(l ->> 'original_value', '')::numeric, nullif(l ->> 'depreciation', '')::numeric,
           coalesce(nullif(l ->> 'original_value', '')::numeric, 0) - coalesce(nullif(l ->> 'depreciation', '')::numeric, 0)
    from   jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) with ordinality x(l, n)
    left   join am_asset a on a.id = nullif(l ->> 'asset_id', '')::bigint
    on conflict (lr_doc_id, line_key) do nothing;
    update am_asset a set status_code = case when a.asset_kind = 'low' then '24' else '8' end
     where a.id in (select nullif(l ->> 'asset_id', '')::bigint from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) l)
       and coalesce(a.status_code, '') not in ('7', '9', '8', '24');
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
      -- Các dòng RR "Liquidation" thành một LR NHÁP cho người lập RR (một lần cho mỗi dự án).
      select * into v_rr from pm_doc x
       where x.project_code = d.project_code and x.doc_type = 'RR' and x.status = 'approved' order by x.id desc limit 1;
      if v_rr.id is not null and exists (select 1 from pm_doc_type where code = 'LR')
         and not exists (select 1 from pm_doc y where y.doc_type = 'LR' and y.status <> 'cancelled'
                                                  and y.data ->> 'project_code' = d.project_code) then
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                 'key', 'r' || n, 'asset_id', a.id, 'asset_code', coalesce(a.asset_code, l ->> 'asset_code'), 'barcode', a.barcode,
                 'name', coalesce(nullif(concat_ws('/', a.name_vi, a.name_en), ''), l ->> 'asset_item', l ->> 'asset_code'),
                 'qty', coalesce(nullif(l ->> 'qty', '')::numeric, a.qty, 1), 'unit', coalesce(a.unit_code, l ->> 'unit'),
                 'dept_code', a.dept_code, 'location', a.location_code, 'kind', a.asset_kind,
                 'in_use_date', coalesce(a.in_use_date, a.purchase_date),
                 'condition', case l ->> 'condition' when 'Full operational' then 'Like new' when 'Poor' then 'Poor'
                                                     when 'Damaged' then 'Damaged' end,
                 'reason', l ->> 'reason', 'mode', 'Sale',
                 'original_value', coalesce(nullif(l ->> 'original_value', '')::numeric, a.unit_price * coalesce(a.qty, 1))))
               order by n)
          into v_lines
          from jsonb_array_elements(coalesce(v_rr.data -> 'lines', '[]'::jsonb)) with ordinality x(l, n)
          left join am_asset a on a.asset_code = l ->> 'asset_code'
         where l ->> 'after' = 'Liquidation' and coalesce(l ->> 'asset_code', '') <> '';
        if v_lines is not null then
          v_dept := (select dept_code from pm_project where code = d.project_code);
          perform pg_advisory_xact_lock(hashtext('pm_lq_no.' || v_dept || '.' || extract(year from current_date)::int));
          v_no := pm_lq_next_no(v_dept, extract(year from current_date)::int);
          insert into pm_pkg (project_code, dept_code, grp, created_by, created_email, created_name)
          values (null, v_dept, 'LR', v_rr.created_by, v_rr.created_email, coalesce(pm_user_name(v_rr.created_by), v_rr.created_email))
          returning id into v_pkg;
          perform pm_pkg_log(v_pkg, 'create', null, 'draft', null, 'Tự lập từ ' || v_rr.doc_no || ' khi ' || d.doc_no || ' được duyệt');
          insert into pm_doc (project_code, dept_code, doc_type, doc_no, data, created_by, created_email, pkg_id)
          values (null, v_dept, 'LR', v_no,
                  jsonb_build_object('date', current_date, 'dept_code', v_dept, 'project_code', d.project_code,
                                     'rr_doc_no', v_rr.doc_no, 'source', 'RR', 'lines', v_lines),
                  v_rr.created_by, v_rr.created_email, v_pkg)
          returning id into v_lr;
          perform pm_doc_log(v_lr, 'create', null, 'draft', null, 'Tự lập từ ' || v_rr.doc_no);
          -- "AH.… đã duyệt xong — tới lượt bạn lập Đề xuất thanh lý"; bấm vào là mở LR nháp.
          if exists (select 1 from app_user where id = v_rr.created_by) then
            insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code)
            values (v_rr.created_by, v_lr, v_pkg, 'next', d.doc_no, 'LR', d.project_code);
          end if;
        end if;
      end if;
    end if;
  end if;
end $$;


-- =====================================================================
-- 8. RLS — thấy hồ sơ thanh lý theo khu quyền "Thanh lý" và phạm vi phòng ban
-- =====================================================================

drop policy if exists pm_doc_read on pm_doc;
create policy pm_doc_read on pm_doc
  for select to authenticated
  using (exists (select 1 from pm_project p where p.code = project_code)
         or (project_code is null and pm_lq_can_view(dept_code)));
drop policy if exists pm_pkg_read on pm_pkg;
create policy pm_pkg_read on pm_pkg
  for select to authenticated
  using (exists (select 1 from pm_project p where p.code = project_code)
         or (project_code is null and pm_lq_can_view(dept_code)));

alter table pm_lq_item enable row level security;
drop policy if exists pm_lq_item_read on pm_lq_item;
create policy pm_lq_item_read on pm_lq_item
  for select to authenticated using (pm_lq_can_view(dept_code));
revoke all on pm_lq_item from anon;
grant select on pm_lq_item to authenticated;
revoke insert, update, delete on pm_lq_item from authenticated;
do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    execute 'drop trigger if exists app_audit on pm_lq_item';
    execute 'create trigger app_audit after insert or update or delete on pm_lq_item for each row execute function app_audit_row()';
  end if;
end $$;

revoke execute on function pm_lq_can_view(text), pm_can_prepare(text, text), pm_lq_next_no(text, int),
                           pm_lq_create(text, jsonb, int), pm_lq_check(bigint), pm_doc_save(bigint, jsonb),
                           pm_pkg_submit(bigint, jsonb), pm_pkg_act(bigint, text, text, jsonb, text),
                           pm_pkg_cancel(bigint, text), pm_inbox(), pm_next_actors(bigint)
  from public, anon;
grant execute on function pm_lq_can_view(text), pm_can_prepare(text, text), pm_lq_next_no(text, int),
                          pm_lq_create(text, jsonb, int), pm_lq_check(bigint), pm_doc_save(bigint, jsonb),
                          pm_pkg_submit(bigint, jsonb), pm_pkg_act(bigint, text, text, jsonb, text),
                          pm_pkg_cancel(bigint, text), pm_inbox(), pm_next_actors(bigint)
  to authenticated;
-- Nội bộ: không gọi thẳng qua API.
revoke execute on function pm_doc_apply(bigint), pm_notify_trg() from public, anon, authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 9. KIỂM CHỨNG
-- =====================================================================

select 'Khu quyền Thanh lý' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   app_module where code = 'liquidation'
union all
select 'Quyền mặc định của khu Thanh lý (số vai trò)', count(*)::text, '≥ 14',
       case when count(*) >= 14 then '✔' else '✘ HỎNG' end
from   app_permission where module_code = 'liquidation'
union all
select 'Loại chứng từ LR', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pm_doc_type where code = 'LR' and repeatable and not required
union all
select 'Chuỗi ký LR (SSP · CP · JVC)', count(distinct entity)::text, '3', case when count(distinct entity) = 3 then '✔' else '✘ HỎNG' end
from   pm_chain where doc_type = 'LR' and step = 0
union all
select 'Bước AM team KIỂM TRA trong chuỗi LR', count(*)::text, '> 0', case when count(*) > 0 then '✔' else '✘ HỎNG' end
from   pm_chain where doc_type = 'LR' and kind = 'check'
union all
select 'Phó TGĐ JVC có người giữ vai trò (chuỗi LR có bước này)', count(*)::text, '≥ 1',
       case when count(*) >= 1 then '✔' else '⚠ Gán vai trò Phó TGĐ JVC ở Người dùng, hoặc bỏ bước này ở Chuỗi phê duyệt' end
from   app_user_role ur join app_user u on u.id = ur.user_id where ur.role_code = 'JVC_DGM' and u.active
union all
select 'Bộ hồ sơ không cần dự án (project_code bỏ trống được)', count(*)::text, '2',
       case when count(*) = 2 then '✔' else '✘ HỎNG' end
from   information_schema.columns
where  table_schema = 'public' and table_name in ('pm_pkg', 'pm_doc') and column_name = 'project_code' and is_nullable = 'YES'
union all
select 'Kho chờ thanh lý có RLS', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_class where relname = 'pm_lq_item' and relrowsecurity
union all
select 'Trình duyệt ghi thẳng kho chờ thanh lý (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name = 'pm_lq_item' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Ảnh hiện trạng (kind condition) được phép', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ Chạy 26_alr_project.sql trước' end
from   pg_constraint where conname = 'am_asset_photo_kind_check' and pg_get_constraintdef(oid) like '%condition%'
union all
select 'Hàm lập LR', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_lq_create';
