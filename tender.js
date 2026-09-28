/* =====================================================================
   Tender portal — the page a vendor opens from the private link the hotel
   sends (Tender.html#c=<config>&t=<token>). No account: the token in the link
   is the key, checked by the database on every call (vp_* functions,
   sql/25_pm_tender.sql + sql/41_tendering.sql). The vendor sees only their own
   bids, their own questions and the answers shared with every bidder.

   A bid is saved as a draft and can be changed; once submitted it is locked
   and sealed — to change it, the vendor creates a replacement version. Files
   go to the private Storage bucket "pm-tender", into the draft's own folder;
   the vendor can upload but never read or list them back. The hotel's tender
   documents are downloaded from the call's own folder.

   On the page (user 28/09/2026): what makes a bid valid (deadline, signed and
   stamped quotation letter, the original sent to the address), a data-entry
   guide, quantity and unit per item and per overhead line, the payment
   schedule by instalment, the quotation letter printed from what was typed
   (to sign, stamp and upload), clarification questions, a site-visit request,
   and the purchase orders the hotel sends.

   Everything the vendor or the hotel typed is shown with textContent only —
   never as HTML (the printed letter escapes every value).
   ===================================================================== */
'use strict';

const $ = s => document.querySelector(s);
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e[k] = v;
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null && c !== '') e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

