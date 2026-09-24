-- =====================================================================
-- 21_pm_payment.sql — QUẢN LÝ DỰ ÁN, GIAI ĐOẠN 5: HOÁ ĐƠN & THANH TOÁN
--
-- Chạy SAU 20_pm_notify.sql.
--
-- Hai file kế toán xuất hằng tháng, đều CỘNG DỒN TỪ ĐẦU NĂM — nạp lại tháng sau
-- là cập nhật, không phải cộng thêm:
--   * Bảng kê hoá đơn mua vào (Bang_ke_hoa_don...)  → pm_invoice
--       giá trị CHƯA THUẾ + thuế GTGT + thuế suất. Khoá: MST người bán + ký
--       hiệu + số hoá đơn.
--   * Thu chi tiền gửi (Thu_chi_tien_gui...)         → pm_payment
--       số tiền ĐÃ GỒM THUẾ chi ra ngân hàng. Khoá: số chứng từ + thứ tự dòng
--       trong cùng chứng từ.
--
-- Nguyên tắc tiền (quyết định 24/09/2026):
--   * tiêu hao ngân sách tính trên giá CHƯA THUẾ (thuế GTGT đầu vào được khấu
--     trừ, nguyên giá tài sản là giá chưa thuế) → lấy từ hoá đơn;
--   * dòng tiền tính trên số ĐÃ GỒM THUẾ → lấy từ thu chi ngân hàng;
--   * thuế GTGT luôn hiện thành một số riêng.
--
-- Phân bổ về dự án: mã dự án nằm lẫn trong cột Diễn giải. Khi nạp, hàm tự tìm
-- mã; đúng MỘT mã khớp đúng MỘT dự án thì phân bổ 100% tự động. Còn lại (hai
-- mã, mã bị cắt "FFE.JVC....", mã chính có nhiều dự án con, không có mã) vào
-- hàng "Chờ phân bổ" để người dùng chia tay. Phân bổ lưu theo TỶ LỆ, nên hoá
-- đơn bị sửa số tiền ở lần nạp sau vẫn giữ nguyên cách chia.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_pay_import (
  id           bigserial primary key,
  kind         text not null check (kind in ('invoice', 'payment')),
  file_name    text,
  period_from  date,
  period_to    date,
  n_rows       int,
  n_new        int,
  n_updated    int,
  n_auto       int,
  n_queue      int,
  n_gone       int,
  imported_by  uuid default auth.uid(),
  imported_at  timestamptz not null default now()
);

create table if not exists pm_invoice (
  id            bigserial primary key,
  seller_tax    text not null default '',
  series        text not null default '',
  invoice_no    text not null,
  invoice_date  date,
  voucher_no    text,
  voucher_date  date,
  post_date     date,
  seller_name   text,
  net           numeric(18, 2) not null default 0,
  vat           numeric(18, 2) not null default 0,
  vat_rate      text,
  description   text,
  codes_found   text[],
  -- auto: hàm tự phân bổ · manual: người dùng chia · ignore: không thuộc dự án
  -- nào · null: đang chờ phân bổ
  alloc_mode    text check (alloc_mode in ('auto', 'manual', 'ignore')),
  import_id     bigint references pm_pay_import(id) on delete set null,
  gone          boolean not null default false,
  updated_at    timestamptz not null default now(),
  unique (seller_tax, series, invoice_no)
);
comment on column pm_invoice.gone is
  'true = lần nạp gần nhất phủ kỳ của dòng này nhưng không còn thấy nó (kế toán đã xoá/sửa chứng từ). Không tự xoá — để người dùng xem.';

create table if not exists pm_payment (
  id            bigserial primary key,
  voucher_no    text not null,
  line_no       int  not null default 1,
  voucher_date  date,
  post_date     date,
  description   text,
  amount        numeric(18, 2) not null default 0,
  vendor_code   text,
  vendor_name   text,
  bank_account  text,
  reason        text,
  voucher_type  text,
  codes_found   text[],
  alloc_mode    text check (alloc_mode in ('auto', 'manual', 'ignore')),
  import_id     bigint references pm_pay_import(id) on delete set null,
  gone          boolean not null default false,
  updated_at    timestamptz not null default now(),
  unique (voucher_no, line_no)
);

