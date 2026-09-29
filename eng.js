/* ============================================================ BUILDING SYSTEMS & SHIFT CHECKLISTS
   (37_eng_checklist.sql) — user 27/09/2026: the Engineering team's daily
   checklists move into the app (Beetrack is not in use); the "system" layer is
   Engineering's own list ST01–ST20; the condition-assessment pilot is ST04
   Chiller.

   Two screens:
     engchk   SHIFT CHECKLIST (tablet): date + shift (Morning / Afternoon /
              Night, the night shift belongs to the day it starts), the 16
              checklists as cards, then one checklist as big buttons (Auto /
              On / Off …) and number boxes with the allowed range. Every tap
              is saved; a reading outside the range turns red and can raise an
              incident on the asset (am_incident — the shared maintenance
              history). The last shift's reading is shown beside each point.
     eng      BUILDING SYSTEMS: systems → items (asset, age, criticality,
              latest condition score, abnormal readings / incidents in 90
              days); condition & investment plan (score 1–5, action, year,
              cost, reason → Excel for the Capex budget); the logbook (points ×
              shifts, compliance); checklist set-up (normal states, min/max);
              import of Engineering's two workbooks.

   Loaded after app.js and assetops.js; uses their helpers (el, msg, t, can, SB,
   hnorm, fmtInt, fmtDate, aoTabs, aoFld, aoAsset, XLSX). */

const EN = { tab: 'systems', sys: [], items: [], chk: [], points: [], cond: [], assets: new Map(), stats: new Map(),
             loaded: false, cfg: { shifts: { S: ['06:00', '14:00'], C: ['14:00', '22:00'], D: ['22:00', '06:00'] }, pilot: ['ST04'], life: 20 },
             date: null, shift: null, runs: [], run: null, vals: new Map(), prev: new Map(), sysSel: null, condSys: null,
             logChk: null, logFrom: null, logTo: null, cfgChk: null, parsed: null, flash: null };
const EN_SHIFTS = ['S', 'C', 'D'];
const EN_ACTIONS = ['none', 'monitor', 'repair', 'overhaul', 'replace'];
const enW = () => can('eng', 'create');
const enEd = () => can('eng', 'edit');
const enAdm = () => can('eng', 'admin');
const enMissing = e => /am_sys|am_chk|am_cond|am_eng|PGRST20[25]|does not exist|404/.test(String(e && e.message));
const enErr = (out, e) => msg(out, 'err', enMissing(e) ? t('en.notInstalled') : e.message);
const enSys = code => EN.sys.find(s => s.code === code);
const enItem = id => EN.items.find(i => i.id === id);
const enChk = code => EN.chk.find(c => c.code === code);
const enIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const enSysName = s => (s ? (LANG === 'vi' && s.name_vi ? s.name_vi : s.name_en) : '');
const enNum = v => (v == null || v === '' ? '' : Number(v).toLocaleString(LANG === 'vi' ? 'vi-VN' : 'en-US', { maximumFractionDigits: 2 }));
const enMoney = v => (v == null || v === '' ? '' : fmtInt(Math.round(Number(v))));

/* The shift now and the day it belongs to: the night shift that started
   yesterday at 22:00 is still yesterday's until 06:00. */
function enNowShift() {
  const now = new Date(), hm = now.getHours() * 60 + now.getMinutes();
  const mins = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  for (const k of EN_SHIFTS) {
    const [a, b] = EN.cfg.shifts[k] || [];
    if (a == null) continue;
    const A = mins(a), B = mins(b);
    if (A < B ? hm >= A && hm < B : hm >= A || hm < B) {
      const d = new Date(now);
      if (A > B && hm < B) d.setDate(d.getDate() - 1);   // after midnight in a shift that began the evening before
      return { date: enIso(d), shift: k };
    }
  }
  return { date: enIso(now), shift: 'S' };
}

async function enBase(force) {
  if (EN.loaded && !force) return;
  const [sys, items, chk, points, cond, sets] = await Promise.all([
    SB.select('am_sys', 'select=*&order=sort,code'),
    SB.select('am_sys_item', 'select=*&order=sys_code,sort,code&limit=5000'),
    SB.select('am_chk', 'select=*&order=sort,code'),
    SB.select('am_chk_point', 'select=*&order=chk_code,seq,id&limit=5000'),
    SB.select('am_cond', 'select=*&order=assessed_on.desc,id.desc&limit=20000'),
    SB.select('am_setting', 'select=key,value&key=in.(eng_shifts,eng_pilot,eng_default_life)').catch(() => [])]);
  Object.assign(EN, { sys, items, chk, points, cond, loaded: true });
  for (const r of sets) {
    if (r.key === 'eng_shifts' && r.value && typeof r.value === 'object') EN.cfg.shifts = r.value;
    if (r.key === 'eng_pilot' && Array.isArray(r.value)) EN.cfg.pilot = r.value;
    if (r.key === 'eng_default_life' && Number(r.value)) EN.cfg.life = Number(r.value);
  }
  const ids = [...new Set([...sys.map(s => s.asset_id), ...items.map(i => i.asset_id)].filter(Boolean))];
  EN.assets = new Map();
  for (let k = 0; k < ids.length; k += 150) {
    const rows = await SB.select('am_asset', `select=id,asset_code,name_vi,name_en,purchase_year,in_use_date,status_code&id=in.(${ids.slice(k, k + 150).join(',')})`).catch(() => []);
    for (const a of rows) EN.assets.set(a.id, a);
  }
}
async function enStats() {
  const to = new Date(), from = new Date(); from.setDate(from.getDate() - 90);
  const rows = await SB.rpc('am_eng_stats', { p_from: enIso(from), p_to: enIso(to) }).catch(() => []);
  EN.stats = new Map((rows || []).map(r => [r.item_id, r]));
}
const enLatest = id => EN.cond.find(c => c.item_id === id) || null;
function enAge(i) {
  const a = EN.assets.get(i.asset_id) || EN.assets.get((enSys(i.sys_code) || {}).asset_id);
  const y = i.install_year || (a && a.purchase_year) || null;
  return y ? new Date().getFullYear() - y : null;
}
/* A starting point for the assessor, never the answer: age against design life,
   then abnormal readings and incidents in the last 90 days. */
function enSuggest(i) {
  const age = enAge(i), life = i.life_years || EN.cfg.life;
  if (age == null) return null;
  let s = 5 - 4 * Math.min(1, age / life);
  const st = EN.stats.get(i.id) || {};
  if ((st.abn || 0) >= 5) s -= 1;
  if ((st.incidents || 0) >= 2) s -= 1;
  return Math.max(1, Math.min(5, Math.round(s)));
}
const enScoreChip = s => el('span', { className: 'enscore s' + (s || 0), textContent: s ? String(s) : '–', title: s ? t('en.score.' + s) : t('en.cond.none') });

function enDrawerEl() {
  let dr = $('#enDrawer');
  if (dr) return dr;
  dr = el('div', { id: 'enDrawer', className: 'drawer', role: 'dialog', hidden: true }, [
    el('div', { className: 'dhead' }, [el('h2', { id: 'enDrTitle' }), el('button', { className: 'dbtn', type: 'button', textContent: '✕', onclick: enDrawerClose })]),
    el('div', { id: 'enDrBody', className: 'dbody' })]);
  document.body.append(dr);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dr.hidden) enDrawerClose(); });
  return dr;
}
function enDrawerClose() { const d = $('#enDrawer'); if (d) { d.hidden = true; $('#enDrBody').innerHTML = ''; } }

// An open checklist stays open when the screen is redrawn (language switch, coming back to it).
function enShow(view) { return view === 'engchk' ? ecLoad(!!(EN.run && EN.run.chk_code)) : enLoad(); }
window.enShow = enShow;

/* ================================================================ SHIFT CHECKLIST */
async function ecLoad(keepRun) {
  const out = $('#ecMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await enBase();
    if (!EN.date) Object.assign(EN, enNowShift());
    EN.runs = await SB.select('am_chk_run', `select=*&run_date=eq.${EN.date}&shift=eq.${EN.shift}`);
    msg(out, EN.flash ? 'ok' : '', EN.flash || ''); EN.flash = null;
    const pend = EN.pendingRun;
    EN.pendingRun = null;
    if (pend) return ecRunOpen(pend, true);
    if (keepRun && EN.run) return ecRunOpen(EN.run.chk_code, true);
    EN.run = null;
    ecRender();
  } catch (e) { $('#ecBody').innerHTML = ''; enErr(out, e); }
}

function ecHead() {
  const now = enNowShift();
  const d = el('input', { type: 'date', value: EN.date, max: enIso(new Date()) });
  d.onchange = () => { if (d.value) { EN.date = d.value; ecLoad(); } };
  const seg = el('div', { className: 'seg enshifts' }, EN_SHIFTS.map(k => {
    const [a, b] = EN.cfg.shifts[k] || ['', ''];
    const btn = el('button', { type: 'button', className: EN.shift === k ? 'on' : '', innerHTML: `<b>${t('en.shift.' + k)}</b><small>${a}–${b}</small>` });
    btn.onclick = () => { EN.shift = k; ecLoad(); };
    return btn;
  }));
  const back = el('button', { type: 'button', className: 'btn', textContent: t('en.now'), disabled: now.date === EN.date && now.shift === EN.shift });
  back.onclick = () => { Object.assign(EN, enNowShift()); ecLoad(); };
  return el('div', { className: 'card enhead' }, [aoFld(t('en.date'), d), seg, back]);
}