/* ------------------------------------------------------------ language */
const TX = {
  vi: {
    title: 'Cổng chào giá', who: 'Nhà thầu: {v} · link hết hạn {d}', loading: 'Đang tải…', bad: 'Đường link không hợp lệ hoặc đã hết hạn. Liên hệ bộ phận Thu mua của khách sạn.',
    noCfg: 'Đường link thiếu thông tin kết nối. Hãy mở đúng đường link được gửi cho bạn.',
    tenders: 'Các gói chào giá', deadline: 'Hạn nộp', project: 'Dự án', round: 'Vòng', status: 'Trạng thái',
    accepting: 'Đang nhận hồ sơ', closed: 'Đã đóng', scope: 'Phạm vi công việc / Hồ sơ mời thầu', terms: 'Chỉ dẫn chào giá',
    myBid: 'Hồ sơ của bạn', none: 'Chưa có', draft: 'Nháp', submitted: 'Đã nộp', superseded: 'Đã được thay thế',
    items: 'Hạng mục chào giá', no: 'STT', item: 'Hạng mục', qtyReq: 'SL yêu cầu', qty: 'SL chào', unit: 'ĐVT', price: 'Đơn giá (VND)', amount: 'Thành tiền', spec: 'Thông số',
    specBtn: 'Thông số', otherSpec: 'Khác / ghi tự do', reqSpec: 'Yêu cầu: {s}', qtyDiff: 'khác yêu cầu',
    overheads: 'Chi phí khác (vận chuyển, lắp đặt, vật tư phụ…)', ohLabel: 'Nội dung', addOh: '+ Thêm dòng',
    subtotal: 'Cộng hạng mục', total: 'Tổng giá chào (trước thuế)', commercial: 'Điều khoản thương mại',
    paySched: 'Lịch thanh toán theo đợt', payNo: 'Đợt', payPct: '%', payWhen: 'Thời điểm', payDays: 'Trong vòng (ngày)', payNote: 'Ghi chú',
    payAdd: '+ Thêm đợt', paySum: 'Cộng: {p}%', paySumBad: 'Cộng: {p}% — phải đủ 100%', payTerm: 'Ghi chú thanh toán (nếu có)',
    when_deposit: 'Đặt cọc / tạm ứng khi đặt hàng', when_delivery: 'Sau khi giao hàng', when_acceptance: 'Sau nghiệm thu', when_handover: 'Sau bàn giao',
    when_warranty: 'Khi hết bảo hành', when_other: 'Khác (ghi chú)',
    delivery: 'Thời gian giao hàng', warranty: 'Bảo hành', validity: 'Hiệu lực báo giá', note: 'Ghi chú',
    capability: 'Kê khai năng lực & kỹ thuật', capHint: 'Kê khai theo từng tiêu chí (số liệu, tài liệu chứng minh).',
    files: 'Tài liệu đính kèm', quotation: 'Thư báo giá đã ký, đóng dấu (PDF)', otherFile: 'Tài liệu khác', upload: 'Tải lên', noFiles: 'Chưa có tệp nào.',
    save: 'Lưu nháp', submit: 'Nộp hồ sơ', xlsDown: 'Tải mẫu Excel', xlsUp: 'Nạp từ Excel', replace: 'Tạo bản thay thế', letter: 'In thư báo giá',
    saved: 'Đã lưu nháp.', submittedOk: 'Đã nộp hồ sơ. Hồ sơ được niêm phong cho tới khi khách sạn mở cùng lúc.',
    confirmSubmit: 'Nộp hồ sơ? Sau khi nộp sẽ KHÔNG rút lại hay sửa được — muốn thay đổi phải tạo bản thay thế.',
    askReason: 'Lý do tạo bản thay thế (vd: làm rõ theo yêu cầu, cập nhật giá):', replaced: 'Đã tạo bản nháp thay thế — sửa rồi nộp lại.',
    uploaded: 'Đã tải lên {n}.', xlsRead: 'Đã nạp dữ liệu từ Excel — kiểm tra rồi lưu nháp.', readonly: 'Hồ sơ đã nộp — chỉ xem. Muốn thay đổi: tạo bản thay thế.',
    notAccepting: 'Gói này không còn nhận hồ sơ.', history: 'Các bản đã nộp', sealed: 'niêm phong', pick: 'Chọn một gói để chào giá.',
    tooBig: 'Tệp {n} lớn hơn 20 MB.', badType: 'Chỉ nhận PDF, ảnh, Excel, Word, ZIP.',
    rulesH: 'Hồ sơ được xem là HỢP LỆ khi',
    rule1: 'Nộp trên cổng này trước {d}. Lưu nháp chưa phải là nộp — phải bấm "Nộp hồ sơ".',
    rule2: 'Có thư báo giá ký tên người đại diện và đóng dấu công ty, tải lên ở mục "Tài liệu đính kèm". Bấm "In thư báo giá" để in mẫu từ số liệu bạn đã nhập.',
    rule3: 'Gửi bản gốc thư báo giá có đóng dấu tới: {a} trước {d}.',
    rule4: 'Đơn giá bằng VND, chưa gồm VAT; lịch thanh toán cộng đủ 100%.',
    hotelH: 'Bên mời chào giá', contact: 'Liên hệ',
    guideBtn: 'Hướng dẫn nhập liệu', guideH: 'Hướng dẫn nhập liệu',
    guide: ['Đọc phạm vi công việc, chỉ dẫn và tải hồ sơ mời thầu (bản vẽ, thông số…) ở mục "Hồ sơ mời thầu".',
            'Có điểm chưa rõ: gửi câu hỏi ở mục "Hỏi đáp làm rõ". Cần xem hiện trường: bấm "Yêu cầu khảo sát hiện trường".',
            'Nhập đơn giá từng hạng mục. Số lượng và đơn vị tính đã điền theo yêu cầu; chỉ sửa khi bạn chào khác (khách sạn sẽ thấy phần khác).',
            'Bấm "Thông số" ở mỗi dòng để ghi hãng, model, xuất xứ, kích thước…',
            'Chi phí khác (vận chuyển, lắp đặt…): mỗi khoản một dòng, có số lượng, đơn vị tính và đơn giá.',
            'Lịch thanh toán: mỗi đợt một dòng — % và thời điểm (đặt cọc, sau giao hàng, sau nghiệm thu…), cộng đủ 100%.',
            'Điền giao hàng, bảo hành, hiệu lực báo giá và kê khai năng lực. Bấm "Lưu nháp" thường xuyên.',
            'Bấm "In thư báo giá", ký, đóng dấu, scan PDF và tải lên. Rồi bấm "Nộp hồ sơ".',
            'Có thể làm trên Excel: "Tải mẫu Excel", điền, rồi "Nạp từ Excel".'],
    docsH: 'Hồ sơ mời thầu (tải về)', noDocs: 'Khách sạn chưa đính kèm tài liệu.',
    qaH: 'Hỏi đáp làm rõ', qaHint: 'Câu hỏi gửi tới bộ phận Thu mua. Câu trả lời hiện ở đây (và được gửi email); câu trả lời chung được gửi cho mọi nhà thầu, không nêu tên người hỏi.',
    qaMine: 'Câu hỏi của bạn', qaShared: 'Làm rõ chung', qaAnswer: 'Trả lời', qaWait: 'Đang chờ trả lời', qaAsk: 'Gửi câu hỏi', qaPh: 'Nội dung cần làm rõ…', qaSent: 'Đã gửi câu hỏi.', qaNone: 'Chưa có câu hỏi nào.',
    svBtn: 'Yêu cầu khảo sát hiện trường', svH: 'Khảo sát hiện trường', svHint: 'Đề xuất 1–3 thời điểm, danh sách người đến (họ tên, số CCCD, số điện thoại — để đăng ký ra vào) và email liên hệ. Thu mua sẽ liên hệ lại khi xếp được lịch.',
    svWhen: 'Thời điểm đề xuất', svPeople: 'Người đến khảo sát', svName: 'Họ tên', svId: 'Số CCCD', svPhone: 'Số điện thoại', svAddP: '+ Thêm người',
    svContactName: 'Người liên hệ', svContactPhone: 'SĐT liên hệ', svContactEmail: 'Email liên hệ', svNote: 'Ghi chú', svSend: 'Gửi yêu cầu', svSent: 'Đã gửi yêu cầu khảo sát.',
    svSt_requested: 'Chờ xếp lịch', svSt_scheduled: 'Đã xếp lịch', svSt_done: 'Đã khảo sát', svSt_cancelled: 'Không thực hiện', svAt: 'Lịch: {d}',
    ordersH: 'Đơn đặt hàng (PO) khách sạn gửi bạn', poAck: 'Xác nhận đã nhận PO', poAcked: 'Đã xác nhận {d}', poPrint: 'In PO', poAckOk: 'Đã xác nhận nhận PO.',
    poSent: 'Gửi ngày {d}', poTerms: 'Điều khoản', poQty: 'SL', poTotal: 'Tổng giá trị đơn hàng (trước thuế)', poPay: 'Điều khoản thanh toán',
    letterTitle: 'THƯ BÁO GIÁ', letterTo: 'Kính gửi', letterFrom: 'Đơn vị báo giá', letterRe: 'V/v: báo giá', letterDate: 'Ngày',
    letterIntro: 'Chúng tôi xin gửi báo giá cho các hạng mục dưới đây theo hồ sơ mời chào giá của Quý công ty:',
    letterVat: 'Giá trên chưa bao gồm thuế GTGT.', letterSign: 'ĐẠI DIỆN NHÀ THẦU', letterSignSub: '(Ký, ghi rõ họ tên, đóng dấu)',
    letterNoPop: 'Trình duyệt chặn cửa sổ in — cho phép cửa sổ bật lên rồi bấm lại.'
  },
  en: {
    title: 'Tender portal', who: 'Vendor: {v} · link expires {d}', loading: 'Loading…', bad: 'This link is not valid or has expired. Please contact the hotel\'s Purchasing team.',
    noCfg: 'This link lacks its connection details. Open the exact link that was sent to you.',
    tenders: 'Tenders', deadline: 'Deadline', project: 'Project', round: 'Round', status: 'Status',
    accepting: 'Accepting bids', closed: 'Closed', scope: 'Scope of work / Tender document', terms: 'Instructions',
    myBid: 'Your bid', none: 'None yet', draft: 'Draft', submitted: 'Submitted', superseded: 'Replaced',
    items: 'Items to quote', no: 'No.', item: 'Item', qtyReq: 'Qty required', qty: 'Qty quoted', unit: 'Unit', price: 'Unit price (VND)', amount: 'Amount', spec: 'Spec',
    specBtn: 'Spec', otherSpec: 'Other / free text', reqSpec: 'Required: {s}', qtyDiff: 'differs from required',
    overheads: 'Other costs (transport, installation, consumables…)', ohLabel: 'Description', addOh: '+ Add line',
    subtotal: 'Items subtotal', total: 'Total quoted (pre-tax)', commercial: 'Commercial terms',
    paySched: 'Payment schedule by instalment', payNo: 'No.', payPct: '%', payWhen: 'When', payDays: 'Within (days)', payNote: 'Note',
    payAdd: '+ Add instalment', paySum: 'Total: {p}%', paySumBad: 'Total: {p}% — must be 100%', payTerm: 'Payment remarks (if any)',
    when_deposit: 'Deposit / advance on order', when_delivery: 'After delivery', when_acceptance: 'After acceptance', when_handover: 'After handover',
    when_warranty: 'At the end of warranty', when_other: 'Other (see note)',
    delivery: 'Delivery time', warranty: 'Warranty', validity: 'Quotation validity', note: 'Note',
    capability: 'Capability & technical declaration', capHint: 'Declare against each criterion (figures, supporting documents).',
    files: 'Attachments', quotation: 'Signed and stamped quotation letter (PDF)', otherFile: 'Other document', upload: 'Upload', noFiles: 'No files yet.',
    save: 'Save draft', submit: 'Submit bid', xlsDown: 'Download Excel template', xlsUp: 'Load from Excel', replace: 'Create a replacement', letter: 'Print quotation letter',
    saved: 'Draft saved.', submittedOk: 'Bid submitted. It stays sealed until the hotel opens all bids together.',
    confirmSubmit: 'Submit the bid? It can NOT be withdrawn or changed afterwards — to change it you create a replacement.',
    askReason: 'Reason for the replacement (e.g. clarification requested, price update):', replaced: 'Replacement draft created — edit it and submit again.',
    uploaded: '{n} uploaded.', xlsRead: 'Data loaded from Excel — check it, then save the draft.', readonly: 'Submitted bid — read only. To change it, create a replacement.',
    notAccepting: 'This tender no longer accepts bids.', history: 'Submitted versions', sealed: 'sealed', pick: 'Choose a tender to quote.',
    tooBig: 'File {n} is larger than 20 MB.', badType: 'Only PDF, images, Excel, Word, ZIP are accepted.',
    rulesH: 'A bid is VALID when',
    rule1: 'It is submitted on this portal before {d}. A saved draft is not a submission — press "Submit bid".',
    rule2: 'It carries a quotation letter signed by your representative and stamped with your company seal, uploaded under "Attachments". "Print quotation letter" prints one from what you typed.',
    rule3: 'The stamped original of the quotation letter reaches: {a} before {d}.',
    rule4: 'Prices are in VND, before VAT; the payment instalments add up to 100%.',
    hotelH: 'Requested by', contact: 'Contact',
    guideBtn: 'How to fill in', guideH: 'How to fill in the bid',
    guide: ['Read the scope and instructions, and download the tender documents (drawings, specs…) under "Tender documents".',
            'Anything unclear: send a question under "Clarifications". To see the site: press "Request a site visit".',
            'Type the unit price of each item. Quantity and unit are filled in as required; change them only if you quote otherwise (the hotel sees the difference).',
            'Press "Spec" on each line for brand, model, origin, dimensions…',
            'Other costs (transport, installation…): one line each, with quantity, unit and unit price.',
            'Payment schedule: one line per instalment — % and when (deposit, after delivery, after acceptance…), adding up to 100%.',
            'Fill in delivery, warranty, validity and the capability declaration. Press "Save draft" often.',
            'Press "Print quotation letter", sign, stamp, scan to PDF and upload it. Then press "Submit bid".',
            'You may work in Excel: "Download Excel template", fill it in, then "Load from Excel".'],
    docsH: 'Tender documents (download)', noDocs: 'The hotel has not attached any document.',
    qaH: 'Clarifications', qaHint: 'Questions go to the Purchasing team. Answers show here (and are e-mailed); an answer shared with all bidders does not name who asked.',
    qaMine: 'Your question', qaShared: 'Clarification to all bidders', qaAnswer: 'Answer', qaWait: 'Waiting for an answer', qaAsk: 'Send question', qaPh: 'What needs clarifying…', qaSent: 'Question sent.', qaNone: 'No question yet.',
    svBtn: 'Request a site visit', svH: 'Site visit', svHint: 'Propose 1–3 times, list the visitors (full name, ID card number, phone — for the security desk) and a contact e-mail. Purchasing will get back to you with the schedule.',
    svWhen: 'Proposed times', svPeople: 'Visitors', svName: 'Full name', svId: 'ID card no.', svPhone: 'Phone', svAddP: '+ Add visitor',
    svContactName: 'Contact person', svContactPhone: 'Contact phone', svContactEmail: 'Contact e-mail', svNote: 'Note', svSend: 'Send request', svSent: 'Site-visit request sent.',
    svSt_requested: 'Waiting to be scheduled', svSt_scheduled: 'Scheduled', svSt_done: 'Visited', svSt_cancelled: 'Not held', svAt: 'Time: {d}',
    ordersH: 'Purchase orders from the hotel', poAck: 'Confirm receipt of the PO', poAcked: 'Confirmed {d}', poPrint: 'Print PO', poAckOk: 'Receipt of the PO confirmed.',
    poSent: 'Sent {d}', poTerms: 'Terms', poQty: 'Qty', poTotal: 'Order total (pre-tax)', poPay: 'Payment term',
    letterTitle: 'QUOTATION', letterTo: 'To', letterFrom: 'From', letterRe: 'Re: quotation for', letterDate: 'Date',
    letterIntro: 'We are pleased to quote for the items below, as requested in your call for quotations:',
    letterVat: 'Prices exclude VAT.', letterSign: 'FOR THE VENDOR', letterSignSub: '(Signature, full name, company seal)',
    letterNoPop: 'The browser blocked the print window — allow pop-ups and press again.'
  }
};
let LANG = (() => { try { return localStorage.getItem('tender.lang') || 'vi'; } catch { return 'vi'; } })();
const t = (k, p = {}) => String((TX[LANG] || TX.vi)[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? '');
const WHEN = ['deposit', 'delivery', 'acceptance', 'handover', 'warranty', 'other'];

/* ------------------------------------------------------------ connection */
// The link carries the project address (same encoding as the app's #sbcfg) and the token.
const P = { url: '', key: '', token: '', s: null, cur: null, form: null, specOpen: -1, guide: false, sv: false };
function readLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  let c = h.get('c'), tok = h.get('t');
  try { if (!c) c = sessionStorage.getItem('tender.c'); if (!tok) tok = sessionStorage.getItem('tender.t'); } catch {}
  if (c) {
    try { const o = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(c))))); P.url = String(o.url || '').replace(/\/+$/, ''); P.key = String(o.key || ''); } catch {}
  }
  P.token = tok || '';
  // Kept for this tab only, and taken off the address bar (screen shares, history).
  try { if (c) sessionStorage.setItem('tender.c', c); if (tok) sessionStorage.setItem('tender.t', tok); } catch {}
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
async function rpc(fn, args) {
  const r = await fetch(`${P.url}/rest/v1/rpc/${fn}`, { method: 'POST',
    headers: { apikey: P.key, Authorization: 'Bearer ' + P.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ p_token: P.token }, args || {})) });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) throw new Error((j && (j.message || j.hint)) || txt || r.statusText);
  return j;
}
const OK_TYPES = /^(application\/pdf|image\/(png|jpeg)|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|application\/vnd\.ms-excel|application\/msword|application\/(x-)?zip(-compressed)?)$/;
const safeName = n => n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
async function uploadFile(file, key) {
  const path = `${key}/${Date.now()}-${safeName(file.name)}`;
  const r = await fetch(`${P.url}/storage/v1/object/pm-tender/${path}`, { method: 'POST',
    headers: { apikey: P.key, Authorization: 'Bearer ' + P.key, 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, body: file });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
  return path;
}
// The hotel's tender documents: readable through this link only (random folder of the call).
async function download(f) {
  try {
    const r = await fetch(`${P.url}/storage/v1/object/authenticated/pm-tender/${f.path.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { apikey: P.key, Authorization: 'Bearer ' + P.key } });
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    const url = URL.createObjectURL(await r.blob());
    const a = el('a', { href: url, download: f.name || 'file' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { msg('err', e.message); }
}

/* ------------------------------------------------------------ helpers */
const msg = (kind, text) => { const b = $('#msg'); b.innerHTML = ''; if (text) b.append(el('div', { className: 'msg ' + kind, textContent: text })); if (text) window.scrollTo({ top: 0, behavior: 'smooth' }); };
/* Amounts typed either way: 22.500.000 (Vietnamese, as shown), 22,500,000, 22500000 or
   1.5 / 1,5. Both marks present: the last one is the decimal point. One kind only:
   groups of three digits are thousands, anything else a decimal. */
const num = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const hasC = s.includes(','), hasD = s.includes('.');
  if (hasC && hasD) { const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.'); }
  else if (hasC || hasD) { const m = hasC ? ',' : '.';
    s = /^-?\d{1,3}([.,]\d{3})+$/.test(s) ? s.split(m).join('') : s.replace(m, '.'); }
  const n = Number(s);
  return isFinite(n) ? n : null;
};
const n0 = v => Number(v) || 0;
const money = v => v == null || v === '' || !isFinite(v) ? '' : Math.round(Number(v)).toLocaleString('vi-VN');
const qfmt = v => v == null || v === '' ? '' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 3 });
// dd/mm/yyyy HH:mm in both languages, like the hotel's app.
const dt = s => { if (!s) return ''; const d = new Date(s), z = n => String(n).padStart(2, '0');
  return isNaN(d) ? String(s) : `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const dLocal = d => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SPEC = [['brand', 'Brand'], ['model', 'Model'], ['origin', 'Origin'], ['capacity', 'Capacity'], ['function', 'Function'],
  ['length', 'Length'], ['width', 'Width'], ['height', 'Height/Depth'], ['weight', 'Weight'], ['material', 'Material'], ['color', 'Color'],
  ['manufacturer', 'Manufacturer'], ['mfg_year', 'Year'], ['accessory', 'Accessory'], ['radius', 'Radius'], ['fuel', 'Fuel'],
  ['serial', 'Serial'], ['shape', 'Shape'], ['area', 'Area'], ['perimeter', 'Perimeter']];
const blank = () => ({ prices: {}, qtys: {}, units: {}, specx: {}, specs: {}, olines: [], pay_sched: [], pay_term: '', delivery: '', warranty: '', validity: '', note: '', crit: {} });
const curBid = tn => (tn.bids || []).filter(b => b.round === tn.round).sort((a, b) => b.version - a.version)[0] || null;
// Quantity quoted (the required one until changed), overhead amount (qty × unit price; old bids: the amount typed).
const qtyOf = (tn, d, i) => d.qtys[i] != null && d.qtys[i] !== '' ? n0(d.qtys[i]) : n0((tn.items[i] || {}).qty);
const ohAmt = o => o.price != null && o.price !== '' ? n0(o.qty ?? 1) * n0(o.price) : n0(o.amount);
const unitName = code => { const u = ((P.s && P.s.units) || []).find(x => x.code === code); return u ? (LANG === 'en' ? u.en || u.vi || u.code : u.vi || u.code) : (code || ''); };
function totals(tn, d) {
  const sub = (tn.items || []).reduce((s, it, i) => s + qtyOf(tn, d, i) * n0(d.prices[i]), 0);
  const oh = d.olines.reduce((s, o) => s + ohAmt(o), 0);
  return { sub, oh, total: sub + oh };
}
const payText = (d, lang) => {
  const L = TX[lang || LANG];
  return (d.pay_sched || []).filter(x => n0(x.pct) > 0).map((x, i) => `${i + 1}. ${x.pct}% — ${L['when_' + x.when] || ''}${x.days ? ` (${lang === 'en' || LANG === 'en' ? 'within' : 'trong vòng'} ${x.days} ${lang === 'en' || LANG === 'en' ? 'days' : 'ngày'})` : ''}${x.note ? ' — ' + x.note : ''}`).join('\n');
};

/* ------------------------------------------------------------ screens */
async function load(keepId) {
  msg('info', t('loading'));
  try {
    P.s = await rpc('vp_session');
    msg('', '');
    $('#hWho').textContent = t('who', { v: P.s.vendor, d: dt(P.s.expires_at) });
    const list = P.s.tenders || [];
    P.cur = list.find(x => x.id === keepId) || (list.length === 1 && !(P.s.orders || []).length ? list[0] : null);
    render();
  } catch (e) { $('#app').innerHTML = ''; msg('err', /28000|not valid|không hợp lệ/i.test(e.message) ? t('bad') : e.message); }
}

function render() {
  document.documentElement.lang = LANG;
  $('#hTitle').textContent = t('title') + ' / ' + (LANG === 'vi' ? 'Tender portal' : 'Cổng chào giá');
  const app = $('#app');
  const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fid : null;
  app.innerHTML = '';
  if (focus) setTimeout(() => { const f = [...app.querySelectorAll('[data-fid]')].find(x => x.dataset.fid === focus); if (f) f.focus(); }, 0);
  const list = (P.s && P.s.tenders) || [];
  if ((P.s.orders || []).length) app.append(ordersCard());
  if (list.length > 1 || !P.cur) {
    const box = el('div', { className: 'card' }, [el('h2', { textContent: t('tenders') })]);
    const grid = el('div', { className: 'tlist' });
    for (const tn of list) {
      const b = curBid(tn);
      grid.append(el('div', { className: 'tcard' + (P.cur && P.cur.id === tn.id ? ' on' : ''), onclick: () => { P.cur = tn; P.form = null; P.sv = false; render(); } }, [
        el('b', { textContent: tn.title || tn.project_name || tn.project_code }),
        el('small', { textContent: `${tn.project_code} · ${t('deadline')}: ${dt(tn.deadline)}` }), el('br'),
        el('span', { className: 'chip ' + (tn.accepting ? 'ok' : 'bad'), textContent: tn.accepting ? t('accepting') : t('closed') }), ' ',
        el('span', { className: 'chip', textContent: `${t('myBid')}: ${b ? t(b.status) + ' v' + b.version : t('none')}` })]));
    }
    if (list.length) { box.append(grid); app.append(box); }
    if (!P.cur) { if (list.length) app.append(el('div', { className: 'msg info', textContent: t('pick') })); return; }
  }
  renderTender(app, P.cur);
}

function renderTender(app, tn) {
  const b = curBid(tn);
  const editable = tn.accepting && (!b || b.status === 'draft');
  if (!P.form || P.form.tid !== tn.id) {
    const d = Object.assign(blank(), JSON.parse(JSON.stringify((b && b.data) || {})));
    // Old bids: overhead lines had an amount only.
    d.olines = (d.olines || []).map(o => o.price == null && o.amount != null ? Object.assign({ qty: 1, price: o.amount }, o) : o);
    (tn.items || []).forEach((it, i) => { if (d.units[i] == null && it.unit) d.units[i] = it.unit; });
    P.form = { tid: tn.id, d };
  }
  const d = P.form.d, h = P.s.hotel || {};
  const addr = tn.address || [h.dept, h.company, h.address].filter(Boolean).join(' — ');
  // Header, and what makes the bid valid.
  app.append(el('div', { className: 'card' }, [
    el('h2', { textContent: tn.title || tn.project_name || tn.project_code }),
    el('dl', { className: 'kv' }, [
      el('dt', { textContent: t('project') }), el('dd', { textContent: `${tn.project_code} — ${tn.project_name || ''}` }),
      el('dt', { textContent: t('deadline') }), el('dd', {}, [el('b', { textContent: dt(tn.deadline) })]),
      el('dt', { textContent: t('status') }), el('dd', {}, [el('span', { className: 'chip ' + (tn.accepting ? 'ok' : 'bad'), textContent: tn.accepting ? t('accepting') : t('closed') }),
        tn.round > 1 ? ` · ${t('round')} ${tn.round}` : '']),
      el('dt', { textContent: t('myBid') }), el('dd', { textContent: b ? `${t(b.status)} · v${b.version}${b.submitted_at ? ' · ' + dt(b.submitted_at) : ''}` : t('none') }),
      el('dt', { textContent: t('hotelH') }), el('dd', { textContent: [h.company, h.dept, h.address].filter(Boolean).join(' · ') }),
      (h.email || h.phone) ? el('dt', { textContent: t('contact') }) : '', (h.email || h.phone) ? el('dd', { textContent: [h.email, h.phone].filter(Boolean).join(' · ') }) : '']),
    el('div', { className: 'rules' }, [el('b', { textContent: t('rulesH') }), el('ol', {}, [
      el('li', { textContent: t('rule1', { d: dt(tn.deadline) }) }), el('li', { textContent: t('rule2') }),
      el('li', { textContent: t('rule3', { a: addr || '—', d: dt(tn.deadline) }) }), el('li', { textContent: t('rule4') })])]),
    el('div', { className: 'acts' }, [el('button', { className: 'btn', type: 'button', textContent: (P.guide ? '▴ ' : '▾ ') + t('guideBtn'), onclick: () => { P.guide = !P.guide; render(); } })]),
    P.guide ? el('div', { className: 'guide' }, [el('b', { textContent: t('guideH') }), el('ol', {}, TX[LANG].guide.map(s => el('li', { textContent: s })))]) : '',
    tn.scope ? el('div', { style: 'margin-top:10px' }, [el('div', { className: 'dim', textContent: t('scope') }), el('div', { className: 'pre', textContent: tn.scope })]) : '',
    tn.terms ? el('div', { style: 'margin-top:10px' }, [el('div', { className: 'dim', textContent: t('terms') }), el('div', { className: 'pre', textContent: tn.terms })]) : '']));
  // The hotel's tender documents.
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('docsH') }),
    (tn.files || []).length ? el('ul', { className: 'files' }, tn.files.map(f => el('li', {}, [el('a', { href: '#', textContent: '📎 ' + (f.name || 'file'),
      onclick: e => { e.preventDefault(); download(f); } }), el('span', { className: 'dim', textContent: ` (${Math.max(1, Math.round((f.size || 0) / 1024))} KB)` })])))
      : el('div', { className: 'dim', textContent: t('noDocs') })]));
  if (!tn.accepting) app.append(el('div', { className: 'msg warn', textContent: t('notAccepting') }));
  else if (!editable) app.append(el('div', { className: 'msg info', textContent: t('readonly') }));

  const inp = (obj, k, opts = {}) => {
    const i = el(opts.area ? 'textarea' : 'input', { value: obj[k] ?? '', disabled: !editable });
    i.dataset.fid = (opts.fid || '') + ':' + k;
    if (opts.num) { i.inputMode = 'decimal'; i.value = obj[k] != null && obj[k] !== '' ? (opts.qty ? qfmt(obj[k]) : money(obj[k])) : ''; if (opts.ph != null) i.placeholder = opts.ph; }
    if (opts.type) i.type = opts.type;
    // Amounts are recomputed by redrawing; wait for the focus to move (Tab) so it can be put back.
    i.onchange = () => { obj[k] = opts.num ? num(i.value) : i.value.trim(); if (opts.num || opts.redraw) setTimeout(render, 0); };
    return i;
  };
  const unitSel = (obj, k, fid, extra) => {
    const s = el('select', { disabled: !editable });
    s.dataset.fid = fid + ':' + k;
    const units = P.s.units || [];
    s.append(el('option', { value: '', textContent: '—' }));
    for (const u of units) s.append(el('option', { value: u.code, textContent: `${u.code}${u.vi || u.en ? ' — ' + (LANG === 'en' ? u.en || u.vi : u.vi || u.en) : ''}` }));
    const v = obj[k] || extra || '';
    if (v && !units.some(u => u.code === v)) s.append(el('option', { value: v, textContent: v }));
    s.value = v;
    s.onchange = () => { obj[k] = s.value || null; };
    return s;
  };
  // Items: quantity and unit as required, changeable; price; amount; spec.
  const items = tn.items || [];
  const tb = el('table');
  tb.append(el('tr', {}, [el('th', { textContent: t('no') }), el('th', { textContent: t('item') }), el('th', { className: 'n', textContent: t('qtyReq') }),
    el('th', { className: 'n', textContent: t('qty') }), el('th', { textContent: t('unit') }), el('th', { className: 'n', textContent: t('price') }),
    el('th', { className: 'n', textContent: t('amount') }), el('th', { textContent: t('spec') })]));
  items.forEach((it, i) => {
    const k = String(i), qty = qtyOf(tn, d, i), amt = qty * n0(d.prices[k]);
    const sx = d.specx[k] = d.specx[k] || {};
    const summary = SPEC.filter(([f]) => sx[f]).map(([f, hd]) => `${hd}: ${sx[f]}`).concat(d.specs[k] ? [d.specs[k]] : []).join('; ');
    const diff = d.qtys[k] != null && d.qtys[k] !== '' && n0(d.qtys[k]) !== n0(it.qty);
    tb.append(el('tr', {}, [el('td', { className: 'c', textContent: String(i + 1) }),
      el('td', {}, [el('div', { textContent: it.item || '' }), it.spec ? el('small', { className: 'dim', textContent: t('reqSpec', { s: it.spec }) }) : '']),
      el('td', { className: 'n', textContent: `${qfmt(it.qty)} ${it.unit ? unitName(it.unit) : ''}` }),
      el('td', { className: 'n' + (diff ? ' diff' : ''), style: 'width:90px', title: diff ? t('qtyDiff') : '' }, inp(d.qtys, k, { num: true, qty: true, fid: 'q', ph: qfmt(it.qty) })),
      el('td', { style: 'width:130px' }, unitSel(d.units, k, 'u', it.unit)),
      el('td', { className: 'n', style: 'width:150px' }, inp(d.prices, k, { num: true, fid: 'p' })), el('td', { className: 'n', textContent: amt ? money(amt) : '' }),
      el('td', {}, [el('span', { className: 'dim', textContent: summary }), ' ',
        el('button', { className: 'btn tiny', type: 'button', textContent: P.specOpen === i ? '▴' : t('specBtn'), onclick: () => { P.specOpen = P.specOpen === i ? -1 : i; render(); } })])]));
    if (P.specOpen === i) tb.append(el('tr', { className: 'spec' }, el('td', { colSpan: 8 }, el('div', { className: 'specgrid' }, [
      ...SPEC.map(([f, hd]) => el('label', {}, [hd, inp(sx, f, { fid: 'x' + k })])),
      el('label', { style: 'grid-column:1 / -1' }, [t('otherSpec'), inp(d.specs, k, { fid: 's' })])]))));
  });
  // Overheads: description, qty, unit, unit price, amount.
  const tot = totals(tn, d);
  const ot = el('table', { style: 'margin-top:10px' });
  ot.append(el('tr', {}, [el('th', { textContent: t('ohLabel') }), el('th', { className: 'n', textContent: t('qty') }), el('th', { textContent: t('unit') }),
    el('th', { className: 'n', textContent: t('price') }), el('th', { className: 'n', textContent: t('amount') }), el('th', { style: 'width:40px' })]));
  d.olines.forEach((o, i) => ot.append(el('tr', {}, [el('td', {}, inp(o, 'label', { fid: 'o' + i })),
    el('td', { className: 'n', style: 'width:80px' }, inp(o, 'qty', { num: true, qty: true, fid: 'o' + i, ph: '1' })),
    el('td', { style: 'width:130px' }, unitSel(o, 'unit', 'o' + i)),
    el('td', { className: 'n', style: 'width:150px' }, inp(o, 'price', { num: true, fid: 'o' + i })),
    el('td', { className: 'n', textContent: money(ohAmt(o)) }),
    el('td', { className: 'c' }, editable ? el('button', { className: 'btn tiny danger', type: 'button', textContent: '×', onclick: () => { d.olines.splice(i, 1); render(); } }) : '')])));
  ot.append(el('tr', { className: 'tot' }, [el('td', { colSpan: 4, textContent: t('subtotal') + ' + ' + t('overheads').split(' (')[0] }), el('td', { className: 'n', textContent: money(tot.total) }), el('td')]));
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('items') }), el('div', { className: 'wrap' }, tb),
    el('h2', { style: 'margin-top:14px', textContent: t('overheads') }), el('div', { className: 'wrap' }, ot),
    editable ? el('button', { className: 'btn tiny', type: 'button', style: 'margin-top:6px', textContent: t('addOh'), onclick: () => { d.olines.push({ label: '', qty: 1, unit: null, price: null }); render(); } }) : '',
    el('div', { style: 'margin-top:10px;font-weight:700', textContent: `${t('total')}: ${money(tot.total)} VND` })]));
  // Payment schedule by instalment.
  const pt = el('table');
  pt.append(el('tr', {}, [el('th', { textContent: t('payNo') }), el('th', { className: 'n', textContent: t('payPct') }), el('th', { textContent: t('payWhen') }),
    el('th', { className: 'n', textContent: t('payDays') }), el('th', { textContent: t('payNote') }), el('th', { style: 'width:40px' })]));
  d.pay_sched.forEach((x, i) => {
    const w = el('select', { disabled: !editable });
    for (const k of WHEN) w.append(el('option', { value: k, textContent: t('when_' + k) }));
    w.value = x.when || 'deposit'; w.onchange = () => { x.when = w.value; };
    pt.append(el('tr', {}, [el('td', { className: 'c', textContent: String(i + 1) }), el('td', { className: 'n', style: 'width:80px' }, inp(x, 'pct', { num: true, qty: true, fid: 'y' + i })),
      el('td', { style: 'width:230px' }, w), el('td', { className: 'n', style: 'width:110px' }, inp(x, 'days', { num: true, qty: true, fid: 'y' + i })),
      el('td', {}, inp(x, 'note', { fid: 'y' + i })),
      el('td', { className: 'c' }, editable ? el('button', { className: 'btn tiny danger', type: 'button', textContent: '×', onclick: () => { d.pay_sched.splice(i, 1); render(); } }) : '')]));
  });
  const psum = d.pay_sched.reduce((s, x) => s + n0(x.pct), 0);
  const f = (k, lbl, area) => el('div', { className: 'fld' }, [el('label', { textContent: t(lbl) }), inp(d, k, { area })]);
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('commercial') }),
    el('h3', { textContent: t('paySched') }), el('div', { className: 'wrap' }, pt),
    el('div', { className: 'row', style: 'margin-top:6px;align-items:center' }, [
      editable ? el('button', { className: 'btn tiny', type: 'button', textContent: t('payAdd'),
        onclick: () => { d.pay_sched.push({ pct: d.pay_sched.length ? Math.max(0, 100 - psum) || null : 100, when: d.pay_sched.length ? 'acceptance' : 'deposit' }); render(); } }) : '',
      d.pay_sched.length ? el('span', { className: 'chip ' + (Math.abs(psum - 100) < 0.01 ? 'ok' : 'bad'), textContent: Math.abs(psum - 100) < 0.01 ? t('paySum', { p: qfmt(psum) }) : t('paySumBad', { p: qfmt(psum) }) }) : '']),
    el('div', { className: 'row', style: 'margin-top:8px' }, [f('pay_term', 'payTerm')]),
    el('div', { className: 'row', style: 'margin-top:8px' }, [f('delivery', 'delivery'), f('warranty', 'warranty'), f('validity', 'validity')]),
    el('div', { className: 'row', style: 'margin-top:8px' }, [f('note', 'note', true)])]));
  // Capability declarations.
  if ((tn.crit || []).length) {
    const ct = el('table');
    for (const c of tn.crit) ct.append(el('tr', {}, [el('td', { style: 'width:34%', textContent: c.label }), el('td', {}, inp(d.crit, c.label, { area: true, fid: 'c' }))]));
    app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('capability') }), el('div', { className: 'dim', style: 'margin-bottom:6px', textContent: t('capHint') }), ct]));
  }
  // Files.
  const files = (b && b.files) || [];
  const fl = el('ul', { className: 'files' }, files.length ? files.map(x => el('li', {}, [
    el('span', { className: 'chip' + (x.kind === 'quotation' ? ' ok' : ''), textContent: x.kind === 'quotation' ? t('quotation') : t('otherFile') }), ' ',
    x.name || '', ` (${Math.round((x.size || 0) / 1024)} KB) `,
    editable ? el('button', { className: 'btn tiny danger', type: 'button', textContent: '×', onclick: () => removeFile(tn, x.path) }) : ''])) : [el('li', { className: 'dim', textContent: t('noFiles') })]);
  const fileBox = el('div', { className: 'card' }, [el('h2', { textContent: t('files') }), fl]);
  if (editable) {
    const pick = (kind, label, multi) => { const i = el('input', { type: 'file', multiple: !!multi, accept: '.pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx,.doc,.zip', style: 'display:none' });
      i.onchange = () => addFiles(tn, [...i.files], kind);
      return [i, el('button', { className: 'btn', type: 'button', textContent: `${t('upload')}: ${label}`, onclick: () => i.click() })]; };
    fileBox.append(el('div', { className: 'acts' }, [...pick('quotation', t('quotation'), false), ...pick('other', t('otherFile'), true)]));
  }
  app.append(fileBox);
  // Actions.
  const acts = el('div', { className: 'acts' });
  acts.append(el('button', { className: 'btn', type: 'button', textContent: '🖨 ' + t('letter'), onclick: () => printLetter(tn) }));
  if (editable) {
    const xin = el('input', { type: 'file', accept: '.xlsx,.xls', style: 'display:none', onchange: () => xlsIn(tn, xin.files[0]) });
    acts.append(el('button', { className: 'btn', type: 'button', textContent: t('save'), onclick: () => save(tn) }),
      el('button', { className: 'btn', type: 'button', textContent: t('xlsDown'), onclick: () => xlsOut(tn) }), xin,
      el('button', { className: 'btn', type: 'button', textContent: t('xlsUp'), onclick: () => xin.click() }),
      el('button', { className: 'btn pri', type: 'button', textContent: t('submit'), onclick: () => submit(tn) }));
  } else if (tn.accepting && b && b.status === 'submitted') {
    acts.append(el('button', { className: 'btn pri', type: 'button', textContent: t('replace'), onclick: () => replace(tn) }));
  }
  app.append(el('div', { className: 'card' }, [acts]));
  app.append(qaCard(tn), surveyCard(tn));
  // History.
  const done = (tn.bids || []).filter(x => x.submitted_at);
  if (done.length) app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('history') }),
    el('ul', { className: 'files' }, done.map(x => el('li', { textContent: `${t('round')} ${x.round} · v${x.version} · ${t(x.status)} · ${dt(x.submitted_at)} · ${t('sealed')}${x.note ? ' · ' + x.note : ''}` })))]));
}

