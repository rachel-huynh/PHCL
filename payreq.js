/* ============================================================ PAYMENT REQUESTS
   Project management → Payment → Payment requests (42_payment_request.sql, user 28–29/09/2026).
   After the contract is confirmed, Purchasing requests the 1st payment — the amount comes from
   the contract's payment schedule and may be adjusted (with the reason and the vendor's own
   payment-request letter) — and attaches the documents. On sending, the Chief Accountant is
   asked to approve and the Accountant is told at the same time (to follow it); every form of
   the project is on the request, to check at once. The CA approves (and signs); the Accountant
   then sees "approved — proceed to payment" and, once paid, confirms it — several at once.
   Interim payments go the same way; the FINAL payment opens only once the last AH is
   approved, and paying it completes the project. A CA-approved request marks the printed
   dossier "Approved by CA — name — time".
   Route (roles per step) in am_setting pay_route (an empty "check" = no checking step). Files in
   the private bucket pm-payreq (<request id>/<file>) or OneDrive links. Loaded after app.js /
   contracts.js / tendering.js. */

const PQ = { rows: [], todo: [], tab: 'mine', q: '', open: null, cur: null, route: null, flash: null, prj: new Map(), sel: new Set() };
const PQ_STEPS = ['prep', 'check', 'approve', 'process'];
const pqMissing = e => /pm_payreq|pm_todo_pay|PGRST20[25]|does not exist|404/.test(String(e && e.message));
const pqChip = s => el('span', { className: 'ctst pq-' + s, textContent: t('pq.st.' + s) });
const pqAmt = r => r.amount_total != null ? Number(r.amount_total) : r.amount != null ? Number(r.amount) : null;

async function pqRoute() {
  if (PQ.route) return PQ.route;
  try { const [r] = await SB.select('am_setting', 'select=value&key=eq.pay_route'); PQ.route = (r && r.value) || null; } catch {}
  PQ.route = PQ.route || { prep: ['PURCHASING'], check: [], approve: ['CHIEF_ACC'], process: ['ACCOUNTANT'], watch: ['ACCOUNTANT'] };
  return PQ.route;
}
// May I act at this step for this department? (the server checks again)
const pqCan = (step, dept) => (PQ.route[step] || []).some(r => wfHasRoleFor(r, dept)) || (step === 'prep' && wfCanPrepare('PO', dept));

async function pqLoad() {
  const out = $('#pqMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups(); await wfLookups(); await pqRoute();
    const [rows, todo] = await Promise.all([SB.select('pm_payreq', 'select=*&order=id.desc&limit=2000'), SB.rpc('pm_todo_pay').catch(() => [])]);
    PQ.rows = rows; PQ.todo = todo;
    // Testing switch (am_setting pm_allow_self_approve): the preparer may also check / approve.
    PQ.selfOk = await SB.select('am_setting', 'select=value&key=eq.pm_allow_self_approve').then(([s]) => !!s && (s.value === true || s.value === 'true')).catch(() => false);
    const codes = [...new Set(rows.map(r => r.project_code).concat(todo.map(r => r.project_code)))];
    const prj = codes.length ? await pmSelectAll('pm_project', `select=code,name,dept_code,status&code=in.(${codes.map(encodeURIComponent).join(',')})`) : [];
    PQ.prj = new Map(prj.map(p => [p.code, p]));
    msg(out, PQ.flash ? 'ok' : '', PQ.flash || ''); PQ.flash = null;
    pqRender();
    if (PQ.open) { const id = PQ.open; PQ.open = null; pqView(id); }
    if (PQ.newFor) { const c = PQ.newFor; PQ.newFor = null; pqNew(c); }
  } catch (e) { $('#pqBody').innerHTML = ''; msg(out, 'err', pqMissing(e) ? t('pq.notInstalled') : e.message); }
}