function ecRender() {
  const body = $('#ecBody');
  body.innerHTML = '';
  body.append(ecHead());
  const list = EN.chk.filter(c => c.active && (c.shifts || []).includes(EN.shift));
  if (!list.length) return body.append(el('div', { className: 'msg info', textContent: EN.chk.length ? t('en.chk.noneShift') : t('en.chk.none') }));
  const done = list.filter(c => (EN.runs.find(r => r.chk_code === c.code) || {}).status === 'done').length;
  const abn = EN.runs.reduce((s, r) => s + (r.abn || 0), 0);
  body.append(el('div', { className: 'aokpis' }, [
    el('div', { className: 'aokpi' }, [el('small', { textContent: t('en.k.done') }), el('b', { textContent: `${done} / ${list.length}` })]),
    el('div', { className: 'aokpi' + (abn ? ' warn' : '') }, [el('small', { textContent: t('en.k.abn') }), el('b', { textContent: fmtInt(abn) })])]));
  const grid = el('div', { className: 'encards' });
  for (const c of list) {
    const r = EN.runs.find(x => x.chk_code === c.code);
    const pts = EN.points.filter(p => p.chk_code === c.code && p.active).length;
    const st = !r ? 'todo' : r.status === 'done' ? 'done' : 'open';
    const card = el('button', { type: 'button', className: 'encard st-' + st + (r && r.abn ? ' abn' : '') }, [
      el('small', { textContent: c.code + (c.sys_code ? ' · ' + c.sys_code : '') }),
      el('b', { textContent: c.name }),
      el('span', { className: 'enbar' }, el('i', { style: `width:${pts ? Math.round(100 * ((r && r.filled) || 0) / pts) : 0}%` })),
      el('span', { className: 'dim', textContent: t('en.card.' + st, { n: (r && r.filled) || 0, of: pts }) + (r && r.abn ? ' · ⚠ ' + t('en.abnN', { n: r.abn }) : '') })]);
    card.onclick = () => ecRunOpen(c.code);
    grid.append(card);
  }
  body.append(grid);
}

async function ecRunOpen(code, keep) {
  const out = $('#ecMsg');
  const c = enChk(code);
  try {
    let r = EN.runs.find(x => x.chk_code === code);
    if (!r && enW()) {
      const id = await SB.rpc('am_chk_start', { p_chk: code, p_date: EN.date, p_shift: EN.shift });
      [r] = await SB.select('am_chk_run', `select=*&id=eq.${id}`);
      EN.runs.push(r);
    }
    EN.run = r || { chk_code: code, run_date: EN.date, shift: EN.shift, status: 'none', filled: 0, abn: 0 };
    EN.vals = new Map();
    if (r) for (const v of await SB.select('am_chk_val', `select=*&run_id=eq.${r.id}`)) EN.vals.set(v.point_id, v);
    // The previous shift that has readings, for comparison.
    EN.prev = new Map();
    const prevRuns = await SB.select('am_chk_run', `select=id,run_date,shift&chk_code=eq.${encodeURIComponent(code)}&filled=gt.0&run_date=lte.${EN.date}&order=run_date.desc&limit=8`);
    // Shift order is Morning → Afternoon → Night, not alphabetical: sort here.
    const order = s => EN_SHIFTS.indexOf(s);
    prevRuns.sort((a, b) => (a.run_date === b.run_date ? order(b.shift) - order(a.shift) : a.run_date < b.run_date ? 1 : -1));
    const p = prevRuns.find(x => x.run_date < EN.date || order(x.shift) < order(EN.shift));
    if (p) { EN.prevRun = p; for (const v of await SB.select('am_chk_val', `select=point_id,state,num1,num2,ok&run_id=eq.${p.id}`)) EN.prev.set(v.point_id, v); }
    else EN.prevRun = null;
    if (!keep) msg(out, '', '');
    ecRunRender(c);
  } catch (e) { enErr(out, e); }
}

function ecRunRender(c) {
  const body = $('#ecBody'), r = EN.run;
  body.innerHTML = '';
  const pts = EN.points.filter(p => p.chk_code === c.code && p.active);
  const canWrite = enW() && r.id && (r.status !== 'done' || enEd());
  const prog = el('span', { className: 'enbar big' }, el('i'));
  const info = el('span', { className: 'dim' });
  const sync = () => {
    const filled = pts.filter(p => { const v = EN.vals.get(p.id); return v && v.ok != null; }).length;
    const abn = pts.filter(p => (EN.vals.get(p.id) || {}).ok === false).length;
    prog.firstChild.style.width = (pts.length ? Math.round(100 * filled / pts.length) : 0) + '%';
    info.textContent = t('en.card.open', { n: filled, of: pts.length }) + (abn ? ' · ⚠ ' + t('en.abnN', { n: abn }) : '');
    Object.assign(r, { filled, abn });
  };
  const back = el('button', { type: 'button', className: 'btn', textContent: '← ' + t('en.back'), onclick: () => { EN.run = null; ecLoad(); } });
  const done = el('button', { type: 'button', className: 'btn pri', textContent: r.status === 'done' ? t('en.doneAgain') : t('en.done'), disabled: !canWrite });
  done.onclick = async () => {
    const miss = pts.length - pts.filter(p => (EN.vals.get(p.id) || {}).ok != null).length;
    if (miss && !confirm(t('en.done.miss', { n: miss }))) return;
    try {
      const res = await SB.rpc('am_chk_done', { p_run: r.id, p_note: null });
      EN.flash = res && res.abn ? t('en.done.abn', { code: c.code, n: res.abn }) : t('en.done.ok', { code: c.code });
      EN.run = null; ecLoad();
    } catch (e) { enErr($('#ecMsg'), e); }
  };
  const status = r.status === 'done' ? el('span', { className: 'aost done', textContent: t('en.st.done') + (r.done_name ? ' · ' + r.done_name : '') })
    : r.status === 'open' ? el('span', { className: 'aost open', textContent: t('en.st.open') }) : el('span', { className: 'aost', textContent: t('en.st.none') });
  body.append(el('div', { className: 'card enrunhead' }, [back,
    el('div', { className: 'grow' }, [el('b', { textContent: `${c.code} · ${c.name}` }),
      el('div', { className: 'dim', textContent: `${fmtDate(EN.date)} · ${t('en.shift.' + EN.shift)}` + (EN.prevRun ? ' · ' + t('en.prevFrom', { d: fmtDate(EN.prevRun.run_date), s: t('en.shift.' + EN.prevRun.shift) }) : '') })]),
    status, el('div', { className: 'enprog' }, [prog, info]), done]));
  if (!enW()) body.append(el('div', { className: 'msg info', textContent: t('en.readOnly') }));
  else if (r.status === 'done' && !enEd()) body.append(el('div', { className: 'msg info', textContent: t('en.doneLocked') }));
  let group = null, box = null;
  for (const p of pts) {
    const g = [p.floor, p.location_code].filter(Boolean).join(' · ') || '—';
    if (g !== group) { group = g; box = el('div', { className: 'card enpts' }, el('h3', { textContent: g })); body.append(box); }
    box.append(ecPoint(p, canWrite, sync));
  }
  sync();
}

