-- =====================================================================
-- 18_pm_budget.sql — QUẢN LÝ DỰ ÁN, GIAI ĐOẠN 2: NGÂN SÁCH + DỰ ÁN
--
-- Chạy SAU 17_auth.sql (dùng app_can / app_scope_orgs của nó — chạy trước sẽ
-- báo lỗi ngay ở phần policy, đó là cố ý).
--
--   pm_budget_year   một dòng mỗi năm: tỷ giá cố định, trần SSP, trạng thái
--   pm_budget_round  mỗi VÒNG NỘP là một bản chụp ("CAPEX 2026 20251031");
--                    đúng một vòng mỗi năm là is_final = danh sách đã duyệt
--                    (sheet "Master Data" của file tổng hợp)
--   pm_budget_line   các dòng của một vòng
--   pm_project       dự án đang/đã thực hiện, khoá theo mã dự án CON
--   pm_vendor        nhà cung cấp — khoá bằng MÃ ĐỐI TƯỢNG của kế toán, để
--                    giai đoạn 5 khớp được với file thu chi ngân hàng
--   pm_vendor_score  điểm chấm thầu (sheet Vendor Data của hồ sơ)
--
-- Pháp nhân KHÔNG lưu: nó suy ra từ mã phòng ban qua cây am_org (phòng khách
-- sạn → SSP, CEN → CP, JVC → JVC). Lưu thêm một bản thì sớm muộn hai bản sẽ
-- nói hai chuyện khác nhau.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_budget_year (
  year        int primary key check (year between 2000 and 2100),
  fx_rate     numeric(12, 2) not null default 26000 check (fx_rate > 0),
  reserve_pct numeric(5, 2)  not null default 3,
  ssp_revenue numeric(18, 0),
  ssp_cap     numeric(18, 0),
  cp_revenue  numeric(18, 0),
  status      text not null default 'draft'
              check (status in ('draft', 'submitted', 'approved', 'closed')),
  note        text,
  updated_at  timestamptz not null default now()
);
comment on column pm_budget_year.fx_rate is
  'VND cho 1 USD, CỐ ĐỊNH cả năm ngân sách — để ngưỡng duyệt tính bằng USD không tự nhảy giữa năm.';
comment on column pm_budget_year.ssp_cap is
  'Trần ngân sách SSP như ghi trong file ("Total CAPEX budget - 3% FF&E Reserve"). Để trống thì = ssp_revenue × reserve_pct. CP và JVC không có trần.';

create table if not exists pm_budget_round (
  id           bigserial primary key,
  year         int  not null references pm_budget_year(year) on update cascade,
  label        text not null,
  round_date   date,
  is_final     boolean not null default false,
  source_file  text,
  source_sheet text,
  line_count   int not null default 0,
  total_value  numeric(18, 2) not null default 0,
  imported_at  timestamptz not null default now(),
  imported_by  text,
  unique (year, label)
);
comment on table pm_budget_round is
  'Một vòng nộp ngân sách. Nạp lại cùng (năm, nhãn) thì THAY dòng của vòng đó, không nhân đôi.';
-- Mỗi năm đúng một danh sách chốt.
create unique index if not exists pm_budget_round_final_uq
  on pm_budget_round (year) where is_final;

