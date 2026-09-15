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