function ecPoint(p, canWrite, sync) {
  const v = () => EN.vals.get(p.id) || {};
  const row = el('div', { className: 'enpt' });
  const mark = el('span', { className: 'enmark' });
  const item = p.item_id ? enItem(p.item_id) : null;
  const pv = EN.prev.get(p.id);
  const pvTxt = pv ? [pv.state, pv.num1 != null ? enNum(pv.num1) : null, pv.num2 != null ? enNum(pv.num2) : null].filter(x => x != null && x !== '').join(' / ') : '';
  const range = p.min_ok != null || p.max_ok != null ? `${p.min_ok != null ? enNum(p.min_ok) : '…'}–${p.max_ok != null ? enNum(p.max_ok) : '…'}` : '';
  const name = el('div', { className: 'enname' }, [el('b', { textContent: p.task }),
    el('small', { className: 'dim', textContent: [item ? item.code : '', p.unit ? p.unit + (range ? ' ' + range : '') : range, pvTxt ? t('en.prev') + ': ' + pvTxt : ''].filter(Boolean).join(' · ') })]);
  const ctl = el('div', { className: 'enctl' });
  const nums = [];
  let state = v().state || null;
  const save = async () => {
    const n1 = nums[0] ? (nums[0].value.trim() === '' ? null : Number(nums[0].value.replace(',', '.'))) : null;
    const n2 = nums[1] ? (nums[1].value.trim() === '' ? null : Number(nums[1].value.replace(',', '.'))) : null;
    if ([n1, n2].some(n => n != null && isNaN(n))) return msg($('#ecMsg'), 'err', t('en.badNum'));
    try {
      const ok = await SB.rpc('am_chk_set', { p_run: EN.run.id, p_point: p.id, p_state: state, p_num1: n1, p_num2: n2, p_note: v().note || null });
      if (ok == null && !v().note && !v().incident_id) EN.vals.delete(p.id);
      else EN.vals.set(p.id, Object.assign({}, v(), { state, num1: n1, num2: n2, ok }));
      paint(); sync();
    } catch (e) { enErr($('#ecMsg'), e); }
  };
  if (p.options && p.options.length) {
    const seg = el('div', { className: 'seg enstate' });
    for (const o of p.options) {
      const b = el('button', { type: 'button', textContent: o, disabled: !canWrite });
      b.dataset.o = o;
      b.onclick = () => { state = state === o ? null : o; save(); };
      seg.append(b);
    }
    ctl.append(seg);
  }
  for (const [k, lab] of (p.num_labels || []).entries()) {
    const val = k === 0 ? v().num1 : v().num2;
    const i = el('input', { type: 'text', inputMode: 'decimal', value: val == null ? '' : String(val), disabled: !canWrite, placeholder: lab, title: lab });
    i.onchange = save;
    nums.push(i);
    ctl.append(el('label', { className: 'ennum' }, [el('small', { textContent: lab }), i]));
  }
  const note = el('button', { type: 'button', className: 'btn sm', textContent: '✎', title: t('en.note'), disabled: !canWrite });
  note.onclick = async () => {
    const s = prompt(t('en.note'), v().note || '');
    if (s == null) return;
    EN.vals.set(p.id, Object.assign({}, v(), { note: s.trim() || null }));
    await save();
  };
  const inc = el('button', { type: 'button', className: 'btn sm danger', textContent: '🔧', title: t('en.inc') });
  inc.onclick = async () => {
    const s = prompt(t('en.inc.ask', { task: p.task }), v().note || '');
    if (s == null) return;
    try {
      const id = await SB.rpc('am_chk_incident', { p_run: EN.run.id, p_point: p.id, p_desc: s });
      EN.vals.set(p.id, Object.assign({}, v(), { incident_id: id }));
      paint();
      msg($('#ecMsg'), 'ok', t('en.inc.done'));
    } catch (e) { enErr($('#ecMsg'), e); }
  };
  const incTag = el('span', { className: 'aost open' });
  const paint = () => {
    const cur = v();
    row.classList.toggle('bad', cur.ok === false);
    row.classList.toggle('ok', cur.ok === true);
    mark.textContent = cur.ok === false ? '⚠' : cur.ok === true ? '✓' : '';
    ctl.querySelectorAll('.enstate button').forEach(b => {
      b.classList.toggle('on', b.dataset.o === cur.state);
      b.classList.toggle('abnopt', !(p.ok_states || []).includes(b.dataset.o));
    });
    for (const i of nums) {
      const n = i.value.trim() === '' ? null : Number(i.value.replace(',', '.'));
      i.classList.toggle('bad', n != null && ((p.min_ok != null && n < p.min_ok) || (p.max_ok != null && n > p.max_ok)));
    }
    note.classList.toggle('on', !!cur.note);
    note.title = cur.note || t('en.note');
    inc.hidden = !(canWrite && cur.ok === false && !cur.incident_id);
    incTag.hidden = !cur.incident_id;
    incTag.textContent = t('en.inc.linked');
  };
  row.append(mark, name, ctl, el('div', { className: 'enacts' }, [note, inc, incTag]));
  paint();
  return row;
}

// Opening a checklist from the bell: doc_no = DCL0002/2026-09-27/S.
function enOpenRun(no) {
  const [code, date, shift] = String(no || '').split('/');
  if (!code || !date) return showView('engchk');
  Object.assign(EN, { date, shift: shift || 'S', run: { chk_code: code } });
  if (VIEW === 'engchk') return ecLoad(true);
  EN.pendingRun = code;
  showView('engchk');
}
window.enOpenRun = enOpenRun;

/* ================================================================ BUILDING SYSTEMS */
async function enLoad() {
  const out = $('#enMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await enBase(true);
    await enStats();
    msg(out, EN.flash ? 'ok' : '', EN.flash || ''); EN.flash = null;
    enRender();
  } catch (e) { $('#enBody').innerHTML = ''; enErr(out, e); }
}
async function enReload(flash) { EN.flash = flash || null; await enLoad(); }

function enRender() {
  const list = [['systems', t('en.t.systems'), EN.sys.length], ['cond', t('en.t.cond')], ['log', t('en.t.log')]];
  if (enAdm()) list.push(['config', t('en.t.config')], ['import', t('en.t.import')]);
  if (!list.some(x => x[0] === EN.tab)) EN.tab = 'systems';
  if (!EN.sys.length && enAdm()) EN.tab = 'import';   // nothing yet: start with the import
  aoTabs($('#enTabs'), list, EN.tab, v => { EN.tab = v; enRender(); });
  const body = $('#enBody');
  body.innerHTML = '';
  if (!EN.sys.length) {
    body.append(el('div', { className: 'msg info', textContent: enAdm() ? t('en.empty.adm') : t('en.empty') }));
    if (!enAdm()) return;
  }
  if (EN.tab === 'systems') return enSystems(body);
  if (EN.tab === 'cond') return enCondTab(body);
  if (EN.tab === 'log') return enLogTab(body);
  if (EN.tab === 'config') return enConfigTab(body);
  // The workbooks are uploaded in Data sources (user 29/09/2026); the tab points there.
  if (EN.tab === 'import') return canView('sources') && window.dsLinkCard ? body.append(dsLinkCard('eng', t('en.t.import'))) : enImportTab(body);
}

/* ------------------------------------------------------------- systems */
function enSysSummary(s) {
  const items = EN.items.filter(i => i.sys_code === s.code && i.active);
  const scores = items.map(i => (enLatest(i.id) || {}).score).filter(Boolean);
  const abn = items.reduce((n, i) => n + ((EN.stats.get(i.id) || {}).abn || 0), 0);
  const low = scores.filter(x => x <= 2).length;
  return { items, n: items.length, assessed: scores.length, avg: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null, abn, low };
}

function enSystems(body) {
  if (!EN.sysSel || !enSys(EN.sysSel)) EN.sysSel = (EN.sys.find(s => EN.cfg.pilot.includes(s.code)) || EN.sys[0] || {}).code;
  const wrap = el('div', { className: 'ensplit' });
  const side = el('div', { className: 'card enside' });
  for (const s of EN.sys) {
    const m = enSysSummary(s);
    const b = el('button', { type: 'button', className: 'ensys' + (s.code === EN.sysSel ? ' on' : '') + (s.active ? '' : ' off') }, [
      el('span', { className: 'code', textContent: s.code }), el('span', { className: 'grow', textContent: enSysName(s) }),
      m.low ? el('span', { className: 'enscore s1', textContent: String(m.low), title: t('en.lowN', { n: m.low }) }) : '',
      m.abn ? el('span', { className: 'aost open', textContent: '⚠ ' + m.abn, title: t('en.abn90') }) : '',
      EN.cfg.pilot.includes(s.code) ? el('span', { className: 'aost pending', textContent: t('en.pilot') }) : '']);
    b.onclick = () => { EN.sysSel = s.code; enRender(); };
    side.append(b);
  }
  wrap.append(side);
  const main = el('div', { className: 'grow' });
  const s = enSys(EN.sysSel);
  if (s) main.append(enSysCard(s));
  wrap.append(main);
  body.append(wrap);
}