/* ------------------------------------------------------------ clarifications, site visit */
function qaCard(tn) {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('qaH') }), el('div', { className: 'dim', style: 'margin-bottom:8px', textContent: t('qaHint') })]);
  const list = tn.qa || [];
  if (!list.length) card.append(el('div', { className: 'dim', textContent: t('qaNone') }));
  for (const q of list) card.append(el('div', { className: 'qa' + (q.answer ? '' : ' wait') }, [
    q.question ? el('div', {}, [el('b', { textContent: q.mine ? t('qaMine') : t('qaShared') }), el('span', { className: 'dim', textContent: ' · ' + dt(q.asked_at) }),
      el('div', { className: 'pre', textContent: q.question })]) : el('b', { textContent: t('qaShared') }),
    q.answer ? el('div', { className: 'ans' }, [el('b', { textContent: t('qaAnswer') }), el('span', { className: 'dim', textContent: ' · ' + dt(q.answered_at) }),
      el('div', { className: 'pre', textContent: q.answer })]) : el('div', { className: 'chip warn', textContent: t('qaWait') })]));
  if (tn.accepting) {
    const ta = el('textarea', { placeholder: t('qaPh') });
    card.append(el('div', { className: 'row', style: 'margin-top:10px' }, [el('div', { className: 'fld' }, ta)]),
      el('div', { className: 'acts' }, el('button', { className: 'btn pri', type: 'button', textContent: t('qaAsk'), onclick: async () => {
        try { await rpc('vp_ask', { p_tender: tn.id, p_question: ta.value }); await load(tn.id); msg('ok', t('qaSent')); } catch (e) { msg('err', e.message); } } })));
  }
  return card;
}
function surveyCard(tn) {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('svH') })]);
  for (const s of tn.surveys || []) card.append(el('div', { className: 'qa' }, [
    el('span', { className: 'chip ' + (s.status === 'scheduled' ? 'ok' : s.status === 'requested' ? 'warn' : ''), textContent: t('svSt_' + s.status) }), ' ',
    el('span', { className: 'dim', textContent: dt(s.created_at) }),
    el('div', { textContent: `${t('svWhen')}: ${(s.proposed || []).map(dt).join(' · ')}` }),
    el('div', { textContent: `${t('svPeople')}: ${(s.people || []).map(p => p.name).join(', ')}` }),
    s.scheduled_at ? el('div', {}, el('b', { textContent: t('svAt', { d: dt(s.scheduled_at) }) })) : '',
    s.reply ? el('div', { className: 'pre', textContent: s.reply }) : '']));
  if (!tn.accepting) return card;
  if (!P.sv) { card.append(el('div', { className: 'acts' }, el('button', { className: 'btn', type: 'button', textContent: '📍 ' + t('svBtn'), onclick: () => { P.sv = true; render(); } }))); return card; }
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const times = [el('input', { type: 'datetime-local', value: dLocal(tomorrow) }), el('input', { type: 'datetime-local' }), el('input', { type: 'datetime-local' })];
  const people = el('table');
  people.append(el('tr', {}, [t('svName'), t('svId'), t('svPhone'), ''].map(x => el('th', { textContent: x }))));
  const addP = () => { const r = el('tr', {}, [el('td', {}, el('input')), el('td', {}, el('input', { inputMode: 'numeric' })), el('td', {}, el('input', { inputMode: 'tel' })),
    el('td', { className: 'c' }, el('button', { className: 'btn tiny danger', type: 'button', textContent: '×', onclick: () => r.remove() }))]); people.append(r); };
  addP();
  const cn = el('input'), cp = el('input', { inputMode: 'tel' }), ce = el('input', { type: 'email', value: P.s.email || '' }), note = el('textarea');
  const fld = (lbl, i) => el('div', { className: 'fld' }, [el('label', { textContent: lbl }), i]);
  card.append(el('div', { className: 'dim', style: 'margin-bottom:8px', textContent: t('svHint') }),
    el('div', { className: 'row' }, times.map((x, i) => fld(`${t('svWhen')} ${i + 1}`, x))),
    el('h3', { textContent: t('svPeople') }), el('div', { className: 'wrap' }, people),
    el('button', { className: 'btn tiny', type: 'button', style: 'margin-top:6px', textContent: t('svAddP'), onclick: addP }),
    el('div', { className: 'row', style: 'margin-top:8px' }, [fld(t('svContactName'), cn), fld(t('svContactPhone'), cp), fld(t('svContactEmail'), ce)]),
    el('div', { className: 'row', style: 'margin-top:8px' }, [fld(t('svNote'), note)]),
    el('div', { className: 'acts' }, [el('button', { className: 'btn', type: 'button', textContent: '×', onclick: () => { P.sv = false; render(); } }),
      el('button', { className: 'btn pri', type: 'button', textContent: t('svSend'), onclick: async () => {
        const p = { proposed: times.map(x => x.value).filter(Boolean).map(v => new Date(v).toISOString()),
          people: [...people.querySelectorAll('tr')].slice(1).map(r => { const [a, b, c] = [...r.querySelectorAll('input')].map(i => i.value.trim()); return { name: a, id_no: b, phone: c }; }).filter(x => x.name),
          contact_name: cn.value.trim(), contact_phone: cp.value.trim(), contact_email: ce.value.trim(), note: note.value };
        try { await rpc('vp_survey', { p_tender: tn.id, p }); P.sv = false; await load(tn.id); msg('ok', t('svSent')); } catch (e) { msg('err', e.message); }
      } })]));
  return card;
}

