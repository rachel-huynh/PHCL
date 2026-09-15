-- =====================================================================
-- asset-intake — TẤT CẢ TRONG MỘT FILE
-- Sinh tự động từ các file 01..05 trong cùng thư mục. Đừng sửa file này,
-- sửa file gốc rồi chạy scripts/build-sql.ps1.
--
-- Dán TOÀN BỘ vào Supabase SQL Editor rồi bấm Run. Chạy lại nhiều lần
-- vô hại: mọi lệnh đều if not exists / on conflict do update.
-- Sau đó chạy 00_verify.sql để kiểm chứng.
-- =====================================================================


-- ####################################################################
-- ##  01_schema.sql
-- ####################################################################

-- =====================================================================
-- asset-intake — Schema nền tảng: Master Data + Bộ đếm
-- Supabase / PostgreSQL.  Tiền tố bảng: am_  (asset management)
-- Thứ tự chạy: 01_schema -> 02_seed_master -> 03_functions -> 04_rls
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Cấu hình chung (ngưỡng giá... — sửa được, không hard-code trong app)
-- ---------------------------------------------------------------------
create table if not exists am_setting (
  key         text primary key,
  value       jsonb not null,
  note        text,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 1. Mã đơn vị quản lý (Org) — DANH SÁCH PHẲNG, đúng như file Asset code.xlsx
--    Một mã có thể vừa là công ty thành viên vừa đứng ở vị trí #1 của
--    Mã Tài Sản (ví dụ thật: CEN.C2112.MES.2024.00001).
--    is_company    -> dùng cho cột "Mã Công Ty Thành Viên (*)"
--    is_department -> dùng cho cột "Mã Phòng Ban" và vị trí #1 của Mã Tài Sản
-- ---------------------------------------------------------------------
create table if not exists am_org (
  code            text primary key,
  name_vi         text not null,
  name_en         text,
  level           text not null
                  check (level in ('TCT', 'BRANCH', 'DEPT1', 'DEPT2')),
  is_company      boolean not null default false,
  is_department   boolean not null default false,
  parent_code     text references am_org(code),
  active          boolean not null default true,
  note            text
);
comment on table am_org is
  'Mã đơn vị quản lý 4 cấp. is_company/is_department tách vai trò để Mã Công Ty và Mã Phòng Ban là 2 trường riêng trên tài sản, nhưng vẫn dùng chung một danh mục mã chuẩn.';

-- Bí danh mã đơn vị. Dữ liệu gốc của công ty KHÔNG nhất quán:
--   Asset code.xlsx       : HKD, ITD, SEC
--   Beetrack "4. Org Code": HKP, IT,  SEC
--   Beetrack "1. Area Code": HKP, ..., Security
-- Bảng này để import dữ liệu cũ không vỡ, nhưng mã CHUẨN chỉ có một.
create table if not exists am_org_alias (
  alias       text primary key,
  code        text not null references am_org(code) on update cascade,
  source      text
);

-- ---------------------------------------------------------------------
-- 2. Danh mục tài sản: nhóm cha kế toán (C21xx / C24xx) + mã loại 3 ký tự
-- ---------------------------------------------------------------------
create table if not exists am_category_group (
  code            text primary key,
  name_vi         text not null,
  name_en         text,
  is_intangible   boolean not null default false,
  is_tools        boolean not null default false,
  sort_order      int not null default 0
);
comment on column am_category_group.is_intangible is 'C213x = tài sản vô hình';
comment on column am_category_group.is_tools is 'C242x = CCDC, không đủ điều kiện ghi nhận TSCĐ';

create table if not exists am_category (
  code            text primary key,
  group_code      text not null references am_category_group(code),
  name_vi         text not null,
  name_en         text,
  label_letters   text not null check (label_letters ~ '^[A-Z]{3}$'),
  manage_by       text not null default 'code'
                  check (manage_by in ('code', 'quantity')),
  active          boolean not null default true,
  note            text,
  constraint am_category_letters_ck
    check (label_letters = replace(code, '-QR', ''))
);
comment on column am_category.label_letters is
  'Phần CHỮ ghi vào Mã Tài Sản sau khi BỎ hậu tố -QR. LTG và LTG-QR cùng ra LTG nên phải dùng CHUNG một dãy số. Khóa bộ đếm dùng cột này, KHÔNG dùng code.';
comment on column am_category.manage_by is 'Theo mã / Theo số lượng (cột "Cách quản lý" trong Asset code.xlsx)';

-- ---------------------------------------------------------------------
-- 3. Đơn vị tính
-- ---------------------------------------------------------------------
create table if not exists am_unit (
  code        text primary key,
  name_vi     text,
  name_en     text,
  sort_order  int not null default 0
);

-- ---------------------------------------------------------------------
-- 4. Xuất xứ — CHỈ mã ISO 3166-1 alpha-2 của MỘT quốc gia có thật.
--    Giá trị gốc kiểu "USA/Mexico/China/Singapore", "Asia", "EU"
--    => KHÔNG gán mã, KHÔNG giữ text gốc (để trống cả mã lẫn tên).
-- ---------------------------------------------------------------------
create table if not exists am_origin (
  iso2        char(2) primary key check (iso2 ~ '^[A-Z]{2}$'),
  name_en     text not null,
  name_vi     text
);

-- Bí danh 1-1 tới ĐÚNG một quốc gia ("USA" -> US, "Viet Nam" -> VN).
-- Tuyệt đối không thêm bí danh cho chuỗi nhiều quốc gia hoặc vùng/châu lục.
create table if not exists am_origin_alias (
  alias_norm  text primary key,
  iso2        char(2) not null references am_origin(iso2),
  note        text
);

-- Các chuỗi gốc đã gặp mà CỐ Ý không map. Giữ lại để UI giải thích
-- "vì sao bỏ trống" thay vì im lặng bỏ qua.
create table if not exists am_origin_rejected (
  raw_norm    text primary key,
  raw_sample  text,
  reason      text not null
              check (reason in ('multi_country', 'not_a_country', 'unknown')),
  seen_count  int not null default 1,
  first_seen  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 5. Vị trí: cây Tòa nhà -> Tầng -> Phòng / khu vực
-- ---------------------------------------------------------------------
create table if not exists am_location (
  code            text primary key,
  name            text not null,
  kind            text not null default 'room'
                  check (kind in ('building', 'floor', 'room', 'area')),
  parent_code     text references am_location(code),
  dept_code       text references am_org(code),
  is_dept_office  boolean not null default false,
  active          boolean not null default true
);
comment on column am_location.is_dept_office is
  'Mỗi phòng ban có đúng 1 vị trí office mặc định — dùng làm Mã Vị Trí khi biên bản giao hàng không ghi vị trí lắp đặt.';

create unique index if not exists am_location_one_office_per_dept
  on am_location(dept_code) where is_dept_office;

-- ---------------------------------------------------------------------
-- 6. Product catalogue: tên gốc nhà cung cấp -> tên chuẩn hóa -> danh mục
-- ---------------------------------------------------------------------
create table if not exists am_product (
  id                  bigserial primary key,
  raw_name_norm       text not null unique,
  raw_name            text not null,
  std_name_vi         text not null,
  std_name_en         text,
  default_category    text references am_category(code),
  default_unit        text references am_unit(code),
  default_brand       text,
  hint_intangible     boolean not null default false,
  times_used          int not null default 0,
  created_at          timestamptz not null default now()
);
comment on column am_product.raw_name_norm is
  'Khóa so khớp: lower, bỏ dấu tiếng Việt, gộp khoảng trắng. Sinh bằng am_norm().';
comment on column am_product.hint_intangible is
  'Đánh dấu tài sản vô hình (license, phần mềm). Dùng cho quy tắc >30 triệu: vô hình -> C2135/CTP, KHÔNG ép vào C2112.';

-- =====================================================================
-- 7. BỘ ĐẾM — phần bắt buộc phải đúng
-- =====================================================================

-- 7a. Số thứ tự Mã Tài Sản.
-- KHÓA = (mã phòng ban, CHỮ hiển thị sau khi bỏ '-QR').
--  * KHÔNG gồm mã nhóm cha: dữ liệu thật có ADM.C2112.KME và ADM.C2422.KME
--    dùng chung dãy số; khóa thêm nhóm sẽ sinh TRÙNG Mã Tài Sản.
--  * KHÔNG gồm năm: số thứ tự không reset theo năm.
create table if not exists am_asset_seq (
  dept_code   text not null references am_org(code),
  letters     text not null check (letters ~ '^[A-Z]{3}$'),
  next_seq    int  not null default 1 check (next_seq >= 1),
  updated_at  timestamptz not null default now(),
  primary key (dept_code, letters)
);
comment on table am_asset_seq is
  'Bộ đếm PERSISTENT. next_seq = số SẼ cấp tiếp theo. Chỉ được thay đổi qua am_alloc_asset_seq() / am_seed_asset_seq().';

-- 7b. Số Mã Vạch — hai dải tách biệt hoàn toàn với nhau và với Mã Tài Sản.
--   unique : 'JVC.' + 9 chữ số, chữ số đầu 0-8   (JVC.000006870)
--   low    : 'JVC.9' + 8 chữ số = 9xxxxxxxx      (luôn bắt đầu bằng 9)
create table if not exists am_barcode_seq (
  kind        text primary key check (kind in ('unique', 'low')),
  next_val    bigint not null check (next_val >= 1),
  max_val     bigint not null,
  updated_at  timestamptz not null default now()
);
comment on table am_barcode_seq is
  'next_val của kind=unique là số nguyên 1..899999999 (in ra lpad 9). next_val của kind=low là phần SAU số 9, 1..99999999 (in ra JVC.9 + lpad 8).';

-- 7c. Nhật ký cấp phát. Kế toán cần truy vết mọi số đã cấp, kể cả khi
--     đợt nhập bị hủy — số đã cấp thì KHÔNG tái sử dụng.
create table if not exists am_counter_log (
  id          bigserial primary key,
  counter     text not null check (counter in ('asset_seq', 'barcode')),
  scope       text not null,
  from_val    bigint not null,
  to_val      bigint not null,
  qty         int generated always as ((to_val - from_val + 1)::int) stored,
  shipment_id bigint,
  actor       text,
  created_at  timestamptz not null default now()
);
comment on column am_counter_log.scope is
  'asset_seq: "<dept>|<letters>" (vd "ADM|LTU").  barcode: "unique" hoặc "low".';
create index if not exists am_counter_log_scope_idx
  on am_counter_log(counter, scope, created_at desc);

-- ---------------------------------------------------------------------
-- 8. Đợt giao hàng + dòng trích xuất (nền cho bước upload PDF)
-- ---------------------------------------------------------------------
create table if not exists am_shipment (
  id               bigserial primary key,
  code             text unique,
  delivery_date    date,
  supplier         text,
  contract_ref     text,
  purpose_code     text,
  invoice_no       text,
  company_code     text references am_org(code),
  dept_code        text references am_org(code),
  source_file      text,
  source_page_from int,
  source_page_to   int,
  status           text not null default 'draft'
                   check (status in ('draft', 'extracted', 'confirmed', 'issued', 'cancelled')),
  created_at       timestamptz not null default now(),
  created_by       text
);
comment on column am_shipment.source_page_from is
  'Ranh giới trang trong PDF gộp nhiều đợt — mỗi đợt có trang bìa "BIÊN BẢN GIAO HÀNG" riêng.';

create table if not exists am_shipment_line (
  id              bigserial primary key,
  shipment_id     bigint not null references am_shipment(id) on delete cascade,
  line_no         int,
  raw             jsonb not null default '{}'::jsonb,
  raw_name        text,
  std_name_vi     text,
  std_name_en     text,
  category_code   text references am_category(code),
  unit_code       text references am_unit(code),
  qty             numeric(18, 3),
  unit_price      numeric(18, 2),
  origin_raw      text,
  origin_iso2     char(2) references am_origin(iso2),
  serials         text[],
  location_code   text references am_location(code),
  needs_review    jsonb not null default '[]'::jsonb,
  confirmed       boolean not null default false
);
comment on column am_shipment_line.raw is
  'Nguyên văn Claude trích ra, giữ nguyên để đối chiếu. Số lượng chính thức LUÔN lấy từ số IN ở cột "Số lượng giao", không lấy chữ viết tay bên cạnh.';
comment on column am_shipment_line.needs_review is
  'Các trường không có nguồn dữ liệu xác thực (Mã Tình Trạng, vị trí lắp đặt chi tiết...) phải nằm ở đây để UI đánh dấu rõ, không được âm thầm bỏ qua.';

-- ---------------------------------------------------------------------
-- 9. Sổ tài sản chính thức
-- ---------------------------------------------------------------------
create table if not exists am_asset (
  id                bigserial primary key,
  asset_code        text not null unique,
  barcode           text not null unique,
  asset_kind        text not null check (asset_kind in ('unique', 'low')),

  category_code     text not null references am_category(code),
  group_code        text not null references am_category_group(code),
  letters           text not null,
  seq               int  not null,
  purchase_year     int  not null,

  company_code      text not null references am_org(code),
  dept_code         text not null references am_org(code),
  location_code     text references am_location(code),

  name_vi           text not null,
  name_en           text,
  description       text,
  unit_code         text references am_unit(code),
  qty               numeric(18, 3) not null default 1,
  serial            text,
  unit_price        numeric(18, 2),
  currency          text not null default 'VND',
  fx_rate           numeric(18, 6),
  price_fx          numeric(18, 2),

  origin_iso2       char(2) references am_origin(iso2),
  supplier          text,
  manufacturer      text,
  invoice_no        text,
  purpose_code      text,
  purchase_date     date,
  in_use_date       date,
  depreciate        boolean,
  depreciate_months int,

  -- Đặc tính kỹ thuật — map thẳng sang cột ALR / Beetrack
  spec_function     text,
  spec_capacity     text,
  spec_brand        text,
  spec_model        text,
  spec_weight       text,
  spec_length       text,
  spec_width        text,
  spec_height       text,
  spec_material     text,
  spec_radius       text,
  spec_fuel         text,
  spec_shape        text,
  spec_area         text,
  spec_perimeter    text,
  spec_mfg_year     text,
  spec_accessory    text,
  spec_color        text,

  status_code       text,
  label_printed     boolean not null default false,
  note              text,

  needs_review      jsonb not null default '[]'::jsonb,
  shipment_id       bigint references am_shipment(id),
  created_at        timestamptz not null default now(),

  -- Quy tắc 1: unique asset thì mỗi đơn vị 1 dòng, Số Lượng luôn = 1
  constraint am_asset_unique_qty_ck
    check (asset_kind <> 'unique' or qty = 1),
  -- Mã Tài Sản phải khớp đúng các thành phần đã lưu
  constraint am_asset_code_ck check (
    asset_code = dept_code || '.' || group_code || '.' || letters || '.'
                 || purchase_year::text || '.' || lpad(seq::text, 5, '0')
  ),
  constraint am_asset_barcode_ck check (
    (asset_kind = 'unique' and barcode ~ '^JVC\.[0-8][0-9]{8}$') or
    (asset_kind = 'low'    and barcode ~ '^JVC\.9[0-9]{8}$')
  )
);
comment on column am_asset.status_code is
  'Mã Tình Trạng — không có nguồn xác thực từ biên bản giao hàng. Nếu để trống thì phải có mục tương ứng trong needs_review.';
create index if not exists am_asset_dept_letters_idx
  on am_asset(dept_code, letters, seq desc);
create index if not exists am_asset_shipment_idx on am_asset(shipment_id);
create index if not exists am_asset_category_idx on am_asset(category_code);

-- ---------------------------------------------------------------------
-- 10. Biên bản bàn giao tem nhãn (ALR)
-- ---------------------------------------------------------------------
create table if not exists am_alr (
  id            bigserial primary key,
  code          text not null unique,      -- AL.<số>
  issue_date    date not null default current_date,
  dept_code     text references am_org(code),
  location_code text references am_location(code),
  shipment_id   bigint references am_shipment(id),
  note          text,
  created_at    timestamptz not null default now()
);

create table if not exists am_alr_line (
  id        bigserial primary key,
  alr_id    bigint not null references am_alr(id) on delete cascade,
  line_no   int not null,
  asset_id  bigint not null references am_asset(id),
  unique (alr_id, asset_id)
);

-- Bộ đếm số hiệu ALR (AL.1, AL.2, ...)
create table if not exists am_alr_seq (
  singleton boolean primary key default true check (singleton),
  next_val  int not null default 1
);

-- ---------------------------------------------------------------------
-- 11. Bản đồ cột Excel — điều khiển bằng dữ liệu.
--     Công ty đang tồn tại 3 layout khác nhau (Beetrack gốc / Asset Track /
--     asset-template-file). Thay vì hard-code, mỗi template là một bộ
--     (tên cột -> trường trong am_asset).
-- ---------------------------------------------------------------------
create table if not exists am_xls_template (
  id          bigserial primary key,
  name        text not null unique,
  sheet_kind  text not null check (sheet_kind in ('unique', 'low')),
  sheet_name  text not null,
  header_row  int not null default 1,
  data_row    int not null default 2,
  active      boolean not null default true
);

create table if not exists am_xls_column (
  id           bigserial primary key,
  template_id  bigint not null references am_xls_template(id) on delete cascade,
  col_index    int not null,              -- 1 = A
  header       text not null,
  field        text,                      -- tên cột trong am_asset, null = để trống
  const_value  text,
  number_format text,                     -- xem docs/excel-format.md
  unique (template_id, col_index)
);
comment on column am_xls_column.number_format is
  'Bắt buộc ghi đè number_format cho MỌI ô của mọi dòng khi tạo file từ template có dòng ví dụ mẫu; nếu không, các dòng đầu giữ định dạng Text (@) và số/ngày hiển thị sai.';


-- ####################################################################
-- ##  02_seed_master.sql
-- ####################################################################

-- =====================================================================
-- asset-intake — Nạp Master Data gốc
-- Nguồn: "Asset code.xlsx" và sheet "3. Asset Code" / "4. Org Code"
--        trong "Asset Template File - Beetrack.xlsx"
-- Chạy SAU 01_schema.sql. Chạy lại nhiều lần được (idempotent).
-- Các điểm dữ liệu gốc mâu thuẫn: xem docs/data-issues.md
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Cấu hình
-- ---------------------------------------------------------------------
insert into am_setting (key, value, note) values
  ('unique_threshold', '5000000',  'Đơn giá >= mức này -> Unique asset, mỗi đơn vị 1 dòng, Số Lượng = 1'),
  ('capex_threshold',  '30000000', 'Đơn giá > mức này -> không được gán mã danh mục CCDC'),
  ('default_company',  '"SOF"',    'Mã Công Ty Thành Viên mặc định'),
  ('barcode_prefix',   '"JVC."',   'Tiền tố mã vạch')
on conflict (key) do update
  set value = excluded.value, note = excluded.note, updated_at = now();

-- ---------------------------------------------------------------------
-- 1. Mã đơn vị quản lý
--    JVC / CEN / SOF vừa là công ty thành viên, vừa xuất hiện ở vị trí #1
--    của Mã Tài Sản (bằng chứng thật: CEN.C2112.MES.2024.00001)
--    => is_company = true VÀ is_department = true.
-- ---------------------------------------------------------------------
insert into am_org (code, name_vi, name_en, level, is_company, is_department, parent_code, note) values
  ('PHCL', 'Công ty TNHH Liên Doanh Khách Sạn Plaza', 'Plaza Hotel Ltd.', 'TCT',    true,  false, null,   null),
  ('JVC',  'Văn phòng đại diện chủ đầu tư',           'JVC Office',       'BRANCH', true,  true,  'PHCL', 'Dùng được ở vị trí #1 của Mã Tài Sản'),
  ('CEN',  'Cao ốc văn phòng Central Plaza',          'Central Plaza',    'BRANCH', true,  true,  'PHCL', 'Dùng được ở vị trí #1 của Mã Tài Sản'),
  ('SOF',  'Khách sạn Sofitel SG Plaza',              'Sofitel Saigon Plaza', 'BRANCH', true, true, 'PHCL', 'Dùng được ở vị trí #1 của Mã Tài Sản'),
  ('FOD',  'Bộ phận tiền sảnh',              'Front Office Department',    'DEPT1', false, true, 'SOF', null),
  ('HKD',  'Bộ phận quản gia',               'House Keeping Department',   'DEPT1', false, true, 'SOF', 'Beetrack ghi là HKP — xem am_org_alias'),
  ('FBD',  'Bộ phận F&B',                    'Food & Beverage Department', 'DEPT1', false, true, 'SOF', null),
  ('KIT',  'Bộ phận bếp',                    'Kitchen Department',         'DEPT1', false, true, 'SOF', null),
  ('ENG',  'Bộ phận kỹ thuật',               'Engineering Department',     'DEPT1', false, true, 'SOF', null),
  ('ADM',  'Bộ phận hành chính, nhân sự',    'Administration & Human Resource Department', 'DEPT1', false, true, 'SOF', null),
  ('SMD',  'Bộ phận quảng cáo, bán hàng',    'Sale & Marketing Department', 'DEPT1', false, true, 'SOF', null),
  ('FIN',  'Bộ phận tài chính, kế toán',     'Finance Department',          'DEPT1', false, true, 'SOF', null),
  ('ITD',  'Bộ phận IT',                     'IT Department',               'DEPT2', false, true, 'FIN', 'Beetrack ghi là IT — xem am_org_alias'),
  ('SEC',  'Bộ phận an ninh',                'Security Department',         'DEPT2', false, true, 'ADM', null)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en, level = excluded.level,
      is_company = excluded.is_company, is_department = excluded.is_department,
      parent_code = excluded.parent_code, note = excluded.note;

insert into am_org_alias (alias, code, source) values
  ('HKP',      'HKD', 'Beetrack "4. Org Code" / "1. Area Code" / KiemKe-HKP'),
  ('IT',       'ITD', 'Beetrack "4. Org Code" / KiemKe-IT'),
  ('Security', 'SEC', 'Beetrack "1. Area Code"'),
  ('S&M',      'SMD', 'KiemKe-S&M'),
  ('A&G',      'ADM', 'KiemKe-A&G (Administration & General)')
on conflict (alias) do update set code = excluded.code, source = excluded.source;

-- ---------------------------------------------------------------------
-- 2. Nhóm tài sản (mã cha kế toán)
-- ---------------------------------------------------------------------
insert into am_category_group (code, name_vi, name_en, is_intangible, is_tools, sort_order) values
  ('C2111', 'Nhà cửa, vật kiến trúc',                         'Buildings and structures',                     false, false, 10),
  ('C2112', 'Máy móc và thiết bị',                            'Machinery and equipment',                      false, false, 20),
  ('C2113', 'Trang thiết bị và phương tiện vận tải',          'Transportation and transmission vehicles',     false, false, 30),
  ('C2114', 'Thiết bị, công cụ quản lý',                      'Office equipment, management tools',           false, false, 40),
  ('C2115', 'Cây lâu năm, súc vật làm việc và cho sản phẩm',  'Perennial trees, working and producing animals', false, false, 50),
  ('C2118', 'Tài sản cố định hữu hình khác',                  'Other tangible asset',                         false, false, 60),
  ('C2131', 'Quyền sử dụng đất',                              'Land use rights',                              true,  false, 70),
  ('C2132', 'Quyền phát hành',                                'Copyrights',                                   true,  false, 71),
  ('C2133', 'Bản quyền, quyền phát hành, bằng sáng chế',      'Patent',                                       true,  false, 72),
  ('C2134', 'Nhãn hiệu độc quyền, tên thương mại, quyền SHTT','Trademarks, trade names',                      true,  false, 73),
  ('C2135', 'Chương trình, phần mềm',                         'Computer software',                            true,  false, 74),
  ('C2136', 'Giấy phép và giấy phép nhượng quyền',            'License and right concession permits',         true,  false, 75),
  ('C2138', 'Tài sản cố định vô hình khác',                   'Other intangible asset',                       true,  false, 76),
  ('C2421', 'Thiết bị, CCDC ngắn hạn (không đủ đk ghi nhận TSCĐ)', 'Short-term tools & supplies',             false, true,  80),
  ('C2422', 'Thiết bị, CCDC dài hạn (không đủ đk ghi nhận TSCĐ)',  'Long-term tools & supplies',              false, true,  81)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en,
      is_intangible = excluded.is_intangible, is_tools = excluded.is_tools,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- 3. Mã loại tài sản (mã con 3 ký tự, + biến thể -QR)
--    label_letters = code sau khi bỏ '-QR'  (ràng buộc CHECK tự kiểm tra)
-- ---------------------------------------------------------------------
insert into am_category (code, group_code, name_vi, name_en, label_letters, manage_by, note) values
  ('BUL',    'C2111', 'Tòa nhà',                        'Building',                          'BUL', 'code', null),
  ('STR',    'C2111', 'Công trình, kiến trúc khác',     'Other structure',                   'STR', 'code', null),
  ('INF',    'C2111', 'Cơ sở hạ tầng kỹ thuật',         'Infrastructure, constructual item', 'INF', 'code', null),
  ('MES',    'C2112', 'Hệ thống điện và cơ khí',        'Mechanical & Electrical Systems',   'MES', 'code', null),
  ('FFP',    'C2112', 'Thiết bị, hệ thống PCCC',        'Fire Fighting & Prevention Equipment/System', 'FFP', 'code', null),
  ('ITO',    'C2112', 'Thiết bị CNTT dùng cho kinh doanh', 'IT Equipment for operation',      'ITO', 'code', null),
  ('KME',    'C2112', 'Thiết bị, vật dụng bếp',         'Kitchen Machinery & Equipment',     'KME', 'code', null),
  ('FUR',    'C2112', 'Thiết bị, vật dụng nội thất',    'Furniture, artworks',               'FUR', 'code', null),
  ('SME',    'C2112', 'Máy móc, thiết bị vệ sinh',      'Sanitary Machinery & Equipment',    'SME', 'code', null),
  -- File gốc liệt kê OME ở CẢ C2112 lẫn C2114. Mã con là khóa chính nên chỉ
  -- được một mã cha; user chốt 2026-09-15 giữ đúng mã OME của file gốc và
  -- chọn C2112, khớp với TOÀN BỘ Mã Tài Sản thật quét được
  -- (ADM.C2112.OME, FIN.C2112.OME, SMD.C2112.OME — không có cái nào C2114).
  ('OME',    'C2112', 'Máy móc, thiết bị khác',         'Other Machinery & Equipment',       'OME', 'code',
             'File gốc liệt kê OME ở cả C2112 và C2114; đã chốt C2112 theo dữ liệu thật. Nhóm C2114 vì vậy chỉ còn ITM.'),
  ('TTV',    'C2113', 'Trang thiết bị và phương tiện vận tải', 'Transportation and transmission vehicles', 'TTV', 'code', null),
  ('ITM',    'C2114', 'Thiết bị CNTT dùng cho quản trị', 'IT Equipment for management',       'ITM', 'code', null),
  ('PWP',    'C2115', 'Cây lâu năm, súc vật làm việc và cho sản phẩm', 'Perennial trees, working and producing animals', 'PWP', 'code', null),
  ('OTA',    'C2118', 'Tài sản cố định hữu hình khác',  'Other tangible asset',              'OTA', 'code', null),
  ('LUR',    'C2131', 'Quyền sử dụng đất',              'Land use rights',                   'LUR', 'code', null),
  ('CPR',    'C2132', 'Quyền phát hành',                'Copyrights',                        'CPR', 'code', null),
  ('PAT',    'C2133', 'Bản quyền, bằng sáng chế',       'Patent',                            'PAT', 'code', null),
  ('TMK',    'C2134', 'Nhãn hiệu độc quyền, tên thương mại', 'Trademarks, trade names',      'TMK', 'code', null),
  ('CTP',    'C2135', 'Chương trình, phần mềm',         'Computer software',                 'CTP', 'code',
             'Đích chuyển đổi cho tài sản VÔ HÌNH có đơn giá > 30 triệu.'),
  ('LRP',    'C2136', 'Giấy phép và giấy phép nhượng quyền', 'License and right concession permits', 'LRP', 'code', null),
  ('OIA',    'C2138', 'Tài sản cố định vô hình khác',   'Other intangible asset',            'OIA', 'code', null),
  ('STU',    'C2421', 'CCDC ngắn hạn - quản lý theo mã',      'Short-term tools, managed by code',     'STU', 'code',     null),
  ('STG',    'C2421', 'CCDC ngắn hạn - quản lý theo số lượng','Short-term tools, managed by quantity', 'STG', 'quantity', null),
  ('STG-QR', 'C2421', 'CCDC ngắn hạn - theo số lượng, dán QR','Short-term tools, by quantity, QR label','STG', 'quantity',
             'Mã Tài Sản hiển thị CHỮ "STG" (bỏ -QR) nên DÙNG CHUNG dãy số với STG.'),
  ('LTU',    'C2422', 'CCDC dài hạn - quản lý theo mã',       'Long-term tools, managed by code',      'LTU', 'code',     null),
  ('LTG',    'C2422', 'CCDC dài hạn - quản lý theo số lượng', 'Long-term tools, managed by quantity',  'LTG', 'quantity', null),
  ('LTG-QR', 'C2422', 'CCDC dài hạn - theo số lượng, dán QR', 'Long-term tools, by quantity, QR label','LTG', 'quantity',
             'Mã Tài Sản hiển thị CHỮ "LTG" (bỏ -QR) nên DÙNG CHUNG dãy số với LTG.')
on conflict (code) do update
  set group_code = excluded.group_code, name_vi = excluded.name_vi, name_en = excluded.name_en,
      label_letters = excluded.label_letters, manage_by = excluded.manage_by, note = excluded.note;

-- ---------------------------------------------------------------------
-- 4. Đơn vị tính
-- ---------------------------------------------------------------------
insert into am_unit (code, name_vi, name_en, sort_order) values
  ('pcs',     'cái',       'piece',   10),
  ('set',     'bộ',        'set',     20),
  ('box',     'hộp',       'box',     30),
  ('package', 'gói/kiện',  'package', 40),
  ('kg',      'kilôgam',   'kilogram',50),
  ('m',       'mét',       'metre',   60),
  ('m2',      'mét vuông', 'square metre', 70),
  ('m3',      'mét khối',  'cubic metre',  80),
  ('litre',   'lít',       'litre',   90),
  ('kwh',     'kWh',       'kilowatt hour', 100),
  ('time',    'lần',       'time',    110),
  ('room',    'phòng',     'room',    120),
  ('floor',   'tầng',      'floor',   130),
  ('pot',     'chậu',      'pot',     140),
  ('tubes',   'tuýp',      'tube',    150)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- 5. Khởi tạo bộ đếm mã vạch (chưa có số nào -> bắt đầu từ 1)
--    Nạp số thật từ register bằng am_seed_from_codes() sau khi import.
-- ---------------------------------------------------------------------
insert into am_barcode_seq (kind, next_val, max_val) values
  ('unique', 1, 899999999),
  ('low',    1, 99999999)
on conflict (kind) do nothing;

insert into am_alr_seq (singleton, next_val) values (true, 1)
on conflict (singleton) do nothing;


-- ####################################################################
-- ##  02b_seed_origin.sql
-- ####################################################################

-- =====================================================================
-- asset-intake — Danh mục xuất xứ: ISO 3166-1 alpha-2 (đầy đủ)
-- Danh sách phải ĐẦY ĐỦ thì quy tắc "chỉ gán mã khi khớp đúng MỘT quốc gia
-- có thật" mới đúng — thiếu nước nào là nước đó bị xếp nhầm 'not_a_country'.
-- Chạy SAU 01_schema.sql.
-- =====================================================================

insert into am_origin (iso2, name_en) values
('AD','Andorra'),('AE','United Arab Emirates'),('AF','Afghanistan'),('AG','Antigua and Barbuda'),
('AI','Anguilla'),('AL','Albania'),('AM','Armenia'),('AO','Angola'),('AQ','Antarctica'),
('AR','Argentina'),('AS','American Samoa'),('AT','Austria'),('AU','Australia'),('AW','Aruba'),
('AX','Aland Islands'),('AZ','Azerbaijan'),('BA','Bosnia and Herzegovina'),('BB','Barbados'),
('BD','Bangladesh'),('BE','Belgium'),('BF','Burkina Faso'),('BG','Bulgaria'),('BH','Bahrain'),
('BI','Burundi'),('BJ','Benin'),('BL','Saint Barthelemy'),('BM','Bermuda'),('BN','Brunei Darussalam'),
('BO','Bolivia'),('BQ','Bonaire, Sint Eustatius and Saba'),('BR','Brazil'),('BS','Bahamas'),
('BT','Bhutan'),('BV','Bouvet Island'),('BW','Botswana'),('BY','Belarus'),('BZ','Belize'),
('CA','Canada'),('CC','Cocos (Keeling) Islands'),('CD','Congo, Democratic Republic of the'),
('CF','Central African Republic'),('CG','Congo'),('CH','Switzerland'),('CI','Cote d Ivoire'),
('CK','Cook Islands'),('CL','Chile'),('CM','Cameroon'),('CN','China'),('CO','Colombia'),
('CR','Costa Rica'),('CU','Cuba'),('CV','Cabo Verde'),('CW','Curacao'),('CX','Christmas Island'),
('CY','Cyprus'),('CZ','Czechia'),('DE','Germany'),('DJ','Djibouti'),('DK','Denmark'),
('DM','Dominica'),('DO','Dominican Republic'),('DZ','Algeria'),('EC','Ecuador'),('EE','Estonia'),
('EG','Egypt'),('EH','Western Sahara'),('ER','Eritrea'),('ES','Spain'),('ET','Ethiopia'),
('FI','Finland'),('FJ','Fiji'),('FK','Falkland Islands'),('FM','Micronesia'),('FO','Faroe Islands'),
('FR','France'),('GA','Gabon'),('GB','United Kingdom'),('GD','Grenada'),('GE','Georgia'),
('GF','French Guiana'),('GG','Guernsey'),('GH','Ghana'),('GI','Gibraltar'),('GL','Greenland'),
('GM','Gambia'),('GN','Guinea'),('GP','Guadeloupe'),('GQ','Equatorial Guinea'),('GR','Greece'),
('GS','South Georgia and the South Sandwich Islands'),('GT','Guatemala'),('GU','Guam'),
('GW','Guinea-Bissau'),('GY','Guyana'),('HK','Hong Kong'),('HM','Heard Island and McDonald Islands'),
('HN','Honduras'),('HR','Croatia'),('HT','Haiti'),('HU','Hungary'),('ID','Indonesia'),
('IE','Ireland'),('IL','Israel'),('IM','Isle of Man'),('IN','India'),
('IO','British Indian Ocean Territory'),('IQ','Iraq'),('IR','Iran'),('IS','Iceland'),
('IT','Italy'),('JE','Jersey'),('JM','Jamaica'),('JO','Jordan'),('JP','Japan'),('KE','Kenya'),
('KG','Kyrgyzstan'),('KH','Cambodia'),('KI','Kiribati'),('KM','Comoros'),
('KN','Saint Kitts and Nevis'),('KP','Korea, Democratic People s Republic of'),
('KR','Korea, Republic of'),('KW','Kuwait'),('KY','Cayman Islands'),('KZ','Kazakhstan'),
('LA','Lao People s Democratic Republic'),('LB','Lebanon'),('LC','Saint Lucia'),
('LI','Liechtenstein'),('LK','Sri Lanka'),('LR','Liberia'),('LS','Lesotho'),('LT','Lithuania'),
('LU','Luxembourg'),('LV','Latvia'),('LY','Libya'),('MA','Morocco'),('MC','Monaco'),
('MD','Moldova'),('ME','Montenegro'),('MF','Saint Martin (French part)'),('MG','Madagascar'),
('MH','Marshall Islands'),('MK','North Macedonia'),('ML','Mali'),('MM','Myanmar'),
('MN','Mongolia'),('MO','Macao'),('MP','Northern Mariana Islands'),('MQ','Martinique'),
('MR','Mauritania'),('MS','Montserrat'),('MT','Malta'),('MU','Mauritius'),('MV','Maldives'),
('MW','Malawi'),('MX','Mexico'),('MY','Malaysia'),('MZ','Mozambique'),('NA','Namibia'),
('NC','New Caledonia'),('NE','Niger'),('NF','Norfolk Island'),('NG','Nigeria'),('NI','Nicaragua'),
('NL','Netherlands'),('NO','Norway'),('NP','Nepal'),('NR','Nauru'),('NU','Niue'),
('NZ','New Zealand'),('OM','Oman'),('PA','Panama'),('PE','Peru'),('PF','French Polynesia'),
('PG','Papua New Guinea'),('PH','Philippines'),('PK','Pakistan'),('PL','Poland'),
('PM','Saint Pierre and Miquelon'),('PN','Pitcairn'),('PR','Puerto Rico'),('PS','Palestine'),
('PT','Portugal'),('PW','Palau'),('PY','Paraguay'),('QA','Qatar'),('RE','Reunion'),
('RO','Romania'),('RS','Serbia'),('RU','Russian Federation'),('RW','Rwanda'),
('SA','Saudi Arabia'),('SB','Solomon Islands'),('SC','Seychelles'),('SD','Sudan'),
('SE','Sweden'),('SG','Singapore'),('SH','Saint Helena, Ascension and Tristan da Cunha'),
('SI','Slovenia'),('SJ','Svalbard and Jan Mayen'),('SK','Slovakia'),('SL','Sierra Leone'),
('SM','San Marino'),('SN','Senegal'),('SO','Somalia'),('SR','Suriname'),('SS','South Sudan'),
('ST','Sao Tome and Principe'),('SV','El Salvador'),('SX','Sint Maarten (Dutch part)'),
('SY','Syrian Arab Republic'),('SZ','Eswatini'),('TC','Turks and Caicos Islands'),('TD','Chad'),
('TF','French Southern Territories'),('TG','Togo'),('TH','Thailand'),('TJ','Tajikistan'),
('TK','Tokelau'),('TL','Timor-Leste'),('TM','Turkmenistan'),('TN','Tunisia'),('TO','Tonga'),
('TR','Turkiye'),('TT','Trinidad and Tobago'),('TV','Tuvalu'),('TW','Taiwan'),
('TZ','Tanzania'),('UA','Ukraine'),('UG','Uganda'),
('UM','United States Minor Outlying Islands'),('US','United States of America'),
('UY','Uruguay'),('UZ','Uzbekistan'),('VA','Holy See'),('VC','Saint Vincent and the Grenadines'),
('VE','Venezuela'),('VG','Virgin Islands (British)'),('VI','Virgin Islands (U.S.)'),
('VN','Viet Nam'),('VU','Vanuatu'),('WF','Wallis and Futuna'),('WS','Samoa'),('YE','Yemen'),
('YT','Mayotte'),('ZA','South Africa'),('ZM','Zambia'),('ZW','Zimbabwe')
on conflict (iso2) do update set name_en = excluded.name_en;

-- Tên tiếng Việt cho các nước hay gặp trong hồ sơ mua sắm
update am_origin set name_vi = v.vi from (values
  ('VN','Việt Nam'),('CN','Trung Quốc'),('JP','Nhật Bản'),('KR','Hàn Quốc'),
  ('TW','Đài Loan'),('TH','Thái Lan'),('MY','Malaysia'),('SG','Singapore'),
  ('ID','Indonesia'),('PH','Philippines'),('IN','Ấn Độ'),('US','Mỹ'),
  ('GB','Anh'),('DE','Đức'),('FR','Pháp'),('IT','Ý'),('ES','Tây Ban Nha'),
  ('NL','Hà Lan'),('BE','Bỉ'),('CH','Thụy Sĩ'),('SE','Thụy Điển'),('AT','Áo'),
  ('PL','Ba Lan'),('TR','Thổ Nhĩ Kỳ'),('RU','Nga'),('AU','Úc'),('NZ','New Zealand'),
  ('CA','Canada'),('MX','Mexico'),('BR','Brazil'),('HK','Hồng Kông'),('MO','Ma Cao'),
  ('KH','Campuchia'),('LA','Lào'),('MM','Myanmar'),('AE','UAE'),('DK','Đan Mạch'),
  ('NO','Na Uy'),('FI','Phần Lan'),('PT','Bồ Đào Nha'),('CZ','Séc'),('IL','Israel')
) as v(code, vi) where am_origin.iso2 = v.code;

-- ---------------------------------------------------------------------
-- Bí danh 1-1. CHỈ thêm khi chuỗi chỉ đích danh MỘT quốc gia.
-- alias_norm phải là kết quả của am_norm() (lower, bỏ dấu, gộp khoảng trắng).
-- ---------------------------------------------------------------------
insert into am_origin_alias (alias_norm, iso2, note) values
  ('usa','US',null),('u.s.a','US',null),('u.s.a.','US',null),('us','US',null),
  ('united states','US',null),('america','US',null),('my','US','"Mỹ" đã bỏ dấu'),
  ('viet nam','VN',null),('vietnam','VN',null),('vn','VN',null),
  ('china','CN',null),('p.r.c','CN',null),('prc','CN',null),('trung quoc','CN',null),
  ('chinese','CN',null),('made in china','CN',null),
  ('uk','GB',null),('england','GB',null),('great britain','GB',null),
  ('united kingdom','GB',null),('anh','GB',null),
  ('korea','KR',null),('south korea','KR',null),('han quoc','KR',null),('kr','KR',null),
  ('japan','JP',null),('nhat ban','JP',null),('jp','JP',null),
  ('taiwan','TW',null),('dai loan','TW',null),('tw','TW',null),
  ('thailand','TH',null),('thai lan','TH',null),
  ('malaysia','MY',null),('singapore','SG',null),('indonesia','ID',null),
  ('germany','DE',null),('duc','DE',null),('deutschland','DE',null),
  ('france','FR',null),('phap','FR',null),
  ('italy','IT',null),('italia','IT',null),('y','IT',null),
  ('spain','ES',null),('netherlands','NL',null),('holland','NL',null),
  ('switzerland','CH',null),('turkey','TR',null),('turkiye','TR',null),
  ('russia','RU',null),('australia','AU',null),('canada','CA',null),
  ('india','IN',null),('an do','IN',null),
  ('hong kong','HK',null),('hongkong','HK',null),
  ('uae','AE',null),('united arab emirates','AE',null),
  ('czech','CZ',null),('czech republic','CZ',null),
  ('brasil','BR',null)
on conflict (alias_norm) do update set iso2 = excluded.iso2, note = excluded.note;

-- ---------------------------------------------------------------------
-- Các chuỗi CỐ Ý không map — để UI giải thích vì sao bỏ trống xuất xứ.
-- ---------------------------------------------------------------------
insert into am_origin_rejected (raw_norm, raw_sample, reason) values
  ('asia',   'Asia',   'not_a_country'),
  ('eu',     'EU',     'not_a_country'),
  ('europe', 'Europe', 'not_a_country'),
  ('asean',  'ASEAN',  'not_a_country'),
  ('imported','Imported','not_a_country'),
  ('nhap khau','Nhập khẩu','not_a_country'),
  ('oem',    'OEM',    'not_a_country'),
  ('n/a',    'N/A',    'not_a_country')
on conflict (raw_norm) do nothing;


-- ####################################################################
-- ##  02c_seed_location.sql
-- ####################################################################

-- =====================================================================
-- asset-intake — Seed vị trí (HỆ MÃ DÀI, theo lựa chọn của user 2026-09-15)
-- Nguồn: dòng "Bộ phận:" trong các file
--   ...\ASSET COUNT\Kiểm kê 07.2025\bien-ban-kiem-ke-{FIN,ADM,SMD}.xlsx
--   ...\ASSET COUNT\BBKK-FIN, SMD, ADM.xlsx
-- Cây suy ra từ chính mã: S -> S<tầng>00 / SB<hầm>00 -> phòng.
-- SINH TỰ ĐỘNG - đừng sửa tay, sửa scripts/genloc.ps1 rồi chạy lại.
-- Chạy SAU 02_seed_master.sql (cần am_org đã có).
-- =====================================================================

insert into am_location (code, name, kind, parent_code, dept_code, is_dept_office) values
  ('S', 'Sofitel Saigon Plaza Building / Toà nhà Sofitel Saigon Plaza', 'building', null, null, false),
  ('S0100', 'The 1st floor/ Lầu 01', 'floor', 'S', null, false),
  ('S0101B0', 'Banquet store', 'room', 'S0100', null, false),
  ('S0103B0', 'It office', 'room', 'S0100', 'ITD', true),
  ('S0104B0', 'Director of Operation office', 'room', 'S0100', null, false),
  ('S0105B0', 'Back office', 'room', 'S0100', null, false),
  ('S0107B0', 'Bakery shop', 'room', 'S0100', null, false),
  ('S0109P0', 'Boudoir bar', 'room', 'S0100', null, false),
  ('S0111B0', 'Kitchen office', 'room', 'S0100', 'KIT', true),
  ('S0112B0', 'Banquet kitchen', 'room', 'S0100', null, false),
  ('S0113B0', 'Pastry kitchen', 'room', 'S0100', null, false),
  ('S0200', 'The 2nd floor/ Lầu 02', 'floor', 'S', null, false),
  ('S0202B1', 'Bistro kitchen', 'room', 'S0200', null, false),
  ('S0203B2', 'Mezz hot kitchen', 'room', 'S0200', null, false),
  ('S0203P0', 'Mezz restaurant', 'room', 'S0200', null, false),
  ('S0300', 'The 3rd floor/ Lầu 03', 'floor', 'S', null, false),
  ('S0301B0', 'GM office', 'room', 'S0300', null, false),
  ('S0302B0', 'Sale office', 'room', 'S0300', 'SMD', true),
  ('S0303P1', 'Business center', 'room', 'S0300', null, false),
  ('S0304G0', 'Turquoise', 'room', 'S0300', null, false),
  ('S0307G0', 'Emerald', 'room', 'S0300', null, false),
  ('S0312P4', 'Female locker fitness', 'room', 'S0300', null, false),
  ('S0313B2', 'Fitness store', 'room', 'S0300', null, false),
  ('S0400', 'The 4th floor/ Lầu 04', 'floor', 'S', null, false),
  ('S0500', 'The 5th floor/ Lầu 05', 'floor', 'S', null, false),
  ('S0600', 'The 6th floor/ Lầu 06', 'floor', 'S', null, false),
  ('S0700', 'The 7th floor/ Lầu 07', 'floor', 'S', null, false),
  ('S0800', 'The 8th floor/ Lầu 08', 'floor', 'S', null, false),
  ('S0900', 'The 9th floor/ Lầu 09', 'floor', 'S', null, false),
  ('S1000', 'The 10th floor/ Lầu 10', 'floor', 'S', null, false),
  ('S1100', 'Lầu 11th floor/ Lầu 11', 'floor', 'S', null, false),
  ('S1200', 'The 12th floor/ Lầu 12', 'floor', 'S', null, false),
  ('S1400', 'The 14th floor/ Lầu 14', 'floor', 'S', null, false),
  ('S1500', 'The 15th floor/ Lầu 15', 'floor', 'S', null, false),
  ('S1600', 'The 16th floor/ Lầu 16', 'floor', 'S', null, false),
  ('S1700', 'The 17th floor/ Lầu 17', 'floor', 'S', null, false),
  ('S1800', 'The 18th floor/ Lầu 18', 'floor', 'S', null, false),
  ('S1809B0', 'Club kitchen', 'room', 'S1800', null, false),
  ('S1809P0', 'Club lounge', 'room', 'S1800', null, false),
  ('S1812', 'Pool bar', 'room', 'S1800', null, false),
  ('S1900', 'The 19th floor/ Lầu 19', 'floor', 'S', null, false),
  ('S1903G0', 'Room 1903', 'room', 'S1900', null, false),
  ('S1905G0', 'Room 1905', 'room', 'S1900', null, false),
  ('S1907G0', 'Room 1907', 'room', 'S1900', null, false),
  ('S1909G0', 'Room 1909', 'room', 'S1900', null, false),
  ('S1912G0', 'Room 1912', 'room', 'S1900', null, false),
  ('S1914G0', 'Room 1914', 'room', 'S1900', null, false),
  ('S1916G0', 'Room 1916', 'room', 'S1900', null, false),
  ('S1918G0', 'Room 1918', 'room', 'S1900', null, false),
  ('S2000', 'The 20th floor/ Lầu 20', 'floor', 'S', null, false),
  ('S2000E3', 'SMATV room / Single Master Antenna Television', 'room', 'S2000', null, false),
  ('S2003G0', 'Room 2003', 'room', 'S2000', null, false),
  ('S2005G0', 'Room 2005', 'room', 'S2000', null, false),
  ('S2006G0', 'Room 2006', 'room', 'S2000', null, false),
  ('S2015G0', 'Room 2015', 'room', 'S2000', null, false),
  ('S203', 'Le 17 Bistro restaurant', 'area', 'S', null, false),
  ('SB100', 'Basement 1/ Tầng hầm 1', 'floor', 'S', null, false),
  ('SB107P0', 'Casual labour locker', 'room', 'SB100', null, false),
  ('SB109B0', 'Reservation office', 'room', 'SB100', null, false),
  ('SB110B0', 'Dail 2 office', 'room', 'SB100', null, false),
  ('SB111B0', 'Cashier office', 'room', 'SB100', null, false),
  ('SB112E0', 'PABX room', 'room', 'SB100', null, false),
  ('SB113E0', 'MDF room', 'room', 'SB100', null, false),
  ('SB115B0', 'Laundry area', 'room', 'SB100', null, false),
  ('SB117B0', 'Housekeeping office', 'room', 'SB100', 'HKD', true),
  ('SB120B0', 'Finance office', 'room', 'SB100', 'FIN', true),
  ('SB121', 'HR office', 'room', 'SB100', 'ADM', true),
  ('SB121B0', 'Receiving office', 'room', 'SB100', null, false),
  ('SB122B0', 'Rreceiving area', 'room', 'SB100', null, false),
  ('SB123E0', 'CCTV room', 'room', 'SB100', null, false),
  ('SB124B0', 'Security office', 'room', 'SB100', 'SEC', true),
  ('SB130B0', 'Empty Bottle Store', 'room', 'SB100', null, false),
  ('SB131B0', 'General Store', 'room', 'SB100', null, false),
  ('SB134B1', 'Canteen kitchen', 'room', 'SB100', null, false),
  ('SB134B2', 'Canteen Store', 'room', 'SB100', null, false),
  ('SB134P0', 'Canteen area', 'room', 'SB100', null, false),
  ('SB138B0', 'Doctor room', 'room', 'SB100', null, false),
  ('SB139B0', 'Engineering Building workshop', 'room', 'SB100', null, false),
  ('SB140B0', 'LPG store', 'room', 'SB100', null, false),
  ('SB141B0', 'Engineering workshop', 'room', 'SB100', 'ENG', true),
  ('SB142B0', 'F&B office', 'room', 'SB100', 'FBD', true),
  ('SB143B0', 'Male locker B1', 'room', 'SB100', null, false)
on conflict (code) do update
  set name = excluded.name, kind = excluded.kind, parent_code = excluded.parent_code;

-- Mã không theo quy luật -> gắn tạm vào toà nhà, cần xác nhận:
--   S203   "Le 17 Bistro restaurant"  (nhiều khả năng là S0203, trùng tầng với
--          S0203P0 "Mezz restaurant")
--   SB121  "HR office" vs SB121B0 "Receiving office" — cùng số phòng, khác hậu tố
-- Phòng ban FOD chưa có office mặc định: danh sách vị trí không có "Front office".

-- ####################################################################
-- ##  03_functions.sql
-- ####################################################################

-- =====================================================================
-- asset-intake — Hàm nghiệp vụ: chuẩn hóa, bộ đếm, sinh mã, phân loại
-- Chạy SAU 01_schema.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- Chuẩn hóa chuỗi để so khớp (product catalogue, xuất xứ, tên phòng ban)
--
-- Cố tình KHÔNG dùng extension unaccent: trên Supabase nó nằm ở schema
-- "extensions", nên hàm SECURITY DEFINER đặt search_path=public sẽ không
-- thấy. translate() bao trọn bộ dấu tiếng Việt, thật sự IMMUTABLE và
-- không phụ thuộc cài đặt nào.
-- ---------------------------------------------------------------------
create or replace function am_norm(p text)
returns text
language sql
immutable
strict
as $$
  select regexp_replace(
           trim(translate(
             lower(p),
             'áàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ'
             || 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
             'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'
             || 'aaaaaaceeeeiiiinooooouuuuyy'
           )),
           '\s+', ' ', 'g')
$$;
comment on function am_norm(text) is
  'lower + bỏ dấu tiếng Việt + gộp khoảng trắng. Dùng cho am_product.raw_name_norm và am_origin_alias.alias_norm.';

-- ---------------------------------------------------------------------
-- CHỮ hiển thị trong Mã Tài Sản: bỏ hậu tố '-QR'
-- LTG-QR -> LTG, STG-QR -> STG.  Đây là khóa dùng chung dãy số.
-- ---------------------------------------------------------------------
create or replace function am_letters(p_category_code text)
returns text
language sql
immutable
strict
as $$
  select replace(upper(trim(p_category_code)), '-QR', '')
$$;

-- ---------------------------------------------------------------------
-- Định dạng Mã Vạch từ số nguyên của bộ đếm
--   unique : JVC. + 9 chữ số                 (1        -> JVC.000000001)
--   low    : JVC.9 + 8 chữ số                (1        -> JVC.900000001)
-- ---------------------------------------------------------------------
create or replace function am_format_barcode(p_kind text, p_val bigint)
returns text
language plpgsql
immutable
as $$
begin
  if p_kind = 'unique' then
    if p_val < 1 or p_val > 899999999 then
      raise exception 'Số mã vạch unique ngoài dải cho phép: %', p_val;
    end if;
    return 'JVC.' || lpad(p_val::text, 9, '0');
  elsif p_kind = 'low' then
    if p_val < 1 or p_val > 99999999 then
      raise exception 'Số mã vạch low-value ngoài dải cho phép: %', p_val;
    end if;
    return 'JVC.9' || lpad(p_val::text, 8, '0');
  else
    raise exception 'kind không hợp lệ: %', p_kind;
  end if;
end;
$$;

-- Tách ngược: chuỗi mã vạch -> (kind, số nguyên). Dùng khi nạp bộ đếm từ register cũ.
create or replace function am_parse_barcode(p_code text)
returns table (kind text, val bigint)
language plpgsql
immutable
as $$
declare
  d text;
begin
  if p_code !~ '^JVC\.[0-9]{9}$' then
    return;
  end if;
  d := substring(p_code from 5);          -- 9 chữ số
  if left(d, 1) = '9' then
    kind := 'low';
    val  := substring(d from 2)::bigint;  -- 8 chữ số sau số 9
  else
    kind := 'unique';
    val  := d::bigint;
  end if;
  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- Ghép Mã Tài Sản
--   [Mã Phòng Ban].[Nhóm cha].[CHỮ].[Năm mua].[5 chữ số]
-- ---------------------------------------------------------------------
create or replace function am_build_asset_code(
  p_dept text, p_group text, p_letters text, p_year int, p_seq int
)
returns text
language plpgsql
immutable
as $$
begin
  if p_seq < 1 or p_seq > 99999 then
    raise exception 'Số thứ tự vượt 5 chữ số: %', p_seq;
  end if;
  return p_dept || '.' || p_group || '.' || p_letters || '.'
         || p_year::text || '.' || lpad(p_seq::text, 5, '0');
end;
$$;

-- =====================================================================
-- BỘ ĐẾM — cấp phát nguyên tử
-- Tất cả đều SECURITY DEFINER: ứng dụng KHÔNG được ghi thẳng vào bảng đếm.
-- =====================================================================

-- Cấp p_count số thứ tự liên tiếp cho (phòng ban, CHỮ). Trả về số ĐẦU TIÊN.
create or replace function am_alloc_asset_seq(
  p_dept        text,
  p_letters     text,
  p_count       int default 1,
  p_shipment_id bigint default null,
  p_actor       text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first int;
begin
  if p_count < 1 then
    raise exception 'p_count phải >= 1';
  end if;
  p_dept    := upper(trim(p_dept));
  p_letters := am_letters(p_letters);   -- phòng khi gọi nhầm bằng mã có -QR

  insert into am_asset_seq (dept_code, letters, next_seq)
  values (p_dept, p_letters, 1)
  on conflict (dept_code, letters) do nothing;

  update am_asset_seq
     set next_seq = next_seq + p_count,
         updated_at = now()
   where dept_code = p_dept and letters = p_letters
  returning next_seq - p_count into v_first;

  if v_first is null then
    raise exception 'Không cấp được số thứ tự cho (%, %)', p_dept, p_letters;
  end if;
  if v_first + p_count - 1 > 99999 then
    raise exception 'Dãy số của (%, %) đã vượt 5 chữ số', p_dept, p_letters;
  end if;

  insert into am_counter_log (counter, scope, from_val, to_val, shipment_id, actor)
  values ('asset_seq', p_dept || '|' || p_letters,
          v_first, v_first + p_count - 1, p_shipment_id, p_actor);

  return v_first;
end;
$$;

-- Cấp p_count mã vạch liên tiếp. Trả về số ĐẦU TIÊN (chưa định dạng).
create or replace function am_alloc_barcode(
  p_kind        text,
  p_count       int default 1,
  p_shipment_id bigint default null,
  p_actor       text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_first bigint;
  v_max   bigint;
begin
  if p_count < 1 then
    raise exception 'p_count phải >= 1';
  end if;
  if p_kind not in ('unique', 'low') then
    raise exception 'kind không hợp lệ: %', p_kind;
  end if;

  update am_barcode_seq
     set next_val = next_val + p_count,
         updated_at = now()
   where kind = p_kind
  returning next_val - p_count, max_val into v_first, v_max;

  if v_first is null then
    raise exception 'Chưa khởi tạo bộ đếm mã vạch cho kind=%', p_kind;
  end if;
  if v_first + p_count - 1 > v_max then
    raise exception 'Dải mã vạch % đã cạn (max %)', p_kind, v_max;
  end if;

  insert into am_counter_log (counter, scope, from_val, to_val, shipment_id, actor)
  values ('barcode', p_kind, v_first, v_first + p_count - 1, p_shipment_id, p_actor);

  return v_first;
end;
$$;

-- Số hiệu ALR kế tiếp: AL.<n>
create or replace function am_alloc_alr_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v int;
begin
  insert into am_alr_seq (singleton, next_val) values (true, 1)
  on conflict (singleton) do nothing;

  update am_alr_seq set next_val = next_val + 1
   where singleton returning next_val - 1 into v;

  return 'AL.' || v::text;
end;
$$;

-- =====================================================================
-- NẠP BỘ ĐẾM TỪ REGISTER CŨ (chỉ NÂNG, không bao giờ hạ)
-- =====================================================================

create or replace function am_seed_asset_seq(
  p_dept text, p_letters text, p_max_seen int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v int;
begin
  p_dept    := upper(trim(p_dept));
  p_letters := am_letters(p_letters);

  insert into am_asset_seq (dept_code, letters, next_seq)
  values (p_dept, p_letters, p_max_seen + 1)
  on conflict (dept_code, letters) do update
    set next_seq   = greatest(am_asset_seq.next_seq, excluded.next_seq),
        updated_at = now()
  returning next_seq into v;

  return v;
end;
$$;

create or replace function am_seed_barcode(p_kind text, p_max_seen bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v bigint;
begin
  update am_barcode_seq
     set next_val   = greatest(next_val, p_max_seen + 1),
         updated_at = now()
   where kind = p_kind
  returning next_val into v;

  if v is null then
    raise exception 'Chưa khởi tạo bộ đếm mã vạch cho kind=%', p_kind;
  end if;
  return v;
end;
$$;

-- Nạp hàng loạt từ một mảng chuỗi lấy ra khỏi file register bất kỳ
-- (quét cả Mã Tài Sản lẫn Mã Vạch, bỏ qua chuỗi không đúng định dạng).
-- Trả về bảng tóm tắt để UI hiển thị "đã nâng bộ đếm nào lên bao nhiêu".
create or replace function am_seed_from_codes(p_codes text[])
returns table (scope text, kind text, max_seen bigint, next_val bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  -- 1) Mã Tài Sản: <DEPT>.<C2xxx>.<LLL>.<YYYY>.<NNNNN>
  for r in
    select  m[1] as dept, m[3] as letters, max(m[5]::int) as mx
    from    unnest(p_codes) c,
            lateral regexp_match(
              upper(trim(c)),
              '^([A-Z]{2,5})\.(C2[0-9]{3})\.([A-Z]{3})\.([0-9]{4})\.([0-9]{5})$'
            ) m
    where   m is not null
    group by m[1], m[3]
  loop
    scope    := r.dept || '|' || r.letters;
    kind     := 'asset_seq';
    max_seen := r.mx;
    next_val := am_seed_asset_seq(r.dept, r.letters, r.mx);
    return next;
  end loop;

  -- 2) Mã Vạch: JVC.<9 chữ số>
  for r in
    select  p.kind as bk, max(p.val) as mx
    from    unnest(p_codes) c,
            lateral am_parse_barcode(upper(trim(c))) p
    group by p.kind
  loop
    scope    := r.bk;
    kind     := 'barcode';
    max_seen := r.mx;
    next_val := am_seed_barcode(r.bk, r.mx);
    return next;
  end loop;
end;
$$;

-- Đối chiếu lại bộ đếm với chính bảng am_asset (dùng khi nghi ngờ lệch).
create or replace function am_audit_counters()
returns table (scope text, counter_next bigint, table_max bigint, gap bigint)
language sql
stable
as $$
  select  s.dept_code || '|' || s.letters,
          s.next_seq::bigint,
          coalesce(a.mx, 0)::bigint,
          s.next_seq::bigint - coalesce(a.mx, 0)::bigint - 1
  from    am_asset_seq s
  left join (
    select dept_code, letters, max(seq) mx from am_asset group by 1, 2
  ) a on a.dept_code = s.dept_code and a.letters = s.letters
  order by 1
$$;

-- =====================================================================
-- QUY TẮC PHÂN LOẠI
-- =====================================================================

-- Quy tắc 1 + 3. KHÔNG tự sửa dữ liệu — chỉ trả về kết luận + cảnh báo
-- để UI bắt người dùng xác nhận.
--
--   asset_kind : 'unique' nếu đơn giá >= ngưỡng (mặc định 5.000.000),
--                ngược lại 'low'
--   violates_capex : đơn giá > 30.000.000 nhưng mã danh mục là CCDC
--   suggested_category : gợi ý mã thay thế
--        - vô hình (license/phần mềm) -> CTP (nhóm C2135)
--        - hữu hình                   -> null, người dùng CHỌN mã thuộc C2112
--                                        đúng bản chất (vd CNTT -> ITO)
create or replace function am_classify(
  p_unit_price    numeric,
  p_category_code text,
  p_is_intangible boolean default false
)
returns table (
  asset_kind         text,
  violates_capex     boolean,
  suggested_category text,
  warnings           text[]
)
language plpgsql
stable
as $$
declare
  v_unique_threshold numeric := coalesce(
    (select (value #>> '{}')::numeric from am_setting where key = 'unique_threshold'),
    5000000);
  v_capex_threshold numeric := coalesce(
    (select (value #>> '{}')::numeric from am_setting where key = 'capex_threshold'),
    30000000);
  -- Danh sách CCDC bị cấm khi > ngưỡng capex, đúng theo quy tắc nghiệp vụ
  v_banned text[] := array['LTU', 'LTG', 'LTG-QR', 'STG-QR'];
  v_grp    record;
begin
  asset_kind         := case when p_unit_price >= v_unique_threshold then 'unique' else 'low' end;
  violates_capex     := false;
  suggested_category := null;
  warnings           := array[]::text[];

  select g.code, g.is_tools, g.is_intangible
    into v_grp
    from am_category c join am_category_group g on g.code = c.group_code
   where c.code = upper(trim(p_category_code));

  if not found then
    warnings := warnings || format('Mã danh mục %s không có trong master data', p_category_code);
    return next;
    return;
  end if;

  if p_unit_price > v_capex_threshold then
    if upper(trim(p_category_code)) = any (v_banned) then
      violates_capex := true;
      if p_is_intangible or v_grp.is_intangible then
        suggested_category := 'CTP';
        warnings := warnings || format(
          'Đơn giá %s > %s và là tài sản VÔ HÌNH: phải chuyển sang C2135/CTP. Không được ép vào C2112.',
          to_char(p_unit_price, 'FM999,999,999,999'),
          to_char(v_capex_threshold, 'FM999,999,999,999'));
      else
        warnings := warnings || format(
          'Đơn giá %s > %s: không được để mã CCDC %s. Chọn mã thuộc nhóm C2112 đúng bản chất (vd thiết bị CNTT -> ITO).',
          to_char(p_unit_price, 'FM999,999,999,999'),
          to_char(v_capex_threshold, 'FM999,999,999,999'),
          p_category_code);
      end if;
    elsif v_grp.is_tools then
      -- STU / STG chưa nằm trong danh sách cấm được nêu rõ, nhưng vẫn là CCDC
      warnings := warnings || format(
        'Đơn giá %s > %s nhưng mã %s vẫn thuộc nhóm CCDC %s — cần kế toán xác nhận.',
        to_char(p_unit_price, 'FM999,999,999,999'),
        to_char(v_capex_threshold, 'FM999,999,999,999'),
        p_category_code, v_grp.code);
    end if;
  end if;

  if p_is_intangible and not v_grp.is_intangible then
    warnings := warnings || format(
      'Đánh dấu VÔ HÌNH nhưng mã %s thuộc nhóm hữu hình %s.', p_category_code, v_grp.code);
  end if;

  return next;
end;
$$;

-- ---------------------------------------------------------------------
-- Xuất xứ: chỉ trả mã khi khớp ĐÚNG MỘT quốc gia thật.
-- Nhiều quốc gia ("USA/Mexico/China/Singapore") hoặc không phải quốc gia
-- ("Asia", "EU") -> trả null kèm lý do, KHÔNG giữ text gốc, KHÔNG chọn đại diện.
-- ---------------------------------------------------------------------
create or replace function am_resolve_origin(p_raw text)
returns table (iso2 char(2), reason text)
language plpgsql
stable
as $$
declare
  v_norm text;
  v_hits int;
begin
  iso2 := null; reason := null;
  if p_raw is null or trim(p_raw) = '' then
    reason := 'empty';
    return next; return;
  end if;

  v_norm := am_norm(p_raw);

  -- Dấu hiệu liệt kê nhiều quốc gia: / , ; & " and " " hoac "
  if v_norm ~ '[/,;&]|\yand\y|\yhoac\y|\yor\y' then
    reason := 'multi_country';
    return next; return;
  end if;

  select a.iso2 into iso2 from am_origin_alias a where a.alias_norm = v_norm;
  if iso2 is not null then
    reason := 'alias';
    return next; return;
  end if;

  select count(*) into v_hits from am_origin o
   where am_norm(o.name_en) = v_norm or am_norm(o.name_vi) = v_norm;

  if v_hits = 1 then
    select o.iso2 into iso2 from am_origin o
     where am_norm(o.name_en) = v_norm or am_norm(o.name_vi) = v_norm;
    reason := 'exact';
  elsif v_hits > 1 then
    reason := 'ambiguous';
  else
    reason := 'not_a_country';
  end if;

  return next;
end;
$$;


-- ####################################################################
-- ##  04_rls.sql
-- ####################################################################

-- =====================================================================
-- asset-intake — RLS & quyền
-- Bối cảnh: app tĩnh trên GitHub Pages PUBLIC, anon key phát qua link
-- #sbcfg (không nhúng trong file). Vì key có thể lọt ra ngoài, thiết kế
-- theo hướng "hỏng thì cũng không mất sổ tài sản":
--   * Bảng bộ đếm: KHÔNG cấp quyền ghi trực tiếp — chỉ qua hàm định sẵn.
--   * am_asset / am_counter_log: KHÔNG cho DELETE.
--   * Master data: đọc thoải mái, sửa được (công cụ nội bộ).
-- Chạy SAU 03_functions.sql.
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_asset_seq','am_barcode_seq','am_counter_log','am_shipment',
    'am_shipment_line','am_asset','am_alr','am_alr_line','am_alr_seq',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 1. Master data + dữ liệu nghiệp vụ: đọc/ghi được, KHÔNG xóa được sổ tài sản
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  -- Nhóm cho phép đầy đủ (kể cả xóa): master data và dữ liệu nháp
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_shipment','am_shipment_line','am_alr','am_alr_line',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('drop policy if exists %I on %I', t || '_all', t);
    execute format(
      'create policy %I on %I for all to anon, authenticated using (true) with check (true)',
      t || '_all', t);
    execute format('grant select, insert, update, delete on %I to anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Sổ tài sản: thêm & sửa được, KHÔNG xóa (tránh mất mã đã cấp)
--    Muốn loại bỏ một tài sản thì dùng trạng thái/thanh lý, không DELETE.
-- ---------------------------------------------------------------------
drop policy if exists am_asset_read   on am_asset;
drop policy if exists am_asset_write  on am_asset;
drop policy if exists am_asset_modify on am_asset;

create policy am_asset_read   on am_asset for select to anon, authenticated using (true);
create policy am_asset_write  on am_asset for insert to anon, authenticated with check (true);
create policy am_asset_modify on am_asset for update to anon, authenticated using (true) with check (true);
-- cố tình KHÔNG có policy for delete
grant select, insert, update on am_asset to anon, authenticated;

-- Mọi bảng bigserial cần quyền dùng sequence thì INSERT mới chạy được.
-- Bộ đếm nghiệp vụ (am_asset_seq / am_barcode_seq / am_alr_seq) KHÔNG phải
-- sequence của Postgres nên không bị ảnh hưởng bởi lệnh này.
grant usage, select on all sequences in schema public to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Bộ đếm: chỉ đọc. Mọi thay đổi phải đi qua hàm SECURITY DEFINER.
--    Đây là lý do bộ đếm không thể bị "reset" từ trình duyệt.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['am_asset_seq','am_barcode_seq','am_counter_log','am_alr_seq'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Quyền gọi hàm
-- ---------------------------------------------------------------------
grant execute on function am_norm(text)                                   to anon, authenticated;
grant execute on function am_letters(text)                                to anon, authenticated;
grant execute on function am_format_barcode(text, bigint)                 to anon, authenticated;
grant execute on function am_parse_barcode(text)                          to anon, authenticated;
grant execute on function am_build_asset_code(text, text, text, int, int) to anon, authenticated;
grant execute on function am_alloc_asset_seq(text, text, int, bigint, text) to anon, authenticated;
grant execute on function am_alloc_barcode(text, int, bigint, text)       to anon, authenticated;
grant execute on function am_alloc_alr_code()                             to anon, authenticated;
grant execute on function am_seed_asset_seq(text, text, int)              to anon, authenticated;
grant execute on function am_seed_barcode(text, bigint)                   to anon, authenticated;
grant execute on function am_seed_from_codes(text[])                      to anon, authenticated;
grant execute on function am_audit_counters()                             to anon, authenticated;
grant execute on function am_classify(numeric, text, boolean)             to anon, authenticated;
grant execute on function am_resolve_origin(text)                         to anon, authenticated;

-- Các hàm cấp phát phải thuộc sở hữu của vai trò vượt được RLS
alter function am_alloc_asset_seq(text, text, int, bigint, text) owner to postgres;
alter function am_alloc_barcode(text, int, bigint, text)         owner to postgres;
alter function am_alloc_alr_code()                               owner to postgres;
alter function am_seed_asset_seq(text, text, int)                owner to postgres;
alter function am_seed_barcode(text, bigint)                     owner to postgres;
alter function am_seed_from_codes(text[])                        owner to postgres;


-- ####################################################################
-- ##  05_alr.sql
-- ####################################################################

-- =====================================================================
-- asset-intake — Biên bản bàn giao tem nhãn (ALR)
-- Chạy SAU 03_functions.sql. Chạy lại nhiều lần được.
--
-- Số hiệu = 'AL.' + phần ĐUÔI của mã dự án FFE.
--   FFE.CP.28.2023  -> AL.CP.28.2023
--   FFE.KIT.05.2025 -> AL.KIT.05.2025
-- Người lập vẫn sửa tay được; nếu không có mã dự án thì dùng
-- am_alloc_alr_code() để lấy số chạy AL.<n>.
-- =====================================================================

alter table am_alr add column if not exists project_code   text;
alter table am_alr add column if not exists prepared_by    text;
alter table am_alr add column if not exists received_by    text;
alter table am_alr add column if not exists received_dept  text references am_org(code);
alter table am_alr add column if not exists notes_text     text;

comment on column am_alr.project_code is
  'Mã dự án FFE của đợt hàng, vd FFE.KIT.05.2025. Số hiệu biên bản suy ra từ đây.';
comment on column am_alr.notes_text is
  'Phần "Quy trình và lưu ý" in ở cuối biên bản. Lưu theo từng biên bản vì nội dung có thể đổi (bản mẫu 2023 còn nhắc hệ thống Sinnova, nay công ty dùng Beetrack).';

-- ---------------------------------------------------------------------
-- Suy số hiệu biên bản từ mã dự án
-- ---------------------------------------------------------------------
create or replace function am_alr_code_from_project(p_project text)
returns text
language sql
immutable
as $$
  select case
    when p_project is null or btrim(p_project) = '' then null
    when strpos(btrim(p_project), '.') > 0
      then 'AL.' || substring(btrim(p_project) from strpos(btrim(p_project), '.') + 1)
    else 'AL.' || btrim(p_project)
  end
$$;
comment on function am_alr_code_from_project(text) is
  'FFE.CP.28.2023 -> AL.CP.28.2023. Bỏ đúng đoạn đầu tiên, giữ nguyên phần còn lại.';

grant execute on function am_alr_code_from_project(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Dòng tài sản của biên bản, kèm đủ trường để in thẳng ra 8 cột
-- Thứ tự cột in:
--   Stt | Mã tài sản | Tên tài sản | Số lượng | Thông số kỹ thuật
--       | Đơn giá | Vị trí | Tem nhãn
-- ---------------------------------------------------------------------
create or replace view am_alr_print as
select
  l.alr_id,
  l.line_no,
  a.asset_code,
  a.name_vi,
  a.name_en,
  a.qty,
  a.unit_code,
  a.unit_price,
  a.location_code,
  coalesce(loc.name, '') as location_name,
  a.barcode,
  a.asset_kind,
  -- "Thông số kỹ thuật cơ bản": gom ngắn gọn từ các trường spec chi tiết,
  -- bỏ trường rỗng, nối bằng dấu chấm giữa.
  nullif(array_to_string(array_remove(array[
    nullif(btrim(coalesce(a.spec_brand, '')), ''),
    nullif(btrim(coalesce(a.spec_model, '')), ''),
    nullif(btrim(coalesce(a.spec_function, '')), ''),
    nullif(btrim(coalesce(a.spec_capacity, '')), ''),
    case
      when coalesce(a.spec_length, a.spec_width, a.spec_height) is null then null
      else concat_ws(' x ', nullif(btrim(coalesce(a.spec_length, '')), ''),
                            nullif(btrim(coalesce(a.spec_width,  '')), ''),
                            nullif(btrim(coalesce(a.spec_height, '')), ''))
    end,
    nullif(btrim(coalesce(a.spec_material, '')), ''),
    nullif(btrim(coalesce(a.spec_color, '')), ''),
    case when a.serial is null or btrim(a.serial) = '' then null
         else 'S/N ' || btrim(a.serial) end
  ], null), ' · '), '') as spec_summary
from   am_alr_line l
join   am_asset    a   on a.id = l.asset_id
left join am_location loc on loc.code = a.location_code
order by l.alr_id, l.line_no;

grant select on am_alr_print to anon, authenticated;

comment on view am_alr_print is
  'Nguồn in biên bản ALR. spec_summary là bản gom ngắn của các cột spec chi tiết — dùng cho ô "Thông số kỹ thuật cơ bản".';

