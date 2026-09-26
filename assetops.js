/* ============================================================ ASSET OPERATIONS
   The asset-management module in detail (31_asset_ops.sql), loaded after app.js
   and using its helpers (el, msg, t, SB, PM, WF, lqb* form builders…):

     transfer    Asset transfer slip with its approval chain — handing dept head
                 → receiving dept head → JVC GM (between legal entities) → AM
                 team confirms, which updates the register (new code when the
                 department changes, barcode kept, label to reprint; part of a
                 low-value batch splits into a new row).
     incident    Repair · maintenance · breakage (B&L) · loss, with the asset
                 status following it, work order, vendor, warranty, cost, outcome.
     stock       Periodic stock-take by department / location: the register list
                 frozen when the count opens, counted on the tablet (stockcount)
                 by scanning, then closed — locations updated, "loss" and
                 "repair" incidents raised for what was missing or damaged —
                 with the count minutes.
     amrep       Periodic report: by department / group / status, movement over
                 the period, open work; a period can be frozen (snapshot).
     drawer      Click an asset code in the register: the facts, photos, and the
                 whole life of the asset (history of changes, intake, label,
                 transfers, incidents, counts, liquidation, accounting). */

const AO = {
  tf:  { rows: [], lines: [], assets: new Map(), inbox: [], tab: 'todo', open: null, edit: null, q: '' },
  inc: { rows: [], assets: new Map(), tab: 'open', open: null, draft: null, q: '' },
  kk:  { rows: [], open: null, lines: [], filter: 'all', edit: null, q: '' },
  sc:  { count: null, lines: [], loc: '', q: '', only: 'here' },
  rep: { mode: 'month', val: '', data: null, snaps: [], cmp: '', view: null }
};
let AO_LOC = null;
const aoLocs = async () => AO_LOC || (AO_LOC = await pmSelectAll('am_location', 'select=code,name,dept_code,active&order=code').catch(() => []));
const aoScope = dept => !!(ME && ME.roles.some(r => wfCovers(r.scope, dept)));
const aoDepts = () => (PM.orgs || []).filter(o => o.is_department).map(o => o.code).sort();
const aoMyDepts = () => aoDepts().filter(aoScope);
const aoDeptOpt = c => [c, `${c} — ${pmDeptName(c)}`];
const aoName = a => [a.name_vi, a.name_en].filter(Boolean).join(' / ');
const aoToday = () => new Date().toISOString().slice(0, 10);
// Before 31_asset_ops.sql has run, the screens say so instead of failing.
const aoMissing = e => /am_transfer|am_incident|am_count|am_report|am_asset_history|am_tf_|am_inc_|PGRST20[25]|does not exist|404/.test(String(e && e.message));
const aoErr = (out, e) => msg(out, 'err', aoMissing(e) ? t('ao.notInstalled') : e.message);
const aoChip = (s, pre = 'tf') => el('span', { className: 'aost ' + s, textContent: t(`ao.${pre}.st.${s}`) });
async function aoAssetsById(ids) {
  const m = new Map(), u = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < u.length; i += 200)
    for (const a of await SB.select('am_asset', `select=id,asset_code,barcode,name_vi,name_en,asset_kind,qty,unit_code,dept_code,location_code,status_code,unit_price&id=in.(${u.slice(i, i + 200).join(',')})`))
      m.set(a.id, a);
  return m;
}
function aoTabs(box, list, cur, go) {
  box.innerHTML = '';
  for (const [v, label, n] of list) {
    const b = el('button', { type: 'button', textContent: label + (n != null ? ` (${fmtInt(n)})` : '') });
    b.classList.toggle('on', cur === v);
    b.onclick = () => go(v);
    box.append(b);
  }
}
const aoFld = (label, input, style) => el('div', { className: 'fld', style: style || '' }, [el('label', { textContent: label }), input]);

/* An asset search box: code, barcode or name, within one department (or every
   department the person can see). Enter on an exact code / barcode picks it. */
function aoPicker(opt) {
  const box = el('div', { className: 'aopick' });
  const inp = el('input', { placeholder: opt.placeholder || t('ao.pickPh'), spellcheck: false });
  const list = el('div', { className: 'aopicklist', hidden: true });
  let tmr = null, rows = [];
  const pick = a => { list.hidden = true; inp.value = ''; opt.onPick(a); };
  const search = async () => {
    const q = inp.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    const pat = encodeURIComponent(`*${q.replace(/[*(),]/g, '')}*`);
    const dept = typeof opt.dept === 'function' ? opt.dept() : opt.dept;
    try {
      rows = await SB.select('am_asset', `select=id,asset_code,barcode,name_vi,name_en,asset_kind,qty,unit_code,dept_code,location_code,status_code,unit_price,purchase_date,in_use_date` +
        `&or=(asset_code.ilike.${pat},barcode.ilike.${pat},name_vi.ilike.${pat},name_en.ilike.${pat})${dept ? `&dept_code=eq.${encodeURIComponent(dept)}` : ''}&order=asset_code&limit=20`);
    } catch (e) { rows = []; }
    if (opt.filter) rows = rows.filter(opt.filter);
    list.innerHTML = '';
    for (const a of rows) list.append(el('button', { type: 'button', className: 'aopickrow', onclick: () => pick(a) }, [
      el('code', { textContent: a.asset_code }), el('span', { textContent: aoName(a) }),
      el('small', { textContent: [a.barcode, a.dept_code, a.location_code, a.asset_kind === 'low' ? `${t('col.qty')} ${fmtNum(a.qty)} ${a.unit_code || ''}` : '', amStatusLabel(a.status_code)].filter(Boolean).join(' · ') })]));
    if (!rows.length) list.append(el('div', { className: 'dim', style: 'padding:6px 8px', textContent: t('ao.pickNone') }));
    list.hidden = false;
  };
  inp.oninput = () => { clearTimeout(tmr); tmr = setTimeout(search, 250); };
  inp.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    await search();
    const q = inp.value.trim().toUpperCase();
    const hit = rows.find(a => a.asset_code.toUpperCase() === q || String(a.barcode || '').toUpperCase() === q) || (rows.length === 1 ? rows[0] : null);
    if (hit) pick(hit);
  };
  inp.onblur = () => setTimeout(() => { list.hidden = true; }, 200);
  box.append(inp, list);
  return box;
}

// Pages of a form (lqsheet builders) → PDF preview or download.
async function aoCapture(build, file, fmt, out) {
  const host = el('div', { className: 'fpdfhost' });
  try {
    msg(out, 'info', t('wf.pdfMaking'));
    await Promise.all(['html2canvas', 'jspdf'].map(snapLib));
    document.body.append(host);
    const pages = fsPages(el('div', { className: 'lqsheet print' }, build()));
    const shots = [];
    for (let i = 0; i < pages.length; i++) {
      host.innerHTML = ''; host.append(pages[i].box);
      const canvas = await html2canvas(pages[i].box, { scale: 2, backgroundColor: '#ffffff', logging: false });
      shots.push({ label: file, first: i === 0, doc: file, land: pages[i].land, canvas });
    }
    const name = file.replace(/[\/:*?"<>|]+/g, ' ');
    if (fmt === 'preview') wfCapPreview(wfCapPdf(shots), name); else wfCapPdf(shots).save(name + '.pdf');
    msg(out, 'ok', t('lqb.made', { n: shots.length }));
  } catch (e) { msg(out, 'err', e.message); }
  finally { host.remove(); }
}
const aoPdfBtns = (build, file, out) => [
  el('button', { className: 'btn tiny', type: 'button', textContent: '👁 ' + t('ao.pdfPrev'), onclick: () => aoCapture(build, file(), 'preview', out) }),
  el('button', { className: 'btn tiny', type: 'button', textContent: '⬇ ' + t('ao.pdfSave'), onclick: () => aoCapture(build, file(), 'pdf', out) })];

/* ============================================================ TRANSFERS */
const AO_TF_KEYS = { from: 'ao.tf.k.from', to: 'ao.tf.k.to', jvc: 'ao.tf.k.jvc', am: 'ao.tf.k.am', cancel: 'ao.tf.k.cancel' };
const tfActor = s => !!s && (s.roles || []).some(r => wfHasRoleFor(r, s.dept));
const tfCur = t0 => t0.status === 'pending' && t0.cur != null ? (t0.steps || [])[t0.cur] : null;

async function tfLoad() {
  const out = $('#tfMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await wfLookups(); await aoLocs();
    const [rows, inbox] = await Promise.all([SB.select('am_transfer', 'select=*&order=id.desc&limit=500'), SB.rpc('am_tf_inbox').catch(() => [])]);
    const ids = rows.map(r => r.id);
    const lines = [];
    for (let i = 0; i < ids.length; i += 150) lines.push(...await SB.select('am_transfer_line', `select=*&transfer_id=in.(${ids.slice(i, i + 150).join(',')})&order=id`));
    Object.assign(AO.tf, { rows, inbox, lines, assets: await aoAssetsById(lines.map(l => l.asset_id)) });
    if (!inbox.length && AO.tf.tab === 'todo' && !AO.tf.touched) AO.tf.tab = 'all';
    msg(out, AO.tf.flash ? 'ok' : '', AO.tf.flash || ''); AO.tf.flash = null;
    tfRender();
  } catch (e) { $('#tfBody').innerHTML = ''; aoErr(out, e); }
}

function tfRender() {
  const body = $('#tfBody');
  if (!body) return;
  body.innerHTML = '';
  const S = AO.tf, mine = S.rows.filter(r => r.created_by === (ME && ME.id));
  aoTabs($('#tfTabs'), [['todo', t('ao.tf.t.todo'), S.inbox.length], ['mine', t('ao.tf.t.mine'), mine.filter(r => ['draft', 'returned', 'pending'].includes(r.status)).length],
                        ['all', t('ao.tf.t.all'), null]], S.tab, v => { S.tab = v; S.touched = true; S.open = null; tfRender(); });
  if (S.edit) return tfEditor(body);
  if (S.open) { const r = S.rows.find(x => x.id === S.open); if (r) { tfDetail(body, r); } else S.open = null; }
  const q = el('input', { placeholder: t('pm.f.search'), value: S.q, spellcheck: false });
  q.oninput = () => { S.q = q.value; clearTimeout(S.qt); S.qt = setTimeout(tfRender, 250); };
  const add = el('button', { className: 'btn pri', type: 'button', textContent: '+ ' + t('ao.tf.new'), onclick: () => tfNew([]) });
  add.disabled = !aoMyDepts().length;
  body.append(el('div', { className: 'card row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' },
    [aoFld(t('pm.f.search'), q, 'max-width:340px'), el('span', { style: 'flex:1' }), add]));
  let rows = S.tab === 'todo' ? S.inbox : S.tab === 'mine' ? mine : S.rows;
  const qq = hnorm(S.q);
  if (qq) rows = rows.filter(r => hnorm(`${r.no} ${r.from_dept} ${r.to_dept} ${r.to_location} ${r.reason} ${r.created_name}`).includes(qq)
    || S.lines.some(l => l.transfer_id === r.id && hnorm(`${(S.assets.get(l.asset_id) || {}).asset_code} ${l.old_code} ${l.new_code}`).includes(qq)));
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['ao.tf.c.no', 'ao.tf.c.date', 'ao.tf.c.from', 'ao.tf.c.to', 'ao.tf.c.loc', 'ao.tf.c.n', 'ao.tf.c.status', 'ao.tf.c.step', 'ao.tf.c.by']
    .map(k => el('th', { textContent: t(k) })))]);
  for (const r of rows) {
    const s = tfCur(r), n = S.lines.filter(l => l.transfer_id === r.id).length;
    const tr = el('tr', { className: 'aoclick' + (S.open === r.id ? ' sel' : ''), onclick: () => { S.open = S.open === r.id ? null : r.id; tfRender(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, [
      el('td', {}, el('code', { textContent: r.no })), el('td', { textContent: fmtDate(r.tf_date) }),
      el('td', { textContent: pmDeptName(r.from_dept), title: r.from_dept }), el('td', { textContent: pmDeptName(r.to_dept), title: r.to_dept }),
      el('td', { textContent: r.to_location || '' }), el('td', { className: 'num', textContent: fmtInt(n) }),
      el('td', {}, aoChip(r.status)), el('td', { textContent: s ? t(AO_TF_KEYS[s.key] || s.key) : '' }), el('td', { textContent: r.created_name || '' })]);
    tb.append(tr);
  }
  if (!rows.length) tb.append(el('tr', {}, el('td', { colSpan: 9, className: 'dim', style: 'padding:14px', textContent: S.tab === 'todo' ? t('ao.tf.noTodo') : t('lq.none') })));
  body.append(el('div', { className: 'card' }, el('div', { className: 'wrap' }, tb)));
}

// A new slip, optionally with assets already chosen (from the asset panel).
function tfNew(assets) {
  const depts = aoMyDepts();
  const from = (assets[0] && assets[0].dept_code) || depts[0];
  AO.tf.edit = { id: null, from_dept: from, to_dept: from, to_location: '', tf_date: aoToday(), reason: '',
                 lines: assets.map(a => ({ asset_id: a.id, qty: null, a })) };
  if (VIEW !== 'transfer') showView('transfer'); else tfRender();
}
function tfEdit(r) {
  AO.tf.edit = { id: r.id, from_dept: r.from_dept, to_dept: r.to_dept, to_location: r.to_location || '', tf_date: r.tf_date, reason: r.reason || '',
                 lines: AO.tf.lines.filter(l => l.transfer_id === r.id).map(l => ({ asset_id: l.asset_id, qty: l.qty, note: l.note, a: AO.tf.assets.get(l.asset_id) || { id: l.asset_id } })) };
  tfRender();
}

function tfEditor(body) {
  const E = AO.tf.edit, out = el('div');
  const from = el('select'), to = el('select'), loc = el('select'), date = el('input', { type: 'date', value: E.tf_date || aoToday() });
  const reason = el('textarea', { rows: 2, value: E.reason || '' });
  selFill(from, aoMyDepts().map(aoDeptOpt)); from.value = E.from_dept || ''; from.disabled = !!E.id || E.lines.length > 0;
  selFill(to, aoDepts().map(aoDeptOpt)); to.value = E.to_dept || E.from_dept || '';
  const locFill = () => selFill(loc, [['', t('ao.tf.keepLoc')], ...(AO_LOC || []).filter(l => l.active !== false && (!l.dept_code || l.dept_code === to.value))
    .map(l => [l.code, `${l.code} — ${l.name}`])]);
  locFill(); loc.value = E.to_location || '';
  const keep = () => Object.assign(E, { from_dept: from.value, to_dept: to.value, to_location: loc.value, tf_date: date.value, reason: reason.value });
  from.onchange = () => { keep(); tfRender(); };
  to.onchange = () => { keep(); locFill(); };
  loc.onchange = date.onchange = reason.onchange = keep;
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['ao.c.code', 'ao.c.name', 'ao.c.loc', 'ao.c.qtyBook', 'ao.tf.c.qty', ''].map(k => el('th', { textContent: k ? t(k) : '' })))]);
  E.lines.forEach((l, i) => {
    const a = l.a || {};
    const q = a.asset_kind === 'low' ? el('input', { className: 'aoqty', inputMode: 'decimal', value: l.qty != null ? fmtNum(l.qty) : '', placeholder: fmtNum(a.qty) }) : el('span', { textContent: '1' });
    if (a.asset_kind === 'low') q.onchange = () => { l.qty = q.value.trim() ? numIn(q.value) : null; };
    tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: a.asset_code || '#' + l.asset_id })), el('td', { textContent: aoName(a) }),
      el('td', { textContent: a.location_code || '' }), el('td', { className: 'num', textContent: `${fmtNum(a.qty)} ${a.unit_code || ''}` }), el('td', {}, q),
      el('td', {}, el('button', { className: 'btn tiny', type: 'button', textContent: '✕', onclick: () => { keep(); E.lines.splice(i, 1); tfRender(); } }))]));
  });
  if (!E.lines.length) tb.append(el('tr', {}, el('td', { colSpan: 6, className: 'dim', style: 'padding:10px', textContent: t('ao.tf.noLines') })));
  const picker = aoPicker({ dept: () => from.value, filter: a => !['0', '7', '9', '23'].includes(String(a.status_code || '')),
    onPick: a => { keep(); if (!E.lines.some(l => l.asset_id === a.id)) E.lines.push({ asset_id: a.id, qty: null, a }); tfRender(); } });
  const data = () => { keep(); return { from_dept: E.from_dept, to_dept: E.to_dept, to_location: E.to_location, tf_date: E.tf_date, reason: E.reason,
                                        lines: E.lines.map(l => ({ asset_id: l.asset_id, qty: l.qty, note: l.note || null })) }; };
  const save = async submit => {
    try {
      const id = await SB.rpc('am_tf_save', { p_id: E.id, p_data: data() });
      if (submit) await SB.rpc('am_tf_submit', { p_id: id });
      AO.tf.edit = null; AO.tf.open = id; AO.tf.tab = 'all';
      AO.tf.flash = t(submit ? 'ao.tf.sent' : 'ao.tf.saved');
      await tfLoad(); wfBadge();
    } catch (e) { aoErr(out, e); }
  };
  body.append(el('div', { className: 'card' }, [
    el('h2', { textContent: E.id ? t('ao.tf.editH') : t('ao.tf.newH') }),
    el('div', { className: 'row', style: 'gap:12px;flex-wrap:wrap;align-items:flex-end' }, [
      aoFld(t('ao.tf.c.from'), from, 'max-width:260px'), aoFld(t('ao.tf.c.to'), to, 'max-width:260px'), aoFld(t('ao.tf.c.loc'), loc, 'max-width:280px'),
      aoFld(t('ao.tf.c.date'), date, 'max-width:170px')]),
    aoFld(t('ao.tf.c.reason'), reason),
    el('div', { className: 'tdnote', textContent: t('ao.tf.hint') }),
    el('h3', { textContent: t('ao.tf.linesH') }), picker, el('div', { className: 'wrap' }, tb), out,
    el('div', { className: 'row', style: 'gap:8px;margin-top:10px' }, [
      el('button', { className: 'btn', type: 'button', textContent: t('ao.saveDraft'), onclick: () => save(false) }),
      el('button', { className: 'btn pri', type: 'button', textContent: t('ao.tf.submit'), onclick: () => save(true) }),
      el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: () => { AO.tf.edit = null; tfRender(); } })])]));
}

