-- =====================================================================
-- 17_auth.sql — ĐĂNG NHẬP, VAI TRÒ, MA TRẬN QUYỀN, NHẬT KÝ THAY ĐỔI
--
-- Từ file này trở đi app BẮT BUỘC ĐĂNG NHẬP (Supabase Auth, email + mật khẩu).
-- Người chưa đăng nhập (vai `anon`) không đọc, không ghi, không gọi được gì.
--
-- Mô hình:
--   app_user       một dòng cho mỗi tài khoản Auth (tự tạo bằng trigger)
--   app_role       14 vai trò cố định theo pháp nhân SSP / CP / JVC / SYS
--   app_user_role  người × vai trò × PHẠM VI (một nút trong am_org). Một người
--                  giữ được nhiều vai trò, mỗi vai trò một phạm vi riêng.
--   app_module     các khu chức năng của app
--   app_permission vai trò × khu chức năng × 5 quyền, SỬA ĐƯỢC TRONG APP
--   app_audit      mọi thay đổi dữ liệu: ai, lúc nào, bảng nào, trước/sau
--
-- Phạm vi: người dùng thấy các phòng ban nằm DƯỚI nút phạm vi của mình trong
-- cây am_org. Cây giữ nguyên theo cấu trúc pháp lý (PHCL → CP / JVC / SOF);
-- việc JVC quản lý SOF và CP thể hiện bằng phạm vi (vai trò JVC → PHCL),
-- không phải bằng cách dời nút trong cây.
--
-- Kết nối trực tiếp vào database (SQL Editor, migration) luôn được tin cậy —
-- muốn vào đó phải có mật khẩu database. Đó cũng là đường thoát nếu lỡ khoá
-- hết mọi người: không bao giờ có chuyện bị nhốt ngoài dữ liệu của chính mình.
--
-- ⚠ TRIỂN KHAI — đúng thứ tự, không thì app đứng:
--   1. Supabase → Authentication → Users → Add user → Create new user:
--      email công ty + mật khẩu, TICK "Auto Confirm User". Làm cho chính mình
--      trước.
--   2. Chạy file này (và các file 03, 04, 05, 07, 13, 14, 15, 16 đã sửa — hoặc
--      chạy một file gộp MIGRATE_17.sql là đủ).
--   3. Chạy:  select app_bootstrap_admin('email-cua-ban@jvcplaza.vn');
--      → tài khoản đó thành System Admin + AM Coordinator, phạm vi PHCL.
--   4. Commit + push bản app có màn hình đăng nhập. Bản app CŨ (dùng anon key)
--      sẽ không đọc được gì nữa sau bước 2 — nên bước 2 và 4 làm liền nhau.
--   5. Authentication → Sign In / Providers: TẮT "Allow new users to sign up".
--      Tài khoản chỉ do quản trị tạo ở bước 1.
--   6. Authentication → URL Configuration → Site URL:
--      https://rachel-huynh.github.io/PHCL/AssetManagement.html
--      (để link "quên mật khẩu" trong email quay về đúng app).
--
-- Chạy lại nhiều lần vô hại. Ma trận quyền đã sửa trong app KHÔNG bị ghi đè.
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists app_module (
  code     text primary key,
  name_en  text not null,
  name_vi  text not null,
  sort     int  not null default 0
);
comment on table app_module is
  'Khu chức năng của app. Ma trận quyền là vai trò × khu chức năng.';

create table if not exists app_role (
  code          text primary key,
  entity        text not null check (entity in ('SSP', 'CP', 'JVC', 'SYS')),
  name_en       text not null,
  name_vi       text not null,
  prepares      boolean not null default false,
  default_scope text references am_org(code) on update cascade,
  sort          int  not null default 0
);
comment on column app_role.prepares is
  'Vai trò LẬP chứng từ. Người lập không bao giờ tự duyệt chứng từ của chính mình.';
comment on column app_role.default_scope is
  'Phạm vi gợi ý khi gán vai trò. Để trống = phải chọn phòng ban cụ thể (vd nhân viên / trưởng bộ phận).';