function pqRender() {
  const body = $('#pqBody'), tabs = $('#pqTabs');
  if (!body) return;
  const mine = new Set(PQ.todo.filter(r => /^pay_(check|approve|process|returned)$/.test(r.kind)).map(r => r.ref_id));
  const toMake = PQ.todo.filter(r => ['pay_first', 'pay_final'].includes(r.kind));
  const list = [['mine', t('pq.t.mine', { n: mine.size + toMake.length })], ['open', t('pq.t.open', { n: PQ.rows.filter(r => ['check', 'approve', 'process', 'returned', 'draft'].includes(r.status)).length })],
                ['paid', t('pq.t.paid', { n: PQ.rows.filter(r => r.status === 'paid').length })], ['all', t('pq.t.all', { n: PQ.rows.length })]];
  tabs.innerHTML = '';
  for (const [v, label] of list) { const b = el('button', { type: 'button', textContent: label, className: PQ.tab === v ? 'on' : '' }); b.onclick = () => { PQ.tab = v; pqRender(); }; tabs.append(b); }
  body.innerHTML = '';
  const sum = (f) => PQ.rows.filter(f).reduce((s, r) => s + (pqAmt(r) || 0), 0);
  const month = new Date().toISOString().slice(0, 7);
  const tile = (k, v, s) => el('div', { className: 'aokpi' }, [el('small', { textContent: t(k) }), el('b', { textContent: v }), s ? el('span', { textContent: s }) : '']);
  body.append(el('div', { className: 'aokpis' }, [
    ...(pqHasCheck() || PQ.rows.some(r => r.status === 'check') ? [tile('pq.k.check', fmtInt(PQ.rows.filter(r => r.status === 'check').length), fmtM(sum(r => r.status === 'check')))] : []),
    tile('pq.k.approve', fmtInt(PQ.rows.filter(r => r.status === 'approve').length), fmtM(sum(r => r.status === 'approve'))),
    tile('pq.k.process', fmtInt(PQ.rows.filter(r => r.status === 'process').length), fmtM(sum(r => r.status === 'process'))),
    tile('pq.k.paidMonth', fmtM(PQ.rows.filter(r => r.status === 'paid' && String(r.paid_at || '').slice(0, 7) === month).reduce((s, r) => s + (Number(r.paid_amount) || pqAmt(r) || 0), 0)), t('pq.k.paidSub'))]));
  const card = el('div', { className: 'card' });
  // Requests still to be drawn up (Purchasing): contract confirmed, or last AH approved.
  if (PQ.tab === 'mine' && toMake.length) {
    card.append(el('h3', { textContent: t('pq.toMake') }), ...toMake.map(r => el('div', { className: 'ctpanelrow' }, [
      el('span', { className: 'stg band-op', textContent: t('pq.i.' + r.kind) }), document.createTextNode(` ${r.project_code} — ${r.project_name || ''} · ${r.ref_no || ''} `),
      el('button', { className: 'btn tiny pri', type: 'button', textContent: t('pq.newBtn'), onclick: () => pqNew(r.project_code) })])));
  }
  const q = el('input', { value: PQ.q, placeholder: t('pq.searchPh') });
  q.oninput = () => { PQ.q = q.value; clearTimeout(q._t); q._t = setTimeout(() => { pqRender(); const f = $('#pqBody .card input'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 250); };
  card.append(el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, [el('label', { textContent: t('ct.search') }), q])]));
  const words = hnorm(PQ.q).split(/\s+/).filter(Boolean);
  const rows = PQ.rows.filter(r => (PQ.tab === 'all' || (PQ.tab === 'mine' && mine.has(r.id)) || (PQ.tab === 'paid' && r.status === 'paid')
      || (PQ.tab === 'open' && ['draft', 'check', 'approve', 'process', 'returned'].includes(r.status)))
    && words.every(w => hnorm([r.no, r.project_code, (PQ.prj.get(r.project_code) || {}).name, r.milestone, r.invoice_no, r.voucher_no].join(' ')).includes(w)));
  // The Accountant: approved requests ticked, then "paid" for all of them at once.
  const payable = r => r.status === 'process' && pqCan('process', (PQ.prj.get(r.project_code) || {}).dept_code);
  const canPay = rows.some(payable);
  for (const id of [...PQ.sel]) if (!rows.some(r => r.id === id && payable(r))) PQ.sel.delete(id);
  if (canPay) card.append(pqPayBar(rows.filter(payable)));
  const tb = el('table', { className: 'lqbt' });
  tb.append(el('tr', {}, [...(canPay ? [['', 'tick']] : []), ['pq.c.no'], ['pm.col.code'], ['pm.col.name'], ['pq.c.kind'], ['pq.c.milestone'], ['pq.c.amount', 'num'], ['pq.c.total', 'num'], ['pq.c.status'], ['pq.c.sent'], ['pq.c.paid']]
    .map(([k, c]) => el('th', { className: c || '', textContent: k ? t(k) : '' }))));
  for (const r of rows) {
    const p = PQ.prj.get(r.project_code) || {};
    const tick = canPay ? el('td', { className: 'tick', onclick: e => e.stopPropagation() }, payable(r) ? (() => {
      const cb = el('input', { type: 'checkbox', checked: PQ.sel.has(r.id) });
      cb.onchange = () => { cb.checked ? PQ.sel.add(r.id) : PQ.sel.delete(r.id); pqRender(); };
      return cb; })() : '') : null;
    const tr = el('tr', { className: 'aoclick' + (mine.has(r.id) ? ' pqmine' : '') }, [...(tick ? [tick] : []), el('td', {}, el('code', { textContent: r.no })), el('td', {}, el('code', { textContent: r.project_code })),
      el('td', { className: 'aowrap', textContent: p.name || '' }), el('td', { textContent: t('pq.kind.' + r.kind) }), el('td', { className: 'aowrap', textContent: r.milestone || '' }),
      el('td', { className: 'num', textContent: r.amount != null ? fmtMoney(r.amount) : '' }), el('td', { className: 'num', textContent: r.amount_total != null ? fmtMoney(r.amount_total) : '' }),
      el('td', {}, pqChip(r.status)), el('td', { textContent: fmtDate(String(r.submitted_at || '').slice(0, 10)) }),
      el('td', { textContent: r.paid_at ? `${fmtDate(r.paid_at)}${r.voucher_no ? ' · ' + r.voucher_no : ''}` : '' })]);
    tr.onclick = () => pqView(r.id);
    tb.append(tr);
  }
  card.append(rows.length ? el('div', { className: 'wrap' }, tb) : el('div', { className: 'dim', style: 'padding:10px 2px', textContent: PQ.tab === 'mine' ? t('pq.mineEmpty') : t('pm.none.filter') }));
  body.append(card);
}

const pqHasCheck = () => !!(PQ.route && (PQ.route.check || []).length);
// "Confirm payment" for the ticked approved requests: one date and voucher for all.
function pqPayBar(list) {
  const n = PQ.sel.size, sum = list.filter(r => PQ.sel.has(r.id)).reduce((s, r) => s + (pqAmt(r) || 0), 0);
  const all = el('input', { type: 'checkbox', checked: n > 0 && n === list.length });
  all.onchange = () => { list.forEach(r => all.checked ? PQ.sel.add(r.id) : PQ.sel.delete(r.id)); pqRender(); };
  const fAt = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }), fV = el('input', { placeholder: t('pq.voucherPh') });
  const go = el('button', { className: 'btn pri', type: 'button', disabled: !n, textContent: '✔ ' + t('pq.payMany', { n }) });
  go.onclick = async () => {
    if (!confirm(t('pq.payManyQ', { n, s: fmtMoney(sum) }))) return;
    try { const k = await SB.rpc('pm_payreq_paid_many', { p_ids: [...PQ.sel], p: { paid_at: fAt.value, voucher_no: fV.value.trim() || null } });
          PQ.sel.clear(); await pqReload(t('pq.paidMany', { n: k })); }
    catch (e) { msg('#pqMsg', 'err', e.message); }
  };
  return el('div', { className: 'pqpaybulk' }, [el('label', { className: 'tdpick' }, [all, ' ' + t('pq.payAll', { n: list.length })]),
    el('b', { textContent: n ? t('pq.paySel', { n, s: fmtMoney(sum) }) : t('pq.payPick') }), el('span', { style: 'flex:1' }),
    el('div', { className: 'fld' }, [el('label', { textContent: t('pq.paidAt') }), fAt]), el('div', { className: 'fld' }, [el('label', { textContent: t('pq.voucher') }), fV]), go]);
}

