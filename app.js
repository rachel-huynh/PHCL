/* asset-intake — internal tool (phase 1: master data + counters)
   PUBLIC repo: no URL/key is embedded. Settings come from localStorage or from
   a #sbcfg=<base64> fragment, which is stripped from the address bar at once.
   All user-facing text goes through t() in i18n.js — English is official. */
'use strict';

/* ------------------------------------------------------------------ util */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) n.append(k);
  return n;
};
function msg(host, kind, text) {
  const box = typeof host === 'string' ? $(host) : host;
  box.innerHTML = '';
  if (text) box.append(el('div', { className: 'msg ' + kind, textContent: text }));
  return box;
}
const fmtInt = n => (n ?? 0).toLocaleString(LANG === 'vi' ? 'vi-VN' : 'en-US');

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
    } catch (e) { console.warn('bad sbcfg', e); }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!CFG.url) {
    try { Object.assign(CFG, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch {}
  }
  $('#sbUrl').value = CFG.url || '';
  $('#sbKey').value = CFG.key || '';
}

let CONN = { ok: false, host: '' };
function setConn(ok, hostOrKey) {
  CONN = { ok, host: ok ? hostOrKey : '' };
  $('#dot').classList.toggle('on', !!ok);
  $('#connTxt').textContent = ok ? hostOrKey : t(hostOrKey);
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
    if (!SB.ready()) throw new Error(t('err.noConfig'));
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

/* --------------------------------------------------------- table specs
   Labels and descriptions live in i18n.js under tbl.<table>.label / .sub  */
const T = (name, val) => ({ name, ...val });
const tblLabel = n => t('tbl.' + n + '.label');
const tblSub   = n => t('tbl.' + n + '.sub');

const TABLES = {
  am_org: {
    pk: 'code', order: 'level,code',
    cols: [
      T('code', { w: 80 }), T('name_vi', { w: 300 }), T('name_en', { w: 260 }),
      T('level', { type: 'select', opts: ['TCT', 'BRANCH', 'DEPT1', 'DEPT2'], w: 100 }),
      T('is_company', { type: 'bool' }), T('is_department', { type: 'bool' }),
      T('parent_code', { type: 'ref', ref: 'am_org', w: 110 }),
      T('active', { type: 'bool' }), T('note', { w: 320 })
    ]
  },
  am_org_alias: {
    pk: 'alias', order: 'alias',
    cols: [T('alias', { w: 120 }), T('code', { type: 'ref', ref: 'am_org', w: 110 }),
           T('source', { w: 420 })]
  },
  am_category_group: {
    pk: 'code', order: 'sort_order',
    cols: [T('code', { w: 80 }), T('name_vi', { w: 340 }), T('name_en', { w: 300 }),
           T('expense_class', { type: 'select', opts: ['CAPEX', 'OPEX'], w: 100 }),
           T('is_intangible', { type: 'bool' }), T('is_tools', { type: 'bool' }),
           T('sort_order', { type: 'int', w: 80 })]
  },
  am_category: {
    pk: 'code', order: 'group_code,code',
    cols: [T('code', { w: 90 }), T('group_code', { type: 'ref', ref: 'am_category_group', w: 100 }),
           T('name_vi', { w: 300 }), T('name_en', { w: 280 }),
           T('label_letters', { w: 100 }),
           T('manage_by', { type: 'select', opts: ['code', 'quantity'], w: 110 }),
           T('active', { type: 'bool' }), T('note', { w: 340 })]
  },
  am_unit: {
    pk: 'code', order: 'sort_order',
    cols: [T('code', { w: 100 }), T('name_vi', { w: 160 }), T('name_en', { w: 160 }),
           T('sort_order', { type: 'int', w: 90 })]
  },
  am_origin: {
    pk: 'iso2', order: 'iso2',
    cols: [T('iso2', { w: 70 }), T('name_en', { w: 320 }), T('name_vi', { w: 260 })]
  },
  am_origin_alias: {
    pk: 'alias_norm', order: 'alias_norm',
    cols: [T('alias_norm', { w: 220 }), T('iso2', { type: 'ref', ref: 'am_origin', w: 90 }),
           T('note', { w: 340 })]
  },
  am_origin_rejected: {
    pk: 'raw_norm', order: 'raw_norm',
    cols: [T('raw_norm', { w: 220 }), T('raw_sample', { w: 220 }),
           T('reason', { type: 'select', opts: ['multi_country', 'not_a_country', 'unknown'], w: 150 }),
           T('seen_count', { type: 'int', w: 90 })]
  },
  am_location: {
    pk: 'code', order: 'code',
    cols: [T('code', { w: 110 }), T('name', { w: 330 }),
           T('kind', { type: 'select', opts: ['building', 'floor', 'room', 'area'], w: 110 }),
           T('parent_code', { type: 'ref', ref: 'am_location', w: 110 }),
           T('dept_code', { type: 'ref', ref: 'am_org', w: 110 }),
           T('is_dept_office', { type: 'bool' }), T('active', { type: 'bool' })]
  },
  am_product: {
    pk: 'id', auto: true, order: 'std_name_vi',
    cols: [T('raw_name', { w: 300 }), T('raw_name_norm', { w: 300 }),
           T('std_name_vi', { w: 260 }), T('std_name_en', { w: 240 }),
           T('default_category', { type: 'ref', ref: 'am_category', w: 120 }),
           T('default_unit', { type: 'ref', ref: 'am_unit', w: 110 }),
           T('default_brand', { w: 150 }), T('hint_intangible', { type: 'bool' }),
           T('times_used', { type: 'int', w: 90 })]
  },
  am_setting: {
    pk: 'key', order: 'key',
    cols: [T('key', { w: 180 }), T('value', { w: 180 }), T('note', { w: 520 })]
  }
};

/* --------------------------------------------------------- lookup cache */
const LOOK = {};
async function lookup(table) {
  if (LOOK[table]) return LOOK[table];
  const pk = TABLES[table].pk;
  const lab = TABLES[table].cols.find(c => /^name_en$|^name_vi$|^name$/.test(c.name));
  const sel = lab ? `${pk},${lab.name}` : pk;
  const rows = await SB.select(table, `select=${sel}&order=${pk}`);
  LOOK[table] = rows.map(r => ({ v: r[pk], t: lab ? `${r[pk]} — ${r[lab.name] ?? ''}` : r[pk] }));
  return LOOK[table];
}

/* ------------------------------------------------------------ data grid */
let CUR = null;   // { table, rows:[{orig,cur,isNew,dirty,del}] }

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
        const txt = typeof o === 'string' ? o : o.t, val = typeof o === 'string' ? o : o.v;
        s.append(el('option', { value: val, textContent: txt,
                                selected: String(val) === String(v ?? '') }));
      }
      if (v != null && v !== '' &&
          !list.some(o => String(typeof o === 'string' ? o : o.v) === String(v)))
        s.append(el('option', { value: v, textContent: t('table.notInList', { v }),
                                selected: true }));
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
  if (!CUR) return;
  const spec = TABLES[CUR.table];
  const head = $('#grid thead'), body = $('#grid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  const hr = el('tr');
  hr.append(el('th', { textContent: '' }));
  for (const c of spec.cols) hr.append(el('th', { textContent: c.name }));
  head.append(hr);

  const q = ($('#filter')?.value || '').trim().toLowerCase();
  let shown = 0;
  for (const row of CUR.rows) {
    if (row.del) continue;
    if (q && !JSON.stringify(row.cur).toLowerCase().includes(q)) continue;
    shown++;
    const tr = el('tr');
    if (row.isNew) tr.classList.add('new');
    else if (row.dirty) tr.classList.add('dirty');
    const del = el('button', { className: 'xbtn', textContent: '✕', title: t('table.deleteRow') });
    del.onclick = () => {
      if (row.isNew) CUR.rows.splice(CUR.rows.indexOf(row), 1);
      else if (confirm(t('table.confirmDelete', { id: row.cur[spec.pk] }))) row.del = true;
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
    textContent: q ? t('table.noMatch') : t('table.empty'),
    style: 'color:var(--dim);padding:14px'
  })));
}

function dirtyCheck() {
  const b = $('#btnCommit');
  if (!b || !CUR) return;
  const n = CUR.rows.filter(r => r.isNew || r.dirty || r.del).length;
  b.disabled = !n;
  b.textContent = n ? t('tool.saveN', { n }) : t('tool.save');
}

async function loadTable(name) {
  CUR = { table: name, rows: [] };
  msg('#dataMsg', 'info', t('table.loading'));
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
  msg('#dataMsg', 'info', t('table.writing'));
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
        for (const c of spec.cols)
          if (r.cur[c.name] != null && r.cur[c.name] !== '') o[c.name] = r.cur[c.name];
        return o;
      });
      await SB.insert(CUR.table, payload); done += news.length;
    }
    delete LOOK[CUR.table];
    await loadTable(CUR.table);
    msg('#dataMsg', 'ok', t('table.wrote', { n: done }));
  } catch (e) {
    msg('#dataMsg', 'err', t('table.writeFail', { n: done, err: e.message }));
  }
}

/* ------------------------------------------------------------- counters */
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
  msg(out, 'info', t('cnt.seed.scanning'));
  try {
    if ($('#seedText').value.trim()) scanText($('#seedText').value.toUpperCase(), acc);
    for (const f of ($('#seedFile').files || [])) {
      if (f.size > 40 * 1024 * 1024) {
        acc.files.push(t('cnt.seed.tooBig', { name: f.name, mb: (f.size / 1048576) | 0 }));
        continue;
      }
      const buf = await f.arrayBuffer();
      if (/\.(xlsx|xlsm)$/i.test(f.name)) {
        const wb = XLSX.read(buf, { type: 'array' });
        for (const s of wb.SheetNames)
          scanText(XLSX.utils.sheet_to_csv(wb.Sheets[s]).toUpperCase(), acc);
        acc.files.push(t('cnt.seed.sheets', { name: f.name, n: wb.SheetNames.length }));
      } else {
        scanText(new TextDecoder().decode(buf).toUpperCase(), acc);
        acc.files.push(t('cnt.seed.text', { name: f.name }));
      }
    }
  } catch (e) { return msg(out, 'err', t('cnt.seed.scanErr', { err: e.message })); }

  SEED = acc;
  out.innerHTML = '';
  if (!acc.asset.size && !acc.bar.size) {
    $('#btnSeed').disabled = true;
    return msg(out, 'warn', t('cnt.seed.none'));
  }
  if (acc.files.length)
    out.append(el('div', { className: 'hint', textContent: acc.files.join(' · ') }));
  out.append(el('div', { className: 'msg info', textContent:
    t('cnt.seed.found', { a: fmtInt(acc.nAsset), k: acc.asset.size, b: fmtInt(acc.nBar) }) }));

  const tb = el('table');
  tb.append(el('tr', {}, ['cnt.seed.col.key', 'cnt.seed.col.kind', 'cnt.seed.col.max',
    'cnt.seed.col.sample', 'cnt.seed.col.groups'].map(k => el('th', { textContent: t(k) }))));
  for (const [k, v] of [...acc.asset].sort((a, b) => a[0].localeCompare(b[0])))
    tb.append(el('tr', {}, [
      el('td', {}, el('code', { textContent: k })),
      el('td', { textContent: t('cnt.seed.kindAsset') }),
      el('td', { className: 'num', textContent: fmtInt(v.seq) }),
      el('td', {}, el('code', { textContent: v.code })),
      el('td', { textContent: [...v.groups].join(', '),
                 style: v.groups.size > 1 ? 'color:var(--amber);font-weight:600' : '' })
    ]));
  for (const [k, v] of acc.bar)
    tb.append(el('tr', {}, [
      el('td', {}, el('code', { textContent: k })),
      el('td', { textContent: t('cnt.seed.kindBarcode') }),
      el('td', { className: 'num', textContent: fmtInt(v.val) }),
      el('td', {}, el('code', { textContent: v.code })),
      el('td', { textContent: '' })
    ]));
  out.append(el('div', { className: 'wrap' }, tb));

  const multi = [...acc.asset.values()].filter(v => v.groups.size > 1).length;
  if (multi) out.append(el('div', { className: 'msg warn',
    textContent: t('cnt.seed.multiWarn', { n: multi }) }));
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
    tb.append(el('tr', {}, ['cnt.seed.res.key', 'cnt.seed.res.counter', 'cnt.seed.res.max',
      'cnt.seed.res.next'].map(k => el('th', { textContent: t(k) }))));
    for (const r of res || [])
      tb.append(el('tr', {}, [
        el('td', {}, el('code', { textContent: r.scope })),
        el('td', { textContent: r.kind }),
        el('td', { className: 'num', textContent: fmtInt(r.max_seen) }),
        el('td', { className: 'num', textContent: fmtInt(r.next_val) })
      ]));
    out.innerHTML = '';
    out.append(el('div', { className: 'msg ok',
      textContent: t('cnt.seed.done', { n: (res || []).length, c: codes.length }) }));
    out.append(el('div', { className: 'wrap' }, tb));
    await loadCounters();
  } catch (e) {
    msg(out, 'err', t('cnt.seed.fail', { err: e.message }));
    $('#btnSeed').disabled = false;
  }
}