create table if not exists app_permission (
  role_code   text not null references app_role(code)   on delete cascade on update cascade,
  module_code text not null references app_module(code) on delete cascade on update cascade,
  can_view    boolean not null default false,
  can_create  boolean not null default false,
  can_edit    boolean not null default false,
  can_approve boolean not null default false,
  can_admin   boolean not null default false,
  primary key (role_code, module_code)
);

create table if not exists app_user (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  full_name  text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table app_user is
  'Một dòng cho mỗi tài khoản Supabase Auth, tạo tự động. active = false là khoá tài khoản mà không xoá lịch sử của người đó.';

create table if not exists app_user_role (
  user_id   uuid not null references app_user(id) on delete cascade,
  role_code text not null references app_role(code) on update cascade,
  scope_org text not null references am_org(code) on update cascade,
  primary key (user_id, role_code, scope_org)
);
comment on column app_user_role.scope_org is
  'Người này thấy mọi phòng ban nằm dưới nút này trong cây am_org (tính cả chính nút đó).';

create table if not exists app_audit (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  user_id  uuid,
  email    text,
  tbl      text not null,
  op       text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  pk       text,
  old_data jsonb,
  new_data jsonb
);
comment on table app_audit is
  'Nhật ký thay đổi. UPDATE chỉ lưu các cột thực sự đổi (old_data/new_data cùng tập khoá). email bắt đầu bằng "sql:" = thay đổi chạy thẳng từ SQL Editor.';
create index if not exists app_audit_at_idx  on app_audit (at desc);
create index if not exists app_audit_tbl_idx on app_audit (tbl, at desc);


-- =====================================================================
-- 2. DỮ LIỆU GỐC
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('assets',   'Assets',                'Tài sản',                  10),
  ('master',   'Master data',           'Danh mục',                 20),
  ('system',   'System',                'Hệ thống',                 30),
  ('security', 'Users & permissions',   'Người dùng & phân quyền',  40),
  -- Các khu của module Quản lý dự án (giai đoạn 2–5). Có sẵn từ bây giờ để
  -- ma trận quyền cấu hình trước được.
  ('budget',   'Budget',                'Ngân sách',                50),
  ('project',  'Projects',              'Dự án',                    60),
  ('approval', 'Approvals',             'Phê duyệt',                70),
  ('payment',  'Payments',              'Thanh toán',               80),
  ('report',   'Reports',               'Báo cáo',                  90)
on conflict (code) do update
  set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('DEPT_STAFF', 'SSP', 'Dept Staff',              'Nhân viên bộ phận',           true,  null,   10),
  ('DEPT_HEAD',  'SSP', 'Dept Head',               'Trưởng bộ phận',              false, null,   20),
  ('DOF',        'SSP', 'Director of Finance',     'Trưởng bộ phận tài chính',    false, 'SOF',  30),
  ('HOTEL_GM',   'SSP', 'Hotel GM',                'GM khách sạn',                false, 'SOF',  40),
  ('PURCHASING', 'SSP', 'Purchasing',              'Thu mua',                     true,  'SOF',  50),
  ('CP_ADMIN',   'CP',  'Office Building Admin',   'Admin cao ốc văn phòng',      true,  'CP',   60),
  ('CP_MAINT',   'CP',  'Maintenance Manager',     'Quản lý bảo trì',             false, 'CP',   70),
  ('CP_HEAD',    'CP',  'Head of Office Building', 'Trưởng cao ốc văn phòng',     false, 'CP',   80),
  ('JVC_ADMIN',  'JVC', 'JVC Admin',               'Admin văn phòng JVC',         true,  'PHCL', 90),
  ('AM_COORD',   'JVC', 'AM Coordinator',          'Điều phối quản lý tài sản',   true,  'PHCL', 100),
  ('AM_EXEC',    'JVC', 'AM Executive',            'Chuyên viên quản lý tài sản', false, 'PHCL', 110),
  ('CHIEF_ACC',  'JVC', 'Chief Accountant',        'Kế toán trưởng',              false, 'PHCL', 120),
  ('JVC_GM',     'JVC', 'JVC GM',                  'GM văn phòng JVC',            false, 'PHCL', 130),
  ('SYS_ADMIN',  'SYS', 'System Admin',            'Quản trị hệ thống',           false, 'PHCL', 900)
on conflict (code) do update
  set entity = excluded.entity, name_en = excluded.name_en, name_vi = excluded.name_vi,
      prepares = excluded.prepares, default_scope = excluded.default_scope, sort = excluded.sort;

/* Ma trận quyền MẶC ĐỊNH. Mỗi chữ là một quyền:
     V xem · C tạo · E sửa · A duyệt · M quản trị (thao tác phá huỷ: xoá hàng
     loạt, đặt lại bộ đếm, sửa quyền...)
   "on conflict do nothing": chạy lại file này KHÔNG ghi đè những gì quản trị
   đã chỉnh trong app. Chỉ thêm ô còn thiếu. */
with grp(role_code, g) as (values
  ('DEPT_STAFF','prep'), ('PURCHASING','prep'), ('CP_ADMIN','prep'), ('JVC_ADMIN','prep'),
  ('DEPT_HEAD','appr'),  ('DOF','appr'),        ('HOTEL_GM','appr'),
  ('CP_MAINT','appr'),   ('CP_HEAD','appr'),    ('CHIEF_ACC','appr'), ('JVC_GM','appr'),
  ('AM_COORD','am'),     ('AM_EXEC','amx')
),
def(g, module_code, f) as (values
  -- Người lập đề xuất
  ('prep','assets','V'),   ('prep','master','V'),   ('prep','budget','VCE'),
  ('prep','project','VCE'),('prep','approval','V'), ('prep','payment','V'),  ('prep','report','V'),
  -- Người duyệt
  ('appr','assets','V'),   ('appr','master','V'),   ('appr','budget','VA'),
  ('appr','project','VA'), ('appr','approval','VA'),('appr','payment','V'),  ('appr','report','V'),
  -- AM Coordinator: vận hành sổ tài sản hằng ngày, lập PA/MC, là bước duyệt
  -- đầu tiên phía JVC, nạp file kế toán
  ('am','assets','VCEM'),  ('am','master','VCE'),   ('am','system','VCE'),
  ('am','budget','VCEA'),  ('am','project','VCEA'), ('am','approval','VA'),
  ('am','payment','VCE'),  ('am','report','V'),
  -- AM Executive: đánh giá và duyệt, sửa được sổ tài sản
  ('amx','assets','VCE'),  ('amx','master','VCE'),  ('amx','system','V'),
  ('amx','budget','VA'),   ('amx','project','VA'),  ('amx','approval','VA'),
  ('amx','payment','V'),   ('amx','report','V')
)
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select grp.role_code, def.module_code,
       def.f like '%V%', def.f like '%C%', def.f like '%E%', def.f like '%A%', def.f like '%M%'
from   grp join def using (g)
on conflict (role_code, module_code) do nothing;

-- System Admin: mọi quyền trên mọi khu.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'SYS_ADMIN', m.code, true, true, true, true, true from app_module m
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 3. HÀM KIỂM TRA QUYỀN
-- =====================================================================

-- Claims của JWT trong request hiện tại; {} khi không có (SQL Editor).
-- nullif vì biến có thể là chuỗi rỗng, mà ''::jsonb là lỗi.
create or replace function app_claims()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

/* Được tin cậy tuyệt đối khi:
     * kết nối thẳng vào database (SQL Editor, migration): mọi request qua
       API đều đăng nhập bằng vai `authenticator`, nên session_user khác nó
       nghĩa là có người cầm mật khẩu database;
     * hoặc request mang service key (chỉ dùng phía server, không bao giờ ở
       trình duyệt).
   session_user KHÔNG đổi bên trong hàm SECURITY DEFINER — current_user mới
   đổi — nên kiểm tra này đúng ở mọi chỗ gọi. */
create or replace function app_trusted()
returns boolean
language sql
stable
as $$
  select session_user <> 'authenticator'
      or app_claims() ->> 'role' = 'service_role'
$$;

-- Tài khoản đang hoạt động và có ít nhất một vai trò.
create or replace function app_is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or exists (select 1
                 from   app_user u
                 join   app_user_role ur on ur.user_id = u.id
                 where  u.id = auth.uid() and u.active)
$$;

-- Có quyền p_action trên khu p_module qua BẤT KỲ vai trò nào không.
create or replace function app_can(p_module text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted()
      or exists (
           select 1
           from   app_user u
           join   app_user_role ur on ur.user_id = u.id
           join   app_permission p on p.role_code = ur.role_code
                                  and p.module_code = p_module
           where  u.id = auth.uid()
             and  u.active
             and  case p_action
                    when 'view'    then p.can_view
                    when 'create'  then p.can_create
                    when 'edit'    then p.can_edit
                    when 'approve' then p.can_approve
                    when 'admin'   then p.can_admin
                    else false
                  end)
$$;

-- Dòng đầu tiên của mọi hàm SECURITY DEFINER có ghi dữ liệu.
create or replace function app_require(p_module text, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app_can(p_module, p_action) then
    raise exception 'Không có quyền "%" trên "%". / Permission "%" on "%" is required.',
      p_action, p_module, p_action, p_module
      using errcode = '42501';
  end if;
end $$;

/* Mọi mã phòng ban/đơn vị nằm trong phạm vi của người dùng: các nút phạm vi
   của mọi vai trò, cộng toàn bộ con cháu của chúng trong am_org. */
create or replace function app_scope_orgs()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  with recursive s(code) as (
    select o.code from am_org o where app_trusted()
    union
    select ur.scope_org
    from   app_user_role ur
    join   app_user u on u.id = ur.user_id
    where  u.id = auth.uid() and u.active
    union
    select o.code from am_org o join s on o.parent_code = s.code
  )
  select code from s
$$;

/* Lọc một danh sách id tài sản về những dòng nằm trong phạm vi. Các hàm
   SECURITY DEFINER (sửa/xoá hàng loạt, hoàn tác) chạy vượt RLS, nên phải tự
   lọc — nếu không, người có quyền sửa ở phòng KIT sẽ sửa được tài sản của
   phòng khác chỉ bằng cách gửi id của nó. */
create or replace function app_scope_ids(p_ids bigint[])
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(a.id), '{}'::bigint[])
  from   am_asset a
  where  a.id = any(p_ids)
    and  a.dept_code in (select app_scope_orgs())
$$;

-- Mọi thứ app cần biết về người đang đăng nhập, trong một lần gọi.
create or replace function app_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id',        u.id,
    'email',     u.email,
    'full_name', u.full_name,
    'active',    u.active,
    'roles', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'role', ur.role_code, 'scope', ur.scope_org,
                 'name_en', r.name_en, 'name_vi', r.name_vi, 'entity', r.entity)
               order by r.sort, ur.scope_org)
        from   app_user_role ur join app_role r on r.code = ur.role_code
        where  ur.user_id = u.id), '[]'::jsonb),
    'perms', coalesce((
        select jsonb_object_agg(x.module_code, x.a)
        from (select p.module_code,
                     jsonb_build_object(
                       'view',    bool_or(p.can_view),
                       'create',  bool_or(p.can_create),
                       'edit',    bool_or(p.can_edit),
                       'approve', bool_or(p.can_approve),
                       'admin',   bool_or(p.can_admin)) as a
              from   app_user_role ur
              join   app_permission p on p.role_code = ur.role_code
              where  ur.user_id = u.id and u.active
              group  by p.module_code) x), '{}'::jsonb))
  from app_user u
  where u.id = auth.uid()