/* ------------------------------------------------------------ purchase orders */
function ordersCard() {
  const card = el('div', { className: 'card po' }, [el('h2', { textContent: t('ordersH') })]);
  for (const o of P.s.orders || []) {
    const d = o.data || {};
    const tb = el('table');
    tb.append(el('tr', {}, [t('no'), t('item'), t('poQty'), t('unit'), t('price'), t('amount')].map((x, i) => el('th', { className: i >= 2 && i !== 3 ? 'n' : '', textContent: x }))));
    (d.lines || []).forEach((l, i) => tb.append(el('tr', {}, [el('td', { className: 'c', textContent: String(i + 1) }), el('td', { textContent: l.asset_item || '' }),
      el('td', { className: 'n', textContent: qfmt(l.qty) }), el('td', { textContent: unitName(l.unit) }), el('td', { className: 'n', textContent: money(l.unit_price) }),
      el('td', { className: 'n', textContent: money(n0(l.qty) * n0(l.unit_price)) })])));
    for (const x of d.olines || []) tb.append(el('tr', {}, [el('td'), el('td', { textContent: x.label || '' }), el('td'), el('td'), el('td'), el('td', { className: 'n', textContent: money(x.amount) })]));
    tb.append(el('tr', { className: 'tot' }, [el('td', { colSpan: 5, textContent: t('poTotal') }), el('td', { className: 'n', textContent: money(o.total ?? d.total) })]));
    const terms = [['poPay', d.payment_term], ['delivery', d.delivery_term], ['warranty', d.warranty_term], ['note', d.note]].filter(([, v]) => v);
    card.append(el('div', { className: 'order' }, [
      el('div', { className: 'row', style: 'align-items:center;gap:10px' }, [el('b', { textContent: `${o.doc_no} · ${o.project_name || o.project_code}` }),
        el('span', { className: 'dim', textContent: t('poSent', { d: dt(o.sent_at) }) }),
        o.ack_at ? el('span', { className: 'chip ok', textContent: t('poAcked', { d: dt(o.ack_at) }) }) : '']),
      o.note ? el('div', { className: 'pre', style: 'margin:6px 0', textContent: o.note }) : '',
      el('div', { className: 'wrap' }, tb),
      terms.length ? el('dl', { className: 'kv', style: 'margin-top:8px' }, terms.flatMap(([k, v]) => [el('dt', { textContent: t(k) }), el('dd', { className: 'pre', textContent: v })])) : '',
      el('div', { className: 'acts' }, [el('button', { className: 'btn', type: 'button', textContent: '🖨 ' + t('poPrint'), onclick: () => printPo(o) }),
        !o.ack_at ? el('button', { className: 'btn pri', type: 'button', textContent: '✔ ' + t('poAck'), onclick: async () => {
          try { await rpc('vp_po_ack', { p_send: o.id }); await load(P.cur && P.cur.id); msg('ok', t('poAckOk')); } catch (e) { msg('err', e.message); } } }) : ''])]));
  }
  return card;
}

