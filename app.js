/* asset-intake — internal tool (phase 1: master data + counters)
   PUBLIC repo: no URL/key is embedded. Settings come from localStorage or from
   a #sbcfg=<base64> fragment, which is stripped from the address bar at once.
   All user-facing text goes through t() in i18n.js — English is official. */
'use strict';

/* Shown in the sidebar. If this does not match the ?v= on the script tag in
   AssetManagement.html, the browser is running a cached older app.js — which
   looks identical to "the change did not work". Check here first. */
const APP_VERSION = '20260916f';

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
/* The sidebar says WHETHER it is connected, never to which project. The repo is
   public and this corner of the screen is in every screenshot and screen-share;
   the host name belongs on the Connection screen, behind the Show button. */
function setConn(ok, hostOrKey) {
  CONN = { ok, host: ok ? hostOrKey : '' };
  $('#dot').classList.toggle('on', !!ok);
  $('#connTxt').textContent = t(ok ? 'conn.ok' : hostOrKey);
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

/* Master data is read far more often than it is changed, so the grid opens in
   read mode: no delete buttons, no input boxes, nothing to hit by accident. */
let EDIT = false;

/* Read mode: plain text on the cell's own margin, no input chrome. Keeping the
   inputs and merely disabling them would leave the boxes and the 5px inset that
   throws the content off the column heading. */
function cellRead(col, row) {
  const v = row.cur[col.name];
  if (col.type === 'bool') return document.createTextNode(v ? '✔' : '');
  if (v == null || v === '') return document.createTextNode('');
  return document.createTextNode(typeof v === 'object' ? JSON.stringify(v) : String(v));
}

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

/* Which column points at the parent. am_category points OUT of the table, into
   am_category_group, so its parents become header rows rather than parent rows;
   the other two are self-referencing and nest properly. */
const TREE_PARENT = {
  am_location: 'parent_code',
  am_org: 'parent_code',
  am_category: 'group_code'
};
const TREE_KEY = 'asset-intake.tree';
const SHUT_KEY = 'asset-intake.tree.shut';
let TREE_ON = (() => { try { return localStorage.getItem(TREE_KEY) !== '0'; } catch { return true; } })();

/* Which branches are folded, per table. Survives a reload: refolding 675
   locations by hand every time would make the fold useless. */
const SHUT = (() => {
  try { return JSON.parse(localStorage.getItem(SHUT_KEY) || '{}'); } catch { return {}; }
})();
const shutSet = tbl => new Set(SHUT[tbl] || []);
const shutSave = (tbl, set) => {
  SHUT[tbl] = [...set];
  try { localStorage.setItem(SHUT_KEY, JSON.stringify(SHUT)); } catch {}
};

/* Order the visible rows as a depth-first walk and give each one a depth.
   Rows whose parent is not a row of this table are collected under a header
   for that parent value -- which is what makes the category screen group by
   accounting group, and what surfaces a broken parent_code instead of hiding it. */
function treeOrder(rows, spec, parentField, visible, shut, folding) {
  const pk = spec.pk;
  const byKey = new Map(rows.map(r => [String(r.cur[pk] ?? ''), r]));
  const kids = new Map();          // parent key -> rows
  const heads = new Map();         // synthetic header value -> rows
  const roots = [];
  for (const r of rows) {
    const p = r.cur[parentField];
    if (p == null || p === '') { roots.push(r); continue; }
    const key = String(p);
    if (byKey.has(key)) {
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(r);
    } else {
      if (!heads.has(key)) heads.set(key, []);
      heads.get(key).push(r);
    }
  }

  // A match deep in the tree is useless without the branch above it, so pull
  // every ancestor of a visible row back in, flagged as context.
  const keep = new Set();
  const mark = r => {
    let cur = r, guard = 0;
    while (cur && guard++ < 50) {
      keep.add(cur);
      const p = cur.cur[parentField];
      cur = p == null || p === '' ? null : byKey.get(String(p));
    }
  };
  for (const r of rows) if (visible(r)) mark(r);

  /* A node at depth d draws d-1 continuation columns then its own elbow, so
     guides has length d-1: guides[j] asks whether the ancestor at depth j+1
     still has siblings below, because column j is where that ancestor drew its
     elbow. Hence the rule below -- a child of a ROOT gets an empty array (a
     depth-1 row has no continuation column at all), and only from depth 2 down
     does the parent's own sibling state get appended. Getting this off by one
     draws the rule under the wrong branch. */
  const out = [];
  const childrenOf = r =>
    (kids.get(String(r.cur[pk] ?? '')) || []).filter(c => keep.has(c));

  const walk = (r, depth, guides, last) => {
    if (!keep.has(r)) return;
    const ch = childrenOf(r);
    const key = String(r.cur[pk] ?? '');
    // While filtering, a folded branch would hide the match -- so ignore folds.
    const folded = folding && ch.length > 0 && shut.has(key);
    out.push({ row: r, depth, guides, last, kids: ch.length, folded, key,
               ctx: !visible(r) });
    if (folded) return;
    const childGuides = depth === 0 ? [] : [...guides, !last];
    ch.forEach((c, i) => walk(c, depth + 1, childGuides, i === ch.length - 1));
  };

  for (const key of [...heads.keys()].sort()) {
    const list = heads.get(key).filter(r => keep.has(r));
    if (!list.length) continue;
    const hkey = 'head:' + key;
    const folded = folding && shut.has(hkey);
    out.push({ head: key, n: list.length, depth: 0, folded, key: hkey, kids: list.length });
    if (folded) continue;
    list.forEach((r, i) => walk(r, 1, [], i === list.length - 1));
  }
  roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1));
  return out;
}

/* One indent column each, drawn with CSS borders rather than box characters.
   Glyphs like │ do not touch across rows — the line comes out dashed — while a
   border stretched over the whole row height joins up cleanly.
     v = the branch continues past this row      e = elbow, last child
     t = tee, this child has siblings below      (blank otherwise) */
function treeGuides(item) {
  const box = el('span', { className: 'guides' });
  for (let j = 0; j < item.depth; j++) {
    const cls = j === item.depth - 1 ? (item.last ? 'e' : 't')
              : item.guides[j] ? 'v' : '';
    box.append(el('span', { className: 'g ' + cls }));
  }
  return box;
}

function renderGrid() {
  if (!CUR) return;
  const spec = TABLES[CUR.table];
  const head = $('#grid thead'), body = $('#grid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  const hr = el('tr');
  if (EDIT) hr.append(el('th', { className: 'delcol', textContent: '' }));
  for (const c of spec.cols) hr.append(el('th', { textContent: c.name }));
  head.append(hr);

  const q = ($('#filter')?.value || '').trim().toLowerCase();
  const parentField = TREE_ON ? TREE_PARENT[CUR.table] : null;
  const alive = CUR.rows.filter(r => !r.del);
  const visible = r => !q || JSON.stringify(r.cur).toLowerCase().includes(q);
  const shut = shutSet(CUR.table);

  const plan = parentField
    ? treeOrder(alive, spec, parentField, visible, shut, !q)
    : alive.filter(visible).map(r => ({ row: r, depth: 0, guides: [] }));

  const fold = key => {
    if (shut.has(key)) shut.delete(key); else shut.add(key);
    shutSave(CUR.table, shut);
    renderGrid();
  };
  const caret = item => {
    if (!item.kids) return el('span', { className: 'caret pad' });
    const b = el('button', { className: 'caret', title: t('tree.fold'),
                             textContent: item.folded ? '▸' : '▾' });
    b.onclick = () => fold(item.key);
    return b;
  };

  const cols = spec.cols.length + (EDIT ? 1 : 0);
  let shown = 0;
  for (const item of plan) {
    if (item.head !== undefined) {
      const td = el('td', { colSpan: cols });
      td.append(caret(item), el('span', { className: 'gt', textContent: item.head }),
                el('span', { className: 'gn',
                             textContent: t('tree.nRows', { n: fmtInt(item.n) }) }));
      body.append(el('tr', { className: 'grp' }, td));
      continue;
    }
    const row = item.row;
    if (visible(row)) shown++;
    const tr = el('tr');
    if (item.ctx) tr.classList.add('ctx');
    if (row.isNew) tr.classList.add('new');
    else if (row.dirty) tr.classList.add('dirty');
    // Deleting is only offered in edit mode; in read mode the column is gone
    // entirely rather than greyed, so the tree it sits beside stays legible.
    if (EDIT) {
      const del = el('button', { className: 'xbtn', textContent: '✕',
                                 title: t('table.deleteRow') });
      del.onclick = () => {
        if (row.isNew) CUR.rows.splice(CUR.rows.indexOf(row), 1);
        else if (confirm(t('table.confirmDelete', { id: row.cur[spec.pk] }))) row.del = true;
        else return;
        dirtyCheck(); renderGrid();
      };
      tr.append(el('td', { className: 'delcol' }, del));
    }
    let first = true;
    for (const c of spec.cols) {
      // The tree lives in the editable grid rather than beside it, so every
      // row stays editable; only the first cell carries the outline.
      const td = el('td', first && parentField
        ? { className: 'tcell lvl' + Math.min(item.depth, 2) } : {});
      if (first && parentField) {
        // The rules are absolutely positioned over the cell's full height, so
        // the cell reserves their width as padding instead of flowing them.
        td.style.paddingLeft = (item.depth * 15 + 4) + 'px';
        td.append(treeGuides(item), caret(item));
        first = false;
      }
      if (!EDIT) { td.append(cellRead(c, row)); tr.append(td); continue; }
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
  return `${d}/${m}/${y}`;
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
  // Same shape as the register: a running number first, money and counts ranged
  // right with their headings, everything else left. No column filters here —
  // this list is already narrowed by the pickers above it.
  head.append(el('tr', {}, [
    el('th', { className: 'delcol' }),
    el('th', { className: 'num idx', textContent: '#' }),
    ...[['alr.col.code'], ['alr.col.name'], ['alr.col.qty', 1], ['alr.col.price', 1],
        ['alr.col.loc'], ['alr.col.barcode']]
      .map(([k, r]) => el('th', { className: r ? 'num' : '', textContent: t(k) }))
  ]));
  if (!ALR.rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 8, style: 'color:var(--dim);padding:14px',
      textContent: t('alr.listEmpty') })));
    return;
  }
  ALR.rows.forEach((r, i) => {
    const cb = el('input', { type: 'checkbox', checked: r._pick !== false });
    cb.onchange = () => { r._pick = cb.checked; };
    body.append(el('tr', {}, [
      el('td', { className: 'delcol' }, cb),
      el('td', { className: 'num idx', textContent: fmtInt(i + 1) }),
      el('td', { textContent: r.asset_code }),
      el('td', { textContent: [r.name_vi, r.name_en].filter(Boolean).join(' / ') }),
      el('td', { className: 'num', textContent: fmtNum(r.qty) }),
      el('td', { className: 'num', textContent: fmtNum(r.unit_price) }),
      el('td', { textContent: [r.location_code, r.location_name].filter(Boolean).join(' — ') }),
      el('td', { textContent: r.barcode })
    ]));
  });
}

