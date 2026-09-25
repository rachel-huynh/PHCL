-- =====================================================================
-- 19_pm_workflow.sql — QUẢN LÝ DỰ ÁN, GIAI ĐOẠN 3: LUỒNG DUYỆT CHỨNG TỪ
--
-- Chạy SAU 18_pm_budget.sql.
--
--   pm_doc_type   tám loại chứng từ theo đúng thứ tự của tài liệu FFE:
--                 PR → RR → PA → QC → MC → PO → CT (hợp đồng) → AH
--   pm_chain      chuỗi duyệt theo PHÁP NHÂN × LOẠI CHỨNG TỪ. Bước 0 là vai trò
--                 được LẬP; bước 1..n là người duyệt theo thứ tự. Sửa trong app.
--   pm_doc        một chứng từ: số hiệu, trạng thái, nội dung (jsonb)
--   pm_pkg        BỘ HỒ SƠ đi chung một chuỗi duyệt: PR + RR + PA, QC + MC; PO, CT,
--                 AH mỗi cái một bộ. pm_pkg_step: chuỗi của MỘT lần gửi (dựng lại
--                 mỗi lần gửi lại), chữ ký áp cho mọi chứng từ trong bộ.
--                 pm_pkg_event: lịch sử của bộ.
--   pm_doc_step   (không còn dùng — trước 26/09/2026 mỗi chứng từ một chuỗi)
--   pm_doc_event  lịch sử từng chứng từ (lập, sửa quản trị)
--
-- Trình duyệt KHÔNG ghi thẳng vào ba bảng chứng từ. Tạo, lưu, gửi, duyệt, trả
-- về, từ chối, huỷ đều đi qua hàm dưới đây, và hàm giữ các luật:
--   * đúng thứ tự: chứng từ trước phải được duyệt xong mới lập được chứng từ
--     sau (RR chỉ bắt buộc khi loại đầu tư là Replacement; hợp đồng không bắt
--     buộc — mua nhỏ đi thẳng PO → AH);
--   * đúng người: vai trò của bước hiện tại, phạm vi bao được phòng ban của
--     dự án, và có quyền "duyệt" trong ma trận quyền;
--   * người lập KHÔNG BAO GIỜ tự duyệt chứng từ của chính mình;
--   * AM team KIỂM TRA (không duyệt) hồ sơ operator nộp lên và lập PA / MC ở
--     bước kiểm tra; Kế toán trưởng / GM JVC trả về được người lập hoặc AM team;
--   * trả về / từ chối bắt buộc có lý do.
-- Duyệt xong bước cuối thì các mốc của dự án tự cập nhật (ngày đánh giá, ngày
-- mua, giá trị hợp đồng, ngày nghiệm thu...), nên báo cáo giai đoạn 2 chạy theo.
--
-- Chạy lại nhiều lần vô hại. Chuỗi duyệt đã sửa trong app KHÔNG bị ghi đè.
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_doc_type (
  code       text primary key,
  prefix     text not null,
  side       text not null check (side in ('operator', 'owner')),
  seq        int  not null,
  required   boolean not null default true,
  repeatable boolean not null default false,
  name_en    text not null,
  name_vi    text not null
);
comment on column pm_doc_type.repeatable is
  'Lập được nhiều lần trong một dự án — chỉ AH (nghiệm thu từng phần rồi toàn bộ).';

insert into pm_doc_type (code, prefix, side, seq, required, repeatable, name_en, name_vi) values
  ('PR', 'PR', 'operator', 10, true,  false, 'Purchase Request',    'Yêu cầu mua sắm'),
  ('RR', 'RR', 'operator', 20, false, false, 'Replacement Request', 'Yêu cầu thay thế / cải tạo / nâng cấp'),
  ('PA', 'PA', 'owner',    30, true,  false, 'Project Assessment',  'Đánh giá dự án'),
  ('QC', 'QC', 'operator', 40, true,  false, 'Scoring Tender Form', 'Bảng so sánh đánh giá nhà thầu'),
  ('MC', 'MC', 'owner',    50, true,  false, 'Market Check',        'Kiểm tra giá thị trường'),
  ('PO', 'PO', 'operator', 60, true,  false, 'Purchase Order',      'Đơn đặt hàng'),
  ('CT', 'CT', 'operator', 70, false, false, 'Contract',            'Hợp đồng'),
  ('AH', 'AH', 'operator', 80, true,  true,  'Asset Handover',      'Biên bản nghiệm thu')
on conflict (code) do update
  set prefix = excluded.prefix, side = excluded.side, seq = excluded.seq, required = excluded.required,
      repeatable = excluded.repeatable, name_en = excluded.name_en, name_vi = excluded.name_vi;

-- Nhóm duyệt cùng (pm_doc_type.grp, quyết định 25/09/2026): AM team kiểm tra PR
-- (và RR với dự án thay thế) rồi lập PA làm cơ sở để JVC duyệt; kiểm tra QC rồi
-- lập MC làm cơ sở để JVC duyệt QC. JVC duyệt PR + RR + PA một lần, QC + MC một
-- lần. Cột grp được thêm ở cuối mục 3 (cần pm_entity để chuyển dữ liệu cũ).

create table if not exists pm_chain (
  entity    text not null check (entity in ('SSP', 'CP', 'JVC')),
  doc_type  text not null references pm_doc_type(code) on update cascade on delete cascade,
  step      int  not null check (step >= 0),
  role_code text not null references app_role(code) on update cascade,
  primary key (entity, doc_type, step)
);
comment on column pm_chain.step is '0 = vai trò được LẬP chứng từ; 1..n = người duyệt theo thứ tự.';

