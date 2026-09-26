/* ============================================================ CONTRACTS
   (34_contracts.sql) — the register of procurement contracts: Capex project
   contracts and yearly service / maintenance contracts (user 27/09/2026). Only
   the key terms a procurement procedure needs, each with the page it was read
   from, so the full signed document is one click away.

     register  every contract with its status and the next date that matters;
               a contract page: key terms, approval route, documents with an
               in-app viewer (stored file) or a OneDrive link.
     review    contracts waiting for my approval (the value decides the route:
               below the hotel limit the hotel signs; above it hotel review,
               then Legal, then JVC).
     alerts    contract / bond expiring, warranty ending, delivery overdue,
               payment milestone due — days set in am_setting ct_alert_days.
     import    the already-signed contracts, a whole folder at once.

   Reading the terms, three ways the user switches between (user decision):
     A  Claude chat — the app writes the prompt; the PDF goes into Claude; the
        JSON answer is pasted back.
     B  OCR in the browser (Tesseract) on the PAGES THE USER PICKS only, then
        rules that pick out number, dates, value, VAT, payment %, warranty,
        delivery and penalty; the page text is kept for searching.
     C  Claude API straight from the browser with the user's own key (kept in
        this browser only, never in the database).
   Whatever the way, the result fills the form as a draft to confirm.
   Loaded after app.js / assetops.js and uses their helpers. */

const CT = { tab: 'register', rows: [], files: [], inbox: [], alerts: [], open: null, edit: false, draft: null,
             q: '', f: { status: '', kind: '', scope: '' }, projects: null, vendors: null, money: new Map(), blobs: new Map(),
             page: null, viewer: null, flash: null, imp: null };
const CT_KINDS = ['supply', 'service', 'works', 'maintenance', 'framework', 'other'];
const CT_STATUS = ['draft', 'review', 'returned', 'approved', 'active', 'completed', 'closed', 'rejected', 'cancelled'];
const CT_BONDS = ['advance', 'performance', 'warranty', 'retention'];
const CT_FILE_KINDS = ['contract', 'annex', 'amendment', 'bond', 'acceptance', 'other'];
// The key terms, grouped as on the contract page. [field, type]; type drives the form and the view.
const CT_TERMS = [
  ['id', [['contract_no', 'text'], ['title', 'text'], ['kind', 'kind'], ['scope', 'scope'], ['dept_code', 'dept'], ['project_code', 'project'],
          ['supplier', 'vendor'], ['supplier_tax', 'text'], ['po_no', 'text']]],
  ['dates', [['signed_date', 'date'], ['start_date', 'date'], ['end_date', 'date'], ['delivery_due', 'date'], ['delivery_text', 'text']]],
  ['money', [['currency', 'text'], ['value_pre_vat', 'money'], ['vat_pct', 'num'], ['value_total', 'money']]],
  ['pay', [['pay_terms', 'pay']]],
  ['warranty', [['warranty_months', 'num'], ['warranty_start', 'text'], ['handover_date', 'date'], ['warranty_until', 'date']]],
  ['security', [['bonds', 'bonds']]],
  ['risk', [['penalty_text', 'area'], ['auto_renew', 'bool'], ['notice_days', 'num']]],
  ['other', [['summary', 'area'], ['legal_ref', 'text']]]];
const ctW = () => can('contract', 'create');
const ctEd = () => can('contract', 'edit');
const ctAdm = () => can('contract', 'admin');
const ctMissing = e => /pm_contract|pm_ct_|PGRST20[25]|does not exist|404/.test(String(e && e.message));
const ctErr = (out, e) => msg(out, 'err', ctMissing(e) ? t('ct.notInstalled') : e.message);
const ctRow = id => CT.rows.find(x => x.id === id) || null;
const ctChip = s => el('span', { className: 'ctst s-' + s, textContent: t('ct.st.' + s) });
const ctMoney = (v, cur) => v == null || v === '' ? '' : `${fmtNum(Math.round(Number(v)))}${cur && cur !== 'VND' ? ' ' + cur : ''}`;
const ctToday = () => new Date().toISOString().slice(0, 10);
const ctDays = d => d ? Math.round((new Date(d) - new Date(ctToday())) / 864e5) : null;
const ctVal = (c, f) => c ? c[f] : null;

async function ctLoad() {
  const out = $('#ctMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    const [rows, files, inbox, alerts] = await Promise.all([
      SB.select('pm_contract', 'select=*&order=id.desc&limit=2000'),
      SB.select('pm_contract_file', 'select=id,contract_id,kind,name,source,storage_path,url,size_bytes,pages,uploaded_name,created_at&order=id'),
      SB.rpc('pm_ct_inbox').catch(() => []), SB.rpc('pm_ct_alerts').catch(() => [])]);
    Object.assign(CT, { rows, files, inbox, alerts });
    if (!CT.projects) CT.projects = await SB.select('pm_project', 'select=code,name,year,dept_code&order=code').catch(() => []);
    if (!CT.vendors) CT.vendors = await SB.select('pm_vendor', 'select=code,name,tax_code&active=eq.true&order=name').catch(() => []);
    if (CT.pendingNo) { const c = rows.find(x => x.no === CT.pendingNo); if (c) { CT.tab = 'register'; CT.open = c.id; } CT.pendingNo = null; }
    msg(out, CT.flash ? 'ok' : '', CT.flash || ''); CT.flash = null;
    ctRender();
  } catch (e) { $('#ctBody').innerHTML = ''; ctErr(out, e); }
}
async function ctReload(flash) { CT.flash = flash || null; await ctLoad(); }

function ctRender() {
  const tabs = $('#ctTabs'), body = $('#ctBody');
  if (!tabs) return;
  const list = [['register', t('ct.t.register', { n: CT.rows.length })], ['review', t('ct.t.review', { n: CT.inbox.length })], ['alerts', t('ct.t.alerts', { n: CT.alerts.length })]];
  if (ctW()) list.push(['import', t('ct.t.import')]);
  if (!list.some(x => x[0] === CT.tab)) CT.tab = 'register';
  tabs.innerHTML = '';
  for (const [v, label] of list) {
    const b = el('button', { type: 'button', textContent: label });
    b.classList.toggle('on', CT.tab === v);
    b.onclick = () => { CT.tab = v; CT.open = null; CT.edit = false; ctRender(); };
    tabs.append(b);
  }
  body.innerHTML = '';
  if (CT.tab === 'register') return CT.open ? ctView(body, ctRow(CT.open)) : ctList(body);
  if (CT.tab === 'review') return ctList(body, CT.inbox.map(x => x.id));
  if (CT.tab === 'alerts') return ctAlertsTab(body);
  if (CT.tab === 'import') return ctImportTab(body);
}

