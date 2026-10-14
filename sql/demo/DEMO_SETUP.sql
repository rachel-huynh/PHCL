-- =====================================================================
-- sql/demo/DEMO_SETUP.sql — PROJECT DEMO / ĐÀO TẠO: TÀI KHOẢN + DỮ LIỆU THỬ
--
-- CHỈ chạy trên PROJECT SUPABASE DEMO (project riêng, mới tạo), SAU KHI đã
-- chạy sql/ALL_IN_ONE.sql trên chính project đó. KHÔNG BAO GIỜ chạy trên
-- project thật — file tự dừng nếu thấy dấu hiệu project thật (có bảng của app
-- khác, hoặc có tài sản không mang nhãn [DEMO]).
--
-- Tạo:
--   · 17 tài khoản demo theo vai trò: một mật khẩu chung cho người dùng thử và một mật khẩu RIÊNG
--     cho demo.admin — đổi cả hai ở cuối file (trong SQL Editor) trước khi chạy; đuôi e-mail @plaza-demo.test.
--   · Dữ liệu giả có tính chất như dữ liệu thật, dùng danh mục thật đã có sẵn
--     (phòng ban, vị trí, danh mục, sản phẩm, đơn vị, xuất xứ, từ vựng giá):
--     nhà cung cấp, ~1.200 tài sản, ngân sách 2025–2026, dự án, hoá đơn và
--     thanh toán, báo giá, hợp đồng, họp dự án, điều chuyển, sự cố, kiểm kê.
--     Tên doanh nghiệp, MST, số hoá đơn… đều bịa, mang nhãn [DEMO] khi có chỗ.
--   · am_demo_reset(): nút "Làm mới dữ liệu thử" ở Công cụ quản trị (xoá toàn bộ
--     dữ liệu nghiệp vụ của project demo rồi sinh lại). Tài khoản, danh mục và góp ý giữ nguyên.
--
-- Chạy lại nhiều lần vô hại (dữ liệu được sinh lại từ đầu).
-- =====================================================================


-- =====================================================================
-- 0. CHẶN PROJECT THẬT, ĐÁNH DẤU PROJECT DEMO
-- =====================================================================

do $$
begin
  if to_regclass('public.cd_phieu') is not null or to_regclass('public.legal_docs') is not null
     or to_regclass('public.bt_doc') is not null or to_regclass('public.dashboard_store') is not null then
    raise exception 'DỪNG: project này có bảng của các app khác (Công đoàn / Legal Portal / Budget Tracker / Dashboard) — đây là PROJECT THẬT. Chỉ chạy DEMO_SETUP.sql trên project demo riêng.';
  end if;
  if exists (select 1 from am_asset where coalesce(note, '') not like '[DEMO]%')
     and coalesce((select value #>> '{}' from am_setting where key = 'app_mode'), 'live') <> 'demo' then
    raise exception 'DỪNG: sổ tài sản có dữ liệu không mang nhãn [DEMO] — đây có vẻ là PROJECT THẬT.';
  end if;
end $$;

insert into am_setting (key, value, note) values
  ('app_mode', '"demo"'::jsonb, 'Chế độ của project này: live = dữ liệu thật; demo = dữ liệu thử (chỉ DEMO_SETUP.sql đặt)')
on conflict (key) do update set value = '"demo"'::jsonb;

create or replace function am_demo_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value #>> '{}' from am_setting where key = 'app_mode'), 'live') = 'demo'
$$;

create or replace function am_demo_guard()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not am_demo_on() then raise exception 'Chỉ dùng được trên project demo (am_setting app_mode = demo).'; end if;
end $$;


-- =====================================================================
-- 1. TÀI KHOẢN DEMO
-- =====================================================================

-- [email, họ tên, vai trò, phạm vi]
create or replace function am_demo_people()
returns table (email text, full_name text, role_code text, scope_org text)
language sql immutable as $$
  values ('demo.staff@plaza-demo.test',   'Nguyễn Minh Anh (NV Bếp)',         'DEPT_STAFF', 'KIT'),
         ('demo.kithead@plaza-demo.test', 'Trần Quốc Bảo (Bếp trưởng)',       'DEPT_HEAD',  'KIT'),
         ('demo.enghead@plaza-demo.test', 'Lê Văn Cường (Trưởng Kỹ thuật)',   'DEPT_HEAD',  'ENG'),
         ('demo.engtech@plaza-demo.test', 'Phan Văn Tài (Kỹ thuật viên ca)',  'DEPT_STAFF', 'ENG'),
         ('demo.hkhead@plaza-demo.test',  'Phạm Thu Dung (Trưởng Buồng)',     'DEPT_HEAD',  'HKD'),
         ('demo.dof@plaza-demo.test',     'Võ Thị Hạnh (DOF)',                'DOF',        'SOF'),
         ('demo.gm@plaza-demo.test',      'Daniel Martin (Hotel GM)',         'HOTEL_GM',   'SOF'),
         ('demo.purchasing@plaza-demo.test', 'Đỗ Thanh Hải (Thu mua)',        'PURCHASING', 'SOF'),
         ('demo.cphead@plaza-demo.test',  'Hoàng Gia Khánh (Trưởng cao ốc)',  'CP_HEAD',    'CP'),
         ('demo.amc@plaza-demo.test',     'Huỳnh Ngọc Lan (AM Coordinator)',  'AM_COORD',   'PHCL'),
         ('demo.amx@plaza-demo.test',     'Bùi Đức Minh (AM Executive)',      'AM_EXEC',    'PHCL'),
         ('demo.chiefacc@plaza-demo.test', 'Đặng Thị Ngân (Kế toán trưởng)',  'CHIEF_ACC',  'PHCL'),
         ('demo.jvcgm@plaza-demo.test',   'Mai Văn Phúc (JVC GM)',            'JVC_GM',     'PHCL'),
         ('demo.legal@plaza-demo.test',   'Trịnh Bảo Quyên (Pháp chế)',       'LEGAL',      'PHCL'),
         ('demo.hotelam@plaza-demo.test', 'Vũ Hoài Nam (Hotel Asset Manager)', 'HOTEL_AM',  'SOF'),
         ('demo.accountant@plaza-demo.test', 'Lâm Thị Oanh (Kế toán)',        'ACCOUNTANT', 'PHCL'),
         ('demo.admin@plaza-demo.test',   'Quản trị Demo',                    'SYS_ADMIN',  'PHCL')
$$;

-- Tạo tài khoản đăng nhập (auth.users + auth.identities) nếu chưa có, rồi gán vai trò.
-- Nếu Supabase không cho tạo tài khoản bằng SQL, tạo tay ở Authentication → Users → Add user
-- (đúng các e-mail trên, bỏ chọn "send invitation", tích "auto confirm") rồi chạy lại hàm này để gán vai trò.
-- p_password: mọi tài khoản người dùng thử; p_admin_password: riêng demo.admin (SYS_ADMIN). null = giữ mật khẩu đang có
-- (tài khoản mới tạo mà không có mật khẩu riêng thì dùng p_password).
drop function if exists am_demo_accounts(text);
create or replace function am_demo_accounts(p_password text, p_admin_password text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare r record; v_id uuid; v_pw text; n_new int := 0; n_role int := 0; n_fail int := 0;
begin
  perform am_demo_guard();
  -- Vai trò chưa có (vd ACCOUNTANT trước khi chạy 42) thì bỏ qua tài khoản đó.
  for r in select * from am_demo_people() x where exists (select 1 from app_role where code = x.role_code) loop
    v_pw := case when r.role_code = 'SYS_ADMIN' then p_admin_password else p_password end;
    select id into v_id from auth.users where lower(email) = r.email;
    if v_id is null then
      begin
        v_id := gen_random_uuid();
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', r.email, crypt(coalesce(v_pw, p_password), gen_salt('bf')), now(),
                '{"provider": "email", "providers": ["email"]}'::jsonb, jsonb_build_object('full_name', r.full_name), now(), now(), '', '', '', '');
        insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), v_id, v_id::text, jsonb_build_object('sub', v_id::text, 'email', r.email, 'email_verified', true), 'email', now(), now(), now());
        n_new := n_new + 1;
      exception when others then
        raise notice 'Không tạo được tài khoản % bằng SQL (%). Tạo tay ở Authentication → Users rồi chạy lại am_demo_accounts().', r.email, sqlerrm;
        n_fail := n_fail + 1; v_id := null;
      end;
    else
      -- Tài khoản đã có (chạy lại / đổi mật khẩu): đặt lại mật khẩu nếu có truyền (quản trị: chỉ khi có
      -- p_admin_password, để đổi mật khẩu người dùng thử không đụng tới quản trị), xác nhận e-mail.
      update auth.users set encrypted_password = case when v_pw is not null then crypt(v_pw, gen_salt('bf')) else encrypted_password end,
                            email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now()
      where id = v_id;
    end if;
    if v_id is not null then
      insert into app_user (id, email, full_name) values (v_id, r.email, r.full_name)
      on conflict (id) do update set full_name = coalesce(nullif(trim(app_user.full_name), ''), excluded.full_name), active = true;   -- giữ tên đã đổi trong app
      insert into app_user_role (user_id, role_code, scope_org) values (v_id, r.role_code, r.scope_org) on conflict do nothing;
      n_role := n_role + 1;
    end if;
  end loop;
  return format('Tài khoản mới: %s · có vai trò: %s · lỗi: %s', n_new, n_role, n_fail);
end $$;

create or replace function am_demo_uid(p_email text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from app_user where email = p_email
$$;

-- Tên hiển thị của một tài khoản demo: tên đang dùng trong app (quản trị có thể đổi cho quen thuộc),
-- không có thì tên mặc định. Dữ liệu thử ghi tên này, nên "Làm mới dữ liệu thử" khớp với tên đã đổi.
create or replace function am_demo_nm(p_email text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(trim(full_name), '') from app_user where email = p_email),
                  (select full_name from am_demo_people() where email = p_email), p_email)
$$;


-- =====================================================================
-- 2. XOÁ DỮ LIỆU NGHIỆP VỤ (chỉ project demo)
-- =====================================================================

create or replace function am_demo_wipe()
returns void language plpgsql security definer set search_path = public as $$
declare t text;
begin
  perform am_demo_guard();
  -- Dữ liệu nghiệp vụ. Danh mục (am_org, am_location, am_category…, am_product, am_unit, am_origin,
  -- pr_term, pr_unit), tài khoản, quyền, chuỗi duyệt, cài đặt và GÓP Ý (app_feedback) giữ nguyên.
  foreach t in array array[
    'pm_payreq', 'am_recv', 'pm_po_send', 'pm_tender_qa', 'pm_tender_survey',
    'am_chk_val', 'am_chk_run', 'am_cond', 'am_chk_point', 'am_chk', 'am_sys_item', 'am_sys',
    'pm_notice', 'pm_mt_action', 'pm_mt_entry', 'pm_mt_meeting', 'pm_mt_topic',
    'pm_contract_file', 'pm_contract', 'pr_line', 'pr_source', 'pr_import', 'pr_alias',
    'am_count_line', 'am_count', 'am_incident', 'am_transfer_line', 'am_transfer', 'am_report_snap',
    'pm_pay_alloc', 'pm_invoice', 'pm_payment', 'pm_pay_import',
    'pm_lq_sign', 'pm_lq_attend', 'pm_lq_quote', 'pm_lq_buyer', 'pm_lq_event', 'pm_lq_item', 'pm_lq_batch', 'pm_lq_member', 'pm_lq_council',
    'pm_tender_event', 'pm_tender_consent', 'pm_tender_bid', 'pm_tender_invite', 'pm_tender_invitee', 'pm_tender',
    'pm_doc_event', 'pm_doc_step', 'pm_doc', 'pm_pkg_event', 'pm_pkg_step', 'pm_pkg', 'pm_vendor_score',
    'pm_project', 'pm_budget_line', 'pm_budget_round', 'pm_budget_year',
    'am_asset_photo', 'am_alr_line', 'am_alr', 'am_asset', 'am_shipment', 'am_counter_log', 'am_data_source',
    'pm_vendor', 'app_audit', 'am_acc_link', 'am_acc_change', 'am_acc_line', 'am_acc_stage', 'am_acc_import'] loop
    if to_regclass('public.' || t) is not null then execute format('truncate table %I restart identity cascade', t); end if;
  end loop;
  update am_asset_seq set next_seq = 1;
  if to_regclass('public.pm_contract_no_seq') is not null then alter sequence pm_contract_no_seq restart; end if;
end $$;


-- =====================================================================
-- 3. SINH DỮ LIỆU THỬ
-- =====================================================================

create or replace function am_demo_pick(a text[])
returns text language sql volatile as $$ select a[1 + floor(random() * array_length(a, 1))::int] $$;

/* Hệ thống kỹ thuật & checklist ca (37_eng_checklist.sql): 4 hệ thống thật của
   toà nhà (Chiller — thí điểm, PCCC, Máy phát, Cấp nước), 14 ngày checklist 3 ca
   với vài bất thường có chủ ý (bơm CHWP-2 xuống cấp, Chiller 1 trip), 2 sự cố,
   đánh giá hiện trạng đủ cho ST04. Trả số lần kiểm. */
create or replace function am_demo_eng()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_sys  jsonb := '[["ST04","Chiller","Hệ thống Chiller"],["ST10","Fire fighting system","Hệ thống chữa cháy"],
                    ["ST11","Generator","Máy phát điện"],["ST20","Water Supply","Hệ thống cấp nước"]]';
  -- [mã, tên, vị trí, năm lắp, tuổi thọ, mức quan trọng]
  v_items jsonb := '[["ST04.01","Chiller 1","S0311E1",1998,25,5],["ST04.02","Chiller 2","S0311E1",1998,25,5],["ST04.03","Chiller 3","S0311E1",2016,25,5],
    ["ST04.04","Chiller Water Pump CHWP-1","S0311E1",1998,15,4],["ST04.05","Chiller Water Pump CHWP-2","S0311E1",1998,15,4],["ST04.06","Chiller Water Pump CHWP-3","S0311E1",1998,15,4],
    ["ST04.07","Chiller Water Pump CHWP-4","S0311E1",2019,15,4],["ST04.08","Chiller Water Pump CHWP-5","S0311E1",2019,15,4],
    ["ST04.09","Cooling Chiller Water Pump CCWP1","S0311E1",1998,15,4],["ST04.10","Cooling Chiller Water Pump CCWP2","S0311E1",1998,15,4],
    ["ST04.11","Cooling Chiller Water Pump CCWP3","S0311E1",2012,15,4],["ST04.12","Cooling Chiller Water Pump CCWP4","S0311E1",2012,15,4],
    ["ST04.13","Cooling Chiller Water Pump CCWP5","S0311E1",2012,15,3],["ST04.14","Cooling Tower CT-1","S0311E2",1998,20,4],
    ["ST04.15","Cooling Tower CT-2","S0311E2",1998,20,4],["ST04.16","Cooling Tower CT-3","S0311E2",2010,20,4],["ST04.17","Cooling Tower CT-4","S0311E2",2010,20,4],
    ["ST04.18","Cooling Tower CT-5","S0311E2",2010,20,3],
    ["ST10.01","FS Transfer Pump 1","SB201E0",1998,20,4],["ST10.02","FS Transfer Pump 2","SB201E0",1998,20,4],["ST10.03","Hose Reel Pump A (Duty)","SB201E0",1998,20,5],
    ["ST10.04","Hose Reel Pump B (Stanby)","SB201E0",1998,20,5],["ST10.05","Jockey Pump Hose Reel","SB201E0",2015,15,4],
    ["ST10.06","Jockey Pump Sprinkler High Zone","SB201E0",2015,15,4],["ST10.07","Jockey Pump Sprinkler Low Zone","SB201E0",2015,15,4],
    ["ST10.08","Sprinkler Pump High Zone A","SB201E0",1998,20,5],["ST10.09","Sprinkler Pump High Zone B","SB201E0",1998,20,5],
    ["ST10.10","Sprinkler Pump Low Zone A","SB201E0",1998,20,5],["ST10.11","Sprinkler Pump Low Zone B","SB201E0",1998,20,5],
    ["ST11.01","DO Daily Tank (liter)","SB103E0",1998,40,3],["ST11.02","DO store tank","SB103E0",1998,40,3],["ST11.03","Generator 1","SB103E0",1998,30,5],
    ["ST11.04","Generator 2","SB103E0",1998,30,5],["ST11.05","Generator 3","SB103E0",2008,30,5],
    ["ST20.01","Booster Pump 1","SRT00E3",2014,15,4],["ST20.02","Booster Pump 2","SRT00E3",2014,15,4],["ST20.03","Booster Pump 3","SRT00E3",2014,15,3],
    ["ST20.06","Domestic Water Tank 160m3 rooftop","SRT00E1",1998,40,3],["ST20.10","Fire Water Tank 75 m3 Rooftop","SRT00E1",1998,40,4],
    ["ST20.13","Transfer Pump TP - 1 (Office)","SB201E0",2005,15,3],["ST20.14","Transfer Pump TP - 2 (Spare)","SB201E0",2005,15,3],
    ["ST20.15","Transfer Pump TP - 3 (Hotel)","SB201E0",2005,15,4],["ST20.16","Ultraviolet rays UV-1","SRT00E3",2020,10,3],["ST20.17","Ultraviolet rays UV-2","SRT00E3",2020,10,3]]';
  v_chk  jsonb := '[["DCL0002","Chiller","ST04"],["DCL0005","Fire Fighting","ST10"],["DCL0006","Generator","ST11"],["DCL0016","Water Supply","ST20"]]';
  -- Số đo không gắn hạng mục: [checklist, nhiệm vụ, vị trí, tầng, nhãn, đơn vị, min, max, giá trị thường]
  v_nums jsonb := '[["DCL0002","Chilled water supply temp","S0311E1","3F","°C","°C",6,9,7.2],["DCL0002","Chilled water return temp","S0311E1","3F","°C","°C",10,14,12.1],
    ["DCL0005","Pressure High Zone (Kg/cm2)","SB201E0","B2","Pressure","kg/cm²",6,9,7.5],["DCL0005","Pressure Low Zone (Kg/cm2)","SB201E0","B2","Pressure","kg/cm²",4,7,5.4],
    ["DCL0005","Pressure Hose Reel (Kg/cm2)","SB201E0","B2","Pressure","kg/cm²",5,8,6.3],["DCL0016","Pressure (kg/cm2)","SRT00E3","Rooftop","Pressure","kg/cm²",3,6,4.2],
    ["DCL0016","Domestic Water Tank (level)","SRT00E1","Rooftop","Level","%",40,100,78],["DCL0016","Fire Water Tank (level)","SRT00E1","Rooftop","Level","%",80,100,92]]';
  x jsonb; v_asset bigint; v_run bigint; v_d date; v_s text; v_pt am_chk_point; v_iname text; v_r float; v_st text; v_n1 numeric; v_n2 numeric; v_ok boolean;
  v_runs int := 0; v_names text[] := array[am_demo_nm('demo.engtech@plaza-demo.test'), 'Ngô Minh Trí (KTV ca)', 'Đặng Quốc Việt (KTV ca)', 'Lý Thành Công (KTV ca)'];
  v_inc bigint; v_head text := am_demo_nm('demo.enghead@plaza-demo.test');
