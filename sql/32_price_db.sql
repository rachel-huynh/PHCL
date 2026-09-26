-- =====================================================================
-- 32_price_db.sql — CƠ SỞ DỮ LIỆU GIÁ THAM CHIẾU (26/09/2026)
--
-- Chạy SAU 31_asset_ops.sql (đọc pm_doc, pm_tender*, am_shipment, am_asset).
-- Chạy lại nhiều lần vô hại. KHÔNG chạy ALL_IN_ONE.
--
-- Mục đích: tra cứu, so sánh giá — KHÁC sổ tài sản. Phạm vi: vật tư kỹ thuật
-- và FF&E như file "Reference Pricing List" (quyết định 26/09/2026).
--
--   pr_source   một NGUỒN giá: báo giá (trúng hay không), market check, hồ sơ
--               dự thầu, QC, PO, phiếu nhận hàng, dữ liệu Excel cũ.
--   pr_line     từng dòng giá của nguồn: tên gốc, tên chuẩn (gán dần), nhóm,
--               hãng, model, thông số, SL, đơn vị gốc / chuẩn, đơn giá vật tư +
--               nhân công, giá quy đổi VND chưa VAT / đơn vị (price_vnd).
--   pr_unit     bảng quy đổi đơn vị (cái/pcs, bộ/set, m²/m2, mét/md …); đơn vị
--               trọn gói (gói / lô / hệ …) đánh dấu lump = không so theo đơn giá.
--   pr_alias    tên gốc (chuẩn hoá) → tên chuẩn, học từ mỗi lần QLTS gán tên,
--               áp lại cho mọi dòng cũ và mới.
--
-- Nguồn tự động (pr_sync): QC (mọi nhà cung cấp; A đã duyệt = trúng), MC (giá
-- lịch sử B, giá thị trường C), PO (giá chốt), hồ sơ dự thầu đã mở niêm phong,
-- phiếu nhận hàng (giá mua thực tế). Nguồn tay: Excel cũ, báo giá nhập bằng
-- JSON (AI trích như phiếu giao hàng).
--
-- Quyền (quyết định 26/09/2026): nhóm QLTS nhập (khu "price": C/E); mọi bộ
-- phận xem giá tham chiếu (V) — KHÔNG thấy tên nhà cung cấp: bảng chỉ đọc được
-- khi có quyền nhập; người chỉ xem tra qua pr_search() (ẩn nhà cung cấp, liên
-- hệ, file). Giá bán thanh lý KHÔNG đưa vào đây (đã có ở module Thanh lý).
--
-- File báo giá: để trên OneDrive, lưu link (file_url) hoặc tên file ghép với
-- đường dẫn thư mục ở am_setting 'pr_quotes_base_url'.
--
-- Chỉ đụng vào bảng / hàm có tên của app này; cuối file gọi app_lock_anon().
-- =====================================================================


-- =====================================================================
-- 1. KHU QUYỀN
-- =====================================================================

insert into app_module (code, name_en, name_vi, sort) values
  ('price', 'Price reference', 'CSDL giá tham chiếu', 88)
on conflict (code) do update set name_en = excluded.name_en, name_vi = excluded.name_vi, sort = excluded.sort;