/* ------------------------------------------------------------ printing (a new window, every value escaped) */
function printWin(title, html) {
  const w = window.open('', '_blank');
  if (!w) { msg('err', t('letterNoPop')); return; }
  w.document.open();
  w.document.write(`<!doctype html><html lang="${LANG}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page{size:A4 portrait;margin:14mm} body{font:12.5px/1.45 "Times New Roman",serif;color:#000;margin:0}
    h1{font-size:18px;text-align:center;margin:14px 0 4px;letter-spacing:.5px} .c{text-align:center} .r{text-align:right}
    table{border-collapse:collapse;width:100%;margin:8px 0} th,td{border:1px solid #444;padding:4px 6px;vertical-align:top} th{background:#eee}
    .n{text-align:right;white-space:nowrap} .hd{display:flex;justify-content:space-between;gap:20px} .sig{margin-top:26px;display:flex;justify-content:flex-end}
    .sig div{text-align:center;width:300px} .pre{white-space:pre-wrap} small{color:#444} .tot td{font-weight:bold}
  </style></head><body>${html}<script>setTimeout(function(){print()},300)<\/script></body></html>`);
  w.document.close();
}
function printLetter(tn) {
  const d = P.form.d, h = P.s.hotel || {}, tot = totals(tn, d), now = new Date();
  const rows = (tn.items || []).map((it, i) => { const q = qtyOf(tn, d, i), sx = d.specx[i] || {};
    const spec = SPEC.filter(([f]) => sx[f]).map(([f, hd]) => `${hd}: ${sx[f]}`).concat(d.specs[i] ? [d.specs[i]] : []).join('; ');
    return `<tr><td class="c">${i + 1}</td><td>${esc(it.item)}${spec ? `<br><small>${esc(spec)}</small>` : ''}</td><td class="n">${esc(qfmt(q))}</td><td>${esc(unitName(d.units[i] || it.unit))}</td>
      <td class="n">${esc(money(d.prices[i]))}</td><td class="n">${esc(money(q * n0(d.prices[i])))}</td></tr>`; }).join('');
  const oh = d.olines.filter(o => o.label || ohAmt(o)).map(o => `<tr><td></td><td>${esc(o.label)}</td><td class="n">${esc(qfmt(o.qty ?? 1))}</td><td>${esc(unitName(o.unit))}</td>
      <td class="n">${esc(money(o.price ?? o.amount))}</td><td class="n">${esc(money(ohAmt(o)))}</td></tr>`).join('');
  const L = k => esc(t(k));
  const kv = [['delivery', d.delivery], ['warranty', d.warranty], ['validity', d.validity], ['note', d.note]].filter(([, v]) => v)
    .map(([k, v]) => `<tr><th style="width:30%;text-align:left">${L(k)}</th><td class="pre">${esc(v)}</td></tr>`).join('');
  const pay = payText(d);
  printWin(`${t('letterTitle')} - ${tn.project_code}`, `
    <div class="hd"><div><b>${esc(P.s.vendor)}</b></div><div class="r">${L('letterDate')}: ${esc(dt(now.toISOString()).slice(0, 10))}</div></div>
    <h1>${L('letterTitle')}</h1>
    <p class="c">${L('letterRe')} ${esc(tn.title || tn.project_name || '')} (${esc(tn.project_code)})</p>
    <p><b>${L('letterTo')}:</b> ${esc([h.company, h.dept].filter(Boolean).join(' — '))}<br>${esc(tn.address || h.address || '')}</p>
    <p><b>${L('letterFrom')}:</b> ${esc(P.s.vendor)}${P.s.email ? ' · ' + esc(P.s.email) : ''}</p>
    <p>${L('letterIntro')}</p>
    <table><tr><th>${L('no')}</th><th>${L('item')}</th><th>${L('qty')}</th><th>${L('unit')}</th><th>${L('price')}</th><th>${L('amount')}</th></tr>${rows}${oh}
      <tr class="tot"><td colspan="5">${L('total')}</td><td class="n">${esc(money(tot.total))}</td></tr></table>
    <p><i>${L('letterVat')}</i></p>
    ${pay || d.pay_term ? `<p><b>${L('paySched')}:</b></p><p class="pre">${esc(pay)}${d.pay_term ? '\n' + esc(d.pay_term) : ''}</p>` : ''}
    ${kv ? `<table>${kv}</table>` : ''}
    <div class="sig"><div><b>${L('letterSign')}</b><br><small>${L('letterSignSub')}</small><br><br><br><br><br></div></div>`);
}
function printPo(o) {
  const d = o.data || {}, h = P.s.hotel || {};
  const rows = (d.lines || []).map((l, i) => `<tr><td class="c">${i + 1}</td><td>${esc(l.asset_item)}</td><td class="n">${esc(qfmt(l.qty))}</td><td>${esc(unitName(l.unit))}</td>
    <td class="n">${esc(money(l.unit_price))}</td><td class="n">${esc(money(n0(l.qty) * n0(l.unit_price)))}</td></tr>`).join('')
    + (d.olines || []).map(x => `<tr><td></td><td>${esc(x.label)}</td><td></td><td></td><td></td><td class="n">${esc(money(x.amount))}</td></tr>`).join('');
  const kv = [['poPay', d.payment_term], ['delivery', d.delivery_term], ['warranty', d.warranty_term], ['note', d.note]].filter(([, v]) => v)
    .map(([k, v]) => `<tr><th style="width:30%;text-align:left">${esc(t(k))}</th><td class="pre">${esc(v)}</td></tr>`).join('');
  printWin(o.doc_no, `<div class="hd"><div><b>${esc(h.company || '')}</b><br>${esc(h.address || '')}</div><div class="r"><b>${esc(o.doc_no)}</b><br>${esc(dt(d.order_date || o.sent_at).slice(0, 10))}</div></div>
    <h1>PURCHASE ORDER / ĐƠN ĐẶT HÀNG</h1><p class="c">${esc(o.project_code)} — ${esc(o.project_name || '')}</p><p><b>${esc(t('letterTo'))}:</b> ${esc(P.s.vendor)}</p>
    <table><tr><th>${esc(t('no'))}</th><th>${esc(t('item'))}</th><th>${esc(t('poQty'))}</th><th>${esc(t('unit'))}</th><th>${esc(t('price'))}</th><th>${esc(t('amount'))}</th></tr>${rows}
      <tr class="tot"><td colspan="5">${esc(t('poTotal'))}</td><td class="n">${esc(money(o.total ?? d.total))}</td></tr></table>${kv ? `<table>${kv}</table>` : ''}`);
}