/* ------------------------------------------------------------ the drawer */
function pqDrawerEl() {
  let dr = $('#pqDrawer');
  if (dr) return dr;
  dr = el('div', { id: 'pqDrawer', className: 'drawer pqdrawer', role: 'dialog', hidden: true }, [
    el('div', { className: 'dhead' }, [el('h2', { id: 'pqDrTitle' }), el('button', { className: 'dbtn', type: 'button', textContent: '✕', onclick: pqDrawerClose })]),
    el('div', { id: 'pqDrBody', className: 'dbody' })]);
  document.body.append(dr);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dr.hidden) pqDrawerClose(); });
  return dr;
}
function pqDrawerClose() { const d = $('#pqDrawer'); if (d) { d.hidden = true; $('#pqDrBody').innerHTML = ''; } PQ.cur = null; }
async function pqReload(flash, id) {
  PQ.flash = flash || null;
  await pqLoad();
  if (id) pqView(id);
}

// A new request for a project: kind, the contract's schedule line, amount — saved as a draft, then files.
async function pqNew(code) {
  const dr = pqDrawerEl(), body = $('#pqDrBody');
  dr.hidden = false; body.innerHTML = '';
  $('#pqDrTitle').textContent = t('pq.newH', { p: code });
  const out = el('div'); body.append(out);
  try {
    await pqRoute();
    const st = await SB.rpc('pm_payreq_state', { p_project: code });
    if (!st.can_new) return msg(out, 'warn', t('pq.why.' + (st.why || 'none')));
    const c = st.contract, used = new Set(st.used_terms || []);
    const terms = ((c && c.pay_terms) || []).map((x, i) => Object.assign({ i }, x)).filter(x => !used.has(x.i) && !x.paid);
    const base = n0(c ? c.value_pre_vat : st.po && st.po.total);
    const fKind = el('select');
    const kinds = st.next_seq === 1 ? ['first'] : ['interim'];
    if (st.final_ah) kinds.push('final');
    selFill(fKind, kinds.map(k => [k, t('pq.kind.' + k)]));
    if (st.final_ah) fKind.value = 'final';
    const fTerm = el('select');
    selFill(fTerm, [['', t('pq.noTerm')], ...terms.map(x => [String(x.i), `${x.milestone || ''}${x.pct != null ? ' · ' + x.pct + '%' : ''}${x.condition ? ' · ' + x.condition : ''}`])]);
    const fMs = el('input'), fPct = el('input', { className: 'num', inputMode: 'decimal' }), fAmt = el('input', { className: 'num', inputMode: 'decimal' });
    const fVat = el('input', { className: 'num', inputMode: 'decimal', value: c && c.vat_pct != null ? c.vat_pct : 8 }), fInv = el('input'), fNote = el('textarea', { rows: 2 });
    // The amount of the contract's schedule line is the basis; Purchasing may change the amount asked —
    // then with the reason, and the vendor's own payment-request letter attached before sending.
    let amtContract = null;
    const fCt = el('span', { className: 'pqct' }), fAdj = el('input', { placeholder: t('pq.adjPh') }), adjBox = el('div', { className: 'fld grow', hidden: true }, [el('label', { textContent: t('pq.adjNote') }), fAdj]);
    const syncAdj = () => { const a = numIn(fAmt.value); const diff = amtContract != null && a != null && Math.abs(a - amtContract) >= 1;
      adjBox.hidden = !diff; fCt.textContent = amtContract != null ? t('pq.ctAmt', { a: fmtMoney(amtContract) }) + (diff ? ' · ' + t('pq.adjBy', { d: fmtMoney(a - amtContract) }) : '') : ''; };
    const fill = () => { const x = terms.find(y => String(y.i) === fTerm.value); if (!x) { amtContract = null; return syncAdj(); }
      amtContract = x.amount != null ? Number(x.amount) : Math.round(base * n0(x.pct) / 100);
      fMs.value = x.milestone || ''; fPct.value = x.pct ?? ''; fAmt.value = fmtNum(amtContract); syncAdj(); };
    fTerm.onchange = fill;
    fPct.onchange = () => { const v = numIn(fPct.value); if (v != null && base) fAmt.value = fmtNum(Math.round(base * v / 100)); syncAdj(); };
    fAmt.onchange = syncAdj;
    if (terms.length) { fTerm.value = String(fKind.value === 'final' ? terms[terms.length - 1].i : terms[0].i); fill(); }
    const f = (k, i, cls) => el('div', { className: 'fld' + (cls ? ' ' + cls : '') }, [el('label', { textContent: t(k) }), i]);
    body.append(el('dl', { className: 'aodl' }, [
      el('dt', { textContent: t('pq.contract') }), el('dd', { textContent: c ? `${c.no}${c.contract_no ? ' · ' + c.contract_no : ''} · ${c.supplier || ''} · ${fmtMoney(c.value_pre_vat)}` : t('pq.poOnly', { no: (st.po || {}).doc_no || '' }) }),
      el('dt', { textContent: t('pq.soFar') }), el('dd', { textContent: t('pq.soFarV', { r: fmtMoney(st.requested), p: fmtMoney(st.paid) }) })]),
      el('div', { className: 'row' }, [f('pq.c.kind', fKind), f('pq.term', fTerm, 'grow')]),
      el('div', { className: 'row' }, [f('pq.c.milestone', fMs, 'grow'), f('pq.pct', fPct), f('pq.c.amount', fAmt), f('pq.vat', fVat)]),
      el('div', { className: 'row', style: 'align-items:flex-end' }, [fCt, adjBox]),
      el('div', { className: 'row' }, [f('pq.invoice', fInv), f('pq.note', fNote, 'grow')]),
      el('div', { className: 'tdnote', textContent: t('pq.newHint') }),
      el('div', { className: 'row' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('pq.saveDraft'), onclick: async () => {
        try {
          if (!adjBox.hidden && !fAdj.value.trim()) return msg(out, 'err', t('pq.adjNeed'));
          const id = await SB.rpc('pm_payreq_save', { p: { project_code: code, kind: fKind.value, term_idx: fTerm.value === '' ? null : Number(fTerm.value), milestone: fMs.value,
            pct: numIn(fPct.value), amount: numIn(fAmt.value), amount_contract: amtContract, adjust_note: adjBox.hidden ? null : fAdj.value,
            vat_pct: numIn(fVat.value), invoice_no: fInv.value, note: fNote.value } });
          await pqReload(t('pq.created'), id);
        } catch (e) { msg(out, 'err', e.message); }
      } })]));
  } catch (e) { msg(out, 'err', pqMissing(e) ? t('pq.notInstalled') : e.message); }
}

