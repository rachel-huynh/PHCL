/* ============================================================ TENDERING
   Project management → Project → Tendering (41_tendering.sql, user 28/09/2026).
   Calling for quotations moved out of the QC: once the PR package is approved,
   Purchasing opens a call for quotations FROM THE PROJECT (items from the PR),
   attaches the tender documents vendors download, invites vendors with a
   private link (Tender.html), and follows the bids coming in. Past the deadline
   with fewer than three bids, Purchasing extends it. The three roles of the QC
   chain consent to open; then "Input to QC" creates (or reopens) the QC with
   everything the vendors typed, and opens it for editing.

   Also here, because they are the same people's work on the same vendors:
     - vendors' clarification questions (answered on the portal + a ready
       e-mail) and site-visit requests (scheduled + a ready e-mail);
     - sending the approved PO to the chosen vendor (it shows on their portal);
     - the To-do rows of the new flow (pm_todo_proc) and its bell notices.
   E-mails go out through the user's own mail program (mailto): the app has no
   mail server. Nothing typed by a vendor is ever inserted as HTML.
   Loaded after app.js (uses its helpers and the WF / IN state). */

const TD = { qc: null, list: null, vendors: null, link: null, busy: false,
             board: null, min: 3, f: 'all', q: '', open: null, pend: null, units: null, hotel: null, ctx: null };
const TD_WHEN = ['deposit', 'delivery', 'acceptance', 'handover', 'warranty', 'other'];
const tdMissing = e => /pm_tender_board|pm_tender_create_prj|pm_todo_proc|PGRST202|404/.test(String(e && e.message));

const tdDt = v => fmtDateTime(v);
const tdLocal = d => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
const tdIso = v => v ? new Date(v).toISOString() : null;       // datetime-local (local time) → timestamptz
// What a vendor quoted: items at THEIR quantity (the requested one when they left it), overheads qty × price.
const tdQty = (tn, data, i) => { const q = data && data.qtys && data.qtys[i]; return q != null && q !== '' ? n0(q) : n0((tn.items || [])[i] && tn.items[i].qty); };
const tdOhAmt = o => o.amount != null && o.amount !== '' ? n0(o.amount) : n0(o.qty) * n0(o.price);
const tdTotal = (tn, data) => {
  if (!data) return null;
  const items = (tn.items || []).reduce((s, it, i) => s + tdQty(tn, data, i) * n0((data.prices || {})[i]), 0);
  return items + (data.olines || []).reduce((s, o) => s + tdOhAmt(o), 0);
};
// The payment schedule a vendor declared, in words (English, like the forms): "30% deposit on order; 70% after acceptance (within 15 days)".
function tdPayText(b) {
  const w = { deposit: 'deposit on order', delivery: 'on delivery', acceptance: 'after acceptance', handover: 'after handover', warranty: 'at the end of warranty', other: '' };
  const s = (b.pay_sched || []).filter(x => n0(x.pct) > 0).map(x => [`${x.pct}%`, w[x.when] || '', x.days ? `(within ${x.days} days)` : '', x.note ? `– ${x.note}` : '']
    .filter(Boolean).join(' ')).join('; ');
  return [s, b.pay_term].filter(Boolean).join('. ');
}
function tdOpened(tn) {
  const out = [];
  for (const v of tn.invitees || []) {
    const op = (v.bids || []).filter(b => b.opened_at).sort((a, b) => (b.round - a.round) || (b.version - a.version));
    if (op.length) out.push({ inv: v, bid: op[0] });
  }
  return out.sort((a, b) => n0(tdTotal(tn, a.bid.data)) - n0(tdTotal(tn, b.bid.data)));
}
// Where a tender stands, for the board and its chips.
function tdStage(r, tn) {
  if (!tn) return r.qc && r.qc.status === 'approved' ? 'done' : r.qc ? 'qc' : 'call';
  if (r.qc && r.qc.status === 'approved') return 'done';
  if (tn.opened > 0 || (tn.invitees && tdOpened(tn).length)) return r.qc ? 'qc' : 'opened';
  const past = new Date(tn.deadline) < new Date();
  if (tn.sealed > 0 && (past || tn.submitted >= tn.invited)) return tn.submitted < tn.min_bids && past ? 'due' : 'ready';
  if (tn.status === 'open' && past) return 'due';
  if (tn.status !== 'open') return 'closed';
  return tn.invited ? 'open' : 'draft';
}
const TD_BAND = { call: 'op', draft: 'draft', open: 'op', due: 'bad', ready: 'am', opened: 'jvc', qc: 'jvc', done: 'ok', closed: 'draft' };
function tdLeft(d) {
  const ms = new Date(d) - new Date(), h = Math.round(Math.abs(ms) / 36e5);
  const txt = h >= 48 ? t('tg.days', { n: Math.round(h / 24) }) : t('tg.hours', { n: Math.max(1, h) });
  return ms >= 0 ? t('tg.left', { x: txt }) : t('tg.late', { x: txt });
}
function tdMail(to, subject, body, bcc) {
  const q = [subject && 'subject=' + encodeURIComponent(subject), body && 'body=' + encodeURIComponent(body.slice(0, 1800)),
             bcc && bcc.length && 'bcc=' + encodeURIComponent(bcc.join(','))].filter(Boolean).join('&');
  location.href = `mailto:${encodeURIComponent(to || '')}${q ? '?' + q : ''}`;
}
async function tdHotel() {
  if (TD.hotel) return TD.hotel;
  try { const [r] = await SB.select('am_setting', 'select=value&key=eq.td_hotel_info'); TD.hotel = (r && r.value) || {}; } catch { TD.hotel = {}; }
  return TD.hotel;
}
async function tdUnits() {
  if (TD.units) return TD.units;
  // The Product catalogue too: the items of a call are picked from it (user 29/09/2026), as on the PR / PO.
  try { await wfCatLoad(); } catch {}
  try { TD.units = await SB.select('am_unit', 'select=code,name_vi,name_en&order=sort_order,code'); } catch { TD.units = []; }
  return TD.units;
}

/* ------------------------------------------------------------ the board */
async function tdBoardLoad() {
  const out = $('#tgMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups(); await wfLookups();
    const b = await SB.rpc('pm_tender_board');
    TD.board = b.rows || []; TD.min = b.min_bids || 3;
    msg(out, TD.flash ? 'ok' : '', TD.flash || ''); TD.flash = null;
    tdBoardRender();
    if (TD.open) { const c = TD.open; TD.open = null; tdDetail(c); }
  } catch (e) { $('#tgBody').innerHTML = ''; msg(out, 'err', tdMissing(e) ? t('tg.notInstalled') : e.message); }
}