function enSysCard(s) {
  const m = enSysSummary(s);
  const a = EN.assets.get(s.asset_id);
  const card = el('div', { className: 'card' });
  const head = el('div', { className: 'row', style: 'align-items:flex-start;flex-wrap:wrap;gap:12px' }, [
    el('div', { className: 'grow' }, [el('h2', { style: 'margin:0', textContent: `${s.code} · ${enSysName(s)}` }),
      el('div', { className: 'dim', style: 'margin-top:4px' }, [t('en.parent') + ': ',
        a ? el('a', { href: '#', textContent: a.asset_code, onclick: e => { e.preventDefault(); aoAsset(a.id); } })
          : el('span', { className: s.parent_code ? 'neg' : '', textContent: s.parent_code ? s.parent_code + ' — ' + t('en.parentMissing') : t('en.parentNone') })])])]);
  if (enAdm()) head.append(el('button', { type: 'button', className: 'btn', textContent: t('en.sysEdit'), onclick: () => enSysEdit(s) }));
  card.append(head);
  card.append(el('div', { className: 'aokpis' }, [
    el('div', { className: 'aokpi' }, [el('small', { textContent: t('en.k.items') }), el('b', { textContent: fmtInt(m.n) })]),
    el('div', { className: 'aokpi' }, [el('small', { textContent: t('en.k.assessed') }), el('b', { textContent: `${m.assessed} / ${m.n}` })]),
    el('div', { className: 'aokpi' + (m.avg != null && m.avg < 3 ? ' warn' : '') }, [el('small', { textContent: t('en.k.avg') }), el('b', { textContent: m.avg == null ? '–' : m.avg.toFixed(1) })]),
    el('div', { className: 'aokpi' + (m.abn ? ' warn' : '') }, [el('small', { textContent: t('en.abn90') }), el('b', { textContent: fmtInt(m.abn) })])]));
  const tb = el('table', { className: 'adtbl entbl' });
  tb.append(el('tr', {}, ['en.c.code', 'en.c.name', 'en.c.loc', 'en.c.asset', 'en.c.qty', 'en.c.age', 'en.c.crit', 'en.c.score', 'en.c.action', 'en.c.abn', 'en.c.inc']
    .map((k, n) => el('th', { className: [4, 5, 6, 9, 10].includes(n) ? 'num' : '', textContent: t(k) }))));
  for (const i of m.items.concat(EN.items.filter(x => x.sys_code === s.code && !x.active))) {
    const c = enLatest(i.id), st = EN.stats.get(i.id) || {}, ia = EN.assets.get(i.asset_id), age = enAge(i);
    const tr = el('tr', { className: 'click' + (i.active ? '' : ' off') }, [
      el('td', {}, el('code', { textContent: i.code })), el('td', { textContent: i.name }), el('td', { textContent: i.location_code || '' }),
      el('td', { textContent: ia ? ia.asset_code : '' }), el('td', { className: 'num', textContent: enNum(i.qty) }),
      el('td', { className: 'num', textContent: age == null ? '' : `${age} / ${i.life_years || EN.cfg.life}` }),
      el('td', { className: 'num', textContent: String(i.criticality) }), el('td', {}, enScoreChip(c && c.score)),
      el('td', { textContent: c ? t('en.a.' + c.action) + (c.target_year ? ' ' + c.target_year : '') : '' }),
      el('td', { className: 'num' + (st.abn ? ' neg' : ''), textContent: st.abn ? fmtInt(st.abn) : '' }),
      el('td', { className: 'num', textContent: st.incidents ? `${st.incidents}${st.open_incidents ? ' (' + st.open_incidents + ')' : ''}` : '' })]);
    tr.onclick = () => enItemOpen(i.id);
    tb.append(tr);
  }
  card.append(el('div', { className: 'wrap' }, tb), el('p', { className: 'dim', style: 'font-size:12px', textContent: t('en.itemsHint') }));
  return card;
}

function enSysEdit(s) {
  const dr = enDrawerEl(), body = $('#enDrBody');
  $('#enDrTitle').textContent = `${s.code} · ${s.name_en}`;
  body.innerHTML = '';
  const f = { name_en: el('input', { value: s.name_en || '' }), name_vi: el('input', { value: s.name_vi || '' }),
              parent_code: el('input', { value: s.parent_code || '', placeholder: 'ENG.C2112.MES.1998.00017', spellcheck: false }),
              note: el('input', { value: s.note || '' }), active: el('input', { type: 'checkbox', checked: s.active }) };
  const out = el('div');
  const save = el('button', { type: 'button', className: 'btn pri', textContent: t('tool.save') });
  save.onclick = async () => {
    try {
      await SB.rpc('am_eng_sys_save', { p: { code: s.code, name_en: f.name_en.value, name_vi: f.name_vi.value, parent_code: f.parent_code.value,
                                             note: f.note.value, active: f.active.checked } });
      enDrawerClose(); enReload(t('en.saved'));
    } catch (e) { enErr(out, e); }
  };
  body.append(aoFld(t('en.f.nameEn'), f.name_en), aoFld(t('en.f.nameVi'), f.name_vi), aoFld(t('en.parent'), f.parent_code),
    aoFld(t('en.f.note'), f.note), el('label', { className: 'chk' }, [f.active, el('span', { textContent: t('en.f.active') })]), out,
    el('div', { className: 'row', style: 'margin-top:12px' }, save));
  dr.hidden = false;
}

async function enItemOpen(id) {
  const i = enItem(id);
  if (!i) return;
  const dr = enDrawerEl(), body = $('#enDrBody');
  $('#enDrTitle').textContent = `${i.code} · ${i.name}`;
  body.innerHTML = '';
  dr.hidden = false;
  const out = el('div');
  body.append(out);
  const ia = EN.assets.get(i.asset_id), age = enAge(i), st = EN.stats.get(i.id) || {};
  body.append(el('dl', { className: 'aodl' }, [
    el('dt', { textContent: t('en.c.asset') }), el('dd', {}, ia ? el('a', { href: '#', textContent: ia.asset_code, onclick: e => { e.preventDefault(); aoAsset(ia.id); } }) : t('en.assetNone')),
    el('dt', { textContent: t('en.c.age') }), el('dd', { textContent: age == null ? t('en.ageUnknown') : t('en.ageTxt', { age, life: i.life_years || EN.cfg.life }) }),
    el('dt', { textContent: t('en.abn90') }), el('dd', { textContent: `${fmtInt(st.abn || 0)} / ${fmtInt(st.readings || 0)}` }),
    el('dt', { textContent: t('en.c.inc') }), el('dd', { textContent: fmtInt(st.incidents || 0) + (st.open_incidents ? ' · ' + t('en.incOpen', { n: st.open_incidents }) : '') })]));

  // Condition: new assessment, then the history.
  body.append(el('h3', { textContent: t('en.cond.h') }));
  if (enEd()) body.append(enCondForm(i, out));
  const hist = EN.cond.filter(c => c.item_id === i.id);
  if (!hist.length) body.append(el('p', { className: 'dim', textContent: t('en.cond.none') }));
  else {
    const tb = el('table', { className: 'adtbl entbl' });
    tb.append(el('tr', {}, ['en.c.date', 'en.c.score', 'en.c.action', 'en.c.cost', 'en.c.reason', 'en.c.by', ''].map(k => el('th', { textContent: k ? t(k) : '' }))));
    for (const c of hist) {
      const del = enEd() && (c.created_by === (ME && ME.id) || enAdm())
        ? el('button', { type: 'button', className: 'btn sm', textContent: '✕', onclick: async () => {
            if (!confirm(t('en.cond.del'))) return;
            try { await SB.rpc('am_cond_delete', { p_id: c.id }); EN.cond = EN.cond.filter(x => x.id !== c.id); enItemOpen(i.id); enRender(); }
            catch (e) { enErr(out, e); } } }) : '';
      tb.append(el('tr', {}, [el('td', { className: 'nowrap', textContent: fmtDate(c.assessed_on) }), el('td', {}, enScoreChip(c.score)),
        el('td', { textContent: t('en.a.' + c.action) + (c.target_year ? ' · ' + c.target_year : '') + (c.remaining_years != null ? ' · ' + t('en.remTxt', { n: enNum(c.remaining_years) }) : '') }),
        el('td', { className: 'num', textContent: enMoney(c.est_cost) }), el('td', { className: 'entxt', textContent: c.reason || '' }),
        el('td', { className: 'dim', textContent: c.created_name || '' }), el('td', {}, del)]));
    }
    body.append(el('div', { className: 'wrap' }, tb));
  }

  // Recent abnormal readings of this item's checklist points.
  body.append(el('h3', { textContent: t('en.abnRecent') }));
  const abnBox = el('div', { className: 'dim', textContent: t('table.loading') });
  body.append(abnBox);
  const myPts = EN.points.filter(p => p.item_id === i.id);
  (myPts.length ? SB.select('am_chk_val', `select=run_id,point_id,state,num1,num2,note,incident_id,at&point_id=in.(${myPts.map(p => p.id).join(',')})&ok=eq.false&order=at.desc&limit=30`)
    : Promise.resolve([]))
    .then(async rows => {
      const runs = rows.length ? await SB.select('am_chk_run', `select=id,run_date,shift,chk_code&id=in.(${[...new Set(rows.map(v => v.run_id))].join(',')})`) : [];
      for (const v of rows) { v.run = runs.find(r => r.id === v.run_id); v.point = myPts.find(p => p.id === v.point_id); }
      abnBox.innerHTML = '';
      if (!rows.length) return abnBox.append(t('en.abnNone'));
      const tb = el('table', { className: 'adtbl entbl' });
      for (const v of rows) tb.append(el('tr', {}, [el('td', { className: 'nowrap', textContent: v.run ? `${fmtDate(v.run.run_date)} ${t('en.shift.' + v.run.shift)}` : '' }),
        el('td', { textContent: v.point ? v.point.task : '' }), el('td', { className: 'neg', textContent: [v.state, v.num1 != null ? enNum(v.num1) : '', v.num2 != null ? enNum(v.num2) : ''].filter(Boolean).join(' / ') }),
        el('td', { textContent: v.note || '' }), el('td', {}, v.incident_id ? el('span', { className: 'aost open', textContent: t('en.inc.linked') }) : '')]));
      abnBox.append(el('div', { className: 'wrap' }, tb));
    }).catch(e => { abnBox.textContent = e.message; });

  // Item details (edit right).
  if (enEd()) {
    body.append(el('h3', { textContent: t('en.itemEdit') }));
    const f = { name: el('input', { value: i.name }), location_code: el('input', { value: i.location_code || '', spellcheck: false }),
                asset_code: el('input', { value: ia ? ia.asset_code : '', spellcheck: false, placeholder: t('en.assetPh') }),
                qty: el('input', { type: 'number', min: 0, step: 'any', value: i.qty }),
                install_year: el('input', { type: 'number', min: 1900, max: 2100, value: i.install_year || '' }),
                life_years: el('input', { type: 'number', min: 1, max: 100, value: i.life_years || '', placeholder: String(EN.cfg.life) }),
                criticality: el('select', {}, [1, 2, 3, 4, 5].map(n => el('option', { value: n, textContent: `${n} — ${t('en.crit.' + n)}`, selected: n === i.criticality }))),
                note: el('input', { value: i.note || '' }), active: el('input', { type: 'checkbox', checked: i.active }) };
    const save = el('button', { type: 'button', className: 'btn', textContent: t('tool.save') });
    save.onclick = async () => {
      try {
        await SB.rpc('am_eng_item_save', { p: { id: i.id, name: f.name.value, location_code: f.location_code.value, asset_code: f.asset_code.value,
          qty: f.qty.value, install_year: f.install_year.value, life_years: f.life_years.value, criticality: f.criticality.value,
          note: f.note.value, active: f.active.checked } });
        enDrawerClose(); enReload(t('en.saved'));
      } catch (e) { enErr(out, e); }
    };
    body.append(el('div', { className: 'engrid2' }, [aoFld(t('en.c.name'), f.name), aoFld(t('en.c.loc'), f.location_code), aoFld(t('en.c.asset'), f.asset_code),
      aoFld(t('en.c.qty'), f.qty), aoFld(t('en.f.install'), f.install_year), aoFld(t('en.f.life'), f.life_years), aoFld(t('en.c.crit'), f.criticality),
      aoFld(t('en.f.note'), f.note)]), el('label', { className: 'chk' }, [f.active, el('span', { textContent: t('en.f.active') })]),
      el('div', { className: 'row', style: 'margin-top:10px' }, save));
  }
}