begin
  perform am_demo_guard();
  if to_regclass('public.am_sys') is null then return 0; end if;   -- 37 chưa chạy
  for x in select * from jsonb_array_elements(v_sys) loop
    -- Tài sản cha: một tài sản cơ điện của phòng Kỹ thuật trong bộ dữ liệu giả.
    select id into v_asset from am_asset where dept_code = 'ENG' and category_code = 'MES' and not exists (select 1 from am_sys s where s.asset_id = am_asset.id)
    order by id limit 1;
    insert into am_sys (code, name_en, name_vi, dept_code, parent_code, asset_id, sort)
    values (x ->> 0, x ->> 1, x ->> 2, 'ENG', (select asset_code from am_asset where id = v_asset), v_asset, substr(x ->> 0, 3)::int);
  end loop;
  insert into am_sys_item (code, sys_code, name, location_code, install_year, life_years, criticality, sort)
  select e ->> 0, split_part(e ->> 0, '.', 1), e ->> 1, e ->> 2, (e ->> 3)::int, (e ->> 4)::int, (e ->> 5)::smallint, n
  from jsonb_array_elements(v_items) with ordinality as q(e, n);
  insert into am_chk (code, name, sys_code, sort) select e ->> 0, e ->> 1, e ->> 2, n from jsonb_array_elements(v_chk) with ordinality as q(e, n);
  -- Trạng thái: mọi hạng mục có máy chạy (không phải bể). Máy phát: kèm điện áp ắc quy.
  insert into am_chk_point (chk_code, seq, task, location_code, floor, item_id, options, ok_states, num_labels, unit, min_ok, max_ok)
  select c.code, i.sort, i.name, i.location_code, case when i.location_code like 'S03%' then '3F' when i.location_code like 'SB2%' then 'B2'
                                                        when i.location_code like 'SB1%' then 'B1' else 'Rooftop' end, i.id,
         case when i.name ilike '%tank%' then null else '{Auto,On,Off}'::text[] end,
         case when i.name ~* 'stanby|spare| B$|pump 2$|CHWP-[345]|CCWP[345]|CT-[45]|Generator|Chiller 3' then '{Auto,On,Off}'::text[] else '{Auto,On}'::text[] end,
         case when i.name ilike 'Generator%' then '{Battery}'::text[] when i.name ilike 'DO Daily%' then '{Liter}'::text[] end,
         case when i.name ilike 'Generator%' then 'V' when i.name ilike 'DO Daily%' then 'L' end,
         case when i.name ilike 'Generator%' then 24 when i.name ilike 'DO Daily%' then 300 end,
         case when i.name ilike 'Generator%' then 28.5 when i.name ilike 'DO Daily%' then 1000 end
  from am_sys_item i join am_chk c on c.sys_code = i.sys_code
  where not (i.name ilike 'DO store%' or i.name ilike '%Water Tank%');
  insert into am_chk_point (chk_code, seq, task, location_code, floor, num_labels, unit, min_ok, max_ok)
  select e ->> 0, 100 + n, e ->> 1, e ->> 2, e ->> 3, array[e ->> 4], e ->> 5, (e ->> 6)::numeric, (e ->> 7)::numeric
  from jsonb_array_elements(v_nums) with ordinality as q(e, n);

  -- 14 ngày × 3 ca; ca hiện tại đang ghi dở, thỉnh thoảng một ca bị bỏ.
  for v_d in select generate_series(current_date - 13, current_date, interval '1 day')::date loop
    foreach v_s in array array['S', 'C', 'D'] loop
      if v_d = current_date and v_s <> 'S' then continue; end if;
      for x in select * from jsonb_array_elements(v_chk) loop
        if random() < 0.04 and v_d < current_date then continue; end if;
        insert into am_chk_run (chk_code, run_date, shift, status, started_name, started_at, done_name, done_at)
        values (x ->> 0, v_d, v_s, case when v_d = current_date then 'open' else 'done' end, am_demo_pick(v_names),
                v_d + case v_s when 'S' then time '06:40' when 'C' then time '14:35' else time '22:30' end,
                case when v_d < current_date then am_demo_pick(v_names) end,
                case when v_d < current_date then v_d + case v_s when 'S' then time '07:25' when 'C' then time '15:20' else time '23:15' end end)
        returning id into v_run;
        v_runs := v_runs + 1;
        for v_pt in select * from am_chk_point p where p.chk_code = x ->> 0 order by p.seq loop
          v_iname := (select name from am_sys_item where id = v_pt.item_id);
          if v_d = current_date and random() < 0.5 then continue; end if;   -- ca đang làm: mới ghi một nửa
          -- Độc lập với thứ tự gọi random() (setseed cố định làm các vị trí lặp lại theo chu kỳ).
          v_r := (abs(hashtext(v_d::text || v_s || v_pt.id::text)) % 10000) / 10000.0; v_st := null; v_n1 := null; v_n2 := null;
          if v_pt.options is not null then
            v_st := case when v_pt.ok_states @> '{Off}' then am_demo_pick(array['Auto', 'Auto', 'Off', 'Off', 'On'])
                         else am_demo_pick(array['Auto', 'Auto', 'On']) end;
            -- Xuống cấp có chủ ý: CHWP-2 hay dừng; Chiller 1 trip vài lần tuần này; lác đác nơi khác.
            if (v_iname = 'Chiller Water Pump CHWP-2' and v_r < 0.18) or (v_iname = 'Chiller 1' and v_d > current_date - 6 and v_r < 0.15)
               or v_r < 0.006 then v_st := 'Off'; end if;
          end if;
          if v_pt.num_labels is not null then
            v_n1 := case when v_pt.unit = 'V' then round((26.2 + (random() - 0.5) * 2.4)::numeric, 1)
                         when v_pt.unit = 'L' then round((650 + (random() - 0.5) * 500)::numeric, -1)
                         when v_pt.unit = '%' then least(100, round((coalesce((select (e ->> 8)::numeric from jsonb_array_elements(v_nums) e where e ->> 1 = v_pt.task), 80)
                                     * (1 + (random() - 0.5) * 0.12))::numeric, 0))
                         else round((coalesce((select (e ->> 8)::numeric from jsonb_array_elements(v_nums) e where e ->> 1 = v_pt.task), 5)
                                     * (1 + (random() - 0.5) * 0.16))::numeric, 1) end;
            if v_r > 0.975 then   -- ngoài ngưỡng: mức bể thì hụt, còn lại vượt
              v_n1 := case when v_pt.unit = '%' then round((coalesce(v_pt.min_ok, v_n1) * 0.85)::numeric, 0) else round((coalesce(v_pt.max_ok, v_n1) * 1.12)::numeric, 1) end;
            end if;
            if v_pt.task = 'Chilled water supply temp' and v_d > current_date - 4 and v_r < 0.3 then v_n1 := 9.8; end if;
          end if;
          v_ok := am_chk_ok(v_pt, v_st, v_n1, v_n2);
          insert into am_chk_val (run_id, point_id, state, num1, num2, ok, by_name, at)
          values (v_run, v_pt.id, v_st, v_n1, v_n2, v_ok, am_demo_pick(v_names), v_d + time '07:00');
        end loop;
        update am_chk_run set abn = (select count(*) from am_chk_val where run_id = v_run and ok = false),
                              filled = (select count(*) from am_chk_val where run_id = v_run and ok is not null) where id = v_run;
      end loop;
    end loop;
  end loop;

  -- Hai sự cố báo từ checklist, trên tài sản cha của hệ thống Chiller.
  select asset_id into v_asset from am_sys where code = 'ST04';
  if v_asset is not null then
    insert into am_incident (no, asset_id, dept_code, kind, status, reported_at, description, created_name)
    values ('SC.2026.00901', v_asset, 'ENG', 'repair', 'in_progress', current_date - 9,
            'DCL0002 — Chiller Water Pump CHWP-2 — Off — bơm tự ngắt, nóng động cơ, nghi hỏng bạc đạn', am_demo_nm('demo.engtech@plaza-demo.test'))
    returning id into v_inc;
    update am_chk_val v set incident_id = v_inc from am_chk_run r, am_chk_point p
    where v.run_id = r.id and p.id = v.point_id and p.task = 'Chiller Water Pump CHWP-2' and v.ok = false
      and r.run_date = (select min(r2.run_date) from am_chk_run r2 join am_chk_val v2 on v2.run_id = r2.id join am_chk_point p2 on p2.id = v2.point_id
                        where p2.task = 'Chiller Water Pump CHWP-2' and v2.ok = false and r2.run_date >= current_date - 9);
    insert into am_incident (no, asset_id, dept_code, kind, status, reported_at, description, created_name, closed_at, closed_name, outcome, cost)
    values ('SC.2026.00902', v_asset, 'ENG', 'maintenance', 'closed', current_date - 40, 'Bảo dưỡng Chiller 1 — vệ sinh dàn ngưng, thay lọc gas',
            v_head, now() - interval '38 days', v_head, 'fixed', 38000000);
  end if;

  -- Đánh giá hiện trạng: đủ ST04 (thí điểm), vài hạng mục PCCC / máy phát.
  insert into am_cond (item_id, assessed_on, score, remaining_years, action, target_year, est_cost, reason, created_name)
  select i.id, current_date - 3, c.score, c.rem, c.act, c.yr, c.cost, c.reason, v_head
  from (values
    ('ST04.01', 2, 1.5, 'replace', 2027, 4200000000, 'Máy 1998 (28 năm, quá tuổi thọ 25). Gas R22 đã ngừng sản xuất, rò gas 2 lần/năm, COP giảm ~30%. Trip 3 lần tuần này.'),
    ('ST04.02', 2, 2.0, 'replace', 2028, 4200000000, 'Cùng đời Chiller 1, gas R22; vận hành ổn định hơn nhưng máy nén ồn, dầu nhanh bẩn.'),
    ('ST04.03', 4, 15, 'monitor', null, null, 'Lắp 2016, hiệu suất tốt; bảo dưỡng theo hợp đồng.'),
    ('ST04.04', 3, 4, 'overhaul', 2027, 85000000, 'Rung nhẹ, đã thay phớt 2024.'),
    ('ST04.05', 1, 0.5, 'replace', 2026, 180000000, 'Bơm tự ngắt nhiều lần, nóng động cơ, bạc đạn mòn — đang có sự cố SC.2026.00901. Thay ngay trước mùa nóng.'),
    ('ST04.06', 2, 2, 'replace', 2027, 180000000, 'Gỉ vỏ bơm, hiệu suất thấp, 28 năm.'),
    ('ST04.07', 5, 12, 'none', null, null, 'Thay mới 2019.'),
    ('ST04.08', 5, 12, 'none', null, null, 'Thay mới 2019.'),
    ('ST04.09', 2, 2, 'replace', 2027, 160000000, 'Mòn cánh bơm, lưu lượng giảm.'),
    ('ST04.10', 3, 4, 'overhaul', 2028, 70000000, 'Còn dùng được, cần đại tu động cơ.'),
    ('ST04.11', 4, 8, 'monitor', null, null, 'Lắp 2012, ổn định.'),
    ('ST04.12', 4, 8, 'monitor', null, null, 'Lắp 2012, ổn định.'),
    ('ST04.13', 4, 8, 'monitor', null, null, 'Dự phòng, chạy luân phiên.'),
    ('ST04.14', 2, 2, 'replace', 2027, 650000000, 'Khung thép gỉ, tấm tản nhiệt vỡ nhiều, quạt rung.'),
    ('ST04.15', 3, 3, 'repair', 2027, 220000000, 'Thay tấm tản nhiệt và bạc đạn quạt.'),
    ('ST04.16', 4, 7, 'monitor', null, null, 'Lắp 2010.'),
    ('ST04.17', 4, 7, 'monitor', null, null, 'Lắp 2010.'),
    ('ST04.18', 3, 5, 'repair', 2028, 90000000, 'Rò nước bể chứa.'),
    ('ST10.08', 3, 5, 'overhaul', 2028, 120000000, 'Bơm chữa cháy 1998, chạy thử định kỳ đạt; nên đại tu động cơ.'),
    ('ST11.03', 3, 6, 'overhaul', 2029, 350000000, 'Máy phát 1998, 5.800 giờ chạy; đại tu đầu máy.'),
    ('ST11.05', 4, 12, 'monitor', null, null, 'Lắp 2008, ít giờ chạy.')
  ) as c(code, score, rem, act, yr, cost, reason)
  join am_sys_item i on i.code = c.code;
  -- Một lần đánh giá cũ để thấy lịch sử.
  insert into am_cond (item_id, assessed_on, score, remaining_years, action, target_year, est_cost, reason, created_name)
  select id, current_date - 200, 2, 1.5, 'overhaul', 2026, 60000000, 'Rung, nóng — đề xuất đại tu.', v_head from am_sys_item where code = 'ST04.05';
  return v_runs;
end $$;

create or replace function am_demo_seed(p_assets int default 1200)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  -- Phòng ban (có trọng số) và nhóm danh mục hợp với từng phòng.
  v_depts   text[] := array['HKD','HKD','HKD','HKD','HKD','KIT','KIT','KIT','FBD','FBD','FBD','ENG','ENG','ENG','FOD','FOD','ADM','SMD','FIN','ITD','ITD','SEC','CEN','CEN'];
  v_cats    jsonb := '{"KIT": ["KME","LTU","LTG"], "FBD": ["FUR","LTU","LTG","KME"], "ENG": ["MES","INF","SME","LTU","STR"], "HKD": ["FUR","LTU","LTG"],
                      "ITD": ["ITO","OIA","LTU"], "FOD": ["FUR","ITO","LTU"], "ADM": ["FUR","OIA","LTU"], "SMD": ["FUR","OIA","LTU"], "FIN": ["FUR","OIA","LTU"],
                      "SEC": ["LTU","OIA","MES"], "CEN": ["MES","FUR","LTU","INF"]}';
  -- Từ khoá (không dấu) của sản phẩm thường gặp ở từng phòng.
  v_kw      jsonb := '{"KIT": "bep|lo |lo nuong|tu mat|tu dong|tu lanh|may rua|noi|chao|may xay|may tron|ban inox|ke inox|hut khoi|may lam da|kitchen|oven|fridge|freezer",
                      "FBD": "^(ban|ghe|quay|ly|coc|dia|den|sofa|xe day|tu ruou|may pha)( |$)|restaurant|table|chair|bar counter",
                      "ENG": "may bom|bom|chiller|dieu hoa|quat|tu dien|may phat|thang may|ahu|fcu|pump|boiler|noi hoi|dong co|may nen|ong nuoc|van ",
                      "HKD": "giuong|nem|rem|tham|tivi|ket sat|tu quan ao|ban trang diem|sofa|guong|bed|curtain|carpet|minibar|may say toc|may hut bui|^(den|ghe)( |$)",
                      "ITD": "may tinh|man hinh|may in|switch|router|camera|may chu|server|laptop|dien thoai|wifi|access point|ups|bo dinh tuyen",
                      "FOD": "^(quay|ghe|ban|tu|sofa|ket)( |$)|may tinh|may in|xe day hanh ly",
                      "ADM": "^(ban|ghe|tu|ke)( |$)|may in|may tinh|dien thoai|may photo",
                      "SMD": "^(ban|ghe|tu|ke)( |$)|may tinh|man hinh|may chieu",
                      "FIN": "^(ban|ghe|tu|ket)( |$)|may tinh|may in|ket sat",
                      "SEC": "camera|cong tu|bo dam|den pin|may do|^(ban|ghe|tu)( |$)",
                      "CEN": "thang may|dieu hoa|may bom|quat|tu dien|^(den|ghe|ban|cua)( |$)"}';
  -- Từ loại trừ (tên có chữ "bàn/tủ/ghế" nhưng không phải đồ văn phòng / phòng khách).
  v_kx      jsonb := '{"FBD": "phim|cong|dien|lanh|dieu khien|thanh chan", "HKD": "dieu khien|dien tu", "FOD": "phim|cong|dien|lanh|dieu khien|hap|nguon|chau rua",
                      "ADM": "phim|cong|dien|lanh|dieu khien|bien ap|phat|hap|nguon", "SMD": "phim|cong|dien|lanh|dieu khien|mach|hap|nguon|card", "FIN": "phim|cong|dien|lanh|dieu khien|ban dan|hap|nguon",
                      "SEC": "phim|cong |lanh|ban cong|dinh tuyen", "CEN": "phim|lanh|ban cong|card"}';
  v_locs    jsonb := '{}';
  v_seq     jsonb := '{}';
  v_brands  text[] := array['Electrolux','Rational','Hobart','Daikin','Carrier','Trane','Grundfos','Panasonic','Samsung','LG','Toshiba','Mitsubishi','Hafele','Toto','Kohler','Dell','HP','Cisco','Hikvision','Bosch','Philips','Unox','Winterhalter','Primo','Sunshine','Hòa Phát','Xuân Hòa','Kinglong'];
  v_origins text[] := array['VN','VN','VN','CN','CN','JP','DE','IT','US','KR','TH','MY'];
  v_vendors text[];
  v_vcodes  text[];
  a record; p record; v_cat record; v_dept text; v_loc text; v_key text; v_n int; v_year int; v_kind text; v_qty numeric; v_price numeric;
  v_bu bigint := 1; v_bl bigint := 1; v_st text; v_pd date; v_id bigint; v_code text; v_cnt int := 0; i int; j int; k int;
  v_round bigint; v_pc text; v_names jsonb; v_list jsonb; v_est numeric; v_pos numeric; v_imp numeric; v_ass numeric; v_risk text;
  v_req date; v_app date; v_pur date; v_hand date; v_cv numeric; v_vend text; v_vcode text; v_tax text; v_inv bigint; v_pay bigint;
  v_src bigint; t record; v_topic bigint; v_meet bigint; v_entry bigint; v_d date; v_amx uuid := am_demo_uid('demo.amx@plaza-demo.test');
  v_origin text;
  v_got boolean; v_pool jsonb; v_pool2 jsonb; v_pl jsonb; v_prod jsonb;
  v_amc uuid := am_demo_uid('demo.amc@plaza-demo.test'); v_c pm_contract; v_tf bigint; v_cid bigint; v_out jsonb;