/* ------------------------------------------------------------ register */
function ctNextDate(c) {
  const a = CT.alerts.filter(x => x.contract_id === c.id).sort((x, y) => String(x.due).localeCompare(String(y.due)))[0];
  return a ? el('span', { className: 'ctdue' + (a.days < 0 ? ' late' : ''), textContent: `${t('ct.a.' + a.kind)} ${fmtDate(a.due)}` }) : '';
}
function ctList(body, only) {
  const f = CT.f;
  const card = el('div', { className: 'card' });
  if (!only) {
    const live = CT.rows.filter(c => ['approved', 'active'].includes(c.status));
    const tile = (k, v, s, warn) => el('div', { className: 'aokpi' + (warn ? ' warn' : '') }, [el('small', { textContent: t(k) }), el('b', { textContent: v }), s ? el('span', { textContent: s }) : '']);
    body.append(el('div', { className: 'aokpis' }, [
      tile('ct.k.active', fmtInt(live.length), fmtM(live.reduce((a, c) => a + (Number(c.value_pre_vat || c.value_total) || 0) * (Number(c.fx_rate) || 1), 0))),
      tile('ct.k.review', fmtInt(CT.rows.filter(c => c.status === 'review').length), t('ct.k.mine', { n: CT.inbox.length })),
      tile('ct.k.alerts', fmtInt(CT.alerts.length), t('ct.k.alertsSub'), CT.alerts.length > 0),
      tile('ct.k.noFile', fmtInt(CT.rows.filter(c => !['cancelled', 'rejected'].includes(c.status) && !CT.files.some(x => x.contract_id === c.id)).length), t('ct.k.noFileSub'))]));
    const q = el('input', { value: CT.q, placeholder: t('ct.searchPh') });
    const st = el('select'); selFill(st, [['', t('ct.allStatus')], ...CT_STATUS.map(s => [s, t('ct.st.' + s)])]); st.value = f.status;
    const kd = el('select'); selFill(kd, [['', t('ct.allKinds')], ...CT_KINDS.map(s => [s, t('ct.kind.' + s)])]); kd.value = f.kind;
    const sc = el('select'); selFill(sc, [['', t('ct.allScope')], ['capex', t('ct.scope.capex')], ['opex', t('ct.scope.opex')]]); sc.value = f.scope;
    const go = () => { CT.q = q.value.trim(); Object.assign(f, { status: st.value, kind: kd.value, scope: sc.value }); ctRender(); };
    q.onkeydown = e => { if (e.key === 'Enter') go(); }; st.onchange = kd.onchange = sc.onchange = go;
    const row = el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, [el('label', { textContent: t('ct.search') }), q]),
      el('div', { className: 'fld' }, [el('label', { textContent: t('ct.c.status') }), st]), el('div', { className: 'fld' }, [el('label', { textContent: t('ct.c.kind') }), kd]),
      el('div', { className: 'fld' }, [el('label', { textContent: t('ct.c.scope') }), sc])]);
    if (ctW()) row.append(el('button', { className: 'btn pri', type: 'button', textContent: '+ ' + t('ct.new'), onclick: ctNew }));
    card.append(row);
  }
  const words = hnorm(CT.q).split(/\s+/).filter(Boolean);
  const text = c => hnorm([c.no, c.contract_no, c.title, c.supplier, c.project_code, c.dept_code, c.po_no, c.summary,
    ...CT.files.filter(x => x.contract_id === c.id).map(x => x.name)].join(' '));
  const rows = CT.rows.filter(c => (!only || only.includes(c.id)) && (only || ((!f.status || c.status === f.status) && (!f.kind || c.kind === f.kind)
    && (!f.scope || c.scope === f.scope) && words.every(w => text(c).includes(w)))));
  const tb = el('table', { className: 'lqbt' });
  tb.append(el('tr', {}, [['ct.c.no'], ['ct.f.contract_no'], ['ct.f.title'], ['ct.f.supplier'], ['ct.f.project_code'], ['ct.f.value_pre_vat', 'num'],
    ['ct.f.signed_date'], ['ct.f.end_date'], ['ct.c.next'], ['ct.c.status']].map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
  for (const c of rows) {
    const nf = CT.files.filter(x => x.contract_id === c.id).length;
    const tr = el('tr', { className: 'aoclick' }, [el('td', {}, el('code', { textContent: c.no })), el('td', { textContent: c.contract_no || '' }),
      el('td', { className: 'aowrap' }, [document.createTextNode(c.title || ''), nf ? el('span', { className: 'ctfiles', title: t('ct.nFiles', { n: nf }), textContent: '📎' + nf }) : '']),
      el('td', { className: 'aowrap', textContent: c.supplier || '' }), el('td', {}, c.project_code ? el('code', { textContent: c.project_code }) : el('span', { className: 'dim', textContent: t('ct.scope.' + c.scope) })),
      el('td', { className: 'num', textContent: ctMoney(c.value_pre_vat ?? c.value_total, c.currency) }),
      el('td', { textContent: fmtDate(c.signed_date || '') }), el('td', { textContent: fmtDate(c.end_date || '') }), el('td', {}, ctNextDate(c)), el('td', {}, ctChip(c.status))]);
    tr.onclick = () => { CT.tab = 'register'; CT.open = c.id; CT.edit = false; CT.draft = null; ctRender(); };
    tb.append(tr);
  }
  card.append(rows.length ? el('div', { className: 'wrap' }, tb) : el('div', { className: 'dim', textContent: only ? t('ct.inboxEmpty') : t('pm.none.filter') }));
  body.append(card);
}

async function ctNew() {
  try {
    const id = await SB.rpc('pm_ct_save', { p: { kind: 'supply', scope: 'capex', currency: 'VND' } });
    CT.open = id; CT.edit = true; CT.draft = null;
    await ctReload(t('ct.created'));
  } catch (e) { ctErr('#ctMsg', e); }
}

/* ------------------------------------------------------------ one contract */
function ctView(body, c) {
  if (!c) { CT.open = null; return ctList(body); }
  const out = el('div');
  const acts = [el('button', { className: 'btn', type: 'button', textContent: '← ' + t('ct.back'), onclick: () => { CT.open = null; CT.edit = false; CT.draft = null; ctRender(); } })];
  const canEditTerms = ctW() && c.status !== 'cancelled';
  if (canEditTerms) acts.push(el('button', { className: 'btn' + (CT.edit ? ' on' : ''), type: 'button', textContent: '✎ ' + t('ct.editTerms'), onclick: () => { CT.edit = !CT.edit; CT.draft = null; ctRender(); } }));
  const act = (label, fn, cls = 'btn') => acts.push(el('button', { className: cls, type: 'button', textContent: label, onclick: fn }));
  const setSt = async (s, askNote) => {
    const note = askNote ? prompt(t('ct.noteQ')) : null;
    if (askNote && note === null) return;
    try { await SB.rpc('pm_ct_set_status', { p_id: c.id, p_status: s, p_comment: note || null }); await ctReload(t('ct.stSet', { s: t('ct.st.' + s) })); } catch (e) { ctErr(out, e); } };
  if (ctW() && ['draft', 'returned'].includes(c.status) && c.source !== 'import') act('📨 ' + t('ct.submit'), async () => {
    if (!confirm(t('ct.submitQ', { no: c.no, route: ctRouteText(c) }))) return;
    try { await SB.rpc('pm_ct_submit', { p_id: c.id }); await ctReload(t('ct.submitted')); } catch (e) { ctErr(out, e); } }, 'btn pri');
  if (ctEd() && (c.status === 'approved' || (c.source === 'import' && ['draft', 'returned'].includes(c.status)))) act('✔ ' + t('ct.markActive'), () => setSt('active'), 'btn pri');
  if (ctEd() && c.status === 'active') act(t('ct.markCompleted'), () => setSt('completed'));
  if (ctEd() && ['active', 'completed'].includes(c.status)) act(t('ct.markClosed'), () => setSt('closed', true));
  if (ctEd() && ['draft', 'returned', 'approved', 'active'].includes(c.status)) act(t('ct.cancel'), () => { if (confirm(t('ct.cancelQ', { no: c.no }))) setSt('cancelled', true); }, 'btn danger tiny');
  if (ctEd() && ['cancelled', 'rejected'].includes(c.status)) act(t('ct.reopen'), () => setSt('draft'));
  const mine = CT.inbox.some(x => x.id === c.id);
  const head = el('div', { className: 'card' }, [
    el('div', { className: 'chead' }, [el('h2', {}, [document.createTextNode(`${c.no}${c.contract_no ? ' · ' + c.contract_no : ''} `), ctChip(c.status)])]),
    el('div', { className: 'row mtacts' }, acts), out]);
  if (c.title || c.supplier) head.append(el('div', { className: 'ctsub', textContent: [c.title, c.supplier, c.project_code].filter(Boolean).join(' · ') }));
  if (c.route && c.route.length) head.append(ctRouteView(c));
  if (mine) head.append(ctActBox(c));
  body.append(head);
  const grid = el('div', { className: 'ctgrid' });
  const left = el('div'), right = el('div');
  left.append(CT.edit && canEditTerms ? ctForm(c) : ctTermsView(c));
  right.append(ctDocs(c));
  if (canEditTerms) right.append(ctReadBox(c));
  grid.append(left, right);
  body.append(grid);
}

function ctRouteText(c) {
  const lim = 1e9, amt = (Number(c.value_pre_vat ?? c.value_total) || 0) * (Number(c.fx_rate) || 1);
  return amt >= lim ? t('ct.routeBig') : t('ct.routeSmall');
}
function ctRouteView(c) {
  return el('div', { className: 'aochain' }, (c.route || []).map((s, i) => {
    const done = s.action === 'approve', bad = ['return', 'reject', 'cancelled'].includes(s.action), now = c.status === 'review' && c.cur === i;
    return el('div', { className: 'aostep' + (done ? ' ok' : bad ? ' bad' : now ? ' now' : '') }, [
      el('b', { textContent: (s.roles || []).map(wfRoleName).join(' / ') || t('ct.st.' + s.key) }),
      el('small', { textContent: t('ct.side.' + (s.side || 'other')) }),
      s.name ? el('div', { textContent: `${s.action === 'approve' ? '✓' : s.action === 'return' ? '↩' : s.action === 'reject' ? '✗' : '•'} ${s.name} · ${fmtDateTime(s.at)}` }) : '',
      s.comment ? el('i', { textContent: '“' + s.comment + '”' }) : '']);
  }));
}
function ctActBox(c) {
  const note = el('input', { placeholder: t('ct.commentPh') }), out = el('div');
  const go = async a => {
    if (a !== 'approve' && !note.value.trim()) return msg(out, 'err', t('ct.needReason'));
    try { const s = await SB.rpc('pm_ct_act', { p_id: c.id, p_action: a, p_comment: note.value.trim() || null }); await ctReload(t('ct.acted.' + a, { s: t('ct.st.' + s) })); }
    catch (e) { ctErr(out, e); } };
  return el('div', { className: 'ctact' }, [el('b', { textContent: t('ct.yourTurn') }), el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, note),
    el('button', { className: 'btn pri', type: 'button', textContent: t('ao.tf.approve'), onclick: () => go('approve') }),
    el('button', { className: 'btn', type: 'button', textContent: t('ao.tf.return'), onclick: () => go('return') }),
    el('button', { className: 'btn danger', type: 'button', textContent: t('ao.tf.reject'), onclick: () => go('reject') })]), out]);
}