function enCondForm(i, out) {
  const sug = enSuggest(i), last = enLatest(i.id);
  let score = null;
  const seg = el('div', { className: 'seg enscoreseg' }, [5, 4, 3, 2, 1].map(n => {
    const b = el('button', { type: 'button', className: 's' + n, innerHTML: `<b>${n}</b><small>${t('en.score.' + n)}</small>` });
    b.onclick = () => { score = n; seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); };
    return b;
  }));
  const f = { assessed_on: el('input', { type: 'date', value: enIso(new Date()), max: enIso(new Date()) }),
              remaining_years: el('input', { type: 'number', min: 0, max: 60, step: '0.5', value: last && last.remaining_years != null ? last.remaining_years : '' }),
              action: el('select', {}, EN_ACTIONS.map(a => el('option', { value: a, textContent: t('en.a.' + a), selected: a === ((last && last.action) || 'monitor') }))),
              target_year: el('input', { type: 'number', min: 2000, max: 2100, value: last && last.target_year ? last.target_year : '' }),
              est_cost: el('input', { type: 'text', inputMode: 'numeric', value: last && last.est_cost ? fmtInt(Number(last.est_cost)) : '' }),
              reason: el('textarea', { rows: 3, placeholder: t('en.reasonPh') }) };
  const save = el('button', { type: 'button', className: 'btn pri', textContent: t('en.cond.save') });
  save.onclick = async () => {
    if (!score) return msg(out, 'err', t('en.cond.pick'));
    try {
      await SB.rpc('am_cond_save', { p: { item_id: i.id, assessed_on: f.assessed_on.value, score, remaining_years: f.remaining_years.value,
        action: f.action.value, target_year: f.target_year.value, est_cost: f.est_cost.value.replace(/[^\d]/g, ''), reason: f.reason.value } });
      EN.cond = await SB.select('am_cond', 'select=*&order=assessed_on.desc,id.desc&limit=20000');
      await enItemOpen(i.id);   // redraws the drawer, so the message goes in the new one
      msg($('#enDrBody').firstChild, 'ok', t('en.cond.saved'));
      enRender();
    } catch (e) { enErr(out, e); }
  };
  return el('div', { className: 'encondform' }, [
    el('div', { className: 'dim', style: 'font-size:12px', textContent: sug ? t('en.suggest', { n: sug }) : t('en.suggestNone') }),
    seg,
    el('div', { className: 'engrid2' }, [aoFld(t('en.c.date'), f.assessed_on), aoFld(t('en.f.rem'), f.remaining_years), aoFld(t('en.c.action'), f.action),
      aoFld(t('en.f.year'), f.target_year), aoFld(t('en.c.cost'), f.est_cost)]),
    aoFld(t('en.c.reason'), f.reason), el('div', { className: 'row', style: 'margin-top:8px' }, save)]);
}

/* ------------------------------------------------------------- condition & plan */
function enCondRows() {
  const sel = EN.condSys || (EN.condSys = new Set(EN.cfg.pilot.filter(c => enSys(c))));
  return EN.items.filter(i => i.active && (!sel.size || sel.has(i.sys_code)));
}

function enCondTab(body) {
  if (!EN.condSys) enCondRows();
  const chips = el('div', { className: 'row', style: 'flex-wrap:wrap;gap:6px' });
  const all = el('button', { type: 'button', className: 'btn sm' + (!EN.condSys.size ? ' pri' : ''), textContent: t('en.allSys') });
  all.onclick = () => { EN.condSys = new Set(); enRender(); };
  chips.append(all);
  for (const s of EN.sys) {
    const b = el('button', { type: 'button', className: 'btn sm' + (EN.condSys.has(s.code) ? ' pri' : ''), textContent: `${s.code} ${enSysName(s)}` });
    b.onclick = () => { EN.condSys.has(s.code) ? EN.condSys.delete(s.code) : EN.condSys.add(s.code); enRender(); };
    chips.append(b);
  }
  body.append(el('div', { className: 'card' }, [el('p', { className: 'adedit', style: 'margin-top:0', textContent: t('en.cond.lead') }), chips]));
  const rows = enCondRows();
  const latest = rows.map(i => ({ i, c: enLatest(i.id) }));
  const assessed = latest.filter(x => x.c);
  const dist = [1, 2, 3, 4, 5].map(n => assessed.filter(x => x.c.score === n).length);
  const yNow = new Date().getFullYear();
  const plan = assessed.filter(x => ['repair', 'overhaul', 'replace'].includes(x.c.action));
  const cost5 = plan.filter(x => !x.c.target_year || x.c.target_year <= yNow + 5).reduce((s, x) => s + Number(x.c.est_cost || 0), 0);
  body.append(el('div', { className: 'aokpis' }, [
    el('div', { className: 'aokpi' }, [el('small', { textContent: t('en.k.assessed') }), el('b', { textContent: `${assessed.length} / ${rows.length}` })]),
    el('div', { className: 'aokpi' }, [el('small', { textContent: t('en.k.dist') }), el('span', { className: 'endist' }, dist.map((n, k) => el('span', { className: 'enscore s' + (k + 1), textContent: `${k + 1}: ${n}` })))]),
    el('div', { className: 'aokpi' + (dist[0] + dist[1] ? ' warn' : '') }, [el('small', { textContent: t('en.k.low') }), el('b', { textContent: fmtInt(dist[0] + dist[1]) })]),
    el('div', { className: 'aokpi' }, [el('small', { textContent: t('en.k.cost5') }), el('b', { textContent: enMoney(cost5) })])]));

  // Plan by year × system: what the assessments ask for.
  const years = [...new Set(plan.map(x => x.c.target_year || yNow))].sort();
  if (years.length) {
    const sysList = [...new Set(plan.map(x => x.i.sys_code))].sort();
    const tb = el('table', { className: 'adtbl entbl' });
    tb.append(el('tr', {}, [el('th', { textContent: t('en.c.sys') }), ...years.map(y => el('th', { className: 'num', textContent: String(y) })), el('th', { className: 'num', textContent: t('en.total') })]));
    for (const sc of sysList) {
      const sum = y => plan.filter(x => x.i.sys_code === sc && (x.c.target_year || yNow) === y).reduce((s, x) => s + Number(x.c.est_cost || 0), 0);
      tb.append(el('tr', {}, [el('td', { textContent: `${sc} ${enSysName(enSys(sc))}` }), ...years.map(y => el('td', { className: 'num', textContent: enMoney(sum(y)) || '' })),
        el('td', { className: 'num', textContent: enMoney(years.reduce((s, y) => s + sum(y), 0)) })]));
    }
    body.append(el('div', { className: 'card' }, [el('h3', { textContent: t('en.plan.h') }), el('div', { className: 'wrap' }, tb)]));
  }

  const xls = el('button', { type: 'button', className: 'btn', textContent: t('en.plan.xls'), onclick: () => enCondXls(latest) });
  const tb = el('table', { className: 'adtbl entbl' });
  tb.append(el('tr', {}, ['en.c.code', 'en.c.name', 'en.c.age', 'en.c.crit', 'en.c.score', 'en.c.rem', 'en.c.action', 'en.c.cost', 'en.c.reason', 'en.c.date', 'en.c.abn']
    .map(k => el('th', { textContent: t(k) }))));
  const rank = x => (x.c ? x.c.score * 10 : 100) - (x.i.criticality || 3);
  for (const x of latest.sort((a, b) => rank(a) - rank(b))) {
    const { i, c } = x, st = EN.stats.get(i.id) || {}, age = enAge(i);
    const tr = el('tr', { className: 'click' }, [el('td', {}, el('code', { textContent: i.code })), el('td', { textContent: i.name }),
      el('td', { className: 'num', textContent: age == null ? '' : `${age}/${i.life_years || EN.cfg.life}` }), el('td', { className: 'num', textContent: String(i.criticality) }),
      el('td', {}, c ? enScoreChip(c.score) : el('span', { className: 'dim', textContent: enSuggest(i) ? t('en.sugShort', { n: enSuggest(i) }) : '–' })),
      el('td', { className: 'num', textContent: c && c.remaining_years != null ? enNum(c.remaining_years) : '' }),
      el('td', { textContent: c ? t('en.a.' + c.action) + (c.target_year ? ' ' + c.target_year : '') : '' }),
      el('td', { className: 'num', textContent: c ? enMoney(c.est_cost) : '' }), el('td', { className: 'entxt', textContent: c ? c.reason || '' : '' }),
      el('td', { className: 'nowrap dim', textContent: c ? fmtDate(c.assessed_on) : t('en.cond.not') }),
      el('td', { className: 'num' + (st.abn ? ' neg' : ''), textContent: st.abn ? fmtInt(st.abn) : '' })]);
    tr.onclick = () => enItemOpen(i.id);
    tb.append(tr);
  }
  body.append(el('div', { className: 'card' }, [el('div', { className: 'row', style: 'align-items:center' }, [el('h3', { style: 'margin:0;flex:1', textContent: t('en.cond.list') }), xls]),
    el('div', { className: 'wrap', style: 'margin-top:8px' }, tb)]));
}

