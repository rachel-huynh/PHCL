# asset-intake

Công cụ nội bộ quản lý nhập tài sản từ các đợt giao hàng nhà cung cấp:
chuẩn hóa theo quy tắc kế toán/danh mục của công ty, sinh Mã Tài Sản + Mã Vạch
từ bộ đếm bền vững, xuất Excel đăng ký tài sản và PDF tem nhãn / biên bản ALR.

- **Dữ liệu:** Supabase (PostgreSQL)
- **Giao diện:** web tĩnh, chạy trên GitHub Pages — không cần cài gì
- **Phạm vi:** 1 khách sạn, ít người dùng

> ⚠️ Repo này **PUBLIC**. Tuyệt đối không commit Supabase URL/key vào file.
> Cấu hình phát cho người dùng bằng link dạng `#sbcfg=<base64>` (fragment không
> gửi lên server, app tự xóa khỏi thanh địa chỉ) — cùng cách đã dùng cho
> SSP Budget Tracker.

## Trạng thái

| Giai đoạn | Trạng thái |
|---|---|
| 1. Schema master data + bộ đếm | ✅ đã chạy trên Supabase; hàm sinh mã cho kết quả đúng |
| 2. Nạp bộ đếm từ register hiện có | ✅ màn hình quét + nạp đã chạy, chờ file export đầy đủ |
| 3. Màn hình quản lý master data | ✅ lưới sửa trực tiếp cho 11 bảng |
| 4. Upload PDF + trích xuất bằng Claude vision | ⏳ |
| 5. Xuất Excel (2 sheet Unique / Low-value) | ⏳ |
| 6. PDF tem nhãn Code128 + biên bản ALR | ✅ biên bản 8 cột + trang tem, in được |

Máy đang dùng không có Python / Node / Docker / psql, nên SQL không chạy thử
được tại chỗ — phải chạy thẳng trên Supabase SQL Editor (xem mục **Cài đặt**).
Sau đó mở app, vào **Kết nối → Kiểm tra schema**: nó đếm số dòng từng bảng và
gọi thử hàm để báo bảng/hàm nào còn thiếu.

## Chạy thử tại chỗ

Không cần cài gì — server tĩnh viết bằng PowerShell:

```powershell
.\scripts\serve.ps1 -Port 8325
```

Rồi mở <http://localhost:8325>.

Trang chính là **`AssetManagement.html`** — repo cố ý **không có `index.html`**.
Server tĩnh tự phục vụ file này khi gọi `/`.

### Đường dẫn trên GitHub Pages

URL **phân biệt hoa/thường**, và có kèm tên repo hay không là tuỳ repo:

| Repo chứa file | URL |
|---|---|
| `asset-intake` (repo dự án) | `https://<tài-khoản>.github.io/asset-intake/AssetManagement.html` |
| `<tài-khoản>.github.io` (repo trang cá nhân) | `https://<tài-khoản>.github.io/AssetManagement.html` |

Muốn URL **không có đoạn `/asset-intake/`** thì file phải nằm trong repo tên
đúng bằng `<tài-khoản>.github.io`. Đó là quy định của GitHub Pages, không đổi
được bằng cấu hình.

Trỏ Pages vào nhánh `main`, thư mục gốc. Vì không có `index.html`, mở URL trống
sẽ ra trang 404 của GitHub — bình thường, cứ dùng link đầy đủ ở trên.

## Ngôn ngữ

**Tiếng Anh là ngôn ngữ chính thức**; tiếng Việt chỉ hiện khi bấm **VI** ở góc
phải thanh trên. Lựa chọn lưu trong trình duyệt (`asset-intake.lang`).

Toàn bộ chuỗi giao diện nằm trong `i18n.js`:

- `data-i18n` → `textContent`, `data-i18n-html` → `innerHTML` (chuỗi có
  `<b>`/`<code>`), `data-i18n-ph` → `placeholder`
- trong `app.js` gọi `t('key')` hoặc `t('key', {n: 3})`
- thiếu bản dịch thì tự rơi về tiếng Anh, thiếu luôn thì hiện chính tên khoá —
  để lỗi lộ ra chứ không im lặng thành ô trống

Đổi ngôn ngữ còn đổi cả **định dạng số** (`39,360,000` ↔ `39.360.000`) và dựng
lại biên bản đang mở.

> **Biên bản ALR vẫn song ngữ** dù chọn ngôn ngữ nào — đó là chứng từ chính
> thức của công ty. Ngôn ngữ đang chọn chỉ quyết định vế nào đứng trước:
> `No./Stt` khi EN, `Stt/No.` khi VI.

## Cài đặt

**Cách nhanh:** mở `sql/ALL_IN_ONE.sql`, copy toàn bộ, dán vào Supabase
SQL Editor, bấm **Run**. Rồi dán tiếp `sql/00_verify.sql` và Run lần nữa.

