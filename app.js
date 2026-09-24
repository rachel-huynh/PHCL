/* asset-intake — internal tool (phase 1: master data + counters)
   PUBLIC repo: no URL/key is embedded. Settings come from localStorage or from
   a #sbcfg=<base64> fragment, which is stripped from the address bar at once.
   All user-facing text goes through t() in i18n.js — English is official. */
'use strict';

/* Shown in the sidebar. If this does not match the ?v= on the script tag in
   AssetManagement.html, the browser is running a cached older app.js — which
   looks identical to "the change did not work". Check here first. */
const APP_VERSION = '20260924c';

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
  // key: the status text to put back after a language switch ("signed out"
  // must not turn into "not configured" just because the language changed).
  CONN = { ok, host: ok ? hostOrKey : '', key: ok ? 'conn.ok' : hostOrKey };
  $('#dot').classList.toggle('on', !!ok);
  $('#connTxt').textContent = t(ok ? 'conn.ok' : hostOrKey);
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
  },
  // Keyed by the accounting vendor code, so phase 5 can match the bank export.
  pm_vendor: {
    pk: 'code', order: 'name',
    cols: [T('code', { w: 120 }), T('name', { w: 320 }), T('tax_code', { w: 130 }),
           T('aliases', { w: 380 }), T('active', { type: 'bool' }), T('note', { w: 260 })]
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
      const tb = el('table');
      // Header carries the same alignment as its cells — the rule the register
      // already follows, so a column of numbers reads as one right-ranged block.
      tb.append(el('tr', {}, [['cnt.col.dept'], ['cnt.col.letters'],
                              ['cnt.col.next', 1], ['cnt.col.updated']]
        .map(([k, n]) => el('th', { className: n ? 'num' : '', textContent: t(k) }))));
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
  ['nav.assets', [
    ['register', 'nav.register'],
    ['intake', 'nav.intake'],
    ['alr', 'nav.alr'],
    ['counter', 'nav.counter']
  ]],
  // Budget and projects: the dashboard first, because it is what the people who
  // approve open this for; import last, because it is done once in a while.
  ['nav.pm', [
    ['inbox', 'nav.inbox'],
    ['pmdash', 'nav.pmdash'],
    ['budget', 'nav.budget'],
    ['projects', 'nav.projects'],
    ['tbl:pm_vendor', null],
    ['pmimport', 'nav.pmimport'],
    ['chains', 'nav.chains']
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
    ['backup', 'nav.backup'],
    ['users', 'nav.users'], ['perms', 'nav.perms'], ['audit', 'nav.audit'],
    ['setup', 'nav.setup']
  ]]
];

let VIEW = 'setup';

/* Which permission module a screen belongs to. The Connection screen belongs to
   none: it has to open before anyone can sign in, because a first visit has no
   project URL yet. */
function viewModule(v) {
  if (!v || v === 'setup') return null;
  if (['register', 'intake', 'alr', 'counter'].includes(v)) return 'assets';
  if (['users', 'perms', 'audit'].includes(v)) return 'security';
  if (v === 'pmdash') return 'report';
  if (v === 'budget' || v === 'pmimport') return 'budget';
  if (v === 'projects' || v === 'tbl:pm_vendor' || v === 'doc') return 'project';
  if (v === 'inbox' || v === 'chains') return 'approval';
  if (['sources', 'backup', 'tbl:am_setting'].includes(v)) return 'system';
  if (v === 'cat' || v.startsWith('tbl:')) return 'master';
  return null;
}
const canView = v => { const m = viewModule(v); return !m || can(m, 'view'); };

/* Where to land after signing in: the register for anyone allowed to see it,
   otherwise the first screen the menu offers them. */