function tfDetail(body, r) {
  const S = AO.tf, lines = S.lines.filter(l => l.transfer_id === r.id), s = tfCur(r), out = el('div');
  const isMine = ME && r.created_by === ME.id;
  const act = async (action) => {
    let c = null;
    if (action !== 'approve') { c = prompt(t('ao.tf.why')); if (!c) return; }
    try {
      const res = await SB.rpc('am_tf_act', { p_id: r.id, p_action: action, p_comment: c });
      S.flash = res && res.status === 'done' ? t('ao.tf.doneMsg', { n: res.relabel || 0 }) : t('ao.tf.acted');
      await tfLoad(); wfBadge();
    } catch (e) { aoErr(out, e); }
  };
  const btns = [];
  if (['draft', 'returned'].includes(r.status) && (isMine || can('assets', 'edit'))) {
    btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.edit'), onclick: () => tfEdit(r) }),
              el('button', { className: 'btn pri', type: 'button', textContent: t('ao.tf.submit'), onclick: async () => {
                try { await SB.rpc('am_tf_submit', { p_id: r.id }); S.flash = t('ao.tf.sent'); await tfLoad(); wfBadge(); } catch (e) { aoErr(out, e); } } }));
  }
  if (s && tfActor(s)) btns.push(el('button', { className: 'btn pri', type: 'button', textContent: t(s.key === 'am' ? 'ao.tf.confirm' : s.key === 'to' ? 'ao.tf.receive' : 'ao.tf.approve'), onclick: () => act('approve') }),
                                 el('button', { className: 'btn', type: 'button', textContent: t('ao.tf.return'), onclick: () => act('return') }),
                                 el('button', { className: 'btn', type: 'button', textContent: t('ao.tf.reject'), onclick: () => act('reject') }));
  if (['draft', 'returned', 'pending'].includes(r.status) && (isMine || can('assets', 'admin')))
    btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.tf.cancel'), onclick: async () => {
      const c = prompt(t('ao.tf.whyCancel')); if (c == null) return;
      try { await SB.rpc('am_tf_cancel', { p_id: r.id, p_comment: c || null }); await tfLoad(); } catch (e) { aoErr(out, e); } } }));
  btns.push(...aoPdfBtns(() => tfForm(r, lines), () => `${r.no} - ${t('ao.tf.formName')}`, out));
  // The chain: who signed, who is next.
  const chain = el('div', { className: 'aochain' }, (r.steps || []).filter(x => x.key !== 'cancel').map((x, i) => el('div', {
    className: 'aostep' + (x.action === 'approve' ? ' ok' : x.action === 'return' || x.action === 'reject' ? ' bad' : r.cur === i && r.status === 'pending' ? ' now' : '') }, [
    el('b', { textContent: t(AO_TF_KEYS[x.key] || x.key) }),
    el('small', { textContent: (x.roles || []).map(wfRoleName).join(' / ') + (x.dept ? ` · ${x.dept}` : '') }),
    x.name ? el('div', { textContent: `${x.action === 'approve' ? '✓' : '✗'} ${x.name} · ${fmtDateTime(x.at)}` }) : '',
    x.comment ? el('i', { textContent: '“' + x.comment + '”' }) : ''])));
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['ao.c.code', 'ao.tf.c.newCode', 'ao.c.name', 'ao.c.loc', 'ao.tf.c.qty'].map(k => el('th', { textContent: t(k) })))]);
  for (const l of lines) {
    const a = S.assets.get(l.asset_id) || {};
    tb.append(el('tr', {}, [el('td', {}, el('code', { textContent: l.old_code || a.asset_code || '' })), el('td', {}, l.new_code && l.new_code !== l.old_code ? el('code', { textContent: l.new_code }) : ''),
      el('td', { textContent: aoName(a) }), el('td', { textContent: a.location_code || '' }),
      el('td', { className: 'num', textContent: a.asset_kind === 'low' ? `${fmtNum(l.qty != null ? l.qty : a.qty)} / ${fmtNum(a.qty)}` : '1' })]));
  }
  body.append(el('div', { className: 'card aodet' }, [
    el('div', { className: 'chead' }, [el('h2', { textContent: `${r.no} — ${t('ao.tf.formName')}` }), aoChip(r.status),
      el('button', { className: 'dbtn', type: 'button', textContent: '✕', onclick: () => { AO.tf.open = null; tfRender(); } })]),
    el('dl', { className: 'aodl' }, [
      el('dt', { textContent: t('ao.tf.c.from') }), el('dd', { textContent: `${r.from_dept} — ${pmDeptName(r.from_dept)}` }),
      el('dt', { textContent: t('ao.tf.c.to') }), el('dd', { textContent: `${r.to_dept} — ${pmDeptName(r.to_dept)}${r.to_location ? ' · ' + r.to_location : ''}` }),
      el('dt', { textContent: t('ao.tf.c.date') }), el('dd', { textContent: fmtDate(r.tf_date) }),
      el('dt', { textContent: t('ao.tf.c.reason') }), el('dd', { textContent: r.reason || '' }),
      el('dt', { textContent: t('ao.tf.c.by') }), el('dd', { textContent: `${r.created_name || ''} · ${fmtDateTime(r.created_at)}` })]),
    r.status === 'done' && r.relabel ? el('div', { className: 'msg warn' }, [document.createTextNode(t('ao.tf.relabel', { n: r.relabel }) + ' '),
      el('a', { href: '#', textContent: t('nav.alr') + ' ›', onclick: e => { e.preventDefault(); showView('alr'); } })]) : '',
    r.to_dept !== r.from_dept && r.status !== 'done' ? el('div', { className: 'tdnote', textContent: t('ao.tf.recodeNote') }) : '',
    chain, el('div', { className: 'wrap' }, tb), out, el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:10px' }, btns)]));
}

// The slip: A4 portrait, the lines, the signatures of the chain.
function tfForm(r, lines) {
  const S = AO.tf, A = id => S.assets.get(id) || {};
  const st = k => (r.steps || []).find(x => x.key === k) || null;
  const nm = k => { const x = st(k); return x && x.action === 'approve' ? String(x.name || '').toUpperCase() : ''; };
  const cols = [['STT / No.', (x, i) => i + 1, 'c', '6%'], ['Mã tài sản / Asset code', x => x.old_code || A(x.asset_id).asset_code || '', '', '22%'],
    ['Mã mới / New code', x => x.new_code && x.new_code !== x.old_code ? x.new_code : '', '', '20%'], ['Tên tài sản / Asset name', x => aoName(A(x.asset_id)), '', '28%'],
    ['ĐVT / Unit', x => A(x.asset_id).unit_code || '', 'c', '8%'], ['SL / Qty', x => fmtNum(x.qty != null ? x.qty : (A(x.asset_id).asset_kind === 'low' ? A(x.asset_id).qty : 1)), 'n', '8%'],
    ['Vị trí cũ / From', x => A(x.asset_id).location_code || '', 'c', '8%']];
  const head = [lqbHead(null, 'PHIẾU ĐIỀU CHUYỂN TÀI SẢN', 'ASSET TRANSFER FORM', r.no, r.tf_date),
    lqbBi(`Bên giao: ${r.from_dept} — ${pmDeptName(r.from_dept)}`, `From: ${r.from_dept}`),
    lqbBi(`Bên nhận: ${r.to_dept} — ${pmDeptName(r.to_dept)}${r.to_location ? ' · Vị trí: ' + r.to_location : ''}`, `To: ${r.to_dept}${r.to_location ? ' · Location: ' + r.to_location : ''}`),
    lqbBi(`Lý do điều chuyển: ${r.reason || '…………'}`, 'Reason for transfer'),
    lqbBi(`Danh sách tài sản (${lines.length} dòng):`, `Assets transferred (${lines.length} line(s)):`)];
  const boxes = [['Người lập', 'Prepared by', String(r.created_name || '').toUpperCase()], ['Bên giao', 'Handed over by', nm('from')]];
  if (st('to')) boxes.push(['Bên nhận', 'Received by', nm('to')]);
  if (st('jvc')) boxes.push(['TGĐ JVC', 'JVC General Manager', nm('jvc')]);
  boxes.push(['QLTS xác nhận', 'Asset Management', nm('am')]);
  return lqbPages(false, head, lines, (rows, at) => lqbTable(cols, rows, { start: at }), [lqbSigns(boxes)], 16, 32);
}

// To-do list rows: slips waiting for me, and my slips sent back.
async function aoTodos() {
  if (!ME || !can('assets', 'view')) return [];
  const [inbox, back] = await Promise.all([SB.rpc('am_tf_inbox'), SB.select('am_transfer', `select=*&status=eq.returned&created_by=eq.${ME.id}`)]);
  const row = (r, kind) => { const s = tfCur(r) || {};
    return { kind, tf_id: r.id, doc_no: r.no, project_code: '', project_name: `${t('ao.tf.docName')} · ${r.from_dept} → ${r.to_dept}`,
             dept_code: r.from_dept, submitted_at: r.submitted_at || r.created_at, role_code: (s.roles || [])[0], step: r.cur != null ? r.cur + 1 : null }; };
  return [...inbox.map(r => row(r, 'tf')), ...back.map(r => row(r, 'tfret'))];
}
function aoOpenTransfer(id) { AO.tf.open = id; AO.tf.tab = 'all'; AO.tf.edit = null; showView('transfer'); }

/* ============================================================ INCIDENTS */
const AO_INC_KINDS = ['repair', 'maintenance', 'breakage', 'loss'];
const AO_INC_OUT = ['fixed', 'no_fault', 'replace', 'liquidate', 'lost'];

async function incLoad() {
  const out = $('#incMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    const rows = await SB.select('am_incident', 'select=*&order=id.desc&limit=1000');
    Object.assign(AO.inc, { rows, assets: await aoAssetsById(rows.map(r => r.asset_id)) });
    msg(out, AO.inc.flash ? 'ok' : '', AO.inc.flash || ''); AO.inc.flash = null;
    incRender();
  } catch (e) { $('#incBody').innerHTML = ''; aoErr(out, e); }
}
function incNew(asset) {
  AO.inc.draft = { asset: asset || null, kind: 'repair', reported_at: aoToday() };
  if (VIEW !== 'incident') showView('incident'); else incRender();
}
function incRender() {
  const body = $('#incBody');
  if (!body) return;
  body.innerHTML = '';
  const S = AO.inc, open = S.rows.filter(r => ['open', 'in_progress'].includes(r.status));
  aoTabs($('#incTabs'), [['open', t('ao.inc.t.open'), open.length], ['closed', t('ao.inc.t.closed'), null], ['all', t('ao.inc.t.all'), null]],
    S.tab, v => { S.tab = v; S.open = null; incRender(); });
  if (S.draft) incForm(body);
  if (S.open) { const r = S.rows.find(x => x.id === S.open); if (r) incDetail(body, r); else S.open = null; }
  const q = el('input', { placeholder: t('pm.f.search'), value: S.q, spellcheck: false });
  q.oninput = () => { S.q = q.value; clearTimeout(S.qt); S.qt = setTimeout(incRender, 250); };
  const kind = el('select'); selFill(kind, [['', t('pm.f.all')], ...AO_INC_KINDS.map(k => [k, t('ao.inc.k.' + k)])]); kind.value = S.kind || '';
  kind.onchange = () => { S.kind = kind.value; incRender(); };
  body.append(el('div', { className: 'card row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' }, [
    aoFld(t('pm.f.search'), q, 'max-width:320px'), aoFld(t('ao.inc.c.kind'), kind, 'max-width:200px'), el('span', { style: 'flex:1' }),
    el('button', { className: 'btn', type: 'button', textContent: t('lq.xlsx'), onclick: incXlsx }),
    el('button', { className: 'btn pri', type: 'button', textContent: '+ ' + t('ao.inc.new'), onclick: () => incNew(null) })]));
  let rows = S.tab === 'open' ? open : S.tab === 'closed' ? S.rows.filter(r => ['closed', 'cancelled'].includes(r.status)) : S.rows;
  if (S.kind) rows = rows.filter(r => r.kind === S.kind);
  const qq = hnorm(S.q);
  if (qq) rows = rows.filter(r => { const a = S.assets.get(r.asset_id) || {}; return hnorm(`${r.no} ${a.asset_code} ${a.barcode} ${aoName(a)} ${r.description} ${r.wo_no} ${r.vendor} ${r.dept_code}`).includes(qq); });
  S.shown = rows;
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['ao.inc.c.no', 'ao.inc.c.date', 'ao.c.code', 'ao.c.name', 'pm.col.dept', 'ao.inc.c.kind', 'ao.inc.c.desc',
    'ao.inc.c.status', 'ao.inc.c.wo', 'ao.inc.c.cost', 'ao.inc.c.outcome'].map(k => el('th', { textContent: t(k), className: k === 'ao.inc.c.cost' ? 'num' : '' })))]);
  for (const r of rows) {
    const a = S.assets.get(r.asset_id) || {};
    tb.append(el('tr', { className: 'aoclick' + (S.open === r.id ? ' sel' : ''), onclick: () => { S.open = S.open === r.id ? null : r.id; S.draft = null; incRender(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, [
      el('td', {}, el('code', { textContent: r.no || '#' + r.id })), el('td', { textContent: fmtDate(r.reported_at) }),
      el('td', {}, el('code', { textContent: a.asset_code || '' })), el('td', { textContent: aoName(a) }), el('td', { textContent: r.dept_code || '' }),
      el('td', { textContent: t('ao.inc.k.' + r.kind) + (r.qty != null ? ` · ${fmtNum(r.qty)}` : '') }), el('td', { className: 'aowrap', textContent: r.description || '' }),
      el('td', {}, aoChip(r.status, 'inc')), el('td', { textContent: [r.wo_no, r.vendor].filter(Boolean).join(' · ') }),
      el('td', { className: 'num', textContent: r.cost != null ? lqN(r.cost) : '' }), el('td', { textContent: r.outcome ? t('ao.inc.o.' + r.outcome) : '' })]));
  }
  if (!rows.length) tb.append(el('tr', {}, el('td', { colSpan: 11, className: 'dim', style: 'padding:14px', textContent: t('lq.none') })));
  body.append(el('div', { className: 'card' }, el('div', { className: 'wrap' }, tb)));
}

function incForm(body) {
  const D = AO.inc.draft, out = el('div');
  const kind = el('select'); selFill(kind, AO_INC_KINDS.map(k => [k, t('ao.inc.k.' + k)])); kind.value = D.kind;
  const date = el('input', { type: 'date', value: D.reported_at });
  const qty = el('input', { className: 'aoqty', inputMode: 'decimal', placeholder: D.asset ? fmtNum(D.asset.qty) : '' });
  const desc = el('textarea', { rows: 2, placeholder: t('ao.inc.descPh') }), cause = el('input'), wo = el('input'), vendor = el('input');
  const warr = el('input', { type: 'checkbox' });
  const who = el('div', { className: 'aowho' });
  const showAsset = () => {
    who.innerHTML = '';
    if (!D.asset) return;
    const a = D.asset, w = a.warranty_until && a.warranty_until >= aoToday();
    warr.checked = !!w;
    who.append(el('code', { textContent: a.asset_code }), document.createTextNode(' ' + aoName(a) + ' · ' + [a.dept_code, a.location_code, amStatusLabel(a.status_code)].filter(Boolean).join(' · ')),
      a.warranty_until ? el('div', { className: w ? 'aook' : 'dim', textContent: t(w ? 'ao.inc.inWarranty' : 'ao.inc.outWarranty', { d: fmtDate(a.warranty_until) }) }) : '');
    qty.hidden = a.asset_kind !== 'low';
  };
  const picker = aoPicker({ filter: a => !['0', '7', '9', '23'].includes(String(a.status_code || '')), onPick: async a => {
    try { const [w] = await SB.select('am_asset', `select=warranty_until&id=eq.${a.id}`); a.warranty_until = w && w.warranty_until; } catch {}
    D.asset = a; showAsset(); } });
  showAsset();
  const save = async () => {
    if (!D.asset) return msg(out, 'err', t('ao.inc.pickFirst'));
    try {
      await SB.rpc('am_inc_report', { p_data: { asset_id: D.asset.id, kind: kind.value, qty: qty.value.trim() ? numIn(qty.value) : null, reported_at: date.value,
        description: desc.value.trim(), cause: cause.value.trim() || null, wo_no: wo.value.trim() || null, vendor: vendor.value.trim() || null, warranty: warr.checked } });
      AO.inc.draft = null; AO.inc.tab = 'open'; AO.inc.flash = t('ao.inc.reported');
      await incLoad();
    } catch (e) { aoErr(out, e); }
  };
  body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('ao.inc.newH') }),
    el('div', { className: 'tdnote', textContent: t('ao.inc.hint') }), picker, who,
    el('div', { className: 'row', style: 'gap:12px;flex-wrap:wrap;align-items:flex-end' }, [
      aoFld(t('ao.inc.c.kind'), kind, 'max-width:220px'), aoFld(t('ao.inc.c.date'), date, 'max-width:170px'), aoFld(t('ao.inc.c.qty'), qty, 'max-width:130px'),
      aoFld(t('ao.inc.c.wo'), wo, 'max-width:170px'), aoFld(t('ao.inc.c.vendor'), vendor, 'max-width:240px'),
      el('label', { className: 'chk' }, [warr, el('span', { textContent: t('ao.inc.c.warranty') })])]),
    aoFld(t('ao.inc.c.desc'), desc), aoFld(t('ao.inc.c.cause'), cause), out,
    el('div', { className: 'row', style: 'gap:8px;margin-top:8px' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('ao.inc.send'), onclick: save }),
      el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: () => { AO.inc.draft = null; incRender(); } })])]));
}

