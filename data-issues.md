# Mâu thuẫn giữa đề bài và dữ liệu gốc của công ty

Ghi lại tại thời điểm dựng schema (2026-09-15). Mỗi mục nêu: bằng chứng, cách
schema đang xử lý tạm, và việc cần chị xác nhận.

Nguồn đã đọc:

| File | Vai trò |
|---|---|
| `OneDrive\Asset code.xlsx` | Nguyên tắc sinh mã + danh mục org/nhóm/loại |
| `DỊU\ASSET MANAGEMENT\Asset Template File - Beetrack.xlsx` | 5 sheet: Unique / Low-value / Area Code / Asset Code / Org Code |
| `DỊU\ASSET MANAGEMENT\Asset Track.xlsx` | Format Beetrack **đang dùng thật** (69 cột) |
| `OneDrive\asset-template-file (1).xlsx` | Template import rút gọn (13 cột Unique) |
| `...\ASSET COUNT\Kiểm kê 07.2025\bien-ban-kiem-ke-*.xlsx` | Biên bản kiểm kê FIN / ADM / SMD |
| `Asset Standardization.ipynb` | Bản đồ cột PO → ALR có sẵn |

---

## 1. `OME` có HAI mã cha — vi phạm "mỗi mã con có đúng 1 mã cha" ⚠️

Sheet `3. Asset Code` liệt kê `OME` ở cả hai chỗ:

- dòng 39: `OME` dưới **C2112** — *Máy móc, thiết bị khác*
- dòng 43: `OME` dưới **C2114** — *Thiết bị, vật dụng, công cụ khác dùng cho mục đích quản lý*

Đề bài của chị lại liệt kê **cả `OME` lẫn `OEM`** — tức trong đầu chị là hai mã
khác nhau.

**✅ Đã chốt (2026-09-15):** giữ đúng mã `OME` của file gốc và gán **một** mã cha
là **C2112**, khớp với mọi Mã Tài Sản thật quét được (`ADM.C2112.OME`,
`FIN.C2112.OME`, `SMD.C2112.OME` — không có cái nào C2114). Không tạo mã `OEM`.

**Hệ quả cần biết:** nhóm **C2114** (*Thiết bị, công cụ quản lý*) giờ chỉ còn
đúng một mã loại là `ITM`. Tài sản mang bản chất "thiết bị/vật dụng khác dùng
cho mục đích quản lý" sẽ phải xếp vào `OME` (C2112). Nếu kế toán muốn C2114 có
mã riêng cho nhóm này thì phải đặt cho nó một mã **khác** `OME`.

---

## 2. Mã phòng ban không nhất quán giữa các file ⚠️

| Vai trò | `Asset code.xlsx` | Beetrack `4. Org Code` | Beetrack `1. Area Code` | File kiểm kê |
|---|---|---|---|---|
| Quản gia | `HKD` | `HKP` | `HKP` | `KiemKe-HKP` |
| IT | `ITD` | `IT` | — | `KiemKe-IT` |
| An ninh | `SEC` | `SEC` | `Security` | `KiemKe-Security` |

Mã Tài Sản thật dùng **`HKD`** (`HKD.C2422.LTU.2025.00993`).

**Đang xử lý:** mã chuẩn = `HKD`, `ITD`, `SEC` (theo `Asset code.xlsx` + dữ liệu
thật); các biến thể nằm trong bảng `am_org_alias` để import file cũ không vỡ.

**Cần xác nhận:** `KiemKe-T&C` (Talent & Culture) và `KiemKe-Reservation + Rev`
thuộc phòng ban nào? Tôi **không** đoán, nên chưa tạo alias cho hai cái này.

---

## 3. Đề bài thiếu vài nhóm có thật trong file gốc

- Đề bài liệt kê `C2111, C2112, C2113, C2114, C2118, C2131-C2138, C2421, C2422`.
- File gốc còn có **`C2115`** (Cây lâu năm, súc vật làm việc) — chính là mã cha
  của `PWP`, mà `PWP` lại **có** trong danh sách của chị.