-- QLTS nhập / sửa; mọi vai trò khác chỉ xem giá tham chiếu. "do nothing": ô đã chỉnh ở màn Phân quyền giữ nguyên.
insert into app_permission (role_code, module_code, can_view, can_create, can_edit, can_approve, can_admin)
select r.code, 'price', true,
       r.code in ('AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       r.code in ('AM_COORD', 'AM_EXEC', 'SYS_ADMIN'),
       false,
       r.code in ('AM_COORD', 'SYS_ADMIN')
from   app_role r
on conflict (role_code, module_code) do nothing;

insert into am_setting (key, value, note) values
  ('pr_quotes_base_url', '""'::jsonb,
   'CSDL giá: đường dẫn thư mục báo giá trên OneDrive/SharePoint (vd https://…/QUOTES/) — app ghép thêm tên file để mở báo giá gốc')
on conflict (key) do nothing;


-- =====================================================================
-- 2. BẢNG
-- =====================================================================

create table if not exists pr_import (
  id          bigserial primary key,
  kind        text not null,                     -- legacy | json
  file_name   text,
  stats       jsonb,
  created_by  uuid default auth.uid(),
  created_name text,
  created_at  timestamptz not null default now()
);

create table if not exists pr_source (
  id           bigserial primary key,
  kind         text not null check (kind in ('legacy', 'quote', 'qc', 'mc_hist', 'mc_market', 'po', 'tender', 'intake', 'market')),
  origin_key   text unique,                      -- nguồn tự động: qc:<doc>:<i>, po:<doc>, …; legacy: legacy:Báo giá (n)
  ref          text,                             -- "Báo giá (27)", số chứng từ, số phiếu…
  supplier     text,
  contact      text,                             -- email / điện thoại
  quote_date   date,                             -- null = chưa rõ ngày
  project_code text,
  project_name text,
  currency     text not null default 'VND',
  fx_rate      numeric(18, 6) not null default 1,
  vat_included boolean not null default false,
  won          boolean,                          -- true trúng / chốt · false không trúng · null chưa rõ
  delivery_term text,
  install_term  text,
  payment_term  text,
  file_name    text,
  file_url     text,
  note         text,
  import_id    bigint references pr_import(id) on delete set null,
  created_by   uuid default auth.uid(),
  created_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pr_source_kind_idx on pr_source (kind);

create table if not exists pr_line (
  id           bigserial primary key,
  source_id    bigint not null references pr_source(id) on delete cascade,
  line_no      int,
  section      text,                             -- tiêu đề nhóm phía trên dòng trong báo giá
  name_raw     text not null,
  name_std     text,                             -- tên chuẩn (gán dần, học qua pr_alias)
  category_code text,
  line_kind    text not null default 'goods' check (line_kind in ('goods', 'service', 'lump')),
  brand        text,
  model        text,
  origin       text,
  spec         jsonb not null default '{}'::jsonb,
  qty          numeric(18, 3),
  unit_raw     text,
  unit         text,                             -- đơn vị chuẩn
  unit_price   numeric(18, 2),                   -- đơn giá vật tư (theo tiền tệ nguồn, như ghi trên báo giá)
  labor_price  numeric(18, 2),                   -- đơn giá nhân công / lắp đặt
  vat_rate     numeric(6, 4),
  price_vnd    numeric(18, 2),                   -- (vật tư + nhân công) × tỷ giá, CHƯA VAT, / 1 đơn vị — dùng để so sánh
  note         text,
  uncertain    jsonb not null default '[]'::jsonb,
  search_norm  text                              -- am_norm(tên + tên chuẩn + hãng + model + nhóm): tra cứu không dấu
);
create index if not exists pr_line_source_idx on pr_line (source_id);

create table if not exists pr_unit (
  raw_norm text primary key,
  unit     text not null,
  lump     boolean not null default false
);

create table if not exists pr_alias (
  name_norm  text primary key,
  name_std   text not null,
  category_code text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- TỪ VỰNG TÊN CHUẨN (26/09/2026): mỗi tên chuẩn "VI/EN" một nhóm giá và các TỪ KHOÁ (không dấu,
-- chữ thường). Dòng giá nhận tên chuẩn theo từ khoá xuất hiện SỚM NHẤT trong tên (sau khi bỏ các
-- động từ đầu câu "cung cấp và lắp đặt", "thay", "báo giá"…), bằng nhau thì từ khoá DÀI hơn thắng.
-- Từ khoá ≤ 3 ký tự chỉ tính ở đầu tên (tránh "co" trong "có", "te" trong "thực tế"); tiền tố "*"
-- cho phép khớp ở bất kỳ đâu. Soạn và thử trên 2.554 dòng của file cũ: 96,8% dòng có tên chuẩn.
-- Nhóm: HVAC điều hoà thông gió · PLB cấp thoát nước · ELE điện · ICT CNTT & AV · KIT bếp & giặt ·
-- DOR cửa, kính, phụ kiện · FIN hoàn thiện · SAN thiết bị vệ sinh · FUR nội thất · FPS PCCC ·
-- SRV nhân công & dịch vụ · OTH khác. Sửa / thêm trong app (tab Chuẩn hoá tên).
create table if not exists pr_term (
  id         serial primary key,
  std_vi     text not null unique,
  std_en     text not null,
  grp        text not null,
  kind       text not null default 'goods' check (kind in ('goods', 'service', 'other', 'heading')),
  patterns   text[] not null default '{}',
  sort       int not null default 1000,
  active     boolean not null default true,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

alter table pr_alias add column if not exists term_id int references pr_term(id) on delete set null;
alter table pr_line add column if not exists term_id int references pr_term(id) on delete set null;
alter table pr_line add column if not exists grp     text;
alter table pr_line add column if not exists variant text;          -- DN32 · 10 ly · 15 HP · 600x400 … lấy từ tên
alter table pr_line add column if not exists std_src text;          -- rule · alias · manual · none (null = chưa xét)
alter table pr_line drop constraint if exists pr_line_std_src_check;
alter table pr_line add constraint pr_line_std_src_check check (std_src is null or std_src in ('rule', 'alias', 'manual', 'none'));
alter table pr_line drop constraint if exists pr_line_line_kind_check;
alter table pr_line add constraint pr_line_line_kind_check check (line_kind in ('goods', 'service', 'lump', 'other'));
create index if not exists pr_line_term_idx on pr_line (term_id);
create index if not exists pr_line_std_src_idx on pr_line (std_src);

-- 237 tên chuẩn ban đầu. "do nothing": tên đã sửa trong app giữ nguyên khi chạy lại file.
insert into pr_term (std_vi, std_en, grp, kind, patterns, sort) values
  ('Máy lạnh', 'Air conditioner', 'HVAC', 'goods', array['may lanh','dieu hoa','may dhkk','dhkk packaged','may dieu hoa','air conditioner'], 10),
  ('FCU', 'Fan coil unit', 'HVAC', 'goods', array['fcu','fan coil'], 20),
  ('AHU', 'Air handling unit', 'HVAC', 'goods', array['ahu','air handling unit'], 30),
  ('Dàn lạnh PAU', 'PAU unit', 'HVAC', 'goods', array['dan lanh pau','pau'], 40),
  ('Máy nén', 'Compressor', 'HVAC', 'goods', array['may nen','may nen lanh','compressor'], 50),
  ('Bầu giải nhiệt', 'Heat exchanger', 'HVAC', 'goods', array['bau giai nhiet','heat exchanger'], 60),
  ('Van tiết lưu', 'Expansion valve', 'HVAC', 'goods', array['van tiet luu','expansion valve'], 70),
  ('Phin lọc gas', 'Filter drier', 'HVAC', 'goods', array['phin loc gas','phin loc'], 80),
  ('Lắc lạnh', 'Refrigerant shaker valve', 'HVAC', 'goods', array['lac lanh'], 90),
  ('Nạp gas lạnh', 'Refrigerant charging', 'HVAC', 'service', array['nap gas','sac gas','charge gas','nap gas bo sung'], 100),
  ('Thử kín hệ thống', 'Leak test (nitrogen)', 'HVAC', 'service', array['nen nito','thu kin'], 110),
  ('Bộ ổn nhiệt', 'Thermostat', 'HVAC', 'goods', array['thermostat','themostat','thermkostac','bo on nhiet','bo chinh nhiet do'], 120),
  ('Ống gió chống cháy', 'Fire-rated air duct', 'HVAC', 'goods', array['ong gio chong chay'], 130),
  ('Ống gió', 'Air duct', 'HVAC', 'goods', array['ong gio','duong ong gio','he thong duong ong gio','ong gio g i'], 140),
  ('Ống gió mềm', 'Flexible duct', 'HVAC', 'goods', array['ong gio mem'], 150),
  ('Co ống gió', 'Duct elbow', 'HVAC', 'goods', array['co ong gio'], 160),
  ('Chân rẽ ống gió', 'Duct branch', 'HVAC', 'goods', array['chan re'], 170),
  ('Nối vuông tròn', 'Duct transition', 'HVAC', 'goods', array['noi vuong tron'], 180),
  ('Miệng gió', 'Air grille, diffuser', 'HVAC', 'goods', array['mieng gio','cua gio'], 190),
  ('Box gió', 'Plenum box', 'HVAC', 'goods', array['box gio','hop box ket noi ong gio','hop gio'], 200),
  ('Van gió ngăn cháy', 'Fire damper', 'HVAC', 'goods', array['van gio ngan chay','van chong chay'], 210),
  ('Phụ kiện ống gió', 'Duct accessories', 'HVAC', 'goods', array['phu kien ket noi ong gio','bo ti treo','ti treo','simili chong chay'], 220),
  ('Ống đồng máy lạnh', 'Copper refrigerant pipe', 'HVAC', 'goods', array['ong dong','noi dong'], 230),
  ('Bọc cách nhiệt', 'Insulation', 'HVAC', 'goods', array['boc cach nhiet','cach nhiet','bao on','superlon','supperlon','maxilite'], 240),
  ('Bơm nước ngưng', 'Condensate pump', 'HVAC', 'goods', array['bom nuoc ngung'], 250),
  ('Ống nước ngưng', 'Condensate pipe', 'HVAC', 'goods', array['ong nuoc ngung'], 260),
  ('Quạt thông gió', 'Ventilation fan', 'HVAC', 'goods', array['quat thong gio','ventilator','fan'], 270),
  ('Tấm tản nhiệt tháp giải nhiệt', 'Cooling tower fill', 'HVAC', 'goods', array['tam tan nhiet','thap giai nhiet'], 280),
  ('Hệ thống hút khói, cấp gió', 'Smoke extraction, pressurisation system', 'HVAC', 'goods', array['he thong hut khoi','he thong cap bu gio','hut khoi'], 290),
  ('Cải tạo kho lạnh', 'Cold room renovation', 'HVAC', 'goods', array['kho lanh','cold room','cold storage','freezer','renovation of freezer','renew evaporator','renew control cabinet'], 300),
  ('Đèn kho lạnh', 'Cold room light', 'HVAC', 'goods', array['den kho lanh','den led kho lanh','lamp of cold storage'], 310),
  ('Vệ sinh dàn nóng, dàn lạnh', 'Coil cleaning', 'HVAC', 'service', array['ve sinh dan nong','cleaning condenser','hoa chat ve sinh dan'], 320),
  ('Ống PPR', 'PPR pipe', 'PLB', 'goods', array['ong ppr','ong nhua ppr','ong nuoc nong ppr','ong nuoc lanh ppr','ong nuoc nong pprr'], 330),
  ('Ống PVC', 'PVC pipe', 'PLB', 'goods', array['ong pvc','ong nhua pvc','ong nuoc pvc','ong cung pvc','ong nhua xam'], 340),
  ('Ống thép tráng kẽm', 'Galvanised steel pipe', 'PLB', 'goods', array['ong sat trang kem','ong thep trang kem','ong kem','ong thep','he thong duong ong sat','ong sat','dn 32 thk'], 350),
  ('Co, cút', 'Elbow fitting', 'PLB', 'goods', array['co','co kem','co ppr','co 45','co 90','elbow'], 360),
  ('Tê', 'Tee fitting', 'PLB', 'goods', array['te','te deu','te giam','te kem','te ppr','t ppr'], 370),
  ('Nối ống', 'Pipe coupling', 'PLB', 'goods', array['noi ong','noi ppr','noi chan','noi'], 380),
  ('Giảm, côn thu', 'Reducer', 'PLB', 'goods', array['giam','giam han'], 390),
  ('Mặt bích', 'Flange', 'PLB', 'goods', array['mat bich'], 400),
  ('Rắc co', 'Union', 'PLB', 'goods', array['rac co'], 410),
  ('Kép hai đầu ren', 'Threaded nipple', 'PLB', 'goods', array['hai dau ren'], 420),
  ('Phụ kiện đường ống', 'Pipe fittings', 'PLB', 'goods', array['phu kien duong ong','fitting','phu kien han','pipe','duong ong va van'], 430),
  ('Khớp nối mềm', 'Flexible joint', 'PLB', 'goods', array['khop noi mem'], 440),
  ('Van cổng', 'Gate valve', 'PLB', 'goods', array['van cong'], 450),
  ('Van bướm', 'Butterfly valve', 'PLB', 'goods', array['van buom'], 460),
  ('Van một chiều', 'Check valve', 'PLB', 'goods', array['van 1 chieu','van mot chieu'], 470),
  ('Van an toàn', 'Safety valve', 'PLB', 'goods', array['van an toan','pressure relief valve'], 480),
  ('Cụm van giảm áp', 'Pressure reducing valve set', 'PLB', 'goods', array['cum van giam ap','van giam ap'], 490),
  ('Cụm van FCU', 'FCU valve set', 'PLB', 'goods', array['cum van'], 500),
  ('Van điện từ, van ON-OFF', 'Motorised valve', 'PLB', 'goods', array['van dien tu','on off'], 510),
  ('Van PICV', 'PICV valve', 'PLB', 'goods', array['van picv','picv'], 520),
  ('Van cửa PPR', 'PPR stop valve', 'PLB', 'goods', array['van cua ppr'], 530),
  ('Lọc Y', 'Y-strainer', 'PLB', 'goods', array['loc y'], 540),
  ('Bơm chìm nước thải', 'Submersible sewage pump', 'PLB', 'goods', array['bom chim','may bom chim','bom nuoc thai','bom chim nuoc thai'], 550),
  ('Lắp đặt bơm & đường ống', 'Pump & piping installation', 'PLB', 'service', array['lap dat he thong gom 2 bom','lap dat ong va van cho cum 2 bom'], 560),
  ('Lò xo giảm chấn', 'Vibration isolator', 'PLB', 'goods', array['lo xo giam chan','bo ti treo chong rung'], 570),
  ('Cùm treo ống', 'Pipe clamp', 'PLB', 'goods', array['cum treo','kep ong'], 580),
  ('Ty ren, bulong', 'Threaded rod, bolt', 'PLB', 'goods', array['ty ren','bulong','bu long','tac ke','tan long den'], 590),
  ('Giá đỡ ống', 'Pipe support', 'PLB', 'goods', array['he thong gia do','vat tu support'], 600),
  ('Phễu thoát sàn', 'Floor drain', 'PLB', 'goods', array['phieu thoat','pheu thoat','phieu thu','ga thoat nuoc san'], 610),
  ('Vĩ thoát sàn inox', 'Stainless floor grating', 'PLB', 'goods', array['vi thoat san'], 620),
  ('Di dời đường ống nước', 'Water pipe relocation', 'PLB', 'service', array['di doi duong ong','di lai ong nuoc','cat ong hien huu'], 630),
  ('Cáp điện', 'Power cable', 'ELE', 'goods', array['cap cap nguon','cap dien','cap dong luc','cadivi'], 640),
  ('Dây điện', 'Electric wire', 'ELE', 'goods', array['day dien','day nguon','day dien nguon','day cap'], 650),
  ('Cáp điều khiển', 'Control cable', 'ELE', 'goods', array['cap dieu khien','day dien dieu khien','he thong day dien dieu khien','day dien remote'], 660),
  ('Công tắc', 'Light switch', 'ELE', 'goods', array['cong tac','double pole switch'], 670),
  ('Ổ cắm điện', 'Socket outlet', 'ELE', 'goods', array['o cam','o cam dien'], 680),
  ('Ổ cắm mạng, điện thoại', 'Data, phone outlet', 'ELE', 'goods', array['o cam mang','o cam dien thoai'], 690),
  ('Đế âm', 'Back box', 'ELE', 'goods', array['de am'], 700),
  ('Aptomat MCB, RCBO', 'Circuit breaker', 'ELE', 'goods', array['mcb','rcbo','cb'], 710),
  ('Contactor', 'Contactor', 'ELE', 'goods', array['contactor'], 720),
  ('Relay trung gian', 'Relay', 'ELE', 'goods', array['relay','replay','relay board'], 730),
  ('Tủ điện', 'Electrical panel', 'ELE', 'goods', array['tu dien','renew control cabinet','sua chua tu dien'], 740),
  ('Ống luồn dây điện', 'Electrical conduit', 'ELE', 'goods', array['ong luon','ong luong','ong dien','ong cung'], 750),
  ('Ruột gà luồn dây', 'Flexible conduit', 'ELE', 'goods', array['ruot ga','ong ruot ga'], 760),
  ('Máng cáp, trunking', 'Cable trunking', 'ELE', 'goods', array['trunking','trunkin','trung kinh','mang cap'], 770),
  ('Nẹp nhựa', 'Plastic cable trim', 'ELE', 'goods', array['nep nhua'], 780),
  ('Đèn LED âm trần', 'LED downlight', 'ELE', 'goods', array['bong den led am tran','den led','den am tran'], 790),
  ('Đèn trang trí, đèn thả', 'Decorative light', 'ELE', 'goods', array['bong den','den pha ray','den tha','phu kien ket noi den'], 800),
  ('Chuông cửa phòng', 'Door bell', 'ELE', 'goods', array['chuong phong','chuong'], 810),
  ('Bộ nút chuông & đèn báo phòng', 'Doorbell & DND panel', 'ELE', 'goods', array['bo nut nhan chuong'], 820),
  ('Ắc quy', 'Battery', 'ELE', 'goods', array['ac quy','acquy','rbc55','pin du phong','bao gia acquy'], 830),
  ('Bộ lưu điện (UPS)', 'UPS', 'ELE', 'goods', array['bo luu dien','ups','santak','c3k'], 840),
  ('Thanh ổ điện (PDU)', 'Power distribution unit', 'ELE', 'goods', array['thanh o dien'], 850),
  ('Hệ thống điện (thi công)', 'Electrical works', 'ELE', 'service', array['thi cong cap nguon','ket noi he thong dien','he thong dien','thi cong lai he thong dien','ket noi cap dong luc'], 860),
  ('Vật tư điện', 'Electrical materials', 'ELE', 'goods', array['vat tu thi cong lai he thong dien','phu kien ong dien','phu kien lap dat cong tac','phu kien dau noi lap dat tu dien','bam cos'], 870),
  ('Máy tính xách tay', 'Laptop', 'ICT', 'goods', array['may tinh xach tay','laptop','probook','elitebook'], 880),
  ('Máy tính để bàn', 'Desktop PC', 'ICT', 'goods', array['may tinh de ban','may tinh ban','may tinh mini','may vi tinh lap rap','may tinh pc','imac','mini ops computer','ops computer'], 890),
  ('Máy trạm', 'Workstation', 'ICT', 'goods', array['workstation'], 900),
  ('Máy tính bảng', 'Tablet', 'ICT', 'goods', array['may tinh bang','ipad','ipda','tablets','tablet'], 910),
  ('Màn hình máy tính', 'Computer monitor', 'ICT', 'goods', array['man hinh may tinh','man hinh vi tinh','man hinh hp','monitor'], 920),
  ('Máy in', 'Printer', 'ICT', 'goods', array['may in','printer','laserjet'], 930),
  ('Máy chủ', 'Server', 'ICT', 'goods', array['may chu','server','hpe dl'], 940),
  ('Linh kiện máy chủ', 'Server component', 'ICT', 'goods', array['power supply','*b21','*l21','ssd','network module','stack power cable','stacking cable','stack module','power cord','power cable'], 950),
  ('Switch mạng', 'Network switch', 'ICT', 'goods', array['switch','catalyst'], 960),
  ('Tường lửa', 'Firewall', 'ICT', 'goods', array['ngfw','firewall','forcepoint','giai phap ngfw'], 970),
  ('Bản quyền phần mềm', 'Software licence', 'ICT', 'goods', array['license','licence','ban quyen','windows','office ltsc','microsoft 365','phan mem ban quyen'], 980),
  ('Phần mềm, dịch vụ cloud', 'Software, cloud subscription', 'ICT', 'goods', array['phan mem','cloud','saas','subscription','infrasys','oracle','opera','simphony','sunsystems','infor','cong thong tin nhan vien','tinh luong','quan ly bua an','cham cong','phan he'], 990),
  ('Dịch vụ triển khai phần mềm', 'Software implementation', 'ICT', 'service', array['interface','setup','set up','configuration','implementation','training','report build','manday','customisation','tich hop','ho tro tich','data export','upgrade services','vas report','value added services','tinh chinh'], 1000),
  ('Hỗ trợ & bảo hành phần mềm, thiết bị', 'Support & extended warranty', 'ICT', 'service', array['support','extended warranty','sntc','maintenance','css','live support','trg','phi quan ly thiet bi','phi dich vu'], 1010),
  ('Cáp mạng', 'Network cable', 'ICT', 'goods', array['cap mang','day cap mang','day mang','cable mang'], 1020),
  ('Đầu mạng RJ45', 'RJ45 connector', 'ICT', 'goods', array['dau bam','dau mang','rj45','dau chup mang'], 1030),
  ('Tủ mạng', 'Network rack', 'ICT', 'goods', array['tu mang'], 1040),
  ('Camera IP', 'IP camera', 'ICT', 'goods', array['camera ip','camera'], 1050),
  ('Đầu ghi hình', 'NVR', 'ICT', 'goods', array['dau ghi hinh','nvr'], 1060),
  ('Ổ cứng', 'Hard disk', 'ICT', 'goods', array['o cung','thiet bi luu tru data'], 1070),
  ('Máy chấm công', 'Time attendance device', 'ICT', 'goods', array['may cham cong','thiet bi may cham cong','dung luong luu tru','dung luong du tru'], 1080),
  ('Máy quét hộ chiếu, CCCD', 'Passport, ID scanner', 'ICT', 'goods', array['passport scanner','scanner','id card reading','e passport'], 1090),
  ('Két tiền', 'Cash drawer', 'ICT', 'goods', array['cash drawer'], 1100),
  ('Thẻ nhân viên, thẻ POS', 'Staff card', 'ICT', 'goods', array['employee cards','staff card'], 1110),
  ('Tivi', 'Television', 'ICT', 'goods', array['tivi','hotel tv','smart tivi','tv','samsung hg55'], 1120),
  ('Apple TV', 'Apple TV', 'ICT', 'goods', array['apple tv'], 1130),
  ('Màn hình quảng cáo', 'Digital signage', 'ICT', 'goods', array['man hinh quang cao','digital signage'], 1140),
  ('Máy chiếu', 'Projector', 'ICT', 'goods', array['may chieu','projector','lcd projectors'], 1150),
  ('Ống kính máy chiếu', 'Projector lens', 'ICT', 'goods', array['ong lens','zoom lens'], 1160),
  ('Màn hình tương tác', 'Interactive flat panel', 'ICT', 'goods', array['interactive flat panel'], 1170),
  ('Thiết bị hội nghị', 'Conference equipment', 'ICT', 'goods', array['conference mic','speakerphone','webcam','camera 4k','smart pen','wireless mirroring','amx controller','neutrik'], 1180),
  ('Giá treo màn hình', 'Screen bracket, stand', 'ICT', 'goods', array['mobile bracket','gia treo','adjustable stand','gia do may tinh bang','carrying pouch'], 1190),
  ('Cáp HDMI', 'HDMI cable', 'ICT', 'goods', array['cap hdmi'], 1200),
  ('Cáp truyền hình', 'TV cable', 'ICT', 'goods', array['day cap tivi'], 1210),
  ('Balo, phụ kiện máy tính', 'Computer accessory', 'ICT', 'goods', array['balo laptop'], 1220),
  ('Tủ mát', 'Upright chiller', 'KIT', 'goods', array['tu mat','upright chiller','bao gia tu mat'], 1230),
  ('Tủ minibar', 'Minibar', 'KIT', 'goods', array['tu minibar','mini bar'], 1240),
  ('Máy làm đá', 'Ice machine', 'KIT', 'goods', array['may lam da','scotsman','scotman'], 1250),
  ('Bếp chiên phẳng', 'Griddle', 'KIT', 'goods', array['bep chien phang','smooth plate'], 1260),
  ('Bếp điện', 'Electric range', 'KIT', 'goods', array['bep dien','electric range','hot plate','4 hot plate'], 1270),
  ('Bếp nướng than', 'Char broiler', 'KIT', 'goods', array['bep nuong','char rock broiler'], 1280),
  ('Lò hấp nướng đa năng', 'Combi oven', 'KIT', 'goods', array['lo hap nuong','lo nuong','oven'], 1290),
  ('Bếp', 'Cooking range', 'KIT', 'goods', array['bep','bao gia bep'], 1300),
  ('Máy rửa bát', 'Dishwasher', 'KIT', 'goods', array['may rua bat','dishwasher','under counter dishwasher'], 1310),
  ('Máy ép trái cây', 'Juicer', 'KIT', 'goods', array['may ep trai cay','may ep'], 1320),
  ('Chậu rửa chén', 'Kitchen sink', 'KIT', 'goods', array['chau chen','chau rua chen','bon rua'], 1330),
  ('Vòi bếp', 'Kitchen tap', 'KIT', 'goods', array['voi bep'], 1340),
  ('Bàn inox', 'Stainless steel table', 'KIT', 'goods', array['ban inox'], 1350),
  ('Mặt kính ceramic bếp', 'Ceramic glass plate', 'KIT', 'goods', array['ceramic glass plate'], 1360),
  ('Thanh nhiệt', 'Heating element', 'KIT', 'goods', array['heating element','fin heatingnelement'], 1370),
  ('Vỉ lưới inox bồn rửa', 'Sink grating', 'KIT', 'goods', array['vi inox bon rua','vi luoi inox'], 1380),
  ('Lưới lọc rác bồn rửa', 'Sink strainer', 'KIT', 'goods', array['luoi loc','loc rac bon rua'], 1390),
  ('Hệ thống chữa cháy bếp', 'Kitchen fire suppression', 'FPS', 'goods', array['ansul','fire suppression','fire extinguish system','banquet','bistro','canteen'], 1400),
  ('Máy sấy công nghiệp', 'Industrial dryer', 'KIT', 'goods', array['may say','industrial dryer','girbau'], 1410),
  ('Máy giặt sấy', 'Washer-dryer', 'KIT', 'goods', array['washer dryer','stack washer','may giat','long giat'], 1420),
  ('Máy phun rửa áp lực', 'Pressure washer', 'KIT', 'goods', array['may phun rua','karcher'], 1430),
  ('UV lamp chụp hút', 'Hood UV lamp', 'KIT', 'goods', array['uv lamp'], 1440),
  ('Cửa thép chống cháy', 'Fire-rated steel door', 'DOR', 'goods', array['cua thep chong chay','cua di 1 canh','cua di 2 canh','cua chong chay'], 1450),
  ('Ô kính chống cháy', 'Fire-rated glass panel', 'DOR', 'goods', array['o kinh chong chay','o kinh luoi chong chay'], 1460),
  ('Cửa tự động', 'Automatic door', 'DOR', 'goods', array['cua tu dong','bo cua tu dong','cua truot tu dong','bo tu dong','bo dieu khien cua truot','khoa chuyen dung cho cua tu dong','cam bien an toan','es200','kyk'], 1470),
  ('Cửa nhôm kính', 'Aluminium glass door', 'DOR', 'goods', array['cua nhom','cua mo','xingfa','canh cua khung bao nhom','ma d1a','ma d1b'], 1480),
  ('Vách kính cường lực', 'Tempered glass partition', 'DOR', 'goods', array['vach kinh','cua truot bao gom'], 1490),
  ('Kính cường lực', 'Tempered glass', 'DOR', 'goods', array['kinh cuong luc','kinh trong','tempered glass','kinh thuy'], 1500),
  ('Kính ghép', 'Laminated glass', 'DOR', 'goods', array['kinh ghep'], 1510),
  ('Phim cách nhiệt', 'Window film', 'DOR', 'goods', array['phim cach nhiet','bang bao gia phim','kha nang truyen sang','solar energy'], 1520),
  ('Bản lề', 'Hinge', 'DOR', 'goods', array['ban le','cabinet door hinge'], 1530),
  ('Bản lề kính', 'Glass door hinge', 'DOR', 'goods', array['ban le kinh'], 1540),
  ('Kẹp kính, bát kính', 'Glass clamp', 'DOR', 'goods', array['kep kinh','bat kinh','thanh treo kinh'], 1550),
  ('Tay nắm cửa', 'Door handle', 'DOR', 'goods', array['tay nam','bang day','bang keo push','bang keo pull'], 1560),
  ('Khóa cửa', 'Door lock', 'DOR', 'goods', array['khoa cua','khoa tay gat','khoa tay nam gat','khoa lien ket','khoa tu','cabinet door lock','khoa dien'], 1570),
  ('Chốt âm cửa', 'Flush bolt', 'DOR', 'goods', array['chot am'], 1580),
  ('Tay co thủy lực, tay đẩy hơi', 'Door closer', 'DOR', 'goods', array['tay co thuy luc','tay day hoi'], 1590),
  ('Thanh thoát hiểm', 'Panic bar', 'DOR', 'goods', array['thanh thoat hiem'], 1600),
  ('Ron, gioăng cửa', 'Door seal', 'DOR', 'goods', array['ron cua','roong','roong tu'], 1610),
  ('Ngạch cửa inox', 'Stainless door sill', 'DOR', 'goods', array['door sill','doorsill'], 1620),
  ('Hàng rào sắt', 'Steel fence', 'DOR', 'goods', array['hang rao sat','hang rao'], 1630),
  ('Thanh ray', 'Track rail', 'DOR', 'goods', array['thanh ray','dan huong banh xe'], 1640),
  ('Sơn nước', 'Emulsion painting', 'FIN', 'service', array['son moi','son nuoc','son tuong','son moi tran','dam va son','son mat dung','son dau','son lai','son chi','son mau','tret bot','bao gom tret bot'], 1650),
  ('Sơn gỗ, sơn PU', 'Wood coating', 'FIN', 'service', array['son pu','son phu go','son san go','son moi cua','son ban','son ghe','son ke','son khung','sua chua va son'], 1660),
  ('Sơn (vật tư)', 'Paint material', 'FIN', 'goods', array['dulux','su dung son','pud gloss','son dulux'], 1670),
  ('Giấy dán tường', 'Wallpaper', 'FIN', 'goods', array['giay dan tuong','dan giay','thay giay','thao bo giay','su dung giay','korea 6805'], 1680),
  ('Trần thạch cao', 'Gypsum ceiling', 'FIN', 'goods', array['tran thach cao','dong tran','cat va tran','thao va tran','vinh tuong'], 1690),
  ('Vách thạch cao', 'Gypsum partition', 'FIN', 'goods', array['vach thach cao','khung thep v4','hoa sen z8'], 1700),
  ('Trần nhôm', 'Aluminium ceiling', 'FIN', 'goods', array['tran nhom'], 1710),
  ('Sàn gỗ', 'Wooden flooring', 'FIN', 'goods', array['san go'], 1720),
  ('Sàn nhựa SPC', 'SPC flooring', 'FIN', 'goods', array['san nhua'], 1730),
  ('Thảm trải sàn', 'Carpet', 'FIN', 'goods', array['tham lot san','tham','trai lot'], 1740),
  ('Gạch ốp lát', 'Tiling', 'FIN', 'goods', array['gach','lat gach','op gach','don nen bang gach'], 1750),
  ('Ốp lát đá', 'Stone cladding', 'FIN', 'goods', array['op da','op lat da','lat da','dan da','da granite'], 1760),
  ('Ngạch, chỉ đá chặn nước', 'Stone threshold', 'FIN', 'goods', array['nguong da','ngach da','lat nguong','chi da chan nuoc','lat ngach da'], 1770),
  ('Ron gạch', 'Tile grout', 'FIN', 'service', array['ron gach','lam moi ron','keo cha ron','cao bo lop ron','ron nha ve sinh'], 1780),
  ('Chống thấm', 'Waterproofing', 'FIN', 'service', array['chong tham','gia cuong goc','gia cuong truoc khi','xu ly chong tham','xu li chan tuong'], 1790),
  ('Trám khe, silicone', 'Joint sealing', 'FIN', 'service', array['bom chat tram','bom sealant','xu ly cac mep noi','xu li cac mep noi','ron kinh','thi cong xu ly ron kinh'], 1800),
  ('Cán nền', 'Floor screed', 'FIN', 'service', array['can nen','lam phang be mat san','phu gia','xoa mat nen','dong ron xoa'], 1810),
  ('Tô trát, xây tường', 'Plastering & brickwork', 'FIN', 'service', array['to trat','to can vua','to lai','xay tuong','xay dung to','xay tro','xay lai tuong','xay trat','tuong hang rao xay','dam va lai tuong','chi phi thay gach'], 1820),
  ('Bê tông, cốt thép', 'Concrete & rebar', 'FIN', 'goods', array['be tong','mac 250','cot thep','sat hoa phat','sika grout'], 1830),
  ('Vữa, gạch xây', 'Mortar & bricks', 'FIN', 'goods', array['vua xi mang','gach ong'], 1840),
  ('Len chân tường', 'Skirting', 'FIN', 'goods', array['len chan tuong','chan len tuong'], 1850),
  ('Chỉ phào', 'Cornice moulding', 'FIN', 'goods', array['chi phao'], 1860),
  ('Nẹp inox', 'Stainless trim', 'FIN', 'goods', array['nep inox','nep l inox','u inox','v inox'], 1870),
  ('Vách ngăn compact', 'Compact partition', 'FIN', 'goods', array['vach ngan compact'], 1880),
  ('Ốp veneer, vách lam', 'Veneer & slat cladding', 'FIN', 'goods', array['veneer','vach lam','xu ly vach veneer'], 1890),
  ('Inox tấm, ốp inox', 'Stainless sheet cladding', 'FIN', 'goods', array['inox tam','inox 304','inox op','tam inox','inox cover','op inox','thay toan bo bang inox','mat san inox','xuong gia co','khung inox','chan chiu luc','chan inox','mat tren'], 1900),
  ('Rèm', 'Curtain', 'FIN', 'goods', array['rem'], 1910),
  ('Decal dán', 'Decal film', 'FIN', 'goods', array['dan de can'], 1920),
  ('Bồn cầu', 'Toilet', 'SAN', 'goods', array['bon cau'], 1930),
  ('Bồn tiểu', 'Urinal', 'SAN', 'goods', array['bon tieu','van tieu','van cam ung tieu'], 1940),
  ('Bồn tắm', 'Bathtub', 'SAN', 'goods', array['bon tam','thay bon tam'], 1950),
  ('Sen tắm', 'Shower set', 'SAN', 'goods', array['sen tam','than cay sen','cu sen','voi sen'], 1960),
  ('Vòi chậu lavabo', 'Basin tap', 'SAN', 'goods', array['voi nong lanh','voi chau'], 1970),
  ('Vòi xịt', 'Bidet spray', 'SAN', 'goods', array['voi xit'], 1980),
  ('Chậu lavabo, bàn đá', 'Basin & vanity', 'SAN', 'goods', array['lavabo','chau rua mat','ong thoat cho chau'], 1990),
  ('Gương', 'Mirror', 'SAN', 'goods', array['guong'], 2000),
  ('Phụ kiện phòng tắm', 'Bathroom accessories', 'SAN', 'goods', array['hop de giay','moc ao','day phoi'], 2010),
  ('Thiết bị vệ sinh (sửa chữa)', 'Sanitary works', 'SAN', 'service', array['thiet bi ve sinh','thiet bi nha ve sinh','tbvs','phu kien lap dat bon cau'], 2020),
  ('Bàn', 'Table', 'FUR', 'goods', array['ban tron','ban tiec','foldaway round table','alize low table','ban ghe'], 2030),
  ('Ghế, bục ghế', 'Seating', 'FUR', 'goods', array['ghe','buc ghe','che op simili','sunlounger','headrest'], 2040),
  ('Kệ, tủ gỗ', 'Cabinet', 'FUR', 'goods', array['ke tu','ke duoi tivi','ke trang diem','ke','tu quan ao','van mdf','khung go'], 2050),
  ('Quầy', 'Counter', 'FUR', 'goods', array['quay pha che'], 2060),
  ('Xe làm phòng, xe đẩy', 'Trolley', 'FUR', 'goods', array['xe lam phong','xe van chuyen'], 2070),
  ('Sửa chữa nội thất', 'Furniture repair', 'FUR', 'service', array['sua chua noi that','sua chua va son moi noi that'], 2080),
  ('Hệ thống PCCC', 'Fire protection', 'FPS', 'goods', array['chong chay lan','bao chay','pccc','hochiki'], 2090),
  ('Hồ sơ PCCC, kiểm định', 'Fire permit & inspection', 'FPS', 'service', array['ho so pccc','tham duyet','kiem dinh','lap trinh he thong bao chay','nhuom chat chong chay'], 2100),
  ('Tháo dỡ, phá dỡ', 'Demolition & removal', 'SRV', 'service', array['thao do','thao go','thao bo','thao may','thao cua','thao lap','duc bo','duc pha','pha do','dap tuong','dap bo','cong viec dap pha','nhan cong duc bo','nhan cong cat duc','cat mau nho','thao va lap','chi phi duc tuong','duc tuong'], 2110),
  ('Vận chuyển xà bần', 'Debris removal', 'SRV', 'service', array['xa ban','van chuyen rac','rac thai','thu gom xu ly rac','do rac','van chuyen xa ban','xe xa ban'], 2120),
  ('Vận chuyển', 'Delivery', 'SRV', 'service', array['van chuyen','delivery','freight','shipping','giao hang','customer clearance','cong viec van chuyen'], 2130),
  ('Che chắn bảo vệ', 'Protection works', 'SRV', 'service', array['che chan','bao che','bat che','equipment cover','bao ve be mat','cong viec che chan','hop bao ve'], 2140),
  ('Vệ sinh bàn giao', 'Final cleaning', 'SRV', 'service', array['ve sinh ban giao','ve sinh don dep','ve sinh sau','ve sinh hoan tra','cleanup after work','ve sinh hut bui','ve sinh lam moi','lam lai mat bang'], 2150),
  ('Nhân công lắp đặt', 'Installation labour', 'SRV', 'service', array['nhan cong','cong lap dat','lap dat','installation','chi phi lap dat','chi phi thay the lap dat','phi nhan cong','chi phi thuc hien','nhan cong thuc hien'], 2160),
  ('Chi phí quản lý', 'Management fee', 'SRV', 'service', array['chi phi quan ly','chi phi quan li','quan ly giam sat','nhan su','chi phi nhan su'], 2170),
  ('Vật tư phụ', 'Consumables', 'SRV', 'goods', array['vat tu phu','phu kien','sub materials','supplies and accessories','chi phi vat tu phu','vat tu trien khai','vat tu thi cong','special discount for consumables','chi phi vat tu silicone','vat tu silicone'], 2180),
  ('Giàn giáo, tời', 'Scaffolding & hoist', 'SRV', 'service', array['gian giao','su dung toi'], 2190),
  ('Tư vấn, thiết kế', 'Design consultancy', 'SRV', 'service', array['dich vu tu van','thiet ke','ban ve','design','xay dung ho so','hop kick off'], 2200),
  ('Khảo sát, chuẩn bị', 'Survey & preparation', 'SRV', 'service', array['khao sat','cong viec chuan bi','chuan bi be mat','di doi cac thiet bi'], 2210),
  ('Đi lại, công tác phí', 'Travel expenses', 'SRV', 'service', array['di lai','an o','travel'], 2220),
  ('Bảo hành, bảo trì', 'Warranty & maintenance', 'SRV', 'service', array['bao hanh','bao tri','ve sinh va bao tri','dich vu thay ac quy'], 2230),
  ('Thi công ngoài giờ', 'Night, restricted works', 'SRV', 'service', array['thi cong tranh tieng on'], 2240),
  ('Giấy phép thi công', 'Works permit', 'SRV', 'service', array['xin giay phep'], 2250),
  ('Sửa chữa chung', 'General repair', 'SRV', 'service', array['sua chua','sua chua thay the','sua chua gan','sua chua cua'], 2260),
  ('Chiết khấu', 'Discount', 'OTH', 'other', array['discount','chiet khau','phieu mua hang'], 2270),
  ('Bảo hiểm', 'Insurance', 'OTH', 'other', array['bao hiem'], 2280),
  ('Tổng cộng, tiêu đề', 'Heading, total', 'OTH', 'heading', array['grand total','cong viec khac','phan xay dung','phan mep','he thong nuoc','he gio lanh','he dien dieu khien','cong tac khac','included','toilet lobby','noi dung'], 2290),
  ('Khoan, đục lỗ', 'Drilling & coring', 'SRV', 'service', array['khoan duc','khoan khoet','khoan'], 2300),
  ('Keo dán gạch, đá', 'Tile adhesive', 'FIN', 'goods', array['keo dan','su dung keo dan'], 2310),
  ('Công tắc thẻ phòng', 'Key card switch', 'ELE', 'goods', array['hop doc the','key card'], 2320),
  ('Điều khiển từ xa', 'Remote control', 'ICT', 'goods', array['remote 4 chuc nang','remote'], 2330),
  ('Bạt che', 'Tarpaulin', 'SRV', 'goods', array['bat mem'], 2340),
  ('Ống (chung)', 'Pipe (general)', 'PLB', 'goods', array['ong'], 2350),
  ('Khung sắt, thép', 'Steel frame', 'FIN', 'goods', array['khung sat','su dung khung sat'], 2360),
  ('Hoàn thiện kiến trúc', 'Architectural finishing', 'FIN', 'service', array['cong viec hoan thien'], 2370)
on conflict (std_vi) do nothing;

-- Đơn vị gặp trong file cũ (26/09/2026). Sửa / thêm được bằng SQL; "do nothing" giữ phần đã sửa.
insert into pr_unit (raw_norm, unit, lump) values
  ('cai', 'cái', false), ('chiec', 'cái', false), ('pcs', 'cái', false), ('pc', 'cái', false), ('piece', 'cái', false), ('pieces', 'cái', false), ('ea', 'cái', false),
  ('bo', 'bộ', false), ('set', 'bộ', false), ('sets', 'bộ', false),
  ('m2', 'm²', false), ('m²', 'm²', false), ('m^2', 'm²', false), ('met vuong', 'm²', false), ('sqm', 'm²', false),
  ('m', 'm', false), ('met', 'm', false), ('md', 'm', false), ('m dai', 'm', false), ('meter', 'm', false), ('m3', 'm³', false), ('m³', 'm³', false),
  ('kg', 'kg', false), ('tan', 'tấn', false), ('tam', 'tấm', false), ('cuon', 'cuộn', false), ('roll', 'cuộn', false),
  ('lit', 'lít', false), ('lít', 'lít', false), ('l', 'lít', false), ('thung', 'thùng', false), ('hop', 'hộp', false), ('cay', 'cây', false),
  ('cot', 'cột', false), ('khung', 'khung', false), ('o', 'ô', false), ('canh', 'cánh', false), ('phong', 'phòng', false), ('don vi', 'đơn vị', false),
  ('ngay-cong', 'ngày công', false), ('ngay cong', 'ngày công', false), ('cong', 'công', false),
  ('lic', 'license', false), ('license', 'license', false), ('licence', 'license', false), ('user', 'user', false),
  ('goi', 'gói', true), ('tron goi', 'gói', true), ('package', 'gói', true), ('pkg', 'gói', true),
  ('lo', 'lô', true), ('lot', 'lô', true), ('he', 'hệ', true), ('he thong', 'hệ', true), ('system', 'hệ', true),
  ('lan', 'lần', true), ('job', 'lần', true), ('ls', 'gói', true)
on conflict (raw_norm) do nothing;


-- =====================================================================
-- 3. HÀM PHỤ
-- =====================================================================

create or replace function pr_need(p_action text)
returns void language plpgsql stable security definer set search_path = public as $$
begin perform app_require('price', p_action); end $$;

-- Đơn vị chuẩn + trọn gói hay không.
create or replace function pr_unit_of(p_raw text, out unit text, out lump boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(u.unit, nullif(trim(p_raw), '')), coalesce(u.lump, false)
  from   (select 1) x left join pr_unit u on u.raw_norm = am_norm(coalesce(p_raw, ''))
$$;

-- Dịch vụ (lắp đặt, nhân công, vận chuyển, tháo dỡ…) theo tên: không phải hàng hoá để so đơn giá thiết bị.
create or replace function pr_is_service(p_name text)
returns boolean language sql immutable as $$
  select am_norm(coalesce(p_name, '')) ~ '^(lap dat|nhan cong|thi cong|van chuyen|thao do|chi phi|cong lap|phi |dich vu|bao tri|bao duong|installation|labou?r|transport|delivery|service)'
$$;

-- ---------------------------------------------------------------- tên chuẩn tự động
-- Tên → dạng chỉ-chữ-số không dấu, có đệm hai đầu. "công tác" (việc) đổi trước khi bỏ dấu, kẻo
-- trùng "công tắc" (công tắc điện) — hai từ chỉ khác nhau ở dấu.
create or replace function pr_words(p text)
returns text language sql immutable as $$
  select ' ' || trim(regexp_replace(am_norm(replace(lower(coalesce(p, '')), 'công tác', 'cong viec')), '[^a-z0-9]+', ' ', 'g')) || ' '
$$;

-- Bỏ số thứ tự và động từ đầu câu: "cung cấp và lắp đặt bồn cầu…" → "bồn cầu…".
create or replace function pr_strip(p_w text)
returns text language sql immutable as $$
  select ' ' || regexp_replace(trim(p_w) || ' ',
    '^((\d+|i|ii|iii|iv|v|a|b) )?(bao gia san pham |bao gia thiet bi |bao gia |cung cap va lap dat |cung cap lap dat |cung cap va lap |cung cap thay the |cung cap |thay the |thay moi |thay |su dung |gan )', '')
$$;

-- Tên chuẩn cho một chuỗi đã chuẩn hoá: từ khoá sớm nhất, rồi dài nhất.
create or replace function pr_find_term(p_w text)
returns int language sql stable security definer set search_path = public as $$
  select t.id
  from   pr_term t, unnest(t.patterns) p0,
         lateral (select ltrim(p0, '*') as p, left(p0, 1) = '*' as anyw) x,
         lateral (select position(' ' || x.p || ' ' in p_w) as pos) y
  where  t.active and x.p <> '' and y.pos > 0 and (length(x.p) > 3 or x.anyw or y.pos = 1)
  order by y.pos, length(x.p) desc, t.sort
  limit 1
$$;

-- Biến thể so sánh lấy từ tên: DN32 · phi 20 · 10 ly · 15 HP · 600x400 · Cat6 …
create or replace function pr_variant(p text)
returns text language sql immutable as $$
  select nullif(array_to_string(array(
    select m[1] from regexp_matches(coalesce(p, ''),
      '([Dd][Nn] ?\d+|[Pp]hi ?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)? ?[xX*×] ?\d+(?:[.,]\d+)?(?: ?[xX*×] ?\d+(?:[.,]\d+)?)?|\d+(?:[.,]\d+)? ?(?:mm|ly|cm|HP|hp|Hp|kW|KW|kw|BTU|btu|KVA|kVA|VA|inch)(?![a-zA-Z])|[Cc]at ?\.?[56]e?)', 'g') m
    limit 4), ' · '), '')
$$;

-- Gán tên chuẩn cho các dòng CHƯA xét (std_src null): tên đã học (pr_alias) trước, rồi từ vựng.
-- Dòng chỉ ghi thông số ("Dim: 700x700…", "Model: …", "Kích thước: …") lấy tên theo tiêu đề nhóm.
-- Không đụng dòng đã gán tay (manual). Trả về số dòng đã xét.
create or replace function pr_auto_std(p_source bigint default null, p_limit int default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  l record; a record; w text; t int; t2 int; n int := 0;
  spec constant text := '^((dim|model|mode|kich thuoc|kt|capacity|thong so|thong tin ki|nhan hieu|han hieu|hang san xuat|xuat xu|chat lieu|cong suat|dung tich|nhiet do|dien ap|size|voltage|with|the|power|external)\y|dn ?\d|\d)';
begin
  for l in select id, name_raw, section from pr_line
           where std_src is null and (p_source is null or source_id = p_source)
           order by id limit coalesce(p_limit, 2147483647) loop
    select * into a from pr_alias where name_norm = am_norm(l.name_raw);
    if found then
      update pr_line set name_std = a.name_std, term_id = a.term_id, std_src = 'alias', variant = pr_variant(l.name_raw),
                         grp = (select grp from pr_term where id = a.term_id)
       where id = l.id;
      n := n + 1; continue;
    end if;
    w := pr_words(l.name_raw); t := null;
    if trim(w) ~ spec and coalesce(trim(l.section), '') <> '' then
      t := pr_find_term(pr_strip(pr_words(l.section)));
      if t is null or (select kind from pr_term where id = t) = 'heading' then
        t2 := pr_find_term(pr_strip(w)); if t2 is not null then t := t2; end if;
      end if;
    else
      t := pr_find_term(pr_strip(w));
      if t is null and coalesce(trim(l.section), '') <> '' then t := pr_find_term(pr_strip(pr_words(l.section))); end if;
    end if;
    if t is null and trim(w) ~ '^bao gia' then t := (select id from pr_term where kind = 'heading' and active order by sort limit 1); end if;
    update pr_line set term_id = t, std_src = case when t is null then 'none' else 'rule' end, variant = pr_variant(l.name_raw),
                       name_std = (select std_vi || '/' || std_en from pr_term where id = t), grp = (select grp from pr_term where id = t)
     where id = l.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Tính lại cột suy ra của các dòng: tên chuẩn (dòng chưa xét), đơn vị chuẩn, loại dòng, giá VND,
-- chuỗi tra cứu. Loại dòng: tiêu đề / chiết khấu → other; đơn vị trọn gói → lump; tên chuẩn là
-- nhân công / dịch vụ → service; còn lại hàng hoá.
create or replace function pr_refresh_lines(p_source bigint default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pr_auto_std(p_source, null);
  update pr_line l set
    unit      = (pr_unit_of(l.unit_raw)).unit,
    line_kind = case (select kind from pr_term where id = l.term_id)
                  when 'other' then 'other' when 'heading' then 'other'
                  else case when (pr_unit_of(l.unit_raw)).lump then 'lump'
                            when (select kind from pr_term where id = l.term_id) = 'service' then 'service'
                            when l.term_id is not null then 'goods'
                            when pr_is_service(l.name_raw) then 'service' else 'goods' end end,
    price_vnd = case when l.unit_price is null and l.labor_price is null then null
                     else round((coalesce(l.unit_price, 0) + coalesce(l.labor_price, 0)) * s.fx_rate
                                / case when s.vat_included then 1 + coalesce(l.vat_rate, 0.1) else 1 end, 2) end
  from pr_source s
  where s.id = l.source_id and (p_source is null or l.source_id = p_source);
  update pr_line l set search_norm = am_norm(concat_ws(' ', l.name_raw, l.name_std, l.brand, l.model, l.section, l.category_code))
  where p_source is null or l.source_id = p_source;
end $$;

-- Đọc một dòng JSON vào pr_line.
create or replace function pr_put_lines(p_source bigint, p_lines jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into pr_line (source_id, line_no, section, name_raw, name_std, category_code, brand, model, origin, spec, qty, unit_raw,
                       unit_price, labor_price, vat_rate, note, uncertain)
  select p_source, coalesce((x ->> 'line_no')::int, o::int), nullif(x ->> 'section', ''), x ->> 'name', nullif(x ->> 'name_std', ''),
         nullif(x ->> 'category_code', ''), nullif(x ->> 'brand', ''), nullif(x ->> 'model', ''), nullif(x ->> 'origin', ''),
         coalesce(x -> 'spec', '{}'::jsonb), nullif(x ->> 'qty', '')::numeric, nullif(x ->> 'unit', ''),
         nullif(x ->> 'unit_price', '')::numeric, nullif(x ->> 'labor_price', '')::numeric, nullif(x ->> 'vat_rate', '')::numeric,
         nullif(x ->> 'note', ''), coalesce(x -> 'uncertain', '[]'::jsonb)
  from   jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality e(x, o)
  where  coalesce(trim(x ->> 'name'), '') <> '';
  get diagnostics n = row_count;
  return n;
end $$;


-- =====================================================================
-- 4. NHẬP TAY: báo giá (JSON), file Excel cũ, sửa, xoá
-- =====================================================================

-- p_source: {id?, kind, ref, supplier, contact, quote_date, project_code, project_name, currency, fx_rate, vat_included,
--            won, delivery_term, install_term, payment_term, file_name, file_url, note}; p_lines: [{name, qty, unit, unit_price, …}]
create or replace function pr_save_source(p_source jsonb, p_lines jsonb default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint := nullif(p_source ->> 'id', '')::bigint; v_kind text := coalesce(nullif(p_source ->> 'kind', ''), 'quote');
begin
  perform pr_need('create');
  if v_kind not in ('legacy', 'quote', 'market') then raise exception 'Chỉ sửa được nguồn nhập tay (báo giá, giá thị trường, dữ liệu cũ).'; end if;
  if v_id is null then
    insert into pr_source (kind, created_name) values (v_kind, pm_user_name(auth.uid())) returning id into v_id;
  elsif not exists (select 1 from pr_source where id = v_id and kind in ('legacy', 'quote', 'market')) then
    raise exception 'Nguồn tự động (QC, MC, PO, dự thầu, nhận hàng) chỉ đổi được ở chứng từ gốc.';
  end if;
  update pr_source set
    kind = v_kind, ref = p_source ->> 'ref', supplier = nullif(trim(p_source ->> 'supplier'), ''), contact = p_source ->> 'contact',
    quote_date = nullif(p_source ->> 'quote_date', '')::date, project_code = nullif(p_source ->> 'project_code', ''),
    project_name = p_source ->> 'project_name', currency = coalesce(nullif(p_source ->> 'currency', ''), 'VND'),
    fx_rate = coalesce(nullif(p_source ->> 'fx_rate', '')::numeric, 1), vat_included = coalesce((p_source ->> 'vat_included')::boolean, false),
    won = (p_source ->> 'won')::boolean, delivery_term = p_source ->> 'delivery_term', install_term = p_source ->> 'install_term',
    payment_term = p_source ->> 'payment_term', file_name = p_source ->> 'file_name', file_url = nullif(p_source ->> 'file_url', ''),
    note = p_source ->> 'note', updated_at = now()
  where id = v_id;
  if p_lines is not null then
    delete from pr_line where source_id = v_id;
    perform pr_put_lines(v_id, p_lines);
  end if;
  perform pr_refresh_lines(v_id);
  return v_id;
end $$;

create or replace function pr_delete_source(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pr_need('edit');
  delete from pr_source where id = p_id and kind in ('legacy', 'quote', 'market');
  if not found then raise exception 'Chỉ xoá được nguồn nhập tay.'; end if;
end $$;

-- File Excel cũ: gọi nhiều lần (mỗi lần ≤ 500 dòng) với cùng p_import; mỗi phần tử p_sources = một báo giá
-- {ref, supplier, contact, quote_date, project_name, delivery_term, install_term, payment_term, file_name, lines:[…]}.
-- Báo giá đã có (cùng ref) được THAY bằng bản mới — nạp lại file vô hại.
create or replace function pr_import_legacy(p_import bigint, p_file text, p_sources jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_imp bigint := p_import; s jsonb; v_id bigint; n_src int := 0; n_line int := 0;
begin
  perform pr_need('create');
  if v_imp is null then
    insert into pr_import (kind, file_name, created_name) values ('legacy', p_file, pm_user_name(auth.uid())) returning id into v_imp;
  end if;
  for s in select * from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) loop
    insert into pr_source (kind, origin_key, ref, supplier, contact, quote_date, project_name, delivery_term, install_term, payment_term,
                           file_name, import_id, created_name)
    values ('legacy', 'legacy:' || (s ->> 'ref'), s ->> 'ref', nullif(trim(s ->> 'supplier'), ''), s ->> 'contact',
            nullif(s ->> 'quote_date', '')::date, s ->> 'project_name', s ->> 'delivery_term', s ->> 'install_term', s ->> 'payment_term',
            s ->> 'file_name', v_imp, pm_user_name(auth.uid()))
    on conflict (origin_key) do update set supplier = excluded.supplier, contact = excluded.contact,
      quote_date = coalesce(excluded.quote_date, pr_source.quote_date), project_name = excluded.project_name,
      delivery_term = excluded.delivery_term, install_term = excluded.install_term, payment_term = excluded.payment_term,
      file_name = excluded.file_name, import_id = excluded.import_id, updated_at = now()
    returning id into v_id;
    delete from pr_line where source_id = v_id;
    n_line := n_line + pr_put_lines(v_id, s -> 'lines');
    perform pr_refresh_lines(v_id);
    n_src := n_src + 1;
  end loop;
  update pr_import set stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object('sources', coalesce((stats ->> 'sources')::int, 0) + n_src,
                                                                                    'lines', coalesce((stats ->> 'lines')::int, 0) + n_line)
   where id = v_imp;
  return jsonb_build_object('import', v_imp, 'sources', n_src, 'lines', n_line);
end $$;

-- Gán tên chuẩn TAY cho các dòng (tên chuẩn trong từ vựng, hoặc gõ tên mới). Ghi nhớ tên gốc →
-- tên chuẩn (pr_alias): các dòng cùng tên gốc — hiện có và về sau, mọi nguồn — nhận luôn tên
-- này. p_std trống = bỏ tên tay, trả dòng về quy tắc tự động.
create or replace function pr_set_std(p_lines bigint[], p_std text, p_category text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_term int; v_std text; v_src bigint;
begin
  perform pr_need('edit');
  p_std := nullif(trim(p_std), '');
  if p_std is null then
    delete from pr_alias where name_norm in (select am_norm(name_raw) from pr_line where id = any(p_lines));
    update pr_line set std_src = null, name_std = null, term_id = null, grp = null
     where am_norm(name_raw) in (select am_norm(name_raw) from pr_line where id = any(p_lines));
  else
    select id, std_vi || '/' || std_en into v_term, v_std from pr_term
     where lower(std_vi || '/' || std_en) = lower(p_std) or lower(std_vi) = lower(p_std) order by sort limit 1;
    v_std := coalesce(v_std, p_std);
    insert into pr_alias (name_norm, name_std, term_id, category_code)
    select distinct am_norm(name_raw), v_std, v_term, nullif(p_category, '') from pr_line where id = any(p_lines)
    on conflict (name_norm) do update set name_std = excluded.name_std, term_id = excluded.term_id,
                                          category_code = coalesce(excluded.category_code, pr_alias.category_code);
    update pr_line set name_std = v_std, term_id = v_term, std_src = 'manual', grp = (select grp from pr_term where id = v_term)
     where id = any(p_lines);
    update pr_line set name_std = v_std, term_id = v_term, std_src = 'alias', grp = (select grp from pr_term where id = v_term)
     where coalesce(std_src, '') <> 'manual' and not (id = any(p_lines))
       and am_norm(name_raw) in (select am_norm(name_raw) from pr_line where id = any(p_lines));
  end if;
  for v_src in select distinct source_id from pr_line where am_norm(name_raw) in (select am_norm(name_raw) from pr_line where id = any(p_lines)) loop
    perform pr_refresh_lines(v_src);
  end loop;
  return coalesce(array_length(p_lines, 1), 0);
end $$;

-- Thêm / sửa một tên chuẩn của từ vựng. p: {id?, std_vi, std_en, grp, kind, patterns (mảng hoặc chuỗi
-- cách nhau ";"), sort, active}. Từ khoá được chuẩn hoá (không dấu, chữ thường); giữ tiền tố "*".
create or replace function pr_term_save(p jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare v_id int := nullif(p ->> 'id', '')::int; v_pats text[];
begin
  perform pr_need('edit');
  if coalesce(trim(p ->> 'std_vi'), '') = '' or coalesce(trim(p ->> 'std_en'), '') = '' then raise exception 'Ghi tên chuẩn tiếng Việt và tiếng Anh.'; end if;
  if position('/' in p ->> 'std_vi') > 0 then raise exception 'Tên tiếng Việt không dùng dấu "/" (dấu này ngăn cách tên Việt / Anh) — dùng dấu phẩy.'; end if;
  select array_agg(distinct case when left(trim(x), 1) = '*' then '*' else '' end
                   || trim(regexp_replace(am_norm(ltrim(trim(x), '*')), '[^a-z0-9]+', ' ', 'g')))
    into v_pats
    from (select jsonb_array_elements_text(case when jsonb_typeof(p -> 'patterns') = 'array' then p -> 'patterns'
                                                else to_jsonb(string_to_array(coalesce(p ->> 'patterns', ''), ';')) end) x) q
   where trim(regexp_replace(am_norm(ltrim(trim(x), '*')), '[^a-z0-9]+', ' ', 'g')) <> '';
  if v_id is null then
    insert into pr_term (std_vi, std_en, grp, kind, patterns, sort, active)
    values (trim(p ->> 'std_vi'), trim(p ->> 'std_en'), coalesce(nullif(p ->> 'grp', ''), 'OTH'), coalesce(nullif(p ->> 'kind', ''), 'goods'),
            coalesce(v_pats, '{}'), coalesce(nullif(p ->> 'sort', '')::int, 5000), coalesce((p ->> 'active')::boolean, true))
    returning id into v_id;
  else
    update pr_term set std_vi = trim(p ->> 'std_vi'), std_en = trim(p ->> 'std_en'), grp = coalesce(nullif(p ->> 'grp', ''), grp),
           kind = coalesce(nullif(p ->> 'kind', ''), kind), patterns = coalesce(v_pats, '{}'), sort = coalesce(nullif(p ->> 'sort', '')::int, sort),
           active = coalesce((p ->> 'active')::boolean, active), updated_by = auth.uid(), updated_at = now()
     where id = v_id;
    -- Tên đổi: các dòng đang mang tên này (tay hoặc tự động) đổi theo.
    update pr_line l set name_std = t.std_vi || '/' || t.std_en, grp = t.grp from pr_term t where t.id = v_id and l.term_id = v_id;
    update pr_alias a set name_std = t.std_vi || '/' || t.std_en from pr_term t where t.id = v_id and a.term_id = v_id;
  end if;
  return v_id;
end $$;

-- Áp lại quy tắc cho mọi dòng không gán tay (sau khi sửa từ vựng). Gọi lặp: p_reset = true ở lần
-- đầu; mỗi lần xét tối đa p_limit dòng (giới hạn 8 giây của API); trả {left}. Hết dòng thì tính lại
-- loại dòng và chuỗi tra cứu.
create or replace function pr_std_run(p_reset boolean default false, p_limit int default 800)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_left int;
begin
  perform pr_need('edit');
  if p_reset then
    update pr_line set std_src = null, term_id = null, name_std = null, grp = null where coalesce(std_src, '') <> 'manual';
  end if;
  perform pr_auto_std(null, p_limit);
  select count(*) into v_left from pr_line where std_src is null;
  if v_left = 0 then perform pr_refresh_lines(null); end if;
  return jsonb_build_object('left', v_left);
end $$;


-- =====================================================================
-- 5. ĐỒNG BỘ TỪ APP: QC, MC, PO, dự thầu, nhận hàng
--    Dựng lại toàn bộ nguồn tự động mỗi lần gọi (không ai sửa tay các nguồn này).
-- =====================================================================

create or replace function pr_sync()
returns jsonb language plpgsql security definer set search_path = public as $$
declare d record; v jsonb; i int; v_id bigint; n jsonb := '{}'::jsonb; k text; cnt int;
begin
  perform pr_need('create');
  delete from pr_source where kind in ('qc', 'mc_hist', 'mc_market', 'po', 'tender', 'intake');

  -- QC: mỗi nhà cung cấp một nguồn; nhà cung cấp A của QC đã duyệt = trúng.
  cnt := 0;
  for d in select x.*, p.name as pname from pm_doc x left join pm_project p on p.code = x.project_code
           where x.doc_type = 'QC' and x.status <> 'cancelled' loop
    i := 0;
    for v in select * from jsonb_array_elements(coalesce(d.data -> 'vendors', '[]'::jsonb)) loop
      if coalesce(trim(v ->> 'name'), '') <> '' then
        insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, won, payment_term, created_name)
        values ('qc', 'qc:' || d.id || ':' || i, d.doc_no, v ->> 'name', coalesce(nullif(d.data ->> 'date', '')::date, d.created_at::date),
                d.project_code, d.pname, case when d.status = 'approved' then i = 0 end, v ->> 'pay_term', 'sync')
        returning id into v_id;
        perform pr_put_lines(v_id, (
          select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', q ->> 'item', 'qty', q ->> 'qty', 'unit', q ->> 'unit',
                   'unit_price', v -> 'prices' ->> ((o - 1)::text), 'brand', v -> 'specx' -> ((o - 1)::text) ->> 'brand',
                   'model', v -> 'specx' -> ((o - 1)::text) ->> 'model', 'origin', v -> 'specx' -> ((o - 1)::text) ->> 'origin',
                   'spec', coalesce(v -> 'specx' -> ((o - 1)::text), '{}'::jsonb), 'note', v -> 'specs' ->> ((o - 1)::text))), '[]'::jsonb)
          from jsonb_array_elements(coalesce(d.data -> 'qlines', '[]'::jsonb)) with ordinality e(q, o)
          where v -> 'prices' ->> ((o - 1)::text) is not null));
        perform pr_put_lines(v_id, (
          select coalesce(jsonb_agg(jsonb_build_object('line_no', 1000 + o, 'name', q ->> 'item', 'qty', 1, 'unit', 'gói',
                   'unit_price', v -> 'oprices' ->> ((o - 1)::text))), '[]'::jsonb)
          from jsonb_array_elements(coalesce(d.data -> 'olines', '[]'::jsonb)) with ordinality e(q, o)
          where v -> 'oprices' ->> ((o - 1)::text) is not null));
        cnt := cnt + 1;
      end if;
      i := i + 1;
    end loop;
  end loop;
  n := n || jsonb_build_object('qc', cnt);

  -- MC: giá lịch sử (B, quy về năm của nó) và giá thị trường (C).
  cnt := 0;
  for d in select x.*, p.name as pname from pm_doc x left join pm_project p on p.code = x.project_code
           where x.doc_type = 'MC' and x.status <> 'cancelled' loop
    if exists (select 1 from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) l where nullif(l ->> 'b_pv', '') is not null) then
      -- Đơn giá = giá lịch sử đã quy về ngày MC (b_price, 4,6%/năm như form MC); năm và giá gốc ghi ở ghi chú.
      insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, note, created_name)
      values ('mc_hist', 'mc:' || d.id || ':b', d.doc_no, null, coalesce(nullif(d.data ->> 'date', '')::date, d.created_at::date), d.project_code, d.pname,
              'Giá lịch sử trong Market Check, đã quy về ngày MC', 'sync')
      returning id into v_id;
      perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', l ->> 'item', 'qty', l ->> 'qty', 'unit', l ->> 'unit',
                 'unit_price', coalesce(l ->> 'b_price', l ->> 'b_pv'),
                 'note', concat_ws(' · ', nullif(l ->> 'b_ref', ''), 'giá năm ' || (l ->> 'b_year') || ': ' || (l ->> 'b_pv')))), '[]'::jsonb)
        from jsonb_array_elements(d.data -> 'lines') with ordinality e(l, o) where nullif(l ->> 'b_pv', '') is not null));
      cnt := cnt + 1;
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) l where nullif(l ->> 'c_price', '') is not null) then
      insert into pr_source (kind, origin_key, ref, quote_date, project_code, project_name, note, created_name)
      values ('mc_market', 'mc:' || d.id || ':c', d.doc_no, coalesce(nullif(d.data ->> 'date', '')::date, d.created_at::date), d.project_code, d.pname,
              'Giá thị trường trong Market Check', 'sync')
      returning id into v_id;
      perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', l ->> 'item', 'qty', l ->> 'qty', 'unit', l ->> 'unit',
                 'unit_price', l ->> 'c_price', 'note', nullif(l ->> 'c_spec', ''))), '[]'::jsonb)
        from jsonb_array_elements(d.data -> 'lines') with ordinality e(l, o) where nullif(l ->> 'c_price', '') is not null));
      cnt := cnt + 1;
    end if;
  end loop;
  n := n || jsonb_build_object('mc', cnt);

  -- PO: giá chốt (trúng).
  cnt := 0;
  for d in select x.*, p.name as pname from pm_doc x left join pm_project p on p.code = x.project_code
           where x.doc_type = 'PO' and x.status <> 'cancelled' loop
    insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, won, payment_term, delivery_term, created_name)
    values ('po', 'po:' || d.id, d.doc_no, nullif(d.data ->> 'supplier', ''), coalesce(nullif(d.data ->> 'order_date', '')::date, d.created_at::date),
            d.project_code, d.pname, case when d.status = 'approved' then true end, d.data ->> 'payment_term', d.data ->> 'delivery_term', 'sync')
    returning id into v_id;
    perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', l ->> 'asset_item', 'qty', l ->> 'qty', 'unit', l ->> 'unit',
               'unit_price', l ->> 'unit_price', 'brand', l -> 'spec' ->> 'brand', 'model', l -> 'spec' ->> 'model', 'origin', l ->> 'origin',
               'spec', coalesce(l -> 'spec', '{}'::jsonb))), '[]'::jsonb)
      from jsonb_array_elements(coalesce(d.data -> 'lines', '[]'::jsonb)) with ordinality e(l, o) where nullif(l ->> 'unit_price', '') is not null));
    cnt := cnt + 1;
  end loop;
  n := n || jsonb_build_object('po', cnt);

  -- Hồ sơ dự thầu đã mở niêm phong (bản mới nhất mỗi nhà thầu mỗi vòng): trúng = nhà cung cấp A của QC đã duyệt.
  cnt := 0;
  for d in select b.*, tn.items, tn.project_code, tn.qc_doc_id, tn.title, iv.vendor_name, p.name as pname
           from pm_tender_bid b join pm_tender tn on tn.id = b.tender_id join pm_tender_invitee iv on iv.id = b.invitee_id
           left join pm_project p on p.code = tn.project_code
           where b.status = 'submitted' and b.opened_at is not null loop
    insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, project_name, won, payment_term, created_name)
    values ('tender', 'tender:' || d.id, coalesce(d.title, 'Tender') || ' · vòng ' || d.round, d.vendor_name, d.submitted_at::date, d.project_code, d.pname,
            (select case when q.status = 'approved' then am_norm(q.data ->> 'chosen_vendor') = am_norm(d.vendor_name) end from pm_doc q where q.id = d.qc_doc_id),
            d.data ->> 'pay_term', 'sync')
    returning id into v_id;
    perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('line_no', o, 'name', it ->> 'item', 'qty', it ->> 'qty', 'unit', it ->> 'unit',
               'unit_price', d.data -> 'prices' ->> ((o - 1)::text), 'brand', d.data -> 'specx' -> ((o - 1)::text) ->> 'brand',
               'model', d.data -> 'specx' -> ((o - 1)::text) ->> 'model', 'spec', coalesce(d.data -> 'specx' -> ((o - 1)::text), '{}'::jsonb))), '[]'::jsonb)
      from jsonb_array_elements(coalesce(d.items, '[]'::jsonb)) with ordinality e(it, o) where d.data -> 'prices' ->> ((o - 1)::text) is not null));
    cnt := cnt + 1;
  end loop;
  n := n || jsonb_build_object('tender', cnt);

  -- Phiếu nhận hàng: giá mua thực tế, gộp theo tên chuẩn + đơn vị + đơn giá.
  cnt := 0;
  for d in select s.* from am_shipment s where s.status <> 'cancelled'
           and exists (select 1 from am_asset a where a.shipment_id = s.id and a.unit_price is not null) loop
    insert into pr_source (kind, origin_key, ref, supplier, quote_date, project_code, won, created_name)
    values ('intake', 'intake:' || d.id, coalesce(d.po_doc_no, d.code, 'Nhận hàng #' || d.id), d.supplier, coalesce(d.delivery_date, d.created_at::date),
            d.project_code, true, 'sync')
    returning id into v_id;
    perform pr_put_lines(v_id, (select coalesce(jsonb_agg(jsonb_build_object('name', g.nm, 'qty', g.q, 'unit', g.u, 'unit_price', g.p, 'brand', g.b,
               'model', g.m, 'category_code', g.c, 'name_std', g.nm)), '[]'::jsonb)
      from (select a.name_vi || coalesce(' / ' || a.name_en, '') as nm, a.unit_code as u, a.unit_price as p, max(a.spec_brand) as b, max(a.spec_model) as m,
                   max(a.category_code) as c, sum(a.qty) as q
            from am_asset a where a.shipment_id = d.id and a.unit_price is not null
            group by 1, 2, 3) g));
    cnt := cnt + 1;
  end loop;
  n := n || jsonb_build_object('intake', cnt);

  perform pr_refresh_lines(null);
  insert into am_setting (key, value, note) values ('pr_last_sync', to_jsonb(now()), 'CSDL giá: lần đồng bộ gần nhất từ QC / MC / PO / dự thầu / nhận hàng')
  on conflict (key) do update set value = excluded.value;
  return n;