async function loadAlrAssets() {
  const box = $('#alListMsg');
  const q = ['select=*', 'order=asset_code'];
  const pick = (id, col) => {
    const v = msValues(id);
    if (!v.length) return;
    q.push(v.length === 1 ? `${col}=eq.${v[0]}`
                          : `${col}=in.(${v.map(x => `"${x}"`).join(',')})`);
  };
  pick('alShip', 'shipment_id');
  pick('alDept', 'dept_code');
  pick('alLoc', 'location_code');

  // The project code lives on the asset as purpose_code -- that is what the
  // intake screen writes from its "Project" field.
  const proj = $('#alProjF').value.trim();
  if (proj) q.push('purpose_code=ilike.*' + proj.replace(/[(),*]/g, ' ').trim() + '*');

  const nm = $('#alName').value.trim().replace(/[(),*]/g, ' ').trim();
  if (nm) q.push(`or=(name_vi.ilike.*${nm}*,name_en.ilike.*${nm}*)`);

  // One picker for both levels: "g:C2112" is an accounting group, "c:FUR" a category.
  /* One picker holds both levels. Groups and categories filter different
     columns, so a mixed selection has to become an OR across the two. */
  const cats = msValues('alCat');
  const grp = cats.filter(c => c.startsWith('g:')).map(c => c.slice(2));
  const cc = cats.filter(c => c.startsWith('c:')).map(c => c.slice(2));
  const lst = a => a.map(x => `"${x}"`).join(',');
  if (grp.length && cc.length)
    q.push(`or=(group_code.in.(${lst(grp)}),category_code.in.(${lst(cc)}))`);
  else if (grp.length) q.push(`group_code=in.(${lst(grp)})`);
  else if (cc.length) q.push(`category_code=in.(${lst(cc)})`);
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

/* Company identity ranged left, document identity ranged right — the layout of
   the original ASSET LABEL RECEIPT.xlsx. The project code is deliberately not
   printed: the receipt number already carries it (FFE.KIT.05.2025 -> AL.KIT.05.2025). */
function docHeader() {
  return [el('div', { className: 'doc-head' }, [
    el('div', { className: 'left' }, [
      el('div', { className: 'co', textContent: t('alr.doc.company') }),
      el('div', { className: 'addr', textContent: t('alr.doc.addr') })
    ]),
    el('div', { className: 'right' }, [
      el('div', { className: 'ttl', textContent: t('alr.doc.title') }),
      el('div', { className: 'meta' }, [
        el('div', {}, [el('b', { textContent: t('alr.doc.no') }), $('#alCode').value || '—']),
        el('div', {}, [el('b', { textContent: t('alr.doc.date') }), fmtDate($('#alDate').value)])
      ])
    ])
  ])];
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

  const COLS = [['alr.doc.h.no', '4%'], ['alr.doc.h.code', '16%'], ['alr.doc.h.name', '18%'],
                ['alr.doc.h.qty', '7%'], ['alr.doc.h.spec', '27%'], ['alr.doc.h.price', '10%'],
                ['alr.doc.h.loc', '13%'], ['alr.doc.h.label', '5%']];
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
      // An empty box the receiver ticks to confirm the label was attached --
      // as in the original form. The barcode belongs on the label itself,
      // not in a column of the receipt.
      el('td', { className: 'lbl' }, el('span', { className: 'tick' }))
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
    el('div', {}, [el('b', { textContent: t('alr.doc.approved') }),
                   el('i', {}), document.createTextNode($('#alAppr').value || '')]),
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

/* ------------------------------------------------- Brother 18 mm labels
   Rebuilt from the three P-touch templates in Template Beetrack_PHCL
   (Nhãn Sofitel / Nhãn Central Plaza / Nhãn PHCL). All three are identical in
   geometry, so one layout covers them:

     tape    51.2pt x 180pt landscape  = 18.0 x 63.5 mm  (Brother PT-P900W)
     printed 174.4 x 46.8pt            = 61.5 x 16.5 mm
     layout  [ company 38pt ][ asset code 7.5pt + name 5.8pt, 90pt ][ QR 40pt ]

   The code is a QR, not Code128 -- that is what the existing labels carry and
   what the hand scanners in the hotel are set up to read. */
const LBL = { w: 63.5, h: 18, pad: 0.8 };   // mm

function qrSvg(text, mm) {
  const px = v => v + 'mm';
  try {
    const qr = qrcode(0, 'M');          // smallest version that fits, medium ECC
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
    svg.setAttribute('width', px(mm));
    svg.setAttribute('height', px(mm));
    svg.setAttribute('shape-rendering', 'crispEdges');
    let d = '';
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', '#000');
    svg.append(p);
    return svg;
  } catch {
    return el('code', { textContent: text, style: 'font-size:5pt' });
  }
}

/* P-touch shrinks a text object until it fits its box; CSS has no equivalent,
   and a 24-character asset code does not fit 31.5 mm at 7.5pt. Measure and step
   down instead of letting the code silently truncate -- a clipped asset code on
   a printed label is worse than a small one. */
function fitText(node, maxPt, minPt) {
  let pt = maxPt;
  node.style.fontSize = pt + 'pt';
  while (pt > minPt && node.scrollWidth > node.clientWidth) {
    pt = Math.round((pt - 0.25) * 100) / 100;
    node.style.fontSize = pt + 'pt';
  }
  return pt;
}

function buildTape() {
  const rows = alrPicked();
  const root = $('#printRoot');
  root.innerHTML = '';
  if (!rows.length) { msg('#alOutMsg', 'err', t('alr.nonePicked')); return; }
  if (typeof qrcode !== 'function')
    return msg('#alOutMsg', 'err', t('alr.noQr'));

  const brand = $('#alBrand').value;
  const strip = el('div', { className: 'tape-wrap' });
  for (const r of rows) {
    strip.append(el('div', { className: 'tape' }, [
      el('div', { className: 'tp-co' }, brand.split('|').map(s =>
        el('div', { textContent: s }))),
      el('div', { className: 'tp-mid' }, [
        el('div', { className: 'tp-code', textContent: r.asset_code }),
        el('div', { className: 'tp-name',
                    textContent: [r.name_vi, r.name_en].filter(Boolean).join('/') })
      ]),
      el('div', { className: 'tp-qr' }, qrSvg(r.barcode, 14.5))
    ]));
  }
  root.append(strip);

  // Only measurable once attached. Every asset code then gets the size the
  // longest one needs, so a batch of labels looks like one batch.
  const codes = [...strip.querySelectorAll('.tp-code')];
  let smallest = 7.5;
  for (const n of codes) smallest = Math.min(smallest, fitText(n, 7.5, 4.5));
  for (const n of codes) n.style.fontSize = smallest + 'pt';
  for (const n of strip.querySelectorAll('.tp-name')) fitText(n, 5.8, 4);

  ALR.mode = 'tape';
  $('#btnAlPrint').disabled = false;
  msg('#alOutMsg', 'ok', t('alr.tapeBuilt', { n: rows.length, pt: smallest }));
}

/* The receipt needs A4 landscape, the A4 label sheet portrait, and the Brother
   tape its own page the exact size of one label. @page has to be rewritten
   before every print because the three cannot coexist. */
function printNow() {
  document.getElementById('am-page-rule')?.remove();
  const st = el('style', { id: 'am-page-rule' });
  st.textContent = ALR.mode === 'tape'
    ? `@page{size:${LBL.w}mm ${LBL.h}mm;margin:0}`
    : `@page{size:A4 ${ALR.mode === 'doc' ? 'landscape' : 'portrait'};margin:10mm}`;
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
      approved_by: $('#alAppr').value.trim() || null,
      received_by: $('#alRecv').value.trim() || null,
      notes_text: $('#alNotes').value,
      // These record WHICH filter produced the receipt. With several picked
      // there is no single answer, so only a lone choice is stored.
      shipment_id: msValues('alShip').length === 1 ? msValues('alShip')[0] : null,
      dept_code: msValues('alDept').length === 1 ? msValues('alDept')[0] : null,
      location_code: msValues('alLoc').length === 1 ? msValues('alLoc')[0] : null
    }]);
    await SB.insert('am_alr_line',
      rows.map((r, i) => ({ alr_id: alr.id, line_no: i + 1, asset_id: r.id })));
    msg('#alOutMsg', 'ok', t('alr.saved', { code: alr.code, id: alr.id, n: rows.length }));
    alrHistory();
  } catch (e) { msg('#alOutMsg', 'err', t('alr.saveFail', { err: e.message })); }
}

/* ------------------------------------------------------- saved receipts
   A receipt that has been printed and handed over is a record, so it has to be
   reopenable: the lines are stored by asset_id, and the assets are re-read at
   open time rather than copied, so a later correction to an asset shows up. */
async function alrHistory() {
  const box = $('#alHist');
  box.innerHTML = '';
  if (!SB.ready()) return;
  let list;
  try {
    list = await SB.select('am_alr',
      'select=id,code,issue_date,project_code,prepared_by,received_by,' +
      'am_alr_line(count)&order=id.desc&limit=50');
  } catch (e) { return msg('#alHistMsg', 'warn', e.message); }
  if (!list.length) return msg('#alHistMsg', '', t('alr.histEmpty'));
  msg('#alHistMsg', '', '');

  const tb = el('table');
  tb.append(el('tr', {}, ['alr.h.code', 'alr.h.date', 'alr.h.project', 'alr.h.lines', '']
    .map(k => el('th', { textContent: k ? t(k) : '' }))));
  for (const a of list) {
    const open = el('button', { className: 'btn', textContent: t('alr.histOpen') });
    open.onclick = () => alrOpen(a.id);
    tb.append(el('tr', {}, [
      el('td', {}, el('code', { textContent: a.code || '#' + a.id })),
      el('td', { textContent: fmtDate(a.issue_date) }),
      el('td', { textContent: a.project_code || '' }),
      el('td', { className: 'num', textContent: fmtInt(a.am_alr_line?.[0]?.count ?? 0) }),
      el('td', {}, open)
    ]));
  }
  box.append(el('div', { className: 'wrap', style: 'max-height:30vh' }, tb));
}

async function alrOpen(id) {
  const out = $('#alHistMsg');
  msg(out, 'info', t('alr.histLoading'));
  try {
    const [a] = await SB.select('am_alr', `select=*&id=eq.${id}`);
    if (!a) return msg(out, 'err', t('alr.histGone'));
    const lines = await SB.select('am_alr_line',
      `select=line_no,am_asset(*)&alr_id=eq.${id}&order=line_no`);

    $('#alCode').value = a.code || '';
    $('#alDate').value = a.issue_date || '';
    $('#alProject').value = a.project_code || '';
    $('#alPrep').value = a.prepared_by || '';
    $('#alAppr').value = a.approved_by || '';
    $('#alRecv').value = a.received_by || '';
    if (a.notes_text) $('#alNotes').value = a.notes_text;

    const locs = await lookup('am_location').catch(() => []);
    const lmap = new Map(locs.map(l => [l.v, l.t]));
    // A line whose asset was deleted comes back with am_asset null: drop it and
    // say so, rather than printing a blank row.
    const got = lines.filter(l => l.am_asset);
    ALR.rows = got.map(l => ({ ...l.am_asset, _pick: true,
      location_name: (lmap.get(l.am_asset.location_code) || '').split(' — ')[1] || '' }));
    ALR.demo = false;
    renderAlrList();
    const lost = lines.length - got.length;
    msg(out, lost ? 'warn' : 'ok',
        t(lost ? 'alr.histOpenedGaps' : 'alr.histOpened',
          { code: a.code || '#' + id, n: got.length, lost }));
    buildDoc();
  } catch (e) { msg(out, 'err', e.message); }
}