begin
  perform am_demo_guard();
  perform am_demo_wipe();
  perform setseed(0.2026);

  ---------------------------------------------------------------- nhà cung cấp
  insert into pm_vendor (code, name, tax_code, address, phone, email, active, note)
  select 'DM' || lpad(g::text, 3, '0'),
         (array['Công ty TNHH','Công ty Cổ phần','Công ty TNHH MTV'])[1 + g % 3] || ' ' ||
         (array['Thiết bị Khách sạn Minh Phát','Kỹ thuật Điện lạnh Hoàng Long','Nội thất An Khang','Bếp Công nghiệp Sao Việt','Giải pháp CNTT Tân Tiến',
                'Thang máy Đại Phong','PCCC Thành Công','Vật tư Điện Nam Á','Cơ điện Lạc Hồng','Thiết bị Giặt là Hưng Thịnh','Rèm & Thảm Phương Nam',
                'Thiết bị Vệ sinh Kim Ngân','Âm thanh Ánh sáng Việt Tín','Xây dựng Đông Dương','Tư vấn Thiết kế Phú Mỹ','Điều hoà Toàn Cầu','Camera An Ninh 24h',
                'Nhôm kính Bảo Tín','Sơn & Hoàn thiện Mỹ Á','Nệm & Chăn ga Hoàng Gia','Dụng cụ Bếp Á Châu','Cửa tự động Tân Phú','Máy phát điện Cát Tường',
                'Viễn thông Hòa Bình','Kho lạnh Bắc Nam','Thiết bị Hồ bơi Xanh','Cây xanh Sân vườn Hữu Nghị','Vận chuyển Nhanh Việt','Bảo trì Toà nhà Thịnh Vượng','Văn phòng phẩm Sài Gòn'])[1 + (g - 1) % 30]
         || case when g > 30 then ' ' || (array['Miền Nam','Chi nhánh HCM','Sài Gòn','Việt Nam'])[1 + g % 4] else '' end,
         case when g % 9 = 0 then null else '03' || lpad((10000000 + g * 7919 % 89999999)::text, 8, '0') end,
         (10 + g) || ' ' || (array['Nguyễn Huệ','Lê Lợi','Điện Biên Phủ','Cách Mạng Tháng 8','Võ Văn Tần','Nam Kỳ Khởi Nghĩa','Phan Xích Long'])[1 + g % 7] || ', TP. Hồ Chí Minh',
         '028 ' || lpad((38000000 + g * 1307)::text, 8, '0'), 'sales' || g || '@vendor-demo.test', true, '[DEMO]'
  from generate_series(1, 60) g;
  v_vendors := array(select name from pm_vendor order by code);
  v_vcodes  := array(select code from pm_vendor order by code);

  ---------------------------------------------------------------- vị trí theo phòng ban
  v_locs := jsonb_build_object(
    'KIT', to_jsonb(array(select code from am_location where code like 'S%' and kind = 'room' and (name ilike '%kitchen%' or name ilike '%pantry%' or name ilike '%bakery%' or name ilike '%butcher%'))),
    'FBD', to_jsonb(array(select code from am_location where code like 'S%' and kind = 'room' and (name ilike '%restaurant%' or name ilike '%bar%' or name ilike '%lounge%' or name ilike '%ballroom%' or name ilike '%meeting%'))),
    'ENG', to_jsonb(array(select code from am_location where code like 'S%' and kind = 'room' and (code like 'SB%' or name ilike '%engineer%' or name ilike '%chiller%' or name ilike '%pump%' or name ilike '%electric%'))),
    'HKD', to_jsonb(array(select code from am_location where code like 'S%' and kind = 'room' and name ilike 'room %')),
    'CEN', to_jsonb(array(select code from am_location where code like 'C%' and kind = 'room')),
    'ANY', to_jsonb(array(select code from am_location where code like 'S%' and kind = 'room')));

  ---------------------------------------------------------------- tài sản
  -- Sản phẩm hợp với từng phòng, lập một lần (nhanh: cả đợt sinh dữ liệu phải xong trong vài giây).
  -- v_pool: theo từ khoá của phòng (trừ từ loại trừ); v_pool2: mọi sản phẩm của các danh mục của phòng.
  select jsonb_object_agg(d, arr) into v_pool from (
    select dd.d, jsonb_agg(jsonb_build_object('vi', pr.std_name_vi, 'en', pr.std_name_en, 'unit', pr.default_unit, 'cat', c.code, 'grp', c.group_code,
                                              'letters', c.label_letters, 'mb', c.manage_by)) arr
    from   (select distinct unnest(v_depts) d) dd
    cross  join am_product pr join am_category c on c.code = pr.default_category join am_category_group g on g.code = c.group_code
    where  c.active and not g.is_intangible
      and  am_norm(pr.std_name_vi || ' ' || coalesce(pr.std_name_en, '')) ~ (v_kw ->> dd.d)
      and  am_norm(pr.std_name_vi || ' ' || coalesce(pr.std_name_en, '')) !~ coalesce(v_kx ->> dd.d, '^$')
    group by dd.d) x;
  select jsonb_object_agg(d, arr) into v_pool2 from (
    select dd.d, jsonb_agg(jsonb_build_object('vi', pr.std_name_vi, 'en', pr.std_name_en, 'unit', pr.default_unit, 'cat', c.code, 'grp', c.group_code,
                                              'letters', c.label_letters, 'mb', c.manage_by)) arr
    from   (select distinct unnest(v_depts) d) dd
    cross  join am_product pr join am_category c on c.code = pr.default_category join am_category_group g on g.code = c.group_code
    where  c.active and not g.is_intangible and pr.default_category in (select jsonb_array_elements_text(coalesce(v_cats -> dd.d, '["LTU"]')))
      and  am_norm(pr.std_name_vi || ' ' || coalesce(pr.std_name_en, '')) !~ coalesce(v_kx ->> dd.d, '^$')
    group by dd.d) x;

  for i in 1 .. p_assets loop
    v_dept := am_demo_pick(v_depts);
    -- 4/5 lần theo từ khoá của phòng, còn lại bất kỳ sản phẩm nào của các danh mục của phòng.
    v_pl := case when random() < 0.8 and jsonb_array_length(coalesce(v_pool -> v_dept, '[]')) > 0 then v_pool -> v_dept else v_pool2 -> v_dept end;
    if v_pl is null or jsonb_array_length(v_pl) = 0 then continue; end if;
    v_prod := v_pl -> floor(random() * jsonb_array_length(v_pl))::int;
    select v_prod ->> 'vi' std_name_vi, v_prod ->> 'en' std_name_en, v_prod ->> 'unit' default_unit, v_prod ->> 'cat' cat, v_prod ->> 'grp' grp,
           v_prod ->> 'letters' letters, v_prod ->> 'mb' manage_by
      into p;
    v_kind := case when p.manage_by = 'quantity' or p.cat like '%-QR' then 'low' else 'unique' end;
    v_year := (array[2012,2014,2015,2016,2017,2018,2019,2019,2020,2021,2022,2022,2023,2023,2024,2024,2025,2025,2025,2026,2026])[1 + floor(random() * 21)::int];
    v_key  := v_dept || '.' || p.letters;
    v_n    := coalesce((v_seq ->> v_key)::int, 0) + 1;
    v_seq  := jsonb_set(v_seq, array[v_key], to_jsonb(v_n));
    v_list := coalesce(nullif(v_locs -> v_dept, '[]'::jsonb), v_locs -> 'ANY');
    v_loc  := v_list ->> floor(random() * jsonb_array_length(v_list))::int;
    v_qty  := case when v_kind = 'low' then 5 + floor(random() * 75) else 1 end;
    v_price := case when v_kind = 'low' then round((50 + random() * 1950)) * 1000
                    when p.grp = 'C2112' and p.cat in ('MES', 'INF') then round((20 + random() * 880)) * 1000000
                    when p.cat = 'KME' then round((8 + random() * 240)) * 1000000
                    else round((2 + random() * 60)) * 1000000 end;
    v_pd   := make_date(v_year, 1 + floor(random() * 12)::int, 1 + floor(random() * 27)::int);
    v_origin := am_demo_pick(v_origins);
    if v_pd > current_date then v_pd := current_date - 20; end if;
    v_st   := case when v_kind = 'low' then am_demo_pick(array['20','20','20','20','20','20','20','20','21','25','22'])
                   else am_demo_pick(array['1','1','1','1','1','1','1','1','1','1','1','1','1','1','2','3','5','6','8','10','10']) end;
    if v_kind = 'unique' then v_code := 'JVC.0' || lpad(v_bu::text, 8, '0'); v_bu := v_bu + 1;
    else v_code := 'JVC.9' || lpad(v_bl::text, 8, '0'); v_bl := v_bl + 1; end if;
    insert into am_asset (asset_code, barcode, asset_kind, category_code, group_code, letters, seq, purchase_year, company_code, dept_code, location_code,
                          name_vi, name_en, unit_code, qty, serial, unit_price, currency, origin_iso2, supplier, manufacturer, invoice_no, purchase_date, in_use_date,
                          depreciate, depreciate_months, spec_brand, spec_model, status_code, label_printed, note, warranty_until)
    values (format('%s.%s.%s.%s.%s', v_dept, p.grp, p.letters, v_year, lpad(v_n::text, 5, '0')), v_code, v_kind, p.cat, p.grp, p.letters, v_n, v_year,
            case when v_dept = 'CEN' then 'CP' else 'SOF' end, v_dept, v_loc,
            p.std_name_vi, p.std_name_en, coalesce((select code from am_unit where code = p.default_unit), case when v_kind = 'low' then 'pcs' else 'pcs' end),
            v_qty, case when v_kind = 'unique' then 'SN' || upper(substr(md5(i::text), 1, 10)) end, v_price, 'VND',
            (select o.iso2 from am_origin o where o.iso2 = v_origin), am_demo_pick(v_vendors), am_demo_pick(v_brands),
            'HD' || lpad((1000 + i)::text, 7, '0'), v_pd, v_pd + 7, v_kind = 'unique', case when v_kind = 'unique' then (array[36,60,84,120])[1 + floor(random() * 4)::int] end,
            am_demo_pick(v_brands), upper(substr(md5((i * 7)::text), 1, 6)), v_st, random() < 0.92, '[DEMO]',
            case when random() < 0.7 then v_pd + (array[365, 730, 1095])[1 + floor(random() * 3)::int] end);
    v_cnt := v_cnt + 1;
  end loop;
  -- Bộ đếm mã tài sản và mã vạch theo sổ, để nhập hàng mới trong demo không trùng mã.
  insert into am_asset_seq (dept_code, letters, next_seq)
  select dept_code, letters, max(seq) + 1 from am_asset group by dept_code, letters
  on conflict (dept_code, letters) do update set next_seq = excluded.next_seq;
  update am_barcode_seq set next_val = greatest(next_val, v_bu) where kind = 'unique';
  update am_barcode_seq set next_val = greatest(next_val, v_bl) where kind = 'low';

  ---------------------------------------------------------------- ngân sách + dự án 2025, 2026
  v_names := '{
    "KIT": ["Thay máy rửa chén băng chuyền", "Tủ ủ bột 18 khay", "Lò hấp nướng đa năng 10 khay", "Tủ đông đứng 2 cánh", "Bếp chiên nhúng đôi", "Máy làm đá 150 kg/ngày"],
    "FBD": ["Thay bàn ghế nhà hàng tầng 1", "Quầy bar lobby lounge", "Hệ thống âm thanh ballroom", "Xe đẩy phục vụ tiệc", "Máy pha cà phê 2 group", "Bộ đồ ăn cao cấp phòng VIP"],
    "ENG": ["Thay chiller số 2", "Bọc bảo ôn đường ống nước lạnh", "Nâng cấp tủ điện tổng MSB", "Thay FCU tầng 8–12", "Bơm tăng áp nước sinh hoạt", "Hệ thống BMS giai đoạn 1"],
    "HKD": ["Thay nệm phòng khách 120 phòng", "Rèm cửa phòng tầng 15–19", "Thảm hành lang tầng khách", "Két sắt phòng khách", "Máy giặt công nghiệp 60 kg", "Xe đẩy dọn phòng"],
    "FOD": ["Quầy lễ tân mới", "Máy in thẻ từ", "Ghế sảnh chờ", "Tủ gửi hành lý"],
    "ITD": ["PABX, Wifi, IPTV", "Máy chủ lưu trữ NAS", "Camera an ninh bổ sung", "Thay switch mạng lõi"],
    "SEC": ["Cổng từ an ninh", "Camera khu vực kho gas", "Hệ thống kiểm soát ra vào"],
    "ADM": ["Máy photocopy đa năng", "Bàn ghế văn phòng nhân sự"],
    "SMD": ["Màn hình LED quảng cáo sảnh"],
    "CEN": ["Thay thang máy số 3 cao ốc", "Sơn lại mặt tiền cao ốc", "Cải tạo sảnh cao ốc"]}';
  for v_year in 2025 .. 2026 loop
    insert into pm_budget_year (year, fx_rate, reserve_pct, ssp_revenue, ssp_cap, cp_revenue, status, note)
    values (v_year, case when v_year = 2025 then 25500 else 26000 end, 3, 520000000000 + (v_year - 2025) * 35000000000,
            (520000000000 + (v_year - 2025) * 35000000000) * 0.03, 180000000000, 'approved', '[DEMO]');
    insert into pm_budget_round (year, label, round_date, is_final, source_file, line_count, total_value, imported_by)
    values (v_year, 'Master Data', make_date(v_year - 1, 11, 20), true, 'Capex Budget ' || v_year || ' [DEMO].xlsx', 0, 0, 'demo')
    returning id into v_round;
    k := 0;
    for v_dept in select jsonb_object_keys(v_names) loop
      j := 0;
      for t in select value #>> '{}' nm from jsonb_array_elements(v_names -> v_dept) loop
        j := j + 1; k := k + 1;
        if (v_year = 2025 and j % 2 = 0) then continue; end if;       -- 2025 ít dự án hơn
        v_pc  := format('FFE.%s.%s.%s', v_dept, lpad(j::text, 2, '0'), v_year);
        v_est := case when t.nm ~* 'chiller|thang máy|PABX|BMS|nệm|tủ điện|mặt tiền' then round((900 + random() * 5000)) * 1000000
                      else round((40 + random() * 700)) * 1000000 end;
        v_pos := 1 + floor(random() * 5); v_imp := 1 + floor(random() * 5); v_ass := v_pos * v_imp;
        v_risk := case when v_ass >= 20 then 'Critical' when v_ass >= 12 then 'High' when v_ass >= 6 then 'Medium' else 'Low' end;
        insert into pm_budget_line (round_id, line_no, project_code, category, dept_code, request_date, investment_type, reason, name, estimated_value, gm_approved,
                                    possibility, impact, assessment, risk_level, start_date, end_date, asset_item, rationale, quantity, unit_price, amount,
                                    m01, m02, m03, m04, m05, m06, m07, m08, m09, m10, m11, m12, note)
        values (v_round, k, v_pc, 'FFE', v_dept, make_date(v_year - 1, 10, 15), am_demo_pick(array['Replacement', 'Replacement', 'New', 'Upgrade']),
                am_demo_pick(array['Thiết bị cũ hư hỏng thường xuyên, chi phí sửa chữa cao', 'Hết tuổi thọ thiết kế', 'Nâng cấp theo tiêu chuẩn thương hiệu',
                                   'Đáp ứng yêu cầu an toàn / PCCC', 'Tiết kiệm năng lượng', 'Nâng cao trải nghiệm khách']),
                t.nm, v_est, v_est, v_pos, v_imp, v_ass, v_risk, make_date(v_year, 1 + (k % 9), 1), make_date(v_year, 3 + (k % 9), 28), t.nm,
                'Đề xuất của bộ phận ' || v_dept || ' [DEMO]', 1, v_est, v_est,
                case when k % 4 = 0 then v_est end, null, case when k % 4 = 1 then v_est end, null, null, case when k % 4 = 2 then v_est end, null, null,
                case when k % 4 = 3 then v_est end, null, null, null, '[DEMO]');
        -- Dự án: 2025 gần như xong; 2026 đủ mọi giai đoạn.
        v_req := make_date(v_year, 1 + (k % 6), 5 + (k % 20));
        v_app := null; v_pur := null; v_hand := null; v_cv := null; v_vend := null; v_vcode := null;
        if v_year = 2025 or k % 3 <> 0 then v_app := v_req + 20 + (k % 15); end if;
        if v_app is not null and (v_year = 2025 or k % 3 = 1) then
          v_pur := v_app + 25 + (k % 20); i := 1 + floor(random() * 60)::int; v_vend := v_vendors[i]; v_vcode := v_vcodes[i];
          v_cv := round(v_est * (0.78 + random() * 0.2) / 1000000) * 1000000;
        end if;
        if v_pur is not null and (v_year = 2025 or k % 2 = 0) then v_hand := v_pur + 30 + (k % 40); end if;
        if v_hand > current_date then v_hand := null; end if;
        if v_pur > current_date then v_pur := null; v_cv := null; v_vend := null; v_vcode := null; end if;
        insert into pm_project (code, main_code, year, dept_code, name, category, budgeted, investment_type, estimated_value, possibility, impact, assessment,
                                risk_level, asset_item, reason, rationale, planned_start, planned_end, request_date, approve_date, purchase_date, handover_date,
                                contract_value, chosen_vendor, vendor_code, source, comment)
        values (v_pc, v_pc, v_year, v_dept, t.nm, 'FFE', true, 'Replacement', v_est, v_pos, v_imp, v_ass, v_risk, t.nm,
                'Thiết bị hiện hữu xuống cấp [DEMO]', 'Theo kế hoạch ngân sách ' || v_year, make_date(v_year, 1 + (k % 9), 1), make_date(v_year, 3 + (k % 9), 28),
                v_req, v_app, v_pur, v_hand, v_cv, v_vend, v_vcode, 'budget', '[DEMO]');
      end loop;
    end loop;
    update pm_budget_round r set line_count = (select count(*) from pm_budget_line where round_id = r.id),
                                 total_value = coalesce((select sum(estimated_value) from pm_budget_line where round_id = r.id), 0)
    where id = v_round;
  end loop;
  -- Vài dự án ngoài ngân sách.
  insert into pm_project (code, main_code, year, dept_code, name, category, budgeted, investment_type, estimated_value, request_date, source, comment)
  values ('FFE.KIT.90.2026', 'FFE.KIT.90.2026', 2026, 'KIT', 'Thay máy hút khói bếp nóng (phát sinh)', 'FFE', false, 'Replacement', 185000000, current_date - 12, 'app', '[DEMO]'),
         ('FFE.ENG.91.2026', 'FFE.ENG.91.2026', 2026, 'ENG', 'Sửa chữa khẩn cấp bơm nước thải', 'FFE', false, 'Replacement', 96000000, current_date - 30, 'app', '[DEMO]'),
         ('FFE.HKD.92.2026', 'FFE.HKD.92.2026', 2026, 'HKD', 'Bổ sung giường phụ', 'FFE', false, 'New', 64000000, current_date - 5, 'app', '[DEMO]');

  ---------------------------------------------------------------- hoá đơn + thanh toán của dự án đã mua
  i := 0;
  for p in select * from pm_project where purchase_date is not null and contract_value is not null order by code loop
    i := i + 1;
    v_tax := coalesce((select tax_code from pm_vendor where code = p.vendor_code), '0300000' || lpad(i::text, 3, '0'));
    insert into pm_invoice (seller_tax, series, invoice_no, invoice_date, voucher_no, voucher_date, post_date, seller_name, net, vat, vat_rate, description, codes_found, alloc_mode)
    values (v_tax, 'C' || to_char(p.purchase_date, 'YY') || 'TAA', lpad((100 + i * 13)::text, 8, '0'), p.purchase_date + 5, 'MH' || lpad(i::text, 5, '0'),
            p.purchase_date + 6, p.purchase_date + 6, p.chosen_vendor, p.contract_value, round(p.contract_value * 0.08), '8%',
            p.name || ' — ' || p.code, array[p.code], 'manual')
    returning id into v_inv;
    insert into pm_pay_alloc (kind, ref_id, project_code, share) values ('invoice', v_inv, p.code, 1);
    -- Đặt cọc 30% lúc mua, phần còn lại khi đã bàn giao.
    insert into pm_payment (voucher_no, line_no, voucher_date, post_date, description, amount, vendor_code, vendor_name, reason, voucher_type, codes_found, alloc_mode)
    values ('UNC' || lpad((i * 2 - 1)::text, 5, '0'), 1, p.purchase_date + 8, p.purchase_date + 8, 'Đặt cọc 30% ' || p.code, round(p.contract_value * 1.08 * 0.3),
            p.vendor_code, p.chosen_vendor, 'Thanh toán nhà cung cấp', 'UNC', array[p.code], 'manual')
    returning id into v_pay;
    insert into pm_pay_alloc (kind, ref_id, project_code, share) values ('payment', v_pay, p.code, 1);
    if p.handover_date is not null then
      insert into pm_payment (voucher_no, line_no, voucher_date, post_date, description, amount, vendor_code, vendor_name, reason, voucher_type, codes_found, alloc_mode)
      values ('UNC' || lpad((i * 2)::text, 5, '0'), 1, p.handover_date + 15, p.handover_date + 15, 'Thanh toán 70% sau nghiệm thu ' || p.code,
              round(p.contract_value * 1.08 * 0.7), p.vendor_code, p.chosen_vendor, 'Thanh toán nhà cung cấp', 'UNC', array[p.code], 'manual')
      returning id into v_pay;
      insert into pm_pay_alloc (kind, ref_id, project_code, share) values ('payment', v_pay, p.code, 1);
    end if;
  end loop;

  ---------------------------------------------------------------- CSDL giá: báo giá 2024–2026
  for i in 1 .. 36 loop
    j := 1 + floor(random() * 60)::int;
    insert into pr_source (kind, ref, supplier, contact, quote_date, project_code, currency, fx_rate, vat_included, won, delivery_term, payment_term, note)
    values ('quote', 'BG-DEMO-' || lpad(i::text, 3, '0'), v_vendors[j], 'sales' || j || '@vendor-demo.test',
            current_date - (30 + floor(random() * 800))::int, (select code from pm_project order by random() limit 1), 'VND', 1, false,
            case when i % 3 = 0 then true when i % 3 = 1 then false end, am_demo_pick(array['2–4 tuần', '4–6 tuần', 'Có sẵn', '8–10 tuần (nhập khẩu)']),
            am_demo_pick(array['30% đặt cọc, 70% sau nghiệm thu', '50/50', 'Thanh toán 100% sau bàn giao', '30/60/10 (giữ 10% bảo hành)']), '[DEMO]')
    returning id into v_src;
    insert into pr_line (source_id, line_no, section, name_raw, brand, model, qty, unit_raw, unit_price, labor_price, vat_rate)
    select v_src, row_number() over (), null,
           split_part(t2.std_vi, '/', 1) || ' ' || am_demo_pick(array['', 'loại A', 'DN50', '600x600', '2 cánh', 'inox 304', 'công suất lớn', '']),
           am_demo_pick(v_brands), upper(substr(md5(random()::text), 1, 5)), 1 + floor(random() * 20),
           am_demo_pick(array['cái', 'bộ', 'm2', 'm', 'cái', 'bộ', 'lô']),
           round((case t2.grp when 'HVAC' then 2000000 + random() * 78000000 when 'KIT' then 5000000 + random() * 115000000
                             when 'ICT' then 1000000 + random() * 39000000 when 'FUR' then 1000000 + random() * 29000000
                             when 'SAN' then 1000000 + random() * 19000000 when 'SRV' then 500000 + random() * 49500000
                             else 100000 + random() * 9900000 end) / 1000) * 1000,
           case when random() < 0.3 then round(random() * 2000) * 1000 end, 0.08
    from  (select std_vi, grp from pr_term where active and kind in ('goods', 'service') order by random() limit (5 + floor(random() * 7))::int) t2;
  end loop;
  perform pr_refresh_lines(null);

  ---------------------------------------------------------------- hợp đồng
  for p in select * from pm_project where purchase_date is not null and contract_value >= 30000000 order by purchase_date loop
    insert into pm_contract (no, contract_no, title, kind, scope, entity, dept_code, project_code, vendor_code, supplier, supplier_tax, signed_date, start_date,
                             end_date, delivery_due, delivery_text, currency, value_pre_vat, vat_pct, value_total, pay_terms, warranty_months, warranty_start,
                             handover_date, warranty_until, bonds, penalty_text, status, source, terms_src, created_by, created_name, approved_at)
    values ('HD-' || extract(year from p.purchase_date)::int || '-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'),
            'SO' || lpad((800 + (random() * 199)::int)::text, 6, '0') || '/' || to_char(p.purchase_date, 'YY') || '/HĐ-MB/PH', 'Hợp đồng ' || lower(p.name),
            case when p.name ~* 'bọc|sơn|cải tạo|nâng cấp' then 'works' else 'supply' end, 'capex', case when p.dept_code = 'CEN' then 'CP' else 'SSP' end,
            p.dept_code, p.code, p.vendor_code, p.chosen_vendor, (select tax_code from pm_vendor where code = p.vendor_code), p.purchase_date, p.purchase_date,
            case when p.handover_date is null then p.purchase_date + 150 end, p.purchase_date + 110, '16–18 tuần sau khi ký và nhận thanh toán đợt 1',
            'VND', p.contract_value, 8, round(p.contract_value * 1.08),
            case when p.contract_value >= 1000000000
                 then '[{"milestone": "Deposit", "pct": 30, "condition": "10 ngày làm việc sau khi ký"}, {"milestone": "Progress", "pct": 60, "condition": "Sau khi giao hàng"}, {"milestone": "Retention", "pct": 10, "condition": "Hết thời hạn bảo hành"}]'::jsonb
                 else '[{"milestone": "Deposit", "pct": 30, "condition": "10 ngày làm việc sau khi ký"}, {"milestone": "Handover", "pct": 70, "condition": "15 ngày làm việc sau nghiệm thu"}]'::jsonb end,
            case when p.contract_value >= 1000000000 then 24 else 12 end, 'delivery', p.handover_date,
            case when p.handover_date is not null then (p.handover_date + make_interval(months => case when p.contract_value >= 1000000000 then 24 else 12 end))::date end,
            case when p.contract_value >= 500000000 then jsonb_build_array(jsonb_build_object('kind', 'performance', 'pct', 10,
                   'expiry', (current_date + (20 + floor(random() * 200))::int)::text, 'issuer', 'Vietcombank CN Sài Gòn')) else '[]'::jsonb end,
            'Chậm giao: phạt 0,05%/ngày giá trị hàng giao chậm, tối đa 8%', case when p.handover_date is not null then 'completed' else 'active' end,
            'app', 'manual', v_amx, am_demo_nm('demo.amx@plaza-demo.test'), p.purchase_date - 3);
  end loop;
  -- Hợp đồng dịch vụ / bảo trì hằng năm (một số sắp hết hạn để có nhắc hạn).
  insert into pm_contract (no, contract_no, title, kind, scope, entity, dept_code, vendor_code, supplier, signed_date, start_date, end_date, currency,
                           value_pre_vat, vat_pct, value_total, pay_terms, notice_days, auto_renew, status, source, terms_src, created_by, created_name, summary)
  values
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'BT-TM/2026/01', 'Bảo trì thang máy khách sạn 2026', 'maintenance', 'opex', 'SSP', 'ENG', v_vcodes[6], v_vendors[6],
     make_date(2026, 1, 2), make_date(2026, 1, 1), current_date + 45, 'VND', 480000000, 8, 518400000, '[{"milestone": "Progress", "pct": 25, "condition": "Hằng quý"}]', 30, false, 'active', 'app', 'manual', v_amx, am_demo_nm('demo.amx@plaza-demo.test'), 'Bảo trì định kỳ 12 thang máy, cứu hộ 24/7 [DEMO]'),
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'XLNT/2026', 'Vận hành hệ thống xử lý nước thải', 'maintenance', 'opex', 'SSP', 'ENG', v_vcodes[9], v_vendors[9],
     make_date(2026, 3, 1), make_date(2026, 3, 1), make_date(2027, 2, 28), 'VND', 360000000, 8, 388800000, '[{"milestone": "Progress", "pct": 8.33, "condition": "Hằng tháng"}]', 60, true, 'active', 'app', 'manual', v_amx, am_demo_nm('demo.amx@plaza-demo.test'), 'Vận hành, lấy mẫu quan trắc định kỳ [DEMO]'),
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'PCCC-BT/2026', 'Bảo trì hệ thống PCCC', 'maintenance', 'opex', 'SSP', 'ENG', v_vcodes[7], v_vendors[7],
     make_date(2025, 10, 1), make_date(2025, 10, 1), current_date + 12, 'VND', 210000000, 8, 226800000, '[]', 30, false, 'active', 'app', 'manual', v_amx, am_demo_nm('demo.amx@plaza-demo.test'), 'Kiểm tra, bảo dưỡng bình chữa cháy, sprinkler, báo cháy [DEMO]'),
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'VS-CT/2026', 'Kiểm soát côn trùng cao ốc', 'service', 'opex', 'CP', 'CEN', v_vcodes[29], v_vendors[29],
     make_date(2026, 1, 15), make_date(2026, 1, 15), make_date(2027, 1, 14), 'VND', 96000000, 8, 103680000, '[]', 30, true, 'active', 'app', 'manual', v_amx, am_demo_nm('demo.amx@plaza-demo.test'), null);
  -- Hai hợp đồng đang chờ duyệt: một dưới hạn mức khách sạn, một vượt hạn mức (qua Pháp chế + JVC).
  for i in 1 .. 2 loop
    v_c := null;
    insert into pm_contract (no, contract_no, title, kind, scope, entity, dept_code, project_code, vendor_code, supplier, currency, value_pre_vat, vat_pct, value_total,
                             pay_terms, warranty_months, status, source, created_by, created_name, submitted_at)
    select 'HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), null, 'Hợp đồng ' || lower(pp.name), 'supply', 'capex', 'SSP', pp.dept_code, pp.code, v_vcodes[10 + i], v_vendors[10 + i],
           'VND', case when i = 1 then 245000000 else 1850000000 end, 8, case when i = 1 then 264600000 else 1998000000 end,
           '[{"milestone": "Deposit", "pct": 30}, {"milestone": "Handover", "pct": 70}]', 12, 'review', 'app', v_amx, am_demo_nm('demo.amx@plaza-demo.test'), now() - interval '1 day'
    from pm_project pp where pp.year = 2026 and pp.approve_date is not null and pp.purchase_date is null and pp.dept_code in ('KIT', 'ENG') order by pp.code offset i - 1 limit 1
    returning * into v_c;
    if v_c.id is not null then
      update pm_contract set route = pm_ct_steps(v_c), cur = 0, needs_legal = exists (select 1 from jsonb_array_elements(pm_ct_steps(v_c)) x where x ->> 'side' = 'legal')
      where id = v_c.id;
    end if;
  end loop;

  ---------------------------------------------------------------- họp dự án
  for p in select * from pm_project where year = 2026 and approve_date is not null order by code limit 6 loop
    insert into pm_mt_topic (title_vi, title_en, project_code, status, sort, source, created_name)
    values (p.name, null, p.code, 'open', (select coalesce(max(sort), 0) + 10 from pm_mt_topic), 'app', am_demo_nm('demo.amc@plaza-demo.test'));
  end loop;
  insert into pm_mt_topic (title_vi, title_en, status, sort, source, created_name)
  values ('Kế hoạch Capex 2027', 'Capex plan 2027', 'open', 900, 'app', am_demo_nm('demo.amc@plaza-demo.test'));
  for i in 0 .. 5 loop
    v_d := current_date - (70 - i * 14);
    insert into pm_mt_meeting (no, meeting_date, title_vi, title_en, place, attendees, status, issued_at, issued_name, source, created_name)
    values ('MT-' || to_char(v_d, 'YYMMDD'), v_d, 'Họp định kỳ dự án Capex', 'Capex projects progress meeting', 'Phòng họp tầng 3',
            jsonb_build_array(jsonb_build_object('side', 'owner', 'name', am_demo_nm('demo.amc@plaza-demo.test'), 'user_id', v_amc),
                              jsonb_build_object('side', 'owner', 'name', am_demo_nm('demo.amx@plaza-demo.test'), 'user_id', v_amx),
                              jsonb_build_object('side', 'operator', 'name', am_demo_nm('demo.gm@plaza-demo.test'), 'position', 'GM', 'user_id', am_demo_uid('demo.gm@plaza-demo.test')),
                              jsonb_build_object('side', 'operator', 'name', am_demo_nm('demo.enghead@plaza-demo.test'), 'position', 'DOE', 'user_id', am_demo_uid('demo.enghead@plaza-demo.test'))),
            case when i = 5 then 'draft' else 'issued' end, case when i < 5 then v_d + 1 end, case when i < 5 then am_demo_nm('demo.amc@plaza-demo.test') end,
            'app', am_demo_nm('demo.amc@plaza-demo.test'))
    returning id into v_meet;
    if i = 5 then continue; end if;                       -- cuộc họp sắp tới: nháp, chưa ghi
    for t in select * from pm_mt_topic order by sort loop
      if random() < 0.25 then continue; end if;
      insert into pm_mt_entry (meeting_id, topic_id, stage_vi, progress_vi, progress_en, discussion_vi, discussion_en, decision_vi, decision_en, sort, updated_name)
      values (v_meet, t.id, am_demo_pick(array['Thiết kế', 'Đấu thầu', 'Thi công', 'Nghiệm thu', 'Chuẩn bị hồ sơ']),
              am_demo_pick(array['Đã nhận đủ 3 báo giá', 'Đang thẩm định BOQ', 'Nhà thầu đã khảo sát hiện trạng', 'Hàng đang nhập khẩu, dự kiến về tuần sau', 'Đã lắp đặt 60%']),
              am_demo_pick(array['3 quotations received', 'BOQ under review', 'Contractor surveyed the site', 'Goods being imported, due next week', '60% installed']),
              am_demo_pick(array['Cần cân đối lại ngân sách vì giá thiết bị tăng.', 'Operator đề xuất thi công ngoài giờ để không ảnh hưởng khách.', 'Thống nhất phương án kỹ thuật như đề xuất.', 'Yêu cầu nhà thầu trình tiến độ chi tiết theo tuần.']),
              am_demo_pick(array['Budget to be rebalanced due to higher equipment prices.', 'Operator proposes off-hours works to avoid guest impact.', 'Technical option agreed as proposed.', 'Contractor to submit a weekly detailed schedule.']),
              case when random() < 0.5 then am_demo_pick(array['Chốt nhà cung cấp trước ngày 15', 'Duyệt ngân sách điều chỉnh', 'Triển khai thử 1 tầng trước']) end,
              null, 10, am_demo_nm('demo.amc@plaza-demo.test'))
      returning id into v_entry;
      insert into pm_mt_action (meeting_id, topic_id, entry_id, text_vi, pic_user, pic_name, due_date, status, done_at, done_name, closed_meeting_id)
      values (v_meet, t.id, v_entry, am_demo_pick(array['Gửi lại BOQ đã điều chỉnh', 'Làm việc với nhà cung cấp về giá chiết khấu', 'Trình hồ sơ đề xuất (PR)', 'Lập kế hoạch thi công chi tiết']),
              case when random() < 0.5 then am_demo_uid('demo.enghead@plaza-demo.test') else v_amx end,
              case when random() < 0.5 then am_demo_nm('demo.enghead@plaza-demo.test') else am_demo_nm('demo.amx@plaza-demo.test') end,
              v_d + 10, case when i < 3 then 'done' else 'open' end, case when i < 3 then (v_d + 12)::timestamptz end,
              case when i < 3 then am_demo_nm('demo.amx@plaza-demo.test') end, null);
    end loop;
  end loop;

  ---------------------------------------------------------------- điều chuyển, sự cố
  for i in 1 .. 6 loop
    insert into am_transfer (no, from_dept, to_dept, to_location, reason, tf_date, status, steps, cur, created_name, created_at, submitted_at, done_at)
    values (format('TF.%s.%s.2026', (array['FBD','KIT','HKD','ENG','FOD','ADM'])[i], lpad(i::text, 3, '0')), (array['FBD','KIT','HKD','ENG','FOD','ADM'])[i],
            (array['KIT','FBD','FBD','CEN','ADM','FOD'])[i], null, 'Điều chuyển phục vụ vận hành [DEMO]', current_date - (100 - i * 12), 'done',
            jsonb_build_array(jsonb_build_object('key', 'from', 'action', 'approve', 'name', 'Trưởng bộ phận giao'), jsonb_build_object('key', 'to', 'action', 'approve', 'name', 'Trưởng bộ phận nhận'), jsonb_build_object('key', 'am', 'action', 'approve', 'name', am_demo_nm('demo.amx@plaza-demo.test'))),
            null, am_demo_nm('demo.staff@plaza-demo.test'), now() - make_interval(days => 100 - i * 12), now() - make_interval(days => 100 - i * 12), now() - make_interval(days => 98 - i * 12))
    returning id into v_tf;
    insert into am_transfer_line (transfer_id, asset_id, old_code, new_code)
    select v_tf, id, asset_code, asset_code from am_asset where dept_code = (array['FBD','KIT','HKD','ENG','FOD','ADM'])[i] and asset_kind = 'unique' order by random() limit 2;
  end loop;
  -- Một phiếu đang chờ duyệt (Bếp → F&B) để thử chuỗi duyệt.
  insert into am_transfer (no, from_dept, to_dept, reason, tf_date, status, steps, cur, created_by, created_name, submitted_at)
  values ('TF.KIT.007.2026', 'KIT', 'FBD', 'Chuyển tủ mát sang quầy bar [DEMO]', current_date - 1, 'pending', am_tf_steps('KIT', 'FBD'), 0,
          am_demo_uid('demo.staff@plaza-demo.test'), am_demo_nm('demo.staff@plaza-demo.test'), now() - interval '1 day')
  returning id into v_tf;
  insert into am_transfer_line (transfer_id, asset_id) select v_tf, id from am_asset where dept_code = 'KIT' and asset_kind = 'unique' order by random() limit 1;

  i := 0;
  for a in select * from am_asset where asset_kind = 'unique' order by random() limit 28 loop
    i := i + 1;
    insert into am_incident (no, asset_id, dept_code, kind, status, reported_at, description, cause, wo_no, vendor, warranty, cost, outcome, prev_status,
                             created_name, created_at, started_at, closed_at, closed_name)
    values ('SC.2026.' || lpad(i::text, 5, '0'), a.id, a.dept_code, am_demo_pick(array['repair', 'repair', 'repair', 'maintenance', 'breakage', 'loss']),
            case when i % 4 = 0 then 'open' when i % 4 = 1 then 'in_progress' else 'closed' end, current_date - (5 + i * 9),
            am_demo_pick(array['Máy không lên nguồn', 'Rò nước', 'Tiếng ồn bất thường', 'Vỡ mặt kính', 'Bảo dưỡng định kỳ', 'Không tìm thấy khi kiểm tra']),
            am_demo_pick(array['Hao mòn tự nhiên', 'Sử dụng sai cách', 'Chập điện', null]), 'WO-' || lpad((5000 + i)::text, 6, '0'), am_demo_pick(v_vendors),
            random() < 0.3, case when i % 4 >= 2 then round((1 + random() * 25)) * 1000000 end,
            case when i % 4 >= 2 then am_demo_pick(array['fixed', 'fixed', 'fixed', 'no_fault', 'replace']) end, '1',
            am_demo_nm('demo.staff@plaza-demo.test'), now() - make_interval(days => 5 + i * 9), case when i % 4 <> 0 then now() - make_interval(days => 4 + i * 9) end,
            case when i % 4 >= 2 then now() - make_interval(days => 1 + i * 9) end, case when i % 4 >= 2 then am_demo_nm('demo.enghead@plaza-demo.test') end);
  end loop;

  ---------------------------------------------------------------- kiểm kê: một đợt đã đóng (Buồng), một đợt đang mở (Bếp)
  insert into am_count (code, title, depts, count_date, status, members, created_name, opened_at, closed_at, closed_name)
  values ('KK.2026.01', 'Kiểm kê giữa năm — Buồng', array['HKD'], current_date - 60, 'closed',
          jsonb_build_array(jsonb_build_object('name', am_demo_nm('demo.hkhead@plaza-demo.test'), 'position', 'Trưởng Buồng'), jsonb_build_object('name', am_demo_nm('demo.amx@plaza-demo.test'), 'position', 'AM Executive')), am_demo_nm('demo.amx@plaza-demo.test'),
          now() - interval '62 days', now() - interval '58 days', am_demo_nm('demo.amx@plaza-demo.test'))
  returning id into v_cid;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book, group_code, category_code,
                             found, qty_found, loc_found, cond, by_name, at)
  select v_cid, id, barcode, asset_code, concat_ws(' / ', name_vi, name_en), asset_kind, dept_code, location_code, qty, status_code, group_code, category_code,
         r < 0.96, case when r < 0.96 then qty else 0 end, case when r < 0.96 then location_code end,
         case when r < 0.96 then (case when r < 0.9 then 'good' when r < 0.94 then 'poor' else 'damaged' end) end, am_demo_nm('demo.amx@plaza-demo.test'), now() - interval '59 days'
  from (select *, random() r from am_asset where dept_code = 'HKD') x;
  update am_count set summary = (select jsonb_build_object('total', count(*), 'found', count(*) filter (where cl.found), 'missing', count(*) filter (where not cl.found),
                                                          'damaged', count(*) filter (where cl.cond = 'damaged'), 'extra', 0, 'moved', 0, 'short', 0,
                                                          'applied', jsonb_build_object('moved', 0, 'lost', 0, 'damaged', 0))
                                 from am_count_line cl where cl.count_id = v_cid)
  where id = v_cid;
  insert into am_count (code, title, depts, count_date, status, members, created_name, opened_at)
  values ('KK.2026.02', 'Kiểm kê định kỳ Q3 — Bếp', array['KIT'], current_date, 'open', jsonb_build_array(jsonb_build_object('name', am_demo_nm('demo.kithead@plaza-demo.test'), 'position', 'Bếp trưởng')),
          am_demo_nm('demo.amx@plaza-demo.test'), now() - interval '2 hours')
  returning id into v_cid;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book, group_code, category_code,
                             found, qty_found, loc_found, cond, by_name, at)
  select v_cid, id, barcode, asset_code, concat_ws(' / ', name_vi, name_en), asset_kind, dept_code, location_code, qty, status_code, group_code, category_code,
         case when r < 0.4 then true when r < 0.43 then false end, case when r < 0.4 then qty when r < 0.43 then 0 end, case when r < 0.4 then location_code end,
         case when r < 0.4 then 'good' end, case when r < 0.43 then am_demo_nm('demo.staff@plaza-demo.test') end, case when r < 0.43 then now() - make_interval(mins => (r * 100)::int) end
  from (select *, random() r from am_asset where dept_code = 'KIT') x;

  v_n := am_demo_eng();   -- hệ thống kỹ thuật & checklist ca

  select jsonb_build_object('checklist_runs', v_n,'vendors', (select count(*) from pm_vendor), 'assets', (select count(*) from am_asset), 'projects', (select count(*) from pm_project),
                            'budget_lines', (select count(*) from pm_budget_line), 'invoices', (select count(*) from pm_invoice), 'payments', (select count(*) from pm_payment),
                            'price_lines', (select count(*) from pr_line), 'contracts', (select count(*) from pm_contract), 'meetings', (select count(*) from pm_mt_meeting),
                            'actions', (select count(*) from pm_mt_action), 'transfers', (select count(*) from am_transfer), 'incidents', (select count(*) from am_incident),
                            'count_lines', (select count(*) from am_count_line))
    into v_out;
  -- Dự án mẫu đi hết quy trình (3b), cuối cùng: dùng chính dữ liệu vừa sinh. Lỗi ở đây (vd chuỗi duyệt đã bị sửa)
  -- không làm hỏng cả lần làm mới: phần của dự án mẫu được huỷ, kết quả nói lý do.
  begin
    v_out := v_out || am_demo_sample();
  exception when others then
    v_out := v_out || jsonb_build_object('sample_project', 'lỗi / error: ' || sqlerrm);   -- the "act as" settings roll back with it
  end;
  return v_out;