function tdBoardRender() {
  const body = $('#tgBody');
  if (!body) return;
  body.innerHTML = '';
  // One row per project, carrying its live tender (the latest one).
  const rows = (TD.board || []).map(r => { const tn = (r.tenders || []).filter(x => x.status !== 'cancelled').slice(-1)[0] || null; return { r, tn, st: tdStage(r, tn) }; });
  const cnt = k => rows.filter(x => k === 'all' || x.st === k || (k === 'opened' && x.st === 'qc')).length;
  const tile = (k, n, sub, warn) => el('button', { type: 'button', className: 'aokpi tgkpi' + (TD.f === k ? ' on' : '') + (warn ? ' warn' : ''),
    onclick: () => { TD.f = TD.f === k ? 'all' : k; tdBoardRender(); } }, [el('small', { textContent: t('tg.k.' + k) }), el('b', { textContent: fmtInt(n) }), sub ? el('span', { textContent: sub }) : '']);
  body.append(el('div', { className: 'aokpis' }, [
    tile('call', cnt('call'), t('tg.k.callSub')), tile('open', cnt('open') + cnt('draft'), t('tg.k.openSub')),
    tile('due', cnt('due'), t('tg.k.dueSub', { n: TD.min }), cnt('due') > 0), tile('ready', cnt('ready'), t('tg.k.readySub')),
    tile('opened', cnt('opened'), t('tg.k.openedSub')), tile('done', cnt('done'), t('tg.k.doneSub'))]));
  const card = el('div', { className: 'card' });
  const q = el('input', { value: TD.q, placeholder: t('tg.searchPh') });
  q.oninput = () => { TD.q = q.value; clearTimeout(q._t); q._t = setTimeout(() => { tdBoardRender(); const f = $('#tgBody input'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); };
  card.append(el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, [el('label', { textContent: t('ct.search') }), q]),
    el('div', { className: 'tdnote', style: 'align-self:flex-end;max-width:520px', textContent: t('tg.hint', { n: TD.min }) })]));
  const words = hnorm(TD.q).split(/\s+/).filter(Boolean);
  const show = rows.filter(x => (TD.f === 'all' || x.st === TD.f || (TD.f === 'opened' && x.st === 'qc') || (TD.f === 'open' && x.st === 'draft'))
    && words.every(w => hnorm([x.r.code, x.r.name, x.r.dept_code, pmDeptName(x.r.dept_code), x.tn && x.tn.title].join(' ')).includes(w)));
  const tb = el('table', { className: 'lqbt tgbt' });
  tb.append(el('tr', {}, [['tg.c.stage'], ['pm.col.code'], ['pm.col.name'], ['pm.col.dept'], ['tg.c.pr'], ['tg.c.deadline'], ['tg.c.bids'], ['tg.c.more'], ['tg.c.qc']]
    .map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
  for (const { r, tn, st } of show) {
    const bids = tn ? el('div', { className: 'tgbids' }, [
      el('div', { className: 'tgbar' }, el('i', { style: `width:${Math.min(100, Math.round(n0(tn.submitted) / Math.max(1, tn.min_bids) * 100))}%` + (tn.submitted >= tn.min_bids ? ';background:var(--green)' : '') })),
      el('small', { textContent: t('tg.bidsOf', { s: tn.submitted, m: tn.min_bids, i: tn.invited, d: Math.max(0, n0(tn.started) - n0(tn.submitted)) }) })]) : '';
    const more = el('div', { className: 'tgmore' }, [
      tn && tn.q_open ? el('span', { className: 'tdchip warn', title: t('tg.qOpen'), textContent: '❓ ' + tn.q_open }) : '',
      tn && tn.s_open ? el('span', { className: 'tdchip warn', title: t('tg.sOpen'), textContent: '📍 ' + tn.s_open }) : '',
      tn && tn.files ? el('span', { className: 'tdchip', title: t('tg.files'), textContent: '📎 ' + tn.files }) : '',
      tn && tn.round > 1 ? el('span', { className: 'tdchip', textContent: t('td.round', { n: tn.round }) }) : '']);
    const tr = el('tr', { className: 'aoclick' }, [
      el('td', {}, el('span', { className: 'stg band-' + TD_BAND[st], textContent: t('tg.st.' + st) })),
      el('td', {}, el('code', { textContent: r.code })), el('td', { className: 'aowrap', textContent: [r.name, tn && tn.title && tn.title !== r.name ? '· ' + tn.title : ''].filter(Boolean).join(' ') }),
      el('td', { textContent: pmDeptName(r.dept_code), title: r.dept_code }),
      el('td', { className: 'nw', textContent: r.pr && r.pr.at ? fmtDate(String(r.pr.at).slice(0, 10)) : '' }),
      el('td', { className: 'nw' }, tn ? [document.createTextNode(tdDt(tn.deadline)), el('br'),
        el('small', { className: new Date(tn.deadline) < new Date() ? 'tglate' : 'dim', textContent: tn.status === 'open' ? tdLeft(tn.deadline) : t('td.st.' + tn.status) })] : []),
      el('td', {}, bids), el('td', {}, more),
      el('td', {}, r.qc ? [el('code', { textContent: r.qc.doc_no }), ' ', wfChip(r.qc.status)] : '')]);
    tr.onclick = () => tdDetail(r.code);
    tb.append(tr);
  }
  card.append(show.length ? el('div', { className: 'wrap' }, tb) : el('div', { className: 'dim', style: 'padding:10px 2px', textContent: rows.length ? t('pm.none.filter') : t('tg.empty') }));
  body.append(card);
}

/* ------------------------------------------------------------ the project drawer */
function tdDrawerEl() {
  let dr = $('#tgDrawer');
  if (dr) return dr;
  dr = el('div', { id: 'tgDrawer', className: 'drawer tgdrawer', role: 'dialog', hidden: true }, [
    el('div', { className: 'dhead' }, [el('h2', { id: 'tgDrTitle' }),
      el('button', { className: 'dbtn', type: 'button', textContent: '↻', title: t('td.refresh'), onclick: () => TD.ctx && tdDetail(TD.ctx.p.code) }),
      el('button', { className: 'dbtn', type: 'button', textContent: '✕', onclick: tdDrawerClose })]),
    el('div', { id: 'tgDrBody', className: 'dbody' })]);
  document.body.append(dr);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dr.hidden) tdDrawerClose(); });
  return dr;
}
function tdDrawerClose() { const d = $('#tgDrawer'); if (d) { d.hidden = true; $('#tgDrBody').innerHTML = ''; } TD.ctx = null; }

async function tdDetail(code) {
  const dr = tdDrawerEl(), body = $('#tgDrBody');
  dr.hidden = false; body.innerHTML = ''; body.scrollTop = 0;
  const out = el('div', { id: 'tdMsg' });
  body.append(out);
  $('#tgDrTitle').textContent = t('table.loading');
  try {
    await pmLookups(); await wfLookups();
    const [[p], docs, list] = await Promise.all([
      SB.select('pm_project', `select=*&code=eq.${encodeURIComponent(code)}`),
      SB.select('pm_doc', `select=id,doc_type,doc_no,status,data,decided_at&project_code=eq.${encodeURIComponent(code)}&status=not.in.(cancelled,rejected)&order=id`),
      SB.rpc('pm_tender_list', { p_project: code })]);
    if (!p) throw new Error(t('wf.gone'));
    const pr = docs.filter(d => d.doc_type === 'PR' && d.status === 'approved').slice(-1)[0] || null;
    const qc = docs.filter(d => d.doc_type === 'QC').slice(-1)[0] || null;
    TD.ctx = { p, pr, qc, docs, list, out, body, mode: 'board' };
    TD.list = list; TD.qc = null;
    $('#tgDrTitle').textContent = `${p.code} — ${p.name || ''}`;
    tdDetailDraw();
  } catch (e) { $('#tgDrTitle').textContent = code; msg(out, 'err', tdMissing(e) ? t('tg.notInstalled') : e.message); }
}
function tdDetailDraw() {
  const x = TD.ctx; if (!x) return;
  const { p, pr, qc, body } = x;
  [...body.children].forEach(n => { if (n !== x.out) n.remove(); });
  const docLink = d => d ? el('a', { href: '#', className: 'aolink', textContent: d.doc_no, onclick: e => { e.preventDefault(); tdDrawerClose(); wfOpen(d.id); } }) : el('span', { className: 'dim', textContent: '—' });
  body.append(el('dl', { className: 'aodl' }, [
    el('dt', { textContent: t('pm.col.dept') }), el('dd', { textContent: `${p.dept_code} — ${pmDeptName(p.dept_code)}` }),
    el('dt', { textContent: t('pm.col.estimate') }), el('dd', { textContent: p.estimated_value != null ? fmtMoney(p.estimated_value) : '—' }),
    el('dt', { textContent: t('tg.c.pr') }), el('dd', {}, [docLink(pr), pr && pr.decided_at ? document.createTextNode(' · ' + fmtDate(String(pr.decided_at).slice(0, 10))) : '']),
    el('dt', { textContent: 'QC' }), el('dd', {}, qc ? [docLink(qc), ' ', wfChip(qc.status)] : [el('span', { className: 'dim', textContent: t('tg.noQc') })])]));
  const live = (x.list || []).filter(tn => tn.status !== 'cancelled');
  const canMng = wfCanPrepare('QC', p.dept_code) || can('project', 'admin');
  if (!live.length) {
    body.append(el('div', { className: 'tdnote', textContent: pr ? t('tg.noneYet') : t('tg.needPr') }));
    if (canMng && (pr || can('project', 'admin'))) body.append(tdCreateForm(x));
  }
  for (const tn of live) body.append(tdOne(x, tn));
  const gone = (x.list || []).filter(tn => tn.status === 'cancelled');
  if (gone.length) body.append(el('div', { className: 'tdnote', textContent: t('tg.cancelledN', { n: gone.length }) }));
  // A QC without the portal (a single supplier, an emergency…): straight to the form.
  if (canMng && !qc && pr) body.append(el('div', { className: 'row', style: 'margin-top:14px' }, [
    el('button', { className: 'btn', type: 'button', textContent: t('tg.directQc'), onclick: () => { if (confirm(t('tg.directQcQ'))) { tdDrawerClose(); wfCreateFor(p.code, 'QC', '#tgMsg'); } } }),
    el('span', { className: 'tdnote', textContent: t('tg.directQcHint') })]));
}
async function tdReload(okText) {
  const x = TD.ctx;
  if (!x) return;
  try {
    x.list = await SB.rpc('pm_tender_list', { p_project: x.p.code }); TD.list = x.list;
    if (x.mode === 'board') tdDetailDraw(); else if (x.redraw) x.redraw();
    if (okText) msg(x.out, 'ok', okText);
    if (x.mode === 'board') SB.rpc('pm_tender_board').then(b => { TD.board = b.rows || []; tdBoardRender(); }).catch(() => {});
  } catch (e) { msg(x.out, 'err', e.message); }
}
async function tdCall(fn, args, okText) {
  if (TD.busy) return null;
  TD.busy = true;
  try { const r = await SB.rpc(fn, args); await tdReload(okText); return r; }
  catch (e) { msg(TD.ctx && TD.ctx.out, 'err', e.message); return null; }
  finally { TD.busy = false; }
}