function incDetail(body, r) {
  const a = AO.inc.assets.get(r.asset_id) || {}, out = el('div'), edit = can('assets', 'edit');
  const live = ['open', 'in_progress'].includes(r.status);
  const mayEdit = live && (edit || (ME && r.created_by === ME.id && r.status === 'open'));
  const inp = (k, v, attrs = {}) => { const i = el('input', Object.assign({ value: v ?? '', disabled: !mayEdit }, attrs)); i.dataset.k = k; return i; };
  const wo = inp('wo_no', r.wo_no), vendor = inp('vendor', r.vendor), cost = inp('cost', r.cost != null ? fmtNum(r.cost) : '', { inputMode: 'decimal' });
  const cause = inp('cause', r.cause), desc = el('textarea', { rows: 2, value: r.description || '', disabled: !mayEdit });
  const warr = el('input', { type: 'checkbox', checked: !!r.warranty, disabled: !mayEdit });
  const upd = async extra => {
    try {
      await SB.rpc('am_inc_update', { p_id: r.id, p_data: Object.assign({ wo_no: wo.value.trim() || null, vendor: vendor.value.trim() || null,
        cost: cost.value.trim() ? numIn(cost.value) : null, cause: cause.value.trim() || null, description: desc.value.trim(), warranty: warr.checked }, extra || {}) });
      AO.inc.flash = t('ao.saved'); await incLoad();
    } catch (e) { aoErr(out, e); }
  };
  const btns = [];
  if (mayEdit) btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.save'), onclick: () => upd() }));
  if (edit && r.status === 'open') btns.push(el('button', { className: 'btn pri', type: 'button', textContent: t('ao.inc.start'), onclick: () => upd({ start: true }) }));
  if (edit && live) {
    const oc = el('select'); selFill(oc, AO_INC_OUT.map(k => [k, t('ao.inc.o.' + k)]));
    oc.value = r.kind === 'loss' ? 'lost' : 'fixed';
    const note = el('input', { placeholder: t('ao.inc.outNote') });
    btns.push(el('span', { className: 'aosep' }), oc, note, el('button', { className: 'btn pri', type: 'button', textContent: t('ao.inc.close'), onclick: async () => {
      if (oc.value === 'lost' && !confirm(t('ao.inc.lostQ', { c: a.asset_code }))) return;
      try { await SB.rpc('am_inc_close', { p_id: r.id, p_outcome: oc.value, p_note: note.value.trim() || null, p_cost: cost.value.trim() ? numIn(cost.value) : null });
            AO.inc.flash = t('ao.inc.closed'); await incLoad(); } catch (e) { aoErr(out, e); } } }));
  }
  if (live && (edit || (ME && r.created_by === ME.id && r.status === 'open')))
    btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.inc.cancel'), onclick: async () => {
      const c = prompt(t('ao.tf.whyCancel')); if (c == null) return;
      try { await SB.rpc('am_inc_cancel', { p_id: r.id, p_note: c || null }); await incLoad(); } catch (e) { aoErr(out, e); } } }));
  // Beyond repair / to replace: the next step is a liquidation request.
  if (r.status === 'closed' && ['replace', 'liquidate'].includes(r.outcome) && !r.lr_doc_no && can('liquidation', 'create'))
    btns.push(el('button', { className: 'btn pri', type: 'button', textContent: t('ao.inc.toLr'), onclick: () => aoToLr(r.asset_id, out) }));
  btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.openAsset'), onclick: () => aoAsset(r.asset_id) }));
  body.append(el('div', { className: 'card aodet' }, [
    el('div', { className: 'chead' }, [el('h2', { textContent: `${r.no || '#' + r.id} — ${t('ao.inc.k.' + r.kind)}` }), aoChip(r.status, 'inc'),
      el('button', { className: 'dbtn', type: 'button', textContent: '✕', onclick: () => { AO.inc.open = null; incRender(); } })]),
    el('div', { className: 'aowho' }, [el('code', { textContent: a.asset_code || '' }), document.createTextNode(' ' + aoName(a) + ' · ' +
      [a.dept_code, a.location_code, amStatusLabel(a.status_code)].filter(Boolean).join(' · ') + (r.qty != null ? ` · ${t('ao.inc.c.qty')}: ${fmtNum(r.qty)}` : ''))]),
    el('div', { className: 'dim', textContent: `${t('ao.inc.by')}: ${r.created_name || ''} · ${fmtDate(r.reported_at)}` +
      (r.started_at ? ` · ${t('ao.inc.startedAt')}: ${fmtDateTime(r.started_at)}` : '') + (r.closed_at ? ` · ${t('ao.inc.closedAt')}: ${fmtDateTime(r.closed_at)} (${r.closed_name || ''})` : '') }),
    r.outcome ? el('div', { className: 'msg ' + (r.outcome === 'lost' ? 'warn' : 'ok'), textContent: `${t('ao.inc.c.outcome')}: ${t('ao.inc.o.' + r.outcome)}${r.outcome_note ? ' — ' + r.outcome_note : ''}${r.lr_doc_no ? ' · LR ' + r.lr_doc_no : ''}` }) : '',
    el('div', { className: 'row', style: 'gap:12px;flex-wrap:wrap;align-items:flex-end' }, [
      aoFld(t('ao.inc.c.wo'), wo, 'max-width:170px'), aoFld(t('ao.inc.c.vendor'), vendor, 'max-width:240px'), aoFld(t('ao.inc.c.cost'), cost, 'max-width:170px'),
      el('label', { className: 'chk' }, [warr, el('span', { textContent: t('ao.inc.c.warranty') })])]),
    aoFld(t('ao.inc.c.desc'), desc), aoFld(t('ao.inc.c.cause'), cause), out,
    el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center' }, btns)]));
}

function incXlsx() {
  const rows = (AO.inc.shown || []).map(r => { const a = AO.inc.assets.get(r.asset_id) || {};
    return { [t('ao.inc.c.no')]: r.no, [t('ao.inc.c.date')]: r.reported_at, [t('ao.c.code')]: a.asset_code, [t('ao.c.name')]: aoName(a), [t('pm.col.dept')]: r.dept_code,
             [t('ao.inc.c.kind')]: t('ao.inc.k.' + r.kind), [t('ao.inc.c.qty')]: r.qty, [t('ao.inc.c.desc')]: r.description, [t('ao.inc.c.cause')]: r.cause,
             [t('ao.inc.c.status')]: t('ao.inc.st.' + r.status), [t('ao.inc.c.wo')]: r.wo_no, [t('ao.inc.c.vendor')]: r.vendor, [t('ao.inc.c.warranty')]: r.warranty ? '✓' : '',
             [t('ao.inc.c.cost')]: r.cost != null ? Number(r.cost) : null, [t('ao.inc.c.outcome')]: r.outcome ? t('ao.inc.o.' + r.outcome) : '', LR: r.lr_doc_no }; });
  if (!rows.length) return msg('#incMsg', 'warn', t('lq.none'));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Su co');
  const file = `phcl-su-co-${bkStamp()}.xlsx`; XLSX.writeFile(wb, file); msg('#incMsg', 'ok', t('lq.exported', { file }));
}

// An asset beyond repair (or found lost) → a new LR with it, on the liquidation screen.
async function aoToLr(assetId, out) {
  try {
    const [a] = await lqFinSelect('id,asset_code,barcode,name_vi,name_en,unit_code,unit_price,qty,dept_code,location_code,in_use_date,purchase_date,asset_kind,status_code', `&id=eq.${assetId}`);
    if (!a) throw new Error(t('ao.pickNone'));
    showView('liq');
    setTimeout(() => { try { lqNewForm([a]); } catch (e) { msg('#lqMsg', 'err', e.message); } }, 700);
  } catch (e) { msg(out, 'err', e.message); }
}

/* ============================================================ STOCK-TAKE */
const AO_KK_FILTERS = ['all', 'pending', 'found', 'missing', 'moved', 'short', 'damaged', 'extra'];
const kkState = l => l.found == null ? 'pending' : l.found === false ? 'missing' : l.extra ? 'extra'
  : l.cond === 'damaged' ? 'damaged' : l.kind === 'low' && n0(l.qty_found) < n0(l.qty_book) ? 'short' : l.loc_found && l.loc_found !== l.loc_book ? 'moved' : 'found';
const kkMatch = (l, f) => f === 'all' || (f === 'extra' ? l.extra : f === 'moved' ? (l.found && !l.extra && l.loc_found && l.loc_found !== l.loc_book) : f === 'damaged' ? l.found && l.cond === 'damaged'
  : f === 'short' ? l.found && !l.extra && l.kind === 'low' && n0(l.qty_found) < n0(l.qty_book) : f === 'found' ? l.found && !l.extra : f === 'missing' ? l.found === false : l.found == null);

async function kkLoad() {
  const out = $('#kkMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups(); await aoLocs();
    AO.kk.rows = await SB.select('am_count', 'select=*&order=id.desc');
    if (AO.kk.open) AO.kk.lines = await pmSelectAll('am_count_line', `select=*&count_id=eq.${AO.kk.open}&order=id`);
    msg(out, AO.kk.flash ? 'ok' : '', AO.kk.flash || ''); AO.kk.flash = null;
    kkRender();
  } catch (e) { $('#kkBody').innerHTML = ''; aoErr(out, e); }
}
async function kkOpen(id) { AO.kk.open = id; AO.kk.filter = 'all'; await kkLoad(); }

function kkRender() {
  const body = $('#kkBody');
  if (!body) return;
  body.innerHTML = '';
  const S = AO.kk, edit = can('assets', 'edit');
  if (S.edit) return kkEditor(body);
  const c = S.open && S.rows.find(x => x.id === S.open);
  if (c) return kkDetail(body, c);
  S.open = null;
  body.append(el('div', { className: 'card row', style: 'gap:10px;align-items:center;flex-wrap:wrap' }, [
    el('div', { className: 'tdnote', style: 'flex:1', textContent: t('ao.kk.hint') }),
    edit ? el('button', { className: 'btn pri', type: 'button', textContent: '+ ' + t('ao.kk.new'), onclick: () => {
      S.edit = { id: null, title: '', depts: [], locations: [], count_date: aoToday(), members: [{ name: '', position: '' }], note: '' }; kkRender(); } }) : '']));
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['ao.kk.c.code', 'ao.kk.c.title', 'ao.kk.c.depts', 'ao.kk.c.date', 'ao.kk.c.status', 'ao.kk.c.result'].map(k => el('th', { textContent: t(k) })))]);
  for (const r of S.rows) {
    const s = r.summary || {};
    tb.append(el('tr', { className: 'aoclick', onclick: () => kkOpen(r.id) }, [el('td', {}, el('code', { textContent: r.code })), el('td', { textContent: r.title || '' }),
      el('td', { textContent: (r.depts || []).join(', ') + (r.locations && r.locations.length ? ` · ${r.locations.length} ${t('ao.kk.locs')}` : '') }),
      el('td', { textContent: fmtDate(r.count_date) }), el('td', {}, aoChip(r.status, 'kk')),
      el('td', { textContent: r.summary ? t('ao.kk.sum', { f: fmtInt(s.found || 0), t: fmtInt(s.total || 0), m: fmtInt(s.missing || 0), x: fmtInt(s.extra || 0) }) : '' })]));
  }
  if (!S.rows.length) tb.append(el('tr', {}, el('td', { colSpan: 6, className: 'dim', style: 'padding:14px', textContent: t('ao.kk.none') })));
  body.append(el('div', { className: 'card' }, el('div', { className: 'wrap' }, tb)));
}