/* ------------------------------------------------------------ actions */
async function save(tn, quiet) {
  try { await rpc('vp_save', { p_tender: tn.id, p_data: P.form.d }); if (!quiet) { await load(tn.id); msg('ok', t('saved')); } return true; }
  catch (e) { msg('err', e.message); return false; }
}
async function submit(tn) {
  if (!confirm(t('confirmSubmit'))) return;
  if (!(await save(tn, true))) return;
  try { await rpc('vp_submit', { p_tender: tn.id }); P.form = null; await load(tn.id); msg('ok', t('submittedOk')); }
  catch (e) { msg('err', e.message); }
}
async function replace(tn) {
  const why = prompt(t('askReason'));
  if (!why || !why.trim()) return;
  try { await rpc('vp_new_version', { p_tender: tn.id, p_reason: why.trim() }); P.form = null; await load(tn.id); msg('ok', t('replaced')); }
  catch (e) { msg('err', e.message); }
}
async function addFiles(tn, files, kind) {
  if (!files.length) return;
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) return msg('err', t('tooBig', { n: f.name }));
    if (f.type && !OK_TYPES.test(f.type)) return msg('err', t('badType'));
  }
  if (!(await save(tn, true))) return;
  try {
    const key = await rpc('vp_upload_key', { p_tender: tn.id });
    for (const f of files) {
      const path = await uploadFile(f, key);
      await rpc('vp_file_add', { p_tender: tn.id, p_path: path, p_name: f.name, p_size: f.size, p_kind: kind });
    }
    await load(tn.id);
    msg('ok', t('uploaded', { n: files.map(f => f.name).join(', ') }));
  } catch (e) { msg('err', e.message); }
}
async function removeFile(tn, path) {
  try { await rpc('vp_file_remove', { p_tender: tn.id, p_path: path }); await load(tn.id); } catch (e) { msg('err', e.message); }
}