// The key terms, each with the page it came from (click → the document opens at that page).
function ctTermsView(c) {
  const card = el('div', { className: 'card ctterms' }, [el('h2', { textContent: t('ct.termsH') })]);
  const pages = c.terms_pages || {};
  const pg = f => pages[f] ? el('button', { className: 'ctpg', type: 'button', title: t('ct.openPage'), textContent: `p.${pages[f]}`, onclick: () => ctOpenPage(c, pages[f]) }) : '';
  for (const [grp, fields] of CT_TERMS) {
    const dl = el('dl', { className: 'aodl' });
    for (const [f, ty] of fields) {
      let v = c[f];
      if (ty === 'pay') { if ((v || []).length) dl.append(el('dt', {}, [document.createTextNode(t('ct.f.' + f)), pg(f)]), el('dd', {}, ctPayTable(c, v))); continue; }
      if (ty === 'bonds') { if ((v || []).length) dl.append(el('dt', {}, [document.createTextNode(t('ct.f.' + f)), pg(f)]), el('dd', {}, ctBondList(v))); continue; }
      if (v == null || v === '' || (ty === 'bool' && !v)) continue;
      const txt = ty === 'date' ? fmtDate(v) : ty === 'money' ? ctMoney(v, c.currency) : ty === 'kind' ? t('ct.kind.' + v) : ty === 'scope' ? t('ct.scope.' + v)
        : ty === 'dept' ? `${v} — ${pmDeptName(v)}` : ty === 'bool' ? t('ct.yes') : ty === 'num' && f === 'vat_pct' ? v + '%' : f === 'warranty_months' ? t('ct.months', { n: v })
        : f === 'notice_days' ? t('ct.days', { n: v }) : String(v);
      const dd = el('dd', { className: ty === 'area' ? 'mttext' : '' }, [document.createTextNode(txt)]);
      if (f === 'warranty_until' || f === 'end_date' || f === 'delivery_due') { const d = ctDays(v); if (d != null && d < 60) dd.append(el('span', { className: 'ctdue' + (d < 0 ? ' late' : ''), textContent: d < 0 ? t('ct.ago', { n: -d }) : t('ct.inDays', { n: d }) })); }
      if (f === 'project_code') dd.append(el('a', { className: 'aolink', href: '#', textContent: ' ↗', onclick: e => { e.preventDefault(); PM.prj.open = v; showView('projects'); } }));
      dl.append(el('dt', {}, [document.createTextNode(t('ct.f.' + f)), pg(f)]), dd);
    }
    if (dl.children.length) card.append(el('h3', { textContent: t('ct.g.' + grp) }), dl);
  }
  if (card.children.length === 1) card.append(el('div', { className: 'dim', textContent: t('ct.noTerms') }));
  if (c.terms_src) card.append(el('div', { className: 'dim ctsrc', textContent: t('ct.src.' + c.terms_src) }));
  // What the Payments module has paid on the project (21_pm_payment.sql).
  if (c.project_code) {
    const box = el('div', { className: 'ctpaid' }); card.append(box);
    SB.select('pm_project_money', `select=project_code,invoiced_gross,paid_gross,last_paid&project_code=eq.${encodeURIComponent(c.project_code)}`).then(r => {
      const m = r[0]; if (!m) return;
      const tot = Number(c.value_total || c.value_pre_vat) * (Number(c.fx_rate) || 1);
      box.append(el('b', { textContent: t('ct.paidH') }), document.createTextNode(' ' + t('ct.paid', { inv: fmtNum(Math.round(m.invoiced_gross || 0)), paid: fmtNum(Math.round(m.paid_gross || 0)),
        pct: tot ? Math.round((m.paid_gross || 0) / tot * 100) : '—', d: fmtDate(String(m.last_paid || '').slice(0, 10)) })));
    }).catch(() => {});
  }
  return card;
}
function ctPayTable(c, v) {
  const tb = el('table', { className: 'lqbt ctmini' });
  tb.append(el('tr', {}, [t('ct.p.milestone'), '%', t('ct.p.amount'), t('ct.p.condition'), t('ct.p.due')].map(x => el('th', { textContent: x }))));
  for (const p of v) tb.append(el('tr', {}, [el('td', { textContent: p.milestone || '' }), el('td', { className: 'num', textContent: p.pct != null && p.pct !== '' ? p.pct + '%' : '' }),
    el('td', { className: 'num', textContent: ctMoney(p.amount ?? (p.pct != null && c.value_total ? Number(c.value_total) * Number(p.pct) / 100 : null), c.currency) }),
    el('td', { className: 'aowrap', textContent: p.condition || '' }), el('td', { textContent: /^\d{4}-/.test(p.due || '') ? fmtDate(p.due) : (p.due || '') })]));
  return tb;
}
const ctBondList = v => el('div', {}, v.map(b => el('div', { textContent: `${t('ct.bond.' + (b.kind || 'performance'))}${b.pct ? ' · ' + b.pct + '%' : ''}${b.amount ? ' · ' + ctMoney(b.amount) : ''}${b.expiry ? ' · ' + t('ct.until', { d: fmtDate(b.expiry) }) : ''}${b.issuer ? ' · ' + b.issuer : ''}` })));

// The form: every key term, the page it is on (small box), found values from a reading shown yellow.
function ctForm(c) {
  const d = CT.draft || {};
  const src = Object.assign({}, c, d.values || {});
  const pages = Object.assign({}, c.terms_pages || {}, d.pages || {});
  const found = new Set(Object.keys(d.values || {}));
  const card = el('div', { className: 'card ctterms ctform' }, [el('h2', { textContent: t('ct.termsH') })]);
  if (d.note) card.append(el('div', { className: 'msg info', textContent: d.note }));
  const inputs = {}, pgIn = {};
  let dl = document.getElementById('ctPrjList');
  if (!dl) { dl = el('datalist', { id: 'ctPrjList' }); document.body.append(dl); }
  dl.innerHTML = ''; for (const p of CT.projects || []) dl.append(el('option', { value: p.code, label: `${p.year} · ${p.name || ''}` }));
  let vl = document.getElementById('ctVendorList');
  if (!vl) { vl = el('datalist', { id: 'ctVendorList' }); document.body.append(vl); }
  vl.innerHTML = ''; for (const v of CT.vendors || []) vl.append(el('option', { value: v.name, label: v.code }));
  const payRows = el('div'), bondRows = el('div');
  const addPay = p => { const r = el('div', { className: 'ctline' }, [el('input', { value: p.milestone || '', placeholder: t('ct.p.milestone') }), el('input', { value: p.pct ?? '', placeholder: '%', className: 'num' }),
    el('input', { value: p.amount ?? '', placeholder: t('ct.p.amount'), className: 'num' }), el('input', { value: p.condition || '', placeholder: t('ct.p.condition') }),
    el('input', { value: p.due || '', placeholder: t('ct.p.duePh') }), el('button', { className: 'xbtn', type: 'button', textContent: '✕', onclick: () => r.remove() })]); payRows.append(r); };
  const addBond = b => { const k = el('select'); selFill(k, CT_BONDS.map(x => [x, t('ct.bond.' + x)])); k.value = b.kind || 'performance';
    const r = el('div', { className: 'ctline' }, [k, el('input', { value: b.pct ?? '', placeholder: '%', className: 'num' }), el('input', { value: b.amount ?? '', placeholder: t('ct.p.amount'), className: 'num' }),
      el('input', { type: 'date', value: b.expiry || '' }), el('input', { value: b.issuer || '', placeholder: t('ct.b.issuer') }), el('button', { className: 'xbtn', type: 'button', textContent: '✕', onclick: () => r.remove() })]); bondRows.append(r); };
  for (const [grp, fields] of CT_TERMS) {
    card.append(el('h3', { textContent: t('ct.g.' + grp) }));
    const g = el('div', { className: 'ctfgrid' });
    for (const [f, ty] of fields) {
      const lock = ['dept_code', 'currency', 'value_pre_vat', 'vat_pct', 'value_total'].includes(f) && !['draft', 'returned'].includes(c.status) && !ctAdm();
      let x;
      if (ty === 'pay') { for (const p of src.pay_terms || []) addPay(p); x = el('div', { className: 'wide' }, [payRows, el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('ct.p.add'), onclick: () => addPay({}) })]); }
      else if (ty === 'bonds') { for (const b of src.bonds || []) addBond(b); x = el('div', { className: 'wide' }, [bondRows, el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('ct.b.add'), onclick: () => addBond({}) })]); }
      else if (ty === 'kind' || ty === 'scope' || ty === 'dept') {
        x = el('select');
        selFill(x, ty === 'kind' ? CT_KINDS.map(k => [k, t('ct.kind.' + k)]) : ty === 'scope' ? [['capex', t('ct.scope.capex')], ['opex', t('ct.scope.opex')]]
          : [['', '—'], ...PM.orgs.filter(o => o.is_department).map(o => [o.code, `${o.code} — ${pmDeptName(o.code)}`])]);
        x.value = src[f] || (ty === 'kind' ? 'supply' : ty === 'scope' ? 'capex' : '');
      } else if (ty === 'area') x = el('textarea', { rows: 2, value: src[f] || '' });
      else if (ty === 'bool') x = el('input', { type: 'checkbox', checked: !!src[f] });
      else { x = el('input', { type: ty === 'date' ? 'date' : 'text', value: src[f] ?? '' });
        if (ty === 'project') x.setAttribute('list', 'ctPrjList'); if (ty === 'vendor') x.setAttribute('list', 'ctVendorList');
        if (ty === 'money' || ty === 'num') { x.inputMode = 'decimal'; x.classList.add('num'); if (ty === 'money' && src[f] != null && src[f] !== '') x.value = fmtNum(src[f]); } }
      x.disabled = lock;
      inputs[f] = x;
      const p = el('input', { className: 'ctpgin', value: pages[f] || '', title: t('ct.pageOf'), placeholder: 'p.' });
      pgIn[f] = p;
      g.append(el('div', { className: 'fld' + (['pay', 'bonds', 'area'].includes(ty) ? ' wide' : '') + (found.has(f) ? ' ctfound' : '') }, [
        el('label', {}, [document.createTextNode(t('ct.f.' + f)), p]), x]));
    }
    card.append(g);
  }
  const out = el('div');
  const save = async () => {
    const p = { id: c.id };
    for (const [, fields] of CT_TERMS) for (const [f, ty] of fields) {
      const x = inputs[f];
      if (ty === 'pay') { p.pay_terms = [...payRows.children].map(r => { const v = [...r.querySelectorAll('input')].map(i => i.value.trim());
        return { milestone: v[0], pct: numIn(v[1]), amount: numIn(v[2]), condition: v[3], due: /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v[4]) ? v[4].split('/').reverse().map((s, i) => i ? s.padStart(2, '0') : s).join('-') : v[4] }; })
        .filter(r => r.milestone || r.pct != null || r.amount != null || r.condition); continue; }
      if (ty === 'bonds') { p.bonds = [...bondRows.children].map(r => { const [k] = r.querySelectorAll('select'); const v = [...r.querySelectorAll('input')].map(i => i.value.trim());
        return { kind: k.value, pct: numIn(v[0]), amount: numIn(v[1]), expiry: v[2] || null, issuer: v[3] }; }).filter(b => b.pct != null || b.amount != null || b.expiry); continue; }
      if (ty === 'bool') { p[f] = x.checked; continue; }
      p[f] = ty === 'money' || ty === 'num' ? (numIn(x.value) ?? '') : x.value.trim();
    }
    if (p.supplier) { const v = (CT.vendors || []).find(v => hnorm(v.name) === hnorm(p.supplier)); if (v) p.vendor_code = v.code; }
    if (p.project_code && !(CT.projects || []).some(x => x.code === p.project_code)) return msg(out, 'err', t('ct.noProject', { c: p.project_code }));
    if (p.project_code && !p.dept_code) p.dept_code = ((CT.projects || []).find(x => x.code === p.project_code) || {}).dept_code || '';
    p.terms_pages = Object.fromEntries(Object.entries(pgIn).map(([f, i]) => [f, parseInt(i.value.replace(/\D/g, ''), 10)]).filter(([, n]) => n > 0));
    if (d.src) p.terms_src = d.src;
    try { await SB.rpc('pm_ct_save', { p }); CT.edit = false; CT.draft = null; await ctReload(t('ct.saved')); } catch (e) { ctErr(out, e); }
  };
  card.append(el('div', { className: 'row' }, [el('button', { className: 'btn', type: 'button', textContent: t('mt.cancel'), onclick: () => { CT.edit = false; CT.draft = null; ctRender(); } }),
    el('button', { className: 'btn pri', type: 'button', textContent: t('tool.save'), onclick: save })]), out);
  return card;
}