/* ------------------------------------------------------------ opening a call for quotations */
function tdItemsEditor(items, units) {
  const tb = el('table', { className: 'tdtbl tgitems' });
  const rows = [];
  const add = it => {
    const u = el('select'); selFill(u, [['', '—'], ...units.map(x => [x.code, `${x.code}${x.name_vi ? ' — ' + (LANG === 'en' ? x.name_en || x.name_vi : x.name_vi) : ''}`])]);
    if (it.unit && !units.some(x => x.code === it.unit)) u.append(el('option', { value: it.unit, textContent: it.unit }));
    u.value = it.unit || '';
    // Only an entry of the Product catalogue (what the QC and the PO carry on).
    const item = el('input', { value: it.item || '', spellcheck: false, className: it.item && !wfCatHasProduct(it.item) ? 'bad' : '' });
    item.setAttribute('list', 'wfProdList');
    item.onchange = () => {
      const v = item.value.trim(), hit = !v ? null : WF_CAT.products.has(v) ? { name: v, unit: WF_CAT.products.get(v).default_unit } : wfCatProduct(v);
      item.classList.toggle('bad', !!v && !hit);
      if (hit) { item.value = hit.name; if (hit.unit && !u.value) u.value = hit.unit; }
      else if (v) { item.value = ''; alert(t('wf.cat.product', { v })); }
    };
    const r = { item, qty: el('input', { value: it.qty ?? 1, inputMode: 'decimal', className: 'num', style: 'width:70px' }), unit: u,
                spec: el('input', { value: it.spec || '', placeholder: t('tg.specPh') }) };
    const tr = el('tr', {}, [el('td', {}, r.item), el('td', {}, r.qty), el('td', {}, r.unit), el('td', {}, r.spec),
      el('td', {}, el('button', { className: 'xbtn', type: 'button', textContent: '✕', onclick: () => { tr.remove(); rows.splice(rows.indexOf(r), 1); } }))]);
    rows.push(r); tb.append(tr);
  };
  tb.append(el('tr', {}, [t('tg.h.item'), t('tg.h.qty'), t('tg.h.unit'), t('tg.h.spec'), ''].map(h => el('th', { textContent: h }))));
  for (const it of items) add(it);
  if (!items.length) add({ qty: 1 });
  const node = el('div', {}, [el('div', { className: 'wrap' }, tb), el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('tg.addItem'), onclick: () => add({ qty: 1 }) })]);
  node.read = () => rows.map(r => ({ item: r.item.value.trim(), qty: numIn(r.qty.value), unit: r.unit.value || null, spec: r.spec.value.trim() || null })).filter(r => r.item);
  return node;
}
function tdCreateForm(x) {
  const { p, pr } = x;
  const box = el('details', { className: 'tdbox', open: true }, [el('summary', { textContent: t('tg.new') })]);
  (async () => {
    const [units, hotel] = await Promise.all([tdUnits(), tdHotel()]);
    const d = (pr && pr.data) || {};
    const items = (d.lines || []).filter(l => l.asset_item).map(l => ({ item: l.asset_item, qty: l.qty ?? 1, unit: l.unit || null, spec: l.tech_standard || '' }));
    const scope = [d.reason || p.reason || '', ...(d.lines || []).filter(l => l.asset_item && l.rationale).map(l => `- ${l.asset_item}: ${l.rationale}`)].filter(Boolean).join('\n');
    const dl = new Date(); dl.setDate(dl.getDate() + 7); dl.setHours(17, 0, 0, 0);
    const fTitle = el('input', { value: p.name || '' });
    const fDl = el('input', { type: 'datetime-local', value: tdLocal(dl) });
    const fMin = el('input', { type: 'number', min: 1, max: 9, value: TD.min || 3, style: 'width:70px' });
    const fAddr = el('textarea', { rows: 2, value: [hotel.dept, hotel.company, hotel.address].filter(Boolean).join(' — ') });
    const fScope = el('textarea', { value: scope, style: 'min-height:80px' });
    const fTerms = el('textarea', { value: t('td.termsDefault'), style: 'min-height:70px' });
    const pt = /x[aâ]y|constr/i.test(p.project_type || '') ? QC_PTYPES[1] : /h[oỗ]n|mix/i.test(p.project_type || '') ? QC_PTYPES[2] : QC_PTYPES[0];
    const fAb = el('textarea', { rows: 4, value: QC_ABILITY.join('\n') });
    const fTe = el('textarea', { rows: 4, value: qcTechFor(pt).join('\n') });
    const ed = tdItemsEditor(items, units);
    const go = el('button', { className: 'btn pri', type: 'button', textContent: t('tg.create') });
    go.onclick = async () => {
      const crit = [...fAb.value.split('\n').map(s => s.trim()).filter(Boolean).map(label => ({ label, grp: 'ability' })),
                    ...fTe.value.split('\n').map(s => s.trim()).filter(Boolean).map(label => ({ label, grp: 'technique' }))];
      const id = await tdCall('pm_tender_create_prj', { p_project: p.code, p: { title: fTitle.value.trim(), deadline: tdIso(fDl.value), scope: fScope.value, terms: fTerms.value,
        address: fAddr.value.trim(), min_bids: Number(fMin.value) || 3, items: ed.read(), crit } }, t('tg.created'));
      if (id) TD.flash = null;
    };
    const f = (k, i, cls) => el('div', { className: 'fld' + (cls ? ' ' + cls : '') }, [el('label', { textContent: t(k) }), i]);
    box.append(el('div', { className: 'tdnote', textContent: t('tg.newHint') }),
      el('div', { className: 'row' }, [f('td.f.title', fTitle, 'grow'), f('td.f.deadline', fDl), f('tg.f.min', fMin)]),
      el('h3', { textContent: t('tg.items') }), ed,
      el('div', { className: 'row' }, [f('td.f.scope', fScope, 'grow')]), el('div', { className: 'row' }, [f('td.f.terms', fTerms, 'grow')]),
      el('div', { className: 'row' }, [f('tg.f.address', fAddr, 'grow')]),
      el('details', {}, [el('summary', { className: 'dim', textContent: t('tg.crit') }),
        el('div', { className: 'row' }, [f('tg.f.ability', fAb, 'grow'), f('tg.f.technique', fTe, 'grow')])]),
      el('div', { className: 'row', style: 'margin-top:8px' }, [go]));
  })().catch(e => box.append(el('div', { className: 'msg err', textContent: e.message })));
  return box;
}

/* ------------------------------------------------------------ one call for quotations */
function tdOne(x, tn) {
  const box = el('div', { className: 'tdone' });
  const past = new Date(tn.deadline) < new Date();
  const invited = (tn.invitees || []).filter(v => !v.revoked);
  const submitted = invited.filter(v => (v.bids || []).some(b => b.round === tn.round && b.status === 'submitted')).length;
  const st = tn.status === 'open' && !past ? ['ok', 'td.st.open'] : tn.status === 'open' ? ['warn', 'td.st.past'] : ['bad', 'td.st.' + tn.status];
  box.append(el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [
    el('b', { textContent: tn.title || x.p.name || '' }), el('span', { className: 'tdchip ' + st[0], textContent: t(st[1]) }),
    el('span', { className: 'dim', textContent: `${t('td.f.deadline')}: ${tdDt(tn.deadline)}${tn.status === 'open' ? ' · ' + tdLeft(tn.deadline) : ''}` }),
    tn.round > 1 ? el('span', { className: 'dim', textContent: t('td.round', { n: tn.round }) }) : '',
    el('span', { className: 'dim', textContent: t('td.counts', { i: (tn.items || []).length, c: (tn.crit || []).length }) })]));
  // Progress towards the minimum number of bids.
  box.append(el('div', { className: 'tgprog' }, [el('div', { className: 'tgbar big' }, el('i', { style: `width:${Math.min(100, Math.round(submitted / Math.max(1, tn.min_bids) * 100))}%` + (submitted >= tn.min_bids ? ';background:var(--green)' : '') })),
    el('span', { textContent: t('tg.progress', { s: submitted, m: tn.min_bids, i: invited.length }) })]));
  const opened = tdOpened(tn);
  // Past the deadline with too few bids (and nothing opened yet): extend.
  if (tn.can_manage && tn.status === 'open' && past && submitted < tn.min_bids && !opened.length) {
    const ext = n => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(17, 0, 0, 0);
      return el('button', { className: 'btn tiny pri', type: 'button', textContent: t('tg.plusDays', { n }),
        onclick: () => tdCall('pm_tender_update', { p_id: tn.id, p_deadline: d.toISOString(), p_scope: null, p_terms: null, p_status: null }, t('tg.extended', { d: tdDt(d) })) }); };
    box.append(el('div', { className: 'msg warn tgwarn' }, [el('b', { textContent: t('tg.fewBids', { s: submitted, m: tn.min_bids }) }), ' ', ext(3), ' ', ext(7), ' ',
      el('span', { className: 'tdnote', textContent: t('tg.fewBidsHint') })]));
  }
  if (tn.can_manage) {
    const nd = new Date(Math.max(Date.now(), new Date(tn.deadline).getTime())); nd.setDate(nd.getDate() + 3);
    const fDl = el('input', { type: 'datetime-local', value: tdLocal(nd), style: 'width:auto' });
    const b = (k, cls, fn) => el('button', { className: 'btn ' + cls, type: 'button', textContent: t(k), onclick: fn });
    const acts = [fDl];
    if (tn.status === 'open') acts.push(
      b('td.extend', '', () => tdCall('pm_tender_update', { p_id: tn.id, p_deadline: tdIso(fDl.value), p_scope: null, p_terms: null, p_status: null }, t('td.done'))),
      b('td.close', '', () => confirm(t('td.closeQ')) && tdCall('pm_tender_update', { p_id: tn.id, p_deadline: null, p_scope: null, p_terms: null, p_status: 'closed' }, t('td.done'))));
    acts.push(b('td.reopen', '', () => { const why = prompt(t('td.reopenQ')); if (why && why.trim()) tdCall('pm_tender_reopen', { p_id: tn.id, p_deadline: tdIso(fDl.value), p_reason: why.trim() }, t('td.reopened')); }),
      b('td.cancel', 'danger', () => confirm(t('td.cancelQ')) && tdCall('pm_tender_update', { p_id: tn.id, p_deadline: null, p_scope: null, p_terms: null, p_status: 'cancelled' }, t('td.done'))));
    box.append(el('div', { className: 'row tdacts' }, acts));
    box.append(tdEditBox(x, tn, submitted));
  }
  box.append(tdFilesBox(x, tn));
  box.append(tdInviteesBox(x, tn));
  box.append(tdQaBox(x, tn));
  if (tn.can_answer) box.append(tdSurveyBox(x, tn));
  box.append(tdConsentBox(x, tn));
  if (opened.length) box.append(el('h3', { textContent: t('td.opened') }), tdOpenedTable(x, tn, opened));
  const ev = el('details', { className: 'tdev' }, [el('summary', { textContent: t('td.events', { n: (tn.events || []).length }) })]);
  const et = el('table', { className: 'tdtbl' });
  for (const e of tn.events || []) et.append(el('tr', {}, [el('td', { textContent: tdDt(e.at) }), el('td', { textContent: e.actor || '' }),
    el('td', { textContent: t('td.ev.' + e.action) !== 'td.ev.' + e.action ? t('td.ev.' + e.action) : e.action }), el('td', { style: 'white-space:normal', textContent: e.detail || '' })]));
  ev.append(el('div', { className: 'wrap' }, et));
  box.append(ev);
  return box;
}