create table if not exists pm_doc (
  id           bigserial primary key,
  project_code text not null references pm_project(code) on update cascade on delete cascade,
  doc_type     text not null references pm_doc_type(code),
  doc_no       text not null,
  version      int  not null default 0,
  status       text not null default 'draft'
               check (status in ('draft', 'in_review', 'returned', 'rejected', 'approved', 'cancelled')),
  current_step int,
  data         jsonb not null default '{}'::jsonb,
  total_value  numeric(18, 2),
  created_by   uuid,
  created_email text,
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  decided_at   timestamptz,
  updated_at   timestamptz not null default now()
);
create index if not exists pm_doc_project_idx on pm_doc (project_code);
create index if not exists pm_doc_status_idx  on pm_doc (status);
-- Chữ ký tay của người lập khi gửi duyệt (giai đoạn 4). Người duyệt ký vào pm_doc_step.signature.
alter table pm_doc add column if not exists prep_signature jsonb;
comment on column pm_doc.version is 'Số lần đã gửi duyệt. Mỗi lần bị trả về rồi gửi lại tăng 1.';

create table if not exists pm_doc_step (
  id          bigserial primary key,
  doc_id      bigint not null references pm_doc(id) on delete cascade,
  step        int  not null,
  role_code   text not null,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'returned', 'rejected')),
  acted_by    uuid,
  acted_email text,
  acted_at    timestamptz,
  comment     text,
  signature   jsonb,
  unique (doc_id, step)
);
comment on column pm_doc_step.signature is 'Chữ ký tay trên iPad (giai đoạn 4). Để trống ở giai đoạn 3.';

create table if not exists pm_doc_event (
  id          bigserial primary key,
  doc_id      bigint not null references pm_doc(id) on delete cascade,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_email text,
  action      text not null,
  from_status text,
  to_status   text,
  step        int,
  comment     text
);
create index if not exists pm_doc_event_doc_idx on pm_doc_event (doc_id, at);

/* BỘ HỒ SƠ (quyết định 26/09/2026). Chứng từ đi theo BỘ qua MỘT chuỗi duyệt:
     bộ PR   = PR + RR (dự án thay thế) + PA (AM team lập ở bước kiểm tra)
     bộ QC   = QC + MC (AM team lập ở bước kiểm tra)
     PO, CT, AH: mỗi chứng từ là một bộ riêng.
   Chuỗi duyệt, trạng thái và chữ ký nằm ở BỘ (pm_pkg, pm_pkg_step) — một lần
   duyệt / kiểm tra là ký cho mọi chứng từ trong bộ. Nội dung vẫn ở pm_doc. */
create table if not exists pm_pkg (
  id             bigserial primary key,
  project_code   text not null references pm_project(code) on update cascade on delete cascade,
  grp            text not null,
  status         text not null default 'draft'
                 check (status in ('draft', 'in_review', 'returned', 'rejected', 'approved', 'cancelled')),
  current_step   int,
  version        int  not null default 0,
  returned_to    text check (returned_to in ('operator', 'am')),
  created_by     uuid,
  created_email  text,
  created_name   text,
  prep_signature jsonb,
  created_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  decided_at     timestamptz,
  updated_at     timestamptz not null default now()
);
create index if not exists pm_pkg_project_idx on pm_pkg (project_code);
comment on column pm_pkg.grp is 'Nhóm của bộ: PR, QC (theo pm_doc_type.grp) hoặc mã loại với bộ một chứng từ (PO, CT, AH).';
comment on column pm_pkg.returned_to is 'Lần trả về gần nhất: operator = về người lập cả bộ; am = chỉ PA / MC về AM team làm lại.';

create table if not exists pm_pkg_step (
  id          bigserial primary key,
  pkg_id      bigint not null references pm_pkg(id) on delete cascade,
  step        int  not null,
  role_code   text not null,
  kind        text not null default 'approve' check (kind in ('approve', 'check')),
  owner_prep  boolean not null default false,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'returned', 'rejected')),
  acted_by    uuid,
  acted_email text,
  acted_name  text,
  acted_at    timestamptz,
  comment     text,
  signature   jsonb,
  unique (pkg_id, step)
);
comment on column pm_pkg_step.owner_prep is
  'Bước AM team kiểm tra VÀ lập PA / MC: bấm Checked là ký kiểm tra PR / RR (QC) và ký "Prepared by" trên PA (MC).';

create table if not exists pm_pkg_event (
  id          bigserial primary key,
  pkg_id      bigint not null references pm_pkg(id) on delete cascade,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_email text,
  actor_name  text,
  action      text not null,
  from_status text,
  to_status   text,
  step        int,
  comment     text
);
create index if not exists pm_pkg_event_pkg_idx on pm_pkg_event (pkg_id, at);

alter table pm_doc add column if not exists pkg_id bigint references pm_pkg(id) on delete cascade;
create index if not exists pm_doc_pkg_idx on pm_doc (pkg_id);