/* ------------------------------------------------------------ Excel
   The same bid as a workbook: fill it offline, load it back. Sheets: Items
   (quantity, unit, prices and spec by field), Overheads, Payment, Terms,
   Capability. Older templates (overheads with an amount only) still load. */
function xlsOut(tn) {
  const d = P.form.d, items = tn.items || [];
  const wb = XLSX.utils.book_new();
  const head = ['No.', 'Item', 'Qty required', 'Qty quoted', 'Unit', 'Unit price (VND)', ...SPEC.map(s => s[1]), 'Other spec'];
  const rows = items.map((it, i) => { const k = String(i), sx = d.specx[k] || {};
    return [i + 1, it.item || '', it.qty ?? '', d.qtys[k] ?? '', d.units[k] || it.unit || '', d.prices[k] ?? '', ...SPEC.map(([f]) => sx[f] || ''), d.specs[k] || '']; });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), 'Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Description', 'Qty', 'Unit', 'Unit price (VND)'], ...d.olines.map(o => [o.label || '', o.qty ?? 1, o.unit || '', o.price ?? o.amount ?? ''])]), 'Overheads');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['%', 'When (' + WHEN.join(' / ') + ')', 'Within (days)', 'Note'], ...d.pay_sched.map(x => [x.pct ?? '', x.when || '', x.days ?? '', x.note || ''])]), 'Payment');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Field', 'Value'], ['Payment remarks', d.pay_term || ''], ['Delivery time', d.delivery || ''],
    ['Warranty', d.warranty || ''], ['Quotation validity', d.validity || ''], ['Note', d.note || '']]), 'Terms');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Criterion', 'Declaration'], ...(tn.crit || []).map(c => [c.label, d.crit[c.label] || ''])]), 'Capability');
  XLSX.writeFile(wb, `Tender ${tn.project_code} - ${P.s.vendor}.xlsx`.replace(/[\\/:*?"<>|]/g, ' '));
}
async function xlsIn(tn, file) {
  if (!file) return;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = n => { const ws = wb.Sheets[n] || wb.Sheets[wb.SheetNames.find(s => s.toLowerCase() === n.toLowerCase())]; return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) : []; };
    const d = P.form.d, items = tn.items || [];
    const it = sheet('Items');
    if (it.length) {
      const h = it[0].map(x => String(x).trim().toLowerCase());
      const col = name => h.indexOf(name.toLowerCase());
      for (const r of it.slice(1)) {
        const i = Number(r[col('No.')]) - 1;
        if (!(i >= 0 && i < items.length)) continue;
        const k = String(i);
        const pr = num(r[col('Unit price (VND)')]); if (pr != null) d.prices[k] = pr;
        if (col('Qty quoted') >= 0) { const q = num(r[col('Qty quoted')]); d.qtys[k] = q; }
        if (col('Unit') >= 0 && String(r[col('Unit')]).trim()) d.units[k] = String(r[col('Unit')]).trim();
        const sx = d.specx[k] = d.specx[k] || {};
        for (const [f, hd] of SPEC) { const c = col(hd); if (c >= 0 && String(r[c]).trim() !== '') sx[f] = String(r[c]).trim(); }
        const o = col('Other spec'); if (o >= 0 && String(r[o]).trim() !== '') d.specs[k] = String(r[o]).trim();
      }
    }
    const ohs = sheet('Overheads');
    if (ohs.length) {
      const h = ohs[0].map(x => String(x).trim().toLowerCase()), newer = h.includes('qty');
      const oh = ohs.slice(1).filter(r => String(r[0]).trim() || num(r[newer ? 3 : 1]) != null);
      if (oh.length) d.olines = oh.map(r => newer ? { label: String(r[0]).trim(), qty: num(r[1]) ?? 1, unit: String(r[2] || '').trim() || null, price: num(r[3]) }
                                                  : { label: String(r[0]).trim(), qty: 1, unit: null, price: num(r[1]) });
    }
    const pay = sheet('Payment').slice(1).filter(r => num(r[0]) != null);
    if (pay.length) d.pay_sched = pay.map(r => ({ pct: num(r[0]), when: WHEN.includes(String(r[1]).trim().toLowerCase()) ? String(r[1]).trim().toLowerCase() : 'other', days: num(r[2]), note: String(r[3] || '').trim() }));
    const tm = new Map(sheet('Terms').slice(1).map(r => [String(r[0]).trim().toLowerCase(), String(r[1] ?? '').trim()]));
    for (const [k, lbl] of [['pay_term', 'payment remarks'], ['pay_term', 'payment term'], ['delivery', 'delivery time'], ['warranty', 'warranty'], ['validity', 'quotation validity'], ['note', 'note']])
      if (tm.has(lbl)) d[k] = tm.get(lbl);
    for (const r of sheet('Capability').slice(1)) { const lbl = String(r[0]).trim(); if ((tn.crit || []).some(c => c.label === lbl)) d.crit[lbl] = String(r[1] ?? '').trim(); }
    render();
    msg('ok', t('xlsRead'));
  } catch (e) { msg('err', e.message); }
}

/* ------------------------------------------------------------ start */
document.querySelectorAll('#lang button').forEach(b => {
  b.classList.toggle('on', b.dataset.l === LANG);
  b.onclick = () => { LANG = b.dataset.l; try { localStorage.setItem('tender.lang', LANG); } catch {}
    document.querySelectorAll('#lang button').forEach(x => x.classList.toggle('on', x.dataset.l === LANG));
    if (P.s) { $('#hWho').textContent = t('who', { v: P.s.vendor, d: dt(P.s.expires_at) }); render(); } };
});
readLink();
if (!P.url || !P.key || !P.token) msg('err', t('noCfg'));
else load();
