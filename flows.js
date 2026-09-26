/* Quy trình (workflows) — the in-app replacement for a user manual.
   Four swimlane workflows in the layout of the SOP template
   "Workflow_Thanh_ly_TSCD.html": one column per actor, phase bars, numbered
   step boxes coloured by actor, the documents each step produces, the
   documents checklist and the control points. A step that has a screen in
   the app links to it (data-go); a step the app does not support yet is
   dashed and tagged "chưa có trên app".

   Content is static and written here (trusted), so it is assembled as HTML.
   Vietnamese first with English subtitles, as the SOP documents are. */
(function () {
'use strict';

// Actor colours: column header, step fill. Hotel blue, AM team purple,
// JVC approval amber — the same colours as the approval chain in the app.
const LANES = {
  dept:    ['#4a6fa5', '#dce8f5', '#4a6fa5'],
  hotel:   ['#2e6da4', '#d4e4f7', '#2e6da4'],
  pur:     ['#0f766e', '#d3ecea', '#0f766e'],
  am:      ['#6b4a8a', '#ead8f0', '#6b4a8a'],
  jvc:     ['#9a6700', '#fbefcf', '#b7860b'],
  fin:     ['#8a5a2e', '#f0e4d4', '#8a5a2e'],
  vendor:  ['#5a8a5a', '#d8edd8', '#5a8a5a'],
  council: ['#1f4e79', '#d6e2f0', '#1f4e79'],
  user:    ['#4a6fa5', '#dce8f5', '#4a6fa5'],
  multi:   ['#4a5a7a', '#eef2f8', '#4a5a7a']
};

const FLOWS = [
/* ═══════════════════════════════════════════════════════════════ 1 */
{ id: '1', code: 'WF-01', icon: '🏗️',
  title: 'QUY TRÌNH MUA SẮM DỰ ÁN CAPEX', en: 'Capex Project Procurement Process',
  short: 'Mua sắm dự án Capex', shortEn: 'Capex procurement',
  scope: 'Từ lập ngân sách / phát sinh nhu cầu đến nghiệm thu bàn giao',
  basis: 'FFE Procurement Document · chuỗi phê duyệt trên app',
  lanes: [['dept', 'Bộ phận đề xuất / Hotel AM', 'Requesting dept · Hotel Asset Manager'],
          ['hotel', 'Ban điều hành KS', 'HOD · DOF · Hotel GM'],
          ['pur', 'Thu mua', 'Purchasing'],
          ['am', 'Nhóm QLTS (JVC)', 'AM Coordinator · AM Executive'],
          ['jvc', 'JVC phê duyệt', 'Chief Accountant · DGM · JVC GM'],
          ['fin', 'Kế toán', 'Finance']],
  phases: [
    { t: '📊 GIAI ĐOẠN 1 – Lập ngân sách & mở dự án', en: 'Budget & project set-up', n: 'Bước 1 → 3', rows: [
      { k: 'B1–B2', s: [
        { l: 'dept', n: 'Bước 1', t: 'Đề xuất nhu cầu vào Capex Budget', en: 'Annual capex submission',
          li: ['Mỗi dòng: hạng mục, vị trí, lý do, giá trị ước tính, phân kỳ theo tháng',
               'Chấm rủi ro: <b>khả năng × tác động</b> → Critical / High / Medium / Low',
               'Trả lời câu hỏi của chủ đầu tư (cột Owner Q / Dept answer)'],
          doc: ['Capex Budget Summary (workbook)'] },
        { l: 'jvc', n: 'Bước 2', t: 'Duyệt ngân sách năm', en: 'Budget approval',
          li: ['SSP: trần = <b>3% doanh thu</b> (FF&E reserve); CP, JVC: không trần nhưng vẫn duyệt',
               'Vòng duyệt cuối = <b>Master Data</b> của năm; tỷ giá cố định theo năm'],
          doc: ['Master Data ngân sách'], go: 'budget' }] },
      { k: 'B3', s: [
        { l: 'am', n: 'Bước 3', t: 'Nạp ngân sách, mở dự án', en: 'Load budget, open projects',
          li: ['Nạp workbook ở <b>Nguồn dữ liệu</b>; mỗi dòng ngân sách là một dự án (mã FFE.&lt;BP&gt;.&lt;số&gt;.&lt;năm&gt;)',
               'Dự án chuyển năm giữ nguyên mã; nhu cầu ngoài ngân sách → PR <b>unbudgeted</b>'],
          go: 'projects' },
        { l: 'dept', dec: true, t: 'Có trong ngân sách?', li: ['Có → PR theo mã dự án', 'Không → PR ngoài ngân sách (cảnh báo &gt; USD 50.000)'] }] }] },
    { t: '📝 GIAI ĐOẠN 2 – Đề xuất & thẩm định (gói PR + RR + PA)', en: 'Request & appraisal package', n: 'Bước 4 → 7', rows: [
      { k: 'B4–B5', s: [
        { l: 'dept', n: 'Bước 4', t: 'Lập PR (+ RR nếu thay thế)', en: 'Purchase Request / Replacement Request',
          li: ['Hạng mục chọn từ <b>danh mục sản phẩm</b>, vị trí theo mã vị trí, SL, đơn giá dự kiến, tiêu chuẩn kỹ thuật',
               'RR: mã tài sản cũ (tra sổ tài sản) và phương án: Liquidation / Spare / …',
               'Ký điện tử khi gửi'],
          doc: ['PR', 'RR'], go: 'projects' },
        { l: 'hotel', n: 'Bước 5', t: 'Khách sạn duyệt PR + RR', en: 'Hotel approval',
          li: ['Trưởng BP → DOF → Hotel GM duyệt <b>cả gói</b>', 'Trả lại = cả gói về người lập'], go: 'inbox' }] },
      { k: 'B6–B7', s: [
        { l: 'am', n: 'Bước 6', t: 'Kiểm tra PR/RR, lập PA', en: 'Check & Project Appraisal',
          li: ['AM Coordinator kiểm tra PR/RR và lập PA; một chữ ký "Checked" cho cả gói',
               'PA: loại dự án, điểm rủi ro, giá trị → <b>phương thức mua sắm</b> khoá theo ma trận (chi tiết WF-01b)',
               'Cảnh báo: vượt ngân sách &gt; 10% hoặc &gt; USD 5.000'],
          doc: ['PA'] },
        { l: 'jvc', n: 'Bước 7', t: 'JVC duyệt PR + PA', en: 'JVC approval',
          li: ['Kế toán trưởng → (DGM) → TGĐ JVC duyệt cùng lúc', 'Chỉ trả PA về nhóm QLTS nếu cần sửa thẩm định'],
          go: 'inbox' }] }] },
    { t: '🤝 GIAI ĐOẠN 3 – Lựa chọn nhà cung cấp (gói QC + MC) → chi tiết WF-01b', en: 'Vendor selection', n: 'Bước 8 → 10', rows: [
      { k: 'B8–B10', s: [
        { l: 'pur', n: 'Bước 8–9', t: 'Mời chào giá & lập QC', en: 'Tender & Quotation Comparison',
          li: ['Theo phương thức trong PA: chỉ định / mua trực tiếp / chào hàng cạnh tranh (≥ 3) / đấu thầu rộng rãi',
               'Hồ sơ nhận qua <b>Cổng nhà thầu</b> (niêm phong đến khi mở)',
               'QC: so sánh giá, chấm năng lực – kỹ thuật – tài chính'],
          doc: ['Thư mời chào giá', 'Hồ sơ dự thầu', 'QC'], go: 'projects' },
        { l: 'hotel', t: 'Duyệt QC', li: ['Trưởng BP → DOF → Hotel GM'] },
        { l: 'am', n: 'Bước 10', t: 'MC – kiểm tra giá thị trường', en: 'Market Check',
          li: ['So giá chọn với giá lịch sử (quy về hiện tại 4,6%/năm) và giá thị trường', 'Lấy giá tham chiếu từ <b>CSDL giá</b> (báo giá cũ, QC, PO, nhận hàng) → điền B / C', 'Lệch &gt; 10% phải giải trình'],
          doc: ['MC'], go: 'price' },
        { l: 'jvc', t: 'Duyệt QC + MC', li: ['KTT → TGĐ JVC duyệt cùng lúc; có thể chỉ trả MC'], go: 'inbox' }] }] },
    { t: '📦 GIAI ĐOẠN 4 – Đặt hàng, hợp đồng & thanh toán', en: 'Order, contract & payment', n: 'Bước 11 → 12', rows: [
      { k: 'B11–B12', s: [
        { l: 'pur', n: 'Bước 11', t: 'Lập PO / Hợp đồng', en: 'Purchase Order / Contract',
          li: ['PO lấy hạng mục + thông số từ QC', 'CT (không bắt buộc): link file đã ký, giá trị, lịch thanh toán',
               'Duyệt theo chuỗi; duyệt xong → giá trị hợp đồng vào dự án'],
          doc: ['PO', 'CT'] },
        { l: 'jvc', t: 'Duyệt PO / CT', li: ['Theo chuỗi phê duyệt của pháp nhân'], go: 'chains' },
        { l: 'fin', n: 'Bước 12', t: 'Thanh toán theo tiến độ', en: 'Payments',
          li: ['Gửi hàng tháng: bảng kê hoá đơn + thu chi tiền gửi (luỹ kế từ đầu năm)',
               'App tự phân bổ theo mã dự án; dòng nhiều mã → phân bổ tay',
               'Theo dõi NET (ngân sách) và GROSS (tiền), VAT riêng'],
          doc: ['Hoá đơn', 'Chứng từ thanh toán'], go: 'payments' }] }] },
    { t: '✅ GIAI ĐOẠN 5 – Giao nhận, dán tem & nghiệm thu', en: 'Delivery, labelling & handover', n: 'Bước 13 → 16', rows: [
      { k: 'B13–B14', s: [
        { l: 'dept', n: 'Bước 13', t: 'Nhận hàng → tài sản tạm', en: 'Goods receipt',
          li: ['Thu mua / Hotel AM nhận hàng theo PO ở <b>Nhận hàng mới</b>',
               'Mỗi tài sản được cấp <b>mã tài sản + mã vạch</b>, trạng thái 120/119 "Chờ duyệt", giá tạm = đơn giá PO'],
          doc: ['Phiếu nhận hàng'], go: 'intake' },
        { l: 'am', n: 'Bước 14', t: 'Biên bản dán tem (AL)', en: 'Asset Label Record',
          li: ['AM Coordinator lập → AM Executive kiểm → KTT duyệt → Hotel AM nhận', 'In tem, dán, đánh dấu "đã in tem"'],
          doc: ['AL / ALR'], go: 'alr' }] },
      { k: 'B15–B16', s: [
        { l: 'dept', n: 'Bước 15', t: 'Chụp ảnh & lập AH', en: 'Photos & Acceptance Handover',
          li: ['Hotel AM chụp <b>2 ảnh / tài sản</b> (tem + tổng thể) — thiếu ảnh không gửi được AH',
               'AH lập từ các AL đã duyệt; nghiệm thu nhiều lần, lần cuối đánh dấu "final"'],
          doc: ['Ảnh tem', 'AH'] },
        { l: 'jvc', n: 'Bước 16', t: 'Duyệt AH → đưa vào sử dụng', en: 'Handover approved',
          li: ['Tài sản → <b>1 / 20 Đang sử dụng</b>', 'AH cuối: tài sản cũ theo RR "Liquidation" → 8/24 + LR nháp (→ WF-03); "Spare" → 2',
               'Kế toán ghi nhận chính thức sau quyết toán (→ WF-02)'] }] }] }],
  docs: [['01', 'Capex Budget (Master Data)'], ['02', 'PR – Purchase Request'], ['03', 'RR – Replacement Request (nếu thay thế)'],
         ['04', 'PA – Project Appraisal'], ['05', 'Thư mời / hồ sơ dự thầu'], ['06', 'QC – Quotation Comparison'], ['07', 'MC – Market Check'],
         ['08', 'PO – Purchase Order'], ['09', 'CT – Hợp đồng (nếu có)'], ['10', 'Hoá đơn & chứng từ thanh toán'],
         ['11', 'AL – Biên bản dán tem'], ['12', 'Ảnh tem + tổng thể'], ['13', 'AH – Biên bản nghiệm thu bàn giao']],
  rules: ['Hồ sơ đi theo <b>gói</b>: PR + RR + PA, QC + MC; PO, CT, AH mỗi loại một gói',
          'Người lập <b>không tự duyệt</b> gói của mình',
          'Trả lại = cả gói về người lập; sau bước kiểm tra của nhóm QLTS, KTT/TGĐ chỉ trả PA/MC',
          'Phương thức mua sắm khoá theo ma trận rủi ro × giá trị',
          'AH chỉ gửi được khi đủ <b>2 ảnh / tài sản</b>',
          'Ngân sách tính trên giá <b>chưa VAT</b>; tiền mặt theo giá có VAT']
},
/* ═══════════════════════════════════════════════════════════════ 1b */
{ id: '1b', code: 'WF-01b', icon: '⚖️',
  title: 'ĐÁNH GIÁ & LỰA CHỌN PHƯƠNG THỨC MUA SẮM, NHÀ CUNG CẤP', en: 'Tendering Method & Vendor Selection',
  short: 'Chọn phương thức & nhà cung cấp', shortEn: 'Tendering & vendor selection',
  scope: 'Chi tiết Giai đoạn 3 của WF-01: từ PA đến trao thầu',
  basis: 'Ma trận phương thức (Menu – FFE Procurement Document) · Cổng nhà thầu',
  lanes: [['am', 'Nhóm QLTS (JVC)', 'AM Coordinator · AM Executive'],
          ['pur', 'Thu mua', 'Purchasing'],
          ['vendor', 'Nhà cung cấp', 'Vendors / Bidders'],
          ['hotel', 'Trưởng BP · DOF · GM', 'Unseal & approve'],
          ['jvc', 'JVC phê duyệt', 'Chief Accountant · JVC GM']],
  phases: [
    { t: '🧭 GIAI ĐOẠN 1 – Xác định phương thức mua sắm', en: 'Choose the method', n: 'Bước 1 → 2', rows: [
      { k: 'B1–B2', s: [
        { l: 'am', n: 'Bước 1', t: 'Chấm điểm trong PA', en: 'Appraisal scoring',
          li: ['Loại dự án: <b>Consultancy</b> (tư vấn) / <b>Non-consultancy</b>',
               'Mức rủi ro: Critical / High / Medium / Low',
               'Giá trị: ≤ 200 tr · ≤ 500 tr · ≤ 1 tỷ · ≤ 5 tỷ · &gt; 5 tỷ',
               'App đề xuất và <b>khoá</b> phương thức theo ma trận (bảng dưới)'],
          doc: ['PA'] },
        { l: 'jvc', n: 'Bước 2', t: 'Duyệt PA cùng PR', en: 'Method approved',
          li: ['Phương thức đã duyệt là căn cứ để Thu mua mời chào giá'], go: 'inbox' }] }],
      matrix: true },
    { t: '📨 GIAI ĐOẠN 2 – Chuẩn bị & mời chào giá', en: 'Prepare & invite', n: 'Bước 3 → 5', rows: [
      { k: 'B3–B4', s: [
        { l: 'pur', n: 'Bước 3', t: 'Soạn hồ sơ mời', en: 'Tender pack',
          li: ['Danh sách hạng mục (từ PR), chi phí khác (vận chuyển, lắp đặt…), điều khoản thanh toán',
               'Câu hỏi năng lực, thông số yêu cầu (hãng, model, xuất xứ…)',
               'Tiêu chí &amp; trọng số: năng lực 10 · kỹ thuật 60 · tài chính 30 (tài chính = giá 80 + thanh toán 20) — chỉnh được, tổng phải 100',
               'Hạn nộp (mặc định 14 ngày)'],
          doc: ['Mẫu Excel: Items / Overheads / Terms / Capability'] },
        { l: 'pur', n: 'Bước 4', t: 'Chọn NCC & gửi link', en: 'Shortlist & invite',
          li: ['Chọn từ danh mục <b>Nhà cung cấp</b> (xem điểm đánh giá các lần trước)',
               'Chỉ định / mua trực tiếp: 1 NCC, ghi lý do · Chào hàng cạnh tranh: <b>≥ 3 NCC</b> · Đấu thầu rộng rãi: thông báo công khai',
               'Mỗi NCC một link cổng (mã chỉ hiện một lần), gửi email'],
          doc: ['Thư mời chào giá'], go: 'tbl:pm_vendor' }] },
      { k: 'B5', s: [
        { l: 'vendor', n: 'Bước 5', t: 'Nộp hồ sơ dự thầu', en: 'Bid submission',
          li: ['Mở link, điền đơn giá từng hạng mục, thông số, chi phí khác, điều khoản thanh toán, trả lời năng lực',
               'Đính kèm file (catalogue, báo giá ký đóng dấu, hồ sơ pháp lý)',
               'Nộp → <b>khoá</b>; muốn sửa phải nộp bản thay thế kèm lý do'],
          doc: ['Hồ sơ dự thầu + file'] },
        { l: 'pur', t: 'Theo dõi', li: ['Thấy trạng thái (chưa mở / nháp / đã nộp), <b>không thấy giá</b> đến khi mở niêm phong', 'Nhắc NCC trước hạn'] }] }] },
    { t: '🔓 GIAI ĐOẠN 3 – Mở niêm phong & đánh giá', en: 'Unseal & evaluate', n: 'Bước 6 → 9', rows: [
      { k: 'B6–B7', s: [
        { l: 'hotel', n: 'Bước 6', t: 'Mở niêm phong', en: 'Bid opening',
          li: ['Cần đồng ý của <b>3 vai trò</b>: Thu mua, Trưởng BP, DOF — ba người khác nhau',
               'Chỉ mở sau hạn nộp hoặc khi mọi NCC đã nộp; mỗi lần mở mở toàn bộ hồ sơ đang niêm phong'],
          doc: ['Nhật ký mở thầu'] },
        { l: 'pur', n: 'Bước 7', t: 'Nạp vào QC & chấm điểm', en: 'Load to QC & score',
          li: ['"Nạp vào QC" tối đa 3 hồ sơ: giá, chi phí khác, thông số, điều khoản đổ thẳng vào QC',
               'Chấm năng lực / kỹ thuật theo tiêu chí con',
               'Điểm giá = giá thấp nhất ÷ giá NCC; tổng = Σ điểm × trọng số',
               'NCC điểm cao nhất = đề xuất (cột A)'],
          doc: ['QC + phụ lục chấm điểm'] }] },
      { k: 'B8–B9', s: [
        { l: 'pur', dec: true, t: 'Đạt?', li: ['Vượt ngân sách / &lt; 3 hồ sơ hợp lệ / không đạt kỹ thuật → mở <b>vòng mới</b> hoặc đàm phán'] },
        { l: 'am', n: 'Bước 8', t: 'MC – kiểm tra giá', en: 'Market Check',
          li: ['Giá lịch sử quy về hiện tại: FV = PV × 1,046ⁿ', 'Giá tham chiếu tra ở <b>CSDL giá</b>: nút "Giá tham chiếu cho MC này" trên form MC', 'So với giá thị trường; lệch <b>&gt; 10%</b> phải giải trình'],
          doc: ['MC'], go: 'price' },
        { l: 'hotel', n: 'Bước 9', t: 'Duyệt QC', en: 'QC approval', li: ['Trưởng BP → DOF → Hotel GM'], go: 'inbox' }] }] },
    { t: '🏆 GIAI ĐOẠN 4 – Phê duyệt & trao thầu', en: 'Approve & award', n: 'Bước 10 → 11', rows: [
      { k: 'B10–B11', s: [
        { l: 'jvc', n: 'Bước 10', t: 'Duyệt QC + MC', en: 'JVC approval',
          li: ['KTT → TGĐ JVC duyệt cùng lúc', 'Có thể chỉ trả MC về nhóm QLTS'], go: 'inbox' },
        { l: 'pur', n: 'Bước 11', t: 'Thông báo kết quả, lập PO / CT', en: 'Award',
          li: ['Báo NCC trúng / không trúng', 'Cập nhật điểm đánh giá NCC', 'Lập PO / hợp đồng (→ WF-01 GĐ 4)'],
          doc: ['Thư thông báo kết quả', 'PO / CT'] },
        { l: 'vendor', t: 'Xác nhận đơn hàng', li: ['Ký hợp đồng / xác nhận PO, giao hàng theo tiến độ'] }] }] }],
  docs: [['01', 'PA – phương thức mua sắm đã duyệt'], ['02', 'Hồ sơ mời chào giá (mẫu Excel)'], ['03', 'Thư mời / link cổng từng NCC'],
         ['04', 'Hồ sơ dự thầu + file đính kèm'], ['05', 'Nhật ký mở niêm phong'], ['06', 'QC + phụ lục chấm điểm'],
         ['07', 'MC – kiểm tra giá thị trường'], ['08', 'Thư thông báo kết quả'], ['09', 'PO / Hợp đồng']],
  rules: ['Phương thức <b>khoá</b> theo ma trận — không tự chọn thấp hơn',
          'Chào hàng cạnh tranh cần <b>≥ 3 báo giá</b>',
          'Giá được <b>niêm phong</b> tới khi 3 vai trò cùng mở; mở sau hạn hoặc khi đủ hồ sơ',
          'Hồ sơ đã nộp bị khoá; sửa = bản thay thế có lý do (bản cũ lưu lại)',
          'Trọng số tiêu chí phải cộng đủ 100',
          'MC lệch &gt; 10% phải giải trình trước khi JVC duyệt']
},
/* ═══════════════════════════════════════════════════════════════ 2 */
{ id: '2', code: 'WF-02', icon: '🏷️',
  title: 'QUY TRÌNH GHI NHẬN & QUẢN LÝ TÀI SẢN', en: 'Asset Recognition & Lifecycle Management',
  short: 'Ghi nhận & quản lý tài sản', shortEn: 'Asset recognition & lifecycle',
  scope: 'Từ tài sản tạm → ghi nhận chính thức → sử dụng, điều chuyển, kiểm kê → thanh lý',
  basis: 'Sổ tài sản (hiện vật) ↔ sổ khấu hao kế toán (giá trị)',
  lanes: [['dept', 'Thu mua · Hotel AM', 'Receiving'],
          ['am', 'Nhóm QLTS', 'Asset Management team'],
          ['user', 'Bộ phận sử dụng', 'User department'],
          ['fin', 'Kế toán', 'Finance'],
          ['jvc', 'Ban giám đốc', 'Management approval']],
  phases: [
    { t: '🧾 GIAI ĐOẠN 1 – Hình thành tài sản tạm', en: 'Provisional asset', n: 'Bước 1 → 3', rows: [
      { k: 'B1–B3', s: [
        { l: 'dept', n: 'Bước 1', t: 'Nhận hàng, cấp mã', en: 'Receive & code',
          li: ['Theo PO (WF-01) ở <b>Nhận hàng mới</b>: tài sản riêng (TSCĐ) hoặc nhóm CCDC',
               'Mã tài sản theo quy tắc bộ đếm + mã vạch; tên theo <b>tên chuẩn hoá</b> của danh mục',
               'Trạng thái 120 / 119 "Chờ duyệt"; giá tạm = đơn giá PO'],
          doc: ['Phiếu nhận hàng'], go: 'intake' },
        { l: 'am', n: 'Bước 2', t: 'Dán tem (AL)', en: 'Labelling',
          li: ['Biên bản dán tem, in tem mã vạch, "đã in tem"', 'Phần mềm, cải tạo, chi phí di dời: <b>không dán tem</b>'],
          doc: ['AL / ALR'], go: 'alr' },
        { l: 'user', n: 'Bước 3', t: 'Nghiệm thu bàn giao (AH)', en: 'Acceptance',
          li: ['Ảnh tem + tổng thể; AH duyệt → <b>1 / 20 Đang sử dụng</b>', 'Bộ phận và vị trí sử dụng được ghi trên sổ'],
          doc: ['AH'] }] }] },
    { t: '🔗 GIAI ĐOẠN 2 – Ghi nhận chính thức (đối chiếu kế toán gối đầu)', en: 'Official recognition — rolling reconciliation', n: 'Bước 4 → 8', rows: [
      { k: 'B4', s: [
        { l: 'fin', n: 'Bước 4', t: 'Quyết toán & hạch toán', en: 'Settlement & booking',
          li: ['Sau khi hợp đồng / dự án quyết toán: nguyên giá chính thức, ngày và kỳ khấu hao',
               'Gửi hàng tháng 3 file: TSCĐ · trả trước dài hạn 2422 · ngắn hạn 2421',
               'Điền cột <b>"Mã TS mới"</b> bằng mã tài sản của app'],
          doc: ['Sổ khấu hao TSCĐ', 'Sổ 2422', 'Sổ 2421'] }] },
      { k: 'B5–B6', s: [
        { l: 'am', n: 'Bước 5', t: 'Nạp file & liên kết', en: 'Import & link',
          li: ['Nạp ở <b>Đối chiếu kế toán</b> — không khoá tháng: tài sản tạm nằm trong hàng đợi tới khi được liên kết',
               'Dòng có "Mã TS mới" tự liên kết; còn lại ghép <b>theo dự án</b> (tick dòng ↔ tài sản) hoặc gợi ý một–một',
               'Tên kế toán khác tên chuẩn hoá: app nhớ cặp tên đã ghép cho lần sau'],
          go: 'acc' },
        { l: 'am', n: 'Bước 6', t: 'Dòng gộp: liên kết trước, phân bổ sau', en: 'Group lines',
          li: ['Cải tạo / hệ thống: liên kết nhiều tài sản vào một dòng', 'Đủ thông tin → phân bổ theo giá tạm, chia đều hoặc nhập %',
               'Tài sản: tạm → <b>đã liên kết</b> → <b>đã ghi nhận</b> (nguyên giá, GTCL theo sổ KT)'],
          go: 'acc' }] },
      { k: 'B7–B8', s: [
        { l: 'am', n: 'Bước 7', t: 'Bổ sung & loại trừ', en: 'Add or exclude',
          li: ['Dòng KT chưa có trên sổ tài sản → <b>bổ sung</b> qua màn nhận hàng (tự liên kết)',
               'Bỏ qua kèm lý do: hoa hồng, bảo hiểm, quyền sử dụng đất',
               'Tài sản không có trên sổ KT (chi phí, dưới ngưỡng) → đánh dấu'] },
        { l: 'fin', n: 'Bước 8', t: 'Nhận mã TS, xử lý chênh lệch', en: 'Codes back to accounting',
          li: ['AM xuất file "Mã TS cho kế toán" → kế toán dán vào "Mã TS mới"',
               'Chênh lệch nguyên giá / kỳ / bộ phận / dòng biến mất: hai bên thống nhất'],
          doc: ['File Mã TS mới'] }] }] },
    { t: '🔄 GIAI ĐOẠN 3 – Sử dụng, sự cố & điều chuyển', en: 'In use — incidents & transfers', n: 'Bước 9 → 12', rows: [
      { k: 'B9–B10', s: [
        { l: 'user', n: 'Bước 9', t: 'Báo sự cố', en: 'Report an incident',
          li: ['Hỏng / bảo dưỡng / vỡ (B&amp;L) / mất — ở <b>Sự cố &amp; sửa chữa</b> hoặc từ bảng tài sản',
               'Báo hỏng → tài sản "chờ sửa" (3 / 25); tự tích "còn bảo hành" theo hạn bảo hành'],
          doc: ['Phiếu báo sự cố'], go: 'incident' },
        { l: 'am', n: 'Bước 10', t: 'Xử lý & đóng sự cố', en: 'Repair & close',
          li: ['Work order, đơn vị sửa, chi phí; "đang xử lý" → đang sửa (5) / bảo dưỡng (6)',
               'Đóng: sửa xong → tình trạng cũ · không sửa được → 4 / 25 → <b>lập LR</b> (WF-03) · mất → 0 (CCDC trừ số lượng)',
               'Số lần sửa và hạn bảo hành tự điền vào LR'],
          go: 'incident' }] },
      { k: 'B11–B12', s: [
        { l: 'user', n: 'Bước 11', t: 'Lập phiếu điều chuyển', en: 'Transfer slip',
          li: ['Bộ phận giao chọn tài sản, bộ phận / vị trí nhận, lý do', 'CCDC chuyển một phần → tách dòng mới (mã + mã vạch mới)'],
          doc: ['Phiếu điều chuyển'], go: 'transfer' },
        { l: 'am', n: 'Bước 12', t: 'Duyệt & cập nhật sổ', en: 'Approve & update',
          li: ['Trưởng BP giao → trưởng BP nhận → TGĐ JVC (khác pháp nhân) → QLTS xác nhận',
               'Đổi bộ phận: <b>cấp mã mới</b>, giữ mã vạch, đưa tem vào hàng đợi in lại'],
          go: 'transfer' }] }] },
    { t: '🔍 GIAI ĐOẠN 4 – Kiểm tra, kiểm kê & báo cáo định kỳ', en: 'Checks, stock-take & periodic reports', n: 'Bước 13 → 17', rows: [
      { k: 'B13–B14', s: [
        { l: 'am', n: 'Bước 13', t: 'Đối chiếu hàng tháng', en: 'Monthly reconciliation',
          li: ['Theo dõi: tài sản tạm chờ ≥ 3 tháng, dòng KT chưa có tài sản, dòng gộp chưa phân bổ, chênh lệch',
               'Việc còn lại chuyển sang tháng sau (gối đầu)'], go: 'acc' },
        { l: 'am', n: 'Bước 14', t: 'Mở đợt kiểm kê', en: 'Open a stock-take',
          li: ['Chọn bộ phận / vị trí, ngày, ban kiểm kê', 'Mở đợt → <b>chốt danh sách sổ</b> tại thời điểm mở'],
          go: 'stock' }] },
      { k: 'B15–B16', s: [
        { l: 'user', n: 'Bước 15', t: 'Kiểm trên máy tính bảng', en: 'Count on the tablet',
          li: ['Chọn vị trí đang đứng, quét mã vạch', 'Thấy / không thấy / sai vị trí / thiếu SL / hỏng; mã lạ → ghi "thừa"'],
          go: 'stockcount' },
        { l: 'am', n: 'Bước 16', t: 'Đóng đợt & biên bản', en: 'Close & minutes',
          li: ['Cập nhật vị trí; không thấy → sự cố "mất"; hỏng → sự cố "sửa chữa"',
               'Biên bản kiểm kê (chênh lệch / toàn bộ) PDF, Excel; thành viên ký'],
          doc: ['Biên bản kiểm kê'], go: 'stock' }] },
      { k: 'B17', s: [
        { l: 'jvc', n: 'Bước 17', t: 'Báo cáo định kỳ', en: 'Periodic reports',
          li: ['Tháng / quý / năm: số lượng, giá trị, nguyên giá KT, GTCL theo bộ phận – nhóm – tình trạng',
               'Biến động trong kỳ, việc tồn, kết quả kiểm kê; <b>chốt kỳ</b> để lưu và so sánh', 'PDF / Excel gửi BGĐ'],
          doc: ['Báo cáo tài sản định kỳ'], go: 'amrep' }] }] },
    { t: '🏁 GIAI ĐOẠN 5 – Kết thúc dòng đời', en: 'End of life', n: 'Bước 18', rows: [
      { k: 'B18', s: [
        { l: 'user', n: 'Bước 18', t: 'Đề xuất thanh lý → WF-03', en: 'Disposal',
          li: ['RR "Liquidation" khi thay thế, hoặc LR do bộ phận đề xuất → trạng thái 8 / 24 chờ thanh lý',
               'Đóng đợt: 7 đã thanh lý · 23 CCDC đã thanh lý · 9 huỷ · 0 mất'], go: 'liq' },
        { l: 'fin', t: 'Ghi giảm', li: ['Kế toán ghi giảm; tab "Chênh lệch" báo tài sản đã thanh lý mà sổ KT chưa ghi giảm'] }] }] }],
  docs: [['01', 'Phiếu nhận hàng (mã TS + mã vạch)'], ['02', 'AL – Biên bản dán tem'], ['03', 'AH – Nghiệm thu bàn giao'],
         ['04', 'Sổ khấu hao TSCĐ / 2422 / 2421 hàng tháng'], ['05', 'File "Mã TS mới" cho kế toán'], ['06', 'Work order · B&L report'],
         ['07', 'Phiếu điều chuyển'], ['08', 'Biên bản kiểm kê'], ['09', 'Báo cáo tài sản định kỳ']],
  rules: ['Sổ tài sản (hiện vật, tên chuẩn hoá) và sổ kế toán (giá trị) là <b>hai sổ</b>, nối bằng liên kết — không sửa tên theo kế toán',
          'Tài sản tạm dùng giá PO cho tới khi kế toán ghi nhận; nguyên giá / khấu hao chính thức chỉ lấy từ sổ KT',
          'Đối chiếu <b>gối đầu</b>: không khoá tháng, việc tồn chuyển sang tháng sau',
          'Ghép từ 2022 trở đi trước; dữ liệu cũ hơn xử lý sau',
          'Mọi thay đổi trên sổ tài sản được ghi nhật ký'],
  remind: 'Đã có trên app (26/09/2026): phiếu điều chuyển có duyệt, sự cố – sửa chữa – bảo hành – B&amp;L, kiểm kê định kỳ bằng máy tính bảng, báo cáo định kỳ có chốt kỳ, dòng đời từng tài sản (bấm mã tài sản ở Sổ tài sản). '
        + 'Còn chờ quyết định: gửi báo cáo tự động theo lịch, chữ ký tay trên phiếu điều chuyển / biên bản kiểm kê, email thông báo.'
},
/* ═══════════════════════════════════════════════════════════════ 3 */
{ id: '3', code: 'WF-03', icon: '♻️',
  title: 'QUY TRÌNH THANH LÝ TÀI SẢN', en: 'Asset Liquidation Process',
  short: 'Thanh lý tài sản', shortEn: 'Liquidation',
  scope: 'Từ RR / LR đến xuất hoá đơn và đối chiếu xong giá trị tài sản',
  basis: 'TT 45/2013/TT-BTC · TT 200/2014/TT-BTC (mẫu 02, 04, 05-TSCĐ)',
  lanes: [['dept', 'Bộ phận đề xuất', 'Requesting dept'],
          ['am', 'Nhóm QLTS', 'AM Coordinator · AM Executive'],
          ['council', 'Hội đồng thanh lý', 'Liquidation council'],
          ['vendor', 'Bên thu mua', 'Buyers'],
          ['fin', 'Kế toán', 'Finance'],
          ['jvc', 'KS / JVC phê duyệt', 'HOD · DOF · GM · KTT · TGĐ']],
  phases: [
    { t: '📋 GIAI ĐOẠN 1 – Đề xuất thanh lý (LR + Disposal Form)', en: 'Liquidation request', n: 'Bước 1 → 3', rows: [
      { k: 'B1–B2', s: [
        { l: 'dept', n: 'Bước 1', t: 'Lập LR', en: 'Liquidation Request',
          li: ['Nguồn: RR "Liquidation" → <b>LR nháp tự tạo</b> khi AH cuối được duyệt; hoặc bộ phận tự lập',
               'Mỗi dòng: hiện trạng (Full Operational / Poor / Damaged), lý do, phương án (bán / huỷ)',
               '≥ 1 <b>ảnh hiện trạng</b> mỗi dòng; nguyên giá – hao mòn lấy từ sổ KT nếu đã ghi nhận'],
          doc: ['LR', 'Asset Disposal Form', 'Ảnh hiện trạng'], go: 'liq' },
        { l: 'jvc', n: 'Bước 2', t: 'Khách sạn duyệt', en: 'Hotel approval', li: ['Trưởng BP → DOF → Hotel GM'], go: 'inbox' }] },
      { k: 'B3', s: [
        { l: 'am', n: 'Bước 3', t: 'Kiểm tra LR', en: 'AM check',
          li: ['AM Coordinator → AM Executive kiểm tra, có thể trả lại'] },
        { l: 'jvc', t: 'JVC duyệt', li: ['KTT → DGM → TGĐ JVC', 'Duyệt xong: tài sản → <b>8 / 24 chờ thanh lý</b>, vào <b>kho chờ thanh lý</b>'] }] }] },
    { t: '🏛️ GIAI ĐOẠN 2 – Hội đồng & đợt thanh lý', en: 'Council & batch', n: 'Bước 4 → 6', rows: [
      { k: 'B4–B5', s: [
        { l: 'jvc', n: 'Bước 4', t: 'QĐ thành lập HĐTL', en: 'Council decision',
          li: ['Nhập QĐ và thành viên ở tab <b>Hội đồng</b> (một QĐ hiệu lực)', 'Chủ tịch, phó CT, thành viên thường trực / không thường trực'],
          doc: ['01 – QĐ thành lập HĐTL'], go: 'liq' },
        { l: 'am', n: 'Bước 5', t: 'Tạo đợt & họp HĐTL', en: 'Batch & meeting',
          li: ['Đợt L0x.yyyy, chọn tài sản từ kho chờ thanh lý', 'Giữ lại tài sản không thanh lý (kèm lý do)', 'Ghi biên bản họp'],
          doc: ['02 – BB họp HĐTL'], go: 'liq' },
        { l: 'council', t: 'Xét duyệt', li: ['Xem từng dòng, thống nhất bán / huỷ', 'Xác nhận danh sách và tiến độ'] }] },
      { k: 'B6', s: [
        { l: 'jvc', n: 'Bước 6', t: 'QĐ thanh lý', en: 'Liquidation decision', li: ['TGĐ ký; đợt chuyển "đã quyết định"'], doc: ['03 – QĐ thanh lý'] }] }] },
    { t: '🔍 GIAI ĐOẠN 3 – Kiểm kê & đánh giá lại', en: 'Count & revaluation', n: 'Bước 7 → 8', rows: [
      { k: 'B7–B8', s: [
        { l: 'am', n: 'Bước 7', t: 'Kiểm kê trên máy tính bảng', en: 'Tablet count',
          li: ['Màn <b>Kiểm kê</b>: quét mã, tìm thấy / số lượng / ghi chú', 'Không tìm thấy → sẽ đóng là mất (0)'],
          doc: ['04 – BB kiểm kê (Mẫu 05-TSCĐ)'], go: 'lqcount' },
        { l: 'council', t: 'Xác nhận', li: ['Thành viên HĐ kiểm tra thực tế, ký biên bản'] },
        { l: 'fin', n: 'Bước 8', t: 'Đánh giá lại', en: 'Revaluation',
          li: ['Giá đánh giá lại từng dòng = <b>giá sàn</b>', 'Chênh lệch so với sổ sách'],
          doc: ['05 – BB đánh giá lại (Mẫu 04-TSCĐ)'] }] }] },
    { t: '💰 GIAI ĐOẠN 4 – Gọi báo giá & mở thầu', en: 'Quotations & opening', n: 'Bước 9 → 11', rows: [
      { k: 'B9', s: [
        { l: 'am', n: 'Bước 9', t: 'Gọi báo giá (≥ 3 bên)', en: 'Call for quotations',
          li: ['Hạn nộp, điều khoản; thêm bên mua → mỗi bên một link cổng thanh lý', 'Mời xem tài sản thực tế'],
          doc: ['07 – Thư báo giá'], go: 'liq' },
        { l: 'vendor', t: 'Bên mua nộp báo giá', li: ['Cá nhân (CCCD) / doanh nghiệp (MST + email nhận hoá đơn)', 'Giá từng hạng mục, chi phí thu gom, file đính kèm, cam kết'] }] },
      { k: 'B10–B11', s: [
        { l: 'am', n: 'Bước 10', t: 'Mở thầu', en: 'Opening',
          li: ['<b>&gt; 50% thành viên</b> HĐTL có mặt', 'Sau hạn hoặc khi mọi bên đã nộp; &lt; 3 báo giá phải ghi lý do'],
          doc: ['08 – BB mở thầu'] },
        { l: 'council', n: 'Bước 11', t: 'Trao thầu', en: 'Award',
          li: ['App gợi ý <b>giá cao nhất</b>; chọn khác phải ghi lý do', 'Dưới giá sàn: cảnh báo'] },
        { l: 'jvc', t: 'Duyệt kết quả', li: ['TGĐ / HĐTL ký kết quả'] }] }] },
    { t: '📦 GIAI ĐOẠN 5 – Bàn giao, hoá đơn & đối chiếu', en: 'Handover, invoice & reconciliation', n: 'Bước 12 → 16', rows: [
      { k: 'B12–B13', s: [
        { l: 'am', n: 'Bước 12', t: 'BB thanh lý', en: 'Liquidation minutes',
          li: ['Kết quả bán / huỷ từng dòng, số tiền bằng chữ'], doc: ['06 – BB thanh lý (Mẫu 02-TSCĐ)'] },
        { l: 'council', n: 'Bước 13', span: 2, t: 'Gate pass & giao nhận', en: 'Gate pass & handover',
          li: ['Gate pass: bên mua + bảo vệ + trưởng BP', 'Bên mua tháo dỡ, vận chuyển; lập biên bản giao nhận'],
          doc: ['10 – Gate pass', '11 – BB giao nhận'] }] },
      { k: 'B14–B16', s: [
        { l: 'fin', n: 'Bước 14', t: 'Xuất hoá đơn GTGT', en: 'VAT invoice',
          li: ['<b>Bắt buộc</b>; số / ngày hoá đơn ghi vào app', 'Khớp BB thanh lý và báo giá'], doc: ['09 – Hoá đơn GTGT'] },
        { l: 'am', n: 'Bước 15', t: 'Đóng đợt', en: 'Close batch',
          li: ['Chặn nếu thiếu hoá đơn / gate pass', 'Tài sản → 7 đã thanh lý · 23 CCDC · 9 huỷ · 0 mất'], go: 'liq' },
        { l: 'fin', n: 'Bước 16', t: 'Ghi giảm & đối chiếu', en: 'Write-off & reconcile',
          li: ['Bút toán ghi giảm, thu nhập thanh lý, chênh lệch đánh giá lại',
               '<b>Đối chiếu kế toán → Chênh lệch</b>: tài sản đã thanh lý mà sổ KT chưa ghi giảm → gửi danh sách đề nghị',
               'File tháng sau cho thấy đã ghi giảm → đối chiếu xong'],
          doc: ['Danh sách đề nghị ghi giảm'], go: 'acc' }] }] }],
  docs: [['LR', 'Đề xuất thanh lý + Asset Disposal Form + ảnh'], ['01', 'QĐ thành lập HĐTL'], ['02', 'BB họp HĐTL'], ['03', 'QĐ thanh lý'],
         ['04', 'BB kiểm kê (Mẫu 05-TSCĐ)'], ['05', 'BB đánh giá lại (Mẫu 04-TSCĐ)'], ['06', 'BB thanh lý (Mẫu 02-TSCĐ)'],
         ['07', 'Thư báo giá (≥ 3 bên)'], ['08', 'BB mở thầu'], ['09', 'Hoá đơn GTGT ⚠'], ['10', 'Gate pass'], ['11', 'BB giao nhận']],
  rules: ['Disposal Form phân loại đúng hiện trạng &amp; lý do; ≥ 1 ảnh mỗi dòng',
          'Tối thiểu <b>3 báo giá</b>; ít hơn phải ghi lý do',
          'Mở thầu cần <b>&gt; 50% thành viên HĐTL</b>',
          '<b>Bắt buộc xuất hoá đơn GTGT</b> — không đóng đợt khi thiếu',
          'Gate pass đủ 3 chữ ký: bên mua + bảo vệ + trưởng BP',
          'Giá trị chỉ đối chiếu xong khi sổ KT đã ghi giảm']
}];

// Procurement method by project type, risk and value (PROC_MATRIX in app.js).
const MATRIX_BANDS = ['≤ 200 tr', '≤ 500 tr', '≤ 1 tỷ', '≤ 5 tỷ', '&gt; 5 tỷ'];
const MATRIX_ABBR = { 'Direct Appointment': ['CĐ', 'Chỉ định', '#6b4a8a'], 'Direct Procurement': ['MT', 'Mua trực tiếp', '#2e6da4'],
                      'Competitive Quotation': ['CH', 'Chào hàng cạnh tranh', '#0f766e'], 'Public Tender': ['ĐT', 'Đấu thầu rộng rãi', '#9a6700'] };

const CSS = `
.wfl{--wfl-ink:#1a1a2e;font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:var(--wfl-ink);background:#f4f6f9;border-radius:10px;overflow:hidden;border:1px solid #dde3ec}
.wfl *{box-sizing:border-box}
.wfl-head{background:linear-gradient(135deg,#1a3a5c 0%,#2e6da4 100%);color:#fff;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.wfl-head .co{font-size:10.5px;opacity:.75;margin-bottom:4px}
.wfl-head h2{font-size:17px;font-weight:700;letter-spacing:.3px;margin:0;color:#fff}
.wfl-head .sub{font-size:11px;opacity:.8;margin-top:2px}
.wfl-head .meta{font-size:10px;opacity:.88;text-align:right;line-height:1.7}
.wfl-legend{display:flex;gap:14px;padding:9px 24px;background:#fff;border-bottom:1px solid #dde;flex-wrap:wrap;align-items:center}
.wfl-legend b{font-size:10px;color:#444}
.wfl-li{display:flex;align-items:center;gap:6px;font-size:10px;color:#444}
.wfl-lb{width:24px;height:13px;border-radius:3px;border:1px solid #aaa;flex:none}
.wfl-wrap{padding:16px 18px 24px;overflow-x:auto}
.wfl-grid{display:grid;align-items:start}
.wfl-col{font-weight:700;font-size:10.5px;text-align:center;padding:7px 6px;border-radius:6px 6px 0 0;color:#fff;line-height:1.3}
.wfl-col small{display:block;font-weight:400;opacity:.85;font-size:9.5px}
.wfl-lane{writing-mode:vertical-lr;transform:rotate(180deg);font-size:10px;font-weight:700;text-align:center;background:#e8edf4;border-right:2px solid #c5d0e0;padding:8px 4px;color:#2e6da4;letter-spacing:.5px;align-self:stretch;margin:4px 0}
.wfl-phase{grid-column:1/-1;background:linear-gradient(90deg,#1a3a5c,#2e6da4);color:#fff;font-weight:700;font-size:11px;padding:7px 14px;border-radius:4px;margin:12px 0 6px;letter-spacing:.3px}
.wfl-phase .en{font-weight:400;opacity:.8;margin-left:6px;font-style:italic}
.wfl-phase .num{font-size:10px;opacity:.8;margin-left:8px;font-weight:400}
.wfl-cell{display:flex;flex-direction:column}
.wfl-step{border-radius:8px;padding:8px 10px;margin:4px 5px;border:1.5px solid transparent;line-height:1.45;font-size:10.5px;text-align:left}
.wfl-step .no{font-size:9px;font-weight:700;color:#fff;background:rgba(0,0,0,.25);border-radius:10px;padding:1px 6px;display:inline-block;margin-bottom:4px}
.wfl-step .tt{font-weight:700;font-size:11px;margin-bottom:1px;display:block}
.wfl-step .te{display:block;font-size:9.5px;color:#555;font-style:italic;margin-bottom:2px}
.wfl-step ul{margin:4px 0 0 14px;padding:0}
.wfl-step li{margin-bottom:2px}
.wfl-doc{display:inline-block;font-size:9px;font-weight:600;background:rgba(0,0,0,.08);border-radius:3px;padding:1px 5px;margin:4px 3px 0 0}
.wfl-go{display:inline-block;font-size:9.5px;font-weight:600;color:#1d4ed8;background:#fff;border:1px solid #bcd0f5;border-radius:10px;padding:1px 8px;margin:5px 0 0;cursor:pointer}
.wfl-go:hover{background:#e8eefc}
.wfl-step.soon{border-style:dashed;opacity:.9}
.wfl-soon{display:inline-block;font-size:9px;font-weight:700;color:#b42318;background:#fff1f0;border:1px solid #f5c2bd;border-radius:3px;padding:0 5px;margin-left:4px}
.wfl-step.dec{border-style:dashed;background:#fffdf5!important;border-color:#c49a00!important}
.wfl-step.dec .tt::before{content:'◆ ';color:#c49a00}
.wfl-docs{background:#fff3cd;border:1.5px solid #e0a800;border-radius:8px;padding:11px 15px;margin:10px 5px 4px}
.wfl-docs h4{font-size:11px;color:#7a5a00;margin:0 0 8px;font-weight:700}
.wfl-dg{display:flex;flex-wrap:wrap;gap:6px}
.wfl-di{background:#fff;border:1px solid #e0c87a;border-radius:5px;padding:4px 10px;font-size:10px;display:flex;align-items:center;gap:5px}
.wfl-di b{color:#c8860a}
.wfl-note{background:#fff8f0;border-left:4px solid #e07c2e;padding:8px 12px;border-radius:0 6px 6px 0;font-size:10.5px;color:#5a3a10;margin:6px 5px}
.wfl-note strong{color:#c0510a}
.wfl-note ol{margin:4px 0 0 18px;padding:0}
.wfl-remind{background:#eef4ff;border-left:4px solid #2e6da4;padding:8px 12px;border-radius:0 6px 6px 0;font-size:10.5px;color:#1a3a5c;margin:6px 5px}
.wfl-mx{grid-column:1/-1;margin:2px 5px 6px;background:#fff;border:1px solid #dde3ec;border-radius:8px;padding:10px 12px;overflow-x:auto}
.wfl-mx h4{margin:0 0 6px;font-size:11px;color:#1a3a5c}
.wfl-mx table{width:auto;min-width:0;table-layout:auto;border-collapse:collapse;margin-bottom:6px;font-size:10px;margin-right:14px;display:inline-table;vertical-align:top}
.wfl-mx th,.wfl-mx td{border:1px solid #d5dce6;padding:3px 9px;text-transform:none;letter-spacing:0;font-size:10px;position:static;text-align:center;white-space:nowrap}
.wfl-mx th{background:#f1f4f8;font-weight:700}
.wfl-mx td.m{color:#fff;font-weight:700}
.wfl-mx .key{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
.wfl-mx .key span{display:inline-flex;align-items:center;gap:4px}
.wfl-mx .key i{display:inline-block;width:18px;height:12px;border-radius:2px}
.wfl-foot{text-align:center;padding:10px;font-size:9.5px;color:#888;border-top:1px solid #ddd;background:#fff}
@media print{
  .wfl{border:0;border-radius:0}
  .wfl-wrap{overflow:visible;padding:6px}
  .wfl-head,.wfl-col,.wfl-phase,.wfl-step,.wfl-lb,.wfl-mx td.m,.wfl-mx .key i{print-color-adjust:exact;-webkit-print-color-adjust:exact}
  .wfl-step{break-inside:avoid}
  .wfl-go{display:none}
}`;

const lane = (f, k) => f.lanes.findIndex(x => x[0] === k);
// A screen's menu name; the count screen has no menu entry, so its page title.
const goLabel = v => { try { if (v.startsWith('tbl:')) return tblLabel(v.slice(4));
                             const s = t('nav.' + v); return s === 'nav.' + v ? t('page.' + v) : s; } catch (e) { return v; } };

function stepHtml(s, withLinks) {
  const c = LANES[s.l] || LANES.multi;
  const bg = s.dec ? '' : `background:${c[1]};border-color:${c[2]}`;
  return `<div class="wfl-step${s.soon ? ' soon' : ''}${s.dec ? ' dec' : ''}" style="${bg}">`
    + (s.n ? `<span class="no" style="background:${c[0]}">${s.n}</span>${s.soon ? '<span class="wfl-soon">🔜 chưa có trên app</span>' : ''}` : '')
    + `<span class="tt">${s.t}</span>` + (s.en ? `<span class="te">${s.en}</span>` : '')
    + (s.li && s.li.length ? `<ul>${s.li.map(x => `<li>${x}</li>`).join('')}</ul>` : '')
    + (s.doc || []).map(d => `<span class="wfl-doc">📄 ${d}</span>`).join('')
    + (withLinks && s.go ? `<div><span class="wfl-go" data-go="${s.go}">↗ ${goLabel(s.go)}</span></div>` : '')
    + '</div>';
}

function matrixHtml() {
  const M = typeof PROC_MATRIX !== 'undefined' ? PROC_MATRIX : null;
  if (!M) return '';
  const tbl = (name, m) => `<table><tr><th>${name}</th>${MATRIX_BANDS.map(b => `<th>${b}</th>`).join('')}</tr>`
    + Object.entries(m).map(([risk, row]) => `<tr><th>${risk}</th>${row.map(p => { const a = MATRIX_ABBR[p] || [p, p, '#555'];
        return `<td class="m" style="background:${a[2]}" title="${a[1]}">${a[0]}</td>`; }).join('')}</tr>`).join('') + '</table>';
  return `<div class="wfl-mx"><h4>Ma trận phương thức mua sắm — rủi ro × giá trị (VND)</h4>`
    + tbl('Non-consultancy', M['Non-consultancy']) + tbl('Consultancy', M.Consultancy)
    + `<div class="key">${Object.entries(MATRIX_ABBR).map(([en, a]) => `<span><i style="background:${a[2]}"></i><b>${a[0]}</b> ${a[1]} <em>(${en})</em></span>`).join('')}</div></div>`;
}

// One workflow as a self-contained block (also what is printed / saved).
function flowHtml(f, withLinks) {
  const n = f.lanes.length;
  let h = `<div class="wfl" id="wfl-${f.id}">`
    + `<div class="wfl-head"><div><div class="co">CÔNG TY TNHH LIÊN DOANH KHÁCH SẠN PLAZA</div><h2>${f.icon} WORKFLOW – ${f.title}</h2>`
    + `<div class="sub">${f.en} · ${f.scope}</div></div>`
    + `<div class="meta">Mã tài liệu / Doc No.: ${f.code}<br>Bộ phận / Dept.: Asset Management<br>Căn cứ: ${f.basis}<br>Phiên bản / Version: 1.0 – ${new Date().getFullYear()}</div></div>`
    + `<div class="wfl-legend"><b>Người thực hiện:</b>`
    + f.lanes.map(([k, vi]) => { const c = LANES[k]; return `<span class="wfl-li"><span class="wfl-lb" style="background:${c[1]};border-color:${c[2]}"></span>${vi}</span>`; }).join('')
    + `<span class="wfl-li"><span class="wfl-lb" style="background:#fffdf5;border:1.5px dashed #c49a00"></span>Điểm quyết định</span>`
    + `<span class="wfl-li"><span class="wfl-lb" style="background:#fff;border:1.5px dashed #999"></span>🔜 Chưa có trên app</span>`
    + `<span class="wfl-li"><span class="wfl-lb" style="background:#fff3cd;border:2px solid #e0a800"></span>Hồ sơ bắt buộc</span></div>`
    + `<div class="wfl-wrap"><div class="wfl-grid" style="grid-template-columns:30px repeat(${n},minmax(150px,1fr));min-width:${30 + n * 170}px">`
    + '<div></div>' + f.lanes.map(([k, vi, en]) => `<div class="wfl-col" style="background:${LANES[k][0]}">${vi}<small>${en}</small></div>`).join('');
  let r = 2;
  for (const p of f.phases) {
    h += `<div class="wfl-phase" style="grid-row:${r++}">${p.t}<span class="en">${p.en}</span><span class="num">${p.n}</span></div>`;
    for (const row of p.rows) {
      // Read left to right, top to bottom: a step whose lane lies left of the
      // previous one starts a new line; steps of the same lane stack in one cell.
      const lines = [];
      let cur = null, last = -1;
      for (const s of row.s) {
        const i = lane(f, s.l), span = s.span || 1;
        if (!cur || i < last) { cur = []; lines.push(cur); }
        const c = cur[cur.length - 1];
        if (c && c.i === i && c.span === span) c.list.push(s); else cur.push({ i, span, list: [s] });
        last = i + span - 1;
      }
      h += `<div class="wfl-lane" style="grid-row:${r} / span ${lines.length};grid-column:1">${row.k}</div>`;
      for (const line of lines) {
        for (const c of line)
          h += `<div class="wfl-cell" style="grid-row:${r};grid-column:${c.i + 2} / span ${c.span}">${c.list.map(s => stepHtml(s, withLinks)).join('')}</div>`;
        r++;
      }
    }
    if (p.matrix) h += matrixHtml().replace('class="wfl-mx"', `class="wfl-mx" style="grid-row:${r++}"`);
  }
  h += `<div style="grid-column:1/-1;grid-row:${r++}"><div class="wfl-docs"><h4>📁 BỘ HỒ SƠ – ${f.docs.length} TÀI LIỆU</h4><div class="wfl-dg">`
    + f.docs.map(([k, v]) => `<div class="wfl-di"><b>${k}</b>${v}</div>`).join('') + '</div></div>'
    + `<div class="wfl-note"><strong>⚠ Các điểm kiểm soát quan trọng:</strong><ol>${f.rules.map(x => `<li>${x}</li>`).join('')}</ol></div>`
    + (f.remind ? `<div class="wfl-remind">🔔 <b>Nhắc:</b> ${f.remind}</div>` : '')
    + '</div></div></div>'
    + `<div class="wfl-foot">Công ty TNHH Liên Doanh Khách Sạn Plaza &nbsp;|&nbsp; ${f.code} – ${f.title} &nbsp;|&nbsp; PHCL app</div></div>`;
  return h;
}

function standalone(f) {
  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Workflow ${f.code} – ${f.short}</title>`
    + `<style>body{margin:0;padding:12px;background:#fff}@page{size:A3 landscape;margin:8mm}${CSS}</style></head><body>${flowHtml(f, false)}</body></html>`;
}

const ST = { id: '1' };
try { const v = localStorage.getItem('phcl.flow'); if (FLOWS.some(f => f.id === v)) ST.id = v; } catch (e) {}

function render() {
  const root = document.getElementById('flBody');
  if (!root) return;
  if (!document.getElementById('wflCss')) { const s = document.createElement('style'); s.id = 'wflCss'; s.textContent = CSS; document.head.append(s); }
  const f = FLOWS.find(x => x.id === ST.id) || FLOWS[0];
  // How the four connect: 1 buys (1b chooses the vendor), 2 keeps the asset, 3 ends it and reconciles back into 2.
  const map = FLOWS.map(x => `<button type="button" class="flcard${x.id === f.id ? ' on' : ''}" data-flow="${x.id}">`
    + `<span class="ic">${x.icon}</span><span><b>${x.code}</b> ${x.short}<small>${x.shortEn}</small></span></button>`).join('<span class="flarr">→</span>');
  root.innerHTML = `<div class="card flmap">${map}</div>`
    + `<div class="fltools"><span class="tdnote">${f.scope}. Bấm ↗ trên một bước để mở màn hình tương ứng.</span>`
    + `<span class="sp"></span><button type="button" class="btn" data-act="print">🖨 In / PDF</button>`
    + `<button type="button" class="btn" data-act="save">⬇ Tải HTML</button></div>`
    + flowHtml(f, true);
  root.onclick = e => {
    const c = e.target.closest('[data-flow]');
    if (c) { ST.id = c.dataset.flow; try { localStorage.setItem('phcl.flow', ST.id); } catch (er) {} render(); return; }
    const g = e.target.closest('[data-go]');
    if (g) { const v = g.dataset.go; if (typeof canView === 'function' && !canView(v)) { alert('Bạn chưa có quyền mở màn hình này.'); return; } showView(v); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'print') {
      const w = window.open('', '_blank');
      if (!w) return alert('Trình duyệt chặn cửa sổ in — cho phép pop-up rồi thử lại.');
      w.document.write(standalone(f)); w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
    } else {
      const b = new Blob([standalone(f)], { type: 'text/html' });
      const u = URL.createObjectURL(b), l = document.createElement('a');
      l.href = u; l.download = `Workflow_${f.code}_${f.short.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9]+/g, '_')}.html`;
      document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
    }
  };
}

window.flowsRender = render;
window.FLOWS = FLOWS;
})();