create table if not exists pm_budget_line (
  id                   bigserial primary key,
  round_id             bigint not null references pm_budget_round(id) on delete cascade,
  line_no              int  not null,
  project_code         text not null,
  current_code         text,
  category             text,
  -- Mã phòng ban để dạng chữ, KHÔNG ràng buộc vào am_org: file cũ có mã sai
  -- chính tả, và từ chối cả dòng vì một mã sai là mất dữ liệu ngân sách thật.
  -- Màn hình đánh dấu mã không có trong danh mục.
  dept_code            text,
  dept_name            text,
  request_date         date,
  investment_type      text,
  reason               text,
  name                 text,
  estimated_value      numeric(18, 2),
  gm_approved          numeric(18, 2),
  possibility          numeric(4, 1),
  impact               numeric(4, 1),
  assessment           numeric(6, 1),
  risk_level           text,
  start_date           date,
  end_date             date,
  duration_days        int,
  asset_item           text,
  location             text,
  rationale            text,
  tech_standard        text,
  quantity             numeric(18, 3),
  unit_price           numeric(18, 2),
  amount               numeric(18, 2),
  reference            text,
  previous_code        text,
  supplier             text,
  details              text,
  project_category     text,
  area_category        text,
  color_status         text,
  purchasing_in_charge text,
  owner_note           text,
  dept_response        text,
  note                 text,
  -- Phân bổ theo tháng (cột "Expected delivery in month..."). Cột số thay vì
  -- jsonb để cộng dồn theo tháng/quý bằng SQL thẳng.
  m01 numeric(18, 2), m02 numeric(18, 2), m03 numeric(18, 2), m04 numeric(18, 2),
  m05 numeric(18, 2), m06 numeric(18, 2), m07 numeric(18, 2), m08 numeric(18, 2),
  m09 numeric(18, 2), m10 numeric(18, 2), m11 numeric(18, 2), m12 numeric(18, 2),
  unique (round_id, line_no)
);
create index if not exists pm_budget_line_code_idx on pm_budget_line (project_code);
create index if not exists pm_budget_line_dept_idx on pm_budget_line (dept_code);
comment on column pm_budget_line.owner_note is
  'Câu hỏi / nhận xét của chủ đầu tư ở vòng nộp (cột ngay sau phần phân bổ tháng).';
comment on column pm_budget_line.dept_response is
  'Bộ phận trả lời câu hỏi của chủ đầu tư.';

create table if not exists pm_vendor (
  code     text primary key,
  name     text not null,
  tax_code text unique,
  aliases  text,
  note     text,
  active   boolean not null default true
);
comment on column pm_vendor.code is
  'Mã đối tượng của kế toán (cột "Mã đối tượng" trong file thu chi tiền gửi), vd CLS, SHIJI.';
comment on column pm_vendor.aliases is
  'Các cách viết khác đã gặp trong hồ sơ ("STAR QUALITY", "Chất Lượng Sao"...), cách nhau bằng dấu phẩy. Dùng để khớp tên nhà thầu trong hồ sơ về đúng mã.';