/* ------------------------------------------------------------ documents & viewer */
async function ctBlob(f) {
  if (CT.blobs.has(f.id)) return CT.blobs.get(f.id);
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/authenticated/pm-contract/${f.storage_path.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  const b = await r.blob();
  const v = { blob: b, url: URL.createObjectURL(b) };
  CT.blobs.set(f.id, v);
  return v;
}
// The main document: the first "contract" file, else the first file.
const ctMainFile = c => { const fs = CT.files.filter(x => x.contract_id === c.id); return fs.find(x => x.kind === 'contract') || fs[0] || null; };
async function ctOpenPage(c, page) {
  const f = ctMainFile(c);
  if (!f) return msg('#ctMsg', 'warn', t('ct.noDoc'));
  if (f.source === 'link') { window.open(f.url, '_blank', 'noopener'); return msg('#ctMsg', 'info', t('ct.linkPage', { p: page })); }
  CT.page = { file: f.id, page };
  ctShowViewer(c);
}
async function ctShowViewer(c) {
  const host = document.getElementById('ctViewer'); if (!host) return;
  const f = CT.files.find(x => x.id === (CT.page || {}).file) || ctMainFile(c);
  if (!f || f.source !== 'storage') { host.innerHTML = ''; return; }
  host.innerHTML = '';
  host.append(el('div', { className: 'dim', textContent: t('table.loading') }));
  try {
    const { url, blob } = await ctBlob(f);
    host.innerHTML = '';
    const pdf = /pdf/i.test(blob.type) || /\.pdf$/i.test(f.name || f.storage_path);
    const p = (CT.page && CT.page.file === f.id && CT.page.page) || 1;
    host.append(el('div', { className: 'ctvbar' }, [el('b', { textContent: f.name || f.storage_path }), pdf ? el('span', { className: 'dim', textContent: ' · ' + t('ct.page', { p }) }) : '',
      el('a', { className: 'btn tiny', href: url, target: '_blank', rel: 'noopener', textContent: '↗ ' + t('ct.openFull') })]),
      pdf ? el('iframe', { className: 'ctframe', src: `${url}#page=${p}&view=FitH`, title: f.name || 'document' })
          : /image/.test(blob.type) ? el('img', { className: 'ctimg', src: url }) : el('div', { className: 'dim', textContent: t('ct.noPreview') }));
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) { host.innerHTML = ''; host.append(el('div', { className: 'msg err', textContent: e.message })); }
}
function ctDocs(c) {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('ct.docsH') })]);
  const fs = CT.files.filter(x => x.contract_id === c.id);
  const out = el('div');
  if (!fs.length) card.append(el('div', { className: 'dim', textContent: t('ct.noDoc') }));
  for (const f of fs) {
    const row = el('div', { className: 'ctdoc' }, [el('span', { className: 'ctst', textContent: t('ct.fk.' + f.kind) }),
      el('a', { href: f.source === 'link' ? f.url : '#', target: f.source === 'link' ? '_blank' : '', rel: 'noopener', className: 'aolink', textContent: f.name || f.url || f.storage_path,
        onclick: f.source === 'storage' ? e => { e.preventDefault(); CT.page = { file: f.id, page: 1 }; ctShowViewer(c); } : null }),
      el('small', { className: 'dim', textContent: [f.source === 'link' ? 'OneDrive' : f.size_bytes ? (f.size_bytes / 1048576).toFixed(1) + ' MB' : '', f.pages ? t('ct.nPages', { n: f.pages }) : '', f.uploaded_name].filter(Boolean).join(' · ') })]);
    if (ctEd()) row.append(el('button', { className: 'xbtn', type: 'button', title: t('ct.delFile'), textContent: '✕', onclick: async () => {
      if (!confirm(t('ct.delFileQ', { n: f.name || '' }))) return;
      try {
        const path = await SB.rpc('pm_ct_file_del', { p_id: f.id });
        if (path) { const tok = await authToken(); await fetch(`${CFG.url}/storage/v1/object/pm-contract/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok } }).catch(() => {}); }
        await ctReload(t('ct.fileDeleted'));
      } catch (e) { ctErr(out, e); } } }));
    card.append(row);
  }
  if (ctW() && c.status !== 'cancelled') {
    const kind = el('select'); selFill(kind, CT_FILE_KINDS.map(k => [k, t('ct.fk.' + k)]));
    const file = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,.doc,.docx', hidden: true });
    const link = el('input', { placeholder: t('ct.linkPh') });
    file.onchange = async () => { const fl = file.files[0]; file.value = ''; if (fl) { try { await ctUpload(c, fl, kind.value, out); await ctReload(t('ct.uploaded', { n: fl.name })); } catch (e) { ctErr(out, e); } } };
    card.append(el('div', { className: 'row ctaddfile' }, [el('div', { className: 'fld' }, kind), file,
      el('button', { className: 'btn tiny', type: 'button', textContent: '⬆ ' + t('ct.upload'), onclick: () => file.click() }),
      el('div', { className: 'fld grow' }, link),
      el('button', { className: 'btn tiny', type: 'button', textContent: '🔗 ' + t('ct.addLink'), onclick: async () => {
        if (!/^https:\/\//i.test(link.value.trim())) return msg(out, 'err', t('ph.badLink'));
        try { await SB.rpc('pm_ct_file_add', { p: { contract_id: c.id, kind: kind.value, source: 'link', url: link.value.trim(), name: decodeURIComponent(link.value.trim().split('/').pop().split('?')[0]) || 'OneDrive' } });
              await ctReload(t('ct.linked')); } catch (e) { ctErr(out, e); } } })]),
      el('div', { className: 'tdnote', textContent: t('ct.storeHint') }));
  }
  card.append(out, el('div', { id: 'ctViewer', className: 'ctviewer' }));
  setTimeout(() => ctShowViewer(c));
  return card;
}
async function ctUpload(c, fl, kind, out) {
  if (fl.size > 25 * 1048576) throw new Error(t('ct.tooBig'));
  msg(out, 'info', t('ct.uploading', { n: fl.name }));
  const safe = fl.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  const path = `${c.id}/${Date.now()}-${safe}`;
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/pm-contract/${path}`, { method: 'POST',
    headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok, 'Content-Type': fl.type || 'application/pdf', 'x-upsert': 'false' }, body: fl });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
  let pages = null;
  if (/pdf/i.test(fl.type) || /\.pdf$/i.test(fl.name)) { try { const doc = await ctPdf(fl); pages = doc.numPages; } catch {} }
  return SB.rpc('pm_ct_file_add', { p: { contract_id: c.id, kind, name: fl.name, source: 'storage', storage_path: path, size_bytes: fl.size, pages } });
}

/* ------------------------------------------------------------ reading the key terms (A / B / C) */
// Libraries on demand: pdf.js (page images, page count), Tesseract (OCR), the Anthropic SDK.
async function ctLib(name) {
  if (name === 'pdf' && !window.pdfjsLib) {
    await new Promise((ok, no) => { const s = el('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' }); s.onload = ok; s.onerror = () => no(new Error('pdf.js')); document.head.append(s); });
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  if (name === 'ocr' && !window.Tesseract)
    await new Promise((ok, no) => { const s = el('script', { src: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js' }); s.onload = ok; s.onerror = () => no(new Error('tesseract.js')); document.head.append(s); });
}
async function ctPdf(blob) { await ctLib('pdf'); return pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; }
async function ctPageCanvas(doc, n, width) {
  const pg = await doc.getPage(n), vp0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: width / vp0.width });
  const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  return cv;
}
// The PDF to read: the stored main document, or a file picked from the computer (not stored).
async function ctSourceBlob(c, pick) {
  if (pick && pick.files && pick.files[0]) return pick.files[0];
  const f = ctMainFile(c);
  if (!f) throw new Error(t('ct.r.noFile'));
  if (f.source !== 'storage') throw new Error(t('ct.r.linkOnly'));
  return (await ctBlob(f)).blob;
}

// Structured-output schema (C) and the JSON shape asked of Claude chat (A).
const CT_SCHEMA = (() => {
  const S = { type: ['string', 'null'] }, N = { type: ['number', 'null'] }, I = { type: ['integer', 'null'] };
  const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
  return obj({
    contract_no: S, title: S, supplier: S, supplier_tax: S, signed_date: S, start_date: S, end_date: S, delivery_due: S, delivery_text: S,
    currency: S, value_pre_vat: N, vat_pct: N, value_total: N,
    pay_terms: { type: 'array', items: obj({ milestone: S, pct: N, amount: N, condition: S }) },
    warranty_months: I, warranty_start: S,
    bonds: { type: 'array', items: obj({ kind: { type: ['string', 'null'], enum: [...CT_BONDS, null] }, pct: N, amount: N, expiry: S }) },
    penalty_text: S, auto_renew: { type: ['boolean', 'null'] }, notice_days: I, summary: S,
    pages: { type: 'array', items: obj({ field: { type: 'string' }, page: { type: 'integer' } }) },
    uncertain: { type: 'array', items: { type: 'string' } } });
})();
const CT_PROMPT = `You read a PROCUREMENT CONTRACT of Plaza Hotel Company Limited (Sofitel Saigon Plaza / Central Plaza, Vietnam). The hotel company is the BUYER; the other party is the supplier / contractor. The contract is usually bilingual Vietnamese / English and may be a scan. Extract ONLY what is written — never guess. Dates as YYYY-MM-DD; money as plain numbers in the contract currency (VND unless stated); percentages as numbers (30 for 30%).

Fields:
- contract_no: the contract number as printed ("Số / No.").
- title: the contract type and subject in a few words (e.g. "Sales contract — retarder proofer 18 trays").
- supplier, supplier_tax: the supplier's legal name and tax code (NOT the hotel's).
- signed_date; start_date / end_date: validity period if stated; delivery_due: a delivery / completion date if a fixed date is stated, else null and put the wording in delivery_text (e.g. "16–18 weeks after signing and 1st payment").
- currency, value_pre_vat, vat_pct, value_total (with VAT).
- pay_terms: each installment: milestone (Deposit / Progress / Handover / Retention or the contract's wording), pct, amount, condition (short).
- warranty_months and warranty_start ("delivery", "acceptance" or the wording).
- bonds: advance-payment, performance, warranty guarantees or retention: kind, pct, amount, expiry.
- penalty_text: the late-delivery penalty in one line (rate and cap), plus any other penalty worth knowing.
- auto_renew, notice_days: automatic renewal and termination / renewal notice period, if any.
- summary: one or two sentences on scope and anything unusual a procurement officer must know.
- pages: for every field you filled, the 1-based PDF page it is on.
- uncertain: the fields you are not sure about (hand-written, blurred, conflicting).`;

// Found values → the form draft (yellow), with the pages.
function ctApplyFound(c, j, src, note) {
  const v = {}, pages = {};
  const put = (f, x) => { if (x != null && x !== '' && !(Array.isArray(x) && !x.length)) v[f] = x; };
  for (const f of ['contract_no', 'title', 'supplier', 'supplier_tax', 'signed_date', 'start_date', 'end_date', 'delivery_due', 'delivery_text', 'currency',
                   'value_pre_vat', 'vat_pct', 'value_total', 'warranty_months', 'warranty_start', 'penalty_text', 'notice_days', 'summary']) put(f, j[f]);
  if (j.auto_renew) v.auto_renew = true;
  if (Array.isArray(j.pay_terms)) put('pay_terms', j.pay_terms.filter(p => p && (p.pct != null || p.amount != null || p.milestone)));
  if (Array.isArray(j.bonds)) put('bonds', j.bonds.filter(b => b && (b.pct != null || b.amount != null || b.expiry)));
  for (const p of j.pages || []) if (p && p.field && p.page) pages[p.field] = p.page;
  if (j.pages && !Array.isArray(j.pages)) Object.assign(pages, j.pages);
  for (const f of ['signed_date', 'start_date', 'end_date', 'delivery_due']) if (v[f] && !/^\d{4}-\d{2}-\d{2}$/.test(v[f])) delete v[f];
  const unsure = (j.uncertain || []).filter(Boolean);
  CT.draft = { values: v, pages, src, note: [note, unsure.length ? t('ct.r.unsure', { f: unsure.map(f => t('ct.f.' + f)).join(', ') }) : ''].filter(Boolean).join('\n') };
  CT.edit = true; ctRender();
}
const ctParseJson = s => JSON.parse(String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());

function ctReadBox(c) {
  const mode = (() => { try { return localStorage.getItem('ct.read') || 'A'; } catch { return 'A'; } })();
  const card = el('div', { className: 'card ctread' });
  const seg = el('div', { className: 'seg permtabs' }, ['A', 'B', 'C'].map(k => el('button', { type: 'button', className: k === mode ? 'on' : '', textContent: t('ct.r.m' + k),
    onclick: () => { try { localStorage.setItem('ct.read', k); } catch {} ctRender(); } })));
  card.append(el('div', { className: 'chead' }, [el('h2', { textContent: t('ct.r.h') }), seg]));
  const out = el('div'), body = el('div');
  card.append(el('p', { textContent: t('ct.r.hint' + mode) }), body, out);
  const pick = el('input', { type: 'file', accept: '.pdf' });
  const pickRow = el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, [el('label', { textContent: t(ctMainFile(c) && ctMainFile(c).source === 'storage' ? 'ct.r.orPick' : 'ct.r.pick') }), pick])]);
  if (mode === 'A') {
    const ta = el('textarea', { rows: 6, className: 'prjson', placeholder: t('ct.r.pastePh') });
    body.append(el('div', { className: 'row' }, [el('button', { className: 'btn', type: 'button', textContent: t('pr.copyPrompt'), onclick: async () => {
      const text = CT_PROMPT + '\n\nAnswer with JSON only, exactly this shape (null where not stated):\n' + JSON.stringify(ctSchemaExample(), null, 1);
      try { await navigator.clipboard.writeText(text); msg(out, 'ok', t('ct.r.copied')); } catch { ta.value = text; msg(out, 'warn', t('pr.copyFail')); } } })]),
      ta, el('div', { className: 'row' }, el('button', { className: 'btn pri', type: 'button', textContent: t('ct.r.apply'), onclick: () => {
        try { ctApplyFound(c, ctParseJson(ta.value), 'claude', t('ct.r.fromA')); } catch (e) { msg(out, 'err', t('pr.jsonBad', { e: e.message })); } } })));
  }
  if (mode === 'B') {
    const thumbs = el('div', { className: 'ctthumbs' });
    const load = el('button', { className: 'btn', type: 'button', textContent: t('ct.r.showPages'), onclick: async () => {
      try {
        msg(out, 'info', t('table.loading'));
        const doc = await ctPdf(await ctSourceBlob(c, pick));
        thumbs.innerHTML = '';
        for (let i = 1; i <= doc.numPages; i++) {
          const cv = await ctPageCanvas(doc, i, 110);
          const box = el('input', { type: 'checkbox', checked: i <= 2 });
          thumbs.append(el('label', { className: 'ctthumb' }, [cv, el('span', {}, [box, document.createTextNode(' ' + i)])]));
          box.dataset.page = i;
        }
        thumbs._doc = doc;
        msg(out, 'ok', t('ct.r.tickPages', { n: doc.numPages }));
      } catch (e) { msg(out, 'err', e.message); } } });
    const run = el('button', { className: 'btn pri', type: 'button', textContent: t('ct.r.ocr'), onclick: async () => {
      const doc = thumbs._doc; if (!doc) return msg(out, 'err', t('ct.r.showFirst'));
      const pages = [...thumbs.querySelectorAll('input:checked')].map(x => Number(x.dataset.page));
      if (!pages.length) return msg(out, 'err', t('ct.r.noPages'));
      try {
        await ctLib('ocr');
        msg(out, 'info', t('ct.r.ocrLoading'));
        const worker = await Tesseract.createWorker(['vie', 'eng']);
        const text = {};
        for (let k = 0; k < pages.length; k++) {
          msg(out, 'info', t('ct.r.ocrPage', { p: pages[k], i: k + 1, n: pages.length }));
          const cv = await ctPageCanvas(doc, pages[k], 1800);
          const r = await worker.recognize(cv);
          text[pages[k]] = r.data.text;
        }
        await worker.terminate();
        const f = ctMainFile(c);
        if (f && f.source === 'storage' && !(pick.files && pick.files[0])) await SB.rpc('pm_ct_ocr_save', { p_file: f.id, p_pages: Object.assign({ _pages: doc.numPages }, text) }).catch(() => {});
        const j = ctRules(text);
        const n = Object.keys(j).filter(k => !['pages', 'uncertain'].includes(k) && j[k] != null && !(Array.isArray(j[k]) && !j[k].length)).length;
        ctApplyFound(c, j, 'ocr', t('ct.r.fromB', { n, p: pages.join(', ') }));
        CT.ocrText = text;
      } catch (e) { msg(out, 'err', e.message); } } });
    body.append(pickRow, el('div', { className: 'row' }, [load, run]), thumbs);
    if (CT.ocrText && CT.open === c.id) body.append(el('details', {}, [el('summary', { textContent: t('ct.r.ocrText') }),
      ...Object.entries(CT.ocrText).map(([p, s]) => el('div', { className: 'ctocr' }, [el('b', { textContent: 'p.' + p }), el('pre', { textContent: s })]))]));
  }
  if (mode === 'C') {
    let key = ''; try { key = localStorage.getItem('ct.apiKey') || ''; } catch {}
    const k = el('input', { type: 'password', value: key, placeholder: 'sk-ant-…', autocomplete: 'off' });
    body.append(pickRow, el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, [el('label', { textContent: t('ct.r.key') }), k]),
      el('button', { className: 'btn tiny', type: 'button', textContent: t('ct.r.keySave'), onclick: () => { try { localStorage.setItem('ct.apiKey', k.value.trim()); msg(out, 'ok', t('ct.r.keySaved')); } catch {} } }),
      el('button', { className: 'btn tiny', type: 'button', textContent: t('ct.r.keyForget'), onclick: () => { try { localStorage.removeItem('ct.apiKey'); } catch {} k.value = ''; msg(out, 'ok', t('ct.r.keyGone')); } })]),
      el('div', { className: 'row' }, el('button', { className: 'btn pri', type: 'button', textContent: t('ct.r.run'), onclick: async () => {
        const apiKey = k.value.trim(); if (!apiKey) return msg(out, 'err', t('ct.r.noKey'));
        try {
          const blob = await ctSourceBlob(c, pick);
          if (blob.size > 22 * 1048576) throw new Error(t('ct.r.tooBigApi'));
          msg(out, 'info', t('ct.r.calling'));
          const j = await ctClaude(apiKey, blob);
          ctApplyFound(c, j, 'api', t('ct.r.fromC'));
        } catch (e) { msg(out, 'err', e.message); } } })));
  }
  return card;
}
// The JSON example shown in the prompt of A.
function ctSchemaExample() {
  const ex = s => s.type === 'object' ? Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, ex(v)])) : s.type === 'array' ? [ex(s.items)] : null;
  return ex(CT_SCHEMA);
}
// C: one Messages API call from the browser with the user's own key — the whole PDF as a document block,
// the answer constrained to CT_SCHEMA. Refusals fall back server-side to the recommended model.
async function ctClaude(apiKey, blob) {
  const { default: Anthropic } = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk/+esm');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const b64 = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
  const res = await client.beta.messages.create({
    model: 'claude-opus-5', max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: CT_SCHEMA } },
    messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
      { type: 'text', text: CT_PROMPT }] }] });
  if (res.stop_reason === 'refusal') throw new Error(t('ct.r.refused'));
  if (res.stop_reason === 'max_tokens') throw new Error(t('ct.r.cut'));
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

