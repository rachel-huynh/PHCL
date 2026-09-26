/* ============================================================ PRICE REFERENCE DATABASE
   (32_price_db.sql) — for looking prices up and comparing them, apart from the
   asset register. Scope: technical materials and FF&E, as the "Reference
   Pricing List" workbook (user decision 26/09/2026).

     search   Tra cứu & so sánh: every price line matching the words, brought to
              VND before VAT per unit and to today's value (4.6% a year, as the
              MC form), with min / median / max per unit and a chart over time.
     chat     Hỏi nhanh: a question in plain words, answered FROM THE STORED DATA
              ONLY — no outside AI (user decision): the question is read for its
              item words, years and intent (latest / cheapest / dearest /
              average / compare / who quoted / trend), then pr_search() answers.
     sources  Nguồn giá (AM team): every quotation, market check, bid, PO and
              delivery, with its lines; manual ones editable.
     import   Nhập: sync from the app (QC, MC, PO, bids, deliveries), a new
              quotation through the AI prompt + JSON (like delivery notes), the
              old Excel workbook.

   Rights: the AM team (price.create) enters and sees suppliers; everyone else
   sees reference prices without supplier names — the database leaves them out.
   Loaded after app.js and uses its helpers. */

const PR = { tab: 'search', q: '', f: { kinds: [], year_from: '', goods_only: true, won_only: false, unit: '', grp: '', term_id: null }, rows: [], sel: new Set(), terms: null,
             std: { tab: 'none', q: '', sel: new Set(), term: '', lines: null },
             chat: [], sources: [], srcQ: '', srcKind: '', open: null, draft: null, drafts: [], ov: null };
const PR_KINDS = ['legacy', 'quote', 'market', 'qc', 'mc_hist', 'mc_market', 'po', 'tender', 'intake'];
const PR_RATE = 0.046;
// Price groups of the standard-name vocabulary (pr_term.grp).
const PR_GROUPS = ['HVAC', 'PLB', 'ELE', 'ICT', 'KIT', 'DOR', 'FIN', 'SAN', 'FUR', 'FPS', 'SRV', 'OTH'];
const prGrpChip = g => g ? el('span', { className: 'prg g-' + g, textContent: t('pr.g.' + g) }) : '';
// The vocabulary, once per page; a datalist of "VI/EN" names for the pickers.
async function prTerms(force) {
  if (PR.terms && !force) return PR.terms;
  PR.terms = await SB.select('pr_term', 'select=*&order=sort').catch(() => []);
  let dl = document.getElementById('prTermList');
  if (!dl) { dl = el('datalist', { id: 'prTermList' }); document.body.append(dl); }
  dl.innerHTML = '';
  for (const x of PR.terms.filter(x => x.active)) dl.append(el('option', { value: `${x.std_vi}/${x.std_en}`, label: t('pr.g.' + x.grp) }));
  return PR.terms;
}
// A standard-name picker: the vocabulary as suggestions, any new name allowed.
function prStdPicker(label, onPick, disabled) {
  const i = el('input', { placeholder: t('pr.stdPh'), spellcheck: false, className: 'prstdin', disabled: !!disabled });
  i.setAttribute('list', 'prTermList');
  const b = el('button', { className: 'btn tiny pri', type: 'button', textContent: label, disabled: !!disabled, onclick: () => { const v = i.value.trim(); if (v) onPick(v); } });
  i.onkeydown = e => { if (e.key === 'Enter' && i.value.trim()) onPick(i.value.trim()); };
  return el('span', { className: 'prstdpick' }, [i, b]);
}
const prFull = () => can('price', 'create');
const prEdit = () => can('price', 'edit');
const prMissing = e => /pr_search|pr_source|pr_overview|pr_sync|pr_line|PGRST20[25]|does not exist|404/.test(String(e && e.message));
const prErr = (out, e) => msg(out, 'err', prMissing(e) ? t('pr.notInstalled') : e.message);
const prMoney = v => v == null || v === '' || !isFinite(v) ? '' : fmtNum(Math.round(Number(v)));
const prKindChip = k => el('span', { className: 'prk k-' + k, textContent: t('pr.k.' + k) });
const prDate = d => d ? fmtDate(String(d).slice(0, 10)) : t('pr.noDate');
// Plain words for matching and the chatbot: lower case, no accents, single spaces.
const prNorm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9%./²-]+/g, ' ').replace(/\s+/g, ' ').trim();
const prMedian = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return !n ? null : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
function prFileLink(r) {
  if (r.file_url) return r.file_url;
  const base = PR.ov && typeof PR.ov.base_url === 'string' ? PR.ov.base_url : '';
  return base && r.file_name ? base.replace(/\/?$/, '/') + encodeURIComponent(r.file_name) : null;
}
// Per unit: count, min, median, max of today's value (goods lines with a price).
function prStats(rows) {
  const by = new Map();
  for (const r of rows) {
    const v = r.price_today ?? r.price_vnd;
    if (v == null || r.line_kind === 'lump') continue;
    const u = r.unit || '—';
    if (!by.has(u)) by.set(u, []);
    by.get(u).push(Number(v));
  }
  return [...by].map(([unit, vs]) => ({ unit, n: vs.length, min: Math.min(...vs), med: prMedian(vs), max: Math.max(...vs) })).sort((a, b) => b.n - a.n);
}
async function prSearch(q, f) { return SB.rpc('pr_search', { p_q: q || '', p_f: f || {} }); }

async function prLoad() {
  const out = $('#prMsg');
  msg(out, 'info', t('table.loading'));
  try {
    await pmLookups();
    PR.ov = await SB.rpc('pr_overview');
    await prTerms();
    msg(out, PR.flash ? 'ok' : '', PR.flash || ''); PR.flash = null;
    if (PR.tab === 'sources' && prFull()) await prLoadSources();
    prRender();
  } catch (e) { $('#prBody').innerHTML = ''; prErr(out, e); }
}

function prRender() {
  const tabs = $('#prTabs'), body = $('#prBody');
  if (!tabs) return;
  const list = [['search', t('pr.t.search')], ['chat', t('pr.t.chat')]];
  if (prFull()) list.push(['std', t('pr.t.std')], ['sources', t('pr.t.sources')], ['import', t('pr.t.import')]);
  if (!list.some(x => x[0] === PR.tab)) PR.tab = 'search';
  tabs.innerHTML = '';
  for (const [v, label] of list) {
    const b = el('button', { type: 'button', textContent: label });
    b.classList.toggle('on', PR.tab === v);
    b.onclick = async () => { PR.tab = v; if (v === 'std') PR.std.lines = null; if (v === 'sources') await prLoadSources().catch(e => prErr('#prMsg', e)); prRender(); };
    tabs.append(b);
  }
  body.innerHTML = '';
  if (PR.tab === 'search') return prSearchTab(body);
  if (PR.tab === 'chat') return prChatTab(body);
  if (PR.tab === 'sources') return prSourcesTab(body);
  if (PR.tab === 'import') return prImportTab(body);
  if (PR.tab === 'std') return prStdTab(body);
}