function firstView() {
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
  if (viewTable(VIEW) && view !== VIEW && CUR) {
    const n = CUR.rows.filter(r => r.isNew || r.dirty || r.del).length;
    if (n && !confirm(t('table.confirmLeave', { n }))) return;
  }
  if (VIEW === 'doc' && view !== 'doc' && WF.dirty && wfEditable() && !confirm(t('wf.leave'))) return;
  if (view !== 'doc') WF.dirty = false;
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
    if (view === 'pmdash' && SB.ready()) pdLoad();
    if (view === 'budget' && SB.ready()) pbLoad();
    if (view === 'projects' && SB.ready()) ppLoad();
    if (view === 'pmimport' && SB.ready()) pmLookups().catch(() => {});
    if (view === 'users' && SB.ready()) usLoad();
    if (view === 'perms' && SB.ready()) pmLoad();
    if (view === 'audit' && SB.ready()) auLoad();
    if (view === 'inbox' && SB.ready()) wfInboxLoad();
    if (view === 'chains' && SB.ready()) wfChainsLoad();
    if (view === 'doc' && SB.ready()) wfLoad();
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

  $('#connTxt').textContent = t(CONN.ok ? 'conn.ok' : CONN.key || 'conn.none');
  applyHelp();
  renderAlrList();
  if (ALR.mode === 'doc') buildDoc();
  else if (ALR.mode === 'labels') buildLabels();
  // Only when signed in: on the sign-in box the language buttons work too, and
  // there is nothing to fetch yet.
  if (SB.ready() && ME) { fillPickers(); fillAlrPickers(); }
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
      tr.append(el('td', {
        className: REG_RIGHT.has(c) ? 'num' : '',
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
  $('#btnRegBulkSave').disabled = !$('#regBulkLoc').value && !$('#regBulkDept').value;
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
  if (!loc && !dep) return;
  const ids = [...REG.sel];

  /* Changing department is not an edit to one cell. am_asset_code_ck ties the
     asset code to the department, so the code is REISSUED and any label already
     printed now shows the wrong one. Say that before it happens, not after. */
  const ask = dep ? t('reg.bk.confirmDept', { n: fmtInt(ids.length), dept: dep })
                  : t('reg.bk.confirmLoc', { n: fmtInt(ids.length), loc });
  if (!confirm(ask)) return;

  msg(out, 'info', t('reg.bk.saving'));
  try {
    const r = (await SB.rpc('am_bulk_update',
      { p_ids: ids, p_location: loc, p_dept: dep }))[0] || {};
    const parts = [t('reg.bk.doneUpd', { n: fmtInt(r.updated || 0) })];
    if (r.recoded) parts.push(t('reg.bk.doneRecode', { n: fmtInt(r.recoded) }));
    if (r.relabel) parts.push(t('reg.bk.doneRelabel', { n: fmtInt(r.relabel) }));
    if (r.skipped_legacy) parts.push(t('reg.bk.doneLegacy', { n: fmtInt(r.skipped_legacy) }));
    REG.sel.clear();
    $('#regBulkLoc').value = ''; $('#regBulkDept').value = '';
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

    W(n, t('in.warnStatus', { i: n }));
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
    const payload = all.map(r => {
      const o = { ...r };
      delete o._review;
      o.needs_review = r.needs_review || [];
      return o;
    });
    const saved = await SB.insert('am_asset', payload);
    IN.committed = saved || payload;
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

function usRender() {
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
    SEC.perms = await SB.select('app_permission', 'select=*');
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
    const tr = el('tr', {}, el('td', { textContent: roleName(r), title: r.code }));
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
  const sel = $('#auTbl');
  if (sel.options.length) return;
  sel.append(el('option', { value: '', textContent: t('audit.allTables') }));
  for (const n of AUDIT_TABLES) sel.append(el('option', { value: n, textContent: n }));
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
  const fmtAt = s => new Date(s).toLocaleString(LANG === 'vi' ? 'vi-VN' : 'en-GB',
    { day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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

/* ------------------------------------------------------------ codes, orgs */
const pmCode = s => String(s ?? '').normalize('NFC').toUpperCase().replace(/\s+/g, '')
  .replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
const PM_CODE_OK = /^[A-Z]+(?:\.[A-Z0-9]+)*\.(?:19|20)\d{2}(?:\.\d{1,2})?$/;
const pmMain = c => { const m = /^(.*\.(?:19|20)\d{2})(?:\.\d{1,2})?$/.exec(c || ''); return m ? m[1] : (c || ''); };
const pmYear = c => { const m = /\.((?:19|20)\d{2})$/.exec(pmMain(c)); return m ? +m[1] : null; };

async function pmLookups(force) {
  if (PM.orgs.length && !force) return;
  const [orgs, alias] = await Promise.all([
    SB.select('am_org', 'select=code,name_vi,name_en,parent_code,is_department&order=code'),
    SB.select('am_org_alias', 'select=alias,code')
  ]);
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
const pmDatesOdd = p => {
  const seq = [p.request_date, p.approve_date, p.purchase_date, p.handover_date].filter(Boolean);
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) return true;
  return false;
};

/* ---------------------------------------------------------------- format */
const pmLoc = () => (LANG === 'vi' ? 'vi-VN' : 'en-US');
// Millions of VND, the unit the budget is argued in ("6,667M").
const fmtM = v => (v == null || !isFinite(v)) ? '—'
  : Math.abs(v) >= 1e6 ? fmtInt(Math.round(v / 1e6)) + 'M' : fmtInt(Math.round(v));
const fmtPct = (v, d = 1) => (v == null || !isFinite(v)) ? '—'
  : (v * 100).toLocaleString(pmLoc(), { maximumFractionDigits: d, minimumFractionDigits: d }) + '%';
const pmSum = (rows, f) => rows.reduce((s, r) => s + (Number(typeof f === 'function' ? f(r) : r[f]) || 0), 0);
const pmStatusChip = s => el('span', { className: 'st ' + s, textContent: t('pm.st.' + s) });
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
    if (pmDatesOdd(r)) notes.push(t('pm.flag.dates'));
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
    msg(out, failed.length ? 'warn' : 'ok',
        t('pm.imp.dosDone', { n: ok.length }) + (failed.length ? '\n' + t('pm.imp.dosFailed', { n: failed.length }) + '\n' + failed.join('\n') : ''));
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
      `${r.is_final ? '★ ' : ''}${r.label}${r.round_date ? ' · ' + fmtDate(r.round_date) : ''} · ${fmtInt(r.line_count)} · ${fmtM(Number(r.total_value))}` }));
  const keep = keepRound && rs.some(r => r.id === PM.bud.roundId) ? PM.bud.roundId
    : (rs.find(r => r.is_final) || rs[0] || {}).id;
  if (keep) rSel.value = keep;
  await pbRoundChanged();
}

async function pbRoundChanged() {
  const id = +$('#pbRound').value;
  PM.bud.roundId = id || null;
  PM.bud.pick = null;
  $('#pbDetail').innerHTML = '';
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
    .map(r => ({ v: r, t: r })));
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

  // Year settings: FX and cap are what every other number of the year leans on,
  // so only the budget admin may change them.
  const admin = can('budget', 'admin');
  const card = el('div', { className: 'card' });
  const row = el('div', { className: 'pmyear' });
  const inp = (key, lbl, val, w) => {
    const i = el('input', { value: val ?? '', disabled: !admin, style: `width:${w || 140}px`, inputMode: 'decimal' });
    i.dataset.k = key;
    return el('div', { className: 'fld' }, [el('label', { textContent: t(lbl) }), i]);
  };
  row.append(
    inp('fx_rate', 'pm.bud.fx', y.fx_rate ?? 26000, 110),
    inp('reserve_pct', 'pm.bud.reserve', y.reserve_pct ?? 3, 80),
    inp('ssp_revenue', 'pm.bud.sspRev', y.ssp_revenue != null ? fmtNum(y.ssp_revenue) : '', 170),
    inp('ssp_cap', 'pm.bud.sspCap', y.ssp_cap != null ? fmtNum(y.ssp_cap) : '', 170),
    inp('cp_revenue', 'pm.bud.cpRev', y.cp_revenue != null ? fmtNum(y.cp_revenue) : '', 170));
  const acts = el('div', { className: 'acts' });
  if (admin) {
    const save = el('button', { className: 'btn pri', textContent: t('tool.save') });
    save.onclick = () => pbSaveYear(row);
    acts.append(save);
  }
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
  card.append(row);
  if (round) card.append(el('div', { className: 'sd', style: 'margin-top:8px;color:var(--dim);font-size:12px',
    textContent: t('pm.bud.roundInfo', { file: round.source_file || '—', sheet: round.source_sheet || '—',
      at: (round.imported_at || '').slice(0, 10) ? fmtDate(round.imported_at.slice(0, 10)) : '—',
      by: round.imported_by || '—' }) }));
  box.append(card);
}

async function pbSaveYear(row) {
  const patch = { year: PM.bud.year };
  for (const i of row.querySelectorAll('input[data-k]')) {
    const n = xlNum(i.value);
    patch[i.dataset.k] = n;
  }
  if (!(patch.fx_rate > 0)) return msg('#pbMsg', 'err', t('pm.bud.fxNeeded'));
  try {
    await SB.call('pm_budget_year?on_conflict=year', { method: 'POST',
      headers: SB.hdr({ Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify([patch]) });
    const y = PM.bud.year;
    await pbLoad();                                 // clears #pbMsg, so report after it
    msg('#pbMsg', 'ok', t('pm.bud.yearSaved', { y }));
  } catch (e) { msg('#pbMsg', 'err', e.message); }
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
  pbYearBox();
  const head = $('#pbGrid thead'), body = $('#pbGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  const rows = pbFiltered();
  const phase = $('#pbPhase').checked;
  const qa = PM.bud.lines.some(l => l.owner_note || l.dept_response);
  const cols = [['#', 'idx'], ['pm.col.code'], ['pm.col.dept'], ['pm.col.entity'], ['pm.col.name'],
    ['pm.col.projCat'], ['pm.col.areaCat'], ['pm.col.invest'], ['pm.col.risk'],
    ['pm.col.estimate', 'num'], ['pm.col.start'], ['pm.col.end'], ['pm.col.status']];
  if (phase) for (let m = 1; m <= 12; m++) cols.push([null, 'num', pmMonthName(m)]);
  if (qa) cols.push(['pm.col.ownerNote'], ['pm.col.deptResp']);
  head.append(el('tr', {}, cols.map(([k, c, txt]) => el('th', {
    className: c === 'idx' ? 'num idx' : (c || ''), textContent: txt || (k === '#' ? '#' : t(k)) }))));
  const clip = (s, n) => !s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s;
  rows.forEach((l, i) => {
    const st = PM.bud.projByMain.get(l.project_code) || PM.bud.projByMain.get(l.current_code) || null;
    const tr = el('tr', { className: PM.bud.pick === l.id ? 'pick' : '' });
    const deptTd = el('td', { textContent: l.dept_code || '' });
    if (l.dept_code && !pmDeptKnown(l.dept_code))
      deptTd.append(el('span', { className: 'flag', textContent: '⚠', title: t('pm.flag.dept', { d: l.dept_code }) }));
    tr.append(
      el('td', { className: 'num idx', textContent: fmtInt(i + 1) }),
      el('td', {}, el('code', { textContent: l.project_code })),
      deptTd,
      el('td', { textContent: pmEntity(l.dept_code) }),
      el('td', { textContent: l.name || '', title: l.reason || '' }),
      el('td', { textContent: l.project_category || '' }),
      el('td', { textContent: l.area_category || '' }),
      el('td', { textContent: l.investment_type || '' }),
      el('td', { textContent: l.risk_level || '' }),
      el('td', { className: 'num', textContent: l.estimated_value != null ? fmtNum(Math.round(l.estimated_value)) : '' }),
      el('td', { textContent: fmtDate(l.start_date) }),
      el('td', { textContent: fmtDate(l.end_date) }),
      el('td', {}, st ? pmStatusChip(st) : el('span', { style: 'color:var(--dim)', textContent: t('pm.st.notStarted') })));
    if (phase) for (const m of PM_MONTHS)
      tr.append(el('td', { className: 'num', textContent: l[m] ? fmtNum(Math.round(l[m])) : '' }));
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
    el('td', { className: 'num', textContent: fmtNum(Math.round(pmSum(rows, 'estimated_value'))) }),
    el('td', { colSpan: 3 }));
  if (phase) for (const m of PM_MONTHS)
    tot.append(el('td', { className: 'num', textContent: fmtNum(Math.round(pmSum(rows, m))) || '' }));
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
    if (PM_DATES.includes(k) || /_date$/.test(k)) v = fmtDate(v);
    else if (typeof v === 'number' || /value|price|amount|approved/.test(k)) v = isFinite(Number(v)) ? fmtNum(Number(v)) : v;
    dl.append(el('dt', { textContent: t(lbl) }), el('dd', { textContent: String(v) }));
  }
  return dl;
}

function pbDetail(l) {
  const box = $('#pbDetail');
  box.innerHTML = '';
  const card = el('div', { className: 'card pmdet' });
  card.append(el('h2', { textContent: `${l.project_code} — ${l.name || ''}` }), pmDl(l, PM_LINE_SHOW));
  box.append(card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    const [rows, finals, vendors] = await Promise.all([
      pmSelectAll('pm_project', 'select=*&order=year.desc,code'),
      SB.select('pm_budget_round', 'select=id,year&is_final=eq.true'),
      SB.select('pm_vendor', 'select=code,name,aliases&order=name')
    ]);
    PM.prj.rows = rows;
    PM.prj.vendors = vendors;
    const ids = finals.map(f => f.id);
    const fl = ids.length
      ? await pmSelectAll('pm_budget_line', `select=project_code,current_code,name,dept_code,estimated_value,start_date,end_date,risk_level,possibility,impact,assessment,project_category,area_category,investment_type,asset_item,location,reason,round_id&round_id=in.(${ids.join(',')})`)
      : [];
    PM.prj.finalLines = fl.map(l => Object.assign(l, { year: (finals.find(f => f.id === l.round_id) || {}).year }));
    PM.prj.finalCodes = new Set(fl.flatMap(l => [l.project_code, l.current_code]).filter(Boolean));
    const ys = [...new Set(rows.map(r => r.year))].sort((a, b) => b - a);
    const ySel = $('#ppYear');
    const keep = ySel.value;
    ySel.innerHTML = '';
    ySel.append(el('option', { value: '', textContent: t('pm.f.allYears') }));
    for (const y of ys) ySel.append(el('option', { value: y, textContent: y }));
    ySel.value = ys.map(String).includes(keep) ? keep : (ys[0] ? String(ys[0]) : '');
    const bud = $('#ppBud');
    if (!bud.options.length) for (const [v, k] of [['', 'pm.f.all'], ['1', 'pm.f.budgetedOnly'], ['0', 'pm.f.unbudgetedOnly']])
      bud.append(el('option', { value: v, textContent: t(k) }));
    msSetup('ppEnt', PM_ENTITIES.map(e => ({ v: e, t: `${e} — ${t('perms.ent.' + e)}` })));
    msSetup('ppDept', [...new Set(rows.map(r => r.dept_code))].sort().map(d => ({ v: d, t: d })));
    msSetup('ppStatus', PM_STATUS.map(s => ({ v: s, t: t('pm.st.' + s) })));
    msg(out, '', '');
    ppRender();
    // Coming back from a document: reopen its project.
    const back = PM.prj.open && rows.find(r => r.code === PM.prj.open);
    PM.prj.open = null;
    if (back) { PM.prj.pick = back.code; ppRender(); ppDetail(back); }
  } catch (e) { msg(out, 'err', e.message); }
}

function ppFiltered() {
  const y = $('#ppYear').value, bud = $('#ppBud').value;
  const ent = msValues('ppEnt'), dep = msValues('ppDept'), sts = msValues('ppStatus');
  const q = hnorm($('#ppQ').value);
  return PM.prj.rows.filter(p =>
    (!y || String(p.year) === y)
    && (bud === '' || String(Number(p.budgeted)) === bud)
    && (!ent.length || ent.includes(pmEntity(p.dept_code)))
    && (!dep.length || dep.includes(p.dept_code))
    && (!sts.length || sts.includes(p.status))
    && (!q || hnorm(`${p.code} ${p.name} ${p.chosen_vendor} ${p.asset_item}`).includes(q)));
}

function ppFlags(p) {
  const f = [];
  if (pmDatesOdd(p)) f.push(t('pm.flag.dates'));
  if (p.budgeted && !PM.prj.finalCodes.has(p.main_code)) f.push(t('pm.flag.noLine'));
  if (!pmDeptKnown(p.dept_code)) f.push(t('pm.flag.dept', { d: p.dept_code }));
  return f;
}

function ppRender() {
  const head = $('#ppGrid thead'), body = $('#ppGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  const tools = [];
  if (can('project', 'create')) tools.push(['pm.prj.new', () => ppNew()]);
  tools.push(['reg.xlsx', ppExport]);
  const bar = $('#ppMsg');
  const rows = ppFiltered();
  const cols = [['#', 'num idx'], ['pm.col.code'], ['pm.col.name'], ['pm.col.dept'], ['pm.col.budgeted'],
    ['pm.col.estimate', 'num'], ['pm.col.contract', 'num'], ['pm.col.variance', 'num'], ['pm.col.vendor'],
    ['pm.col.request'], ['pm.col.approve'], ['pm.col.purchase'], ['pm.col.handover'], ['pm.col.status']];
  head.append(el('tr', {}, cols.map(([k, c]) => el('th', { className: c || '', textContent: k === '#' ? '#' : t(k) }))));
  rows.forEach((p, i) => {
    const v = p.contract_value != null && p.estimated_value ? (p.contract_value - p.estimated_value) / p.estimated_value : null;
    const flags = ppFlags(p);
    const codeTd = el('td', {}, el('code', { textContent: p.code }));
    if (flags.length) codeTd.append(el('span', { className: 'flag', textContent: '⚠', title: flags.join('\n') }));
    const tr = el('tr', { className: PM.prj.pick === p.code ? 'pick' : '' }, [
      el('td', { className: 'num idx', textContent: fmtInt(i + 1) }),
      codeTd,
      el('td', { textContent: p.name || '' }),
      el('td', { textContent: p.dept_code }),
      el('td', { textContent: p.budgeted ? '✔' : '—' }),
      el('td', { className: 'num', textContent: p.estimated_value != null ? fmtNum(Math.round(p.estimated_value)) : '' }),
      el('td', { className: 'num', textContent: p.contract_value != null ? fmtNum(Math.round(p.contract_value)) : '' }),
      el('td', { className: 'num' + (v > 0 ? ' neg' : ''), textContent: v == null ? '' : (v > 0 ? '+' : '') + fmtPct(v) }),
      el('td', { textContent: p.chosen_vendor || '' }),
      el('td', { textContent: fmtDate(p.request_date) }),
      el('td', { textContent: fmtDate(p.approve_date) }),
      el('td', { textContent: fmtDate(p.purchase_date) }),
      el('td', { textContent: fmtDate(p.handover_date) }),
      el('td', {}, pmStatusChip(p.status))
    ]);
    tr.onclick = () => { PM.prj.pick = p.code; ppRender(); ppDetail(p); };
    body.append(tr);
  });
  if (!rows.length)
    body.append(el('tr', {}, el('td', { colSpan: cols.length, style: 'color:var(--dim);padding:14px',
      textContent: PM.prj.rows.length ? t('pm.none.filter') : t('pm.prj.empty') })));
  else {
    body.append(el('tr', { className: 'tot' }, [
      el('td', { colSpan: 5, textContent: t('pm.total', { n: fmtInt(rows.length) }) }),
      el('td', { className: 'num', textContent: fmtNum(Math.round(pmSum(rows, 'estimated_value'))) }),
      el('td', { className: 'num', textContent: fmtNum(Math.round(pmSum(rows, 'contract_value'))) }),
      el('td', { colSpan: 7 })]));
  }
  // Tools ride in the message line's slot, above the grid.
  let tb = $('#ppTools');
  if (!tb) { tb = el('div', { id: 'ppTools', className: 'row', style: 'margin:10px 0 0;justify-content:flex-end' }); bar.before(tb); }
  tb.innerHTML = '';
  for (const [k, fn] of tools) { const b = el('button', { className: 'btn' + (k === 'pm.prj.new' ? ' pri' : ''), textContent: t(k) }); b.onclick = fn; tb.append(b); }
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

async function ppDetail(p) {
  const box = $('#ppDetail');
  box.innerHTML = '';
  const card = el('div', { className: 'card pmdet' });
  const share = p.share_pct != null ? Object.assign({}, p, { share_pct: fmtPct(Number(p.share_pct), 0) }) : p;
  card.append(el('h2', { textContent: `${p.code} — ${p.name || ''}` }));
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
        ['pm.vs.technique', 'num'], ['pm.vs.finance', 'num'], ['pm.vs.total', 'num'], ['pm.vs.chosen']]
        .map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
      const f1 = v => v == null ? '' : Number(v).toLocaleString(pmLoc(), { maximumFractionDigits: 1 });
      for (const s of sc) tb.append(el('tr', {}, [
        el('td', { textContent: s.vendor_name }),
        el('td', { className: 'num', textContent: s.total_amount != null ? fmtNum(s.total_amount) : '' }),
        el('td', { className: 'num', textContent: f1(s.ability) }),
        el('td', { className: 'num', textContent: f1(s.technique) }),
        el('td', { className: 'num', textContent: f1(s.finance) }),
        el('td', { className: 'num', textContent: f1(s.total_score) }),
        el('td', { textContent: s.chosen ? '✔' : '' })]));
      card.append(el('h2', { style: 'margin-top:14px', textContent: t('pm.vs.h') }), el('div', { className: 'wrap' }, tb));
    }
  } catch {}
  // The procurement documents. Before 19_pm_workflow.sql is run the tables do
  // not exist, and the project screen must keep working without them.
  try { await wfProjectPanel(p, card); } catch {}
  if (can('project', 'edit')) card.append(ppEditForm(p));
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* The execution facts that change as the project moves. Phase 3 replaces most
   of this with the document workflow; until then someone must be able to
   correct a date or record the contract. */
function ppEditForm(p) {
  const wrap = el('div', { style: 'margin-top:14px' });
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
    for (const i of row.querySelectorAll('[data-k]')) {
      const k = i.dataset.k, ty = i.dataset.type, v = i.value.trim();
      patch[k] = ty === 'date' ? (v || null) : ty === 'select' ? (v || null)
        : /value|volume/.test(k) ? xlNum(v) : (v || null);
    }
    try {
      await SB.patch('pm_project', `code=eq.${encodeURIComponent(p.code)}`, patch);
      await ppLoad();                               // clears #ppMsg, so report after it
      msg('#ppMsg', 'ok', t('pm.prj.saved', { code: p.code }));
      const again = PM.prj.rows.find(r => r.code === p.code);
      if (again) ppDetail(again);
    } catch (e) { msg('#ppMsg', 'err', e.message); }
  };
  acts.append(save);
  if (can('project', 'admin')) {
    const del = el('button', { className: 'btn danger', textContent: t('pm.prj.delete') });
    del.onclick = async () => {
      if (!confirm(t('pm.prj.confirmDel', { code: p.code }))) return;
      try { await SB.remove('pm_project', `code=eq.${encodeURIComponent(p.code)}`); $('#ppDetail').innerHTML = '';
            await ppLoad(); msg('#ppMsg', 'ok', t('pm.prj.deleted', { code: p.code })); }
      catch (e) { msg('#ppMsg', 'err', e.message); }
    };
    acts.append(del);
  }
  row.append(acts);
  wrap.append(row);
  return wrap;
}

/* New project: from an approved budget line (the usual case — everything is
   copied over) or unbudgeted, which needs its own code. The database refuses
   an unbudgeted code that a budget line already owns. */
function ppNew() {
  const box = $('#ppDetail');
  box.innerHTML = '';
  PM.prj.pick = null;
  const y = +$('#ppYear').value || new Date().getFullYear();
  const taken = new Set(PM.prj.rows.map(r => r.main_code));
  const free = (PM.prj.finalLines || []).filter(l => l.year === y && !taken.has(l.project_code));
  const card = el('div', { className: 'card pmdet' });
  card.append(el('h2', { textContent: t('pm.prj.newH', { y }) }));
  const row = el('div', { className: 'row', style: 'align-items:flex-end;flex-wrap:wrap' });
  const lineSel = el('select', { style: 'min-width:360px' });
  lineSel.append(el('option', { value: '', textContent: free.length ? t('pm.prj.pickLine') : t('pm.prj.noFreeLine') }));
  free.forEach((l, i) => lineSel.append(el('option', { value: i,
    textContent: `${l.project_code} — ${l.name || ''} — ${fmtM(l.estimated_value)}` })));
  const unb = el('input', { type: 'checkbox' });
  const code = el('input', { style: 'width:190px', placeholder: 'FFE.ENG.21.' + y, spellcheck: false });
  const name = el('input', { style: 'width:280px' });
  const dept = el('select', { style: 'width:120px' });
  for (const o of PM.orgs.filter(o => o.is_department)) dept.append(el('option', { value: o.code, textContent: o.code }));
  const est = el('input', { style: 'width:150px', inputMode: 'numeric' });
  const sync = () => {
    const l = free[lineSel.value];
    code.disabled = !unb.checked; lineSel.disabled = unb.checked;
    if (!unb.checked && l) { code.value = l.project_code; name.value = l.name || ''; dept.value = pmDept(l.dept_code);
                             est.value = l.estimated_value != null ? fmtNum(l.estimated_value) : ''; }
  };
  lineSel.onchange = sync; unb.onchange = sync;
  row.append(
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.prj.fromLine') }), lineSel]),
    el('label', { className: 'chk' }, [unb, el('span', { textContent: t('pm.prj.unbudgeted') })]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.code') }), code]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.name') }), name]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.dept') }), dept]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pm.col.estimate') }), est]));
  const acts = el('div', { className: 'acts' });
  const save = el('button', { className: 'btn pri', textContent: t('tool.save') });
  save.onclick = async () => {
    const c = pmCode(code.value);
    if (!PM_CODE_OK.test(c)) return msg('#ppMsg', 'err', t('pm.prj.badCode'));
    const l = unb.checked ? null : free[lineSel.value];
    const rec = pmProjRow(l ? {
      name: l.name, investment_type: l.investment_type, possibility: l.possibility, impact: l.impact,
      assessment: l.assessment, risk_level: l.risk_level, project_category: l.project_category,
      area_category: l.area_category, asset_item: l.asset_item, location: l.location, reason: l.reason,
      planned_start: l.start_date, planned_end: l.end_date } : {}, {
      code: c, main_code: pmMain(c), dept_code: dept.value, name: name.value.trim() || null,
      estimated_value: xlNum(est.value), budgeted: !unb.checked, source: 'app',
      request_date: new Date().toISOString().slice(0, 10) });
    try {
      await SB.insert('pm_project', [rec]);
      box.innerHTML = '';
      await ppLoad();                               // clears #ppMsg, so report after it
      msg('#ppMsg', 'ok', t('pm.prj.created', { code: c }));
    } catch (e) { msg('#ppMsg', 'err', e.message); }
  };
  const cancel = el('button', { className: 'btn', textContent: t('auth.cancel') });
  cancel.onclick = () => { box.innerHTML = ''; };
  acts.append(cancel, save);
  row.append(acts);
  card.append(row);
  box.append(card);
  sync();
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function ppExport() {
  const rows = ppFiltered().map((p, i) => {
    const o = { '#': i + 1 };
    for (const [k, lbl] of PM_PROJ_SHOW) o[t(lbl)] = p[k];
    o[t('pm.col.entity')] = pmEntity(p.dept_code);
    o[t('pm.col.budgeted')] = p.budgeted ? 'Y' : 'N';
    o[t('pm.col.status')] = t('pm.st.' + p.status);
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
const VZ = { grid: '#e1e0d9', axis: '#c3c2b7', ink3: '#898781', surface: '#ffffff' };
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
  const body = el('div');
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
    const show = ev => tipShow(ev, c.label, series.map(s => ({ color: s.color, label: s.label, value: fmtNum(Math.round(s.values.get(c.key) || 0)) })));
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
    tipShow(ev, months[at], series.map(s => ({ color: s.color, label: s.label, value: fmtNum(Math.round(s.values[at])) })));
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
                                             { label: t('pm.viz.value'), value: fmtNum(Math.round(p.v || 0)) }]);
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
    const track = el('div', { className: 'gt', tabindex: 0 });
    const ps = pos(it.ps), pe = pos(it.pe);
    if (ps != null && pe != null && pe > ps) track.append(el('div', { className: 'pl', style: `left:${ps}%;width:${pe - ps}%` }));
    const as = pos(it.as), ae = pos(it.ae || (it.open ? today : null));
    if (as != null && ae != null && ae >= as) track.append(el('div', { className: 'ac' + (it.ae ? '' : ' open'), style: `left:${as}%;width:${Math.max(.6, ae - as)}%` }));
    if (tpos != null) track.append(el('div', { className: 'today', style: `left:${tpos}%` }));
    const show = ev => tipShow(ev, `${it.code} — ${it.name || ''}`, [
      { color: 'var(--track)', label: t('pm.viz.planned'), value: `${fmtDate(it.ps) || '—'} → ${fmtDate(it.pe) || '—'}` },
      { color: 'var(--series-1)', label: t('pm.viz.actual'), value: `${fmtDate(it.as) || '—'} → ${fmtDate(it.ae) || (it.open ? t('pm.viz.ongoing') : '—')}` },
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
    const ys = [...new Set([...finals.map(f => f.year), ...projects.map(p => p.year)])].sort((a, b) => b - a);
    const ySel = $('#pdYear');
    const keep = +ySel.value;
    ySel.innerHTML = '';
    for (const y of ys) ySel.append(el('option', { value: y, textContent: y }));
    if (!ys.length) { msg(out, 'info', t('pm.dash.empty')); $('#pdBody').innerHTML = ''; return; }
    ySel.value = ys.includes(keep) ? keep : (ys.includes(new Date().getFullYear()) ? new Date().getFullYear() : ys[0]);
    const per = $('#pdPeriod');
    if (!per.options.length) {
      per.append(el('option', { value: 'Y', textContent: t('pm.per.year') }));
      for (let q = 1; q <= 4; q++) per.append(el('option', { value: 'Q' + q, textContent: 'Q' + q }));
      for (let m = 1; m <= 12; m++) per.append(el('option', { value: 'M' + m, textContent: pmMonthName(m) }));
    }
    const bud = $('#pdBud');
    if (!bud.options.length) for (const [v, k] of [['', 'pm.f.all'], ['1', 'pm.f.budgetedOnly'], ['0', 'pm.f.unbudgetedOnly']])
      bud.append(el('option', { value: v, textContent: t(k) }));
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
  // Hero: the one number this page leads with.
  box.append(el('div', { className: 'hero' }, [
    el('span', { className: 'hl', textContent: t('pm.dash.budget', { y }) }),
    el('span', { className: 'hv', textContent: fmtM(budget) }),
    el('span', { className: 'hs', textContent: t('pm.dash.budgetSub', {
      n: fmtInt(new Set(lines.map(l => l.project_code)).size),
      planned: fullYear ? '' : t('pm.dash.plannedIn', { p: perLabel, v: fmtM(planned) }) }) })]));

  const stats = el('div', { className: 'stats' });
  const tile = (label, value, sub, cls, meter) => {
    const d = el('div', { className: 'stat' }, [el('span', { className: 'sl', textContent: label }),
                                                  el('span', { className: 'sv', textContent: value })]);
    if (sub) d.append(el('span', { className: 'sd' + (cls ? ' ' + cls : ''), textContent: sub }));
    if (meter != null) d.append(el('div', { className: 'meter' + (meter > 1 ? ' over' : '') },
      el('i', { style: `width:${Math.min(100, Math.max(0, meter * 100))}%` })));
    return d;
  };
  if (cap && (!ent.length || ent.includes('SSP')))
    stats.append(tile(t('pm.dash.cap'), fmtPct(sspBudget / cap), t('pm.dash.capSub', { v: fmtM(sspBudget), cap: fmtM(cap) }), null, sspBudget / cap));
  stats.append(tile(fullYear ? t('pm.dash.committed') : t('pm.dash.committedIn', { p: perLabel }), fmtM(committed),
    budget ? t('pm.dash.ofBudget', { pct: fmtPct(committed / budget) }) : null));
  if (fullYear) stats.append(tile(t('pm.dash.remaining'), fmtM(budget - committed), null));
  stats.append(tile(t('pm.dash.overrun'), fmtM(overrun), t('pm.dash.overrunSub', { n: fmtInt(overrunRows.length) }), overrun > 0 ? 'down' : null));
  stats.append(tile(t('pm.dash.carried'), fmtInt(carried.length), t('pm.dash.carriedSub', { v: fmtM(pmSum(carried, 'estimated_value')) })));
  stats.append(tile(t('pm.dash.completed'), projects.length ? fmtPct(done / projects.length, 0) : '—',
    t('pm.dash.completedSub', { done: fmtInt(done), n: fmtInt(projects.length) })));
  stats.append(tile(t('pm.dash.unbudgeted'), fmtInt(unb.length), t('pm.dash.unbudgetedSub', { v: fmtM(pmSum(unb, p => p.contract_value ?? p.estimated_value)) })));
  box.append(stats);

  // Cycle time between the dated steps — the approval clock before phase 3
  // starts timing each signature.
  const span = (a, b) => { const v = projects.map(p => p[a] && p[b] && p[b] >= p[a] ? (Date.parse(p[b]) - Date.parse(p[a])) / 864e5 : null).filter(v => v != null);
                           return { avg: v.length ? v.reduce((s, x) => s + x, 0) / v.length : null, n: v.length }; };
  const cyc = el('div', { className: 'stats' });
  for (const [a, b, k] of [['request_date', 'approve_date', 'pm.dash.cyc1'], ['approve_date', 'purchase_date', 'pm.dash.cyc2'], ['purchase_date', 'handover_date', 'pm.dash.cyc3']]) {
    const s = span(a, b);
    cyc.append(tile(t(k), s.avg == null ? '—' : t('pm.dash.days', { n: fmtInt(Math.round(s.avg)) }), t('pm.dash.cycSub', { n: fmtInt(s.n) })));
  }
  box.append(cyc);

  const charts = el('div', { className: 'charts' });
  const C1 = 'var(--series-1)', C2 = 'var(--series-2)';
  // 1. Budget vs committed by department.
  const depKeys = [...new Set([...lines.map(l => l.dept_code), ...committedSet.map(p => p.dept_code)].filter(Boolean))];
  const bV = new Map(), cV = new Map();
  for (const l of lines) bV.set(l.dept_code, (bV.get(l.dept_code) || 0) + (Number(l.estimated_value) || 0));
  for (const p of committedSet) cV.set(p.dept_code, (cV.get(p.dept_code) || 0) + (Number(p.contract_value) || 0));
  depKeys.sort((a, b) => (bV.get(b) || 0) - (bV.get(a) || 0));
  const depCats = depKeys.map(k => ({ key: k, label: k }));
  const s1 = [{ label: t('pm.viz.budget'), color: '#2a78d6', values: bV }, { label: t('pm.viz.committed'), color: '#eb6834', values: cV }];
  charts.append(chartCard(t('pm.viz.byDept'), null, [{ label: s1[0].label, color: C1 }, { label: s1[1].label, color: C2 }],
    W => hbarChart(W, depCats, s1),
    () => [[t('pm.col.dept'), s1[0].label, s1[1].label], ...depKeys.map(k => [k, fmtNum(Math.round(bV.get(k) || 0)), fmtNum(Math.round(cV.get(k) || 0))])]));
  // 2. Budget by project category (one series: one colour, no legend box).
  const catV = new Map();
  for (const l of lines) { const k = l.project_category || t('pm.viz.uncategorised'); catV.set(k, (catV.get(k) || 0) + (Number(l.estimated_value) || 0)); }
  const catKeys = [...catV.keys()].sort((a, b) => catV.get(b) - catV.get(a));
  charts.append(chartCard(t('pm.viz.byCat'), null, null,
    W => hbarChart(W, catKeys.map(k => ({ key: k, label: k })), [{ label: t('pm.viz.budget'), color: '#2a78d6', values: catV }]),
    () => [[t('pm.col.projCat'), t('pm.viz.budget'), t('pm.viz.share')], ...catKeys.map(k => [k, fmtNum(Math.round(catV.get(k))), fmtPct(catV.get(k) / (budget || 1))])]));
  // 3. Plan vs committed, cumulative by month.
  const plan = [], act = [];
  let pc = 0, ac = 0;
  for (let m = 1; m <= 12; m++) {
    pc += pmSum(lines, PM_MONTHS[m - 1]);
    ac += pmSum(projects.filter(p => p.purchase_date && p.purchase_date.slice(0, 7) === `${y}-${String(m).padStart(2, '0')}`), 'contract_value');
    plan.push(pc); act.push(ac);
  }
  const mNames = Array.from({ length: 12 }, (_, i) => pmMonthName(i + 1));
  const hasPlan = pc > 0;
  const s3 = [{ label: t('pm.viz.plannedCum'), color: '#2a78d6', values: plan }, { label: t('pm.viz.committedCum'), color: '#eb6834', values: act }];
  charts.append(chartCard(t('pm.viz.overTime'), hasPlan ? null : t('pm.viz.noPhasing'),
    [{ label: s3[0].label, color: C1, line: true }, { label: s3[1].label, color: C2, line: true }],
    W => lineChart(W, mNames, s3, months),
    () => [[t('pm.viz.month'), s3[0].label, s3[1].label], ...mNames.map((m, i) => [m, fmtNum(Math.round(plan[i])), fmtNum(Math.round(act[i]))])], true));
  // 4. Risk mix — ordered, so an ordinal ramp, darkest = most severe.
  const ramp = [['Critical', '#0d366b', '#fff'], ['High', '#1c5cab', '#fff'], ['Medium', '#3987e5', '#fff'], ['Low', '#86b6ef', '#0b0b0b']];
  const parts = ramp.map(([k, c, ink]) => ({ label: k, color: c, ink, n: lines.filter(l => l.risk_level === k).length,
    v: pmSum(lines.filter(l => l.risk_level === k), 'estimated_value') }));
  const other = lines.filter(l => !PM_RISK.includes(l.risk_level));
  if (other.length) parts.push({ label: t('pm.viz.notAssessed'), color: '#cfcdc4', ink: '#0b0b0b', n: other.length, v: pmSum(other, 'estimated_value') });
  const riskCard = chartCard(t('pm.viz.risk'), t('pm.viz.riskSub', { n: fmtInt(lines.length) }),
    parts.filter(p => p.n).map(p => ({ label: `${p.label} · ${fmtInt(p.n)}`, color: p.color })),
    W => stackBar(W, parts),
    () => [[t('pm.col.risk'), t('pm.viz.projects'), t('pm.viz.share'), t('pm.viz.value')], ...parts.map(p => [p.label, fmtInt(p.n), fmtPct(p.n / (lines.length || 1)), fmtNum(Math.round(p.v))])],
    true);   // full row: alone in a half-width slot it left the other half empty
  charts.append(riskCard);
  // 5. Timeline.
  const lineOf = new Map(PM.dash.lines.map(l => [l.project_code, l]));
  const items = projects.map(p => {
    const l = lineOf.get(p.main_code) || {};
    return { code: p.code, name: p.name, status: p.status, ps: p.planned_start || l.start_date, pe: p.planned_end || l.end_date,
             as: p.request_date, ae: p.status === 'completed' ? p.handover_date : null, open: !['completed', 'cancelled'].includes(p.status) && !!p.request_date };
  }).sort((a, b) => (a.as || a.ps || '9') .localeCompare(b.as || b.ps || '9'));
  const cap40 = 40;
  let showAll = false;
  const gCard = chartCard(t('pm.viz.timeline'), t('pm.viz.timelineSub', { n: fmtInt(items.length) }),
    [{ label: t('pm.viz.planned'), color: 'var(--track)' }, { label: t('pm.viz.actual'), color: C1 }],
    W => {
      const w = el('div');
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
   forms — one generic editor driven by WF_SPECS, plus a custom one for the QC
   scoring matrix — the inbox, the chain editor and the printed form. */

const WF = { types: [], chains: [], roles: [], doc: null, steps: [], events: [], project: null,
             line: null, docs: [], year: null, inbox: [], entity: 'SSP', dirty: false };
const WF_ORDER = ['PR', 'RR', 'PA', 'QC', 'MC', 'PO', 'CT', 'AH'];
const WF_STATUS = ['draft', 'in_review', 'returned', 'rejected', 'approved', 'cancelled'];

/* Risk thresholds from the Menu sheet of the FFE template. */
const wfRisk = a => a == null || !isFinite(a) ? null : a >= 16 ? 'Critical' : a >= 12 ? 'High' : a >= 8 ? 'Medium' : 'Low';
const WF_SUGGEST = { Critical: 'Need to be processed immediately', High: 'Need to be processed ASAP',
                     Medium: 'Need to be processed after higher priorities', Low: 'May be deferred if necessary' };
const n0 = v => Number(v) || 0;
const wfSum = (rows, f) => (rows || []).reduce((s, r) => s + n0(typeof f === 'function' ? f(r) : r[f]), 0);
// Only http(s) links: an attachment is a OneDrive/SharePoint URL, never script.
const wfSafeUrl = u => /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : null;

/* QC sub-criteria, per the operator guide's appendix. */
const QC_ABILITY = ['Capital', 'Similar contracts (count)', 'Similar contract value', 'Equipment capacity', 'Rating / reputation'];
const QC_TECH = {
  equipment: ['Delivery schedule', 'Installation term', 'Warranty', 'Maintenance', 'Sustainability', 'CO / CQ certificates', 'After-sales service'],
  construction: ['Method statement', 'Construction schedule', 'Procurement lead time', 'Quality assurance', 'Warranty', 'Maintenance', 'Quality control process', 'Testing & commissioning'],
};
QC_TECH.mixed = QC_TECH.construction;
// Equal weights that add up to exactly 100: the last one takes the rounding.
const qcSubs = labels => { const w = Math.floor(10000 / labels.length) / 100;
  return labels.map((l, i) => ({ label: l, w: i < labels.length - 1 ? w : Math.round((100 - w * (labels.length - 1)) * 100) / 100 })); };
const off100 = v => Math.abs(v - 100) > 0.01;

/* ---------------------------------------------------------------- specs
   A field: { k, t, opts, calc(d, ctx), ro, wide }. t is one of
   text | area | num | money | date | select | bool | int15 | pct.
   A line column: the same, calc(l, d, ctx). */

const WF_SPECS = {
  PR: {
    head: [
      { k: 'project_type', t: 'select', opts: ['Non-consultancy', 'Consultancy'] },
      { k: 'investment_type', t: 'select', opts: ['Replacement', 'New Investment'] },
      { k: 'budget', t: 'select', opts: ['Budgeted', 'Unbudgeted'], ro: true },
      { k: 'share_pct', t: 'pct' },
      { k: 'possibility', t: 'int15' }, { k: 'impact', t: 'int15' },
      { k: 'assessment', t: 'num', ro: true, calc: d => d.possibility && d.impact ? n0(d.possibility) * n0(d.impact) : null },
      { k: 'risk_level', t: 'text', ro: true, calc: d => wfRisk(n0(d.possibility) * n0(d.impact) || null) },
      { k: 'suggestion', t: 'text', ro: true, wide: true, calc: d => WF_SUGGEST[wfRisk(n0(d.possibility) * n0(d.impact) || null)] || '' },
      { k: 'reason', t: 'area', wide: true },
      { k: 'cost_benchmark', t: 'select', opts: ['Quotation', 'Previous Project', 'Price Reference', 'Internet'] },
      { k: 'supplier', t: 'text' }
    ],
    lines: { cols: [{ k: 'asset_item', t: 'text', w: 220, product: true }, { k: 'rationale', t: 'area', w: 240 },
                    { k: 'tech_standard', t: 'area', w: 200 }, { k: 'location', t: 'text', w: 100 },
                    { k: 'qty', t: 'num', w: 70 }, { k: 'unit_price', t: 'money', w: 130 },
                    { k: 'amount', t: 'money', w: 140, calc: l => n0(l.qty) * n0(l.unit_price) }] },
    terms: [{ k: 'warranty_term', t: 'text' }, { k: 'delivery_term', t: 'text' }, { k: 'start_date', t: 'date' },
            { k: 'note', t: 'area', wide: true }],
    total: d => wfSum(d.lines, l => n0(l.qty) * n0(l.unit_price))
  },
  RR: {
    head: [
      { k: 'replacement_level', t: 'select', opts: ['Full replacement', 'Partial replacement', 'Upgrade', 'Renovation'] },
      { k: 'after_replacement', t: 'select', opts: ['Liquidation', 'Transfer', 'Keep as spare', 'Scrap'] }
    ],
    lines: { assetLookup: true,
             cols: [{ k: 'asset_code', t: 'text', w: 190 }, { k: 'asset_item', t: 'text', w: 200 },
                    { k: 'condition', t: 'select', w: 110, opts: ['Like new', 'Poor', 'Damaged'] },
                    { k: 'reason', t: 'select', w: 140, opts: ['High repair cost', 'Obsolete', 'Irreparable', 'Breakage/loss'] },
                    { k: 'dep_done', t: 'bool', w: 70 }, { k: 'qty', t: 'num', w: 60 }, { k: 'unit', t: 'text', w: 60 },
                    { k: 'original_value', t: 'money', w: 130 }] },
    terms: [{ k: 'note', t: 'area', wide: true }],
    evidence: true,
    total: d => wfSum(d.lines, 'original_value')
  },
  PA: {
    head: [
      { k: 'budget_value', t: 'money', ro: true, calc: (d, c) => c.budgetValue },
      { k: 'estimated_value', t: 'money', ro: true, calc: (d, c) => c.prTotal },
      { k: 'fx', t: 'money', ro: true, calc: (d, c) => c.fx },
      { k: 'overrun', t: 'money', ro: true, calc: (d, c) => c.budgetValue != null ? c.prTotal - c.budgetValue : null },
      { k: 'overrun_pct', t: 'text', ro: true, calc: (d, c) => c.budgetValue ? fmtPct((c.prTotal - c.budgetValue) / c.budgetValue) : '—' },
      { k: 'overrun_usd', t: 'money', ro: true, calc: (d, c) => c.budgetValue != null ? Math.round((c.prTotal - c.budgetValue) / c.fx) : null },
      { k: 'risk_assessment', t: 'num', ro: true, calc: (d, c) => c.prAssessment },
      { k: 'emergency', t: 'bool' },
      { k: 'gate', t: 'text', ro: true, wide: true, calc: (d, c) => paGate(d, c).text },
      { k: 'recommendation', t: 'select', opts: ['Proceed', 'Proceed with conditions', 'Revise', 'Reject'] },
      { k: 'comments', t: 'area', wide: true }
    ],
    evidence: true,
    total: (d, c) => c.prTotal
  },
  MC: {
    head: [{ k: 'tolerance_pct', t: 'num', ro: true, calc: () => 10 }, { k: 'fv_rate_pct', t: 'num', ro: true, calc: () => 4.6 }],
    lines: { cols: [{ k: 'item', t: 'text', w: 220 }, { k: 'qty', t: 'num', w: 60 },
                    { k: 'chosen_price', t: 'money', w: 130 },
                    { k: 'ref_type', t: 'select', w: 140, opts: ['Market quote', 'Historical project', 'Internet'] },
                    { k: 'ref_source', t: 'text', w: 200 }, { k: 'ref_price', t: 'money', w: 130 },
                    { k: 'ref_date', t: 'date', w: 130 },
                    // Old prices are brought forward at 4.6% a year before comparing.
                    { k: 'ref_adjusted', t: 'money', w: 130, calc: l => mcAdjusted(l) },
                    { k: 'diff_pct', t: 'text', w: 80, calc: l => { const a = mcAdjusted(l); return a ? fmtPct((n0(l.chosen_price) - a) / a) : ''; } },
                    { k: 'within', t: 'text', w: 80, calc: l => { const a = mcAdjusted(l); return !a || !l.chosen_price ? '' : (n0(l.chosen_price) - a) / a <= 0.10 ? '✔' : '✘'; } }] },
    terms: [{ k: 'conclusion', t: 'area', wide: true }],
    evidence: true,
    total: d => wfSum(d.lines, l => n0(l.qty || 1) * n0(l.chosen_price))
  },
  PO: {
    head: [{ k: 'order_date', t: 'date' }, { k: 'supplier', t: 'text' }],
    lines: { specs: true,
             cols: [{ k: 'asset_item', t: 'text', w: 230, product: true }, { k: 'origin', t: 'text', w: 100 },
                    { k: 'warranty_months', t: 'num', w: 80 }, { k: 'qty', t: 'num', w: 60 },
                    { k: 'unit', t: 'text', w: 60 }, { k: 'unit_price', t: 'money', w: 130 },
                    { k: 'amount', t: 'money', w: 140, calc: l => n0(l.qty) * n0(l.unit_price) }] },
    terms: [{ k: 'overheads', t: 'money' }, { k: 'delivery_term', t: 'text' }, { k: 'payment_term', t: 'text' },
            { k: 'warranty_term', t: 'text' }, { k: 'progress', t: 'text' }, { k: 'note', t: 'area', wide: true }],
    total: d => wfSum(d.lines, l => n0(l.qty) * n0(l.unit_price)) + n0(d.overheads)
  },
  CT: {
    head: [{ k: 'contract_no', t: 'text' }, { k: 'signed_date', t: 'date' }, { k: 'value', t: 'money' },
           { k: 'warranty_months', t: 'num' }, { k: 'file_link', t: 'text', wide: true }],
    lines: { cols: [{ k: 'milestone', t: 'select', w: 150, opts: ['Deposit', 'Progress', 'Handover', 'Retention'] },
                    { k: 'pct', t: 'num', w: 80 }, { k: 'amount', t: 'money', w: 150, calc: (l, d) => Math.round(n0(d.value) * n0(l.pct) / 100) },
                    { k: 'due', t: 'text', w: 240 }] },
    terms: [{ k: 'note', t: 'area', wide: true }],
    total: d => n0(d.value)
  },
  AH: {
    head: [{ k: 'handover_date', t: 'date' }, { k: 'final', t: 'bool' },
           { k: 'evaluation', t: 'select', opts: ['Excellent', 'Satisfactory', 'Unsatisfactory'] },
           { k: 'evaluation_detail', t: 'area', wide: true }],
    lines: { specs: true,
             cols: [{ k: 'asset_item', t: 'text', w: 230, product: true }, { k: 'origin', t: 'text', w: 100 },
                    { k: 'warranty_months', t: 'num', w: 80 }, { k: 'qty', t: 'num', w: 60 },
                    { k: 'unit', t: 'text', w: 60 }, { k: 'location', t: 'text', w: 100 },
                    { k: 'unit_price', t: 'money', w: 130 },
                    { k: 'amount', t: 'money', w: 140, calc: l => n0(l.qty) * n0(l.unit_price) }] },
    terms: [{ k: 'warranty_term', t: 'text' }, { k: 'maintenance_term', t: 'text' }, { k: 'retained_amount', t: 'money' },
            { k: 'note', t: 'area', wide: true }],
    evidence: true,
    total: d => wfSum(d.lines, l => n0(l.qty) * n0(l.unit_price))
  }
};

/* The PA gate, from the FFE Assessment Hub:
     budgeted   → accept when the overrun is under 10% OR under USD 50,000;
     unbudgeted → only an emergency with risk ≥ 16 and value under USD 50,000. */
function paGate(d, c) {
  const usd = 50000 * c.fx;
  if (c.budgeted) {
    if (c.budgetValue == null) return { ok: false, text: t('wf.pa.noBudget') };
    const over = c.prTotal - c.budgetValue;
    const ok = over <= 0 || over / c.budgetValue < 0.10 || over < usd;
    return { ok, text: t(ok ? 'wf.pa.passBud' : 'wf.pa.failBud', { pct: fmtPct(over / c.budgetValue), usd: fmtInt(Math.round(over / c.fx)) }) };
  }
  const ok = !!d.emergency && n0(c.prAssessment) >= 16 && c.prTotal < usd;
  return { ok, text: t(ok ? 'wf.pa.passUnb' : 'wf.pa.failUnb', { a: c.prAssessment ?? '—', usd: fmtInt(Math.round(c.prTotal / c.fx)) }) };
}
function mcAdjusted(l) {
  const p = n0(l.ref_price);
  if (!p) return null;
  if (l.ref_type !== 'Historical project' || !l.ref_date) return p;
  const years = (Date.now() - Date.parse(l.ref_date)) / (365.25 * 864e5);
  return Math.round(p * Math.pow(1.046, Math.max(0, years)));
}

/* ------------------------------------------------------- QC scoring maths
   ability / technique = Σ sub-weight × sub-score. Finance = price weight ×
   (lowest price ÷ this price × 100) + payment weight × payment score — the
   formula that reproduces the guide's worked example (80 / 96 / 90). Total =
   Σ criterion weight × criterion score. */
function qcScore(d) {
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
function wfCanPrepare(type, dept) {
  const prep = wfChain(pmEntity(dept), type).find(c => c.step === 0);
  return can('project', 'create') && !!prep && wfHasRoleFor(prep.role_code, dept);
}
function wfCanAct(doc, step, dept) {
  return doc.status === 'in_review' && !!step && can('approval', 'approve')
    && doc.created_by !== (ME && ME.id) && wfHasRoleFor(step.role_code, dept);
}
const wfRoleName = code => { const r = WF.roles.find(x => x.code === code); return r ? (LANG === 'vi' ? r.name_vi : r.name_en) : code; };
const wfTypeName = code => { const r = WF.types.find(x => x.code === code); return r ? (LANG === 'vi' ? r.name_vi : r.name_en) : code; };
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

/* ------------------------------------------ the documents of one project */
async function wfProjectPanel(p, host) {
  await wfLookups();
  const docs = await SB.select('pm_doc', `select=id,doc_type,doc_no,status,current_step,version,total_value,created_by,created_email,submitted_at,decided_at,data&project_code=eq.${encodeURIComponent(p.code)}&order=created_at`);
  const card = el('div', { style: 'margin-top:14px' });
  card.append(el('h2', { textContent: t('wf.docs') }));
  const strip = el('div', { className: 'wfstrip' });
  const approved = type => docs.some(d => d.doc_type === type && d.status === 'approved');
  const replacement = /replace/i.test(p.investment_type || '');
  for (const type of WF_ORDER) {
    const tt = WF.types.find(x => x.code === type) || {};
    const mine = docs.filter(d => d.doc_type === type && d.status !== 'cancelled');
    const box = el('div', { className: 'wfbox' });
    box.append(el('div', { className: 'wft' }, [el('b', { textContent: type }), document.createTextNode(' ' + wfTypeName(type))]));
    if (!tt.required && !(type === 'RR' && replacement)) box.append(el('div', { className: 'wfopt', textContent: t('wf.optional') }));
    for (const d of mine) {
      const a = el('a', { href: '#', className: 'wfdoc' }, [el('code', { textContent: d.doc_no }), wfChip(d.status)]);
      a.onclick = ev => { ev.preventDefault(); wfOpen(d.id); };
      box.append(a);
    }
    // "Create" only when the earlier required steps are approved — the same
    // rule pm_doc_create enforces.
    const seq = tt.seq || 0;
    const blockers = WF.types.filter(x => x.seq < seq && (x.required || (x.code === 'RR' && replacement)) && !approved(x.code));
    // One live document per type; AH repeats (one open at a time) until the final one.
    const live = mine.filter(d => d.status !== 'rejected');
    const finalAH = docs.some(d => d.doc_type === 'AH' && d.status === 'approved' && d.data && d.data.final);
    const room = tt.repeatable ? !finalAH && !live.some(d => ['draft', 'in_review', 'returned'].includes(d.status)) : !live.length;
    // An optional step (RR, CT) cannot be slotted in once a later one exists.
    const later = docs.some(d => !['rejected', 'cancelled'].includes(d.status)
      && ((WF.types.find(x => x.code === d.doc_type) || {}).seq || 0) > seq);
    if (!blockers.length && room && !later && wfCanPrepare(type, p.dept_code)) {
      const b = el('button', { className: 'btn tiny pri', textContent: t('wf.create') });
      b.onclick = () => wfCreate(p, type, docs);
      box.append(b);
    }
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

async function wfPrefill(p, type, docs) {
  const get = tp => docs.find(d => d.doc_type === tp && d.status === 'approved');
  const line = (await wfFinalLine(p)) || {};
  const prLines = (get('PR')?.data?.lines) || [];
  if (type === 'PR') return {
    project_type: 'Non-consultancy', investment_type: p.investment_type || line.investment_type || 'Replacement',
    budget: p.budgeted ? 'Budgeted' : 'Unbudgeted', share_pct: p.share_pct != null ? Number(p.share_pct) : 1,
    possibility: p.possibility ?? line.possibility ?? null, impact: p.impact ?? line.impact ?? null,
    reason: p.reason || line.reason || '', cost_benchmark: line.reference || 'Quotation',
    supplier: p.proposed_supplier || line.supplier || '',
    lines: [{ asset_item: p.asset_item || line.asset_item || '', rationale: line.rationale || p.rationale || '',
              tech_standard: line.tech_standard || p.tech_standard || '', location: p.location || line.location || '',
              qty: line.quantity ?? 1, unit_price: line.unit_price ?? p.estimated_value ?? null }]
  };
  if (type === 'RR') return { replacement_level: 'Full replacement', after_replacement: 'Liquidation', lines: [], evidence: [] };
  if (type === 'PA') return { emergency: false, recommendation: '', comments: '', evidence: [] };
  if (type === 'QC') {
    const pt = /x[aâ]y|constr/i.test(p.project_type || '') ? 'construction' : /h[oỗ]n|mix/i.test(p.project_type || '') ? 'mixed' : 'equipment';
    return { date: new Date().toISOString().slice(0, 10), project_type: pt, procurement_type: p.procurement_type || 'Competitive Quotation',
             w_ability: 20, w_technique: 40, w_finance: 40, w_price: 80, w_pay: 20,
             sub_ability: qcSubs(QC_ABILITY), sub_technique: qcSubs(QC_TECH[pt]),
             total_vendors: 3, vendors: [{ name: '' }, { name: '' }, { name: '' }], chosen_vendor: '', comments: '' };
  }
  if (type === 'MC') return { lines: prLines.map(l => ({ item: l.asset_item, qty: l.qty, ref_type: 'Market quote' })), conclusion: '', evidence: [] };
  if (type === 'PO') return { order_date: new Date().toISOString().slice(0, 10), supplier: get('QC')?.data?.chosen_vendor || '',
    lines: prLines.map(l => ({ asset_item: l.asset_item, qty: l.qty, unit: 'pcs', unit_price: l.unit_price, location: l.location })) };
  if (type === 'CT') { const po = get('PO'); return { value: po ? n0(po.total_value) : null, lines: [{ milestone: 'Deposit', pct: 50 }, { milestone: 'Handover', pct: 50 }] }; }
  if (type === 'AH') { const po = get('PO'); return { handover_date: new Date().toISOString().slice(0, 10), final: true, evaluation: 'Satisfactory',
    lines: ((po && po.data && po.data.lines) || []).map(l => Object.assign({}, l)), evidence: [] }; }
  return {};
}

async function wfCreate(p, type, docs) {
  try {
    const data = await wfPrefill(p, type, docs);
    const spec = WF_SPECS[type];
    Object.assign(WF, { project: p, docs, line: null });
    data.total = type === 'QC' ? null : (spec && spec.total ? spec.total(data, wfCtx()) : null);
    const id = await SB.rpc('pm_doc_create', { p_project: p.code, p_type: type, p_data: data });
    await wfOpen(id);
  } catch (e) { msg('#ppMsg', 'err', e.message); }
}

/* ------------------------------------------------------------ doc screen */
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
    const [doc] = await SB.select('pm_doc', `select=*&id=eq.${WF.openId}`);
    if (!doc) { msg(out, 'err', t('wf.gone')); return; }
    const [project] = await SB.select('pm_project', `select=*&code=eq.${encodeURIComponent(doc.project_code)}`);
    const [steps, events, docs, years] = await Promise.all([
      SB.select('pm_doc_step', `select=*&doc_id=eq.${doc.id}&order=step`),
      SB.select('pm_doc_event', `select=*&doc_id=eq.${doc.id}&order=at`),
      SB.select('pm_doc', `select=id,doc_type,doc_no,status,total_value,data&project_code=eq.${encodeURIComponent(doc.project_code)}`),
      SB.select('pm_budget_year', `select=*&year=eq.${project ? project.year : 0}`)
    ]);
    const line = project ? await wfFinalLine(project) : null;
    Object.assign(WF, { doc, project, steps, events, docs, year: years[0] || null, line: line || null, dirty: false });
    WF.data = JSON.parse(JSON.stringify(doc.data || {}));
    msg(out, '', '');
    wfRender();
    // Who the document is waiting for, by name.
    if (doc.status === 'in_review') {
      try {
        const who = await SB.rpc('pm_next_actors', { p_id: doc.id });
        const n = $('#wdWho');
        if (n) n.textContent = who.length ? who.map(w => w.full_name || w.email).join(', ') : t('wf.nobody');
      } catch {}
    }
  } catch (e) { msg(out, 'err', e.message); }
}

const wfEditable = () => WF.doc && ['draft', 'returned'].includes(WF.doc.status)
  && (WF.doc.created_by === (ME && ME.id) || wfCanPrepare(WF.doc.doc_type, WF.project.dept_code));

function wfRender() {
  const box = $('#wdBody');
  box.innerHTML = '';
  const d = WF.doc, p = WF.project || {};
  const step = WF.steps.find(s => s.step === d.current_step);
  const edit = wfEditable();
  $('#pageTitle').textContent = `${d.doc_no} — ${wfTypeName(d.doc_type)}`;

  // Header + actions.
  const head = el('div', { className: 'card' });
  const top = el('div', { className: 'row', style: 'align-items:center;flex-wrap:wrap;gap:10px' });
  const back = el('a', { href: '#', textContent: '← ' + p.code + ' — ' + (p.name || '') });
  back.onclick = ev => { ev.preventDefault(); PM.prj.open = p.code; showView('projects'); };
  top.append(el('b', { style: 'font-size:15px', textContent: d.doc_no }), wfChip(d.status),
             el('span', { style: 'color:var(--dim)', textContent: t('wf.version', { n: d.version }) }), back);
  head.append(top);
  const info = el('div', { style: 'margin-top:8px;font-size:12.5px;color:var(--dim)' });
  info.append(document.createTextNode(t('wf.madeBy', { who: d.created_email || '—', at: fmtDate((d.created_at || '').slice(0, 10)) })));
  if (d.status === 'in_review' && step) {
    info.append(el('br'), document.createTextNode(t('wf.waiting', { step: step.step, role: wfRoleName(step.role_code) }) + ' '),
                el('b', { id: 'wdWho', textContent: '…' }));
  }
  head.append(info);

  const acts = el('div', { className: 'row', style: 'margin-top:10px;align-items:flex-end;flex-wrap:wrap' });
  const note = el('textarea', { id: 'wdNote', placeholder: t('wf.notePh'), style: 'min-height:38px;width:340px' });
  const btn = (k, cls, fn) => { const b = el('button', { className: 'btn ' + (cls || ''), textContent: t(k) }); b.onclick = fn; acts.append(b); return b; };
  if (edit) {
    btn('wf.save', '', () => wfSave(false));
    btn('wf.submit', 'pri', () => wfSubmit());
  }
  if (wfCanAct(d, step, p.dept_code)) {
    acts.prepend(el('div', { className: 'fld' }, [el('label', { textContent: t('wf.note') }), note]));
    btn('wf.approve', 'pri', () => wfAct('approve'));
    btn('wf.return', '', () => wfAct('return'));
    btn('wf.reject', 'danger', () => wfAct('reject'));
  }
  if (!['approved', 'cancelled'].includes(d.status)
      && (can('project', 'admin') || (d.created_by === (ME && ME.id) && ['draft', 'returned'].includes(d.status))))
    btn('wf.cancel', 'danger', () => wfCancel());
  btn('wf.print', '', () => wfPrint());
  if (d.doc_type === 'AH' && d.status === 'approved') btn('wf.toIntake', '', () => wfToIntake());
  head.append(acts);
  box.append(head);

  // Chain of this submission.
  const chain = el('div', { className: 'card' });
  chain.append(el('h2', { textContent: t('wf.chain') }));
  const planned = WF.steps.length ? WF.steps : wfChain(pmEntity(p.dept_code), d.doc_type).filter(c => c.step > 0)
    .map(c => ({ step: c.step, role_code: c.role_code, status: 'planned' }));
  const ol = el('div', { className: 'wfsteps' });
  const prep = wfChain(pmEntity(p.dept_code), d.doc_type).find(c => c.step === 0);
  ol.append(el('div', { className: 'wfstep done' }, [el('span', { className: 'n', textContent: '0' }),
    el('div', {}, [el('b', { textContent: prep ? wfRoleName(prep.role_code) : '—' }), el('small', { textContent: t('wf.preparer') + ' · ' + (d.created_email || '') })])]));
  for (const s of planned) {
    const cur = d.status === 'in_review' && s.step === d.current_step;
    const cls = s.status === 'approved' ? 'done' : ['returned', 'rejected'].includes(s.status) ? 'bad' : cur ? 'cur' : '';
    const lines = [el('b', { textContent: wfRoleName(s.role_code) })];
    if (s.acted_email) lines.push(el('small', { textContent: `${t('wf.st.' + s.status)} · ${s.acted_email} · ${fmtDate((s.acted_at || '').slice(0, 10))}` }));
    else lines.push(el('small', { textContent: cur ? t('wf.nowHere') : s.status === 'planned' ? t('wf.planned') : t('wf.st.' + s.status) }));
    if (s.comment) lines.push(el('small', { className: 'cm', textContent: '“' + s.comment + '”' }));
    ol.append(el('div', { className: 'wfstep ' + cls }, [el('span', { className: 'n', textContent: String(s.step) }), el('div', {}, lines)]));
  }
  chain.append(ol);
  box.append(chain);

  // The form.
  const form = el('div', { className: 'card' });
  form.append(el('h2', { textContent: t('wf.content') }));
  form.append(wfProjectHeader(p));
  if (d.doc_type === 'QC') form.append(qcEditor(edit));
  else form.append(wfEditor(WF_SPECS[d.doc_type], edit));
  box.append(form);

  // History.
  const hist = el('details', { className: 'card' });
  hist.append(el('summary', { textContent: t('wf.history', { n: WF.events.length }) }));
  const tb = el('table');
  tb.append(el('tr', {}, ['wf.h.at', 'wf.h.who', 'wf.h.action', 'wf.h.step', 'wf.h.note'].map(k => el('th', { textContent: t(k) }))));
  for (const e of WF.events) tb.append(el('tr', {}, [
    el('td', { textContent: new Date(e.at).toLocaleString(pmLoc(), { hour12: false }) }),
    el('td', { textContent: e.actor_email || '' }), el('td', { textContent: t('wf.a.' + e.action) }),
    el('td', { textContent: e.step != null ? String(e.step) : '' }), el('td', { style: 'white-space:normal', textContent: e.comment || '' })]));
  hist.append(el('div', { className: 'wrap' }, tb));
  box.append(hist);
}

function wfProjectHeader(p) {
  const dl = el('dl', { className: 'wfhead' });
  const put = (k, v) => { if (v == null || v === '') return; dl.append(el('dt', { textContent: t(k) }), el('dd', { textContent: String(v) })); };
  put('pm.col.code', p.code); put('pm.col.name', p.name); put('pm.col.dept', p.dept_code);
  put('pm.col.entity', pmEntity(p.dept_code)); put('pm.f.year', p.year);
  put('pm.col.budgeted', p.budgeted ? t('pm.f.budgetedOnly') : t('pm.f.unbudgetedOnly'));
  if (WF.line && WF.line.estimated_value != null) put('wf.budgetLine', fmtNum(Math.round(WF.line.estimated_value)));
  return dl;
}

/* ----------------------------------------------------- generic editor */
// Stored values stay as the dossier template writes them; a few get a label.
const wfOpt = o => { const k = 'wf.o.' + o, s = t(k); return s === k ? o : s; };
function wfInput(f, obj, edit, onChange, ctxRow) {
  const v = f.calc ? f.calc(...ctxRow) : obj[f.k];
  if (!edit || f.ro || f.calc) {
    const shown = v == null || v === '' ? '' : f.t === 'money' ? fmtNum(Math.round(Number(v)))
      : f.t === 'bool' ? (v ? '✔' : '—') : f.t === 'date' ? fmtDate(v) : f.t === 'pct' ? fmtPct(Number(v), 0) : f.t === 'select' ? wfOpt(v) : String(v);
    return el('span', { className: 'wfro' + (f.t === 'money' || f.t === 'num' ? ' num' : ''), textContent: shown });
  }
  let i;
  if (f.t === 'select') {
    i = el('select');
    i.append(el('option', { value: '', textContent: '—' }));
    for (const o of f.opts) i.append(el('option', { value: o, textContent: wfOpt(o) }));
    i.value = v ?? '';
  } else if (f.t === 'bool') {
    i = el('input', { type: 'checkbox', checked: !!v });
  } else if (f.t === 'area') {
    i = el('textarea', { value: v ?? '', style: 'min-height:42px' });
  } else {
    i = el('input', { value: v == null ? '' : f.t === 'money' ? fmtNum(v) : f.t === 'pct' ? String(Math.round(Number(v) * 100)) : v,
                      type: f.t === 'date' ? 'date' : 'text', inputMode: ['money', 'num', 'int15', 'pct'].includes(f.t) ? 'decimal' : 'text' });
    if (f.product) i.setAttribute('list', 'prodList');
  }
  i.onchange = () => {
    let nv = f.t === 'bool' ? i.checked : i.value;
    if (['money', 'num'].includes(f.t)) nv = xlNum(nv);
    if (f.t === 'int15') nv = xlNum(nv) == null ? null : Math.max(1, Math.min(5, Math.round(xlNum(nv))));
    if (f.t === 'pct') nv = xlNum(nv) == null ? null : xlNum(nv) / 100;
    obj[f.k] = nv === '' ? null : nv;
    onChange();
  };
  return i;
}

function wfEditor(spec, edit) {
  const d = WF.data, ctx = wfCtx();
  const wrap = el('div');
  const rerender = () => { WF.dirty = true; d.total = spec.total ? spec.total(d, wfCtx()) : d.total; const n = wfEditor(spec, edit); wrap.replaceWith(n); };
  const grid = (fields) => {
    const g = el('div', { className: 'wfgrid' });
    for (const f of fields) g.append(el('div', { className: 'fld' + (f.wide ? ' wide' : '') }, [
      el('label', { textContent: t('wf.f.' + f.k) }), wfInput(f, d, edit, rerender, [d, ctx])]));
    return g;
  };
  if (spec.head) wrap.append(grid(spec.head));
  if (spec.lines) {
    d.lines = d.lines || [];
    const tb = el('table', { className: 'wflines' });
    const cols = spec.lines.cols;
    tb.append(el('tr', {}, [el('th', { className: 'num idx', textContent: '#' }),
      ...cols.map(c => el('th', { className: ['money', 'num'].includes(c.t) ? 'num' : '', textContent: t('wf.f.' + c.k) })),
      ...(spec.lines.specs ? [el('th', { textContent: t('wf.specs') })] : []), el('th')]));
    d.lines.forEach((l, i) => {
      const tr = el('tr');
      tr.append(el('td', { className: 'num idx', textContent: String(i + 1) }));
      for (const c of cols) {
        const td = el('td', { className: ['money', 'num'].includes(c.t) ? 'num' : '' });
        const inp = wfInput(c, l, edit, rerender, [l, d, ctx]);
        if (inp.style && c.w && inp.tagName !== 'SPAN') inp.style.width = c.w + 'px';
        td.append(inp);
        if (spec.lines.assetLookup && c.k === 'asset_code' && edit) {
          const b = el('button', { className: 'btn tiny', textContent: '↵', title: t('wf.lookup') });
          b.onclick = () => wfAssetLookup(l, rerender);
          td.append(b);
        }
        tr.append(td);
      }
      if (spec.lines.specs) {
        const det = el('details', { className: 'wfspec' });
        det.append(el('summary', { textContent: t('wf.specN', { n: SPEC_FIELDS.filter(k => (l.spec || {})[k]).length }) }));
        const g = el('div', { className: 'wfgrid' });
        l.spec = l.spec || {};
        for (const k of SPEC_FIELDS) {
          const f = { k, t: 'text' };
          g.append(el('div', { className: 'fld' }, [el('label', { textContent: t('spec.' + k) }),
            wfInput(f, l.spec, edit, () => { WF.dirty = true; }, [l.spec])]));
        }
        det.append(g);
        tr.append(el('td', {}, det));
      }
      const x = el('td');
      if (edit) { const del = el('button', { className: 'xbtn', textContent: '×' }); del.onclick = () => { d.lines.splice(i, 1); rerender(); }; x.append(del); }
      tr.append(x);
      tb.append(tr);
    });
    const totCol = cols.findIndex(c => c.k === 'amount' || c.k === 'original_value');
    if (totCol >= 0 && d.lines.length) {
      const tr = el('tr', { className: 'tot' });
      tr.append(el('td', { colSpan: totCol + 1, textContent: t('pm.total', { n: d.lines.length }) }),
        el('td', { className: 'num', textContent: fmtNum(Math.round(wfSum(d.lines, l => { const c = cols[totCol]; return c.calc ? c.calc(l, d, ctx) : l[c.k]; }))) }),
        el('td', { colSpan: cols.length - totCol + (spec.lines.specs ? 1 : 0) }));
      tb.append(tr);
    }
    wrap.append(el('div', { className: 'wrap', style: 'margin-top:10px' }, tb));
    if (edit) { const add = el('button', { className: 'btn', textContent: t('wf.addLine'), style: 'margin-top:6px' }); add.onclick = () => { d.lines.push({}); rerender(); }; wrap.append(add); }
  }
  if (spec.terms) wrap.append(grid(spec.terms));
  wrap.append(wfEvidence(edit, rerender));
  if (spec.total) wrap.append(el('div', { className: 'wftotal', textContent: t('wf.total', { v: fmtNum(Math.round(n0(spec.total(d, wfCtx())))) }) }));
  if (WF.doc.doc_type === 'PA') {
    const g = paGate(d, wfCtx());
    wrap.append(el('div', { className: 'msg ' + (g.ok ? 'ok' : 'warn'), textContent: g.text }));
  }
  return wrap;
}

// OneDrive / SharePoint links, per the decision to keep files out of Supabase for now.
function wfEvidence(edit, rerender) {
  const d = WF.data;
  d.evidence = d.evidence || [];
  const box = el('div', { className: 'wfev' });
  box.append(el('label', { textContent: t('wf.evidence') }));
  if (!d.evidence.length && !edit) box.append(el('div', { style: 'color:var(--dim)', textContent: '—' }));
  d.evidence.forEach((e, i) => {
    const row = el('div', { className: 'row', style: 'align-items:center;margin:3px 0' });
    const url = wfSafeUrl(e.url);
    if (edit) {
      const lab = el('input', { value: e.label || '', placeholder: t('wf.evLabel'), style: 'width:200px' });
      const u = el('input', { value: e.url || '', placeholder: 'https://…sharepoint.com/…', style: 'width:420px', spellcheck: false });
      lab.onchange = () => { e.label = lab.value.trim(); WF.dirty = true; };
      u.onchange = () => { e.url = u.value.trim(); WF.dirty = true; rerender(); };
      const x = el('button', { className: 'xbtn', textContent: '×' }); x.onclick = () => { d.evidence.splice(i, 1); rerender(); };
      row.append(lab, u, x);
      if (e.url && !url) row.append(el('span', { className: 'flag', textContent: '⚠ ' + t('wf.badUrl') }));
    } else if (url) {
      row.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: e.label || url }));
    } else row.append(el('span', { textContent: e.label || e.url || '' }));
    box.append(row);
  });
  if (edit) { const add = el('button', { className: 'btn tiny', textContent: t('wf.addLink') }); add.onclick = () => { d.evidence.push({}); rerender(); }; box.append(add); }
  return box;
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

/* --------------------------------------------------------- QC editor */
function qcEditor(edit) {
  const d = WF.data;
  const wrap = el('div');
  const rerender = () => { WF.dirty = true; const n = qcEditor(edit); wrap.replaceWith(n); };
  const numIn = (obj, k, w = 70) => {
    if (!edit) return el('span', { className: 'wfro num', textContent: obj[k] == null ? '' : String(obj[k]) });
    const i = el('input', { value: obj[k] ?? '', style: `width:${w}px`, inputMode: 'decimal' });
    i.onchange = () => { obj[k] = xlNum(i.value); rerender(); };
    return i;
  };
  const top = el('div', { className: 'wfgrid' });
  const typeSel = { k: 'project_type', t: 'select', opts: ['equipment', 'construction', 'mixed'] };
  top.append(
    el('div', { className: 'fld' }, [el('label', { textContent: t('wf.f.date') }), wfInput({ k: 'date', t: 'date' }, d, edit, rerender, [d])]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('wf.f.project_type') }), wfInput(typeSel, d, edit, () => {
      // A new project type brings its own technical sub-criteria.
      d.sub_technique = qcSubs(QC_TECH[d.project_type] || QC_TECH.equipment); rerender(); }, [d])]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('wf.f.procurement_type') }),
      wfInput({ k: 'procurement_type', t: 'select', opts: ['Direct Appointment', 'Competitive Quotation', 'Public Tender'] }, d, edit, rerender, [d])]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('wf.f.total_vendors') }), numIn(d, 'total_vendors')]));
  wrap.append(top);

  const r = qcScore(d);
  const vs = d.vendors = d.vendors && d.vendors.length ? d.vendors : [{ name: '' }, { name: '' }, { name: '' }];
  const tb = el('table', { className: 'wflines qcm' });
  const head = el('tr', {}, [el('th', { textContent: t('wf.qc.criteria') }), el('th', { className: 'num', textContent: t('wf.qc.weight') })]);
  vs.forEach((v, i) => {
    const th = el('th');
    if (edit) {
      const nm = el('input', { value: v.name || '', placeholder: t('wf.qc.vendorN', { n: i + 1 }), style: 'width:150px' });
      nm.onchange = () => { v.name = nm.value.trim(); rerender(); };
      th.append(nm);
      if (vs.length > 1) { const x = el('button', { className: 'xbtn', textContent: '×' }); x.onclick = () => { vs.splice(i, 1); rerender(); }; th.append(x); }
    } else th.textContent = v.name || '';
    head.append(th);
  });
  if (edit && vs.length < 3) { const add = el('button', { className: 'btn tiny', textContent: '+' }); add.onclick = () => { vs.push({ name: '' }); rerender(); }; head.append(el('th', {}, add)); }
  tb.append(head);
  const group = (key, wKey, subs, scoreKey) => {
    const g = el('tr', { className: 'grp' }, [el('td', { textContent: t('wf.qc.' + key) }), el('td', { className: 'num' }, numIn(d, wKey, 60)),
      ...vs.map(v => el('td', { className: 'num', textContent: v.name && v[key] != null ? String(v[key]) : '' }))]);
    tb.append(g);
    (subs || []).forEach((s, si) => {
      const tr = el('tr');
      const lab = el('td', { className: 'sub' });
      if (edit) { const i = el('input', { value: s.label, style: 'width:200px' }); i.onchange = () => { const old = s.label; s.label = i.value.trim();
        for (const v of vs) if (v[scoreKey] && old in v[scoreKey]) { v[scoreKey][s.label] = v[scoreKey][old]; delete v[scoreKey][old]; } rerender(); }; lab.append(i);
        const x = el('button', { className: 'xbtn', textContent: '×' }); x.onclick = () => { subs.splice(si, 1); rerender(); }; lab.append(x); }
      else lab.textContent = s.label;
      tr.append(lab, el('td', { className: 'num' }, numIn(s, 'w', 60)));
      for (const v of vs) { v[scoreKey] = v[scoreKey] || {}; tr.append(el('td', { className: 'num' }, numIn(v[scoreKey], s.label, 60))); }
      tb.append(tr);
    });
    if (edit) { const add = el('button', { className: 'btn tiny', textContent: t('wf.qc.addSub') }); add.onclick = () => { subs.push({ label: '', w: 0 }); rerender(); };
      tb.append(el('tr', {}, el('td', { colSpan: 2 + vs.length }, add))); }
  };
  d.sub_ability = d.sub_ability || qcSubs(QC_ABILITY);
  d.sub_technique = d.sub_technique || qcSubs(QC_TECH[d.project_type] || QC_TECH.equipment);
  group('ability', 'w_ability', d.sub_ability, 's_ability');
  group('technique', 'w_technique', d.sub_technique, 's_technique');
  // Finance: price (auto-scored) and payment term (scored by hand).
  tb.append(el('tr', { className: 'grp' }, [el('td', { textContent: t('wf.qc.finance') }), el('td', { className: 'num' }, numIn(d, 'w_finance', 60)),
    ...vs.map(v => el('td', { className: 'num', textContent: v.name && v.finance != null ? String(v.finance) : '' }))]));
  const finRow = (label, wKey, cell) => { const tr = el('tr', {}, [el('td', { className: 'sub', textContent: t(label) }), el('td', { className: 'num' }, wKey ? numIn(d, wKey, 60) : '')]);
    for (const v of vs) tr.append(el('td', { className: 'num' }, cell(v))); tb.append(tr); };
  finRow('wf.qc.amount', 'w_price', v => { if (!edit) return el('span', { textContent: v.amount != null ? fmtNum(v.amount) : '' });
    const i = el('input', { value: v.amount != null ? fmtNum(v.amount) : '', style: 'width:130px', inputMode: 'numeric' }); i.onchange = () => { v.amount = xlNum(i.value); rerender(); }; return i; });
  finRow('wf.qc.priceScore', null, v => el('span', { textContent: v.name && v.price_score ? String(v.price_score) : '' }));
  finRow('wf.qc.payTerm', null, v => { if (!edit) return el('span', { textContent: v.pay_term || '' });
    const i = el('input', { value: v.pay_term || '', style: 'width:150px', placeholder: '50% deposit – 50% handover' }); i.onchange = () => { v.pay_term = i.value; WF.dirty = true; }; return i; });
  finRow('wf.qc.payScore', 'w_pay', v => numIn(v, 'pay_score', 60));
  tb.append(el('tr', { className: 'tot' }, [el('td', { textContent: t('wf.qc.totalScore') }), el('td', { className: 'num', textContent: '100' }),
    ...vs.map(v => el('td', { className: 'num', textContent: v.name && v.total != null ? String(v.total) : '' }))]));
  wrap.append(el('div', { className: 'wrap', style: 'margin-top:10px' }, tb));

  const bottom = el('div', { className: 'wfgrid' });
  const chosen = { k: 'chosen_vendor', t: 'select', opts: vs.map(v => v.name).filter(Boolean) };
  bottom.append(el('div', { className: 'fld' }, [el('label', { textContent: t('wf.f.chosen_vendor') }), wfInput(chosen, d, edit, rerender, [d])]),
                el('div', { className: 'fld wide' }, [el('label', { textContent: t('wf.f.comments') }), wfInput({ k: 'comments', t: 'area' }, d, edit, () => { WF.dirty = true; }, [d])]));
  wrap.append(bottom);
  wrap.append(wfEvidence(edit, rerender));
  if (r.problems.length) wrap.append(el('div', { className: 'msg warn', textContent: r.problems.join('\n') }));
  else if (r.best) wrap.append(el('div', { className: 'msg ok', textContent: t('wf.qc.ok', { v: d.chosen_vendor, s: r.best.total }) }));
  const ch = vs.find(v => v.name === d.chosen_vendor);
  d.total = ch ? n0(ch.amount) : null;
  return wrap;
}