// B: rules over the OCR text of the chosen pages. Vietnamese / English contract wording; each hit keeps its page.
function ctRules(pages) {
  const j = { pay_terms: [], bonds: [], pages: [], uncertain: [] };
  const num = s => { if (s == null) return null; const d = String(s).replace(/[^\d.,]/g, ''); const n = Number(d.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.')); return isFinite(n) ? n : null; };
  const set = (f, v, p) => { if (v == null || v === '' || j[f] != null && !Array.isArray(j[f])) return; j[f] = v; j.pages.push({ field: f, page: Number(p) }); };
  const iso = (d, m, y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (const [p, raw] of Object.entries(pages)) {
    const s = raw.replace(/\r/g, ''), flat = s.replace(/\s+/g, ' ');
    let m;
    if ((m = flat.match(/(?:Số|So)\s*\/?\s*(?:No\.?)?\s*[:.]\s*([A-Z0-9][A-Z0-9\/\-_.]{4,})/i))) set('contract_no', m[1].replace(/[.,]$/, ''), p);
    if ((m = flat.match(/(?:HỢP ĐỒNG|HOP DONG)\s+([A-ZÀ-Ỹ ]{4,60}?)\s+(?:[A-Z ]*CONTRACT)/))) set('title', ('Hợp đồng ' + m[1].toLowerCase()).trim(), p);
    // OCR often loses the Vietnamese title ("HQP DONG"); the English line under it survives.
    else if ((m = s.match(/^\s*([A-Z][A-Z &]{2,40}CONTRACT)\s*$/m))) set('title', m[1].charAt(0) + m[1].slice(1).toLowerCase(), p);
    if ((m = flat.match(/[Hh]ôm nay,?\s*ngày\s*(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})/))) set('signed_date', iso(m[1], m[2], m[3]), p);
    else if ((m = flat.match(/[Hh]ôm nay[^.]{0,20}?năm\s*(\d{4})/))) j.uncertain.push('signed_date');
    // Parties: the one that is not Plaza is the supplier. The English "Party A" line reads cleaner after OCR
    // than the Vietnamese one (accents lost, "Bên" read as "Bén"), so it is preferred.
    const party = re => [...s.matchAll(re)].map(x => x[1].replace(/[|¡!]+\s*$/, '').trim()).find(x => x.length > 3 && !/PLAZA/i.test(x));
    const sup = party(/Party\s*[AB]\s*[:：]\s*(.+)/gi) || party(/B[eéèêẹ]n\s*[AB]\s*[:：]\s*(.+)/gi);
    if (sup) set('supplier', sup.replace(/\s{2,}.*/, ''), p);
    const taxes = [...flat.matchAll(/(?:Mã số thuế|Tax code)[^\d]{0,15}(\d{10}(?:-\d{3})?)/gi)].map(x => x[1]);
    if (taxes.length) set('supplier_tax', taxes[0], p);
    if ((m = flat.match(/(?:chưa (?:bao )?gồm VAT|without VAT|before VAT)[^\d]{0,30}([\d.,]{5,})/i))) set('value_pre_vat', num(m[1]), p);
    if ((m = flat.match(/(\d{1,2})\s*%\s*VAT/i)) || (m = flat.match(/VAT\s*\(?\s*(\d{1,2})\s*%/i))) set('vat_pct', Number(m[1]), p);
    if ((m = flat.match(/(?:bao gồm VAT|with VAT|VAT included)\)?\s*(?:là|is|\(VND\))?[^\d]{0,20}([\d.,]{5,})/i))) set('value_total', num(m[1]), p);
    if ((m = flat.match(/(?:Thời gian bảo hành|warranty period)[^\d]{0,20}(\d{1,3})\s*(?:tháng|months)/i))) {
      set('warranty_months', Number(m[1]), p);
      const st = flat.slice(m.index, m.index + 120);
      set('warranty_start', /nghiệm thu|acceptance/i.test(st) ? 'acceptance' : /giao|delivery/i.test(st) ? 'delivery' : null, p);
    }
    if ((m = flat.match(/(?:giao hàng trong vòng|deliver the goods within|delivery (?:period|time)[^\d]{0,20})\s*([^.;]{3,80})/i))) set('delivery_text', m[1].trim(), p);
    // Installments: a whole percentage (not the "0.05%" of a penalty) after "Lần / Đợt / installment / payment".
    for (const x of flat.matchAll(/(?:Lần|Lin|Đợt|installment|payment)\s*(\d|một|hai|ba)?\s*[:.]?\s*[^%]{0,60}?(?<![\d.,])(\d{1,3})\s*%/gi)) {
      const pct = Number(x[2]); if (!pct || pct > 100 || j.pay_terms.some(t0 => t0.pct === pct && t0._p === p)) continue;
      if (/phạt|penalty/i.test(flat.slice(Math.max(0, x.index - 20), x.index + x[0].length))) continue;
      const tail = flat.slice(x.index, x.index + 260);
      const amt = tail.match(/\(([\d.,]{5,})\s*VN[DĐ]\)/i);
      j.pay_terms.push({ milestone: /cọc|advance|deposit/i.test(tail) ? 'Deposit' : /bảo hành|retention|giữ lại/i.test(tail) ? 'Retention' : /nghiệm thu|acceptance|giao hàng|delivery/i.test(tail) ? 'Handover' : 'Progress',
                         pct, amount: amt ? num(amt[1]) : null, condition: tail.replace(/\s+/g, ' ').slice(0, 110), _p: p });
      if (!j.pages.some(q => q.field === 'pay_terms')) j.pages.push({ field: 'pay_terms', page: Number(p) });
    }
    if ((m = flat.match(/(?:phạt|penalty)[^.]{0,80}?(\d+[.,]?\d*)\s*%[^.]{0,140}/i))) set('penalty_text', m[0].replace(/\s+/g, ' ').trim().slice(0, 240), p);
    for (const x of flat.matchAll(/bảo lãnh\s*(thực hiện|tạm ứng|bảo hành)[^.]{0,80}?(\d{1,2}(?:[.,]\d)?)\s*%/gi))
      j.bonds.push({ kind: /tạm ứng/i.test(x[1]) ? 'advance' : /bảo hành/i.test(x[1]) ? 'warranty' : 'performance', pct: num(x[2]), amount: null, expiry: null });
    if ((m = flat.match(/(?:có hiệu lực|effective)[^.]{0,40}?(?:đến|until|to)\s*(?:ngày)?\s*(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/i))) set('end_date', iso(m[1], m[2], m[3]), p);
    if (/tự động gia hạn|automatic(?:ally)? renew/i.test(flat)) j.auto_renew = true;
  }
  j.pay_terms.forEach(x => delete x._p);
  return j;
}

/* ------------------------------------------------------------ alerts */
function ctAlertsTab(body) {
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('ct.alertsH', { n: CT.alerts.length }) }), el('p', { textContent: t('ct.alertsHint') })]);
  const tb = el('table', { className: 'lqbt' });
  tb.append(el('tr', {}, [['ct.c.when'], ['ct.c.what'], ['ct.c.no'], ['ct.f.title'], ['ct.c.detail']].map(([k]) => el('th', { textContent: t(k) }))));
  for (const a of CT.alerts) {
    const tr = el('tr', { className: 'aoclick' + (a.days < 0 ? ' mtlate' : '') }, [
      el('td', {}, [document.createTextNode(fmtDate(a.due) + ' '), el('span', { className: 'ctdue' + (a.days < 0 ? ' late' : ''), textContent: a.days < 0 ? t('ct.ago', { n: -a.days }) : t('ct.inDays', { n: a.days }) })]),
      el('td', { textContent: t('ct.a.' + a.kind) }), el('td', {}, el('code', { textContent: a.no })), el('td', { className: 'aowrap', textContent: a.title || '' }),
      el('td', { textContent: a.kind === 'bond' ? t('ct.bond.' + (a.detail || 'performance')) : a.detail || '' })]);
    tr.onclick = () => { CT.tab = 'register'; CT.open = a.contract_id; ctRender(); };
    tb.append(tr);
  }
  card.append(CT.alerts.length ? el('div', { className: 'wrap' }, tb) : el('div', { className: 'dim', textContent: t('ct.noAlerts') }));
  body.append(card);
}