end $$;

-- =====================================================================
-- 3b. DỰ ÁN MẪU ĐẦY ĐỦ (user 14/10/2026)
--     Một dự án Bếp (FFE.KIT.07.2026) đi trọn quy trình bằng CHÍNH các hàm của app, mỗi bước do đúng
--     người demo làm (am_demo_as): PR + RR + PA → gọi báo giá, 3 nhà cung cấp nộp → QC + MC → PO → CT
--     (hợp đồng) → đề nghị thanh toán đợt 1 → nhập tài sản, AL → nhận hàng, ảnh → AH cuối → ghi sổ kế
--     toán → quyết toán → LR các tài sản cũ → đợt thanh lý tới khi đóng. Để XEM các phiếu đã điền đủ;
--     muốn thử cơ chế duyệt thì lập dự án khác. Ngày giờ được lùi về theo kế hoạch (am_demo_tick), nên
--     lịch sử trông như đã diễn ra trong ~5 tháng. Chữ ký tay và tệp mẫu (PDF, ảnh) do Công cụ quản trị
--     vẽ / tải lên sau (demo.js: am_demo_sample_finish, am_demo_sample_files).
-- =====================================================================

-- Chữ ký tạm (ảnh 1×1) khi chạy: được thay bằng chữ ký vẽ tay ở bước hoàn thiện; nhờ nó, mẫu chạy được cả
-- khi project bật "bắt buộc ký" (pm_require_signature).
create or replace function am_demo_sig0()
returns jsonb language sql immutable as $$
  select '{"png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}'::jsonb