async function loadCounters() {
  const out = $('#cntOut');
  msg(out, 'info', t('table.loading'));
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
        el('label', { textContent: t('cnt.kpi.next', { kind: b.kind }) }),
        el('b', { textContent: next }),
        el('small', { textContent: t('cnt.kpi.remaining',
                                     { n: fmtInt(b.max_val - b.next_val + 1) }) })
      ]));
    }
    kpis.append(el('div', { className: 'kpi' }, [
      el('label', { textContent: t('cnt.kpi.keys') }),
      el('b', { textContent: fmtInt(seqs.length) }),
      el('small', { textContent: t('cnt.kpi.keysSub') })
    ]));
    kpis.append(el('div', { className: 'kpi g' }, [
      el('label', { textContent: t('cnt.kpi.issued') }),
      el('b', { textContent: fmtInt(seqs.reduce((s, r) => s + r.next_seq - 1, 0)) }),
      el('small', { textContent: t('cnt.kpi.issuedSub') })
    ]));
    out.append(kpis);

    if (seqs.length) {
      const tb = el('table');
      tb.append(el('tr', {}, ['cnt.col.dept', 'cnt.col.letters', 'cnt.col.next', 'cnt.col.updated']
        .map(k => el('th', { textContent: t(k) }))));
      for (const s of seqs)
        tb.append(el('tr', {}, [
          el('td', {}, el('code', { textContent: s.dept_code })),
          el('td', {}, el('code', { textContent: s.letters })),
          el('td', { className: 'num', textContent: String(s.next_seq).padStart(5, '0') }),
          el('td', { textContent: (s.updated_at || '').slice(0, 19).replace('T', ' ') })
        ]));
      out.append(el('div', { className: 'wrap' }, tb));
    } else {
      out.append(el('div', { className: 'msg warn', textContent: t('cnt.noKeys') }));
    }

    if (log.length) {
      const d = el('details');
      d.append(el('summary', { textContent: t('cnt.log.summary', { n: log.length }) }));
      const tb = el('table');
      tb.append(el('tr', {}, ['cnt.log.when', 'cnt.log.counter', 'cnt.log.scope', 'cnt.log.from',
        'cnt.log.to', 'cnt.log.qty', 'cnt.log.actor'].map(k => el('th', { textContent: t(k) }))));
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
      textContent: bad.length ? t('cnt.audit.bad', { n: bad.length })
                              : t('cnt.audit.ok', { n: (res || []).length })
    }));
    const rows = bad.length ? bad : (res || []);
    if (rows.length) {
      const tb = el('table');
      tb.append(el('tr', {}, ['cnt.audit.key', 'cnt.audit.next', 'cnt.audit.max', 'cnt.audit.gap']
        .map(k => el('th', { textContent: t(k) }))));
      for (const r of rows)
        tb.append(el('tr', {}, [
          el('td', {}, el('code', { textContent: r.scope })),
          el('td', { className: 'num', textContent: fmtInt(r.counter_next) }),
          el('td', { className: 'num', textContent: fmtInt(r.table_max) }),
          el('td', { className: 'num' + (r.gap < 0 ? ' neg' : ''), textContent: fmtInt(r.gap) })
        ]));
      box.append(el('div', { className: 'wrap' }, tb));
    }
    out.innerHTML = ''; out.append(box);
  } catch (e) { msg(out, 'err', e.message); }
}

/* -------------------------------------------------------------- rules */
async function fillPickers() {
  try {
    const cats = await SB.select('am_category',
      'select=code,group_code,label_letters,name_vi,name_en&order=code');
    const orgs = await SB.select('am_org',
      'select=code,name_vi,name_en&is_department=is.true&order=code');
    const catText = c => `${c.code} — ${(LANG === 'vi' ? c.name_vi : c.name_en) || c.name_vi}`;
    for (const id of ['#rcCat', '#pvCat']) {
      const s = $(id); const keep = s.value; s.innerHTML = '';
      for (const c of cats) s.append(el('option', { value: c.code, textContent: catText(c) }));
      s.value = keep || (id === '#rcCat' ? 'LTU' : cats[0]?.code) || '';
    }
    const d = $('#pvDept'); const keepD = d.value; d.innerHTML = '';
    for (const o of orgs) d.append(el('option', { value: o.code, textContent: o.code }));
    d.value = keepD || orgs[0]?.code || '';
    window.__CATS = cats;
  } catch { /* the Connection screen already reports it */ }
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
      t(r.asset_kind === 'unique' ? 'rules.kind.unique' : 'rules.kind.low') +
      (r.violates_capex ? t('rules.violates') : '') +
      (r.suggested_category ? t('rules.suggested', { code: r.suggested_category }) : '') }));
    for (const w of r.warnings || [])
      out.append(el('div', { className: 'msg warn', textContent: w }));
  } catch (e) { msg(out, 'err', e.message); }
}

async function doOrigin() {
  const out = $('#orOut');
  try {
    const r = (await SB.rpc('am_resolve_origin', { p_raw: $('#orRaw').value }))[0];
    const why = t('why.' + r.reason) === 'why.' + r.reason ? r.reason : t('why.' + r.reason);
    msg(out, r.iso2 ? 'ok' : 'warn', r.iso2
      ? t('rules.origin.hit', { iso: r.iso2, why })
      : t('rules.origin.miss', { why }));
  } catch (e) { msg(out, 'err', e.message); }
}

async function doPreview() {
  const out = $('#pvOut');
  try {
    const cat = (window.__CATS || []).find(c => c.code === $('#pvCat').value);
    if (!cat) return msg(out, 'err', t('rules.noCats'));
    const dept = $('#pvDept').value;
    const code = await SB.rpc('am_build_asset_code', {
      p_dept: dept, p_group: cat.group_code, p_letters: cat.label_letters,
      p_year: Number($('#pvYear').value), p_seq: Number($('#pvSeq').value)
    });
    const qr = cat.code !== cat.label_letters;
    msg(out, 'ok', t('rules.built', { code }) + (qr
      ? t('rules.builtQr', { code: cat.code, letters: cat.label_letters, dept })
      : t('rules.builtPlain', { dept, letters: cat.label_letters })));
  } catch (e) { msg(out, 'err', e.message); }
}

/* ================================================================== ALR
   Asset label receipt + Code128 label sheet.
   Source form: ASSET LABEL RECEIPT.xlsx (5 columns) plus Unit price and
   Location inserted BEFORE the Label column, as agreed.
   The printed form stays bilingual — it is the company's official document. */

const ALR_NOTES = {
en:
`1. After receiving the asset labels, the receiving department must attach each label directly to its asset as soon as the handover with the carrier is complete, and take two (2) photographs (one close-up of the attached label and one overall view of the asset showing the label).

2. Both photographs must be uploaded to the Asset Management System under the asset record, printed, and attached to the Asset Handover Form.

Note: If the two (2) photographs of the asset label are not attached to the Asset Handover Form, the final payment request will not be approved.`,
vi:
`1. Sau khi tiếp nhận tem nhãn tài sản, bộ phận nhận bàn giao có trách nhiệm dán tem nhãn trực tiếp lên tài sản khi hoàn tất quá trình giao nhận với đơn vị vận chuyển, đồng thời chụp hai (2) hình ảnh (gồm một (1) hình ảnh chụp cận tem nhãn đã được dán và một (1) ảnh toàn cảnh tài sản có tem nhãn).

2. Hai (2) hình ảnh đã chụp cần được cập nhật trên Hệ thống Quản lý Tài sản tại mục Thẻ tài sản, đồng thời được in ra và đính kèm vào Biên bản nghiệm thu (Asset Handover Form).

Lưu ý: Nếu hai (2) hình ảnh về tem nhãn tài sản không được đính kèm vào Biên bản nghiệm thu, yêu cầu hoàn tất thanh toán đợt cuối sẽ không được thông qua.`
};

const ALR = { rows: [], mode: null, demo: false };

const fmtNum = n => n == null || n === ''
  ? '' : Number(n).toLocaleString(LANG === 'vi' ? 'vi-VN' : 'en-US');
const fmtDate = iso => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
};

/* Specification cell: short roll-up of the detailed spec fields.
   Keep this order identical to the am_alr_print view in sql/05_alr.sql,
   otherwise the printed form and the stored record drift apart. */
function specSummary(a) {
  if (a.spec_summary) return a.spec_summary;
  const dim = [a.spec_length, a.spec_width, a.spec_height]
    .map(v => (v || '').trim()).filter(Boolean).join(' x ');
  return [a.spec_brand, a.spec_model, a.spec_function, a.spec_capacity, dim,
          a.spec_material, a.spec_color, a.serial ? 'S/N ' + a.serial : null]
    .map(v => (v || '').trim()).filter(Boolean).join(' · ');
}

function alrCodeFromProject(p) {
  p = (p || '').trim();
  if (!p) return '';
  const i = p.indexOf('.');
  return 'AL.' + (i > 0 ? p.slice(i + 1) : p);
}

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
    spec_brand: 'Ocean', spec_capacity: '350ml', spec_color: 'Clear' },
  { asset_code: 'ITD.C2112.ITO.2025.00506', barcode: 'JVC.000006875', asset_kind: 'unique',
    name_vi: 'Máy tính xách tay', name_en: 'Laptop', qty: 1, unit_code: 'pcs',
    unit_price: 32900000, location_code: 'S0103B0', location_name: 'It office',
    spec_brand: 'Dell', spec_model: 'Latitude 5450', spec_function: 'i7 / 16GB / 512GB',
    spec_color: 'Grey', serial: 'CN0X7Y2Z' }
];

