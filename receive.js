/* ============================================================ RECEIVING (tablet / phone)
   Project management → Delivery → Receive & photograph (41_tendering.sql, user 28/09/2026).
   The ALR is approved (AM Coordinator → AM Executive → Chief Accountant) and the
   labels reach the Hotel Asset Manager, who on a phone or tablet:
     - sticks each label, scans it (a scanner that types the code + Enter, or
       typed by hand), takes the two photos (label close-up + overall);
     - enters the QUANTITY ACTUALLY RECEIVED (a batch of low-value items may come
       in several deliveries; an asset with its own barcode is received or not);
     - chooses per asset: into THIS handover (AH batch 1, 2, 3 … for payment by
       instalment) or LATER (the next AH);
     - presses "Update the AH draft": the draft AH of the project is created or
       brought up to date with exactly those assets, to check on the website and
       send for approval.
   Loaded after app.js (uses phUpload / phLoad / phUrl / PH_KINDS / wfCreate…). */

const RV = window.RV = { als: [], al: null, prj: new Map(), assets: [], recv: [], photos: [], ahs: [], q: '', only: '', busy: false };
const rvMissing = e => /am_recv|PGRST20[25]|does not exist|404/.test(String(e && e.message));
const rvOut = () => $('#rvMsg');

async function rvLoad() {
  msg(rvOut(), 'info', t('table.loading'));
  try {
    await pmLookups(); await wfLookups();
    const als = await pmSelectAll('pm_doc', 'select=id,doc_no,project_code,decided_at,ids:data->asset_ids&doc_type=eq.AL&status=eq.approved&order=decided_at.desc');
    const codes = [...new Set(als.map(a => a.project_code))];
    const [prj, ahs, recv] = codes.length ? await Promise.all([
      pmSelectAll('pm_project', `select=code,name,dept_code,status&code=in.(${codes.map(encodeURIComponent).join(',')})`),
      pmSelectAll('pm_doc', `select=id,doc_no,project_code,status,final:data->final,recv:data->recv_ids&doc_type=eq.AH&status=not.in.(cancelled,rejected)&project_code=in.(${codes.map(encodeURIComponent).join(',')})`),
      pmSelectAll('am_recv', `select=*&project_code=in.(${codes.map(encodeURIComponent).join(',')})&order=id`)]) : [[], [], []];
    RV.prj = new Map(prj.map(p => [p.code, p]));
    RV.ahs = ahs.map(h => Object.assign(h, { final: h.final === true || h.final === 'true' }));
    RV.recv = recv;
    // The ALRs this person receives for: they draw up the AH of the department (or edit assets).
    RV.als = als.filter(a => { const p = RV.prj.get(a.project_code); return p && (wfCanPrepare('AH', p.dept_code) || can('assets', 'edit'))
      && !RV.ahs.some(h => h.project_code === a.project_code && h.status === 'approved' && h.final); });
    msg(rvOut(), RV.flash ? 'ok' : '', RV.flash || ''); RV.flash = null;
    if (RV.al && !RV.als.some(a => a.id === RV.al)) RV.al = null;
    if (RV.al) await rvOpen(RV.al); else rvRender();
  } catch (e) { $('#rvBody').innerHTML = ''; msg(rvOut(), 'err', rvMissing(e) ? t('rv.notInstalled') : e.message); }
}
/* Per asset: what is received in handovers already SENT (in review / approved), and the
   line still open — not in an AH, or in the draft AH (it can still change there; the
   same rule as am_recv_set). Cancelled / rejected AHs are not loaded: their lines are open. */
const rvAhSt = id => (RV.ahs.find(h => h.id === id) || {}).status || null;
const rvOpenLine = r => !r.ah_doc_id || !rvAhSt(r.ah_doc_id) || ['draft', 'returned'].includes(rvAhSt(r.ah_doc_id));
const rvDone = a => RV.recv.filter(r => r.asset_id === a.id && !rvOpenLine(r)).reduce((s, r) => s + n0(r.qty), 0);
const rvPend = a => RV.recv.filter(r => r.asset_id === a.id && rvOpenLine(r)).slice(-1)[0] || null;