$$;

-- Làm các bước tiếp theo với tư cách một người demo: auth.uid() / app_claims() của server là người đó,
-- nên mọi kiểm tra quyền của app áp dụng như khi người đó bấm.
create or replace function am_demo_as(p_email text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid := am_demo_uid(p_email);
begin
  if v is null then raise exception 'Dự án mẫu: chưa có tài khoản demo %.', p_email; end if;
  perform set_config('request.jwt.claim.sub', v::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v, 'email', p_email, 'role', 'authenticated')::text, true);
  return v;
end $$;

-- Người demo đứng ở một vai trò (dự án mẫu thuộc Bếp).
create or replace function am_demo_role_mail(p_role text)
returns text language sql immutable as $$
  select case p_role when 'DEPT_STAFF' then 'demo.staff' when 'DEPT_HEAD' then 'demo.kithead' when 'DOF' then 'demo.dof' when 'HOTEL_GM' then 'demo.gm'
                     when 'AM_COORD' then 'demo.amc' when 'AM_EXEC' then 'demo.amx' when 'CHIEF_ACC' then 'demo.chiefacc' when 'JVC_GM' then 'demo.jvcgm'
                     when 'PURCHASING' then 'demo.purchasing' when 'HOTEL_AM' then 'demo.hotelam' when 'ACCOUNTANT' then 'demo.accountant'
                     when 'LEGAL' then 'demo.legal' when 'CP_HEAD' then 'demo.cphead' else 'demo.admin' end || '@plaza-demo.test'
$$;

-- Thời điểm "n ngày trước, h giờ" (giờ Việt Nam).
create or replace function am_demo_at(p_days int, p_hour numeric default 9)
returns timestamptz language sql stable as $$
  select ((current_date - p_days)::timestamp + make_interval(secs => p_hour * 3600)) at time zone 'Asia/Ho_Chi_Minh'
$$;

/* Đồng hồ của dự án mẫu: mọi hàm ghi now() (cùng một giá trị trong cả lần chạy), nên sau mỗi bước, các
   dấu thời gian còn bằng now() của dự án mẫu được đặt về thời điểm đã định của bước đó. Thông báo do các
   bước sinh ra được đánh dấu đã đọc (lịch sử, không làm đầy chuông). */