function renderAlrList() {
  const head = $('#alGrid thead'), body = $('#alGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, ['', 'alr.col.code', 'alr.col.name', 'alr.col.qty', 'alr.col.price',
    'alr.col.loc', 'alr.col.barcode'].map(k => el('th', { textContent: k ? t(k) : '' }))));
  if (!ALR.rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 7, style: 'color:var(--dim);padding:14px',
      textContent: t('alr.listEmpty') })));
    return;
  }
  for (const r of ALR.rows) {
    const cb = el('input', { type: 'checkbox', checked: r._pick !== false });
    cb.onchange = () => { r._pick = cb.checked; };
    body.append(el('tr', {}, [
      el('td', {}, cb),
      el('td', {}, el('code', { textContent: r.asset_code })),
      el('td', { textContent: (LANG === 'vi' ? r.name_vi : r.name_en) || r.name_vi || '' }),
      el('td', { className: 'num', textContent: fmtNum(r.qty) }),
      el('td', { className: 'num', textContent: fmtNum(r.unit_price) }),
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
  msg(box, 'info', t('table.loading'));
  try {
    const rows = await SB.select('am_asset', q.join('&'));
    const locs = await lookup('am_location').catch(() => []);
    const lmap = new Map(locs.map(l => [l.v, l.t]));
    ALR.rows = rows.map(r => ({ ...r, _pick: true,
      location_name: (lmap.get(r.location_code) || '').split(' — ')[1] || '' }));
    ALR.demo = false;
    msg(box, ALR.rows.length ? 'ok' : 'warn',
        ALR.rows.length ? t('alr.loaded', { n: ALR.rows.length }) : t('alr.loadedNone'));
  } catch (e) { msg(box, 'err', e.message); ALR.rows = []; }
  renderAlrList();
}

function loadAlrDemo() {
  ALR.rows = DEMO_ROWS.map(r => ({ ...r, _pick: true }));
  ALR.demo = true;
  msg('#alListMsg', 'warn', t('alr.demoOn'));
  renderAlrList();
}

const alrPicked = () => ALR.rows.filter(r => r._pick !== false);

function docHeader() {
  const h = el('div', { className: 'doc-head' }, [
    el('div', { className: 'co', textContent: t('alr.doc.company') }),
    el('div', { className: 'addr', textContent: t('alr.doc.addr') }),
    el('div', { className: 'ttl', textContent: t('alr.doc.title') })
  ]);
  const meta = el('div', { className: 'doc-meta' }, [
    el('div', {}, [el('b', { textContent: t('alr.doc.no') }), $('#alCode').value || '—']),
    el('div', {}, [el('b', { textContent: t('alr.doc.date') }), fmtDate($('#alDate').value)]),
    el('div', {}, [el('b', { textContent: t('alr.doc.project') }), $('#alProject').value || '—'])
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
  } catch { svg.remove(); return el('code', { textContent: code }); }
  return svg;
}

function buildDoc() {
  const rows = alrPicked();
  const root = $('#printRoot');
  root.innerHTML = '';
  if (!rows.length) { msg('#alOutMsg', 'err', t('alr.nonePicked')); return; }

  root.append(...docHeader());

  const COLS = [['alr.doc.h.no', '4%'], ['alr.doc.h.code', '13%'], ['alr.doc.h.name', '15%'],
                ['alr.doc.h.qty', '6%'], ['alr.doc.h.spec', '24%'], ['alr.doc.h.price', '9%'],
                ['alr.doc.h.loc', '12%'], ['alr.doc.h.label', '17%']];
  const tb = el('table', { className: 'doc' });
  const cg = el('colgroup');
  for (const [, w] of COLS) cg.append(el('col', { style: 'width:' + w }));
  const hr = el('tr');
  for (const [k] of COLS) { const th = el('th'); th.innerHTML = t(k); hr.append(th); }
  tb.append(cg, el('thead', {}, hr));

  const body = el('tbody');
  rows.forEach((r, i) => {
    body.append(el('tr', {}, [
      el('td', { className: 'c', textContent: String(i + 1) }),
      el('td', { textContent: r.asset_code }),
      el('td', { textContent: [r.name_vi, r.name_en].filter(Boolean).join(' / ') }),
      el('td', { className: 'c',
                 textContent: fmtNum(r.qty) + (r.unit_code ? ' ' + r.unit_code : '') }),
      el('td', { textContent: specSummary(r) }),
      el('td', { className: 'r', textContent: fmtNum(r.unit_price) }),
      el('td', { textContent: [r.location_code, r.location_name].filter(Boolean).join(' — ') }),
      el('td', { className: 'lbl' }, barcodeSvg(r.barcode, { height: 26, width: 1.2, fontSize: 10 }))
    ]));
  });
  tb.append(body);
  root.append(tb);

  root.append(el('div', { className: 'doc-notes' }, [
    el('b', { textContent: t('alr.doc.notesTitle') }),
    document.createTextNode('\n' + $('#alNotes').value)
  ]));
  root.append(el('div', { className: 'doc-sign' }, [
    el('div', {}, [el('b', { textContent: t('alr.doc.prepared') }),
                   el('i', {}), document.createTextNode($('#alPrep').value || '')]),
    el('div', {}, [el('b', { textContent: t('alr.doc.received') }),
                   el('i', {}), document.createTextNode($('#alRecv').value || '')])
  ]));

  ALR.mode = 'doc';
  $('#btnAlPrint').disabled = false;
  $('#btnAlSave').disabled = ALR.demo || !SB.ready();
  msg('#alOutMsg', 'ok',
      t('alr.docBuilt', { code: $('#alCode').value || '', n: rows.length }) +
      (ALR.demo ? t('alr.docDemoNote') : ''));
}

function buildLabels() {
  const rows = alrPicked();
  const root = $('#printRoot');
  root.innerHTML = '';
  if (!rows.length) { msg('#alOutMsg', 'err', t('alr.nonePicked')); return; }

  root.append(...docHeader());
  root.append(el('div', { className: 'doc-notes', style: 'margin:0 0 6mm',
    textContent: t('alr.labelsNote', { n: rows.length }) }));

  const cols = Math.min(6, Math.max(1, Number($('#alCols').value) || 3));
  const sheet = el('div', { className: 'sheet', style: `--cols:${cols}` });
  for (const r of rows)
    sheet.append(el('div', { className: 'lab' }, [
      barcodeSvg(r.barcode, { height: 34, width: 1.5, fontSize: 12 }),
      el('div', { className: 'nm',
                  textContent: (LANG === 'vi' ? r.name_vi : r.name_en) || r.name_vi || '' }),
      el('div', { className: 'cd', textContent: r.asset_code })
    ]));
  root.append(sheet);

  ALR.mode = 'labels';
  $('#btnAlPrint').disabled = false;
  msg('#alOutMsg', 'ok', t('alr.labelsBuilt', { n: rows.length, c: cols }));
}

/* The 8-column receipt needs landscape; the label sheet needs portrait. */
function printNow() {
  document.getElementById('am-page-rule')?.remove();
  const st = el('style', { id: 'am-page-rule' });
  st.textContent = `@page{size:A4 ${ALR.mode === 'doc' ? 'landscape' : 'portrait'};margin:10mm}`;
  document.head.append(st);
  window.print();
}

async function saveAlr() {
  const rows = alrPicked();
  if (ALR.demo) return msg('#alOutMsg', 'err', t('alr.demoNoSave'));
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
    msg('#alOutMsg', 'ok', t('alr.saved', { code: alr.code, id: alr.id, n: rows.length }));
  } catch (e) { msg('#alOutMsg', 'err', t('alr.saveFail', { err: e.message })); }
}

async function fillAlrPickers() {
  try {
    const [deps, locs] = await Promise.all([
      SB.select('am_org', 'select=code,name_vi,name_en&is_department=is.true&order=code'),
      SB.select('am_location', 'select=code,name&order=code')
    ]);
    const d = $('#alDept'), l = $('#alLoc');
    while (d.options.length > 1) d.remove(1);
    while (l.options.length > 1) l.remove(1);
    for (const o of deps) d.append(el('option', { value: o.code,
      textContent: `${o.code} — ${(LANG === 'vi' ? o.name_vi : o.name_en) || o.name_vi}` }));
    for (const o of locs) l.append(el('option', { value: o.code,
      textContent: `${o.code} — ${o.name}` }));
    const sh = await SB.select('am_shipment',
      'select=id,code,delivery_date,purpose_code&order=id.desc&limit=100');
    const s = $('#alShip');
    while (s.options.length > 1) s.remove(1);
    for (const o of sh)
      s.append(el('option', { value: o.id, textContent:
        [o.code || '#' + o.id, o.purpose_code, o.delivery_date].filter(Boolean).join(' · ') }));
  } catch { /* the Connection screen already reports it */ }
}

function initAlr() {
  $('#alNotes').value = ALR_NOTES[LANG] || ALR_NOTES.en;
  $('#alDate').value = new Date().toISOString().slice(0, 10);
  const sync = () => { $('#alCode').value = alrCodeFromProject($('#alProject').value); };
  sync();
  $('#alProject').oninput = sync;
  $('#alShip').onchange = () => {
    const txt = $('#alShip').selectedOptions[0]?.textContent || '';
    const m = /\b((?:FFE|CAPEX)\.[A-Z]+\.\d+\.\d{4})\b/i.exec(txt);
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

/* --------------------------------------------------------- navigation */
/* Each entry is [viewId, labelKey, children?]. Children render one level
   deeper, so an item that belongs to another one sits under it rather than
   beside it. */
const NAV = [
  ['nav.catalog', [
    ['tbl:am_org', null, [['tbl:am_org_alias', null]]],
    ['cat', 'nav.cat'],
    ['tbl:am_unit', null], ['tbl:am_location', null], ['tbl:am_product', null]
  ]],
  ['nav.originGrp', [
    ['tbl:am_origin', null], ['tbl:am_origin_alias', null], ['tbl:am_origin_rejected', null]
  ]],
  ['nav.counters', [['counter', 'nav.counter'], ['rules', 'nav.rules']]],
  ['nav.registerGrp', [['intake', 'nav.intake'], ['register', 'nav.register']]],
  ['nav.docs',      [['alr', 'nav.alr']]],
  ['nav.backupGrp', [['backup', 'nav.backup']]],
  ['nav.system',    [['sources', 'nav.sources'], ['tbl:am_setting', null], ['setup', 'nav.setup']]]
];

let VIEW = 'setup';

/* Asset groups and category codes are one screen with a switch, because the
   28 category codes are meaningless without the 15 parent codes next to them.
   CAT_TABLE remembers which of the two the switch is on. */
const CAT_KEY = 'asset-intake.catTable';
let CAT_TABLE = 'am_category';
try { const v = localStorage.getItem(CAT_KEY);
      if (v === 'am_category_group' || v === 'am_category') CAT_TABLE = v; } catch {}

const viewTable = v => v.startsWith('tbl:') ? v.slice(4) : (v === 'cat' ? CAT_TABLE : null);
const viewTitle = v => v === 'cat' ? t('page.cat')
                     : v.startsWith('tbl:') ? tblLabel(v.slice(4)) : t('page.' + v);

/* Which nav groups are collapsed, remembered per browser. */
const NAV_SHUT_KEY = 'asset-intake.navShut';
let NAV_SHUT = new Set();
try { NAV_SHUT = new Set(JSON.parse(localStorage.getItem(NAV_SHUT_KEY) || '[]')); } catch {}
const navSaveShut = () => {
  try { localStorage.setItem(NAV_SHUT_KEY, JSON.stringify([...NAV_SHUT])); } catch {}
};

function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [grpKey, items] of NAV) {
    // A group holding the current view is always expanded, so the active item
    // can never be hidden inside a collapsed branch.
    const flat = items.flatMap(([id, , ch]) => [id, ...(ch || []).map(c => c[0])]);
    const holdsCurrent = flat.includes(VIEW);
    const shut = NAV_SHUT.has(grpKey) && !holdsCurrent;

    const kids = el('div', { className: 'kids' + (shut ? ' shut' : '') });
    const head = el('button', { className: 'grp' + (shut ? ' shut' : '') }, [
      el('span', { className: 'car', textContent: '▶' }),
      el('span', { textContent: t(grpKey) }),
      el('span', { className: 'n', textContent: String(flat.length) })
    ]);
    head.onclick = () => {
      const nowShut = !kids.classList.contains('shut');
      kids.classList.toggle('shut', nowShut);
      head.classList.toggle('shut', nowShut);
      if (nowShut) NAV_SHUT.add(grpKey); else NAV_SHUT.delete(grpKey);
      navSaveShut();
    };

    const addItem = (id, labelKey, depth) => {
      const a = el('a', { href: '#',
        textContent: labelKey ? t(labelKey) : tblLabel(id.slice(4)) });
      a.dataset.view = id;
      a.classList.toggle('on', id === VIEW);
      if (depth) a.classList.add('sub');
      a.onclick = ev => { ev.preventDefault(); showView(id); };
      kids.append(a);
    };
    for (const [id, labelKey, children] of items) {
      addItem(id, labelKey, 0);
      for (const [cid, ckey] of children || []) addItem(cid, ckey, 1);
    }
    nav.append(head, kids);
  }
}

/* The toolbar changes with the screen. */
function buildTools(view) {
  const box = $('#tools');
  box.innerHTML = '';
  const table = viewTable(view);
  if (table) {
    // The merged category screen gets a switch between the two tables.
    if (view === 'cat') {
      const seg = el('div', { className: 'seg' });
      for (const [tbl, key] of [['am_category', 'cat.codes'], ['am_category_group', 'cat.groups']]) {
        const b = el('button', { textContent: t(key) });
        b.classList.toggle('on', CAT_TABLE === tbl);
        b.onclick = () => {
          if (CAT_TABLE === tbl) return;
          CAT_TABLE = tbl;
          try { localStorage.setItem(CAT_KEY, tbl); } catch {}
          showView('cat');
        };
        seg.append(b);
      }
      box.append(seg);
    }
    const f = el('input', { id: 'filter', style: 'width:190px' });
    f.placeholder = t('tool.filter');
    f.oninput = () => renderGrid();
    const reload = el('button', { className: 'btn', textContent: t('tool.reload') });
    reload.onclick = () => loadTable(table);
    const add = el('button', { className: 'btn', textContent: t('tool.add') });
    add.onclick = addRow;
    const save = el('button', { className: 'btn pri', id: 'btnCommit',
                                textContent: t('tool.save'), disabled: true });
    save.onclick = commit;
    box.append(f, reload, add, save);
  } else if (view === 'counter') {
    const a = el('button', { className: 'btn', textContent: t('tool.loadStatus') });
    a.onclick = loadCounters;
    const b = el('button', { className: 'btn', textContent: t('tool.audit') });
    b.onclick = runAudit;
    box.append(a, b);
  } else if (view === 'backup') {
    const c = el('button', { className: 'btn', textContent: t('bk.count') });
    c.onclick = bkCount;
    box.append(c);
  } else if (view === 'register') {
    const cols = el('button', { className: 'btn', textContent: t('reg.cols') });
    cols.onclick = () => { const d = $('#regColsBox'); d.open = !d.open; };
    const rel = el('button', { className: 'btn', textContent: t('tool.reload') });
    rel.onclick = () => regLoad();
    const x = el('button', { className: 'btn', textContent: t('reg.xlsx') });
    x.onclick = regXlsx;
    const p = el('button', { className: 'btn pri', textContent: t('reg.print') });
    p.onclick = regPrint;
    box.append(cols, rel, x, p);
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
  if (viewTable(VIEW) && view !== VIEW && CUR) {
    const n = CUR.rows.filter(r => r.isNew || r.dirty || r.del).length;
    if (n && !confirm(t('table.confirmLeave', { n }))) return;
  }
  VIEW = view;
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  const table = viewTable(view);
  const sect = table ? 'v-table' : 'v-' + view;
  $$('section').forEach(s => s.classList.toggle('on', s.id === sect));
  buildTools(view);
  $('#pageTitle').textContent = viewTitle(view);

  if (table) {
    $('#tableLead').textContent = tblSub(table);
    CUR = null;
    loadTable(table);
  } else {
    if (view === 'counter' && SB.ready()) loadCounters();
    if (view === 'rules' && SB.ready()) fillPickers();
    if (view === 'alr' && SB.ready()) fillAlrPickers();
    if (view === 'backup' && SB.ready()) bkCount();
    if (view === 'sources' && SB.ready()) srcLoad();
    if (view === 'register' && SB.ready()) { regFillPickers(); regLoad(true); }
    if (view === 'intake' && SB.ready()) inFill();
  }
}

/* ------------------------------------------------------------- language */
function markLang() {
  $$('#langSeg button').forEach(b => b.classList.toggle('on', b.dataset.lang === LANG));
}

function switchLang(l) {
  if (!setLang(l)) return;
  applyI18n();
  markLang();
  buildNav();

  // The default notes text is only replaced while it is still untouched,
  // so a hand-edited version survives a language switch.
  const notes = $('#alNotes');
  if (notes && Object.values(ALR_NOTES).includes(notes.value.trim()))
    notes.value = ALR_NOTES[LANG] || ALR_NOTES.en;

  if (!CONN.ok) $('#connTxt').textContent = t('conn.none');
  renderAlrList();
  if (ALR.mode === 'doc') buildDoc();
  else if (ALR.mode === 'labels') buildLabels();
  if (SB.ready()) { fillPickers(); fillAlrPickers(); }
  showView(VIEW);
}

/* ------------------------------------------------------------- connect */
async function testConn(quiet) {
  if (!SB.ready()) { setConn(false, 'conn.none'); return false; }
  try {
    await SB.select('am_setting', 'select=key&limit=1');
    setConn(true, new URL(CFG.url).hostname);
    if (!quiet) msg('#setupMsg', 'ok', t('setup.ok'));
    return true;
  } catch (e) {
    setConn(false, 'conn.error');
    if (!quiet) msg('#setupMsg', 'err', e.message + t('setup.err.suffix'));
    return false;
  }
}

async function checkSchema() {
  const out = $('#checkOut');
  msg(out, 'info', t('setup.counting'));
  const extra = ['am_asset_seq', 'am_barcode_seq', 'am_counter_log', 'am_shipment',
                 'am_shipment_line', 'am_asset', 'am_alr', 'am_alr_line', 'am_alr_seq',
                 'am_xls_template', 'am_xls_column'];
  const names = [...Object.keys(TABLES), ...extra];
  const tb = el('table');
  tb.append(el('tr', {}, [t('setup.col.table'), t('setup.col.rows')]
    .map(h => el('th', { textContent: h }))));
  let bad = 0;
  for (const n of names) {
    let txt, cls = 'num';
    try { txt = fmtInt(await SB.count(n)); }
    catch { txt = t('setup.missing'); cls = 'num neg'; bad++; }
    tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: n })),
                            el('td', { className: cls, textContent: txt })]));
  }
  out.innerHTML = '';
  out.append(el('div', { className: 'msg ' + (bad ? 'err' : 'ok'),
    textContent: bad ? t('setup.missingTables', { n: bad })
                     : t('setup.allTables', { n: names.length }) }));
  for (const fn of ['am_audit_counters']) {
    try { await SB.rpc(fn); }
    catch (e) {
      out.append(el('div', { className: 'msg err',
        textContent: t('setup.fnFailed', { fn, err: e.message }) }));
    }
  }
  out.append(el('div', { className: 'wrap' }, tb));
}