$$;

/* Cấp quyền quản trị cho TÀI KHOẢN ĐẦU TIÊN. Chỉ chạy được từ SQL Editor —
   không ai gọi được qua API, kể cả người đã đăng nhập. */
create or replace function app_bootstrap_admin(p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if session_user = 'authenticator' then
    raise exception 'Chỉ chạy được từ SQL Editor của Supabase.' using errcode = '42501';
  end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'Chưa có tài khoản %. Tạo trước ở Authentication → Users → Add user (tick Auto Confirm User).', p_email;
  end if;

  insert into app_user (id, email, full_name)
  values (v_id, lower(trim(p_email)), split_part(lower(trim(p_email)), '@', 1))
  on conflict (id) do update set active = true;

  insert into app_user_role (user_id, role_code, scope_org) values
    (v_id, 'SYS_ADMIN', 'PHCL'),
    (v_id, 'AM_COORD',  'PHCL')
  on conflict do nothing;

  return 'OK: ' || lower(trim(p_email)) || ' = System Admin + AM Coordinator, phạm vi PHCL';
end $$;


-- =====================================================================
-- 4. TÀI KHOẢN AUTH → app_user
-- =====================================================================

create or replace function app_on_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Không có email (vd đăng nhập bằng số điện thoại) thì bỏ qua: nếu để lệnh
  -- insert dưới đây lỗi thì chính việc TẠO TÀI KHOẢN trong Auth cũng hỏng theo.
  if new.email is null then
    return new;
  end if;
  insert into app_user (id, email, full_name)
  values (new.id, lower(new.email),
          coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''),
                   split_part(lower(new.email), '@', 1)))
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists app_on_auth_user on auth.users;
create trigger app_on_auth_user
  after insert or update of email on auth.users
  for each row execute function app_on_auth_user();