create or replace function am_demo_tick(p_t timestamptz, p_project text, p_nmark bigint)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select c.table_name t, c.column_name c from information_schema.columns c
           where c.table_schema = 'public' and c.data_type = 'timestamp with time zone' and c.column_name not in ('expires_at', 'deadline', 'call_deadline')
             and c.table_name = any (array['pm_pkg', 'pm_pkg_step', 'pm_pkg_event', 'pm_doc', 'pm_doc_event', 'pm_doc_step', 'pm_tender', 'pm_tender_invitee',
                                           'pm_tender_bid', 'pm_tender_consent', 'pm_tender_event', 'pm_payreq', 'pm_lq_batch', 'pm_lq_item', 'pm_lq_sign',
                                           'pm_lq_quote', 'pm_lq_buyer', 'pm_lq_event', 'am_recv', 'am_shipment', 'am_alr', 'am_asset_photo', 'pm_contract_file',
                                           'pm_vendor_score', 'pm_po_send']) loop
    execute format('update %I set %I = $1 where %I = $2', r.t, r.c, r.c) using p_t, now();
  end loop;
  -- Times kept inside records too (a request's step history, the "uploaded at" of files…).
  for r in select c.table_name t, c.column_name c from information_schema.columns c
           where c.table_schema = 'public' and c.data_type = 'jsonb'
             and c.table_name = any (array['pm_payreq', 'pm_lq_batch', 'pm_tender', 'pm_tender_bid', 'pm_lq_quote', 'pm_contract', 'pm_doc']) loop
    execute format('update %I set %I = replace(%I::text, $1, $2)::jsonb where strpos(%I::text, $1) > 0', r.t, r.c, r.c, r.c)
      using to_jsonb(now()) #>> '{}', to_jsonb(p_t) #>> '{}';
  end loop;
  for r in select c.column_name c from information_schema.columns c
           where c.table_schema = 'public' and c.table_name = 'pm_contract' and c.data_type = 'timestamp with time zone' loop
    execute format('update pm_contract set %I = $1 where %I = $2 and project_code = $3', r.c, r.c) using p_t, now(), p_project;
  end loop;
  update pm_notice set created_at = p_t, read_at = p_t + interval '2 hours' where id > p_nmark and created_at = now();
end $$;

-- Một gói hồ sơ qua hết chuỗi duyệt, mỗi bước đúng người ký; ở bước AM soạn (owner_prep) thì lập phiếu của AM (PA / MC).
create or replace function am_demo_drive(p_pkg bigint, p_days int, p_project text, p_nmark bigint, p_owner text default null, p_owner_data jsonb default null)
returns text language plpgsql security definer set search_path = public as $$
declare k pm_pkg; s pm_pkg_step; i int := 0;
begin
  loop
    select * into k from pm_pkg where id = p_pkg;
    exit when k.status <> 'in_review' or i > 14;
    select * into s from pm_pkg_step where pkg_id = p_pkg and step = k.current_step;
    perform am_demo_as(am_demo_role_mail(s.role_code));
    if s.owner_prep and p_owner is not null
       and not exists (select 1 from pm_doc where pkg_id = p_pkg and doc_type = p_owner and status not in ('rejected', 'cancelled')) then
      perform pm_doc_create(k.project_code, p_owner, p_owner_data);
    end if;
    perform pm_pkg_act(p_pkg, 'approve', null, am_demo_sig0(), null);
    perform am_demo_tick(am_demo_at(p_days - i / 2, 9 + (i % 2) * 5), p_project, p_nmark);
    i := i + 1;
  end loop;
  select * into k from pm_pkg where id = p_pkg;
  if k.status <> 'approved' then raise exception 'Dự án mẫu: gói % (%) dừng ở "%".', p_pkg, k.grp, k.status; end if;
  return k.status;
end $$;

/* Ký hết bước hiện tại của đợt thanh lý, mỗi ô đúng người. Khi chạy từ SQL Editor (tin cậy), một lần ký
   ký luôn mọi ô của lượt; nên cuối cùng mỗi ô ghi lại đúng tên người của ô đó. */
create or replace function am_demo_lq_sign(p_batch bigint, p_days int, p_project text, p_nmark bigint)
returns text language plpgsql security definer set search_path = public as $$
declare v_st text := (select status from pm_lq_batch where id = p_batch); v_now text; x record; i int := 0;
begin
  loop
    select status into v_now from pm_lq_batch where id = p_batch;
    exit when v_now <> v_st or i > 12;
    select * into x from pm_lq_pending(p_batch) limit 1;
    exit when x.slot is null;
    perform am_demo_as(coalesce((select email from app_user where id = x.uid), am_demo_role_mail(x.roles[1])));
    perform pm_lq_act(p_batch, 'approve', null, am_demo_sig0());
    perform am_demo_tick(am_demo_at(p_days - i / 3, 9 + (i % 3) * 2), p_project, p_nmark);
    i := i + 1;
  end loop;
  select status into v_now from pm_lq_batch where id = p_batch;
  if v_now = v_st then raise exception 'Dự án mẫu: đợt thanh lý dừng ở "%".', v_st; end if;
  update pm_lq_sign g set user_id = m.user_id, name = m.full_name
    from pm_lq_member m where g.batch_id = p_batch and g.slot = 'M' || m.id and g.user_id is distinct from m.user_id;
  update pm_lq_sign g set user_id = m.user_id, name = m.full_name
    from pm_lq_batch b join pm_lq_member m on m.council_id = b.council_id and m.role = 'chair'
   where b.id = p_batch and g.batch_id = p_batch and g.slot = 'CHAIR';
  update pm_lq_sign g set user_id = am_demo_uid(am_demo_role_mail(v.r)), name = am_demo_nm(am_demo_role_mail(v.r))
    from (values ('DOF', 'DOF'), ('HOTEL_GM', 'HOTEL_GM'), ('AM_COORD', 'AM_COORD'), ('AM_EXEC', 'AM_EXEC'), ('AM', 'AM_EXEC'),
                 ('ACCOUNTANT', 'ACCOUNTANT'), ('CHIEF_ACC', 'CHIEF_ACC')) v(slot, r)
   where g.batch_id = p_batch and g.slot = v.slot;
  return v_now;
end $$;

create or replace function am_demo_sample()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  c_sc     constant text := 'FFE.KIT.07.2026';
  c_loc    constant text := 'S0203B2';               -- Mezz hot kitchen
  v_claims text := current_setting('request.jwt.claims', true);
  v_sub    text := current_setting('request.jwt.claim.sub', true);
  v_nm     bigint := coalesce((select max(id) from pm_notice), 0);
  v_sig    jsonb := am_demo_sig0();
  p1 record; p2 record; p3 record;                    -- bàn lạnh, tủ lạnh, chảo (danh mục thật)
  v_vn text[]; v_vc text[]; v_vt text[];              -- 3 nhà cung cấp: tên, mã, MST
  -- Báo giá: đơn giá 3 mặt hàng + vận chuyển & lắp đặt, theo nhà cung cấp A (chọn), B, C.
  v_u1 numeric[] := array[58500000, 61000000, 63500000];
  v_u2 numeric[] := array[32000000, 33500000, 31000000];
  v_u3 numeric[] := array[850000, 950000, 900000];
  v_oh numeric[] := array[4500000, 5000000, 6000000];
  v_br text[] := array['Electrolux', 'Berjaya', 'Turbo Air'];
  v_la text[] := array['Vốn điều lệ/Capital', 'SL hợp đồng tương tự/Similar contract', 'Giá trị hợp đồng tương tự/Similar contract value', 'Năng lực thiết bị/Equipment', 'Uy tín/Rating'];
  v_lt text[] := array['Tiến độ nhập hàng/Progress', 'Điều khoản lắp đặt/Installation term', 'Bảo hành/Warranty', 'Bảo trì/Maintenance',
                       'Yếu tố bền vững/Sustainability', 'Chứng nhận CO, CQ/CO, CQ', 'Dịch vụ hậu mãi/After-sales service'];
  v_sa int[] := array[[90, 85, 85, 90, 90], [85, 85, 80, 85, 85], [80, 80, 80, 80, 80]];
  v_st int[] := array[[90, 90, 95, 90, 85, 95, 90], [85, 90, 85, 85, 85, 85, 85], [80, 85, 90, 80, 85, 85, 80]];
  v_tot numeric[] := array[[88, 90.72, 100, 98, 92.62], [84, 85.71, 95.23, 93.18, 87.38], [80, 83.57, 93.65, 90.92, 85.43]];
  v_pay int[] := array[90, 85, 80];
  v_amt numeric[]; v_sub1 numeric; v_total numeric; v_vat numeric;
  v_old bigint[] := '{}'; v_oldc text[] := '{}'; v_new bigint[] := '{}'; v_seq int; v_bc bigint; v_round bigint;
  v_pr bigint; v_rr bigint; v_pkg bigint; v_qc bigint; v_po bigint; v_ct bigint; v_al bigint; v_ah bigint; v_lr bigint; v_lrpkg bigint;
  v_tid bigint; v_tok text[] := '{}'; v_key text; v_ship bigint; v_cid bigint; v_pq bigint; v_council bigint; v_b bigint;
  v_items bigint[]; v_btok text[] := '{}'; v_recv bigint[]; v_ph bigint; v_line bigint;
  v_lines jsonb; v_vend jsonb := '[]'; v_specx jsonb; v_data jsonb; x record; k int; v_alno text; v_inv text;
begin
  perform am_demo_guard();
  if exists (select 1 from pm_project where code = c_sc) then return jsonb_build_object('sample_project', c_sc || ' (đã có)'); end if;
  select pr.std_name_vi || '/' || pr.std_name_en lab, pr.std_name_vi vi, pr.std_name_en en, c.code cat, c.group_code grp, c.label_letters let into p1
    from am_product pr join am_category c on c.code = pr.default_category where pr.std_name_vi = 'Bàn lạnh' and c.active limit 1;
  select pr.std_name_vi || '/' || pr.std_name_en lab, pr.std_name_vi vi, pr.std_name_en en, c.code cat, c.group_code grp, c.label_letters let into p2
    from am_product pr join am_category c on c.code = pr.default_category where pr.std_name_vi = 'Tủ lạnh' and c.active limit 1;
  select pr.std_name_vi || '/' || pr.std_name_en lab, pr.std_name_vi vi, pr.std_name_en en, c.code cat, c.group_code grp, c.label_letters let into p3
    from am_product pr join am_category c on c.code = pr.default_category where pr.std_name_vi = 'Chảo' and c.active limit 1;
  if p1.lab is null or p2.lab is null or p3.lab is null or not exists (select 1 from am_location where code = c_loc) then
    return jsonb_build_object('sample_project', 'bỏ qua: danh mục thiếu Bàn lạnh / Tủ lạnh / Chảo hoặc vị trí ' || c_loc);
  end if;
  select array_agg(name order by ord), array_agg(code order by ord), array_agg(coalesce(tax_code, '0312345678') order by ord) into v_vn, v_vc, v_vt
    from (select distinct on (ord) * from (select v.*, case when v.name like '%Bếp Công nghiệp Sao Việt' then 1 when v.name like '%Kho lạnh Bắc Nam' then 2
                                                       when v.name like '%Dụng cụ Bếp Á Châu' then 3 end ord from pm_vendor v) y
            where ord is not null order by ord, code) x;
  if coalesce(array_length(v_vn, 1), 0) < 3 then
    select array_agg(name order by code), array_agg(code order by code), array_agg(coalesce(tax_code, '0312345678') order by code) into v_vn, v_vc, v_vt
      from (select * from pm_vendor order by code limit 3) x;
  end if;
  v_amt := array[2 * v_u1[1] + v_u2[1] + 12 * v_u3[1] + v_oh[1], 2 * v_u1[2] + v_u2[2] + 12 * v_u3[2] + v_oh[2], 2 * v_u1[3] + v_u2[3] + 12 * v_u3[3] + v_oh[3]];
  v_sub1 := 2 * v_u1[1] + v_u2[1] + 12 * v_u3[1];
  v_total := v_amt[1];                                   -- 163.700.000 trước VAT
  v_vat := round(v_total * 1.08);

  ---------------------------------------------------------------- tài sản cũ được thay (đã có trong sổ, đã khấu hao hết)
  perform am_demo_as('demo.amc@plaza-demo.test');
  v_seq := am_alloc_asset_seq('KIT', p1.let, 2, null, 'demo-sample');
  v_bc := am_alloc_barcode('unique', 3, null, 'demo-sample');
  for k in 0 .. 1 loop
    insert into am_asset (asset_code, barcode, asset_kind, category_code, group_code, letters, seq, purchase_year, company_code, dept_code, location_code,
                          name_vi, name_en, unit_code, qty, serial, unit_price, currency, origin_iso2, supplier, manufacturer, invoice_no, purchase_date, in_use_date,
                          depreciate, depreciate_months, spec_brand, spec_model, status_code, label_printed, note, warranty_until)
    values (format('KIT.%s.%s.2014.%s', p1.grp, p1.let, lpad((v_seq + k)::text, 5, '0')), 'JVC.' || lpad((v_bc + k)::text, 9, '0'), 'unique', p1.cat, p1.grp, p1.let,
            v_seq + k, 2014, 'SOF', 'KIT', c_loc, p1.vi, p1.en, 'pcs', 1, 'RT14-0' || (381 + k), 42000000, 'VND', (select iso2 from am_origin where iso2 = 'IT'),
            'Công ty TNHH Thiết bị Bếp Á Âu [DEMO]', 'Electrolux', 'HD0001402', date '2014-05-12', date '2014-05-20', true, 96, 'Electrolux', 'RCSN2M', '1', true,
            '[DEMO] Dự án mẫu: bàn lạnh cũ, được thay bởi ' || c_sc, date '2015-05-20')
    returning id into v_line;
    v_old := v_old || v_line;
  end loop;
  v_seq := am_alloc_asset_seq('KIT', p2.let, 1, null, 'demo-sample');
  insert into am_asset (asset_code, barcode, asset_kind, category_code, group_code, letters, seq, purchase_year, company_code, dept_code, location_code,
                        name_vi, name_en, unit_code, qty, serial, unit_price, currency, origin_iso2, supplier, manufacturer, invoice_no, purchase_date, in_use_date,
                        depreciate, depreciate_months, spec_brand, spec_model, status_code, label_printed, note, warranty_until)
  values (format('KIT.%s.%s.2016.%s', p2.grp, p2.let, lpad(v_seq::text, 5, '0')), 'JVC.' || lpad((v_bc + 2)::text, 9, '0'), 'unique', p2.cat, p2.grp, p2.let,
          v_seq, 2016, 'SOF', 'KIT', c_loc, p2.vi, p2.en, 'pcs', 1, 'RF16-1102', 19500000, 'VND', (select iso2 from am_origin where iso2 = 'KR'),
          'Công ty TNHH Điện máy Phương Đông [DEMO]', 'Samsung', 'HD0002219', date '2016-08-03', date '2016-08-10', false, null, 'Samsung', 'RR39M7140',
          '1', true, '[DEMO] Dự án mẫu: tủ lạnh cũ, chuyển làm dự phòng', date '2017-08-10')
  returning id into v_line;
  v_old := v_old || v_line;
  select array_agg(asset_code order by id) into v_oldc from am_asset where id = any (v_old);

  ---------------------------------------------------------------- ngân sách + dự án
  select id into v_round from pm_budget_round where year = 2026 and is_final order by id desc limit 1;
  if v_round is not null then
    insert into pm_budget_line (round_id, line_no, project_code, category, dept_code, request_date, investment_type, reason, name, estimated_value, gm_approved,
                                possibility, impact, assessment, risk_level, start_date, end_date, asset_item, rationale, quantity, unit_price, amount, m05, note)
    values (v_round, (select coalesce(max(line_no), 0) + 1 from pm_budget_line where round_id = v_round), c_sc, 'FFE', 'KIT', date '2025-10-15', 'Replacement',
            'Bàn lạnh bếp nóng mua 2014 hỏng máy nén nhiều lần, chi phí sửa chữa cao', 'Thay bàn lạnh & tủ lạnh bếp nóng Mezz', 185000000, 185000000,
            4, 3, 12, 'High', date '2026-05-01', date '2026-08-31', 'Bàn lạnh, tủ lạnh, dụng cụ bếp', 'Đề xuất của bộ phận KIT [DEMO]', 1, 185000000, 185000000,
            185000000, '[DEMO] Dự án mẫu');
    update pm_budget_round r set line_count = (select count(*) from pm_budget_line where round_id = r.id),
                                 total_value = coalesce((select sum(estimated_value) from pm_budget_line where round_id = r.id), 0) where id = v_round;
  end if;
  insert into pm_project (code, main_code, year, dept_code, name, category, budgeted, investment_type, estimated_value, possibility, impact, assessment,
                          risk_level, asset_item, reason, rationale, planned_start, planned_end, source, comment)
  values (c_sc, c_sc, 2026, 'KIT', '★ Dự án mẫu — Thay bàn lạnh & tủ lạnh bếp nóng Mezz', 'FFE', true, 'Replacement', 185000000, 4, 3, 12, 'High',
          'Bàn lạnh, tủ lạnh, dụng cụ bếp', 'Bàn lạnh mua 2014 hỏng máy nén nhiều lần [DEMO]', 'Theo kế hoạch ngân sách 2026',
          date '2026-05-01', date '2026-08-31', 'budget', '[DEMO] Dự án mẫu đã đi hết quy trình — để xem các phiếu. Muốn thử duyệt, lập dự án khác.');

  ---------------------------------------------------------------- 1. PR + RR (NV Bếp), PA (AM)
  perform am_demo_as('demo.staff@plaza-demo.test');
  v_pr := pm_doc_create(c_sc, 'PR', jsonb_build_object(
    'request_date', (current_date - 165)::text, 'project_type', 'Non-consultancy', 'share_pct', 1, 'category', 'FFE', 'budget', 'Budgeted',
    'investment_type', 'Replacement', 'currency', 'VND', 'possibility', '4', 'impact', '3', 'assessment', 12, 'risk_level', 'High',
    'reason', 'Hai bàn lạnh bếp nóng Mezz (mua 2014) hỏng máy nén 2 lần trong 12 tháng, không giữ được 2–4 °C; chi phí sửa chữa đã vượt 40% giá trị mua mới. Tủ lạnh 2016 xuống cấp, chuyển làm dự phòng.',
    'cost_benchmark', 'Quotation', 'supplier', v_vn[1],
    'notes', E'- Warranty time: 24 tháng\n- Delivery time: 4–6 tuần kể từ ngày đặt hàng\n- Other: giao, lắp đặt, chạy thử và hướng dẫn vận hành tại bếp',
    'procurement_type', 'Competitive Quotation', 'evidence', '[]'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('asset_item', p1.lab, 'unit', 'pcs', 'rationale', 'Thay 2 bàn lạnh hỏng máy nén', 'tech_standard', 'Inox 304, 2 cánh, 1.800 mm, 2–8 °C, gas R290', 'location', c_loc, 'qty', 2, 'unit_price', 60000000, 'amount', 120000000),
      jsonb_build_object('asset_item', p2.lab, 'unit', 'pcs', 'rationale', 'Tủ lạnh đứng mới cho khu sơ chế', 'tech_standard', '2 cánh, 650 L, inverter', 'location', c_loc, 'qty', 1, 'unit_price', 34000000, 'amount', 34000000),
      jsonb_build_object('asset_item', p3.lab, 'unit', 'pcs', 'rationale', 'Bổ sung chảo cho line nóng', 'tech_standard', 'Chảo gang/inox đáy từ Ø 32 cm', 'location', c_loc, 'qty', 12, 'unit_price', 900000, 'amount', 10800000)),
    'total', 164800000));
  v_pkg := (select pkg_id from pm_doc where id = v_pr);
  v_rr := pm_doc_create(c_sc, 'RR', jsonb_build_object(
    'replacement_level', 'Full replacement', 'after_replacement', 'Liquidation', 'currency', 'VND', 'request_date', (current_date - 165)::text,
    'evidence', '[]'::jsonb, 'total_qty', 3, 'total', 103500000,
    'lines', jsonb_build_array(
      jsonb_build_object('asset_item', p1.lab, 'asset_code', v_oldc[1], 'condition', 'Damaged', 'reason', 'High repair cost', 'after', 'Liquidation', 'qty', 1, 'unit', 'pcs', 'original_value', 42000000),
      jsonb_build_object('asset_item', p1.lab, 'asset_code', v_oldc[2], 'condition', 'Damaged', 'reason', 'Irreparable', 'after', 'Liquidation', 'qty', 1, 'unit', 'pcs', 'original_value', 42000000),
      jsonb_build_object('asset_item', p2.lab, 'asset_code', v_oldc[3], 'condition', 'Poor', 'reason', 'Obsolete', 'after', 'Spare', 'qty', 1, 'unit', 'pcs', 'original_value', 19500000))));
  perform am_demo_tick(am_demo_at(165, 10), c_sc, v_nm);
  perform pm_pkg_submit(v_pkg, v_sig);
  perform am_demo_tick(am_demo_at(163, 15), c_sc, v_nm);
  perform am_demo_drive(v_pkg, 162, c_sc, v_nm, 'PA', jsonb_build_object(
    'date', (current_date - 160)::text, 'comparability', 'Comparable', 'risk_category', 'Technical Issues', 'possibility', 4, 'impact', 3, 'hide_ref', false,
    'evidence', '[]'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('asset_item', p1.lab, 'picture', 'Ảnh hiện trạng trong RR', 'qty', 2, 'location', c_loc, 'specs', 'Inox 304, 2 cánh, 1.800 mm', 'condition', 'Damaged', 'notes', 'Máy nén thay 2 lần; gioăng cửa rách, mặt inox rỉ'),
      jsonb_build_object('asset_item', p2.lab, 'picture', 'Ảnh hiện trạng kèm RR', 'qty', 1, 'location', c_loc, 'specs', '2 cánh, 650 L', 'condition', 'Poor', 'notes', 'Còn chạy, làm dự phòng'),
      jsonb_build_object('asset_item', p3.lab, 'picture', 'Không áp dụng — mua bổ sung', 'qty', 12, 'location', c_loc, 'specs', 'Ø 32 cm, đáy từ', 'condition', 'Full operational', 'notes', 'Bổ sung'))));

  ---------------------------------------------------------------- 2. Gọi báo giá: 3 nhà cung cấp nộp, mở thầu
  perform am_demo_as('demo.purchasing@plaza-demo.test');
  v_tid := pm_tender_create_prj(c_sc, jsonb_build_object(
    'title', 'Cung cấp, lắp đặt bàn lạnh, tủ lạnh và chảo bếp nóng Mezz', 'scope', 'Cung cấp, vận chuyển, lắp đặt, chạy thử, hướng dẫn vận hành',
    'terms', 'Báo giá đã gồm VAT tách riêng; hiệu lực tối thiểu 30 ngày; bảo hành tối thiểu 24 tháng cho thiết bị lạnh.',
    'deadline', (now() + interval '10 days')::text, 'address', 'Phòng Thu mua, tầng B1 — 17 Lê Duẩn, Phường Sài Gòn, TP.HCM', 'min_bids', 3,
    'items', jsonb_build_array(jsonb_build_object('item', p1.lab, 'qty', 2, 'unit', 'pcs', 'spec', 'Inox 304, 2 cánh, 1.800 mm, 2–8 °C'),
                               jsonb_build_object('item', p2.lab, 'qty', 1, 'unit', 'pcs', 'spec', '2 cánh, 650 L, inverter'),
                               jsonb_build_object('item', p3.lab, 'qty', 12, 'unit', 'pcs', 'spec', 'Ø 32 cm, đáy từ')),
    'crit', jsonb_build_array(jsonb_build_object('label', v_la[2], 'grp', 'ability'), jsonb_build_object('label', v_la[5], 'grp', 'ability'),
                              jsonb_build_object('label', v_lt[1], 'grp', 'technique'), jsonb_build_object('label', v_lt[3], 'grp', 'technique'))));
  perform am_demo_tick(am_demo_at(155, 9), c_sc, v_nm);
  for k in 1 .. 3 loop
    v_tok := v_tok || pm_tender_invite_add(array[v_tid], v_vc[k], v_vn[k], 'sales.' || lower(v_vc[k]) || '@vendor-demo.test', 14);
  end loop;
  perform am_demo_tick(am_demo_at(155, 10), c_sc, v_nm);
  for k in 1 .. 3 loop
    v_specx := jsonb_build_object('0', jsonb_build_object('brand', v_br[k], 'model', (array['RCDR2M18', 'BS2DC6', 'TST-72SD'])[k], 'origin', (array['Italy', 'Malaysia', 'Korea'])[k], 'capacity', '2–8 °C, 2 cánh', 'material', 'Inox 304'),
                                  '1', jsonb_build_object('brand', (array['Samsung', 'Hitachi', 'LG'])[k], 'model', (array['RS64R5331B4', 'R-FM800GPGV', 'GR-X257JS'])[k], 'origin', (array['Thailand', 'Thailand', 'Korea'])[k], 'capacity', '650 L'),
                                  '2', jsonb_build_object('brand', (array['Vollrath', 'Lodge', 'Matfer'])[k], 'origin', (array['USA', 'USA', 'France'])[k], 'capacity', 'Ø 32 cm'));
    perform vp_save(v_tok[k], v_tid, jsonb_build_object(
      'prices', jsonb_build_object('0', v_u1[k], '1', v_u2[k], '2', v_u3[k]), 'qtys', '{}'::jsonb, 'units', jsonb_build_object('0', 'pcs', '1', 'pcs', '2', 'pcs'),
      'specx', v_specx, 'specs', '{}'::jsonb,
      'olines', jsonb_build_array(jsonb_build_object('label', 'Vận chuyển & lắp đặt/Transport & installation', 'qty', 1, 'unit', 'package', 'price', v_oh[k])),
      'pay_sched', jsonb_build_array(jsonb_build_object('pct', 30, 'when', 'deposit'), jsonb_build_object('pct', 70, 'when', 'acceptance', 'days', 15)),
      'delivery', (array['4 tuần', '5 tuần', '6 tuần'])[k], 'warranty', (array['24 tháng', '24 tháng', '18 tháng'])[k], 'validity', '30 ngày',
      'crit', jsonb_build_object(v_la[2], (array['14 bếp khách sạn 4–5 sao', '9 bếp khách sạn', '6 nhà hàng'])[k], v_la[5], (array['Đối tác 8 năm', 'Đối tác mới', 'Đối tác 3 năm'])[k],
                                 v_lt[1], (array['Hàng có sẵn 60%', 'Nhập theo đơn', 'Nhập theo đơn'])[k], v_lt[3], (array['24 tháng, đổi mới 30 ngày', '24 tháng', '18 tháng'])[k])));
    v_key := vp_upload_key(v_tok[k], v_tid);
    perform vp_file_add(v_tok[k], v_tid, v_key || '/bao-gia-' || lower(v_vc[k]) || '.pdf', 'Báo giá ' || v_vn[k] || '.pdf', 186000, 'quotation');
    perform vp_submit(v_tok[k], v_tid);
    perform am_demo_tick(am_demo_at(152 - k, 11), c_sc, v_nm);
  end loop;
  perform am_demo_as('demo.purchasing@plaza-demo.test'); perform pm_tender_consent_give(v_tid, 'PURCHASING');
  perform am_demo_tick(am_demo_at(148, 9), c_sc, v_nm);
  perform am_demo_as('demo.kithead@plaza-demo.test'); perform pm_tender_consent_give(v_tid, 'DEPT_HEAD');
  perform am_demo_tick(am_demo_at(148, 10), c_sc, v_nm);
  perform am_demo_as('demo.dof@plaza-demo.test'); perform pm_tender_consent_give(v_tid, 'DOF');
  perform am_demo_tick(am_demo_at(148, 11), c_sc, v_nm);
  update pm_tender set deadline = am_demo_at(149, 17) where id = v_tid;

  ---------------------------------------------------------------- 3. QC (Thu mua, từ 3 báo giá) + MC (AM)
  for k in 1 .. 3 loop
    select b.id bid, b.invitee_id inv into x from pm_tender_bid b join pm_tender_invitee i on i.id = b.invitee_id
     where b.tender_id = v_tid and i.vendor_name = v_vn[k] order by b.id desc limit 1;
    v_vend := v_vend || jsonb_build_array(jsonb_build_object(
      'name', v_vn[k], 'vendor_code', v_vc[k], 'tender_bid', x.bid, 'tender_invitee', x.inv,
      'prices', jsonb_build_object('0', v_u1[k], '1', v_u2[k], '2', v_u3[k]),
      'specx', (select data -> 'specx' from pm_tender_bid where id = x.bid), 'specs', '{}'::jsonb,
      'oprices', jsonb_build_object('0', v_oh[k]),
      's_ability', (select jsonb_object_agg(v_la[j], v_sa[k][j]) from generate_series(1, 5) j),
      's_technique', (select jsonb_object_agg(v_lt[j], v_st[k][j]) from generate_series(1, 7) j),
      'n_ability', jsonb_build_object(v_la[2], (array['14 bếp khách sạn 4–5 sao', '9 bếp khách sạn', '6 nhà hàng'])[k], v_la[5], (array['Đối tác 8 năm', 'Đối tác mới', 'Đối tác 3 năm'])[k]),
      'n_technique', jsonb_build_object(v_lt[1], (array['Hàng có sẵn 60%', 'Nhập theo đơn', 'Nhập theo đơn'])[k], v_lt[3], (array['24 tháng, đổi mới 30 ngày', '24 tháng', '18 tháng'])[k]),
      'pay_score', v_pay[k], 'pay_term', '30% deposit on order; 70% after acceptance (within 15 days)',
      'pay_sched', jsonb_build_array(jsonb_build_object('pct', 30, 'when', 'deposit'), jsonb_build_object('pct', 70, 'when', 'acceptance', 'days', 15)),
      'delivery', (array['4 tuần', '5 tuần', '6 tuần'])[k], 'warranty', (array['24 tháng', '24 tháng', '18 tháng'])[k], 'validity', '30 ngày',
      'amount', v_amt[k], 'ability', v_tot[k][1], 'technique', v_tot[k][2], 'price_score', v_tot[k][3], 'finance', v_tot[k][4], 'total', v_tot[k][5]));
  end loop;
  perform am_demo_as('demo.purchasing@plaza-demo.test');
  v_qc := pm_doc_create(c_sc, 'QC', jsonb_build_object(
    'date', (current_date - 147)::text, 'project_type', 'Mua sắm/Equipment', 'procurement_type', 'Competitive Quotation',
    'w_ability', 10, 'w_technique', 60, 'w_finance', 30, 'w_price', 80, 'w_pay', 20,
    'sub_ability', (select jsonb_agg(jsonb_build_object('label', v_la[j], 'w', 20) order by j) from generate_series(1, 5) j),
    'sub_technique', (select jsonb_agg(jsonb_build_object('label', v_lt[j], 'w', case when j = 7 then 14.32 else 14.28 end) order by j) from generate_series(1, 7) j),
    'qlines', jsonb_build_array(jsonb_build_object('item', p1.lab, 'qty', 2), jsonb_build_object('item', p2.lab, 'qty', 1), jsonb_build_object('item', p3.lab, 'qty', 12)),
    'olines', jsonb_build_array(jsonb_build_object('label', 'Vận chuyển & lắp đặt/Transport & installation')),
    'vendors', v_vend, 'chosen_vendor', v_vn[1], 'total_vendors', 3, 'tender_submitted', 3, 'tender_id', v_tid,
    'comments', 'Nhận đủ 3 báo giá hợp lệ qua cổng báo giá. Nhà cung cấp A điểm cao nhất (kỹ thuật, bảo hành, có sẵn hàng) và giá thấp nhất.',
    'estimated', v_amt[1], 'total', v_amt[1], 'evidence', '[]'::jsonb));
  perform pm_tender_link_qc(v_tid, v_qc);
  perform am_demo_tick(am_demo_at(147, 10), c_sc, v_nm);
  perform pm_pkg_submit((select pkg_id from pm_doc where id = v_qc), v_sig);
  perform am_demo_tick(am_demo_at(146, 15), c_sc, v_nm);
  perform am_demo_drive((select pkg_id from pm_doc where id = v_qc), 145, c_sc, v_nm, 'MC', jsonb_build_object(
    'date', (current_date - 143)::text, 'b_vendor', 'Công ty TNHH Thiết bị Bếp Á Âu (mua 2014, 2016)', 'c_vendor', 'Giá niêm yết nhà phân phối (website, 09/2026)',
    'note', 'So với giá mua cũ đã quy đổi (4,6%/năm) và giá niêm yết thị trường: giá nhà cung cấp A đều thấp hơn, trong biên độ cho phép.', 'evidence', '[]'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('item', p1.lab, 'qty', 2, 'a_spec', 'Electrolux RCDR2M18, inox 304', 'a_price', v_u1[1], 'b_ref', v_oldc[1], 'b_asset', true, 'b_year', 2014, 'b_pv', 42000000,
                         'c_spec', 'Bàn mát 2 cánh 1,8 m inox', 'c_price', 61900000),
      jsonb_build_object('item', p2.lab, 'qty', 1, 'a_spec', 'Samsung RS64R5331B4, 650 L', 'a_price', v_u2[1], 'b_ref', v_oldc[3], 'b_asset', true, 'b_year', 2016, 'b_pv', 19500000,
                         'c_spec', 'Tủ lạnh side-by-side 650 L', 'c_price', 33500000),
      jsonb_build_object('item', p3.lab, 'qty', 12, 'a_spec', 'Vollrath Ø 32 cm đáy từ', 'a_price', v_u3[1], 'b_ref', 'FFE.KIT.03.2025', 'b_asset', false, 'b_year', 2025, 'b_pv', 820000,
                         'c_spec', 'Chảo Ø 32 cm đáy từ', 'c_price', 890000))));

  ---------------------------------------------------------------- 4. PO (Thu mua)
  perform am_demo_as('demo.purchasing@plaza-demo.test');
  v_po := pm_doc_create(c_sc, 'PO', jsonb_build_object(
    'order_date', (current_date - 138)::text, 'supplier', v_vn[1],
    'payment_term', 'Đặt cọc 30% khi ký hợp đồng; 70% trong 15 ngày sau nghiệm thu bàn giao (AH)',
    'delivery_term', '4 tuần kể từ ngày đặt hàng, giao tại kho nhận hàng tầng B1', 'warranty_term', '24 tháng kể từ ngày nghiệm thu',
    'progress', 'Lắp đặt trong 2 ngày, ngoài giờ phục vụ (14:00–17:00)', 'note', 'Báo giá ngày ' || to_char(current_date - 151, 'DD/MM/YYYY') || ', hiệu lực 30 ngày',
    'hide_cols', '[]'::jsonb,
    'lines', jsonb_build_array(
      jsonb_build_object('asset_item', p1.lab, 'qty', 2, 'unit', 'pcs', 'unit_price', v_u1[1], 'amount', 2 * v_u1[1], 'origin', 'Italy', 'warranty_months', 24,
                         'spec', jsonb_build_object('brand', 'Electrolux', 'model', 'RCDR2M18', 'capacity', '2–8 °C, 2 cánh', 'material', 'Inox 304', 'length', '1800 mm')),
      jsonb_build_object('asset_item', p2.lab, 'qty', 1, 'unit', 'pcs', 'unit_price', v_u2[1], 'amount', v_u2[1], 'origin', 'Thailand', 'warranty_months', 24,
                         'spec', jsonb_build_object('brand', 'Samsung', 'model', 'RS64R5331B4', 'capacity', '650 L', 'material', 'Thép sơn tĩnh điện', 'length', '912 mm')),
      jsonb_build_object('asset_item', p3.lab, 'qty', 12, 'unit', 'pcs', 'unit_price', v_u3[1], 'amount', 12 * v_u3[1], 'origin', 'USA', 'warranty_months', 12,
                         'spec', jsonb_build_object('brand', 'Vollrath', 'model', 'N3112', 'capacity', 'Ø 32 cm', 'material', 'Inox 3 lớp, đáy từ', 'length', 'Ø 320 mm'))),
    'olines', jsonb_build_array(jsonb_build_object('label', 'Vận chuyển & lắp đặt/Transport & installation', 'qty', 1, 'unit', 'package', 'unit_price', v_oh[1], 'amount', v_oh[1])),
    'total_qty', 15, 'subtotal', v_sub1, 'overheads', v_oh[1], 'total', v_total));
  perform am_demo_tick(am_demo_at(138, 10), c_sc, v_nm);
  perform pm_pkg_submit((select pkg_id from pm_doc where id = v_po), v_sig);
  perform am_demo_tick(am_demo_at(137, 15), c_sc, v_nm);
  perform am_demo_drive((select pkg_id from pm_doc where id = v_po), 136, c_sc, v_nm);

  ---------------------------------------------------------------- 5. CT (hợp đồng) → sổ hợp đồng
  perform am_demo_as('demo.purchasing@plaza-demo.test');
  v_ct := pm_doc_create(c_sc, 'CT', jsonb_build_object(
    'signed_date', (current_date - 130)::text, 'supplier', v_vn[1], 'contract_no', '0412/2026/HĐMB/PLZ-' || v_vc[1], 'value', v_total, 'warranty_months', 24,
    'note', 'Phạt chậm giao 0,05%/ngày trên giá trị hàng giao chậm, tối đa 8%. Bảo hành tại chỗ trong 24 giờ.',
    'lines', jsonb_build_array(jsonb_build_object('milestone', 'Deposit', 'pct', 30, 'amount', round(v_total * 0.3), 'due', 'Trong 10 ngày làm việc sau khi ký'),
                               jsonb_build_object('milestone', 'Handover', 'pct', 70, 'amount', v_total - round(v_total * 0.3), 'due', 'Trong 15 ngày sau nghiệm thu (AH)')),
    'pct_sum', 100, 'total', v_total));
  perform am_demo_tick(am_demo_at(131, 10), c_sc, v_nm);
  perform pm_pkg_submit((select pkg_id from pm_doc where id = v_ct), v_sig);
  perform am_demo_tick(am_demo_at(130, 15), c_sc, v_nm);
  perform am_demo_drive((select pkg_id from pm_doc where id = v_ct), 129, c_sc, v_nm);
  select id into v_cid from pm_contract where doc_id = v_ct;
  if v_cid is not null then
    update pm_contract set kind = 'supply', vendor_code = v_vc[1], supplier_tax = v_vt[1], currency = 'VND', vat_pct = 8, value_total = v_vat,
                           start_date = current_date - 130, delivery_due = current_date - 102, end_date = current_date - 60,
                           delivery_text = '4 tuần kể từ ngày đặt hàng', penalty_text = 'Chậm giao: 0,05%/ngày giá trị hàng giao chậm, tối đa 8%',
                           summary = 'Cung cấp, lắp đặt 2 bàn lạnh, 1 tủ lạnh và 12 chảo cho bếp nóng Mezz [DEMO]'
     where id = v_cid;
    -- The CT form's "signed contract (link)": set after approval, so the register keeps the uploaded copy below instead of a link.
    update pm_doc set data = data || jsonb_build_object('file_link', 'https://plazahotel.sharepoint.com/sites/AM/Contracts/HD-0412-2026-ban-ky.pdf') where id = v_ct;
    insert into pm_contract_file (contract_id, kind, name, source, storage_path, size_bytes, pages, uploaded_name)
    values (v_cid, 'contract', 'Hợp đồng 0412-2026 (bản ký).pdf', 'storage', v_cid || '/hop-dong-0412-2026-ban-ky.pdf', 420000, 2, am_demo_nm('demo.purchasing@plaza-demo.test'));
    perform am_demo_tick(am_demo_at(128, 16), c_sc, v_nm);
  end if;

  ---------------------------------------------------------------- 6. Đề nghị thanh toán đợt 1 (đặt cọc 30%)
  perform am_demo_as('demo.purchasing@plaza-demo.test');
  v_pq := pm_payreq_save(jsonb_build_object('project_code', c_sc, 'kind', 'first', 'term_idx', 0, 'milestone', 'Deposit', 'pct', 30,
                                            'amount', round(v_total * 0.3), 'amount_contract', round(v_total * 0.3), 'vat_pct', 8,
                                            'invoice_no', '00001284', 'note', 'Đặt cọc 30% theo hợp đồng 0412/2026'));
  perform pm_payreq_file_add(v_pq, v_pq || '/thu-de-nghi-thanh-toan-dot-1.pdf', 'Thư đề nghị thanh toán đợt 1.pdf', 152000, 'vendor_letter');
  perform pm_payreq_file_add(v_pq, v_pq || '/hoa-don-00001284.pdf', 'Hoá đơn GTGT 00001284.pdf', 98000, 'invoice');
  perform am_demo_tick(am_demo_at(124, 10), c_sc, v_nm);
  perform pm_payreq_submit(v_pq, jsonb_build_object('sig', v_sig));
  perform am_demo_tick(am_demo_at(124, 11), c_sc, v_nm);
  perform am_demo_as('demo.chiefacc@plaza-demo.test');
  perform pm_payreq_act(v_pq, 'approve', null, jsonb_build_object('sig', v_sig));
  perform am_demo_tick(am_demo_at(123, 15), c_sc, v_nm);
  perform am_demo_as('demo.accountant@plaza-demo.test');
  perform pm_payreq_act(v_pq, 'paid', null, jsonb_build_object('paid_at', (current_date - 121)::text, 'paid_amount', round(round(v_total * 0.3) * 1.08),
                                                               'voucher_no', 'UNC-0921', 'sig', v_sig));
  perform am_demo_tick(am_demo_at(121, 14), c_sc, v_nm);

  ---------------------------------------------------------------- 7. Nhập tài sản mới (lô giao hàng) + AL
  perform am_demo_as('demo.amc@plaza-demo.test');
  insert into am_shipment (code, delivery_date, supplier, invoice_no, purpose_code, project_code, po_doc_no, contract_ref, company_code, dept_code, status, created_by)
  values (c_sc || '/' || to_char(current_date - 96, 'YYYYMMDD') || '-091500', current_date - 96, v_vn[1], '00001462', c_sc, c_sc,
          (select doc_no from pm_doc where id = v_po), (select doc_no from pm_doc where id = v_po), 'SOF', 'KIT', 'confirmed', am_demo_nm('demo.amc@plaza-demo.test'))
  returning id into v_ship;
  v_seq := am_alloc_asset_seq('KIT', p1.let, 2, v_ship, 'demo-sample');
  v_bc := am_alloc_barcode('unique', 3, v_ship, 'demo-sample');
  for k in 0 .. 1 loop
    insert into am_asset (asset_code, barcode, asset_kind, category_code, group_code, letters, seq, purchase_year, company_code, dept_code, location_code,
                          name_vi, name_en, unit_code, qty, serial, unit_price, currency, origin_iso2, supplier, manufacturer, invoice_no, purchase_date,
                          depreciate, depreciate_months, spec_brand, spec_model, status_code, label_printed, note, warranty_until, purpose_code, shipment_id)
    values (format('KIT.%s.%s.2026.%s', p1.grp, p1.let, lpad((v_seq + k)::text, 5, '0')), 'JVC.' || lpad((v_bc + k)::text, 9, '0'), 'unique', p1.cat, p1.grp, p1.let,
            v_seq + k, 2026, 'SOF', 'KIT', c_loc, p1.vi, p1.en, 'pcs', 1, 'EX26-0' || (5517 + k), v_u1[1], 'VND', (select iso2 from am_origin where iso2 = 'IT'),
            v_vn[1], 'Electrolux', '00001462', current_date - 96, true, 84, 'Electrolux', 'RCDR2M18', '120', false, '[DEMO] Dự án mẫu ' || c_sc,
            current_date - 82 + 730, c_sc, v_ship)
    returning id into v_line;
    v_new := v_new || v_line;
  end loop;
  v_seq := am_alloc_asset_seq('KIT', p2.let, 1, v_ship, 'demo-sample');
  insert into am_asset (asset_code, barcode, asset_kind, category_code, group_code, letters, seq, purchase_year, company_code, dept_code, location_code,
                        name_vi, name_en, unit_code, qty, serial, unit_price, currency, origin_iso2, supplier, manufacturer, invoice_no, purchase_date,
                        depreciate, depreciate_months, spec_brand, spec_model, status_code, label_printed, note, warranty_until, purpose_code, shipment_id)
  values (format('KIT.%s.%s.2026.%s', p2.grp, p2.let, lpad(v_seq::text, 5, '0')), 'JVC.' || lpad((v_bc + 2)::text, 9, '0'), 'unique', p2.cat, p2.grp, p2.let,
          v_seq, 2026, 'SOF', 'KIT', c_loc, p2.vi, p2.en, 'pcs', 1, 'SS26-77120', v_u2[1], 'VND', (select iso2 from am_origin where iso2 = 'TH'),
          v_vn[1], 'Samsung', '00001462', current_date - 96, false, null, 'Samsung', 'RS64R5331B4', '120', false, '[DEMO] Dự án mẫu ' || c_sc,
          current_date - 82 + 730, c_sc, v_ship)
  returning id into v_line;
  v_new := v_new || v_line;
  v_seq := am_alloc_asset_seq('KIT', p3.let, 1, v_ship, 'demo-sample');
  v_bc := am_alloc_barcode('low', 1, v_ship, 'demo-sample');
  insert into am_asset (asset_code, barcode, asset_kind, category_code, group_code, letters, seq, purchase_year, company_code, dept_code, location_code,
                        name_vi, name_en, unit_code, qty, unit_price, currency, origin_iso2, supplier, manufacturer, invoice_no, purchase_date,
                        depreciate, spec_brand, status_code, label_printed, note, purpose_code, shipment_id)
  values (format('KIT.%s.%s.2026.%s', p3.grp, p3.let, lpad(v_seq::text, 5, '0')), 'JVC.9' || lpad(v_bc::text, 8, '0'), 'low', p3.cat, p3.grp, p3.let,
          v_seq, 2026, 'SOF', 'KIT', c_loc, p3.vi, p3.en, 'pcs', 12, v_u3[1], 'VND', (select iso2 from am_origin where iso2 = 'US'),
          v_vn[1], 'Vollrath', '00001462', current_date - 96, false, 'Vollrath', '119', false, '[DEMO] Dự án mẫu ' || c_sc, c_sc, v_ship)
  returning id into v_line;
  v_new := v_new || v_line;
  update am_asset set created_at = am_demo_at(96, 9) where id = any (v_new || v_old);
  perform am_demo_tick(am_demo_at(96, 9), c_sc, v_nm);
  v_al := pm_doc_create(c_sc, 'AL', jsonb_build_object(
    'date', (current_date - 95)::text, 'shipment_id', v_ship, 'shipment_code', (select code from am_shipment where id = v_ship), 'delivery_date', (current_date - 96)::text,
    'po_no', (select doc_no from pm_doc where id = v_po), 'dept_code', 'KIT',
    'notes', E'1. Bộ phận nhận dán tem lên đúng tài sản ngay khi nhận hàng và chụp 2 ảnh (cận cảnh tem, toàn cảnh tài sản).\n2. Tải 2 ảnh lên hệ thống theo từng tài sản và đính kèm vào biên bản nghiệm thu (AH).',
    'asset_ids', to_jsonb(v_new),
    'assets', (select jsonb_agg(jsonb_build_object('id', id, 'asset_code', asset_code, 'barcode', barcode, 'name', name_vi || '/' || name_en, 'qty', qty, 'unit', unit_code,
                                                   'unit_price', unit_price, 'location', location_code, 'kind', asset_kind) order by id) from am_asset where id = any (v_new)),
    'total_qty', 15, 'total', v_sub1));
  perform am_demo_tick(am_demo_at(95, 10), c_sc, v_nm);
  perform pm_pkg_submit((select pkg_id from pm_doc where id = v_al), v_sig);
  perform am_demo_tick(am_demo_at(95, 11), c_sc, v_nm);
  perform am_demo_drive((select pkg_id from pm_doc where id = v_al), 94, c_sc, v_nm);

  ---------------------------------------------------------------- 8. Nhận hàng, ảnh tem / toàn cảnh, AH cuối (Hotel AM)
  perform am_demo_as('demo.hotelam@plaza-demo.test');
  for x in select id, asset_kind, qty, asset_code from am_asset where id = any (v_new) order by id loop
    perform am_recv_set(x.id, x.qty, 'now', 'Đủ số lượng, nguyên đai, đã dán tem', true);
    insert into am_asset_photo (asset_id, kind, source, storage_path, pm_doc_id, taken_name)
    values (x.id, 'label', 'storage', 'sample/' || x.asset_code || '-label.jpg', v_al, am_demo_nm('demo.hotelam@plaza-demo.test'));
    insert into am_asset_photo (asset_id, kind, source, storage_path, pm_doc_id, taken_name)
    values (x.id, 'overall', 'storage', 'sample/' || x.asset_code || '-overall.jpg', v_al, am_demo_nm('demo.hotelam@plaza-demo.test'))
    returning id into v_ph;
    update am_asset set avatar_photo_id = v_ph where id = x.id;
  end loop;
  select array_agg(id order by id) into v_recv from am_recv where asset_id = any (v_new);
  perform am_demo_tick(am_demo_at(92, 10), c_sc, v_nm);
  v_ah := pm_doc_create(c_sc, 'AH', jsonb_build_object(
    'handover_date', (current_date - 90)::text, 'evaluation', 'Excellent', 'final', true, 'supplier', v_vn[1],
    'evaluation_detail', 'Giao đủ, đúng chủng loại; lắp đặt gọn trong 2 ngày ngoài giờ phục vụ; chạy thử 48 giờ đạt 2–4 °C; đã hướng dẫn vận hành cho ca bếp.',
    'warranty_term', '24 tháng kể từ ngày nghiệm thu (chảo: 12 tháng)', 'maintenance_term', 'Bảo dưỡng miễn phí 3 tháng/lần trong năm đầu', 'retained_amount', 0,
    'note', 'Biên bản bàn giao kèm ảnh tem và ảnh toàn cảnh của từng tài sản.', 'hide_cols', '[]'::jsonb, 'evidence', '[]'::jsonb,
    'al_ids', jsonb_build_array(v_al), 'al_nos', jsonb_build_array((select doc_no from pm_doc where id = v_al)), 'asset_ids', to_jsonb(v_new), 'recv_ids', to_jsonb(v_recv),
    'lines', jsonb_build_array(
      jsonb_build_object('asset_item', p1.lab, 'qty', 2, 'unit', 'pcs', 'unit_price', v_u1[1], 'amount', 2 * v_u1[1], 'location', c_loc, 'origin', 'Italy', 'warranty_months', 24,
                         'spec', jsonb_build_object('brand', 'Electrolux', 'model', 'RCDR2M18', 'capacity', '2–8 °C, 2 cánh')),
      jsonb_build_object('asset_item', p2.lab, 'qty', 1, 'unit', 'pcs', 'unit_price', v_u2[1], 'amount', v_u2[1], 'location', c_loc, 'origin', 'Thailand', 'warranty_months', 24,
                         'spec', jsonb_build_object('brand', 'Samsung', 'model', 'RS64R5331B4', 'capacity', '650 L')),
      jsonb_build_object('asset_item', p3.lab, 'qty', 12, 'unit', 'pcs', 'unit_price', v_u3[1], 'amount', 12 * v_u3[1], 'location', c_loc, 'origin', 'USA', 'warranty_months', 12,
                         'spec', jsonb_build_object('brand', 'Vollrath', 'model', 'N3112', 'capacity', 'Ø 32 cm'))),
    'total_qty', 15, 'total', v_sub1));
  perform am_recv_link(v_ah, v_recv);
  perform am_demo_tick(am_demo_at(90, 10), c_sc, v_nm);
  perform pm_pkg_submit((select pkg_id from pm_doc where id = v_ah), v_sig);
  perform am_demo_tick(am_demo_at(90, 15), c_sc, v_nm);
  perform am_demo_drive((select pkg_id from pm_doc where id = v_ah), 89, c_sc, v_nm);

  ---------------------------------------------------------------- 9. Ghi sổ kế toán (sổ TSCĐ / CCDC) → tài sản "đã ghi nhận"
  if to_regclass('public.am_acc_line') is not null then
    insert into am_acc_line (kind, line_key, acc_code, entity, dept, acct_debit, description, qty, unit, unit_price, cost, start_date, term_months, monthly, accum, nbv,
                             docs, project_code, tax_code, supplier, first_seen, last_seen)
    select case when a.depreciate then 'fa' else 'ccdc' end, 'DEMO-SAMPLE-' || a.asset_code, a.asset_code, 'S', 'KIT', case when a.depreciate then '2112' else '242' end,
           a.name_vi || ' — ' || coalesce(a.spec_brand, '') || ' (' || a.asset_code || ')', a.qty, 'cái', a.unit_price, a.unit_price * a.qty,
           coalesce(a.in_use_date, current_date - 90), case when a.depreciate then a.depreciate_months else case when a.asset_kind = 'low' then 12 else 24 end end,
           round(a.unit_price * a.qty / case when a.depreciate then a.depreciate_months else case when a.asset_kind = 'low' then 12 else 24 end end),
           case when a.id = any (v_old) then a.unit_price * a.qty else round(a.unit_price * a.qty / case when a.depreciate then a.depreciate_months else case when a.asset_kind = 'low' then 12 else 24 end end) * 2 end,
           case when a.id = any (v_old) then 0 else a.unit_price * a.qty - round(a.unit_price * a.qty / case when a.depreciate then a.depreciate_months else case when a.asset_kind = 'low' then 12 else 24 end end) * 2 end,
           case when a.id = any (v_new) then c_sc end, case when a.id = any (v_new) then c_sc end,
           case when a.id = any (v_new) then v_vt[1] end, a.supplier, current_date - 75, current_date - 14
      from am_asset a where a.id = any (v_new || v_old);
    insert into am_acc_link (line_id, asset_id, method, note)
    select l.id, a.id, 'code', '[DEMO] dự án mẫu' from am_asset a join am_acc_line l on l.line_key = 'DEMO-SAMPLE-' || a.asset_code where a.id = any (v_new || v_old);
    perform am_acc_refresh(v_new || v_old);
  end if;

  ---------------------------------------------------------------- 10. Đề nghị quyết toán (70%) → dự án hoàn thành
  perform am_demo_as('demo.purchasing@plaza-demo.test');
  v_pq := pm_payreq_save(jsonb_build_object('project_code', c_sc, 'kind', 'final', 'term_idx', 1, 'milestone', 'Handover', 'pct', 70,
                                            'amount', v_total - round(v_total * 0.3), 'amount_contract', v_total - round(v_total * 0.3), 'vat_pct', 8,
                                            'invoice_no', '00001462', 'note', 'Quyết toán 70% sau nghiệm thu bàn giao'));
  perform pm_payreq_file_add(v_pq, v_pq || '/thu-de-nghi-quyet-toan.pdf', 'Thư đề nghị quyết toán.pdf', 148000, 'vendor_letter');
  perform pm_payreq_file_add(v_pq, v_pq || '/hoa-don-00001462.pdf', 'Hoá đơn GTGT 00001462.pdf', 101000, 'invoice');
  perform pm_payreq_file_add(v_pq, v_pq || '/bien-ban-nghiem-thu.pdf', 'Biên bản nghiệm thu đã ký.pdf', 233000, 'other');
  perform am_demo_tick(am_demo_at(86, 10), c_sc, v_nm);
  perform pm_payreq_submit(v_pq, jsonb_build_object('sig', v_sig));
  perform am_demo_tick(am_demo_at(86, 11), c_sc, v_nm);
  perform am_demo_as('demo.chiefacc@plaza-demo.test');
  perform pm_payreq_act(v_pq, 'approve', null, jsonb_build_object('sig', v_sig));
  perform am_demo_tick(am_demo_at(85, 15), c_sc, v_nm);
  perform am_demo_as('demo.accountant@plaza-demo.test');
  perform pm_payreq_act(v_pq, 'paid', null, jsonb_build_object('paid_at', (current_date - 83)::text, 'paid_amount', round((v_total - round(v_total * 0.3)) * 1.08),
                                                               'voucher_no', 'UNC-1107', 'sig', v_sig));
  perform am_demo_tick(am_demo_at(83, 14), c_sc, v_nm);

  ---------------------------------------------------------------- 11. LR các bàn lạnh cũ (tự lập từ RR khi AH cuối duyệt) → duyệt
  select id, pkg_id, data into x from pm_doc where doc_type = 'LR' and status in ('draft', 'returned') and data ->> 'project_code' = c_sc order by id desc limit 1;
  perform am_demo_as('demo.staff@plaza-demo.test');
  if x.id is null then
    v_lr := pm_lq_create('KIT', jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('key', 'r' || a.id, 'asset_id', a.id, 'asset_code', a.asset_code,
              'name', a.name_vi || '/' || a.name_en, 'qty', 1, 'unit', a.unit_code, 'dept_code', a.dept_code, 'kind', a.asset_kind, 'location', a.location_code,
              'original_value', a.unit_price)) from am_asset a where a.id = any (v_old[1:2]))));
    select id, pkg_id, data into x from pm_doc where id = v_lr;
  end if;
  v_lr := x.id; v_lrpkg := x.pkg_id;
  v_lines := (select jsonb_agg(l || jsonb_build_object('condition', 'Damaged', 'reason', 'High repair cost / Chi phí sửa chữa cao', 'mode', 'Sale',
                       'unit_price', 42000000, 'original_value', 42000000, 'depreciation', 42000000, 'nbv', 0, 'in_use_date', '2014-05-20', 'warranty', '2015-05-20',
                       'repairs', 6, 'location', c_loc, 'notes', 'Máy nén thay 2 lần trong 12 tháng; gioăng cửa rách, mặt inox rỉ. Đã khấu hao hết.')
                       order by ord) from jsonb_array_elements(x.data -> 'lines') with ordinality t(l, ord));
  perform pm_doc_save(v_lr, x.data || jsonb_build_object('date', (current_date - 80)::text, 'dept_code', 'KIT', 'position', 'Nhân viên bếp — phụ trách tài sản bộ phận',
                                                        'reason', 'Hai bàn lạnh cũ được thay theo dự án ' || c_sc || '; hỏng máy nén, sửa chữa không kinh tế. Đề nghị thanh lý bán phế liệu.',
                                                        'evidence', '[]'::jsonb, 'lines', v_lines, 'total_qty', jsonb_array_length(v_lines),
                                                        'total_original', 42000000 * jsonb_array_length(v_lines), 'total_dep', 42000000 * jsonb_array_length(v_lines),
                                                        'total_nbv', 0, 'total', 42000000 * jsonb_array_length(v_lines)));
  for x in select l ->> 'key' lk, (l ->> 'asset_id')::bigint aid, l ->> 'asset_code' ac from jsonb_array_elements(v_lines) l loop
    insert into am_asset_photo (asset_id, kind, source, storage_path, pm_doc_id, line_key, taken_name)
    values (x.aid, 'condition', 'storage', 'sample/' || x.ac || '-condition.jpg', v_lr, x.lk, am_demo_nm('demo.staff@plaza-demo.test'));
  end loop;
  perform am_demo_tick(am_demo_at(80, 10), c_sc, v_nm);
  perform pm_pkg_submit(v_lrpkg, v_sig);
  perform am_demo_tick(am_demo_at(80, 15), c_sc, v_nm);
  perform am_demo_drive(v_lrpkg, 79, c_sc, v_nm);

  ---------------------------------------------------------------- 12. Hội đồng thanh lý + đợt thanh lý tới khi đóng
  if not exists (select 1 from pm_lq_council where active) then
    insert into pm_lq_council (decision_no, decision_date, active, note) values ('QĐ 01/2026/QĐ-PLZ [DEMO]', date '2026-01-05', true, '[DEMO] Hội đồng thanh lý')
    returning id into v_council;
    insert into pm_lq_member (council_id, sort, full_name, position_vi, position_en, role, permanent, user_id) values
      (v_council, 1, am_demo_nm('demo.jvcgm@plaza-demo.test'), 'Tổng Giám đốc Liên doanh', 'JVC General Manager', 'chair', true, am_demo_uid('demo.jvcgm@plaza-demo.test')),
      (v_council, 2, am_demo_nm('demo.dof@plaza-demo.test'), 'Giám đốc Tài chính khách sạn', 'Director of Finance', 'member', true, am_demo_uid('demo.dof@plaza-demo.test')),
      (v_council, 3, am_demo_nm('demo.chiefacc@plaza-demo.test'), 'Kế toán trưởng', 'Chief Accountant', 'member', true, am_demo_uid('demo.chiefacc@plaza-demo.test')),
      (v_council, 4, am_demo_nm('demo.cphead@plaza-demo.test'), 'Trưởng Ban quản lý cao ốc', 'Office Building Manager', 'member', true, am_demo_uid('demo.cphead@plaza-demo.test'));
  end if;
  perform am_demo_as('demo.hotelam@plaza-demo.test');
  v_b := pm_lq_batch_create(null, '{}'::jsonb);
  select array_agg(id order by id) into v_items from pm_lq_item where lr_doc_id = v_lr;
  perform pm_lq_batch_items(v_b, v_items, '{}'::bigint[]);
  for k in 1 .. coalesce(array_length(v_items, 1), 0) loop
    perform pm_lq_item_map(v_items[k], (select asset_id from pm_lq_item where id = v_items[k]), null, null);
  end loop;
  update pm_lq_batch set meeting_date = current_date - 62, meeting_time = '14:00', meeting_place = 'Phòng họp tầng 3, khách sạn',
         data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
           'causes_vi', 'Hai bàn lạnh bếp nóng Mezz mua năm 2014 đã khấu hao hết, hỏng máy nén nhiều lần; đã được thay mới theo dự án ' || c_sc || '.',
           'causes_en', 'Two 2014 refrigerated tables in the Mezz hot kitchen, fully depreciated, with repeated compressor failures; replaced under project ' || c_sc || '.',
           'plan_vi', 'Bán thanh lý theo hình thức chào giá cạnh tranh (tối thiểu 3 bên mua); bên mua tự tháo dỡ, vận chuyển.',
           'plan_en', 'Sell by competitive quotation (at least 3 buyers); the buyer dismantles and removes the items.',
           'conclusion_vi', 'Hội đồng thống nhất thanh lý 02 bàn lạnh, giá khởi điểm theo đánh giá lại; tiền thu nộp về tài khoản khách sạn.',
           'conclusion_en', 'The committee agrees to dispose of the 2 refrigerated tables, starting from the revalued price; proceeds to the hotel account.')
 where id = v_b;
  perform am_demo_tick(am_demo_at(70, 10), c_sc, v_nm);
  perform pm_lq_submit(v_b);
  perform am_demo_tick(am_demo_at(69, 15), c_sc, v_nm);
  perform am_demo_lq_sign(v_b, 68, c_sc, v_nm);         -- DOF, GM khách sạn
  perform am_demo_lq_sign(v_b, 66, c_sc, v_nm);         -- AM team kiểm tra
  perform am_demo_lq_sign(v_b, 62, c_sc, v_nm);         -- Hội đồng: biên bản 02, Chủ tịch: quyết định 03
  perform am_demo_as('demo.hotelam@plaza-demo.test');
  perform pm_lq_file_add(v_b, 'minutes', v_b || '/bien-ban-hop-hoi-dong-02.pdf', 'Biên bản họp Hội đồng (02) — bản ký.pdf', 310000, null);
  perform pm_lq_file_add(v_b, 'decision', v_b || '/quyet-dinh-thanh-ly-03.pdf', 'Quyết định thanh lý (03) — bản ký.pdf', 205000, null);
  perform am_demo_tick(am_demo_at(61, 10), c_sc, v_nm);
  -- Kiểm tra thực tế (04) và đánh giá lại (05)
  perform am_demo_as('demo.amx@plaza-demo.test');
  for k in 1 .. coalesce(array_length(v_items, 1), 0) loop
    perform pm_lq_count(v_items[k], true, 1, 'Còn tại bếp nóng Mezz, đúng hiện trạng biên bản');
  end loop;
  perform pm_lq_file_add(v_b, 'sitecheck', v_b || '/bien-ban-kiem-tra-hien-truong-04.pdf', 'Biên bản kiểm tra hiện trường (04) — bản ký.pdf', 260000, null);
  perform pm_lq_milestone(v_b, 'count', true);
  perform am_demo_tick(am_demo_at(58, 10), c_sc, v_nm);
  for k in 1 .. coalesce(array_length(v_items, 1), 0) loop
    perform pm_lq_reval(v_items[k], 2500000, 'Giá thu hồi inox 304 (≈ 70 kg) và máy nén');
  end loop;
  perform pm_lq_file_add(v_b, 'reval', v_b || '/danh-gia-lai-05.pdf', 'Đánh giá lại (05).pdf', 140000, null);
  perform pm_lq_milestone(v_b, 'reval', true);
  perform am_demo_tick(am_demo_at(56, 10), c_sc, v_nm);
  -- Gọi báo giá mua lại: 3 bên mua nộp
  perform pm_lq_call_open(v_b, now() + interval '7 days', 'Giá đã gồm VAT; bên mua tự tháo dỡ, vận chuyển trong 5 ngày; thanh toán 100% trước khi nhận hàng.');
  perform am_demo_tick(am_demo_at(55, 9), c_sc, v_nm);
  for k in 1 .. 3 loop
    v_btok := v_btok || pm_lq_buyer_add(v_b, (array['Công ty TNHH Môi trường Xanh Việt [DEMO]', 'Cơ sở thu mua phế liệu Tân Phú [DEMO]', 'Ông Lê Văn Sáu [DEMO]'])[k],
                                        '090' || (1234560 + k), 'buyer' || k || '@buyer-demo.test', 10);
  end loop;
  perform am_demo_tick(am_demo_at(55, 10), c_sc, v_nm);
  for k in 1 .. 3 loop
    perform vq_save(v_btok[k], jsonb_build_object('kind', case when k = 3 then 'person' else 'company' end,
      'name', (array['Công ty TNHH Môi trường Xanh Việt [DEMO]', 'Cơ sở thu mua phế liệu Tân Phú [DEMO]', 'Lê Văn Sáu [DEMO]'])[k],
      'phone', '090' || (1234560 + k), 'address', (array['12 Tân Thới Nhất 8, Q.12', '88 Lũy Bán Bích, Tân Phú', '41/7 Bùi Minh Trực, Q.8'])[k] || ', TP.HCM',
      'tax_code', case when k < 3 then '03' || (19876540 + k) end, 'email', 'buyer' || k || '@buyer-demo.test', 'id_no', case when k = 3 then '079083001234' end,
      'prices', (select jsonb_object_agg(i::text, (array[3200000, 2900000, 2600000])[k] - (i % 2) * 100000) from unnest(v_items) i),
      'cost', 0, 'agree', true, 'note', 'Tự tháo dỡ và vận chuyển'));
    perform vq_submit(v_btok[k]);
    perform am_demo_tick(am_demo_at(53 - k, 11), c_sc, v_nm);
  end loop;
  perform am_demo_as('demo.hotelam@plaza-demo.test');
  perform pm_lq_open(v_b, array(select m.id from pm_lq_member m join pm_lq_batch b on b.council_id = m.council_id where b.id = v_b), 'Mở báo giá tại phòng họp tầng 3; đủ thành viên Hội đồng.');
  update pm_lq_batch set call_deadline = am_demo_at(48, 17) where id = v_b;
  perform am_demo_tick(am_demo_at(48, 14), c_sc, v_nm);
  perform pm_lq_award(v_b, (select jsonb_agg(jsonb_build_object('item_id', i.id, 'outcome', 'sale', 'quote_id', q.id,
                                                                'price', (q.data -> 'prices' ->> i.id::text)::numeric, 'cost', 0, 'note', 'Giá cao nhất'))
                              from pm_lq_item i
                              cross join lateral (select * from pm_lq_quote q where q.batch_id = v_b and q.status <> 'draft'
                                                  order by (q.data -> 'prices' ->> i.id::text)::numeric desc nulls last limit 1) q
                             where i.id = any (v_items)));
  perform pm_lq_file_add(v_b, 'award', v_b || '/ket-qua-ban-thanh-ly-06.pdf', 'Kết quả bán thanh lý (06).pdf', 150000, null);
  perform pm_lq_award_submit(v_b);
  perform am_demo_tick(am_demo_at(47, 10), c_sc, v_nm);
  perform am_demo_lq_sign(v_b, 46, c_sc, v_nm);         -- Hội đồng duyệt giá
  -- Quyết toán: hoá đơn (Kế toán), gate pass + biên bản giao nhận đã ký (Hotel AM)
  k := 0;
  for x in select distinct q.id, q.data ->> 'name' nm from pm_lq_quote q join pm_lq_item i on i.sale_quote_id = q.id where i.batch_id = v_b loop
    k := k + 1;
    v_inv := '0000' || (2101 + k);
    perform am_demo_as('demo.accountant@plaza-demo.test');
    perform pm_lq_buyer_doc(x.id, jsonb_build_object('invoice_no', v_inv, 'invoice_date', (current_date - 42)::text));
    perform pm_lq_file_add(v_b, 'invoice', v_b || '/hoa-don-' || v_inv || '.pdf', 'Hoá đơn bán thanh lý ' || v_inv || '.pdf', 90000, x.id);
    perform am_demo_as('demo.hotelam@plaza-demo.test');
    perform pm_lq_buyer_doc(x.id, jsonb_build_object('gate_date', (current_date - 41)::text, 'handover_date', (current_date - 41)::text));
    perform pm_lq_file_add(v_b, 'handover', v_b || '/bien-ban-giao-nhan-' || x.id || '.pdf', 'Biên bản giao nhận — ' || x.nm || '.pdf', 180000, x.id);
    perform pm_lq_file_add(v_b, 'gatepass', v_b || '/gate-pass-' || x.id || '.pdf', 'Gate pass — ' || x.nm || '.pdf', 120000, x.id);
  end loop;
  perform am_demo_tick(am_demo_at(41, 15), c_sc, v_nm);
  perform am_demo_lq_sign(v_b, 39, c_sc, v_nm);         -- AM, Kế toán, Kế toán trưởng → đóng đợt, cập nhật sổ

  -- The Disposal Form's sales table (LR page 2): price and buyer of each sold line.
  update pm_doc d set data = jsonb_set(d.data, '{lines}', (
    select jsonb_agg(l || coalesce((select jsonb_build_object('sale_price', i.sale_price, 'buyer', i.buyer, 'buyer_id', coalesce(q.data ->> 'tax_code', q.data ->> 'id_no'))
                                      from pm_lq_item i left join pm_lq_quote q on q.id = i.sale_quote_id
                                     where i.lr_doc_id = d.id and i.line_key = l ->> 'key'), '{}'::jsonb) order by ord)
      from jsonb_array_elements(d.data -> 'lines') with ordinality t(l, ord)))
   where d.id = v_lr;

  ---------------------------------------------------------------- ngày tháng theo kế hoạch
  update pm_project set request_date = current_date - 165, approve_date = current_date - 141, purchase_date = current_date - 132,
                        handover_date = current_date - 86 where code = c_sc;
  update pm_project set assess_date = current_date - 158 where code = c_sc and assess_date is not null;
  update pm_contract set signed_date = current_date - 130, approved_at = am_demo_at(125, 15), handover_date = current_date - 86,
                         warranty_until = current_date - 86 + 730 where id = v_cid;
  update am_alr set issue_date = current_date - 93 where pm_doc_id = v_al;
  update am_asset set in_use_date = current_date - 86 where id = any (v_new);
  update pm_lq_batch set decision_date = current_date - 61, count_date = current_date - 58, valuation_date = current_date - 56, liquidation_date = current_date - 38
   where id = v_b;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return jsonb_build_object('sample_project', c_sc, 'batch', (select code || ' · ' || status from pm_lq_batch where id = v_b),
                            'docs', (select count(*) from pm_doc where project_code = c_sc or id = v_lr), 'project_status', (select status from pm_project where code = c_sc));
