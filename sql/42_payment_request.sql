-- =====================================================================
-- 42_payment_request.sql — HỢP ĐỒNG TỪ PO VÀ ĐỀ NGHỊ THANH TOÁN THEO ĐỢT (28/09/2026)
--
-- Chạy SAU 41_tendering.sql (cần 34_contracts). Chạy lại nhiều lần vô hại.
-- KHÔNG chạy ALL_IN_ONE trên CSDL thật.
--
-- Quy trình (quyết định của người dùng 28/09/2026):
--   PO duyệt xong → Thu mua bấm "Tải hợp đồng": hợp đồng mới trong sổ Hợp đồng, điền sẵn
--   từ PO và báo giá được chọn (nhà cung cấp, giá trị, lịch thanh toán, bảo hành, giao
--   hàng) → tải bản scan, đọc điều khoản (34: Claude chat / OCR / Claude API) → "Xác nhận
--   hợp đồng" (hợp đồng đã ký, các bước duyệt đã đi qua PR/QC/PO: đi thẳng "đang hiệu
--   lực"; am_setting ct_po_direct = false thì phải gửi duyệt theo tuyến của 34).
--   → "Đề nghị thanh toán lần 1": Thu mua đính kèm hồ sơ (số tiền theo lịch thanh toán của
--   hợp đồng; Thu mua được điều chỉnh — khi đó ghi lý do và kèm thư đề nghị thanh toán của
--   nhà thầu) → gửi: Kế toán trưởng DUYỆT, Kế toán được báo CÙNG LÚC để nắm thông tin
--   (sửa 29/09/2026: bỏ bước Kế toán kiểm tra) → KTT duyệt (ký) → Kế toán nhận "đã duyệt,
--   tiến hành thanh toán" → chi xong, Kế toán xác nhận đã thanh toán (chọn nhiều đề nghị
--   một lúc được) → Thu mua thấy trạng thái. Các đợt giữa kỳ tương tự; đợt QUYẾT
--   TOÁN chỉ mở khi AH cuối cùng đã duyệt. Quyết toán xong → dự án "Hoàn thành", hợp
--   đồng "Hoàn thành". Hồ sơ dự án in / xuất ra mang dấu "Approved by CA – tên – giờ".
--   Dự án chỉ có PO (không hợp đồng) vẫn đề nghị thanh toán được, căn cứ PO đã duyệt.
--   Dự án có hợp đồng: AH cuối duyệt xong dự án vẫn "Đang thực hiện" tới khi quyết toán xong.
--
-- Tuyến duyệt đề nghị thanh toán ở am_setting pay_route (sửa trong Cài đặt).
-- Vai trò mới: ACCOUNTANT (Kế toán — JVC).
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. VAI TRÒ, QUYỀN, CÀI ĐẶT
-- =====================================================================

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('ACCOUNTANT', 'JVC', 'Accountant', 'Kế toán', false, 'PHCL', 125)
on conflict (code) do nothing;

-- "do nothing": ô đã chỉnh ở màn Phân quyền giữ nguyên.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'ACCOUNTANT', m.code, true, m.code = 'payment', m.code = 'payment', m.code = 'payment', false
from   app_module m where m.code in ('assets', 'master', 'budget', 'project', 'approval', 'payment', 'report', 'contract')
on conflict (role_code, module_code) do nothing;
-- Thu mua đề nghị thanh toán: xem + tạo ở khu Thanh toán (chỉ thêm quyền).
update app_permission set can_view = true, can_create = true where role_code = 'PURCHASING' and module_code = 'payment';

insert into am_setting (key, value, note) values
  ('pay_route', '{"prep": ["PURCHASING"], "check": [], "approve": ["CHIEF_ACC"], "process": ["ACCOUNTANT"], "watch": ["ACCOUNTANT"]}'::jsonb,
   'Đề nghị thanh toán: người lập (prep) → [kiểm tra (check), để trống = bỏ qua] → duyệt (approve) → xác nhận đã chi (process); watch = được báo khi gửi, theo mã vai trò'),
  ('ct_po_direct', 'true'::jsonb,
   'Hợp đồng tải lên từ PO đã duyệt: true = Thu mua xác nhận là có hiệu lực ngay; false = gửi duyệt theo tuyến hợp đồng (ct_route)')
on conflict (key) do nothing;

-- Bản đầu (28/09) có bước Kế toán kiểm tra: đổi sang tuyến mới nếu vẫn là mặc định cũ.
update am_setting
   set value = '{"prep": ["PURCHASING"], "check": [], "approve": ["CHIEF_ACC"], "process": ["ACCOUNTANT"], "watch": ["ACCOUNTANT"]}'::jsonb,
       note = 'Đề nghị thanh toán: người lập (prep) → [kiểm tra (check), để trống = bỏ qua] → duyệt (approve) → xác nhận đã chi (process); watch = được báo khi gửi, theo mã vai trò'
 where key = 'pay_route' and value = '{"prep": ["PURCHASING"], "check": ["ACCOUNTANT"], "approve": ["CHIEF_ACC"], "process": ["ACCOUNTANT"]}'::jsonb;

alter table pm_contract drop constraint if exists pm_contract_source_check;
alter table pm_contract add constraint pm_contract_source_check check (source in ('app', 'ct', 'import', 'po'));


-- =====================================================================
-- 2. HỢP ĐỒNG TỪ PO
-- =====================================================================

