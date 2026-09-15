/* asset-intake — giao diện nội bộ (giai đoạn 1: master data + bộ đếm)
   Repo PUBLIC: không nhúng URL/key. Cấu hình lấy từ localStorage hoặc
   từ fragment #sbcfg=<base64> rồi xoá ngay khỏi thanh địa chỉ. */
'use strict';

/* ------------------------------------------------------------------ util */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};
const esc = s => String(s ?? '');
function msg(host, kind, text) {
  const box = typeof host === 'string' ? $(host) : host;
  box.innerHTML = '';
  if (text) box.append(el('div', { className: 'msg ' + kind, textContent: text }));
  return box;
}
const fmtInt = n => (n ?? 0).toLocaleString('vi-VN');

/* ---------------------------------------------------------------- config */
const LS_KEY = 'asset-intake.sb';
let CFG = { url: '', key: '' };

function loadCfg() {
  const m = /[#&]sbcfg=([^&]+)/.exec(location.hash);
  if (m) {
    try {
      const o = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
      if (o.url && o.key) {
        CFG = { url: String(o.url).replace(/\/+$/, ''), key: String(o.key) };
        localStorage.setItem(LS_KEY, JSON.stringify(CFG));
      }
    } catch (e) { console.warn('sbcfg hỏng', e); }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!CFG.url) {
    try { Object.assign(CFG, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch {}
  }
  $('#sbUrl').value = CFG.url || '';
  $('#sbKey').value = CFG.key || '';
}

function setConn(ok, text) {
  $('#dot').classList.toggle('on', !!ok);
  $('#connTxt').textContent = text;
}

/* ------------------------------------------------------------------- SB */
const SB = {
  ready: () => !!(CFG.url && CFG.key),
  hdr(extra = {}) {
    return Object.assign({
      apikey: CFG.key,
      Authorization: 'Bearer ' + CFG.key,
      'Content-Type': 'application/json'
    }, extra);
  },
  async call(path, opts = {}) {
    if (!SB.ready()) throw new Error('Chưa cấu hình Supabase — vào tab “Kết nối”.');
    const res = await fetch(CFG.url + '/rest/v1/' + path, opts);
    const raw = await res.text();
    let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    if (!res.ok) {
      const d = body && typeof body === 'object'
        ? [body.message, body.details, body.hint].filter(Boolean).join(' — ')
        : String(body || res.statusText);
      throw new Error(`${res.status} ${d}`);
    }
    return { body, range: res.headers.get('content-range') };
  },
  async select(table, query = '') {
    const { body } = await SB.call(`${table}?${query || 'select=*'}`, { headers: SB.hdr() });
    return body || [];
  },
  async count(table) {
    const { range } = await SB.call(`${table}?select=*&limit=0`,
      { headers: SB.hdr({ Prefer: 'count=exact' }) });
    return Number(String(range || '').split('/')[1] ?? NaN);
  },
  async insert(table, rows) {
    return (await SB.call(table, {
      method: 'POST', headers: SB.hdr({ Prefer: 'return=representation' }),
      body: JSON.stringify(rows)
    })).body;
  },
  async patch(table, filter, patch) {
    return (await SB.call(`${table}?${filter}`, {
      method: 'PATCH', headers: SB.hdr({ Prefer: 'return=representation' }),
      body: JSON.stringify(patch)
    })).body;
  },
  async remove(table, filter) {
    await SB.call(`${table}?${filter}`, { method: 'DELETE', headers: SB.hdr() });
  },
  async rpc(fn, args = {}) {
    return (await SB.call('rpc/' + fn,
      { method: 'POST', headers: SB.hdr(), body: JSON.stringify(args) })).body;
  }
};

/* --------------------------------------------------------- mô tả bảng */
const T = (name, val) => ({ name, ...val });
const TABLES = {
  am_org: {
    label: 'Đơn vị / Phòng ban', pk: 'code', order: 'level,code',
    sub: 'Danh sách phẳng 4 cấp. Một mã có thể vừa là công ty thành viên (is_company) vừa đứng ở vị trí #1 của Mã Tài Sản (is_department) — ví dụ CEN, SOF.',
    cols: [
      T('code', { w: 80 }), T('name_vi', { w: 300 }), T('name_en', { w: 260 }),
      T('level', { type: 'select', opts: ['TCT', 'BRANCH', 'DEPT1', 'DEPT2'], w: 100 }),
      T('is_company', { type: 'bool' }), T('is_department', { type: 'bool' }),
      T('parent_code', { type: 'ref', ref: 'am_org', w: 110 }),
      T('active', { type: 'bool' }), T('note', { w: 320 })
    ]
  },
  am_org_alias: {
    label: 'Bí danh phòng ban', pk: 'alias', order: 'alias',
    sub: 'Dữ liệu gốc không nhất quán (HKD/HKP, ITD/IT, SEC/Security). Bảng này để import file cũ không vỡ; mã chuẩn vẫn chỉ có một.',
    cols: [T('alias', { w: 120 }), T('code', { type: 'ref', ref: 'am_org', w: 110 }),
           T('source', { w: 420 })]
  },
  am_category_group: {
    label: 'Nhóm tài sản (mã cha)', pk: 'code', order: 'sort_order',
    sub: 'Mã cha kế toán. is_tools = CCDC (C242x), is_intangible = vô hình (C213x).',
    cols: [T('code', { w: 80 }), T('name_vi', { w: 340 }), T('name_en', { w: 300 }),
           T('is_intangible', { type: 'bool' }), T('is_tools', { type: 'bool' }),
           T('sort_order', { type: 'int', w: 80 })]
  },
  am_category: {
    label: 'Mã danh mục (mã loại)', pk: 'code', order: 'group_code,code',
    sub: 'label_letters = code sau khi bỏ hậu tố -QR. LTG và LTG-QR cùng ra "LTG" nên dùng CHUNG một dãy số thứ tự.',
    cols: [T('code', { w: 90 }), T('group_code', { type: 'ref', ref: 'am_category_group', w: 100 }),
           T('name_vi', { w: 300 }), T('name_en', { w: 280 }),
           T('label_letters', { w: 100 }),
           T('manage_by', { type: 'select', opts: ['code', 'quantity'], w: 110 }),
           T('active', { type: 'bool' }), T('note', { w: 340 })]
  },
  am_unit: {
    label: 'Đơn vị tính', pk: 'code', order: 'sort_order',
    cols: [T('code', { w: 100 }), T('name_vi', { w: 160 }), T('name_en', { w: 160 }),
           T('sort_order', { type: 'int', w: 90 })]
  },
  am_origin: {
    label: 'Xuất xứ (ISO 3166-1)', pk: 'iso2', order: 'iso2',
    sub: 'Danh sách phải ĐẦY ĐỦ thì quy tắc “chỉ gán mã khi khớp đúng một quốc gia có thật” mới đúng — thiếu nước nào là nước đó bị xếp nhầm.',
    cols: [T('iso2', { w: 70 }), T('name_en', { w: 320 }), T('name_vi', { w: 260 })]
  },
  am_origin_alias: {
    label: 'Bí danh xuất xứ', pk: 'alias_norm', order: 'alias_norm',
    sub: 'CHỈ thêm khi chuỗi chỉ đích danh MỘT quốc gia. alias_norm phải viết thường, bỏ dấu.',
    cols: [T('alias_norm', { w: 220 }), T('iso2', { type: 'ref', ref: 'am_origin', w: 90 }),
           T('note', { w: 340 })]
  },
  am_origin_rejected: {
    label: 'Xuất xứ cố ý bỏ trống', pk: 'raw_norm', order: 'raw_norm',
    sub: 'Giữ lại để giao diện giải thích “vì sao bỏ trống” thay vì im lặng.',
    cols: [T('raw_norm', { w: 220 }), T('raw_sample', { w: 220 }),
           T('reason', { type: 'select', opts: ['multi_country', 'not_a_country', 'unknown'], w: 150 }),
           T('seen_count', { type: 'int', w: 90 })]
  },
  am_location: {
    label: 'Vị trí', pk: 'code', order: 'code',
    sub: 'Cây Toà nhà → Tầng → Phòng. Mỗi phòng ban chỉ được có ĐÚNG MỘT vị trí is_dept_office (database ép bằng unique index).',
    cols: [T('code', { w: 110 }), T('name', { w: 330 }),
           T('kind', { type: 'select', opts: ['building', 'floor', 'room', 'area'], w: 110 }),
           T('parent_code', { type: 'ref', ref: 'am_location', w: 110 }),
           T('dept_code', { type: 'ref', ref: 'am_org', w: 110 }),
           T('is_dept_office', { type: 'bool' }), T('active', { type: 'bool' })]
  },
  am_product: {
    label: 'Product catalogue', pk: 'id', auto: true, order: 'std_name_vi',
    sub: 'Tên gốc nhà cung cấp → tên chuẩn hoá → mã danh mục mặc định. raw_name_norm là khoá so khớp: viết thường, bỏ dấu, gộp khoảng trắng.',
    cols: [T('raw_name', { w: 300 }), T('raw_name_norm', { w: 300 }),
           T('std_name_vi', { w: 260 }), T('std_name_en', { w: 240 }),
           T('default_category', { type: 'ref', ref: 'am_category', w: 120 }),
           T('default_unit', { type: 'ref', ref: 'am_unit', w: 110 }),
           T('default_brand', { w: 150 }), T('hint_intangible', { type: 'bool' }),
           T('times_used', { type: 'int', w: 90 })]
  },
  am_setting: {
    label: 'Cấu hình ngưỡng', pk: 'key', order: 'key',
    sub: 'unique_threshold = 5.000.000 (ngưỡng Unique asset). capex_threshold = 30.000.000 (ngưỡng cấm mã CCDC). Giá trị là JSON.',
    cols: [T('key', { w: 180 }), T('value', { w: 180 }), T('note', { w: 520 })]
  }
};

/* --------------------------------------------------------- lookup cache */
const LOOK = {};
async function lookup(table) {
  if (LOOK[table]) return LOOK[table];
  const pk = TABLES[table].pk;
  const lab = TABLES[table].cols.find(c => /^name_vi$|^name$|^name_en$/.test(c.name));
  const sel = lab ? `${pk},${lab.name}` : pk;
  const rows = await SB.select(table, `select=${sel}&order=${pk}`);
  LOOK[table] = rows.map(r => ({ v: r[pk], t: lab ? `${r[pk]} — ${r[lab.name] ?? ''}` : r[pk] }));
  return LOOK[table];
}

/* ------------------------------------------------------------ data grid */
let CUR = null;        // { table, rows:[{orig,cur,isNew,del}] }

function cellInput(col, row, onChange) {
  const v = row.cur[col.name];
  if (col.type === 'bool') {
    const i = el('input', { type: 'checkbox', checked: !!v });
    i.onchange = () => onChange(col.name, i.checked);
    return i;
  }
  if (col.type === 'select' || col.type === 'ref') {
    const s = el('select');
    s.append(el('option', { value: '', textContent: '—' }));
    const fill = list => {
      for (const o of list) {
        const t = typeof o === 'string' ? o : o.t, val = typeof o === 'string' ? o : o.v;
        s.append(el('option', { value: val, textContent: t, selected: String(val) === String(v ?? '') }));
      }
      if (v != null && v !== '' && !list.some(o => String(typeof o === 'string' ? o : o.v) === String(v)))
        s.append(el('option', { value: v, textContent: v + ' (không có trong danh mục)', selected: true }));
    };
    if (col.type === 'select') fill(col.opts);
    else lookup(col.ref).then(fill).catch(() => fill([]));
    s.onchange = () => onChange(col.name, s.value || null);
    return s;
  }
  const i = el('input', {
    type: col.type === 'int' ? 'number' : 'text',
    value: v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v),
    style: `width:${col.w || 140}px`
  });
  i.onchange = () => {
    let nv = i.value === '' ? null : i.value;
    if (col.type === 'int' && nv != null) nv = Number(nv);
    onChange(col.name, nv);
  };
  return i;
}

function renderGrid() {
  const spec = TABLES[CUR.table];
  const head = $('#grid thead'), body = $('#grid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  const hr = el('tr');
  hr.append(el('th', { textContent: '' }));
  for (const c of spec.cols) hr.append(el('th', { textContent: c.name }));
  head.append(hr);

  const q = $('#filter').value.trim().toLowerCase();
  let shown = 0;
  for (const row of CUR.rows) {
    if (row.del) continue;
    if (q && !JSON.stringify(row.cur).toLowerCase().includes(q)) continue;
    shown++;
    const tr = el('tr');
    if (row.isNew) tr.classList.add('new');
    else if (row.dirty) tr.classList.add('dirty');
    const del = el('button', { className: 'mini', textContent: '✕', title: 'Xoá dòng' });
    del.onclick = () => {
      if (row.isNew) CUR.rows.splice(CUR.rows.indexOf(row), 1);
      else if (confirm(`Xoá ${row.cur[spec.pk]}?`)) row.del = true;
      else return;
      dirtyCheck(); renderGrid();
    };
    tr.append(el('td', {}, del));
    for (const c of spec.cols) {
      const td = el('td');
      td.append(cellInput(c, row, (field, val) => {
        row.cur[field] = val;
        row.dirty = row.isNew || spec.cols.some(k => row.cur[k.name] !== row.orig?.[k.name]);
        tr.classList.toggle('dirty', !row.isNew && !!row.dirty);
        dirtyCheck();
      }));
      tr.append(td);
    }
    body.append(tr);
  }
  $('#dataTitle').textContent = spec.label;
  $('#dataSub').textContent = spec.sub || '';
  if (!shown) body.append(el('tr', {}, el('td', {
    colSpan: spec.cols.length + 1,
    textContent: q ? 'Không có dòng nào khớp bộ lọc.' : 'Bảng trống.',
    style: 'color:var(--dim);padding:14px'
  })));
}

function dirtyCheck() {
  const n = CUR.rows.filter(r => r.isNew || r.dirty || r.del).length;
  $('#btnCommit').disabled = !n;
  $('#btnCommit').textContent = n ? `Lưu ${n} thay đổi` : 'Lưu thay đổi';
}

async function loadTable(name) {
  CUR = { table: name, rows: [] };
  msg('#dataMsg', 'info', 'Đang tải…');
  try {
    const spec = TABLES[name];
    const rows = await SB.select(name, `select=*&order=${spec.order || spec.pk}`);
    CUR.rows = rows.map(r => ({ orig: { ...r }, cur: { ...r }, isNew: false }));
    msg('#dataMsg', '', '');
  } catch (e) { msg('#dataMsg', 'err', e.message); }
  dirtyCheck(); renderGrid();
}

async function commit() {
  const spec = TABLES[CUR.table], pk = spec.pk;
  const news = CUR.rows.filter(r => r.isNew && !r.del);
  const upds = CUR.rows.filter(r => !r.isNew && r.dirty && !r.del);
  const dels = CUR.rows.filter(r => r.del && !r.isNew);
  let done = 0;
  msg('#dataMsg', 'info', 'Đang ghi…');
  try {
    for (const r of dels) {
      await SB.remove(CUR.table, `${pk}=eq.${encodeURIComponent(r.orig[pk])}`); done++;
    }
    for (const r of upds) {
      const patch = {};
      for (const c of spec.cols)
        if (r.cur[c.name] !== r.orig[c.name]) patch[c.name] = r.cur[c.name];
      await SB.patch(CUR.table, `${pk}=eq.${encodeURIComponent(r.orig[pk])}`, patch); done++;
    }
    if (news.length) {
      const payload = news.map(r => {
        const o = {};
        for (const c of spec.cols) if (r.cur[c.name] != null && r.cur[c.name] !== '') o[c.name] = r.cur[c.name];
        return o;
      });
      await SB.insert(CUR.table, payload); done += news.length;
    }
    delete LOOK[CUR.table];
    await loadTable(CUR.table);
    msg('#dataMsg', 'ok', `Đã ghi ${done} thay đổi.`);
  } catch (e) {
    msg('#dataMsg', 'err', `Ghi thất bại sau ${done} thay đổi: ${e.message}\n` +
        'Các thay đổi chưa ghi vẫn còn trên màn hình.');
  }
}

/* ------------------------------------------------------------- bộ đếm */
const RE_ASSET = /\b([A-Z]{2,5})\.(C2\d{3})\.([A-Z]{3})\.(\d{4})\.(\d{5})\b/g;
const RE_BAR   = /\bJVC\.(\d{9})\b/g;
let SEED = null;

function scanText(text, acc) {
  let m;
  RE_ASSET.lastIndex = 0;
  while ((m = RE_ASSET.exec(text))) {
    const key = m[1] + '|' + m[3], seq = Number(m[5]);
    const cur = acc.asset.get(key);
    if (!cur || seq > cur.seq) acc.asset.set(key, { seq, code: m[0], groups: new Set() });
    acc.asset.get(key).groups.add(m[2]);
    acc.nAsset++;
  }
  RE_BAR.lastIndex = 0;
  while ((m = RE_BAR.exec(text))) {
    const d = m[1], kind = d[0] === '9' ? 'low' : 'unique';
    const val = kind === 'low' ? Number(d.slice(1)) : Number(d);
    const cur = acc.bar.get(kind);
    if (!cur || val > cur.val) acc.bar.set(kind, { val, code: m[0] });
    acc.nBar++;
  }
}

async function scanSeed() {
  const out = $('#seedOut');
  const acc = { asset: new Map(), bar: new Map(), nAsset: 0, nBar: 0, files: [] };
  msg(out, 'info', 'Đang quét…');
  try {
    if ($('#seedText').value.trim()) scanText($('#seedText').value.toUpperCase(), acc);
    for (const f of ($('#seedFile').files || [])) {
      if (f.size > 40 * 1024 * 1024) {
        acc.files.push(`${f.name} — BỎ QUA, ${(f.size / 1048576) | 0} MB quá lớn cho trình duyệt`);
        continue;
      }
      const buf = await f.arrayBuffer();
      if (/\.(xlsx|xlsm)$/i.test(f.name)) {
        const wb = XLSX.read(buf, { type: 'array' });
        for (const s of wb.SheetNames)
          scanText(XLSX.utils.sheet_to_csv(wb.Sheets[s]).toUpperCase(), acc);
        acc.files.push(`${f.name} — ${wb.SheetNames.length} sheet`);
      } else {
        scanText(new TextDecoder().decode(buf).toUpperCase(), acc);
        acc.files.push(`${f.name} — text`);
      }
    }
  } catch (e) { return msg(out, 'err', 'Quét lỗi: ' + e.message); }

  SEED = acc;
  out.innerHTML = '';
  if (!acc.asset.size && !acc.bar.size) {
    $('#btnSeed').disabled = true;
    return msg(out, 'warn', 'Không tìm thấy mã nào đúng định dạng.\n' +
      'Mã Tài Sản: DEPT.C2xxx.LLL.YYYY.NNNNN — Mã Vạch: JVC.+9 chữ số');
  }
  if (acc.files.length)
    out.append(el('div', { className: 'hint', textContent: acc.files.join(' · ') }));
  out.append(el('div', { className: 'msg info', textContent:
    `Tìm thấy ${fmtInt(acc.nAsset)} Mã Tài Sản (${acc.asset.size} khoá) và ` +
    `${fmtInt(acc.nBar)} Mã Vạch. Chỉ gửi lên server số LỚN NHẤT của mỗi khoá.` }));

  const tb = el('table');
  tb.append(el('tr', {}, ['Khoá', 'Loại', 'Max', 'Mã đại diện', 'Nhóm cha đã thấy']
    .map(h => el('th', { textContent: h }))));
  for (const [k, v] of [...acc.asset].sort((a, b) => a[0].localeCompare(b[0])))
    tb.append(el('tr', {}, [
      el('td', {}, el('code', { textContent: k })),
      el('td', { textContent: 'Mã Tài Sản' }),
      el('td', { className: 'num', textContent: fmtInt(v.seq) }),
      el('td', {}, el('code', { textContent: v.code })),
      el('td', { textContent: [...v.groups].join(', '),
                 style: v.groups.size > 1 ? 'color:var(--warn);font-weight:600' : '' })
    ]));
  for (const [k, v] of acc.bar)
    tb.append(el('tr', {}, [
      el('td', {}, el('code', { textContent: k })),
      el('td', { textContent: 'Mã Vạch' }),
      el('td', { className: 'num', textContent: fmtInt(v.val) }),
      el('td', {}, el('code', { textContent: v.code })),
      el('td', { textContent: '' })
    ]));
  out.append(el('div', { className: 'wrap' }, tb));
  const multi = [...acc.asset.values()].filter(v => v.groups.size > 1).length;
  if (multi) out.append(el('div', { className: 'msg warn', textContent:
    `${multi} khoá dùng chung dãy số dưới NHIỀU mã nhóm cha (đánh dấu vàng). ` +
    'Đây chính là lý do bộ đếm khoá theo (phòng ban, chữ) chứ không kèm nhóm cha.' }));
  $('#btnSeed').disabled = false;
}

async function runSeed() {
  if (!SEED) return;
  const codes = [...[...SEED.asset.values()].map(v => v.code),
                 ...[...SEED.bar.values()].map(v => v.code)];
  const out = $('#seedOut');
  try {
    $('#btnSeed').disabled = true;
    const res = await SB.rpc('am_seed_from_codes', { p_codes: codes });
    const tb = el('table');
    tb.append(el('tr', {}, ['Khoá', 'Bộ đếm', 'Max đã thấy', 'Số sẽ cấp tiếp theo']
      .map(h => el('th', { textContent: h }))));
    for (const r of res || [])
      tb.append(el('tr', {}, [
        el('td', {}, el('code', { textContent: r.scope })),
        el('td', { textContent: r.kind }),
        el('td', { className: 'num', textContent: fmtInt(r.max_seen) }),
        el('td', { className: 'num', textContent: fmtInt(r.next_val) })
      ]));
    out.innerHTML = '';
    out.append(el('div', { className: 'msg ok', textContent:
      `Đã nạp ${(res || []).length} bộ đếm từ ${codes.length} mã đại diện. ` +
      'Bộ đếm chỉ được nâng, không bao giờ hạ — chạy lại vô hại.' }));
    out.append(el('div', { className: 'wrap' }, tb));
    await loadCounters();
  } catch (e) {
    msg(out, 'err', 'Nạp thất bại: ' + e.message);
    $('#btnSeed').disabled = false;
  }
}

async function loadCounters() {
  const out = $('#cntOut');
  msg(out, 'info', 'Đang tải…');
  try {
    const [seqs, bars, log] = await Promise.all([
      SB.select('am_asset_seq', 'select=*&order=dept_code,letters'),
      SB.select('am_barcode_seq', 'select=*&order=kind'),
      SB.select('am_counter_log', 'select=*&order=created_at.desc&limit=25')
    ]);
    out.innerHTML = '';
    const stat = el('div', { className: 'stat' });
    for (const b of bars) {
      const next = b.kind === 'low'
        ? 'JVC.9' + String(b.next_val).padStart(8, '0')
        : 'JVC.' + String(b.next_val).padStart(9, '0');
      stat.append(el('div', {}, [
        el('b', { textContent: next }),
        el('span', { textContent: `mã vạch kế tiếp — dải ${b.kind} (còn ${fmtInt(b.max_val - b.next_val + 1)})` })
      ]));
    }
    stat.append(el('div', {}, [el('b', { textContent: fmtInt(seqs.length) }),
      el('span', { textContent: 'khoá (phòng ban × chữ) đang có' })]));
    out.append(stat);

    if (seqs.length) {
      const tb = el('table');
      tb.append(el('tr', {}, ['Phòng ban', 'Chữ', 'Số kế tiếp', 'Cập nhật']
        .map(h => el('th', { textContent: h }))));
      for (const s of seqs)
        tb.append(el('tr', {}, [
          el('td', {}, el('code', { textContent: s.dept_code })),
          el('td', {}, el('code', { textContent: s.letters })),
          el('td', { className: 'num', textContent: String(s.next_seq).padStart(5, '0') }),
          el('td', { textContent: (s.updated_at || '').slice(0, 19).replace('T', ' ') })
        ]));
      out.append(el('div', { className: 'wrap' }, tb));
    } else {
      out.append(el('div', { className: 'msg warn', textContent:
        'Chưa có khoá nào. Phải nạp bộ đếm từ sổ tài sản cũ TRƯỚC khi cấp mã cho đợt hàng đầu tiên.' }));
    }

    if (log.length) {
      const d = el('details');
      d.append(el('summary', { textContent: `Nhật ký cấp phát — ${log.length} lần gần nhất` }));
      const tb = el('table');
      tb.append(el('tr', {}, ['Lúc', 'Bộ đếm', 'Phạm vi', 'Từ', 'Đến', 'SL', 'Người']
        .map(h => el('th', { textContent: h }))));
      for (const r of log)
        tb.append(el('tr', {}, [
          el('td', { textContent: (r.created_at || '').slice(0, 19).replace('T', ' ') }),
          el('td', { textContent: r.counter }),
          el('td', {}, el('code', { textContent: r.scope })),
          el('td', { className: 'num', textContent: fmtInt(r.from_val) }),
          el('td', { className: 'num', textContent: fmtInt(r.to_val) }),
          el('td', { className: 'num', textContent: fmtInt(r.qty) }),
          el('td', { textContent: r.actor || '' })
        ]));
      d.append(el('div', { className: 'wrap' }, tb));
      out.append(d);
    }
  } catch (e) { msg(out, 'err', e.message); }
}

async function runAudit() {
  const out = $('#cntOut');
  try {
    const res = await SB.rpc('am_audit_counters');
    const bad = (res || []).filter(r => r.gap < 0);
    const box = el('div');
    box.append(el('div', {
      className: 'msg ' + (bad.length ? 'err' : 'ok'),
      textContent: bad.length
        ? `${bad.length} khoá có bộ đếm THẤP HƠN số lớn nhất trong sổ tài sản — sẽ cấp trùng mã. Phải nạp lại bộ đếm.`
        : `Đối chiếu ${(res || []).length} khoá: bộ đếm luôn lớn hơn số đã dùng. Không có nguy cơ trùng mã.`
    }));
    const rows = bad.length ? bad : (res || []);
    if (rows.length) {
      const tb = el('table');
      tb.append(el('tr', {}, ['Khoá', 'Bộ đếm kế tiếp', 'Max trong sổ', 'Khoảng trống']
        .map(h => el('th', { textContent: h }))));
      for (const r of rows)
        tb.append(el('tr', {}, [
          el('td', {}, el('code', { textContent: r.scope })),
          el('td', { className: 'num', textContent: fmtInt(r.counter_next) }),
          el('td', { className: 'num', textContent: fmtInt(r.table_max) }),
          el('td', { className: 'num', textContent: fmtInt(r.gap),
                     style: r.gap < 0 ? 'color:var(--err);font-weight:700' : '' })
        ]));
      box.append(el('div', { className: 'wrap' }, tb));
    }
    out.innerHTML = ''; out.append(box);
  } catch (e) { msg(out, 'err', e.message); }
}

/* -------------------------------------------------------------- rules */
async function fillPickers() {
  try {
    const cats = await SB.select('am_category', 'select=code,group_code,label_letters,name_vi&order=code');
    const orgs = await SB.select('am_org', 'select=code,name_vi&is_department=is.true&order=code');
    for (const id of ['#rcCat', '#pvCat']) {
      const s = $(id); s.innerHTML = '';
      for (const c of cats)
        s.append(el('option', { value: c.code, textContent: `${c.code} — ${c.name_vi}` }));
      if (id === '#rcCat') s.value = 'LTU';
    }
    const d = $('#pvDept'); d.innerHTML = '';
    for (const o of orgs) d.append(el('option', { value: o.code, textContent: o.code }));
    window.__CATS = cats;
  } catch (e) { /* tab Kết nối sẽ báo */ }
}

async function doClassify() {
  const out = $('#rcOut');
  try {
    const r = (await SB.rpc('am_classify', {
      p_unit_price: Number($('#rcPrice').value),
      p_category_code: $('#rcCat').value,
      p_is_intangible: $('#rcIntan').value === 'true'
    }))[0];
    out.innerHTML = '';
    out.append(el('div', { className: 'msg ' + (r.violates_capex ? 'err' : 'ok'), textContent:
      `Loại tài sản: ${r.asset_kind === 'unique' ? 'UNIQUE ASSET (mỗi đơn vị 1 dòng, Số Lượng = 1)'
                                                 : 'LOW-VALUE ASSET (gộp theo số lượng)'}` +
      (r.violates_capex ? '\n⛔ VI PHẠM: không được dùng mã CCDC ở mức giá này.' : '') +
      (r.suggested_category ? `\n→ Mã đề xuất: ${r.suggested_category}` : '') }));
    for (const w of r.warnings || [])
      out.append(el('div', { className: 'msg warn', textContent: w }));
  } catch (e) { msg(out, 'err', e.message); }
}

async function doOrigin() {
  const out = $('#orOut');
  try {
    const r = (await SB.rpc('am_resolve_origin', { p_raw: $('#orRaw').value }))[0];
    const why = {
      exact: 'khớp đúng tên quốc gia', alias: 'khớp qua bí danh',
      multi_country: 'chuỗi liệt kê nhiều quốc gia', not_a_country: 'không phải tên quốc gia hợp lệ',
      ambiguous: 'khớp nhiều quốc gia', empty: 'để trống'
    }[r.reason] || r.reason;
    msg(out, r.iso2 ? 'ok' : 'warn', r.iso2
      ? `Mã xuất xứ: ${r.iso2}  (${why})`
      : `Bỏ trống CẢ mã lẫn tên — ${why}.\nKhông giữ text gốc, không tự chọn đại diện một quốc gia.`);
  } catch (e) { msg(out, 'err', e.message); }
}

async function doPreview() {
  const out = $('#pvOut');
  try {
    const cat = (window.__CATS || []).find(c => c.code === $('#pvCat').value);
    if (!cat) return msg(out, 'err', 'Chưa tải được danh mục.');
    const code = await SB.rpc('am_build_asset_code', {
      p_dept: $('#pvDept').value, p_group: cat.group_code,
      p_letters: cat.label_letters, p_year: Number($('#pvYear').value),
      p_seq: Number($('#pvSeq').value)
    });
    const qr = cat.code !== cat.label_letters;
    msg(out, 'ok', `Mã Tài Sản: ${code}` + (qr
      ? `\n\nMã danh mục "${cat.code}" có hậu tố -QR nên phần chữ hiển thị là "${cat.label_letters}".`
        + ` Vì vậy ${cat.code} và ${cat.label_letters} BẮT BUỘC dùng chung một dãy số — khoá bộ đếm là`
        + ` (${$('#pvDept').value}, ${cat.label_letters}).`
      : `\n\nKhoá bộ đếm: (${$('#pvDept').value}, ${cat.label_letters}) — không kèm nhóm cha, không kèm năm.`));
  } catch (e) { msg(out, 'err', e.message); }
}

/* ---------------------------------------------------------------- tabs */
const TABS = [
  ['t-setup', 'Kết nối'], ['t-data', 'Master data'],
  ['t-counter', 'Bộ đếm'], ['t-rules', 'Thử quy tắc']
];
function setDataHeader(name) {
  const spec = TABLES[name];
  $('#dataTitle').textContent = spec.label;
  $('#dataSub').textContent = spec.sub || '';
}
function showTab(id) {
  $$('section').forEach(s => s.classList.toggle('on', s.id === id));
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  if (id === 't-data') {
    const name = $('#tablePick').value;
    setDataHeader(name);
    if (!CUR) loadTable(name);
  }
  if (id === 't-counter' && SB.ready()) loadCounters();
  if (id === 't-rules' && SB.ready()) fillPickers();
}

/* ------------------------------------------------------------- connect */
async function testConn(quiet) {
  if (!SB.ready()) { setConn(false, 'chưa kết nối'); return false; }
  try {
    await SB.select('am_setting', 'select=key&limit=1');
    setConn(true, new URL(CFG.url).hostname);
    if (!quiet) msg('#setupMsg', 'ok', 'Kết nối được, bảng am_setting đã tồn tại.');
    return true;
  } catch (e) {
    setConn(false, 'lỗi kết nối');
    if (!quiet) msg('#setupMsg', 'err', e.message +
      '\nNếu báo không tìm thấy bảng: chạy các file trong sql/ theo đúng thứ tự.');
    return false;
  }
}

async function checkSchema() {
  const out = $('#checkOut');
  msg(out, 'info', 'Đang đếm…');
  const extra = ['am_asset_seq', 'am_barcode_seq', 'am_counter_log', 'am_shipment',
                 'am_shipment_line', 'am_asset', 'am_alr', 'am_xls_template'];
  const names = [...Object.keys(TABLES), ...extra];
  const tb = el('table');
  tb.append(el('tr', {}, ['Bảng', 'Số dòng'].map(h => el('th', { textContent: h }))));
  let bad = 0;
  for (const n of names) {
    let txt, style = '';
    try { txt = fmtInt(await SB.count(n)); }
    catch (e) { txt = 'KHÔNG CÓ'; style = 'color:var(--err);font-weight:600'; bad++; }
    tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: n })),
                            el('td', { className: 'num', textContent: txt, style })]));
  }
  out.innerHTML = '';
  out.append(el('div', { className: 'msg ' + (bad ? 'err' : 'ok'), textContent: bad
    ? `${bad} bảng chưa tồn tại — chạy lại các file sql/ theo thứ tự 01 → 02 → 02b → 02c → 03 → 04.`
    : 'Đủ cả 22 bảng. Kiểm tra số dòng master data bên dưới.' }));
  out.append(el('div', { className: 'wrap' }, tb));
  const fns = ['am_audit_counters'];
  for (const f of fns) {
    try { await SB.rpc(f); }
    catch (e) { out.append(el('div', { className: 'msg err',
      textContent: `Hàm ${f}() gọi không được: ${e.message} — kiểm tra 03_functions.sql và 04_rls.sql.` })); }
  }
}

