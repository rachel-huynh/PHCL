/* =====================================================================
   Liquidation — the new flow of a batch (user 29/09/2026, sql/43_liquidation_flow.sql).
   The Hotel Asset Manager draws up the list from the approved department requests and
   maps the asset codes (a construction-package asset by a % share); DOF and Hotel GM
   sign; the AM team checks (and may change the codes — the booked value and the
   depreciation follow); every member of the Liquidation Committee signs the minutes
   (02) and the chairman the decision (03); then, side by side, the physical check (04,
   with the signed site-check minutes uploaded) → revaluation (05), and the call for
   quotations; the committee approves the winning prices; the Hotel AM uploads each
   buyer's signed handover minutes and gate pass, the Accountant records the invoice;
   the AM team, the Accountant and the Chief Accountant approve → the register and the
   accounting reconciliation are updated.
   The batch screen itself stays in app.js (lqBatchDetail); these are its parts.
   ===================================================================== */

const lqHas = codes => !!(ME && ME.roles.some(r => codes.includes(r.role)));
const lqIsAm = () => !!LQ.isAm;
const LQ_SIGN_STAGES = ['hotel', 'amcheck', 'committee', 'awarding', 'settling'];

/* ------------------------------------------------------------ signatures of the step */
function lqbSignCard(panel, b) {
  if (![...LQ_SIGN_STAGES, 'closed'].includes(b.status)) return;
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('lqf.signH') }), el('div', { className: 'dim', textContent: t('table.loading') })]);
  panel.append(card);
  (async () => {
    let st;
    try { st = await SB.rpc('pm_lq_sign_state', { p_batch: b.id }); } catch (e) { card.lastChild.textContent = e.message; return; }
    card.innerHTML = '';
    card.append(el('h2', { textContent: t('lqf.signH') }));
    const out = el('div');
    const slotName = s => s.member_id ? `${s.label} — ${t(s.stage === 'decision' ? 'lqf.chair' : 'lqf.member')}` : s.roles && s.roles.length > 1 ? t('lqf.amTeam') : wfRoleName(s.label);
    if (LQ_SIGN_STAGES.includes(b.status)) {
      card.append(el('div', { className: 'tdnote', textContent: t('lqf.hint.' + b.status) }));
      if (b.status === 'settling' && st.missing) card.append(el('div', { className: 'msg warn', textContent: t('lqf.missing', { l: st.missing }) }));
      const grid = el('div', { className: 'lqsigngrid' });
      for (const s of st.slots) {
        const sg = s.signed;
        grid.append(el('div', { className: 'lqslot' + (sg ? ' done' : s.mine ? ' mine' : '') }, [
          el('small', { textContent: t('lqf.stage.' + s.stage) }), el('b', { textContent: slotName(s) }),
          sg && sg.sig && sg.sig.png ? el('img', { src: sg.sig.png, alt: '' }) : el('div', { className: 'gap' }),
          el('div', { className: 'dim', textContent: sg ? `✓ ${sg.name || ''} · ${fmtDateTime(sg.at)}` : s.mine ? t('lqf.yourTurn') : t('lqf.waiting') })]));
      }
      card.append(grid);
      if (st.slots.some(s => s.mine)) {
        const note = el('input', { placeholder: t('lqf.notePh') });
        // The final approval waits for every buyer's papers (the database checks it too).
        const sign = el('button', { className: 'btn pri', type: 'button', textContent: '✍ ' + t('lqf.sign.' + b.status), disabled: b.status === 'settling' && !!st.missing });
        sign.onclick = async () => {
          const png = await sigAsk(t('lqf.sigTitle', { c: b.code, s: t('lqb.st.' + b.status) })); if (png === null) return;
          sign.disabled = true;
          try { const to = await SB.rpc('pm_lq_act', { p_batch: b.id, p_action: 'approve', p_comment: note.value.trim() || null, p_sig: png ? { png } : null });
                LQ.flash = t('lqf.signed', { c: b.code, s: t('lqb.st.' + to) }); await lqLoad(); }
          catch (e) { sign.disabled = false; msg(out, 'err', e.message); }
        };
        const back = el('button', { className: 'btn', type: 'button', textContent: t('ao.tf.return') });
        back.onclick = async () => {
          if (!note.value.trim()) return msg(out, 'err', t('ct.needReason'));
          try { await SB.rpc('pm_lq_act', { p_batch: b.id, p_action: 'return', p_comment: note.value.trim(), p_sig: null }); LQ.flash = t('lqf.returned', { c: b.code }); await lqLoad(); }
          catch (e) { msg(out, 'err', e.message); }
        };
        card.append(el('div', { className: 'row', style: 'gap:8px;align-items:center;margin-top:8px' }, [el('div', { className: 'fld grow' }, note), sign, back]));
      }
    }
    // Who signed what, round by round (a return starts a new round).
    if (st.history.length) card.append(el('details', { className: 'lqlog' }, [el('summary', { textContent: t('lqf.history', { n: st.history.length }) }),
      el('ul', {}, st.history.map(h => el('li', { className: h.action === 'return' ? 'bad' : '', textContent:
        `${fmtDateTime(h.at)} · ${t('lqf.stage.' + h.stage)} · ${h.name || ''} · ${t(h.action === 'return' ? 'lqf.act.return' : 'lqf.act.approve')}${h.comment ? ' — ' + h.comment : ''}` })))]));
    card.append(out);
  })();
}

