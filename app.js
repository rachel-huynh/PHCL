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
const NAV = [
  ['nav.catalog', [
    ['tbl:am_org', null], ['tbl:am_org_alias', null], ['tbl:am_category_group', null],
    ['tbl:am_category', null], ['tbl:am_unit', null], ['tbl:am_location', null],
    ['tbl:am_product', null]
  ]],
  ['nav.originGrp', [
    ['tbl:am_origin', null], ['tbl:am_origin_alias', null], ['tbl:am_origin_rejected', null]
  ]],
  ['nav.counters', [['counter', 'nav.counter'], ['rules', 'nav.rules']]],
  ['nav.docs',     [['alr', 'nav.alr']]],
  ['nav.system',   [['tbl:am_setting', null], ['setup', 'nav.setup']]]
];

let VIEW = 'setup';

const viewTitle = v => v.startsWith('tbl:') ? tblLabel(v.slice(4)) : t('page.' + v);

function buildNav() {
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [grpKey, items] of NAV) {
    nav.append(el('div', { className: 'grp', textContent: t(grpKey) }));
    for (const [id, labelKey] of items) {
      const a = el('a', { href: '#',
        textContent: labelKey ? t(labelKey) : tblLabel(id.slice(4)) });
      a.dataset.view = id;
      a.classList.toggle('on', id === VIEW);
      a.onclick = ev => { ev.preventDefault(); showView(id); };
      nav.append(a);
    }
  }
}

/* The toolbar changes with the screen. */
function buildTools(view) {
  const box = $('#tools');
  box.innerHTML = '';
  if (view.startsWith('tbl:')) {
    const f = el('input', { id: 'filter', style: 'width:190px' });
    f.placeholder = t('tool.filter');
    f.oninput = () => renderGrid();
    const reload = el('button', { className: 'btn', textContent: t('tool.reload') });
    reload.onclick = () => loadTable(view.slice(4));
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
    if (n && !confirm(t('table.confirmLeave', { n }))) return;
  }
  VIEW = view;
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  const sect = view.startsWith('tbl:') ? 'v-table' : 'v-' + view;
  $$('section').forEach(s => s.classList.toggle('on', s.id === sect));
  buildTools(view);
  $('#pageTitle').textContent = viewTitle(view);

  if (view.startsWith('tbl:')) {
    const name = view.slice(4);
    $('#tableLead').textContent = tblSub(name);
    CUR = null;
    loadTable(name);
  } else {
    if (view === 'counter' && SB.ready()) loadCounters();
    if (view === 'rules' && SB.ready()) fillPickers();
    if (view === 'alr' && SB.ready()) fillAlrPickers();
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
  loadCfg();
  showView('setup');
  testConn(true).then(ok => { if (ok) { showView('tbl:am_org'); fillPickers(); } });
}
document.addEventListener('DOMContentLoaded', init);