-- Tài khoản đã tạo TRƯỚC khi có trigger.
insert into app_user (id, email, full_name)
select id, lower(email), split_part(lower(email), '@', 1)
from   auth.users
where  email is not null
on conflict (id) do nothing;


-- =====================================================================
-- 5. NHẬT KÝ THAY ĐỔI
-- =====================================================================

create or replace function app_audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  o jsonb;
  n jsonb;
  r jsonb;
begin
  if tg_op = 'INSERT' then
    n := to_jsonb(new);
    r := n;
  elsif tg_op = 'DELETE' then
    o := to_jsonb(old);
    r := o;
  else
    r := to_jsonb(new);
    o := to_jsonb(old);
    -- Chỉ giữ các cột thực sự đổi. Một lần nạp lại sổ cũ đụng 16.000 dòng mà
    -- phần lớn không đổi gì — những dòng đó không để lại dấu vết nào.
    select jsonb_object_agg(e.key, e.value) into n
    from   jsonb_each(r) e
    where  o -> e.key is distinct from e.value;
    if n is null then
      return null;
    end if;
    select jsonb_object_agg(k, o -> k) into o from jsonb_object_keys(n) k;
  end if;

  insert into app_audit (user_id, email, tbl, op, pk, old_data, new_data)
  values (auth.uid(),
          coalesce(app_claims() ->> 'email',
                   case when app_trusted() then 'sql:' || session_user end),
          tg_table_name,
          tg_op,
          coalesce(r ->> 'id', r ->> 'code', r ->> 'iso2', r ->> 'alias_norm',
                   r ->> 'raw_norm', r ->> 'alias', r ->> 'key',
                   nullif(concat_ws('|', r ->> 'dept_code', r ->> 'letters', r ->> 'kind',
                                         r ->> 'user_id', r ->> 'role_code',
                                         r ->> 'module_code', r ->> 'scope_org'), '')),
          o, n);
  return null;
