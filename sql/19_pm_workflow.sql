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
--   pm_doc_step   chuỗi duyệt của MỘT lần gửi — dựng lại mỗi lần gửi lại
--   pm_doc_event  lịch sử: ai làm gì, lúc nào, ý kiến gì
--
-- Trình duyệt KHÔNG ghi thẳng vào ba bảng chứng từ. Tạo, lưu, gửi, duyệt, trả
-- về, từ chối, huỷ đều đi qua hàm dưới đây, và hàm giữ các luật:
--   * đúng thứ tự: chứng từ trước phải được duyệt xong mới lập được chứng từ
--     sau (RR chỉ bắt buộc khi loại đầu tư là Replacement; hợp đồng không bắt
--     buộc — mua nhỏ đi thẳng PO → AH);
--   * đúng người: vai trò của bước hiện tại, phạm vi bao được phòng ban của
--     dự án, và có quyền "duyệt" trong ma trận quyền;
--   * người lập KHÔNG BAO GIỜ tự duyệt chứng từ của chính mình;
--   * AM team KIỂM TRA (không duyệt) hồ sơ operator nộp lên; JVC duyệt PR + RR
--     + PA một lần, QC + MC một lần (xem mục 2);
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
--            tra trước khi JVC duyệt (và lập PA / MC làm cơ sở cho JVC);
--   joint    JVC duyệt CÙNG cả nhóm (PR + RR + PA, QC + MC): bước này chờ tới
--            khi mọi chứng từ trong nhóm cũng tới bước cùng vai trò, rồi một
--            lần duyệt là qua cả nhóm.
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
  'Nhóm duyệt cùng: các bước "joint" của mọi chứng từ trong nhóm được JVC duyệt một lần (PR + RR + PA, QC + MC).';
comment on column pm_chain.kind is
  'approve = duyệt; check = kiểm tra (AM team, không phải duyệt); joint = JVC duyệt cùng cả nhóm (PR + RR + PA, QC + MC).';


-- =====================================================================
-- 4. VÒNG ĐỜI CHỨNG TỪ
-- =====================================================================

/* Lập chứng từ. Số hiệu = tiền tố loại + phần sau đoạn đầu của mã dự án:
   FFE.KIT.02.2025 → PR.KIT.02.2025. AH lập nhiều lần thì thêm /2, /3... */