end $$;


-- =====================================================================
-- 6. TRA CỨU — dùng cho màn tra cứu, chatbot và Market Check
--    Người chỉ có quyền xem: KHÔNG trả tên nhà cung cấp, liên hệ, file.
-- =====================================================================

-- p_f: {kinds:[…], year_from, year_to, unit, won_only, goods_only, category, supplier, limit}
create or replace function pr_search(p_q text, p_f jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  w     text[] := array(select x from regexp_split_to_table(am_norm(coalesce(p_q, '')), '\s+') x where length(x) >= 1);
  full_ boolean := app_can('price', 'create');
  lim   int := least(coalesce(nullif(p_f ->> 'limit', '')::int, 200), 1000);
  rate  numeric := 0.046;
  v     jsonb;
begin
  perform pr_need('view');
  select coalesce(jsonb_agg(q.r order by q.rk desc, q.dt desc nulls last), '[]'::jsonb) into v from (
    select s.quote_date as dt, jsonb_build_object(
      'id', l.id, 'source_id', s.id, 'kind', s.kind, 'ref', case when full_ then s.ref end, 'date', s.quote_date, 'won', s.won,
      'project_code', s.project_code, 'project_name', s.project_name,
      'supplier', case when full_ then s.supplier end, 'contact', case when full_ then s.contact end,
      'file_name', case when full_ then s.file_name end, 'file_url', case when full_ then s.file_url end,
      'name', l.name_raw, 'name_std', l.name_std, 'section', l.section, 'category_code', l.category_code, 'line_kind', l.line_kind, 'grp', l.grp, 'variant', l.variant, 'std_src', l.std_src, 'term_id', l.term_id,
      'brand', l.brand, 'model', l.model, 'origin', l.origin, 'spec', l.spec, 'qty', l.qty, 'unit_raw', l.unit_raw, 'unit', l.unit,
      'unit_price', l.unit_price, 'labor_price', l.labor_price, 'currency', s.currency, 'vat_included', s.vat_included, 'price_vnd', l.price_vnd,
      'price_today', case when l.price_vnd is not null and s.quote_date is not null
                          then round(l.price_vnd * power(1 + rate, greatest(0, extract(year from current_date) - extract(year from s.quote_date))), 0) end,
      'note', l.note) as r,
      (select count(*) from unnest(w) x where position(x in am_norm(coalesce(l.name_std, l.name_raw))) > 0) * 10
        + (select count(*) from unnest(w) x where position(x in coalesce(l.search_norm, '')) > 0) as rk
    from pr_line l join pr_source s on s.id = l.source_id
    where (coalesce(array_length(w, 1), 0) = 0
           or not exists (select 1 from unnest(w) x where position(x in coalesce(l.search_norm, '') || ' ' || am_norm(coalesce(case when full_ then s.supplier end, ''))
                                                                  || ' ' || am_norm(coalesce(s.project_name, ''))) = 0))
      and (p_f -> 'kinds' is null or jsonb_array_length(p_f -> 'kinds') = 0 or s.kind in (select jsonb_array_elements_text(p_f -> 'kinds')))
      and (nullif(p_f ->> 'year_from', '') is null or s.quote_date >= make_date((p_f ->> 'year_from')::int, 1, 1))
      and (nullif(p_f ->> 'year_to', '') is null or s.quote_date <= make_date((p_f ->> 'year_to')::int, 12, 31))
      and (nullif(p_f ->> 'unit', '') is null or l.unit = p_f ->> 'unit')
      and (not coalesce((p_f ->> 'won_only')::boolean, false) or s.won)
      and (not coalesce((p_f ->> 'goods_only')::boolean, false) or l.line_kind = 'goods')
      and (nullif(p_f ->> 'category', '') is null or l.category_code = p_f ->> 'category')
      and (nullif(p_f ->> 'grp', '') is null or l.grp = p_f ->> 'grp')
      and (nullif(p_f ->> 'term_id', '') is null or l.term_id = (p_f ->> 'term_id')::int)
      and (nullif(p_f ->> 'supplier', '') is null or (full_ and position(am_norm(p_f ->> 'supplier') in am_norm(coalesce(s.supplier, ''))) > 0))
    order by rk desc, s.quote_date desc nulls last limit lim) q;
  return v;
end $$;

-- Tổng quan cho màn hình: số nguồn / dòng theo loại, lần đồng bộ, nhà cung cấp (chỉ người nhập).
create or replace function pr_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform pr_need('view');
  return jsonb_build_object(
    'by_kind', (select coalesce(jsonb_object_agg(kind, jsonb_build_object('sources', ns, 'lines', nl)), '{}'::jsonb)
                from (select s.kind, count(distinct s.id) ns, count(l.id) nl from pr_source s left join pr_line l on l.source_id = s.id group by s.kind) q),
    'no_date', (select count(*) from pr_source where quote_date is null and kind in ('legacy', 'quote', 'market')),
    'no_std', (select count(*) from pr_line where name_std is null and line_kind <> 'other'),
    'named', (select coalesce(jsonb_object_agg(coalesce(std_src, 'pending'), n), '{}'::jsonb) from (select std_src, count(*) n from pr_line group by std_src) q),
    'lines', (select count(*) from pr_line),
    'suppliers', case when app_can('price', 'create') then (select count(distinct am_norm(supplier)) from pr_source where supplier is not null) end,
    'last_sync', (select value from am_setting where key = 'pr_last_sync'),
    'base_url', (select value from am_setting where key = 'pr_quotes_base_url'));
end $$;


-- =====================================================================
-- 7. QUYỀN
-- =====================================================================

alter table pr_import enable row level security;
alter table pr_source enable row level security;
alter table pr_line   enable row level security;
alter table pr_unit   enable row level security;
alter table pr_alias  enable row level security;
alter table pr_term   enable row level security;
revoke all on pr_import, pr_source, pr_line, pr_unit, pr_alias, pr_term from anon, authenticated;
grant select on pr_import, pr_source, pr_line, pr_unit, pr_alias, pr_term to authenticated;

-- Bảng đọc thẳng: chỉ người nhập (thấy nhà cung cấp). Người chỉ xem dùng pr_search().
drop policy if exists pr_import_read on pr_import;
create policy pr_import_read on pr_import for select to authenticated using ((select app_can('price', 'create')));
drop policy if exists pr_source_read on pr_source;
create policy pr_source_read on pr_source for select to authenticated using ((select app_can('price', 'create')));
drop policy if exists pr_line_read on pr_line;
create policy pr_line_read on pr_line for select to authenticated using ((select app_can('price', 'create')));
drop policy if exists pr_unit_read on pr_unit;
create policy pr_unit_read on pr_unit for select to authenticated using ((select app_can('price', 'view')));
drop policy if exists pr_alias_read on pr_alias;
create policy pr_alias_read on pr_alias for select to authenticated using ((select app_can('price', 'create')));
drop policy if exists pr_term_read on pr_term;
create policy pr_term_read on pr_term for select to authenticated using ((select app_can('price', 'view')));

do $$
declare t text;
begin
  foreach t in array array['pr_source', 'pr_alias', 'pr_unit', 'pr_term'] loop
    execute format('drop trigger if exists app_audit on %I', t);
    execute format('create trigger app_audit after insert or update or delete on %I for each row execute function app_audit_row()', t);
  end loop;
end $$;

revoke execute on function pr_need(text), pr_unit_of(text), pr_is_service(text), pr_refresh_lines(bigint), pr_put_lines(bigint, jsonb),
  pr_words(text), pr_strip(text), pr_find_term(text), pr_variant(text), pr_auto_std(bigint, int), pr_term_save(jsonb), pr_std_run(boolean, int),
  pr_save_source(jsonb, jsonb), pr_delete_source(bigint), pr_import_legacy(bigint, text, jsonb), pr_set_std(bigint[], text, text),
  pr_sync(), pr_search(text, jsonb), pr_overview()
  from public, anon;
grant execute on function pr_save_source(jsonb, jsonb), pr_delete_source(bigint), pr_import_legacy(bigint, text, jsonb),
  pr_set_std(bigint[], text, text), pr_sync(), pr_search(text, jsonb), pr_overview(), pr_term_save(jsonb), pr_std_run(boolean, int)
  to authenticated;

select app_lock_anon();


-- =====================================================================
-- 8. KIỂM CHỨNG
-- =====================================================================

select 'Bảng CSDL giá có RLS' as "Mục", count(*)::text as "Thực tế", '6' as "Mong đợi", case when count(*) = 6 then '✔' else '✘ HỎNG' end as "Đạt"
from   pg_class where relname in ('pr_import', 'pr_source', 'pr_line', 'pr_unit', 'pr_alias', 'pr_term') and relrowsecurity
union all
select 'Trình duyệt ghi thẳng bảng CSDL giá (phải = 0)', count(*)::text, '0', case when count(*) = 0 then '✔' else '✘ HỎNG' end
from   information_schema.role_table_grants
where  grantee in ('authenticated', 'anon') and table_name like 'pr\_%' and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
union all
select 'Khu quyền "price"', count(*)::text, '1', case when count(*) = 1 then '✔' else '✘ HỎNG' end from app_module where code = 'price'
union all
select 'Hàm CSDL giá', count(*)::text, '9', case when count(*) = 9 then '✔' else '✘ HỎNG' end
from   pg_proc where proname in ('pr_save_source', 'pr_delete_source', 'pr_import_legacy', 'pr_set_std', 'pr_sync', 'pr_search', 'pr_overview', 'pr_term_save', 'pr_std_run')
union all
select 'Từ vựng tên chuẩn', count(*)::text, '>= 237', case when count(*) >= 237 then '✔' else '✘ HỎNG' end from pr_term;
