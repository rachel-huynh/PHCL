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
    const del = el('button', { className: 'xbtn', textContent: '✕', title: 'Xoá dòng' });
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
  if (!shown) body.append(el('tr', {}, el('td', {
    colSpan: spec.cols.length + 1,
    textContent: q ? 'Không có dòng nào khớp bộ lọc.' : 'Bảng trống.',
    style: 'color:var(--dim);padding:14px'
  })));
}

function dirtyCheck() {
  const b = $('#btnCommit');
  if (!b || !CUR) return;
  const n = CUR.rows.filter(r => r.isNew || r.dirty || r.del).length;
  b.disabled = !n;
  b.textContent = n ? `Lưu ${n} thay đổi` : 'Lưu thay đổi';
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
    const kpis = el('div', { className: 'kpis' });
    for (const b of bars) {
      const next = b.kind === 'low'
        ? 'JVC.9' + String(b.next_val).padStart(8, '0')
        : 'JVC.' + String(b.next_val).padStart(9, '0');
      kpis.append(el('div', { className: 'kpi ' + (b.kind === 'low' ? 'a' : 'n') }, [
        el('label', { textContent: `Mã vạch kế tiếp — dải ${b.kind}` }),
        el('b', { textContent: next }),
        el('small', { textContent: `còn ${fmtInt(b.max_val - b.next_val + 1)} số trong dải` })
      ]));
    }
    kpis.append(el('div', { className: 'kpi' }, [
      el('label', { textContent: 'Khoá bộ đếm Mã Tài Sản' }),
      el('b', { textContent: fmtInt(seqs.length) }),
      el('small', { textContent: 'cặp (phòng ban × chữ) đang có' })
    ]));
    const used = seqs.reduce((s, r) => s + r.next_seq - 1, 0);
    kpis.append(el('div', { className: 'kpi g' }, [
      el('label', { textContent: 'Số thứ tự đã cấp' }),
      el('b', { textContent: fmtInt(used) }),
      el('small', { textContent: 'cộng dồn mọi khoá, không tái sử dụng' })
    ]));
    out.append(kpis);

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


/* --------------------------------------------------------- điều hướng */
const NAV = [
  ['Danh mục', [
    ['tbl:am_org',            'Đơn vị & phòng ban'],
    ['tbl:am_org_alias',      'Bí danh phòng ban'],
    ['tbl:am_category_group', 'Nhóm tài sản (mã cha)'],
    ['tbl:am_category',       'Mã danh mục'],
    ['tbl:am_unit',           'Đơn vị tính'],
    ['tbl:am_location',       'Vị trí'],
    ['tbl:am_product',        'Product catalogue']
  ]],
  ['Xuất xứ', [
    ['tbl:am_origin',          'Danh mục quốc gia'],
    ['tbl:am_origin_alias',    'Bí danh xuất xứ'],
    ['tbl:am_origin_rejected', 'Cố ý bỏ trống']
  ]],
  ['Bộ đếm & quy tắc', [
    ['counter', 'Bộ đếm mã'],
    ['rules',   'Thử quy tắc']
  ]],
  ['Xuất chứng từ', [
    ['alr', 'Biên bản tem nhãn']
  ]],
  ['Hệ thống', [
    ['tbl:am_setting', 'Cấu hình ngưỡng'],
    ['setup',          'Kết nối']
  ]]
];

let VIEW = 'setup';

function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [grp, items] of NAV) {
    nav.append(el('div', { className: 'grp', textContent: grp }));
    for (const [id, label] of items) {
      const a = el('a', { textContent: label, href: '#' });
      a.dataset.view = id;
      a.onclick = ev => { ev.preventDefault(); showView(id); };
      nav.append(a);
    }
  }
}

/* Thanh công cụ đổi theo màn hình đang mở */
function buildTools(view) {
  const t = $('#tools');
  t.innerHTML = '';
  if (view.startsWith('tbl:')) {
    const f = el('input', { id: 'filter', placeholder: 'Lọc nhanh…', style: 'width:190px' });
    f.oninput = () => renderGrid();
    const reload = el('button', { className: 'btn', textContent: 'Tải lại' });
    reload.onclick = () => loadTable(view.slice(4));
    const add = el('button', { className: 'btn', textContent: '+ Thêm dòng' });
    add.onclick = addRow;
    const save = el('button', { className: 'btn pri', id: 'btnCommit',
                                textContent: 'Lưu thay đổi', disabled: true });
    save.onclick = commit;
    t.append(f, reload, add, save);
  } else if (view === 'counter') {
    const a = el('button', { className: 'btn', textContent: 'Tải trạng thái' });
    a.onclick = loadCounters;
    const b = el('button', { className: 'btn', textContent: 'Đối chiếu với sổ tài sản' });
    b.onclick = runAudit;
    t.append(a, b);
  }
}