- `C2137` không tồn tại trong file gốc (dãy C213x nhảy 2131→2136 rồi 2138).

**Đang xử lý:** seed đủ `C2115`, bỏ `C2137`.

---

## 4. Danh sách CCDC bị cấm khi đơn giá > 30 triệu chưa đầy đủ

Đề bài cấm `LTU / LTG / LTG-QR / STG-QR`. Nhưng nhóm CCDC còn `STU` (C2421,
theo mã) và `STG` (C2421, theo số lượng) — cũng là "không đủ điều kiện ghi
nhận TSCĐ".

**✅ Đã chốt (2026-09-15):** giữ nguyên cách đang làm — `am_classify()` chặn cứng
đúng 4 mã chị nêu (`violates_capex = true`), còn `STU`/`STG` chỉ **cảnh báo**
để kế toán quyết định từng trường hợp.

---

## 5. Bộ đếm: dữ liệu thật CHỨNG MINH phải khóa theo (phòng ban, chữ) ✅

Quét 2.500 Mã Tài Sản từ các biên bản kiểm kê:

```
ADM.KME   n=6     max=2     groups=C2112, C2422   <-- cùng chữ, HAI nhóm cha
ADM.FUR   n=185   max=507   groups=C2112
ADM.LTU   n=527   max=464   groups=C2422
ADM.LTG   n=46    max=49    groups=C2422
FIN.ITO   n=563   max=505   groups=C2112
FIN.LTG   n=270   max=280   groups=C2422
FIN.LTU   n=437   max=376   groups=C2422
FIN.ITM   n=1     max=1     groups=C2114
ADM.ITM   n=1     max=1     groups=C2112          <-- ITM lẽ ra chỉ thuộc C2114
FOD.FUR   n=45    max=6024  groups=C2112
FOD.LTU   n=11    max=6006  groups=C2422
HKD.LTU   n=20    max=993   groups=C2422
KIT.KME   n=1     max=183   groups=C2112
```

`ADM.KME` tồn tại dưới **cả** `C2112` và `C2422` mà vẫn dùng chung một dãy số
(max=2). Nếu khóa bộ đếm theo `(phòng ban, nhóm cha, chữ)` thì sẽ sinh **trùng
Mã Tài Sản**. Đây là bằng chứng độc lập xác nhận quy tắc chị nêu ở mục 4 của
đề bài — và cũng là lý do `am_asset_seq` khóa đúng `(dept_code, letters)`.

Dòng `ADM.C2112.ITM` là **sai so với master data** (ITM thuộc C2114). Schema
không tự sửa dữ liệu cũ; chỉ ghi nhận ở đây.

---

## 6. Chưa tìm thấy register đầy đủ trên máy này ⚠️

Số Mã Vạch lớn nhất quét được chỉ tới `JVC.000012012`, từ vài file rời. Các file
`KiemKe-*(full).xlsx` trong `ASSET COUNT\All dept` nặng 20–165 MB nhưng **gần
như toàn ảnh chụp**, phần bảng chỉ vài dòng — không phải sổ đăng ký.

Thư mục `ASSET COUNT\Mã tài sản` **rỗng**.

**Hệ quả:** không thể nạp bộ đếm cho đủ mọi cặp (phòng ban, chữ) ngay bây giờ.
Đã làm sẵn hàm `am_seed_from_codes(text[])` — đưa vào mảng chuỗi bất kỳ (Mã Tài
Sản lẫn Mã Vạch), nó tự bóc tách, lấy max theo từng khóa rồi **chỉ nâng, không
bao giờ hạ** bộ đếm. Chạy lại nhiều lần vô hại.

**Cần chị cung cấp:** một bản export đầy đủ từ Beetrack (toàn bộ tài sản, mọi
phòng ban, mọi năm) để nạp lần đầu. Nạp thiếu ⇒ cấp trùng mã với tài sản cũ.

---

## 7. Đang tồn tại BA layout Excel khác nhau