/* ---------------------------------------------------------------- init */
function init() {
  applyI18n();
  markLang();
  $$('#langSeg button').forEach(b => { b.onclick = () => switchLang(b.dataset.lang); });
  buildNav();

  $('#btnSave').onclick = async () => {
    CFG = { url: $('#sbUrl').value.trim().replace(/\/+$/, ''), key: $('#sbKey').value.trim() };
    localStorage.setItem(LS_KEY, JSON.stringify(CFG));
    Object.keys(LOOK).forEach(k => delete LOOK[k]);
    if (await testConn()) fillPickers();
  };
  $('#btnLink').onclick = () => {
    if (!SB.ready()) return msg('#setupMsg', 'err', t('setup.needBoth'));
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(CFG))));
    const link = location.origin + location.pathname + '#sbcfg=' + encodeURIComponent(b64);
    navigator.clipboard?.writeText(link).catch(() => {});
    msg('#setupMsg', 'ok', t('setup.linkCopied', { link }));
  };
  $('#btnForget').onclick = () => {
    localStorage.removeItem(LS_KEY); CFG = { url: '', key: '' };
    $('#sbUrl').value = ''; $('#sbKey').value = '';
    setConn(false, 'conn.none');
    msg('#setupMsg', 'ok', t('setup.forgotten'));
  };
  $('#btnCheck').onclick = checkSchema;

  $('#btnScan').onclick = scanSeed;
  $('#btnSeed').onclick = runSeed;
  $('#btnClassify').onclick = doClassify;
  $('#btnOrigin').onclick = doOrigin;
  $('#btnPreview').onclick = doPreview;

  initAlr();
  initBackup();
  initSources();
  initRegister();
  initIntake();
  initLegacy();
  loadCfg();
  showView('setup');
  testConn(true).then(ok => { if (ok) { showView('tbl:am_org'); fillPickers(); } });
}
document.addEventListener('DOMContentLoaded', init);

/* =============================================================== BACKUP
   Pull  = read every table into one JSON file on this computer.
   Push  = load the MASTER DATA back from such a file.

   Push deliberately stops at master data. Assets, deliveries and label
   receipts use bigserial keys, so restoring them would also have to fix the
   sequences and reconcile the counters -- getting that wrong issues duplicate
   asset codes, which is exactly the failure this whole app exists to prevent. */

// Read order does not matter; WRITE order does, because of the foreign keys.
const BK_ALL = [
  'am_setting', 'am_org', 'am_org_alias', 'am_category_group', 'am_category',
  'am_unit', 'am_origin', 'am_origin_alias', 'am_origin_rejected',
  'am_location', 'am_product',
  'am_shipment', 'am_shipment_line', 'am_asset', 'am_alr', 'am_alr_line',
  'am_asset_seq', 'am_barcode_seq', 'am_counter_log'
];

// Parents before children. am_org and am_location also need an inner sort,
// because a row may reference another row of the same table.
const BK_PUSH = [
  'am_setting', 'am_org', 'am_org_alias', 'am_category_group', 'am_category',
  'am_unit', 'am_origin', 'am_origin_alias', 'am_origin_rejected',
  'am_location', 'am_product'
];
const BK_SELF_REF = { am_org: 'parent_code', am_location: 'parent_code' };
const BK_PK = {
  am_setting: 'key', am_org: 'code', am_org_alias: 'alias',
  am_category_group: 'code', am_category: 'code', am_unit: 'code',
  am_origin: 'iso2', am_origin_alias: 'alias_norm', am_origin_rejected: 'raw_norm',
  am_location: 'code', am_product: 'raw_name_norm'
};

const BK_PAGE = 1000;   // PostgREST caps a plain select at 1000 rows
const BK_CHUNK = 400;   // rows per upsert request

async function bkSelectAll(table) {
  const rows = [];
  for (let off = 0; ; off += BK_PAGE) {
    const page = await SB.select(table, `select=*&limit=${BK_PAGE}&offset=${off}`);
    rows.push(...page);
    if (page.length < BK_PAGE) break;
  }
  return rows;
}

function bkDownload(text, filename, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const bkStamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');

async function bkCount() {
  const out = $('#bkCounts');
  msg(out, 'info', t('bk.counting'));
  try {
    const tb = el('table');
    tb.append(el('tr', {}, [t('setup.col.table'), t('setup.col.rows')]
      .map(h => el('th', { textContent: h }))));
    let total = 0;
    for (const table of BK_ALL) {
      let txt, cls = 'num';
      try { const n = await SB.count(table); total += n; txt = fmtInt(n); }
      catch { txt = t('setup.missing'); cls = 'num neg'; }
      tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: table })),
                              el('td', { className: cls, textContent: txt })]));
    }
    out.innerHTML = '';
    const kpis = el('div', { className: 'kpis' });
    kpis.append(el('div', { className: 'kpi n' }, [
      el('label', { textContent: t('bk.h.counts') }),
      el('b', { textContent: fmtInt(total) }),
      el('small', { textContent: `${BK_ALL.length} tables` })
    ]));
    out.append(kpis);
    const d = el('details');
    d.append(el('summary', { textContent: t('bk.h.counts') }));
    d.append(el('div', { className: 'wrap' }, tb));
    out.append(d);
  } catch (e) { msg(out, 'err', e.message); }
}

async function bkPull() {
  const out = $('#bkPullMsg');
  const snap = { meta: { app: 'PHCL Asset Intake', at: new Date().toISOString(),
                         host: CFG.url, lang: LANG }, tables: {} };
  let rows = 0, table = '';
  try {
    for (table of BK_ALL) {
      msg(out, 'info', t('bk.pulling', { table }));
      snap.tables[table] = await bkSelectAll(table);
      rows += snap.tables[table].length;
    }
  } catch (e) { return msg(out, 'err', t('bk.err', { table, err: e.message })); }
  const file = `phcl-asset-snapshot-${bkStamp()}.json`;
  bkDownload(JSON.stringify(snap, null, 1), file);
  msg(out, 'ok', t('bk.pulled', { file, n: BK_ALL.length, rows: fmtInt(rows) }));
}

async function bkXlsx() {
  const out = $('#bkPullMsg');
  let table = '';
  try {
    const wb = XLSX.utils.book_new();
    for (table of BK_PUSH) {
      const data = await bkSelectAll(table);
      // Sheet names are capped at 31 characters by the format itself.
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data),
                                   table.replace(/^am_/, '').slice(0, 31));
    }
    XLSX.writeFile(wb, `phcl-master-data-${bkStamp()}.xlsx`);
    msg(out, 'ok', t('bk.pulled', { file: `phcl-master-data-${bkStamp()}.xlsx`,
                                    n: BK_PUSH.length, rows: '-' }));
  } catch (e) { msg(out, 'err', t('bk.err', { table, err: e.message })); }
}

/* Postgres refuses an upsert whose batch contains the same key twice
   ("ON CONFLICT DO UPDATE command cannot affect row a second time"), so any
   duplicate has to be collapsed before the request goes out. The last
   occurrence wins, matching how a sequence of single upserts would end up. */
function dedupeBy(rows, pk) {
  if (!pk) return rows;
  const seen = new Map();
  for (const r of rows) seen.set(String(r[pk]), r);
  return [...seen.values()];
}

/* Order self-referencing rows so a parent is always written before its child. */
function bkSortByDepth(rows, pkField, parentField) {
  const have = new Set(rows.map(r => r[pkField]));
  const done = new Set();
  const outRows = [];
  let guard = 0;
  while (outRows.length < rows.length && guard++ < 50) {
    for (const r of rows) {
      if (done.has(r[pkField])) continue;
      const p = r[parentField];
      // A parent outside this snapshot is already on the server, so it is fine.
      if (!p || !have.has(p) || done.has(p)) { outRows.push(r); done.add(r[pkField]); }
    }
  }
  for (const r of rows) if (!done.has(r[pkField])) outRows.push(r);
  return outRows;
}

async function bkReadFile() {
  const f = $('#bkFile').files?.[0];
  if (!f) { return null; }
  return JSON.parse(await f.text());
}

async function bkPush() {
  const out = $('#bkPushMsg');
  let snap;
  try {
    snap = await bkReadFile();
    if (!snap) return msg(out, 'err', t('bk.noFile'));
    if (!snap.tables) throw new Error('missing "tables"');
  } catch (e) { return msg(out, 'err', t('bk.badFile', { err: e.message })); }

  const host = CFG.url ? new URL(CFG.url).hostname : '?';
  if (!confirm(t('bk.pushConfirm', { host, at: (snap.meta?.at || '?').slice(0, 19) }))) return;

  let tables = 0, rows = 0, table = '';
  try {
    for (table of BK_PUSH) {
      let data = snap.tables[table];
      if (!Array.isArray(data) || !data.length) continue;
      data = dedupeBy(data, BK_PK[table]);
      if (BK_SELF_REF[table]) data = bkSortByDepth(data, BK_PK[table], BK_SELF_REF[table]);
      for (let i = 0; i < data.length; i += BK_CHUNK) {
        msg(out, 'info', t('bk.pushing', { table, done: i, total: data.length }));
        await SB.call(table, {
          method: 'POST',
          headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify(data.slice(i, i + BK_CHUNK))
        });
      }
      tables++; rows += data.length;
    }
  } catch (e) { return msg(out, 'err', t('bk.err', { table, err: e.message })); }

  Object.keys(LOOK).forEach(k => delete LOOK[k]);
  const skipped = BK_ALL.filter(x => !BK_PUSH.includes(x) && snap.tables[x]?.length);
  out.innerHTML = '';
  out.append(el('div', { className: 'msg ok',
    textContent: t('bk.pushed', { n: tables, rows: fmtInt(rows) }) }));
  if (skipped.length)
    out.append(el('div', { className: 'msg warn',
      textContent: t('bk.pushSkip', { list: skipped.join(', ') }) }));
}

async function bkReseed() {
  const out = $('#bkReseedMsg');
  let snap;
  try {
    snap = await bkReadFile();
    if (!snap) return msg(out, 'err', t('bk.noFile'));
  } catch (e) { return msg(out, 'err', t('bk.badFile', { err: e.message })); }

  // Reuse the scanner from the counter screen: keep only the highest number
  // per key, so the request stays small however big the snapshot is.
  const acc = { asset: new Map(), bar: new Map(), nAsset: 0, nBar: 0, files: [] };
  for (const a of (snap.tables?.am_asset || []))
    scanText(`${a.asset_code || ''} ${a.barcode || ''}`.toUpperCase(), acc);

  const codes = [...[...acc.asset.values()].map(v => v.code),
                 ...[...acc.bar.values()].map(v => v.code)];
  if (!codes.length) return msg(out, 'warn', t('bk.reseedNone'));
  try {
    const res = await SB.rpc('am_seed_from_codes', { p_codes: codes });
    msg(out, 'ok', t('bk.reseedDone', { n: (res || []).length, c: codes.length }));
  } catch (e) { msg(out, 'err', e.message); }
}

function initBackup() {
  $('#btnBkPull').onclick = bkPull;
  $('#btnBkXlsx').onclick = bkXlsx;
  $('#btnBkPush').onclick = bkPush;
  $('#btnBkReseed').onclick = bkReseed;
}