function addRow() {
  if (!CUR) return;
  const spec = TABLES[CUR.table], blank = {};
  for (const c of spec.cols) blank[c.name] = c.type === 'bool' ? false : null;
  CUR.rows.unshift({ orig: null, cur: blank, isNew: true });
  dirtyCheck(); renderGrid();
}

function showView(view) {
  if (VIEW.startsWith('tbl:') && view !== VIEW && CUR) {
    const n = CUR.rows.filter(r => r.isNew || r.dirty || r.del).length;
    if (n && !confirm(n + ' thay đổi chưa lưu sẽ mất. Vẫn chuyển màn hình?')) return;
  }
  VIEW = view;
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view));

  const sect = view.startsWith('tbl:') ? 'v-table' : 'v-' + view;
  $$('section').forEach(s => s.classList.toggle('on', s.id === sect));
  buildTools(view);

  if (view.startsWith('tbl:')) {
    const name = view.slice(4), spec = TABLES[name];
    $('#pageTitle').textContent = spec.label;
    $('#tableLead').textContent = spec.sub || '';
    CUR = null;
    loadTable(name);
  } else {
    $('#pageTitle').textContent = {
      setup: 'Kết nối', counter: 'Bộ đếm Mã Tài Sản & Mã Vạch',
      rules: 'Thử quy tắc', alr: 'Biên bản bàn giao tem nhãn'
    }[view];
    if (view === 'counter' && SB.ready()) loadCounters();
    if (view === 'rules' && SB.ready()) fillPickers();
    if (view === 'alr' && SB.ready()) fillAlrPickers();
  }
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
                 'am_shipment_line', 'am_asset', 'am_alr', 'am_alr_line', 'am_alr_seq',
                 'am_xls_template', 'am_xls_column'];
  const names = [...Object.keys(TABLES), ...extra];
  const tb = el('table');
  tb.append(el('tr', {}, ['Bảng', 'Số dòng'].map(h => el('th', { textContent: h }))));
  let bad = 0;
  for (const n of names) {
    let txt, cls = 'num';
    try { txt = fmtInt(await SB.count(n)); }
    catch { txt = 'KHÔNG CÓ'; cls = 'num neg'; bad++; }
    tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: n })),
                            el('td', { className: cls, textContent: txt })]));
  }
  out.innerHTML = '';
  out.append(el('div', { className: 'msg ' + (bad ? 'err' : 'ok'), textContent: bad
    ? bad + ' bảng chưa tồn tại — chạy lại các file sql/ theo thứ tự 01 → 02 → 02b → 02c → 03 → 04.'
    : 'Đủ ' + names.length + ' bảng. Kiểm tra số dòng master data bên dưới.' }));
  for (const f of ['am_audit_counters']) {
    try { await SB.rpc(f); }
    catch (e) {
      out.append(el('div', { className: 'msg err', textContent:
        'Hàm ' + f + '() gọi không được: ' + e.message +
        ' — kiểm tra 03_functions.sql và 04_rls.sql.' }));
    }
  }
  out.append(el('div', { className: 'wrap' }, tb));
}