// Title, scope, instructions, address, minimum bids — and the items while nobody has submitted.
function tdEditBox(x, tn, submitted) {
  const det = el('details', { className: 'tdbox' }, [el('summary', { textContent: t('tg.edit') })]);
  det.ontoggle = async () => {
    if (!det.open || det.dataset.ready) return;
    det.dataset.ready = '1';
    const units = await tdUnits();
    const fTitle = el('input', { value: tn.title || '' }), fMin = el('input', { type: 'number', min: 1, max: 9, value: tn.min_bids || 3, style: 'width:70px' });
    const fScope = el('textarea', { value: tn.scope || '', style: 'min-height:70px' }), fTerms = el('textarea', { value: tn.terms || '', style: 'min-height:60px' });
    const fAddr = el('textarea', { rows: 2, value: tn.address || '' });
    const ed = submitted ? null : tdItemsEditor(tn.items || [], units);
    const f = (k, i, cls) => el('div', { className: 'fld' + (cls ? ' ' + cls : '') }, [el('label', { textContent: t(k) }), i]);
    const go = el('button', { className: 'btn pri', type: 'button', textContent: t('tool.save'), onclick: () => {
      const p = { title: fTitle.value, scope: fScope.value, terms: fTerms.value, address: fAddr.value, min_bids: Number(fMin.value) || 3 };
      if (ed) p.items = ed.read();
      tdCall('pm_tender_set', { p_id: tn.id, p }, t('tg.saved'));
    } });
    det.append(el('div', { className: 'row' }, [f('td.f.title', fTitle, 'grow'), f('tg.f.min', fMin)]),
      ed ? el('div', {}, [el('h3', { textContent: t('tg.items') }), ed]) : el('div', { className: 'tdnote', textContent: t('tg.itemsLocked') }),
      el('div', { className: 'row' }, [f('td.f.scope', fScope, 'grow')]), el('div', { className: 'row' }, [f('td.f.terms', fTerms, 'grow')]),
      el('div', { className: 'row' }, [f('tg.f.address', fAddr, 'grow')]), el('div', { className: 'row' }, [go]));
  };
  return det;
}

/* The tender documents vendors download from the portal (drawings, BOQ, specs…):
   Storage bucket pm-tender, folder doc/<doc_key>/, readable through the portal link only. */
async function tdPut(path, file) {
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/pm-tender/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST',
    headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok, 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, body: file });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
}
// A stored file opens in the in-app viewer (docview.js); its download button is there (user 29/09/2026).
function tdFile(f, bucket = 'pm-tender') { dvFile(f, bucket); }
const tdSafe = n => (n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)) || 'file';
function tdFilesBox(x, tn) {
  const wrap = el('div');
  wrap.append(el('h3', { textContent: t('tg.docs', { n: (tn.files || []).length }) }));
  const ul = el('ul', { className: 'tgfiles' });
  for (const f of tn.files || []) ul.append(el('li', {}, [el('a', { href: '#', textContent: '📎 ' + (f.name || 'file'), onclick: e => { e.preventDefault(); tdFile(f); } }),
    el('small', { className: 'dim', textContent: ` ${Math.max(1, Math.round((f.size || 0) / 1024))} KB · ${fmtDate(String(f.at || '').slice(0, 10))}` }),
    tn.can_manage ? el('button', { className: 'xbtn', type: 'button', textContent: '✕', title: t('ph.remove'),
      onclick: () => confirm(t('tg.docDelQ', { n: f.name })) && tdCall('pm_tender_file_del', { p_id: tn.id, p_path: f.path }, t('td.done')) }) : '']));
  if (!(tn.files || []).length) ul.append(el('li', { className: 'dim', textContent: t('tg.noDocs') }));
  wrap.append(ul);
  if (tn.can_manage && tn.status !== 'cancelled') {
    const inp = el('input', { type: 'file', multiple: true, hidden: true, accept: '.pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx,.doc,.zip,.dwg' });
    inp.onchange = async () => {
      const files = [...inp.files]; inp.value = '';
      if (!files.length) return;
      msg(x.out, 'info', t('ph.uploading'));
      try {
        for (const f of files) {
          if (f.size > 20 * 1024 * 1024) throw new Error(t('tg.tooBig', { n: f.name }));
          const path = `doc/${tn.doc_key}/${Date.now()}-${tdSafe(f.name)}`;
          await tdPut(path, f);
          await SB.rpc('pm_tender_file_add', { p_id: tn.id, p_path: path, p_name: f.name, p_size: f.size });
        }
        await tdReload(t('tg.docsAdded', { n: files.length }));
      } catch (e) { msg(x.out, 'err', e.message); }
    };
    wrap.append(inp, el('div', { className: 'row' }, [el('button', { className: 'btn tiny', type: 'button', textContent: '＋ ' + t('tg.docAdd'), onclick: () => inp.click() }),
      el('span', { className: 'tdnote', textContent: t('tg.docHint') })]));
  }
  return wrap;
}

function tdInviteesBox(x, tn) {
  const wrap = el('div');
  const tb = el('table', { className: 'tdtbl' });
  tb.append(el('tr', {}, ['td.h.vendor', 'td.h.link', 'td.h.bid', 'td.h.total', ''].map(k => el('th', { textContent: k ? t(k) : '' }))));
  for (const v of tn.invitees || []) {
    const cur = (v.bids || []).filter(b => b.round === tn.round).sort((a, b) => b.version - a.version);
    const sub = cur.find(b => b.status === 'submitted') || cur.find(b => b.submitted_at);
    const bidTxt = !cur.length ? t('td.b.none') : !sub ? t('td.b.draft')
      : `${t('td.b.sub', { v: sub.version, at: tdDt(sub.submitted_at) })} · ${sub.opened_at ? t('td.b.opened') : '🔒 ' + t('td.b.sealed')}`;
    const expired = new Date(v.expires_at) < new Date();
    const linkTxt = v.revoked ? t('td.l.revoked') : expired ? t('td.l.expired') : t('td.l.until', { d: tdDt(v.expires_at) });
    const ops = [];
    if (tn.can_manage) {
      const b = (k, fn) => el('button', { className: 'btn tiny', type: 'button', textContent: t(k), onclick: fn });
      ops.push(b('td.l.extend', () => tdCall('pm_tender_invite_set', { p_invitee: v.id, p_days: 14, p_revoke: false, p_new_token: false }, t('td.done'))),
        b('td.l.new', async () => { if (!confirm(t('td.l.newQ'))) return;
          const tok = await tdCall('pm_tender_invite_set', { p_invitee: v.id, p_days: 14, p_revoke: false, p_new_token: true }, '');
          if (tok) tdShowLink(v.name, v.email, tok, tn); }));
      if (!v.revoked) ops.push(b('td.l.revoke', () => confirm(t('td.l.revokeQ')) && tdCall('pm_tender_invite_set', { p_invitee: v.id, p_days: null, p_revoke: true, p_new_token: false }, t('td.done'))));
    }
    const op = (v.bids || []).filter(b => b.opened_at).sort((a, b) => (b.round - a.round) || (b.version - a.version))[0];
    tb.append(el('tr', {}, [el('td', {}, [el('b', { textContent: v.name || '' }), el('br'), el('small', { className: 'dim', textContent: [v.vendor_code, v.email].filter(Boolean).join(' · ') })]),
      el('td', { className: v.revoked || expired ? 'dim' : '', textContent: linkTxt + (v.last_seen_at ? ' · ' + t('td.l.seen', { d: tdDt(v.last_seen_at) }) : '') }),
      el('td', { textContent: bidTxt }), el('td', { className: 'n', textContent: op ? fmtMoney(tdTotal(tn, op.data)) : '' }), el('td', { className: 'tdops' }, ops)]));
  }
  if (!(tn.invitees || []).length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'dim', textContent: t('td.noInv') })));
  wrap.append(el('h3', { textContent: t('td.invitees') }), el('div', { className: 'wrap' }, tb));
  if (TD.link && TD.link.tender === tn.id) wrap.append(TD.link.node);
  if (tn.can_manage && tn.status === 'open') wrap.append(tdInviteForm(x, tn));
  return wrap;
}