function rvRender() {
  const body = $('#rvBody');
  if (!body) return;
  body.innerHTML = '';
  if (!RV.als.length) { body.append(el('div', { className: 'card' }, el('div', { className: 'tbempty', textContent: t('rv.none') }))); return; }
  const grid = el('div', { className: 'rvcards' });
  for (const a of RV.als) {
    const p = RV.prj.get(a.project_code) || {}, ids = a.ids || [];
    const got = RV.recv.filter(r => ids.includes(r.asset_id));
    const inAh = new Set(got.filter(r => r.ah_doc_id && rvAhSt(r.ah_doc_id)).map(r => r.asset_id)).size;
    grid.append(el('button', { className: 'tbcard band-op rvcard', type: 'button', onclick: () => rvOpen(a.id) }, [
      el('div', { className: 'r1' }, [el('span', { className: 'stg band-op', textContent: a.doc_no }), el('span', { className: 'when', textContent: fmtDate(String(a.decided_at || '').slice(0, 10)) })]),
      el('div', { className: 'pn', textContent: p.name || a.project_code }),
      el('div', { className: 'r3' }, [el('span', { textContent: `${a.project_code} · ${pmDeptName(p.dept_code)}` }),
        el('b', { textContent: t('rv.cardN', { g: new Set(got.map(r => r.asset_id)).size, n: ids.length, h: inAh }) })])]));
  }
  body.append(el('div', { className: 'card' }, [el('div', { className: 'tdnote', textContent: t('rv.pick') }), grid]));
}

async function rvOpen(alId) {
  RV.al = alId;
  const a = RV.als.find(x => x.id === alId);
  if (!a) return rvRender();
  msg(rvOut(), 'info', t('table.loading'));
  try {
    const ids = a.ids || [];
    const rows = [];
    for (let i = 0; i < ids.length; i += 150)
      rows.push(...await SB.select('am_asset', `select=id,asset_code,barcode,name_vi,name_en,qty,unit_code,unit_price,location_code,asset_kind,status_code,dept_code&id=in.(${ids.slice(i, i + 150).join(',')})&order=asset_code`));
    RV.assets = rows.map(r => Object.assign(r, { name: [r.name_vi, r.name_en].filter(Boolean).join('/') }));
    RV.photos = await phLoad(ids).catch(() => []);
    msg(rvOut(), '', '');
    rvDraw();
  } catch (e) { msg(rvOut(), 'err', e.message); }
}
async function rvRefresh() {
  const a = RV.als.find(x => x.id === RV.al); if (!a) return;
  const [recv, ahs] = await Promise.all([pmSelectAll('am_recv', `select=*&project_code=eq.${encodeURIComponent(a.project_code)}&order=id`),
    pmSelectAll('pm_doc', `select=id,doc_no,project_code,status,final:data->final,recv:data->recv_ids&doc_type=eq.AH&status=not.in.(cancelled,rejected)&project_code=eq.${encodeURIComponent(a.project_code)}`)]);
  RV.recv = RV.recv.filter(r => r.project_code !== a.project_code).concat(recv);
  RV.ahs = RV.ahs.filter(h => h.project_code !== a.project_code).concat(ahs.map(h => Object.assign(h, { final: h.final === true || h.final === 'true' })));
  RV.photos = await phLoad(a.ids || []).catch(() => RV.photos);
}