end $$;

/* Bảng bộ đếm KHÔNG gắn: mỗi lần cấp số đã ghi vào am_counter_log rồi, gắn
   thêm chỉ nhân đôi. am_data_source cũng vậy — bản thân nó đã là nhật ký. */
do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_shipment','am_shipment_line','am_asset','am_alr','am_alr_line',
    'am_xls_template','am_xls_column',
    'app_module','app_role','app_permission','app_user','app_user_role'
  ] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I '
                   'for each row execute function app_audit_row()', t);
  end loop;
end $$;


-- =====================================================================
-- 6. RLS — XOÁ SẠCH POLICY CŨ, DỰNG LẠI TỪ ĐẦU
--
-- Xoá TẤT CẢ policy hiện có trên bảng am_* / app_* thay vì xoá theo tên:
-- chỉ cần sót một policy "for all to anon using (true)" của bản cũ là cả hệ
-- thống mở, vì các policy được OR với nhau.
--
-- Lệnh gọi hàm được bọc trong (select ...) để Postgres tính MỘT lần cho cả
-- câu truy vấn, không phải một lần cho mỗi dòng trong 16.000 dòng.
-- =====================================================================

do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname
    from   pg_policies
    where  schemaname = 'public'
      -- KHÔNG dùng 'app_%': Legal Portal cùng project có bảng app_settings.
      and  (tablename like 'am\_%'
            or tablename in ('app_module', 'app_role', 'app_permission', 'app_user',
                             'app_user_role', 'app_audit'))
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