/* ------------------------------------------------------------ import the signed contracts */
// A folder of the procurement SharePoint: every file whose name reads like a contract becomes a contract (to check),
// its project code from the folder / file name (FFE.KIT.02.2026), the file stored in the app.
function ctImportTab(body) {
  const pick = el('input', { type: 'file', multiple: true });
  pick.setAttribute('webkitdirectory', '');
  const pickFiles = el('input', { type: 'file', multiple: true, accept: '.pdf' });
  const out = el('div'), list = el('div');
  const take = files => {
    const rows = [...files].filter(f => /\.pdf$/i.test(f.name) && /contract|h[ợo]p\s*đ[ồo]ng|hop dong|\bH[ĐD][-_ .]|\bHĐ\b/i.test(f.name + ' ' + (f.webkitRelativePath || '')))
      .map(f => { const path = f.webkitRelativePath || f.name;
        const code = (path.match(/\b(FFE|CAPEX|OPEX|PIP)[.,][A-Z]{2,5}[.,]\d{1,3}[.,]\d{4}\b/i) || [''])[0].toUpperCase().replace(/,/g, '.');
        const prj = (CT.projects || []).find(p => p.code === code);
        const sup = (f.name.match(/contract\s*[-–]?\s*(.+?)\.pdf$/i) || f.name.match(/h[ợo]p\s*đ[ồo]ng\s*[-–]?\s*(.+?)\.pdf$/i) || [])[1] || '';
        const known = CT.rows.some(c => CT.files.some(x => x.contract_id === c.id && x.name === f.name));
        return { f, path, code: prj ? code : '', dept: prj ? prj.dept_code : '', title: prj ? prj.name : f.name.replace(/\.pdf$/i, ''), supplier: sup.trim(), on: !known, known }; });
    CT.imp = rows; ctImportList(list, out);
  };
  pick.onchange = () => take(pick.files); pickFiles.onchange = () => take(pickFiles.files);
  body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('ct.imp.h') }), el('p', { textContent: t('ct.imp.hint') }),
    el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, [el('label', { textContent: t('ct.imp.folder') }), pick]),
      el('div', { className: 'fld grow' }, [el('label', { textContent: t('ct.imp.files') }), pickFiles])]), out, list]));
  if (CT.imp) ctImportList(list, out);
}
function ctImportList(list, out) {
  list.innerHTML = '';
  const rows = CT.imp || [];
  if (!rows.length) return msg(out, 'warn', t('ct.imp.none'));
  msg(out, 'info', t('ct.imp.found', { n: rows.length, mb: (rows.reduce((a, r) => a + r.f.size, 0) / 1048576).toFixed(0) }));
  const tb = el('table', { className: 'lqbt' });
  tb.append(el('tr', {}, ['', t('ct.imp.file'), t('ct.f.project_code'), t('ct.f.title'), t('ct.f.supplier'), 'MB'].map(x => el('th', { textContent: x }))));
  for (const r of rows) {
    const on = el('input', { type: 'checkbox', checked: r.on }); on.onchange = () => { r.on = on.checked; };
    const code = el('input', { value: r.code }); code.setAttribute('list', 'ctPrjList'); code.onchange = () => { r.code = code.value.trim(); };
    const ti = el('input', { value: r.title }); ti.onchange = () => { r.title = ti.value.trim(); };
    const sp = el('input', { value: r.supplier }); sp.onchange = () => { r.supplier = sp.value.trim(); };
    tb.append(el('tr', { className: r.known ? 'dim' : '' }, [el('td', {}, on), el('td', { className: 'aowrap', title: r.path, textContent: r.f.name + (r.known ? ' · ' + t('ct.imp.known') : '') }),
      el('td', {}, code), el('td', {}, ti), el('td', {}, sp), el('td', { className: 'num', textContent: (r.f.size / 1048576).toFixed(1) })]));
  }
  let dl = document.getElementById('ctPrjList');
  if (!dl) { dl = el('datalist', { id: 'ctPrjList' }); document.body.append(dl); dl.innerHTML = ''; for (const p of CT.projects || []) dl.append(el('option', { value: p.code, label: p.name || '' })); }
  const go = async () => {
    const todo = rows.filter(r => r.on);
    if (!todo.length || !confirm(t('ct.imp.q', { n: todo.length }))) return;
    let n = 0;
    for (const r of todo) {
      try {
        msg(out, 'info', t('ct.imp.running', { i: n + 1, n: todo.length, f: r.f.name }));
        const prj = (CT.projects || []).find(p => p.code === r.code);
        const id = await SB.rpc('pm_ct_save', { p: { source: 'import', title: r.title, supplier: r.supplier, project_code: prj ? r.code : '', dept_code: prj ? prj.dept_code : '',
          kind: 'supply', scope: prj ? 'capex' : 'opex', currency: 'VND' } });
        await ctUpload({ id }, r.f, 'contract', el('div'));
        r.on = false; r.known = true; n++;
      } catch (e) { msg(out, 'err', `${r.f.name}: ${e.message}`); return; }
    }
    CT.imp = null; CT.tab = 'register'; CT.f = { status: 'draft', kind: '', scope: '' };
    await ctReload(t('ct.imp.done', { n }));
  };
  list.append(el('div', { className: 'wrap' }, tb), el('div', { className: 'row' }, el('button', { className: 'btn pri', type: 'button', textContent: t('ct.imp.go'), onclick: go })));
}