/* ========================================================== DATA SOURCES
   Shows which master data is live, where it came from and when it landed,
   and imports the Beetrack template workbooks straight into Supabase.

   The row-shaping rules below mirror scripts/genseed.ps1. Change one and you
   must change the other, or the in-app import and the generated SQL seed will
   disagree about the same workbook. */

const SRC_TABLES = ['am_org', 'am_category_group', 'am_category', 'am_unit',
                    'am_origin', 'am_location', 'am_product'];

// Workbooks are recognised by sheet name, so file names and order do not matter.
const SRC_SHEET = {
  'Categories':      'cat',
  'DepartmentList':  'dept',
  'Group&Trackable': 'loc',
  'ProductCatalogue':'prod'
};

const srcTxt = v => (v == null ? '' : String(v).trim());

/* Read one workbook into { kind, tables: { am_x: [rows] } }. */
function srcParse(wb, fileName) {
  const grid = name => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 'A', defval: '' });
  let kind = null;
  for (const s of wb.SheetNames) if (SRC_SHEET[s]) { kind = SRC_SHEET[s]; break; }

  if (!kind) {
    // The unit and origin workbooks have generic sheet names, so they are
    // detected by header. Match the WHOLE cell, never a substring: the asset
    // register has a column called "Mã Đơn Vị Tính", and a substring test
    // mistook that whole 17k-row export for the unit list.
    const h = grid(wb.SheetNames[0])[0] || {};
    const cells = Object.values(h).map(v => srcTxt(v).toLowerCase());
    const has = s => cells.includes(s);
    if (has('mã đơn vị') && has('tên') && cells.length <= 4) kind = 'unit';
    else if (has('mã xuất xứ') && has('tên') && cells.length <= 4) kind = 'origin';
    // The Beetrack asset-register export is the file people reach for first.
    // Name it explicitly instead of letting it fall through to "not recognised".
    else if (has('mã tài sản') && has('mã vạch')) kind = 'register';
  }
  if (kind === 'register') return { kind, file: fileName, tables: {} };
  if (!kind) return null;

  const out = { kind, file: fileName, tables: {} };

  if (kind === 'dept') {
    const rows = grid('DepartmentList').slice(1).filter(r => srcTxt(r.B));
    const byCode = {}; rows.forEach(r => byCode[srcTxt(r.B)] = r);
    const depth = c => { let n = 0, x = c; while (x && byCode[x] && srcTxt(byCode[x].C)) { x = srcTxt(byCode[x].C); n++; if (n > 6) break; } return n; };
    const lvl = ['TCT', 'BRANCH', 'DEPT1', 'DEPT2', 'DEPT2'];
    const companies = ['PHCL', 'JVC', 'CP', 'CEN', 'SOF'];
    out.tables.am_org = rows.map(r => ({
      code: srcTxt(r.B), name_vi: srcTxt(r.F) || srcTxt(r.D), name_en: srcTxt(r.D),
      level: lvl[depth(srcTxt(r.B))] || 'DEPT2',
      is_company: companies.includes(srcTxt(r.B)), is_department: true,
      parent_code: srcTxt(r.C) || null
    }));
  }

  if (kind === 'cat') {
    const rows = grid('Categories').slice(1).filter(r => srcTxt(r.B));
    const groups = [], types = [], seen = {};
    for (const r of rows) {
      if (srcTxt(r.G) === '2') { if (!seen[srcTxt(r.B)]) { seen[srcTxt(r.B)] = 1; groups.push(r); } }
      else types.push(r);
    }
    let i = 0;
    out.tables.am_category_group = groups.map(r => ({
      code: srcTxt(r.B), name_vi: srcTxt(r.D), name_en: srcTxt(r.E),
      is_intangible: /^C213/.test(srcTxt(r.B)), is_tools: /^C242/.test(srcTxt(r.B)),
      sort_order: (i += 10)
    }));
    out.tables.am_category = types.map(r => {
      const code = srcTxt(r.B), letters = code.replace('-QR', '');
      const quantity = /^(STG|LTG)/.test(code);
      return {
        code, group_code: srcTxt(r.C), name_vi: srcTxt(r.D), name_en: srcTxt(r.E),
        label_letters: letters, manage_by: quantity ? 'quantity' : 'code',
        note: code.endsWith('-QR') ? 'One shared QR label for the whole batch ("Cung QR").'
              : quantity ? 'A separate QR label per unit ("Khac QR").' : null
      };
    });
  }

  if (kind === 'unit') {
    const rows = grid(wb.SheetNames[0]).slice(1).filter(r => srcTxt(r.B));
    let i = 0;
    out.tables.am_unit = rows.map(r => ({
      code: srcTxt(r.B), name_en: srcTxt(r.A), sort_order: (i += 10)
    }));
  }

  if (kind === 'origin') {
    const rows = grid(wb.SheetNames[0]).slice(1).filter(r => /^[A-Z]{2}$/.test(srcTxt(r.A)));
    out.tables.am_origin = rows.map(r => ({ iso2: srcTxt(r.A), name_en: srcTxt(r.B) }));
  }

  if (kind === 'loc') {
    const list = [];
    for (const r of grid('Group&Trackable').slice(1)) {
      if (!srcTxt(r.C)) continue;
      list.push({ code: srcTxt(r.C), parent_code: srcTxt(r.D) || null, name: srcTxt(r.E),
                  kind: srcTxt(r.B) === '1' ? 'building' : 'floor' });
    }
    if (wb.Sheets['Internal']) {
      for (const r of grid('Internal').slice(1)) {
        if (!srcTxt(r.C)) continue;
        // NB: the Internal sheet puts the parent in B and the code in C.
        list.push({ code: srcTxt(r.C), parent_code: srcTxt(r.B) || null, name: srcTxt(r.D),
                    kind: 'room' });
      }
    }
    out.tables.am_location = list;
  }

  if (kind === 'prod') {
    const rows = grid('ProductCatalogue').slice(1).filter(r => srcTxt(r.D));
    const seen = {};
    out.tables.am_product = rows.filter(r => {
      const k = srcTxt(r.D).toLowerCase();
      if (seen[k]) return false; seen[k] = 1; return true;
    }).map(r => {
      const full = srcTxt(r.D), i = full.indexOf('/');
      return {
        raw_name: full,
        raw_name_norm: srcNorm(full),
        std_name_vi: i > 0 ? full.slice(0, i).trim() : full,
        std_name_en: i > 0 ? full.slice(i + 1).trim() : null,
        default_category: srcTxt(r.C) || null,
        default_unit: srcTxt(r.H) || null,
        default_brand: srcTxt(r.F) || null
      };
    });
  }
  return out;
}

/* Must produce exactly what am_norm() produces in Postgres, because that is
   the key am_product is looked up by. Same character table as 03_functions.sql. */
const SRC_FROM = 'áàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ'
               + 'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ';
const SRC_TO   = 'aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy'
               + 'aaaaaaceeeeiiiinooooouuuuyy';
function srcNorm(s) {
  let r = '';
  for (const ch of String(s).toLowerCase()) {
    const i = SRC_FROM.indexOf(ch);
    r += i >= 0 ? SRC_TO[i] : ch;
  }
  return r.trim().replace(/\s+/g, ' ');
}

let SRC_PENDING = null;

async function srcRead() {
  const out = $('#srcMsg');
  const files = [...($('#srcFiles').files || [])];
  if (!files.length) return msg(out, 'err', t('bk.noFile'));
  const found = [], skipped = [];
  msg(out, 'info', t('src.loading'));
  for (const f of files) {
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const parsed = srcParse(wb, f.name);
      if (parsed) found.push(parsed); else skipped.push(f.name);
    } catch (e) { skipped.push(`${f.name} (${e.message})`); }
  }
  out.innerHTML = '';

  // The asset register is recognised but NOT imported here: this screen only
  // refreshes master data. Say so plainly rather than "not recognised".
  const regs = found.filter(p => p.kind === 'register');
  const master = found.filter(p => p.kind !== 'register');
  for (const r of regs)
    out.append(el('div', { className: 'msg warn', textContent: t('src.isRegister', { file: r.file }) }));

  if (!master.length) {
    $('#btnSrcImport').disabled = true;
    if (!regs.length) msg(out, 'warn', t('src.nothing'));
    return;
  }
  found.length = 0; found.push(...master);
  SRC_PENDING = found;
  out.append(el('div', { className: 'msg info', textContent: t('src.recognised', { n: found.length }) }));
  const tb = el('table');
  tb.append(el('tr', {}, [t('src.col.file'), t('src.col.table'), t('src.col.rows')]
    .map(h => el('th', { textContent: h }))));
  for (const p of found)
    for (const [tbl, rows] of Object.entries(p.tables))
      tb.append(el('tr', {}, [
        el('td', { textContent: p.file }),
        el('td', {}, el('code', { textContent: tbl })),
        el('td', { className: 'num', textContent: fmtInt(rows.length) })
      ]));
  out.append(el('div', { className: 'wrap' }, tb));
  for (const s of skipped)
    out.append(el('div', { className: 'msg warn', textContent: t('src.unknown', { file: s }) }));
  $('#btnSrcImport').disabled = false;
}

// Parents before children, and category groups before the types that use them.
const SRC_ORDER = ['am_org', 'am_category_group', 'am_category', 'am_unit',
                   'am_origin', 'am_location', 'am_product'];

async function srcImport() {
  if (!SRC_PENDING) return;
  const out = $('#srcMsg');
  const merged = {}, fileOf = {};
  for (const p of SRC_PENDING)
    for (const [tbl, rows] of Object.entries(p.tables)) { merged[tbl] = rows; fileOf[tbl] = p.file; }

  let nT = 0, nR = 0, table = '';
  try {
    for (table of SRC_ORDER) {
      let rows = merged[table];
      if (!rows?.length) continue;
      rows = dedupeBy(rows, BK_PK[table]);
      if (table === "am_org" || table === "am_location")
        rows = bkSortByDepth(rows, "code", "parent_code");
      for (let i = 0; i < rows.length; i += BK_CHUNK) {
        msg(out, 'info', t('src.importing', { table, done: i, total: rows.length }));
        await SB.call(table, {
          method: 'POST',
          headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify(rows.slice(i, i + BK_CHUNK))
        });
      }
      await SB.insert('am_data_source', [{
        table_name: table, source_file: fileOf[table], source_kind: 'beetrack-template',
        rows_loaded: rows.length, loaded_by: $('#srcWho').value.trim() || null
      }]);
      nT++; nR += rows.length;
    }
  } catch (e) { return msg(out, 'err', t('src.importFail', { table, err: e.message })); }

  Object.keys(LOOK).forEach(k => delete LOOK[k]);
  msg(out, 'ok', t('src.imported', { n: nT, rows: fmtInt(nR) }));
  $('#btnSrcImport').disabled = true;
  SRC_PENDING = null;
  srcLoad();
}

async function srcLoad() {
  const cur = $('#srcCurrent'), hist = $('#srcHistory');
  msg(cur, 'info', t('src.loading'));
  try {
    const [latest, log] = await Promise.all([
      SB.select('am_data_source_current', 'select=*'),
      SB.select('am_data_source', 'select=*&order=loaded_at.desc&limit=40')
    ]);
    const byTable = new Map(latest.map(r => [r.table_name, r]));

    const tb = el('table');
    tb.append(el('tr', {}, ['src.col.table', 'src.col.rows', 'src.col.file',
      'src.col.when', 'src.col.kind', 'src.col.by'].map(k => el('th', { textContent: t(k) }))));
    for (const table of SRC_TABLES) {
      let n = '—';
      try { n = fmtInt(await SB.count(table)); } catch {}
      const r = byTable.get(table);
      tb.append(el('tr', {}, [
        el('td', {}, el('code', { textContent: table })),
        el('td', { className: 'num', textContent: n }),
        el('td', { textContent: r?.source_file || t('src.never') }),
        el('td', { textContent: (r?.loaded_at || '').slice(0, 19).replace('T', ' ') }),
        el('td', { textContent: r ? t('src.kind.' + r.source_kind) : '' }),
        el('td', { textContent: r?.loaded_by || '' })
      ]));
    }
    cur.innerHTML = '';
    cur.append(el('div', { className: 'wrap' }, tb));

    hist.innerHTML = '';
    if (!log.length) { msg(hist, 'warn', t('src.noHistory')); return; }
    const h = el('table');
    // "Rows loaded", not "Rows now": this is the count AT THE TIME of that
    // import, frozen in the log — it does not follow the table afterwards.
    h.append(el('tr', {}, ['src.col.when', 'src.col.table', 'src.col.file',
      'src.col.loaded', 'src.col.kind', 'src.col.by'].map(k => el('th', { textContent: t(k) }))));
    for (const r of log)
      h.append(el('tr', {}, [
        el('td', { textContent: (r.loaded_at || '').slice(0, 19).replace('T', ' ') }),
        el('td', {}, el('code', { textContent: r.table_name })),
        el('td', { textContent: r.source_file || '' }),
        el('td', { className: 'num', textContent: fmtInt(r.rows_loaded) }),
        el('td', { textContent: t('src.kind.' + r.source_kind) }),
        el('td', { textContent: r.loaded_by || '' })
      ]));
    hist.append(el('div', { className: 'wrap' }, h));
  } catch (e) {
    msg(cur, 'err', e.message + '\nsql/07_data_source.sql');
  }
}

function initSources() {
  $('#btnSrcRead').onclick = srcRead;
  $('#btnSrcImport').onclick = srcImport;
}