function enCondXls(latest) {
  const rows = latest.map(({ i, c }) => {
    const s = enSys(i.sys_code), ia = EN.assets.get(i.asset_id) || EN.assets.get((s || {}).asset_id), st = EN.stats.get(i.id) || {};
    return { [t('en.c.sys')]: `${i.sys_code} ${enSysName(s)}`, [t('en.c.code')]: i.code, [t('en.c.name')]: i.name, [t('en.c.asset')]: ia ? ia.asset_code : '',
      [t('en.c.loc')]: i.location_code || '', [t('en.c.qty')]: Number(i.qty), [t('en.f.install')]: i.install_year || (ia && ia.purchase_year) || '',
      [t('en.f.life')]: i.life_years || EN.cfg.life, [t('en.c.crit')]: i.criticality, [t('en.c.score')]: c ? c.score : '',
      [t('en.c.rem')]: c && c.remaining_years != null ? Number(c.remaining_years) : '', [t('en.c.action')]: c ? t('en.a.' + c.action) : '',
      [t('en.f.year')]: c && c.target_year ? c.target_year : '', [t('en.c.cost')]: c && c.est_cost ? Number(c.est_cost) : '',
      [t('en.c.reason')]: c ? c.reason || '' : '', [t('en.abn90')]: st.abn || 0, [t('en.c.inc')]: st.incidents || 0,
      [t('en.c.date')]: c ? c.assessed_on : '', [t('en.c.by')]: c ? c.created_name || '' : '' };
  });
  const wb = XLSX.utils.book_new(), ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [22, 10, 34, 26, 10, 7, 9, 9, 8, 7, 9, 12, 9, 15, 50, 9, 8, 11, 20].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Condition');
  XLSX.writeFile(wb, `Building systems condition ${enIso(new Date())}.xlsx`);
}

/* ------------------------------------------------------------- logbook */
async function enLogTab(body) {
  if (!EN.logChk || !enChk(EN.logChk)) EN.logChk = (EN.chk.find(c => EN.cfg.pilot.includes(c.sys_code)) || EN.chk[0] || {}).code;
  if (!EN.logTo) { const d = new Date(); EN.logTo = enIso(d); d.setDate(d.getDate() - 6); EN.logFrom = enIso(d); }
  const sel = el('select', {}, EN.chk.map(c => el('option', { value: c.code, textContent: `${c.code} · ${c.name}`, selected: c.code === EN.logChk })));
  const from = el('input', { type: 'date', value: EN.logFrom }), to = el('input', { type: 'date', value: EN.logTo });
  const go = () => { EN.logChk = sel.value; EN.logFrom = from.value; EN.logTo = to.value; enRender(); };
  sel.onchange = go; from.onchange = go; to.onchange = go;
  const xls = el('button', { type: 'button', className: 'btn', textContent: t('en.log.xls') });
  body.append(el('div', { className: 'card row', style: 'align-items:flex-end;flex-wrap:wrap;gap:12px' }, [aoFld(t('en.log.chk'), sel), aoFld(t('en.from'), from), aoFld(t('en.to'), to), xls]));
  const box = el('div', { className: 'card' }, el('div', { className: 'dim', textContent: t('table.loading') }));
  const comp = el('div', { className: 'card' });
  body.append(comp, box);
  if (!EN.logChk) return;
  try {
    const [runs, allRuns] = await Promise.all([
      SB.select('am_chk_run', `select=*&chk_code=eq.${encodeURIComponent(EN.logChk)}&run_date=gte.${EN.logFrom}&run_date=lte.${EN.logTo}&order=run_date,shift`),
      SB.select('am_chk_run', `select=chk_code,status,abn,run_date,shift&run_date=gte.${EN.logFrom}&run_date=lte.${EN.logTo}&limit=20000`)]);
    // Morning → Afternoon → Night within a day (the letters do not sort that way).
    runs.sort((a, b) => (a.run_date === b.run_date ? EN_SHIFTS.indexOf(a.shift) - EN_SHIFTS.indexOf(b.shift) : a.run_date < b.run_date ? -1 : 1));
    // Compliance: runs completed against the shifts in the period, per checklist.
    const days = Math.max(1, Math.round((new Date(EN.logTo) - new Date(EN.logFrom)) / 86400000) + 1);
    const ct = el('table', { className: 'adtbl entbl' });
    ct.append(el('tr', {}, ['en.log.chk', 'en.log.expected', 'en.log.doneN', 'en.log.pct', 'en.k.abn'].map((k, n) => el('th', { className: n ? 'num' : '', textContent: t(k) }))));
    for (const c of EN.chk.filter(x => x.active)) {
      const exp = days * (c.shifts || []).length, mine = allRuns.filter(r => r.chk_code === c.code);
      const dn = mine.filter(r => r.status === 'done').length, pct = exp ? Math.round(100 * dn / exp) : 0;
      ct.append(el('tr', {}, [el('td', { textContent: `${c.code} · ${c.name}` }), el('td', { className: 'num', textContent: fmtInt(exp) }), el('td', { className: 'num', textContent: fmtInt(dn) }),
        el('td', { className: 'num ' + (pct < 90 ? 'neg' : ''), textContent: pct + '%' }), el('td', { className: 'num', textContent: fmtInt(mine.reduce((s, r) => s + (r.abn || 0), 0)) })]));
    }
    comp.append(el('h3', { textContent: t('en.log.comp', { n: days }) }), el('div', { className: 'wrap' }, ct));

    const pts = EN.points.filter(p => p.chk_code === EN.logChk);
    const vals = new Map();
    for (let k = 0; k < runs.length; k += 60) {
      const ids = runs.slice(k, k + 60).map(r => r.id);
      for (const v of await SB.select('am_chk_val', `select=run_id,point_id,state,num1,num2,ok,note,incident_id&run_id=in.(${ids.join(',')})&limit=20000`)) vals.set(v.run_id + ':' + v.point_id, v);
    }
    box.innerHTML = '';
    if (!runs.length) { box.append(el('div', { className: 'msg info', textContent: t('en.log.none') })); xls.disabled = true; return; }
    const cell = v => (v ? [v.state, v.num1 != null ? enNum(v.num1) : null, v.num2 != null ? enNum(v.num2) : null].filter(x => x != null && x !== '').join(' / ') : '');
    const tb = el('table', { className: 'adtbl entbl enlog' });
    tb.append(el('tr', {}, [el('th', { textContent: t('en.c.point') }), ...runs.map(r => el('th', { className: 'c', title: [r.started_name, r.done_name].filter(Boolean).join(' → '),
      innerHTML: `${fmtDate(r.run_date).slice(0, 5)}<br>${t('en.shiftShort.' + r.shift)}${r.status === 'done' ? '' : ' …'}` }))]));
    for (const p of pts) {
      tb.append(el('tr', {}, [el('td', { className: 'enlp', textContent: p.task + (p.unit ? ` (${p.unit})` : '') }),
        ...runs.map(r => { const v = vals.get(r.id + ':' + p.id);
          return el('td', { className: 'c' + (v && v.ok === false ? ' bad' : ''), textContent: cell(v) + (v && v.incident_id ? ' 🔧' : ''), title: (v && v.note) || '' }); })]));
    }
    box.append(el('div', { className: 'wrap' }, tb));
    xls.onclick = () => {
      const aoa = [[t('en.c.point'), t('en.c.unit'), ...runs.map(r => `${r.run_date} ${t('en.shift.' + r.shift)}`)]];
      for (const p of pts) aoa.push([p.task, p.unit || '', ...runs.map(r => cell(vals.get(r.id + ':' + p.id)))]);
      aoa.push([t('en.log.by'), '', ...runs.map(r => r.done_name || r.started_name || '')]);
      const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 36 }, { wch: 8 }, ...runs.map(() => ({ wch: 11 }))];
      XLSX.utils.book_append_sheet(wb, ws, EN.logChk);
      XLSX.writeFile(wb, `Logbook ${EN.logChk} ${EN.logFrom} ${EN.logTo}.xlsx`);
    };
  } catch (e) { box.innerHTML = ''; enErr(box, e); }
}

