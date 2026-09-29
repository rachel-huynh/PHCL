/* Data sources screen (user 29/09/2026).
   1. Import: one card for every upload — the person picks what the file is from a list and that
      import's box opens under it. The boxes keep their ids, so each importer (app.js, contracts.js,
      assetops.js) works as before; piShow marks the parts a person may not see (data-allow="0").
   2. Excel templates: every dataset the app reads from Excel, as a blank workbook in exactly the
      layout its importer expects (sheet names, header words, fixed columns, the period / date rows
      some of them need). Built here, on the spot, from the same rules the importers use:
      budget workbook (pmParseBudgetSheet), dossiers (pmSheetRecords), suppliers (vdParse), asset photos
      (avbRead), accounting invoices / payments (payParseBook), master data (srcParse), asset upload
      (legUploadGrid, BT_UNIQUE / BT_LOW), accounting registers (accParse), price list (prLegacyRead),
      building systems (enParse), meetings (mtParseBook, mtXlsIn), counter seed (scanSeed).
      Headers only — no example rows, which an importer would take as real data. The master-data
      templates can carry the current lists, to be edited and uploaded back. */

const DS_KEY = 'phcl.imp.what';
const dsBlocks = () => [...document.querySelectorAll('#impCard .impblk')];

/* ------------------------------------------------------------ the import card
   The uploads that used to sit on their own screens (user 29/09/2026) — accounting's registers
   (Reconciliation), the old price workbook (Price reference), the building-systems workbooks, the
   meeting-recap workbook (Meetings) — are built here by those screens' own code, on first open. The
   counter seed card was moved here in the page itself. Who may use each: that screen's right. */