function tdInviteForm(x, tn) {
  const det = el('details', { className: 'tdbox' }, [el('summary', { textContent: t('td.invite') })]);
  det.ontoggle = async () => {
    if (!det.open || det.dataset.ready) return;
    det.dataset.ready = '1';
    let vendors = [], open = [];
    try {
      [vendors, open] = await Promise.all([TD.vendors || SB.select('pm_vendor', 'select=code,name,email&order=name'), SB.rpc('pm_tender_open_list')]);
      TD.vendors = vendors;
    } catch (e) { msg(x.out, 'err', e.message); }
    const fV = el('select', {}, [el('option', { value: '', textContent: t('td.pickVendor') }), ...vendors.map(v => el('option', { value: v.code, textContent: v.name }))]);
    const fName = el('input', {}), fMail = el('input', { type: 'email' }), fDays = el('input', { type: 'number', value: 14, min: 1, max: 90, style: 'width:80px' });
    fV.onchange = () => { const v = vendors.find(y => y.code === fV.value); if (v) { fName.value = v.name || ''; fMail.value = v.email || ''; } };
    const picks = open.map(o => { const c = el('input', { type: 'checkbox', checked: o.id === tn.id, value: o.id });
      return el('label', { className: 'tdpick' }, [c, ` ${o.project_code} — ${o.title || o.project_name || ''} (${tdDt(o.deadline)})`]); });
    const go = el('button', { className: 'btn pri', type: 'button', textContent: t('td.inviteGo') });
    go.onclick = async () => {
      const ids = picks.map(l => l.querySelector('input')).filter(c => c.checked).map(c => Number(c.value));
      if (!ids.length) ids.push(tn.id);
      const tok = await tdCall('pm_tender_invite_add', { p_tenders: ids, p_vendor_code: fV.value || null, p_name: fName.value.trim(), p_email: fMail.value.trim(), p_days: Number(fDays.value) || 14 }, '');
      if (tok) tdShowLink(fName.value.trim(), fMail.value.trim(), tok, tn);
    };
    const f = (k, i) => el('div', { className: 'fld' }, [el('label', { textContent: t(k) }), i]);
    det.append(el('div', { className: 'row' }, [f('td.f.vendor', fV), f('td.f.name', fName), f('td.f.email', fMail), f('td.f.days', fDays)]),
      picks.length > 1 ? el('div', {}, [el('div', { className: 'tdnote', textContent: t('td.multi') }), ...picks]) : '',
      el('div', { className: 'row' }, [go]));
  };
  return det;
}

/* The link is shown ONCE: the database keeps only a hash of the code. A ready
   e-mail (mailto) carries it with the deadline and what a valid bid needs. */