/* ------------------------------------------------------------ actions */
function wfCollect() {
  const d = WF.data;
  if (WF.doc.doc_type === 'QC') {
    const r = qcScore(d);
    d.vendors_scored = r.vendors.map(v => ({ name: v.name, amount: v.amount, ability: v.ability, technique: v.technique,
                                             finance: v.finance, total: v.total }));
    // The approval side effect writes these into pm_vendor_score.
    d.vendors = d.vendors.map(v => Object.assign({}, v));
    const ch = d.vendors.find(v => v.name === d.chosen_vendor);
    d.total = ch ? n0(ch.amount) : null;
  } else {
    const spec = WF_SPECS[WF.doc.doc_type];
    const ctx = wfCtx();
    // Freeze computed fields into the saved document, so the printed form and
    // the audit log show the numbers as they were when it was submitted.
    for (const f of [...(spec.head || []), ...(spec.terms || [])]) if (f.calc) d[f.k] = f.calc(d, ctx);
    for (const l of d.lines || []) for (const c of (spec.lines ? spec.lines.cols : [])) if (c.calc) l[c.k] = c.calc(l, d, ctx);
    d.total = spec.total ? spec.total(d, ctx) : null;
    if (WF.doc.doc_type === 'PA') d.gate_ok = paGate(d, ctx).ok;
  }
  return d;
}