end $$;

/* Hoàn thiện dự án mẫu (Công cụ quản trị → nút, demo.js): chữ ký vẽ tay của từng người demo thay cho chữ ký
   tạm (am_demo_sig0) ở mọi ô đã ký của dự án mẫu. p_sigs = {"email": "data:image/png;base64,…"}. */
create or replace function am_demo_sample_finish(p_sigs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v0 text := am_demo_sig0() ->> 'png'; n int := 0; m int;
begin
  perform am_demo_guard();
  perform app_require('override', 'admin');
  update pm_pkg_step s set signature = jsonb_build_object('png', p_sigs ->> u.email, 'at', s.acted_at)
    from app_user u where u.id = s.acted_by and s.signature ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,' and length(p_sigs ->> u.email) < 300000;
  get diagnostics m = row_count; n := n + m;
  update pm_pkg k set prep_signature = jsonb_build_object('png', p_sigs ->> u.email, 'at', k.submitted_at)
    from app_user u where u.id = k.created_by and k.prep_signature ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,' and length(p_sigs ->> u.email) < 300000;
  get diagnostics m = row_count; n := n + m;
  update pm_doc d set prep_signature = jsonb_build_object('png', p_sigs ->> u.email, 'at', d.submitted_at)
    from app_user u where u.id = d.created_by and d.prep_signature ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,' and length(p_sigs ->> u.email) < 300000;
  get diagnostics m = row_count; n := n + m;
  -- Phiếu PA / MC: "Người lập" là AM Coordinator ở bước soạn của gói.
  update pm_doc d set prep_signature = jsonb_build_object('png', p_sigs ->> u.email, 'at', s.acted_at)
    from pm_pkg_step s join app_user u on u.id = s.acted_by
   where d.pkg_id = s.pkg_id and s.owner_prep and d.doc_type in ('PA', 'MC') and d.prep_signature ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,';
  get diagnostics m = row_count; n := n + m;
  update pm_doc_step s set signature = jsonb_build_object('png', p_sigs ->> u.email, 'at', s.acted_at)
    from app_user u where u.id = s.acted_by and s.signature ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,';
  get diagnostics m = row_count; n := n + m;
  update pm_payreq r set submitted_sig = jsonb_build_object('png', p_sigs ->> u.email, 'at', r.submitted_at)
    from app_user u where u.id = r.created_by and r.submitted_sig ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,';
  get diagnostics m = row_count; n := n + m;
  update pm_payreq r set approved_sig = jsonb_build_object('png', p_sigs ->> u.email, 'at', r.approved_at)
    from app_user u where u.id = r.approved_by and r.approved_sig ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,';
  get diagnostics m = row_count; n := n + m;
  update pm_payreq r set paid_sig = jsonb_build_object('png', p_sigs ->> u.email, 'at', r.updated_at)
    from app_user u where u.id = r.paid_by and r.paid_sig ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,';
  get diagnostics m = row_count; n := n + m;
  update pm_lq_sign g set sig = jsonb_build_object('png', p_sigs ->> u.email, 'at', g.at)
    from app_user u where u.id = g.user_id and g.sig ->> 'png' = v0 and (p_sigs ->> u.email) ~ '^data:image/png;base64,';
  get diagnostics m = row_count; n := n + m;
  return jsonb_build_object('signatures', n);
end $$;

-- Các tệp mà dự án mẫu tham chiếu nhưng chưa có trong kho lưu trữ: Công cụ quản trị vẽ tệp mẫu (PDF / ảnh) rồi tải lên đúng chỗ.
create or replace function am_demo_sample_files()
returns table (bucket text, path text, name text, kind text, label text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform am_demo_guard();
  perform app_require('override', 'admin');
  return query
  with f as (
    select 'pm-tender'::text b, x ->> 'path' p, x ->> 'name' n, 'quotation'::text k, i.vendor_name l
      from pm_tender t join pm_tender_bid d on d.tender_id = t.id join pm_tender_invitee i on i.id = d.invitee_id, jsonb_array_elements(d.files) x
     where t.project_code = 'FFE.KIT.07.2026'
    union all
    select 'pm-payreq', x ->> 'path', x ->> 'name', x ->> 'kind', r.no from pm_payreq r, jsonb_array_elements(r.files) x where r.project_code = 'FFE.KIT.07.2026'
    union all
    select 'pm-contract', cf.storage_path, cf.name, 'contract', c.contract_no from pm_contract_file cf join pm_contract c on c.id = cf.contract_id
     where c.project_code = 'FFE.KIT.07.2026' and cf.source = 'storage'
    union all
    select 'am-photo', ph.storage_path, a.asset_code, 'photo-' || ph.kind, a.name_vi || ' · ' || a.asset_code
      from am_asset_photo ph join am_asset a on a.id = ph.asset_id where ph.source = 'storage' and ph.storage_path like 'sample/%'
    union all
    select 'pm-lqdoc', x ->> 'path', x ->> 'name', x ->> 'kind', b.code from pm_lq_batch b, jsonb_array_elements(b.files) x
     where exists (select 1 from pm_lq_item i join pm_doc d on d.id = i.lr_doc_id where i.batch_id = b.id and d.data ->> 'project_code' = 'FFE.KIT.07.2026'))
  select f.b, f.p, f.n, f.k, f.l from f
   where f.p is not null and (to_regclass('storage.objects') is null
                              or not exists (select 1 from storage.objects o where o.bucket_id = f.b and o.name = f.p));
end $$;

-- Tải tệp mẫu lên: chỉ quản trị, chỉ project demo, chỉ các kho của dự án mẫu.
do $$
begin
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists am_demo_upload on storage.objects';
    execute $p$create policy am_demo_upload on storage.objects for insert to authenticated
      with check (bucket_id in ('pm-tender', 'pm-payreq', 'pm-contract', 'am-photo', 'pm-lqdoc') and (select am_demo_on()) and (select app_can('override', 'admin')))$p$;
  end if;
end $$;

-- Nút "Làm mới dữ liệu thử" (Công cụ quản trị, chỉ project demo, quyền quản trị dữ liệu).
create or replace function am_demo_reset()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform am_demo_guard();
  perform app_require('override', 'admin');
  return am_demo_seed(1200);
end $$;

revoke execute on function am_demo_on(), am_demo_guard(), am_demo_people(), am_demo_accounts(text, text), am_demo_uid(text), am_demo_nm(text), am_demo_wipe(),
  am_demo_pick(text[]), am_demo_eng(), am_demo_seed(int), am_demo_reset(),
  am_demo_sig0(), am_demo_as(text), am_demo_role_mail(text), am_demo_at(int, numeric), am_demo_tick(timestamptz, text, bigint),
  am_demo_drive(bigint, int, text, bigint, text, jsonb), am_demo_lq_sign(bigint, int, text, bigint), am_demo_sample(),
  am_demo_sample_finish(jsonb), am_demo_sample_files() from public, anon;
revoke execute on function am_demo_as(text), am_demo_tick(timestamptz, text, bigint), am_demo_drive(bigint, int, text, bigint, text, jsonb),
  am_demo_lq_sign(bigint, int, text, bigint), am_demo_sample() from authenticated;
grant execute on function am_demo_on(), am_demo_reset(), am_demo_sample_finish(jsonb), am_demo_sample_files() to authenticated;


-- =====================================================================
-- 4. CHẠY — ĐỔI MẬT KHẨU DEMO TRƯỚC KHI CHẠY
-- =====================================================================

-- Mật khẩu người dùng thử, rồi mật khẩu RIÊNG của demo.admin (null = giữ mật khẩu quản trị đang có).
select am_demo_accounts('Demo@2026', 'Admin@2026');
select am_demo_seed(1200) as "Dữ liệu thử đã tạo";
select app_lock_anon();
