/* asset-intake — internal tool (phase 1: master data + counters)
   PUBLIC repo: no URL/key is embedded. Settings come from localStorage or from
   a #sbcfg=<base64> fragment, which is stripped from the address bar at once.
   All user-facing text goes through t() in i18n.js — English is official. */
'use strict';

/* Shown in the sidebar. If this does not match the ?v= on the script tag in
   AssetManagement.html, the browser is running a cached older app.js — which
   looks identical to "the change did not work". Check here first. */
const APP_VERSION = '20260926m';

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
/* A database column shown as a heading: its label in the reading language
   (col.* / spec.* in i18n.js), so the asset screens read like the project
   screens. The raw name stays as the tooltip and in Excel exports, because
   the importers match on it. */
function colLabel(c) {
  for (const k of ['col.' + c, c.startsWith('spec_') ? 'spec.' + c.slice(5) : null]) {
    if (k && t(k) !== k) return t(k);
  }
  const s = String(c).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------------------------------------------------------------- config */
const LS_KEY = 'asset-intake.sb';
let CFG = { url: '', key: '' };
/* Tablet / phone mode (tbDetect): declared up here because showView and firstView read it from the start. */
const TB_VIEWS = ['pmdash', 'inbox', 'doc', 'lqcount', 'stockcount', 'flows', 'settings', 'setup'];
const TB = { on: false, pages: [], i: 0, key: null, busy: false };

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
  // key: the status text to put back after a language switch ("signed out"
  // must not turn into "not configured" just because the language changed).
  CONN = { ok, host: ok ? hostOrKey : '', key: ok ? 'conn.ok' : hostOrKey };
  $('#dot').classList.toggle('on', !!ok);
  $('#connTxt').textContent = t(ok ? 'conn.ok' : hostOrKey);
  // The same state as a "Live" pill in the top bar, like the other PHCL apps.
  $('#liveTop').classList.toggle('ok', !!ok);
  $('#liveTxt').textContent = t(ok ? 'conn.live' : 'conn.offline');
  $('#liveTop').title = t(ok ? 'conn.ok' : hostOrKey);
}

/* ------------------------------------------------------------------- SB */
const SB = {
  ready: () => !!(CFG.url && CFG.key),
  /* The anon key still goes in `apikey` — the Supabase gateway wants it on
     every request — but it no longer authorises anything by itself. The
     Authorization header is the signed-in user's token, set in call(). */
  hdr(extra = {}) {
    return Object.assign({ apikey: CFG.key, 'Content-Type': 'application/json' }, extra);
  },
  async call(path, opts = {}, retried = false) {
    if (!SB.ready()) throw new Error(t('err.noConfig'));
    const tok = await authToken();
    if (!tok) { authExpired(); throw new Error(t('auth.needSignIn')); }
    const headers = Object.assign({}, opts.headers || SB.hdr(),
                                  { Authorization: 'Bearer ' + tok });
    const res = await fetch(CFG.url + '/rest/v1/' + path, Object.assign({}, opts, { headers }));
    const raw = await res.text();
    /* A token can be rejected before the clock says it expired (the server's
       clock and this PC's disagree). Refresh once and try again rather than
       throwing the user out mid-task. */
    if (res.status === 401 && !retried && /jwt|token/i.test(raw)) {
      if (await authRefresh(true)) return SB.call(path, opts, true);
      authExpired();
    }
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

/* ------------------------------------------------------------------ auth
   Supabase Auth over plain REST — no supabase-js, because there is no build
   step and one more CDN script is one more thing that can fail to load.

   The session lives in localStorage, so it survives a reload and every tab
   shares it. That sharing matters: Supabase ROTATES refresh tokens, each good
   for exactly one refresh. Two tabs refreshing with the same token would log
   the slower one out — so a refresh first re-reads storage in case another
   tab already did it, and only one refresh per tab is ever in flight. */
const SESS_KEY = 'asset-intake.session';
let SESS = null;   // { access_token, refresh_token, expires_at (ms), email }
let ME = null;     // app_me(): profile, roles with their scopes, merged rights

function authLoad() {
  try { SESS = JSON.parse(localStorage.getItem(SESS_KEY) || 'null'); } catch { SESS = null; }
}
function authStore(s) {
  SESS = s;
  try { s ? localStorage.setItem(SESS_KEY, JSON.stringify(s)) : localStorage.removeItem(SESS_KEY); }
  catch {}
}

async function authReq(method, path, body, token) {
  const res = await fetch(CFG.url + '/auth/v1/' + path, {
    method,
    headers: Object.assign({ apikey: CFG.key, 'Content-Type': 'application/json' },
                           token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await res.text();
  let j = null;
  try { j = raw ? JSON.parse(raw) : null; } catch { j = raw; }
  if (!res.ok) {
    const m = (j && typeof j === 'object'
               && (j.error_description || j.msg || j.message || j.error)) || res.statusText;
    const e = new Error(String(m));
    e.status = res.status;
    e.code = j && typeof j === 'object' ? (j.error_code || j.error || '') : '';
    throw e;
  }
  return j;
}

const sessFrom = j => ({
  access_token: j.access_token,
  refresh_token: j.refresh_token,
  expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  email: (j.user && j.user.email) || (SESS && SESS.email) || ''
});

async function authSignIn(email, password) {
  authStore(sessFrom(await authReq('POST', 'token?grant_type=password', { email, password })));
}

let REFRESHING = null;
function authRefresh(force) {
  if (REFRESHING) return REFRESHING;
  REFRESHING = (async () => {
    authLoad();
    if (!SESS || !SESS.refresh_token) return null;
    if (!force && SESS.expires_at - Date.now() > 60000) return SESS.access_token;
    try {
      authStore(sessFrom(await authReq('POST', 'token?grant_type=refresh_token',
                                       { refresh_token: SESS.refresh_token })));
      return SESS.access_token;
    } catch {
      // Lost the race to another tab, which stored a fresh session a moment ago?
      authLoad();
      if (SESS && SESS.expires_at - Date.now() > 60000) return SESS.access_token;
      authStore(null);
      return null;
    }
  })().finally(() => { REFRESHING = null; });
  return REFRESHING;
}

/* A token that is good for at least another minute, or null. */
async function authToken() {
  if (!SESS) authLoad();
  if (!SESS) return null;
  if (SESS.expires_at - Date.now() > 60000) return SESS.access_token;
  return authRefresh(false);
}

/* Signing out reloads the page: whatever the last person had on screen — a
   register page, an intake draft — must not still be there for the next one. */
async function authSignOut() {
  const tok = SESS && SESS.access_token;
  authStore(null);
  ME = null;
  if (tok) { try { await authReq('POST', 'logout', {}, tok); } catch {} }
  location.replace(location.pathname + location.search);
}

/* The session ran out mid-work. Put the sign-in box over the screen but leave
   the screen itself alone, so signing back in as the same person carries on
   where they were — an intake half typed in is not thrown away. */
function authExpired() {
  if (!$('#login').hidden) return;
  authStore(null);
  loginShow('in', t('auth.expired'), 'warn');
}

/* Coming back from the password-reset e-mail: Supabase puts the session in the
   address bar fragment. Read it, then wipe it from the bar at once. */
function authFromHash() {
  const h = location.hash.replace(/^#/, '');
  if (!/(^|&)(access_token|error)=/.test(h)) return null;
  const p = new URLSearchParams(h);
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('error')) return { error: p.get('error_description') || p.get('error') };
  authStore({
    access_token: p.get('access_token'),
    refresh_token: p.get('refresh_token'),
    expires_at: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
    email: ''
  });
  return { type: p.get('type') || '' };
}

const authErrText = e => {
  const m = String((e && e.message) || e);
  if (/invalid login credentials|invalid_grant/i.test(m + (e && e.code))) return t('auth.badCreds');
  if (/email not confirmed/i.test(m)) return t('auth.notConfirmed');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return t('auth.network');
  if (e && e.status === 429) return t('auth.tooMany');
  return m;
};

/* The signed-in user's rights, merged across every role they hold. The UI
   only uses these to hide what cannot be done; the database checks again. */
const can = (module, action = 'view') => !!(ME && ME.perms && ME.perms[module]
                                            && ME.perms[module][action]);

async function loadMe() {
  ME = await SB.rpc('app_me');
  renderMe();
  buildNav();
  applyPerms();
  return ME;
}

function renderMe() {
  const on = !!ME;
  $('#meName').textContent = on ? (ME.full_name || ME.email) : '';
  $('#meMail').textContent = on ? ME.email : '';
  $('#meActs').hidden = !on;
  const box = $('#meRoles');
  box.innerHTML = '';
  for (const r of (on && ME.roles) || [])
    box.append(el('span', { className: 'rchip',
      textContent: `${LANG === 'vi' ? r.name_vi : r.name_en} · ${r.scope}` }));
}

/* Buttons that write carry data-perm="module:action". Without the right they
   stay on screen but greyed, and the capture listener in init() swallows the
   click before the button's own handler ever sees it. */
function applyPerms() {
  for (const n of $$('[data-perm]')) {
    const [m, a] = n.dataset.perm.split(':');
    const ok = can(m, a);
    n.classList.toggle('noperm', !ok);
    if (!ok) {
      if (n.dataset.t0 === undefined) n.dataset.t0 = n.title || '';
      n.title = t('auth.noPerm');
    } else if (n.dataset.t0 !== undefined) {
      n.title = n.dataset.t0;
      delete n.dataset.t0;
    }
  }
}

function loginShow(mode, text, kind) {
  $('#login').hidden = false;
  $('#loginIn').hidden = mode !== 'in';
  $('#loginNew').hidden = mode === 'in';
  $('#btnPwCancel').hidden = mode !== 'change';
  msg('#loginMsg', kind || (text ? 'err' : ''), text || '');
  markLang();
  if (mode === 'in' && !$('#liEmail').value && SESS && SESS.email) $('#liEmail').value = SESS.email;
  setTimeout(() => {
    const f = mode === 'in' ? ($('#liEmail').value ? $('#liPw') : $('#liEmail')) : $('#liNew1');
    f.focus();
  }, 0);
}
function loginHide() {
  $('#login').hidden = true;
  msg('#loginMsg', '', '');
}

/* After a session exists: who is this, and what may they see?
   resume: the same person signing back in after their session ran out — they
   stay on the screen they were using instead of being sent to the register. */
async function enterApp(resume = false) {
  try { await loadMe(); }
  catch (e) { return loginShow('in', authErrText(e)); }   // "Failed to fetch" → "cannot reach the server"
  if (!ME) return loginShow('in', t('auth.noProfile'));
  if (!ME.active) {
    authStore(null);
    ME = null;
    renderMe();
    return loginShow('in', t('auth.disabled'));
  }
  loginHide();
  helpLoad();                      // this person's own choice
  wfBadgeStart();
  if (resume) { await testConn(true); return; }
  const ok = await testConn(true);
  if (!ME.roles.length) {
    showView('setup');
    return msg('#setupMsg', 'warn', t('auth.noRoles', { email: ME.email }));
  }
  if (ok) { showView(firstView()); fillPickers(); }
}

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
    cols: [T('iso2', { type: 'ref', ref: 'am_origin', w: 90 }), T('alias_norm', { w: 220 }),
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
  },
  // Keyed by the accounting vendor code, so phase 5 can match the bank export.
  pm_vendor: {
    pk: 'code', order: 'name',
    cols: [T('code', { w: 120 }), T('name', { w: 320 }), T('tax_code', { w: 130 }), T('email', { w: 200 }),
           T('projects', { calc: r => VENDOR_PROJ.get(r.code) || '', w: 220 }),
           T('aliases', { w: 300 }), T('active', { type: 'bool' }), T('note', { w: 220 })]
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
  const v = col.calc ? col.calc(row.cur) : row.cur[col.name];
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

/* Sort and per-column filters of the master-data grid (user 25/09/2026), per
   table: click a heading to sort (again to reverse), type under it to filter.
   While either is in use the tree steps aside — a sorted or filtered list is
   flat. Yes / no columns filter with a ✓ / ✗ picker. */
const GRID_SORT = {}, GRID_CF = {};
const gridVal = (c, row) => c.calc ? c.calc(row.cur) : row.cur[c.name];
const gridTxt = (c, row) => { const v = gridVal(c, row); return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); };
function gridMatch(c, row, q) {
  if (!q) return true;
  if (c.type === 'bool') return q === 'y' ? !!row.cur[c.name] : !row.cur[c.name];
  if (c.type === 'int') {
    const v = Number(row.cur[c.name]);
    const m = /^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/.exec(q.trim());
    if (m) { const x = +m[2]; return m[1] === '>' ? v > x : m[1] === '<' ? v < x : m[1] === '>=' ? v >= x : m[1] === '<=' ? v <= x : v === x; }
  }
  return hnorm(gridTxt(c, row)).includes(hnorm(q));
}
// A column's share of the width: its declared width, yes / no columns narrow.
const gridW = c => c.type === 'bool' ? 76 : (c.w || 120);

function renderGrid() {
  if (!CUR) return;
  const spec = TABLES[CUR.table], tbl = CUR.table;
  const head = $('#grid thead');
  head.innerHTML = '';
  const cf = GRID_CF[tbl] = GRID_CF[tbl] || {};
  const hr = el('tr');
  if (EDIT) hr.append(el('th', { className: 'delcol', textContent: '' }));
  for (const c of spec.cols) {
    const s = GRID_SORT[tbl] && GRID_SORT[tbl].k === c.name ? GRID_SORT[tbl].dir : null;
    const th = el('th', { className: 'srt' + (c.type === 'bool' ? ' c' : c.type === 'int' ? ' num' : '') + (s ? ' on' : ''),
      title: t('pm.sortHint'), style: `width:${gridW(c)}px` },
      [document.createTextNode(colLabel(c.name)), el('span', { className: 'arr', textContent: s === 'asc' ? '▲' : s === 'desc' ? '▼' : '⇅' })]);
    th.onclick = () => { GRID_SORT[tbl] = s === 'desc' ? null : { k: c.name, dir: s === 'asc' ? 'desc' : 'asc' }; renderGrid(); };
    hr.append(th);
  }
  const fr = el('tr', { className: 'frow' });
  if (EDIT) fr.append(el('th', { className: 'delcol' }));
  spec.cols.forEach((c, i) => {
    let inp;
    if (c.type === 'bool') {
      inp = el('select', { className: 'cfin' + (cf[c.name] ? ' on' : '') });
      for (const [v, txt] of [['', '—'], ['y', '✓'], ['n', '✗']]) inp.append(el('option', { value: v, textContent: txt, selected: (cf[c.name] || '') === v }));
      inp.onchange = () => { cf[c.name] = inp.value; renderGrid(); };
    } else {
      inp = el('input', { className: 'cfin' + (cf[c.name] ? ' on' : ''), value: cf[c.name] || '', spellcheck: false,
        placeholder: c.type === 'int' ? '>0 · <10' : t('pm.cfPh') });
      inp.oninput = () => { cf[c.name] = inp.value; inp.classList.toggle('on', !!inp.value); renderGridBody(); };
    }
    // The first filter box carries the "clear all" button.
    fr.append(el('th', {}, i === 0 ? el('div', { className: 'cfone' }, [el('button', { className: 'btn tiny', textContent: '↺', title: t('pm.cfClear'),
      onclick: () => { GRID_CF[tbl] = {}; GRID_SORT[tbl] = null; renderGrid(); } }), inp]) : inp));
  });
  head.append(hr, fr);
  renderGridBody();
}

function renderGridBody() {
  if (!CUR) return;
  const spec = TABLES[CUR.table], tbl = CUR.table;
  const body = $('#grid tbody');
  body.innerHTML = '';
  const cf = GRID_CF[tbl] || {}, sort = GRID_SORT[tbl];
  const q = ($('#filter')?.value || '').trim().toLowerCase();
  const colsOn = Object.values(cf).some(Boolean);
  const parentField = TREE_ON && !sort && !colsOn ? TREE_PARENT[CUR.table] : null;
  const alive = CUR.rows.filter(r => !r.del);
  // A row being added always shows, whatever the filters.
  const visible = r => r.isNew || ((!q || JSON.stringify(r.cur).toLowerCase().includes(q)) && spec.cols.every(c => gridMatch(c, r, cf[c.name])));
  const shut = shutSet(CUR.table);

  let plan;
  if (parentField) plan = treeOrder(alive, spec, parentField, visible, shut, !q);
  else {
    let list = alive.filter(visible);
    const col = sort && spec.cols.find(c => c.name === sort.k);
    if (col) {
      const dir = sort.dir === 'desc' ? -1 : 1;
      list = list.slice().sort((a, b) => {
        const x = gridVal(col, a), y = gridVal(col, b);
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), pmLoc(), { numeric: true })) * dir;
      });
    }
    plan = list.map(r => ({ row: r, depth: 0, guides: [] }));
  }

  const fold = key => {
    if (shut.has(key)) shut.delete(key); else shut.add(key);
    shutSave(CUR.table, shut);
    renderGridBody();
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
        dirtyCheck(); renderGridBody();
      };
      tr.append(el('td', { className: 'delcol' }, del));
    }
    let first = true;
    for (const c of spec.cols) {
      // The tree lives in the editable grid rather than beside it, so every
      // row stays editable; only the first cell carries the outline.
      const td = el('td', first && parentField
        ? { className: 'tcell lvl' + Math.min(item.depth, 2) } : { className: c.type === 'bool' ? 'c' : c.type === 'int' ? 'num' : '' });
      if (first && parentField) {
        // The rules are absolutely positioned over the cell's full height, so
        // the cell reserves their width as padding instead of flowing them.
        td.style.paddingLeft = (item.depth * 15 + 4) + 'px';
        td.append(treeGuides(item), caret(item));
      }
      first = false;
      // A long text wraps inside its column's width instead of stretching it
      // (one 300-character product name made the catalogue several screens wide).
      if (!c.type || c.type === 'text' || c.type === 'ref') { td.classList.add('gwrap'); td.style.maxWidth = gridW(c) + 'px'; td.style.minWidth = Math.round(gridW(c) * 0.6) + 'px'; }
      if (!EDIT || c.calc) { td.append(cellRead(c, row)); tr.append(td); continue; }
      td.append(cellInput(c, row, (field, val) => {
        row.cur[field] = val;
        row.dirty = row.isNew || spec.cols.some(k => !k.calc && row.cur[k.name] !== row.orig?.[k.name]);
        tr.classList.toggle('dirty', !row.isNew && !!row.dirty);
        dirtyCheck();
      }));
      tr.append(td);
    }
    body.append(tr);
  }
  if (!shown) body.append(el('tr', {}, el('td', {
    colSpan: spec.cols.length + 1,
    textContent: q || colsOn ? t('table.noMatch') : t('table.empty'),
    style: 'color:var(--dim);padding:14px'
  })));
}

/* Vendors: the projects each one worked on — its payments and invoices
   allocated to projects, and the projects naming it as the chosen vendor. */
const VENDOR_PROJ = new Map();
async function vendorProjects(vendors) {
  VENDOR_PROJ.clear();
  const sets = new Map(vendors.map(v => [v.code, new Set()]));
  const add = (code, p) => { if (code && p && sets.has(code)) sets.get(code).add(p); };
  const byTax = new Map(vendors.filter(v => v.tax_code).map(v => [String(v.tax_code).trim(), v.code]));
  const byName = new Map();
  for (const v of vendors) for (const n of [v.code, v.name, ...String(v.aliases || '').split(',')]) if (n && hnorm(n)) byName.set(hnorm(n), v.code);
  try {
    const prj = await pmSelectAll('pm_project', 'select=code,chosen_vendor');
    for (const p of prj) if (p.chosen_vendor) add(byName.get(hnorm(p.chosen_vendor)), p.code);
  } catch {}
  try {
    const [pays, invs, al] = await Promise.all([pmSelectAll('pm_payment', 'select=id,vendor_code'),
      pmSelectAll('pm_invoice', 'select=id,seller_tax'), pmSelectAll('pm_pay_alloc', 'select=kind,ref_id,project_code')]);
    const pv = new Map(pays.map(x => [x.id, x.vendor_code])), iv = new Map(invs.map(x => [x.id, byTax.get(String(x.seller_tax || '').trim())]));
    for (const a of al) add(a.kind === 'payment' ? pv.get(a.ref_id) : iv.get(a.ref_id), a.project_code);
  } catch {}                                       // before 21_pm_payment.sql there is nothing to add
  for (const [code, set] of sets) VENDOR_PROJ.set(code, [...set].sort().join(', '));
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
    if (name === 'pm_vendor') await vendorProjects(rows);
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
        if (!c.calc && r.cur[c.name] !== r.orig[c.name]) patch[c.name] = r.cur[c.name];
      await SB.patch(CUR.table, `${pk}=eq.${encodeURIComponent(r.orig[pk])}`, patch); done++;
    }
    if (news.length) {
      const payload = news.map(r => {
        const o = {};
        for (const c of spec.cols)
          if (!c.calc && r.cur[c.name] != null && r.cur[c.name] !== '') o[c.name] = r.cur[c.name];
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

let CNT_ALL = false;          // the counter-key list unrolled
async function loadCounters() {
  const out = $('#cntOut');
  msg(out, 'info', t('table.loading'));
  try {
    const [seqs, bars, log] = await Promise.all([
      SB.select('am_asset_seq', 'select=*&order=dept_code,letters'),
      SB.select('am_barcode_seq', 'select=*&order=kind'),
      SB.select('am_counter_log', 'select=*&order=created_at.desc&limit=25')
    ]);
    /* Three hosts, not one: the KPI strip and the allocation log want the full
       width, while the key table sits in the left half with the reset panel
       beside it. */
    const kpiBox = $('#cntKpis'), logBox = $('#cntLog');
    out.innerHTML = ''; kpiBox.innerHTML = ''; logBox.innerHTML = '';
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
    kpiBox.append(kpis);

    if (seqs.length) {
      /* Short by default (user 25/09/2026): the first 3 keys, a filter to find
         the one wanted, and a link to unroll the whole list. */
      const f = el('input', { placeholder: t('cnt.filter'), style: 'width:220px' });
      const host = el('div');
      const draw = () => {
        const q = f.value.trim().toUpperCase().replace(/\s+/g, '');
        const hit = q ? seqs.filter(s => (s.dept_code + s.letters).toUpperCase().includes(q) || `${s.dept_code}.${s.letters}`.includes(q)) : seqs;
        const show = q || CNT_ALL ? hit : hit.slice(0, 3);
        const tb = el('table');
        // Header carries the same alignment as its cells — the rule the register
        // already follows, so a column of numbers reads as one right-ranged block.
        tb.append(el('tr', {}, [['cnt.col.dept'], ['cnt.col.letters'],
                                ['cnt.col.next', 1], ['cnt.col.updated']]
          .map(([k, n]) => el('th', { className: n ? 'num' : '', textContent: t(k) }))));
        for (const s of show)
          tb.append(el('tr', {}, [
            el('td', {}, el('code', { textContent: s.dept_code })),
            el('td', {}, el('code', { textContent: s.letters })),
            el('td', { className: 'num', textContent: String(s.next_seq).padStart(5, '0') }),
            el('td', { textContent: (s.updated_at || '').slice(0, 19).replace('T', ' ') })
          ]));
        host.innerHTML = '';
        host.append(el('div', { className: 'wrap' }, tb));
        if (!q && seqs.length > 3) {
          const more = el('a', { href: '#', textContent: CNT_ALL ? t('cnt.less') : t('cnt.more', { n: fmtInt(seqs.length) }) });
          more.onclick = ev => { ev.preventDefault(); CNT_ALL = !CNT_ALL; draw(); };
          host.append(el('div', { style: 'margin-top:6px;font-size:12.5px' }, more));
        }
      };
      f.oninput = draw;
      draw();
      out.append(el('h2', { textContent: t('cnt.keysH') }), el('div', { style: 'margin-bottom:8px' }, f), host);
    } else {
      out.append(el('div', { className: 'msg warn', textContent: t('cnt.noKeys') }));
    }

    if (log.length) {
      const d = el('details');
      d.append(el('summary', { textContent: t('cnt.log.summary', { n: log.length }) }));
      const tb = el('table');
      tb.append(el('tr', {}, [['cnt.log.when'], ['cnt.log.counter'], ['cnt.log.scope'],
        ['cnt.log.from', 1], ['cnt.log.to', 1], ['cnt.log.qty', 1], ['cnt.log.actor']]
        .map(([k, n]) => el('th', { className: n ? 'num' : '', textContent: t(k) }))));
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
      logBox.append(d);
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
      tb.append(el('tr', {}, [['cnt.audit.key'], ['cnt.audit.next', 1],
                              ['cnt.audit.max', 1], ['cnt.audit.gap', 1]]
        .map(([k, n]) => el('th', { className: n ? 'num' : '', textContent: t(k) }))));
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
    /* manage_by comes along because it is the field that says whether a
       category is kept one-row-per-unit ('code') or by quantity ('quantity') —
       which has to agree with the kind the unit price implies. */
    const cats = await SB.select('am_category',
      'select=code,group_code,label_letters,manage_by,name_vi,name_en&order=code');
    const orgs = await SB.select('am_org',
      'select=code,name_vi,name_en&is_department=is.true&order=code');
    const catText = c => `${c.code} — ${(LANG === 'vi' ? c.name_vi : c.name_en) || c.name_vi}`;
    for (const id of ['#rcCat', '#pvCat']) {
      const s = $(id); const keep = s.value; s.innerHTML = '';
      for (const c of cats) s.append(el('option', { value: c.code, textContent: catText(c) }));
      s.value = keep || (id === '#rcCat' ? 'LTU' : cats[0]?.code) || '';
    }
    for (const id of ['#pvDept', '#rsDept']) {
      const d = $(id); if (!d) continue;
      const keepD = d.value; d.innerHTML = '';
      for (const o of orgs) d.append(el('option', { value: o.code, textContent: o.code }));
      d.value = keepD || orgs[0]?.code || '';
    }
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

/* ------------------------------------------------- reseed / reset counters
   The Reconcile button on top of this page only ever pushes counters UP
   (am_seed_asset_seq uses greatest). These two do the other direction, which
   is why they are guarded and logged rather than offered as one more button. */
function rsTable(rows) {
  const tb = el('table');
  tb.append(el('tr', {}, [['cnt.rs.col.key'], ['cnt.rs.col.from', 1], ['cnt.rs.col.to', 1],
                          ['cnt.rs.col.move']]
    .map(([k, n]) => el('th', { className: n ? 'num' : '', textContent: t(k) }))));
  for (const r of rows)
    tb.append(el('tr', {}, [
      el('td', {}, el('code', { textContent: r.scope })),
      el('td', { className: 'num', textContent: fmtInt(r.old_next) }),
      el('td', { className: 'num', textContent: fmtInt(r.new_next) }),
      el('td', { className: r.moved === 'down' ? 'neg' : '',
                 textContent: t('cnt.rs.move.' + r.moved) })
    ]));
  return el('div', { className: 'wrap' }, tb);
}

/* Preview = run with p_allow_lower false and show what a real run WOULD move.
   It cannot show the downward moves without doing them, so instead it asks the
   audit what the gaps are -- read-only, and that is the whole point. */
async function rsPreview() {
  const out = $('#rsOut');
  msg(out, 'info', t('cnt.rs.checking'));
  try {
    const res = await SB.rpc('am_audit_counters');
    const ahead = (res || []).filter(r => r.gap > 0);
    out.innerHTML = '';
    out.append(el('div', { className: 'msg ' + (ahead.length ? 'warn' : 'ok'),
      textContent: ahead.length ? t('cnt.rs.ahead', { n: fmtInt(ahead.length) })
                                : t('cnt.rs.level') }));
    if (ahead.length)
      out.append(rsTable(ahead.map(r => ({ scope: r.scope, old_next: r.counter_next,
                                           new_next: r.table_max + 1, moved: 'down' }))));
  } catch (e) { msg(out, 'err', e.message); }
}

async function rsRunAll() {
  const out = $('#rsOut');
  if (!confirm(t('cnt.rs.confirmAll'))) return;
  msg(out, 'info', t('cnt.rs.running'));
  try {
    const res = await SB.rpc('am_reseed_counters', { p_allow_lower: true });
    const rows = res || [];
    out.innerHTML = '';
    out.append(el('div', { className: 'msg ' + (rows.length ? 'ok' : 'info'),
      textContent: rows.length ? t('cnt.rs.doneAll', { n: fmtInt(rows.length) })
                               : t('cnt.rs.level') }));
    if (rows.length) out.append(rsTable(rows));
    loadCounters();                       // the table above is now stale
  } catch (e) { msg(out, 'err', e.message); }
}

async function rsSetOne() {
  const out = $('#rsOut');
  const dept = $('#rsDept').value, letters = $('#rsLetters').value.trim();
  const next = Number($('#rsNext').value);
  if (!dept || !letters || !(next >= 1)) return msg(out, 'err', t('cnt.rs.needAll'));
  if (!confirm(t('cnt.rs.confirmOne', { dept, letters, n: fmtInt(next) }))) return;
  try {
    const r = (await SB.rpc('am_set_asset_seq',
      { p_dept: dept, p_letters: letters, p_next: next }))[0] || {};
    msg(out, 'ok', t('cnt.rs.doneOne', {
      key: `${r.dept_code}|${r.letters}`, from: fmtInt(r.old_next ?? 0),
      to: fmtInt(r.new_next), floor: fmtInt(r.floor_next) }));
    loadCounters();
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

/* One bilingual block, not one per language. This is the company's official
   form: it is signed by Vietnamese staff and filed in an English-language
   system, so both languages print together and the document does not change
   meaning when someone flips the UI toggle. */
const ALR_NOTES =
`1. After receiving the asset labels, the receiving department must attach each label directly to its asset as soon as the handover with the carrier is complete, and take two (2) photographs (one close-up of the attached label and one overall view of the asset showing the label).
1. Sau khi nhận được tem nhãn tài sản, bộ phận tiếp nhận phải dán ngay từng tem nhãn lên đúng tài sản tương ứng ngay sau khi hoàn tất việc bàn giao với đơn vị vận chuyển. Đồng thời, phải chụp hai (02) hình ảnh cho mỗi tài sản, bao gồm: (i) một ảnh cận cảnh thể hiện rõ tem nhãn đã được dán và (ii) một ảnh toàn cảnh tài sản có nhìn thấy tem nhãn.

2. Both photographs must be uploaded to the Asset Management System under the asset record, printed, and attached to the Asset Handover Form.
2. Cả hai (02) hình ảnh phải được tải lên Hệ thống Quản lý Tài sản (Asset Management System) theo đúng hồ sơ tài sản, đồng thời được in ra và đính kèm cùng Biên bản Nghiệm thu

Note: If the two (2) photographs of the asset label are not attached to the Asset Handover Form, the final payment request will not be approved.
Lưu ý: Trường hợp Biên bản Nghiệm thu không đính kèm đầy đủ hai (02) hình ảnh nêu trên, hồ sơ đề nghị thanh toán cuối cùng sẽ không được xem xét hoặc phê duyệt.`;

const ALR = { rows: [], mode: null, demo: false };

const fmtNum = n => n == null || n === ''
  ? '' : Number(n).toLocaleString(LANG === 'vi' ? 'vi-VN' : 'en-US');
const fmtDate = iso => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};
/* Date + time, one format for the whole app in both languages:
   dd/mm/yyyy HH:mm, 24-hour, local time (same day order as fmtDate). */
const fmtDateTime = v => {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  const z = n => String(n).padStart(2, '0');
  return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}`;
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
  /* Two independent ticks per row, which is why each needs its own tick-all:
       _pick  — is this asset ON the receipt at all
       _label — is its label already printed and attached; this one prints as
                the ✔ in the Label column instead of an empty box to fill in
                by pen, and is written back to am_asset.label_printed on save. */
  const all = (field, dflt) => {
    const n = ALR.rows.filter(r => (r[field] ?? dflt) !== false).length;
    const cb = el('input', { type: 'checkbox', title: t('alr.tickAll') });
    cb.checked = n > 0 && n === ALR.rows.length;
    cb.indeterminate = n > 0 && n < ALR.rows.length;
    cb.onchange = () => {
      for (const r of ALR.rows) r[field] = cb.checked;
      renderAlrList();
    };
    return cb;
  };

  head.append(el('tr', {}, [
    el('th', { className: 'delcol' }, ALR.rows.length ? all('_pick', true) : null),
    el('th', { className: 'num idx', textContent: '#' }),
    ...[['alr.col.code'], ['alr.col.name'], ['alr.col.qty', 1], ['alr.col.price', 1],
        ['alr.col.loc'], ['alr.col.barcode']]
      .map(([k, r]) => el('th', { className: r ? 'num' : '', textContent: t(k) })),
    /* Heading and its tick-all on ONE line. Stacked, the box dropped to a second
       row and no longer lined up with the tick-all at the far left of the same
       header — two controls doing the same job, sitting at two heights. */
    el('th', { className: 'lblcol' },
      el('div', { className: 'thtick' },
        [ALR.rows.length ? all('_label', false) : null,
         el('span', { textContent: t('alr.col.label') })]))
  ]));
  if (!ALR.rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: 9, style: 'color:var(--dim);padding:14px',
      textContent: t('alr.listEmpty') })));
    return;
  }
  ALR.rows.forEach((r, i) => {
    if (r._label === undefined) r._label = !!r.label_printed;
    const cb = el('input', { type: 'checkbox', checked: r._pick !== false });
    cb.onchange = () => { r._pick = cb.checked; renderAlrList(); };
    const lb = el('input', { type: 'checkbox', checked: r._label });
    lb.onchange = () => { r._label = lb.checked; renderAlrList(); };
    body.append(el('tr', {}, [
      el('td', { className: 'delcol' }, cb),
      el('td', { className: 'num idx', textContent: fmtInt(i + 1) }),
      el('td', { textContent: r.asset_code }),
      el('td', { textContent: [r.name_vi, r.name_en].filter(Boolean).join(' / ') }),
      el('td', { className: 'num', textContent: fmtNum(r.qty) }),
      el('td', { className: 'num', textContent: fmtNum(r.unit_price) }),
      el('td', { textContent: [r.location_code, r.location_name].filter(Boolean).join(' — ') }),
      el('td', { textContent: r.barcode }),
      el('td', { className: 'lblcol' }, lb)
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

  /* The receipt goes to the receiving department, who do not need to be told
     what every asset cost. Dropping the column gives its width back to the
     specification, which is the column that actually runs out of room. */
    const hidePrice = $('#alHidePrice').checked;
  const COLS = [['alr.doc.h.no', '4%'], ['alr.doc.h.code', '16%'], ['alr.doc.h.name', '18%'],
                ['alr.doc.h.qty', '7%'], ['alr.doc.h.spec', hidePrice ? '37%' : '27%'],
                ...(hidePrice ? [] : [['alr.doc.h.price', '10%']]),
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
      ...(hidePrice ? [] : [el('td', { className: 'r', textContent: fmtNum(r.unit_price) })]),
      el('td', { textContent: [r.location_code, r.location_name].filter(Boolean).join(' — ') }),
      /* Ticked in the app prints as ✔; untouched prints as the empty box the
         receiver fills in by pen — which is what the original form is for. */
      el('td', { className: 'lbl' },
         el('span', { className: 'tick' + (r._label ? ' on' : ''),
                      textContent: r._label ? '✔' : '' }))
    ]));
  });
  /* A closing line to count the sheet against the labels actually printed —
     one label per row, so the row count IS the label count. The quantity is
     shown too because they differ: a low-value line of 48 glasses is 48 units
     under one label, and someone counting glasses against labels needs to see
     why the two numbers are not the same. */
  const units = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const ticked = rows.filter(r => r._label).length;
  const sum = el('tr', { className: 'sum' });
  sum.append(el('td', { colSpan: COLS.length - 1, className: 'r',
                        textContent: t('alr.doc.total', { n: fmtInt(rows.length),
                                                          u: fmtInt(units) }) }));
  sum.append(el('td', { className: 'c',
                        textContent: ticked ? `${fmtInt(ticked)}/${fmtInt(rows.length)}` : '' }));
  body.append(sum);

  tb.append(body);
  root.append(tb);

  root.append(el('div', { className: 'doc-notes' }, [
    el('b', { textContent: t('alr.doc.notesTitle') }),
    document.createTextNode('\n' + $('#alNotes').value)
  ]));
  /* The remark prints only when there is one. An empty "Comment:" heading on a
     signed form invites someone to write in it by pen after the fact. */
  const comment = $('#alComment').value.trim();
  if (comment)
    root.append(el('div', { className: 'doc-notes' }, [
      el('b', { textContent: t('alr.doc.commentTitle') }),
      document.createTextNode('\n' + comment)
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
      comment_text: $('#alComment').value.trim() || null,
      // These record WHICH filter produced the receipt. With several picked
      // there is no single answer, so only a lone choice is stored.
      shipment_id: msValues('alShip').length === 1 ? msValues('alShip')[0] : null,
      dept_code: msValues('alDept').length === 1 ? msValues('alDept')[0] : null,
      location_code: msValues('alLoc').length === 1 ? msValues('alLoc')[0] : null
    }]);
    await SB.insert('am_alr_line',
      rows.map((r, i) => ({ alr_id: alr.id, line_no: i + 1, asset_id: r.id })));
    /* The ticks are a fact about the assets, not about this sheet of paper, so
       they go back to am_asset — otherwise the next receipt would show every
       label as still unattached. */
    const ticked = rows.filter(r => r._label && r.id).map(r => r.id);
    if (ticked.length) {
      try {
        await SB.call('am_asset?id=in.(' + ticked.join(',') + ')', {
          method: 'PATCH',
          headers: SB.hdr({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ label_printed: true })
        });
      } catch (e) { msg('#alOutMsg', 'warn', t('alr.labelSaveFail', { err: e.message })); }
    }
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
    // Reopening a receipt must not carry the last one's remark, so this is set
    // unconditionally — empty is a real value here.
    $('#alComment').value = a.comment_text || '';

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
  $('#alNotes').value = ALR_NOTES;
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
  // Budget and projects first: the dashboard, because it is what the people who
  // approve open this for, then their to-do list.
  ['nav.pm', [
    ['pmdash', 'nav.pmdash'],
    ['inbox', 'nav.inbox'],
    ['budget', 'nav.budget'],
    ['projects', 'nav.projects'],
    ['payments', 'nav.payments'],
    ['tbl:pm_vendor', null],
    ['price', 'nav.price'],             // price reference database (pricedb.js, 32_price_db.sql)
    ['chains', 'nav.chains']
  ]],
  ['nav.assets', [
    ['register', 'nav.register'],
    ['intake', 'nav.intake'],
    ['alr', 'nav.alr'],
    // The asset-management module in detail (assetops.js, 31_asset_ops.sql).
    ['transfer', 'nav.transfer'],
    ['incident', 'nav.incident'],
    ['stock', 'nav.stock'],
    ['liq', 'nav.liq'],
    ['acc', 'nav.acc'],
    ['amrep', 'nav.amrep'],
    ['counter', 'nav.counter']
  ]],
  // Every file that is uploaded from time to time, in one place: the budget
  // workbook, the dossiers, the accounting exports, the master-data templates.
  // Every file that is uploaded from time to time, on one screen (user 25/09/2026):
  // the budget workbook, dossiers and accounting exports on top, then the master-data templates.
  ['nav.import', [
    ['sources', 'nav.sources']
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
  // The four workflows (flows.js) stand in for a user manual (user 26/09/2026).
  ['nav.guide', [
    ['flows', 'nav.flows']
  ]],
  ['nav.system', [
    ['settings', 'nav.settings'],
    ['backup', 'nav.backup'],
    ['users', 'nav.users'], ['perms', 'nav.perms'], ['audit', 'nav.audit'], ['admin', 'nav.admin'],
    ['setup', 'nav.setup']
  ]]
];

let VIEW = 'setup';

/* Which permission module a screen belongs to. The Connection screen belongs to
   none: it has to open before anyone can sign in, because a first visit has no
   project URL yet. */
function viewModule(v) {
  if (!v || v === 'setup') return null;
  if (['register', 'intake', 'alr', 'counter', 'acc', 'transfer', 'incident', 'stock', 'stockcount', 'amrep'].includes(v)) return 'assets';
  if (['users', 'perms', 'audit'].includes(v)) return 'security';
  if (v === 'admin') return 'override';
  if (v === 'pmdash') return 'report';
  if (v === 'budget' || v === 'pmimport') return 'budget';
  if (v === 'projects' || v === 'tbl:pm_vendor' || v === 'doc') return 'project';
  if (v === 'inbox' || v === 'chains') return 'approval';
  if (v === 'liq' || v === 'lqcount') return 'liquidation';
  if (v === 'payments') return 'payment';
  if (v === 'price') return 'price';
  if (['sources', 'backup', 'tbl:am_setting'].includes(v)) return 'system';
  if (v === 'cat' || v.startsWith('tbl:')) return 'master';
  return null;
}
// The import page holds budget, dossier and accounting files: open to anyone who may see one of them.
const canView = v => { if (v === 'pmimport') return ['budget', 'project', 'payment'].some(m => can(m, 'view'));
                      if (v === 'sources') return ['budget', 'project', 'payment', 'system'].some(m => can(m, 'view'));
                      if (v === 'settings') return true;      // the help switch is everyone's; the year settings check their own right
                      // A document screen holds a project's package or a liquidation request (27_liquidation.sql).
                      if (v === 'doc') return can('project', 'view') || can('liquidation', 'view');
                      // Change log and Connection: System Admin only (feedback 25/09/2026). Connection still
                      // opens before anyone is signed in — a first visit has no project address yet.
                      if (v === 'audit') return can('system', 'admin');
                      if (v === 'setup') return !ME || can('system', 'admin');
                      const m = viewModule(v); return !m || can(m, 'view'); };

/* Where to land after signing in: the register for anyone allowed to see it,
   otherwise the first screen the menu offers them. */
function firstView() {
  if (TB.on) return canView('inbox') ? 'inbox' : 'pmdash';
  if (canView('register')) return 'register';
  for (const [, items] of NAV)
    for (const [id, , ch] of items) {
      if (id && id !== 'setup' && canView(id)) return id;
      for (const [cid] of ch || []) if (canView(cid)) return cid;
    }
  return 'setup';
}

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
  for (const [grpKey, allItems] of NAV) {
    // Only what this user may open. A group left with nothing is not drawn at
    // all, rather than shown as an empty heading.
    const items = allItems
      .map(([id, key, ch]) => [id, key, (ch || []).filter(c => canView(c[0]))])
      .filter(([id, , ch]) => (id ? canView(id) : ch.length > 0));
    if (!items.length) continue;
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
      if (id === 'inbox' && WF.badgeN > 0) a.append(el('span', { className: 'tag', textContent: String(WF.badgeN) }));
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
   start hidden. The switch is on the Settings screen, remembered per person
   (in this browser). */
const HELP_KEY = 'asset-intake.help';
const helpKey = () => HELP_KEY + (ME && ME.id ? ':' + ME.id : '');
let HELP_ON = false;
function helpLoad() { try { HELP_ON = localStorage.getItem(helpKey()) === '1'; } catch { HELP_ON = false; } applyHelp(); }
function helpSet(on) { HELP_ON = !!on; try { localStorage.setItem(helpKey(), HELP_ON ? '1' : '0'); } catch {} applyHelp(); }
function applyHelp() {
  document.body.classList.toggle('nohelp', !HELP_ON);
  const b = $('#stHelp');
  if (b) b.checked = HELP_ON;
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
    f.oninput = () => renderGridBody();
    const reload = el('button', { className: 'btn', textContent: t('tool.reload') });
    reload.onclick = () => loadTable(table);
    box.append(f, reload);

    /* Editing needs the "edit" right on this table's module. Without it the grid
       is read-only and the switch is not offered at all — a greyed-out Edit
       button on every catalogue screen would only be noise. */
    if (!can(viewModule(view), 'edit')) { EDIT = false; return; }
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
    // "Add new" straight from read mode (user 25/09/2026): opens editing with a blank row.
    if (!EDIT) {
      const add = el('button', { className: 'btn', textContent: t('tool.addNew') });
      add.onclick = () => { EDIT = true; buildTools(VIEW); addRow(); };
      box.append(add);
    }

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
  } else if (view === 'users' || view === 'perms' || view === 'audit') {
    const r = el('button', { className: 'btn', textContent: t('tool.reload') });
    r.onclick = () => (view === 'users' ? usLoad() : view === 'perms' ? pmLoad() : auLoad());
    box.append(r);
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
  // A screen this user may not open (rights changed, or it was the last screen
  // of the previous person) falls back to one they may.
  if (!canView(view)) view = ME ? firstView() : 'setup';
  // Tablet / phone: only the dashboard, the to-do list and the package to sign (tbDetect).
  if (TB.on && ME && !TB_VIEWS.includes(view)) view = canView('inbox') ? 'inbox' : 'pmdash';
  if (viewTable(VIEW) && view !== VIEW && CUR) {
    const n = CUR.rows.filter(r => r.isNew || r.dirty || r.del).length;
    if (n && !confirm(t('table.confirmLeave', { n }))) return;
  }
  if (VIEW === 'doc' && view !== 'doc' && WF.dirty && wfEditable() && !confirm(t('wf.leave'))) return;
  if (view !== 'doc') WF.dirty = false;
  if (view !== 'projects') ppDrawerClose();
  if (view !== 'budget') pbDrawerClose();
  VIEW = view;
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  curMark();
  const table = viewTable(view);
  const sect = table ? 'v-table' : 'v-' + view;
  $$('section').forEach(s => s.classList.toggle('on', s.id === sect));
  buildTools(view);
  $('#pageTitle').textContent = viewTitle(view);
  tbBarRender();

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
    if (view === 'sources' && SB.ready()) { if (can('system', 'view')) srcLoad(); srcChecklist(); pmLookups().catch(() => {}); piShow(); }
    if (view === 'settings' && SB.ready()) stLoad();
    if (view === 'register' && SB.ready()) { regFillPickers(); regLoad(true); }
    if (view === 'intake' && SB.ready()) inFill();
    if (view === 'pmdash' && SB.ready()) pdLoad();
    if (view === 'budget' && SB.ready()) pbLoad();
    if (view === 'projects' && SB.ready()) ppLoad();
    if (view === 'users' && SB.ready()) usLoad();
    if (view === 'perms' && SB.ready()) pmLoad();
    if (view === 'audit' && SB.ready()) auLoad();
    if (view === 'inbox' && SB.ready()) wfInboxLoad();
    if (view === 'chains' && SB.ready()) wfChainsLoad();
    if (view === 'doc' && SB.ready()) wfLoad();
    if (view === 'liq' && SB.ready()) lqLoad();
    if (view === 'lqcount' && SB.ready()) lcLoad();
    if (view === 'acc' && SB.ready()) accLoad();
    if (view === 'flows' && window.flowsRender) flowsRender();
    if (['transfer', 'incident', 'stock', 'stockcount', 'amrep'].includes(view) && SB.ready() && window.aoShow) aoShow(view);
    if (view === 'price' && SB.ready() && window.prLoad) prLoad();
    if (view === 'payments' && SB.ready()) payLoad();
    if (view === 'admin' && SB.ready()) adLoad();
  }
}

/* ------------------------------------------------------------- language */
function markLang() {
  $$('#langSeg button, #loginLang button')
    .forEach(b => b.classList.toggle('on', b.dataset.lang === LANG));
}

function switchLang(l) {
  if (!setLang(l)) return;
  applyI18n();
  markLang();
  buildNav();

  // The receipt notes are not swapped here any more: the block is bilingual, so
  // flipping the UI language must not rewrite a document that is already right.

  // The multi-select summaries and their option labels are built text, not
  // data-i18n markup, so applyI18n() cannot reach them.
  for (const id of Object.keys(MS)) {
    if (id === 'regKind')
      msSetup(id, [{ v: 'unique', t: t('reg.kindUnique') }, { v: 'low', t: t('reg.kindLow') }]);
    else msRender(id);
  }
  regFillBulk();                          // built options, same blind spot
  renderMe();                             // role names come from the database in both languages
  applyPerms();                           // the "no permission" tooltip is translated too

  setConn(CONN.ok, CONN.ok ? CONN.host : CONN.key || 'conn.none');   // sidebar text + Live pill
  applyHelp();
  ntRender();                             // the bell's tooltip and notice texts are built text too
  renderAlrList();
  if (ALR.mode === 'doc') buildDoc();
  else if (ALR.mode === 'labels') buildLabels();
  // Only when signed in: on the sign-in box the language buttons work too, and
  // there is nothing to fetch yet.
  if (SB.ready() && ME) { fillPickers(); fillAlrPickers(); }
  tplFill();                              // built options, same blind spot
  for (const [btn, field] of [['#btnShowUrl', '#sbUrl'], ['#btnShowKey', '#sbKey']])   // applyI18n reset them to Show
    $(btn).textContent = t($(field).type === 'password' ? 'setup.show' : 'setup.hide');
  showView(VIEW);
}

/* ------------------------------------------------------------- connect */
async function testConn(quiet) {
  if (!SB.ready()) { setConn(false, 'conn.none'); return false; }
  /* Step 1 needs nobody signed in: the auth settings endpoint answers to the
     anon key alone, so it tells a wrong URL or key apart from "right, but not
     signed in yet". No table answers to the anon key any more. */
  try { await authReq('GET', 'settings'); }
  catch (e) {
    setConn(false, 'conn.error');
    if (!quiet) msg('#setupMsg', 'err', authErrText(e) + t('setup.err.suffix'));
    return false;
  }
  if (!(await authToken())) {
    setConn(false, 'conn.signin');
    if (!quiet) { msg('#setupMsg', 'ok', t('setup.okSignIn')); loginShow('in'); }
    return false;
  }
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
  helpLoad();
  $('#stHelp').onchange = e => helpSet(e.target.checked);
  tbInit();
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
    // Not signed in yet: testConn opens the sign-in box itself.
    if (await testConn()) await enterApp();
  };
  $('#btnLink').onclick = () => {
    if (!SB.ready()) return msg('#setupMsg', 'err', t('setup.needBoth'));
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(CFG))));
    const link = location.origin + location.pathname + '#sbcfg=' + encodeURIComponent(b64);
    navigator.clipboard?.writeText(link).catch(() => {});
    msg('#setupMsg', 'ok', t('setup.linkCopied', { link }));
  };
  $('#btnForget').onclick = () => {
    // Forgetting the project on this device forgets who was signed in to it too.
    authStore(null); ME = null; renderMe(); buildNav(); applyPerms();
    localStorage.removeItem(LS_KEY); CFG = { url: '', key: '' };
    $('#sbUrl').value = ''; $('#sbKey').value = '';
    setConn(false, 'conn.none');
    msg('#setupMsg', 'ok', t('setup.forgotten'));
  };
  $('#btnCheck').onclick = checkSchema;

  $('#btnScan').onclick = scanSeed;
  $('#btnSeed').onclick = runSeed;
  $('#btnClassify').onclick = doClassify;
  $('#btnRsPreview').onclick = rsPreview;
  $('#btnRsAll').onclick = rsRunAll;
  $('#btnRsOne').onclick = rsSetOne;
  $('#btnOrigin').onclick = doOrigin;
  $('#btnPreview').onclick = doPreview;

  initAlr();
  initBackup();
  initSources();
  initRegister();
  initIntake();
  initLegacy();
  initAuthUi();
  initSecurity();
  initPm();
  initWf();
  initLq();
  initAdmin();
  initSig();
  initNotices();
  initPay();
  initCur();
  const back = authFromHash();   // BEFORE loadCfg: both read the address-bar fragment
  loadCfg();
  authLoad();
  renderMe();
  showView('setup');
  boot(back);
}
document.addEventListener('DOMContentLoaded', init);

/* Start-up order: a project to talk to → a session → who that is. Each missing
   piece stops at the screen that supplies it. */
async function boot(back) {
  if (!SB.ready()) { setConn(false, 'conn.none'); return; }   // first visit: connection first
  if (back && back.error) return loginShow('in', back.error);
  if (back && back.type === 'recovery' && SESS) return loginShow('new', t('auth.recoveryLead'), 'info');
  if (!(await authToken())) { setConn(false, 'conn.signin'); return loginShow('in'); }
  await enterApp();
}

function initAuthUi() {
  $('#loginForm').onsubmit = async ev => {
    ev.preventDefault();
    if ($('#loginIn').hidden) return $('#btnSetPw').click();   // Enter in the new-password box
    const email = $('#liEmail').value.trim(), pw = $('#liPw').value;
    if (!email || !pw) return msg('#loginMsg', 'err', t('auth.needBoth'));
    if (!SB.ready()) return msg('#loginMsg', 'err', t('err.noConfig'));
    const before = ((ME && ME.email) || '').toLowerCase();
    const btn = $('#btnSignIn');
    btn.disabled = true;
    msg('#loginMsg', 'info', t('auth.signingIn'));
    try {
      await authSignIn(email, pw);
      $('#liPw').value = '';
      // Someone else took over this browser mid-session: start from a clean page
      // rather than show them what the previous person had open.
      if (before && before !== email.toLowerCase()) return location.reload();
      await enterApp(before === email.toLowerCase());
    } catch (e) {
      msg('#loginMsg', 'err', authErrText(e));
    } finally {
      btn.disabled = false;
    }
  };

  $('#btnForgot').onclick = async () => {
    const email = $('#liEmail').value.trim();
    if (!email) { $('#liEmail').focus(); return msg('#loginMsg', 'err', t('auth.forgotNeedEmail')); }
    if (!SB.ready()) return msg('#loginMsg', 'err', t('err.noConfig'));
    try {
      await authReq('POST', 'recover?redirect_to='
                    + encodeURIComponent(location.origin + location.pathname), { email });
      msg('#loginMsg', 'ok', t('auth.forgotSent', { email }));
    } catch (e) { msg('#loginMsg', 'err', authErrText(e)); }
  };

  $('#btnLoginSetup').onclick = () => { loginHide(); showView('setup'); };

  $('#btnSetPw').onclick = async () => {
    const a = $('#liNew1').value, b = $('#liNew2').value;
    if (a.length < 8) return msg('#loginMsg', 'err', t('auth.pwShort'));
    if (a !== b) return msg('#loginMsg', 'err', t('auth.pwMismatch'));
    const btn = $('#btnSetPw');
    btn.disabled = true;
    try {
      const tok = await authToken();
      if (!tok) return loginShow('in', t('auth.expired'), 'warn');
      await authReq('PUT', 'user', { password: a }, tok);
      $('#liNew1').value = ''; $('#liNew2').value = '';
      // Say it worked before the box goes — a password change that closes
      // silently leaves people unsure whether it took.
      msg('#loginMsg', 'ok', t('auth.pwChanged'));
      setTimeout(() => (ME ? loginHide() : enterApp()), 1300);   // ME: changed from the sidebar
    } catch (e) {
      msg('#loginMsg', 'err', authErrText(e));
    } finally {
      btn.disabled = false;
    }
  };
  $('#btnPwCancel').onclick = loginHide;
  $('#btnPw').onclick = () => loginShow('change');
  $('#btnSignOut').onclick = authSignOut;
  $$('#loginLang button').forEach(b => { b.onclick = () => switchLang(b.dataset.lang); });

  /* Swallow clicks on anything applyPerms greyed out. Capture phase, so this
     runs before the button's own onclick and that handler never fires. */
  document.addEventListener('click', ev => {
    const n = ev.target.closest && ev.target.closest('.noperm');
    if (!n) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);

  // An open filter list closes when clicking anywhere else, like a drop-down.
  document.addEventListener('click', ev => {
    // composedPath, not contains(): a click on a choice redraws the list, so the
    // clicked row is already detached by the time this runs.
    const path = ev.composedPath();
    for (const d of $$('details.ms[open]')) if (!path.includes(d)) d.open = false;
  });

  // Signed out in another tab: this one follows instead of failing request by
  // request.
  window.addEventListener('storage', ev => {
    if (ev.key === SESS_KEY && !ev.newValue && ME) location.reload();
  });
}

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
  'am_asset_seq', 'am_barcode_seq', 'am_counter_log',
  'pm_budget_year', 'pm_budget_round', 'pm_budget_line',
  'pm_vendor', 'pm_project', 'pm_vendor_score'
];

// Parents before children. am_org and am_location also need an inner sort,
// because a row may reference another row of the same table.
// Budget rounds, their lines and vendor scores are backed up but NOT pushed
// back, for the same reason as assets: their keys are bigserial. They come
// back from the budget workbooks and dossiers, which are the originals.
const BK_PUSH = [
  'am_setting', 'am_org', 'am_org_alias', 'am_category_group', 'am_category',
  'am_unit', 'am_origin', 'am_origin_alias', 'am_origin_rejected',
  'am_location', 'am_product',
  'pm_budget_year', 'pm_vendor', 'pm_project'
];
const BK_SELF_REF = { am_org: 'parent_code', am_location: 'parent_code' };
const BK_PK = {
  am_setting: 'key', am_org: 'code', am_org_alias: 'alias',
  am_category_group: 'code', am_category: 'code', am_unit: 'code',
  am_origin: 'iso2', am_origin_alias: 'alias_norm', am_origin_rejected: 'raw_norm',
  am_location: 'code', am_product: 'raw_name_norm',
  pm_budget_year: 'year', pm_vendor: 'code', pm_project: 'code'
};
// Columns the database computes. Sending a value back — even the same value —
// is rejected ("cannot insert a non-DEFAULT value into column").
const BK_GENERATED = { pm_project: ['status'] };

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
      el('small', { textContent: t('bk.nTables', { n: BK_ALL.length }) })
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
    if (!snap.tables) throw new Error(t('bk.noTablesKey'));
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
      if (BK_GENERATED[table])
        data = data.map(r => { const o = { ...r }; for (const c of BK_GENERATED[table]) delete o[c]; return o; });
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
        el('td', { textContent: r.loaded_by === SRC_DOSSIER ? t('src.kind.dossier') : t('src.kind.' + r.source_kind) }),
        el('td', { textContent: r.loaded_by || '' })
      ]));
    hist.append(el('div', { className: 'wrap' }, h));
  } catch (e) {
    msg(cur, 'err', e.message + '\nsql/07_data_source.sql');
  }
}

/* The upload checklist (feedback 25/09/2026): one row per file that has to be
   uploaded again and again, one column per month of the year. A month is
   ticked when an upload covers it — the accounting exports by the period they
   hold, the others by the day they were loaded — with the day beside the tick;
   a month that has ended without one is marked missing; the rest is not due
   yet. The budget workbook comes per submission round, so it is never
   "missing". Rows the person may not read are left out. */
const SRC_DOSSIER = 'dossier import';
const SRC_CK = { year: null };
async function srcChecklist() {
  let box = $('#srcCheck');
  if (!box) return;
  const y = SRC_CK.year || new Date().getFullYear();
  const mm = d => { const x = new Date(d); return isNaN(x) ? null : { y: x.getFullYear(), m: x.getMonth() + 1 }; };
  const at = rows => rows.map(r => ({ at: r.at, file: r.file, months: [mm(r.at)].filter(Boolean) }));
  // The months a period covers (from…to), else the month of the upload.
  const span = (from, to, when) => {
    const a = mm(from || when), b = mm(to || from || when), out = [];
    if (!a || !b) return out;
    for (let yy = a.y, m = a.m, n = 0; (yy < b.y || (yy === b.y && m <= b.m)) && n < 36; n++) { out.push({ y: yy, m }); if (++m > 12) { m = 1; yy++; } }
    return out;
  };
  const defs = [
    ['budget', 'round', async () => at((await SB.select('pm_budget_round', 'select=imported_at,source_file,label')).map(r => ({ at: r.imported_at, file: r.source_file || r.label })))],
    ['dossier', 'month', async () => at((await SB.select('am_data_source', `select=loaded_at,source_file&table_name=eq.pm_project&loaded_by=eq.${encodeURIComponent(SRC_DOSSIER)}`))
      .map(r => ({ at: r.loaded_at, file: r.source_file })))],
    ...['invoice', 'payment'].map(kind => [kind, 'month', async () => (await SB.select('pm_pay_import', `select=imported_at,file_name,period_from,period_to&kind=eq.${kind}`))
      .map(r => ({ at: r.imported_at, file: r.file_name, months: span(r.period_from, r.period_to, r.imported_at) }))]),
    ['register', 'month', async () => at((await SB.select('am_data_source', 'select=loaded_at,source_file&table_name=eq.am_asset&source_kind=eq.register-scan'))
      .map(r => ({ at: r.loaded_at, file: r.source_file })))]
  ];
  const rows = (await Promise.all(defs.map(async ([k, freq, get]) => { try { return { k, freq, items: await get() }; } catch { return null; } }))).filter(Boolean);
  const now = new Date(), ended = m => y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
  const years = [...new Set([now.getFullYear(), ...rows.flatMap(r => r.items.flatMap(i => i.months.map(x => x.y)))])].sort((a, b) => b - a);
  const ySel = el('select', {}, years.map(v => el('option', { value: v, textContent: v, selected: v === y })));
  ySel.onchange = () => { SRC_CK.year = +ySel.value; srcChecklist(); };
  const tb = el('table', { className: 'srcck' });
  const monthName = m => new Date(2000, m - 1, 1).toLocaleString(LANG === 'vi' ? 'vi-VN' : 'en-GB', { month: 'short' });
  tb.append(el('tr', {}, [el('th', { textContent: t('src.ck.file') }), el('th', { textContent: t('src.ck.freq') }),
    ...Array.from({ length: 12 }, (_, i) => el('th', { className: 'c', textContent: monthName(i + 1) }))]));
  for (const r of rows) {
    const tr = el('tr', {}, [el('td', { textContent: t('src.ck.' + r.k) }), el('td', { className: 'dim', textContent: t('src.ck.f.' + r.freq) })]);
    for (let m = 1; m <= 12; m++) {
      const hit = r.items.filter(i => i.months.some(x => x.y === y && x.m === m)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      if (hit.length) tr.append(el('td', { className: 'c ok', title: hit.map(i => `${fmtDateTime(i.at)} · ${i.file || ''}`).join('\n') },
        [el('b', { textContent: '✓' }), el('small', { textContent: fmtDate(String(hit[0].at).slice(0, 10)).slice(0, 5) })]));
      else if (r.freq === 'month' && ended(m)) tr.append(el('td', { className: 'c miss', title: t('src.ck.missing'), textContent: '✗' }));
      else tr.append(el('td', { className: 'c na', textContent: '·' }));
    }
    tb.append(tr);
  }
  box.innerHTML = '';
  box.append(el('div', { className: 'chead' }, [el('h2', { textContent: t('src.ck.h') }), el('div', { className: 'fld', style: 'max-width:110px' }, ySel)]),
    el('div', { className: 'wrap' }, tb),
    el('div', { className: 'srcckkey' }, [el('span', { className: 'ok', textContent: '✓ ' + t('src.ck.kOk') }),
      el('span', { className: 'miss', textContent: '✗ ' + t('src.ck.missing') }), el('span', { className: 'na', textContent: '· ' + t('src.ck.kNa') })]));
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

/* Refill a <select>, keeping what was chosen — so the labels follow a language
   switch instead of staying in the language the screen was first opened in. */
function selFill(sel, opts) {
  const keep = sel.value;
  sel.innerHTML = '';
  for (const [v, txt] of opts) sel.append(el('option', { value: v, textContent: txt }));
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
}

function tplFill() {
  const s = $('#tplPick');
  if (!s) return;
  selFill(s, [...TPL_MASTER.map(tbl => ['tbl:' + tbl, tblLabel(tbl)]), ['beetrack', t('tpl.beetrack')]]);
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
  'description', 'status_code', 'label_printed', 'note', 'created_at',
  // Official values from accounting's books (30_acc_reconcile.sql) — pick them in Columns once 30 has run.
  'fin_status', 'fin_cost', 'fin_nbv', 'fin_start', 'fin_term', 'fin_account', 'fin_as_of', 'no_label',
  'warranty_until'                 // 31_asset_ops.sql
];
const REG_DEFAULT = ['asset_code', 'barcode', 'name', 'category_code',
                     'dept_code', 'location_code', 'qty', 'unit_code',
                     'unit_price', 'purchase_date', 'status_code'];
/* How each column is rendered. Only money and quantities are right-aligned —
   header included — everything else reads better ranged left.
   Years and sequence numbers are numeric but are NOT quantities: a thousands
   separator turns 2026 into "2,026", so they print as plain digits. */
const REG_RIGHT = new Set(['qty', 'unit_price', 'depreciate_months', 'fin_cost', 'fin_nbv', 'fin_term']);
const REG_PLAIN = new Set(['seq', 'purchase_year', 'spec_mfg_year']);
const REG_DATE  = new Set(['purchase_date', 'in_use_date', 'created_at', 'fin_start', 'fin_as_of', 'warranty_until']);
// Yes / no columns, centred: a label printed shows ✓, not yet ✗ (user 25/09/2026).
const REG_MID   = new Set(['label_printed', 'depreciate', 'no_label']);

/* Asset status codes ("Mã Tình Trạng"), as Beetrack defines them (the note on
   the column of its upload template, user 26/09/2026). Two lists: an asset with
   its own barcode (unique) and a batch sharing one barcode (low-value). The
   code is what is stored and exported; the words are shown beside it. */
const AM_STATUS = {
  unique: [['0', 'Đã mất', 'Lost'], ['1', 'Đang sử dụng', 'In use'], ['2', 'Chưa được sử dụng', 'Not yet in use'],
           ['3', 'Hư hỏng, đang chờ được sửa chữa', 'Damaged, awaiting repair'], ['4', 'Hư hỏng, không thể sửa chữa', 'Damaged beyond repair'],
           ['5', 'Đang sửa chữa', 'Under repair'], ['6', 'Đang bảo dưỡng', 'Under maintenance'], ['7', 'Đã thanh lí', 'Liquidated'],
           ['8', 'Chờ thanh lí', 'Awaiting liquidation'], ['9', 'Đã hủy', 'Destroyed'], ['10', 'Không sử dụng', 'Not in use'],
           ['120', 'Chờ duyệt', 'Awaiting approval']],
  low:    [['20', 'Hoạt động', 'Operating'], ['21', 'Không hoạt động', 'Not operating'], ['22', 'Tạm dừng', 'Suspended'],
           ['23', 'Thanh lý một phần', 'Partly liquidated'], ['24', 'Chờ Thanh lý', 'Awaiting liquidation'],
           ['25', 'Hư hỏng, đang chờ được sửa chữa', 'Damaged, awaiting repair'], ['119', 'Chờ duyệt', 'Awaiting approval']]
};
const amStatusRow = code => { const c = String(code ?? '').trim(); for (const k of ['unique', 'low']) { const r = AM_STATUS[k].find(s => s[0] === c); if (r) return [k, r]; } return null; };
// "1 · Đang sử dụng" / "1 · In use"; an unknown code as it is.
const amStatusLabel = code => { const h = amStatusRow(code); return h ? `${h[1][0]} · ${LANG === 'vi' ? h[1][1] : h[1][2]}` : String(code ?? ''); };
// Which list a code belongs to ('unique' | 'low'), or null.
const amStatusKind = code => (amStatusRow(code) || [null])[0];

function regCell(col, v, row) {
  if (col === 'status_code' && v != null && v !== '') return amStatusLabel(v);
  if (col === 'fin_status') return t('acc.fs.' + (v || 'temp'));
  if (REG_JOINED[col])
    return REG_JOINED[col].map(f => (row?.[f] || '').trim())
                          .filter(Boolean).join(' / ');
  if (col === 'label_printed') return v ? '✓' : '✗';
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
/* sel holds asset ids, not row indexes, so a selection survives paging,
   sorting and re-filtering — you can gather rows from four pages and act on
   them once. anchor is the last row clicked, for shift-click ranges. */
let REG = { cols: null, sort: 'asset_code', dir: 'asc', page: 0, total: 0, rows: [],
            colq: {}, sel: new Set(), anchor: -1, opts: { deps: [], locs: [] } };

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
  /* Tick-all applies to THIS PAGE only. Ticking 16,000 rows from one box is a
     mistake waiting to happen; the bulk bar offers the whole filtered set
     separately, in words, so choosing it has to be deliberate. */
  const all = el('input', { type: 'checkbox', title: t('reg.bk.allPage') });
  all.checked = REG.rows.length > 0 && REG.rows.every(r => REG.sel.has(r.id));
  all.onchange = () => {
    for (const r of REG.rows) all.checked ? REG.sel.add(r.id) : REG.sel.delete(r.id);
    regRender();
  };
  hr.append(el('th', { className: 'tickcol' }, all));
  hr.append(el('th', { className: 'num idx', textContent: '#' }));
  for (const c of REG.cols) {
    // The header carries the same alignment as its cells, so a money column
    // reads as one right-ranged block instead of a left title over right digits.
    const th = el('th', { className: 'sortable' + (REG_RIGHT.has(c) ? ' num' : REG_MID.has(c) ? ' c' : ''), title: c });
    th.append(document.createTextNode(colLabel(c)));
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
  fr.append(el('th', { className: 'tickcol' }));
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
    const tr = el('tr', { className: REG.sel.has(r.id) ? 'sel' : '' });
    const cb = el('input', { type: 'checkbox', checked: REG.sel.has(r.id) });
    cb.onclick = ev => {
      // Shift-click takes everything between the last tick and this one, the
      // way a file list does -- ticking 80 rows one at a time is not a feature.
      if (ev.shiftKey && REG.anchor >= 0 && REG.anchor !== i) {
        const lo = Math.min(REG.anchor, i), hi = Math.max(REG.anchor, i);
        for (let k = lo; k <= hi; k++)
          cb.checked ? REG.sel.add(REG.rows[k].id) : REG.sel.delete(REG.rows[k].id);
      } else {
        cb.checked ? REG.sel.add(r.id) : REG.sel.delete(r.id);
      }
      REG.anchor = i;
      regRender();
    };
    tr.append(el('td', { className: 'tickcol' }, cb));
    // Numbered across the whole filtered set, not restarted on every page.
    tr.append(el('td', { className: 'num idx', textContent: fmtInt(from + i + 1) }));
    for (const c of REG.cols) {
      // The asset code opens the asset's panel: facts, photos, its whole life (assetops.js).
      if (c === 'asset_code' && window.aoAsset) {
        tr.append(el('td', {}, el('a', { href: '#', className: 'aolink', textContent: regCell(c, r[c], r), onclick: ev => { ev.preventDefault(); aoAsset(r.id); } })));
        continue;
      }
      tr.append(el('td', {
        className: REG_RIGHT.has(c) ? 'num' : REG_MID.has(c) ? 'c' + (c === 'label_printed' && !r[c] ? ' dim' : '') : '',
        textContent: regCell(c, r[c], r)
      }));
    }
    body.append(tr);
  });
  if (!REG.rows.length)
    body.append(el('tr', {}, el('td', { colSpan: (REG.cols.length || 1) + 2,
      style: 'color:var(--dim);padding:14px', textContent: t('reg.empty') })));
  regBulkBar();

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

/* ------------------------------------------------------ bulk edit / delete
   Selection is by id and lives across pages, so the bar has to say plainly how
   many rows are held — including the ones scrolled away. */
function regBulkBar() {
  const bar = $('#regBulk'), n = REG.sel.size;
  bar.hidden = n === 0;
  if (!n) { msg($('#regBulkMsg'), '', ''); return; }
  $('#regSelN').textContent = t('reg.bk.n', { n: fmtInt(n) });
  const all = $('#btnRegSelAll');
  all.textContent = t('reg.bk.all', { n: fmtInt(REG.total) });
  all.hidden = n >= REG.total;
  $('#btnRegBulkSave').disabled = !$('#regBulkLoc').value && !$('#regBulkDept').value && !$('#regBulkSt').value;
}

/* Tick every row the current filter matches, not just the page on screen.
   Only ids are fetched -- 16,000 of those is a small payload; 16,000 full rows
   is not, and nothing here needs the other columns. */
async function regSelectAll() {
  const out = $('#regBulkMsg');
  msg(out, 'info', t('reg.bk.loadingIds'));
  try {
    const step = 1000;
    for (let off = 0; off < REG.total; off += step) {
      const q = ['select=id', `order=${REG_JOINED[REG.sort] ? REG_JOINED[REG.sort][0] : REG.sort}.${REG.dir}`,
                 `limit=${step}`, `offset=${off}`, ...regFilters()];
      const { body } = await SB.call('am_asset?' + q.join('&'), { headers: SB.hdr() });
      if (!body?.length) break;
      for (const r of body) REG.sel.add(r.id);
    }
    msg(out, '', '');
    regRender();
  } catch (e) { msg(out, 'err', e.message); }
}

async function regBulkSave() {
  /* The outcome goes to the register's own message line, not the bulk bar: the
     bar disappears with the selection the moment the write succeeds, and a
     report nobody can read is not a report. */
  const out = $('#regMsg');
  const loc = $('#regBulkLoc').value || null;
  const dep = $('#regBulkDept').value || null;
  const st = $('#regBulkSt').value || null;
  if (!loc && !dep && !st) return;
  const ids = [...REG.sel];

  // A status belongs to one kind of asset: a low-value code on a unique asset (or the reverse) is refused.
  if (st) {
    try {
      const kinds = new Set();
      for (let i = 0; i < ids.length; i += 300) {
        const part = await SB.select('am_asset', `select=asset_kind&id=in.(${ids.slice(i, i + 300).join(',')})`);
        part.forEach(r => kinds.add(r.asset_kind));
      }
      const need = amStatusKind(st);
      if ([...kinds].some(k => k !== need)) return msg(out, 'err', t('reg.bk.stKind', { s: amStatusLabel(st), k: t('reg.st.' + need) }));
    } catch (e) { return msg(out, 'err', e.message); }
  }

  /* Changing department is not an edit to one cell. am_asset_code_ck ties the
     asset code to the department, so the code is REISSUED and any label already
     printed now shows the wrong one. Say that before it happens, not after. */
  const ask = dep ? t('reg.bk.confirmDept', { n: fmtInt(ids.length), dept: dep })
                  : loc ? t('reg.bk.confirmLoc', { n: fmtInt(ids.length), loc }) : t('reg.bk.confirmSt', { n: fmtInt(ids.length), s: amStatusLabel(st) });
  if (!confirm(ask)) return;

  msg(out, 'info', t('reg.bk.saving'));
  try {
    const r = (await SB.rpc('am_bulk_update',
      { p_ids: ids, p_location: loc, p_dept: dep, p_status: st }))[0] || {};
    const parts = [t('reg.bk.doneUpd', { n: fmtInt(r.updated || 0) })];
    if (r.recoded) parts.push(t('reg.bk.doneRecode', { n: fmtInt(r.recoded) }));
    if (r.relabel) parts.push(t('reg.bk.doneRelabel', { n: fmtInt(r.relabel) }));
    if (r.skipped_legacy) parts.push(t('reg.bk.doneLegacy', { n: fmtInt(r.skipped_legacy) }));
    REG.sel.clear();
    $('#regBulkLoc').value = ''; $('#regBulkDept').value = ''; $('#regBulkSt').value = '';
    await regLoad();          // regLoad clears #regMsg, so report after it
    msg(out, r.skipped_legacy ? 'warn' : 'ok', parts.join(' '));
  } catch (e) { msg(out, 'err', e.message); }
}

async function regBulkDelete() {
  const out = $('#regMsg');
  const ids = [...REG.sel];
  // Deleting from the register does NOT rewind the counters (see 15_bulk_edit.sql),
  // so the confirmation has to be worth reading rather than waved through.
  if (!confirm(t('reg.bk.confirmDel', { n: fmtInt(ids.length) }))) return;
  msg(out, 'info', t('reg.bk.deleting'));
  try {
    const r = (await SB.rpc('am_bulk_delete', { p_ids: ids }))[0] || {};
    const parts = [t('reg.bk.doneDel', { n: fmtInt(r.deleted || 0) })];
    if (r.kept_on_receipt) parts.push(t('reg.bk.doneKept', { n: fmtInt(r.kept_on_receipt) }));
    REG.sel.clear();
    await regLoad();
    msg(out, r.kept_on_receipt ? 'warn' : 'ok', parts.join(' '));
  } catch (e) { msg(out, 'err', e.message); }
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
    row.append(cb, el('span', { textContent: colLabel(c), title: c }));
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
async function regFetchAll(onProgress, allCols) {
  const sel = allCols ? '*' : regSelect();
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
    // Every field of the asset (feedback 25/09/2026), not only the columns on
    // screen: the chosen columns first in their order, then all the others.
    const rows = await regFetchAll(n => msg(out, 'info', t('reg.exporting') + ' ' + fmtInt(n)), true);
    const rest = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(c => !REG.cols.includes(c));
    const flat = v => v != null && typeof v === 'object' ? JSON.stringify(v).slice(0, 32000) : v;   // needs_review and other jsonb (an Excel cell holds 32,767 characters)
    // A joined column has no raw value, so it is built here -- otherwise the sheet would carry an empty "name".
    const shaped = rows.map((r, i) => Object.fromEntries([
      ['#', i + 1],
      ...REG.cols.map(c => [c, REG_JOINED[c] ? regCell(c, null, r) : flat(r[c])]),
      ...rest.map(c => [c, flat(r[c])])
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
    : n === 1 ? ((st.opts.find(o => o.v === [...st.sel][0]) || {}).t || [...st.sel][0])
    : t('ms.nChosen', { n });
  host.classList.toggle('picked', n > 0);
  host.querySelector('.ms-q').placeholder = t('ms.search');
  // A short list needs no search box, just like a plain drop-down.
  host.querySelector('.ms-q').hidden = st.opts.length <= 8;
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
  const hit = st.opts.filter(o => !q || o.t.toLowerCase().includes(q));
  // While searching, chosen entries stay on top so they never scroll out of
  // reach; otherwise rows keep their place, so a click never moves the list.
  const shown = (q ? [...hit.filter(o => st.sel.has(o.v)), ...hit.filter(o => !st.sel.has(o.v))] : hit)
    .slice(0, 300);
  /* Drawn like an open drop-down list (same look as the other PHCL apps):
     "— all —" first, then the choices; a click toggles one, a ✓ marks what is
     chosen. Several can be chosen, so the list stays open until clicked away. */
  if (!q) {
    const all = el('div', { className: 'ms-i all' + (st.sel.size ? '' : ' cur') }, el('span', { textContent: t('reg.all') }));
    all.onclick = () => { st.sel.clear(); msRender(id); st.onChange?.(); };
    box.append(all);
  }
  for (const o of shown) {
    const it = el('div', { className: 'ms-i' + (st.sel.has(o.v) ? ' on' : ''), title: o.t }, el('span', { textContent: o.t }));
    it.onclick = () => {
      if (st.sel.has(o.v)) st.sel.delete(o.v); else st.sel.add(o.v);
      msRender(id); st.onChange?.();
    };
    box.append(it);
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

    /* The bulk bar writes one value to many rows, so it is a single-choice
       <select> -- not the multi-select the filters use. Same lists, though:
       there is only one set of valid codes. */
    REG.opts.deps = deps.map(o => ({ v: o.code, t: `${o.code} — ${nm(o)}` }));
    REG.opts.locs = locs.map(o => ({ v: o.code, t: `${o.code} — ${o.name}` }));
    regFillBulk();
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

  regFillBulk();
  $('#btnRegSelAll').onclick = regSelectAll;
  $('#btnRegSelNone').onclick = () => { REG.sel.clear(); REG.anchor = -1; regRender(); };
  $('#regBulkLoc').onchange = regBulkBar;   // Apply stays dead until a target is set
  $('#regBulkDept').onchange = regBulkBar;
  $('#regBulkSt').onchange = regBulkBar;
  $('#btnRegBulkSave').onclick = regBulkSave;
  $('#btnRegBulkDel').onclick = regBulkDelete;
}

function regFillBulk() {
  for (const [id, list] of [['#regBulkLoc', REG.opts.locs], ['#regBulkDept', REG.opts.deps]]) {
    const sel = $(id);
    if (!sel) continue;
    const keep = sel.value;               // survive a refill or a language switch
    sel.innerHTML = '';
    sel.append(el('option', { value: '', textContent: t('reg.bk.keep') }));
    for (const o of list) sel.append(el('option', { value: o.v, textContent: o.t }));
    sel.value = keep;
  }
  // The status: the two lists of codes, each under its own heading.
  const st = $('#regBulkSt');
  if (st) {
    const keep = st.value;
    st.innerHTML = '';
    st.append(el('option', { value: '', textContent: t('reg.bk.keep') }));
    for (const k of ['unique', 'low'])
      st.append(el('optgroup', { label: t('reg.st.' + k) }, AM_STATUS[k].map(s => el('option', { value: s[0], textContent: amStatusLabel(s[0]) }))));
    st.value = keep;
  }
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
  unit_price: '', serials: '', origin_raw: '', origin_iso2: '', location_code: '', description: '',
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
    // Carries the verdict from the last Check, so the grid shows where the
    // problems are instead of making the reviewer match line numbers by hand.
    const tr = el('tr', { className: ln._bad ? 'bad' : ln._warn ? 'warn' : '' });
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
    /* Money needs group separators to be read at a glance — 149801000 and
       14980100 look alike, 149.801.000 and 14.980.100 do not. <input
       type=number> cannot show them, so this is a text box that formats on
       blur and keeps the raw number in the line.
       Digits only: the intake screen books in VND, and every price in the
       register is a whole đồng, so there is no decimal mark to preserve. */
    const money = (field, w) => {
      const v = ln[field];
      const inp = el('input', { style: `width:${w}px`, inputMode: 'numeric',
                                spellcheck: false,
                                value: v === '' || v == null ? '' : fmtNum(v) });
      inp.onchange = () => {
        const digits = inp.value.replace(/[^\d]/g, '');
        ln[field] = digits === '' ? '' : Number(digits);
        IN.checked = null;
        inRender();
      };
      return el('td', { className: 'num' }, inp);
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
    }
    /* Say when the code was moved for us — a changed category the reviewer did
       not pick must never pass unannounced, and the alternative is named so the
       other half of the pair is one click away. */
    if (ln._kindSwap)
      catTd.append(el('span', { className: 'sug weak', textContent: '⇄',
        title: t('in.kindSwapped', { was: ln._kindSwap.was,
                                     alts: ln._kindSwap.alts.join(' / ') }) }));

    /* Flag a category that fights the price right in the cell. Waiting for
       Check hides it until the reviewer has already moved on. */
    const catRow = (window.__CATS || []).find(c => c.code === ln.category_code);
    const kindNow = kindOf(ln);
    if (catRow && kindNow && catRow.manage_by &&
        catRow.manage_by !== (kindNow === 'unique' ? 'code' : 'quantity')) {
      catTd.append(el('span', { className: 'sug bad', textContent: '!',
        title: t('in.kindMismatchShort',
                 { cat: catRow.code, kind: t('reg.kind' + (kindNow === 'unique' ? 'Unique' : 'Low')) }) }));
    }
    if (!ln._sug && ln.name_vi && IN.sugRan) {
      // Only claim "the register does not know this name" once the lookup has
      // actually run. Before that, saying so would be a guess of our own.
      catTd.append(el('span', { className: 'sug none', title: t('in.sugNone'),
                                textContent: '?' }));
    }
    tr.append(catTd);
    tr.append(txt('qty', 60, 'number'));
    tr.append(pick('unit_code', IN.units || [], 90));
    const priceTd = money('unit_price', 120);
    // Where the number came from matters: the delivery note or the contract.
    if (ln._priceFrom === 'contract')
      priceTd.append(el('div', { className: 'sercount', textContent: t('in.priceContract') }));
    tr.append(priceTd);
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
    /* Origin is stored as an ISO-3166 alpha-2 code, because that is what the
       column is (am_asset.origin_iso2 references am_origin) and what Beetrack's
       "Mã Xuất Xứ" expects. So the cell is a droplist of countries, not a text
       box: "UK", "Vietnam" and "VN" all have to land on one value.
       The raw text from the delivery note stays underneath as the evidence the
       code was derived from — the same arrangement as name and description. */
    const oriTd = el('td');
    const oriSel = el('select', { style: 'width:150px' });
    oriSel.append(el('option', { value: '', textContent: '—' }));
    for (const o of IN.origins || [])
      oriSel.append(el('option', { value: o.v, textContent: o.t,
                                   selected: o.v === ln.origin_iso2 }));
    oriSel.onchange = () => {
      ln.origin_iso2 = oriSel.value; IN.checked = null; inRender();
    };
    oriTd.append(oriSel);
    if (ln.origin_raw?.trim())
      oriTd.append(el('div', { className: 'sercount', textContent: ln.origin_raw }));
    /* Raw text that resolved to nothing. "EU" and "Asia" are the usual cause:
       they are real answers but they are not countries, so no ISO code exists
       and the reviewer has to decide. Saying so here beats saying it at Check. */
    if (ln.origin_raw?.trim() && !ln.origin_iso2)
      oriTd.append(el('span', { className: 'sug none', textContent: '?',
                                title: t('in.originNone', { raw: ln.origin_raw }) }));
    tr.append(oriTd);
    /* Left empty, the line inherits the department's office. Show that as the
       placeholder so the inherited value is visible rather than implied. */
    const locTd = txt('location_code', 110);
    const office = inDeptOffice();
    if (office && !ln.location_code) {
      locTd.querySelector('input').placeholder = office.code;
      locTd.append(el('div', { className: 'sercount', textContent: office.name }));
    }
    tr.append(locTd);

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

/* The catalogue knows what a thing IS, not what it cost. "Dây nguồn" maps to
   LTU because that is the long-term tools code, but LTU is kept one row per
   unit — so on a 455,000đ line it is the wrong half of the pair. Swap to the
   sibling in the same accounting group that matches the price, and say so:
   silently changing a code the reviewer did not choose would be worse than
   the mismatch. Returns the code it moved away from, or null. */
function alignKindCategory(ln) {
  const cats = window.__CATS || [];
  const cat = cats.find(c => c.code === ln.category_code);
  const kind = kindOf(ln);
  if (!cat || !kind || !cat.manage_by) return null;
  const want = kind === 'unique' ? 'code' : 'quantity';
  if (cat.manage_by === want) return null;
  const alt = cats.filter(c => c.group_code === cat.group_code && c.manage_by === want)
                  .map(c => c.code).sort();
  if (!alt.length) return null;
  const was = ln.category_code;
  ln.category_code = alt[0];
  ln._kindSwap = { was, alts: alt };
  return was;
}

/* Scroll the grid to a line and flash it, so a number in the Check panel and a
   row in the grid are the same thing rather than two lists to compare by eye. */
function inJump(i) {
  const tr = document.querySelectorAll('#inGrid tbody tr')[i - 1];
  if (!tr) return;
  tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
  tr.classList.remove('flash');
  void tr.offsetWidth;            // restart the animation
  tr.classList.add('flash');
}

/* The office of the department currently chosen for this delivery. */
const inDeptOffice = () => IN.deptOffice?.get($('#inDept')?.value);

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
    // No location entered? The asset sits at its department's office.
    location_code: ln.location_code || inDeptOffice()?.code || null,
    company_code: $('#inCompany').value,
    dept_code: $('#inDept').value,
    purpose_code: $('#inPurpose').value.trim() || null,
    invoice_no: $('#inInvoice').value.trim() || null,
    supplier: $('#inSupplier').value.trim() || null,
    purchase_date: $('#inDate').value || null,
    in_use_date: $('#inDate').value || null,
    purchase_year: Number(($('#inDate').value || '').slice(0, 4)) || new Date().getFullYear(),
    origin_iso2: ln.origin_iso2 || null,
    // Received, not yet accepted: "Chờ duyệt" until the handover (AH) is approved (user 26/09/2026).
    // Added from accounting's books (already in use and booked): in use straight away.
    status_code: IN.src && IN.src.acc ? (kind === 'low' ? '20' : '1') : kind === 'low' ? '119' : '120',
    // Which intake line it came from (links it back to the accounting line after Confirm; not a column).
    _ln: IN.lines.indexOf(ln),
    ...(ln._nolabel ? { no_label: true } : {}),
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
  /* Problems are recorded against their line, not flattened into a list of
     sentences. The same sentence repeated for seven lines is unreadable and
     impossible to cross-check against the grid; grouped by message with the
     line numbers beside it, it is one row. */
  const errs = [], warns = [];
  const E = (i, msg) => errs.push({ i, msg });
  const W = (i, msg) => warns.push({ i, msg });
  let rows = 0;

  for (let i = 0; i < IN.lines.length; i++) {
    const ln = IN.lines[i], n = i + 1;
    ln._review = [];
    if (!ln.name_vi?.trim()) E(n, t('in.errNoName', { i: n }));
    if (!ln.category_code) E(n, t('in.errNoCat', { i: n }));
    const price = Number(ln.unit_price);
    if (!price) E(n, t('in.errNoPrice', { i: n }));

    /* The category has to agree with what the price makes this line.
         >= 5,000,000  -> unique -> a category kept per unit  (manage_by 'code')
         <  5,000,000  -> low    -> a category kept by quantity
       Getting this wrong is not cosmetic: 'unique' turns one line into one row
       PER UNIT and draws from the JVC.0… barcode range, 'low' stays one row and
       draws from JVC.9…. A 455,000đ power cord under LTU would be issued a
       unique asset code and a unique-range barcode it is not entitled to. */
    const cat = (window.__CATS || []).find(c => c.code === ln.category_code);
    const kind = kindOf(ln);
    if (cat && kind) {
      const want = kind === 'unique' ? 'code' : 'quantity';
      if (cat.manage_by && cat.manage_by !== want) {
        const alt = (window.__CATS || [])
          .filter(c => c.group_code === cat.group_code && c.manage_by === want)
          .map(c => c.code);
        // Two directions, two sentences — one template cannot describe both
        // without saying something false about the price or the category.
        E(n, t(kind === 'unique' ? 'in.errKindNeedsCode' : 'in.errKindNeedsQty', {
          i: n, cat: cat.code,
          price: fmtNum(price), th: fmtNum(IN.thUnique || 5000000),
          alt: alt.length ? alt.join(' / ') : '—'
        }));
      }
    }
    if (!(Number(ln.qty) >= 1)) E(n, t('in.errNoQty', { i: n }));

    if (ln.category_code && price) {
      try {
        const r = (await SB.rpc('am_classify', {
          p_unit_price: price, p_category_code: ln.category_code,
          p_is_intangible: false
        }))[0];
        if (r.violates_capex) E(n, t('in.errCapex', { i: n, code: ln.category_code }));
        for (const w of r.warnings || []) W(n, `${n}: ${w}`);
      } catch (e) { E(n, `${n}: ${e.message}`); }
    }

    /* The droplist is the answer now — it was filled by the lookup on import and
       may since have been corrected by hand, so re-resolving here would throw
       that correction away. Only a raw string that still has no code is a
       finding, and "EU" or "Asia" is the usual reason: a real answer that has
       no ISO code, which the reviewer must settle rather than the app. */
    if (!ln.origin_iso2 && ln.origin_raw?.trim()) {
      try {
        const o = (await SB.rpc('am_resolve_origin', { p_raw: ln.origin_raw }))[0];
        W(n, t('in.warnOrigin', { i: n, why: t('why.' + o.reason) }));
        ln._review.push({ field: 'origin_iso2', reason: o.reason, raw: ln.origin_raw });
      } catch {
        W(n, t('in.warnOrigin', { i: n, why: t('why.unknown') }));
      }
    }

    /* A serial is what ties a register row to a physical object. On a unique
       asset each unit becomes its own row, so a missing serial leaves a row
       that can never be matched back to the thing on the shelf. Warn on the
       absence, not only on a miscount. */
    const ser = inSerials(ln);
    const wantSer = Number(ln.qty) || 0;
    if (ser.length && ser.length !== wantSer)
      W(n, t('in.warnSerial', { i: n, have: ser.length, qty: ln.qty }));
    else if (!ser.length && kindOf(ln) === 'unique') {
      W(n, t('in.warnNoSerial', { i: n, qty: ln.qty }));
      ln._review.push({ field: 'serial', reason: 'missing_on_unique' });
    }

    // Doubt raised while reading the delivery note must survive into the
    // register, not stop at this screen.
    for (const f of ln._unsure || []) {
      W(n, t('in.warnUnsure', { i: n, field: f }));
      ln._review.push({ field: f, reason: 'unreadable_on_note' });
    }
    if (ln._src && ln._src !== 'printed') {
      W(n, t('in.warnQtySrc', { i: n, src: ln._src }));
      ln._review.push({ field: 'qty', reason: 'qty_' + ln._src });
    }
    if (ln._unitRaw && !ln.unit_code)
      W(n, t('in.warnUnit', { i: n, raw: ln._unitRaw }));
    // Inheriting the office is the right default, but it is still a choice the
    // reviewer should see stated rather than discover in the register later.
    if (!ln.location_code && inDeptOffice())
      W(n, t('in.warnOffice', { i: n, dept: $('#inDept').value,
                                      loc: inDeptOffice().code }));
    // A price taken from the contract is not a price off the delivery note.
    if (ln._priceFrom === 'contract') {
      W(n, t('in.warnPriceContract', { i: n }));
      ln._review.push({ field: 'unit_price', reason: 'from_contract' });
    }

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
  /* Hand the problems back to the lines so the grid can colour itself, and
     group them by message so one sentence carries all the line numbers it
     applies to. Each number is a button that jumps to that row and flashes it. */
  for (const ln of IN.lines) { ln._bad = 0; ln._warn = 0; }
  for (const e of errs) if (IN.lines[e.i - 1]) IN.lines[e.i - 1]._bad++;
  for (const w of warns) if (IN.lines[w.i - 1]) IN.lines[w.i - 1]._warn++;
  inRender();

  const group = list => {
    const by = new Map();
    for (const { i, msg } of list) {
      // Drop the "Line 7:" prefix — the numbers move to the chips beside it.
      const key = String(msg).replace(/^\s*(Line|Dòng)\s+\d+\s*:\s*/, '');
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(i);
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  };

  const block = (list, cls) => {
    for (const [msg, lines] of group(list)) {
      const row = el('div', { className: 'msg ' + cls });
      row.append(el('div', { className: 'gmsg', textContent: msg }));
      const chips = el('div', { className: 'chips' });
      for (const i of lines) {
        const b = el('button', { className: 'chip', textContent: fmtInt(i),
                                 title: t('in.jumpTo', { i }) });
        b.onclick = () => inJump(i);
        chips.append(b);
      }
      row.append(chips);
      out.append(row);
    }
  };

  if (errs.length) {
    out.append(el('div', { className: 'msg err',
      textContent: t('in.hasErr', { n: new Set(errs.map(e => e.i)).size }) }));
    block(errs, 'err');
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
    out.append(el('div', { className: 'msg warn',
      textContent: t('in.hasWarn', { n: new Set(warns.map(w => w.i)).size }) }));
    block(warns, 'warn');
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
    // One delivery = one batch (am_shipment, 26_alr_project.sql): the project and the PO it came from,
    // so the label receipt (AL) and the handover (AH) can take exactly these assets.
    // Before 26 has run the columns are missing: the assets are written without a batch, as before.
    let shipId = null;
    const proj = $('#inPurpose').value.trim();
    if (proj) {
      try {
        const now = new Date(), z = n => String(n).padStart(2, '0');
        const [sh] = await SB.insert('am_shipment', [{
          code: `${proj}/${now.getFullYear()}${z(now.getMonth() + 1)}${z(now.getDate())}-${z(now.getHours())}${z(now.getMinutes())}${z(now.getSeconds())}`,
          delivery_date: $('#inDate').value || null, supplier: $('#inSupplier').value.trim() || null,
          invoice_no: $('#inInvoice').value.trim() || null, purpose_code: proj, project_code: proj,
          po_doc_no: (IN.src && IN.src.project === proj && IN.src.po) || null, contract_ref: (IN.src && IN.src.project === proj && IN.src.po) || null,
          company_code: $('#inCompany').value || null, dept_code: $('#inDept').value || null, status: 'confirmed',
          created_by: (ME && (ME.full_name || ME.email)) || null }]);
        shipId = sh && sh.id;
      } catch (e) { console.warn('shipment not recorded', e); }
    }
    const lnOf = all.map(r => r._ln);
    const payload = all.map(r => {
      const o = { ...r };
      delete o._review; delete o._ln;
      o.needs_review = r.needs_review || [];
      if (shipId) o.shipment_id = shipId;
      return o;
    });
    const saved = await SB.insert('am_asset', payload);
    IN.committed = saved || payload;
    // Assets added from accounting's books: linked back to the lines they came from (30_acc_reconcile.sql).
    if (IN.src && IN.src.acc && saved) {
      const pairs = saved.flatMap((a, k) => ((IN.lines[lnOf[k]] || {})._acc || []).map(line_id => ({ line_id, asset_id: a.id,
        desc_norm: accNorm(((ACC.lineMap || new Map()).get(line_id) || {}).description) })));
      try { if (pairs.length) await SB.rpc('am_acc_link_set', { p_pairs: pairs, p_method: 'intake' }); }
      catch (e) { console.warn('accounting links not recorded', e); msg(out, 'warn', t('acc.linkLater', { err: e.message })); }
      IN.src = null;
    }
    const codes = IN.committed.map(r => r.asset_code).sort();
    msg(out, 'ok', t('in.written', { n: IN.committed.length,
                                     from: codes[0], to: codes[codes.length - 1] }));
    $('#btnInXlsx').disabled = false;
    $('#btnInUndo').disabled = false;
    $('#btnInConfirm').disabled = true;
    /* Keep the draft aside rather than dropping it. Undo has to give back the
       lines as they were edited — the corrections in them are the expensive
       part, not the writing. Plain data only, so a JSON round-trip clones it. */
    IN.draft = JSON.parse(JSON.stringify(IN.lines));
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

/* Undo the batch just written. Available only while this screen still holds the
   rows it created — it is a "that was wrong, take it back" for the minute after
   Confirm, not a general delete tool. */
async function inUndo() {
  if (!IN.committed.length) return msg('#inMsg', 'warn', t('in.nothingYet'));
  const ids = IN.committed.map(r => r.id).filter(Boolean);
  if (!ids.length) return msg('#inMsg', 'err', t('in.undoNoIds'));
  if (!confirm(t('in.undoConfirm', { n: fmtInt(ids.length) }))) return;

  msg('#inMsg', 'info', t('in.undoing', { n: fmtInt(ids.length) }));
  let res;
  try { res = (await SB.rpc('am_undo_intake', { p_ids: ids }))?.[0]; }
  catch (e) { return msg('#inMsg', 'err', t('in.undoFail', { err: e.message })); }

  const kept = (res?.kept_on_receipt || 0) + (res?.kept_legacy || 0);
  const rew = res?.seq_rewound || 0, held = res?.seq_held || 0;
  msg('#inMsg', kept || held ? 'warn' : 'ok',
      t(kept ? 'in.undoneSome' : 'in.undone',
        { n: fmtInt(res?.deleted || 0), kept: fmtInt(kept),
          receipt: fmtInt(res?.kept_on_receipt || 0) }) + ' ' +
      t(held ? 'in.undoSeqHeld' : 'in.undoSeqBack',
        { rew: fmtInt(rew), held: fmtInt(held) }));

  try {
    await SB.insert('am_data_source', [{
      table_name: 'am_asset', source_file: $('#inPurpose').value.trim() || 'manual intake',
      source_kind: 'manual', rows_loaded: -(res?.deleted || 0), loaded_by: 'intake undo'
    }]);
  } catch { /* the provenance log is optional, never block on it */ }

  if (!(res?.kept_on_receipt || res?.kept_legacy)) IN.committed = [];
  $('#btnInUndo').disabled = !IN.committed.length;
  $('#btnInXlsx').disabled = !IN.committed.length;

  /* Put the edited lines back. Without this the undo would cost the reviewer
     everything they had corrected — category by category — and leave them
     re-pasting the JSON from scratch. */
  if (IN.draft?.length) {
    if (!IN.lines.length ||
        confirm(t('in.undoRestore', { n: fmtInt(IN.draft.length),
                                      cur: fmtInt(IN.lines.length) }))) {
      IN.lines = IN.draft;
      IN.draft = null;
      IN.checked = null;
      $('#btnInConfirm').disabled = true;   // must pass Check again
      inRender();
      msg('#inMsg', 'ok', $('#inMsg').textContent + ' ' +
                          t('in.undoRestored', { n: fmtInt(IN.lines.length) }));
    }
  }
  regLoad(true);
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

/* Turn every raw origin string into an ISO2 code up front, so the reviewer sees
   a filled droplist instead of being told at Check that something was wrong.
   Resolved per DISTINCT string: one delivery note of 45 lines usually carries
   four or five different spellings, not 45. Lines the reviewer has already set
   by hand are left alone — a manual answer outranks a lookup. */
async function inResolveOrigins() {
  const todo = [...new Set(IN.lines
    .filter(ln => (ln.origin_raw || '').trim() && !ln.origin_iso2)
    .map(ln => ln.origin_raw.trim()))];
  if (!todo.length) return 0;

  const seen = new Map();
  for (const raw of todo) {
    try {
      const o = (await SB.rpc('am_resolve_origin', { p_raw: raw }))[0];
      seen.set(raw, o?.iso2 || null);
    } catch { seen.set(raw, null); }
  }
  let n = 0;
  for (const ln of IN.lines) {
    const hit = seen.get((ln.origin_raw || '').trim());
    if (hit && !ln.origin_iso2) { ln.origin_iso2 = hit; n++; }
  }
  return n;
}

async function inFill() {
  try {
    const [orgs, units, th, prods, offices, origins] = await Promise.all([
      SB.select('am_org', 'select=code,is_company,is_department&order=code'),
      SB.select('am_unit', 'select=code&order=sort_order'),
      SB.select('am_setting', 'select=key,value&key=eq.unique_threshold'),
      SB.select('am_product',
        'select=std_name_vi,std_name_en,default_category,default_unit&order=std_name_vi'),
      /* Each department has exactly one office location (the database enforces
         it with a unique index). An asset with no location of its own belongs
         at its department's office — that is what the office flag is FOR, and
         the intake screen was ignoring it, leaving the column empty. */
      SB.select('am_location', 'select=code,name,dept_code&is_dept_office=is.true'),
      SB.select('am_origin', 'select=iso2,name_en,name_vi&order=iso2')
    ]);
    /* Code first, then the name in the reading language: the code is what gets
       stored and exported, so it is what the eye should land on. */
    IN.origins = (origins || []).map(o => ({
      v: o.iso2, t: `${o.iso2} — ${(LANG === 'vi' ? o.name_vi : o.name_en) || o.name_en}`
    }));
    IN.deptOffice = new Map((offices || [])
      .filter(o => o.dept_code)
      .map(o => [o.dept_code, { code: o.code, name: o.name }]));
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
  const nOri = await inResolveOrigins();
  if (nOri) inRender();
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
  let filled = 0, none = 0, weak = 0, swapped = 0;
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
    // The catalogue answers "what is it", the price answers "how is it kept".
    if (alignKindCategory(ln)) swapped++;
  }
  IN.sugRan = true;
  inRender();
  msg('#dnMsg', none || weak ? 'warn' : 'ok',
      t('dn.suggested', { n: filled, none, weak }) +
      (swapped ? ' ' + t('dn.kindSwapped', { n: fmtInt(swapped) }) : ''));
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
  // The inherited office changes with the department, so redraw the lines.
  $('#inDept').onchange = () => inRender();
  $('#btnInCheck').onclick = inCheck;
  $('#btnInConfirm').onclick = inConfirm;
  $('#btnInXlsx').onclick = inXlsx;
  $('#btnInUndo').onclick = inUndo;
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

/* The same card also takes the app's own "Asset upload (Beetrack, 2 sheets)"
   form (BT_UNIQUE / BT_LOW): its columns sit elsewhere (category in D, not C),
   so it is read by header name, both sheets, and turned into rows keyed like
   the export — the checks below then run unchanged. The sheet says the kind.
   Returns null when the workbook is not that form. */
const LEG_UPLOAD_HEAD = {
  category: 'Mã Danh Mục (*)', name: 'Tên (*)', desc: 'Mô Tả', code: 'Mã Tài Sản', barcode: 'Mã Vạch',
  location: 'Mã Vị Trí (*)', dept: 'Mã Phòng Ban', company: 'Mã Công Ty Thành Viên (*)', origin: 'Mã Xuất Xứ',
  serial: 'Số Seri', invoice: 'Số Hóa Đơn', unit: 'Đơn Vị Tính', qty: 'Số Lượng',
  price: ['Đơn Giá', 'Giá Đơn Vị'], bought: 'Ngày Mua', status: 'Mã Tình Trạng (*)', purpose: 'Mục đích Tài Sản'
};
function legUploadGrid(wb) {
  const norm = s => legTxt(s).normalize('NFC').toLowerCase();
  const out = [{}];                 // row 0 stands for the header, as in the export grid
  let found = false;
  wb.SheetNames.forEach((name, si) => {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    const head = (aoa[0] || []).map(norm);
    if (!head.includes(norm(LEG_UPLOAD_HEAD.category))) return;
    found = true;
    const kind = /low|thấp|cùng/i.test(name) || si === 1 ? 'low' : 'unique';
    const idx = {};
    for (const [k, h] of Object.entries(LEG_UPLOAD_HEAD))
      idx[k] = [].concat(h).map(x => head.indexOf(norm(x))).find(i => i >= 0) ?? -1;
    aoa.slice(1).forEach((r, ri) => {
      const row = { __line: `${name} · ${ri + 2}`, __kind: kind };
      for (const [k, i] of Object.entries(idx)) if (i >= 0 && LEG_COL[k]) row[LEG_COL[k]] = r[i];
      out.push(row);
    });
  });
  return found ? out : null;
}

/* The export writes dates as dd/mm/yyyy text; a workbook saved in Excel may
   hold a real date instead, which arrives as its serial number (35796 = 1998-01-01). */
function legDate(v) {
  if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(legTxt(v))) {
    const n = Number(v);
    if (n > 20000 && n < 80000) return new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);
  }
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
    grid = legUploadGrid(wb) || XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 'A', defval: '' });
  } catch (e) { return msg(out, 'err', e.message); }
  if (grid.length < 2) return msg(out, 'warn', t('leg.noRows'));

  const seenCode = new Set(), seenBar = new Set();
  const G = LEG_COL;

  for (let i = 1; i < grid.length; i++) {
    const r = grid[i], line = r.__line || i + 1;
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

    // The status must be one of Beetrack's codes for this kind of asset (AM_STATUS): kept, but flagged when not.
    const rawSt = legTxt(r[G.status]);
    const kindNow = r.__kind || (/cùng/i.test(legTxt(r[G.kind])) ? 'low' : 'unique');
    if (rawSt && amStatusKind(rawSt) !== kindNow) warns.push(t('leg.wStatus', { v: rawSt, k: t('reg.st.' + kindNow) }));

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
      asset_kind: r.__kind || (/cùng/i.test(legTxt(r[G.kind])) ? 'low' : 'unique'),
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

/* ======================================================= USERS & PERMISSIONS
   Accounts are created in the Supabase dashboard (Authentication → Users →
   Add user, "Auto Confirm User" ticked). Creating one from here would need the
   service key, and that key must never reach a browser. A trigger turns each
   new account into a row of app_user straight away; this screen hands out the
   roles and the scope each one applies to. */

const SEC = { users: [], roles: [], mods: [], perms: [], orgs: [], pmMod: 'assets' };
const PM_ACTS = ['view', 'create', 'edit', 'approve', 'admin'];
const AUDIT_TABLES = [
  'am_asset', 'am_alr', 'am_alr_line', 'am_shipment', 'am_shipment_line',
  'am_org', 'am_org_alias', 'am_category_group', 'am_category', 'am_unit',
  'am_location', 'am_product', 'am_origin', 'am_origin_alias', 'am_origin_rejected',
  'am_setting', 'am_xls_template', 'am_xls_column',
  'app_user', 'app_user_role', 'app_permission', 'app_role', 'app_module'
];

const roleName = r => (LANG === 'vi' ? r.name_vi : r.name_en) || r.code;
const modName  = m => (LANG === 'vi' ? m.name_vi : m.name_en) || m.code;
const orgName  = o => (LANG === 'vi' ? o.name_vi : o.name_en) || o.name_vi || '';
const isSelf   = u => !!(ME && u.id === ME.id);

async function secLookups() {
  const [roles, mods, orgs] = await Promise.all([
    SB.select('app_role', 'select=*&order=sort'),
    SB.select('app_module', 'select=*&order=sort'),
    SB.select('am_org', 'select=code,name_vi,name_en,parent_code&order=code')
  ]);
  Object.assign(SEC, { roles, mods, orgs });
}

/* am_org in tree order with a depth, for the scope picker: a scope is a node
   of that tree, and picking one from a flat alphabetical list hides which
   departments it covers. */
function orgTreeOrder() {
  const kids = new Map();
  for (const o of SEC.orgs) {
    const p = o.parent_code || '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(o);
  }
  const out = [];
  const walk = (p, d) => {
    for (const o of (kids.get(p) || []).sort((a, b) => a.code.localeCompare(b.code))) {
      out.push(Object.assign({ depth: d }, o));
      walk(o.code, d + 1);
    }
  };
  walk('', 0);
  return out;
}

/* ---------------------------------------------------------------- users */
async function usLoad() {
  const out = $('#usMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await secLookups();
    const [users, links] = await Promise.all([
      SB.select('app_user', 'select=*&order=email'),
      SB.select('app_user_role', 'select=*')
    ]);
    SEC.users = users.map(u => Object.assign({}, u, {
      roles: links.filter(l => l.user_id === u.id)
                  .sort((a, b) => a.role_code.localeCompare(b.role_code))
    }));
    // How to add someone is the first question on this screen, and the answer
    // is not on this screen — so it is said here, not in a help text that is
    // hidden by default.
    msg(out, 'info', t('users.howToAdd'));
    usRender();
  } catch (e) { msg(out, 'err', e.message); }
}

/* Users as an organisation chart (user 25/09/2026): company → entities →
   departments (the am_org tree), each box listing who holds which role with
   that exact scope. People scoped to the whole company sit in the top box. */
function usOrgChart() {
  const showOff = $('#usInactive').checked, q = $('#usQ').value.trim().toLowerCase();
  const people = new Map();                  // org code -> [{ role, user }]
  for (const u of SEC.users) {
    if (!showOff && !u.active) continue;
    if (q && !`${u.email} ${u.full_name || ''}`.toLowerCase().includes(q)) continue;
    for (const l of u.roles) (people.get(l.scope_org) || people.set(l.scope_org, []).get(l.scope_org)).push({ role: l.role_code, u });
  }
  const kids = new Map();
  for (const o of SEC.orgs) (kids.get(o.parent_code || '') || kids.set(o.parent_code || '', []).get(o.parent_code || '')).push(o);
  const orgName = o => (LANG === 'vi' ? o.name_vi : o.name_en) || o.name_en || o.name_vi || o.code;
  const box = o => {
    const list = (people.get(o.code) || []).sort((a, b) => (SEC.roles.findIndex(r => r.code === a.role) - SEC.roles.findIndex(r => r.code === b.role)));
    const r = code => SEC.roles.find(x => x.code === code);
    return el('div', { className: 'onode' + (list.length ? '' : ' empty') }, [
      el('div', { className: 'oname' }, [el('code', { textContent: o.code }), document.createTextNode(' ' + orgName(o))]),
      ...list.map(p => el('div', { className: 'operson' + (p.u.active ? '' : ' off') }, [
        el('span', { className: 'orole', textContent: r(p.role) ? roleName(r(p.role)) : p.role }),
        el('span', { textContent: p.u.full_name || p.u.email, title: p.u.email })]))]);
  };
  const walk = o => {
    const ch = (kids.get(o.code) || []).sort((a, b) => a.code.localeCompare(b.code));
    // Departments without sub-units stack in a column under their entity, so the chart stays narrow.
    const leaves = ch.length && ch.every(c => !(kids.get(c.code) || []).length);
    return el('li', {}, [box(o), ...(ch.length ? [el('ul', { className: leaves ? 'leaves' : '' }, ch.map(walk))] : [])]);
  };
  const roots = (kids.get('') || []).sort((a, b) => a.code.localeCompare(b.code));
  return el('div', { className: 'orgwrap' }, el('ul', { className: 'org' }, roots.map(walk)));
}
function usRender() {
  // List or organisation chart (user 25/09/2026).
  const vs = $('#usView');
  vs.innerHTML = '';
  for (const [v, k] of [['list', 'users.view.list'], ['org', 'users.view.org']]) {
    const b = el('button', { textContent: t(k) });
    b.classList.toggle('on', (SEC.usView || 'list') === v);
    b.onclick = () => { SEC.usView = v; usRender(); };
    vs.append(b);
  }
  const org = $('#usOrg');
  org.innerHTML = '';
  $('#usTableWrap').hidden = SEC.usView === 'org';
  if (SEC.usView === 'org') { org.append(usOrgChart()); return; }
  const head = $('#usGrid thead'), body = $('#usGrid tbody');
  const admin = can('security', 'admin');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, [
    el('th', { className: 'num idx', textContent: '#' }),
    el('th', { textContent: t('users.col.email') }),
    el('th', { textContent: t('users.col.name') }),
    el('th', { textContent: t('users.col.roles') }),
    el('th', { textContent: t('users.col.active') })
  ]));
  const q = $('#usQ').value.trim().toLowerCase();
  const showOff = $('#usInactive').checked;
  const list = SEC.users.filter(u => (showOff || u.active)
    && (!q || `${u.email} ${u.full_name || ''}`.toLowerCase().includes(q)));

  list.forEach((u, i) => {
    const tr = el('tr', { className: u.active ? '' : 'off' });
    tr.append(el('td', { className: 'num idx', textContent: fmtInt(i + 1) }));
    tr.append(el('td', {}, el('code', { textContent: u.email })));

    const nameTd = el('td');
    if (admin) {
      const inp = el('input', { value: u.full_name || '', style: 'width:190px', spellcheck: false });
      inp.onchange = () => usPatch(u, { full_name: inp.value.trim() || null });
      nameTd.append(inp);
    } else nameTd.textContent = u.full_name || '';
    tr.append(nameTd);

    const box = el('div', { className: 'roles' });
    for (const l of u.roles) {
      const r = SEC.roles.find(x => x.code === l.role_code);
      const chip = el('span', { className: 'role', title: l.role_code }, [
        el('b', { textContent: r ? roleName(r) : l.role_code }),
        document.createTextNode(' · ' + l.scope_org)
      ]);
      // Your own System Admin role cannot be taken away from here: that is the
      // one click that would leave nobody able to open this screen.
      if (admin && !(isSelf(u) && l.role_code === 'SYS_ADMIN')) {
        const x = el('button', { className: 'x', textContent: '×', title: t('users.removeRole') });
        x.onclick = () => usRemoveRole(u, l);
        chip.append(x);
      }
      box.append(chip);
    }
    if (!u.roles.length)
      box.append(el('span', { style: 'color:var(--amber);font-size:12px', textContent: t('users.noRole') }));
    if (admin) box.append(usAddRoleCtl(u));
    tr.append(el('td', {}, box));

    const cb = el('input', { type: 'checkbox', checked: u.active,
                             disabled: !admin || isSelf(u),
                             title: isSelf(u) ? t('users.cannotSelf') : '' });
    cb.onchange = () => usPatch(u, { active: cb.checked });
    tr.append(el('td', {}, cb));
    body.append(tr);
  });
  if (!list.length)
    body.append(el('tr', {}, el('td', { colSpan: 5, style: 'color:var(--dim);padding:14px',
      textContent: t('users.none') })));
}

/* Role first, then scope. The scope list starts on the role's usual scope
   (SOF for the hotel GM, PHCL for JVC) and stays empty for roles that must be
   tied to one department, so nobody is handed the whole hotel by accident. */
function usAddRoleCtl(u) {
  const wrap = el('span', { className: 'addrole' });
  const rs = el('select');
  rs.append(el('option', { value: '', textContent: t('users.addRole') }));
  for (const ent of ['SSP', 'CP', 'JVC', 'SYS']) {
    const og = el('optgroup', { label: t('perms.ent.' + ent) });
    for (const r of SEC.roles.filter(x => x.entity === ent))
      og.append(el('option', { value: r.code, textContent: roleName(r) }));
    rs.append(og);
  }
  const ss = el('select');
  const ok = el('button', { className: 'btn', textContent: t('users.add') });
  ss.hidden = true; ok.hidden = true;
  rs.onchange = () => {
    const r = SEC.roles.find(x => x.code === rs.value);
    ss.innerHTML = '';
    ss.hidden = ok.hidden = !r;
    if (!r) return;
    ss.append(el('option', { value: '', textContent: t('users.pickScope') }));
    for (const o of orgTreeOrder())
      ss.append(el('option', { value: o.code,
        textContent: '  '.repeat(o.depth) + o.code + ' — ' + orgName(o) }));
    ss.value = r.default_scope || '';
  };
  ok.onclick = () => {
    if (!rs.value) return;
    if (!ss.value) return msg('#usMsg', 'err', t('users.pickScope'));
    usAddRole(u, rs.value, ss.value);
  };
  wrap.append(rs, ss, ok);
  return wrap;
}

async function usAddRole(u, role, scope) {
  try {
    await SB.insert('app_user_role', [{ user_id: u.id, role_code: role, scope_org: scope }]);
    await usLoad();
    msg('#usMsg', 'ok', t('users.roleAdded', { email: u.email, role, scope }));
    if (isSelf(u)) await loadMe();
  } catch (e) { msg('#usMsg', 'err', e.message); }
}

async function usRemoveRole(u, l) {
  if (!confirm(t('users.confirmRemove', { email: u.email, role: l.role_code, scope: l.scope_org })))
    return;
  try {
    await SB.remove('app_user_role', `user_id=eq.${u.id}`
      + `&role_code=eq.${encodeURIComponent(l.role_code)}`
      + `&scope_org=eq.${encodeURIComponent(l.scope_org)}`);
    await usLoad();
    msg('#usMsg', 'ok', t('users.roleRemoved', { email: u.email, role: l.role_code, scope: l.scope_org }));
    if (isSelf(u)) await loadMe();
  } catch (e) { msg('#usMsg', 'err', e.message); }
}

async function usPatch(u, patch) {
  try {
    await SB.patch('app_user', `id=eq.${u.id}`, patch);
    Object.assign(u, patch);
    msg('#usMsg', 'ok', t('users.saved', { email: u.email }));
  } catch (e) { msg('#usMsg', 'err', e.message); }
  usRender();
}

/* ----------------------------------------------------- permission matrix */
async function pmLoad() {
  const out = $('#pmMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await secLookups();
    const [perms, links] = await Promise.all([SB.select('app_permission', 'select=*'),
      SB.select('app_user_role', 'select=role_code,scope_org,app_user(email,full_name,active)').catch(() => [])]);
    SEC.perms = perms;
    SEC.roleUsers = links.filter(l => l.app_user && l.app_user.active);
    msg(out, '', '');
    pmRender();
  } catch (e) { msg(out, 'err', e.message); }
}

function pmRender() {
  const tabs = $('#pmTabs');
  tabs.innerHTML = '';
  if (!SEC.mods.some(m => m.code === SEC.pmMod)) SEC.pmMod = (SEC.mods[0] || {}).code;
  for (const m of SEC.mods) {
    const b = el('button', { textContent: modName(m) });
    b.classList.toggle('on', m.code === SEC.pmMod);
    b.onclick = () => { SEC.pmMod = m.code; pmRender(); };
    tabs.append(b);
  }

  const admin = can('security', 'admin');
  const head = $('#pmGrid thead'), body = $('#pmGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, [
    el('th', { textContent: t('perms.col.role') }),
    ...PM_ACTS.map(a => el('th', { className: 'ck', textContent: t('perms.act.' + a) }))
  ]));
  let ent = null;
  for (const r of SEC.roles) {
    if (r.entity !== ent) {
      ent = r.entity;
      body.append(el('tr', { className: 'grp' },
        el('td', { colSpan: PM_ACTS.length + 1, textContent: t('perms.ent.' + ent) })));
    }
    const p = SEC.perms.find(x => x.role_code === r.code && x.module_code === SEC.pmMod) || {};
    // The System Admin's rights on this very screen cannot be switched off:
    // doing so would leave nobody able to switch them back on.
    const locked = r.code === 'SYS_ADMIN' && SEC.pmMod === 'security';
    // How many people hold the role; click to see who (user 25/09/2026).
    const who = (SEC.roleUsers || []).filter(l => l.role_code === r.code);
    const cnt = el('button', { className: 'ucount' + (who.length ? '' : ' zero'), type: 'button', textContent: String(who.length),
      title: who.length ? t('perms.users', { n: who.length }) : t('perms.nobody') });
    const tr = el('tr', {}, el('td', {}, [document.createTextNode(roleName(r) + ' '), cnt]));
    tr.firstChild.title = r.code;
    let open = null;
    cnt.onclick = () => {
      if (open) { open.remove(); open = null; cnt.classList.remove('on'); return; }
      if (!who.length) return;
      open = el('tr', { className: 'ulist' }, el('td', { colSpan: PM_ACTS.length + 1 }, who.map(l => el('span', { className: 'role' }, [
        el('b', { textContent: l.app_user.full_name || l.app_user.email }), document.createTextNode(' · ' + l.scope_org)]))));
      tr.after(open); cnt.classList.add('on');
    };
    for (const a of PM_ACTS) {
      const cb = el('input', { type: 'checkbox', checked: !!p['can_' + a],
                               disabled: !admin || locked,
                               title: locked ? t('perms.locked') : '' });
      cb.onchange = () => pmSet(r.code, SEC.pmMod, a, cb.checked, cb);
      tr.append(el('td', { className: 'ck' }, cb));
    }
    body.append(tr);
  }
}

/* One click, one write. Any right implies "view" (a screen you cannot open is
   a right you cannot use), and taking "view" away takes the rest with it. */
async function pmSet(role, mod, act, on, cb) {
  const row = SEC.perms.find(x => x.role_code === role && x.module_code === mod);
  const patch = { ['can_' + act]: on };
  if (on && act !== 'view') patch.can_view = true;
  if (!on && act === 'view') for (const a of PM_ACTS) patch['can_' + a] = false;
  try {
    if (row) await SB.patch('app_permission',
      `role_code=eq.${encodeURIComponent(role)}&module_code=eq.${encodeURIComponent(mod)}`, patch);
    else await SB.insert('app_permission', [Object.assign({ role_code: role, module_code: mod }, patch)]);
    if (row) Object.assign(row, patch);
    else SEC.perms.push(Object.assign({ role_code: role, module_code: mod,
      can_view: false, can_create: false, can_edit: false, can_approve: false, can_admin: false }, patch));
    pmRender();
    msg('#pmMsg', 'ok', t('perms.saved', { role, mod, act: t('perms.act.' + act),
                                          state: t(on ? 'perms.on' : 'perms.off') }));
    // The signed-in user's own rights may just have changed.
    if (ME && ME.roles.some(x => x.role === role)) await loadMe();
  } catch (e) {
    cb.checked = !on;
    msg('#pmMsg', 'err', e.message);
  }
}

/* --------------------------------------------------------------- audit */
function auInitPickers() {
  selFill($('#auTbl'), [['', t('audit.allTables')], ...AUDIT_TABLES.map(n => [n, n])]);
}

/* A date typed in the picker is a LOCAL day. The column is timestamptz, so the
   bounds go over as the UTC instants of local midnight — otherwise the first
   seven hours of every Vietnamese day would land on the wrong side. */
const localDayStart = (d, addDays = 0) => {
  const x = new Date(d + 'T00:00:00');
  x.setDate(x.getDate() + addDays);
  return x.toISOString();
};

const AU_CAP = 300;
async function auLoad() {
  auInitPickers();
  const out = $('#auMsg');
  msg(out, 'info', t('table.loading'));
  try {
    const q = ['select=*', 'order=at.desc', 'limit=' + AU_CAP];
    const tbl = $('#auTbl').value;
    if (tbl) q.push('tbl=eq.' + encodeURIComponent(tbl));
    const who = $('#auUser').value.trim().replace(/[(),*]/g, ' ');
    if (who) q.push('email=ilike.*' + encodeURIComponent(who) + '*');
    const f = $('#auFrom').value, to = $('#auTo').value;
    if (f) q.push('at=gte.' + encodeURIComponent(localDayStart(f)));
    if (to) q.push('at=lt.' + encodeURIComponent(localDayStart(to, 1)));
    const rows = await SB.select('app_audit', q.join('&'));
    msg(out, rows.length >= AU_CAP ? 'warn' : '',
        rows.length >= AU_CAP ? t('audit.capped', { n: fmtInt(AU_CAP) }) : '');
    auRender(rows);
  } catch (e) { msg(out, 'err', e.message); }
}

const auVal = v => {
  if (v === null || v === undefined || v === '') return '∅';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 70 ? s.slice(0, 69) + '…' : s;
};

/* An UPDATE shows each changed field as before → after. An INSERT or DELETE
   has no "before" (or no "after"), so it lists the filled fields instead — a
   few of them; the full row is one hover away. */
function auChanges(r) {
  const box = el('div', { className: 'chg' });
  if (r.op === 'UPDATE') {
    for (const k of Object.keys(r.new_data || {})) {
      const line = el('div');
      line.append(el('b', { textContent: k + ': ' }),
                  el('s', { textContent: auVal((r.old_data || {})[k]) }),
                  document.createTextNode(' → '),
                  el('ins', { textContent: auVal(r.new_data[k]) }));
      box.append(line);
    }
    return box;
  }
  const data = (r.op === 'INSERT' ? r.new_data : r.old_data) || {};
  const keys = Object.keys(data).filter(k => data[k] !== null && data[k] !== '');
  box.title = JSON.stringify(data, null, 1);
  for (const k of keys.slice(0, 6)) {
    const line = el('div');
    line.append(el('b', { textContent: k + ': ' }), document.createTextNode(auVal(data[k])));
    box.append(line);
  }
  if (keys.length > 6)
    box.append(el('div', { style: 'color:var(--dim)', textContent: t('audit.more', { n: keys.length - 6 }) }));
  return box;
}

function auRender(rows) {
  const head = $('#auGrid thead'), body = $('#auGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, ['audit.col.at', 'audit.col.user', 'audit.col.table', 'audit.col.op',
                            'audit.col.pk', 'audit.col.changes']
    .map(k => el('th', { textContent: t(k) }))));
  const fmtAt = fmtDateTime;
  for (const r of rows)
    body.append(el('tr', {}, [
      el('td', { textContent: fmtAt(r.at) }),
      el('td', { textContent: r.email || '' }),
      el('td', {}, el('code', { textContent: r.tbl })),
      el('td', { textContent: t('audit.op.' + r.op) }),
      el('td', {}, el('code', { textContent: r.pk || '' })),
      el('td', {}, auChanges(r))
    ]));
  if (!rows.length)
    body.append(el('tr', {}, el('td', { colSpan: 6, style: 'color:var(--dim);padding:14px',
      textContent: t('audit.none') })));
}

function initSecurity() {
  $('#usQ').oninput = () => usRender();
  $('#usInactive').onchange = () => usRender();
  $('#btnAuLoad').onclick = auLoad;
  $('#auUser').onkeydown = ev => { if (ev.key === 'Enter') auLoad(); };
  for (const id of ['#auTbl', '#auFrom', '#auTo']) $(id).onchange = auLoad;
}

/* ====================================================== PROJECT MANAGEMENT
   Phase 2: the annual CAPEX budget, the projects that spend it, importing both
   from the workbooks the team already keeps, and the report the approvers read.

   Two sources, two shapes:
     * the budget summary ("Capex Budget Summary - PHCL - YYYY.xlsx"): one sheet
       per submission round plus "Master Data", the approved list. The years do
       NOT share a column order — 2026 puts Project Code in A, the others in G,
       and 2023–24 label Impact "Column1" — so every column is found by its
       HEADER, never by its letter;
     * the per-project dossier (the FFE procurement workbook): its hidden data
       sheets Capex Data / Project Data / Vendor Data carry the dates, the
       contract value and the tender scores. A project usually has several
       copies ("assessed", "new PR PO", a copy under "reference"); the newest
       file wins.
   Entity is never stored: it follows the department up the am_org tree. */

const PM = {
  orgs: [], orgMap: new Map(), alias: new Map(),
  bud: { year: null, roundId: null, rounds: [], lines: [], yearRow: null, projByMain: new Map(), pick: null },
  prj: { rows: [], finalCodes: new Set(), pick: null, vendors: [] },
  dash: { year: null, lines: [], projects: [], years: [], yearRow: null },
  impBud: null, impDos: null
};
const PM_ENTITIES = ['SSP', 'CP', 'JVC'];
const PM_STATUS = ['pending', 'in_progress', 'completed', 'cancelled'];
const PM_RISK = ['Critical', 'High', 'Medium', 'Low'];
// Risk levels are stored in the workbook's English; shown in the UI language.
const pmRiskName = r => { if (!r) return ''; const k = 'pm.risk.' + r, s = t(k); return s === k ? r : s; };

/* ------------------------------------------------------------ codes, orgs */
const pmCode = s => String(s ?? '').normalize('NFC').toUpperCase().replace(/\s+/g, '')
  .replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
const PM_CODE_OK = /^[A-Z]+(?:\.[A-Z0-9]+)*\.(?:19|20)\d{2}(?:\.\d{1,2})?$/;
const pmMain = c => { const m = /^(.*\.(?:19|20)\d{2})(?:\.\d{1,2})?$/.exec(c || ''); return m ? m[1] : (c || ''); };
const pmYear = c => { const m = /\.((?:19|20)\d{2})$/.exec(pmMain(c)); return m ? +m[1] : null; };

async function pmLookups(force) {
  if (PM.orgs.length && !force) return;
  const [orgs, alias, fx] = await Promise.all([
    SB.select('am_org', 'select=code,name_vi,name_en,parent_code,is_department&order=code'),
    SB.select('am_org_alias', 'select=alias,code'),
    // Fixed rate per budget year, for the VND | USD switch. Missing table
    // (18_pm_budget.sql not run) must not break the asset screens.
    SB.select('pm_budget_year', 'select=year,fx_rate').catch(() => [])
  ]);
  MONEY.fx = new Map(fx.filter(r => Number(r.fx_rate) > 0).map(r => [Number(r.year), Number(r.fx_rate)]));
  PM.orgs = orgs;
  PM.orgMap = new Map(orgs.map(o => [o.code, o]));
  PM.alias = new Map(alias.map(a => [String(a.alias).toUpperCase(), a.code]));
}
// The old workbooks spell some departments differently (HKP for HKD, IT for
// ITD); am_org_alias already knows those spellings.
const pmDept = raw => {
  const c = String(raw ?? '').normalize('NFC').trim().toUpperCase();
  return PM.alias.get(c) || c;
};
function pmEntity(dept) {
  let o = PM.orgMap.get(dept), guard = 0;
  while (o && guard++ < 12) {
    if (o.code === 'SOF') return 'SSP';
    if (o.code === 'CP') return 'CP';
    if (o.code === 'JVC') return 'JVC';
    o = PM.orgMap.get(o.parent_code);
  }
  return '—';
}
const pmDeptKnown = d => PM.orgMap.has(d);

/* Mirrors the generated column in 18_pm_budget.sql, for rows not saved yet. */
function pmStatus(p) {
  if (p.status) return p.status;
  if (p.status_override) return p.status_override;
  const h = p.handover_date, base = p.purchase_date || p.approve_date || p.request_date || h;
  if (h && h >= base) return 'completed';
  if (p.purchase_date || p.approve_date) return 'in_progress';
  return 'pending';
}
// The milestones must run request <= approve <= purchase <= handover. Returns
// the first pair out of order ([earlier key, later key]) so the warning can say
// exactly which two dates to fix, or null.
const PM_DATE_SEQ = [['request_date', 'pm.col.request'], ['approve_date', 'pm.col.approve'],
                     ['purchase_date', 'pm.col.purchase'], ['handover_date', 'pm.col.handover']];
const pmDatesOddPair = p => {
  const seq = PM_DATE_SEQ.filter(([k]) => p[k]);
  for (let i = 1; i < seq.length; i++)
    for (let j = 0; j < i; j++) if (p[seq[i][0]] < p[seq[j][0]]) return [seq[j], seq[i]];
  return null;
};
const pmDatesOdd = p => !!pmDatesOddPair(p);
// "Purchased (03/04/2026) is before Approved (19/05/2026)".
const pmDatesMsg = p => { const x = pmDatesOddPair(p); return x && t('pm.flag.datesPair', {
  a: t(x[1][1]), da: fmtDate(p[x[1][0]]), b: t(x[0][1]), db: fmtDate(p[x[0][0]]) }); };

/* ---------------------------------------------------------------- format */
const pmLoc = () => (LANG === 'vi' ? 'vi-VN' : 'en-US');
// Millions of VND, the unit the budget is argued in ("6,667M").
/* Currency switch (VND | USD in the top bar, on the project screens). Money is
   stored in VND; USD is only a way of showing it, converted at the FIXED rate of
   the budget year in view (pm_budget_year.fx_rate) — the rate the budget itself
   is set in. A list spanning several years converts at the rate of the year in
   its filter (this year's when "all years"), so its totals still add up.
   MONEY.lock keeps an editable form in VND: prices are typed as quoted. */
const CUR_KEY = 'asset-intake.cur';
const MONEY = { code: 'VND', fx: new Map(), year: null, lock: false };
try { if (localStorage.getItem(CUR_KEY) === 'USD') MONEY.code = 'USD'; } catch {}
const curUsd = () => MONEY.code === 'USD' && !MONEY.lock;
const curCode = () => curUsd() ? 'USD' : 'VND';
const fxOf = y => MONEY.fx.get(Number(y)) || MONEY.fx.get(new Date().getFullYear()) || 26000;
const curV = v => (v == null || v === '' || !isFinite(v)) ? v : curUsd() ? Number(v) / fxOf(MONEY.year) : Number(v);
const fmtMoney = v => (v == null || v === '' || !isFinite(v)) ? '' : (curUsd() ? '$' : '') + fmtNum(Math.round(curV(v)));
// Screens where the switch shows: the ones that show money.
const CUR_VIEWS = ['pmdash', 'budget', 'projects', 'payments', 'doc', 'inbox'];
function curMark() {
  const seg = $('#curSeg');
  if (!seg) return;
  seg.hidden = !CUR_VIEWS.includes(VIEW);
  seg.title = t('cur.hint');
  for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.cur === MONEY.code);
}
function curSet(code) {
  if (code === MONEY.code) return;
  MONEY.code = code;
  try { localStorage.setItem(CUR_KEY, code); } catch {}
  curMark();
  // A document being edited is only redrawn, never re-read (unsaved typing
  // stays); the other screens reload as when opened.
  if (VIEW === 'doc' && WF.doc) wfRender();
  else showView(VIEW);
}
function initCur() {
  for (const b of $$('#curSeg button')) b.onclick = () => curSet(b.dataset.cur);
  curMark();
}
/* Short figures, written like the SSP BOD dashboard: "39.28 bn", "755.1 M",
   plain below a million; decimal mark per language (39,28 bn in Vietnamese). */
const fmtM = v => { if (v == null || !isFinite(v)) return '—';
  const c = curV(v), p = curUsd() ? '$' : '', a = Math.abs(c);
  const dec = (x, d) => x.toLocaleString(pmLoc(), { minimumFractionDigits: d, maximumFractionDigits: d });
  return p + (a >= 1e9 ? dec(c / 1e9, 2) + ' bn' : a >= 1e6 ? dec(c / 1e6, 1) + ' M' : fmtInt(Math.round(c))); };
const fmtPct = (v, d = 1) => (v == null || !isFinite(v)) ? '—'
  : (v * 100).toLocaleString(pmLoc(), { maximumFractionDigits: d, minimumFractionDigits: d }) + '%';
const pmSum = (rows, f) => rows.reduce((s, r) => s + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0);
const pmStatusChip = s => el('span', { className: 'st ' + s, textContent: t('pm.st.' + s) });
// A department by its full name in the language on screen (user 25/09/2026), the code when unknown.
const pmDeptName = code => { const o = PM.orgMap && PM.orgMap.get(code);
  return o ? ((LANG === 'vi' ? o.name_vi : o.name_en) || o.name_en || o.name_vi || code) : (code || ''); };
const pmMonthName = m => new Date(2020, m - 1, 1).toLocaleString(pmLoc(), { month: 'short' });

/* ------------------------------------------------------------ excel cells */
const hnorm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '');
const xlSerial = (y, m, d) => Date.UTC(y, m - 1, d) / 86400000 + 25569;
function xlDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && isFinite(v) && v > 20000 && v < 80000)
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);          // dd/mm/yyyy — the company's format
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;   // "Glass Washer" in a date column is not a date
}
function xlNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[\s,]/g, '').replace(/%$/, '');
  const n = Number(s);
  return s !== '' && isFinite(n) ? n : null;
}
/* A number TYPED on screen, in either way of writing it. The boxes show
   numbers in the UI language (vi "510.000.000" / "12,5"; en "510,000,000" /
   "12.5") and people type both, so the separator is read, not assumed:
   both "." and "," present → the last one is the decimal point; one kind used
   several times → thousands; used once with exactly three digits after it →
   thousands; otherwise the decimal point. (xlNum is for cells read from Excel.) */
function numIn(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[\s ]/g, '').replace(/%$/, '');
  if (s === '') return null;
  const dot = s.split('.').length - 1, com = s.split(',').length - 1;
  if (dot && com) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
  } else if (dot + com) {
    const sep = dot ? '.' : ',', n = dot || com;
    s = n > 1 || /^[-+]?\d{1,3}[.,]\d{3}$/.test(s) ? s.split(sep).join('') : s.replace(',', '.');
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}
// A formula that found nothing leaves 0 in a text column; that is "empty".
const xlText = v => {
  if (v == null || v === 0) return null;
  const s = String(v).normalize('NFC').trim();
  return s === '' ? null : s;
};
async function pmReadBook(file) {
  const buf = await file.arrayBuffer();
  return XLSX.read(buf, { type: 'array', cellDates: false });
}
const pmRows = ws => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });

async function pmSelectAll(table, query) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const page = await SB.select(table, `${query}&limit=1000&offset=${off}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/* ======================================================= import: budget */
const PM_BUD_COLS = {
  projectcode: 'project_code', currentprojectcode: 'current_code', category: 'category',
  departmentcode: 'dept_code', departmentname: 'dept_name', requestdate: 'request_date',
  investmenttype: 'investment_type', reason: 'reason', projectname: 'name',
  areacategory: 'area_category', areacatergory: 'area_category',
  estimatedvalue: 'estimated_value', totalestimatedvalue: 'estimated_value',
  approvedbygm: 'gm_approved', posibility: 'possibility', possibility: 'possibility',
  // 2023–24 files head the Impact column "Column1" — it sits between
  // Posibility and Assessment, and Assessment = Posibility × it.
  impact: 'impact', column1: 'impact',
  assessment: 'assessment', risklevel: 'risk_level',
  timetostart: 'start_date', timetocomplete: 'end_date', duration: 'duration_days',
  assetitem: 'asset_item', location: 'location', rationale: 'rationale',
  technicalstandard: 'tech_standard', quantity: 'quantity', unitprice: 'unit_price', amount: 'amount',
  reference: 'reference', previousprojectcode: 'previous_code',
  previousprojectcodeifapplicable: 'previous_code', supplier: 'supplier',
  details: 'details', detailsdeliverypaymentetc: 'details',
  projectcategory: 'project_category', color: 'color_status',
  purchasingincharge: 'purchasing_in_charge', note: 'note'
};
const PM_LINE_TEXT = ['project_code', 'current_code', 'category', 'dept_code', 'dept_name',
  'investment_type', 'reason', 'name', 'risk_level', 'asset_item', 'location', 'rationale',
  'tech_standard', 'reference', 'previous_code', 'supplier', 'details', 'project_category',
  'area_category', 'color_status', 'purchasing_in_charge', 'owner_note', 'dept_response', 'note'];
const PM_LINE_NUM = ['estimated_value', 'gm_approved', 'possibility', 'impact', 'assessment',
  'duration_days', 'quantity', 'unit_price', 'amount'];
const PM_LINE_DATE = ['request_date', 'start_date', 'end_date'];
const PM_MONTHS = Array.from({ length: 12 }, (_, i) => 'm' + String(i + 1).padStart(2, '0'));
const pmBlankLine = () => Object.fromEntries(
  [...PM_LINE_TEXT, ...PM_LINE_NUM, ...PM_LINE_DATE, ...PM_MONTHS].map(k => [k, null]));

function pmParseBudgetSheet(name, ws, hidden, fileYear, fileDate) {
  const rows = pmRows(ws);
  let hr = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const n = (rows[i] || []).map(hnorm);
    if (n.includes('projectcode')
        && (n.includes('estimatedvalue') || n.includes('totalestimatedvalue') || n.includes('projectname'))) {
      hr = i; break;
    }
  }
  if (hr < 0) return null;
  const head = rows[hr] || [];
  const col = {};                              // field -> column index (first wins)
  head.forEach((h, i) => { const f = PM_BUD_COLS[hnorm(h)]; if (f && col[f] === undefined) col[f] = i; });
  if (col.project_code === undefined) return null;

  const raw = [];
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = pmCode(r[col.project_code]);
    if (!code || !/(?:19|20)\d{2}/.test(code)) continue;       // blank, subtotal, note rows
    raw.push({ r, code });
  }
  if (!raw.length) return null;
  // A sheet belongs to the year most of its codes carry ("Capex 2024" sits in
  // the 2025 workbook and is a 2024 list).
  const tally = new Map();
  for (const { code } of raw) { const y = pmYear(code); if (y) tally.set(y, (tally.get(y) || 0) + 1); }
  const year = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] || fileYear;

  // Monthly phasing: header cells that are dates inside that year.
  const phase = {};                            // column index -> 'mNN'
  const lo = xlSerial(year, 1, 1), hi = xlSerial(year, 12, 31);
  head.forEach((h, i) => {
    if (typeof h === 'number' && h >= lo && h <= hi) {
      const m = new Date(Math.round((h - 25569) * 86400000)).getUTCMonth() + 1;
      phase[i] = PM_MONTHS[m - 1];
    }
  });
  // The owner's question and the department's answer ride in the unheaded
  // columns straight after the phasing block (AP / AQ in the 2026 sheet).
  const phaseCols = Object.keys(phase).map(Number);
  let noteCols = [];
  if (phaseCols.length) {
    const after = Math.max(...phaseCols) + 1;
    for (let i = after; i < after + 4 && noteCols.length < 2; i++)
      if (head[i] == null || String(head[i]).trim() === '') noteCols.push(i);
  }
  // SSP cap as written: "Total CAPEX budget - 3% FF&E Reserve" + the number beside it.
  let cap = null;
  for (let i = 0; i < hr && cap == null; i++) {
    const r = rows[i] || [];
    const at = r.findIndex(c => hnorm(c).includes('ffereserve'));
    if (at >= 0) for (let j = at + 1; j < r.length; j++) { const n = xlNum(r[j]); if (n && n > 1e6) { cap = n; break; } }
  }

  const unknownDept = new Set();
  let badCode = 0;
  const lines = raw.map(({ r, code }) => {
    const l = pmBlankLine();
    for (const f of PM_LINE_TEXT) if (col[f] !== undefined) l[f] = xlText(r[col[f]]);
    for (const f of PM_LINE_NUM) if (col[f] !== undefined) l[f] = xlNum(r[col[f]]);
    for (const f of PM_LINE_DATE) if (col[f] !== undefined) l[f] = xlDate(r[col[f]]);
    l.project_code = code;
    if (l.current_code) l.current_code = pmCode(l.current_code);
    if (l.previous_code) l.previous_code = pmCode(l.previous_code);
    if (l.dept_code) { l.dept_code = pmDept(l.dept_code); if (!pmDeptKnown(l.dept_code)) unknownDept.add(l.dept_code); }
    if (l.duration_days != null) l.duration_days = Math.round(l.duration_days);
    if (l.estimated_value == null) l.estimated_value = l.amount;
    if (!PM_CODE_OK.test(code)) badCode++;
    for (const [ci, m] of Object.entries(phase)) l[m] = xlNum(r[ci]);
    // A plan marked with 1 / x per month (not amounts) is spread evenly.
    const marks = PM_MONTHS.filter(m => l[m] != null && l[m] !== 0);
    if (marks.length && marks.every(m => l[m] > 0 && l[m] <= 1) && l.estimated_value) {
      for (const m of marks) l[m] = l.estimated_value / marks.length;
    }
    if (noteCols[0] !== undefined) l.owner_note = xlText(r[noteCols[0]]);
    if (noteCols[1] !== undefined) l.dept_response = xlText(r[noteCols[1]]);
    return l;
  });

  const dm = /(20\d{2})(\d{2})(\d{2})/.exec(name);
  const isFinal = hnorm(name) === 'masterdata';
  return {
    name, hidden, year, label: name.trim(), is_final: isFinal,
    round_date: dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : (isFinal ? fileDate : null),
    lines, cap, headerRow: hr + 1, phased: phaseCols.length > 0,
    total: pmSum(lines, 'estimated_value'), unknownDept: [...unknownDept], badCode,
    // Pre-ticked: what the team can see, and the dated submission snapshots.
    pick: !hidden || !!dm
  };
}

async function piBudRead() {
  const out = $('#piBudOut');
  const f = $('#piBudFile').files[0];
  $('#btnPiBudGo').disabled = true;
  if (!f) return msg(out, 'err', t('pm.imp.pickFile'));
  msg(out, 'info', t('pm.imp.reading'));
  try {
    await pmLookups();
    const wb = await pmReadBook(f);
    const fy = +(/(20\d{2})(?!.*20\d{2})/.exec(f.name) || [])[1] || new Date().getFullYear();
    const fd = new Date(f.lastModified).toISOString().slice(0, 10);
    const hid = (wb.Workbook && wb.Workbook.Sheets) || [];
    const found = [];
    wb.SheetNames.forEach((n, i) => {
      const c = pmParseBudgetSheet(n, wb.Sheets[n], !!(hid[i] && hid[i].Hidden), fy, fd);
      if (c) found.push(c);
    });
    PM.impBud = { file: f, sheets: found };
    piBudRender();
  } catch (e) { msg(out, 'err', e.message); }
}

function piBudRender() {
  const out = $('#piBudOut');
  const st = PM.impBud;
  out.innerHTML = '';
  if (!st || !st.sheets.length) return msg(out, 'warn', t('pm.imp.noSheets'));
  out.append(el('div', { className: 'msg info',
    textContent: t('pm.imp.budFound', { n: st.sheets.length, file: st.file.name }) }));
  const tb = el('table', { className: 'pmsheets' });
  tb.append(el('tr', {}, ['', 'pm.imp.col.sheet', 'pm.imp.col.year', 'pm.imp.col.date',
    'pm.imp.col.lines', 'pm.imp.col.total', 'pm.imp.col.notes']
    .map((k, i) => el('th', { className: [4, 5].includes(i) ? 'num' : '', textContent: k ? t(k) : '' }))));
  for (const s of st.sheets) {
    const cb = el('input', { type: 'checkbox', checked: s.pick });
    cb.onchange = () => { s.pick = cb.checked; $('#btnPiBudGo').disabled = !st.sheets.some(x => x.pick); };
    const notes = [];
    if (s.is_final) notes.push(t('pm.imp.isFinal'));
    if (s.hidden) notes.push(t('pm.imp.hidden'));
    if (s.phased) notes.push(t('pm.imp.phased'));
    if (s.cap) notes.push(t('pm.imp.cap', { v: fmtM(s.cap) }));
    if (s.unknownDept.length) notes.push(t('pm.imp.unknownDept', { list: s.unknownDept.join(', ') }));
    if (s.badCode) notes.push(t('pm.imp.badCode', { n: s.badCode }));
    tb.append(el('tr', {}, [
      el('td', {}, cb),
      el('td', {}, el('b', { textContent: s.label })),
      el('td', { textContent: String(s.year) }),
      el('td', { textContent: s.round_date ? fmtDate(s.round_date) : '' }),
      el('td', { className: 'num', textContent: fmtInt(s.lines.length) }),
      el('td', { className: 'num', textContent: fmtNum(Math.round(s.total)) }),
      el('td', { style: 'white-space:normal', textContent: notes.join(' · ') })
    ]));
  }
  out.append(el('div', { className: 'wrap', style: 'margin-top:8px' }, tb));
  $('#btnPiBudGo').disabled = !st.sheets.some(x => x.pick);
}

/* One round = one call to pm_import_round, which runs as a single transaction:
   the same (year, label) again REPLACES that round's lines, and a dropped
   connection halfway leaves the old lines in place instead of none at all.
   The cap from the file only fills an empty cap, never overwrites one. */
async function pmWriteRound(s, file) {
  return SB.rpc('pm_import_round', {
    p_round: { year: s.year, label: s.label, round_date: s.round_date, is_final: s.is_final,
               source_file: file.name, source_sheet: s.name },
    p_lines: s.lines.map((l, i) => Object.assign({}, l, { line_no: i + 1 })),
    p_cap: s.cap || null
  });
}

async function piBudGo() {
  const out = $('#piBudOut');
  const st = PM.impBud;
  const pick = (st && st.sheets.filter(s => s.pick)) || [];
  if (!pick.length) return;
  $('#btnPiBudGo').disabled = true;
  let done = 0;
  try {
    for (const s of pick) {
      msg(out, 'info', t('pm.imp.writing', { sheet: s.label, i: done + 1, n: pick.length }));
      await pmWriteRound(s, st.file);
      done++;
    }
    msg(out, 'ok', t('pm.imp.budDone', { n: done, lines: fmtInt(pmSum(pick, s => s.lines.length)) }));
    PM.bud.year = null;                      // the budget screen re-reads on next open
  } catch (e) {
    msg(out, 'err', t('pm.imp.failAt', { sheet: (pick[done] || {}).label, err: e.message, n: done }));
  } finally { $('#btnPiBudGo').disabled = false; }
}

/* ===================================================== import: dossiers */
const PM_CD = { category: 'category', departmentcode: 'dept_code', investmenttype: 'investment_type',
  reason: 'reason', budget: 'budget', projecttype: 'consult', procurementtype: 'procurement_type',
  projectcode: 'main_code', subprojectcode: 'code', projectname: 'name',
  // "Completion" in Capex Data is the sub-project's SHARE of the main project
  // (the PR guide: "sub-project no. and its percentage"), not progress.
  completion: 'share_pct', estimatedvalue: 'estimated_value',
  posibility: 'possibility', possibility: 'possibility', impact: 'impact', assessment: 'assessment',
  risklevel: 'risk_level', riskcategory: 'risk_category', assetitem: 'asset_item', location: 'location',
  rationale: 'rationale', technicalstandard: 'tech_standard', reference: 'reference',
  previousprojectcode: 'previous_code', supplier: 'proposed_supplier' };
const PM_PD = { departmentcode: 'dept_code', projecttype: 'project_type', reason: 'reason',
  projectcode: 'main_code', subprojectcode: 'code', projectname: 'name', risklevel: 'risk_level',
  assetitem: 'asset_item', requestdate: 'request_date', assessdate: 'assess_date',
  approvedate: 'approve_date', purchasedate: 'purchase_date', handoverdate: 'handover_date',
  location: 'location', contractvalue: 'contract_value', contractvolume: 'contract_volume',
  chosenvendor: 'chosen_vendor', overallevalution: 'evaluation', overallevaluation: 'evaluation',
  comment: 'comment' };
const PM_VD = { checkdate: 'check_date', projectcode: 'main_code', subprojectcode: 'code',
  vendor: 'vendor_name', totalamount: 'total_amount', abilityexperience: 'ability',
  techniques: 'technique', finance: 'finance', totalscore: 'total_score', comment: 'comment' };
// Fields only Project Data knows: they overrule Capex Data.
const PM_PD_OWN = ['project_type', 'request_date', 'assess_date', 'approve_date', 'purchase_date',
  'handover_date', 'contract_value', 'contract_volume', 'chosen_vendor', 'evaluation', 'comment'];
const PM_DATES = ['request_date', 'assess_date', 'approve_date', 'purchase_date', 'handover_date',
  'check_date', 'planned_start', 'planned_end'];
const PM_NUMS = ['share_pct', 'estimated_value', 'possibility', 'impact', 'assessment',
  'contract_value', 'contract_volume', 'total_amount', 'ability', 'technique', 'finance', 'total_score'];
const PM_PROJ_FIELDS = ['code', 'main_code', 'dept_code', 'name', 'category', 'budgeted',
  'investment_type', 'project_type', 'procurement_type', 'share_pct', 'estimated_value',
  'possibility', 'impact', 'assessment', 'risk_level', 'risk_category', 'project_category',
  'area_category', 'asset_item', 'location', 'reason', 'rationale', 'tech_standard', 'reference',
  'previous_code', 'proposed_supplier', 'planned_start', 'planned_end', 'request_date',
  'assess_date', 'approve_date', 'purchase_date', 'handover_date', 'contract_value',
  'contract_volume', 'chosen_vendor', 'evaluation', 'comment', 'source', 'source_file',
  'source_modified'];

function pmSheetRecords(ws, map) {
  if (!ws) return [];
  const rows = pmRows(ws);
  let hr = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const n = (rows[i] || []).map(hnorm);
    if (n.includes('subprojectcode') || n.includes('projectcode')) { hr = i; break; }
  }
  if (hr < 0) return [];
  const col = {};
  (rows[hr] || []).forEach((h, i) => { const f = map[hnorm(h)]; if (f && col[f] === undefined) col[f] = i; });
  const out = [];
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = pmCode(r[col.code] ?? r[col.main_code]);
    if (!code || !/(?:19|20)\d{2}/.test(code)) continue;
    const o = {};
    for (const [f, ci] of Object.entries(col)) {
      const v = r[ci];
      o[f] = PM_DATES.includes(f) ? xlDate(v) : PM_NUMS.includes(f) ? xlNum(v) : xlText(v);
    }
    o.code = code;
    out.push(o);
  }
  return out;
}

async function piDosRead() {
  const out = $('#piDosOut');
  const files = [...$('#piDosFile').files];
  $('#btnPiDosGo').disabled = true;
  if (!files.length) return msg(out, 'err', t('pm.imp.pickFile'));
  try {
    await pmLookups();
    const byCode = new Map();
    const skipped = [];
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      msg(out, 'info', t('pm.imp.readingN', { i: fi + 1, n: files.length, file: f.name }));
      let wb;
      try { wb = await pmReadBook(f); } catch { skipped.push(f.name); continue; }
      if (!wb.Sheets['Project Data'] && !wb.Sheets['Capex Data']) { skipped.push(f.name); continue; }
      const cd = pmSheetRecords(wb.Sheets['Capex Data'], PM_CD);
      const pd = pmSheetRecords(wb.Sheets['Project Data'], PM_PD);
      const vd = pmSheetRecords(wb.Sheets['Vendor Data'], PM_VD);
      const codes = new Set([...cd, ...pd].map(r => r.code));
      for (const code of codes) {
        const c = cd.find(r => r.code === code) || {};
        const p = pd.find(r => r.code === code) || {};
        const rec = Object.assign({}, c);
        for (const [k, v] of Object.entries(p))
          if (v != null && (rec[k] == null || PM_PD_OWN.includes(k))) rec[k] = v;
        rec.code = code;
        rec.main_code = PM_CODE_OK.test(pmCode(rec.main_code)) ? pmMain(pmCode(rec.main_code)) : pmMain(code);
        rec.dept_code = pmDept(rec.dept_code || (code.split('.')[1] || ''));
        rec.budgeted = !/unbudget/i.test(String(c.budget || ''));
        if (!rec.project_type && c.consult) rec.project_type = c.consult;
        if (rec.share_pct != null && rec.share_pct > 1) rec.share_pct = rec.share_pct / 100;
        delete rec.budget; delete rec.consult;
        const scores = vd.filter(v => v.code === code || (!v.code && v.main_code === rec.main_code));
        const cand = { rec, scores, file: f.name, modified: f.lastModified, dupes: [] };
        const prev = byCode.get(code);
        if (!prev) byCode.set(code, cand);
        else if (f.lastModified > prev.modified) { cand.dupes = [...prev.dupes, prev.file]; byCode.set(code, cand); }
        else prev.dupes.push(f.name);
      }
    }
    PM.impDos = { items: [...byCode.values()].sort((a, b) => a.rec.code.localeCompare(b.rec.code)),
                  files: files.length, skipped };
    piDosRender();
  } catch (e) { msg(out, 'err', e.message); }
}

function piDosRender() {
  const out = $('#piDosOut');
  const st = PM.impDos;
  out.innerHTML = '';
  if (!st || !st.items.length) return msg(out, 'warn', t('pm.imp.noDossier'));
  const dupes = pmSum(st.items, i => i.dupes.length);
  out.append(el('div', { className: 'msg info', textContent:
    t('pm.imp.dosFound', { n: st.items.length, files: st.files, dupes, skipped: st.skipped.length }) }));
  const tb = el('table');
  tb.append(el('tr', {}, ['pm.col.code', 'pm.col.name', 'pm.col.dept', 'pm.col.budgeted',
    'pm.col.contract', 'pm.col.vendor', 'pm.col.status', 'pm.imp.col.file', 'pm.imp.col.notes']
    .map((k, i) => el('th', { className: i === 4 ? 'num' : '', textContent: t(k) }))));
  for (const it of st.items) {
    const r = it.rec, notes = [];
    if (!PM_CODE_OK.test(r.code)) notes.push(t('pm.flag.code'));
    if (!pmDeptKnown(r.dept_code)) notes.push(t('pm.flag.dept', { d: r.dept_code }));
    if (pmDatesOdd(r)) notes.push(pmDatesMsg(r));
    if (it.dupes.length) notes.push(t('pm.imp.dupes', { n: it.dupes.length }));
    tb.append(el('tr', {}, [
      el('td', {}, el('code', { textContent: r.code })),
      el('td', { textContent: r.name || '' }),
      el('td', { textContent: r.dept_code || '' }),
      el('td', { textContent: r.budgeted ? '✔' : '—' }),
      el('td', { className: 'num', textContent: r.contract_value != null ? fmtNum(r.contract_value) : '' }),
      el('td', { textContent: r.chosen_vendor || '' }),
      el('td', {}, pmStatusChip(pmStatus(r))),
      el('td', { title: it.dupes.join('\n'), textContent: `${it.file} · ${fmtDate(new Date(it.modified).toISOString().slice(0, 10))}` }),
      el('td', { style: 'white-space:normal', textContent: notes.join(' · ') })
    ]));
  }
  out.append(el('div', { className: 'wrap', style: 'margin-top:8px' }, tb));
  $('#btnPiDosGo').disabled = false;
}

const pmProjRow = (rec, extra) => {
  const o = {};
  for (const f of PM_PROJ_FIELDS) o[f] = rec[f] === undefined ? null : rec[f];
  return Object.assign(o, extra);
};

async function piDosGo() {
  const out = $('#piDosOut');
  const st = PM.impDos;
  if (!st || !st.items.length) return;
  $('#btnPiDosGo').disabled = true;
  const rows = st.items.map(it => pmProjRow(it.rec, {
    source: 'dossier', source_file: it.file, source_modified: new Date(it.modified).toISOString(),
    budgeted: it.rec.budgeted
  }));
  const failed = [];
  const upsert = batch => SB.call('pm_project?on_conflict=code', {
    method: 'POST', headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(batch) });
  try {
    for (let i = 0; i < rows.length; i += 50) {
      msg(out, 'info', t('pm.imp.writingN', { i: Math.min(i + 50, rows.length), n: rows.length }));
      const batch = rows.slice(i, i + 50);
      // One bad row (an unbudgeted project re-using a budgeted code) would sink
      // the whole batch; retry row by row so the rest still lands.
      try { await upsert(batch); }
      catch { for (const r of batch) { try { await upsert([r]); } catch (e) { failed.push(`${r.code}: ${e.message}`); } } }
    }
    const ok = st.items.filter(it => !failed.some(f => f.startsWith(it.rec.code + ':')));
    // Scores are swapped per batch inside pm_replace_scores, in one transaction,
    // so an interrupted import never leaves a project with no scores.
    for (let i = 0; i < ok.length; i += 40) {
      const part = ok.slice(i, i + 40);
      const sc = part.flatMap(it => it.scores.filter(s => s.vendor_name).map(s => ({
        project_code: it.rec.code, vendor_name: s.vendor_name, check_date: s.check_date,
        total_amount: s.total_amount, ability: s.ability, technique: s.technique,
        finance: s.finance, total_score: s.total_score, comment: s.comment,
        chosen: !!it.rec.chosen_vendor && hnorm(s.vendor_name) === hnorm(it.rec.chosen_vendor)
      })));
      await SB.rpc('pm_replace_scores', { p_codes: part.map(it => it.rec.code), p_scores: sc });
    }
    // Logged for the upload checklist on Data sources (loaded_by marks the dossier import;
    // the log only takes the kinds of 07_data_source.sql). No right to write the log: never mind.
    if (ok.length) {
      try {
        await SB.insert('am_data_source', [{ table_name: 'pm_project', source_file: [...new Set(ok.map(it => it.file))].slice(0, 20).join('; ').slice(0, 900),
          source_kind: 'manual', rows_loaded: ok.length, loaded_by: SRC_DOSSIER }]);
      } catch {}
    }
    msg(out, failed.length ? 'warn' : 'ok',
        t('pm.imp.dosDone', { n: ok.length }) + (failed.length ? '\n' + t('pm.imp.dosFailed', { n: failed.length }) + '\n' + failed.join('\n') : ''));
    srcChecklist();
  } catch (e) { msg(out, 'err', e.message); }
  finally { $('#btnPiDosGo').disabled = false; }
}

/* ============================================================== budget */
async function pbLoad() {
  const out = $('#pbMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    const [years, rounds] = await Promise.all([
      SB.select('pm_budget_year', 'select=*&order=year.desc'),
      SB.select('pm_budget_round', 'select=*&order=year.desc,is_final.desc,round_date.desc.nullslast')
    ]);
    PM.bud.rounds = rounds;
    PM.bud.years = years;
    const ys = [...new Set([...years.map(y => y.year), ...rounds.map(r => r.year)])].sort((a, b) => b - a);
    const ySel = $('#pbYear');
    ySel.innerHTML = '';
    for (const y of ys) ySel.append(el('option', { value: y, textContent: y }));
    if (!ys.length) {
      msg(out, 'info', t('pm.bud.empty'));
      $('#pbGrid thead').innerHTML = ''; $('#pbGrid tbody').innerHTML = ''; $('#pbYearBox').innerHTML = '';
      return;
    }
    const want = ys.includes(PM.bud.year) ? PM.bud.year
      : (rounds.find(r => r.is_final) || {}).year || ys[0];
    ySel.value = want;
    await pbYearChanged(true);
    msg(out, '', '');
  } catch (e) { msg(out, 'err', e.message); }
}

async function pbYearChanged(keepRound) {
  const y = +$('#pbYear').value;
  PM.bud.year = y;
  PM.bud.yearRow = PM.bud.years.find(r => r.year === y) || { year: y };
  const rs = PM.bud.rounds.filter(r => r.year === y);
  const rSel = $('#pbRound');
  rSel.innerHTML = '';
  for (const r of rs)
    rSel.append(el('option', { value: r.id, textContent:
      // No sheet name (user 25/09/2026): the date says which round it is.
      `${r.is_final ? '★ ' : ''}${r.round_date ? fmtDate(r.round_date) : r.label} · ${fmtInt(r.line_count)} · ${fmtM(Number(r.total_value))}` }));
  const keep = keepRound && rs.some(r => r.id === PM.bud.roundId) ? PM.bud.roundId
    : (rs.find(r => r.is_final) || rs[0] || {}).id;
  if (keep) rSel.value = keep;
  await pbRoundChanged();
}

async function pbRoundChanged() {
  const id = +$('#pbRound').value;
  PM.bud.roundId = id || null;
  PM.bud.pick = null;
  $('#pbDrawer').hidden = true; $('#pbDetail').innerHTML = '';
  const [lines, projects] = await Promise.all([
    id ? pmSelectAll('pm_budget_line', `select=*&round_id=eq.${id}&order=line_no`) : [],
    pmSelectAll('pm_project', `select=code,main_code,status,contract_value&year=eq.${PM.bud.year}`)
  ]);
  PM.bud.lines = lines;
  // One status per budget line: completed only when every sub-project is.
  const by = new Map();
  for (const p of projects) {
    const a = by.get(p.main_code) || [];
    a.push(p); by.set(p.main_code, a);
  }
  PM.bud.projByMain = new Map([...by].map(([k, ps]) => [k,
    ps.every(p => p.status === 'completed') ? 'completed'
    : ps.every(p => p.status === 'cancelled') ? 'cancelled'
    : ps.some(p => p.status !== 'pending') ? 'in_progress' : 'pending']));
  const depts = [...new Set(lines.map(l => l.dept_code).filter(Boolean))].sort();
  msSetup('pbEnt', PM_ENTITIES.map(e => ({ v: e, t: `${e} — ${t('perms.ent.' + e)}` })));
  msSetup('pbDept', depts.map(d => ({ v: d, t: d })));
  const risks = [...new Set(lines.map(l => l.risk_level).filter(Boolean))];
  msSetup('pbRisk', PM_RISK.filter(r => risks.includes(r)).concat(risks.filter(r => !PM_RISK.includes(r)))
    .map(r => ({ v: r, t: pmRiskName(r) })));
  pbRender();
}

function pbFiltered() {
  const ent = msValues('pbEnt'), dep = msValues('pbDept'), risk = msValues('pbRisk');
  const q = hnorm($('#pbQ').value);
  return PM.bud.lines.filter(l =>
    (!ent.length || ent.includes(pmEntity(l.dept_code)))
    && (!dep.length || dep.includes(l.dept_code))
    && (!risk.length || risk.includes(l.risk_level))
    && (!q || hnorm(`${l.project_code} ${l.name} ${l.asset_item} ${l.dept_code}`).includes(q)));
}

function pbYearBox() {
  const box = $('#pbYearBox');
  box.innerHTML = '';
  const y = PM.bud.yearRow || {};
  const round = PM.bud.rounds.find(r => r.id === PM.bud.roundId);
  const lines = PM.bud.lines;
  const byEnt = e => pmSum(lines.filter(l => pmEntity(l.dept_code) === e), 'estimated_value');
  const cap = y.ssp_cap != null ? Number(y.ssp_cap)
    : (y.ssp_revenue != null ? Number(y.ssp_revenue) * Number(y.reserve_pct || 3) / 100 : null);
  const ssp = byEnt('SSP');
  const stats = el('div', { className: 'stats' });
  const tile = (label, value, sub, meter) => {
    const d = el('div', { className: 'stat' }, [
      el('span', { className: 'sl', textContent: label }),
      el('span', { className: 'sv', textContent: value })]);
    if (sub) d.append(el('span', { className: 'sd', textContent: sub }));
    if (meter != null) {
      const m = el('div', { className: 'meter' + (meter > 1 ? ' over' : '') },
                   el('i', { style: `width:${Math.min(100, Math.max(0, meter * 100))}%` }));
      d.append(m);
    }
    return d;
  };
  stats.append(tile(t('pm.bud.total'), fmtM(pmSum(lines, 'estimated_value')),
    t('pm.bud.lines', { n: fmtInt(lines.length) })));
  stats.append(tile(t('pm.bud.sspVsCap'), fmtM(ssp),
    cap ? t('pm.bud.ofCap', { cap: fmtM(cap), pct: fmtPct(ssp / cap), left: fmtM(cap - ssp) }) : t('pm.bud.noCap'),
    cap ? ssp / cap : null));
  stats.append(tile(t('pm.bud.cp'), fmtM(byEnt('CP')), t('pm.bud.noCapNeedsApproval')));
  stats.append(tile(t('pm.bud.jvc'), fmtM(byEnt('JVC')), t('pm.bud.noCapNeedsApproval')));
  box.append(stats);

  // The year's FX, reserve and caps are set on the Settings screen (user 25/09/2026).
  // Only the round's buttons, on the right, no card or source line (feedback 25/09/2026);
  // where the round came from stays in the tooltip.
  const row = el('div', { className: 'pbacts' });
  const acts = el('div', { className: 'acts' });
  if (round) row.title = t('pm.bud.roundInfo', { file: round.source_file || '—',
    at: (round.imported_at || '').slice(0, 10) ? fmtDate(round.imported_at.slice(0, 10)) : '—', by: round.imported_by || '—' });
  if (round && !round.is_final && can('budget', 'create')) {
    const fin = el('button', { className: 'btn', textContent: t('pm.bud.makeFinal') });
    fin.onclick = () => pbMakeFinal(round);
    acts.append(fin);
  }
  if (round && can('budget', 'admin')) {
    const del = el('button', { className: 'btn danger', textContent: t('pm.bud.delRound') });
    del.onclick = () => pbDeleteRound(round);
    acts.append(del);
  }
  const xl = el('button', { className: 'btn', textContent: t('reg.xlsx') });
  xl.onclick = pbExport;
  acts.append(xl);
  row.append(acts);
  box.append(row);
}

async function pbMakeFinal(round) {
  if (!confirm(t('pm.bud.confirmFinal', { label: round.label, y: round.year }))) return;
  try {
    await SB.patch('pm_budget_round', `year=eq.${round.year}&is_final=eq.true`, { is_final: false });
    await SB.patch('pm_budget_round', `id=eq.${round.id}`, { is_final: true });
    await pbLoad();
    msg('#pbMsg', 'ok', t('pm.bud.finalSet', { label: round.label }));
  } catch (e) { msg('#pbMsg', 'err', e.message); }
}

async function pbDeleteRound(round) {
  if (!confirm(t('pm.bud.confirmDel', { label: round.label, n: fmtInt(round.line_count) }))) return;
  try {
    await SB.remove('pm_budget_round', `id=eq.${round.id}`);
    PM.bud.roundId = null;
    await pbLoad();
    msg('#pbMsg', 'ok', t('pm.bud.deleted', { label: round.label }));
  } catch (e) { msg('#pbMsg', 'err', e.message); }
}

function pbRender() {
  MONEY.year = PM.bud.year;
  pbYearBox();
  const head = $('#pbGrid thead'), body = $('#pbGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  const rows = pbFiltered();
  const phase = $('#pbPhase').checked;
  const qa = PM.bud.lines.some(l => l.owner_note || l.dept_response);
  // Status first; the department by name (no entity column); quantity instead of the area category (user 25/09/2026).
  const cols = [['#', 'idx'], ['pm.col.status'], ['pm.col.code'], ['pm.col.dept'], ['pm.col.name'],
    ['pm.col.projCat'], ['pm.col.invest'], ['pm.col.risk'], ['pm.f.qty', 'num'],
    ['pm.col.estimate', 'num'], ['pm.col.start'], ['pm.col.end']];
  if (phase) for (let m = 1; m <= 12; m++) cols.push([null, 'num', pmMonthName(m)]);
  if (qa) cols.push(['pm.col.ownerNote'], ['pm.col.deptResp']);
  head.append(el('tr', {}, cols.map(([k, c, txt]) => el('th', {
    className: c === 'idx' ? 'num idx' : (c || ''), textContent: txt || (k === '#' ? '#' : t(k)) }))));
  const clip = (s, n) => !s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s;
  rows.forEach((l, i) => {
    const st = PM.bud.projByMain.get(l.project_code) || PM.bud.projByMain.get(l.current_code) || null;
    const tr = el('tr', { className: PM.bud.pick === l.id ? 'pick' : '' });
    const deptTd = el('td', { textContent: pmDeptName(l.dept_code), title: l.dept_code || '' });
    if (l.dept_code && !pmDeptKnown(l.dept_code))
      deptTd.append(el('span', { className: 'flag', textContent: '⚠', title: t('pm.flag.dept', { d: l.dept_code }) }));
    tr.append(
      el('td', { className: 'num idx', textContent: fmtInt(i + 1) }),
      // "Not started" in the same pill as the others, in grey (user 25/09/2026).
      el('td', { className: 'nw' }, st ? pmStatusChip(st) : el('span', { className: 'st notstarted', textContent: t('pm.st.notStarted') })),
      el('td', {}, el('code', { textContent: l.project_code })),
      deptTd,
      el('td', { textContent: l.name || '', title: l.reason || '' }),
      el('td', { textContent: l.project_category || '' }),
      el('td', { textContent: l.investment_type || '' }),
      el('td', { textContent: pmRiskName(l.risk_level) }),
      el('td', { className: 'num', textContent: l.quantity != null ? fmtNum(l.quantity) : '' }),
      el('td', { className: 'num', textContent: l.estimated_value != null ? fmtMoney(l.estimated_value) : '' }),
      el('td', { textContent: fmtDate(l.start_date) }),
      el('td', { textContent: fmtDate(l.end_date) }));
    if (phase) for (const m of PM_MONTHS)
      tr.append(el('td', { className: 'num', textContent: l[m] ? fmtMoney(l[m]) : '' }));
    if (qa) tr.append(el('td', { title: l.owner_note || '', textContent: clip(l.owner_note, 40) }),
                      el('td', { title: l.dept_response || '', textContent: clip(l.dept_response, 40) }));
    tr.onclick = () => { PM.bud.pick = l.id; pbRender(); pbDetail(l); };
    body.append(tr);
  });
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: cols.length, style: 'color:var(--dim);padding:14px',
      textContent: PM.bud.lines.length ? t('pm.none.filter') : t('pm.bud.noLines') })));
    return;
  }
  const tot = el('tr', { className: 'tot' });
  tot.append(el('td', { colSpan: 9, textContent: t('pm.total', { n: fmtInt(rows.length) }) }),
    el('td', { className: 'num', textContent: fmtMoney(pmSum(rows, 'estimated_value')) }),
    el('td', { colSpan: 2 }));
  if (phase) for (const m of PM_MONTHS)
    tot.append(el('td', { className: 'num', textContent: fmtMoney(pmSum(rows, m)) || '' }));
  if (qa) tot.append(el('td', { colSpan: 2 }));
  body.append(tot);
}

const PM_LINE_SHOW = [['project_code', 'pm.col.code'], ['current_code', 'pm.f.currentCode'],
  ['name', 'pm.col.name'], ['dept_code', 'pm.col.dept'], ['category', 'pm.f.category2'],
  ['investment_type', 'pm.col.invest'], ['reason', 'pm.f.reason'], ['asset_item', 'pm.f.assetItem'],
  ['location', 'pm.f.location'], ['estimated_value', 'pm.col.estimate'], ['gm_approved', 'pm.f.gmApproved'],
  ['quantity', 'pm.f.qty'], ['unit_price', 'pm.f.unitPrice'], ['possibility', 'pm.f.possibility'],
  ['impact', 'pm.f.impact'], ['assessment', 'pm.f.assessment'], ['risk_level', 'pm.col.risk'],
  ['start_date', 'pm.col.start'], ['end_date', 'pm.col.end'], ['rationale', 'pm.f.rationale'],
  ['tech_standard', 'pm.f.techStd'], ['reference', 'pm.f.reference'], ['previous_code', 'pm.f.prevCode'],
  ['supplier', 'pm.f.supplier'], ['details', 'pm.f.details'], ['project_category', 'pm.col.projCat'],
  ['area_category', 'pm.col.areaCat'], ['color_status', 'pm.f.color'],
  ['purchasing_in_charge', 'pm.f.purchasing'], ['owner_note', 'pm.col.ownerNote'],
  ['dept_response', 'pm.col.deptResp'], ['note', 'pm.f.note']];

function pmDl(obj, fields) {
  const dl = el('dl');
  for (const [k, lbl] of fields) {
    let v = obj[k];
    if (v == null || v === '') continue;
    if (k === 'risk_level') v = pmRiskName(v);
    else if (PM_DATES.includes(k) || /_date$/.test(k)) v = fmtDate(v);
    else if (/value|price|amount|approved/.test(k)) v = isFinite(Number(v)) ? fmtMoney(Number(v)) : v;
    else if (typeof v === 'number') v = isFinite(v) ? fmtNum(v) : v;
    dl.append(el('dt', { textContent: t(lbl) }), el('dd', { textContent: String(v) }));
  }
  return dl;
}

/* A budget line's details open on the right, like a project's (user 25/09/2026). */
function pbDrawerClose() {
  const dr = $('#pbDrawer');
  if (!dr || dr.hidden) return;
  dr.hidden = true;
  $('#pbDetail').innerHTML = '';
  if (PM.bud.pick) { PM.bud.pick = null; pbRender(); }
}
function pbDetail(l) {
  MONEY.year = PM.bud.year;
  $('#pbDrTitle').textContent = `${l.project_code} — ${l.name || ''}`;
  $('#pbDrawer').hidden = false;
  const box = $('#pbDetail');
  box.innerHTML = '';
  box.scrollTop = 0;
  const card = el('div', { className: 'pmdet' });
  card.append(pmDl(Object.assign({}, l, { dept_code: l.dept_code ? `${l.dept_code} — ${pmDeptName(l.dept_code)}` : null }), PM_LINE_SHOW));
  // Admin override: correct any field of the line (testing phase), logged in the change log.
  if (canOverride() && can('budget', 'edit')) {
    const b = el('button', { className: 'btn', style: 'margin-top:10px', textContent: t('wf.adminEdit') });
    b.onclick = () => { b.remove(); card.append(pbLineForm(l)); };
    card.append(b);
  }
  box.append(card);
}

function pbLineForm(l) {
  const NUM = ['estimated_value', 'gm_approved', 'quantity', 'unit_price', 'possibility', 'impact', 'assessment'];
  const DATE = ['start_date', 'end_date'], LONG = ['reason', 'rationale', 'tech_standard', 'details'];
  const wrap = el('div', { className: 'ppedit', style: 'margin-top:12px' }, [el('h2', { textContent: t('pm.bud.editLine') })]);
  const all = el('div', { className: 'row adall' });
  for (const [k, lbl] of PM_LINE_SHOW) {
    const type = DATE.includes(k) ? 'date' : NUM.includes(k) ? 'num' : 'text';
    const val = l[k] == null ? '' : type === 'num' ? fmtNum(l[k]) : String(l[k]);
    const i = LONG.includes(k) ? el('textarea', { value: val, rows: 3 })
      : el('input', { type: type === 'date' ? 'date' : 'text', value: val, inputMode: type === 'num' ? 'decimal' : 'text' });
    i.dataset.k = k; i.dataset.type = type;
    all.append(el('div', { className: 'fld' + (LONG.includes(k) ? ' wide' : '') }, [el('label', { textContent: t(lbl) }), i]));
  }
  const out = el('div');
  const save = el('button', { className: 'btn pri', textContent: t('wf.adminSave') });
  save.onclick = async () => {
    const patch = {};
    for (const i of all.querySelectorAll('[data-k]')) {
      const v = i.value.trim();
      patch[i.dataset.k] = i.dataset.type === 'num' ? numIn(v) : (v || null);
    }
    try {
      await SB.patch('pm_budget_line', `id=eq.${l.id}`, patch);
      await pbRoundChanged();
      msg('#pbMsg', 'ok', t('pm.bud.lineSaved', { code: patch.project_code || l.project_code }));
    } catch (e) { msg(out, 'err', e.message); }
  };
  wrap.append(all, el('div', { className: 'acts' }, save), out);
  return wrap;
}

function pbExport() {
  const rows = pbFiltered().map((l, i) => {
    const o = { '#': i + 1 };
    for (const [k, lbl] of PM_LINE_SHOW) o[t(lbl)] = l[k];
    o[t('pm.col.entity')] = pmEntity(l.dept_code);
    for (let m = 1; m <= 12; m++) o[pmMonthName(m)] = l[PM_MONTHS[m - 1]];
    return o;
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Budget ' + PM.bud.year);
  XLSX.writeFile(wb, `Budget ${PM.bud.year} - ${($('#pbRound').selectedOptions[0] || {}).text || ''}.xlsx`
    .replace(/[\\/:*?"<>|★]/g, ' ').replace(/\s+/g, ' '));
}

/* ============================================================ projects */
async function ppLoad() {
  const out = $('#ppMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    const [rows, finals, vendors, money] = await Promise.all([
      pmSelectAll('pm_project', 'select=*&order=year.desc,code'),
      SB.select('pm_budget_round', 'select=id,year&is_final=eq.true'),
      SB.select('pm_vendor', 'select=code,name,aliases&order=name'),
      // Paid so far (21_pm_payment.sql). Not run yet, or no right to see
      // payments: the column is simply left out.
      can('payment', 'view') ? pmSelectAll('pm_project_money', 'select=project_code,paid_gross,invoiced_net,invoiced_vat').catch(() => null) : null
    ]);
    PM.prj.rows = rows;
    PM.prj.money = money ? new Map(money.map(m => [m.project_code, m])) : null;
    // Packages, their documents and the step each waits at (19_pm_workflow.sql),
    // for the "current step" column. Missing tables: the column is left out.
    PM.prj.docs = null;
    try {
      await wfLookups();
      const [docs, pkgs] = await Promise.all([
        pmSelectAll('pm_doc', 'select=id,project_code,doc_type,doc_no,status,pkg_id,final:data->final'),
        pmSelectAll('pm_pkg', 'select=id,project_code,grp,status,current_step,returned_to')]);
      const open = pkgs.filter(k => k.status === 'in_review').map(k => k.id);
      const steps = open.length ? await pmSelectAll('pm_pkg_step', `select=pkg_id,step,role_code,kind,owner_prep&pkg_id=in.(${open.join(',')})`) : [];
      PM.prj.docs = new Map();
      PM.prj.pkgs = new Map();
      for (const d of docs) {
        d.final = d.final === true || d.final === 'true';
        (PM.prj.docs.get(d.project_code) || PM.prj.docs.set(d.project_code, []).get(d.project_code)).push(d);
      }
      for (const k of pkgs) {
        k.step = steps.find(x => x.pkg_id === k.id && x.step === k.current_step) || null;
        (PM.prj.pkgs.get(k.project_code) || PM.prj.pkgs.set(k.project_code, []).get(k.project_code)).push(k);
      }
    } catch { PM.prj.docs = null; }
    PM.prj.vendors = vendors;
    const ids = finals.map(f => f.id);
    const fl = ids.length
      ? await pmSelectAll('pm_budget_line', `select=project_code,current_code,name,dept_code,estimated_value,start_date,end_date,risk_level,possibility,impact,assessment,project_category,area_category,investment_type,asset_item,location,reason,round_id&round_id=in.(${ids.join(',')})`)
      : [];
    PM.prj.finalLines = fl.map(l => Object.assign(l, { year: (finals.find(f => f.id === l.round_id) || {}).year }));
    PM.prj.finalCodes = new Set(fl.flatMap(l => [l.project_code, l.current_code]).filter(Boolean));
    /* Final-budget lines nobody has opened a project for yet: shown in the list
       too, as "not started", so the list covers the whole approved budget and
       not only the projects that already have a dossier. Split lines count as
       opened once any sub-project exists (main_code). */
    const opened = new Set(rows.flatMap(r => [r.code, r.main_code]));
    PM.prj.virtual = PM.prj.finalLines
      .filter(l => l.project_code && !opened.has(l.project_code) && !(l.current_code && opened.has(l.current_code)))
      .map(l => ({ code: l.project_code, main_code: l.project_code, year: l.year, dept_code: pmDept(l.dept_code),
                   name: l.name, budgeted: true, estimated_value: l.estimated_value, contract_value: null,
                   status: 'pending', virtual: true, planned_start: l.start_date, planned_end: l.end_date,
                   investment_type: l.investment_type, risk_level: l.risk_level, reason: l.reason,
                   asset_item: l.asset_item, location: l.location, project_category: l.project_category }));
    const ys = [...new Set([...rows, ...PM.prj.virtual].map(r => r.year))].sort((a, b) => b - a);
    const ySel = $('#ppYear');
    const keep = ySel.value;
    ySel.innerHTML = '';
    ySel.append(el('option', { value: '', textContent: t('pm.f.allYears') }));
    for (const y of ys) ySel.append(el('option', { value: y, textContent: y }));
    ySel.value = ys.map(String).includes(keep) ? keep : (ys[0] ? String(ys[0]) : '');
    selFill($('#ppBud'), [['', t('pm.f.all')], ['1', t('pm.f.budgetedOnly')], ['0', t('pm.f.unbudgetedOnly')]]);
    msSetup('ppEnt', PM_ENTITIES.map(e => ({ v: e, t: `${e} — ${t('perms.ent.' + e)}` })));
    msSetup('ppDept', [...new Set(rows.map(r => r.dept_code))].sort().map(d => ({ v: d, t: d })));
    msSetup('ppStatus', PM_STATUS.map(s => ({ v: s, t: t('pm.st.' + s) })));
    msg(out, '', '');
    ppRender();
    // Coming back from a document: reopen its project.
    const back = PM.prj.open && rows.find(r => r.code === PM.prj.open);
    PM.prj.open = null;
    if (back) { PM.prj.pick = back.code; ppRender(); ppDetail(back); }
    // The side panel stays open across a reload (a language switch, a save):
    // redraw it from the fresh row so it never shows old text or old figures.
    else if (!$('#ppDrawer').hidden && PM.prj.pick) {
      const again = [...rows, ...(PM.prj.virtual || [])].find(r => r.code === PM.prj.pick);
      if (again) (again.virtual ? ppVirtualDetail : ppDetail)(again); else ppDrawerClose();
    }
  } catch (e) { msg(out, 'err', e.message); }
}

function ppFiltered() {
  const y = $('#ppYear').value, bud = $('#ppBud').value;
  const ent = msValues('ppEnt'), dep = msValues('ppDept'), sts = msValues('ppStatus');
  const q = hnorm($('#ppQ').value);
  return [...PM.prj.rows, ...(PM.prj.virtual || [])].filter(p =>
    (!y || String(p.year) === y)
    && (bud === '' || String(Number(p.budgeted)) === bud)
    && (!ent.length || ent.includes(pmEntity(p.dept_code)))
    && (!dep.length || dep.includes(p.dept_code))
    && (!sts.length || sts.includes(p.status))
    && (!q || hnorm(`${p.code} ${p.name} ${p.chosen_vendor} ${p.asset_item}`).includes(q)));
}

function ppFlags(p) {
  const f = [];
  if (pmDatesOdd(p)) f.push(pmDatesMsg(p));
  if (p.budgeted && !PM.prj.finalCodes.has(p.main_code)) f.push(t('pm.flag.noLine'));
  if (!pmDeptKnown(p.dept_code)) f.push(t('pm.flag.dept', { d: p.dept_code }));
  return f;
}

/* Paid so far, shown PRE-TAX so it sits beside the contract value (also
   pre-tax) like for like: the bank amount (incl. VAT) is divided by 1 + the
   project's VAT rate as its invoices show it — 8% (÷ 1.08) when it has no
   invoice yet. Comparing the gross figure with the net contract made a fully
   paid project look ~8% over. */
function ppPaid(p) {
  const m = PM.prj.money && PM.prj.money.get(p.code);
  if (!m || !(Number(m.paid_gross) > 0)) return null;
  const vat = Number(m.invoiced_net) > 0 ? Number(m.invoiced_vat) / Number(m.invoiced_net) : 0.08;
  const paid = Number(m.paid_gross) / (1 + vat);
  const base = p.contract_value != null && Number(p.contract_value) > 0 ? Number(p.contract_value) : null;
  return { paid, base, pct: base ? paid / base : null };
}
/* Where each project stands, from its furthest live PACKAGE: whom it waits for
   (coloured: blue hotel, purple AM team, yellow JVC), or — once approved — the
   next package to draw up. Empty until 19_pm_workflow.sql exists. */
function ppStage(p) {
  if (!PM.prj.docs) return null;
  const docs = (PM.prj.docs.get(p.code) || []).filter(d => !['cancelled', 'rejected'].includes(d.status));
  const pkgs = (PM.prj.pkgs.get(p.code) || []).filter(k => k.status !== 'cancelled');
  const types = k => docs.filter(d => d.pkg_id === k.id).map(d => d.doc_type).sort((a, b) => wfSeq(a) - wfSeq(b)).join(' + ') || wfLead(k.grp);
  const nos = k => docs.filter(d => d.pkg_id === k.id).map(d => d.doc_no).join(' + ');
  const k = pkgs.slice().sort((a, b) => wfSeq(wfLead(b.grp)) - wfSeq(wfLead(a.grp)) || b.id - a.id)[0];
  if (!k) return { type: 'PR', state: 'none', band: 'op' };
  if (k.status === 'in_review') {
    const s = k.step || {}, owners = wfPkgTypes(k.grp).filter(ty => wfSide(ty) === 'owner').join('/');
    return { type: types(k), state: 'review', who: s.role_code ? wfRoleName(s.role_code) : '', no: nos(k), band: wfBand(s.role_code),
             kind: s.owner_prep ? (k.returned_to === 'am' ? 'redo' : 'checkPrep') : s.kind, pair: owners };
  }
  if (k.status === 'approved') {
    if (docs.some(d => d.doc_type === 'AH' && d.status === 'approved' && d.final)) return { type: 'AH', state: 'done', band: 'ok' };
    const top = Math.max(...wfPkgTypes(k.grp).map(wfSeq));
    const nx = k.grp === 'AH' ? 'AH' : (WF.types.filter(x => x.required && x.side === 'operator' && x.seq > top).sort((a, b) => a.seq - b.seq)[0] || {}).code;
    return nx ? { type: nx, state: 'none', band: 'op', no: nos(k) } : { type: types(k), state: 'done', band: 'ok', no: nos(k) };
  }
  return { type: types(k), state: k.status, band: k.status === 'draft' ? 'draft' : 'bad', no: nos(k) };   // draft / returned / rejected
}
// "waiting for X to approve" / "… to check" / "… to check and draw up the PA".
const ppStageVerb = s => s.state !== 'review' ? t('pm.stage.' + s.state)
  : t(['check', 'checkPrep', 'redo'].includes(s.kind) ? 'pm.stage.' + s.kind : 'pm.stage.review', { who: s.who || '?', pair: s.pair || '' });
const ppStageType = s => s.type;
const ppStageText = s => !s ? '' : s.state === 'done' ? t('pm.stage.done') : `${ppStageType(s)} · ${ppStageVerb(s)}`;

/* Filter text per column, like the Đối chiếu hoá đơn grid: words match
   anywhere; on figures ">100000000", "<0", "1..5" or "=0" compare the value. */
function ppCfMatch(col, p, q) {
  q = q.trim();
  if (!q) return true;
  if (col.num) {
    const v = col.val(p);
    const n = s => numIn(String(s).replace(/%$/, ''));
    let m;
    if ((m = /^(>=|<=|>|<|=)\s*(.+)$/.exec(q)) && n(m[2]) != null) {
      if (v == null) return false;
      const x = n(m[2]);
      return m[1] === '>' ? v > x : m[1] === '<' ? v < x : m[1] === '>=' ? v >= x : m[1] === '<=' ? v <= x : v === x;
    }
    if ((m = /^(.+?)\.\.(.+)$/.exec(q)) && n(m[1]) != null && n(m[2]) != null) return v != null && v >= n(m[1]) && v <= n(m[2]);
  }
  return hnorm(col.txt(p)).includes(hnorm(q));
}

// The grid's columns: header, sort value, filter text and cell, in one place.
function ppCols() {
  const money = (k, lbl) => ({ k, lbl, num: true, val: p => p[k] != null ? Number(p[k]) : null,
    txt: p => p[k] != null ? fmtMoney(p[k]) : '', td: p => el('td', { className: 'num', textContent: p[k] != null ? fmtMoney(p[k]) : '' }) });
  const date = (k, lbl) => ({ k, lbl, val: p => p[k] || '', txt: p => fmtDate(p[k]), td: p => el('td', { className: 'nw', textContent: fmtDate(p[k]) }) });
  const cols = [
    { k: 'status', lbl: 'pm.col.status', val: p => PM_STATUS.indexOf(p.status), txt: p => t('pm.st.' + p.status), td: p => el('td', { className: 'nw' }, pmStatusChip(p.status)) },
    ...(PM.prj.docs ? [{ k: 'stage', lbl: 'pm.col.stage', val: p => ppStageText(ppStage(p)), txt: p => ppStageText(ppStage(p)),
      td: p => { const s = ppStage(p); return el('td', { className: 'nw' }, s ? el('span', { className: 'stg band-' + s.band, title: s.no || '' }, [
        ...(s.state === 'done' ? [] : [el('b', { textContent: ppStageType(s) })]),
        document.createTextNode(s.state === 'done' ? t('pm.stage.done') : ' ' + ppStageVerb(s))]) : ''); } }] : []),
    { k: 'code', lbl: 'pm.col.code', val: p => p.code, txt: p => p.code, td: p => {
      const flags = ppFlags(p), td = el('td', { className: 'nw' }, el('code', { textContent: p.code }));
      if (flags.length) td.append(el('span', { className: 'flag', textContent: '⚠', title: flags.join('\n') }));
      if (p.virtual) td.append(el('span', { className: 'virt', textContent: t('pm.prj.budgetOnly'), title: t('pm.prj.budgetOnlyHint') }));
      return td; } },
    { k: 'name', lbl: 'pm.col.name', val: p => p.name || '', txt: p => p.name || '', td: p => el('td', { className: 'wrapname', textContent: p.name || '' }) },
    { k: 'dept', lbl: 'pm.col.dept', val: p => pmDeptName(p.dept_code), txt: p => (p.dept_code || '') + ' ' + pmDeptName(p.dept_code),
      td: p => el('td', { textContent: pmDeptName(p.dept_code), title: p.dept_code || '' }) },
    { k: 'budgeted', lbl: 'pm.col.budgeted', val: p => p.budgeted ? 1 : 0, txt: p => p.budgeted ? '✔ ' + t('pm.f.budgetedOnly') : '— ' + t('pm.f.unbudgetedOnly'),
      td: p => el('td', { className: 'c', textContent: p.budgeted ? '✔' : '—' }) },
    money('estimated_value', 'pm.col.estimate'),
    // The contract with its share of the budget in the same cell, like Paid (user 25/09/2026).
    { k: 'contract_value', lbl: 'pm.col.contract', hint: 'pm.col.contractHint', num: true, val: p => p.contract_value != null ? Number(p.contract_value) : null,
      txt: p => p.contract_value != null ? fmtMoney(p.contract_value) : '', td: p => ppContractCell(p) },
    ...(PM.prj.money ? [{ k: 'paid', lbl: 'pm.col.paid', hint: 'pm.col.paidHint', num: true,
      val: p => { const pd = ppPaid(p); return pd ? pd.paid : null; }, txt: p => { const pd = ppPaid(p); return pd ? fmtMoney(pd.paid) : ''; },
      td: p => ppPaidCell(ppPaid(p)) }] : []),
    { k: 'vendor', lbl: 'pm.col.vendor', val: p => p.chosen_vendor || '', txt: p => p.chosen_vendor || '', td: p => el('td', { textContent: p.chosen_vendor || '' }) },
    date('request_date', 'pm.col.request'), date('approve_date', 'pm.col.approve'),
    date('purchase_date', 'pm.col.contracted'), date('handover_date', 'pm.col.handover')
  ];
  return cols;
}
// Contract value and, small beside it, contract / budget (the estimate) — red above 100 %.
const ppContractCell = p => {
  const v = p.contract_value != null ? Number(p.contract_value) : null, b = Number(p.estimated_value) || 0;
  const r = v != null && b ? v / b : null;
  return el('td', { className: 'num paidc', title: t('pm.col.contractHint') }, v == null ? [] : [document.createTextNode(fmtMoney(v)),
    el('small', { className: 'pp' + (r > 1.0001 ? ' neg' : ''), textContent: r != null ? fmtPct(r, 0) : '—' })]);
};
const ppPaidCell = pd => el('td', { className: 'num paidc', title: t('pm.col.paidHint') }, pd ? [
  document.createTextNode(fmtMoney(pd.paid)),
  el('small', { className: 'pp' + (pd.pct > 1.0001 ? ' neg' : ''), textContent: pd.pct != null ? fmtPct(pd.pct, 0) : '—' })] : []);

// Filtered by the bar above AND the column filters, then sorted.
function ppRows(cols = ppCols()) {
  const cf = PM.prj.cf || {};
  let rows = ppFiltered().filter(p => cols.every(c => ppCfMatch(c, p, cf[c.k] || '')));
  const s = PM.prj.sort;
  const col = s && cols.find(c => c.k === s.k);
  if (col) {
    const dir = s.dir === 'desc' ? -1 : 1;
    rows = rows.slice().sort((a, b) => {
      const x = col.val(a), y = col.val(b);
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), pmLoc())) * dir;
    });
  }
  return rows;
}

function ppRender() {
  MONEY.year = +$('#ppYear').value || null;
  const head = $('#ppGrid thead');
  head.innerHTML = '';
  const cols = ppCols();
  PM.prj.cf = PM.prj.cf || {};
  // Header: click to sort (again to reverse), and a filter box under each title.
  const hr = el('tr', {}, [el('th', { className: 'num idx', textContent: '#' }), ...cols.map(c => {
    const s = PM.prj.sort && PM.prj.sort.k === c.k ? PM.prj.sort.dir : null;
    const th = el('th', { className: 'srt' + (c.num ? ' num' : '') + (s ? ' on' : ''), title: c.hint ? t(c.hint) : t('pm.sortHint') },
      [document.createTextNode(t(c.lbl)), el('span', { className: 'arr', textContent: s === 'asc' ? '▲' : s === 'desc' ? '▼' : '⇅' })]);
    th.onclick = () => { PM.prj.sort = { k: c.k, dir: s === 'asc' ? 'desc' : 'asc' }; ppRender(); };
    return th; })]);
  const fr = el('tr', { className: 'frow' }, [el('th', {}, el('button', { className: 'btn tiny', textContent: '↺', title: t('pm.cfClear'),
    onclick: () => { PM.prj.cf = {}; ppRender(); } })), ...cols.map(c => {
    const i = el('input', { className: 'cfin' + (PM.prj.cf[c.k] ? ' on' : ''), value: PM.prj.cf[c.k] || '', spellcheck: false,
      placeholder: c.num ? '>0 · <0 · 1..9' : t('pm.cfPh') });
    i.oninput = () => { PM.prj.cf[c.k] = i.value; i.classList.toggle('on', !!i.value); ppRenderBody(cols); };
    return el('th', {}, i); })]);
  head.append(hr, fr);
  ppRenderBody(cols);
  // Tools ride in the message line's slot, above the grid.
  const tools = [];
  if (can('project', 'create')) tools.push(['pm.prj.new', () => ppNew()]);
  tools.push(['reg.xlsx', ppExport]);
  let tb = $('#ppTools');
  if (!tb) { tb = el('div', { id: 'ppTools', className: 'row', style: 'margin:10px 0 0;justify-content:flex-end' }); $('#ppMsg').before(tb); }
  tb.innerHTML = '';
  for (const [k, fn] of tools) { const b = el('button', { className: 'btn' + (k === 'pm.prj.new' ? ' pri' : ''), textContent: t(k) }); b.onclick = fn; tb.append(b); }
}

// Rows only, so typing in a column filter keeps the cursor where it is.
function ppRenderBody(cols = ppCols()) {
  const body = $('#ppGrid tbody');
  body.innerHTML = '';
  const rows = ppRows(cols);
  ppStats(rows);
  rows.forEach((p, i) => {
    const tr = el('tr', { className: (PM.prj.pick === p.code ? 'pick' : '') + (p.virtual ? ' virtrow' : '') }, [el('td', { className: 'num idx', textContent: fmtInt(i + 1) }), ...cols.map(c => c.td(p))]);
    tr.onclick = () => { PM.prj.pick = p.code; ppRenderBody(cols); if (p.virtual) ppVirtualDetail(p); else ppDetail(p); };
    body.append(tr);
  });
  if (!rows.length) {
    body.append(el('tr', {}, el('td', { colSpan: cols.length + 1, style: 'color:var(--dim);padding:14px',
      textContent: PM.prj.rows.length ? t('pm.none.filter') : t('pm.prj.empty') })));
    return;
  }
  // Totals of what is shown: estimate, contract, paid (with its share).
  const tot = el('tr', { className: 'tot' }, [el('td', { className: 'num idx' })]);
  cols.forEach((c, ci) => {
    if (ci === 0) return tot.append(el('td', { textContent: t('pm.total', { n: fmtInt(rows.length) }) }));
    if (c.k === 'estimated_value') return tot.append(el('td', { className: 'num', textContent: fmtMoney(pmSum(rows, c.k)) }));
    if (c.k === 'contract_value') {
      const withC = rows.filter(p => p.contract_value != null);
      return tot.append(ppContractCell({ contract_value: pmSum(rows, c.k), estimated_value: pmSum(withC, 'estimated_value') }));
    }
    if (c.k === 'paid') {
      const ps = rows.map(ppPaid).filter(Boolean);
      const paid = ps.reduce((a, x) => a + x.paid, 0), base = ps.reduce((a, x) => a + (x.base || 0), 0);
      return tot.append(ppPaidCell(ps.length ? { paid, pct: base ? paid / base : null } : null));
    }
    tot.append(el('td'));
  });
  body.append(tot);
}

/* Score cards over the rows shown (filters and column filters included), in
   the Budget sheet's style (feedback 25/09/2026): how many projects, their
   average progress (as the dashboard), the budget of their lines, the
   estimate, the contract (÷ estimate of the contracted ones, as the Contract
   column) and paid pre-tax (÷ contract, as the Paid column). */
function ppStats(rows) {
  let box = $('#ppStats');
  if (!box) { box = el('div', { id: 'ppStats', className: 'stats' }); $('#ppMsg').before(box); }
  box.innerHTML = '';
  const tile = (label, value, sub, meter) => el('div', { className: 'stat' }, [
    el('span', { className: 'sl', textContent: label }), el('span', { className: 'sv', textContent: value }),
    ...(sub ? [el('span', { className: 'sd', textContent: sub })] : []),
    ...(meter != null ? [el('div', { className: 'meter' + (meter > 1 ? ' over' : '') },
                            el('i', { style: `width:${Math.min(100, Math.max(0, meter * 100))}%` }))] : [])]);
  const live = rows.filter(p => p.status !== 'cancelled');
  const done = live.filter(p => p.status === 'completed').length;
  const avg = live.length ? live.reduce((s, p) => s + pdCompletion(p, PM.prj.docs ? PM.prj.docs.get(p.code) : []), 0) / live.length : null;
  // The budget of the lines behind the budgeted rows, each line once (a split project shares its line).
  const codes = new Set(live.filter(p => p.budgeted).flatMap(p => [p.main_code, p.code]).filter(Boolean));
  const lines = (PM.prj.finalLines || []).filter(l => codes.has(l.project_code) || (l.current_code && codes.has(l.current_code)));
  const budget = pmSum(lines, 'estimated_value');
  const est = pmSum(live, 'estimated_value');
  const withC = live.filter(p => p.contract_value != null);
  const contract = pmSum(withC, 'contract_value'), estC = pmSum(withC, 'estimated_value');
  const ps = live.map(ppPaid).filter(Boolean);
  const paid = ps.reduce((a, x) => a + x.paid, 0), paidBase = ps.reduce((a, x) => a + (x.base || 0), 0);
  box.append(
    tile(t('pm.ps.count'), fmtInt(live.length), t('pm.ps.countSub', { done: fmtInt(done), open: fmtInt(live.length - done) })),
    tile(t('pm.ps.progress'), avg == null ? '—' : fmtPct(avg, 0), t('pm.ps.progressSub'), avg),
    tile(t('pm.ps.budget'), fmtM(budget), t('pm.ps.budgetSub', { n: fmtInt(lines.length) })),
    tile(t('pm.ps.estimate'), fmtM(est), budget ? t('pm.ps.ofBudget', { pct: fmtPct(est / budget) }) : ''),
    tile(t('pm.ps.contract'), fmtM(contract), estC ? t('pm.ps.contractSub', { pct: fmtPct(contract / estC), n: fmtInt(withC.length) }) : '',
         estC ? contract / estC : null),
    ...(PM.prj.money ? [tile(t('pm.ps.paid'), fmtM(paid), paidBase ? t('pm.ps.paidSub', { pct: fmtPct(paid / paidBase) }) : '',
                             paidBase ? paid / paidBase : null)] : []));
}

const PM_PROJ_SHOW = [['code', 'pm.col.code'], ['main_code', 'pm.f.mainCode'], ['name', 'pm.col.name'],
  ['dept_code', 'pm.col.dept'], ['share_pct', 'pm.f.share'], ['investment_type', 'pm.col.invest'],
  ['project_type', 'pm.f.projectType'], ['procurement_type', 'pm.f.procType'],
  ['estimated_value', 'pm.col.estimate'], ['risk_level', 'pm.col.risk'], ['risk_category', 'pm.f.riskCat'],
  ['asset_item', 'pm.f.assetItem'], ['location', 'pm.f.location'], ['reason', 'pm.f.reason'],
  ['rationale', 'pm.f.rationale'], ['tech_standard', 'pm.f.techStd'], ['proposed_supplier', 'pm.f.supplier'],
  ['request_date', 'pm.col.request'], ['assess_date', 'pm.f.assess'], ['approve_date', 'pm.col.approve'],
  ['purchase_date', 'pm.col.purchase'], ['handover_date', 'pm.col.handover'],
  ['contract_value', 'pm.col.contract'], ['contract_volume', 'pm.f.volume'], ['chosen_vendor', 'pm.col.vendor'],
  ['evaluation', 'pm.f.evaluation'], ['comment', 'pm.f.note'], ['source_file', 'pm.f.sourceFile']];

/* The project panel slides in from the right, so the list stays in view and
   another row can be clicked straight away. ✎ shows the update form (only for
   those who may edit), ✕ or Esc closes. Returns the empty panel body. */
function ppDrawer(title, onEdit) {
  const dr = $('#ppDrawer');
  $('#ppDrTitle').textContent = title;
  const pen = $('#ppDrEdit');
  pen.hidden = !onEdit;
  pen.classList.remove('on');
  pen.onclick = onEdit ? () => pen.classList.toggle('on', onEdit()) : null;
  dr.hidden = false;
  const body = $('#ppDetail');
  body.innerHTML = '';
  body.scrollTop = 0;
  return body;
}
function ppDrawerClose() {
  const dr = $('#ppDrawer');
  if (!dr || dr.hidden) return;
  dr.hidden = true;
  $('#ppDetail').innerHTML = '';
  if (PM.prj.pick) { PM.prj.pick = null; ppRenderBody(); }
}

async function ppDetail(p) {
  MONEY.year = p.year;
  const card = el('div', { className: 'pmdet' });
  const share = Object.assign({}, p, p.share_pct != null ? { share_pct: fmtPct(Number(p.share_pct), 0) } : {},
    p.dept_code ? { dept_code: p.dept_code + ' — ' + pmDeptName(p.dept_code) } : {});       // the department by its full name
  // The update form waits at the top of the panel, folded until ✎ is pressed.
  const form = can('project', 'edit') ? ppEditForm(p) : null;
  const box = ppDrawer(`${p.code} — ${p.name || ''}`, form && (() => {
    form.hidden = !form.hidden;
    if (!form.hidden) { $('#ppDetail').scrollTop = 0; const f = form.querySelector('select,input'); if (f) f.focus(); }
    return !form.hidden;
  }));
  if (form) { form.hidden = true; card.append(form); }
  const flags = ppFlags(p);
  if (flags.length) card.append(el('div', { className: 'msg warn', textContent: flags.join('\n') }));
  card.append(pmDl(share, PM_PROJ_SHOW));
  box.append(card);
  // Tender scores, newest dossier's.
  try {
    const sc = await SB.select('pm_vendor_score', `select=*&project_code=eq.${encodeURIComponent(p.code)}&order=total_score.desc.nullslast`);
    if (sc.length) {
      const tb = el('table');
      tb.append(el('tr', {}, [['pm.vs.vendor'], ['pm.vs.amount', 'num'], ['pm.vs.ability', 'num'],
        ['pm.vs.technique', 'num'], ['pm.vs.finance', 'num'], ['pm.vs.total', 'num'], ['pm.vs.chosen', 'c']]
        .map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
      const f1 = v => v == null ? '' : Number(v).toLocaleString(pmLoc(), { maximumFractionDigits: 1 });
      for (const s of sc) tb.append(el('tr', {}, [
        el('td', { textContent: s.vendor_name }),
        el('td', { className: 'num', textContent: s.total_amount != null ? fmtNum(s.total_amount) : '' }),
        el('td', { className: 'num', textContent: f1(s.ability) }),
        el('td', { className: 'num', textContent: f1(s.technique) }),
        el('td', { className: 'num', textContent: f1(s.finance) }),
        el('td', { className: 'num', textContent: f1(s.total_score) }),
        el('td', { className: 'c', textContent: s.chosen ? '✔' : '' })]));
      card.append(el('h2', { style: 'margin-top:14px', textContent: t('pm.vs.h') }), el('div', { className: 'wrap' }, tb));
    }
  } catch {}
  // The procurement documents. Before 19_pm_workflow.sql is run the tables do
  // not exist, and the project screen must keep working without them.
  try { await wfProjectPanel(p, card); } catch {}
  // Invoices and payments against it (21_pm_payment.sql), same tolerance.
  if (can('payment', 'view')) { try { await payProjectDetail(p.code, card, true); } catch {} }
}

/* The execution facts that change as the project moves. Phase 3 replaces most
   of this with the document workflow; until then someone must be able to
   correct a date or record the contract. */
function ppEditForm(p) {
  const wrap = el('div', { className: 'ppedit' });
  wrap.append(el('h2', { textContent: t('pm.prj.edit') }));
  const row = el('div', { className: 'row', style: 'align-items:flex-end;flex-wrap:wrap' });
  const fld = (k, lbl, type, w) => {
    const i = el('input', { type: type || 'text', style: `width:${w || 150}px`,
      value: type === 'date' ? (p[k] || '') : (p[k] != null ? (typeof p[k] === 'number' || /value|volume/.test(k) ? fmtNum(p[k]) : p[k]) : '') });
    i.dataset.k = k; i.dataset.type = type || 'text';
    return el('div', { className: 'fld' }, [el('label', { textContent: t(lbl) }), i]);
  };
  const st = el('select', { style: 'width:150px' });
  st.dataset.k = 'status_override'; st.dataset.type = 'select';
  st.append(el('option', { value: '', textContent: t('pm.prj.autoStatus') }));
  for (const s of PM_STATUS) st.append(el('option', { value: s, textContent: t('pm.st.' + s) }));
  st.value = p.status_override || '';
  row.append(
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.status') }), st]),
    fld('request_date', 'pm.col.request', 'date'), fld('approve_date', 'pm.col.approve', 'date'),
    fld('purchase_date', 'pm.col.purchase', 'date'), fld('handover_date', 'pm.col.handover', 'date'),
    fld('contract_value', 'pm.col.contract', 'text', 150), fld('chosen_vendor', 'pm.col.vendor', 'text', 200),
    fld('comment', 'pm.f.note', 'text', 260));
  const acts = el('div', { className: 'acts' });
  const save = el('button', { className: 'btn pri', textContent: t('tool.save') });
  save.onclick = async () => {
    const patch = {};
    for (const i of wrap.querySelectorAll('[data-k]')) {
      const k = i.dataset.k, ty = i.dataset.type, v = i.value.trim();
      patch[k] = ty === 'date' ? (v || null) : ty === 'select' ? (v || null)
        : ty === 'num' || /value|volume/.test(k) ? numIn(v) : (v || null);
    }
    try {
      await SB.patch('pm_project', `code=eq.${encodeURIComponent(p.code)}`, patch);
      PM.prj.pick = p.code;
      await ppLoad();                               // clears #ppMsg, so report after it; redraws the panel
      msg('#ppMsg', 'ok', t('pm.prj.saved', { code: p.code }));
    } catch (e) { msg('#ppMsg', 'err', e.message); }
  };
  acts.append(save);
  if (can('project', 'admin')) {
    const del = el('button', { className: 'btn danger', textContent: t('pm.prj.delete') });
    del.onclick = async () => {
      if (!confirm(t('pm.prj.confirmDel', { code: p.code }))) return;
      try { await SB.remove('pm_project', `code=eq.${encodeURIComponent(p.code)}`); ppDrawerClose();
            await ppLoad(); msg('#ppMsg', 'ok', t('pm.prj.deleted', { code: p.code })); }
      catch (e) { msg('#ppMsg', 'err', e.message); }
    };
    acts.append(del);
  }
  wrap.append(row);
  if (canOverride()) wrap.append(ppAllFields(p, row));
  wrap.append(acts);
  return wrap;
}

/* Admin override: every other field of the project as well — what the budget
   line and the dossier filled in — for the testing phase's corrections. */
function ppAllFields(p, row) {
  const shown = new Set(['code', ...[...row.querySelectorAll('[data-k]')].map(i => i.dataset.k)]);
  const LONG = ['reason', 'rationale', 'tech_standard', 'evaluation'];
  const all = el('div', { className: 'row adall' });
  for (const [k, lbl] of PM_PROJ_SHOW) {
    if (shown.has(k) || k === 'source_file') continue;
    const type = PM_DATES.includes(k) ? 'date' : PM_NUMS.includes(k) ? 'num' : 'text';
    const val = p[k] == null ? '' : type === 'num' ? fmtNum(p[k]) : String(p[k]);
    const i = LONG.includes(k) ? el('textarea', { value: val, rows: 3 })
      : el('input', { type: type === 'date' ? 'date' : 'text', value: val, inputMode: type === 'num' ? 'decimal' : 'text' });
    i.dataset.k = k; i.dataset.type = type;
    all.append(el('div', { className: 'fld' + (LONG.includes(k) ? ' wide' : '') }, [el('label', { textContent: t(lbl) }), i]));
  }
  return el('div', {}, [el('h3', { className: 'adh3', textContent: t('pm.prj.allFields') }), all]);
}

/* New project: from an approved budget line (the usual case — everything is
   copied over) or unbudgeted, which needs its own code. The database refuses
   an unbudgeted code that a budget line already owns. */
/* A budget line with no project yet: what the budget says, and a button to
   open the project from it (the same form as '+ New project', pre-filled). */
function ppVirtualDetail(p) {
  MONEY.year = p.year;
  const box = ppDrawer(`${p.code} — ${p.name || ''}`, null);
  const card = el('div', { className: 'pmdet' });
  card.append(el('div', { className: 'msg info', textContent: t('pm.prj.budgetOnlyHint') }),
    pmDl(p, [['code', 'pm.col.code'], ['name', 'pm.col.name'], ['dept_code', 'pm.col.dept'], ['estimated_value', 'pm.col.estimate'],
             ['investment_type', 'pm.col.invest'], ['risk_level', 'pm.col.risk'], ['planned_start', 'pm.f.plannedStart'],
             ['planned_end', 'pm.f.plannedEnd'], ['asset_item', 'pm.f.assetItem'], ['location', 'pm.f.location'], ['reason', 'pm.f.reason']]));
  if (can('project', 'create')) {
    const b = el('button', { className: 'btn pri', textContent: t('pm.prj.openFromLine') });
    b.onclick = () => ppNew(p.code, p.year);
    card.append(el('div', { className: 'acts', style: 'margin-top:10px' }, b));
  }
  box.append(card);
}

function ppNew(preCode, preYear) {
  const y = preYear || +$('#ppYear').value || new Date().getFullYear();
  const box = ppDrawer(t('pm.prj.newH', { y }), null);
  if (!preCode && PM.prj.pick) { PM.prj.pick = null; ppRenderBody(); }
  const taken = new Set(PM.prj.rows.map(r => r.main_code));
  const free = (PM.prj.finalLines || []).filter(l => l.year === y && !taken.has(l.project_code));
  const card = el('div', { className: 'pmdet' });
  const row = el('div', { className: 'row', style: 'align-items:flex-end;flex-wrap:wrap' });
  const lineSel = el('select', { style: 'min-width:360px;max-width:100%' });
  lineSel.append(el('option', { value: '', textContent: free.length ? t('pm.prj.pickLine') : t('pm.prj.noFreeLine') }));
  free.forEach((l, i) => lineSel.append(el('option', { value: i,
    textContent: `${l.project_code} — ${l.name || ''} — ${fmtM(l.estimated_value)}` })));
  const unb = el('input', { type: 'checkbox' });
  const code = el('input', { style: 'width:190px', placeholder: 'FFE.ENG.21.' + y, spellcheck: false });
  const name = el('input', { style: 'width:280px' });
  const dept = el('select', { style: 'width:120px' });
  for (const o of PM.orgs.filter(o => o.is_department)) dept.append(el('option', { value: o.code, textContent: o.code }));
  const est = el('input', { style: 'width:150px', inputMode: 'numeric' });
  // Replacement or new investment decides whether the PR goes with an RR.
  // The budget line usually says; when it does not, the preparer chooses here.
  const inv = el('select', { style: 'width:170px' });
  for (const v of ['', 'Replacement', 'New Investment']) inv.append(el('option', { value: v, textContent: v ? wfOpt(v) : '—' }));
  const lineInv = l => /replace/i.test(l.investment_type || '') ? 'Replacement' : /new/i.test(l.investment_type || '') ? 'New Investment' : '';
  const sync = () => {
    const l = free[lineSel.value];
    code.disabled = !unb.checked; lineSel.disabled = unb.checked;
    if (!unb.checked && l) { code.value = l.project_code; name.value = l.name || ''; dept.value = pmDept(l.dept_code);
                             est.value = l.estimated_value != null ? fmtNum(l.estimated_value) : ''; }
    const fixed = !unb.checked && l && lineInv(l);
    if (fixed) inv.value = fixed;
    inv.disabled = !!fixed;
  };
  lineSel.onchange = sync; unb.onchange = sync;
  row.append(
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.prj.fromLine') }), lineSel]),
    el('label', { className: 'chk' }, [unb, el('span', { textContent: t('pm.prj.unbudgeted') })]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.code') }), code]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.name') }), name]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.dept') }), dept]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.estimate') }), est]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.invest') }), inv]));
  const acts = el('div', { className: 'acts' });
  const save = el('button', { className: 'btn pri', textContent: t('tool.save') });
  save.onclick = async () => {
    const c = pmCode(code.value);
    if (!PM_CODE_OK.test(c)) return msg('#ppMsg', 'err', t('pm.prj.badCode'));
    const l = unb.checked ? null : free[lineSel.value];
    if (!inv.value) return msg('#ppMsg', 'err', t('wf.askInvest'));
    const rec = pmProjRow(l ? {
      name: l.name, investment_type: l.investment_type, possibility: l.possibility, impact: l.impact,
      assessment: l.assessment, risk_level: l.risk_level, project_category: l.project_category,
      area_category: l.area_category, asset_item: l.asset_item, location: l.location, reason: l.reason,
      planned_start: l.start_date, planned_end: l.end_date } : {}, {
      code: c, main_code: pmMain(c), dept_code: dept.value, name: name.value.trim() || null,
      estimated_value: numIn(est.value), budgeted: !unb.checked, source: 'app', investment_type: inv.value,
      request_date: new Date().toISOString().slice(0, 10) });
    try {
      await SB.insert('pm_project', [rec]);
      await ppLoad();                               // clears #ppMsg, so report after it
      msg('#ppMsg', 'ok', t('pm.prj.created', { code: c }));
      // Straight on to its PR (and RR for a replacement), when this person draws them up;
      // otherwise to the new project.
      const made = PM.prj.rows.find(r => r.code === c);
      if (made && WF.types.length && wfCanPrepare('PR', made.dept_code)) { ppDrawerClose(); await wfCreate(made, 'PR', [], '#ppMsg'); }
      else if (made) { PM.prj.pick = c; ppRenderBody(); ppDetail(made); } else ppDrawerClose();
    } catch (e) { msg('#ppMsg', 'err', e.message); }
  };
  const cancel = el('button', { className: 'btn', textContent: t('auth.cancel') });
  cancel.onclick = ppDrawerClose;
  acts.append(cancel, save);
  row.append(acts);
  card.append(row);
  box.append(card);
  // Opened from a not-started budget line: that line is already chosen.
  if (preCode) { const i = free.findIndex(l => l.project_code === preCode); if (i >= 0) lineSel.value = String(i); }
  sync();
}

function ppExport() {
  const rows = ppRows().map((p, i) => {
    const o = { '#': i + 1 };
    if (PM.prj.docs) o[t('pm.col.stage')] = ppStageText(ppStage(p));
    for (const [k, lbl] of PM_PROJ_SHOW) o[t(lbl)] = p[k];
    o[t('pm.col.entity')] = pmEntity(p.dept_code);
    o[t('pm.col.budgeted')] = p.budgeted ? 'Y' : 'N';
    o[t('pm.col.status')] = t('pm.st.' + p.status);
    if (PM.prj.money) {
      const pd = ppPaid(p);
      o[t('pm.col.paid')] = pd ? Math.round(pd.paid) : null;
      o[t('pm.col.paidPct')] = pd && pd.pct != null ? Math.round(pd.pct * 1000) / 10 : null;
    }
    return o;
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Projects');
  XLSX.writeFile(wb, `Projects ${$('#ppYear').value || 'all'}.xlsx`);
}

/* ================================================================ charts
   Plain SVG, no library. Specs from the dataviz reference: bars <= 24px with a
   4px rounded data end and a square baseline, 2px lines, 8px end dots with a
   2px surface ring, 2px surface gaps, hairline solid grid, one tooltip that
   lists every series, and a table view behind every chart. */
// SVG presentation attributes take literal colours; CSS variables are only
// dependable inside CSS and style="". Same values as the .viz tokens.
const VZ = { grid: '#e2e6ee', axis: '#c3cad6', ink3: '#6b7280', surface: '#ffffff' };
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
};
const svText = (x, y, s, attrs = {}) => { const n = sv('text', Object.assign({ x, y }, attrs)); n.textContent = s; return n; };

let VTIP = null;
function tipShow(ev, title, rows) {
  if (!VTIP) { VTIP = el('div', { className: 'vtip', hidden: true }); document.body.append(VTIP); }
  VTIP.innerHTML = '';
  VTIP.append(el('div', { className: 'tt', textContent: title }));
  for (const r of rows) {
    const line = el('div', { className: 'tr' });
    if (r.color) line.append(el('i', { style: `background:${r.color}` }));
    line.append(el('b', { textContent: r.value }), el('span', { textContent: r.label }));
    VTIP.append(line);
  }
  VTIP.hidden = false;
  let x, y;
  if (ev && ev.clientX != null && ev.type !== 'focus') { x = ev.clientX; y = ev.clientY; }
  else { const b = ev.target.getBoundingClientRect(); x = b.left + b.width / 2; y = b.top; }
  const w = VTIP.offsetWidth, h = VTIP.offsetHeight;
  VTIP.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14)) + 'px';
  VTIP.style.top = Math.max(8, y - h - 10) + 'px';
}
const tipHide = () => { if (VTIP) VTIP.hidden = true; };

// Round a data end (right side for bars growing rightwards), square at the base.
function barPath(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}h${w - rr}q${rr},0 ${rr},${rr}v${h - 2 * rr}q0,${rr} -${rr},${rr}h-${w - rr}z`;
}
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/* A chart card: title, optional legend, the chart, and a Table toggle that
   swaps the chart for the numbers behind it. */
function chartCard(title, sub, legend, drawChart, tableRows, wide) {
  const card = el('div', { className: 'chartcard' + (wide ? ' wide' : '') });
  const h3 = el('h3', { textContent: title });
  if (sub) h3.append(el('span', { className: 'sub', textContent: sub }));
  const toggle = el('button', { className: 'btn tiny', textContent: t('pm.viz.table') });
  card.append(el('div', { className: 'ch' }, [h3, toggle]));
  if (legend && legend.length > 1) {
    const lg = el('div', { className: 'legend' });
    for (const it of legend) lg.append(el('span', {}, [el('i', { className: it.line ? 'ln' : '', style: `background:${it.color}` }), document.createTextNode(it.label)]));
    card.append(lg);
  }
  const body = el('div', { className: 'cbody' });      // centred in the card's height (user 25/09/2026)
  const tbl = el('div', { className: 'viztbl wrap', hidden: true });
  card.append(body, tbl);
  let showing = false;
  toggle.onclick = () => {
    showing = !showing;
    toggle.textContent = t(showing ? 'pm.viz.chart' : 'pm.viz.table');
    body.hidden = showing; tbl.hidden = !showing;
    if (showing && !tbl.firstChild) {
      const [hd, ...rs] = tableRows();
      const tb = el('table');
      tb.append(el('tr', {}, hd.map((h, i) => el('th', { className: i ? 'num' : '', textContent: h }))));
      for (const r of rs) tb.append(el('tr', {}, r.map((c, i) => el('td', { className: i ? 'num' : '', textContent: c }))));
      tbl.append(tb);
    }
  };
  // Drawn after the card is in the page, so it can measure its own width.
  card._draw = () => { body.innerHTML = ''; body.append(drawChart(Math.max(300, body.clientWidth || card.clientWidth - 28))); };
  return card;
}

/* Horizontal bars, one or two series on ONE axis. Only the first series gets
   a value at its tip; the rest is in the tooltip and the table. */
function hbarChart(W, cats, series, labelFirst = true) {
  const labW = Math.min(170, Math.max(90, W * 0.26)), rightPad = 58, top = 4, axisH = 20;
  const barH = series.length > 1 ? 10 : 16, gap = 2;
  const band = series.length * barH + (series.length - 1) * gap + 12;
  const H = top + cats.length * band + axisH;
  const max = niceMax(Math.max(1, ...cats.flatMap(c => series.map(s => s.values.get(c.key) || 0))));
  const x = v => labW + (W - labW - rightPad) * (v / max);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  // Hairline grid + ticks.
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4, gx = x(v);
    svg.append(sv('line', { x1: gx, x2: gx, y1: top, y2: H - axisH, stroke: VZ.grid, 'stroke-width': 1 }));
    svg.append(svText(gx, H - 6, fmtM(v), { 'text-anchor': i === 0 ? 'start' : 'middle' }));
  }
  svg.append(sv('line', { x1: labW, x2: labW, y1: top, y2: H - axisH, stroke: VZ.axis, 'stroke-width': 1 }));
  cats.forEach((c, ci) => {
    const y0 = top + ci * band + 6;
    const lbl = c.label.length > 24 ? c.label.slice(0, 23) + '…' : c.label;
    svg.append(svText(labW - 8, y0 + (band - 12) / 2 + 4, lbl, { 'text-anchor': 'end', class: 'lab' }));
    const g = sv('g', { class: 'hitbar', tabindex: 0 });
    series.forEach((s, si) => {
      const v = s.values.get(c.key) || 0, by = y0 + si * (barH + gap);
      if (v > 0) g.append(sv('path', { class: 'mk', d: barPath(labW, by, x(v) - labW, barH), fill: s.color }));
      if (si === 0 && labelFirst && v > 0) g.append(svText(x(v) + 5, by + barH / 2 + 4, fmtM(v), { class: 'v' }));
    });
    // The hit target is the whole band, not the painted pixels.
    g.prepend(sv('rect', { class: 'hit', x: 0, y: y0 - 4, width: W, height: band - 4, fill: 'transparent' }));
    const show = ev => tipShow(ev, c.label, series.map(s => ({ color: s.color, label: s.label, value: fmtMoney(s.values.get(c.key) || 0) })));
    g.addEventListener('pointermove', show); g.addEventListener('focus', show);
    g.addEventListener('pointerleave', tipHide); g.addEventListener('blur', tipHide);
    svg.append(g);
  });
  return svg;
}

/* Cumulative plan vs actual over the twelve months: two 2px lines, end dots,
   a crosshair that snaps to the nearest month and lists both series. */
function lineChart(W, months, series, highlight) {
  const H = 230, L = 58, R = 70, T = 10, B = 24;
  const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
  const x = i => L + (W - L - R) * (i / 11), y = v => T + (H - T - B) * (1 - v / max);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  if (highlight && highlight.length < 12) {
    const a = Math.min(...highlight) - 1, b = Math.max(...highlight) - 1;
    svg.append(sv('rect', { x: x(a) - 6, y: T, width: x(b) - x(a) + 12, height: H - T - B, fill: '#eef4fc' }));
  }
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    svg.append(sv('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: i ? VZ.grid : VZ.axis, 'stroke-width': 1 }));
    svg.append(svText(L - 8, y(v) + 4, fmtM(v), { 'text-anchor': 'end' }));
  }
  months.forEach((m, i) => svg.append(svText(x(i), H - 6, m, { 'text-anchor': 'middle' })));
  const ends = [];
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
    svg.append(sv('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = s.values.length - 1;
    svg.append(sv('circle', { cx: x(last), cy: y(s.values[last]), r: 4, fill: s.color, stroke: VZ.surface, 'stroke-width': 2 }));
    ends.push({ s, yy: y(s.values[last]) });
  }
  // End labels only when they do not collide; otherwise legend + tooltip carry it.
  if (ends.length < 2 || Math.abs(ends[0].yy - ends[1].yy) > 14)
    for (const e of ends) svg.append(svText(W - R + 8, e.yy + 4, fmtM(e.s.values[e.s.values.length - 1]), { class: 'v' }));
  const cross = sv('line', { y1: T, y2: H - B, stroke: VZ.ink3, 'stroke-width': 1, visibility: 'hidden' });
  svg.append(cross);
  const hit = sv('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent', tabindex: 0 });
  let at = 11;
  const move = (ev, idx) => {
    at = idx;
    cross.setAttribute('x1', x(at)); cross.setAttribute('x2', x(at)); cross.setAttribute('visibility', 'visible');
    tipShow(ev, months[at], series.map(s => ({ color: s.color, label: s.label, value: fmtMoney(s.values[at]) })));
  };
  hit.addEventListener('pointermove', ev => {
    const b = svg.getBoundingClientRect(), px = (ev.clientX - b.left) * (W / b.width);
    move(ev, Math.max(0, Math.min(11, Math.round((px - L) / ((W - L - R) / 11)))));
  });
  hit.addEventListener('focus', ev => move(ev, at));
  hit.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); move({ target: hit }, Math.max(0, Math.min(11, at + (ev.key === 'ArrowLeft' ? -1 : 1)))); }
  });
  const off = () => { cross.setAttribute('visibility', 'hidden'); tipHide(); };
  hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off);
  svg.append(hit);
  return svg;
}

/* Part-to-whole on an ordered scale: one 100% bar, 2px surface gaps between
   segments, a label inside a segment only when it fits. */
function stackBar(W, parts) {
  const H = 34, total = parts.reduce((s, p) => s + p.n, 0) || 1;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  const clip = 'clip' + Math.random().toString(36).slice(2, 8);
  svg.append(sv('clipPath', { id: clip }, sv('rect', { x: 0, y: 6, width: W, height: 22, rx: 4 })));
  const g = sv('g', { 'clip-path': `url(#${clip})` });
  let x = 0;
  const shown = parts.filter(p => p.n > 0);
  shown.forEach((p, i) => {
    const w = W * p.n / total, gw = i < shown.length - 1 ? 2 : 0;
    const seg = sv('g', { class: 'hitbar', tabindex: 0 });
    seg.append(sv('rect', { class: 'mk', x, y: 6, width: Math.max(0, w - gw), height: 22, fill: p.color }));
    const txt = `${p.label} ${fmtPct(p.n / total, 0)}`;
    if (txt.length * 6.4 + 14 < w - gw)
      seg.append(svText(x + (w - gw) / 2, 21, txt, { 'text-anchor': 'middle', style: `fill:${p.ink}` }));
    const show = ev => tipShow(ev, p.label, [{ color: p.color, label: t('pm.viz.projects'), value: `${fmtInt(p.n)} · ${fmtPct(p.n / total)}` },
                                             { label: t('pm.viz.value'), value: fmtMoney(p.v || 0) }]);
    seg.addEventListener('pointermove', show); seg.addEventListener('focus', show);
    seg.addEventListener('pointerleave', tipHide); seg.addEventListener('blur', tipHide);
    g.append(seg);
    x += w;
  });
  svg.append(g);
  return svg;
}

/* One row per project across the year: the planned window as a grey track,
   the actual span (request → handover, or → today while open) in the accent. */
function gantt(W, items, year) {
  const wrap = el('div', { className: 'gantt' });
  const y0 = Date.UTC(year, 0, 1), y1 = Date.UTC(year + 1, 0, 1);
  const pos = d => { if (!d) return null; const v = Date.parse(d + 'T00:00:00Z'); return Math.max(0, Math.min(100, (v - y0) / (y1 - y0) * 100)); };
  const ax = el('div', { className: 'gax' }, [el('div'), el('div')]);
  for (let m = 0; m < 12; m += 1) ax.lastChild.append(el('span', { style: `left:${(m + .5) / 12 * 100}%`, textContent: pmMonthName(m + 1) }));
  wrap.append(ax);
  const today = new Date().toISOString().slice(0, 10);
  const tpos = today.slice(0, 4) === String(year) ? pos(today) : null;
  for (const it of items) {
    // A department heading (timeline grouped by department).
    if (it.head !== undefined) { wrap.append(el('div', { className: 'ghead' }, [el('b', { textContent: it.head }), el('small', { textContent: it.sub || '' })])); continue; }
    const track = el('div', { className: 'gt', tabindex: 0 });
    const ps = pos(it.ps), pe = pos(it.pe);
    if (ps != null && pe != null && pe > ps) track.append(el('div', { className: 'pl', style: `left:${ps}%;width:${pe - ps}%` }));
    const as = pos(it.as), ae = pos(it.ae || (it.open ? today : null));
    if (as != null && ae != null && ae >= as) track.append(el('div', { className: 'ac' + (it.ae ? '' : ' open'), style: `left:${as}%;width:${Math.max(.6, ae - as)}%` }));
    if (tpos != null) track.append(el('div', { className: 'today', style: `left:${tpos}%` }));
    const show = ev => tipShow(ev, `${it.code} — ${it.name || ''}`, [
      { color: 'var(--track)', label: t('pm.viz.planned'), value: `${fmtDate(it.ps) || '—'} → ${fmtDate(it.pe) || '—'}` },
      { color: 'var(--series-2)', label: t('pm.viz.actual'), value: `${fmtDate(it.as) || '—'} → ${fmtDate(it.ae) || (it.open ? t('pm.viz.ongoing') : '—')}` },
      { label: t('pm.col.status'), value: t('pm.st.' + it.status) }]);
    track.addEventListener('pointermove', show); track.addEventListener('focus', show);
    track.addEventListener('pointerleave', tipHide); track.addEventListener('blur', tipHide);
    wrap.append(el('div', { className: 'gr' }, [
      el('div', { className: 'gl', title: `${it.code} — ${it.name || ''}` }, [el('code', { textContent: it.code }), document.createTextNode(it.name || '')]),
      track]));
  }
  return wrap;
}

/* ============================================================= dashboard */
async function pdLoad() {
  const out = $('#pdMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    const [years, finals, projects] = await Promise.all([
      SB.select('pm_budget_year', 'select=*'),
      SB.select('pm_budget_round', 'select=id,year,label&is_final=eq.true'),
      pmSelectAll('pm_project', 'select=*')
    ]);
    PM.dash.years = years;
    PM.dash.finals = finals;
    PM.dash.projects = projects;
    // For the progress card: documents (19_pm_workflow.sql) and money paid
    // (21_pm_payment.sql). Either may not exist yet — the card copes without.
    const [docs, money] = await Promise.all([
      pmSelectAll('pm_doc', 'select=project_code,doc_type,status,final:data->final').catch(() => null),
      pmSelectAll('pm_project_money', 'select=*').catch(() => null)]);
    PM.dash.docs = docs;
    PM.dash.money = money ? new Map(money.map(m => [m.project_code, m])) : null;
    const ys = [...new Set([...finals.map(f => f.year), ...projects.map(p => p.year)])].sort((a, b) => b - a);
    const ySel = $('#pdYear');
    const keep = +ySel.value;
    ySel.innerHTML = '';
    for (const y of ys) ySel.append(el('option', { value: y, textContent: y }));
    if (!ys.length) { msg(out, 'info', t('pm.dash.empty')); $('#pdBody').innerHTML = ''; return; }
    ySel.value = ys.includes(keep) ? keep : (ys.includes(new Date().getFullYear()) ? new Date().getFullYear() : ys[0]);
    selFill($('#pdPeriod'), [['Y', t('pm.per.year')], ...[1, 2, 3, 4].map(q => ['Q' + q, 'Q' + q]),
                             ...Array.from({ length: 12 }, (_, i) => ['M' + (i + 1), pmMonthName(i + 1)])]);
    selFill($('#pdBud'), [['', t('pm.f.all')], ['1', t('pm.f.budgetedOnly')], ['0', t('pm.f.unbudgetedOnly')]]);
    await pdYearChanged();
    msg(out, '', '');
  } catch (e) { msg(out, 'err', e.message); }
}

async function pdYearChanged() {
  const y = +$('#pdYear').value;
  PM.dash.year = y;
  const f = PM.dash.finals.find(r => r.year === y);
  PM.dash.lines = f ? await pmSelectAll('pm_budget_line', `select=*&round_id=eq.${f.id}`) : [];
  PM.dash.yearRow = PM.dash.years.find(r => r.year === y) || null;
  const depts = [...new Set([...PM.dash.lines.map(l => l.dept_code), ...PM.dash.projects.filter(p => p.year === y).map(p => p.dept_code)].filter(Boolean))].sort();
  const cats = [...new Set(PM.dash.lines.map(l => l.project_category).filter(Boolean))].sort();
  msSetup('pdEnt', PM_ENTITIES.map(e => ({ v: e, t: `${e} — ${t('perms.ent.' + e)}` })));
  msSetup('pdDept', depts.map(d => ({ v: d, t: d })));
  msSetup('pdCat', cats.map(c => ({ v: c, t: c })));
  msSetup('pdStatus', PM_STATUS.map(s => ({ v: s, t: t('pm.st.' + s) })));
  for (const id of ['pdEnt', 'pdDept', 'pdCat', 'pdStatus']) MS[id].onChange = pdRender;
  pdRender();
}

function pdPeriodMonths() {
  const v = $('#pdPeriod').value || 'Y';
  if (v === 'Y') return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  if (v[0] === 'Q') { const q = +v.slice(1); return [q * 3 - 2, q * 3 - 1, q * 3]; }
  return [+v.slice(1)];
}

function pdRender() {
  MONEY.year = PM.dash.year;
  const box = $('#pdBody');
  if (!PM.dash.year) return;
  const y = PM.dash.year, months = pdPeriodMonths(), fullYear = months.length === 12;
  const ent = msValues('pdEnt'), dep = msValues('pdDept'), cat = msValues('pdCat'), sts = msValues('pdStatus');
  const bud = $('#pdBud').value;
  const byMain = new Map();
  for (const p of PM.dash.projects) { const a = byMain.get(p.main_code) || []; a.push(p); byMain.set(p.main_code, a); }
  const lineStatus = l => {
    const ps = byMain.get(l.project_code) || byMain.get(l.current_code);
    if (!ps) return 'pending';
    return ps.every(p => p.status === 'completed') ? 'completed' : ps.every(p => p.status === 'cancelled') ? 'cancelled'
      : ps.some(p => p.status !== 'pending') ? 'in_progress' : 'pending';
  };
  const common = (dept, pcat) => (!ent.length || ent.includes(pmEntity(dept))) && (!dep.length || dep.includes(dept))
    && (!cat.length || cat.includes(pcat));
  const lines = bud === '0' ? [] : PM.dash.lines.filter(l => common(l.dept_code, l.project_category)
    && (!sts.length || sts.includes(lineStatus(l))));
  const lineCat = new Map(PM.dash.lines.map(l => [l.project_code, l.project_category]));
  const projOk = p => common(p.dept_code, p.project_category || lineCat.get(p.main_code))
    && (!sts.length || sts.includes(p.status)) && (bud === '' || String(Number(p.budgeted)) === bud);
  const inPeriod = d => d && d.slice(0, 4) === String(y) && months.includes(+d.slice(5, 7));
  const projects = PM.dash.projects.filter(p => p.year === y && projOk(p));
  const committedSet = fullYear ? projects : projects.filter(p => inPeriod(p.purchase_date));
  const carried = PM.dash.projects.filter(p => p.year < y && projOk(p) && !['completed', 'cancelled'].includes(p.status));

  const budget = pmSum(lines, 'estimated_value');
  const planned = pmSum(lines, l => months.reduce((s, m) => s + (Number(l[PM_MONTHS[m - 1]]) || 0), 0));
  const committed = pmSum(committedSet, 'contract_value');
  const overrunRows = committedSet.filter(p => p.contract_value != null && p.estimated_value != null && p.contract_value > p.estimated_value);
  const overrun = pmSum(overrunRows, p => p.contract_value - p.estimated_value);
  const done = projects.filter(p => p.status === 'completed').length;
  const unb = projects.filter(p => !p.budgeted);
  const yr = PM.dash.yearRow || {};
  const cap = yr.ssp_cap != null ? Number(yr.ssp_cap) : (yr.ssp_revenue != null ? Number(yr.ssp_revenue) * Number(yr.reserve_pct || 3) / 100 : null);
  const sspBudget = pmSum(lines.filter(l => pmEntity(l.dept_code) === 'SSP'), 'estimated_value');
  const perLabel = ($('#pdPeriod').selectedOptions[0] || {}).text || '';

  box.innerHTML = '';
  // Three clusters (user 25/09/2026): the money, the projects, the cycle time.
  const fig = (label, value, sub, cls) => el('div', { className: 'dfig' + (cls ? ' ' + cls : '') }, [el('span', { className: 'sl', textContent: label }),
    el('b', { textContent: value }), el('small', { textContent: sub || '' })]);
  // 1. Money, in boxes of equal width (feedback 25/09/2026 — the SSP cap meter
  //    left this row; the cap still marks the ceiling in Overall progress):
  //    the approved budget, committed, not yet committed, paid, overrun.
  const nBudget = new Set(lines.map(l => l.project_code)).size;
  const lead = el('div', { className: 'dlead' }, [
    el('span', { className: 'hl', textContent: t('pm.dash.budget', { y }) }),
    el('span', { className: 'hv', textContent: fmtM(budget) }),
    ...(fullYear ? [] : [el('span', { className: 'hs', textContent: t('pm.dash.plannedIn', { p: perLabel, v: fmtM(planned) }).replace(/^ · /, '') })])]);
  const paidAll = pmSum(projects, pdPaidNet);
  const valFigs = [fig(fullYear ? t('pm.dash.committed') : t('pm.dash.committedIn', { p: perLabel }), fmtM(committed),
                       budget ? t('pm.dash.ofBudget', { pct: fmtPct(committed / budget) }) : '')];
  if (fullYear) valFigs.push(fig(t('pm.dash.remaining'), fmtM(budget - committed), budget ? t('pm.dash.ofBudget', { pct: fmtPct((budget - committed) / budget) }) : ''));
  valFigs.push(fig(t('pm.dash.paid'), fmtM(paidAll), budget ? t('pm.dash.paidSub', { pct: fmtPct(paidAll / budget) }) : ''));
  valFigs.push(fig(t('pm.dash.overrun'), fmtM(overrun), t('pm.dash.overrunSub', { n: fmtInt(overrunRows.length) }), overrun > 0 ? 'down' : ''));
  const valCard = el('div', { className: 'hero dtop dval', style: `grid-template-columns:repeat(${valFigs.length + 1},minmax(0,1fr))` }, [lead, ...valFigs]);
  // 2. Projects: in the budget, outside it, done, and carried forward from earlier years.
  const prjCard = el('div', { className: 'hero dtop' }, [
    el('span', { className: 'hl', textContent: t('pm.dash.projectsH', { y }) }),
    el('div', { className: 'dfigs n4' }, [
      fig(t('pm.dash.budgetedN'), fmtInt(nBudget), t('pm.dash.budgetedSub', { v: fmtM(budget) })),
      fig(t('pm.dash.unbudgeted'), fmtInt(unb.length), fmtM(pmSum(unb, p => p.contract_value ?? p.estimated_value))),
      fig(t('pm.dash.completed'), projects.length ? fmtPct(done / projects.length, 0) : '—',
          t('pm.dash.completedSub', { done: fmtInt(done), n: fmtInt(projects.length) })),
      fig(t('pm.dash.carried'), fmtInt(carried.length), t('pm.dash.carriedSub', { v: fmtM(pmSum(carried, 'estimated_value')) }))])]);
  // 3. Cycle time between the dated steps.
  const span = (a, b) => { const v = projects.map(p => p[a] && p[b] && p[b] >= p[a] ? (Date.parse(p[b]) - Date.parse(p[a])) / 864e5 : null).filter(v => v != null);
                           return { avg: v.length ? v.reduce((s, x) => s + x, 0) / v.length : null, n: v.length }; };
  const cycCard = el('div', { className: 'hero dtop' }, [
    el('span', { className: 'hl', textContent: t('pm.dash.cycH') }),
    el('div', { className: 'dfigs n3' }, [['request_date', 'approve_date', 'pm.dash.cyc1'], ['approve_date', 'purchase_date', 'pm.dash.cyc2'],
                                       ['purchase_date', 'handover_date', 'pm.dash.cyc3']].map(([a, b, k]) => {
      const s = span(a, b);
      return fig(t(k), s.avg == null ? '—' : t('pm.dash.days', { n: fmtInt(Math.round(s.avg)) }), t('pm.dash.cycSub', { n: fmtInt(s.n) }));
    }))]);
  const kpis = el('div', { className: 'dkpis3' }, [valCard, prjCard, cycCard]);
  box.append(kpis);

  const charts = el('div', { className: 'charts' });
  const C1 = 'var(--series-1)', C2 = 'var(--series-2)';
  // 1. Budget vs committed by department.
  const depKeys = [...new Set([...lines.map(l => l.dept_code), ...committedSet.map(p => p.dept_code)].filter(Boolean))];
  const bV = new Map(), cV = new Map();
  for (const l of lines) bV.set(l.dept_code, (bV.get(l.dept_code) || 0) + (Number(l.estimated_value) || 0));
  for (const p of committedSet) cV.set(p.dept_code, (cV.get(p.dept_code) || 0) + (Number(p.contract_value) || 0));
  depKeys.sort((a, b) => (bV.get(b) || 0) - (bV.get(a) || 0));
  const depCats = depKeys.map(k => ({ key: k, label: k }));
  const s1 = [{ label: t('pm.viz.budget'), color: '#9fb8dc', values: bV }, { label: t('pm.viz.committed'), color: '#0b1f3a', values: cV }];
  charts.append(chartCard(t('pm.viz.byDept'), null, [{ label: s1[0].label, color: C1 }, { label: s1[1].label, color: C2 }],
    W => hbarChart(W, depCats, s1),
    () => [[t('pm.col.dept'), s1[0].label, s1[1].label], ...depKeys.map(k => [k, fmtMoney(bV.get(k) || 0), fmtMoney(cV.get(k) || 0)])]));
  // 2. Budget by project category (one series: one colour, no legend box).
  const catV = new Map();
  for (const l of lines) { const k = l.project_category || t('pm.viz.uncategorised'); catV.set(k, (catV.get(k) || 0) + (Number(l.estimated_value) || 0)); }
  const catKeys = [...catV.keys()].sort((a, b) => catV.get(b) - catV.get(a));
  charts.append(chartCard(t('pm.viz.byCat'), null, null,
    W => hbarChart(W, catKeys.map(k => ({ key: k, label: k })), [{ label: t('pm.viz.budget'), color: '#9fb8dc', values: catV }]),
    () => [[t('pm.col.projCat'), t('pm.viz.budget'), t('pm.viz.share')], ...catKeys.map(k => [k, fmtMoney(catV.get(k)), fmtPct(catV.get(k) / (budget || 1))])]));
  // 3. Overall progress: how much of the budget is committed, how far the
  //    projects have got on average, and paid against budget and ceiling.
  charts.append(pdProgressCard({ lines, projects, budget, committed, cap, sspBudget,
                                 capInScope: !!cap && (!ent.length || ent.includes('SSP')) }));
  // 4. Risk mix (order: risk mix > cumulative > timeline, user 25/09/2026) — ordered, so an ordinal ramp, darkest = most severe.
  const ramp = [['Critical', '#0d366b', '#fff'], ['High', '#1c5cab', '#fff'], ['Medium', '#3987e5', '#fff'], ['Low', '#86b6ef', '#1f2937']];
  const parts = ramp.map(([k, c, ink]) => ({ label: pmRiskName(k), color: c, ink, n: lines.filter(l => l.risk_level === k).length,
    v: pmSum(lines.filter(l => l.risk_level === k), 'estimated_value') }));
  const other = lines.filter(l => !PM_RISK.includes(l.risk_level));
  if (other.length) parts.push({ label: t('pm.viz.notAssessed'), color: '#d5dbe6', ink: '#1f2937', n: other.length, v: pmSum(other, 'estimated_value') });
  const riskCard = chartCard(t('pm.viz.risk'), t('pm.viz.riskSub', { n: fmtInt(lines.length) }),
    parts.filter(p => p.n).map(p => ({ label: `${p.label} · ${fmtInt(p.n)}`, color: p.color })),
    W => stackBar(W, parts),
    () => [[t('pm.col.risk'), t('pm.viz.projects'), t('pm.viz.share'), t('pm.viz.value')], ...parts.map(p => [p.label, fmtInt(p.n), fmtPct(p.n / (lines.length || 1)), fmtMoney(p.v)])],
    true);   // full row: alone in a half-width slot it left the other half empty
  charts.append(riskCard);
  // 5. Plan vs committed, cumulative by month.
  const plan = [], act = [];
  let pc = 0, ac = 0;
  for (let m = 1; m <= 12; m++) {
    pc += pmSum(lines, PM_MONTHS[m - 1]);
    ac += pmSum(projects.filter(p => p.purchase_date && p.purchase_date.slice(0, 7) === `${y}-${String(m).padStart(2, '0')}`), 'contract_value');
    plan.push(pc); act.push(ac);
  }
  const mNames = Array.from({ length: 12 }, (_, i) => pmMonthName(i + 1));
  const hasPlan = pc > 0;
  const s3 = [{ label: t('pm.viz.plannedCum'), color: '#9fb8dc', values: plan }, { label: t('pm.viz.committedCum'), color: '#0b1f3a', values: act }];
  charts.append(chartCard(t('pm.viz.overTime'), hasPlan ? null : t('pm.viz.noPhasing'),
    [{ label: s3[0].label, color: C1, line: true }, { label: s3[1].label, color: C2, line: true }],
    W => lineChart(W, mNames, s3, months),
    () => [[t('pm.viz.month'), s3[0].label, s3[1].label], ...mNames.map((m, i) => [m, fmtMoney(plan[i]), fmtMoney(act[i])])], true));
  // 6. Timeline.
  const lineOf = new Map(PM.dash.lines.map(l => [l.project_code, l]));
  const items = projects.map(p => {
    const l = lineOf.get(p.main_code) || {};
    return { code: p.code, name: p.name, status: p.status, dept: p.dept_code, ps: p.planned_start || l.start_date, pe: p.planned_end || l.end_date,
             as: p.request_date, ae: p.status === 'completed' ? p.handover_date : null, open: !['completed', 'cancelled'].includes(p.status) && !!p.request_date };
  }).sort((a, b) => (a.as || a.ps || '9') .localeCompare(b.as || b.ps || '9'));
  const cap40 = 40;
  let showAll = false;
  // Option (user 25/09/2026): the projects grouped by department, a heading
  // per department with how many of its projects are done.
  const byDept = () => {
    const groups = new Map();
    for (const it of items) (groups.get(it.dept) || groups.set(it.dept, []).get(it.dept)).push(it);
    return [...groups].sort((a, b) => pmDeptName(a[0]).localeCompare(pmDeptName(b[0]), pmLoc()))
      .flatMap(([d, list]) => [{ head: pmDeptName(d) || '—', sub: t('pm.viz.deptDone', { done: fmtInt(list.filter(i => i.status === 'completed').length), n: fmtInt(list.length) }) }, ...list]);
  };
  const gCard = chartCard(t('pm.viz.timeline'), t('pm.viz.timelineSub', { n: fmtInt(items.length) }),
    [{ label: t('pm.viz.planned'), color: 'var(--track)' }, { label: t('pm.viz.actual'), color: C2 }],
    W => {
      const w = el('div');
      const seg = el('div', { className: 'seg gseg' });
      for (const [on, k] of [[false, 'pm.viz.byProject'], [true, 'pm.viz.byDeptTl']]) {
        const b = el('button', { textContent: t(k) });
        b.classList.toggle('on', !!PM.dash.tlByDept === on);
        b.onclick = () => { PM.dash.tlByDept = on; gCard._draw(); };
        seg.append(b);
      }
      w.append(seg);
      if (PM.dash.tlByDept) { w.append(gantt(W, byDept(), y)); return w; }
      w.append(gantt(W, showAll ? items : items.slice(0, cap40), y));
      if (items.length > cap40) {
        const more = el('button', { className: 'btn tiny', style: 'margin-top:8px',
          textContent: showAll ? t('pm.viz.showFewer') : t('pm.viz.showAll', { n: fmtInt(items.length) }) });
        more.onclick = () => { showAll = !showAll; gCard._draw(); };
        w.append(more);
      }
      return w;
    },
    () => [[t('pm.col.code'), t('pm.viz.planned'), t('pm.viz.actual'), t('pm.col.status')],
           ...items.map(i => [i.code, `${fmtDate(i.ps) || '—'} → ${fmtDate(i.pe) || '—'}`, `${fmtDate(i.as) || '—'} → ${fmtDate(i.ae) || (i.open ? t('pm.viz.ongoing') : '—')}`, t('pm.st.' + i.status)])], true);
  charts.append(gCard);
  box.append(charts);
  for (const c of charts.children) c._draw && c._draw();
}

/* How far one project has got, 0..1: the share of its documents approved
   (PR, RR on a replacement, PA, QC, MC, PO, final AH), or of its milestone
   dates for projects loaded from the Excel dossiers — whichever is further. */
function pdCompletion(p, docs) {
  if (p.status === 'completed') return 1;
  const types = ['PR', ...(/replace/i.test(p.investment_type || '') ? ['RR'] : []), 'PA', 'QC', 'MC', 'PO', 'AH'];
  const mine = (docs || []).filter(d => d.project_code === p.code && d.status === 'approved');
  const byDocs = types.filter(ty => mine.some(d => d.doc_type === ty && (ty !== 'AH' || d.final === true || d.final === 'true'))).length / types.length;
  const dates = ['request_date', 'assess_date', 'approve_date', 'purchase_date', 'handover_date'];
  const byDates = dates.filter(k => p[k]).length / dates.length;
  return Math.max(byDocs, byDates);
}
// Paid so far, pre-tax (bank amount ÷ 1 + the VAT rate its invoices show, else 8%) — as ppPaid.
function pdPaidNet(p) {
  const m = PM.dash.money && PM.dash.money.get(p.code);
  if (!m || !(Number(m.paid_gross) > 0)) return 0;
  const vat = Number(m.invoiced_net) > 0 ? Number(m.invoiced_vat) / Number(m.invoiced_net) : 0.08;
  return Number(m.paid_gross) / (1 + vat);
}

/* The progress card: three meters and one bullet bar.
   - budget implementation = committed ÷ approved budget
   - average completion    = mean of pdCompletion over the budget projects
                             (a budget line with no project yet counts 0)
   - paid ÷ budget, and the bullet: paid (navy) inside budget (pale blue)
     against the ceiling (tick) — the SSP cap (3% FF&E reserve) plus the CP /
     JVC budgets, which have no cap of their own. */
function pdProgressCard(x) {
  const { lines, projects, budget, committed, cap, sspBudget, capInScope } = x;
  const byMain = new Map();
  for (const p of projects) if (p.status !== 'cancelled') (byMain.get(p.main_code) || byMain.set(p.main_code, []).get(p.main_code)).push(p);
  const mains = [...new Set(lines.map(l => l.project_code))];
  const items = [...mains.map(c => { const ps = byMain.get(c) || [];
                                     return ps.length ? ps.reduce((s, p) => s + pdCompletion(p, PM.dash.docs), 0) / ps.length : 0; }),
                 ...projects.filter(p => !p.budgeted && p.status !== 'cancelled').map(p => pdCompletion(p, PM.dash.docs))];
  const avgDone = items.length ? items.reduce((s, v) => s + v, 0) / items.length : null;
  const paid = pmSum(projects, pdPaidNet);
  const ceiling = capInScope ? cap + (budget - sspBudget) : null;
  const top = Math.max(budget, ceiling || 0, paid, committed) || 1;
  const legend = [{ label: t('pm.prog.paid'), color: '#0b1f3a' }, { label: t('pm.prog.budget'), color: '#9fb8dc' },
                  ...(ceiling ? [{ label: t('pm.prog.ceiling'), color: 'var(--ink-3)' }] : [])];
  const rows = [
    ['pm.prog.impl', budget ? committed / budget : null, t('pm.prog.implSub', { v: fmtM(committed), b: fmtM(budget) })],
    ['pm.prog.avg', avgDone, t('pm.prog.avgSub', { n: fmtInt(items.length) })],
    ['pm.prog.paidPct', budget ? paid / budget : null, t('pm.prog.paidSub', { v: fmtM(paid), b: fmtM(budget) })]];
  return chartCard(t('pm.prog.h'), null, legend, () => {
    const w = el('div', { className: 'prog' });
    for (const [k, v, sub] of rows) w.append(el('div', { className: 'pgrow', title: sub }, [
      el('div', { className: 'pgh' }, [el('span', { textContent: t(k) }), el('b', { textContent: v == null ? '—' : fmtPct(v, 0) })]),
      el('div', { className: 'meter' + (v > 1 ? ' over' : '') }, el('i', { style: `width:${Math.min(100, Math.max(0, (v || 0) * 100))}%` })),
      el('small', { textContent: sub })]));
    // Bullet: paid inside budget, ceiling as a tick.
    const pc = v => `${Math.min(100, (v / top) * 100)}%`;
    const bullet = el('div', { className: 'bullet' }, [
      el('i', { className: 'bb', style: `width:${pc(budget)}`, title: `${t('pm.prog.budget')}: ${fmtM(budget)}` }),
      el('i', { className: 'bp', style: `width:${pc(paid)}`, title: `${t('pm.prog.paid')}: ${fmtM(paid)}` }),
      ...(ceiling ? [el('i', { className: 'bc', style: `left:${pc(ceiling)}`, title: `${t('pm.prog.ceiling')}: ${fmtM(ceiling)}` })] : [])]);
    w.append(el('div', { className: 'pgrow' }, [
      el('div', { className: 'pgh' }, [el('span', { textContent: t('pm.prog.bullet') })]), bullet,
      el('small', { textContent: [`${t('pm.prog.paid')} ${fmtM(paid)}`, `${t('pm.prog.budget')} ${fmtM(budget)}`,
                                  ceiling ? `${t('pm.prog.ceiling')} ${fmtM(ceiling)}` : t('pm.prog.noCap')].join(' · ') })]));
    return w;
  }, () => [[t('pm.prog.h'), t('pm.viz.value')],
            ...rows.map(([k, v]) => [t(k), v == null ? '—' : fmtPct(v, 1)]),
            [t('pm.prog.paid'), fmtMoney(paid)], [t('pm.prog.budget'), fmtMoney(budget)],
            [t('pm.prog.ceiling'), ceiling ? fmtMoney(ceiling) : '—']]);
}

let PD_RESIZE = null;
window.addEventListener('resize', () => {
  if (VIEW !== 'pmdash') return;
  clearTimeout(PD_RESIZE);
  PD_RESIZE = setTimeout(() => { for (const c of $$('#pdBody .chartcard')) c._draw && c._draw(); }, 150);
});

function initPm() {
  $('#btnPiBudRead').onclick = piBudRead;
  $('#btnPiBudGo').onclick = piBudGo;
  $('#btnPiDosRead').onclick = piDosRead;
  $('#btnPiDosGo').onclick = piDosGo;
  $('#pbYear').onchange = () => pbYearChanged(false);
  $('#pbRound').onchange = pbRoundChanged;
  for (const id of ['pbEnt', 'pbDept', 'pbRisk', 'ppEnt', 'ppDept', 'ppStatus']) msSetup(id, []);
  MS.pbEnt.onChange = MS.pbDept.onChange = MS.pbRisk.onChange = () => pbRender();
  MS.ppEnt.onChange = MS.ppDept.onChange = MS.ppStatus.onChange = () => ppRender();
  $('#pbQ').oninput = () => pbRender();
  $('#pbPhase').onchange = () => pbRender();
  $('#ppYear').onchange = () => ppRender();
  $('#ppBud').onchange = () => ppRender();
  $('#ppQ').oninput = () => ppRender();
  for (const id of ['pdEnt', 'pdDept', 'pdCat', 'pdStatus']) msSetup(id, []);
  $('#pdYear').onchange = pdYearChanged;
  $('#pdPeriod').onchange = pdRender;
  $('#pdBud').onchange = pdRender;
}

/* ============================================================== WORKFLOW
   Phase 3: the procurement documents and their approval chains.

   The browser never changes a document's status itself. Create, save, submit,
   approve, return, reject and cancel all go through functions in
   19_pm_workflow.sql, which hold the rules: the right order, the right person
   for the step (role + department scope + the "approve" right), and the
   preparer never approving their own document. What this file adds is the
+— one generic editor driven by WF_SPECS, plus a custom one for the QC
   scoring matrix — the inbox, the chain editor and the printed form. */

const WF = { types: [], chains: [], roles: [], doc: null, steps: [], events: [], project: null,
             line: null, docs: [], year: null, inbox: [], entity: 'SSP', dirty: false };
const WF_ORDER = ['PR', 'RR', 'PA', 'QC', 'MC', 'PO', 'CT', 'AH'];
const WF_STATUS = ['draft', 'in_review', 'returned', 'rejected', 'approved', 'cancelled'];

/* Risk thresholds from the Menu sheet of the FFE template. */
const wfRisk = a => a == null || !isFinite(a) ? null : a >= 16 ? 'Critical' : a >= 12 ? 'High' : a >= 8 ? 'Medium' : 'Low';
const WF_SUGGEST = { Critical: 'Need to be processed immediately', High: 'Need to be processed ASAP',
                     Medium: 'Need to be processed as scheduled', Low: 'Consider to be processed next term' };
const n0 = v => Number(v) || 0;
const wfSum = (rows, f) => (rows || []).reduce((s, r) => s + n0(typeof f === 'function' ? f(r) : r[f]), 0);
// Only http(s) links: an attachment is a OneDrive/SharePoint URL, never script.
const wfSafeUrl = u => /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : null;

/* Drop-down lists, word for word from the Menu sheet of "FFE Procurement
   Document.xlsx". The forms below reproduce that workbook, so the choices must
   be the ones the departments already pick from. */
const QC_PTYPES = ['Mua sắm/Equipment', 'Xây lắp/Construction', 'Hỗn hợp/Mixed'];
const QC_ABILITY = ['Vốn điều lệ/Capital', 'SL hợp đồng tương tự/Similar contract',
                    'Giá trị hợp đồng tương tự/Similar contract value', 'Năng lực thiết bị/Equipment', 'Uy tín/Rating'];
const QC_TECH_EQ = ['Tiến độ nhập hàng/Progress', 'Điều khoản lắp đặt/Installation term', 'Bảo hành/Warranty',
                    'Bảo trì/Maintenance', 'Yếu tố bền vững/Sustainability', 'Chứng nhận CO, CQ/CO, CQ',
                    'Dịch vụ hậu mãi/After-sales service'];
const QC_TECH_CO = ['Biện pháp thi công/Method statement', 'Tiến độ thi công/Schedule', 'Tiến độ nhập hàng/Procurement',
                    'Biện pháp bảo đảm chất lượng/Quality assurance', 'Bảo hành/Warranty', 'Bảo trì/Maintenance',
                    'Quy trình kiểm soát/Quality Control'];
const qcTechFor = pt => /x[aâ]y|constr|h[oỗ]n|mix/i.test(pt || '') ? QC_TECH_CO : QC_TECH_EQ;
// Equal weights that add up to exactly 100: the last one takes the rounding.
const qcSubs = labels => { const w = Math.floor(10000 / labels.length) / 100;
  return labels.map((l, i) => ({ label: l, w: i < labels.length - 1 ? w : Math.round((100 - w * (labels.length - 1)) * 100) / 100 })); };
const off100 = v => Math.abs(v - 100) > 0.01;

const WF_COND = ['Full operational', 'Poor', 'Damaged'];     // the workbook's words (Menu!BI)
const WF_RR_REASON = ['High repair cost', 'Obsolete', 'Irreparable', 'Breakage/loss'];
const WF_RISK_CAT = ["People's Health & Safety", 'Technical Issues', 'Reputation Damage', 'Incident Acknowledgement',
                     'Periodic Internal Assessment', 'Legal Compliance', 'HACCP Fail Point', 'Public Negative Feedback',
                     "Employee's Complaint", 'Financial Efficiency', 'Operational Inconsistency',
                     'Competitive Advantage Lost', 'Touchpoints', 'Productivity'];
const WF_COMPARE = {
  Comparable: 'The specifications of the requested items can be found in the market.',
  Incomparable: 'Unique designs or solution or the specification of the requested items can not be found in the market.'
};
const MC_TEXT = {
  ok: 'The price of the items on the selected quotation is assessed to be acceptable within the allowable variance.',
  over: 'The price of the items on the selected quotation exceeds the allowable variance. It is recommended to reevaluate the current unit prices in the quotation.',
  na: 'This is a project where market prices cannot be checked because the items are related to technical factors, have a construction-related nature, or are specialized products with prices not publicly disclosed.'
};

/* Procurement decision matrix (Menu sheet, "Procurement decision process"):
   project type × risk level × value band → procurement type. The forms show it
   as the suggestion; the preparer can still choose otherwise. */
const PROC_OPTS = ['Direct Appointment', 'Direct Procurement', 'Competitive Quotation', 'Public Tender'];
const PROC_BANDS = [200e6, 500e6, 1e9, 5e9];                 // ≤200 triệu · ≤500 triệu · ≤1 tỷ · ≤5 tỷ · >5 tỷ
const PROC_MATRIX = {
  'Non-consultancy': {
    Critical: ['Direct Appointment', 'Direct Appointment', 'Direct Procurement', 'Competitive Quotation', 'Public Tender'],
    High:     ['Direct Appointment', 'Direct Procurement', 'Direct Procurement', 'Competitive Quotation', 'Public Tender'],
    Medium:   ['Direct Procurement', 'Competitive Quotation', 'Competitive Quotation', 'Competitive Quotation', 'Public Tender'],
    Low:      ['Competitive Quotation', 'Competitive Quotation', 'Competitive Quotation', 'Competitive Quotation', 'Public Tender']
  },
  Consultancy: {
    Critical: ['Direct Appointment', 'Competitive Quotation', 'Public Tender', 'Public Tender', 'Public Tender'],
    High:     ['Competitive Quotation', 'Competitive Quotation', 'Public Tender', 'Public Tender', 'Public Tender'],
    Medium:   ['Public Tender', 'Public Tender', 'Public Tender', 'Public Tender', 'Public Tender'],
    Low:      ['Public Tender', 'Public Tender', 'Public Tender', 'Public Tender', 'Public Tender']
  }
};
function procSuggest(ptype, risk, value) {
  const m = PROC_MATRIX[ptype === 'Consultancy' ? 'Consultancy' : 'Non-consultancy'][risk];
  if (!m || !(n0(value) > 0)) return '';
  const band = PROC_BANDS.findIndex(b => n0(value) <= b);
  return m[band < 0 ? 4 : band];
}

/* The PA warning (feedback 25/09/2026), shown beside the form, never blocking:
     budgeted   → over budget by more than 10% OR by more than USD 5,000;
     unbudgeted → a value above USD 50,000. */
function paGate(d, c) {
  if (c.budgeted) {
    if (c.budgetValue == null) return { ok: false, text: t('wf.pa.noBudget') };
    const over = c.prTotal - c.budgetValue;
    const warn = over > 0 && (over / c.budgetValue > 0.10 || over > 5000 * c.fx);
    return { ok: !warn, text: t(warn ? 'wf.pa.failBud' : 'wf.pa.passBud', { pct: fmtPct(over / c.budgetValue), usd: fmtInt(Math.round(over / c.fx)) }) };
  }
  const warn = c.prTotal > 50000 * c.fx;
  return { ok: !warn, text: t(warn ? 'wf.pa.failUnb' : 'wf.pa.passUnb', { usd: fmtInt(Math.round(c.prTotal / c.fx)) }) };
}

// A QC criterion in English only ("Vốn điều lệ/Capital" → "Capital"); the stored label keys the scores, so it is not changed.
const qcLabel = s => { s = String(s || ''); const i = s.lastIndexOf('/'); return i > 0 && /[^\x00-\x7F]/.test(s.slice(0, i)) ? s.slice(i + 1).trim() : s; };
// One vendor's spec of one line: the fields filled in ("Brand: X; Model: Y"), then any free text.
function qcSpecText(v, i) {
  const sx = (v.specx || {})[i] || {};
  const parts = FS_SPEC_COLS.map(([h, k]) => sx[k || 'origin'] ? `${h}: ${sx[k || 'origin']}` : '').filter(Boolean);
  const free = (v.specs || {})[i];
  return [...parts, ...(free ? [free] : [])].join('; ');
}

/* Market check: an old price is brought forward to today's value at 4.6% a
   year (the "Time Money Value" block of the MC sheet: FV = PV × (1 + r)^n). */
const MC_RATE = 0.046, MC_TOL = 0.10;
const mcFv = (pv, year) => !n0(pv) ? null
  : Math.round(n0(pv) * Math.pow(1 + MC_RATE, Math.max(0, new Date().getFullYear() - (n0(year) || new Date().getFullYear()))));

/* ------------------------------------------------------- QC scoring maths
   Vendor A is the chosen vendor, as in the workbook (columns A / B / C).
   ability / technique = Σ sub-weight × sub-score. Finance = price weight ×
   (lowest price ÷ this price × 100) + payment weight × payment score — the
   formula that reproduces the guide's worked example. Total = Σ criterion
   weight × criterion score. Amounts come from the appendix item lines. */
function qcScore(d) {
  const lines = d.qlines || [];
  for (const v of d.vendors || []) {
    v.prices = v.prices || {};
    const priced = lines.some((l, i) => n0(v.prices[i]) > 0);
    // The items, plus the vendor's overhead lines (transport, installation, consumables…).
    const over = (d.olines || []).reduce((s, o, i) => s + n0((v.oprices || {})[i]), 0);
    v.amount = priced ? lines.reduce((s, l, i) => s + n0(l.qty) * n0(v.prices[i]), 0) + over : (lines.length ? null : v.amount);
  }
  const vs = (d.vendors || []).filter(v => v.name);
  const priced = vs.map(v => n0(v.amount)).filter(a => a > 0);
  const low = priced.length ? Math.min(...priced) : 0;
  const sub = (list, scores) => list.reduce((s, it) => s + n0(it.w) / 100 * n0((scores || {})[it.label]), 0);
  for (const v of vs) {
    v.ability = Math.round(sub(d.sub_ability || [], v.s_ability) * 100) / 100;
    v.technique = Math.round(sub(d.sub_technique || [], v.s_technique) * 100) / 100;
    v.price_score = n0(v.amount) > 0 && low ? Math.round(low / n0(v.amount) * 10000) / 100 : 0;
    v.finance = Math.round((n0(d.w_price) / 100 * v.price_score + n0(d.w_pay) / 100 * n0(v.pay_score)) * 100) / 100;
    v.total = Math.round((n0(d.w_ability) / 100 * v.ability + n0(d.w_technique) / 100 * v.technique
                          + n0(d.w_finance) / 100 * v.finance) * 100) / 100;
  }
  const best = vs.slice().sort((a, b) => b.total - a.total)[0];
  const problems = [];
  if (off100(n0(d.w_ability) + n0(d.w_technique) + n0(d.w_finance))) problems.push(t('wf.qc.w100'));
  if ([d.w_ability, d.w_technique, d.w_finance].some(w => !(n0(w) > 0))) problems.push(t('wf.qc.w0'));
  for (const [k, list] of [['ability', d.sub_ability], ['technique', d.sub_technique]])
    if (off100(wfSum(list, 'w'))) problems.push(t('wf.qc.sub100', { c: t('wf.qc.' + k) }));
  if (off100(n0(d.w_price) + n0(d.w_pay))) problems.push(t('wf.qc.fin100'));
  if (vs.length < 3 && n0(d.total_vendors) < 3) problems.push(t('wf.qc.few'));
  if (!d.chosen_vendor) problems.push(t('wf.qc.noChoice'));
  else if (best && best.name !== d.chosen_vendor) problems.push(t('wf.qc.notBest', { best: best.name }));
  return { vendors: vs, best, problems };
}

/* ------------------------------------------------------------- context */
// What a document needs from the rest of the project: the budget value, the
// FX rate of the budget year, the PR total, the PO lines an AH starts from.
function wfCtx() {
  const p = WF.project || {}, byType = {};
  for (const d of WF.docs) if (!['cancelled', 'rejected'].includes(d.status)) (byType[d.doc_type] = byType[d.doc_type] || []).push(d);
  const pr = (byType.PR || [])[0];
  const l = WF.line;
  const share = p.share_pct != null ? Number(p.share_pct) : 1;
  return {
    budgeted: !!p.budgeted,
    budgetValue: l && l.estimated_value != null ? Math.round(Number(l.estimated_value) * (share || 1)) : null,
    fx: Number((WF.year || {}).fx_rate) || 26000,
    prTotal: pr ? n0(pr.total_value) : n0(p.estimated_value),
    prAssessment: pr && pr.data ? (n0(pr.data.possibility) * n0(pr.data.impact) || null) : (p.assessment != null ? Number(p.assessment) : null),
    // Earlier documents the later sheets read from (PA from PR, MC / PO from QC).
    prData: (pr && pr.data) || {},
    qcData: (((byType.QC || []).find(q => q.status === 'approved') || (byType.QC || [])[0]) || {}).data || {},
    byType
  };
}

/* Client mirror of pm_can_prepare / the step check — only to decide which
   buttons to show. The database decides for real. */
function wfCovers(scope, dept) {
  if (!scope) return false;
  const root = PM.orgMap.get(scope);
  if (root && !root.parent_code) return true;
  let o = PM.orgMap.get(dept), g = 0;
  while (o && g++ < 12) { if (o.code === scope) return true; o = PM.orgMap.get(o.parent_code); }
  return false;
}
const wfHasRoleFor = (role, dept) => !!(ME && ME.roles.some(r => r.role === role && wfCovers(r.scope, dept)));
const wfChain = (entity, type) => WF.chains.filter(c => c.entity === entity && c.doc_type === type).sort((a, b) => a.step - b.step);
/* Packages (pm_doc_type.grp): PR + RR + PA and QC + MC go through one chain
   together (see "packages" below). */
const wfSeq = ty => ((WF.types.find(x => x.code === ty) || {}).seq) || 0;
const wfGrp = ty => (WF.types.find(x => x.code === ty) || {}).grp || null;
function wfCanPrepare(type, dept) {
  const prep = wfChain(pmEntity(dept), type).find(c => c.step === 0);
  return can(type === 'LR' ? 'liquidation' : 'project', 'create') && !!prep && wfHasRoleFor(prep.role_code, dept);
}
const wfRoleName = code => { const r = WF.roles.find(x => x.code === code); return r ? (LANG === 'vi' ? r.name_vi : r.name_en) : code; };
const wfTypeName = code => { if (code === 'TF' || code === 'SC') return t(code === 'TF' ? 'ao.tf.docName' : 'ao.inc.docName');   // transfer slip / incident (assetops.js)
  const r = WF.types.find(x => x.code === code); return r ? (LANG === 'vi' ? r.name_vi : r.name_en) : code; };
const wfChip = s => el('span', { className: 'st wf-' + s, textContent: t('wf.st.' + s) });

async function wfLookups(force) {
  if (WF.types.length && !force) return;
  await pmLookups();
  const [types, chains, roles] = await Promise.all([
    SB.select('pm_doc_type', 'select=*&order=seq'),
    SB.select('pm_chain', 'select=*'),
    SB.select('app_role', 'select=code,name_en,name_vi,entity,sort&order=sort')
  ]);
  Object.assign(WF, { types, chains, roles });
}

/* ------------------------------------------------------- packages (bộ hồ sơ)
   Documents travel in PACKAGES through ONE approval chain (19_pm_workflow.sql):
   PR + RR + PA, then QC + MC; PO, CT and AH one each. The chain, its status
   and the signatures belong to the package — one approval or check signs
   every document in it — while each document keeps its own content.
   The chain is the lead type's (PR / QC); its AM Coordinator step is where
   the AM team checks AND draws up the PA / MC (owner_prep). */
// A package named after a member type ("RR", from before 23_pm_pkg_merge.sql) counts as its group.
const wfGrpOf = grp => (WF.types.find(x => x.code === grp) || {}).grp || grp;
const wfPkgTypes = grp => { grp = wfGrpOf(grp); const ts = WF.types.filter(x => x.grp === grp).sort((a, b) => a.seq - b.seq).map(x => x.code); return ts.length ? ts : [grp]; };
const wfLead = grp => { const x = WF.types.filter(t => t.grp === grp && t.side === 'operator').sort((a, b) => a.seq - b.seq)[0]; return x ? x.code : grp; };
const wfSide = ty => (WF.types.find(x => x.code === ty) || {}).side;
const wfIsReplacement = p => /replace/i.test((p || {}).investment_type || '');
// Colour band of a step: blue = hotel operator, purple = AM team, yellow = JVC approvers.
const WF_BAND = { AM_COORD: 'am', AM_EXEC: 'am', CHIEF_ACC: 'jvc', JVC_DGM: 'jvc', JVC_GM: 'jvc' };
const wfBand = role => WF_BAND[role] || 'op';
// Titles under the signature boxes, in the workbook's words.
const WF_SIG_TITLE = {
  PURCHASING: ['Purchasing Manager', 'Trưởng phòng Thu mua'],          // feedback 26/09/2026: the preparer of QC / PO / CT
  DEPT_HEAD: ['Head of Department', 'Trưởng bộ phận'], DOF: ['Head of Finance', 'Trưởng bộ phận Tài chính'],
  HOTEL_GM: ['Hotel General Manager', 'Tổng Quản lý KS'], AM_COORD: ['AM Coordinator', 'Điều phối quản lý tài sản'],
  AM_EXEC: ['AM Executive', 'Chuyên viên quản lý tài sản'], CHIEF_ACC: ['JVC Chief Accountant', 'Kế toán trưởng JVC'],
  JVC_DGM: ['JVC Deputy General Manager', 'Phó Tổng Giám đốc JVC'], JVC_GM: ['JVC General Manager', 'Tổng Giám đốc JVC']
};
const wfSigTitle = code => WF_SIG_TITLE[code] || (r => r ? [r.name_en, r.name_vi] : [code, ''])(WF.roles.find(x => x.code === code));

/* ------------------------------------------ the documents of one project */
/* Can this person draw up a document of this type for the project now — the
   same rules pm_doc_create enforces — and if not, why (shown under the empty
   box, so nobody hunts for a button that cannot be there yet):
   - PA / MC are drawn up by the AM team at their checking step, in the package;
   - RR belongs only to a replacement project, and joins the PR's package while
     it is still being prepared;
   - a new package (PR, QC, PO, CT, AH): every earlier required document approved;
   - one live document per type (AH repeats, one open at a time, until the final one);
   - an optional step (CT) cannot be slotted in once a later one exists;
   - the person holds the chain's preparer role (step 0) for the project.
   { ok } or { ok: false, why } — why is null when the box already holds the document. */
function wfCreateState(p, type, docs, pkgs = []) {
  const tt = WF.types.find(x => x.code === type) || {};
  const seq = tt.seq || 0;
  const live = docs.filter(d => d.doc_type === type && !['cancelled', 'rejected'].includes(d.status));
  const finalAH = docs.some(d => d.doc_type === 'AH' && d.status === 'approved' && d.data && d.data.final);
  const room = tt.repeatable ? !finalAH && !live.some(d => ['draft', 'in_review', 'returned'].includes(d.status)) : !live.length;
  if (!room) return { ok: false, why: null };
  if (tt.side === 'owner') return { ok: false, why: t('wf.why.owner', { t: wfLead(tt.grp) }) };
  const pk = tt.grp ? pkgs.filter(k => k.grp === tt.grp && !['rejected', 'cancelled'].includes(k.status)).sort((a, b) => b.id - a.id)[0] : null;
  if (tt.grp && type !== wfLead(tt.grp)) {
    if (type === 'RR' && !wfIsReplacement(p)) return { ok: false, why: t('wf.rr.na') };
    if (!pk) return { ok: false, why: t('wf.why.leadFirst', { t: wfLead(tt.grp) }) };
    if (!['draft', 'returned'].includes(pk.status)) return { ok: false, why: null };
  } else {
    const later = docs.some(d => !['rejected', 'cancelled'].includes(d.status) && wfSeq(d.doc_type) > seq);
    if (later) return { ok: false, why: null };
    const has = c => docs.some(d => d.doc_type === c && d.status === 'approved');
    const blockers = WF.types.filter(x => x.seq < seq && (!tt.grp || x.grp !== tt.grp)
      && (x.required || (x.code === 'RR' && wfIsReplacement(p))) && !has(x.code));
    if (blockers.length) return { ok: false, why: t('wf.why.first', { list: blockers.map(x => t('wf.why.approved', { t: x.code })).join(', ') }) };
  }
  if (!wfCanPrepare(type, p.dept_code)) {
    const prep = wfChain(pmEntity(p.dept_code), type).find(c => c.step === 0);
    return { ok: false, why: prep ? t('wf.why.who', { role: wfRoleName(prep.role_code) }) : null };
  }
  return { ok: true };
}

/* What the To-do list adds beyond documents to check or approve: the next
   package to draw up once the one before it is approved — the QC after the
   PR package, the PO after the QC package, the AH after the PO. */
async function wfPrepTodos() {
  if (!ME || !can('project', 'create')) return [];
  await wfLookups();
  const next = ['QC', 'PO', 'AL', 'AH'].filter(ty => WF.types.some(x => x.code === ty) && PM_ENTITIES.some(e => { const c = wfChain(e, ty).find(c => c.step === 0);
    return c && ME.roles.some(r => r.role === c.role_code); }));
  if (!next.length) return [];
  // AL: projects with received assets (status 120 / 119) that no live AL holds yet.
  const alOpen = new Set();
  if (next.includes('AL')) {
    try {
      const [recv, alDocs] = await Promise.all([
        pmSelectAll('am_asset', 'select=id,purpose_code&status_code=in.(119,120)&purpose_code=not.is.null'),
        pmSelectAll('pm_doc', 'select=project_code,ids:data->asset_ids&doc_type=eq.AL&status=not.in.(cancelled,rejected)')]);
      const held = new Set(alDocs.flatMap(d => d.ids || []));
      for (const a of recv) if (!held.has(a.id)) alOpen.add(a.purpose_code);
    } catch {}
  }
  const [docs, pkgs, projects] = await Promise.all([
    pmSelectAll('pm_doc', 'select=id,project_code,doc_type,doc_no,status,pkg_id,decided_at,final:data->final&status=not.in.(cancelled,rejected)'),
    pmSelectAll('pm_pkg', 'select=id,project_code,grp,status&status=not.in.(cancelled,rejected)'),
    pmSelectAll('pm_project', 'select=code,name,dept_code,investment_type,status&status=not.in.(completed,cancelled)')]);
  const by = new Map(), pby = new Map();
  for (const d of docs) { d.data = { final: d.final === true || d.final === 'true' }; (by.get(d.project_code) || by.set(d.project_code, []).get(d.project_code)).push(d); }
  for (const k of pkgs) (pby.get(k.project_code) || pby.set(k.project_code, []).get(k.project_code)).push(k);
  const out = [];
  for (const p of projects) {
    const pd = by.get(p.code) || [];
    if (!pd.length) continue;
    for (const ty of next) {
      if (ty === 'AL' && !alOpen.has(p.code)) continue;
      // The handover waits while a label receipt is still on its way to the hotel.
      if (ty === 'AH' && pd.some(d => d.doc_type === 'AL' && d.status !== 'approved')) continue;
      if (!wfCreateState(p, ty, pd, pby.get(p.code) || []).ok) continue;
      const basis = pd.filter(d => d.status === 'approved' && wfSeq(d.doc_type) < wfSeq(ty)).sort((a, b) => wfSeq(b.doc_type) - wfSeq(a.doc_type))[0];
      out.push({ kind: 'prepare', doc_type: ty, doc_id: basis ? basis.id : null, doc_no: basis ? basis.doc_no : '', project_code: p.code,
                 project_name: p.name, dept_code: p.dept_code, total_value: null, submitted_at: basis ? basis.decided_at : null });
    }
  }
  // Labels received but photos missing (for whoever draws up the handover): open the AL to take them.
  if (next.includes('AH')) {
    try {
      const als = await pmSelectAll('pm_doc', 'select=id,project_code,doc_no,decided_at,ids:data->asset_ids&doc_type=eq.AL&status=eq.approved');
      const ahs = await pmSelectAll('pm_doc', 'select=al:data->al_ids&doc_type=eq.AH&status=not.in.(cancelled,rejected)');
      const handed = new Set(ahs.flatMap(d => d.al || []));
      const pmap = new Map(projects.map(p => [p.code, p]));
      for (const a of als.filter(a => !handed.has(a.id) && pmap.has(a.project_code))) {
        const ids = a.ids || [];
        const photos = await phLoad(ids).catch(() => null);
        if (!photos) break;                                 // 26_alr_project.sql not run yet
        const missing = ids.filter(id => PH_KINDS.some(k => !photos.some(p => p.asset_id === id && p.kind === k))).length;
        if (!missing) continue;
        const p = pmap.get(a.project_code);
        out.push({ kind: 'photo', doc_type: 'AL', doc_id: a.id, doc_no: a.doc_no, project_code: p.code, project_name: p.name,
                   dept_code: p.dept_code, total_value: null, submitted_at: a.decided_at, missing });
      }
    } catch {}
  }
  return out;
}

// Create from somewhere other than the project panel: fetch the project and its documents first.
async function wfCreateFor(projectCode, type, out) {
  try {
    const [p] = await SB.select('pm_project', `select=*&code=eq.${encodeURIComponent(projectCode)}`);
    const docs = await SB.select('pm_doc', `select=id,doc_type,doc_no,status,pkg_id,total_value,created_by,data&project_code=eq.${encodeURIComponent(projectCode)}&order=created_at`);
    await wfCreate(p, type, docs, out);
  } catch (e) { msg(out, 'err', e.message); }
}

/* Replacement or new investment decides whether the package carries an RR.
   The budget line usually says; when it does not, the preparer is asked once,
   and the answer is kept on the project. */
async function wfAskInvestment(p, host) {
  if (p.investment_type) return p.investment_type;
  return new Promise(ok => {
    const box = el('div', { className: 'msg info wfask' }, [el('b', { textContent: t('wf.askInvest') }), document.createTextNode(' ')]);
    for (const v of ['Replacement', 'New Investment']) {
      const b = el('button', { className: 'btn tiny pri', textContent: wfOpt(v) });
      b.onclick = async () => {
        try { await SB.patch('pm_project', `code=eq.${encodeURIComponent(p.code)}`, { investment_type: v }); p.investment_type = v; box.remove(); ok(v); }
        catch (e) { box.textContent = e.message; ok(null); }
      };
      box.append(b, document.createTextNode(' '));
    }
    const x = el('button', { className: 'btn tiny', textContent: t('auth.cancel') }); x.onclick = () => { box.remove(); ok(null); };
    box.append(x);
    host.prepend(box);
  });
}

async function wfProjectPanel(p, host) {
  await wfLookups();
  const [docs, pkgs] = await Promise.all([
    SB.select('pm_doc', `select=id,doc_type,doc_no,status,pkg_id,version,total_value,created_by,created_email,submitted_at,decided_at,data&project_code=eq.${encodeURIComponent(p.code)}&order=created_at`),
    SB.select('pm_pkg', `select=id,grp,status,current_step,returned_to&project_code=eq.${encodeURIComponent(p.code)}&order=id`)]);
  const card = el('div', { style: 'margin-top:14px' });
  // Every form of the project captured at once (PDF / PNG), once there is any.
  const capOut = el('div');
  card.append(el('div', { className: 'row', style: 'align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px' }, [
    el('h2', { textContent: t('wf.docs') }),
    docs.some(d => !['cancelled', 'rejected'].includes(d.status)) ? el('div', { className: 'row', style: 'gap:6px' }, wfCapButtons(p.code, capOut)) : '']), capOut);
  const strip = el('div', { className: 'wfstrip' });
  // Where the documentation is at: its box(es) outlined (user 25/09/2026).
  const stage = PM.prj.docs ? ppStage(p) : null;
  const here = stage && stage.state !== 'done' ? String(stage.type).split(' + ') : [];
  for (const type of WF_ORDER) {
    const tt = WF.types.find(x => x.code === type) || {};
    const mine = docs.filter(d => d.doc_type === type && d.status !== 'cancelled');
    const box = el('div', { className: 'wfbox' + (type === 'RR' && !wfIsReplacement(p) ? ' na' : '') + (here.includes(type) ? ' cur band-' + stage.band : ''),
      title: here.includes(type) ? ppStageText(stage) : '' });
    box.append(el('div', { className: 'wft' }, [el('b', { textContent: type }), document.createTextNode(' ' + wfTypeName(type))]));
    if (!tt.required && type !== 'RR') box.append(el('div', { className: 'wfopt', textContent: t('wf.optional') }));
    for (const d of mine) {
      const a = el('a', { href: '#', className: 'wfdoc' }, [el('code', { textContent: d.doc_no }), wfChip(d.status)]);
      a.onclick = ev => { ev.preventDefault(); wfOpen(d.id); };
      box.append(a);
    }
    const st = wfCreateState(p, type, docs, pkgs);
    if (st.ok) {
      const b = el('button', { className: 'btn tiny pri', textContent: t('wf.create') });
      b.onclick = async () => {
        if (type === 'PR' && !(await wfAskInvestment(p, card))) return;
        wfCreate(p, type, docs);
      };
      box.append(b);
    } else if (st.why) box.append(el('div', { className: 'wfwhy', textContent: st.why }));   // why there is no button yet
    strip.append(box);
  }
  card.append(strip);
  host.append(card);
}

/* What a new document starts with, taken from the project and the documents
   before it — so nothing that is already known is typed twice. */
// The project's line in the FINAL budget round of its year ("Master Data").
async function wfFinalLine(p) {
  const [fin] = await SB.select('pm_budget_round', `select=id&is_final=eq.true&year=eq.${Number(p.year) || 0}`);
  if (!fin) return null;
  return (await SB.select('pm_budget_line', `select=*&round_id=eq.${fin.id}&project_code=eq.${encodeURIComponent(p.main_code)}&limit=1`))[0] || null;
}

async function wfCreate(p, type, docs, out = '#ppMsg') {
  try {
    await wfLookups();
    await wfCatLoad();
    const make = async ty => {
      const data = await wfPrefill(p, ty, docs);
      Object.assign(WF, { project: p, docs, line: null });
      WF_FORMS[ty].derive(data, wfCtx());           // fills in totals and computed boxes
      return SB.rpc('pm_doc_create', { p_project: p.code, p_type: ty, p_data: data });
    };
    const id = await make(type);
    // A replacement project's PR takes its RR along: both are filled in and sent together.
    if (type === 'PR' && wfIsReplacement(p) && !docs.some(d => d.doc_type === 'RR' && !['cancelled', 'rejected'].includes(d.status)))
      await make('RR');
    await wfOpen(id);
  } catch (e) { msg(out, 'err', e.message); }
}

/* ------------------------------------------------------------ doc screen
   One screen per PACKAGE: its chain, its actions, and its documents shown one
   at a time on the same page — round dots beside CONTENT (PR · RR · PA) and
   arrows under the sheet switch between them with a page-turn, without
   leaving the screen. */
async function wfOpen(id) {
  WF.openId = id;
  showView('doc');
}

async function wfLoad() {
  const out = $('#wdMsg');
  if (!WF.openId) { msg(out, 'info', t('wf.noDoc')); $('#wdBody').innerHTML = ''; return; }
  msg(out, 'info', t('table.loading'));
  try {
    await wfLookups();
    await wfCatLoad();
    const [doc] = await SB.select('pm_doc', `select=*&id=eq.${WF.openId}`);
    if (!doc) { msg(out, 'err', t('wf.gone')); return; }
    // A liquidation request belongs to a department, not a project (27_liquidation.sql).
    const lq = !doc.project_code;
    const [project] = lq ? [lqProject(doc)] : await SB.select('pm_project', `select=*&code=eq.${encodeURIComponent(doc.project_code)}`);
    const [pkgs, pdocs, steps, events, docs, years] = await Promise.all([
      SB.select('pm_pkg', `select=*&id=eq.${doc.pkg_id}`),
      SB.select('pm_doc', `select=*&pkg_id=eq.${doc.pkg_id}&status=neq.cancelled`),
      SB.select('pm_pkg_step', `select=*&pkg_id=eq.${doc.pkg_id}&order=step`),
      SB.select('pm_pkg_event', `select=*&pkg_id=eq.${doc.pkg_id}&order=at`),
      lq ? [] : SB.select('pm_doc', `select=id,doc_type,doc_no,status,pkg_id,total_value,data&project_code=eq.${encodeURIComponent(doc.project_code)}`),
      lq ? [] : SB.select('pm_budget_year', `select=*&year=eq.${project ? project.year : 0}`)
    ]);
    const line = project && !lq ? await wfFinalLine(project) : null;
    if (lq) { pdocs.length || pdocs.push(doc); await lqPhotosLoad(pdocs); }   // the Disposal Form's Picture column
    // Testing switch (am_setting 'pm_allow_self_approve'): the preparer may check / approve their own package.
    WF.selfOk = await SB.select('am_setting', 'select=value&key=eq.pm_allow_self_approve')
      .then(([r]) => !!r && (r.value === true || r.value === 'true')).catch(() => false);
    // Admin switch (Settings): show the package's history under the form, or not.
    WF.showHist = await SB.select('am_setting', 'select=value&key=eq.pm_show_history')
      .then(([r]) => !r || !(r.value === false || r.value === 'false')).catch(() => true);
    let pkg = pkgs[0] || null;
    // Documents of the same group still in another package being drawn up (split
    // before packages existed): shown, signed and sent with this one — submitting
    // the RR submits its PR too; the server merges the packages (pm_pkg_submit).
    if (pkg && ['draft', 'returned'].includes(pkg.status)) {
      const g = wfGrpOf(pkg.grp), grpOf = ty => (WF.types.find(x => x.code === ty) || {}).grp;
      const sib = docs.filter(x => x.pkg_id !== pkg.id && ['draft', 'returned'].includes(x.status) && wfSide(x.doc_type) === 'operator'
        && grpOf(x.doc_type) === g && !pdocs.some(y => y.doc_type === x.doc_type));
      if (sib.length) pdocs.push(...await SB.select('pm_doc', `select=*&id=in.(${sib.map(x => x.id).join(',')})`));
      if (g !== pkg.grp) pkg = { ...pkg, grp: g };
    }
    if (!WF.pkg || !pkg || WF.pkg.id !== pkg.id) { WF.qcTab = null; WF.adminEdit = false; WF.autoMade = false; }
    pdocs.sort((a, b) => wfSeq(a.doc_type) - wfSeq(b.doc_type));
    Object.assign(WF, { pkg, pdocs, project, steps, events, docs, year: years[0] || null, line: line || null, dirty: false });
    WF.drafts = new Map(pdocs.map(d => [d.id, JSON.parse(JSON.stringify(d.data || {}))]));
    WF.dirtyIds = new Set();
    // The approved documents of the EARLIER packages, for reference on the same
    // screen (QC · MC shows PR · RR · PA first; PO shows those and QC · MC …),
    // each with its own package's signatures. Read-only.
    const prevRef = WF.ref && WF.ref.d.id;
    WF.refs = []; WF.ref = null;
    if (pkg) {
      const first = Math.min(...wfPkgTypes(pkg.grp).map(wfSeq)), pick = new Map();
      for (const x of docs)      // the latest approved one of each earlier type
        if (x.pkg_id !== pkg.id && x.status === 'approved' && wfSeq(x.doc_type) < first
            && (!pick.has(x.doc_type) || pick.get(x.doc_type).id < x.id)) pick.set(x.doc_type, x);
      if (pick.size) {
        const ids = [...pick.values()].map(x => x.id), pids = [...new Set([...pick.values()].map(x => x.pkg_id))];
        const [rdocs, rpkgs, rsteps] = await Promise.all([
          SB.select('pm_doc', `select=*&id=in.(${ids.join(',')})`),
          SB.select('pm_pkg', `select=*&id=in.(${pids.join(',')})`),
          SB.select('pm_pkg_step', `select=*&pkg_id=in.(${pids.join(',')})&order=step`)]);
        rdocs.sort((a, b) => wfSeq(a.doc_type) - wfSeq(b.doc_type));
        WF.refs = rdocs.map(d => ({ d, pkg: rpkgs.find(k => k.id === d.pkg_id) || {}, steps: rsteps.filter(s => s.pkg_id === d.pkg_id),
                                    pdocs: rdocs.filter(o => o.pkg_id === d.pkg_id) }));
        for (const r of WF.refs) WF.drafts.set(r.d.id, JSON.parse(JSON.stringify(r.d.data || {})));
        WF.ref = WF.refs.find(r => r.d.id === prevRef) || null;
      }
    }
    // Keep showing the document that was on screen (after a save or an action).
    const keep = WF.lastOpen === WF.openId && WF.doc && pdocs.find(d => d.doc_type === WF.doc.doc_type && WF.doc.pkg_id === pkg.id);
    WF.lastOpen = WF.openId;
    wfSetDoc((keep || pdocs.find(d => d.id === doc.id) || doc).doc_type);
    // The AM Coordinator at the checking step finds the PA / MC already started.
    const cur = wfCurStep();
    if (pkg && pkg.status === 'in_review' && cur && cur.owner_prep && !WF.autoMade && wfCanActPkg()) {
      const missing = wfPkgTypes(pkg.grp).filter(ty => wfSide(ty) === 'owner' && !pdocs.some(d => d.doc_type === ty)
        && wfCanPrepare(ty, project.dept_code));
      if (missing.length) {
        WF.autoMade = true;
        for (const ty of missing) {
          const data = await wfPrefill(project, ty, docs);
          WF_FORMS[ty].derive(data, wfCtx());
          await SB.rpc('pm_doc_create', { p_project: project.code, p_type: ty, p_data: data });
        }
        WF.doc = { doc_type: missing[0], pkg_id: pkg.id };      // open on the new PA / MC
        return wfLoad();
      }
    }
    msg(out, '', '');
    wfRender();
    // Who the package is waiting for, by name.
    if (pkg && pkg.status === 'in_review') {
      try {
        const who = await SB.rpc('pm_next_actors', { p_id: WF.doc.id });
        const n = $('#wdWho');
        if (n) n.textContent = who.length ? who.map(w => w.full_name || w.email).join(', ') : t(WF.selfOk ? 'wf.nobody' : 'wf.nobodyElse');
      } catch {}
    }
  } catch (e) { msg(out, 'err', e.message); }
}

// Put one document of the package on screen (its working copy keeps unsaved edits).
function wfSetDoc(type) {
  const d = WF.pdocs.find(x => x.doc_type === type) || WF.pdocs[0];
  WF.doc = d;
  WF.data = WF.drafts.get(d.id);
}
const wfCurStep = () => WF.pkg && WF.steps.find(s => s.step === WF.pkg.current_step);
function wfCanActPkg() {
  const s = wfCurStep();
  return !!(WF.pkg && WF.pkg.status === 'in_review' && s && can('approval', 'approve')
    && (WF.pkg.created_by !== (ME && ME.id) || WF.selfOk) && wfHasRoleFor(s.role_code, WF.project.dept_code));
}
// The small tag after a role: approves / checks.
const wfKindTag = (kind, ownerPrep) => el('span', { className: 'kt kt-' + (kind || 'approve'),
  textContent: t(ownerPrep ? 'wf.k.checkPrep' : 'wf.k.' + (kind || 'approve')) });

/* Who may edit which document of the package:
   - PR / RR / QC: their preparer while the package is a draft or came back;
   - PA / MC: the AM Coordinator while the package sits at their checking step
     (or JVC sent them back to the AM team);
   - admin override: any document not cancelled, switched on with ✎. */
function wfDocEditable(d) {
  if (!d || !WF.pkg || !['draft', 'returned'].includes(d.status)) return false;
  const dept = WF.project.dept_code, mine = x => x === (ME && ME.id);
  if (wfSide(d.doc_type) === 'owner') {
    const s = wfCurStep();
    return WF.pkg.status === 'in_review' && !!s && s.owner_prep && (mine(d.created_by) || wfCanPrepare(d.doc_type, dept));
  }
  return ['draft', 'returned'].includes(WF.pkg.status) && (mine(WF.pkg.created_by) || mine(d.created_by) || wfCanPrepare(d.doc_type, dept));
}
const wfOwnEditable = () => wfDocEditable(WF.doc);
// Admin override (22_admin_tools.sql): content of a document in any state but cancelled, switched on with ✎.
const wfAdminMode = () => !!(WF.adminEdit && WF.doc && WF.doc.status !== 'cancelled' && can('override', 'edit'));
const wfEditable = () => wfOwnEditable() || wfAdminMode();
const wfPkgEditable = () => WF.pkg && ['draft', 'returned'].includes(WF.pkg.status)
  && WF.pdocs.some(d => wfSide(d.doc_type) !== 'owner' && wfDocEditable(d));

function wfRender() {
  if (TB.on) return tbDocRender();         // tablet / phone: the paper reader
  const box = $('#wdBody');
  box.innerHTML = '';
  const k = WF.pkg, d = WF.doc, p = WF.project || {};
  const step = wfCurStep();
  const nos = WF.pdocs.map(x => x.doc_no).join(' + ');
  $('#pageTitle').textContent = WF.pdocs.length > 1 ? `${t('wf.pkg')} ${nos}` : `${d.doc_no} — ${wfTypeName(d.doc_type)}`;

  // Header + actions.
  const head = el('div', { className: 'card' });
  const top = el('div', { className: 'row', style: 'align-items:center;flex-wrap:wrap;gap:10px;justify-content:flex-start' });
  const back = el('a', { href: '#', textContent: p._lq ? '← ' + t('nav.liq') : '← ' + p.code + ' — ' + (p.name || '') });
  back.onclick = ev => { ev.preventDefault(); if (p._lq) return showView('liq'); PM.prj.open = p.code; showView('projects'); };
  top.append(el('b', { style: 'font-size:15px', textContent: nos }), wfChip(k.status),
             el('span', { style: 'color:var(--dim)', textContent: t('wf.version', { n: k.version }) }), back);
  head.append(top);
  const info = el('div', { style: 'margin-top:8px;font-size:12.5px;color:var(--dim)' });
  info.append(document.createTextNode(t('wf.madeBy', { who: k.created_name || k.created_email || '—', at: fmtDate((k.created_at || '').slice(0, 10)) })));
  if (k.status === 'in_review' && step) {
    info.append(el('br'), el('span', { className: 'stg band-' + wfBand(step.role_code), textContent: t('wf.waiting', { step: step.step, role: wfRoleName(step.role_code) }) }),
                document.createTextNode(' '), wfKindTag(step.kind, step.owner_prep), document.createTextNode(' '), el('b', { id: 'wdWho', textContent: '…' }));
  }
  head.append(info);
  // The preparer holds the role of the step too: they may not check / approve their own package.
  if (k.status === 'in_review' && step && !WF.selfOk && k.created_by === (ME && ME.id) && wfHasRoleFor(step.role_code, p.dept_code))
    head.append(el('div', { className: 'msg warn', style: 'margin-top:10px', textContent: t('wf.selfBlocked', { role: wfRoleName(step.role_code) }) }));
  // Why it came back, in the words of whoever sent it.
  const lastBack = [...WF.events].reverse().find(e => ['return', 'return_am', 'reject'].includes(e.action));
  if (lastBack && (k.status === 'returned' || k.status === 'rejected' || (k.status === 'in_review' && k.returned_to === 'am' && step && step.owner_prep)))
    head.append(el('div', { className: 'msg ' + (k.status === 'rejected' ? 'err' : 'warn'), style: 'margin-top:10px',
      textContent: t('wf.back.' + lastBack.action, { who: lastBack.actor_name || lastBack.actor_email || '', note: lastBack.comment || '' }) }));
  if (wfAdminMode()) head.append(el('div', { className: 'msg warn', style: 'margin-top:10px', textContent: t('wf.adminBanner') }));

  const acts = el('div', { className: 'row', style: 'margin-top:10px;align-items:flex-end;flex-wrap:wrap' });
  const note = el('textarea', { id: 'wdNote', placeholder: t('wf.notePh'), style: 'min-height:38px;width:340px' });
  const btn = (k2, cls, fn) => { const b = el('button', { className: 'btn ' + (cls || ''), textContent: t(k2) }); b.onclick = fn; acts.append(b); return b; };
  if (wfPkgEditable()) {
    btn('wf.save', '', () => wfSave(false));
    btn(WF.pdocs.length > 1 || wfPkgTypes(k.grp).length > 1 ? 'wf.submitPkg' : 'wf.submit', 'pri', () => wfSubmit());
  } else if (wfAdminMode()) {
    btn('wf.adminSave', 'pri', () => wfSave(false));
    btn('wf.adminStop', '', () => { if (WF.dirty && !confirm(t('wf.leave'))) return; WF.adminEdit = false; wfLoad(); });
  } else if (d.status !== 'cancelled' && can('override', 'edit')) {
    btn('wf.adminEdit', '', () => { WF.adminEdit = true; wfRender(); });
  }
  if (wfCanActPkg()) {
    acts.prepend(el('div', { className: 'fld' }, [el('label', { textContent: t('wf.note') }), note]));
    if (step.owner_prep) {
      if (WF.dirtyIds.size || WF.pdocs.some(x => wfSide(x.doc_type) === 'owner' && wfDocEditable(x))) btn('wf.save', '', () => wfSave(false));
      btn('wf.checkPrepBtn', 'pri', () => wfAct('approve'));
    } else btn(step.kind === 'check' ? 'wf.checkBtn' : WF.pdocs.length > 1 ? 'wf.approvePkg' : 'wf.approve', 'pri', () => wfAct('approve'));
    // Back to the preparer — or, once the AM team has checked, the PA / MC alone back to them.
    const amDone = WF.steps.some(s => s.owner_prep && s.step < step.step);
    btn(amDone ? 'wf.returnOp' : 'wf.return', '', () => wfAct('return', 'operator'));
    if (amDone) btn('wf.returnAm', '', () => wfAct('return', 'am'));
    if (step.kind !== 'check') btn('wf.reject', 'danger', () => wfAct('reject'));
  }
  if (!['approved', 'cancelled', 'rejected'].includes(k.status)
      && (can(k.grp === 'LR' ? 'liquidation' : 'project', 'admin') || (k.created_by === (ME && ME.id) && ['draft', 'returned'].includes(k.status))))
    btn(WF.pdocs.length > 1 ? 'wf.cancelPkg' : 'wf.cancel', 'danger', () => wfCancel());
  // An RR that turned out not to belong (the project is not a replacement after all).
  if (wfPkgEditable() && d.doc_type !== wfLead(k.grp) && wfSide(d.doc_type) !== 'owner')
    btn(t('wf.removeDoc', { no: d.doc_no }), '', () => wfRemoveDoc());
  if (can('override', 'edit') && !['draft', 'cancelled'].includes(k.status)) btn('wf.adminReopen', '', () => wfAdminReopen());
  btn('wf.print', '', () => wfPrint());
  btn('wf.pdf', '', () => wfPdf());
  // Goods are received before the handover: an approved PO sends its lines to a new delivery.
  if (d.doc_type === 'PO' && d.status === 'approved') btn('wf.toIntake', '', () => wfToIntake());
  // The label receipt prints its labels on the label screen (tape or sheet).
  if (d.doc_type === 'AL' && d.status !== 'cancelled') btn('al.print', '', () => alPrintLabels(d));
  head.append(acts);
  box.append(head);

  // The chain of this submission (or the planned one), coloured by who acts.
  const chain = el('div', { className: 'card' });
  chain.append(el('h2', { textContent: t('wf.chain') }));
  const planned = WF.steps.length ? WF.steps : wfChain(pmEntity(p.dept_code), wfLead(k.grp)).filter(c => c.step > 0)
    .map(c => ({ step: c.step, role_code: c.role_code, kind: c.kind === 'check' ? 'check' : 'approve', status: 'planned',
                 owner_prep: wfPkgTypes(k.grp).some(ty => wfSide(ty) === 'owner'
                   && (wfChain(pmEntity(p.dept_code), ty).find(x => x.step === 0) || {}).role_code === c.role_code) }));
  const stName = s => s.status === 'approved' && s.kind === 'check' ? t('wf.st.checked') : t('wf.st.' + s.status);
  const ol = el('div', { className: 'wfsteps' });
  const prep = wfChain(pmEntity(p.dept_code), wfLead(k.grp)).find(c => c.step === 0);
  ol.append(el('div', { className: 'wfstep done' }, [el('span', { className: 'n', textContent: '0' }),
    el('div', {}, [el('b', { textContent: prep ? wfRoleName(prep.role_code) : '—' }),
                   el('small', { textContent: t('wf.preparer') + ' · ' + (k.created_name || k.created_email || '') }),
                   ...sigImg(k.prep_signature, 'wfsig')])]));
  for (const s of planned) {
    const cur = k.status === 'in_review' && s.step === k.current_step;
    const cls = s.status === 'approved' ? 'done' : ['returned', 'rejected'].includes(s.status) ? 'bad' : cur ? 'cur band-' + wfBand(s.role_code) : '';
    const lines = [el('b', { textContent: wfRoleName(s.role_code) }), wfKindTag(s.kind, s.owner_prep)];
    if (s.acted_at) lines.push(el('small', { textContent: `${stName(s)} · ${s.acted_name || s.acted_email} · ${fmtDate((s.acted_at || '').slice(0, 10))}` }));
    else lines.push(el('small', { textContent: cur ? t('wf.nowHere') : s.status === 'planned' ? t('wf.planned') : stName(s) }));
    if (s.comment) lines.push(el('small', { className: 'cm', textContent: '“' + s.comment + '”' }));
    lines.push(...sigImg(s.signature, 'wfsig'));
    ol.append(el('div', { className: 'wfstep ' + cls }, [el('span', { className: 'n', textContent: String(s.step) }), el('div', {}, lines)]));
  }
  chain.append(ol);
  box.append(chain);

  // The documents, one at a time: dots beside CONTENT, arrows under the sheet.
  const form = el('div', { className: 'card' });
  const pbtn = el('button', { className: 'btn', textContent: t('wf.print') }); pbtn.onclick = () => wfPrint();
  const fbtn = el('button', { className: 'btn', textContent: t('wf.pdf') }); fbtn.onclick = () => wfPdf();
  form.append(el('div', { className: 'chead' }, [el('div', { className: 'row', style: 'align-items:center;gap:12px' },
    [el('h2', { textContent: t('wf.content') }), wfDots()]), el('div', { className: 'row' }, [pbtn, fbtn, ...(p._lq ? [] : wfCapButtons(p.code, '#wdMsg'))])]));
  form.append(el('div', { id: 'wdWarn' }));
  form.append(el('div', { className: 'flipwrap' }, el('div', { className: 'fscroll', id: 'wdSheet' }, fsSheet(d.doc_type, wfEditable()))));
  form.append(wfArrows());
  box.append(form);
  wfWarnRender();
  // A QC in the package: its tender (vendors quote on the portal, bids load into the appendix).
  const qcDoc = WF.pdocs.find(x => x.doc_type === 'QC');
  if (qcDoc && qcDoc.id) box.append(tdPanel(qcDoc));
  // The photos of the attached labels: on the received AL, and on the AH of those assets.
  const ph = phForPackage();
  if (ph) box.append(ph);

  // History of the package.
  const hist = el('details', { className: 'card' });
  hist.append(el('summary', { textContent: t('wf.history', { n: WF.events.length }) }));
  const tb = el('table');
  tb.append(el('tr', {}, ['wf.h.at', 'wf.h.who', 'wf.h.action', 'wf.h.step', 'wf.h.note'].map(k2 => el('th', { textContent: t(k2) }))));
  for (const e of WF.events) tb.append(el('tr', {}, [
    el('td', { textContent: fmtDateTime(e.at) }),
    el('td', { textContent: e.actor_name || e.actor_email || '' }), el('td', { textContent: t('wf.a.' + e.action) }),
    el('td', { textContent: e.step != null ? String(e.step) : '' }), el('td', { style: 'white-space:normal', textContent: e.comment || '' })]));
  hist.append(el('div', { className: 'wrap' }, tb));
  if (WF.showHist !== false) box.append(hist);
}

/* ------------------------------------------------ tender portal (staff side)
   Under the QC of a package (sql/25_pm_tender.sql, vendor page Tender.html):
   open a tender from the QC, invite vendors with a private link, and — once
   the bids are in — the three roles of the QC chain (steps 0–2: Purchasing,
   Head of department, Head of finance) each consent; the third consent opens
   every sealed bid at once. Opened bids are loaded into the QC as a draft for
   Purchasing to check, score and submit. Nothing of a sealed bid reaches this
   screen: the server leaves data and files out until it is opened. */
const TD = { qc: null, list: null, vendors: null, link: null, busy: false };

function tdPanel(qcDoc) {
  const card = el('div', { className: 'card tdcard' });
  const body = el('div');
  card.append(el('div', { className: 'chead' }, [el('h2', { textContent: t('td.title') }),
    el('button', { className: 'btn tiny', textContent: '↻', title: t('td.refresh'), onclick: () => tdLoad(qcDoc, body, true) })]),
    el('div', { id: 'tdMsg' }), body);
  tdLoad(qcDoc, body, TD.qc !== qcDoc.id);
  return card;
}

async function tdLoad(qcDoc, body, fresh) {
  if (fresh || !TD.list) {
    body.textContent = t('td.loading');
    try {
      TD.list = await SB.rpc('pm_tender_list', { p_project: WF.project.code });
      TD.qc = qcDoc.id;
    } catch (e) {
      // Before sql/25 has run, the function does not exist: say so once, quietly.
      body.innerHTML = '';
      body.append(el('div', { className: 'tdnote', textContent: /pm_tender_list|PGRST202|404/.test(e.message) ? t('td.notInstalled') : e.message }));
      return;
    }
  }
  tdDraw(qcDoc, body);
}

const tdDt = v => fmtDateTime(v);
const tdLocal = d => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
const tdIso = v => v ? new Date(v).toISOString() : null;       // datetime-local (local time) → timestamptz
const tdTotal = (tn, data) => {
  if (!data) return null;
  const items = (tn.items || []).reduce((s, it, i) => s + n0(it.qty) * n0((data.prices || {})[i]), 0);
  return items + (data.olines || []).reduce((s, o) => s + n0(o.amount), 0);
};
// The latest OPENED bid of each vendor (current round first).
function tdOpened(tn) {
  const out = [];
  for (const v of tn.invitees || []) {
    const op = (v.bids || []).filter(b => b.opened_at).sort((a, b) => (b.round - a.round) || (b.version - a.version));
    if (op.length) out.push({ inv: v, bid: op[0] });
  }
  return out.sort((a, b) => n0(tdTotal(tn, a.bid.data)) - n0(tdTotal(tn, b.bid.data)));
}
async function tdCall(fn, args, okText, qcDoc, body) {
  if (TD.busy) return null;
  TD.busy = true;
  try {
    const r = await SB.rpc(fn, args);
    if (okText) msg('#tdMsg', 'ok', okText);
    await tdLoad(qcDoc, body, true);
    return r;
  } catch (e) { msg('#tdMsg', 'err', e.message); return null; }
  finally { TD.busy = false; }
}

function tdDraw(qcDoc, body) {
  body.innerHTML = '';
  const mine = (TD.list || []).filter(x => x.qc_doc_id === qcDoc.id && x.status !== 'cancelled');
  const canCreate = wfCanPrepare('QC', WF.project.dept_code) || can('project', 'admin');
  if (!mine.length) {
    body.append(el('div', { className: 'tdnote', textContent: t('td.none') }));
    if (canCreate) body.append(tdCreateForm(qcDoc, body));
    return;
  }
  for (const tn of mine) body.append(tdOne(qcDoc, body, tn));
}

function tdCreateForm(qcDoc, body) {
  const p = WF.project || {};
  const prRef = (WF.refs || []).find(r => r.d.doc_type === 'PR');
  const pr = prRef ? (WF.drafts.get(prRef.d.id) || prRef.d.data || {}) : {};
  const scope = [pr.reason || p.reason || '', ...(pr.lines || []).filter(l => l.asset_item).map(l => `- ${l.asset_item}${l.qty ? ' × ' + l.qty : ''}${l.tech_standard ? ': ' + l.tech_standard : ''}`)]
    .filter(Boolean).join('\n');
  const dl = new Date(); dl.setDate(dl.getDate() + 7); dl.setHours(17, 0, 0, 0);
  const fTitle = el('input', { value: p.name || '' });
  const fDl = el('input', { type: 'datetime-local', value: tdLocal(dl) });
  const fScope = el('textarea', { value: scope, style: 'min-height:90px' });
  const fTerms = el('textarea', { value: t('td.termsDefault'), style: 'min-height:70px' });
  const go = el('button', { className: 'btn pri', textContent: t('td.create') });
  go.onclick = async () => {
    if (WF.dirty) return msg('#tdMsg', 'warn', t('td.saveFirst'));
    await tdCall('pm_tender_create', { p_qc: qcDoc.id, p_deadline: tdIso(fDl.value), p_title: fTitle.value.trim(), p_scope: fScope.value, p_terms: fTerms.value },
      t('td.created'), qcDoc, body);
  };
  const f = (k, i) => el('div', { className: 'fld' }, [el('label', { textContent: t(k) }), i]);
  return el('details', { className: 'tdbox', open: true }, [el('summary', { textContent: t('td.new') }),
    el('div', { className: 'tdnote', textContent: t('td.newHint') }),
    el('div', { className: 'row' }, [f('td.f.title', fTitle), f('td.f.deadline', fDl)]),
    el('div', { className: 'row' }, [f('td.f.scope', fScope)]), el('div', { className: 'row' }, [f('td.f.terms', fTerms)]),
    el('div', { className: 'row' }, [go])]);
}

function tdOne(qcDoc, body, tn) {
  const box = el('div', { className: 'tdone' });
  const past = new Date(tn.deadline) < new Date();
  const st = tn.status === 'open' && !past ? ['ok', 'td.st.open'] : tn.status === 'open' ? ['warn', 'td.st.past'] : ['bad', 'td.st.' + tn.status];
  box.append(el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [
    el('b', { textContent: tn.title || WF.project.name || '' }), el('span', { className: 'tdchip ' + st[0], textContent: t(st[1]) }),
    el('span', { className: 'dim', textContent: `${t('td.f.deadline')}: ${tdDt(tn.deadline)}` }),
    tn.round > 1 ? el('span', { className: 'dim', textContent: t('td.round', { n: tn.round }) }) : '',
    el('span', { className: 'dim', textContent: t('td.counts', { i: (tn.items || []).length, c: (tn.crit || []).length }) })]));

  // Managing the tender: extend / close / cancel / reopen for a new round.
  if (tn.can_manage) {
    const nd = new Date(Math.max(Date.now(), new Date(tn.deadline).getTime())); nd.setDate(nd.getDate() + 3);
    const fDl = el('input', { type: 'datetime-local', value: tdLocal(nd), style: 'width:auto' });
    const b = (k, cls, fn) => el('button', { className: 'btn ' + cls, textContent: t(k), onclick: fn });
    const acts = [fDl];
    if (tn.status === 'open') acts.push(
      b('td.extend', '', () => tdCall('pm_tender_update', { p_id: tn.id, p_deadline: tdIso(fDl.value), p_scope: null, p_terms: null, p_status: null }, t('td.done'), qcDoc, body)),
      b('td.close', '', () => confirm(t('td.closeQ')) && tdCall('pm_tender_update', { p_id: tn.id, p_deadline: null, p_scope: null, p_terms: null, p_status: 'closed' }, t('td.done'), qcDoc, body)));
    acts.push(b('td.reopen', '', () => { const why = prompt(t('td.reopenQ')); if (why && why.trim())
      tdCall('pm_tender_reopen', { p_id: tn.id, p_deadline: tdIso(fDl.value), p_reason: why.trim() }, t('td.reopened'), qcDoc, body); }),
      b('td.cancel', 'danger', () => confirm(t('td.cancelQ')) && tdCall('pm_tender_update', { p_id: tn.id, p_deadline: null, p_scope: null, p_terms: null, p_status: 'cancelled' }, t('td.done'), qcDoc, body)));
    box.append(el('div', { className: 'row tdacts' }, acts));
  }

  // Invitees and where their bid stands (sealed until the three consents).
  const tb = el('table', { className: 'tdtbl' });
  tb.append(el('tr', {}, ['td.h.vendor', 'td.h.link', 'td.h.bid', 'td.h.total', ''].map(k => el('th', { textContent: k ? t(k) : '' }))));
  for (const v of tn.invitees || []) {
    const cur = (v.bids || []).filter(x => x.round === tn.round).sort((a, b) => b.version - a.version);
    const sub = cur.find(x => x.status === 'submitted') || cur.find(x => x.submitted_at);
    const bidTxt = !cur.length ? t('td.b.none') : !sub ? t('td.b.draft')
      : `${t('td.b.sub', { v: sub.version, at: tdDt(sub.submitted_at) })} · ${sub.opened_at ? t('td.b.opened') : '🔒 ' + t('td.b.sealed')}`;
    const expired = new Date(v.expires_at) < new Date();
    const linkTxt = v.revoked ? t('td.l.revoked') : expired ? t('td.l.expired') : t('td.l.until', { d: tdDt(v.expires_at) });
    const ops = [];
    if (tn.can_manage) {
      const b = (k, fn) => el('button', { className: 'btn tiny', textContent: t(k), onclick: fn });
      ops.push(b('td.l.extend', () => tdCall('pm_tender_invite_set', { p_invitee: v.id, p_days: 14, p_revoke: false, p_new_token: false }, t('td.done'), qcDoc, body)),
        b('td.l.new', async () => { if (!confirm(t('td.l.newQ'))) return;
          const tok = await tdCall('pm_tender_invite_set', { p_invitee: v.id, p_days: 14, p_revoke: false, p_new_token: true }, '', qcDoc, body);
          if (tok) tdShowLink(v.name, v.email, tok); }));
      if (!v.revoked) ops.push(b('td.l.revoke', () => confirm(t('td.l.revokeQ')) && tdCall('pm_tender_invite_set', { p_invitee: v.id, p_days: null, p_revoke: true, p_new_token: false }, t('td.done'), qcDoc, body)));
    }
    const opened = (v.bids || []).filter(x => x.opened_at).sort((a, b) => (b.round - a.round) || (b.version - a.version))[0];
    tb.append(el('tr', {}, [el('td', {}, [el('b', { textContent: v.name || '' }), el('br'), el('small', { className: 'dim', textContent: [v.vendor_code, v.email].filter(Boolean).join(' · ') })]),
      el('td', { className: v.revoked || expired ? 'dim' : '', textContent: linkTxt + (v.last_seen_at ? ' · ' + t('td.l.seen', { d: tdDt(v.last_seen_at) }) : '') }),
      el('td', { textContent: bidTxt }), el('td', { className: 'n', textContent: opened ? fmtMoney(tdTotal(tn, opened.data)) : '' }),
      el('td', { className: 'tdops' }, ops)]));
  }
  if (!(tn.invitees || []).length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'dim', textContent: t('td.noInv') })));
  box.append(el('h3', { textContent: t('td.invitees') }), el('div', { className: 'wrap' }, tb));
  if (TD.link && TD.link.tender === tn.id) box.append(TD.link.node);
  if (tn.can_manage && tn.status === 'open') box.append(tdInviteForm(qcDoc, body, tn));

  // Consent to open: one per role of the QC chain, three different people.
  const sealed = (tn.invitees || []).reduce((s, v) => s + (v.bids || []).filter(b => b.submitted_at && !b.opened_at).length, 0);
  const cons = el('div', { className: 'tdcons' });
  for (const r of tn.open_roles || []) {
    const c = (tn.consents || []).find(x => x.role === r);
    const cell = el('div', { className: 'tdrole' + (c ? ' ok' : '') }, [el('b', { textContent: wfRoleName(r) })]);
    if (c) cell.append(el('small', { textContent: `✓ ${c.user || ''} · ${tdDt(c.at)}` }));
    else if (sealed && wfHasRoleFor(r, WF.project.dept_code)) cell.append(el('button', { className: 'btn pri tiny', textContent: t('td.consent'),
      onclick: async () => { if (!confirm(t('td.consentQ'))) return;
        const res = await tdCall('pm_tender_consent_give', { p_tender: tn.id, p_role: r }, '', qcDoc, body);
        if (res) msg('#tdMsg', 'ok', t(res === 'opened' ? 'td.openedNow' : 'td.waiting')); } }));
    else cell.append(el('small', { className: 'dim', textContent: t('td.pending') }));
    cons.append(cell);
  }
  box.append(el('h3', { textContent: t('td.consents') }),
    el('div', { className: 'tdnote', textContent: sealed ? t('td.sealedN', { n: sealed }) : t('td.noSealed') }), cons);

  // Opened bids: totals, files, into the QC.
  const op = tdOpened(tn);
  if (op.length) box.append(el('h3', { textContent: t('td.opened') }), tdOpenedTable(qcDoc, tn, op));

  const ev = el('details', { className: 'tdev' }, [el('summary', { textContent: t('td.events', { n: (tn.events || []).length }) })]);
  const et = el('table', { className: 'tdtbl' });
  for (const e of tn.events || []) et.append(el('tr', {}, [el('td', { textContent: tdDt(e.at) }), el('td', { textContent: e.actor || '' }),
    el('td', { textContent: t('td.ev.' + e.action) !== 'td.ev.' + e.action ? t('td.ev.' + e.action) : e.action }), el('td', { style: 'white-space:normal', textContent: e.detail || '' })]));
  ev.append(el('div', { className: 'wrap' }, et));
  box.append(ev);
  return box;
}

function tdInviteForm(qcDoc, body, tn) {
  const det = el('details', { className: 'tdbox' }, [el('summary', { textContent: t('td.invite') })]);
  det.ontoggle = async () => {
    if (!det.open || det.dataset.ready) return;
    det.dataset.ready = '1';
    let vendors = [], open = [];
    try {
      [vendors, open] = await Promise.all([TD.vendors || SB.select('pm_vendor', 'select=code,name,email&order=name'), SB.rpc('pm_tender_open_list')]);
      TD.vendors = vendors;
    } catch (e) { msg('#tdMsg', 'err', e.message); }
    const fV = el('select', {}, [el('option', { value: '', textContent: t('td.pickVendor') }), ...vendors.map(v => el('option', { value: v.code, textContent: v.name }))]);
    const fName = el('input', {}), fMail = el('input', { type: 'email' }), fDays = el('input', { type: 'number', value: 14, min: 1, max: 90, style: 'width:80px' });
    fV.onchange = () => { const v = vendors.find(x => x.code === fV.value); if (v) { fName.value = v.name || ''; fMail.value = v.email || ''; } };
    const picks = open.map(o => { const c = el('input', { type: 'checkbox', checked: o.id === tn.id, value: o.id });
      return el('label', { className: 'tdpick' }, [c, ` ${o.project_code} — ${o.title || o.project_name || ''} (${tdDt(o.deadline)})`]); });
    const go = el('button', { className: 'btn pri', textContent: t('td.inviteGo') });
    go.onclick = async () => {
      const ids = picks.map(l => l.querySelector('input')).filter(c => c.checked).map(c => Number(c.value));
      if (!ids.length) ids.push(tn.id);
      const tok = await tdCall('pm_tender_invite_add', { p_tenders: ids, p_vendor_code: fV.value || null, p_name: fName.value.trim(), p_email: fMail.value.trim(), p_days: Number(fDays.value) || 14 },
        '', qcDoc, body);
      if (tok) tdShowLink(fName.value.trim(), fMail.value.trim(), tok, tn.id);
    };
    const f = (k, i) => el('div', { className: 'fld' }, [el('label', { textContent: t(k) }), i]);
    det.append(el('div', { className: 'row' }, [f('td.f.vendor', fV), f('td.f.name', fName), f('td.f.email', fMail), f('td.f.days', fDays)]),
      picks.length > 1 ? el('div', {}, [el('div', { className: 'tdnote', textContent: t('td.multi') }), ...picks]) : '',
      el('div', { className: 'row' }, [go]));
  };
  return det;
}

/* The link is shown ONCE: the database keeps only a hash of the code. */
function tdShowLink(name, email, token, tenderId) {
  const cfg = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify({ url: CFG.url, key: CFG.key })))));
  const link = new URL('Tender.html', location.href.split('#')[0]).href + '#c=' + cfg + '&t=' + token;
  const inp = el('input', { value: link, readOnly: true, onclick: () => inp.select() });
  const copy = el('button', { className: 'btn pri', textContent: t('td.copy'), onclick: () => { inp.select(); navigator.clipboard?.writeText(link).catch(() => {}); copy.textContent = t('td.copied'); } });
  const node = el('div', { className: 'msg ok tdlink' }, [el('b', { textContent: t('td.linkFor', { v: name, e: email || '—' }) }),
    el('div', { className: 'tdnote', textContent: t('td.linkOnce') }), el('div', { className: 'row', style: 'flex-wrap:nowrap' }, [inp, copy])]);
  TD.link = { tender: tenderId || (TD.link && TD.link.tender) || ((TD.list || [])[0] || {}).id, node };
  const host = document.querySelector('#wdBody .tdcard .tdone');
  if (host) host.append(node);
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function tdFile(f) {
  try {
    const tok = await authToken();
    const r = await fetch(`${CFG.url}/storage/v1/object/authenticated/pm-tender/${f.path.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok } });
    if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
    const url = URL.createObjectURL(await r.blob());
    const a = el('a', { href: url, download: f.name || 'file', target: '_blank', rel: 'noopener' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { msg('#tdMsg', 'err', e.message); }
}

function tdOpenedTable(qcDoc, tn, op) {
  const wrap = el('div');
  const tb = el('table', { className: 'tdtbl' });
  tb.append(el('tr', {}, ['', 'td.h.vendor', 'td.h.version', 'td.h.total', 'td.h.terms', 'td.h.files'].map(k => el('th', { textContent: k ? t(k) : '' }))));
  const checks = op.map((o, i) => {
    const c = el('input', { type: 'checkbox', checked: i < 3 });
    const d = o.bid.data || {};
    tb.append(el('tr', {}, [el('td', { className: 'c' }, c), el('td', { textContent: o.inv.name || '' }),
      el('td', { textContent: `v${o.bid.version}${o.bid.round > 1 ? ' · ' + t('td.round', { n: o.bid.round }) : ''}${o.bid.note ? ' · ' + o.bid.note : ''}` }),
      el('td', { className: 'n', textContent: fmtMoney(tdTotal(tn, d)) }),
      el('td', { style: 'white-space:normal', textContent: [d.pay_term, d.delivery && t('td.t.delivery') + ': ' + d.delivery, d.warranty && t('td.t.warranty') + ': ' + d.warranty,
        d.validity && t('td.t.validity') + ': ' + d.validity].filter(Boolean).join(' · ') }),
      el('td', {}, (o.bid.files || []).map(f => el('div', {}, el('a', { href: '#', textContent: (f.kind === 'quotation' ? '★ ' : '') + (f.name || 'file'),
        onclick: ev => { ev.preventDefault(); tdFile(f); } }))))]));
    return c;
  });
  wrap.append(el('div', { className: 'wrap' }, tb));
  const qcDraft = WF.drafts.get(qcDoc.id);
  if (wfDocEditable(qcDoc) || wfAdminMode()) {
    const go = el('button', { className: 'btn pri', textContent: t('td.load') });
    go.onclick = () => {
      const pick = op.filter((o, i) => checks[i].checked);
      if (!pick.length || pick.length > 3) return msg('#tdMsg', 'warn', t('td.pick3'));
      if ((qcDraft.vendors || []).some(v => v.name) && !confirm(t('td.loadQ'))) return;
      tdToQc(qcDoc, tn, pick);
    };
    wrap.append(el('div', { className: 'row', style: 'margin-top:8px;align-items:center' }, [go, el('span', { className: 'tdnote', textContent: t('td.loadHint') })]));
  } else wrap.append(el('div', { className: 'tdnote', textContent: t('td.loadNo') }));
  return wrap;
}

/* The chosen bids into the QC appendix, as a draft: items (the tender's, whose
   order the prices follow), overhead lines (the union of the vendors'), each
   vendor's prices, spec by field, payment term, and the capability
   declarations as the notes beside each criterion. Scores stay for
   Purchasing — kept if the vendor was already in the QC. */
function tdToQc(qcDoc, tn, pick) {
  const d = WF.drafts.get(qcDoc.id);
  const old = d.vendors || [];
  d.qlines = (tn.items || []).map((it, i) => Object.assign({}, (d.qlines || [])[i] || {}, { item: it.item, qty: it.qty }));
  const labels = [];
  for (const o of pick) for (const l of (o.bid.data || {}).olines || []) {
    const k = String(l.label || '').trim();
    if (k && !labels.some(x => x.toLowerCase() === k.toLowerCase())) labels.push(k);
  }
  d.olines = labels.map(label => ({ label }));
  const abil = new Set((tn.crit || []).filter(c => c.grp === 'ability').map(c => c.label));
  d.vendors = pick.map(o => {
    const b = o.bid.data || {}, prev = old.find(v => v.name && v.name.trim().toLowerCase() === String(o.inv.name || '').trim().toLowerCase()) || {};
    const oprices = {};
    (b.olines || []).forEach(l => { const i = labels.findIndex(x => x.toLowerCase() === String(l.label || '').trim().toLowerCase()); if (i >= 0) oprices[i] = n0(oprices[i]) + n0(l.amount); });
    const n_ability = {}, n_technique = {};
    for (const [lbl, txt] of Object.entries(b.crit || {})) if (txt) (abil.has(lbl) ? n_ability : n_technique)[lbl] = txt;
    return Object.assign({}, prev, { name: o.inv.name, prices: Object.assign({}, b.prices), specx: JSON.parse(JSON.stringify(b.specx || {})),
      specs: Object.assign({}, b.specs), oprices, pay_term: b.pay_term || prev.pay_term || '', n_ability, n_technique,
      delivery: b.delivery || '', warranty: b.warranty || '', validity: b.validity || '', bid_note: b.note || '',
      tender_bid: o.bid.id, vendor_code: o.inv.vendor_code || prev.vendor_code || null });
  });
  while (d.vendors.length < 3) d.vendors.push({ name: '' });
  const submitted = (tn.invitees || []).filter(v => (v.bids || []).some(b => b.submitted_at)).length;
  d.total_vendors = Math.max(n0(d.total_vendors), submitted, pick.length);
  d.tender_id = tn.id;
  WF.ref = null;
  wfSetDoc('QC');
  WF.qcTab = 'appendix';
  WF.dirty = true; WF.dirtyIds.add(qcDoc.id);
  wfRender();
  msg('#wdMsg', 'ok', t('td.loaded', { n: pick.length }));
}
/* The dots: every type of the package in order. A type not in the package yet
   is grey — RR on a new investment ("not applicable"), PA / MC before the AM
   team's checking step. */
function wfDotTypes() {
  const k = WF.pkg;
  return wfPkgTypes(k.grp).map(ty => {
    const d = WF.pdocs.find(x => x.doc_type === ty);
    const why = d ? '' : ty === 'RR' && !wfIsReplacement(WF.project) ? t('wf.rr.na')
      : wfSide(ty) === 'owner' ? t('wf.why.owner', { t: wfLead(k.grp) }) : t('wf.dotNone');
    // A replacement's RR missing from a package still being drawn up (made
    // before the RR came along automatically): its dot adds it.
    const add = !d && ty === 'RR' && wfIsReplacement(WF.project) && wfPkgEditable() && wfCanPrepare(ty, WF.project.dept_code);
    return { ty, d, why: add ? t('wf.dotAdd', { t: ty }) : why, add };
  });
}
function wfDots() {
  const list = wfDotTypes(), refs = WF.refs || [];
  if (list.length + refs.length < 2) return '';
  // Earlier packages first (for reference, lighter), a divider, then this package.
  const refDots = refs.map(r => {
    const b = el('button', { className: 'wfdot ref' + (WF.ref === r ? ' on' : ''),
      title: `${r.d.doc_no} — ${wfTypeName(r.d.doc_type)} · ${t('wf.refDoc')}` },
      [el('b', { textContent: r.d.doc_type }), el('i', { className: 'st wf-' + r.d.status })]);
    b.onclick = () => wfShow('ref:' + r.d.id);
    return b;
  });
  return el('div', { className: 'wfdots' }, [...refDots, refs.length ? el('span', { className: 'wfsep', title: t('wf.refSep') }) : '',
    ...list.map(({ ty, d, why, add }) => {
    const b = el('button', { className: 'wfdot' + (d && !WF.ref && d.doc_type === WF.doc.doc_type ? ' on' : '') + (d ? '' : add ? ' add' : ' off'),
      title: d ? `${d.doc_no} — ${wfTypeName(ty)}` : `${ty} — ${why}`, disabled: !d && !add },
      [el('b', { textContent: ty }), d ? el('i', { className: 'st wf-' + d.status }) : add ? el('i', { className: 'plus', textContent: '+' }) : '']);
    if (d) b.onclick = () => wfShow(ty);
    else if (add) b.onclick = () => wfAddToPkg(ty);
    return b;
  })]);
}
/* Unbudgeted project: a new department code / project no. / budget year typed
   on the PR renames the project, and every document number follows it
   (pm_project_recode, only while nothing has been sent for approval). */
async function wfRecode(p, dept, no, year) {
  const n = parseInt(no, 10), y = parseInt(year, 10);
  if (!dept || !(n > 0) || !(y > 2000 && y < 2100)) { msg('#wdMsg', 'err', t('wf.recode.bad')); return wfRender(); }
  const seg = String(p.code).split('.');
  const next = [seg[0], dept, String(n).padStart(2, '0'), y, ...seg.slice(4)].join('.');
  if (next === p.code) return;
  if (!confirm(t('wf.recode.ask', { from: p.code, to: next }))) return wfRender();
  if (!(await wfSave(true))) return;
  try {
    await SB.rpc('pm_project_recode', { p_code: p.code, p_dept: dept, p_no: n, p_year: y });
    await wfLoad();
    msg('#wdMsg', 'ok', t('wf.recode.done', { code: next }));
  } catch (e) { msg('#wdMsg', 'err', e.message); wfRender(); }
}
// Adds a missing document to the package being drawn up, then turns to it.
async function wfAddToPkg(ty) {
  if (!(await wfSave(true))) return;
  try {
    const p = WF.project, data = await wfPrefill(p, ty, WF.docs);
    WF_FORMS[ty].derive(data, wfCtx());
    await SB.rpc('pm_doc_create', { p_project: p.code, p_type: ty, p_data: data });
    WF.doc = { doc_type: ty, pkg_id: WF.pkg.id };
    await wfLoad();
  } catch (e) { msg('#wdMsg', 'err', e.message); }
}
/* Everything that can be on screen, earliest first: the earlier packages'
   documents ("ref:<id>"), then this package's (by type). */
const wfShownKey = () => WF.ref ? 'ref:' + WF.ref.d.id : WF.doc.doc_type;
const wfShown = () => WF.ref ? WF.ref.d : WF.doc;
function wfPages() {
  return [...(WF.refs || []).map(r => ({ key: 'ref:' + r.d.id, d: r.d })),
          ...wfDotTypes().filter(x => x.d).map(x => ({ key: x.ty, d: x.d }))];
}
function wfArrows() {
  const list = wfPages();
  if (list.length < 2) return '';
  const i = list.findIndex(x => x.key === wfShownKey());
  const prev = el('button', { className: 'btn wfarrow', textContent: '‹', title: list[i - 1] ? list[i - 1].d.doc_no : '', disabled: i <= 0 });
  const next = el('button', { className: 'btn wfarrow', textContent: '›', title: list[i + 1] ? list[i + 1].d.doc_no : '', disabled: i >= list.length - 1 });
  prev.onclick = () => wfShow(list[i - 1].key);
  next.onclick = () => wfShow(list[i + 1].key);
  return el('div', { className: 'wfnav' }, [el('span', { className: 'wfpg', textContent: `${i + 1} / ${list.length}` }), prev, next]);
}

/* Draws an earlier package's document in ITS package's context (chain,
   signatures), read-only, then puts this package back. */
function wfOnScreen(fn) {
  const r = WF.ref;
  if (!r || WF.inRef) return fn();
  const keep = { pkg: WF.pkg, steps: WF.steps, pdocs: WF.pdocs, doc: WF.doc, data: WF.data, adminEdit: WF.adminEdit };
  Object.assign(WF, { pkg: r.pkg, steps: r.steps, pdocs: r.pdocs, doc: r.d, data: WF.drafts.get(r.d.id), adminEdit: false, inRef: true });
  try { return fn(); } finally { Object.assign(WF, keep, { inRef: false }); }
}

// Turn the page to another document (this package's, or an earlier one's), the way a binder turns.
function wfShow(key) {
  if (!WF.doc || key === wfShownKey()) return;
  const order = wfPages().map(x => x.key);
  const fwd = order.indexOf(key) > order.indexOf(wfShownKey());
  const wrap = document.querySelector('#wdBody .flipwrap');
  const swap = () => {
    if (key.startsWith('ref:')) WF.ref = WF.refs.find(r => 'ref:' + r.d.id === key) || null;
    else { WF.ref = null; wfSetDoc(key); }
    wfRender();
  };
  if (!wrap || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return swap();
  wrap.classList.add(fwd ? 'turn-out-fwd' : 'turn-out-back');
  setTimeout(() => {
    swap();
    const w2 = document.querySelector('#wdBody .flipwrap');
    if (!w2) return;
    w2.classList.add(fwd ? 'turn-in-fwd' : 'turn-in-back');
    setTimeout(() => w2.classList.remove('turn-in-fwd', 'turn-in-back'), 260);
  }, 220);
}

async function wfPrefill(p, type, docs) {
  // The approved one, else the one in review: the PA is drawn up while its PR is still being checked.
  const get = tp => docs.find(d => d.doc_type === tp && d.status === 'approved') || docs.find(d => d.doc_type === tp && d.status === 'in_review');
  const line = (await wfFinalLine(p)) || {};
  const today = new Date().toISOString().slice(0, 10);
  const pr = get('PR')?.data || {}, pa = get('PA')?.data || {}, qc = get('QC')?.data || {}, po = get('PO')?.data || {};
  const prLines = pr.lines || [];
  const qA = (qc.vendors || [])[0] || {};                     // vendor A = the chosen vendor
  const qItems = (qc.qlines || []).length ? qc.qlines.map((l, i) => ({ item: l.item, qty: l.qty, price: (qA.prices || {})[i], spec: (qA.specs || {})[i] }))
                                          : prLines.map(l => ({ item: l.asset_item, qty: l.qty, price: l.unit_price, spec: l.tech_standard }));
  if (type === 'PR') {
    // Asset item and location only from the catalogues (Master data): the
    // budget line's words are matched to a catalogue entry, or left empty.
    const item = wfCatProduct(p.asset_item || line.asset_item || '');
    return {
      request_date: today, project_type: 'Non-consultancy', category: p.category || 'FFE', currency: 'VND',
      investment_type: p.investment_type || line.investment_type || 'Replacement',
      budget: p.budgeted ? 'Budgeted' : 'Unbudgeted', share_pct: p.share_pct != null ? Number(p.share_pct) : 1,
      possibility: p.possibility ?? line.possibility ?? null, impact: p.impact ?? line.impact ?? null,
      reason: p.reason || line.reason || '',
      cost_benchmark: ['Quotation', 'Previous Project', 'Price Reference'].includes(line.reference) ? line.reference : 'Quotation',
      supplier: p.proposed_supplier || line.supplier || '', notes: '- Warranty time: \n- Delivery time: \n- Other: ',
      lines: [{ asset_item: item ? item.name : '', unit: item ? item.unit : null, rationale: line.rationale || p.rationale || '',
                tech_standard: line.tech_standard || p.tech_standard || '', location: wfCatLocation(p.location || line.location || ''),
                qty: line.quantity ?? 1, unit_price: line.unit_price ?? p.estimated_value ?? null }]
    };
  }
  if (type === 'RR') return { replacement_level: 'Full replacement', after_replacement: 'Liquidation', currency: 'VND',
                              request_date: pr.request_date || today,
                              lines: [{ qty: 1, after: 'Reuse' }], evidence: [] };
  if (type === 'PA') return {
    // No committee, recommendation or comments any more (feedback 25/09/2026); the risk scores start from the PR's.
    date: today, comparability: 'Comparable', risk_category: '', possibility: pr.possibility ?? null, impact: pr.impact ?? null,
    lines: prLines.map(l => ({ asset_item: l.asset_item, qty: l.qty, location: l.location, specs: l.tech_standard,
                               condition: '', notes: '', picture: '' })),
    evidence: []
  };
  if (type === 'QC') {
    const pt = /x[aâ]y|constr/i.test(p.project_type || '') ? QC_PTYPES[1] : /h[oỗ]n|mix/i.test(p.project_type || '') ? QC_PTYPES[2] : QC_PTYPES[0];
    const items = prLines.map(l => ({ item: l.asset_item, qty: l.qty ?? 1 }));
    return { date: today, project_type: pt, procurement_type: pa.procurement_type || pr.procurement_type || p.procurement_type || '',
             w_ability: 10, w_technique: 60, w_finance: 30, w_price: 80, w_pay: 20,
             sub_ability: qcSubs(QC_ABILITY), sub_technique: qcSubs(qcTechFor(pt)),
             total_vendors: 3, qlines: items.length ? items : [{ item: '', qty: 1 }],
             vendors: [{ name: '' }, { name: '' }, { name: '' }], comments: '' };
  }
  if (type === 'MC') return {
    date: today, b_vendor: '', c_vendor: '', note: '',
    lines: qItems.map(l => ({ item: l.item, qty: l.qty ?? 1, a_spec: l.spec || '', a_price: l.price ?? null })),
    evidence: []
  };
  if (type === 'PO') {
    // The chosen vendor's lines of the QC appendix: the catalogue name, its default
    // unit, the price, and the spec field by field; its overhead lines.
    const lines = (qc.qlines || []).length ? qc.qlines.map((l, i) => {
      const hit = wfCatProduct(l.item || '') || {}, sx = Object.assign({}, (qA.specx || {})[i] || {}), free = (qA.specs || {})[i];
      const origin = sx.origin || ''; delete sx.origin;
      if (free && !Object.values(sx).some(Boolean)) sx.function = free;
      return { asset_item: hit.name || l.item || '', qty: l.qty ?? 1, unit: hit.unit || null, unit_price: (qA.prices || {})[i] ?? null, origin, spec: sx };
    }) : qItems.map(l => ({ asset_item: l.item, qty: l.qty ?? 1, unit_price: l.price ?? null, spec: {} }));
    return { order_date: today, supplier: qA.name || qc.chosen_vendor || '', payment_term: qA.pay_term || '', lines,
             olines: (qc.olines || []).map((o, i) => ({ label: o.label || '', amount: (qA.oprices || {})[i] ?? null })).filter(o => o.label || o.amount) };
  }
  if (type === 'CT') { const poDoc = get('PO');
    return { signed_date: '', value: poDoc ? n0(poDoc.total_value) : null, supplier: po.supplier || '',
             lines: [{ milestone: 'Deposit', pct: 50 }, { milestone: 'Handover', pct: 50 }] }; }
  if (type === 'AL') return alPrefill(p, docs, today, get('PO'));
  if (type === 'AH') {
    // Labels received (AL) and not handed over yet: the handover is of exactly those assets (user 26/09/2026).
    const covered = new Set(docs.filter(d => d.doc_type === 'AH' && !['cancelled', 'rejected'].includes(d.status))
      .flatMap(d => (d.data && d.data.al_ids) || []));
    const als = docs.filter(d => d.doc_type === 'AL' && d.status === 'approved' && !covered.has(d.id));
    if (als.length) {
      const assets = als.flatMap(d => (d.data && d.data.assets) || []);
      const lines = new Map();
      for (const a of assets) {
        const k = [a.name, a.unit, a.location, n0(a.unit_price)].join('|');
        const l = lines.get(k) || { asset_item: a.name, unit: a.unit || null, location: a.location || null, unit_price: n0(a.unit_price) || null, qty: 0, spec: {} };
        l.qty += n0(a.qty) || 1;
        lines.set(k, l);
      }
      return { handover_date: today, final: true, evaluation: 'Satisfactory', supplier: po.supplier || '', warranty_term: po.warranty_term || '',
               lines: [...lines.values()], al_ids: als.map(d => d.id), al_nos: als.map(d => d.doc_no),
               asset_ids: assets.map(a => a.id), hide_cols: po.hide_cols || [], evidence: [] };
    }
    // The PO's lines, each with the location its PR line named (Location list).
    const locOf = item => (prLines.find(l => l.asset_item && l.asset_item === item) || {}).location || null;
    return { handover_date: today, final: true, evaluation: 'Satisfactory', supplier: po.supplier || '', warranty_term: po.warranty_term || '',
             lines: (po.lines || []).map(l => Object.assign(JSON.parse(JSON.stringify(l)), { location: l.location || locOf(l.asset_item) })),
             hide_cols: po.hide_cols || [], evidence: [] };
  }
  return {};
}

/* A label receipt (AL) for one delivery: the assets received for the project
   (status "Chờ duyệt" 120 / 119) that no live AL holds yet — the earliest
   delivery batch first; another AL takes the next one. */
async function alPrefill(p, docs, today, poDoc) {
  const used = new Set(docs.filter(d => d.doc_type === 'AL' && !['cancelled', 'rejected'].includes(d.status))
    .flatMap(d => (d.data && d.data.asset_ids) || []));
  const all = (await pmSelectAll('am_asset', 'select=id,asset_code,barcode,name_vi,name_en,qty,unit_code,unit_price,location_code,dept_code,asset_kind,shipment_id' +
    `&purpose_code=eq.${encodeURIComponent(p.code)}&status_code=in.(119,120)&order=asset_code`)).filter(a => !used.has(a.id));
  if (!all.length) throw new Error(t('al.noDelivery', { p: p.code }));
  const ships = [...new Set(all.map(a => a.shipment_id))].sort((a, b) => (a == null) - (b == null) || a - b);
  const shipId = ships[0];
  const list = all.filter(a => a.shipment_id === shipId);
  let ship = null;
  if (shipId) { try { [ship] = await SB.select('am_shipment', `select=id,code,delivery_date,po_doc_no,dept_code&id=eq.${shipId}`); } catch {} }
  return { date: today, shipment_id: shipId || null, shipment_code: ship ? ship.code : '', delivery_date: ship ? ship.delivery_date : null,
           po_no: (ship && ship.po_doc_no) || (poDoc && poDoc.doc_no) || '', dept_code: (ship && ship.dept_code) || list[0].dept_code || p.dept_code,
           notes: ALR_NOTES, asset_ids: list.map(a => a.id),
           assets: list.map(a => ({ id: a.id, asset_code: a.asset_code, barcode: a.barcode, name: [a.name_vi, a.name_en].filter(Boolean).join('/'),
                                    qty: n0(a.qty) || 1, unit: a.unit_code, unit_price: a.unit_price, location: a.location_code, kind: a.asset_kind })) };
}


/* ============================================================ FORM SHEETS
   Every procurement document is drawn as the sheet the departments know from
   "FFE Procurement Document.xlsx": company block and bilingual title top right,
   CODE / DATE boxes, navy section bars on the light-blue page, small-caps labels
   over white boxes, navy-headed tables, "Consent by" boxes at the foot. Labels
   stay in the workbook's words (English, as on the paper forms).

   ONE builder draws all three: the editable screen (pale-yellow boxes are the
   ones to fill, white ones are computed or come from earlier documents), the
   printout and the PDF (plain text in the same boxes) — so what is typed is
   exactly what gets signed. */

// Stored values stay as the dossier template writes them; a few get a label.
const wfOpt = o => { const k = 'wf.o.' + o, s = t(k); return s === k ? o : s; };
function wfInput(f, obj, edit, onChange, ctxRow) {
  const v = f.calc ? f.calc(...ctxRow) : obj[f.k];
  if (!edit || f.ro || f.calc) {
    const shown = v == null || v === '' ? '' : f.t === 'money' ? fmtMoney(Number(v))
      : f.t === 'bool' ? (v ? '✔' : '—') : f.t === 'date' ? fmtDate(v) : f.t === 'pct' ? fmtPct(Number(v), 0) : f.t === 'select' ? wfOpt(v) : String(v);
    return el('span', { className: 'wfro' + (f.t === 'money' || f.t === 'num' ? ' num' : ''), textContent: shown });
  }
  let i;
  if (f.t === 'select') {
    i = el('select');
    i.append(el('option', { value: '', textContent: '—' }));
    for (const o of f.opts) i.append(el('option', { value: o, textContent: wfOpt(o) }));
    if (v && !f.opts.includes(v)) i.append(el('option', { value: v, textContent: v }));   // an old value stays visible
    i.value = v ?? '';
  } else if (f.t === 'bool') {
    i = el('input', { type: 'checkbox', checked: !!v });
  } else if (f.t === 'area') {
    i = el('textarea', { value: v ?? '', rows: 2 });
  } else {
    i = el('input', { value: v == null ? '' : f.t === 'money' ? fmtNum(v) : f.t === 'pct' ? String(Math.round(Number(v) * 10000) / 100) : v,
                      type: f.t === 'date' ? 'date' : 'text', inputMode: ['money', 'num', 'int15', 'pct'].includes(f.t) ? 'decimal' : 'text' });
    if (f.product) i.setAttribute('list', 'prodList');
  }
  i.onchange = () => {
    let nv = f.t === 'bool' ? i.checked : i.value;
    if (['money', 'num'].includes(f.t)) nv = numIn(nv);
    if (f.t === 'int15') nv = numIn(nv) == null ? null : Math.max(1, Math.min(5, Math.round(numIn(nv))));
    if (f.t === 'pct') nv = numIn(nv) == null ? null : numIn(nv) / 100;
    obj[f.k] = nv === '' ? null : nv;
    onChange();
  };
  return i;
}

const FS_CO = ['PLAZA HOTEL COMPANY LIMITED', 'CÔNG TY TNHH LDKS PLAZA', '17 Lê Duẩn, Phường Sài Gòn, TP.HCM'];

// Read-only value, formatted the way the workbook shows it.
function fsR(v, ty) {
  let s = v;
  if (v == null || v === '' || (typeof v === 'number' && !isFinite(v))) s = '';
  else if (ty === 'money') s = fmtMoney(Number(v));
  else if (ty === 'num') s = fmtNum(Math.round(Number(v) * 100) / 100);
  else if (ty === 'pct') s = fmtPct(Number(v), Math.abs(Number(v)) < 0.1 ? 1 : 0);
  else if (ty === 'date') s = fmtDate(v);
  return el('span', { className: 'wfro', textContent: String(s) });
}
// A labelled box on the 12-column grid.
function fc(label, node, span = 3, cls = '') {
  return el('div', { className: 'fcell ' + cls, style: `grid-column:span ${span}` },
    // 'fit': one line, the font shrinking to fit (fsFit); 'rows2': two grid rows tall.
    [el('div', { className: 'fl', textContent: label }), el('div', { className: 'fv' + (/\bfit\b/.test(cls) ? ' fit' : '') }, node)]);
}
/* Text marked .fit stays on one line: its font steps down until it fits its
   box (7 px at least). Run once the sheet is in the page (it measures). */
function fsFit(root) {
  if (!root || !root.querySelectorAll) return;
  for (const e of root.querySelectorAll('.fit')) {
    e.style.fontSize = '';
    let fs = parseFloat(getComputedStyle(e).fontSize) || 12, guard = 0;
    while (e.scrollWidth > e.clientWidth + 1 && fs > 7 && guard++ < 40) { fs -= 0.5; e.style.fontSize = fs + 'px'; }
  }
}
const fsGrid = cells => el('div', { className: 'fgrid' }, cells);
const fsBar = (text, right) => el('div', { className: 'fbar' }, [el('span', { textContent: text }), right ? el('i', { textContent: right }) : '']);
const fsNote = text => el('div', { className: 'fnote', textContent: text });
const fsPage = (kids, cls = '') => el('div', { className: 'fpage ' + cls }, kids);
const deptName = code => { const o = PM.orgMap.get(code); return o ? (o.name_en || o.name_vi || code) : (code || ''); };

function fsHead(x, dateLabel, dateNode) {
  const f = x.form;
  return el('div', { className: 'fhead' }, [
    el('div', { className: 'fco' }, FS_CO.map((s, i) => el('div', { className: i < 2 ? 'b' : '', textContent: s }))),
    el('div', { className: 'fttl' }, [
      el('div', { className: 't1', textContent: f.title[0] }), el('div', { className: 't2', textContent: f.title[1] }),
      el('table', { className: 'fcode' }, [
        el('tr', {}, [el('th', { textContent: 'CODE' }), el('th', { textContent: dateLabel })]),
        el('tr', {}, [el('td', { textContent: WF.doc.doc_no }), el('td', {}, dateNode)])])])]);
}
// Label on the left, value box on the right (the QC / MC general block).
function fsKv(rows) {
  return el('table', { className: 'fkv' }, rows.map(r => el('tr', {}, [
    el('td', { className: 'k', textContent: r[0] }), el('td', { className: 'v' + (r[2] ? ' n' : '') }, r[1]),
    ...(r[3] || []).map((n, i) => el('td', { className: 'u' + (i === 2 && r[3].length >= 4 ? ' un' : '') }, n))])));
}

/* A form table. cols: { h, k, t, opts, w, ro, get(l,i), obj(l), product, after(l) }.
   o: { add(): new row, groups: [[label, span]], foot: [[label, colIndex, value]...], noDel } */
function fsTable(x, cols, rows, o = {}) {
  const tb = el('table', { className: 'ftable' });
  // Percent widths scaled back up to the full row when some columns are left out (empty spec, an empty MC group).
  const pct = cols.reduce((s, c) => s + (/%$/.test(c.w || '') ? parseFloat(c.w) : 0), 0);
  const k = pct > 0 && pct < 94 ? 95 / pct : 1;
  const colg = el('colgroup', {}, [el('col', { style: 'width:34px' }), ...cols.map(c => el('col', { style: c.w ? `width:${/%$/.test(c.w) ? (parseFloat(c.w) * k).toFixed(2) + '%' : c.w}` : '' })),
                                   ...(x.edit && !o.noDel ? [el('col', { style: 'width:24px' })] : [])]);
  tb.append(colg);
  if (o.groups) tb.append(el('tr', { className: 'fgrp' }, [el('th'), ...o.groups.map(([g, n]) => el('th', { colSpan: n }, g)),
                                                          ...(x.edit && !o.noDel ? [el('th')] : [])]));
  tb.append(el('tr', {}, [el('th', { textContent: 'No.' }), ...cols.map(c => el('th', { textContent: c.h })),
                          ...(x.edit && !o.noDel ? [el('th')] : [])]));
  rows.forEach((l, i) => {
    const tr = el('tr');
    tr.append(el('td', { textContent: String(i + 1) }));
    for (const c of cols) {
      const td = el('td', { className: ['money', 'num', 'pct'].includes(c.t) ? 'n' : (c.left ? 'l' : '') });
      if (c.cell) td.append(c.cell(l, i));
      else if (c.get) td.append(fsR(c.get(l, i), c.t));
      else td.append(wfInput({ k: c.k, t: c.t, opts: c.opts, ro: c.ro, product: c.product }, c.obj ? c.obj(l) : l, x.edit, x.rr, []));
      if (c.after && x.edit) td.append(c.after(l));
      tr.append(td);
    }
    if (x.edit && !o.noDel) {
      const del = el('button', { className: 'xbtn', textContent: '×', title: t('wf.delLine') });
      del.onclick = () => { rows.splice(i, 1); x.rr(); };
      tr.append(el('td', { className: 'del' }, del));
    }
    tb.append(tr);
  });
  for (const f of o.foot || []) {
    const tr = el('tr', { className: 'ftot' });
    tr.append(el('td', { colSpan: f[1] + 1, className: 'n', textContent: f[0] }));
    for (let ci = f[1]; ci < cols.length; ci++) {
      const hit = (f[2] || {})[ci];
      tr.append(el('td', { className: 'n' }, hit != null ? fsR(hit[0], hit[1]) : ''));
    }
    if (x.edit && !o.noDel) tr.append(el('td'));
    tb.append(tr);
  }
  const wrap = el('div', { className: 'ftwrap' }, tb);
  if (x.edit && o.add) {
    const add = el('button', { className: 'btn tiny fadd', textContent: t('wf.addLine') });
    add.onclick = () => { rows.push(o.add()); x.rr(); };
    wrap.append(add);
  }
  // The widths of the last two columns (unit price, amount), so the totals box under the table lines up with them.
  if (o.tail) { const w = c => /%$/.test(c.w || '') ? parseFloat(c.w) * k : 0; x.tail = [w(cols[cols.length - 2]), w(cols[cols.length - 1])]; }
  return wrap;
}

// Possibility × Impact = Assessment, and the risk level under the assessment, as wide as it.
function fsRisk(x, obj, editable, span = 6) {
  const I = k => wfInput({ k, t: 'int15', ro: !editable }, obj, x.edit, x.rr, []);
  return el('div', { className: 'fcell frisk', style: `grid-column:span ${span}` }, [
    el('div', { className: 'fl', textContent: 'RISK-ASSESSMENT' }),
    el('div', { className: 'frg' }, [
      el('div', { className: 'fl c', textContent: 'Possibility' }), el('span'), el('div', { className: 'fl c', textContent: 'Impact' }), el('span'),
      el('div', { className: 'fl c', textContent: 'Assessment' }),
      el('div', { className: 'fv' }, I('possibility')), el('span', { className: 'op', textContent: 'x' }),
      el('div', { className: 'fv' }, I('impact')), el('span', { className: 'op', textContent: '=' }), el('div', { className: 'fv' }, fsR(obj.assessment)),
      el('span', { className: 'lvlk', textContent: 'Risk Level :' }), el('div', { className: 'fv lvlv fit' }, fsR(obj.risk_level))])]);
}

/* The PA's figures, on the left: budget, project value, the difference (red
   when over budget, green when within), then ratio and exchange rate on one row. */
function paMoney(d, c) {
  const cls = d.difference == null ? '' : d.difference > 0 ? ' bad' : ' good';
  const row = (k, v, extra) => el('tr', {}, [el('td', { className: 'k', textContent: k }), el('td', { className: 'v' + (extra || '') }, fsR(v, 'money')),
    ...fsPair(v, c).map((n, i) => el('td', { className: 'u' + (i === 2 ? ' un' : '') }, n))]);
  // The exchange rate on the ratio's row without a box: its figure under the USD figures, "(exrate)" under "USD" (feedback 26/09/2026).
  const fx = curUsd() ? [] : [el('td', { className: 'u' }), el('td', { className: 'u' }), el('td', { className: 'u un' }, fsR(c.fx, 'money')),
                              el('td', { className: 'u', textContent: '(exrate)' })];
  return el('table', { className: 'fkv pakv' }, [row('Budgeted Value:', d.budget_value), row('Project Value:', d.project_value),
    row('Difference:', d.difference, cls),
    el('tr', {}, [el('td', { className: 'k', textContent: 'Ratio:' }), el('td', { className: 'v' + cls }, fsR(d.ratio, 'pct')), ...fx])]);
}

// "Note" box with the terms, and a figure on the right. A finished form leaves out the terms left empty.
function fsTerms(x, fields, rightLabel, rightValue) {
  const d = x.d;
  const shown = fields.filter(([, k]) => x.edit || (d[k] != null && d[k] !== ''));
  const left = !shown.length ? el('div') : el('div', { className: 'fterms' }, [el('div', { className: 'fnh', textContent: 'Note:' }),
    ...shown.map(([lbl, k, ty, opts]) => el('div', { className: 'ftr' + (ty === 'area' ? ' tall' : '') }, [
      el('span', { className: 'tl', textContent: lbl + ':' }),
      el('div', { className: 'fv' }, wfInput({ k, t: ty, opts }, d, x.edit, x.rr, []))]))]);
  // Under a table that gave its column widths (x.tail): label under "Unit Price", figure under "Amount",
  // edges in line with the table's (feedback 26/09/2026).
  const tl = x.tail && x.tail[0] && x.tail[1] ? x.tail : null;
  const right = el('div', { className: 'ftotbox' }, rightLabel ? (Array.isArray(rightLabel) ? rightLabel : [[rightLabel, rightValue]])
    .map(([l, v]) => el('div', { className: 'ftl', style: tl ? `grid-template-columns:${tl[0]}fr ${tl[1]}fr` : '' },
      [el('b', { textContent: l }), el('div', { className: 'fv' }, fsR(v, 'money'))])) : []);
  return el('div', { className: 'ftermrow' + (tl ? ' tail' : ''), style: tl ? `grid-template-columns:1fr ${tl[0] + tl[1]}%` : '' }, [left, right]);
}

// OneDrive / SharePoint links (files stay out of Supabase for now).
function fsLinks(x, title = 'ATTACHMENTS') {
  const d = x.d;
  d.evidence = d.evidence || [];
  if (!x.edit && !d.evidence.some(e => wfSafeUrl(e.url))) return '';
  const box = el('div', { className: 'flinks' });
  d.evidence.forEach((e, i) => {
    const url = wfSafeUrl(e.url);
    if (x.edit) {
      const lab = el('input', { value: e.label || '', placeholder: t('wf.evLabel') });
      const u = el('input', { value: e.url || '', placeholder: 'https://…sharepoint.com/…', spellcheck: false });
      lab.onchange = () => { e.label = lab.value.trim(); wfMarkDirty(); };
      u.onchange = () => { e.url = u.value.trim(); x.rr(); };
      const del = el('button', { className: 'xbtn', textContent: '×' }); del.onclick = () => { d.evidence.splice(i, 1); x.rr(); };
      box.append(el('div', { className: 'fl2' }, [el('div', { className: 'fv' }, lab), el('div', { className: 'fv' }, u), del,
        e.url && !url ? el('span', { className: 'flag', textContent: '⚠ ' + t('wf.badUrl') }) : '']));
    } else if (url) box.append(el('div', { className: 'fl2 p' }, [el('b', { textContent: '• ' + (e.label || '') + ' ' }),
      el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: url })]));
  });
  if (x.edit) { const add = el('button', { className: 'btn tiny fadd', textContent: t('wf.addLink') }); add.onclick = () => { d.evidence.push({}); x.rr(); }; box.append(add); }
  return el('div', {}, [fsBar(title), box]);
}

// A change on the sheet on screen: remember which document of the package to save.
const wfMarkDirty = () => { WF.dirty = true; if (WF.dirtyIds && WF.doc) WF.dirtyIds.add(WF.doc.id); };

/* The sheet for the open document. Re-drawn after every change, so computed
   boxes follow what is typed. */
function fsSheet(type, edit, mode = 'screen') {
  // An earlier package's document on screen: drawn in its own package's context, read-only.
  if (WF.ref && !WF.inRef) return wfOnScreen(() => fsSheet(WF.ref.d.doc_type, false, mode));
  const form = WF_FORMS[type];
  const d = WF.data, c = wfCtx();
  form.derive(d, c);
  const x = { d, c, p: WF.project || {}, edit, type, form, mode };
  MONEY.year = x.p.year;
  const lock = MONEY.lock;
  MONEY.lock = edit;
  x.rr = () => { wfMarkDirty(); const n = fsSheet(type, edit, mode); x.root.replaceWith(n); wfWarnRender(); };
  try {
    const kids = form.build(x);                       // built first: it tells whether the table is crowded (x.wide)
    x.root = el('div', { className: `fsheet ${form.orient} ${edit ? 'edit' : 'print'}${form.wide && x.wide !== false ? ' wide' : ''}${form.xs ? ' xs' : ''}` }, kids);
  } finally { MONEY.lock = lock; }
  requestAnimationFrame(() => fsFit(x.root));       // once it is in the page: shrink the one-line texts to fit
  return x.root;
}

// Checks that belong next to the form but not on the paper.
function wfWarnRender() {
  const box = $('#wdWarn');
  if (!box || !WF.doc) return;
  box.innerHTML = '';
  if (WF.ref) return box.append(el('div', { className: 'msg info', textContent: t('wf.refNote', { no: WF.ref.d.doc_no }) }));
  const d = WF.data, c = wfCtx(), ty = WF.doc.doc_type;
  const put = (kind, text) => box.append(el('div', { className: 'msg ' + kind, textContent: text }));
  if (wfEditable()) put('info', t(ty === 'LR' ? 'lq.fillHint' : 'wf.fillHint'));
  // Not on the workbook sheet, so said beside it: what the procurement decision matrix suggests.
  if (ty === 'PR' && d.procurement_suggested && wfEditable()) put(d.procurement_type === d.procurement_suggested ? 'ok' : 'warn', t('wf.pr.suggest', { v: d.procurement_suggested }));
  if (ty === 'PA') { const g = paGate(d, c); put(g.ok ? 'ok' : 'warn', g.text);
                     if (d.procurement_suggested) put('info', t('wf.pa.procRule', { v: d.procurement_suggested, pt: d.project_type, r: d.risk_level })); }
  // QC: the chosen vendor's total against the budget, by the same gate as the PA (feedback 26/09/2026).
  if (ty === 'QC' && d.estimated) { const g = paGate(d, Object.assign({}, c, { prTotal: d.estimated })); if (!g.ok) put('warn', g.text); }
  if (ty === 'QC') { const r = qcScore(d); if (r.problems.length) put('warn', r.problems.join('\n')); else if (r.best) put('ok', t('wf.qc.ok', { v: d.chosen_vendor, s: r.best.total })); }
  if (ty === 'MC' && d.mc_over && d.mc_over.length) put('warn', t('wf.mc.over', { items: d.mc_over.join(', ') }));
  // Stored prices for the MC lines, to take as B (historical) or C (market) — pricedb.js.
  if (ty === 'MC' && wfEditable() && window.prMcButton) prMcButton(box);
  if (ty === 'CT' && off100(n0(d.pct_sum))) put('warn', t('wf.ct.pct', { p: Math.round(n0(d.pct_sum) * 100) / 100 }));
  if (ty === 'LR' && d.source === 'RR' && wfEditable()) put('info', t('lq.fromRR', { rr: d.rr_doc_no || 'RR', p: d.project_code || '' }));
  if (ty === 'LR') { const fb = (d.lines || []).filter(l => l.fin_as_of != null).map(l => l.asset_code);
                     if (fb.length) put('info', t('lq.fromBooks', { n: fb.length, list: fb.slice(0, 8).join(', ') + (fb.length > 8 ? '…' : '') })); }
  if (ty === 'LR' && n0(d.total_nbv) > 0) put('warn', t('lq.nbvLeft', { v: fmtMoney(d.total_nbv) }));
}

async function wfAssetLookup(l, rerender) {
  const code = String(l.asset_code || '').trim();
  if (!code) return;
  try {
    const [a] = await SB.select('am_asset', `select=asset_code,name_vi,name_en,unit_price,qty,unit_code,purchase_date&asset_code=eq.${encodeURIComponent(code)}`);
    if (!a) return msg('#wdMsg', 'warn', t('wf.assetNone', { code }));
    Object.assign(l, { asset_item: [a.name_vi, a.name_en].filter(Boolean).join(' / '), original_value: a.unit_price,
                       qty: l.qty || 1, unit: a.unit_code });
    msg('#wdMsg', '', '');
    rerender();
  } catch (e) { msg('#wdMsg', 'err', e.message); }
}

/* ---------------------------------------------------------- the eight forms
   derive(d, c): fills every computed box (runs before drawing and before
   saving, so the stored document holds the numbers as they were signed).
   build(x): returns the pages. */
const lineSum = (rows, f) => (rows || []).reduce((s, l) => s + n0(f(l)), 0);
const riskOf = d => { d.assessment = n0(d.possibility) * n0(d.impact) || null; d.risk_level = wfRisk(d.assessment); d.suggestion = WF_SUGGEST[d.risk_level] || ''; };
const toUsd = (v, c) => v == null || !isFinite(v) ? null : v / c.fx;
// The unit after a figure: VND ~ USD as on the workbook; just USD when the
// sheet is already shown in USD.
const fsPair = (v, c) => curUsd() ? [fsR('USD')] : [fsR('VND'), fsR('~'), fsR(toUsd(v, c), 'money'), fsR('USD')];
const I = (x, obj, k, ty, opts) => wfInput({ k, t: ty, opts }, obj, x.edit, x.rr, []);

// Columns of the PO / AH sheets, in the workbook's order.
const FS_SPEC_COLS = [['Function', 'function'], ['Capacity', 'capacity'], ['Brand', 'brand'], ['Origin', null],
  ['Model', 'model'], ['Weight', 'weight'], ['Length', 'length'], ['Width', 'width'], ['Height/Depth', 'height'],
  ['Material', 'material'], ['Radius', 'radius'], ['Fuel', 'fuel'], ['Serial', 'serial'], ['Shape', 'shape'],
  ['Area', 'area'], ['Perimeter', 'perimeter'], ['Year', 'mfg_year'], ['Manufacturer', 'manufacturer'],
  ['Accessory', 'accessory'], ['Color', 'color']];
/* Columns of the PO / AH sheets, in the workbook's order. Spec columns with
   nothing in them are left out — on screen and on paper — and so are the ones
   ticked off to fit a portrait A4; "Open every column" shows them all to fill
   in (feedback 25/09/2026). Asset item from the Product catalogue, location
   from the Location list. */
function fsAssetCols(x, extra = []) {
  const d = x.d, lines = d.lines || [], hide = new Set(d.hide_cols || []);
  const showAll = x.edit && !!WF.showAllCols;
  const filled = key => lines.some(l => { const v = key === 'origin' || key === 'warranty_months' ? l[key] : (l.spec || {})[key];
                                          return v != null && String(v).trim() !== ''; });
  const shown = key => showAll || (filled(key) && !hide.has(key));
  const spec = [...FS_SPEC_COLS.map(([h, k]) => k ? { h, key: k, k, t: 'text', obj: l => (l.spec = l.spec || {}) } : { h, key: 'origin', k: 'origin', t: 'text' }),
                { h: 'Warranty Period', key: 'warranty_months', k: 'warranty_months', t: 'num' }].filter(c => shown(c.key));
  // Extra columns (the AH's location) follow the same rule: empty → hidden until the preparer opens every column.
  extra = extra.filter(c => !c.key || showAll || lines.some(l => l[c.key] != null && String(l[c.key]).trim() !== ''));
  // Only a crowded table (many spec columns) takes the small type; a few columns keep the form's size (feedback 26/09/2026).
  x.wide = spec.length + extra.length > 4;
  const fixed = 16 + 5 + 5 + 10 + 11 + (extra.length ? 9 : 0);
  const w = spec.length ? Math.max(3, (100 - 4 - fixed) / spec.length).toFixed(2) + '%' : '';
  return [{ h: 'Asset Item', k: 'asset_item', w: '16%', left: true, cell: l => wfPickProduct(x, l) },
    ...spec.map(c => Object.assign(c, { w })), ...extra,
    { h: 'Qnt', k: 'qty', t: 'num', w: '5%' }, { h: 'Unit', w: '5%', cell: l => wfPickUnit(x, l) },
    { h: 'Unit Price', k: 'unit_price', t: 'money', w: '10%' }, { h: 'Amount', k: 'amount', t: 'money', ro: true, w: '11%' }];
}
// Above the PO / AH table while editing: open every spec column, or tick off the ones to hide.
function fsColBar(x) {
  if (!x.edit || x.mode !== 'screen') return '';
  const d = x.d, hide = new Set(d.hide_cols || []);
  const redraw = () => x.root.replaceWith(fsSheet(x.type, x.edit, x.mode));
  const bar = el('div', { className: 'fcolbar' }, [el('button', { className: 'btn tiny', type: 'button',
    textContent: t(WF.showAllCols ? 'wf.cols.fold' : 'wf.cols.open'), onclick: () => { WF.showAllCols = !WF.showAllCols; redraw(); } })]);
  if (WF.showAllCols) {
    bar.append(el('span', { className: 'dim', textContent: t('wf.cols.pick') }));
    for (const [h, k] of [...FS_SPEC_COLS, ['Warranty Period', 'warranty_months']]) {
      const key = k || 'origin';
      const cb = el('input', { type: 'checkbox', checked: !hide.has(key) });
      cb.onchange = () => { if (cb.checked) hide.delete(key); else hide.add(key); d.hide_cols = [...hide]; wfMarkDirty(); };
      bar.append(el('label', { className: 'chk' }, [cb, el('span', { textContent: h })]));
    }
  }
  return bar;
}
// Overhead lines (transport, installation, consumables…) under the PO table; the total goes to "Overheads".
function fsOverheads(x) {
  const d = x.d; d.olines = d.olines || [];
  if (!x.edit && !d.olines.length) return '';
  const tb = el('table', { className: 'ftable fover' }, [el('colgroup', {}, [el('col', { style: 'width:34px' }), el('col'), el('col', { style: 'width:22%' }),
    ...(x.edit ? [el('col', { style: 'width:24px' })] : [])]),
    el('tr', {}, [el('th', { textContent: 'No.' }), el('th', { textContent: 'Overheads' }), el('th', { textContent: 'Amount' }), ...(x.edit ? [el('th')] : [])])]);
  d.olines.forEach((o, i) => tb.append(el('tr', {}, [el('td', { textContent: String(i + 1) }), el('td', { className: 'l' }, I(x, o, 'label', 'text')),
    el('td', { className: 'n' }, I(x, o, 'amount', 'money')),
    ...(x.edit ? [el('td', { className: 'del' }, el('button', { className: 'xbtn', textContent: '×', onclick: () => { d.olines.splice(i, 1); x.rr(); } }))] : [])])));
  const wrap = el('div', { className: 'ftwrap' }, tb);
  if (x.edit) wrap.append(el('button', { className: 'btn tiny fadd', textContent: t('wf.qc.addOverhead'), onclick: () => { d.olines.push({ label: '' }); x.rr(); } }));
  return wrap;
}
function fsProjectBlock(x, right = []) {
  const p = x.p;
  return fsGrid([fc('PROJECT CODE', fsR(p.code), 4), ...right,
                 fc('PROJECT NAME', fsR(p.name), 4, 'fit'),
                 fc('SUPPLIER', I(x, x.d, 'supplier', 'text'), 4)]);
}

/* --------------------------------------------------- catalogues (Master data)
   The PR / RR boxes for asset item, location and unit take only entries of the
   catalogues: Product catalogue (am_product, written "Tiếng Việt/English" as
   the workbook's Menu!M does), Location (am_location — stored by code, shown
   "CODE - NAME"), Unit (am_unit). What is missing is added to Master data by
   the AM team; it cannot be typed in here. */
const WF_CAT = { loaded: false, products: new Map(), prodNorm: new Map(), locs: new Map(), locNorm: new Map(), units: [] };
const wfProdLabel = p => [p.std_name_vi, p.std_name_en].map(s => String(s || '').trim()).filter(Boolean).join('/');
const wfNormName = s => hnorm(String(s || '').replace(/\s*\/\s*/g, '/'));
const wfLocLabel = l => `${l.code} - ${String(l.name || '').toUpperCase()}`;
async function wfCatLoad(force) {
  if (WF_CAT.loaded && !force) return;
  const [prods, locs, units] = await Promise.all([
    pmSelectAll('am_product', 'select=std_name_vi,std_name_en,default_unit&order=std_name_vi').catch(() => []),
    pmSelectAll('am_location', 'select=code,name,active&order=code').catch(() => []),
    SB.select('am_unit', 'select=code&order=sort_order').catch(() => [])]);
  WF_CAT.products = new Map(); WF_CAT.prodNorm = new Map();
  for (const p of prods) {
    const lbl = wfProdLabel(p);
    if (!lbl || WF_CAT.products.has(lbl)) continue;
    WF_CAT.products.set(lbl, p);
    WF_CAT.prodNorm.set(wfNormName(lbl), lbl);
    const vi = wfNormName(p.std_name_vi);
    if (vi && !WF_CAT.prodNorm.has(vi)) WF_CAT.prodNorm.set(vi, lbl);
  }
  WF_CAT.locs = new Map(locs.filter(l => l.active !== false).map(l => [l.code, l]));
  WF_CAT.locNorm = new Map();
  for (const l of WF_CAT.locs.values()) {
    WF_CAT.locNorm.set(hnorm(l.code), l.code);
    if (l.name && !WF_CAT.locNorm.has(hnorm(l.name))) WF_CAT.locNorm.set(hnorm(l.name), l.code);
  }
  WF_CAT.units = units.map(u => u.code);
  // The type-ahead lists behind the boxes.
  const put = (id, values) => {
    let dl = document.getElementById(id);
    if (!dl) { dl = el('datalist', { id }); document.body.append(dl); }
    dl.innerHTML = '';
    for (const v of values) dl.append(el('option', { value: v }));
  };
  put('wfProdList', WF_CAT.products.keys());
  put('wfLocList', [...WF_CAT.locs.values()].map(wfLocLabel));
  WF_CAT.loaded = true;
}
// The catalogue entry for a name as the budget or a person wrote it: { name, unit } or null.
function wfCatProduct(text) {
  const k = WF_CAT.prodNorm.get(wfNormName(text));
  if (!k) return null;
  return { name: k, unit: WF_CAT.products.get(k).default_unit || null };
}
const wfCatHasProduct = v => WF_CAT.products.has(v);
// The location code for what was written (a code, a name, or "CODE - NAME"), or ''.
function wfCatLocation(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  return WF_CAT.locNorm.get(hnorm(s.split(' - ')[0].trim())) || WF_CAT.locNorm.get(hnorm(s)) || '';
}

// Asset item: a type-ahead on the Product catalogue; anything else is refused.
function wfPickProduct(x, l, k = 'asset_item') {
  if (!x.edit) return fsR(l[k]);
  const i = el('input', { value: l[k] || '', spellcheck: false, className: l[k] && !wfCatHasProduct(l[k]) ? 'bad' : '',
                          title: l[k] && !wfCatHasProduct(l[k]) ? t('wf.cat.product', { v: l[k] }) : '' });
  i.setAttribute('list', 'wfProdList');
  i.onchange = () => {
    const v = i.value.trim();
    if (!v) { l[k] = null; x.rr(); return; }
    const hit = WF_CAT.products.has(v) ? { name: v, unit: WF_CAT.products.get(v).default_unit } : wfCatProduct(v);
    if (!hit) { i.classList.add('bad'); i.value = l[k] || ''; msg('#wdMsg', 'warn', t('wf.cat.product', { v })); return; }
    l[k] = hit.name;
    if (hit.unit) l.unit = hit.unit;                   // PR keeps the unit out of sight, for the documents after it
    msg('#wdMsg', '', '');
    x.rr();
  };
  return i;
}
// Location: a type-ahead on the Location catalogue, stored by code.
function wfPickLoc(x, l) {
  const cur = WF_CAT.locs.get(l.location);
  if (!x.edit) return fsR(cur ? wfLocLabel(cur) : (l.location || ''));
  const i = el('input', { value: cur ? wfLocLabel(cur) : (l.location || ''), spellcheck: false, className: l.location && !cur ? 'bad' : '' });
  i.setAttribute('list', 'wfLocList');
  i.onchange = () => {
    const v = i.value.trim();
    if (!v) { l.location = null; x.rr(); return; }
    const code = wfCatLocation(v);
    if (!code) { i.classList.add('bad'); i.value = cur ? wfLocLabel(cur) : ''; msg('#wdMsg', 'warn', t('wf.cat.location', { v })); return; }
    l.location = code;
    msg('#wdMsg', '', '');
    x.rr();
  };
  return i;
}
// Unit: the Unit catalogue.
const wfPickUnit = (x, l) => x.edit ? wfInput({ k: 'unit', t: 'select', opts: WF_CAT.units }, l, true, x.rr, []) : fsR(l.unit);

/* RR asset code: search the register (the project's department first) as you
   type; an exact code fills Asset Item, Unit and Original value from the
   register, so two assets with the same name are told apart by their code. */
function wfPickAsset(x, l) {
  if (!x.edit) return fsR(l.asset_code);
  const i = el('input', { value: l.asset_code || '', spellcheck: false });
  i.setAttribute('list', 'wfAssetList');
  let tmr = null;
  i.oninput = () => {
    clearTimeout(tmr);
    const q = i.value.trim();
    if (q.length >= 3) tmr = setTimeout(() => wfAssetSearch(q).catch(() => {}), 250);
  };
  i.onchange = async () => {
    l.asset_code = i.value.trim().toUpperCase() || null;
    try { await wfAssetFill(l); } catch (e) { msg('#wdMsg', 'err', e.message); }
    x.rr();
  };
  return i;
}
async function wfAssetSearch(q) {
  const dept = (WF.project || {}).dept_code;
  const pat = encodeURIComponent(`*${q.replace(/[*(),]/g, '')}*`);
  const sel = where => SB.select('am_asset', `select=asset_code,name_vi,name_en&or=(asset_code.ilike.${pat},name_vi.ilike.${pat},name_en.ilike.${pat})${where}&order=asset_code&limit=25`);
  let rows = dept ? await sel(`&dept_code=eq.${encodeURIComponent(dept)}`) : [];
  if (!rows.length) rows = await sel('');
  let dl = document.getElementById('wfAssetList');
  if (!dl) { dl = el('datalist', { id: 'wfAssetList' }); document.body.append(dl); }
  dl.innerHTML = '';
  for (const a of rows) dl.append(el('option', { value: a.asset_code, label: [a.name_vi, a.name_en].filter(Boolean).join('/') }));
}
async function wfAssetFill(l) {
  if (!l.asset_code) return;
  const [a] = await SB.select('am_asset', `select=asset_code,name_vi,name_en,unit_price,unit_code&asset_code=eq.${encodeURIComponent(l.asset_code)}`);
  if (!a) { msg('#wdMsg', 'warn', t('wf.assetNone', { code: l.asset_code })); return; }
  const raw = [a.name_vi, a.name_en].filter(Boolean).join('/');
  const cat = wfCatProduct(raw) || wfCatProduct(a.name_vi);
  Object.assign(l, { asset_item: cat ? cat.name : raw, unit: a.unit_code || l.unit || null,
                     original_value: a.unit_price != null ? Number(a.unit_price) : l.original_value });
  msg('#wdMsg', '', '');
}

/* ----------------------------------------- workbook-exact sheets (PR, RR)
   Drawn on the workbook's own column grid: the column widths of the sheet (in
   the same proportions), its merged cells, row heights and colours — navy
   bars, light-blue page, white boxes, 8-pt labels. Each block is a CSS grid
   over columns A..V; cells are placed by their Excel ranges ('B8:E8'). */
const XS_W = {
  PR: [1.38, 6.54, 6.54, 2, 15.84, 1.84, 18.54, 3.3, 13.84, 1.15, 10.3, 0.84, 5.54, 1.15, 5.3, 1, 5.3, 1, 6.84, 1, 8, 1.15],
  RR: [1.38, 6.54, 6.54, 2, 13.84, 1.84, 20.84, 2.69, 11.69, 1.15, 15.38, 0.84, 10.38, 1.15, 5.3, 1, 5.3, 1, 6.84, 1, 7.3, 1.15]
};
const xsCol = L => L.charCodeAt(0) - 64;
// rows: { excelRow: heightPt }; cells: [[range, kind, content, extraClass]].
function xsBlock(type, rows, cells, cls = '') {
  const nums = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const at = new Map(nums.map((r, i) => [r, i + 1]));
  const g = el('div', { className: 'xsg ' + cls,
    style: `grid-template-columns:${XS_W[type].map(w => w + 'fr').join(' ')};grid-template-rows:${nums.map(r => `minmax(${Math.round(rows[r] * 4 / 3)}px,auto)`).join(' ')}` });
  for (const [range, kind, content, extra] of cells) {
    const [a, b] = range.split(':');
    const m1 = /^([A-Z])(\d+)$/.exec(a), m2 = /^([A-Z])(\d+)$/.exec(b || a);
    const c = el('div', { className: 'xs-' + kind + (extra ? ' ' + extra : ''),
      style: `grid-column:${xsCol(m1[1])} / ${xsCol(m2[1]) + 1};grid-row:${at.get(+m1[2])} / ${at.get(+m2[2]) + 1}` });
    if (content != null && content !== '') c.append(typeof content === 'string' || typeof content === 'number' ? document.createTextNode(String(content)) : content);
    g.append(c);
  }
  return g;
}
// Rows 1-4: company block, the bilingual title, CODE and the date box.
function xsHead(x, type, dateLabel, dateNode) {
  const f = x.form, split = type === 'RR' ? ['B1:F2', 'G1:U2'] : ['B1:G2', 'H1:U2'];
  return xsBlock(type, { 1: 29.9, 2: 15, 3: 13, 4: 20.5, 5: 15 }, [
    [split[0], 'co', el('div', {}, FS_CO.map((s, i) => el('div', { className: i < 2 ? 'b' : 'sm', textContent: s })))],
    [split[1], 'ttl', el('div', {}, [el('div', { textContent: f.title[0].toUpperCase() }), el('div', { textContent: f.title[1].toUpperCase() })])],
    ['M3:Q3', 'hd', 'CODE'], ['R3:U3', 'hd', dateLabel],
    ['M4:Q4', 'cv', WF.doc.doc_no, 'l'], ['R4:U4', 'cv', dateNode, 'l']], 'xs-white');     // both left (feedback 26/09/2026)
}
/* A table on the grid: cols = [[fromCol, toCol, header, cell(line, i), extraClass]].
   Only the filled lines are drawn (no empty rows: the sheet has to fit one page). */
function xsTable(x, type, cols, lines, o = {}) {
  const rows = { 1: o.headH || 29.9 }, cells = cols.map(([a, b, h, , cls]) => [`${a}1:${b}1`, 'th', h, typeof cls === 'string' && cls.includes('n') ? 'c' : '']);
  const n = lines.length;
  for (let r = 0; r < n; r++) {
    const R = r + 2, l = lines[r];
    rows[R] = o.rowH || 20.5;
    for (const [a, b, , fn, cls] of cols) cells.push([`${a}${R}:${b}${R}`, 'td', l ? (a === 'B' ? String(r + 1) : fn(l, r)) : '', (typeof cls === 'function' ? l && cls(l) : cls) || '']);
    if (x.edit && l) {
      const del = el('button', { className: 'xbtn', textContent: '×', title: t('wf.delLine') });
      del.onclick = () => { lines.splice(r, 1); x.rr(); };
      cells.push([`V${R}`, 'del', del]);
    }
  }
  const wrap = el('div', { className: 'xstable' }, xsBlock(type, rows, cells, 'xs-tbl'));
  if (x.edit && o.add) {
    const add = el('button', { className: 'btn tiny fadd', textContent: t('wf.addLine') });
    add.onclick = () => { lines.push(o.add()); x.rr(); };
    wrap.append(add);
  }
  return wrap;
}
// Money in the form's own currency, as typed (not converted by the VND | USD switch).
const xsMoney = v => fsR(v == null || !isFinite(v) ? '' : fmtNum(Math.round(Number(v) * 100) / 100));
// The guidance box of the RR sheet, styled as on the workbook: underlined title,
// bold headings, italic notes. Blank lines are the sheet's own spacing.
const XS_RR_NOTE = () => el('div', {}, [
  ['u', 'Condition Description & Reason for Asset Replacement:'], [''],
  ['b', 'Condition Descriptions:'],
  ['', '1. Full operational – In a condition almost identical to a new item.'],
  ['', '2. Poor – The quality has deteriorated compared to the original condition but is still usable.'],
  ['', '3. Damaged – The quality is significantly impaired, and the item is no longer usable.'], [''],
  ['i', 'Note: The condition must be supported by images/videos documenting the asset\'s current state.'], [''],
  ['b', 'Reason for Asset Replacement:'],
  ['', '1. High repair cost – The cost of repairing the item exceeds its value or is no longer cost-effective.'],
  ['', '2. Obsolete – The item is outdated and no longer meets the required needs or functions.'],
  ['', '3. Irreparable – The item is damaged beyond repair and cannot be restored to working condition.'],
  ['', '4. Breakage/loss – The item has either been broken or is missing, rendering it unusable or unaccounted for.'], [''],
  ['i', 'Note: The reason for replacement must be supported by appropriate evidence (e.g., quotation, incident report, work order, etc.).']
].map(([c, s]) => el('div', { className: c, textContent: s || ' ' })));

/* "Consent by": the signatures of the package, in two rows as on the workbook —
   the preparer and the hotel approvals, then the AM team's checks and the JVC
   approvals. Each box: Prepared / Checked / Approved by, the title, the
   signature, and under it the person's display name (Users → full name) with
   the date. A PA / MC is prepared by the AM Coordinator at their checking step,
   so its boxes start there. Before submission the boxes show the planned roles. */
function fsConsent(x, label = 'Consent by:') {
  const k = WF.pkg || {}, doc = WF.doc, p = x.p;
  const lead = wfLead(k.grp || doc.doc_type), ent = pmEntity(p.dept_code);
  const ownerRoles = wfPkgTypes(k.grp || doc.doc_type).filter(ty => wfSide(ty) === 'owner')
    .map(ty => (wfChain(ent, ty).find(c => c.step === 0) || {}).role_code);
  const steps = WF.steps.length ? WF.steps : wfChain(ent, lead).filter(c => c.step > 0)
    .map(c => ({ step: c.step, role_code: c.role_code, kind: c.kind === 'check' ? 'check' : 'approve', owner_prep: ownerRoles.includes(c.role_code) }));
  const done = s => s.status === 'approved';
  const stepBox = s => ({ lbl: s.kind === 'check' ? 'Checked by' : 'Approved by', role: s.role_code, sig: done(s) ? s.signature : null,
                          name: done(s) ? (s.acted_name || s.acted_email) : '', at: done(s) ? s.acted_at : null,
                          sub: ['returned', 'rejected'].includes(s.status) ? t('wf.st.' + s.status) : '' });
  const prepRole = (wfChain(ent, lead).find(c => c.step === 0) || {}).role_code;
  let boxes;
  if (wfSide(doc.doc_type) === 'owner') {
    const op = steps.findIndex(s => s.owner_prep);
    const s0 = steps[op];
    boxes = [{ lbl: 'Prepared by', role: s0 ? s0.role_code : '', sig: s0 && done(s0) ? s0.signature : null,
               name: s0 && done(s0) ? (s0.acted_name || s0.acted_email) : '', at: s0 && done(s0) ? s0.acted_at : null },
             ...steps.slice(op + 1).map(stepBox)];
  } else {
    boxes = [{ lbl: 'Prepared by', role: prepRole, sig: k.prep_signature, name: k.submitted_at ? (k.created_name || k.created_email) : '', at: k.submitted_at },
             ...steps.map(stepBox)];
  }
  // The MC shows no JVC GM box: the JVC GM approves QC and MC together, and signs on the QC.
  if (doc.doc_type === 'MC') boxes = boxes.filter(b => b.role !== 'JVC_GM');
  // The label receipt's last signature is the hotel taking the labels.
  if (doc.doc_type === 'AL' && boxes.length > 1) boxes[boxes.length - 1].lbl = 'Received by';
  // Two rows: up to the AM team, and from the AM team on (a PA / MC starts with them: one row).
  const split = wfSide(doc.doc_type) === 'owner' || doc.doc_type === 'AL' ? -1 : boxes.findIndex((b, i) => i > 0 && wfBand(b.role) !== 'op');
  const rows = split > 0 ? [boxes.slice(0, split), boxes.slice(split)] : [boxes];
  const cols = Math.max(4, ...rows.map(r => r.length));
  return el('div', { className: 'fconsent' }, [el('div', { className: 'fct', textContent: label }),
    // A short row (the MC's three boxes) keeps the boxes' width and sits in the middle (feedback 26/09/2026).
    ...rows.map(r => el('div', { className: 'fsigs', style: `grid-template-columns:repeat(${r.length},calc((100% - ${(cols - 1) * 8}px) / ${cols}));justify-content:center` }, r.map(b => {
      const [en, vi] = b.role ? wfSigTitle(b.role) : ['', ''];
      return el('div', { className: 'fsig' }, [
        el('div', { className: 'sk', textContent: b.lbl }),
        el('div', { className: 'sr', textContent: en }), el('div', { className: 'ss', textContent: vi || ' ' }),
        el('div', { className: 'simg' }, sigPng(b.sig) ? el('img', { src: sigPng(b.sig), alt: '' }) : ''),
        el('div', { className: 'sn', textContent: b.name || ' ' }),
        el('div', { className: 'sd', textContent: b.sub || (b.at ? fmtDate(String(b.at).slice(0, 10)) : ' ') })]);
    })))]);
}


const WF_FORMS = {
  /* -------------------------------------------------------------- PR
     Workbook sheet "PR", cell for cell: rows 1-4 header, 6-19 general, 21-24
     detailed, 26-65 the lines, 67-71 note + total, 73-75 conclusion. */
  PR: { orient: 'portrait', xs: true, title: ['Purchase Request', 'Yêu cầu mua sắm'],
    derive(d) {
      riskOf(d);
      for (const l of d.lines || []) l.amount = n0(l.qty) * n0(l.unit_price);
      d.total = lineSum(d.lines, l => l.amount);
      d.investment_type = (WF.project && WF.project.investment_type) || d.investment_type || null;
      d.procurement_suggested = procSuggest(d.project_type, d.risk_level, d.total);
      if (!d.procurement_type && d.procurement_suggested) d.procurement_type = d.procurement_suggested;
      // Notes used to be four separate boxes: they now live in one, as on the sheet.
      if (d.notes == null && (d.warranty_term || d.delivery_term || d.note))
        d.notes = [d.warranty_term && `- Warranty time: ${d.warranty_term}`, d.delivery_term && `- Delivery time: ${d.delivery_term}`,
                   d.note && `- Other: ${d.note}`].filter(Boolean).join('\n');
    },
    build(x) {
      const { d, p } = x, seg = String(p.code || '').split('.'), T = 'PR';
      d.lines = d.lines || [];
      const V = (k, ty, opts) => I(x, d, k, ty, opts);
      const cur = d.currency || 'VND';
      const prev = d.cost_benchmark === 'Previous Project';
      // Unbudgeted: department code, project no. and budget year can be changed
      // here, and the project code (and every document number) follows them.
      const recode = x.edit && !p.budgeted && x.mode === 'screen';
      const codeBox = (k, node) => recode ? node : fsR(k);
      const depts = recode ? PM.orgs.filter(o => o.is_department && !PM.orgs.some(c => c.parent_code === o.code)) : [];
      const reSel = el('select');
      if (recode) { for (const o of depts) reSel.append(el('option', { value: o.code, textContent: o.code })); reSel.value = p.dept_code; }
      const reNo = el('input', { value: seg[2] || '', inputMode: 'numeric' }), reYear = el('input', { value: p.year || '', inputMode: 'numeric' });
      for (const i of [reSel, reNo, reYear]) i.onchange = () => wfRecode(p, reSel.value, reNo.value, reYear.value);
      return [el('div', { className: 'xspage' }, [
        xsHead(x, T, 'REQUEST DATE', V('request_date', 'date')),
        xsBlock(T, { 6: 21, 7: 10.75, 8: 21, 9: 10.75, 10: 21, 11: 10.75, 12: 21, 13: 10.75, 14: 10.75, 15: 21, 16: 5.15, 17: 21, 18: 10.75, 19: 15, 20: 7.95 }, [
          ['B6:U6', 'bar', 'GENERAL INFORMATION'],
          ['B7:F7', 'lbl', 'PROJECT CODE'], ['G7:H7', 'lbl', 'PROJECT TYPE'], ['I7:J7', 'lbl', 'DEPARTMENT CODE'], ['K7:L7', 'lbl', 'PROJECT NO.'],
          ['M7:P7', 'lbl', 'BUDGET YEAR'], ['Q7:T7', 'lbl', 'SUB-PROJECT NO.'], ['U7', 'lbl', '%'],
          ['B8:E8', 'val', fsR(p.code)], ['G8', 'val', V('project_type', 'select', ['Consultancy', 'Non-consultancy'])],
          ['I8', 'val', codeBox(p.dept_code, reSel)], ['K8', 'val', codeBox(seg[2] || '', reNo)], ['M8:O8', 'val', codeBox(p.year, reYear)],
          ['Q8:S8', 'val', fsR(seg[4] || '')], ['U8', 'val', V('share_pct', 'pct')],
          ['B9:H9', 'lbl', 'PROJECT NAME'], ['I9:U9', 'lbl', 'DEPARTMENT NAME'],
          ['B10:G10', 'val', fsR(p.name), 'fit'], ['I10:U10', 'val', fsR(deptName(p.dept_code)), 'fit'],
          ['B11:D11', 'lbl', 'CATEGORY'], ['E11:F11', 'lbl', 'BUDGET'], ['G11:H11', 'lbl', 'INVESTMENT TYPE'], ['I11:U11', 'lbl', 'ESTIMATED TOTAL VALUE'],
          ['B12:C12', 'val', V('category', 'select', ['FFE', 'PIP'])], ['E12', 'val', fsR(d.budget)],
          ['G12', 'val', fsR(d.investment_type ? wfOpt(d.investment_type) : '')],
          ['I12:Q12', 'val', xsMoney(d.total), 'n'], ['S12:U12', 'val', V('currency', 'select', ['VND', 'USD'])],
          ['B13:H13', 'lbl', 'RISK-ASSESSMENT'], ['I13:U13', 'lbl', 'REASON/CURRENT CONDITION'],
          ['B14:C14', 'lbl', 'Posibility'], ['E14', 'lbl', 'Impact'], ['G14', 'lbl', 'Assessment'],
          ['B15:C15', 'val', V('possibility', 'select', ['1', '2', '3', '4', '5'])], ['D15', 'txt', 'x'],
          ['E15', 'val', V('impact', 'select', ['1', '2', '3', '4'])], ['F15', 'txt', '='], ['G15', 'val', fsR(d.assessment)],
          ['I15:U19', 'val', V('reason', 'area'), 'l top small'],
          ['E17', 'wtxt', 'Risk Level', 'c'], ['F17', 'txt', ':'], ['G17', 'val', fsR(d.risk_level), 'fit'],
          ['B18:H18', 'lbl', 'SUGGESTION'], ['B19:G19', 'val', fsR(d.suggestion), 'fit']]),
        xsBlock(T, { 21: 21, 22: 3.75, 23: 15, 24: 15, 25: 3.75 }, [
          ['B21:P21', 'bar', 'DETAILED INFORMATION'], ['Q21:T21', 'bar', 'Currency  :', 'r i'], ['U21', 'bar', cur, 'i'],
          ['A22:V22', 'band', ''],
          // Without a previous project the supplier takes the empty box beside it.
          ['B23:F23', 'nav', 'COST BENCHMARK'], ...(prev ? [['G23:H23', 'nav', 'PREVIOUS PROJECT'], ['I23:U23', 'nav', 'SUPPLIER']] : [['G23:U23', 'nav', 'SUPPLIER']]),
          ['B24:F24', 'val', V('cost_benchmark', 'select', ['Quotation', 'Previous Project', 'Price Reference']), 'l'],
          ...(prev ? [['G24:H24', 'val', V('previous_project', 'text'), 'l'], ['I24:U24', 'val', V('supplier', 'text'), 'l']] : [['G24:U24', 'val', V('supplier', 'text'), 'l']])]),
        xsTable(x, T, [['B', 'B', 'No.'],
          ['C', 'F', 'Asset Item', l => wfPickProduct(x, l), 'l'],
          // Centred, at the asset item's size; smaller only for a text too long for the box (feedback 26/09/2026).
          ['G', 'H', 'Rationale', l => I(x, l, 'rationale', 'area'), l => String(l.rationale || '').length > 70 ? 'small' : ''],
          ['I', 'J', 'Technical Standard', l => I(x, l, 'tech_standard', 'area'), l => String(l.tech_standard || '').length > 70 ? 'small' : ''],
          ['K', 'L', 'Location', l => wfPickLoc(x, l)],
          ['M', 'N', 'Qnt', l => I(x, l, 'qty', 'num'), 'n'],
          ['O', 'R', 'Unit Price', l => I(x, l, 'unit_price', 'money'), 'n'],
          ['S', 'U', 'Amount', l => xsMoney(l.amount), 'n']], d.lines, { headH: 29.9, add: () => ({ qty: 1 }) }),
        // A lower note box, and no Conclusion block: the procurement type is decided on the PA.
        xsBlock(T, { 66: 3.75, 67: 15, 68: 14.25, 69: 15, 70: 9.25 }, [
          ['B67:G67', 'nav', 'Note:', 'b'], ['I67:R67', 'wtxt', 'Estimated Total Amount', 'bd b'], ['S67:U67', 'val', xsMoney(d.total), 'n bd b'],
          ['B68:G69', 'val', V('notes', 'area'), 'l top bd']]),
        fsConsent(x)]),
        x.mode === 'screen' ? fsLinks(x) : ''];
    } },

  /* -------------------------------------------------------------- RR
     Workbook sheet "RR": general (project from the PR), the asset lines found
     by their code in the register, the total, the guidance box. */
  RR: { orient: 'portrait', xs: true, title: ['Replacement Request', 'Yêu cầu thay thế/cải tạo/nâng cấp'],
    derive(d, c) {
      d.request_date = c.prData.request_date || d.request_date || (WF.project || {}).request_date || null;
      d.total_qty = lineSum(d.lines, l => l.qty);
      d.total = lineSum(d.lines, l => n0(l.qty) * n0(l.original_value));
    },
    build(x) {
      const { d, p } = x, T = 'RR';
      d.lines = d.lines || [];
      const V = (k, ty, opts) => I(x, d, k, ty, opts);
      return [el('div', { className: 'xspage' }, [
        xsHead(x, T, 'REQUEST DATE', fsR(d.request_date, 'date')),
        xsBlock(T, { 6: 21, 7: 10.75, 8: 21, 9: 7.95, 10: 21, 11: 4.95 }, [
          ['B6:U6', 'bar', 'GENERAL INFORMATION'],
          // No "after replacement" box (each line says it); the replacement level takes its room.
          ['B7:F7', 'lbl', 'PROJECT CODE'], ['G7:L7', 'lbl', 'PROJECT NAME'], ['M7:U7', 'lbl', 'REPLACEMENT LEVEL'],
          ['B8:E8', 'val', fsR(p.code)], ['G8:K8', 'val', fsR(p.name), 'fit'],
          ['M8:U8', 'val', V('replacement_level', 'select', ['Full replacement', 'Partial replacement'])],
          ['B10:P10', 'bar', 'DETAILED INFORMATION'], ['Q10:T10', 'bar', 'Currency  :', 'r i'],
          ['U10', 'bar', x.edit ? V('currency', 'select', ['VND', 'USD']) : (d.currency || 'VND')]]),
        xsTable(x, T, [['B', 'B', 'No.'],
          ['C', 'F', 'Asset Item', l => wfPickProduct(x, l), 'l'],
          ['G', 'H', 'Asset Code', l => wfPickAsset(x, l)],
          ['I', 'J', 'Current condition', l => I(x, l, 'condition', 'select', WF_COND)],
          ['K', 'L', 'Reason', l => I(x, l, 'reason', 'select', WF_RR_REASON)],
          ['M', 'N', 'After replacement', l => I(x, l, 'after', 'select', ['Reuse', 'Spare', 'Liquidation'])],
          ['O', 'P', 'Qnt', l => I(x, l, 'qty', 'num'), 'n'],
          ['Q', 'R', 'Unit', l => wfPickUnit(x, l)],
          ['S', 'U', 'Original value', l => I(x, l, 'original_value', 'money'), 'n']], d.lines,
          { headH: 36, rowH: 15, add: () => ({ qty: 1, after: 'Reuse' }) }),
        xsBlock(T, { 52: 3.75, 53: 15 }, [
          // The unit box left white too, so the total row reads as one strip (feedback 26/09/2026).
          ['K53:N53', 'wtxt', 'Total', 'bd b'], ['O53:P53', 'val', fsR(d.total_qty, 'num'), 'n bd b'], ['Q53:R53', 'val', '', 'bd'], ['S53:U53', 'val', xsMoney(d.total), 'n bd b']]),
        xsBlock(T, { 54: 5.15, 55: 140, 56: 7.4 }, [['B55:U55', 'note', XS_RR_NOTE()]]),     // as tall as its text
        fsConsent(x)]),
        x.mode === 'screen' ? fsLinks(x, 'IMAGES / VIDEOS OF THE CURRENT CONDITION (LINKS)') : ''];
    } },

  /* -------------------------------------------------------------- PA */
  PA: { orient: 'portrait', title: ['Project Assessment', 'Biên bản thẩm duyệt dự án'],
    derive(d, c) {
      const pr = c.prData;
      Object.assign(d, { project_type: pr.project_type || 'Non-consultancy', budget: c.budgeted ? 'Budgeted' : 'Unbudgeted',
                         requested_date: pr.request_date || (WF.project || {}).request_date || null, reason: pr.reason || '',
                         // The PA's own scores once typed; the PR's until then.
                         possibility: d.possibility ?? pr.possibility ?? null, impact: d.impact ?? pr.impact ?? null });
      riskOf(d);
      d.budget_value = c.budgetValue; d.project_value = c.prTotal; d.fx = c.fx;
      d.difference = d.budget_value != null ? d.project_value - d.budget_value : null;
      d.ratio = d.budget_value ? d.difference / d.budget_value : null;
      // The procurement type follows the decision matrix (Menu sheet): project type × risk level × value band.
      // It is not a free choice on the PA (feedback 26/09/2026); only without a value is it picked by hand.
      d.procurement_suggested = procSuggest(d.project_type, d.risk_level, d.project_value);
      if (d.procurement_suggested) d.procurement_type = d.procurement_suggested;
      const g = paGate(d, c); d.gate_ok = g.ok; d.gate = g.text;
      d.total = c.prTotal;
    },
    build(x) {
      const { d, p, c } = x;
      d.lines = d.lines || [];
      // Feedback 25/09/2026: no assessment committee, no gate / emergency /
      // recommendation / comments (a PA that should not proceed is sent back);
      // the risk scores are the PA's own (it is assessed independently of the PR).
      return [fsPage([
        fsHead(x, 'DATE', I(x, d, 'date', 'date')),
        fsBar('GENERAL INFORMATION'),
        fsGrid([fc('PROJECT CODE', fsR(p.code), 2), fc('PROJECT TYPE', fsR(d.project_type), 2), fc('BUDGET', fsR(d.budget), 2),
                fc('COMPARABILITY', I(x, d, 'comparability', 'select', Object.keys(WF_COMPARE)), 2, 'fit'),
                fc('RISK CATEGORY', I(x, d, 'risk_category', 'select', WF_RISK_CAT), 2, 'fit'), fc('REQUESTED DATE', fsR(d.requested_date, 'date'), 2),
                fc('PROJECT NAME', fsR(p.name), 6, 'fit'), fc('REASON/CURRENT CONDITION', fsR(d.reason), 6, 'left rows2'),
                fsRisk(x, d, true)]),
        fsBar('DETAILED INFORMATION'),
        paMoney(d, c),
        fsBar('ASSESSMENT RESULTS'),
        fsTable(x, [{ h: 'Asset Item', k: 'asset_item', t: 'text', w: '17%', left: true }, { h: 'Picture (link)', k: 'picture', t: 'text', w: '12%' },
                    { h: 'Qnt', k: 'qty', t: 'num', w: '6%' }, { h: 'Location', k: 'location', t: 'text', w: '11%' },
                    { h: 'Specifications', k: 'specs', t: 'area', w: '20%' }, { h: 'Current Condition', k: 'condition', t: 'select', opts: WF_COND, w: '11%' },
                    { h: 'Notes', k: 'notes', t: 'area', w: '19%' }], d.lines, { add: () => ({ qty: 1 }) }),
        fsBar('CONCLUSION'),
        // Suggestion and the procurement type (by the rule, one line) side by side, the comparability under both.
        fsGrid([fc('SUGGESTION', fsR(d.suggestion), 6, 'fit'),
                fc('PROCUREMENT TYPE', d.procurement_suggested ? fsR(d.procurement_type) : I(x, d, 'procurement_type', 'select', PROC_OPTS), 6, 'fit'),
                fc('COMPARABILITY', fsR(WF_COMPARE[d.comparability] || ''), 12, 'fit')]),
        fsRiskRef(x), fsLinks(x), fsConsent(x)])];
    } },

  /* -------------------------------------------------------------- QC */
  QC: { orient: 'portrait', title: ['Scoring Tender Form', 'Bảng so sánh đánh giá nhà thầu'],
    derive(d, c) {
      d.vendors = d.vendors || [];
      while (d.vendors.length < 3) d.vendors.push({ name: '' });
      d.qlines = d.qlines || [];
      d.chosen_vendor = d.vendors[0].name || '';              // vendor A is the chosen one, as in the workbook
      d.w_finance = Math.round((100 - n0(d.w_ability) - n0(d.w_technique)) * 100) / 100;   // = 100% - G28 - G26
      const r = qcScore(d);
      d.estimated = n0(d.vendors[0].amount) || null;
      d.budget_value = c.budgetValue;
      d.difference = d.budget_value && d.estimated ? d.estimated - d.budget_value : null;
      d.total = d.estimated;
      d.vendors_scored = r.vendors.map(v => ({ name: v.name, amount: v.amount, ability: v.ability, technique: v.technique, finance: v.finance, total: v.total }));
    },
    build(x) { return qcBuild(x); } },

  /* -------------------------------------------------------------- MC */
  MC: { orient: 'landscape', title: ['Market Check', 'Thẩm định giá'],
    derive(d, c) {
      const qv = (c.qcData.vendors || [])[0] || {};
      d.a_vendor = qv.name || c.qcData.chosen_vendor || '';
      d.lines = d.lines || [];
      let a = 0, b = 0, cc = 0, anyRef = false;
      d.mc_over = [];
      for (const l of d.lines) {
        l.a_amount = n0(l.qty) * n0(l.a_price);
        l.b_price = mcFv(l.b_pv, l.b_year);
        l.b_amount = l.b_price != null ? n0(l.qty) * l.b_price : null;
        l.c_amount = n0(l.c_price) ? n0(l.qty) * n0(l.c_price) : null;
        l.diff_b = l.b_amount ? (l.a_amount - l.b_amount) / l.b_amount : null;
        l.diff_c = l.c_amount ? (l.a_amount - l.c_amount) / l.c_amount : null;
        if (l.b_amount || l.c_amount) anyRef = true;
        if ((l.diff_b != null && l.diff_b > MC_TOL) || (l.diff_c != null && l.diff_c > MC_TOL)) d.mc_over.push(l.item || '?');
        a += l.a_amount; b += n0(l.b_amount); cc += n0(l.c_amount);
      }
      for (const l of d.lines) l.weight = a ? l.a_amount / a : null;
      Object.assign(d, { sub_a: a, sub_b: b || null, sub_c: cc || null, est_value: a,
                         diff_b: b ? (a - b) / b : null, diff_c: cc ? (a - cc) / cc : null });
      d.conclusion = !anyRef ? MC_TEXT.na : d.mc_over.length ? MC_TEXT.over : MC_TEXT.ok;
      d.total = a;
    },
    build(x) {
      const { d, p, c } = x;
      // B (previous vendor) or C (market price) left out of a finished form when it holds nothing.
      const hasB = x.edit || d.lines.some(l => l.b_ref || n0(l.b_pv)), hasC = x.edit || d.lines.some(l => l.c_spec || n0(l.c_price));
      const A = [{ h: 'Spec.', k: 'a_spec', t: 'text', w: '9%' }, { h: 'Unit Price', k: 'a_price', t: 'money', w: '8%' }, { h: 'Amount', get: l => l.a_amount, t: 'money', w: '8%', key: 'a_amount' }];
      const B = [{ h: 'Ref. (asset / project)', k: 'b_ref', t: 'text', w: '9%' }, { h: 'Year', k: 'b_year', t: 'num', w: '4%' },
        { h: 'Price then', k: 'b_pv', t: 'money', w: '7%' }, { h: 'Unit Price (today)', get: l => l.b_price, t: 'money', w: '7%' },
        { h: 'Amount', get: l => l.b_amount, t: 'money', w: '7%', key: 'b_amount' }];
      const C = [{ h: 'Spec.', k: 'c_spec', t: 'text', w: '8%' }, { h: 'Unit Price', k: 'c_price', t: 'money', w: '7%' },
        { h: 'Amount', get: l => l.c_amount, t: 'money', w: '7%', key: 'c_amount' }];
      const D = [...(hasB ? [{ h: '(A-B)/B', get: l => l.diff_b, t: 'pct', w: '5%', key: 'diff_b' }] : []),
                 ...(hasC ? [{ h: '(A-C)/C', get: l => l.diff_c, t: 'pct', w: '5%', key: 'diff_c' }] : [])];
      const cols = [{ h: 'Asset Item', k: 'item', t: 'text', w: '15%', left: true }, { h: 'Weight', get: l => l.weight, t: 'pct', w: '5%' },
        { h: 'Qnt.', k: 'qty', t: 'num', w: '4%' }, ...A, ...(hasB ? B : []), ...(hasC ? C : []), ...D];
      // The name of a vendor on its own line under the group's title.
      const vname = (k, ph) => x.edit ? wfInput({ k, t: 'text' }, d, true, x.rr, []) : el('b', { textContent: d[k] || ph });
      const foot = {};
      const put = (key, v, ty) => { const i = cols.findIndex(cc => cc.key === key); if (i >= 0) foot[i] = [v, ty]; };
      put('a_amount', d.sub_a, 'money'); put('b_amount', d.sub_b, 'money'); put('c_amount', d.sub_c, 'money');
      put('diff_b', d.diff_b, 'pct'); put('diff_c', d.diff_c, 'pct');
      return [fsPage([
        fsHead(x, 'DATE', I(x, d, 'date', 'date')),
        fsBar('GENERAL INFORMATION'),
        // The project on the left, the figures on the right (feedback 26/09/2026).
        el('div', { className: 'fkv2' }, [
          fsKv([['Code:', fsR(WF.doc.doc_no)], ['Date:', fsR(d.date, 'date')], ['Project No.:', fsR(p.code)], ['Project Name:', fsR(p.name)]]),
          fsKv([['Estimated Project Value:', fsR(d.est_value, 'money'), true, [...fsPair(d.est_value, c)]],
                ['Risk Tolerance:', fsR(MC_TOL, 'pct'), true], ['Exrate:', fsR(c.fx, 'money'), true]])]),
        fsBar('DETAILED INFORMATION', 'Time Money Value: price then × (1 + 4.6%)^years'),
        fsTable(x, cols, d.lines, { add: () => ({ qty: 1 }),
          groups: [['', 3], [el('div', { className: 'fgv col' }, ['A: Chosen Vendor', el('b', { textContent: d.a_vendor || '—' })]), 3],
                   ...(hasB ? [[el('div', { className: 'fgv col' }, ['B: Previous Vendor', vname('b_vendor', '[NAME]')]), 5]] : []),
                   ...(hasC ? [[el('div', { className: 'fgv col' }, ['C: Market Price', vname('c_vendor', '[NAME]')]), 3]] : []),
                   ...(D.length ? [['Difference', D.length]] : [])],
          foot: [['Subtotal', 5, foot]] }),
        fsBar('CONCLUSION'),
        fsGrid([fc('', fsR(d.conclusion), 12, 'left strong ' + (d.mc_over.length ? 'badv' : 'okv'))]),
        // A note or an attachment, under a bar like the conclusion's.
        ...(x.edit || d.note ? [fsBar('ATTACHMENT/COMMENT (IF ANY)'), fsGrid([fc('', I(x, d, 'note', 'area'), 12, 'tall left')])] : []),
        fsLinks(x), fsConsent(x)], 'land')];
    } },

  /* -------------------------------------------------------------- PO
     Portrait A4 (feedback 25/09/2026): the empty spec columns left out, no
     total row in the table (the box under it has the totals), overheads as
     lines of their own. */
  PO: { orient: 'portrait', wide: true, title: ['Purchase Order', 'Đơn đặt hàng'],
    derive(d) {
      for (const l of d.lines || []) l.amount = n0(l.qty) * n0(l.unit_price);
      d.total_qty = lineSum(d.lines, l => l.qty);
      d.subtotal = lineSum(d.lines, l => l.amount);
      if ((d.olines || []).length) d.overheads = lineSum(d.olines, o => o.amount) || null;
      d.total = d.subtotal + n0(d.overheads);
    },
    build(x) {
      const d = x.d; d.lines = d.lines || [];
      const cols = fsAssetCols(x);
      return [fsPage([
        fsHead(x, 'ORDER DATE', I(x, d, 'order_date', 'date')),
        fsBar('GENERAL INFORMATION'), fsProjectBlock(x),
        fsBar('DETAILED INFORMATION'), fsColBar(x),
        fsTable(x, cols, d.lines, { add: () => ({ qty: 1, spec: {} }), tail: true }),
        fsOverheads(x),
        fsTerms(x, [['Payment Term', 'payment_term', 'text'], ['Delivery Term', 'delivery_term', 'text'],
                    ['Warranty Term', 'warranty_term', 'text'], ['Progress', 'progress', 'text'], ['Other', 'note', 'area']],
                [['Subtotal', d.subtotal], ['Overheads', d.overheads], ['Total Amount', d.total]]),
        fsConsent(x)])];
    } },

  /* -------------------------------------------------------------- CT
     No workbook sheet for the contract: same look, the key terms only (the
     signed file is linked; drafting belongs to a later contract module). */
  CT: { orient: 'portrait', title: ['Contract', 'Hợp đồng'],
    derive(d) {
      for (const l of d.lines || []) l.amount = Math.round(n0(d.value) * n0(l.pct) / 100);
      d.pct_sum = lineSum(d.lines, l => l.pct);
      d.total = n0(d.value);
    },
    build(x) {
      const { d, p } = x; d.lines = d.lines || [];
      return [fsPage([
        fsHead(x, 'SIGNED DATE', I(x, d, 'signed_date', 'date')),
        fsBar('GENERAL INFORMATION'),
        fsGrid([fc('PROJECT CODE', fsR(p.code), 4), fc('PROJECT NAME', fsR(p.name), 8, 'left'),
                fc('SUPPLIER', I(x, d, 'supplier', 'text'), 6), fc('CONTRACT NO.', I(x, d, 'contract_no', 'text'), 6),
                fc('CONTRACT VALUE (PRE-TAX, VND)', I(x, d, 'value', 'money'), 6, 'num'), fc('WARRANTY (MONTHS)', I(x, d, 'warranty_months', 'num'), 6),
                fc('SIGNED CONTRACT (LINK)', I(x, d, 'file_link', 'text'), 12, 'left')]),
        fsBar('PAYMENT SCHEDULE'),
        fsTable(x, [{ h: 'Milestone', k: 'milestone', t: 'select', opts: ['Deposit', 'Progress', 'Handover', 'Retention'], w: '22%' },
                    { h: '%', k: 'pct', t: 'num', w: '10%' }, { h: 'Amount', get: l => l.amount, t: 'money', w: '22%' },
                    { h: 'Condition / due', k: 'due', t: 'text', w: '42%', left: true }],
                d.lines, { add: () => ({ milestone: 'Progress' }), foot: [['Total', 1, { 1: [d.pct_sum, 'num'], 2: [lineSum(d.lines, l => l.amount), 'money'] }]] }),
        fsGrid([fc('NOTE', I(x, d, 'note', 'area'), 12, 'tall left')]),
        fsConsent(x)])];
    } },

  /* -------------------------------------------------------------- AL
     Asset label receipt (26_alr_project.sql): the labels of one delivery,
     handed to the hotel. Prepared by the AM Coordinator, checked by the AM
     Executive, approved by the JVC Chief Accountant, received by the Hotel
     Asset Manager. The assets are fixed when it is drawn up (the delivery's
     codes); the photos of the attached labels are taken after it is received. */
  AL: { orient: 'portrait', title: ['Asset Label Receipt', 'Biên bản bàn giao tem tài sản'],
    derive(d) {
      const a = d.assets || [];
      d.total_qty = a.reduce((s, r) => s + (n0(r.qty) || 1), 0);
      d.total = a.reduce((s, r) => s + n0(r.unit_price) * (n0(r.qty) || 1), 0);
    },
    build(x) {
      const { d, p } = x; d.assets = d.assets || [];
      const cols = [{ h: 'Asset Code', get: r => r.asset_code, t: 'text', w: '23%' }, { h: 'Barcode', get: r => r.barcode, t: 'text', w: '14%' },
        { h: 'Asset Item', get: r => r.name, t: 'text', w: '27%', left: true }, { h: 'Qnt', get: r => r.qty, t: 'num', w: '6%' },
        { h: 'Unit', get: r => r.unit, t: 'text', w: '7%' }, { h: 'Location', get: r => r.location, t: 'text', w: '18%' }];
      return [fsPage([
        fsHead(x, 'ISSUE DATE', I(x, d, 'date', 'date')),
        fsBar('GENERAL INFORMATION'),
        fsGrid([fc('PROJECT CODE', fsR(p.code), 4), fc('PROJECT NAME', fsR(p.name), 8, 'fit'),
                fc('PURCHASE ORDER', fsR(d.po_no), 4),
                fc('DELIVERY', fsR([d.shipment_code, d.delivery_date && fmtDate(d.delivery_date)].filter(Boolean).join(' · ')), 4, 'fit'),
                fc('DEPARTMENT', fsR(deptName(d.dept_code || p.dept_code)), 4, 'fit')]),
        fsBar('ASSET LABELS', t('al.count', { n: fmtInt(d.assets.length) })),
        fsTable(x, cols, d.assets, { noDel: true }),
        x.edit ? fsGrid([fc('PROCESS & NOTES', I(x, d, 'notes', 'area'), 12, 'tall left')]) : fsNote(d.notes || ALR_NOTES),
        fsConsent(x)])];
    } },

  /* -------------------------------------------------------------- AH
     Portrait A4, English only (the title and the signers' titles keep their
     Vietnamese), no total row in the table, location from the Location list. */
  AH: { orient: 'portrait', wide: true, title: ['Asset Handover', 'Biên bản nghiệm thu'],
    derive(d) {
      for (const l of d.lines || []) l.amount = n0(l.qty) * n0(l.unit_price);
      d.total_qty = lineSum(d.lines, l => l.qty);
      d.total = lineSum(d.lines, l => l.amount);
    },
    build(x) {
      const d = x.d; d.lines = d.lines || [];
      const cols = fsAssetCols(x, [{ h: 'Location', key: 'location', w: '9%', cell: l => wfPickLoc(x, l) }]);
      return [fsPage([
        fsHead(x, 'HANDOVER DATE', I(x, d, 'handover_date', 'date')),
        fsBar('GENERAL INFORMATION'),
        // Project name over supplier on the left, the detailed evaluation as tall as both: no gap.
        fsGrid([fc('PROJECT CODE', fsR(x.p.code), 4),
                fc('PROJECT COMPLETION EVALUATION', I(x, d, 'evaluation', 'select', ['Excellent', 'Satisfactory', 'Unsatisfactory']), 4),
                fc('FINAL HANDOVER', I(x, d, 'final', 'bool'), 4),
                fc('PROJECT NAME', fsR(x.p.name), 4, 'fit'), fc('DETAILED EVALUATION', I(x, d, 'evaluation_detail', 'area'), 8, 'left rows2'),
                fc('SUPPLIER', I(x, d, 'supplier', 'text'), 4)]),
        fsBar('DETAILED INFORMATION'), fsColBar(x),
        fsTable(x, cols, d.lines, { add: () => ({ qty: 1, spec: {} }), tail: true }),
        fsTerms(x, [['Warranty Term', 'warranty_term', 'text'], ['Maintenance Term', 'maintenance_term', 'text'],
                    ['Retention amount', 'retained_amount', 'money'], ['Other', 'note', 'area']], 'Total Amount', d.total),
        fsNote('We agree that all items mentioned above meet your requirements in terms of quantity, quality and these are being handed over to you from owning office by signing this form.\n'
          + 'You are expected to protect, maintain and use the items for working purposes only and should not be used for any personal purposes.'),
        fsLinks(x), fsConsent(x)])];
    } }
};


/* The scoring tender form and its appendix. */
function qcBuild(x) {
  const { d, p, c } = x;
  const V = d.vendors.slice(0, 3), L = ['A: Chosen Vendor', 'B: Vendor', 'C: Vendor'];
  const vn = (v, i) => v.name || ['A', 'B', 'C'][i];
  const pct = (obj, k) => x.edit ? wfInput({ k, t: 'num' }, obj, true, x.rr, []) : fsR(obj[k] != null ? obj[k] + '%' : '');
  const navc = (text, cls = '') => el('td', { className: 'fnav ' + cls, textContent: text });
  const diff = (a, b) => (n0(a) && n0(b)) ? (n0(a) - n0(b)) / n0(b) : null;
  const r = qcScore(d);
  const allW = [d.w_ability, d.w_technique, d.w_finance].every(w => n0(w) > 0);

  // Page 1 — the scoring summary.
  const crit = el('table', { className: 'fqc' });
  crit.append(el('tr', {}, [el('td'), el('td'), el('td'), ...V.map((v, i) => el('td', { className: 'fvh' }, [el('small', { textContent: L[i] }), el('div', { textContent: vn(v, i) })])), el('td')]));
  const rows = [['ABILITY & EXPERIENCE', 'w_ability', 'ability'], ['TECHNIQUES', 'w_technique', 'technique'],
                ['FINANCE', 'w_finance', 'finance'], ['TOTAL SCORE', null, 'total']];
  // Scores on this page are read from the appendix; on screen a click opens it.
  const goApp = () => { WF.qcTab = 'appendix'; x.root.replaceWith(fsSheet(x.type, x.edit, x.mode)); };
  rows.forEach(([lbl, wk, sk], ri) => {
    const tr = el('tr', {}, [navc(lbl), navc('Ratio', 'sm'),
      el('td', { className: 'fvbox n' }, wk && wk !== 'w_finance' ? pct(d, wk)
        : fsR((wk ? n0(d.w_finance) : Math.round(n0(d.w_ability) + n0(d.w_technique) + n0(d.w_finance))) + '%')),
      ...V.map(v => { const td = el('td', { className: 'fvbox n' + (sk === 'total' ? ' strong' : '') }, fsR(v.name ? v[sk] : null, 'num'));
        if (x.mode === 'screen' && sk !== 'total') { td.classList.add('flink'); td.title = t('wf.qc.fromAppendix'); td.onclick = goApp; }
        return td; })]);
    // The Conclusion box runs down beside all four rows, total score included.
    if (ri === 0) tr.append(el('td', { rowSpan: 4, className: 'fconc' + (allW && r.best && r.best.name === d.chosen_vendor ? ' ok' : ' warn') },
      el('div', { className: 'fcw' }, [el('div', { className: 'ch', textContent: 'Conclusion' }),
        el('div', { className: 'cb', textContent: allW ? (d.chosen_vendor || '—') : 'Please assess thoroughly across all three criteria' })])));
    crit.append(tr);
  });
  const oTot = v => (d.olines || []).reduce((s, o, i) => s + n0((v.oprices || {})[i]), 0);   // the vendor's overheads
  const sumCols = [{ h: 'Asset Item', get: l => l.item, t: 'text', w: '26%', left: true }, { h: 'Qnt.', get: l => l.qty, t: 'num', w: '6%' },
    ...V.map((v, vi) => ({ h: vn(v, vi), get: (l, i) => n0((v.prices || {})[i]) ? n0(l.qty) * n0(v.prices[i]) : null, t: 'money', w: '14%' })),   // the vendor's name alone (feedback 26/09/2026)
    { h: '(A-B)/B', get: (l, i) => diff(n0(l.qty) * n0((V[0].prices || {})[i]), n0(l.qty) * n0((V[1].prices || {})[i])), t: 'pct', w: '10%' },
    { h: '(A-C)/C', get: (l, i) => diff(n0(l.qty) * n0((V[0].prices || {})[i]), n0(l.qty) * n0((V[2].prices || {})[i])), t: 'pct', w: '10%' }];
  const page1 = fsPage([
    fsHead(x, 'DATE', I(x, d, 'date', 'date')),
    fsBar('GENERAL INFORMATION'),
    // Five rows on the left, the money on the right (feedback 26/09/2026). A difference above the
    // budget is shown red and says so; the 10 % / USD 5,000 gate is warned beside the form.
    el('div', { className: 'fkv2' }, [
      fsKv([['Code:', fsR(WF.doc.doc_no)], ['Date:', fsR(d.date, 'date')], ['Project No.:', fsR(p.code)], ['Project Name:', fsR(p.name)],
            ['Project Type:', I(x, d, 'project_type', 'select', QC_PTYPES)]]),
      fsKv([['Procurement Type:', I(x, d, 'procurement_type', 'select', PROC_OPTS)],
            ['Budget:', fsR(d.budget_value, 'money'), true, [...fsPair(d.budget_value, c)]],
            ['Estimated Project Value:', fsR(d.estimated, 'money'), true, [...fsPair(d.estimated, c)]],
            ['Difference:', el('span', { className: d.difference > 0 ? 'fover' : '' }, [fsR(d.difference, 'money')]), true, [...fsPair(d.difference, c),
              el('span', { className: d.difference > 0 ? 'fover' : '', textContent: (d.budget_value && d.difference != null ? fmtPct(d.difference / d.budget_value) : '')
                + (d.difference > 0 ? ' over budget' : '') })]],
            ['Exrate:', fsR(c.fx, 'money'), true]])]),
    fsBar('DETAILED INFORMATION'), crit,
    x.mode === 'screen' ? el('div', { className: 'fhint' }, [t('wf.qc.fromAppendix') + ' ',
      el('a', { href: '#', textContent: t('wf.qc.tabApp') + ' →', onclick: ev => { ev.preventDefault(); goApp(); } })]) : '',
    el('table', { className: 'fqc' }, el('tr', {}, [navc('COMMENTS'), el('td', { className: 'fvbox wide' }, I(x, d, 'comments', 'area'))])),
    el('table', { className: 'fqc' }, el('tr', {}, [navc('QUOTATION SUMMARY')])),
    fsTable(x, sumCols, d.qlines, { noDel: true, foot: [
      ...((d.olines || []).length ? [['Overheads', 2, { 2: [oTot(V[0]), 'money'], 3: [oTot(V[1]), 'money'], 4: [oTot(V[2]), 'money'] }]] : []),
      ['Total Amount', 2, { 2: [V[0].amount, 'money'], 3: [V[1].amount, 'money'], 4: [V[2].amount, 'money'],
      5: [diff(V[0].amount, V[1].amount), 'pct'], 6: [diff(V[0].amount, V[2].amount), 'pct'] }]] }),
    fsNote('Notes: For further information regarding the comparison, please refer to the attached Appendix, which provides detailed assessment information.'),
    fsLinks(x, 'QUOTATIONS & VENDOR DOCUMENTS (LINKS)'), fsConsent(x)]);

  // Page 2 — the appendix, where the scores and prices are entered.
  const ap = el('table', { className: 'fqc fap' });
  const vHead = el('tr', {}, [el('td', { className: 'fnav', textContent: 'Total number of vendor(s)' }), el('td', { className: 'fvbox n' }, I(x, d, 'total_vendors', 'num')),
    // Each vendor's name over its score box (the wide one), centred there (feedback 26/09/2026).
    ...V.map((v, i) => [el('td'), el('td', { className: 'fvh' }, [el('small', {}, [L[i] + ' ',
      ...(x.edit && i > 0 ? [el('button', { className: 'btn tiny', textContent: '⇄ A', title: t('wf.qc.makeA'),
        onclick: () => { const [m] = d.vendors.splice(i, 1); d.vendors.unshift(m); x.rr(); } })] : [])]),
      x.edit ? wfInput({ k: 'name', t: 'text' }, v, true, x.rr, []) : el('div', { textContent: v.name || '' })])]).flat()]);
  ap.append(vHead);
  const block = (title, wKey, subsKey, sKey, nKey, scoreKey) => {
    ap.append(el('tr', { className: 'fbh' }, [navc(title), navc('Ratio', 'sm'),
      ...V.map(v => [navc('Score', 'sm'), el('td', { className: 'fvbox n strong' }, fsR(v.name ? v[scoreKey] : null, 'num'))]).flat()]));
    const subs = d[subsKey];
    subs.forEach((s, si) => {
      const lab = x.edit ? el('div', { className: 'fsubl' }, [wfInput({ k: 'label', t: 'text' }, s, true, x.rr, []),
        el('button', { className: 'xbtn', textContent: '×', onclick: () => { subs.splice(si, 1); x.rr(); } })]) : fsR(qcLabel(s.label));
      ap.append(el('tr', {}, [el('td', { className: 'fsub' }, lab), el('td', { className: 'fvbox n' }, pct(s, 'w')),
        ...V.map(v => { v[sKey] = v[sKey] || {}; v[nKey] = v[nKey] || {};
          return [el('td', { className: 'fvbox n' }, x.edit ? wfInput({ k: s.label, t: 'num' }, v[sKey], true, x.rr, []) : fsR(v[sKey][s.label], 'num')),
                  el('td', { className: 'fvbox l' }, x.edit ? wfInput({ k: s.label, t: 'text' }, v[nKey], true, x.rr, []) : fsR(v[nKey][s.label]))]; }).flat()]));
    });
    if (x.edit) ap.append(el('tr', {}, el('td', { colSpan: 8 }, el('button', { className: 'btn tiny fadd', textContent: t('wf.qc.addSub'),
      onclick: () => { subs.push({ label: '', w: 0 }); x.rr(); } }))));
  };
  d.sub_ability = d.sub_ability || qcSubs(QC_ABILITY);
  d.sub_technique = d.sub_technique || qcSubs(qcTechFor(d.project_type));
  block('ABILITY & EXPERIENCE', 'w_ability', 'sub_ability', 's_ability', 'n_ability', 'ability');
  block('TECHNIQUES', 'w_technique', 'sub_technique', 's_technique', 'n_technique', 'technique');
  ap.append(el('tr', { className: 'fbh' }, [navc('FINANCE'), navc('Ratio', 'sm'),
    ...V.map(v => [navc('Score', 'sm'), el('td', { className: 'fvbox n strong' }, fsR(v.name ? v.finance : null, 'num'))]).flat()]));

  // Finance: the quoted items (from the Product catalogue), per vendor spec /
  // unit price / amount; the overhead lines (transport, installation,
  // consumables…); the payment term with its score on a row of its own.
  const fin = el('table', { className: 'ftable fin' });
  // Narrow No. and Qnt., the room to the asset item (feedback 26/09/2026).
  fin.append(el('colgroup', {}, [['3%'], ['14%'], ['4%'], ...V.map(() => [['8%'], ['8%'], ['7.5%']]).flat(), ['4%'], ['4%'], ...(x.edit ? [['24px']] : [])]
    .map(([w]) => el('col', { style: `width:${w}` }))));
  const cols = 3 + V.length * 3 + 2 + (x.edit ? 1 : 0);
  const shift = (o, i) => { if (!o) return; const keys = Object.keys(o).map(Number).filter(k => !isNaN(k)).sort((a, b) => a - b);
    const next = {}; for (const k of keys) { if (k < i) next[k] = o[k]; else if (k > i) next[k - 1] = o[k]; } Object.keys(o).forEach(k => delete o[k]); Object.assign(o, next); };
  fin.append(el('tr', { className: 'fgrp' }, [el('th', { colSpan: 2, textContent: 'Price ratio' }),
    el('th', {}, x.edit ? el('span', { className: 'fvbox inl' }, pct(d, 'w_price')) : fsR((d.w_price ?? '') + '%')),
    ...V.map((v, i) => el('th', { colSpan: 3, textContent: `${'ABC'[i]}: ${v.name || ''}` })), el('th', { colSpan: 2, textContent: 'Difference' }), ...(x.edit ? [el('th')] : [])]));
  fin.append(el('tr', {}, ['No.', 'Asset Item', 'Qnt.', ...V.map(() => ['Spec.', 'Unit Price', 'Amount']).flat(), '(A-B)/B', '(A-C)/C', ...(x.edit ? [''] : [])]
    .map(h => el('th', { textContent: h }))));
  d.qlines.forEach((l, i) => {
    const tr = el('tr', {}, [el('td', { textContent: String(i + 1) }),
      el('td', { className: 'l' }, wfPickProduct(x, l, 'item')), el('td', {}, I(x, l, 'qty', 'num'))]);
    V.forEach((v, vi) => {
      v.prices = v.prices || {}; v.specs = v.specs || {}; v.specx = v.specx || {};
      const key = vi + ':' + i, open = WF.qcSpecOpen === key;
      const spec = el('td', { className: 'fspec' }, [fsR(qcSpecText(v, i))]);
      if (x.edit) spec.append(el('button', { className: 'btn tiny', type: 'button', textContent: open ? '▴' : '✎', title: t('wf.qc.specEdit'),
        onclick: () => { WF.qcSpecOpen = open ? null : key; x.root.replaceWith(fsSheet(x.type, x.edit, x.mode)); } }));
      tr.append(spec,
                el('td', {}, x.edit ? wfInput({ k: String(i), t: 'money' }, v.prices, true, x.rr, []) : fsR(v.prices[i], 'money')),
                el('td', {}, fsR(n0(v.prices[i]) ? n0(l.qty) * n0(v.prices[i]) : null, 'money')));
    });
    const a = n0(l.qty) * n0((V[0].prices || {})[i]);
    tr.append(el('td', {}, fsR(diff(a, n0(l.qty) * n0((V[1].prices || {})[i])), 'pct')),
              el('td', {}, fsR(diff(a, n0(l.qty) * n0((V[2].prices || {})[i])), 'pct')));
    if (x.edit) tr.append(el('td', { className: 'del' }, el('button', { className: 'xbtn', textContent: '×',
      onclick: () => { d.qlines.splice(i, 1); for (const v of V) { shift(v.prices, i); shift(v.specs, i); shift(v.specx, i); } x.rr(); } })));
    fin.append(tr);
    // The spec of one vendor's line, field by field (the PO takes them from here).
    const vo = x.edit && WF.qcSpecOpen && WF.qcSpecOpen.endsWith(':' + i) ? V[+WF.qcSpecOpen.split(':')[0]] : null;
    if (vo) {
      const sx = vo.specx[i] = vo.specx[i] || {};
      const grid = el('div', { className: 'fspecgrid' }, [...FS_SPEC_COLS.map(([h, k]) => el('label', {}, [el('span', { textContent: h }),
          wfInput({ k: k || 'origin', t: 'text' }, sx, true, x.rr, [])])),
        el('label', { className: 'wide' }, [el('span', { textContent: t('wf.qc.specOther') }), wfInput({ k: String(i), t: 'text' }, vo.specs, true, x.rr, [])])]);
      fin.append(el('tr', { className: 'fspecrow' }, el('td', { colSpan: cols }, [el('b', { textContent: `${'ABC'[V.indexOf(vo)]}: ${vo.name || ''} — ${l.item || ''}` }), grid])));
    }
  });
  // Overheads: lines of their own, an amount per vendor (added to its total).
  d.olines = d.olines || [];
  if (d.olines.length || x.edit) fin.append(el('tr', { className: 'fsub2' }, [el('td', { colSpan: 3, className: 'l', textContent: 'Overheads' }),
    ...V.map(() => el('td', { colSpan: 3 })), el('td', { colSpan: 2 }), ...(x.edit ? [el('td')] : [])]));
  d.olines.forEach((o, i) => {
    fin.append(el('tr', {}, [el('td', { colSpan: 3, className: 'l' }, I(x, o, 'label', 'text')),
      ...V.map(v => { v.oprices = v.oprices || {};
        return [el('td', { colSpan: 2 }), el('td', {}, x.edit ? wfInput({ k: String(i), t: 'money' }, v.oprices, true, x.rr, []) : fsR(v.oprices[i], 'money'))]; }).flat(),
      el('td', { colSpan: 2 }),
      ...(x.edit ? [el('td', { className: 'del' }, el('button', { className: 'xbtn', textContent: '×',
        onclick: () => { d.olines.splice(i, 1); for (const v of V) shift(v.oprices, i); x.rr(); } }))] : [])]));
  });
  fin.append(el('tr', { className: 'ftot' }, [el('td', { colSpan: 3, textContent: 'Total Amount' }),
    ...V.map(v => [el('td'), el('td'), el('td', {}, fsR(v.amount, 'money'))]).flat(),
    el('td', {}, fsR(diff(V[0].amount, V[1].amount), 'pct')), el('td', {}, fsR(diff(V[0].amount, V[2].amount), 'pct')),
    ...(x.edit ? [el('td')] : [])]));
  // Payment term: "Score" and "Term" on a row of their own, the values under them.
  fin.append(el('tr', { className: 'fsub2' }, [el('td', { colSpan: 3 }),
    ...V.map(() => [el('td', { textContent: 'Score' }), el('td', { colSpan: 2, textContent: 'Term' })]).flat(), el('td', { colSpan: 2 }), ...(x.edit ? [el('td')] : [])]));
  fin.append(el('tr', {}, [el('td', { colSpan: 2, textContent: 'Payment term' }), el('td', {}, pct(d, 'w_pay')),
    ...V.map(v => [el('td', {}, x.edit ? wfInput({ k: 'pay_score', t: 'num' }, v, true, x.rr, []) : fsR(v.pay_score, 'num')),
                   el('td', { colSpan: 2 }, x.edit ? wfInput({ k: 'pay_term', t: 'text' }, v, true, x.rr, []) : fsR(v.pay_term))]).flat(),
    el('td', { colSpan: 2 }), ...(x.edit ? [el('td')] : [])]));
  const finWrap = el('div', { className: 'ftwrap' }, fin);
  if (x.edit) finWrap.append(el('button', { className: 'btn tiny fadd', textContent: t('wf.addLine'), onclick: () => { d.qlines.push({ qty: 1 }); x.rr(); } }),
    el('button', { className: 'btn tiny fadd', textContent: t('wf.qc.addOverhead'), onclick: () => { d.olines.push({ label: '' }); x.rr(); } }));

  const page2 = fsPage([
    el('div', { className: 'fhead' }, [el('div', { className: 'fco' }, FS_CO.map((s, i) => el('div', { className: i < 2 ? 'b' : '', textContent: s }))),
      el('div', { className: 'fttl' }, [el('div', { className: 't1', textContent: 'Appendix' }), el('div', { className: 't2', textContent: 'Phụ lục' })])]),
    fsBar('DETAILED INFORMATION'), ap, finWrap,
    fsNote('Please note that if the total number of vendors participating exceeds 3, only the information of the 3 most preferable contractors will be presented. The remaining contractors\' related documents should be attached to this file.')], 'fbreak land');
  if (x.mode !== 'screen') return [page1, page2];
  // On screen: the main page and the appendix as two tabs. A new, empty QC
  // opens on the appendix, where its figures are entered.
  if (!WF.qcTab) WF.qcTab = x.edit && !V.some(v => v.name) ? 'appendix' : 'main';
  const tab = (k, label) => el('button', { className: WF.qcTab === k ? 'on' : '', textContent: label,
    onclick: () => { WF.qcTab = k; x.root.replaceWith(fsSheet(x.type, x.edit, x.mode)); } });
  page2.classList.remove('fbreak');
  return [el('div', { className: 'seg fqctabs' }, [tab('main', t('wf.qc.tabMain')), tab('appendix', t('wf.qc.tabApp'))]),
          WF.qcTab === 'main' ? page1 : page2];
}

/* The risk scales printed under the PA (from the workbook), for reference: a
   narrow # column, the scores in brackets. It can be folded away (on screen,
   and then left off the print) when the PA itself needs the room. */
function fsRiskRef(x) {
  const d = x.d, hidden = !!d.hide_ref;
  if (hidden && x.mode !== 'screen') return '';
  const toggle = () => { d.hide_ref = !hidden; if (x.edit) x.rr(); else x.root.replaceWith(fsSheet(x.type, x.edit, x.mode)); };
  const bar = el('div', { className: 'fbar frefbar' }, [el('span', { textContent: 'RISK SCALES (REFERENCE)' }),
    x.mode === 'screen' ? el('button', { className: 'btn tiny', type: 'button', textContent: t(hidden ? 'wf.ref.show' : 'wf.ref.hide'), onclick: toggle }) : '']);
  if (hidden) return bar;
  const tb = el('table', { className: 'ftable fref' });
  tb.append(el('colgroup', {}, [el('col', { style: 'width:4%' }), el('col', { style: 'width:14%' }), ...Array.from({ length: 5 }, () => el('col', { style: 'width:16.4%' }))]));
  const hr = (cells) => el('tr', {}, cells.map(([t2, n]) => el('th', { colSpan: n || 1, textContent: t2 })));
  const row = (cells) => el('tr', {}, cells.map(([t2, n, cls]) => el('td', { colSpan: n || 1, className: cls || 'l', textContent: t2 })));
  const severe = "- Immediate hazard to people's health & safety;\n- Service interruption for more than 12hrs;\n- Reputation damage (service recovery cost) weighted >3 times value of the fixing cost OR > 3 times of ordinary revenue when no failure;\n- Incident acknowledgement from the hotel management team;\n- Periodic internal assessment done by the hotel team or management company;";
  tb.append(hr([['#'], ['POSSIBILITY'], ['Certain (5)'], ['Likely (4)'], ['Moderate (3)'], ['Unlikely (2)'], ['Rare (1)']]),
    row([['1', 1, ''], ['Engineering system'], ['>6 failures in the last 12 mo.'], ['3><6 failures in the last 12 mo.'], ['1><3 failures in the last 12 mo.'], ['once in the last 12 mo.'], ['once in the last 24 mo.']]),
    row([['2', 1, ''], ['Physical touch point (servicing equipment & fit-out)'], ['immediately in guests’ eyesight'], ['within guest eyesight during service engagement'], ['recognizable by close attention'], ['non-important components of equipment or furniture'], ['Only found out by incident']]),
    hr([['#'], ['IMPACT'], ['Severe (4)', 2], ['Significant (3)'], ['Moderate (2)'], ['Minor (1)']]),
    row([['1', 1, ''], ['Engineering system'], [severe, 2],
         ['Potential hazard to people health & safety (guest or employee), Service interruption, Legal compliance with penalty, or fail in HACCP.'],
         ['Damage to:\n- Financial efficiency (waste, revenue lost, exceed cost…);\n- Operational inconsistency (HVAC or hot water temps, food quality);\n- lowering HACCP score but not to FAIL point.'],
         ['Some obstacle in daily works of FOH & BOH teams with very little quantitative impacts to productivity & fixable at convenient time']]),
    row([['2', 1, ''], ['Physical touch point (servicing equipment & fit-out)'], [severe, 2],
         ["- Negative feedback on any public channels OR affect to guest's emotional experience equivalent to score 1 & 2 in LQA benchmark;\n- Mutually mentioned by over 50% employees in EES if for employee’s facility."],
         ["- Negative feedback in VOG but solvable by hotel's service recovery plan OR guest's emotional experience equivalent to score 3 in LQA benchmark; or\n- Having evidences of losing competitive advantage."],
         ['Good for branding purpose but limited impacts guest awareness of the replacement/upgrade or limited financial impacts.']]));
  return el('div', {}, [bar, el('div', { className: 'ftwrap fsmall' }, tb)]);
}

/* ------------------------------------------------------------ actions */
// Freeze every computed box into a document before it is saved, so the printed
// form and the audit log show the numbers as they were when it was sent.
function wfCollectDoc(d) {
  const data = WF.drafts.get(d.id);
  WF_FORMS[d.doc_type].derive(data, wfCtx());
  return data;
}
function wfCollect() { return wfCollectDoc(WF.doc); }

// Save every document of the package that changed, and the one on screen.
async function wfSave(quiet) {
  try {
    const ids = new Set(WF.dirtyIds || []);
    if (wfEditable()) ids.add(WF.doc.id);
    for (const d of WF.pdocs) {
      if (!ids.has(d.id)) continue;
      const own = wfDocEditable(d);
      if (!own && !(wfAdminMode() && d.id === WF.doc.id)) continue;
      // Admin override saves through its own function (any state, logged as an admin edit).
      await SB.rpc(own ? 'pm_doc_save' : 'pm_doc_admin_save', { p_id: d.id, p_data: wfCollectDoc(d) });
    }
    WF.dirty = false;
    WF.dirtyIds.clear();
    if (!quiet) { await wfLoad(); msg('#wdMsg', 'ok', t('wf.saved')); }
    return true;
  } catch (e) { msg('#wdMsg', 'err', e.message); return false; }
}

/* What has to be right before a document leaves its author: the catalogue
   entries, the lines, the scores. Listed per document so the message says
   which of the package's sheets to fix. */
function wfProblems(d) {
  const data = wfCollectDoc(d), ty = d.doc_type, out = [], lines = data.lines || [];
  if (ty === 'PR') {
    if (!lines.length) out.push(t('wf.chk.noLines'));
    lines.forEach((l, i) => {
      if (!l.asset_item) out.push(t('wf.chk.item', { n: i + 1 }));
      else if (!wfCatHasProduct(l.asset_item)) out.push(t('wf.cat.product', { v: l.asset_item }));
      if (!l.location) out.push(t('wf.chk.loc', { n: i + 1 }));
      else if (!WF_CAT.locs.has(l.location)) out.push(t('wf.cat.location', { v: l.location }));
      if (!n0(l.qty)) out.push(t('wf.chk.qty', { n: i + 1 }));
    });
    if (!data.reason) out.push(t('wf.chk.reason'));
  }
  if (ty === 'RR') {
    if (!lines.length) out.push(t('wf.chk.noLines'));
    lines.forEach((l, i) => {
      if (!l.asset_code) out.push(t('wf.chk.assetCode', { n: i + 1 }));
      if (!l.asset_item || !wfCatHasProduct(l.asset_item)) out.push(t('wf.cat.product', { v: l.asset_item || '—' }));
      if (!l.condition || !l.reason || !l.after) out.push(t('wf.chk.condReason', { n: i + 1 }));
      if (l.unit && !WF_CAT.units.includes(l.unit)) out.push(t('wf.cat.unit', { v: l.unit }));
    });
  }
  // LR: the same rules as pm_lq_check, said before the signature is asked for.
  if (ty === 'LR') {
    if (!lines.length) out.push(t('wf.chk.noLines'));
    const seen = new Set();
    lines.forEach((l, i) => {
      const n = i + 1;
      if (!String(l.name || '').trim()) out.push(t('lq.chk.name', { n }));
      if (!(n0(l.qty) > 0)) out.push(t('wf.chk.qty', { n }));
      if (!l.condition || !String(l.reason || '').trim() || !l.mode) out.push(t('lq.chk.cond', { n }));
      if (n0(l.nbv) > 0 && !String(l.nbv_note || '').trim()) out.push(t('lq.chk.nbv', { n }));
      if (l.mode === 'Other' && !String(l.other_note || '').trim()) out.push(t('lq.chk.other', { n }));
      if (l.asset_id) { if (seen.has(l.asset_id)) out.push(t('lq.twice', { code: l.asset_code })); seen.add(l.asset_id); }
      if (l.unit && !WF_CAT.units.includes(l.unit)) out.push(t('wf.cat.unit', { v: l.unit }));
    });
  }
  if (ty === 'QC' && qcScore(data).problems.some(p => p === t('wf.qc.w0') || p === t('wf.qc.w100'))) out.push(t('wf.qc.cannotSubmit'));
  // QC / PO / AH items from the Product catalogue too, the handover's locations from the Location list.
  if (ty === 'QC') (data.qlines || []).forEach(l => { if (l.item && !wfCatHasProduct(l.item)) out.push(t('wf.cat.product', { v: l.item })); });
  if (ty === 'PO' || ty === 'AH') lines.forEach((l, i) => {
    if (!l.asset_item) out.push(t('wf.chk.item', { n: i + 1 }));
    else if (!wfCatHasProduct(l.asset_item)) out.push(t('wf.cat.product', { v: l.asset_item }));
    if (ty === 'AH' && l.location && !WF_CAT.locs.has(l.location)) out.push(t('wf.cat.location', { v: l.location }));
  });
  return out.map(s => `${d.doc_no}: ${s}`);
}

// Send the whole package: every document of the preparer's side, signed once.
async function wfSubmit() {
  const mine = WF.pdocs.filter(d => wfSide(d.doc_type) !== 'owner');
  const probs = mine.flatMap(wfProblems);
  if (WF.pkg.grp === 'PR' && wfIsReplacement(WF.project) && !WF.pdocs.some(d => d.doc_type === 'RR')) probs.unshift(t('wf.chk.needRR'));
  // A handover of labelled assets (from AL): every asset needs its two photos first.
  const ah = mine.find(d => d.doc_type === 'AH');
  const ahIds = ah && ((WF.drafts.get(ah.id) || ah.data || {}).asset_ids || []);
  if (ahIds && ahIds.length) {
    try {
      const assets = [];
      for (let i = 0; i < ahIds.length; i += 200) assets.push(...await SB.select('am_asset', `select=id,asset_code&id=in.(${ahIds.slice(i, i + 200).join(',')})`));
      const gaps = await phGaps(assets);
      if (gaps.length) probs.push(t('ph.gaps', { n: gaps.length, list: gaps.slice(0, 12).join(', ') + (gaps.length > 12 ? '…' : '') }));
    } catch (e) { probs.push(e.message); }
  }
  // A liquidation request: a condition photo of every line (the Disposal Form's evidence).
  const lr = mine.find(d => d.doc_type === 'LR');
  if (lr && !probs.length) {
    try { const gaps = await lqPhotoGaps(lr); if (gaps.length) probs.push(t('lq.ph.gaps', { list: gaps.join(', ') })); }
    catch (e) { probs.push(e.message); }
  }
  if (probs.length) return msg('#wdMsg', 'err', probs.join('\n'));
  if (!(await wfSave(true))) return;
  const nos = mine.map(d => d.doc_no).join(' + ');
  // Signing IS the confirmation: the pad says what is being signed.
  const png = await sigAsk(t('sig.titleSubmit', { no: nos }));
  if (png === null) return;                     // cancelled; '' = skipped (not compulsory)
  try {
    await SB.rpc('pm_pkg_submit', { p_pkg: WF.pkg.id, p_signature: png ? { png } : null });
    await wfLoad(); wfBadge();
    msg('#wdMsg', 'ok', t('wf.submitted', { no: nos }));
  } catch (e) { msg('#wdMsg', 'err', e.message); }
}

/* Approve / check / return / reject the package's current step. At the AM
   Coordinator's step "Checked" needs the PA / MC complete: it signs the PR / RR
   (QC) as checked and the PA (MC) as prepared, in one go. A return after the
   AM team has checked goes either to the preparer (target 'operator') or, for
   the PA / MC alone, to the AM team (target 'am'). */
async function wfAct(action, target) {
  const note = ($('#wdNote') || {}).value || '';
  if (action !== 'approve' && !note.trim()) return msg('#wdMsg', 'err', t('wf.needReason'));
  const step = wfCurStep() || {};
  const nos = WF.pdocs.map(d => d.doc_no).join(' + ');
  let png = null;
  if (action === 'approve') {
    if (step.owner_prep) {
      const own = WF.pdocs.filter(d => wfSide(d.doc_type) === 'owner');
      const probs = own.flatMap(wfProblems);
      const need = wfPkgTypes(WF.pkg.grp).filter(ty => wfSide(ty) === 'owner' && !own.some(d => d.doc_type === ty));
      if (need.length) probs.unshift(t('wf.chk.needOwner', { t: need.join(', ') }));
      if (probs.length) return msg('#wdMsg', 'err', probs.join('\n'));
      if (!(await wfSave(true))) return;
    }
    png = await sigAsk(t(step.owner_prep ? 'sig.titleCheckPrep' : step.kind === 'check' ? 'sig.titleCheck' : 'sig.titleApprove', { no: nos }));
    if (png === null) return;
  } else if (!confirm(t(action === 'return' && target === 'am' ? 'wf.confirm.returnAm' : 'wf.confirm.' + action, { no: nos }))) return;
  const lrPkg = WF.pkg.grp === 'LR';            // approved: its lines go to the liquidation pool, not to a project
  try {
    const to = await SB.rpc('pm_pkg_act', { p_pkg: WF.pkg.id, p_action: action, p_comment: note.trim() || null,
                                            p_signature: png ? { png } : null, p_target: target || null });
    await wfLoad(); wfBadge();
    const k = action === 'approve' ? (to === 'approved' ? 'final' : step.owner_prep ? 'checkPrep' : step.kind === 'check' ? 'check' : 'approve')
      : to === 'returned_am' ? 'returnAm' : action;
    // On a tablet the next thing to do is the next task: back to the list, the result said there.
    if (TB.on) { TB.flash = t(k === 'final' && lrPkg ? 'lq.final' : 'wf.acted.' + k, { no: nos }); return showView('inbox'); }
    msg('#wdMsg', 'ok', t(k === 'final' && lrPkg ? 'lq.final' : 'wf.acted.' + k, { no: nos }));
  } catch (e) { msg('#wdMsg', 'err', e.message); }
}

// Admin override: the whole package goes back to draft (its approval chain for
// this submission is dropped); milestones already pushed to the project stay.
async function wfAdminReopen() {
  const nos = WF.pdocs.map(d => d.doc_no).join(' + ');
  const why = prompt(t('wf.adminReopenWhy', { no: nos }));
  if (why === null) return;
  try { await SB.rpc('pm_doc_admin_reopen', { p_id: WF.doc.id, p_comment: why || null }); await wfLoad(); wfBadge();
        msg('#wdMsg', 'ok', t('wf.adminReopened', { no: nos })); }
  catch (e) { msg('#wdMsg', 'err', e.message); }
}

async function wfCancel() {
  const nos = WF.pdocs.map(d => d.doc_no).join(' + ');
  const why = prompt(t('wf.cancelWhy', { no: nos }));
  if (why === null) return;
  try { await SB.rpc('pm_pkg_cancel', { p_pkg: WF.pkg.id, p_comment: why || null }); await wfLoad(); wfBadge();
        msg('#wdMsg', 'ok', t('wf.cancelled', { no: nos })); }
  catch (e) { msg('#wdMsg', 'err', e.message); }
}

// Take one document (not the lead) out of a package that is still being prepared.
async function wfRemoveDoc() {
  const d = WF.doc;
  if (!confirm(t('wf.removeConfirm', { no: d.doc_no }))) return;
  try {
    await SB.rpc('pm_doc_remove', { p_id: d.id });
    WF.openId = (WF.pdocs.find(x => x.doc_type === wfLead(WF.pkg.grp)) || d).id;
    WF.doc = null;
    await wfLoad();
    msg('#wdMsg', 'ok', t('wf.removed', { no: d.doc_no }));
  } catch (e) { msg('#wdMsg', 'err', e.message); }
}

/* An approved handover becomes the next delivery in the asset intake, with the
   project code as its purpose — so the assets it hands over get their codes
   through the one path that allocates them. */
function wfToIntake() {
  const d = WF.doc.data || {}, p = WF.project || {};
  if (IN.lines.length && !confirm(t('dn.replace', { n: IN.lines.length }))) return;
  IN.lines = (d.lines || []).map(l => {
    const ln = Object.assign(inBlank(), {
      qty: n0(l.qty) || 1, unit_price: l.unit_price ?? '', origin_raw: l.origin || '',
      // The location on a handover is free text; the intake wants a location
      // code, so it rides in the description for the reviewer to pick.
      description: [l.location && `@ ${l.location}`, l.warranty_months && `BH ${l.warranty_months}m`].filter(Boolean).join(' · '),
      spec: Object.assign({}, l.spec || {}), serials: (l.spec && l.spec.serial) || ''
    });
    if (l.unit) ln.unit_code = l.unit;
    inSetName(ln, l.asset_item || '');
    return ln;
  });
  IN.checked = null; IN.sugRan = false;
  IN.src = { project: p.code, po: WF.doc.doc_no };      // the delivery batch records the PO it came from
  showView('intake');
  $('#inPurpose').value = p.code || '';
  $('#inSupplier').value = d.supplier || p.chosen_vendor || '';
  if (d.handover_date || d.order_date) $('#inDate').value = d.handover_date || d.order_date;
  inRender();
  msg('#inMsg', 'ok', t('wf.intakeReady', { n: IN.lines.length, no: WF.doc.doc_no }));
  inResolveOrigins().then(n => n && inRender()).catch(() => {});
}

/* ------------------------------------------------------ print and PDF
   Both use the same sheet as the screen, drawn read-only. Print goes through
   the browser (which can also "Save as PDF"); "Export PDF" writes the file
   directly, named after the document number. */
function wfPageRule(orient) {
  document.getElementById('am-page-rule')?.remove();
  const st = el('style', { id: 'am-page-rule' });
  st.textContent = `@page{size:A4 ${orient};margin:8mm}`;
  document.head.append(st);
}

/* One form page always goes on ONE A4 page: it is laid out a little wider
   until it is no taller than the page allows, then scaled back down to the
   page width. Returns the box to put on the page. */
function xsFit(sheet, pageW, ratio) {
  sheet.classList.add('pdf');
  const probe = el('div', { className: 'fpdfhost' }, sheet);
  document.body.append(probe);
  fsFit(sheet);
  const tall = w => { sheet.style.width = w + 'px'; return sheet.getBoundingClientRect().height; };
  let w = pageW, h = tall(w);
  if (h > w * ratio) {
    let lo = w, hi = Math.ceil(h / ratio);
    while (tall(hi) > hi * ratio) hi = Math.ceil(hi * 1.2);
    for (let i = 0; i < 8; i++) { const mid = Math.round((lo + hi) / 2); if (tall(mid) > mid * ratio) lo = mid; else hi = mid; }
    w = hi; h = tall(w);
  }
  const k = pageW / w;
  Object.assign(sheet.style, { transform: k < 1 ? `scale(${k})` : '', transformOrigin: '0 0' });
  probe.remove();
  return el('div', { className: 'xsfit', style: `width:${pageW}px;height:${Math.ceil(h * k)}px` }, sheet);
}
/* Every page of a drawn sheet, each fitted to one A4 page (feedback 25/09/2026):
   portrait for PR, RR, PA, QC, PO, CT, AH; landscape for the QC appendix and the
   MC (pages marked .land). pageW / ratio are the printable area in CSS px. */
const FS_A4 = { port: { w: 733, r: 1.43 }, land: { w: 1062, r: 0.68 } };
function fsPages(sheet) {
  const pages = [...sheet.children].filter(n => n.classList && (n.classList.contains('fpage') || n.classList.contains('xspage')));
  if (!pages.length) return [{ box: xsFit(sheet, FS_A4.port.w, FS_A4.port.r), land: false }];
  return pages.map(pg => {
    const land = pg.classList.contains('land'), a = land ? FS_A4.land : FS_A4.port;
    return { box: xsFit(el('div', { className: sheet.className }, pg), a.w, a.r), land };
  });
}

// Print the form on screen: one A4 page per form page, in its own orientation.
function wfPrint() {
  const root = $('#wdPrint'), type = wfShown().doc_type;
  root.innerHTML = '';
  wfCollect();
  for (const p of fsPages(fsSheet(type, false, 'print'))) root.append(el('div', { className: 'fprintpage' + (p.land ? ' land' : '') }, p.box));
  wfPageRule('portrait');
  window.print();
}
// Export the form on screen as a PDF: the same pages, through the capture below (saved first, so the file is what is stored).
async function wfPdf() {
  if (WF.dirty && wfEditable() && !(await wfSave(true))) return;
  await wfCaptureForms(WF.project._lq ? '' : WF.project.code, 'pdf', '#wdMsg', wfShown().id);
}

/* ----------------------------------------- every form of a project, captured
   "All forms": each document of the project that is not cancelled / rejected,
   in the order of the procedure (PR · RR · PA · QC · MC · PO · CT · AH), every
   page of every form drawn as on paper — each with its own package's
   signatures, each on one A4 page — handed back as ONE PDF (bookmarked by
   document number), a print preview, or ONE ZIP of PNG pictures. Drawn
   off-screen: whatever is open stays as it was. onlyId: just that document. */
const WF_CAP_KEYS = ['project', 'docs', 'line', 'year', 'pkg', 'steps', 'pdocs', 'doc', 'data', 'drafts', 'dirtyIds',
                     'ref', 'refs', 'qcTab', 'adminEdit', 'events', 'inRef'];
async function wfCaptureForms(code, fmt, out, onlyId) {
  const keep = Object.fromEntries(WF_CAP_KEYS.map(k => [k, WF[k]]));
  const host = el('div', { className: 'fpdfhost' });
  const shots = [];
  try {
    msg(out, 'info', t(onlyId ? 'wf.pdfMaking' : 'wf.cap.loading'));
    await Promise.all(['html2canvas', fmt === 'zip' ? 'JSZip' : 'jspdf'].map(snapLib));
    await wfLookups(); await wfCatLoad();
    const enc = encodeURIComponent(code);
    // No project code: one liquidation request (onlyId), in its own package.
    const [[project], docs, pkgs] = code ? await Promise.all([
      SB.select('pm_project', `select=*&code=eq.${enc}`),
      SB.select('pm_doc', `select=*&project_code=eq.${enc}`),
      SB.select('pm_pkg', `select=*&project_code=eq.${enc}`)])
      : await SB.select('pm_doc', `select=*&id=eq.${Number(onlyId) || 0}`).then(async ds => [[ds[0] ? lqProject(ds[0]) : null], ds,
          ds[0] ? await SB.select('pm_pkg', `select=*&id=eq.${ds[0].pkg_id}`) : []]);
    if (!code) await lqPhotosLoad(docs);
    const live = docs.filter(d => !['cancelled', 'rejected'].includes(d.status) && WF_FORMS[d.doc_type])
      .sort((a, b) => wfSeq(a.doc_type) - wfSeq(b.doc_type) || a.id - b.id);
    const todo = onlyId ? docs.filter(d => d.id === onlyId) : live;
    if (!project || !todo.length) throw new Error(t('wf.cap.none'));
    const pids = [...new Set(docs.map(d => d.pkg_id).filter(Boolean))];
    const [steps, years, line] = await Promise.all([
      pids.length ? SB.select('pm_pkg_step', `select=*&pkg_id=in.(${pids.join(',')})&order=step`) : [],
      code ? SB.select('pm_budget_year', `select=*&year=eq.${Number(project.year) || 0}`) : [],
      code ? wfFinalLine(project) : null]);
    Object.assign(WF, { project, docs, line: line || null, year: years[0] || null, drafts: new Map(), dirtyIds: new Set(),
                        adminEdit: false, events: [], refs: [], qcTab: null, inRef: false });
    document.body.append(host);
    for (const d of todo) {
      if (!onlyId) msg(out, 'info', t('wf.cap.progress', { no: d.doc_no, n: shots.length + 1 }));
      const pkg = pkgs.find(k => k.id === d.pkg_id) || {}, pst = steps.filter(s => s.pkg_id === d.pkg_id);
      WF.drafts.set(d.id, JSON.parse(JSON.stringify(d.data || {})));
      // Drawn as a "reference" document: in its own package's context, read-only.
      Object.assign(WF, { pkg, steps: pst, pdocs: live.filter(o => o.pkg_id === d.pkg_id), doc: d, data: WF.drafts.get(d.id),
                          ref: { d, pkg, steps: pst, pdocs: live.filter(o => o.pkg_id === d.pkg_id) } });
      host.innerHTML = '';
      const pages = fsPages(fsSheet(d.doc_type, false, 'print'));
      for (let i = 0; i < pages.length; i++) {
        host.innerHTML = '';
        host.append(pages[i].box);
        const canvas = await html2canvas(pages[i].box, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true });
        shots.push({ label: pages.length > 1 ? `${d.doc_no} (${i + 1}-${pages.length})` : d.doc_no, first: i === 0, doc: d.doc_no, land: pages[i].land, canvas });
      }
    }
    msg(out, 'info', t('wf.cap.building', { n: shots.length }));
    const base = onlyId ? todo[0].doc_no : `${code} - ${t('wf.cap.file')}`;
    if (fmt === 'zip') {
      const zip = new JSZip();
      shots.forEach((s, i) => zip.file(`${String(i + 1).padStart(2, '0')} - ${s.label.replace(/[\\/:*?"<>|]/g, ' ')}.png`,
        s.canvas.toDataURL('image/png').split(',')[1], { base64: true }));
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = el('a', { href: URL.createObjectURL(blob), download: base + '.zip' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } else if (fmt === 'preview') wfCapPreview(wfCapPdf(shots), base);
    else wfCapPdf(shots).save(base + '.pdf');
    msg(out, 'ok', onlyId ? t('wf.pdfDone', { file: base + '.pdf' })
                          : t(fmt === 'preview' ? 'wf.cap.shown' : 'wf.cap.done', { n: shots.length, d: todo.length }));
  } catch (e) {
    msg(out, 'err', t('wf.cap.fail') + ' ' + (e && e.message || e));
  } finally {
    host.remove();
    Object.assign(WF, keep);
  }
}
// Print preview: the PDF in a window over the app, where the browser's viewer prints or saves it.
function wfCapPreview(doc, name) {
  $('#capPrev')?.remove();
  const url = URL.createObjectURL(doc.output('blob'));
  const close = el('button', { className: 'dbtn', type: 'button', textContent: '✕', title: t('pm.prj.close') });
  const ov = el('div', { id: 'capPrev', className: 'capprev' }, [
    el('div', { className: 'dhead' }, [el('h2', { textContent: name }), close]),
    el('iframe', { src: url, title: name })]);
  close.onclick = () => { ov.remove(); URL.revokeObjectURL(url); };
  document.body.append(ov);
}
// An A4 page per form page, portrait or landscape as the form, the picture fitted inside 6 mm margins.
function wfCapPdf(shots) {
  const { jsPDF } = window.jspdf;
  let doc = null;
  for (const s of shots) {
    const o = s.land ? 'l' : 'p', W = s.land ? 297 : 210, H = s.land ? 210 : 297, m = 6;
    if (!doc) doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: o, compress: true });
    else doc.addPage('a4', o);
    const k = Math.min((W - 2 * m) / s.canvas.width, (H - 2 * m) / s.canvas.height);
    const w = s.canvas.width * k, h = s.canvas.height * k;
    doc.addImage(s.canvas.toDataURL('image/jpeg', 0.9), 'JPEG', (W - w) / 2, m, w, h);
    if (s.first) try { doc.outline.add(null, s.doc, { pageNumber: doc.getNumberOfPages() }); } catch {}
  }
  return doc;
}
// The two buttons ("All forms · PDF", "· PNG") and where they report.
function wfCapButtons(code, out) {
  const b = (fmt, key) => {
    const x = el('button', { className: 'btn tiny', textContent: t(key), title: t('wf.cap.title') });
    x.onclick = async () => { x.disabled = true; try { await wfCaptureForms(code, fmt, out); } finally { x.disabled = false; } };
    return x;
  };
  return [b('preview', 'wf.cap.preview'), b('pdf', 'wf.cap.pdf'), b('zip', 'wf.cap.zip')];
}

/* ------------------------------------------------------------- inbox */
/* One line per PACKAGE waiting for this person ("PR.… + RR.… + PA.…"),
   coloured by who acts — blue hotel, purple AM team, yellow JVC — plus the
   packages returned to them and the next package they have to draw up.
   Under them what this person has already done (user 25/09/2026): ticked and
   faded, so they remember what they did; a search box and filters above. */
async function wfInboxLoad() {
  MONEY.year = null;
  const out = $('#wiMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await wfLookups();
    WF.inbox = [...(await SB.rpc('pm_inbox')), ...(await wfPrepTodos().catch(() => [])), ...(await lqTodos().catch(() => [])), ...(window.aoTodos ? await aoTodos().catch(() => []) : [])];
    WF.done = await wfDoneLoad().catch(() => []);
    msg(out, TB.flash ? 'ok' : '', TB.flash || ''); TB.flash = null;      // the result of a signature on a tablet
    wfInboxRender();
    wfBadge(wfInboxCount(WF.inbox));
  } catch (e) { msg(out, 'err', e.message); }
}

// What this person did lately: submitted, approved, checked, returned, rejected — from the packages' history.
async function wfDoneLoad() {
  if (!ME) return [];
  const ev = await SB.select('pm_pkg_event', `select=pkg_id,at,action,step&actor=eq.${ME.id}` +
    '&action=in.(submit,resubmit,approve,return,return_am,reject,cancel)&order=at.desc&limit=200');
  if (!ev.length) return [];
  const ids = [...new Set(ev.map(e => e.pkg_id))];
  const [pkgs, docs, steps] = await Promise.all([
    SB.select('pm_pkg', `select=*&id=in.(${ids.join(',')})`),            // * : dept_code exists once 27_liquidation.sql ran
    SB.select('pm_doc', `select=id,pkg_id,doc_no,doc_type,total_value,status&pkg_id=in.(${ids.join(',')})&status=neq.cancelled`),
    SB.select('pm_pkg_step', `select=pkg_id,step,role_code,kind&pkg_id=in.(${ids.join(',')})`)]);
  const codes = [...new Set(pkgs.map(k => k.project_code).filter(Boolean))];
  const prj = codes.length ? await SB.select('pm_project', `select=code,name,dept_code&code=in.(${codes.map(encodeURIComponent).join(',')})`) : [];
  return ev.map(e => {
    const k = pkgs.find(x => x.id === e.pkg_id) || {}, p = prj.find(x => x.code === k.project_code) || {};
    const ds = docs.filter(d => d.pkg_id === e.pkg_id).sort((a, b) => wfSeq(a.doc_type) - wfSeq(b.doc_type));
    const s = steps.find(x => x.pkg_id === e.pkg_id && x.step === e.step) || {};
    return { kind: 'done', action: e.action, at: e.at, step: e.step, role_code: s.role_code, step_kind: s.kind, grp: k.grp,
             doc_id: (ds[0] || {}).id, doc_no: ds.map(d => d.doc_no).join(' + '), project_code: k.project_code,
             project_name: p.name || (k.grp === 'LR' ? t('lq.docName') : ''), dept_code: p.dept_code || k.dept_code,
             total_value: ds.reduce((a, d) => a + (Number(d.total_value) || 0), 0) || null };
  });
}

function wfInboxRender() {
  const q = hnorm(($('#wiQ') || {}).value || ''), show = ($('#wiShow') || {}).value || '', ty = ($('#wiType') || {}).value || '';
  const all = [...(WF.inbox || []), ...(WF.done || [])];
  // Type choices from the rows themselves.
  const types = [...new Set(all.flatMap(r => String(r.doc_no || '').split(' + ').map(lqNoType)).filter(Boolean))].sort((a, b) => wfSeq(a) - wfSeq(b));
  selFill($('#wiType'), [['', t('pm.f.all')], ...types.map(x => [x, `${x} — ${wfTypeName(x)}`])]);
  selFill($('#wiShow'), [['', t('wf.i.showAll')], ['todo', t('wf.i.showTodo')], ['done', t('wf.i.showDone')]]);
  const rows = all.filter(r => (!show || (show === 'done') === (r.kind === 'done'))
    && (!ty || String(r.doc_no || '').split(' + ').some(n => lqNoType(n) === ty))
    && (!q || hnorm(`${r.doc_no} ${r.project_code} ${r.project_name} ${r.dept_code} ${pmDeptName(r.dept_code)}`).includes(q)));
  const head = $('#wiGrid thead'), body = $('#wiGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, [['wf.i.kind'], ['wf.i.doc'], ['wf.i.type'], ['pm.col.code'], ['pm.col.name'], ['pm.col.dept'],
    ['wf.i.value', 'num'], ['wf.i.sent'], ['wf.i.step']].map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
  if (!rows.length) body.append(el('tr', {}, el('td', { colSpan: 9, style: 'color:var(--dim);padding:14px',
    textContent: (WF.inbox || []).length || (WF.done || []).length ? t('pm.none.filter') : t('wf.inboxEmpty') })));
  for (const r of rows) {
    const done = r.kind === 'done';
    const owners = wfPkgTypes(r.grp).filter(ty2 => wfSide(ty2) === 'owner').join('/');
    const band = done ? 'ok' : ['returned', 'tfret'].includes(r.kind) ? 'bad' : ['prepare', 'photo', 'draft', 'tf'].includes(r.kind) ? 'op' : wfBand(r.role_code);
    const what = r.kind === 'tf' ? t('ao.tf.i.act') : r.kind === 'tfret' ? t('wf.i.returned') : done ? '✓ ' + (r.action === 'approve' && r.step_kind === 'check' ? t('wf.st.checked') : t('wf.a.' + r.action))
      : r.kind === 'photo' ? t('ph.todo', { n: r.missing }) : r.kind === 'draft' ? t('lq.i.draft') : r.kind === 'prepare' ? t('wf.i.prepare', { t: r.doc_type }) : r.kind === 'returned' ? t('wf.i.returned')
      : r.owner_prep ? t(r.returned_to === 'am' ? 'wf.i.redoOwner' : 'wf.i.checkPrep', { t: owners })
      : t(r.step_kind === 'check' ? 'wf.i.check' : 'wf.i.approve');
    const nos = String(r.doc_no || '').split(' + ').filter(Boolean);
    const when = done ? r.at : r.submitted_at;
    const tr = el('tr', { className: done ? 'done' : '', style: 'cursor:pointer' }, [
      el('td', {}, el('span', { className: 'stg band-' + band, textContent: what })),
      r.kind === 'prepare'
        ? el('td', {}, [el('code', { textContent: r.doc_no }), document.createTextNode(' → '),
            el('button', { className: 'btn tiny pri', textContent: t('wf.createType', { t: r.doc_type }),
              onclick: ev => { ev.stopPropagation(); wfCreateFor(r.project_code, r.doc_type, '#wiMsg'); } })])
        : el('td', {}, nos.flatMap((n, i) => [...(i ? [document.createTextNode(' + ')] : []), el('code', { textContent: n })])),
      el('td', { textContent: r.kind === 'prepare' ? wfTypeName(r.doc_type) : nos.map(n => wfTypeName(lqNoType(n))).join(' + ') }),
      el('td', {}, el('code', { textContent: r.project_code || '' })), el('td', { textContent: r.project_name || (r.grp === 'LR' ? t('lq.docName') : '') }),
      el('td', { textContent: pmDeptName(r.dept_code), title: r.dept_code || '' }),
      el('td', { className: 'num', textContent: r.total_value != null ? fmtMoney(r.total_value) : '' }),
      el('td', { textContent: when ? fmtDate(String(when).slice(0, 10)) : '' }),
      el('td', { textContent: r.role_code ? `${r.step} · ${wfRoleName(r.role_code)}` : '' })]);
    tr.onclick = () => { if (r.tf_id) aoOpenTransfer(r.tf_id); else if (r.doc_id) wfOpen(r.doc_id); };
    body.append(tr);
  }
  if (TB.on) tbInboxCards(rows);
}
// What the menu badge counts: things the person can do now.
// On a tablet the list leaves out the documents to draw up (no data entry there), so the count does too.
const wfInboxCount = rows => TB.on ? rows.filter(r => r.kind !== 'prepare').length : rows.length;

/* The number beside "To-do list" in the menu. */
async function wfBadge(n) {
  ntLoad();                            // the bell moves whenever the inbox does
  if (n == null) { try { await wfLookups(); } catch {}   // types name the package's owner documents
                   try { n = wfInboxCount([...(await SB.rpc('pm_inbox')), ...(await wfPrepTodos().catch(() => [])), ...(await lqTodos().catch(() => [])), ...(window.aoTodos ? await aoTodos().catch(() => []) : [])]); } catch { return; } }
  WF.badgeN = n;                       // buildNav() redraws the menu and re-adds it from here
  if (TB.on) { await lcCheck(); if (window.scCheck) await scCheck(); }          // the tablet bar offers the count while a batch waits for it
  tbBarRender();
  const a = $('#nav a[data-view="inbox"]');
  if (!a) return;
  a.querySelector('.tag')?.remove();
  if (n > 0) a.append(el('span', { className: 'tag', textContent: String(n) }));
}
let WF_TIMER = null;
function wfBadgeStart() {
  clearInterval(WF_TIMER);
  if (!can('approval', 'view') && !can('project', 'view')) return;
  wfBadge();
  WF_TIMER = setInterval(() => { if (ME && document.visibilityState === 'visible') wfBadge(); }, 60000);
}

/* ============================================================ SIGNATURE
   Phase 4. A hand-drawn signature: finger or Apple Pencil on the iPad, mouse on
   a PC. Pointer events cover all three; touch-action:none on the canvas stops
   the page from scrolling while someone signs. The drawing is cropped to the
   ink, scaled down and sent as a PNG, which the database copies into the step
   it signs — changing the saved signature later never alters a signed paper. */
const sigPng = s => s && typeof s === 'object' && /^data:image\/png;base64,/.test(s.png || '') ? s.png : null;
const sigImg = (s, cls) => sigPng(s) ? [el('img', { className: cls, src: sigPng(s), alt: '' })] : [];
const sigBox = s => sigPng(s) ? [el('img', { className: 'sigimg', src: sigPng(s), alt: '' })] : [el('i', {})];

const SIG = { ctx: null, drawing: false, ink: false, box: null, last: null, saved: null, resolve: null };

function sigSize() {
  const c = $('#sigPad'), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#10214a';
  SIG.ctx = ctx;
}
function sigClear() {
  const c = $('#sigPad');
  SIG.ctx.clearRect(0, 0, c.width, c.height);
  SIG.ink = false; SIG.box = null; SIG.fromSaved = false;
  msg('#sigMsg', '', '');
}
function sigPoint(ev) {
  const r = $('#sigPad').getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top,
           // A pen reports pressure; a finger or mouse reports 0 or 0.5.
           w: ev.pointerType === 'pen' && ev.pressure > 0 ? 1.2 + ev.pressure * 2.6 : 2.4 };
}
function sigGrow(p) {
  const b = SIG.box || { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  SIG.box = { x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) };
}
function sigDown(ev) {
  ev.preventDefault();
  if (SIG.fromSaved) sigClear();
  msg('#sigMsg', '', '');
  try { $('#sigPad').setPointerCapture(ev.pointerId); } catch {}   // a pointer that is already gone
  SIG.drawing = true;
  SIG.last = sigPoint(ev);
  const { x, y, w } = SIG.last;
  SIG.ctx.beginPath(); SIG.ctx.arc(x, y, w / 2, 0, Math.PI * 2); SIG.ctx.fillStyle = '#10214a'; SIG.ctx.fill();
  sigGrow(SIG.last);
}
function sigMove(ev) {
  if (!SIG.drawing) return;
  ev.preventDefault();
  // Coalesced events keep a fast Pencil stroke smooth instead of polygonal.
  for (const e of (ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev])) {
    const p = sigPoint(e), a = SIG.last;
    const mx = (a.x + p.x) / 2, my = (a.y + p.y) / 2;
    SIG.ctx.lineWidth = (a.w + p.w) / 2;
    SIG.ctx.beginPath(); SIG.ctx.moveTo(a.mx ?? a.x, a.my ?? a.y);
    SIG.ctx.quadraticCurveTo(a.x, a.y, mx, my); SIG.ctx.stroke();
    SIG.last = Object.assign(p, { mx, my });
    sigGrow(p);
    SIG.ink = true;
  }
}
function sigUp() { SIG.drawing = false; }

// Crop to the ink (plus a margin) and scale to at most 480 × 140 CSS px.
function sigExport() {
  const c = $('#sigPad'), dpr = window.devicePixelRatio || 1, pad = 8;
  const b = SIG.box;
  const x0 = Math.max(0, (b.x0 - pad) * dpr), y0 = Math.max(0, (b.y0 - pad) * dpr);
  const w = Math.min(c.width - x0, (b.x1 - b.x0 + pad * 2) * dpr), h = Math.min(c.height - y0, (b.y1 - b.y0 + pad * 2) * dpr);
  const k = Math.min(1, 480 / w, 140 / h);    // 140 px high is ~2.4× the printed box: sharp enough
  const out = el('canvas', { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) });
  out.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

async function sigLoadSaved() {
  SIG.saved = null;
  try {
    const [r] = await SB.select('pm_signature', `select=png&user_id=eq.${ME.id}`);
    SIG.saved = r && r.png || null;
  } catch {}                          // 20_pm_notify.sql not run yet: no saved signatures
  $('#sigUseSaved').hidden = !SIG.saved;
}

function sigUseSaved() {
  if (!SIG.saved) return;
  sigClear();
  const img = new Image();
  img.onload = () => {
    const c = $('#sigPad'), r = c.getBoundingClientRect();
    const k = Math.min(1, (r.width - 40) / img.width, (r.height - 60) / img.height);
    const w = img.width * k, h = img.height * k, x = (r.width - w) / 2, y = r.height - 50 - h;
    SIG.ctx.drawImage(img, x, y, w, h);
    SIG.fromSaved = true; SIG.ink = true;
  };
  img.src = SIG.saved;
}

/* Whether signing is compulsory: am_setting 'pm_require_signature' (the
   database checks the same key). Missing or unreadable = compulsory. */
async function sigRequired() {
  try {
    const [r] = await SB.select('am_setting', 'select=value&key=eq.pm_require_signature');
    return !(r && (r.value === false || r.value === 'false'));
  } catch { return true; }
}

/* Ask for a signature. Resolves with the PNG data URL, '' if the person chose
   to skip (only offered when signing is not compulsory), or null if cancelled. */
function sigAsk(title) {
  return new Promise(resolve => {
    SIG.resolve = resolve;
    $('#sigTitle').textContent = title;
    $('#sigSave').checked = false;
    $('#sigSkip').hidden = true;
    $('#sigModal').hidden = false;
    sigSize(); sigClear();
    sigLoadSaved();
    sigRequired().then(req => { $('#sigSkip').hidden = req; });
  });
}
function sigDone(png) {
  $('#sigModal').hidden = true;
  const r = SIG.resolve; SIG.resolve = null;
  if (r) r(png);
}
async function sigOk() {
  if (!SIG.ink) return msg('#sigMsg', 'err', t('sig.empty'));
  const png = SIG.fromSaved ? SIG.saved : sigExport();
  if (!SIG.fromSaved && $('#sigSave').checked) {
    try {
      await SB.call('pm_signature?on_conflict=user_id', { method: 'POST',
        headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ user_id: ME.id, png, updated_at: new Date().toISOString() }) });
    } catch (e) { return msg('#sigMsg', 'err', t('sig.saveFail') + ' ' + e.message); }
  }
  sigDone(png);
}

function initSig() {
  const c = $('#sigPad');
  c.addEventListener('pointerdown', sigDown);
  c.addEventListener('pointermove', sigMove);
  c.addEventListener('pointerup', sigUp);
  c.addEventListener('pointercancel', sigUp);
  $('#sigClear').onclick = sigClear;
  $('#sigUseSaved').onclick = sigUseSaved;
  $('#sigCancel').onclick = () => sigDone(null);
  $('#sigSkip').onclick = () => sigDone('');
  $('#sigOk').onclick = sigOk;
  // Rotating the iPad resizes the pad; the half-drawn signature would be
  // stretched, so start clean.
  window.addEventListener('resize', () => { if (!$('#sigModal').hidden) { sigSize(); sigClear(); } });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('#sigModal').hidden) sigDone(null); });
  $('#ppDrClose').onclick = ppDrawerClose;
  $('#pbDrClose').onclick = pbDrawerClose;
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && $('#sigModal').hidden && !(ev.target.closest && ev.target.closest('details[open]'))) { ppDrawerClose(); pbDrawerClose(); } });
}

/* ======================================================== NOTIFICATIONS
   Phase 4, in-app. pm_notice rows are written by a trigger on the document log
   (20_pm_notify.sql); the app only reads them and marks them read. The bell
   stays hidden until that table exists. Email comes later. */
const NT = { rows: [], unread: 0, ok: false };

async function ntLoad() {
  if (!ME || !(can('approval', 'view') || can('project', 'view'))) return;
  try {
    NT.rows = await SB.select('pm_notice', 'select=*&order=created_at.desc&limit=40');
    const un = await SB.select('pm_notice', 'select=id&read_at=is.null&limit=200');
    NT.unread = un.length; NT.ok = true;
  } catch { NT.ok = false; }
  ntRender();
}

function ntText(r) {
  if (r.doc_type === 'SC' && r.kind === 'todo') return t('ao.nt.inc', { no: r.doc_no || '', who: r.actor_email || '' });
  return t('nt.k.' + r.kind, { no: r.doc_no || '', type: r.doc_type ? wfTypeName(r.doc_type) : '', who: r.actor_email || '' });
}

function ntRender() {
  $('#bellWrap').hidden = !NT.ok;
  if (!NT.ok) return;
  $('#btnBell').title = t('nt.title');
  const n = $('#bellN');
  n.hidden = !NT.unread;
  n.textContent = NT.unread > 99 ? '99+' : String(NT.unread);
  document.title = document.title.replace(/^\(\d+\+?\) /, '');
  if (NT.unread) document.title = `(${NT.unread}) ` + document.title;
  const p = $('#bellPanel');
  if (p.hidden) return;
  p.innerHTML = '';
  const head = el('div', { className: 'bh' }, [el('b', { textContent: t('nt.title') })]);
  if (NT.unread) {
    const all = el('button', { className: 'btn tiny', textContent: t('nt.readAll') });
    all.onclick = ntReadAll;
    head.append(all);
  }
  p.append(head);
  if (!NT.rows.length) p.append(el('div', { className: 'empty', textContent: t('nt.none') }));
  for (const r of NT.rows) {
    const it = el('div', { className: `it k-${r.kind}` + (r.read_at ? '' : ' new') }, [
      el('span', { className: 'dot' }),
      el('div', {}, [document.createTextNode(ntText(r)),
        ...(r.comment ? [el('i', { textContent: '“' + r.comment + '”' })] : []),
        el('small', { textContent: `${r.project_code || ''} · ${fmtDateTime(r.created_at)}` })])]);
    it.onclick = () => ntOpen(r);
    p.append(it);
  }
}

async function ntOpen(r) {
  $('#bellPanel').hidden = true;
  if (!r.read_at) {
    try { await SB.patch('pm_notice', `id=eq.${r.id}`, { read_at: new Date().toISOString() }); } catch {}
  }
  // "Your turn to draw up the QC": to the project, whose panel has the button.
  if (r.kind === 'next' && r.project_code) { PM.prj.open = r.project_code; showView('projects'); }
  // Transfer slips and incidents (assetops.js) carry their number, not a document id.
  else if (r.doc_type === 'TF' && window.AO) { AO.tf.tab = 'all'; AO.tf.open = null; AO.tf.q = r.doc_no || ''; showView('transfer'); }
  else if (r.doc_type === 'SC' && window.AO) { AO.inc.tab = 'all'; AO.inc.open = null; AO.inc.q = r.doc_no || ''; showView('incident'); }
  else if (r.doc_id) wfOpen(r.doc_id);
  ntLoad();
}

async function ntReadAll() {
  try { await SB.patch('pm_notice', 'read_at=is.null', { read_at: new Date().toISOString() }); } catch {}
  ntLoad();
}

function initNotices() {
  $('#btnBell').onclick = ev => {
    ev.stopPropagation();
    const p = $('#bellPanel');
    p.hidden = !p.hidden;
    if (!p.hidden) { ntRender(); ntLoad(); }
  };
  document.addEventListener('click', ev => {
    if (!$('#bellPanel').hidden && !ev.target.closest('#bellWrap')) $('#bellPanel').hidden = true;
  });
}

/* ------------------------------------------------------ chain editor */
/* The chains as a workflow diagram (user 25/09/2026), one per package of the
   chosen entity: the preparer, each step in order coloured by who acts (blue
   hotel, purple AM team, yellow JVC), the approved end and the package it
   leads to — and under each step what happens when it says no: returned to
   the preparer, or (JVC, once the AM team has checked) the PA / MC alone back
   to the AM team; a rejection stops the package. Read-only: anyone who can
   open Approval chains sees it; changing a chain stays in the list view. */
// Every document type with a chain, in the order of the procedure: the eight, the label receipt (AL), the liquidation request (LR).
const wfChainTypes = () => [...new Set([...WF_ORDER, ...WF.types.slice().sort((a, b) => a.seq - b.seq).map(x => x.code)])]
  .filter(ty => WF.types.some(x => x.code === ty)).sort((a, b) => wfSeq(a) - wfSeq(b));
function wfChainFlow() {
  const box = el('div', { className: 'wflow' });
  const ent = WF.entity;
  const leads = wfChainTypes().filter(ty => { const g = wfGrp(ty); return !g || ty === wfLead(g); });
  for (const lead of leads) {
    const grp = wfGrp(lead) || lead;
    const types = wfPkgTypes(grp);
    const rows = wfChain(ent, lead);
    const prep = rows.find(c => c.step === 0);
    const steps = rows.filter(c => c.step > 0);
    if (!prep && !steps.length) continue;
    const ownerTypes = types.filter(ty => wfSide(ty) === 'owner');
    const ownerRoles = ownerTypes.map(ty => (wfChain(ent, ty).find(c => c.step === 0) || {}).role_code);
    const opIdx = steps.findIndex(s => ownerRoles.includes(s.role_code));
    const top = Math.max(...types.map(wfSeq));
    const next = (WF.types.filter(x => x.required && x.side === 'operator' && x.seq > top && (!x.grp || x.code === wfLead(x.grp)))
      .sort((a, b) => a.seq - b.seq)[0] || {}).code;
    const node = (cls, head, name, tag, outs) => el('div', { className: 'fnode ' + cls }, [
      el('small', { textContent: head }), el('b', { textContent: name }), tag || '',
      ...(outs || []).map(([c, txt]) => el('div', { className: 'fout ' + c, textContent: txt }))]);
    const flow = el('div', { className: 'fline' });
    flow.append(node('band-op', t('wf.f.prepares'), prep ? wfRoleName(prep.role_code) : '—', null,
      [['note', types.filter(ty => wfSide(ty) !== 'owner').join(' + ')]]));
    steps.forEach((s, i) => {
      const kind = s.kind === 'check' ? 'check' : 'approve';
      const isOp = i === opIdx;
      const outs = [['back', '↩ ' + t('wf.f.backPrep')]];
      if (opIdx >= 0 && i > opIdx && kind === 'approve') outs.push(['back', '↩ ' + t('wf.f.backAm', { t: ownerTypes.join('/') })]);
      if (kind === 'approve') outs.push(['stop', '✕ ' + t('wf.f.reject')]);
      if (isOp) outs.unshift(['note', '✎ ' + t('wf.f.drawsUp', { t: ownerTypes.join(' + ') })]);
      flow.append(el('span', { className: 'farrow', textContent: '→' }),
        node('band-' + wfBand(s.role_code), `${t('wf.f.step')} ${s.step}`, wfRoleName(s.role_code), wfKindTag(kind, isOp), outs));
    });
    flow.append(el('span', { className: 'farrow', textContent: '→' }),
      node('band-ok', t('wf.f.done'), '✓ ' + t('wf.st.approved'), null, next ? [['note', t('wf.f.next', { t: next })]] : []));
    box.append(el('div', { className: 'fcard' }, [
      el('h3', {}, [el('b', { textContent: types.join(' + ') }), document.createTextNode(' — ' + types.map(wfTypeName).join(' + '))]),
      el('div', { className: 'fscroll2' }, flow)]));
  }
  box.append(el('div', { className: 'flegend' }, [
    el('span', { className: 'fk band-op', textContent: t('wf.f.lgOp') }), el('span', { className: 'fk band-am', textContent: t('wf.f.lgAm') }),
    el('span', { className: 'fk band-jvc', textContent: t('wf.f.lgJvc') }), el('span', { className: 'fk band-ok', textContent: t('wf.f.lgOk') }),
    el('span', { className: 'fout back', textContent: '↩ ' + t('wf.f.lgBack') }), el('span', { className: 'fout stop', textContent: '✕ ' + t('wf.f.lgStop') })]));
  return box;
}
async function wfChainsLoad() {
  const out = $('#wcMsg');
  msg(out, 'info', t('table.loading'));
  try { await wfLookups(true); msg(out, '', ''); wfChainsRender(); }
  catch (e) { msg(out, 'err', e.message); }
}

function wfChainsRender() {
  const tabs = $('#wcTabs');
  tabs.innerHTML = '';
  for (const e of PM_ENTITIES) {
    const b = el('button', { textContent: `${e} — ${t('perms.ent.' + e)}` });
    b.classList.toggle('on', WF.entity === e);
    b.onclick = () => { WF.entity = e; wfChainsRender(); };
    tabs.append(b);
  }
  // List (editable) or workflow diagram (user 25/09/2026).
  const vs = $('#wcView');
  vs.innerHTML = '';
  for (const [v, k] of [['list', 'wf.f.list'], ['flow', 'wf.f.flow']]) {
    const b = el('button', { textContent: t(k) });
    b.classList.toggle('on', (WF.chainView || 'list') === v);
    b.onclick = () => { WF.chainView = v; wfChainsRender(); };
    vs.append(b);
  }
  const flowBox = $('#wcFlow');
  flowBox.innerHTML = '';
  $('#wcTableWrap').hidden = WF.chainView === 'flow';
  if (WF.chainView === 'flow') { flowBox.append(wfChainFlow()); return; }
  const admin = can('approval', 'admin');
  const head = $('#wcGrid thead'), body = $('#wcGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, [el('th', { textContent: t('wf.c.doc') }), el('th', { textContent: t('wf.c.prep') }), el('th', { textContent: t('wf.c.steps') }), el('th')]));
  const roleSel = (val) => { const s = el('select'); s.append(el('option', { value: '', textContent: '—' }));
    for (const r of WF.roles) s.append(el('option', { value: r.code, textContent: LANG === 'vi' ? r.name_vi : r.name_en })); s.value = val || ''; return s; };
  for (const type of wfChainTypes()) {
    const rows = wfChain(WF.entity, type);
    const prep = rows.find(c => c.step === 0);
    const grp = wfGrp(type), follows = grp && type !== wfLead(grp);   // RR, PA, MC travel on the PR / QC chain
    const steps = rows.filter(c => c.step > 0).map(c => ({ r: c.role_code, k: c.kind === 'check' ? 'check' : 'approve' }));
    // The AM Coordinator's step of a PR / QC chain also draws up the PA / MC.
    const ownerRoles = grp && !follows ? wfPkgTypes(grp).filter(ty => wfSide(ty) === 'owner')
      .map(ty => (wfChain(WF.entity, ty).find(c => c.step === 0) || {}).role_code) : [];
    // What a newly added step does by default: the AM team checks, everyone else approves.
    const kindFor = r => ['AM_COORD', 'AM_EXEC'].includes(r) ? 'check' : 'approve';
    const kinds = ['approve', 'check'];
    const tr = el('tr');
    tr.append(el('td', {}, [el('b', { textContent: type }), document.createTextNode(' ' + wfTypeName(type))]));
    const prepCell = el('td');
    let prepSel = null;
    if (admin) { prepSel = roleSel(prep && prep.role_code); prepCell.append(prepSel); } else prepCell.textContent = prep ? wfRoleName(prep.role_code) : '—';
    tr.append(prepCell);
    const chips = el('div', { className: 'roles' });
    const draw = () => {
      chips.innerHTML = '';
      if (follows) { chips.append(el('span', { className: 'wcfollow', textContent: t('wf.c.follows', { t: wfLead(grp) }) })); return; }
      steps.forEach((st, i) => {
        const c = el('span', { className: 'role' }, [el('b', { textContent: `${i + 1}. ` }), document.createTextNode(wfRoleName(st.r))]);
        const tag = wfKindTag(st.k, st.k === 'check' && ownerRoles.includes(st.r));
        if (admin) {                      // click the tag: approves ↔ checks
          tag.classList.add('kt-btn');
          tag.title = t('wf.c.kindHint');
          tag.onclick = () => { st.k = kinds[(kinds.indexOf(st.k) + 1) % kinds.length]; draw(); };
        }
        c.append(tag);
        if (admin) {
          if (i > 0) { const l = el('button', { className: 'x', textContent: '←' }); l.onclick = () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; draw(); }; c.append(l); }
          const x = el('button', { className: 'x', textContent: '×' }); x.onclick = () => { steps.splice(i, 1); draw(); }; c.append(x);
        }
        chips.append(c);
      });
      if (admin) { const add = roleSel(''); add.onchange = () => { if (add.value) { steps.push({ r: add.value, k: kindFor(add.value) }); draw(); } }; chips.append(add); }
    };
    draw();
    tr.append(el('td', {}, chips));
    const act = el('td');
    if (admin) { const save = el('button', { className: 'btn tiny pri', textContent: t('tool.save') });
      save.onclick = () => wfChainSave(type, prepSel.value, steps, follows); act.append(save); }
    tr.append(act);
    body.append(tr);
  }
}

/* Upsert the new steps first, then drop the ones past the end — a failure in
   between leaves a chain with extra steps, never a chain with none. */
async function wfChainSave(type, prep, steps, prepOnly) {
  if (!prep) return msg('#wcMsg', 'err', t('wf.c.needPrep'));
  // RR / PA / MC: only who draws them up — their steps are the PR / QC chain's.
  if (prepOnly) {
    try {
      await SB.call('pm_chain?on_conflict=entity,doc_type,step', { method: 'POST',
        headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ entity: WF.entity, doc_type: type, step: 0, role_code: prep, kind: 'approve' }]) });
      await wfLookups(true); wfChainsRender();
      msg('#wcMsg', 'ok', t('wf.c.saved', { e: WF.entity, type }));
    } catch (e) { msg('#wcMsg', 'err', e.message); }
    return;
  }
  if (!steps.length) return msg('#wcMsg', 'err', t('wf.c.needStep'));
  // A chain must end with someone who approves, not only checks.
  if (!steps.some(s => s.k !== 'check')) return msg('#wcMsg', 'err', t('wf.c.needApprover'));
  const rows = [{ entity: WF.entity, doc_type: type, step: 0, role_code: prep, kind: 'approve' },
                ...steps.map((s, i) => ({ entity: WF.entity, doc_type: type, step: i + 1, role_code: s.r, kind: s.k }))];
  try {
    await SB.call('pm_chain?on_conflict=entity,doc_type,step', { method: 'POST',
      headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(rows) });
    await SB.remove('pm_chain', `entity=eq.${WF.entity}&doc_type=eq.${type}&step=gt.${steps.length}`);
    await wfLookups(true);
    wfChainsRender();
    msg('#wcMsg', 'ok', t('wf.c.saved', { e: WF.entity, type }));
  } catch (e) { msg('#wcMsg', 'err', e.message); }
}

function initWf() {
  // Leaving a form with unsaved edits asks first.
  window.addEventListener('beforeunload', ev => { if (VIEW === 'doc' && WF.dirty && wfEditable()) { ev.preventDefault(); ev.returnValue = ''; } });
  // To-do list filters.
  $('#wiQ').oninput = wfInboxRender;
  $('#wiShow').onchange = wfInboxRender;
  $('#wiType').onchange = wfInboxRender;
}

/* ============================================================ SETTINGS
   One place for what is set once and left (user 25/09/2026): this person's
   help switch, and each budget year's FX rate, reserve and caps — what every
   other number of the year leans on, so only the budget admin changes them. */
const ST = { year: null };
async function stLoad() {
  applyHelp();
  stDocLoad();
  const card = $('#stYearCard'), box = $('#stYearBox'), out = $('#stMsg');
  card.hidden = !can('budget', 'view');
  if (card.hidden) return;
  box.innerHTML = '';
  try {
    const [years, rounds] = await Promise.all([
      SB.select('pm_budget_year', 'select=*&order=year.desc'),
      SB.select('pm_budget_round', 'select=year')]);
    const ys = [...new Set([...years.map(y => y.year), ...rounds.map(r => r.year), new Date().getFullYear()])].sort((a, b) => b - a);
    const sel = el('select', { style: 'width:110px' });
    for (const y of ys) sel.append(el('option', { value: y, textContent: y }));
    sel.value = ys.includes(ST.year) ? ST.year : ys.includes(PM.bud.year) ? PM.bud.year : ys[0];
    const admin = can('budget', 'admin');
    const row = el('div', { className: 'pmyear' });
    const draw = () => {
      ST.year = +sel.value;
      const y = years.find(r => r.year === ST.year) || {};
      const inp = (key, lbl, val, w) => {
        const i = el('input', { value: val ?? '', disabled: !admin, style: `width:${w || 140}px`, inputMode: 'decimal' });
        i.dataset.k = key;
        return el('div', { className: 'fld' }, [el('label', { textContent: t(lbl) }), i]);
      };
      row.innerHTML = '';
      row.append(el('div', { className: 'fld' }, [el('label', { textContent: t('pm.f.year') }), sel]),
        inp('fx_rate', 'pm.bud.fx', y.fx_rate ?? 26000, 110),
        inp('reserve_pct', 'pm.bud.reserve', y.reserve_pct ?? 3, 80),
        inp('ssp_revenue', 'pm.bud.sspRev', y.ssp_revenue != null ? fmtNum(y.ssp_revenue) : '', 170),
        inp('ssp_cap', 'pm.bud.sspCap', y.ssp_cap != null ? fmtNum(y.ssp_cap) : '', 170),
        inp('cp_revenue', 'pm.bud.cpRev', y.cp_revenue != null ? fmtNum(y.cp_revenue) : '', 170));
      if (admin) {
        const save = el('button', { className: 'btn pri', textContent: t('tool.save') });
        save.onclick = () => stSaveYear(ST.year, row);
        row.append(el('div', { className: 'acts' }, save));
      }
    };
    sel.onchange = draw;
    draw();
    box.append(row);
    if (!admin) box.append(el('div', { className: 'sd', style: 'margin-top:8px;color:var(--dim);font-size:12px', textContent: t('st.adminOnly') }));
  } catch (e) { msg(out, 'err', e.message); }
}
// Document screen switches, for whoever may edit System settings: the history under each form.
async function stDocLoad() {
  const card = $('#stDocCard');
  card.hidden = !can('system', 'edit');
  if (card.hidden) return;
  const cb = $('#stHist');
  try { const [r] = await SB.select('am_setting', 'select=value&key=eq.pm_show_history'); cb.checked = !r || !(r.value === false || r.value === 'false'); } catch {}
  cb.onchange = async () => {
    try {
      await SB.call('am_setting?on_conflict=key', { method: 'POST', headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify([{ key: 'pm_show_history', value: cb.checked, note: 'true = the document screen shows the package history under the form.' }]) });
      msg('#stDocMsg', 'ok', t('st.saved'));
    } catch (e) { msg('#stDocMsg', 'err', e.message); }
  };
}
async function stSaveYear(year, row) {
  const patch = { year };
  for (const i of row.querySelectorAll('input[data-k]')) patch[i.dataset.k] = numIn(i.value);
  if (!(patch.fx_rate > 0)) return msg('#stMsg', 'err', t('pm.bud.fxNeeded'));
  try {
    await SB.call('pm_budget_year?on_conflict=year', { method: 'POST',
      headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([patch]) });
    MONEY.fx.set(Number(year), Number(patch.fx_rate));   // the USD view follows the new rate at once
    await stLoad();
    msg('#stMsg', 'ok', t('pm.bud.yearSaved', { y: year }));
  } catch (e) { msg('#stMsg', 'err', e.message); }
}

/* =========================================================== ADMIN TOOLS
   For the testing phase (22_admin_tools.sql). Permission area "override":
     view  = this screen
     edit  = edit ANY content — a document in any state, every project field,
             every budget line field — each change kept in the history
     admin = reset (delete) test data, group by group
   System Admin has all three; a user given the "Content editor" role has
   view + edit. The database checks each call; the screen only hides what
   someone cannot do. */
const AD_GROUPS = ['docs', 'payments', 'projects', 'budget', 'vendors', 'notices', 'signatures', 'assets', 'audit'];
const AD = { sel: new Set(), counts: null };
const canOverride = () => can('override', 'edit');

/* The groups as a table with a tick per row (user 25/09/2026); "Count rows first"
   fills the last column. */
function adLoad() {
  const box = $('#adGroups');
  box.innerHTML = '';
  $('#adResetCard').hidden = !can('override', 'admin');
  const tb = el('table', { className: 'adtbl adpick' });
  const all = el('input', { type: 'checkbox', checked: AD.sel.size === AD_GROUPS.length, title: t('ad.all') });
  all.onchange = () => { AD_GROUPS.forEach(g => all.checked ? AD.sel.add(g) : AD.sel.delete(g)); AD.counts = null; $('#adOut').innerHTML = ''; adLoad(); };
  tb.append(el('tr', {}, [el('th', { className: 'tick' }, all), el('th', { textContent: t('ad.col.group') }),
    el('th', { textContent: t('ad.col.what') }), el('th', { className: 'num', textContent: t('ad.col.rows') })]));
  for (const g of AD_GROUPS) {
    const cb = el('input', { type: 'checkbox', checked: AD.sel.has(g) });
    cb.onchange = () => { if (cb.checked) AD.sel.add(g); else AD.sel.delete(g); AD.counts = null; $('#adOut').innerHTML = ''; adLoad(); };
    const n = AD.counts && AD.counts.has(g) ? fmtInt(AD.counts.get(g)) : '';
    const tr = el('tr', { className: AD.sel.has(g) ? 'on' : '' }, [el('td', { className: 'tick' }, cb),
      el('td', {}, el('b', { textContent: t('ad.g.' + g) })), el('td', { className: 'dim', textContent: t('ad.gd.' + g) }),
      el('td', { className: 'num', textContent: n })]);
    tr.onclick = ev => { if (ev.target !== cb) { cb.checked = !cb.checked; cb.onchange(); } };
    tb.append(tr);
  }
  box.append(el('div', { className: 'wrap' }, tb));
  adSync();
  adSettings();
  wfLookups().catch(() => {}).then(adEditors);   // role names come with the lookups
}

// The reset button needs groups ticked and the word typed.
function adSync() {
  $('#btnAdReset').disabled = !AD.sel.size || $('#adConfirm').value.trim().toUpperCase() !== 'RESET';
}

const adGroups = () => AD_GROUPS.filter(g => AD.sel.has(g));
function adTable(rows) {
  const tb = el('table', { className: 'adtbl' });
  tb.append(el('tr', {}, [el('th', { textContent: t('ad.col.group') }), el('th', { textContent: t('ad.col.table') }),
                          el('th', { className: 'num', textContent: t('ad.col.rows') })]));
  for (const r of rows) tb.append(el('tr', {}, [el('td', { textContent: t('ad.g.' + r.grp) }), el('td', {}, el('code', { textContent: r.tbl })),
                                                el('td', { className: 'num', textContent: fmtInt(Number(r.n)) })]));
  return el('div', { className: 'wrap', style: 'margin-top:10px' }, tb);
}

async function adCount() {
  const out = $('#adOut');
  if (!AD.sel.size) return msg(out, 'err', t('ad.pick'));
  try {
    const rows = await SB.rpc('app_reset_data', { p_groups: adGroups(), p_dry: true });
    AD.counts = new Map();
    for (const r of rows) AD.counts.set(r.grp, (AD.counts.get(r.grp) || 0) + Number(r.n));
    adLoad();
    msg(out, 'info', t('ad.counted'));
    out.append(adTable(rows));
  } catch (e) { msg(out, 'err', e.message); }
}

async function adReset() {
  const out = $('#adOut');
  const gs = adGroups();
  if (!gs.length || $('#adConfirm').value.trim().toUpperCase() !== 'RESET') return;
  if (!confirm(t('ad.confirm', { list: gs.map(g => t('ad.g.' + g)).join(', ') }))) return;
  $('#btnAdReset').disabled = true;
  try {
    const rows = await SB.rpc('app_reset_data', { p_groups: gs, p_dry: false });
    $('#adConfirm').value = '';
    AD.sel.clear();
    // Cached lists of the project screens would show what is gone.
    WF.types = []; PAY.inv = []; PAY.pay = [];
    adLoad();
    msg(out, 'ok', t('ad.done'));
    out.append(adTable(rows));
    wfBadge();
  } catch (e) { msg(out, 'err', e.message); adSync(); }
}

/* Thresholds (am_setting), moved here from the System menu (user 25/09/2026):
   one small table, the value editable by whoever may edit System settings. */
const adValText = v => v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
const adValParse = s => { s = s.trim(); if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s); return s; };
async function adSettings() {
  const card = $('#adSetCard'), box = $('#adSetBox');
  card.hidden = !can('system', 'view');
  if (card.hidden) return;
  box.innerHTML = '';
  const edit = can('system', 'edit');
  try {
    const rows = await SB.select('am_setting', 'select=key,value,note&order=key');
    const tb = el('table', { className: 'adtbl' });
    tb.append(el('tr', {}, [el('th', { textContent: t('ad.set.key') }), el('th', { textContent: t('ad.set.value') }), el('th', { textContent: t('ad.set.note') })]));
    for (const r of rows) {
      const i = el('input', { value: adValText(r.value), disabled: !edit, style: 'width:180px' });
      i.dataset.key = r.key; i.dataset.was = adValText(r.value);
      tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: r.key })), el('td', {}, i), el('td', { className: 'dim', textContent: r.note || '' })]));
    }
    box.append(el('div', { className: 'wrap' }, tb));
    if (!edit) return;
    const save = el('button', { className: 'btn pri', style: 'margin-top:10px', textContent: t('tool.save') });
    save.onclick = async () => {
      try {
        const changed = [...tb.querySelectorAll('input')].filter(i => i.value.trim() !== i.dataset.was);
        for (const i of changed) await SB.patch('am_setting', `key=eq.${encodeURIComponent(i.dataset.key)}`, { value: adValParse(i.value), updated_at: new Date().toISOString() });
        await adSettings();
        msg('#adSetMsg', 'ok', t('ad.set.saved', { n: changed.length }));
      } catch (e) { msg('#adSetMsg', 'err', e.message); }
    };
    box.append(save);
  } catch (e) { msg('#adSetMsg', 'err', e.message); }
}

// Who may edit any content now: System Admins and Content editors.
async function adEditors() {
  const box = $('#adEditors');
  box.innerHTML = '';
  try {
    const rows = await SB.select('app_user_role', 'select=role_code,app_user(email,full_name,active)&role_code=in.(SYS_ADMIN,CONTENT_EDITOR)');
    const list = rows.filter(r => r.app_user && r.app_user.active);
    if (!list.length) return;
    box.append(el('h3', { className: 'adh3', textContent: t('ad.editors') }),
      el('div', { className: 'adlist' }, list.map(r => el('span', { className: 'st in_progress',
        textContent: `${r.app_user.full_name || r.app_user.email} · ${wfRoleName(r.role_code)}` }))));
  } catch {}
}


/* ---------------------------------------------- capture every screen
   Admin tools → "Capture the whole app": opens every screen this person may
   see — menu items, their sub-items, the Payments tabs, each entity's approval
   chains, a project's side panel and a document — and captures each one full
   length (the tall tables unrolled, not cut at the window), then hands back
   ONE PDF (a page per screen, bookmarked) and / or ONE ZIP of PNGs.
   The Connection screen is left out: it holds the project's address and key. */
const SNAP_LIBS = {
  html2canvas: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
  jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  JSZip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
};
const snapLib = name => window[name] ? Promise.resolve() : new Promise((ok, bad) => {
  const s = el('script', { src: SNAP_LIBS[name] });
  s.onload = ok; s.onerror = () => bad(new Error(name));
  document.head.append(s);
});

// Every screen to capture, in menu order, with the extra states worth a page of their own.
async function snapTargets() {
  const out = [];
  const add = (view, label, o = {}) => out.push(Object.assign({ view, label }, o));
  for (const [, items] of NAV)
    for (const [id, key, ch] of items)
      for (const [v] of [[id, key], ...(ch || [])]) {
        if (!v || v === 'setup' || !canView(v)) continue;
        if (v === 'payments') {
          for (const tab of PAY_TABS) add(v, `${viewTitle(v)} — ${t('pay.tab.' + tab)}`,
            { after: () => { PAY.tab = tab; PAY.sel.clear(); payRender(); } });
        } else if (v === 'chains') {
          for (const e of PM_ENTITIES) add(v, `${viewTitle(v)} — ${e}`, { after: () => { WF.entity = e; wfChainsRender(); } });
        } else add(v, viewTitle(v));
        if (v === 'projects') add(v, `${viewTitle(v)} — ${t('snap.panel')}`, {
          after: async () => { const r = PM.prj.rows && PM.prj.rows[0]; if (r) { PM.prj.pick = r.code; ppRenderBody(); await ppDetail(r); } },
          el: '#ppDrawer', skip: () => $('#ppDrawer').hidden });
      }
  // One document, drawn as its form, if there is any.
  if (canView('doc')) {
    try {
      const [d] = await SB.select('pm_doc', 'select=id,doc_no&status=neq.cancelled&order=id.desc&limit=1');
      if (d) add('doc', `${t('page.doc')} — ${d.doc_no}`, { before: () => { WF.openId = d.id; } });
    } catch {}
  }
  return out;
}

// Wait until the screen has finished loading: no request in flight for a moment.
let SNAP_INFLIGHT = 0;
async function snapIdle() {
  await new Promise(r => setTimeout(r, 350));
  const t0 = Date.now();
  let quietSince = Date.now();
  while (Date.now() - t0 < 15000) {
    if (SNAP_INFLIGHT > 0) quietSince = Date.now();
    if (Date.now() - quietSince > 500) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 300));          // charts draw after their data
}

async function snapShot(target) {
  const node = target.el ? $(target.el) : $('.content');
  const w = Math.max(node.scrollWidth, node.clientWidth);
  const h = Math.min(Math.max(node.scrollHeight, node.clientHeight), 16000);   // a register of thousands of rows is cut here
  const scale = Math.min(1.5, Math.sqrt(40e6 / (w * h)));                       // stays inside the browser's canvas limit
  return html2canvas(node, { scale, width: w, height: h, windowWidth: document.documentElement.scrollWidth,
    backgroundColor: getComputedStyle(document.body).backgroundColor, logging: false, useCORS: true });
}

async function adSnap() {
  const wantPdf = $('#snapPdf').checked, wantZip = $('#snapZip').checked;
  const out = $('#snapOut');
  if (!wantPdf && !wantZip) return msg(out, 'err', t('snap.pickFormat'));
  const back = VIEW;
  const btn = $('#btnSnap'), stop = $('#btnSnapStop');
  btn.disabled = true; stop.hidden = false; AD.snapStop = false;
  const realFetch = window.fetch;
  window.fetch = (...a) => { SNAP_INFLIGHT++; return realFetch(...a).finally(() => { SNAP_INFLIGHT--; }); };
  document.body.classList.add('snap');
  const shots = [];
  try {
    msg(out, 'info', t('snap.loading'));
    await Promise.all(['html2canvas', ...(wantPdf ? ['jspdf'] : []), ...(wantZip ? ['JSZip'] : [])].map(snapLib));
    const targets = await snapTargets();
    for (let i = 0; i < targets.length && !AD.snapStop; i++) {
      const tg = targets[i];
      msg(out, 'info', t('snap.progress', { i: i + 1, n: targets.length, name: tg.label }));
      if (tg.before) tg.before();
      if (VIEW !== tg.view || tg.before) showView(tg.view);
      await snapIdle();
      if (tg.after) { await tg.after(); await snapIdle(); }
      if (tg.skip && tg.skip()) continue;
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
      shots.push({ label: tg.label, canvas: await snapShot(tg) });
      if (tg.el === '#ppDrawer') ppDrawerClose();
    }
    if (!shots.length) throw new Error(t('snap.none'));
    msg(out, 'info', t('snap.building', { n: shots.length }));
    const d0 = new Date(), p2 = n => String(n).padStart(2, '0');       // local time in the file name
    const stamp = `${d0.getFullYear()}${p2(d0.getMonth() + 1)}${p2(d0.getDate())}-${p2(d0.getHours())}${p2(d0.getMinutes())}`;
    const base = `PHCL app ${LANG.toUpperCase()} ${stamp}`;
    if (wantPdf) snapPdf(shots).save(base + '.pdf');
    if (wantZip) {
      const zip = new JSZip();
      shots.forEach((s, i) => zip.file(`${String(i + 1).padStart(2, '0')} - ${s.label.replace(/[\\/:*?"<>|]/g, ' ').trim()}.png`,
        s.canvas.toDataURL('image/png').split(',')[1], { base64: true }));
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = el('a', { href: URL.createObjectURL(blob), download: base + '.zip' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    msg(out, AD.snapStop ? 'warn' : 'ok', t(AD.snapStop ? 'snap.stopped' : 'snap.done', { n: shots.length }));
  } catch (e) {
    msg(out, 'err', t('snap.fail', { err: e.message }));
  } finally {
    window.fetch = realFetch;
    document.body.classList.remove('snap');
    btn.disabled = false; stop.hidden = true;
    if (VIEW !== back) showView(back);
  }
}

// One page per screen at a fixed width; a very tall screen continues on the next page(s).
function snapPdf(shots) {
  const { jsPDF } = window.jspdf;
  const W = 1000, MAX_H = 14000;                        // points; PDF pages top out near 14,400
  let doc = null;
  for (const s of shots) {
    const c = s.canvas, k = W / c.width, sliceH = Math.floor(MAX_H / k);
    for (let y = 0, part = 0; y < c.height; y += sliceH, part++) {
      const hPx = Math.min(sliceH, c.height - y);
      const piece = document.createElement('canvas');
      piece.width = c.width; piece.height = hPx;
      piece.getContext('2d').drawImage(c, 0, y, c.width, hPx, 0, 0, c.width, hPx);
      const size = [W, hPx * k], orient = size[0] > size[1] ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ unit: 'pt', format: size, orientation: orient, compress: true });
      else doc.addPage(size, orient);
      doc.addImage(piece.toDataURL('image/jpeg', 0.86), 'JPEG', 0, 0, size[0], size[1]);
      if (part === 0) try { doc.outline.add(null, s.label, { pageNumber: doc.getNumberOfPages() }); } catch {}
    }
  }
  return doc;
}
function initAdmin() {
  $('#btnAdCount').onclick = adCount;
  $('#btnAdReset').onclick = adReset;
  $('#adConfirm').oninput = adSync;
  $('#btnAdBackup').onclick = () => showView('backup');
  $('#btnAdUsers').onclick = () => showView('users');
  $('#btnAdPerms').onclick = () => showView('perms');
  $('#btnSnap').onclick = adSnap;
  $('#btnSnapStop').onclick = () => { AD.snapStop = true; };
}

/* ============================================================== PAYMENTS
   Phase 5. The accounting office exports two year-to-date workbooks each month:
   the purchase-invoice register (pre-tax value + VAT) and the bank payments
   (gross). They are read here and sent whole to pm_import_pay, which upserts,
   finds the project codes in "Diễn giải" and allocates what it can. What it
   cannot — two codes on one line, a truncated code, a main code with several
   sub-projects — waits in "To allocate" for a person to split.

   Money rules: budget consumption = invoiced PRE-TAX; cash = paid GROSS; VAT is
   always its own figure. */

const PAY = { tab: 'project', cf: {}, sort: {}, sel: new Map(), parsed: [], inv: [], pay: [], alloc: [], money: [], projects: [], budget: new Map(),
              imports: [], pick: null };
// By project first, To allocate last (user 25/09/2026).
const PAY_TABS = ['project', 'invoice', 'payment', 'queue'];

/* Column headers, normalised with hnorm(). The files find columns by NAME, so a
   re-ordered export still reads. */
const PAY_INV_COLS = {
  sochungtu: 'voucher_no', ngaychungtu: 'voucher_date', sohoadon: 'invoice_no', ngayhoadon: 'invoice_date',
  tennguoiban: 'seller_name', masothuenguoiban: 'seller_tax', giatrihhdvmuavaochuacothue: 'net',
  thuegtgt: 'vat', kyhieuhd: 'series', ngayhachtoan: 'post_date', diengiai: 'description', thuesuat: 'vat_rate'
};
const PAY_PAY_COLS = {
  stt: 'stt', ngayhachtoan: 'post_date', ngaychungtu: 'voucher_date', sochungtu: 'voucher_no',
  diengiai: 'description', sotien: 'amount', madoituong: 'vendor_code', doituong: 'vendor_name',
  sotaikhoannh: 'bank_account', lydothuchi: 'reason', loaichungtu: 'voucher_type'
};
// Same pattern as pm_codes_in() in 21_pm_payment.sql.
const PAY_CODE_RE = /(?:^|[^A-Z0-9.])([A-Z]{2,}(?:\.[A-Z0-9]+)*\.(?:19|20)\d{2}(?:\.\d{1,2})?)(?!\d)/g;
const payCodes = s => [...new Set([...String(s || '').toUpperCase().matchAll(PAY_CODE_RE)].map(m => m[1]))].sort();
const payDmy = s => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };
const payStr = v => v == null ? '' : String(v).normalize('NFC').trim();
const fmtVnd = v => fmtMoney(v);             // follows the VND | USD switch

/* One workbook → { kind, rows, period, fileTotal } or throws. */
function payParseBook(wb, fileName) {
  for (const sn of wb.SheetNames) {
    const g = pmRows(wb.Sheets[sn]);
    for (let h = 0; h < Math.min(g.length, 15); h++) {
      const heads = (g[h] || []).map(hnorm);
      const kind = heads.includes('sohoadon') && heads.includes('masothuenguoiban') ? 'invoice'
                 : heads.includes('madoituong') && heads.includes('sotien') ? 'payment' : null;
      if (!kind) continue;
      const map = kind === 'invoice' ? PAY_INV_COLS : PAY_PAY_COLS;
      const col = {};
      heads.forEach((hd, i) => { if (map[hd] && col[map[hd]] == null) col[map[hd]] = i; });
      const get = (r, k) => col[k] == null ? null : r[col[k]];
      let period = null;
      for (let i = 0; i < h; i++) {
        const txt = (g[i] || []).map(payStr).join(' ');
        const m = /(\d{1,2}\/\d{1,2}\/\d{4}).*?(\d{1,2}\/\d{1,2}\/\d{4})/.exec(txt);
        if (m) { period = [payDmy(m[1]), payDmy(m[2])]; break; }
      }
      const rows = [], seen = new Map();
      let fileTotal = null;
      for (const r of g.slice(h + 1)) {
        if (!r) continue;
        const first = hnorm(r.find(v => v != null && v !== '') || '');
        if (kind === 'invoice') {
          const no = payStr(get(r, 'invoice_no'));
          // The group heading ("Nhóm HHDV…") and "Tổng cộng" carry no invoice number.
          if (!no) { if (/^tongcong/.test(first)) fileTotal = [xlNum(get(r, 'net')), xlNum(get(r, 'vat'))]; continue; }
          rows.push({
            voucher_no: payStr(get(r, 'voucher_no')), voucher_date: xlDate(get(r, 'voucher_date')),
            invoice_no: no, invoice_date: xlDate(get(r, 'invoice_date')), seller_name: payStr(get(r, 'seller_name')),
            seller_tax: payStr(get(r, 'seller_tax')), net: xlNum(get(r, 'net')) || 0, vat: xlNum(get(r, 'vat')) || 0,
            series: payStr(get(r, 'series')), post_date: xlDate(get(r, 'post_date')),
            description: payStr(get(r, 'description')), vat_rate: payStr(get(r, 'vat_rate'))
          });
        } else {
          const vno = payStr(get(r, 'voucher_no')), post = xlDate(get(r, 'post_date'));
          // The total line reads "Tổng … Cộng" with no posting date.
          if (!vno || !post) { if (/tong/.test(first)) fileTotal = [xlNum(get(r, 'amount'))]; continue; }
          const n = (seen.get(vno) || 0) + 1;
          seen.set(vno, n);
          rows.push({
            voucher_no: vno, line_no: n, post_date: post, voucher_date: xlDate(get(r, 'voucher_date')),
            description: payStr(get(r, 'description')), amount: xlNum(get(r, 'amount')) || 0,
            vendor_code: payStr(get(r, 'vendor_code')), vendor_name: payStr(get(r, 'vendor_name')),
            bank_account: payStr(get(r, 'bank_account')), reason: payStr(get(r, 'reason')),
            voucher_type: payStr(get(r, 'voucher_type'))
          });
        }
      }
      return { kind, rows, period, fileTotal, file: fileName, sheet: sn };
    }
  }
  throw new Error(t('pay.unknownFile', { file: fileName }));
}

async function payRead() {
  const out = $('#payReadOut');
  const files = [...$('#payFile').files];
  $('#btnPayGo').disabled = true;
  PAY.parsed = [];
  if (!files.length) return msg(out, 'err', t('pm.imp.pickFile'));
  try { await payLoadProjects(); } catch {}
  const lines = [];
  for (const f of files) {
    try {
      const p = payParseBook(await pmReadBook(f), f.name);
      PAY.parsed.push(p);
      const sum = k => p.rows.reduce((s, r) => s + (r[k] || 0), 0);
      const auto = p.rows.filter(r => { const c = payCodes(r.description); return c.length === 1 && payResolve(c[0]).length === 1; }).length;
      let tot;
      if (p.kind === 'invoice') {
        const ok = p.fileTotal && Math.abs(sum('net') - p.fileTotal[0]) < 1 && Math.abs(sum('vat') - p.fileTotal[1]) < 1;
        tot = t('pay.readInv', { n: p.rows.length, net: fmtVnd(sum('net')), vat: fmtVnd(sum('vat')) })
            + ' ' + (p.fileTotal ? (ok ? t('pay.totOk') : t('pay.totBad')) : '');
      } else {
        const ok = p.fileTotal && Math.abs(sum('amount') - p.fileTotal[0]) < 1;
        tot = t('pay.readPay', { n: p.rows.length, amt: fmtVnd(sum('amount')) })
            + ' ' + (p.fileTotal ? (ok ? t('pay.totOk') : t('pay.totBad')) : '');
      }
      const per = p.period ? ` · ${fmtDate(p.period[0])} → ${fmtDate(p.period[1])}` : '';
      lines.push(`✔ ${f.name} — ${t('pay.kind.' + p.kind)}${per}\n   ${tot}\n   ${t('pay.readAuto', { a: auto, q: p.rows.length - auto })}`);
    } catch (e) { lines.push(`✘ ${f.name} — ${e.message}`); }
  }
  msg(out, PAY.parsed.length ? 'ok' : 'err', lines.join('\n'));
  $('#btnPayGo').disabled = !PAY.parsed.length || !can('payment', 'create');
}

async function payGo() {
  const out = $('#payReadOut');
  $('#btnPayGo').disabled = true;
  const lines = [];
  for (const p of PAY.parsed) {
    try {
      const r = await SB.rpc('pm_import_pay', { p_kind: p.kind, p_rows: p.rows, p_file: p.file,
                                                p_from: p.period ? p.period[0] : null, p_to: p.period ? p.period[1] : null });
      lines.push('✔ ' + t('pay.done', { file: p.file, rows: r.rows, nw: r.new, up: r.updated, auto: r.auto, q: r.queue })
                 + (r.gone ? '\n   ⚠ ' + t('pay.gone', { n: r.gone }) : ''));
    } catch (e) { lines.push(`✘ ${p.file} — ${e.message}`); }
  }
  PAY.parsed = [];
  $('#payFile').value = '';
  await payLoad();
  msg(out, lines.some(l => l.startsWith('✘')) ? 'warn' : 'ok', lines.join('\n'));   // after the reload
}

/* ------------------------------------------------------------ loading */
async function payLoadProjects() {
  await pmLookups();
  const [projects, finals] = await Promise.all([
    pmSelectAll('pm_project', 'select=code,main_code,name,dept_code,year,share_pct,estimated_value,contract_value,chosen_vendor,status&order=code'),
    SB.select('pm_budget_round', 'select=id&is_final=eq.true')
  ]);
  PAY.projects = projects;
  PAY.byCode = new Map(projects.map(p => [p.code, p]));
  const ids = finals.map(f => f.id);
  const lines = ids.length ? await pmSelectAll('pm_budget_line', `select=project_code,estimated_value&round_id=in.(${ids.join(',')})`) : [];
  PAY.budget = new Map();
  for (const l of lines) PAY.budget.set(l.project_code, (PAY.budget.get(l.project_code) || 0) + Number(l.estimated_value || 0));
  if (PAY.fillList) PAY.fillList();
}

// Budget value of a (sub-)project: its main code's final line × its share.
const payBudget = p => { const b = PAY.budget.get(p.main_code); return b == null ? null : b * (p.share_pct != null ? Number(p.share_pct) : 1); };

// A code found in a description → the projects it may mean.
function payResolve(code) {
  if (!PAY.byCode) return [];
  if (PAY.byCode.has(code)) return [code];
  return PAY.projects.filter(p => p.main_code === code).map(p => p.code);
}

async function payLoad() {
  const out = $('#payMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await payLoadProjects();
    const [inv, pay, alloc, money, imports] = await Promise.all([
      pmSelectAll('pm_invoice', 'select=*&order=post_date.desc,id.desc'),
      pmSelectAll('pm_payment', 'select=*&order=post_date.desc,id.desc'),
      pmSelectAll('pm_pay_alloc', 'select=*'),
      pmSelectAll('pm_project_money', 'select=*'),
      SB.select('pm_pay_import', 'select=*&order=imported_at.desc&limit=6')
    ]);
    Object.assign(PAY, { inv, pay, alloc, money, imports });
    PAY.allocBy = new Map();
    for (const a of alloc) {
      const k = a.kind + ':' + a.ref_id;
      (PAY.allocBy.get(k) || PAY.allocBy.set(k, []).get(k)).push(a);
    }
    msg(out, '', '');
    if (PAY.sel) PAY.sel.clear();                  // ticks point at the rows just replaced
    payRenderImports();
    payRender();
  } catch (e) {
    msg(out, 'err', /pm_invoice|pm_pay|relation|schema cache/i.test(e.message) ? t('pay.noTables') : e.message);
  }
}

/* The Import page: budget workbook, dossiers and the accounting exports side by
   side, each card only for those who may see that part. The accounting card
   needs the projects (to read codes in the preview) and the last imports. */
function piShow() {
  // Data sources screen: the periodic files on top (each by its own right), the master-data parts for System.
  $('#srcMaster').hidden = !can('system', 'view');
  $('#piBudCard').hidden = !can('budget', 'view');
  $('#piDosCard').hidden = !can('project', 'view');
  const pay = can('payment', 'view');
  $('#piPayCard').hidden = !pay;
  if (pay) payImpLoad();
}
async function payImpLoad() {
  try {
    await payLoadProjects();
    PAY.imports = await SB.select('pm_pay_import', 'select=*&order=imported_at.desc&limit=6');
    if (VIEW === 'sources') srcChecklist();
    payRenderImports();
  } catch (e) {
    msg('#payReadOut', 'err', /pm_invoice|pm_pay|relation|schema cache/i.test(e.message) ? t('pay.noTables') : e.message);
  }
}

function payRenderImports() {
  const box = $('#payImports');
  box.innerHTML = '';
  if (!(PAY.imports || []).length) return;
  box.append(el('div', { className: 'payimp' }, PAY.imports.slice(0, 4).map(i => el('span', {
    textContent: `${t('pay.kind.' + i.kind)} · ${fmtDate((i.imported_at || '').slice(0, 10))} · ${i.file_name || ''} · ${t('pay.impRows', { n: i.n_rows ?? 0, q: i.n_queue ?? 0 })}` }))));
}

/* ------------------------------------------------------------ helpers */
const payAllocOf = (kind, id) => PAY.allocBy.get(kind + ':' + id) || [];
function payStatus(kind, r) {
  if (r.gone) return 'gone';
  return r.alloc_mode || 'queue';
}
const payChip = s => el('span', { className: 'st pay-' + s, textContent: t('pay.st.' + s) });
function payProjCell(kind, r) {
  const a = payAllocOf(kind, r.id);
  // One code per line, so the column is as wide as one code (feedback 25/09/2026).
  if (!a.length) return el('td', { className: 'paycodes' }, (r.codes_found || []).length
    ? r.codes_found.map(c => el('div', { textContent: c })) : [document.createTextNode('—')]);
  return el('td', { className: 'paycodes' }, a.map(x => el('div', {}, [el('code', { textContent: x.project_code }),
    Number(x.share) < 1 ? document.createTextNode(' ' + fmtPct(Number(x.share), 0)) : ''])));
}
function payFilterRows(rows, kind) {
  const q = hnorm($('#payQ').value), y = $('#payYear').value, st = $('#paySt').value;
  return rows.filter(r => {
    if (y && String(r.post_date || '').slice(0, 4) !== y) return false;
    if (st && payStatus(kind, r) !== st) return false;
    if (q) {
      const hay = hnorm([r.description, r.invoice_no, r.voucher_no, r.seller_name, r.vendor_name, r.vendor_code,
                         ...payAllocOf(kind, r.id).map(a => a.project_code)].join(' '));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------- render */
/* The grid of each tab is a list of columns — header, sort value, filter text
   and cell — as on the Projects screen: click a header to sort, type under it
   to filter (">1000000", "<0", "1..5" on figures). Rows are items
   { kind, r } (an invoice or payment line) or, By project, { p, ...sums }. */
function payCols(tab) {
  const doc = it => it.kind === 'invoice' ? it.r.invoice_no : it.r.voucher_no + (it.r.line_no > 1 ? '/' + it.r.line_no : '');
  const party = it => it.kind === 'invoice' ? it.r.seller_name || '' : (it.r.vendor_name || it.r.vendor_code || '');
  const money = (k, lbl, f, cls, title) => ({ k, lbl, num: true, sum: true, val: f,
    txt: it => { const v = f(it); return v == null ? '' : fmtVnd(v); },
    td: it => { const v = f(it); return el('td', { className: 'num' + (cls && cls(it) ? ' ' + cls(it) : ''), title: title ? title(it) : '',
                                                   textContent: v == null ? '' : fmtVnd(v) }); } });
  const text = (k, lbl, f, cls, code) => ({ k, lbl, val: it => f(it) || '', txt: it => f(it) || '',
    td: it => el('td', { className: cls || '' }, code ? el('code', { textContent: f(it) || '' }) : document.createTextNode(f(it) || '')) });
  const date = (k, lbl, f) => ({ k, lbl, val: it => f(it) || '', txt: it => fmtDate(f(it)),
    td: it => el('td', { className: 'nw', textContent: fmtDate(f(it)) }) });
  const projs = it => payAllocOf(it.kind, it.r.id).map(a => a.project_code).join(', ');
  const projCol = { k: 'proj', lbl: 'pay.c.projects', val: projs, txt: it => projs(it) || (it.r.codes_found || []).join(', '),
                    td: it => payProjCell(it.kind, it.r) };
  // The project names (user 25/09/2026): of the allocation, else of the codes found that match a project.
  const projName = it => {
    const a = payAllocOf(it.kind, it.r.id).map(x => x.project_code);
    const codes = a.length ? a : [...new Set((it.r.codes_found || []).flatMap(payResolve))];
    return codes.map(c => (PAY.byCode.get(c) || {}).name).filter(Boolean).join('; ');
  };
  const nameCol = text('pname', 'pay.c.projName', projName, 'wrapcell');
  const stCol = { k: 'st', lbl: 'pay.c.status', val: it => t('pay.st.' + payStatus(it.kind, it.r)),
                  txt: it => t('pay.st.' + payStatus(it.kind, it.r)), td: it => el('td', {}, payChip(payStatus(it.kind, it.r))) };
  const desc = text('desc', 'pay.c.desc', it => it.r.description, 'wrapcell paydesc');
  // Column order (user 25/09/2026): the allocation before the date, the projects right after it.
  if (tab === 'queue') return [
    text('kind', 'pay.c.kind', it => t('pay.kind.' + it.kind)), date('date', 'pay.c.date', it => it.r.post_date),
    text('codes', 'pay.c.codes', it => (it.r.codes_found || []).join(', ') || '—', 'paycodes'), nameCol,
    text('doc', 'pay.c.doc', doc, '', true), text('party', 'pay.c.party', party, 'wrapcell'),
    money('amount', 'pay.c.amount', it => Number(it.kind === 'invoice' ? it.r.net : it.r.amount)), desc];
  // Invoice no. and series after the amount incl. VAT (feedback 25/09/2026).
  if (tab === 'invoice') return [
    stCol, date('date', 'pay.c.date', it => it.r.post_date), projCol, nameCol, text('party', 'pay.c.party', party, 'wrapcell'),
    money('net', 'pay.c.net', it => Number(it.r.net)), money('vat', 'pay.c.vat', it => Number(it.r.vat)),
    text('rate', 'pay.c.rate', it => it.r.vat_rate), money('gross', 'pay.c.gross', it => Number(it.r.net) + Number(it.r.vat)),
    text('doc', 'pay.c.invNo', doc, '', true), text('series', 'pay.c.series', it => it.r.series), desc];
  if (tab === 'payment') return [
    stCol, date('date', 'pay.c.date', it => it.r.post_date), projCol, nameCol,
    text('doc', 'pay.c.payslip', doc, '', true), text('vcode', 'pay.c.vendor', it => it.r.vendor_code, '', true),
    text('party', 'pay.c.party', it => it.r.vendor_name, 'wrapcell'), money('paid', 'pay.c.paid', it => Number(it.r.amount)), desc];
  // By project: no "invoiced − paid" / "contract − invoiced"; the contract with its share of the budget,
  // and Paid % = paid (pre-tax) ÷ contract, like the Projects screen (user 25/09/2026).
  return [
    text('code', 'pm.col.code', it => it.p.code, '', true), text('name', 'pm.col.name', it => it.p.name, 'wrapcell'),
    text('dept', 'pm.col.dept', it => pmDeptName(it.p.dept_code)),
    money('budget', 'pay.c.budget', it => it.budget),
    Object.assign(money('contract', 'pm.col.contract', it => it.contract), {
      td: it => ppContractCell({ contract_value: it.contract, estimated_value: it.budget }),
      totTd: live => { const withC = live.filter(it => it.contract != null);
        return ppContractCell({ contract_value: withC.reduce((s, it) => s + it.contract, 0), estimated_value: withC.reduce((s, it) => s + (it.budget || 0), 0) }); } }),
    money('inv', 'pay.c.net', it => it.inv), money('vat', 'pay.c.vat', it => it.vat), money('gross', 'pay.c.gross', it => it.gross),
    // Paid with its share of the contract as a small pill, like the Contract column (feedback 25/09/2026).
    Object.assign(money('paid', 'pay.c.paid', it => it.paid), {
      td: it => payPaidCell(it.paid, it.paidPct),
      totTd: live => { const withC = live.filter(it => it.contract), b = withC.reduce((s, it) => s + it.contract, 0);
        return payPaidCell(live.reduce((s, it) => s + it.paid, 0), b ? withC.reduce((s, it) => s + it.paidNet, 0) / b : null); } }),
    date('last', 'pay.c.lastPaid', it => it.last)];
}

// Paid (gross) with its pill: paid pre-tax ÷ contract; red past 100 %.
const payPaidCell = (v, pct) => el('td', { className: 'num paidc', title: t('pay.c.paidPctHint') }, [document.createTextNode(fmtVnd(v)),
  el('small', { className: 'pp' + (pct > 1.0001 ? ' neg' : ''), textContent: pct != null ? fmtPct(pct, 0) : '—' })]);

// The rows of a tab, after the bar above (year, status, search).
function payItems(tab) {
  const wrap = kind => r => ({ kind, r });
  if (tab === 'queue')
    return [...payFilterRows(PAY.inv, 'invoice').filter(r => payStatus('invoice', r) === 'queue').map(wrap('invoice')),
            ...payFilterRows(PAY.pay, 'payment').filter(r => payStatus('payment', r) === 'queue').map(wrap('payment'))]
      .sort((a, b) => String(b.r.post_date).localeCompare(String(a.r.post_date)));
  if (tab === 'invoice') return payFilterRows(PAY.inv, 'invoice').map(wrap('invoice'));
  if (tab === 'payment') return payFilterRows(PAY.pay, 'payment').map(wrap('payment'));
  // By project: only projects with money against them, plus the search.
  const q = hnorm($('#payQ').value), y = $('#payYear').value;
  return PAY.money.filter(m => (m.n_invoices || m.n_payments)).map(m => {
    const p = PAY.byCode.get(m.project_code) || { code: m.project_code };
    const inv = Number(m.invoiced_net), vat = Number(m.invoiced_vat), paid = Number(m.paid_gross);
    const budget = p.main_code ? payBudget(p) : null;
    const contract = p.contract_value != null ? Number(p.contract_value) : null;
    // Paid pre-tax at the project's VAT rate (8 % before any invoice), against the contract.
    const paidNet = paid / (1 + (inv > 0 ? vat / inv : 0.08));
    return { p, inv, vat, gross: inv + vat, paid, paidNet, budget, contract,
             paidPct: contract ? paidNet / contract : null, last: m.last_paid };
  }).filter(r => (!y || String(r.p.year) === y) && (!q || hnorm(`${r.p.code} ${r.p.name} ${r.p.dept_code}`).includes(q)))
    .sort((a, b) => a.p.code.localeCompare(b.p.code));
}

// Column filters, then the header sort.
function payRows(cols) {
  const cf = (PAY.cf[PAY.tab] = PAY.cf[PAY.tab] || {});
  let rows = payItems(PAY.tab).filter(it => cols.every(c => ppCfMatch(c, it, cf[c.k] || '')));
  const s = PAY.sort[PAY.tab], col = s && cols.find(c => c.k === s.k);
  if (col) {
    const dir = s.dir === 'desc' ? -1 : 1;
    rows = rows.slice().sort((a, b) => {
      const x = col.val(a), y = col.val(b);
      if (x == null || x === '') return 1;
      if (y == null || y === '') return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), pmLoc())) * dir;
    });
  }
  return rows;
}

// Invoice / payment lines can be ticked and allocated together; By project cannot.
const paySelectable = it => !!it.kind && !it.r.gone && can('payment', 'edit');
const payKey = it => it.kind + ':' + it.r.id;
const payHasTicks = () => PAY.tab !== 'project' && can('payment', 'edit');

function payRender() {
  MONEY.year = +$('#payYear').value || null;
  PAY.cf = PAY.cf || {}; PAY.sort = PAY.sort || {}; PAY.sel = PAY.sel || new Map();
  const tabs = $('#payTabs');
  tabs.innerHTML = '';
  const nQueue = PAY.inv.filter(r => payStatus('invoice', r) === 'queue').length
               + PAY.pay.filter(r => payStatus('payment', r) === 'queue').length;
  for (const k of PAY_TABS) {
    const b = el('button', { textContent: t('pay.tab.' + k) + (k === 'queue' && nQueue ? ` (${nQueue})` : '') });
    b.classList.toggle('on', PAY.tab === k);
    b.onclick = () => { PAY.tab = k; PAY.pick = null; PAY.sel.clear(); $('#payDetail').innerHTML = ''; payRender(); };
    tabs.append(b);
  }
  // Year choices from the data itself.
  const years = [...new Set([...PAY.inv, ...PAY.pay].map(r => String(r.post_date || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  selFill($('#payYear'), [['', t('pm.f.allYears')], ...years.map(y => [y, y])]);
  selFill($('#paySt'), [['', t('pm.f.all')], ...['queue', 'auto', 'manual', 'ignore', 'gone'].map(s => [s, t('pay.st.' + s)])]);
  $('#payStWrap').hidden = PAY.tab === 'queue' || PAY.tab === 'project';

  const cols = payCols(PAY.tab);
  const ticks = payHasTicks();
  const cf = (PAY.cf[PAY.tab] = PAY.cf[PAY.tab] || {});
  const head = $('#payGrid thead');
  head.innerHTML = '';
  // Header: tick-all, then click a title to sort (again to reverse).
  const all = el('input', { type: 'checkbox', title: t('pay.selAll') });
  all.onchange = () => {
    for (const it of PAY.shown || []) if (paySelectable(it)) { if (all.checked) PAY.sel.set(payKey(it), it); else PAY.sel.delete(payKey(it)); }
    payRenderBody(cols);
  };
  const hr = el('tr', {}, [...(ticks ? [el('th', { className: 'cb' }, all)] : []), ...cols.map(c => {
    const s = PAY.sort[PAY.tab] && PAY.sort[PAY.tab].k === c.k ? PAY.sort[PAY.tab].dir : null;
    const th = el('th', { className: 'srt' + (c.num ? ' num' : '') + (s ? ' on' : ''), title: t('pm.sortHint') },
      [document.createTextNode(t(c.lbl)), el('span', { className: 'arr', textContent: s === 'asc' ? '▲' : s === 'desc' ? '▼' : '⇅' })]);
    th.onclick = () => { PAY.sort[PAY.tab] = { k: c.k, dir: s === 'asc' ? 'desc' : 'asc' }; payRender(); };
    return th; })]);
  const clear = el('button', { className: 'btn tiny', textContent: '↺', title: t('pm.cfClear') });
  clear.onclick = () => { PAY.cf[PAY.tab] = {}; payRender(); };
  const fr = el('tr', { className: 'frow' }, [el('th', {}, clear), ...cols.map((c, i) => {
    const inp = el('input', { className: 'cfin' + (cf[c.k] ? ' on' : ''), value: cf[c.k] || '', spellcheck: false,
      placeholder: c.num ? '>0 · <0 · 1..9' : t('pm.cfPh') });
    inp.oninput = () => { cf[c.k] = inp.value; inp.classList.toggle('on', !!inp.value); payRenderBody(cols); };
    // Without the tick column the reset button shares the first filter cell.
    return i === 0 && !ticks ? null : el('th', {}, inp);
  }).filter(Boolean)]);
  if (!ticks) {                          // first header cell holds both the reset and the first filter
    const c0 = cols[0], inp = el('input', { className: 'cfin' + (cf[c0.k] ? ' on' : ''), value: cf[c0.k] || '', spellcheck: false,
      placeholder: c0.num ? '>0 · <0 · 1..9' : t('pm.cfPh'), style: 'width:calc(100% - 30px);min-width:40px' });
    inp.oninput = () => { cf[c0.k] = inp.value; inp.classList.toggle('on', !!inp.value); payRenderBody(cols); };
    fr.firstChild.append(inp);
  }
  head.append(hr, fr);
  PAY.allBox = ticks ? all : null;
  payRenderBody(cols);
}

// Rows only, so typing in a column filter keeps the cursor where it is.
function payRenderBody(cols) {
  const body = $('#payGrid tbody');
  body.innerHTML = '';
  const rows = PAY.shown = payRows(cols);
  const ticks = payHasTicks();
  const n = cols.length + (ticks ? 1 : 0);
  if (!rows.length) body.append(el('tr', {}, el('td', { colSpan: n, className: 'payempty', textContent: t('pay.none') })));
  for (const it of rows) {
    const key = it.kind ? payKey(it) : 'project' + it.p.code;
    const pick = it.kind ? PAY.pick === it.kind + it.r.id : PAY.pick === key;
    const tr = el('tr', { className: (it.r && it.r.gone ? 'gone ' : '') + (pick ? 'pick ' : '') + (it.kind && PAY.sel.has(key) ? 'sel' : ''),
                          style: 'cursor:pointer' });
    if (ticks) {
      const cb = el('input', { type: 'checkbox', checked: PAY.sel.has(key), disabled: !paySelectable(it) });
      cb.onclick = ev => ev.stopPropagation();
      cb.onchange = () => { if (cb.checked) PAY.sel.set(key, it); else PAY.sel.delete(key); tr.classList.toggle('sel', cb.checked); payBulkBar(); };
      tr.append(el('td', { className: 'cb' }, cb));
    }
    for (const c of cols) tr.append(c.td(it));
    tr.onclick = it.kind
      ? () => { PAY.pick = it.kind + it.r.id; payRenderBody(cols); if (can('payment', 'edit')) payEdit(it.kind, it.r); }
      : () => { PAY.pick = key; payRenderBody(cols); $('#payDetail').innerHTML = ''; payProjectDetail(it.p.code, $('#payDetail')); };
    body.append(tr);
  }
  // Totals of what is shown (lines gone from the file left out); "used" = total invoiced ÷ total budget.
  if (rows.length) {
    const live = rows.filter(it => !(it.r && it.r.gone));
    const tot = el('tr', { className: 'tot' }, ticks ? [el('td')] : []);
    cols.forEach((c, i) => {
      if (i === 0) return tot.append(el('td', { textContent: t('pm.total', { n: fmtInt(rows.length) }) }));
      if (c.totTd) return tot.append(c.totTd(live));
      if (c.sum) return tot.append(el('td', { className: 'num', textContent: fmtVnd(live.reduce((s, it) => s + (Number(c.val(it)) || 0), 0)) }));
      tot.append(el('td'));
    });
    body.append(tot);
  }
  if (PAY.allBox) { const ok = rows.filter(paySelectable); PAY.allBox.checked = ok.length > 0 && ok.every(it => PAY.sel.has(payKey(it))); }
  payBulkBar();
}

/* The bar for ticked lines: how many, how much, and what to do with all of
   them at once — one split (usually one project) for every line, or mark them
   "not a project" / back to automatic. */
function payBulkBar() {
  let bar = $('#payBulk');
  if (!bar) { bar = el('div', { id: 'payBulk', className: 'paybulk' }); $('#payMsg').before(bar); }
  bar.innerHTML = '';
  const items = [...PAY.sel.values()];
  const top = $('#btnPayAlloc');
  if (top) { top.hidden = PAY.tab === 'project' || !can('payment', 'edit'); top.disabled = !items.length;
            top.textContent = items.length ? t('pay.allocN', { n: fmtInt(items.length) }) : t('pay.allocate'); }
  bar.hidden = !items.length || PAY.tab === 'project';
  if (bar.hidden) return;
  const amt = items.reduce((s, it) => s + Number(it.kind === 'invoice' ? it.r.net : it.r.amount), 0);
  const b = (k, cls, fn) => { const x = el('button', { className: 'btn tiny ' + (cls || ''), textContent: t(k) }); x.onclick = fn; bar.append(x); };
  bar.append(el('b', { textContent: t('pay.bulk.n', { n: fmtInt(items.length), v: fmtVnd(amt) }) }));
  b('pay.bulk.alloc', 'pri', () => payBulkEdit(items));
  b('pay.ignore', '', () => payBulkCall(items, 'ignore'));
  b('pay.auto', '', () => payBulkCall(items, 'auto'));
  b('pay.bulk.clear', '', () => { PAY.sel.clear(); payRenderBody(payCols(PAY.tab)); });
}

// One call per line; report how many went through and which did not.
async function payBulkCall(items, mode, alloc) {
  const bad = [];
  for (const it of items) {
    try { await SB.rpc('pm_alloc_set', { p_kind: it.kind, p_id: it.r.id, p_alloc: alloc || [], p_mode: mode }); }
    catch (e) { bad.push(`${it.kind === 'invoice' ? it.r.invoice_no : it.r.voucher_no}: ${e.message}`); }
  }
  PAY.sel.clear();
  $('#payDetail').innerHTML = '';
  await payLoad();
  msg('#payMsg', bad.length ? 'warn' : 'ok', t('pay.bulk.done', { ok: fmtInt(items.length - bad.length), n: fmtInt(items.length) })
      + (bad.length ? '\n' + bad.join('\n') : ''));
}

/* Allocating several ticked lines at once, two ways (user 25/09/2026):
   - "each by its code": every line goes to the project its own description
     names; a line whose code matches no single project gets one picked here;
   - "split together": the lines' total is shared among several projects, by
     % or by amount — the same shares applied to every line. */
function payBulkEdit(items) {
  const box = $('#payDetail');
  box.innerHTML = '';
  PAY.bulkMode = PAY.bulkMode || 'each';
  const amt = it => Number(it.kind === 'invoice' ? it.r.net : it.r.amount);
  const docNo = it => it.kind === 'invoice' ? it.r.invoice_no : it.r.voucher_no;
  const amount = items.reduce((s, it) => s + amt(it), 0);
  const card = el('div', { className: 'card' });
  const seg = el('div', { className: 'seg' });
  for (const m of ['each', 'split']) {
    const b = el('button', { textContent: t('pay.bulk.mode.' + m) });
    b.classList.toggle('on', PAY.bulkMode === m);
    b.onclick = () => { PAY.bulkMode = m; payBulkEdit(items); };
    seg.append(b);
  }
  card.append(el('div', { className: 'chead' }, [el('h2', { textContent: t('pay.bulk.h', { n: fmtInt(items.length) }) }), seg]),
    el('p', { className: 'paydesc', textContent: t('pay.bulk.modeHint.' + PAY.bulkMode) }));
  const out = el('div');
  const cancel = el('button', { className: 'btn', textContent: t('sig.cancel') });
  cancel.onclick = () => { box.innerHTML = ''; };

  if (PAY.bulkMode === 'each') {
    // One row per line: its codes, and the project it goes to (the only match, else picked here).
    const pick = items.map(it => { const c = [...new Set((it.r.codes_found || []).flatMap(payResolve))]; return { it, codes: c, code: c.length === 1 ? c[0] : '' }; });
    const tb = el('table', { className: 'wflines' });
    tb.append(el('tr', {}, [['pay.c.doc'], ['pay.c.party'], ['pay.c.amount', 'num'], ['pay.c.codes'], ['pm.col.code'], ['pm.col.name']]
      .map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
    for (const x of pick) {
      const inp = el('input', { value: x.code, style: 'width:180px', spellcheck: false, placeholder: x.codes.length > 1 ? t('pay.bulk.pickOne') : '' });
      inp.setAttribute('list', 'payProjList');
      const name = el('td', { className: 'wrapcell' });
      const show = () => { const p = PAY.byCode.get(x.code); name.textContent = p ? p.name || '' : (x.code ? '⚠ ' + t('pay.noProject') : ''); };
      inp.onchange = () => { x.code = pmCode(inp.value); inp.value = x.code; show(); };
      show();
      tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: docNo(x.it) })),
        el('td', { className: 'wrapcell', textContent: x.it.kind === 'invoice' ? x.it.r.seller_name : (x.it.r.vendor_name || x.it.r.vendor_code) }),
        el('td', { className: 'num', textContent: fmtVnd(amt(x.it)) }), el('td', { className: 'paycodes', textContent: (x.it.r.codes_found || []).join(', ') || '—' }),
        el('td', {}, inp), name]));
    }
    const save = el('button', { className: 'btn pri', textContent: t('pay.bulk.save', { n: fmtInt(items.length) }) });
    save.onclick = async () => {
      const bad = pick.filter(x => x.code && !PAY.byCode.has(x.code));
      if (bad.length) return msg(out, 'err', t('pay.badCodes', { c: bad.map(x => x.code).join(', ') }));
      const go = pick.filter(x => x.code), skip = pick.length - go.length;
      if (!go.length) return msg(out, 'err', t('pay.bulk.noneSet'));
      const fails = [];
      for (const x of go) {
        try { await SB.rpc('pm_alloc_set', { p_kind: x.it.kind, p_id: x.it.r.id, p_alloc: [{ project_code: x.code, share: 1 }], p_mode: 'manual' }); }
        catch (e) { fails.push(`${docNo(x.it)}: ${e.message}`); }
      }
      PAY.sel.clear();
      box.innerHTML = '';
      await payLoad();
      msg('#payMsg', fails.length || skip ? 'warn' : 'ok', t('pay.bulk.done', { ok: fmtInt(go.length - fails.length), n: fmtInt(items.length) })
          + (skip ? '\n' + t('pay.bulk.skipped', { n: fmtInt(skip) }) : '') + (fails.length ? '\n' + fails.join('\n') : ''));
    };
    card.append(el('div', { className: 'wrap' }, tb), el('div', { className: 'acts' }, [save, cancel]), out);
    box.append(card);
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  // Split together: the projects every ticked line mentions are proposed, evenly.
  const codes = items.map(it => new Set((it.r.codes_found || []).flatMap(payResolve)));
  const common = codes.length ? [...codes[0]].filter(c => codes.every(s => s.has(c))) : [];
  const even = common.length ? Math.round(10000 / common.length) / 100 : 100;
  const lines = common.length
    ? common.map((c, i) => ({ code: c, pct: i < common.length - 1 ? even : Math.round((100 - even * (common.length - 1)) * 100) / 100 }))
    : [{ code: '', pct: 100 }];
  const tb = el('table', { className: 'wflines' }), sumEl = el('div', { className: 'wftotal' });
  const draw = () => {
    tb.innerHTML = '';
    tb.append(el('tr', {}, [el('th', { textContent: t('pm.col.code') }), el('th', { textContent: t('pm.col.name') }),
      el('th', { className: 'num', textContent: '%' }), el('th', { className: 'num', textContent: t('pay.c.amount') }), el('th')]));
    lines.forEach((l, i) => {
      const code = el('input', { value: l.code, style: 'width:190px', spellcheck: false });
      code.setAttribute('list', 'payProjList');
      code.onchange = () => { l.code = pmCode(code.value); draw(); };
      const pct = el('input', { value: l.pct, style: 'width:80px', inputMode: 'decimal' });
      pct.onchange = () => { l.pct = numIn(pct.value) || 0; draw(); };
      // …or by amount: the % follows from the lines' total.
      const money = el('input', { value: fmtNum(Math.round(amount * l.pct / 100)), style: 'width:130px', inputMode: 'decimal' });
      money.onchange = () => { const v = numIn(money.value) || 0; l.pct = amount ? Math.round(v / amount * 1e6) / 1e4 : 0; draw(); };
      const x = el('button', { className: 'xbtn', textContent: '×' });
      x.onclick = () => { lines.splice(i, 1); draw(); };
      const p = PAY.byCode.get(l.code);
      tb.append(el('tr', {}, [el('td', {}, code),
        el('td', { className: 'wrapcell', textContent: p ? p.name || '' : (l.code ? '⚠ ' + t('pay.noProject') : '') }),
        el('td', { className: 'num' }, pct), el('td', { className: 'num' }, money), el('td', {}, x)]));
    });
    const s = lines.reduce((a, l) => a + (l.pct || 0), 0);
    sumEl.textContent = t('pay.sum', { p: Math.round(s * 100) / 100 }) + ' · ' + fmtVnd(amount * s / 100) + ' / ' + fmtVnd(amount);
    sumEl.classList.toggle('payneg', Math.abs(s - 100) > 0.01);
  };
  draw();
  const add = el('button', { className: 'btn tiny', textContent: t('pay.addLine') });
  add.onclick = () => { const s = lines.reduce((a, l) => a + (l.pct || 0), 0); lines.push({ code: '', pct: Math.max(0, Math.round((100 - s) * 100) / 100) }); draw(); };
  const save = el('button', { className: 'btn pri', textContent: t('pay.bulk.save', { n: fmtInt(items.length) }) });
  save.onclick = () => {
    const bad = lines.filter(l => !PAY.byCode.has(l.code));
    if (bad.length) return msg(out, 'err', t('pay.badCodes', { c: bad.map(l => l.code || '—').join(', ') }));
    const s = lines.reduce((a, l) => a + (l.pct || 0), 0);
    if (Math.abs(s - 100) > 0.01) return msg(out, 'err', t('pay.sumBad', { p: Math.round(s * 100) / 100 }));
    const merged = new Map();
    for (const l of lines) merged.set(l.code, (merged.get(l.code) || 0) + l.pct);
    payBulkCall(items, 'manual', [...merged].map(([project_code, pct]) => ({ project_code, share: Math.round(pct * 10000) / 1e6 })));
  };
  card.append(el('div', { className: 'wrap' }, tb), add, sumEl, el('div', { className: 'acts' }, [save, cancel]), out);
  box.append(card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* --------------------------------------------------- allocation editor */
function payEdit(kind, r) {
  const box = $('#payDetail');
  box.innerHTML = '';
  PAY.pick = kind + r.id;
  const card = el('div', { className: 'card' });
  const amount = kind === 'invoice' ? Number(r.net) : Number(r.amount);
  card.append(el('h2', { textContent: `${t('pay.kind.' + kind)} ${kind === 'invoice' ? r.invoice_no : r.voucher_no} — ${kind === 'invoice' ? r.seller_name : (r.vendor_name || r.vendor_code)}` }));
  const dl = el('dl', { className: 'wfhead' });
  const put = (k, v) => { if (v != null && v !== '') dl.append(el('dt', { textContent: t(k) }), el('dd', { textContent: String(v) })); };
  put('pay.c.date', fmtDate(r.post_date));
  if (kind === 'invoice') { put('pay.c.net', fmtVnd(Number(r.net))); put('pay.c.vat', fmtVnd(Number(r.vat)) + (r.vat_rate ? ` (${r.vat_rate})` : '')); }
  else put('pay.c.paid', fmtVnd(Number(r.amount)));
  put('pay.c.codes', (r.codes_found || []).join(', ') || '—');
  put('pay.c.status', t('pay.st.' + payStatus(kind, r)));
  card.append(dl, el('p', { className: 'paydesc', textContent: r.description || '' }));

  // Start from the current split, else from the codes found in the text:
  // a main code with several sub-projects proposes all of them, weighted by
  // contract (or estimate) value — a proposal the user confirms, never a guess
  // the system saves on its own.
  let lines = payAllocOf(kind, r.id).map(a => ({ code: a.project_code, pct: Math.round(Number(a.share) * 10000) / 100 }));
  if (!lines.length) {
    const cand = [...new Set((r.codes_found || []).flatMap(payResolve))];
    const w = cand.map(c => { const p = PAY.byCode.get(c) || {}; return Number(p.contract_value || p.estimated_value || 0); });
    const tw = w.reduce((s, x) => s + x, 0);
    lines = cand.map((c, i) => ({ code: c, pct: Math.round((tw ? w[i] / tw : 1 / cand.length) * 10000) / 100 }));
    if (lines.length) lines[lines.length - 1].pct = Math.round((100 - lines.slice(0, -1).reduce((s, l) => s + l.pct, 0)) * 100) / 100;
  }
  if (!lines.length) lines = [{ code: '', pct: 100 }];

  const tb = el('table', { className: 'wflines' });
  const sumEl = el('div', { className: 'wftotal' });
  const draw = () => {
    tb.innerHTML = '';
    tb.append(el('tr', {}, [el('th', { textContent: t('pm.col.code') }), el('th', { textContent: t('pm.col.name') }),
      el('th', { className: 'num', textContent: '%' }), el('th', { className: 'num', textContent: t('pay.c.amount') }), el('th')]));
    lines.forEach((l, i) => {
      const code = el('input', { value: l.code, style: 'width:190px', spellcheck: false });
      code.setAttribute('list', 'payProjList');
      code.onchange = () => { l.code = pmCode(code.value); draw(); };
      const pct = el('input', { value: l.pct, style: 'width:80px', inputMode: 'decimal' });
      pct.onchange = () => { l.pct = numIn(pct.value) || 0; draw(); };
      const x = el('button', { className: 'xbtn', textContent: '×' });
      x.onclick = () => { lines.splice(i, 1); draw(); };
      const p = PAY.byCode.get(l.code);
      tb.append(el('tr', {}, [el('td', {}, code),
        el('td', { className: 'wrapcell', textContent: p ? p.name || '' : (l.code ? '⚠ ' + t('pay.noProject') : '') }),
        el('td', { className: 'num' }, pct), el('td', { className: 'num', textContent: fmtVnd(amount * l.pct / 100) }), el('td', {}, x)]));
    });
    const s = lines.reduce((a, l) => a + (l.pct || 0), 0);
    sumEl.textContent = t('pay.sum', { p: Math.round(s * 100) / 100 });
    sumEl.classList.toggle('payneg', Math.abs(s - 100) > 0.01);
  };
  draw();
  const add = el('button', { className: 'btn tiny', textContent: t('pay.addLine') });
  add.onclick = () => { const s = lines.reduce((a, l) => a + (l.pct || 0), 0); lines.push({ code: '', pct: Math.max(0, Math.round((100 - s) * 100) / 100) }); draw(); };
  card.append(el('div', { className: 'wrap' }, tb), add, sumEl);

  const acts = el('div', { className: 'acts' });
  const out = el('div');
  const call = async (mode, alloc) => {
    try {
      await SB.rpc('pm_alloc_set', { p_kind: kind, p_id: r.id, p_alloc: alloc || [], p_mode: mode });
      await payLoad();
      msg('#payMsg', 'ok', t('pay.saved.' + mode, { doc: kind === 'invoice' ? r.invoice_no : r.voucher_no }));
      $('#payDetail').innerHTML = '';
    } catch (e) { msg(out, 'err', e.message); }
  };
  const save = el('button', { className: 'btn pri', textContent: t('tool.save') });
  save.onclick = () => {
    const bad = lines.filter(l => !PAY.byCode.has(l.code));
    if (bad.length) return msg(out, 'err', t('pay.badCodes', { c: bad.map(l => l.code || '—').join(', ') }));
    const s = lines.reduce((a, l) => a + (l.pct || 0), 0);
    if (Math.abs(s - 100) > 0.01) return msg(out, 'err', t('pay.sumBad', { p: Math.round(s * 100) / 100 }));
    const merged = new Map();
    for (const l of lines) merged.set(l.code, (merged.get(l.code) || 0) + l.pct);
    call('manual', [...merged].map(([project_code, pct]) => ({ project_code, share: Math.round(pct * 10000) / 1e6 })));
  };
  const ign = el('button', { className: 'btn', textContent: t('pay.ignore') });
  ign.onclick = () => call('ignore');
  const auto = el('button', { className: 'btn', textContent: t('pay.auto') });
  auto.onclick = () => call('auto');
  const cancel = el('button', { className: 'btn', textContent: t('sig.cancel') });
  cancel.onclick = () => { box.innerHTML = ''; PAY.pick = null; payRender(); };
  acts.append(save, ign, auto, cancel);
  card.append(acts, out);
  box.append(card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* The project panel's payments as ONE table by payment term (user 25/09/2026):
   the terms and their amounts from the contract (CT — its payment schedule),
   matched in date order with the payments actually made; per row the date
   paid, the amount pre-tax and gross, its share of the contract, and whether
   the invoices received so far cover it (✓) or not yet (✗); a total row.
   Without a contract, each payment is a row of its own. */
async function payTermTable(code, p, m, pay, share, wrap) {
  let ct = null;
  try {
    const docs = await SB.select('pm_doc', `select=data,status&project_code=eq.${encodeURIComponent(code)}&doc_type=eq.CT&order=id.desc`);
    ct = (docs.find(d => !['cancelled', 'rejected'].includes(d.status)) || {}).data || null;
  } catch {}
  const terms = ct && (ct.lines || []).length ? ct.lines : [];
  const value = ct && n0(ct.value) ? n0(ct.value) : (p.contract_value != null ? Number(p.contract_value) : null);
  // Pre-tax at the project's VAT rate as its invoices show it (8 % before the first invoice), like the Paid column.
  const vat = m && Number(m.invoiced_net) > 0 ? Number(m.invoiced_vat) / Number(m.invoiced_net) : 0.08;
  const invGross = m ? Number(m.invoiced_net) + Number(m.invoiced_vat) : 0;
  const paid = pay.slice().sort((a, b) => String(a.post_date).localeCompare(String(b.post_date)))
    .map(r => ({ date: r.post_date, gross: Number(r.amount) * share('payment', r.id), doc: r.voucher_no }));
  const n = Math.max(terms.length, paid.length);
  const tb = el('table', { className: 'paytrail payterms' });
  tb.append(el('tr', {}, [['pay.t.term'], ['pay.t.termAmt', 'num'], ['pay.t.date'], ['pay.t.net', 'num'], ['pay.t.gross', 'num'],
    ['%', 'num'], ['pay.t.inv', 'c']].map(([k, c]) => el('th', { className: c || '', textContent: k === '%' ? '%' : t(k) }))));
  let cumPaid = 0, sumTerm = 0, sumPct = 0, sumNet = 0, sumGross = 0;
  for (let i = 0; i < n; i++) {
    const tm = terms[i], py = paid[i];
    const termAmt = tm ? (tm.amount != null ? n0(tm.amount) : Math.round(n0(value) * n0(tm.pct) / 100)) : null;
    const net = py ? py.gross / (1 + vat) : null;
    if (py) cumPaid += py.gross;
    if (tm) { sumTerm += termAmt || 0; sumPct += n0(tm.pct); }
    if (py) { sumNet += net; sumGross += py.gross; }
    // Covered by invoices: what has been invoiced (incl. VAT) reaches what has been paid up to this row.
    const invoiced = py ? invGross + 1 >= cumPaid : null;
    tb.append(el('tr', {}, [
      el('td', { textContent: tm ? `${i + 1}. ${tm.milestone || ''}${tm.pct != null && tm.pct !== '' ? ' · ' + fmtNum(n0(tm.pct)) + '%' : ''}` : `${i + 1}.` }),
      el('td', { className: 'num', textContent: termAmt != null ? fmtVnd(termAmt) : '' }),
      el('td', { textContent: py ? fmtDate(py.date) : '', title: py ? py.doc : '' }),
      el('td', { className: 'num', textContent: py ? fmtVnd(net) : '' }),
      el('td', { className: 'num', textContent: py ? fmtVnd(py.gross) : '' }),
      el('td', { className: 'num', textContent: py && value ? fmtPct(net / value, 0) : '' }),
      el('td', { className: 'c ' + (invoiced ? 'ok' : 'no'), textContent: invoiced == null ? '' : invoiced ? '✓' : '✗' })]));
  }
  tb.append(el('tr', { className: 'tot' }, [
    el('td', { textContent: t('pm.total', { n: fmtInt(n) }) + (terms.length ? ' · ' + fmtNum(sumPct) + '%' : '') }),
    // No schedule: the contract value (or the purchase value) stands in the term column (feedback 25/09/2026).
    el('td', { className: 'num', textContent: terms.length ? fmtVnd(sumTerm) : value ? fmtVnd(value) : '',
               title: terms.length ? '' : t('pay.t.valueHint') }),
    el('td'),
    el('td', { className: 'num', textContent: fmtVnd(sumNet) }),
    el('td', { className: 'num', textContent: fmtVnd(sumGross) }),
    el('td', { className: 'num', textContent: value ? fmtPct(sumNet / value, 0) : '' }),
    el('td', { className: 'c', textContent: paid.length ? (invGross + 1 >= cumPaid ? '✓' : '✗') : '' })]));
  if (!terms.length) wrap.append(el('div', { className: 'sd', style: 'color:var(--dim);font-size:12px;margin-bottom:6px', textContent: t('pay.t.noCt') }));
  wrap.append(el('div', { className: 'wrap' }, tb));
}

/* -------------------------------------------- one project's money trail */
async function payProjectDetail(code, host, compact) {
  if (PAY.byCode && PAY.byCode.get(code)) MONEY.year = PAY.byCode.get(code).year;
  if (!PAY.byCode) await payLoadProjects();
  const [alloc, money] = await Promise.all([
    SB.select('pm_pay_alloc', `select=*&project_code=eq.${encodeURIComponent(code)}`),
    SB.select('pm_project_money', `select=*&project_code=eq.${encodeURIComponent(code)}`)
  ]);
  const m = money[0];
  const invIds = alloc.filter(a => a.kind === 'invoice').map(a => a.ref_id);
  const payIds = alloc.filter(a => a.kind === 'payment').map(a => a.ref_id);
  const [inv, pay] = await Promise.all([
    invIds.length ? SB.select('pm_invoice', `select=*&id=in.(${invIds.join(',')})&order=post_date`) : [],
    payIds.length ? SB.select('pm_payment', `select=*&id=in.(${payIds.join(',')})&order=post_date`) : []
  ]);
  const share = (kind, id) => Number((alloc.find(a => a.kind === kind && a.ref_id === id) || {}).share || 0);
  const p = PAY.byCode.get(code) || { code };
  const wrap = el('div', { className: compact ? '' : 'card' });
  wrap.append(el('h2', { style: compact ? 'margin-top:14px' : '', textContent: compact ? t('pay.h') : `${code} — ${p.name || ''}` }));
  if (compact) {
    // The project panel: one table by payment term, with a total row.
    await payTermTable(code, p, m, pay, share, wrap);
  } else if (!m || (!inv.length && !pay.length)) {
    wrap.append(el('div', { className: 'payempty', textContent: t('pay.noneProject') }));
  } else {
    const inv0 = Number(m.invoiced_net), vat0 = Number(m.invoiced_vat), paid0 = Number(m.paid_gross);
    const budget = p.main_code ? payBudget(p) : null;
    const stats = el('div', { className: 'stats' });
    const stat = (k, v, sub) => stats.append(el('div', { className: 'stat' }, [el('span', { className: 'sl', textContent: t(k) }),
      el('span', { className: 'sv', textContent: v }), el('span', { className: 'sd', textContent: sub || '' })]));
    stat('pay.c.net', fmtVnd(inv0), budget ? t('pay.ofBudget', { p: fmtPct(inv0 / budget, 0) }) : '');
    stat('pay.c.vat', fmtVnd(vat0));
    stat('pay.c.paid', fmtVnd(paid0), inv0 + vat0 ? t('pay.ofInvoiced', { p: fmtPct(paid0 / (inv0 + vat0), 0) }) : '');
    stat('pay.c.payable', fmtVnd(inv0 + vat0 - paid0), inv0 + vat0 - paid0 < -1 ? t('pay.advance') : '');
    wrap.append(stats);
    const tb = el('table', { className: 'paytrail' });
    tb.append(el('tr', {}, [['pay.c.date'], ['pay.c.kind'], ['pay.c.doc'], ['pay.c.party'], ['pay.c.net', 'num'],
      ['pay.c.vat', 'num'], ['pay.c.paid', 'num'], ['%', 'num']].map(([k, c]) => el('th', { className: c || '', textContent: k === '%' ? '%' : t(k) }))));
    const ev = [...inv.map(r => ['invoice', r]), ...pay.map(r => ['payment', r])]
      .sort((a, b) => String(a[1].post_date).localeCompare(String(b[1].post_date)));
    for (const [kind, r] of ev) {
      const s = share(kind, r.id);
      tb.append(el('tr', { className: r.gone ? 'gone' : '' }, [
        el('td', { textContent: fmtDate(r.post_date) }), el('td', { textContent: t('pay.kind.' + kind) }),
        el('td', {}, el('code', { textContent: kind === 'invoice' ? r.invoice_no : r.voucher_no })),
        el('td', { className: 'wrapcell', textContent: kind === 'invoice' ? r.seller_name : (r.vendor_name || r.vendor_code) }),
        el('td', { className: 'num', textContent: kind === 'invoice' ? fmtVnd(Number(r.net) * s) : '' }),
        el('td', { className: 'num', textContent: kind === 'invoice' ? fmtVnd(Number(r.vat) * s) : '' }),
        el('td', { className: 'num', textContent: kind === 'payment' ? fmtVnd(Number(r.amount) * s) : '' }),
        el('td', { className: 'num', textContent: s < 1 ? fmtPct(s, 0) : '' })]));
    }
    wrap.append(el('div', { className: 'wrap' }, tb));
  }
  host.append(wrap);
}

function payExport() {
  const wb = XLSX.utils.book_new();
  const allocTxt = (kind, id) => payAllocOf(kind, id).map(a => a.project_code + (Number(a.share) < 1 ? ` ${Math.round(a.share * 100)}%` : '')).join('; ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(PAY.inv.map(r => ({
    [t('pay.c.date')]: r.post_date, [t('pay.c.invNo')]: r.invoice_no, [t('pay.c.series')]: r.series, MST: r.seller_tax,
    [t('pay.c.party')]: r.seller_name, [t('pay.c.net')]: Number(r.net), [t('pay.c.vat')]: Number(r.vat), [t('pay.c.rate')]: r.vat_rate,
    [t('pay.c.projects')]: allocTxt('invoice', r.id), [t('pay.c.status')]: t('pay.st.' + payStatus('invoice', r)), [t('pay.c.desc')]: r.description }))), 'Invoices');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(PAY.pay.map(r => ({
    [t('pay.c.date')]: r.post_date, [t('pay.c.voucher')]: r.voucher_no, [t('pay.c.vendor')]: r.vendor_code, [t('pay.c.party')]: r.vendor_name,
    [t('pay.c.paid')]: Number(r.amount), [t('pay.c.projects')]: allocTxt('payment', r.id),
    [t('pay.c.status')]: t('pay.st.' + payStatus('payment', r)), [t('pay.c.desc')]: r.description }))), 'Payments');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(PAY.money.filter(m => m.n_invoices || m.n_payments).map(m => {
    const p = PAY.byCode.get(m.project_code) || {};
    return { [t('pm.col.code')]: m.project_code, [t('pm.col.name')]: p.name, [t('pay.c.budget')]: p.main_code ? payBudget(p) : null,
             [t('pm.col.contract')]: p.contract_value != null ? Number(p.contract_value) : null,
             [t('pay.c.net')]: Number(m.invoiced_net), [t('pay.c.vat')]: Number(m.invoiced_vat), [t('pay.c.paid')]: Number(m.paid_gross),
             [t('pay.c.payable')]: Number(m.invoiced_gross) - Number(m.paid_gross) };
  })), 'By project');
  XLSX.writeFile(wb, `Payments ${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function initPay() {
  $('#btnPayRead').onclick = payRead;
  $('#btnPayGo').onclick = payGo;
  $('#btnPayExport').onclick = payExport;
  $('#btnPayAlloc').onclick = () => { const items = [...PAY.sel.values()]; if (items.length) payBulkEdit(items); };
  $('#payQ').oninput = () => payRenderBody(payCols(PAY.tab));   // keeps the cursor in the box
  $('#payYear').onchange = () => payRender();
  $('#paySt').onchange = () => payRender();
  // Project codes for the allocation editor's code boxes.
  const dl = el('datalist', { id: 'payProjList' });
  document.body.append(dl);
  PAY.fillList = () => { dl.innerHTML = ''; for (const p of PAY.projects) dl.append(el('option', { value: p.code, label: p.name || '' })); };
}

/* ================================================================ TABLET / PHONE
   Signing will be done on a tablet or a phone (user 26/09/2026). There only
   three things matter: the dashboard, the to-do list and the package waiting
   for a signature — no grids, no data entry. On: a touch screen (coarse
   pointer) or a narrow window; Settings can force it on or off, so it can be
   looked at on a PC as well.
   The package reads like paper: every page of every document of the package,
   one A4 page at a time, turned with a swipe. The page lifts from its bottom
   corner — the right one to go on, the left one to go back — and turns on its
   spine, gently; a tap near the edge turns it too. Under the page, the sign
   bar: approve / check (the signature pad takes a finger or a stylus), return,
   reject. After signing, straight back to the list for the next task. */
const TB_KEY = 'asset-intake.tablet';
const tbPref = () => { try { return localStorage.getItem(TB_KEY) || 'auto'; } catch { return 'auto'; } };
function tbDetect() {
  const p = tbPref();
  const on = p === 'on' || (p === 'auto' && (matchMedia('(pointer: coarse)').matches || innerWidth <= 820));
  const changed = on !== TB.on;
  TB.on = on;
  document.body.classList.toggle('tab', on);
  return changed;
}
function tbInit() {
  tbDetect();
  const sel = $('#stTab');
  if (sel) {
    sel.value = tbPref();
    sel.onchange = () => { try { localStorage.setItem(TB_KEY, sel.value); } catch {} tbApply(); };
  }
  let tm = null;
  window.addEventListener('resize', () => { clearTimeout(tm); tm = setTimeout(() => { if (tbDetect()) tbApply(); else if (TB.on && VIEW === 'doc' && TB.pages.length) tbShowPage(TB.i); }, 250); });
  document.addEventListener('keydown', e => {
    if (!TB.on || VIEW !== 'doc' || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName || '')) return;
    if (e.key === 'ArrowRight') tbFlip(1); else if (e.key === 'ArrowLeft') tbFlip(-1);
  });
}
// The mode changed (a turned device, the Settings switch): redraw the screen in the new mode.
function tbApply() {
  tbDetect();
  TB.key = null;
  if (ME) { showView(VIEW); wfBadge(); }          // the count differs between the two modes (wfInboxCount)
  tbBarRender();
}

/* The bar at the bottom of the screen: Dashboard · To-do (with its count) · Sign out. */
function tbBarRender() {
  let bar = $('#tbBar');
  if (!bar) { bar = el('nav', { id: 'tbBar', className: 'tbbar' }); document.body.append(bar); }
  bar.hidden = !TB.on || !ME;
  if (bar.hidden) return;
  bar.innerHTML = '';
  const item = (view, key, icon, n) => {
    const b = el('button', { className: 'tbitem' + (VIEW === view || (view === 'inbox' && VIEW === 'doc') ? ' on' : ''), type: 'button',
      onclick: () => showView(view) }, [el('span', { className: 'ic', textContent: icon }), el('span', { textContent: t(key) })]);
    if (n) b.append(el('span', { className: 'tag', textContent: String(n) }));
    return b;
  };
  if (canView('pmdash')) bar.append(item('pmdash', 'tb.dash', '▦'));
  if (canView('inbox')) bar.append(item('inbox', 'tb.todo', '✓', WF.badgeN));
  // A liquidation batch waiting for its physical count: counted walking round with the tablet.
  if (LQ.countN && canView('lqcount')) bar.append(item('lqcount', 'lc.tab', '☑', LQ.countN));
  // A periodic stock-take open: counted walking round with the tablet (assetops.js).
  if (window.AO && AO.sc.openN && canView('stockcount')) bar.append(item('stockcount', 'ao.sc.tab', '▣', AO.sc.openN));
  bar.append(item('flows', 'tb.flows', '⇄'));
  // Back to the full screens (a PC with a narrow or zoomed window turns tablet mode on by itself):
  // remembered in this browser; Settings → tablet / phone view → "Automatic" undoes it.
  bar.append(el('button', { className: 'tbitem', type: 'button', title: t('tb.fullHint'), onclick: () => {
    try { localStorage.setItem(TB_KEY, 'off'); } catch {}
    tbApply();
  } }, [el('span', { className: 'ic', textContent: '🖥' }), el('span', { textContent: t('tb.full') })]));
  bar.append(el('button', { className: 'tbitem', type: 'button', onclick: () => authSignOut() },
    [el('span', { className: 'ic', textContent: '⏻' }), el('span', { textContent: t('auth.signOut') })]));
}

/* The to-do list as cards: what to do, the documents, the project, the value. */
function tbInboxCards(rows) {
  let box = $('#wiCards');
  if (!box) { box = el('div', { id: 'wiCards', className: 'tbcards' }); $('#wiMsg').after(box); }
  box.innerHTML = '';
  const todo = rows.filter(r => r.kind !== 'done' && r.kind !== 'prepare');
  if (!todo.length) box.append(el('div', { className: 'tbempty', textContent: t('tb.nothing') }));
  for (const r of todo) {
    const owners = wfPkgTypes(r.grp).filter(ty => wfSide(ty) === 'owner').join('/');
    const band = ['returned', 'tfret'].includes(r.kind) ? 'bad' : ['photo', 'draft', 'tf'].includes(r.kind) ? 'op' : wfBand(r.role_code);
    const what = r.kind === 'tf' ? t('ao.tf.i.act') : r.kind === 'tfret' ? t('wf.i.returned') : r.kind === 'photo' ? t('ph.todo', { n: r.missing }) : r.kind === 'draft' ? t('lq.i.draft') : r.kind === 'returned' ? t('wf.i.returned')
      : r.owner_prep ? t(r.returned_to === 'am' ? 'wf.i.redoOwner' : 'wf.i.checkPrep', { t: owners })
      : t(r.step_kind === 'check' ? 'wf.i.check' : 'wf.i.approve');
    const c = el('button', { className: 'tbcard band-' + band, type: 'button', onclick: () => { if (r.tf_id) { TB.on && alert(t('ao.tf.onPc')); if (!TB.on) aoOpenTransfer(r.tf_id); } else if (r.doc_id) wfOpen(r.doc_id); } }, [
      el('div', { className: 'r1' }, [el('span', { className: 'stg band-' + band, textContent: what }),
        el('span', { className: 'when', textContent: r.submitted_at ? fmtDate(String(r.submitted_at).slice(0, 10)) : '' })]),
      el('div', { className: 'nos', textContent: String(r.doc_no || '').replace(/ \+ /g, ' · ') }),
      el('div', { className: 'pn', textContent: r.project_name || (r.grp === 'LR' ? t('lq.docName') : '') }),
      el('div', { className: 'r3' }, [el('span', { textContent: [r.project_code, pmDeptName(r.dept_code)].filter(Boolean).join(' · ') }),
        el('b', { textContent: r.total_value != null ? fmtMoney(r.total_value) : '' })])]);
    box.append(c);
  }
}

/* ------------------------------------------------------------- the reader */
function tbDocRender() {
  const box = $('#wdBody');
  box.innerHTML = '';
  const k = WF.pkg || {}, p = WF.project || {}, step = wfCurStep();
  const docs = WF.pdocs.slice().sort((a, b) => wfSeq(a.doc_type) - wfSeq(b.doc_type));
  $('#pageTitle').textContent = docs.map(d => d.doc_no).join(' · ');
  const back = el('button', { className: 'btn tbback', type: 'button', textContent: '‹ ' + t('tb.todo'), onclick: () => showView('inbox') });
  const head = el('div', { className: 'tbhead' }, [back,
    el('div', { className: 'tbt' }, [el('b', { textContent: p.name || '' }), el('small', { textContent: [p.code, pmDeptName(p.dept_code)].filter(Boolean).join(' · ') })]),
    wfChip(k.status)]);
  if (k.status === 'in_review' && step)
    head.append(el('div', { className: 'tbwho' }, [el('span', { className: 'stg band-' + wfBand(step.role_code),
      textContent: t('wf.waiting', { step: step.step, role: wfRoleName(step.role_code) }) })]));
  // Every page of every document of the package, drawn as on paper (built once per state of the package).
  const key = [k.id, k.version, k.status, k.current_step, LANG, docs.map(d => d.id + d.status).join()].join('|');
  if (TB.key !== key) {
    const keepDoc = WF.doc;
    TB.pages = [];
    for (const d of docs) {
      wfSetDoc(d.doc_type);
      WF.ref = null;
      try { for (const pg of fsPages(fsSheet(d.doc_type, false, 'print'))) TB.pages.push(Object.assign(pg, { doc: d })); } catch (e) { console.warn(e); }
    }
    WF.doc = keepDoc; WF.data = WF.drafts.get(keepDoc.id);
    TB.key = key; TB.i = 0;
  }
  const tabs = el('div', { className: 'tbtabs' }, docs.map(d => Object.assign(el('button', { className: 'tbtab', type: 'button',
    textContent: d.doc_type, title: d.doc_no, onclick: () => tbGo(TB.pages.findIndex(pg => pg.doc.id === d.id)) }), { _doc: d.id })));
  const count = el('span', { className: 'tbcount' });
  const stage = el('div', { className: 'tbstage' });
  box.append(head, el('div', { className: 'tbnavrow' }, [tabs, count]), stage, tbActs(step));
  const ph = phForPackage();                 // label photos, taken with the tablet's camera
  if (ph) box.append(ph);
  Object.assign(TB, { stage, tabs, count });
  tbSwipe(stage);
  requestAnimationFrame(() => tbShowPage(TB.i));
}

// The sign bar: what this person can do with the package now, or where it stands.
function tbActs(step) {
  const bar = el('div', { className: 'tbacts' });
  if (!wfCanActPkg()) {
    const k = WF.pkg || {};
    bar.append(el('div', { className: 'tbstate', textContent: k.status === 'in_review' && step
      ? t('wf.waiting', { step: step.step, role: wfRoleName(step.role_code) }) : t('wf.st.' + (k.status || 'draft')) }));
    return bar;
  }
  const note = el('textarea', { id: 'wdNote', placeholder: t('tb.notePh'), rows: 1 });
  const b = (key, cls, fn) => el('button', { className: 'btn ' + cls, type: 'button', textContent: t(key), onclick: fn });
  const amDone = WF.steps.some(s => s.owner_prep && s.step < step.step);
  const main = step.owner_prep ? 'wf.checkPrepBtn' : step.kind === 'check' ? 'wf.checkBtn' : WF.pdocs.length > 1 ? 'wf.approvePkg' : 'wf.approve';
  bar.append(note, el('div', { className: 'tbbtns' }, [
    b(amDone ? 'wf.returnOp' : 'wf.return', '', () => wfAct('return', 'operator')),
    ...(amDone ? [b('wf.returnAm', '', () => wfAct('return', 'am'))] : []),
    ...(step.kind !== 'check' ? [b('wf.reject', 'danger', () => wfAct('reject'))] : []),
    b(main, 'pri tbsign', () => wfAct('approve'))]));
  return bar;
}

// One page, scaled to the stage: the whole page on a tablet, the page's width on a phone (it then scrolls down).
function tbPageEl(i) {
  const pg = TB.pages[i];
  if (!pg) return null;
  const st = TB.stage, W = st.clientWidth - 16, H = st.clientHeight - 16;
  const bw = parseFloat(pg.box.style.width) || 733, bh = parseFloat(pg.box.style.height) || 1040;
  let s = W / bw;
  if (bh * s > H && W >= 600) s = Math.max(H / bh, 0.2);
  const inner = el('div', { className: 'tbpin', style: `width:${bw}px;height:${bh}px;transform:scale(${s})` }, pg.box);
  return el('div', { className: 'tbpage', style: `width:${Math.round(bw * s)}px;height:${Math.round(bh * s)}px` }, [inner, el('i', { className: 'tbshade' })]);
}
function tbShowPage(i) {
  if (!TB.stage || !TB.pages.length) return;
  TB.i = Math.max(0, Math.min(TB.pages.length - 1, i));
  TB.stage.innerHTML = '';
  const pgEl = tbPageEl(TB.i);
  pgEl.classList.add('cur');
  TB.stage.append(pgEl, el('button', { className: 'tbcorner l', type: 'button', title: t('tb.prev'), onclick: () => tbFlip(-1), hidden: TB.i === 0 }),
    el('button', { className: 'tbcorner r', type: 'button', title: t('tb.next'), onclick: () => tbFlip(1), hidden: TB.i === TB.pages.length - 1 }));
  TB.count.textContent = `${TB.i + 1} / ${TB.pages.length}`;
  const doc = TB.pages[TB.i].doc;
  for (const tb of TB.tabs.children) tb.classList.toggle('on', tb._doc === doc.id);
}
const tbGo = i => { if (i >= 0 && i !== TB.i) tbFlip(i > TB.i ? 1 : -1, i); };

/* The turn. Going on: the page on top turns on its left spine, 0° → −180°,
   its bottom-right corner leading, and the next page is under it. Going back:
   the previous page comes back over, −180° → 0°, its bottom-left corner
   leading. p (0..1) is how far the turn has gone. */
const TB_EASE = 'transform .6s cubic-bezier(.22,.7,.28,1), box-shadow .6s ease';
function tbPose(pageEl, dir, p) {
  const a = dir > 0 ? -180 * p : -180 * (1 - p);
  pageEl.style.transform = `rotateY(${a}deg) rotateZ(${a * 0.028}deg)`;
  pageEl.style.setProperty('--sh', String(Math.sin(Math.PI * Math.min(1, Math.abs(a) / 180)) * 0.5));
}
function tbStart(dir, to) {
  const target = to != null ? to : TB.i + dir;
  if (TB.busy || target < 0 || target >= TB.pages.length) return null;
  const cur = TB.stage.querySelector('.tbpage.cur');
  if (dir > 0) {
    const under = tbPageEl(target); under.classList.add('under');
    TB.stage.insertBefore(under, cur);
    cur.classList.add('turning', 'fwd');
    return { dir, target, moving: cur };
  }
  const over = tbPageEl(target); over.classList.add('turning', 'back');
  TB.stage.append(over);
  tbPose(over, -1, 0);
  return { dir, target, moving: over };
}
function tbFinish(f, commit) {
  if (!f) return;
  TB.busy = true;
  f.moving.style.transition = TB_EASE;
  requestAnimationFrame(() => tbPose(f.moving, f.dir, commit ? 1 : 0));
  let done = false;
  const end = () => { if (done) return; done = true; TB.busy = false; tbShowPage(commit ? f.target : TB.i); };
  f.moving.addEventListener('transitionend', end, { once: true });
  setTimeout(end, 800);                                   // in case the event never comes
}
function tbFlip(dir, to) { const f = tbStart(dir, to); if (f) tbFinish(f, true); }

// A finger (or the mouse) turns the page: it follows the finger, and is let go past a quarter of the page or with a flick.
function tbSwipe(stage) {
  let x0 = 0, y0 = 0, t0 = 0, f = null, dragging = false, id = null;
  stage.addEventListener('pointerdown', e => {
    if (TB.busy || e.button > 0 || e.target.closest('.tbcorner')) return;
    x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); f = null; dragging = false; id = e.pointerId;
  });
  stage.addEventListener('pointermove', e => {
    if (id !== e.pointerId || TB.busy) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return;     // a scroll down the page, not a turn
      f = tbStart(dx < 0 ? 1 : -1);
      if (!f) { id = null; return; }
      dragging = true;
      try { stage.setPointerCapture(e.pointerId); } catch {}
    }
    const W = stage.clientWidth;
    const p = Math.max(0, Math.min(1, (f.dir > 0 ? -dx : dx) / (W * 0.9)));
    f.moving.style.transition = 'none';
    tbPose(f.moving, f.dir, p);
  });
  const up = e => {
    if (id !== e.pointerId) return;
    id = null;
    if (!dragging || !f) return;
    const dx = e.clientX - x0, v = Math.abs(dx) / Math.max(1, performance.now() - t0);
    const go = (f.dir > 0 ? -dx : dx) > stage.clientWidth * 0.25 || (v > 0.6 && Math.sign(-dx) === f.dir);
    tbFinish(f, go);
    f = null; dragging = false;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
}

/* ============================================================ LABEL PHOTOS (AL → AH)
   After the labels of a delivery are received (AL approved), the department
   attaches them and takes two photos of each asset: the label close up, and
   the asset with the label in view (26_alr_project.sql). Two ways side by side
   while the cloud plan is decided (user 26/09/2026): the photo taken straight
   in the app (Supabase Storage, bucket "am-photo", shrunk in the browser to
   1600 px JPEG), or a link to the photo on OneDrive / SharePoint. The AH of
   those assets cannot be sent until every asset has both. */
const PH = { urls: new Map() };
const PH_KINDS = ['label', 'overall'];

async function phLoad(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 200)
    out.push(...await SB.select('am_asset_photo', `select=*&asset_id=in.(${ids.slice(i, i + 200).join(',')})&order=taken_at.desc`));
  return out;
}
// The assets of a list still missing a photo of one kind: their codes.
async function phGaps(assets) {
  const photos = await phLoad(assets.map(a => a.id));
  return assets.filter(a => PH_KINDS.some(k => !photos.some(p => p.asset_id === a.id && p.kind === k))).map(a => a.asset_code || '#' + a.id);
}
// A stored photo, fetched with the signed-in person's token (the bucket is private).
async function phUrl(path) {
  if (PH.urls.has(path)) return PH.urls.get(path);
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/authenticated/am-photo/${path.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  const u = URL.createObjectURL(await r.blob());
  PH.urls.set(path, u);
  return u;
}
// A camera photo is 3–12 MB: shrink to 1600 px on the long side, JPEG 0.82 (~300–600 KB).
function phShrink(file) {
  return new Promise((ok, no) => {
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u);
      c.toBlob(b => b ? ok(b) : no(new Error('image')), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(u); no(new Error(t('ph.badImage'))); };
    img.src = u;
  });
}
async function phUpload(asset, kind, file, docId) {
  const blob = await phShrink(file);
  const path = `${asset.id}/${kind}-${Date.now()}.jpg`;
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/am-photo/${path}`, { method: 'POST',
    headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok, 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body: blob });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
  await SB.insert('am_asset_photo', [{ asset_id: asset.id, kind, source: 'storage', storage_path: path, pm_doc_id: docId || null,
                                       taken_name: (ME && (ME.full_name || ME.email)) || null }]);
}
async function phAddLink(asset, kind, url, docId) {
  if (!/^https:\/\//i.test(url || '')) throw new Error(t('ph.badLink'));
  await SB.insert('am_asset_photo', [{ asset_id: asset.id, kind, source: 'link', url: url.trim(), pm_doc_id: docId || null,
                                       taken_name: (ME && (ME.full_name || ME.email)) || null }]);
}

/* The panel: one row per asset, two boxes (label · overall), each with the
   photo (or the link) and the buttons to take one / paste a link / remove. */
function phPanel(assets, docId, title) {
  const card = el('div', { className: 'card phcard' });
  const head = el('div', { className: 'chead' }, [el('h2', { textContent: title || t('ph.h') }), el('span', { className: 'phprog' })]);
  const body = el('div', { className: 'phlist', textContent: t('table.loading') });
  const out = el('div');
  card.append(head, el('div', { className: 'tdnote', textContent: t('ph.hint') }), out, body);
  const draw = async () => {
    let photos = [];
    try { photos = await phLoad(assets.map(a => a.id)); } catch (e) { body.textContent = ''; return msg(out, 'err', /am_asset_photo|PGRST205|404/.test(e.message) ? t('ph.notInstalled') : e.message); }
    body.innerHTML = '';
    let done = 0;
    for (const a of assets) {
      const mine = k => photos.filter(p => p.asset_id === a.id && p.kind === k);
      if (PH_KINDS.every(k => mine(k).length)) done++;
      const row = el('div', { className: 'phrow' + (PH_KINDS.every(k => mine(k).length) ? ' ok' : '') }, [
        el('div', { className: 'phwho' }, [el('code', { textContent: a.asset_code || '' }), el('small', { textContent: `${a.barcode || ''} · ${a.name || ''}` })])]);
      for (const k of PH_KINDS) {
        const box = el('div', { className: 'phbox' }, [el('span', { className: 'phk', textContent: t('ph.k.' + k) })]);
        const list = mine(k);
        const shot = el('div', { className: 'phshot' });
        if (list.length) {
          const p = list[0];
          if (p.source === 'storage') {
            const img = el('img', { alt: t('ph.k.' + k) });
            phUrl(p.storage_path).then(u => { img.src = u; img.onclick = () => window.open(u, '_blank'); }).catch(() => { img.alt = '⚠'; });
            shot.append(img);
          } else shot.append(el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', className: 'phlink', textContent: '🔗 ' + t('ph.linkOpen') }));
          const del = el('button', { className: 'xbtn', type: 'button', textContent: '×', title: t('ph.remove'), onclick: async () => {
            if (!confirm(t('ph.removeQ'))) return;
            try { await SB.remove('am_asset_photo', `id=eq.${p.id}`); draw(); } catch (e) { msg(out, 'err', e.message); } } });
          shot.append(del);
        } else shot.append(el('span', { className: 'phnone', textContent: '—' }));
        const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
        file.setAttribute('capture', 'environment');        // straight to the camera on a phone / tablet
        file.onchange = async () => {
          if (!file.files[0]) return;
          msg(out, 'info', t('ph.uploading'));
          try { await phUpload(a, k, file.files[0], docId); msg(out, '', ''); draw(); } catch (e) { msg(out, 'err', e.message); }
        };
        box.append(shot, el('div', { className: 'phbtns' }, [file,
          el('button', { className: 'btn tiny', type: 'button', textContent: '📷 ' + t('ph.take'), onclick: () => file.click() }),
          el('button', { className: 'btn tiny', type: 'button', textContent: '🔗 ' + t('ph.link'), onclick: async () => {
            const u = prompt(t('ph.linkQ'));
            if (!u) return;
            try { await phAddLink(a, k, u, docId); draw(); } catch (e) { msg(out, 'err', e.message); } } })]));
        row.append(box);
      }
      body.append(row);
    }
    head.querySelector('.phprog').textContent = t('ph.progress', { n: done, of: assets.length });
    head.querySelector('.phprog').className = 'phprog' + (done === assets.length ? ' ok' : '');
  };
  draw();
  return card;
}

/* On the document screen: the label receipt once received (AL approved), and
   the handover of those assets while it is being drawn up (AH with asset_ids). */
function phForPackage() {
  const lr = WF.pdocs.find(d => d.doc_type === 'LR');
  if (lr) return lqPhotoPanel(lr);                  // condition photos of a liquidation request
  const al = WF.pdocs.find(d => d.doc_type === 'AL' && d.status === 'approved');
  if (al) { const data = WF.drafts.get(al.id) || al.data || {}; return phPanel(data.assets || [], al.id, t('ph.h')); }
  const ah = WF.pdocs.find(d => d.doc_type === 'AH' && ['draft', 'returned'].includes(d.status));
  const ids = ah && ((WF.drafts.get(ah.id) || ah.data || {}).asset_ids || []);
  if (!ids || !ids.length) return null;
  const card = el('div');
  (async () => {
    try {
      const assets = [];
      for (let i = 0; i < ids.length; i += 200)
        assets.push(...(await SB.select('am_asset', `select=id,asset_code,barcode,name_vi,name_en&id=in.(${ids.slice(i, i + 200).join(',')})&order=asset_code`))
          .map(a => ({ id: a.id, asset_code: a.asset_code, barcode: a.barcode, name: [a.name_vi, a.name_en].filter(Boolean).join('/') })));
      card.replaceWith(phPanel(assets, ah.id, t('ph.hAh')));
    } catch (e) { card.textContent = e.message; }
  })();
  return card;
}

// "Print the labels": the label screen, loaded with exactly the assets of this AL.
async function alPrintLabels(alDoc) {
  const data = WF.drafts.get(alDoc.id) || alDoc.data || {};
  const ids = data.asset_ids || [];
  if (!ids.length) return;
  showView('alr');
  try {
    await fillAlrPickers();
    $('#alProject').value = WF.project.code || '';
    $('#alCode').value = alDoc.doc_no;
    const rows = [];
    for (let i = 0; i < ids.length; i += 200) rows.push(...await SB.select('am_asset', `select=*&id=in.(${ids.slice(i, i + 200).join(',')})&order=asset_code`));
    const locs = await lookup('am_location').catch(() => []);
    const lmap = new Map(locs.map(l => [l.v, l.t]));
    ALR.rows = rows.map(r => ({ ...r, _pick: true, location_name: (lmap.get(r.location_code) || '').split(' — ')[1] || '' }));
    ALR.demo = false;
    msg('#alListMsg', 'ok', t('al.loadedFor', { n: rows.length, no: alDoc.doc_no }));
    renderAlrList();
  } catch (e) { msg('#alListMsg', 'err', e.message); }
}

/* ============================================================ LIQUIDATION — phase 1
   The liquidation request (LR) and the pool of what waits for the council
   (27_liquidation.sql). Decisions of 26/09/2026:
   - the LR and the Asset Disposal Form are ONE document: typed once, printed
     as both sheets (the LR landscape, then the Disposal Form);
   - its chain is the LR's signature line with the AM team checking before the
     Chief Accountant (Chuỗi phê duyệt → LR);
   - original value and depreciation are typed by hand for now (the monthly
     depreciation file from accounting comes later);
   - fixed assets and tools (same-barcode assets) go the same way.
   An LR is a package of its own, tied to a DEPARTMENT instead of a project,
   so it travels through the same chain / signature / to-do / tablet screens
   as the project documents. Once approved its lines are in the pool (8 / 24);
   phase 2 takes them from there into a council batch. */
const LQ = { tab: 'lr', stv: { lr: '', pool: 'pool' }, docs: [], pkgs: new Map(), steps: new Map(), items: null, orphans: [], sel: new Set(), ph: new Map(), phDraw: null };
const LQ_COND = [['Like new', 'Nguyên phẩm'], ['Poor', 'Kém phẩm'], ['Damaged', 'Mất phẩm']];
const LQ_MODE = [['Sale', 'Bán thanh lý'], ['Other', 'Khác (huỷ, tiêu huỷ…)']];
const LQ_REASONS = ['High repair cost / Chi phí sửa chữa cao', 'Obsolete / Lỗi thời', 'Irreparable / Hư hỏng không thể sửa chữa',
                    'Breakage/loss / Hư hỏng, mất mát', 'No longer suitable / Không còn phù hợp'];
const lqBi = (list, v) => { const r = list.find(x => x[0] === v); return r ? `${r[0]}/${r[1]}` : (v || ''); };
const lqKey = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// The package of an LR has no project: the screens get a stand-in carrying its department.
const lqProject = d => ({ code: '', name: t('lq.docName'), dept_code: d.dept_code || (d.data || {}).dept_code, _lq: true });
const lqNoType = no => { const p = String(no || '').split('.')[0]; return (WF.types.find(x => x.prefix === p && x.code !== p) || {}).code || p; };

function lqLists() {
  if (document.getElementById('lqReasonList')) return;
  const dl = el('datalist', { id: 'lqReasonList' });
  for (const r of LQ_REASONS) dl.append(el('option', { value: r }));
  document.body.append(dl);
}
const lqIn = (x, l, k, ty, ro) => wfInput({ k, t: ty, ro: !!ro }, l, x.edit, x.rr, []);
function lqSel(x, l, k, list) {
  if (!x.edit) return fsR(lqBi(list, l[k]));
  const s = el('select');
  s.append(el('option', { value: '', textContent: '—' }));
  for (const [v, vi] of list) s.append(el('option', { value: v, textContent: `${v} / ${vi}` }));
  s.value = l[k] || '';
  s.onchange = () => { l[k] = s.value || null; x.rr(); };
  return s;
}
function lqReason(x, l) {
  if (!x.edit) return fsR(l.reason);
  lqLists();
  const i = el('input', { value: l.reason || '', spellcheck: false });
  i.setAttribute('list', 'lqReasonList');
  i.onchange = () => { l.reason = i.value.trim() || null; x.rr(); };
  return i;
}

/* Asset code: the register, searched as you type (the LR's department first).
   A code or a barcode fills the line from the register; empty = an item not in
   the register (e.g. an old roof, by the square metre), typed by hand. */
function lqPickAsset(x, l) {
  if (!x.edit) return fsR(l.asset_code || (l.name ? 'N/A' : ''));
  const i = el('input', { value: l.asset_code || '', spellcheck: false, placeholder: t('lq.codePh') });
  i.setAttribute('list', 'wfAssetList');
  let tmr = null;
  i.oninput = () => { clearTimeout(tmr); const q = i.value.trim(); if (q.length >= 3) tmr = setTimeout(() => wfAssetSearch(q).catch(() => {}), 250); };
  i.onchange = async () => {
    const code = i.value.trim().toUpperCase();
    if (!code) { Object.assign(l, { asset_id: null, asset_code: null, barcode: null, kind: null }); return x.rr(); }
    try { await lqAssetFill(l, code, x.d); } catch (e) { msg('#wdMsg', 'err', e.message); }
    x.rr();
  };
  return i;
}
async function lqAssetFill(l, code, d) {
  const q = encodeURIComponent(`"${code.replace(/"/g, '')}"`);
  const [a] = await lqFinSelect('id,asset_code,barcode,name_vi,name_en,unit_code,unit_price,qty,dept_code,location_code,in_use_date,purchase_date,asset_kind,status_code',
    `&or=(asset_code.eq.${q},barcode.eq.${q})&limit=1`);
  if (!a) { msg('#wdMsg', 'warn', t('wf.assetNone', { code })); return; }
  if ((d.lines || []).some(o => o !== l && o.asset_id === a.id)) { msg('#wdMsg', 'warn', t('lq.twice', { code: a.asset_code })); return; }
  msg('#wdMsg', ['7', '9'].includes(String(a.status_code)) ? 'warn' : '', ['7', '9'].includes(String(a.status_code))
    ? t('lq.gone', { code: a.asset_code, st: amStatusLabel(a.status_code) }) : '');
  const qty = a.asset_kind === 'unique' ? 1 : (n0(l.qty) || n0(a.qty) || 1);
  Object.assign(l, { asset_id: a.id, asset_code: a.asset_code, barcode: a.barcode, name: [a.name_vi, a.name_en].filter(Boolean).join('/'),
    unit: a.unit_code || l.unit || null, qty, dept_code: a.dept_code, location: a.location_code, kind: a.asset_kind,
    in_use_date: a.in_use_date || a.purchase_date || l.in_use_date || null,
    unit_price: a.unit_price != null ? Number(a.unit_price) : null, orig_manual: false });
  delete l.fin_as_of; delete l.fin_u;
  lqFin(l, a);
  await lqEnrich([l]);
}
// Repairs so far (incidents) and the warranty, once 31_asset_ops.sql has run; left as typed otherwise.
async function lqEnrich(lines) {
  const ids = [...new Set(lines.map(l => l.asset_id).filter(Boolean))];
  if (!ids.length) return;
  try {
    const [inc, ws] = await Promise.all([SB.select('am_incident', `select=asset_id&asset_id=in.(${ids.join(',')})&kind=in.(repair,breakage)&status=neq.cancelled`),
                                         SB.select('am_asset', `select=id,warranty_until&id=in.(${ids.join(',')})`)]);
    for (const l of lines) {
      const n = inc.filter(i => i.asset_id === l.asset_id).length, w = ws.find(x => x.id === l.asset_id);
      if (n) l.repairs = n;
      if (w && w.warranty_until) l.warranty = w.warranty_until;
    }
  } catch {}
}
/* Once accounting has booked the asset (sql/30), the LR takes cost, accumulated
   depreciation and NBV from the books — scaled to the quantity liquidated —
   instead of the provisional unit price. Before sql/30 the columns don't exist,
   so the select falls back to the plain one. */
function lqFinSelect(cols, where, sel = (tb, q) => SB.select(tb, q)) {
  return sel('am_asset', `select=${cols},fin_status,fin_cost,fin_nbv,fin_as_of${where}`)
    .catch(() => sel('am_asset', `select=${cols}${where}`));
}
function lqFin(l, a) {
  if (a.fin_status !== 'booked' || a.fin_cost == null) return l;
  const n = a.asset_kind === 'unique' ? 1 : (n0(a.qty) || 1);
  const cost = Number(a.fin_cost), nbv = a.fin_nbv != null ? Number(a.fin_nbv) : cost;
  // Per unit, so derive() rescales when the quantity liquidated changes.
  return Object.assign(l, { fin_u: { c: cost / n, d: (cost - nbv) / n }, fin_as_of: a.fin_as_of || '' });
}
// A register row as an LR line (the orphans of status 8 / 24).
const lqLineOf = a => {
  const qty = a.asset_kind === 'unique' ? 1 : (n0(a.qty) || 1);
  return lqFin({ key: lqKey(), asset_id: a.id, asset_code: a.asset_code, barcode: a.barcode, name: [a.name_vi, a.name_en].filter(Boolean).join('/'),
           unit: a.unit_code || null, qty, dept_code: a.dept_code, location: a.location_code, kind: a.asset_kind,
           in_use_date: a.in_use_date || a.purchase_date || null, mode: 'Sale',
           unit_price: a.unit_price != null ? Number(a.unit_price) : null }, a);
};

/* The two sheets. Page 1: the LR, where everything is typed. Page 2: the Asset
   Disposal Form, drawn from the same lines (read-only), with the condition
   photo of each line in its Picture column. */
WF_FORMS.LR = { orient: 'landscape', wide: true, title: ['Liquidation Request', 'Đề xuất thanh lý tài sản'],
  derive(d) {
    d.lines = d.lines || [];
    let o = 0, dp = 0, q = 0;
    d.lines.forEach((l, i) => {
      if (!l.key) l.key = String(i + 1);             // the pool keys an unkeyed line by its number too
      // From the register: unit price × quantity, until the preparer types the original value themselves.
      // Booked by accounting: cost and accumulated depreciation from the books instead.
      if (l.fin_u && !l.orig_manual) { l.original_value = Math.round(l.fin_u.c * n0(l.qty)); l.depreciation = Math.round(l.fin_u.d * n0(l.qty)); }
      else if (l.unit_price != null && !l.orig_manual) l.original_value = Math.round(Number(l.unit_price) * n0(l.qty));
      const has = l.original_value != null || l.depreciation != null;
      l.nbv = has ? n0(l.original_value) - n0(l.depreciation) : null;
      o += n0(l.original_value); dp += n0(l.depreciation); q += n0(l.qty);
    });
    Object.assign(d, { total_qty: q, total_original: o, total_dep: dp, total_nbv: o - dp, total: o || null });
  },
  build(x) {
    if (x.edit && x.mode === 'screen' && LQ.phDraw) LQ.phDraw();     // lines added / taken away: the photo list follows
    return [lqSheetLR(x), lqSheetDisposal(x)];
  } };

function lqSheetLR(x) {
  const d = x.d, k = WF.pkg || {};
  const cols = [
    { h: 'Item code / Mã TS', w: '9.5%', left: true, cell: l => lqPickAsset(x, l) },
    { h: 'Item name / Tên tài sản', w: '13%', left: true, cell: l => l.asset_id || !x.edit ? fsR(l.name) : lqIn(x, l, 'name', 'text') },
    { h: 'Qty / SL', w: '3.5%', cell: l => lqIn(x, l, 'qty', 'num', l.kind === 'unique') },
    { h: 'Unit / ĐVT', w: '4%', cell: l => wfPickUnit(x, l) },
    { h: 'Dept / BP', w: '4.5%', get: l => l.dept_code || d.dept_code, t: 'text' },
    { h: 'Used from / Bắt đầu SD', w: '6%', cell: l => lqIn(x, l, 'in_use_date', 'date') },
    { h: 'Warranty / Hạn BH', w: '5.5%', cell: l => lqIn(x, l, 'warranty', 'date') },
    { h: 'Repairs / Số lần SC', w: '3.5%', cell: l => lqIn(x, l, 'repairs', 'num') },
    { h: 'Condition / Hiện trạng', w: '6.5%', cell: l => lqSel(x, l, 'condition', LQ_COND) },
    { h: 'Reason / Lý do', w: '8.5%', left: true, cell: l => lqReason(x, l) },
    { h: 'Method / Đề xuất', w: '5.5%', cell: l => lqSel(x, l, 'mode', LQ_MODE) },
    { h: 'Original value / Nguyên giá', w: '7%', cell: l => { const i = lqIn(x, l, 'original_value', 'money'); i.addEventListener('input', () => { l.orig_manual = true; }); return i; } },
    { h: 'Depreciation / Hao mòn', w: '7%', cell: l => { const i = lqIn(x, l, 'depreciation', 'money'); i.addEventListener('input', () => { if (l.fin_u) l.orig_manual = true; }); return i; } },
    { h: 'Residual / Giá trị còn lại', get: l => l.nbv, t: 'money', w: '7%' },
    { h: 'Notes / Ghi chú', k: 'notes', t: 'text', w: '4.5%', left: true }];
  const src = d.project_code ? `${d.rr_doc_no || 'RR'} · ${d.project_code}` : 'Department request / Bộ phận đề xuất';
  return fsPage([
    fsHead(x, 'DATE', I(x, d, 'date', 'date')),
    fsBar('GENERAL INFORMATION / THÔNG TIN CHUNG'),
    fsGrid([fc('DEPARTMENT / BỘ PHẬN', fsR(`${d.dept_code || x.p.dept_code || ''} — ${pmDeptName(d.dept_code || x.p.dept_code)}`), 4, 'fit'),
            fc('TO / KÍNH GỬI', fsR('Board of General Directors — Owner\'s Representative Office / Ban Tổng Giám đốc — Văn phòng đại diện chủ đầu tư'), 8, 'fit'),
            fc('INITIATING PERSON / NGƯỜI LẬP', fsR(k.created_name || k.created_email || (ME && (ME.full_name || ME.email)) || ''), 4, 'fit'),
            fc('POSITION / CHỨC VỤ', I(x, d, 'position', 'text'), 4),
            fc('SOURCE / NGUỒN', fsR(src), 4, 'fit'),
            fc('CURRENT CONDITION & REASON FOR LIQUIDATION / HIỆN TRẠNG VÀ LÝ DO ĐỀ NGHỊ THANH LÝ', I(x, d, 'reason', 'area'), 12, 'tall left')]),
    fsBar('ITEMS TO BE LIQUIDATED / TÀI SẢN ĐỀ NGHỊ THANH LÝ', t('lq.count', { n: fmtInt(d.lines.length) })),
    fsTable(x, cols, d.lines, { add: () => ({ key: lqKey(), qty: null, mode: 'Sale', dept_code: d.dept_code }),
      foot: [['Total / Tổng cộng', 2, { 2: [d.total_qty, 'num'], 11: [d.total_original, 'money'], 12: [d.total_dep, 'money'], 13: [d.total_nbv, 'money'] }]] }),
    ...lqExplain(x),
    fsNote('Current condition / Hiện trạng: Like new / Nguyên phẩm — shape and function as originally described · Poor / Kém phẩm — one or more defects, still usable · '
      + 'Damaged / Mất phẩm — no longer usable. A photo of every item is attached (condition photos in the app).'),
    fsLinks(x, 'ATTACHMENTS / TÀI LIỆU ĐÍNH KÈM'),
    fsConsent(x, 'Consent by / Ký duyệt:')], 'land');
}

// What the Disposal Form asks to be explained: (**) a remaining book value, (***) an item that cannot be sold.
function lqExplain(x) {
  const d = x.d, rows = [];
  d.lines.forEach((l, i) => {
    const tag = `${i + 1}. ${l.asset_code || 'N/A'} — ${l.name || ''}`;
    if (n0(l.nbv) > 0 && (x.edit || l.nbv_note)) rows.push(fc(`(**) ${tag}: remaining book value / giải trình giá trị còn lại`, lqIn(x, l, 'nbv_note', 'area'), 6, 'left'));
    if (l.mode === 'Other' && (x.edit || l.other_note)) rows.push(fc(`(***) ${tag}: why it cannot be sold / lý do không bán được`, lqIn(x, l, 'other_note', 'area'), 6, 'left'));
  });
  return rows.length ? [fsBar('EXPLANATIONS / GIẢI TRÌNH'), fsGrid(rows)] : [];
}

function lqThumb(doc, l) {
  const p = LQ.ph.get(doc.id + ':' + l.key);
  if (!p) return fsR('—');
  if (p.img) return el('img', { className: 'lqthumb', src: p.img, alt: '' });
  return el('span', { className: 'wfro', textContent: '🔗 OneDrive' });
}
function lqSheetDisposal(x) {
  const d = x.d, k = WF.pkg || {}, doc = WF.doc;
  const y = Object.assign({}, x, { edit: false, form: Object.assign({}, x.form, { title: ['Asset Disposal Form', 'Đề nghị xử lý tài sản'] }) });
  const sale = d.lines.filter(l => l.mode !== 'Other'), other = d.lines.filter(l => l.mode === 'Other');
  const cols = [{ h: 'Asset Code', get: l => l.asset_code || 'N/A', w: '13%', left: true }, { h: 'Qty', get: l => l.qty, t: 'num', w: '5%' },
    { h: 'Description', get: l => l.name, w: '20%', left: true }, { h: 'Condition (*)', get: l => lqBi(LQ_COND, l.condition), w: '9%' },
    { h: 'Dept', get: l => l.dept_code || d.dept_code, w: '5%' }, { h: 'Location', get: l => l.location, w: '8%' },
    { h: 'Initial use', get: l => l.in_use_date, t: 'date', w: '7.5%' }, { h: 'Net book value (**)', get: l => l.nbv, t: 'money', w: '9%' },
    { h: 'Mode of disposal (***)', get: l => l.mode === 'Other' ? '3' : '1', w: '7%' }, { h: 'Picture', cell: l => lqThumb(doc, l), w: '11.5%' }];
  const saleCols = [{ h: 'Asset Code', get: l => l.asset_code || 'N/A', w: '14%', left: true }, { h: 'Qty', get: l => l.qty, t: 'num', w: '5%' },
    { h: 'Description', get: l => l.name, w: '22%', left: true }, { h: 'Unit price (VND)', get: l => l.sale_price, t: 'money', w: '10%' },
    { h: 'Total price (VND)', get: l => l.sale_price != null ? n0(l.sale_price) * n0(l.qty) : null, t: 'money', w: '10%' },
    { h: 'Net book value', get: l => l.nbv, t: 'money', w: '10%' }, { h: 'Buyer — Name', get: l => l.buyer, w: '14%', left: true },
    { h: 'Buyer — ID / Tax code', get: l => l.buyer_id, w: '10%' }];
  const otherCols = [{ h: 'Asset Code', get: l => l.asset_code || 'N/A', w: '16%', left: true }, { h: 'Qty', get: l => l.qty, t: 'num', w: '6%' },
    { h: 'Description', get: l => l.name, w: '28%', left: true }, { h: 'Submission comments', get: l => l.other_note, w: '45%', left: true }];
  const nbvRows = d.lines.map((l, i) => [l, i]).filter(([l]) => n0(l.nbv) > 0);
  return fsPage([
    fsHead(y, 'DATE', fsR(d.date, 'date')),
    fsBar('1. INITIATING PERSON'),
    fsGrid([fc('NAME', fsR(k.created_name || k.created_email || ''), 4, 'fit'),
            fc('DIVISION / DEPARTMENT / POSITION', fsR([pmDeptName(d.dept_code || x.p.dept_code), d.position].filter(Boolean).join(' · ')), 8, 'fit')]),
    fsBar('2. PROPERTY TO BE DISPOSED', d.project_code || ''),
    fsTable(y, cols, d.lines, { noDel: true }),
    fsNote('(*) Please attach the photos as evidence of asset condition.   (**) Please explain for the asset which still has net book value (uncompleted depreciation / allocation).   '
      + '(***) 1 = Sale · 2 = Department transfer · 3 = Other situation.'),
    fsBar('SALES', t('lq.saleLater')),
    fsTable(y, saleCols, sale, { noDel: true }),
    fsBar('DEPARTMENT TRANSFER'),
    fsNote('Not through liquidation: a transfer between departments is done in the asset register (bulk edit → department), which re-codes and re-labels the asset.'),
    ...(other.length ? [fsBar('OTHER SITUATION'), fsTable(y, otherCols, other, { noDel: true }),
                        fsNote('Please explain why the asset can not be sold, neither can the asset be transferred.')] : []),
    ...(nbvRows.length ? [fsBar('(**) NET BOOK VALUE EXPLANATION'),
                          fsGrid(nbvRows.map(([l, i]) => fc(`${i + 1}. ${l.asset_code || 'N/A'} — ${l.name || ''}`, fsR(l.nbv_note || ''), 6, 'left')))] : []),
    lqConsent3(y)], 'land');
}
// The Disposal Form's three boxes: prepared by, checked by accounting (Chief Accountant), approved by the PHCL GM.
function lqConsent3(x) {
  const k = WF.pkg || {}, st = role => (WF.steps || []).find(s => s.role_code === role && s.status === 'approved');
  const box = (lbl, title, sig, name, at) => el('div', { className: 'fsig' }, [
    el('div', { className: 'sk', textContent: lbl }), el('div', { className: 'sr', textContent: title[0] }), el('div', { className: 'ss', textContent: title[1] || ' ' }),
    el('div', { className: 'simg' }, sigPng(sig) ? el('img', { src: sigPng(sig), alt: '' }) : ''),
    el('div', { className: 'sn', textContent: name || ' ' }), el('div', { className: 'sd', textContent: at ? fmtDate(String(at).slice(0, 10)) : ' ' })]);
  const ca = st('CHIEF_ACC'), gm = st('JVC_GM');
  const prep = (wfChain(pmEntity(x.p.dept_code), 'LR').find(c => c.step === 0) || {}).role_code;
  return el('div', { className: 'fconsent' }, [el('div', { className: 'fct', textContent: 'Consent by:' }),
    el('div', { className: 'fsigs', style: 'grid-template-columns:repeat(3,calc((100% - 24px) / 4));justify-content:center' }, [
      box('Prepared by', prep ? wfSigTitle(prep) : ['', ''], k.prep_signature, k.submitted_at ? (k.created_name || k.created_email) : '', k.submitted_at),
      box('Checked by Accounting Dept', ['Chief Accountant', 'Kế toán trưởng'], ca && ca.signature, ca && (ca.acted_name || ca.acted_email), ca && ca.acted_at),
      box('Approved by PHCL GM', ['General Manager', 'Tổng Giám đốc'], gm && gm.signature, gm && (gm.acted_name || gm.acted_email), gm && gm.acted_at)])]);
}

/* ------------------------------------------------ condition photos of an LR
   One photo at least per line (the Disposal Form's evidence), taken on the
   phone / tablet or pasted as a OneDrive link — same two ways as the label
   photos. Kept by document + line, so a line without an asset code has them too. */
async function lqPhotoRows(docIds) {
  if (!docIds.length) return [];
  return SB.select('am_asset_photo', `select=*&pm_doc_id=in.(${docIds.join(',')})&kind=eq.condition&order=taken_at.desc`);
}
// The first photo of every line, ready for the Picture column (stored ones fetched with the person's token).
async function lqPhotosLoad(docs) {
  const lr = docs.filter(d => d.doc_type === 'LR');
  if (!lr.length) return;
  let rows = [];
  try { rows = await lqPhotoRows(lr.map(d => d.id)); } catch { return; }
  for (const d of lr) for (const [k] of LQ.ph) if (k.startsWith(d.id + ':')) LQ.ph.delete(k);
  for (const r of rows.slice().reverse()) {             // oldest first, so the newest wins
    const key = r.pm_doc_id + ':' + r.line_key;
    if (r.source === 'link') { LQ.ph.set(key, { link: r.url }); continue; }
    try { LQ.ph.set(key, { img: await phUrl(r.storage_path) }); } catch {}
  }
}
async function lqPhotoGaps(doc) {
  const data = WF.drafts.get(doc.id) || doc.data || {};
  const rows = await lqPhotoRows([doc.id]);
  return (data.lines || []).map((l, i) => [l, i]).filter(([l]) => !rows.some(r => r.line_key === l.key))
    .map(([l, i]) => `${i + 1} (${l.asset_code || l.name || '?'})`);
}
async function lqPhotoAdd(doc, l, file, url) {
  const base = { asset_id: l.asset_id || null, kind: 'condition', pm_doc_id: doc.id, line_key: l.key, taken_name: (ME && (ME.full_name || ME.email)) || null };
  if (url != null) {
    if (!/^https:\/\//i.test(url.trim())) throw new Error(t('ph.badLink'));
    return SB.insert('am_asset_photo', [Object.assign(base, { source: 'link', url: url.trim() })]);
  }
  const blob = await phShrink(file);
  const path = `lr/${doc.id}/${String(l.key).replace(/[^\w-]/g, '')}-${Date.now()}.jpg`;
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/am-photo/${path}`, { method: 'POST',
    headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok, 'Content-Type': 'image/jpeg', 'x-upsert': 'false' }, body: blob });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
  return SB.insert('am_asset_photo', [Object.assign(base, { source: 'storage', storage_path: path })]);
}
function lqPhotoPanel(doc) {
  const card = el('div', { className: 'card phcard' });
  const head = el('div', { className: 'chead' }, [el('h2', { textContent: t('lq.ph.h') }), el('span', { className: 'phprog' })]);
  const body = el('div', { className: 'phlist', textContent: t('table.loading') });
  const out = el('div');
  card.append(head, el('div', { className: 'tdnote', textContent: t('lq.ph.hint') }), out, body);
  const open = !['approved', 'cancelled', 'rejected'].includes(doc.status);
  let last = '', tmr = null;
  const draw = async () => {
    const lines = ((WF.drafts.get(doc.id) || doc.data || {}).lines || []);
    last = lines.map(l => l.key).join('|');
    let rows = [];
    try { rows = await lqPhotoRows([doc.id]); } catch (e) { body.textContent = ''; return msg(out, 'err', /am_asset_photo|line_key|PGRST|404/.test(e.message) ? t('lq.notInstalled') : e.message); }
    body.innerHTML = '';
    let done = 0;
    if (!lines.length) body.append(el('div', { className: 'phnone', textContent: t('lq.ph.noLines') }));
    lines.forEach((l, i) => {
      const mine = rows.filter(r => r.line_key === l.key);
      if (mine.length) done++;
      const shot = el('div', { className: 'phshot' });
      if (mine.length) {
        const p = mine[0];
        if (p.source === 'storage') {
          const img = el('img', { alt: '' });
          phUrl(p.storage_path).then(u => { img.src = u; img.onclick = () => window.open(u, '_blank'); LQ.ph.set(doc.id + ':' + l.key, { img: u }); }).catch(() => { img.alt = '⚠'; });
          shot.append(img);
        } else { shot.append(el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', className: 'phlink', textContent: '🔗 ' + t('ph.linkOpen') }));
                 LQ.ph.set(doc.id + ':' + l.key, { link: p.url }); }
        if (mine.length > 1) shot.append(el('span', { className: 'phmore', textContent: '+' + (mine.length - 1) }));
        shot.append(el('button', { className: 'xbtn', type: 'button', textContent: '×', title: t('ph.remove'), onclick: async () => {
          if (!confirm(t('ph.removeQ'))) return;
          try { await SB.remove('am_asset_photo', `id=eq.${p.id}`); LQ.ph.delete(doc.id + ':' + l.key); draw(); } catch (e) { msg(out, 'err', e.message); } } }));
      } else shot.append(el('span', { className: 'phnone', textContent: '—' }));
      const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
      file.setAttribute('capture', 'environment');
      file.onchange = async () => {
        if (!file.files[0]) return;
        msg(out, 'info', t('ph.uploading'));
        try { await lqPhotoAdd(doc, l, file.files[0]); msg(out, '', ''); draw(); } catch (e) { msg(out, 'err', e.message); }
      };
      const btns = open ? [file,
        el('button', { className: 'btn tiny', type: 'button', textContent: '📷 ' + t('ph.take'), onclick: () => file.click() }),
        el('button', { className: 'btn tiny', type: 'button', textContent: '🔗 ' + t('ph.link'), onclick: async () => {
          const u = prompt(t('ph.linkQ'));
          if (!u) return;
          try { await lqPhotoAdd(doc, l, null, u); draw(); } catch (e) { msg(out, 'err', e.message); } } })] : [];
      body.append(el('div', { className: 'phrow one' + (mine.length ? ' ok' : '') }, [
        el('div', { className: 'phwho' }, [el('code', { textContent: `${i + 1}. ${l.asset_code || 'N/A'}` }), el('small', { textContent: [l.name, lqBi(LQ_COND, l.condition)].filter(Boolean).join(' · ') })]),
        el('div', { className: 'phbox' }, [el('span', { className: 'phk', textContent: t('lq.ph.k') }), shot, el('div', { className: 'phbtns' }, btns)])]));
    });
    head.querySelector('.phprog').textContent = t('lq.ph.progress', { n: done, of: lines.length });
    head.querySelector('.phprog').className = 'phprog' + (lines.length && done === lines.length ? ' ok' : '');
  };
  // The sheet redraws on every change: follow it only when the lines themselves changed.
  LQ.phDraw = () => { clearTimeout(tmr); tmr = setTimeout(() => {
    if (!card.isConnected) return;
    const now = ((WF.drafts.get(doc.id) || doc.data || {}).lines || []).map(l => l.key).join('|');
    if (now !== last) draw();
  }, 400); };
  draw();
  return card;
}

/* ------------------------------------------------------------ the screen
   Three tabs: the requests (every LR this person may see), the pool (lines of
   approved LRs waiting for a council batch) and the assets already marked
   8 / 24 that no request holds yet (from before, or from a replacement
   project) — from there an LR is started with them in it. */
async function lqLoad() {
  const out = $('#lqMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await wfLookups(); await wfCatLoad();
    if (!WF.types.some(x => x.code === 'LR')) { LQ.docs = []; LQ.items = null; LQ.orphans = []; lqRender(); return msg(out, 'warn', t('lq.notInstalled')); }
    const [docs, items, marked] = await Promise.all([
      pmSelectAll('pm_doc', 'select=id,doc_no,status,dept_code,pkg_id,created_by,created_email,created_at,submitted_at,decided_at,total_value,data&doc_type=eq.LR&order=id.desc'),
      pmSelectAll('pm_lq_item', 'select=*&order=id').catch(() => null),
      can('assets', 'view') ? lqFinSelect('id,asset_code,barcode,name_vi,name_en,qty,unit_code,unit_price,dept_code,location_code,asset_kind,status_code,in_use_date,purchase_date',
        '&status_code=in.(8,24)&order=asset_code', pmSelectAll).catch(() => []) : []]);
    const pids = [...new Set(docs.map(d => d.pkg_id))];
    const pkgs = [], steps = [];
    for (let i = 0; i < pids.length; i += 150) {
      const ids = pids.slice(i, i + 150).join(',');
      pkgs.push(...await SB.select('pm_pkg', `select=id,status,current_step,created_name&id=in.(${ids})`));
      steps.push(...await SB.select('pm_pkg_step', `select=pkg_id,step,role_code,kind&pkg_id=in.(${ids})`));
    }
    LQ.pkgs = new Map(pkgs.map(k => [k.id, k]));
    LQ.steps = new Map(pkgs.map(k => [k.id, steps.find(s => s.pkg_id === k.id && s.step === k.current_step) || null]));
    LQ.docs = docs;
    LQ.items = items;
    const held = new Set(docs.filter(d => !['cancelled', 'rejected'].includes(d.status))
      .flatMap(d => ((d.data || {}).lines || []).map(l => l.asset_id).filter(Boolean)));
    LQ.orphans = marked.filter(a => !held.has(a.id));
    LQ.sel = new Set([...LQ.sel].filter(id => LQ.orphans.some(a => a.id === id)));
    await lqLoadBatches();
    if (can('liquidation', 'admin') && !LQ.users) LQ.users = await SB.select('app_user', 'select=id,email,full_name&active=eq.true&order=full_name').catch(() => []);
    msg(out, LQ.flash ? 'ok' : '', LQ.flash || ''); LQ.flash = null;
    lqRender();
  } catch (e) { msg(out, 'err', e.message); }
}

const lqDays = iso => iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)) : null;
function lqRender() {
  const tabs = $('#lqTabs');
  tabs.innerHTML = '';
  const approved = new Map(LQ.docs.filter(d => d.status === 'approved').map(d => [d.id, d]));
  const pool = (LQ.items || []).filter(i => approved.has(i.lr_doc_id));
  for (const [v, key, n] of [['lr', 'lq.tab.lr', LQ.docs.length], ['pool', 'lq.tab.pool', pool.filter(i => i.status === 'pool').length],
                             ['orphan', 'lq.tab.orphan', LQ.orphans.length],
                             ['batch', 'lqb.tab', (LQ.batches || []).filter(b => !['closed', 'cancelled'].includes(b.status)).length],
                             ['council', 'lqc.tab', (LQ.councils || []).length]]) {
    const b = el('button', { textContent: `${t(key)} (${fmtInt(n)})` });
    b.classList.toggle('on', LQ.tab === v);
    b.onclick = () => { LQ.tab = v; if (v !== 'batch') LQ.batchOpen = null; lqRender(); };
    tabs.append(b);
  }
  // Batches and the council draw into a panel of their own; the filters and the grid are for the three lists.
  const panel = $('#lqPanel'), boxed = LQ.tab === 'batch' || LQ.tab === 'council';
  panel.innerHTML = '';
  $('#lqFilt').hidden = boxed; $('#lqGridWrap').hidden = boxed; $('#lqSum').innerHTML = ''; $('#lqXlsBtn').hidden = boxed;
  if (LQ.tab === 'batch') { $('#lqNewBtn').hidden = true; return lqBatchList(panel); }
  if (LQ.tab === 'council') { $('#lqNewBtn').hidden = true; return lqCouncilTab(panel); }
  const depts = [...new Set([...LQ.docs.map(d => d.dept_code), ...pool.map(i => i.dept_code), ...LQ.orphans.map(a => a.dept_code)].filter(Boolean))].sort();
  selFill($('#lqDept'), [['', t('pm.f.all')], ...depts.map(c => [c, `${c} — ${pmDeptName(c)}`])]);
  const stOpts = LQ.tab === 'lr' ? [['', t('pm.f.all')], ...WF_STATUS.map(s => [s, t('wf.st.' + s)])]
    : LQ.tab === 'pool' ? [['', t('pm.f.all')], ...['pool', 'batched', 'sold', 'destroyed', 'kept'].map(s => [s, t('lq.is.' + s)])] : [];
  $('#lqStWrap').hidden = !stOpts.length;
  if (stOpts.length) { const s = $('#lqSt'); selFill(s, stOpts); s.value = LQ.stv[LQ.tab] || ''; }
  $('#lqNewBtn').hidden = !lqPrepDepts().length;
  const dept = $('#lqDept').value, st = $('#lqSt').value, q = hnorm($('#lqQ').value);
  const head = $('#lqGrid thead'), body = $('#lqGrid tbody'), sum = $('#lqSum');
  head.innerHTML = ''; body.innerHTML = ''; sum.innerHTML = '';
  const th = cols => head.append(el('tr', {}, cols.map(([k, c]) => el('th', { className: c || '', textContent: k ? t(k) : '' }))));
  const none = (n, cols) => { if (!n) body.append(el('tr', {}, el('td', { colSpan: cols, style: 'color:var(--dim);padding:14px', textContent: t('lq.none') }))); };
  const money = v => el('td', { className: 'num', textContent: v != null ? fmtMoney(v) : '' });
  const tot = (label, span, vals, after) => body.append(el('tr', { className: 'tot' }, [el('td', { colSpan: span, textContent: label }), ...vals.map(money), ...after.map(() => el('td'))]));
  LQ.shown = [];
  if (LQ.tab === 'lr') {
    th([['lq.c.no'], ['lq.c.date'], ['pm.col.dept'], ['lq.c.lines', 'num'], ['lq.c.orig', 'num'], ['lq.c.nbv', 'num'], ['lq.c.status'], ['lq.c.waiting'], ['lq.c.source'], ['lq.c.by']]);
    const rows = LQ.docs.filter(d => (!dept || d.dept_code === dept) && (!st || d.status === st)
      && (!q || hnorm(`${d.doc_no} ${d.dept_code} ${pmDeptName(d.dept_code)} ${(d.data || {}).project_code || ''} ${((d.data || {}).lines || []).map(l => `${l.asset_code || ''} ${l.name || ''}`).join(' ')}`).includes(q)));
    for (const d of rows) {
      const x = d.data || {}, lines = x.lines || [], k = LQ.pkgs.get(d.pkg_id) || {}, s = LQ.steps.get(d.pkg_id);
      const orig = lines.reduce((a, l) => a + n0(l.original_value), 0), nbv = lines.reduce((a, l) => a + (n0(l.original_value) - n0(l.depreciation)), 0);
      const tr = el('tr', { style: 'cursor:pointer' }, [el('td', {}, el('code', { textContent: d.doc_no })),
        el('td', { textContent: fmtDate(x.date || String(d.created_at).slice(0, 10)) }),
        el('td', { textContent: pmDeptName(d.dept_code), title: d.dept_code || '' }),
        el('td', { className: 'num', textContent: fmtInt(lines.length) }), money(orig), money(nbv),
        el('td', {}, wfChip(d.status)),
        el('td', {}, d.status === 'in_review' && s ? el('span', { className: 'stg band-' + wfBand(s.role_code), textContent: `${s.step} · ${wfRoleName(s.role_code)}` }) : ''),
        el('td', { textContent: x.project_code ? `${x.rr_doc_no || 'RR'} · ${x.project_code}` : t('lq.srcDept') }),
        el('td', { textContent: k.created_name || d.created_email || '' })]);
      tr.onclick = () => wfOpen(d.id);
      body.append(tr);
      LQ.shown.push({ [t('lq.c.no')]: d.doc_no, [t('lq.c.date')]: x.date || '', [t('pm.col.dept')]: d.dept_code, [t('lq.c.lines')]: lines.length,
                      [t('lq.c.orig')]: orig, [t('lq.c.nbv')]: nbv, [t('lq.c.status')]: t('wf.st.' + d.status),
                      [t('lq.c.waiting')]: d.status === 'in_review' && s ? wfRoleName(s.role_code) : '', [t('lq.c.source')]: x.project_code || '', [t('lq.c.by')]: k.created_name || d.created_email || '' });
    }
    none(rows.length, 10);
  } else if (LQ.tab === 'pool') {
    if (LQ.items == null) { none(0, 1); return msg('#lqMsg', 'warn', t('lq.notInstalled')); }
    th([['lq.c.no'], ['lq.c.code'], ['lq.c.name'], ['lq.c.qty', 'num'], ['pm.col.dept'], ['lq.c.cond'], ['lq.c.mode'], ['lq.c.orig', 'num'], ['lq.c.dep', 'num'], ['lq.c.nbv', 'num'],
        ['lq.c.approved'], ['lq.c.days', 'num'], ['lq.c.pstat']]);
    const rows = pool.filter(i => (!dept || i.dept_code === dept) && (!st || i.status === st)
      && (!q || hnorm(`${approved.get(i.lr_doc_id).doc_no} ${i.asset_code || ''} ${i.name} ${i.dept_code || ''}`).includes(q)));
    for (const i of rows) {
      const d = approved.get(i.lr_doc_id), days = lqDays(d.decided_at || i.approved_at);
      const tr = el('tr', { style: 'cursor:pointer' }, [el('td', {}, el('code', { textContent: d.doc_no })), el('td', {}, el('code', { textContent: i.asset_code || 'N/A' })),
        el('td', { textContent: i.name }), el('td', { className: 'num', textContent: `${fmtNum(i.qty)} ${i.unit || ''}` }),
        el('td', { textContent: i.dept_code || '' }), el('td', { textContent: lqBi(LQ_COND, i.condition) }), el('td', { textContent: lqBi(LQ_MODE, i.mode) }),
        money(i.original_value), money(i.depreciation), money(i.nbv),
        el('td', { textContent: fmtDate(String(d.decided_at || i.approved_at).slice(0, 10)) }),
        el('td', { className: 'num' + (days > 180 ? ' bad' : ''), textContent: days != null ? fmtInt(days) : '' }),
        el('td', {}, el('span', { className: 'lqis ' + i.status, textContent: t('lq.is.' + i.status) + (i.batch_id && (LQ.batches || []).some(x => x.id === i.batch_id) ? ' · ' + LQ.batches.find(x => x.id === i.batch_id).code : '') }))]);
      tr.onclick = () => wfOpen(d.id);
      body.append(tr);
      LQ.shown.push({ [t('lq.c.no')]: d.doc_no, [t('lq.c.code')]: i.asset_code || '', [t('lq.c.name')]: i.name, [t('lq.c.qty')]: Number(i.qty), unit: i.unit || '',
                      [t('pm.col.dept')]: i.dept_code || '', [t('lq.c.cond')]: i.condition || '', [t('lq.c.mode')]: i.mode || '',
                      [t('lq.c.orig')]: i.original_value != null ? Number(i.original_value) : null, [t('lq.c.dep')]: i.depreciation != null ? Number(i.depreciation) : null,
                      [t('lq.c.nbv')]: i.nbv != null ? Number(i.nbv) : null, [t('lq.c.approved')]: String(d.decided_at || i.approved_at).slice(0, 10),
                      [t('lq.c.days')]: days, [t('lq.c.pstat')]: t('lq.is.' + i.status) });
    }
    if (rows.length) tot(t('lq.total', { n: fmtInt(rows.length) }), 7, [pmSum(rows, 'original_value'), pmSum(rows, 'depreciation'), pmSum(rows, 'nbv')], [1, 2, 3]);
    none(rows.length, 13);
    const old = rows.filter(i => i.status === 'pool' && lqDays((approved.get(i.lr_doc_id) || {}).decided_at || i.approved_at) > 180).length;
    if (old) sum.append(el('div', { className: 'msg warn', textContent: t('lq.old', { n: old }) }));
  } else {
    const rows = LQ.orphans.filter(a => (!dept || a.dept_code === dept)
      && (!q || hnorm(`${a.asset_code} ${a.barcode} ${a.name_vi} ${a.name_en || ''}`).includes(q)));
    const all = el('input', { type: 'checkbox', checked: rows.length > 0 && rows.every(a => LQ.sel.has(a.id)), title: t('lq.selAll') });
    all.onchange = () => { for (const a of rows) all.checked ? LQ.sel.add(a.id) : LQ.sel.delete(a.id); lqRender(); };
    head.append(el('tr', {}, [el('th', {}, all), ...[['lq.c.code'], ['col.barcode'], ['lq.c.name'], ['lq.c.qty', 'num'], ['pm.col.dept'], ['lq.c.astat'], ['lq.c.orig', 'num']]
      .map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))]));
    for (const a of rows) {
      const cb = el('input', { type: 'checkbox', checked: LQ.sel.has(a.id) });
      cb.onchange = () => { cb.checked ? LQ.sel.add(a.id) : LQ.sel.delete(a.id); lqRender(); };
      const v = a.unit_price != null ? Number(a.unit_price) * (a.asset_kind === 'unique' ? 1 : (n0(a.qty) || 1)) : null;
      body.append(el('tr', {}, [el('td', {}, cb), el('td', {}, el('code', { textContent: a.asset_code })), el('td', { textContent: a.barcode || '' }),
        el('td', { textContent: [a.name_vi, a.name_en].filter(Boolean).join(' / ') }), el('td', { className: 'num', textContent: `${fmtNum(a.qty)} ${a.unit_code || ''}` }),
        el('td', { textContent: a.dept_code }), el('td', { textContent: amStatusLabel(a.status_code) }), money(v)]));
      LQ.shown.push({ [t('lq.c.code')]: a.asset_code, barcode: a.barcode, [t('lq.c.name')]: [a.name_vi, a.name_en].filter(Boolean).join(' / '), [t('lq.c.qty')]: Number(a.qty),
                      [t('pm.col.dept')]: a.dept_code, [t('lq.c.astat')]: amStatusLabel(a.status_code), [t('lq.c.orig')]: v });
    }
    none(rows.length, 8);
    sum.append(el('div', { className: 'msg info', textContent: t('lq.orphanHint') }));
    if (LQ.sel.size) sum.append(el('div', { className: 'row', style: 'gap:8px;align-items:center;margin-top:8px' }, [
      el('b', { textContent: t('lq.selN', { n: fmtInt(LQ.sel.size) }) }),
      el('button', { className: 'btn pri', type: 'button', textContent: t('lq.fromSel'), onclick: () => lqNewForm(LQ.orphans.filter(a => LQ.sel.has(a.id))) }),
      el('button', { className: 'btn', type: 'button', textContent: t('lq.selClear'), onclick: () => { LQ.sel.clear(); lqRender(); } })]));
  }
}

// The departments this person may draw up an LR for (chain step 0 of the department's entity, liquidation "create").
function lqPrepDepts() {
  if (!ME || !can('liquidation', 'create') || !PM.orgMap) return [];
  return [...PM.orgMap.values()].filter(o => o.parent_code && wfCanPrepare('LR', o.code))
    .map(o => o.code).sort();
}

/* A new LR: the department (the number carries it), the date, and — only if
   paper LRs of this year already used some numbers — the number to start at. */
function lqNewForm(assets = []) {
  const box = $('#lqNewBox');
  box.innerHTML = '';
  const depts = lqPrepDepts();
  if (!depts.length) return msg('#lqMsg', 'err', t('lq.cannot'));
  const fromDepts = [...new Set(assets.map(a => a.dept_code))];
  if (fromDepts.length > 1) return msg('#lqMsg', 'err', t('lq.oneDept', { list: fromDepts.join(', ') }));
  const dsel = el('select');
  for (const c of depts) dsel.append(el('option', { value: c, textContent: `${c} — ${pmDeptName(c)}` }));
  if (fromDepts[0]) {
    if (!depts.includes(fromDepts[0])) return msg('#lqMsg', 'err', t('lq.notYours', { d: fromDepts[0] }));
    dsel.value = fromDepts[0]; dsel.disabled = true;
  }
  const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const no = el('input', { inputMode: 'numeric', placeholder: '…', style: 'max-width:110px' });
  const next = el('code', { textContent: '…' });
  const out = el('div');
  const peek = async () => {
    try { next.textContent = await SB.rpc('pm_lq_next_no', { p_dept: dsel.value, p_year: Number(date.value.slice(0, 4)) || new Date().getFullYear() }); }
    catch { next.textContent = '—'; }
  };
  dsel.onchange = peek; date.onchange = peek;
  const go = el('button', { className: 'btn pri', type: 'button', textContent: t('lq.create') });
  go.onclick = async () => {
    go.disabled = true;
    try {
      const n = no.value.trim() ? parseInt(no.value, 10) : null;
      if (no.value.trim() && !(n > 0)) throw new Error(t('lq.badNo'));
      const data = { date: date.value, dept_code: dsel.value, reason: '', position: '', lines: assets.map(lqLineOf), evidence: [] };
      await lqEnrich(data.lines);
      WF_FORMS.LR.derive(data);
      const id = await SB.rpc('pm_lq_create', { p_dept: dsel.value, p_data: data, p_no: n });
      box.innerHTML = ''; LQ.sel.clear();
      wfOpen(id);
    } catch (e) { msg(out, 'err', e.message); go.disabled = false; }
  };
  box.append(el('div', { className: 'card lqnew' }, [
    el('h2', { textContent: assets.length ? t('lq.newFrom', { n: fmtInt(assets.length) }) : t('lq.new') }),
    el('div', { className: 'row', style: 'align-items:flex-end;flex-wrap:wrap;gap:12px' }, [
      el('div', { className: 'fld', style: 'max-width:280px' }, [el('label', { textContent: t('pm.col.dept') }), dsel]),
      el('div', { className: 'fld', style: 'max-width:170px' }, [el('label', { textContent: t('lq.c.date') }), date]),
      el('div', { className: 'fld', style: 'max-width:130px' }, [el('label', { textContent: t('lq.noOpt') }), no]),
      el('div', { className: 'fld' }, [el('label', { textContent: t('lq.nextNo') }), next]),
      go, el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: () => { box.innerHTML = ''; } })]),
    el('div', { className: 'tdnote', textContent: t('lq.noHint') }), out]));
  peek();
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function lqXlsx() {
  if (!(LQ.shown || []).length) return msg('#lqMsg', 'warn', t('lq.none'));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(LQ.shown), LQ.tab === 'lr' ? 'LR' : LQ.tab === 'pool' ? 'Pool' : 'Awaiting');
  const file = `phcl-liquidation-${LQ.tab}-${bkStamp()}.xlsx`;
  XLSX.writeFile(wb, file);
  msg('#lqMsg', 'ok', t('lq.exported', { file }));
}

/* To-do: this person's LRs still in draft — started and not sent, or drawn up
   automatically from a replacement project's RR when its last handover was approved. */
async function lqTodos() {
  if (!ME || !can('liquidation', 'create')) return [];
  const rows = await SB.select('pm_doc', `select=id,doc_no,dept_code,created_at,total_value,src:data->>project_code,rr:data->>rr_doc_no&doc_type=eq.LR&status=eq.draft&created_by=eq.${ME.id}&order=id`);
  return rows.map(d => ({ kind: 'draft', doc_type: 'LR', grp: 'LR', doc_id: d.id, doc_no: d.doc_no, project_code: d.src || '', project_name: t('lq.docName'),
                          dept_code: d.dept_code, total_value: d.total_value, submitted_at: d.created_at, rr: d.rr }));
}

function initLq() {
  if (!$('#lqTabs')) return;
  $('#lqDept').onchange = lqRender;
  $('#lqSt').onchange = () => { LQ.stv[LQ.tab] = $('#lqSt').value; lqRender(); };
  $('#lqQ').oninput = lqRender;
  $('#lqNewBtn').onclick = () => lqNewForm([]);
  $('#lqXlsBtn').onclick = lqXlsx;
}

/* ============================================================ LIQUIDATION — phase 2
   The council and the liquidation batch (28_liquidation_batch.sql). The council
   is the one set up by the GM's decision (L01/2026…), typed in here — names
   never go in the public repo. A batch L0x.yyyy takes items from the pool and
   goes: list → council meeting + decision (forms 02, 03) → physical count
   (form 04, on the tablet) → revaluation (form 05, the floor price for the
   quotations). Form 06 is drawn from the same list; its results are phase 3.
   Every form comes out of the ONE list, with the same numbers and dates, so the
   documents of a batch can no longer disagree with each other. */
const LQB_STEPS = ['open', 'decided', 'counted', 'valued', 'bidding'];
const LQB_NEXT = { open: 'decided', decided: 'counted', counted: 'valued' };
const LQB_BACK = { decided: 'open', counted: 'decided', valued: 'counted' };
const LQ_PLACE = '17 Lê Duẩn, phường Sài Gòn, TP.HCM / 17 Le Duan, Sai Gon Ward, Ho Chi Minh City';
const lqMemRep = m => m.role === 'chair' ? ['Chủ tịch hội đồng', 'Chairman of the Council']
  : m.role === 'vice' ? ['Phó Chủ tịch hội đồng', 'Vice Chairman of the Council']
  : m.permanent ? ['Thành viên thường trực hội đồng', 'Permanent Member of the Council']
  : ['Thành viên không thường trực hội đồng (Tham gia theo chỉ định của chủ tịch hội đồng)', "Non-permanent Member of the Council (Participating upon Chairman's appointment)"];
const lqMembersOf = cid => (LQ.members || []).filter(m => m.council_id === cid).sort((a, b) => a.sort - b.sort || a.id - b.id);
const lqBatchItems = b => (LQ.items || []).filter(i => i.batch_id === b.id);
const lqD = iso => iso ? fmtDate(String(iso).slice(0, 10)) : '…………';
const lqN = v => v == null || v === '' || !isFinite(v) ? '' : fmtNum(Math.round(Number(v)));

async function lqLoadBatches() {
  try {
    const [councils, members, batches] = await Promise.all([
      SB.select('pm_lq_council', 'select=*&order=id.desc'), SB.select('pm_lq_member', 'select=*&order=council_id,sort,id'),
      SB.select('pm_lq_batch', 'select=*&order=id.desc')]);
    Object.assign(LQ, { councils, members, batches, p2: true });
  } catch { Object.assign(LQ, { councils: [], members: [], batches: [], p2: false }); }
}

/* ------------------------------------------------------------ batches tab */
function lqBatchList(panel) {
  const edit = can('liquidation', 'edit');
  if (!LQ.p2) return panel.append(el('div', { className: 'msg warn', textContent: t('lqb.notInstalled') }));
  if (LQ.batchOpen) { const b = LQ.batches.find(x => x.id === LQ.batchOpen); if (b) return lqBatchDetail(panel, b); LQ.batchOpen = null; }
  const card = el('div', { className: 'card' });
  const head = el('div', { className: 'chead' }, [el('h2', { textContent: t('lqb.list') })]);
  if (edit) head.append(el('button', { className: 'btn pri', type: 'button', textContent: t('lqb.new'), onclick: () => lqBatchNew(card) }));
  card.append(head);
  if (!LQ.councils.some(c => c.active)) card.append(el('div', { className: 'msg warn', textContent: t('lqb.noCouncil') }));
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['lqb.c.code', 'lqb.c.meeting', 'lqb.c.council', 'lqb.c.items', 'lq.c.orig', 'lq.c.nbv', 'lqb.c.reval', 'lqb.c.status']
    .map((k, i) => el('th', { className: i >= 3 && i <= 6 ? 'num' : '', textContent: t(k) })))]);
  for (const b of LQ.batches) {
    const its = lqBatchItems(b).filter(i => i.status !== 'kept'), c = LQ.councils.find(x => x.id === b.council_id);
    const tr = el('tr', { style: 'cursor:pointer', onclick: () => { LQ.batchOpen = b.id; lqRender(); } }, [
      el('td', {}, el('b', { textContent: b.code })), el('td', { textContent: lqD(b.meeting_date) }), el('td', { textContent: c ? c.decision_no : '—' }),
      el('td', { className: 'num', textContent: fmtInt(its.length) }), el('td', { className: 'num', textContent: lqN(pmSum(its, 'original_value')) }),
      el('td', { className: 'num', textContent: lqN(pmSum(its, 'nbv')) }),
      el('td', { className: 'num', textContent: its.some(i => i.reval_value != null) ? lqN(pmSum(its, 'reval_value')) : '' }),
      el('td', {}, el('span', { className: 'lqbs ' + b.status, textContent: t('lqb.st.' + b.status) }))]);
    tb.append(tr);
  }
  if (!LQ.batches.length) tb.append(el('tr', {}, el('td', { colSpan: 8, className: 'dim', textContent: t('lqb.none') })));
  card.append(el('div', { className: 'wrap' }, tb));
  panel.append(card);
}

function lqBatchNew(card) {
  card.querySelector('.lqbnew')?.remove();
  const code = el('input', { placeholder: '…', style: 'max-width:130px' });
  const date = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const out = el('div');
  const peek = async () => { try { code.placeholder = await SB.rpc('pm_lq_batch_next', { p_year: Number(date.value.slice(0, 4)) || new Date().getFullYear() }); } catch {} };
  date.onchange = peek;
  const go = el('button', { className: 'btn pri', type: 'button', textContent: t('lq.create'), onclick: async () => {
    go.disabled = true;
    try {
      const id = await SB.rpc('pm_lq_batch_create', { p_code: code.value.trim() || null, p_data: { meeting_date: date.value, meeting_place: LQ_PLACE } });
      await lqLoadBatches(); LQ.batchOpen = id; lqRender();
    } catch (e) { msg(out, 'err', e.message); go.disabled = false; }
  } });
  card.append(el('div', { className: 'lqbnew row', style: 'align-items:flex-end;gap:12px;flex-wrap:wrap;margin-top:10px' }, [
    el('div', { className: 'fld' }, [el('label', { textContent: t('lqb.meetingDate') }), date]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('lqb.codeOpt') }), code]), go,
    el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: e => e.target.closest('.lqbnew').remove() }),
    el('div', { className: 'tdnote', style: 'flex-basis:100%', textContent: t('lqb.codeHint') }), out]));
  peek();
}

// One batch: its steps, the meeting, the list, the forms.
function lqBatchDetail(panel, b) {
  const edit = can('liquidation', 'edit') && !['closed', 'cancelled'].includes(b.status);
  const its = lqBatchItems(b), live = its.filter(i => ['batched', 'sold', 'destroyed', 'lost'].includes(i.status)), kept = its.filter(i => i.status === 'kept');
  const out = el('div');
  const docNo = id => (LQ.docs.find(d => d.id === id) || {}).doc_no || '';
  // Header + steps.
  const top = el('div', { className: 'card' });
  top.append(el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [
    el('a', { href: '#', textContent: '← ' + t('lqb.list'), onclick: e => { e.preventDefault(); LQ.batchOpen = null; lqRender(); } }),
    el('b', { style: 'font-size:16px', textContent: b.code }), el('span', { className: 'lqbs ' + b.status, textContent: t('lqb.st.' + b.status) })]));
  const idx = b.status === 'closed' ? LQB_STEPS.length : LQB_STEPS.indexOf(b.status);
  top.append(el('div', { className: 'lqsteps' }, LQB_STEPS.map((s, i) => el('div', { className: 'lqstep' + (i < idx ? ' done' : i === idx ? ' cur' : '') + (s === 'bidding' ? ' later' : '') },
    [el('span', { className: 'n', textContent: String(i + 1) }), el('div', {}, [el('b', { textContent: t('lqb.step.' + s) }), el('small', { textContent: t('lqb.stepHint.' + s) })])]))));
  // What can be done now.
  const acts = el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' });
  const act = (key, cls, fn) => acts.append(el('button', { className: 'btn ' + cls, type: 'button', textContent: t(key), onclick: fn }));
  const move = async (to, ask) => {
    if (ask && !confirm(ask)) return;
    try { await SB.rpc('pm_lq_batch_move', { p_id: b.id, p_to: to }); await lqLoad(); msg('#lqMsg', 'ok', t('lqb.moved', { c: b.code, s: t('lqb.st.' + to) })); }
    catch (e) { msg(out, 'err', e.message); }
  };
  if (edit && LQB_NEXT[b.status]) act('lqb.next.' + b.status, 'pri', () => move(LQB_NEXT[b.status], t('lqb.ask.' + b.status, { c: b.code })));
  if (edit && b.status === 'decided') act('lqb.countOpen', '', () => { LQ.countBatch = b.id; showView('lqcount'); });
  if (edit && LQB_BACK[b.status]) act('lqb.back', '', () => move(LQB_BACK[b.status], t('lqb.askBack', { c: b.code, s: t('lqb.st.' + LQB_BACK[b.status]) })));
  if (edit && b.status === 'open') act('lqb.cancel', 'danger', () => move('cancelled', t('lqb.askCancel', { c: b.code })));
  top.append(acts, out);
  panel.append(top);

  // The meeting and the dates.
  const info = el('div', { className: 'card' });
  info.append(el('h2', { textContent: t('lqb.meeting') }));
  const d = Object.assign({}, b.data || {});
  const patch = {};
  const fld = (key, node, wide) => el('div', { className: 'fld' + (wide ? ' lqwide' : '') }, [el('label', { textContent: t(key) }), node]);
  const inp = (k, type = 'text', v) => { const i = el('input', { type, value: v ?? b[k] ?? '', disabled: !edit }); i.onchange = () => { patch[k] = i.value; }; return i; };
  const txt = k => { const i = el('textarea', { rows: 2, value: d[k] || '', disabled: !edit }); i.onchange = () => { patch.data = Object.assign(patch.data || {}, { [k]: i.value }); }; return i; };
  const csel = el('select', { disabled: !edit || b.status !== 'open' });
  csel.append(el('option', { value: '', textContent: '—' }));
  for (const c of LQ.councils) csel.append(el('option', { value: c.id, textContent: `${c.decision_no}${c.active ? ' ✓' : ''}` }));
  csel.value = b.council_id || '';
  csel.onchange = () => { patch.council_id = csel.value; };
  const codeIn = inp('code'); codeIn.disabled = !edit || b.status !== 'open';
  info.append(el('div', { className: 'lqgrid' }, [
    fld('lqb.c.code', codeIn), fld('lqb.c.council', csel), fld('lqb.meetingDate', inp('meeting_date', 'date')), fld('lqb.meetingTime', inp('meeting_time')),
    fld('lqb.place', inp('meeting_place'), true), fld('lqb.decisionDate', inp('decision_date', 'date')), fld('lqb.countDate', inp('count_date', 'date')),
    fld('lqb.valDate', inp('valuation_date', 'date')), fld('lqb.liqDate', inp('liquidation_date', 'date')),
    fld('lqb.causesVi', txt('causes_vi'), true), fld('lqb.causesEn', txt('causes_en'), true),
    fld('lqb.planVi', txt('plan_vi'), true), fld('lqb.planEn', txt('plan_en'), true),
    fld('lqb.conclVi', txt('conclusion_vi'), true), fld('lqb.conclEn', txt('conclusion_en'), true)]));
  if (edit) info.append(el('div', { className: 'row', style: 'margin-top:8px' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('tool.save'), onclick: async () => {
    if (!Object.keys(patch).length) return;
    try { await SB.rpc('pm_lq_batch_save', { p_id: b.id, p_patch: patch }); await lqLoad(); msg('#lqMsg', 'ok', t('lqb.saved', { c: b.code })); }
    catch (e) { msg(out, 'err', e.message); } } })]));
  panel.append(info);

  // The list.
  const list = el('div', { className: 'card' });
  const lh = el('div', { className: 'chead' }, [el('h2', { textContent: t('lqb.items', { n: fmtInt(live.length) }) })]);
  if (edit && b.status === 'open') lh.append(el('button', { className: 'btn', type: 'button', textContent: t('lqb.addFromPool'), onclick: () => lqPoolPicker(list, b) }));
  if (edit && b.status === 'counted') lh.append(el('button', { className: 'btn', type: 'button', textContent: t('lqb.revalFill'), onclick: async () => {
    try { for (const i of live.filter(x => x.reval_value == null)) await SB.rpc('pm_lq_reval', { p_item: i.id, p_value: Math.max(0, Number(i.nbv) || 0), p_note: null });
          await lqLoad(); } catch (e) { msg(out, 'err', e.message); } } }));
  list.append(lh);
  const showCount = ['decided', 'counted', 'valued', 'bidding', 'closed'].includes(b.status), showReval = ['counted', 'valued', 'bidding', 'closed'].includes(b.status);
  const heads = ['lq.c.no', 'lq.c.code', 'lq.c.name', 'lq.c.qty', 'pm.col.dept', 'lq.c.cond', 'lq.c.mode', 'lq.c.orig', 'lq.c.dep', 'lq.c.nbv',
                 ...(showCount ? ['lqb.c.counted'] : []), ...(showReval ? ['lqb.c.reval', 'lqb.c.diff'] : []), ...(edit && b.status === 'open' ? [''] : [])];
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, heads.map(k => el('th', { className: /orig|dep|nbv|reval|diff|qty/.test(k) ? 'num' : '', textContent: k ? t(k) : '' })))]);
  for (const i of live) {
    const cells = [el('td', {}, el('code', { textContent: docNo(i.lr_doc_id) })), el('td', {}, el('code', { textContent: i.asset_code || 'N/A' })), el('td', { textContent: i.name }),
      el('td', { className: 'num', textContent: `${fmtNum(i.qty)} ${i.unit || ''}` }), el('td', { textContent: i.dept_code || '' }),
      el('td', { textContent: lqBi(LQ_COND, i.condition) }), el('td', { textContent: lqBi(LQ_MODE, i.mode) }),
      el('td', { className: 'num', textContent: lqN(i.original_value) }), el('td', { className: 'num', textContent: lqN(i.depreciation) }), el('td', { className: 'num', textContent: lqN(i.nbv) })];
    if (showCount) cells.push(el('td', { className: i.count_found === false || (i.count_found && n0(i.count_qty) !== n0(i.qty)) ? 'bad' : '',
      textContent: i.count_found == null ? '—' : i.count_found ? `✓ ${fmtNum(i.count_qty)}` : '✗ ' + t('lqb.notFound'), title: i.count_note || '' }));
    if (showReval) {
      if (edit && b.status === 'counted') {
        const r = el('input', { value: i.reval_value != null ? fmtNum(i.reval_value) : '', inputMode: 'decimal', className: 'lqrv' });
        r.onchange = async () => { try { await SB.rpc('pm_lq_reval', { p_item: i.id, p_value: numIn(r.value), p_note: null }); i.reval_value = numIn(r.value); } catch (e) { msg(out, 'err', e.message); } };
        cells.push(el('td', { className: 'num' }, r));
      } else cells.push(el('td', { className: 'num', textContent: lqN(i.reval_value) }));
      const df = i.reval_value != null ? Number(i.reval_value) - n0(i.nbv) : null;
      cells.push(el('td', { className: 'num' + (df > 0 ? ' up' : df < 0 ? ' down' : ''), textContent: df == null ? '' : (df > 0 ? '+' : '') + lqN(df) }));
    }
    if (edit && b.status === 'open') cells.push(el('td', { className: 'nowrap' }, [
      el('button', { className: 'btn tiny', type: 'button', textContent: t('lqb.keep'), title: t('lqb.keepHint'), onclick: async () => {
        const why = prompt(t('lqb.keepWhy', { n: i.name })); if (!why) return;
        try { await SB.rpc('pm_lq_keep', { p_item: i.id, p_keep: true, p_note: why }); await lqLoad(); } catch (e) { msg(out, 'err', e.message); } } }),
      el('button', { className: 'xbtn', type: 'button', textContent: '×', title: t('lqb.remove'), onclick: async () => {
        try { await SB.rpc('pm_lq_batch_items', { p_id: b.id, p_add: [], p_remove: [i.id] }); await lqLoad(); } catch (e) { msg(out, 'err', e.message); } } })]));
    tb.append(el('tr', {}, cells));
  }
  if (live.length) {
    const tot = [el('td', { colSpan: 7, textContent: t('lq.total', { n: fmtInt(live.length) }) }),
      ...['original_value', 'depreciation', 'nbv'].map(k => el('td', { className: 'num', textContent: lqN(pmSum(live, k)) })),
      ...(showCount ? [el('td')] : []), ...(showReval ? [el('td', { className: 'num', textContent: lqN(pmSum(live, 'reval_value')) }),
        el('td', { className: 'num', textContent: lqN(pmSum(live.filter(i => i.reval_value != null), i => Number(i.reval_value) - n0(i.nbv))) })] : []),
      ...(edit && b.status === 'open' ? [el('td')] : [])];
    tb.append(el('tr', { className: 'tot' }, tot));
  } else tb.append(el('tr', {}, el('td', { colSpan: heads.length, className: 'dim', textContent: t('lqb.noItems') })));
  list.append(el('div', { className: 'wrap' }, tb));
  if (kept.length) {
    list.append(el('h3', { className: 'lqsub', textContent: t('lqb.kept', { n: kept.length }) }));
    list.append(el('ul', { className: 'lqkept' }, kept.map(i => el('li', {}, [el('code', { textContent: i.asset_code || 'N/A' }), document.createTextNode(` ${i.name} — ${i.keep_note || ''} `),
      ...(edit && b.status === 'open' ? [el('button', { className: 'btn tiny', type: 'button', textContent: t('lqb.unkeep'), onclick: async () => {
        try { await SB.rpc('pm_lq_keep', { p_item: i.id, p_keep: false, p_note: null }); await lqLoad(); } catch (e) { msg(out, 'err', e.message); } } })] : [])]))));
  }
  panel.append(list);

  // Quotations, opening, result, the buyers' papers, closing (phase 3).
  if (['valued', 'bidding', 'closed'].includes(b.status)) lqbBidCard(panel, b);

  // The forms.
  const forms = el('div', { className: 'card' });
  const fout = el('div');
  forms.append(el('h2', { textContent: t('lqb.forms') }), el('div', { className: 'tdnote', textContent: t('lqb.formsHint') }));
  const grid = el('div', { className: 'lqforms' });
  for (const k of LQB_FORMS) {
    const ready = lqbFormReady(k, b);
    grid.append(el('div', { className: 'lqform' + (ready ? '' : ' draft') }, [
      el('b', { textContent: `${k} — ${t('lqb.f.' + k)}` }), el('small', { textContent: ready ? t('lqb.fReady') : t('lqb.fDraft.' + k) }),
      el('div', { className: 'row', style: 'gap:6px' }, [
        el('button', { className: 'btn tiny', type: 'button', textContent: t('wf.cap.preview'), onclick: () => lqbCapture(b, [k], 'preview', fout) }),
        el('button', { className: 'btn tiny', type: 'button', textContent: 'PDF', onclick: () => lqbCapture(b, [k], 'pdf', fout) })])]));
  }
  forms.append(grid, el('div', { className: 'row', style: 'gap:6px;margin-top:8px' }, [
    el('button', { className: 'btn', type: 'button', textContent: t('lqb.allPdf'), onclick: () => lqbCapture(b, [...LQB_FORMS, ...(b.opened_at ? ['07', 'GP', '11'] : [])], 'pdf', fout) }),
    el('button', { className: 'btn', type: 'button', textContent: t('lqb.allPreview'), onclick: () => lqbCapture(b, [...LQB_FORMS, ...(b.opened_at ? ['07', 'GP', '11'] : [])], 'preview', fout) })]), fout);
  panel.append(forms);
}

// Pool items to add: every item still waiting, grouped by its LR, ticked and added in one go.
function lqPoolPicker(card, b) {
  card.querySelector('.lqpick')?.remove();
  const approved = new Set(LQ.docs.filter(d => d.status === 'approved').map(d => d.id));
  const pool = (LQ.items || []).filter(i => i.status === 'pool' && approved.has(i.lr_doc_id));
  const box = el('div', { className: 'lqpick' });
  if (!pool.length) { box.append(el('div', { className: 'msg info', textContent: t('lqb.poolEmpty') })); card.append(box); return; }
  const pick = new Set();
  const byLr = new Map();
  for (const i of pool) (byLr.get(i.lr_doc_id) || byLr.set(i.lr_doc_id, []).get(i.lr_doc_id)).push(i);
  for (const [lr, list] of byLr) {
    const doc = LQ.docs.find(d => d.id === lr) || {};
    const all = el('input', { type: 'checkbox' });
    const boxes = list.map(i => { const c = el('input', { type: 'checkbox' }); c.onchange = () => { c.checked ? pick.add(i.id) : pick.delete(i.id); }; return [i, c]; });
    all.onchange = () => { for (const [i, c] of boxes) { c.checked = all.checked; all.checked ? pick.add(i.id) : pick.delete(i.id); } };
    box.append(el('div', { className: 'lqpg' }, [el('label', { className: 'chk' }, [all, el('b', { textContent: `${doc.doc_no || lr} · ${pmDeptName(doc.dept_code)} · ${lqD((doc.data || {}).date || doc.decided_at)}` })]),
      ...boxes.map(([i, c]) => el('label', { className: 'chk lqpi' }, [c, el('span', { textContent: `${i.asset_code || 'N/A'} — ${i.name} · ${fmtNum(i.qty)} ${i.unit || ''} · ${lqN(i.nbv)}` })]))]));
  }
  box.append(el('div', { className: 'row', style: 'gap:8px;margin-top:8px' }, [
    el('button', { className: 'btn pri', type: 'button', textContent: t('lqb.addSel'), onclick: async () => {
      if (!pick.size) return;
      try { await SB.rpc('pm_lq_batch_items', { p_id: b.id, p_add: [...pick], p_remove: [] }); await lqLoad(); } catch (e) { msg('#lqMsg', 'err', e.message); } } }),
    el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: () => box.remove() })]));
  card.querySelector('.chead').after(box);
}

/* ------------------------------------------------------------ council tab */
async function lqCouncilTab(panel) {
  if (!LQ.p2) return panel.append(el('div', { className: 'msg warn', textContent: t('lqb.notInstalled') }));
  const admin = can('liquidation', 'admin');
  const out = el('div');
  const card = el('div', { className: 'card' });
  card.append(el('div', { className: 'chead' }, [el('h2', { textContent: t('lqc.h') }),
    ...(admin ? [el('button', { className: 'btn pri', type: 'button', textContent: t('lqc.new'), onclick: () => lqCouncilNew(card, out) })] : [])]),
    el('div', { className: 'tdnote', textContent: t('lqc.hint') }), out);
  if (!LQ.councils.length) card.append(el('div', { className: 'msg info', textContent: t('lqc.none') }));
  for (const c of LQ.councils) {
    const mem = lqMembersOf(c.id);
    const box = el('div', { className: 'lqcouncil' + (c.active ? ' on' : '') });
    const head = el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [
      el('b', { textContent: t('lqc.decision', { no: c.decision_no }) }), el('span', { className: 'dim', textContent: lqD(c.decision_date) }),
      c.active ? el('span', { className: 'lqbs valued', textContent: t('lqc.active') }) : '',
      wfSafeUrl(c.file_url) ? el('a', { href: c.file_url, target: '_blank', rel: 'noopener noreferrer', textContent: '🔗 ' + t('lqc.file') }) : '']);
    if (admin && !c.active) head.append(el('button', { className: 'btn tiny', type: 'button', textContent: t('lqc.makeActive'), onclick: async () => {
      try { await SB.patch('pm_lq_council', 'active=eq.true', { active: false }); await SB.patch('pm_lq_council', `id=eq.${c.id}`, { active: true }); await lqLoad(); }
      catch (e) { msg(out, 'err', e.message); } } }));
    box.append(head);
    const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['lqc.m.name', 'lqc.m.posVi', 'lqc.m.posEn', 'lqc.m.role', 'lqc.m.user', ...(admin ? [''] : [])]
      .map(k => el('th', { textContent: k ? t(k) : '' })))]);
    const users = LQ.users || [];
    const row = m => {
      const nm = el('input', { value: m.full_name || '', disabled: !admin }), pv = el('input', { value: m.position_vi || '', disabled: !admin }),
            pe = el('input', { value: m.position_en || '', disabled: !admin });
      const role = el('select', { disabled: !admin });
      for (const [v, k] of [['chair', 'lqc.r.chair'], ['vice', 'lqc.r.vice'], ['member:1', 'lqc.r.perm'], ['member:0', 'lqc.r.nonperm']]) role.append(el('option', { value: v, textContent: t(k) }));
      role.value = m.role === 'member' ? `member:${m.permanent === false ? 0 : 1}` : (m.role || 'member:1');
      const us = el('select', { disabled: !admin });
      us.append(el('option', { value: '', textContent: '—' }));
      for (const u of users) us.append(el('option', { value: u.id, textContent: u.full_name || u.email }));
      us.value = m.user_id || '';
      const save = async () => {
        if (!nm.value.trim()) return;
        const [r, p] = role.value.split(':');
        const rec = { council_id: c.id, sort: m.sort ?? mem.length, full_name: nm.value.trim(), position_vi: pv.value.trim() || null, position_en: pe.value.trim() || null,
                      role: r, permanent: r !== 'member' || p !== '0', user_id: us.value || null };
        try { if (m.id) await SB.patch('pm_lq_member', `id=eq.${m.id}`, rec); else await SB.insert('pm_lq_member', [rec]); await lqLoad(); }
        catch (e) { msg(out, 'err', e.message); }
      };
      for (const i of [nm, pv, pe, role, us]) i.onchange = () => { if (m.id) save(); };
      return el('tr', {}, [el('td', {}, nm), el('td', {}, pv), el('td', {}, pe), el('td', {}, role), el('td', {}, us),
        ...(admin ? [el('td', { className: 'nowrap' }, m.id ? el('button', { className: 'xbtn', type: 'button', textContent: '×', title: t('lqc.m.del'), onclick: async () => {
          if (!confirm(t('lqc.m.delQ', { n: m.full_name }))) return;
          try { await SB.remove('pm_lq_member', `id=eq.${m.id}`); await lqLoad(); } catch (e) { msg(out, 'err', e.message); } } })
          : el('button', { className: 'btn tiny pri', type: 'button', textContent: t('lqc.m.add'), onclick: save }))] : [])]);
    };
    for (const m of mem) tb.append(row(m));
    if (admin) tb.append(row({ sort: mem.length, role: 'member', permanent: false }));
    box.append(el('div', { className: 'wrap' }, tb));
    if (!mem.some(m => m.role === 'chair')) box.append(el('div', { className: 'msg warn', textContent: t('lqc.noChair') }));
    card.append(box);
  }
  panel.append(card);
}
function lqCouncilNew(card, out) {
  card.querySelector('.lqbnew')?.remove();
  const no = el('input', { placeholder: 'L01/2026', style: 'max-width:140px' }), date = el('input', { type: 'date' }), url = el('input', { placeholder: 'https://…', style: 'min-width:260px' });
  const copy = el('input', { type: 'checkbox', checked: LQ.councils.some(c => c.active) });
  card.querySelector('.chead').after(el('div', { className: 'lqbnew row', style: 'align-items:flex-end;gap:12px;flex-wrap:wrap' }, [
    el('div', { className: 'fld' }, [el('label', { textContent: t('lqc.no') }), no]), el('div', { className: 'fld' }, [el('label', { textContent: t('lqc.date') }), date]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('lqc.file') }), url]),
    el('label', { className: 'chk' }, [copy, el('span', { textContent: t('lqc.copy') })]),
    el('button', { className: 'btn pri', type: 'button', textContent: t('lq.create'), onclick: async () => {
      if (!no.value.trim()) return msg(out, 'err', t('lqc.needNo'));
      try {
        const prev = LQ.councils.find(c => c.active);
        if (prev) await SB.patch('pm_lq_council', 'active=eq.true', { active: false });
        const [c] = await SB.insert('pm_lq_council', [{ decision_no: no.value.trim(), decision_date: date.value || null, file_url: url.value.trim() || null, active: true }]);
        if (copy.checked && prev) {
          const ms = lqMembersOf(prev.id).map(({ id, council_id, ...m }) => Object.assign(m, { council_id: c.id }));
          if (ms.length) await SB.insert('pm_lq_member', ms);
        }
        await lqLoad();
      } catch (e) { msg(out, 'err', e.message); }
    } })]));
}

/* ------------------------------------------------------------ the forms
   02 minutes of the council meeting · 03 decision · 04 count (Mẫu 05-TSCĐ) ·
   05 revaluation (Mẫu 04-TSCĐ) · 06 liquidation minutes (Mẫu 02-TSCĐ).
   Bilingual as the templates are; long lists run on over as many A4 pages as
   they need, the signatures on the last. */
const LQB_FORMS = ['02', '03', '04', '05', '08', '06'];
const lqbFormReady = (k, b) => { const i = LQB_STEPS.indexOf(b.status);
  return k === '02' || k === '03' ? i >= 1 : k === '04' ? i >= 2 : k === '05' ? i >= 3 : k === '08' ? !!b.opened_at : b.status === 'closed'; };
const LQB_TT200 = { '04': 'Mẫu số 05 - TSCĐ', '05': 'Mẫu số 04 - TSCĐ', '06': 'Mẫu số 02 - TSCĐ' };

function lqbCtx(b, assets) {
  // The list of the batch: still in it, or already settled when the batch closed (sold / destroyed / lost).
  const its = lqBatchItems(b), live = its.filter(i => ['batched', 'sold', 'destroyed', 'lost'].includes(i.status));
  const council = LQ.councils.find(c => c.id === b.council_id) || null;
  const mem = council ? lqMembersOf(council.id) : [];
  const lrIds = [...new Set(live.map(i => i.lr_doc_id))];
  const lrs = lrIds.map(id => LQ.docs.find(d => d.id === id)).filter(Boolean)
    .sort((a, b2) => String((b2.data || {}).date || b2.created_at).localeCompare(String((a.data || {}).date || a.created_at)));
  return { b, d: b.data || {}, live, kept: its.filter(i => i.status === 'kept'), council, mem, chair: mem.find(m => m.role === 'chair'), lrs, assets };
}
const lqbBi = (vi, en, cls = '') => el('div', { className: 'bi ' + cls }, [el('div', { textContent: vi }), en ? el('div', { className: 'en', textContent: en }) : '']);
function lqbHead(key, titleVi, titleEn, no, date, sub) {
  return el('div', {}, [
    el('div', { className: 'lqh' }, [
      el('div', { className: 'lqco' }, [el('b', { textContent: 'Công ty TNHH Liên Doanh Khách Sạn Plaza' }), el('div', { textContent: 'Plaza Hotel Company Limited' })]),
      LQB_TT200[key] ? el('div', { className: 'lqtt' }, [el('b', { textContent: LQB_TT200[key] }), el('div', { textContent: '(Ban hành theo Thông tư số 200/2014/TT-BTC' }),
        el('div', { textContent: 'Ngày 22/12/2014 của Bộ Tài chính)' })]) : '']),
    el('h1', {}, [el('div', { textContent: titleVi }), el('div', { className: 'en', textContent: titleEn })]),
    sub ? lqbBi(sub[0], sub[1], 'c') : '',
    el('div', { className: 'lqno' }, [...(no ? [el('div', { textContent: `Số/No: ${no}` })] : []), el('div', { textContent: `Ngày/Date: ${lqD(date)}` })])]);
}
function lqbMembers(c) {
  if (!c.mem.length) return el('div', { className: 'lqwarn', textContent: t('lqb.noMembers') });
  return el('div', { className: 'lqmem' }, c.mem.flatMap(m => { const r = lqMemRep(m); const n = String(m.full_name || '').toUpperCase();
    return [el('div', { textContent: `Ông/Bà: ${n}` }), el('div', { textContent: `Chức vụ: ${m.position_vi || ''}` }), el('div', { textContent: `Đại diện: ${r[0]}` }),
            el('div', { className: 'en', textContent: `Mr./Mrs. ${n}` }), el('div', { className: 'en', textContent: `Position: ${m.position_en || ''}` }),
            el('div', { className: 'en', textContent: `Represent: ${r[1]}` })]; }));
}
const lqbLrBasis = c => c.lrs.map(d => lqbBi(`Căn cứ theo Đề nghị thanh lý tài sản - Disposal form No.: ${d.doc_no} ngày ${lqD((d.data || {}).date)};`,
  `According to the Asset Liquidation Request - Disposal form No.: ${d.doc_no} dated ${lqD((d.data || {}).date)};`));
const lqbSec = (vi, en) => el('div', { className: 'lqsec' }, [el('b', { textContent: vi }), en ? el('span', { className: 'en', textContent: ' / ' + en }) : '']);
// A signature row: [[label vi/en, name]...]
const lqbSigns = boxes => el('div', { className: 'lqsigns', style: `grid-template-columns:repeat(${boxes.length},1fr)` },
  boxes.map(([vi, en, name]) => el('div', { className: 'lqsign' }, [el('b', { textContent: vi }), el('div', { className: 'en', textContent: en }), el('div', { className: 'sp' }), el('div', { className: 'nm', textContent: name || '' })])));
// A table: cols [[header vi/en, get(item, i), cls, width]]; groups: [[label, span]] above.
function lqbTable(cols, rows, o = {}) {
  const tb = el('table', { className: 'lqt' });
  tb.append(el('colgroup', {}, cols.map(c => el('col', { style: c[3] ? `width:${c[3]}` : '' }))));
  if (o.groups) tb.append(el('tr', {}, o.groups.map(([g, n, rs]) => el('th', { colSpan: n, rowSpan: rs || 1, textContent: g }))));
  tb.append(el('tr', {}, cols.filter(c => !c[4]).map(c => el('th', { textContent: c[0] }))));
  rows.forEach((r, i) => tb.append(el('tr', {}, cols.map(c => el('td', { className: c[2] || '', textContent: c[1](r, (o.start || 0) + i) ?? '' })))));
  if (o.total) tb.append(el('tr', { className: 'tot' }, o.total));
  return tb;
}
// Paged: the first page carries the head, the rest carry the table on; the last one the foot.
function lqbPages(land, head, rows, table, foot, first, next) {
  const pages = [];
  let at = 0;
  do {
    const n = pages.length ? next : first, chunk = rows.slice(at, at + n);
    const last = at + n >= rows.length;
    pages.push(el('div', { className: 'fpage lqpage' + (land ? ' land' : '') }, [...(pages.length ? [el('div', { className: 'lqcont', textContent: t('lqb.cont') })] : head),
      table(chunk, at, last), ...(last ? foot : [])]));
    at += n;
  } while (at < rows.length);
  return pages;
}

function lqbForm(k, c) {
  const { b, d, live } = c;
  const A = id => c.assets.get(id) || {};
  const chairName = c.chair ? String(c.chair.full_name).toUpperCase() : '';
  const ref = (i) => (LQ.docs.find(x => x.id === i.lr_doc_id) || {}).doc_no || '';
  if (k === '02') {
    const cols = [['STT / No.', (r, i) => i + 1, 'c', '6%'], ['Tên tài sản / Asset Name', r => r.name, '', '34%'], ['Mã tài sản / Asset Code', r => r.asset_code || 'N/A', '', '22%'],
      ['SL / Qnt.', r => fmtNum(r.qty), 'n', '8%'], ['Bộ phận / Dept.', r => r.dept_code, 'c', '9%'], ['Đề nghị / Request', r => ref(r), '', '21%']];
    const head = [lqbHead(k, 'BIÊN BẢN HỌP HỘI ĐỒNG THANH LÝ TSCĐ', 'MINUTES OF THE ASSET LIQUIDATION COUNCIL MEETING', b.code, b.meeting_date),
      lqbSec('I. Thông tin cuộc họp', 'Meeting Information:'), lqbBi('1. Thành phần tham dự buổi họp:', 'Attendance:'), lqbMembers(c),
      lqbBi(`2. Cuộc họp diễn ra tại: ${b.meeting_place || '…………'}`, 'The meeting took place at the address above'),
      lqbBi(`3. Thời gian cuộc họp: ${b.meeting_time || '…………'}`, 'Meeting time'),
      lqbSec('II. Nội dung cuộc họp', 'Meeting Details:'), ...lqbLrBasis(c),
      lqbBi('Hội đồng thanh lý tài sản và các thành viên cuộc họp xem xét nguyên nhân và các phương án thanh lý TSCĐ chi tiết như sau:',
            'The asset liquidation council and members of the meeting shall consider the causes and options for liquidation of fixed assets in detail as follows:'),
      lqbBi(`Về nguyên nhân thanh lý tài sản: ${d.causes_vi || '…………'}`, `Regarding the causes of asset liquidation: ${d.causes_en || '…………'}`),
      lqbBi(`Về phương án thanh lý tài sản: ${d.plan_vi || '…………'}`, `Regarding the asset liquidation plan: ${d.plan_en || '…………'}`),
      lqbBi(`Danh sách tài sản xem xét (${live.length} món):`, `Assets considered (${live.length} item(s)):`)];
    const foot = [
      ...(c.kept.length ? [lqbBi(`Hội đồng giữ lại, không thanh lý: ${c.kept.map(i => `${i.asset_code || i.name} (${i.keep_note || ''})`).join('; ')}`,
                                 `Kept by the council, not liquidated: ${c.kept.map(i => i.asset_code || i.name).join('; ')}`)] : []),
      lqbSec('III. Kết luận cuộc họp', 'Meeting Conclusion:'),
      lqbBi('Hội đồng thanh lý và các thành viên cuộc họp nhất trí với các nội dung sau:', 'The liquidation council and meeting members unanimously agree on the following contents:'),
      lqbBi('- Chấp thuận với nguyên nhân thanh lý TSCĐ;', '- Approving the reasons for asset liquidation;'),
      lqbBi('- Không có ý kiến khác với phương án thanh lý TSCĐ.', '- No different opinions regarding the asset liquidation plan.'),
      ...(d.conclusion_vi || d.conclusion_en ? [lqbBi(d.conclusion_vi || '', d.conclusion_en || '')] : []),
      lqbSigns([['Các thành viên cuộc họp', 'Attendances', c.mem.filter(m => m.role !== 'chair').map(m => String(m.full_name).toUpperCase()).join(' · ')],
                ['Chủ tịch hội đồng thanh lý / Chủ trì cuộc họp', 'Chairman of the Council', chairName]])];
    return lqbPages(false, head, live, (rows, at) => lqbTable(cols, rows, { start: at }), foot, 8, 34);
  }
  if (k === '03') {
    const cols = [['STT / No.', (r, i) => i + 1, 'c', '6%'], ['Tên tài sản / Asset Name', r => r.name, '', '25%'], ['Mã tài sản / Asset Code', r => r.asset_code || 'N/A', '', '19%'],
      ['SL / Qnt.', r => fmtNum(r.qty), 'n', '7%'], ['Mã hiệu / Model', r => A(r.asset_id).spec_model || '', '', '11%'], ['Nước sx / Country', r => A(r.asset_id).origin_iso2 || '', 'c', '8%'],
      ['Năm sx / Year', r => A(r.asset_id).spec_mfg_year || '', 'c', '7%'], ['Bộ phận / Dept.', r => r.dept_code, 'c', '8%'],
      ['Năm đưa vào sd / Being used from', r => { const a = A(r.asset_id); return String(a.in_use_date || a.purchase_date || '').slice(0, 4); }, 'c', '9%']];
    const head = [lqbHead(k, 'QUYẾT ĐỊNH', 'DECISION', b.code, b.decision_date || b.meeting_date, ['Về việc thanh lý tài sản cố định', 'Regarding the Asset Liquidation']),
      lqbBi('Căn cứ vào hướng dẫn của Thông tư số 45/2013/TT-BTC của Bộ Tài Chính;', 'Pursuant to Circular 45/2013/TT-BTC dated April 25, 2013, by the Ministry of Finance;'),
      ...lqbLrBasis(c),
      lqbBi(`Căn cứ quyền hạn theo Quyết định thành lập hội đồng thanh lý số ${c.council ? c.council.decision_no : '…'}, ngày ${lqD(c.council && c.council.decision_date)};`,
            `Pursuant to the Asset Liquidation Council Establishment Decision No. ${c.council ? c.council.decision_no : '…'} dated ${lqD(c.council && c.council.decision_date)};`),
      lqbBi(`Căn cứ vào Biên bản họp hội đồng thanh lý tài sản số ${b.code}, ngày ${lqD(b.meeting_date)}.`,
            `Pursuant to the Minutes of the Asset Liquidation Council Meeting No. ${b.code}, dated ${lqD(b.meeting_date)}.`),
      lqbSec('Quyết định các vấn đề sau', 'Decides on the following issues:'), lqbSec('Điều 1', 'Article 1:'),
      lqbBi('Thanh lý các tài sản sau:', 'To liquidate the following assets:')];
    const foot = [lqbSec('Điều 2', 'Article 2:'),
      lqbBi('Ban thanh lý tài sản và các phòng ban có liên quan có trách nhiệm thi hành quyết định này.', 'The Asset Liquidation Committee and related departments are responsible for implementing this decision.'),
      lqbSigns([['Nơi nhận', 'Recipients:', ''], ['TỔNG GIÁM ĐỐC', 'GENERAL MANAGER', chairName]])];
    return lqbPages(false, head, live, (rows, at, last) => lqbTable(cols, rows, { start: at,
      total: last ? [el('td', { colSpan: 3, textContent: 'Tổng cộng / Total' }), el('td', { className: 'n', textContent: fmtNum(pmSum(live, 'qty')) }), el('td', { colSpan: 5 })] : null }), foot, 12, 34);
  }
  if (k === '04') {
    const cq = r => r.count_found == null ? null : n0(r.count_qty), ratio = r => n0(r.qty) ? (cq(r) ?? 0) / n0(r.qty) : 0;
    const co = r => cq(r) == null ? null : n0(r.original_value) * ratio(r), cr = r => cq(r) == null ? null : n0(r.nbv) * ratio(r);
    const cols = [['A', (r, i) => i + 1, 'c', '4%', 1], ['B', r => r.name, '', '17%', 1], ['C', r => r.asset_code || 'N/A', '', '13%', 1], ['D', r => r.dept_code, 'c', '5%', 1],
      ['SL / Qnt.', r => fmtNum(r.qty), 'n', '5%'], ['Nguyên giá / Original Cost', r => lqN(r.original_value), 'n', '8%'], ['Giá trị còn lại / Residual Value', r => lqN(r.nbv), 'n', '8%'],
      ['SL / Qnt.', r => cq(r) == null ? '' : fmtNum(cq(r)), 'n', '5%'], ['Nguyên giá / Original Cost', r => lqN(co(r)), 'n', '8%'], ['Giá trị còn lại / Residual Value', r => lqN(cr(r)), 'n', '8%'],
      ['SL / Qnt.', r => cq(r) == null ? '' : fmtNum(cq(r) - n0(r.qty)), 'n', '5%'], ['Nguyên giá / Original Cost', r => co(r) == null ? '' : lqN(co(r) - n0(r.original_value)), 'n', '7%'],
      ['Giá trị còn lại / Residual Value', r => cr(r) == null ? '' : lqN(cr(r) - n0(r.nbv)), 'n', '7%'],
      ['Ghi chú / Notes', r => [r.count_found === false ? 'Không thấy / Not found' : '', r.count_note || ''].filter(Boolean).join(' — '), '', '', 1]];
    const groups = [['STT / No.', 1, 2], ['Tên TSCĐ / Asset Name', 1, 2], ['Mã số / Asset Code', 1, 2], ['Bộ phận / Dept.', 1, 2], ['Theo sổ kế toán / Accounting Books', 3],
      ['Theo sổ kiểm kê / Asset Count', 3], ['Chênh lệch / Difference', 3], ['Ghi chú / Notes', 1, 2]];
    const head = [lqbHead(k, 'BIÊN BẢN KIỂM KÊ TÀI SẢN', 'MINUTES OF ASSET COUNT', b.code, b.count_date),
      lqbBi('Ban kiểm kê gồm:', 'Asset Count Committee Comprises:'), lqbMembers(c), lqbBi('Đã kiểm kê TSCĐ, kết quả như sau:', 'The fixed assets were inventoried, with the following results:')];
    const sum = f => lqN(live.reduce((s, r) => s + n0(f(r)), 0));
    const foot = [lqbSigns([['Tổng Giám đốc', 'General Manager', chairName], ['Kế toán trưởng', 'Chief Accountant', ''], ['Trưởng Ban kiểm kê', 'Head of Committee', '']])];
    return lqbPages(true, head, live, (rows, at, last) => lqbTable(cols, rows, { start: at, groups,
      total: last ? [el('td', { colSpan: 4, textContent: 'Tổng cộng / Total' }), el('td'), el('td', { className: 'n', textContent: sum(r => r.original_value) }), el('td', { className: 'n', textContent: sum(r => r.nbv) }),
        el('td'), el('td', { className: 'n', textContent: sum(co) }), el('td', { className: 'n', textContent: sum(cr) }), el('td'),
        el('td', { className: 'n', textContent: sum(r => co(r) == null ? 0 : co(r) - n0(r.original_value)) }), el('td', { className: 'n', textContent: sum(r => cr(r) == null ? 0 : cr(r) - n0(r.nbv)) }), el('td')] : null }),
      foot, 6, 20);
  }
  if (k === '05') {
    const df = r => r.reval_value == null ? null : Number(r.reval_value) - n0(r.nbv);
    const cols = [['', (r, i) => i + 1, 'c', '5%', 1], ['', r => r.name, '', '24%', 1], ['', r => r.asset_code || 'N/A', '', '16%', 1],
      ['Nguyên giá / Original Cost', r => lqN(r.original_value), 'n', '10%'], ['Hao mòn lũy kế / Depreciation', r => lqN(r.depreciation), 'n', '10%'],
      ['Giá trị còn lại / Residual Value', r => lqN(r.nbv), 'n', '10%'], ['', r => lqN(r.reval_value), 'n', '11%', 1],
      ['Tăng / Increase', r => df(r) > 0 ? lqN(df(r)) : '', 'n', '7%'], ['Giảm / Decrease', r => df(r) < 0 ? lqN(-df(r)) : '', 'n', '7%']];
    const groups = [['STT / No.', 1, 2], ['Tên tài sản / Asset Name', 1, 2], ['Mã Tài sản / Asset Code', 1, 2], ['Giá trị đang ghi sổ / Book Value', 3],
      ['Đánh giá lại giá trị còn lại / Revaluated Residual Value', 1, 2], ['Chênh lệch / Difference', 2]];
    const head = [lqbHead(k, 'BIÊN BẢN ĐÁNH GIÁ LẠI TÀI SẢN', 'MINUTES OF ASSETS REVALUATION', b.code, b.valuation_date),
      lqbBi(`- Căn cứ Quyết định số: ${b.code}, ngày ${lqD(b.decision_date || b.meeting_date)} của Hội Đồng Thanh Lý TSCĐ về việc đánh giá lại TSCĐ`,
            `- Pursuant to Decision No. ${b.code}, dated ${lqD(b.decision_date || b.meeting_date)}, by the Asset Liquidation Council regarding the revaluation of fixed assets.`),
      lqbMembers(c), lqbBi('Đã thực hiện đánh giá lại giá trị các TSCĐ sau đây:', 'The revaluation of the following fixed assets has been carried out:')];
    const s = f => lqN(live.reduce((a, r) => a + n0(f(r)), 0));
    const foot = [lqbSigns([['Chủ tịch Hội đồng thanh lý', 'Chairman of the Council', chairName], ['Các thành viên hội đồng thanh lý', 'Consented by', ''], ['Kế toán trưởng', 'Chief Accountant JVC', '']])];
    return lqbPages(true, head, live, (rows, at, last) => lqbTable(cols, rows, { start: at, groups,
      total: last ? [el('td', { colSpan: 3, textContent: 'Tổng cộng / Total' }), el('td', { className: 'n', textContent: s(r => r.original_value) }), el('td', { className: 'n', textContent: s(r => r.depreciation) }),
        el('td', { className: 'n', textContent: s(r => r.nbv) }), el('td', { className: 'n', textContent: s(r => r.reval_value) }),
        el('td', { className: 'n', textContent: s(r => Math.max(0, n0(df(r)))) }), el('td', { className: 'n', textContent: s(r => Math.max(0, -n0(df(r)))) })] : null }), foot, 7, 22);
  }
  // 06 — the liquidation minutes; results (buyer, value) come in phase 3.
  const cols = [['', (r, i) => i + 1, 'c', '4%', 1], ['', r => r.name, '', '18%', 1], ['', r => fmtNum(r.qty), 'n', '5%', 1], ['', r => r.asset_code || 'N/A', '', '13%', 1],
    ['Mã hiệu / Model', r => A(r.asset_id).spec_model || '', '', '9%'], ['Năm sx / Year', r => A(r.asset_id).spec_mfg_year || '', 'c', '6%'], ['Nước sx / Country', r => A(r.asset_id).origin_iso2 || '', 'c', '6%'],
    ['', r => { const a = A(r.asset_id); return String(a.in_use_date || a.purchase_date || '').slice(0, 4); }, 'c', '7%', 1], ['', r => r.dept_code, 'c', '6%', 1],
    ['', r => lqN(r.original_value), 'n', '9%', 1], ['', r => lqN(r.depreciation), 'n', '8%', 1], ['', r => lqN(r.nbv), 'n', '9%', 1]];
  const groups = [['STT / No.', 1, 2], ['Tên tài sản / Asset Name', 1, 2], ['SL / Qnt.', 1, 2], ['Số hiệu TSCĐ / Asset Code', 1, 2], ['Thông số kỹ thuật / Specification', 3],
    ['Năm đưa vào sử dụng / Year Usage', 1, 2], ['Thuộc bộ phận / Dept.', 1, 2], ['Nguyên giá / Original Cost', 1, 2], ['Giá trị hao mòn / Depreciation', 1, 2], ['Giá trị còn lại / Residual', 1, 2]];
  const rcols = [['#', (r, i) => i + 1, 'c', '4%'], ['Tên tài sản / Item', r => r.name, '', '22%'], ['SL', r => fmtNum(r.qty), 'n', '5%'], ['Mã tài sản / Asset Code', r => r.asset_code || 'N/A', '', '14%'],
    ['Bên thu mua — Họ tên / Bidder — Name', r => r.buyer || '', '', '16%'], ['ID / CMND / MST', r => r.buyer_id || '', '', '11%'], ['Thuộc phòng ban', r => r.dept_code, 'c', '7%'],
    ['Giá trị thanh lý (thu hồi) / Liquidation value', r => lqN(r.sale_value), 'n', '11%'], ['Chi phí thanh lý (nếu có) / Outstanding exps', r => lqN(r.sale_cost), 'n', '10%']];
  const head = [lqbHead(k, 'BIÊN BẢN THANH LÝ TÀI SẢN', 'MINUTES OF ASSET LIQUIDATION', b.code, b.liquidation_date),
    lqbBi(`- Căn cứ Quyết định số: ${b.code}, ngày ${lqD(b.decision_date || b.meeting_date)} của Hội Đồng Thanh Lý TSCĐ về việc thanh lý TSCĐ`,
          `- Pursuant to Decision No. ${b.code}, dated ${lqD(b.decision_date || b.meeting_date)}, by the Asset Liquidation Council regarding the liquidation of fixed assets.`),
    lqbSec('I. Ban thanh lý TSCĐ gồm', 'Liquidation Committee Comprises:'), lqbMembers(c),
    lqbSec('II. Tiến hành thanh lý TSCĐ', 'Proceed with the Liquidation of Fixed Assets:')];
  // Items not found at the count are not liquidated: they stay out of this form (lost, set when the batch closes).
  const rows6 = live.filter(r => r.count_found !== false);
  const s = f => lqN(rows6.reduce((a, r) => a + n0(f(r)), 0));
  const cost = rows6.reduce((a, r) => a + n0(r.sale_cost), 0), got = rows6.reduce((a, r) => a + n0(r.sale_value), 0);
  const settled = rows6.some(r => r.outcome);
  const foot = [lqbSec('III. Kết quả thanh lý TSCĐ', 'Results:'),
    lqbTable(rcols.map(c => c[0].startsWith('Bên thu mua') ? [c[0], r => r.outcome === 'destroy' ? 'Huỷ / Destroyed' : r.buyer || '', c[2], c[3]] : c), rows6, {
      total: [el('td', { colSpan: 7, textContent: 'Tổng cộng / Total' }), el('td', { className: 'n', textContent: lqN(got) }), el('td', { className: 'n', textContent: lqN(cost) })] }),
    lqbBi(`- Tổng chi phí thanh lý TSCĐ (viết bằng chữ): ${settled ? (cost ? lqWordsVi(cost) : 'Không có') : '…………'}`,
          `- Total cost of fixed asset liquidation: ${settled ? (cost ? lqWordsEn(cost) : 'None') : '…………'}`),
    lqbBi(`- Tổng giá trị thu hồi (viết bằng chữ): ${settled ? lqWordsVi(got) : '…………'}`, `- Total residual value: ${settled ? lqWordsEn(got) : '…………'}`),
    lqbBi(`- Đã ghi giảm sổ TSCĐ ngày ${b.status === 'closed' ? lqD(b.liquidation_date) : '…… tháng …… năm ……'}`, `- Liquidation confirmed on ${b.status === 'closed' ? lqD(b.liquidation_date) : ''}`),
    lqbSigns([['Chủ tịch Hội đồng thanh lý tài sản', 'Chairman of the Council', chairName], ['Các thành viên hội đồng thanh lý tài sản', 'Consented by', ''], ['Kế toán trưởng', 'Chief Accountant JVC', '']])];
  return lqbPages(true, head, rows6, (rows, at, last) => lqbTable(cols, rows, { start: at, groups,
    total: last ? [el('td', { colSpan: 2, textContent: 'Tổng cộng / Total' }), el('td', { className: 'n', textContent: fmtNum(pmSum(rows6, 'qty')) }), el('td', { colSpan: 6 }),
      el('td', { className: 'n', textContent: s(r => r.original_value) }), el('td', { className: 'n', textContent: s(r => r.depreciation) }), el('td', { className: 'n', textContent: s(r => r.nbv) })] : null }),
    foot, 6, 16);
}

/* Phase 3 forms. 07: the buyer's quotation letter, as typed on the portal.
   08: minutes of the opening — who of the council was there, every quotation
   item by item, what was chosen. GP: the gate pass of a winning buyer (buyer,
   security, head of department sign). 11: the handover minutes of a winning buyer. */
function lqbForm3(k, c, q) {
  const { b } = c, d = (q && q.data) || {};
  const chairName = c.chair ? String(c.chair.full_name).toUpperCase() : '';
  const qty = r => n0(r.count_qty ?? r.qty);
  const buyerBlock = () => el('div', { className: 'lqbuyer' }, [
    lqbBi(`${d.kind === 'company' ? 'Tên doanh nghiệp' : 'Họ tên'}: ${d.name || ''}`, d.kind === 'company' ? 'Company name' : 'Full name'),
    lqbBi(d.kind === 'company' ? `Mã số thuế: ${d.tax_code || ''}${d.representative ? ' · Người đại diện: ' + d.representative : ''}` : `Số CCCD: ${d.id_no || ''}`,
          d.kind === 'company' ? 'Tax code · Representative' : 'ID card number'),
    lqbBi(`Địa chỉ: ${d.address || ''}`, 'Address'), lqbBi(`Điện thoại: ${d.phone || ''}${d.email ? ' · Email: ' + d.email : ''}`, d.kind === 'company' ? 'Phone · Invoice e-mail' : 'Phone · E-mail')]);
  if (k === '07') {
    const items = c.live.filter(r => lqPrice(q, r.id) > 0);
    const tot = items.reduce((a, r) => a + lqPrice(q, r.id) * qty(r), 0);
    const cols = [['STT / No.', (r, i) => i + 1, 'c', '7%'], ['Tên tài sản / Item', r => r.name, '', '33%'], ['Mã tài sản / Asset Code', r => r.asset_code || 'N/A', '', '20%'],
      ['SL / Qnt.', r => `${fmtNum(qty(r))} ${r.unit || ''}`, 'n', '10%'], ['Đơn giá / Unit price (VND)', r => lqN(lqPrice(q, r.id)), 'n', '15%'],
      ['Thành tiền / Amount (VND)', r => lqN(lqPrice(q, r.id) * qty(r)), 'n', '15%']];
    return lqbPages(false, [lqbHead(k, 'THƯ BÁO GIÁ', 'QUOTATION LETTER', b.code, q.submitted_at),
      lqbBi('Kính gửi: Công ty TNHH Liên Doanh Khách Sạn Plaza — Hội đồng thanh lý tài sản', 'To: Plaza Hotel Company Limited — Asset Liquidation Council'),
      lqbSec('Thông tin bên chào mua', 'Buyer:'), buyerBlock(),
      lqbBi('Sau khi xem tài sản thực tế, chúng tôi chào mua các tài sản thanh lý với giá như sau:', 'Having seen the assets, we offer to buy the liquidated assets at the following prices:')],
      items, (rows, at, last) => lqbTable(cols, rows, { start: at, total: last ? [el('td', { colSpan: 5, textContent: 'Tổng cộng / Total' }), el('td', { className: 'n', textContent: lqN(tot) })] : null }),
      [lqbBi(`Bằng chữ: ${lqWordsVi(tot)}`, `In words: ${lqWordsEn(tot)}`),
       lqbBi(`Chi phí thanh lý / thu gom: ${d.cost ? lqN(d.cost) + ' VND' : 'Không có'}`, `Liquidation / collection cost: ${d.cost ? lqN(d.cost) + ' VND' : 'None'}`),
       ...(d.note ? [lqbBi(`Ghi chú: ${d.note}`, 'Note')] : []),
       lqbBi('Chúng tôi xác nhận thông tin trên là đúng và cam kết mua theo giá đã chào nếu được chọn.', 'We confirm the information above and commit to buy at the prices offered if selected.'),
       lqbSigns([['', '', ''], ['Bên chào mua', 'Buyer', String(d.name || '').toUpperCase()]])], 18, 34);
  }
  if (k === '08') {
    const quotes = (c.quotes || []), att = new Map(((c.bids || {}).attend || []).map(a => [a.member_id, a]));
    const here = c.mem.filter(m => (att.get(m.id) || {}).present), away = c.mem.filter(m => att.has(m.id) && !att.get(m.id).present);
    const rows = c.live.filter(r => r.count_found !== false);
    const w = Math.max(6, Math.floor(40 / Math.max(1, quotes.length)));
    const cols = [['STT', (r, i) => i + 1, 'c', '4%'], ['Tên tài sản / Item', r => r.name, '', '17%'], ['Mã TS / Code', r => r.asset_code || 'N/A', '', '11%'],
      ['SL / Qnt.', r => fmtNum(qty(r)), 'n', '5%'], ['Giá sàn / Floor', r => lqN(r.reval_value), 'n', '8%'],
      ...quotes.map(qq => [qq.data.name || qq.buyer.name, r => { const p = lqPrice(qq, r.id); return p > 0 ? lqN(p) : '—'; }, 'n', w + '%']),
      ['Chọn / Chosen', r => r.outcome === 'destroy' ? 'Huỷ / Destroy' : r.buyer || '', '', '12%'], ['Giá trị / Value', r => lqN(r.sale_value), 'n', '9%']];
    return lqbPages(true, [lqbHead(k, 'BIÊN BẢN MỞ THẦU THANH LÝ TÀI SẢN', 'MINUTES OF THE LIQUIDATION BID OPENING', b.code, b.opened_at),
      lqbBi(`Thời điểm mở thầu: ${b.opened_at ? fmtDateTime(b.opened_at) : '…………'} · Hạn nộp báo giá: ${b.call_deadline ? fmtDateTime(b.call_deadline) : '…………'}`, 'Opening time · Quotation deadline'),
      lqbSec('I. Thành viên hội đồng có mặt', `Council members present (${here.length}/${c.mem.length}):`),
      el('div', { className: 'lqmem2' }, here.map(m => el('div', { textContent: `${String(m.full_name).toUpperCase()} — ${m.position_vi || ''} / ${m.position_en || ''}` }))),
      ...(away.length ? [lqbBi(`Vắng mặt: ${away.map(m => m.full_name).join(', ')}`, 'Absent')] : []),
      lqbSec('II. Các báo giá đã nộp', `Quotations submitted (${quotes.length}):`),
      el('div', { className: 'lqmem2' }, quotes.map((qq, i) => el('div', { textContent: `${i + 1}. ${qq.data.name || qq.buyer.name} · ${lqBuyerId(qq.data)} · ${fmtDateTime(qq.submitted_at)}` }))),
      ...(b.open_note ? [lqbBi(`Giải trình (ít hơn 3 báo giá): ${b.open_note}`, 'Explanation (fewer than 3 quotations)')] : []),
      lqbSec('III. So sánh giá và kết quả', 'Price comparison and result (unit prices, VND):')],
      rows, (rr, at, last) => lqbTable(cols, rr, { start: at, total: last ? [el('td', { colSpan: 5 + quotes.length + 1, textContent: 'Tổng giá trị thu hồi / Total' }),
        el('td', { className: 'n', textContent: lqN(rows.reduce((a, r) => a + n0(r.sale_value), 0)) })] : null }),
      [...rows.filter(r => r.award_note).map(r => lqbBi(`${r.asset_code || r.name}: ${r.award_note}`, '')),
       lqbBi('Nguyên tắc: chọn giá cao nhất hợp lệ, đã được Hội đồng đánh giá tính hợp lý và so sánh với giá thị trường.',
             'Rule: the highest valid price, assessed as reasonable by the council against the market price.'),
       lqbSigns(here.map(m => [m.role === 'chair' ? 'Chủ tịch hội đồng' : 'Thành viên hội đồng', m.role === 'chair' ? 'Chairman' : 'Member', String(m.full_name).toUpperCase()]))], 6, 18);
  }
  const mine = c.live.filter(r => r.outcome === 'sale' && r.sale_quote_id === q.id);
  const tot = mine.reduce((a, r) => a + n0(r.sale_value), 0);
  if (k === 'GP') {
    const cols = [['STT / No.', (r, i) => i + 1, 'c', '8%'], ['Tên tài sản / Item', r => r.name, '', '42%'], ['Mã tài sản / Asset Code', r => r.asset_code || 'N/A', '', '25%'],
      ['SL / Qnt.', r => `${fmtNum(qty(r))} ${r.unit || ''}`, 'n', '15%']];
    return lqbPages(false, [lqbHead(k, 'GIẤY RA CỔNG — HÀNG THANH LÝ', 'GATE PASS — LIQUIDATED ASSETS', b.code, q.gate_date),
      lqbBi(`Đợt thanh lý: ${b.code} · Hoá đơn GTGT số: ${q.invoice_no || '…………'}${q.invoice_date ? ' ngày ' + lqD(q.invoice_date) : ''}`, 'Liquidation batch · VAT invoice'),
      lqbSec('Người nhận hàng (bên mua)', 'Receiver (buyer):'), buyerBlock(),
      lqbBi('Được phép mang ra khỏi khách sạn các tài sản sau:', 'Is allowed to take the following assets out of the hotel:')],
      mine, (rows, at) => lqbTable(cols, rows, { start: at }),
      [lqbBi('Phương tiện / biển số xe: ……………………   Giờ ra: ……………', 'Vehicle / plate number · Time out'),
       lqbSigns([['Người nhận hàng', 'Receiver (buyer)', String(d.name || '').toUpperCase()], ['Bảo vệ', 'Security', ''], ['Trưởng bộ phận', 'Head of Department', '']])], 18, 34);
  }
  // 11 — handover minutes.
  const cols = [['STT / No.', (r, i) => i + 1, 'c', '6%'], ['Tên tài sản / Item', r => r.name, '', '30%'], ['Mã tài sản / Asset Code', r => r.asset_code || 'N/A', '', '20%'],
    ['SL / Qnt.', r => `${fmtNum(qty(r))} ${r.unit || ''}`, 'n', '10%'], ['Đơn giá / Unit price', r => lqN(r.sale_price), 'n', '16%'], ['Thành tiền / Amount', r => lqN(r.sale_value), 'n', '18%']];
  return lqbPages(false, [lqbHead(k, 'BIÊN BẢN GIAO NHẬN TÀI SẢN THANH LÝ', 'MINUTES OF HANDOVER OF LIQUIDATED ASSETS', b.code, q.handover_date),
    lqbBi(`Căn cứ Quyết định thanh lý số ${b.code} ngày ${lqD(b.decision_date || b.meeting_date)} và kết quả mở thầu ngày ${lqD(b.opened_at)};`,
          `Pursuant to Liquidation Decision No. ${b.code} dated ${lqD(b.decision_date || b.meeting_date)} and the bid opening of ${lqD(b.opened_at)};`),
    lqbSec('Bên giao: Công ty TNHH Liên Doanh Khách Sạn Plaza', 'Deliverer: Plaza Hotel Company Limited'),
    lqbBi('Địa chỉ: 17 Lê Duẩn, phường Sài Gòn, TP.HCM · Đại diện: ……………………', 'Address · Represented by'),
    lqbSec('Bên nhận', 'Receiver:'), buyerBlock(),
    lqbBi('Hai bên thống nhất giao nhận các tài sản thanh lý sau:', 'Both parties agree on the handover of the following liquidated assets:')],
    mine, (rows, at, last) => lqbTable(cols, rows, { start: at, total: last ? [el('td', { colSpan: 5, textContent: 'Tổng cộng / Total' }), el('td', { className: 'n', textContent: lqN(tot) })] : null }),
    [lqbBi(`Bằng chữ: ${lqWordsVi(tot)}`, `In words: ${lqWordsEn(tot)}`),
     lqbBi(`Hoá đơn GTGT số: ${q.invoice_no || '…………'}${q.invoice_date ? ' ngày ' + lqD(q.invoice_date) : ''}`, 'VAT invoice'),
     lqbBi('Bên nhận đã kiểm tra hiện trạng, số lượng và nhận đủ các tài sản trên; tự chịu trách nhiệm tháo dỡ, vận chuyển.',
           'The receiver has checked the condition and quantity, received all the assets above, and is responsible for dismantling and transport.'),
     lqbSigns([['Đại diện bên giao', 'Deliverer', ''], ['Đại diện bên nhận', 'Receiver', String(d.name || '').toUpperCase()]])], 16, 34);
}

// Every page of the chosen forms, fitted to A4 each, as one PDF / a print preview.
async function lqbCapture(b, keys, fmt, out, quoteId) {
  const host = el('div', { className: 'fpdfhost' });
  try {
    msg(out, 'info', t('wf.pdfMaking'));
    await Promise.all(['html2canvas', 'jspdf'].map(snapLib));
    const ids = [...new Set(lqBatchItems(b).map(i => i.asset_id).filter(Boolean))];
    const assets = new Map();
    for (let i = 0; i < ids.length; i += 200)
      for (const a of await SB.select('am_asset', `select=id,asset_code,spec_model,origin_iso2,spec_mfg_year,in_use_date,purchase_date,location_code&id=in.(${ids.slice(i, i + 200).join(',')})`)) assets.set(a.id, a);
    const c = lqbCtx(b, assets);
    if (!c.live.length) throw new Error(t('lqb.noItems'));
    // Quotations for 07 / 08 / gate pass / 11: the opened ones (their prices are sealed before).
    if (keys.some(k => LQ_DOCS3.includes(k))) {
      c.bids = await lqbBidLoad(b);
      c.quotes = (c.bids.buyers || []).filter(v => v.quote && v.quote.opened_at).map(v => Object.assign({ buyer: v }, v.quote));
    }
    document.body.append(host);
    const shots = [];
    for (const k of keys) {
      // Per-buyer forms: every opened quotation (07) / every winning buyer (GP, 11), or just the one asked for.
      const per = k === '07' ? c.quotes : k === 'GP' || k === '11' ? c.quotes.filter(q => c.live.some(r => r.outcome === 'sale' && r.sale_quote_id === q.id)) : [null];
      const list = quoteId ? per.filter(q => q && q.id === quoteId) : per;
      if (k !== '08' && LQ_DOCS3.includes(k) && !list.length) continue;
      for (const q of list) {
        const pages = fsPages(el('div', { className: 'lqsheet print' }, LQ_DOCS3.includes(k) ? lqbForm3(k, c, q) : lqbForm(k, c)));
        for (let i = 0; i < pages.length; i++) {
          host.innerHTML = ''; host.append(pages[i].box);
          const canvas = await html2canvas(pages[i].box, { scale: 2, backgroundColor: '#ffffff', logging: false });
          shots.push({ label: `${b.code} - ${k}`, first: i === 0, doc: `${k} — ${t('lqb.f.' + k)}${q ? ' · ' + (q.data.name || q.buyer.name) : ''}`, land: pages[i].land, canvas });
        }
      }
    }
    if (!shots.length) throw new Error(t('lqq.noDoc'));
    const one = keys.length === 1 && quoteId ? ((c.quotes || []).find(q => q.id === quoteId) || {}).data : null;
    const name = keys.length > 1 ? `${b.code} - ${t('lqb.allName')}` : `${b.code} - ${keys[0]} ${t('lqb.f.' + keys[0])}${one ? ' - ' + one.name : ''}`;
    const file = name.replace(/[\/:*?"<>|]+/g, ' ');
    if (fmt === 'preview') wfCapPreview(wfCapPdf(shots), file); else wfCapPdf(shots).save(file + '.pdf');
    msg(out, 'ok', t('lqb.made', { n: shots.length }));
  } catch (e) { msg(out, 'err', e.message); }
  finally { host.remove(); }
}

/* ------------------------------------------------------------ the count
   Walking the hotel with the tablet: every item of the batch as a card — found
   (with the quantity) or not found, a note. A code or barcode typed or scanned
   in the box on top jumps to its card and, on Enter, counts it as found. */
const LC = { batch: null, items: [], assets: new Map(), q: '' };
async function lcLoad() {
  const out = $('#lcMsg'), body = $('#lcBody');
  msg(out, 'info', t('table.loading'));
  try {
    await wfLookups();
    if (!LQ.batches) await lqLoadBatches();
    const bs = await SB.select('pm_lq_batch', 'select=*&status=eq.decided&order=id');
    if (!bs.length) { body.innerHTML = ''; return msg(out, 'info', t('lc.none')); }
    const b = bs.find(x => x.id === LQ.countBatch) || bs[0];
    LQ.countBatch = b.id;
    const items = await SB.select('pm_lq_item', `select=*&batch_id=eq.${b.id}&status=eq.batched&order=id`);
    const docs = await SB.select('pm_doc', `select=id,doc_no&id=in.(${[...new Set(items.map(i => i.lr_doc_id))].join(',') || 0})`);
    const ids = items.map(i => i.asset_id).filter(Boolean);
    const assets = new Map();
    for (let i = 0; i < ids.length; i += 200)
      for (const a of await SB.select('am_asset', `select=id,barcode,location_code&id=in.(${ids.slice(i, i + 200).join(',')})`)) assets.set(a.id, a);
    Object.assign(LC, { batch: b, batches: bs, items, assets, docs: new Map(docs.map(d => [d.id, d.doc_no])) });
    msg(out, '', '');
    lcRender();
  } catch (e) { msg(out, 'err', e.message); }
}
function lcRender() {
  const body = $('#lcBody'), b = LC.batch;
  body.innerHTML = '';
  $('#pageTitle').textContent = `${t('lc.title')} — ${b.code}`;
  const done = LC.items.filter(i => i.count_found != null).length;
  const top = el('div', { className: 'card lctop' });
  if (LC.batches.length > 1) {
    const s = el('select');
    for (const x of LC.batches) s.append(el('option', { value: x.id, textContent: x.code }));
    s.value = b.id; s.onchange = () => { LQ.countBatch = Number(s.value); lcLoad(); };
    top.append(s);
  }
  const bar = el('div', { className: 'lcprog' }, [el('i', { style: `width:${LC.items.length ? Math.round(done / LC.items.length * 100) : 0}%` })]);
  const scan = el('input', { className: 'lcscan', placeholder: t('lc.scan'), value: LC.q, spellcheck: false, autocapitalize: 'characters' });
  scan.oninput = () => { LC.q = scan.value; lcFilter(); };
  scan.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    const q = scan.value.trim().toUpperCase(); if (!q) return;
    const hit = LC.items.find(i => (i.asset_code || '').toUpperCase() === q || ((LC.assets.get(i.asset_id) || {}).barcode || '').toUpperCase() === q);
    if (!hit) return msg('#lcMsg', 'warn', t('lc.noMatch', { q }));
    if (hit.count_found == null) await lcSet(hit, true, null, hit.count_note);
    LC.q = ''; lcRender();
    const card = document.getElementById('lc-' + hit.id); if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); }
    setTimeout(() => $('.lcscan') && $('.lcscan').focus(), 50);
  };
  top.append(el('div', { className: 'lchead' }, [el('b', { textContent: t('lc.progress', { n: done, of: LC.items.length }) }), bar]), scan);
  if (can('liquidation', 'edit')) top.append(el('button', { className: 'btn pri', type: 'button', textContent: t('lqb.next.decided'), disabled: done < LC.items.length, onclick: async () => {
    if (!confirm(t('lqb.ask.decided', { c: b.code }))) return;
    try { await SB.rpc('pm_lq_batch_move', { p_id: b.id, p_to: 'counted' });
          LQ.flash = t('lqb.moved', { c: b.code, s: t('lqb.st.counted') });
          // Back to the batch on a PC; a tablet has no batch screen, so it stays here and says so.
          if (TB.on) { await lcLoad(); msg('#lcMsg', 'ok', LQ.flash); LQ.flash = null; } else { LQ.tab = 'batch'; LQ.batchOpen = b.id; showView('liq'); } }
    catch (e) { msg('#lcMsg', 'err', e.message); } } }));
  body.append(top);
  const list = el('div', { className: 'lccards' });
  for (const i of LC.items) list.append(lcCard(i));
  body.append(list);
  lcFilter();
}
function lcFilter() {
  const q = hnorm(LC.q);
  for (const i of LC.items) {
    const c = document.getElementById('lc-' + i.id); if (!c) continue;
    const a = LC.assets.get(i.asset_id) || {};
    c.hidden = !!q && !hnorm(`${i.asset_code || ''} ${a.barcode || ''} ${i.name} ${a.location_code || ''}`).includes(q);
  }
}
async function lcSet(i, found, qty, note) {
  try {
    await SB.rpc('pm_lq_count', { p_item: i.id, p_found: found, p_qty: qty, p_note: note || null });
    Object.assign(i, { count_found: found, count_qty: found == null ? null : found ? (qty ?? i.qty) : 0, count_note: found == null ? null : note || null });
    msg('#lcMsg', '', '');
  } catch (e) { msg('#lcMsg', 'err', e.message); }
}
function lcCard(i) {
  const a = LC.assets.get(i.asset_id) || {};
  const st = i.count_found == null ? '' : i.count_found ? (n0(i.count_qty) === n0(i.qty) ? ' ok' : ' diff') : ' miss';
  const qty = el('input', { className: 'lcqty', inputMode: 'decimal', value: i.count_found === false ? '0' : i.count_found ? fmtNum(i.count_qty) : fmtNum(i.qty), disabled: i.kind === 'unique' });
  const note = el('input', { className: 'lcnote', placeholder: t('lc.note'), value: i.count_note || '' });
  const redo = () => { const c = document.getElementById('lc-' + i.id); if (c) c.replaceWith(lcCard(i)); lcHead(); };
  const yes = el('button', { className: 'btn lcyes' + (i.count_found === true ? ' on' : ''), type: 'button', textContent: '✓ ' + t('lc.found'),
    onclick: async () => { await lcSet(i, true, numIn(qty.value), note.value); redo(); } });
  const no = el('button', { className: 'btn lcno' + (i.count_found === false ? ' on' : ''), type: 'button', textContent: '✗ ' + t('lc.missing'),
    onclick: async () => { await lcSet(i, false, 0, note.value); redo(); } });
  note.onchange = qty.onchange = async () => { if (i.count_found != null) { await lcSet(i, i.count_found, i.count_found ? numIn(qty.value) : 0, note.value); redo(); } };
  const undo = i.count_found != null ? el('button', { className: 'btn tiny', type: 'button', textContent: t('lc.undo'), onclick: async () => { await lcSet(i, null); redo(); } }) : '';
  return el('div', { className: 'lccard' + st, id: 'lc-' + i.id }, [
    el('div', { className: 'lcwho' }, [el('code', { textContent: i.asset_code || 'N/A' }), el('b', { textContent: i.name }),
      el('small', { textContent: [LC.docs.get(i.lr_doc_id), i.dept_code, a.location_code, a.barcode].filter(Boolean).join(' · ') })]),
    el('div', { className: 'lcbook', textContent: t('lc.book', { q: `${fmtNum(i.qty)} ${i.unit || ''}` }) }),
    el('div', { className: 'lcact' }, [yes, no, el('label', { className: 'lcql' }, [el('span', { textContent: t('lc.qty') }), qty]), note, undo])]);
}
function lcHead() {
  const done = LC.items.filter(i => i.count_found != null).length;
  const h = $('.lchead b'); if (h) h.textContent = t('lc.progress', { n: done, of: LC.items.length });
  const bar = $('.lcprog i'); if (bar) bar.style.width = `${LC.items.length ? Math.round(done / LC.items.length * 100) : 0}%`;
  const btn = $('.lctop .btn.pri'); if (btn) btn.disabled = done < LC.items.length;
}
// Is there a batch waiting for its count that this person may count (for the tablet bar)?
async function lcCheck() {
  try { LQ.countN = can('liquidation', 'view') ? (await SB.select('pm_lq_batch', 'select=id&status=eq.decided')).length : 0; } catch { LQ.countN = 0; }
}

/* ============================================================ LIQUIDATION — phase 3
   Quotations, opening, result, close (29_liquidation_bid.sql). Buyers quote on
   their own private link (Liquidation.html); the quotations stay sealed until
   the opening, which needs more than half of the council present. Each item
   then goes to a buyer (the highest price is suggested; any other choice needs
   a reason) or is destroyed. Every winning buyer needs a VAT invoice number
   and a gate pass with its three signatures before the batch can close — and
   closing sets the register: sold 7, destroyed 9, same-barcode 23, not found 0. */
const LQ_DOCS3 = ['07', '08', 'GP', '11'];

// Amounts in words for the minutes: Vietnamese as the forms are written, English under it.
function lqWordsVi(n) {
  n = Math.round(Math.abs(Number(n) || 0));
  if (!n) return 'Không đồng';
  const D = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  // One group of three digits; full = a higher group comes before it ("không trăm", "lẻ").
  const three = (x, full) => {
    const h = Math.floor(x / 100), t2 = Math.floor(x / 10) % 10, u = x % 10, w = [];
    if (full || h) w.push(D[h], 'trăm');
    if (t2 > 1) w.push(D[t2], 'mươi'); else if (t2 === 1) w.push('mười'); else if (u && (full || h)) w.push('lẻ');
    if (u) w.push(t2 > 1 && u === 1 ? 'mốt' : t2 >= 1 && u === 5 ? 'lăm' : D[u]);
    return w.join(' ');
  };
  const U = ['', 'nghìn', 'triệu', 'tỷ'], g = [];
  while (n > 0) { g.push(n % 1000); n = Math.floor(n / 1000); }
  const out = [];
  for (let i = g.length - 1; i >= 0; i--) {
    if (!g[i]) continue;
    out.push(three(g[i], i < g.length - 1), i ? U[i % 3 === 0 ? 3 : i % 3] : '');
  }
  const s = out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() + ' đồng';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function lqWordsEn(n) {
  n = Math.round(Math.abs(Number(n) || 0));
  if (!n) return 'Zero dong';
  const A = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
             'sixteen', 'seventeen', 'eighteen', 'nineteen'], T = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const three = x => { const h = Math.floor(x / 100), r = x % 100, w = [];
    if (h) w.push(A[h], 'hundred'); if (r) w.push(r < 20 ? A[r] : T[Math.floor(r / 10)] + (r % 10 ? '-' + A[r % 10] : '')); return w.join(' '); };
  const U = ['', 'thousand', 'million', 'billion', 'trillion'], out = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 1000)) { const g = n % 1000; if (g) out.unshift(three(g) + (U[i] ? ' ' + U[i] : '')); }
  const s = out.join(' ') + ' dong';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function lqbBidLoad(b) {
  try { return await SB.rpc('pm_lq_bid_list', { p_batch: b.id }); } catch (e) { return { error: e.message, buyers: [], attend: [], events: [] }; }
}
const lqPrice = (q, itemId) => { const v = q && q.data && q.data.prices ? q.data.prices[String(itemId)] : null; return v == null || v === '' ? null : Number(v); };
const lqBuyerId = d => d ? (d.kind === 'company' ? d.tax_code : d.id_no) || '' : '';

// The card under the list: quotations, opening, result, buyers' papers, closing.
function lqbBidCard(panel, b) {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('lqq.h') }), el('div', { className: 'dim', textContent: t('table.loading') })]);
  panel.append(card);
  (async () => {
    const bl = await lqbBidLoad(b);
    card.innerHTML = '';
    card.append(el('h2', { textContent: t('lqq.h') }));
    if (bl.error) return card.append(el('div', { className: 'msg warn', textContent: /pm_lq_bid_list|PGRST|404/.test(bl.error) ? t('lqq.notInstalled') : bl.error }));
    lqbBidBody(card, b, bl);
  })();
}

function lqbBidBody(card, b, bl) {
  const edit = can('liquidation', 'edit') && ['valued', 'bidding'].includes(b.status);
  const out = el('div');
  const live = lqBatchItems(b).filter(i => i.status === 'batched' || ['sold', 'destroyed', 'lost'].includes(i.status));
  const quotes = bl.buyers.filter(v => v.quote && v.quote.status === 'submitted').map(v => Object.assign({ buyer: v }, v.quote));
  const opened = !!b.opened_at;
  card.append(out);
  const re = async () => { await lqLoad(); };

  // 1. The call: deadline and instructions.
  if (b.status === 'valued' || (b.status === 'bidding' && !opened)) {
    const dl = el('input', { type: 'datetime-local', value: b.call_deadline ? new Date(new Date(b.call_deadline).getTime() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : '', disabled: !edit });
    const terms = el('textarea', { rows: 3, value: b.call_terms || t('lqq.termsDef'), disabled: !edit });
    card.append(el('h3', { className: 'lqsub', textContent: t('lqq.call') }),
      el('div', { className: 'lqgrid' }, [el('div', { className: 'fld' }, [el('label', { textContent: t('lqq.deadline') }), dl]),
        el('div', { className: 'fld lqwide', style: 'grid-column:span 3' }, [el('label', { textContent: t('lqq.terms') }), terms])]));
    if (edit) card.append(el('div', { className: 'row', style: 'gap:8px;margin-top:6px' }, [
      el('button', { className: 'btn pri', type: 'button', textContent: t(b.status === 'valued' ? 'lqq.callOpen' : 'lqq.callSave'), onclick: async () => {
        if (!dl.value) return msg(out, 'err', t('lqq.needDeadline'));
        try { await SB.rpc('pm_lq_call_open', { p_batch: b.id, p_deadline: new Date(dl.value).toISOString(), p_terms: terms.value }); await re(); }
        catch (e) { msg(out, 'err', e.message); } } }),
      ...(b.status === 'bidding' && !bl.buyers.length ? [el('button', { className: 'btn', type: 'button', textContent: t('lqq.callCancel'), onclick: async () => {
        try { await SB.rpc('pm_lq_call_cancel', { p_batch: b.id }); await re(); } catch (e) { msg(out, 'err', e.message); } } })] : [])]));
  }

  // 2. The buyers invited and where their quotation stands.
  if (b.status !== 'valued') {
    card.append(el('h3', { className: 'lqsub', textContent: t('lqq.buyers', { n: bl.buyers.length, s: quotes.length }) }));
    const linkBox = el('div');
    const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['lqq.b.name', 'lqq.b.contact', 'lqq.b.quote', 'lqq.b.link', ''].map(k => el('th', { textContent: k ? t(k) : '' })))]);
    for (const v of bl.buyers) {
      const q = v.quote;
      const st = !q ? t('lqq.q.none') : q.status === 'submitted' ? t('lqq.q.sub', { d: fmtDateTime(q.submitted_at) }) + (q.opened_at ? '' : ' · 🔒') : t('lqq.q.draft');
      tb.append(el('tr', {}, [el('td', {}, [el('b', { textContent: v.name }), q && q.data && q.data.name && q.data.name !== v.name ? el('small', { className: 'dim', textContent: ' · ' + q.data.name }) : '']),
        el('td', { textContent: [v.phone, v.email].filter(Boolean).join(' · ') }), el('td', { textContent: st }),
        el('td', { className: v.revoked ? 'bad' : '', textContent: v.revoked ? t('lqq.revoked') : t('lqq.until', { d: fmtDate(String(v.expires_at).slice(0, 10)) }) + (v.last_seen_at ? ' · ' + t('lqq.seen') : '') }),
        el('td', { className: 'nowrap' }, edit && !opened ? [
          el('button', { className: 'btn tiny', type: 'button', textContent: t('lqq.newLink'), onclick: async () => {
            try { const tok = await SB.rpc('pm_lq_buyer_set', { p_buyer: v.id, p_days: null, p_revoke: false, p_new_token: true }); lqLinkShow(linkBox, v.name, tok); } catch (e) { msg(out, 'err', e.message); } } }),
          el('button', { className: 'btn tiny', type: 'button', textContent: v.revoked ? t('lqq.unrevoke') : t('lqq.revoke'), onclick: async () => {
            try { await SB.rpc('pm_lq_buyer_set', { p_buyer: v.id, p_days: null, p_revoke: !v.revoked, p_new_token: false }); await re(); } catch (e) { msg(out, 'err', e.message); } } })] : '')]));
    }
    if (!bl.buyers.length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'dim', textContent: t('lqq.noBuyers') })));
    card.append(el('div', { className: 'wrap' }, tb), linkBox);
    if (edit && !opened) {
      const nm = el('input', { placeholder: t('lqq.b.name') }), ph = el('input', { placeholder: t('lqq.b.phone') }), em = el('input', { placeholder: 'Email' });
      card.append(el('div', { className: 'row', style: 'gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:6px' }, [
        el('div', { className: 'fld' }, [el('label', { textContent: t('lqq.b.name') }), nm]), el('div', { className: 'fld' }, [el('label', { textContent: t('lqq.b.phone') }), ph]),
        el('div', { className: 'fld' }, [el('label', { textContent: 'Email' }), em]),
        el('button', { className: 'btn pri', type: 'button', textContent: t('lqq.invite'), onclick: async () => {
          if (!nm.value.trim()) return msg(out, 'err', t('lqq.needName'));
          try { const tok = await SB.rpc('pm_lq_buyer_add', { p_batch: b.id, p_name: nm.value.trim(), p_phone: ph.value.trim(), p_email: em.value.trim(), p_days: 7 });
                const name = nm.value.trim(); await re(); setTimeout(() => { const host = document.querySelector('#lqPanel .lqlinkhost'); if (host) lqLinkShow(host, name, tok); }, 50); }
          catch (e) { msg(out, 'err', e.message); } } })]), el('div', { className: 'lqlinkhost' }));
    }
  }

  // 3. The opening: who of the council is here.
  if (b.status === 'bidding' && !opened) {
    const mem = lqMembersOf(b.council_id);
    const due = !b.call_deadline || new Date(b.call_deadline) <= new Date() || (bl.buyers.filter(v => !v.revoked).length > 0 && bl.buyers.filter(v => !v.revoked).every(v => v.quote && v.quote.status === 'submitted'));
    const boxes = mem.map(m => [m, el('input', { type: 'checkbox' })]);
    const note = el('textarea', { rows: 2, placeholder: t('lqq.fewWhy') });
    const need = Math.floor(mem.length / 2) + 1;
    card.append(el('h3', { className: 'lqsub', textContent: t('lqq.opening') }),
      el('div', { className: 'tdnote', textContent: t('lqq.openHint', { need, of: mem.length }) }),
      el('div', { className: 'lqpresent' }, boxes.map(([m, c]) => el('label', { className: 'chk' }, [c, el('span', { textContent: `${m.full_name} — ${t(m.role === 'chair' ? 'lqc.r.chair' : m.role === 'vice' ? 'lqc.r.vice' : m.permanent ? 'lqc.r.perm' : 'lqc.r.nonperm')}` })]))),
      ...(quotes.length < 3 ? [el('div', { className: 'msg warn', textContent: t('lqq.few', { n: quotes.length }) }), note] : []));
    if (edit) card.append(el('div', { className: 'row', style: 'gap:8px;margin-top:6px' }, [
      el('button', { className: 'btn pri', type: 'button', disabled: !due || !quotes.length, title: due ? '' : t('lqq.notDue'), textContent: t('lqq.open'), onclick: async () => {
        const present = boxes.filter(([, c]) => c.checked).map(([m]) => m.id);
        if (present.length < need) return msg(out, 'err', t('lqq.quorum', { n: present.length, need, of: mem.length }));
        try { await SB.rpc('pm_lq_open', { p_batch: b.id, p_present: present, p_note: note.value.trim() || null }); await re(); msg('#lqMsg', 'ok', t('lqq.opened')); }
        catch (e) { msg(out, 'err', e.message); } } }),
      !due ? el('span', { className: 'dim', textContent: t('lqq.notDue') }) : '']));
  }

  // 4. The result, item by item (destroying needs no quotation; selling needs the opening).
  if (['valued', 'bidding', 'closed'].includes(b.status)) lqbAward(card, b, bl, quotes, live, edit, out);
  // 5. The winners' papers, and closing.
  if (b.status === 'bidding' || b.status === 'closed') lqbWinners(card, b, bl, live, edit, out);
  if (edit) {
    const left = live.filter(i => i.status === 'batched' && i.count_found !== false && !i.outcome).length;
    const date = el('input', { type: 'date', value: b.liquidation_date || new Date().toISOString().slice(0, 10) });
    card.append(el('h3', { className: 'lqsub', textContent: t('lqq.close') }), el('div', { className: 'tdnote', textContent: t('lqq.closeHint') }),
      el('div', { className: 'row', style: 'gap:8px;align-items:flex-end' }, [el('div', { className: 'fld' }, [el('label', { textContent: t('lqb.liqDate') }), date]),
        el('button', { className: 'btn pri', type: 'button', disabled: left > 0, title: left ? t('lqq.left', { n: left }) : '', textContent: t('lqq.closeBtn'), onclick: async () => {
          if (!confirm(t('lqq.closeAsk', { c: b.code }))) return;
          try { await SB.rpc('pm_lq_close', { p_batch: b.id, p_date: date.value || null }); LQ.flash = t('lqq.closed', { c: b.code }); await re(); }
          catch (e) { msg(out, 'err', e.message); } } }),
        left ? el('span', { className: 'dim', textContent: t('lqq.left', { n: left }) }) : '']));
  }
  if ((bl.events || []).length) card.append(el('details', { className: 'lqlog' }, [el('summary', { textContent: t('lqq.log', { n: bl.events.length }) }),
    el('ul', {}, bl.events.map(e => el('li', { textContent: `${fmtDateTime(e.at)} · ${e.actor || ''} · ${t('lqq.ev.' + e.action) === 'lqq.ev.' + e.action ? e.action : t('lqq.ev.' + e.action)}${e.detail ? ' · ' + e.detail : ''}` })))]));
}

function lqLinkShow(host, name, token) {
  const cfg = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify({ url: CFG.url, key: CFG.key })))));
  const link = new URL('Liquidation.html', location.href.split('#')[0]).href + '#c=' + cfg + '&t=' + token;
  const inp = el('input', { value: link, readOnly: true, onclick: () => inp.select() });
  const copy = el('button', { className: 'btn pri', type: 'button', textContent: t('td.copy'), onclick: () => { inp.select(); navigator.clipboard?.writeText(link).catch(() => {}); copy.textContent = t('td.copied'); } });
  host.innerHTML = '';
  host.append(el('div', { className: 'msg ok tdlink' }, [el('b', { textContent: t('lqq.linkFor', { v: name }) }), el('div', { className: 'tdnote', textContent: t('td.linkOnce') }),
    el('div', { className: 'row', style: 'flex-wrap:nowrap' }, [inp, copy])]));
  host.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Items × quotations: each buyer's unit price, the highest marked; the choice, the price, the cost, why.
function lqbAward(card, b, bl, quotes, live, edit, out) {
  const opened = !!b.opened_at, canSet = edit && b.status !== 'closed';
  card.append(el('h3', { className: 'lqsub', textContent: t('lqq.result') }));
  if (!opened && b.status === 'bidding') card.append(el('div', { className: 'tdnote', textContent: t('lqq.sealedHint') }));
  const found = live.filter(i => i.count_found !== false), lost = live.filter(i => i.count_found === false);
  const draft = new Map(found.map(i => [i.id, { outcome: i.outcome || '', quote_id: i.sale_quote_id || '', price: i.sale_price, cost: i.sale_cost, note: i.award_note || '' }]));
  const head = [t('lq.c.code'), t('lq.c.name'), t('lq.c.qty'), t('lqb.c.reval'), ...(opened ? quotes.map(q => q.data.name || q.buyer.name) : []), t('lqq.choice'), t('lqq.price'), t('lqq.value'), t('lqq.cost'), t('lqq.why')];
  const tb = el('table', { className: 'lqbt lqaward' }, [el('tr', {}, head.map((h, i) => el('th', { className: i === 2 || i === 3 || (i >= 4 && i < 4 + (opened ? quotes.length : 0)) || i >= head.length - 3 && i < head.length - 1 ? 'num' : '', textContent: h })))]);
  for (const i of found) {
    const dr = draft.get(i.id), qty = n0(i.count_qty ?? i.qty);
    const prices = opened ? quotes.map(q => lqPrice(q, i.id)) : [];
    const max = Math.max(0, ...prices.filter(p => p > 0));
    const sel = el('select', { disabled: !canSet });
    sel.append(el('option', { value: '', textContent: '—' }), el('option', { value: 'destroy', textContent: t('lqq.destroy') }));
    quotes.forEach((q, k) => { if (prices[k] > 0) sel.append(el('option', { value: 'q' + q.id, textContent: `${q.data.name || q.buyer.name} · ${lqN(prices[k])}` })); });
    sel.value = dr.outcome === 'destroy' ? 'destroy' : dr.outcome === 'sale' ? 'q' + dr.quote_id : '';
    const pr = el('input', { className: 'lqrv', inputMode: 'decimal', value: dr.price != null ? fmtNum(dr.price) : '', disabled: !canSet || dr.outcome !== 'sale' });
    const cost = el('input', { className: 'lqrv', inputMode: 'decimal', value: dr.cost != null ? fmtNum(dr.cost) : '', disabled: !canSet || !dr.outcome });
    const why = el('input', { value: dr.note, disabled: !canSet, placeholder: '' });
    const val = el('td', { className: 'num', textContent: dr.outcome === 'sale' && dr.price ? lqN(dr.price * qty) : '' });
    sel.onchange = () => {
      const v = sel.value;
      dr.outcome = v === 'destroy' ? 'destroy' : v ? 'sale' : '';
      dr.quote_id = v.startsWith('q') ? Number(v.slice(1)) : '';
      dr.price = dr.outcome === 'sale' ? lqPrice(quotes.find(q => q.id === dr.quote_id), i.id) : null;
      pr.value = dr.price != null ? fmtNum(dr.price) : ''; pr.disabled = dr.outcome !== 'sale'; cost.disabled = !dr.outcome;
      val.textContent = dr.price ? lqN(dr.price * qty) : '';
      why.placeholder = dr.outcome === 'sale' && dr.price < max ? t('lqq.whyNeed') : '';
    };
    pr.onchange = () => { dr.price = numIn(pr.value); val.textContent = dr.price ? lqN(dr.price * qty) : ''; why.placeholder = dr.price < max ? t('lqq.whyNeed') : ''; };
    cost.onchange = () => { dr.cost = numIn(cost.value); };
    why.onchange = () => { dr.note = why.value.trim(); };
    tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: i.asset_code || 'N/A' })), el('td', { textContent: `${i.name}${i.mode === 'Other' ? ' · ' + t('lqq.planDestroy') : ''}` }),
      el('td', { className: 'num', textContent: `${fmtNum(qty)} ${i.unit || ''}` }), el('td', { className: 'num', textContent: lqN(i.reval_value) }),
      ...prices.map(p => el('td', { className: 'num' + (p > 0 && p === max ? ' best' : ''), textContent: p > 0 ? lqN(p) : '—' })),
      el('td', {}, sel), el('td', { className: 'num' }, pr), val, el('td', { className: 'num' }, cost), el('td', {}, why)]));
  }
  const saleSum = found.reduce((s, i) => s + (i.outcome === 'sale' ? n0(i.sale_value) : 0), 0);
  card.append(el('div', { className: 'wrap' }, tb));
  if (lost.length) card.append(el('div', { className: 'msg warn', textContent: t('lqq.lost', { list: lost.map(i => i.asset_code || i.name).join(', ') }) }));
  if (b.opened_at && quotes.length) {
    const below = found.filter(i => i.outcome === 'sale' && i.reval_value != null && n0(i.sale_price) * n0(i.count_qty ?? i.qty) < n0(i.reval_value));
    if (below.length) card.append(el('div', { className: 'msg warn', textContent: t('lqq.belowFloor', { list: below.map(i => i.asset_code || i.name).join(', ') }) }));
  }
  if (saleSum) card.append(el('div', { className: 'lqsum', textContent: t('lqq.saleSum', { v: lqN(saleSum) }) }));
  if (canSet) card.append(el('div', { className: 'row', style: 'gap:8px;margin-top:6px' }, [
    ...(opened ? [el('button', { className: 'btn', type: 'button', textContent: t('lqq.suggest'), onclick: () => {
      for (const i of found) {
        const dr = draft.get(i.id); if (dr.outcome) continue;
        let best = null, bp = 0; for (const q of quotes) { const p = lqPrice(q, i.id); if (p > bp) { bp = p; best = q; } }
        if (best) Object.assign(dr, { outcome: 'sale', quote_id: best.id, price: bp }); else if (i.mode === 'Other') dr.outcome = 'destroy';
      }
      lqbSaveAward(b, draft, out);
    } })] : []),
    el('button', { className: 'btn pri', type: 'button', textContent: t('lqq.saveResult'), onclick: () => lqbSaveAward(b, draft, out) })]));
}
async function lqbSaveAward(b, draft, out) {
  const items = [...draft].map(([id, d]) => ({ item_id: id, outcome: d.outcome || null, quote_id: d.quote_id || null, price: d.price ?? null, cost: d.cost ?? null, note: d.note || null }));
  try { await SB.rpc('pm_lq_award', { p_batch: b.id, p_items: items }); LQ.flash = t('lqq.resultSaved'); await lqLoad(); }
  catch (e) { msg(out, 'err', e.message); }
}

// Each winning buyer: what they bought, the VAT invoice, the gate pass, the handover; their papers to print.
function lqbWinners(card, b, bl, live, edit, out) {
  const wins = bl.buyers.filter(v => v.quote && live.some(i => i.outcome === 'sale' && i.sale_quote_id === v.quote.id));
  if (!wins.length) return;
  card.append(el('h3', { className: 'lqsub', textContent: t('lqq.winners', { n: wins.length }) }));
  for (const v of wins) {
    const q = v.quote, mine = live.filter(i => i.outcome === 'sale' && i.sale_quote_id === q.id);
    const total = mine.reduce((s, i) => s + n0(i.sale_value), 0), dis = !edit || b.status === 'closed';
    const inv = el('input', { value: q.invoice_no || '', disabled: dis }), invD = el('input', { type: 'date', value: q.invoice_date || '', disabled: dis });
    const gd = el('input', { type: 'date', value: q.gate_date || '', disabled: dis }), gok = el('input', { type: 'checkbox', checked: !!q.gate_ok, disabled: dis });
    const hd = el('input', { type: 'date', value: q.handover_date || '', disabled: dis });
    const fOut = el('div');
    const box = el('div', { className: 'lqwin' + (q.invoice_no && q.gate_ok ? ' ok' : '') }, [
      el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [el('b', { textContent: (q.data && q.data.name) || v.name }),
        el('span', { className: 'dim', textContent: `${lqBuyerId(q.data)} · ${t('lqq.items', { n: mine.length })} · ${lqN(total)}` })]),
      el('div', { className: 'lqgrid', style: 'margin-top:6px' }, [
        el('div', { className: 'fld' }, [el('label', { textContent: t('lqq.invNo') }), inv]), el('div', { className: 'fld' }, [el('label', { textContent: t('lqq.invDate') }), invD]),
        el('div', { className: 'fld' }, [el('label', { textContent: t('lqq.gateDate') }), gd]),
        el('label', { className: 'chk', style: 'align-self:end' }, [gok, el('span', { textContent: t('lqq.gateOk') })]),
        el('div', { className: 'fld' }, [el('label', { textContent: t('lqq.handDate') }), hd])]),
      el('div', { className: 'row', style: 'gap:6px;margin-top:6px;flex-wrap:wrap' }, [
        ...(dis ? [] : [el('button', { className: 'btn tiny pri', type: 'button', textContent: t('tool.save'), onclick: async () => {
          try { await SB.rpc('pm_lq_buyer_doc', { p_quote: q.id, p_patch: { invoice_no: inv.value, invoice_date: invD.value, gate_date: gd.value, gate_ok: gok.checked, handover_date: hd.value } });
                LQ.flash = t('lqq.docSaved', { v: (q.data && q.data.name) || v.name }); await lqLoad(); } catch (e) { msg(out, 'err', e.message); } } })]),
        ...[['07', 'lqb.f.07'], ['GP', 'lqb.f.GP'], ['11', 'lqb.f.11']].map(([k, key]) => el('button', { className: 'btn tiny', type: 'button', textContent: t(key),
          onclick: () => lqbCapture(b, [k], 'preview', fOut, q.id) }))]), fOut]);
    card.append(box);
  }
}

/* ============================================================ ACCOUNTING RECONCILIATION
   The asset register (the things: code, barcode, standard name, place, status)
   and accounting's depreciation books (the money: cost, term, accumulated,
   residual) are two books, joined by links (30_acc_reconcile.sql). Every month
   accounting sends three files — fixed assets, long-term prepayments (tools,
   2422) and short-term prepayments (2421, only the tool lines count); each is
   read here in the browser and loaded as that month's picture: new lines,
   changed lines, lines gone. Linking is rolling, not closed month by month:
   every asset still provisional stays in the queue until accounting books it.
   Decisions of 26/09/2026: accounting pastes the asset codes the app exports
   into its "Mã TS mới" column (the next import links those by itself); a line
   that holds several assets is linked first and allocated later; commissions,
   insurance and the land-use right are left out; relocation counts when it
   belongs to an asset or a project; from 2022 first, older lines after. */
const ACC = { tab: 'home', lines: [], links: [], assets: [], imports: [], changes: [], alias: new Map(), proj: null, q: '', year: 2022, sel: new Set(), asel: new Set(), files: [] };
const ACC_KINDS = { fa: 'acc.k.fa', ccdc: 'acc.k.ccdc', st: 'acc.k.st' };
const ACC_SKIP = [[/insurance|bảo hiểm|bao hiem/i, 'acc.skip.ins'], [/commission|hoa hồng|hoa hong/i, 'acc.skip.com'],
                  [/right to use land|quyền sử dụng đất|quyen su dung dat/i, 'acc.skip.land']];
const accNorm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim();
const accTokens = s => new Set(accNorm(s).split(' ').filter(w => w.length > 1 && !/^\d+$/.test(w)));
const accProject = (...xs) => { for (const x of xs) { const m = /\bFFE(?:\.[A-Z0-9]+)+\.\d{4}\b/i.exec(String(x || '')); if (m) return m[0].toUpperCase(); } return null; };
const accDate = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 60000) { const d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 10); }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(String(v).trim()); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const n = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return n ? n[0] : null;
};
const accNum = v => { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; const n = numIn(v); return n == null || !isFinite(n) ? null : n; };
// The period a file is "as of": from its name (2025.11.30 / 25.11.30 / 2025-11), else the month before this one.
function accPeriodOf(name) {
  const s = String(name || '');
  let m = /(20\d{2})[._-](\d{1,2})[._-](\d{1,2})(?!.*20\d{2}[._-]\d{1,2}[._-]\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /(?:^|\D)(\d{2})[._-](\d{2})[._-](\d{2})(?:\D|$)/.exec(s);
  if (m) return `20${m[1]}-${m[2]}`;
  const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 7);
}
const accMonthEnd = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/* ------------------------------------------------------------ reading a file
   The three files have their own layouts; each is found by its header row
   (the one with "Description"), the columns by their header words, and the
   month's residual by the date above its block (FA: Term · Monthly Dep ·
   Residual; prepayments: Debit · Credit · Term · Allocation · Residuals). */
function accFindSheet(wb) {
  const cand = [];
  for (const name of wb.SheetNames) {
    if (/commission/i.test(name)) continue;
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true, sheetRows: 45 });
    for (let r = 0; r < aoa.length; r++) {
      const row = (aoa[r] || []).map(v => String(v ?? '').trim().toLowerCase());
      if (!row.includes('description')) continue;
      const kind = row.includes('being used at') ? 'fa' : row.includes('beginning') && row.includes('price') ? 'ccdc' : row.includes('beginning') ? 'st' : null;
      if (kind) cand.push({ name, kind, hr: r });
      break;
    }
  }
  // Short-term: the last yearly sheet ("2023 + 2024 + 2025") holds the current lines.
  const fa = cand.find(c => c.kind === 'fa' && /^details$/i.test(c.name)) || cand.find(c => c.kind === 'fa');
  return fa || cand.find(c => c.kind === 'ccdc') || cand.filter(c => c.kind === 'st').pop() || null;
}
function accParse(wb, fileName, periodYm) {
  const found = accFindSheet(wb);
  if (!found) throw new Error(t('acc.noSheet', { f: fileName }));
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[found.name], { header: 1, raw: true, defval: null, blankrows: true });
  const H = (aoa[found.hr] || []).map(v => String(v ?? '').trim().toLowerCase()), U = (aoa[found.hr - 1] || []);
  const col = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } return -1; };
  const up = re => U.findIndex(v => re.test(String(v ?? '')));
  const kind = found.kind;
  const C = kind === 'fa'
    ? { entity: 0, dept: 1, grp: 2, loai: 3, debit: 5, credit: 6, costAcct: 7, desc: col('description'), usd: col('usd'), cost: col('vnd'), qty: col('qty'),
        docs: col('docs'), tax: col('mst'), sup: col('supplier'), contract: col('contract'), loc: col('location'), liq: col('liquidation no.'),
        start: col('being used at'), term: col('term'), code: up(/mã\s*ts\s*mới/i) }
    : { dept: col('tổ chức'), grp: col('nhóm'), loai: col('loại'), desc: col('description'), qty: col('qty'), unit: col('unit'), docs: col('doc'), project: col('project'),
        tax: col('tax code'), sup: col('supplier'), contract: col('contract no.'), loc: col('location'), start: col('beginning'), term: col('month'),
        price: col('price'), cost: col('asset value'), code: Math.max(up(/mã\s*ts\s*mới/i), H.findIndex(v => /mã\s*ts\s*mới/.test(v))) };
  if (C.desc < 0 || C.cost < 0) throw new Error(t('acc.noCols', { f: fileName }));
  // The month's block: its date sits above its first column.
  const target = periodYm;
  let blk = -1;
  for (let j = 0; j < U.length; j++) {
    const v = U[j]; if (typeof v !== 'number' || v < 30000 || v > 60000) continue;
    const ym = new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 7);
    if (ym === target) { blk = j; break; }
  }
  const off = kind === 'fa' ? { monthly: 1, res: 2 } : { monthly: 3, res: 4 };
  // Dept codes for the account sheet's own dept list; the rest of the rows are data from the header down.
  const rows = [], seen = new Map();
  for (let r = found.hr + 1; r < aoa.length; r++) {
    const a = aoa[r] || [];
    const desc = String(a[C.desc] ?? '').trim(), dept = String(a[C.dept] ?? '').trim();
    const cost = accNum(a[C.cost]);
    if (!desc || !dept || dept.length > 6 || cost == null) continue;
    const grp = String(a[C.grp] ?? '').trim();
    if (kind === 'st' && grp !== 'E') continue;                     // short-term: only tools
    const start = accDate(a[C.start]);
    const docs = [a[C.docs], kind === 'fa' ? null : a[C.project]].filter(v => v != null && String(v).trim() && String(v).trim() !== '0').map(String).join(' · ');
    const nbv = blk >= 0 ? accNum(a[blk + off.res]) : null, monthly = blk >= 0 ? accNum(a[blk + off.monthly]) : null;
    let skip = null;
    for (const [re, k] of ACC_SKIP) if (re.test(desc)) { skip = t(k); break; }
    if (!skip && cost < 0) skip = t('acc.skip.neg');
    // The line's identity: department, description, start date, document — NOT the cost, which accounting
    // corrects when a project is settled (a changed cost is a change of the same line, not a new one).
    const base = [dept, accNorm(desc).slice(0, 80), start || '', accNorm(docs).slice(0, 40)].join('|');
    const k = (seen.get(base) || 0) + 1; seen.set(base, k);
    rows.push({ line_key: kind + ':' + base + '#' + k, src_row: r + 1, acc_code: C.code >= 0 ? String(a[C.code] ?? '').trim() : '',
      entity: kind === 'fa' ? String(a[C.entity] ?? '').trim() : '', dept, grp, loai: String(a[C.loai] ?? '').trim(),
      acct_debit: kind === 'fa' ? String(a[C.debit] ?? '').trim() : '2422', acct_credit: kind === 'fa' ? String(a[C.credit] ?? '').trim() : '',
      acct_cost: kind === 'fa' ? String(a[C.costAcct] ?? '').trim() : '', description: desc,
      qty: accNum(a[C.qty]), unit: C.unit >= 0 ? String(a[C.unit] ?? '').trim() : '', unit_price: C.price >= 0 ? accNum(a[C.price]) : null,
      cost, start_date: start, term_months: accNum(a[C.term]), monthly, nbv, accum: nbv != null ? cost - nbv : null,
      docs, project_code: accProject(a[C.docs], kind === 'fa' ? a[C.contract] : a[C.project], a[C.contract], desc),
      tax_code: String(a[C.tax] ?? '').trim().replace(/^0$/, ''), supplier: String(a[C.sup] ?? '').trim().replace(/^0$/, ''),
      contract: String(a[C.contract] ?? '').trim().replace(/^0$/, ''), location: C.loc >= 0 ? String(a[C.loc] ?? '').trim().replace(/^0$/, '') : '',
      liquidation_no: C.liq >= 0 ? String(a[C.liq] ?? '').trim().replace(/^0$/, '') : '', skip });
  }
  if (kind === 'ccdc') for (const r of rows) r.acct_debit = '2422';
  if (kind === 'st') for (const r of rows) r.acct_debit = '2421';
  return { kind, sheet: found.name, rows, block: blk >= 0 };
}

async function accPick(files) {
  const out = $('#accMsg');
  try {
    if (typeof XLSX === 'undefined') throw new Error('XLSX');
    ACC.files = [];
    for (const f of files) {
      msg(out, 'info', t('acc.reading', { f: f.name }));
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellFormula: false, cellHTML: false, cellStyles: false });
      const ym = accPeriodOf(f.name);
      const p = accParse(wb, f.name, ym);
      ACC.files.push({ file: f.name, wb, ym, parsedYm: ym, ...p });
    }
    msg(out, '', '');
    accRender();
  } catch (e) { msg(out, 'err', e.message); }
}
async function accImport() {
  const out = $('#accMsg');
  try {
    for (const f of ACC.files) {
      if (f.ym !== f.parsedYm) Object.assign(f, accParse(f.wb, f.file, f.ym), { parsedYm: f.ym });
      msg(out, 'info', t('acc.loading', { f: f.file, n: fmtInt(f.rows.length) }));
      const id = await SB.rpc('am_acc_import_begin', { p_kind: f.kind, p_period: accMonthEnd(f.ym), p_file: f.file, p_sheet: f.sheet });
      for (let i = 0; i < f.rows.length; i += 400) await SB.rpc('am_acc_import_rows', { p_import: id, p_rows: f.rows.slice(i, i + 400) });
      let st;
      do { st = await SB.rpc('am_acc_import_finish', { p_import: id, p_limit: 600 });
           if (st.more) msg(out, 'info', t('acc.applying', { f: f.file, n: fmtInt(st.left) })); } while (st.more);
      f.stats = st;
    }
    const done = ACC.files.map(f => `${f.file}: ${t('acc.stats', { n: f.stats.new || 0, c: f.stats.changed || 0, g: f.stats.gone || 0, r: f.stats.rekeyed || 0, a: f.stats.autolinked || 0 })}`).join('\n');
    ACC.files = [];
    await accLoad();
    msg(out, 'ok', done);
  } catch (e) { msg(out, 'err', e.message); }
}

/* ------------------------------------------------------------ loading */
async function accLoad() {
  const out = $('#accMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    const [lines, links, imports, alias] = await Promise.all([
      pmSelectAll('am_acc_line', 'select=*&order=id'), pmSelectAll('am_acc_link', 'select=*'),
      SB.select('am_acc_import', 'select=*&order=id.desc&limit=30'), pmSelectAll('am_acc_alias', 'select=desc_norm,name')]);
    const assets = await pmSelectAll('am_asset', 'select=id,asset_code,barcode,name_vi,name_en,qty,unit_code,unit_price,dept_code,location_code,purpose_code,supplier,invoice_no,'
      + 'purchase_date,in_use_date,purchase_year,created_at,asset_kind,status_code,is_legacy,shipment_id,no_label,fin_status,fin_cost,fin_nbv,fin_start,fin_term,fin_account,fin_as_of,fin_note'
      + '&or=(purchase_year.gte.2022,fin_status.not.is.null,is_legacy.eq.false)&order=id');
    const last = imports.find(i => i.status === 'done');
    const changes = last ? await pmSelectAll('am_acc_change', `select=*&period=gte.${imports.filter(i => i.status === 'done').map(i => i.period).sort()[0]}&order=id.desc`) : [];
    Object.assign(ACC, { lines, links, imports, assets, changes, alias: new Map(alias.map(a => [a.desc_norm, a.name])), ready: true });
    ACC.byLine = new Map(); ACC.byAsset = new Map();
    for (const k of links) { (ACC.byLine.get(k.line_id) || ACC.byLine.set(k.line_id, []).get(k.line_id)).push(k); (ACC.byAsset.get(k.asset_id) || ACC.byAsset.set(k.asset_id, []).get(k.asset_id)).push(k); }
    ACC.assetMap = new Map(assets.map(a => [a.id, a]));
    ACC.lineMap = new Map(lines.map(l => [l.id, l]));
    msg(out, '', '');
    accRender();
  } catch (e) {
    ACC.ready = false; accRender();
    msg(out, 'err', /am_acc_|PGRST205|404/.test(e.message) ? t('acc.notInstalled') : e.message);
  }
}
const accYear = l => l.start_date ? Number(l.start_date.slice(0, 4)) : 0;
const accInScope = l => l.status === 'active' && l.scope === 'in' && accYear(l) >= ACC.year;
const accAssetName = a => [a.name_vi, a.name_en].filter(Boolean).join(' / ');
const accAge = a => { const d = new Date(a.purchase_date || a.created_at); return isNaN(d) ? null : Math.max(0, Math.floor((Date.now() - d) / (30.44 * 864e5))); };
// Assets waiting to be booked: in the app's own lifetime (not the old Beetrack register) or bought from 2022, not linked, not marked off.
const accQueue = () => ACC.assets.filter(a => !a.fin_status && !ACC.byAsset.has(a.id) && (!a.is_legacy || (a.purchase_year || 0) >= ACC.year)
  && !['7', '9', '0'].includes(String(a.status_code)));

/* How well an accounting line and an asset fit (0–100): the project code first,
   then value, date, department, supplier, and the name (the learned dictionary,
   then shared words in either language). */
function accScore(l, a) {
  let s = 0;
  if (l.project_code && a.purpose_code && l.project_code === String(a.purpose_code).toUpperCase()) s += 40;
  const unit = l.unit_price || (l.qty ? l.cost / l.qty : l.cost), ap = Number(a.unit_price) || 0;
  if (unit && ap) { const d = Math.abs(unit - ap) / Math.max(unit, ap); s += d <= 0.02 ? 22 : d <= 0.1 ? 14 : d <= 0.25 ? 5 : 0; }
  const ad = a.in_use_date || a.purchase_date;
  if (l.start_date && ad) { const g = Math.abs(new Date(l.start_date) - new Date(ad)) / 864e5; s += g <= 31 ? 10 : g <= 92 ? 5 : 0; }
  if (l.dept && a.dept_code && l.dept === a.dept_code) s += 6;
  if (l.supplier && a.supplier && accNorm(a.supplier).includes(accNorm(l.supplier).split(' ').slice(0, 3).join(' '))) s += 6;
  const nm = accAssetName(a);
  if (ACC.alias.get(accNorm(l.description)) === [a.name_vi, a.name_en].filter(Boolean).join('/')) s += 30;
  else { const A = accTokens(l.description), B = accTokens(nm); let inter = 0; for (const w of A) if (B.has(w)) inter++;
         s += A.size && B.size ? Math.round(24 * inter / Math.min(A.size, B.size)) : 0; }
  return Math.min(100, s);
}
function accCandidates(l, pool, n = 5) {
  const list = (l.project_code ? pool.filter(a => String(a.purpose_code || '').toUpperCase() === l.project_code) : pool)
    .filter(a => !['7', '9', '0'].includes(String(a.status_code)));
  const scored = (list.length ? list : pool).map(a => [a, accScore(l, a)]).filter(([, s]) => s >= 25).sort((x, y) => y[1] - x[1]);
  return scored.slice(0, n);
}

/* ------------------------------------------------------------ actions */
async function accLink(pairs, out) {
  if (!pairs.length) return;
  try {
    const withAlias = pairs.map(p => Object.assign({}, p, { desc_norm: accNorm((ACC.lineMap.get(p.line_id) || {}).description) }));
    const n = await SB.rpc('am_acc_link_set', { p_pairs: withAlias, p_method: 'manual' });
    ACC.flash = t('acc.linked', { n }); await accLoad();
  } catch (e) { msg(out || '#accMsg', 'err', e.message); }
}
async function accUnlink(pairs) {
  try { await SB.rpc('am_acc_unlink', { p_pairs: pairs }); await accLoad(); } catch (e) { msg('#accMsg', 'err', e.message); }
}
async function accAllocate(lineId, mode) {
  try { await SB.rpc('am_acc_allocate', { p_line: lineId, p_mode: mode, p_shares: null }); await accLoad(); } catch (e) { msg('#accMsg', 'err', e.message); }
}
async function accSkip(ids, skip) {
  const why = skip ? prompt(t('acc.skipWhy')) : null;
  if (skip && !why) return;
  try { await SB.rpc('am_acc_scope', { p_lines: ids, p_skip: skip, p_reason: why }); await accLoad(); } catch (e) { msg('#accMsg', 'err', e.message); }
}
async function accOff(ids, off) {
  const why = off ? prompt(t('acc.offWhy')) : null;
  if (off && !why) return;
  try { await SB.rpc('am_acc_asset_off', { p_assets: ids, p_off: off, p_note: why }); await accLoad(); } catch (e) { msg('#accMsg', 'err', e.message); }
}
/* Accounting lines not in the register → the intake screen, where they get
   their codes the one way codes are given; once confirmed they are linked to
   the lines they came from. One department at a time (the intake's header). */
async function accToIntake(lineIds) {
  const ls = lineIds.map(id => ACC.lineMap.get(id)).filter(Boolean);
  const depts = [...new Set(ls.map(l => l.dept))];
  if (depts.length > 1) return msg('#accMsg', 'err', t('acc.oneDept', { list: depts.join(', ') }));
  if (IN.lines.length && !confirm(t('dn.replace', { n: IN.lines.length }))) return;
  IN.lines = ls.map(l => {
    const ln = Object.assign(inBlank(), { qty: l.kind === 'fa' ? (Number(l.qty) || 1) : (Number(l.qty) || 1),
      unit_price: Math.round(l.unit_price || (l.qty ? l.cost / l.qty : l.cost)) || '', description: `${t('acc.fromAcc')} ${l.kind.toUpperCase()} #${l.src_row || ''}`.trim() });
    if (l.unit) ln.unit_code = l.unit.toLowerCase();
    if (l.location && WF_CAT.locs && WF_CAT.locs.has(l.location)) ln.location_code = l.location;
    inSetName(ln, l.description);
    ln._acc = [l.id];
    // Software, renovation, relocation: kept in the register to match the books, not labelled.
    ln._nolabel = /^(217|213|2135|2138)/.test(l.acct_debit || '') || /renovation|cải tạo|software|phần mềm|relocation|di dời/i.test(l.description);
    return ln;
  });
  IN.checked = null; IN.sugRan = false;
  IN.src = { acc: true };
  showView('intake');
  await inFill();
  const dept = depts[0], start = ls.map(l => l.start_date).filter(Boolean).sort()[0];
  const proj = [...new Set(ls.map(l => l.project_code).filter(Boolean))];
  if ([...$('#inDept').options].some(o => o.value === dept)) $('#inDept').value = dept;
  let o = PM.orgMap.get(dept), g = 0;
  while (o && g++ < 10 && ![...$('#inCompany').options].some(x => x.value === o.code)) o = PM.orgMap.get(o.parent_code);
  if (o) $('#inCompany').value = o.code;
  if (start) $('#inDate').value = start;
  $('#inPurpose').value = proj.length === 1 ? proj[0] : '';
  $('#inSupplier').value = ls.length === 1 ? (ls[0].supplier || '') : '';
  inRender();
  msg('#inMsg', 'info', t('acc.intakeReady', { n: ls.length }));
}

/* ------------------------------------------------------------ export for accounting
   One sheet per book, one row per line of the latest file (its row number, so
   it can be pasted beside the right row): the asset codes to paste into "Mã TS
   mới", and the group, the kind, how many assets, the standard names. */
function accExport() {
  const out = $('#accMsg');
  try {
    const wb = XLSX.utils.book_new();
    for (const kind of ['fa', 'ccdc', 'st']) {
      const ls = ACC.lines.filter(l => l.kind === kind && l.status === 'active' && ACC.byLine.has(l.id)).sort((a, b) => (a.src_row || 0) - (b.src_row || 0));
      if (!ls.length) continue;
      const rows = ls.map(l => {
        const as = ACC.byLine.get(l.id).map(k => ACC.assetMap.get(k.asset_id)).filter(Boolean);
        return { [t('acc.x.row')]: l.src_row, [t('acc.x.dept')]: l.dept, Description: l.description, [t('acc.x.start')]: l.start_date || '', [t('acc.x.cost')]: Number(l.cost),
                 'Mã TS mới': as.map(a => a.asset_code).join('; '), 'Nhóm mới': [...new Set(as.map(a => a.asset_code.split('.')[1]))].join('; '),
                 'Loại mới': [...new Set(as.map(a => a.asset_kind === 'low' ? 'CCDC' : 'TSCĐ'))].join('; '), 'Bộ TS': as.length,
                 'Tên TS chuẩn hóa': [...new Set(as.map(a => [a.name_vi, a.name_en].filter(Boolean).join('/')))].join('; ') };
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), kind === 'fa' ? 'TSCD' : kind === 'ccdc' ? 'CCDC 2422' : 'Ngan han 2421');
    }
    if (!wb.SheetNames.length) return msg(out, 'warn', t('acc.nothingLinked'));
    const file = `phcl-ma-ts-cho-ke-toan-${bkStamp()}.xlsx`;
    XLSX.writeFile(wb, file);
    msg(out, 'ok', t('acc.exported', { file }));
  } catch (e) { msg(out, 'err', e.message); }
}

/* ------------------------------------------------------------ the screen */
function accRender() {
  const tabs = $('#accTabs'), body = $('#accBody');
  if (!tabs) return;
  tabs.innerHTML = ''; body.innerHTML = '';
  if (ACC.flash) { msg('#accMsg', 'ok', ACC.flash); ACC.flash = null; }
  const inScope = ACC.lines.filter(accInScope), unl = inScope.filter(l => !ACC.byLine.has(l.id)), queue = accQueue();
  const groupsOpen = ACC.lines.filter(l => (ACC.byLine.get(l.id) || []).length > 1 && ACC.byLine.get(l.id).some(k => k.share == null));
  const diffs = accDiffs();
  for (const [v, k, n] of [['home', 'acc.t.home', null], ['proj', 'acc.t.proj', null], ['queue', 'acc.t.queue', queue.length],
                           ['lines', 'acc.t.lines', unl.length], ['diff', 'acc.t.diff', diffs.length], ['alloc', 'acc.t.alloc', groupsOpen.length]]) {
    const b = el('button', { textContent: t(k) + (n != null ? ` (${fmtInt(n)})` : '') });
    b.classList.toggle('on', ACC.tab === v);
    b.onclick = () => { ACC.tab = v; ACC.sel.clear(); ACC.asel.clear(); accRender(); };
    tabs.append(b);
  }
  const edit = can('assets', 'edit');
  if (ACC.tab === 'home') return accHome(body, { inScope, unl, queue, groupsOpen, diffs, edit });
  if (!ACC.ready) return;
  // A filter row shared by the lists: search, and from which year.
  const q = el('input', { placeholder: t('pm.f.search'), value: ACC.q, spellcheck: false });
  q.oninput = () => { ACC.q = q.value; clearTimeout(ACC.qt); ACC.qt = setTimeout(accRender, 250); };
  const yr = el('select');
  for (const y of [2022, 2020, 2015, 2000, 0]) yr.append(el('option', { value: y, textContent: y ? t('acc.fromYear', { y }) : t('acc.allYears') }));
  yr.value = ACC.year; yr.onchange = () => { ACC.year = Number(yr.value); accRender(); };
  body.append(el('div', { className: 'card row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' }, [
    el('div', { className: 'fld grow', style: 'max-width:340px' }, [el('label', { textContent: t('pm.f.search') }), q]),
    el('div', { className: 'fld', style: 'max-width:200px' }, [el('label', { textContent: t('acc.scopeYear') }), yr])]));
  setTimeout(() => { if (document.activeElement !== q && ACC.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 0);
  if (ACC.tab === 'proj') return accProjTab(body, edit);
  if (ACC.tab === 'queue') return accQueueTab(body, queue, edit);
  if (ACC.tab === 'lines') return accLinesTab(body, unl, edit);
  if (ACC.tab === 'diff') return accDiffTab(body, diffs, edit);
  if (ACC.tab === 'alloc') return accAllocTab(body, groupsOpen, edit);
}

function accHome(body, s) {
  const up = el('div', { className: 'card' }, [el('h2', { textContent: t('acc.upload') }), el('div', { className: 'tdnote', textContent: t('acc.uploadHint') })]);
  if (s.edit) {
    const inp = el('input', { type: 'file', multiple: true, accept: '.xlsx,.xls,.xlsm', style: 'display:none', onchange: () => { accPick([...inp.files]); inp.value = ''; } });
    up.append(inp, el('button', { className: 'btn pri', type: 'button', textContent: t('acc.pick'), onclick: () => inp.click() }));
  }
  if (ACC.files.length) {
    const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['acc.f.file', 'acc.f.kind', 'acc.f.sheet', 'acc.f.period', 'acc.f.rows', 'acc.f.from22'].map(k => el('th', { textContent: t(k) })))]);
    for (const f of ACC.files) {
      const ym = el('input', { type: 'month', value: f.ym, onchange: e => { f.ym = e.target.value; } });
      tb.append(el('tr', {}, [el('td', { textContent: f.file }), el('td', { textContent: t(ACC_KINDS[f.kind]) }), el('td', { textContent: f.sheet }), el('td', {}, ym),
        el('td', { className: 'num', textContent: fmtInt(f.rows.length) }), el('td', { className: 'num', textContent: fmtInt(f.rows.filter(r => (r.start_date || '') >= '2022').length) })]));
      if (!f.block) tb.append(el('tr', {}, el('td', { colSpan: 6, className: 'bad', textContent: t('acc.noBlock', { m: f.ym }) })));
    }
    up.append(el('div', { className: 'wrap', style: 'margin-top:8px' }, tb),
      el('div', { className: 'row', style: 'gap:8px;margin-top:8px' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('acc.import'), onclick: accImport }),
        el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: () => { ACC.files = []; accRender(); } })]));
  }
  body.append(up);
  if (!ACC.ready) return;
  const tile = (n, k, tab, warn) => el('button', { className: 'acctile' + (warn && n ? ' warn' : ''), type: 'button', onclick: () => { ACC.tab = tab; accRender(); } },
    [el('b', { textContent: fmtInt(n) }), el('span', { textContent: t(k) })]);
  const booked = ACC.assets.filter(a => a.fin_status === 'booked').length, linked = ACC.assets.filter(a => a.fin_status === 'linked').length;
  const old = s.queue.filter(a => accAge(a) >= 3).length;
  body.append(el('div', { className: 'acctiles' }, [tile(s.queue.length, 'acc.k.queue', 'queue', true), tile(old, 'acc.k.old3', 'queue', true),
    tile(s.unl.length, 'acc.k.unl', 'lines', true), tile(s.groupsOpen.length, 'acc.k.alloc', 'alloc'), tile(s.diffs.length, 'acc.k.diff', 'diff', true),
    tile(booked, 'acc.k.booked', 'proj'), tile(linked, 'acc.k.linked', 'alloc')]));
  const hist = el('div', { className: 'card' }, [el('div', { className: 'chead' }, [el('h2', { textContent: t('acc.hist') }),
    el('button', { className: 'btn', type: 'button', textContent: t('acc.export'), title: t('acc.exportHint'), onclick: accExport })])]);
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['acc.f.period', 'acc.f.kind', 'acc.f.file', 'acc.f.rows', 'acc.h.result', 'acc.h.by'].map(k => el('th', { textContent: t(k) })))]);
  for (const i of ACC.imports) tb.append(el('tr', {}, [el('td', { textContent: String(i.period).slice(0, 7) }), el('td', { textContent: t(ACC_KINDS[i.kind]) }),
    el('td', { textContent: i.file_name || '' }), el('td', { className: 'num', textContent: fmtInt(i.rows_in) }),
    el('td', { textContent: i.status === 'done' ? t('acc.stats', { n: i.stats.new || 0, c: i.stats.changed || 0, g: i.stats.gone || 0, r: i.stats.rekeyed || 0, a: i.stats.autolinked || 0 }) : i.status }),
    el('td', { textContent: `${i.imported_name || ''} · ${fmtDateTime(i.imported_at)}` })]));
  if (!ACC.imports.length) tb.append(el('tr', {}, el('td', { colSpan: 6, className: 'dim', textContent: t('acc.noImport') })));
  hist.append(el('div', { className: 'wrap' }, tb), el('div', { className: 'tdnote', textContent: t('acc.exportHint') }));
  body.append(hist);
}

const accQ = (...xs) => !ACC.q || hnorm(xs.join(' ')).includes(hnorm(ACC.q));
const accLineCell = l => el('div', { className: 'accl' }, [el('b', { textContent: l.description }),
  el('small', { textContent: [t(ACC_KINDS[l.kind]), l.dept, l.start_date && fmtDate(l.start_date), l.qty != null ? `SL ${fmtNum(l.qty)}` : '', lqN(l.cost), l.term_months ? `${l.term_months} th` : '',
    l.project_code || l.docs].filter(Boolean).join(' · ') })]);
const accAssetCell = a => el('div', { className: 'accl' }, [el('b', {}, [el('code', { textContent: a.asset_code }), document.createTextNode(' ' + accAssetName(a))]),
  el('small', { textContent: [a.dept_code, a.purpose_code, `SL ${fmtNum(a.qty)}`, lqN(a.unit_price), a.purchase_date && fmtDate(a.purchase_date), a.is_legacy ? 'Beetrack' : ''].filter(Boolean).join(' · ') })]);
const accChips = (l, edit) => (ACC.byLine.get(l.id) || []).map(k => { const a = ACC.assetMap.get(k.asset_id) || { asset_code: '#' + k.asset_id };
  return el('span', { className: 'accchip' }, [el('code', { textContent: a.asset_code }), k.share != null ? ` ${Math.round(k.share * 1000) / 10}%` : '',
    edit ? el('button', { className: 'x', type: 'button', textContent: '×', title: t('acc.unlink'), onclick: () => accUnlink([{ line_id: l.id, asset_id: k.asset_id }]) }) : '']); });

// By project: the lines and the assets of one project side by side; tick on both sides, link.
function accProjTab(body, edit) {
  const codes = new Map();
  for (const l of ACC.lines) if (accInScope(l) && l.project_code) { const c = codes.get(l.project_code) || { lines: 0, lu: 0, assets: 0, au: 0 }; c.lines++; if (!ACC.byLine.has(l.id)) c.lu++; codes.set(l.project_code, c); }
  for (const a of ACC.assets) { const p = String(a.purpose_code || '').toUpperCase(); if (!/^FFE/.test(p)) continue; const c = codes.get(p) || { lines: 0, lu: 0, assets: 0, au: 0 }; c.assets++; if (!ACC.byAsset.has(a.id) && a.fin_status !== 'off') c.au++; codes.set(p, c); }
  if (!ACC.proj) {
    const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['acc.p.code', 'acc.p.lines', 'acc.p.lu', 'acc.p.assets', 'acc.p.au'].map((k, i) => el('th', { className: i ? 'num' : '', textContent: t(k) })))]);
    const list = [...codes].filter(([c]) => accQ(c)).sort((x, y) => (y[1].lu + y[1].au) - (x[1].lu + x[1].au) || x[0].localeCompare(y[0]));
    for (const [c, v] of list) tb.append(el('tr', { style: 'cursor:pointer', onclick: () => { ACC.proj = c; ACC.sel.clear(); ACC.asel.clear(); accRender(); } }, [
      el('td', {}, el('code', { textContent: c })), el('td', { className: 'num', textContent: fmtInt(v.lines) }), el('td', { className: 'num' + (v.lu ? ' bad' : ''), textContent: fmtInt(v.lu) }),
      el('td', { className: 'num', textContent: fmtInt(v.assets) }), el('td', { className: 'num' + (v.au ? ' bad' : ''), textContent: fmtInt(v.au) })]));
    if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'dim', textContent: t('lq.none') })));
    return body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('acc.t.proj') }), el('div', { className: 'tdnote', textContent: t('acc.projHint') }), el('div', { className: 'wrap' }, tb)]));
  }
  const c = ACC.proj;
  const ls = ACC.lines.filter(l => l.project_code === c && l.status === 'active');
  const as = ACC.assets.filter(a => String(a.purpose_code || '').toUpperCase() === c);
  const card = el('div', { className: 'card' });
  card.append(el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [
    el('a', { href: '#', textContent: '← ' + t('acc.t.proj'), onclick: e => { e.preventDefault(); ACC.proj = null; accRender(); } }), el('b', { textContent: c }),
    el('span', { className: 'dim', textContent: t('acc.projSum', { l: ls.length, a: as.length, lc: lqN(pmSum(ls, 'cost')), ac: lqN(as.reduce((s, a) => s + n0(a.unit_price) * n0(a.qty), 0)) }) })]));
  const grid = el('div', { className: 'accsplit' });
  const left = el('div', {}, [el('h3', { className: 'lqsub', textContent: t('acc.side.lines') })]), right = el('div', {}, [el('h3', { className: 'lqsub', textContent: t('acc.side.assets') })]);
  for (const l of ls) {
    const cb = el('input', { type: 'checkbox', checked: ACC.sel.has(l.id), disabled: !edit, onchange: e => { e.target.checked ? ACC.sel.add(l.id) : ACC.sel.delete(l.id); } });
    left.append(el('label', { className: 'accrow' + (ACC.byLine.has(l.id) ? ' ok' : '') + (l.scope === 'skip' ? ' skip' : '') }, [cb, el('div', {}, [accLineCell(l), el('div', { className: 'accchips' }, accChips(l, edit))])]));
  }
  for (const a of as) {
    const cb = el('input', { type: 'checkbox', checked: ACC.asel.has(a.id), disabled: !edit, onchange: e => { e.target.checked ? ACC.asel.add(a.id) : ACC.asel.delete(a.id); } });
    right.append(el('label', { className: 'accrow' + (ACC.byAsset.has(a.id) ? ' ok' : a.fin_status === 'off' ? ' skip' : '') }, [cb, accAssetCell(a)]));
  }
  if (!ls.length) left.append(el('div', { className: 'dim', textContent: t('acc.noLinesYet') }));
  if (!as.length) right.append(el('div', { className: 'dim', textContent: t('acc.noAssetsYet') }));
  grid.append(left, right);
  card.append(grid);
  if (edit) card.append(el('div', { className: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, [
    el('button', { className: 'btn pri', type: 'button', textContent: t('acc.linkSel'), onclick: () => {
      const L = [...ACC.sel], A = [...ACC.asel];
      if (!L.length || !A.length) return msg('#accMsg', 'warn', t('acc.pickBoth'));
      if (L.length > 1 && A.length > 1 && !confirm(t('acc.crossQ', { l: L.length, a: A.length }))) return;
      accLink(L.flatMap(line_id => A.map(asset_id => ({ line_id, asset_id }))));
    } }),
    el('button', { className: 'btn', type: 'button', textContent: t('acc.suggest'), title: t('acc.suggestHint'), onclick: () => {
      // One-to-one by the best score, for lines and assets still free.
      const L = ls.filter(l => !ACC.byLine.has(l.id) && l.scope === 'in'), used = new Set(), pairs = [];
      for (const l of L) { const best = as.filter(a => !ACC.byAsset.has(a.id) && !used.has(a.id)).map(a => [a, accScore(l, a)]).sort((x, y) => y[1] - x[1])[0];
        if (best && best[1] >= 60) { used.add(best[0].id); pairs.push({ line_id: l.id, asset_id: best[0].id }); } }
      if (!pairs.length) return msg('#accMsg', 'info', t('acc.noSuggest'));
      if (confirm(t('acc.suggestQ', { n: pairs.length }))) accLink(pairs);
    } }),
    el('button', { className: 'btn', type: 'button', textContent: t('acc.toIntake'), onclick: () => { const L = [...ACC.sel].filter(id => !ACC.byLine.has(id)); if (!L.length) return msg('#accMsg', 'warn', t('acc.pickLines')); accToIntake(L); } }),
    el('button', { className: 'btn', type: 'button', textContent: t('acc.off'), onclick: () => { const A = [...ACC.asel]; if (A.length) accOff(A, true); } })]));
  body.append(card);
}

// Provisional assets not yet booked, oldest first, each with the accounting lines that fit best.
function accQueueTab(body, queue, edit) {
  const pool = ACC.lines.filter(l => l.status === 'active' && l.scope === 'in' && !ACC.byLine.has(l.id));   // lines still free
  const list = queue.filter(a => accQ(a.asset_code, a.barcode, accAssetName(a), a.purpose_code, a.dept_code)).sort((x, y) => (accAge(y) || 0) - (accAge(x) || 0));
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('acc.t.queue') }), el('div', { className: 'tdnote', textContent: t('acc.queueHint') })]);
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['acc.q.asset', 'acc.q.age', 'acc.q.best', ''].map(k => el('th', { textContent: k ? t(k) : '' })))]);
  for (const a of list.slice(0, 120)) {
    const best = pool.map(l => [l, accScore(l, a)]).filter(([, s]) => s >= 30).sort((x, y) => y[1] - x[1]).slice(0, 3);
    tb.append(el('tr', {}, [el('td', {}, accAssetCell(a)), el('td', { className: 'num' + ((accAge(a) || 0) >= 3 ? ' bad' : ''), textContent: accAge(a) != null ? t('acc.months', { n: accAge(a) }) : '' }),
      el('td', {}, best.length ? best.map(([l, s]) => el('div', { className: 'accsug' }, [el('span', { className: 'accsc', textContent: s }), accLineCell(l),
        edit ? el('button', { className: 'btn tiny pri', type: 'button', textContent: t('acc.linkOne'), onclick: () => accLink([{ line_id: l.id, asset_id: a.id }]) }) : ''])) : el('span', { className: 'dim', textContent: t('acc.noCand') })),
      el('td', { className: 'nowrap' }, edit ? el('button', { className: 'btn tiny', type: 'button', textContent: t('acc.off'), title: t('acc.offHint'), onclick: () => accOff([a.id], true) }) : '')]));
  }
  if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 4, className: 'dim', textContent: t('acc.queueEmpty') })));
  card.append(el('div', { className: 'wrap' }, tb));
  if (list.length > 120) card.append(el('div', { className: 'dim', textContent: t('acc.more', { n: list.length - 120 }) }));
  body.append(card);
}

// Accounting lines (from the year chosen) with no asset: the best candidates, or add them to the register, or leave them out.
function accLinesTab(body, unl, edit) {
  const pool = ACC.assets.filter(a => !['7', '9', '0'].includes(String(a.status_code)) && a.fin_status !== 'off');
  const list = unl.filter(l => accQ(l.description, l.dept, l.project_code, l.docs, l.supplier)).sort((x, y) => String(y.start_date).localeCompare(String(x.start_date)));
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('acc.t.lines') }), el('div', { className: 'tdnote', textContent: t('acc.linesHint') })]);
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['', 'acc.l.line', 'acc.l.cand'].map(k => el('th', { textContent: k ? t(k) : '' })))]);
  for (const l of list.slice(0, 120)) {
    const cb = el('input', { type: 'checkbox', checked: ACC.sel.has(l.id), disabled: !edit, onchange: e => { e.target.checked ? ACC.sel.add(l.id) : ACC.sel.delete(l.id); } });
    const cands = accCandidates(l, pool, 3);
    tb.append(el('tr', {}, [el('td', {}, cb), el('td', {}, accLineCell(l)),
      el('td', {}, cands.length ? cands.map(([a, s]) => el('div', { className: 'accsug' }, [el('span', { className: 'accsc', textContent: s }), accAssetCell(a),
        edit ? el('button', { className: 'btn tiny pri', type: 'button', textContent: t('acc.linkOne'), onclick: () => accLink([{ line_id: l.id, asset_id: a.id }]) }) : ''])) : el('span', { className: 'dim', textContent: t('acc.noCand') }))]));
  }
  if (!list.length) tb.append(el('tr', {}, el('td', { colSpan: 3, className: 'dim', textContent: t('acc.linesEmpty') })));
  card.append(el('div', { className: 'wrap' }, tb));
  if (list.length > 120) card.append(el('div', { className: 'dim', textContent: t('acc.more', { n: list.length - 120 }) }));
  if (edit) card.append(el('div', { className: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap' }, [
    el('button', { className: 'btn pri', type: 'button', textContent: t('acc.toIntake'), title: t('acc.toIntakeHint'), onclick: () => { if (!ACC.sel.size) return msg('#accMsg', 'warn', t('acc.pickLines')); accToIntake([...ACC.sel]); } }),
    el('button', { className: 'btn', type: 'button', textContent: t('acc.skip'), onclick: () => { if (ACC.sel.size) accSkip([...ACC.sel], true); } })]));
  // Lines left out, to put back.
  const skipped = ACC.lines.filter(l => l.scope === 'skip' && l.status === 'active' && accYear(l) >= ACC.year && accQ(l.description));
  if (skipped.length) card.append(el('details', { className: 'lqlog' }, [el('summary', { textContent: t('acc.skipped', { n: skipped.length }) }),
    el('ul', {}, skipped.slice(0, 200).map(l => el('li', {}, [`${l.description} · ${lqN(l.cost)} · ${l.skip_reason || ''} `,
      edit ? el('button', { className: 'btn tiny', type: 'button', textContent: t('acc.unskip'), onclick: () => accSkip([l.id], false) }) : ''])))]));
  body.append(card);
}

/* What no longer agrees: a linked line changed or gone in the latest file; an
   asset liquidated / destroyed / lost in the app while accounting still has
   its line without a liquidation number; a line accounting wrote off while the
   asset is still in use. */
function accDiffs() {
  if (!ACC.ready) return [];
  const last = new Map(); for (const i of ACC.imports) if (i.status === 'done' && !last.has(i.kind)) last.set(i.kind, i.period);
  const out = [];
  for (const ch of ACC.changes) {
    const l = ACC.lineMap.get(ch.line_id); if (!l || !ACC.byLine.has(l.id) || ch.period !== last.get(l.kind)) continue;
    if (!['cost', 'term_months', 'dept', 'start_date', 'status'].includes(ch.field)) continue;
    out.push({ kind: 'change', l, ch });
  }
  for (const l of ACC.lines) {
    const as = (ACC.byLine.get(l.id) || []).map(k => ACC.assetMap.get(k.asset_id)).filter(Boolean);
    if (!as.length) continue;
    const gone = as.filter(a => ['7', '9', '0', '23'].includes(String(a.status_code)));
    if (gone.length && !l.liquidation_no && l.status === 'active') out.push({ kind: 'writeoff', l, as: gone });
    if (l.liquidation_no && as.some(a => !['7', '9', '0', '23', '8', '24'].includes(String(a.status_code)))) out.push({ kind: 'still', l, as });
  }
  return out;
}
function accDiffTab(body, diffs, edit) {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('acc.t.diff') }), el('div', { className: 'tdnote', textContent: t('acc.diffHint') })]);
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['acc.d.what', 'acc.l.line', 'acc.d.assets'].map(k => el('th', { textContent: t(k) })))]);
  for (const d of diffs.filter(d => accQ(d.l.description, d.l.project_code))) {
    const what = d.kind === 'change' ? t('acc.d.ch.' + d.ch.field, { o: d.ch.old_val ?? '—', n: d.ch.new_val ?? '—' }) : t('acc.d.' + d.kind);
    const as = d.as || (ACC.byLine.get(d.l.id) || []).map(k => ACC.assetMap.get(k.asset_id)).filter(Boolean);
    tb.append(el('tr', {}, [el('td', {}, el('span', { className: 'stg band-' + (d.kind === 'change' ? 'am' : 'bad'), textContent: what })), el('td', {}, accLineCell(d.l)),
      el('td', {}, as.map(a => el('div', {}, [el('code', { textContent: a.asset_code }), ` ${amStatusLabel(a.status_code)}`])))]));
  }
  if (!diffs.length) tb.append(el('tr', {}, el('td', { colSpan: 3, className: 'dim', textContent: t('acc.diffEmpty') })));
  card.append(el('div', { className: 'wrap' }, tb));
  const wo = diffs.filter(d => d.kind === 'writeoff');
  if (wo.length) card.append(el('button', { className: 'btn', type: 'button', style: 'margin-top:8px', textContent: t('acc.woExport', { n: wo.length }), onclick: () => {
    const rows = wo.map(d => ({ [t('acc.x.row')]: d.l.src_row, Sheet: t(ACC_KINDS[d.l.kind]), Description: d.l.description, [t('acc.x.cost')]: Number(d.l.cost),
      'Mã TS': d.as.map(a => a.asset_code).join('; '), [t('acc.d.status')]: d.as.map(a => amStatusLabel(a.status_code)).join('; ') }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Ghi giam'); XLSX.writeFile(wb, `phcl-de-nghi-ghi-giam-${bkStamp()}.xlsx`);
  } }));
  body.append(card);
}

// Typed percentages for one line (settlement breakdowns rarely follow the provisional prices).
function accManual(l, ks) {
  const n = ks.length, cost = n0(l.cost);
  const pct = new Map(ks.map(k => [k.asset_id, k.share != null ? Math.round(k.share * 100000) / 1000 : Math.round(100000 / n) / 1000]));
  const sum = el('b'), out = el('div', { className: 'msg' });
  const show = () => { const s = [...pct.values()].reduce((a, b) => a + n0(b), 0);
    sum.textContent = t('acc.a.sum', { p: Math.round(s * 1000) / 1000 }); sum.className = Math.abs(s - 100) > 0.1 ? 'lqneg' : ''; };
  const rows = ks.map(k => { const a = ACC.assetMap.get(k.asset_id) || { asset_code: '#' + k.asset_id };
    const amt = el('span', { className: 'dim' });
    const put = () => { amt.textContent = cost ? lqN(Math.round(cost * n0(pct.get(k.asset_id)) / 100)) : ''; };
    const i = el('input', { type: 'number', step: '0.001', min: '0', max: '100', value: pct.get(k.asset_id), className: 'accpct' });
    i.oninput = () => { pct.set(k.asset_id, i.value === '' ? 0 : Number(i.value)); put(); show(); };
    put();
    return el('div', { className: 'accman' }, [el('code', { textContent: a.asset_code }), el('span', { textContent: accAssetName(a) }), i, '%', amt]); });
  show();
  const save = el('button', { className: 'btn primary tiny', type: 'button', textContent: t('acc.a.save'), onclick: async () => {
    const s = [...pct.values()].reduce((a, b) => a + n0(b), 0);
    if (Math.abs(s - 100) > 0.1) return msg(out, 'err', t('acc.a.sumErr', { p: Math.round(s * 1000) / 1000 }));
    // The last share absorbs rounding so the database sees exactly 1.
    const ids = [...pct.keys()], sh = {};
    let acc = 0;
    ids.forEach((id, j) => { const v = j < ids.length - 1 ? Math.round(n0(pct.get(id)) / 100 * 1e6) / 1e6 : Math.round((1 - acc) * 1e6) / 1e6; sh[id] = v; acc += v; });
    try { await SB.rpc('am_acc_allocate', { p_line: l.id, p_mode: 'manual', p_shares: sh }); ACC.manual = null; await accLoad(); } catch (e) { msg(out, 'err', e.message); }
  } });
  return el('div', { className: 'accmanbox' }, [el('div', { className: 'tdnote', textContent: t('acc.a.manualHint') }), ...rows,
    el('div', { className: 'row' }, [sum, save, el('button', { className: 'btn tiny', type: 'button', textContent: t('auth.cancel'), onclick: () => { ACC.manual = null; accRender(); } })]), out]);
}
// Lines holding several assets, linked but not allocated yet ("link first, allocate when the facts are in").
function accAllocTab(body, groups, edit) {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('acc.t.alloc') }), el('div', { className: 'tdnote', textContent: t('acc.allocHint') })]);
  const all = ACC.lines.filter(l => (ACC.byLine.get(l.id) || []).length > 1 && accQ(l.description, l.project_code));
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['acc.l.line', 'acc.a.assets', ''].map(k => el('th', { textContent: k ? t(k) : '' })))]);
  for (const l of all) {
    const ks = ACC.byLine.get(l.id), open = ks.some(k => k.share == null);
    tb.append(el('tr', {}, [el('td', {}, [accLineCell(l), el('span', { className: 'lqbs ' + (open ? 'open' : 'valued'), textContent: t(open ? 'acc.a.open' : 'acc.a.done') })]),
      el('td', {}, el('div', { className: 'accchips' }, accChips(l, edit))),
      el('td', { className: 'nowrap' }, edit ? [el('button', { className: 'btn tiny', type: 'button', textContent: t('acc.a.price'), onclick: () => accAllocate(l.id, 'price') }),
        el('button', { className: 'btn tiny', type: 'button', textContent: t('acc.a.equal'), onclick: () => accAllocate(l.id, 'equal') }),
        el('button', { className: 'btn tiny', type: 'button', textContent: t('acc.a.manual'), onclick: () => { ACC.manual = ACC.manual === l.id ? null : l.id; accRender(); } }),
        ...(open ? [] : [el('button', { className: 'btn tiny', type: 'button', textContent: t('acc.a.clear'), onclick: () => accAllocate(l.id, 'clear') })])] : '')]));
    if (edit && ACC.manual === l.id) tb.append(el('tr', {}, el('td', { colSpan: 3 }, accManual(l, ks))));
  }
  if (!all.length) tb.append(el('tr', {}, el('td', { colSpan: 3, className: 'dim', textContent: t('lq.none') })));
  card.append(el('div', { className: 'wrap' }, tb));
  body.append(card);
}