-- =====================================================================
-- 2. CHUỖI DUYỆT MẶC ĐỊNH (theo quyết định 24/09 và 25/09/2026)
--   [JVC] = AM Coordinator (kiểm tra) → AM Executive (kiểm tra)
--           → Chief Accountant (duyệt) → JVC GM (duyệt)
--   SSP: Dept Staff lập (QC, PO, CT: Purchasing lập) → Dept Head → DOF → Hotel GM → [JVC]
--   CP : Office Building Admin lập → Maintenance Manager → Head of Office Building → [JVC]
--   JVC: JVC Admin lập → [JVC]
--   PA, MC (chứng từ của chủ đầu tư), mọi pháp nhân:
--        AM Coordinator lập → AM Executive (kiểm tra) → Chief Accountant → JVC GM
--
-- Mỗi bước có một kiểu (pm_chain.kind):
--   approve  duyệt;
--   check    KIỂM TRA — AM team không duyệt hồ sơ operator nộp lên, họ kiểm
--            tra trước khi JVC duyệt (và lập PA / MC làm cơ sở cho JVC).
-- Bộ PR (PR + RR + PA) và bộ QC (QC + MC) đi theo chuỗi của PR / QC; chuỗi
-- của RR, PA, MC chỉ còn dùng bước 0 (ai lập). Bước của AM Coordinator trong
-- chuỗi PR / QC là bước kiểm tra VÀ lập PA / MC.
-- "on conflict do nothing": chuỗi đã sửa trong app không bị ghi đè.
-- =====================================================================