async function fillAlrPickers() {
  try {
    const [deps, locs] = await Promise.all([
      SB.select('am_org', 'select=code,name_vi,name_en&is_department=is.true&order=code'),
      SB.select('am_location', 'select=code,name&order=code')
    ]);
    const nm = o => (LANG === 'vi' ? o.name_vi : o.name_en) || o.name_vi || '';
    msSetup('alDept', deps.map(o => ({ v: o.code, t: `${o.code} — ${nm(o)}` })));
    msSetup('alLoc', locs.map(o => ({ v: o.code, t: `${o.code} — ${o.name}` })));

    const sh = await SB.select('am_shipment',
      'select=id,code,delivery_date,purpose_code&order=id.desc&limit=100');
    msSetup('alShip', sh.map(o => ({ v: String(o.id), t:
      [o.code || '#' + o.id, o.purpose_code, o.delivery_date].filter(Boolean).join(' · ') })));

    // One list, two levels: accounting groups first, then the categories under
    // them. The prefix tells loadAlrAssets() which column to filter on.
    const [grps, cats] = await Promise.all([
      SB.select('am_category_group', 'select=code,name_vi,name_en&order=sort_order'),
      SB.select('am_category', 'select=code,group_code,name_vi,name_en&order=group_code,code')
    ]);
    msSetup('alCat', [
      ...grps.map(o => ({ v: 'g:' + o.code,
                          t: `${t('alr.catGroup')} · ${o.code} — ${nm(o)}` })),
      ...cats.map(o => ({ v: 'c:' + o.code,
                          t: `${o.code} (${o.group_code}) — ${nm(o)}` }))
    ]);
  } catch { /* the Connection screen already reports it */ }
}

function initAlr() {
  $('#alNotes').value = ALR_NOTES[LANG] || ALR_NOTES.en;
  $('#alDate').value = new Date().toISOString().slice(0, 10);
  const sync = () => { $('#alCode').value = alrCodeFromProject($('#alProject').value); };
  sync();
  $('#alProject').oninput = sync;
  ['alShip', 'alDept', 'alLoc', 'alCat'].forEach(id => msSetup(id, []));
  // Picking exactly one delivery batch offers up its project code.
  MS.alShip.onChange = () => {
    const v = msValues('alShip');
    if (v.length !== 1) return;
    const txt = (MS.alShip.opts.find(o => o.v === v[0]) || {}).t || '';
    const m = /\b((?:FFE|CAPEX)\.[A-Z]+\.\d+\.\d{4})\b/i.exec(txt);
    if (m) { $('#alProject').value = m[1]; sync(); }
  };
  $('#btnAlLoad').onclick = loadAlrAssets;
  $('#btnAlDemo').onclick = loadAlrDemo;
  $('#btnAlReset').onclick = () => {
    ['alShip', 'alDept', 'alLoc', 'alCat'].forEach(msClear);
    $('#alProjF').value = ''; $('#alName').value = '';
  };
  $('#alName').onkeydown = ev => { if (ev.key === 'Enter') loadAlrAssets(); };
  $('#alProjF').onkeydown = ev => { if (ev.key === 'Enter') loadAlrAssets(); };
  $('#btnAlDoc').onclick = buildDoc;
  $('#btnAlLabels').onclick = buildLabels;
  $('#btnAlTape').onclick = buildTape;
  $('#btnAlPrint').onclick = printNow;
  $('#btnAlSave').onclick = saveAlr;
  $('#btnAlHist').onclick = alrHistory;
  renderAlrList();
}

/* --------------------------------------------------------- navigation */
/* Each entry is [viewId, labelKey, children?]. Children render one level
   deeper, so an item that belongs to another one sits under it rather than
   beside it. */
/* Assets first: the register is the thing people open the app for, and intake,
   the label receipt and the counters are all steps around it — so they live in
   that one module instead of being scattered as sibling groups. Origin sits
   under the catalogue (it is master data like the rest) and backup under the
   system (it is plumbing, not daily work). */
const NAV = [
  ['nav.assets', [
    ['register', 'nav.register'],
    ['intake', 'nav.intake'],
    ['alr', 'nav.alr'],
    ['counter', 'nav.counter']
  ]],
  ['nav.catalog', [
    ['tbl:am_org', null, [['tbl:am_org_alias', null]]],
    ['cat', 'nav.cat'],
    ['tbl:am_unit', null], ['tbl:am_location', null], ['tbl:am_product', null],
    // A heading, not a screen: the three origin tables belong together, and
    // none of them is the natural parent of the other two.
    [null, 'nav.originHead', [['tbl:am_origin', null],
                              ['tbl:am_origin_alias', null],
                              ['tbl:am_origin_rejected', null]]]
  ]],
  ['nav.system', [
    ['sources', 'nav.sources'], ['tbl:am_setting', null],
    ['backup', 'nav.backup'], ['setup', 'nav.setup']
  ]]
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
    const flat = items.flatMap(([id, , ch]) => [id, ...(ch || []).map(c => c[0])])
                      .filter(Boolean);        // a heading has no view of its own
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

    const addItem = (id, labelKey, depth, into) => {
      const a = el('a', { href: '#' });
      a.dataset.view = id;
      a.classList.toggle('on', id === VIEW);
      if (depth) a.classList.add('sub');
      a.append(el('span', { className: 'lbl',
        textContent: labelKey ? t(labelKey) : tblLabel(id.slice(4)) }));
      a.onclick = ev => { ev.preventDefault(); showView(id); };
      (into || kids).append(a);
      return a;
    };

    /* An item that has children folds them away. The caret is its own click
       target inside the link, so opening the branch and opening the screen stay
       separate actions. Folded by default, same as the headings: the parent is
       what people navigate to, the children are occasional. */
    const addBranch = (parent, children) => {
      const key = 'subopen:' + parent.dataset.view;
      const inner = el('div', { className: 'subkids' });
      const holds = children.some(c => c[0] === VIEW);
      const shut = !holds && !NAV_SHUT.has(key);
      inner.classList.toggle('shut', shut);
      const car = el('button', { className: 'car' + (shut ? ' shut' : ''),
                                 textContent: '▶', title: t('tree.fold') });
      car.onclick = ev => {
        ev.preventDefault(); ev.stopPropagation();
        const nowShut = !inner.classList.contains('shut');
        inner.classList.toggle('shut', nowShut);
        car.classList.toggle('shut', nowShut);
        if (nowShut) NAV_SHUT.delete(key); else NAV_SHUT.add(key);
        navSaveShut();
      };
      parent.prepend(car);
      parent.after(inner);
      for (const [cid, ckey] of children) addItem(cid, ckey, 1, inner);
    };
    for (const [id, labelKey, children] of items) {
      if (id) {
        const a = addItem(id, labelKey, 0);
        if (children && children.length) addBranch(a, children);
        continue;
      }
      /* A heading with no screen of its own still folds, like the groups above
         it — otherwise it is the one thing in the nav that cannot be closed. */
      /* Folded by default, unlike the top-level groups: these are lookup tables
         opened once in a while, and left open they cost four lines in every
         screen's sidebar. The key records the OPPOSITE — that the user opened
         it — so "no state" means closed. */
      /* Built from the same DOM as a real entry — <a> with a .car and a .lbl —
         so it inherits the identical type, colour and indent. The only
         difference is that it opens nothing: it has no data-view, and clicking
         anywhere on it folds instead of navigating. */
      const key = 'subopen:' + labelKey;
      const inner = el('div', { className: 'subkids' });
      const holds = (children || []).some(c => c[0] === VIEW);
      const shutSub = !holds && !NAV_SHUT.has(key);
      inner.classList.toggle('shut', shutSub);

      const head = el('a', { href: '#', className: 'branch' });
      const car = el('button', { className: 'car' + (shutSub ? ' shut' : ''),
                                 textContent: '▶', title: t('tree.fold') });
      head.append(car, el('span', { className: 'lbl', textContent: t(labelKey) }));
      head.onclick = ev => {
        ev.preventDefault();
        const nowShut = !inner.classList.contains('shut');
        inner.classList.toggle('shut', nowShut);
        car.classList.toggle('shut', nowShut);
        if (nowShut) NAV_SHUT.delete(key); else NAV_SHUT.add(key);
        navSaveShut();
      };
      kids.append(head, inner);
      for (const [cid, ckey] of children || []) addItem(cid, ckey, 1, inner);
    }
    nav.append(head, kids);
  }
}

/* ------------------------------------------------- page chrome, app-wide
   Two things the screens have in common, applied once instead of card by card
   so a new card picks them up for free. */

/* Explanations are worth having but not worth re-reading every day, so they
   start hidden behind one switch in the top bar. */
const HELP_KEY = 'asset-intake.help';
let HELP_ON = (() => { try { return localStorage.getItem(HELP_KEY) === '1'; } catch { return false; } })();
function applyHelp() {
  document.body.classList.toggle('nohelp', !HELP_ON);
  const b = $('#btnHelp');
  if (b) {
    b.classList.toggle('on', HELP_ON);
    b.title = t(HELP_ON ? 'tool.helpOff' : 'tool.helpOn');
  }
}

/* Lift a card's action row onto its heading line. Cards are written heading →
   fields → actions, which reads well in the source but leaves the buttons
   hunting for an edge on screen. */