Chạy lại bao nhiêu lần cũng được — mọi lệnh đều `if not exists` /
`on conflict do update` nên **không xoá dữ liệu đã có**.

`ALL_IN_ONE.sql` là bản gộp của 7 file dưới đây, theo đúng thứ tự phụ thuộc.
Muốn chạy từng bước (dễ tìm lỗi hơn) thì chạy lần lượt:

```
sql/01_schema.sql         -- bảng
sql/02_seed_master.sql    -- org, nhóm, mã loại, đơn vị tính, khởi tạo bộ đếm
sql/02b_seed_origin.sql   -- ISO 3166-1 alpha-2 đầy đủ + bí danh
sql/02c_seed_location.sql -- 82 vị trí hệ mã dài + cây tầng/phòng (sinh tự động)
sql/03_functions.sql      -- chuẩn hóa, cấp phát bộ đếm, quy tắc phân loại
sql/04_rls.sql            -- RLS & quyền
sql/05_alr.sql            -- biên bản tem nhãn: cột bổ sung, số hiệu, view in
```

Sửa file gốc thì phải dựng lại bản gộp:

```powershell
.\scripts\build-sql.ps1
```

Rồi chạy `sql/00_verify.sql` — **một câu truy vấn duy nhất** trả về ~35 dòng
kiểm tra, cột cuối là `✔` hoặc `✘ HỎNG`.

> ⚠️ Supabase SQL Editor **chỉ hiện kết quả của câu lệnh CUỐI CÙNG**. Vì vậy
> `00_verify.sql` gộp mọi phép kiểm vào một `select` — dán cả file, Run một
> lần là thấy hết.

> `sql/99_reset.sql` xoá sạch mọi bảng/view/hàm `am_*` để làm lại từ đầu.
> **Không cần dùng trong trường hợp bình thường** — và mất bộ đếm là mất dấu
> những số đã cấp. Nội dung để trong khối chú thích, phải cố ý bỏ chú thích
> mới chạy được.

> Chạy `ALL_IN_ONE.sql` xong thì Results **trống** — bình thường, vì `CREATE
> TABLE` không trả về dòng nào. Nếu panel Results báo *“Failed to get project's
> logs”* thì đó cũng là lỗi giao diện dashboard, **không phải lỗi SQL**.

`02c_seed_location.sql` do `scripts/genloc.ps1` sinh ra từ các biên bản kiểm
kê — sửa script rồi chạy lại, đừng sửa file SQL bằng tay:

```powershell
.\scripts\genloc.ps1 -s <thư-mục-chứa-file-kiểm-kê> -out .\sql\02c_seed_location.sql
```

Sau đó nạp bộ đếm từ sổ tài sản cũ (xem mục dưới).

## Các quyết định cốt lõi

### Mã Tài Sản

```
[Mã Phòng Ban].[Nhóm cha].[CHỮ].[Năm mua].[5 chữ số]
FBD.C2422.LTU.2025.00309
```

Phần **CHỮ** đã **bỏ hậu tố `-QR`**: `LTG-QR` → `LTG`, `STG-QR` → `STG`.

Vì thế bộ đếm khóa theo **`(mã phòng ban, CHỮ)`** — không gồm nhóm cha, không
gồm năm:

- `LTG` và `LTG-QR` cùng hiển thị `LTG` ⇒ bắt buộc dùng chung dãy số, nếu tách
  sẽ sinh trùng mã.
- Dữ liệu thật có `ADM.C2112.KME` và `ADM.C2422.KME` dùng chung dãy số ⇒ khóa
  thêm nhóm cha cũng sinh trùng. Xem `docs/data-issues.md` §5.
- Số thứ tự **không** reset theo năm.

### Mã Vạch

Bộ đếm **tách hoàn toàn** với Mã Tài Sản, và hai dải tách nhau:

| Loại | Định dạng | Dải số |
|---|---|---|
| Unique asset | `JVC.` + 9 chữ số | 1 … 899 999 999 |
| Low-value asset | `JVC.9` + 8 chữ số | 1 … 99 999 999 (in ra `JVC.9xxxxxxxx`) |

Ràng buộc `CHECK` trên `am_asset` ép đúng định dạng theo `asset_kind`, nên
không thể ghi nhầm mã vạch unique cho tài sản low-value.

### Phân loại theo đơn giá

| Ngưỡng | Hệ quả |
|---|---|
| `>= 5.000.000` | **Unique asset** — mỗi đơn vị 1 dòng, `qty = 1` (có `CHECK` ép) |
| `< 5.000.000` | **Low-value** — gộp theo số lượng, hoặc 1 dòng/serial nếu có serial |
| `> 30.000.000` | **Không được** gán mã CCDC. Hữu hình → mã thuộc C2112 đúng bản chất; vô hình → `CTP` (C2135), **không** ép vào C2112 |

`am_classify()` trả về kết luận + mảng cảnh báo, **không tự sửa dữ liệu** —
người dùng phải xác nhận.