function rvDraw() {
  const body = $('#rvBody');
  body.innerHTML = '';
  const a = RV.als.find(x => x.id === RV.al), p = RV.prj.get(a.project_code) || {};
  const back = el('button', { className: 'btn tbback', type: 'button', textContent: '‹ ' + t('rv.back'), onclick: () => { RV.al = null; rvRender(); } });
  const ph = (as, k) => RV.photos.filter(x => x.asset_id === as.id && x.kind === k);
  const rows = RV.assets.map(as => ({ as, done: rvDone(as), pend: rvPend(as), ok: PH_KINDS.every(k => ph(as, k).length) }));
  const now = rows.filter(r => r.pend && r.pend.pick === 'now'), later = rows.filter(r => r.pend && r.pend.pick === 'next');
  const left = rows.filter(r => r.done + n0(r.pend && r.pend.qty) < n0(r.as.qty || 1));
  // Scan box: a scanner types the code and Enter; the asset is marked received (one unit, or its line focused).
  const scan = el('input', { className: 'lcscan', placeholder: t('rv.scan'), spellcheck: false, autocapitalize: 'characters' });
  scan.onkeydown = async e => {
    if (e.key !== 'Enter') return;
    const q = scan.value.trim().toUpperCase(); scan.value = '';
    if (!q) return;
    const r = rows.find(x => [x.as.barcode, x.as.asset_code].some(c => String(c || '').toUpperCase() === q));
    if (!r) { msg(rvOut(), 'warn', t('rv.notHere', { c: q })); return; }
    if (r.as.asset_kind === 'unique') {
      if (r.done >= 1 || r.pend) { msg(rvOut(), 'info', t('rv.already', { c: r.as.asset_code })); rvFocus(r.as.id); return; }
      await rvSet(r.as, 1, 'now', true, t('rv.gotOne', { c: r.as.asset_code }));
    } else rvFocus(r.as.id, true);
  };
  const flt = el('select');
  selFill(flt, [['', t('rv.f.all')], ['todo', t('rv.f.todo')], ['now', t('rv.f.now')], ['next', t('rv.f.next')], ['nophoto', t('rv.f.nophoto')]]);
  flt.value = RV.only;
  flt.onchange = () => { RV.only = flt.value; rvDraw(); };
  body.append(el('div', { className: 'card rvhead' }, [
    el('div', { className: 'row', style: 'align-items:center;gap:10px;flex-wrap:wrap' }, [back, el('b', { textContent: `${a.doc_no} · ${p.name || a.project_code}` }),
      el('span', { className: 'dim', textContent: `${a.project_code} · ${pmDeptName(p.dept_code)}` })]),
    el('div', { className: 'row', style: 'margin-top:8px;gap:8px;flex-wrap:wrap;align-items:flex-end' }, [el('div', { className: 'fld grow' }, scan), el('div', { className: 'fld' }, flt)]),
    el('div', { className: 'tdnote', textContent: t('rv.hint') })]));

  const list = el('div', { className: 'rvlist' });
  const show = rows.filter(r => !RV.only || (RV.only === 'todo' && !r.pend && r.done < n0(r.as.qty || 1)) || (RV.only === 'now' && r.pend && r.pend.pick === 'now')
    || (RV.only === 'next' && r.pend && r.pend.pick === 'next') || (RV.only === 'nophoto' && !r.ok));
  for (const r of show) list.append(rvRow(r, ph));
  if (!show.length) list.append(el('div', { className: 'tbempty', textContent: t('pm.none.filter') }));
  body.append(list);

  // Footer: this handover's batch, what waits for the next one, and the button.
  const nAh = RV.ahs.filter(h => h.project_code === a.project_code).length;
  const draft = RV.ahs.find(h => h.project_code === a.project_code && ['draft', 'returned'].includes(h.status));
  const units = now.reduce((s, r) => s + n0(r.pend.qty), 0);
  const noPh = now.filter(r => !r.ok).length;
  const go = el('button', { className: 'btn pri', type: 'button', disabled: !now.length && !draft, textContent: draft ? t('rv.ahUpdate', { no: draft.doc_no }) : t('rv.ahNew', { n: nAh + 1 }) });
  go.onclick = () => rvToAh(a, p, rows);
  body.append(el('div', { className: 'rvfoot' }, [
    el('div', {}, [el('b', { textContent: t('rv.batch', { n: draft ? nAh : nAh + 1 }) }), document.createTextNode(' ' + t('rv.batchN', { a: now.length, u: fmtNum(units) })),
      later.length ? el('div', { className: 'dim', textContent: t('rv.later', { n: later.length }) }) : '',
      left.length ? el('div', { className: 'dim', textContent: t('rv.left', { n: left.length }) }) : '',
      noPh ? el('div', { className: 'tglate', textContent: t('rv.noPhoto', { n: noPh }) }) : '']),
    el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-end' }, [
      later.length ? el('button', { className: 'btn', type: 'button', textContent: t('rv.allNow'), onclick: () => rvPickAll(later, 'now') }) : '',
      now.length ? el('button', { className: 'btn', type: 'button', textContent: t('rv.allLater'), onclick: () => rvPickAll(now, 'next') }) : '',
      draft ? el('button', { className: 'btn', type: 'button', textContent: t('rv.openAh'), onclick: () => wfOpen(draft.id) }) : '', go])]));
  setTimeout(() => { const s = $('.lcscan'); if (s && !TB.on) s.focus(); }, 30);
}