/* ------------------------------------------------------------ search & compare */
function prSearchTab(body) {
  const q = el('input', { value: PR.q, placeholder: t('pr.qPh'), spellcheck: false, className: 'prq' });
  const run = async () => { PR.q = q.value.trim(); await prRun(); };
  q.onkeydown = e => { if (e.key === 'Enter') run(); };
  const kinds = el('div', { className: 'prkinds' }, PR_KINDS.map(k => { const on = PR.f.kinds.includes(k);
    return el('button', { type: 'button', className: 'prk k-' + k + (on ? ' on' : ''), textContent: t('pr.k.' + k), onclick: () => {
      PR.f.kinds = on ? PR.f.kinds.filter(x => x !== k) : [...PR.f.kinds, k]; run(); } }); }));
  const yr = el('select'); selFill(yr, [['', t('pr.allYears')], ...[2020, 2021, 2022, 2023, 2024, 2025, 2026].map(y => [String(y), t('acc.fromYear', { y })])]); yr.value = PR.f.year_from;
  yr.onchange = () => { PR.f.year_from = yr.value; run(); };
  const goods = el('input', { type: 'checkbox', checked: PR.f.goods_only }); goods.onchange = () => { PR.f.goods_only = goods.checked; run(); };
  const won = el('input', { type: 'checkbox', checked: PR.f.won_only }); won.onchange = () => { PR.f.won_only = won.checked; run(); };
  const grp = el('select'); selFill(grp, [['', t('pr.allGroups')], ...PR_GROUPS.map(g => [g, t('pr.g.' + g)])]); grp.value = PR.f.grp || '';
  grp.onchange = () => { PR.f.grp = grp.value; run(); };
  body.append(el('div', { className: 'card' }, [
    el('div', { className: 'row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' }, [
      el('div', { className: 'fld', style: 'flex:1;min-width:260px' }, [el('label', { textContent: t('pr.q') }), q]),
      el('button', { className: 'btn pri', type: 'button', textContent: t('pr.find'), onclick: run }),
      el('div', { className: 'fld', style: 'max-width:170px' }, [el('label', { textContent: t('pr.year') }), yr]),
      el('div', { className: 'fld', style: 'max-width:220px' }, [el('label', { textContent: t('pr.group') }), grp]),
      el('label', { className: 'chk' }, [goods, el('span', { textContent: t('pr.goodsOnly') })]),
      el('label', { className: 'chk' }, [won, el('span', { textContent: t('pr.wonOnly') })])]),
    kinds, el('div', { className: 'tdnote', textContent: t(prFull() ? 'pr.searchHint' : 'pr.searchHintView') })]));
  const res = el('div', { id: 'prRes' });
  body.append(res);
  if (PR.rows.length || PR.q) prResults(res);
  setTimeout(() => q.focus(), 0);
}
async function prRun() {
  const out = $('#prMsg');
  try {
    msg(out, 'info', t('table.loading'));
    PR.rows = await prSearch(PR.q, Object.assign({}, PR.f, { limit: 500 }));
    PR.sel.clear();
    msg(out, '', '');
    prRender();
  } catch (e) { prErr(out, e); }
}
function prResults(box) {
  box.innerHTML = '';
  const rows = PR.rows;
  if (!rows.length) { box.append(el('div', { className: 'card dim', textContent: t('pr.none', { q: PR.q }) })); return; }
  // The standard names in the result: click one to compare like with like.
  const byStd = new Map();
  for (const r of rows) { const k = r.term_id || r.name_std || ''; if (!k) continue; const o = byStd.get(k) || { n: 0, name: r.name_std, term: r.term_id }; o.n++; byStd.set(k, o); }
  if (byStd.size > 1 || PR.f.term_id) box.append(el('div', { className: 'card prstdbar' }, [el('b', { textContent: t('pr.byStd') }),
    ...[...byStd.values()].sort((a, b) => b.n - a.n).slice(0, 12).map(o => el('button', { type: 'button', className: 'btn tiny' + (PR.f.term_id && PR.f.term_id === o.term ? ' on' : ''),
      textContent: `${o.name} (${o.n})`, disabled: !o.term, onclick: () => { PR.f.term_id = PR.f.term_id === o.term ? null : o.term; prRun(); } })),
    PR.f.term_id ? el('button', { type: 'button', className: 'btn tiny', textContent: '✕ ' + t('pr.clearStd'), onclick: () => { PR.f.term_id = null; prRun(); } }) : '']));
  const st = prStats(rows);
  box.append(el('div', { className: 'prstats' }, st.slice(0, 4).map(s => el('div', { className: 'aokpi' }, [
    el('small', { textContent: t('pr.statUnit', { u: s.unit, n: fmtInt(s.n) }) }),
    el('b', { textContent: prMoney(s.med) }),
    el('span', { textContent: t('pr.statRange', { a: prMoney(s.min), b: prMoney(s.max) }) })]))));
  const chart = prChart(rows, st[0] && st[0].unit);
  if (chart) box.append(el('div', { className: 'card' }, [el('h3', { textContent: t('pr.chartH', { u: st[0].unit }) }), chart]));
  const full = prFull(), edit = prEdit();
  const tools = [el('span', { className: 'dim', textContent: t('pr.found', { n: fmtInt(rows.length) }) }), el('span', { style: 'flex:1' }),
    el('button', { className: 'btn tiny', type: 'button', textContent: t('lq.xlsx'), onclick: () => prXlsx(rows) })];
  if (edit) tools.push(el('span', { className: 'dim', textContent: t('pr.setStd', { n: PR.sel.size }) }), prStdPicker(t('pr.assign'), v => prSetStd(v), !PR.sel.size));
  const cols = [...(edit ? [''] : []), 'pr.c.date', 'pr.c.kind', 'pr.c.item', 'pr.c.brand', 'pr.c.qty', 'pr.c.price', 'pr.c.labor', 'pr.c.net', 'pr.c.today',
                ...(full ? ['pr.c.supplier'] : []), 'pr.c.project', ...(full ? ['pr.c.file'] : [])];
  const num = new Set(['pr.c.qty', 'pr.c.price', 'pr.c.labor', 'pr.c.net', 'pr.c.today']);
  const tb = el('table', { className: 'lqbt prgrid' }, [el('tr', {}, cols.map(k => el('th', { className: num.has(k) ? 'num' : '', textContent: k ? t(k) : '' })))]);
  for (const r of rows.slice(0, 500)) {
    const cb = el('input', { type: 'checkbox', checked: PR.sel.has(r.id) });
    cb.onchange = () => { cb.checked ? PR.sel.add(r.id) : PR.sel.delete(r.id); prResults(box); };
    const link = full ? prFileLink(r) : null;
    tb.append(el('tr', { className: r.won ? 'prwon' : '' }, [
      ...(edit ? [el('td', {}, cb)] : []),
      el('td', { className: r.date ? '' : 'dim', textContent: prDate(r.date) }), el('td', {}, prKindChip(r.kind)),
      el('td', { className: 'aowrap' }, [el('b', { textContent: r.name_std || r.name }), r.variant ? el('span', { className: 'prvar', textContent: r.variant }) : '', prGrpChip(r.grp),
        r.name_std && r.name_std !== r.name ? el('div', { className: 'dim', textContent: r.name }) : '',
        r.section ? el('div', { className: 'dim', textContent: '↳ ' + r.section }) : '', r.note ? el('div', { className: 'dim', textContent: r.note }) : '']),
      el('td', { textContent: [r.brand, r.model, r.origin].filter(Boolean).join(' · ') }),
      el('td', { className: 'num', textContent: r.qty != null ? `${fmtNum(r.qty)} ${r.unit || r.unit_raw || ''}` : (r.unit || '') }),
      el('td', { className: 'num', textContent: prMoney(r.unit_price) + (r.currency && r.currency !== 'VND' ? ' ' + r.currency : '') }),
      el('td', { className: 'num', textContent: prMoney(r.labor_price) }),
      el('td', { className: 'num', textContent: prMoney(r.price_vnd) }),
      el('td', { className: 'num', textContent: r.line_kind === 'lump' ? t('pr.lump') : prMoney(r.price_today) }),
      ...(full ? [el('td', { className: 'aowrap', textContent: [r.supplier, r.won ? '✓ ' + t('pr.won') : r.won === false ? t('pr.lost') : ''].filter(Boolean).join(' · ') })] : []),
      el('td', { className: 'aowrap', textContent: [r.project_code, r.project_name].filter(Boolean).join(' — ') }),
      ...(full ? [el('td', {}, link ? el('a', { href: link, target: '_blank', rel: 'noopener', textContent: r.ref || r.file_name || '↗' }) : el('span', { className: 'dim', textContent: r.ref || '' }))] : [])]));
  }
  box.append(el('div', { className: 'card' }, [el('div', { className: 'row', style: 'gap:8px;align-items:center;margin-bottom:6px' }, tools), el('div', { className: 'wrap' }, tb),
    el('div', { className: 'tdnote', textContent: t('pr.netHint') })]));
}
// Price of the main unit over time: one dot per line (VND before VAT, as quoted then); a won / ordered price is ringed.
function prChart(rows, unit) {
  const pts = rows.filter(r => r.date && r.price_vnd != null && r.line_kind !== 'lump' && (r.unit || '—') === unit)
    .map(r => ({ x: new Date(r.date).getTime(), y: Number(r.price_vnd), r }));
  if (pts.length < 2) return null;
  const W = 760, H = 220, L = 70, R = 14, T = 12, B = 28;
  const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)) || x0 + 1, y1 = Math.max(...pts.map(p => p.y)) * 1.08 || 1;
  const X = v => L + (x1 === x0 ? (W - L - R) / 2 : (v - x0) / (x1 - x0) * (W - L - R)), Y = v => T + (1 - v / y1) * (H - T - B);
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'prchart'); svg.setAttribute('role', 'img');
  const add = (tag, a, txt) => { const n = document.createElementNS(ns, tag); for (const k in a) n.setAttribute(k, a[k]); if (txt != null) n.textContent = txt; svg.append(n); return n; };
  for (let i = 0; i <= 4; i++) { const v = y1 * i / 4; add('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'g' }); add('text', { x: L - 6, y: Y(v) + 4, class: 'ax', 'text-anchor': 'end' }, prMoney(v)); }
  const y0 = new Date(x0).getFullYear(), yN = new Date(x1).getFullYear();
  for (let y = y0; y <= yN; y++) { const tx = new Date(y, 0, 1).getTime(); if (tx >= x0 && tx <= x1 || y0 === yN) add('text', { x: y0 === yN ? X(x0) : X(tx), y: H - 8, class: 'ax', 'text-anchor': 'middle' }, String(y)); }
  for (const p of pts) {
    const c = add('circle', { cx: X(p.x), cy: Y(p.y), r: 5, class: p.r.won ? 'dot won' : 'dot' });
    const tt = document.createElementNS(ns, 'title');
    tt.textContent = `${prDate(p.r.date)} · ${p.r.name_std || p.r.name} · ${prMoney(p.y)} VND${p.r.supplier ? ' · ' + p.r.supplier : ''}`;
    c.append(tt);
  }
  return svg;
}
async function prSetStd(name) {
  const ids = [...PR.sel];
  if (!ids.length || !name) return;
  try { await SB.rpc('pr_set_std', { p_lines: ids, p_std: name, p_category: null }); PR.flash = t('pr.stdDone'); await prRun(); msg('#prMsg', 'ok', PR.flash); PR.flash = null; }
  catch (e) { prErr('#prMsg', e); }
}
function prXlsx(rows) {
  const full = prFull();
  const data = rows.map(r => Object.assign({ [t('pr.c.date')]: r.date || t('pr.noDate'), [t('pr.c.kind')]: t('pr.k.' + r.kind), [t('pr.c.item')]: r.name, [t('pr.c.std')]: r.name_std,
    [t('pr.c.section')]: r.section, [t('pr.c.brand')]: [r.brand, r.model].filter(Boolean).join(' · '), [t('pr.c.qtyN')]: r.qty != null ? Number(r.qty) : null, [t('pr.c.unit')]: r.unit,
    [t('pr.c.price')]: r.unit_price != null ? Number(r.unit_price) : null, [t('pr.c.labor')]: r.labor_price != null ? Number(r.labor_price) : null,
    [t('pr.c.net')]: r.price_vnd != null ? Number(r.price_vnd) : null, [t('pr.c.today')]: r.price_today != null ? Number(r.price_today) : null,
    [t('pr.c.project')]: [r.project_code, r.project_name].filter(Boolean).join(' — ') },
    full ? { [t('pr.c.supplier')]: r.supplier, [t('pr.c.won')]: r.won == null ? '' : r.won ? '✓' : '✗', [t('pr.c.ref')]: r.ref, [t('pr.c.file')]: prFileLink(r) || r.file_name } : {}));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Gia tham chieu');
  const file = `phcl-gia-tham-chieu-${bkStamp()}.xlsx`; XLSX.writeFile(wb, file); msg('#prMsg', 'ok', t('lq.exported', { file }));
}

/* ------------------------------------------------------------ chatbot (stored data only) */
const PR_STOP = new Set(('gia bao gia cho la bao nhieu nao nhat re dat cao thap gan moi trung binh binh quan so sanh nam tu den tu nam cac nhung voi va o tai thi co khong ' +
  'duoc cho toi xem tim kiem tra hoi ve mot hai ba chiec loai dang hien nay hien tai nay the nhu the nao bn bnh ncc nha cung cap ai sau truoc tren duoi don vi ' +
  'price prices quote quotes quotation of the a an is what how much for from to in on at between latest last recent cheapest lowest highest most expensive average avg compare trend who supplier suppliers since before after vnd dong').split(' '));
// Words that are both filler and item words once the accents are gone (của / cửa, bán / bản / bàn, cái …):
// kept in the search, dropped first when nothing matches.
const PR_SOFT = new Set(['cua', 'ban', 'mua', 'cai', 'loai', 'bo']);
// English item words → the Vietnamese used in the quotations (the data is Vietnamese).
const PR_SYN = { hinge: 'ban le', hinges: 'ban le', door: 'cua', doors: 'cua', fire: 'chong chay', pipe: 'ong', pipes: 'ong', cable: 'cap', wire: 'day dien',
  lock: 'khoa', chair: 'ghe', chairs: 'ghe', table: 'ban', desk: 'ban', lamp: 'den', light: 'den', bulb: 'bong den', valve: 'van', pump: 'bom', fan: 'quat',
  curtain: 'rem', carpet: 'tham', mattress: 'nem', tile: 'gach', paint: 'son', glass: 'kinh', mirror: 'guong', sink: 'chau rua', toilet: 'bon cau',
  faucet: 'voi', tap: 'voi', switch: 'cong tac', socket: 'o cam', insulation: 'bao on', cabinet: 'tu', wardrobe: 'tu', fridge: 'tu lanh', refrigerator: 'tu lanh',
  washer: 'may giat', dishwasher: 'may rua chen', generator: 'may phat dien', elevator: 'thang may', lift: 'thang may', ceiling: 'tran', floor: 'san', wood: 'go', steel: 'thep' };
function prParse(text) {
  const n = prNorm(text), words = n.split(' ');
  const has = re => re.test(n);
  const intent = has(/\b(re nhat|thap nhat|cheapest|lowest|min)\b/) ? 'min' : has(/\b(dat nhat|cao nhat|highest|most expensive|max)\b/) ? 'max'
    : has(/\b(nha cung cap|ncc|who|supplier|ai bao)\b/) ? 'who' : has(/\b(bien dong|xu huong|theo nam|trend|qua cac nam|lich su)\b/) ? 'trend'
    : has(/\b(trung binh|binh quan|average|avg)\b/) ? 'avg' : has(/\b(so sanh|compare)\b/) ? 'compare'
    : has(/\b(bao nhieu bao gia|how many|so luong bao gia|may bao gia)\b/) ? 'count' : 'latest';
  const f = { goods_only: true, limit: 300 };
  const yrs = [...n.matchAll(/\b(20[12]\d)\b/g)].map(m => Number(m[1]));
  if (yrs.length >= 2) { f.year_from = Math.min(...yrs); f.year_to = Math.max(...yrs); }
  else if (yrs.length === 1) {
    if (has(/\b(tu|sau|since|after|from)\s+(nam\s+)?20[12]\d/)) f.year_from = yrs[0];
    else if (has(/\b(truoc|before|den|until)\s+(nam\s+)?20[12]\d/)) f.year_to = yrs[0];
    else { f.year_from = yrs[0]; f.year_to = yrs[0]; }
  }
  if (has(/\b(trung thau|da chot|gia chot|won)\b/)) f.won_only = true;
  const kinds = [];
  if (has(/\b(market check|mc|tham dinh gia)\b/)) kinds.push('mc_hist', 'mc_market');
  if (has(/\b(du thau|tender|ho so thau)\b/)) kinds.push('tender');
  if (has(/\b(po|don dat hang|don hang)\b/)) kinds.push('po');
  if (has(/\b(nhan hang|gia mua thuc te|thuc te)\b/)) kinds.push('intake');
  if (kinds.length) f.kinds = kinds;
  const kw = words.filter(w => w && !PR_STOP.has(w) && !/^20[12]\d$/.test(w) && !['mc', 'po', 'tender', 'won', 'min', 'max'].includes(w)
    && !['trung', 'thau', 'chot', 'check', 'market', 'du', 'thuc', 'te', 'nhan', 'hang', 'dat', 'hang', 'xu', 'huong', 'bien', 'dong', 'lich', 'su', 'qua', 'theo', 'ho', 'so', 'binh', 'quan'].includes(w));
  return { intent, f, kw };
}
async function prAsk(text) {
  const p = prParse(text);
  if (!p.kw.length) return { text: t('pr.bot.noItem') };
  // Try: every word · without the ambiguous words · English words in Vietnamese · then fewer words from the end.
  const tries = [p.kw, p.kw.filter(w => !PR_SOFT.has(w)), p.kw.map(w => PR_SYN[w] || w).join(' ').split(' ')];
  for (let k = p.kw.length - 1; k > 0; k--) tries.push(p.kw.map(w => PR_SYN[w] || w).filter(w => !PR_SOFT.has(w)).slice(0, k));
  let kw = p.kw, rows = [], loose = false, i = 0;
  for (const tr of tries) {
    if (!tr.length) { i++; continue; }
    rows = await prSearch(tr.join(' '), p.f);
    if (rows.length) { kw = tr; loose = i >= 3; break; }
    i++;
  }
  // No won / ordered price: say so, and answer with the others.
  let noWon = false;
  if (!rows.length && p.f.won_only) {
    const f2 = Object.assign({}, p.f); delete f2.won_only;
    for (const tr of tries) { if (!tr.length) continue; rows = await prSearch(tr.join(' '), f2); if (rows.length) { kw = tr; noWon = true; p.f = f2; break; } }
  }
  if (!rows.length) return { text: t('pr.bot.none', { q: p.kw.join(' ') }) };
  const priced = rows.filter(r => r.price_vnd != null && r.line_kind !== 'lump');
  const st = prStats(priced), main = st[0];
  const inMain = priced.filter(r => (r.unit || '—') === (main && main.unit));
  const val = r => Number(r.price_today ?? r.price_vnd);
  let lead = '', pick = [];
  const q = [...new Set(kw)].join(' ');
  if (!priced.length) { lead = t('pr.bot.noPrice', { q, n: rows.length }); pick = rows.slice(0, 5); }
  else if (p.intent === 'min') { pick = inMain.slice().sort((a, b) => val(a) - val(b)).slice(0, 5); lead = t('pr.bot.min', { q, v: prMoney(val(pick[0])), u: main.unit }); }
  else if (p.intent === 'max') { pick = inMain.slice().sort((a, b) => val(b) - val(a)).slice(0, 5); lead = t('pr.bot.max', { q, v: prMoney(val(pick[0])), u: main.unit }); }
  else if (p.intent === 'avg' || p.intent === 'compare') {
    pick = inMain.slice(0, 8);
    lead = t('pr.bot.avg', { q, n: main.n, u: main.unit, med: prMoney(main.med), a: prMoney(main.min), b: prMoney(main.max), avg: prMoney(inMain.reduce((s, r) => s + val(r), 0) / inMain.length) });
  } else if (p.intent === 'who') {
    if (!prFull()) lead = t('pr.bot.whoHidden');
    else {
      const by = new Map();
      for (const r of inMain) { const k = r.supplier || '—'; const o = by.get(k) || { n: 0, min: Infinity, last: '' }; o.n++; o.min = Math.min(o.min, val(r)); if ((r.date || '') > o.last) o.last = r.date || ''; by.set(k, o); }
      const list = [...by].sort((a, b) => a[1].min - b[1].min).slice(0, 8);
      lead = t('pr.bot.who', { q, n: by.size }) + '\n' + list.map(([s, o]) => `• ${s}: ${t('pr.bot.whoLine', { n: o.n, v: prMoney(o.min), d: o.last ? prDate(o.last) : t('pr.noDate') })}`).join('\n');
    }
    pick = inMain.slice().sort((a, b) => val(a) - val(b)).slice(0, 5);
  } else if (p.intent === 'trend') {
    const by = new Map();
    for (const r of inMain.filter(r => r.date)) { const y = String(r.date).slice(0, 4); (by.get(y) || by.set(y, []).get(y)).push(Number(r.price_vnd)); }
    const ys = [...by].sort((a, b) => a[0].localeCompare(b[0]));
    lead = ys.length ? t('pr.bot.trend', { q, u: main.unit }) + '\n' + ys.map(([y, vs]) => `• ${y}: ${t('pr.bot.trendLine', { n: vs.length, med: prMoney(prMedian(vs)), a: prMoney(Math.min(...vs)), b: prMoney(Math.max(...vs)) })}`).join('\n')
      : t('pr.bot.noDates', { q });
    pick = inMain.filter(r => r.date).slice(0, 5);
  } else if (p.intent === 'count') {
    const srcs = new Set(rows.map(r => r.source_id));
    lead = t('pr.bot.count', { q, s: srcs.size, n: rows.length });
    pick = rows.slice(0, 5);
  } else {
    pick = inMain.filter(r => r.date).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
    if (!pick.length) pick = inMain.slice(0, 5);
    const r0 = pick[0];
    lead = t('pr.bot.latest', { q, d: prDate(r0.date), v: prMoney(r0.price_vnd), u: r0.unit || '', today: prMoney(val(r0)) });
  }
  const filt = [p.f.year_from || p.f.year_to ? t('pr.bot.fYears', { a: p.f.year_from || '…', b: p.f.year_to || '…' }) : '', p.f.won_only ? t('pr.wonOnly') : '',
                p.f.kinds ? p.f.kinds.map(k => t('pr.k.' + k)).join(', ') : ''].filter(Boolean).join(' · ');
  return { text: (noWon ? t('pr.bot.noWon', { q }) + '\n' : '') + (loose ? t('pr.bot.loose', { q }) + '\n' : '') + lead + (filt ? `\n(${filt})` : ''), rows: pick, q, stats: main };
}
function prChatTab(body) {
  const box = el('div', { className: 'card prchat' });
  const log = el('div', { className: 'prlog' });
  const inp = el('input', { placeholder: t('pr.chatPh'), spellcheck: false });
  const draw = () => {
    log.innerHTML = '';
    if (!PR.chat.length) log.append(el('div', { className: 'prmsg bot' }, [el('div', { textContent: t('pr.bot.hello') })]));
    for (const m of PR.chat) log.append(prMsg(m));
    log.scrollTop = log.scrollHeight;
  };
  const send = async text => {
    text = (text || inp.value).trim(); if (!text) return;
    inp.value = '';
    PR.chat.push({ me: true, text });
    PR.chat.push({ wait: true }); draw();
    let a;
    try { a = await prAsk(text); } catch (e) { a = { text: prMissing(e) ? t('pr.notInstalled') : e.message }; }
    PR.chat.pop(); PR.chat.push(a); draw();
  };
  inp.onkeydown = e => { if (e.key === 'Enter') send(); };
  const sugg = el('div', { className: 'prsugg' }, ['pr.s1', 'pr.s2', 'pr.s3', 'pr.s4', 'pr.s5'].map(k => el('button', { type: 'button', className: 'btn tiny', textContent: t(k), onclick: () => send(t(k)) })));
  box.append(el('div', { className: 'tdnote', textContent: t('pr.chatHint') }), log, sugg,
    el('div', { className: 'row', style: 'gap:8px;margin-top:8px' }, [inp, el('button', { className: 'btn pri', type: 'button', textContent: t('pr.send'), onclick: () => send() }),
      el('button', { className: 'btn', type: 'button', textContent: t('pr.clear'), onclick: () => { PR.chat = []; draw(); } })]));
  body.append(box);
  draw();
  setTimeout(() => inp.focus(), 0);
}
function prMsg(m) {
  if (m.wait) return el('div', { className: 'prmsg bot dim', textContent: '…' });
  if (m.me) return el('div', { className: 'prmsg me', textContent: m.text });
  const full = prFull();
  const node = el('div', { className: 'prmsg bot' }, [el('div', { className: 'prtext', textContent: m.text })]);
  if (m.rows && m.rows.length) {
    const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['pr.c.date', 'pr.c.item', 'pr.c.qty', 'pr.c.net', 'pr.c.today', ...(full ? ['pr.c.supplier'] : []), 'pr.c.project']
      .map(k => el('th', { textContent: t(k) })))]);
    for (const r of m.rows) {
      const link = full ? prFileLink(r) : null;
      tb.append(el('tr', { className: r.won ? 'prwon' : '' }, [el('td', { textContent: prDate(r.date) }),
        el('td', { className: 'aowrap' }, [document.createTextNode(r.name_std || r.name), r.brand || r.model ? el('div', { className: 'dim', textContent: [r.brand, r.model].filter(Boolean).join(' · ') }) : '']),
        el('td', { className: 'num', textContent: `${r.qty != null ? fmtNum(r.qty) : ''} ${r.unit || ''}` }), el('td', { className: 'num', textContent: prMoney(r.price_vnd) }),
        el('td', { className: 'num', textContent: prMoney(r.price_today) }),
        ...(full ? [el('td', { className: 'aowrap' }, link ? el('a', { href: link, target: '_blank', rel: 'noopener', textContent: r.supplier || r.ref || '↗' }) : document.createTextNode(r.supplier || ''))] : []),
        el('td', { className: 'aowrap', textContent: r.project_name || r.project_code || '' })]));
    }
    node.append(el('div', { className: 'wrap' }, tb));
  }
  if (m.q) node.append(el('button', { className: 'btn tiny', type: 'button', textContent: t('pr.bot.more'), onclick: () => { PR.q = m.q; PR.tab = 'search'; prRun(); } }));
  return node;
}

