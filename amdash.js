/* ============================================================ ASSET DASHBOARD
   (40_asset_dashboard.sql) — Overview → Dashboard → Asset (user 28/09/2026).

   One call to am_dashboard() (everything summed on the server — the register
   holds ~16,000 assets), then the same parts as the project dashboard: a
   filter row that scopes everything below it, three tile clusters (the
   register · data quality · operation), charts with tooltips and a Table view,
   and short lists that open the asset or the screen behind them.

   Colours are the house chart tokens (.viz in AssetManagement.html): one hue
   for single-series bars, pale / navy for a pair on one axis, the ordinal blue
   ramp for age (newest light → oldest dark), grey for "unknown".

   Loaded after app.js and assetops.js; uses their helpers (el, msg, t, can,
   SB, chartCard, hbarChart, lineChart, stackBar, fmtM, fmtMoney, fmtPct,
   fmtInt, amStatusLabel, pmLookups, pmDeptName, pmEntity, msSetup, aoAsset). */

const AMD = { data: null, all: null, kind: '', busy: false };

async function amdLoad() {
  const out = $('#amdMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    // The unfiltered call first: it lists the departments (with their counts) for the filter.
    if (!AMD.all) {
      AMD.all = await SB.rpc('am_dashboard', {});
      const depts = (AMD.all.by_dept || []).map(d => d.dept).filter(Boolean).sort();
      msSetup('amdEnt', PM_ENTITIES.map(e => ({ v: e, t: `${e} — ${t('perms.ent.' + e)}` })));
      msSetup('amdDept', depts.map(d => ({ v: d, t: `${d} — ${pmDeptName(d)}` })));
      for (const id of ['amdEnt', 'amdDept']) MS[id].onChange = amdFilter;
      selFill($('#amdKind'), [['', t('amd.kind.all')], ['unique', t('reg.kindUnique')], ['low', t('reg.kindLow')]]);
      $('#amdKind').value = AMD.kind;
      $('#amdKind').onchange = () => { AMD.kind = $('#amdKind').value; amdFilter(); };
      $('#btnAmdReload').onclick = () => { AMD.all = null; amdLoad(); };
      $('#btnAmdRep').onclick = () => showView('amrep');
    }
    await amdFilter(true);
    msg(out, '', '');
  } catch (e) {
    $('#amdBody').innerHTML = '';
    msg(out, 'err', /am_dashboard|PGRST202|404/.test(e.message) ? t('amd.notInstalled') : e.message);
  }
}

// The departments the filters leave (null = all), then one call for them.
async function amdFilter(first) {
  const ent = msValues('amdEnt'), dep = msValues('amdDept');
  const all = (AMD.all.by_dept || []).map(d => d.dept);
  let depts = null;
  if (ent.length || dep.length) depts = all.filter(d => (!ent.length || ent.includes(pmEntity(d))) && (!dep.length || dep.includes(d)));
  try {
    AMD.data = !depts && !AMD.kind && AMD.all ? AMD.all : await SB.rpc('am_dashboard', { p_depts: depts, p_kind: AMD.kind || null });
    amdRender();
  } catch (e) { msg('#amdMsg', 'err', e.message); if (first) throw e; }
}