/* ---------------------------------------------------------------- init */
function init() {
  buildNav();

  $('#btnSave').onclick = async () => {
    CFG = { url: $('#sbUrl').value.trim().replace(/\/+$/, ''), key: $('#sbKey').value.trim() };
    localStorage.setItem(LS_KEY, JSON.stringify(CFG));
    Object.keys(LOOK).forEach(k => delete LOOK[k]);
    if (await testConn()) fillPickers();
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

  $('#btnScan').onclick = scanSeed;
  $('#btnSeed').onclick = runSeed;
  $('#btnClassify').onclick = doClassify;
  $('#btnOrigin').onclick = doOrigin;
  $('#btnPreview').onclick = doPreview;

  initAlr();
  loadCfg();
  showView('setup');
  testConn(true).then(ok => { if (ok) { showView('tbl:am_org'); fillPickers(); } });
}
document.addEventListener('DOMContentLoaded', init);

/* ================================================================== ALR
   Biên bản bàn giao tem nhãn + trang tem Code128.
   Mẫu gốc: ASSET LABEL RECEIPT.xlsx (5 cột) + 2 cột Đơn giá / Vị trí
   chèn TRƯỚC cột Tem nhãn theo yêu cầu.                                */

const ALR_NOTES_DEFAULT =
`1. Sau khi tiếp nhận tem nhãn tài sản, bộ phận nhận bàn giao có trách nhiệm dán tem nhãn trực tiếp lên tài sản khi hoàn tất quá trình giao nhận với đơn vị vận chuyển, đồng thời chụp hai (2) hình ảnh (gồm một (1) hình ảnh chụp cận tem nhãn đã được dán và một (1) ảnh toàn cảnh tài sản có tem nhãn).
After receiving the asset label, the handover department is required to immediately attach the label to the asset when the delivery process with the carrier is completed, and to take two (2) images (one close-up of the label and one of the asset with the label attached).

2. Hai (2) hình ảnh đã chụp cần được cập nhật trên Hệ thống Quản lý Tài sản tại mục Thẻ tài sản, đồng thời được in ra và đính kèm vào Biên bản nghiệm thu (Asset Handover Form).
Two (2) taken images must be uploaded on the Asset Management System (Asset Section) and simultaneously printed and attached to the Asset Handover Form.

Lưu ý: Nếu hai (2) hình ảnh về tem nhãn tài sản không được đính kèm vào Biên bản nghiệm thu, yêu cầu hoàn tất thanh toán đợt cuối sẽ không được thông qua.
Note: If two (2) images of the asset label are not attached to the Asset Handover Form, the final payment request will not be approved.`;

const ALR = { rows: [], mode: null, demo: false };

const fmtVnd = n => n == null || n === '' ? '' : Number(n).toLocaleString('vi-VN');
const fmtDate = iso => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/* Ô "Thông số kỹ thuật cơ bản": gom ngắn từ các trường spec chi tiết.
   Cùng thứ tự với view am_alr_print để bản in và bản DB khớp nhau. */
function specSummary(a) {
  if (a.spec_summary) return a.spec_summary;
  const dim = [a.spec_length, a.spec_width, a.spec_height]
    .map(v => (v || '').trim()).filter(Boolean).join(' x ');
  return [a.spec_brand, a.spec_model, a.spec_function, a.spec_capacity, dim,
          a.spec_material, a.spec_color,
          a.serial ? 'S/N ' + a.serial : null]
    .map(v => (v || '').trim()).filter(Boolean).join(' · ');
}

function alrCodeFromProject(p) {
  p = (p || '').trim();
  if (!p) return '';
  const i = p.indexOf('.');
  return 'AL.' + (i > 0 ? p.slice(i + 1) : p);
}

/* ------------------------------------------------------- chọn tài sản */
const DEMO_ROWS = [
  { asset_code: 'KIT.C2112.KME.2025.00183', barcode: 'JVC.000006873', asset_kind: 'unique',
    name_vi: 'Tủ lạnh', name_en: 'Refrigerator', qty: 1, unit_code: 'pcs',
    unit_price: 39360000, location_code: 'S0111B0', location_name: 'Kitchen office',
    spec_brand: 'Berjaya', spec_model: 'BS3D2C1F7/Z', spec_capacity: '558L',
    spec_length: '2100mm', spec_width: '760mm', spec_height: '840mm', serial: 'BJ25-0183' },
  { asset_code: 'KIT.C2422.LTU.2025.00241', barcode: 'JVC.000006874', asset_kind: 'unique',
    name_vi: 'Bàn inox 2 tầng', name_en: 'Stainless steel table', qty: 1, unit_code: 'pcs',
    unit_price: 8450000, location_code: 'S1809B0', location_name: 'Club kitchen',
    spec_material: 'Inox 304', spec_length: '1500mm', spec_width: '700mm', spec_height: '850mm' },
  { asset_code: 'FBD.C2422.LTG.2025.00281', barcode: 'JVC.900000042', asset_kind: 'low',
    name_vi: 'Ly thuỷ tinh chân cao', name_en: 'Stemmed glass', qty: 48, unit_code: 'pcs',
    unit_price: 145000, location_code: 'SB142B0', location_name: 'F&B office',
    spec_brand: 'Ocean', spec_capacity: '350ml', spec_color: 'Trong suốt' },
  { asset_code: 'ITD.C2112.ITO.2025.00506', barcode: 'JVC.000006875', asset_kind: 'unique',
    name_vi: 'Máy tính xách tay', name_en: 'Laptop', qty: 1, unit_code: 'pcs',
    unit_price: 32900000, location_code: 'S0103B0', location_name: 'It office',
    spec_brand: 'Dell', spec_model: 'Latitude 5450', spec_function: 'i7 / 16GB / 512GB',
    spec_color: 'Xám', serial: 'CN0X7Y2Z' }
];

function renderAlrList() {
  const head = $('#alGrid thead'), body = $('#alGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, ['', 'Mã tài sản', 'Tên', 'SL', 'Đơn giá', 'Vị trí', 'Mã vạch']
    .map(h => el('th', { textContent: h }))));
  if (!ALR.rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 7, style: 'color:var(--dim);padding:14px',
      textContent: 'Chưa có tài sản nào. Bấm “Tải tài sản”, hoặc “Dữ liệu mẫu” để xem thử bố cục.' })));
    return;
  }
  for (const r of ALR.rows) {
    const cb = el('input', { type: 'checkbox', checked: r._pick !== false });
    cb.onchange = () => { r._pick = cb.checked; };
    body.append(el('tr', {}, [
      el('td', {}, cb),
      el('td', {}, el('code', { textContent: r.asset_code })),
      el('td', { textContent: r.name_vi || '' }),
      el('td', { className: 'num', textContent: fmtVnd(r.qty) }),
      el('td', { className: 'num', textContent: fmtVnd(r.unit_price) }),
      el('td', { textContent: [r.location_code, r.location_name].filter(Boolean).join(' — ') }),
      el('td', {}, el('code', { textContent: r.barcode }))
    ]));
  }
}