with chains(entity, doc_type, roles) as (
  select e, d,
    case
      when d in ('PA', 'MC') then array['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_GM']
      when e = 'SSP' then array[case when d in ('QC', 'PO', 'CT') then 'PURCHASING' else 'DEPT_STAFF' end,
                                'DEPT_HEAD', 'DOF', 'HOTEL_GM', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_GM']
      when e = 'CP'  then array['CP_ADMIN', 'CP_MAINT', 'CP_HEAD', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_GM']
      else                array['JVC_ADMIN', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_GM']
    end
  from unnest(array['SSP', 'CP', 'JVC']) e, unnest(array['PR', 'RR', 'PA', 'QC', 'MC', 'PO', 'CT', 'AH']) d
)
insert into pm_chain (entity, doc_type, step, role_code)
select c.entity, c.doc_type, r.ord - 1, r.role
from   chains c, unnest(c.roles) with ordinality r(role, ord)
on conflict (entity, doc_type, step) do nothing;

-- Phó Tổng Giám đốc JVC: có ô ký trên mẫu PR / RR nhưng hiện chưa là một bước
-- duyệt. Tạo sẵn vai trò để khi cần chỉ việc thêm vào chuỗi ở Chuỗi phê duyệt.
insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('JVC_DGM', 'JVC', 'JVC Deputy General Manager', 'Phó Tổng Giám đốc JVC', false, 'PHCL', 125)
on conflict (code) do nothing;
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'JVC_DGM', m, true, false, false, m in ('budget', 'project', 'approval'), false
from   unnest(array['assets', 'master', 'budget', 'project', 'approval', 'payment', 'report']) m
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 3. HÀM PHỤ
-- =====================================================================

-- Pháp nhân của một phòng ban: đi ngược cây am_org tới SOF / CP / JVC.
create or replace function pm_entity(p_dept text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with recursive up(code, parent_code, depth) as (
    select o.code, o.parent_code, 0 from am_org o where o.code = p_dept
    union all
    select o.code, o.parent_code, u.depth + 1
    from   am_org o join up u on o.code = u.parent_code
    where  u.depth < 12
  )
  select case (select code from up where code in ('SOF', 'CP', 'JVC') order by depth limit 1)
           when 'SOF' then 'SSP' when 'CP' then 'CP' when 'JVC' then 'JVC' end
$$;

/* Người p_uid có giữ vai trò p_role với phạm vi bao được phòng ban p_dept
   không. Phạm vi là một gốc của cây (PHCL) thì bao mọi thứ, kể cả mã phòng
   ban không có trong danh mục. */
create or replace function app_user_role_covers(p_uid uuid, p_role text, p_dept text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive s(code) as (
    select ur.scope_org
    from   app_user_role ur join app_user u on u.id = ur.user_id
    where  ur.user_id = p_uid and u.active and ur.role_code = p_role
    union
    select o.code from am_org o join s on o.parent_code = s.code
  )
  select exists (select 1 from s where code = p_dept)
      or exists (select 1
                 from   app_user_role ur
                 join   app_user u on u.id = ur.user_id
                 join   am_org o   on o.code = ur.scope_org
                 where  ur.user_id = p_uid and u.active and ur.role_code = p_role
                   and  o.parent_code is null)
$$;

create or replace function pm_doc_log(p_doc bigint, p_action text, p_from text, p_to text,
                                      p_step int default null, p_comment text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into pm_doc_event (doc_id, actor, actor_email, action, from_status, to_status, step, comment)
  values (p_doc, auth.uid(), coalesce(app_claims() ->> 'email', 'sql:' || session_user),
          p_action, p_from, p_to, p_step, p_comment)
$$;

-- Người dùng hiện tại có được LẬP loại chứng từ này cho dự án này không.
create or replace function pm_can_prepare(p_type text, p_dept text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or (app_can('project', 'create')
          and exists (select 1 from pm_chain c
                      where c.entity = pm_entity(p_dept) and c.doc_type = p_type and c.step = 0
                        and app_user_role_covers(auth.uid(), c.role_code, p_dept)))
$$;


-- Kiểu bước. Chỉ gán mặc định MỘT LẦN, lúc thêm cột — chạy lại file này không
-- ghi đè kiểu đã sửa trong app. Chứng từ đang duyệt cũng được gán theo chuỗi.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'pm_chain' and column_name = 'kind') then
    alter table pm_chain add column kind text not null default 'approve'
      check (kind in ('approve', 'check', 'joint'));
    update pm_chain set kind = 'check'
     where step > 0 and role_code in ('AM_COORD', 'AM_EXEC');
    update pm_chain set kind = 'joint'
     where step > 0 and role_code in ('CHIEF_ACC', 'JVC_GM') and doc_type in ('PR', 'RR', 'PA', 'QC', 'MC');
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'pm_doc_step' and column_name = 'kind') then
    alter table pm_doc_step add column kind text not null default 'approve'
      check (kind in ('approve', 'check', 'joint'));
    update pm_doc_step s set kind = c.kind
      from pm_doc d, pm_project p, pm_chain c
     where d.id = s.doc_id and p.code = d.project_code
       and c.entity = pm_entity(p.dept_code) and c.doc_type = d.doc_type
       and c.step = s.step and c.role_code = s.role_code;
  end if;
  -- Nhóm duyệt cùng. Lần đầu có cột này (bản 25/09 trước chỉ có cặp PR↔PA): RR
  -- vào nhóm của PR — hai bước JVC của RR thành "duyệt cùng", kể cả RR đang duyệt.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'pm_doc_type' and column_name = 'grp') then
    alter table pm_doc_type add column grp text;
    update pm_chain set kind = 'joint'
     where doc_type = 'RR' and step > 0 and role_code in ('CHIEF_ACC', 'JVC_GM') and kind = 'approve';
    update pm_doc_step s set kind = 'joint'
      from pm_doc d
     where d.id = s.doc_id and d.doc_type = 'RR' and s.status = 'pending'
       and s.role_code in ('CHIEF_ACC', 'JVC_GM') and s.kind = 'approve';
  end if;
end $$;
update pm_doc_type set grp = case when code in ('PR', 'RR', 'PA') then 'PR' when code in ('QC', 'MC') then 'QC' end;
alter table pm_doc_type drop column if exists pair;
comment on column pm_doc_type.grp is
  'Bộ hồ sơ: các chứng từ cùng nhóm đi chung MỘT chuỗi duyệt (PR + RR + PA, QC + MC).';
-- 26/09/2026: cả bộ đi chung một chuỗi, nên kiểu "joint" (chờ nhau ở bước JVC) không còn.
update pm_chain set kind = 'approve' where kind = 'joint';
comment on column pm_chain.kind is
  'approve = duyệt; check = kiểm tra (AM team, không phải duyệt).';

-- Chứng từ lập trước khi có bộ hồ sơ: mỗi chứng từ thành một bộ riêng. Bản
-- đang chờ duyệt về lại nháp (chuỗi duyệt cũ không chuyển sang được) — giai
-- đoạn thử nghiệm: xoá bằng Công cụ quản trị → Đặt lại → Chứng từ mua sắm.
do $$
declare d record; v bigint;
begin
  for d in select * from pm_doc where pkg_id is null order by id loop
    insert into pm_pkg (project_code, grp, status, version, created_by, created_email, created_name,
                        prep_signature, created_at, submitted_at, decided_at)
    values (d.project_code, d.doc_type, case when d.status = 'in_review' then 'draft' else d.status end,
            d.version, d.created_by, d.created_email, d.created_email, d.prep_signature,
            d.created_at, d.submitted_at, d.decided_at)
    returning id into v;
    update pm_doc set pkg_id = v, status = case when status = 'in_review' then 'draft' else status end,
                      current_step = null
     where id = d.id;
  end loop;
end $$;


-- =====================================================================
-- 4. VÒNG ĐỜI BỘ HỒ SƠ
-- =====================================================================

-- Tên hiển thị của một người (Người dùng → Họ tên), để dưới chữ ký.
create or replace function pm_user_name(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(nullif(trim(u.full_name), ''), u.email) from app_user u where u.id = p_uid
$$;

create or replace function pm_pkg_log(p_pkg bigint, p_action text, p_from text, p_to text,
                                      p_step int default null, p_comment text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into pm_pkg_event (pkg_id, actor, actor_email, actor_name, action, from_status, to_status, step, comment)
  values (p_pkg, auth.uid(), coalesce(app_claims() ->> 'email', 'sql:' || session_user),
          coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email', 'sql:' || session_user),
          p_action, p_from, p_to, p_step, nullif(trim(p_comment), ''))
$$;

-- Loại chứng từ dẫn chuỗi của một nhóm: loại phía operator có thứ tự nhỏ nhất
-- (PR của bộ PR, QC của bộ QC); bộ một chứng từ thì chính nó.
create or replace function pm_grp_lead(p_grp text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select code from pm_doc_type where grp = p_grp and side = 'operator' order by seq limit 1), p_grp)
$$;

/* Lập chứng từ. Số hiệu = tiền tố loại + phần sau đoạn đầu của mã dự án:
   FFE.KIT.02.2025 → PR.KIT.02.2025. AH lập nhiều lần thì thêm /2, /3...
   Chứng từ vào bộ của nó:
   - PR / QC mở một bộ mới (khi các bộ trước đã duyệt xong);
   - RR vào bộ PR đang nháp / bị trả về;
   - PA / MC do AM team lập khi bộ đang ở bước kiểm tra của họ;
   - PO, CT, AH: mỗi chứng từ một bộ. */
create or replace function pm_doc_create(p_project text, p_type text, p_data jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  p      pm_project;
  t      pm_doc_type;
  k      pm_pkg;
  v_miss text;
  v_no   text;
  v_n    int;
  v_id   bigint;
  v_pkg  bigint;
begin
  select * into p from pm_project where code = p_project;
  if p.code is null then raise exception 'Không có dự án % / No project %', p_project, p_project; end if;
  select * into t from pm_doc_type where code = p_type;
  if t.code is null then raise exception 'Không có loại chứng từ %', p_type; end if;

  if not pm_can_prepare(p_type, p.dept_code) then
    raise exception 'Bạn không phải người lập % của pháp nhân % (xem chuỗi duyệt).', p_type, pm_entity(p.dept_code)
      using errcode = '42501';
  end if;

  -- Một bản đang hiệu lực cho mỗi loại, trừ AH (lập nhiều lần cho tới bản cuối).
  if not t.repeatable and exists (select 1 from pm_doc d
       where d.project_code = p.code and d.doc_type = p_type and d.status not in ('rejected', 'cancelled')) then
    raise exception 'Dự án % đã có một % đang hiệu lực.', p.code, p_type;
  end if;
  if t.repeatable and exists (select 1 from pm_doc d
       where d.project_code = p.code and d.doc_type = p_type and d.status = 'approved'
         and coalesce((d.data ->> 'final')::boolean, false)) then
    raise exception 'Dự án % đã có biên bản nghiệm thu cuối cùng.', p.code;
  end if;

  if t.grp is not null then
    select * into k from pm_pkg
     where project_code = p.code and grp = t.grp and status not in ('rejected', 'cancelled')
     order by id desc limit 1;
  end if;

  if t.side = 'owner' then
    -- PA / MC: chỉ lập được khi bộ đang chờ đúng bước AM kiểm tra-và-lập.
    if k.id is null or k.status <> 'in_review' or not exists (select 1 from pm_pkg_step s
         where s.pkg_id = k.id and s.step = k.current_step and s.owner_prep) then
      raise exception '% được AM team lập ở bước kiểm tra của bộ %, sau khi khách sạn duyệt xong.', p_type, t.grp;
    end if;
    v_pkg := k.id;
  elsif k.id is not null then
    -- RR (hay PR / QC còn thiếu) vào bộ đang soạn.
    if k.status not in ('draft', 'returned') then
      raise exception 'Bộ hồ sơ % đã gửi duyệt — không thêm % được nữa.', t.grp, p_type;
    end if;
    v_pkg := k.id;
  else
    if t.grp is not null and p_type <> pm_grp_lead(t.grp) then
      raise exception 'Lập % trước, rồi thêm % vào cùng bộ.', pm_grp_lead(t.grp), p_type;
    end if;
    -- Thứ tự: mọi loại bắt buộc đứng trước (ngoài bộ này) phải được duyệt xong.
    select string_agg(pt.code, ', ' order by pt.seq) into v_miss
    from   pm_doc_type pt
    where  pt.seq < t.seq
      and  pt.grp is distinct from coalesce(t.grp, '#')
      and  (pt.required or (pt.code = 'RR' and p.investment_type ilike '%replace%'))
      and  not exists (select 1 from pm_doc d
                       where d.project_code = p.code and d.doc_type = pt.code and d.status = 'approved');
    if v_miss is not null then
      raise exception 'Chưa lập được %: % phải được duyệt xong trước.', p_type, v_miss;
    end if;
    -- Bước tuỳ chọn (CT) không chen vào được khi dự án đã có chứng từ của bước sau.
    select string_agg(distinct d.doc_type, ', ') into v_miss
    from   pm_doc d join pm_doc_type x on x.code = d.doc_type
    where  d.project_code = p.code and x.seq > t.seq and d.status not in ('rejected', 'cancelled');
    if v_miss is not null then
      raise exception 'Không lập % được nữa: dự án đã có %.', p_type, v_miss;
    end if;
    insert into pm_pkg (project_code, grp, created_by, created_email, created_name)
    values (p.code, coalesce(t.grp, t.code), auth.uid(), coalesce(app_claims() ->> 'email', 'sql:' || session_user),
            coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
    returning id into v_pkg;
    perform pm_pkg_log(v_pkg, 'create', null, 'draft');
  end if;

  v_no := t.prefix || substring(p.code from position('.' in p.code));
  select count(*) into v_n from pm_doc d
  where d.project_code = p.code and d.doc_type = p_type and d.status not in ('cancelled');
  if t.repeatable and v_n > 0 then v_no := v_no || '/' || (v_n + 1); end if;

  insert into pm_doc (project_code, doc_type, doc_no, data, total_value, created_by, created_email, pkg_id)
  values (p.code, p_type, v_no, coalesce(p_data, '{}'::jsonb), nullif(p_data ->> 'total', '')::numeric,
          auth.uid(), coalesce(app_claims() ->> 'email', 'sql:' || session_user), v_pkg)
  returning id into v_id;
  perform pm_doc_log(v_id, 'create', null, 'draft');
  return v_id;
end $$;

-- Lưu nội dung. Chỉ khi còn nháp hoặc bị trả về, và chỉ người lập (hoặc
-- người cùng vai trò lập trong phạm vi).
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
  select dept_code into v_dept from pm_project where code = d.project_code;
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

/* Chữ ký tay (giai đoạn 4): ảnh PNG vẽ bằng ngón tay / bút trên iPad. Bắt buộc
   khi GỬI DUYỆT và khi DUYỆT (trả về / từ chối thì không), trừ khi am_setting
   'pm_require_signature' = false. Kết nối trực tiếp (SQL Editor) được miễn.
   Chỉ giữ lại ảnh + thời điểm ký — trình duyệt không nhét thêm được gì khác. */
create or replace function pm_sig_check(p_sig jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_png text := p_sig ->> 'png';
begin
  if v_png is null then
    if app_trusted() or coalesce((select value from am_setting where key = 'pm_require_signature')
                                 in ('false'::jsonb, '"false"'::jsonb), false) then
      return null;
    end if;
    raise exception 'Cần ký xác nhận trước khi gửi / duyệt.' using errcode = '22023';
  end if;
  if v_png not like 'data:image/png;base64,%' or length(v_png) > 300000 then
    raise exception 'Chữ ký không hợp lệ (phải là ảnh PNG, dưới 300 KB).' using errcode = '22023';
  end if;
  return jsonb_build_object('png', v_png, 'at', now());
end $$;

/* Gửi duyệt CẢ BỘ: dựng chuỗi từ pm_chain của loại dẫn chuỗi (PR / QC / chính
   nó) tại thời điểm gửi. Bước có vai trò của người lập PA / MC là bước AM
   kiểm tra-và-lập (owner_prep). Mọi chứng từ phía operator nhận chữ ký người
   lập; PA / MC (nếu đã có từ lần trước) về nháp để AM kiểm tra lại. */
create or replace function pm_pkg_submit(p_pkg bigint, p_signature jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare k pm_pkg; p pm_project; v_lead text; v_ent text; v_first int; v_from text; v_sig jsonb;
begin
  select * into k from pm_pkg where id = p_pkg for update;
  if k.id is null then raise exception 'Không có bộ hồ sơ % / No package %', p_pkg, p_pkg; end if;
  select * into p from pm_project where code = k.project_code;
  v_lead := pm_grp_lead(k.grp);
  v_ent := pm_entity(p.dept_code);
  if k.status not in ('draft', 'returned') then
    raise exception 'Bộ hồ sơ đang "%" — không gửi được.', k.status;
  end if;
  if not (k.created_by = auth.uid() or pm_can_prepare(v_lead, p.dept_code)) then
    raise exception 'Chỉ người lập mới gửi được bộ hồ sơ này.' using errcode = '42501';
  end if;
  if not exists (select 1 from pm_doc where pkg_id = k.id and doc_type = v_lead and status in ('draft', 'returned')) then
    raise exception 'Bộ hồ sơ chưa có %.', v_lead;
  end if;
  -- Dự án thay thế: RR đi cùng PR.
  if k.grp = 'PR' and p.investment_type ilike '%replace%'
     and not exists (select 1 from pm_doc where pkg_id = k.id and doc_type = 'RR' and status in ('draft', 'returned')) then
    raise exception 'Dự án thay thế: cần lập RR cùng PR trước khi gửi.';
  end if;
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

/* Duyệt (hoặc kiểm tra) / trả về / từ chối bước hiện tại của CẢ BỘ.
   - Bước AM kiểm tra-và-lập: PA / MC phải có rồi; một lần bấm Checked = ký
     kiểm tra PR / RR (QC) và ký "Prepared by" trên PA (MC).
   - Trả về: p_target = 'operator' (mặc định) — cả bộ về người lập;
             p_target = 'am' (chỉ sau khi AM đã kiểm tra) — chỉ PA / MC về
             AM team làm lại, các bước khách sạn đã duyệt giữ nguyên.
   - Từ chối: cả bộ dừng. */
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
  select * into s from pm_pkg_step where pkg_id = k.id and step = k.current_step;

  if p_action not in ('approve', 'return', 'reject') then
    raise exception 'Thao tác không hợp lệ: %', p_action;
  end if;
  if not app_trusted() then
    if not app_can('approval', 'approve') then
      raise exception 'Bạn không có quyền duyệt.' using errcode = '42501';
    end if;
    if not app_user_role_covers(auth.uid(), s.role_code, p.dept_code) then
      raise exception 'Bước này cần vai trò % cho phòng ban %.', s.role_code, p.dept_code using errcode = '42501';
    end if;
    if k.created_by = auth.uid() then
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

-- Huỷ cả bộ: người lập khi còn nháp / bị trả về; quản trị dự án bất kỳ lúc nào trước khi duyệt xong.
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
  if not (app_trusted() or app_can('project', 'admin') or (k.created_by = auth.uid() and k.status in ('draft', 'returned'))) then
    raise exception 'Chỉ người lập (khi còn nháp) hoặc quản trị dự án mới huỷ được.' using errcode = '42501';
  end if;
  update pm_pkg set status = 'cancelled', current_step = null, updated_at = now() where id = k.id;
  update pm_doc set status = 'cancelled', updated_at = now() where pkg_id = k.id and status <> 'approved';
  perform pm_pkg_log(k.id, 'cancel', k.status, 'cancelled', null, p_comment);
end $$;

/* Bỏ một chứng từ khỏi bộ đang soạn (vd RR khi dự án hoá ra không phải thay
   thế, hay PA lập nhầm). Không bỏ được chứng từ dẫn chuỗi — huỷ cả bộ thay vào đó. */
create or replace function pm_doc_remove(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; k pm_pkg; v_dept text;
begin
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ %', p_id; end if;
  select * into k from pm_pkg where id = d.pkg_id;
  select dept_code into v_dept from pm_project where code = d.project_code;
  if d.doc_type = pm_grp_lead(k.grp) then raise exception 'Không bỏ được %: huỷ cả bộ hồ sơ.', d.doc_no; end if;
  if d.status not in ('draft', 'returned') then raise exception 'Chứng từ % đang "%" — không bỏ được.', d.doc_no, d.status; end if;
  if not (d.created_by = auth.uid() or pm_can_prepare(d.doc_type, v_dept) or app_can('project', 'admin')) then
    raise exception 'Chỉ người lập mới bỏ được %.', d.doc_no using errcode = '42501';
  end if;
  update pm_doc set status = 'cancelled', updated_at = now() where id = p_id;
  perform pm_doc_log(p_id, 'cancel', d.status, 'cancelled', null, 'bỏ khỏi bộ hồ sơ');
end $$;

-- Tên cũ, theo một chứng từ: làm trên bộ của nó.
drop function if exists pm_doc_submit(bigint);
create or replace function pm_doc_submit(p_id bigint, p_signature jsonb default null)
returns void language plpgsql security definer set search_path = public
as $$ begin perform pm_pkg_submit((select pkg_id from pm_doc where id = p_id), p_signature); end $$;
create or replace function pm_doc_act(p_id bigint, p_action text, p_comment text default null,
                                      p_signature jsonb default null)
returns text language plpgsql security definer set search_path = public
as $$ begin return pm_pkg_act((select pkg_id from pm_doc where id = p_id), p_action, p_comment, p_signature, null); end $$;
create or replace function pm_doc_cancel(p_id bigint, p_comment text default null)
returns void language plpgsql security definer set search_path = public
as $$ begin perform pm_pkg_cancel((select pkg_id from pm_doc where id = p_id), p_comment); end $$;
-- Của mô hình "chờ nhau ở bước JVC" trước đây.
drop function if exists pm_pair_state(bigint);
drop function if exists pm_step_pass(bigint, int, jsonb, text);

/* Duyệt xong: đẩy các mốc sang dự án, để báo cáo và trạng thái dự án đi theo
   chứng từ thay vì chờ ai đó gõ tay. */
create or replace function pm_doc_apply(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; v jsonb;
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
           -- Giá trị PO là giá trị cam kết cho tới khi có hợp đồng được duyệt.
           contract_value = case when exists (select 1 from pm_doc c where c.project_code = d.project_code
                                                and c.doc_type = 'CT' and c.status = 'approved')
                                 then contract_value else coalesce(d.total_value, contract_value) end,
           chosen_vendor = coalesce(nullif(d.data ->> 'supplier', ''), chosen_vendor)
     where code = d.project_code;
  elsif d.doc_type = 'CT' then
    update pm_project set contract_value = coalesce(nullif(d.data ->> 'value', '')::numeric, contract_value)
     where code = d.project_code;
  elsif d.doc_type = 'AH' and coalesce((d.data ->> 'final')::boolean, false) then
    update pm_project
       set handover_date = coalesce(nullif(d.data ->> 'handover_date', '')::date, current_date),
           evaluation = coalesce(nullif(d.data ->> 'evaluation', ''), evaluation)
     where code = d.project_code;
  end if;
end $$;


-- =====================================================================
-- 5. HỘP "VIỆC CẦN LÀM"
-- =====================================================================

/* Việc của người đang đăng nhập, theo BỘ: bộ đang chờ đúng vai trò của họ (và
   không do chính họ lập), cộng bộ của họ bị trả về cần sửa. doc_no gom số
   hiệu các chứng từ trong bộ ("PR.… + RR.… + PA.…"); doc_id là chứng từ để mở. */
drop function if exists pm_inbox();
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
  select k.id, dd.first_id, dd.nos, pm_grp_lead(k.grp), k.grp, k.project_code, p.name, p.dept_code, dd.total,
         k.submitted_at, s.step, s.role_code, 'approve', s.kind, s.owner_prep, k.returned_to
  from   pm_pkg k
  join   docs dd       on dd.pkg_id = k.id
  join   pm_project p  on p.code = k.project_code
  join   pm_pkg_step s on s.pkg_id = k.id and s.step = k.current_step
  where  k.status = 'in_review'
    and  k.created_by is distinct from auth.uid()
    and  app_can('approval', 'approve')
    and  app_user_role_covers(auth.uid(), s.role_code, p.dept_code)
  union all
  select k.id, dd.first_id, dd.nos, pm_grp_lead(k.grp), k.grp, k.project_code, p.name, p.dept_code, dd.total,
         k.submitted_at, null, null, 'returned', null, null, k.returned_to
  from   pm_pkg k join docs dd on dd.pkg_id = k.id join pm_project p on p.code = k.project_code
  where  k.status = 'returned' and k.created_by = auth.uid()
  order  by 10 nulls last
$$;

-- Ai có thể làm bước hiện tại của bộ chứa chứng từ này — để màn hình nói "đang chờ ai".
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
  join   pm_project p  on p.code = k.project_code
  join   pm_pkg_step s on s.pkg_id = k.id and s.step = k.current_step
  join   app_user u    on u.active and u.id is distinct from k.created_by
  where  d.id = p_id and k.status = 'in_review'
    and  app_user_role_covers(u.id, s.role_code, p.dept_code)
    -- Hàm chạy vượt RLS, nên tự kiểm tra: chỉ trả lời người thấy được dự án.
    and  app_can('project', 'view')
    and  (app_scope_root() or p.dept_code in (select app_scope_orgs()))
  order  by u.full_name nulls last, u.email
$$;


-- =====================================================================
-- 6. RLS — chỉ đọc; mọi thay đổi qua hàm ở trên
-- =====================================================================

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('pm_doc_type', 'pm_chain', 'pm_doc', 'pm_doc_step', 'pm_doc_event',
                               'pm_pkg', 'pm_pkg_step', 'pm_pkg_event')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table pm_doc_type  enable row level security;
alter table pm_chain     enable row level security;
alter table pm_doc       enable row level security;
alter table pm_doc_step  enable row level security;
alter table pm_doc_event enable row level security;
alter table pm_pkg       enable row level security;
alter table pm_pkg_step  enable row level security;
alter table pm_pkg_event enable row level security;

create policy pm_doc_type_read on pm_doc_type
  for select to authenticated using ((select app_is_member()));
create policy pm_doc_type_write on pm_doc_type
  for all to authenticated
  using ((select app_can('security', 'admin'))) with check ((select app_can('security', 'admin')));

create policy pm_chain_read on pm_chain
  for select to authenticated using ((select app_is_member()));
create policy pm_chain_write on pm_chain
  for all to authenticated
  using ((select app_can('approval', 'admin'))) with check ((select app_can('approval', 'admin')));

-- Thấy chứng từ / bộ hồ sơ khi thấy được dự án của nó (RLS của pm_project áp trong câu con).
create policy pm_doc_read on pm_doc
  for select to authenticated
  using (exists (select 1 from pm_project p where p.code = project_code));
create policy pm_doc_step_read on pm_doc_step
  for select to authenticated using (exists (select 1 from pm_doc d where d.id = doc_id));
create policy pm_doc_event_read on pm_doc_event
  for select to authenticated using (exists (select 1 from pm_doc d where d.id = doc_id));
create policy pm_pkg_read on pm_pkg
  for select to authenticated
  using (exists (select 1 from pm_project p where p.code = project_code));
create policy pm_pkg_step_read on pm_pkg_step
  for select to authenticated using (exists (select 1 from pm_pkg k where k.id = pkg_id));
create policy pm_pkg_event_read on pm_pkg_event
  for select to authenticated using (exists (select 1 from pm_pkg k where k.id = pkg_id));

do $$
declare t text;
begin
  foreach t in array array['pm_doc_type', 'pm_chain', 'pm_doc', 'pm_doc_step', 'pm_pkg', 'pm_pkg_step'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I '
                   'for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke all on pm_doc_type, pm_chain, pm_doc, pm_doc_step, pm_doc_event, pm_pkg, pm_pkg_step, pm_pkg_event from anon;
grant select on pm_doc, pm_doc_step, pm_doc_event, pm_pkg, pm_pkg_step, pm_pkg_event to authenticated;
grant select, insert, update, delete on pm_doc_type, pm_chain to authenticated;
revoke insert, update, delete on pm_doc, pm_doc_step, pm_doc_event, pm_pkg, pm_pkg_step, pm_pkg_event from authenticated;

revoke execute on function pm_entity(text), app_user_role_covers(uuid, text, text),
                           pm_doc_log(bigint, text, text, text, int, text), pm_can_prepare(text, text),
                           pm_doc_create(text, text, jsonb), pm_doc_save(bigint, jsonb),
                           pm_doc_submit(bigint, jsonb), pm_doc_act(bigint, text, text, jsonb),
                           pm_sig_check(jsonb), pm_doc_apply(bigint), pm_doc_cancel(bigint, text),
                           pm_inbox(), pm_next_actors(bigint),
                           pm_user_name(uuid), pm_pkg_log(bigint, text, text, text, int, text), pm_grp_lead(text),
                           pm_pkg_submit(bigint, jsonb), pm_pkg_act(bigint, text, text, jsonb, text),
                           pm_pkg_cancel(bigint, text), pm_doc_remove(bigint)
  from public, anon;
grant execute on function pm_entity(text), pm_can_prepare(text, text), pm_grp_lead(text),
                          pm_doc_create(text, text, jsonb), pm_doc_save(bigint, jsonb),
                          pm_doc_submit(bigint, jsonb), pm_doc_act(bigint, text, text, jsonb),
                          pm_doc_cancel(bigint, text), pm_inbox(), pm_next_actors(bigint),
                          pm_pkg_submit(bigint, jsonb), pm_pkg_act(bigint, text, text, jsonb, text),
                          pm_pkg_cancel(bigint, text), pm_doc_remove(bigint)
  to authenticated;
-- Nội bộ: không gọi thẳng qua API (ghi nhật ký giả, hay áp mốc dự án khi chưa duyệt).
revoke execute on function pm_doc_log(bigint, text, text, text, int, text), pm_doc_apply(bigint),
                           app_user_role_covers(uuid, text, text), pm_sig_check(jsonb),
                           pm_pkg_log(bigint, text, text, text, int, text), pm_user_name(uuid)
  from authenticated;
-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 7. KIỂM CHỨNG
-- =====================================================================

select 'Loại chứng từ' as "Mục", count(*)::text as "Thực tế", '8' as "Mong đợi",
       case when count(*) = 8 then '✔' else '✘ HỎNG' end as "Đạt"
from   pm_doc_type
union all
select 'Chuỗi duyệt (pháp nhân × loại)', count(distinct (entity, doc_type))::text, '24',
       case when count(distinct (entity, doc_type)) = 24 then '✔' else '✘ HỎNG' end
from   pm_chain
union all
select 'Chuỗi có người lập (bước 0)', count(*)::text, '24',
       case when count(*) = 24 then '✔' else '✘ HỎNG' end
from   pm_chain where step = 0
union all
select 'Bộ hồ sơ (PR + RR + PA, QC + MC)', count(*)::text, '5',
       case when count(*) = 5 then '✔' else '✘ HỎNG' end
from   pm_doc_type where grp is not null
union all
select 'Bước KIỂM TRA của AM team', count(*)::text, '> 0',
       case when count(*) > 0 then '✔' else '✘ AM team đang là người duyệt — xem Chuỗi phê duyệt' end
from   pm_chain where kind = 'check'
union all
select 'Không còn bước "joint" (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pm_chain where kind = 'joint'
union all
select 'Chứng từ chưa thuộc bộ nào (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pm_doc where pkg_id is null
union all
select 'Vai trò Phó TGĐ JVC (dự trù)', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   app_role where code = 'JVC_DGM'
union all
select 'Trình duyệt ghi thẳng chứng từ / bộ hồ sơ (phải = 0)',
       count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee = 'authenticated' and table_name in ('pm_doc', 'pm_doc_step', 'pm_doc_event', 'pm_pkg', 'pm_pkg_step', 'pm_pkg_event')
  and  privilege_type in ('INSERT', 'UPDATE', 'DELETE');