/* ------------------------------------------------------------ code mapping of a line
   Hotel AM while drawing up the list, the AM team while checking: the asset from the
   register (code or barcode), and for an asset of a package (the original construction,
   no breakdown) the % of it that goes. The booked value and depreciation come back from
   the database: accounting's book when booked, else unit price × qty. */
function lqbMapCell(i, b, out) {
  const canMap = (b.status === 'open' && lqIsAm()) || (b.status === 'amcheck' && (lqHas(['AM_COORD', 'AM_EXEC', 'SYS_ADMIN']) || can('liquidation', 'admin')));
  const src = i.val_source ? el('small', { className: 'dim', textContent: ' · ' + t('lqf.src.' + i.val_source) }) : '';
  if (!canMap) return [el('code', { textContent: i.asset_code || 'N/A' }), i.share_pct != null ? el('small', { className: 'lqshare', textContent: ` ${fmtNum(i.share_pct)}%` }) : '', src];
  const code = el('input', { value: i.asset_code || '', placeholder: t('lqf.codePh'), spellcheck: false, className: 'lqcode' });
  code.setAttribute('list', 'wfAssetList');
  let tmr = null;
  code.oninput = () => { clearTimeout(tmr); const q = code.value.trim(); if (q.length >= 3) tmr = setTimeout(() => wfAssetSearch(q).catch(() => {}), 250); };
  const share = el('input', { value: i.share_pct != null ? fmtNum(i.share_pct) : '', placeholder: '%', inputMode: 'decimal', className: 'lqsharein', title: t('lqf.shareHint') });
  const apply = async () => {
    const c = code.value.trim().toUpperCase();
    try {
      let id = null;
      if (c) {
        // By its code, else by its barcode.
        const [a] = (await SB.select('am_asset', `select=id&asset_code=eq.${encodeURIComponent(c)}&limit=1`)).concat(await SB.select('am_asset', `select=id&barcode=eq.${encodeURIComponent(c)}&limit=1`));
        if (!a) return msg(out, 'err', t('wf.assetNone', { code: c }));
        id = a.id;
      }
      const sh = share.value.trim() ? numIn(share.value) : null;
      const r = await SB.rpc('pm_lq_item_map', { p_item: i.id, p_asset: id, p_share: sh, p_values: null });
      Object.assign(i, { asset_id: id, asset_code: id ? c : i.asset_code, share_pct: id ? sh : null, original_value: r.original_value, depreciation: r.depreciation,
                         nbv: n0(r.original_value) - n0(r.depreciation), val_source: r.source });
      msg(out, 'ok', t('lqf.mapped', { n: i.name }));
      lqRender();
    } catch (e) { msg(out, 'err', e.message); }
  };
  code.onchange = apply; share.onchange = apply;
  return [el('div', { className: 'lqmap' }, [code, share]), src];
}
// Liquidation method (the committee's decision), while the list can change.
function lqbModeCell(i, b, out, locked) {
  if (!lqIsAm() || locked || !['open', 'amcheck', 'committee'].includes(b.status)) return document.createTextNode(lqBi(LQ_MODE, i.mode));
  const s = el('select');
  for (const [v] of LQ_MODE) s.append(el('option', { value: v, textContent: lqBi(LQ_MODE, v) }));
  s.value = i.mode || 'Sale';
  s.onchange = async () => { try { await SB.rpc('pm_lq_item_set', { p_item: i.id, p_patch: { mode: s.value } }); i.mode = s.value; } catch (e) { msg(out, 'err', e.message); s.value = i.mode; } };
  return s;
}