function kkEditor(body) {
  const E = AO.kk.edit, out = el('div');
  const title = el('input', { value: E.title || '', placeholder: t('ao.kk.titlePh') }), date = el('input', { type: 'date', value: E.count_date });
  const note = el('textarea', { rows: 2, value: E.note || '' });
  const keep = () => Object.assign(E, { title: title.value, count_date: date.value, note: note.value });
  const depts = el('div', { className: 'aochecks' }, aoMyDepts().map(d => { const cb = el('input', { type: 'checkbox', checked: E.depts.includes(d) });
    cb.onchange = () => { keep(); E.depts = cb.checked ? [...E.depts, d] : E.depts.filter(x => x !== d); E.locations = E.locations.filter(x => (AO_LOC.find(l => l.code === x) || {}).dept_code && E.depts.includes(AO_LOC.find(l => l.code === x).dept_code)); kkRender(); };
    return el('label', { className: 'chk' }, [cb, el('span', { textContent: `${d} — ${pmDeptName(d)}` })]); }));
  const locs = (AO_LOC || []).filter(l => l.active !== false && E.depts.includes(l.dept_code));
  const locBox = el('div', { className: 'aochecks' }, locs.map(l => { const cb = el('input', { type: 'checkbox', checked: E.locations.includes(l.code) });
    cb.onchange = () => { keep(); E.locations = cb.checked ? [...E.locations, l.code] : E.locations.filter(x => x !== l.code); };
    return el('label', { className: 'chk' }, [cb, el('span', { textContent: `${l.code} — ${l.name}` })]); }));
  const mem = el('div', {}, E.members.map((m, i) => { const n = el('input', { value: m.name || '', placeholder: t('ao.kk.mName') }), p = el('input', { value: m.position || '', placeholder: t('ao.kk.mPos') });
    n.onchange = () => { m.name = n.value; }; p.onchange = () => { m.position = p.value; };
    return el('div', { className: 'row', style: 'gap:8px;margin-bottom:6px' }, [n, p, el('button', { className: 'btn tiny', type: 'button', textContent: '✕', onclick: () => { keep(); E.members.splice(i, 1); kkRender(); } })]); }));
  const save = async () => {
    keep();
    try {
      const id = await SB.rpc('am_count_save', { p_id: E.id, p_data: { title: E.title, depts: E.depts, locations: E.locations, count_date: E.count_date,
        members: E.members.filter(m => (m.name || '').trim()), note: E.note } });
      AO.kk.edit = null; AO.kk.flash = t('ao.saved'); await kkOpen(id);
    } catch (e) { aoErr(out, e); }
  };
  body.append(el('div', { className: 'card' }, [el('h2', { textContent: E.id ? t('ao.kk.editH') : t('ao.kk.newH') }),
    el('div', { className: 'row', style: 'gap:12px;flex-wrap:wrap;align-items:flex-end' }, [aoFld(t('ao.kk.c.title'), title, 'min-width:280px;flex:1'), aoFld(t('ao.kk.c.date'), date, 'max-width:170px')]),
    el('h3', { textContent: t('ao.kk.c.depts') }), depts,
    el('h3', { textContent: t('ao.kk.locsH') }), el('div', { className: 'tdnote', textContent: t('ao.kk.locsHint') }), locs.length ? locBox : el('div', { className: 'dim', textContent: '—' }),
    el('h3', { textContent: t('ao.kk.membersH') }), mem,
    el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('ao.kk.addMember'), onclick: () => { keep(); E.members.push({ name: '', position: '' }); kkRender(); } }),
    aoFld(t('ao.kk.c.note'), note), out,
    el('div', { className: 'row', style: 'gap:8px;margin-top:10px' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('ao.save'), onclick: save }),
      el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: () => { AO.kk.edit = null; kkRender(); } })])]));
}