| File | Cột "Mã Tài Sản" | Cột "Mã Vạch" | Số cột |
|---|---|---|---|
| `Asset Template File - Beetrack.xlsx` | *(không có cột này)* | H | 67 |
| `Asset Track.xlsx` | **G** | **K** | 69 |
| `asset-template-file (1).xlsx` | **H** | **K** | 13 (Unique) / 36 (Low) |

**Đang xử lý:** không hard-code layout. Hai bảng `am_xls_template` +
`am_xls_column` mô tả từng template dưới dạng dữ liệu (số cột → trường trong
`am_asset` → number_format), nên thêm/đổi layout không phải sửa code.

**⏳ Chờ (2026-09-15):** chị sẽ gửi file mẫu đúng. Nhận được thì tôi dựng bản đồ
cột từ chính file đó và nạp vào `am_xls_template` / `am_xls_column`.

Lưu ý khi chọn: `Asset Track.xlsx` tuy đầy đủ nhất nhưng **chỉ có sheet
"Unique asset"** — vẫn cần thêm mẫu sheet "Low-value asset" tương ứng.

---

## 8. Mã vị trí có hai hệ, không tương thích

- Beetrack `1. Area Code`: `S401`, `S207`, `S1809-K`, `CR0`
- Biên bản kiểm kê 07.2025: `S0103B0`, `S1905G0`, `SB120B0`, `S2000E3`

Hệ thứ hai dài hơn và có hậu tố phân loại (`B0` = back office, `G0` = guest
room, `E0` = phòng kỹ thuật, `P0/P1` = public...).

**✅ Đã chốt (2026-09-15): dùng hệ dài.** Đã sinh `sql/02c_seed_location.sql` —
**82 vị trí** trích từ dòng "Bộ phận:" của các biên bản kiểm kê 07.2025, cây
suy ra từ chính mã (`S` → `S<tầng>00` / `SB<hầm>00` → phòng). Sinh tự động bằng
`scripts/genloc.ps1`; sửa script rồi chạy lại, đừng sửa file SQL bằng tay.

Đã gán `is_dept_office` cho **9 phòng ban** — chỉ nhận khi chính tên vị trí nói
rõ phòng ban:

| Vị trí | Phòng ban | | Vị trí | Phòng ban |
|---|---|---|---|---|
| `S0103B0` It office | ITD | | `SB120B0` Finance office | FIN |
| `S0111B0` Kitchen office | KIT | | `SB121` HR office | ADM |
| `S0302B0` Sale office | SMD | | `SB124B0` Security office | SEC |
| `SB117B0` Housekeeping office | HKD | | `SB141B0` Engineering workshop | ENG |
| `SB142B0` F&B office | FBD | | | |

**Còn tồn, cần chị xác nhận:**

- **`FOD` chưa có office mặc định** — danh sách không có vị trí nào tên "Front
  office". `SB109B0 Reservation office` có phải không? Tôi không đoán.
- **`S203`** "Le 17 Bistro restaurant" không theo quy luật (3 chữ số). Nhiều
  khả năng là `S0203`, cùng tầng với `S0203P0` "Mezz restaurant". Đang tạm xếp
  `kind = 'area'`, cha là toà nhà `S`.
- **`SB121`** "HR office" và **`SB121B0`** "Receiving office" cùng số phòng 21
  nhưng khác tên hoàn toàn.
- Danh sách này chỉ gồm phạm vi kiểm kê của FIN/ADM/SMD nên **chưa đủ toàn bộ
  khách sạn** (thiếu phần lớn phòng khách các tầng 4–17). Cần bản export vị trí
  đầy đủ từ Beetrack.

---

## 9. Trường không có nguồn dữ liệu xác thực

Biên bản giao hàng **không** chứa: `Mã Tình Trạng`, vị trí lắp đặt chi tiết
từng thiết bị, `Mã Người Dùng`, `Ngày Tính Khấu Hao`.

**Đang xử lý:** cột `needs_review jsonb` trên cả `am_shipment_line` và
`am_asset`. Mọi trường suy đoán/để trống phải có mục tương ứng trong đó; UI sẽ
hiển thị rõ "placeholder / cần xác nhận" thay vì âm thầm bỏ qua.