/* ------------------------------------------------------------ sources (AM team) */
async function prLoadSources() {
  const [src, lines] = await Promise.all([pmSelectAll('pr_source', 'select=*&order=id.desc'), pmSelectAll('pr_line', 'select=source_id,price_vnd')]);
  const n = new Map(), p = new Map();
  for (const l of lines) { n.set(l.source_id, (n.get(l.source_id) || 0) + 1); if (l.price_vnd != null) p.set(l.source_id, (p.get(l.source_id) || 0) + 1); }
  PR.sources = src.map(s => Object.assign(s, { n_lines: n.get(s.id) || 0, n_priced: p.get(s.id) || 0 }));
}
function prSourcesTab(body) {
  if (PR.open) return prSourceDetail(body);
  const q = el('input', { value: PR.srcQ, placeholder: t('pm.f.search'), spellcheck: false });
  q.oninput = () => { PR.srcQ = q.value; clearTimeout(PR.qt); PR.qt = setTimeout(prRender, 250); };
  const kind = el('select'); selFill(kind, [['', t('pm.f.all')], ['nodate', t('pr.noDateOnly')], ...PR_KINDS.map(k => [k, t('pr.k.' + k)])]); kind.value = PR.srcKind;
  kind.onchange = () => { PR.srcKind = kind.value; prRender(); };
  body.append(el('div', { className: 'card row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' }, [
    el('div', { className: 'fld', style: 'max-width:320px' }, [el('label', { textContent: t('pm.f.search') }), q]),
    el('div', { className: 'fld', style: 'max-width:220px' }, [el('label', { textContent: t('pr.c.kind') }), kind]), el('span', { style: 'flex:1' }),
    el('button', { className: 'btn pri', type: 'button', textContent: '+ ' + t('pr.newQuote'), onclick: () => { PR.draft = prBlank(); PR.tab = 'import'; prRender(); } })]));
  const qq = prNorm(PR.srcQ);
  let rows = PR.sources.filter(s => (!PR.srcKind || (PR.srcKind === 'nodate' ? !s.quote_date : s.kind === PR.srcKind))
    && (!qq || prNorm(`${s.ref} ${s.supplier} ${s.project_code} ${s.project_name} ${s.file_name}`).includes(qq)));
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, ['pr.c.ref', 'pr.c.kind', 'pr.c.date', 'pr.c.supplier', 'pr.c.project', 'pr.c.lines', 'pr.c.won'].map(k => el('th', { textContent: t(k) })))]);
  for (const s of rows.slice(0, 800)) tb.append(el('tr', { className: 'aoclick', onclick: () => { PR.open = s.id; prRender(); } }, [
    el('td', {}, el('code', { textContent: s.ref || '#' + s.id })), el('td', {}, prKindChip(s.kind)), el('td', { className: s.quote_date ? '' : 'dim', textContent: prDate(s.quote_date) }),
    el('td', { className: 'aowrap', textContent: s.supplier || '' }), el('td', { className: 'aowrap', textContent: [s.project_code, s.project_name].filter(Boolean).join(' — ') }),
    el('td', { className: 'num', textContent: `${fmtInt(s.n_priced)} / ${fmtInt(s.n_lines)}` }),
    el('td', { textContent: s.won == null ? '' : s.won ? '✓' : '✗' })]));
  if (rows.length > 800) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'dim', textContent: t('acc.more', { n: fmtInt(rows.length - 800) }) })));
  if (!rows.length) tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'dim', style: 'padding:14px', textContent: t('lq.none') })));
  body.append(el('div', { className: 'card' }, el('div', { className: 'wrap' }, tb)));
}
async function prSourceDetail(body) {
  const s = PR.sources.find(x => x.id === PR.open);
  if (!s) { PR.open = null; return prRender(); }
  const lines = await SB.select('pr_line', `select=*&source_id=eq.${s.id}&order=line_no,id`);
  const manual = ['legacy', 'quote', 'market'].includes(s.kind) && prEdit();
  const src = Object.assign({}, s), ls = lines.map(l => ({ section: l.section, name: l.name_raw, name_std: l.name_std, brand: l.brand, model: l.model, origin: l.origin,
    spec: l.spec, qty: l.qty, unit: l.unit_raw, unit_price: l.unit_price, labor_price: l.labor_price, vat_rate: l.vat_rate, note: l.note, uncertain: l.uncertain }));
  const out = el('div');
  const head = el('div', { className: 'chead' }, [el('h2', { textContent: `${s.ref || '#' + s.id} — ${t('pr.k.' + s.kind)}` }),
    el('button', { className: 'btn', type: 'button', textContent: '‹ ' + t('pr.back'), onclick: () => { PR.open = null; prRender(); } })]);
  const auto = !['legacy', 'quote', 'market'].includes(s.kind);
  const docId = auto ? Number(String(s.origin_key || '').split(':')[1]) : null;
  body.append(el('div', { className: 'card' }, [head,
    auto ? el('div', { className: 'msg info' }, [document.createTextNode(t('pr.autoNote') + ' '),
      ['qc', 'mc_hist', 'mc_market', 'po'].includes(s.kind) && docId ? el('a', { href: '#', textContent: t('pr.openDoc'), onclick: e => { e.preventDefault(); wfOpen(docId); } }) : '']) : '',
    prEditor(src, ls, manual, out, async () => {
      try { await SB.rpc('pr_save_source', { p_source: src, p_lines: ls }); PR.flash = t('ao.saved'); await prLoadSources(); msg('#prMsg', 'ok', PR.flash); PR.flash = null; prRender(); }
      catch (e) { prErr(out, e); } },
      manual ? async () => { if (!confirm(t('pr.delQ', { r: s.ref || s.id }))) return;
        try { await SB.rpc('pr_delete_source', { p_id: s.id }); PR.open = null; await prLoadSources(); prRender(); } catch (e) { prErr(out, e); } } : null), out]));
}
// The editor of one source: its facts and its lines. Used for a new quotation from JSON and for editing a manual source.
function prEditor(src, ls, editable, out, onSave, onDelete) {
  const wrap = el('div');
  const f = (k, label, type = 'text', w = '220px') => {
    const i = type === 'check' ? el('input', { type: 'checkbox', checked: !!src[k], disabled: !editable }) : type === 'area' ? el('textarea', { value: src[k] ?? '', disabled: !editable, rows: 2 }) : el('input', { type, value: src[k] ?? '', disabled: !editable });
    i.onchange = () => { src[k] = type === 'check' ? i.checked : type === 'number' ? (i.value === '' ? null : Number(i.value)) : i.value; };
    return type === 'check' ? el('label', { className: 'chk' }, [i, el('span', { textContent: label })]) : el('div', { className: 'fld', style: `max-width:${w}` }, [el('label', { textContent: label }), i]);
  };
  const won = el('select', { disabled: !editable }); selFill(won, [['', t('pr.wonUnknown')], ['true', t('pr.won')], ['false', t('pr.lost')]]);
  won.value = src.won == null ? '' : String(src.won); won.onchange = () => { src.won = won.value === '' ? null : won.value === 'true'; };
  wrap.append(el('div', { className: 'row', style: 'gap:10px;flex-wrap:wrap;align-items:flex-end' }, [
    f('ref', t('pr.c.ref'), 'text', '180px'), f('supplier', t('pr.c.supplier'), 'text', '320px'), f('contact', t('pr.f.contact'), 'text', '240px'),
    f('quote_date', t('pr.c.date'), 'date', '170px'), f('project_code', t('pm.col.code'), 'text', '170px'), f('project_name', t('pr.c.project'), 'text', '300px'),
    f('currency', t('pr.f.currency'), 'text', '90px'), f('fx_rate', t('pr.f.fx'), 'number', '110px'), f('vat_included', t('pr.f.vatIncl'), 'check'),
    el('div', { className: 'fld', style: 'max-width:170px' }, [el('label', { textContent: t('pr.c.won') }), won])]),
    el('div', { className: 'row', style: 'gap:10px;flex-wrap:wrap;align-items:flex-end' }, [f('file_name', t('pr.f.fileName'), 'text', '240px'), f('file_url', t('pr.f.fileUrl'), 'text', '460px')]),
    el('div', { className: 'row', style: 'gap:10px;flex-wrap:wrap;align-items:flex-end' }, [f('delivery_term', t('pr.f.delivery'), 'text', '300px'), f('install_term', t('pr.f.install'), 'text', '300px'),
      f('payment_term', t('pr.f.payment'), 'text', '300px')]), f('note', t('pr.f.note'), 'area', '100%'));
  // Lines: an editable grid (name, qty, unit, prices, brand, model, section); uncertain fields flagged.
  const cols = [['section', 'pr.c.section', 140], ['name', 'pr.c.item', 280], ['brand', 'pr.c.brandOnly', 110], ['model', 'pr.c.model', 110], ['qty', 'pr.c.qtyN', 70, 1],
                ['unit', 'pr.c.unit', 70], ['unit_price', 'pr.c.price', 120, 1], ['labor_price', 'pr.c.labor', 110, 1], ['note', 'pr.f.note', 160]];
  const tb = el('table', { className: 'lqbt preditor' }, [el('tr', {}, [...cols.map(c => el('th', { className: c[3] ? 'num' : '', textContent: t(c[1]) })), el('th', { textContent: '' })])]);
  ls.forEach((l, i) => {
    const unc = new Set((l.uncertain || []).map(String));
    tb.append(el('tr', {}, [...cols.map(([k, , w, isNum]) => {
      const v = l[k];
      const inp = el('input', { value: v == null ? '' : isNum ? fmtNum(v) : v, disabled: !editable, style: `width:${w}px`, className: (isNum ? 'num' : '') + (unc.has(k) ? ' prunc' : '') });
      if (unc.has(k)) inp.title = t('pr.uncertain');
      inp.onchange = () => { l[k] = isNum ? (inp.value.trim() === '' ? null : numIn(inp.value)) : inp.value; };
      return el('td', {}, inp); }),
      el('td', {}, editable ? el('button', { className: 'btn tiny', type: 'button', textContent: '✕', onclick: () => { ls.splice(i, 1); wrap.replaceWith(prEditor(src, ls, editable, out, onSave, onDelete)); } }) : '')]));
  });
  wrap.append(el('h3', { textContent: t('pr.linesH', { n: ls.length }) }), el('div', { className: 'wrap' }, tb));
  if (editable) wrap.append(el('div', { className: 'row', style: 'gap:8px;margin-top:10px;flex-wrap:wrap' }, [
    el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('pr.addLine'), onclick: () => { ls.push({ qty: 1 }); const n = prEditor(src, ls, editable, out, onSave, onDelete); wrap.replaceWith(n); } }),
    el('span', { style: 'flex:1' }),
    onDelete ? el('button', { className: 'btn', type: 'button', textContent: t('pr.del'), onclick: onDelete }) : '',
    el('button', { className: 'btn pri', type: 'button', textContent: t('ao.save'), onclick: onSave })]));
  return wrap;
}