/* ------------------------------------------------------------ physical check (04) and revaluation (05) */
function lqbMilestones(panel, b) {
  if (!['decided', 'bidding'].includes(b.status)) return;
  const out = el('div'), am = lqIsAm();
  const its = lqBatchItems(b).filter(i => i.status === 'batched');
  const counted = its.filter(i => i.count_found != null).length, valued = its.filter(i => i.count_found === false || i.reval_value != null).length;
  const scan = (b.files || []).filter(f => f.kind === 'sitecheck');
  const ms = async (what, done) => { try { await SB.rpc('pm_lq_milestone', { p_batch: b.id, p_what: what, p_done: done }); LQ.flash = t('lqf.ms.' + what + (done ? 'Done' : 'Open')); await lqLoad(); } catch (e) { msg(out, 'err', e.message); } };
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('lqf.msH') }), el('div', { className: 'tdnote', textContent: t('lqf.msHint') })]);
  const box = (title, state, kids) => el('div', { className: 'lqms' + (state ? ' done' : '') }, [el('b', { textContent: title }), ...kids]);
  card.append(el('div', { className: 'lqmsgrid' }, [
    box(t('lqf.count'), !!b.count_date, [
      el('div', { className: 'dim', textContent: b.count_date ? t('lqf.countDone', { d: lqD(b.count_date) }) : t('lqf.countProg', { n: counted, of: its.length }) }),
      el('div', { className: 'dim', textContent: scan.length ? t('lqf.scanOk', { n: scan.length }) : t('lqf.scanNone') }),
      el('div', { className: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
        el('button', { className: 'btn tiny', type: 'button', textContent: '🖨 ' + t('lqf.print04'), onclick: () => lqbCapture(b, ['04'], 'preview', out) }),
        ...(am && !b.count_date ? [el('button', { className: 'btn tiny', type: 'button', textContent: t('lqb.countOpen'), onclick: () => { LQ.countBatch = b.id; showView('lqcount'); } }),
          lqbUploadBtn(b, 'sitecheck', null, out),
          el('button', { className: 'btn tiny pri', type: 'button', textContent: t('lqf.countConfirm'), disabled: counted < its.length || !scan.length, onclick: () => ms('count', true) })] : []),
        ...(am && b.count_date && !b.valuation_date ? [el('button', { className: 'btn tiny', type: 'button', textContent: t('lqf.reopen'), onclick: () => ms('count', false) })] : [])])]),
    box(t('lqf.reval'), !!b.valuation_date, [
      el('div', { className: 'dim', textContent: b.valuation_date ? t('lqf.revalDone', { d: lqD(b.valuation_date) }) : b.count_date ? t('lqf.revalProg', { n: valued, of: its.length }) : t('lqf.revalWait') }),
      el('div', { className: 'row', style: 'gap:6px;flex-wrap:wrap' }, [
        ...(am && b.count_date && !b.valuation_date ? [el('button', { className: 'btn tiny pri', type: 'button', textContent: t('lqf.revalConfirm'), disabled: valued < its.length, onclick: () => ms('reval', true) })] : []),
        ...(am && b.valuation_date && b.status !== 'awarding' ? [el('button', { className: 'btn tiny', type: 'button', textContent: t('lqf.reopen'), onclick: () => ms('reval', false) })] : [])])]),
    box(t('lqf.tender'), !!b.opened_at, [el('div', { className: 'dim', textContent: b.opened_at ? t('lqf.tenderOpened', { d: fmtDateTime(b.opened_at) })
      : b.status === 'bidding' ? t('lqf.tenderCalling', { d: fmtDateTime(b.call_deadline) }) : t('lqf.tenderNot') })])]), out);
  panel.append(card);
}