/* ========================================================= ASSET REGISTER
   Every asset that already carries a code. 17k rows is far too many to put in
   the DOM, so filtering, sorting and paging all happen on the server; only one
   page is ever rendered. Export walks the same filter page by page. */

const REG_COLS = [
  'asset_code', 'barcode', 'asset_kind', 'name_vi', 'name_en',
  'category_code', 'group_code', 'letters', 'seq', 'purchase_year',
  'company_code', 'dept_code', 'location_code',
  'qty', 'unit_code', 'unit_price', 'currency', 'serial',
  'origin_iso2', 'supplier', 'manufacturer', 'invoice_no', 'purpose_code',
  'purchase_date', 'in_use_date', 'depreciate', 'depreciate_months',
  'spec_brand', 'spec_model', 'spec_function', 'spec_capacity',
  'spec_length', 'spec_width', 'spec_height', 'spec_weight',
  'spec_material', 'spec_color', 'spec_shape', 'spec_radius', 'spec_fuel',
  'spec_area', 'spec_perimeter', 'spec_mfg_year', 'spec_accessory',
  'description', 'status_code', 'label_printed', 'note', 'created_at'
];
const REG_DEFAULT = ['asset_code', 'barcode', 'name_vi', 'category_code',
                     'dept_code', 'location_code', 'qty', 'unit_code',
                     'unit_price', 'purchase_year', 'status_code'];
/* How each column is rendered. Only money and quantities are right-aligned —
   header included — everything else reads better ranged left.
   Years and sequence numbers are numeric but are NOT quantities: a thousands
   separator turns 2026 into "2,026", so they print as plain digits. */
const REG_RIGHT = new Set(['qty', 'unit_price', 'depreciate_months']);
const REG_PLAIN = new Set(['seq', 'purchase_year', 'spec_mfg_year']);
const REG_DATE  = new Set(['purchase_date', 'in_use_date', 'created_at']);

function regCell(col, v) {
  if (v == null || v === '') return '';
  if (REG_RIGHT.has(col)) return fmtNum(v);
  if (REG_PLAIN.has(col)) return String(v);
  // created_at is a timestamptz; the date half is all the register shows.
  if (REG_DATE.has(col)) return fmtDate(String(v).slice(0, 10));
  if (typeof v === 'boolean') return v ? '✔' : '';
  return String(v);
}

const REG_KEY = 'asset-intake.regCols';
const REG_SIZE = 100;
let REG = { cols: null, sort: 'asset_code', dir: 'asc', page: 0, total: 0, rows: [] };

function regLoadCols() {
  try {
    const saved = JSON.parse(localStorage.getItem(REG_KEY) || 'null');
    // Drop anything that is no longer a real column, so an old saved layout
    // cannot ask PostgREST for a field that does not exist.
    if (Array.isArray(saved) && saved.length) {
      REG.cols = saved.filter(c => REG_COLS.includes(c));
      if (REG.cols.length) return;
    }
  } catch {}
  REG.cols = [...REG_DEFAULT];
}
const regSaveCols = () => {
  try { localStorage.setItem(REG_KEY, JSON.stringify(REG.cols)); } catch {}
};

function regFilters() {
  const f = [];
  const q = $('#regQ').value.trim();
  if (q) {
    const safe = q.replace(/[(),*]/g, ' ').trim();
    if (safe) f.push(`or=(asset_code.ilike.*${safe}*,name_vi.ilike.*${safe}*,` +
                     `name_en.ilike.*${safe}*,barcode.ilike.*${safe}*)`);
  }
  if ($('#regDept').value) f.push('dept_code=eq.' + $('#regDept').value);
  if ($('#regCat').value)  f.push('category_code=eq.' + $('#regCat').value);
  if ($('#regKind').value) f.push('asset_kind=eq.' + $('#regKind').value);
  const y = $('#regYear').value.trim();
  if (y) f.push('purchase_year=eq.' + Number(y));
  return f;
}

async function regLoad(resetPage) {
  if (resetPage) REG.page = 0;
  const out = $('#regMsg');
  msg(out, 'info', t('reg.loading'));
  try {
    const sel = ['id', ...REG.cols].join(',');
    const q = ['select=' + sel, `order=${REG.sort}.${REG.dir}`,
               `limit=${REG_SIZE}`, `offset=${REG.page * REG_SIZE}`, ...regFilters()];
    const { body, range } = await SB.call('am_asset?' + q.join('&'),
      { headers: SB.hdr({ Prefer: 'count=exact' }) });
    REG.rows = body || [];
    REG.total = Number(String(range || '').split('/')[1]) || REG.rows.length;
    msg(out, '', '');
    regRender();
  } catch (e) { msg(out, 'err', e.message); }
}

function regRender() {
  const head = $('#regGrid thead'), body = $('#regGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  const hr = el('tr');
  for (const c of REG.cols) {
    // The header carries the same alignment as its cells, so a money column
    // reads as one right-ranged block instead of a left title over right digits.
    const th = el('th', { className: 'sortable' + (REG_RIGHT.has(c) ? ' num' : '') });
    th.append(document.createTextNode(c));
    if (REG.sort === c) th.append(el('span', { className: 'dir',
                                               textContent: REG.dir === 'asc' ? '▲' : '▼' }));
    th.onclick = () => {
      if (REG.sort === c) REG.dir = REG.dir === 'asc' ? 'desc' : 'asc';
      else { REG.sort = c; REG.dir = 'asc'; }
      regLoad(true);
    };
    hr.append(th);
  }
  head.append(hr);

  for (const r of REG.rows) {
    const tr = el('tr');
    for (const c of REG.cols) {
      tr.append(el('td', {
        className: REG_RIGHT.has(c) ? 'num' : '',
        textContent: regCell(c, r[c])
      }));
    }
    body.append(tr);
  }
  if (!REG.rows.length)
    body.append(el('tr', {}, el('td', { colSpan: REG.cols.length || 1,
      style: 'color:var(--dim);padding:14px', textContent: t('reg.empty') })));

  const pages = Math.max(1, Math.ceil(REG.total / REG_SIZE));
  $('#regPage').textContent =
    t('reg.count', { shown: fmtInt(REG.rows.length), total: fmtInt(REG.total) }) +
    ' · ' + t('reg.page', { p: REG.page + 1, n: pages });
  $('#btnRegPrev').disabled = REG.page <= 0;
  $('#btnRegNext').disabled = REG.page + 1 >= pages;
}

function regRenderCols() {
  const box = $('#regCols');
  box.innerHTML = '';
  // Chosen columns first, in their display order, then everything else.
  const rest = REG_COLS.filter(c => !REG.cols.includes(c));
  const list = [...REG.cols, ...rest];
  for (const c of list) {
    const on = REG.cols.includes(c);
    const row = el('div', { className: 'ci' + (on ? ' on' : '') });
    const cb = el('input', { type: 'checkbox', checked: on });
    cb.onchange = () => {
      if (cb.checked) REG.cols.push(c);
      else REG.cols = REG.cols.filter(x => x !== c);
      if (!REG.cols.length) REG.cols = [c];
      regSaveCols(); regRenderCols(); regLoad(true);
    };
    row.append(cb, el('span', { textContent: c }));
    if (on) {
      const i = REG.cols.indexOf(c);
      const up = el('button', { textContent: '◀', title: t('reg.up'), disabled: i === 0 });
      const dn = el('button', { textContent: '▶', title: t('reg.down'),
                                disabled: i === REG.cols.length - 1 });
      up.onclick = () => { REG.cols.splice(i - 1, 0, REG.cols.splice(i, 1)[0]);
                           regSaveCols(); regRenderCols(); regRender(); };
      dn.onclick = () => { REG.cols.splice(i + 1, 0, REG.cols.splice(i, 1)[0]);
                           regSaveCols(); regRenderCols(); regRender(); };
      row.append(up, dn);
    }
    box.append(row);
  }
}

/* Walk the current filter page by page — used by both export paths. */
async function regFetchAll(onProgress) {
  const sel = REG.cols.join(',');
  const all = [];
  for (let off = 0; ; off += 1000) {
    const q = ['select=' + sel, `order=${REG.sort}.${REG.dir}`,
               `limit=1000`, `offset=${off}`, ...regFilters()];
    const page = await SB.select('am_asset', q.join('&'));
    all.push(...page);
    onProgress?.(all.length);
    if (page.length < 1000) break;
  }
  return all;
}

async function regXlsx() {
  const out = $('#regMsg');
  try {
    msg(out, 'info', t('reg.exporting'));
    const rows = await regFetchAll(n => msg(out, 'info', t('reg.exporting') + ' ' + fmtInt(n)));
    // Reorder each object so the sheet columns follow the chosen order.
    const shaped = rows.map(r => Object.fromEntries(REG.cols.map(c => [c, r[c]])));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shaped), 'Assets');
    const file = `phcl-asset-register-${bkStamp()}.xlsx`;
    XLSX.writeFile(wb, file);
    msg(out, 'ok', t('reg.exported', { n: fmtInt(rows.length), file }));
  } catch (e) { msg(out, 'err', e.message); }
}

async function regPrint() {
  const out = $('#regMsg');
  try {
    msg(out, 'info', t('reg.exporting'));
    const rows = await regFetchAll();
    const root = $('#printRoot');
    root.innerHTML = '';
    root.append(el('div', { className: 'doc-head' }, [
      el('div', { className: 'co', textContent: t('alr.doc.company') }),
      el('div', { className: 'ttl', textContent: t('page.register') })
    ]));
    root.append(el('div', { className: 'doc-meta' }, [
      el('div', {}, [el('b', { textContent: t('alr.doc.date') }),
                     new Date().toISOString().slice(0, 10)]),
      el('div', {}, [el('b', { textContent: '' }),
                     t('reg.count', { shown: fmtInt(rows.length), total: fmtInt(REG.total) })])
    ]));
    const tb = el('table', { className: 'doc' });
    tb.append(el('thead', {}, el('tr', {}, REG.cols.map(c =>
      el('th', { className: REG_RIGHT.has(c) ? 'r' : '', textContent: c })))));
    const tbody = el('tbody');
    for (const r of rows)
      tbody.append(el('tr', {}, REG.cols.map(c => el('td', {
        className: REG_RIGHT.has(c) ? 'r' : '',
        textContent: regCell(c, r[c])
      }))));
    tb.append(tbody);
    root.append(tb);
    msg(out, '', '');
    ALR.mode = 'doc';          // the register is wide: print it landscape
    printNow();
  } catch (e) { msg(out, 'err', e.message); }
}

async function regFillPickers() {
  try {
    const [deps, cats] = await Promise.all([
      SB.select('am_org', 'select=code&is_department=is.true&order=code'),
      SB.select('am_category', 'select=code&order=code')
    ]);
    const fill = (sel, rows) => {
      const s = $(sel), keep = s.value;
      while (s.options.length > 1) s.remove(1);
      for (const r of rows) s.append(el('option', { value: r.code, textContent: r.code }));
      s.value = keep;
    };
    fill('#regDept', deps); fill('#regCat', cats);
  } catch { /* the Connection screen already reports it */ }
}

function initRegister() {
  regLoadCols();
  regRenderCols();
  $('#btnRegApply').onclick = () => regLoad(true);
  $('#btnRegReset').onclick = () => {
    $('#regQ').value = ''; $('#regDept').value = ''; $('#regCat').value = '';
    $('#regKind').value = ''; $('#regYear').value = '';
    regLoad(true);
  };
  $('#regQ').onkeydown = ev => { if (ev.key === 'Enter') regLoad(true); };
  $('#btnRegColsReset').onclick = () => {
    REG.cols = [...REG_DEFAULT]; regSaveCols(); regRenderCols(); regLoad(true);
  };
  $('#btnRegPrev').onclick = () => { if (REG.page > 0) { REG.page--; regLoad(); } };
  $('#btnRegNext').onclick = () => { REG.page++; regLoad(); };
}

/* ============================================================ NEW DELIVERY
   Enter the goods of one delivery, apply the rules, allocate the codes and
   commit to am_asset. Nothing is written until Confirm.

   Export format: "asset-template-file (Beetrack - original).xlsx" — the sheet
   Beetrack actually accepts on upload. Unique asset is A..AX, Low-value is
   A..AJ, and in BOTH the asset code sits in H and the barcode in K.
   The workbook is built from scratch rather than by editing the template, so
   no sample row's Text (@) number format can survive and corrupt the numbers
   and dates. */