async function loadAlrAssets() {
  const box = $('#alListMsg');
  const q = ['select=*', 'order=asset_code'];
  const ship = $('#alShip').value, dept = $('#alDept').value, loc = $('#alLoc').value;
  if (ship) q.push('shipment_id=eq.' + ship);
  if (dept) q.push('dept_code=eq.' + dept);
  if (loc)  q.push('location_code=eq.' + loc);
  msg(box, 'info', 'Đang tải…');
  try {
    const rows = await SB.select('am_asset', q.join('&'));
    const locs = await lookup('am_location').catch(() => []);
    const lmap = new Map(locs.map(l => [l.v, l.t]));
    ALR.rows = rows.map(r => ({ ...r, _pick: true,
      location_name: (lmap.get(r.location_code) || '').split(' — ')[1] || '' }));
    ALR.demo = false;
    msg(box, ALR.rows.length ? 'ok' : 'warn', ALR.rows.length
      ? `Tải được ${ALR.rows.length} tài sản.`
      : 'Không có tài sản nào khớp bộ lọc. Sổ am_asset còn trống cho tới khi làm xong phần nhập đợt hàng — dùng “Dữ liệu mẫu” để xem bố cục biên bản.');
  } catch (e) {
    msg(box, 'err', e.message);
    ALR.rows = [];
  }
  renderAlrList();
}

function loadAlrDemo() {
  ALR.rows = DEMO_ROWS.map(r => ({ ...r, _pick: true }));
  ALR.demo = true;
  msg('#alListMsg', 'warn',
    'Đang dùng DỮ LIỆU MẪU — chỉ để kiểm tra bố cục và thử in. Không phải tài sản thật, không lưu lên Supabase được.');
  renderAlrList();
}

const alrPicked = () => ALR.rows.filter(r => r._pick !== false);

/* ---------------------------------------------------- dựng biên bản */
function docHeader() {
  const h = el('div', { className: 'doc-head' }, [
    el('div', { className: 'co', textContent: 'Công ty TNHH Liên Doanh Khách Sạn Plaza' }),
    el('div', { className: 'addr', textContent: '17 Lê Duẩn, Bến Nghé, Quận 1, TP. Hồ Chí Minh' }),
    el('div', { className: 'ttl',
                textContent: 'Asset Label Receipt / Biên bản bàn giao tem nhãn tài sản' })
  ]);
  const meta = el('div', { className: 'doc-meta' }, [
    el('div', {}, [el('b', { textContent: 'No./Số: ' }), $('#alCode').value || '—']),
    el('div', {}, [el('b', { textContent: 'Date/Ngày: ' }), fmtDate($('#alDate').value)]),
    el('div', {}, [el('b', { textContent: 'Mã dự án/Project: ' }), $('#alProject').value || '—'])
  ]);
  return [h, meta];
}