/* ------------------------------------------------------------ to-do list, notices, project panel */
async function ctTodos() {
  if (!ME || !can('contract', 'view')) return [];
  const [inbox, back] = await Promise.all([SB.rpc('pm_ct_inbox').catch(() => []), SB.select('pm_contract', `select=*&status=eq.returned&created_by=eq.${ME.id}`).catch(() => [])]);
  const row = (c, kind) => ({ kind, ct_id: c.id, doc_no: c.no, project_code: c.project_code || '', project_name: [c.title, c.supplier].filter(Boolean).join(' · '),
    dept_code: c.dept_code, submitted_at: c.submitted_at || c.created_at, total_value: c.value_pre_vat ?? c.value_total,
    role_code: c.route && c.cur != null ? ((c.route[c.cur] || {}).roles || [])[0] : null, step: c.cur != null ? c.cur + 1 : null });
  return [...inbox.map(c => row(c, 'ct')), ...back.map(c => row(c, 'ctret'))];
}
function ctOpen(id) { CT.tab = 'register'; CT.open = id; CT.edit = false; showView('contracts'); }
function ctOpenNo(no) { const c = CT.rows.find(x => x.no === no); CT.tab = 'register'; CT.open = c ? c.id : null; CT.pendingNo = c ? null : no; showView('contracts'); }
async function ctProjectPanel(p, card) {
  if (!can('contract', 'view')) return;
  const rows = await SB.select('pm_contract', `select=id,no,contract_no,title,supplier,value_pre_vat,value_total,currency,status,end_date,warranty_until&project_code=eq.${encodeURIComponent(p.code)}&status=neq.cancelled`);
  if (!rows.length) return;
  card.append(el('h2', { style: 'margin-top:14px', textContent: t('ct.panelH') }),
    ...rows.map(c => el('div', { className: 'ctpanelrow' }, [el('a', { className: 'aolink', href: '#', textContent: `${c.no}${c.contract_no ? ' · ' + c.contract_no : ''}`,
      onclick: e => { e.preventDefault(); ppDrawerClose(); ctOpen(c.id); } }), document.createTextNode(` ${c.supplier || ''} · ${ctMoney(c.value_pre_vat ?? c.value_total, c.currency)} `), ctChip(c.status),
      c.warranty_until ? el('small', { className: 'dim', textContent: ' · ' + t('ct.f.warranty_until') + ' ' + fmtDate(c.warranty_until) }) : ''])));
}