### Xuất xứ

Chỉ gán mã ISO khi khớp **đúng một** quốc gia có thật. Chuỗi nhiều quốc gia
(`USA/Mexico/China/Singapore`) hoặc không phải quốc gia (`Asia`, `EU`) ⇒ **để
trống cả mã lẫn tên**, không giữ text gốc, không chọn đại diện.
`am_resolve_origin()` trả kèm lý do (`multi_country` / `not_a_country` /
`ambiguous`) để UI giải thích.

## Bộ đếm

Bảng bộ đếm **không** cấp quyền ghi cho `anon`. Mọi thay đổi đi qua hàm
`SECURITY DEFINER`, nên không thể reset từ trình duyệt kể cả khi lộ anon key.

```sql
-- Cấp 12 số liên tiếp cho phòng ban ADM, chữ LTU
select am_alloc_asset_seq('ADM', 'LTU', 12, :shipment_id, :actor);

-- Cấp 12 mã vạch dải unique
select am_alloc_barcode('unique', 12, :shipment_id, :actor);
select am_format_barcode('unique', 6871);   -- JVC.000006871
select am_format_barcode('low',    1);      -- JVC.900000001
```

Số đã cấp **không tái sử dụng**, kể cả khi đợt nhập bị hủy. Mọi lần cấp đều
ghi vào `am_counter_log` để kế toán truy vết.

### Nạp bộ đếm lần đầu

```sql
-- Đưa vào mảng chuỗi lấy từ file register cũ; nhận cả Mã Tài Sản lẫn Mã Vạch,
-- tự bỏ qua chuỗi sai định dạng, CHỈ nâng chứ không bao giờ hạ bộ đếm.
select * from am_seed_from_codes(array[
  'FBD.C2422.LTU.2025.00309', 'JVC.000006870',
  'KIT.C2112.KME.2025.00183', 'JVC.000006873'
]);
```

Kiểm tra lại bất cứ lúc nào:

```sql
select * from am_audit_counters();   -- gap < 0 nghĩa là bộ đếm ĐANG TỤT SAU sổ
```

> ⚠️ Phải nạp từ bản export **đầy đủ** trước khi cấp mã cho đợt hàng đầu tiên.
> Nạp thiếu sẽ cấp trùng mã với tài sản cũ. Xem `docs/data-issues.md` §6.

## Biên bản bàn giao tem nhãn (ALR)

Theo đúng mẫu `ASSET LABEL RECEIPT.xlsx` của công ty, mở rộng thành **8 cột**:

```
Stt | Mã tài sản | Tên tài sản | Số lượng | Thông số kỹ thuật cơ bản | Đơn giá | Vị trí | Tem nhãn
```

`Đơn giá` và `Vị trí` chèn **trước** cột Tem nhãn. Ô *Thông số kỹ thuật cơ bản*
là bản gom ngắn từ các trường spec chi tiết, theo đúng thứ tự:

```
Nhãn hiệu · Mô đen · Công dụng · Capacity · Dài x Rộng x Cao · Chất liệu · Màu · S/N
```

Cùng một thứ tự được dùng ở cả hai nơi: hàm dựng phía trình duyệt và view
`am_alr_print` trong `05_alr.sql`, để bản in và bản lưu trong database luôn khớp.

**Số hiệu** = `AL.` + phần đuôi của mã dự án FFE, và luôn sửa tay được:

| Mã dự án | Số hiệu biên bản |
|---|---|
| `FFE.CP.28.2023` | `AL.CP.28.2023` |
| `FFE.KIT.05.2025` | `AL.KIT.05.2025` |

Trang tem nhãn in riêng: lưới Code128 (1–6 tem mỗi hàng) kèm tên tài sản và Mã
Tài Sản, có đường cắt. Biên bản in khổ A4 **nằm ngang**, trang tem in **dọc** —
app tự đặt `@page` trước khi gọi in.

> Phần "Quy trình và lưu ý" ở cuối biên bản sửa được trong giao diện và lưu theo
> từng biên bản (`am_alr.notes_text`). Bản mẫu 2023 của công ty còn nhắc hệ thống
> **Sinnova**; bản mặc định trong app đã bỏ tên đó vì công ty nay dùng Beetrack.

## Định dạng Excel

Khi tạo file từ template có sẵn dòng ví dụ mẫu, phải **ghi đè toàn bộ** thuộc
tính định dạng của các dòng đó — bao gồm `number_format`, không chỉ màu
nền/font/viền. Nếu bỏ sót, các dòng đầu giữ định dạng Text (`@`) và số/ngày
hiển thị sai dù dữ liệu đúng. Cột `am_xls_column.number_format` giữ định dạng
đích cho từng cột.

## Còn phải chốt

Xem `docs/data-issues.md` — 9 điểm dữ liệu gốc mâu thuẫn với đề bài, trong đó
4 điểm cần chị xác nhận trước khi đi tiếp.