async function wfSave(quiet) {
  try {
    await SB.rpc('pm_doc_save', { p_id: WF.doc.id, p_data: wfCollect() });
    WF.dirty = false;
    if (!quiet) { await wfLoad(); msg('#wdMsg', 'ok', t('wf.saved')); }
    return true;
  } catch (e) { msg('#wdMsg', 'err', e.message); return false; }
}

async function wfSubmit() {
  const d = wfCollect();
  if (WF.doc.doc_type === 'QC' && qcScore(d).problems.some(p => p === t('wf.qc.w0') || p === t('wf.qc.w100')))
    return msg('#wdMsg', 'err', t('wf.qc.cannotSubmit'));
  if (WF.doc.doc_type === 'PA' && !d.recommendation) return msg('#wdMsg', 'err', t('wf.pa.needRec'));
  if (!confirm(t('wf.confirmSubmit', { no: WF.doc.doc_no }))) return;
  if (!(await wfSave(true))) return;
  try {
    await SB.rpc('pm_doc_submit', { p_id: WF.doc.id });
    await wfLoad(); wfBadge();
    msg('#wdMsg', 'ok', t('wf.submitted', { no: WF.doc.doc_no }));
  } catch (e) { msg('#wdMsg', 'err', e.message); }
}

async function wfAct(action) {
  const note = ($('#wdNote') || {}).value || '';
  if (action !== 'approve' && !note.trim()) return msg('#wdMsg', 'err', t('wf.needReason'));
  if (!confirm(t('wf.confirm.' + action, { no: WF.doc.doc_no }))) return;
  try {
    const to = await SB.rpc('pm_doc_act', { p_id: WF.doc.id, p_action: action, p_comment: note.trim() || null, p_signature: null });
    await wfLoad(); wfBadge();
    msg('#wdMsg', 'ok', t('wf.acted.' + (to === 'approved' ? 'final' : action), { no: WF.doc.doc_no }));
  } catch (e) { msg('#wdMsg', 'err', e.message); }
}