do $$
declare t text;
begin
  -- Bật RLS trên mọi bảng của app (04 đã bật cho am_*; đây là lưới an toàn).
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_asset_seq','am_barcode_seq','am_counter_log','am_shipment',
    'am_shipment_line','am_asset','am_alr','am_alr_line','am_alr_seq',
    'am_xls_template','am_xls_column','am_data_source',
    'app_module','app_role','app_permission','app_user','app_user_role','app_audit'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;

  -- Danh mục: mọi thành viên đọc được (form nào cũng cần), sửa cần quyền master.
  foreach t in array array[
    'am_org','am_org_alias','am_category_group','am_category','am_unit',
    'am_origin','am_origin_alias','am_origin_rejected','am_location','am_product'
  ] loop
    execute format('create policy %I on %I for select to authenticated using ((select app_is_member()))',
                   t || '_read', t);
    execute format('create policy %I on %I for all to authenticated '
                   'using ((select app_can(''master'', ''edit''))) '
                   'with check ((select app_can(''master'', ''edit'')))',
                   t || '_write', t);
  end loop;

  -- Cấu hình hệ thống: đọc được, sửa cần quyền system.
  foreach t in array array['am_setting','am_xls_template','am_xls_column'] loop
    execute format('create policy %I on %I for select to authenticated using ((select app_is_member()))',
                   t || '_read', t);
    execute format('create policy %I on %I for all to authenticated '
                   'using ((select app_can(''system'', ''edit''))) '
                   'with check ((select app_can(''system'', ''edit'')))',
                   t || '_write', t);
  end loop;

  -- Bộ đếm: chỉ đọc. Ghi chỉ qua hàm SECURITY DEFINER.
  foreach t in array array['am_asset_seq','am_barcode_seq','am_counter_log','am_alr_seq'] loop
    execute format('create policy %I on %I for select to authenticated '
                   'using ((select app_can(''assets'', ''view'')))',
                   t || '_read', t);
  end loop;

  -- Vai trò, khu chức năng, ma trận quyền: ai cũng đọc được (app cần để vẽ
  -- menu), chỉ quản trị sửa.
  foreach t in array array['app_module','app_role','app_permission'] loop
    execute format('create policy %I on %I for select to authenticated using ((select app_is_member()))',
                   t || '_read', t);
    execute format('create policy %I on %I for all to authenticated '
                   'using ((select app_can(''security'', ''admin''))) '
                   'with check ((select app_can(''security'', ''admin'')))',
                   t || '_write', t);
  end loop;
end $$;

-- Nguồn dữ liệu: nhật ký chỉ-thêm của các lần nạp master data.
create policy am_data_source_read on am_data_source
  for select to authenticated using ((select app_is_member()));
create policy am_data_source_add on am_data_source
  for insert to authenticated
  with check ((select app_can('master', 'edit')) or (select app_can('system', 'edit')));

-- Sổ tài sản: theo quyền VÀ theo phạm vi phòng ban. Không có policy DELETE —
-- xoá chỉ qua am_undo_intake / am_bulk_delete.
create policy am_asset_read on am_asset
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and dept_code in (select app_scope_orgs()));
create policy am_asset_add on am_asset
  for insert to authenticated
  with check ((select app_can('assets', 'create'))
              and dept_code in (select app_scope_orgs()));
create policy am_asset_edit on am_asset
  for update to authenticated
  using      ((select app_can('assets', 'edit')) and dept_code in (select app_scope_orgs()))
  with check ((select app_can('assets', 'edit')) and dept_code in (select app_scope_orgs()));

-- Đợt giao hàng và biên bản tem nhãn: phòng ban để trống = đợt nhiều phòng,
-- ai có quyền xem tài sản đều thấy.
create policy am_shipment_read on am_shipment
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and (dept_code is null or dept_code in (select app_scope_orgs())));
create policy am_shipment_write on am_shipment
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

create policy am_shipment_line_read on am_shipment_line
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and exists (select 1 from am_shipment s where s.id = shipment_id));
create policy am_shipment_line_write on am_shipment_line
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

create policy am_alr_read on am_alr
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and (dept_code is null or dept_code in (select app_scope_orgs())));
create policy am_alr_write on am_alr
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

create policy am_alr_line_read on am_alr_line
  for select to authenticated
  using ((select app_can('assets', 'view'))
         and exists (select 1 from am_alr a where a.id = alr_id));