create table if not exists pm_project (
  code              text primary key,
  main_code         text not null,
  year              int  not null,
  dept_code         text not null,
  name              text,
  category          text default 'FFE',
  budgeted          boolean not null default true,
  investment_type   text,
  project_type      text,
  procurement_type  text,
  share_pct         numeric(7, 4),
  estimated_value   numeric(18, 2),
  possibility       numeric(4, 1),
  impact            numeric(4, 1),
  assessment        numeric(6, 1),
  risk_level        text,
  risk_category     text,
  project_category  text,
  area_category     text,
  asset_item        text,
  location          text,
  reason            text,
  rationale         text,
  tech_standard     text,
  reference         text,
  previous_code     text,
  proposed_supplier text,
  planned_start     date,
  planned_end       date,
  request_date      date,
  assess_date       date,
  approve_date      date,
  purchase_date     date,
  handover_date     date,
  contract_value    numeric(18, 2),
  contract_volume   numeric(18, 3),
  chosen_vendor     text,
  vendor_code       text references pm_vendor(code) on update cascade on delete set null,
  evaluation        text,
  comment           text,
  status_override   text check (status_override in ('pending', 'in_progress', 'completed', 'cancelled')),
  /* Trạng thái suy từ các mốc ngày, trừ khi có người chốt tay. "Hoàn thành"
     đòi ngày nghiệm thu KHÔNG sớm hơn các mốc trước nó: hồ sơ mẫu hay còn sót
     ngày nghiệm thu của file gốc (15/03/2025 trên một dự án đề xuất 2026), và
     tin mù ngày đó là báo hoàn thành một dự án chưa mua. */
  status text generated always as (
    coalesce(status_override,
      case
        when handover_date is not null
             and handover_date >= coalesce(purchase_date, approve_date, request_date, handover_date)
          then 'completed'
        when purchase_date is not null or approve_date is not null then 'in_progress'
        else 'pending'
      end)) stored,
  source            text not null default 'app' check (source in ('app', 'dossier', 'budget')),
  source_file       text,
  source_modified   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists pm_project_year_idx on pm_project (year);
create index if not exists pm_project_dept_idx on pm_project (dept_code);
create index if not exists pm_project_main_idx on pm_project (main_code);
comment on column pm_project.code is
  'Mã dự án CON (FFE.ENG.19.2026.01). Dự án không chia nhỏ thì bằng mã dự án chính.';
comment on column pm_project.share_pct is
  'Tỷ lệ của dự án con trong dự án chính (1 = toàn bộ). Cột "Completion" trong sheet Capex Data của hồ sơ thực ra là số này, không phải tiến độ.';

create table if not exists pm_vendor_score (
  id           bigserial primary key,
  project_code text not null references pm_project(code) on delete cascade on update cascade,
  vendor_name  text not null,
  check_date   date,
  total_amount numeric(18, 2),
  ability      numeric(7, 3),
  technique    numeric(7, 3),
  finance      numeric(7, 3),
  total_score  numeric(7, 3),
  comment      text,
  chosen       boolean not null default false
);
create index if not exists pm_vendor_score_project_idx on pm_vendor_score (project_code);


-- =====================================================================
-- 2. LUẬT MÃ DỰ ÁN
-- =====================================================================

/* Mã chính và năm suy từ mã con, và luật cứng duy nhất của đề bài: dự án
   NGOÀI ngân sách không bao giờ được dùng lại mã của một dự án TRONG ngân
   sách đã duyệt. SECURITY DEFINER để nhìn thấy mọi dòng ngân sách, kể cả
   dòng nằm ngoài phạm vi của người đang lưu. */
create or replace function pm_project_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.code := upper(trim(new.code));
  new.main_code := coalesce(
    nullif(upper(trim(new.main_code)), ''),
    substring(new.code from '^(.*\.(?:19|20)[0-9]{2})(?:\.[0-9]{1,2})?$'),
    new.code);
  if new.year is null then
    new.year := substring(new.main_code from '\.((?:19|20)[0-9]{2})$')::int;
  end if;
  if new.year is null then
    raise exception 'Mã dự án % không có năm ở cuối (dạng FFE.PHÒNG.SỐ.NĂM).', new.code;
  end if;

  if not new.budgeted and exists (
       select 1
       from   pm_budget_line l
       join   pm_budget_round r on r.id = l.round_id
       where  r.is_final
         and  new.main_code in (upper(trim(l.project_code)), upper(trim(coalesce(l.current_code, ''))))
     ) then
    raise exception 'Mã % đã là một dự án TRONG ngân sách được duyệt — dự án ngoài ngân sách phải dùng mã khác.',
      new.main_code using errcode = '23505';
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists pm_project_rules on pm_project;
create trigger pm_project_rules
  before insert or update on pm_project
  for each row execute function pm_project_rules();


-- =====================================================================
-- 2b. NẠP MỘT VÒNG NGÂN SÁCH — TRONG MỘT GIAO DỊCH
--
-- "Nạp lại thì thay thế" nghĩa là xoá dòng cũ rồi ghi dòng mới. Làm bằng hai
-- request từ trình duyệt thì mạng rớt ở giữa là vòng đó mất sạch dòng cho tới
-- khi có người nạp lại. Trong một hàm, hoặc xong hết, hoặc không đổi gì.
-- =====================================================================

create or replace function pm_import_round(p_round jsonb, p_lines jsonb, p_cap numeric default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    bigint;
  v_year  int  := (p_round ->> 'year')::int;
  v_label text := p_round ->> 'label';
  v_bad   text;
begin
  perform app_require('budget', 'create');
  -- Hàm chạy vượt RLS, nên tự giữ luật phạm vi: ai không có phạm vi gốc chỉ
  -- nạp được dòng của phòng ban mình.
  if not app_scope_root() then
    select string_agg(distinct e ->> 'dept_code', ', ') into v_bad
    from   jsonb_array_elements(p_lines) e
    where  coalesce(e ->> 'dept_code', '') not in (select app_scope_orgs());
    if v_bad is not null then
      raise exception 'Dòng của phòng ban % nằm ngoài phạm vi của bạn.', v_bad using errcode = '42501';
    end if;
  end if;

  -- Trần trong file chỉ được điền vào chỗ còn trống — con số người quản trị
  -- đã sửa tay không bị file ghi đè.
  insert into pm_budget_year (year, ssp_cap) values (v_year, p_cap)
  on conflict (year) do update
    set ssp_cap = coalesce(pm_budget_year.ssp_cap, excluded.ssp_cap);

  select id into v_id from pm_budget_round where year = v_year and label = v_label;
  if v_id is null then
    insert into pm_budget_round (year, label) values (v_year, v_label) returning id into v_id;
  else
    delete from pm_budget_line where round_id = v_id;
  end if;

  update pm_budget_round
     set round_date   = nullif(p_round ->> 'round_date', '')::date,
         source_file  = p_round ->> 'source_file',
         source_sheet = p_round ->> 'source_sheet',
         line_count   = jsonb_array_length(p_lines),
         total_value  = coalesce((select sum((e ->> 'estimated_value')::numeric)
                                  from jsonb_array_elements(p_lines) e), 0),
         imported_at  = now(),
         imported_by  = coalesce(app_claims() ->> 'email', 'sql:' || session_user)
   where id = v_id;

  if coalesce((p_round ->> 'is_final')::boolean, false) then
    update pm_budget_round set is_final = false where year = v_year and is_final and id <> v_id;
    update pm_budget_round set is_final = true  where id = v_id;
  end if;

  -- Dựng từng dòng theo đúng kiểu hàng của bảng: khoá JSON trùng tên cột, cột
  -- thiếu thành null, id lấy số mới, round_id là vòng này. Hàm đặt trong
  -- LATERAL để chạy MỘT lần mỗi dòng — viết (f(x)).* thì Postgres gọi f một lần
  -- cho mỗi cột, và nextval bị tiêu ~60 số cho mỗi dòng.
  insert into pm_budget_line
  select r.*
  from   jsonb_array_elements(p_lines) e
  cross  join lateral jsonb_populate_record(null::pm_budget_line,
           e || jsonb_build_object('id', nextval(pg_get_serial_sequence('pm_budget_line', 'id')),
                                   'round_id', v_id)) r;

  return v_id;
end $$;

/* Điểm chấm thầu của các dự án vừa nạp: xoá của dự án đó rồi ghi lại, cùng
   một giao dịch, cùng lý do như trên. */
create or replace function pm_replace_scores(p_codes text[], p_scores jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  perform app_require('project', 'edit');
  if not app_scope_root() and exists (
       select 1 from pm_project p
       where p.code = any(p_codes) and p.dept_code not in (select app_scope_orgs())) then
    raise exception 'Có dự án nằm ngoài phạm vi của bạn.' using errcode = '42501';
  end if;
  delete from pm_vendor_score where project_code = any(p_codes);
  insert into pm_vendor_score
  select r.*
  from   jsonb_array_elements(p_scores) e
  cross  join lateral jsonb_populate_record(null::pm_vendor_score,
           e || jsonb_build_object('id', nextval(pg_get_serial_sequence('pm_vendor_score', 'id')))) r
  where  e ->> 'project_code' = any(p_codes);
  get diagnostics v_n = row_count;
  return v_n;
end $$;


-- =====================================================================
-- 3. PHẠM VI GỐC
--
-- Dòng ngân sách có thể mang mã phòng ban không có trong am_org (file cũ viết
-- sai). app_scope_orgs() chỉ trả mã có thật, nên những dòng đó sẽ vô hình với
-- MỌI người — kể cả JVC, là người phải sửa chúng. Ai có phạm vi là một gốc
-- của cây (PHCL) thì thấy tất cả.
-- =====================================================================

create or replace function app_scope_root()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or exists (select 1
                 from   app_user_role ur
                 join   app_user u on u.id = ur.user_id
                 join   am_org o   on o.code = ur.scope_org
                 where  u.id = auth.uid() and u.active and o.parent_code is null)
$$;


-- =====================================================================
-- 4. RLS
-- =====================================================================

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename like 'pm\_%'
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table pm_budget_year  enable row level security;
alter table pm_budget_round enable row level security;
alter table pm_budget_line  enable row level security;
alter table pm_project      enable row level security;
alter table pm_vendor       enable row level security;
alter table pm_vendor_score enable row level security;

-- Năm ngân sách: ai cũng đọc (tỷ giá dùng khắp nơi). TẠO năm mới đi kèm việc
-- nạp file ngân sách, nên chỉ cần quyền tạo; còn SỬA tỷ giá, trần, trạng thái
-- — những con số cả năm dựa vào — thì cần quyền quản trị ngân sách.
create policy pm_budget_year_read on pm_budget_year
  for select to authenticated using ((select app_is_member()));
create policy pm_budget_year_add on pm_budget_year
  for insert to authenticated with check ((select app_can('budget', 'create')));
create policy pm_budget_year_edit on pm_budget_year
  for update to authenticated
  using ((select app_can('budget', 'admin'))) with check ((select app_can('budget', 'admin')));
create policy pm_budget_year_del on pm_budget_year
  for delete to authenticated using ((select app_can('budget', 'admin')));

-- Vòng nộp: nạp (tạo) cần quyền tạo ngân sách; xoá cả vòng cần quyền quản trị.
create policy pm_budget_round_read on pm_budget_round
  for select to authenticated using ((select app_can('budget', 'view')));
create policy pm_budget_round_add on pm_budget_round
  for insert to authenticated with check ((select app_can('budget', 'create')));
create policy pm_budget_round_edit on pm_budget_round
  for update to authenticated
  using ((select app_can('budget', 'create'))) with check ((select app_can('budget', 'create')));
create policy pm_budget_round_del on pm_budget_round
  for delete to authenticated using ((select app_can('budget', 'admin')));

-- Dòng ngân sách: theo phạm vi phòng ban. Nạp lại một vòng = xoá dòng cũ của
-- vòng đó rồi thêm lại, nên quyền tạo đi kèm quyền xoá dòng.
create policy pm_budget_line_read on pm_budget_line
  for select to authenticated
  using ((select app_can('budget', 'view'))
         and ((select app_scope_root()) or dept_code in (select app_scope_orgs())));
create policy pm_budget_line_add on pm_budget_line
  for insert to authenticated
  with check ((select app_can('budget', 'create'))
              and ((select app_scope_root()) or dept_code in (select app_scope_orgs())));
create policy pm_budget_line_edit on pm_budget_line
  for update to authenticated
  using      ((select app_can('budget', 'edit'))
              and ((select app_scope_root()) or dept_code in (select app_scope_orgs())))
  with check ((select app_can('budget', 'edit'))
              and ((select app_scope_root()) or dept_code in (select app_scope_orgs())));
create policy pm_budget_line_del on pm_budget_line
  for delete to authenticated
  using ((select app_can('budget', 'create'))
         and ((select app_scope_root()) or dept_code in (select app_scope_orgs())));

-- Dự án: theo quyền và phạm vi.
create policy pm_project_read on pm_project
  for select to authenticated
  using ((select app_can('project', 'view'))
         and ((select app_scope_root()) or dept_code in (select app_scope_orgs())));
create policy pm_project_add on pm_project
  for insert to authenticated
  with check ((select app_can('project', 'create'))
              and ((select app_scope_root()) or dept_code in (select app_scope_orgs())));
create policy pm_project_edit on pm_project
  for update to authenticated
  using      ((select app_can('project', 'edit'))
              and ((select app_scope_root()) or dept_code in (select app_scope_orgs())))
  with check ((select app_can('project', 'edit'))
              and ((select app_scope_root()) or dept_code in (select app_scope_orgs())));
create policy pm_project_del on pm_project
  for delete to authenticated using ((select app_can('project', 'admin')));

-- Nhà cung cấp: danh mục dùng chung.
create policy pm_vendor_read on pm_vendor
  for select to authenticated using ((select app_is_member()));
create policy pm_vendor_write on pm_vendor
  for all to authenticated
  using ((select app_can('project', 'edit'))) with check ((select app_can('project', 'edit')));

-- Điểm chấm thầu: thấy được khi thấy được dự án.
create policy pm_vendor_score_read on pm_vendor_score
  for select to authenticated
  using ((select app_can('project', 'view'))
         and exists (select 1 from pm_project p where p.code = project_code));
create policy pm_vendor_score_write on pm_vendor_score
  for all to authenticated
  using ((select app_can('project', 'edit'))) with check ((select app_can('project', 'edit')));


-- =====================================================================
-- 5. NHẬT KÝ THAY ĐỔI (cùng trigger của 17_auth.sql)
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array['pm_budget_year', 'pm_budget_round', 'pm_budget_line',
                           'pm_project', 'pm_vendor', 'pm_vendor_score'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I '
                   'for each row execute function app_audit_row()', t);
  end loop;
end $$;


-- =====================================================================
-- 6. QUYỀN
-- =====================================================================

revoke all on pm_budget_year, pm_budget_round, pm_budget_line,
              pm_project, pm_vendor, pm_vendor_score from anon;
grant select, insert, update, delete on pm_budget_year, pm_budget_round, pm_budget_line,
                                        pm_project, pm_vendor, pm_vendor_score to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke execute on function pm_project_rules() from public, anon;
revoke execute on function app_scope_root()   from public, anon;
grant  execute on function app_scope_root()   to authenticated;
revoke execute on function pm_import_round(jsonb, jsonb, numeric) from public, anon;
grant  execute on function pm_import_round(jsonb, jsonb, numeric) to authenticated;
revoke execute on function pm_replace_scores(text[], jsonb)       from public, anon;
grant  execute on function pm_replace_scores(text[], jsonb)       to authenticated;
-- Lưới an toàn: default privileges của project (dùng chung với app khác) tự cấp
-- quyền cho anon trên mọi bảng/sequence/hàm mới — tước lại cho đồ của app này.
select app_lock_anon();


-- =====================================================================
-- 7. KIỂM CHỨNG
-- =====================================================================

select 'Bảng pm_* có RLS' as "Mục",
       count(*) filter (where rowsecurity)::text || '/' || count(*)::text as "Thực tế",
       '6/6' as "Mong đợi",
       case when count(*) = 6 and bool_and(rowsecurity) then '✔' else '✘ HỎNG' end as "Đạt"
-- Đúng 6 bảng của file này — 19_pm_workflow.sql thêm 5 bảng pm_* nữa, nên
-- đếm theo tên chứ không theo tiền tố.
from   pg_tables where schemaname = 'public'
  and  tablename in ('pm_budget_year', 'pm_budget_round', 'pm_budget_line',
                     'pm_project', 'pm_vendor', 'pm_vendor_score')
union all
select 'Policy pm_* mở cho anon (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'public' and tablename like 'pm\_%' and 'anon' = any (roles)
union all
select 'Trigger luật mã dự án', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_trigger where tgname = 'pm_project_rules' and not tgisinternal;