/* ------------------------------------------------------------ import */
const prBlank = () => ({ src: { kind: 'quote', ref: '', supplier: '', quote_date: '', currency: 'VND', fx_rate: 1, vat_included: false, won: null }, lines: [] });

/* The instructions handed to Claude with the quotation PDF / picture (paste-in
   path, like the delivery notes: the answer is pasted back as JSON). Kept to
   what is printed; the app normalises units and works out the comparable price. */
const PR_PROMPT = `You are reading one or more supplier QUOTATIONS ("báo giá") for a hotel's technical materials and FF&E. Extract ONLY what is printed and return JSON.

OUTPUT: a single JSON object, no prose, no markdown fence:

{"quotes":[{
  "quote_no": string|null,
  "quote_date": "YYYY-MM-DD"|null,
  "supplier": string|null,
  "contact": string|null,            // email / phone / person, as printed
  "project": string|null,            // project / job the quotation is for, if printed
  "currency": "VND"|"USD"|...,
  "vat_included": true|false,        // are the UNIT PRICES printed inclusive of VAT?
  "vat_rate": number|null,           // 0.08, 0.1 …
  "delivery_term": string|null,
  "installation_term": string|null,
  "payment_term": string|null,
  "validity": string|null,
  "lines":[{
    "section": string|null,          // the heading the line sits under (e.g. "Cửa đi 2 cánh EI60", "Phụ kiện")
    "name": string,                  // the item exactly as printed, Vietnamese kept
    "brand": string|null,
    "model": string|null,
    "origin": string|null,
    "spec": {"size": string|null, "capacity": string|null, "material": string|null, "color": string|null, "other": string|null},
    "qty": number|null,
    "unit": string|null,             // as printed: cái, bộ, m2, m, gói, lô …
    "unit_price": number|null,       // MATERIAL / goods unit price, as printed (no thousands separators)
    "labor_price": number|null,      // separate installation / labour UNIT price if the quotation has that column
    "note": string|null,
    "uncertain": [string]            // names of the fields you are not sure about
  }]
}]}

RULES
1. One file may hold several quotations (several suppliers or versions): one object each, never merged.
2. Numbers are numbers: 1.250.000 → 1250000; no currency symbols.
3. A line that is only a heading (no quantity, no price) is NOT a line: put its text in "section" of the lines below it.
4. Installation / transport / management fees printed as their own lines are lines (their name says what they are).
5. If the unit price is not printed but the amount and quantity are, leave unit_price null and write the amount in "note".
6. Do not translate, do not guess, do not fill in what is not printed; list doubtful fields in "uncertain".`;