function kkDetail(body, c) {
  const S = AO.kk, edit = can('assets', 'edit'), out = el('div'), L = S.lines.filter(l => l.count_id === c.id);
  const own = L.filter(l => !l.extra), done = own.filter(l => l.found != null).length;
  const btns = [el('button', { className: 'btn', type: 'button', textContent: '‹ ' + t('ao.kk.back'), onclick: () => { S.open = null; kkRender(); } })];
  if (edit && c.status === 'draft') btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.edit'), onclick: () => {
      S.edit = { id: c.id, title: c.title, depts: c.depts || [], locations: c.locations || [], count_date: c.count_date, members: (c.members || []).length ? c.members : [{ name: '', position: '' }], note: c.note }; kkRender(); } }),
    el('button', { className: 'btn pri', type: 'button', textContent: t('ao.kk.open'), onclick: async () => {
      try { const n = await SB.rpc('am_count_open', { p_id: c.id }); S.flash = t('ao.kk.opened', { n: fmtInt(n) }); await kkLoad(); } catch (e) { aoErr(out, e); } } }));
  if (c.status === 'open') btns.push(el('button', { className: 'btn pri', type: 'button', textContent: '📱 ' + t('ao.kk.goCount'), onclick: () => { AO.sc.countId = c.id; showView('stockcount'); } }));
  if (edit && c.status === 'open') btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.kk.close'), onclick: () => kkCloseDlg(c, out) }));
  if (edit && ['draft', 'open'].includes(c.status)) btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.kk.cancel'), onclick: async () => {
    if (!confirm(t('ao.kk.cancelQ', { c: c.code }))) return;
    try { await SB.rpc('am_count_cancel', { p_id: c.id }); await kkLoad(); } catch (e) { aoErr(out, e); } } }));
  if (c.status !== 'draft') {
    btns.push(...aoPdfBtns(() => kkForm(c, L, true), () => `${c.code} - ${t('ao.kk.formDiff')}`, out).map((b, i) => { b.textContent = (i ? '⬇ ' : '👁 ') + t('ao.kk.formDiff'); return b; }));
    btns.push(...aoPdfBtns(() => kkForm(c, L, false), () => `${c.code} - ${t('ao.kk.formAll')}`, out).map((b, i) => { b.textContent = (i ? '⬇ ' : '👁 ') + t('ao.kk.formAll'); return b; }));
    btns.push(el('button', { className: 'btn tiny', type: 'button', textContent: t('lq.xlsx'), onclick: () => kkXlsx(c, L) }));
  }
  const s = c.summary;
  body.append(el('div', { className: 'card aodet' }, [
    el('div', { className: 'chead' }, [el('h2', { textContent: `${c.code} — ${c.title || t('ao.kk.name')}` }), aoChip(c.status, 'kk')]),
    el('div', { className: 'dim', textContent: `${t('ao.kk.c.depts')}: ${(c.depts || []).map(d => `${d} — ${pmDeptName(d)}`).join(', ')}` +
      (c.locations && c.locations.length ? ` · ${t('ao.kk.locsH')}: ${c.locations.join(', ')}` : '') + ` · ${t('ao.kk.c.date')}: ${fmtDate(c.count_date)}` }),
    (c.members || []).length ? el('div', { className: 'dim', textContent: `${t('ao.kk.membersH')}: ${c.members.map(m => m.name + (m.position ? ` (${m.position})` : '')).join(', ')}` }) : '',
    c.status !== 'draft' ? el('div', { className: 'lchead', style: 'margin:8px 0' }, [el('b', { textContent: t('lc.progress', { n: fmtInt(done), of: fmtInt(own.length) }) }),
      el('div', { className: 'lcprog' }, [el('i', { style: `width:${own.length ? Math.round(done / own.length * 100) : 0}%` })])]) : el('div', { className: 'tdnote', textContent: t('ao.kk.draftHint') }),
    s ? el('div', { className: 'msg ok', textContent: t('ao.kk.closedSum', { f: fmtInt(s.found || 0), t: fmtInt(s.total || 0), m: fmtInt(s.missing || 0), sh: fmtInt(s.short || 0),
      mv: fmtInt(s.moved || 0), x: fmtInt(s.extra || 0), d: fmtInt(s.damaged || 0), am: fmtInt((s.applied || {}).moved || 0), al: fmtInt((s.applied || {}).lost || 0), ad: fmtInt((s.applied || {}).damaged || 0) }) }) : '',
    out, el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap' }, btns)]));
  if (c.status === 'draft') return;
  const chips = el('div', { className: 'seg permtabs' });
  aoTabs(chips, AO_KK_FILTERS.map(f => [f, t('ao.kk.f.' + f), L.filter(l => kkMatch(l, f)).length]), S.filter, v => { S.filter = v; kkRender(); });
  const q = el('input', { placeholder: t('pm.f.search'), value: S.q, spellcheck: false });
  q.oninput = () => { S.q = q.value; clearTimeout(S.qt); S.qt = setTimeout(kkRender, 250); };
  body.append(el('div', { className: 'card' }, [chips, el('div', { style: 'margin-top:8px;max-width:340px' }, q)]));
  let rows = L.filter(l => kkMatch(l, S.filter));
  const qq = hnorm(S.q);
  if (qq) rows = rows.filter(l => hnorm(`${l.asset_code} ${l.barcode} ${l.name} ${l.loc_book} ${l.loc_found} ${l.note}`).includes(qq));
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['ao.c.code', 'ao.c.name', 'pm.col.dept', 'ao.kk.c.locBook', 'ao.kk.c.locFound', 'ao.c.qtyBook', 'ao.kk.c.qtyFound',
    'ao.kk.c.cond', 'ao.kk.c.note', 'ao.kk.c.state', ''].map(k => el('th', { textContent: k ? t(k) : '' })))]);
  const may = c.status === 'open';
  for (const l of rows.slice(0, 1500)) {
    const st = kkState(l);
    const acts = may ? el('td', { className: 'nowrap' }, [
      el('button', { className: 'btn tiny', type: 'button', textContent: '✓', title: t('lc.found'), onclick: () => kkMark(l, true, null, l.loc_found, l.cond, l.note, out) }),
      el('button', { className: 'btn tiny', type: 'button', textContent: '✗', title: t('lc.missing'), onclick: () => kkMark(l, false, 0, null, null, l.note, out) }),
      l.found != null ? el('button', { className: 'btn tiny', type: 'button', textContent: '↺', title: t('lc.undo'), onclick: () => kkMark(l, null, null, null, null, null, out) }) : '']) : el('td', { textContent: l.action || '' });
    tb.append(el('tr', { className: 'kk-' + st }, [el('td', {}, el('code', { textContent: l.asset_code || l.barcode || '' })), el('td', { textContent: l.name || t('ao.kk.unknown') }),
      el('td', { textContent: l.dept_code || '' }), el('td', { textContent: l.loc_book || '' }), el('td', { textContent: l.loc_found || '' }),
      el('td', { className: 'num', textContent: l.qty_book != null ? fmtNum(l.qty_book) : '' }), el('td', { className: 'num', textContent: l.qty_found != null ? fmtNum(l.qty_found) : '' }),
      el('td', { textContent: l.cond ? t('ao.kk.cond.' + l.cond) : '' }), el('td', { className: 'aowrap', textContent: [l.note, l.by_name].filter(Boolean).join(' · ') }),
      el('td', {}, el('span', { className: 'aost kk-' + st, textContent: t('ao.kk.f.' + st) })), acts]));
  }
  if (rows.length > 1500) tb.append(el('tr', {}, el('td', { colSpan: 11, className: 'dim', textContent: t('acc.more', { n: fmtInt(rows.length - 1500) }) })));
  if (!rows.length) tb.append(el('tr', {}, el('td', { colSpan: 11, className: 'dim', style: 'padding:14px', textContent: t('lq.none') })));
  body.append(el('div', { className: 'card' }, el('div', { className: 'wrap' }, tb)));
}
async function kkMark(l, found, qty, loc, cond, note, out) {
  try {
    await SB.rpc('am_count_mark', { p_line: l.id, p_found: found, p_qty: qty, p_loc: loc || null, p_cond: cond || null, p_note: note || null });
    if (found == null && l.extra) AO.kk.lines = AO.kk.lines.filter(x => x.id !== l.id);
    else Object.assign(l, { found, qty_found: found == null ? null : found ? (l.kind === 'unique' ? 1 : (qty ?? l.qty_found ?? l.qty_book)) : 0,
                            loc_found: found ? (loc || l.loc_found || l.loc_book) : null, cond: found ? cond || null : null, note: found == null ? null : note || null,
                            by_name: found == null ? null : (ME && (ME.full_name || ME.email)) });
    if (VIEW === 'stock') kkRender(); else scRender();
  } catch (e) { aoErr(out || '#scMsg', e); }
}
function kkCloseDlg(c, out) {
  const L = AO.kk.lines.filter(l => l.count_id === c.id && !l.extra), pend = L.filter(l => l.found == null).length;
  const box = el('div', { className: 'card aoclose' });
  const cb = (k, on) => { const x = el('input', { type: 'checkbox', checked: on }); x.dataset.k = k; return x; };
  const mv = cb('move', true), lost = cb('lost', true), dmg = cb('damaged', true), pm = cb('pending_missing', true);
  box.append(el('h3', { textContent: t('ao.kk.closeH', { c: c.code }) }),
    pend ? el('div', { className: 'msg warn', textContent: t('ao.kk.pendWarn', { n: fmtInt(pend) }) }) : '',
    ...[[mv, 'ao.kk.ap.move'], [lost, 'ao.kk.ap.lost'], [dmg, 'ao.kk.ap.damaged'], [pm, 'ao.kk.ap.pending']].map(([x, k]) => el('label', { className: 'chk', style: 'display:flex;margin:4px 0' }, [x, el('span', { textContent: t(k) })])),
    el('div', { className: 'row', style: 'gap:8px;margin-top:8px' }, [
      el('button', { className: 'btn pri', type: 'button', textContent: t('ao.kk.close'), onclick: async () => {
        try { const s = await SB.rpc('am_count_close', { p_id: c.id, p_apply: { move: mv.checked, lost: lost.checked, damaged: dmg.checked, pending_missing: pm.checked } });
              AO.kk.flash = t('ao.kk.closedMsg', { m: fmtInt((s.applied || {}).moved || 0), l: fmtInt((s.applied || {}).lost || 0), d: fmtInt((s.applied || {}).damaged || 0) }); await kkLoad(); }
        catch (e) { aoErr(out, e); } } }),
      el('button', { className: 'btn', type: 'button', textContent: t('auth.cancel'), onclick: () => box.remove() })]));
  out.after(box);
}
// The count minutes: landscape, book vs count, the difference; the discrepancies only, or every line.
function kkForm(c, L, diffOnly) {
  const rows = L.filter(l => !diffOnly || kkState(l) !== 'found');
  const cols = [['STT / No.', (r, i) => i + 1, 'c', '4%'], ['Mã tài sản / Asset code', r => r.asset_code || r.barcode || '', '', '15%'], ['Tên tài sản / Asset name', r => r.name || 'Chưa có trên sổ / Not registered', '', '20%'],
    ['BP / Dept.', r => r.dept_code || '', 'c', '5%'], ['Vị trí sổ / Book location', r => r.loc_book || '', 'c', '8%'], ['Vị trí thực tế / Found at', r => r.loc_found || '', 'c', '8%'],
    ['SL sổ / Book qty', r => r.extra ? '' : fmtNum(r.qty_book), 'n', '6%'], ['SL thực tế / Counted', r => r.qty_found != null ? fmtNum(r.qty_found) : '', 'n', '6%'],
    ['Chênh lệch / Diff.', r => r.extra ? '+' + fmtNum(r.qty_found || 1) : r.qty_found != null ? fmtNum(n0(r.qty_found) - n0(r.qty_book)) : '', 'n', '6%'],
    ['Tình trạng / Condition', r => r.cond ? `${t('ao.kk.cond.' + r.cond)}` : '', 'c', '8%'], ['Ghi chú / Notes', r => [LANG === 'vi' ? t('ao.kk.f.' + kkState(r)) : kkState(r), r.note].filter(Boolean).join(' — '), '', '14%']];
  const own = L.filter(l => !l.extra), s = c.summary || {
    total: own.length, found: own.filter(l => l.found).length, missing: own.filter(l => l.found === false).length, extra: L.filter(l => l.extra).length };
  const head = [lqbHead('04', 'BIÊN BẢN KIỂM KÊ TÀI SẢN', 'MINUTES OF ASSET COUNT', c.code, c.count_date),
    lqbBi(`Phạm vi: ${(c.depts || []).map(d => `${d} — ${pmDeptName(d)}`).join(', ')}${c.locations && c.locations.length ? ' · Vị trí: ' + c.locations.join(', ') : ''}`,
          `Scope: ${(c.depts || []).join(', ')}${c.locations && c.locations.length ? ' · Locations: ' + c.locations.join(', ') : ''}`),
    lqbBi('Ban kiểm kê gồm:', 'Asset Count Committee Comprises:'),
    ...(c.members || []).map(m => lqbBi(`Ông/Bà: ${String(m.name || '').toUpperCase()} — Chức vụ: ${m.position || ''}`, `Mr./Mrs. ${String(m.name || '').toUpperCase()} — Position: ${m.position || ''}`)),
    lqbBi(`Kết quả: kiểm ${fmtInt(s.total || 0)} tài sản theo sổ, thấy ${fmtInt(s.found || 0)}, không thấy ${fmtInt(s.missing || 0)}, thừa / ngoài sổ ${fmtInt(s.extra || 0)}.`,
          `Result: ${fmtInt(s.total || 0)} asset(s) on the books, ${fmtInt(s.found || 0)} found, ${fmtInt(s.missing || 0)} not found, ${fmtInt(s.extra || 0)} extra / not on the books.`),
    lqbBi(diffOnly ? 'Danh sách chênh lệch:' : 'Chi tiết:', diffOnly ? 'Discrepancies:' : 'Details:')];
  const foot = [lqbSigns([['Tổng Giám đốc', 'General Manager', ''], ['Kế toán trưởng', 'Chief Accountant', ''], ['Trưởng Ban kiểm kê', 'Head of Committee', String(((c.members || [])[0] || {}).name || '').toUpperCase()]])];
  return lqbPages(true, head, rows, (rr, at) => lqbTable(cols, rr, { start: at }), foot, 10, 22);
}
function kkXlsx(c, L) {
  const rows = L.map(l => ({ [t('ao.c.code')]: l.asset_code, Barcode: l.barcode, [t('ao.c.name')]: l.name, [t('pm.col.dept')]: l.dept_code, [t('ao.kk.c.locBook')]: l.loc_book,
    [t('ao.kk.c.locFound')]: l.loc_found, [t('ao.c.qtyBook')]: l.qty_book != null ? Number(l.qty_book) : null, [t('ao.kk.c.qtyFound')]: l.qty_found != null ? Number(l.qty_found) : null,
    [t('ao.kk.c.cond')]: l.cond ? t('ao.kk.cond.' + l.cond) : '', [t('ao.kk.c.state')]: t('ao.kk.f.' + kkState(l)), [t('ao.kk.c.note')]: l.note, [t('ao.kk.c.by')]: l.by_name, [t('ao.kk.c.action')]: l.action }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), c.code.replace(/[^\w.]/g, '_').slice(0, 30));
  const file = `phcl-kiem-ke-${c.code}-${bkStamp()}.xlsx`; XLSX.writeFile(wb, file); msg('#kkMsg', 'ok', t('lq.exported', { file }));
}