/* ------------------------------------------------------------ supplier list from accounting
   The "Danh sách nhà cung cấp" export of the accounting software (title row, then a header row with
   "Mã nhà cung cấp", "Tên nhà cung cấp", "Địa chỉ", "Mã số thuế…", "Điện thoại"). Matched by CODE —
   the accounting vendor code the Vendors table is keyed on; e-mail, aliases and notes typed in the app
   are kept (35_vendor_photo_count.sql). */
const VD = { rows: null, file: '' };
function vdParse(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const hi = aoa.findIndex(r => r.some(c => /mã nhà cung cấp|ma nha cung cap|vendor code/i.test(String(c))) && r.some(c => /tên nhà cung cấp|ten nha cung cap|vendor name/i.test(String(c))));
  if (hi < 0) throw new Error(t('vd.noHeader'));
  const H = aoa[hi].map(c => hnorm(c));
  const col = re => H.findIndex(h => re.test(h));
  const C = { code: col(/^manhacungcap|vendorcode/), name: col(/^tennhacungcap|vendorname/), address: col(/^diachi|address/), tax: col(/masothue|taxcode/), phone: col(/dienthoai|phone|^tel/) };   // hnorm drops the spaces
  const rows = [];
  for (const r of aoa.slice(hi + 1)) {
    const code = String(r[C.code] || '').trim(), name = String(r[C.name] || '').replace(/\s+/g, ' ').trim();
    if (!code || !name) continue;
    rows.push({ code: code.toUpperCase(), name, address: C.address >= 0 ? String(r[C.address] || '').trim() : '', tax_code: C.tax >= 0 ? String(r[C.tax] || '').trim().replace(/^0$/, '') : '',
                phone: C.phone >= 0 ? String(r[C.phone] || '').trim() : '' });
  }
  return rows;
}
async function vdRead() {
  const f = $('#vdFile').files[0], out = $('#vdOut');
  if (!f) return msg(out, 'warn', t('vd.pick'));
  try {
    const rows = vdParse(XLSX.read(await f.arrayBuffer(), { type: 'array' }));
    const cur = await pmSelectAll('pm_vendor', 'select=code,name,tax_code,address,phone,active');
    const by = new Map(cur.map(v => [v.code, v]));
    const neu = rows.filter(r => !by.has(r.code));
    const chg = rows.filter(r => { const v = by.get(r.code); return v && (v.name !== r.name || (v.tax_code || '') !== r.tax_code || (v.address || '') !== r.address || (v.phone || '') !== r.phone || !v.active); });
    const codes = new Set(rows.map(r => r.code));
    const gone = cur.filter(v => v.active && !codes.has(v.code));
    const dupTax = [...rows.reduce((m, r) => (r.tax_code ? m.set(r.tax_code, [...(m.get(r.tax_code) || []), r.code]) : m), new Map())].filter(([, cs]) => cs.length > 1);
    Object.assign(VD, { rows, file: f.name, gone: gone.length });
    out.innerHTML = '';
    out.append(el('div', { className: 'msg info', textContent: t('vd.sum', { f: f.name, n: fmtInt(rows.length), a: fmtInt(neu.length), u: fmtInt(chg.length), s: fmtInt(rows.length - neu.length - chg.length), g: fmtInt(gone.length) }) +
      (dupTax.length ? '\n' + t('vd.dupTax', { l: dupTax.map(([tx, cs]) => `${tx}: ${cs.join(' / ')}`).join('; ') }) : '') }));
    if (neu.length || chg.length) {
      const tb = el('table', { className: 'lqbt' }, [el('tr', {}, [t('vd.c.what'), t('col.code'), t('vd.c.name'), 'MST', t('vd.c.address'), t('vd.c.phone')].map(x => el('th', { textContent: x })))]);
      for (const [r, k] of [...neu.map(r => [r, 'new']), ...chg.map(r => [r, 'chg'])].slice(0, 200))
        tb.append(el('tr', {}, [el('td', {}, el('span', { className: 'ctst ' + (k === 'new' ? 's-active' : 's-review'), textContent: t('vd.k.' + k) })), el('td', {}, el('code', { textContent: r.code })),
          el('td', { className: 'aowrap', textContent: r.name }), el('td', { textContent: r.tax_code }), el('td', { className: 'aowrap', textContent: r.address }), el('td', { textContent: r.phone })]));
      out.append(el('div', { className: 'wrap', style: 'max-height:320px' }, tb));
    }
    $('#btnVdGo').disabled = !can('project', 'edit') && !can('master', 'edit');
  } catch (e) { msg(out, 'err', e.message); }
}
async function vdGo() {
  const out = $('#vdOut');
  if (!VD.rows || !VD.rows.length) return;
  const deact = $('#vdDeact').checked;
  if (!confirm(t('vd.q', { n: fmtInt(VD.rows.length) }) + (deact && VD.gone ? '\n' + t('vd.qDeact', { n: fmtInt(VD.gone) }) : ''))) return;
  try {
    const tot = { added: 0, updated: 0, skipped: 0, deactivated: 0 };
    for (let i = 0; i < VD.rows.length; i += 400) {
      const last = i + 400 >= VD.rows.length;
      const r = await SB.rpc('pm_vendor_import', { p_rows: VD.rows.slice(i, i + 400), p_all_codes: last && deact ? VD.rows.map(x => x.code) : null });
      for (const k in tot) tot[k] += Number((r || {})[k] || 0);
    }
    VD.rows = null; $('#btnVdGo').disabled = true; if (typeof LOOK !== 'undefined') delete LOOK.pm_vendor; CT.vendors = null;
    msg(out, 'ok', t('vd.done', { a: fmtInt(tot.added), u: fmtInt(tot.updated), s: fmtInt(tot.skipped), d: fmtInt(tot.deactivated) }));
  } catch (e) { msg(out, 'err', /pm_vendor_import|PGRST202/.test(e.message) ? t('vd.notInstalled') : e.message); }
}
(function vdWire() {
  const r = document.getElementById('btnVdRead'), g = document.getElementById('btnVdGo');
  if (r) r.onclick = vdRead;
  if (g) g.onclick = vdGo;
})();

window.ctLoad = ctLoad;
window.ctTodos = ctTodos;
window.ctOpen = ctOpen;
window.ctOpenNo = ctOpenNo;
window.ctProjectPanel = ctProjectPanel;