const DS_DYN = {
  acc: { ok: () => canView('acc') && can('assets', 'edit'), build(blk) {
    const out = el('div');
    const draw = () => { blk.innerHTML = ''; const c = accUploadCard(true, out, draw); c.classList.remove('card'); c.querySelector('h2')?.remove(); blk.append(c, out); };
    draw();
  } },
  price: { ok: () => canView('price') && can('price', 'create'), build(blk) {
    const out = el('div'), file = el('input', { type: 'file', accept: '.xlsx,.xls' });
    file.onchange = () => prLegacyRead(file.files[0], out);
    blk.append(el('p', { className: 'tdnote', textContent: t('pr.legacyHint') }), el('div', { className: 'fld grow', style: 'max-width:520px' }, [el('label', { textContent: t('pm.imp.file') }), file]), out);
  } },
  eng: { ok: () => canView('eng') && can('eng', 'admin'), async build(blk) {
    // The checklist's systems are matched to the ones already in the app: read them first.
    try { await enBase(); } catch {}
    enImportTab(blk);
    for (const c of blk.querySelectorAll('.card')) c.classList.remove('card');
  } },
  meetings: { ok: () => canView('meetings') && can('meeting', 'admin'), build(blk) {
    mtImportTab(blk);
    for (const c of blk.querySelectorAll('.card')) { c.classList.remove('card'); c.querySelector('h2')?.remove(); }
  } },
  seed: { ok: () => canView('counter') }
};
let DS_PENDING = null;
function dsImpSync() {
  const s = $('#impWhat');
  if (!s) return;
  for (const [k, d] of Object.entries(DS_DYN)) { const b = document.querySelector(`#impCard .impblk[data-imp="${k}"]`); if (b) b.dataset.allow = d.ok() ? '1' : '0'; }
  const blks = dsBlocks().filter(b => b.dataset.allow !== '0');
  let keep = DS_PENDING || s.value;
  DS_PENDING = null;
  if (!keep) try { keep = localStorage.getItem(DS_KEY) || ''; } catch { keep = ''; }
  s.innerHTML = '';
  for (const b of blks) s.append(el('option', { value: b.dataset.imp, textContent: t(b.dataset.label) }));
  if (blks.some(b => b.dataset.imp === keep)) s.value = keep;
  dsImpShow();
}
function dsImpShow() {
  const v = $('#impWhat').value;
  for (const b of dsBlocks()) b.classList.toggle('on', b.dataset.imp === v && b.dataset.allow !== '0');
  try { localStorage.setItem(DS_KEY, v); } catch {}
  // A box built by another screen's code: on its first opening.
  const blk = document.querySelector(`#impCard .impblk.on[data-dyn]`);
  if (blk && !blk.dataset.built && DS_DYN[v] && DS_DYN[v].build) {
    blk.dataset.built = '1';
    Promise.resolve(DS_DYN[v].build(blk)).catch(e => blk.append(el('div', { className: 'msg err', textContent: e.message || String(e) })));
  }
  const n = DS_TPL.filter(x => x.imp === v).length;
  const b = $('#btnImpTpl');
  if (b) { b.hidden = !n; b.textContent = '⬇ ' + t('imp.tplFor', { n }); }
}
// "Templates for this upload": the templates card, those rows marked.
function dsShowTpl(imp) {
  const card = $('#tplCard');
  if (!card) return;
  for (const tr of card.querySelectorAll('tr[data-imp]')) tr.classList.toggle('hl', tr.dataset.imp === imp);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// On the screens the uploads came from: a card that leads to the box in Data sources.
function dsGoImp(imp) {
  DS_PENDING = imp;
  try { localStorage.setItem(DS_KEY, imp); } catch {}
  if (VIEW === 'sources') { dsImpSync(); $('#impCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  else showView('sources');
}
function dsLinkCard(imp, title) {
  return el('div', { className: 'card' }, [el('h2', { textContent: title }), el('div', { className: 'tdnote', style: 'margin:4px 0 10px', textContent: t('imp.moved') }),
    el('button', { className: 'btn pri', type: 'button', textContent: '→ ' + t('imp.goSources'), onclick: () => dsGoImp(imp) })]);
}
// From a template row back to its upload box.
function dsOpenImp(imp) {
  const s = $('#impWhat');
  if (!s || ![...s.options].some(o => o.value === imp)) return;
  s.value = imp; dsImpShow();
  $('#impCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ------------------------------------------------------------ workbook helpers */
function dsSheet(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const head = rows.reduce((m, r) => (r.length > m.length ? r : m), []);
  ws['!cols'] = head.map((h, i) => ({ wch: (widths && widths[i]) || Math.min(42, Math.max(10, String(h ?? '').length + 2)) }));
  return ws;
}
function dsBook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of sheets) XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  return wb;
}
// A date cell (Excel serial) shown as a month or a day.
function dsDateCells(ws, row, cols, fmt) {
  for (const c of cols) { const a = XLSX.utils.encode_cell({ r: row, c }); if (ws[a]) { ws[a].t = 'n'; ws[a].z = fmt; } }
}
const dsYear = () => new Date().getFullYear();
const dsMonthEnd = (y, m) => xlSerial(y, m + 1, 0);        // the last day of month m (1..12)
const dsDmy = (y, m, d) => `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;

/* ------------------------------------------------------------ the templates
   Each: key, the upload it belongs to (imp: a box of the import card) or the screen (view),
   a group, a builder returning [workbook, file name]. */
const DS_BUD_HEAD = ['Project Code', 'Category', 'Department Code', 'Department Name', 'Request Date', 'Investment Type', 'Reason', 'Project Name',
  'Area Category', 'Estimated Value', 'Approved by GM', 'Posibility', 'Impact', 'Assessment', 'Risk Level', 'Time to start', 'Time to complete', 'Duration',
  'Asset Item', 'Location', 'Rationale', 'Technical Standard', 'Quantity', 'Unit Price', 'Amount', 'Reference', 'Previous Project Code', 'Supplier',
  'Details', 'Project Category', 'Purchasing in charge'];
const DS_TPL = [
  // Periodic files & projects
  { key: 'budget', grp: 'periodic', imp: 'budget', build() {
    // Header row: the columns pmParseBudgetSheet knows, then the monthly phasing (a date per month of the
    // year), two unheaded columns (owner's question, department's answer), Note. The cap line above it.
    const y = dsYear() + 1, months = Array.from({ length: 12 }, (_, i) => xlSerial(y, i + 1, 1));
    const head = [...DS_BUD_HEAD, ...months, '', '', 'Note'];
    const ws = dsSheet([[`CAPEX BUDGET ${y}`], ['Total CAPEX budget - 3% FF&E Reserve', null], head]);
    dsDateCells(ws, 2, months.map((_, i) => DS_BUD_HEAD.length + i), 'mmm-yy');
    return [dsBook([[`Capex ${y}`, ws]]), `Budget summary ${y} - template`];
  } },
  { key: 'dossiers', grp: 'periodic', imp: 'dossiers', build() {
    const cd = ['Category', 'Department Code', 'Investment Type', 'Reason', 'Budget', 'Project Type', 'Procurement Type', 'Project Code', 'Sub-project Code',
      'Project Name', 'Completion', 'Estimated Value', 'Posibility', 'Impact', 'Assessment', 'Risk Level', 'Risk Category', 'Asset Item', 'Location',
      'Rationale', 'Technical Standard', 'Reference', 'Previous Project Code', 'Supplier'];
    const pd = ['Department Code', 'Project Type', 'Reason', 'Project Code', 'Sub-project Code', 'Project Name', 'Risk Level', 'Asset Item', 'Request Date',
      'Assess Date', 'Approve Date', 'Purchase Date', 'Handover Date', 'Location', 'Contract Value', 'Contract Volume', 'Chosen Vendor', 'Overall Evaluation', 'Comment'];
    const vd = ['Check Date', 'Project Code', 'Sub-project Code', 'Vendor', 'Total Amount', 'Ability & Experience', 'Techniques', 'Finance', 'Total Score', 'Comment'];
    return [dsBook([['Capex Data', dsSheet([cd])], ['Project Data', dsSheet([pd])], ['Vendor Data', dsSheet([vd])]]), 'Procurement dossier - template'];
  } },
  { key: 'suppliers', grp: 'periodic', imp: 'suppliers', build: () =>
    [dsBook([['Nha cung cap', dsSheet([['Mã nhà cung cấp', 'Tên nhà cung cấp', 'Địa chỉ', 'Mã số thuế', 'Điện thoại']], [18, 48, 48, 16, 16])]]), 'Supplier list - template'] },
  { key: 'photos', grp: 'periodic', imp: 'avatars', build: () =>
    [dsBook([['Anh tai san', dsSheet([['Mã vạch', 'Mã tài sản', 'Ảnh (tên tệp hoặc link)']], [18, 28, 60])]]), 'Asset photos list - template'] },
  { key: 'invoices', grp: 'periodic', imp: 'payments', build() {
    const y = dsYear();
    const head = ['STT', 'Ngày hạch toán', 'Ngày chứng từ', 'Số chứng từ', 'Ký hiệu HĐ', 'Số hóa đơn', 'Ngày hóa đơn', 'Tên người bán', 'Mã số thuế người bán',
      'Diễn giải', 'Giá trị HHDV mua vào chưa có thuế', 'Thuế suất', 'Thuế GTGT'];
    return [dsBook([['Hoa don mua vao', dsSheet([['BẢNG KÊ HÓA ĐƠN MUA VÀO'], [`Từ ngày ${dsDmy(y, 1, 1)} đến ngày ${dsDmy(y, 12, 31)}`], head])]]), `Purchase invoices ${y} - template`];
  } },
  { key: 'bankpay', grp: 'periodic', imp: 'payments', build() {
    const y = dsYear();
    const head = ['STT', 'Ngày hạch toán', 'Ngày chứng từ', 'Số chứng từ', 'Loại chứng từ', 'Diễn giải', 'Số tiền', 'Mã đối tượng', 'Đối tượng', 'Số tài khoản NH', 'Lý do thu/chi'];
    return [dsBook([['Chi tien', dsSheet([['SỔ CHI TIẾT CHI TIỀN'], [`Từ ngày ${dsDmy(y, 1, 1)} đến ngày ${dsDmy(y, 12, 31)}`], head])]]), `Bank payments ${y} - template`];
  } },

  // Master data (srcParse): fixed columns, the first row is a heading the importer skips.
  { key: 'dept', grp: 'master', imp: 'master', data: true, async build(withData) {
    const rows = [['', 'Code / Mã', 'Parent code / Mã cấp trên', 'Name (English)', '', 'Tên (Tiếng Việt)']];
    if (withData) for (const o of await pmSelectAll('am_org', 'select=code,parent_code,name_en,name_vi&order=code'))
      rows.push(['', o.code, o.parent_code || '', o.name_en || '', '', o.name_vi || '']);
    return [dsBook([['DepartmentList', dsSheet(rows, [4, 14, 20, 40, 4, 40])]]), 'Departments - template'];
  } },
  { key: 'cats', grp: 'master', imp: 'master', data: true, async build(withData) {
    const rows = [['', 'Code / Mã', 'Group code / Mã nhóm', 'Tên (Tiếng Việt)', 'Name (English)', '', '2 = group / nhóm']];
    if (withData) {
      for (const g of await pmSelectAll('am_category_group', 'select=code,name_vi,name_en&order=code')) rows.push(['', g.code, '', g.name_vi || '', g.name_en || '', '', 2]);
      for (const c of await pmSelectAll('am_category', 'select=code,group_code,name_vi,name_en&order=code')) rows.push(['', c.code, c.group_code || '', c.name_vi || '', c.name_en || '', '', '']);
    }
    return [dsBook([['Categories', dsSheet(rows, [4, 12, 16, 40, 40, 4, 16])]]), 'Asset categories - template'];
  } },
  { key: 'locs', grp: 'master', imp: 'master', data: true, async build(withData) {
    const bf = [['', '1 = building / toà nhà (blank = floor / tầng)', 'Code / Mã', 'Parent code / Mã cấp trên', 'Name / Tên']];
    const rm = [['', 'Parent code / Mã cấp trên', 'Room code / Mã phòng', 'Name / Tên']];
    if (withData) for (const l of await pmSelectAll('am_location', 'select=code,name,kind,parent_code&order=code')) {
      if (l.kind === 'building') bf.push(['', 1, l.code, l.parent_code || '', l.name || '']);
      else if (l.kind === 'floor') bf.push(['', '', l.code, l.parent_code || '', l.name || '']);
      else rm.push(['', l.parent_code || '', l.code, l.name || '']);
    }
    return [dsBook([['Group&Trackable', dsSheet(bf, [4, 22, 16, 22, 40])], ['Internal', dsSheet(rm, [4, 22, 16, 40])]]), 'Locations - template'];
  } },
  { key: 'products', grp: 'master', imp: 'master', data: true, async build(withData) {
    const rows = [['', '', 'Category code / Mã danh mục', 'Tên Tiếng Việt/English name', '', 'Brand / Thương hiệu', '', 'Unit / ĐVT']];
    if (withData) for (const p of await pmSelectAll('am_product', 'select=std_name_vi,std_name_en,default_category,default_brand,default_unit&order=std_name_vi'))
      if (p.std_name_vi || p.std_name_en) rows.push(['', '', p.default_category || '', [p.std_name_vi, p.std_name_en].filter(Boolean).join('/'), '', p.default_brand || '', '', p.default_unit || '']);
    return [dsBook([['ProductCatalogue', dsSheet(rows, [4, 4, 16, 52, 4, 20, 4, 10])]]), 'Product catalogue - template'];
  } },
  { key: 'units', grp: 'master', imp: 'master', data: true, async build(withData) {
    const rows = [['Tên', 'Mã đơn vị']];
    if (withData) for (const u of await pmSelectAll('am_unit', 'select=code,name_en,name_vi&order=sort_order')) rows.push([u.name_en || u.name_vi || '', u.code]);
    return [dsBook([['Units', dsSheet(rows, [30, 14])]]), 'Units - template'];
  } },
  { key: 'origins', grp: 'master', imp: 'master', data: true, async build(withData) {
    const rows = [['Mã xuất xứ', 'Tên']];
    if (withData) for (const o of await pmSelectAll('am_origin', 'select=iso2,name_en&order=iso2')) rows.push([o.iso2, o.name_en || '']);
    return [dsBook([['Origins', dsSheet(rows, [14, 36])]]), 'Countries of origin - template'];
  } },

  // Assets
  { key: 'assets', grp: 'assets', imp: 'legacy', build: () =>
    [dsBook([['Unique asset', btSheet(BT_UNIQUE, [])], ['Low-value asset', btSheet(BT_LOW, [])]]), 'Asset upload (2 sheets) - template'] },
  { key: 'seed', grp: 'assets', imp: 'seed', build: () =>
    [dsBook([['Ma tai san', dsSheet([['Mã tài sản', 'Mã vạch']], [30, 18])]]), 'Asset codes list (counter seed) - template'] },

  // Uploads on other screens
  { key: 'fa', grp: 'other', imp: 'acc', build() {
    // Accounting's fixed-asset register (accParse, kind fa): 8 fixed columns, the named ones, then a
    // block per month — Term · Monthly Dep · Residual — with the month's last day above its first column.
    const y = dsYear();
    const fixed = ['Entity', 'Dept', 'Group', 'Type', 'Asset no.', 'Debit', 'Credit', 'Cost account'];
    const named = ['Description', 'USD', 'VND', 'Qty', 'Docs', 'MST', 'Supplier', 'Contract', 'Location', 'Liquidation No.', 'Being used at', 'Term'];
    const head = [...fixed, ...named], up = Array(head.length).fill(null);
    up[4] = 'Mã TS mới';
    const dateCols = [];
    for (let m = 1; m <= 12; m++) { dateCols.push(head.length); up[head.length] = dsMonthEnd(y, m); head.push('Term', 'Monthly Dep', 'Residual'); up.push(null, null); }
    const ws = dsSheet([['FIXED ASSETS REGISTER'], up, head]);
    dsDateCells(ws, 1, dateCols, 'dd/mm/yyyy');
    return [dsBook([['Details', ws]]), `Fixed assets register ${y} - template`];
  } },
  { key: 'ccdc', grp: 'other', imp: 'acc', build() { return dsPrepay('ccdc'); } },
  { key: 'st', grp: 'other', imp: 'acc', build() { return dsPrepay('st'); } },
  { key: 'price', grp: 'other', imp: 'price', build() {
    // prLegacyRead: sheet "Master Data", the header row starts with "#" and "Nguồn/ Source", a numbering row
    // under it; fixed columns A–K, the others found by their words; spec columns between Model and Supplier.
    const head = ['#', 'Nguồn/ Source', 'Ngày/ Date', 'Dự án - Hạng mục/ Project - Heading', 'Tên hàng/ Item', 'SL/ Qty', 'ĐVT/ Unit', 'Đơn giá/ Unit price',
      'Thành tiền/ Amount', 'Đơn giá nhân công/ Labour price', 'Thành tiền nhân công/ Labour amount', 'Tiền tệ/ Currency', 'Quốc gia/ Region',
      'Nhà sản xuất/ Manufacturer', 'Thương hiệu/ Brand', 'Seri/ Serial', 'Part No.', 'Số hiệu/ Model', 'Công suất/ Capacity', 'Kích thước/ Dimension',
      'Nhà cung cấp/ Supplier', 'Email', 'Điện thoại/ Phone', 'Giao hàng/ Delivery', 'Lắp đặt/ Installation', 'Thanh toán/ Payment'];
    return [dsBook([['Master Data', dsSheet([['REFERENCE PRICING LIST (SUPPLIER)'], head, head.map((_, i) => i + 1)])]]), 'Reference price list - template'];
  } },
  { key: 'engsys', grp: 'other', imp: 'eng', build: () =>
    [dsBook([['System', dsSheet([['Mã Vị Trí', 'Mã TS Cha', 'Mã Hệ Thống', 'Tên Hệ Thống', 'Mã Hạng Mục', 'Tên Hạng Mục']], [14, 26, 14, 36, 14, 40])]]), 'Building systems - template'] },
  { key: 'engchk', grp: 'other', imp: 'eng', build: () =>
    [dsBook([['DCL', dsSheet([['Mã DCL', 'Mã TS Cha', 'Tên Hệ Thống', 'Chu Kỳ', 'Shift']], [12, 26, 36, 12, 24])],
             ['CheckList', dsSheet([['Mã DCL', 'Location Code', 'Floor', 'Tên Nhiệm Vụ', 'Checklist Setting', 'UOM']], [12, 16, 10, 50, 28, 10])]]), 'Daily checklist - template'] },
  { key: 'mtrecap', grp: 'other', imp: 'meetings', build: () =>
    // mtParseBook: row 1 is skipped; a heading row has only column A; data rows use A–H.
    [dsBook([['Meeting Recap', dsSheet([['Mục / Item — dòng tiêu đề dự án: chỉ cột A / project heading: column A only', 'Ngày họp / Date', 'Tiến độ / Progress',
      'Thảo luận / Discussion', 'Việc cần làm / Actions (mỗi việc một dòng "- ")', 'Hạn / Due', 'Ghi chú / Note', 'Phụ trách / PIC']], [44, 14, 20, 40, 40, 14, 24, 18])]]), 'Meeting recap - template'] },
  { key: 'mtnotes', grp: 'other', view: 'meetings', build: () =>
    [dsBook([['Notes', dsSheet([typeof MT_XH !== 'undefined' ? MT_XH : []])]]), 'Meeting notes - template'] }
];
// Accounting's prepayment registers (accParse): tools & equipment (ccdc: with "Price") and short-term
// (st: without; only group E rows count). A block per month: Debit · Credit · Term · Allocation · Residuals.
function dsPrepay(kind) {
  const y = dsYear();
  const head = ['Tổ chức', 'Nhóm', 'Loại', 'Asset no.', 'Description', 'Qty', 'Unit', 'Doc', 'Project', 'Tax code', 'Supplier', 'Contract no.', 'Location',
    'Beginning', 'Month', ...(kind === 'ccdc' ? ['Price'] : []), 'Asset value'];
  const up = Array(head.length).fill(null);
  up[3] = 'Mã TS mới';
  const dateCols = [];
  for (let m = 1; m <= 12; m++) { dateCols.push(head.length); up[head.length] = dsMonthEnd(y, m); head.push('Debit', 'Credit', 'Term', 'Allocation', 'Residuals'); up.push(null, null, null, null); }
  const ws = dsSheet([[kind === 'ccdc' ? 'TOOLS & EQUIPMENT (CCDC)' : 'SHORT-TERM PREPAYMENTS'], up, head]);
  dsDateCells(ws, 1, dateCols, 'dd/mm/yyyy');
  return [dsBook([[kind === 'ccdc' ? 'CCDC' : String(y), ws]]), kind === 'ccdc' ? `Tools and equipment register ${y} - template` : `Short-term prepayments ${y} - template`];
}

/* ------------------------------------------------------------ the templates card */
const DS_GRP = ['periodic', 'master', 'assets', 'other'];
function dsTplRender() {
  const card = $('#tplCard');
  if (!card) return;
  const withData = el('input', { type: 'checkbox', id: 'tplWithData' });
  const out = el('div');
  const imps = new Map(dsBlocks().map(b => [b.dataset.imp, b]));
  const tb = el('table', { className: 'lqbt tplgrid' });
  tb.append(el('tr', {}, [t('tpl.c.name'), t('tpl.c.for'), t('tpl.c.where'), ''].map(h => el('th', { textContent: h }))));
  for (const g of DS_GRP) {
    tb.append(el('tr', { className: 'tplgrp' }, el('td', { colSpan: 4, textContent: t('tpl.g.' + g) })));
    for (const x of DS_TPL.filter(y => y.grp === g)) {
      const blk = x.imp && imps.get(x.imp);
      const where = x.imp
        ? el('a', { href: '#', className: 'aolink', textContent: `${t('nav.sources')} → ${blk ? t(blk.dataset.label) : x.imp}`, onclick: e => { e.preventDefault(); dsOpenImp(x.imp); } })
        : el('a', { href: '#', className: 'aolink', textContent: t('tpl.w.' + x.key), onclick: e => { e.preventDefault(); if (canView(x.view)) showView(x.view); } });
      const go = el('button', { className: 'btn tiny', type: 'button', textContent: '⬇ ' + t('tpl.get') });
      go.onclick = async () => {
        go.disabled = true;
        try {
          if (typeof XLSX === 'undefined') throw new Error('XLSX');
          const [wb, name] = await x.build(!!(x.data && withData.checked && SB.ready()));
          const file = `${name}.xlsx`;
          XLSX.writeFile(wb, file);
          msg(out, 'ok', t('tpl.done', { file }));
        } catch (e) { msg(out, 'err', e.message || String(e)); }
        finally { go.disabled = false; }
      };
      tb.append(el('tr', { 'data-imp': x.imp || '' }, [el('td', {}, [el('b', { textContent: t('tpl.n.' + x.key) }), x.data ? el('small', { className: 'dim', textContent: ' · ' + t('tpl.canData') }) : '']),
        el('td', { className: 'aowrap', textContent: t('tpl.d.' + x.key) }), el('td', {}, where), el('td', { className: 'c' }, go)]));
    }
  }
  card.innerHTML = '';
  card.append(el('h2', { textContent: t('tpl.h') }), el('p', { className: 'tdnote', textContent: t('tpl.lead') }),
    el('label', { className: 'chk', style: 'margin:4px 0 8px' }, [withData, el('span', { textContent: t('tpl.withData') })]), out,
    el('div', { className: 'wrap' }, tb));
}

// Language switch, first open.
function dsRefresh() { dsImpSync(); dsTplRender(); }
function dsInit() {
  const s = $('#impWhat');
  if (!s || s.dataset.ready) return;
  s.dataset.ready = '1';
  s.onchange = dsImpShow;
  $('#btnImpTpl').onclick = () => dsShowTpl(s.value);
  // Who loaded a master-data file: the signed-in person, unless typed otherwise.
  const who = $('#srcWho');
  if (who && !who.value && typeof ME !== 'undefined' && ME) who.value = ME.full_name || ME.email || '';
  dsRefresh();
}
