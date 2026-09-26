-- =====================================================================
-- asset-intake — TẤT CẢ TRONG MỘT FILE — dùng cho database MỚI.
-- Dán TOÀN BỘ vào Supabase SQL Editor rồi bấm Run.
-- ⚠ Database đang chạy thật: dùng MIGRATE_17.sql, KHÔNG dùng file này —
--   seed ở đây ghi đè master data đã sửa trong app.
-- Sinh tự động bởi scripts/build-sql.ps1. Đừng sửa file này — sửa file
-- gốc trong sql/ rồi chạy lại script.
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
  expense_class   text not null default 'CAPEX'
                  check (expense_class in ('CAPEX', 'OPEX')),
  sort_order      int not null default 0
);
-- ⚠️ KHÔNG đặt "comment on column am_category_group.expense_class" ở đây.
-- Trên database đã có sẵn, "create table if not exists" là lệnh rỗng nên cột
-- chưa tồn tại, và câu COMMENT sẽ chết ngay với
--   ERROR 42703: column "expense_class" does not exist
-- làm hỏng toàn bộ ALL_IN_ONE trước khi 02b2 kịp chạy ALTER.
-- Phần comment nằm trong 02b2_seed_category_opex.sql, sau lệnh ALTER.
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
-- ##  02_seed_settings.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake — thresholds and counter initialisation
-- Hand-maintained. The master-data files 02a..02f are generated from the
-- Beetrack templates by scripts/genseed.ps1.
-- Run after 01_schema.sql. Safe to re-run.
-- =====================================================================

insert into am_setting (key, value, note) values
  ('unique_threshold', '5000000',
   'Unit price >= this => Unique asset: one row per unit, quantity always 1'),
  ('capex_threshold',  '30000000',
   'Unit price > this => a tools & supplies (CCDC) category code is not allowed'),
  ('default_company',  '"SOF"',
   'Default member company on new assets. Real asset rows use SOF for the hotel and CEN for Central Plaza.'),
  ('barcode_prefix',   '"JVC."', 'Barcode prefix')
on conflict (key) do update
  set value = excluded.value, note = excluded.note, updated_at = now();

-- Two separate barcode ranges:
--   unique : 'JVC.'  + 9 digits, first digit 0-8
--   low    : 'JVC.9' + 8 digits (next_val is the part AFTER the 9)
insert into am_barcode_seq (kind, next_val, max_val) values
  ('unique', 1, 899999999),
  ('low',    1, 99999999)
on conflict (kind) do nothing;

insert into am_alr_seq (singleton, next_val) values (true, 1)
on conflict (singleton) do nothing;


-- ####################################################################
-- ##  02a_seed_org.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake -- organisation units
-- GENERATED by scripts/genseed.ps1 from the Beetrack master templates.
-- Source workbook: 4. department-template-file.xlsx
-- Do not hand-edit; change the workbook or the script and re-run.
-- =====================================================================
insert into am_org (code, name_vi, name_en, level, is_company, is_department, parent_code, note) values
  ('PHCL', 'Công ty TNHH Liên Doanh Khách Sạn Plaza', 'Plaza Hotel Ltd.', 'TCT', true, true, null, null),
  ('JVC', 'Văn phòng đại diện chủ đầu tư', 'JVC Office', 'BRANCH', true, true, 'PHCL', null),
  ('CP', 'Cao ốc văn phòng Central Plaza', 'Central Plaza', 'BRANCH', true, true, 'PHCL', null),
  ('CEN', 'Bộ phận vận hành Cao ốc văn phòng Central Plaza', 'Central Plaza Department', 'DEPT1', true, true, 'CP', null),
  ('SOF', 'Khách sạn Sofitel SG Plaza', 'Sofitel Saigon Plaza', 'BRANCH', true, true, 'PHCL', null),
  ('FOD', 'Bộ phận tiền sảnh', 'Front Office Department', 'DEPT1', false, true, 'SOF', null),
  ('HKD', 'Bộ phận quản gia', 'House Keeping Department', 'DEPT1', false, true, 'SOF', null),
  ('FBD', 'Bộ phận F&B', 'Food & Beverage Department', 'DEPT1', false, true, 'SOF', null),
  ('KIT', 'Bộ phận bếp', 'Kitchen Department', 'DEPT1', false, true, 'SOF', null),
  ('ENG', 'Bộ phận kỹ thuật', 'Engineering Department', 'DEPT1', false, true, 'SOF', null),
  ('ADM', 'Bộ phận hành chính, nhân sự', 'Administration & Human Resource Department', 'DEPT1', false, true, 'SOF', null),
  ('SMD', 'Bộ phận quảng cáo, bán hàng', 'Sale & Marketing Department', 'DEPT1', false, true, 'SOF', null),
  ('FIN', 'Bộ phận tài chính, kế toán', 'Finance Department', 'DEPT1', false, true, 'SOF', null),
  ('ITD', 'Bộ phận IT', 'IT Department', 'DEPT1', false, true, 'SOF', null),
  ('SEC', 'Bộ phận an ninh', 'Security Department', 'DEPT1', false, true, 'SOF', null)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en, level = excluded.level,
      is_company = excluded.is_company, is_department = excluded.is_department,
      parent_code = excluded.parent_code;

-- Aliases: other files in the company spell some codes differently.
insert into am_org_alias (alias, code, source) values
  ('HKP', 'HKD', 'Beetrack "4. Org Code" / "1. Area Code" / KiemKe-HKP'),
  ('IT',  'ITD', 'Beetrack "4. Org Code" / KiemKe-IT'),
  ('Security', 'SEC', 'Beetrack "1. Area Code"'),
  ('S&M', 'SMD', 'KiemKe-S&M'),
  ('A&G', 'ADM', 'KiemKe-A&G (Administration & General)')
on conflict (alias) do update set code = excluded.code, source = excluded.source;


-- ####################################################################
-- ##  02b_seed_category.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake -- asset categories
-- GENERATED by scripts/genseed.ps1 from the Beetrack master templates.
-- Source workbook: 3. category-template-file.xlsx
-- Do not hand-edit; change the workbook or the script and re-run.
-- =====================================================================
insert into am_category_group (code, name_vi, name_en, is_intangible, is_tools, sort_order) values
  ('C2111', 'Nhà cửa, vật kiến trúc', 'Buildings and structures', false, false, 10),
  ('C2112', 'Máy móc và thiết bị', 'Machinery and equipment', false, false, 20),
  ('C2113', 'Trang thiết bị và phương tiện vận tải', 'Transportation and transmission vehicles', false, false, 30),
  ('C2114', 'Thiết bị, công cụ quản lý', 'Office equipment, management toos', false, false, 40),
  ('C2115', 'Cây lâu năm, súc vật làm việc và cho sản phẩm', 'Perennial trees, Working and Producing Animals', false, false, 50),
  ('C2118', 'Tài sản cố định hữu hình khác', 'Other tangible asset', false, false, 60),
  ('C2131', 'Quyền sử dụng đất', 'Land use rights', true, false, 70),
  ('C2132', 'Quyền phát hành', 'Copyrights', true, false, 80),
  ('C2133', 'Bản quyền, quyền phát hành, bằng sáng chế', 'Patent', true, false, 90),
  ('C2134', 'Nhãn hiệu độc quyền, tên thương mại, quyền sở hữu trí tuệ', 'Trademarks, trade names', true, false, 100),
  ('C2135', 'Chương trình, phần mềm', 'Computer software', true, false, 110),
  ('C2136', 'Giấy phép và giấy phép nhượng quyền', 'License and right concession permits', true, false, 120),
  ('C2138', 'Tài sản cố định vô hình khác', 'Other intangible asset', true, false, 130),
  ('C2421', 'Thiết bị, CCDC ngắn hạn (không đủ điều kiện ghi nhận TSCĐ)', 'Short-term tools & supplies', false, true, 140),
  ('C2422', 'Thiết bị, CCDC dài hạn (không đủ điều kiện ghi nhận TSCĐ)', 'Long-term tools & supplies', false, true, 150)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en,
      is_intangible = excluded.is_intangible, is_tools = excluded.is_tools;

-- label_letters = the code with the -QR suffix removed; LTG and LTG-QR both
-- print as "LTG", which is why they must share one sequence.
-- manage_by: 'code' = one record per unit, 'quantity' = grouped by count.
insert into am_category (code, group_code, name_vi, name_en, label_letters, manage_by, note) values
  ('BUL', 'C2111', 'Tòa nhà', 'Building', 'BUL', 'code', null),
  ('STR', 'C2111', 'Công trình, kiến trúc khác', 'Other structure', 'STR', 'code', null),
  ('INF', 'C2111', 'Cơ sở hạ tầng kỹ thuật', 'Infrastructure, Constructual item', 'INF', 'code', null),
  ('MES', 'C2112', 'Hệ thống điện và cơ khí', 'Machenical & Electrical Systems', 'MES', 'code', null),
  ('FFP', 'C2112', 'Thiết bị, hệ thống PCCC', 'Fire Fighting & Prevention Equipment/System', 'FFP', 'code', null),
  ('ITO', 'C2112', 'Thiết bị công nghệ thông tin sử dụng cho việc kinh doanh', 'Information Technology Equipment for operation', 'ITO', 'code', null),
  ('KME', 'C2112', 'Thiết bị, vật dụng bếp', 'Kitchen Machinery & Equipment', 'KME', 'code', null),
  ('FUR', 'C2112', 'Thiết bị, vật dụng nội thất', 'Furniture, artworks', 'FUR', 'code', null),
  ('SME', 'C2112', 'Máy móc, thiết bị vệ sinh', 'Sanitary Machinery & Equipment', 'SME', 'code', null),
  ('OME', 'C2112', 'Máy móc, thiết bị khác', 'Other Machinery & Equiment', 'OME', 'code', null),
  ('TTV', 'C2113', 'Trang thiết bị và phương tiện vận tải', 'Transportation and transmission vehicles', 'TTV', 'code', null),
  ('ITM', 'C2114', 'Thiết bị công nghệ thông tin sử dụng cho việc quản trị', 'Information Technology Equipment for management', 'ITM', 'code', null),
  ('OEM', 'C2114', 'Thiết bị, vật dụng, công cụ khác sử dụng cho mục đích quản lý.', 'Other Funitures, Equipments, Measurement tools for management purposes.', 'OEM', 'code', null),
  ('PWP', 'C2115', 'Cây lâu năm, súc vật làm việc và cho sản phẩm', 'Perennial trees, Working and Producing Animals', 'PWP', 'code', null),
  ('OTA', 'C2118', 'Tài sản cố định hữu hình khác', 'Other tangible asset', 'OTA', 'code', null),
  ('LUR', 'C2131', 'Quyền sử dụng đất', 'Land use rights', 'LUR', 'code', null),
  ('CPR', 'C2132', 'Quyền phát hành', 'Copyrights', 'CPR', 'code', null),
  ('PAT', 'C2133', 'Bản quyền, quyền phát hành, bằng sáng chế', 'Patent', 'PAT', 'code', null),
  ('TMK', 'C2134', 'Nhãn hiệu độc quyền, tên thương mại, quyền sở hữu trí tuệ', 'Trademarks, trade names', 'TMK', 'code', null),
  ('CTP', 'C2135', 'Chương trình, phần mềm', 'Computer software', 'CTP', 'code', null),
  ('LRP', 'C2136', 'Giấy phép và giấy phép nhượng quyền', 'License and right concession permits', 'LRP', 'code', null),
  ('OIA', 'C2138', 'Tài sản cố định vô hình khác', 'Other intangible asset', 'OIA', 'code', null),
  ('STU', 'C2421', 'Thiết bị, CCDC ngắn hạn (không đủ điều kiện ghi nhận TSCĐ)', 'Short-term tools & supplies', 'STU', 'code', null),
  ('LTU', 'C2422', 'Thiết bị, CCDC dài hạn (không đủ điều kiện ghi nhận TSCĐ)', 'Long-term tools & supplies', 'LTU', 'code', null),
  ('STG', 'C2421', 'Thiết bị, CCDC ngắn hạn (không đủ điều kiện ghi nhận TSCĐ) - Khác QR', 'Short-term tools & supplies', 'STG', 'quantity', 'A separate QR label per unit ("Khac QR").'),
  ('LTG', 'C2422', 'Thiết bị, CCDC dài hạn (không đủ điều kiện ghi nhận TSCĐ) - Khác QR', 'Long-term tools & supplies', 'LTG', 'quantity', 'A separate QR label per unit ("Khac QR").'),
  ('LTG-QR', 'C2422', 'Thiết bị, CCDC dài hạn (không đủ điều kiện ghi nhận TSCĐ) - Cùng QR', 'Long-term tools & supplies', 'LTG', 'quantity', 'One shared QR label for the whole batch ("Cung QR").'),
  ('STG-QR', 'C2421', 'Thiết bị, CCDC dài hạn (không đủ điều kiện ghi nhận TSCĐ) - Cùng QR', 'Long-term tools & supplies', 'STG', 'quantity', 'One shared QR label for the whole batch ("Cung QR").')
on conflict (code) do update
  set group_code = excluded.group_code, name_vi = excluded.name_vi,
      name_en = excluded.name_en, label_letters = excluded.label_letters,
      manage_by = excluded.manage_by, note = excluded.note;


-- ####################################################################
-- ##  02b2_seed_category_opex.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake — OPEX group O4000 (operating supplies & equipment)
--
-- HAND-MAINTAINED. This group is NOT in "3. category-template-file.xlsx",
-- so scripts/genseed.ps1 cannot produce it — but 853 live assets in the
-- Beetrack register already use it (SOF.O4000.OBA.2019.00001 and so on).
-- Without these rows those assets cannot be loaded: am_asset.group_code and
-- am_asset.category_code are both foreign keys.
--
-- Evidence from "Danh sach tai san (up to Sep 15 - Beetrack).xlsx":
--   853 rows, all department SOF, all "Cung Barcode" (one shared barcode for
--   the whole batch), all unit pcs, quantities up to 5,581 per row, and the
--   accounting-code column empty on every single one — which is why these are
--   OPEX rather than CAPEX.
--
-- ⚠️ WHY THE do $$ ... execute ... $$ BLOCKS BELOW
-- When several statements are submitted together, PostgreSQL resolves column
-- names while it parses — before the earlier ALTER has run. So a plain
-- "insert ... (expense_class)" in this same file fails with
--   ERROR 42703: column "expense_class" does not exist
-- even though the ALTER sits right above it. Putting those statements inside
-- execute '...' defers parsing to run time, after the column exists.
-- Do not "simplify" them back into plain statements.
--
-- Run after 02b_seed_category.sql. Safe to re-run.
-- =====================================================================

-- Tell CAPEX groups apart from OPEX ones. A fresh install already has the
-- column from 01_schema.sql; an existing database gets it here.
alter table am_category_group
  add column if not exists expense_class text not null default 'CAPEX';

do $$
begin
  execute 'alter table am_category_group drop constraint if exists am_category_group_class_ck';
  execute 'alter table am_category_group add constraint am_category_group_class_ck '
       || 'check (expense_class in (''CAPEX'', ''OPEX''))';
  execute 'comment on column am_category_group.expense_class is '
       || '''CAPEX = the C2xxx accounting groups. OPEX = operating supplies (O4000), '
       || 'which carry no accounting code.''';
  -- Everything generated from the Beetrack category template is CAPEX: the
  -- source workbook lists all of them under its "CAPEX:" heading.
  execute 'update am_category_group set expense_class = ''CAPEX'' where code like ''C2%''';
end $$;

-- Inserted without expense_class so this statement parses on a database that
-- has not run the ALTER yet; the value is set in the do-block that follows.
insert into am_category_group (code, name_vi, name_en, is_intangible, is_tools, sort_order)
values ('O4000', 'Đồ dùng vận hành khách sạn',
        'Operating supplies & equipment (OS&E)', false, false, 90)
on conflict (code) do update
  set name_vi = excluded.name_vi, name_en = excluded.name_en,
      sort_order = excluded.sort_order;

do $$
begin
  execute 'update am_category_group set expense_class = ''OPEX'' where code = ''O4000''';
end $$;

-- All eight are managed by quantity and share one barcode per batch
-- ("Cung Barcode" in Beetrack), the same handling as the -QR codes.
insert into am_category (code, group_code, name_vi, name_en, label_letters,
                         manage_by, note) values
  ('OBA', 'O4000', 'Đồ dùng quầy bar',          'Bar equipment',       'OBA', 'quantity', null),
  ('OCN', 'O4000', 'Đồ gốm, sứ',                'Chinaware',           'OCN', 'quantity', null),
  ('OES', 'O4000', 'Công cụ, dụng cụ kỹ thuật', 'Engineering tools',   'OES', 'quantity', null),
  ('OFL', 'O4000', 'Đồ dùng ăn uống',           'Flatware & cutlery',  'OFL', 'quantity', null),
  ('OGL', 'O4000', 'Đồ thủy tinh',              'Glassware',           'OGL', 'quantity', null),
  ('OKU', 'O4000', 'Dụng cụ làm bếp',           'Kitchen utensils',    'OKU', 'quantity', null),
  ('OLI', 'O4000', 'Hàng vải',                  'Linen',               'OLI', 'quantity', null),
  ('OPS', 'O4000', 'Công cụ vận hành',          'Operating equipment', 'OPS', 'quantity', null)
on conflict (code) do update
  set group_code = excluded.group_code, name_vi = excluded.name_vi,
      name_en = excluded.name_en, label_letters = excluded.label_letters,
      manage_by = excluded.manage_by;


-- ####################################################################
-- ##  02c_seed_unit.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake -- units of measure
-- GENERATED by scripts/genseed.ps1 from the Beetrack master templates.
-- Source workbook: 10. unit-template-file.xlsx
-- Do not hand-edit; change the workbook or the script and re-run.
-- =====================================================================
insert into am_unit (code, name_vi, name_en, sort_order) values
  ('litre', null, 'Litre', 10),
  ('kwh', null, 'Kilowatt-hour (kwh)', 20),
  ('kg', null, 'kg', 30),
  ('m3', null, 'Cubic Meter (m3)', 40),
  ('pcs', null, 'pcs', 50),
  ('m', null, 'm', 60),
  ('set', null, 'set', 70),
  ('box', null, 'box', 80),
  ('m2', null, 'm2', 90),
  ('package', null, 'package', 100),
  ('time', null, 'time', 110),
  ('room', null, 'room', 120),
  ('floor', null, 'floor', 130),
  ('pot', null, 'pot', 140),
  ('tubes', null, 'tubes', 150),
  ('lit', null, 'Liter (lit)', 160)
on conflict (code) do update set name_en = excluded.name_en, sort_order = excluded.sort_order;


-- ####################################################################
-- ##  02d_seed_origin.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake -- countries of origin (ISO 3166-1 alpha-2)
-- GENERATED by scripts/genseed.ps1 from the Beetrack master templates.
-- Source workbook: 9. origin-country-template-file.xlsx
-- Do not hand-edit; change the workbook or the script and re-run.
-- =====================================================================
insert into am_origin (iso2, name_en) values
  ('AF', 'AFGHANISTAN'),
  ('AX', 'ÅLAND ISLANDS'),
  ('AL', 'ALBANIA'),
  ('DZ', 'ALGERIA'),
  ('AS', 'AMERICAN SAMOA'),
  ('AD', 'ANDORRA'),
  ('AO', 'ANGOLA'),
  ('AI', 'ANGUILLA'),
  ('AQ', 'ANTARCTICA'),
  ('AG', 'ANTIGUA AND BARBUDA'),
  ('AR', 'ARGENTINA'),
  ('AM', 'ARMENIA'),
  ('AW', 'ARUBA'),
  ('AU', 'AUSTRALIA'),
  ('AT', 'AUSTRIA'),
  ('AZ', 'AZERBAIJAN'),
  ('BS', 'BAHAMAS'),
  ('BH', 'BAHRAIN'),
  ('BD', 'BANGLADESH'),
  ('BB', 'BARBADOS'),
  ('BY', 'BELARUS'),
  ('BE', 'BELGIUM'),
  ('BZ', 'BELIZE'),
  ('BJ', 'BENIN'),
  ('BM', 'BERMUDA'),
  ('BT', 'BHUTAN'),
  ('BO', 'BOLIVIA'),
  ('BA', 'BOSNIA AND HERZEGOVINA'),
  ('BW', 'BOTSWANA'),
  ('BV', 'BOUVET ISLAND'),
  ('BR', 'BRAZIL'),
  ('IO', 'BRITISH INDIAN OCEAN TERRITORY'),
  ('BN', 'BRUNEI DARUSSALAM'),
  ('BG', 'BULGARIA'),
  ('BF', 'BURKINA FASO'),
  ('BI', 'BURUNDI'),
  ('KH', 'CAMBODIA'),
  ('CM', 'CAMEROON'),
  ('CA', 'CANADA'),
  ('CV', 'CAPE VERDE'),
  ('KY', 'CAYMAN ISLANDS'),
  ('CF', 'CENTRAL AFRICAN REPUBLIC'),
  ('TD', 'CHAD'),
  ('CL', 'CHILE'),
  ('CN', 'CHINA'),
  ('CX', 'CHRISTMAS ISLAND'),
  ('CC', 'COCOS (KEELING ISLANDS)'),
  ('CO', 'COLOMBIA'),
  ('KM', 'COMOROS'),
  ('CG', 'CONGO'),
  ('CD', 'CONGO'),
  ('CK', 'COOK ISLANDS'),
  ('CR', 'COSTA RICA'),
  ('CI', 'CÔTE D''IVOIRE'),
  ('HR', 'CROATIA'),
  ('CU', 'CUBA'),
  ('CY', 'CYPRUS'),
  ('CZ', 'CZECH REPUBLIC'),
  ('DK', 'DENMARK'),
  ('DJ', 'DJIBOUTI'),
  ('DM', 'DOMINICA'),
  ('DO', 'DOMINICAN REPUBLIC'),
  ('EC', 'ECUADOR'),
  ('EG', 'EGYPT'),
  ('SV', 'EL SALVADOR'),
  ('GQ', 'EQUATORIAL GUINEA'),
  ('ER', 'ERITREA'),
  ('EE', 'ESTONIA'),
  ('ET', 'ETHIOPIA'),
  ('FK', 'FALKLAND ISLANDS (MALVINAS)'),
  ('FO', 'FAROE ISLANDS'),
  ('FJ', 'FIJI'),
  ('FI', 'FINLAND'),
  ('FR', 'FRANCE'),
  ('GF', 'FRENCH GUIANA'),
  ('PF', 'FRENCH POLYNESIA'),
  ('TF', 'FRENCH SOUTHERN TERRITORIES'),
  ('GA', 'GABON'),
  ('GM', 'GAMBIA'),
  ('GE', 'GEORGIA'),
  ('DE', 'GERMANY'),
  ('GH', 'GHANA'),
  ('GI', 'GIBRALTAR'),
  ('GR', 'GREECE'),
  ('GL', 'GREENLAND'),
  ('GD', 'GRENADA'),
  ('GP', 'GUADELOUPE'),
  ('GU', 'GUAM'),
  ('GT', 'GUATEMALA'),
  ('GN', 'GUINEA'),
  ('GW', 'GUINEA-BISSAU'),
  ('GY', 'GUYANA'),
  ('HT', 'HAITI'),
  ('HM', 'HEARD ISLAND AND MCDONALD ISLANDS'),
  ('VA', 'HOLY SEE (VATICAN CITY STATE)'),
  ('HN', 'HONDURAS'),
  ('HK', 'HONG KONG'),
  ('HU', 'HUNGARY'),
  ('IS', 'ICELAND'),
  ('IN', 'INDIA'),
  ('ID', 'INDONESIA'),
  ('IR', 'IRAN, ISLAMIC REPUBLIC OF'),
  ('IQ', 'IRAQ'),
  ('IE', 'IRELAND'),
  ('IL', 'ISRAEL'),
  ('IT', 'ITALY'),
  ('JM', 'JAMAICA'),
  ('JP', 'JAPAN'),
  ('JO', 'JORDAN'),
  ('KZ', 'KAZAKHSTAN'),
  ('KE', 'KENYA'),
  ('KI', 'KIRIBATI'),
  ('KP', 'KOREA, DEMOCRATIC PEOPLE''S REPUBLIC OF'),
  ('KR', 'KOREA, REPUBLIC OF'),
  ('KW', 'KUWAIT'),
  ('KG', 'KYRGYZSTAN'),
  ('LA', 'LAO PEOPLE''S DEMOCRATIC REPUBLIC'),
  ('LV', 'LATVIA'),
  ('LB', 'LEBANON'),
  ('LS', 'LESOTHO'),
  ('LR', 'LIBERIA'),
  ('LY', 'LIBYAN ARAB JAMAHIRIYA'),
  ('LI', 'LIECHTENSTEIN'),
  ('LT', 'LITHUANIA'),
  ('LU', 'LUXEMBOURG'),
  ('MO', 'MACAO'),
  ('MK', 'MACEDONIA'),
  ('MG', 'MADAGASCAR'),
  ('MW', 'MALAWI'),
  ('MY', 'MALAYSIA'),
  ('MV', 'MALDIVES'),
  ('ML', 'MALI'),
  ('MT', 'MALTA'),
  ('MH', 'MARSHALL ISLANDS'),
  ('MQ', 'MARTINIQUE'),
  ('MR', 'MAURITANIA'),
  ('MU', 'MAURITIUS'),
  ('YT', 'MAYOTTE'),
  ('MX', 'MEXICO'),
  ('FM', 'MICRONESIA'),
  ('MD', 'MOLDOVA'),
  ('MC', 'MONACO'),
  ('MN', 'MONGOLIA'),
  ('MS', 'MONTSERRAT'),
  ('MA', 'MOROCCO'),
  ('MZ', 'MOZAMBIQUE'),
  ('MM', 'MYANMAR'),
  ('NA', 'NAMIBIA'),
  ('NR', 'NAURU'),
  ('NP', 'NEPAL'),
  ('NL', 'NETHERLANDS'),
  ('AN', 'NETHERLANDS ANTILLES'),
  ('NC', 'NEW CALEDONIA'),
  ('NZ', 'NEW ZEALAND'),
  ('NI', 'NICARAGUA'),
  ('NE', 'NIGER'),
  ('NG', 'NIGERIA'),
  ('NU', 'NIUE'),
  ('NF', 'NORFOLK ISLAND'),
  ('MP', 'NORTHERN MARIANA ISLANDS'),
  ('NO', 'NORWAY'),
  ('OM', 'OMAN'),
  ('PK', 'PAKISTAN'),
  ('PW', 'PALAU'),
  ('PS', 'PALESTINIAN TERRITORY, OCCUPIED'),
  ('PA', 'PANAMA'),
  ('PG', 'PAPUA NEW GUINEA'),
  ('PY', 'PARAGUAY'),
  ('PE', 'PERU'),
  ('PH', 'PHILIPPINES'),
  ('PN', 'PITCAIRN'),
  ('PL', 'POLAND'),
  ('PT', 'PORTUGAL'),
  ('PR', 'PUERTO RICO'),
  ('QA', 'QATAR'),
  ('RE', 'RÉUNION'),
  ('RO', 'ROMANIA'),
  ('RU', 'RUSSIAN FEDERATION'),
  ('RW', 'RWANDA'),
  ('SH', 'SAINT HELENA'),
  ('KN', 'SAINT KITTS AND NEVIS'),
  ('LC', 'SAINT LUCIA'),
  ('PM', 'SAINT PIERRE AND MIQUELON'),
  ('VC', 'SAINT VINCENT AND THE GRENADINES'),
  ('WS', 'SAMOA'),
  ('SM', 'SAN MARINO'),
  ('ST', 'SAO TOME AND PRINCIPE'),
  ('SA', 'SAUDI ARABIA'),
  ('SN', 'SENEGAL'),
  ('CS', 'SERBIA AND MONTENEGRO'),
  ('SC', 'SEYCHELLES'),
  ('SL', 'SIERRA LEONE'),
  ('SG', 'SINGAPORE'),
  ('SK', 'SLOVAKIA'),
  ('SI', 'SLOVENIA'),
  ('SB', 'SOLOMON ISLANDS'),
  ('SO', 'SOMALIA'),
  ('ZA', 'SOUTH AFRICA'),
  ('GS', 'SOUTH GEORGIA AND THE SOUTH SANDWICH ISLANDS'),
  ('ES', 'SPAIN'),
  ('LK', 'SRI LANKA'),
  ('SD', 'SUDAN'),
  ('SR', 'SURINAME'),
  ('SJ', 'SVALBARD AND JAN MAYEN'),
  ('SZ', 'SWAZILAND'),
  ('SE', 'SWEDEN'),
  ('CH', 'SWITZERLAND'),
  ('SY', 'SYRIAN ARAB REPUBLIC'),
  ('TW', 'TAIWAN, PROVINCE OF CHINA'),
  ('TJ', 'TAJIKISTAN'),
  ('TZ', 'TANZANIA, UNITED REPUBLIC OF'),
  ('TH', 'THAILAND'),
  ('TL', 'TIMOR-LESTE'),
  ('TG', 'TOGO'),
  ('TK', 'TOKELAU'),
  ('TO', 'TONGA'),
  ('TT', 'TRINIDAD AND TOBAGO'),
  ('TN', 'TUNISIA'),
  ('TR', 'TURKEY'),
  ('TM', 'TURKMENISTAN'),
  ('TC', 'TURKS AND CAICOS ISLANDS'),
  ('TV', 'TUVALU'),
  ('UG', 'UGANDA'),
  ('UA', 'UKRAINE'),
  ('AE', 'UNITED ARAB EMIRATES'),
  ('GB', 'UNITED KINGDOM'),
  ('US', 'UNITED STATES'),
  ('UM', 'UNITED STATES MINOR OUTLYING ISLANDS'),
  ('UY', 'URUGUAY'),
  ('UZ', 'UZBEKISTAN'),
  ('VU', 'VANUATU'),
  ('VE', 'VENEZUELA'),
  ('VN', 'VIET NAM'),
  ('VG', 'VIRGIN ISLANDS, BRITISH'),
  ('VI', 'VIRGIN ISLANDS, U.S.'),
  ('WF', 'WALLIS AND FUTUNA'),
  ('EH', 'WESTERN SAHARA'),
  ('YE', 'YEMEN'),
  ('ZM', 'ZAMBIA'),
  ('ZW', 'ZIMBABWE')
on conflict (iso2) do update set name_en = excluded.name_en;

-- Vietnamese names for the countries that actually turn up in purchasing files.
update am_origin set name_vi = v.vi from (values
  ('VN','Viet Nam'),('CN','Trung Quoc'),('JP','Nhat Ban'),('KR','Han Quoc'),
  ('TW','Dai Loan'),('TH','Thai Lan'),('MY','Malaysia'),('SG','Singapore'),
  ('ID','Indonesia'),('PH','Philippines'),('IN','An Do'),('US','My'),
  ('GB','Anh'),('DE','Duc'),('FR','Phap'),('IT','Y'),('ES','Tay Ban Nha'),
  ('NL','Ha Lan'),('BE','Bi'),('CH','Thuy Si'),('SE','Thuy Dien'),('AT','Ao'),
  ('PL','Ba Lan'),('TR','Tho Nhi Ky'),('RU','Nga'),('AU','Uc'),('NZ','New Zealand'),
  ('CA','Canada'),('MX','Mexico'),('BR','Brazil'),('HK','Hong Kong'),('MO','Ma Cao'),
  ('KH','Campuchia'),('LA','Lao'),('MM','Myanmar'),('AE','UAE'),('DK','Dan Mach'),
  ('NO','Na Uy'),('FI','Phan Lan'),('PT','Bo Dao Nha'),('CZ','Sec'),('IL','Israel')
) as v(code, vi) where am_origin.iso2 = v.code;

-- Aliases: ONLY when the text names exactly ONE country.
-- alias_norm must be the output of am_norm(): lowercase, no diacritics.
insert into am_origin_alias (alias_norm, iso2, note) values
  ('usa','US',null),('u.s.a','US',null),('u.s.a.','US',null),('us','US',null),
  ('united states','US',null),('america','US',null),('my','US','"My" with diacritics stripped'),
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
  ('czech','CZ',null),('czech republic','CZ',null),('brasil','BR',null)
on conflict (alias_norm) do update set iso2 = excluded.iso2, note = excluded.note;

-- Strings deliberately NOT mapped, so the interface can say why it is blank.
insert into am_origin_rejected (raw_norm, raw_sample, reason) values
  ('asia','Asia','not_a_country'),
  ('eu','EU','not_a_country'),
  ('europe','Europe','not_a_country'),
  ('asean','ASEAN','not_a_country'),
  ('imported','Imported','not_a_country'),
  ('nhap khau','Nhap khau','not_a_country'),
  ('oem','OEM','not_a_country'),
  ('n/a','N/A','not_a_country')
on conflict (raw_norm) do nothing;


-- ####################################################################
-- ##  02e_seed_location.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake -- locations (buildings, floors, rooms)
-- GENERATED by scripts/genseed.ps1 from the Beetrack master templates.
-- Source workbook: 6. location-template-file.xlsx
-- Do not hand-edit; change the workbook or the script and re-run.
-- =====================================================================
-- The template is the authority on which room is each department's office, so
-- clear every flag first. Without this, a room promoted to "office" by an older
-- seed keeps the flag, and the partial unique index am_location_one_office_per_dept
-- then blocks the template's own office row for that same department.
-- Only the flag is cleared; dept_code set by hand on other rooms survives.
update am_location set is_dept_office = false where is_dept_office;
insert into am_location (code, name, kind, parent_code, dept_code, is_dept_office) values
  ('CP', 'Central Plaza Building', 'building', null, null, false),
  ('SOF', 'Sofitel Saigon Plaza Building', 'building', null, null, false),
  ('CB100', 'Basement', 'floor', 'CP', null, false),
  ('CRT00', 'Roof top', 'floor', 'CP', null, false),
  ('C1000', 'The 10th floor', 'floor', 'CP', null, false),
  ('C1100', 'The 11th floor', 'floor', 'CP', null, false),
  ('C1200', 'The 12th floor', 'floor', 'CP', null, false),
  ('C1400', 'The 14th floor', 'floor', 'CP', null, false),
  ('C1500', 'The 15th floor', 'floor', 'CP', null, false),
  ('C1600', 'The 16th floor', 'floor', 'CP', null, false),
  ('C0100', 'The 1st floor', 'floor', 'CP', null, false),
  ('C0200', 'The 2nd floor', 'floor', 'CP', null, false),
  ('C0300', 'The 3rd floor', 'floor', 'CP', null, false),
  ('C0400', 'The 4th floor', 'floor', 'CP', null, false),
  ('C0500', 'The 5th floor', 'floor', 'CP', null, false),
  ('C0600', 'The 6th floor', 'floor', 'CP', null, false),
  ('C0700', 'The 7th floor', 'floor', 'CP', null, false),
  ('C0800', 'The 8th floor', 'floor', 'CP', null, false),
  ('C0900', 'The 9th floor', 'floor', 'CP', null, false),
  ('S0100', '1F', 'floor', 'SOF', null, false),
  ('S0200', '2F', 'floor', 'SOF', null, false),
  ('S0300', '3F', 'floor', 'SOF', null, false),
  ('S0400', '4F', 'floor', 'SOF', null, false),
  ('S0500', '5F', 'floor', 'SOF', null, false),
  ('S0600', '6F', 'floor', 'SOF', null, false),
  ('S0700', '7F', 'floor', 'SOF', null, false),
  ('S0800', '8F', 'floor', 'SOF', null, false),
  ('S0900', '9F', 'floor', 'SOF', null, false),
  ('S1000', '10F', 'floor', 'SOF', null, false),
  ('S1100', '11F', 'floor', 'SOF', null, false),
  ('S1200', '12F', 'floor', 'SOF', null, false),
  ('S1400', '14F', 'floor', 'SOF', null, false),
  ('S1500', '15F', 'floor', 'SOF', null, false),
  ('S1600', '16F', 'floor', 'SOF', null, false),
  ('S1700', '17F', 'floor', 'SOF', null, false),
  ('S1800', '18F', 'floor', 'SOF', null, false),
  ('S1900', '19F', 'floor', 'SOF', null, false),
  ('S2000', '20F', 'floor', 'SOF', null, false),
  ('SB100', 'B1', 'floor', 'SOF', null, false),
  ('SB200', 'B2', 'floor', 'SOF', null, false),
  ('SRT00', 'Rooftop', 'floor', 'SOF', null, false),
  ('S0312P2', 'Yoga area', 'room', 'S0300', null, false),
  ('SB202E0', 'Water tank', 'room', 'SB200', null, false),
  ('SRT00E1', 'Water tank', 'room', 'SRT00', null, false),
  ('CRT00E2', 'Unit RT2 - Phòng bơm điều áp', 'room', 'CRT00', null, false),
  ('CRT00E1', 'Unit RT1 - Phòng điều khiển thang máy', 'room', 'CRT00', null, false),
  ('C0904G0', 'Unit 904', 'room', 'C0900', null, false),
  ('C0903G0', 'Unit 903', 'room', 'C0900', null, false),
  ('C0902G0', 'Unit 902', 'room', 'C0900', null, false),
  ('C0901G0', 'Unit 901', 'room', 'C0900', null, false),
  ('C0804G0', 'Unit 804', 'room', 'C0800', null, false),
  ('C0803G0', 'Unit 803', 'room', 'C0800', null, false),
  ('C0802G0', 'Unit 802', 'room', 'C0800', null, false),
  ('C0801G0', 'Unit 801', 'room', 'C0800', null, false),
  ('C0704G0', 'Unit 704', 'room', 'C0700', null, false),
  ('C0703G0', 'Unit 703', 'room', 'C0700', null, false),
  ('C0702G0', 'Unit 702', 'room', 'C0700', null, false),
  ('C0701G0', 'Unit 701', 'room', 'C0700', null, false),
  ('C0604G0', 'Unit 604', 'room', 'C0600', null, false),
  ('C0603G0', 'Unit 603', 'room', 'C0600', null, false),
  ('C0602G0', 'Unit 602', 'room', 'C0600', null, false),
  ('C0601G0', 'Unit 601', 'room', 'C0600', null, false),
  ('C0506B0', 'Unit 506 - Store No.9', 'room', 'C0500', null, false),
  ('C0505B0', 'Unit 505 - Store No.8', 'room', 'C0500', null, false),
  ('C0504B0', 'Unit 504 - Store No.7', 'room', 'C0500', null, false),
  ('C0503G0', 'Unit 503', 'room', 'C0500', null, false),
  ('C0502G0', 'Unit 502', 'room', 'C0500', null, false),
  ('C0501G0', 'Unit 501', 'room', 'C0500', null, false),
  ('C0401B6', 'Unit 406 - Store No.6', 'room', 'C0400', null, false),
  ('C0401B5', 'Unit 405 - Store No.5', 'room', 'C0400', null, false),
  ('C0401B4', 'Unit 404 - Store No.4', 'room', 'C0400', null, false),
  ('C0401B3', 'Unit 403 - Store No.3', 'room', 'C0400', null, false),
  ('C0401B2', 'Unit 402 - Store No.2', 'room', 'C0400', null, false),
  ('C0401B1', 'Unit 401 - Store No.1', 'room', 'C0400', null, false),
  ('C0301G0', 'Unit 301', 'room', 'C0300', null, false),
  ('C1604G0', 'Unit 1604', 'room', 'C1600', null, false),
  ('C1603G0', 'Unit 1603', 'room', 'C1600', null, false),
  ('C1602G0', 'Unit 1602', 'room', 'C1600', null, false),
  ('C1601G0', 'Unit 1601', 'room', 'C1600', null, false),
  ('C1504G0', 'Unit 1504', 'room', 'C1500', null, false),
  ('C1503G0', 'Unit 1503', 'room', 'C1500', null, false),
  ('C1502G0', 'Unit 1502', 'room', 'C1500', null, false),
  ('C1501G0', 'Unit 1501', 'room', 'C1500', null, false),
  ('C1404G0', 'Unit 1404', 'room', 'C1400', null, false),
  ('C1403G0', 'Unit 1403', 'room', 'C1400', null, false),
  ('C1402G0', 'Unit 1402', 'room', 'C1400', null, false),
  ('C1401G0', 'Unit 1401', 'room', 'C1400', null, false),
  ('C1204G0', 'Unit 1204', 'room', 'C1200', null, false),
  ('C1203G0', 'Unit 1203', 'room', 'C1200', null, false),
  ('C1202G0', 'Unit 1202', 'room', 'C1200', null, false),
  ('C1201G0', 'Unit 1201', 'room', 'C1200', null, false),
  ('C1104G0', 'Unit 1104', 'room', 'C1100', null, false),
  ('C1103G0', 'Unit 1103', 'room', 'C1100', null, false),
  ('C1102G0', 'Unit 1102', 'room', 'C1100', null, false),
  ('C1101G0', 'Unit 1101', 'room', 'C1100', null, false),
  ('C0102G0', 'Unit 102', 'room', 'C0100', null, false),
  ('C0101G0', 'Unit 101', 'room', 'C0100', null, false),
  ('C1004G0', 'Unit 1004', 'room', 'C1000', null, false),
  ('C1003G0', 'Unit 1003', 'room', 'C1000', null, false),
  ('C1002G0', 'Unit 1002', 'room', 'C1000', null, false),
  ('C1001G0', 'Unit 1001', 'room', 'C1000', null, false),
  ('SB114B0', 'Uniform room', 'room', 'SB100', null, false),
  ('S0304G0', 'Turquoise', 'room', 'S0300', null, false),
  ('SB104E0', 'Transformer room', 'room', 'SB100', null, false),
  ('S0308G0', 'Topaz', 'room', 'S0300', null, false),
  ('SB139B0', 'Talent & Culture office', 'room', 'SB100', 'ADM', true),
  ('SB102E0', 'STP control room', 'room', 'SB100', null, false),
  ('C0200B0', 'Store No.10', 'room', 'C0200', null, false),
  ('S0201B1', 'Store AV', 'room', 'S0200', null, false),
  ('SB125B0', 'Steward store', 'room', 'SB100', null, false),
  ('S0900S2', 'Stairs 9F-2', 'room', 'S0900', null, false),
  ('S0900S1', 'Stairs 9F-1', 'room', 'S0900', null, false),
  ('S0800S2', 'Stairs 8F-2', 'room', 'S0800', null, false),
  ('S0800S1', 'Stairs 8F-1', 'room', 'S0800', null, false),
  ('S0700S2', 'Stairs 7F-2', 'room', 'S0700', null, false),
  ('S0700S1', 'Stairs 7F-1', 'room', 'S0700', null, false),
  ('S0600S2', 'Stairs 6F-2', 'room', 'S0600', null, false),
  ('S0600S1', 'Stairs 6F-1', 'room', 'S0600', null, false),
  ('S0500S2', 'Stairs 5F-2', 'room', 'S0500', null, false),
  ('S0500S1', 'Stairs 5F-1', 'room', 'S0500', null, false),
  ('S0400S2', 'Stairs 4F-2', 'room', 'S0400', null, false),
  ('S0400S1', 'Stairs 4F-1', 'room', 'S0400', null, false),
  ('S2000S2', 'Stairs 20F-2', 'room', 'S2000', null, false),
  ('S2000S1', 'Stairs 20F-1', 'room', 'S2000', null, false),
  ('S1900S2', 'Stairs 19F-2', 'room', 'S1900', null, false),
  ('S1900S1', 'Stairs 19F-1', 'room', 'S1900', null, false),
  ('S1800S2', 'Stairs 18F-2', 'room', 'S1800', null, false),
  ('S1800S1', 'Stairs 18F-1', 'room', 'S1800', null, false),
  ('S1700S2', 'Stairs 17F-2', 'room', 'S1700', null, false),
  ('S1700S1', 'Stairs 17F-1', 'room', 'S1700', null, false),
  ('S1600S2', 'Stairs 16F-2', 'room', 'S1600', null, false),
  ('S1600S1', 'Stairs 16F-1', 'room', 'S1600', null, false),
  ('S1500S2', 'Stairs 15F-2', 'room', 'S1500', null, false),
  ('S1500S1', 'Stairs 15F-1', 'room', 'S1500', null, false),
  ('S1400S2', 'Stairs 14F-2', 'room', 'S1400', null, false),
  ('S1400S1', 'Stairs 14F-1', 'room', 'S1400', null, false),
  ('S1200S2', 'Stairs 12F-2', 'room', 'S1200', null, false),
  ('S1200S1', 'Stairs 12F-1', 'room', 'S1200', null, false),
  ('S1100S2', 'Stairs 11F-2', 'room', 'S1100', null, false),
  ('S1100S1', 'Stairs 11F-1', 'room', 'S1100', null, false),
  ('S1000S2', 'Stairs 10F-2', 'room', 'S1000', null, false),
  ('S1000S1', 'Stairs 10F-1', 'room', 'S1000', null, false),
  ('SB200S1', 'Stair B2-1', 'room', 'SB200', null, false),
  ('SB100S1', 'Stair B1-1', 'room', 'SB100', null, false),
  ('S0300S3', 'Stair 3F-3', 'room', 'S0300', null, false),
  ('S0300S2', 'Stair 3F-2', 'room', 'S0300', null, false),
  ('S0300S1', 'Stair 3F-1', 'room', 'S0300', null, false),
  ('S0200S5', 'Stair 2F-5', 'room', 'S0200', null, false),
  ('S0200S4', 'Stair 2F-4', 'room', 'S0200', null, false),
  ('S0200S3', 'Stair 2F-3', 'room', 'S0200', null, false),
  ('S0200S1', 'Stair 2F-1', 'room', 'S0200', null, false),
  ('S0100S5', 'Stair 1F-5', 'room', 'S0100', null, false),
  ('S0100S4', 'Stair 1F-4', 'room', 'S0100', null, false),
  ('S0100S1', 'Stair 1F-1', 'room', 'S0100', null, false),
  ('S0203B5', 'St25 Koto store', 'room', 'S0200', null, false),
  ('S0203P2', 'St25 Koto restaurant', 'room', 'S0200', null, false),
  ('S0203B4', 'St25 Koto kitchen', 'room', 'S0200', null, false),
  ('S0312P3', 'Spa area', 'room', 'S0300', null, false),
  ('S2000E3', 'SMATV room / Single Master Antenna Television', 'room', 'S2000', null, false),
  ('C0300G1', 'Shower room', 'room', 'C0300', null, false),
  ('S0102E0', 'Sever room', 'room', 'S0100', null, false),
  ('S0400L3', 'Service lift Sl6', 'room', 'S0400', null, false),
  ('SRT00L4', 'Service lift Sl5', 'room', 'SRT00', null, false),
  ('SRT00L3', 'Service lift Sl4', 'room', 'SRT00', null, false),
  ('SB100L1', 'Service lift lobby B1', 'room', 'SB100', null, false),
  ('S0900L2', 'Service lift lobby 9F', 'room', 'S0900', null, false),
  ('S0800L2', 'Service lift lobby 8F', 'room', 'S0800', null, false),
  ('S0700L2', 'Service lift lobby 7F', 'room', 'S0700', null, false),
  ('S0600L2', 'Service lift lobby 6F', 'room', 'S0600', null, false),
  ('S0500L2', 'Service lift lobby 5F', 'room', 'S0500', null, false),
  ('S0400L2', 'Service lift lobby 4F', 'room', 'S0400', null, false),
  ('S0300L2', 'Service lift lobby 3F', 'room', 'S0300', null, false),
  ('S0200L2', 'Service lift lobby 2F', 'room', 'S0200', null, false),
  ('S2000L2', 'Service lift lobby 20F', 'room', 'S2000', null, false),
  ('S0100L2', 'Service lift lobby 1F', 'room', 'S0100', null, false),
  ('S1900L2', 'Service lift lobby 19F', 'room', 'S1900', null, false),
  ('S1800L2', 'Service lift lobby 18F', 'room', 'S1800', null, false),
  ('S1700L2', 'Service lift lobby 17F', 'room', 'S1700', null, false),
  ('S1600L2', 'Service lift lobby 16F', 'room', 'S1600', null, false),
  ('S1500L2', 'Service lift lobby 15F', 'room', 'S1500', null, false),
  ('S1400L2', 'Service lift lobby 14F', 'room', 'S1400', null, false),
  ('S1200L2', 'Service lift lobby 12F', 'room', 'S1200', null, false),
  ('S1100L2', 'Service lift lobby 11F', 'room', 'S1100', null, false),
  ('S1000L2', 'Service lift lobby 10F', 'room', 'S1000', null, false),
  ('SB124B0', 'Security office', 'room', 'SB100', 'SEC', true),
  ('S0309G0', 'Sapphire', 'room', 'S0300', null, false),
  ('S0302B0', 'Sale office', 'room', 'S0300', 'SMD', true),
  ('S0305G0', 'Ruby', 'room', 'S0300', null, false),
  ('S1800E2', 'Room BTS Base Transceiver Station', 'room', 'S1800', null, false),
  ('S0920G0', 'Room 920', 'room', 'S0900', null, false),
  ('S0919G0', 'Room 919', 'room', 'S0900', null, false),
  ('S0918G0', 'Room 918', 'room', 'S0900', null, false),
  ('S0917G0', 'Room 917', 'room', 'S0900', null, false),
  ('S0916G0', 'Room 916', 'room', 'S0900', null, false),
  ('S0915G0', 'Room 915', 'room', 'S0900', null, false),
  ('S0914G0', 'Room 914', 'room', 'S0900', null, false),
  ('S0913G0', 'Room 913', 'room', 'S0900', null, false),
  ('S0912G0', 'Room 912', 'room', 'S0900', null, false),
  ('S0911G0', 'Room 911', 'room', 'S0900', null, false),
  ('S0910G0', 'Room 910', 'room', 'S0900', null, false),
  ('S0909G0', 'Room 909', 'room', 'S0900', null, false),
  ('S0908G0', 'Room 908', 'room', 'S0900', null, false),
  ('S0907G0', 'Room 907', 'room', 'S0900', null, false),
  ('S0906G0', 'Room 906', 'room', 'S0900', null, false),
  ('S0905G0', 'Room 905', 'room', 'S0900', null, false),
  ('S0904G0', 'Room 904', 'room', 'S0900', null, false),
  ('S0903G0', 'Room 903', 'room', 'S0900', null, false),
  ('S0902G0', 'Room 902', 'room', 'S0900', null, false),
  ('S0901G0', 'Room 901', 'room', 'S0900', null, false),
  ('S0820G0', 'Room 820', 'room', 'S0800', null, false),
  ('S0819G0', 'Room 819', 'room', 'S0800', null, false),
  ('S0818G0', 'Room 818', 'room', 'S0800', null, false),
  ('S0817G0', 'Room 817', 'room', 'S0800', null, false),
  ('S0816G0', 'Room 816', 'room', 'S0800', null, false),
  ('S0815G0', 'Room 815', 'room', 'S0800', null, false),
  ('S0814G0', 'Room 814', 'room', 'S0800', null, false),
  ('S0813G0', 'Room 813', 'room', 'S0800', null, false),
  ('S0812G0', 'Room 812', 'room', 'S0800', null, false),
  ('S0811G0', 'Room 811', 'room', 'S0800', null, false),
  ('S0810G0', 'Room 810', 'room', 'S0800', null, false),
  ('S0809G0', 'Room 809', 'room', 'S0800', null, false),
  ('S0808G0', 'Room 808', 'room', 'S0800', null, false),
  ('S0807G0', 'Room 807', 'room', 'S0800', null, false),
  ('S0806G0', 'Room 806', 'room', 'S0800', null, false),
  ('S0805G0', 'Room 805', 'room', 'S0800', null, false),
  ('S0804G0', 'Room 804', 'room', 'S0800', null, false),
  ('S0803G0', 'Room 803', 'room', 'S0800', null, false),
  ('S0802G0', 'Room 802', 'room', 'S0800', null, false),
  ('S0801G0', 'Room 801', 'room', 'S0800', null, false),
  ('S0720G0', 'Room 720', 'room', 'S0700', null, false),
  ('S0719G0', 'Room 719', 'room', 'S0700', null, false),
  ('S0718G0', 'Room 718', 'room', 'S0700', null, false),
  ('S0717G0', 'Room 717', 'room', 'S0700', null, false),
  ('S0716G0', 'Room 716', 'room', 'S0700', null, false),
  ('S0715G0', 'Room 715', 'room', 'S0700', null, false),
  ('S0714G0', 'Room 714', 'room', 'S0700', null, false),
  ('S0713G0', 'Room 713', 'room', 'S0700', null, false),
  ('S0712G0', 'Room 712', 'room', 'S0700', null, false),
  ('S0711G0', 'Room 711', 'room', 'S0700', null, false),
  ('S0710G0', 'Room 710', 'room', 'S0700', null, false),
  ('S0709G0', 'Room 709', 'room', 'S0700', null, false),
  ('S0708G0', 'Room 708', 'room', 'S0700', null, false),
  ('S0707G0', 'Room 707', 'room', 'S0700', null, false),
  ('S0706G0', 'Room 706', 'room', 'S0700', null, false),
  ('S0705G0', 'Room 705', 'room', 'S0700', null, false),
  ('S0704G0', 'Room 704', 'room', 'S0700', null, false),
  ('S0703G0', 'Room 703', 'room', 'S0700', null, false),
  ('S0702G0', 'Room 702', 'room', 'S0700', null, false),
  ('S0701G0', 'Room 701', 'room', 'S0700', null, false),
  ('S0620G0', 'Room 620', 'room', 'S0600', null, false),
  ('S0619G0', 'Room 619', 'room', 'S0600', null, false),
  ('S0618G0', 'Room 618', 'room', 'S0600', null, false),
  ('S0617G0', 'Room 617', 'room', 'S0600', null, false),
  ('S0616G0', 'Room 616', 'room', 'S0600', null, false),
  ('S0615G0', 'Room 615', 'room', 'S0600', null, false),
  ('S0614G0', 'Room 614', 'room', 'S0600', null, false),
  ('S0613G0', 'Room 613', 'room', 'S0600', null, false),
  ('S0612G0', 'Room 612', 'room', 'S0600', null, false),
  ('S0611G0', 'Room 611', 'room', 'S0600', null, false),
  ('S0610G0', 'Room 610', 'room', 'S0600', null, false),
  ('S0609G0', 'Room 609', 'room', 'S0600', null, false),
  ('S0608G0', 'Room 608', 'room', 'S0600', null, false),
  ('S0607G0', 'Room 607', 'room', 'S0600', null, false),
  ('S0606G0', 'Room 606', 'room', 'S0600', null, false),
  ('S0605G0', 'Room 605', 'room', 'S0600', null, false),
  ('S0604G0', 'Room 604', 'room', 'S0600', null, false),
  ('S0603G0', 'Room 603', 'room', 'S0600', null, false),
  ('S0602G0', 'Room 602', 'room', 'S0600', null, false),
  ('S0601G0', 'Room 601', 'room', 'S0600', null, false),
  ('S0520G0', 'Room 520', 'room', 'S0500', null, false),
  ('S0519G0', 'Room 519', 'room', 'S0500', null, false),
  ('S0518G0', 'Room 518', 'room', 'S0500', null, false),
  ('S0517G0', 'Room 517', 'room', 'S0500', null, false),
  ('S0516G0', 'Room 516', 'room', 'S0500', null, false),
  ('S0515G0', 'Room 515', 'room', 'S0500', null, false),
  ('S0514G0', 'Room 514', 'room', 'S0500', null, false),
  ('S0513G0', 'Room 513', 'room', 'S0500', null, false),
  ('S0512G0', 'Room 512', 'room', 'S0500', null, false),
  ('S0511G0', 'Room 511', 'room', 'S0500', null, false),
  ('S0510G0', 'Room 510', 'room', 'S0500', null, false),
  ('S0509G0', 'Room 509', 'room', 'S0500', null, false),
  ('S0508G0', 'Room 508', 'room', 'S0500', null, false),
  ('S0507G0', 'Room 507', 'room', 'S0500', null, false),
  ('S0506G0', 'Room 506', 'room', 'S0500', null, false),
  ('S0505G0', 'Room 505', 'room', 'S0500', null, false),
  ('S0504G0', 'Room 504', 'room', 'S0500', null, false),
  ('S0503G0', 'Room 503', 'room', 'S0500', null, false),
  ('S0502G0', 'Room 502', 'room', 'S0500', null, false),
  ('S0501G0', 'Room 501', 'room', 'S0500', null, false),
  ('S0420G0', 'Room 420', 'room', 'S0400', null, false),
  ('S0419G0', 'Room 419', 'room', 'S0400', null, false),
  ('S0418G0', 'Room 418', 'room', 'S0400', null, false),
  ('S0417G0', 'Room 417', 'room', 'S0400', null, false),
  ('S0416G0', 'Room 416', 'room', 'S0400', null, false),
  ('S0415G0', 'Room 415', 'room', 'S0400', null, false),
  ('S0414G0', 'Room 414', 'room', 'S0400', null, false),
  ('S0413G0', 'Room 413', 'room', 'S0400', null, false),
  ('S0412G0', 'Room 412', 'room', 'S0400', null, false),
  ('S0411G0', 'Room 411', 'room', 'S0400', null, false),
  ('S0410G0', 'Room 410', 'room', 'S0400', null, false),
  ('S0409G0', 'Room 409', 'room', 'S0400', null, false),
  ('S0408G0', 'Room 408', 'room', 'S0400', null, false),
  ('S0407G0', 'Room 407', 'room', 'S0400', null, false),
  ('S0406G0', 'Room 406', 'room', 'S0400', null, false),
  ('S0405G0', 'Room 405', 'room', 'S0400', null, false),
  ('S0404G0', 'Room 404', 'room', 'S0400', null, false),
  ('S0403G0', 'Room 403', 'room', 'S0400', null, false),
  ('S0402G0', 'Room 402', 'room', 'S0400', null, false),
  ('S0401G0', 'Room 401', 'room', 'S0400', null, false),
  ('S2015G0', 'Room 2015', 'room', 'S2000', null, false),
  ('S2008G0', 'Room 2008', 'room', 'S2000', null, false),
  ('S2006G0', 'Room 2006', 'room', 'S2000', null, false),
  ('S2005G0', 'Room 2005', 'room', 'S2000', null, false),
  ('S2003G0', 'Room 2003', 'room', 'S2000', null, false),
  ('S1920G0', 'Room 1920', 'room', 'S1900', null, false),
  ('S1918G0', 'Room 1918', 'room', 'S1900', null, false),
  ('S1916G0', 'Room 1916', 'room', 'S1900', null, false),
  ('S1914G0', 'Room 1914', 'room', 'S1900', null, false),
  ('S1912G0', 'Room 1912', 'room', 'S1900', null, false),
  ('S1911G0', 'Room 1911', 'room', 'S1900', null, false),
  ('S1910G0', 'Room 1910', 'room', 'S1900', null, false),
  ('S1909G0', 'Room 1909', 'room', 'S1900', null, false),
  ('S1907G0', 'Room 1907', 'room', 'S1900', null, false),
  ('S1905G0', 'Room 1905', 'room', 'S1900', null, false),
  ('S1903G0', 'Room 1903', 'room', 'S1900', null, false),
  ('S1901G0', 'Room 1901', 'room', 'S1900', null, false),
  ('S1820G0', 'Room 1820', 'room', 'S1800', null, false),
  ('S1819G0', 'Room 1819', 'room', 'S1800', null, false),
  ('S1818G0', 'Room 1818', 'room', 'S1800', null, false),
  ('S1817G0', 'Room 1817', 'room', 'S1800', null, false),
  ('S1810P0', 'Room 1810 Aquamarine meeting room', 'room', 'S1800', null, false),
  ('S1808G0', 'Room 1808', 'room', 'S1800', null, false),
  ('S1807G0', 'Room 1807', 'room', 'S1800', null, false),
  ('S1806G0', 'Room 1806', 'room', 'S1800', null, false),
  ('S1805G0', 'Room 1805', 'room', 'S1800', null, false),
  ('S1804G0', 'Room 1804', 'room', 'S1800', null, false),
  ('S1803G0', 'Room 1803', 'room', 'S1800', null, false),
  ('S1802G0', 'Room 1802', 'room', 'S1800', null, false),
  ('S1801G0', 'Room 1801', 'room', 'S1800', null, false),
  ('S1720G0', 'Room 1720', 'room', 'S1700', null, false),
  ('S1719G0', 'Room 1719', 'room', 'S1700', null, false),
  ('S1718G0', 'Room 1718', 'room', 'S1700', null, false),
  ('S1717G0', 'Room 1717', 'room', 'S1700', null, false),
  ('S1716G0', 'Room 1716', 'room', 'S1700', null, false),
  ('S1715G0', 'Room 1715', 'room', 'S1700', null, false),
  ('S1714G0', 'Room 1714', 'room', 'S1700', null, false),
  ('S1713G0', 'Room 1713', 'room', 'S1700', null, false),
  ('S1712G0', 'Room 1712', 'room', 'S1700', null, false),
  ('S1711G0', 'Room 1711', 'room', 'S1700', null, false),
  ('S1710G0', 'Room 1710', 'room', 'S1700', null, false),
  ('S1709G0', 'Room 1709', 'room', 'S1700', null, false),
  ('S1708G0', 'Room 1708', 'room', 'S1700', null, false),
  ('S1707G0', 'Room 1707', 'room', 'S1700', null, false),
  ('S1706G0', 'Room 1706', 'room', 'S1700', null, false),
  ('S1705G0', 'Room 1705', 'room', 'S1700', null, false),
  ('S1704G0', 'Room 1704', 'room', 'S1700', null, false),
  ('S1703G0', 'Room 1703', 'room', 'S1700', null, false),
  ('S1702G0', 'Room 1702', 'room', 'S1700', null, false),
  ('S1701G0', 'Room 1701', 'room', 'S1700', null, false),
  ('S1620G0', 'Room 1620', 'room', 'S1600', null, false),
  ('S1619G0', 'Room 1619', 'room', 'S1600', null, false),
  ('S1618G0', 'Room 1618', 'room', 'S1600', null, false),
  ('S1617G0', 'Room 1617', 'room', 'S1600', null, false),
  ('S1616G0', 'Room 1616', 'room', 'S1600', null, false),
  ('S1615G0', 'Room 1615', 'room', 'S1600', null, false),
  ('S1614G0', 'Room 1614', 'room', 'S1600', null, false),
  ('S1613G0', 'Room 1613', 'room', 'S1600', null, false),
  ('S1612G0', 'Room 1612', 'room', 'S1600', null, false),
  ('S1611G0', 'Room 1611', 'room', 'S1600', null, false),
  ('S1610G0', 'Room 1610', 'room', 'S1600', null, false),
  ('S1609G0', 'Room 1609', 'room', 'S1600', null, false),
  ('S1608G0', 'Room 1608', 'room', 'S1600', null, false),
  ('S1607G0', 'Room 1607', 'room', 'S1600', null, false),
  ('S1606G0', 'Room 1606', 'room', 'S1600', null, false),
  ('S1605G0', 'Room 1605', 'room', 'S1600', null, false),
  ('S1604G0', 'Room 1604', 'room', 'S1600', null, false),
  ('S1603G0', 'Room 1603', 'room', 'S1600', null, false),
  ('S1602G0', 'Room 1602', 'room', 'S1600', null, false),
  ('S1601G0', 'Room 1601', 'room', 'S1600', null, false),
  ('S1520G0', 'Room 1520', 'room', 'S1500', null, false),
  ('S1519G0', 'Room 1519', 'room', 'S1500', null, false),
  ('S1518G0', 'Room 1518', 'room', 'S1500', null, false),
  ('S1517G0', 'Room 1517', 'room', 'S1500', null, false),
  ('S1516G0', 'Room 1516', 'room', 'S1500', null, false),
  ('S1515G0', 'Room 1515', 'room', 'S1500', null, false),
  ('S1514G0', 'Room 1514', 'room', 'S1500', null, false),
  ('S1513G0', 'Room 1513', 'room', 'S1500', null, false),
  ('S1512G0', 'Room 1512', 'room', 'S1500', null, false),
  ('S1511G0', 'Room 1511', 'room', 'S1500', null, false),
  ('S1510G0', 'Room 1510', 'room', 'S1500', null, false),
  ('S1509G0', 'Room 1509', 'room', 'S1500', null, false),
  ('S1508G0', 'Room 1508', 'room', 'S1500', null, false),
  ('S1507G0', 'Room 1507', 'room', 'S1500', null, false),
  ('S1506G0', 'Room 1506', 'room', 'S1500', null, false),
  ('S1505G0', 'Room 1505', 'room', 'S1500', null, false),
  ('S1504G0', 'Room 1504', 'room', 'S1500', null, false),
  ('S1503G0', 'Room 1503', 'room', 'S1500', null, false),
  ('S1502G0', 'Room 1502', 'room', 'S1500', null, false),
  ('S1501G0', 'Room 1501', 'room', 'S1500', null, false),
  ('S1420G0', 'Room 1420', 'room', 'S1400', null, false),
  ('S1419G0', 'Room 1419', 'room', 'S1400', null, false),
  ('S1418G0', 'Room 1418', 'room', 'S1400', null, false),
  ('S1417G0', 'Room 1417', 'room', 'S1400', null, false),
  ('S1416G0', 'Room 1416', 'room', 'S1400', null, false),
  ('S1415G0', 'Room 1415', 'room', 'S1400', null, false),
  ('S1414G0', 'Room 1414', 'room', 'S1400', null, false),
  ('S1413G0', 'Room 1413', 'room', 'S1400', null, false),
  ('S1412G0', 'Room 1412', 'room', 'S1400', null, false),
  ('S1411G0', 'Room 1411', 'room', 'S1400', null, false),
  ('S1410G0', 'Room 1410', 'room', 'S1400', null, false),
  ('S1409G0', 'Room 1409', 'room', 'S1400', null, false),
  ('S1408G0', 'Room 1408', 'room', 'S1400', null, false),
  ('S1407G0', 'Room 1407', 'room', 'S1400', null, false),
  ('S1406G0', 'Room 1406', 'room', 'S1400', null, false),
  ('S1405G0', 'Room 1405', 'room', 'S1400', null, false),
  ('S1404G0', 'Room 1404', 'room', 'S1400', null, false),
  ('S1403G0', 'Room 1403', 'room', 'S1400', null, false),
  ('S1402G0', 'Room 1402', 'room', 'S1400', null, false),
  ('S1401G0', 'Room 1401', 'room', 'S1400', null, false),
  ('S1220G0', 'Room 1220', 'room', 'S1200', null, false),
  ('S1219G0', 'Room 1219', 'room', 'S1200', null, false),
  ('S1218G0', 'Room 1218', 'room', 'S1200', null, false),
  ('S1217G0', 'Room 1217', 'room', 'S1200', null, false),
  ('S1216G0', 'Room 1216', 'room', 'S1200', null, false),
  ('S1215G0', 'Room 1215', 'room', 'S1200', null, false),
  ('S1214G0', 'Room 1214', 'room', 'S1200', null, false),
  ('S1213G0', 'Room 1213', 'room', 'S1200', null, false),
  ('S1212G0', 'Room 1212', 'room', 'S1200', null, false),
  ('S1211G0', 'Room 1211', 'room', 'S1200', null, false),
  ('S1210G0', 'Room 1210', 'room', 'S1200', null, false),
  ('S1209G0', 'Room 1209', 'room', 'S1200', null, false),
  ('S1208G0', 'Room 1208', 'room', 'S1200', null, false),
  ('S1207G0', 'Room 1207', 'room', 'S1200', null, false),
  ('S1206G0', 'Room 1206', 'room', 'S1200', null, false),
  ('S1205G0', 'Room 1205', 'room', 'S1200', null, false),
  ('S1204G0', 'Room 1204', 'room', 'S1200', null, false),
  ('S1203G0', 'Room 1203', 'room', 'S1200', null, false),
  ('S1202G0', 'Room 1202', 'room', 'S1200', null, false),
  ('S1201G0', 'Room 1201', 'room', 'S1200', null, false),
  ('S1120G0', 'Room 1120', 'room', 'S1100', null, false),
  ('S1119G0', 'Room 1119', 'room', 'S1100', null, false),
  ('S1118G0', 'Room 1118', 'room', 'S1100', null, false),
  ('S1117G0', 'Room 1117', 'room', 'S1100', null, false),
  ('S1116G0', 'Room 1116', 'room', 'S1100', null, false),
  ('S1115G0', 'Room 1115', 'room', 'S1100', null, false),
  ('S1114G0', 'Room 1114', 'room', 'S1100', null, false),
  ('S1113G0', 'Room 1113', 'room', 'S1100', null, false),
  ('S1112G0', 'Room 1112', 'room', 'S1100', null, false),
  ('S1111G0', 'Room 1111', 'room', 'S1100', null, false),
  ('S1110G0', 'Room 1110', 'room', 'S1100', null, false),
  ('S1109G0', 'Room 1109', 'room', 'S1100', null, false),
  ('S1108G0', 'Room 1108', 'room', 'S1100', null, false),
  ('S1107G0', 'Room 1107', 'room', 'S1100', null, false),
  ('S1106G0', 'Room 1106', 'room', 'S1100', null, false),
  ('S1105G0', 'Room 1105', 'room', 'S1100', null, false),
  ('S1104G0', 'Room 1104', 'room', 'S1100', null, false),
  ('S1103G0', 'Room 1103', 'room', 'S1100', null, false),
  ('S1102G0', 'Room 1102', 'room', 'S1100', null, false),
  ('S1101G0', 'Room 1101', 'room', 'S1100', null, false),
  ('S1020G0', 'Room 1020', 'room', 'S1000', null, false),
  ('S1019G0', 'Room 1019', 'room', 'S1000', null, false),
  ('S1018G0', 'Room 1018', 'room', 'S1000', null, false),
  ('S1017G0', 'Room 1017', 'room', 'S1000', null, false),
  ('S1016G0', 'Room 1016', 'room', 'S1000', null, false),
  ('S1015G0', 'Room 1015', 'room', 'S1000', null, false),
  ('S1014G0', 'Room 1014', 'room', 'S1000', null, false),
  ('S1013G0', 'Room 1013', 'room', 'S1000', null, false),
  ('S1012G0', 'Room 1012', 'room', 'S1000', null, false),
  ('S1011G0', 'Room 1011', 'room', 'S1000', null, false),
  ('S1010G0', 'Room 1010', 'room', 'S1000', null, false),
  ('S1009G0', 'Room 1009', 'room', 'S1000', null, false),
  ('S1008G0', 'Room 1008', 'room', 'S1000', null, false),
  ('S1007G0', 'Room 1007', 'room', 'S1000', null, false),
  ('S1006G0', 'Room 1006', 'room', 'S1000', null, false),
  ('S1005G0', 'Room 1005', 'room', 'S1000', null, false),
  ('S1004G0', 'Room 1004', 'room', 'S1000', null, false),
  ('S1003G0', 'Room 1003', 'room', 'S1000', null, false),
  ('S1002G0', 'Room 1002', 'room', 'S1000', null, false),
  ('S1001G0', 'Room 1001', 'room', 'S1000', null, false),
  ('SB109B0', 'Reservation office', 'room', 'SB100', null, false),
  ('SB121B0', 'Receiving office', 'room', 'SB100', null, false),
  ('SB122B0', 'Receiving area', 'room', 'SB100', null, false),
  ('S0300P1', 'Public restroom 3F', 'room', 'S0300', null, false),
  ('S0200P1', 'Public restroom 2F', 'room', 'S0200', null, false),
  ('S0100P1', 'Public restroom 1F', 'room', 'S0100', null, false),
  ('S1810P1', 'Pool lobby', 'room', 'S1800', null, false),
  ('S1810B0', 'Pool bar Store', 'room', 'S1800', null, false),
  ('S1810P2', 'Pool area', 'room', 'S1800', null, false),
  ('SRT00E2', 'PAU room', 'room', 'SRT00', null, false),
  ('S0113B0', 'Pastry kitchen', 'room', 'S0100', null, false),
  ('SRT00L2', 'Passenger lift PL3', 'room', 'SRT00', null, false),
  ('SRT00L1', 'Passenger lift PL1-PL2', 'room', 'SRT00', null, false),
  ('S0900L1', 'Passenger lift lobby 9F', 'room', 'S0900', null, false),
  ('S0800L1', 'Passenger lift lobby 8F', 'room', 'S0800', null, false),
  ('S0700L1', 'Passenger lift lobby 7F', 'room', 'S0700', null, false),
  ('S0600L1', 'Passenger lift lobby 6F', 'room', 'S0600', null, false),
  ('S0500L1', 'Passenger lift lobby 5F', 'room', 'S0500', null, false),
  ('S0400L1', 'Passenger lift lobby 4F', 'room', 'S0400', null, false),
  ('S0300L1', 'Passenger lift lobby 3F', 'room', 'S0300', null, false),
  ('S0200L1', 'Passenger lift lobby 2F', 'room', 'S0200', null, false),
  ('S2000L1', 'Passenger lift lobby 20F', 'room', 'S2000', null, false),
  ('S0100L1', 'Passenger lift lobby 1F', 'room', 'S0100', null, false),
  ('S1900L1', 'Passenger lift lobby 19F', 'room', 'S1900', null, false),
  ('S1800L1', 'Passenger lift lobby 18F', 'room', 'S1800', null, false),
  ('S1700L1', 'Passenger lift lobby 17F', 'room', 'S1700', null, false),
  ('S1600L1', 'Passenger lift lobby 16F', 'room', 'S1600', null, false),
  ('S1500L1', 'Passenger lift lobby 15F', 'room', 'S1500', null, false),
  ('S1400L1', 'Passenger lift lobby 14F', 'room', 'S1400', null, false),
  ('S1200L1', 'Passenger lift lobby 12F', 'room', 'S1200', null, false),
  ('S1100L1', 'Passenger lift lobby 11F', 'room', 'S1100', null, false),
  ('S1000L1', 'Passenger lift lobby 10F', 'room', 'S1000', null, false),
  ('C0200P0', 'Parking area', 'room', 'C0200', null, false),
  ('C0300K0', 'Parking area', 'room', 'C0300', null, false),
  ('C0400K0', 'Parking area', 'room', 'C0400', null, false),
  ('C0500K0', 'Parking area', 'room', 'C0500', null, false),
  ('S0205B0', 'Pantry room service', 'room', 'S0200', null, false),
  ('SB132B0', 'Pantry kitchen B1', 'room', 'SB100', null, false),
  ('S0109B0', 'Pantry boudoir', 'room', 'S0100', null, false),
  ('S0310B1', 'Pantry Barbaard', 'room', 'S0300', null, false),
  ('S0900B0', 'Pantry 9F', 'room', 'S0900', null, false),
  ('S0800B0', 'Pantry 8F', 'room', 'S0800', null, false),
  ('S0700B0', 'Pantry 7F', 'room', 'S0700', null, false),
  ('S0600B0', 'Pantry 6F', 'room', 'S0600', null, false),
  ('S0500B0', 'Pantry 5F', 'room', 'S0500', null, false),
  ('S0400B0', 'Pantry 4F', 'room', 'S0400', null, false),
  ('S2000B0', 'Pantry 20F', 'room', 'S2000', null, false),
  ('S1900B0', 'Pantry 19F', 'room', 'S1900', null, false),
  ('S1800B0', 'Pantry 18F', 'room', 'S1800', null, false),
  ('S1700B0', 'Pantry 17F', 'room', 'S1700', null, false),
  ('S1600B0', 'Pantry 16F', 'room', 'S1600', null, false),
  ('S1500B0', 'Pantry 15F', 'room', 'S1500', null, false),
  ('S1400B0', 'Pantry 14F', 'room', 'S1400', null, false),
  ('S1200B0', 'Pantry 12F', 'room', 'S1200', null, false),
  ('S1100B0', 'Pantry 11F', 'room', 'S1100', null, false),
  ('S1000B0', 'Pantry 10F', 'room', 'S1000', null, false),
  ('SB112E0', 'PABX room', 'room', 'SB100', null, false),
  ('S0203B1', 'Mezz show kitchen', 'room', 'S0200', null, false),
  ('S0203P1', 'Mezz restaurant', 'room', 'S0200', null, false),
  ('S0203B2', 'Mezz hot kitchen', 'room', 'S0200', null, false),
  ('S0203B3', 'Mezz cold kitchen', 'room', 'S0200', null, false),
  ('SB113E0', 'MDF room', 'room', 'SB100', null, false),
  ('S0312P5', 'Male locker fitness', 'room', 'S0300', null, false),
  ('SB143B0', 'Male locker B1', 'room', 'SB100', null, false),
  ('C0300E0', 'Maintenance Room', 'room', 'C0300', null, false),
  ('S0206E0', 'M&E plant room 2F', 'room', 'S0200', null, false),
  ('S1800E1', 'M&E plant room 18F', 'room', 'S1800', null, false),
  ('S0106B0', 'Luggage room', 'room', 'S0100', null, false),
  ('SB140B2', 'LPG store', 'room', 'SB100', null, false),
  ('SB105E0', 'Low voltage room', 'room', 'SB100', null, false),
  ('SB1O8B0', 'Loss/found room', 'room', 'SB100', null, false),
  ('C0100P0', 'Lobby', 'room', 'C0100', null, false),
  ('SB119B0', 'Linen Store', 'room', 'SB100', null, false),
  ('SB116B0', 'Laundry office', 'room', 'SB100', null, false),
  ('SB115B0', 'Laundry area', 'room', 'SB100', null, false),
  ('S0111B0', 'Kitchen office', 'room', 'S0100', 'KIT', true),
  ('S0306G0', 'Jade', 'room', 'S0300', null, false),
  ('S0103B0', 'It office', 'room', 'S0100', 'ITD', true),
  ('SB117B0', 'Housekeeping office', 'room', 'SB100', 'HKD', true),
  ('S0310P2', 'House of Barbaard', 'room', 'S0300', null, false),
  ('SB138B3', 'Hk Store B1F-1', 'room', 'SB100', null, false),
  ('S0400B1', 'HK Store 4F-1', 'room', 'S0400', null, false),
  ('SB105E1', 'High voltage room', 'room', 'SB100', null, false),
  ('S0312P1', 'Gym area', 'room', 'S0300', null, false),
  ('S0301B0', 'GM office', 'room', 'S0300', null, false),
  ('SB103E0', 'Genset room', 'room', 'SB100', null, false),
  ('SB131B0', 'General Store', 'room', 'SB100', null, false),
  ('S0400P4', 'Garden area 4F-2', 'room', 'S0400', null, false),
  ('S0400P3', 'Garden area 4F-1', 'room', 'S0400', null, false),
  ('SB128E0', 'Garbage store', 'room', 'SB100', null, false),
  ('S0118B0', 'Freezer store N08', 'room', 'S0100', null, false),
  ('S0120G0', 'Foyer Daimond hall', 'room', 'S0100', null, false),
  ('SB137B0', 'Flower store', 'room', 'SB100', null, false),
  ('SB136B0', 'Flower room', 'room', 'SB100', null, false),
  ('S0313B2', 'Fitness store', 'room', 'S0300', null, false),
  ('SB201E0', 'Fire pump system', 'room', 'SB200', null, false),
  ('SB120B0', 'Finance office', 'room', 'SB100', 'FIN', true),
  ('S0312P4', 'Female locker fitness', 'room', 'S0300', null, false),
  ('SB144B0', 'Female locker B1', 'room', 'SB100', null, false),
  ('SB125B2', 'Feezer store N02', 'room', 'SB100', null, false),
  ('SB125B1', 'Feezer store N01', 'room', 'SB100', null, false),
  ('S0400B2', 'FB Store 4F-2', 'room', 'S0400', null, false),
  ('SB135B0', 'FB artist office', 'room', 'SB100', null, false),
  ('S2000E2', 'Fan room 20F-2', 'room', 'S2000', null, false),
  ('S2000E1', 'Fan room 20F-1', 'room', 'S2000', null, false),
  ('SB142B0', 'F&B office', 'room', 'SB100', 'FBD', true),
  ('S0100P0', 'Entrance lobby', 'room', 'S0100', null, false),
  ('SB141B0', 'Engineering workshop', 'room', 'SB100', null, false),
  ('SB140B0', 'Engineering office', 'room', 'SB100', 'ENG', true),
  ('SB139B1', 'Engineering Building workshop', 'room', 'SB100', null, false),
  ('SB130B0', 'Empty Bottle Store', 'room', 'SB100', null, false),
  ('S0307G0', 'Emerald', 'room', 'S0300', null, false),
  ('S0100P3', 'Driveway out', 'room', 'S0100', null, false),
  ('S0100P2', 'Driveway in', 'room', 'S0100', null, false),
  ('C0300G0', 'Driver room', 'room', 'C0300', null, false),
  ('SB203E0', 'Domestic water pump', 'room', 'SB200', null, false),
  ('SB138B0', 'Doctor room', 'room', 'SB100', null, false),
  ('S0104B0', 'Director of Operation office', 'room', 'S0100', null, false),
  ('SB101B0', 'Diesel store', 'room', 'SB100', null, false),
  ('S0119G0', 'Daimond hall', 'room', 'S0100', null, false),
  ('SB110B0', 'Dail 2 office', 'room', 'SB100', null, false),
  ('SB100P2', 'Corridor Staff locker', 'room', 'SB100', null, false),
  ('SB100P1', 'Corridor Staff entrance', 'room', 'SB100', null, false),
  ('S0205P0', 'Corridor room service', 'room', 'S0200', null, false),
  ('S0203P0', 'Corridor res Mezz-kitchen', 'room', 'S0200', null, false),
  ('S0204P0', 'Corridor res Mezz-Bistro', 'room', 'S0200', null, false),
  ('S0112P0', 'Corridor Banquet', 'room', 'S0100', null, false),
  ('S0900P2', 'Corridor 9F-2', 'room', 'S0900', null, false),
  ('S0900P1', 'Corridor 9F-1', 'room', 'S0900', null, false),
  ('S0800P2', 'Corridor 8F-2', 'room', 'S0800', null, false),
  ('S0800P1', 'Corridor 8F-1', 'room', 'S0800', null, false),
  ('S0700P2', 'Corridor 7F-2', 'room', 'S0700', null, false),
  ('S0700P1', 'Corridor 7F-1', 'room', 'S0700', null, false),
  ('S0600P2', 'Corridor 6F-2', 'room', 'S0600', null, false),
  ('S0600P1', 'Corridor 6F-1', 'room', 'S0600', null, false),
  ('S0500P2', 'Corridor 5F-2', 'room', 'S0500', null, false),
  ('S0500P1', 'Corridor 5F-1', 'room', 'S0500', null, false),
  ('S0400P2', 'Corridor 4F-2', 'room', 'S0400', null, false),
  ('S0400P1', 'Corridor 4F-1', 'room', 'S0400', null, false),
  ('S0300P2', 'Corridor 3F', 'room', 'S0300', null, false),
  ('S2000P1', 'Corridor 20F-1', 'room', 'S2000', null, false),
  ('S1900P2', 'Corridor 19F-2', 'room', 'S1900', null, false),
  ('S1900P1', 'Corridor 19F-1', 'room', 'S1900', null, false),
  ('S1800P2', 'Corridor 18F-2', 'room', 'S1800', null, false),
  ('S1800P1', 'Corridor 18F-1', 'room', 'S1800', null, false),
  ('S1700P2', 'Corridor 17F-2', 'room', 'S1700', null, false),
  ('S1700P1', 'Corridor 17F-1', 'room', 'S1700', null, false),
  ('S1600P2', 'Corridor 16F-2', 'room', 'S1600', null, false),
  ('S1600P1', 'Corridor 16F-1', 'room', 'S1600', null, false),
  ('S1500P2', 'Corridor 15F-2', 'room', 'S1500', null, false),
  ('S1500P1', 'Corridor 15F-1', 'room', 'S1500', null, false),
  ('S1400P2', 'Corridor 14F-2', 'room', 'S1400', null, false),
  ('S1400P1', 'Corridor 14F-1', 'room', 'S1400', null, false),
  ('S1200P2', 'Corridor 12F-2', 'room', 'S1200', null, false),
  ('S1200P1', 'Corridor 12F-1', 'room', 'S1200', null, false),
  ('S1101P2', 'Corridor 11F-2', 'room', 'S1100', null, false),
  ('S1103P1', 'Corridor 11F-1', 'room', 'S1100', null, false),
  ('S1000P2', 'Corridor 10F-2', 'room', 'S1000', null, false),
  ('S1000P1', 'Corridor 10F-1', 'room', 'S1000', null, false),
  ('S0311E2', 'Cooling tower', 'room', 'S0300', null, false),
  ('SB127E0', 'Compressor control room', 'room', 'SB100', null, false),
  ('S1809P0', 'Club lounge', 'room', 'S1800', null, false),
  ('S1809B0', 'Club kitchen', 'room', 'S1800', null, false),
  ('SB126B3', 'Chiller store N10', 'room', 'SB100', null, false),
  ('S0204B1', 'Chiller store N09', 'room', 'S0200', null, false),
  ('S0117B0', 'Chiller store N07', 'room', 'S0100', null, false),
  ('S0115B0', 'Chiller store N06', 'room', 'S0100', null, false),
  ('SB126B2', 'Chiller store N04', 'room', 'SB100', null, false),
  ('SB126B1', 'Chiller store N03', 'room', 'SB100', null, false),
  ('S0311E1', 'Chiller plant room', 'room', 'S0300', null, false),
  ('SB129B0', 'Chemical Steward store', 'room', 'SB100', null, false),
  ('SB118B0', 'Chemical HK store', 'room', 'SB100', null, false),
  ('SB123E0', 'CCTV room', 'room', 'SB100', null, false),
  ('SB107P0', 'Casual labour locker', 'room', 'SB100', null, false),
  ('SB111B0', 'Cashier office', 'room', 'SB100', null, false),
  ('SB134B2', 'Canteen Store', 'room', 'SB100', null, false),
  ('SB134B1', 'Canteen kitchen', 'room', 'SB100', null, false),
  ('SB134P0', 'Canteen area', 'room', 'SB100', null, false),
  ('S0116B0', 'Butcher kitchen', 'room', 'S0100', null, false),
  ('S0303P1', 'Business center', 'room', 'S0300', null, false),
  ('S0109P0', 'Boudoir bar', 'room', 'S0100', null, false),
  ('SB106E0', 'Boiler room', 'room', 'SB100', null, false),
  ('S0202B2', 'Bistro store', 'room', 'S0200', null, false),
  ('S0202P0', 'Bistro restaurant', 'room', 'S0200', null, false),
  ('S0202B1', 'Bistro kitchen', 'room', 'S0200', null, false),
  ('S0310P1', 'Barbaard lobby', 'room', 'S0300', null, false),
  ('S0101B0', 'Banquet store', 'room', 'S0100', null, false),
  ('S0112B0', 'Banquet kitchen', 'room', 'S0100', null, false),
  ('S0107B0', 'Bakery shop', 'room', 'S0100', null, false),
  ('S0114B0', 'Bakery kitchen', 'room', 'S0100', null, false),
  ('S0105B0', 'Back office', 'room', 'S0100', null, false),
  ('S0201E2', 'AV control room', 'room', 'S0200', null, false),
  ('SB133B0', 'AHU room B1', 'room', 'SB100', null, false),
  ('S0110E0', 'AHU room 1F-1', 'room', 'S0100', null, false),
  ('S0201E1', 'AHU room', 'room', 'S0200', null, false),
  ('SRT00E3', 'Booster pump room', 'room', 'SRT00', null, false)
on conflict (code) do update
  set name           = excluded.name,
      kind           = excluded.kind,
      parent_code    = excluded.parent_code,
      -- coalesce, not a plain assignment: a dept_code set by hand on a room the
      -- template says nothing about must not be wiped on every re-seed.
      dept_code      = coalesce(excluded.dept_code, am_location.dept_code),
      is_dept_office = excluded.is_dept_office;


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
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
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
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
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
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
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
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
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
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
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
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
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
  -- Duyệt HỢP của hai phía, không phải chỉ từ bảng bộ đếm ra.
  --
  -- Nếu chỉ duyệt từ am_asset_seq thì khoá nào có tài sản nhưng CHƯA có dòng
  -- bộ đếm sẽ vô hình — mà đó mới là trường hợp nguy hiểm nhất: cấp mã cho
  -- khoá đó bắt đầu từ 1 và đụng ngay mã đã có. Khoá thiếu bộ đếm coi như
  -- next_seq = 0 nên gap ra âm và bị bắt lỗi.
  --
  -- seq = 0 là dòng lịch sử có mã không phân tích được, không được phép kéo
  -- bộ đếm lên nên loại ra.
  with k as (
    select dept_code, letters from am_asset_seq
    union
    select dept_code, letters from am_asset where seq > 0
  ),
  mx as (
    select dept_code, letters, max(seq) mx
    from am_asset where seq > 0 group by 1, 2
  )
  select  k.dept_code || '|' || k.letters,
          coalesce(s.next_seq, 0)::bigint,
          coalesce(a.mx, 0)::bigint,
          coalesce(s.next_seq, 0)::bigint - coalesce(a.mx, 0)::bigint - 1
  from    k
  left join am_asset_seq s using (dept_code, letters)
  left join mx a           using (dept_code, letters)
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

  select g.code, g.is_tools, g.is_intangible,
         coalesce(g.expense_class, 'CAPEX') as expense_class
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
    elsif v_grp.expense_class = 'OPEX' then
      -- O4000 is operating supplies and carries no accounting code, so it is
      -- never blocked. But an item this expensive is very unlikely to belong
      -- there, so say so and let the buyer decide.
      warnings := warnings || format(
        'Đơn giá %s > %s nhưng mã %s thuộc nhóm OPEX %s (đồ dùng vận hành, không có mã kế toán) — kiểm tra lại xem có phải TSCĐ không.',
        to_char(p_unit_price, 'FM999,999,999,999'),
        to_char(v_capex_threshold, 'FM999,999,999,999'),
        p_category_code, v_grp.code);
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
-- 04_rls.sql — BẬT RLS + QUYỀN NỀN
--
-- Từ 17_auth.sql trở đi app BẮT BUỘC ĐĂNG NHẬP. File này chỉ còn làm ba việc:
--   * bật RLS trên mọi bảng (chưa có policy = không ai đọc được, trừ postgres),
--   * cấp quyền bảng cho vai `authenticated` — RLS quyết định DÒNG nào,
--   * khoá ghi trực tiếp vào bảng bộ đếm (chỉ qua hàm SECURITY DEFINER).
--
-- Mọi POLICY nằm ở 17_auth.sql. File này KHÔNG cấp gì cho `anon`, nên chạy
-- lại nó sau 17 không mở lại hệ thống. (Bản cũ cấp "for all to anon using
-- (true)" cho gần như mọi bảng — ai có link là đọc/sửa được hết.)
--
-- Chạy SAU 03_functions.sql. Chạy lại nhiều lần vô hại.
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
-- 1. Quyền bảng cho người đã đăng nhập. RLS (17_auth.sql) lọc tiếp theo
--    vai trò và phạm vi phòng ban.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'am_setting','am_org','am_org_alias','am_category_group','am_category',
    'am_unit','am_origin','am_origin_alias','am_origin_rejected','am_location',
    'am_product','am_shipment','am_shipment_line','am_alr','am_alr_line',
    'am_xls_template','am_xls_column'
  ] loop
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- Sổ tài sản: KHÔNG có DELETE. Xoá chỉ qua am_undo_intake / am_bulk_delete,
-- là những hàm có luật đi kèm (giữ dòng đã nằm trên biên bản, v.v.).
grant select, insert, update on am_asset to authenticated;

-- Mọi bảng bigserial cần quyền dùng sequence thì INSERT mới chạy được.
-- Bộ đếm nghiệp vụ (am_asset_seq / am_barcode_seq / am_alr_seq) KHÔNG phải
-- sequence của Postgres nên không bị ảnh hưởng bởi lệnh này.
grant usage, select on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------
-- 2. Bộ đếm: chỉ đọc. Mọi thay đổi phải đi qua hàm SECURITY DEFINER.
--    Đây là lý do bộ đếm không thể bị "reset" từ trình duyệt.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['am_asset_seq','am_barcode_seq','am_counter_log','am_alr_seq'] loop
    execute format('revoke insert, update, delete on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Quyền gọi hàm — chỉ người đã đăng nhập. Hàm nào ghi dữ liệu thì tự
--    kiểm tra vai trò bên trong bằng app_require() (17_auth.sql).
-- ---------------------------------------------------------------------
grant execute on function am_norm(text)                                   to authenticated;
grant execute on function am_letters(text)                                to authenticated;
grant execute on function am_format_barcode(text, bigint)                 to authenticated;
grant execute on function am_parse_barcode(text)                          to authenticated;
grant execute on function am_build_asset_code(text, text, text, int, int) to authenticated;
grant execute on function am_alloc_asset_seq(text, text, int, bigint, text) to authenticated;
grant execute on function am_alloc_barcode(text, int, bigint, text)       to authenticated;
grant execute on function am_alloc_alr_code()                             to authenticated;
grant execute on function am_seed_asset_seq(text, text, int)              to authenticated;
grant execute on function am_seed_barcode(text, bigint)                   to authenticated;
grant execute on function am_seed_from_codes(text[])                      to authenticated;
grant execute on function am_audit_counters()                             to authenticated;
grant execute on function am_classify(numeric, text, boolean)             to authenticated;
grant execute on function am_resolve_origin(text)                         to authenticated;

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
-- Người duyệt ký GIỮA người lập và người nhận trên biên bản in.
alter table am_alr add column if not exists approved_by    text;
alter table am_alr add column if not exists received_by    text;
alter table am_alr add column if not exists received_dept  text references am_org(code);
alter table am_alr add column if not exists notes_text     text;
-- Ghi chú riêng của MỘT biên bản, khác notes_text là quy trình chung in cố định.
alter table am_alr add column if not exists comment_text   text;

comment on column am_alr.project_code is
  'Mã dự án FFE của đợt hàng, vd FFE.KIT.05.2025. Số hiệu biên bản suy ra từ đây.';
comment on column am_alr.comment_text is
  'Ghi chú tự do cho riêng biên bản này. Để trống thì KHÔNG in ra — một mục "Ghi chú:" rỗng trên chứng từ đã ký là chỗ mời người ta viết thêm bằng bút sau.';
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

grant execute on function am_alr_code_from_project(text) to authenticated;

-- ---------------------------------------------------------------------
-- Dòng tài sản của biên bản, kèm đủ trường để in thẳng ra 8 cột
-- Thứ tự cột in:
--   Stt | Mã tài sản | Tên tài sản | Số lượng | Thông số kỹ thuật
--       | Đơn giá | Vị trí | Tem nhãn
-- ---------------------------------------------------------------------
create or replace view am_alr_print with (security_invoker = true) as
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

grant select on am_alr_print to authenticated;

comment on view am_alr_print is
  'Nguồn in biên bản ALR. spec_summary là bản gom ngắn của các cột spec chi tiết — dùng cho ô "Thông số kỹ thuật cơ bản".';


-- ####################################################################
-- ##  06_seed_product.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake -- product catalogue
-- GENERATED by scripts/genseed.ps1 from the Beetrack master templates.
-- Source workbook: 8. product-catalogue-template-file.xlsx
-- Do not hand-edit; change the workbook or the script and re-run.
-- =====================================================================
insert into am_product (raw_name_norm, raw_name, std_name_vi, std_name_en, default_category, default_unit, default_brand) values
  (am_norm('AHU/Air handling unit'), 'AHU/Air handling unit', 'AHU', 'Air handling unit', 'MES', null, null),
  (am_norm('Áp phích/Poster'), 'Áp phích/Poster', 'Áp phích', 'Poster', 'LTG', null, null),
  (am_norm('Bậc/Step'), 'Bậc/Step', 'Bậc', 'Step', 'LTU', null, null),
  (am_norm('Bàn/Table'), 'Bàn/Table', 'Bàn', 'Table', 'LTU', null, null),
  (am_norm('Ban công/Balcony'), 'Ban công/Balcony', 'Ban công', 'Balcony', 'MES', null, null),
  (am_norm('Bàn lạnh/Refrigerated table'), 'Bàn lạnh/Refrigerated table', 'Bàn lạnh', 'Refrigerated table', 'KME', null, null),
  (am_norm('Bản lề/Hinge'), 'Bản lề/Hinge', 'Bản lề', 'Hinge', 'LTU', null, null),
  (am_norm('Bàn liền ghế/Table with chairs'), 'Bàn liền ghế/Table with chairs', 'Bàn liền ghế', 'Table with chairs', 'LTU', null, null),
  (am_norm('Bàn phím/Keyboard'), 'Bàn phím/Keyboard', 'Bàn phím', 'Keyboard', 'LTU', null, null),
  (am_norm('Bàn ủi/Iron'), 'Bàn ủi/Iron', 'Bàn ủi', 'Iron', 'FUR', null, null),
  (am_norm('Bảng/Flipchart/Board/Panel'), 'Bảng/Flipchart/Board/Panel', 'Bảng', 'Flipchart/Board/Panel', 'LTU', null, null),
  (am_norm('Bánh xe/Wheel'), 'Bánh xe/Wheel', 'Bánh xe', 'Wheel', 'LTU', null, null),
  (am_norm('Bao cát/Punching bag'), 'Bao cát/Punching bag', 'Bao cát', 'Punching bag', 'LTU', null, null),
  (am_norm('Bảo ôn đường ống/Pipe insulation'), 'Bảo ôn đường ống/Pipe insulation', 'Bảo ôn đường ống', 'Pipe insulation', 'INF', null, null),
  (am_norm('Bao thư/Envelope'), 'Bao thư/Envelope', 'Bao thư', 'Envelope', 'LTG', null, null),
  (am_norm('Bầu giải nhiệt/Heat exchanger'), 'Bầu giải nhiệt/Heat exchanger', 'Bầu giải nhiệt', 'Heat exchanger', 'LTG', null, null),
  (am_norm('Bẫy hơi/Steam trap'), 'Bẫy hơi/Steam trap', 'Bẫy hơi', 'Steam trap', 'MES', null, null),
  (am_norm('Bẫy mỡ/Grease Interceptor'), 'Bẫy mỡ/Grease Interceptor', 'Bẫy mỡ', 'Grease Interceptor', 'MES', null, null),
  (am_norm('Bể tách mỡ/Grease separator tank'), 'Bể tách mỡ/Grease separator tank', 'Bể tách mỡ', 'Grease separator tank', 'MES', null, null),
  (am_norm('Bếp/Stove'), 'Bếp/Stove', 'Bếp', 'Stove', 'KME', null, null),
  (am_norm('Bìa/Cover'), 'Bìa/Cover', 'Bìa', 'Cover', 'LTU', null, null),
  (am_norm('Biến áp/Transformer'), 'Biến áp/Transformer', 'Biến áp', 'Transformer', 'LTU', null, null),
  (am_norm('Biển báo/Signboard'), 'Biển báo/Signboard', 'Biển báo', 'Signboard', 'LTU', null, null),
  (am_norm('Biển hiệu/Signage'), 'Biển hiệu/Signage', 'Biển hiệu', 'Signage', 'LTU', null, null),
  (am_norm('Biến tần/Inverter'), 'Biến tần/Inverter', 'Biến tần', 'Inverter', 'MES', null, null),
  (am_norm('Biệt thự/Villa'), 'Biệt thự/Villa', 'Biệt thự', 'Villa', 'BUL', null, null),
  (am_norm('Bình/Vase'), 'Bình/Vase', 'Bình', 'Vase', 'LTU', null, null),
  (am_norm('BMS/Building management unit'), 'BMS/Building management unit', 'BMS', 'Building management unit', 'CTP', null, null),
  (am_norm('Bộ âm thanh/Sound system'), 'Bộ âm thanh/Sound system', 'Bộ âm thanh', 'Sound system', 'KME', null, null),
  (am_norm('Bộ bàn ghế/Dining set'), 'Bộ bàn ghế/Dining set', 'Bộ bàn ghế', 'Dining set', 'OTA', null, null),
  (am_norm('Bộ cân bằng âm thanh/Audio equalizer'), 'Bộ cân bằng âm thanh/Audio equalizer', 'Bộ cân bằng âm thanh', 'Audio equalizer', 'LTU', null, null),
  (am_norm('Bộ chuyển đổi/Converter'), 'Bộ chuyển đổi/Converter', 'Bộ chuyển đổi', 'Converter', 'KME', null, null),
  (am_norm('Bộ đàm/Walkie talkie'), 'Bộ đàm/Walkie talkie', 'Bộ đàm', 'Walkie talkie', 'LTU', null, null),
  (am_norm('Bộ điều chỉnh nguồn và âm lượng/Source select and volume control'), 'Bộ điều chỉnh nguồn và âm lượng/Source select and volume control', 'Bộ điều chỉnh nguồn và âm lượng', 'Source select and volume control', 'LTU', null, null),
  (am_norm('Bộ điề̀u khiển/Controller'), 'Bộ điề̀u khiển/Controller', 'Bộ điề̀u khiển', 'Controller', 'LTU', null, null),
  (am_norm('Bộ định tuyến/Router'), 'Bộ định tuyến/Router', 'Bộ định tuyến', 'Router', 'LTU', null, null),
  (am_norm('Bộ đo/Measurement set'), 'Bộ đo/Measurement set', 'Bộ đo', 'Measurement set', 'LTU', null, null),
  (am_norm('Bộ giải mã/Decoder'), 'Bộ giải mã/Decoder', 'Bộ giải mã', 'Decoder', 'LTU', null, null),
  (am_norm('Bộ kết nối/Connector'), 'Bộ kết nối/Connector', 'Bộ kết nối', 'Connector', 'FUR', null, null),
  (am_norm('Bộ khóa/Lock unit'), 'Bộ khóa/Lock unit', 'Bộ khóa', 'Lock unit', 'LTU', null, null),
  (am_norm('Bộ lặp/Repeater'), 'Bộ lặp/Repeater', 'Bộ lặp', 'Repeater', 'LTU', null, null),
  (am_norm('Bộ lọc/Filter'), 'Bộ lọc/Filter', 'Bộ lọc', 'Filter', 'LTG', null, null),
  (am_norm('Bộ lưu điện/UPS'), 'Bộ lưu điện/UPS', 'Bộ lưu điện', 'UPS', 'LTU', null, null),
  (am_norm('Bộ mã hóa/Encoding unit'), 'Bộ mã hóa/Encoding unit', 'Bộ mã hóa', 'Encoding unit', 'LTU', null, null),
  (am_norm('Bo mạch/Circuit board'), 'Bo mạch/Circuit board', 'Bo mạch', 'Circuit board', 'OIA', null, null),
  (am_norm('Bộ máy tính/Computer set'), 'Bộ máy tính/Computer set', 'Bộ máy tính', 'Computer set', 'OEM', null, null),
  (am_norm('Bộ ngắt mạch thu nhỏ/Circuit breaker'), 'Bộ ngắt mạch thu nhỏ/Circuit breaker', 'Bộ ngắt mạch thu nhỏ', 'Circuit breaker', 'LTU', null, null),
  (am_norm('Bộ nhớ kênh/Channel beltpack'), 'Bộ nhớ kênh/Channel beltpack', 'Bộ nhớ kênh', 'Channel beltpack', 'LTU', null, null),
  (am_norm('Bộ phân phối/Dispenser'), 'Bộ phân phối/Dispenser', 'Bộ phân phối', 'Dispenser', 'LTU', null, null),
  (am_norm('Bộ phân tần/Crossover'), 'Bộ phân tần/Crossover', 'Bộ phân tần', 'Crossover', 'LTU', null, null),
  (am_norm('Bộ phát tín hiệu/Transmitter'), 'Bộ phát tín hiệu/Transmitter', 'Bộ phát tín hiệu', 'Transmitter', 'LTU', null, null),
  (am_norm('Bộ phòng họp/Meeting room set'), 'Bộ phòng họp/Meeting room set', 'Bộ phòng họp', 'Meeting room set', 'LTU', null, null),
  (am_norm('Bộ thiết bị nội thất trong phòng/Indoor furniture set'), 'Bộ thiết bị nội thất trong phòng/Indoor furniture set', 'Bộ thiết bị nội thất trong phòng', 'Indoor furniture set', 'OTA', null, null),
  (am_norm('Bộ thiết bị văn phòng/Office equipment set'), 'Bộ thiết bị văn phòng/Office equipment set', 'Bộ thiết bị văn phòng', 'Office equipment set', 'OEM', null, null),
  (am_norm('Bộ thiết bị vệ sinh/Sanitary equipment set'), 'Bộ thiết bị vệ sinh/Sanitary equipment set', 'Bộ thiết bị vệ sinh', 'Sanitary equipment set', 'SME', null, null),
  (am_norm('Bộ thu/Receiver'), 'Bộ thu/Receiver', 'Bộ thu', 'Receiver', 'LTU', null, null),
  (am_norm('Bộ tiếp nhận/Receiver'), 'Bộ tiếp nhận/Receiver', 'Bộ tiếp nhận', 'Receiver', 'LTU', null, null),
  (am_norm('Bộ trộn/Mixer'), 'Bộ trộn/Mixer', 'Bộ trộn', 'Mixer', 'LTU', null, null),
  (am_norm('Bộ truy cập/Access point'), 'Bộ truy cập/Access point', 'Bộ truy cập', 'Access point', 'LTU', null, null),
  (am_norm('Bộ xử lý/Processor'), 'Bộ xử lý/Processor', 'Bộ xử lý', 'Processor', 'LTU', null, null),
  (am_norm('Bọc vải/Cover'), 'Bọc vải/Cover', 'Bọc vải', 'Cover', 'LTU', null, null),
  (am_norm('Bồn cầu/Toilet bowl'), 'Bồn cầu/Toilet bowl', 'Bồn cầu', 'Toilet bowl', 'LTG', null, null),
  (am_norm('Bồn chứa/Tank'), 'Bồn chứa/Tank', 'Bồn chứa', 'Tank', 'LTU', null, null),
  (am_norm('Bồn nước/Water tank'), 'Bồn nước/Water tank', 'Bồn nước', 'Water tank', 'INF', null, null),
  (am_norm('Bồn tắm/Bathtub'), 'Bồn tắm/Bathtub', 'Bồn tắm', 'Bathtub', 'LTU', null, null),
  (am_norm('Bồn tiểu/Urinal'), 'Bồn tiểu/Urinal', 'Bồn tiểu', 'Urinal', 'LTU', null, null),
  (am_norm('Bóng đèn/Bulb'), 'Bóng đèn/Bulb', 'Bóng đèn', 'Bulb', 'LTG', null, null),
  (am_norm('Bóng tập thể dục/Exercise ball'), 'Bóng tập thể dục/Exercise ball', 'Bóng tập thể dục', 'Exercise ball', 'LTG', null, null),
  (am_norm('Bục/Lectern'), 'Bục/Lectern', 'Bục', 'Lectern', 'KME', null, null),
  (am_norm('Buồng/Cabin'), 'Buồng/Cabin', 'Buồng', 'Cabin', 'LTU', null, null),
  (am_norm('Bút cảm ứng/Stylus pen'), 'Bút cảm ứng/Stylus pen', 'Bút cảm ứng', 'Stylus pen', 'LTG', null, null),
  (am_norm('Bình/Bottle'), 'Bình/Bottle', 'Bình', 'Bottle', 'LTU', null, null),
  (am_norm('Bút chiếu/Projection pen'), 'Bút chiếu/Projection pen', 'Bút chiếu', 'Projection pen', 'LTU', null, null),
  (am_norm('Cảm biến/Sensor'), 'Cảm biến/Sensor', 'Cảm biến', 'Sensor', 'LTU', null, null),
  (am_norm('Camera/Camera'), 'Camera/Camera', 'Camera', 'Camera', 'LTU', null, null),
  (am_norm('Cân/Scale'), 'Cân/Scale', 'Cân', 'Scale', 'LTU', null, null),
  (am_norm('Cáng cứu thương/Stretcher'), 'Cáng cứu thương/Stretcher', 'Cáng cứu thương', 'Stretcher', 'LTU', null, null),
  (am_norm('Cáp/Cable'), 'Cáp/Cable', 'Cáp', 'Cable', 'LTU', null, null),
  (am_norm('Card âm thanh/Audio card'), 'Card âm thanh/Audio card', 'Card âm thanh', 'Audio card', 'LTU', null, null),
  (am_norm('Card điện tử/Electronic card'), 'Card điện tử/Electronic card', 'Card điện tử', 'Electronic card', 'LTU', null, null),
  (am_norm('Card đồ họa/Graphics card'), 'Card đồ họa/Graphics card', 'Card đồ họa', 'Graphics card', 'LTU', null, null),
  (am_norm('Card mạng/Network card'), 'Card mạng/Network card', 'Card mạng', 'Network card', 'LTU', null, null),
  (am_norm('Cầu thang/Staircase'), 'Cầu thang/Staircase', 'Cầu thang', 'Staircase', 'INF', null, null),
  (am_norm('Chân đèn/Candelabra'), 'Chân đèn/Candelabra', 'Chân đèn', 'Candelabra', 'KME', null, null),
  (am_norm('Chảo/Pan'), 'Chảo/Pan', 'Chảo', 'Pan', 'LTG', null, null),
  (am_norm('Chậ̣u/Pot'), 'Chậ̣u/Pot', 'Chậ̣u', 'Pot', 'LTU', null, null),
  (am_norm('Chậu rửa/Sink'), 'Chậu rửa/Sink', 'Chậu rửa', 'Sink', 'LTU', null, null),
  (am_norm('Chống thấm/Waterproofing'), 'Chống thấm/Waterproofing', 'Chống thấm', 'Waterproofing', 'LTG', null, null),
  (am_norm('Chuông/Bell'), 'Chuông/Bell', 'Chuông', 'Bell', 'LTU', null, null),
  (am_norm('Chương trình điều khiển hệ thống tích hợp/Integrated system control program'), 'Chương trình điều khiển hệ thống tích hợp/Integrated system control program', 'Chương trình điều khiển hệ thống tích hợp', 'Integrated system control program', 'KME', null, null),
  (am_norm('Chuột/Computer mouse'), 'Chuột/Computer mouse', 'Chuột', 'Computer mouse', 'LTU', null, null),
  (am_norm('Cổ áo/Collar'), 'Cổ áo/Collar', 'Cổ áo', 'Collar', 'LTU', null, null),
  (am_norm('Con lăn/Roller'), 'Con lăn/Roller', 'Con lăn', 'Roller', 'LTU', null, null),
  (am_norm('Cổng/Gate'), 'Cổng/Gate', 'Cổng', 'Gate', 'STR', null, null),
  (am_norm('Công tắc/Switch'), 'Công tắc/Switch', 'Công tắc', 'Switch', 'LTU', null, null),
  (am_norm('Cổng từ/Magnetic gate'), 'Cổng từ/Magnetic gate', 'Cổng từ', 'Magnetic gate', 'LTU', null, null),
  (am_norm('Công viên nước/Water park'), 'Công viên nước/Water park', 'Công viên nước', 'Water park', 'STR', null, null),
  (am_norm('Cột/Column'), 'Cột/Column', 'Cột', 'Column', 'STR', null, null),
  (am_norm('CPU/CPU'), 'CPU/CPU', 'CPU', 'CPU', 'LTU', null, null),
  (am_norm('Cửa/Door'), 'Cửa/Door', 'Cửa', 'Door', 'LTU', null, null),
  (am_norm('Cuộn cảm/Inductor'), 'Cuộn cảm/Inductor', 'Cuộn cảm', 'Inductor', 'LTU', null, null),
  (am_norm('Cuộn dây làm mát/Cooling coil'), 'Cuộn dây làm mát/Cooling coil', 'Cuộn dây làm mát', 'Cooling coil', 'MES', null, null),
  (am_norm('Cút thép hàn/Welded steel fitting'), 'Cút thép hàn/Welded steel fitting', 'Cút thép hàn', 'Welded steel fitting', 'LTU', null, null),
  (am_norm('Đá/Stone'), 'Đá/Stone', 'Đá', 'Stone', 'LTU', null, null),
  (am_norm('Đàn dương cầm/Piano'), 'Đàn dương cầm/Piano', 'Đàn dương cầm', 'Piano', 'KME', null, null),
  (am_norm('Đầu đọc/Reader'), 'Đầu đọc/Reader', 'Đầu đọc', 'Reader', 'LTG', null, null),
  (am_norm('Đầu đổi/Changer'), 'Đầu đổi/Changer', 'Đầu đổi', 'Changer', 'LTU', null, null),
  (am_norm('Đầu ghi/Recorder'), 'Đầu ghi/Recorder', 'Đầu ghi', 'Recorder', 'LTU', null, null),
  (am_norm('Đầu kết nối/Connector'), 'Đầu kết nối/Connector', 'Đầu kết nối', 'Connector', 'LTU', null, null),
  (am_norm('Đầu phát/Player'), 'Đầu phát/Player', 'Đầu phát', 'Player', 'LTU', null, null),
  (am_norm('Đầu phun nước/Sprinkler head'), 'Đầu phun nước/Sprinkler head', 'Đầu phun nước', 'Sprinkler head', 'LTG', null, null),
  (am_norm('Dây/Wire'), 'Dây/Wire', 'Dây', 'Wire', 'LTU', null, null),
  (am_norm('Co/Elbow'), 'Co/Elbow', 'Co', 'Elbow', 'LTG', null, null),
  (am_norm('Dây kháng lực/Resistance band'), 'Dây kháng lực/Resistance band', 'Dây kháng lực', 'Resistance band', 'LTU', null, null),
  (am_norm('Đế/Base'), 'Đế/Base', 'Đế', 'Base', 'LTU', null, null),
  (am_norm('Đèn/Light'), 'Đèn/Light', 'Đèn', 'Light', 'LTG', null, null),
  (am_norm('Đĩa/Plate'), 'Đĩa/Plate', 'Đĩa', 'Plate', 'LTU', null, null),
  (am_norm('Điện thoại/Phone'), 'Điện thoại/Phone', 'Điện thoại', 'Phone', 'LTU', null, null),
  (am_norm('Điện trở/Resistor'), 'Điện trở/Resistor', 'Điện trở', 'Resistor', 'LTU', null, null),
  (am_norm('Điều hòa không khí/Air conditioner'), 'Điều hòa không khí/Air conditioner', 'Điều hòa không khí', 'Air conditioner', 'LTU', null, null),
  (am_norm('Điều khiển từ xa/Remote'), 'Điều khiển từ xa/Remote', 'Điều khiển từ xa', 'Remote', 'LTU', null, null),
  (am_norm('Đồ trang trí/Decorative object'), 'Đồ trang trí/Decorative object', 'Đồ trang trí', 'Decorative object', 'LTU', null, null),
  (am_norm('Động cơ/Motor'), 'Động cơ/Motor', 'Động cơ', 'Motor', 'LTG', null, null),
  (am_norm('Đồng hồ đo/Meter'), 'Đồng hồ đo/Meter', 'Đồng hồ đo', 'Meter', 'LTG', null, null),
  (am_norm('Đồng phục/Uniform'), 'Đồng phục/Uniform', 'Đồng phục', 'Uniform', 'LTG', null, null),
  (am_norm('Dự án thi công thiết kế mặt bằng/Fitout'), 'Dự án thi công thiết kế mặt bằng/Fitout', 'Dự án thi công thiết kế mặt bằng', 'Fitout', 'STR', null, null),
  (am_norm('Dụng cụ ăn uống/Dining utensils'), 'Dụng cụ ăn uống/Dining utensils', 'Dụng cụ ăn uống', 'Dining utensils', 'LTU', null, null),
  (am_norm('Dụng cụ căng cơ/Stretching equipment'), 'Dụng cụ căng cơ/Stretching equipment', 'Dụng cụ căng cơ', 'Stretching equipment', 'LTG', null, null),
  (am_norm('Dụng cụ thể dục/Exercise kit'), 'Dụng cụ thể dục/Exercise kit', 'Dụng cụ thể dục', 'Exercise kit', 'LTG', null, null),
  (am_norm('Đường ống/Pipe'), 'Đường ống/Pipe', 'Đường ống', 'Pipe', 'LTU', null, null),
  (am_norm('FCU/Fan Coil Unit'), 'FCU/Fan Coil Unit', 'FCU', 'Fan Coil Unit', 'MES', null, null),
  (am_norm('Flycam/Flycam'), 'Flycam/Flycam', 'Flycam', 'Flycam', 'ITO', null, null),
  (am_norm('Ga trải giường/Bed sheet'), 'Ga trải giường/Bed sheet', 'Ga trải giường', 'Bed sheet', 'LTU', null, null),
  (am_norm('Gạt tàn/Ashtray'), 'Gạt tàn/Ashtray', 'Gạt tàn', 'Ashtray', 'LTU', null, null),
  (am_norm('Ghế/Chair'), 'Ghế/Chair', 'Ghế', 'Chair', 'LTU', null, null),
  (am_norm('Giá/Shelf'), 'Giá/Shelf', 'Giá', 'Shelf', 'LTU', null, null),
  (am_norm('Giải pháp nền tảng đám mây/Cloud platform solution'), 'Giải pháp nền tảng đám mây/Cloud platform solution', 'Giải pháp nền tảng đám mây', 'Cloud platform solution', 'OIA', null, null),
  (am_norm('Giao diện/ giao thức/Interface'), 'Giao diện/ giao thức/Interface', 'Giao diện', 'giao thức/Interface', 'CTP', null, null),
  (am_norm('Giấy dán tường/Wallpaper'), 'Giấy dán tường/Wallpaper', 'Giấy dán tường', 'Wallpaper', 'LTG', null, null),
  (am_norm('Giường/Bed'), 'Giường/Bed', 'Giường', 'Bed', 'FUR', null, null),
  (am_norm('Gờ giảm tốc/Speed bump'), 'Gờ giảm tốc/Speed bump', 'Gờ giảm tốc', 'Speed bump', 'LTU', null, null),
  (am_norm('Gối/Pillow'), 'Gối/Pillow', 'Gối', 'Pillow', 'LTU', null, null),
  (am_norm('Gối tựa/Cushion'), 'Gối tựa/Cushion', 'Gối tựa', 'Cushion', 'FUR', null, null),
  (am_norm('Gương/Mirror'), 'Gương/Mirror', 'Gương', 'Mirror', 'LTU', null, null),
  (am_norm('Hệ điều hành/Operating system'), 'Hệ điều hành/Operating system', 'Hệ điều hành', 'Operating system', 'CTP', null, null),
  (am_norm('Hệ thống âm thanh/Sound system'), 'Hệ thống âm thanh/Sound system', 'Hệ thống âm thanh', 'Sound system', 'LTU', null, null),
  (am_norm('Hệ thống âm thanh nổi/Stereo system'), 'Hệ thống âm thanh nổi/Stereo system', 'Hệ thống âm thanh nổi', 'Stereo system', 'LTU', null, null),
  (am_norm('Hệ thống báo cháy/Fire alarm system'), 'Hệ thống báo cháy/Fire alarm system', 'Hệ thống báo cháy', 'Fire alarm system', 'MES', null, null),
  (am_norm('Hệ thống biến áp tự động/Automatic voltage regulator system'), 'Hệ thống biến áp tự động/Automatic voltage regulator system', 'Hệ thống biến áp tự động', 'Automatic voltage regulator system', 'MES', null, null),
  (am_norm('Hệ thống bơm nhiệt/Heatpump system'), 'Hệ thống bơm nhiệt/Heatpump system', 'Hệ thống bơm nhiệt', 'Heatpump system', 'MES', null, null),
  (am_norm('Hệ thống CCTV/CCTV system'), 'Hệ thống CCTV/CCTV system', 'Hệ thống CCTV', 'CCTV system', 'MES', null, null),
  (am_norm('Hệ thống dập lửa/Fire suppression system'), 'Hệ thống dập lửa/Fire suppression system', 'Hệ thống dập lửa', 'Fire suppression system', 'FFP', null, null),
  (am_norm('Hệ thống điện và cơ khí/M&E system'), 'Hệ thống điện và cơ khí/M&E system', 'Hệ thống điện và cơ khí', 'M&E system', 'MES', null, null),
  (am_norm('Hệ thống điều hòa không khí/Air conditioning system'), 'Hệ thống điều hòa không khí/Air conditioning system', 'Hệ thống điều hòa không khí', 'Air conditioning system', 'LTU', null, null),
  (am_norm('Hệ thống điều khiển âm thanh/Sound control system'), 'Hệ thống điều khiển âm thanh/Sound control system', 'Hệ thống điều khiển âm thanh', 'Sound control system', 'MES', null, null),
  (am_norm('Hệ thống điều khiển song song/Parallel control system'), 'Hệ thống điều khiển song song/Parallel control system', 'Hệ thống điều khiển song song', 'Parallel control system', 'MES', null, null),
  (am_norm('Hệ thống đồng bộ hóa máy phát điện/Generator synchronization system'), 'Hệ thống đồng bộ hóa máy phát điện/Generator synchronization system', 'Hệ thống đồng bộ hóa máy phát điện', 'Generator synchronization system', 'MES', null, null),
  (am_norm('Hệ thống hóa đơn điện tử/Electronic invoicing system'), 'Hệ thống hóa đơn điện tử/Electronic invoicing system', 'Hệ thống hóa đơn điện tử', 'Electronic invoicing system', 'ITO', null, null),
  (am_norm('Hệ thống hút khói hành lang/Corridor smoke extraction system'), 'Hệ thống hút khói hành lang/Corridor smoke extraction system', 'Hệ thống hút khói hành lang', 'Corridor smoke extraction system', 'OIA', null, null),
  (am_norm('Hệ thống IPTV/IPTV System'), 'Hệ thống IPTV/IPTV System', 'Hệ thống IPTV', 'IPTV System', 'MES', null, null),
  (am_norm('Hệ thống khóa/Locking system'), 'Hệ thống khóa/Locking system', 'Hệ thống khóa', 'Locking system', 'LTU', null, null),
  (am_norm('Hệ thống khởi động áp suất/Pressure startup system'), 'Hệ thống khởi động áp suất/Pressure startup system', 'Hệ thống khởi động áp suất', 'Pressure startup system', 'MES', null, null),
  (am_norm('Hệ thống kiểm soát định lượng Clo/Chlorine dosing control system'), 'Hệ thống kiểm soát định lượng Clo/Chlorine dosing control system', 'Hệ thống kiểm soát định lượng Clo', 'Chlorine dosing control system', 'MES', null, null),
  (am_norm('Chân rẽ/Take off'), 'Chân rẽ/Take off', 'Chân rẽ', 'Take off', 'LTG', null, null),
  (am_norm('Hệ thống kiể̉m soát ra vào/Access management system'), 'Hệ thống kiể̉m soát ra vào/Access management system', 'Hệ thống kiể̉m soát ra vào', 'Access management system', 'MES', null, null),
  (am_norm('Hệ thống làm lạnh/Chiller system'), 'Hệ thống làm lạnh/Chiller system', 'Hệ thống làm lạnh', 'Chiller system', 'INF', null, null),
  (am_norm('Hệ thống làm mềm nước cứng/Water softening system'), 'Hệ thống làm mềm nước cứng/Water softening system', 'Hệ thống làm mềm nước cứng', 'Water softening system', 'MES', null, null),
  (am_norm('Hệ thống làm sạch/Cleaning system'), 'Hệ thống làm sạch/Cleaning system', 'Hệ thống làm sạch', 'Cleaning system', 'FUR', null, null),
  (am_norm('Hệ thống lập trình điều khiển thông minh/Smart control system'), 'Hệ thống lập trình điều khiển thông minh/Smart control system', 'Hệ thống lập trình điều khiển thông minh', 'Smart control system', 'LTU', null, null),
  (am_norm('Hệ thống lọc không khí/Air filtration system'), 'Hệ thống lọc không khí/Air filtration system', 'Hệ thống lọc không khí', 'Air filtration system', 'LTU', null, null),
  (am_norm('Miệng gió/Air Grill'), 'Miệng gió/Air Grill', 'Miệng gió', 'Air Grill', 'LTG', null, null),
  (am_norm('Hệ thống LPG/LPG system'), 'Hệ thống LPG/LPG system', 'Hệ thống LPG', 'LPG system', 'INF', null, null),
  (am_norm('Hệ thống mạng/Network system'), 'Hệ thống mạng/Network system', 'Hệ thống mạng', 'Network system', 'ITO', null, null),
  (am_norm('Hệ thống mạng nội bộ/Intranet system'), 'Hệ thống mạng nội bộ/Intranet system', 'Hệ thống mạng nội bộ', 'Intranet system', 'MES', null, null),
  (am_norm('Hệ thống máy chủ/Server system'), 'Hệ thống máy chủ/Server system', 'Hệ thống máy chủ', 'Server system', 'MES', null, null),
  (am_norm('Hệ thống mô-đun/Modular system'), 'Hệ thống mô-đun/Modular system', 'Hệ thống mô-đun', 'Modular system', 'KME', null, null),
  (am_norm('Hệ thống năng lượng mặt trời/Solar energy systems'), 'Hệ thống năng lượng mặt trời/Solar energy systems', 'Hệ thống năng lượng mặt trời', 'Solar energy systems', 'MES', null, null),
  (am_norm('Hệ thống ống nước/Plumbing system'), 'Hệ thống ống nước/Plumbing system', 'Hệ thống ống nước', 'Plumbing system', 'MES', null, null),
  (am_norm('Hệ̣ thống PCCC/Fire protection system'), 'Hệ̣ thống PCCC/Fire protection system', 'Hệ̣ thống PCCC', 'Fire protection system', 'LTU', null, null),
  (am_norm('Hệ thống phòng họp thông minh/Smart meeting room system'), 'Hệ thống phòng họp thông minh/Smart meeting room system', 'Hệ thống phòng họp thông minh', 'Smart meeting room system', 'MES', null, null),
  (am_norm('Hệ thống thang máy/Elevator'), 'Hệ thống thang máy/Elevator', 'Hệ thống thang máy', 'Elevator', 'INF', null, null),
  (am_norm('Hệ thống thoát nước/Drainage'), 'Hệ thống thoát nước/Drainage', 'Hệ thống thoát nước', 'Drainage', 'STR', null, null),
  (am_norm('Hệ thống tổng đài PABX/PABX System'), 'Hệ thống tổng đài PABX/PABX System', 'Hệ thống tổng đài PABX', 'PABX System', 'MES', null, null),
  (am_norm('Hệ thống trunking/Trunking system'), 'Hệ thống trunking/Trunking system', 'Hệ thống trunking', 'Trunking system', 'MES', null, null),
  (am_norm('Hệ thống viễn thông tòa nhà/Building telecommunications system'), 'Hệ thống viễn thông tòa nhà/Building telecommunications system', 'Hệ thống viễn thông tòa nhà', 'Building telecommunications system', 'MES', null, null),
  (am_norm('Hệ thống wifi/WiFi system'), 'Hệ thống wifi/WiFi system', 'Hệ thống wifi', 'WiFi system', 'ITO', null, null),
  (am_norm('Hệ thống xử lý nước thải/Sewage treatment system'), 'Hệ thống xử lý nước thải/Sewage treatment system', 'Hệ thống xử lý nước thải', 'Sewage treatment system', 'LTU', null, null),
  (am_norm('Hệ thống xử lý nước thải rắn/Solid waste water treatment system'), 'Hệ thống xử lý nước thải rắn/Solid waste water treatment system', 'Hệ thống xử lý nước thải rắn', 'Solid waste water treatment system', 'INF', null, null),
  (am_norm('Hệ thống xử lý nước thải sinh hoạt/Domestic wastewater treatment system'), 'Hệ thống xử lý nước thải sinh hoạt/Domestic wastewater treatment system', 'Hệ thống xử lý nước thải sinh hoạt', 'Domestic wastewater treatment system', 'INF', null, null),
  (am_norm('Hồ/Pool'), 'Hồ/Pool', 'Hồ', 'Pool', 'STR', null, null),
  (am_norm('Hồ bơi/Swimming pool'), 'Hồ bơi/Swimming pool', 'Hồ bơi', 'Swimming pool', 'STR', null, null),
  (am_norm('Hồ cảnh quan/Landscape lake'), 'Hồ cảnh quan/Landscape lake', 'Hồ cảnh quan', 'Landscape lake', 'STR', null, null),
  (am_norm('Hộp/Box'), 'Hộp/Box', 'Hộp', 'Box', 'LTG', null, null),
  (am_norm('Hộp chuyển quang/Optical transfer box'), 'Hộp chuyển quang/Optical transfer box', 'Hộp chuyển quang', 'Optical transfer box', 'LTU', null, null),
  (am_norm('Hộp phối quang/Optical distribution box'), 'Hộp phối quang/Optical distribution box', 'Hộp phối quang', 'Optical distribution box', 'LTU', null, null),
  (am_norm('Hộp rèm/Curtain box'), 'Hộp rèm/Curtain box', 'Hộp rèm', 'Curtain box', 'LTU', null, null),
  (am_norm('Kệ/Shelf'), 'Kệ/Shelf', 'Kệ', 'Shelf', 'LTG', null, null),
  (am_norm('Két đựng tiền/Cash drawer'), 'Két đựng tiền/Cash drawer', 'Két đựng tiền', 'Cash drawer', 'LTU', null, null),
  (am_norm('Két sắt/Safe'), 'Két sắt/Safe', 'Két sắt', 'Safe', 'LTU', null, null),
  (am_norm('Khay/Tray'), 'Khay/Tray', 'Khay', 'Tray', 'LTU', null, null),
  (am_norm('Kho/Warehouse'), 'Kho/Warehouse', 'Kho', 'Warehouse', 'LTU', null, null),
  (am_norm('Kho đông/Walk in freezer'), 'Kho đông/Walk in freezer', 'Kho đông', 'Walk in freezer', 'LTU', null, null),
  (am_norm('Kho mát/Walk in chiller'), 'Kho mát/Walk in chiller', 'Kho mát', 'Walk in chiller', 'LTU', null, null),
  (am_norm('Kho rác/Waste storage'), 'Kho rác/Waste storage', 'Kho rác', 'Waste storage', 'KME', null, null),
  (am_norm('Khóa/Lock'), 'Khóa/Lock', 'Khóa', 'Lock', 'LTU', null, null),
  (am_norm('Khởi động từ/Contactor'), 'Khởi động từ/Contactor', 'Khởi động từ', 'Contactor', 'LTG', null, null),
  (am_norm('Khung/Frame'), 'Khung/Frame', 'Khung', 'Frame', 'LTU', null, null),
  (am_norm('Kính/Glass'), 'Kính/Glass', 'Kính', 'Glass', 'LTG', null, null),
  (am_norm('Kính mắt/Glasses'), 'Kính mắt/Glasses', 'Kính mắt', 'Glasses', 'LTU', null, null),
  (am_norm('Lò/Oven'), 'Lò/Oven', 'Lò', 'Oven', 'LTU', null, null),
  (am_norm('Lò hơi/Boiler'), 'Lò hơi/Boiler', 'Lò hơi', 'Boiler', 'MES', null, null),
  (am_norm('Lò salamander/Salamander broiler'), 'Lò salamander/Salamander broiler', 'Lò salamander', 'Salamander broiler', 'LTU', null, null),
  (am_norm('Lò vi sóng/Microwave oven'), 'Lò vi sóng/Microwave oven', 'Lò vi sóng', 'Microwave oven', 'KME', null, null),
  (am_norm('Loa/Speaker'), 'Loa/Speaker', 'Loa', 'Speaker', 'LTU', null, null),
  (am_norm('Lớp lót/Underlay'), 'Lớp lót/Underlay', 'Lớp lót', 'Underlay', 'LTU', null, null),
  (am_norm('Lưới chắn/Scrupper drain'), 'Lưới chắn/Scrupper drain', 'Lưới chắn', 'Scrupper drain', 'LTU', null, null),
  (am_norm('Mạch điện tử/Electronic circuit'), 'Mạch điện tử/Electronic circuit', 'Mạch điện tử', 'Electronic circuit', 'LTU', null, null),
  (am_norm('Màn hình/Screen'), 'Màn hình/Screen', 'Màn hình', 'Screen', 'LTU', null, null),
  (am_norm('Mặt nạ/Mask'), 'Mặt nạ/Mask', 'Mặt nạ', 'Mask', 'FUR', null, null),
  (am_norm('Máy ATM/ATM machine'), 'Máy ATM/ATM machine', 'Máy ATM', 'ATM machine', 'FUR', null, null),
  (am_norm('Máy bào gỗ/Wood planer'), 'Máy bào gỗ/Wood planer', 'Máy bào gỗ', 'Wood planer', 'LTU', null, null),
  (am_norm('Máy bơm/Pump'), 'Máy bơm/Pump', 'Máy bơm', 'Pump', 'LTG', null, null),
  (am_norm('Máy cà phê/Coffee machine'), 'Máy cà phê/Coffee machine', 'Máy cà phê', 'Coffee machine', 'KME', null, null),
  (am_norm('Máy cán bột/Dough sheeter'), 'Máy cán bột/Dough sheeter', 'Máy cán bột', 'Dough sheeter', 'KME', null, null),
  (am_norm('Máy cắt/Cutter'), 'Máy cắt/Cutter', 'Máy cắt', 'Cutter', 'KME', null, null),
  (am_norm('Máy cắt giấy/Paper cutter'), 'Máy cắt giấy/Paper cutter', 'Máy cắt giấy', 'Paper cutter', 'LTU', null, null),
  (am_norm('Máy chà nhám/Sander'), 'Máy chà nhám/Sander', 'Máy chà nhám', 'Sander', 'LTU', null, null),
  (am_norm('Máy chà sàn/Floor scrubber'), 'Máy chà sàn/Floor scrubber', 'Máy chà sàn', 'Floor scrubber', 'LTU', null, null),
  (am_norm('Máy chấm công/Time attendance system'), 'Máy chấm công/Time attendance system', 'Máy chấm công', 'Time attendance system', 'LTU', null, null),
  (am_norm('Máy chia/Dispenser/Divider'), 'Máy chia/Dispenser/Divider', 'Máy chia', 'Dispenser/Divider', 'LTU', null, null),
  (am_norm('Máy chiếu/Projector'), 'Máy chiếu/Projector', 'Máy chiếu', 'Projector', 'LTU', null, null),
  (am_norm('Máy chủ/Server'), 'Máy chủ/Server', 'Máy chủ', 'Server', 'ITO', null, null),
  (am_norm('Máy chụp hình/Camera'), 'Máy chụp hình/Camera', 'Máy chụp hình', 'Camera', 'LTU', null, null),
  (am_norm('Máy cưa/Saw'), 'Máy cưa/Saw', 'Máy cưa', 'Saw', 'KME', null, null),
  (am_norm('Máy đa năng/Multi-purpose machine'), 'Máy đa năng/Multi-purpose machine', 'Máy đa năng', 'Multi-purpose machine', 'KME', null, null),
  (am_norm('Máy đánh bóng/Polishing machine'), 'Máy đánh bóng/Polishing machine', 'Máy đánh bóng', 'Polishing machine', 'FUR', null, null),
  (am_norm('Máy đánh chữ/Typewriter'), 'Máy đánh chữ/Typewriter', 'Máy đánh chữ', 'Typewriter', 'LTU', null, null),
  (am_norm('Máy đánh dấu/Marking machine'), 'Máy đánh dấu/Marking machine', 'Máy đánh dấu', 'Marking machine', 'FUR', null, null),
  (am_norm('Máy đếm tiền/Cash register'), 'Máy đếm tiền/Cash register', 'Máy đếm tiền', 'Cash register', 'LTU', null, null),
  (am_norm('Máy định hình/Former'), 'Máy định hình/Former', 'Máy định hình', 'Former', 'LTU', null, null),
  (am_norm('Máy đo huyết áp/Sphygmomanometer'), 'Máy đo huyết áp/Sphygmomanometer', 'Máy đo huyết áp', 'Sphygmomanometer', 'LTU', null, null),
  (am_norm('Máy dò kim loại/Metal detector'), 'Máy dò kim loại/Metal detector', 'Máy dò kim loại', 'Metal detector', 'LTU', null, null),
  (am_norm('Máy đọc mã vạch/Barcode readers'), 'Máy đọc mã vạch/Barcode readers', 'Máy đọc mã vạch', 'Barcode readers', 'LTU', null, null),
  (am_norm('Máy ép/Compressor'), 'Máy ép/Compressor', 'Máy ép', 'Compressor', 'LTU', null, null),
  (am_norm('Máy fax/Fax machine'), 'Máy fax/Fax machine', 'Máy fax', 'Fax machine', 'LTU', null, null),
  (am_norm('Máy ghi/Recorder'), 'Máy ghi/Recorder', 'Máy ghi', 'Recorder', 'LTU', null, null),
  (am_norm('Máy giặt/Washing machine'), 'Máy giặt/Washing machine', 'Máy giặt', 'Washing machine', 'SME', null, null),
  (am_norm('Máy giặt liên hợp/Extraction cleaner'), 'Máy giặt liên hợp/Extraction cleaner', 'Máy giặt liên hợp', 'Extraction cleaner', 'SME', null, null),
  (am_norm('Máy giữ ấm/Warmer'), 'Máy giữ ấm/Warmer', 'Máy giữ ấm', 'Warmer', 'KME', null, null),
  (am_norm('Máy hấp/Autoclave'), 'Máy hấp/Autoclave', 'Máy hấp', 'Autoclave', 'KME', null, null),
  (am_norm('Máy hút bụi/Vacuum cleaner'), 'Máy hút bụi/Vacuum cleaner', 'Máy hút bụi', 'Vacuum cleaner', 'LTU', null, null),
  (am_norm('Máy hút chân không/Vacuum sealer'), 'Máy hút chân không/Vacuum sealer', 'Máy hút chân không', 'Vacuum sealer', 'LTU', null, null),
  (am_norm('Máy hút mùi/Exhaust hood'), 'Máy hút mùi/Exhaust hood', 'Máy hút mùi', 'Exhaust hood', 'LTU', null, null),
  (am_norm('Máy huỷ giấy/Shredder'), 'Máy huỷ giấy/Shredder', 'Máy huỷ giấy', 'Shredder', 'LTU', null, null),
  (am_norm('Máy in/Printer'), 'Máy in/Printer', 'Máy in', 'Printer', 'LTU', null, null),
  (am_norm('Máy khoan/Drill'), 'Máy khoan/Drill', 'Máy khoan', 'Drill', 'LTU', null, null),
  (am_norm('Máy làm bánh crepe/Crepe maker'), 'Máy làm bánh crepe/Crepe maker', 'Máy làm bánh crepe', 'Crepe maker', 'LTU', null, null),
  (am_norm('Máy làm bánh waffle/Waffle maker'), 'Máy làm bánh waffle/Waffle maker', 'Máy làm bánh waffle', 'Waffle maker', 'KME', null, null),
  (am_norm('Máy làm đá/Ice maker'), 'Máy làm đá/Ice maker', 'Máy làm đá', 'Ice maker', 'KME', null, null),
  (am_norm('Máy làm kem/Ice cream machine'), 'Máy làm kem/Ice cream machine', 'Máy làm kem', 'Ice cream machine', 'KME', null, null),
  (am_norm('Máy làm lạnh nước trái cây/Juice cooler'), 'Máy làm lạnh nước trái cây/Juice cooler', 'Máy làm lạnh nước trái cây', 'Juice cooler', 'LTU', null, null),
  (am_norm('Máy làm sạch áp lực cao/High-pressure cleaner'), 'Máy làm sạch áp lực cao/High-pressure cleaner', 'Máy làm sạch áp lực cao', 'High-pressure cleaner', 'FUR', null, null),
  (am_norm('Máy lọc không khí/Air purifier'), 'Máy lọc không khí/Air purifier', 'Máy lọc không khí', 'Air purifier', 'SME', null, null),
  (am_norm('Máy mài/Grinder'), 'Máy mài/Grinder', 'Máy mài', 'Grinder', 'LTU', null, null),
  (am_norm('Máy nén/Compressor'), 'Máy nén/Compressor', 'Máy nén', 'Compressor', 'MES', null, null),
  (am_norm('Máy nghiền/Crusher'), 'Máy nghiền/Crusher', 'Máy nghiền', 'Crusher', 'KME', null, null),
  (am_norm('Máy nhào/Kneader'), 'Máy nhào/Kneader', 'Máy nhào', 'Kneader', 'KME', null, null),
  (am_norm('Máy nướng/Grilling machine'), 'Máy nướng/Grilling machine', 'Máy nướng', 'Grilling machine', 'KME', null, null),
  (am_norm('Máy ozone/Ozone machine'), 'Máy ozone/Ozone machine', 'Máy ozone', 'Ozone machine', 'FUR', null, null),
  (am_norm('Máy phân loại/Sorting machine'), 'Máy phân loại/Sorting machine', 'Máy phân loại', 'Sorting machine', 'LTU', null, null),
  (am_norm('Máy phát/Generator'), 'Máy phát/Generator', 'Máy phát', 'Generator', 'LTU', null, null),
  (am_norm('Máy phát hiện tiền giả/Money detector'), 'Máy phát hiện tiền giả/Money detector', 'Máy phát hiện tiền giả', 'Money detector', 'LTU', null, null),
  (am_norm('Máy photocopy/Photocopier'), 'Máy photocopy/Photocopier', 'Máy photocopy', 'Photocopier', 'LTU', null, null),
  (am_norm('Máy phun/Sprayer'), 'Máy phun/Sprayer', 'Máy phun', 'Sprayer', 'LTU', null, null),
  (am_norm('Máy phun hút/Vacuum extractor'), 'Máy phun hút/Vacuum extractor', 'Máy phun hút', 'Vacuum extractor', 'SME', null, null),
  (am_norm('Máy POS/ Máy tính tiền/POS / Cash register'), 'Máy POS/ Máy tính tiền/POS / Cash register', 'Máy POS', 'Máy tính tiền/POS / Cash register', 'LTU', null, null),
  (am_norm('Máy quay phim/Camera'), 'Máy quay phim/Camera', 'Máy quay phim', 'Camera', 'LTU', null, null),
  (am_norm('Máy quét/Scanner'), 'Máy quét/Scanner', 'Máy quét', 'Scanner', 'LTU', null, null),
  (am_norm('Máy rửa chén/Dishwasher'), 'Máy rửa chén/Dishwasher', 'Máy rửa chén', 'Dishwasher', 'FUR', null, null),
  (am_norm('Máy rửa ly/Glass washer'), 'Máy rửa ly/Glass washer', 'Máy rửa ly', 'Glass washer', 'LTU', null, null),
  (am_norm('Máy sấy/Dryer'), 'Máy sấy/Dryer', 'Máy sấy', 'Dryer', 'LTU', null, null),
  (am_norm('Máy sục khí/Aerator'), 'Máy sục khí/Aerator', 'Máy sục khí', 'Aerator', 'LTU', null, null),
  (am_norm('Máy tẩy điểm/Spotting cleaner'), 'Máy tẩy điểm/Spotting cleaner', 'Máy tẩy điểm', 'Spotting cleaner', 'LTU', null, null),
  (am_norm('Máy thổi khí/Air blower'), 'Máy thổi khí/Air blower', 'Máy thổi khí', 'Air blower', 'KME', null, null),
  (am_norm('Máy tính/Computer'), 'Máy tính/Computer', 'Máy tính', 'Computer', 'LTU', null, null),
  (am_norm('Máy trộn/Mixer'), 'Máy trộn/Mixer', 'Máy trộn', 'Mixer', 'LTU', null, null),
  (am_norm('Máy xay/Blender'), 'Máy xay/Blender', 'Máy xay', 'Blender', 'LTU', null, null),
  (am_norm('Micrô/Microphone'), 'Micrô/Microphone', 'Micrô', 'Microphone', 'LTU', null, null),
  (am_norm('Miếng dán/Film'), 'Miếng dán/Film', 'Miếng dán', 'Film', 'LTU', null, null),
  (am_norm('Miệng gió cấp/Supply air grille'), 'Miệng gió cấp/Supply air grille', 'Miệng gió cấp', 'Supply air grille', 'LTU', null, null),
  (am_norm('Miệng gió hồi/Return air grille'), 'Miệng gió hồi/Return air grille', 'Miệng gió hồi', 'Return air grille', 'LTU', null, null),
  (am_norm('Minibar/Minibar'), 'Minibar/Minibar', 'Minibar', 'Minibar', 'LTU', null, null),
  (am_norm('Modem/Modem'), 'Modem/Modem', 'Modem', 'Modem', 'LTU', null, null),
  (am_norm('Mũi khoan/Drill bit'), 'Mũi khoan/Drill bit', 'Mũi khoan', 'Drill bit', 'LTU', null, null),
  (am_norm('Nắp/Cover'), 'Nắp/Cover', 'Nắp', 'Cover', 'STR', null, null),
  (am_norm('Nệm/Mattress'), 'Nệm/Mattress', 'Nệm', 'Mattress', 'LTG', null, null),
  (am_norm('Nguồn điện/Power supply'), 'Nguồn điện/Power supply', 'Nguồn điện', 'Power supply', 'LTU', null, null),
  (am_norm('Nguồn máy tính/Computer power'), 'Nguồn máy tính/Computer power', 'Nguồn máy tính', 'Computer power', 'LTU', null, null),
  (am_norm('Nhà để xe/Garage'), 'Nhà để xe/Garage', 'Nhà để xe', 'Garage', 'STR', null, null),
  (am_norm('Nhà thay quần áo/Locker/ Changing room'), 'Nhà thay quần áo/Locker/ Changing room', 'Nhà thay quần áo', 'Locker/ Changing room', 'STR', null, null),
  (am_norm('Nhãn hiệu/Trademarks'), 'Nhãn hiệu/Trademarks', 'Nhãn hiệu', 'Trademarks', 'LTU', null, null),
  (am_norm('Nồi/Pot'), 'Nồi/Pot', 'Nồi', 'Pot', 'LTU', null, null),
  (am_norm('Nồi chiên/Fryer'), 'Nồi chiên/Fryer', 'Nồi chiên', 'Fryer', 'KME', null, null),
  (am_norm('Nồi cơm điện/Rice cooker'), 'Nồi cơm điện/Rice cooker', 'Nồi cơm điện', 'Rice cooker', 'KME', null, null),
  (am_norm('Nồi giữ lạnh/Cold well'), 'Nồi giữ lạnh/Cold well', 'Nồi giữ lạnh', 'Cold well', 'LTU', null, null),
  (am_norm('Nồi hâm nóng/Soup insert'), 'Nồi hâm nóng/Soup insert', 'Nồi hâm nóng', 'Soup insert', 'KME', null, null),
  (am_norm('Nồi hấp/Steamer'), 'Nồi hấp/Steamer', 'Nồi hấp', 'Steamer', 'LTU', null, null),
  (am_norm('Nồi luộc/Cooker'), 'Nồi luộc/Cooker', 'Nồi luộc', 'Cooker', 'KME', null, null),
  (am_norm('Nồi tiệt trùng/Sterilizer'), 'Nồi tiệt trùng/Sterilizer', 'Nồi tiệt trùng', 'Sterilizer', 'KME', null, null),
  (am_norm('Ô/Umbrella'), 'Ô/Umbrella', 'Ô', 'Umbrella', 'LTU', null, null),
  (am_norm('Ổ cắm điện/Electrical outlet'), 'Ổ cắm điện/Electrical outlet', 'Ổ cắm điện', 'Electrical outlet', 'LTU', null, null),
  (am_norm('Ổ đài quang/Optical drive'), 'Ổ đài quang/Optical drive', 'Ổ đài quang', 'Optical drive', 'LTU', null, null),
  (am_norm('Ổ đĩa/Drive'), 'Ổ đĩa/Drive', 'Ổ đĩa', 'Drive', 'LTU', null, null),
  (am_norm('Ổn áp/Voltage stabilizer'), 'Ổn áp/Voltage stabilizer', 'Ổn áp', 'Voltage stabilizer', 'LTU', null, null),
  (am_norm('Ống/Tube'), 'Ống/Tube', 'Ống', 'Tube', 'LTU', null, null),
  (am_norm('Ống gió/Duct'), 'Ống gió/Duct', 'Ống gió', 'Duct', 'LTG', null, null),
  (am_norm('Ống luồn/Conduit'), 'Ống luồn/Conduit', 'Ống luồn', 'Conduit', 'LTU', null, null),
  (am_norm('PAU/Primary Air Unit'), 'PAU/Primary Air Unit', 'PAU', 'Primary Air Unit', 'LTU', null, null),
  (am_norm('Phần mềm/Software'), 'Phần mềm/Software', 'Phần mềm', 'Software', 'LTG', null, null),
  (am_norm('Phòng khách/Guestroom'), 'Phòng khách/Guestroom', 'Phòng khách', 'Guestroom', 'STR', null, null),
  (am_norm('Phòng xông hơi/Sauna'), 'Phòng xông hơi/Sauna', 'Phòng xông hơi', 'Sauna', 'STR', null, null),
  (am_norm('Pin/Battery'), 'Pin/Battery', 'Pin', 'Battery', 'LTG', null, null),
  (am_norm('Quạt/Fan'), 'Quạt/Fan', 'Quạt', 'Fan', 'LTU', null, null),
  (am_norm('Quạt cấp gió/Air supply fan'), 'Quạt cấp gió/Air supply fan', 'Quạt cấp gió', 'Air supply fan', 'OIA', null, null),
  (am_norm('Quạ̣t hút khói/Smoke extractor fan'), 'Quạ̣t hút khói/Smoke extractor fan', 'Quạ̣t hút khói', 'Smoke extractor fan', 'OIA', null, null),
  (am_norm('Quạt thông gió/Ventilation fan'), 'Quạt thông gió/Ventilation fan', 'Quạt thông gió', 'Ventilation fan', 'LTU', null, null),
  (am_norm('Quầy/Counter'), 'Quầy/Counter', 'Quầy', 'Counter', 'LTU', null, null),
  (am_norm('Quyền/Rights'), 'Quyền/Rights', 'Quyền', 'Rights', 'LUR', null, null),
  (am_norm('Rack/Rack'), 'Rack/Rack', 'Rack', 'Rack', 'LTU', null, null),
  (am_norm('RAM/Random Access Memory'), 'RAM/Random Access Memory', 'RAM', 'Random Access Memory', 'LTU', null, null),
  (am_norm('Ram dốc/Driveway Ramp'), 'Ram dốc/Driveway Ramp', 'Ram dốc', 'Driveway Ramp', 'STR', null, null),
  (am_norm('RCU/Room control unit'), 'RCU/Room control unit', 'RCU', 'Room control unit', 'LTU', null, null),
  (am_norm('Rèm/Curtain'), 'Rèm/Curtain', 'Rèm', 'Curtain', 'LTU', null, null),
  (am_norm('Rổ/Basket'), 'Rổ/Basket', 'Rổ', 'Basket', 'LTU', null, null),
  (am_norm('Rơle/Relay'), 'Rơle/Relay', 'Rơle', 'Relay', 'MES', null, null),
  (am_norm('Ruột chăn/Duvet insert'), 'Ruột chăn/Duvet insert', 'Ruột chăn', 'Duvet insert', 'LTG', null, null),
  (am_norm('Sàn/Floor'), 'Sàn/Floor', 'Sàn', 'Floor', 'LTU', null, null),
  (am_norm('Sân/Yard'), 'Sân/Yard', 'Sân', 'Yard', 'STR', null, null),
  (am_norm('Sân bóng đá/Football pitches'), 'Sân bóng đá/Football pitches', 'Sân bóng đá', 'Football pitches', 'STR', null, null),
  (am_norm('Sân chơi/Playground'), 'Sân chơi/Playground', 'Sân chơi', 'Playground', 'STR', null, null),
  (am_norm('Sân khấu/Stage'), 'Sân khấu/Stage', 'Sân khấu', 'Stage', 'LTU', null, null),
  (am_norm('Sàn nâng kỹ thuật/Raised technical floor'), 'Sàn nâng kỹ thuật/Raised technical floor', 'Sàn nâng kỹ thuật', 'Raised technical floor', 'INF', null, null),
  (am_norm('Sân quần vợt/Tennis course'), 'Sân quần vợt/Tennis course', 'Sân quần vợt', 'Tennis course', 'STR', null, null),
  (am_norm('Sân tennis/Tennis course'), 'Sân tennis/Tennis course', 'Sân tennis', 'Tennis course', 'STR', null, null),
  (am_norm('Sơn/Paint'), 'Sơn/Paint', 'Sơn', 'Paint', 'LTU', null, null),
  (am_norm('Sơn mài/Lacquer'), 'Sơn mài/Lacquer', 'Sơn mài', 'Lacquer', 'LTU', null, null),
  (am_norm('Tai nghe/Earphone'), 'Tai nghe/Earphone', 'Tai nghe', 'Earphone', 'LTU', null, null),
  (am_norm('Tấm đèn led/LED panel'), 'Tấm đèn led/LED panel', 'Tấm đèn led', 'LED panel', 'MES', null, null),
  (am_norm('Tấm lõi lọc tản nhiệt/Heat dissipation core filter'), 'Tấm lõi lọc tản nhiệt/Heat dissipation core filter', 'Tấm lõi lọc tản nhiệt', 'Heat dissipation core filter', 'OIA', null, null),
  (am_norm('Tay cầm/Handle'), 'Tay cầm/Handle', 'Tay cầm', 'Handle', 'LTU', null, null),
  (am_norm('Tay vịn/Handrail'), 'Tay vịn/Handrail', 'Tay vịn', 'Handrail', 'LTG', null, null),
  (am_norm('Tem nhãn/Labels'), 'Tem nhãn/Labels', 'Tem nhãn', 'Labels', 'LTG', null, null),
  (am_norm('Thảm/Carpet'), 'Thảm/Carpet', 'Thảm', 'Carpet', 'LTU', null, null),
  (am_norm('Thang máy/Elevator'), 'Thang máy/Elevator', 'Thang máy', 'Elevator', 'INF', null, null),
  (am_norm('Thang nâng máy chiếu/Projector lift'), 'Thang nâng máy chiếu/Projector lift', 'Thang nâng máy chiếu', 'Projector lift', 'LTU', null, null),
  (am_norm('Thanh chắn/Barrier'), 'Thanh chắn/Barrier', 'Thanh chắn', 'Barrier', 'LTG', null, null),
  (am_norm('Thanh điều hướng/Guide rail'), 'Thanh điều hướng/Guide rail', 'Thanh điều hướng', 'Guide rail', 'LTU', null, null),
  (am_norm('Thanh/Xà/Bar'), 'Thanh/Xà/Bar', 'Thanh', 'Xà/Bar', 'LTU', null, null),
  (am_norm('Tháp/Fountain'), 'Tháp/Fountain', 'Tháp', 'Fountain', 'LTU', null, null),
  (am_norm('Tháp bảo quản rượu/Le Verre De Vin Tower'), 'Tháp bảo quản rượu/Le Verre De Vin Tower', 'Tháp bảo quản rượu', 'Le Verre De Vin Tower', 'LTU', null, null),
  (am_norm('Tháp giải nhiệt/Cooling tower'), 'Tháp giải nhiệt/Cooling tower', 'Tháp giải nhiệt', 'Cooling tower', 'OTA', null, null),
  (am_norm('Thẻ/Card'), 'Thẻ/Card', 'Thẻ', 'Card', 'LTU', null, null),
  (am_norm('Thiết bị an toàn kỹ thuật/Technical safety equipment'), 'Thiết bị an toàn kỹ thuật/Technical safety equipment', 'Thiết bị an toàn kỹ thuật', 'Technical safety equipment', 'LTU', null, null),
  (am_norm('Thiết bị bán dẫn/Semiconductor device'), 'Thiết bị bán dẫn/Semiconductor device', 'Thiết bị bán dẫn', 'Semiconductor device', 'LTU', null, null),
  (am_norm('Thiết bị báo cháy/Fire alarm'), 'Thiết bị báo cháy/Fire alarm', 'Thiết bị báo cháy', 'Fire alarm', 'FFP', null, null),
  (am_norm('Thiết bị bảo vệ chống sét/Lightning protection device'), 'Thiết bị bảo vệ chống sét/Lightning protection device', 'Thiết bị bảo vệ chống sét', 'Lightning protection device', 'MES', null, null),
  (am_norm('Thiết bị chăm sóc sức khoẻ/Health care equipment'), 'Thiết bị chăm sóc sức khoẻ/Health care equipment', 'Thiết bị chăm sóc sức khoẻ', 'Health care equipment', 'LTU', null, null),
  (am_norm('Thiết bị chia sẻ/Sharing device'), 'Thiết bị chia sẻ/Sharing device', 'Thiết bị chia sẻ', 'Sharing device', 'LTG', null, null),
  (am_norm('Thiết bị chữa cháy/Fire-fighting equipment'), 'Thiết bị chữa cháy/Fire-fighting equipment', 'Thiết bị chữa cháy', 'Fire-fighting equipment', 'LTU', null, null),
  (am_norm('Thiế́t bị chuyển mạch/Switch'), 'Thiế́t bị chuyển mạch/Switch', 'Thiế́t bị chuyển mạch', 'Switch', 'LTU', null, null),
  (am_norm('Thiết bị cứu hộ/Rescue equipment'), 'Thiết bị cứu hộ/Rescue equipment', 'Thiết bị cứu hộ', 'Rescue equipment', 'MES', null, null),
  (am_norm('Thiết bị cứu hộ thanh máy tự động/Automatic rescue device (ARD)'), 'Thiết bị cứu hộ thanh máy tự động/Automatic rescue device (ARD)', 'Thiết bị cứu hộ thanh máy tự động', 'Automatic rescue device (ARD)', 'LTU', null, null),
  (am_norm('Thiết bị định giờ/Timer device'), 'Thiết bị định giờ/Timer device', 'Thiết bị định giờ', 'Timer device', 'LTU', null, null),
  (am_norm('Thiết bị đo/Measurement device'), 'Thiết bị đo/Measurement device', 'Thiết bị đo', 'Measurement device', 'LTU', null, null),
  (am_norm('Thiết bị ghi và tái tạo/Recording and reproducing equipment'), 'Thiết bị ghi và tái tạo/Recording and reproducing equipment', 'Thiết bị ghi và tái tạo', 'Recording and reproducing equipment', 'LTU', null, null),
  (am_norm('Thiết bị giải trí/Entertainment unit'), 'Thiết bị giải trí/Entertainment unit', 'Thiết bị giải trí', 'Entertainment unit', 'FUR', null, null),
  (am_norm('Thiết bị hội đàm/Intercom system'), 'Thiết bị hội đàm/Intercom system', 'Thiết bị hội đàm', 'Intercom system', 'LTU', null, null),
  (am_norm('Thiết bị khử khuẩn/Disinfection equipment'), 'Thiết bị khử khuẩn/Disinfection equipment', 'Thiết bị khử khuẩn', 'Disinfection equipment', 'LTU', null, null),
  (am_norm('Thiết bị khuếch đại (Amply)/Amplifier'), 'Thiết bị khuếch đại (Amply)/Amplifier', 'Thiết bị khuếch đại (Amply)', 'Amplifier', 'LTU', null, null),
  (am_norm('Thiết bị lưu trữ/Storage devices'), 'Thiết bị lưu trữ/Storage devices', 'Thiết bị lưu trữ', 'Storage devices', 'LTU', null, null),
  (am_norm('Thiết bị nghe nhìn/Audio-visual equipment'), 'Thiết bị nghe nhìn/Audio-visual equipment', 'Thiết bị nghe nhìn', 'Audio-visual equipment', 'LTU', null, null),
  (am_norm('Thiết bị radar/Radar equipment'), 'Thiết bị radar/Radar equipment', 'Thiết bị radar', 'Radar equipment', 'LTU', null, null),
  (am_norm('Thiết bị spa & massage/Spa & massage equipment'), 'Thiết bị spa & massage/Spa & massage equipment', 'Thiết bị spa & massage', 'Spa & massage equipment', 'LTU', null, null),
  (am_norm('Thiết bị thể dục/Exercise equipment'), 'Thiết bị thể dục/Exercise equipment', 'Thiết bị thể dục', 'Exercise equipment', 'LTU', null, null),
  (am_norm('Thiết bị thu phát sóng vô tuyến điện/Radio transceiver equipment'), 'Thiết bị thu phát sóng vô tuyến điện/Radio transceiver equipment', 'Thiết bị thu phát sóng vô tuyến điện', 'Radio transceiver equipment', 'LTU', null, null),
  (am_norm('Thiết bị truyền dẫn/Transmission device'), 'Thiết bị truyền dẫn/Transmission device', 'Thiết bị truyền dẫn', 'Transmission device', 'LTU', null, null),
  (am_norm('Thớt/Cutting board'), 'Thớt/Cutting board', 'Thớt', 'Cutting board', 'KME', null, null),
  (am_norm('Thùng/Bin'), 'Thùng/Bin', 'Thùng', 'Bin', 'LTG', null, null),
  (am_norm('Thước kẹp/Calipers'), 'Thước kẹp/Calipers', 'Thước kẹp', 'Calipers', 'LTU', null, null),
  (am_norm('Tivi/Television'), 'Tivi/Television', 'Tivi', 'Television', 'LTU', null, null),
  (am_norm('Trạm/Station'), 'Trạm/Station', 'Trạm', 'Station', 'LTU', null, null),
  (am_norm('Tranh vẽ/Painting'), 'Tranh vẽ/Painting', 'Tranh vẽ', 'Painting', 'LTU', null, null),
  (am_norm('Trình hiển thị/Display'), 'Trình hiển thị/Display', 'Trình hiển thị', 'Display', 'KME', null, null),
  (am_norm('Trống/Drum'), 'Trống/Drum', 'Trống', 'Drum', 'LTU', null, null),
  (am_norm('Trụ/Post'), 'Trụ/Post', 'Trụ', 'Post', 'LTG', null, null),
  (am_norm('Trụ kiểm soát/Turnstile'), 'Trụ kiểm soát/Turnstile', 'Trụ kiểm soát', 'Turnstile', 'LTU', null, null),
  (am_norm('Tủ/Cabinet'), 'Tủ/Cabinet', 'Tủ', 'Cabinet', 'LTU', null, null),
  (am_norm('Tủ điện/Electrical cabinet'), 'Tủ điện/Electrical cabinet', 'Tủ điện', 'Electrical cabinet', 'LTU', null, null),
  (am_norm('Tủ điều khiển/Control cabinet'), 'Tủ điều khiển/Control cabinet', 'Tủ điều khiển', 'Control cabinet', 'MES', null, null),
  (am_norm('Tủ hấp/Steamer'), 'Tủ hấp/Steamer', 'Tủ hấp', 'Steamer', 'KME', null, null),
  (am_norm('Tủ lạnh/Refrigerator'), 'Tủ lạnh/Refrigerator', 'Tủ lạnh', 'Refrigerator', 'LTU', null, null),
  (am_norm('Monitor/Màn hình'), 'Monitor/Màn hình', 'Monitor', 'Màn hình', 'LTU', null, null),
  (am_norm('Tủ mạng/Rack mount'), 'Tủ mạng/Rack mount', 'Tủ mạng', 'Rack mount', 'LTU', null, null),
  (am_norm('Tủ mát/Cooler'), 'Tủ mát/Cooler', 'Tủ mát', 'Cooler', 'KME', null, null),
  (am_norm('Tường/Wall'), 'Tường/Wall', 'Tường', 'Wall', 'LTU', null, null),
  (am_norm('Tượng/Statue'), 'Tượng/Statue', 'Tượng', 'Statue', 'LTU', null, null),
  (am_norm('Tường lửa/Firewall'), 'Tường lửa/Firewall', 'Tường lửa', 'Firewall', 'LTU', null, null),
  (am_norm('Tường rào/Fence'), 'Tường rào/Fence', 'Tường rào', 'Fence', 'LTU', null, null),
  (am_norm('Vách ngăn/Partition'), 'Vách ngăn/Partition', 'Vách ngăn', 'Partition', 'LTU', null, null),
  (am_norm('Van/Valve'), 'Van/Valve', 'Van', 'Valve', 'LTU', null, null),
  (am_norm('Van bi/Ball valve'), 'Van bi/Ball valve', 'Van bi', 'Ball valve', 'LTU', null, null),
  (am_norm('Viền/Trim'), 'Viền/Trim', 'Viền', 'Trim', 'LTU', null, null),
  (am_norm('Vỏ/Case'), 'Vỏ/Case', 'Vỏ', 'Case', 'LTG', null, null),
  (am_norm('Vòi/faucet'), 'Vòi/faucet', 'Vòi', 'faucet', 'LTG', null, null),
  (am_norm('Vòng thạch cao/Plaster ring'), 'Vòng thạch cao/Plaster ring', 'Vòng thạch cao', 'Plaster ring', 'LTU', null, null),
  (am_norm('Webcam/Webcam'), 'Webcam/Webcam', 'Webcam', 'Webcam', 'LTU', null, null),
  (am_norm('Xe/Vehicle'), 'Xe/Vehicle', 'Xe', 'Vehicle', 'LTU', null, null),
  (am_norm('Lắc lạnh/Cooler'), 'Lắc lạnh/Cooler', 'Lắc lạnh', 'Cooler', 'LTG', null, null),
  (am_norm('Xe đẩy/Trolley'), 'Xe đẩy/Trolley', 'Xe đẩy', 'Trolley', 'LTG', null, null),
  (am_norm('Xô/Shove'), 'Xô/Shove', 'Xô', 'Shove', 'LTU', null, null)
on conflict (raw_name_norm) do update
  set raw_name = excluded.raw_name, std_name_vi = excluded.std_name_vi,
      std_name_en = excluded.std_name_en, default_category = excluded.default_category,
      default_unit = excluded.default_unit, default_brand = excluded.default_brand;


-- ####################################################################
-- ##  07_data_source.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake — provenance of the master data
--
-- Answers two questions the interface has to be able to answer at any time:
--   "which data is in use right now?"  and  "when was it loaded, from what?"
-- Every import writes one row per table it touched; nothing is ever deleted,
-- so the history stays readable.
-- Run after 04_rls.sql. Safe to re-run.
-- =====================================================================

create table if not exists am_data_source (
  id           bigserial primary key,
  table_name   text not null,
  source_file  text,
  source_kind  text not null default 'manual'
               check (source_kind in ('beetrack-template', 'snapshot', 'sql-seed',
                                      'manual', 'register-scan')),
  rows_loaded  int,
  loaded_at    timestamptz not null default now(),
  loaded_by    text,
  note         text
);
comment on table am_data_source is
  'One row per (table, import). Append-only log of where the master data came from.';

create index if not exists am_data_source_latest_idx
  on am_data_source (table_name, loaded_at desc);

-- Most recent import per table — what the Data sources screen reads.
create or replace view am_data_source_current with (security_invoker = true) as
select distinct on (table_name)
       table_name, source_file, source_kind, rows_loaded, loaded_at, loaded_by, note
from   am_data_source
order  by table_name, loaded_at desc;

alter table am_data_source enable row level security;
-- Policies live in 17_auth.sql with every other table's, so that re-running
-- this file can never put back the old open-to-anyone policies. The log stays
-- append-only: 17 grants select + insert, never update or delete.
grant select, insert on am_data_source to authenticated;
grant select on am_data_source_current to authenticated;
grant usage, select on sequence am_data_source_id_seq to authenticated;

-- Record what the SQL seed files themselves loaded, so a fresh install does
-- not show "never loaded" for data that is plainly there.
insert into am_data_source (table_name, source_file, source_kind, rows_loaded, loaded_by, note)
select v.t, v.f, 'sql-seed', v.n, 'sql/ALL_IN_ONE.sql',
       'Initial load from the generated seed files'
from (values
  ('am_org',            '4. department-template-file.xlsx',       (select count(*)::int from am_org)),
  ('am_category_group', '3. category-template-file.xlsx',         (select count(*)::int from am_category_group)),
  ('am_category',       '3. category-template-file.xlsx',         (select count(*)::int from am_category)),
  ('am_unit',           '10. unit-template-file.xlsx',            (select count(*)::int from am_unit)),
  ('am_origin',         '9. origin-country-template-file.xlsx',   (select count(*)::int from am_origin)),
  ('am_location',       '6. location-template-file.xlsx',         (select count(*)::int from am_location)),
  ('am_product',        '8. product-catalogue-template-file.xlsx',(select count(*)::int from am_product))
) as v(t, f, n)
where not exists (select 1 from am_data_source d where d.table_name = v.t);


-- ####################################################################
-- ##  08_seed_counters.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake -- seed the counters from the Beetrack asset register
-- Source: "Danh sach tai san (up to Sep 15 - Beetrack).xlsx", 17,036 rows.
--
-- Keyed on (department, letters) only. In that register 11 keys appear
-- under SEVERAL parent groups -- HKD|FUR alone spans C2111, C2112, C2113
-- and C2422 -- so keying on the group as well would hand out duplicate
-- asset codes.
--
-- am_seed_asset_seq only ever RAISES a counter, so re-running is harmless.
-- Run after 03_functions.sql. Re-run whenever a newer register export arrives.
-- =====================================================================

select v.dept, v.letters, v.max_seen,
       am_seed_asset_seq(v.dept, v.letters, v.max_seen) as next_seq
from (values
  ('ADM', 'FUR', 507),
  ('ADM', 'ITM', 1),
  ('ADM', 'KME', 2),
  ('ADM', 'LTG', 49),
  ('ADM', 'LTU', 464),
  ('ADM', 'MES', 1),
  ('ADM', 'OIA', 3),
  ('ADM', 'OME', 47),
  ('CEN', 'BUL', 1),
  ('CEN', 'INF', 2),
  ('CEN', 'LTG', 1337),
  ('CEN', 'LTU', 238),
  ('CEN', 'MES', 3),
  ('CEN', 'OIA', 23),
  ('CEN', 'OTA', 91),
  ('CEN', 'STR', 11),
  ('ENG', 'FFP', 383),
  ('ENG', 'FUR', 458),
  ('ENG', 'ITM', 5),
  ('ENG', 'ITO', 679),
  ('ENG', 'KME', 3),
  ('ENG', 'LTG', 849),
  ('ENG', 'LTU', 1277),
  ('ENG', 'MES', 857),
  ('ENG', 'OIA', 21),
  ('ENG', 'OME', 10),
  ('ENG', 'SME', 237),
  ('ENG', 'STR', 13),
  ('FBD', 'FUR', 614),
  ('FBD', 'ITO', 238),
  ('FBD', 'KME', 219),
  ('FBD', 'LTG', 4),
  ('FBD', 'LTU', 481),
  ('FBD', 'MES', 18),
  ('FBD', 'OME', 592),
  ('FIN', 'CTP', 4),
  ('FIN', 'FFP', 2),
  ('FIN', 'FUR', 299),
  ('FIN', 'ITM', 1),
  ('FIN', 'ITO', 505),
  ('FIN', 'LTG', 281),
  ('FIN', 'LTU', 447),
  ('FIN', 'MES', 120),
  ('FIN', 'OIA', 5),
  ('FIN', 'OME', 59),
  ('FIN', 'STR', 1),
  ('FOD', 'FUR', 6024),
  ('FOD', 'ITO', 1),
  ('FOD', 'KME', 41),
  ('FOD', 'LTU', 6010),
  ('FOD', 'MES', 2),
  ('FOD', 'OME', 1005),
  ('HKD', 'FUR', 4210),
  ('HKD', 'ITO', 947),
  ('HKD', 'KME', 78),
  ('HKD', 'LTG', 844),
  ('HKD', 'LTU', 2268),
  ('HKD', 'MES', 320),
  ('HKD', 'OME', 68),
  ('HKD', 'SME', 613),
  ('ITD', 'CTP', 3),
  ('ITD', 'ITO', 30),
  ('ITD', 'LTG', 171),
  ('ITD', 'LTU', 328),
  ('ITD', 'MES', 2),
  ('ITD', 'STG', 8),
  ('JVC', 'CTP', 1),
  ('JVC', 'INF', 19),
  ('JVC', 'ITO', 54),
  ('JVC', 'LTG', 44),
  ('JVC', 'LTU', 102),
  ('JVC', 'OIA', 7),
  ('JVC', 'OME', 4),
  ('JVC', 'OTA', 10),
  ('JVC', 'STR', 3),
  ('KIT', 'FUR', 349),
  ('KIT', 'ITO', 197),
  ('KIT', 'KME', 1551),
  ('KIT', 'LTU', 633),
  ('KIT', 'OME', 3001),
  ('KIT', 'SME', 23),
  ('SMD', 'FUR', 21),
  ('SMD', 'ITO', 1),
  ('SMD', 'OME', 39),
  ('SOF', 'OBA', 77),
  ('SOF', 'OCN', 172),
  ('SOF', 'OES', 109),
  ('SOF', 'OFL', 115),
  ('SOF', 'OGL', 141),
  ('SOF', 'OKU', 127),
  ('SOF', 'OLI', 76),
  ('SOF', 'OPS', 36)
) as v(dept, letters, max_seen)
order by v.dept, v.letters;

select am_seed_barcode('unique', 105076) as next_unique,
       am_seed_barcode('low',    2213)    as next_low;

-- Check: every gap must be >= 0.
select * from am_audit_counters() where gap < 0;


-- ####################################################################
-- ##  10_legacy_assets.sql
-- ####################################################################

-- =====================================================================
-- PHCL Asset Intake — make room for the legacy Beetrack register
--
-- The 17,036 rows already in Beetrack do not all match the rules this app
-- enforces on NEW assets. That is historical fact, not a data error, so the
-- constraints get an explicit exemption instead of being dropped:
--
--   barcode   10 different formats are in use, not just "JVC.":
--             JVC.######### 13,349 · GR##.##### 1,347 · SOF.######### 853 ·
--             SB###.##### 762 · S###.##### 580 · RT##.##### 96 ·
--             SSP.##### 36 · 14 plain digits 3 · SOFlXR6 / SOFmGD3 1 each.
--   asset_code 5 rows carry a SIX digit sequence (CEN.C2422.LTU.2024.000168),
--             one has a note appended, one cell holds only a number.
--   qty       "Cung Barcode" rows hold the whole batch on one line, up to
--             5,581 pieces, so the one-row-per-unit rule cannot apply.
--
-- is_legacy = true means "imported as it stands from Beetrack; the format
-- rules were not applied". Everything the app issues itself stays false and
-- is still checked in full, so a new asset can never get a stray barcode.
--
-- ⚠️ The constraints are rebuilt inside do $$ ... execute ... $$ because a
-- plain ALTER referencing is_legacy would be parsed before the ADD COLUMN in
-- this same file had run, and fail with 42703.
--
-- Run after 01_schema.sql. Safe to re-run.
-- =====================================================================

alter table am_asset
  add column if not exists is_legacy boolean not null default false;

do $$
begin
  execute 'comment on column am_asset.is_legacy is '
       || '''Imported verbatim from the Beetrack register. Exempt from the '
       || 'barcode / asset-code / quantity format rules, which only bind the '
       || 'codes this app issues itself.''';

  -- Barcode: the app's two ranges, or anything at all on a legacy row.
  execute 'alter table am_asset drop constraint if exists am_asset_barcode_ck';
  execute $c$alter table am_asset add constraint am_asset_barcode_ck check (
      is_legacy
      or (asset_kind = 'unique' and barcode ~ '^JVC\.[0-8][0-9]{8}$')
      or (asset_kind = 'low'    and barcode ~ '^JVC\.9[0-9]{8}$'))$c$;

  -- Asset code must still be rebuildable from its parts -- unless legacy.
  execute 'alter table am_asset drop constraint if exists am_asset_code_ck';
  execute $c$alter table am_asset add constraint am_asset_code_ck check (
      is_legacy
      or asset_code = dept_code || '.' || group_code || '.' || letters || '.'
                      || purchase_year::text || '.' || lpad(seq::text, 5, '0'))$c$;

  -- One row per unit for unique assets -- unless legacy.
  execute 'alter table am_asset drop constraint if exists am_asset_unique_qty_ck';
  execute $c$alter table am_asset add constraint am_asset_unique_qty_ck check (
      is_legacy or asset_kind <> 'unique' or qty = 1)$c$;
end $$;

-- Legacy rows are read-only history: never hand out a code that reuses one.
create index if not exists am_asset_legacy_idx on am_asset (is_legacy);

-- How the import should split the register's "Loai Tai San" column:
--   'Barcode duy nhat' -> asset_kind = 'unique'  (one barcode per unit)
--   'Cung Barcode'     -> asset_kind = 'low'     (one barcode for the batch)


-- ####################################################################
-- ##  11_suggest.sql
-- ####################################################################

-- =====================================================================
-- 11_suggest.sql — GỢI Ý DANH MỤC TỪ LỊCH SỬ
--
-- Phiếu giao hàng KHÔNG chứa mã danh mục, đơn vị tính hay thời gian khấu
-- hao. Trước đây phải điền tay từng dòng. Nhưng sổ cũ đã có ~16.000 dòng,
-- và trong đó "Ghế" luôn là LTU/C2422. Vậy thì tra ngược tên hàng vào sổ
-- là điền sẵn được, kèm số lần đã dùng để người duyệt biết mức tin cậy.
--
-- Hai nguồn, am_product thắng vì đó là ánh xạ do người xác nhận:
--   1. am_product  — bảng ánh xạ tên thô -> danh mục chuẩn.
--   2. am_asset    — thống kê trên chính sổ tài sản.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

-- am_norm() là immutable nên dùng được cho index. Không có index này thì
-- mỗi lần gợi ý là một lần quét toàn bảng.
create index if not exists am_asset_name_norm_ix on am_asset (am_norm(name_vi));

-- ---------------------------------------------------------------------
-- Nhận một mảng tên hàng, trả về gợi ý cho từng tên.
--   n   = số dòng trong sổ đã dùng tổ hợp đó (0 = không có căn cứ)
--   src = 'product' | 'history' | 'none'
-- Không tự ý chọn khi không có căn cứ: trả null và để người dùng điền.
--
-- ⚠ PHẢI drop trước. 13_suggest_terms.sql thay hàm này bằng bản khớp theo
-- ranh giới từ với kiểu trả về KHÁC. Trên một cơ sở dữ liệu đã chạy 13, câu
-- "create or replace" ở đây sẽ định kéo kiểu trả về về lại bản cũ và Postgres
-- ném ERROR 42P13 — "cannot change return type of existing function". Có drop
-- thì ALL_IN_ONE.sql chạy lại được bao nhiêu lần cũng xong, theo thứ tự nào
-- cũng xong, vì 13 chạy sau và luôn là bản thắng.
-- ---------------------------------------------------------------------
drop function if exists am_suggest_lines(text[]);

create or replace function am_suggest_lines(p_names text[])
returns table (
  name              text,
  category_code     text,
  unit_code         text,
  depreciate_months int,
  n                 int,
  src               text
)
language sql
stable
as $$
  with want as (
    select distinct x as name, am_norm(x) as nrm
    from unnest(p_names) as x
    where coalesce(trim(x), '') <> ''
  ),
  prod as (
    select w.name, p.default_category, p.default_unit, p.times_used
    from want w
    join am_product p on p.raw_name_norm = w.nrm
  ),
  -- Danh mục hay gặp nhất cho mỗi tên.
  --
  -- Chỉ gộp nhóm theo category_code. Nếu gộp thêm unit_code / khấu hao thì
  -- thống kê bị phân mảnh: một danh mục dùng 40 lần nhưng rải trên ba đơn vị
  -- tính sẽ thua một danh mục dùng 7 lần nhưng đồng nhất. Đơn vị tính và
  -- khấu hao lấy bằng mode() trong chính nhóm đã thắng.
  hist as (
    select w.name,
           a.category_code,
           mode() within group (order by a.unit_code)         as unit_code,
           mode() within group (order by a.depreciate_months) as depreciate_months,
           count(*)::int as n,
           row_number() over (
             partition by w.name
             order by count(*) desc, a.category_code
           ) as rk
    from want w
    join am_asset a on am_norm(a.name_vi) = w.nrm
    where a.category_code is not null
    group by w.name, a.category_code
  )
  select w.name,
         coalesce(pr.default_category, h.category_code),
         coalesce(pr.default_unit,     h.unit_code),
         h.depreciate_months,
         coalesce(h.n, pr.times_used, 0)::int,
         case
           when pr.name is not null then 'product'
           when h.name  is not null then 'history'
           else 'none'
         end
  from want w
  left join prod pr on pr.name = w.name
  left join hist h  on h.name  = w.name and h.rk = 1;
$$;

comment on function am_suggest_lines(text[]) is
  'Gợi ý mã danh mục / đơn vị tính / khấu hao cho từng tên hàng, học từ am_product và sổ tài sản. Trả n = số dòng làm căn cứ, src = nguồn.';

-- ---------------------------------------------------------------------
-- Các tổ hợp khác cho MỘT tên, để người duyệt xem vì sao lại gợi ý vậy
-- và đổi sang lựa chọn khác nếu cần.
-- ---------------------------------------------------------------------
create or replace function am_suggest_detail(p_name text)
returns table (category_code text, unit_code text, n int)
language sql
stable
as $$
  select a.category_code,
         mode() within group (order by a.unit_code),
         count(*)::int
  from am_asset a
  where am_norm(a.name_vi) = am_norm(p_name)
    and a.category_code is not null
  group by a.category_code
  order by count(*) desc
  limit 20;
$$;

grant execute on function am_suggest_lines(text[]) to authenticated;
grant execute on function am_suggest_detail(text)  to authenticated;


-- ####################################################################
-- ##  13_suggest_terms.sql
-- ####################################################################

-- =====================================================================
-- 13_suggest_terms.sql — GỢI Ý THEO TỪ KHOÁ, KHÔNG PHẢI KHỚP TÊN CHÍNH XÁC
--
-- VÌ SAO: phiếu giao hàng ghi tên là cả một dòng thông số —
--   "RUCKUS ICX 8200 Switch, 48x10/100/1000 Mbps PoE+ ports, 4x25 GbE..."
-- Khớp tên chính xác với am_product không bao giờ chạm tới từ "Switch".
-- Đo trên 73 dòng thật của đợt Sitek: khớp chính xác ra 0 dòng.
--
-- ⚠️ PHẢI khớp theo RANH GIỚI TỪ (\y), không được khớp chuỗi con. Cùng bộ dữ
-- liệu đó, khớp chuỗi con ra 58 dòng nhưng kèm rác trông rất tự tin:
--   "MiVoice Bus License…" -> Vòi / faucet   ("voi" nằm trong "MiVoice")
--   "WatchDog Advance…"    -> Van / Valve    ("van" nằm trong "Advance")
-- Mã danh mục SAI nguy hiểm hơn ô TRỐNG: ô trống thì người duyệt thấy, mã sai
-- thì trôi thẳng vào sổ. Ranh giới từ ra 45 dòng và sạch rác kiểu đó.
--
-- Mỗi gợi ý đều mang theo NGUỒN và MỨC TIN CẬY để người duyệt tự cân nhắc.
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tách am_product thành các từ khoá tra cứu. "Bàn lạnh/Refrigerated table"
-- cho hai từ khoá: "ban lanh" và "refrigerated table".
-- Bỏ từ ngắn hơn 3 ký tự — chúng khớp bừa.
-- ---------------------------------------------------------------------
-- `words` là dạng CHỈ-CHỮ-SỐ, mọi thứ khác thành một khoảng trắng, có đệm hai
-- đầu. So khớp bằng LIKE trên dạng đó cho đúng ngữ nghĩa "ranh giới từ" mà
-- không phải escape ký tự đặc biệt của regex nằm trong chính tên sản phẩm —
-- am_norm KHÔNG bỏ dấu câu, nên tên thật đầy dấu phẩy, ngoặc và gạch chéo.
create or replace view am_product_term with (security_invoker = true) as
  select p.id,
         am_norm(trim(x)) as term,
         ' ' || trim(regexp_replace(am_norm(trim(x)), '[^a-z0-9]+', ' ', 'g')) || ' '
           as term_words,
         length(trim(x))  as term_len,
         p.std_name_vi, p.std_name_en,
         p.default_category, p.default_unit, p.times_used
  from   am_product p,
         lateral regexp_split_to_table(p.raw_name, '/') as x
  where  length(trim(x)) >= 3
    and  trim(regexp_replace(am_norm(trim(x)), '[^a-z0-9]+', ' ', 'g')) <> '';

comment on view am_product_term is
  'am_product tách theo dấu "/" thành từ khoá tra cứu cho am_suggest_lines.';

-- ---------------------------------------------------------------------
-- Gợi ý cho từng tên hàng. Thứ tự ưu tiên, dừng ở nguồn đầu tiên có kết quả:
--   1. am_product khớp CHÍNH XÁC tên     -> cao
--   2. sổ tài sản khớp CHÍNH XÁC tên     -> cao nếu >= 3 dòng làm chứng
--   3. am_product khớp TỪ KHOÁ (dài nhất thắng) -> vừa, hoặc thấp nếu từ ngắn
--   4. không có gì                        -> none, để người dùng tự điền
-- ---------------------------------------------------------------------
-- 11_suggest.sql đã tạo hàm này với BỘ CỘT TRẢ VỀ KHÁC (chưa có std_name,
-- matched_term, confidence). PostgreSQL không cho "create or replace" đổi kiểu
-- trả về — báo 42P13 — nên phải bỏ hàm cũ trước. Bỏ xong là mất quyền đã cấp,
-- vì vậy lệnh grant ở cuối file là bắt buộc, không phải thừa.
drop function if exists am_suggest_lines(text[]);

create or replace function am_suggest_lines(p_names text[])
returns table (
  name              text,
  std_name_vi       text,
  std_name_en       text,
  category_code     text,
  unit_code         text,
  depreciate_months int,
  n                 int,
  src               text,
  matched_term      text,
  confidence        text
)
language sql
stable
as $$
  with want as (
    select distinct x as name,
           am_norm(x) as nrm,
           ' ' || trim(regexp_replace(am_norm(x), '[^a-z0-9]+', ' ', 'g')) || ' ' as words
    from unnest(p_names) as x
    where coalesce(trim(x), '') <> ''
  ),

  -- 1. Ánh xạ sản phẩm do người xác nhận, khớp nguyên tên.
  exact_prod as (
    select w.name, p.std_name_vi, p.std_name_en,
           p.default_category, p.default_unit, p.times_used
    from want w join am_product p on p.raw_name_norm = w.nrm
  ),

  -- 2. Thống kê trên chính sổ tài sản, khớp nguyên tên.
  --    Chỉ gộp theo category_code — gộp thêm đơn vị/khấu hao làm phân mảnh.
  hist as (
    select w.name, a.category_code,
           mode() within group (order by a.unit_code)         as unit_code,
           mode() within group (order by a.depreciate_months) as depreciate_months,
           count(*)::int as n,
           row_number() over (partition by w.name
                              order by count(*) desc, a.category_code) as rk
    from want w
    join am_asset a on am_norm(a.name_vi) = w.nrm
    where a.category_code is not null
    group by w.name, a.category_code
  ),

  -- 3. Từ khoá, khớp theo RANH GIỚI TỪ (qua dạng chỉ-chữ-số có đệm khoảng
  --    trắng). Từ dài thắng, nên "access point" thắng "point".
  term_hit as (
    select w.name, tm.std_name_vi, tm.std_name_en,
           tm.default_category, tm.default_unit, tm.term, tm.term_len,
           row_number() over (partition by w.name
                              order by tm.term_len desc, tm.term) as rk
    from want w
    join am_product_term tm
      on w.words like '%' || tm.term_words || '%'
  )

  select w.name,
         coalesce(ep.std_name_vi, th.std_name_vi),
         coalesce(ep.std_name_en, th.std_name_en),
         coalesce(ep.default_category, h.category_code, th.default_category),
         coalesce(ep.default_unit, h.unit_code, th.default_unit),
         h.depreciate_months,
         coalesce(h.n, ep.times_used, 0)::int,
         case when ep.name is not null then 'product'
              when h.name  is not null then 'history'
              when th.name is not null then 'term'
              else 'none' end,
         th.term,
         case when ep.name is not null              then 'high'
              when h.name is not null and h.n >= 3  then 'high'
              when h.name is not null               then 'medium'
              when th.name is not null and th.term_len >= 6 then 'medium'
              when th.name is not null              then 'low'
              else 'none' end
  from want w
  left join exact_prod ep on ep.name = w.name
  left join hist h        on h.name  = w.name and h.rk = 1
  left join term_hit th   on th.name = w.name and th.rk = 1;
$$;

comment on function am_suggest_lines(text[]) is
  'Gợi ý tên chuẩn / danh mục / đơn vị cho từng tên hàng. Ưu tiên am_product khớp đúng, rồi sổ tài sản, rồi TỪ KHOÁ theo ranh giới từ. Trả kèm nguồn, từ đã khớp và mức tin cậy.';

grant execute on function am_suggest_lines(text[]) to authenticated;
grant select on am_product_term to authenticated;

-- ---------------------------------------------------------------------
-- Ghi nhớ một dòng người dùng đã sửa tay, để lần sau tự điền.
-- Chạy lại với cùng tên thì cập nhật, không nhân đôi.
-- ---------------------------------------------------------------------
create or replace function am_remember_product(
  p_raw_name text, p_std_vi text, p_std_en text,
  p_category text, p_unit text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v text;
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  if coalesce(trim(p_raw_name), '') = '' then
    raise exception 'tên hàng rỗng';
  end if;
  insert into am_product (raw_name_norm, raw_name, std_name_vi, std_name_en,
                          default_category, default_unit, times_used)
  values (am_norm(p_raw_name), trim(p_raw_name),
          coalesce(nullif(trim(p_std_vi), ''), trim(p_raw_name)),
          nullif(trim(p_std_en), ''), p_category, p_unit, 1)
  on conflict (raw_name_norm) do update
    set std_name_vi      = excluded.std_name_vi,
        std_name_en      = coalesce(excluded.std_name_en, am_product.std_name_en),
        default_category = coalesce(excluded.default_category, am_product.default_category),
        default_unit     = coalesce(excluded.default_unit, am_product.default_unit),
        times_used       = am_product.times_used + 1
  returning raw_name into v;
  return v;
end $$;

grant execute on function am_remember_product(text, text, text, text, text)
  to authenticated;


-- ####################################################################
-- ##  14_undo_intake.sql
-- ####################################################################

-- =====================================================================
-- 14_undo_intake.sql — HOÀN TÁC MỘT ĐỢT VỪA GHI VÀO SỔ
--
-- Vì sao phải là HÀM chứ không phải câu DELETE từ trình duyệt: vai `anon`
-- CỐ Ý không có quyền delete trên am_asset (04_rls.sql chỉ cấp select/insert/
-- update). Xoá tài sản là việc phải có luật đi kèm, và luật nằm ở đây:
--
--   1. Chỉ xoá đúng các id được truyền vào.
--   2. KHÔNG xoá dòng lịch sử (is_legacy) — đợt nhập không bao giờ tạo ra
--      chúng, nên nếu id nào là legacy thì đó là nhầm lẫn, phải chặn.
--   3. KHÔNG xoá tài sản đã nằm trên một biên bản tem nhãn đã lưu. Biên bản
--      là chứng từ đã phát hành; xoá tài sản dưới chân nó sẽ để lại một biên
--      bản trỏ vào hư không. Những dòng đó được GIỮ LẠI và báo về.
--
-- BỘ ĐẾM: lùi lại ĐƯỢC, nhưng chỉ khi chắc chắn an toàn. Điều kiện:
--
--   a) Bộ đếm vẫn đứng đúng chỗ đợt này để lại (next = max(seq đã xoá) + 1).
--      Nếu ai đó đã cấp thêm sau mình thì next đã vượt qua — lùi lúc đó sẽ
--      cấp lại số người khác đang dùng. Trường hợp này GIỮ NGUYÊN.
--   b) Không dòng nào trong đợt đã được đánh dấu ĐÃ IN TEM. Xoá dòng trong
--      cơ sở dữ liệu không bóc được cái tem đã dán lên hiện vật; cấp lại số
--      đó sẽ tạo ra hai vật mang cùng một mã.
--
-- Không đủ điều kiện thì bộ đếm đứng yên và dãy số có một khoảng trống — đó là
-- cái giá đúng, vì trùng mã tệ hơn thủng số rất nhiều.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_undo_intake(bigint[]);

create or replace function am_undo_intake(p_ids bigint[])
returns table (deleted int, kept_on_receipt int, kept_legacy int,
               seq_rewound int, seq_held int, barcode_rewound int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_del     int := 0;
  v_receipt int := 0;
  v_legacy  int := 0;
  v_rew     int := 0;
  v_held    int := 0;
  v_bcrew   int := 0;
  v_printed int := 0;
  r         record;
begin
  perform app_require('assets', 'create');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_ids := app_scope_ids(p_ids);            -- chỉ những dòng trong phạm vi của người gọi
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0, 0, 0, 0, 0;
    return;
  end if;

  -- A printed label cannot be unprinted, so its number must never come back.
  select count(*) into v_printed
  from   am_asset a
  where  a.id = any(p_ids) and a.label_printed;

  -- Snapshot what this batch used, BEFORE deleting it.
  create temp table if not exists _undo_used (
    dept_code text, letters text, seq int, kind text, barcode text
  ) on commit drop;
  delete from _undo_used;
  insert into _undo_used
  select a.dept_code, a.letters, a.seq, a.asset_kind, a.barcode
  from   am_asset a
  where  a.id = any(p_ids)
    and  not a.is_legacy
    and  not exists (select 1 from am_alr_line l where l.asset_id = a.id);

  select count(*) into v_legacy
  from   am_asset a
  where  a.id = any(p_ids) and a.is_legacy;

  select count(distinct l.asset_id) into v_receipt
  from   am_alr_line l
  where  l.asset_id = any(p_ids);

  with gone as (
    delete from am_asset a
    where  a.id = any(p_ids)
      and  not a.is_legacy
      and  not exists (select 1 from am_alr_line l where l.asset_id = a.id)
    returning 1
  )
  select count(*) into v_del from gone;

  /* Rewind each (dept, letters) counter, but ONLY where it still stands exactly
     where this batch left it. If it has moved on, someone allocated after us
     and those numbers are in use — leave it alone and count it as held. */
  if v_printed = 0 then
    for r in
      select u.dept_code, u.letters, min(u.seq) as lo, max(u.seq) as hi
      from   _undo_used u group by u.dept_code, u.letters
    loop
      update am_asset_seq s
         set next_seq = greatest(
               1, coalesce((select max(a.seq) from am_asset a
                            where a.dept_code = r.dept_code
                              and a.letters = r.letters
                              and a.seq > 0), 0) + 1),
             updated_at = now()
       where s.dept_code = r.dept_code
         and s.letters   = r.letters
         and s.next_seq  = r.hi + 1;
      if found then v_rew := v_rew + 1; else v_held := v_held + 1; end if;
    end loop;

    /* Barcodes are one counter per kind. Same test: only rewind when the
       counter is still sitting right after the highest number this batch took. */
    for r in
      select u.kind, count(*) as n,
             max((regexp_replace(u.barcode, '^JVC\.9?', ''))::bigint) as hi
      from   _undo_used u
      where  u.barcode ~ '^JVC\.[0-9]+$'
      group by u.kind
    loop
      update am_barcode_seq b
         set next_val = greatest(1, b.next_val - r.n), updated_at = now()
       where b.kind = r.kind
         and b.next_val = r.hi + 1;
      if found then v_bcrew := v_bcrew + 1; end if;
    end loop;
  else
    select count(distinct (u.dept_code, u.letters)) into v_held from _undo_used u;
  end if;

  return query select v_del, v_receipt, v_legacy, v_rew, v_held, v_bcrew;
end $$;

comment on function am_undo_intake(bigint[]) is
  'Xoá các tài sản vừa ghi bởi một đợt nhập và lùi bộ đếm về nếu an toàn. Giữ lại dòng lịch sử và dòng đã nằm trên biên bản đã lưu. Chỉ lùi bộ đếm khi nó vẫn đứng đúng chỗ đợt này để lại VÀ chưa dòng nào được đánh dấu đã in tem.';

grant execute on function am_undo_intake(bigint[]) to authenticated;


-- ####################################################################
-- ##  15_bulk_edit.sql
-- ####################################################################

-- =====================================================================
-- 15_bulk_edit.sql — SỬA / XOÁ HÀNG LOẠT TRONG SỔ TÀI SẢN
--
-- Vì sao là HÀM chứ không phải PATCH/DELETE thẳng từ trình duyệt:
--
--   * Vai `anon` CỐ Ý không có quyền delete trên am_asset (04_rls.sql).
--   * Đổi PHÒNG BAN không phải là đổi một ô. Ràng buộc am_asset_code_ck bắt
--     buộc  asset_code = dept_code.group.letters.year.seq  — nên một lệnh
--     UPDATE dept_code trần sẽ bị cơ sở dữ liệu ném ra ngay. Mã tài sản MANG
--     mã phòng ban; đổi phòng ban là phải cấp lại mã.
--
-- Do đó hàm này làm đúng việc phải làm, chứ không làm việc dễ:
--
--   1. Vị trí / tình trạng: đổi thẳng, không ảnh hưởng mã.
--   2. Phòng ban: cấp SỐ MỚI từ bộ đếm của (phòng ban mới, CHỮ) và dựng lại
--      asset_code. MÃ VẠCH GIỮ NGUYÊN — mã vạch mới là danh tính vĩnh viễn của
--      hiện vật, còn asset_code là chỗ nó đang thuộc về.
--   3. Mã cũ KHÔNG được trả lại bộ đếm cũ. Số đã cấp coi như đã tiêu; trùng mã
--      tệ hơn thủng số rất nhiều.
--   4. Dòng nào đã in tem thì tem đó giờ sai — label_printed bị đặt lại false
--      để nó quay vào hàng đợi in lại. Hàm trả về số lượng cần in lại.
--   5. Dòng lịch sử (is_legacy) KHÔNG đổi được phòng ban: mã của chúng không
--      theo quy tắc của app nên không dựng lại được. Chúng được bỏ qua và báo về.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_bulk_update(bigint[], text, text, text);

create or replace function am_bulk_update(
  p_ids      bigint[],
  p_location text default null,
  p_dept     text default null,
  p_status   text default null
)
returns table (updated int, recoded int, skipped_legacy int, relabel int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_up      int := 0;
  v_recode  int := 0;
  v_legacy  int := 0;
  v_relabel int := 0;
  r         record;
  v_first   int;
begin
  perform app_require('assets', 'edit');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_ids := app_scope_ids(p_ids);            -- chỉ những dòng trong phạm vi của người gọi
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0, 0, 0; return;
  end if;

  -- Thà không đổi gì còn hơn ghi một mã treo.
  if p_location is not null then
    p_location := upper(trim(p_location));
    if not exists (select 1 from am_location where code = p_location) then
      raise exception 'Mã vị trí % không có trong danh mục', p_location;
    end if;
  end if;
  if p_dept is not null then
    p_dept := upper(trim(p_dept));
    if not exists (select 1 from am_org where code = p_dept and is_department) then
      raise exception 'Mã phòng ban % không có trong danh mục', p_dept;
    end if;
    if p_dept not in (select app_scope_orgs()) then
      raise exception 'Phòng ban % nằm ngoài phạm vi của bạn.', p_dept using errcode = '42501';
    end if;
  end if;

  -- --- 1. Vị trí / tình trạng -----------------------------------------
  if p_location is not null or p_status is not null then
    update am_asset a
       set location_code = coalesce(p_location, a.location_code),
           status_code   = coalesce(p_status,   a.status_code)
     where a.id = any(p_ids);
    get diagnostics v_up = row_count;
  end if;

  -- --- 2. Phòng ban: cấp lại mã ----------------------------------------
  if p_dept is not null then
    select count(*) into v_legacy
    from   am_asset a
    where  a.id = any(p_ids) and a.is_legacy and a.dept_code <> p_dept;

    -- Cấp theo từng khối (phòng ban mới, CHỮ) để bộ đếm chỉ nhích một lần mỗi
    -- khối, rồi rải số liên tiếp theo thứ tự id.
    create temp table if not exists _bulk_recode (
      id bigint primary key, letters text, new_seq int
    ) on commit drop;
    delete from _bulk_recode;

    /* am_letters() on both sides: the counter is keyed by the stripped form
       ('MVT', never 'MVT-QR'), and the code has to be built from the same value
       the number came out of, or am_asset_code_ck will disagree with it. */
    for r in
      select am_letters(a.letters) as letters, count(*) as n
      from   am_asset a
      where  a.id = any(p_ids) and not a.is_legacy and a.dept_code <> p_dept
      group by am_letters(a.letters)
    loop
      v_first := am_alloc_asset_seq(p_dept, r.letters, r.n::int, null::bigint, 'bulk_update');
      insert into _bulk_recode (id, letters, new_seq)
      select a.id, r.letters,
             v_first + (row_number() over (order by a.id))::int - 1
      from   am_asset a
      where  a.id = any(p_ids) and not a.is_legacy
        and  a.dept_code <> p_dept and am_letters(a.letters) = r.letters;
    end loop;

    -- Tem đã in mang mã cũ: đếm TRƯỚC khi ghi đè.
    select count(*) into v_relabel
    from   am_asset a join _bulk_recode b on b.id = a.id
    where  a.label_printed;

    update am_asset a
       set dept_code     = p_dept,
           letters       = b.letters,
           seq           = b.new_seq,
           asset_code    = am_build_asset_code(p_dept, a.group_code, b.letters,
                                               a.purchase_year, b.new_seq),
           label_printed = false
      from _bulk_recode b
     where b.id = a.id;
    get diagnostics v_recode = row_count;

    v_up := greatest(v_up, v_recode);
  end if;

  return query select v_up, v_recode, v_legacy, v_relabel;
end $$;

comment on function am_bulk_update(bigint[], text, text, text) is
  'Sửa vị trí / phòng ban / tình trạng cho nhiều tài sản cùng lúc. Bỏ qua tham số null. Đổi phòng ban sẽ CẤP LẠI mã tài sản (giữ nguyên mã vạch) và đặt lại cờ đã in tem; dòng lịch sử được bỏ qua.';

-- ---------------------------------------------------------------------
-- XOÁ HÀNG LOẠT
--
-- Khác am_undo_intake ở hai chỗ, đều có lý do:
--   * CÓ xoá dòng lịch sử — đây chính là chỗ người dùng dọn các dòng trùng của
--     sổ Beetrack cũ.
--   * KHÔNG lùi bộ đếm. Undo chỉ lùi được vì nó biết chắc đợt vừa ghi là phần
--     đuôi của dãy số; một nhóm dòng chọn tay giữa sổ thì không có gì bảo đảm đó.
-- Vẫn giữ nguyên một luật: không xoá tài sản đã nằm trên biên bản tem nhãn đã
-- lưu, vì biên bản là chứng từ đã phát hành.
-- ---------------------------------------------------------------------
drop function if exists am_bulk_delete(bigint[]);

create or replace function am_bulk_delete(p_ids bigint[])
returns table (deleted int, kept_on_receipt int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_del  int := 0;
  v_keep int := 0;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_ids := app_scope_ids(p_ids);            -- chỉ những dòng trong phạm vi của người gọi
  if p_ids is null or array_length(p_ids, 1) is null then
    return query select 0, 0; return;
  end if;

  select count(distinct l.asset_id) into v_keep
  from   am_alr_line l where l.asset_id = any(p_ids);

  with gone as (
    delete from am_asset a
    where  a.id = any(p_ids)
      and  not exists (select 1 from am_alr_line l where l.asset_id = a.id)
    returning 1
  )
  select count(*) into v_del from gone;

  return query select v_del, v_keep;
end $$;

comment on function am_bulk_delete(bigint[]) is
  'Xoá nhiều tài sản cùng lúc. Giữ lại dòng đã nằm trên biên bản tem nhãn đã lưu. KHÔNG lùi bộ đếm — số đã cấp coi như đã tiêu.';

grant execute on function am_bulk_update(bigint[], text, text, text) to authenticated;
grant execute on function am_bulk_delete(bigint[]) to authenticated;


-- ####################################################################
-- ##  16_reset_counters.sql
-- ####################################################################

-- =====================================================================
-- 16_reset_counters.sql — ĐẶT LẠI BỘ ĐẾM VỀ NGANG SỔ
--
-- Bối cảnh: am_seed_asset_seq() dùng greatest(), nên nút "Đối chiếu với sổ"
-- chỉ ĐẨY LÊN, không bao giờ kéo xuống. Đó là mặc định đúng — nhưng sau khi
-- xoá hàng loạt, bộ đếm đứng cao hơn sổ và dãy số thủng một khoảng.
--
-- Hai hàm ở đây là đường duy nhất để kéo xuống, và cả hai đều bị chặn bởi
-- MỘT luật không thương lượng:
--
--     next_seq KHÔNG BAO GIỜ được đặt thấp hơn max(seq đang có) + 1.
--
-- Hạ thấp hơn mức đó là cấp lại một mã đang nằm trong sổ — đúng thứ toàn bộ
-- ứng dụng này sinh ra để ngăn. Hàm sẽ báo lỗi chứ không im lặng kẹp số.
--
-- ⚠ VẪN CÒN MỘT RỦI RO MÀ CƠ SỞ DỮ LIỆU KHÔNG THẤY ĐƯỢC: nếu một mã đã được
-- IN RA TEM rồi dòng đó bị xoá, sổ không còn dấu vết nào của nó, nên sàn tính
-- ở trên không biết mà tránh. Kéo bộ đếm xuống lúc đó sẽ cấp lại một số đang
-- dán trên hiện vật. Vì thế đây là thao tác THỦ CÔNG, do người biết đợt nào
-- đã in quyết định — không phải việc app tự làm sau mỗi lần xoá.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================

drop function if exists am_set_asset_seq(text, text, int);

-- Đặt tay MỘT khoá. Trả về giá trị cũ, giá trị mới và sàn an toàn.
create or replace function am_set_asset_seq(
  p_dept text, p_letters text, p_next int
)
returns table (dept_code text, letters text, old_next int, new_next int, floor_next int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old   int;
  v_floor int;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
  p_dept    := upper(trim(p_dept));
  p_letters := am_letters(p_letters);

  if not exists (select 1 from am_org where code = p_dept and is_department) then
    raise exception 'Mã phòng ban % không có trong danh mục', p_dept;
  end if;
  if p_next is null or p_next < 1 then
    raise exception 'Số kế tiếp phải >= 1';
  end if;

  -- Sàn: ngay sau số cao nhất đang thực sự nằm trong sổ ở khoá này.
  select coalesce(max(a.seq), 0) + 1 into v_floor
  from   am_asset a
  where  a.dept_code = p_dept and a.letters = p_letters and a.seq > 0;

  if p_next < v_floor then
    raise exception
      'Không hạ được bộ đếm (%, %) xuống % — sổ đang có mã tới số %, đặt thấp hơn % sẽ cấp trùng.',
      p_dept, p_letters, p_next, v_floor - 1, v_floor;
  end if;

  -- Đọc giá trị cũ TRƯỚC khi ghi, nếu không thì khoá mới sẽ tự báo là "không đổi".
  select s.next_seq into v_old
  from   am_asset_seq s where s.dept_code = p_dept and s.letters = p_letters;

  /* UPDATE rồi INSERT chứ không dùng "on conflict (dept_code, letters)": phần
     RETURNS TABLE ở trên đã biến dept_code và letters thành BIẾN PL/pgSQL, mà
     ô suy diễn chỉ mục của ON CONFLICT lại được đọc như một biểu thức — nên
     Postgres không biết đó là biến hay là cột và báo "column reference is
     ambiguous". Ở đây mọi tham chiếu đều có tiền tố bảng, còn danh sách cột
     của INSERT thì không bao giờ bị đọc là biến. */
  update am_asset_seq s
     set next_seq = p_next, updated_at = now()
   where s.dept_code = p_dept and s.letters = p_letters;

  if not found then
    insert into am_asset_seq (dept_code, letters, next_seq)
    values (p_dept, p_letters, p_next);
  end if;

  -- Ghi nhật ký kể cả khi kéo xuống: from > to đọc ra ngay là một lần đặt tay.
  if v_old is distinct from p_next then
    insert into am_counter_log (counter, scope, from_val, to_val, actor)
    values ('asset_seq', p_dept || '|' || p_letters,
            coalesce(v_old, 0), p_next, 'set_manual');
  end if;

  return query select p_dept, p_letters, v_old, p_next, v_floor;
end $$;

comment on function am_set_asset_seq(text, text, int) is
  'Đặt tay số kế tiếp của một khoá bộ đếm. Chặn mọi giá trị thấp hơn max(seq trong sổ)+1. Ghi vào am_counter_log.';

-- ---------------------------------------------------------------------
drop function if exists am_reseed_counters(boolean);

-- Nạp lại TOÀN BỘ khoá từ am_asset.
--   p_allow_lower = false : chỉ đẩy lên (giống nút Đối chiếu sẵn có)
--   p_allow_lower = true  : đặt đúng bằng max(seq)+1, kể cả khi phải kéo xuống
create or replace function am_reseed_counters(p_allow_lower boolean default false)
returns table (scope text, old_next int, new_next int, moved text)
language plpgsql
security definer
set search_path = public
as $$
declare r record;
begin
  perform app_require('assets', 'admin');   -- quyền theo người đăng nhập — xem 17_auth.sql
  create temp table if not exists _reseed (
    scope text, old_next int, new_next int, moved text
  ) on commit drop;
  delete from _reseed;

  for r in
    select a.dept_code as d, a.letters as l, max(a.seq) + 1 as want,
           coalesce(s.next_seq, 0) as have
    from   am_asset a
    left join am_asset_seq s
           on s.dept_code = a.dept_code and s.letters = a.letters
    where  a.seq > 0
    group by a.dept_code, a.letters, s.next_seq
  loop
    if r.want = r.have then continue; end if;
    if r.want < r.have and not p_allow_lower then continue; end if;

    insert into am_asset_seq (dept_code, letters, next_seq)
    values (r.d, r.l, r.want)
    on conflict (dept_code, letters)
      do update set next_seq = excluded.next_seq, updated_at = now();

    insert into am_counter_log (counter, scope, from_val, to_val, actor)
    values ('asset_seq', r.d || '|' || r.l, r.have, r.want, 'reseed');

    insert into _reseed values (r.d || '|' || r.l, r.have, r.want,
      case when r.want < r.have then 'down' else 'up' end);
  end loop;

  /* Khoá nào không còn dòng tài sản nào thì max() ở trên không thấy. Nếu bộ đếm
     của nó đang > 1 thì đó là một khoá đã bị xoá sạch — trả về 1 khi được phép. */
  if p_allow_lower then
    for r in
      select s.dept_code as d, s.letters as l, s.next_seq as have
      from   am_asset_seq s
      where  s.next_seq > 1
        and  not exists (select 1 from am_asset a
                         where a.dept_code = s.dept_code
                           and a.letters = s.letters and a.seq > 0)
    loop
      update am_asset_seq s set next_seq = 1, updated_at = now()
       where s.dept_code = r.d and s.letters = r.l;
      insert into am_counter_log (counter, scope, from_val, to_val, actor)
      values ('asset_seq', r.d || '|' || r.l, r.have, 1, 'reseed');
      insert into _reseed values (r.d || '|' || r.l, r.have, 1, 'empty');
    end loop;
  end if;

  return query select x.scope, x.old_next, x.new_next, x.moved
               from _reseed x order by x.moved, x.scope;
end $$;

comment on function am_reseed_counters(boolean) is
  'Nạp lại toàn bộ khoá bộ đếm mã tài sản từ am_asset. p_allow_lower=true cho phép KÉO XUỐNG đúng bằng max(seq)+1 sau khi xoá hàng loạt — chỉ dùng khi chắc chắn không có mã nào đã in tem rồi bị xoá.';

grant execute on function am_set_asset_seq(text, text, int) to authenticated;
grant execute on function am_reseed_counters(boolean) to authenticated;


-- ####################################################################
-- ##  17_auth.sql
-- ####################################################################

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
                             'pm_tender_log', 'pm_tender_open_roles', 'pm_tender_can_manage',
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


-- ####################################################################
-- ##  18_pm_budget.sql
-- ####################################################################

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


-- ####################################################################
-- ##  19_pm_workflow.sql
-- ####################################################################

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

-- Tự duyệt (giai đoạn thử nghiệm, 25/09/2026): mặc định NGƯỜI LẬP không được
-- kiểm tra / duyệt bộ hồ sơ của chính mình. Khi thử một mình với nhiều vai trò,
-- đặt am_setting 'pm_allow_self_approve' = true (Hệ thống → Ngưỡng); đặt lại
-- false khi dùng thật.
insert into am_setting (key, value, note) values
  ('pm_allow_self_approve', 'false',
   'true = người lập được tự kiểm tra / duyệt bộ hồ sơ của mình (chỉ để thử nghiệm). false khi dùng thật.')
on conflict (key) do nothing;

create or replace function pm_self_ok()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from am_setting where key = 'pm_allow_self_approve') in ('true'::jsonb, '"true"'::jsonb), false)
$$;

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
declare k pm_pkg; p pm_project; v_lead text; v_grp text; v_ent text; v_first int; v_from text; v_sig jsonb;
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
  -- Gửi RR là gửi luôn PR (và ngược lại): chứng từ cùng nhóm của dự án còn nằm
  -- ở bộ khác đang soạn / bị trả về (bộ tách từ trước khi có bộ hồ sơ) được
  -- gộp vào bộ này trước khi gửi.
  v_grp := coalesce((select grp from pm_doc_type where code = k.grp), k.grp);
  if exists (select 1 from pm_doc_type where grp = v_grp) then
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
    and  (k.created_by is distinct from auth.uid() or pm_self_ok())
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
  join   app_user u    on u.active and (u.id is distinct from k.created_by or pm_self_ok())
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
  and  privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Công tắc tự duyệt pm_allow_self_approve (Ngưỡng) — hiện tại',
       coalesce((select value::text from am_setting where key = 'pm_allow_self_approve'), '—'), 'false khi dùng thật',
       case when exists (select 1 from am_setting where key = 'pm_allow_self_approve') then '✔' else '✘ HỎNG' end;


-- ####################################################################
-- ##  20_pm_notify.sql
-- ####################################################################

-- =====================================================================
-- 20_pm_notify.sql — QUẢN LÝ DỰ ÁN, GIAI ĐOẠN 4: THÔNG BÁO + CHỮ KÝ ĐÃ LƯU
--
-- Chạy SAU 19_pm_workflow.sql (bản có BỘ HỒ SƠ 26/09/2026 — chạy lại 19 trước
-- nếu đã chạy bản cũ).
--
--   pm_notice     thông báo trong app (chuông ở góc trên): "có chứng từ chờ bạn
--                 duyệt", "chứng từ của bạn đã được duyệt / bị trả về / bị từ
--                 chối / bị huỷ". Sinh tự động từ nhật ký pm_doc_event, nên mọi
--                 đường thay đổi trạng thái đều báo, không sót đường nào.
--   pm_signature  chữ ký mẫu của mỗi người, để lần sau bấm "Dùng chữ ký đã lưu"
--                 thay vì vẽ lại. Mỗi người chỉ thấy và sửa được chữ ký của mình.
--
-- Email là bước sau (cần Edge Function + dịch vụ gửi mail); bảng pm_notice đã
-- đủ thông tin để bước đó chỉ việc đọc ra gửi đi.
--
-- Chạy lại nhiều lần vô hại.
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_notice (
  id           bigserial primary key,
  user_id      uuid not null references app_user(id) on delete cascade,
  doc_id       bigint references pm_doc(id) on delete cascade,
  kind         text not null check (kind in ('todo', 'approved', 'returned', 'rejected', 'cancelled')),
  doc_no       text,
  doc_type     text,
  project_code text,
  actor_email  text,
  comment      text,
  created_at   timestamptz not null default now(),
  read_at      timestamptz
);
create index if not exists pm_notice_user_idx on pm_notice (user_id, read_at, created_at desc);
comment on table pm_notice is
  'Thông báo trong app. Chỉ trigger ghi; người dùng chỉ đọc và đánh dấu đã đọc (read_at) thông báo của mình.';

create table if not exists pm_signature (
  user_id    uuid primary key default auth.uid() references app_user(id) on delete cascade,
  png        text not null check (png like 'data:image/png;base64,%' and length(png) <= 300000),
  updated_at timestamptz not null default now()
);
comment on table pm_signature is
  'Chữ ký mẫu. Khi ký, ảnh được CHÉP vào bước duyệt — đổi chữ ký mẫu sau này không sửa chứng từ đã ký.';


-- Theo quyết định 24/09/2026: TẠM KHÔNG BẮT BUỘC ký (chưa có iPad cho mọi người
-- duyệt). App vẫn mời ký, bấm "Bỏ qua" được. Muốn bắt buộc: sửa value thành
-- true ở Hệ thống → Cài đặt (am_setting). "do nothing": chạy lại file này
-- không ghi đè giá trị đã sửa trong app.
insert into am_setting (key, value, note)
values ('pm_require_signature', 'false'::jsonb,
        'true = bắt buộc ký tay khi gửi duyệt và khi duyệt chứng từ dự án; false = không bắt buộc')
on conflict (key) do nothing;


-- =====================================================================
-- 2. SINH THÔNG BÁO TỪ NHẬT KÝ BỘ HỒ SƠ
-- =====================================================================

-- Thông báo mới (26/09/2026): pkg_id, và kind "next" = bộ trước đã duyệt xong,
-- tới lượt bạn lập chứng từ tiếp theo (vd Thu mua lập QC sau khi bộ PR duyệt).
alter table pm_notice add column if not exists pkg_id bigint references pm_pkg(id) on delete cascade;
alter table pm_notice drop constraint if exists pm_notice_kind_check;
alter table pm_notice add constraint pm_notice_kind_check
  check (kind in ('todo', 'approved', 'returned', 'rejected', 'cancelled', 'next'));

/* Mọi thay đổi trạng thái của một bộ đi qua pm_pkg_event, nên báo từ đây là
   không sót đường nào:
   - bộ đang chờ duyệt: báo "việc cần làm" cho mọi người làm được bước hiện
     tại (kể cả khi Kế toán trưởng / GM JVC trả PA / MC về AM team);
   - kết cục (duyệt xong / trả về người lập / từ chối / huỷ): báo người lập;
   - duyệt xong: báo người lập chứng từ bắt buộc kế tiếp (QC sau bộ PR, PO sau
     bộ QC, AH sau PO) theo chuỗi của pháp nhân. */
create or replace function pm_notify_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare k pm_pkg; p pm_project; s pm_pkg_step; v_nos text; v_lead text; v_first bigint; v_next text;
begin
  select * into k from pm_pkg where id = new.pkg_id;
  if k.id is null then return null; end if;
  select * into p from pm_project where code = k.project_code;
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
      and  app_user_role_covers(u.id, s.role_code, p.dept_code)
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

  if k.status = 'approved' and new.to_status = 'approved' then
    select t.code into v_next from pm_doc_type t
     where t.required and t.side = 'operator'
       and t.seq > (select max(x.seq) from pm_doc_type x where x.code = v_lead or x.grp = k.grp)
     order by t.seq limit 1;
    if v_next is not null then
      insert into pm_notice (user_id, doc_id, pkg_id, kind, doc_no, doc_type, project_code, actor_email)
      select u.id, v_first, k.id, 'next', v_nos, v_next, k.project_code, new.actor_email
      from   app_user u
      join   pm_chain c on c.entity = pm_entity(p.dept_code) and c.doc_type = v_next and c.step = 0
      where  u.active and app_user_role_covers(u.id, c.role_code, p.dept_code);
    end if;
  end if;
  return null;
end $$;

-- Thông báo sinh từ BỘ; nhật ký từng chứng từ (lập, sửa quản trị) không báo gì nữa.
drop trigger if exists pm_notify on pm_doc_event;
drop trigger if exists pm_notify on pm_pkg_event;
create trigger pm_notify after insert on pm_pkg_event
  for each row execute function pm_notify_trg();


-- =====================================================================
-- 3. RLS — mỗi người chỉ thấy đồ của mình
-- =====================================================================

do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('pm_notice', 'pm_signature')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table pm_notice    enable row level security;
alter table pm_signature enable row level security;

create policy pm_notice_read on pm_notice
  for select to authenticated using (user_id = (select auth.uid()));
create policy pm_notice_mark on pm_notice
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy pm_signature_own on pm_signature
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on pm_notice, pm_signature from anon;
revoke insert, update, delete on pm_notice from authenticated;
grant select on pm_notice to authenticated;
grant update (read_at) on pm_notice to authenticated;       -- chỉ đánh dấu đã đọc
grant select, insert, update, delete on pm_signature to authenticated;
revoke execute on function pm_notify_trg() from public, anon, authenticated;
-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 4. KIỂM CHỨNG
-- =====================================================================

select 'Bảng thông báo + chữ ký có RLS' as "Mục",
       count(*) filter (where rowsecurity)::text || '/' || count(*)::text as "Thực tế",
       '2/2' as "Mong đợi",
       case when count(*) = 2 and bool_and(rowsecurity) then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_tables where schemaname = 'public' and tablename in ('pm_notice', 'pm_signature')
union all
select 'Trigger sinh thông báo', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_trigger where tgname = 'pm_notify' and not tgisinternal
union all
select 'Gửi duyệt nhận chữ ký', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ Chạy lại 19_pm_workflow.sql trước' end
from   pg_proc where proname = 'pm_doc_submit' and pronargs = 2
union all
select 'Bản gửi duyệt cũ đã bỏ (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ Chạy lại 19_pm_workflow.sql' end
from   pg_proc where proname = 'pm_doc_submit' and pronargs = 1
union all
select 'Bộ hồ sơ (26/09): trigger trên nhật ký bộ', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ Chạy lại 19_pm_workflow.sql trước' end
from   pg_trigger g join pg_class c on c.oid = g.tgrelid where g.tgname = 'pm_notify' and c.relname = 'pm_pkg_event';


-- ####################################################################
-- ##  21_pm_payment.sql
-- ####################################################################

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
  c_new  int := 0; c_upd int := 0; c_auto int := 0; c_queue int := 0; c_gone int := 0;
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
      if pm_auto_alloc('invoice', v_id, r ->> 'description') then c_auto := c_auto + 1; else c_queue := c_queue + 1; end if;
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
      if pm_auto_alloc('payment', v_id, r ->> 'description') then c_auto := c_auto + 1; else c_queue := c_queue + 1; end if;
      -- Nhà cung cấp mới gặp lần đầu: thêm vào danh mục (mã = mã đối tượng kế toán).
      if coalesce(r ->> 'vendor_code', '') <> '' then
        insert into pm_vendor (code, name) values (r ->> 'vendor_code', coalesce(nullif(r ->> 'vendor_name', ''), r ->> 'vendor_code'))
        on conflict (code) do nothing;
      end if;
    end if;
    if v_new then c_new := c_new + 1; else c_upd := c_upd + 1; end if;
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
  get diagnostics c_gone = row_count;

  update pm_pay_import
     set period_from = v_from, period_to = v_to, n_rows = c_new + c_upd, n_new = c_new, n_updated = c_upd,
         n_auto = c_auto, n_queue = c_queue, n_gone = c_gone
   where id = v_imp;
  return jsonb_build_object('import_id', v_imp, 'rows', c_new + c_upd, 'new', c_new, 'updated', c_upd,
                            'auto', c_auto, 'queue', c_queue, 'gone', c_gone,
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


-- ####################################################################
-- ##  22_admin_tools.sql
-- ####################################################################

-- =====================================================================
-- 22_admin_tools.sql — CÔNG CỤ QUẢN TRỊ CHO GIAI ĐOẠN THỬ NGHIỆM
--
-- Chạy SAU 21_pm_payment.sql. Chạy lại nhiều lần vô hại.
--
--   Khu quyền mới "override" (Quyền quản trị dữ liệu) trong ma trận quyền:
--     Xem   = mở màn hình Công cụ quản trị
--     Sửa   = sửa MỌI nội dung: chứng từ ở bất kỳ trạng thái nào (đã gửi, đã
--             duyệt, bị từ chối), mở lại chứng từ thành nháp. Mỗi lần sửa ghi
--             vào lịch sử chứng từ và nhật ký thay đổi.
--     Quản trị = ĐẶT LẠI (xoá) dữ liệu thử theo từng nhóm.
--   System Admin có đủ ba quyền.
--
--   Vai trò mới CONTENT_EDITOR "Người sửa nội dung": gán cho người cụ thể ở
--   Người dùng → vai trò. Có quyền Xem + Sửa ở khu override và Xem + Sửa ở
--   các khu dữ liệu (tài sản, danh mục, ngân sách, dự án, thanh toán) — nhưng
--   KHÔNG đặt lại dữ liệu, KHÔNG duyệt, KHÔNG phân quyền.
--
-- Project Supabase DÙNG CHUNG với các app khác: hàm đặt lại chỉ đụng tới các
-- bảng am_/pm_/app_audit liệt kê tên ở dưới — không bao giờ quét theo mẫu tên.
-- Sổ tài sản cũ nạp từ Beetrack (is_legacy) và mọi danh mục KHÔNG bị xoá.
-- =====================================================================


-- =====================================================================
-- 1. KHU QUYỀN + VAI TRÒ
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('override', 'Admin override (edit any content, reset test data)', 'Quyền quản trị dữ liệu (sửa mọi nội dung, đặt lại dữ liệu thử)', 100)
on conflict (code) do update
  set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('CONTENT_EDITOR', 'SYS', 'Content editor', 'Người sửa nội dung', false, 'PHCL', 990)
on conflict (code) do update
  set name_en = excluded.name_en, name_vi = excluded.name_vi, default_scope = excluded.default_scope, sort = excluded.sort;

-- System Admin: mọi quyền trên khu mới. "do nothing": quyền đã chỉnh trong app giữ nguyên.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
values ('SYS_ADMIN', 'override', true, true, true, true, true)
on conflict (role_code, module_code) do nothing;

-- Người sửa nội dung: xem + sửa, không tạo / xoá / duyệt / quản trị.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'CONTENT_EDITOR', m, true, false, true, false, false
from   unnest(array['override', 'assets', 'master', 'budget', 'project', 'payment']) m
on conflict (role_code, module_code) do nothing;
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'CONTENT_EDITOR', m, true, false, false, false, false
from   unnest(array['approval', 'report']) m
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 2. SỬA CHỨNG TỪ Ở MỌI TRẠNG THÁI
-- =====================================================================

/* Lưu nội dung chứng từ bất kể trạng thái (trừ đã huỷ). Không đổi trạng thái,
   bước duyệt hay chữ ký — chỉ nội dung. Ghi "admin_edit" vào lịch sử; bảng
   pm_doc có trigger nhật ký nên bản trước / sau cũng được giữ. */
create or replace function pm_doc_admin_save(p_id bigint, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc;
begin
  perform app_require('override', 'edit');
  select * into d from pm_doc where id = p_id for update;
  if d.id is null then raise exception 'Không có chứng từ % / No document %', p_id, p_id; end if;
  if d.status = 'cancelled' then
    raise exception 'Chứng từ % đã huỷ. / Document % is cancelled.', d.doc_no, d.doc_no;
  end if;
  update pm_doc
     set data = coalesce(p_data, '{}'::jsonb),
         total_value = nullif(p_data ->> 'total', '')::numeric,
         updated_at = now()
   where id = p_id;
  perform pm_doc_log(p_id, 'admin_edit', d.status, d.status, d.current_step, null);
end $$;

/* Mở lại CẢ BỘ hồ sơ chứa chứng từ này thành nháp: xoá chuỗi duyệt của lần
   gửi này, để người lập sửa và gửi lại (PA / MC về nháp cho AM). Các mốc đã
   đẩy sang dự án khi duyệt xong KHÔNG tự lùi lại. */
create or replace function pm_doc_admin_reopen(p_id bigint, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; k pm_pkg;
begin
  perform app_require('override', 'edit');
  select * into d from pm_doc where id = p_id;
  if d.id is null then raise exception 'Không có chứng từ % / No document %', p_id, p_id; end if;
  select * into k from pm_pkg where id = d.pkg_id for update;
  if k.status in ('draft', 'cancelled') then
    raise exception 'Bộ hồ sơ đang "%" — không cần mở lại. / Package is "%".', k.status, k.status;
  end if;
  delete from pm_pkg_step where pkg_id = k.id;
  update pm_pkg set status = 'draft', current_step = null, returned_to = null, decided_at = null, updated_at = now() where id = k.id;
  update pm_doc set status = 'draft', decided_at = null, updated_at = now() where pkg_id = k.id and status <> 'cancelled';
  perform pm_pkg_log(k.id, 'admin_reopen', k.status, 'draft', null, p_comment);
end $$;


-- =====================================================================
-- 3. ĐẶT LẠI DỮ LIỆU THỬ
-- =====================================================================

/* p_groups: những nhóm cần xoá —
     docs        chứng từ mua sắm + chuỗi duyệt + lịch sử + thông báo của chúng
     payments    hoá đơn, thanh toán, phân bổ, lịch sử nạp file kế toán
     projects    dự án (kéo theo chứng từ, điểm nhà thầu, phân bổ thanh toán)
     budget      các vòng ngân sách và dòng ngân sách (giữ thiết lập năm: tỷ giá, trần)
     vendors     danh sách nhà cung cấp
     notices     thông báo (chuông)
     signatures  chữ ký mẫu đã lưu
     assets      tài sản nhập qua app (KHÔNG xoá sổ cũ Beetrack), đợt hàng,
                 biên bản tem nhãn; bộ đếm mã kéo về ngang sổ còn lại
     audit       nhật ký thay đổi (làm cuối cùng)
   p_dry = true: chỉ đếm, không xoá — màn hình dùng để xem trước. */
create or replace function app_reset_data(p_groups text[], p_dry boolean default true)
returns table (grp text, tbl text, n bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  g  text;
  c  bigint;
  ok text[] := array['docs', 'payments', 'projects', 'budget', 'vendors', 'notices', 'signatures', 'assets', 'audit'];
begin
  perform app_require('override', 'admin');
  if exists (select 1 from unnest(p_groups) x where x <> all(ok)) then
    raise exception 'Nhóm không hợp lệ: % / Unknown group', array_to_string(p_groups, ', ');
  end if;

  -- Đếm (và xoá khi p_dry = false), theo thứ tự khoá ngoại cho phép.
  foreach g in array ok loop
    continue when not (g = any(p_groups));
    if g = 'docs' then
      select count(*) into c from pm_doc;               grp := g; tbl := 'pm_doc'; n := c; return next;
      select count(*) into c from pm_pkg;               grp := g; tbl := 'pm_pkg'; n := c; return next;
      if not p_dry then delete from pm_pkg; delete from pm_doc; end if;   -- bước duyệt, lịch sử, thông báo đi theo (on delete cascade)
    elsif g = 'payments' then
      select count(*) into c from pm_pay_alloc;         grp := g; tbl := 'pm_pay_alloc'; n := c; return next;
      select count(*) into c from pm_invoice;           grp := g; tbl := 'pm_invoice'; n := c; return next;
      select count(*) into c from pm_payment;           grp := g; tbl := 'pm_payment'; n := c; return next;
      select count(*) into c from pm_pay_import;        grp := g; tbl := 'pm_pay_import'; n := c; return next;
      if not p_dry then
        delete from pm_pay_alloc; delete from pm_invoice; delete from pm_payment; delete from pm_pay_import;
      end if;
    elsif g = 'projects' then
      select count(*) into c from pm_project;           grp := g; tbl := 'pm_project'; n := c; return next;
      select count(*) into c from pm_vendor_score;      grp := g; tbl := 'pm_vendor_score'; n := c; return next;
      if not p_dry then delete from pm_vendor_score; delete from pm_pay_alloc; delete from pm_pkg; delete from pm_doc; delete from pm_project; end if;
    elsif g = 'budget' then
      select count(*) into c from pm_budget_line;       grp := g; tbl := 'pm_budget_line'; n := c; return next;
      select count(*) into c from pm_budget_round;      grp := g; tbl := 'pm_budget_round'; n := c; return next;
      if not p_dry then delete from pm_budget_line; delete from pm_budget_round; end if;
    elsif g = 'vendors' then
      select count(*) into c from pm_vendor;            grp := g; tbl := 'pm_vendor'; n := c; return next;
      if not p_dry then delete from pm_vendor; end if;
    elsif g = 'notices' then
      select count(*) into c from pm_notice;            grp := g; tbl := 'pm_notice'; n := c; return next;
      if not p_dry then delete from pm_notice; end if;
    elsif g = 'signatures' then
      select count(*) into c from pm_signature;         grp := g; tbl := 'pm_signature'; n := c; return next;
      if not p_dry then delete from pm_signature; end if;
    elsif g = 'assets' then
      select count(*) into c from am_asset where not is_legacy; grp := g; tbl := 'am_asset'; n := c; return next;
      select count(*) into c from am_shipment;          grp := g; tbl := 'am_shipment'; n := c; return next;
      select count(*) into c from am_alr;               grp := g; tbl := 'am_alr'; n := c; return next;
      if not p_dry then
        delete from am_alr_line; delete from am_alr;
        update am_asset set shipment_id = null where is_legacy and shipment_id is not null;
        delete from am_asset where not is_legacy;
        delete from am_shipment;                           -- dòng đợt hàng đi theo (on delete cascade)
        perform am_reseed_counters(true);                  -- bộ đếm về ngang sổ còn lại
      end if;
    elsif g = 'audit' then
      select count(*) into c from app_audit;            grp := g; tbl := 'app_audit'; n := c; return next;
      if not p_dry then delete from app_audit; end if;
    end if;
  end loop;
end $$;


-- =====================================================================
-- 4. QUYỀN GỌI HÀM — mỗi hàm tự kiểm tra quyền ở dòng đầu
-- =====================================================================

revoke execute on function pm_doc_admin_save(bigint, jsonb), pm_doc_admin_reopen(bigint, text),
                           app_reset_data(text[], boolean)
  from public, anon;
grant execute on function pm_doc_admin_save(bigint, jsonb), pm_doc_admin_reopen(bigint, text),
                          app_reset_data(text[], boolean)
  to authenticated;
-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 5. KIỂM CHỨNG
-- =====================================================================

select 'Khu quyền override' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   app_module where code = 'override'
union all
select 'System Admin có quyền đặt lại', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   app_permission where role_code = 'SYS_ADMIN' and module_code = 'override' and can_admin
union all
select 'Vai trò Người sửa nội dung', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   app_role where code = 'CONTENT_EDITOR'
union all
select 'Người sửa nội dung KHÔNG đặt lại được (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   app_permission where role_code = 'CONTENT_EDITOR' and module_code = 'override' and can_admin
union all
select 'Khách (anon) gọi được hàm quản trị (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('app_reset_data', 'pm_doc_admin_save', 'pm_doc_admin_reopen')
  and  has_function_privilege('anon', oid, 'execute');


-- ####################################################################
-- ##  23_pm_pkg_merge.sql
-- ####################################################################

-- =====================================================================
-- 23_pm_pkg_merge.sql — GỘP BỘ HỒ SƠ BỊ TÁCH
--
-- Chạy SAU 22_admin_tools.sql. Chạy lại nhiều lần vô hại.
--
--   Khi chuyển sang mô hình bộ hồ sơ (19_pm_workflow.sql), mỗi chứng từ lập
--   từ trước được gói thành MỘT BỘ RIÊNG mang tên loại của nó (bộ "RR", bộ
--   "PA"…). Vì vậy PR và RR của cùng một dự án nằm ở hai bộ khác nhau: màn
--   hình chứng từ không có chấm tròn PR · RR · PA để chuyển qua lại, và RR
--   đi duyệt một mình.
--
--   File này gộp chúng lại: với mỗi dự án, mọi bộ còn hiệu lực thuộc cùng
--   nhóm (PR + RR + PA; QC + MC) dồn vào MỘT bộ — bộ đang chứa PR (QC), nếu
--   không có thì bộ lập sớm nhất. Lịch sử của các bộ được gộp giữ lại.
--   Bộ sau khi gộp:
--     - mọi chứng từ đã duyệt xong  → giữ nguyên "đã duyệt";
--     - còn lại (nháp / đang duyệt / trả về) → về NHÁP, người lập gửi lại cả
--       bộ một lần (chuỗi duyệt cũ của RR riêng lẻ không dùng tiếp được).
--
-- Chỉ đụng tới pm_pkg, pm_pkg_step, pm_pkg_event, pm_doc (và thông báo của
-- các bộ bị gộp, xoá theo khoá ngoại). Không quét bảng theo mẫu tên.
-- =====================================================================

do $$
declare
  r      record;
  v_tgt  bigint;
  v_ok   boolean;
  v_n    int := 0;
begin
  -- Các (dự án, nhóm) có bộ mang tên một loại THÀNH VIÊN của nhóm (RR, PA, MC…)
  -- hoặc có nhiều hơn một bộ còn hiệu lực trong cùng nhóm.
  for r in
    select k.project_code, coalesce(t.grp, k.grp) as grp
      from pm_pkg k
      left join pm_doc_type t on t.code = k.grp
     where k.status not in ('cancelled', 'rejected')
       and coalesce(t.grp, k.grp) in (select grp from pm_doc_type where grp is not null)
     group by k.project_code, coalesce(t.grp, k.grp)
    having count(*) > 1 or bool_or(k.grp <> coalesce(t.grp, k.grp))
  loop
    -- Bộ giữ lại: bộ chứa chứng từ dẫn chuỗi (PR / QC), nếu không thì bộ sớm nhất.
    select k.id into v_tgt
      from pm_pkg k
     where k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp))
     order by exists (select 1 from pm_doc d where d.pkg_id = k.id and d.doc_type = pm_grp_lead(r.grp)
                                               and d.status not in ('cancelled', 'rejected')) desc,
              k.id
     limit 1;

    -- Chứng từ và lịch sử của các bộ còn lại chuyển sang bộ giữ lại.
    update pm_doc d set pkg_id = v_tgt
      from pm_pkg k
     where d.pkg_id = k.id and k.id <> v_tgt
       and k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp));
    update pm_pkg_event e set pkg_id = v_tgt
      from pm_pkg k
     where e.pkg_id = k.id and k.id <> v_tgt
       and k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp));
    -- Các bộ đã rỗng (bước duyệt và thông báo của chúng xoá theo khoá ngoại).
    delete from pm_pkg k
     where k.id <> v_tgt
       and k.project_code = r.project_code
       and k.status not in ('cancelled', 'rejected')
       and (k.grp = r.grp or k.grp in (select code from pm_doc_type where grp = r.grp))
       and not exists (select 1 from pm_doc d where d.pkg_id = k.id);

    select coalesce(bool_and(d.status = 'approved'), false) into v_ok
      from pm_doc d where d.pkg_id = v_tgt and d.status not in ('cancelled', 'rejected');

    if v_ok then
      update pm_pkg set grp = r.grp, updated_at = now() where id = v_tgt;
    else
      delete from pm_pkg_step where pkg_id = v_tgt;
      update pm_pkg set grp = r.grp, status = 'draft', current_step = null, returned_to = null,
                        submitted_at = null, decided_at = null, updated_at = now()
       where id = v_tgt;
      update pm_doc set status = 'draft', current_step = null
       where pkg_id = v_tgt and status in ('in_review', 'returned');
    end if;

    -- Không ghi to_status: thông báo (20_pm_notify.sql) không bắn ra cho việc gộp.
    insert into pm_pkg_event (pkg_id, actor_email, actor_name, action, comment)
    values (v_tgt, 'sql:' || session_user, 'Hệ thống', 'merged',
            'Gộp các chứng từ của nhóm ' || r.grp || ' vào một bộ hồ sơ (23_pm_pkg_merge.sql).');
    v_n := v_n + 1;
  end loop;
  raise notice 'Đã gộp % bộ hồ sơ.', v_n;
end $$;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- KIỂM CHỨNG
-- =====================================================================

select 'Bộ mang tên loại thành viên (RR, PA, MC…) còn lại (phải = 0)' as "Mục", count(*)::text as "Thực tế", '0' as "Mong đợi",
       case when count(*) = 0 then '✔' else '✘ HỎNG' end as "Đạt"
from   pm_pkg k join pm_doc_type t on t.code = k.grp
where  t.grp is not null and t.grp <> k.grp and k.status not in ('cancelled', 'rejected')
union all
select 'Dự án có hơn một bộ PR / QC còn hiệu lực (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from  (select project_code, grp from pm_pkg
        where status not in ('cancelled', 'rejected') and grp in (select grp from pm_doc_type where grp is not null)
        group by project_code, grp having count(*) > 1) x
union all
select 'Chứng từ không thuộc bộ nào (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pm_doc where pkg_id is null;


-- ####################################################################
-- ##  24_ui_feedback.sql
-- ####################################################################

-- =====================================================================
-- 24_ui_feedback.sql — THAY ĐỔI THEO GÓP Ý GIAO DIỆN VÀ FORM (25/09/2026)
--
-- Chạy SAU 23_pm_pkg_merge.sql. Chạy lại nhiều lần vô hại.
--
--   1. Nhà cung cấp: thêm cột e-mail.
--   2. Dự án NGOÀI ngân sách: đổi mã bộ phận / số dự án / năm ngay trên PR thì
--      mã dự án đổi theo (FFE.KIT.05.2026 → FFE.ENG.07.2026), số hiệu mọi
--      chứng từ của dự án cũng đổi theo (PR.KIT.05.2026 → PR.ENG.07.2026).
--      Chỉ khi chưa có chứng từ nào gửi duyệt.
--   3. Công tắc (Cài đặt, người sửa được cấu hình hệ thống): hiện hay ẩn mục
--      Lịch sử ở màn hình chứng từ.
--
-- Chỉ đụng tới bảng được nêu tên ở dưới — project Supabase dùng chung với các
-- app khác, không quét bảng theo mẫu tên.
-- =====================================================================

-- 1. ------------------------------------------------------------------
alter table pm_vendor add column if not exists email text;
comment on column pm_vendor.email is 'E-mail liên hệ của nhà cung cấp.';

-- 2. ------------------------------------------------------------------
/* Đổi mã một dự án ngoài ngân sách. Mã mới = đoạn đầu cũ (FFE) . bộ phận .
   số (2 chữ số) . năm [. đoạn con cũ nếu có]. Các bảng tham chiếu mã dự án bằng
   khoá ngoại (chứng từ, bộ hồ sơ, điểm nhà thầu, phân bổ thanh toán) đổi theo
   nhờ ON UPDATE CASCADE; số hiệu chứng từ và thông báo được sửa ở đây. */
create or replace function pm_project_recode(p_code text, p_dept text, p_no int, p_year int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p     pm_project;
  v_seg text[];
  v_new text;
  v_mid text;
  v_tail_old text;
  v_tail_new text;
begin
  select * into p from pm_project where code = p_code for update;
  if p.code is null then raise exception 'Không có dự án %.', p_code; end if;
  if p.budgeted then
    raise exception 'Chỉ đổi mã được với dự án ngoài ngân sách — mã dự án trong ngân sách theo file ngân sách.';
  end if;
  if not (app_trusted() or app_can('project', 'admin') or pm_can_prepare('PR', p.dept_code)) then
    raise exception 'Bạn không có quyền đổi mã dự án %.', p.code using errcode = '42501';
  end if;
  if exists (select 1 from pm_doc where project_code = p.code and status not in ('draft', 'returned', 'cancelled')) then
    raise exception 'Dự án % đã có chứng từ gửi duyệt — không đổi mã được nữa.', p.code;
  end if;
  if not exists (select 1 from am_org where code = upper(trim(p_dept)) and is_department) then
    raise exception 'Không có bộ phận %.', p_dept;
  end if;
  if p_no is null or p_no < 1 or p_no > 999 then raise exception 'Số dự án không hợp lệ.'; end if;
  if p_year is null or p_year < 2000 or p_year > 2099 then raise exception 'Năm không hợp lệ.'; end if;

  v_seg := string_to_array(p.code, '.');
  v_mid := v_seg[1] || '.' || upper(trim(p_dept)) || '.' || lpad(p_no::text, 2, '0') || '.' || p_year;
  v_new := v_mid || coalesce('.' || v_seg[5], '');
  if v_new = p.code then return v_new; end if;
  if exists (select 1 from pm_project where code = v_new) then
    raise exception 'Mã % đã có dự án khác dùng.', v_new;
  end if;

  update pm_project
     set code = v_new,
         main_code = case when main_code = p.code or array_length(v_seg, 1) = 4 then v_mid else main_code end,
         dept_code = upper(trim(p_dept)), year = p_year
   where code = p.code;

  -- Số hiệu chứng từ: tiền tố loại + phần sau đoạn đầu của mã dự án (+ "/n" nếu có).
  v_tail_old := substring(p.code from position('.' in p.code));
  v_tail_new := substring(v_new from position('.' in v_new));
  update pm_doc
     set doc_no = replace(doc_no, v_tail_old, v_tail_new), updated_at = now()
   where project_code = v_new;
  update pm_notice
     set doc_no = replace(doc_no, v_tail_old, v_tail_new), project_code = v_new
   where project_code = p.code;
  return v_new;
end $$;

revoke all on function pm_project_recode(text, text, int, int) from public;
grant execute on function pm_project_recode(text, text, int, int) to authenticated;

-- 3. ------------------------------------------------------------------
insert into am_setting (key, value, note) values
  ('pm_show_history', 'true', 'true = màn hình chứng từ hiện mục Lịch sử dưới form; false = ẩn.')
on conflict (key) do nothing;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- KIỂM CHỨNG
-- =====================================================================

select 'Cột e-mail của nhà cung cấp' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.columns
where  table_schema = 'public' and table_name = 'pm_vendor' and column_name = 'email'
union all
select 'Hàm đổi mã dự án ngoài ngân sách', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_project_recode'
union all
select 'Công tắc Lịch sử (pm_show_history)', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   am_setting where key = 'pm_show_history'
union all
select 'Khách (anon) gọi được hàm đổi mã (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where proname = 'pm_project_recode' and has_function_privilege('anon', oid, 'execute');


-- ####################################################################
-- ##  25_pm_tender.sql
-- ####################################################################

-- =====================================================================
-- 25_pm_tender.sql — PORTAL ĐẤU THẦU CHO NHÀ THẦU (26/09/2026)
--
-- Chạy SAU 24_ui_feedback.sql. Chạy lại nhiều lần vô hại.
--
--   Thu mua mở một ĐỢT ĐẤU THẦU cho một QC (hạng mục, số lượng, phạm vi công
--   việc = hồ sơ mời thầu, tiêu chí năng lực phải kê khai, hạn nộp) và gửi cho
--   từng nhà thầu MỘT ĐƯỜNG LINK RIÊNG (mã bí mật, có hạn dùng, thu hồi được;
--   một link có thể gắn với nhiều đợt đấu thầu). Không cần tài khoản.
--
--   Nhà thầu (qua link) điền đơn giá từng hạng mục, spec từng trường, các dòng
--   chi phí khác (overheads), điều khoản, kê khai năng lực, và tải lên báo giá
--   có đóng dấu + tài liệu liên quan. Được LƯU NHÁP và sửa; đã NỘP thì không
--   rút lại được — muốn đổi phải tạo BẢN MỚI (yêu cầu thay thế).
--
--   HỒ SƠ NIÊM PHONG: không ai trong khách sạn xem được nội dung / tệp của hồ
--   sơ đã nộp cho tới khi ĐỦ BA người đồng ý mở trong cùng một lượt: người lập
--   QC (Thu mua), Trưởng bộ phận, Trưởng bộ phận tài chính (theo chuỗi duyệt QC
--   của pháp nhân: bước 0, 1, 2). Bản thay thế (v2…) nộp sau lượt mở chỉ được
--   xem khi có lượt đồng ý mới đủ ba người. QC bị từ chối → Thu mua MỞ LẠI đợt
--   (vòng mới) để nhà thầu nộp lại.
--
--   Tệp: Supabase Storage, bucket riêng "pm-tender", mỗi hồ sơ một thư mục có
--   khoá ngẫu nhiên. Khách chỉ TẢI LÊN được (vào thư mục của hồ sơ nháp còn hạn),
--   không xem / liệt kê / xoá được gì. Người trong khách sạn chỉ xem được tệp của
--   hồ sơ ĐÃ MỞ.
--
-- An toàn cho project Supabase dùng chung:
--   - bảng pm_tender_* không cấp cho anon (app_lock_anon() ở cuối) và KHÔNG cấp
--     SELECT trực tiếp cho authenticated — đọc qua hàm có kiểm tra;
--   - hàm cho nhà thầu mang tiền tố vp_ (app_lock_anon chỉ khoá am_/app_/pm_),
--     mỗi hàm tự kiểm tra mã link; chỉ các hàm vp_ được cấp cho anon;
--   - Storage: chỉ bucket "pm-tender", chính sách chỉ áp cho bucket đó.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_tender (
  id           bigserial primary key,
  project_code text not null references pm_project(code) on update cascade on delete cascade,
  qc_doc_id    bigint references pm_doc(id) on delete set null,
  title        text,
  scope        text,                           -- phạm vi công việc / hồ sơ mời thầu
  terms        text,                           -- chỉ dẫn, điều kiện chào giá
  items        jsonb not null default '[]',    -- [{item, qty, unit}]
  crit         jsonb not null default '[]',    -- tiêu chí kê khai [{label, grp: ability|technique}]
  deadline     timestamptz not null,
  status       text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  round        int  not null default 1,        -- vòng nộp (tăng khi mở lại cho nộp lại)
  open_seq     int  not null default 1,        -- lượt đồng ý mở hiện tại
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pm_tender_project_idx on pm_tender (project_code);

create table if not exists pm_tender_invitee (
  id           bigserial primary key,
  token_hash   text not null unique,           -- sha256 của mã trong link; mã gốc không lưu
  vendor_code  text,
  vendor_name  text not null,
  email        text,
  expires_at   timestamptz not null,
  revoked      boolean not null default false,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists pm_tender_invite (
  invitee_id bigint not null references pm_tender_invitee(id) on delete cascade,
  tender_id  bigint not null references pm_tender(id) on delete cascade,
  primary key (invitee_id, tender_id)
);

create table if not exists pm_tender_bid (
  id           bigserial primary key,
  tender_id    bigint not null references pm_tender(id) on delete cascade,
  invitee_id   bigint not null references pm_tender_invitee(id) on delete cascade,
  round        int  not null,
  version      int  not null,
  status       text not null default 'draft' check (status in ('draft', 'submitted', 'superseded')),
  data         jsonb not null default '{}',
  files        jsonb not null default '[]',    -- [{path, name, size, kind}]
  upload_key   uuid not null default gen_random_uuid(),
  note         text,                           -- lý do bản thay thế
  submitted_at timestamptz,
  opened_at    timestamptz,                    -- null = còn niêm phong
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tender_id, invitee_id, round, version)
);
create index if not exists pm_tender_bid_key_idx on pm_tender_bid (upload_key);

create table if not exists pm_tender_consent (
  tender_id bigint not null references pm_tender(id) on delete cascade,
  seq       int  not null,
  role_code text not null,
  user_id   uuid not null,
  user_name text,
  at        timestamptz not null default now(),
  primary key (tender_id, seq, role_code)
);

-- Nhật ký đợt đấu thầu (không chứa nội dung hồ sơ — hồ sơ niêm phong).
create table if not exists pm_tender_event (
  id        bigserial primary key,
  tender_id bigint not null references pm_tender(id) on delete cascade,
  at        timestamptz not null default now(),
  actor     text,
  action    text not null,
  detail    text
);

alter table pm_tender         enable row level security;
alter table pm_tender_invitee enable row level security;
alter table pm_tender_invite  enable row level security;
alter table pm_tender_bid     enable row level security;
alter table pm_tender_consent enable row level security;
alter table pm_tender_event   enable row level security;
-- Không có chính sách nào: không ai đọc / ghi thẳng được, chỉ qua các hàm dưới.
revoke all on pm_tender, pm_tender_invitee, pm_tender_invite, pm_tender_bid, pm_tender_consent, pm_tender_event
  from authenticated, anon;


-- =====================================================================
-- 2. HÀM DÙNG CHUNG (nội bộ)
-- =====================================================================

-- Ba vai trò phải đồng ý mở hồ sơ: bước 0, 1, 2 của chuỗi duyệt QC của pháp nhân
-- (SSP: Thu mua, Trưởng bộ phận, Trưởng bộ phận tài chính).
create or replace function pm_tender_open_roles(p_project text)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(c.role_code order by c.step), '{}')
  from   pm_project p
  join   pm_chain c on c.entity = pm_entity(p.dept_code) and c.doc_type = 'QC' and c.step <= 2
  where  p.code = p_project
$$;

create or replace function pm_tender_log(p_tender bigint, p_actor text, p_action text, p_detail text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into pm_tender_event (tender_id, actor, action, detail) values (p_tender, p_actor, p_action, p_detail)
$$;

-- Người trong khách sạn được quản lý đợt đấu thầu của dự án: người lập QC hoặc quản trị dự án.
create or replace function pm_tender_can_manage(p_project text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_trusted() or app_can('project', 'admin')
      or coalesce((select pm_can_prepare('QC', p.dept_code) from pm_project p where p.code = p_project), false)
$$;

-- Mã trong link → người được mời (còn hạn, chưa thu hồi); sai thì báo lỗi chung.
create or replace function vp_invitee(p_token text)
returns pm_tender_invitee
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee;
begin
  select * into v from pm_tender_invitee
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if v.id is null or v.revoked or v.expires_at < now() then
    raise exception 'Đường link không hợp lệ hoặc đã hết hạn. / This link is not valid or has expired.' using errcode = '28000';
  end if;
  update pm_tender_invitee set last_seen_at = now() where id = v.id;
  return v;
end $$;

-- Đợt đấu thầu mà người được mời có quyền vào, còn nhận hồ sơ (đang mở, chưa quá hạn).
create or replace function vp_tender_for(p_inv bigint, p_tender bigint, p_write boolean)
returns pm_tender
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender;
begin
  select t2.* into t from pm_tender t2 join pm_tender_invite i on i.tender_id = t2.id
   where t2.id = p_tender and i.invitee_id = p_inv;
  if t.id is null then raise exception 'Không có đợt đấu thầu này. / No such tender.'; end if;
  if p_write and (t.status <> 'open' or t.deadline < now()) then
    raise exception 'Đợt đấu thầu đã đóng hoặc quá hạn nộp. / The tender is closed or past its deadline.';
  end if;
  return t;
end $$;


-- =====================================================================
-- 3. HÀM CHO NHÀ THẦU (anon, qua link)
-- =====================================================================

-- Mọi thứ nhà thầu cần thấy: các đợt được mời, hồ sơ của CHÍNH MÌNH.
create or replace function vp_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; r jsonb;
begin
  v := vp_invitee(p_token);
  select jsonb_build_object(
    'vendor', v.vendor_name, 'email', v.email, 'expires_at', v.expires_at,
    'tenders', coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'project_code', t.project_code, 'project_name', p.name,
      'scope', t.scope, 'terms', t.terms, 'items', t.items, 'crit', t.crit,
      'deadline', t.deadline, 'status', t.status, 'round', t.round,
      'accepting', t.status = 'open' and t.deadline >= now(),
      'bids', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', b.id, 'round', b.round, 'version', b.version, 'status', b.status,
                  'data', b.data, 'files', b.files, 'note', b.note, 'submitted_at', b.submitted_at)
                  order by b.round, b.version), '[]')
               from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id)
    ) order by t.deadline), '[]'))
  into r
  from pm_tender_invite i join pm_tender t on t.id = i.tender_id join pm_project p on p.code = t.project_code
  where i.invitee_id = v.id and t.status <> 'cancelled';
  return r;
end $$;

-- Lưu nháp. Chỉ sửa được bản NHÁP của vòng hiện tại; chưa có thì tạo bản 1.
create or replace function vp_save(p_token text, p_tender bigint, p_data jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  if octet_length(coalesce(p_data, '{}')::text) > 500000 then raise exception 'Nội dung quá lớn. / Too much data.'; end if;
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round
   order by version desc limit 1;
  if b.id is null then
    insert into pm_tender_bid (tender_id, invitee_id, round, version, data)
    values (t.id, v.id, t.round, 1, coalesce(p_data, '{}')) returning * into b;
    perform pm_tender_log(t.id, v.vendor_name, 'draft', 'v1');
    return b.id;
  end if;
  if b.status <> 'draft' then
    raise exception 'Hồ sơ đã nộp không sửa được — hãy tạo bản thay thế. / A submitted bid cannot be changed — create a replacement.';
  end if;
  update pm_tender_bid set data = coalesce(p_data, '{}'), updated_at = now() where id = b.id;
  return b.id;
end $$;

-- Bản thay thế: sau khi đã nộp, tạo bản nháp mới (chép nội dung và tệp của bản đã nộp).
create or replace function vp_new_version(p_token text, p_tender bigint, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid; n bigint;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round
   order by version desc limit 1;
  if b.id is null or b.status <> 'submitted' then
    raise exception 'Chỉ tạo bản thay thế sau khi đã nộp. / A replacement follows a submitted bid.';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Ghi lý do thay thế. / Give the reason for the replacement.'; end if;
  insert into pm_tender_bid (tender_id, invitee_id, round, version, data, files, note)
  values (t.id, v.id, t.round, b.version + 1, b.data, b.files, trim(p_reason)) returning id into n;
  perform pm_tender_log(t.id, v.vendor_name, 'replace', 'v' || (b.version + 1) || ': ' || trim(p_reason));
  return n;
end $$;

-- Nộp bản nháp: khoá lại, không rút được. Cần đủ đơn giá và báo giá có đóng dấu.
create or replace function vp_submit(p_token text, p_tender bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid; n int; i int;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if b.id is null then raise exception 'Chưa có bản nháp để nộp. / There is no draft to submit.'; end if;
  n := jsonb_array_length(t.items);
  for i in 0 .. n - 1 loop
    if coalesce(nullif(b.data -> 'prices' ->> i::text, ''), '0')::numeric <= 0 then
      raise exception 'Thiếu đơn giá hạng mục %. / Unit price missing for item %.', i + 1, i + 1;
    end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements(b.files) f where f ->> 'kind' = 'quotation') then
    raise exception 'Tải lên báo giá có đóng dấu trước khi nộp. / Upload the stamped quotation before submitting.';
  end if;
  update pm_tender_bid set status = 'submitted', submitted_at = now(), updated_at = now() where id = b.id;
  -- Bản trước (đã nộp) của cùng vòng: được thay thế.
  update pm_tender_bid set status = 'superseded', updated_at = now()
   where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'submitted' and id <> b.id;
  perform pm_tender_log(t.id, v.vendor_name, 'submit', 'v' || b.version);
end $$;

-- Tệp đã tải lên Storage: ghi vào hồ sơ nháp (đường dẫn phải nằm trong thư mục của hồ sơ).
create or replace function vp_file_add(p_token text, p_tender bigint, p_path text, p_name text, p_size bigint, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if b.id is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> b.upload_key::text or length(p_path) > 300 then
    raise exception 'Đường dẫn tệp không hợp lệ. / Invalid file path.';
  end if;
  if jsonb_array_length(b.files) >= 20 then raise exception 'Tối đa 20 tệp. / 20 files at most.'; end if;
  update pm_tender_bid
     set files = files || jsonb_build_array(jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, ''), 200),
                          'size', p_size, 'kind', case when p_kind = 'quotation' then 'quotation' else 'other' end)),
         updated_at = now()
   where id = b.id;
end $$;

create or replace function vp_file_remove(p_token text, p_tender bigint, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; b pm_tender_bid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select * into b from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if b.id is null then raise exception 'Hồ sơ đã nộp không sửa được. / A submitted bid cannot be changed.'; end if;
  update pm_tender_bid set files = coalesce((select jsonb_agg(f) from jsonb_array_elements(files) f where f ->> 'path' <> p_path), '[]'),
                           updated_at = now()
   where id = b.id;
end $$;

-- Thư mục tải lên của hồ sơ nháp (khoá ngẫu nhiên, chỉ trả cho đúng nhà thầu).
create or replace function vp_upload_key(p_token text, p_tender bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v pm_tender_invitee; t pm_tender; k uuid;
begin
  v := vp_invitee(p_token);
  t := vp_tender_for(v.id, p_tender, true);
  select upload_key into k from pm_tender_bid where tender_id = t.id and invitee_id = v.id and round = t.round and status = 'draft'
   order by version desc limit 1;
  if k is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  return k::text;
end $$;

-- Dùng trong chính sách Storage: khách chỉ tải lên vào thư mục của một hồ sơ NHÁP còn nhận hồ sơ.
create or replace function vp_upload_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from pm_tender_bid b
    join pm_tender t on t.id = b.tender_id
    join pm_tender_invitee v on v.id = b.invitee_id
    where b.upload_key::text = split_part(coalesce(p_name, ''), '/', 1)
      and b.status = 'draft' and t.status = 'open' and t.deadline >= now()
      and not v.revoked and v.expires_at >= now())
$$;


-- =====================================================================
-- 4. HÀM CHO NGƯỜI TRONG KHÁCH SẠN (authenticated, tự kiểm tra quyền)
-- =====================================================================

-- Mở đợt đấu thầu từ một QC: hạng mục và tiêu chí lấy từ QC.
create or replace function pm_tender_create(p_qc bigint, p_deadline timestamptz, p_title text, p_scope text, p_terms text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; n bigint; v_items jsonb; v_crit jsonb;
begin
  select * into d from pm_doc where id = p_qc and doc_type = 'QC';
  if d.id is null then raise exception 'Không có QC %.', p_qc; end if;
  if not pm_tender_can_manage(d.project_code) then raise exception 'Bạn không có quyền mở đấu thầu cho dự án này.' using errcode = '42501'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'Hạn nộp phải ở tương lai.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('item', l ->> 'item', 'qty', l -> 'qty', 'unit', l ->> 'unit')), '[]') into v_items
    from jsonb_array_elements(coalesce(d.data -> 'qlines', '[]')) l where coalesce(l ->> 'item', '') <> '';
  if jsonb_array_length(v_items) = 0 then raise exception 'QC chưa có hạng mục nào.'; end if;
  select coalesce(jsonb_agg(x), '[]') into v_crit from (
    select jsonb_build_object('label', s ->> 'label', 'grp', 'ability') x from jsonb_array_elements(coalesce(d.data -> 'sub_ability', '[]')) s where coalesce(s ->> 'label', '') <> ''
    union all
    select jsonb_build_object('label', s ->> 'label', 'grp', 'technique') from jsonb_array_elements(coalesce(d.data -> 'sub_technique', '[]')) s where coalesce(s ->> 'label', '') <> '') q;
  insert into pm_tender (project_code, qc_doc_id, title, scope, terms, items, crit, deadline, created_by)
  values (d.project_code, d.id, nullif(trim(p_title), ''), p_scope, p_terms, v_items, v_crit, p_deadline, auth.uid())
  returning id into n;
  perform pm_tender_log(n, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'create', to_char(p_deadline, 'YYYY-MM-DD HH24:MI'));
  return n;
end $$;

-- Sửa đợt: hạn nộp (gia hạn để làm rõ), phạm vi, chỉ dẫn, đóng / huỷ.
create or replace function pm_tender_update(p_id bigint, p_deadline timestamptz, p_scope text, p_terms text, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_id for update;
  if t.id is null then raise exception 'Không có đợt đấu thầu %.', p_id; end if;
  if not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền sửa đợt đấu thầu này.' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('open', 'closed', 'cancelled') then raise exception 'Trạng thái không hợp lệ.'; end if;
  update pm_tender set deadline = coalesce(p_deadline, deadline), scope = coalesce(p_scope, scope), terms = coalesce(p_terms, terms),
                       status = coalesce(p_status, status), updated_at = now()
   where id = p_id;
  perform pm_tender_log(p_id, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'update',
                        concat_ws(' · ', to_char(p_deadline, 'YYYY-MM-DD HH24:MI'), p_status));
end $$;

-- Mở lại cho nộp lại (QC bị từ chối / lần 1 thất bại): vòng mới, hạn mới.
create or replace function pm_tender_reopen(p_id bigint, p_deadline timestamptz, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender;
begin
  select * into t from pm_tender where id = p_id for update;
  if t.id is null then raise exception 'Không có đợt đấu thầu %.', p_id; end if;
  if not pm_tender_can_manage(t.project_code) then raise exception 'Bạn không có quyền mở lại đợt đấu thầu này.' using errcode = '42501'; end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'Hạn nộp phải ở tương lai.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Ghi lý do mở lại.'; end if;
  update pm_tender set round = round + 1, status = 'open', deadline = p_deadline, updated_at = now() where id = p_id;
  perform pm_tender_log(p_id, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'reopen', trim(p_reason));
end $$;

-- Mời một nhà thầu vào một hoặc nhiều đợt: trả về mã (chỉ MỘT lần — không lưu mã gốc).
create or replace function pm_tender_invite_add(p_tenders bigint[], p_vendor_code text, p_name text, p_email text, p_days int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_tok text; n bigint; t bigint;
begin
  if coalesce(array_length(p_tenders, 1), 0) = 0 then raise exception 'Chọn ít nhất một đợt đấu thầu.'; end if;
  foreach t in array p_tenders loop
    if not exists (select 1 from pm_tender x where x.id = t and x.status = 'open' and pm_tender_can_manage(x.project_code)) then
      raise exception 'Đợt đấu thầu % không mở hoặc bạn không có quyền.', t using errcode = '42501';
    end if;
  end loop;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nhập tên nhà thầu.'; end if;
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into pm_tender_invitee (token_hash, vendor_code, vendor_name, email, expires_at, created_by)
  values (encode(extensions.digest(v_tok, 'sha256'), 'hex'), nullif(trim(p_vendor_code), ''), trim(p_name), nullif(trim(p_email), ''),
          now() + make_interval(days => greatest(1, least(coalesce(p_days, 14), 90))), auth.uid())
  returning id into n;
  insert into pm_tender_invite (invitee_id, tender_id) select n, unnest(p_tenders) on conflict do nothing;
  foreach t in array p_tenders loop
    perform pm_tender_log(t, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'invite', trim(p_name));
  end loop;
  return v_tok;
end $$;

-- Gia hạn / thu hồi link; tạo link mới (mã mới, link cũ hết hiệu lực).
create or replace function pm_tender_invite_set(p_invitee bigint, p_days int, p_revoke boolean, p_new_token boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_tok text;
begin
  if not exists (select 1 from pm_tender_invite i join pm_tender t on t.id = i.tender_id
                  where i.invitee_id = p_invitee and pm_tender_can_manage(t.project_code)) then
    raise exception 'Bạn không có quyền với link này.' using errcode = '42501';
  end if;
  if p_new_token then v_tok := encode(extensions.gen_random_bytes(24), 'hex'); end if;
  update pm_tender_invitee
     set expires_at = case when p_days is not null then now() + make_interval(days => greatest(1, least(p_days, 90))) else expires_at end,
         revoked = coalesce(p_revoke, revoked),
         token_hash = case when v_tok is not null then encode(extensions.digest(v_tok, 'sha256'), 'hex') else token_hash end
   where id = p_invitee;
  return v_tok;
end $$;

-- Đợt đấu thầu của một dự án, cho màn hình QC: KHÔNG có nội dung hồ sơ chưa mở.
create or replace function pm_tender_list(p_project text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r jsonb;
begin
  if not (app_trusted() or app_can('project', 'view')) then raise exception 'Bạn không có quyền xem dự án.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'qc_doc_id', t.qc_doc_id, 'title', t.title, 'scope', t.scope, 'terms', t.terms, 'items', t.items, 'crit', t.crit,
    'deadline', t.deadline, 'status', t.status, 'round', t.round, 'open_seq', t.open_seq, 'created_at', t.created_at,
    'can_manage', pm_tender_can_manage(t.project_code),
    'open_roles', to_jsonb(pm_tender_open_roles(t.project_code)),
    'consents', (select coalesce(jsonb_agg(jsonb_build_object('role', c.role_code, 'user', c.user_name, 'at', c.at)), '[]')
                 from pm_tender_consent c where c.tender_id = t.id and c.seq = t.open_seq),
    'invitees', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', v.id, 'vendor_code', v.vendor_code, 'name', v.vendor_name, 'email', v.email, 'expires_at', v.expires_at,
                   'revoked', v.revoked, 'last_seen_at', v.last_seen_at,
                   'bids', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'round', b.round, 'version', b.version, 'status', b.status,
                              'submitted_at', b.submitted_at, 'opened_at', b.opened_at, 'note', case when b.opened_at is not null then b.note end,
                              -- nội dung và tệp chỉ khi đã mở
                              'data', case when b.opened_at is not null then b.data end,
                              'files', case when b.opened_at is not null then b.files end) order by b.round, b.version), '[]')
                            from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id)) order by v.id), '[]')
                 from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id where i.tender_id = t.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor', e.actor, 'action', e.action, 'detail', e.detail) order by e.at), '[]')
               from pm_tender_event e where e.tender_id = t.id)
  ) order by t.id), '[]') into r
  from pm_tender t where t.project_code = p_project;
  return r;
end $$;

-- Các đợt đang mở mà người bấm quản lý được: để một link mời vào nhiều đợt cùng lúc.
create or replace function pm_tender_open_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'project_code', t.project_code, 'project_name', p.name,
                                               'title', t.title, 'deadline', t.deadline) order by t.deadline), '[]')
  from pm_tender t join pm_project p on p.code = t.project_code
  where t.status = 'open' and t.deadline >= now() and pm_tender_can_manage(t.project_code)
$$;

-- Đồng ý mở hồ sơ, theo MỘT vai trò của người bấm. Đủ ba vai trò trong lượt → mở mọi
-- hồ sơ đã nộp còn niêm phong, rồi sang lượt mới (bản thay thế nộp sau cần lượt mới).
create or replace function pm_tender_consent_give(p_tender bigint, p_role text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare t pm_tender; p pm_project; v_roles text[]; v_have int; v_sealed int; v_waiting int;
begin
  select * into t from pm_tender where id = p_tender for update;
  if t.id is null then raise exception 'Không có đợt đấu thầu %.', p_tender; end if;
  select * into p from pm_project where code = t.project_code;
  v_roles := pm_tender_open_roles(t.project_code);
  if not (p_role = any(v_roles)) then raise exception 'Vai trò % không thuộc nhóm đồng ý mở hồ sơ.', p_role; end if;
  if not app_user_role_covers(auth.uid(), p_role, p.dept_code) then
    raise exception 'Bạn không giữ vai trò % cho bộ phận %.', p_role, p.dept_code using errcode = '42501';
  end if;
  select count(*) into v_sealed from pm_tender_bid where tender_id = t.id and status in ('submitted', 'superseded') and opened_at is null;
  if v_sealed = 0 then raise exception 'Không có hồ sơ niêm phong nào để mở.'; end if;
  -- Trước hạn nộp chỉ mở được khi mọi nhà thầu được mời đã nộp ở vòng hiện tại.
  select count(*) into v_waiting from pm_tender_invite i join pm_tender_invitee v on v.id = i.invitee_id
   where i.tender_id = t.id and not v.revoked
     and not exists (select 1 from pm_tender_bid b where b.tender_id = t.id and b.invitee_id = v.id and b.round = t.round and b.status = 'submitted');
  if t.deadline > now() and v_waiting > 0 then
    raise exception 'Chưa tới hạn nộp và còn % nhà thầu chưa nộp — chưa mở được.', v_waiting;
  end if;
  -- Ba người khác nhau (trừ khi đang bật tự duyệt để thử nghiệm).
  if not pm_self_ok() and exists (select 1 from pm_tender_consent where tender_id = t.id and seq = t.open_seq and user_id = auth.uid() and role_code <> p_role) then
    raise exception 'Mỗi người chỉ đồng ý theo một vai trò — cần ba người khác nhau.';
  end if;
  insert into pm_tender_consent (tender_id, seq, role_code, user_id, user_name)
  values (t.id, t.open_seq, p_role, auth.uid(), coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
  on conflict (tender_id, seq, role_code) do nothing;
  perform pm_tender_log(t.id, coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), 'consent', p_role);
  select count(distinct role_code) into v_have from pm_tender_consent where tender_id = t.id and seq = t.open_seq and role_code = any(v_roles);
  if v_have >= coalesce(array_length(v_roles, 1), 3) then
    update pm_tender_bid set opened_at = now() where tender_id = t.id and status in ('submitted', 'superseded') and opened_at is null;
    update pm_tender set open_seq = open_seq + 1, updated_at = now() where id = t.id;
    perform pm_tender_log(t.id, 'system', 'opened', v_sealed || ' bid(s)');
    return 'opened';
  end if;
  return 'waiting';
end $$;

-- Dùng trong chính sách Storage: người trong khách sạn chỉ xem tệp của hồ sơ ĐÃ MỞ.
create or replace function pm_tender_file_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_can('project', 'view') and exists (
    select 1 from pm_tender_bid b
    where b.upload_key::text = split_part(coalesce(p_name, ''), '/', 1) and b.opened_at is not null)
$$;


-- =====================================================================
-- 5. QUYỀN GỌI HÀM
-- =====================================================================

revoke execute on function pm_tender_open_roles(text), pm_tender_log(bigint, text, text, text), pm_tender_can_manage(text),
                           vp_invitee(text), vp_tender_for(bigint, bigint, boolean) from public, anon, authenticated;
grant execute on function pm_tender_create(bigint, timestamptz, text, text, text), pm_tender_update(bigint, timestamptz, text, text, text),
                          pm_tender_reopen(bigint, timestamptz, text), pm_tender_invite_add(bigint[], text, text, text, int),
                          pm_tender_invite_set(bigint, int, boolean, boolean), pm_tender_list(text), pm_tender_open_list(),
                          pm_tender_consent_give(bigint, text), pm_tender_file_ok(text) to authenticated;
-- Chỉ các hàm vp_ công khai được cấp cho khách (anon): mỗi hàm tự kiểm tra mã link.
revoke execute on function vp_session(text), vp_save(text, bigint, jsonb), vp_new_version(text, bigint, text),
                           vp_submit(text, bigint), vp_file_add(text, bigint, text, text, bigint, text),
                           vp_file_remove(text, bigint, text), vp_upload_key(text, bigint), vp_upload_ok(text) from public;
grant execute on function vp_session(text), vp_save(text, bigint, jsonb), vp_new_version(text, bigint, text),
                          vp_submit(text, bigint), vp_file_add(text, bigint, text, text, bigint, text),
                          vp_file_remove(text, bigint, text), vp_upload_key(text, bigint), vp_upload_ok(text) to anon, authenticated;


-- =====================================================================
-- 6. STORAGE — bucket riêng "pm-tender", chính sách chỉ áp cho bucket này
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pm-tender', 'pm-tender', false, 20971520,
        array['application/pdf', 'image/png', 'image/jpeg',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
              'application/zip', 'application/x-zip-compressed'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pm_tender_upload on storage.objects;
create policy pm_tender_upload on storage.objects for insert to anon
  with check (bucket_id = 'pm-tender' and vp_upload_ok(name));
drop policy if exists pm_tender_read on storage.objects;
create policy pm_tender_read on storage.objects for select to authenticated
  using (bucket_id = 'pm-tender' and pm_tender_file_ok(name));

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 7. KIỂM CHỨNG
-- =====================================================================

select 'Bảng đấu thầu' as "Mục", count(*)::text as "Thực tế", '6' as "Mong đợi",
       case when count(*) = 6 then '✔' else '✘ HỎNG' end as "Đạt"
from   information_schema.tables
where  table_schema = 'public' and table_name in ('pm_tender', 'pm_tender_invitee', 'pm_tender_invite', 'pm_tender_bid', 'pm_tender_consent', 'pm_tender_event')
union all
select 'Khách (anon) đọc / ghi thẳng bảng đấu thầu (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee = 'anon' and table_name like 'pm\_tender%'
union all
-- Hồ sơ niêm phong: RLS bật và không có chính sách nào → không ai đọc thẳng được, kể cả khi bảng được cấp quyền.
select 'Chính sách đọc thẳng bảng đấu thầu (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'public' and tablename like 'pm\_tender%'
union all
select 'RLS bật trên bảng đấu thầu', count(*)::text, '6',
       case when count(*) = 6 then '✔' else '✘ HỎNG' end
from   pg_class c join pg_namespace s on s.oid = c.relnamespace
where  s.nspname = 'public' and c.relname like 'pm\_tender%' and c.relkind = 'r' and c.relrowsecurity
union all
select 'Khách gọi được hàm nội bộ / hàm pm_ (phải = 0)', count(*)::text, '0',
       case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where (proname like 'pm\_tender%' or proname in ('vp_invitee', 'vp_tender_for')) and has_function_privilege('anon', oid, 'execute')
union all
select 'Hàm vp_ công khai cho nhà thầu', count(*)::text, '8',
       case when count(*) = 8 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('vp_session', 'vp_save', 'vp_new_version', 'vp_submit', 'vp_file_add', 'vp_file_remove', 'vp_upload_key', 'vp_upload_ok')
  and  has_function_privilege('anon', oid, 'execute')
union all
select 'Bucket pm-tender (riêng tư)', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   storage.buckets where id = 'pm-tender' and not public
union all
select 'Chính sách Storage của bucket', count(*)::text, '2',
       case when count(*) = 2 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('pm_tender_upload', 'pm_tender_read');


-- ####################################################################
-- ##  26_alr_project.sql
-- ####################################################################

-- =====================================================================
-- 26_alr_project.sql — BIÊN BẢN BÀN GIAO TEM (AL) TRONG QUY TRÌNH DỰ ÁN (26/09/2026)
--
-- Chạy SAU 25_pm_tender.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Luồng (quyết định của người dùng 26/09/2026):
--   PO duyệt → NHẬN HÀNG từ PO (Thu mua hoặc Hotel Asset Manager): cấp mã tài
--   sản + mã vạch, tình trạng "Chờ duyệt" (120 tài sản mã vạch duy nhất / 119
--   tài sản cùng mã vạch), mỗi lần nhận là một ĐỢT GIAO HÀNG (am_shipment) gắn
--   với dự án và số PO
--   → AL — biên bản bàn giao tem cho đợt đó: lập bởi AM Coordinator, kiểm tra
--   bởi AM Executive, duyệt bởi Kế toán trưởng JVC, NHẬN bởi Hotel Asset Manager
--   → bộ phận dán tem, chụp 2 ảnh / tài sản (tem cận cảnh + toàn cảnh): ảnh lưu
--   trong app (Supabase Storage, bucket "am-photo") hoặc link OneDrive — cả hai
--   cách cùng dùng được để thử
--   → AH (Hotel Asset Manager lập, dòng hàng lấy từ AL) → AH duyệt: tài sản
--   của AH chuyển "Đang sử dụng" (1) / "Hoạt động" (20); AH cuối cùng còn xử lý
--   tài sản bị thay theo RR: Thanh lý → "Chờ thanh lí" (8 / 24), Dự phòng →
--   "Chưa được sử dụng" (2).
--
-- Chỉ đụng vào bảng / hàm có tên của app này (am_*, app_*, pm_*); không lệnh
-- nào áp cho cả schema. Cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. VAI TRÒ HOTEL ASSET MANAGER, QUYỀN NHẬN HÀNG
-- =====================================================================

insert into app_role (code, entity, name_en, name_vi, prepares, default_scope, sort) values
  ('HOTEL_AM', 'SSP', 'Hotel Asset Manager', 'Quản lý tài sản khách sạn', true, 'SOF', 55)
on conflict (code) do nothing;

-- Hotel Asset Manager: nhận hàng (tạo tài sản), lập AH, ký nhận AL.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select 'HOTEL_AM', m.code,
       true,
       m.code in ('assets', 'project'),
       m.code in ('assets', 'project'),
       m.code in ('project', 'approval'),
       false
from   app_module m where m.code in ('assets', 'master', 'budget', 'project', 'approval', 'payment', 'report')
on conflict (role_code, module_code) do nothing;

-- Thu mua nhận hàng từ PO: được tạo tài sản (chỉ thêm quyền, không bớt quyền nào đã chỉnh).
update app_permission set can_view = true, can_create = true
 where role_code = 'PURCHASING' and module_code = 'assets';
insert into app_permission (role_code, module_code, can_view, can_create)
values ('PURCHASING', 'assets', true, true)
on conflict (role_code, module_code) do nothing;


-- =====================================================================
-- 2. LOẠI CHỨNG TỪ AL VÀ CHUỖI KÝ
-- =====================================================================

-- Giữa PO (60) / CT (70) và AH (80). Không bắt buộc (dự án cũ không có), lập
-- nhiều lần (mỗi đợt giao hàng một AL). Là một bộ một chứng từ của riêng nó.
insert into pm_doc_type (code, prefix, side, seq, required, repeatable, name_en, name_vi)
values ('AL', 'AL', 'operator', 75, false, true, 'Asset Label Receipt', 'Biên bản bàn giao tem tài sản')
on conflict (code) do update
  set prefix = excluded.prefix, side = excluded.side, seq = excluded.seq, required = excluded.required,
      repeatable = excluded.repeatable, name_en = excluded.name_en, name_vi = excluded.name_vi;
update pm_doc_type set grp = null where code = 'AL';

-- Lập: AM Coordinator · kiểm tra: AM Executive · duyệt: Kế toán trưởng JVC ·
-- nhận: Hotel Asset Manager (cao ốc: Admin cao ốc; văn phòng JVC: Admin JVC).
-- "do nothing": chuỗi đã chỉnh ở màn Chuỗi phê duyệt thì giữ nguyên.
with chains(entity, roles) as (values
  ('SSP', array['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'HOTEL_AM']),
  ('CP',  array['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'CP_ADMIN']),
  ('JVC', array['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_ADMIN']))
insert into pm_chain (entity, doc_type, step, role_code, kind)
select c.entity, 'AL', r.ord - 1, r.role, case when r.role = 'AM_EXEC' then 'check' else 'approve' end
from   chains c, unnest(c.roles) with ordinality r(role, ord)
on conflict (entity, doc_type, step) do nothing;

-- AH của khách sạn do Hotel Asset Manager lập (chỉ đổi khi vẫn là mặc định cũ).
update pm_chain set role_code = 'HOTEL_AM'
 where entity = 'SSP' and doc_type = 'AH' and step = 0 and role_code = 'DEPT_STAFF';


-- =====================================================================
-- 3. ĐỢT GIAO HÀNG GẮN VỚI DỰ ÁN / PO; ALR GẮN VỚI CHỨNG TỪ AL
-- =====================================================================

alter table am_shipment add column if not exists project_code text;
alter table am_shipment add column if not exists po_doc_no    text;
create index if not exists am_shipment_project_idx on am_shipment (project_code);
comment on column am_shipment.project_code is
  'Dự án của đợt nhận hàng (nhận từ PO). Tài sản của đợt mang am_asset.shipment_id = id và purpose_code = mã dự án.';

alter table am_alr add column if not exists pm_doc_id bigint;
comment on column am_alr.pm_doc_id is
  'Chứng từ AL (pm_doc) sinh ra biên bản này khi được duyệt xong — để màn Biên bản tem thấy cả các AL của dự án.';


-- =====================================================================
-- 4. ẢNH TÀI SẢN SAU KHI DÁN TEM
-- =====================================================================

create table if not exists am_asset_photo (
  id           bigserial primary key,
  asset_id     bigint not null references am_asset(id) on delete cascade,
  kind         text not null check (kind in ('label', 'overall')),   -- tem cận cảnh · toàn cảnh
  source       text not null check (source in ('storage', 'link')),
  storage_path text,                                                 -- bucket am-photo
  url          text,                                                 -- link OneDrive / SharePoint
  pm_doc_id    bigint,                                               -- AL đang chụp cho (tham khảo)
  taken_by     uuid default auth.uid(),
  taken_name   text,
  taken_at     timestamptz not null default now(),
  constraint am_asset_photo_src_ck check ((source = 'storage' and storage_path is not null) or (source = 'link' and url ~* '^https://'))
);
create index if not exists am_asset_photo_asset_idx on am_asset_photo (asset_id);
comment on table am_asset_photo is
  'Ảnh bằng chứng đã dán tem: mỗi tài sản cần 1 ảnh tem cận cảnh (label) và 1 ảnh toàn cảnh (overall). Ảnh trong app hoặc link.';

alter table am_asset_photo enable row level security;
revoke all on am_asset_photo from anon;
grant select, insert, delete on am_asset_photo to authenticated;
grant usage, select on sequence am_asset_photo_id_seq to authenticated;
drop policy if exists am_asset_photo_read on am_asset_photo;
create policy am_asset_photo_read on am_asset_photo for select to authenticated
  using ((select app_can('assets', 'view')) or (select app_can('project', 'view')));
drop policy if exists am_asset_photo_add on am_asset_photo;
create policy am_asset_photo_add on am_asset_photo for insert to authenticated
  with check (((select app_can('assets', 'view')) or (select app_can('project', 'view'))) and taken_by = auth.uid());
drop policy if exists am_asset_photo_del on am_asset_photo;
create policy am_asset_photo_del on am_asset_photo for delete to authenticated
  using (taken_by = auth.uid() or (select app_can('assets', 'edit')));

do $$ begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    execute 'drop trigger if exists app_audit on am_asset_photo';
    execute 'create trigger app_audit after insert or update or delete on am_asset_photo for each row execute function app_audit_row()';
  end if;
end $$;

-- Bucket riêng, không công khai; ảnh đã thu nhỏ trong trình duyệt (≤ 8 MB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('am-photo', 'am-photo', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists am_photo_upload on storage.objects;
create policy am_photo_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'am-photo' and ((select app_can('assets', 'view')) or (select app_can('project', 'view'))));
drop policy if exists am_photo_read on storage.objects;
create policy am_photo_read on storage.objects for select to authenticated
  using (bucket_id = 'am-photo' and ((select app_can('assets', 'view')) or (select app_can('project', 'view'))));
drop policy if exists am_photo_delete on storage.objects;
create policy am_photo_delete on storage.objects for delete to authenticated
  using (bucket_id = 'am-photo' and (owner = auth.uid() or (select app_can('assets', 'edit'))));


-- =====================================================================
-- 5. KHI CHỨNG TỪ ĐƯỢC DUYỆT XONG (thay pm_doc_apply của 19_pm_workflow.sql)
-- =====================================================================

create or replace function pm_doc_apply(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d pm_doc; v jsonb; r jsonb; v_alr bigint; v_recv text; v_ids bigint[];
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
    end if;
  end if;
end $$;
revoke execute on function pm_doc_apply(bigint) from public, anon, authenticated;


-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Vai trò Hotel Asset Manager' as "Mục", count(*)::text as "Thực tế", '1' as "Mong đợi",
       case when count(*) = 1 then '✔' else '✘ HỎNG' end as "Đạt"
from   app_role where code = 'HOTEL_AM'
union all
select 'Loại chứng từ AL', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pm_doc_type where code = 'AL' and repeatable and not required
union all
select 'Chuỗi ký AL (SSP · CP · JVC, 4 bước mỗi pháp nhân)', count(*)::text, '12', case when count(*) >= 12 then '✔' else '✘ HỎNG' end
from   pm_chain where doc_type = 'AL'
union all
select 'Người lập AH khách sạn', coalesce(max(role_code), '—'), 'HOTEL_AM (hoặc vai trò đã chỉnh)', '✔'
from   pm_chain where entity = 'SSP' and doc_type = 'AH' and step = 0
union all
select 'Thu mua được nhận hàng (assets: tạo)', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   app_permission where role_code = 'PURCHASING' and module_code = 'assets' and can_create
union all
select 'Bảng ảnh tài sản có RLS', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   pg_class where relname = 'am_asset_photo' and relrowsecurity
union all
select 'Khách (anon) đọc bảng ảnh (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants where table_name = 'am_asset_photo' and grantee = 'anon'
union all
select 'Bucket am-photo (riêng tư)', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   storage.buckets where id = 'am-photo' and not public
union all
select 'Chính sách storage cho am-photo', count(*)::text, '3', case when count(*) = 3 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('am_photo_upload', 'am_photo_read', 'am_photo_delete')
union all
select 'Cột dự án / PO trên đợt giao hàng', count(*)::text, '2', case when count(*) = 2 then '✔' else '✘ HỎNG' end
from   information_schema.columns where table_name = 'am_shipment' and column_name in ('project_code', 'po_doc_no');


-- ####################################################################
-- ##  27_liquidation.sql
-- ####################################################################

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


-- ####################################################################
-- ##  28_liquidation_batch.sql
-- ####################################################################

-- =====================================================================
-- 28_liquidation_batch.sql — THANH LÝ TÀI SẢN, GIAI ĐOẠN 2: HỘI ĐỒNG VÀ ĐỢT
--                            THANH LÝ (26/09/2026)
--
-- Chạy SAU 27_liquidation.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
--   pm_lq_council  Quyết định thành lập Hội đồng thanh lý (vd L01/2026): số, ngày,
--                  link bản ký. Mỗi lúc một hội đồng ĐANG HIỆU LỰC; có QĐ mới thì
--                  thêm hội đồng mới — đợt cũ vẫn giữ hội đồng của nó.
--   pm_lq_member   Thành viên của từng hội đồng: họ tên, chức vụ (VN / EN), vai
--                  trò (chủ tịch / phó chủ tịch / thành viên thường trực hoặc
--                  không thường trực), tài khoản app (nếu có). Nhập trong app —
--                  tên người KHÔNG nằm trong file này (repo công khai).
--   pm_lq_batch    Đợt thanh lý L0x.yyyy: gom các món trong kho chờ thanh lý,
--                  đi qua các mốc
--                    open     đang lập danh sách, chuẩn bị họp
--                    decided  đã họp & ra Quyết định thanh lý (02, 03) — khoá danh sách
--                    counted  đã kiểm kê thực tế (04)
--                    valued   đã đánh giá lại giá trị còn lại (05) — sẵn sàng gọi báo giá
--                    bidding / closed  giai đoạn 3 (báo giá, mở thầu, kết quả, đóng đợt)
--   pm_lq_item     (27) thêm kết quả kiểm kê, giá trị đánh giá lại, ghi chú giữ lại.
--
-- Mọi thay đổi đợt và món đi qua hàm ở dưới (trình duyệt chỉ đọc hai bảng đó);
-- hội đồng / thành viên sửa thẳng trong app, quyền quản trị khu Thanh lý.
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

create table if not exists pm_lq_council (
  id            bigserial primary key,
  decision_no   text not null unique,
  decision_date date,
  active        boolean not null default true,
  file_url      text check (file_url is null or file_url ~* '^https://'),
  note          text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now()
);
create unique index if not exists pm_lq_council_one_active on pm_lq_council ((true)) where active;
comment on table pm_lq_council is 'Quyết định thành lập Hội đồng thanh lý. Chỉ một hội đồng đang hiệu lực (active).';

create table if not exists pm_lq_member (
  id          bigserial primary key,
  council_id  bigint not null references pm_lq_council(id) on delete cascade,
  sort        int  not null default 0,
  full_name   text not null,
  position_vi text,
  position_en text,
  role        text not null default 'member' check (role in ('chair', 'vice', 'member')),
  permanent   boolean not null default true,
  user_id     uuid references app_user(id) on delete set null
);
create index if not exists pm_lq_member_council_idx on pm_lq_member (council_id, sort);
comment on column pm_lq_member.permanent is 'Thành viên thường trực (true) hay không thường trực — tham gia theo chỉ định của chủ tịch hội đồng (false).';
comment on column pm_lq_member.user_id is 'Tài khoản app của thành viên (nếu có): để xác nhận có mặt / kiểm kê trên tablet.';

create table if not exists pm_lq_batch (
  id               bigserial primary key,
  code             text not null unique check (code ~ '^L\d{2,3}\.\d{4}$'),
  year             int  not null,
  council_id       bigint references pm_lq_council(id),
  status           text not null default 'open'
                   check (status in ('open', 'decided', 'counted', 'valued', 'bidding', 'closed', 'cancelled')),
  meeting_date     date,
  meeting_time     text,
  meeting_place    text,
  decision_date    date,
  count_date       date,
  valuation_date   date,
  liquidation_date date,
  data             jsonb not null default '{}'::jsonb,
  created_by       uuid default auth.uid(),
  created_name     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on column pm_lq_batch.data is
  'Nội dung biên bản họp: causes_vi / causes_en (nguyên nhân), plan_vi / plan_en (phương án), conclusion_vi / conclusion_en (kết luận thêm), note.';

alter table pm_lq_item add column if not exists count_found boolean;
alter table pm_lq_item add column if not exists count_qty   numeric(18, 3);
alter table pm_lq_item add column if not exists count_note  text;
alter table pm_lq_item add column if not exists count_by    uuid;
alter table pm_lq_item add column if not exists count_name  text;
alter table pm_lq_item add column if not exists count_at    timestamptz;
alter table pm_lq_item add column if not exists reval_value numeric(18, 2);
alter table pm_lq_item add column if not exists reval_note  text;
alter table pm_lq_item add column if not exists keep_note   text;
create index if not exists pm_lq_item_batch_idx on pm_lq_item (batch_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pm_lq_item_batch_fk') then
    alter table pm_lq_item add constraint pm_lq_item_batch_fk foreign key (batch_id) references pm_lq_batch(id) on delete set null;
  end if;
end $$;


-- =====================================================================
-- 2. HÀM
-- =====================================================================

create or replace function pm_lq_need_edit()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app_can('liquidation', 'edit') then
    raise exception 'Cần quyền sửa của khu Thanh lý. / Liquidation "edit" right required.' using errcode = '42501';
  end if;
end $$;

/* Số đợt kế tiếp trong năm. Quyết định thành lập hội đồng cũng lấy một số trong
   dãy (QĐ L01.2026 → đợt đầu là L02.2026), nên đếm cả hai. */
create or replace function pm_lq_batch_next(p_year int)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select 'L' || lpad((coalesce(max(n), 0) + 1)::text, 2, '0') || '.' || p_year
  from (
    select split_part(substr(code, 2), '.', 1)::int as n from pm_lq_batch where year = p_year
    union all
    select (regexp_match(decision_no, '^L(\d{1,3})[./](\d{4})$'))[1]::int
    from   pm_lq_council where (regexp_match(decision_no, '^L(\d{1,3})[./](\d{4})$'))[2] = p_year::text
  ) x
$$;

create or replace function pm_lq_batch_create(p_code text default null, p_data jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_year int; v_code text; v_id bigint;
begin
  perform pm_lq_need_edit();
  v_year := coalesce(extract(year from nullif(p_data ->> 'meeting_date', '')::date)::int, extract(year from current_date)::int);
  perform pg_advisory_xact_lock(hashtext('pm_lq_batch.' || v_year));
  v_code := coalesce(nullif(trim(p_code), ''), pm_lq_batch_next(v_year));
  if v_code !~ '^L\d{2,3}\.\d{4}$' then raise exception 'Số đợt phải dạng L02.2026. / Batch number must look like L02.2026.'; end if;
  if exists (select 1 from pm_lq_batch where code = v_code) then raise exception 'Đợt % đã có. / Batch % exists.', v_code, v_code; end if;
  insert into pm_lq_batch (code, year, council_id, meeting_date, meeting_time, meeting_place, data, created_name)
  values (v_code, split_part(v_code, '.', 2)::int,
          coalesce(nullif(p_data ->> 'council_id', '')::bigint, (select id from pm_lq_council where active limit 1)),
          nullif(p_data ->> 'meeting_date', '')::date, nullif(p_data ->> 'meeting_time', ''), nullif(p_data ->> 'meeting_place', ''),
          coalesce(p_data -> 'data', '{}'::jsonb), coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
  returning id into v_id;
  return v_id;
end $$;

-- Thông tin đợt (họp, các ngày, nội dung biên bản). Số đợt chỉ đổi được khi còn lập danh sách.
create or replace function pm_lq_batch_save(p_id bigint, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if b.status in ('closed', 'cancelled') then raise exception 'Đợt % đã %. / Batch is %.', b.code, b.status, b.status; end if;
  if p_patch ? 'code' and p_patch ->> 'code' <> b.code then
    if b.status <> 'open' then raise exception 'Chỉ đổi số đợt khi còn lập danh sách.'; end if;
    if (p_patch ->> 'code') !~ '^L\d{2,3}\.\d{4}$' then raise exception 'Số đợt phải dạng L02.2026.'; end if;
    if exists (select 1 from pm_lq_batch where code = p_patch ->> 'code') then raise exception 'Đợt % đã có.', p_patch ->> 'code'; end if;
  end if;
  update pm_lq_batch set
    code             = case when p_patch ? 'code' then p_patch ->> 'code' else code end,
    year             = case when p_patch ? 'code' then split_part(p_patch ->> 'code', '.', 2)::int else year end,
    council_id       = case when p_patch ? 'council_id' then nullif(p_patch ->> 'council_id', '')::bigint else council_id end,
    meeting_date     = case when p_patch ? 'meeting_date' then nullif(p_patch ->> 'meeting_date', '')::date else meeting_date end,
    meeting_time     = case when p_patch ? 'meeting_time' then nullif(p_patch ->> 'meeting_time', '') else meeting_time end,
    meeting_place    = case when p_patch ? 'meeting_place' then nullif(p_patch ->> 'meeting_place', '') else meeting_place end,
    decision_date    = case when p_patch ? 'decision_date' then nullif(p_patch ->> 'decision_date', '')::date else decision_date end,
    count_date       = case when p_patch ? 'count_date' then nullif(p_patch ->> 'count_date', '')::date else count_date end,
    valuation_date   = case when p_patch ? 'valuation_date' then nullif(p_patch ->> 'valuation_date', '')::date else valuation_date end,
    liquidation_date = case when p_patch ? 'liquidation_date' then nullif(p_patch ->> 'liquidation_date', '')::date else liquidation_date end,
    data             = case when p_patch ? 'data' then data || (p_patch -> 'data') else data end,
    updated_at       = now()
  where id = p_id;
end $$;

-- Thêm món từ kho (đang chờ, của LR đã duyệt) / trả món về kho. Chỉ khi đợt còn lập danh sách.
create or replace function pm_lq_batch_items(p_id bigint, p_add bigint[] default '{}', p_remove bigint[] default '{}')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; n int := 0; m int;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if b.status <> 'open' then raise exception 'Đợt % đã chốt danh sách. / The list of % is closed.', b.code, b.code; end if;
  update pm_lq_item i set batch_id = b.id, status = 'batched'
    from pm_doc d
   where d.id = i.lr_doc_id and d.status = 'approved'
     and i.id = any(coalesce(p_add, '{}')) and i.status = 'pool';
  get diagnostics n = row_count;
  update pm_lq_item set batch_id = null, status = 'pool', count_found = null, count_qty = null, count_note = null,
                        count_by = null, count_name = null, count_at = null, reval_value = null, reval_note = null, keep_note = null
   where batch_id = b.id and id = any(coalesce(p_remove, '{}')) and status in ('batched', 'kept');
  get diagnostics m = row_count;
  update pm_lq_batch set updated_at = now() where id = b.id;
  return n + m;
end $$;

/* Hội đồng GIỮ LẠI một món (không thanh lý) khi họp — ghi lý do. Món thôi thuộc
   danh sách của đợt; tình trạng tài sản trong sổ KHÔNG tự đổi (AM team đổi tay
   nếu cần). p_keep = false: đưa món lại vào danh sách. */
create or replace function pm_lq_keep(p_item bigint, p_keep boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null then raise exception 'Món chưa thuộc đợt nào.'; end if;
  if b.status <> 'open' then raise exception 'Đợt % đã chốt danh sách.', b.code; end if;
  if p_keep and coalesce(trim(p_note), '') = '' then raise exception 'Ghi lý do giữ lại. / Say why it is kept.'; end if;
  update pm_lq_item set status = case when p_keep then 'kept' else 'batched' end,
                        keep_note = case when p_keep then trim(p_note) end
   where id = p_item;
end $$;

-- Kiểm kê một món: có / không thấy, số lượng thực tế, ghi chú. Khi đợt đã ra QĐ (decided).
create or replace function pm_lq_count(p_item bigint, p_found boolean, p_qty numeric default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null or i.status <> 'batched' then raise exception 'Món không nằm trong danh sách của đợt nào.'; end if;
  if not (app_can('liquidation', 'edit')
          or exists (select 1 from pm_lq_member m where m.council_id = b.council_id and m.user_id = auth.uid())) then
    raise exception 'Chỉ AM team hoặc thành viên hội đồng mới kiểm kê được.' using errcode = '42501';
  end if;
  if b.status <> 'decided' then raise exception 'Kiểm kê khi đợt % đã ra Quyết định và chưa chốt kiểm kê. / Count after the decision.', b.code; end if;
  if p_found is null then
    update pm_lq_item set count_found = null, count_qty = null, count_note = null, count_by = null, count_name = null, count_at = null where id = p_item;
    return;
  end if;
  if p_qty is not null and p_qty < 0 then raise exception 'Số lượng không âm.'; end if;
  update pm_lq_item set count_found = p_found,
                        count_qty = case when p_found then coalesce(p_qty, qty) else 0 end,
                        count_note = nullif(trim(p_note), ''),
                        count_by = auth.uid(), count_name = coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'), count_at = now()
   where id = p_item;
end $$;

-- Giá trị còn lại đánh giá lại (giá sàn khi gọi báo giá). Khi đã kiểm kê xong (counted).
create or replace function pm_lq_reval(p_item bigint, p_value numeric, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare i pm_lq_item; b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into i from pm_lq_item where id = p_item for update;
  select * into b from pm_lq_batch where id = i.batch_id;
  if b.id is null or i.status <> 'batched' then raise exception 'Món không nằm trong danh sách của đợt nào.'; end if;
  if b.status <> 'counted' then raise exception 'Đánh giá lại khi đợt % đã kiểm kê xong và chưa chốt đánh giá. / Revalue after the count.', b.code; end if;
  if p_value is not null and p_value < 0 then raise exception 'Giá trị không âm.'; end if;
  update pm_lq_item set reval_value = p_value, reval_note = nullif(trim(p_note), '') where id = p_item;
end $$;

/* Chuyển mốc của đợt. Tiến:
     open → decided   có ít nhất một món, có hội đồng, có ngày họp
     decided → counted  mọi món đã kiểm kê (có / không thấy)
     counted → valued   mọi món có giá trị đánh giá lại
   Lùi một mốc để sửa (valued → counted → decided → open). Huỷ khi còn open:
   các món về kho. bidding / closed là của giai đoạn 3. */
create or replace function pm_lq_batch_move(p_id bigint, p_to text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_left int;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_id for update;
  if b.id is null then raise exception 'Không có đợt %', p_id; end if;
  if not ((b.status, p_to) in (('open', 'decided'), ('decided', 'counted'), ('counted', 'valued'),
                               ('decided', 'open'), ('counted', 'decided'), ('valued', 'counted'), ('open', 'cancelled'))) then
    raise exception 'Không chuyển được đợt % từ "%" sang "%".', b.code, b.status, p_to;
  end if;
  if p_to = 'decided' and b.status = 'open' then
    if not exists (select 1 from pm_lq_item where batch_id = b.id and status = 'batched') then raise exception 'Đợt chưa có món nào.'; end if;
    if b.council_id is null then raise exception 'Chọn hội đồng cho đợt trước.'; end if;
    if b.meeting_date is null then raise exception 'Nhập ngày họp hội đồng trước.'; end if;
    update pm_lq_batch set decision_date = coalesce(decision_date, meeting_date) where id = b.id;
  elsif p_to = 'counted' and b.status = 'decided' then
    select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and count_found is null;
    if v_left > 0 then raise exception 'Còn % món chưa kiểm kê. / % item(s) not counted yet.', v_left, v_left; end if;
    update pm_lq_batch set count_date = coalesce(count_date, current_date) where id = b.id;
  elsif p_to = 'valued' then
    select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and reval_value is null;
    if v_left > 0 then raise exception 'Còn % món chưa có giá trị đánh giá lại. / % item(s) not revalued yet.', v_left, v_left; end if;
    update pm_lq_batch set valuation_date = coalesce(valuation_date, current_date) where id = b.id;
  elsif p_to = 'cancelled' then
    update pm_lq_item set batch_id = null, status = 'pool', keep_note = null where batch_id = b.id and status in ('batched', 'kept');
  end if;
  update pm_lq_batch set status = p_to, updated_at = now() where id = b.id;
  return p_to;
end $$;


-- =====================================================================
-- 3. RLS
-- =====================================================================

alter table pm_lq_council enable row level security;
alter table pm_lq_member  enable row level security;
alter table pm_lq_batch   enable row level security;

drop policy if exists pm_lq_council_read on pm_lq_council;
create policy pm_lq_council_read on pm_lq_council for select to authenticated using ((select app_can('liquidation', 'view')));
drop policy if exists pm_lq_council_write on pm_lq_council;
create policy pm_lq_council_write on pm_lq_council for all to authenticated
  using ((select app_can('liquidation', 'admin'))) with check ((select app_can('liquidation', 'admin')));

drop policy if exists pm_lq_member_read on pm_lq_member;
create policy pm_lq_member_read on pm_lq_member for select to authenticated using ((select app_can('liquidation', 'view')));
drop policy if exists pm_lq_member_write on pm_lq_member;
create policy pm_lq_member_write on pm_lq_member for all to authenticated
  using ((select app_can('liquidation', 'admin'))) with check ((select app_can('liquidation', 'admin')));

drop policy if exists pm_lq_batch_read on pm_lq_batch;
create policy pm_lq_batch_read on pm_lq_batch for select to authenticated using ((select app_can('liquidation', 'view')));

-- Món thuộc một đợt: người thấy được đợt (AM team, hội đồng) thấy cả món, kể cả món của phòng ban khác.
drop policy if exists pm_lq_item_read on pm_lq_item;
create policy pm_lq_item_read on pm_lq_item
  for select to authenticated using (pm_lq_can_view(dept_code) or (batch_id is not null and (select app_can('liquidation', 'edit'))));

revoke all on pm_lq_council, pm_lq_member, pm_lq_batch from anon;
grant select, insert, update, delete on pm_lq_council, pm_lq_member to authenticated;
grant select on pm_lq_batch to authenticated;
revoke insert, update, delete on pm_lq_batch from authenticated;
grant usage, select on sequence pm_lq_council_id_seq, pm_lq_member_id_seq to authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    foreach t in array array['pm_lq_council', 'pm_lq_member', 'pm_lq_batch'] loop
      execute format('drop trigger if exists app_audit on %I', t);
      execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
    end loop;
  end if;
end $$;

revoke execute on function pm_lq_need_edit(), pm_lq_batch_next(int), pm_lq_batch_create(text, jsonb), pm_lq_batch_save(bigint, jsonb),
                           pm_lq_batch_items(bigint, bigint[], bigint[]), pm_lq_keep(bigint, boolean, text),
                           pm_lq_count(bigint, boolean, numeric, text), pm_lq_reval(bigint, numeric, text), pm_lq_batch_move(bigint, text)
  from public, anon;
grant execute on function pm_lq_need_edit(), pm_lq_batch_next(int), pm_lq_batch_create(text, jsonb), pm_lq_batch_save(bigint, jsonb),
                          pm_lq_batch_items(bigint, bigint[], bigint[]), pm_lq_keep(bigint, boolean, text),
                          pm_lq_count(bigint, boolean, numeric, text), pm_lq_reval(bigint, numeric, text), pm_lq_batch_move(bigint, text)
  to authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 4. KIỂM CHỨNG
-- =====================================================================

select 'Bảng hội đồng / thành viên / đợt có RLS' as "Mục", count(*)::text as "Thực tế", '3' as "Mong đợi",
       case when count(*) = 3 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pm_lq_council', 'pm_lq_member', 'pm_lq_batch') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng đợt (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name = 'pm_lq_batch' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Cột kiểm kê / đánh giá lại trên kho chờ thanh lý', count(*)::text, '3', case when count(*) = 3 then '✔' else '✘ Chạy 27_liquidation.sql trước' end
from   information_schema.columns where table_name = 'pm_lq_item' and column_name in ('count_found', 'count_qty', 'reval_value')
union all
select 'Hàm của đợt thanh lý', count(*)::text, '6', case when count(*) = 6 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pm_lq_batch_create', 'pm_lq_batch_save', 'pm_lq_batch_items', 'pm_lq_count', 'pm_lq_reval', 'pm_lq_batch_move')
union all
select 'Hội đồng đang hiệu lực (nhập ở app: Thanh lý → Hội đồng)', count(*)::text, '1',
       case when count(*) = 1 then '✔' else '⚠ Chưa có — nhập QĐ thành lập hội đồng trong app' end
from   pm_lq_council where active;


-- ####################################################################
-- ##  29_liquidation_bid.sql
-- ####################################################################

-- =====================================================================
-- 29_liquidation_bid.sql — THANH LÝ TÀI SẢN, GIAI ĐOẠN 3: GỌI BÁO GIÁ, MỞ THẦU,
--                          KẾT QUẢ, ĐÓNG ĐỢT (26/09/2026)
--
-- Chạy SAU 28_liquidation_batch.sql. Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
--   Đợt đã đánh giá lại (valued) → AM team MỞ GỌI BÁO GIÁ: hạn nộp, chỉ dẫn; mời
--   từng bên thu mua bằng MỘT ĐƯỜNG LINK RIÊNG (Liquidation.html — mã bí mật, có
--   hạn, thu hồi được; không cần tài khoản). Bên mua điền Thư báo giá: cá nhân
--   (CCCD) hay doanh nghiệp (MST, email nhận hoá đơn), đơn giá từng món, chi phí
--   thu gom; đính kèm thư báo giá đã ký nếu có. Sửa được tới khi hết hạn; đã nộp
--   thì NIÊM PHONG — trong khách sạn không ai xem được giá cho tới khi MỞ THẦU.
--
--   MỞ THẦU: khi đã quá hạn nộp (hoặc mọi bên được mời đã nộp), AM team ghi danh
--   thành viên Hội đồng CÓ MẶT — phải QUÁ 50% số thành viên; ít hơn 3 báo giá thì
--   bắt buộc giải trình. Kết quả: từng món chọn bên mua (app gợi ý giá cao nhất;
--   chọn khác phải ghi lý do) hoặc HUỶ (không bán được).
--
--   ĐÓNG ĐỢT: mỗi bên mua trúng phải có số hoá đơn GTGT và Gate pass đủ 3 chữ ký
--   (bên mua, bảo vệ, trưởng bộ phận). Đóng đợt thì tình trạng tài sản:
--     đã bán   → 7 "Đã thanh lí" (mã vạch duy nhất) · 23 "Thanh lý một phần" (cùng mã vạch)
--     huỷ      → 9 "Đã hủy" (mã vạch duy nhất)      · 23 (cùng mã vạch)
--     kiểm kê không thấy → 0 "Đã mất" (mã vạch duy nhất); cùng mã vạch giữ nguyên
--
-- An toàn cho project Supabase dùng chung (như 25_pm_tender.sql):
--   - bảng pm_lq_* không cấp cho anon (app_lock_anon cuối file), không có chính
--     sách đọc thẳng — người trong khách sạn đọc qua hàm có kiểm tra quyền;
--   - hàm cho bên mua mang tiền tố vq_, mỗi hàm tự kiểm tra mã link; chỉ các hàm
--     vq_ công khai được cấp cho anon;
--   - Storage: bucket riêng "pm-lqbid", chính sách chỉ áp cho bucket đó.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

alter table pm_lq_batch add column if not exists call_deadline timestamptz;
alter table pm_lq_batch add column if not exists call_terms    text;
alter table pm_lq_batch add column if not exists opened_at     timestamptz;
alter table pm_lq_batch add column if not exists open_note     text;
alter table pm_lq_batch add column if not exists closed_at     timestamptz;

alter table pm_lq_item drop constraint if exists pm_lq_item_status_check;
alter table pm_lq_item add constraint pm_lq_item_status_check
  check (status in ('pool', 'batched', 'sold', 'destroyed', 'kept', 'lost'));
alter table pm_lq_item add column if not exists outcome       text;
alter table pm_lq_item add column if not exists sale_quote_id bigint;
alter table pm_lq_item add column if not exists sale_price    numeric(18, 2);
alter table pm_lq_item add column if not exists sale_value    numeric(18, 2);
alter table pm_lq_item add column if not exists sale_cost     numeric(18, 2);
alter table pm_lq_item add column if not exists buyer         text;
alter table pm_lq_item add column if not exists buyer_id      text;
alter table pm_lq_item add column if not exists award_note    text;
alter table pm_lq_item drop constraint if exists pm_lq_item_outcome_check;
alter table pm_lq_item add constraint pm_lq_item_outcome_check check (outcome is null or outcome in ('sale', 'destroy'));

create table if not exists pm_lq_buyer (
  id           bigserial primary key,
  batch_id     bigint not null references pm_lq_batch(id) on delete cascade,
  token_hash   text not null unique,            -- sha256 của mã trong link; mã gốc không lưu
  name         text not null,
  phone        text,
  email        text,
  expires_at   timestamptz not null,
  revoked      boolean not null default false,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);
create index if not exists pm_lq_buyer_batch_idx on pm_lq_buyer (batch_id);

create table if not exists pm_lq_quote (
  id            bigserial primary key,
  batch_id      bigint not null references pm_lq_batch(id) on delete cascade,
  buyer_id      bigint not null unique references pm_lq_buyer(id) on delete cascade,
  status        text not null default 'draft' check (status in ('draft', 'submitted')),
  version       int  not null default 0,
  data          jsonb not null default '{}'::jsonb,
  files         jsonb not null default '[]'::jsonb,
  upload_key    uuid not null default gen_random_uuid(),
  submitted_at  timestamptz,
  opened_at     timestamptz,
  invoice_no    text,
  invoice_date  date,
  gate_date     date,
  gate_ok       boolean not null default false,
  handover_date date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists pm_lq_quote_key_idx on pm_lq_quote (upload_key);
comment on column pm_lq_quote.data is
  'Thư báo giá: kind person|company, name, id_no (CCCD), tax_code (MST), address, phone, email (nhận hoá đơn), representative, prices {item_id: đơn giá}, cost (chi phí thu gom), note, agree.';
comment on column pm_lq_quote.gate_ok is 'Gate pass đã đủ 3 chữ ký: bên mua, bảo vệ, trưởng bộ phận.';

create table if not exists pm_lq_attend (
  batch_id      bigint not null references pm_lq_batch(id) on delete cascade,
  member_id     bigint not null references pm_lq_member(id) on delete cascade,
  present       boolean not null,
  recorded_by   uuid,
  recorded_name text,
  at            timestamptz not null default now(),
  primary key (batch_id, member_id)
);

create table if not exists pm_lq_event (
  id       bigserial primary key,
  batch_id bigint not null references pm_lq_batch(id) on delete cascade,
  at       timestamptz not null default now(),
  actor    text,
  action   text not null,
  detail   text
);
create index if not exists pm_lq_event_batch_idx on pm_lq_event (batch_id, at);

alter table pm_lq_buyer  enable row level security;
alter table pm_lq_quote  enable row level security;
alter table pm_lq_attend enable row level security;
alter table pm_lq_event  enable row level security;
-- Không có chính sách nào: không ai đọc / ghi thẳng được, chỉ qua các hàm dưới.
revoke all on pm_lq_buyer, pm_lq_quote, pm_lq_attend, pm_lq_event from authenticated, anon;


-- =====================================================================
-- 2. HÀM NỘI BỘ
-- =====================================================================

create or replace function pm_lq_log(p_batch bigint, p_actor text, p_action text, p_detail text default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into pm_lq_event (batch_id, actor, action, detail) values (p_batch, p_actor, p_action, p_detail)
$$;

create or replace function pm_lq_me()
returns text
language sql
stable
security definer
set search_path = public
as $$ select coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email', 'sql:' || session_user) $$;

-- Mã trong link → bên mua (còn hạn, chưa thu hồi); sai thì báo lỗi chung.
create or replace function vq_buyer(p_token text)
returns pm_lq_buyer
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer;
begin
  select * into v from pm_lq_buyer where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if v.id is null or v.revoked or v.expires_at < now() then
    raise exception 'Đường link không hợp lệ hoặc đã hết hạn. / This link is not valid or has expired.' using errcode = '28000';
  end if;
  update pm_lq_buyer set last_seen_at = now() where id = v.id;
  return v;
end $$;

-- Đợt của bên mua, còn nhận báo giá (đang gọi báo giá, chưa mở thầu, chưa quá hạn).
create or replace function vq_batch(p_buyer pm_lq_buyer, p_write boolean)
returns pm_lq_batch
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  select * into b from pm_lq_batch where id = p_buyer.batch_id;
  if p_write and (b.status <> 'bidding' or b.opened_at is not null or b.call_deadline < now()) then
    raise exception 'Đợt thanh lý đã ngừng nhận báo giá. / This liquidation no longer accepts quotations.';
  end if;
  return b;
end $$;


-- =====================================================================
-- 3. HÀM CHO BÊN MUA (anon, qua link)
-- =====================================================================

-- Mọi thứ bên mua cần: đợt, các món được bán (không có giá sàn), báo giá của CHÍNH MÌNH.
create or replace function vq_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; q pm_lq_quote;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, false);
  select * into q from pm_lq_quote where buyer_id = v.id;
  return jsonb_build_object(
    'buyer', v.name, 'phone', v.phone, 'email', v.email, 'expires_at', v.expires_at,
    'batch', b.code, 'deadline', b.call_deadline, 'terms', b.call_terms,
    'accepting', b.status = 'bidding' and b.opened_at is null and b.call_deadline >= now(),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'name', i.name, 'asset_code', i.asset_code, 'qty', coalesce(i.count_qty, i.qty), 'unit', i.unit,
                'condition', i.condition, 'dept', i.dept_code) order by i.id), '[]')
              from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false),
    'quote', case when q.id is null then null else jsonb_build_object(
                'status', q.status, 'version', q.version, 'data', q.data, 'files', q.files, 'submitted_at', q.submitted_at) end);
end $$;

-- Lưu nháp (sửa được tới khi hết hạn; sửa bản đã nộp thì phải nộp lại).
create or replace function vq_save(p_token text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  if octet_length(coalesce(p_data, '{}')::text) > 200000 then raise exception 'Nội dung quá lớn. / Too much data.'; end if;
  insert into pm_lq_quote (batch_id, buyer_id, data) values (b.id, v.id, coalesce(p_data, '{}'))
  on conflict (buyer_id) do update set data = excluded.data, status = 'draft', updated_at = now();
end $$;

-- Nộp: đủ thông tin bên mua, ít nhất một đơn giá, cam kết. Niêm phong tới khi mở thầu.
create or replace function vq_submit(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; q pm_lq_quote; d jsonb; n int;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  select * into q from pm_lq_quote where buyer_id = v.id;
  if q.id is null then raise exception 'Lưu nháp trước khi nộp. / Save a draft first.'; end if;
  d := q.data;
  if coalesce(d ->> 'kind', '') not in ('person', 'company') then raise exception 'Chọn cá nhân hay doanh nghiệp. / Person or company?'; end if;
  if coalesce(trim(d ->> 'name'), '') = '' or coalesce(trim(d ->> 'phone'), '') = '' or coalesce(trim(d ->> 'address'), '') = '' then
    raise exception 'Nhập họ tên / tên doanh nghiệp, địa chỉ và điện thoại. / Name, address and phone are required.';
  end if;
  if d ->> 'kind' = 'person' and coalesce(trim(d ->> 'id_no'), '') = '' then raise exception 'Nhập số CCCD. / ID number is required.'; end if;
  if d ->> 'kind' = 'company' and (coalesce(trim(d ->> 'tax_code'), '') = '' or coalesce(trim(d ->> 'email'), '') = '') then
    raise exception 'Nhập mã số thuế và email nhận hoá đơn. / Tax code and invoice e-mail are required.';
  end if;
  select count(*) into n from pm_lq_item i
   where i.batch_id = b.id and i.status = 'batched' and i.mode = 'Sale' and i.count_found is not false
     and coalesce(nullif(d -> 'prices' ->> i.id::text, ''), '0')::numeric > 0;
  if n = 0 then raise exception 'Nhập đơn giá cho ít nhất một món. / Quote at least one item.'; end if;
  if coalesce((d ->> 'agree')::boolean, false) is not true then raise exception 'Xác nhận cam kết trước khi nộp. / Tick the commitment first.'; end if;
  update pm_lq_quote set status = 'submitted', version = version + 1, submitted_at = now(), updated_at = now() where id = q.id;
  perform pm_lq_log(b.id, v.name, 'submit', 'v' || (q.version + 1));
end $$;

create or replace function vq_upload_key(p_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; k uuid;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  select upload_key into k from pm_lq_quote where buyer_id = v.id;
  if k is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  return k::text;
end $$;

create or replace function vq_file_add(p_token text, p_path text, p_name text, p_size bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch; q pm_lq_quote;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  select * into q from pm_lq_quote where buyer_id = v.id;
  if q.id is null then raise exception 'Lưu nháp trước khi tải tệp. / Save a draft before uploading.'; end if;
  if p_path is null or split_part(p_path, '/', 1) <> q.upload_key::text or length(p_path) > 300 then
    raise exception 'Đường dẫn tệp không hợp lệ. / Invalid file path.';
  end if;
  if jsonb_array_length(q.files) >= 10 then raise exception 'Tối đa 10 tệp. / 10 files at most.'; end if;
  update pm_lq_quote set files = files || jsonb_build_array(jsonb_build_object('path', p_path, 'name', left(coalesce(p_name, ''), 200), 'size', p_size)),
                         status = 'draft', updated_at = now()
   where id = q.id;
end $$;

create or replace function vq_file_remove(p_token text, p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v pm_lq_buyer; b pm_lq_batch;
begin
  v := vq_buyer(p_token);
  b := vq_batch(v, true);
  update pm_lq_quote set files = coalesce((select jsonb_agg(f) from jsonb_array_elements(files) f where f ->> 'path' <> p_path), '[]'),
                         status = 'draft', updated_at = now()
   where buyer_id = v.id;
end $$;

-- Chính sách Storage: khách chỉ tải lên vào thư mục của một báo giá còn nhận.
create or replace function vq_upload_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from pm_lq_quote q
    join pm_lq_batch b on b.id = q.batch_id
    join pm_lq_buyer v on v.id = q.buyer_id
    where q.upload_key::text = split_part(coalesce(p_name, ''), '/', 1)
      and b.status = 'bidding' and b.opened_at is null and b.call_deadline >= now()
      and not v.revoked and v.expires_at >= now())
$$;


-- =====================================================================
-- 4. HÀM CHO NGƯỜI TRONG KHÁCH SẠN
-- =====================================================================

-- Mở gọi báo giá (từ "đã đánh giá lại"), hoặc sửa hạn / chỉ dẫn khi chưa mở thầu.
create or replace function pm_lq_call_open(p_batch bigint, p_deadline timestamptz, p_terms text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if not (b.status = 'valued' or (b.status = 'bidding' and b.opened_at is null)) then
    raise exception 'Gọi báo giá khi đợt đã đánh giá lại và chưa mở thầu.';
  end if;
  if p_deadline is null or p_deadline <= now() then raise exception 'Hạn nộp báo giá phải ở tương lai.'; end if;
  update pm_lq_batch set status = 'bidding', call_deadline = p_deadline, call_terms = nullif(trim(p_terms), ''), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), case when b.status = 'valued' then 'call' else 'call_edit' end, to_char(p_deadline, 'DD/MM/YYYY HH24:MI'));
end $$;

-- Mời một bên mua: trả về mã (chỉ MỘT lần — không lưu mã gốc).
create or replace function pm_lq_buyer_add(p_batch bigint, p_name text, p_phone text, p_email text, p_days int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_tok text;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Chỉ mời bên mua khi đang gọi báo giá (chưa mở thầu).'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Nhập tên bên mua.'; end if;
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into pm_lq_buyer (batch_id, token_hash, name, phone, email, expires_at, created_by)
  values (b.id, encode(extensions.digest(v_tok, 'sha256'), 'hex'), trim(p_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''),
          greatest(b.call_deadline, now()) + make_interval(days => greatest(1, least(coalesce(p_days, 7), 60))), auth.uid());
  perform pm_lq_log(b.id, pm_lq_me(), 'invite', trim(p_name));
  return v_tok;
end $$;

-- Gia hạn / thu hồi link; tạo mã mới (link cũ hết hiệu lực).
create or replace function pm_lq_buyer_set(p_buyer bigint, p_days int, p_revoke boolean, p_new_token boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_tok text;
begin
  perform pm_lq_need_edit();
  if not exists (select 1 from pm_lq_buyer where id = p_buyer) then raise exception 'Không có bên mua %', p_buyer; end if;
  if p_new_token then v_tok := encode(extensions.gen_random_bytes(24), 'hex'); end if;
  update pm_lq_buyer
     set expires_at = case when p_days is not null then now() + make_interval(days => greatest(1, least(p_days, 60))) else expires_at end,
         revoked = coalesce(p_revoke, revoked),
         token_hash = case when v_tok is not null then encode(extensions.digest(v_tok, 'sha256'), 'hex') else token_hash end
   where id = p_buyer;
  return v_tok;
end $$;

-- Tình hình gọi báo giá của một đợt: bên mua, báo giá (giá / tệp chỉ khi đã mở thầu), điểm danh, nhật ký.
create or replace function pm_lq_bid_list(p_batch bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r jsonb;
begin
  if not (app_trusted() or app_can('liquidation', 'view')) then raise exception 'Bạn không có quyền xem thanh lý.' using errcode = '42501'; end if;
  select jsonb_build_object(
    'buyers', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', v.id, 'name', v.name, 'phone', v.phone, 'email', v.email, 'expires_at', v.expires_at, 'revoked', v.revoked,
                 'last_seen_at', v.last_seen_at,
                 'quote', (select jsonb_build_object('id', q.id, 'status', q.status, 'version', q.version, 'submitted_at', q.submitted_at,
                             'opened_at', q.opened_at, 'invoice_no', q.invoice_no, 'invoice_date', q.invoice_date, 'gate_date', q.gate_date,
                             'gate_ok', q.gate_ok, 'handover_date', q.handover_date,
                             'data', case when q.opened_at is not null then q.data end,
                             'files', case when q.opened_at is not null then q.files end)
                           from pm_lq_quote q where q.buyer_id = v.id)) order by v.id), '[]')
               from pm_lq_buyer v where v.batch_id = p_batch),
    'attend', (select coalesce(jsonb_agg(jsonb_build_object('member_id', a.member_id, 'present', a.present, 'by', a.recorded_name, 'at', a.at)), '[]')
               from pm_lq_attend a where a.batch_id = p_batch),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'actor', e.actor, 'action', e.action, 'detail', e.detail) order by e.at), '[]')
               from pm_lq_event e where e.batch_id = p_batch)) into r;
  return r;
end $$;

/* MỞ THẦU. p_present: các thành viên hội đồng có mặt — phải QUÁ 50% số thành viên
   của hội đồng của đợt. Chỉ khi đã quá hạn nộp, hoặc mọi bên được mời (còn hiệu
   lực) đã nộp. Ít hơn 3 báo giá: bắt buộc giải trình (p_note). */
create or replace function pm_lq_open(p_batch bigint, p_present bigint[], p_note text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_total int; v_here int; v_sub int; v_wait int;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Đợt không ở bước gọi báo giá, hoặc đã mở thầu.'; end if;
  select count(*) into v_sub from pm_lq_quote where batch_id = b.id and status = 'submitted';
  if v_sub = 0 then raise exception 'Chưa có báo giá nào đã nộp.'; end if;
  select count(*) into v_wait from pm_lq_buyer v where v.batch_id = b.id and not v.revoked
     and not exists (select 1 from pm_lq_quote q where q.buyer_id = v.id and q.status = 'submitted');
  if b.call_deadline > now() and v_wait > 0 then
    raise exception 'Chưa tới hạn nộp và còn % bên mua chưa nộp — chưa mở được.', v_wait;
  end if;
  select count(*) into v_total from pm_lq_member where council_id = b.council_id;
  select count(*) into v_here from pm_lq_member where council_id = b.council_id and id = any(coalesce(p_present, '{}'));
  if v_total = 0 then raise exception 'Hội đồng của đợt chưa có thành viên.'; end if;
  if v_here * 2 <= v_total then
    raise exception 'Cần QUÁ 50%% thành viên hội đồng có mặt: mới có % / %.', v_here, v_total;
  end if;
  if v_sub < 3 and coalesce(trim(p_note), '') = '' then
    raise exception 'Có % báo giá (ít hơn 3) — ghi giải trình trước khi mở.', v_sub;
  end if;
  delete from pm_lq_attend where batch_id = b.id;
  insert into pm_lq_attend (batch_id, member_id, present, recorded_by, recorded_name)
  select b.id, m.id, m.id = any(coalesce(p_present, '{}')), auth.uid(), pm_lq_me() from pm_lq_member m where m.council_id = b.council_id;
  update pm_lq_quote set opened_at = now() where batch_id = b.id and status = 'submitted';
  update pm_lq_batch set opened_at = now(), open_note = nullif(trim(p_note), ''), updated_at = now() where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'open', v_sub || ' báo giá · ' || v_here || '/' || v_total || ' thành viên');
  return v_sub;
end $$;

/* Kết quả từng món: p_items = [{item_id, outcome: 'sale'|'destroy'|null, quote_id, price, cost, note}].
   Bán: báo giá đã mở của đợt, đơn giá > 0; không phải giá cao nhất của món thì
   bắt buộc ghi lý do. Huỷ: không bán được (hoặc phương án huỷ). Món kiểm kê không
   thấy không có kết quả (đóng đợt ghi "đã mất"). */
create or replace function pm_lq_award(p_batch bigint, p_items jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; x jsonb; i pm_lq_item; q pm_lq_quote; v_max numeric; v_price numeric; n int := 0;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status not in ('valued', 'bidding') then raise exception 'Đợt đã đóng hoặc chưa đánh giá lại.'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select * into i from pm_lq_item where id = (x ->> 'item_id')::bigint and batch_id = b.id and status = 'batched' for update;
    if i.id is null then raise exception 'Món % không thuộc đợt.', x ->> 'item_id'; end if;
    if i.count_found is false then raise exception '% không thấy khi kiểm kê — không có kết quả bán / huỷ.', coalesce(i.asset_code, i.name); end if;
    if coalesce(x ->> 'outcome', '') = '' then
      update pm_lq_item set outcome = null, sale_quote_id = null, sale_price = null, sale_value = null, sale_cost = null,
                            buyer = null, buyer_id = null, award_note = null where id = i.id;
    elsif x ->> 'outcome' = 'destroy' then
      update pm_lq_item set outcome = 'destroy', sale_quote_id = null, sale_price = null, sale_value = null,
                            sale_cost = nullif(x ->> 'cost', '')::numeric, buyer = null, buyer_id = null,
                            award_note = nullif(trim(x ->> 'note'), '') where id = i.id;
    elsif x ->> 'outcome' = 'sale' then
      if b.opened_at is null then raise exception 'Mở thầu trước khi chọn bên mua.'; end if;
      select * into q from pm_lq_quote where id = (x ->> 'quote_id')::bigint and batch_id = b.id and opened_at is not null;
      if q.id is null then raise exception 'Báo giá không hợp lệ cho %.', coalesce(i.asset_code, i.name); end if;
      v_price := coalesce(nullif(x ->> 'price', '')::numeric, nullif(q.data -> 'prices' ->> i.id::text, '')::numeric);
      if coalesce(v_price, 0) <= 0 then raise exception 'Đơn giá bán của % phải > 0.', coalesce(i.asset_code, i.name); end if;
      select max(nullif(o.data -> 'prices' ->> i.id::text, '')::numeric) into v_max
        from pm_lq_quote o where o.batch_id = b.id and o.opened_at is not null;
      if v_price < coalesce(v_max, 0) and coalesce(trim(x ->> 'note'), '') = '' then
        raise exception '% không chọn giá cao nhất (%) — ghi lý do.', coalesce(i.asset_code, i.name), v_max;
      end if;
      update pm_lq_item set outcome = 'sale', sale_quote_id = q.id, sale_price = v_price,
                            sale_value = round(v_price * coalesce(i.count_qty, i.qty), 2), sale_cost = nullif(x ->> 'cost', '')::numeric,
                            buyer = q.data ->> 'name',
                            buyer_id = case when q.data ->> 'kind' = 'company' then q.data ->> 'tax_code' else q.data ->> 'id_no' end,
                            award_note = nullif(trim(x ->> 'note'), '') where id = i.id;
    else raise exception 'Kết quả không hợp lệ: %', x ->> 'outcome';
    end if;
    n := n + 1;
  end loop;
  perform pm_lq_log(b.id, pm_lq_me(), 'award', n || ' món');
  return n;
end $$;

-- Hồ sơ của bên mua trúng: hoá đơn GTGT, Gate pass (đủ 3 chữ ký), biên bản giao nhận.
create or replace function pm_lq_buyer_doc(p_quote bigint, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare q pm_lq_quote; b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into q from pm_lq_quote where id = p_quote for update;
  select * into b from pm_lq_batch where id = q.batch_id;
  if q.id is null or b.status <> 'bidding' then raise exception 'Báo giá không thuộc đợt đang gọi báo giá.'; end if;
  update pm_lq_quote set
    invoice_no    = case when p_patch ? 'invoice_no' then nullif(trim(p_patch ->> 'invoice_no'), '') else invoice_no end,
    invoice_date  = case when p_patch ? 'invoice_date' then nullif(p_patch ->> 'invoice_date', '')::date else invoice_date end,
    gate_date     = case when p_patch ? 'gate_date' then nullif(p_patch ->> 'gate_date', '')::date else gate_date end,
    gate_ok       = case when p_patch ? 'gate_ok' then coalesce((p_patch ->> 'gate_ok')::boolean, false) else gate_ok end,
    handover_date = case when p_patch ? 'handover_date' then nullif(p_patch ->> 'handover_date', '')::date else handover_date end,
    updated_at = now()
  where id = q.id;
end $$;

/* ĐÓNG ĐỢT: mọi món tìm thấy có kết quả; mỗi bên mua trúng có số hoá đơn GTGT và
   Gate pass đủ 3 chữ ký. Rồi ghi kết quả vào kho và tình trạng tài sản. */
create or replace function pm_lq_close(p_batch bigint, p_date date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch; v_left int; v_bad text;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.id is null then raise exception 'Không có đợt %', p_batch; end if;
  if b.status not in ('valued', 'bidding') then raise exception 'Đợt % không đóng được ở mốc "%".', b.code, b.status; end if;
  select count(*) into v_left from pm_lq_item where batch_id = b.id and status = 'batched' and count_found is not false and outcome is null;
  if v_left > 0 then raise exception 'Còn % món chưa có kết quả (bán / huỷ).', v_left; end if;
  select string_agg(distinct coalesce(q.data ->> 'name', v.name), ', ') into v_bad
    from pm_lq_item i join pm_lq_quote q on q.id = i.sale_quote_id join pm_lq_buyer v on v.id = q.buyer_id
   where i.batch_id = b.id and i.status = 'batched' and i.outcome = 'sale' and (coalesce(q.invoice_no, '') = '' or not q.gate_ok);
  if v_bad is not null then
    raise exception 'Thiếu số hoá đơn GTGT hoặc Gate pass chưa đủ 3 chữ ký: %.', v_bad;
  end if;
  -- Tình trạng tài sản.
  update am_asset a set status_code = case when a.asset_kind = 'low' then '23' when i.outcome = 'sale' then '7' else '9' end
    from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.outcome in ('sale', 'destroy') and a.id = i.asset_id;
  update am_asset a set status_code = '0'
    from pm_lq_item i where i.batch_id = b.id and i.status = 'batched' and i.count_found is false and a.id = i.asset_id and a.asset_kind = 'unique';
  update pm_lq_item set status = case when count_found is false then 'lost' when outcome = 'sale' then 'sold' else 'destroyed' end
   where batch_id = b.id and status = 'batched';
  update pm_lq_batch set status = 'closed', liquidation_date = coalesce(p_date, liquidation_date, current_date), closed_at = now(), updated_at = now()
   where id = b.id;
  perform pm_lq_log(b.id, pm_lq_me(), 'close', null);
end $$;

-- Chính sách Storage: người trong khách sạn chỉ xem tệp của báo giá ĐÃ MỞ.
create or replace function pm_lq_file_ok(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_can('liquidation', 'view') and exists (
    select 1 from pm_lq_quote q where q.upload_key::text = split_part(coalesce(p_name, ''), '/', 1) and q.opened_at is not null)
$$;

-- Đợt 'bidding' lùi được về 'valued' khi chưa mời ai (mở gọi báo giá nhầm).
create or replace function pm_lq_call_cancel(p_batch bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b pm_lq_batch;
begin
  perform pm_lq_need_edit();
  select * into b from pm_lq_batch where id = p_batch for update;
  if b.status <> 'bidding' or b.opened_at is not null then raise exception 'Chỉ huỷ gọi báo giá khi chưa mở thầu.'; end if;
  if exists (select 1 from pm_lq_buyer where batch_id = b.id) then raise exception 'Đã mời bên mua — thu hồi link thay vì huỷ.'; end if;
  update pm_lq_batch set status = 'valued', call_deadline = null, updated_at = now() where id = b.id;
end $$;


-- =====================================================================
-- 5. QUYỀN GỌI HÀM, STORAGE
-- =====================================================================

revoke execute on function pm_lq_log(bigint, text, text, text), pm_lq_me(), vq_buyer(text), vq_batch(pm_lq_buyer, boolean)
  from public, anon, authenticated;
grant execute on function pm_lq_call_open(bigint, timestamptz, text), pm_lq_buyer_add(bigint, text, text, text, int),
                          pm_lq_buyer_set(bigint, int, boolean, boolean), pm_lq_bid_list(bigint), pm_lq_open(bigint, bigint[], text),
                          pm_lq_award(bigint, jsonb), pm_lq_buyer_doc(bigint, jsonb), pm_lq_close(bigint, date), pm_lq_file_ok(text),
                          pm_lq_call_cancel(bigint)
  to authenticated;
-- Chỉ các hàm vq_ công khai được cấp cho khách (anon): mỗi hàm tự kiểm tra mã link.
revoke execute on function vq_session(text), vq_save(text, jsonb), vq_submit(text), vq_upload_key(text),
                           vq_file_add(text, text, text, bigint), vq_file_remove(text, text), vq_upload_ok(text) from public;
grant execute on function vq_session(text), vq_save(text, jsonb), vq_submit(text), vq_upload_key(text),
                          vq_file_add(text, text, text, bigint), vq_file_remove(text, text), vq_upload_ok(text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pm-lqbid', 'pm-lqbid', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pm_lqbid_upload on storage.objects;
create policy pm_lqbid_upload on storage.objects for insert to anon
  with check (bucket_id = 'pm-lqbid' and vq_upload_ok(name));
drop policy if exists pm_lqbid_read on storage.objects;
create policy pm_lqbid_read on storage.objects for select to authenticated
  using (bucket_id = 'pm-lqbid' and pm_lq_file_ok(name));

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Bảng gọi báo giá thanh lý có RLS' as "Mục", count(*)::text as "Thực tế", '4' as "Mong đợi",
       case when count(*) = 4 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pm_lq_buyer', 'pm_lq_quote', 'pm_lq_attend', 'pm_lq_event') and relrowsecurity
union all
select 'Chính sách đọc thẳng các bảng đó (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'public' and tablename in ('pm_lq_buyer', 'pm_lq_quote', 'pm_lq_attend', 'pm_lq_event')
union all
select 'Khách (anon) đọc / ghi thẳng bảng thanh lý (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants where grantee = 'anon' and table_name like 'pm\_lq%'
union all
select 'Khách gọi được hàm pm_ / hàm nội bộ (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   pg_proc where (proname like 'pm\_lq%' or proname in ('vq_buyer', 'vq_batch')) and has_function_privilege('anon', oid, 'execute')
union all
select 'Hàm vq_ công khai cho bên mua', count(*)::text, '7', case when count(*) = 7 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('vq_session', 'vq_save', 'vq_submit', 'vq_upload_key', 'vq_file_add', 'vq_file_remove', 'vq_upload_ok')
  and  has_function_privilege('anon', oid, 'execute')
union all
select 'Bucket pm-lqbid (riêng tư) + 2 chính sách', (select count(*) from storage.buckets where id = 'pm-lqbid' and not public)::text || ' + ' || count(*)::text,
       '1 + 2', case when count(*) = 2 and exists (select 1 from storage.buckets where id = 'pm-lqbid' and not public) then '✔' else '✘ HỎNG' end
from   pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('pm_lqbid_upload', 'pm_lqbid_read');


-- ####################################################################
-- ##  30_acc_reconcile.sql
-- ####################################################################

-- =====================================================================
-- 30_acc_reconcile.sql — ĐỐI CHIẾU SỔ TÀI SẢN VỚI SỔ KHẤU HAO KẾ TOÁN (26/09/2026)
--
-- Chạy SAU 29_liquidation_bid.sql (không phụ thuộc thanh lý; chỉ cần 01–17).
-- Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Hai sổ RIÊNG, nối bằng một bảng liên kết (quyết định 26/09/2026):
--   sổ tài sản  = hiện vật: mã, mã vạch, tên chuẩn hoá, vị trí, tình trạng (am_asset);
--   sổ kế toán  = tài chính: nguyên giá, kỳ khấu hao, luỹ kế, giá trị còn lại —
--                 nạp mỗi tháng từ 3 file kế toán gửi (TSCĐ, CCDC dài hạn 2422,
--                 trả trước ngắn hạn 2421 — chỉ dòng dụng cụ).
--
--   am_acc_import  mỗi lần nạp một file (kỳ, loại, tên file, thống kê)
--   am_acc_stage   các dòng của lần nạp đang dở
--   am_acc_line    dòng kế toán, trạng thái MỚI NHẤT (khoá ổn định line_key);
--                  so với lần nạp trước: mới / đổi / không còn; đổi → am_acc_change
--   am_acc_link    liên kết NHIỀU–NHIỀU dòng kế toán ↔ tài sản. share (tỷ lệ phân
--                  bổ) để trống: "liên kết trước, phân bổ sau khi đủ thông tin"
--   am_acc_alias   từ điển tên: mô tả của kế toán (đã chuẩn hoá) → tên chuẩn trong
--                  sổ tài sản, học từ mỗi lần AM xác nhận liên kết
--   am_asset.fin_* giá trị CHÍNH THỨC lấy từ kế toán (nguyên giá, ngày bắt đầu
--                  khấu hao, kỳ, tài khoản, GTCL tại kỳ nạp). unit_price (giá tạm
--                  từ PO / nhận hàng) KHÔNG bị ghi đè.
--   fin_status     null = chưa đối chiếu (tài sản tạm) · linked = đã liên kết, chưa
--                  phân bổ được giá trị · booked = đã ghi nhận chính thức ·
--                  off = không có trên sổ kế toán (ghi lý do)
--
-- Cột "Mã TS mới" trong file kế toán: kế toán dán mã tài sản app xuất ra (đồng ý
-- 26/09/2026). Lần nạp sau, dòng có mã được TỰ LIÊN KẾT.
--
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

alter table am_asset add column if not exists fin_status  text;
alter table am_asset add column if not exists fin_cost    numeric(18, 2);
alter table am_asset add column if not exists fin_start   date;
alter table am_asset add column if not exists fin_term    int;
alter table am_asset add column if not exists fin_account text;
alter table am_asset add column if not exists fin_nbv     numeric(18, 2);
alter table am_asset add column if not exists fin_as_of   date;
alter table am_asset add column if not exists fin_note    text;
alter table am_asset add column if not exists no_label    boolean not null default false;
alter table am_asset drop constraint if exists am_asset_fin_status_ck;
alter table am_asset add constraint am_asset_fin_status_ck check (fin_status is null or fin_status in ('linked', 'booked', 'off'));
comment on column am_asset.fin_status is 'Đối chiếu kế toán: null = tạm / chưa đối chiếu · linked = đã liên kết, chưa phân bổ · booked = đã ghi nhận chính thức · off = không có trên sổ kế toán.';
comment on column am_asset.no_label is 'Tài sản không dán tem (phần mềm, cải tạo, chi phí di dời gắn với dự án…): có trong sổ tài sản để khớp sổ kế toán, không in tem.';

create table if not exists am_acc_import (
  id          bigserial primary key,
  kind        text not null check (kind in ('fa', 'ccdc', 'st')),
  period      date not null,
  file_name   text,
  sheet       text,
  status      text not null default 'loading' check (status in ('loading', 'done', 'failed')),
  rows_in     int  not null default 0,
  stats       jsonb not null default '{}'::jsonb,
  imported_by uuid default auth.uid(),
  imported_name text,
  imported_at timestamptz not null default now()
);

create table if not exists am_acc_stage (
  import_id bigint not null references am_acc_import(id) on delete cascade,
  n         int not null,
  row       jsonb not null,
  done      boolean not null default false,
  primary key (import_id, n)
);
alter table am_acc_stage add column if not exists done boolean not null default false;
create index if not exists am_acc_stage_key_idx on am_acc_stage (import_id, (row ->> 'line_key'));

create table if not exists am_acc_line (
  id             bigserial primary key,
  kind           text not null check (kind in ('fa', 'ccdc', 'st')),
  line_key       text not null,
  src_row        int,                        -- số dòng trong file kế toán (lần nạp mới nhất)
  acc_code       text,                       -- cột "Mã TS mới" trong file kế toán
  entity         text,                       -- S / C / J
  dept           text,                       -- Tổ chức
  grp            text,                       -- Nhóm (T, I, E, O…)
  loai           text,
  acct_debit     text, acct_credit text, acct_cost text,
  description    text not null,
  qty            numeric(18, 3),
  unit           text,
  unit_price     numeric(18, 2),
  cost           numeric(18, 2),             -- nguyên giá (VND)
  start_date     date,                       -- ngày đưa vào sử dụng / bắt đầu phân bổ
  term_months    int,
  monthly        numeric(18, 2),
  accum          numeric(18, 2),
  nbv            numeric(18, 2),             -- giá trị còn lại tại kỳ nạp
  docs           text,                       -- số chứng từ / mã dự án
  project_code   text,                       -- mã dự án FFE… tách từ chứng từ / dự án / hợp đồng
  tax_code       text, supplier text, contract text, location text,
  liquidation_no text,
  first_seen     date not null,
  last_seen      date not null,
  status         text not null default 'active' check (status in ('active', 'gone')),
  scope          text not null default 'in' check (scope in ('in', 'skip')),
  skip_reason    text,
  updated_at     timestamptz not null default now(),
  unique (kind, line_key)
);
create index if not exists am_acc_line_project_idx on am_acc_line (project_code);
create index if not exists am_acc_line_code_idx on am_acc_line (acc_code) where acc_code is not null;

create table if not exists am_acc_change (
  id       bigserial primary key,
  line_id  bigint not null references am_acc_line(id) on delete cascade,
  period   date not null,
  field    text not null,
  old_val  text,
  new_val  text,
  at       timestamptz not null default now()
);
create index if not exists am_acc_change_line_idx on am_acc_change (line_id, period);

create table if not exists am_acc_link (
  line_id    bigint not null references am_acc_line(id) on delete cascade,
  asset_id   bigint not null references am_asset(id) on delete cascade,
  share      numeric(9, 6) check (share is null or (share >= 0 and share <= 1)),
  method     text not null default 'manual' check (method in ('manual', 'code', 'intake')),
  note       text,
  linked_by  uuid default auth.uid(),
  linked_name text,
  linked_at  timestamptz not null default now(),
  primary key (line_id, asset_id)
);
create index if not exists am_acc_link_asset_idx on am_acc_link (asset_id);

create table if not exists am_acc_alias (
  desc_norm text primary key,
  name      text not null,
  hits      int not null default 1,
  updated_at timestamptz not null default now()
);


-- =====================================================================
-- 2. HÀM PHỤ
-- =====================================================================

create or replace function am_acc_need(p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app_can('assets', p_action) then
    raise exception 'Cần quyền "%" của khu Tài sản. / Assets "%" right required.', p_action, p_action using errcode = '42501';
  end if;
end $$;

/* Giá trị chính thức của một tài sản, tính lại từ các liên kết:
   - dòng kế toán chỉ liên kết với tài sản này → cả dòng;
   - dòng liên kết nhiều tài sản → phần share (khi đã phân bổ); chưa phân bổ → chưa biết;
   - nhiều dòng liên kết với tài sản (CCDC tách từng cái) → cộng lại. */
create or replace function am_acc_refresh(p_assets bigint[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare a bigint; r record;
begin
  foreach a in array coalesce(p_assets, '{}') loop
    select count(*) as n,
           bool_or(k.share is null and (select count(*) from am_acc_link x where x.line_id = k.line_id) > 1) as unknown,
           sum(l.cost * case when (select count(*) from am_acc_link x where x.line_id = k.line_id) = 1 then 1 else k.share end) as cost,
           sum(l.nbv  * case when (select count(*) from am_acc_link x where x.line_id = k.line_id) = 1 then 1 else k.share end) as nbv,
           min(l.start_date) as start, max(l.term_months) as term, max(l.last_seen) as as_of,
           string_agg(distinct l.acct_debit, ', ') as acct
      into r
      from am_acc_link k join am_acc_line l on l.id = k.line_id
     where k.asset_id = a;
    update am_asset set
      fin_status  = case when fin_status = 'off' and r.n = 0 then 'off' when r.n = 0 then null when r.unknown then 'linked' else 'booked' end,
      fin_cost    = case when r.n > 0 and not r.unknown then round(r.cost, 2) end,
      fin_nbv     = case when r.n > 0 and not r.unknown then round(r.nbv, 2) end,
      fin_start   = case when r.n > 0 then r.start end,
      fin_term    = case when r.n > 0 then r.term end,
      fin_account = case when r.n > 0 then r.acct end,
      fin_as_of   = case when r.n > 0 then r.as_of end
     where id = a;
  end loop;
end $$;

-- Dòng có cột "Mã TS mới": mỗi mã tài sản / mã vạch trong ô (cách nhau ; , xuống dòng) → liên kết.
create or replace function am_acc_autolink(p_lines bigint[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare l am_acc_line; tok text; n int := 0; v_ids bigint[] := '{}'; v_a bigint;
begin
  for l in select * from am_acc_line where id = any(coalesce(p_lines, '{}')) and coalesce(acc_code, '') <> '' loop
    foreach tok in array regexp_split_to_array(upper(l.acc_code), '[;,\s]+') loop
      continue when tok = '';
      select id into v_a from am_asset where upper(asset_code) = tok or upper(barcode) = tok limit 1;
      continue when v_a is null;
      insert into am_acc_link (line_id, asset_id, method, linked_name) values (l.id, v_a, 'code', 'file kế toán')
      on conflict do nothing;
      if found then n := n + 1; end if;
      v_ids := v_ids || v_a;
    end loop;
  end loop;
  perform am_acc_refresh(v_ids);
  return n;
end $$;


-- =====================================================================
-- 3. NẠP FILE THEO THÁNG
-- =====================================================================

create or replace function am_acc_import_begin(p_kind text, p_period date, p_file text, p_sheet text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v bigint; v_last date;
begin
  perform am_acc_need('edit');
  if p_kind not in ('fa', 'ccdc', 'st') then raise exception 'Loại file không hợp lệ: %', p_kind; end if;
  if p_period is null then raise exception 'Chưa có kỳ của file.'; end if;
  select max(period) into v_last from am_acc_import where kind = p_kind and status = 'done';
  if v_last is not null and p_period < v_last then
    raise exception 'File kỳ % cũ hơn lần nạp gần nhất (%). / Older than the last import.', to_char(p_period, 'MM/YYYY'), to_char(v_last, 'MM/YYYY');
  end if;
  delete from am_acc_import where kind = p_kind and status = 'loading' and imported_at < now() - interval '1 hour';
  insert into am_acc_import (kind, period, file_name, sheet, imported_name)
  values (p_kind, date_trunc('month', p_period)::date + interval '1 month - 1 day', left(p_file, 200), left(p_sheet, 100),
          coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
  returning id into v;
  return v;
end $$;

create or replace function am_acc_import_rows(p_import bigint, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n0 int;
begin
  perform am_acc_need('edit');
  if not exists (select 1 from am_acc_import where id = p_import and status = 'loading') then raise exception 'Lần nạp % không còn mở.', p_import; end if;
  select coalesce(max(n), 0) into n0 from am_acc_stage where import_id = p_import;
  insert into am_acc_stage (import_id, n, row)
  select p_import, n0 + ord::int, r from jsonb_array_elements(p_rows) with ordinality x(r, ord);
  return jsonb_array_length(p_rows);
end $$;

/* Áp lần nạp, TỪNG LÔ (p_limit dòng mỗi lần gọi — một lần gọi phải xong trong
   giới hạn thời gian của API). Trả {more: true, left} khi còn dòng; lần cuối trả
   thống kê. So từng dòng với trạng thái đã có (theo line_key):
   - có rồi: cập nhật; đổi nguyên giá / kỳ / bộ phận / ngày / số thanh lý / mã TS → ghi am_acc_change;
   - chưa có: thử khớp một dòng CŨ không còn trong file này, cùng bộ phận + nguyên giá +
     ngày (kế toán chỉ sửa mô tả) → giữ dòng cũ, đổi khoá, giữ liên kết; không thì thêm mới;
   - lần cuối: dòng cũ không còn trong file → "không còn" (gone); dòng có "Mã TS mới"
     → tự liên kết; giá trị chính thức của tài sản đã liên kết tính lại. */
create or replace function am_acc_import_finish(p_import bigint, p_limit int default 600)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare im am_acc_import; s record; r jsonb; l am_acc_line; v_new int := 0; v_chg int := 0; v_same int := 0; v_rekey int := 0;
        v_gone int := 0; v_auto int := 0; v_left int; f text; o text; nv text; v_diff boolean; st jsonb;
begin
  perform am_acc_need('edit');
  select * into im from am_acc_import where id = p_import for update;
  if im.id is null or im.status <> 'loading' then raise exception 'Lần nạp % không còn mở.', p_import; end if;
  for s in select n, row from am_acc_stage where import_id = im.id and not done order by n limit greatest(50, least(coalesce(p_limit, 600), 2000)) loop
    r := s.row;
    select * into l from am_acc_line where kind = im.kind and line_key = r ->> 'line_key';
    if l.id is null then
      -- Kế toán sửa mô tả: một dòng cũ chưa thấy trong lần nạp này, cùng bộ phận, nguyên giá, ngày.
      select * into l from am_acc_line x
       where x.kind = im.kind and x.last_seen < im.period and x.status = 'active'
         and coalesce(x.dept, '') = coalesce(r ->> 'dept', '') and x.start_date is not distinct from nullif(r ->> 'start_date', '')::date
         and round(coalesce(x.cost, 0)) = round(coalesce(nullif(r ->> 'cost', '')::numeric, 0)) and coalesce(x.cost, 0) <> 0
         and not exists (select 1 from am_acc_stage t where t.import_id = im.id and (t.row ->> 'line_key') = x.line_key)
       order by x.id limit 1;
      if l.id is not null then
        insert into am_acc_change (line_id, period, field, old_val, new_val) values (l.id, im.period, 'description', l.description, r ->> 'description');
        update am_acc_line set line_key = r ->> 'line_key' where id = l.id;
        v_rekey := v_rekey + 1;
      end if;
    end if;
    if l.id is null then
      insert into am_acc_line (kind, line_key, first_seen, last_seen, description, scope, skip_reason)
      values (im.kind, r ->> 'line_key', im.period, im.period, coalesce(r ->> 'description', ''),
              case when coalesce(r ->> 'skip', '') <> '' then 'skip' else 'in' end, nullif(r ->> 'skip', ''))
      returning * into l;
      v_new := v_new + 1;
    else
      v_diff := false;
      foreach f in array array['cost', 'term_months', 'dept', 'start_date', 'liquidation_no', 'acc_code'] loop
        o := case f when 'cost' then round(l.cost)::text when 'term_months' then l.term_months::text when 'dept' then l.dept
                    when 'start_date' then l.start_date::text when 'liquidation_no' then l.liquidation_no else l.acc_code end;
        nv := case f when 'cost' then round(nullif(r ->> 'cost', '')::numeric)::text
                     when 'term_months' then round(nullif(r ->> 'term_months', '')::numeric)::text else nullif(r ->> f, '') end;
        if o is distinct from nv then
          insert into am_acc_change (line_id, period, field, old_val, new_val) values (l.id, im.period, f, o, nv);
          v_diff := true;
        end if;
      end loop;
      if l.status = 'gone' then insert into am_acc_change (line_id, period, field, old_val, new_val) values (l.id, im.period, 'status', 'gone', 'active'); v_diff := true; end if;
      if v_diff then v_chg := v_chg + 1; else v_same := v_same + 1; end if;
    end if;
    update am_acc_line set
      src_row = nullif(r ->> 'src_row', '')::int, acc_code = nullif(r ->> 'acc_code', ''), entity = nullif(r ->> 'entity', ''),
      dept = nullif(r ->> 'dept', ''), grp = nullif(r ->> 'grp', ''), loai = nullif(r ->> 'loai', ''),
      acct_debit = nullif(r ->> 'acct_debit', ''), acct_credit = nullif(r ->> 'acct_credit', ''), acct_cost = nullif(r ->> 'acct_cost', ''),
      description = coalesce(nullif(r ->> 'description', ''), description), qty = nullif(r ->> 'qty', '')::numeric, unit = nullif(r ->> 'unit', ''),
      unit_price = nullif(r ->> 'unit_price', '')::numeric, cost = nullif(r ->> 'cost', '')::numeric,
      start_date = nullif(r ->> 'start_date', '')::date, term_months = round(nullif(r ->> 'term_months', '')::numeric)::int,
      monthly = nullif(r ->> 'monthly', '')::numeric, accum = nullif(r ->> 'accum', '')::numeric, nbv = nullif(r ->> 'nbv', '')::numeric,
      docs = nullif(r ->> 'docs', ''), project_code = nullif(r ->> 'project_code', ''), tax_code = nullif(r ->> 'tax_code', ''),
      supplier = nullif(r ->> 'supplier', ''), contract = nullif(r ->> 'contract', ''), location = nullif(r ->> 'location', ''),
      liquidation_no = nullif(r ->> 'liquidation_no', ''), last_seen = im.period, status = 'active', updated_at = now()
    where id = l.id;
    update am_acc_stage set done = true where import_id = im.id and n = s.n;
  end loop;
  -- Cộng dồn thống kê qua các lô.
  st := jsonb_build_object('new', coalesce((im.stats ->> 'new')::int, 0) + v_new, 'changed', coalesce((im.stats ->> 'changed')::int, 0) + v_chg,
                           'same', coalesce((im.stats ->> 'same')::int, 0) + v_same, 'rekeyed', coalesce((im.stats ->> 'rekeyed')::int, 0) + v_rekey);
  select count(*) into v_left from am_acc_stage where import_id = im.id and not done;
  if v_left > 0 then
    update am_acc_import set stats = st where id = im.id;
    return st || jsonb_build_object('more', true, 'left', v_left);
  end if;
  -- Lô cuối: dòng không còn trong file.
  with g as (
    update am_acc_line set status = 'gone', updated_at = now()
     where kind = im.kind and status = 'active' and last_seen < im.period
    returning id)
  insert into am_acc_change (line_id, period, field, old_val, new_val) select id, im.period, 'status', 'active', 'gone' from g;
  get diagnostics v_gone = row_count;
  v_auto := am_acc_autolink(array(select id from am_acc_line where kind = im.kind and last_seen = im.period and coalesce(acc_code, '') <> ''));
  -- Giá trị chính thức của các tài sản đã liên kết đi theo số liệu mới.
  perform am_acc_refresh(array(select distinct k.asset_id from am_acc_link k join am_acc_line l2 on l2.id = k.line_id where l2.kind = im.kind));
  select count(*) into v_left from am_acc_stage where import_id = im.id;
  delete from am_acc_stage where import_id = im.id;
  st := st || jsonb_build_object('gone', v_gone, 'autolinked', v_auto);
  update am_acc_import set status = 'done', rows_in = v_left, stats = st where id = im.id;
  return st || jsonb_build_object('more', false);
end $$;



-- =====================================================================
-- 4. LIÊN KẾT, PHÂN BỔ, PHẠM VI
-- =====================================================================

-- p_pairs = [{line_id, asset_id}]: liên kết; học từ điển tên (mô tả kế toán → tên chuẩn).
create or replace function am_acc_link_set(p_pairs jsonb, p_method text default 'manual')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare x jsonb; n int := 0; v_ids bigint[] := '{}'; v_name text; v_desc text;
begin
  perform am_acc_need('edit');
  for x in select * from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    insert into am_acc_link (line_id, asset_id, method, linked_name)
    values ((x ->> 'line_id')::bigint, (x ->> 'asset_id')::bigint, case when p_method = 'intake' then 'intake' else 'manual' end,
            coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email'))
    on conflict do nothing;
    if found then n := n + 1; end if;
    v_ids := v_ids || (x ->> 'asset_id')::bigint;
    v_desc := nullif(x ->> 'desc_norm', '');      -- chuẩn hoá bên app (cùng một hàm khi tra lại)
    select concat_ws('/', name_vi, name_en) into v_name from am_asset where id = (x ->> 'asset_id')::bigint;
    if coalesce(v_desc, '') <> '' and coalesce(v_name, '') <> '' then
      insert into am_acc_alias (desc_norm, name) values (v_desc, v_name)
      on conflict (desc_norm) do update set name = excluded.name, hits = am_acc_alias.hits + 1, updated_at = now();
    end if;
  end loop;
  update am_asset set fin_note = null where id = any(v_ids) and fin_status = 'off';
  update am_asset set fin_status = null where id = any(v_ids) and fin_status = 'off';
  perform am_acc_refresh(v_ids);
  return n;
end $$;

create or replace function am_acc_unlink(p_pairs jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare x jsonb; n int := 0; v_ids bigint[] := '{}';
begin
  perform am_acc_need('edit');
  for x in select * from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) loop
    delete from am_acc_link where line_id = (x ->> 'line_id')::bigint and asset_id = (x ->> 'asset_id')::bigint;
    if found then n := n + 1; end if;
    v_ids := v_ids || (x ->> 'asset_id')::bigint;
  end loop;
  -- Phân bổ của các dòng bị bỏ bớt tài sản không còn đúng: xoá, phân bổ lại khi cần.
  update am_acc_link set share = null where line_id in (select (x ->> 'line_id')::bigint from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) x);
  perform am_acc_refresh(v_ids || array(select asset_id from am_acc_link where line_id in
    (select (x ->> 'line_id')::bigint from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) x)));
  return n;
end $$;

/* Phân bổ một dòng gộp cho các tài sản đã liên kết (khi đã đủ thông tin):
   p_mode 'price' — theo giá tạm (đơn giá × SL trong sổ tài sản); 'equal' — chia đều;
   'manual' — p_shares {asset_id: tỷ lệ}, cộng lại = 1; 'clear' — bỏ phân bổ. */
create or replace function am_acc_allocate(p_line bigint, p_mode text, p_shares jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_tot numeric; v_n int; v_sum numeric;
begin
  perform am_acc_need('edit');
  select count(*) into v_n from am_acc_link where line_id = p_line;
  if v_n = 0 then raise exception 'Dòng chưa liên kết tài sản nào.'; end if;
  if p_mode = 'clear' then
    update am_acc_link set share = null where line_id = p_line;
  elsif p_mode = 'equal' then
    update am_acc_link set share = round(1.0 / v_n, 6) where line_id = p_line;
  elsif p_mode = 'price' then
    select sum(coalesce(a.unit_price, 0) * coalesce(a.qty, 1)) into v_tot from am_acc_link k join am_asset a on a.id = k.asset_id where k.line_id = p_line;
    if coalesce(v_tot, 0) <= 0 then raise exception 'Các tài sản chưa có giá tạm — chia đều hoặc nhập tỷ lệ.'; end if;
    update am_acc_link k set share = round(coalesce(a.unit_price, 0) * coalesce(a.qty, 1) / v_tot, 6)
      from am_asset a where a.id = k.asset_id and k.line_id = p_line;
  elsif p_mode = 'manual' then
    select sum((value)::numeric) into v_sum from jsonb_each_text(coalesce(p_shares, '{}'::jsonb));
    if abs(coalesce(v_sum, 0) - 1) > 0.001 then raise exception 'Tổng tỷ lệ phải bằng 100%% (đang %).', round(coalesce(v_sum, 0) * 100, 2); end if;
    update am_acc_link k set share = (p_shares ->> k.asset_id::text)::numeric where k.line_id = p_line;
  else raise exception 'Cách phân bổ không hợp lệ: %', p_mode;
  end if;
  perform am_acc_refresh(array(select asset_id from am_acc_link where line_id = p_line));
end $$;

-- Đưa dòng kế toán ra / vào phạm vi đối chiếu (hoa hồng, bảo hiểm, quyền sử dụng đất… thì bỏ qua).
create or replace function am_acc_scope(p_lines bigint[], p_skip boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform am_acc_need('edit');
  if p_skip and coalesce(trim(p_reason), '') = '' then raise exception 'Ghi lý do bỏ qua.'; end if;
  update am_acc_line set scope = case when p_skip then 'skip' else 'in' end, skip_reason = case when p_skip then trim(p_reason) end,
                         updated_at = now()
   where id = any(coalesce(p_lines, '{}'));
end $$;

-- Tài sản KHÔNG có trên sổ kế toán (hạch toán chi phí, dưới ngưỡng…): ghi lý do; p_off = false: bỏ đánh dấu.
create or replace function am_acc_asset_off(p_assets bigint[], p_off boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform am_acc_need('edit');
  if p_off and coalesce(trim(p_note), '') = '' then raise exception 'Ghi lý do tài sản không có trên sổ kế toán.'; end if;
  if p_off and exists (select 1 from am_acc_link where asset_id = any(coalesce(p_assets, '{}'))) then
    raise exception 'Tài sản đã liên kết với sổ kế toán — bỏ liên kết trước.';
  end if;
  update am_asset set fin_status = case when p_off then 'off' end, fin_note = case when p_off then trim(p_note) end
   where id = any(coalesce(p_assets, '{}')) and (p_off or fin_status = 'off');
end $$;


-- =====================================================================
-- 5. RLS, QUYỀN
-- =====================================================================

alter table am_acc_import enable row level security;
alter table am_acc_stage  enable row level security;
alter table am_acc_line   enable row level security;
alter table am_acc_change enable row level security;
alter table am_acc_link   enable row level security;
alter table am_acc_alias  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['am_acc_import', 'am_acc_line', 'am_acc_change', 'am_acc_link', 'am_acc_alias'] loop
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using ((select app_can(''assets'', ''view'')))', t || '_read', t);
  end loop;
end $$;

revoke all on am_acc_import, am_acc_stage, am_acc_line, am_acc_change, am_acc_link, am_acc_alias from anon;
revoke all on am_acc_stage from authenticated;
grant select on am_acc_import, am_acc_line, am_acc_change, am_acc_link, am_acc_alias to authenticated;
revoke insert, update, delete on am_acc_import, am_acc_line, am_acc_change, am_acc_link, am_acc_alias from authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_proc where proname = 'app_audit_row') then
    foreach t in array array['am_acc_link'] loop
      execute format('drop trigger if exists app_audit on %I', t);
      execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
    end loop;
  end if;
end $$;

revoke execute on function am_acc_need(text), am_acc_refresh(bigint[]), am_acc_autolink(bigint[]),
                           am_acc_import_begin(text, date, text, text), am_acc_import_rows(bigint, jsonb), am_acc_import_finish(bigint, int),
                           am_acc_link_set(jsonb, text), am_acc_unlink(jsonb), am_acc_allocate(bigint, text, jsonb),
                           am_acc_scope(bigint[], boolean, text), am_acc_asset_off(bigint[], boolean, text)
  from public, anon;
grant execute on function am_acc_import_begin(text, date, text, text), am_acc_import_rows(bigint, jsonb),
                          am_acc_import_finish(bigint, int), am_acc_link_set(jsonb, text), am_acc_unlink(jsonb),
                          am_acc_allocate(bigint, text, jsonb), am_acc_scope(bigint[], boolean, text), am_acc_asset_off(bigint[], boolean, text)
  to authenticated;
-- Nội bộ: tính lại giá trị / tự liên kết chỉ chạy bên trong các hàm trên.
revoke execute on function am_acc_refresh(bigint[]), am_acc_autolink(bigint[]), am_acc_need(text) from authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 6. KIỂM CHỨNG
-- =====================================================================

select 'Bảng đối chiếu kế toán có RLS' as "Mục", count(*)::text as "Thực tế", '6' as "Mong đợi",
       case when count(*) = 6 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('am_acc_import', 'am_acc_stage', 'am_acc_line', 'am_acc_change', 'am_acc_link', 'am_acc_alias') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng đối chiếu (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name like 'am\_acc\_%' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Cột giá trị chính thức trên tài sản (fin_*, no_label)', count(*)::text, '9', case when count(*) = 9 then '✔' else '✘ HỎNG' end
from   information_schema.columns where table_name = 'am_asset' and (column_name like 'fin\_%' or column_name = 'no_label')
union all
select 'Hàm nạp / liên kết / phân bổ', count(*)::text, '8', case when count(*) = 8 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('am_acc_import_begin', 'am_acc_import_rows', 'am_acc_import_finish', 'am_acc_link_set', 'am_acc_unlink',
                                 'am_acc_allocate', 'am_acc_scope', 'am_acc_asset_off');


-- ####################################################################
-- ##  31_asset_ops.sql
-- ####################################################################

-- =====================================================================
-- 31_asset_ops.sql — QUẢN LÝ TÀI SẢN CHI TIẾT (26/09/2026)
--
-- Chạy SAU 30_acc_reconcile.sql (dùng cột fin_* của 30, bảng pm_lq_item của
-- 27–29, am_asset_photo của 26, pm_notice của 20). Chạy lại nhiều lần vô hại.
-- KHÔNG chạy ALL_IN_ONE.
--
--   am_transfer / am_transfer_line   PHIẾU ĐIỀU CHUYỂN có chuỗi duyệt:
--        bên giao (trưởng BP) → bên nhận (trưởng BP nhận, nếu đổi phòng ban)
--        → TGĐ JVC (nếu đổi pháp nhân SSP / CP / JVC) → nhóm QLTS xác nhận.
--        Bước cuối cập nhật sổ: vị trí; phòng ban → CẤP LẠI MÃ tài sản (giữ mã
--        vạch, đặt lại "đã in tem"); CCDC chuyển một phần → tách dòng mới (mã
--        + mã vạch mới). Tài sản Beetrack (is_legacy) giữ mã cũ, chỉ đổi phòng ban.
--   am_incident   SỰ CỐ: hỏng cần sửa · bảo dưỡng · vỡ (B&L) · mất. Tình trạng
--        tài sản đổi theo: báo hỏng → 3 / 25, đang sửa → 5 (bảo dưỡng 6),
--        sửa xong → tình trạng cũ, không sửa được → 4 / 25 (chờ lập LR),
--        mất → 0 (CCDC: trừ số lượng).
--   am_count / am_count_line   KIỂM KÊ ĐỊNH KỲ theo bộ phận / vị trí: chụp danh
--        sách sổ khi mở đợt, quét mã vạch trên máy tính bảng, thừa / thiếu /
--        sai vị trí / tình trạng; đóng đợt → (tuỳ chọn) cập nhật vị trí, lập sự
--        cố "mất" cho tài sản không thấy, "hỏng" cho tài sản hư.
--   am_report() + am_report_snap   BÁO CÁO ĐỊNH KỲ: tổng hợp theo bộ phận /
--        nhóm / tình trạng, biến động trong kỳ, việc tồn; "chốt kỳ" lưu lại số
--        liệu để so sánh về sau.
--   am_asset_history()   DÒNG ĐỜI một tài sản: nhật ký thay đổi + nhận hàng,
--        tem, ảnh, điều chuyển, sự cố, kiểm kê, thanh lý, đối chiếu kế toán.
--   am_asset.warranty_until   hạn bảo hành.
--
-- Quyền: khu "assets" (không thêm khu mới). Người có assets.view thao tác
-- trong phạm vi phòng ban của mình (lập phiếu điều chuyển, báo sự cố, kiểm
-- kê bộ phận mình); assets.edit (nhóm QLTS) mở / đóng đợt kiểm kê, xử lý sự cố.
-- Duyệt điều chuyển theo VAI TRÒ bao phòng ban (như chuỗi phê duyệt).
--
-- Mọi bảng chỉ ghi qua hàm (không cấp insert/update/delete cho trình duyệt).
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. BẢNG
-- =====================================================================

alter table am_asset add column if not exists warranty_until date;
comment on column am_asset.warranty_until is 'Hạn bảo hành (nhập tay hoặc theo hợp đồng / PO).';

create table if not exists am_transfer (
  id           bigserial primary key,
  no           text not null unique,                     -- TF.<BP giao>.<nnn>.<năm>
  from_dept    text not null,
  to_dept      text not null,
  to_location  text,
  reason       text,
  tf_date      date not null default current_date,
  status       text not null default 'draft'
               check (status in ('draft', 'pending', 'returned', 'done', 'rejected', 'cancelled')),
  steps        jsonb not null default '[]'::jsonb,       -- [{key, roles[], dept, by, name, at, action, comment}]
  cur          int,                                      -- bước đang chờ (0-based)
  relabel      int,                                      -- số tem phải in lại khi hoàn tất
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now(),
  submitted_at timestamptz,
  done_at      timestamptz
);
create index if not exists am_transfer_status_idx on am_transfer (status);

create table if not exists am_transfer_line (
  id           bigserial primary key,
  transfer_id  bigint not null references am_transfer(id) on delete cascade,
  asset_id     bigint not null references am_asset(id),
  qty          numeric(18, 3),                           -- CCDC: số lượng chuyển (trống = cả dòng)
  old_code     text,                                     -- mã trước khi chuyển (điền lúc hoàn tất)
  new_code     text,
  new_asset_id bigint,                                   -- dòng mới khi tách CCDC
  note         text
);
create index if not exists am_transfer_line_tf_idx on am_transfer_line (transfer_id);
create index if not exists am_transfer_line_asset_idx on am_transfer_line (asset_id);

create table if not exists am_incident (
  id            bigserial primary key,
  no            text unique,                             -- SC.<năm>.<nnnnn>
  asset_id      bigint not null references am_asset(id),
  dept_code     text,
  kind          text not null check (kind in ('repair', 'maintenance', 'breakage', 'loss')),
  qty           numeric(18, 3),                          -- CCDC: số lượng bị ảnh hưởng
  status        text not null default 'open' check (status in ('open', 'in_progress', 'closed', 'cancelled')),
  reported_at   date not null default current_date,
  description   text,
  cause         text,
  wo_no         text,                                    -- số work order
  vendor        text,
  warranty      boolean,                                 -- còn bảo hành?
  cost          numeric(18, 2),
  outcome       text check (outcome in ('fixed', 'no_fault', 'replace', 'liquidate', 'lost')),
  outcome_note  text,
  lr_doc_no     text,
  prev_status   text,                                    -- tình trạng trước khi báo (để trả lại)
  count_id      bigint,                                  -- sinh từ đợt kiểm kê
  created_by    uuid default auth.uid(),
  created_name  text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  closed_at     timestamptz,
  closed_by     uuid,
  closed_name   text
);
create index if not exists am_incident_asset_idx on am_incident (asset_id);
create index if not exists am_incident_status_idx on am_incident (status);

create table if not exists am_count (
  id           bigserial primary key,
  code         text not null unique,                     -- KK.<năm>.<nn>
  title        text,
  depts        text[] not null,
  locations    text[],                                   -- trống = mọi vị trí của các bộ phận
  count_date   date not null default current_date,
  status       text not null default 'draft' check (status in ('draft', 'open', 'closed', 'cancelled')),
  members      jsonb not null default '[]'::jsonb,       -- [{name, position, user_id}]
  note         text,
  summary      jsonb,
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now(),
  opened_at    timestamptz,
  closed_at    timestamptz,
  closed_by    uuid,
  closed_name  text
);

create table if not exists am_count_line (
  id           bigserial primary key,
  count_id     bigint not null references am_count(id) on delete cascade,
  asset_id     bigint references am_asset(id),
  barcode      text,
  asset_code   text,
  name         text,
  kind         text,
  dept_code    text,
  loc_book     text,
  qty_book     numeric(18, 3),
  status_book  text,
  extra        boolean not null default false,           -- quét được nhưng không có trong danh sách đợt
  found        boolean,                                  -- null = chưa kiểm
  qty_found    numeric(18, 3),
  loc_found    text,
  cond         text check (cond in ('good', 'poor', 'damaged')),
  note         text,
  by_user      uuid,
  by_name      text,
  at           timestamptz,
  action       text                                      -- việc đã làm khi đóng đợt (moved / incident:…)
);
create index if not exists am_count_line_count_idx on am_count_line (count_id);
create index if not exists am_count_line_asset_idx on am_count_line (asset_id);

create table if not exists am_report_snap (
  id           bigserial primary key,
  period       text not null unique,                     -- 2026-09, 2026-Q3, 2026 …
  p_from       date,
  p_to         date,
  data         jsonb not null,
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now()
);

-- Chuỗi duyệt điều chuyển: sửa được ở Hệ thống → Cài đặt (am_setting).
insert into am_setting (key, value, note) values
  ('am_transfer_heads', '{"SSP": ["DEPT_HEAD"], "CP": ["CP_HEAD"], "JVC": ["JVC_GM", "JVC_DGM"]}'::jsonb,
   'Điều chuyển tài sản: vai trò trưởng bộ phận ký bên giao / bên nhận, theo pháp nhân'),
  ('am_transfer_confirm', '["AM_EXEC", "AM_COORD"]'::jsonb,
   'Điều chuyển tài sản: vai trò xác nhận cuối (cập nhật sổ, cấp lại mã)')
on conflict (key) do nothing;


-- =====================================================================
-- 2. HÀM PHỤ
-- =====================================================================

create or replace function am_me_name()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(pm_user_name(auth.uid()), app_claims() ->> 'email', 'sql:' || session_user)
$$;

-- Phòng ban có nằm trong phạm vi của người gọi không.
create or replace function am_in_scope(p_dept text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or p_dept in (select app_scope_orgs())
$$;

-- Công ty (pháp nhân) gần nhất phía trên một phòng ban: cột company_code của tài sản.
create or replace function am_company_of(p_dept text)
returns text language sql stable security definer set search_path = public as $$
  with recursive up(code, parent_code, is_company, depth) as (
    select o.code, o.parent_code, o.is_company, 0 from am_org o where o.code = p_dept
    union all
    select o.code, o.parent_code, o.is_company, u.depth + 1 from am_org o join up u on o.code = u.parent_code where u.depth < 12
  )
  select code from up where is_company order by depth limit 1
$$;

-- Người dùng đang hoạt động giữ một trong các vai trò, phạm vi bao phòng ban.
create or replace function am_actors(p_roles jsonb, p_dept text)
returns setof uuid language sql stable security definer set search_path = public as $$
  select u.id from app_user u
  where  u.active and exists (select 1 from jsonb_array_elements_text(p_roles) r where app_user_role_covers(u.id, r, p_dept))
$$;

create or replace function am_is_actor(p_roles jsonb, p_dept text)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or exists (select 1 from jsonb_array_elements_text(p_roles) r where app_user_role_covers(auth.uid(), r, p_dept))
$$;

-- Thông báo trong app (chuông) — dùng lại pm_notice, doc_type 'TF' / 'SC' / 'KK'.
create or replace function am_notify(p_users uuid[], p_kind text, p_no text, p_type text, p_dept text, p_comment text default null)
returns void language sql security definer set search_path = public as $$
  insert into pm_notice (user_id, kind, doc_no, doc_type, project_code, actor_email, comment)
  select distinct u, p_kind, p_no, p_type, p_dept, coalesce(app_claims() ->> 'email', 'sql'), p_comment
  from   unnest(p_users) u
  where  u is not null and u is distinct from auth.uid()
$$;

-- Tình trạng "còn trên sổ" (không tính đã mất / đã thanh lý / đã huỷ / CCDC đã thanh lý).
create or replace function am_alive(p_status text)
returns boolean language sql immutable as $$
  select coalesce(p_status, '') not in ('0', '7', '9', '23')
$$;


-- =====================================================================
-- 3. ĐIỀU CHUYỂN
-- =====================================================================

create or replace function am_tf_steps(p_from text, p_to text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  heads jsonb := coalesce((select value from am_setting where key = 'am_transfer_heads'),
                          '{"SSP": ["DEPT_HEAD"], "CP": ["CP_HEAD"], "JVC": ["JVC_GM", "JVC_DGM"]}'::jsonb);
  conf  jsonb := coalesce((select value from am_setting where key = 'am_transfer_confirm'), '["AM_EXEC", "AM_COORD"]'::jsonb);
  ef    text := pm_entity(p_from);
  et    text := pm_entity(p_to);
  s     jsonb;
begin
  s := jsonb_build_array(jsonb_build_object('key', 'from', 'roles', coalesce(heads -> ef, '["DEPT_HEAD"]'::jsonb), 'dept', p_from));
  if p_to <> p_from then
    s := s || jsonb_build_array(jsonb_build_object('key', 'to', 'roles', coalesce(heads -> et, '["DEPT_HEAD"]'::jsonb), 'dept', p_to));
  end if;
  if ef is distinct from et then
    s := s || jsonb_build_array(jsonb_build_object('key', 'jvc', 'roles', '["JVC_GM"]'::jsonb, 'dept', p_from));
  end if;
  return s || jsonb_build_array(jsonb_build_object('key', 'am', 'roles', conf, 'dept', p_from));
end $$;

-- Tạo / sửa phiếu nháp. p_data: {from_dept, to_dept, to_location, reason, tf_date, lines:[{asset_id, qty, note}]}
create or replace function am_tf_save(p_id bigint, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  t      am_transfer;
  v_from text := upper(trim(p_data ->> 'from_dept'));
  v_to   text := upper(trim(coalesce(nullif(p_data ->> 'to_dept', ''), p_data ->> 'from_dept')));
  v_loc  text := nullif(upper(trim(coalesce(p_data ->> 'to_location', ''))), '');
  v_date date := coalesce(nullif(p_data ->> 'tf_date', '')::date, current_date);
  v_n    int;
  l      jsonb;
  a      record;
begin
  perform app_require('assets', 'view');
  if not am_in_scope(v_from) then raise exception 'Phòng ban % nằm ngoài phạm vi của bạn.', v_from using errcode = '42501'; end if;
  if not exists (select 1 from am_org where code = v_to and is_department) then raise exception 'Mã phòng ban nhận % không có trong danh mục.', v_to; end if;
  if v_loc is not null and not exists (select 1 from am_location where code = v_loc) then raise exception 'Mã vị trí % không có trong danh mục.', v_loc; end if;
  if v_to = v_from and v_loc is null then raise exception 'Chọn phòng ban nhận khác hoặc vị trí mới.'; end if;
  if jsonb_array_length(coalesce(p_data -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Phiếu chưa có tài sản nào.'; end if;

  if p_id is null then
    lock table am_transfer in share row exclusive mode;
    select coalesce(max(split_part(no, '.', 3)::int), 0) + 1 into v_n
    from   am_transfer where split_part(no, '.', 2) = v_from and split_part(no, '.', 4) = extract(year from v_date)::text;
    insert into am_transfer (no, from_dept, to_dept, to_location, reason, tf_date, created_name)
    values ('TF.' || v_from || '.' || lpad(v_n::text, 3, '0') || '.' || extract(year from v_date)::int,
            v_from, v_to, v_loc, p_data ->> 'reason', v_date, am_me_name())
    returning * into t;
  else
    select * into t from am_transfer where id = p_id for update;
    if not found then raise exception 'Không có phiếu %.', p_id; end if;
    if t.status not in ('draft', 'returned') then raise exception 'Phiếu % đã gửi — không sửa được.', t.no; end if;
    if t.created_by is distinct from auth.uid() and not app_can('assets', 'edit') then raise exception 'Chỉ người lập sửa được phiếu.' using errcode = '42501'; end if;
    if v_from <> t.from_dept then raise exception 'Không đổi được phòng ban giao của phiếu đã lập.'; end if;
    update am_transfer set to_dept = v_to, to_location = v_loc, reason = p_data ->> 'reason', tf_date = v_date where id = t.id;
    delete from am_transfer_line where transfer_id = t.id;
  end if;

  for l in select * from jsonb_array_elements(p_data -> 'lines') loop
    select x.id, x.asset_code, x.asset_kind, x.qty, x.dept_code, x.status_code into a from am_asset x where x.id = (l ->> 'asset_id')::bigint;
    if not found then raise exception 'Không có tài sản id %.', l ->> 'asset_id'; end if;
    if a.dept_code <> v_from then raise exception 'Tài sản % thuộc phòng ban %, không phải %.', a.asset_code, a.dept_code, v_from; end if;
    if not am_alive(a.status_code) then raise exception 'Tài sản % đã mất / thanh lý / huỷ.', a.asset_code; end if;
    if exists (select 1 from am_transfer_line tl join am_transfer x on x.id = tl.transfer_id
               where tl.asset_id = a.id and x.id <> t.id and x.status in ('draft', 'pending', 'returned')) then
      raise exception 'Tài sản % đang nằm trên một phiếu điều chuyển khác.', a.asset_code;
    end if;
    if a.asset_kind = 'low' and nullif(l ->> 'qty', '') is not null
       and ((l ->> 'qty')::numeric <= 0 or (l ->> 'qty')::numeric > a.qty) then
      raise exception 'Số lượng chuyển của % phải từ 0 đến %.', a.asset_code, a.qty;
    end if;
    insert into am_transfer_line (transfer_id, asset_id, qty, note)
    values (t.id, a.id, case when a.asset_kind = 'low' then nullif(l ->> 'qty', '')::numeric end, l ->> 'note');
  end loop;
  return t.id;
end $$;

create or replace function am_tf_submit(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare t am_transfer; s jsonb;
begin
  perform app_require('assets', 'view');
  select * into t from am_transfer where id = p_id for update;
  if not found then raise exception 'Không có phiếu %.', p_id; end if;
  if t.status not in ('draft', 'returned') then raise exception 'Phiếu % không ở trạng thái nháp.', t.no; end if;
  if t.created_by is distinct from auth.uid() and not app_can('assets', 'edit') then raise exception 'Chỉ người lập gửi được phiếu.' using errcode = '42501'; end if;
  if not exists (select 1 from am_transfer_line where transfer_id = t.id) then raise exception 'Phiếu chưa có tài sản nào.'; end if;
  s := am_tf_steps(t.from_dept, t.to_dept);
  update am_transfer set status = 'pending', steps = s, cur = 0, submitted_at = now() where id = t.id;
  perform am_notify(array(select am_actors(s -> 0 -> 'roles', s -> 0 ->> 'dept')), 'todo', t.no, 'TF', t.from_dept, t.reason);
end $$;

-- Cập nhật sổ khi bước cuối xác nhận. Nội bộ (không cấp cho trình duyệt).
create or replace function am_tf_apply(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare
  t       am_transfer;
  l       record;
  a       am_asset;
  n       am_asset;
  v_mv    numeric;
  v_seq   int;
  v_co    text;
  v_rel   int := 0;
  v_new   boolean;
begin
  select * into t from am_transfer where id = p_id;
  v_new := t.to_dept <> t.from_dept;
  v_co  := case when v_new then am_company_of(t.to_dept) end;
  for l in select * from am_transfer_line where transfer_id = p_id order by id loop
    select * into a from am_asset where id = l.asset_id for update;
    if a.dept_code <> t.from_dept then raise exception 'Tài sản % đã đổi phòng ban (%) từ khi lập phiếu.', a.asset_code, a.dept_code; end if;
    v_mv := case when a.asset_kind = 'low' then coalesce(l.qty, a.qty) else 1 end;

    if a.asset_kind = 'low' and v_mv < a.qty then
      -- CCDC chuyển một phần: phần chuyển thành dòng mới (mã + mã vạch mới), dòng cũ giảm số lượng.
      update am_asset set qty = qty - v_mv where id = a.id;
      n := a;
      n.id            := nextval(pg_get_serial_sequence('am_asset', 'id'));
      n.qty           := v_mv;
      n.barcode       := am_format_barcode('low', am_alloc_barcode('low', 1, null, 'transfer ' || t.no));
      n.dept_code     := t.to_dept;
      n.company_code  := coalesce(v_co, a.company_code);
      n.letters       := am_letters(a.letters);
      n.seq           := am_alloc_asset_seq(t.to_dept, am_letters(a.letters), 1, null, 'transfer ' || t.no);
      n.asset_code    := am_build_asset_code(t.to_dept, a.group_code, am_letters(a.letters), a.purchase_year, n.seq);
      n.location_code := coalesce(t.to_location, a.location_code);
      n.is_legacy     := false;
      n.label_printed := false;
      n.created_at    := now();
      n.needs_review  := '[]'::jsonb;
      n.fin_status := null; n.fin_cost := null; n.fin_nbv := null; n.fin_start := null;
      n.fin_term := null; n.fin_account := null; n.fin_as_of := null; n.fin_note := null;
      n.note          := trim(both ' ' from coalesce(a.note, '') || ' [tách từ ' || a.asset_code || ' theo ' || t.no || ']');
      insert into am_asset select n.*;
      update am_transfer_line set old_code = a.asset_code, new_code = n.asset_code, new_asset_id = n.id where id = l.id;
      v_rel := v_rel + 1;
    elsif v_new and not a.is_legacy then
      -- Đổi phòng ban: cấp lại mã (mã mang mã phòng ban), mã vạch giữ nguyên, tem phải in lại.
      v_seq := am_alloc_asset_seq(t.to_dept, am_letters(a.letters), 1, null, 'transfer ' || t.no);
      update am_asset
         set dept_code = t.to_dept, company_code = coalesce(v_co, company_code), letters = am_letters(a.letters), seq = v_seq,
             asset_code = am_build_asset_code(t.to_dept, a.group_code, am_letters(a.letters), a.purchase_year, v_seq),
             location_code = coalesce(t.to_location, location_code), label_printed = false
       where id = a.id
      returning asset_code into n.asset_code;
      update am_transfer_line set old_code = a.asset_code, new_code = n.asset_code where id = l.id;
      if a.label_printed then v_rel := v_rel + 1; end if;
    else
      -- Chỉ đổi vị trí, hoặc tài sản Beetrack (mã cũ không dựng lại được): giữ mã.
      update am_asset set dept_code = t.to_dept, company_code = coalesce(v_co, company_code),
                          location_code = coalesce(t.to_location, location_code)
       where id = a.id;
      update am_transfer_line set old_code = a.asset_code, new_code = a.asset_code where id = l.id;
    end if;
  end loop;
  return v_rel;
end $$;

-- approve | return | reject. Người lập không tự duyệt (trừ khi bật pm_allow_self_approve).
create or replace function am_tf_act(p_id bigint, p_action text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t   am_transfer;
  s   jsonb;
  st  jsonb;
  v_last boolean;
  v_rel  int;
begin
  perform app_require('assets', 'view');
  select * into t from am_transfer where id = p_id for update;
  if not found then raise exception 'Không có phiếu %.', p_id; end if;
  if t.status <> 'pending' then raise exception 'Phiếu % không chờ duyệt.', t.no; end if;
  st := t.steps -> t.cur;
  if not am_is_actor(st -> 'roles', st ->> 'dept') then raise exception 'Bước này không phải của bạn.' using errcode = '42501'; end if;
  if t.created_by = auth.uid() and not pm_self_ok() then raise exception 'Người lập không duyệt phiếu của mình.' using errcode = '42501'; end if;
  if p_action not in ('approve', 'return', 'reject') then raise exception 'Thao tác không hợp lệ: %', p_action; end if;
  if p_action in ('return', 'reject') and coalesce(trim(p_comment), '') = '' then raise exception 'Ghi lý do trả lại / từ chối.'; end if;

  s := jsonb_set(t.steps, array[t.cur::text], st || jsonb_build_object('by', auth.uid(), 'name', am_me_name(), 'at', now(),
                                                                      'action', p_action, 'comment', p_comment));
  v_last := t.cur = jsonb_array_length(t.steps) - 1;
  if p_action = 'return' then
    update am_transfer set status = 'returned', steps = s, cur = null where id = t.id;
    perform am_notify(array[t.created_by], 'returned', t.no, 'TF', t.from_dept, p_comment);
  elsif p_action = 'reject' then
    update am_transfer set status = 'rejected', steps = s, cur = null where id = t.id;
    perform am_notify(array[t.created_by], 'rejected', t.no, 'TF', t.from_dept, p_comment);
  elsif v_last then
    update am_transfer set steps = s where id = t.id;
    v_rel := am_tf_apply(t.id);
    update am_transfer set status = 'done', cur = null, done_at = now(), relabel = v_rel where id = t.id;
    perform am_notify(array[t.created_by], 'approved', t.no, 'TF', t.from_dept, p_comment);
  else
    update am_transfer set steps = s, cur = t.cur + 1 where id = t.id;
    perform am_notify(array(select am_actors(s -> (t.cur + 1) -> 'roles', s -> (t.cur + 1) ->> 'dept')), 'todo', t.no, 'TF', t.from_dept, t.reason);
  end if;
  return jsonb_build_object('status', (select status from am_transfer where id = t.id), 'relabel', v_rel);
end $$;

create or replace function am_tf_cancel(p_id bigint, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare t am_transfer;
begin
  perform app_require('assets', 'view');
  select * into t from am_transfer where id = p_id for update;
  if not found then raise exception 'Không có phiếu %.', p_id; end if;
  if t.status not in ('draft', 'pending', 'returned') then raise exception 'Phiếu % đã kết thúc.', t.no; end if;
  if t.created_by is distinct from auth.uid() and not app_can('assets', 'admin') then raise exception 'Chỉ người lập huỷ được phiếu.' using errcode = '42501'; end if;
  update am_transfer set status = 'cancelled', cur = null,
         steps = steps || jsonb_build_array(jsonb_build_object('key', 'cancel', 'by', auth.uid(), 'name', am_me_name(), 'at', now(), 'action', 'cancel', 'comment', p_comment))
   where id = t.id;
end $$;

-- Việc chờ tôi: phiếu đang ở bước mà tôi giữ vai trò.
create or replace function am_tf_inbox()
returns setof am_transfer language sql stable security definer set search_path = public as $$
  select t.* from am_transfer t
  where  t.status = 'pending'
    and  am_is_actor(t.steps -> t.cur -> 'roles', t.steps -> t.cur ->> 'dept')
    and  (t.created_by is distinct from auth.uid() or pm_self_ok())
  order by t.submitted_at
$$;


-- =====================================================================
-- 4. SỰ CỐ — hỏng / bảo dưỡng / vỡ (B&L) / mất
-- =====================================================================

-- p_data: {asset_id, kind, qty, reported_at, description, cause, wo_no, vendor, warranty}
create or replace function am_inc_report(p_data jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare a am_asset; v_id bigint; v_kind text := p_data ->> 'kind'; v_st text;
begin
  perform app_require('assets', 'view');
  select * into a from am_asset where id = (p_data ->> 'asset_id')::bigint for update;
  if not found then raise exception 'Không có tài sản.'; end if;
  if not am_in_scope(a.dept_code) then raise exception 'Tài sản % nằm ngoài phạm vi của bạn.', a.asset_code using errcode = '42501'; end if;
  if not am_alive(a.status_code) then raise exception 'Tài sản % đã mất / thanh lý / huỷ.', a.asset_code; end if;
  if v_kind not in ('repair', 'maintenance', 'breakage', 'loss') then raise exception 'Loại sự cố không hợp lệ: %', v_kind; end if;
  if exists (select 1 from am_incident where asset_id = a.id and status in ('open', 'in_progress') and kind = v_kind) then
    raise exception 'Tài sản % đang có sự cố cùng loại chưa đóng.', a.asset_code;
  end if;
  insert into am_incident (asset_id, dept_code, kind, qty, reported_at, description, cause, wo_no, vendor, warranty, prev_status, created_name, count_id)
  values (a.id, a.dept_code, v_kind, case when a.asset_kind = 'low' then coalesce(nullif(p_data ->> 'qty', '')::numeric, a.qty) end,
          coalesce(nullif(p_data ->> 'reported_at', '')::date, current_date), p_data ->> 'description', p_data ->> 'cause',
          p_data ->> 'wo_no', p_data ->> 'vendor', nullif(p_data ->> 'warranty', '')::boolean, a.status_code, am_me_name(),
          nullif(p_data ->> 'count_id', '')::bigint)
  returning id into v_id;
  update am_incident set no = 'SC.' || extract(year from reported_at)::int || '.' || lpad(v_id::text, 5, '0') where id = v_id;
  -- Hỏng / vỡ: "chờ sửa". Bảo dưỡng và mất không đổi tình trạng lúc báo.
  if v_kind in ('repair', 'breakage') and coalesce(a.status_code, '') not in ('3', '4', '5', '6', '25', '8', '24') then
    v_st := case when a.asset_kind = 'unique' then '3' else '25' end;
    update am_asset set status_code = v_st where id = a.id;
  end if;
  perform am_notify(array(select am_actors((select value from am_setting where key = 'am_transfer_confirm'), a.dept_code)),
                    'todo', (select no from am_incident where id = v_id), 'SC', a.dept_code, p_data ->> 'description');
  return v_id;
end $$;

-- Cập nhật khi đang xử lý: {wo_no, vendor, warranty, cost, description, cause, lr_doc_no, start:true}
create or replace function am_inc_update(p_id bigint, p_data jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare i am_incident; a am_asset;
begin
  perform app_require('assets', 'view');
  select * into i from am_incident where id = p_id for update;
  if not found then raise exception 'Không có sự cố %.', p_id; end if;
  if not (app_can('assets', 'edit') or (i.created_by = auth.uid() and i.status = 'open')) then
    raise exception 'Chỉ nhóm QLTS (hoặc người báo, khi chưa xử lý) sửa được.' using errcode = '42501';
  end if;
  if i.status in ('closed', 'cancelled') and not (p_data ? 'lr_doc_no') then raise exception 'Sự cố % đã đóng.', i.no; end if;
  update am_incident set
    wo_no       = case when p_data ? 'wo_no'       then p_data ->> 'wo_no'       else wo_no end,
    vendor      = case when p_data ? 'vendor'      then p_data ->> 'vendor'      else vendor end,
    warranty    = case when p_data ? 'warranty'    then nullif(p_data ->> 'warranty', '')::boolean else warranty end,
    cost        = case when p_data ? 'cost'        then nullif(p_data ->> 'cost', '')::numeric else cost end,
    description = case when p_data ? 'description' then p_data ->> 'description' else description end,
    cause       = case when p_data ? 'cause'       then p_data ->> 'cause'       else cause end,
    lr_doc_no   = case when p_data ? 'lr_doc_no'   then p_data ->> 'lr_doc_no'   else lr_doc_no end
  where id = i.id;
  if coalesce((p_data ->> 'start')::boolean, false) and i.status = 'open' then
    if not app_can('assets', 'edit') then raise exception 'Chỉ nhóm QLTS chuyển sang "đang xử lý".' using errcode = '42501'; end if;
    update am_incident set status = 'in_progress', started_at = now() where id = i.id;
    select * into a from am_asset where id = i.asset_id for update;
    if a.asset_kind = 'unique' and i.kind in ('repair', 'breakage', 'maintenance') and a.status_code not in ('4', '8') then
      update am_asset set status_code = case when i.kind = 'maintenance' then '6' else '5' end where id = a.id;
    end if;
  end if;
end $$;

-- Đóng: fixed | no_fault → tình trạng cũ · replace | liquidate → 4 / 25 (chờ LR) · lost → 0 (CCDC trừ số lượng)
create or replace function am_inc_close(p_id bigint, p_outcome text, p_note text default null, p_cost numeric default null)
returns void language plpgsql security definer set search_path = public as $$
declare i am_incident; a am_asset; v_back text;
begin
  perform app_require('assets', 'edit');
  select * into i from am_incident where id = p_id for update;
  if not found then raise exception 'Không có sự cố %.', p_id; end if;
  if i.status in ('closed', 'cancelled') then raise exception 'Sự cố % đã đóng.', i.no; end if;
  if p_outcome not in ('fixed', 'no_fault', 'replace', 'liquidate', 'lost') then raise exception 'Kết quả không hợp lệ: %', p_outcome; end if;
  select * into a from am_asset where id = i.asset_id for update;
  v_back := case when am_alive(i.prev_status) and coalesce(i.prev_status, '') not in ('3', '4', '5', '6', '25', '')
                 then i.prev_status when a.asset_kind = 'unique' then '1' else '20' end;
  if p_outcome in ('fixed', 'no_fault') then
    if coalesce(a.status_code, '') in ('3', '5', '6', '25') then update am_asset set status_code = v_back where id = a.id; end if;
  elsif p_outcome in ('replace', 'liquidate') then
    if coalesce(a.status_code, '') not in ('8', '24') then
      update am_asset set status_code = case when a.asset_kind = 'unique' then '4' else '25' end where id = a.id;
    end if;
  else  -- lost
    if a.asset_kind = 'unique' then update am_asset set status_code = '0' where id = a.id;
    else
      update am_asset set qty = greatest(qty - coalesce(i.qty, qty), 0),
                          status_code = case when qty - coalesce(i.qty, qty) <= 0 then '21' else status_code end
       where id = a.id;
    end if;
  end if;
  update am_incident set status = 'closed', outcome = p_outcome, outcome_note = p_note, cost = coalesce(p_cost, cost),
         closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name()
   where id = i.id;
  perform am_notify(array[i.created_by], 'approved', i.no, 'SC', i.dept_code, p_note);
end $$;

create or replace function am_inc_cancel(p_id bigint, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare i am_incident; a am_asset;
begin
  perform app_require('assets', 'view');
  select * into i from am_incident where id = p_id for update;
  if not found then raise exception 'Không có sự cố %.', p_id; end if;
  if i.status in ('closed', 'cancelled') then raise exception 'Sự cố % đã đóng.', i.no; end if;
  if not (app_can('assets', 'edit') or (i.created_by = auth.uid() and i.status = 'open')) then raise exception 'Không huỷ được sự cố này.' using errcode = '42501'; end if;
  select * into a from am_asset where id = i.asset_id for update;
  if coalesce(a.status_code, '') in ('3', '5', '6', '25') and i.prev_status is not null then
    update am_asset set status_code = i.prev_status where id = a.id;
  end if;
  update am_incident set status = 'cancelled', outcome_note = p_note, closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name() where id = i.id;
end $$;


-- =====================================================================
-- 5. KIỂM KÊ ĐỊNH KỲ
-- =====================================================================

-- Người được kiểm: QLTS (assets.edit), thành viên có tài khoản, hoặc người có
-- assets.view mà phạm vi bao mọi bộ phận của đợt.
create or replace function am_count_can(p_count bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select app_trusted() or app_can('assets', 'edit')
      or exists (select 1 from am_count c, jsonb_array_elements(c.members) m
                 where c.id = p_count and m ->> 'user_id' = auth.uid()::text)
      or (app_can('assets', 'view')
          and not exists (select 1 from am_count c, unnest(c.depts) d where c.id = p_count and not am_in_scope(d)))
$$;

-- p_data: {title, depts[], locations[], count_date, members[{name, position, user_id}], note}
create or replace function am_count_save(p_id bigint, p_data jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare c am_count; v_n int; v_d date := coalesce(nullif(p_data ->> 'count_date', '')::date, current_date);
        v_depts text[] := array(select upper(trim(x)) from jsonb_array_elements_text(coalesce(p_data -> 'depts', '[]'::jsonb)) x where trim(x) <> '');
        v_locs text[]  := nullif(array(select upper(trim(x)) from jsonb_array_elements_text(coalesce(p_data -> 'locations', '[]'::jsonb)) x where trim(x) <> ''), '{}');
begin
  perform app_require('assets', 'edit');
  if coalesce(array_length(v_depts, 1), 0) = 0 then raise exception 'Chọn ít nhất một bộ phận.'; end if;
  if p_id is null then
    lock table am_count in share row exclusive mode;
    select coalesce(max(split_part(code, '.', 3)::int), 0) + 1 into v_n from am_count where split_part(code, '.', 2) = extract(year from v_d)::text;
    insert into am_count (code, title, depts, locations, count_date, members, note, created_name)
    values ('KK.' || extract(year from v_d)::int || '.' || lpad(v_n::text, 2, '0'), p_data ->> 'title', v_depts, v_locs, v_d,
            coalesce(p_data -> 'members', '[]'::jsonb), p_data ->> 'note', am_me_name())
    returning * into c;
  else
    select * into c from am_count where id = p_id for update;
    if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
    if c.status in ('closed', 'cancelled') then raise exception 'Đợt % đã kết thúc.', c.code; end if;
    if c.status = 'open' and (v_depts is distinct from c.depts or v_locs is distinct from c.locations) then
      raise exception 'Đợt đã mở — không đổi phạm vi được (huỷ và lập đợt mới).';
    end if;
    update am_count set title = p_data ->> 'title', depts = v_depts, locations = v_locs, count_date = v_d,
                        members = coalesce(p_data -> 'members', '[]'::jsonb), note = p_data ->> 'note'
     where id = c.id;
  end if;
  return c.id;
end $$;

-- Mở đợt: chụp danh sách sổ tại lúc mở.
create or replace function am_count_open(p_id bigint)
returns int language plpgsql security definer set search_path = public as $$
declare c am_count; v_n int;
begin
  perform app_require('assets', 'edit');
  select * into c from am_count where id = p_id for update;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'draft' then raise exception 'Đợt % đã mở.', c.code; end if;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book)
  select c.id, a.id, a.barcode, a.asset_code, concat_ws(' / ', a.name_vi, nullif(a.name_en, '')), a.asset_kind, a.dept_code,
         a.location_code, a.qty, a.status_code
  from   am_asset a
  where  a.dept_code = any(c.depts)
    and  (c.locations is null or a.location_code = any(c.locations))
    and  am_alive(a.status_code)
    and  (a.asset_kind = 'unique' or a.qty > 0)
  order by a.location_code nulls last, a.asset_code;
  get diagnostics v_n = row_count;
  update am_count set status = 'open', opened_at = now() where id = c.id;
  return v_n;
end $$;

-- Quét một mã (mã vạch hoặc mã tài sản) tại vị trí p_loc. Trả về dòng (jsonb).
create or replace function am_count_scan(p_id bigint, p_code text, p_loc text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c am_count; l am_count_line; a am_asset; q text := upper(trim(p_code)); v_loc text := nullif(upper(trim(coalesce(p_loc, ''))), '');
begin
  select * into c from am_count where id = p_id;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if not am_count_can(p_id) then raise exception 'Bạn không kiểm được đợt này.' using errcode = '42501'; end if;
  select * into l from am_count_line where count_id = p_id and (upper(barcode) = q or upper(asset_code) = q) order by extra limit 1 for update;
  if found then
    update am_count_line set found = true, qty_found = coalesce(qty_found, qty_book), loc_found = coalesce(v_loc, loc_found, loc_book),
                             by_user = auth.uid(), by_name = am_me_name(), at = now()
     where id = l.id returning * into l;
    return to_jsonb(l) || jsonb_build_object('hit', 'list');
  end if;
  -- Không có trong danh sách: tài sản của bộ phận / vị trí khác, hoặc chưa có trên sổ.
  select * into a from am_asset where upper(barcode) = q or upper(asset_code) = q limit 1;
  insert into am_count_line (count_id, asset_id, barcode, asset_code, name, kind, dept_code, loc_book, qty_book, status_book,
                             extra, found, qty_found, loc_found, by_user, by_name, at)
  values (p_id, a.id, coalesce(a.barcode, q), a.asset_code, concat_ws(' / ', a.name_vi, nullif(a.name_en, '')), a.asset_kind, a.dept_code,
          a.location_code, a.qty, a.status_code, true, true, coalesce(a.qty, 1), v_loc, auth.uid(), am_me_name(), now())
  returning * into l;
  return to_jsonb(l) || jsonb_build_object('hit', case when a.id is null then 'unknown' else 'extra' end);
end $$;

-- Ghi tay một dòng: p_found null = trả về chưa kiểm.
create or replace function am_count_mark(p_line bigint, p_found boolean, p_qty numeric default null, p_loc text default null,
                                         p_cond text default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare l am_count_line; c am_count;
begin
  select * into l from am_count_line where id = p_line for update;
  if not found then raise exception 'Không có dòng %.', p_line; end if;
  select * into c from am_count where id = l.count_id;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if not am_count_can(c.id) then raise exception 'Bạn không kiểm được đợt này.' using errcode = '42501'; end if;
  if p_found is null and l.extra then delete from am_count_line where id = l.id; return; end if;
  update am_count_line set
    found     = p_found,
    qty_found = case when p_found is null then null when not p_found then 0 when kind = 'unique' then 1 else coalesce(p_qty, qty_found, qty_book) end,
    loc_found = case when p_found then coalesce(nullif(upper(trim(coalesce(p_loc, ''))), ''), loc_found, loc_book) end,
    cond      = case when p_found then p_cond end,
    note      = case when p_found is null then null else p_note end,
    by_user   = case when p_found is null then null else auth.uid() end,
    by_name   = case when p_found is null then null else am_me_name() end,
    at        = case when p_found is null then null else now() end
  where id = l.id;
end $$;

-- Đóng đợt. p_apply: {move: bool, lost: bool, damaged: bool, pending_missing: bool}
--   move    tài sản thấy ở vị trí khác → cập nhật vị trí trên sổ
--   lost    tài sản không thấy → lập sự cố "mất" (chờ QLTS xử lý, KHÔNG tự đổi 0)
--   damaged tài sản tình trạng "hỏng" → lập sự cố "hỏng"
--   pending_missing  dòng chưa kiểm coi như không thấy (mặc định true)
create or replace function am_count_close(p_id bigint, p_apply jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c am_count; l record; v jsonb; n_move int := 0; n_lost int := 0; n_dmg int := 0; v_inc bigint;
begin
  perform app_require('assets', 'edit');
  select * into c from am_count where id = p_id for update;
  if not found then raise exception 'Không có đợt kiểm kê %.', p_id; end if;
  if c.status <> 'open' then raise exception 'Đợt % không mở.', c.code; end if;
  if coalesce((p_apply ->> 'pending_missing')::boolean, true) then
    update am_count_line set found = false, qty_found = 0, note = coalesce(note, 'Chưa kiểm khi đóng đợt') where count_id = c.id and found is null;
  end if;
  for l in select cl.*, a.status_code as cur_status, a.dept_code as cur_dept from am_count_line cl left join am_asset a on a.id = cl.asset_id
           where cl.count_id = c.id and cl.asset_id is not null order by cl.id loop
    -- Thừa (tài sản của bộ phận khác / ngoài danh sách) KHÔNG tự đổi vị trí: đi đúng đường là phiếu điều chuyển.
    if coalesce((p_apply ->> 'move')::boolean, false) and l.found and not l.extra and l.loc_found is not null
       and l.loc_found is distinct from l.loc_book and exists (select 1 from am_location where code = l.loc_found) then
      update am_asset set location_code = l.loc_found where id = l.asset_id;
      update am_count_line set action = 'moved' where id = l.id;
      n_move := n_move + 1;
    end if;
    if coalesce((p_apply ->> 'lost')::boolean, false) and l.found = false and not l.extra and am_alive(l.cur_status)
       and not exists (select 1 from am_incident where asset_id = l.asset_id and kind = 'loss' and status in ('open', 'in_progress')) then
      v_inc := am_inc_report(jsonb_build_object('asset_id', l.asset_id, 'kind', 'loss', 'reported_at', c.count_date,
               'qty', case when l.kind = 'low' then l.qty_book - coalesce(l.qty_found, 0) end,
               'description', 'Không thấy khi kiểm kê ' || c.code, 'count_id', c.id));
      update am_count_line set action = 'incident:' || v_inc where id = l.id;
      n_lost := n_lost + 1;
    elsif coalesce((p_apply ->> 'lost')::boolean, false) and l.found and l.kind = 'low' and l.qty_found < l.qty_book and am_alive(l.cur_status)
       and not exists (select 1 from am_incident where asset_id = l.asset_id and kind = 'loss' and status in ('open', 'in_progress')) then
      v_inc := am_inc_report(jsonb_build_object('asset_id', l.asset_id, 'kind', 'loss', 'reported_at', c.count_date,
               'qty', l.qty_book - l.qty_found, 'description', 'Thiếu ' || (l.qty_book - l.qty_found) || ' khi kiểm kê ' || c.code, 'count_id', c.id));
      update am_count_line set action = 'incident:' || v_inc where id = l.id;
      n_lost := n_lost + 1;
    end if;
    if coalesce((p_apply ->> 'damaged')::boolean, false) and l.found and l.cond = 'damaged' and am_alive(l.cur_status)
       and not exists (select 1 from am_incident where asset_id = l.asset_id and kind in ('repair', 'breakage') and status in ('open', 'in_progress')) then
      v_inc := am_inc_report(jsonb_build_object('asset_id', l.asset_id, 'kind', 'repair', 'reported_at', c.count_date,
               'description', coalesce(l.note, 'Hư hỏng phát hiện khi kiểm kê ' || c.code), 'count_id', c.id));
      update am_count_line set action = coalesce(action || ' ', '') || 'incident:' || v_inc where id = l.id;
      n_dmg := n_dmg + 1;
    end if;
  end loop;
  select jsonb_build_object(
           'total',   count(*) filter (where not extra),
           'found',   count(*) filter (where not extra and found),
           'missing', count(*) filter (where not extra and found = false),
           'short',   count(*) filter (where not extra and found and kind = 'low' and qty_found < qty_book),
           'moved',   count(*) filter (where found and loc_found is distinct from loc_book and not extra),
           'extra',   count(*) filter (where extra),
           'unknown', count(*) filter (where extra and asset_id is null),
           'damaged', count(*) filter (where found and cond = 'damaged'),
           'applied', jsonb_build_object('moved', n_move, 'lost', n_lost, 'damaged', n_dmg))
    into v from am_count_line where count_id = c.id;
  update am_count set status = 'closed', closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name(), summary = v where id = c.id;
  return v;
end $$;

create or replace function am_count_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform app_require('assets', 'edit');
  update am_count set status = 'cancelled', closed_at = now(), closed_by = auth.uid(), closed_name = am_me_name()
   where id = p_id and status in ('draft', 'open');
  if not found then raise exception 'Đợt đã kết thúc hoặc không có.'; end if;
end $$;


-- =====================================================================
-- 6. BÁO CÁO ĐỊNH KỲ
-- =====================================================================

-- Số liệu hiện tại của sổ (trong phạm vi người gọi) + biến động trong [p_from, p_to].
-- Giá trị: nguyên giá kế toán khi đã ghi nhận, còn lại giá tạm (đơn giá × SL).
create or replace function am_report(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb; s text[];
begin
  perform app_require('assets', 'view');
  s := array(select app_scope_orgs());
  with a as (
    select x.*, case when x.fin_status = 'booked' and x.fin_cost is not null then x.fin_cost else coalesce(x.unit_price, 0) * coalesce(x.qty, 1) end as val,
           x.fin_status = 'booked' as booked
    from am_asset x where x.dept_code = any(s)
  ), live as (select * from a where am_alive(status_code))
  select jsonb_build_object(
    'as_of', now(), 'from', p_from, 'to', p_to,
    'totals', (select jsonb_build_object('rows', count(*), 'unique', count(*) filter (where asset_kind = 'unique'),
                                         'low_rows', count(*) filter (where asset_kind = 'low'), 'low_qty', coalesce(sum(qty) filter (where asset_kind = 'low'), 0),
                                         'value', coalesce(sum(val), 0), 'booked', count(*) filter (where booked),
                                         'booked_cost', coalesce(sum(fin_cost) filter (where booked), 0), 'nbv', coalesce(sum(fin_nbv) filter (where booked), 0),
                                         'temp', count(*) filter (where fin_status is null and not is_legacy),
                                         'temp_value', coalesce(sum(val) filter (where fin_status is null and not is_legacy), 0),
                                         'no_label', count(*) filter (where not label_printed and not coalesce(no_label, false) and not is_legacy))
               from live),
    'by_dept', (select coalesce(jsonb_agg(r order by r ->> 'dept'), '[]'::jsonb) from (
                 select jsonb_build_object('dept', dept_code, 'unique', count(*) filter (where asset_kind = 'unique'),
                                           'low_rows', count(*) filter (where asset_kind = 'low'), 'low_qty', coalesce(sum(qty) filter (where asset_kind = 'low'), 0),
                                           'value', coalesce(sum(val), 0), 'booked_cost', coalesce(sum(fin_cost) filter (where booked), 0),
                                           'nbv', coalesce(sum(fin_nbv) filter (where booked), 0), 'temp', count(*) filter (where fin_status is null and not is_legacy),
                                           'repair', count(*) filter (where status_code in ('3', '4', '5', '6', '25')),
                                           'awaiting', count(*) filter (where status_code in ('8', '24'))) r
                 from live group by dept_code) q),
    'by_group', (select coalesce(jsonb_agg(r order by r ->> 'group'), '[]'::jsonb) from (
                 select jsonb_build_object('group', group_code, 'rows', count(*), 'qty', coalesce(sum(qty), 0), 'value', coalesce(sum(val), 0)) r
                 from live group by group_code) q),
    'by_status', (select coalesce(jsonb_agg(r order by r ->> 'status'), '[]'::jsonb) from (
                 select jsonb_build_object('status', coalesce(status_code, ''), 'rows', count(*), 'qty', coalesce(sum(qty), 0), 'value', coalesce(sum(val), 0)) r
                 from a group by status_code) q),
    'movement', jsonb_build_object(
       'new', (select count(*) from a where created_at::date between p_from and p_to),
       'new_value', (select coalesce(sum(val), 0) from a where created_at::date between p_from and p_to),
       'status', (select coalesce(jsonb_object_agg(st, n), '{}'::jsonb) from (
                    select au.new_data ->> 'status_code' as st, count(*) as n from app_audit au
                    where au.tbl = 'am_asset' and au.op = 'UPDATE' and au.new_data ? 'status_code'
                      and au.at::date between p_from and p_to and au.pk in (select id::text from a)
                    group by 1) q),
       'transfers', (select count(*) from am_transfer where status = 'done' and done_at::date between p_from and p_to
                       and (from_dept = any(s) or to_dept = any(s))),
       'transfer_lines', (select count(*) from am_transfer_line tl join am_transfer t on t.id = tl.transfer_id
                            where t.status = 'done' and t.done_at::date between p_from and p_to and (t.from_dept = any(s) or t.to_dept = any(s))),
       'inc_opened', (select count(*) from am_incident where reported_at between p_from and p_to and dept_code = any(s)),
       'inc_closed', (select count(*) from am_incident where status = 'closed' and closed_at::date between p_from and p_to and dept_code = any(s)),
       'repair_cost', (select coalesce(sum(cost), 0) from am_incident where status = 'closed' and closed_at::date between p_from and p_to and dept_code = any(s)),
       'counts', (select count(*) from am_count where status = 'closed' and closed_at::date between p_from and p_to)),
    'pending', jsonb_build_object(
       'temp_old', (select count(*) from live where fin_status is null and not is_legacy and created_at < p_to - 90),
       'repair', (select count(*) from live where status_code in ('3', '5', '6', '25')),
       'beyond', (select count(*) from live where status_code = '4'),
       'awaiting', (select count(*) from live where status_code in ('8', '24')),
       'inc_open', (select count(*) from am_incident where status in ('open', 'in_progress') and dept_code = any(s)),
       'tf_open', (select count(*) from am_transfer where status = 'pending' and (from_dept = any(s) or to_dept = any(s))),
       'warranty_30', (select count(*) from live where warranty_until between p_to and p_to + 30)),
    'counts', (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'title', title, 'depts', depts, 'date', count_date, 'summary', summary)
                                         order by closed_at desc), '[]'::jsonb)
               from (select * from am_count where status = 'closed' and depts && s order by closed_at desc limit 12) q))
  into v;
  return v;
end $$;

create or replace function am_report_snap_save(p_period text, p_from date, p_to date)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform app_require('assets', 'edit');
  if coalesce(trim(p_period), '') = '' then raise exception 'Ghi tên kỳ (vd 2026-09).'; end if;
  insert into am_report_snap (period, p_from, p_to, data, created_name)
  values (trim(p_period), p_from, p_to, am_report(p_from, p_to), am_me_name())
  on conflict (period) do update set p_from = excluded.p_from, p_to = excluded.p_to, data = excluded.data,
                                     created_by = auth.uid(), created_name = excluded.created_name, created_at = now()
  returning id into v_id;
  return v_id;
end $$;


-- =====================================================================
-- 7. DÒNG ĐỜI MỘT TÀI SẢN
-- =====================================================================

create or replace function am_asset_history(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a am_asset; v jsonb;
begin
  perform app_require('assets', 'view');
  select * into a from am_asset where id = p_id;
  if not found then raise exception 'Không có tài sản %.', p_id; end if;
  if not am_in_scope(a.dept_code) then raise exception 'Tài sản nằm ngoài phạm vi của bạn.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(e order by e ->> 'at' desc), '[]'::jsonb) into v from (
    -- Nhật ký thay đổi (app_audit): tạo, và các cột có ý nghĩa với dòng đời.
    select jsonb_build_object('at', au.at, 'kind', case au.op when 'INSERT' then 'created' else 'change' end, 'who', au.email,
             'data', case au.op when 'INSERT' then jsonb_build_object('asset_code', au.new_data ->> 'asset_code', 'dept_code', au.new_data ->> 'dept_code',
                                                                      'location_code', au.new_data ->> 'location_code', 'status_code', au.new_data ->> 'status_code')
                          else (select jsonb_object_agg(k, jsonb_build_object('o', au.old_data -> k, 'n', au.new_data -> k))
                                from jsonb_object_keys(au.new_data) k
                                where k in ('status_code', 'dept_code', 'location_code', 'asset_code', 'qty', 'unit_price', 'label_printed',
                                            'fin_status', 'fin_cost', 'warranty_until', 'name_vi')) end) e
    from app_audit au where au.tbl = 'am_asset' and au.pk = p_id::text
      and (au.op = 'INSERT' or exists (select 1 from jsonb_object_keys(au.new_data) k
                                       where k in ('status_code', 'dept_code', 'location_code', 'asset_code', 'qty', 'unit_price', 'label_printed',
                                                   'fin_status', 'fin_cost', 'warranty_until', 'name_vi')))
    union all
    select jsonb_build_object('at', s.created_at, 'kind', 'intake', 'data', jsonb_build_object('shipment', s.id, 'project_code', to_jsonb(s) ->> 'project_code',
             'po', to_jsonb(s) ->> 'po_doc_no', 'supplier', to_jsonb(s) ->> 'supplier'))
    from am_shipment s where s.id = a.shipment_id
    union all
    select jsonb_build_object('at', r.created_at, 'kind', 'label',
             'data', jsonb_build_object('no', r.code))
    from am_alr_line l join am_alr r on r.id = l.alr_id where l.asset_id = p_id
    union all
    select jsonb_build_object('at', p.taken_at, 'kind', 'photo', 'who', p.taken_name, 'data', jsonb_build_object('photo_kind', p.kind))
    from am_asset_photo p where p.asset_id = p_id
    union all
    select jsonb_build_object('at', coalesce(t.done_at, t.submitted_at, t.created_at), 'kind', 'transfer', 'who', t.created_name,
             'data', jsonb_build_object('id', t.id, 'no', t.no, 'status', t.status, 'from', t.from_dept, 'to', t.to_dept, 'loc', t.to_location,
                                        'old_code', tl.old_code, 'new_code', tl.new_code, 'qty', tl.qty))
    from am_transfer_line tl join am_transfer t on t.id = tl.transfer_id where (tl.asset_id = p_id or tl.new_asset_id = p_id) and t.status <> 'cancelled'
    union all
    select jsonb_build_object('at', i.created_at, 'kind', 'incident', 'who', i.created_name,
             'data', jsonb_build_object('id', i.id, 'no', i.no, 'type', i.kind, 'status', i.status, 'outcome', i.outcome, 'cost', i.cost, 'text', i.description))
    from am_incident i where i.asset_id = p_id
    union all
    select jsonb_build_object('at', coalesce(cl.at, c.closed_at, c.opened_at), 'kind', 'count', 'who', cl.by_name,
             'data', jsonb_build_object('code', c.code, 'found', cl.found, 'qty', cl.qty_found, 'loc', cl.loc_found, 'cond', cl.cond, 'note', cl.note))
    from am_count_line cl join am_count c on c.id = cl.count_id where cl.asset_id = p_id and c.status <> 'cancelled' and cl.found is not null
    union all
    select jsonb_build_object('at', q.approved_at, 'kind', 'liquidation',
             'data', jsonb_build_object('status', q.status, 'lr', d.doc_no, 'batch', b.code, 'outcome', q.outcome, 'buyer', q.buyer, 'price', q.sale_value))
    from pm_lq_item q left join pm_doc d on d.id = q.lr_doc_id left join pm_lq_batch b on b.id = q.batch_id where q.asset_id = p_id
    union all
    select jsonb_build_object('at', ln.first_seen::date, 'kind', 'accounting',
             'data', jsonb_build_object('line', ln.description, 'cost', ln.cost, 'share', k.share, 'kind_acc', ln.kind, 'status', ln.status))
    from am_acc_link k join am_acc_line ln on ln.id = k.line_id where k.asset_id = p_id
  ) q;
  return jsonb_build_object('asset', to_jsonb(a), 'events', v,
    'incidents', (select coalesce(jsonb_agg(to_jsonb(i) order by i.id desc), '[]'::jsonb) from am_incident i where i.asset_id = p_id),
    'transfers', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'no', t.no, 'status', t.status, 'from', t.from_dept, 'to', t.to_dept) order by t.id desc), '[]'::jsonb)
                  from am_transfer t where exists (select 1 from am_transfer_line tl where tl.transfer_id = t.id and (tl.asset_id = p_id or tl.new_asset_id = p_id))));
end $$;


-- =====================================================================
-- 8. QUYỀN
-- =====================================================================

alter table am_transfer      enable row level security;
alter table am_transfer_line enable row level security;
alter table am_incident      enable row level security;
alter table am_count         enable row level security;
alter table am_count_line    enable row level security;
alter table am_report_snap   enable row level security;

revoke all on am_transfer, am_transfer_line, am_incident, am_count, am_count_line, am_report_snap from anon, authenticated;
grant select on am_transfer, am_transfer_line, am_incident, am_count, am_count_line, am_report_snap to authenticated;

drop policy if exists am_transfer_read on am_transfer;
create policy am_transfer_read on am_transfer for select to authenticated
  using ((select app_can('assets', 'view')) and (am_in_scope(from_dept) or am_in_scope(to_dept) or created_by = auth.uid()));
drop policy if exists am_transfer_line_read on am_transfer_line;
create policy am_transfer_line_read on am_transfer_line for select to authenticated
  using (exists (select 1 from am_transfer t where t.id = transfer_id));
drop policy if exists am_incident_read on am_incident;
create policy am_incident_read on am_incident for select to authenticated
  using ((select app_can('assets', 'view')) and (am_in_scope(dept_code) or created_by = auth.uid()));
drop policy if exists am_count_read on am_count;
create policy am_count_read on am_count for select to authenticated
  using ((select app_can('assets', 'view')) and (depts && array(select app_scope_orgs()) or am_count_can(id)));
drop policy if exists am_count_line_read on am_count_line;
create policy am_count_line_read on am_count_line for select to authenticated
  using (exists (select 1 from am_count c where c.id = count_id));
drop policy if exists am_report_snap_read on am_report_snap;
create policy am_report_snap_read on am_report_snap for select to authenticated
  using ((select app_can('assets', 'view')));

-- Nhật ký thay đổi cho các bảng mới.
do $$
declare t text;
begin
  foreach t in array array['am_transfer', 'am_transfer_line', 'am_incident', 'am_count', 'am_report_snap'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke execute on function
  am_me_name(), am_in_scope(text), am_company_of(text), am_actors(jsonb, text), am_is_actor(jsonb, text),
  am_notify(uuid[], text, text, text, text, text), am_alive(text), am_tf_steps(text, text), am_tf_apply(bigint),
  am_count_can(bigint),
  am_tf_save(bigint, jsonb), am_tf_submit(bigint), am_tf_act(bigint, text, text), am_tf_cancel(bigint, text), am_tf_inbox(),
  am_inc_report(jsonb), am_inc_update(bigint, jsonb), am_inc_close(bigint, text, text, numeric), am_inc_cancel(bigint, text),
  am_count_save(bigint, jsonb), am_count_open(bigint), am_count_scan(bigint, text, text),
  am_count_mark(bigint, boolean, numeric, text, text, text), am_count_close(bigint, jsonb), am_count_cancel(bigint),
  am_report(date, date), am_report_snap_save(text, date, date), am_asset_history(bigint)
  from public, anon;
grant execute on function
  am_tf_save(bigint, jsonb), am_tf_submit(bigint), am_tf_act(bigint, text, text), am_tf_cancel(bigint, text), am_tf_inbox(),
  am_inc_report(jsonb), am_inc_update(bigint, jsonb), am_inc_close(bigint, text, text, numeric), am_inc_cancel(bigint, text),
  am_count_save(bigint, jsonb), am_count_open(bigint), am_count_scan(bigint, text, text),
  am_count_mark(bigint, boolean, numeric, text, text, text), am_count_close(bigint, jsonb), am_count_cancel(bigint),
  am_report(date, date), am_report_snap_save(text, date, date), am_asset_history(bigint),
  -- dùng trong policy đọc (chạy bằng quyền người đọc):
  am_in_scope(text), am_count_can(bigint)
  to authenticated;

-- Lưới an toàn cho project dùng chung (xem app_lock_anon trong 17_auth.sql).
select app_lock_anon();


-- =====================================================================
-- 9. KIỂM CHỨNG
-- =====================================================================

select 'Bảng quản lý tài sản có RLS' as "Mục", count(*)::text as "Thực tế", '6' as "Mong đợi",
       case when count(*) = 6 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('am_transfer', 'am_transfer_line', 'am_incident', 'am_count', 'am_count_line', 'am_report_snap') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng các bảng mới (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name in ('am_transfer', 'am_transfer_line', 'am_incident', 'am_count', 'am_count_line', 'am_report_snap')
  and  privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Hàm điều chuyển / sự cố / kiểm kê / báo cáo / dòng đời', count(*)::text, '18', case when count(*) = 18 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('am_tf_save', 'am_tf_submit', 'am_tf_act', 'am_tf_cancel', 'am_tf_inbox', 'am_inc_report', 'am_inc_update',
                                 'am_inc_close', 'am_inc_cancel', 'am_count_save', 'am_count_open', 'am_count_scan', 'am_count_mark',
                                 'am_count_close', 'am_count_cancel', 'am_report', 'am_report_snap_save', 'am_asset_history')
union all
select 'Cột hạn bảo hành', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end
from   information_schema.columns where table_name = 'am_asset' and column_name = 'warranty_until';