function prImportTab(body) {
  const ov = PR.ov || {};
  // 1. Sync from the app
  const syncOut = el('div');
  body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('pr.syncH') }), el('div', { className: 'tdnote', textContent: t('pr.syncHint') }),
    el('div', { className: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap' }, [
      el('button', { className: 'btn pri', type: 'button', textContent: t('pr.sync'), onclick: async e => {
        e.target.disabled = true;
        try { const r = await SB.rpc('pr_sync'); msg(syncOut, 'ok', t('pr.synced', { qc: r.qc || 0, mc: r.mc || 0, po: r.po || 0, td: r.tender || 0, in: r.intake || 0 })); PR.ov = await SB.rpc('pr_overview'); }
        catch (er) { prErr(syncOut, er); } finally { e.target.disabled = false; } } }),
      el('span', { className: 'dim', textContent: ov.last_sync ? t('pr.lastSync', { d: fmtDateTime(ov.last_sync) }) : t('pr.neverSync') })]), syncOut]));
  // 2. New quotation through the AI prompt
  const jsOut = el('div'), ta = el('textarea', { rows: 6, placeholder: t('pr.jsonPh'), spellcheck: false, className: 'prjson' });
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('pr.jsonH') }), el('div', { className: 'tdnote', textContent: t('pr.jsonHint') }),
    el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap;margin:6px 0' }, [
      el('button', { className: 'btn', type: 'button', textContent: t('pr.copyPrompt'), onclick: async () => {
        try { await navigator.clipboard.writeText(PR_PROMPT); msg(jsOut, 'ok', t('pr.copied')); } catch { msg(jsOut, 'warn', t('pr.copyFail')); ta.value = PR_PROMPT; } } }),
      el('button', { className: 'btn', type: 'button', textContent: t('pr.blank'), onclick: () => { PR.draft = prBlank(); PR.drafts = []; prRender(); } })]),
    ta, el('div', { className: 'row', style: 'gap:8px;margin-top:6px' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('pr.readJson'), onclick: () => {
      try { PR.drafts = prFromJson(ta.value); PR.draft = PR.drafts.shift() || null; if (!PR.draft) throw new Error(t('pr.jsonEmpty')); prRender(); }
      catch (e) { msg(jsOut, 'err', t('pr.jsonBad', { e: e.message })); } } })]), jsOut]);
  body.append(card);
  if (PR.draft) {
    const d = PR.draft, out = el('div');
    body.append(el('div', { className: 'card prdraft' }, [el('h2', { textContent: t('pr.reviewH') + (PR.drafts.length ? ` (${t('pr.moreDrafts', { n: PR.drafts.length })})` : '') }),
      el('div', { className: 'tdnote', textContent: t('pr.reviewHint') }),
      prEditor(d.src, d.lines, true, out, async () => {
        try {
          if (!d.lines.length) throw new Error(t('pr.noLines'));
          await SB.rpc('pr_save_source', { p_source: d.src, p_lines: d.lines });
          PR.flash = t('pr.savedQuote', { n: d.lines.length });
          PR.draft = PR.drafts.shift() || null;
          PR.ov = await SB.rpc('pr_overview'); msg('#prMsg', 'ok', PR.flash); PR.flash = null; prRender();
        } catch (e) { prErr(out, e); } }, () => { PR.draft = PR.drafts.shift() || null; prRender(); }), out]));
  }
  // 3. The old workbook
  const xOut = el('div'), file = el('input', { type: 'file', accept: '.xlsx,.xls' });
  file.onchange = () => prLegacyRead(file.files[0], xOut);
  body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('pr.legacyH') }), el('div', { className: 'tdnote', textContent: t('pr.legacyHint') }), file, xOut,
    el('div', { className: 'dim', style: 'margin-top:8px', textContent: t('pr.overview', { src: fmtInt(Object.values(ov.by_kind || {}).reduce((a, x) => a + x.sources, 0)),
      ln: fmtInt(Object.values(ov.by_kind || {}).reduce((a, x) => a + x.lines, 0)), nd: fmtInt(ov.no_date || 0), ns: fmtInt(ov.no_std || 0) }) })]));
}
function prFromJson(text) {
  let s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const j = JSON.parse(s);
  const quotes = Array.isArray(j) ? j : j.quotes || (j.lines ? [j] : []);
  return quotes.map(q => ({
    src: { kind: 'quote', ref: q.quote_no || '', supplier: q.supplier || '', contact: q.contact || '', quote_date: /^\d{4}-\d{2}-\d{2}$/.test(q.quote_date || '') ? q.quote_date : '',
           project_name: q.project || '', currency: (q.currency || 'VND').toUpperCase(), fx_rate: 1, vat_included: !!q.vat_included, won: null,
           delivery_term: q.delivery_term || '', install_term: q.installation_term || '', payment_term: q.payment_term || '', note: q.validity ? `Hiệu lực: ${q.validity}` : '' },
    lines: (q.lines || []).filter(l => l && l.name).map(l => ({ section: l.section || null, name: l.name, brand: l.brand || null, model: l.model || null, origin: l.origin || null,
      spec: Object.fromEntries(Object.entries(l.spec || {}).filter(([, v]) => v != null && v !== '')), qty: l.qty ?? null, unit: l.unit || null,
      unit_price: l.unit_price ?? null, labor_price: l.labor_price ?? null, vat_rate: q.vat_rate ?? null, note: l.note || null, uncertain: l.uncertain || [] }))
  }));
}