create table if not exists pm_pay_alloc (
  id           bigserial primary key,
  kind         text not null check (kind in ('invoice', 'payment')),
  ref_id       bigint not null,
  project_code text not null references pm_project(code) on update cascade on delete cascade,
  share        numeric(9, 6) not null check (share > 0 and share <= 1),
  unique (kind, ref_id, project_code)
);
create index if not exists pm_pay_alloc_ref_idx  on pm_pay_alloc (kind, ref_id);
create index if not exists pm_pay_alloc_proj_idx on pm_pay_alloc (project_code);
comment on column pm_pay_alloc.share is 'Tỷ lệ của dòng hoá đơn / thanh toán thuộc về dự án này (0–1).';

-- Xoá một hoá đơn / thanh toán thì xoá luôn phân bổ của nó (không có FK vì
-- một bảng phân bổ phục vụ hai bảng nguồn).
create or replace function pm_pay_alloc_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from pm_pay_alloc
  where kind = case tg_table_name when 'pm_invoice' then 'invoice' else 'payment' end
    and ref_id = old.id;
  return old;
end $$;
drop trigger if exists pm_pay_alloc_cleanup on pm_invoice;
create trigger pm_pay_alloc_cleanup after delete on pm_invoice
  for each row execute function pm_pay_alloc_cleanup();
drop trigger if exists pm_pay_alloc_cleanup on pm_payment;
create trigger pm_pay_alloc_cleanup after delete on pm_payment
  for each row execute function pm_pay_alloc_cleanup();


-- =====================================================================
-- 2. TÌM MÃ DỰ ÁN TRONG DIỄN GIẢI
-- =====================================================================

-- Mọi chuỗi có dạng mã dự án: CHỮ(.CHỮ/SỐ)*.NĂM(.SỐ CON). Số hợp đồng kiểu
-- "1904.2024.HĐMB" hay "2025.03.13.MINATEK" bắt đầu bằng số nên không khớp.
create or replace function pm_codes_in(p_text text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(distinct m[1]), '{}')
  from   regexp_matches(upper(coalesce(p_text, '')),
                        '(?:^|[^A-Z0-9.])([A-Z]{2,}(?:\.[A-Z0-9]+)*\.(?:19|20)[0-9]{2}(?:\.[0-9]{1,2})?)(?![0-9])',
                        'g') as m
$$;

-- Một mã tìm thấy → dự án nào. Khớp đúng mã con, hoặc mã chính chỉ có một
-- dự án. Mã chính có nhiều dự án con thì KHÔNG đoán (trả null).
create or replace function pm_code_project(p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select code from pm_project where code = p_code),
    (select min(code) from pm_project where main_code = p_code having count(*) = 1))
$$;