/* ------------------------------------------------------------ signed papers of the batch */
const LQ_FILE_KINDS = ['minutes', 'decision', 'sitecheck', 'reval', 'award', 'gatepass', 'handover', 'invoice', 'other'];
async function lqbPut(path, file) {
  const tok = await authToken();
  const res = await fetch(`${CFG.url}/storage/v1/object/pm-lqdoc/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST',
    headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok, 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, body: file });
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).message || m; } catch {} throw new Error(m); }
}
function lqbUploadBtn(b, kind, quoteId, out, label) {
  const inp = el('input', { type: 'file', hidden: true, multiple: true, accept: '.pdf,.png,.jpg,.jpeg' });
  inp.onchange = async () => {
    const files = [...inp.files]; inp.value = '';
    if (!files.length) return;
    msg(out, 'info', t('ph.uploading'));
    try {
      for (const f of files) {
        if (f.size > 25 * 1024 * 1024) throw new Error(t('tg.tooBig', { n: f.name }));
        const path = `${b.id}/${Date.now()}-${tdSafe(f.name)}`;
        await lqbPut(path, f);
        await SB.rpc('pm_lq_file_add', { p_batch: b.id, p_kind: kind, p_path: path, p_name: f.name, p_size: f.size, p_quote: quoteId || null });
      }
      LQ.flash = t('lqf.uploaded', { n: files.length, k: t('lqf.fk.' + kind) });
      await lqLoad();
    } catch (e) { msg(out, 'err', e.message); }
  };
  const btn = el('button', { className: 'btn tiny', type: 'button', textContent: '⬆ ' + (label || t('lqf.fk.' + kind)), onclick: () => inp.click() });
  return el('span', {}, [inp, btn]);
}
function lqbFilesCard(panel, b, quotes) {
  const files = b.files || [];
  if (!files.length && !lqIsAm()) return;
  const out = el('div');
  const card = el('div', { className: 'card' }, [el('div', { className: 'chead' }, [el('h2', { textContent: t('lqf.filesH', { n: files.length }) }),
    files.length ? el('button', { className: 'btn tiny', type: 'button', textContent: '👁 ' + t('lqf.viewAll'),
      onclick: () => dvOpen(`${b.code} — ${t('lqf.filesH', { n: files.length })}`, files.map(f => ({ label: t('lqf.fk.' + f.kind), sub: f.name, name: f.name, get: () => dvStored('pm-lqdoc', f.path) }))) }) : ''])]);
  const qName = id => { const q = (quotes || []).find(x => x.id === id); return q ? ((q.data && q.data.name) || (q.buyer && q.buyer.name) || '') : ''; };
  const ul = el('ul', { className: 'tgfiles' });
  for (const f of files) ul.append(el('li', {}, [el('span', { className: 'tdchip', textContent: t('lqf.fk.' + f.kind) }), ' ',
    el('a', { href: '#', textContent: '📎 ' + (f.name || 'file'), onclick: e => { e.preventDefault(); dvFile(f, 'pm-lqdoc'); } }),
    el('small', { className: 'dim', textContent: ` ${f.quote_id ? qName(f.quote_id) + ' · ' : ''}${f.by || ''} · ${fmtDate(String(f.at || '').slice(0, 10))}` }),
    lqIsAm() && !['closed', 'cancelled'].includes(b.status) ? el('button', { className: 'xbtn', type: 'button', textContent: '✕', onclick: async () => {
      if (!confirm(t('lqf.delQ', { n: f.name }))) return;
      try { await SB.rpc('pm_lq_file_del', { p_batch: b.id, p_path: f.path }); await lqLoad(); } catch (e) { msg(out, 'err', e.message); } } }) : '']));
  if (!files.length) ul.append(el('li', { className: 'dim', textContent: t('lqf.noFiles') }));
  card.append(ul);
  if (lqIsAm() && !['closed', 'cancelled'].includes(b.status)) {
    // The committee's signed papers (02, 03), the revaluation, the award, anything else.
    const kind = el('select', { style: 'width:auto' });
    selFill(kind, ['minutes', 'decision', 'reval', 'award', 'other'].map(k => [k, t('lqf.fk.' + k)]));
    const holder = el('span');
    const redraw = () => { holder.innerHTML = ''; holder.append(lqbUploadBtn(b, kind.value, null, out, t('lqf.upload'))); };
    kind.onchange = redraw; redraw();
    card.append(el('div', { className: 'row', style: 'gap:6px;align-items:center' }, [kind, holder, el('span', { className: 'tdnote', textContent: t('lqf.filesHint') })]));
  }
  card.append(out);
  panel.append(card);
}

/* ------------------------------------------------------------ To-do, bell */
async function lqFlowTodos() {
  if (!ME) return [];
  let rows;
  try { rows = await SB.rpc('pm_todo_lq'); } catch { return []; }
  const band = r => r.kind === 'lq_sign' ? ({ hotel: 'op', amcheck: 'am', committee: 'jvc', awarding: 'jvc', settling: 'am' }[r.detail] || 'am') : 'am';
  return rows.map(r => ({ kind: 'x:' + r.kind, x: true, band: band(r),
    what: r.kind === 'lq_sign' ? t('lqf.i.sign.' + r.detail)
      : t('lqf.i.' + r.kind, { d: r.kind === 'lq_work' ? String(r.detail || '').split(' · ').filter(Boolean).map(k => t('lqf.w.' + k)).join(', ') : (r.detail || '') }),
    docLabel: r.ref_no, typeLabel: t('lqf.it'), doc_no: '', project_code: '', project_name: t('lqf.it'), dept_code: '', submitted_at: r.at, total_value: null,
    open: () => { LQ.tab = 'batch'; LQ.batchOpen = r.ref_id; showView('liq'); } }));
}
function lqNotice(r) {
  const c = String(r.comment || '');
  const key = r.kind === 'returned' ? 'lqf.nt.returned' : r.kind === 'info' ? 'lqf.nt.' + (c === 'settling' ? 'settling' : 'decided') : 'lqf.nt.todo';
  return { text: t(key, { no: r.doc_no || '', s: t('lqb.st.' + c) }), comment: r.kind === 'returned' ? c : null,
           open: () => { LQ.tab = 'batch'; LQ.batchOpen = r.ref_id; showView('liq'); } };
}