create policy am_alr_line_write on am_alr_line
  for all to authenticated
  using ((select app_can('assets', 'create'))) with check ((select app_can('assets', 'create')));

-- Người dùng: mỗi người thấy chính mình; quản trị thấy và sửa tất cả.
create policy app_user_read on app_user
  for select to authenticated
  using (id = auth.uid() or (select app_can('security', 'view')));
create policy app_user_write on app_user
  for all to authenticated
  using ((select app_can('security', 'admin'))) with check ((select app_can('security', 'admin')));

create policy app_user_role_read on app_user_role
  for select to authenticated
  using (user_id = auth.uid() or (select app_can('security', 'view')));
create policy app_user_role_write on app_user_role
  for all to authenticated
  using ((select app_can('security', 'admin'))) with check ((select app_can('security', 'admin')));

-- Nhật ký: chỉ đọc, chỉ người có quyền xem khu phân quyền. Trigger ghi vào
-- bằng quyền của chủ sở hữu nên không cần policy INSERT.
create policy app_audit_read on app_audit
  for select to authenticated using ((select app_can('security', 'view')));


-- =====================================================================
-- 7. VIEW CHẠY BẰNG QUYỀN NGƯỜI GỌI
--
-- Mặc định view chạy bằng quyền CHỦ SỞ HỮU (postgres) và bỏ qua RLS — tức là
-- mọi policy ở trên sẽ vô nghĩa với ai đọc qua view. Các file 05, 07, 13 cũng
-- đã khai báo sẵn tuỳ chọn này, để chạy lại chúng không xoá mất nó.
-- =====================================================================

alter view am_alr_print           set (security_invoker = true);
alter view am_data_source_current set (security_invoker = true);
alter view am_product_term        set (security_invoker = true);


-- =====================================================================
-- 8. QUYỀN CẤP CHO VAI TRÒ DATABASE
-- =====================================================================

/* ⚠ Project Supabase này DÙNG CHUNG với app khác (Công đoàn cd_*, Budget
   Tracker bt_*, SSP Dashboard dashboard_store, Legal Portal, Đối chiếu hoá đơn
   hd_*). Vài app trong số đó KHÔNG có đăng nhập và sống nhờ quyền của anon.
   Vì vậy mọi lệnh ở đây chỉ đụng vào đồ của app này — tên bắt đầu bằng am_ /
   pm_ / app_ (và riêng 6 bảng app_* bên dưới) — KHÔNG BAO GIỜ "all tables in
   schema public", và không đổi default privileges của cả schema.

   app_lock_anon(): tước mọi quyền của anon (và PUBLIC trên hàm) khỏi đồ của app
   này. Gọi ở cuối 17, 18, 19 và mọi file sau, vì default privileges của
   project vẫn tự cấp quyền cho anon trên bảng/hàm mới tạo. */
create or replace function app_lock_anon()
returns void
language plpgsql
set search_path = public
as $$
declare r record;
begin
  for r in
    select c.oid::regclass::text as n, c.relkind
    from   pg_class c join pg_namespace s on s.oid = c.relnamespace
    where  s.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
      and  (c.relname ~ '^(am|pm)_'
            or c.relname in ('app_module', 'app_role', 'app_permission', 'app_user',
                             'app_user_role', 'app_audit'))
  loop
    execute format(case when r.relkind = 'S' then 'revoke all on sequence %s from anon'
                        else 'revoke all on table %s from anon' end, r.n);
  end loop;
  for r in
    select p.oid::regprocedure::text as n
    from   pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where  s.nspname = 'public' and p.proname ~ '^(am|app|pm)_'
      and  p.proowner = (select oid from pg_roles where rolname = current_user)
  loop
    execute format('revoke execute on function %s from public, anon', r.n);
  end loop;
end $$;
revoke execute on function app_lock_anon() from public, anon;