/* ------------------------------------------------------------- checklist set-up */
function enConfigTab(body) {
  if (!EN.cfgChk || !enChk(EN.cfgChk)) EN.cfgChk = (EN.chk[0] || {}).code;
  const sel = el('select', {}, EN.chk.map(c => el('option', { value: c.code, textContent: `${c.code} · ${c.name}`, selected: c.code === EN.cfgChk })));
  sel.onchange = () => { EN.cfgChk = sel.value; enRender(); };
  const out = el('div');
  body.append(el('div', { className: 'card' }, [el('p', { className: 'adedit', style: 'margin-top:0', textContent: t('en.cfg.lead') }), aoFld(t('en.log.chk'), sel), out]));
  const c = enChk(EN.cfgChk);
  if (!c) return;
  const items = EN.items.filter(i => i.sys_code === c.sys_code);
  const tb = el('table', { className: 'adtbl entbl encfg' });
  tb.append(el('tr', {}, ['en.c.point', 'en.c.item', 'en.cfg.normal', 'en.cfg.nums', 'en.c.unit', 'en.cfg.min', 'en.cfg.max', 'en.f.active', ''].map(k => el('th', { textContent: k ? t(k) : '' }))));
  for (const p of EN.points.filter(x => x.chk_code === c.code)) {
    const item = el('select', {}, [el('option', { value: '', textContent: '—' }), ...items.map(i => el('option', { value: i.id, textContent: `${i.code} ${i.name}`, selected: i.id === p.item_id }))]);
    const oks = (p.options || []).map(o => { const cb = el('input', { type: 'checkbox', checked: (p.ok_states || []).includes(o) }); cb.dataset.o = o; return cb; });
    const unit = el('input', { value: p.unit || '', style: 'width:70px' });
    const mn = el('input', { value: p.min_ok ?? '', inputMode: 'decimal', style: 'width:70px' });
    const mx = el('input', { value: p.max_ok ?? '', inputMode: 'decimal', style: 'width:70px' });
    const act = el('input', { type: 'checkbox', checked: p.active });
    const save = el('button', { type: 'button', className: 'btn sm', textContent: t('tool.save') });
    save.onclick = async () => {
      try {
        const payload = { id: p.id, ok_states: oks.filter(x => x.checked).map(x => x.dataset.o), unit: unit.value, min_ok: mn.value.replace(',', '.'),
                          max_ok: mx.value.replace(',', '.'), active: act.checked, item_id: item.value };
        await SB.rpc('am_chk_point_save', { p: payload });
        Object.assign(p, { ok_states: payload.ok_states, unit: unit.value || null, min_ok: mn.value === '' ? null : Number(payload.min_ok),
                           max_ok: mx.value === '' ? null : Number(payload.max_ok), active: act.checked, item_id: item.value ? Number(item.value) : null });
        msg(out, 'ok', t('en.cfg.saved', { task: p.task }));
      } catch (e) { enErr(out, e); }
    };
    tb.append(el('tr', { className: p.active ? '' : 'off' }, [el('td', { textContent: p.task }), el('td', {}, item),
      el('td', { className: 'nowrap' }, oks.length ? oks.map(cb => el('label', { className: 'chk inl' }, [cb, el('span', { textContent: cb.dataset.o })])) : '—'),
      el('td', { textContent: (p.num_labels || []).join(' / ') || '—' }), el('td', {}, unit), el('td', {}, mn), el('td', {}, mx), el('td', {}, act), el('td', {}, save)]));
  }
  body.append(el('div', { className: 'card' }, el('div', { className: 'wrap' }, tb)));
}

/* ------------------------------------------------------------- import */
function enImportTab(body) {
  const f1 = el('input', { type: 'file', accept: '.xlsx,.xls,.xlsb' }), f2 = el('input', { type: 'file', accept: '.xlsx,.xls,.xlsb' });
  const out = el('div'), prev = el('div');
  const read = async () => {
    try {
      const sysWb = f1.files[0] ? XLSX.read(await f1.files[0].arrayBuffer()) : null;
      const chkWb = f2.files[0] ? XLSX.read(await f2.files[0].arrayBuffer()) : null;
      if (!sysWb && !chkWb) return;
      EN.parsed = enParse(sysWb, chkWb);
      enImportPreview(prev, out);
    } catch (e) { msg(out, 'err', e.message); }
  };
  f1.onchange = read; f2.onchange = read;
  body.append(el('div', { className: 'card' }, [el('p', { className: 'adedit', style: 'margin-top:0', innerHTML: t('en.imp.lead_html') }),
    el('div', { className: 'row', style: 'flex-wrap:wrap;gap:16px' }, [aoFld(t('en.imp.sysFile'), f1), aoFld(t('en.imp.chkFile'), f2)]), out]), prev);
}

// A sheet as rows of cells; the header row is the first one with all the wanted columns.
function enSheet(wb, test) {
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
    const h = aoa.findIndex(r => test(r.map(hnorm)));
    if (h >= 0) return { name, head: aoa[h].map(hnorm), rows: aoa.slice(h + 1) };
  }
  return null;
}
const enCol = (head, ...pats) => head.findIndex(h => pats.some(p => p.test(h)));