function tdShowLink(name, email, token, tn) {
  const cfg = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify({ url: CFG.url, key: CFG.key })))));
  const link = new URL('Tender.html', location.href.split('#')[0]).href + '#c=' + cfg + '&t=' + token;
  const inp = el('input', { value: link, readOnly: true, onclick: () => inp.select() });
  const copy = el('button', { className: 'btn pri', type: 'button', textContent: t('td.copy'), onclick: () => { inp.select(); navigator.clipboard?.writeText(link).catch(() => {}); copy.textContent = t('td.copied'); } });
  const mail = el('button', { className: 'btn', type: 'button', textContent: '✉ ' + t('tg.mailInvite'), onclick: () => {
    const x = TD.ctx || {}, p = x.p || WF.project || {};
    tdMail(email, t('tg.mail.invSubj', { p: (tn && tn.title) || p.name || p.code }),
      t('tg.mail.invBody', { v: name, p: `${p.code} — ${(tn && tn.title) || p.name || ''}`, d: tn ? tdDt(tn.deadline) : '', a: (tn && tn.address) || '', link }));
  } });
  const node = el('div', { className: 'msg ok tdlink' }, [el('b', { textContent: t('td.linkFor', { v: name, e: email || '—' }) }),
    el('div', { className: 'tdnote', textContent: t('td.linkOnce') }), el('div', { className: 'row', style: 'flex-wrap:nowrap' }, [inp, copy, mail])]);
  TD.link = { tender: tn ? tn.id : null, node };
  const host = document.querySelector('#tgDrBody .tdone, #wdBody .tdcard .tdone');
  if (host) host.append(node);
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* Clarification questions: vendors ask on the portal; Purchasing or the requesting
   department answers — to the asker only, or shared with every invited vendor
   (without the asker's name). A ready e-mail follows the answer. */
function tdQaBox(x, tn) {
  const wrap = el('div');
  const qa = tn.qa || [];
  wrap.append(el('h3', { textContent: t('tg.qa', { n: qa.length, o: qa.filter(q => q.question && !q.answer).length }) }));
  if (!qa.length) wrap.append(el('div', { className: 'tdnote', textContent: t('tg.qaNone') }));
  for (const q of qa) {
    const row = el('div', { className: 'tgqa' + (q.question && !q.answer ? ' open' : '') });
    if (q.question) row.append(el('div', { className: 'q' }, [el('b', { textContent: q.vendor || '' }), el('small', { className: 'dim', textContent: ' · ' + tdDt(q.asked_at) }),
      el('div', { className: 'mttext', textContent: q.question })]));
    if (q.answer) row.append(el('div', { className: 'a' }, [el('b', { textContent: q.question ? t('tg.answer') : t('tg.announce') }),
      el('small', { className: 'dim', textContent: ` · ${q.answered_name || ''} · ${tdDt(q.answered_at)}${q.shared ? ' · ' + t('tg.sharedAll') : ''}` }),
      el('div', { className: 'mttext', textContent: q.answer })]));
    else if (tn.can_answer) {
      const ta = el('textarea', { rows: 2, placeholder: t('tg.answerPh') });
      const sh = el('input', { type: 'checkbox', checked: true });
      row.append(el('div', { className: 'a' }, [ta, el('div', { className: 'row', style: 'align-items:center;gap:10px' }, [
        el('label', { className: 'tdpick' }, [sh, ' ' + t('tg.shareAll')]),
        el('button', { className: 'btn pri tiny', type: 'button', textContent: t('tg.send'), onclick: async () => {
          const r = await tdCall('pm_tender_answer', { p_qa: q.id, p_answer: ta.value, p_shared: sh.checked }, t('tg.answered'));
          if (r) tdMailAnswer(r, sh.checked);
        } })])]));
    }
    wrap.append(row);
  }
  if (tn.can_answer && tn.status !== 'cancelled') {
    const det = el('details', { className: 'tdbox' }, [el('summary', { textContent: t('tg.announceNew') })]);
    const ta = el('textarea', { rows: 3, placeholder: t('tg.announcePh') });
    det.append(ta, el('div', { className: 'row' }, el('button', { className: 'btn pri tiny', type: 'button', textContent: t('tg.send'), onclick: async () => {
      const r = await tdCall('pm_tender_announce', { p_tender: tn.id, p_text: ta.value }, t('tg.announced'));
      if (r) tdMailAnswer(r, true);
    } })));
    wrap.append(det);
  }
  return wrap;
}
function tdMailAnswer(r, shared) {
  const to = r.to || [];
  if (!to.length) return;
  const body = (r.question ? t('tg.mail.q', { q: r.question }) + '\n\n' : '') + t('tg.mail.a', { a: r.answer }) + '\n\n' + t('tg.mail.sign');
  const subj = t('tg.mail.ansSubj', { p: r.title });
  if (shared && to.length > 1) tdMail('', subj, body, to); else tdMail(to[0], subj, body);
}

/* Site visits requested by vendors: the people coming (ID card, phone) are for the
   security desk; Purchasing picks the time and the reply goes by e-mail. */
function tdSurveyBox(x, tn) {
  const wrap = el('div');
  const list = tn.surveys || [];
  wrap.append(el('h3', { textContent: t('tg.sv', { n: list.length, o: list.filter(s => s.status === 'requested').length }) }));
  if (!list.length) { wrap.append(el('div', { className: 'tdnote', textContent: t('tg.svNone') })); return wrap; }
  for (const s of list) {
    const row = el('div', { className: 'tgqa' + (s.status === 'requested' ? ' open' : '') });
    row.append(el('div', { className: 'q' }, [el('b', { textContent: s.vendor || '' }), ' ', el('span', { className: 'tdchip' + (s.status === 'scheduled' ? ' ok' : s.status === 'requested' ? ' warn' : ''), textContent: t('tg.sv.' + s.status) }),
      el('small', { className: 'dim', textContent: ' · ' + tdDt(s.created_at) }),
      el('div', { textContent: t('tg.svWhen', { d: (s.proposed || []).map(tdDt).join(' · ') }) }),
      el('div', { textContent: t('tg.svContact', { n: s.contact_name || '', p: s.contact_phone || '', e: s.contact_email || '' }) }),
      s.note ? el('div', { className: 'mttext dim', textContent: s.note }) : '']));
    const pt = el('table', { className: 'tdtbl' }, [el('tr', {}, [t('tg.sv.name'), t('tg.sv.id'), t('tg.sv.phone')].map(h => el('th', { textContent: h })))]);
    for (const m of s.people || []) pt.append(el('tr', {}, [el('td', { textContent: m.name || '' }), el('td', { textContent: m.id_no || '' }), el('td', { textContent: m.phone || '' })]));
    row.append(el('div', { className: 'wrap' }, pt));
    if (s.scheduled_at || s.reply) row.append(el('div', { className: 'a' }, [el('b', { textContent: s.scheduled_at ? t('tg.svAt', { d: tdDt(s.scheduled_at) }) : '' }),
      el('small', { className: 'dim', textContent: s.handled_name ? ' · ' + s.handled_name : '' }), s.reply ? el('div', { className: 'mttext', textContent: s.reply }) : '']));
    if (['requested', 'scheduled'].includes(s.status)) {
      const first = (s.proposed || [])[0];
      const fAt = el('input', { type: 'datetime-local', value: first ? tdLocal(new Date(s.scheduled_at || first)) : '' });
      const fRe = el('input', { value: s.reply || '', placeholder: t('tg.svReplyPh') });
      const go = async st => {
        const r = await tdCall('pm_tender_survey_set', { p_id: s.id, p_status: st, p_at: st === 'scheduled' ? tdIso(fAt.value) : null, p_reply: fRe.value }, t('td.done'));
        if (r && r.to && st !== 'done') tdMail(r.to, t('tg.mail.svSubj', { p: r.title }),
          st === 'scheduled' ? t('tg.mail.svBody', { v: r.vendor || '', d: tdDt(tdIso(fAt.value)), r: fRe.value || '' }) : t('tg.mail.svNo', { v: r.vendor || '', r: fRe.value || '' }));
      };
      row.append(el('div', { className: 'row', style: 'align-items:flex-end;gap:6px;flex-wrap:wrap' }, [
        el('div', { className: 'fld' }, [el('label', { textContent: t('tg.svPick') }), fAt]), el('div', { className: 'fld grow' }, [el('label', { textContent: t('tg.svReply') }), fRe]),
        el('button', { className: 'btn pri tiny', type: 'button', textContent: t('tg.svSchedule'), onclick: () => go('scheduled') }),
        s.status === 'scheduled' ? el('button', { className: 'btn tiny', type: 'button', textContent: t('tg.svDone'), onclick: () => go('done') }) : '',
        el('button', { className: 'btn tiny danger', type: 'button', textContent: t('tg.svCancel'), onclick: () => go('cancelled') })]));
    }
    wrap.append(row);
  }
  return wrap;
}

// Consent to open: one per role of the QC chain (steps 0–2), three different people.
function tdConsentBox(x, tn) {
  const wrap = el('div');
  const sealed = (tn.invitees || []).reduce((s, v) => s + (v.bids || []).filter(b => b.submitted_at && !b.opened_at).length, 0);
  const cons = el('div', { className: 'tdcons' });
  for (const r of tn.open_roles || []) {
    const c = (tn.consents || []).find(y => y.role === r);
    const cell = el('div', { className: 'tdrole' + (c ? ' ok' : '') }, [el('b', { textContent: wfRoleName(r) })]);
    if (c) cell.append(el('small', { textContent: `✓ ${c.user || ''} · ${tdDt(c.at)}` }));
    else if (sealed && wfHasRoleFor(r, x.p.dept_code)) cell.append(el('button', { className: 'btn pri tiny', type: 'button', textContent: t('td.consent'),
      onclick: async () => { if (!confirm(t('td.consentQ'))) return;
        const res = await tdCall('pm_tender_consent_give', { p_tender: tn.id, p_role: r }, '');
        if (res) msg(x.out, 'ok', t(res === 'opened' ? 'td.openedNow' : 'td.waiting')); } }));
    else cell.append(el('small', { className: 'dim', textContent: t('td.pending') }));
    cons.append(cell);
  }
  wrap.append(el('h3', { textContent: t('td.consents') }), el('div', { className: 'tdnote', textContent: sealed ? t('td.sealedN', { n: sealed }) : t('td.noSealed') }), cons);
  return wrap;
}

/* Opened bids: totals, terms, files — and "Input to QC". On the board the QC is
   created (or reopened) and filled; under a QC on the document screen the bids
   load into that QC's draft directly. */
function tdOpenedTable(x, tn, op) {
  const wrap = el('div');
  const tb = el('table', { className: 'tdtbl' });
  tb.append(el('tr', {}, ['', 'td.h.vendor', 'td.h.version', 'td.h.total', 'td.h.terms', 'td.h.files'].map(k => el('th', { textContent: k ? t(k) : '' }))));
  const checks = op.map((o, i) => {
    const c = el('input', { type: 'checkbox', checked: i < 3 });
    const d = o.bid.data || {};
    const diff = (tn.items || []).map((it, k) => d.qtys && d.qtys[k] != null && d.qtys[k] !== '' && n0(d.qtys[k]) !== n0(it.qty) ? `#${k + 1}: ${d.qtys[k]}` : '').filter(Boolean);
    tb.append(el('tr', {}, [el('td', { className: 'c' }, c), el('td', { textContent: o.inv.name || '' }),
      el('td', { textContent: `v${o.bid.version}${o.bid.round > 1 ? ' · ' + t('td.round', { n: o.bid.round }) : ''}${o.bid.note ? ' · ' + o.bid.note : ''}` }),
      el('td', { className: 'n' }, [document.createTextNode(fmtMoney(tdTotal(tn, d))), diff.length ? el('div', { className: 'tglate', textContent: t('tg.qtyDiff', { l: diff.join(', ') }) }) : '']),
      el('td', { style: 'white-space:normal', textContent: [tdPayText(d), d.delivery && t('td.t.delivery') + ': ' + d.delivery, d.warranty && t('td.t.warranty') + ': ' + d.warranty,
        d.validity && t('td.t.validity') + ': ' + d.validity].filter(Boolean).join(' · ') }),
      el('td', {}, (o.bid.files || []).map(f => el('div', {}, el('a', { href: '#', textContent: (f.kind === 'quotation' ? '★ ' : '') + (f.name || 'file'),
        onclick: ev => { ev.preventDefault(); tdFile(f); } }))))]));
    return c;
  });
  // Every quotation of the opened bids in one window, vendor after vendor (user 29/09/2026).
  const allFiles = op.flatMap(o => (o.bid.files || []).map(f => ({ label: o.inv.name || '', sub: (f.kind === 'quotation' ? '★ ' : '') + (f.name || 'file'), name: f.name,
    get: () => dvStored('pm-tender', f.path) })));
  if (allFiles.length) wrap.append(el('div', { className: 'row', style: 'margin:4px 0' }, el('button', { className: 'btn tiny', type: 'button',
    textContent: '👁 ' + t('dv.allBids', { n: allFiles.length }), onclick: () => dvOpen(`${tn.title || ''} — ${t('dv.bidsH')}`, allFiles) })));
  wrap.append(el('div', { className: 'wrap' }, tb));
  const pick = () => { const p = op.filter((o, i) => checks[i].checked); if (!p.length || p.length > 3) { msg(x.out, 'warn', t('td.pick3')); return null; } return p; };
  if (x.mode === 'qc') {
    const qcDoc = x.qc, qcDraft = WF.drafts.get(qcDoc.id);
    if (wfDocEditable(qcDoc) || wfAdminMode()) {
      const go = el('button', { className: 'btn pri', type: 'button', textContent: t('td.load') });
      go.onclick = () => { const p = pick(); if (!p) return;
        if ((qcDraft.vendors || []).some(v => v.name) && !confirm(t('td.loadQ'))) return;
        tdToQc(qcDoc, tn, p); };
      wrap.append(el('div', { className: 'row', style: 'margin-top:8px;align-items:center' }, [go, el('span', { className: 'tdnote', textContent: t('td.loadHint') })]));
    } else wrap.append(el('div', { className: 'tdnote', textContent: t('td.loadNo') }));
    return wrap;
  }
  const qc = x.qc;
  if (qc && ['in_review', 'approved'].includes(qc.status)) wrap.append(el('div', { className: 'tdnote', textContent: t('tg.qcBusy', { no: qc.doc_no, s: t('wf.st.' + qc.status) }) }));
  else if (wfCanPrepare('QC', x.p.dept_code) || can('project', 'admin')) {
    const go = el('button', { className: 'btn pri', type: 'button', textContent: '➜ ' + t('tg.toQc') });
    go.onclick = () => { const p = pick(); if (!p) return;
      TD.pend = { code: x.p.code, tid: tn.id, bids: p.map(o => o.bid.id) };
      tdDrawerClose();
      if (qc) wfOpen(qc.id); else wfCreateFor(x.p.code, 'QC', '#tgMsg');
    };
    wrap.append(el('div', { className: 'row', style: 'margin-top:8px;align-items:center' }, [go, el('span', { className: 'tdnote', textContent: t('tg.toQcHint') })]));
  }
  return wrap;
}

/* Under the QC on the document screen: the project's calls for quotations in
   short, a way to the Tendering screen, and the opened bids to (re)load. A
   pending "Input to QC" from the board is carried out here, once the QC is
   loaded. */
function tdQcCard(qcDoc) {
  const card = el('div', { className: 'card tdcard' });
  const out = el('div', { id: 'tdMsg' }), body = el('div', { textContent: t('td.loading') });
  const code = WF.project.code;
  card.append(el('div', { className: 'chead' }, [el('h2', { textContent: t('tg.qcCard') }),
    el('div', { className: 'row', style: 'gap:6px' }, [
      el('button', { className: 'btn tiny', type: 'button', textContent: '↻', title: t('td.refresh'), onclick: () => { TD.qc = null; wfRender(); } }),
      el('button', { className: 'btn tiny', type: 'button', textContent: t('tg.openBoard'), onclick: () => { TD.open = code; showView('tendering'); } })])]), out, body);
  (async () => {
    try {
      if (TD.qc !== qcDoc.id || !TD.list) { TD.list = await SB.rpc('pm_tender_list', { p_project: code }); TD.qc = qcDoc.id; }
    } catch (e) { body.textContent = ''; body.append(el('div', { className: 'tdnote', textContent: /pm_tender_list|PGRST202|404/.test(e.message) ? t('td.notInstalled') : e.message })); return; }
    const x = { p: WF.project, qc: qcDoc, out, mode: 'qc', list: TD.list, redraw: () => wfRender() };
    TD.ctx = x;
    // "Input to QC" pressed on the board: link the tender, load the chosen bids.
    if (TD.pend && TD.pend.code === code) {
      const pd = TD.pend; TD.pend = null;
      const tn = TD.list.find(y => y.id === pd.tid);
      if (tn) {
        if (tn.qc_doc_id !== qcDoc.id) { try { await SB.rpc('pm_tender_link_qc', { p_tender: tn.id, p_qc: qcDoc.id }); tn.qc_doc_id = qcDoc.id; } catch {} }
        const pick = tdOpened(tn).filter(o => pd.bids.includes(o.bid.id));
        if (pick.length && (wfDocEditable(qcDoc) || wfAdminMode())) return tdToQc(qcDoc, tn, pick);
      }
    }
    body.innerHTML = '';
    const live = TD.list.filter(tn => tn.status !== 'cancelled');
    if (!live.length) { body.append(el('div', { className: 'tdnote', textContent: t('tg.qcNone') })); return; }
    for (const tn of live) {
      const inv = (tn.invitees || []).filter(v => !v.revoked);
      const sub = inv.filter(v => (v.bids || []).some(b => b.round === tn.round && b.status === 'submitted')).length;
      const op = tdOpened(tn);
      body.append(el('div', { className: 'tdone' }, [
        el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [el('b', { textContent: tn.title || '' }),
          el('span', { className: 'dim', textContent: `${t('td.f.deadline')}: ${tdDt(tn.deadline)} · ${t('tg.progress', { s: sub, m: tn.min_bids, i: inv.length })}` })]),
        op.length ? tdOpenedTable(x, tn, op) : el('div', { className: 'tdnote', textContent: t('tg.qcSealed') })]));
    }
  })();
  return card;
}