function barcodeSvg(code, opts = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, code, Object.assign({
      format: 'CODE128', displayValue: true, fontSize: 11, textMargin: 1,
      height: 28, width: 1.3, margin: 0
    }, opts));
  } catch (e) {
    svg.remove();
    return el('code', { textContent: code });
  }
  return svg;
}

function buildDoc() {
  const rows = alrPicked();
  const root = $('#printRoot');
  root.innerHTML = '';
  if (!rows.length) { msg('#alOutMsg', 'err', 'Chưa chọn tài sản nào.'); return; }

  root.append(...docHeader());

  const COLS = [
    ['Stt<br>No.', '4%'], ['Mã tài sản<br>Asset code', '13%'],
    ['Tên tài sản<br>Asset name', '15%'], ['Số lượng<br>Quantity', '6%'],
    ['Thông số kỹ thuật cơ bản<br>Specification', '24%'],
    ['Đơn giá<br>Unit price', '9%'], ['Vị trí<br>Location', '12%'],
    ['Tem nhãn<br>Label', '17%']
  ];
  const tb = el('table', { className: 'doc' });
  const cg = el('colgroup');
  for (const [, w] of COLS) cg.append(el('col', { style: 'width:' + w }));
  const hr = el('tr');
  for (const [h] of COLS) { const th = el('th'); th.innerHTML = h; hr.append(th); }
  tb.append(cg, el('thead', {}, hr));

  const body = el('tbody');
  rows.forEach((r, i) => {
    const name = [r.name_vi, r.name_en].filter(Boolean).join(' / ');
    body.append(el('tr', {}, [
      el('td', { className: 'c', textContent: String(i + 1) }),
      el('td', { textContent: r.asset_code }),
      el('td', { textContent: name }),
      el('td', { className: 'c', textContent: fmtVnd(r.qty) + (r.unit_code ? ' ' + r.unit_code : '') }),
      el('td', { textContent: specSummary(r) }),
      el('td', { className: 'r', textContent: fmtVnd(r.unit_price) }),
      el('td', { textContent: [r.location_code, r.location_name].filter(Boolean).join(' — ') }),
      el('td', { className: 'lbl' }, barcodeSvg(r.barcode, { height: 26, width: 1.2, fontSize: 10 }))
    ]));
  });
  tb.append(body);
  root.append(tb);

  root.append(el('div', { className: 'doc-notes' }, [
    el('b', { textContent: 'Quy trình và lưu ý khi tiếp nhận và sử dụng tem nhãn tài sản / Process and notes:' }),
    document.createTextNode('\n' + $('#alNotes').value)
  ]));
  root.append(el('div', { className: 'doc-sign' }, [
    el('div', {}, [el('b', { textContent: 'Prepared by / Người lập biểu' }),
                   el('i', {}), document.createTextNode($('#alPrep').value || '')]),
    el('div', {}, [el('b', { textContent: 'Received by / Người nhận' }),
                   el('i', {}), document.createTextNode($('#alRecv').value || '')])
  ]));

  ALR.mode = 'doc';
  $('#btnAlPrint').disabled = false;
  $('#btnAlSave').disabled = ALR.demo || !SB.ready();
  msg('#alOutMsg', 'ok', `Đã dựng biên bản ${$('#alCode').value || ''} — ${rows.length} dòng. ` +
    'In ra khổ A4 nằm ngang.' + (ALR.demo ? '\n(Đang là dữ liệu mẫu nên không lưu được.)' : ''));
}

function buildLabels() {
  const rows = alrPicked();
  const root = $('#printRoot');
  root.innerHTML = '';
  if (!rows.length) { msg('#alOutMsg', 'err', 'Chưa chọn tài sản nào.'); return; }

  root.append(...docHeader());
  root.append(el('div', { className: 'doc-notes', style: 'margin:0 0 6mm',
    textContent: `Trang tem nhãn — ${rows.length} tem. Cắt theo đường viền rồi dán lên đúng tài sản.` }));

  const cols = Math.min(6, Math.max(1, Number($('#alCols').value) || 3));
  const sheet = el('div', { className: 'sheet', style: `--cols:${cols}` });
  for (const r of rows) {
    sheet.append(el('div', { className: 'lab' }, [
      barcodeSvg(r.barcode, { height: 34, width: 1.5, fontSize: 12 }),
      el('div', { className: 'nm', textContent: r.name_vi || r.name_en || '' }),
      el('div', { className: 'cd', textContent: r.asset_code })
    ]));
  }
  root.append(sheet);

  ALR.mode = 'labels';
  $('#btnAlPrint').disabled = false;
  msg('#alOutMsg', 'ok', `Đã dựng ${rows.length} tem, ${cols} tem mỗi hàng. In khổ A4 dọc.`);
}