function layoutCards() {
  for (const card of $$('.card')) {
    const h2 = card.querySelector(':scope > h2');
    if (!h2 || h2.parentElement !== card) continue;
    const acts = [...card.querySelectorAll(':scope > .row')]
      .find(r => !r.querySelector('.fld') && r.querySelector('button'));
    if (!acts) continue;
    const head = el('div', { className: 'chead' });
    card.insertBefore(head, h2);
    acts.style.marginTop = '';
    head.append(h2, acts);
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
    // Only offered where there is actually a hierarchy to show.
    if (TREE_PARENT[table]) {
      const seg = el('div', { className: 'seg' });
      for (const [on, key] of [[true, 'tree.tree'], [false, 'tree.flat']]) {
        const b = el('button', { textContent: t(key) });
        b.classList.toggle('on', TREE_ON === on);
        b.onclick = () => {
          if (TREE_ON === on) return;
          TREE_ON = on;
          try { localStorage.setItem(TREE_KEY, on ? '1' : '0'); } catch {}
          // buildTools rebuilds the filter box, so carry its text across.
          const keep = $('#filter')?.value || '';
          buildTools(VIEW);
          if ($('#filter')) $('#filter').value = keep;
          renderGrid();
        };
        seg.append(b);
      }
      box.append(seg);
      if (TREE_ON) {
        const anyShut = (SHUT[table] || []).length > 0;
        const fold = el('button', { className: 'btn',
          textContent: t(anyShut ? 'tree.expandAll' : 'tree.foldAll') });
        fold.onclick = () => {
          if (anyShut) shutSave(table, new Set());
          else {
            // Fold every branch that has children, so only the top level shows.
            const pf = TREE_PARENT[table], set = new Set();
            const present = new Set((CUR?.rows || [])
              .filter(r => !r.del).map(r => String(r.cur[TABLES[table].pk] ?? '')));
            for (const r of (CUR?.rows || [])) {
              if (r.del) continue;
              const p = r.cur[pf];
              if (p == null || p === '') continue;
              set.add(present.has(String(p)) ? String(p) : 'head:' + p);
            }
            shutSave(table, set);
          }
          const keep = $('#filter')?.value || '';
          buildTools(VIEW);
          if ($('#filter')) $('#filter').value = keep;
          renderGrid();
        };
        box.append(fold);
      }
    }
    const f = el('input', { id: 'filter', style: 'width:190px' });
    f.placeholder = t('tool.filter');
    f.oninput = () => renderGrid();
    const reload = el('button', { className: 'btn', textContent: t('tool.reload') });
    reload.onclick = () => loadTable(table);
    box.append(f, reload);

    const edit = el('button', { className: 'btn' + (EDIT ? ' pri' : ''),
                                textContent: t(EDIT ? 'tool.editOff' : 'tool.editOn') });
    edit.onclick = () => {
      const n = (CUR?.rows || []).filter(r => r.isNew || r.dirty || r.del).length;
      if (EDIT && n && !confirm(t('table.confirmLeave', { n }))) return;
      if (EDIT && n) loadTable(table);       // leaving edit discards unsaved edits
      EDIT = !EDIT;
      const keep = $('#filter')?.value || '';
      buildTools(VIEW);
      if ($('#filter')) $('#filter').value = keep;
      renderGrid();
    };
    box.append(edit);

    if (EDIT) {
      const add = el('button', { className: 'btn', textContent: t('tool.add') });
      add.onclick = addRow;
      const save = el('button', { className: 'btn pri', id: 'btnCommit',
                                  textContent: t('tool.save'), disabled: true });
      save.onclick = commit;
      box.append(add, save);
      dirtyCheck();
    }
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
    // The rule tester lives inside the counters screen now, so its pickers
    // load with that screen.
    if (view === 'counter' && SB.ready()) fillPickers();
    if (view === 'alr' && SB.ready()) { fillAlrPickers(); alrHistory(); }
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

  // The multi-select summaries and their option labels are built text, not
  // data-i18n markup, so applyI18n() cannot reach them.
  for (const id of Object.keys(MS)) {
    if (id === 'regKind')
      msSetup(id, [{ v: 'unique', t: t('reg.kindUnique') }, { v: 'low', t: t('reg.kindLow') }]);
    else msRender(id);
  }

  $('#connTxt').textContent = t(CONN.ok ? 'conn.ok' : 'conn.none');
  applyHelp();
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
  layoutCards();          // once: the cards are static markup
  $('#appVer').textContent = 'v' + APP_VERSION;
  $('#btnHelp').onclick = () => {
    HELP_ON = !HELP_ON;
    try { localStorage.setItem(HELP_KEY, HELP_ON ? '1' : '0'); } catch {}
    applyHelp();
  };
  applyHelp();
  $$('#langSeg button').forEach(b => { b.onclick = () => switchLang(b.dataset.lang); });
  buildNav();

  /* The connection details are masked by default. The repo is public and the
     link carrying them gets shared, so they should not sit on screen during a
     screen-share or a screenshot unless someone asks to see them. */
  for (const [btn, field] of [['#btnShowUrl', '#sbUrl'], ['#btnShowKey', '#sbKey']]) {
    $(btn).onclick = () => {
      const i = $(field), show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      $(btn).textContent = t(show ? 'setup.hide' : 'setup.show');
    };
  }

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
    // Same card + heading + wrap as the history table below, so the two read as
    // one pair rather than one loose table above a framed one.
    cur.innerHTML = '';
    cur.append(el('div', { className: 'card' }, [
      el('h2', { textContent: t('src.h.current') }),
      el('div', { className: 'wrap' }, tb)
    ]));

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

/* ------------------------------------------------------ blank templates
   The upload boxes above only accept a sheet whose columns they recognise, so
   the app has to be able to hand out that shape. Headers come from the same
   TABLES descriptors the grids are built from — they cannot drift apart — and
   the asset upload sheet from the Beetrack column maps. A few real rows are
   included when connected, because a column is far easier to fill in correctly
   with an example beside it than from a bare heading. */
const TPL_MASTER = ['am_org', 'am_org_alias', 'am_category_group', 'am_category',
                    'am_unit', 'am_origin', 'am_origin_alias', 'am_location',
                    'am_product'];

function tplFill() {
  const s = $('#tplPick');
  if (!s || s.options.length) return;
  for (const tbl of TPL_MASTER)
    s.append(el('option', { value: 'tbl:' + tbl, textContent: tblLabel(tbl) }));
  s.append(el('option', { value: 'beetrack', textContent: t('tpl.beetrack') }));
}

async function tplGet() {
  const out = $('#tplMsg');
  const pick = $('#tplPick').value;
  const want = Number($('#tplRows').value) || 0;
  try {
    msg(out, 'info', t('tpl.building'));
    const wb = XLSX.utils.book_new();
    let file;

    if (pick === 'beetrack') {
      // Exactly the two sheets the Beetrack importer accepts, headers only.
      for (const [name, cols] of [['Unique asset', BT_UNIQUE], ['Low-value asset', BT_LOW]])
        XLSX.utils.book_append_sheet(wb, btSheet(cols, []), name);
      file = `phcl-template-asset-upload-${bkStamp()}.xlsx`;
    } else {
      const tbl = pick.slice(4);
      const cols = TABLES[tbl].cols.map(c => c.name);
      let rows = [];
      if (want && SB.ready()) {
        try {
          rows = await SB.select(tbl,
            `select=${cols.join(',')}&order=${TABLES[tbl].order || TABLES[tbl].pk}&limit=${want}`);
        } catch { /* headers alone are still a usable template */ }
      }
      const aoa = [cols, ...rows.map(r => cols.map(c => {
        const v = r[c];
        return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
      }))];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), tbl.slice(0, 31));
      file = `phcl-template-${tbl}-${bkStamp()}.xlsx`;
    }
    XLSX.writeFile(wb, file);
    msg(out, 'ok', t('tpl.done', { file }));
  } catch (e) { msg(out, 'err', e.message); }
}

function initSources() {
  $('#btnSrcRead').onclick = srcRead;
  $('#btnSrcImport').onclick = srcImport;
  $('#btnTplGet').onclick = tplGet;
  tplFill();
}

/* ========================================================= ASSET REGISTER
   Every asset that already carries a code. 17k rows is far too many to put in
   the DOM, so filtering, sorting and paging all happen on the server; only one
   page is ever rendered. Export walks the same filter page by page. */

/* "name" is not a column of am_asset: it is name_vi and name_en joined with a
   slash, the way the register and the Beetrack sheets have always shown them.
   It is fetched as the two real columns and merged at render time. */
const REG_JOINED = { name: ['name_vi', 'name_en'] };