/* The chosen bids into the QC appendix, as a draft: items (the tender's, whose
   order the prices follow), overhead lines (the union of the vendors', qty ×
   price), each vendor's prices, spec by field, payment schedule + terms, and
   the capability declarations as the notes beside each criterion. Scores stay
   for Purchasing — kept if the vendor was already in the QC. The criteria of
   the call become the QC's sub-criteria (weights kept where the label is the same). */
function tdToQc(qcDoc, tn, pick) {
  const d = WF.drafts.get(qcDoc.id);
  const old = d.vendors || [];
  d.qlines = (tn.items || []).map((it, i) => Object.assign({}, (d.qlines || [])[i] || {}, { item: it.item, qty: it.qty }));
  const labels = [];
  for (const o of pick) for (const l of (o.bid.data || {}).olines || []) {
    const k = String(l.label || '').trim();
    if (k && !labels.some(y => y.toLowerCase() === k.toLowerCase())) labels.push(k);
  }
  d.olines = labels.map(label => ({ label }));
  const subs = (grp, cur) => { const ls = (tn.crit || []).filter(c => c.grp === grp).map(c => c.label);
    if (!ls.length) return cur; const base = qcSubs(ls); return base.map(s => Object.assign(s, { w: ((cur || []).find(c => c.label === s.label) || s).w })); };
  d.sub_ability = subs('ability', d.sub_ability); d.sub_technique = subs('technique', d.sub_technique);
  const abil = new Set((tn.crit || []).filter(c => c.grp === 'ability').map(c => c.label));
  d.vendors = pick.map(o => {
    const b = o.bid.data || {}, prev = old.find(v => v.name && v.name.trim().toLowerCase() === String(o.inv.name || '').trim().toLowerCase()) || {};
    const oprices = {};
    (b.olines || []).forEach(l => { const i = labels.findIndex(y => y.toLowerCase() === String(l.label || '').trim().toLowerCase()); if (i >= 0) oprices[i] = n0(oprices[i]) + tdOhAmt(l); });
    const n_ability = {}, n_technique = {};
    for (const [lbl, txt] of Object.entries(b.crit || {})) if (txt) (abil.has(lbl) ? n_ability : n_technique)[lbl] = txt;
    const diff = (tn.items || []).map((it, k) => b.qtys && b.qtys[k] != null && b.qtys[k] !== '' && n0(b.qtys[k]) !== n0(it.qty) ? `${it.item}: ${b.qtys[k]}${b.units && b.units[k] ? ' ' + b.units[k] : ''} (req. ${it.qty})` : '').filter(Boolean);
    return Object.assign({}, prev, { name: o.inv.name, prices: Object.assign({}, b.prices), specx: JSON.parse(JSON.stringify(b.specx || {})),
      specs: Object.assign({}, b.specs), oprices, pay_term: tdPayText(b) || prev.pay_term || '', pay_sched: b.pay_sched || [], n_ability, n_technique,
      delivery: b.delivery || '', warranty: b.warranty || '', validity: b.validity || '',
      bid_note: [b.note, diff.length ? 'Quoted quantity differs — ' + diff.join('; ') : ''].filter(Boolean).join(' · '),
      tender_bid: o.bid.id, tender_invitee: o.inv.id, vendor_code: o.inv.vendor_code || prev.vendor_code || null });
  });
  while (d.vendors.length < 3) d.vendors.push({ name: '' });
  const submitted = (tn.invitees || []).filter(v => (v.bids || []).some(b => b.submitted_at)).length;
  // The vendors that sent a quotation on the portal (user 29/09/2026: the valid quotations, not the invited).
  d.total_vendors = Math.max(submitted, pick.length); d.tender_submitted = submitted;
  d.tender_id = tn.id;
  WF.ref = null;
  wfSetDoc('QC');
  WF.qcTab = 'appendix';
  WF.dirty = true; WF.dirtyIds.add(qcDoc.id);
  wfRender();
  msg('#wdMsg', 'ok', t('td.loaded', { n: pick.length }));
}

/* ------------------------------------------------------------ sending the approved PO
   To the chosen vendor: recorded (pm_po_send), shown on their portal when they
   quoted through it (their link is kept alive 60 more days), the PO exported as
   PDF to attach, and a ready e-mail. */