/* The count on the tablet: pick the location you are standing in, scan. What
   is found at another location than the book says is noted there; a barcode
   of another department or not in the register is added as "extra". */
async function scLoad() {
  const out = $('#scMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups(); await aoLocs();
    const counts = await SB.select('am_count', 'select=*&status=eq.open&order=id');
    AO.sc.counts = counts;
    if (!counts.length) { $('#scBody').innerHTML = ''; return msg(out, 'info', t('ao.sc.none')); }
    const c = counts.find(x => x.id === AO.sc.countId) || counts[0];
    AO.sc.countId = c.id; AO.sc.count = c;
    AO.sc.lines = await pmSelectAll('am_count_line', `select=*&count_id=eq.${c.id}&order=id`);
    AO.kk.lines = AO.sc.lines;
    msg(out, '', '');
    scRender();
  } catch (e) { $('#scBody').innerHTML = ''; aoErr(out, e); }
}
function scRender() {
  const body = $('#scBody'), S = AO.sc, c = S.count;
  if (!body || !c) return;
  S.lines = AO.kk.lines;
  body.innerHTML = '';
  $('#pageTitle').textContent = `${t('ao.sc.title')} — ${c.code}`;
  const own = S.lines.filter(l => !l.extra), done = own.filter(l => l.found != null).length;
  const top = el('div', { className: 'card lctop' });
  if (S.counts.length > 1) {
    const cs = el('select'); selFill(cs, S.counts.map(x => [x.id, `${x.code} ${x.title || ''}`])); cs.value = c.id;
    cs.onchange = () => { S.countId = Number(cs.value); scLoad(); };
    top.append(cs);
  }
  const locs = [...new Set([...(c.locations || []), ...own.map(l => l.loc_book).filter(Boolean)])].sort();
  const ls = el('select', { className: 'scloc' });
  selFill(ls, [['', t('ao.sc.anyLoc')], ...locs.map(x => [x, x + (((AO_LOC || []).find(l => l.code === x) || {}).name ? ' — ' + AO_LOC.find(l => l.code === x).name : '')])]);
  ls.value = S.loc; ls.onchange = () => { S.loc = ls.value; scRender(); };
  const scan = el('input', { className: 'lcscan', placeholder: t('lc.scan'), spellcheck: false, autocapitalize: 'characters' });
  scan.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    const q = scan.value.trim(); if (!q) return;
    try {
      const r = await SB.rpc('am_count_scan', { p_id: c.id, p_code: q, p_loc: S.loc || null });
      const i = AO.kk.lines.findIndex(l => l.id === r.id);
      if (i >= 0) AO.kk.lines[i] = Object.assign(AO.kk.lines[i], r); else AO.kk.lines.push(r);
      S.flash = r.hit === 'list' ? ['ok', t('ao.sc.ok', { c: r.asset_code || q, n: r.name || '' }) + (r.loc_found && r.loc_book && r.loc_found !== r.loc_book ? ' · ' + t('ao.sc.moved', { a: r.loc_book, b: r.loc_found }) : '')]
        : r.hit === 'extra' ? ['warn', t('ao.sc.extra', { c: r.asset_code || q, d: r.dept_code || '', l: r.loc_book || '' })] : ['warn', t('ao.sc.unknown', { c: q })];
      scRender();
      const card = document.getElementById('sc-' + r.id); if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('flash'); }
    } catch (er) { aoErr('#scMsg', er); }
    setTimeout(() => { const s = $('.lcscan'); if (s) { s.value = ''; s.focus(); } }, 30);
  };
  const only = el('select'); selFill(only, [['here', t('ao.sc.onlyHere')], ['pending', t('ao.sc.onlyPending')], ['all', t('ao.sc.onlyAll')]]); only.value = S.only;
  only.onchange = () => { S.only = only.value; scRender(); };
  top.append(el('div', { className: 'lchead' }, [el('b', { textContent: t('lc.progress', { n: fmtInt(done), of: fmtInt(own.length) }) }),
    el('div', { className: 'lcprog' }, [el('i', { style: `width:${own.length ? Math.round(done / own.length * 100) : 0}%` })])]),
    aoFld(t('ao.sc.loc'), ls, 'min-width:200px'), aoFld(t('ao.sc.show'), only, 'min-width:160px'), scan);
  body.append(top);
  if (S.flash) { msg('#scMsg', S.flash[0], S.flash[1]); S.flash = null; }
  let rows = S.only === 'all' ? S.lines : S.only === 'pending' ? own.filter(l => l.found == null)
    : S.lines.filter(l => (S.loc ? (l.loc_book === S.loc || l.loc_found === S.loc) : true) && (l.found == null || l.at && Date.now() - new Date(l.at).getTime() < 3600e3));
  rows = rows.slice(0, 400);
  const list = el('div', { className: 'lccards' });
  for (const l of rows) list.append(scCard(l));
  if (!rows.length) list.append(el('div', { className: 'tbempty', textContent: t('ao.sc.empty') }));
  body.append(list);
  setTimeout(() => { const s = $('.lcscan'); if (s && !TB.on) s.focus(); }, 30);
}
function scCard(l) {
  const st = kkState(l);
  const cls = l.found == null ? '' : st === 'found' ? ' ok' : st === 'missing' ? ' miss' : ' diff';
  const qty = el('input', { className: 'lcqty', inputMode: 'decimal', value: l.qty_found != null ? fmtNum(l.qty_found) : fmtNum(l.qty_book), disabled: l.kind !== 'low' });
  const cond = el('select'); selFill(cond, [['', t('ao.kk.c.cond')], ...['good', 'poor', 'damaged'].map(k => [k, t('ao.kk.cond.' + k)])]); cond.value = l.cond || '';
  const note = el('input', { className: 'lcnote', placeholder: t('lc.note'), value: l.note || '' });
  const save = f => kkMark(l, f, f ? numIn(qty.value) : 0, f ? (AO.sc.loc || l.loc_found || l.loc_book) : null, f ? cond.value : null, note.value, '#scMsg');
  cond.onchange = note.onchange = qty.onchange = () => { if (l.found) save(true); };
  return el('div', { className: 'lccard' + cls, id: 'sc-' + l.id }, [
    el('div', { className: 'lcwho' }, [el('code', { textContent: l.asset_code || l.barcode || '' }), el('b', { textContent: l.name || t('ao.kk.unknown') }),
      el('small', { textContent: [l.barcode, l.dept_code, l.loc_book && `${t('ao.kk.c.locBook')}: ${l.loc_book}`, l.loc_found && l.loc_found !== l.loc_book ? `→ ${l.loc_found}` : '',
                                  l.extra ? t('ao.kk.f.extra') : ''].filter(Boolean).join(' · ') })]),
    el('div', { className: 'lcbook', textContent: t('lc.book', { q: fmtNum(l.qty_book ?? 1) }) }),
    el('div', { className: 'lcact' }, [
      el('button', { className: 'btn lcyes' + (l.found === true ? ' on' : ''), type: 'button', textContent: '✓ ' + t('lc.found'), onclick: () => save(true) }),
      el('button', { className: 'btn lcno' + (l.found === false ? ' on' : ''), type: 'button', textContent: '✗ ' + t('lc.missing'), onclick: () => save(false) }),
      el('label', { className: 'lcql' }, [el('span', { textContent: t('lc.qty') }), qty]), cond, note,
      l.found != null ? el('button', { className: 'btn tiny', type: 'button', textContent: t('lc.undo'), onclick: () => kkMark(l, null, null, null, null, null, '#scMsg') }) : ''])]);
}
// Is a count open (for the tablet bar)?
async function scCheck() {
  try { AO.sc.openN = can('assets', 'view') ? (await SB.select('am_count', 'select=id&status=eq.open')).length : 0; } catch { AO.sc.openN = 0; }
}

