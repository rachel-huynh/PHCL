/* =====================================================================
   Tender portal — the page a vendor opens from the private link the hotel
   sends (Tender.html#c=<config>&t=<token>). No account: the token in the link
   is the key, checked by the database on every call (vp_* functions,
   sql/25_pm_tender.sql). The vendor sees only their own bids.

   A bid is saved as a draft and can be changed; once submitted it is locked
   and sealed — to change it, the vendor creates a replacement version. Files
   go to the private Storage bucket "pm-tender", into the draft's own folder;
   the vendor can upload but never read or list them back.

   Everything the vendor or the hotel typed is shown with textContent only —
   never as HTML.
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
    items: 'Hạng mục chào giá', no: 'STT', item: 'Hạng mục', qty: 'SL', unit: 'ĐVT', price: 'Đơn giá (VND)', amount: 'Thành tiền', spec: 'Thông số',
    specBtn: 'Thông số', otherSpec: 'Khác / ghi tự do', overheads: 'Chi phí khác (vận chuyển, lắp đặt, vật tư phụ…)', ohLabel: 'Nội dung', addOh: '+ Thêm dòng',
    subtotal: 'Cộng hạng mục', total: 'Tổng giá chào (trước thuế)', commercial: 'Điều khoản thương mại', payTerm: 'Điều khoản thanh toán',
    delivery: 'Thời gian giao hàng', warranty: 'Bảo hành', validity: 'Hiệu lực báo giá', note: 'Ghi chú',
    capability: 'Kê khai năng lực & kỹ thuật', capHint: 'Kê khai theo từng tiêu chí (số liệu, tài liệu chứng minh).',
    files: 'Tài liệu đính kèm', quotation: 'Báo giá có đóng dấu (PDF)', otherFile: 'Tài liệu khác', upload: 'Tải lên', noFiles: 'Chưa có tệp nào.',
    save: 'Lưu nháp', submit: 'Nộp hồ sơ', xlsDown: 'Tải mẫu Excel', xlsUp: 'Nạp từ Excel', replace: 'Tạo bản thay thế',
    saved: 'Đã lưu nháp.', submittedOk: 'Đã nộp hồ sơ. Hồ sơ được niêm phong cho tới khi khách sạn mở cùng lúc.',
    confirmSubmit: 'Nộp hồ sơ? Sau khi nộp sẽ KHÔNG rút lại hay sửa được — muốn thay đổi phải tạo bản thay thế.',
    askReason: 'Lý do tạo bản thay thế (vd: làm rõ theo yêu cầu, cập nhật giá):', replaced: 'Đã tạo bản nháp thay thế — sửa rồi nộp lại.',
    uploaded: 'Đã tải lên {n}.', xlsRead: 'Đã nạp dữ liệu từ Excel — kiểm tra rồi lưu nháp.', readonly: 'Hồ sơ đã nộp — chỉ xem. Muốn thay đổi: tạo bản thay thế.',
    notAccepting: 'Gói này không còn nhận hồ sơ.', history: 'Các bản đã nộp', sealed: 'niêm phong', pick: 'Chọn một gói để chào giá.',
    tooBig: 'Tệp {n} lớn hơn 20 MB.', badType: 'Chỉ nhận PDF, ảnh, Excel, Word, ZIP.'
  },
  en: {
    title: 'Tender portal', who: 'Vendor: {v} · link expires {d}', loading: 'Loading…', bad: 'This link is not valid or has expired. Please contact the hotel\'s Purchasing team.',
    noCfg: 'This link lacks its connection details. Open the exact link that was sent to you.',
    tenders: 'Tenders', deadline: 'Deadline', project: 'Project', round: 'Round', status: 'Status',
    accepting: 'Accepting bids', closed: 'Closed', scope: 'Scope of work / Tender document', terms: 'Instructions',
    myBid: 'Your bid', none: 'None yet', draft: 'Draft', submitted: 'Submitted', superseded: 'Replaced',
    items: 'Items to quote', no: 'No.', item: 'Item', qty: 'Qty', unit: 'Unit', price: 'Unit price (VND)', amount: 'Amount', spec: 'Spec',
    specBtn: 'Spec', otherSpec: 'Other / free text', overheads: 'Other costs (transport, installation, consumables…)', ohLabel: 'Description', addOh: '+ Add line',
    subtotal: 'Items subtotal', total: 'Total quoted (pre-tax)', commercial: 'Commercial terms', payTerm: 'Payment term',
    delivery: 'Delivery time', warranty: 'Warranty', validity: 'Quotation validity', note: 'Note',
    capability: 'Capability & technical declaration', capHint: 'Declare against each criterion (figures, supporting documents).',
    files: 'Attachments', quotation: 'Stamped quotation (PDF)', otherFile: 'Other document', upload: 'Upload', noFiles: 'No files yet.',
    save: 'Save draft', submit: 'Submit bid', xlsDown: 'Download Excel template', xlsUp: 'Load from Excel', replace: 'Create a replacement',
    saved: 'Draft saved.', submittedOk: 'Bid submitted. It stays sealed until the hotel opens all bids together.',
    confirmSubmit: 'Submit the bid? It can NOT be withdrawn or changed afterwards — to change it you create a replacement.',
    askReason: 'Reason for the replacement (e.g. clarification requested, price update):', replaced: 'Replacement draft created — edit it and submit again.',
    uploaded: '{n} uploaded.', xlsRead: 'Data loaded from Excel — check it, then save the draft.', readonly: 'Submitted bid — read only. To change it, create a replacement.',
    notAccepting: 'This tender no longer accepts bids.', history: 'Submitted versions', sealed: 'sealed', pick: 'Choose a tender to quote.',
    tooBig: 'File {n} is larger than 20 MB.', badType: 'Only PDF, images, Excel, Word, ZIP are accepted.'
  }
};
let LANG = (() => { try { return localStorage.getItem('tender.lang') || 'vi'; } catch { return 'vi'; } })();
const t = (k, p = {}) => String((TX[LANG] || TX.vi)[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? '');

/* ------------------------------------------------------------ connection */
// The link carries the project address (same encoding as the app's #sbcfg) and the token.
const P = { url: '', key: '', token: '', s: null, cur: null, form: null, specOpen: -1 };
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
async function uploadFile(file, key) {
  const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
  const path = `${key}/${Date.now()}-${safe}`;
  const r = await fetch(`${P.url}/storage/v1/object/pm-tender/${path}`, { method: 'POST',
    headers: { apikey: P.key, Authorization: 'Bearer ' + P.key, 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, body: file });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
  return path;
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
const money = v => v == null || v === '' || !isFinite(v) ? '' : Math.round(Number(v)).toLocaleString('vi-VN');
// dd/mm/yyyy HH:mm in both languages, like the hotel's app.
const dt = s => { if (!s) return ''; const d = new Date(s), z = n => String(n).padStart(2, '0');
  return isNaN(d) ? String(s) : `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const SPEC = [['brand', 'Brand'], ['model', 'Model'], ['origin', 'Origin'], ['capacity', 'Capacity'], ['function', 'Function'],
  ['length', 'Length'], ['width', 'Width'], ['height', 'Height/Depth'], ['weight', 'Weight'], ['material', 'Material'], ['color', 'Color'],
  ['manufacturer', 'Manufacturer'], ['mfg_year', 'Year'], ['accessory', 'Accessory'], ['radius', 'Radius'], ['fuel', 'Fuel'],
  ['serial', 'Serial'], ['shape', 'Shape'], ['area', 'Area'], ['perimeter', 'Perimeter']];
const blank = () => ({ prices: {}, specx: {}, specs: {}, olines: [], pay_term: '', delivery: '', warranty: '', validity: '', note: '', crit: {} });
const curBid = tn => (tn.bids || []).filter(b => b.round === tn.round).sort((a, b) => b.version - a.version)[0] || null;

/* ------------------------------------------------------------ screens */
async function load(keepId) {
  msg('info', t('loading'));
  try {
    P.s = await rpc('vp_session');
    msg('', '');
    $('#hWho').textContent = t('who', { v: P.s.vendor, d: dt(P.s.expires_at) });
    const list = P.s.tenders || [];
    P.cur = list.find(x => x.id === keepId) || (list.length === 1 ? list[0] : null);
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
  if (list.length > 1 || !P.cur) {
    const box = el('div', { className: 'card' }, [el('h2', { textContent: t('tenders') })]);
    const grid = el('div', { className: 'tlist' });
    for (const tn of list) {
      const b = curBid(tn);
      grid.append(el('div', { className: 'tcard' + (P.cur && P.cur.id === tn.id ? ' on' : ''), onclick: () => { P.cur = tn; P.form = null; render(); } }, [
        el('b', { textContent: tn.title || tn.project_name || tn.project_code }),
        el('small', { textContent: `${tn.project_code} · ${t('deadline')}: ${dt(tn.deadline)}` }), el('br'),
        el('span', { className: 'chip ' + (tn.accepting ? 'ok' : 'bad'), textContent: tn.accepting ? t('accepting') : t('closed') }), ' ',
        el('span', { className: 'chip', textContent: `${t('myBid')}: ${b ? t(b.status) + ' v' + b.version : t('none')}` })]));
    }
    box.append(grid);
    app.append(box);
    if (!P.cur) { app.append(el('div', { className: 'msg info', textContent: t('pick') })); return; }
  }
  renderTender(app, P.cur);
}

function renderTender(app, tn) {
  const b = curBid(tn);
  const editable = tn.accepting && (!b || b.status === 'draft');
  if (!P.form || P.form.tid !== tn.id) P.form = { tid: tn.id, d: Object.assign(blank(), JSON.parse(JSON.stringify((b && b.data) || {}))) };
  const d = P.form.d;
  // Header
  app.append(el('div', { className: 'card' }, [
    el('h2', { textContent: tn.title || tn.project_name || tn.project_code }),
    el('dl', { className: 'kv' }, [
      el('dt', { textContent: t('project') }), el('dd', { textContent: `${tn.project_code} — ${tn.project_name || ''}` }),
      el('dt', { textContent: t('deadline') }), el('dd', { textContent: dt(tn.deadline) }),
      el('dt', { textContent: t('status') }), el('dd', {}, [el('span', { className: 'chip ' + (tn.accepting ? 'ok' : 'bad'), textContent: tn.accepting ? t('accepting') : t('closed') }),
        tn.round > 1 ? ` · ${t('round')} ${tn.round}` : '']),
      el('dt', { textContent: t('myBid') }), el('dd', { textContent: b ? `${t(b.status)} · v${b.version}${b.submitted_at ? ' · ' + dt(b.submitted_at) : ''}` : t('none') })]),
    tn.scope ? el('div', { style: 'margin-top:10px' }, [el('div', { className: 'dim', textContent: t('scope') }), el('div', { className: 'pre', textContent: tn.scope })]) : '',
    tn.terms ? el('div', { style: 'margin-top:10px' }, [el('div', { className: 'dim', textContent: t('terms') }), el('div', { className: 'pre', textContent: tn.terms })]) : '']));
  if (!tn.accepting) app.append(el('div', { className: 'msg warn', textContent: t('notAccepting') }));
  else if (!editable) app.append(el('div', { className: 'msg info', textContent: t('readonly') }));

  const inp = (obj, k, opts = {}) => {
    const i = el(opts.area ? 'textarea' : 'input', { value: obj[k] ?? '', disabled: !editable });
    i.dataset.fid = (opts.fid || '') + ':' + k;
    if (opts.num) { i.inputMode = 'decimal'; i.value = obj[k] != null && obj[k] !== '' ? money(obj[k]) : ''; }
    // Amounts are recomputed by redrawing; wait for the focus to move (Tab) so it can be put back.
    i.onchange = () => { obj[k] = opts.num ? num(i.value) : i.value.trim(); if (opts.num) setTimeout(render, 0); };
    return i;
  };
  // Items
  const items = tn.items || [];
  const tb = el('table');
  tb.append(el('tr', {}, [el('th', { textContent: t('no') }), el('th', { textContent: t('item') }), el('th', { className: 'n', textContent: t('qty') }),
    el('th', { textContent: t('unit') }), el('th', { className: 'n', textContent: t('price') }), el('th', { className: 'n', textContent: t('amount') }), el('th', { textContent: t('spec') })]));
  let sub = 0;
  items.forEach((it, i) => {
    const k = String(i), qty = Number(it.qty) || 0, amt = qty * (Number(d.prices[k]) || 0);
    sub += amt;
    const sx = d.specx[k] = d.specx[k] || {};
    const summary = SPEC.filter(([f]) => sx[f]).map(([f, h]) => `${h}: ${sx[f]}`).concat(d.specs[k] ? [d.specs[k]] : []).join('; ');
    tb.append(el('tr', {}, [el('td', { className: 'c', textContent: String(i + 1) }), el('td', { textContent: it.item || '' }),
      el('td', { className: 'n', textContent: String(it.qty ?? '') }), el('td', { textContent: it.unit || '' }),
      el('td', { className: 'n', style: 'width:150px' }, inp(d.prices, k, { num: true, fid: 'p' })), el('td', { className: 'n', textContent: amt ? money(amt) : '' }),
      el('td', {}, [el('span', { className: 'dim', textContent: summary }), ' ',
        el('button', { className: 'btn tiny', type: 'button', textContent: P.specOpen === i ? '▴' : t('specBtn'), onclick: () => { P.specOpen = P.specOpen === i ? -1 : i; render(); } })])]));
    if (P.specOpen === i) tb.append(el('tr', { className: 'spec' }, el('td', { colSpan: 7 }, el('div', { className: 'specgrid' }, [
      ...SPEC.map(([f, h]) => el('label', {}, [h, inp(sx, f, { fid: 'x' + k })])),
      el('label', { style: 'grid-column:1 / -1' }, [t('otherSpec'), inp(d.specs, k, { fid: 's' })])]))));
  });
  // Overheads
  const oh = d.olines.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const ot = el('table', { style: 'margin-top:10px' });
  ot.append(el('tr', {}, [el('th', { textContent: t('ohLabel') }), el('th', { className: 'n', textContent: t('amount') }), el('th', { style: 'width:40px' })]));
  d.olines.forEach((o, i) => ot.append(el('tr', {}, [el('td', {}, inp(o, 'label', { fid: 'o' + i })), el('td', { className: 'n', style: 'width:180px' }, inp(o, 'amount', { num: true, fid: 'o' + i })),
    el('td', { className: 'c' }, editable ? el('button', { className: 'btn tiny danger', type: 'button', textContent: '×', onclick: () => { d.olines.splice(i, 1); render(); } }) : '')])));
  ot.append(el('tr', { className: 'tot' }, [el('td', { textContent: t('subtotal') + ' + ' + t('overheads').split(' (')[0] }), el('td', { className: 'n', textContent: money(sub + oh) }), el('td')]));
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('items') }), el('div', { className: 'wrap' }, tb),
    el('h2', { style: 'margin-top:14px', textContent: t('overheads') }), el('div', { className: 'wrap' }, ot),
    editable ? el('button', { className: 'btn tiny', type: 'button', style: 'margin-top:6px', textContent: t('addOh'), onclick: () => { d.olines.push({ label: '', amount: null }); render(); } }) : '',
    el('div', { style: 'margin-top:10px;font-weight:700', textContent: `${t('total')}: ${money(sub + oh)} VND` })]));
  // Commercial terms
  const f = (k, lbl, area) => el('div', { className: 'fld' }, [el('label', { textContent: t(lbl) }), inp(d, k, { area })]);
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('commercial') }),
    el('div', { className: 'row' }, [f('pay_term', 'payTerm'), f('delivery', 'delivery'), f('warranty', 'warranty'), f('validity', 'validity')]),
    el('div', { className: 'row', style: 'margin-top:8px' }, [f('note', 'note', true)])]));
  // Capability declarations
  if ((tn.crit || []).length) {
    const ct = el('table');
    for (const c of tn.crit) ct.append(el('tr', {}, [el('td', { style: 'width:34%', textContent: c.label }), el('td', {}, inp(d.crit, c.label, { area: true, fid: 'c' }))]));
    app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('capability') }), el('div', { className: 'dim', style: 'margin-bottom:6px', textContent: t('capHint') }), ct]));
  }
  // Files
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
  // Actions
  const acts = el('div', { className: 'acts' });
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
  // History
  const done = (tn.bids || []).filter(x => x.submitted_at);
  if (done.length) app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('history') }),
    el('ul', { className: 'files' }, done.map(x => el('li', { textContent: `${t('round')} ${x.round} · v${x.version} · ${t(x.status)} · ${dt(x.submitted_at)} · ${t('sealed')}${x.note ? ' · ' + x.note : ''}` })))]));
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
   (prices and spec by field), Overheads, Terms, Capability. */
function xlsOut(tn) {
  const d = P.form.d, items = tn.items || [];
  const wb = XLSX.utils.book_new();
  const head = ['No.', 'Item', 'Qty', 'Unit', 'Unit price (VND)', ...SPEC.map(s => s[1]), 'Other spec'];
  const rows = items.map((it, i) => { const k = String(i), sx = d.specx[k] || {};
    return [i + 1, it.item || '', it.qty ?? '', it.unit || '', d.prices[k] ?? '', ...SPEC.map(([f]) => sx[f] || ''), d.specs[k] || '']; });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows]), 'Items');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Description', 'Amount (VND)'], ...d.olines.map(o => [o.label || '', o.amount ?? ''])]), 'Overheads');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Field', 'Value'], ['Payment term', d.pay_term || ''], ['Delivery time', d.delivery || ''],
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
        const sx = d.specx[k] = d.specx[k] || {};
        for (const [f, hd] of SPEC) { const c = col(hd); if (c >= 0 && String(r[c]).trim() !== '') sx[f] = String(r[c]).trim(); }
        const o = col('Other spec'); if (o >= 0 && String(r[o]).trim() !== '') d.specs[k] = String(r[o]).trim();
      }
    }
    const oh = sheet('Overheads').slice(1).filter(r => String(r[0]).trim() || num(r[1]) != null);
    if (oh.length) d.olines = oh.map(r => ({ label: String(r[0]).trim(), amount: num(r[1]) }));
    const tm = new Map(sheet('Terms').slice(1).map(r => [String(r[0]).trim().toLowerCase(), String(r[1] ?? '').trim()]));
    for (const [k, lbl] of [['pay_term', 'payment term'], ['delivery', 'delivery time'], ['warranty', 'warranty'], ['validity', 'quotation validity'], ['note', 'note']])
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