async function tdPoSend() {
  const d = WF.doc, p = WF.project;
  const out = '#wdMsg';
  let invitees = [], chosen = null, vendors = [];
  try {
    const list = await SB.rpc('pm_tender_list', { p_project: p.code }).catch(() => []);
    invitees = list.flatMap(tn => (tn.invitees || []).map(v => Object.assign({ tender: tn.title }, v)));
    const qc = (WF.refs || []).map(r => r.d).find(x => x.doc_type === 'QC');
    const a = qc && qc.data && (qc.data.vendors || [])[0];
    if (a) chosen = invitees.find(v => v.id === a.tender_invitee || (v.bids || []).some(b => b.id === a.tender_bid)) || null;
    vendors = await SB.select('pm_vendor', 'select=code,name,email&order=name').catch(() => []);
  } catch (e) { return msg(out, 'err', e.message); }
  const supplier = (d.data || {}).supplier || '';
  const vRow = vendors.find(v => hnorm(v.name) === hnorm(supplier));
  const fInv = el('select');
  selFill(fInv, [['', t('tg.po.noPortal')], ...invitees.map(v => [String(v.id), `${v.name}${v.email ? ' · ' + v.email : ''}${v.tender ? ' — ' + v.tender : ''}`])]);
  fInv.value = chosen ? String(chosen.id) : '';
  const fMail = el('input', { type: 'email', value: (chosen && chosen.email) || (vRow && vRow.email) || '' });
  fInv.onchange = () => { const v = invitees.find(y => String(y.id) === fInv.value); if (v && v.email) fMail.value = v.email; };
  const fNote = el('textarea', { rows: 3, value: t('tg.po.noteDefault') });
  const fPdf = el('input', { type: 'checkbox', checked: true });
  const box = tdModal(t('tg.po.title', { no: d.doc_no }), [
    el('div', { className: 'tdnote', textContent: t('tg.po.hint', { v: supplier || '—' }) }),
    el('div', { className: 'fld' }, [el('label', { textContent: t('tg.po.portal') }), fInv]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('td.f.email') }), fMail]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('tg.po.note') }), fNote]),
    el('label', { className: 'tdpick' }, [fPdf, ' ' + t('tg.po.pdf')])], [
    [t('tg.po.send'), 'pri', async close => {
      try {
        await SB.rpc('pm_po_send_do', { p_doc: d.id, p_invitee: fInv.value ? Number(fInv.value) : null, p_email: fMail.value.trim() || null, p_note: fNote.value.trim() || null });
        close();
        if (fPdf.checked) { try { await wfPdf(); } catch {} }
        tdMail(fMail.value.trim(), t('tg.po.mailSubj', { no: d.doc_no, p: p.name || p.code }),
          t('tg.po.mailBody', { v: supplier, no: d.doc_no, p: `${p.code} — ${p.name || ''}`, n: fNote.value.trim(), portal: fInv.value ? t('tg.po.mailPortal') : '' }));
        msg(out, 'ok', t('tg.po.sent', { v: supplier || fMail.value }));
        wfRender();
      } catch (e) { msg(box.out, 'err', e.message); }
    }], [t('auth.cancel'), '', close => close()]]);
}
// When and to whom the PO went (shown on the approved PO).
function tdPoSends(d, p) {
  const card = el('div', { className: 'card' });
  SB.rpc('pm_po_sends', { p_project: p.code }).then(rows => {
    rows = (rows || []).filter(r => r.doc_id === d.id);
    if (!rows.length) { card.remove(); return; }
    card.append(el('h2', { textContent: t('tg.po.sentH') }), ...rows.map(r => el('div', { className: 'ctpanelrow' }, [
      el('b', { textContent: r.vendor || '' }), document.createTextNode(` · ${r.email || ''} · ${tdDt(r.sent_at)} · ${r.sent_name || ''} `),
      r.portal ? el('span', { className: 'tdchip', textContent: t('tg.po.onPortal') }) : '',
      el('span', { className: 'tdchip ' + (r.ack_at ? 'ok' : 'warn'), textContent: r.ack_at ? t('tg.po.acked', { d: tdDt(r.ack_at) }) : t('tg.po.notAcked') })])));
  }).catch(() => card.remove());
  return card;
}

// A small dialog: title, body nodes, buttons [label, cls, fn(close)].
function tdModal(title, kids, buttons) {
  const bg = el('div', { className: 'tgmodal' });
  const out = el('div');
  const close = () => bg.remove();
  const panel = el('div', { className: 'tgmpanel', role: 'dialog' }, [el('h2', { textContent: title }), out, ...kids,
    el('div', { className: 'row', style: 'justify-content:flex-end;gap:8px;margin-top:12px' },
      buttons.map(([l, c, fn]) => el('button', { className: 'btn ' + c, type: 'button', textContent: l, onclick: () => fn(close) })))]);
  bg.append(panel);
  bg.onclick = e => { if (e.target === bg) close(); };
  document.body.append(bg);
  const f = panel.querySelector('input,select,textarea'); if (f) f.focus();
  return { out, close };
}

/* ------------------------------------------------------------ project drawer, To-do list, bell */
async function tdProjectPanel(p, card) {
  let list;
  try { list = await SB.rpc('pm_tender_list', { p_project: p.code }); } catch { return; }
  const live = (list || []).filter(tn => tn.status !== 'cancelled');
  if (!live.length) return;
  card.append(el('h2', { style: 'margin-top:14px', textContent: t('tg.panelH') }), ...live.map(tn => {
    const inv = (tn.invitees || []).filter(v => !v.revoked);
    const sub = inv.filter(v => (v.bids || []).some(b => b.round === tn.round && b.status === 'submitted')).length;
    return el('div', { className: 'ctpanelrow' }, [el('a', { className: 'aolink', href: '#', textContent: tn.title || p.name || p.code,
      onclick: e => { e.preventDefault(); ppDrawerClose(); TD.open = p.code; showView('tendering'); } }),
      document.createTextNode(` · ${t('td.f.deadline')}: ${tdDt(tn.deadline)} · ${t('tg.progress', { s: sub, m: tn.min_bids, i: inv.length })}`)]);
  }));
}

// To-do rows of the new flow, in the shape of the To-do list (what / band / open).
const TD_TABLET = new Set(['recv', 'td_open']);
async function tdTodos() {
  if (!ME) return [];
  let rows;
  try { rows = await SB.rpc('pm_todo_proc'); window.TD_PROC_OK = true; } catch { window.TD_PROC_OK = false; return []; }
  return rows.map(r => ({ kind: 'x:' + r.kind, x: true, tablet: TD_TABLET.has(r.kind), what: t('tg.i.' + r.kind, { n: r.n ?? '', m: r.detail || '' }),
    band: ['td_due'].includes(r.kind) ? 'bad' : ['td_open'].includes(r.kind) ? 'am' : 'op',
    docLabel: r.ref_no || '', typeLabel: t('tg.it.' + r.kind), doc_no: '', project_code: r.project_code, project_name: r.project_name,
    dept_code: r.dept_code, submitted_at: r.at, total_value: null, open: () => tdTodoOpen(r) }));
}
function tdTodoOpen(r) {
  if (/^td_/.test(r.kind)) { TD.open = r.project_code; return showView('tendering'); }
  if (r.kind === 'recv') { if (window.RV) { RV.al = r.ref_id; } return showView('recv'); }
  if (r.kind === 'codes') return tdCodes(r.ref_id);
  return wfOpen(r.ref_id);                                  // po_send / ct_upload: the approved PO, with its buttons
}
// "Generate asset codes" from the To-do list: the approved PO's lines into a new delivery, then the ALR.
async function tdCodes(poId) {
  try {
    const [doc] = await SB.select('pm_doc', `select=*&id=eq.${poId}`);
    const [p] = await SB.select('pm_project', `select=*&code=eq.${encodeURIComponent(doc.project_code)}`);
    wfToIntake(doc, p, { alr: true });
  } catch (e) { msg('#wiMsg', 'err', e.message); }
}

// Bell notices of the new flow: text, and where a click goes.
window.ntHook = r => {
  if (r.kind === 'tender') return { text: t('tg.nt.tender', { no: r.doc_no || '' }), open: () => { TD.open = r.project_code; showView('tendering'); } };
  if (r.kind === 'next' && r.doc_type === 'QC') return { text: t('tg.nt.callQuotes', { no: r.doc_no || '' }), open: () => { TD.open = r.project_code; showView('tendering'); } };
  if (r.kind === 'next' && r.doc_type === 'AL') return { text: t('tg.nt.codes', { no: r.doc_no || '' }), open: () => r.doc_id && wfOpen(r.doc_id) };
  if (r.kind === 'next' && r.doc_type === 'RV') return { text: t('tg.nt.recv', { no: r.doc_no || '' }), open: () => { if (window.RV) RV.al = r.doc_id; showView('recv'); } };
  if (r.kind === 'info' && r.doc_type === 'AL') return { text: t('tg.nt.alrReady', { no: r.doc_no || '' }), comment: null, open: () => r.doc_id && wfOpen(r.doc_id) };
  if (r.kind === 'info' && r.doc_type === 'PO') return { text: t('tg.nt.poAck', { no: r.doc_no || '', v: String(r.comment || '').replace(/^po_ack: /, '') }), comment: null,
    open: () => r.doc_id && wfOpen(r.doc_id) };
  if (r.doc_type === 'TT' && window.pqNotice) return pqNotice(r);
  if (r.doc_type === 'LQ' && window.lqNotice) return lqNotice(r);           // liquidation batches (lqflow.js)
  return null;
};