function amdRender() {
  const D = AMD.data, box = $('#amdBody');
  box.innerHTML = '';
  if (!D) return;
  const N = Number(D.n) || 0;
  const pct = (a, b) => (b ? fmtPct(a / b, 0) : '—');
  const fig = (label, value, sub, opts = {}) => {
    const f = el('div', { className: 'dfig' + (opts.cls ? ' ' + opts.cls : '') + (opts.go ? ' go' : '') }, [el('span', { className: 'sl', textContent: label }),
      el('b', { textContent: value }), el('small', { textContent: sub || '' })]);
    if (opts.go) { f.tabIndex = 0; f.title = t('amd.open'); f.onclick = opts.go; f.onkeydown = e => { if (e.key === 'Enter') opts.go(); }; }
    return f;
  };
  if (!N && !Number(D.gone_n)) { box.append(el('div', { className: 'msg info', textContent: t('amd.empty') })); return; }

  // 1. The register: the headline number, then value and make-up.
  const reg = el('div', { className: 'hero dtop dval', style: 'grid-template-columns:repeat(5,minmax(0,1fr))' }, [
    el('div', { className: 'dlead' }, [el('span', { className: 'hl', textContent: t('amd.onBooks') }), el('span', { className: 'hv', textContent: fmtInt(N) }),
      el('span', { className: 'hs', textContent: t('amd.units', { n: fmtInt(Number(D.units) || 0) }) })]),
    fig(t('amd.value'), fmtM(Number(D.value) || 0), t('amd.valueSub')),
    fig(t('amd.unique'), fmtInt(Number(D.unique_n) || 0), t('amd.uniqueSub', { p: pct(Number(D.unique_n), N) })),
    fig(t('amd.low'), fmtInt(Number(D.low_n) || 0), t('amd.lowSub', { p: pct(Number(D.low_n), N) })),
    fig(t('amd.new30'), fmtInt(Number(D.new30) || 0), t('amd.goneSub', { n: fmtInt(Number(D.gone_n) || 0), v: fmtM(Number(D.gone_value) || 0) }),
        { go: () => showView('register') })]);
  // 2. Data quality: what still needs doing on the register itself.
  const q = el('div', { className: 'hero dtop' }, [el('span', { className: 'hl', textContent: t('amd.quality') }), el('div', { className: 'dfigs n4' }, [
    fig(t('amd.photo'), pct(Number(D.photo_n), N), t('amd.ofN', { n: fmtInt(Number(D.photo_n) || 0), of: fmtInt(N) }), { go: () => showView('sources') }),
    fig(t('amd.label'), pct(Number(D.label_n), N), t('amd.labelDue', { n: fmtInt(Number(D.label_due) || 0) }), { go: () => showView('alr') }),
    fig(t('amd.review'), fmtInt(Number(D.review_n) || 0), t('amd.reviewSub'), { cls: Number(D.review_n) ? 'down' : '', go: () => showView('register') }),
    fig(t('amd.noloc'), fmtInt(Number(D.noloc_n) || 0), t('amd.nostatus', { n: fmtInt(Number(D.nostatus_n) || 0) }), { go: () => showView('register') })])]);
  // 3. Operation: what is happening to the assets now.
  const incN = (Number(D.inc_open) || 0) + (Number(D.inc_prog) || 0);
  const op = el('div', { className: 'hero dtop' }, [el('span', { className: 'hl', textContent: t('amd.operation') }), el('div', { className: 'dfigs n4' }, [
    fig(t('amd.incOpen'), fmtInt(incN), t('amd.incSub', { n: fmtInt(Number(D.inc_prog) || 0), c: fmtM(Number(D.inc_cost12) || 0) }), { cls: incN ? 'down' : '', go: () => showView('incident') }),
    fig(t('amd.repair'), fmtInt(Number(D.repair_now) || 0), t('amd.repairSub'), { go: () => showView('incident') }),
    fig(t('amd.tf'), fmtInt(Number(D.tf_pending) || 0), t('amd.tfSub'), { go: () => showView('transfer') }),
    fig(t('amd.liq'), fmtInt(Number(D.liq_wait) || 0), t('amd.liqSub'), { go: () => showView('liq') })])]);
  box.append(el('div', { className: 'dkpis3' }, [reg, q, op]));

  const charts = el('div', { className: 'charts' });
  // Validated with the dataviz palette checker (28/09/2026): the single series is ord-2 blue; the two-series pair
  // (two different measures, so categorical) is house blue + house gold — passes lightness, chroma, CVD and
  // normal-vision separation; gold is under 3:1 on white, relieved by the tooltips and the Table view.
  const ONE = '#1c5cab', C1 = '#1c5cab', C2 = '#c98a1c';
  // Counts: whole-number ticks. The charts draw four gridline steps, so pick a round integer STEP and end at 4 steps.
  const cmax = v => { const raw = Math.max(1, v) / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) { const s = f * p; if (Number.isInteger(s) && s >= raw) return s * 4; }
    return Math.ceil(raw) * 4; };
  const cnt = { axis: v => fmtInt(Math.round(v)), short: v => fmtInt(v), fmt: v => fmtInt(v) };
  const pc = { axis: v => fmtPct(v, 0), short: v => fmtPct(v, 0), fmt: v => fmtPct(v, 0), max: 1 };

  // a. By status — every status, including gone ones (they are what the register still lists).
  const st = (D.by_status || []).map(s => ({ key: s.code, label: s.code ? amStatusLabel(s.code) : t('amd.noStatus'), n: Number(s.n), v: Number(s.v) }));
  const stV = new Map(st.map(s => [s.key, s.n]));
  for (const s of st) s.tip = [{ label: t('amd.value'), value: fmtMoney(s.v) }];
  charts.append(chartCard(t('amd.c.status'), null, null,
    W => hbarChart(W, st, [Object.assign({ label: t('amd.assets'), color: ONE, values: stV, max: cmax(Math.max(0, ...st.map(s => s.n))) }, cnt)]),
    () => [[t('amd.status'), t('amd.assets'), t('amd.value')], ...st.map(s => [s.label, fmtInt(s.n), fmtMoney(s.v)])]));

  // b. By department — counts; value and photo coverage in the tooltip (different scales: never a second axis).
  const dp = (D.by_dept || []).map(d => ({ key: d.dept, label: `${d.dept} — ${pmDeptName(d.dept)}`, n: Number(d.n), v: Number(d.v), photo: Number(d.photo), lab: Number(d.label) }));
  for (const d of dp) d.tip = [{ label: t('amd.value'), value: fmtMoney(d.v) }, { label: t('amd.photo'), value: pct(d.photo, d.n) }];
  const dpShown = dp.slice(0, 20);
  charts.append(chartCard(t('amd.c.dept'), dp.length > 20 ? t('amd.top', { n: 20, of: dp.length }) : null, null,
    W => hbarChart(W, dpShown, [Object.assign({ label: t('amd.assets'), color: ONE, values: new Map(dp.map(d => [d.key, d.n])), max: cmax(Math.max(0, ...dp.map(d => d.n))) }, cnt)]),
    () => [[t('pm.col.dept'), t('amd.assets'), t('amd.value'), t('amd.photo'), t('amd.label')],
           ...dp.map(d => [d.label, fmtInt(d.n), fmtMoney(d.v), pct(d.photo, d.n), pct(d.lab, d.n)])]));

  // c. Book value by asset group (money).
  const gr = (D.by_group || []).map(g => ({ key: g.code || '—', label: `${g.code || '—'} ${(LANG === 'vi' ? g.name_vi : g.name_en || g.name_vi) || ''}`.trim(), n: Number(g.n), v: Number(g.v) }));
  for (const g of gr) g.tip = [{ label: t('amd.assets'), value: fmtInt(g.n) }];
  charts.append(chartCard(t('amd.c.group'), null, null,
    W => hbarChart(W, gr.slice(0, 15), [{ label: t('amd.value'), color: ONE, values: new Map(gr.map(g => [g.key, g.v])) }]),
    () => [[t('amd.group'), t('amd.assets'), t('amd.value')], ...gr.map(g => [g.label, fmtInt(g.n), fmtMoney(g.v)])]));

  // d. Photo and label coverage by department — two shares on ONE 0–100% axis.
  charts.append(chartCard(t('amd.c.cover'), null, [{ label: t('amd.photo'), color: C1 }, { label: t('amd.label'), color: C2 }],
    W => hbarChart(W, dpShown.map(d => ({ key: d.key, label: d.label, tip: [{ label: t('amd.assets'), value: fmtInt(d.n) }] })), [
      Object.assign({ label: t('amd.photo'), color: C1, values: new Map(dp.map(d => [d.key, d.n ? d.photo / d.n : 0])) }, pc),
      Object.assign({ label: t('amd.label'), color: C2, values: new Map(dp.map(d => [d.key, d.n ? d.lab / d.n : 0])) }, pc)]),
    () => [[t('pm.col.dept'), t('amd.photo'), t('amd.label')], ...dp.map(d => [d.label, pct(d.photo, d.n), pct(d.lab, d.n)])]));

  // e. Age — an ordered scale, so the ordinal ramp: newest light, oldest dark; unknown grey.
  const A = D.age || {};
  const ages = [['a', 'amd.age.a', '#86b6ef', '#1f2937'], ['b', 'amd.age.b', '#3987e5', '#fff'], ['c', 'amd.age.c', '#1c5cab', '#fff'],
                ['d', 'amd.age.d', '#0d366b', '#fff'], ['unk', 'amd.age.unk', '#d5dbe6', '#1f2937']]
    .map(([k, lk, color, ink]) => ({ label: t(lk), color, ink, n: Number((A[k] || {}).n) || 0, v: Number((A[k] || {}).v) || 0 }));
  charts.append(chartCard(t('amd.c.age'), t('amd.c.ageSub'), ages.filter(p => p.n).map(p => ({ label: `${p.label} · ${fmtInt(p.n)}`, color: p.color })),
    W => stackBar(W, ages, t('amd.assets')),
    () => [[t('amd.age'), t('amd.assets'), t('pm.viz.share'), t('amd.value')], ...ages.map(p => [p.label, fmtInt(p.n), pct(p.n, N), fmtMoney(p.v)])], true));

  // f. Incidents over the last 12 months: reported vs closed (both counts, one axis).
  const im = D.inc_months || [];
  const mLab = im.map(m => `${m.m.slice(5, 7)}/${m.m.slice(2, 4)}`);
  if (im.length === 12) {
    const opened = im.map(m => Number(m.opened) || 0), closed = im.map(m => Number(m.closed) || 0);
    const cntL = { axis: v => fmtInt(Math.round(v)), short: v => fmtInt(v), fmt: v => fmtInt(v), max: cmax(Math.max(0, ...opened, ...closed)) };
    charts.append(chartCard(t('amd.c.inc'), t('amd.c.incSub', { c: fmtM(Number(D.inc_cost12) || 0) }),
      [{ label: t('amd.incOpened'), color: C2, line: true }, { label: t('amd.incClosed'), color: C1, line: true }],
      W => lineChart(W, mLab, [Object.assign({ label: t('amd.incOpened'), color: C2, values: opened }, cntL),
                               Object.assign({ label: t('amd.incClosed'), color: C1, values: closed }, cntL)]),
      () => [[t('pm.viz.month'), t('amd.incOpened'), t('amd.incClosed'), t('amd.cost')], ...im.map((m, i) => [mLab[i], fmtInt(opened[i]), fmtInt(closed[i]), fmtMoney(Number(m.cost) || 0)])], true));
  }
  box.append(charts);
  for (const c of charts.children) c._draw && c._draw();

  // Lists: open asset counts, most repaired, warranty ending, building systems.
  const lists = el('div', { className: 'amdlists' });
  const listCard = (title, sub, rows, empty, goTo) => {   // rows: a node, or null for the empty text
    const c = el('div', { className: 'chartcard' });
    const h3 = el('h3', { textContent: title });
    if (sub) h3.append(el('span', { className: 'sub', textContent: sub }));
    const head = el('div', { className: 'ch' }, [h3]);
    if (goTo) head.append(el('button', { className: 'btn tiny', textContent: t('amd.open'), onclick: goTo }));
    c.append(head, rows || el('div', { className: 'dim', style: 'padding:6px 0', textContent: empty }));
    return c;
  };
  const counts = (D.counts_open || []).map(c => {
    const tot = Number(c.total) || 0, dn = Number(c.done) || 0;
    return el('div', { className: 'amdrow' }, [el('div', { className: 'grow' }, [el('b', { textContent: c.code }), el('span', { className: 'dim', textContent: ' · ' + (c.title || '') }),
      el('div', { className: 'meter' }, el('i', { style: `width:${tot ? Math.round(100 * dn / tot) : 0}%` }))]),
      el('span', { className: 'num', textContent: `${fmtInt(dn)} / ${fmtInt(tot)} · ${pct(dn, tot)}` })]);
  });
  lists.append(listCard(t('amd.l.counts'), D.count_last ? t('amd.l.countLast', { d: fmtDate(String(D.count_last).slice(0, 10)) }) : null,
    counts.length ? el('div', {}, counts) : null, t('amd.l.countsNone'), () => showView('stock')));
  const assetRow = (r, right) => {
    const row = el('div', { className: 'amdrow click' }, [el('div', { className: 'grow' }, [el('code', { textContent: r.code }),
      el('span', { className: 'dim', textContent: ` · ${r.name || ''} · ${r.dept || ''}` })]), el('span', { className: 'num', textContent: right })]);
    row.onclick = () => aoAsset(r.id);
    return row;
  };
  const top = (D.inc_top || []).map(r => assetRow(r, t('amd.l.repairN', { n: fmtInt(Number(r.n)), c: fmtM(Number(r.cost) || 0) })));
  lists.append(listCard(t('amd.l.repair'), t('amd.l.repairSub'), top.length ? el('div', {}, top) : null, t('amd.l.none'), () => showView('incident')));
  const war = (D.warranty_list || []).map(r => assetRow(r, fmtDate(r.until)));
  lists.append(listCard(t('amd.l.warranty'), t('amd.l.warrantySub', { n: fmtInt(Number(D.warranty90) || 0) }), war.length ? el('div', {}, war) : null, t('amd.l.none')));
  if (D.cond) {
    const c = D.cond, dist = c.dist || {};
    const chips = el('div', { className: 'endist', style: 'margin:6px 0 8px' }, [1, 2, 3, 4, 5].map(k => el('span', { className: 'enscore s' + k, textContent: `${k}: ${fmtInt(Number(dist[k]) || 0)}` })));
    lists.append(listCard(t('amd.l.cond'), t('amd.l.condSub', { a: fmtInt(Number(c.assessed) || 0), n: fmtInt(Number(c.items) || 0) }),
      el('div', {}, [chips, el('div', { className: 'amdrow' }, [el('span', { className: 'grow', textContent: t('amd.l.condLow') }), el('b', { textContent: fmtInt(Number(c.low) || 0) })]),
        el('div', { className: 'amdrow' }, [el('span', { className: 'grow', textContent: t('amd.l.condPlan') }), el('b', { textContent: fmtM(Number(c.plan5) || 0) })])]),
      '', () => showView('eng')));
  }
  box.append(lists);
  box.append(el('div', { className: 'dim', style: 'font-size:11.5px;margin-top:10px', textContent: t('amd.asOf', { at: fmtDateTime(D.as_of) }) }));
}

window.amdLoad = amdLoad;