function rvRow(r, ph) {
  const { as } = r, ordered = n0(as.qty || 1), pend = r.pend;
  const row = el('div', { className: 'rvrow' + (pend ? ' got' : '') + (r.done >= ordered ? ' full' : ''), id: 'rv-' + as.id });
  row.append(el('div', { className: 'rvwho' }, [el('code', { textContent: as.asset_code || '' }), el('small', { textContent: `${as.barcode || ''} · ${as.name || ''}` }),
    el('small', { className: 'dim', textContent: t('rv.ordered', { q: fmtNum(ordered), u: as.unit_code || '', d: fmtNum(r.done) }) })]));
  // Quantity actually received this time.
  const qbox = el('div', { className: 'rvqty' });
  if (as.asset_kind === 'unique') {
    const c = el('input', { type: 'checkbox', checked: !!pend || r.done >= 1, disabled: r.done >= 1 });
    c.onchange = () => rvSet(as, c.checked ? 1 : 0, pend ? pend.pick : 'now', false);
    qbox.append(el('label', { className: 'rvchk' }, [c, ' ' + (r.done >= 1 ? t('rv.inAh') : t('rv.received'))]));
  } else {
    const rest = Math.max(0, ordered - r.done);
    const i = el('input', { type: 'text', inputMode: 'decimal', className: 'num', value: pend ? fmtNum(pend.qty) : '', placeholder: fmtNum(rest), disabled: rest <= 0 && !pend });
    i.onchange = () => { const v = numIn(i.value); if (v != null && v > rest) { msg(rvOut(), 'err', t('rv.tooMany', { q: fmtNum(rest) })); i.value = pend ? fmtNum(pend.qty) : ''; return; }
      rvSet(as, v || 0, pend ? pend.pick : 'now', false); };
    qbox.append(el('label', {}, [el('small', { textContent: t('rv.qtyNow', { u: as.unit_code || '' }) }), i]));
    if (rest > 0) qbox.append(el('button', { className: 'btn tiny', type: 'button', textContent: t('rv.all', { q: fmtNum(rest) }), onclick: () => rvSet(as, rest, pend ? pend.pick : 'now', false) }));
  }
  row.append(qbox);
  // This handover or the next.
  const seg = el('div', { className: 'seg rvseg' });
  for (const k of ['now', 'next']) seg.append(el('button', { type: 'button', className: pend && pend.pick === k ? 'on' : '', disabled: !pend, textContent: t('rv.pick.' + k),
    onclick: () => rvSet(as, pend.qty, k, false) }));
  row.append(seg);
  // The two photos.
  const pbox = el('div', { className: 'rvph' });
  for (const k of PH_KINDS) {
    const list = ph(as, k);
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true });
    file.setAttribute('capture', 'environment');
    file.onchange = async () => {
      if (!file.files[0]) return;
      msg(rvOut(), 'info', t('ph.uploading'));
      try { await phUpload(as, k, file.files[0], RV.al); RV.photos = await phLoad(RV.assets.map(x => x.id)); msg(rvOut(), 'ok', t('rv.photoOk', { c: as.asset_code })); rvDraw(); rvFocus(as.id); }
      catch (e) { msg(rvOut(), 'err', e.message); }
    };
    const shot = el('button', { className: 'rvshot' + (list.length ? ' ok' : ''), type: 'button', title: t('ph.k.' + k), onclick: () => file.click() },
      [el('span', { textContent: (list.length ? '✓ ' : '📷 ') + t('ph.k.' + k) })]);
    if (list.length && list[0].source === 'storage') {
      const img = el('img', { alt: '' });
      phUrl(list[0].thumb_path || list[0].storage_path).then(u => { img.src = u; }).catch(() => {});
      shot.prepend(img);
    }
    pbox.append(file, shot);
  }
  row.append(pbox);
  return row;
}
function rvFocus(id, input) {
  const n = document.getElementById('rv-' + id);
  if (!n) return;
  n.scrollIntoView({ block: 'center', behavior: 'smooth' });
  n.classList.add('hit'); setTimeout(() => n.classList.remove('hit'), 1600);
  if (input) { const i = n.querySelector('.rvqty input[type=text]'); if (i) setTimeout(() => i.focus(), 250); }
}
async function rvSet(as, qty, pick, scanned, okText) {
  if (RV.busy) return;
  RV.busy = true;
  try {
    await SB.rpc('am_recv_set', { p_asset: as.id, p_qty: qty, p_pick: pick, p_note: null, p_scanned: !!scanned });
    await rvRefresh();
    msg(rvOut(), okText ? 'ok' : '', okText || '');
    rvDraw(); rvFocus(as.id);
  } catch (e) { msg(rvOut(), 'err', rvMissing(e) ? t('rv.notInstalled') : e.message); }
  finally { RV.busy = false; }
}
async function rvPickAll(rows, pick) {
  try { await SB.rpc('am_recv_pick', { p_ids: rows.map(r => r.pend.id), p_pick: pick }); await rvRefresh(); rvDraw(); }
  catch (e) { msg(rvOut(), 'err', e.message); }
}