/* ---------------------------------------------------------------- init */
function init() {
  const nav = $('#tabs');
  for (const [id, label] of TABS) {
    const b = el('button', { textContent: label });
    b.dataset.id = id; b.onclick = () => showTab(id);
    nav.append(b);
  }
  const pick = $('#tablePick');
  for (const [k, v] of Object.entries(TABLES))
    pick.append(el('option', { value: k, textContent: v.label }));
  pick.onchange = () => {
    const n = CUR?.rows.filter(r => r.isNew || r.dirty || r.del).length || 0;
    if (n && !confirm(`${n} thay đổi chưa lưu sẽ mất. Vẫn đổi bảng?`)) {
      pick.value = CUR.table; return;
    }
    setDataHeader(pick.value); loadTable(pick.value);
  };

  $('#btnSave').onclick = async () => {
    CFG = { url: $('#sbUrl').value.trim().replace(/\/+$/, ''), key: $('#sbKey').value.trim() };
    localStorage.setItem(LS_KEY, JSON.stringify(CFG));
    Object.keys(LOOK).forEach(k => delete LOOK[k]);
    if (await testConn()) { fillPickers(); }
  };
  $('#btnLink').onclick = () => {
    if (!SB.ready()) return msg('#setupMsg', 'err', 'Nhập URL và key trước đã.');
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(CFG))));
    const link = location.origin + location.pathname + '#sbcfg=' + encodeURIComponent(b64);
    navigator.clipboard?.writeText(link).catch(() => {});
    msg('#setupMsg', 'ok', 'Đã chép link vào clipboard:\n' + link +
      '\n\nGửi riêng cho người cần dùng — đừng đăng công khai, đừng commit vào repo.');
  };
  $('#btnForget').onclick = () => {
    localStorage.removeItem(LS_KEY); CFG = { url: '', key: '' };
    $('#sbUrl').value = ''; $('#sbKey').value = '';
    setConn(false, 'chưa kết nối');
    msg('#setupMsg', 'ok', 'Đã xoá cấu hình khỏi máy này.');
  };
  $('#btnCheck').onclick = checkSchema;

  $('#btnReload').onclick = () => loadTable(pick.value);
  $('#filter').oninput = () => renderGrid();
  $('#btnAdd').onclick = () => {
    const spec = TABLES[CUR?.table || pick.value];
    if (!CUR) CUR = { table: pick.value, rows: [] };
    const blank = {};
    for (const c of spec.cols) blank[c.name] = c.type === 'bool' ? false : null;
    CUR.rows.unshift({ orig: null, cur: blank, isNew: true });
    dirtyCheck(); renderGrid();
  };
  $('#btnCommit').onclick = commit;

  $('#btnCnt').onclick = loadCounters;
  $('#btnAudit').onclick = runAudit;
  $('#btnScan').onclick = scanSeed;
  $('#btnSeed').onclick = runSeed;

  $('#btnClassify').onclick = doClassify;
  $('#btnOrigin').onclick = doOrigin;
  $('#btnPreview').onclick = doPreview;

  loadCfg();
  showTab('t-setup');
  testConn(true).then(ok => {
    if (ok) { showTab('t-data'); loadTable(pick.value); fillPickers(); }
  });
}
document.addEventListener('DOMContentLoaded', init);