/* Đổi hướng giấy theo thứ đang in: biên bản 8 cột cần nằm ngang. */
function printNow() {
  const id = 'am-page-rule';
  document.getElementById(id)?.remove();
  const st = el('style', { id });
  st.textContent = `@page{size:A4 ${ALR.mode === 'doc' ? 'landscape' : 'portrait'};margin:10mm}`;
  document.head.append(st);
  window.print();
}

/* ------------------------------------------------------- lưu Supabase */
async function saveAlr() {
  const rows = alrPicked();
  if (ALR.demo) return msg('#alOutMsg', 'err', 'Dữ liệu mẫu không lưu được.');
  if (!rows.length) return;
  try {
    const [alr] = await SB.insert('am_alr', [{
      code: $('#alCode').value.trim(),
      issue_date: $('#alDate').value || null,
      project_code: $('#alProject').value.trim() || null,
      prepared_by: $('#alPrep').value.trim() || null,
      received_by: $('#alRecv').value.trim() || null,
      notes_text: $('#alNotes').value,
      shipment_id: $('#alShip').value || null,
      dept_code: $('#alDept').value || null,
      location_code: $('#alLoc').value || null
    }]);
    await SB.insert('am_alr_line',
      rows.map((r, i) => ({ alr_id: alr.id, line_no: i + 1, asset_id: r.id })));
    msg('#alOutMsg', 'ok', `Đã lưu biên bản ${alr.code} (id ${alr.id}) với ${rows.length} dòng.`);
  } catch (e) {
    msg('#alOutMsg', 'err', 'Lưu thất bại: ' + e.message +
      '\nNếu báo thiếu cột project_code / notes_text: chạy sql/05_alr.sql.');
  }
}

/* --------------------------------------------------------- khởi tạo */
async function fillAlrPickers() {
  try {
    const [deps, locs] = await Promise.all([
      SB.select('am_org', 'select=code,name_vi&is_department=is.true&order=code'),
      SB.select('am_location', 'select=code,name&order=code')
    ]);
    const d = $('#alDept'), l = $('#alLoc');
    d.length = 1; l.length = 1;
    for (const o of deps) d.append(el('option', { value: o.code, textContent: `${o.code} — ${o.name_vi}` }));
    for (const o of locs) l.append(el('option', { value: o.code, textContent: `${o.code} — ${o.name}` }));
    const sh = await SB.select('am_shipment', 'select=id,code,delivery_date,purpose_code&order=id.desc&limit=100');
    const s = $('#alShip'); s.length = 1;
    for (const o of sh)
      s.append(el('option', { value: o.id,
        textContent: [o.code || '#' + o.id, o.purpose_code, o.delivery_date].filter(Boolean).join(' · ') }));
  } catch { /* chưa kết nối — màn hình Kết nối đã báo rồi */ }
}

function initAlr() {
  $('#alNotes').value = ALR_NOTES_DEFAULT;
  $('#alDate').value = new Date().toISOString().slice(0, 10);
  const sync = () => { $('#alCode').value = alrCodeFromProject($('#alProject').value); };
  sync();
  $('#alProject').oninput = sync;
  $('#alShip').onchange = () => {
    const t = $('#alShip').selectedOptions[0]?.textContent || '';
    const m = /\b((?:FFE|CAPEX)\.[A-Z]+\.\d+\.\d{4})\b/i.exec(t);
    if (m) { $('#alProject').value = m[1]; sync(); }
  };
  $('#btnAlLoad').onclick = loadAlrAssets;
  $('#btnAlDemo').onclick = loadAlrDemo;
  $('#btnAlDoc').onclick = buildDoc;
  $('#btnAlLabels').onclick = buildLabels;
  $('#btnAlPrint').onclick = printNow;
  $('#btnAlSave').onclick = saveAlr;
  renderAlrList();
}