function enParse(sysWb, chkWb) {
  const warn = [], sys = new Map(), items = [], chk = [], points = [];
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  if (sysWb) {
    const sh = enSheet(sysWb, h => h.some(x => /^mahethong/.test(x)) && h.some(x => /^mahangmuc/.test(x)));
    if (!sh) throw new Error(t('en.imp.noSys'));
    const c = { loc: enCol(sh.head, /^mavitri/), parent: enCol(sh.head, /^matscha|^mataisancha/), sc: enCol(sh.head, /^mahethong/), sn: enCol(sh.head, /^tenhethong/),
                ic: enCol(sh.head, /^mahangmuc/), inm: enCol(sh.head, /^tenhangmuc/) };
    for (const r of sh.rows) {
      const sc = clean(r[c.sc]).toUpperCase(), ic = clean(r[c.ic]).toUpperCase();
      if (!sc || !ic) continue;
      if (!sys.has(sc)) sys.set(sc, { code: sc, name_en: clean(r[c.sn]), parents: [], sort: sys.size + 1 });
      const s = sys.get(sc), pc = clean(r[c.parent]);
      if (pc && !s.parents.includes(pc)) s.parents.push(pc);
      items.push({ code: ic, sys_code: sc, name: clean(r[c.inm]), location_code: c.loc >= 0 ? clean(r[c.loc]) : '', sort: items.length + 1 });
    }
    for (const s of sys.values()) {
      if (s.parents.length > 1) warn.push(t('en.imp.w.parents', { sys: s.code, codes: s.parents.join(', ') }));
      const names = items.filter(i => i.sys_code === s.code).map(i => hnorm(i.name));
      const dup = [...new Set(names.filter((n, k) => names.indexOf(n) !== k))];
      if (dup.length) warn.push(t('en.imp.w.dup', { sys: s.code, names: items.filter(i => i.sys_code === s.code && dup.includes(hnorm(i.name))).map(i => i.code + ' ' + i.name).join(', ') }));
    }
  }
  // Existing systems count too: the checklist file can be read on its own later.
  for (const s of EN.sys) if (!sys.has(s.code)) sys.set(s.code, { code: s.code, name_en: s.name_en, parents: s.parent_code ? [s.parent_code] : [], sort: s.sort, existing: true });
  if (chkWb) {
    const dh = enSheet(chkWb, h => h.some(x => /^madcl/.test(x)) && h.some(x => /^tenhethong/.test(x)) && h.some(x => /^chuky/.test(x)));
    const ph = enSheet(chkWb, h => h.some(x => /^madcl/.test(x)) && h.some(x => /^tennhiemvu/.test(x)));
    if (!dh || !ph) throw new Error(t('en.imp.noChk'));
    const d = { code: enCol(dh.head, /^madcl/), parent: enCol(dh.head, /^matscha|^mataisancha/), sn: enCol(dh.head, /^tenhethong/), shift: enCol(dh.head, /^shift|^ca$/) };
    const findSys = (name, parent) => {
      const n = hnorm(name);
      const byName = [...sys.values()].find(s => { const h = hnorm(s.name_en); return n && (h === n || h.startsWith(n) || n.startsWith(h)); });
      return byName || [...sys.values()].find(s => parent && s.parents[0] === parent) || null;
    };
    let extra = 21;
    for (const r of dh.rows) {
      const code = clean(r[d.code]).toUpperCase();
      if (!/^DCL\d+/.test(code)) continue;
      const name = clean(r[d.sn]), parent = clean(r[d.parent]);
      let s = findSys(name, parent);
      if (!s) {   // a system the list does not have (Kitchen, LPG): add it
        while (sys.has('ST' + extra)) extra++;
        s = { code: 'ST' + extra, name_en: name, parents: parent ? [parent] : [], sort: extra, added: true };
        sys.set(s.code, s);
        warn.push(t('en.imp.w.newSys', { sys: s.code, name, dcl: code }));
      } else if (parent && !s.parents.includes(parent)) {
        if (!s.parents.length) { s.parents.push(parent); warn.push(t('en.imp.w.fillParent', { sys: s.code, code: parent, dcl: code })); }
        else warn.push(t('en.imp.w.otherParent', { sys: s.code, code: parent, dcl: code, own: s.parents[0] }));
      }
      const sh = clean(r[d.shift]);
      const shifts = [['S', /sang|morning/], ['C', /chieu|afternoon/], ['D', /dem|night/]].filter(([, re]) => re.test(hnorm(sh))).map(x => x[0]);
      chk.push({ code, name, sys_code: s.code, shifts: shifts.length ? shifts : ['S', 'C', 'D'], sort: chk.length + 1 });
    }
    const p = { code: enCol(ph.head, /^madcl/), loc: enCol(ph.head, /^locationcode|^mavitri/), floor: enCol(ph.head, /^floor|^tang/), task: enCol(ph.head, /^tennhiemvu/),
                set: enCol(ph.head, /^checklistsetting|^caidat/), uom: enCol(ph.head, /^uom|^donvi/) };
    const unmatched = [];
    for (const r of ph.rows) {
      const code = clean(r[p.code]).toUpperCase(), task = clean(r[p.task]);
      if (!code || !task) continue;
      const k = chk.find(x => x.code === code);
      if (!k) { warn.push(t('en.imp.w.noDcl', { dcl: code, task })); continue; }
      const setting = clean(r[p.set]).split(/[;,]/).map(x => x.trim()).filter(Boolean);
      const pt = enSetting(setting, task, clean(r[p.uom]));
      const cand = items.concat(EN.items.map(i => ({ code: i.code, sys_code: i.sys_code, name: i.name })))
        .filter(i => i.sys_code === k.sys_code);
      const tn = hnorm(task);
      const it = cand.find(i => hnorm(i.name) === tn) || cand.find(i => { const h = hnorm(i.name); return h.length > 4 && (tn.includes(h) || h.includes(tn)); });
      if (!it && pt.options && cand.length) unmatched.push(`${code} ${task}`);
      points.push(Object.assign({ chk_code: code, seq: points.filter(x => x.chk_code === code).length + 1, task, location_code: clean(r[p.loc]),
                                  floor: clean(r[p.floor]), item_code: it ? it.code : null }, pt));
    }
    if (unmatched.length) warn.push(t('en.imp.w.unmatched', { n: unmatched.length, list: unmatched.slice(0, 12).join('; ') + (unmatched.length > 12 ? '…' : '') }));
    const known = new Set(EN.points.map(x => x.chk_code + '|' + x.task));
    const tasks = points.map(x => x.chk_code + '|' + x.task);
    const dupT = [...new Set(tasks.filter((x, k) => tasks.indexOf(x) !== k))];
    if (dupT.length) warn.push(t('en.imp.w.dupTask', { list: dupT.join('; ') }));
    EN.parsedNew = points.filter(x => !known.has(x.chk_code + '|' + x.task)).length;
  }
  const sysOut = [...sys.values()].filter(s => !s.existing || s.added || s.parents.length)
    .map(s => ({ code: s.code, name_en: s.name_en, parent_code: s.parents[0] || null, sort: s.sort, _added: !!s.added }));
  for (const s of sysOut) if (!s.parent_code) warn.push(t('en.imp.w.noParent', { sys: s.code }));
  return { sys: sysOut, items, chk, points, warn };
}

/* "Auto;On;Off" → buttons; Pressure / Temperature / Level / Liter / M3 / Battery →
   number boxes with a unit read from the task name when it says one. */
function enSetting(tokens, task, uom) {
  const states = tokens.filter(x => /^(auto|on|off)$/i.test(x)).map(x => x[0].toUpperCase() + x.slice(1).toLowerCase());
  const rest = tokens.filter(x => !/^(auto|on|off)$/i.test(x));
  const unitIn = (task.match(/\(([^)]*)\)/) || [])[1] || '';
  let labels = null, unit = uom || null;
  const u = s => (/kg\/?cm/i.test(s) ? 'kg/cm²' : /psi/i.test(s) ? 'psi' : /volt/i.test(s) ? 'V' : /lit/i.test(s) ? 'L' : /m3/i.test(s) ? 'm³' : null);
  if (rest.length) {
    const lines = rest.filter(x => /^line\s*\d/i.test(x));
    if (lines.length) { labels = lines; unit = unit || u(rest.join(' ')) || 'kg/cm²'; }
    else if (/set\s*\/\s*act/i.test(task)) { labels = ['Set', 'Actual']; unit = unit || (rest.some(x => /temp/i.test(x)) ? '°C' : null); }
    else {
      const k = rest[0].toLowerCase();
      if (k.startsWith('battery')) { labels = ['Battery']; unit = unit || 'V'; }
      else if (k.startsWith('pressure')) { labels = [rest[0]]; unit = unit || u(unitIn) || 'kg/cm²'; }
      else if (k.startsWith('temp')) { labels = [rest[0]]; unit = unit || '°C'; }
      else if (k.startsWith('level')) { labels = [rest[0]]; unit = unit || '%'; }
      else if (k.startsWith('liter') || k === 'l') { labels = ['Liter']; unit = unit || 'L'; }
      else if (k === 'm3') { labels = ['m³']; unit = unit || 'm³'; }
      else { labels = [rest[0]]; unit = unit || u(rest.join(' ')); }
    }
  }
  // Stand-by / spare equipment is normally off.
  const standby = /stand\s*by|stanby|spare|du phong|dự phòng/i.test(task);
  return { options: states.length ? states : null, ok_states: standby ? ['Auto', 'On', 'Off'] : ['Auto', 'On'], num_labels: labels, unit };
}

function enImportPreview(prev, out) {
  const P = EN.parsed;
  prev.innerHTML = '';
  msg(out, 'info', t('en.imp.read', { s: P.sys.length, i: P.items.length, c: P.chk.length, p: P.points.length }));
  if (P.warn.length) prev.append(el('div', { className: 'card' }, [el('h3', { textContent: t('en.imp.warn', { n: P.warn.length }) }),
    el('ul', { className: 'enwarn' }, P.warn.map(w => el('li', { textContent: w })))]));
  const tb = el('table', { className: 'adtbl entbl' });
  tb.append(el('tr', {}, ['en.c.sys', 'en.parent', 'en.k.items', 'en.imp.dcl', 'en.imp.pts'].map(k => el('th', { textContent: t(k) }))));
  for (const s of P.sys) {
    const dcl = P.chk.filter(c => c.sys_code === s.code);
    tb.append(el('tr', {}, [el('td', { textContent: `${s.code} ${s.name_en}` + (s._added ? ' ★' : '') }), el('td', { className: s.parent_code ? '' : 'neg', textContent: s.parent_code || '—' }),
      el('td', { className: 'num', textContent: fmtInt(P.items.filter(i => i.sys_code === s.code).length) }), el('td', { textContent: dcl.map(c => c.code).join(', ') }),
      el('td', { className: 'num', textContent: fmtInt(P.points.filter(p => dcl.some(c => c.code === p.chk_code)).length) })]));
  }
  const go = el('button', { type: 'button', className: 'btn pri', textContent: t('en.imp.go') });
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await SB.rpc('am_eng_import', { p_sys: P.sys.map(({ _added, ...s }) => s), p_items: P.items, p_chk: P.chk, p_points: P.points });
      EN.parsed = null; EN.loaded = false;
      const note = t('en.imp.done', { s: r.systems, i: r.items, c: r.checklists, p: r.points });
      // From Data sources (user 29/09/2026) the result is said there; the screen reads the systems when opened.
      if (VIEW !== 'eng') { prev.innerHTML = ''; msg(out, 'ok', note); return; }
      EN.tab = 'systems';
      enReload(note);
    } catch (e) { go.disabled = false; enErr(out, e); }
  };
  prev.append(el('div', { className: 'card' }, [el('div', { className: 'wrap' }, tb), el('p', { className: 'dim', style: 'font-size:12px', textContent: t('en.imp.keep') }), go]));
}