/* ============================================================ REPORTS */
function repRange(mode, val) {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1, pad = n => String(n).padStart(2, '0');
  const last = (yy, mm) => new Date(yy, mm, 0).getDate();
  if (mode === 'year') { const yy = Number(val) || y; return { from: `${yy}-01-01`, to: `${yy}-12-31`, label: String(yy) }; }
  if (mode === 'quarter') { const [yy, q] = (val || `${y}-Q${Math.ceil(m / 3)}`).split('-Q').map(Number); const m0 = (q - 1) * 3 + 1;
    return { from: `${yy}-${pad(m0)}-01`, to: `${yy}-${pad(m0 + 2)}-${last(yy, m0 + 2)}`, label: `${yy}-Q${q}` }; }
  const [yy, mm] = (val || `${y}-${pad(m)}`).split('-').map(Number);
  return { from: `${yy}-${pad(mm)}-01`, to: `${yy}-${pad(mm)}-${last(yy, mm)}`, label: `${yy}-${pad(mm)}` };
}
async function repLoad() {
  const out = $('#repMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    const R = AO.rep, r = repRange(R.mode, R.val);
    R.range = r;
    const [data, snaps] = await Promise.all([SB.rpc('am_report', { p_from: r.from, p_to: r.to }),
      SB.select('am_report_snap', 'select=id,period,p_from,p_to,created_name,created_at&order=period.desc').catch(() => [])]);
    Object.assign(R, { data, snaps, view: null });
    msg(out, R.flash ? 'ok' : '', R.flash || ''); R.flash = null;
    repRender();
  } catch (e) { $('#repBody').innerHTML = ''; aoErr(out, e); }
}
function repRender() {
  const body = $('#repBody'), R = AO.rep;
  if (!body) return;
  body.innerHTML = '';
  const mode = el('select'); selFill(mode, [['month', t('ao.rep.month')], ['quarter', t('ao.rep.quarter')], ['year', t('ao.rep.year')]]); mode.value = R.mode;
  const cur = repRange(R.mode, R.val);
  const val = el('input', { value: R.val || cur.label, style: 'max-width:120px', placeholder: R.mode === 'year' ? '2026' : R.mode === 'quarter' ? '2026-Q3' : '2026-09' });
  mode.onchange = () => { R.mode = mode.value; R.val = ''; repLoad(); };
  val.onchange = () => { R.val = val.value.trim(); repLoad(); };
  const cmp = el('select'); selFill(cmp, [['', t('ao.rep.noCmp')], ...R.snaps.map(s => [s.id, s.period])]); cmp.value = R.cmp || '';
  cmp.onchange = async () => { R.cmp = cmp.value; R.cmpData = null;
    if (R.cmp) try { const [s] = await SB.select('am_report_snap', `select=*&id=eq.${R.cmp}`); R.cmpData = s; } catch {}
    repRender(); };
  const tools = [aoFld(t('ao.rep.period'), mode, 'max-width:160px'), aoFld(t('ao.rep.which'), val, 'max-width:140px'), aoFld(t('ao.rep.cmp'), cmp, 'max-width:180px'), el('span', { style: 'flex:1' })];
  const D = R.view ? R.view.data : R.data;
  const out = el('div');
  if (can('assets', 'edit') && !R.view) tools.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.rep.freeze', { p: (R.range || cur).label }), onclick: async () => {
    if (!confirm(t('ao.rep.freezeQ', { p: (R.range || cur).label }))) return;
    try { await SB.rpc('am_report_snap_save', { p_period: (R.range || cur).label, p_from: (R.range || cur).from, p_to: (R.range || cur).to }); R.flash = t('ao.rep.frozen'); await repLoad(); }
    catch (e) { aoErr(out, e); } } }));
  if (D) tools.push(el('button', { className: 'btn', type: 'button', textContent: t('lq.xlsx'), onclick: () => repXlsx(D) }),
                    ...aoPdfBtns(() => repForm(D), () => `${t('ao.rep.title')} ${R.view ? R.view.period : (R.range || cur).label}`, out));
  body.append(el('div', { className: 'card row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' }, tools), out);
  if (R.view) body.append(el('div', { className: 'msg info' }, [document.createTextNode(t('ao.rep.viewing', { p: R.view.period, d: fmtDateTime(R.view.created_at), w: R.view.created_name || '' }) + ' '),
    el('a', { href: '#', textContent: t('ao.rep.backLive'), onclick: e => { e.preventDefault(); R.view = null; repRender(); } })]));
  if (!D) return;
  const C = R.cmpData && !R.view ? R.cmpData.data : null;
  const T = D.totals || {}, M = D.movement || {}, P = D.pending || {};
  const delta = (a, b) => b == null ? '' : ` (${a - b >= 0 ? '+' : ''}${fmtNum(Math.round(a - b))})`;
  const tile = (k, v, sub, cls) => el('div', { className: 'aokpi ' + (cls || '') }, [el('small', { textContent: t(k) }), el('b', { textContent: v }), sub ? el('span', { textContent: sub }) : '']);
  body.append(el('div', { className: 'aokpis' }, [
    tile('ao.rep.k.unique', fmtInt(T.unique || 0), C ? delta(T.unique || 0, (C.totals || {}).unique || 0) : ''),
    tile('ao.rep.k.low', fmtInt(T.low_rows || 0), t('ao.rep.k.lowQty', { n: fmtNum(T.low_qty || 0) })),
    tile('ao.rep.k.value', fmtMoney(T.value || 0), C ? delta(T.value || 0, (C.totals || {}).value || 0) : t('ao.rep.k.valueHint')),
    tile('ao.rep.k.booked', fmtInt(T.booked || 0), t('ao.rep.k.nbv', { v: fmtMoney(T.nbv || 0) })),
    tile('ao.rep.k.temp', fmtInt(T.temp || 0), fmtMoney(T.temp_value || 0), T.temp ? 'warn' : ''),
    tile('ao.rep.k.noLabel', fmtInt(T.no_label || 0), '', T.no_label ? 'warn' : '')]));
  const sect = (h, node) => el('div', { className: 'card' }, [el('h2', { textContent: h }), node]);
  const kv = pairs => el('dl', { className: 'aodl' }, pairs.flatMap(([k, v]) => [el('dt', { textContent: t(k) }), el('dd', { textContent: v })]));
  body.append(el('div', { className: 'aogrid2' }, [
    sect(t('ao.rep.movement', { a: fmtDate(D.from), b: fmtDate(D.to) }), kv([
      ['ao.rep.m.new', `${fmtInt(M.new || 0)} · ${fmtMoney(M.new_value || 0)}`], ['ao.rep.m.transfers', t('ao.rep.m.tfLines', { n: fmtInt(M.transfers || 0), l: fmtInt(M.transfer_lines || 0) })],
      ['ao.rep.m.incOpened', fmtInt(M.inc_opened || 0)], ['ao.rep.m.incClosed', `${fmtInt(M.inc_closed || 0)} · ${t('ao.rep.m.cost')} ${fmtMoney(M.repair_cost || 0)}`],
      ['ao.rep.m.counts', fmtInt(M.counts || 0)],
      ['ao.rep.m.status', Object.entries(M.status || {}).map(([s, n]) => `${amStatusLabel(s)}: ${fmtInt(n)}`).join(' · ') || '—']])),
    sect(t('ao.rep.pending'), kv([
      ['ao.rep.p.tempOld', fmtInt(P.temp_old || 0)], ['ao.rep.p.repair', fmtInt(P.repair || 0)], ['ao.rep.p.beyond', fmtInt(P.beyond || 0)],
      ['ao.rep.p.awaiting', fmtInt(P.awaiting || 0)], ['ao.rep.p.incOpen', fmtInt(P.inc_open || 0)], ['ao.rep.p.tfOpen', fmtInt(P.tf_open || 0)],
      ['ao.rep.p.warranty', fmtInt(P.warranty_30 || 0)]]))]));
  const table = (cols, rows, total) => { const tb = el('table', { className: 'lqbt' }, [el('tr', {}, cols.map(c => el('th', { className: c[2] || '', textContent: t(c[0]) })))]);
    for (const r of rows) tb.append(el('tr', {}, cols.map(c => el('td', { className: c[2] || '', textContent: c[1](r) }))));
    if (total) tb.append(el('tr', { className: 'tot' }, cols.map((c, i) => el('td', { className: c[2] || '', textContent: i ? (c[3] ? c[3](rows) : '') : t('lq.total', { n: fmtInt(rows.length) }) }))));
    return el('div', { className: 'wrap' }, tb); };
  const sum = f => rs => fmtNum(Math.round(rs.reduce((a, r) => a + n0(f(r)), 0)));
  const cmpDept = d => C ? ((C.by_dept || []).find(x => x.dept === d.dept) || { value: 0, unique: 0 }) : null;
  body.append(sect(t('ao.rep.byDept'), table([
    ['pm.col.dept', r => `${r.dept} — ${pmDeptName(r.dept)}`], ['ao.rep.c.unique', r => fmtInt(r.unique), 'num', sum(r => r.unique)],
    ['ao.rep.c.lowRows', r => `${fmtInt(r.low_rows)} · ${fmtNum(r.low_qty)}`, 'num'], ['ao.rep.c.value', r => lqN(r.value) + (C ? delta(n0(r.value), n0(cmpDept(r).value)) : ''), 'num', sum(r => r.value)],
    ['ao.rep.c.booked', r => lqN(r.booked_cost), 'num', sum(r => r.booked_cost)], ['ao.rep.c.nbv', r => lqN(r.nbv), 'num', sum(r => r.nbv)],
    ['ao.rep.c.temp', r => fmtInt(r.temp), 'num', sum(r => r.temp)], ['ao.rep.c.repair', r => fmtInt(r.repair), 'num', sum(r => r.repair)],
    ['ao.rep.c.awaiting', r => fmtInt(r.awaiting), 'num', sum(r => r.awaiting)]], D.by_dept || [], true)));
  body.append(el('div', { className: 'aogrid2' }, [
    sect(t('ao.rep.byGroup'), table([['ao.rep.c.group', r => r.group], ['ao.rep.c.rows', r => fmtInt(r.rows), 'num', sum(r => r.rows)], ['ao.rep.c.value', r => lqN(r.value), 'num', sum(r => r.value)]], D.by_group || [], true)),
    sect(t('ao.rep.byStatus'), table([['ao.rep.c.status', r => r.status ? amStatusLabel(r.status) : t('ao.rep.noStatus')], ['ao.rep.c.rows', r => fmtInt(r.rows), 'num', sum(r => r.rows)],
      ['ao.rep.c.value', r => lqN(r.value), 'num', sum(r => r.value)]], D.by_status || [], true))]));
  if ((D.counts || []).length) body.append(sect(t('ao.rep.counts'), table([['ao.kk.c.code', r => r.code], ['ao.kk.c.title', r => r.title || ''], ['ao.kk.c.depts', r => (r.depts || []).join(', ')],
    ['ao.kk.c.date', r => fmtDate(r.date)], ['ao.kk.c.result', r => { const s = r.summary || {}; return t('ao.kk.sum', { f: fmtInt(s.found || 0), t: fmtInt(s.total || 0), m: fmtInt(s.missing || 0), x: fmtInt(s.extra || 0) }); }]], D.counts)));
  if (R.snaps.length) body.append(sect(t('ao.rep.snaps'), el('div', { className: 'aosnaps' }, R.snaps.map(s => el('button', { className: 'btn tiny', type: 'button',
    textContent: `${s.period} · ${fmtDate(String(s.created_at).slice(0, 10))}`, onclick: async () => {
      try { const [x] = await SB.select('am_report_snap', `select=*&id=eq.${s.id}`); R.view = x; repRender(); } catch (e) { aoErr(out, e); } } })))));
  body.append(el('div', { className: 'tdnote', textContent: t('ao.rep.note') }));
}
function repXlsx(D) {
  const wb = XLSX.utils.book_new(), T = D.totals || {}, M = D.movement || {}, P = D.pending || {};
  const kv = [[t('ao.rep.period'), `${D.from} → ${D.to}`], ...Object.entries(T).map(([k, v]) => ['totals.' + k, v]), ...Object.entries(M).filter(([, v]) => typeof v !== 'object').map(([k, v]) => ['movement.' + k, v]),
              ...Object.entries(P).map(([k, v]) => ['pending.' + k, v])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kv), 'Tong hop');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((D.by_dept || []).map(r => Object.assign({ ten: pmDeptName(r.dept) }, r))), 'Theo bo phan');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(D.by_group || []), 'Theo nhom');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((D.by_status || []).map(r => Object.assign({ ten: amStatusLabel(r.status) }, r))), 'Theo tinh trang');
  if ((D.counts || []).length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(D.counts.map(c => Object.assign({ code: c.code, title: c.title, depts: (c.depts || []).join(','), date: c.date }, c.summary || {}))), 'Kiem ke');
  const file = `phcl-bao-cao-tai-san-${(AO.rep.view ? AO.rep.view.period : (AO.rep.range || {}).label) || ''}-${bkStamp()}.xlsx`;
  XLSX.writeFile(wb, file); msg('#repMsg', 'ok', t('lq.exported', { file }));
}
function repForm(D) {
  const T = D.totals || {}, M = D.movement || {}, P = D.pending || {}, per = AO.rep.view ? AO.rep.view.period : (AO.rep.range || {}).label;
  const head = [lqbHead(null, 'BÁO CÁO TÀI SẢN ĐỊNH KỲ', 'PERIODIC ASSET REPORT', per, String(D.as_of || '').slice(0, 10)),
    lqbBi(`Kỳ báo cáo: ${lqD(D.from)} – ${lqD(D.to)}`, `Period: ${lqD(D.from)} – ${lqD(D.to)}`),
    lqbSec('I. Tổng hợp', 'Summary'),
    lqbBi(`TSCĐ (quản lý riêng): ${fmtInt(T.unique || 0)} · CCDC: ${fmtInt(T.low_rows || 0)} dòng / ${fmtNum(T.low_qty || 0)} đơn vị · Giá trị: ${lqN(T.value)} VND`,
          `Unique assets: ${fmtInt(T.unique || 0)} · Low-value: ${fmtInt(T.low_rows || 0)} rows / ${fmtNum(T.low_qty || 0)} units · Value: ${lqN(T.value)} VND`),
    lqbBi(`Đã ghi nhận kế toán: ${fmtInt(T.booked || 0)} (nguyên giá ${lqN(T.booked_cost)}, GTCL ${lqN(T.nbv)}) · Tài sản tạm: ${fmtInt(T.temp || 0)} (${lqN(T.temp_value)})`,
          `Booked: ${fmtInt(T.booked || 0)} (cost ${lqN(T.booked_cost)}, NBV ${lqN(T.nbv)}) · Provisional: ${fmtInt(T.temp || 0)}`),
    lqbSec('II. Biến động trong kỳ', 'Movement'),
    lqbBi(`Tăng mới: ${fmtInt(M.new || 0)} (${lqN(M.new_value)}) · Điều chuyển: ${fmtInt(M.transfers || 0)} phiếu / ${fmtInt(M.transfer_lines || 0)} dòng · Sự cố: mở ${fmtInt(M.inc_opened || 0)}, đóng ${fmtInt(M.inc_closed || 0)}, chi phí ${lqN(M.repair_cost)} · Kiểm kê: ${fmtInt(M.counts || 0)} đợt`,
          `New: ${fmtInt(M.new || 0)} · Transfers: ${fmtInt(M.transfers || 0)} · Incidents opened ${fmtInt(M.inc_opened || 0)}, closed ${fmtInt(M.inc_closed || 0)} · Counts: ${fmtInt(M.counts || 0)}`),
    lqbBi(`Đổi tình trạng: ${Object.entries(M.status || {}).map(([s, n]) => `${amStatusLabel(s)} ${fmtInt(n)}`).join('; ') || '—'}`, 'Status changes'),
    lqbSec('III. Việc tồn', 'Open items'),
    lqbBi(`Tài sản tạm chờ > 3 tháng: ${fmtInt(P.temp_old || 0)} · Đang hỏng / sửa: ${fmtInt(P.repair || 0)} · Không sửa được: ${fmtInt(P.beyond || 0)} · Chờ thanh lý: ${fmtInt(P.awaiting || 0)} · Sự cố mở: ${fmtInt(P.inc_open || 0)} · Phiếu điều chuyển chờ duyệt: ${fmtInt(P.tf_open || 0)} · Hết bảo hành trong 30 ngày: ${fmtInt(P.warranty_30 || 0)}`,
          'Open items'),
    lqbSec('IV. Theo bộ phận', 'By department')];
  const rows = D.by_dept || [];
  const cols = [['STT / No.', (r, i) => i + 1, 'c', '5%'], ['Bộ phận / Dept.', r => `${r.dept} — ${pmDeptName(r.dept)}`, '', '25%'], ['TSCĐ / Unique', r => fmtInt(r.unique), 'n', '8%'],
    ['CCDC / Low-value', r => `${fmtInt(r.low_rows)} · ${fmtNum(r.low_qty)}`, 'n', '11%'], ['Giá trị / Value', r => lqN(r.value), 'n', '13%'], ['Nguyên giá KT / Booked', r => lqN(r.booked_cost), 'n', '13%'],
    ['GTCL / NBV', r => lqN(r.nbv), 'n', '11%'], ['Tạm / Prov.', r => fmtInt(r.temp), 'n', '7%'], ['Hỏng / Repair', r => fmtInt(r.repair), 'n', '7%']];
  const foot = [lqbSigns([['Người lập', 'Prepared by', String((ME && (ME.full_name || ME.email)) || '').toUpperCase()], ['Kế toán trưởng', 'Chief Accountant', ''], ['Tổng Giám đốc', 'General Manager', '']])];
  return lqbPages(false, head, rows, (rr, at) => lqbTable(cols, rr, { start: at }), foot, 8, 30);
}