async function wfCancel() {
  const why = prompt(t('wf.cancelWhy', { no: WF.doc.doc_no }));
  if (why === null) return;
  try { await SB.rpc('pm_doc_cancel', { p_id: WF.doc.id, p_comment: why || null }); await wfLoad(); wfBadge();
        msg('#wdMsg', 'ok', t('wf.cancelled', { no: WF.doc.doc_no })); }
  catch (e) { msg('#wdMsg', 'err', e.message); }
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
      spec: Object.assign({}, l.spec || {})
    });
    if (l.unit) ln.unit_code = l.unit;
    inSetName(ln, l.asset_item || '');
    return ln;
  });
  IN.checked = null; IN.sugRan = false;
  showView('intake');
  $('#inPurpose').value = p.code || '';
  $('#inSupplier').value = d.supplier || p.chosen_vendor || '';
  if (d.handover_date) $('#inDate').value = d.handover_date;
  inRender();
  msg('#inMsg', 'ok', t('wf.intakeReady', { n: IN.lines.length, no: WF.doc.doc_no }));
  inResolveOrigins().then(n => n && inRender()).catch(() => {});
}

/* ------------------------------------------------------------- print
   The official bilingual form: company block, title EN / VI, number and date,
   the general information, the lines (columns can be hidden before printing),
   terms, links, and the approvals with names and dates. */