create or replace function pm_doc_create(p_project text, p_type text, p_data jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  p      pm_project;
  t      pm_doc_type;
  v_miss text;
  v_no   text;
  v_n    int;
  v_id   bigint;
begin
  select * into p from pm_project where code = p_project;
  if p.code is null then raise exception 'Không có dự án %', p_project; end if;
  select * into t from pm_doc_type where code = p_type;
  if t.code is null then raise exception 'Không có loại chứng từ %', p_type; end if;

  if not pm_can_prepare(p_type, p.dept_code) then
    raise exception 'Bạn không phải người lập % của pháp nhân % (xem chuỗi duyệt).', p_type, pm_entity(p.dept_code)
      using errcode = '42501';
  end if;

  -- Thứ tự: mọi loại đứng trước và bắt buộc phải có một bản đã duyệt. Riêng
  -- trong một nhóm duyệt cùng (PR + RR + PA, QC + MC): bản trước chỉ cần đã
  -- GỬI DUYỆT — AM team lập PA trong lúc kiểm tra PR / RR, rồi JVC duyệt cả nhóm.
  select string_agg(pt.code, ', ' order by pt.seq) into v_miss
  from   pm_doc_type pt
  where  pt.seq < t.seq
    and  (pt.required or (pt.code = 'RR' and p.investment_type ilike '%replace%'))
    and  not exists (select 1 from pm_doc d
                     where d.project_code = p.code and d.doc_type = pt.code
                       and (d.status = 'approved'
                            or (d.status = 'in_review' and pt.grp is not null and pt.grp = t.grp)));
  if v_miss is not null then
    raise exception 'Chưa lập được %: % phải được duyệt xong (cùng nhóm duyệt thì chỉ cần đã gửi duyệt) trước.', p_type, v_miss;
  end if;

  -- Bước tuỳ chọn (RR, CT) không chen vào được khi dự án đã có chứng từ của bước sau.
  select string_agg(distinct d.doc_type, ', ') into v_miss
  from   pm_doc d join pm_doc_type x on x.code = d.doc_type
  where  d.project_code = p.code and x.seq > t.seq and d.status not in ('rejected', 'cancelled');
  if v_miss is not null then
    raise exception 'Không lập % được nữa: dự án đã có %.', p_type, v_miss;
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

  v_no := t.prefix || substring(p.code from position('.' in p.code));
  select count(*) into v_n from pm_doc d
  where d.project_code = p.code and d.doc_type = p_type and d.status not in ('cancelled');
  if t.repeatable and v_n > 0 then v_no := v_no || '/' || (v_n + 1); end if;

  insert into pm_doc (project_code, doc_type, doc_no, data, total_value, created_by, created_email)
  values (p.code, p_type, v_no, coalesce(p_data, '{}'::jsonb), nullif(p_data ->> 'total', '')::numeric,
          auth.uid(), coalesce(app_claims() ->> 'email', 'sql:' || session_user))
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

-- Gửi duyệt: dựng chuỗi duyệt từ pm_chain tại thời điểm gửi, kèm chữ ký người lập.
-- Bản cũ một tham số phải bỏ: để lại thì PostgREST không biết chọn bản nào.
drop function if exists pm_doc_submit(bigint);
create or replace function pm_doc_submit(p_id bigint, p_signature jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; p pm_project; v_first int; v_from text; v_sig jsonb;
begin
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ %', p_id; end if;
  select * into p from pm_project where code = d.project_code;
  if d.status not in ('draft', 'returned') then
    raise exception 'Chứng từ % đang ở trạng thái "%" — không gửi được.', d.doc_no, d.status;
  end if;
  if not (d.created_by = auth.uid() or pm_can_prepare(d.doc_type, p.dept_code)) then
    raise exception 'Chỉ người lập mới gửi được %.', d.doc_no using errcode = '42501';
  end if;
  v_sig := pm_sig_check(p_signature);

  delete from pm_doc_step where doc_id = p_id;
  insert into pm_doc_step (doc_id, step, role_code, kind)
  select p_id, c.step, c.role_code, c.kind from pm_chain c
  where  c.entity = pm_entity(p.dept_code) and c.doc_type = d.doc_type and c.step > 0;
  select min(step) into v_first from pm_doc_step where doc_id = p_id;
  if v_first is null then
    raise exception 'Chưa có chuỗi duyệt cho % của pháp nhân %.', d.doc_type, coalesce(pm_entity(p.dept_code), '?');
  end if;

  v_from := d.status;
  update pm_doc
     set status = 'in_review', current_step = v_first, version = version + 1, prep_signature = v_sig,
         submitted_at = now(), decided_at = null, updated_at = now()
   where id = p_id;
  -- Ngày đề xuất của dự án = lần đầu PR được gửi đi.
  if d.doc_type = 'PR' then
    update pm_project set request_date = coalesce(request_date, current_date) where code = p.code;
  end if;
  perform pm_doc_log(p_id, case when v_from = 'returned' then 'resubmit' else 'submit' end, v_from, 'in_review', v_first);
end $$;

/* Chứng từ đang đứng ở bước "joint" (duyệt cùng) — các chứng từ khác trong nhóm
   của nó đang ở đâu, mỗi loại một dòng. Không trả dòng nào khi bước hiện tại
   không phải "joint". Một loại thuộc nhóm khi nó bắt buộc (PA, MC; RR với dự án
   thay thế) hoặc dự án đã có một bản đang hiệu lực của nó.
     wait = null       duyệt được ngay (pair_id, nếu đang chờ cùng bước, được duyệt cùng lúc)
     wait = 'missing'  chưa được lập
     wait = 'behind'   chưa tới bước cùng vai trò */
create or replace function pm_pair_state(p_doc bigint)
returns table (pair_id bigint, pair_no text, pair_type text, wait text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare d pm_doc; s pm_doc_step; p pm_project; v_grp text; tt pm_doc_type; pd pm_doc; ps pm_doc_step;
begin
  select * into d from pm_doc where id = p_doc;
  if d.status is distinct from 'in_review' then return; end if;
  select * into s from pm_doc_step where doc_id = d.id and step = d.current_step;
  if s.kind is distinct from 'joint' then return; end if;
  select grp into v_grp from pm_doc_type where code = d.doc_type;
  if v_grp is null then return; end if;
  select * into p from pm_project where code = d.project_code;
  for tt in select * from pm_doc_type where grp = v_grp and code <> d.doc_type order by seq loop
    select * into pd from pm_doc
     where project_code = d.project_code and doc_type = tt.code and status not in ('cancelled', 'rejected')
     order by id desc limit 1;
    if pd.id is null then
      if tt.required or (tt.code = 'RR' and p.investment_type ilike '%replace%') then
        return query select null::bigint, null::text, tt.code, 'missing'::text;
      end if;
      continue;
    end if;
    if pd.status = 'approved' then                     -- đã xong riêng: không cần chờ
      return query select pd.id, pd.doc_no, tt.code, null::text; continue;
    end if;
    if pd.status <> 'in_review' then                   -- nháp / bị trả về
      return query select pd.id, pd.doc_no, tt.code, 'behind'::text; continue;
    end if;
    select * into ps from pm_doc_step
     where doc_id = pd.id and role_code = s.role_code and kind = 'joint' and status = 'pending'
     order by step limit 1;
    return query select pd.id, pd.doc_no, tt.code,
                        case when ps.id is null or pd.current_step = ps.step then null else 'behind' end::text;
  end loop;
end $$;

/* Qua một bước (duyệt hoặc kiểm tra): ghi bước, chuyển sang bước sau hoặc
   duyệt xong chứng từ. Nội bộ — gọi từ pm_doc_act. */
create or replace function pm_step_pass(p_doc bigint, p_step int, p_sig jsonb, p_comment text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_next int; v_kind text;
begin
  update pm_doc_step
     set status = 'approved', acted_by = auth.uid(),
         acted_email = coalesce(app_claims() ->> 'email', 'sql:' || session_user),
         acted_at = now(), comment = nullif(trim(p_comment), ''), signature = p_sig
   where doc_id = p_doc and step = p_step
   returning kind into v_kind;
  select min(step) into v_next from pm_doc_step where doc_id = p_doc and step > p_step and status = 'pending';
  if v_next is not null then
    update pm_doc set current_step = v_next, updated_at = now() where id = p_doc;
    perform pm_doc_log(p_doc, case when v_kind = 'check' then 'check' else 'approve' end,
                       'in_review', 'in_review', p_step, p_comment);
    return 'in_review';
  end if;
  update pm_doc set status = 'approved', current_step = null, decided_at = now(), updated_at = now()
   where id = p_doc;
  perform pm_doc_apply(p_doc);
  perform pm_doc_log(p_doc, case when v_kind = 'check' then 'check' else 'approve' end,
                     'in_review', 'approved', p_step, p_comment);
  return 'approved';
end $$;

/* Duyệt (hoặc kiểm tra) / trả về / từ chối bước hiện tại. Ở bước "joint":
   chờ cả nhóm tới cùng bước, rồi một lần duyệt là qua bước đó ở MỌI chứng từ.
   Trả về / từ chối ở bước joint chỉ áp cho chứng từ đang mở. */
create or replace function pm_doc_act(p_id bigint, p_action text, p_comment text default null,
                                      p_signature jsonb default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  d      pm_doc;
  p      pm_project;
  s      pm_doc_step;
  v_pairs bigint[];
  v_miss  text;
  v_behind text;
  v_pair bigint;
  v_to   text;
  v_sig  jsonb;
begin
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ %', p_id; end if;
  if d.status <> 'in_review' then
    raise exception 'Chứng từ % không ở trạng thái chờ duyệt.', d.doc_no;
  end if;
  select * into p from pm_project where code = d.project_code;
  select * into s from pm_doc_step where doc_id = p_id and step = d.current_step;

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
    if d.created_by = auth.uid() then
      raise exception 'Người lập không được tự duyệt chứng từ của mình.' using errcode = '42501';
    end if;
  end if;
  if p_action in ('return', 'reject') and coalesce(trim(p_comment), '') = '' then
    raise exception 'Trả về hoặc từ chối phải ghi lý do.';
  end if;
  if p_action = 'approve' then v_sig := pm_sig_check(p_signature); end if;

  if p_action = 'approve' then
    if s.kind = 'joint' then
      -- Cả nhóm phải cùng tới bước này (PR + RR + PA, QC + MC).
      select string_agg(g.pair_type, ', ') filter (where g.wait = 'missing'),
             string_agg(g.pair_no, ', ')   filter (where g.wait = 'behind')
        into v_miss, v_behind
        from pm_pair_state(p_id) g;
      if v_miss is not null then
        raise exception 'JVC duyệt % cùng cả nhóm: % chưa được lập — AM team lập trước.', d.doc_type, v_miss
          using errcode = '22023';
      elsif v_behind is not null then
        raise exception 'JVC duyệt % cùng cả nhóm: chờ % tới bước này.', d.doc_type, v_behind
          using errcode = '22023';
      end if;
      -- Những chứng từ trong nhóm đang chờ đúng bước này: qua cùng lúc.
      select array_agg(x.id order by x.id) into v_pairs
        from pm_pair_state(p_id) g
        join pm_doc x on x.id = g.pair_id
       where x.status = 'in_review'
         and exists (select 1 from pm_doc_step y
                     where y.doc_id = x.id and y.step = x.current_step and y.kind = 'joint' and y.role_code = s.role_code);
      perform 1 from pm_doc where id = any(coalesce(v_pairs, '{}')) for update;
      if not app_trusted() and exists (select 1 from pm_doc where id = any(coalesce(v_pairs, '{}')) and created_by = auth.uid()) then
        raise exception 'Bạn là người lập một chứng từ trong nhóm — không duyệt cùng được.' using errcode = '42501';
      end if;
    end if;
    v_to := pm_step_pass(p_id, s.step, v_sig, p_comment);
    foreach v_pair in array coalesce(v_pairs, '{}') loop
      perform pm_step_pass(v_pair, (select current_step from pm_doc where id = v_pair), v_sig,
                           coalesce(nullif(trim(p_comment), '') || ' · ', '') || 'cùng ' || d.doc_no);
    end loop;
    return v_to;
  end if;

  update pm_doc_step
     set status = case p_action when 'return' then 'returned' else 'rejected' end,
         acted_by = auth.uid(), acted_email = coalesce(app_claims() ->> 'email', 'sql:' || session_user),
         acted_at = now(), comment = nullif(trim(p_comment), '')
   where id = s.id;

  if p_action = 'return' then
    v_to := 'returned';
    update pm_doc set status = 'returned', current_step = null, updated_at = now() where id = p_id;
  else
    v_to := 'rejected';
    update pm_doc set status = 'rejected', current_step = null, decided_at = now(), updated_at = now() where id = p_id;
  end if;

  perform pm_doc_log(p_id, p_action, 'in_review', v_to, s.step, p_comment);
  return v_to;
end $$;

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

-- Huỷ: người lập huỷ nháp của mình; quản trị dự án huỷ được mọi chứng từ chưa duyệt.
create or replace function pm_doc_cancel(p_id bigint, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc;
begin
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ %', p_id; end if;
  if d.status in ('approved', 'cancelled') then
    raise exception 'Chứng từ % đã % — không huỷ được.', d.doc_no, d.status;
  end if;
  if not (app_trusted() or app_can('project', 'admin') or (d.created_by = auth.uid() and d.status in ('draft', 'returned'))) then
    raise exception 'Chỉ người lập (khi còn nháp) hoặc quản trị dự án mới huỷ được.' using errcode = '42501';
  end if;
  update pm_doc set status = 'cancelled', current_step = null, updated_at = now() where id = p_id;
  perform pm_doc_log(p_id, 'cancel', d.status, 'cancelled', null, p_comment);
end $$;


-- =====================================================================
-- 5. HỘP "CHỜ TÔI"
-- =====================================================================

/* Việc của người đang đăng nhập: chứng từ đang chờ đúng vai trò của họ (và
   không do chính họ lập), cộng chứng từ của họ bị trả về cần sửa.
   step_kind cho biết bước đó là duyệt / kiểm tra / duyệt cùng; ở bước "joint"
   có thêm các chứng từ cùng nhóm và wait (null = làm được ngay). */
drop function if exists pm_inbox();
create or replace function pm_inbox()
returns table (doc_id bigint, doc_no text, doc_type text, project_code text, project_name text,
               dept_code text, total_value numeric, submitted_at timestamptz, step int,
               role_code text, kind text, step_kind text, pair_ids bigint[], pair_nos text, wait text)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.doc_no, d.doc_type, d.project_code, p.name, p.dept_code, d.total_value,
         d.submitted_at, s.step, s.role_code, 'approve', s.kind, g.pair_ids, g.pair_nos, g.wait
  from   pm_doc d
  join   pm_project p  on p.code = d.project_code
  join   pm_doc_step s on s.doc_id = d.id and s.step = d.current_step
  -- Bước joint: các chứng từ cùng nhóm đang chờ cùng bước, và còn chờ gì không.
  cross  join lateral (select array_agg(x.pair_id) filter (where x.pair_id is not null and y.status = 'in_review') as pair_ids,
                              string_agg(x.pair_no, ' + ') filter (where y.status = 'in_review') as pair_nos,
                              min(x.wait) as wait
                       from   pm_pair_state(d.id) x left join pm_doc y on y.id = x.pair_id) g
  where  d.status = 'in_review'
    and  d.created_by is distinct from auth.uid()
    and  app_can('approval', 'approve')
    and  app_user_role_covers(auth.uid(), s.role_code, p.dept_code)
  union all
  select d.id, d.doc_no, d.doc_type, d.project_code, p.name, p.dept_code, d.total_value,
         d.submitted_at, null, null, 'returned', null, null, null, null
  from   pm_doc d join pm_project p on p.code = d.project_code
  where  d.status = 'returned' and d.created_by = auth.uid()
  order  by 8 nulls last
$$;

-- Ai có thể duyệt bước hiện tại — để màn hình nói "đang chờ ai".
create or replace function pm_next_actors(p_id bigint)
returns table (email text, full_name text)
language sql
stable
security definer
set search_path = public
as $$
  select u.email, u.full_name
  from   pm_doc d
  join   pm_project p  on p.code = d.project_code
  join   pm_doc_step s on s.doc_id = d.id and s.step = d.current_step
  join   app_user u    on u.active and u.id is distinct from d.created_by
  where  d.id = p_id and d.status = 'in_review'
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
             and tablename in ('pm_doc_type', 'pm_chain', 'pm_doc', 'pm_doc_step', 'pm_doc_event')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table pm_doc_type  enable row level security;
alter table pm_chain     enable row level security;
alter table pm_doc       enable row level security;
alter table pm_doc_step  enable row level security;
alter table pm_doc_event enable row level security;

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

-- Thấy chứng từ khi thấy được dự án của nó (RLS của pm_project áp trong câu con).
create policy pm_doc_read on pm_doc
  for select to authenticated
  using (exists (select 1 from pm_project p where p.code = project_code));
create policy pm_doc_step_read on pm_doc_step
  for select to authenticated using (exists (select 1 from pm_doc d where d.id = doc_id));
create policy pm_doc_event_read on pm_doc_event
  for select to authenticated using (exists (select 1 from pm_doc d where d.id = doc_id));

do $$
declare t text;
begin
  foreach t in array array['pm_doc_type', 'pm_chain', 'pm_doc', 'pm_doc_step'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I '
                   'for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke all on pm_doc_type, pm_chain, pm_doc, pm_doc_step, pm_doc_event from anon;
grant select on pm_doc, pm_doc_step, pm_doc_event to authenticated;
grant select, insert, update, delete on pm_doc_type, pm_chain to authenticated;
revoke insert, update, delete on pm_doc, pm_doc_step, pm_doc_event from authenticated;

revoke execute on function pm_entity(text), app_user_role_covers(uuid, text, text),
                           pm_doc_log(bigint, text, text, text, int, text), pm_can_prepare(text, text),
                           pm_doc_create(text, text, jsonb), pm_doc_save(bigint, jsonb),
                           pm_doc_submit(bigint, jsonb), pm_doc_act(bigint, text, text, jsonb),
                           pm_sig_check(jsonb), pm_doc_apply(bigint), pm_doc_cancel(bigint, text),
                           pm_inbox(), pm_next_actors(bigint),
                           pm_pair_state(bigint), pm_step_pass(bigint, int, jsonb, text)
  from public, anon;
grant execute on function pm_entity(text), pm_can_prepare(text, text),
                          pm_doc_create(text, text, jsonb), pm_doc_save(bigint, jsonb),
                          pm_doc_submit(bigint, jsonb), pm_doc_act(bigint, text, text, jsonb),
                          pm_doc_cancel(bigint, text), pm_inbox(), pm_next_actors(bigint)
  to authenticated;
-- Nội bộ: không gọi thẳng qua API (ghi nhật ký giả, hay áp mốc dự án khi chưa duyệt).
-- pm_step_pass qua bước mà KHÔNG kiểm tra người duyệt — chỉ pm_doc_act được gọi.
revoke execute on function pm_doc_log(bigint, text, text, text, int, text), pm_doc_apply(bigint),
                           app_user_role_covers(uuid, text, text), pm_sig_check(jsonb),
                           pm_pair_state(bigint), pm_step_pass(bigint, int, jsonb, text)
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
select 'Nhóm duyệt cùng (PR + RR + PA, QC + MC)', count(*)::text, '5',
       case when count(*) = 5 then '✔' else '✘ HỎNG' end
from   pm_doc_type where grp is not null
union all
select 'Bước KIỂM TRA của AM team', count(*)::text, '> 0',
       case when count(*) > 0 then '✔' else '✘ AM team đang là người duyệt — xem Chuỗi phê duyệt' end
from   pm_chain where kind = 'check'
union all
select 'Bước JVC duyệt cùng (joint)', count(*)::text, '> 0',
       case when count(*) > 0 then '✔' else '✘ HỎNG' end
from   pm_chain where kind = 'joint'
union all
select 'Hàm qua bước nội bộ không gọi được từ app (phải = 0)',
       count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_step_pass' and has_function_privilege('authenticated', oid, 'execute')
union all
select 'Trình duyệt ghi thẳng pm_doc (phải = 0)',
       count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee = 'authenticated' and table_name in ('pm_doc', 'pm_doc_step', 'pm_doc_event')
  and  privilege_type in ('INSERT', 'UPDATE', 'DELETE');