async function pqView(id) {
  const r = PQ.rows.find(x => x.id === id);
  const dr = pqDrawerEl(), body = $('#pqDrBody');
  dr.hidden = false; body.innerHTML = ''; body.scrollTop = 0;
  PQ.cur = id;
  if (!r) { $('#pqDrTitle').textContent = '—'; return; }
  await pqRoute();
  const p = PQ.prj.get(r.project_code) || { code: r.project_code };
  $('#pqDrTitle').textContent = `${r.no} — ${p.name || ''}`;
  const out = el('div'); body.append(out);
  const mineStep = ['check', 'approve', 'process'].includes(r.status) && pqCan(r.status, p.dept_code) && (r.created_by !== (ME && ME.id) || PQ.selfOk);
  const prep = ['draft', 'returned'].includes(r.status) && (r.created_by === (ME && ME.id) || pqCan('prep', p.dept_code));
  // The amount as the contract has it, and as asked when Purchasing changed it (with the reason).
  const adj = r.amount_contract != null && r.amount != null && Math.abs(Number(r.amount) - Number(r.amount_contract)) >= 1;
  const letter = (r.files || []).find(f => f.kind === 'vendor_letter');
  body.append(el('div', { className: 'row', style: 'align-items:center;gap:8px;flex-wrap:wrap' }, [pqChip(r.status), el('b', { textContent: t('pq.kind.' + r.kind) }),
    el('span', { className: 'dim', textContent: r.milestone || '' }), el('span', { style: 'flex:1' }),
    el('button', { className: 'btn tiny', type: 'button', textContent: '🖨 ' + t('pq.print'), onclick: e => pqPrint(r, p, e.target) })]),
    r.approved_at ? el('div', { className: 'pqmark' }, [el('b', { textContent: '✔ ' + t('pq.approvedBy', { n: r.approved_name || '', d: fmtDateTime(r.approved_at) }) }),
      r.approved_sig && r.approved_sig.png ? el('img', { src: r.approved_sig.png, alt: '' }) : '']) : '',
    el('dl', { className: 'aodl' }, [
      // The project's signed forms and the contract, viewed here without leaving the request (user 29/09/2026).
      el('dt', { textContent: t('pm.col.code') }), el('dd', {}, [el('a', { href: '#', className: 'aolink', textContent: `${r.project_code} — ${p.name || ''}`, onclick: e => { e.preventDefault(); pqDrawerClose(); PM.prj.open = r.project_code; showView('projects'); } }), ' ',
        el('button', { className: 'btn tiny', type: 'button', textContent: '📄 ' + t('pq.dv.forms'), title: t('pq.dv.formsT'), onclick: () => pqViewForms(r, p) })]),
      ...(r.amount_contract != null || r.contract_id ? [el('dt', { textContent: t('pq.amtCt') }), el('dd', {}, [r.amount_contract != null ? fmtMoney(r.amount_contract) : '—', ' ',
        el('button', { className: 'btn tiny', type: 'button', textContent: '📄 ' + t('pq.dv.contract'), onclick: () => pqViewContract(r) })])] : []),
      el('dt', { textContent: adj ? t('pq.amtAdj') : t('pq.c.amount') }), el('dd', { className: adj ? 'pqadj' : '', textContent: `${fmtMoney(r.amount)}${r.pct != null ? ' (' + Number(r.pct) + '%)' : ''}`
        + (adj ? ` · ${t('pq.adjBy', { d: fmtMoney(Number(r.amount) - Number(r.amount_contract)) })}` : '') }),
      ...(adj ? [el('dt', { textContent: t('pq.adjNote') }), el('dd', { textContent: r.adjust_note || '—' })] : []),
      // The vendor's payment-request letter (a stamped scan) goes with every request (user 29/09/2026).
      el('dt', { textContent: t('pq.f.vendor_letter') }), el('dd', {}, letter
        ? el('a', { href: '#', className: 'aolink', textContent: '📎 ' + (letter.name || t('pq.f.vendor_letter')), onclick: e => { e.preventDefault(); tdFile(letter, 'pm-payreq'); } })
        : el('span', { className: 'tglate', textContent: t('pq.noLetter') })),
      el('dt', { textContent: t('pq.c.total') }), el('dd', { textContent: `${fmtMoney(r.amount_total)}${r.vat_pct != null ? ' · VAT ' + Number(r.vat_pct) + '%' : ''}` }),
      ...(r.invoice_no ? [el('dt', { textContent: t('pq.invoice') }), el('dd', { textContent: r.invoice_no })] : []),
      ...(r.note ? [el('dt', { textContent: t('pq.note') }), el('dd', { className: 'mttext', textContent: r.note })] : []),
      ...(r.status === 'paid' ? [el('dt', { textContent: t('pq.c.paid') }), el('dd', { textContent: `${fmtDate(r.paid_at)} · ${fmtMoney(r.paid_amount)}${r.voucher_no ? ' · ' + r.voucher_no : ''}` })] : [])]));
  body.append(pqSteps(r));
  // Actions of the person whose turn it is.
  if (mineStep) body.append(pqActBox(r, out));
  if (prep) {
    body.append(el('div', { className: 'row', style: 'gap:8px;margin:10px 0' }, [
      el('button', { className: 'btn pri', type: 'button', textContent: '📨 ' + t('pq.submit'), onclick: async () => {
        if (!letter) return msg(out, 'err', t('pq.letterNeed'));
        if (!confirm(t('pq.submitQ', { no: r.no }))) return;
        try { await SB.rpc('pm_payreq_submit', { p_id: r.id }); await pqReload(t('pq.submitted'), r.id); } catch (e) { msg(out, 'err', e.message); } } }),
      el('button', { className: 'btn danger tiny', type: 'button', textContent: t('pq.cancel'), onclick: async () => {
        const why = prompt(t('pq.cancelQ')); if (why === null) return;
        try { await SB.rpc('pm_payreq_cancel', { p_id: r.id, p_comment: why }); await pqReload(t('pq.cancelled')); pqDrawerClose(); } catch (e) { msg(out, 'err', e.message); } } })]));
  }
  body.append(pqFiles(r, out, prep || mineStep));
  // Everything the accountant checks, on one page.
  body.append(el('h2', { style: 'margin-top:16px', textContent: t('pq.dossier') }));
  const dos = el('div', { textContent: t('table.loading') });
  body.append(dos);
  pqDossier(r, p, dos).catch(e => { dos.textContent = e.message; });
}