/* The "Reference Pricing List (Supplier)" workbook: sheet Master Data, header
   row with "#" and "Nguồn/ Source", a numbering row under it, lines from there.
   A row without "#" is a heading (it becomes the section of the lines below).
   Each "Báo giá (n)" is one quotation; its file is "Báo giá (n).pdf". */
async function prLegacyRead(file, out) {
  if (!file) return;
  try {
    msg(out, 'info', t('acc.reading', { f: file.name }));
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets['Master Data'] || wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const hi = grid.findIndex(r => r && String(r[0] || '').trim() === '#' && /ngu[oồ]n|source/i.test(String(r[1] || '')));
    if (hi < 0) throw new Error(t('pr.legacyNoHead'));
    const head = grid[hi].map(h => String(h || '').replace(/\s+/g, ' ').trim());
    const col = re => head.findIndex(h => re.test(h));
    const C = { no: 0, src: 1, date: 2, proj: 3, item: 4, qty: 5, unit: 6, price: 7, amount: 8, labor: 9, laborAmt: 10, cur: col(/ti[eề]n t[eệ]|currency/i),
                origin: col(/qu[oố]c gia|region/i), maker: col(/nh[aà] s[aả]n xu[aấ]t|manufacturer/i), brand: col(/th[uư][oơ]ng hi[eệ]u|brand/i),
                serial: col(/seri|serial/i), part: col(/part/i), model: col(/s[oố] hi[eệ]u|model/i), supplier: col(/nh[aà] cung c[aấ]p|supplier/i),
                email: col(/email/i), phone: col(/[dđ]i[eệ]n tho[aạ]i|phone/i), deliv: col(/giao h[aà]ng|delivery/i), inst: col(/l[aắ]p [dđ][aặ]t|installation/i),
                pay: col(/thanh to[aá]n|payment/i) };
    const specCols = head.map((h, i) => [h, i]).filter(([h, i]) => i > C.model && i < C.supplier && h).map(([h, i]) => [h.split('/').pop().trim() || h, i]);
    const num = v => v == null || v === '' ? null : typeof v === 'number' ? v : (() => { const x = numIn(String(v)); return isFinite(x) ? x : null; })();
    const txt = v => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    const isoOf = v => typeof v === 'number' && v > 20000 && v < 80000 ? new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) : null;
    const quotes = new Map();
    // A heading applies to the lines under it, within one quotation; a new quotation starts without one
    // unless a heading row sits right above its first line.
    let heading = null, fresh = false, lastRef = null;
    for (let i = hi + 2; i < grid.length; i++) {
      const r = grid[i]; if (!r) continue;
      const no = txt(r[C.no]), ref = txt(r[C.src]), name = txt(r[C.item]) || txt(r[C.proj]);
      if (!ref) { if (!no && txt(r[C.proj])) { heading = txt(r[C.proj]); fresh = true; } continue; }
      if (!name) continue;
      if (ref !== lastRef && !fresh) heading = null;
      fresh = false; lastRef = ref;
      let q = quotes.get(ref);
      if (!q) { q = { ref, supplier: '', contact: '', quote_date: null, project_name: heading || '', delivery_term: '', install_term: '', payment_term: '', file_name: ref + '.pdf', lines: [] }; quotes.set(ref, q); }
      if (!q.supplier && txt(r[C.supplier])) q.supplier = txt(r[C.supplier]);
      if (!q.contact) q.contact = [txt(r[C.email]), txt(r[C.phone])].filter(Boolean).join(' · ');
      if (!q.quote_date) q.quote_date = isoOf(r[C.date]);
      for (const [k, c] of [['delivery_term', C.deliv], ['install_term', C.inst], ['payment_term', C.pay]]) if (!q[k] && c >= 0 && txt(r[c])) q[k] = txt(r[c]);
      const qty = num(r[C.qty]);
      let price = num(r[C.price]), labor = num(r[C.labor]);
      if (price == null && num(r[C.amount]) && qty) price = Math.round(num(r[C.amount]) / qty);
      if (labor == null && num(r[C.laborAmt]) && qty) labor = Math.round(num(r[C.laborAmt]) / qty);
      const spec = {};
      for (const [h, c] of specCols) { const v = txt(r[c]); if (v && v !== '-') spec[h] = v; }
      if (C.maker >= 0 && txt(r[C.maker])) spec.Manufacturer = txt(r[C.maker]);
      if (C.serial >= 0 && txt(r[C.serial]) && txt(r[C.serial]) !== '-') spec.Serial = txt(r[C.serial]);
      if (C.part >= 0 && txt(r[C.part]) && txt(r[C.part]) !== '-') spec.Part = txt(r[C.part]);
      q.lines.push({ line_no: q.lines.length + 1, section: heading && heading !== name ? heading : null, name, qty, unit: txt(r[C.unit]) || null, unit_price: price,
                     labor_price: labor || null, brand: txt(r[C.brand]) || null, model: txt(r[C.model]) || null, origin: txt(r[C.origin]) || null, spec });
    }
    const list = [...quotes.values()];
    const nl = list.reduce((a, q) => a + q.lines.length, 0), np = list.reduce((a, q) => a + q.lines.filter(l => l.unit_price != null || l.labor_price != null).length, 0);
    const nd = list.filter(q => !q.quote_date).length;
    out.innerHTML = '';
    out.append(el('div', { className: 'msg info', textContent: t('pr.legacyRead', { q: fmtInt(list.length), n: fmtInt(nl), p: fmtInt(np), d: fmtInt(nd), s: fmtInt(new Set(list.map(q => prNorm(q.supplier)).filter(Boolean)).size) }) }),
      el('button', { className: 'btn pri', type: 'button', textContent: t('pr.legacyGo'), onclick: async e => {
        e.target.disabled = true;
        let imp = null, done = 0;
        try {
          for (let i = 0; i < list.length; i += 25) {
            msg(out, 'info', t('pr.legacyWorking', { n: fmtInt(done), of: fmtInt(list.length) }));
            const r = await SB.rpc('pr_import_legacy', { p_import: imp, p_file: file.name, p_sources: list.slice(i, i + 25) });
            imp = r.import; done += r.sources;
          }
          msg(out, 'ok', t('pr.legacyDone', { q: fmtInt(done), n: fmtInt(nl) }));
          PR.ov = await SB.rpc('pr_overview');
        } catch (er) { prErr(out, er); e.target.disabled = false; }
      } }));
  } catch (e) { msg(out, 'err', e.message); }
}