/* ============================================================ ASSET PANEL */
const AO_EV_ICON = { created: '＋', change: '✎', intake: '📦', label: '🏷', photo: '📷', transfer: '⇄', incident: '🔧', count: '☑', liquidation: '♻', accounting: '📒' };
function aoDrawerEl() {
  let dr = $('#aoDrawer');
  if (dr) return dr;
  dr = el('div', { id: 'aoDrawer', className: 'drawer', role: 'dialog', hidden: true }, [
    el('div', { className: 'dhead' }, [el('h2', { id: 'aoDrTitle' }), el('button', { className: 'dbtn', type: 'button', textContent: '✕', onclick: aoDrawerClose })]),
    el('div', { id: 'aoDrBody', className: 'dbody' })]);
  document.body.append(dr);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dr.hidden) aoDrawerClose(); });
  return dr;
}
function aoDrawerClose() { const d = $('#aoDrawer'); if (d) { d.hidden = true; $('#aoDrBody').innerHTML = ''; } }

async function aoAsset(id) {
  const dr = aoDrawerEl(), body = $('#aoDrBody');
  dr.hidden = false; body.innerHTML = ''; body.scrollTop = 0;
  $('#aoDrTitle').textContent = t('table.loading');
  const out = el('div');
  body.append(out);
  try {
    await pmLookups();
    let H;
    try { H = await SB.rpc('am_asset_history', { p_id: id }); }
    catch (e) { if (!aoMissing(e)) throw e;
      const [a] = await SB.select('am_asset', `select=*&id=eq.${id}`); H = { asset: a, events: [], incidents: [], transfers: [], old: true }; }
    const a = H.asset || {};
    $('#aoDrTitle').textContent = `${a.asset_code} — ${aoName(a)}`;
    if (H.old) msg(out, 'warn', t('ao.notInstalled'));
    const f = (k, v) => v == null || v === '' ? [] : [el('dt', { textContent: t(k) }), el('dd', { textContent: v })];
    const wIn = el('input', { type: 'date', value: a.warranty_until || '', disabled: !can('assets', 'edit') || H.old });
    wIn.onchange = async () => { try { await SB.patch('am_asset', `id=eq.${a.id}`, { warranty_until: wIn.value || null }); msg(out, 'ok', t('ao.saved')); } catch (e) { msg(out, 'err', e.message); } };
    const acts = [];
    if (!['0', '7', '9', '23'].includes(String(a.status_code || '')) && !H.old) {
      acts.push(el('button', { className: 'btn', type: 'button', textContent: '🔧 ' + t('ao.inc.new'), onclick: () => { aoDrawerClose(); incNew(a); } }));
      if (aoScope(a.dept_code)) acts.push(el('button', { className: 'btn', type: 'button', textContent: '⇄ ' + t('ao.tf.new'), onclick: () => { aoDrawerClose(); tfNew([a]); } }));
      if (can('liquidation', 'create')) acts.push(el('button', { className: 'btn', type: 'button', textContent: '♻ ' + t('ao.toLr'), onclick: () => { aoDrawerClose(); aoToLr(a.id, out); } }));
    }
    body.append(el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap;margin-bottom:10px' }, acts),
      el('dl', { className: 'aodl' }, [
        ...f('ao.c.code', a.asset_code), ...f('ao.a.barcode', a.barcode), ...f('ao.a.kind', t('ao.a.k.' + a.asset_kind)),
        ...f('pm.col.dept', a.dept_code ? `${a.dept_code} — ${pmDeptName(a.dept_code)}` : ''), ...f('ao.c.loc', a.location_code),
        ...f('ao.a.qty', `${fmtNum(a.qty)} ${a.unit_code || ''}`), ...f('ao.a.status', amStatusLabel(a.status_code)),
        ...f('ao.a.cat', [a.group_code, a.category_code].filter(Boolean).join(' · ')), ...f('ao.a.brand', [a.spec_brand, a.spec_model, a.serial].filter(Boolean).join(' · ')),
        ...f('ao.a.supplier', a.supplier), ...f('ao.a.purchase', [a.purchase_date && fmtDate(a.purchase_date), a.in_use_date && `${t('ao.a.inUse')} ${fmtDate(a.in_use_date)}`].filter(Boolean).join(' · ')),
        ...f('ao.a.price', a.unit_price != null ? `${lqN(a.unit_price)} × ${fmtNum(a.qty)} = ${lqN(n0(a.unit_price) * n0(a.qty))}` : ''),
        ...f('ao.a.fin', a.fin_status ? `${t('acc.fs.' + a.fin_status)}${a.fin_cost != null ? ` · ${lqN(a.fin_cost)}` : ''}${a.fin_nbv != null ? ` · GTCL ${lqN(a.fin_nbv)}` : ''}${a.fin_as_of ? ` (${fmtDate(a.fin_as_of)})` : ''}` : t('acc.fs.temp')),
        el('dt', { textContent: t('ao.a.warranty') }), el('dd', {}, wIn),
        ...f('ao.a.label', a.label_printed ? '✓' : a.no_label ? t('col.no_label') : '✗'), ...f('ao.a.note', a.note)]));
    // Photos
    const ph = el('div', { className: 'aophotos' });
    body.append(el('h3', { textContent: t('ao.a.photos') }), ph);
    phLoad([a.id]).then(async ps => {
      if (!ps.length) { ph.append(el('div', { className: 'dim', textContent: t('ao.a.noPhoto') })); return; }
      for (const p of ps.slice(0, 12)) {
        const box = el('a', { className: 'aophoto', target: '_blank', rel: 'noopener', title: `${p.kind} · ${p.taken_name || ''} · ${fmtDateTime(p.taken_at)}` });
        if (p.source === 'link') { box.href = p.url; box.textContent = '🔗 ' + p.kind; }
        else { try { const u = await phUrl(p.storage_path); box.href = u; box.append(el('img', { src: u, alt: p.kind })); } catch { box.textContent = p.kind; } }
        ph.append(box);
      }
    }).catch(() => ph.append(el('div', { className: 'dim', textContent: t('ao.a.noPhoto') })));
    // Open incidents & transfers
    const openInc = (H.incidents || []).filter(i => ['open', 'in_progress'].includes(i.status));
    if (openInc.length) body.append(el('div', { className: 'msg warn' }, openInc.map(i => el('div', {}, [el('a', { href: '#', textContent: i.no, onclick: e => { e.preventDefault(); aoDrawerClose(); AO.inc.open = i.id; AO.inc.tab = 'open'; showView('incident'); } }),
      document.createTextNode(` · ${t('ao.inc.k.' + i.kind)} · ${t('ao.inc.st.' + i.status)} · ${i.description || ''}`)]))));
    const repairs = (H.incidents || []).filter(i => ['repair', 'breakage'].includes(i.kind) && i.status !== 'cancelled');
    if (repairs.length) body.append(el('div', { className: 'dim', textContent: t('ao.a.repairs', { n: repairs.length, c: lqN(repairs.reduce((s, i) => s + n0(i.cost), 0)) }) }));
    // Timeline
    body.append(el('h3', { textContent: t('ao.a.life') }));
    const tl = el('div', { className: 'aotl' });
    for (const e of H.events || []) tl.append(el('div', { className: 'aoev k-' + e.kind }, [el('span', { className: 'ic', textContent: AO_EV_ICON[e.kind] || '•' }),
      el('div', {}, [el('b', { textContent: aoEvTitle(e) }), el('div', { textContent: aoEvText(e) }), el('small', { textContent: [fmtDateTime(e.at), e.who].filter(Boolean).join(' · ') })])]));
    if (!(H.events || []).length) tl.append(el('div', { className: 'dim', textContent: t('ao.a.noEvents') }));
    body.append(tl);
  } catch (e) { $('#aoDrTitle').textContent = ''; msg(out, 'err', e.message); }
}
function aoEvTitle(e) { return t('ao.ev.' + e.kind) + (e.kind === 'transfer' || e.kind === 'incident' || e.kind === 'label' ? ' ' + ((e.data || {}).no || '') : e.kind === 'count' ? ' ' + ((e.data || {}).code || '') : ''); }
function aoEvText(e) {
  const d = e.data || {};
  const lbl = { status_code: 'ao.a.status', dept_code: 'pm.col.dept', location_code: 'ao.c.loc', asset_code: 'ao.c.code', qty: 'ao.a.qty', unit_price: 'ao.a.price',
                label_printed: 'ao.a.label', fin_status: 'ao.a.fin', fin_cost: 'col.fin_cost', warranty_until: 'ao.a.warranty', name_vi: 'ao.c.name' };
  const v = (k, x) => x == null || x === '' ? '—' : k === 'status_code' ? amStatusLabel(x) : k === 'fin_status' ? t('acc.fs.' + x) : k === 'label_printed' ? (x ? '✓' : '✗')
    : ['unit_price', 'fin_cost'].includes(k) ? lqN(x) : String(x);
  switch (e.kind) {
    case 'created': return [d.asset_code, d.dept_code, d.location_code, d.status_code && amStatusLabel(d.status_code)].filter(Boolean).join(' · ');
    case 'change': return Object.entries(d).map(([k, x]) => `${t(lbl[k] || k)}: ${v(k, x.o)} → ${v(k, x.n)}`).join(' · ');
    case 'intake': return [d.project_code, d.po && 'PO ' + d.po, d.supplier].filter(Boolean).join(' · ');
    case 'photo': return d.photo_kind || '';
    case 'transfer': return `${d.from} → ${d.to}${d.loc ? ' · ' + d.loc : ''} · ${t('ao.tf.st.' + d.status)}${d.new_code && d.new_code !== d.old_code ? ` · ${d.old_code} → ${d.new_code}` : ''}${d.qty != null ? ` · SL ${fmtNum(d.qty)}` : ''}`;
    case 'incident': return `${t('ao.inc.k.' + d.type)} · ${t('ao.inc.st.' + d.status)}${d.outcome ? ' · ' + t('ao.inc.o.' + d.outcome) : ''}${d.cost != null ? ' · ' + lqN(d.cost) : ''}${d.text ? ' — ' + d.text : ''}`;
    case 'count': return `${d.found ? t('lc.found') : t('lc.missing')}${d.qty != null ? ' · ' + t('col.qty') + ' ' + fmtNum(d.qty) : ''}${d.loc ? ' · ' + d.loc : ''}${d.cond ? ' · ' + t('ao.kk.cond.' + d.cond) : ''}${d.note ? ' — ' + d.note : ''}`;
    case 'liquidation': return [d.lr && 'LR ' + d.lr, d.batch, d.status, d.outcome, d.buyer, d.price != null ? lqN(d.price) : ''].filter(Boolean).join(' · ');
    case 'accounting': return [d.line, d.cost != null ? lqN(d.cost) : '', d.share != null ? Math.round(d.share * 1000) / 10 + '%' : '', d.status === 'gone' ? t('acc.d.ch.status', { o: 'active', n: 'gone' }) : ''].filter(Boolean).join(' · ');
    default: return '';
  }
}

/* ============================================================ WIRING */
function aoShow(view) {
  if (view === 'transfer') tfLoad();
  else if (view === 'incident') incLoad();
  else if (view === 'stock') kkLoad();
  else if (view === 'stockcount') scLoad();
  else if (view === 'amrep') repLoad();
}
window.aoShow = aoShow;