const REG_COLS = [
  'asset_code', 'barcode', 'asset_kind', 'name', 'name_vi', 'name_en',
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
const REG_DEFAULT = ['asset_code', 'barcode', 'name', 'category_code',
                     'dept_code', 'location_code', 'qty', 'unit_code',
                     'unit_price', 'purchase_date', 'status_code'];
/* How each column is rendered. Only money and quantities are right-aligned —
   header included — everything else reads better ranged left.
   Years and sequence numbers are numeric but are NOT quantities: a thousands
   separator turns 2026 into "2,026", so they print as plain digits. */
const REG_RIGHT = new Set(['qty', 'unit_price', 'depreciate_months']);
const REG_PLAIN = new Set(['seq', 'purchase_year', 'spec_mfg_year']);
const REG_DATE  = new Set(['purchase_date', 'in_use_date', 'created_at']);

function regCell(col, v, row) {
  if (REG_JOINED[col])
    return REG_JOINED[col].map(f => (row?.[f] || '').trim())
                          .filter(Boolean).join(' / ');
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
let REG = { cols: null, sort: 'asset_code', dir: 'asc', page: 0, total: 0, rows: [], colq: {} };

function regLoadCols() {
  try {
    const saved = JSON.parse(localStorage.getItem(REG_KEY) || 'null');
    // Drop anything that is no longer a real column, so an old saved layout
    // cannot ask PostgREST for a field that does not exist.
    if (Array.isArray(saved) && saved.length) {
      let cols = saved.filter(c => REG_COLS.includes(c));
      // A layout saved before the two name columns were merged still lists them
      // separately; fold them into the joined column in place, so the change
      // reaches people who have used the screen before, not just new browsers.
      if (cols.includes('name_vi') || cols.includes('name_en')) {
        const at = Math.min(...['name_vi', 'name_en'].map(c => cols.indexOf(c))
                                                     .filter(i => i >= 0));
        cols = cols.filter(c => c !== 'name_vi' && c !== 'name_en');
        if (!cols.includes('name')) cols.splice(at, 0, 'name');
        REG.cols = cols;
        regSaveCols();
        if (REG.cols.length) return;
      }
      REG.cols = cols;
      if (REG.cols.length) return;
    }
  } catch {}
  REG.cols = [...REG_DEFAULT];
}
const regSaveCols = () => {
  try { localStorage.setItem(REG_KEY, JSON.stringify(REG.cols)); } catch {}
};

const regSafe = s => String(s).replace(/[(),*]/g, ' ').trim();

function regFilters() {
  const f = [];          // plain params, ANDed by PostgREST
  const ors = [];        // groups that need OR inside them

  const q = regSafe($('#regQ').value);
  if (q) ors.push(['asset_code', 'name_vi', 'name_en', 'barcode']
                  .map(c => `${c}.ilike.*${q}*`));

  /* One pick is `eq`, several are `in.(a,b,c)` — PostgREST needs the values
     quoted there, because a code could contain a comma or a bracket. */
  const pick = (id, col) => {
    const v = msValues(id);
    if (!v.length) return;
    f.push(v.length === 1 ? `${col}=eq.${v[0]}`
                          : `${col}=in.(${v.map(x => `"${x}"`).join(',')})`);
  };
  pick('regDept', 'dept_code');
  pick('regCat', 'category_code');
  pick('regLoc', 'location_code');
  pick('regKind', 'asset_kind');
  const y = $('#regYear').value.trim();
  if (y) f.push('purchase_year=eq.' + Number(y));

  /* Per-column boxes under the header. Sent to PostgREST rather than applied to
     the page in hand: filtering only the 200 rows on screen would quietly lie
     about the other 15,000. */
  for (const [col, raw] of Object.entries(REG.colq || {})) {
    const v = regSafe(raw);
    if (!v) continue;
    const parts = REG_JOINED[col] || [col];
    const term = p => REG_NUMERIC.has(p) ? `eq.${Number(v) || 0}` : `ilike.*${v}*`;
    if (parts.length > 1) ors.push(parts.map(p => `${p}.${term(p)}`));
    else f.push(`${parts[0]}=${term(parts[0])}`);
  }

  // A query string cannot carry two `or=` keys, so more than one OR group has
  // to be nested inside a single `and=`.
  if (ors.length === 1) f.push(`or=(${ors[0].join(',')})`);
  else if (ors.length > 1)
    f.push(`and=(${ors.map(g => `or(${g.join(',')})`).join(',')})`);
  return f;
}

/* Columns PostgREST will not accept ilike on. */
const REG_NUMERIC = new Set(['seq', 'purchase_year', 'qty', 'unit_price',
                             'depreciate_months']);

/* Only real columns may be asked of PostgREST; a joined one expands to its parts. */
function regSelect() {
  const real = new Set(['id']);
  for (const c of REG.cols) (REG_JOINED[c] || [c]).forEach(x => real.add(x));
  return [...real].join(',');
}

async function regLoad(resetPage) {
  if (resetPage) REG.page = 0;
  const out = $('#regMsg');
  msg(out, 'info', t('reg.loading'));
  try {
    const sel = regSelect();
    // A joined column cannot be sorted on by name -- sort on its first real
    // part instead, so clicking "name" orders by name_vi.
    const sort = REG_JOINED[REG.sort] ? REG_JOINED[REG.sort][0] : REG.sort;
    const q = ['select=' + sel, `order=${sort}.${REG.dir}`,
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
  hr.append(el('th', { className: 'num idx', textContent: '#' }));
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

  /* A filter box per column, applied on the server so it searches the whole
     register and not just the page on screen. */
  const fr = el('tr', { className: 'colf' });
  // A loop glyph rather than a word: it sits in a table header cell as narrow
  // as the # column, and needs no translating.
  const over = el('button', { className: 'btn ico', textContent: '↻',
                              title: t('reg.startOver') });
  over.onclick = () => { REG.colq = {}; regLoad(true); };
  fr.append(el('th', { className: 'overcol' }, over));
  for (const c of REG.cols) {
    const box = el('input', { value: REG.colq?.[c] ?? '', placeholder: t('reg.colqPh'),
                              spellcheck: false });
    box.onchange = () => {
      REG.colq = REG.colq || {};
      const v = box.value.trim();
      if (v) REG.colq[c] = v; else delete REG.colq[c];
      regLoad(true);
    };
    box.onkeydown = ev => { if (ev.key === 'Enter') box.onchange(); };
    fr.append(el('th', {}, box));
  }
  head.append(fr);

  const from = REG.page * REG_SIZE;
  REG.rows.forEach((r, i) => {
    const tr = el('tr');
    // Numbered across the whole filtered set, not restarted on every page.
    tr.append(el('td', { className: 'num idx', textContent: fmtInt(from + i + 1) }));
    for (const c of REG.cols) {
      tr.append(el('td', {
        className: REG_RIGHT.has(c) ? 'num' : '',
        textContent: regCell(c, r[c], r)
      }));
    }
    body.append(tr);
  });
  if (!REG.rows.length)
    body.append(el('tr', {}, el('td', { colSpan: (REG.cols.length || 1) + 1,
      style: 'color:var(--dim);padding:14px', textContent: t('reg.empty') })));

  /* Which rows of which total, and where in the run. With a filter on, the
     total is the FILTERED total — otherwise the number would quietly claim the
     filter found more than it did. */
  const pages = Math.max(1, Math.ceil(REG.total / REG_SIZE));
  const firstRow = REG.total ? from + 1 : 0;      // `from` is the page offset
  const lastRow = from + REG.rows.length;
  const box = $('#regPage');
  box.innerHTML = '';
  box.append(
    el('b', { textContent: `${fmtInt(firstRow)}–${fmtInt(lastRow)}` }),
    document.createTextNode(' ' + t('reg.ofRows', { total: fmtInt(REG.total) }) + ' · '),
    el('b', { textContent: t('reg.page', { p: fmtInt(REG.page + 1), n: fmtInt(pages) }) }));
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
  const sel = regSelect();
  const sort = REG_JOINED[REG.sort] ? REG_JOINED[REG.sort][0] : REG.sort;
  const all = [];
  for (let off = 0; ; off += 1000) {
    const q = ['select=' + sel, `order=${sort}.${REG.dir}`,
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
    // Reorder each object so the sheet columns follow the chosen order, and add
    // the running number. A joined column has no raw value, so it is built here
    // too -- otherwise the sheet would carry an empty "name".
    const shaped = rows.map((r, i) => Object.fromEntries([
      ['#', i + 1],
      ...REG.cols.map(c => [c, REG_JOINED[c] ? regCell(c, null, r) : r[c]])
    ]));
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
      el('div', { className: 'left' }, [
        el('div', { className: 'co', textContent: t('alr.doc.company') }),
        el('div', { className: 'addr', textContent: t('alr.doc.addr') })
      ]),
      el('div', { className: 'right' }, [
        el('div', { className: 'ttl', textContent: t('page.register') }),
        el('div', { className: 'meta' }, [
          el('div', {}, [el('b', { textContent: t('alr.doc.date') }),
                         fmtDate(new Date().toISOString().slice(0, 10))]),
          el('div', {}, t('reg.count', { shown: fmtInt(rows.length),
                                         total: fmtInt(REG.total) }))
        ])
      ])
    ]));
    const tb = el('table', { className: 'doc' });
    tb.append(el('thead', {}, el('tr', {}, [
      el('th', { className: 'r', textContent: '#' }),
      ...REG.cols.map(c =>
        el('th', { className: REG_RIGHT.has(c) ? 'r' : '', textContent: c }))])));
    const tbody = el('tbody');
    rows.forEach((r, i) =>
      tbody.append(el('tr', {}, [
        el('td', { className: 'r', textContent: fmtInt(i + 1) }),
        ...REG.cols.map(c => el('td', {
          className: REG_RIGHT.has(c) ? 'r' : '',
          textContent: regCell(c, r[c], r)
        }))])));
    tb.append(tbody);
    root.append(tb);
    msg(out, '', '');
    ALR.mode = 'doc';          // the register is wide: print it landscape
    printNow();
  } catch (e) { msg(out, 'err', e.message); }
}

/* ------------------------------------------------------- multi-select box
   A <select multiple> cannot show a summary, cannot be searched, and is
   miserable with 675 locations. This is a <details> holding a checkbox list
   with its own search box; the summary line says what is chosen.
   State lives here, keyed by the element id. */
const MS = {};

function msSetup(id, opts) {
  const host = $('#' + id);
  if (!host) return;
  const st = MS[id] || (MS[id] = { sel: new Set(), opts: [], q: '' });
  st.opts = opts;
  // Drop selections that no longer exist, so a stale pick cannot filter to nothing.
  const have = new Set(opts.map(o => o.v));
  for (const v of [...st.sel]) if (!have.has(v)) st.sel.delete(v);
  if (!host.dataset.built) {
    host.dataset.built = '1';
    host.append(
      el('summary', { className: 'ms-sum' }),
      el('div', { className: 'ms-body' }, [
        el('input', { className: 'ms-q', spellcheck: false }),
        el('div', { className: 'ms-list' }),
        el('div', { className: 'ms-acts' })
      ]));
    host.querySelector('.ms-q').oninput = ev => { st.q = ev.target.value; msList(id); };
  }
  msRender(id);
}

function msRender(id) {
  const host = $('#' + id), st = MS[id];
  const n = st.sel.size;
  host.querySelector('.ms-sum').textContent =
    n === 0 ? t('reg.all')
    : n === 1 ? [...st.sel][0]
    : t('ms.nChosen', { n });
  host.classList.toggle('picked', n > 0);
  host.querySelector('.ms-q').placeholder = t('ms.search');
  const acts = host.querySelector('.ms-acts');
  acts.innerHTML = '';
  const clr = el('button', { className: 'btn tiny', textContent: t('ms.clear') });
  clr.onclick = ev => { ev.preventDefault(); st.sel.clear(); msRender(id); st.onChange?.(); };
  acts.append(clr);
  msList(id);
}

function msList(id) {
  const host = $('#' + id), st = MS[id];
  const box = host.querySelector('.ms-list');
  const q = st.q.trim().toLowerCase();
  box.innerHTML = '';
  // Chosen entries stay on top so they never scroll out of reach of the search.
  const hit = st.opts.filter(o => !q || o.t.toLowerCase().includes(q));
  const shown = [...hit.filter(o => st.sel.has(o.v)), ...hit.filter(o => !st.sel.has(o.v))]
    .slice(0, 300);
  for (const o of shown) {
    const cb = el('input', { type: 'checkbox', checked: st.sel.has(o.v) });
    cb.onchange = () => {
      if (cb.checked) st.sel.add(o.v); else st.sel.delete(o.v);
      msRender(id); st.onChange?.();
    };
    box.append(el('label', { className: 'ms-i' }, [cb, el('span', { textContent: o.t })]));
  }
  if (!shown.length)
    box.append(el('div', { className: 'ms-none', textContent: t('ms.none') }));
  else if (hit.length > shown.length)
    box.append(el('div', { className: 'ms-none',
                           textContent: t('ms.more', { n: fmtInt(hit.length - shown.length) }) }));
}

const msValues = id => [...(MS[id]?.sel || [])];
const msClear = id => { if (MS[id]) { MS[id].sel.clear(); MS[id].q = ''; msRender(id); } };

async function regFillPickers() {
  try {
    const [deps, cats, locs] = await Promise.all([
      SB.select('am_org', 'select=code,name_vi,name_en&is_department=is.true&order=code'),
      SB.select('am_category', 'select=code,name_vi,name_en&order=code'),
      SB.select('am_location', 'select=code,name,kind&order=code')
    ]);
    const nm = o => (LANG === 'vi' ? o.name_vi : o.name_en) || o.name_vi || '';
    msSetup('regDept', deps.map(o => ({ v: o.code, t: `${o.code} — ${nm(o)}` })));
    msSetup('regCat', cats.map(o => ({ v: o.code, t: `${o.code} — ${nm(o)}` })));
    msSetup('regLoc', locs.map(o => ({ v: o.code, t: `${o.code} — ${o.name}` })));
    msSetup('regKind', [{ v: 'unique', t: t('reg.kindUnique') },
                        { v: 'low', t: t('reg.kindLow') }]);
    for (const id of ['regDept', 'regCat', 'regLoc', 'regKind'])
      MS[id].onChange = () => {};        // filters apply on Apply, not per tick
  } catch { /* the Connection screen already reports it */ }
}

function initRegister() {
  regLoadCols();
  regRenderCols();
  /* Build them empty up front. regFillPickers() needs the database, and if it
     fails the boxes must still look like filters — a bare <details> renders as
     the browser's own "Details" triangle, which is not a control anyone
     recognises. The kind list needs no database at all. */
  ['regDept', 'regCat', 'regLoc'].forEach(id => msSetup(id, []));
  msSetup('regKind', [{ v: 'unique', t: t('reg.kindUnique') },
                      { v: 'low', t: t('reg.kindLow') }]);

  $('#btnRegApply').onclick = () => regLoad(true);
  $('#btnRegReset').onclick = () => {
    $('#regQ').value = ''; $('#regYear').value = '';
    ['regDept', 'regCat', 'regLoc', 'regKind'].forEach(msClear);
    REG.colq = {};                       // the per-column boxes are filters too
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
const IN = { lines: [], checked: null, committed: [], sugRan: false };

/* The register keeps specifications in SEPARATE columns, not one blob — the
   label receipt and the Beetrack sheet both read them individually. Intake used
   to write none of them, so every asset it created had an empty spec cell.
   Key here = column in am_asset, minus the spec_ prefix. */
const SPEC_FIELDS = ['brand', 'model', 'function', 'capacity',
                     'length', 'width', 'height', 'weight',
                     'material', 'color', 'shape', 'radius', 'fuel',
                     'area', 'perimeter', 'mfg_year', 'accessory'];
const specFilled = ln => SPEC_FIELDS.filter(f => (ln.spec?.[f] || '').trim()).length;

const inBlank = () => ({
  name_vi: '', name_en: '', category_code: '', qty: 1, unit_code: 'pcs',
  unit_price: '', serials: '', origin_raw: '', location_code: '', description: '',
  spec: {}
});

function inRender() {
  const head = $('#inGrid thead'), body = $('#inGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  // Same shape as the register and the label-receipt picker.
  head.append(el('tr', {}, [
    el('th', { className: 'delcol' }),
    el('th', { className: 'num idx', textContent: '#' }),
    ...[['in.col.name'], ['in.col.desc'], ['in.col.spec'], ['in.col.cat'],
        ['in.col.qty', 1], ['in.col.unit'],
        ['in.col.price', 1], ['in.col.serial'], ['in.col.origin'], ['in.col.loc'],
        ['in.col.kind'], ['in.col.rows', 1], ['in.col.mem']]
      .map(([k, r]) => el('th', { className: r ? 'num' : '', textContent: t(k) }))
  ]));

  IN.lines.forEach((ln, i) => {
    const tr = el('tr');
    const del = el('button', { className: 'xbtn', textContent: '✕' });
    del.onclick = () => { IN.lines.splice(i, 1); IN.checked = null; inRender(); };
    tr.append(el('td', { className: 'delcol' }, del));
    tr.append(el('td', { className: 'num idx', textContent: fmtInt(i + 1) }));

    // 'num' on the cell puts the value AND its heading on the right edge, the
    // same rule the register follows.
    const txt = (field, w, type) => {
      const inp = el('input', { value: ln[field] ?? '', style: `width:${w}px`,
                                type: type || 'text' });
      inp.onchange = () => { ln[field] = type === 'number' ? inp.value : inp.value;
                             IN.checked = null; inRender(); };
      return el('td', { className: type === 'number' ? 'num' : '' }, inp);
    };
    const pick = (field, list, w) => {
      const s = el('select', { style: `width:${w}px` });
      s.append(el('option', { value: '', textContent: '—' }));
      for (const o of list)
        s.append(el('option', { value: o, textContent: o, selected: o === ln[field] }));
      s.onchange = () => { ln[field] = s.value; IN.checked = null; inRender(); };
      return el('td', {}, s);
    };

    // Name: one box carrying "vi / en", backed by the catalogue as a type-ahead.
    const nameTd = el('td');
    const nameIn = el('input', { style: 'width:230px', spellcheck: false,
                                 value: inLabel({ std_name_vi: ln.name_vi,
                                                  std_name_en: ln.name_en }) });
    nameIn.setAttribute('list', 'prodList');
    nameIn.onchange = () => { inSetName(ln, nameIn.value); IN.checked = null; inRender(); };
    nameTd.append(nameIn);
    if (IN.prod?.has(inLabel({ std_name_vi: ln.name_vi, std_name_en: ln.name_en })))
      nameTd.append(el('span', { className: 'sug', title: t('in.sug.product'),
                                 textContent: '★' }));
    tr.append(nameTd);

    /* What the delivery note actually said. When a standard name replaces the
       supplier's spec line, the original lands here — so the reviewer can see
       what the tidy name was derived from and correct it if the match was
       wrong. It also carries brand, model and any note off the paper. */
    const descTd = el('td');
    const desc = el('textarea', { className: 'ser', value: ln.description ?? '',
                                  rows: 2, spellcheck: false });
    desc.onchange = () => { ln.description = desc.value; IN.checked = null; };
    descTd.append(desc);
    if (ln._rawName)
      descTd.append(el('div', { className: 'sercount', textContent: t('in.fromNote') }));
    tr.append(descTd);

    /* Specs get a button, not 17 columns. The count is what matters at a glance
       — an asset with none will print an empty specification cell. */
    const nSpec = specFilled(ln);
    const spec = el('button', { className: 'btn ico wide' + (nSpec ? ' has' : ''),
                                textContent: nSpec ? `⚙ ${nSpec}` : '⚙',
                                title: t('in.specEdit') });
    spec.onclick = () => inSpecOpen(i);
    tr.append(el('td', {}, spec));

    // Category, plus the evidence behind the suggestion. A code filled in from
    // 40 historical rows and one filled in from a single row are not the same
    // claim, so the count is shown rather than hidden behind a tick.
    const catTd = pick('category_code', (window.__CATS || []).map(c => c.code), 110);
    if (ln._sug) {
      /* The badge says WHERE the code came from and HOW sure that is, because a
         code matched on the single word "base" is not the same claim as one
         backed by 47 register rows — and only the reviewer can tell them apart. */
      const s = ln._sug;
      const mark = s.src === 'product' ? '★'
                 : s.src === 'history' ? '×' + fmtInt(s.n)
                 : '“' + (s.term || '') + '”';
      catTd.append(el('span', {
        className: 'sug' + (s.conf === 'high' ? '' : s.conf === 'medium' ? ' weak' : ' poor'),
        title: t('in.sug.' + s.src, { n: fmtInt(s.n), term: s.term || '' }) +
               ' · ' + t('in.conf.' + (s.conf || 'none')),
        textContent: mark
      }));
    } else if (ln.name_vi && IN.sugRan) {
      // Only claim "the register does not know this name" once the lookup has
      // actually run. Before that, saying so would be a guess of our own.
      catTd.append(el('span', { className: 'sug none', title: t('in.sugNone'),
                                textContent: '?' }));
    }
    tr.append(catTd);
    tr.append(txt('qty', 60, 'number'));
    tr.append(pick('unit_code', IN.units || [], 90));
    tr.append(txt('unit_price', 120, 'number'));
    /* Serials go in a textarea, not an input: one line can carry 34 of them and
       an <input> renders the newlines as nothing, running the numbers together
       into one unreadable string. */
    const serTd = el('td');
    const ser = el('textarea', { className: 'ser', value: ln.serials ?? '',
                                 rows: 2, spellcheck: false });
    ser.onchange = () => { ln.serials = ser.value; IN.checked = null; inRender(); };
    const nSer = inSerials(ln).length;
    serTd.append(ser);
    if (nSer) serTd.append(el('div', { className: 'sercount',
      textContent: t('in.nSerials', { n: fmtInt(nSer), qty: fmtInt(Number(ln.qty) || 0) }) }));
    tr.append(serTd);
    tr.append(txt('origin_raw', 130));
    tr.append(txt('location_code', 110));

    /* Kind follows the unit price, so with no price there IS no kind. Saying
       "Low-value asset" because an empty box reads as 0 would be a claim the
       paperwork does not support — and on this delivery that was every line. */
    const kind = kindOf(ln);
    const rows = !kind ? null
               : kind === 'unique' ? (Number(ln.qty) || 0)
               : (inSerials(ln).length || 1);
    tr.append(el('td', { className: kind ? '' : 'unsure',
      textContent: !kind ? t('in.kindUnknown')
                 : kind === 'unique' ? t('reg.kindUnique') : t('reg.kindLow') }));
    tr.append(el('td', { className: 'num', textContent: rows == null ? '—' : String(rows) }));

    // Teach the catalogue: one click writes this name -> category back to
    // am_product, so the next delivery from this supplier fills itself in.
    const mem = el('button', { className: 'btn ico', textContent: '✚',
                               title: t('in.remember') });
    mem.disabled = !ln.name_vi?.trim() || !ln.category_code;
    mem.onclick = () => inRemember(ln, mem);
    tr.append(el('td', {}, mem));
    body.append(tr);
  });

  if (!IN.lines.length)
    body.append(el('tr', {}, el('td', { colSpan: 15, style: 'color:var(--dim);padding:14px',
      textContent: t('in.noLines') })));
}

/* Write this line's name -> standard name + category back into am_product.
   The name remembered is the RAW one off the delivery note, not the tidied one,
   because the raw one is what the next note will say. */
async function inRemember(ln, btn) {
  const raw = (ln._rawName || ln.name_vi || '').trim();
  if (!raw || !ln.category_code) return;
  btn.disabled = true;
  try {
    await SB.rpc('am_remember_product', {
      p_raw_name: raw,
      p_std_vi: ln.name_vi || raw,
      p_std_en: ln.name_en || null,
      p_category: ln.category_code,
      p_unit: ln.unit_code || null
    });
    btn.textContent = '✔';
    btn.title = t('in.remembered', { name: raw });
    ln._sug = { src: 'product', n: 1, conf: 'high' };
    msg('#inMsg', 'ok', t('in.remembered', { name: raw }));
  } catch (e) {
    btn.disabled = false;
    msg('#inMsg', 'err', e.message);
  }
}

/* One definition of "which kind is this line", used by the grid, the checker
   and the expander alike — they disagreed before, which is how every line of a
   price-less delivery came out labelled "Low-value asset".
   null means the price is not known yet, so the kind is not either. */
/* The product catalogue as a type-ahead list. A <datalist> is the right control
   here: it filters as you type but still accepts a name that is not in the
   catalogue yet — which is most of a first delivery from a new supplier. The
   label is "vi / en" because that is how the register and Beetrack write it. */
const inLabel = p => [p.std_name_vi, p.std_name_en].filter(Boolean).join(' / ');

function inProducts(rows) {
  IN.prod = new Map();
  const dl = $('#prodList');
  dl.innerHTML = '';
  for (const p of rows || []) {
    const label = inLabel(p);
    if (!label || IN.prod.has(label)) continue;
    IN.prod.set(label, p);
    dl.append(el('option', { value: label }));
  }
}

/* Split what the user typed back into the two name columns. An exact catalogue
   hit also brings its category and unit; anything else is kept verbatim. */
function inSetName(ln, text) {
  const v = (text || '').trim();
  const hit = IN.prod?.get(v);
  if (hit) {
    ln.name_vi = hit.std_name_vi || '';
    ln.name_en = hit.std_name_en || '';
    if (hit.default_category) ln.category_code = hit.default_category;
    if (hit.default_unit) ln.unit_code = hit.default_unit;
    ln._sug = { src: 'product', n: 0, conf: 'high' };
    return;
  }
  const i = v.indexOf(' / ');
  ln.name_vi = i > 0 ? v.slice(0, i).trim() : v;
  ln.name_en = i > 0 ? v.slice(i + 3).trim() : '';
}

/* The spec editor for one line. A panel under the grid rather than a dialog:
   the reviewer usually wants the delivery note's description visible while
   filling these in, and the description is one column away. */
function inSpecOpen(i) {
  const ln = IN.lines[i];
  const box = $('#inSpec');
  box.innerHTML = '';
  if (!ln) { box.hidden = true; return; }
  box.hidden = false;

  const head = el('div', { className: 'chead' });
  head.append(el('h2', { textContent: t('in.specFor', { i: i + 1, name: ln.name_vi || '—' }) }));
  const close = el('button', { className: 'btn', textContent: t('in.specClose') });
  close.onclick = () => { box.hidden = true; inRender(); };
  head.append(el('div', { className: 'row' }, close));
  box.append(head);

  const grid = el('div', { className: 'specgrid' });
  for (const f of SPEC_FIELDS) {
    const inp = el('input', { value: ln.spec?.[f] ?? '', spellcheck: false });
    inp.onchange = () => {
      ln.spec = ln.spec || {};
      ln.spec[f] = inp.value;
      IN.checked = null;
    };
    grid.append(el('div', { className: 'fld' },
      [el('label', { textContent: t('spec.' + f) }), inp]));
  }
  box.append(grid);
  box.append(el('div', { className: 'hint', textContent: t('in.specNote') }));
  box.scrollIntoView({ block: 'nearest' });
}

function kindOf(ln) {
  const v = ln.unit_price;
  if (v === '' || v == null) return null;
  const p = Number(v);
  if (!Number.isFinite(p) || p <= 0) return null;
  return p >= (IN.thUnique || 5000000) ? 'unique' : 'low';
}

const inSerials = ln => String(ln.serials || '')
  .split(/[\n,;]/).map(s => s.trim()).filter(Boolean);

/* Expand one entered line into the asset rows it will become. */
function inExpand(ln) {
  const price = Number(ln.unit_price) || 0;
  // inCheck refuses to commit a line with no price, so kindOf() cannot be null
  // by the time this runs; 'low' is only a shape for the preview.
  const kind = kindOf(ln) || 'low';
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
    // Each spec lands in its own column, which is what the label receipt and
    // the Beetrack sheet read. A blank one stays null rather than ''.
    ...Object.fromEntries(SPEC_FIELDS.map(f =>
      ['spec_' + f, (ln.spec?.[f] || '').trim() || null])),
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

    /* A serial is what ties a register row to a physical object. On a unique
       asset each unit becomes its own row, so a missing serial leaves a row
       that can never be matched back to the thing on the shelf. Warn on the
       absence, not only on a miscount. */
    const ser = inSerials(ln);
    const wantSer = Number(ln.qty) || 0;
    if (ser.length && ser.length !== wantSer)
      warns.push(t('in.warnSerial', { i: n, have: ser.length, qty: ln.qty }));
    else if (!ser.length && kindOf(ln) === 'unique') {
      warns.push(t('in.warnNoSerial', { i: n, qty: ln.qty }));
      ln._review.push({ field: 'serial', reason: 'missing_on_unique' });
    }

    // Doubt raised while reading the delivery note must survive into the
    // register, not stop at this screen.
    for (const f of ln._unsure || []) {
      warns.push(t('in.warnUnsure', { i: n, field: f }));
      ln._review.push({ field: f, reason: 'unreadable_on_note' });
    }
    if (ln._src && ln._src !== 'printed') {
      warns.push(t('in.warnQtySrc', { i: n, src: ln._src }));
      ln._review.push({ field: 'qty', reason: 'qty_' + ln._src });
    }
    if (ln._unitRaw && !ln.unit_code)
      warns.push(t('in.warnUnit', { i: n, raw: ln._unitRaw }));
    // A price taken from the contract is not a price off the delivery note.
    if (ln._priceFrom === 'contract') {
      warns.push(t('in.warnPriceContract', { i: n }));
      ln._review.push({ field: 'unit_price', reason: 'from_contract' });
    }

    warns.push(t('in.warnStatus', { i: n }));
    ln._review.push({ field: 'status_code', reason: 'no_source' });

    rows += inExpand(ln).length;
  }

  /* What the codes WILL be. Read from the counters without touching them —
     a number is only spent when a row is actually written, so nothing here
     leaves a gap if the user walks away. This is also the answer to "where is
     the asset code?": it does not exist until Confirm, on purpose. */
  let preview = [];
  if (!errs.length && SB.ready()) {
    try {
      const audit = await SB.rpc('am_audit_counters');
      const next = new Map((audit || []).map(a => [a.scope, Number(a.counter_next)]));
      const byKey = new Map();
      for (const r of IN.lines.flatMap(inExpand)) {
        const k = `${r.dept_code}|${r.letters}`;
        byKey.set(k, (byKey.get(k) || 0) + 1);
      }
      for (const [k, n] of byKey) {
        const [dept, letters] = k.split('|');
        const from = next.get(k) || 1;
        const year = Number(($('#inDate').value || '').slice(0, 4)) || new Date().getFullYear();
        const grp = (window.__CATS || []).find(c => c.label_letters === letters)?.group_code || '…';
        const code = s => `${dept}.${grp}.${letters}.${year}.${String(s).padStart(5, '0')}`;
        preview.push(n === 1 ? code(from)
                             : `${code(from)} → …${String(from + n - 1).padStart(5, '0')}`);
      }
    } catch { /* the preview is a courtesy; never block Check on it */ }
  }

  IN.checked = errs.length ? null : { rows };
  out.innerHTML = '';
  if (errs.length) {
    out.append(el('div', { className: 'msg err', textContent: t('in.hasErr', { n: errs.length }) }));
    for (const e of errs) out.append(el('div', { className: 'msg err', textContent: e }));
  } else {
    out.append(el('div', { className: 'msg ok',
      textContent: t('in.okAll', { n: IN.lines.length, r: rows }) }));
    if (preview.length) {
      const box = el('div', { className: 'msg' });
      box.append(el('b', { textContent: t('in.willAllocate') }));
      for (const p of preview)
        box.append(el('div', { className: 'prev', textContent: p }));
      box.append(el('div', { className: 'hint', style: 'margin-top:5px',
                             textContent: t('in.allocNote') }));
      out.append(box);
    }
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
    const [orgs, units, th, prods] = await Promise.all([
      SB.select('am_org', 'select=code,is_company,is_department&order=code'),
      SB.select('am_unit', 'select=code&order=sort_order'),
      SB.select('am_setting', 'select=key,value&key=eq.unique_threshold'),
      SB.select('am_product',
        'select=std_name_vi,std_name_en,default_category,default_unit&order=std_name_vi')
    ]);
    IN.units = units.map(u => u.code);
    IN.thUnique = Number(th?.[0]?.value) || 5000000;
    inProducts(prods);
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

/* ======================================================== DELIVERY NOTE
   A delivery note carries the goods, the quantities and the prices. It does
   NOT carry the asset category, the department, the location or the purpose,
   so those can never be "extracted" -- they have to come from somewhere else.

   They come from history: the register already holds ~16,000 rows, and in it
   a "Ghe" has always been LTU/C2422. am_suggest_lines() looks the name up and
   returns the category together with the number of rows backing it, so the
   reviewer sees the evidence instead of a bare guess.

   Extraction itself is deliberately kept to what is printed on the paper.
   The app -- not the model -- applies the 5,000,000 threshold, picks the
   accounting group, allocates the sequence and builds the barcode, because
   those must be reproducible and auditable. */

/* The instructions handed to Claude along with the PDF. Kept verbatim in one
   place so the Edge Function (step 2) and the paste-in path cannot drift. */
const DN_PROMPT = `You are reading one or more delivery notes ("phiếu giao hàng") for a hotel's asset intake. Extract ONLY what is on the page and return JSON.

OUTPUT: a single JSON object, no prose, no markdown fence:

{"price_list":[ … see rule 10 … ],
 "deliveries":[{
  "delivery_no": string|null,
  "delivery_date": "YYYY-MM-DD"|null,
  "supplier": string|null,
  "invoice_no": string|null,
  "note": string|null,
  "lines": [{
    "name_vi": string,
    "name_en": string|null,
    "description": string|null,
    "qty": number|null,
    "qty_source": "printed"|"handwritten"|"inferred",
    "unit_raw": string|null,
    "unit_price": number|null,
    "currency": string|null,
    "serials": [string],
    "brand": string|null,
    "model": string|null,
    "spec": { … see rule 11 … },
    "origin_raw": string|null,
    "uncertain": [string],
    "note": string|null
  }]
}]}

RULES

1. One file may hold SEVERAL delivery notes. Return one object per note. Do not merge them.

2. The PRINTED "Số lượng giao" is the authoritative quantity. If a handwritten
   figure differs from it, use the PRINTED one, set "qty_source":"printed", add
   "qty" to "uncertain", and record the handwritten value in the line "note".
   Only use a handwritten number when nothing is printed; then set
   "qty_source":"handwritten" and add "qty" to "uncertain".

3. Never invent a value. If a field is not on the paper, return null and add its
   name to "uncertain". An empty "uncertain" means every field was read off the page.

4. "origin_raw": copy the origin EXACTLY as written. If it names several
   countries ("USA/Mexico/China") or is not a country ("Asia", "EU"), copy that
   text unchanged. Do NOT pick one country and do NOT translate it.

5. Numbers: return plain numbers with no separators. Vietnamese notes use "." for
   thousands and "," for decimals, so "1.250.000" is 1250000 and "1,5" is 1.5.

6. Dates: ISO "YYYY-MM-DD". Vietnamese notes write dd/mm/yyyy.

7. SERIAL NUMBERS. One array entry per unit, in the order printed. A serial is
   what ties a row to a physical object for the rest of that object's life, so:

   - NEVER drop a serial list because it is long. A list of 298 is still the
     list. Return all of them.
   - If ONE serial in a list cannot be read, put null in its position and add
     "serials" to "uncertain". Do not shorten the list — position carries
     meaning, and a missing entry silently shifts every serial after it onto
     the wrong unit.
   - Always return as many entries as the printed list holds, even when that
     differs from the quantity. The application compares the two and asks; you
     must not reconcile them by inventing or discarding entries.
   - Serials are often on their own sheet ("THE INFORMATION OF GOODS" or
     similar) rather than in the delivery table, and one block there may cover
     several delivery lines of the same part number. Split them in the printed
     order, and say in the line "note" that the split was inferred.
   - If none are printed, return [].

8. Do NOT output an asset category, asset code, barcode, department, location,
   condition code or depreciation. None of those are on a delivery note; the
   application derives them. Adding them would be a guess.

9. If a page is a scan and a character is unreadable, prefer null plus an
   "uncertain" entry over a plausible-looking reading.

10. PRICE SCHEDULE. A delivery note often carries no prices at all — the
    contract or its appendix does. If the file ALSO contains a price schedule
    ("bảng giá", "phụ lục hợp đồng", a contract line-item table with unit
    prices), return it SEPARATELY, beside "deliveries" and at the same level:

      "price_list": [{ "model": string|null,
                       "name": string|null,
                       "unit_price": number,
                       "currency": string|null }]

    Do NOT copy those prices onto the delivery lines. The application joins the
    two tables itself and shows the reviewer that the price came from the
    contract rather than off the delivery note — a distinction that is lost the
    moment the two are merged.

    "model" is the manufacturer part number, written exactly as it appears, and
    exactly as you wrote it in the delivery line's "model". That string is what
    the two tables are joined on.

    If the file has no price schedule, return "price_list": [].

11. SPECIFICATIONS, one field at a time. The register keeps each of these in its
    own column, and the label receipt and the Beetrack upload read them
    individually — a specification left as one paragraph reaches neither.

      "spec": { "function": …, "capacity": …, "length": …, "width": …,
                "height":  …, "weight":  …, "material": …, "color": …,
                "shape":   …, "radius":  …, "fuel": …, "area": …,
                "perimeter": …, "mfg_year": …, "accessory": … }

    All strings or null. Keep the unit with the number: "2100mm", "558L",
    "80kg" — the column is text, and a bare 2100 means nothing later.
    Brand and model stay in their own top-level keys; do not repeat them here.

    Only what is printed. A delivery note usually gives few of these, and an
    empty spec is the correct answer — do not infer dimensions from a model
    number or a product photograph.`;

const DN = { parsed: [], prices: new Map() };

/* Part numbers are written inconsistently between a contract appendix and a
   delivery note — spaces, hyphens and case all drift. Compare them stripped. */
const dnModelKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function dnCopyPrompt() {
  try {
    await navigator.clipboard.writeText(DN_PROMPT);
    msg('#dnMsg', 'ok', t('dn.copied'));
  } catch {
    // Clipboard needs a secure context; show the text so it can be copied by hand.
    $('#dnJson').value = DN_PROMPT;
    msg('#dnMsg', 'warn', t('dn.copyFail'));
  }
}

const dnNum = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function dnParse() {
  const out = $('#dnMsg');
  let raw = $('#dnJson').value.trim();
  if (!raw) return msg(out, 'err', t('dn.noJson'));
  // Tolerate a ```json fence, since that is what a chat window tends to hand back.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { return msg(out, 'err', t('dn.badJson', { err: e.message })); }

  // Accept the full envelope, a bare array, or a single delivery.
  const list = Array.isArray(data) ? data
             : Array.isArray(data.deliveries) ? data.deliveries
             : data.lines ? [data] : null;
  if (!list || !list.length) return msg(out, 'err', t('dn.noDeliveries'));
  for (const d of list)
    if (!Array.isArray(d.lines)) return msg(out, 'err', t('dn.noLines'));

  DN.parsed = list;
  // The price schedule sits beside the deliveries, keyed by part number.
  DN.prices = new Map();
  for (const p of (data.price_list || [])) {
    const k = dnModelKey(p.model);
    const v = dnNum(p.unit_price);
    if (k && v != null) DN.prices.set(k, { price: v, currency: p.currency || null });
  }
  dnRender();
  msg(out, 'ok', t('dn.parsed', {
    n: list.length,
    r: list.reduce((s, d) => s + d.lines.length, 0),
    p: DN.prices.size
  }));
}

function dnRender() {
  const box = $('#dnList');
  box.innerHTML = '';
  if (!DN.parsed.length) return;
  for (let i = 0; i < DN.parsed.length; i++) {
    const d = DN.parsed[i];
    const unsure = d.lines.filter(l => (l.uncertain || []).length).length;
    const row = el('div', { className: 'row', style: 'align-items:center;gap:10px' });
    row.append(el('div', { className: 'grow', textContent:
      `${d.delivery_no || t('dn.noNumber')} · ${d.delivery_date || '—'} · ` +
      `${d.supplier || '—'} · ` + t('dn.nLines', { n: d.lines.length }) +
      (unsure ? ' · ' + t('dn.nUnsure', { n: unsure }) : '') }));
    const b = el('button', { className: 'btn pri', textContent: t('dn.load') });
    b.onclick = () => dnApply(i);
    row.append(b);
    box.append(row);
  }
}

async function dnApply(i) {
  const d = DN.parsed[i];
  const out = $('#dnMsg');
  if (IN.lines.length && !confirm(t('dn.replace', { n: IN.lines.length }))) return;

  if (d.delivery_date) $('#inDate').value = d.delivery_date;
  if (d.supplier) $('#inSupplier').value = d.supplier;
  if (d.invoice_no) $('#inInvoice').value = d.invoice_no;

  let priced = 0;
  IN.lines = d.lines.map(l => {
    const ln = inBlank();
    ln.name_vi = (l.name_vi || '').trim();
    ln.name_en = (l.name_en || '').trim();
    /* Brand and model go to their own columns now, not into the description
       blob — that blob was why every intake row printed an empty spec cell. */
    ln.spec = { brand: l.brand || '', model: l.model || '' };
    for (const f of SPEC_FIELDS)
      if (l.spec && l.spec[f] != null && l.spec[f] !== '') ln.spec[f] = String(l.spec[f]);
    ln.description = [l.description, l.note].filter(Boolean).join(' · ') || '';
    ln.qty = dnNum(l.qty) ?? 1;
    ln.unit_price = dnNum(l.unit_price) ?? '';
    /* No price on the note? Take it from the contract schedule, matched on the
       part number — and record that it came from there, because a price off a
       contract is a different fact from a price off the delivery note. */
    if (ln.unit_price === '' && l.model) {
      const hit = DN.prices.get(dnModelKey(l.model));
      if (hit) {
        ln.unit_price = hit.price;
        ln._priceFrom = 'contract';
        priced++;
      }
    }
    ln.origin_raw = (l.origin_raw || '').trim();
    ln.serials = (l.serials || []).join('\n');
    // Carried into needs_review at Confirm, so the doubt survives into the register.
    ln._src = l.qty_source || null;
    ln._unsure = l.uncertain || [];
    ln._unitRaw = l.unit_raw || null;
    return ln;
  });
  IN.checked = null; IN.sugRan = false;
  inRender();
  msg(out, 'ok', t(priced ? 'dn.appliedPriced' : 'dn.applied',
                   { n: IN.lines.length, p: priced }));
  await inSuggest();
}

/* Fill category / unit / depreciation from what the register already knows. */
async function inSuggest() {
  const names = IN.lines.map(l => l.name_vi).filter(Boolean);
  if (!names.length) return;
  let sug;
  try { sug = await SB.rpc('am_suggest_lines', { p_names: names }); }
  catch (e) {
    IN.sugRan = false; inRender();
    return msg('#dnMsg', 'warn', t('dn.sugFail', { err: e.message }));
  }
  IN.sugRan = true;

  const by = new Map((sug || []).map(s => [s.name, s]));
  let filled = 0, none = 0, weak = 0;
  for (const ln of IN.lines) {
    const s = by.get(ln.name_vi);
    if (!s || !s.category_code) { ln._sug = null; none++; continue; }
    if (!ln.category_code) { ln.category_code = s.category_code; filled++; }
    if (!ln.unit_code && s.unit_code) ln.unit_code = s.unit_code;
    /* The standard name replaces the supplier's spec line — but the original is
       kept in the description, because that is what the delivery note says and
       the register should still be able to show it. */
    if (s.std_name_vi && s.std_name_vi !== ln.name_vi) {
      ln._rawName = ln._rawName || ln.name_vi;
      ln.description = [ln._rawName, ln.description].filter(Boolean).join(' · ');
      ln.name_vi = s.std_name_vi;
      ln.name_en = s.std_name_en || ln.name_en;
    }
    ln._sug = { n: s.n, src: s.src, term: s.matched_term, conf: s.confidence };
    if (s.confidence === 'low' || s.confidence === 'medium') weak++;
  }
  IN.sugRan = true;
  inRender();
  msg('#dnMsg', none || weak ? 'warn' : 'ok',
      t('dn.suggested', { n: filled, none, weak }));
}

function initDelivery() {
  $('#btnDnPrompt').onclick = dnCopyPrompt;
  $('#btnDnParse').onclick = dnParse;
  $('#btnDnClear').onclick = () => {
    $('#dnJson').value = ''; DN.parsed = []; dnRender(); msg('#dnMsg', '', '');
  };
  $('#btnInSuggest').onclick = inSuggest;
}

function initIntake() {
  $('#inDate').value = new Date().toISOString().slice(0, 10);
  $('#btnInAdd').onclick = () => { IN.lines.push(inBlank()); IN.checked = null; inRender(); };
  $('#btnInClear').onclick = () => { IN.lines = []; IN.checked = null; IN.sugRan = false; inRender(); };
  $('#btnInCheck').onclick = inCheck;
  $('#btnInConfirm').onclick = inConfirm;
  $('#btnInXlsx').onclick = inXlsx;
  $('#btnInAlr').onclick = inToAlr;
  initDelivery();
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
/* The register writes a bare building letter when the room was never recorded.
   Evidence: of the 438 distinct location codes in the 17,036-row export, exactly
   two are absent from am_location — "S" (3,680 rows) and "C" (1,476) — and both
   buildings exist under their proper codes. */
// A Map, not an object: a plain object would also answer to "constructor" and
// "toString", and a stray cell holding one of those would map to a function.
const LEG_BUILDING = new Map([['S', 'SOF'], ['C', 'CP']]);
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

    /* 5,156 rows record the location as the bare building letter — S for
       Sofitel, C for Central Plaza — meaning "somewhere in this building, room
       not recorded". Those are the ONLY two codes in the whole register that
       am_location does not hold, and both buildings exist in it under their
       real codes. Mapping them keeps the building; dropping them lost it. */
    /* A value that does not match master data may NOT simply vanish. The column
       itself is a foreign key, so an unknown code cannot be stored there — but
       the raw text goes into needs_review, which travels with the row into the
       register. Nothing is lost; it is parked, flagged, and fixable later. */
    const keep = [];
    const check = (raw, set, field, warnKey) => {
      const v = legTxt(raw);
      if (!v) return null;
      if (set.has(v)) return v;
      warns.push(t(warnKey, { v }));
      keep.push({ field, reason: 'not_in_master', raw: v });
      return null;
    };

    /* 5,156 rows record the location as the bare building letter — S for
       Sofitel, C for Central Plaza — meaning "somewhere in this building, room
       not recorded". Those are the ONLY two codes in the whole register that
       am_location does not hold, and both buildings exist in it under their
       real codes. Mapping them keeps the building; dropping them lost it. */
    let rawLoc = legTxt(r[G.location]);
    if (LEG_BUILDING.has(rawLoc)) rawLoc = LEG_BUILDING.get(rawLoc);
    const loc = check(rawLoc, master.loc, 'location_code', 'leg.wNoLoc');
    const unit = check(r[G.unit], master.unit, 'unit_code', 'leg.wNoUnit');
    const iso = check(legTxt(r[G.origin]).toUpperCase(), master.origin,
                      'origin_iso2', 'leg.wNoOrigin');

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
      // Both halves: the human-readable warnings AND the raw values that could
      // not be stored in their own column, each with the field it belongs to.
      needs_review: [...keep, ...warns.map(w => ({ field: 'import', reason: w }))]
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

/* Every barcode already in the register. One column, paged — the whole set is
   needed to tell an addition from an update BEFORE writing, which is what makes
   "add only" and "update only" possible and the counts honest. */
async function legExisting(onProgress) {
  const have = new Set();
  for (let off = 0; ; off += 1000) {
    const page = await SB.select('am_asset',
      `select=barcode&order=barcode&limit=1000&offset=${off}`);
    for (const r of page) have.add(r.barcode);
    onProgress?.(have.size);
    if (page.length < 1000) break;
  }
  return have;
}

async function legImport() {
  if (!LEG.rows.length) return;
  const out = $('#legMsg');
  const host = CFG.url ? new URL(CFG.url).hostname : '?';
  const mode = $('#legMode').value;        // both | add | update

  /* The barcode is the identity — that part is settled. This only decides what
     to DO with a match: refresh it, leave it alone, or refuse rows that have no
     match. Re-running to correct a field wants "update only", so a stray new
     row cannot slip in unnoticed. */
  msg(out, 'info', t('leg.reading'));
  let existing;
  try { existing = await legExisting(); }
  catch (e) { return msg(out, 'err', e.message); }

  const isNew = r => !existing.has(r.barcode);
  const rows = mode === 'add' ? LEG.rows.filter(isNew)
             : mode === 'update' ? LEG.rows.filter(r => !isNew(r))
             : LEG.rows;
  const nAdd = rows.filter(isNew).length;
  const nUpd = rows.length - nAdd;
  const held = LEG.rows.length - rows.length;
  if (!rows.length)
    return msg(out, 'warn', t('leg.modeNothing', { mode: t('leg.mode.' + mode) }));

  if (!confirm(t('leg.confirm', { n: fmtInt(rows.length), host,
                                  bad: fmtInt(LEG.bad.length),
                                  warn: fmtInt(LEG.warn.length),
                                  add: fmtInt(nAdd), upd: fmtInt(nUpd),
                                  held: fmtInt(held) }))) return;
  let done = 0;
  try {
    for (let i = 0; i < rows.length; i += LEG_CHUNK) {
      msg(out, 'info', t('leg.importing', { done: fmtInt(done),
                                            total: fmtInt(rows.length) }));
      // on_conflict makes the import repeatable. Without it PostgREST resolves
      // conflicts on the primary key, and since id is a bigserial we never
      // send, a second run would insert duplicates and die on the unique index
      // -- halfway through 17,000 rows.
      await SB.call('am_asset?on_conflict=barcode', {
        method: 'POST',
        headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows.slice(i, i + LEG_CHUNK))
      });
      done += Math.min(LEG_CHUNK, rows.length - i);
    }
  } catch (e) {
    return msg(out, 'err', t('leg.fail', { done: fmtInt(done), err: e.message }));
  }
  // Say what actually happened, not just a total: added vs refreshed.
  msg(out, 'ok', t('leg.done', { n: fmtInt(done), add: fmtInt(nAdd), upd: fmtInt(nUpd),
                                 held: fmtInt(held), skip: fmtInt(LEG.bad.length) }));
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