const BT_UNIQUE = [
  ['STT (*)', '#'], ['Asset Id', null], ['Mã Sản Phẩm', null],
  ['Mã Danh Mục (*)', 'category_code'], ['Tên (*)', '#name'], ['Tên Khác', null],
  ['Mô Tả', 'description'], ['Mã Tài Sản', 'asset_code'], ['Mã Tài Sản Cha', null],
  ['Mã Dự Án', 'purpose_code'], ['Mã Vạch', 'barcode'], ['Biển Số Xe', null],
  ['Số Lượng Ban Đầu', 'qty'], ['Số Lượng', 'qty'], ['Đơn Vị Tính', 'unit_code'],
  ['Số Seri', 'serial'], ['Mã Vị Trí (*)', 'location_code'], ['Mã Phòng', null],
  ['Mã Phòng Ban', 'dept_code'], ['Mã Phòng Ban Quản Lý', null],
  ['Mã Công Ty Thành Viên (*)', 'company_code'], ['Mã Người Dùng', null],
  ['Mã Thiết Bị', null], ['Mã Xuất Xứ', 'origin_iso2'], ['Mã Nhà Cung Cấp', null],
  ['Mã Nhà Sản Xuất', null], ['Số Hóa Đơn', 'invoice_no'], ['Giá Ngoại Tệ', 'price_fx'],
  ['Ngoại Tệ', 'currency'], ['Tỉ Giá', 'fx_rate'], ['Đơn Giá', 'unit_price'],
  ['Giá Thanh Lý', null], ['Hoá Đơn Thanh Lý', null], ['Có Tính Khấu Hao', '#dep'],
  ['Thời Gian Khấu Hao', 'depreciate_months'], ['Giá Trị Còn Lại', null],
  ['Năm Sản Xuất', 'spec_mfg_year'], ['Ngày Mua', '#d:purchase_date'],
  ['Ngày Sử Dụng', '#d:in_use_date'], ['Ngày Tính Khấu Hao', '#d:in_use_date'],
  ['Mã Tình Trạng (*)', 'status_code'], ['Nguồn Mua', null],
  ['Mục đích Tài Sản', 'purpose_code'], ['Đã In Nhãn', '#lbl'],
  ['Ngày Hết Hạn Bảo Hành', null], ['Lịch Bảo Dưỡng', null],
  ['Đơn Vị Thời Gian Bảo Dưỡng', null], ['Tên Người Bảo Dưỡng', null],
  ['Email Người Bảo Dưỡng', null], ['Ghi Chú', 'note']
];

const BT_LOW = [
  ['STT (*)', '#'], ['Asset Id', null], ['Mã Sản Phẩm', null],
  ['Mã Danh Mục (*)', 'category_code'], ['Tên (*)', '#name'], ['Tên Khác', null],
  ['Mô Tả', 'description'], ['Mã Tài Sản', 'asset_code'],
  ['Mã Vạch Tài Sản Cha', null], ['Mã Dự Án', 'purpose_code'], ['Mã Vạch', 'barcode'],
  ['Số Lượng Ban Đầu', 'qty'], ['Số Lượng', 'qty'], ['Đơn Vị Tính', 'unit_code'],
  ['Số Seri', 'serial'], ['Mã Vị Trí (*)', 'location_code'],
  ['Mã Phòng Ban', 'dept_code'], ['Mã Phòng Ban Quản Lý', null],
  ['Mã Công Ty Thành Viên (*)', 'company_code'], ['Mã Người Dùng', null],
  ['Mã Thiết Bị', null], ['Mã Xuất Xứ', 'origin_iso2'], ['Mã Nhà Cung Cấp', null],
  ['Mã Nhà Sản Xuất', null], ['Số Hóa Đơn', 'invoice_no'], ['Giá Ngoại Tệ', 'price_fx'],
  ['Ngoại Tệ', 'currency'], ['Tỉ Giá', 'fx_rate'], ['Giá Đơn Vị', 'unit_price'],
  ['Ngày Mua', '#d:purchase_date'], ['Ngày Sử Dụng', '#d:in_use_date'],
  ['Mã Tình Trạng (*)', 'status_code'], ['Nguồn Mua', null],
  ['Mục đích Tài Sản', 'purpose_code'], ['Đã In Nhãn', '#lbl'], ['Ghi Chú', 'note']
];

function btCell(spec, row, i) {
  if (spec === null) return '';
  if (spec === '#') return i + 1;
  if (spec === '#name') return [row.name_vi, row.name_en].filter(Boolean).join('/');
  if (spec === '#dep') return row.depreciate ? 1 : 0;
  if (spec === '#lbl') return row.label_printed ? 1 : 0;
  if (spec.startsWith('#d:')) {
    const v = row[spec.slice(3)];
    return v ? new Date(v + 'T00:00:00') : '';
  }
  const v = row[spec];
  return v == null ? '' : v;
}

function btSheet(cols, rows) {
  const aoa = [cols.map(c => c[0])];
  rows.forEach((r, i) => aoa.push(cols.map(c => btCell(c[1], r, i))));
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  // Dates must carry an explicit format, otherwise Excel shows the serial.
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = 1; R <= range.e.r; R++)
    for (let C = 0; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && cell.t === 'd') cell.z = 'dd/mm/yyyy';
    }
  return ws;
}

function btExport(rows, stamp) {
  const uniq = rows.filter(r => r.asset_kind === 'unique');
  const low = rows.filter(r => r.asset_kind === 'low');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, btSheet(BT_UNIQUE, uniq), 'Unique asset');
  XLSX.utils.book_append_sheet(wb, btSheet(BT_LOW, low), 'Low-value asset');
  const file = `phcl-asset-upload-${stamp || bkStamp()}.xlsx`;
  XLSX.writeFile(wb, file);
  return { file, u: uniq.length, l: low.length };
}

/* ------------------------------------------------------------ the screen */
const IN = { lines: [], checked: null, committed: [] };

const inBlank = () => ({
  name_vi: '', name_en: '', category_code: '', qty: 1, unit_code: 'pcs',
  unit_price: '', serials: '', origin_raw: '', location_code: '', description: ''
});

function inRender() {
  const head = $('#inGrid thead'), body = $('#inGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, ['', 'in.col.name', 'in.col.cat', 'in.col.qty', 'in.col.unit',
    'in.col.price', 'in.col.serial', 'in.col.origin', 'in.col.loc', 'in.col.kind', 'in.col.rows']
    .map(k => el('th', { textContent: k ? t(k) : '' }))));

  IN.lines.forEach((ln, i) => {
    const tr = el('tr');
    const del = el('button', { className: 'xbtn', textContent: '✕' });
    del.onclick = () => { IN.lines.splice(i, 1); IN.checked = null; inRender(); };
    tr.append(el('td', {}, del));

    const txt = (field, w, type) => {
      const inp = el('input', { value: ln[field] ?? '', style: `width:${w}px`,
                                type: type || 'text' });
      inp.onchange = () => { ln[field] = type === 'number' ? inp.value : inp.value;
                             IN.checked = null; inRender(); };
      return el('td', {}, inp);
    };
    const pick = (field, list, w) => {
      const s = el('select', { style: `width:${w}px` });
      s.append(el('option', { value: '', textContent: '—' }));
      for (const o of list)
        s.append(el('option', { value: o, textContent: o, selected: o === ln[field] }));
      s.onchange = () => { ln[field] = s.value; IN.checked = null; inRender(); };
      return el('td', {}, s);
    };

    tr.append(txt('name_vi', 200));
    tr.append(pick('category_code', (window.__CATS || []).map(c => c.code), 110));
    tr.append(txt('qty', 60, 'number'));
    tr.append(pick('unit_code', IN.units || [], 90));
    tr.append(txt('unit_price', 120, 'number'));
    tr.append(txt('serials', 170));
    tr.append(txt('origin_raw', 130));
    tr.append(txt('location_code', 110));

    const price = Number(ln.unit_price) || 0;
    const kind = price >= (IN.thUnique || 5000000) ? 'unique' : 'low';
    const rows = kind === 'unique' ? (Number(ln.qty) || 0)
                 : (inSerials(ln).length || 1);
    tr.append(el('td', { textContent: kind === 'unique' ? t('reg.kindUnique') : t('reg.kindLow') }));
    tr.append(el('td', { className: 'num', textContent: String(rows) }));
    body.append(tr);
  });

  if (!IN.lines.length)
    body.append(el('tr', {}, el('td', { colSpan: 11, style: 'color:var(--dim);padding:14px',
      textContent: t('in.noLines') })));
}

const inSerials = ln => String(ln.serials || '')
  .split(/[\n,;]/).map(s => s.trim()).filter(Boolean);

/* Expand one entered line into the asset rows it will become. */
function inExpand(ln) {
  const price = Number(ln.unit_price) || 0;
  const kind = price >= (IN.thUnique || 5000000) ? 'unique' : 'low';
  const cat = (window.__CATS || []).find(c => c.code === ln.category_code);
  const serials = inSerials(ln);
  const base = {
    asset_kind: kind,
    category_code: ln.category_code,
    group_code: cat?.group_code,
    letters: cat?.label_letters,
    name_vi: ln.name_vi, name_en: ln.name_en || null,
    description: ln.description || null,
    unit_code: ln.unit_code || null,
    unit_price: price,
    currency: 'VND',
    location_code: ln.location_code || null,
    company_code: $('#inCompany').value,
    dept_code: $('#inDept').value,
    purpose_code: $('#inPurpose').value.trim() || null,
    invoice_no: $('#inInvoice').value.trim() || null,
    supplier: $('#inSupplier').value.trim() || null,
    purchase_date: $('#inDate').value || null,
    in_use_date: $('#inDate').value || null,
    purchase_year: Number(($('#inDate').value || '').slice(0, 4)) || new Date().getFullYear(),
    origin_iso2: ln._iso || null,
    status_code: null,
    needs_review: ln._review || []
  };
  const out = [];
  if (kind === 'unique') {
    const n = Math.max(1, Number(ln.qty) || 1);
    for (let i = 0; i < n; i++)
      out.push({ ...base, qty: 1, serial: serials[i] || null });
  } else if (serials.length) {
    for (const s of serials) out.push({ ...base, qty: 1, serial: s });
  } else {
    out.push({ ...base, qty: Number(ln.qty) || 1, serial: null });
  }
  return out;
}

async function inCheck() {
  const out = $('#inMsg');
  if (!IN.lines.length) return msg(out, 'err', t('in.noLines'));
  msg(out, 'info', t('in.checking'));
  const errs = [], warns = [];
  let rows = 0;

  for (let i = 0; i < IN.lines.length; i++) {
    const ln = IN.lines[i], n = i + 1;
    ln._review = [];
    if (!ln.name_vi?.trim()) errs.push(t('in.errNoName', { i: n }));
    if (!ln.category_code) errs.push(t('in.errNoCat', { i: n }));
    const price = Number(ln.unit_price);
    if (!price) errs.push(t('in.errNoPrice', { i: n }));
    if (!(Number(ln.qty) >= 1)) errs.push(t('in.errNoQty', { i: n }));

    if (ln.category_code && price) {
      try {
        const r = (await SB.rpc('am_classify', {
          p_unit_price: price, p_category_code: ln.category_code,
          p_is_intangible: false
        }))[0];
        if (r.violates_capex) errs.push(t('in.errCapex', { i: n, code: ln.category_code }));
        for (const w of r.warnings || []) warns.push(`${n}: ${w}`);
      } catch (e) { errs.push(`${n}: ${e.message}`); }
    }

    if (ln.origin_raw?.trim()) {
      try {
        const o = (await SB.rpc('am_resolve_origin', { p_raw: ln.origin_raw }))[0];
        ln._iso = o.iso2 || null;
        if (!o.iso2) {
          warns.push(t('in.warnOrigin', { i: n, why: t('why.' + o.reason) }));
          ln._review.push({ field: 'origin_iso2', reason: o.reason, raw: ln.origin_raw });
        }
      } catch { ln._iso = null; }
    } else ln._iso = null;

    const ser = inSerials(ln);
    if (ser.length && ser.length !== Number(ln.qty))
      warns.push(t('in.warnSerial', { i: n, have: ser.length, qty: ln.qty }));

    warns.push(t('in.warnStatus', { i: n }));
    ln._review.push({ field: 'status_code', reason: 'no_source' });

    rows += inExpand(ln).length;
  }

  IN.checked = errs.length ? null : { rows };
  out.innerHTML = '';
  if (errs.length) {
    out.append(el('div', { className: 'msg err', textContent: t('in.hasErr', { n: errs.length }) }));
    for (const e of errs) out.append(el('div', { className: 'msg err', textContent: e }));
  } else {
    out.append(el('div', { className: 'msg ok',
      textContent: t('in.okAll', { n: IN.lines.length, r: rows }) }));
  }
  if (warns.length) {
    out.append(el('div', { className: 'msg warn', textContent: t('in.hasWarn', { n: warns.length }) }));
    for (const w of warns) out.append(el('div', { className: 'msg warn', textContent: w }));
  }
  $('#btnInConfirm').disabled = !IN.checked;
  inRender();
}

