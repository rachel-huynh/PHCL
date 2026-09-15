# Dữ liệu gốc: điểm đã chốt và điểm còn treo

Cập nhật 2026-09-15 sau khi nhận được **bộ template Beetrack chính thức**
(`Khánh\Asset Management System\...\Sinnova - Amis - Beetrack\Template
Beetrack_PHCL\`). Bộ này là **nguồn chuẩn**; những gì tôi dựng trước đó từ
`Asset code.xlsx` và các biên bản kiểm kê đã bị thay thế.

| File template | Sinh ra |
|---|---|
| `3. category-template-file.xlsx` | `sql/02b_seed_category.sql` — 15 nhóm cha + 28 mã loại |
| `4. department-template-file.xlsx` | `sql/02a_seed_org.sql` — 15 đơn vị |
| `6. location-template-file.xlsx` | `sql/02e_seed_location.sql` — 675 vị trí |
| `8. product-catalogue-template-file.xlsx` | `sql/06_seed_product.sql` — 420 sản phẩm |
| `9. origin-country-template-file.xlsx` | `sql/02d_seed_origin.sql` — 240 quốc gia |
| `10. unit-template-file.xlsx` | `sql/02c_seed_unit.sql` — 16 đơn vị tính |

Chạy lại: `scripts\genseed.ps1` rồi `scripts\build-sql.ps1`.

---

## ⚠️ Ba điều tôi đã kết luận SAI trước đó

### 1. `OEM` có thật — tôi đã bỏ nhầm nó

`Asset code.xlsx` ghi **`OME` ở cả hai chỗ** (C2112 và C2114), nên ngày
2026-09-15 tôi đã kết luận đó là một mã duy nhất và **xoá `OEM`**, rồi nói với
chị rằng nhóm C2114 chỉ còn `ITM`.

Template Beetrack cho thấy đó là **hai mã riêng biệt**:

| Mã | Nhóm cha | Tên |
|---|---|---|
| `OME` | C2112 | Máy móc, thiết bị khác |
| `OEM` | C2114 | Thiết bị, vật dụng, công cụ khác dùng cho mục đích quản lý |

Đúng như danh sách chị đưa trong đề bài ngay từ đầu. Đã khôi phục; `00_verify.sql`
nay kiểm tra riêng cả hai.

### 2. Ý nghĩa hậu tố `-QR` — tôi hiểu ngược

Tôi ghi `-QR` là "có dán QR". Tên đầy đủ trong template nói khác:

| Mã | Tên trong template | Nghĩa thật |
|---|---|---|
| `STG`, `LTG` | *"… - Khác QR"* | mỗi đơn vị **một mã QR riêng** |
| `STG-QR`, `LTG-QR` | *"… - Cùng QR"* | cả lô **dùng chung một mã QR** |

Quy tắc Mã Tài Sản không đổi: phần chữ vẫn bỏ hậu tố `-QR`, nên `LTG` và
`LTG-QR` vẫn **bắt buộc dùng chung một dãy số**.

### 3. Cây phòng ban khác hẳn bản tôi dựng

| | Bản cũ (sai) | Template (đúng) |
|---|---|---|
| Số đơn vị | 14 | **15** |
| `CP` | không có | **có** — Central Plaza, cấp chi nhánh |
| `CEN` | chi nhánh, con của PHCL | **phòng ban, con của `CP`** |
| `SEC` | con của `ADM` | con của `SOF` |
| `ITD` | con của `FIN` | con của `SOF` |

Cột `Mã Công Ty` trong template là **`PHCL` cho mọi dòng**, trong khi dữ liệu
tài sản thật dùng `SOF`/`CEN`. Hai cột này khác ngữ nghĩa: template nói *đơn vị
thuộc pháp nhân nào*, sổ tài sản nói *tài sản thuộc cơ sở nào*. Tôi giữ
`default_company = SOF` và đánh dấu `is_company` cho `PHCL, JVC, CP, CEN, SOF`.

---

## ✅ Các điểm đã chốt

**Mã phòng ban.** `HKD`, `ITD`, `SEC` là mã chuẩn (không phải HKP/IT/Security).
Bảng `am_org_alias` vẫn giữ 5 bí danh để import file cũ không vỡ.

**Vị trí — 675 thay vì 82.** Template có đủ **cả hai toà nhà**: `CP` (Central
Plaza, mã bắt đầu bằng `C`) và `SOF` (Sofitel, mã bắt đầu bằng `S`), 3 cấp
Toà nhà → Tầng → Phòng, quan hệ cha-con lấy thẳng từ cột `Mã Cha` chứ không
còn phải suy từ hình dạng mã. Đã kiểm tra tại chỗ: **0 vị trí mồ côi**.

**Product catalogue — 420 dòng.** Trước đây bảng này trống hoàn toàn. Tên ở
dạng `Tiếng Việt/English` được tách thành `std_name_vi` / `std_name_en`;
`raw_name_norm` do chính hàm `am_norm()` của Postgres tính, nên luôn khớp với
khoá mà ứng dụng tra cứu. Đã kiểm tra: **0 sản phẩm trỏ tới mã danh mục không
tồn tại**.

**Đơn vị tính — 16.** Lưu ý template có **cả `litre` lẫn `lit`** cho cùng một
khái niệm. Tôi giữ nguyên cả hai vì đó là dữ liệu gốc, nhưng nên hợp nhất.

**Office mặc định của phòng ban — 9/10.** Khớp theo đúng tên vị trí:

| Vị trí | Phòng ban | | Vị trí | Phòng ban |
|---|---|---|---|---|
| It office | ITD | | Finance office | FIN |
| Kitchen office | KIT | | Talent & Culture office | ADM |
| Sale office | SMD | | Security office | SEC |
| Housekeeping office | HKD | | Engineering office | ENG |
| F&B office | FBD | | | |

---

## ❓ Còn treo

**`FOD` chưa có office mặc định.** Trong 675 vị trí không có cái nào tên
"Front office". Có `Reservation office` và `Back office` — nhưng tôi không đoán.

**`Talent & Culture office` → `ADM` là suy luận.** T&C là cách Accor gọi bộ
phận nhân sự, mà `ADM` = *Administration & Human Resource Department*. Hợp lý
nhưng vẫn là suy luận, chị xác nhận giúp.

**Lỗi trong chính file template:** dòng `STG-QR` ghi tên *"CCDC **dài hạn** -
Cùng QR"* nhưng mã cha là `C2421` (**ngắn hạn**). Nhiều khả năng copy nhầm từ
dòng `LTG-QR`. Tôi giữ nguyên tên gốc, không tự sửa.

**Bộ đếm vẫn chưa nạp.** Master data đã đủ, nhưng `am_asset_seq` và
`am_barcode_seq` vẫn ở 0 cho tới khi có **bản export tài sản đầy đủ từ
Beetrack**. Nạp thiếu ⇒ cấp trùng mã với tài sản cũ. Xem mục "Bộ đếm" trong
README.

**Trường không có nguồn dữ liệu xác thực.** Biên bản giao hàng không chứa
`Mã Tình Trạng`, vị trí lắp đặt chi tiết, `Mã Người Dùng`, `Ngày Tính Khấu
Hao`. Cột `needs_review jsonb` trên `am_shipment_line` và `am_asset` giữ danh
sách các trường bị suy đoán, để giao diện đánh dấu rõ thay vì âm thầm bỏ qua.

**Mẫu ALR 2023 còn nhắc hệ thống Sinnova.** Công ty nay dùng Beetrack. Bản mặc
định trong app đã bỏ tên đó, và ô ghi chú sửa được cho từng biên bản.
