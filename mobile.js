/* =====================================================================
   PHONE APP VIEW (user 01/11/2026)
   On a phone (narrower than 768 px, or Settings → "always"), the app looks
   and moves like a phone app, in the colours of the web app: a Home screen —
   a summary card (the year's budget left, committed, paid; or the assets),
   round quick actions, the to-do list, the budget by department as bars,
   the assets in four figures — and a bar at the bottom: Home · To do ·
   [scan] · Dashboard · More. The middle button looks an asset up by its
   code or barcode (typed, from a scanner, or the camera where the browser
   reads barcodes). "More" opens the other phone screens in a sheet.
   A 10–11" tablet is not a phone: it shows the website itself, scaled down
   to 1024 px of layout (the viewport script in AssetManagement.html).
   ===================================================================== */
const MB = { home: null, at: 0, sheet: null };

// Stroke icons on a 24 px grid (no icon font: they print and scale the same everywhere).
const MB_IC = {
  home: '<path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/>',
  todo: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 10.5l2 2 4-4M8.5 16.5h7"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M7 12h10M8 9v6M11 9v6M14 9v6M16.5 9v6"/>',
  dash: '<path d="M12 4a8 8 0 1 0 8 8h-8z"/><path d="M15 3.5A6 6 0 0 1 20.5 9H15z"/>',
  more: '<circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/>',
  pay: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M3.5 10h17M7 14.5h4"/>',
  count: '<path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  assets: '<path d="M4 10 12 5l8 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3.5 20h17"/>',
  flows: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8.2 6H15a3 3 0 0 1 3 3v6.8M15.8 18H9a3 3 0 0 1-3-3V8.2"/>',
  meet: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9.5h16M8.5 3.5v3M15.5 3.5v3"/>',
  contract: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4M10 12h5M10 15.5h5"/>',
  recv: '<path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5z"/><path d="M3.5 8.5 12 13l8.5-4.5M12 13v7"/>',
  check: '<path d="M5 12.5 10 17l9-10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
  full: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16.5V20"/>',
  out: '<path d="M14 4.5h4.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H14M10 8l-4 4 4 4M6 12h9"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9.5h16M8.5 3.5v3M15.5 3.5v3"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  in: '<path d="M17 7 7 17M7 9v8h8"/>', outA: '<path d="M7 17 17 7M9 7h8v8"/>',
  cam: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/>'
};
const mbIcon = (k, cls = '') => el('span', { className: 'mbic ' + cls,
  innerHTML: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MB_IC[k] || ''}</svg>` });
const mbMoney = v => v == null || !isFinite(v) ? '—' : fmtMoney(v) + (curUsd() ? '' : ' đ');

/* The phone screens there are, for this person: [view, label key, icon, count]. */
function mbScreens() {
  const payRoles = window.PQ && PQ.route ? ['check', 'approve', 'process'].flatMap(k => PQ.route[k] || []) : ['CHIEF_ACC', 'ACCOUNTANT'];
  const out = [];
  const add = (v, key, ic, n) => { if (canView(v)) out.push([v, key, ic, n]); };
  add('inbox', 'tb.todo', 'todo', WF.badgeN);
  if (canView('payreq') && ME && ME.roles.some(x => payRoles.includes(x.role))) out.push(['payreq', 'mb.payreq', 'pay']);
  if (LQ.countN) add('lqcount', 'mb.lqCount', 'count', LQ.countN);
  if (window.AO && AO.sc.openN) add('stockcount', 'ao.sc.tab', 'count', AO.sc.openN);
  add('pmdash', 'mb.prjDash', 'dash'); add('amdash', 'mb.assetDash', 'assets');
  add('recv', 'mb.recv', 'recv'); add('engchk', 'mb.eng', 'check');
  add('meetings', 'mb.meet', 'meet'); add('contracts', 'mb.contract', 'contract');
  add('flows', 'tb.flows', 'flows');
  return out;
}

/* ------------------------------------------------------------ the bottom bar */
function mbBar(bar) {
  bar.className = 'tbbar mbbar';
  const on = v => VIEW === v || (v === 'inbox' && VIEW === 'doc');
  const tab = (v, key, ic, n, click) => {
    const b = el('button', { className: 'mbtab' + (on(v) ? ' on' : ''), type: 'button', onclick: click || (() => showView(v)) },
      [mbIcon(ic), el('span', { className: 'lb', textContent: t(key) })]);
    if (n) b.append(el('span', { className: 'tag', textContent: n > 99 ? '99+' : String(n) }));
    return b;
  };
  const third = canView('pmdash') ? ['pmdash', 'mb.dash', 'dash'] : canView('amdash') ? ['amdash', 'mb.assets', 'assets'] : ['flows', 'tb.flows', 'flows'];
  const moreOn = !['mhome', 'inbox', 'doc', third[0]].includes(VIEW);
  bar.append(
    tab('mhome', 'mb.home', 'home'),
    canView('inbox') ? tab('inbox', 'tb.todo', 'todo', WF.badgeN) : tab('flows', 'tb.flows', 'flows'),
    el('div', { className: 'mbfabwrap' }, el('button', { className: 'mbfab', type: 'button', title: t('mb.scan'), onclick: () => mbScan() }, mbIcon('scan'))),
    tab(...third),
    (() => { const b = tab('', 'mb.more', 'more', 0, () => mbMore()); b.classList.toggle('on', moreOn); return b; })());
}

/* "More": every other phone screen, the settings, the website, signing out — as a sheet. */
function mbSheet(title, kids) {
  mbSheetClose();
  const scrim = el('div', { className: 'mbscrim', onclick: () => mbSheetClose() });
  const sheet = el('div', { className: 'mbsheet', role: 'dialog' }, [el('div', { className: 'mbgrab' }),
    el('div', { className: 'mbsh' }, [el('b', { textContent: title }),
      el('button', { className: 'mbx', type: 'button', textContent: '✕', 'aria-label': t('pm.prj.close'), onclick: () => mbSheetClose() })]), ...kids]);
  document.body.append(scrim, sheet);
  MB.sheet = [scrim, sheet];
  requestAnimationFrame(() => { scrim.classList.add('on'); sheet.classList.add('on'); });
  return sheet;
}
function mbSheetClose() {
  if (!MB.sheet) return;
  for (const n of MB.sheet) n.remove();
  MB.sheet = null;
}
function mbMore() {
  const go = v => () => { mbSheetClose(); showView(v); };
  const tile = (key, ic, click, n) => el('button', { className: 'mbtile', type: 'button', onclick: click }, [
    el('span', { className: 'mbdot' }, [mbIcon(ic), n ? el('span', { className: 'tag', textContent: String(n) }) : '']), el('span', { textContent: t(key) })]);
  const tiles = mbScreens().filter(([v]) => v !== 'inbox').map(([v, key, ic, n]) => tile(key, ic, go(v), n));
  tiles.push(tile('page.settings', 'gear', go('settings')),
    tile('tb.full', 'full', () => { mbSheetClose(); try { localStorage.setItem(TB_KEY, 'off'); } catch {} tbApply(); }),
    tile('auth.signOut', 'out', () => { mbSheetClose(); authSignOut(); }));
  mbSheet(t('mb.more'), [el('div', { className: 'mbtiles' }, tiles),
    el('p', { className: 'mbhint', textContent: t('mb.moreHint') })]);
}

/* ------------------------------------------------------------ look an asset up */
// The middle button: a code or barcode typed (or sent by a Bluetooth scanner), or read by the camera.
function mbScan() {
  const inp = el('input', { className: 'mbscanin', placeholder: t('mb.scanPh'), spellcheck: false, autocapitalize: 'characters', enterKeyHint: 'search' });
  const out = el('div', { className: 'mbscanout' });
  const find = async q => {
    q = String(q || '').trim(); if (!q) return;
    msg(out, 'info', t('table.loading'));
    try {
      const e = encodeURIComponent(q);
      let rows = await SB.select('am_asset', `select=id,asset_code,barcode,name_vi,name_en,dept_code,location_code,status_code&or=(asset_code.eq.${e},barcode.eq.${e})&limit=5`);
      if (!rows.length) rows = await SB.select('am_asset', `select=id,asset_code,barcode,name_vi,name_en,dept_code,location_code,status_code&or=(asset_code.ilike.*${e}*,barcode.ilike.*${e}*)&limit=8`);
      if (!rows.length) return msg(out, 'warn', t('mb.scanNone', { q }));
      if (rows.length === 1 && window.aoAsset) { mbSheetClose(); return aoAsset(rows[0].id); }
      out.innerHTML = '';
      for (const r of rows) out.append(el('button', { className: 'mbhit', type: 'button', onclick: () => { mbSheetClose(); if (window.aoAsset) aoAsset(r.id); } }, [
        el('div', {}, [el('b', { textContent: r.asset_code || r.barcode }), el('span', { textContent: (LANG === 'vi' ? r.name_vi || r.name_en : r.name_en || r.name_vi) || '' })]),
        el('small', { textContent: [r.dept_code, r.location_code, amStatusLabel(r.status_code)].filter(Boolean).join(' · ') }), mbIcon('chev')]));
    } catch (e) { msg(out, 'err', e.message); }
  };
  inp.onkeydown = e => { if (e.key === 'Enter') find(inp.value); };
  const kids = [el('div', { className: 'mbscanrow' }, [inp, el('button', { className: 'btn pri', type: 'button', textContent: t('mb.find'), onclick: () => find(inp.value) })])];
  // The camera, where the browser can read barcodes (Chrome on Android); elsewhere the typed code.
  if ('BarcodeDetector' in window && navigator.mediaDevices) {
    const video = el('video', { className: 'mbcam', playsInline: true, muted: true, hidden: true });
    let stream = null, stop = false;
    const camBtn = el('button', { className: 'btn mbcambtn', type: 'button' }, [mbIcon('cam'), el('span', { textContent: t('mb.camera') })]);
    camBtn.onclick = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.srcObject = stream; video.hidden = false; camBtn.hidden = true; await video.play();
        const det = new BarcodeDetector();
        const tick = async () => {
          if (stop || !MB.sheet) { stream.getTracks().forEach(x => x.stop()); return; }
          try { const [c] = await det.detect(video); if (c && c.rawValue) { stop = true; stream.getTracks().forEach(x => x.stop()); video.hidden = true; inp.value = c.rawValue; return find(c.rawValue); } } catch {}
          setTimeout(tick, 250);
        };
        tick();
      } catch (e) { msg(out, 'err', t('mb.camNo') + ' ' + (e.message || '')); }
    };
    kids.push(camBtn, video);
  }
  kids.push(out);
  mbSheet(t('mb.scan'), kids);
  setTimeout(() => inp.focus(), 60);
}

/* ------------------------------------------------------------ Home */
async function mbHomeLoad(force) {
  const box = $('#v-mhome');
  if (!box) return;
  if (MB.home && !force && Date.now() - MB.at < 60000) return mbHomeRender();
  if (!MB.home) box.replaceChildren(el('div', { className: 'mbload', textContent: t('table.loading') }));
  const year = new Date().getFullYear();
  const H = { year, todo: null, budget: null, assets: null };
  const jobs = [];
  if (canView('inbox')) jobs.push((async () => { await wfLookups(); WF.inbox = await wfAllTodos(); H.todo = WF.inbox.filter(r => r.kind !== 'prepare'); })().catch(() => {}));
  if (canView('pmdash')) jobs.push(mbBudget(year).then(b => { H.budget = b; }).catch(() => {}));
  if (canView('amdash')) jobs.push(SB.rpc('am_dashboard', {}).then(a => { H.assets = a; }).catch(() => {}));
  await Promise.all(jobs);
  MB.home = H; MB.at = Date.now();
  if (H.todo) { WF.badgeN = H.todo.length; tbBarRender(); }
  mbHomeRender();
}

// The year's budget by department: budget (final round), committed (each project's contract, else its estimate), paid.
async function mbBudget(year) {
  await pmLookups();
  const [rounds, projects, money] = await Promise.all([
    SB.select('pm_budget_round', `select=id&year=eq.${year}&is_final=eq.true`),
    pmSelectAll('pm_project', `select=code,dept_code,estimated_value,contract_value,status&year=eq.${year}`),
    pmSelectAll('pm_project_money', 'select=project_code,paid_gross').catch(() => [])]);
  const lines = rounds.length ? await pmSelectAll('pm_budget_line', `select=dept_code,estimated_value&round_id=eq.${rounds[0].id}`) : [];
  const paid = new Map(money.map(m => [m.project_code, Number(m.paid_gross) || 0]));
  const by = new Map();
  const row = d => { if (!by.has(d)) by.set(d, { dept: d, budget: 0, committed: 0, paid: 0 }); return by.get(d); };
  for (const l of lines) row(l.dept_code || '—').budget += Number(l.estimated_value) || 0;
  for (const p of projects) {
    if (p.status === 'cancelled') continue;
    const r = row(p.dept_code || '—');
    r.committed += Number(p.contract_value ?? p.estimated_value) || 0;
    r.paid += paid.get(p.code) || 0;
  }
  const depts = [...by.values()].sort((a, b) => Math.max(b.budget, b.committed) - Math.max(a.budget, a.committed));
  const sum = k => depts.reduce((s, r) => s + r[k], 0);
  return { depts, budget: sum('budget'), committed: sum('committed'), paid: sum('paid'), n: projects.filter(p => p.status !== 'cancelled').length };
}

function mbHomeRender() {
  const box = $('#v-mhome'), H = MB.home;
  if (!box || !H) return;
  const B = H.budget, A = H.assets;
  const first = String((ME && (ME.full_name || ME.email)) || '').trim().split(/\s+/).pop();
  const kids = [el('div', { className: 'mbhello' }, [el('span', { textContent: t('mb.hello', { n: first }) }),
    el('button', { className: 'mbpill', type: 'button', onclick: () => mbHomeLoad(true) }, [mbIcon('cal'), el('span', { textContent: fmtDate(new Date().toISOString().slice(0, 10)) })])])];

  // The summary card.
  let hero;
  if (B && (B.budget || B.committed)) {
    hero = [el('div', { className: 'mbhl' }, [el('span', { textContent: t('mb.left', { y: H.year }) }), el('span', { className: 'mbyr', textContent: H.year })]),
      el('div', { className: 'mbbig' + (B.budget - B.committed < 0 ? ' neg' : '') }, mbMoney(B.budget - B.committed)),
      el('div', { className: 'mbglass' }, [
        el('div', { className: 'mbgr' }, [mbIcon('in', 'sm'), el('span', { textContent: t('mb.budget') }), el('b', { textContent: mbMoney(B.budget) })]),
        el('div', { className: 'mbgr' }, [mbIcon('outA', 'sm'), el('span', { textContent: t('mb.committed', { n: B.n }) }), el('b', { textContent: mbMoney(B.committed) })]),
        el('div', { className: 'mbgline' }),
        el('div', { className: 'mbgr tot' }, [el('span', { textContent: t('mb.paid') }), el('b', { textContent: mbMoney(B.paid) })])])];
  } else if (A) {
    hero = [el('div', { className: 'mbhl' }, [el('span', { textContent: t('mb.assetsNow') })]),
      el('div', { className: 'mbbig' }, fmtInt(A.n)),
      el('div', { className: 'mbglass' }, [
        el('div', { className: 'mbgr' }, [el('span', { textContent: t('mb.assetValue') }), el('b', { textContent: mbMoney(A.value) })]),
        el('div', { className: 'mbgr' }, [el('span', { textContent: t('mb.liqWait') }), el('b', { textContent: fmtInt(A.liq_wait) })]),
        el('div', { className: 'mbgline' }),
        el('div', { className: 'mbgr tot' }, [el('span', { textContent: t('mb.repair') }), el('b', { textContent: fmtInt(A.repair_now) })])])];
  } else {
    hero = [el('div', { className: 'mbhl' }, [el('span', { textContent: t('tb.todo') })]), el('div', { className: 'mbbig' }, fmtInt((H.todo || []).length))];
  }
  kids.push(el('div', { className: 'mbhero' }, hero));

  // Quick actions: the first four of the scan and the phone screens.
  const acts = [['', 'mb.scanShort', 'scan', 0, () => mbScan()], ...mbScreens().map(([v, key, ic, n]) => [v, key, ic, n, () => showView(v)])].slice(0, 4);
  kids.push(el('div', { className: 'mbacts' }, acts.map(([, key, ic, n, go]) => el('button', { className: 'mbact', type: 'button', onclick: go }, [
    el('span', { className: 'mbdot' }, [mbIcon(ic), n ? el('span', { className: 'tag', textContent: String(n) }) : '']), el('span', { textContent: t(key) })]))));

  // To do: the first three, as the to-do list shows them.
  if (H.todo) {
    kids.push(mbSecHead(t('mb.todoH', { n: H.todo.length }), 'inbox'));
    const list = el('div', { className: 'mbcards' });
    if (!H.todo.length) list.append(el('div', { className: 'mbcard mbempty' }, [mbIcon('check', 'ok'), el('span', { textContent: t('tb.nothing') })]));
    for (const r of H.todo.slice(0, 3)) list.append(tbCard(r));
    kids.push(list);
  }

  // The budget by department: paid (dark) and committed (light) against the budget; the line is today in the year.
  if (B && B.depts.length) {
    kids.push(mbSecHead(t('mb.budgetH', { y: H.year }), 'pmdash'));
    const yearPart = (Date.now() - new Date(H.year, 0, 1)) / (new Date(H.year + 1, 0, 1) - new Date(H.year, 0, 1));
    const card = el('div', { className: 'mbcard mbbud' }, [el('div', { className: 'mbstrip' }, [
      el('div', {}, [el('small', { textContent: t('mb.paid') }), el('b', { textContent: fmtM(B.paid) })]),
      el('div', { className: 'c' + (B.committed > B.budget ? ' over' : '') }, [el('small', { textContent: t('mb.committedS') }), el('b', { textContent: fmtM(B.committed) })]),
      el('div', { className: 'r' }, [el('small', { textContent: t('mb.budget') }), el('b', { textContent: fmtM(B.budget) })])])]);
    const top = B.depts.slice(0, 5), rest = B.depts.slice(5);
    if (rest.length) top.push(rest.reduce((s, r) => ({ dept: '', others: true, budget: s.budget + r.budget, committed: s.committed + r.committed, paid: s.paid + r.paid }),
                                          { budget: 0, committed: 0, paid: 0 }));
    for (const r of top) {
      const max = Math.max(r.budget, r.committed, 1), over = r.committed > r.budget && r.budget > 0;
      const pct = v => Math.min(100, v / max * 100).toFixed(1) + '%';
      card.append(el('div', { className: 'mbrow' + (over ? ' over' : ''), title: r.dept }, [
        el('div', { className: 'mbrh' }, [el('span', { textContent: r.others ? t('mb.others') : pmDeptName(r.dept) || r.dept }),
          el('small', { textContent: `${fmtM(r.paid)} · ${fmtM(r.committed)} / ${fmtM(r.budget)}` })]),
        el('div', { className: 'mbtrack' }, [el('i', { className: 'cm', style: `width:${pct(r.committed)}` }), el('i', { className: 'pd', style: `width:${pct(r.paid)}` }),
          ...(r.budget ? [el('i', { className: 'bd', style: `left:${pct(r.budget)}` })] : []),
          el('i', { className: 'now', style: `left:${(Math.min(1, Math.max(0, yearPart)) * r.budget / max * 100).toFixed(1)}%`, title: t('mb.today') })])]));
    }
    card.append(el('div', { className: 'mblegend' }, [el('span', { className: 'pd', textContent: t('mb.paid') }), el('span', { className: 'cm', textContent: t('mb.committedS') }),
      el('span', { className: 'now', textContent: t('mb.today') })]));
    kids.push(card);
  }

  // The assets in four figures.
  if (A) {
    kids.push(mbSecHead(t('mb.assetsH'), 'amdash'));
    const fig = (key, v, cls = '') => el('div', { className: 'mbfig ' + cls }, [el('b', { textContent: fmtInt(v) }), el('span', { textContent: t(key) })]);
    kids.push(el('div', { className: 'mbfigs' }, [fig('mb.inUse', A.n), fig('mb.liqWait', A.liq_wait, A.liq_wait ? 'warn' : ''),
      fig('mb.repair', A.repair_now, A.repair_now ? 'warn' : ''), fig('mb.incOpen', A.inc_open, A.inc_open ? 'bad' : '')]));
  }
  box.replaceChildren(...kids);
}
const mbSecHead = (title, view) => el('div', { className: 'mbsec' }, [el('h3', { textContent: title }),
  canView(view) ? el('button', { className: 'mbsee', type: 'button', textContent: t('mb.seeAll'), onclick: () => showView(view) }) : '']);