function wfPrint() {
  const root = $('#wdPrint');
  root.innerHTML = '';
  const d = WF.doc, data = wfCollect(), p = WF.project || {}, tt = WF.types.find(x => x.code === d.doc_type) || {};
  root.append(el('div', { className: 'doc-head' }, [
    el('div', { className: 'left' }, [el('div', { className: 'co', textContent: t('alr.doc.company') }),
                                      el('div', { className: 'addr', textContent: t('alr.doc.addr') })]),
    el('div', { className: 'right' }, [
      el('div', { className: 'ttl' }, [document.createTextNode(tt.name_en || ''), el('br'), document.createTextNode(tt.name_vi || '')]),
      el('div', { className: 'meta' }, [el('div', {}, [el('b', { textContent: 'No. / Số: ' }), d.doc_no]),
        el('div', {}, [el('b', { textContent: 'Date / Ngày: ' }), fmtDate((d.submitted_at || d.created_at || '').slice(0, 10))])])])]));
  const kv = el('table', { className: 'doc wfkv' });
  const addKv = (k, v) => { if (v == null || v === '') return; kv.append(el('tr', {}, [el('th', { textContent: k }), el('td', { textContent: String(v) })])); };
  addKv('Project / Dự án', `${p.code} — ${p.name || ''}`);
  addKv('Department / Bộ phận', p.dept_code);
  addKv('Budget / Ngân sách', p.budgeted ? 'Budgeted' : 'Unbudgeted');
  const spec = WF_SPECS[d.doc_type];
  for (const f of (spec && spec.head) || []) {
    let v = data[f.k];
    if (f.t === 'money' && v != null && v !== '') v = fmtNum(Math.round(Number(v)));
    if (f.t === 'bool') v = v ? '✔' : '—';
    if (f.t === 'date') v = fmtDate(v);
    if (f.t === 'pct' && v != null) v = fmtPct(Number(v), 0);
    addKv(t('wf.f.' + f.k), v);
  }
  root.append(kv);
  if (d.doc_type === 'QC') {
    const r = qcScore(data);
    const tb = el('table', { className: 'doc' });
    tb.append(el('tr', {}, [el('th', { textContent: 'Criteria / Tiêu chí' }), el('th', { textContent: '%' }), ...r.vendors.map(v => el('th', { textContent: v.name }))]));
    for (const [k, w] of [['ability', 'w_ability'], ['technique', 'w_technique'], ['finance', 'w_finance']])
      tb.append(el('tr', {}, [el('td', { textContent: t('wf.qc.' + k) }), el('td', { className: 'r', textContent: String(data[w] ?? '') }),
        ...r.vendors.map(v => el('td', { className: 'r', textContent: String(v[k] ?? '') }))]));
    tb.append(el('tr', {}, [el('td', { textContent: t('wf.qc.amount') }), el('td'), ...r.vendors.map(v => el('td', { className: 'r', textContent: v.amount != null ? fmtNum(v.amount) : '' }))]));
    tb.append(el('tr', {}, [el('td', {}, el('b', { textContent: t('wf.qc.totalScore') })), el('td', { className: 'r', textContent: '100' }),
      ...r.vendors.map(v => el('td', { className: 'r' }, el('b', { textContent: String(v.total ?? '') })))]));
    root.append(tb);
    addKv(t('wf.f.chosen_vendor'), data.chosen_vendor);
  } else if (spec && spec.lines && (data.lines || []).length) {
    const cols = spec.lines.cols.filter(c => !(WF.hideCols || new Set()).has(c.k));
    const tb = el('table', { className: 'doc' });
    tb.append(el('tr', {}, [el('th', { textContent: 'No.', style: 'width:34px' }), ...cols.map(c => el('th', { textContent: t('wf.f.' + c.k) }))]));
    data.lines.forEach((l, i) => tb.append(el('tr', {}, [el('td', { className: 'c', textContent: String(i + 1) }),
      ...cols.map(c => { let v = l[c.k]; if (c.t === 'money' && v != null && v !== '') v = fmtNum(Math.round(Number(v))); if (c.t === 'date') v = fmtDate(v); if (c.t === 'bool') v = v ? '✔' : ''; if (c.k === 'asset_item' && spec.lines.specs) {
        const sp = SPEC_FIELDS.filter(k => (l.spec || {})[k]).map(k => (l.spec || {})[k]).join(' · '); if (sp) v = `${v || ''}\n${sp}`; }
        return el('td', { className: ['money', 'num'].includes(c.t) ? 'r' : '', style: 'white-space:pre-wrap', textContent: v == null ? '' : String(v) }); })])));
    root.append(tb);
  }
  const terms = el('table', { className: 'doc wfkv' });
  for (const f of (spec && spec.terms) || []) {
    let v = data[f.k]; if (v == null || v === '') continue;
    if (f.t === 'money') v = fmtNum(Math.round(Number(v))); if (f.t === 'date') v = fmtDate(v);
    terms.append(el('tr', {}, [el('th', { textContent: t('wf.f.' + f.k) }), el('td', { style: 'white-space:pre-wrap', textContent: String(v) })]));
  }
  if (terms.children.length) root.append(terms);
  if (data.total != null) root.append(el('div', { className: 'doc-notes', textContent: `Total / Tổng: ${fmtNum(Math.round(n0(data.total)))} VND` }));
  const links = (data.evidence || []).filter(e => wfSafeUrl(e.url));
  if (links.length) root.append(el('div', { className: 'doc-notes' }, [el('b', { textContent: 'Attachments / Tài liệu đính kèm:' }),
    ...links.map(e => el('div', { textContent: `• ${e.label || ''} ${e.url}` }))]));
  // Approvals: preparer, then every step with who and when.
  const sign = el('div', { className: 'doc-sign wfsign' });
  const prep = wfChain(pmEntity(p.dept_code), d.doc_type).find(c => c.step === 0);
  sign.append(el('div', {}, [el('b', { textContent: `Prepared by / Người lập` }), el('small', { textContent: prep ? wfRoleName(prep.role_code) : '' }),
    el('i', {}), document.createTextNode(d.created_email || '')]));
  for (const s of WF.steps) sign.append(el('div', {}, [el('b', { textContent: wfRoleName(s.role_code) }),
    el('small', { textContent: s.acted_at ? `${t('wf.st.' + s.status)} · ${fmtDate(s.acted_at.slice(0, 10))}` : '' }),
    el('i', {}), document.createTextNode(s.acted_email || '')]));
  root.append(sign);
  document.getElementById('am-page-rule')?.remove();
  const st = el('style', { id: 'am-page-rule' });
  st.textContent = '@page{size:A4 portrait;margin:12mm}';
  document.head.append(st);
  window.print();
}