-- Tạo (hoặc trả về) hợp đồng nháp của dự án, điền sẵn từ PO đã duyệt và báo giá được chọn ở QC.
create or replace function pm_ct_from_po(p_doc bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare d pm_doc; p pm_project; q jsonb; a jsonb; v_id bigint; v_terms jsonb; v_vcode text;
        v_base date; v_n int; v_unit text; v_due date; v_wtxt text;
begin
  perform pm_ct_need('create');
  select * into d from pm_doc where id = p_doc and doc_type = 'PO';
  if d.id is null then raise exception 'Không có PO %.', p_doc; end if;
  if d.status <> 'approved' then raise exception 'PO % chưa được duyệt xong.', d.doc_no; end if;
  select * into p from pm_project where code = d.project_code;
  if not (app_trusted() or app_can('contract', 'admin') or pm_can_prepare('PO', p.dept_code)) then
    raise exception 'Chỉ người lập PO (Thu mua) tải hợp đồng của dự án được.' using errcode = '42501';
  end if;
  select data into q from pm_doc where project_code = p.code and doc_type = 'QC' and status = 'approved' order by id desc limit 1;
  a := coalesce(q -> 'vendors' -> 0, '{}'::jsonb);                     -- nhà thầu A = nhà thầu được chọn
  -- Lịch thanh toán nhà thầu khai trên cổng: [{pct, when, days, note}] → [{milestone, pct, amount, condition}]
  select coalesce(jsonb_agg(jsonb_build_object(
           'milestone', case x ->> 'when' when 'deposit' then 'Đặt cọc / Deposit' when 'delivery' then 'Giao hàng / Delivery'
                          when 'acceptance' then 'Nghiệm thu / Acceptance' when 'handover' then 'Bàn giao / Handover'
                          when 'warranty' then 'Hết bảo hành / End of warranty' else coalesce(nullif(x ->> 'note', ''), 'Khác / Other') end,
           'pct', nullif(x ->> 'pct', '')::numeric,
           'amount', round(coalesce(d.total_value, 0) * coalesce(nullif(x ->> 'pct', '')::numeric, 0) / 100),
           'condition', concat_ws(' · ', nullif(x ->> 'days', '') || ' ngày / days', nullif(x ->> 'note', ''))) order by n), '[]')
    into v_terms
    from jsonb_array_elements(case when jsonb_typeof(a -> 'pay_sched') = 'array' then a -> 'pay_sched' else '[]' end) with ordinality y(x, n);
  if jsonb_array_length(v_terms) = 0 and coalesce(d.data ->> 'payment_term', '') <> '' then
    v_terms := jsonb_build_array(jsonb_build_object('milestone', 'Theo PO / As per PO', 'condition', d.data ->> 'payment_term'));
  end if;
  v_vcode := coalesce(nullif(a ->> 'vendor_code', ''), (select code from pm_vendor where lower(name) = lower(d.data ->> 'supplier') limit 1));
  if v_vcode is not null and not exists (select 1 from pm_vendor where code = v_vcode) then v_vcode := null; end if;
  -- Hạn giao hàng: "4 tuần" / "30 ngày" / "2 tháng" (hoặc weeks / days / months) tính từ ngày đặt hàng của PO.
  v_base := coalesce(nullif(d.data ->> 'order_date', '')::date, d.decided_at::date, current_date);
  v_n := nullif(substring(lower(coalesce(d.data ->> 'delivery_term', '')) from '(\d+)\s*(?:tuần|tuan|week|ngày|ngay|day|tháng|thang|month)'), '')::int;
  v_unit := substring(lower(coalesce(d.data ->> 'delivery_term', '')) from '\d+\s*(tuần|tuan|week|ngày|ngay|day|tháng|thang|month)');
  if v_n is not null then
    v_due := v_base + case when v_unit in ('tuần', 'tuan', 'week') then make_interval(days => v_n * 7)
                           when v_unit in ('tháng', 'thang', 'month') then make_interval(months => v_n) else make_interval(days => v_n) end;
  end if;
  -- Bảo hành "24 tháng" / "24 months" → số tháng; "kể từ nghiệm thu / bàn giao / giao hàng" → mốc tính.
  v_wtxt := lower(coalesce(a ->> 'warranty', '') || ' ' || coalesce(d.data ->> 'warranty_term', ''));
  -- Hợp đồng nháp đã có (tải trước đó): chỉ điền các ô còn trống, không đè lên những gì đã nhập.
  select id into v_id from pm_contract where project_code = p.code and status not in ('cancelled', 'rejected') order by id desc limit 1;
  if v_id is not null then
    update pm_contract c set
      dept_code = coalesce(c.dept_code, p.dept_code), entity = coalesce(c.entity, pm_entity(p.dept_code)), po_no = coalesce(c.po_no, d.doc_no),
      vendor_code = coalesce(c.vendor_code, v_vcode), supplier = coalesce(c.supplier, nullif(d.data ->> 'supplier', '')),
      supplier_tax = coalesce(c.supplier_tax, (select tax_code from pm_vendor where code = v_vcode)),
      value_pre_vat = coalesce(c.value_pre_vat, d.total_value),
      pay_terms = case when jsonb_array_length(coalesce(c.pay_terms, '[]')) = 0 then v_terms else c.pay_terms end,
      delivery_text = coalesce(c.delivery_text, nullif(d.data ->> 'delivery_term', '')), delivery_due = coalesce(c.delivery_due, v_due),
      warranty_months = coalesce(c.warranty_months, nullif(substring(v_wtxt from '(\d+)\s*(tháng|thang|month)'), '')::int),
      updated_at = now()
     where c.id = v_id and c.status in ('draft', 'returned');
    return v_id;
  end if;
  insert into pm_contract (no, title, kind, scope, entity, dept_code, project_code, po_no, vendor_code, supplier, supplier_tax, value_pre_vat,
                           pay_terms, delivery_text, delivery_due, warranty_months, warranty_start, summary, status, source, created_by, created_name)
  values (pm_ct_next_no(), coalesce(p.name, d.doc_no), 'supply', 'capex', pm_entity(p.dept_code), p.dept_code, p.code, d.doc_no, v_vcode,
          nullif(d.data ->> 'supplier', ''), (select tax_code from pm_vendor where code = v_vcode), d.total_value, v_terms,
          nullif(d.data ->> 'delivery_term', ''), v_due,
          nullif(substring(v_wtxt from '(\d+)\s*(tháng|thang|month)'), '')::int,
          case when v_wtxt ~ '(nghiệm thu|nghiem thu|accept)' then 'acceptance' when v_wtxt ~ '(bàn giao|ban giao|handover)' then 'handover'
               when v_wtxt ~ '(giao hàng|giao hang|deliver)' then 'delivery' end,
          nullif(concat_ws(E'\n', 'Bảo hành / Warranty: ' || nullif(coalesce(nullif(d.data ->> 'warranty_term', ''), a ->> 'warranty'), ''),
                           nullif(d.data ->> 'note', '')), ''),
          'draft', 'po', auth.uid(), am_me_name())
  returning id into v_id;
  return v_id;
end $$;

-- Xác nhận hợp đồng đã ký (tải từ PO): có ít nhất một văn bản → "đang hiệu lực".
create or replace function pm_ct_confirm(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare c pm_contract;
begin
  perform pm_ct_need('edit');
  select * into c from pm_contract where id = p_id for update;
  if c.id is null then raise exception 'Không có hợp đồng %.', p_id; end if;
  if c.source <> 'po' then raise exception 'Chỉ hợp đồng tải lên từ PO mới xác nhận trực tiếp — hợp đồng khác gửi duyệt theo tuyến.'; end if;
  if c.status not in ('draft', 'returned') then raise exception 'Hợp đồng % đang "%".', c.no, c.status; end if;
  if coalesce((select value::text from am_setting where key = 'ct_po_direct'), 'true') = 'false' then
    raise exception 'Cài đặt yêu cầu gửi duyệt hợp đồng (ct_po_direct = false) — bấm "Gửi duyệt".';
  end if;
  if not exists (select 1 from pm_contract_file where contract_id = c.id) then
    raise exception 'Tải bản scan hợp đồng đã ký trước khi xác nhận.';
  end if;
  if c.value_pre_vat is null and c.value_total is null then raise exception 'Nhập giá trị hợp đồng trước khi xác nhận.'; end if;
  update pm_contract
     set status = 'active', approved_at = now(), updated_at = now(),
         route = coalesce(route, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('key', 'confirm', 'by', auth.uid(), 'name', am_me_name(),
                                                                                      'at', now(), 'action', 'approve', 'side', 'hotel'))
   where id = c.id;
  update pm_project set contract_value = coalesce(c.value_pre_vat, contract_value) where code = c.project_code;
end $$;


-- =====================================================================
-- 3. ĐỀ NGHỊ THANH TOÁN
-- =====================================================================

create table if not exists pm_payreq (
  id            bigserial primary key,
  no            text not null unique,                    -- <mã dự án>/TT01
  project_code  text not null references pm_project(code) on update cascade on delete cascade,
  contract_id   bigint references pm_contract(id) on delete set null,
  po_doc_id     bigint references pm_doc(id) on delete set null,
  seq           int not null,
  kind          text not null default 'interim' check (kind in ('first', 'interim', 'final')),
  term_idx      int,                                     -- dòng lịch thanh toán của hợp đồng
  milestone     text,
  pct           numeric(7, 3),
  amount        numeric(18, 2),                          -- trước VAT
  vat_pct       numeric(5, 2),
  amount_total  numeric(18, 2),                          -- gồm VAT
  invoice_no    text,
  note          text,
  files         jsonb not null default '[]',             -- [{path, name, size, by, at}] bucket pm-payreq
  links         jsonb not null default '[]',             -- [{url, label}]
  status        text not null default 'draft'
                check (status in ('draft', 'check', 'approve', 'process', 'paid', 'returned', 'rejected', 'cancelled')),
  route         jsonb not null default '[]',             -- nhật ký các bước [{step, action, by, name, at, comment}]
  paid_at       date,
  paid_amount   numeric(18, 2),
  voucher_no    text,
  created_by    uuid default auth.uid(),
  created_name  text,
  created_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists pm_payreq_project_idx on pm_payreq (project_code);
create index if not exists pm_payreq_status_idx on pm_payreq (status);
-- 29/09/2026: số tiền theo hợp đồng (lịch thanh toán) và số Thu mua điều chỉnh (amount) + lý do;
-- người duyệt (Kế toán trưởng) với giờ duyệt và chữ ký — dấu "Approved by CA" trên hồ sơ in ra.
alter table pm_payreq add column if not exists amount_contract numeric(18, 2);
alter table pm_payreq add column if not exists adjust_note     text;
alter table pm_payreq add column if not exists approved_by     uuid;
alter table pm_payreq add column if not exists approved_name   text;
alter table pm_payreq add column if not exists approved_at     timestamptz;
alter table pm_payreq add column if not exists approved_sig    jsonb;
-- 29/09/2026: Thu mua ký khi gửi, Kế toán ký khi xác nhận đã chi — cùng hiện trên trang đề nghị in ra.
alter table pm_payreq add column if not exists submitted_name  text;
alter table pm_payreq add column if not exists submitted_sig   jsonb;
alter table pm_payreq add column if not exists paid_by         uuid;
alter table pm_payreq add column if not exists paid_name       text;
alter table pm_payreq add column if not exists paid_sig        jsonb;
comment on table pm_payreq is
  'Đề nghị thanh toán theo đợt của dự án: Thu mua lập → Kế toán trưởng duyệt (Kế toán được báo cùng lúc) → Kế toán xác nhận đã chi. Ghi qua pm_payreq_*.';

-- Người xem: quyền Thanh toán hoặc Dự án, trong phạm vi bộ phận.
create or replace function pm_payreq_see(p_project text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or coalesce((select (app_can('payment', 'view') or app_can('project', 'view'))
                                           and (app_scope_root() or p.dept_code in (select app_scope_orgs()))
                                    from pm_project p where p.code = p_project), false)
$$;

alter table pm_payreq enable row level security;
revoke all on pm_payreq from anon;
revoke insert, update, delete on pm_payreq from authenticated;
grant select on pm_payreq to authenticated;
drop policy if exists pm_payreq_read on pm_payreq;
create policy pm_payreq_read on pm_payreq for select to authenticated using (pm_payreq_see(project_code));

do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    execute 'drop trigger if exists app_audit on pm_payreq';
    execute 'create trigger app_audit after insert or update or delete on pm_payreq for each row execute function app_audit_row()';
  end if;
end $$;

-- Vai trò của một bước (am_setting pay_route).
create or replace function pm_pay_roles(p_step text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((select value -> p_step from am_setting where key = 'pay_route'),
                  case p_step when 'prep' then '["PURCHASING"]' when 'check' then '[]' when 'watch' then '["ACCOUNTANT"]'
                              when 'approve' then '["CHIEF_ACC"]' when 'process' then '["ACCOUNTANT"]' end::jsonb)
$$;

create or replace function pm_pay_can(p_step text, p_project text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or coalesce((select am_is_actor(pm_pay_roles(p_step), p.dept_code)
                                           or (p_step = 'prep' and pm_can_prepare('PO', p.dept_code))
                                    from pm_project p where p.code = p_project), false)
$$;

-- Thông báo theo bước: người giữ vai trò của bước (không báo chính người bấm).
create or replace function pm_pay_notify(r pm_payreq, p_kind text, p_step text, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_dept text := (select dept_code from pm_project where code = r.project_code);
begin
  if p_step is not null then
    insert into pm_notice (user_id, kind, doc_no, doc_type, project_code, comment, ref_id)
    select distinct u, p_kind, r.no, 'TT', r.project_code, coalesce(p_comment, r.status), r.id
    from   am_actors(pm_pay_roles(p_step), v_dept) u
    where  u is distinct from auth.uid() and (u is distinct from r.created_by or pm_self_ok() or p_step = 'prep');
  end if;
  if p_step is null and r.created_by is not null and r.created_by is distinct from auth.uid()
     and exists (select 1 from app_user where id = r.created_by) then
    insert into pm_notice (user_id, kind, doc_no, doc_type, project_code, comment, ref_id)
    values (r.created_by, p_kind, r.no, 'TT', r.project_code, coalesce(p_comment, r.status), r.id);
  end if;
end $$;

-- Tình hình thanh toán của dự án, cho màn đề nghị: hợp đồng, lịch, đã đề nghị / đã chi, AH cuối, loại được lập.
create or replace function pm_payreq_state(p_project text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c pm_contract; v_po pm_doc; v_final boolean; v_ok boolean; v_why text; v_open int;
begin
  if not pm_payreq_see(p_project) then raise exception 'Bạn không có quyền xem dự án này.' using errcode = '42501'; end if;
  select * into c from pm_contract where project_code = p_project and status not in ('cancelled', 'rejected') order by id desc limit 1;
  select * into v_po from pm_doc where project_code = p_project and doc_type = 'PO' and status = 'approved' order by id desc limit 1;
  v_final := exists (select 1 from pm_doc where project_code = p_project and doc_type = 'AH' and status = 'approved'
                     and coalesce((data ->> 'final')::boolean, false));
  select count(*) into v_open from pm_payreq where project_code = p_project and status in ('draft', 'check', 'approve', 'process', 'returned');
  v_ok := true;
  if c.id is not null and c.status not in ('approved', 'active', 'completed') then v_ok := false; v_why := 'contract'; end if;
  if c.id is null and v_po.id is null then v_ok := false; v_why := 'po'; end if;
  if v_open > 0 then v_ok := false; v_why := 'open'; end if;
  if exists (select 1 from pm_payreq where project_code = p_project and kind = 'final' and status not in ('cancelled', 'rejected')) then v_ok := false; v_why := 'final_done'; end if;
  return jsonb_build_object(
    'contract', case when c.id is not null then jsonb_build_object('id', c.id, 'no', c.no, 'contract_no', c.contract_no, 'status', c.status,
                   'supplier', c.supplier, 'value_pre_vat', c.value_pre_vat, 'vat_pct', c.vat_pct, 'value_total', c.value_total,
                   'pay_terms', c.pay_terms, 'currency', c.currency) end,
    'po', case when v_po.id is not null then jsonb_build_object('id', v_po.id, 'doc_no', v_po.doc_no, 'total', v_po.total_value,
                   'supplier', v_po.data ->> 'supplier', 'payment_term', v_po.data ->> 'payment_term') end,
    'final_ah', v_final, 'can_new', v_ok and pm_pay_can('prep', p_project), 'why', v_why,
    'next_seq', (select count(*) + 1 from pm_payreq where project_code = p_project and status not in ('cancelled', 'rejected')),
    'requested', (select coalesce(sum(amount), 0) from pm_payreq where project_code = p_project and status not in ('cancelled', 'rejected')),
    'paid', (select coalesce(sum(coalesce(paid_amount, amount_total, amount)), 0) from pm_payreq where project_code = p_project and status = 'paid'),
    'used_terms', (select coalesce(jsonb_agg(term_idx), '[]') from pm_payreq where project_code = p_project and term_idx is not null and status not in ('cancelled', 'rejected')));
end $$;

-- Lập / sửa (nháp, bị trả về). p = {id?, project_code, kind, term_idx, milestone, pct, amount, vat_pct, invoice_no, note, links}
create or replace function pm_payreq_save(p jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare r pm_payreq; v_id bigint := nullif(p ->> 'id', '')::bigint; v_prj text; st jsonb; c pm_contract; v_kind text; v_seq int; v_amt numeric; v_vat numeric;
begin
  if v_id is null then
    v_prj := p ->> 'project_code';
    if not pm_pay_can('prep', v_prj) then raise exception 'Chỉ Thu mua (người lập PO) lập đề nghị thanh toán.' using errcode = '42501'; end if;
    st := pm_payreq_state(v_prj);
    if not (st ->> 'can_new')::boolean then
      raise exception '%', case st ->> 'why' when 'contract' then 'Hợp đồng chưa được xác nhận — xác nhận hợp đồng trước.'
                                              when 'po' then 'Dự án chưa có PO đã duyệt.'
                                              when 'open' then 'Đang có một đề nghị thanh toán chưa xong.'
                                              when 'final_done' then 'Dự án đã có đề nghị quyết toán.' else 'Chưa lập được.' end;
    end if;
    v_kind := coalesce(nullif(p ->> 'kind', ''), 'interim');
    if not exists (select 1 from pm_payreq where project_code = v_prj and status not in ('cancelled', 'rejected')) then v_kind := case when v_kind = 'final' then 'final' else 'first' end; end if;
    if v_kind = 'final' and not (st ->> 'final_ah')::boolean then
      raise exception 'Đề nghị quyết toán chỉ lập được sau khi AH cuối cùng đã duyệt.';
    end if;
    v_seq := (st ->> 'next_seq')::int;
    insert into pm_payreq (no, project_code, contract_id, po_doc_id, seq, kind, created_name)
    values (v_prj || '/TT' || lpad(v_seq::text, 2, '0'), v_prj, nullif(st -> 'contract' ->> 'id', '')::bigint,
            nullif(st -> 'po' ->> 'id', '')::bigint, v_seq, v_kind, am_me_name())
    returning id into v_id;
  end if;
  select * into r from pm_payreq where id = v_id for update;
  if r.id is null then raise exception 'Không có đề nghị %.', v_id; end if;
  if r.status not in ('draft', 'returned') then raise exception 'Đề nghị % đang "%" — không sửa được.', r.no, r.status; end if;
  if not (r.created_by = auth.uid() or pm_pay_can('prep', r.project_code)) then raise exception 'Chỉ người lập sửa được.' using errcode = '42501'; end if;
  if p ? 'kind' and p ->> 'kind' = 'final' and r.kind <> 'final'
     and not exists (select 1 from pm_doc where project_code = r.project_code and doc_type = 'AH' and status = 'approved' and coalesce((data ->> 'final')::boolean, false)) then
    raise exception 'Đề nghị quyết toán chỉ lập được sau khi AH cuối cùng đã duyệt.';
  end if;
  v_amt := nullif(p ->> 'amount', '')::numeric;
  v_vat := nullif(p ->> 'vat_pct', '')::numeric;
  update pm_payreq set
    kind         = case when p ->> 'kind' in ('interim', 'final') and r.seq > 1 then p ->> 'kind'
                        when p ->> 'kind' = 'final' then 'final' else kind end,
    term_idx     = nullif(p ->> 'term_idx', '')::int,
    milestone    = nullif(trim(p ->> 'milestone'), ''),
    pct          = nullif(p ->> 'pct', '')::numeric,
    amount       = v_amt,
    amount_contract = case when p ? 'amount_contract' then nullif(p ->> 'amount_contract', '')::numeric else amount_contract end,
    adjust_note  = case when p ? 'adjust_note' then nullif(trim(p ->> 'adjust_note'), '') else adjust_note end,
    vat_pct      = v_vat,
    amount_total = coalesce(nullif(p ->> 'amount_total', '')::numeric, case when v_amt is not null then round(v_amt * (1 + coalesce(v_vat, 0) / 100)) end),
    invoice_no   = nullif(trim(p ->> 'invoice_no'), ''),
    note         = nullif(trim(p ->> 'note'), ''),
    links        = coalesce((select jsonb_agg(jsonb_build_object('url', l ->> 'url', 'label', left(coalesce(l ->> 'label', ''), 200)))
                             from jsonb_array_elements(case when jsonb_typeof(p -> 'links') = 'array' then p -> 'links' else '[]' end) l
                             where l ->> 'url' ~* '^https://'), links),
    updated_at   = now()
  where id = r.id;
  return r.id;
end $$;

-- p_kind: vendor_letter (thư đề nghị thanh toán của nhà thầu) · invoice (hoá đơn) · other.
drop function if exists pm_payreq_file_add(bigint, text, text, bigint);
create or replace function pm_payreq_file_add(p_id bigint, p_path text, p_name text, p_size bigint, p_kind text default 'other')
returns void language plpgsql security definer set search_path = public as $$
declare r pm_payreq;
begin
  select * into r from pm_payreq where id = p_id for update;
  if r.id is null then raise exception 'Không có đề nghị %.', p_id; end if;
  if not (r.created_by = auth.uid() or pm_pay_can('prep', r.project_code) or pm_pay_can('check', r.project_code) or pm_pay_can('process', r.project_code)) then
    raise exception 'Bạn không đính kèm được vào đề nghị này.' using errcode = '42501';
  end if;
  if r.status in ('paid', 'cancelled', 'rejected') then raise exception 'Đề nghị % đã đóng.', r.no; end if;
  if p_path is null or split_part(p_path, '/', 1) <> r.id::text or length(p_path) > 300 then raise exception 'Đường dẫn tệp không hợp lệ.'; end if;
  if jsonb_array_length(r.files) >= 40 then raise exception 'Tối đa 40 tệp.'; end if;
  -- Thư đề nghị thanh toán của nhà thầu: bản scan có đóng dấu công ty (PDF hoặc ảnh), 29/09/2026.
  if p_kind = 'vendor_letter' and lower(coalesce(p_name, p_path)) !~ '\.(pdf|png|jpe?g)$' then
    raise exception 'Thư đề nghị thanh toán của nhà thầu: tải bản scan có đóng dấu (PDF, PNG, JPG).';
  end if;
  update pm_payreq set files = files || jsonb_build_array(jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, ''), 200), 'size', p_size,
                                                                             'kind', case when p_kind in ('vendor_letter', 'invoice') then p_kind else 'other' end,
                                                                             'by', am_me_name(), 'at', now())), updated_at = now()
   where id = r.id;
end $$;

create or replace function pm_payreq_file_del(p_id bigint, p_path text)
returns void language plpgsql security definer set search_path = public as $$
declare r pm_payreq;
begin
  select * into r from pm_payreq where id = p_id for update;
  if r.id is null or not (r.created_by = auth.uid() or pm_pay_can('prep', r.project_code)) or r.status not in ('draft', 'returned') then
    raise exception 'Chỉ người lập gỡ tệp được, khi đề nghị còn nháp.' using errcode = '42501';
  end if;
  update pm_payreq set files = coalesce((select jsonb_agg(f) from jsonb_array_elements(files) f where f ->> 'path' <> p_path), '[]'), updated_at = now()
   where id = r.id;
end $$;

create or replace function pm_payreq_log(p_id bigint, p_step text, p_action text, p_comment text)
returns void language sql security definer set search_path = public as $$
  update pm_payreq set route = route || jsonb_build_array(jsonb_build_object('step', p_step, 'action', p_action, 'by', auth.uid(),
                                                                             'name', am_me_name(), 'at', now(), 'comment', nullif(trim(p_comment), '')))
   where id = p_id
$$;

-- Gửi: cần số tiền, hồ sơ đính kèm và thư đề nghị thanh toán của nhà thầu (bản scan có đóng dấu).
-- p = {sig: {png}}: chữ ký của người gửi (Thu mua), 29/09/2026.
drop function if exists pm_payreq_submit(bigint);
create or replace function pm_payreq_submit(p_id bigint, p jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r pm_payreq; v_to text; v_sig jsonb;
begin
  select * into r from pm_payreq where id = p_id for update;
  if r.id is null then raise exception 'Không có đề nghị %.', p_id; end if;
  if r.status not in ('draft', 'returned') then raise exception 'Đề nghị % đang "%".', r.no, r.status; end if;
  if not (r.created_by = auth.uid() or pm_pay_can('prep', r.project_code)) then raise exception 'Chỉ người lập gửi được.' using errcode = '42501'; end if;
  if coalesce(r.amount, r.amount_total, 0) <= 0 then raise exception 'Nhập số tiền đề nghị.'; end if;
  if jsonb_array_length(r.files) + jsonb_array_length(r.links) = 0 then raise exception 'Đính kèm hồ sơ thanh toán (tệp hoặc link) trước khi gửi.'; end if;
  -- Thư đề nghị thanh toán của nhà thầu (bản scan có đóng dấu công ty) luôn bắt buộc (29/09/2026).
  if not exists (select 1 from jsonb_array_elements(r.files) f where f ->> 'kind' = 'vendor_letter') then
    raise exception 'Đính kèm thư đề nghị thanh toán của nhà thầu (bản scan có đóng dấu công ty) trước khi gửi.';
  end if;
  -- Số tiền khác lịch thanh toán của hợp đồng: ghi lý do điều chỉnh.
  if r.amount_contract is not null and abs(coalesce(r.amount, 0) - r.amount_contract) >= 1
     and coalesce(trim(r.adjust_note), '') = '' then raise exception 'Số tiền khác hợp đồng: ghi lý do điều chỉnh.'; end if;
  v_sig := pm_sig_check(p -> 'sig');
  -- Có bước kiểm tra (pay_route.check) thì tới đó; không thì thẳng tới Kế toán trưởng duyệt.
  v_to := case when jsonb_array_length(coalesce(pm_pay_roles('check'), '[]')) > 0 then 'check' else 'approve' end;
  update pm_payreq set status = v_to, submitted_at = now(), submitted_name = am_me_name(), submitted_sig = v_sig, updated_at = now()
   where id = r.id returning * into r;
  perform pm_payreq_log(r.id, 'prep', case when r.route @> '[{"action": "return"}]' then 'resubmit' else 'submit' end, null);
  perform pm_pay_notify(r, 'pay', v_to, v_to);
  perform pm_pay_notify(r, 'info', 'watch', 'submitted');         -- Kế toán nắm thông tin cùng lúc
end $$;

-- Kiểm tra (check) · duyệt (approve) · chi (process). p_action: approve | return | reject | paid.
-- p = {paid_at, paid_amount, voucher_no} khi chi.
create or replace function pm_payreq_act(p_id bigint, p_action text, p_comment text default null, p jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare r pm_payreq; v_step text; v_to text; v_sig jsonb;
begin
  select * into r from pm_payreq where id = p_id for update;
  if r.id is null then raise exception 'Không có đề nghị %.', p_id; end if;
  if r.status not in ('check', 'approve', 'process') then raise exception 'Đề nghị % không chờ xử lý.', r.no; end if;
  v_step := r.status;
  if not pm_pay_can(v_step, r.project_code) then
    raise exception 'Bước này cần vai trò %.', (select string_agg(x, ' / ') from jsonb_array_elements_text(pm_pay_roles(v_step)) x) using errcode = '42501';
  end if;
  if r.created_by = auth.uid() and not pm_self_ok() and not app_trusted() then
    raise exception 'Người lập không tự kiểm tra / duyệt đề nghị của mình.' using errcode = '42501';
  end if;
  if p_action in ('return', 'reject') and coalesce(trim(p_comment), '') = '' then raise exception 'Trả về hoặc từ chối phải ghi lý do.'; end if;
  if p_action = 'reject' and v_step <> 'approve' then raise exception 'Chỉ bước duyệt mới từ chối được — bước này trả về.'; end if;
  if p_action = 'paid' and v_step <> 'process' then raise exception 'Chỉ ghi đã chi ở bước thực hiện chi.'; end if;
  if p_action = 'approve' and v_step = 'process' then p_action := 'paid'; end if;
  if p_action not in ('approve', 'return', 'reject', 'paid') then raise exception 'Thao tác không hợp lệ: %', p_action; end if;

  if p_action = 'return' then
    update pm_payreq set status = 'returned', updated_at = now() where id = r.id returning * into r;
    perform pm_payreq_log(r.id, v_step, 'return', p_comment);
    perform pm_pay_notify(r, 'pay', null, 'returned: ' || trim(p_comment));
    return 'returned';
  elsif p_action = 'reject' then
    update pm_payreq set status = 'rejected', updated_at = now() where id = r.id returning * into r;
    perform pm_payreq_log(r.id, v_step, 'reject', p_comment);
    perform pm_pay_notify(r, 'pay', null, 'rejected: ' || trim(p_comment));
    return 'rejected';
  elsif p_action = 'approve' then
    v_to := case v_step when 'check' then 'approve' else 'process' end;
    if v_step = 'approve' then
      -- Kế toán trưởng duyệt (ký): tên, giờ và chữ ký thành dấu "Approved by CA" trên hồ sơ in ra.
      v_sig := pm_sig_check(p -> 'sig');
      update pm_payreq set approved_by = auth.uid(), approved_name = am_me_name(), approved_at = now(), approved_sig = v_sig where id = r.id;
    end if;
    update pm_payreq set status = v_to, updated_at = now() where id = r.id returning * into r;
    perform pm_payreq_log(r.id, v_step, 'approve', p_comment);
    perform pm_pay_notify(r, 'pay', v_to, v_to);
    perform pm_pay_notify(r, 'info', null, v_to);                      -- Thu mua thấy hồ sơ đi tới đâu
    return v_to;
  end if;
  -- Đã chi: Kế toán ký (p.sig), tên và chữ ký hiện ở ô "Đã chi" của trang đề nghị.
  if nullif(p ->> 'paid_at', '') is null then raise exception 'Nhập ngày chi.'; end if;
  v_sig := pm_sig_check(p -> 'sig');
  update pm_payreq set status = 'paid', paid_at = (p ->> 'paid_at')::date, paid_by = auth.uid(), paid_name = am_me_name(), paid_sig = v_sig,
                       paid_amount = coalesce(nullif(p ->> 'paid_amount', '')::numeric, amount_total, amount),
                       voucher_no = nullif(trim(p ->> 'voucher_no'), ''), updated_at = now()
   where id = r.id returning * into r;
  perform pm_payreq_log(r.id, 'process', 'paid', p_comment);
  perform pm_pay_notify(r, 'pay', null, 'paid');
  -- Dòng lịch thanh toán của hợp đồng: đã chi.
  if r.contract_id is not null and r.term_idx is not null then
    update pm_contract set pay_terms = jsonb_set(pay_terms, array[r.term_idx::text, 'paid'], 'true'::jsonb, true), updated_at = now()
     where id = r.contract_id and jsonb_typeof(pay_terms) = 'array' and jsonb_array_length(pay_terms) > r.term_idx;
  end if;
  -- Quyết toán xong: dự án hoàn thành, hợp đồng hoàn thành (còn bảo hành).
  if r.kind = 'final' then
    update pm_project set status_override = 'completed'
     where code = r.project_code and (status_override is null or status_override = 'in_progress');
    update pm_contract set status = 'completed', updated_at = now() where id = r.contract_id and status in ('approved', 'active');
  end if;
  return 'paid';
end $$;

-- Kế toán xác nhận đã thanh toán NHIỀU đề nghị một lúc (cùng ngày chi; số tiền = số đã duyệt gồm VAT,
-- số chứng từ chung nếu có). Trả về số đề nghị đã ghi.
create or replace function pm_payreq_paid_many(p_ids bigint[], p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare v_id bigint; n int := 0;
begin
  if nullif(p ->> 'paid_at', '') is null then raise exception 'Nhập ngày chi.'; end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    perform pm_payreq_act(v_id, 'paid', nullif(trim(p ->> 'note'), ''),
                          jsonb_build_object('paid_at', p ->> 'paid_at', 'voucher_no', p ->> 'voucher_no', 'sig', p -> 'sig'));   -- một chữ ký cho cả lô
    n := n + 1;
  end loop;
  return n;
end $$;

-- Số AH (29/09/2026): AH không phải bản cuối mang đuôi -01, -02… theo thứ tự lập; AH cuối giữ số gốc
-- (AH.KIT.05.2026). Đặt lại mỗi khi AH còn nháp / bị trả về / gửi duyệt; AH đã duyệt giữ nguyên số.
create or replace function pm_ah_no_trg()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_base text; v_n int; v_no text;
begin
  if new.doc_type <> 'AH' or new.status not in ('draft', 'returned', 'in_review') then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then return new; end if;
  v_base := regexp_replace(new.doc_no, '(/\d+|-\d{2})$', '');
  if coalesce((new.data ->> 'final')::boolean, false) then
    v_no := v_base;
  else
    select count(*) + 1 into v_n from pm_doc x
     where x.project_code = new.project_code and x.doc_type = 'AH' and x.id <> new.id and x.id < coalesce(new.id, 9223372036854775807)
       and x.status not in ('cancelled', 'rejected') and not coalesce((x.data ->> 'final')::boolean, false);
    v_no := v_base || '-' || lpad(v_n::text, 2, '0');
  end if;
  -- Số đã có ở chứng từ khác (vd AH cuối cũ bị huỷ): giữ số hiện tại.
  if v_no <> new.doc_no and not exists (select 1 from pm_doc y where y.doc_no = v_no and y.id <> coalesce(new.id, -1)) then
    new.doc_no := v_no;
  end if;
  return new;
end $$;
drop trigger if exists pm_ah_no on pm_doc;
create trigger pm_ah_no before insert or update of data, status on pm_doc for each row execute function pm_ah_no_trg();

create or replace function pm_payreq_cancel(p_id bigint, p_comment text)
returns void language plpgsql security definer set search_path = public as $$
declare r pm_payreq;
begin
  select * into r from pm_payreq where id = p_id for update;
  if r.id is null then raise exception 'Không có đề nghị %.', p_id; end if;
  if r.status in ('paid', 'cancelled') then raise exception 'Đề nghị % đã %.', r.no, r.status; end if;
  if not (app_trusted() or app_can('payment', 'admin') or (r.created_by = auth.uid() and r.status in ('draft', 'returned'))) then
    raise exception 'Chỉ người lập (khi còn nháp) hoặc quản trị huỷ được.' using errcode = '42501';
  end if;
  update pm_payreq set status = 'cancelled', updated_at = now() where id = r.id;
  perform pm_payreq_log(r.id, r.status, 'cancel', p_comment);
end $$;

-- Việc của tôi ở đề nghị thanh toán + các đề nghị cần lập (cho To-do list):
--   pay_check / pay_approve / pay_process   đang chờ bước của tôi
--   pay_returned                            bị trả về tôi
--   pay_first                               hợp đồng đã xác nhận (hoặc chỉ có PO) mà chưa đề nghị lần nào
--   pay_final                               AH cuối đã duyệt mà chưa đề nghị quyết toán
create or replace function pm_todo_pay()
returns table (kind text, project_code text, project_name text, dept_code text, ref_id bigint, ref_no text, at timestamptz, amount numeric, detail text)
language sql stable security definer set search_path = public as $$
  select 'pay_' || r.status, r.project_code, p.name, p.dept_code, r.id, r.no, coalesce(r.submitted_at, r.created_at), coalesce(r.amount_total, r.amount), r.kind
  from   pm_payreq r join pm_project p on p.code = r.project_code
  where  r.status in ('check', 'approve', 'process') and pm_pay_can(r.status, r.project_code)
    and  (r.created_by is distinct from auth.uid() or pm_self_ok())
  union all
  select 'pay_returned', r.project_code, p.name, p.dept_code, r.id, r.no, r.updated_at, coalesce(r.amount_total, r.amount), r.kind
  from   pm_payreq r join pm_project p on p.code = r.project_code
  where  r.status = 'returned' and r.created_by = auth.uid()
  union all
  select 'pay_first', p.code, p.name, p.dept_code, coalesce(c.id, po.id), coalesce(c.no, po.doc_no), coalesce(c.approved_at, po.decided_at),
         coalesce(c.value_pre_vat, po.total_value), null
  from   pm_project p
  join   lateral (select * from pm_doc d where d.project_code = p.code and d.doc_type = 'PO' and d.status = 'approved' order by d.id desc limit 1) po on true
  left   join lateral (select * from pm_contract x where x.project_code = p.code and x.status not in ('cancelled', 'rejected') order by x.id desc limit 1) c on true
  where  p.status not in ('completed', 'cancelled') and not coalesce(p.wf_offline, false)
    and  c.status in ('approved', 'active')                                -- chỉ có PO: không nhắc (có thể không cần đề nghị qua app)
    and  not exists (select 1 from pm_payreq r where r.project_code = p.code and r.status <> 'cancelled')
    and  pm_pay_can('prep', p.code)
  union all
  select 'pay_final', p.code, p.name, p.dept_code, ah.id, ah.doc_no, ah.decided_at, null, null
  from   pm_project p
  join   lateral (select * from pm_doc d where d.project_code = p.code and d.doc_type = 'AH' and d.status = 'approved'
                  and coalesce((d.data ->> 'final')::boolean, false) order by d.id desc limit 1) ah on true
  where  not coalesce(p.wf_offline, false) and p.status <> 'cancelled'
    and  exists (select 1 from pm_payreq r where r.project_code = p.code and r.status not in ('cancelled', 'rejected'))
    and  not exists (select 1 from pm_payreq r where r.project_code = p.code and r.kind = 'final' and r.status not in ('cancelled', 'rejected'))
    and  not exists (select 1 from pm_payreq r where r.project_code = p.code and r.status in ('draft', 'check', 'approve', 'process', 'returned'))
    and  pm_pay_can('prep', p.code)
$$;

-- Dự án có hợp đồng / đề nghị thanh toán: AH cuối duyệt xong thì vẫn "Đang thực hiện" tới khi quyết toán xong.
create or replace function pm_pay_hold_trg()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.doc_type <> 'AH' or new.status <> 'approved' or old.status = 'approved'
     or not coalesce((new.data ->> 'final')::boolean, false) then return new; end if;
  if (exists (select 1 from pm_contract c where c.project_code = new.project_code and c.status not in ('cancelled', 'rejected'))
      or exists (select 1 from pm_payreq r where r.project_code = new.project_code and r.status <> 'cancelled'))
     and not exists (select 1 from pm_payreq r where r.project_code = new.project_code and r.kind = 'final' and r.status = 'paid') then
    update pm_project set status_override = 'in_progress' where code = new.project_code and status_override is null;
  end if;
  return new;
end $$;
drop trigger if exists pm_pay_hold on pm_doc;
create trigger pm_pay_hold after update of status on pm_doc for each row execute function pm_pay_hold_trg();


-- =====================================================================
-- 4. STORAGE — bucket riêng "pm-payreq" (<id đề nghị>/<tệp>)
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pm-payreq', 'pm-payreq', false, 26214400,
        array['application/pdf', 'image/png', 'image/jpeg',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
              'application/zip', 'application/x-zip-compressed', 'text/xml', 'application/xml'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function pm_payreq_path_ok(p_name text, p_write boolean)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from pm_payreq r where r.id::text = split_part(coalesce(p_name, ''), '/', 1)
                 and case when p_write then r.status not in ('paid', 'cancelled', 'rejected')
                                            and (r.created_by = auth.uid() or pm_pay_can('prep', r.project_code)
                                                 or pm_pay_can('check', r.project_code) or pm_pay_can('process', r.project_code))
                          else pm_payreq_see(r.project_code) end)
$$;

drop policy if exists pm_payreq_up on storage.objects;
create policy pm_payreq_up on storage.objects for insert to authenticated
  with check (bucket_id = 'pm-payreq' and pm_payreq_path_ok(name, true));
drop policy if exists pm_payreq_rd on storage.objects;
create policy pm_payreq_rd on storage.objects for select to authenticated
  using (bucket_id = 'pm-payreq' and pm_payreq_path_ok(name, false));
drop policy if exists pm_payreq_del on storage.objects;
create policy pm_payreq_del on storage.objects for delete to authenticated
  using (bucket_id = 'pm-payreq' and pm_payreq_path_ok(name, true));


-- =====================================================================
-- 5. QUYỀN GỌI HÀM
-- =====================================================================

revoke execute on function pm_pay_notify(pm_payreq, text, text, text), pm_payreq_log(bigint, text, text, text), pm_pay_hold_trg(), pm_ah_no_trg()
  from public, anon, authenticated;
revoke execute on function pm_ct_from_po(bigint), pm_ct_confirm(bigint), pm_payreq_see(text), pm_pay_roles(text), pm_pay_can(text, text),
  pm_payreq_state(text), pm_payreq_save(jsonb), pm_payreq_file_add(bigint, text, text, bigint, text), pm_payreq_file_del(bigint, text), pm_payreq_paid_many(bigint[], jsonb),
  pm_payreq_submit(bigint, jsonb), pm_payreq_act(bigint, text, text, jsonb), pm_payreq_cancel(bigint, text), pm_todo_pay(),
  pm_payreq_path_ok(text, boolean) from public, anon;
grant execute on function pm_ct_from_po(bigint), pm_ct_confirm(bigint), pm_payreq_see(text), pm_pay_roles(text), pm_pay_can(text, text),
  pm_payreq_state(text), pm_payreq_save(jsonb), pm_payreq_file_add(bigint, text, text, bigint, text), pm_payreq_file_del(bigint, text), pm_payreq_paid_many(bigint[], jsonb),
  pm_payreq_submit(bigint, jsonb), pm_payreq_act(bigint, text, text, jsonb), pm_payreq_cancel(bigint, text), pm_todo_pay(),
  pm_payreq_path_ok(text, boolean) to authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Vai trò Kế toán (ACCOUNTANT)' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   app_role where code = 'ACCOUNTANT'
union all
select 'Bảng đề nghị thanh toán có RLS', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_class where relname = 'pm_payreq' and relrowsecurity
union all
select 'Khách (anon) đọc bảng đề nghị (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants where table_name = 'pm_payreq' and grantee = 'anon'
union all
select 'Tuyến đề nghị thanh toán (pay_route)', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   am_setting where key = 'pay_route'
union all
select 'Bucket pm-payreq (riêng tư) + 3 chính sách', (select count(*) from storage.buckets where id = 'pm-payreq' and not public)::text || ' + ' || count(*)::text,
       '1 + 3', case when count(*) = 3 and exists (select 1 from storage.buckets where id = 'pm-payreq' and not public) then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('pm_payreq_up', 'pm_payreq_rd', 'pm_payreq_del')
union all
select 'Hợp đồng nhận nguồn "po"', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_constraint where conname = 'pm_contract_source_check' and pg_get_constraintdef(oid) like '%po%'
union all
select 'Trigger giữ "Đang thực hiện" tới khi quyết toán', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_trigger where tgname = 'pm_pay_hold' and not tgisinternal
union all
select 'Số AH: AH chưa phải bản cuối mang đuôi -01, -02…', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_trigger where tgname = 'pm_ah_no' and not tgisinternal
union all
select 'Tuyến thanh toán: Thu mua → KTT duyệt → Kế toán xác nhận chi', coalesce((select value::text from am_setting where key = 'pay_route'), '—'), 'check = [] (hoặc đã chỉnh)', '✔';
