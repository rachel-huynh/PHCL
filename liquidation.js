/* =====================================================================
   Liquidation quotation — the page a buyer opens from the private link the
   hotel sends (Liquidation.html#c=<config>&t=<token>). No account: the token
   in the link is the key, checked by the database on every call (vq_*
   functions, sql/29_liquidation_bid.sql). The buyer sees the items for sale
   and their own quotation only — never the other quotations nor the floor price.

   The quotation (Thư báo giá) can be saved and changed until the deadline;
   once submitted it is sealed until the council opens all quotations together.
   Changing a submitted one takes it back to a draft: submit it again.

   Everything typed is shown with textContent only — never as HTML.
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

const TX = {
  vi: {
    title: 'Thư báo giá thanh lý', alt: 'Liquidation quotation', who: 'Bên mua: {v} · link hết hạn {d}', loading: 'Đang tải…',
    bad: 'Đường link không hợp lệ hoặc đã hết hạn. Liên hệ bộ phận Quản lý tài sản của khách sạn.',
    noCfg: 'Đường link thiếu thông tin kết nối. Hãy mở đúng đường link được gửi cho bạn.',
    batch: 'Đợt thanh lý', deadline: 'Hạn nộp báo giá', status: 'Trạng thái', accepting: 'Đang nhận báo giá', closed: 'Đã ngừng nhận',
    terms: 'Chỉ dẫn', mine: 'Báo giá của bạn', none: 'Chưa có', draft: 'Nháp — chưa nộp', submitted: 'Đã nộp (niêm phong)',
    buyer: 'Thông tin bên mua', person: 'Cá nhân', company: 'Doanh nghiệp', name_p: 'Họ tên', name_c: 'Tên doanh nghiệp', id_no: 'Số CCCD',
    tax_code: 'Mã số thuế', rep: 'Người đại diện', address: 'Địa chỉ', phone: 'Điện thoại', email_p: 'Email', email_c: 'Email nhận hoá đơn',
    items: 'Tài sản thanh lý', no: 'STT', item: 'Tên tài sản', code: 'Mã tài sản', qty: 'SL', unit: 'ĐVT', cond: 'Hiện trạng',
    price: 'Đơn giá chào mua (VND)', amount: 'Thành tiền', total: 'Tổng giá chào mua', skip: 'Để trống đơn giá những món không mua.',
    cost: 'Chi phí thanh lý / thu gom (nếu có, VND)', note: 'Ghi chú (thời gian tháo dỡ, vận chuyển…)',
    agree: 'Tôi xác nhận thông tin trên là đúng, đã xem tài sản thực tế và cam kết mua theo giá đã chào nếu được chọn.',
    files: 'Tệp đính kèm (thư báo giá đã ký, CCCD / giấy phép kinh doanh…)', upload: 'Tải lên', noFiles: 'Chưa có tệp nào.',
    save: 'Lưu nháp', submit: 'Nộp báo giá', saved: 'Đã lưu nháp.',
    submittedOk: 'Đã nộp báo giá. Báo giá được niêm phong cho tới khi Hội đồng thanh lý mở cùng lúc.',
    confirmSubmit: 'Nộp báo giá? Báo giá được niêm phong; trước hạn nộp vẫn sửa được nhưng phải nộp lại.',
    editWarn: 'Báo giá đã nộp. Nếu sửa, báo giá trở về nháp — nhớ bấm "Nộp báo giá" lại trước hạn.',
    notAccepting: 'Đợt này không còn nhận báo giá.', uploaded: 'Đã tải lên {n}.', tooBig: 'Tệp {n} lớn hơn 10 MB.', badType: 'Chỉ nhận PDF, ảnh JPG / PNG.',
    cond_Like: 'Nguyên phẩm', cond_Poor: 'Kém phẩm', cond_Damaged: 'Mất phẩm'
  },
  en: {
    title: 'Liquidation quotation', alt: 'Thư báo giá thanh lý', who: 'Buyer: {v} · link expires {d}', loading: 'Loading…',
    bad: 'This link is not valid or has expired. Please contact the hotel\'s Asset Management team.',
    noCfg: 'This link lacks its connection details. Open the exact link that was sent to you.',
    batch: 'Liquidation batch', deadline: 'Quotation deadline', status: 'Status', accepting: 'Accepting quotations', closed: 'Closed',
    terms: 'Instructions', mine: 'Your quotation', none: 'None yet', draft: 'Draft — not submitted', submitted: 'Submitted (sealed)',
    buyer: 'Buyer', person: 'Individual', company: 'Company', name_p: 'Full name', name_c: 'Company name', id_no: 'ID card number',
    tax_code: 'Tax code', rep: 'Representative', address: 'Address', phone: 'Phone', email_p: 'E-mail', email_c: 'Invoice e-mail',
    items: 'Items for sale', no: 'No.', item: 'Item', code: 'Asset code', qty: 'Qty', unit: 'Unit', cond: 'Condition',
    price: 'Offered unit price (VND)', amount: 'Amount', total: 'Total offered', skip: 'Leave the price empty for items you do not want.',
    cost: 'Liquidation / collection cost (if any, VND)', note: 'Note (dismantling, transport time…)',
    agree: 'I confirm the information above is correct, I have seen the items, and I commit to buy at the prices offered if selected.',
    files: 'Attachments (signed quotation letter, ID card / business licence…)', upload: 'Upload', noFiles: 'No files yet.',
    save: 'Save draft', submit: 'Submit quotation', saved: 'Draft saved.',
    submittedOk: 'Quotation submitted. It stays sealed until the liquidation council opens all quotations together.',
    confirmSubmit: 'Submit the quotation? It is sealed; before the deadline it can still be changed, but must then be submitted again.',
    editWarn: 'Submitted. Changing it takes it back to a draft — remember to submit again before the deadline.',
    notAccepting: 'This batch no longer accepts quotations.', uploaded: '{n} uploaded.', tooBig: 'File {n} is larger than 10 MB.', badType: 'Only PDF, JPG / PNG pictures.',
    cond_Like: 'Like new', cond_Poor: 'Poor', cond_Damaged: 'Damaged'
  }
};
let LANG = (() => { try { return localStorage.getItem('lqbid.lang') || 'vi'; } catch { return 'vi'; } })();
const t = (k, p = {}) => String((TX[LANG] || TX.vi)[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => p[n] ?? '');

const P = { url: '', key: '', token: '', s: null, d: null };
function readLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  let c = h.get('c'), tok = h.get('t');
  try { if (!c) c = sessionStorage.getItem('lqbid.c'); if (!tok) tok = sessionStorage.getItem('lqbid.t'); } catch {}
  if (c) { try { const o = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(c))))); P.url = String(o.url || '').replace(/\/+$/, ''); P.key = String(o.key || ''); } catch {} }
  P.token = tok || '';
  try { if (c) sessionStorage.setItem('lqbid.c', c); if (tok) sessionStorage.setItem('lqbid.t', tok); } catch {}
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
const msg = (kind, text) => { const b = $('#msg'); b.innerHTML = ''; if (text) { b.append(el('div', { className: 'msg ' + kind, textContent: text })); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
const num = v => {
  if (v == null || v === '') return null;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  const hasC = s.includes(','), hasD = s.includes('.');
  if (hasC && hasD) { const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.'; s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.'); }
  else if (hasC || hasD) { const m = hasC ? ',' : '.'; s = /^-?\d{1,3}([.,]\d{3})+$/.test(s) ? s.split(m).join('') : s.replace(m, '.'); }
  const n = Number(s); return isFinite(n) ? n : null;
};
const money = v => v == null || v === '' || !isFinite(v) ? '' : Math.round(Number(v)).toLocaleString('vi-VN');
const dt = s => { if (!s) return ''; const d = new Date(s), z = n => String(n).padStart(2, '0');
  return isNaN(d) ? String(s) : `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const condTxt = c => c === 'Like new' ? t('cond_Like') : c === 'Poor' ? t('cond_Poor') : c === 'Damaged' ? t('cond_Damaged') : (c || '');

async function load() {
  msg('info', t('loading'));
  try {
    P.s = await rpc('vq_session');
    const q = P.s.quote;
    P.d = Object.assign({ kind: 'person', name: '', id_no: '', tax_code: '', representative: '', address: '', phone: P.s.phone || '', email: P.s.email || '',
                          prices: {}, cost: null, note: '', agree: false }, JSON.parse(JSON.stringify((q && q.data) || {})));
    if (!q && !P.d.name) P.d.name = P.s.buyer || '';
    msg('', '');
    render();
  } catch (e) { $('#app').innerHTML = ''; msg('err', /28000|not valid|không hợp lệ/i.test(e.message) ? t('bad') : e.message); }
}

function render() {
  document.documentElement.lang = LANG;
  $('#hTitle').textContent = `${t('title')} / ${t('alt')}`;
  $('#hWho').textContent = P.s ? t('who', { v: P.s.buyer, d: dt(P.s.expires_at) }) : '';
  const app = $('#app'), s = P.s, d = P.d, q = s.quote, open = s.accepting;
  app.innerHTML = '';
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: `${t('batch')} ${s.batch}` }),
    el('dl', { className: 'kv' }, [
      el('dt', { textContent: t('deadline') }), el('dd', { textContent: dt(s.deadline) }),
      el('dt', { textContent: t('status') }), el('dd', {}, el('span', { className: 'chip ' + (open ? 'ok' : 'bad'), textContent: open ? t('accepting') : t('closed') })),
      el('dt', { textContent: t('mine') }), el('dd', { textContent: q ? `${t(q.status)}${q.submitted_at ? ' · ' + dt(q.submitted_at) : ''}` : t('none') })]),
    s.terms ? el('div', { style: 'margin-top:10px' }, [el('div', { className: 'dim', textContent: t('terms') }), el('div', { className: 'pre', textContent: s.terms })]) : '']));
  if (!open) app.append(el('div', { className: 'msg warn', textContent: t('notAccepting') }));
  else if (q && q.status === 'submitted') app.append(el('div', { className: 'msg info', textContent: t('editWarn') }));

  const inp = (k, opts = {}) => {
    const i = el(opts.area ? 'textarea' : 'input', { value: d[k] ?? '', disabled: !open });
    if (opts.num) { i.inputMode = 'decimal'; i.value = d[k] != null && d[k] !== '' ? money(d[k]) : ''; }
    i.onchange = () => { d[k] = opts.num ? num(i.value) : i.value.trim(); if (opts.redraw) render(); };
    return i;
  };
  const fld = (lbl, node) => el('div', { className: 'fld' }, [el('label', { textContent: lbl }), node]);
  const kind = el('div', { className: 'kind' }, ['person', 'company'].map(k => el('label', {}, [
    el('input', { type: 'radio', name: 'kind', checked: d.kind === k, disabled: !open, onchange: () => { d.kind = k; render(); } }), t(k)])));
  const co = d.kind === 'company';
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('buyer') }), kind,
    el('div', { className: 'row' }, [fld(t(co ? 'name_c' : 'name_p'), inp('name')), co ? fld(t('tax_code'), inp('tax_code')) : fld(t('id_no'), inp('id_no')),
      ...(co ? [fld(t('rep'), inp('representative'))] : [])]),
    el('div', { className: 'row', style: 'margin-top:8px' }, [fld(t('address'), inp('address')), fld(t('phone'), inp('phone')), fld(t(co ? 'email_c' : 'email_p'), inp('email'))])]));

  const tb = el('table');
  tb.append(el('tr', {}, [t('no'), t('item'), t('code'), t('qty'), t('unit'), t('cond'), t('price'), t('amount')].map((h, i) => el('th', { className: i === 3 || i >= 6 ? 'n' : '', textContent: h }))));
  let tot = 0;
  (s.items || []).forEach((it, i) => {
    const k = String(it.id), pr = Number(d.prices[k]) || 0, amt = pr * (Number(it.qty) || 0);
    tot += amt;
    const pi = el('input', { value: d.prices[k] != null && d.prices[k] !== '' ? money(d.prices[k]) : '', inputMode: 'decimal', disabled: !open });
    pi.onchange = () => { d.prices[k] = num(pi.value); setTimeout(render, 0); };
    tb.append(el('tr', {}, [el('td', { className: 'c', textContent: String(i + 1) }), el('td', { textContent: it.name }), el('td', { textContent: it.asset_code || 'N/A' }),
      el('td', { className: 'n', textContent: Number(it.qty).toLocaleString('vi-VN') }), el('td', { textContent: it.unit || '' }), el('td', { textContent: condTxt(it.condition) }),
      el('td', { className: 'n', style: 'width:170px' }, pi), el('td', { className: 'n', textContent: amt ? money(amt) : '' })]));
  });
  tb.append(el('tr', { className: 'tot' }, [el('td', { colSpan: 7, textContent: t('total') }), el('td', { className: 'n', textContent: money(tot) })]));
  app.append(el('div', { className: 'card' }, [el('h2', { textContent: t('items') }), el('div', { className: 'dim', style: 'margin-bottom:6px', textContent: t('skip') }),
    el('div', { className: 'wrap' }, tb),
    el('div', { className: 'row', style: 'margin-top:10px' }, [fld(t('cost'), inp('cost', { num: true })), fld(t('note'), inp('note', { area: true }))]),
    el('label', { className: 'agree' }, [el('input', { type: 'checkbox', checked: !!d.agree, disabled: !open, onchange: e => { d.agree = e.target.checked; } }), t('agree')])]));

  const files = (q && q.files) || [];
  const fileBox = el('div', { className: 'card' }, [el('h2', { textContent: t('files') }),
    el('ul', { className: 'files' }, files.length ? files.map(f => el('li', {}, [f.name || '', ` (${Math.round((f.size || 0) / 1024)} KB) `,
      open ? el('button', { className: 'btn tiny danger', type: 'button', textContent: '×', onclick: () => removeFile(f.path) }) : ''])) : [el('li', { className: 'dim', textContent: t('noFiles') })])]);
  if (open) {
    const pick = el('input', { type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none', onchange: () => addFiles([...pick.files]) });
    fileBox.append(el('div', { className: 'acts' }, [pick, el('button', { className: 'btn', type: 'button', textContent: t('upload'), onclick: () => pick.click() })]));
  }
  app.append(fileBox);
  if (open) app.append(el('div', { className: 'card' }, el('div', { className: 'acts' }, [
    el('button', { className: 'btn', type: 'button', textContent: t('save'), onclick: () => save() }),
    el('button', { className: 'btn pri', type: 'button', textContent: t('submit'), onclick: () => submit() })])));
}

async function save(quiet) {
  try { await rpc('vq_save', { p_data: P.d }); if (!quiet) { await load(); msg('ok', t('saved')); } return true; }
  catch (e) { msg('err', e.message); return false; }
}
async function submit() {
  if (!confirm(t('confirmSubmit'))) return;
  if (!(await save(true))) return;
  try { await rpc('vq_submit'); await load(); msg('ok', t('submittedOk')); } catch (e) { msg('err', e.message); }
}
async function addFiles(files) {
  if (!files.length) return;
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) return msg('err', t('tooBig', { n: f.name }));
    if (f.type && !/^(application\/pdf|image\/(png|jpeg))$/.test(f.type)) return msg('err', t('badType'));
  }
  if (!(await save(true))) return;
  try {
    const key = await rpc('vq_upload_key');
    for (const f of files) {
      const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
      const path = `${key}/${Date.now()}-${safe}`;
      const r = await fetch(`${P.url}/storage/v1/object/pm-lqbid/${path}`, { method: 'POST',
        headers: { apikey: P.key, Authorization: 'Bearer ' + P.key, 'Content-Type': f.type || 'application/octet-stream', 'x-upsert': 'false' }, body: f });
      if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
      await rpc('vq_file_add', { p_path: path, p_name: f.name, p_size: f.size });
    }
    await load();
    msg('ok', t('uploaded', { n: files.map(f => f.name).join(', ') }));
  } catch (e) { msg('err', e.message); }
}
async function removeFile(path) {
  try { await rpc('vq_file_remove', { p_path: path }); await load(); } catch (e) { msg('err', e.message); }
}

document.querySelectorAll('#lang button').forEach(b => {
  b.classList.toggle('on', b.dataset.l === LANG);
  b.onclick = () => { LANG = b.dataset.l; try { localStorage.setItem('lqbid.lang', LANG); } catch {}
    document.querySelectorAll('#lang button').forEach(x => x.classList.toggle('on', x.dataset.l === LANG));
    if (P.s) render(); };
});
readLink();
if (!P.url || !P.key || !P.token) msg('err', t('noCfg'));
else load();
