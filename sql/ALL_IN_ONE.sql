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
create or replace view am_data_source_current as
select distinct on (table_name)
       table_name, source_file, source_kind, rows_loaded, loaded_at, loaded_by, note
from   am_data_source
order  by table_name, loaded_at desc;

alter table am_data_source enable row level security;

drop policy if exists am_data_source_read  on am_data_source;
drop policy if exists am_data_source_write on am_data_source;
create policy am_data_source_read  on am_data_source
  for select to anon, authenticated using (true);
create policy am_data_source_write on am_data_source
  for insert to anon, authenticated with check (true);
-- No update and no delete policy: the provenance log is append-only.

grant select, insert on am_data_source to anon, authenticated;
grant select on am_data_source_current to anon, authenticated;
grant usage, select on sequence am_data_source_id_seq to anon, authenticated;

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
-- ---------------------------------------------------------------------
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

grant execute on function am_suggest_lines(text[]) to anon, authenticated;
grant execute on function am_suggest_detail(text)  to anon, authenticated;