/* The draft AH of the project, created or brought up to date with the lines
   chosen for this handover (received, "this handover"): lines grouped by item,
   unit, location and price; the PO's supplier, warranty and hidden columns;
   FINAL when nothing else is left to receive. */
async function rvToAh(a, p, rows) {
  const draft = RV.ahs.find(h => h.project_code === a.project_code && ['draft', 'returned'].includes(h.status));
  const now = rows.filter(r => r.pend && r.pend.pick === 'now');
  if (!now.length && !draft) return msg(rvOut(), 'warn', t('rv.nothing'));
  const noPh = now.filter(r => !r.ok).length;
  if (noPh && !confirm(t('rv.noPhotoQ', { n: noPh }))) return;
  msg(rvOut(), 'info', t('rv.building'));
  try {
    const docs = await SB.select('pm_doc', `select=id,doc_type,doc_no,status,data&project_code=eq.${encodeURIComponent(a.project_code)}&status=not.in.(cancelled,rejected)`);
    const po = (docs.find(d => d.doc_type === 'PO' && d.status === 'approved') || {}).data || {};
    const alNos = new Map(docs.filter(d => d.doc_type === 'AL').map(d => [d.id, d.doc_no]));
    // Every approved ALR of the project: what is left once this handover is counted.
    const allIds = docs.filter(d => d.doc_type === 'AL' && d.status === 'approved').flatMap(d => (d.data && d.data.asset_ids) || []);
    const lines = new Map(), specOf = name => ((po.lines || []).find(l => l.asset_item && hnorm(l.asset_item) === hnorm(name)) || {}).spec || {};
    for (const r of now) {
      const as = r.as, k = [as.name, as.unit_code, as.location_code, n0(as.unit_price)].join('|');
      const l = lines.get(k) || { asset_item: as.name, unit: as.unit_code || null, location: as.location_code || null, unit_price: n0(as.unit_price) || null, qty: 0, spec: JSON.parse(JSON.stringify(specOf(as.name))) };
      l.qty += n0(r.pend.qty);
      lines.set(k, l);
    }
    const got = id => { const as = RV.assets.find(x => x.id === id); return as ? rvDone(as) + n0((now.find(r => r.as.id === id) || {}).pend && now.find(r => r.as.id === id).pend.qty) : 0; };
    const pendingAl = docs.some(d => d.doc_type === 'AL' && d.status !== 'approved');
    const others = allIds.filter(id => !RV.assets.some(x => x.id === id));
    const final = !pendingAl && !others.length && RV.assets.every(as => got(as.id) >= n0(as.qty || 1));
    const base = draft ? (docs.find(d => d.id === draft.id) || {}).data || {} : {
      handover_date: new Date().toISOString().slice(0, 10), evaluation: 'Satisfactory', supplier: po.supplier || '', warranty_term: po.warranty_term || '',
      hide_cols: po.hide_cols || [], evidence: [] };
    const data = Object.assign({}, base, { lines: [...lines.values()], asset_ids: [...new Set(now.map(r => r.as.id))], recv_ids: now.map(r => r.pend.id),
      al_ids: [a.id], al_nos: [alNos.get(a.id) || a.doc_no], final });
    WF_FORMS.AH.derive(data);
    let id = draft ? draft.id : null;
    if (id) await SB.rpc('pm_doc_save', { p_id: id, p_data: data });
    else id = await SB.rpc('pm_doc_create', { p_project: a.project_code, p_type: 'AH', p_data: data });
    await SB.rpc('am_recv_link', { p_ah: id, p_ids: now.map(r => r.pend.id) });
    await rvRefresh();
    const [ah] = await SB.select('pm_doc', `select=doc_no&id=eq.${id}`);
    msg(rvOut(), 'ok', t(final ? 'rv.ahDoneFinal' : 'rv.ahDone', { no: (ah || {}).doc_no || '', n: now.length }));
    rvDraw();
    if (!TB.on && confirm(t('rv.openAhQ'))) wfOpen(id);
  } catch (e) { msg(rvOut(), 'err', e.message); }
}