/* ------------------------------------------------------------ Market Check helper
   On an MC being filled in: the stored prices matching each line, with buttons
   to take one as the historical price (B: price then + year + reference) or the
   market price (C: today's value + spec / source). */
const PRMC = { open: false, cache: new Map() };
function prMcButton(box) {
  if (!window.SB || !can('price', 'view')) return;
  box.append(el('div', { className: 'row', style: 'gap:8px;align-items:center' }, [
    el('button', { className: 'btn tiny', type: 'button', textContent: (PRMC.open ? '▾ ' : '▸ ') + t('pr.mc.btn'), onclick: () => { PRMC.open = !PRMC.open; wfWarnRender(); } }),
    el('span', { className: 'dim', textContent: t('pr.mc.hint') })]));
  if (!PRMC.open) return;
  const panel = el('div', { className: 'card prmc', textContent: t('table.loading') });
  box.append(panel);
  prMcFill(panel).catch(e => { panel.textContent = ''; prErr(panel, e); });
}
async function prMcFill(panel) {
  const d = WF.data || {}, lines = (d.lines || []).filter(l => (l.item || '').trim());
  panel.innerHTML = '';
  if (!lines.length) { panel.append(el('div', { className: 'dim', textContent: t('pr.mc.noLines') })); return; }
  const redraw = () => { wfMarkDirty(); const s = $('#wdSheet'); if (s && s.firstChild) s.firstChild.replaceWith(fsSheet(WF.doc.doc_type, wfEditable())); wfWarnRender(); };
  for (const l of lines) {
    const key = prNorm(l.item);
    let rows = PRMC.cache.get(key);
    if (!rows) {
      const words = key.split(' ').filter(w => w.length > 1).slice(0, 5);
      rows = [];
      for (let n = words.length; n > 0 && !rows.length; n--) rows = await prSearch(words.slice(0, n).join(' '), { goods_only: true, limit: 8 });
      PRMC.cache.set(key, rows);
    }
    const tb = el('table', { className: 'lqbt' });
    for (const r of rows.filter(r => r.price_vnd != null).slice(0, 5)) {
      const yr = r.date ? Number(String(r.date).slice(0, 4)) : null;
      tb.append(el('tr', {}, [el('td', { textContent: prDate(r.date) }), el('td', { className: 'aowrap', textContent: [r.name_std || r.name, r.brand, r.model].filter(Boolean).join(' · ') }),
        el('td', { className: 'num', textContent: `${prMoney(r.price_vnd)} / ${r.unit || ''}` }), el('td', { className: 'num', textContent: prMoney(r.price_today) }),
        el('td', { className: 'aowrap', textContent: r.supplier || t('pr.k.' + r.kind) }),
        el('td', { className: 'nowrap' }, [
          el('button', { className: 'btn tiny', type: 'button', textContent: '→ B', title: t('pr.mc.toB'), disabled: !yr || !wfEditable(), onclick: () => {
            Object.assign(l, { b_pv: Math.round(Number(r.price_vnd)), b_year: yr, b_ref: [r.ref, r.supplier || t('pr.k.' + r.kind), r.project_code].filter(Boolean).join(' · ') }); redraw(); } }),
          el('button', { className: 'btn tiny', type: 'button', textContent: '→ C', title: t('pr.mc.toC'), disabled: !wfEditable(), onclick: () => {
            Object.assign(l, { c_price: Math.round(Number(r.price_today ?? r.price_vnd)), c_spec: [r.brand, r.model, r.supplier || t('pr.k.' + r.kind), prDate(r.date)].filter(Boolean).join(' · ') }); redraw(); } })])]));
    }
    panel.append(el('div', { className: 'prmcline' }, [el('b', { textContent: `${l.item} · ${fmtNum(l.qty)} ` }),
      rows.some(r => r.price_vnd != null) ? el('div', { className: 'wrap' }, tb) : el('div', { className: 'dim', textContent: t('pr.mc.none') })]));
  }
}

/* ------------------------------------------------------------ standard names (AM team)
   Every price line gets a standard name "VI/EN" from the vocabulary (pr_term):
   the earliest keyword in its name, after the verbs at the start ("cung cấp và
   lắp đặt", "thay"…); a line that is only specs takes its heading's. Measured on
   the old workbook: 96.8% of 2,554 lines named. Here the AM team names what is
   left, checks what the rules did, and keeps the vocabulary. A name given by
   hand is remembered for every line with the same original name, now and later. */