/* ------------------------------------------------------------- inbox */
async function wfInboxLoad() {
  const out = $('#wiMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await wfLookups();
    WF.inbox = await SB.rpc('pm_inbox');
    msg(out, WF.inbox.length ? '' : 'ok', WF.inbox.length ? '' : t('wf.inboxEmpty'));
    const head = $('#wiGrid thead'), body = $('#wiGrid tbody');
    head.innerHTML = ''; body.innerHTML = '';
    head.append(el('tr', {}, [['wf.i.kind'], ['wf.i.doc'], ['wf.i.type'], ['pm.col.code'], ['pm.col.name'], ['pm.col.dept'],
      ['wf.i.value', 'num'], ['wf.i.sent'], ['wf.i.step']].map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
    for (const r of WF.inbox) {
      const tr = el('tr', { style: 'cursor:pointer' }, [
        el('td', {}, el('span', { className: 'st ' + (r.kind === 'approve' ? 'in_progress' : 'cancelled'), textContent: t('wf.i.' + r.kind) })),
        el('td', {}, el('code', { textContent: r.doc_no })), el('td', { textContent: wfTypeName(r.doc_type) }),
        el('td', {}, el('code', { textContent: r.project_code })), el('td', { textContent: r.project_name || '' }),
        el('td', { textContent: r.dept_code }), el('td', { className: 'num', textContent: r.total_value != null ? fmtNum(Math.round(r.total_value)) : '' }),
        el('td', { textContent: r.submitted_at ? fmtDate(r.submitted_at.slice(0, 10)) : '' }),
        el('td', { textContent: r.role_code ? `${r.step} · ${wfRoleName(r.role_code)}` : '' })]);
      tr.onclick = () => wfOpen(r.doc_id);
      body.append(tr);
    }
    wfBadge(WF.inbox.length);
  } catch (e) { msg(out, 'err', e.message); }
}

/* The number beside "Waiting for me" in the menu. */
async function wfBadge(n) {
  if (n == null) { try { n = (await SB.rpc('pm_inbox')).length; } catch { return; } }
  WF.badgeN = n;                       // buildNav() redraws the menu and re-adds it from here
  const a = $('#nav a[data-view="inbox"]');
  if (!a) return;
  a.querySelector('.tag')?.remove();
  if (n > 0) a.append(el('span', { className: 'tag', textContent: String(n) }));
}
let WF_TIMER = null;
function wfBadgeStart() {
  clearInterval(WF_TIMER);
  if (!can('approval', 'view')) return;
  wfBadge();
  WF_TIMER = setInterval(() => { if (ME && document.visibilityState === 'visible') wfBadge(); }, 120000);
}

/* ------------------------------------------------------ chain editor */
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
  const admin = can('approval', 'admin');
  const head = $('#wcGrid thead'), body = $('#wcGrid tbody');
  head.innerHTML = ''; body.innerHTML = '';
  head.append(el('tr', {}, [el('th', { textContent: t('wf.c.doc') }), el('th', { textContent: t('wf.c.prep') }), el('th', { textContent: t('wf.c.steps') }), el('th')]));
  const roleSel = (val) => { const s = el('select'); s.append(el('option', { value: '', textContent: '—' }));
    for (const r of WF.roles) s.append(el('option', { value: r.code, textContent: LANG === 'vi' ? r.name_vi : r.name_en })); s.value = val || ''; return s; };
  for (const type of WF_ORDER) {
    const rows = wfChain(WF.entity, type);
    const prep = rows.find(c => c.step === 0);
    const steps = rows.filter(c => c.step > 0).map(c => c.role_code);
    const tr = el('tr');
    tr.append(el('td', {}, [el('b', { textContent: type }), document.createTextNode(' ' + wfTypeName(type))]));
    const prepCell = el('td');
    let prepSel = null;
    if (admin) { prepSel = roleSel(prep && prep.role_code); prepCell.append(prepSel); } else prepCell.textContent = prep ? wfRoleName(prep.role_code) : '—';
    tr.append(prepCell);
    const chips = el('div', { className: 'roles' });
    const draw = () => {
      chips.innerHTML = '';
      steps.forEach((r, i) => {
        const c = el('span', { className: 'role' }, [el('b', { textContent: `${i + 1}. ` }), document.createTextNode(wfRoleName(r))]);
        if (admin) {
          if (i > 0) { const l = el('button', { className: 'x', textContent: '←' }); l.onclick = () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; draw(); }; c.append(l); }
          const x = el('button', { className: 'x', textContent: '×' }); x.onclick = () => { steps.splice(i, 1); draw(); }; c.append(x);
        }
        chips.append(c);
      });
      if (admin) { const add = roleSel(''); add.onchange = () => { if (add.value) { steps.push(add.value); draw(); } }; chips.append(add); }
    };
    draw();
    tr.append(el('td', {}, chips));
    const act = el('td');
    if (admin) { const save = el('button', { className: 'btn tiny pri', textContent: t('tool.save') });
      save.onclick = () => wfChainSave(type, prepSel.value, steps); act.append(save); }
    tr.append(act);
    body.append(tr);
  }
}

/* Upsert the new steps first, then drop the ones past the end — a failure in
   between leaves a chain with extra steps, never a chain with none. */
async function wfChainSave(type, prep, steps) {
  if (!prep) return msg('#wcMsg', 'err', t('wf.c.needPrep'));
  if (!steps.length) return msg('#wcMsg', 'err', t('wf.c.needStep'));
  const rows = [{ entity: WF.entity, doc_type: type, step: 0, role_code: prep },
                ...steps.map((r, i) => ({ entity: WF.entity, doc_type: type, step: i + 1, role_code: r }))];
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
}