-- Phân bổ tự động một dòng: đúng một mã, khớp đúng một dự án → 100%.
-- Trả về true nếu đã phân bổ. Không đụng dòng người dùng đã chia tay / bỏ qua.
create or replace function pm_auto_alloc(p_kind text, p_id bigint, p_desc text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_codes text[] := pm_codes_in(p_desc); v_proj text; v_mode text;
begin
  if p_kind = 'invoice' then
    select alloc_mode into v_mode from pm_invoice where id = p_id;
    update pm_invoice set codes_found = v_codes where id = p_id;
  else
    select alloc_mode into v_mode from pm_payment where id = p_id;
    update pm_payment set codes_found = v_codes where id = p_id;
  end if;
  if v_mode in ('manual', 'ignore') then return true; end if;   -- người dùng đã quyết, không phải hàng chờ

  delete from pm_pay_alloc where kind = p_kind and ref_id = p_id;
  if cardinality(v_codes) = 1 then v_proj := pm_code_project(v_codes[1]); end if;
  if v_proj is not null then
    insert into pm_pay_alloc (kind, ref_id, project_code, share) values (p_kind, p_id, v_proj, 1);
  end if;
  if p_kind = 'invoice' then
    update pm_invoice set alloc_mode = case when v_proj is null then null else 'auto' end where id = p_id;
  else
    update pm_payment set alloc_mode = case when v_proj is null then null else 'auto' end where id = p_id;
  end if;
  return v_proj is not null;
end $$;


-- =====================================================================
-- 3. NẠP FILE (một giao dịch — lỗi giữa chừng thì không đổi gì)
-- =====================================================================

/* p_rows: mảng dòng đã đọc từ Excel (trình duyệt đọc, database kiểm tra).
   Hoá đơn: {seller_tax, series, invoice_no, invoice_date, voucher_no,
             voucher_date, post_date, seller_name, net, vat, vat_rate, description}
   Thanh toán: {voucher_no, line_no, voucher_date, post_date, description,
             amount, vendor_code, vendor_name, bank_account, reason, voucher_type} */
create or replace function pm_import_pay(p_kind text, p_rows jsonb, p_file text,
                                         p_from date default null, p_to date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_imp  bigint;
  r      jsonb;
  v_id   bigint;
  v_new  boolean;
  n_new  int := 0; n_upd int := 0; n_auto int := 0; n_queue int := 0; n_gone int := 0;
  v_from date := p_from; v_to date := p_to;
begin
  perform app_require('payment', 'create');
  if p_kind not in ('invoice', 'payment') then raise exception 'Loại file không hợp lệ: %', p_kind; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'File không có dòng dữ liệu nào.';
  end if;

  insert into pm_pay_import (kind, file_name) values (p_kind, p_file) returning id into v_imp;

  for r in select * from jsonb_array_elements(p_rows) loop
    if p_kind = 'invoice' then
      if coalesce(r ->> 'invoice_no', '') = '' then continue; end if;
      insert into pm_invoice as t (seller_tax, series, invoice_no, invoice_date, voucher_no, voucher_date,
                                   post_date, seller_name, net, vat, vat_rate, description, import_id)
      values (coalesce(r ->> 'seller_tax', ''), coalesce(r ->> 'series', ''), r ->> 'invoice_no',
              nullif(r ->> 'invoice_date', '')::date, r ->> 'voucher_no', nullif(r ->> 'voucher_date', '')::date,
              nullif(r ->> 'post_date', '')::date, r ->> 'seller_name',
              coalesce(nullif(r ->> 'net', '')::numeric, 0), coalesce(nullif(r ->> 'vat', '')::numeric, 0),
              r ->> 'vat_rate', r ->> 'description', v_imp)
      on conflict (seller_tax, series, invoice_no) do update
        set invoice_date = excluded.invoice_date, voucher_no = excluded.voucher_no,
            voucher_date = excluded.voucher_date, post_date = excluded.post_date,
            seller_name = excluded.seller_name, net = excluded.net, vat = excluded.vat,
            vat_rate = excluded.vat_rate, description = excluded.description,
            import_id = v_imp, gone = false, updated_at = now()
      returning t.id, (t.xmax = 0) into v_id, v_new;
      if pm_auto_alloc('invoice', v_id, r ->> 'description') then n_auto := n_auto + 1; else n_queue := n_queue + 1; end if;
    else
      if coalesce(r ->> 'voucher_no', '') = '' then continue; end if;
      insert into pm_payment as t (voucher_no, line_no, voucher_date, post_date, description, amount,
                                   vendor_code, vendor_name, bank_account, reason, voucher_type, import_id)
      values (r ->> 'voucher_no', coalesce(nullif(r ->> 'line_no', '')::int, 1),
              nullif(r ->> 'voucher_date', '')::date, nullif(r ->> 'post_date', '')::date,
              r ->> 'description', coalesce(nullif(r ->> 'amount', '')::numeric, 0),
              nullif(r ->> 'vendor_code', ''), r ->> 'vendor_name', r ->> 'bank_account',
              r ->> 'reason', r ->> 'voucher_type', v_imp)
      on conflict (voucher_no, line_no) do update
        set voucher_date = excluded.voucher_date, post_date = excluded.post_date,
            description = excluded.description, amount = excluded.amount,
            vendor_code = excluded.vendor_code, vendor_name = excluded.vendor_name,
            bank_account = excluded.bank_account, reason = excluded.reason,
            voucher_type = excluded.voucher_type, import_id = v_imp, gone = false, updated_at = now()
      returning t.id, (t.xmax = 0) into v_id, v_new;
      if pm_auto_alloc('payment', v_id, r ->> 'description') then n_auto := n_auto + 1; else n_queue := n_queue + 1; end if;
      -- Nhà cung cấp mới gặp lần đầu: thêm vào danh mục (mã = mã đối tượng kế toán).
      if coalesce(r ->> 'vendor_code', '') <> '' then
        insert into pm_vendor (code, name) values (r ->> 'vendor_code', coalesce(nullif(r ->> 'vendor_name', ''), r ->> 'vendor_code'))
        on conflict (code) do nothing;
      end if;
    end if;
    if v_new then n_new := n_new + 1; else n_upd := n_upd + 1; end if;
  end loop;

  -- Kỳ của file: truyền vào (bảng kê ghi "Từ ngày … đến ngày …"), không thì
  -- lấy theo ngày hạch toán nhỏ nhất / lớn nhất trong file.
  if p_kind = 'invoice' then
    if v_from is null then select min(post_date), max(post_date) into v_from, v_to from pm_invoice where import_id = v_imp; end if;
    update pm_invoice set gone = true
     where import_id is distinct from v_imp and not gone and post_date between v_from and v_to;
  else
    if v_from is null then select min(post_date), max(post_date) into v_from, v_to from pm_payment where import_id = v_imp; end if;
    update pm_payment set gone = true
     where import_id is distinct from v_imp and not gone and post_date between v_from and v_to;
  end if;
  get diagnostics n_gone = row_count;

  update pm_pay_import
     set period_from = v_from, period_to = v_to, n_rows = n_new + n_upd, n_new = n_new, n_updated = n_upd,
         n_auto = n_auto, n_queue = n_queue, n_gone = n_gone
   where id = v_imp;
  return jsonb_build_object('import_id', v_imp, 'rows', n_new + n_upd, 'new', n_new, 'updated', n_upd,
                            'auto', n_auto, 'queue', n_queue, 'gone', n_gone,
                            'from', v_from, 'to', v_to);
end $$;

/* Chia tay một dòng: p_alloc = [{project_code, share}], tổng share = 1.
   p_mode 'ignore' = dòng không thuộc dự án nào (phí ngân hàng...), p_alloc bỏ
   qua. p_mode 'auto' = trả về cho máy tự phân bổ lại theo diễn giải. */
create or replace function pm_alloc_set(p_kind text, p_id bigint, p_alloc jsonb, p_mode text default 'manual')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_sum numeric; v_desc text;
begin
  perform app_require('payment', 'edit');
  if p_kind not in ('invoice', 'payment') then raise exception 'Loại không hợp lệ: %', p_kind; end if;
  if p_mode not in ('manual', 'ignore', 'auto') then raise exception 'Chế độ không hợp lệ: %', p_mode; end if;
  if p_kind = 'invoice' then
    select description into v_desc from pm_invoice where id = p_id;
    if not found then raise exception 'Không có hoá đơn %', p_id; end if;
  else
    select description into v_desc from pm_payment where id = p_id;
    if not found then raise exception 'Không có dòng thanh toán %', p_id; end if;
  end if;

  if p_mode = 'auto' then
    if p_kind = 'invoice' then update pm_invoice set alloc_mode = null where id = p_id;
    else update pm_payment set alloc_mode = null where id = p_id; end if;
    perform pm_auto_alloc(p_kind, p_id, v_desc);
    return;
  end if;

  delete from pm_pay_alloc where kind = p_kind and ref_id = p_id;
  if p_mode = 'manual' then
    select sum((a ->> 'share')::numeric) into v_sum from jsonb_array_elements(coalesce(p_alloc, '[]')) a;
    if v_sum is null or abs(v_sum - 1) > 0.0001 then
      raise exception 'Tổng tỷ lệ phân bổ phải bằng 100%% (đang là % %%).', round(coalesce(v_sum, 0) * 100, 2);
    end if;
    insert into pm_pay_alloc (kind, ref_id, project_code, share)
    select p_kind, p_id, a ->> 'project_code', (a ->> 'share')::numeric
    from   jsonb_array_elements(p_alloc) a;
  end if;
  if p_kind = 'invoice' then update pm_invoice set alloc_mode = p_mode where id = p_id;
  else update pm_payment set alloc_mode = p_mode where id = p_id; end if;
end $$;


-- =====================================================================
-- 4. SỐ LIỆU THEO DỰ ÁN
-- =====================================================================

-- Mỗi dự án: đã xuất hoá đơn (chưa thuế, thuế, gồm thuế) và đã chi (gồm
-- thuế). Dòng "gone" không tính. RLS của các bảng nguồn áp qua security_invoker.
create or replace view pm_project_money with (security_invoker = true) as
select p.code as project_code,
       coalesce(i.net, 0)   as invoiced_net,
       coalesce(i.vat, 0)   as invoiced_vat,
       coalesce(i.net, 0) + coalesce(i.vat, 0) as invoiced_gross,
       coalesce(i.n, 0)     as n_invoices,
       coalesce(y.paid, 0)  as paid_gross,
       coalesce(y.n, 0)     as n_payments,
       y.last_paid
from   pm_project p
left join (select a.project_code, sum(v.net * a.share) as net, sum(v.vat * a.share) as vat, count(*) as n
           from pm_pay_alloc a join pm_invoice v on v.id = a.ref_id
           where a.kind = 'invoice' and not v.gone group by a.project_code) i on i.project_code = p.code
left join (select a.project_code, sum(v.amount * a.share) as paid, count(*) as n, max(v.post_date) as last_paid
           from pm_pay_alloc a join pm_payment v on v.id = a.ref_id
           where a.kind = 'payment' and not v.gone group by a.project_code) y on y.project_code = p.code;


-- =====================================================================
-- 5. RLS
--   Hoá đơn / thanh toán: cần quyền "Thanh toán – xem". Người có phạm vi gốc
--   (JVC, kế toán) thấy hết; người khác chỉ thấy dòng đã phân bổ vào dự án
--   trong phạm vi của mình — chứng từ chưa phân bổ là việc của kế toán/JVC.
--   Mọi thay đổi đi qua hàm ở trên.
-- =====================================================================

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('pm_pay_import', 'pm_invoice', 'pm_payment', 'pm_pay_alloc')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table pm_pay_import enable row level security;
alter table pm_invoice    enable row level security;
alter table pm_payment    enable row level security;
alter table pm_pay_alloc  enable row level security;

create policy pm_pay_import_read on pm_pay_import
  for select to authenticated using ((select app_can('payment', 'view')));

create policy pm_pay_alloc_read on pm_pay_alloc
  for select to authenticated
  using ((select app_can('payment', 'view'))
         and exists (select 1 from pm_project p where p.code = project_code));

create policy pm_invoice_read on pm_invoice
  for select to authenticated
  using ((select app_can('payment', 'view'))
         and ((select app_scope_root())
              or exists (select 1 from pm_pay_alloc a join pm_project p on p.code = a.project_code
                         where a.kind = 'invoice' and a.ref_id = pm_invoice.id)));

create policy pm_payment_read on pm_payment
  for select to authenticated
  using ((select app_can('payment', 'view'))
         and ((select app_scope_root())
              or exists (select 1 from pm_pay_alloc a join pm_project p on p.code = a.project_code
                         where a.kind = 'payment' and a.ref_id = pm_payment.id)));

do $$
declare t text;
begin
  foreach t in array array['pm_invoice', 'pm_payment', 'pm_pay_alloc'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I '
                   'for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke all on pm_pay_import, pm_invoice, pm_payment, pm_pay_alloc, pm_project_money from anon;
revoke insert, update, delete on pm_pay_import, pm_invoice, pm_payment, pm_pay_alloc from authenticated;
grant select on pm_pay_import, pm_invoice, pm_payment, pm_pay_alloc, pm_project_money to authenticated;

revoke execute on function pm_pay_alloc_cleanup(), pm_codes_in(text), pm_code_project(text),
                           pm_auto_alloc(text, bigint, text),
                           pm_import_pay(text, jsonb, text, date, date),
                           pm_alloc_set(text, bigint, jsonb, text)
  from public, anon;
grant execute on function pm_import_pay(text, jsonb, text, date, date),
                          pm_alloc_set(text, bigint, jsonb, text),
                          pm_codes_in(text)
  to authenticated;
revoke execute on function pm_pay_alloc_cleanup(), pm_code_project(text), pm_auto_alloc(text, bigint, text)
  from authenticated;
-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Bảng hoá đơn/thanh toán có RLS' as "Mục",
       count(*) filter (where rowsecurity)::text || '/' || count(*)::text as "Thực tế",
       '4/4' as "Mong đợi",
       case when count(*) = 4 and bool_and(rowsecurity) then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_tables where schemaname = 'public'
  and  tablename in ('pm_pay_import', 'pm_invoice', 'pm_payment', 'pm_pay_alloc')
union all
select 'Tìm mã: "FFE.ENG.06.2025.01 + FFE.ENG.06.2025.02 - 1904.2024.HĐMB"',
       array_to_string(pm_codes_in('FFE.ENG.06.2025.01 + FFE.ENG.06.2025.02 - Restore - 1904.2024.HĐMB.SFT-SV'), ' | '),
       'FFE.ENG.06.2025.01 | FFE.ENG.06.2025.02',
       case when pm_codes_in('FFE.ENG.06.2025.01 + FFE.ENG.06.2025.02 - Restore - 1904.2024.HĐMB.SFT-SV')
                 = array['FFE.ENG.06.2025.01', 'FFE.ENG.06.2025.02'] then '✔' else '✘ HỎNG' end
union all
select 'Mã bị cắt "FFE.JVC.... Laptop" → không đoán',
       coalesce(array_to_string(pm_codes_in('FFE.JVC.... Laptop Lenovo'), ' | '), ''), '(rỗng)',
       case when cardinality(pm_codes_in('FFE.JVC.... Laptop Lenovo')) = 0 then '✔' else '✘ HỎNG' end
union all
select 'Phân bổ tự động theo quyền', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_import_pay';