const PR_SRC = ['rule', 'alias', 'manual', 'none'];
async function prStdLoad(force) {
  if (PR.std.lines && !force) return;
  await prTerms(true);
  PR.std.lines = await pmSelectAll('pr_line', 'select=id,source_id,name_raw,name_std,term_id,std_src,grp,line_kind,section,variant&order=id');
}
function prStdTab(body) {
  const S = PR.std, out = el('div');
  if (!S.lines) { body.append(el('div', { className: 'card dim', textContent: t('table.loading') })); prStdLoad().then(() => prRender()).catch(e => prErr('#prMsg', e)); return; }
  const L = S.lines, cmp = L.filter(l => l.line_kind !== 'other');
  const by = k => cmp.filter(l => (l.std_src || 'none') === k).length;
  const named = cmp.filter(l => l.name_std).length;
  const edit = prEdit();
  const rerun = el('button', { className: 'btn', type: 'button', textContent: t('pr.std.rerun'), disabled: !edit, onclick: async () => {
    if (!confirm(t('pr.std.rerunQ'))) return;
    rerun.disabled = true;
    try {
      let r = await SB.rpc('pr_std_run', { p_reset: true, p_limit: 800 });
      while (r.left > 0) { msg(out, 'info', t('pr.std.running', { n: fmtInt(r.left) })); r = await SB.rpc('pr_std_run', { p_reset: false, p_limit: 800 }); }
      await prStdLoad(true); PR.flash = t('pr.std.rerunDone'); msg('#prMsg', 'ok', PR.flash); PR.flash = null; prRender();
    } catch (e) { prErr(out, e); rerun.disabled = false; } } });
  body.append(el('div', { className: 'card' }, [
    el('div', { className: 'prstats' }, [
      el('div', { className: 'aokpi' }, [el('small', { textContent: t('pr.std.named') }), el('b', { textContent: cmp.length ? Math.round(named / cmp.length * 1000) / 10 + '%' : '—' }),
        el('span', { textContent: t('pr.std.namedOf', { n: fmtInt(named), of: fmtInt(cmp.length) }) })]),
      ...PR_SRC.map(k => el('div', { className: 'aokpi' + (k === 'none' && by(k) ? ' warn' : '') }, [el('small', { textContent: t('pr.std.src.' + k) }), el('b', { textContent: fmtInt(by(k)) })]))]),
    el('div', { className: 'tdnote', textContent: t('pr.std.hint') }), out,
    el('div', { className: 'row', style: 'gap:8px;flex-wrap:wrap' }, [rerun])]));
  const tabs = el('div', { className: 'seg permtabs' });
  aoTabs(tabs, [['none', t('pr.std.t.none'), by('none')], ['review', t('pr.std.t.review'), null], ['vocab', t('pr.std.t.vocab'), (PR.terms || []).length]], S.tab,
    v => { S.tab = v; S.sel.clear(); prRender(); });
  body.append(el('div', { className: 'card' }, tabs));
  if (S.tab === 'none') return prStdNone(body, cmp.filter(l => (l.std_src || 'none') === 'none'), edit);
  if (S.tab === 'review') return prStdReview(body, cmp, edit);
  return prStdVocab(body, edit);
}
// Lines of the same original name, together: one row per name.
function prStdGroups(lines) {
  const m = new Map();
  for (const l of lines) { const k = prNorm(l.name_raw); const o = m.get(k) || { name: l.name_raw, ids: [], section: l.section, src: new Set(), std: l.name_std }; o.ids.push(l.id); o.src.add(l.std_src || 'none'); m.set(k, o); }
  return [...m.values()].sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name));
}
function prStdTable(groups, box, edit) {
  const S = PR.std, qq = prNorm(S.q);
  const rows = groups.filter(g => !qq || prNorm(`${g.name} ${g.section || ''} ${g.std || ''}`).includes(qq));
  const all = el('input', { type: 'checkbox', checked: rows.length > 0 && rows.every(g => g.ids.every(i => S.sel.has(i))) });
  all.onchange = () => { for (const g of rows.slice(0, 500)) for (const i of g.ids) all.checked ? S.sel.add(i) : S.sel.delete(i); prRender(); };
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, [el('th', {}, edit ? all : ''), ...['pr.std.c.name', 'pr.std.c.n', 'pr.std.c.std', 'pr.c.section'].map(k => el('th', { textContent: t(k) }))])]);
  for (const g of rows.slice(0, 500)) {
    const cb = el('input', { type: 'checkbox', checked: g.ids.every(i => S.sel.has(i)) });
    cb.onchange = () => { for (const i of g.ids) cb.checked ? S.sel.add(i) : S.sel.delete(i); prRender(); };
    tb.append(el('tr', {}, [el('td', {}, edit ? cb : ''), el('td', { className: 'aowrap', textContent: g.name }), el('td', { className: 'num', textContent: fmtInt(g.ids.length) }),
      el('td', {}, [document.createTextNode(g.std || '—'), ...[...g.src].filter(x => x !== 'none').map(x => el('span', { className: 'prsrc s-' + x, textContent: t('pr.std.src.' + x) }))]),
      el('td', { className: 'aowrap dim', textContent: g.section || '' })]));
  }
  if (rows.length > 500) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'dim', textContent: t('acc.more', { n: fmtInt(rows.length - 500) }) })));
  if (!rows.length) tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'dim', style: 'padding:12px', textContent: t('lq.none') })));
  box.append(el('div', { className: 'wrap' }, tb));
}
async function prStdAssign(name, out) {
  const ids = [...PR.std.sel];
  if (!ids.length) return;
  try {
    await SB.rpc('pr_set_std', { p_lines: ids, p_std: name === '' ? null : name, p_category: null });
    PR.std.sel.clear(); await prStdLoad(true);
    PR.flash = name === '' ? t('pr.std.cleared') : t('pr.std.assigned', { n: fmtInt(ids.length), s: name }); msg('#prMsg', 'ok', PR.flash); PR.flash = null; prRender();
  } catch (e) { prErr(out, e); }
}
function prStdTools(box, edit, extra) {
  const S = PR.std, out = el('div');
  const q = el('input', { placeholder: t('pm.f.search'), value: S.q, spellcheck: false });
  q.oninput = () => { S.q = q.value; clearTimeout(S.qt); S.qt = setTimeout(prRender, 250); };
  box.append(el('div', { className: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, [
    el('div', { style: 'max-width:280px;flex:1' }, q), ...(extra || []), el('span', { style: 'flex:1' }),
    edit ? el('span', { className: 'dim', textContent: t('pr.std.ticked', { n: fmtInt(S.sel.size) }) }) : '',
    edit ? prStdPicker(t('pr.assign'), v => prStdAssign(v, out), !S.sel.size) : '']), out);
  return out;
}
function prStdNone(body, lines, edit) {
  const card = el('div', { className: 'card' }, [el('h3', { textContent: t('pr.std.noneH') }), el('div', { className: 'tdnote', textContent: t('pr.std.noneHint') })]);
  const out = prStdTools(card, edit, [el('button', { className: 'btn tiny', type: 'button', textContent: t('pr.std.ai'), onclick: () => prStdAi(card, lines) })]);
  prStdTable(prStdGroups(lines), card, edit);
  body.append(card);
}
function prStdReview(body, lines, edit) {
  const S = PR.std;
  const counts = new Map();
  for (const l of lines) if (l.term_id) counts.set(l.term_id, (counts.get(l.term_id) || 0) + 1);
  const sel = el('select');
  selFill(sel, [['', t('pr.std.pickTerm')], ...(PR.terms || []).filter(x => counts.has(x.id)).sort((a, b) => a.std_vi.localeCompare(b.std_vi))
    .map(x => [String(x.id), `${x.std_vi}/${x.std_en} (${counts.get(x.id)})`])]);
  sel.value = S.term || '';
  sel.onchange = () => { S.term = sel.value; S.sel.clear(); prRender(); };
  const card = el('div', { className: 'card' }, [el('h3', { textContent: t('pr.std.reviewH') }), el('div', { className: 'tdnote', textContent: t('pr.std.reviewHint') })]);
  const out = prStdTools(card, edit, [sel, edit && S.sel.size ? el('button', { className: 'btn tiny', type: 'button', textContent: t('pr.std.unset'), onclick: () => prStdAssign('', out) }) : '']);
  if (S.term) prStdTable(prStdGroups(lines.filter(l => String(l.term_id) === String(S.term))), card, edit);
  body.append(card);
}
function prStdVocab(body, edit) {
  const S = PR.std, out = el('div');
  const counts = new Map();
  for (const l of S.lines || []) if (l.term_id) counts.set(l.term_id, (counts.get(l.term_id) || 0) + 1);
  const q = el('input', { placeholder: t('pm.f.search'), value: S.q, spellcheck: false });
  q.oninput = () => { S.q = q.value; clearTimeout(S.qt); S.qt = setTimeout(prRender, 250); };
  const gsel = el('select'); selFill(gsel, [['', t('pr.allGroups')], ...PR_GROUPS.map(g => [g, t('pr.g.' + g)])]); gsel.value = S.grp || '';
  gsel.onchange = () => { S.grp = gsel.value; prRender(); };
  const qq = prNorm(S.q);
  const rows = (PR.terms || []).filter(x => (!S.grp || x.grp === S.grp) && (!qq || prNorm(`${x.std_vi} ${x.std_en} ${(x.patterns || []).join(' ')}`).includes(qq)));
  const kinds = ['goods', 'service', 'other', 'heading'];
  const line = x => {
    const vi = el('input', { value: x.std_vi || '', disabled: !edit }), en = el('input', { value: x.std_en || '', disabled: !edit });
    const g = el('select', { disabled: !edit }); selFill(g, PR_GROUPS.map(c => [c, t('pr.g.' + c)])); g.value = x.grp || 'OTH';
    const k = el('select', { disabled: !edit }); selFill(k, kinds.map(c => [c, t('pr.kind.' + c)])); k.value = x.kind || 'goods';
    const kw = el('textarea', { rows: 1, value: (x.patterns || []).join('; '), disabled: !edit, className: 'prkw' });
    const act = el('input', { type: 'checkbox', checked: x.active !== false, disabled: !edit });
    const save = el('button', { className: 'btn tiny pri', type: 'button', textContent: t('ao.save'), disabled: !edit, onclick: async () => {
      try { await SB.rpc('pr_term_save', { p: { id: x.id || null, std_vi: vi.value, std_en: en.value, grp: g.value, kind: k.value, patterns: kw.value, active: act.checked } });
            await prTerms(true); PR.flash = t('pr.std.termSaved'); msg('#prMsg', 'ok', PR.flash); PR.flash = null; S.adding = false; prRender(); }
      catch (e) { prErr(out, e); } } });
    return el('tr', {}, [el('td', {}, vi), el('td', {}, en), el('td', {}, g), el('td', {}, k), el('td', {}, kw),
      el('td', { className: 'num', textContent: x.id ? fmtInt(counts.get(x.id) || 0) : '' }), el('td', { className: 'c' }, act), el('td', {}, save)]);
  };
  const tb = el('table', { className: 'lqbt prvocab' }, [el('tr', {}, ['pr.std.c.vi', 'pr.std.c.en', 'pr.group', 'pr.std.c.kind', 'pr.std.c.kw', 'pr.std.c.n', 'pr.std.c.active', '']
    .map(c => el('th', { textContent: c ? t(c) : '' })))]);
  if (S.adding) tb.append(line({ std_vi: '', std_en: '', grp: S.grp || 'OTH', kind: 'goods', patterns: [] }));
  for (const x of rows) tb.append(line(x));
  body.append(el('div', { className: 'card' }, [el('h3', { textContent: t('pr.std.vocabH') }), el('div', { className: 'tdnote', textContent: t('pr.std.vocabHint') }),
    el('div', { className: 'row', style: 'gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, [el('div', { style: 'max-width:260px;flex:1' }, q), gsel, el('span', { style: 'flex:1' }),
      edit ? el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('pr.std.addTerm'), onclick: () => { S.adding = true; prRender(); } }) : '']),
    out, el('div', { className: 'wrap' }, tb)]));
}
// Names the rules did not catch → the Claude chat with the vocabulary, the answer pasted back (no outside AI from the app).
function prStdAi(card, lines) {
  const groups = prStdGroups(lines).slice(0, 300);
  const vocab = (PR.terms || []).filter(x => x.active).map(x => `${x.std_vi}/${x.std_en}`).join('\n');
  const prompt = `You standardise item names of a hotel's price database (technical materials, FF&E, works). For each ORIGINAL name below, choose the best STANDARD name from the vocabulary; if none fits, propose a new one in the same "Vietnamese/English" form (Vietnamese without "/", short, generic — the item type, not the brand or size). Answer with JSON only, no prose:\n{"names":[{"name": "<original, exactly as given>", "std": "<Vietnamese/English>", "new": true|false}]}\n\nVOCABULARY:\n${vocab}\n\nORIGINAL NAMES (with their heading when there is one):\n` +
    groups.map(g => `- ${g.name}${g.section ? '  [heading: ' + g.section + ']' : ''}`).join('\n');
  const ta = el('textarea', { rows: 6, className: 'prjson', placeholder: t('pr.jsonPh') }), out = el('div');
  const box = el('div', { className: 'card prdraft' }, [el('h3', { textContent: t('pr.std.aiH') }), el('div', { className: 'tdnote', textContent: t('pr.std.aiHint', { n: groups.length }) }),
    el('div', { className: 'row', style: 'gap:8px;margin:6px 0' }, [el('button', { className: 'btn', type: 'button', textContent: t('pr.copyPrompt'), onclick: async () => {
      try { await navigator.clipboard.writeText(prompt); msg(out, 'ok', t('pr.copied')); } catch { ta.value = prompt; msg(out, 'warn', t('pr.copyFail')); } } })]),
    ta, el('div', { className: 'row', style: 'gap:8px;margin-top:6px' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('pr.std.aiApply'), onclick: async () => {
      try {
        const j = JSON.parse(String(ta.value).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
        const by = new Map();
        for (const x of j.names || []) { const g = groups.find(g => prNorm(g.name) === prNorm(x.name)); if (g && x.std) (by.get(x.std) || by.set(x.std, []).get(x.std)).push(...g.ids); }
        let n = 0;
        for (const [std, ids] of by) { await SB.rpc('pr_set_std', { p_lines: ids, p_std: std, p_category: null }); n += ids.length; }
        await prStdLoad(true); PR.flash = t('pr.std.aiDone', { n: fmtInt(n), k: fmtInt(by.size) }); msg('#prMsg', 'ok', PR.flash); PR.flash = null; prRender();
      } catch (e) { msg(out, 'err', t('pr.jsonBad', { e: e.message })); } } })]), out]);
  card.after(box);
}

window.prLoad = prLoad;
window.prMcButton = prMcButton;
