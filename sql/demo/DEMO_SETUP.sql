-- =====================================================================
-- sql/demo/DEMO_SETUP.sql — PROJECT DEMO / ĐÀO TẠO: TÀI KHOẢN + DỮ LIỆU THỬ
--
-- CHỈ chạy trên PROJECT SUPABASE DEMO (project riêng, mới tạo), SAU KHI đã
-- chạy sql/ALL_IN_ONE.sql trên chính project đó. KHÔNG BAO GIỜ chạy trên
-- project thật — file tự dừng nếu thấy dấu hiệu project thật (có bảng của app
-- khác, hoặc có tài sản không mang nhãn [DEMO]).
--
-- Tạo:
--   · 13 tài khoản demo theo vai trò (mật khẩu chung — đổi ở cuối file trước khi
--     chạy), đuôi e-mail @plaza-demo.test.
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
         ('demo.admin@plaza-demo.test',   'Quản trị Demo',                    'SYS_ADMIN',  'PHCL')
$$;

-- Tạo tài khoản đăng nhập (auth.users + auth.identities) nếu chưa có, rồi gán vai trò.
-- Nếu Supabase không cho tạo tài khoản bằng SQL, tạo tay ở Authentication → Users → Add user
-- (đúng các e-mail trên, bỏ chọn "send invitation", tích "auto confirm") rồi chạy lại hàm này để gán vai trò.
create or replace function am_demo_accounts(p_password text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare r record; v_id uuid; n_new int := 0; n_role int := 0; n_fail int := 0;
begin
  perform am_demo_guard();
  for r in select * from am_demo_people() loop
    select id into v_id from auth.users where lower(email) = r.email;
    if v_id is null then
      begin
        v_id := gen_random_uuid();
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', r.email, crypt(p_password, gen_salt('bf')), now(),
                '{"provider": "email", "providers": ["email"]}'::jsonb, jsonb_build_object('full_name', r.full_name), now(), now(), '', '', '', '');
        insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        values (gen_random_uuid(), v_id, v_id::text, jsonb_build_object('sub', v_id::text, 'email', r.email, 'email_verified', true), 'email', now(), now(), now());
        n_new := n_new + 1;
      exception when others then
        raise notice 'Không tạo được tài khoản % bằng SQL (%). Tạo tay ở Authentication → Users rồi chạy lại am_demo_accounts().', r.email, sqlerrm;
        n_fail := n_fail + 1; v_id := null;
      end;
    end if;
    if v_id is not null then
      insert into app_user (id, email, full_name) values (v_id, r.email, r.full_name)
      on conflict (id) do update set full_name = excluded.full_name, active = true;
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
    'pm_notice', 'pm_mt_action', 'pm_mt_entry', 'pm_mt_meeting', 'pm_mt_topic',
    'pm_contract_file', 'pm_contract', 'pr_line', 'pr_source', 'pr_import', 'pr_alias',
    'am_count_line', 'am_count', 'am_incident', 'am_transfer_line', 'am_transfer', 'am_report_snap',
    'pm_pay_alloc', 'pm_invoice', 'pm_payment', 'pm_pay_import',
    'pm_lq_attend', 'pm_lq_quote', 'pm_lq_buyer', 'pm_lq_event', 'pm_lq_item', 'pm_lq_batch', 'pm_lq_member', 'pm_lq_council',
    'pm_tender_event', 'pm_tender_consent', 'pm_tender_bid', 'pm_tender_invite', 'pm_tender_invitee', 'pm_tender',
    'pm_doc_event', 'pm_doc_step', 'pm_doc', 'pm_pkg_event', 'pm_pkg_step', 'pm_pkg', 'pm_vendor_score',
    'pm_project', 'pm_budget_line', 'pm_budget_round', 'pm_budget_year',
    'am_asset_photo', 'am_alr_line', 'am_alr', 'am_asset', 'am_shipment', 'am_counter_log', 'am_data_source',
    'pm_vendor', 'app_audit'] loop
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
            'app', 'manual', v_amx, 'Bùi Đức Minh (AM Executive)', p.purchase_date - 3);
  end loop;
  -- Hợp đồng dịch vụ / bảo trì hằng năm (một số sắp hết hạn để có nhắc hạn).
  insert into pm_contract (no, contract_no, title, kind, scope, entity, dept_code, vendor_code, supplier, signed_date, start_date, end_date, currency,
                           value_pre_vat, vat_pct, value_total, pay_terms, notice_days, auto_renew, status, source, terms_src, created_by, created_name, summary)
  values
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'BT-TM/2026/01', 'Bảo trì thang máy khách sạn 2026', 'maintenance', 'opex', 'SSP', 'ENG', v_vcodes[6], v_vendors[6],
     make_date(2026, 1, 2), make_date(2026, 1, 1), current_date + 45, 'VND', 480000000, 8, 518400000, '[{"milestone": "Progress", "pct": 25, "condition": "Hằng quý"}]', 30, false, 'active', 'app', 'manual', v_amx, 'Bùi Đức Minh (AM Executive)', 'Bảo trì định kỳ 12 thang máy, cứu hộ 24/7 [DEMO]'),
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'XLNT/2026', 'Vận hành hệ thống xử lý nước thải', 'maintenance', 'opex', 'SSP', 'ENG', v_vcodes[9], v_vendors[9],
     make_date(2026, 3, 1), make_date(2026, 3, 1), make_date(2027, 2, 28), 'VND', 360000000, 8, 388800000, '[{"milestone": "Progress", "pct": 8.33, "condition": "Hằng tháng"}]', 60, true, 'active', 'app', 'manual', v_amx, 'Bùi Đức Minh (AM Executive)', 'Vận hành, lấy mẫu quan trắc định kỳ [DEMO]'),
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'PCCC-BT/2026', 'Bảo trì hệ thống PCCC', 'maintenance', 'opex', 'SSP', 'ENG', v_vcodes[7], v_vendors[7],
     make_date(2025, 10, 1), make_date(2025, 10, 1), current_date + 12, 'VND', 210000000, 8, 226800000, '[]', 30, false, 'active', 'app', 'manual', v_amx, 'Bùi Đức Minh (AM Executive)', 'Kiểm tra, bảo dưỡng bình chữa cháy, sprinkler, báo cháy [DEMO]'),
    ('HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), 'VS-CT/2026', 'Kiểm soát côn trùng cao ốc', 'service', 'opex', 'CP', 'CEN', v_vcodes[29], v_vendors[29],
     make_date(2026, 1, 15), make_date(2026, 1, 15), make_date(2027, 1, 14), 'VND', 96000000, 8, 103680000, '[]', 30, true, 'active', 'app', 'manual', v_amx, 'Bùi Đức Minh (AM Executive)', null);
  -- Hai hợp đồng đang chờ duyệt: một dưới hạn mức khách sạn, một vượt hạn mức (qua Pháp chế + JVC).
  for i in 1 .. 2 loop
    v_c := null;
    insert into pm_contract (no, contract_no, title, kind, scope, entity, dept_code, project_code, vendor_code, supplier, currency, value_pre_vat, vat_pct, value_total,
                             pay_terms, warranty_months, status, source, created_by, created_name, submitted_at)
    select 'HD-2026-' || lpad(nextval('pm_contract_no_seq')::text, 4, '0'), null, 'Hợp đồng ' || lower(pp.name), 'supply', 'capex', 'SSP', pp.dept_code, pp.code, v_vcodes[10 + i], v_vendors[10 + i],
           'VND', case when i = 1 then 245000000 else 1850000000 end, 8, case when i = 1 then 264600000 else 1998000000 end,
           '[{"milestone": "Deposit", "pct": 30}, {"milestone": "Handover", "pct": 70}]', 12, 'review', 'app', v_amx, 'Bùi Đức Minh (AM Executive)', now() - interval '1 day'
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
    values (p.name, null, p.code, 'open', (select coalesce(max(sort), 0) + 10 from pm_mt_topic), 'app', 'Huỳnh Ngọc Lan (AM Coordinator)');
  end loop;
  insert into pm_mt_topic (title_vi, title_en, status, sort, source, created_name)
  values ('Kế hoạch Capex 2027', 'Capex plan 2027', 'open', 900, 'app', 'Huỳnh Ngọc Lan (AM Coordinator)');
  for i in 0 .. 5 loop
    v_d := current_date - (70 - i * 14);
    insert into pm_mt_meeting (no, meeting_date, title_vi, title_en, place, attendees, status, issued_at, issued_name, source, created_name)
    values ('MT-' || to_char(v_d, 'YYMMDD'), v_d, 'Họp định kỳ dự án Capex', 'Capex projects progress meeting', 'Phòng họp tầng 3',
            jsonb_build_array(jsonb_build_object('side', 'owner', 'name', 'Huỳnh Ngọc Lan (AM Coordinator)', 'user_id', v_amc),
                              jsonb_build_object('side', 'owner', 'name', 'Bùi Đức Minh (AM Executive)', 'user_id', v_amx),
                              jsonb_build_object('side', 'operator', 'name', 'Daniel Martin (Hotel GM)', 'position', 'GM', 'user_id', am_demo_uid('demo.gm@plaza-demo.test')),
                              jsonb_build_object('side', 'operator', 'name', 'Lê Văn Cường (Trưởng Kỹ thuật)', 'position', 'DOE', 'user_id', am_demo_uid('demo.enghead@plaza-demo.test'))),
            case when i = 5 then 'draft' else 'issued' end, case when i < 5 then v_d + 1 end, case when i < 5 then 'Huỳnh Ngọc Lan (AM Coordinator)' end,
            'app', 'Huỳnh Ngọc Lan (AM Coordinator)')
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
              null, 10, 'Huỳnh Ngọc Lan (AM Coordinator)')
      returning id into v_entry;
      insert into pm_mt_action (meeting_id, topic_id, entry_id, text_vi, pic_user, pic_name, due_date, status, done_at, done_name, closed_meeting_id)
      values (v_meet, t.id, v_entry, am_demo_pick(array['Gửi lại BOQ đã điều chỉnh', 'Làm việc với nhà cung cấp về giá chiết khấu', 'Trình hồ sơ đề xuất (PR)', 'Lập kế hoạch thi công chi tiết']),
              case when random() < 0.5 then am_demo_uid('demo.enghead@plaza-demo.test') else v_amx end,
              case when random() < 0.5 then 'Lê Văn Cường (Trưởng Kỹ thuật)' else 'Bùi Đức Minh (AM Executive)' end,
              v_d + 10, case when i < 3 then 'done' else 'open' end, case when i < 3 then (v_d + 12)::timestamptz end,
              case when i < 3 then 'Bùi Đức Minh (AM Executive)' end, null);
    end loop;
  end loop;

  ---------------------------------------------------------------- điều chuyển, sự cố
  for i in 1 .. 6 loop
    insert into am_transfer (no, from_dept, to_dept, to_location, reason, tf_date, status, steps, cur, created_name, created_at, submitted_at, done_at)
    values (format('TF.%s.%s.2026', (array['FBD','KIT','HKD','ENG','FOD','ADM'])[i], lpad(i::text, 3, '0')), (array['FBD','KIT','HKD','ENG','FOD','ADM'])[i],
            (array['KIT','FBD','FBD','CEN','ADM','FOD'])[i], null, 'Điều chuyển phục vụ vận hành [DEMO]', current_date - (100 - i * 12), 'done',
            '[{"key": "from", "action": "approve", "name": "Trưởng bộ phận giao"}, {"key": "to", "action": "approve", "name": "Trưởng bộ phận nhận"}, {"key": "am", "action": "approve", "name": "Bùi Đức Minh (AM Executive)"}]',
            null, 'Nguyễn Minh Anh (NV Bếp)', now() - make_interval(days => 100 - i * 12), now() - make_interval(days => 100 - i * 12), now() - make_interval(days => 98 - i * 12))
    returning id into v_tf;
    insert into am_transfer_line (transfer_id, asset_id, old_code, new_code)
    select v_tf, id, asset_code, asset_code from am_asset where dept_code = (array['FBD','KIT','HKD','ENG','FOD','ADM'])[i] and asset_kind = 'unique' order by random() limit 2;
  end loop;
  -- Một phiếu đang chờ duyệt (Bếp → F&B) để thử chuỗi duyệt.
  insert into am_transfer (no, from_dept, to_dept, reason, tf_date, status, steps, cur, created_by, created_name, submitted_at)
  values ('TF.KIT.007.2026', 'KIT', 'FBD', 'Chuyển tủ mát sang quầy bar [DEMO]', current_date - 1, 'pending', am_tf_steps('KIT', 'FBD'), 0,
          am_demo_uid('demo.staff@plaza-demo.test'), 'Nguyễn Minh Anh (NV Bếp)', now() - interval '1 day')
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
            'Nguyễn Minh Anh (NV Bếp)', now() - make_interval(days => 5 + i * 9), case when i % 4 <> 0 then now() - make_interval(days => 4 + i * 9) end,
            case when i % 4 >= 2 then now() - make_interval(days => 1 + i * 9) end, case when i % 4 >= 2 then 'Lê Văn Cường (Trưởng Kỹ thuật)' end);
  end loop;

  ---------------------------------------------------------------- kiểm kê: một đợt đã đóng (Buồng), một đợt đang mở (Bếp)
  insert into am_count (code, title, depts, count_date, status, members, created_name, opened_at, closed_at, closed_name)
  values ('KK.2026.01', 'Kiểm kê giữa năm — Buồng', array['HKD'], current_date - 60, 'closed',
          '[{"name": "Phạm Thu Dung", "position": "Trưởng Buồng"}, {"name": "Bùi Đức Minh", "position": "AM Executive"}]', 'Bùi Đức Minh (AM Executive)',
          now() - interval '62 days', now() - interval '58 days', 'Bùi Đức Minh (AM Executive)')
  returning id into v_cid;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book, group_code, category_code,
                             found, qty_found, loc_found, cond, by_name, at)
  select v_cid, id, barcode, asset_code, concat_ws(' / ', name_vi, name_en), asset_kind, dept_code, location_code, qty, status_code, group_code, category_code,
         r < 0.96, case when r < 0.96 then qty else 0 end, case when r < 0.96 then location_code end,
         case when r < 0.96 then (case when r < 0.9 then 'good' when r < 0.94 then 'poor' else 'damaged' end) end, 'Bùi Đức Minh (AM Executive)', now() - interval '59 days'
  from (select *, random() r from am_asset where dept_code = 'HKD') x;
  update am_count set summary = (select jsonb_build_object('total', count(*), 'found', count(*) filter (where cl.found), 'missing', count(*) filter (where not cl.found),
                                                          'damaged', count(*) filter (where cl.cond = 'damaged'), 'extra', 0, 'moved', 0, 'short', 0,
                                                          'applied', jsonb_build_object('moved', 0, 'lost', 0, 'damaged', 0))
                                 from am_count_line cl where cl.count_id = v_cid)
  where id = v_cid;
  insert into am_count (code, title, depts, count_date, status, members, created_name, opened_at)
  values ('KK.2026.02', 'Kiểm kê định kỳ Q3 — Bếp', array['KIT'], current_date, 'open', '[{"name": "Trần Quốc Bảo", "position": "Bếp trưởng"}]',
          'Bùi Đức Minh (AM Executive)', now() - interval '2 hours')
  returning id into v_cid;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book, group_code, category_code,
                             found, qty_found, loc_found, cond, by_name, at)
  select v_cid, id, barcode, asset_code, concat_ws(' / ', name_vi, name_en), asset_kind, dept_code, location_code, qty, status_code, group_code, category_code,
         case when r < 0.4 then true when r < 0.43 then false end, case when r < 0.4 then qty when r < 0.43 then 0 end, case when r < 0.4 then location_code end,
         case when r < 0.4 then 'good' end, case when r < 0.43 then 'Nguyễn Minh Anh (NV Bếp)' end, case when r < 0.43 then now() - make_interval(mins => (r * 100)::int) end
  from (select *, random() r from am_asset where dept_code = 'KIT') x;

  select jsonb_build_object('vendors', (select count(*) from pm_vendor), 'assets', (select count(*) from am_asset), 'projects', (select count(*) from pm_project),
                            'budget_lines', (select count(*) from pm_budget_line), 'invoices', (select count(*) from pm_invoice), 'payments', (select count(*) from pm_payment),
                            'price_lines', (select count(*) from pr_line), 'contracts', (select count(*) from pm_contract), 'meetings', (select count(*) from pm_mt_meeting),
                            'actions', (select count(*) from pm_mt_action), 'transfers', (select count(*) from am_transfer), 'incidents', (select count(*) from am_incident),
                            'count_lines', (select count(*) from am_count_line))
    into v_out;
  return v_out;
end $$;

-- Nút "Làm mới dữ liệu thử" (Công cụ quản trị, chỉ project demo, quyền quản trị dữ liệu).
create or replace function am_demo_reset()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform am_demo_guard();
  perform app_require('override', 'admin');
  return am_demo_seed(1200);
end $$;

revoke execute on function am_demo_on(), am_demo_guard(), am_demo_people(), am_demo_accounts(text), am_demo_uid(text), am_demo_wipe(),
  am_demo_pick(text[]), am_demo_seed(int), am_demo_reset() from public, anon;
grant execute on function am_demo_on(), am_demo_reset() to authenticated;


-- =====================================================================
-- 4. CHẠY — ĐỔI MẬT KHẨU DEMO TRƯỚC KHI CHẠY
-- =====================================================================

select am_demo_accounts('Demo@2026');
select am_demo_seed(1200) as "Dữ liệu thử đã tạo";
select app_lock_anon();