function pqSteps(r) {
  const names = { prep: t('pq.s.prep'), check: t('pq.s.check'), approve: t('pq.s.approve'), process: t('pq.s.process') };
  // No checking step in the route (user 29/09/2026): Purchasing → Chief Accountant → Accountant.
  const steps = PQ_STEPS.filter(k => k !== 'check' || pqHasCheck() || (r.route || []).some(x => x.step === 'check'));
  const at = steps.indexOf(r.status === 'returned' || r.status === 'draft' ? 'prep' : r.status);
  const last = k => [...(r.route || [])].reverse().find(x => x.step === k);
  return el('div', { className: 'aochain' }, steps.map((k, i) => {
    const l = last(k), done = r.status === 'paid' || (i < at && l), now = i === at && !['paid', 'rejected', 'cancelled'].includes(r.status);
    const roles = (PQ.route[k] || []).map(wfRoleName).join(' / ');
    return el('div', { className: 'aostep' + (done ? ' ok' : ['return', 'reject'].includes(l && l.action) && i >= at ? ' bad' : now ? ' now' : '') }, [
      el('b', { textContent: names[k] }), el('small', { textContent: roles }),
      l ? el('div', { textContent: `${l.action === 'return' ? '↩' : l.action === 'reject' ? '✗' : '✓'} ${l.name || ''} · ${fmtDateTime(l.at)}` }) : '',
      l && l.comment ? el('i', { textContent: '“' + l.comment + '”' }) : '']);
  }));
}

function pqActBox(r, out) {
  const note = el('input', { placeholder: t('ct.commentPh') });
  const box = el('div', { className: 'ctact' }, [el('b', { textContent: t('pq.yourTurn.' + r.status) }), el('div', { className: 'tdnote', textContent: t('pq.turnHint.' + r.status) })]);
  const go = async (a, extra) => {
    if (['return', 'reject'].includes(a) && !note.value.trim()) return msg(out, 'err', t('ct.needReason'));
    try { const s = await SB.rpc('pm_payreq_act', { p_id: r.id, p_action: a, p_comment: note.value.trim() || null, p: extra || {} }); await pqReload(t('pq.acted.' + s), r.id); }
    catch (e) { msg(out, 'err', e.message); }
  };
  const btns = [];
  if (r.status === 'process') {
    const fAt = el('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }), fAmt = el('input', { className: 'num', inputMode: 'decimal', value: fmtNum(pqAmt(r)) });
    const fV = el('input', { placeholder: t('pq.voucherPh') });
    box.append(el('div', { className: 'row' }, [el('div', { className: 'fld' }, [el('label', { textContent: t('pq.paidAt') }), fAt]),
      el('div', { className: 'fld' }, [el('label', { textContent: t('pq.paidAmt') }), fAmt]), el('div', { className: 'fld grow' }, [el('label', { textContent: t('pq.voucher') }), fV])]));
    btns.push(el('button', { className: 'btn pri', type: 'button', textContent: '✔ ' + t('pq.markPaid'), onclick: () => go('paid', { paid_at: fAt.value, paid_amount: numIn(fAmt.value), voucher_no: fV.value }) }));
  } else btns.push(el('button', { className: 'btn pri', type: 'button', textContent: '✔ ' + t('pq.ok.' + r.status), onclick: async () => {
    // The Chief Accountant signs the approval: the signature goes on the "Approved by CA" mark of the printed dossier.
    if (r.status === 'approve') { const png = await sigAsk(t('pq.sigTitle', { no: r.no })); if (png === null) return; return go('approve', png ? { sig: { png } } : {}); }
    go('approve'); } }));
  btns.push(el('button', { className: 'btn', type: 'button', textContent: t('ao.tf.return'), onclick: () => go('return') }));
  if (r.status === 'approve') btns.push(el('button', { className: 'btn danger', type: 'button', textContent: t('ao.tf.reject'), onclick: () => go('reject') }));
  box.append(el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, note), ...btns]));
  return box;
}