async function inConfirm() {
  if (!IN.checked) return;
  const out = $('#inMsg');
  // Expand first, then group by (dept, letters) so each key needs one
  // allocation call, and each barcode range one more.
  const all = IN.lines.flatMap(inExpand);
  msg(out, 'info', t('in.writing', { n: all.length }));
  try {
    const byKey = new Map();
    for (const r of all) {
      const k = `${r.dept_code}|${r.letters}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    for (const [k, list] of byKey) {
      const [dept, letters] = k.split('|');
      const first = await SB.rpc('am_alloc_asset_seq',
        { p_dept: dept, p_letters: letters, p_count: list.length, p_actor: 'intake' });
      list.forEach((r, i) => {
        r.seq = first + i;
        r.asset_code = `${r.dept_code}.${r.group_code}.${r.letters}.${r.purchase_year}.` +
                       String(r.seq).padStart(5, '0');
      });
    }
    for (const kind of ['unique', 'low']) {
      const list = all.filter(r => r.asset_kind === kind);
      if (!list.length) continue;
      const first = await SB.rpc('am_alloc_barcode',
        { p_kind: kind, p_count: list.length, p_actor: 'intake' });
      list.forEach((r, i) => {
        const v = first + i;
        r.barcode = kind === 'low' ? 'JVC.9' + String(v).padStart(8, '0')
                                   : 'JVC.' + String(v).padStart(9, '0');
      });
    }
    const payload = all.map(r => {
      const o = { ...r };
      delete o._iso; delete o._review;
      o.needs_review = r.needs_review || [];
      return o;
    });
    const saved = await SB.insert('am_asset', payload);
    IN.committed = saved || payload;
    const codes = IN.committed.map(r => r.asset_code).sort();
    msg(out, 'ok', t('in.written', { n: IN.committed.length,
                                     from: codes[0], to: codes[codes.length - 1] }));
    $('#btnInXlsx').disabled = false;
    $('#btnInConfirm').disabled = true;
    IN.lines = []; IN.checked = null; inRender();
    try {
      await SB.insert('am_data_source', [{
        table_name: 'am_asset', source_file: $('#inPurpose').value.trim() || 'manual intake',
        source_kind: 'manual', rows_loaded: IN.committed.length, loaded_by: 'intake'
      }]);
    } catch { /* the provenance log is optional, never block on it */ }
  } catch (e) {
    msg(out, 'err', t('in.writeFail', { err: e.message }));
  }
}

function inXlsx() {
  if (!IN.committed.length) return msg('#inMsg', 'warn', t('in.nothingYet'));
  const r = btExport(IN.committed);
  msg('#inMsg', 'ok', t('in.exported', { u: r.u, l: r.l, file: r.file }));
}

function inToAlr() {
  if (!IN.committed.length) return msg('#inMsg', 'warn', t('in.nothingYet'));
  ALR.rows = IN.committed.map(r => ({ ...r, _pick: true }));
  ALR.demo = false;
  showView('alr');
  renderAlrList();
  msg('#alListMsg', 'ok', t('alr.loaded', { n: ALR.rows.length }));
}

async function inFill() {
  try {
    const [orgs, units, th] = await Promise.all([
      SB.select('am_org', 'select=code,is_company,is_department&order=code'),
      SB.select('am_unit', 'select=code&order=sort_order'),
      SB.select('am_setting', 'select=key,value&key=eq.unique_threshold')
    ]);
    IN.units = units.map(u => u.code);
    IN.thUnique = Number(th?.[0]?.value) || 5000000;
    const fill = (sel, list, keep) => {
      const s = $(sel); s.innerHTML = '';
      for (const c of list) s.append(el('option', { value: c, textContent: c }));
      if (keep && list.includes(keep)) s.value = keep;
    };
    fill('#inCompany', orgs.filter(o => o.is_company).map(o => o.code), 'SOF');
    fill('#inDept', orgs.filter(o => o.is_department).map(o => o.code));
    if (!window.__CATS) await fillPickers();
    inRender();
  } catch { /* the Connection screen already reports it */ }
}

function initIntake() {
  $('#inDate').value = new Date().toISOString().slice(0, 10);
  $('#btnInAdd').onclick = () => { IN.lines.push(inBlank()); IN.checked = null; inRender(); };
  $('#btnInClear').onclick = () => { IN.lines = []; IN.checked = null; inRender(); };
  $('#btnInCheck').onclick = inCheck;
  $('#btnInConfirm').onclick = inConfirm;
  $('#btnInXlsx').onclick = inXlsx;
  $('#btnInAlr').onclick = inToAlr;
  inRender();
}

/* ================================================== LEGACY REGISTER IMPORT
   Loads "Danh sách tài sản (… - Beetrack).xlsx" into am_asset with
   is_legacy = true.

   group_code / letters come from the CATEGORY, never from parsing the asset
   code: 860 of the 17,036 codes do not parse (an unknown O4000-era group, six
   digit sequences, one code with a note appended, one cell holding a number),
   and those columns are NOT NULL. The category is present and valid on every
   row, so it is the reliable source.

   Columns of the Beetrack export, by spreadsheet letter. */
const LEG_COL = {
  kind: 'B', category: 'C', name: 'E', desc: 'G', code: 'J', barcode: 'M',
  location: 'N', dept: 'R', company: 'V', origin: 'AD', brand: 'AF',
  serial: 'AG', model: 'AH', invoice: 'AX', unit: 'BA', qty: 'BD',
  price: 'BI', bought: 'BT', status: 'CD', purpose: 'CH'
};
const LEG_CHUNK = 300;
let LEG = { rows: [], bad: [], warn: [] };

const legTxt = v => (v == null ? '' : String(v).trim());

/* The export writes dates as dd/mm/yyyy text. */
function legDate(v) {
  const s = legTxt(v);
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[0] : null;
}
const legNum = v => {
  // Strip the empty case first: Number('') is 0, which would turn a blank
  // quantity cell into qty 0 and a blank price into 0 VND.
  const s = String(v ?? '').replace(/[^\d.-]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function legRead() {
  const out = $('#legMsg');
  const f = $('#legFile').files?.[0];
  if (!f) return msg(out, 'err', t('bk.noFile'));
  msg(out, 'info', t('leg.reading'));
  LEG = { rows: [], bad: [], warn: [] };

  let master;
  try {
    const [cats, orgs, locs, units, origins] = await Promise.all([
      SB.select('am_category', 'select=code,group_code,label_letters'),
      SB.select('am_org', 'select=code,is_company,is_department'),
      SB.select('am_location', 'select=code'),
      SB.select('am_unit', 'select=code'),
      SB.select('am_origin', 'select=iso2')
    ]);
    master = {
      cat: new Map(cats.map(c => [c.code, c])),
      dept: new Set(orgs.filter(o => o.is_department).map(o => o.code)),
      comp: new Set(orgs.filter(o => o.is_company).map(o => o.code)),
      loc: new Set(locs.map(l => l.code)),
      unit: new Set(units.map(u => u.code)),
      origin: new Set(origins.map(o => o.iso2))
    };
  } catch (e) { return msg(out, 'err', e.message); }

  let grid;
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 'A', defval: '' });
  } catch (e) { return msg(out, 'err', e.message); }
  if (grid.length < 2) return msg(out, 'warn', t('leg.noRows'));

  const seenCode = new Set(), seenBar = new Set();
  const G = LEG_COL;

  for (let i = 1; i < grid.length; i++) {
    const r = grid[i], line = i + 1;
    const code = legTxt(r[G.code]), bar = legTxt(r[G.barcode]);
    if (!code && !bar && !legTxt(r[G.name])) continue;   // blank row

    const errs = [], warns = [];
    const catCode = legTxt(r[G.category]);
    const cat = master.cat.get(catCode);
    const dept = legTxt(r[G.dept]);
    const comp = legTxt(r[G.company]) || 'SOF';
    const name = legTxt(r[G.name]);

    if (!name) errs.push(t('leg.eNoName'));
    if (!cat) errs.push(t('leg.eNoCat', { v: catCode || '—' }));
    if (!master.dept.has(dept)) errs.push(t('leg.eNoDept', { v: dept || '—' }));
    if (!master.comp.has(comp)) errs.push(t('leg.eNoCompany', { v: comp }));
    if (code && seenCode.has(code)) errs.push(t('leg.eDupCode'));
    if (bar && seenBar.has(bar)) errs.push(t('leg.eDupBarcode'));
    // The barcode is what both "add new" and "update" match on, so a row
    // without one has no identity to match: skip it rather than invent one.
    if (!bar) errs.push(t('leg.eNoBarcode'));

    const parsed = /^([A-Z]{2,5})\.([A-Z0-9]{5})\.([A-Z]{3})\.(\d{4})\.(\d{5})$/.exec(code);
    if (!parsed) warns.push(t('leg.wOddCode'));
    if (!/^JVC\.\d{9}$/.test(bar)) warns.push(t('leg.wOddBarcode'));

    let loc = legTxt(r[G.location]) || null;
    if (loc && !master.loc.has(loc)) { warns.push(t('leg.wNoLoc', { v: loc })); loc = null; }
    let unit = legTxt(r[G.unit]) || null;
    if (unit && !master.unit.has(unit)) { warns.push(t('leg.wNoUnit', { v: unit })); unit = null; }
    let iso = legTxt(r[G.origin]).toUpperCase() || null;
    if (iso && !master.origin.has(iso)) { warns.push(t('leg.wNoOrigin', { v: iso })); iso = null; }

    if (errs.length) { LEG.bad.push({ line, code, why: errs.join(' · ') }); continue; }
    if (code) seenCode.add(code);
    if (bar) seenBar.add(bar);
    if (warns.length) LEG.warn.push({ line, code, why: warns.join(' · ') });

    const bought = legDate(r[G.bought]);
    const nameParts = name.split('/');
    LEG.rows.push({
      is_legacy: true,
      asset_code: code || `LEGACY-${line}`,
      barcode: bar,
      // "Cung Barcode" means one barcode for the whole batch -> low-value.
      asset_kind: /cùng/i.test(legTxt(r[G.kind])) ? 'low' : 'unique',
      category_code: catCode,
      group_code: cat.group_code,
      letters: cat.label_letters,
      seq: parsed ? Number(parsed[5]) : 0,
      purchase_year: parsed ? Number(parsed[4])
                     : (bought ? Number(bought.slice(0, 4)) : new Date().getFullYear()),
      company_code: comp,
      dept_code: dept,
      location_code: loc,
      name_vi: nameParts[0].trim() || name,
      name_en: nameParts.length > 1 ? nameParts.slice(1).join('/').trim() : null,
      description: legTxt(r[G.desc]) || null,
      unit_code: unit,
      qty: legNum(r[G.qty]) ?? 1,
      serial: legTxt(r[G.serial]) || null,
      unit_price: legNum(r[G.price]),
      currency: 'VND',
      origin_iso2: iso,
      invoice_no: legTxt(r[G.invoice]) || null,
      purpose_code: legTxt(r[G.purpose]) || null,
      purchase_date: bought,
      status_code: legTxt(r[G.status]) || null,
      spec_brand: legTxt(r[G.brand]) || null,
      spec_model: legTxt(r[G.model]) || null,
      needs_review: warns.length ? warns.map(w => ({ field: 'import', reason: w })) : []
    });
  }

  out.innerHTML = '';
  out.append(el('div', { className: LEG.bad.length ? 'msg warn' : 'msg ok', textContent:
    t('leg.readDone', { n: fmtInt(LEG.rows.length + LEG.bad.length),
                        ok: fmtInt(LEG.rows.length), bad: fmtInt(LEG.bad.length) }) }));

  const table = (title, list, cls) => {
    if (!list.length) return;
    out.append(el('div', { className: 'msg ' + cls, textContent: title }));
    const tb = el('table');
    tb.append(el('tr', {}, ['leg.col.row', 'leg.col.code', 'leg.col.why']
      .map(k => el('th', { textContent: t(k) }))));
    for (const r of list.slice(0, 200))
      tb.append(el('tr', {}, [
        el('td', { className: 'num', textContent: r.line }),
        el('td', {}, el('code', { textContent: r.code || '—' })),
        el('td', { textContent: r.why })
      ]));
    out.append(el('div', { className: 'wrap', style: 'max-height:32vh' }, tb));
  };
  table(t('leg.errHead', { n: fmtInt(LEG.bad.length) }), LEG.bad, 'err');
  table(t('leg.warnHead', { n: fmtInt(LEG.warn.length) }), LEG.warn, 'warn');

  $('#btnLegImport').disabled = !LEG.rows.length;
}

async function legImport() {
  if (!LEG.rows.length) return;
  const out = $('#legMsg');
  const host = CFG.url ? new URL(CFG.url).hostname : '?';
  if (!confirm(t('leg.confirm', { n: fmtInt(LEG.rows.length), host,
                                  bad: fmtInt(LEG.bad.length),
                                  warn: fmtInt(LEG.warn.length) }))) return;
  let done = 0;
  try {
    for (let i = 0; i < LEG.rows.length; i += LEG_CHUNK) {
      msg(out, 'info', t('leg.importing', { done: fmtInt(done),
                                            total: fmtInt(LEG.rows.length) }));
      // The barcode is the identity: both "add new" and "update" match on it.
      // It is the only field present and unique on every row of the register --
      // 860 asset codes do not even parse -- so it is what decides whether a
      // row already exists.
      // on_conflict also makes the import repeatable. Without it PostgREST
      // resolves conflicts on the primary key, and since id is a bigserial we
      // never send, a second run would insert duplicates and die on the unique
      // index -- halfway through 17,000 rows.
      await SB.call('am_asset?on_conflict=barcode', {
        method: 'POST',
        headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(LEG.rows.slice(i, i + LEG_CHUNK))
      });
      done += Math.min(LEG_CHUNK, LEG.rows.length - i);
    }
  } catch (e) {
    return msg(out, 'err', t('leg.fail', { done: fmtInt(done), err: e.message }));
  }
  msg(out, 'ok', t('leg.done', { n: fmtInt(done), skip: fmtInt(LEG.bad.length) }));
  $('#btnLegImport').disabled = true;
  try {
    await SB.insert('am_data_source', [{
      table_name: 'am_asset', source_file: $('#legFile').files[0].name,
      source_kind: 'register-scan', rows_loaded: done, loaded_by: 'legacy import'
    }]);
  } catch { /* the provenance log is optional, never block on it */ }
  regLoad(true);
}

function initLegacy() {
  $('#btnLegRead').onclick = legRead;
  $('#btnLegImport').onclick = legImport;
}