-- authenticated: gọi được hàm của app (hàm nào ghi dữ liệu thì tự kiểm tra vai
-- trò), dùng được bảng (RLS lọc dòng). Cấp TRƯỚC khi tước của PUBLIC.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure::text as n
    from   pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where  s.nspname = 'public' and p.proname ~ '^(am|app|pm)_'
      and  p.proowner = (select oid from pg_roles where rolname = current_user)
      -- Hàm nội bộ mà 19 / 20 / 21 cố ý không cho gọi qua API — chạy lại
      -- file này sau các file đó không được mở lại chúng.
      and  p.proname not in ('pm_doc_log', 'pm_doc_apply', 'app_user_role_covers',
                             'pm_sig_check', 'pm_notify_trg', 'pm_step_pass', 'pm_pair_state',
                             'pm_pay_alloc_cleanup', 'pm_code_project', 'pm_auto_alloc', 'pm_pkg_log', 'pm_user_name',
                             'app_bootstrap_admin', 'app_lock_anon')
  loop
    execute format('grant execute on function %s to authenticated', r.n);
  end loop;
end $$;
revoke execute on function app_bootstrap_admin(text) from authenticated;
revoke execute on function app_lock_anon() from authenticated;
select app_lock_anon();

grant select, insert, update, delete on app_module, app_role, app_permission,
                                        app_user, app_user_role to authenticated;
grant select on app_audit to authenticated;
revoke insert, update, delete on app_audit from authenticated;
revoke update, delete on am_data_source from authenticated;
do $$
declare r record;
begin
  for r in select c.oid::regclass::text as n
           from   pg_class c join pg_namespace s on s.oid = c.relnamespace
           where  s.nspname = 'public' and c.relkind = 'S' and c.relname ~ '^(am|app|pm)_'
  loop
    execute format('grant usage, select on sequence %s to authenticated', r.n);
  end loop;
end $$;


-- =====================================================================
-- 9. KIỂM CHỨNG — Supabase SQL Editor chỉ hiện kết quả câu lệnh CUỐI.
-- =====================================================================

-- Chỉ đếm đồ của app này (am_* / pm_* / 6 bảng app_*). Bảng của app khác trong
-- cùng project có luật riêng của chúng — không phải việc của file này.
select 'Bảng của app chưa bật RLS (phải = 0)' as "Mục",
       count(*)::text as "Thực tế", '0' as "Mong đợi",
       case when count(*) = 0 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_tables
where  schemaname = 'public' and not rowsecurity
  and  (tablename ~ '^(am|pm)_' or tablename in ('app_module', 'app_role', 'app_permission',
                                                 'app_user', 'app_user_role', 'app_audit'))
union all
select 'Policy của app mở cho anon (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies
where  schemaname = 'public' and 'anon' = any (roles)
  and  (tablename ~ '^(am|pm)_' or tablename in ('app_module', 'app_role', 'app_permission',
                                                 'app_user', 'app_user_role', 'app_audit'))
union all
select 'Bảng của app anon còn quyền (phải = 0)', count(distinct table_name)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee = 'anon' and table_schema = 'public'
  and  (table_name ~ '^(am|pm)_' or table_name in ('app_module', 'app_role', 'app_permission',
                                                   'app_user', 'app_user_role', 'app_audit'))
union all
select 'Hàm của app anon còn gọi được (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
where  n.nspname = 'public' and p.proname ~ '^(am|app|pm)_'
  and  has_function_privilege('anon', p.oid, 'execute')
union all
select 'View của app bỏ qua RLS (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_class c join pg_namespace n on n.oid = c.relnamespace
where  n.nspname = 'public' and c.relkind = 'v' and c.relname ~ '^(am|pm)_'
  and  not coalesce(c.reloptions @> array['security_invoker=true'], false)
union all
select 'Vai trò', count(*)::text, '14',
       case when count(*) = 14 then '✔' else '✘ HỎNG' end
from   app_role
union all
select 'Ô ma trận quyền', count(*)::text, '> 0',
       case when count(*) > 0 then '✔' else '✘ HỎNG' end
from   app_permission
union all
select 'Tài khoản đã đồng bộ', count(*)::text, '> 0',
       case when count(*) > 0 then '✔'
            else '✘ Tạo tài khoản ở Authentication → Users trước' end
from   app_user
union all
select 'System Admin', count(*)::text, '>= 1',
       case when count(*) >= 1 then '✔'
            else '✘ Chạy: select app_bootstrap_admin(''email@jvcplaza.vn'');' end
from   app_user_role
where  role_code = 'SYS_ADMIN';