async function pqPut(path, file) {
  const tok = await authToken();
  const res = await fetch(`${CFG.url}/storage/v1/object/pm-payreq/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST',
    headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok, 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, body: file });
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).message || m; } catch {} throw new Error(m); }
}
function pqFiles(r, out, canAdd) {
  const wrap = el('div');
  // "View full document": the payment documents, the contract and the signed forms in one window.
  wrap.append(el('div', { className: 'row', style: 'align-items:center;gap:8px;margin-top:14px' }, [
    el('h3', { style: 'margin:0', textContent: t('pq.files', { n: (r.files || []).length + (r.links || []).length }) }),
    el('button', { className: 'btn tiny pri', type: 'button', textContent: '👁 ' + t('pq.dv.all'), title: t('pq.dv.allT'), onclick: () => pqViewAll(r) })]));
  const ul = el('ul', { className: 'tgfiles' });
  for (const f of r.files || []) ul.append(el('li', {}, [el('span', { className: 'tdchip' + (f.kind === 'vendor_letter' ? ' ok' : ''), textContent: t('pq.f.' + (f.kind || 'other')) }), ' ',
    el('a', { href: '#', textContent: '📎 ' + (f.name || 'file'), onclick: e => { e.preventDefault(); tdFile(f, 'pm-payreq'); } }),
    el('small', { className: 'dim', textContent: ` ${Math.max(1, Math.round((f.size || 0) / 1024))} KB · ${f.by || ''} · ${fmtDate(String(f.at || '').slice(0, 10))}` }),
    ['draft', 'returned'].includes(r.status) && canAdd ? el('button', { className: 'xbtn', type: 'button', textContent: '✕', onclick: async () => {
      try { await SB.rpc('pm_payreq_file_del', { p_id: r.id, p_path: f.path }); await pqReload('', r.id); } catch (e) { msg(out, 'err', e.message); } } }) : '']));
  for (const l of r.links || []) ul.append(el('li', {}, el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', textContent: '🔗 ' + (l.label || l.url) })));
  if (!(r.files || []).length && !(r.links || []).length) ul.append(el('li', { className: 'dim', textContent: t('pq.noFiles') }));
  wrap.append(ul);
  if (canAdd && !['paid', 'cancelled', 'rejected'].includes(r.status)) {
    const inp = el('input', { type: 'file', multiple: true, hidden: true, accept: '.pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx,.doc,.zip,.xml' });
    // What the file is: the vendor's payment-request letter (required: the stamped scan, PDF or image), the invoice, other.
    const fKind = el('select', { style: 'width:auto' });
    selFill(fKind, ['vendor_letter', 'invoice', 'other'].map(k => [k, t('pq.f.' + k)]));
    if ((r.files || []).some(f => f.kind === 'vendor_letter')) fKind.value = 'invoice';
    const ACC = '.pdf,.png,.jpg,.jpeg,.xlsx,.xls,.docx,.doc,.zip,.xml';
    const setAcc = () => { inp.accept = fKind.value === 'vendor_letter' ? '.pdf,.png,.jpg,.jpeg' : ACC; };
    fKind.onchange = setAcc; setAcc();
    inp.onchange = async () => {
      const files = [...inp.files]; inp.value = '';
      if (!files.length) return;
      msg(out, 'info', t('ph.uploading'));
      try {
        for (const f of files) {
          if (f.size > 25 * 1024 * 1024) throw new Error(t('tg.tooBig', { n: f.name }));
          if (fKind.value === 'vendor_letter' && !/\.(pdf|png|jpe?g)$/i.test(f.name)) throw new Error(t('pq.letterType'));
          const path = `${r.id}/${Date.now()}-${tdSafe(f.name)}`;
          await pqPut(path, f);
          await SB.rpc('pm_payreq_file_add', { p_id: r.id, p_path: path, p_name: f.name, p_size: f.size, p_kind: fKind.value });
        }
        await pqReload(t('tg.docsAdded', { n: files.length }), r.id);
      } catch (e) { msg(out, 'err', e.message); }
    };
    const addLink = async () => {
      const url = prompt(t('pq.linkQ')); if (!url) return;
      if (!/^https:\/\//i.test(url)) return msg(out, 'err', t('ph.badLink'));
      try { await SB.rpc('pm_payreq_save', { p: { id: r.id, links: [...(r.links || []), { url: url.trim(), label: url.trim().split('/').pop() }], kind: r.kind, term_idx: r.term_idx,
        milestone: r.milestone, pct: r.pct, amount: r.amount, vat_pct: r.vat_pct, invoice_no: r.invoice_no, note: r.note } }); await pqReload('', r.id); }
      catch (e) { msg(out, 'err', e.message); }
    };
    wrap.append(inp, el('div', { className: 'row', style: 'gap:6px;align-items:center' }, [fKind, el('button', { className: 'btn tiny', type: 'button', textContent: '＋ ' + t('pq.addFile'), onclick: () => inp.click() }),
      ['draft', 'returned'].includes(r.status) ? el('button', { className: 'btn tiny', type: 'button', textContent: '🔗 ' + t('pq.addLink'), onclick: addLink }) : '',
      el('span', { className: 'tdnote', textContent: t('pq.filesHint') })]));
  }
  return wrap;
}

/* ------------------------------------------------------------ in-app viewer (docview.js)
   What the Chief Accountant checks, seen without downloading (user 29/09/2026): the payment
   documents (the vendor's letter first, then the invoice and the rest), the contract's files,
   the project's approved forms with their signatures (marked "Approved by CA" once approved). */
const PQ_FK = { vendor_letter: 0, invoice: 1, other: 2 };
function pqPayItems(r) {
  return [...(r.files || [])].sort((a, b) => (PQ_FK[a.kind] ?? 2) - (PQ_FK[b.kind] ?? 2))
    .map(f => ({ label: t('pq.f.' + (f.kind || 'other')), sub: f.name || '', name: f.name, get: () => dvStored('pm-payreq', f.path) }))
    .concat((r.links || []).map(l => ({ label: t('pq.dv.link'), sub: l.label || l.url, url: l.url })));
}
async function pqCtItems(r) {
  if (!can('contract', 'view')) return [];
  const [c] = r.contract_id ? await SB.select('pm_contract', `select=id,no,contract_no&id=eq.${r.contract_id}`).catch(() => [])
    : await SB.select('pm_contract', `select=id,no,contract_no&project_code=eq.${encodeURIComponent(r.project_code)}&status=not.in.(cancelled,rejected)&order=id.desc&limit=1`).catch(() => []);
  if (!c) return [];
  const fs = await SB.select('pm_contract_file', `select=id,kind,name,source,storage_path,url&contract_id=eq.${c.id}&order=id`).catch(() => []);
  fs.sort((a, b) => (a.kind === 'contract' ? 0 : 1) - (b.kind === 'contract' ? 0 : 1) || a.id - b.id);
  const lbl = `${t('pq.dv.contract')} ${c.contract_no || c.no}`;
  return fs.map(f => f.source === 'link' ? { label: lbl, sub: f.name || f.url, url: f.url }
    : { label: lbl, sub: [t('ct.fk.' + f.kind), f.name].filter(Boolean).join(' · '), name: f.name, get: () => dvStored('pm-contract', f.storage_path) });
}
const pqFormsItem = r => ({ label: t('pq.dv.forms'), sub: `${r.project_code} · ${t('pq.dv.formsSub')}`, name: `${r.project_code} - ${t('wf.cap.file')}.pdf`,
  get: () => wfCaptureForms(r.project_code, 'blob', null, null, { approved: true }) });
const pqViewForms = (r, p) => dvOpen(`${r.project_code} — ${p.name || ''} · ${t('pq.dv.forms')}`, [pqFormsItem(r)]);
async function pqViewContract(r) {
  const items = await pqCtItems(r);
  if (!items.length) return msg('#pqMsg', 'warn', t('pq.dv.noCt'));
  dvOpen(`${r.no} · ${t('pq.dv.contract')}`, items);
}
async function pqViewAll(r) {
  dvOpen(`${r.no} — ${t('pq.dv.allH')}`, [...pqPayItems(r), ...await pqCtItems(r), pqFormsItem(r)]);
}

/* The project's whole file for the accountant: every approved form (open one, or all
   of them as one PDF), the contract and its schedule, the handovers, earlier requests,
   and what accounting has recorded as paid. */
async function pqDossier(r, p, box) {
  const [docs, ctr, others, money] = await Promise.all([
    SB.select('pm_doc', `select=id,doc_type,doc_no,status,decided_at,total_value,final:data->final&project_code=eq.${encodeURIComponent(r.project_code)}&status=eq.approved&order=id`),
    can('contract', 'view') ? SB.select('pm_contract', `select=*&project_code=eq.${encodeURIComponent(r.project_code)}&status=not.in.(cancelled,rejected)&order=id.desc`).catch(() => []) : [],
    Promise.resolve(PQ.rows.filter(x => x.project_code === r.project_code && x.id !== r.id)),
    SB.select('pm_project_money', `select=invoiced_gross,paid_gross,last_paid&project_code=eq.${encodeURIComponent(r.project_code)}`).catch(() => [])]);
  box.innerHTML = '';
  const capOut = el('div');
  box.append(el('div', { className: 'row', style: 'gap:6px;align-items:center' }, [el('span', { className: 'tdnote', textContent: t('pq.allForms') }), ...wfCapButtons(r.project_code, capOut)]), capOut);
  const tb = el('table', { className: 'tdtbl' });
  tb.append(el('tr', {}, [t('wf.i.doc'), t('wf.i.type'), t('pq.c.value'), t('pq.c.approvedAt')].map(h => el('th', { textContent: h }))));
  for (const d of docs.sort((a, b) => wfSeq(a.doc_type) - wfSeq(b.doc_type) || a.id - b.id))
    // 👁: the signed form in the viewer, the request staying open; the number opens the form's screen.
    tb.append(el('tr', {}, [el('td', {}, [el('a', { href: '#', className: 'aolink', textContent: d.doc_no, onclick: e => { e.preventDefault(); pqDrawerClose(); wfOpen(d.id); } }), ' ',
      el('button', { className: 'btn tiny', type: 'button', textContent: '👁', title: t('dv.view'),
        onclick: () => dvOpen(d.doc_no, [{ label: d.doc_no, sub: wfTypeName(d.doc_type), name: d.doc_no + '.pdf', get: () => wfCaptureForms(r.project_code, 'blob', null, d.id) }]) })]),
      el('td', { textContent: wfTypeName(d.doc_type) + (d.doc_type === 'AH' && (d.final === true || d.final === 'true') ? ' · ' + t('pq.finalAh') : '') }),
      el('td', { className: 'n', textContent: d.total_value != null ? fmtMoney(d.total_value) : '' }), el('td', { textContent: fmtDate(String(d.decided_at || '').slice(0, 10)) })]));
  box.append(el('div', { className: 'wrap' }, tb));
  const c = ctr[0];
  if (c) {
    box.append(el('h3', { textContent: t('pq.contract') }), el('div', { className: 'ctpanelrow' }, [el('a', { href: '#', className: 'aolink', textContent: `${c.no}${c.contract_no ? ' · ' + c.contract_no : ''}`,
      onclick: e => { e.preventDefault(); pqDrawerClose(); ctOpen(c.id); } }), document.createTextNode(` · ${c.supplier || ''} · ${fmtMoney(c.value_pre_vat)} `), ctChip(c.status),
      ' ', el('button', { className: 'btn tiny', type: 'button', textContent: '👁', title: t('dv.view'), onclick: () => pqViewContract(Object.assign({}, r, { contract_id: c.id })) })]));
    if ((c.pay_terms || []).length && window.ctPayTable) {
      const tbl = ctPayTable(c, c.pay_terms);
      (c.pay_terms || []).forEach((x, i) => { if (x.paid && tbl.rows[i + 1]) tbl.rows[i + 1].classList.add('pqpaid'); });
      box.append(tbl);
    }
  }
  if (others.length) box.append(el('h3', { textContent: t('pq.others') }), ...others.map(o => el('div', { className: 'ctpanelrow' }, [
    el('a', { href: '#', className: 'aolink', textContent: o.no, onclick: e => { e.preventDefault(); pqView(o.id); } }),
    document.createTextNode(` · ${t('pq.kind.' + o.kind)} · ${fmtMoney(pqAmt(o))} `), pqChip(o.status)])));
  const m = money[0];
  if (m) box.append(el('div', { className: 'tdnote', textContent: t('pq.acc', { inv: fmtMoney(m.invoiced_gross || 0), paid: fmtMoney(m.paid_gross || 0), d: fmtDate(String(m.last_paid || '').slice(0, 10)) }) }));
}

/* ------------------------------------------------------------ project drawer, To-do, bell */
async function pqProjectPanel(p, card) {
  let rows, st = null;
  try { rows = await SB.select('pm_payreq', `select=*&project_code=eq.${encodeURIComponent(p.code)}&status=neq.cancelled&order=id`); } catch { return; }
  try { st = await SB.rpc('pm_payreq_state', { p_project: p.code }); } catch {}
  if (!rows.length && !(st && st.can_new)) return;
  card.append(el('h2', { style: 'margin-top:14px', textContent: t('pq.panelH') }), ...rows.map(r => el('div', { className: 'ctpanelrow' }, [
    el('a', { href: '#', className: 'aolink', textContent: r.no, onclick: e => { e.preventDefault(); ppDrawerClose(); PQ.open = r.id; showView('payreq'); } }),
    document.createTextNode(` · ${t('pq.kind.' + r.kind)} · ${fmtMoney(pqAmt(r))} `), pqChip(r.status)])));
  if (st && st.can_new) card.append(el('button', { className: 'btn tiny pri', type: 'button', style: 'margin-top:6px', textContent: '💳 ' + t('pq.newBtn'),
    onclick: () => { ppDrawerClose(); PQ.newFor = p.code; showView('payreq'); } }));
}
async function pqTodos() {
  if (!ME) return [];
  let rows;
  try { rows = await SB.rpc('pm_todo_pay'); } catch { return []; }
  return rows.map(r => ({ kind: 'x:' + r.kind, x: true, what: t('pq.i.' + r.kind), band: r.kind === 'pay_returned' ? 'bad' : r.kind === 'pay_approve' ? 'jvc' : 'op',
    docLabel: r.ref_no || '', typeLabel: t('pq.it'), doc_no: '', project_code: r.project_code, project_name: r.project_name, dept_code: r.dept_code,
    submitted_at: r.at, total_value: r.amount != null ? Number(r.amount) : null,
    open: () => { if (['pay_first', 'pay_final'].includes(r.kind)) PQ.newFor = r.project_code; else PQ.open = r.ref_id; showView('payreq'); } }));
}
// Bell: payment request notices (doc_type TT, comment = the new status or "returned: why").
function pqNotice(r) {
  const c = String(r.comment || ''), m = /^(returned|rejected): ?(.*)$/.exec(c);
  const st = m ? m[1] : c;
  const key = r.kind === 'info' ? (st === 'submitted' ? 'pq.nt.submitted' : 'pq.nt.info')
    : 'pq.nt.' + (['check', 'approve', 'process', 'returned', 'rejected', 'paid'].includes(st) ? st : 'other');
  return { text: t(key, { no: r.doc_no || '', s: t('pq.st.' + st) }), comment: m ? m[2] : null, open: () => { PQ.open = r.ref_id; showView('payreq'); } };
}

/* The payment request printed: its own page (amounts as the contract has them and as asked, the
   reason, attachments, who sent / approved / paid, the CA's signature) followed by every approved
   form of the project — all pages marked "Approved by CA" once the Chief Accountant approved. */
async function pqPrint(r, p, btn) {
  const esc = s => String(s ?? '');
  const row = (a, b) => el('tr', {}, [el('th', { textContent: a }), el('td', { textContent: esc(b) })]);
  const adj = r.amount_contract != null && Math.abs(Number(r.amount) - Number(r.amount_contract)) >= 1;
  const last = k => [...(r.route || [])].reverse().find(x => x.step === k && ['submit', 'resubmit', 'approve', 'paid'].includes(x.action));
  const sub = last('prep'), paid = last('process');
  const cover = el('div', { className: 'pqcover' }, [
    el('div', { className: 'pqch' }, [el('div', {}, [el('b', { textContent: FS_CO[0] }), el('div', { textContent: FS_CO[1] }), el('small', { textContent: FS_CO[2] })]),
      el('div', { className: 'r' }, [el('b', { textContent: r.no }), el('div', { textContent: fmtDate(String(r.submitted_at || r.created_at || '').slice(0, 10)) })])]),
    el('h1', { textContent: 'ĐỀ NGHỊ THANH TOÁN / PAYMENT REQUEST' }),
    el('table', {}, [row('Dự án / Project', `${r.project_code} — ${p.name || ''}`), row('Đợt / Instalment', `${t('pq.kind.' + r.kind)}${r.milestone ? ' · ' + r.milestone : ''}${r.pct != null ? ' · ' + Number(r.pct) + '%' : ''}`),
      ...(r.amount_contract != null ? [row('Theo hợp đồng / As per contract', fmtMoney(r.amount_contract))] : []),
      row(adj ? 'Số đề nghị (điều chỉnh) / Amount requested (adjusted)' : 'Số tiền đề nghị (trước VAT) / Amount (pre-VAT)', fmtMoney(r.amount)),
      ...(adj ? [row('Lý do điều chỉnh / Reason', r.adjust_note || '')] : []),
      row('VAT', r.vat_pct != null ? Number(r.vat_pct) + '%' : ''), row('Tổng thanh toán / Total incl. VAT', fmtMoney(r.amount_total)),
      ...(r.invoice_no ? [row('Hoá đơn / Invoice', r.invoice_no)] : []), ...(r.note ? [row('Ghi chú / Note', r.note)] : []),
      row('Hồ sơ kèm theo / Attachments', [...(r.files || []).map(f => `${t('pq.f.' + (f.kind || 'other'))}: ${f.name}`), ...(r.links || []).map(l => l.label || l.url)].join('\n') || '—')]),
    el('div', { className: 'pqsign' }, [
      el('div', {}, [el('b', { textContent: 'Người đề nghị / Requested by' }), el('small', { textContent: 'Thu mua / Purchasing' }), el('div', { className: 'nm', textContent: (sub && sub.name) || r.created_name || '' }),
        el('small', { textContent: sub ? fmtDateTime(sub.at) : '' })]),
      el('div', {}, [el('b', { textContent: 'Duyệt / Approved by' }), el('small', { textContent: 'Kế toán trưởng / Chief Accountant' }),
        r.approved_sig && r.approved_sig.png ? el('img', { src: r.approved_sig.png, alt: '' }) : el('div', { className: 'gap' }),
        el('div', { className: 'nm', textContent: r.approved_name || '' }), el('small', { textContent: r.approved_at ? fmtDateTime(r.approved_at) : '' })]),
      el('div', {}, [el('b', { textContent: 'Đã chi / Paid' }), el('small', { textContent: 'Kế toán / Accountant' }), el('div', { className: 'nm', textContent: (paid && paid.name) || '' }),
        el('small', { textContent: r.paid_at ? `${fmtDate(r.paid_at)}${r.voucher_no ? ' · ' + r.voucher_no : ''}` : '' })])])]);
  const stamp = r.approved_at ? { no: r.no, name: r.approved_name, at: r.approved_at, png: r.approved_sig && r.approved_sig.png } : null;
  if (btn) btn.disabled = true;
  try { await wfCaptureForms(r.project_code, 'preview', '#pqMsg', null, { cover, coverLabel: r.no, stamp, base: `${r.no.replace(/\//g, '-')} - ${t('pq.dossier')}` }); }
  finally { if (btn) btn.disabled = false; }
}
