(() => {
const orgs = [
  { code: 'PHCL', name_vi: 'PHCL', name_en: 'PHCL', parent_code: null, is_department: false, is_company: true },
  { code: 'SOF', name_vi: 'Sofitel', name_en: 'Sofitel', parent_code: 'PHCL', is_department: false, is_company: true },
  { code: 'KIT', name_vi: 'Bếp', name_en: 'Kitchen', parent_code: 'SOF', is_department: true, is_company: false },
  { code: 'CP', name_vi: 'Cao ốc', name_en: 'Office', parent_code: 'PHCL', is_department: false, is_company: true },
  { code: 'JVC', name_vi: 'JVC', name_en: 'JVC', parent_code: 'PHCL', is_department: true, is_company: true }
];
const roleNames = { DEPT_STAFF: ['Dept Staff', 'Nhân viên bộ phận'], DEPT_HEAD: ['Dept Head', 'Trưởng bộ phận'], DOF: ['Director of Finance', 'Trưởng bộ phận tài chính'],
  HOTEL_GM: ['Hotel GM', 'GM khách sạn'], PURCHASING: ['Purchasing', 'Thu mua'], AM_COORD: ['AM Coordinator', 'Điều phối quản lý tài sản'],
  AM_EXEC: ['AM Executive', 'Chuyên viên quản lý tài sản'], CHIEF_ACC: ['Chief Accountant', 'Kế toán trưởng'], JVC_DGM: ['JVC Deputy General Manager', 'Phó Tổng Giám đốc JVC'],
  JVC_GM: ['JVC GM', 'GM văn phòng JVC'], SYS_ADMIN: ['System Admin', 'Quản trị hệ thống'] };
const users = [
  ['u1', 'staff@x', 'Nguyễn Văn Staff', [['DEPT_STAFF', 'KIT']]], ['u2', 'head@x', 'Trần Thị Head', [['DEPT_HEAD', 'KIT']]],
  ['u3', 'dof@x', 'Lê DOF', [['DOF', 'SOF']]], ['u4', 'gm@x', 'Phạm Hotel GM', [['HOTEL_GM', 'SOF']]],
  ['u5', 'amc@x', 'Huỳnh AM Coord', [['AM_COORD', 'PHCL']]], ['u6', 'amx@x', 'Võ AM Exec', [['AM_EXEC', 'PHCL']]],
  ['u7', 'ca@x', 'Nguyễn Chief Acc', [['CHIEF_ACC', 'PHCL']]], ['u8', 'jgm@x', 'Đinh JVC GM', [['JVC_GM', 'PHCL']]],
  ['u9', 'pur@x', 'Mai Purchasing', [['PURCHASING', 'SOF']]], ['u0', 'admin@x', 'Admin', [['SYS_ADMIN', 'PHCL']]]
].map(([id, email, full_name, roles]) => ({ id, email, full_name, active: true, roles }));
const chain = [];
const J = ['AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_GM'];
for (const ty of ['PR', 'RR', 'QC', 'PO', 'CT', 'AH']) {
  const prep = ['QC', 'PO', 'CT'].includes(ty) ? 'PURCHASING' : 'DEPT_STAFF';
  [prep, 'DEPT_HEAD', 'DOF', 'HOTEL_GM', ...J].forEach((r, i) => chain.push({ entity: 'SSP', doc_type: ty, step: i, role_code: r }));
}
for (const ty of ['PA', 'MC']) J.forEach((r, i) => chain.push({ entity: 'SSP', doc_type: ty, step: i, role_code: r }));
for (const c of chain) c.kind = c.step > 0 && ['AM_COORD', 'AM_EXEC'].includes(c.role_code) ? 'check' : 'approve';
const GRP = { PR: 'PR', RR: 'PR', PA: 'PR', QC: 'QC', MC: 'QC' };
const prods = [['Máy rửa chén', 'Dishwasher', 'pcs'], ['Điều hòa không khí', 'Air conditioner', 'set'], ['Tủ mát', 'Cooler', 'pcs'], ['Bếp', 'Stove', 'pcs']];
const db = window.FKDB = JSON.parse(localStorage.getItem('fkdb') || 'null') || {
  am_org: orgs, am_org_alias: [], am_setting: [{ key: 'unique_threshold', value: '10000000' }],
  app_role: Object.keys(roleNames).map((c, i) => ({ code: c, name_en: roleNames[c][0], name_vi: roleNames[c][1], entity: 'X', sort: i })),
  pm_doc_type: [['PR', 10, true, false, 'Purchase Request', 'Yêu cầu mua sắm'], ['RR', 20, false, false, 'Replacement Request', 'Yêu cầu thay thế'],
    ['PA', 30, true, false, 'Project Assessment', 'Đánh giá dự án'], ['QC', 40, true, false, 'Scoring Tender Form', 'Bảng so sánh đánh giá nhà thầu'],
    ['MC', 50, true, false, 'Market Check', 'Kiểm tra giá thị trường'], ['PO', 60, true, false, 'Purchase Order', 'Đơn đặt hàng'],
    ['CT', 70, false, false, 'Contract', 'Hợp đồng'], ['AH', 80, true, true, 'Asset Handover', 'Biên bản nghiệm thu']]
    .map(([code, seq, required, repeatable, name_en, name_vi]) => ({ code, seq, required, repeatable, name_en, name_vi, prefix: code,
      side: ['PA', 'MC'].includes(code) ? 'owner' : 'operator', grp: GRP[code] || null })),
  pm_chain: chain,
  pm_project: [{ code: 'FFE.KIT.02.2025', main_code: 'FFE.KIT.02.2025', year: 2025, dept_code: 'KIT', name: 'Replace dishwasher', budgeted: true,
    investment_type: 'Replacement', project_type: 'Thiết bị', share_pct: 1, estimated_value: 500000000, possibility: 4, impact: 4, assessment: 16,
    asset_item: 'Máy rửa chén / Dishwasher', location: 'KIT-01', status: 'pending', reason: 'Old unit broken beyond repair' }],
  pm_budget_year: [{ year: 2025, fx_rate: 26000, reserve_pct: 3, status: 'open' }],
  pm_budget_round: [{ id: 1, year: 2025, label: 'Final', is_final: true }],
  pm_budget_line: [{ id: 1, round_id: 1, line_no: 1, project_code: 'FFE.KIT.02.2025', dept_code: 'KIT', name: 'Replace dishwasher', estimated_value: 500000000,
    quantity: 2, unit_price: 250000000, asset_item: 'Máy rửa chén / Dishwasher', rationale: 'Old unit broken', tech_standard: 'Hobart AM-15', reference: 'Quotation',
    supplier: 'ABC Co', location: 'Kitchen main', investment_type: 'Replacement' }],
  am_product: prods.map(([vi, en, u], i) => ({ id: i + 1, std_name_vi: vi, std_name_en: en, default_unit: u })),
  am_location: [{ code: 'KIT-01', name: 'Kitchen main', active: true }, { code: 'KIT-02', name: 'Pastry kitchen', active: true }, { code: 'POOL', name: 'Pool area', active: true }],
  am_unit: [{ code: 'pcs', sort_order: 1 }, { code: 'set', sort_order: 2 }, { code: 'm2', sort_order: 3 }],
  am_asset: [{ asset_code: 'KIT.C212.OME.0000.00054', dept_code: 'KIT', name_vi: 'Máy rửa chén', name_en: 'Dishwasher', unit_price: 120000000, qty: 1, unit_code: 'pcs' },
             { asset_code: 'KIT.C212.OME.0000.00055', dept_code: 'KIT', name_vi: 'Tủ mát', name_en: 'Cooler', unit_price: 20000000, qty: 1, unit_code: 'pcs' }],
  pm_vendor: [], pm_vendor_score: [], pm_doc: [], pm_doc_event: [], pm_pkg: [], pm_pkg_step: [], pm_pkg_event: [], pm_notice: [],
  pm_invoice: [], pm_payment: [], pm_pay_alloc: [], pm_pay_import: [], pm_project_money: [],
  seq: 1
};
const save = () => localStorage.setItem('fkdb', JSON.stringify(db));
const perms = {};
for (const m of ['assets', 'master', 'system', 'security', 'budget', 'project', 'approval', 'payment', 'report', 'override', 'liquidation'])
  perms[m] = { view: true, create: true, edit: true, approve: true, admin: false };
perms.override = { view: false, create: false, edit: false, approve: false, admin: false };
const me = () => users.find(u => u.id === (localStorage.getItem('fkuid') || 'u1'));
const org = c => db.am_org.find(o => o.code === c);
const covers = (scope, dept) => { if (org(scope) && !org(scope).parent_code) return true; let o = org(dept), g = 0; while (o && g++ < 10) { if (o.code === scope) return true; o = org(o.parent_code); } return false; };
const roleCovers = (u, role, dept) => u.roles.some(([r, s]) => r === role && covers(s, dept));
const entity = dept => { let o = org(dept); while (o) { if (o.code === 'SOF') return 'SSP'; if (o.code === 'CP') return 'CP'; if (o.code === 'JVC') return 'JVC'; o = org(o.parent_code); } return null; };
const err = (m, code = 400) => { const e = new Error(m); e.http = code; throw e; };
const now = () => new Date().toISOString();
const type = c => db.pm_doc_type.find(x => x.code === c);
const proj = code => db.pm_project.find(p => p.code === code);
const lead = g => (db.pm_doc_type.filter(x => x.grp === g && x.side === 'operator').sort((a, b) => a.seq - b.seq)[0] || {}).code || g;
const canPrepare = (ty, dept) => { const c = db.pm_chain.find(c => c.entity === entity(dept) && c.doc_type === ty && c.step === 0); return c && roleCovers(me(), c.role_code, dept); };
const sigOk = sig => { if (!sig) return null; return { png: sig.png, at: now() }; };
const plog = (pkg, action, from, to, step, comment) => db.pm_pkg_event.push({ id: db.seq++, pkg_id: pkg, at: now(), actor: me().id, actor_email: me().email,
  actor_name: me().full_name, action, from_status: from, to_status: to, step: step ?? null, comment: comment ?? null });
const pdocs = k => db.pm_doc.filter(d => d.pkg_id === k.id);
const RPC = {
  app_me: () => { const u = me(); return { id: u.id, email: u.email, full_name: u.full_name, active: true,
    roles: u.roles.map(([role, scope]) => ({ role, scope, name_en: role, name_vi: role, entity: 'X' })),
    perms: u.roles.some(r => r[0] === 'SYS_ADMIN') ? Object.fromEntries(Object.keys(perms).map(k => [k, { view: 1, create: 1, edit: 1, approve: 1, admin: 1 }])) : perms }; },
  am_resolve_origin: () => [],
  pm_doc_create: ({ p_project, p_type, p_data }) => {
    const p = proj(p_project), t = type(p_type);
    if (!canPrepare(p_type, p.dept_code)) err(`Bạn không phải người lập ${p_type}`, 403);
    if (!t.repeatable && db.pm_doc.some(d => d.project_code === p.code && d.doc_type === p_type && !['rejected', 'cancelled'].includes(d.status))) err('đã có một bản đang hiệu lực');
    let k = t.grp ? db.pm_pkg.filter(x => x.project_code === p.code && x.grp === t.grp && !['rejected', 'cancelled'].includes(x.status)).sort((a, b) => b.id - a.id)[0] : null;
    let pkg;
    if (t.side === 'owner') {
      const s = k && db.pm_pkg_step.find(x => x.pkg_id === k.id && x.step === k.current_step);
      if (!k || k.status !== 'in_review' || !s || !s.owner_prep) err(`${p_type} được AM team lập ở bước kiểm tra`);
      pkg = k.id;
    } else if (k) {
      if (!['draft', 'returned'].includes(k.status)) err('Bộ hồ sơ đã gửi duyệt'); pkg = k.id;
    } else {
      if (t.grp && p_type !== lead(t.grp)) err(`Lập ${lead(t.grp)} trước`);
      const miss = db.pm_doc_type.filter(x => x.seq < t.seq && x.grp !== (t.grp || '#') && (x.required || (x.code === 'RR' && /replace/i.test(p.investment_type || '')))
        && !db.pm_doc.some(d => d.project_code === p.code && d.doc_type === x.code && d.status === 'approved')).map(x => x.code);
      if (miss.length) err(`Chưa lập được ${p_type}: ${miss.join(', ')} phải được duyệt xong trước.`);
      pkg = db.seq++;
      db.pm_pkg.push({ id: pkg, project_code: p.code, grp: t.grp || t.code, status: 'draft', current_step: null, version: 0, returned_to: null,
        created_by: me().id, created_email: me().email, created_name: me().full_name, prep_signature: null, created_at: now(), submitted_at: null, decided_at: null });
      plog(pkg, 'create', null, 'draft');
    }
    let no = t.prefix + p.code.slice(p.code.indexOf('.'));
    const n = db.pm_doc.filter(d => d.project_code === p.code && d.doc_type === p_type && d.status !== 'cancelled').length;
    if (t.repeatable && n) no += '/' + (n + 1);
    const d = { id: db.seq++, project_code: p.code, doc_type: p_type, doc_no: no, version: 0, status: 'draft', data: p_data || {}, pkg_id: pkg,
      total_value: p_data && p_data.total != null ? +p_data.total : null, created_by: me().id, created_email: me().email, created_at: now() };
    db.pm_doc.push(d); return d.id;
  },
  pm_doc_save: ({ p_id, p_data }) => { const d = db.pm_doc.find(x => x.id === p_id);
    if (!['draft', 'returned'].includes(d.status)) err('không sửa được');
    if (!(d.created_by === me().id || canPrepare(d.doc_type, (proj(d.project_code) || d).dept_code))) err('Chỉ người lập', 403);
    d.data = p_data; d.total_value = p_data.total != null ? +p_data.total : null; return null; },
  pm_pkg_submit: ({ p_pkg, p_signature }) => {
    const k = db.pm_pkg.find(x => x.id === p_pkg), p = (proj(k.project_code) || { dept_code: k.dept_code }), L = lead(k.grp);
    if (!['draft', 'returned'].includes(k.status)) err('không gửi được');
    if (k.grp === 'PR' && /replace/i.test(p.investment_type || '') && !pdocs(k).some(d => d.doc_type === 'RR' && ['draft', 'returned'].includes(d.status))) err('Dự án thay thế: cần RR');
    db.pm_pkg_step = db.pm_pkg_step.filter(s => s.pkg_id !== k.id);
    const owners = db.pm_doc_type.filter(x => x.grp === k.grp && x.side === 'owner').map(x => (db.pm_chain.find(c => c.entity === entity(p.dept_code) && c.doc_type === x.code && c.step === 0) || {}).role_code);
    const ch = db.pm_chain.filter(c => c.entity === entity(p.dept_code) && c.doc_type === L && c.step > 0).sort((a, b) => a.step - b.step);
    for (const c of ch) db.pm_pkg_step.push({ id: db.seq++, pkg_id: k.id, step: c.step, role_code: c.role_code, kind: c.kind === 'check' ? 'check' : 'approve',
      owner_prep: owners.includes(c.role_code), status: 'pending', acted_by: null, acted_email: null, acted_name: null, acted_at: null, comment: null, signature: null });
    const from = k.status, sig = sigOk(p_signature);
    Object.assign(k, { status: 'in_review', current_step: ch[0].step, version: k.version + 1, prep_signature: sig, returned_to: null, submitted_at: now(), decided_at: null });
    for (const d of pdocs(k)) if (['draft', 'returned'].includes(d.status)) { if (type(d.doc_type).side === 'owner') d.status = 'draft'; else { d.status = 'in_review'; d.prep_signature = sig; } }
    plog(k.id, from === 'returned' ? 'resubmit' : 'submit', from, 'in_review', ch[0].step); return null; },
  pm_pkg_act: ({ p_pkg, p_action, p_comment, p_signature, p_target }) => {
    const k = db.pm_pkg.find(x => x.id === p_pkg), p = (proj(k.project_code) || { dept_code: k.dept_code });
    if (k.status !== 'in_review') err('không chờ duyệt');
    const s = db.pm_pkg_step.find(x => x.pkg_id === k.id && x.step === k.current_step);
    if (k.created_by === me().id) err('Người lập không tự duyệt', 403);
    if (!roleCovers(me(), s.role_code, p.dept_code)) err(`Bước ${s.step} cần vai trò ${s.role_code}`, 403);
    if (p_action !== 'approve' && !(p_comment || '').trim()) err('Cần ghi lý do');
    const act = { acted_by: me().id, acted_email: me().email, acted_name: me().full_name, acted_at: now() };
    if (p_action === 'approve') {
      const sig = sigOk(p_signature);
      if (s.owner_prep) {
        const miss = db.pm_doc_type.filter(x => x.grp === k.grp && x.side === 'owner' && !pdocs(k).some(d => d.doc_type === x.code && ['draft', 'returned'].includes(d.status))).map(x => x.code);
        if (miss.length) err(`Cần lập ${miss.join(', ')} trước khi bấm Checked.`);
        for (const d of pdocs(k)) if (type(d.doc_type).side === 'owner' && ['draft', 'returned'].includes(d.status)) Object.assign(d, { status: 'in_review', prep_signature: sig });
      }
      Object.assign(s, act, { status: 'approved', comment: p_comment || null, signature: sig });
      const nx = db.pm_pkg_step.filter(x => x.pkg_id === k.id && x.step > s.step && x.status === 'pending').sort((a, b) => a.step - b.step)[0];
      if (nx) { k.current_step = nx.step; plog(k.id, s.kind === 'check' ? 'check' : 'approve', 'in_review', 'in_review', s.step, p_comment); return 'in_review'; }
      Object.assign(k, { status: 'approved', current_step: null, decided_at: now() });
      for (const d of pdocs(k)) if (d.status === 'in_review') { Object.assign(d, { status: 'approved', decided_at: now() }); if (window.__apply) window.__apply(d, db); }
      plog(k.id, 'approve', 'in_review', 'approved', s.step, p_comment); return 'approved';
    }
    if (p_action === 'return' && p_target === 'am') {
      const op = db.pm_pkg_step.filter(x => x.pkg_id === k.id && x.owner_prep && x.step < s.step).sort((a, b) => a.step - b.step)[0];
      if (!op) err('Chỉ trả về AM team được sau khi AM đã kiểm tra.');
      for (const x of db.pm_pkg_step) if (x.pkg_id === k.id && x.step >= op.step) Object.assign(x, { status: 'pending', acted_by: null, acted_email: null, acted_name: null, acted_at: null, comment: null, signature: null });
      Object.assign(k, { current_step: op.step, returned_to: 'am' });
      for (const d of pdocs(k)) if (type(d.doc_type).side === 'owner' && d.status === 'in_review') d.status = 'returned';
      plog(k.id, 'return_am', 'in_review', 'in_review', s.step, p_comment); return 'returned_am';
    }
    Object.assign(s, act, { status: p_action === 'return' ? 'returned' : 'rejected', comment: p_comment });
    if (p_action === 'return') {
      Object.assign(k, { status: 'returned', current_step: null, returned_to: 'operator' });
      for (const d of pdocs(k)) if (['in_review', 'draft', 'returned'].includes(d.status)) d.status = type(d.doc_type).side === 'owner' ? 'draft' : 'returned';
      plog(k.id, 'return', 'in_review', 'returned', s.step, p_comment); return 'returned';
    }
    Object.assign(k, { status: 'rejected', current_step: null, decided_at: now() });
    for (const d of pdocs(k)) if (!['cancelled', 'approved'].includes(d.status)) d.status = 'rejected';
    plog(k.id, 'reject', 'in_review', 'rejected', s.step, p_comment); return 'rejected'; },
  pm_pkg_cancel: ({ p_pkg, p_comment }) => { const k = db.pm_pkg.find(x => x.id === p_pkg); const from = k.status;
    Object.assign(k, { status: 'cancelled', current_step: null }); for (const d of pdocs(k)) if (d.status !== 'approved') d.status = 'cancelled';
    plog(k.id, 'cancel', from, 'cancelled', null, p_comment); return null; },
  pm_doc_remove: ({ p_id }) => { const d = db.pm_doc.find(x => x.id === p_id); d.status = 'cancelled'; return null; },
  pm_doc_admin_save: ({ p_id, p_data }) => { const d = db.pm_doc.find(x => x.id === p_id); d.data = p_data; return null; },
  pm_doc_admin_reopen: ({ p_id, p_comment }) => { const d = db.pm_doc.find(x => x.id === p_id), k = db.pm_pkg.find(x => x.id === d.pkg_id); const from = k.status;
    db.pm_pkg_step = db.pm_pkg_step.filter(s => s.pkg_id !== k.id); Object.assign(k, { status: 'draft', current_step: null, returned_to: null });
    for (const x of pdocs(k)) if (x.status !== 'cancelled') x.status = 'draft'; plog(k.id, 'admin_reopen', from, 'draft', null, p_comment); return null; },
  pm_inbox: () => { const u = me(), out = [];
    for (const k of db.pm_pkg) { const p = (proj(k.project_code) || { dept_code: k.dept_code }), ds = pdocs(k).filter(d => !['cancelled', 'rejected'].includes(d.status)).sort((a, b) => type(a.doc_type).seq - type(b.doc_type).seq);
      if (!ds.length) continue;
      const base = { pkg_id: k.id, doc_id: ds[0].id, doc_no: ds.map(d => d.doc_no).join(' + '), doc_type: lead(k.grp), grp: k.grp, project_code: p.code, project_name: p.name,
        dept_code: p.dept_code, total_value: ds[0].total_value, submitted_at: k.submitted_at, returned_to: k.returned_to };
      if (k.status === 'in_review') { const s = db.pm_pkg_step.find(x => x.pkg_id === k.id && x.step === k.current_step);
        if (k.created_by !== u.id && roleCovers(u, s.role_code, p.dept_code)) out.push(Object.assign({}, base, { step: s.step, role_code: s.role_code, kind: 'approve', step_kind: s.kind, owner_prep: s.owner_prep })); }
      if (k.status === 'returned' && k.created_by === u.id) out.push(Object.assign({}, base, { step: null, role_code: null, kind: 'returned' })); }
    return out; },
  pm_next_actors: ({ p_id }) => { const d = db.pm_doc.find(x => x.id === p_id), k = db.pm_pkg.find(x => x.id === d.pkg_id), p = (proj(k.project_code) || { dept_code: k.dept_code });
    const s = db.pm_pkg_step.find(x => x.pkg_id === k.id && x.step === k.current_step);
    return s ? users.filter(u => u.id !== k.created_by && roleCovers(u, s.role_code, p.dept_code)).map(u => ({ email: u.email, full_name: u.full_name })) : []; }
};
function query(rows, params) {
  let out = rows.slice();
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'or'].includes(k)) continue;
    const m = /^(eq|neq|gt|gte|lt|lte|in|is|ilike)\.(.*)$/.exec(v); if (!m) continue;
    const [, op, raw] = m;
    const cmp = x => { const val = x[k];
      if (op === 'eq') return String(val) === raw; if (op === 'neq') return String(val) !== raw;
      if (op === 'gt') return Number(val) > Number(raw); if (op === 'gte') return isNaN(Number(raw)) ? String(val) >= raw : Number(val) >= Number(raw);
      if (op === 'lt') return Number(val) < Number(raw); if (op === 'lte') return Number(val) <= Number(raw);
      if (op === 'in') return raw.replace(/^\(|\)$/g, '').split(',').includes(String(val));
      if (op === 'ilike') return String(val || '').toLowerCase().includes(raw.replace(/\*/g, '').toLowerCase());
      if (op === 'is') return raw === 'null' ? val == null : String(!!val) === raw; };
    out = out.filter(cmp);
  }
  const orq = params.get('or');
  if (orq) { const parts = orq.replace(/^\(|\)$/g, '').split(',');
    out = out.filter(r => parts.some(p => { const m = /^(\w+)\.(eq|ilike|gte|is|not\.is)\.(.*)$/.exec(p); if (!m) return false; const v = m[3].replace(/^"|"$/g, '').replace(/\*/g, '');
      if (m[2] === 'gte') return Number(r[m[1]]) >= Number(v);
      if (m[2] === 'is') return v === 'null' ? r[m[1]] == null : String(!!r[m[1]]) === v;
      if (m[2] === 'not.is') return v === 'null' ? r[m[1]] != null : String(!!r[m[1]]) !== v;
      return m[2] === 'eq' ? String(r[m[1]]) === v : String(r[m[1]] || '').toLowerCase().includes(v.toLowerCase()); })); }
  const ord = params.get('order');
  if (ord) { const keys = ord.split(',').map(s => { const [c, d] = s.split('.'); return [c, d === 'desc' ? -1 : 1]; });
    out.sort((a, b) => { for (const [c, d] of keys) { if (a[c] == b[c]) continue; if (a[c] == null) return 1; if (b[c] == null) return -1; return (a[c] > b[c] ? 1 : -1) * d; } return 0; }); }
  const off = +(params.get('offset') || 0), lim = params.get('limit');
  out = out.slice(off, lim != null ? off + +lim : undefined);
  const sel = params.get('select');
  if (sel && sel !== '*') { const cols = sel.split(','); out = out.map(r => Object.fromEntries(cols.map(c => { const [al, src] = c.includes(':') ? c.split(':') : [c, c];
    const path = src.split('->'); let v = r[path[0]]; if (path[1] && v) v = v[path[1]]; return [al, v]; }))); }
  return out;
}
const PK = { pm_chain: ['entity', 'doc_type', 'step'], pm_project: ['code'], pm_vendor: ['code'], pm_signature: ['user_id'] };
const resp = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'content-range': '0-0/' + (Array.isArray(body) ? body.length : 0) } });
const real = window.__realFetch || window.fetch; window.__realFetch = real;
window.fetch = async (url, opts = {}) => {
  url = String(url);
  if (!url.startsWith('https://fake.supabase.co')) return real(url, opts);
  const u = new URL(url), method = (opts.method || 'GET').toUpperCase();
  if (u.pathname.startsWith('/auth/v1/')) return resp({});
  if (u.pathname.startsWith('/storage/v1/object/')) { const key = decodeURIComponent(u.pathname.replace('/storage/v1/object/', '').replace(/^authenticated\//, '')); window.__blobs = window.__blobs || {}; if (method === 'POST') { window.__blobs[key] = opts.body; return resp({ Key: key }); } if (method === 'DELETE') { delete window.__blobs[key]; return resp({}); } const b = window.__blobs[key]; return b ? new Response(b, { status: 200, headers: { 'content-type': b.type || 'image/jpeg' } }) : resp({ message: 'not found' }, 404); }
  const path = u.pathname.replace('/rest/v1/', '');
  try {
    if (path.startsWith('rpc/')) { const fn = path.slice(4); const f = RPC[fn]; if (!f) return resp({ message: 'no rpc ' + fn }, 404);
      const r = f(opts.body ? JSON.parse(opts.body) : {}); save(); return resp(r === undefined ? null : r); }
    const tbl = db[path] || (db[path] = []);
    if (path === 'pm_notice' || path === 'pm_signature') u.searchParams.append('user_id', 'eq.' + me().id);
    if (method === 'GET') return resp(query(tbl, u.searchParams));
    if (method === 'POST') { const rows = [].concat(JSON.parse(opts.body)); const pk = PK[path];
      const back = [];
      for (const r of rows) { const i = pk ? tbl.findIndex(x => pk.every(k => String(x[k]) === String(r[k]))) : -1; if (i >= 0) back.push(Object.assign(tbl[i], r)); else { const o = Object.assign({ id: db.seq++ }, r); tbl.push(o); back.push(o); } }
      save(); return resp(back, 201); }
    if (method === 'PATCH') { const hit = query(tbl, new URLSearchParams([...u.searchParams].filter(([k]) => k !== 'select'))); const patch = JSON.parse(opts.body);
      const ids = new Set(hit.map(h => JSON.stringify(h))); for (const r of tbl) if (ids.has(JSON.stringify(r))) Object.assign(r, patch); save(); return resp(hit); }
    if (method === 'DELETE') { const hit = new Set(query(tbl, u.searchParams).map(h => JSON.stringify(h))); db[path] = tbl.filter(r => !hit.has(JSON.stringify(r))); save(); return resp(null, 204); }
  } catch (e) { return resp({ message: e.message }, e.http || 400); }
  return resp({ message: 'unsupported' }, 400);
};
window.FK = { as: id => { localStorage.setItem('fkuid', id); }, db, users, RPC, save, me, now, plog, reset: () => localStorage.removeItem('fkdb') };
})();

;(() => {
const { db, RPC, save, me, now, plog, users } = FK;
if (!users.some(u => u.id === 'u10')) users.push({ id: 'u10', email: 'dgm@x', full_name: 'Phó TGĐ JVC', active: true, roles: [['JVC_DGM', 'PHCL']] });
if (!db.pm_doc_type.some(x => x.code === 'LR')) {
  db.pm_doc_type.push({ code: 'LR', prefix: 'LID', side: 'operator', seq: 900, required: false, repeatable: true, name_en: 'Liquidation Request', name_vi: 'Đề xuất thanh lý tài sản', grp: null });
  ['DEPT_STAFF', 'DEPT_HEAD', 'DOF', 'HOTEL_GM', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM'].forEach((r, i) =>
    db.pm_chain.push({ entity: 'SSP', doc_type: 'LR', step: i, role_code: r, kind: i > 0 && ['AM_COORD', 'AM_EXEC'].includes(r) ? 'check' : 'approve' }));
  db.am_asset = [
    { id: 901, asset_code: 'KIT.C212.OME.2019.00054', barcode: 'P0000901', asset_kind: 'unique', dept_code: 'KIT', location_code: 'KIT-01', name_vi: 'Máy rửa chén', name_en: 'Dishwasher', unit_price: 120000000, qty: 1, unit_code: 'pcs', status_code: '4', in_use_date: '2019-05-01' },
    { id: 902, asset_code: 'KIT.C300.TRA.2020.00012', barcode: 'P0000902', asset_kind: 'low', dept_code: 'KIT', location_code: 'KIT-02', name_vi: 'Khay inox', name_en: 'Steel tray', unit_price: 350000, qty: 40, unit_code: 'pcs', status_code: '20', purchase_date: '2020-03-10' },
    { id: 903, asset_code: 'KIT.C212.OME.2015.00007', barcode: 'P0000903', asset_kind: 'unique', dept_code: 'KIT', location_code: 'KIT-01', name_vi: 'Tủ mát', name_en: 'Cooler', unit_price: 20000000, qty: 1, unit_code: 'pcs', status_code: '8', in_use_date: '2015-01-01' }];
  db.pm_lq_item = []; db.am_asset_photo = [];
}
RPC.pm_lq_next_no = ({ p_dept, p_year }) => {
  const n = db.pm_doc.filter(d => d.doc_type === 'LR' && d.doc_no.split('.')[1] === p_dept && d.doc_no.split('.')[3] === String(p_year)).map(d => +d.doc_no.split('.')[2] || 0);
  return `LID.${p_dept}.${String((n.length ? Math.max(...n) : 0) + 1).padStart(2, '0')}.${p_year}`;
};
RPC.pm_lq_create = ({ p_dept, p_data, p_no }) => {
  const year = String(p_data.date || now()).slice(0, 4);
  const no = p_no ? `LID.${p_dept}.${String(p_no).padStart(2, '0')}.${year}` : RPC.pm_lq_next_no({ p_dept, p_year: +year });
  const pkg = db.seq++;
  db.pm_pkg.push({ id: pkg, project_code: null, dept_code: p_dept, grp: 'LR', status: 'draft', current_step: null, version: 0, returned_to: null, created_by: me().id,
    created_email: me().email, created_name: me().full_name, prep_signature: null, created_at: now(), submitted_at: null, decided_at: null });
  plog(pkg, 'create', null, 'draft');
  const d = { id: db.seq++, project_code: null, dept_code: p_dept, doc_type: 'LR', doc_no: no, version: 0, status: 'draft', data: p_data, pkg_id: pkg,
    total_value: p_data.total ?? null, created_by: me().id, created_email: me().email, created_at: now() };
  db.pm_doc.push(d);
  return d.id;
};
window.__apply = (d, db) => {
  if (d.doc_type !== 'LR') return;
  (d.data.lines || []).forEach((l, i) => {
    db.pm_lq_item.push({ id: db.seq++, lr_doc_id: d.id, line_key: l.key || String(i + 1), asset_id: l.asset_id || null, asset_code: l.asset_code || null, name: l.name, qty: l.qty,
      unit: l.unit, dept_code: l.dept_code || d.dept_code, kind: l.kind, condition: l.condition, reason: l.reason, mode: l.mode, original_value: l.original_value,
      depreciation: l.depreciation, nbv: (l.original_value || 0) - (l.depreciation || 0), status: 'pool', approved_at: now() });
    const a = db.am_asset.find(x => x.id === l.asset_id);
    if (a && !['7', '9', '8', '24'].includes(a.status_code)) a.status_code = a.asset_kind === 'low' ? '24' : '8';
  });
};
save();
})();

;(() => {
const { db, RPC, me, now } = FK;
for (const k of ['pm_lq_council', 'pm_lq_member', 'pm_lq_batch']) db[k] = db[k] || [];
db.app_user = FK.users.map(u => ({ id: u.id, email: u.email, full_name: u.full_name, active: true }));
const err = m => { const e = new Error(m); e.http = 400; throw e; };
const B = id => db.pm_lq_batch.find(b => b.id === id);
const I = id => db.pm_lq_item.find(i => i.id === id);
RPC.pm_lq_batch_next = ({ p_year }) => {
  const ns = db.pm_lq_batch.filter(b => b.year === p_year).map(b => +b.code.slice(1).split('.')[0])
    .concat(db.pm_lq_council.map(c => /^L(\d+)[./](\d{4})$/.exec(c.decision_no)).filter(m => m && +m[2] === p_year).map(m => +m[1]));
  return `L${String((ns.length ? Math.max(...ns) : 0) + 1).padStart(2, '0')}.${p_year}`;
};
RPC.pm_lq_batch_create = ({ p_code, p_data }) => {
  const y = +(String(p_data.meeting_date || now()).slice(0, 4));
  const code = p_code || RPC.pm_lq_batch_next({ p_year: y });
  if (db.pm_lq_batch.some(b => b.code === code)) err('Đợt đã có');
  const b = { id: db.seq++, code, year: +code.split('.')[1], council_id: (db.pm_lq_council.find(c => c.active) || {}).id || null, status: 'open',
    meeting_date: p_data.meeting_date || null, meeting_time: null, meeting_place: p_data.meeting_place || null, decision_date: null, count_date: null,
    valuation_date: null, liquidation_date: null, data: {}, created_name: me().full_name, created_at: now() };
  db.pm_lq_batch.push(b); return b.id;
};
RPC.pm_lq_batch_save = ({ p_id, p_patch }) => { const b = B(p_id);
  for (const [k, v] of Object.entries(p_patch)) { if (k === 'data') b.data = Object.assign({}, b.data, v); else b[k] = v === '' ? null : (k === 'council_id' && v ? +v : v); }
  if (p_patch.code) b.year = +p_patch.code.split('.')[1]; return null; };
RPC.pm_lq_batch_items = ({ p_id, p_add, p_remove }) => { const b = B(p_id); if (b.status !== 'open') err('Đợt đã chốt danh sách');
  for (const id of p_add || []) { const i = I(id); if (i && i.status === 'pool') Object.assign(i, { batch_id: b.id, status: 'batched' }); }
  for (const id of p_remove || []) { const i = I(id); if (i && i.batch_id === b.id) Object.assign(i, { batch_id: null, status: 'pool', count_found: null, count_qty: null, reval_value: null, keep_note: null }); }
  return 1; };
RPC.pm_lq_keep = ({ p_item, p_keep, p_note }) => { const i = I(p_item); Object.assign(i, { status: p_keep ? 'kept' : 'batched', keep_note: p_keep ? p_note : null }); return null; };
RPC.pm_lq_count = ({ p_item, p_found, p_qty, p_note }) => { const i = I(p_item), b = B(i.batch_id);
  if (b.status !== 'decided') err('Kiểm kê khi đợt đã ra Quyết định');
  if (p_found == null) Object.assign(i, { count_found: null, count_qty: null, count_note: null });
  else Object.assign(i, { count_found: p_found, count_qty: p_found ? (p_qty ?? i.qty) : 0, count_note: p_note, count_name: me().full_name, count_at: now() });
  return null; };
RPC.pm_lq_reval = ({ p_item, p_value, p_note }) => { const i = I(p_item); if (B(i.batch_id).status !== 'counted') err('Đánh giá lại khi đã kiểm kê xong'); i.reval_value = p_value; i.reval_note = p_note; return null; };
RPC.pm_lq_batch_move = ({ p_id, p_to }) => { const b = B(p_id), its = db.pm_lq_item.filter(i => i.batch_id === b.id && i.status === 'batched');
  const ok = { 'open>decided': 1, 'decided>counted': 1, 'counted>valued': 1, 'decided>open': 1, 'counted>decided': 1, 'valued>counted': 1, 'open>cancelled': 1 }[b.status + '>' + p_to];
  if (!ok) err(`Không chuyển được ${b.status} → ${p_to}`);
  if (p_to === 'decided' && b.status === 'open') { if (!its.length) err('Đợt chưa có món nào.'); if (!b.council_id) err('Chọn hội đồng.'); if (!b.meeting_date) err('Nhập ngày họp.'); b.decision_date = b.decision_date || b.meeting_date; }
  if (p_to === 'counted' && b.status === 'decided') { const n = its.filter(i => i.count_found == null).length; if (n) err(`Còn ${n} món chưa kiểm kê.`); b.count_date = b.count_date || now().slice(0, 10); }
  if (p_to === 'valued') { const n = its.filter(i => i.reval_value == null).length; if (n) err(`Còn ${n} món chưa đánh giá lại.`); b.valuation_date = b.valuation_date || now().slice(0, 10); }
  if (p_to === 'cancelled') for (const i of db.pm_lq_item.filter(i => i.batch_id === b.id)) Object.assign(i, { batch_id: null, status: 'pool' });
  b.status = p_to; return p_to; };
FK.save();
})();

;(() => {
const { db, RPC, me, now } = FK;
for (const k of ['pm_lq_buyer', 'pm_lq_quote', 'pm_lq_attend', 'pm_lq_event']) db[k] = db[k] || [];
const err = m => { const e = new Error(m); e.http = 400; throw e; };
const B = id => db.pm_lq_batch.find(b => b.id === id);
const log = (b, a, d) => db.pm_lq_event.push({ id: db.seq++, batch_id: b, at: now(), actor: me() ? me().full_name : 'buyer', action: a, detail: d || null });
const buyerOf = tok => { const v = db.pm_lq_buyer.find(x => x.token === tok); if (!v || v.revoked) err('Đường link không hợp lệ hoặc đã hết hạn.'); return v; };
RPC.pm_lq_call_open = ({ p_batch, p_deadline, p_terms }) => { const b = B(p_batch); const was = b.status; Object.assign(b, { status: 'bidding', call_deadline: p_deadline, call_terms: p_terms }); log(b.id, was === 'valued' ? 'call' : 'call_edit'); return null; };
RPC.pm_lq_call_cancel = ({ p_batch }) => { Object.assign(B(p_batch), { status: 'valued', call_deadline: null }); return null; };
RPC.pm_lq_buyer_add = ({ p_batch, p_name, p_phone, p_email }) => { const tok = 'tok' + db.seq; db.pm_lq_buyer.push({ id: db.seq++, batch_id: p_batch, token: tok, name: p_name, phone: p_phone, email: p_email,
  expires_at: new Date(Date.now() + 9 * 864e5).toISOString(), revoked: false, last_seen_at: null }); log(p_batch, 'invite', p_name); return tok; };
RPC.pm_lq_buyer_set = ({ p_buyer, p_revoke, p_new_token }) => { const v = db.pm_lq_buyer.find(x => x.id === p_buyer); if (p_revoke != null) v.revoked = p_revoke; if (p_new_token) { v.token = 'tok' + db.seq++; return v.token; } return null; };
RPC.pm_lq_bid_list = ({ p_batch }) => ({
  buyers: db.pm_lq_buyer.filter(v => v.batch_id === p_batch).map(v => { const q = db.pm_lq_quote.find(x => x.buyer_id === v.id);
    return Object.assign({}, v, { token: undefined, quote: q ? Object.assign({}, q, { data: q.opened_at ? q.data : null, files: q.opened_at ? q.files : null }) : null }); }),
  attend: db.pm_lq_attend.filter(a => a.batch_id === p_batch), events: db.pm_lq_event.filter(e => e.batch_id === p_batch) });
RPC.pm_lq_open = ({ p_batch, p_present, p_note }) => { const b = B(p_batch); const subs = db.pm_lq_quote.filter(q => q.batch_id === b.id && q.status === 'submitted');
  if (!subs.length) err('Chưa có báo giá nào đã nộp.');
  const mem = db.pm_lq_member.filter(m => m.council_id === b.council_id), here = mem.filter(m => p_present.includes(m.id));
  if (here.length * 2 <= mem.length) err(`Cần QUÁ 50% thành viên: ${here.length}/${mem.length}`);
  if (subs.length < 3 && !p_note) err('Ít hơn 3 báo giá — ghi giải trình.');
  db.pm_lq_attend = db.pm_lq_attend.filter(a => a.batch_id !== b.id).concat(mem.map(m => ({ batch_id: b.id, member_id: m.id, present: p_present.includes(m.id), by: me().full_name, at: now() })));
  for (const q of subs) q.opened_at = now(); b.opened_at = now(); b.open_note = p_note; log(b.id, 'open', subs.length + ' báo giá'); return subs.length; };
RPC.pm_lq_award = ({ p_batch, p_items }) => { const b = B(p_batch);
  for (const x of p_items) { const i = db.pm_lq_item.find(y => y.id === x.item_id);
    if (!x.outcome) Object.assign(i, { outcome: null, sale_quote_id: null, sale_price: null, sale_value: null, sale_cost: null, buyer: null, buyer_id: null, award_note: null });
    else if (x.outcome === 'destroy') Object.assign(i, { outcome: 'destroy', sale_quote_id: null, sale_price: null, sale_value: null, sale_cost: x.cost, buyer: null, buyer_id: null, award_note: x.note });
    else { if (!b.opened_at) err('Mở thầu trước.'); const q = db.pm_lq_quote.find(z => z.id === x.quote_id); const p = x.price ?? q.data.prices[i.id];
      const max = Math.max(...db.pm_lq_quote.filter(z => z.batch_id === b.id && z.opened_at).map(z => +z.data.prices[i.id] || 0));
      if (p < max && !x.note) err(`${i.asset_code || i.name} không chọn giá cao nhất (${max}) — ghi lý do.`);
      Object.assign(i, { outcome: 'sale', sale_quote_id: q.id, sale_price: p, sale_value: p * (i.count_qty ?? i.qty), sale_cost: x.cost, buyer: q.data.name,
        buyer_id: q.data.kind === 'company' ? q.data.tax_code : q.data.id_no, award_note: x.note }); } }
  log(b.id, 'award', p_items.length + ' món'); return p_items.length; };
RPC.pm_lq_buyer_doc = ({ p_quote, p_patch }) => { Object.assign(db.pm_lq_quote.find(q => q.id === p_quote), p_patch); return null; };
RPC.pm_lq_close = ({ p_batch, p_date }) => { const b = B(p_batch), its = db.pm_lq_item.filter(i => i.batch_id === b.id && i.status === 'batched');
  const left = its.filter(i => i.count_found !== false && !i.outcome).length; if (left) err(`Còn ${left} món chưa có kết quả.`);
  const bad = its.filter(i => i.outcome === 'sale').map(i => db.pm_lq_quote.find(q => q.id === i.sale_quote_id)).filter(q => !q.invoice_no || !q.gate_ok);
  if (bad.length) err('Thiếu số hoá đơn GTGT hoặc Gate pass: ' + [...new Set(bad.map(q => q.data.name))].join(', '));
  for (const i of its) { const a = db.am_asset.find(x => x.id === i.asset_id);
    if (a) a.status_code = i.count_found === false ? (a.asset_kind === 'unique' ? '0' : a.status_code) : a.asset_kind === 'low' ? '23' : i.outcome === 'sale' ? '7' : '9';
    i.status = i.count_found === false ? 'lost' : i.outcome === 'sale' ? 'sold' : 'destroyed'; }
  Object.assign(b, { status: 'closed', liquidation_date: p_date || now().slice(0, 10), closed_at: now() }); log(b.id, 'close'); return null; };
// The buyer's side.
RPC.vq_session = ({ p_token }) => { const v = buyerOf(p_token), b = B(v.batch_id), q = db.pm_lq_quote.find(x => x.buyer_id === v.id);
  return { buyer: v.name, phone: v.phone, email: v.email, expires_at: v.expires_at, batch: b.code, deadline: b.call_deadline, terms: b.call_terms,
    accepting: b.status === 'bidding' && !b.opened_at,
    items: db.pm_lq_item.filter(i => i.batch_id === b.id && i.status === 'batched' && i.mode === 'Sale' && i.count_found !== false)
      .map(i => ({ id: i.id, name: i.name, asset_code: i.asset_code, qty: i.count_qty ?? i.qty, unit: i.unit, condition: i.condition, dept: i.dept_code })),
    quote: q ? { status: q.status, version: q.version, data: q.data, files: q.files || [], submitted_at: q.submitted_at } : null }; };
RPC.vq_save = ({ p_token, p_data }) => { const v = buyerOf(p_token); let q = db.pm_lq_quote.find(x => x.buyer_id === v.id);
  if (!q) db.pm_lq_quote.push(q = { id: db.seq++, batch_id: v.batch_id, buyer_id: v.id, status: 'draft', version: 0, files: [], gate_ok: false });
  Object.assign(q, { data: p_data, status: 'draft' }); return null; };
RPC.vq_submit = ({ p_token }) => { const v = buyerOf(p_token), q = db.pm_lq_quote.find(x => x.buyer_id === v.id), d = q.data;
  if (!['person', 'company'].includes(d.kind) || !d.name || !d.phone || !d.address) err('Nhập họ tên, địa chỉ và điện thoại.');
  if (d.kind === 'person' && !d.id_no) err('Nhập số CCCD.');
  if (!Object.values(d.prices || {}).some(p => +p > 0)) err('Nhập đơn giá cho ít nhất một món.');
  if (!d.agree) err('Xác nhận cam kết trước khi nộp.');
  Object.assign(q, { status: 'submitted', version: q.version + 1, submitted_at: now() }); log(v.batch_id, 'submit', 'v' + q.version); return null; };
FK.save();
})();

;(() => {
const { db, RPC, me, now } = FK;
for (const k of ['am_acc_import', 'am_acc_stage', 'am_acc_line', 'am_acc_change', 'am_acc_link', 'am_acc_alias']) db[k] = db[k] || [];
const err = m => { const e = new Error(m); e.http = 400; throw e; };
const refresh = ids => { for (const a of db.am_asset.filter(x => ids.includes(x.id))) {
  const ks = db.am_acc_link.filter(k => k.asset_id === a.id);
  if (!ks.length) { if (a.fin_status !== 'off') Object.assign(a, { fin_status: null, fin_cost: null, fin_nbv: null }); continue; }
  let unknown = false, cost = 0, nbv = 0;
  for (const k of ks) { const l = db.am_acc_line.find(x => x.id === k.line_id), n = db.am_acc_link.filter(x => x.line_id === k.line_id).length;
    if (n > 1 && k.share == null) unknown = true; else { cost += (+l.cost || 0) * (n === 1 ? 1 : k.share); nbv += (+l.nbv || 0) * (n === 1 ? 1 : k.share); } }
  Object.assign(a, { fin_status: unknown ? 'linked' : 'booked', fin_cost: unknown ? null : cost, fin_nbv: unknown ? null : nbv }); } };
RPC.am_acc_import_begin = ({ p_kind, p_period, p_file, p_sheet }) => { const i = { id: db.seq++, kind: p_kind, period: p_period, file_name: p_file, sheet: p_sheet, status: 'loading', rows_in: 0, stats: {}, imported_name: me().full_name, imported_at: now() };
  db.am_acc_import.push(i); return i.id; };
RPC.am_acc_import_rows = ({ p_import, p_rows }) => { const n0 = db.am_acc_stage.filter(s => s.import_id === p_import).length; p_rows.forEach((r, i) => db.am_acc_stage.push({ import_id: p_import, n: n0 + i + 1, row: r, done: false })); return p_rows.length; };
RPC.am_acc_import_finish = ({ p_import, p_limit }) => { const im = db.am_acc_import.find(i => i.id === p_import); const st = im.stats;
  const todo = db.am_acc_stage.filter(s => s.import_id === p_import && !s.done).slice(0, p_limit || 600);
  for (const s of todo) { const r = s.row; let l = db.am_acc_line.find(x => x.kind === im.kind && x.line_key === r.line_key);
    if (!l) { l = { id: db.seq++, kind: im.kind, line_key: r.line_key, first_seen: im.period, scope: r.skip ? 'skip' : 'in', skip_reason: r.skip || null }; db.am_acc_line.push(l); st.new = (st.new || 0) + 1; }
    else if (+l.cost !== +r.cost) { db.am_acc_change.push({ id: db.seq++, line_id: l.id, period: im.period, field: 'cost', old_val: String(Math.round(l.cost)), new_val: String(Math.round(r.cost)) }); st.changed = (st.changed || 0) + 1; }
    else st.same = (st.same || 0) + 1;
    const { skip, ...rest } = r; Object.assign(l, rest, { last_seen: im.period, status: 'active' }); s.done = true; }
  const left = db.am_acc_stage.filter(s => s.import_id === p_import && !s.done).length;
  if (left) return Object.assign({}, st, { more: true, left });
  let gone = 0; for (const l of db.am_acc_line.filter(x => x.kind === im.kind && x.status === 'active' && x.last_seen < im.period)) { l.status = 'gone'; gone++; }
  let auto = 0; for (const l of db.am_acc_line.filter(x => x.kind === im.kind && x.last_seen === im.period && x.acc_code)) for (const tok of l.acc_code.toUpperCase().split(/[;,\s]+/)) {
    const a = db.am_asset.find(x => x.asset_code.toUpperCase() === tok); if (a && !db.am_acc_link.some(k => k.line_id === l.id && k.asset_id === a.id)) { db.am_acc_link.push({ line_id: l.id, asset_id: a.id, share: null, method: 'code' }); auto++; refresh([a.id]); } }
  db.am_acc_stage = db.am_acc_stage.filter(s => s.import_id !== p_import);
  Object.assign(im, { status: 'done', rows_in: todo.length, stats: Object.assign(st, { gone, autolinked: auto }) });
  return Object.assign({}, im.stats, { more: false }); };
RPC.am_acc_link_set = ({ p_pairs, p_method }) => { let n = 0; for (const p of p_pairs) { if (!db.am_acc_link.some(k => k.line_id === p.line_id && k.asset_id === p.asset_id)) { db.am_acc_link.push({ line_id: p.line_id, asset_id: p.asset_id, share: null, method: p_method }); n++; }
  const a = db.am_asset.find(x => x.id === p.asset_id); if (p.desc_norm && a) { const e = db.am_acc_alias.find(x => x.desc_norm === p.desc_norm); const name = [a.name_vi, a.name_en].filter(Boolean).join('/'); if (e) e.name = name; else db.am_acc_alias.push({ desc_norm: p.desc_norm, name }); }
  if (a && a.fin_status === 'off') a.fin_status = null; }
  refresh(p_pairs.map(p => p.asset_id)); return n; };
RPC.am_acc_unlink = ({ p_pairs }) => { const ids = []; for (const p of p_pairs) { db.am_acc_link = db.am_acc_link.filter(k => !(k.line_id === p.line_id && k.asset_id === p.asset_id)); ids.push(p.asset_id);
  for (const k of db.am_acc_link.filter(k => k.line_id === p.line_id)) { k.share = null; ids.push(k.asset_id); } } refresh(ids); return p_pairs.length; };
RPC.am_acc_allocate = ({ p_line, p_mode, p_shares }) => { const ks = db.am_acc_link.filter(k => k.line_id === p_line);
  if (p_mode === 'manual') { const sum = Object.values(p_shares || {}).reduce((s, v) => s + +v, 0); if (Math.abs(sum - 1) > 0.001) err('Tổng tỷ lệ phải bằng 100% (đang ' + Math.round(sum * 10000) / 100 + ').'); ks.forEach(k => k.share = +(p_shares[String(k.asset_id)])); }
  else if (p_mode === 'clear') ks.forEach(k => k.share = null);
  else if (p_mode === 'equal') ks.forEach(k => k.share = 1 / ks.length);
  else { const tot = ks.reduce((s, k) => { const a = db.am_asset.find(x => x.id === k.asset_id); return s + (+a.unit_price || 0) * (+a.qty || 1); }, 0);
    if (!tot) err('Các tài sản chưa có giá tạm'); ks.forEach(k => { const a = db.am_asset.find(x => x.id === k.asset_id); k.share = (+a.unit_price || 0) * (+a.qty || 1) / tot; }); }
  refresh(ks.map(k => k.asset_id)); return null; };
RPC.am_acc_scope = ({ p_lines, p_skip, p_reason }) => { for (const l of db.am_acc_line.filter(x => p_lines.includes(x.id))) Object.assign(l, { scope: p_skip ? 'skip' : 'in', skip_reason: p_skip ? p_reason : null }); return null; };
RPC.am_acc_asset_off = ({ p_assets, p_off, p_note }) => { for (const a of db.am_asset.filter(x => p_assets.includes(x.id))) Object.assign(a, { fin_status: p_off ? 'off' : null, fin_note: p_off ? p_note : null }); return null; };
// Register seed: 2026 provisional assets of two projects, and a few 2023 ones.
if (!db.am_asset.some(a => a.id === 1101)) db.am_asset.push(
  { id: 1101, asset_code: 'KIT.C212.OME.2026.00101', barcode: 'JVC.000001101', asset_kind: 'unique', dept_code: 'KIT', name_vi: 'Máy rửa chén', name_en: 'Dishwasher', unit_price: 245000000, qty: 1, purpose_code: 'FFE.KIT.02.2025', supplier: 'ABC Co', purchase_date: '2026-02-10', purchase_year: 2026, created_at: '2026-02-10T08:00:00Z', status_code: '1', is_legacy: false },
  { id: 1102, asset_code: 'KIT.C212.OME.2026.00102', barcode: 'JVC.000001102', asset_kind: 'unique', dept_code: 'KIT', name_vi: 'Máy rửa chén', name_en: 'Dishwasher', unit_price: 245000000, qty: 1, purpose_code: 'FFE.KIT.02.2025', supplier: 'ABC Co', purchase_date: '2026-02-10', purchase_year: 2026, created_at: '2026-02-10T08:00:00Z', status_code: '1', is_legacy: false },
  { id: 1103, asset_code: 'HKP.C300.KES.2026.00007', barcode: 'JVC.900001103', asset_kind: 'low', dept_code: 'HKP', name_vi: 'Kệ inox', name_en: 'Steel shelf', unit_price: 1050000, qty: 20, purpose_code: 'FFE.HKP.05.2026', purchase_date: '2026-03-05', purchase_year: 2026, created_at: '2026-03-05T08:00:00Z', status_code: '20', is_legacy: false },
  { id: 1104, asset_code: 'ENG.C100.DHO.2026.00003', barcode: 'JVC.000001104', asset_kind: 'unique', dept_code: 'ENG', name_vi: 'Điều hòa không khí', name_en: 'Air conditioner', unit_price: 38000000, qty: 1, purpose_code: 'FFE.ENG.08.2026', purchase_date: '2026-06-01', purchase_year: 2026, created_at: '2026-06-01T08:00:00Z', status_code: '120', is_legacy: false },
  { id: 1105, asset_code: 'CEN.C100.QUA.2023.00011', barcode: 'P0001105', asset_kind: 'unique', dept_code: 'CEN', name_vi: 'Quạt hút khói', name_en: 'Smoke exhaust fan', unit_price: 60000000, qty: 1, purpose_code: 'FFE.CP.10.2024', purchase_date: '2024-08-01', purchase_year: 2024, created_at: '2025-01-01T08:00:00Z', status_code: '7', is_legacy: true },
  { id: 1106, asset_code: 'CEN.C100.QUA.2023.00012', barcode: 'P0001106', asset_kind: 'unique', dept_code: 'CEN', name_vi: 'Quạt hút khói', name_en: 'Smoke exhaust fan', unit_price: 60000000, qty: 1, purpose_code: 'FFE.CP.10.2024', purchase_date: '2024-08-01', purchase_year: 2024, created_at: '2025-01-01T08:00:00Z', status_code: '1', is_legacy: true });
FK.save();
// Synthetic accounting workbooks in the three layouts (made-up data).
window.__mkBooks = (ym) => {
  const serial = d => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5 + 25569);
  const monthEnds = []; for (let m = 1; m <= 12; m++) monthEnds.push(serial(new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10)));
  // FA "Details": rows 5-6 header, data from row 7; blocks Term / Monthly Dep / Residual from column GJ-like offset 40.
  const fa = []; fa[1] = []; fa[1][3] = 'ASSET CHECK LIST';
  const H5 = []; H5[0] = 'Code'; H5[5] = 'Account'; H5[8] = 'Mã TS mới'; H5[12] = 'Tên TS chuẩn hóa';
  const H6 = ['S/C/J', 'Tổ chức', 'Nhóm', 'Loại', 'Full code', 'De', 'Cre', 'Cost', null, null, null, null, null, 'Description', 'USD', 'Ex', 'VND ', 'Qty', 'Detail', 'Docs', 'MST', 'Supplier', 'Contract', 'Situation', 'Location', 'Notes', 'Liquidation No.', 'Being used at', 'Term'];
  monthEnds.forEach((d, i) => { H5[40 + i * 3] = d; H6[40 + i * 3] = 'Term'; H6[41 + i * 3] = 'Monthly Dep'; H6[42 + i * 3] = 'Residual value '; });
  fa[4] = H5; fa[5] = H6;
  const faRow = (dept, desc, cost, start, term, docs, sup, code, liq) => { const r = []; Object.assign(r, { 0: 'S', 1: dept, 2: 'T', 3: '001', 5: '21141', 6: '214141', 7: '642441', 13: desc, 16: cost, 17: 1, 19: docs, 21: sup, 26: liq || null, 27: serial(start), 28: term });
    if (code) r[8] = code; monthEnds.forEach((d, i) => { const m = i + 1 - (+start.slice(5, 7)) + 1; r[40 + i * 3] = m; r[41 + i * 3] = Math.round(cost / term); r[42 + i * 3] = Math.max(0, cost - Math.round(cost / term) * Math.max(0, m)); }); return r; };
  fa.push(faRow('KIT', 'Dishwasher Hobart AM-15 (2 units) / Máy rửa chén', 490000000, '2026-03-01', 60, 'FFE.KIT.02.2025', 'ABC Co'));
  fa.push(faRow('ENG', 'Air-conditioner Daikin 5HP / Điều hòa', 38500000, '2026-07-01', 60, 'FFE.ENG.08.2026', 'Daikin VN'));
  fa.push(faRow('CEN', 'Corridor smoke extraction fan / Quạt hút khói hành lang', 60000000, '2024-09-01', 120, 'FFE.CP.10.2024 - Corridor smoke extraction', 'Cơ điện X'));
  fa.push(faRow('CEN', 'Corridor smoke extraction fan / Quạt hút khói hành lang', 60000000, '2024-09-01', 120, 'FFE.CP.10.2024 - Corridor smoke extraction', 'Cơ điện X'));
  fa.push(faRow('ADM', 'Right to use land', 110598042024, '1992-04-17', 600, '', ''));
  fa.push(faRow('FIN', 'E-invoice system / Phần mềm hoá đơn điện tử', 72100000, '2025-05-01', 60, 'FFE.FIN.IT.03.2025', 'Soft Co'));
  fa.push(faRow('HKP', 'Guest room carpet 1999', 45000000, '1999-01-01', 180, '', ''));
  // CCDC 2422: header on row 23 (index 22), dates on row 22 at each "Debit".
  const cc = []; cc[1] = []; cc[1][1] = 'ALLOCATION TABLE';
  const U = [], H = [null, 'Tổ chức', 'Nhóm', 'Loại', null, 'Description', 'Qty', 'Unit', 'Doc', 'Project', 'Tax code', 'Supplier', 'Contract No.', 'Location', 'Others', 'Beginning', 'Month', 'Price', 'Asset value', 'Allocation', 'Accumulation', 'Residuals'];
  U[1] = 'Code'; monthEnds.forEach((d, i) => { U[22 + i * 5] = d; H[22 + i * 5] = 'Debit'; H[23 + i * 5] = 'Credit'; H[24 + i * 5] = 'Term'; H[25 + i * 5] = 'Allocation'; H[26 + i * 5] = 'Residuals'; });
  cc[21] = U; cc[22] = H;
  const ccRow = (dept, desc, price, start, term, doc, proj, loc) => { const r = []; Object.assign(r, { 1: dept, 2: 'E', 3: '001', 5: desc, 6: 1, 7: 'pcs', 8: doc, 9: proj, 13: loc, 15: serial(start), 16: term, 17: price, 18: price });
    monthEnds.forEach((d, i) => { const m = i + 1 - (+start.slice(5, 7)) + 1; r[22 + i * 5] = 2422; r[24 + i * 5] = m; r[25 + i * 5] = Math.round(price / term); r[26 + i * 5] = Math.max(0, price - Math.round(price / term) * Math.max(0, m)); }); return r; };
  for (let i = 0; i < 20; i++) cc.push(ccRow('HKP', 'Steel shelves 1200*610 mm/Kệ inox', 1050000, '2026-04-01', 36, 'PKT2604002', 'FFE.HKP.05.2026', 'S2003'));
  cc.push(ccRow('FBD', 'Wine glass Riedel / Ly vang', 350000, '2026-05-01', 24, 'UNC2605011', '', 'S114'));
  // Short-term 2421: header row 6 (index 5); E rows are tools, O rows services.
  const st = []; st[1] = []; st[1][1] = 'Short-term Prepayment';
  const SU = [], SH = [null, 'Tổ chức', 'Nhóm', 'Loại', 'Description', 'Qty', 'Unit', 'Doc', 'Project', 'Tax code', 'Supplier', 'Contract No.', 'Location', 'Others', 'Beginning', 'Month', 'Asset value', 'Accumlation', 'Residual value'];
  monthEnds.forEach((d, i) => { SU[19 + i * 5] = d; SH[19 + i * 5] = 'Debit'; SH[20 + i * 5] = 'Credit'; SH[21 + i * 5] = 'Tern'; SH[22 + i * 5] = 'Allocation'; SH[23 + i * 5] = 'Residuals'; });
  st[4] = SU; st[5] = SH;
  st.push(Object.assign([], { 1: 'FIN', 2: 'O', 4: 'Staff insurance 2026', 5: 1, 6: 'package', 14: serial('2026-01-01'), 15: 12, 16: 60000000 }));
  st.push(Object.assign([], { 1: 'KIT', 2: 'E', 4: 'Kitchen knives set / Bộ dao bếp', 5: 1, 6: 'set', 14: serial('2026-06-01'), 15: 12, 16: 8400000 }));
  const book = (rows, name) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows.map(r => r || [])), name); return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], `${name === 'Details' ? 'ASSET DEPRECIATION - updated ' : name === '2422' ? 'Long-term prepayment - ' : 'Short-term prepayment - '}${ym}.xlsx`); };
  return [book(fa, 'Details'), book(cc, '2422'), book(st, '2023 + 2024 + 2025')];
};
})();

;(() => {
// Fake 31_asset_ops.sql: simplified copies of the RPCs, enough to drive the screens.
const { db, RPC, save, me, now, users } = FK;
if (!users.some(u => u.id === 'u11')) users.push({ id: 'u11', email: 'enghead@x', full_name: 'Trưởng BP Kỹ thuật', active: true, roles: [['DEPT_HEAD', 'ENG']] });
const err = m => { const e = new Error(m); throw e; };
for (const k of ['am_transfer', 'am_transfer_line', 'am_incident', 'am_count', 'am_count_line', 'am_report_snap', 'am_location']) db[k] = db[k] || [];
if (!db.am_location.length) db.am_location.push({ code: 'KIT-01', name: 'Bếp chính', dept_code: 'KIT', active: true }, { code: 'KIT-02', name: 'Kho bếp', dept_code: 'KIT', active: true },
  { code: 'ENG-01', name: 'Xưởng kỹ thuật', dept_code: 'ENG', active: true }, { code: 'HKP-01', name: 'Kho buồng', dept_code: 'HKP', active: true });
if (!db.am_org.some(o => o.code === 'ENG')) db.am_org.push({ code: 'ENG', name_vi: 'Kỹ thuật', name_en: 'Engineering', parent_code: 'SOF', is_department: true, is_company: false });
if (!db.am_org.some(o => o.code === 'HKP')) db.am_org.push({ code: 'HKP', name_vi: 'Buồng', name_en: 'Housekeeping', parent_code: 'SOF', is_department: true, is_company: false });
const org = c => db.am_org.find(o => o.code === c);
const covers = (scope, dept) => { if (org(scope) && !org(scope).parent_code) return true; let o = org(dept), g = 0; while (o && g++ < 10) { if (o.code === scope) return true; o = org(o.parent_code); } return false; };
const isActor = (roles, dept, u = me()) => u.roles.some(([r, s]) => roles.includes(r) && covers(s, dept));
const entity = dept => { let o = org(dept); while (o) { if (o.code === 'SOF') return 'SSP'; if (o.code === 'CP') return 'CP'; if (o.code === 'JVC') return 'JVC'; o = org(o.parent_code); } return null; };
const nm = () => me().full_name;
const alive = s => !['0', '7', '9', '23'].includes(String(s || ''));
const notify = (uids, kind, no, type, dept, comment) => { db.pm_notice = db.pm_notice || [];
  for (const u of uids) if (u !== me().id) db.pm_notice.push({ id: db.seq++, user_id: u, kind, doc_no: no, doc_type: type, project_code: dept, actor_email: me().email, comment, created_at: now(), read_at: null }); };
const actors = (roles, dept) => users.filter(u => isActor(roles, dept, u)).map(u => u.id);
const steps = (f, t) => { const s = [{ key: 'from', roles: ['DEPT_HEAD'], dept: f }]; if (t !== f) s.push({ key: 'to', roles: ['DEPT_HEAD'], dept: t });
  if (entity(f) !== entity(t)) s.push({ key: 'jvc', roles: ['JVC_GM'], dept: f }); s.push({ key: 'am', roles: ['AM_EXEC', 'AM_COORD'], dept: f }); return s; };
const A = id => db.am_asset.find(a => a.id === id);

RPC.am_tf_save = ({ p_id, p_data: d }) => {
  const from = d.from_dept, to = d.to_dept || from;
  if (to === from && !d.to_location) err('Chọn phòng ban nhận khác hoặc vị trí mới.');
  if (!(d.lines || []).length) err('Phiếu chưa có tài sản nào.');
  let t;
  if (!p_id) { const yr = String(d.tf_date || now()).slice(0, 4), n = db.am_transfer.filter(x => x.from_dept === from && x.no.endsWith('.' + yr)).length + 1;
    t = { id: db.seq++, no: `TF.${from}.${String(n).padStart(3, '0')}.${yr}`, from_dept: from, status: 'draft', steps: [], cur: null, created_by: me().id, created_name: nm(), created_at: now() };
    db.am_transfer.push(t);
  } else { t = db.am_transfer.find(x => x.id === p_id); if (!['draft', 'returned'].includes(t.status)) err('Phiếu đã gửi.'); db.am_transfer_line = db.am_transfer_line.filter(l => l.transfer_id !== t.id); }
  Object.assign(t, { to_dept: to, to_location: d.to_location || null, reason: d.reason, tf_date: d.tf_date });
  for (const l of d.lines) { const a = A(l.asset_id); if (a.dept_code !== from) err(`Tài sản ${a.asset_code} thuộc phòng ban ${a.dept_code}`);
    if (a.asset_kind === 'low' && l.qty != null && (l.qty <= 0 || l.qty > a.qty)) err(`Số lượng chuyển của ${a.asset_code} phải từ 0 đến ${a.qty}.`);
    db.am_transfer_line.push({ id: db.seq++, transfer_id: t.id, asset_id: a.id, qty: a.asset_kind === 'low' ? l.qty : null, note: l.note }); }
  return t.id;
};
RPC.am_tf_submit = ({ p_id }) => { const t = db.am_transfer.find(x => x.id === p_id); t.status = 'pending'; t.steps = steps(t.from_dept, t.to_dept); t.cur = 0; t.submitted_at = now();
  notify(actors(t.steps[0].roles, t.steps[0].dept), 'todo', t.no, 'TF', t.from_dept, t.reason); return null; };
RPC.am_tf_inbox = () => db.am_transfer.filter(t => t.status === 'pending' && isActor(t.steps[t.cur].roles, t.steps[t.cur].dept) && t.created_by !== me().id);
RPC.am_tf_act = ({ p_id, p_action, p_comment }) => {
  const t = db.am_transfer.find(x => x.id === p_id), s = t.steps[t.cur];
  if (!isActor(s.roles, s.dept)) err('Bước này không phải của bạn.');
  if (t.created_by === me().id) err('Người lập không duyệt phiếu của mình.');
  Object.assign(s, { by: me().id, name: nm(), at: now(), action: p_action, comment: p_comment });
  let rel = null;
  if (p_action === 'return') { t.status = 'returned'; t.cur = null; notify([t.created_by], 'returned', t.no, 'TF', t.from_dept, p_comment); }
  else if (p_action === 'reject') { t.status = 'rejected'; t.cur = null; }
  else if (t.cur === t.steps.length - 1) {
    rel = 0;
    for (const l of db.am_transfer_line.filter(x => x.transfer_id === t.id)) {
      const a = A(l.asset_id); l.old_code = a.asset_code;
      if (a.asset_kind === 'low' && l.qty != null && l.qty < a.qty) {
        a.qty -= l.qty; const n = Object.assign({}, a, { id: db.seq++, qty: l.qty, barcode: 'JVC.9' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
          dept_code: t.to_dept, asset_code: a.asset_code.replace(/^[^.]+/, t.to_dept).replace(/\d{5}$/, String(90000 + db.seq).slice(-5)), location_code: t.to_location || a.location_code, label_printed: false });
        db.am_asset.push(n); l.new_code = n.asset_code; l.new_asset_id = n.id; rel++;
      } else if (t.to_dept !== t.from_dept && !a.is_legacy) {
        if (a.label_printed) rel++;
        Object.assign(a, { dept_code: t.to_dept, asset_code: a.asset_code.replace(/^[^.]+/, t.to_dept).replace(/\d{5}$/, String(80000 + db.seq++).slice(-5)), location_code: t.to_location || a.location_code, label_printed: false });
        l.new_code = a.asset_code;
      } else { Object.assign(a, { dept_code: t.to_dept, location_code: t.to_location || a.location_code }); l.new_code = a.asset_code; }
    }
    Object.assign(t, { status: 'done', cur: null, done_at: now(), relabel: rel });
    notify([t.created_by], 'approved', t.no, 'TF', t.from_dept, p_comment);
  } else { t.cur++; notify(actors(t.steps[t.cur].roles, t.steps[t.cur].dept), 'todo', t.no, 'TF', t.from_dept, t.reason); }
  return { status: t.status, relabel: rel };
};
RPC.am_tf_cancel = ({ p_id }) => { const t = db.am_transfer.find(x => x.id === p_id); t.status = 'cancelled'; t.cur = null; return null; };

RPC.am_inc_report = ({ p_data: d }) => {
  const a = A(d.asset_id); if (!alive(a.status_code)) err('đã mất / thanh lý');
  if (db.am_incident.some(i => i.asset_id === a.id && i.kind === d.kind && ['open', 'in_progress'].includes(i.status))) err(`Tài sản ${a.asset_code} đang có sự cố cùng loại chưa đóng.`);
  const id = db.seq++;
  db.am_incident.push({ id, no: `SC.${String(d.reported_at || now()).slice(0, 4)}.${String(id).padStart(5, '0')}`, asset_id: a.id, dept_code: a.dept_code, kind: d.kind,
    qty: a.asset_kind === 'low' ? (d.qty ?? a.qty) : null, status: 'open', reported_at: d.reported_at || now().slice(0, 10), description: d.description, cause: d.cause, wo_no: d.wo_no,
    vendor: d.vendor, warranty: d.warranty, prev_status: a.status_code, created_by: me().id, created_name: nm(), created_at: now(), count_id: d.count_id || null });
  if (['repair', 'breakage'].includes(d.kind) && !['3', '4', '5', '6', '25', '8', '24'].includes(String(a.status_code))) a.status_code = a.asset_kind === 'unique' ? '3' : '25';
  notify(actors(['AM_EXEC', 'AM_COORD'], a.dept_code), 'todo', db.am_incident.find(i => i.id === id).no, 'SC', a.dept_code, d.description);
  return id;
};
RPC.am_inc_update = ({ p_id, p_data: d }) => { const i = db.am_incident.find(x => x.id === p_id);
  for (const k of ['wo_no', 'vendor', 'warranty', 'cost', 'description', 'cause', 'lr_doc_no']) if (k in d) i[k] = d[k];
  if (d.start && i.status === 'open') { i.status = 'in_progress'; i.started_at = now(); const a = A(i.asset_id); if (a.asset_kind === 'unique') a.status_code = i.kind === 'maintenance' ? '6' : '5'; }
  return null; };
RPC.am_inc_close = ({ p_id, p_outcome, p_note, p_cost }) => { const i = db.am_incident.find(x => x.id === p_id), a = A(i.asset_id);
  const back = alive(i.prev_status) && !['3', '4', '5', '6', '25', ''].includes(String(i.prev_status || '')) ? i.prev_status : a.asset_kind === 'unique' ? '1' : '20';
  if (['fixed', 'no_fault'].includes(p_outcome)) { if (['3', '5', '6', '25'].includes(String(a.status_code))) a.status_code = back; }
  else if (['replace', 'liquidate'].includes(p_outcome)) a.status_code = a.asset_kind === 'unique' ? '4' : '25';
  else if (a.asset_kind === 'unique') a.status_code = '0'; else { a.qty = Math.max(0, a.qty - (i.qty ?? a.qty)); if (!a.qty) a.status_code = '21'; }
  Object.assign(i, { status: 'closed', outcome: p_outcome, outcome_note: p_note, cost: p_cost ?? i.cost, closed_at: now(), closed_name: nm() }); return null; };
RPC.am_inc_cancel = ({ p_id }) => { const i = db.am_incident.find(x => x.id === p_id); i.status = 'cancelled'; const a = A(i.asset_id); if (['3', '5', '6', '25'].includes(String(a.status_code))) a.status_code = i.prev_status; return null; };

RPC.am_count_save = ({ p_id, p_data: d }) => {
  if (!(d.depts || []).length) err('Chọn ít nhất một bộ phận.');
  let c = p_id && db.am_count.find(x => x.id === p_id);
  if (!c) { const yr = String(d.count_date).slice(0, 4); c = { id: db.seq++, code: `KK.${yr}.${String(db.am_count.filter(x => x.code.includes('.' + yr + '.')).length + 1).padStart(2, '0')}`, status: 'draft', created_name: nm(), created_at: now() }; db.am_count.push(c); }
  Object.assign(c, { title: d.title, depts: d.depts, locations: (d.locations || []).length ? d.locations : null, count_date: d.count_date, members: d.members || [], note: d.note });
  return c.id; };
RPC.am_count_open = ({ p_id }) => { const c = db.am_count.find(x => x.id === p_id); let n = 0;
  for (const a of db.am_asset.filter(a => c.depts.includes(a.dept_code) && (!c.locations || c.locations.includes(a.location_code)) && alive(a.status_code))) {
    db.am_count_line.push({ id: db.seq++, count_id: c.id, asset_id: a.id, barcode: a.barcode, asset_code: a.asset_code, name: [a.name_vi, a.name_en].filter(Boolean).join(' / '), kind: a.asset_kind,
      dept_code: a.dept_code, loc_book: a.location_code, qty_book: a.qty, status_book: a.status_code, extra: false, found: null }); n++; }
  Object.assign(c, { status: 'open', opened_at: now() }); return n; };
RPC.am_count_scan = ({ p_id, p_code, p_loc }) => { const q = p_code.toUpperCase();
  let l = db.am_count_line.find(x => x.count_id === p_id && (String(x.barcode).toUpperCase() === q || String(x.asset_code).toUpperCase() === q));
  if (l) { Object.assign(l, { found: true, qty_found: l.qty_found ?? l.qty_book, loc_found: p_loc || l.loc_found || l.loc_book, by_name: nm(), at: now() }); return Object.assign({ hit: 'list' }, l); }
  const a = db.am_asset.find(x => String(x.barcode).toUpperCase() === q || String(x.asset_code).toUpperCase() === q);
  l = { id: db.seq++, count_id: p_id, asset_id: a ? a.id : null, barcode: a ? a.barcode : q, asset_code: a ? a.asset_code : null, name: a ? [a.name_vi, a.name_en].filter(Boolean).join(' / ') : '',
        kind: a ? a.asset_kind : null, dept_code: a ? a.dept_code : null, loc_book: a ? a.location_code : null, qty_book: a ? a.qty : null, extra: true, found: true, qty_found: a ? a.qty : 1, loc_found: p_loc, by_name: nm(), at: now() };
  db.am_count_line.push(l); return Object.assign({ hit: a ? 'extra' : 'unknown' }, l); };
RPC.am_count_mark = ({ p_line, p_found, p_qty, p_loc, p_cond, p_note }) => { const l = db.am_count_line.find(x => x.id === p_line);
  if (p_found == null && l.extra) { db.am_count_line = db.am_count_line.filter(x => x.id !== l.id); return null; }
  Object.assign(l, { found: p_found, qty_found: p_found == null ? null : !p_found ? 0 : l.kind === 'unique' ? 1 : (p_qty ?? l.qty_found ?? l.qty_book),
    loc_found: p_found ? (p_loc || l.loc_found || l.loc_book) : null, cond: p_found ? p_cond : null, note: p_found == null ? null : p_note, by_name: p_found == null ? null : nm(), at: p_found == null ? null : now() });
  return null; };
RPC.am_count_close = ({ p_id, p_apply: ap }) => { const c = db.am_count.find(x => x.id === p_id), L = () => db.am_count_line.filter(l => l.count_id === c.id);
  if (ap.pending_missing !== false) for (const l of L()) if (l.found == null) Object.assign(l, { found: false, qty_found: 0, note: l.note || 'Chưa kiểm khi đóng đợt' });
  let m = 0, lo = 0, d = 0;
  for (const l of L().filter(l => l.asset_id)) { const a = A(l.asset_id);
    if (ap.move && l.found && !l.extra && l.loc_found && l.loc_found !== l.loc_book) { a.location_code = l.loc_found; l.action = 'moved'; m++; }
    if (ap.lost && ((l.found === false && !l.extra) || (l.found && l.kind === 'low' && l.qty_found < l.qty_book)) && alive(a.status_code)) {
      const id = RPC.am_inc_report({ p_data: { asset_id: a.id, kind: 'loss', reported_at: c.count_date, qty: l.kind === 'low' ? l.qty_book - (l.qty_found || 0) : null, description: 'Không thấy khi kiểm kê ' + c.code, count_id: c.id } });
      l.action = 'incident:' + id; lo++; }
    if (ap.damaged && l.found && l.cond === 'damaged') { const id = RPC.am_inc_report({ p_data: { asset_id: a.id, kind: 'repair', reported_at: c.count_date, description: l.note || 'Hư hỏng khi kiểm kê', count_id: c.id } }); l.action = (l.action ? l.action + ' ' : '') + 'incident:' + id; d++; }
  }
  const own = L().filter(l => !l.extra);
  const s = { total: own.length, found: own.filter(l => l.found).length, missing: own.filter(l => l.found === false).length, short: own.filter(l => l.found && l.kind === 'low' && l.qty_found < l.qty_book).length,
              moved: own.filter(l => l.found && l.loc_found && l.loc_found !== l.loc_book).length, extra: L().filter(l => l.extra).length, damaged: L().filter(l => l.cond === 'damaged').length,
              applied: { moved: m, lost: lo, damaged: d } };
  Object.assign(c, { status: 'closed', closed_at: now(), closed_name: nm(), summary: s }); return s; };
RPC.am_count_cancel = ({ p_id }) => { db.am_count.find(x => x.id === p_id).status = 'cancelled'; return null; };

RPC.am_report = ({ p_from, p_to }) => {
  const all = db.am_asset, live = all.filter(a => alive(a.status_code)), val = a => a.fin_status === 'booked' && a.fin_cost != null ? +a.fin_cost : (+a.unit_price || 0) * (+a.qty || 1);
  const grp = (rows, key, f) => { const m = new Map(); for (const r of rows) { const k = r[key] || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return [...m].map(([k, rs]) => f(k, rs)); };
  const sum = (rs, f) => rs.reduce((s, r) => s + (+f(r) || 0), 0);
  return { as_of: now(), from: p_from, to: p_to,
    totals: { rows: live.length, unique: live.filter(a => a.asset_kind === 'unique').length, low_rows: live.filter(a => a.asset_kind === 'low').length, low_qty: sum(live.filter(a => a.asset_kind === 'low'), a => a.qty),
              value: sum(live, val), booked: live.filter(a => a.fin_status === 'booked').length, booked_cost: sum(live.filter(a => a.fin_status === 'booked'), a => a.fin_cost),
              nbv: sum(live.filter(a => a.fin_status === 'booked'), a => a.fin_nbv), temp: live.filter(a => !a.fin_status && !a.is_legacy).length, temp_value: sum(live.filter(a => !a.fin_status && !a.is_legacy), val),
              no_label: live.filter(a => !a.label_printed && !a.is_legacy).length },
    by_dept: grp(live, 'dept_code', (k, rs) => ({ dept: k, unique: rs.filter(a => a.asset_kind === 'unique').length, low_rows: rs.filter(a => a.asset_kind === 'low').length,
      low_qty: sum(rs.filter(a => a.asset_kind === 'low'), a => a.qty), value: sum(rs, val), booked_cost: sum(rs.filter(a => a.fin_status === 'booked'), a => a.fin_cost),
      nbv: sum(rs.filter(a => a.fin_status === 'booked'), a => a.fin_nbv), temp: rs.filter(a => !a.fin_status && !a.is_legacy).length,
      repair: rs.filter(a => ['3', '4', '5', '6', '25'].includes(String(a.status_code))).length, awaiting: rs.filter(a => ['8', '24'].includes(String(a.status_code))).length })),
    by_group: grp(live, 'group_code', (k, rs) => ({ group: k, rows: rs.length, qty: sum(rs, a => a.qty), value: sum(rs, val) })),
    by_status: grp(all, 'status_code', (k, rs) => ({ status: k, rows: rs.length, qty: sum(rs, a => a.qty), value: sum(rs, val) })),
    movement: { new: 2, new_value: 490000000, status: { '5': 1, '1': 1 }, transfers: db.am_transfer.filter(t => t.status === 'done').length, transfer_lines: 1,
                inc_opened: db.am_incident.length, inc_closed: db.am_incident.filter(i => i.status === 'closed').length, repair_cost: sum(db.am_incident.filter(i => i.status === 'closed'), i => i.cost),
                counts: db.am_count.filter(c => c.status === 'closed').length },
    pending: { temp_old: 1, repair: live.filter(a => ['3', '5', '6', '25'].includes(String(a.status_code))).length, beyond: live.filter(a => a.status_code === '4').length,
               awaiting: live.filter(a => ['8', '24'].includes(String(a.status_code))).length, inc_open: db.am_incident.filter(i => ['open', 'in_progress'].includes(i.status)).length,
               tf_open: db.am_transfer.filter(t => t.status === 'pending').length, warranty_30: 0 },
    counts: db.am_count.filter(c => c.status === 'closed').map(c => ({ code: c.code, title: c.title, depts: c.depts, date: c.count_date, summary: c.summary })) };
};
RPC.am_report_snap_save = ({ p_period, p_from, p_to }) => { db.am_report_snap = db.am_report_snap.filter(s => s.period !== p_period);
  const id = db.seq++; db.am_report_snap.push({ id, period: p_period, p_from, p_to, data: RPC.am_report({ p_from, p_to }), created_name: nm(), created_at: now() }); return id; };
RPC.am_asset_history = ({ p_id }) => { const a = A(p_id);
  const ev = [{ at: '2026-01-10T08:00:00Z', kind: 'created', who: 'amc@x', data: { asset_code: a.asset_code, dept_code: a.dept_code, location_code: a.location_code, status_code: '120' } },
              { at: '2026-02-01T08:00:00Z', kind: 'change', who: 'amx@x', data: { status_code: { o: '120', n: '1' }, label_printed: { o: false, n: true } } }];
  for (const l of db.am_transfer_line.filter(l => l.asset_id === p_id || l.new_asset_id === p_id)) { const t = db.am_transfer.find(x => x.id === l.transfer_id);
    ev.push({ at: t.done_at || t.created_at, kind: 'transfer', who: t.created_name, data: { id: t.id, no: t.no, status: t.status, from: t.from_dept, to: t.to_dept, loc: t.to_location, old_code: l.old_code, new_code: l.new_code, qty: l.qty } }); }
  for (const i of db.am_incident.filter(i => i.asset_id === p_id)) ev.push({ at: i.created_at, kind: 'incident', who: i.created_name, data: { id: i.id, no: i.no, type: i.kind, status: i.status, outcome: i.outcome, cost: i.cost, text: i.description } });
  for (const l of db.am_count_line.filter(l => l.asset_id === p_id && l.found != null)) ev.push({ at: l.at || now(), kind: 'count', who: l.by_name, data: { code: (db.am_count.find(c => c.id === l.count_id) || {}).code, found: l.found, qty: l.qty_found, loc: l.loc_found, cond: l.cond, note: l.note } });
  ev.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return { asset: a, events: ev, incidents: db.am_incident.filter(i => i.asset_id === p_id), transfers: [] }; };
})();

;(() => {
// Fake 32_price_db.sql: enough to drive the price screens.
const { db, RPC, save, me, now } = FK;
const err = m => { throw new Error(m); };
for (const k of ['pr_source', 'pr_line', 'pr_alias', 'pr_import']) db[k] = db[k] || [];
const baseMe = RPC.app_me;
RPC.app_me = () => { const r = baseMe(); const am = me().roles.some(([x]) => ['AM_COORD', 'AM_EXEC', 'SYS_ADMIN'].includes(x));
  r.perms = Object.assign({}, r.perms, { price: { view: true, create: am, edit: am, approve: false, admin: am } }); return r; };
const isAm = () => me().roles.some(([x]) => ['AM_COORD', 'AM_EXEC', 'SYS_ADMIN'].includes(x));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
const UNIT = { cai: ['cái'], pcs: ['cái'], chiec: ['cái'], bo: ['bộ'], set: ['bộ'], m2: ['m²'], 'm²': ['m²'], m: ['m'], met: ['m'], md: ['m'], goi: ['gói', 1], 'tron goi': ['gói', 1], lo: ['lô', 1], lot: ['lô', 1], he: ['hệ', 1], lan: ['lần', 1] };
const svc = n => /^(lap dat|nhan cong|thi cong|van chuyen|thao do|chi phi|dich vu)/.test(norm(n));
const refresh = sid => { for (const l of db.pr_line.filter(l => sid == null || l.source_id === sid)) { const s = db.pr_source.find(x => x.id === l.source_id);
  const u = UNIT[norm(l.unit_raw)] || [l.unit_raw || null]; l.unit = u[0]; l.line_kind = u[1] ? 'lump' : svc(l.name_raw) ? 'service' : 'goods';
  const a = db.pr_alias.find(a => a.name_norm === norm(l.name_raw)); if (!l.name_std && a) l.name_std = a.name_std;
  l.price_vnd = l.unit_price == null && l.labor_price == null ? null : Math.round(((+l.unit_price || 0) + (+l.labor_price || 0)) * (+s.fx_rate || 1) / (s.vat_included ? 1.1 : 1));
  l.search_norm = norm([l.name_raw, l.name_std, l.brand, l.model, l.section].filter(Boolean).join(' ')); } };
const put = (sid, lines) => { let n = 0; (lines || []).forEach((x, i) => { if (!x.name) return; n++;
  db.pr_line.push({ id: db.seq++, source_id: sid, line_no: x.line_no || i + 1, section: x.section || null, name_raw: x.name, name_std: x.name_std || null, brand: x.brand || null, model: x.model || null,
    origin: x.origin || null, spec: x.spec || {}, qty: x.qty ?? null, unit_raw: x.unit || null, unit_price: x.unit_price ?? null, labor_price: x.labor_price ?? null, vat_rate: x.vat_rate ?? null, note: x.note || null, uncertain: x.uncertain || [] }); }); return n; };
RPC.pr_overview = () => { const by = {}; for (const s of db.pr_source) { by[s.kind] = by[s.kind] || { sources: 0, lines: 0 }; by[s.kind].sources++; by[s.kind].lines += db.pr_line.filter(l => l.source_id === s.id).length; }
  return { by_kind: by, no_date: db.pr_source.filter(s => !s.quote_date && ['legacy', 'quote', 'market'].includes(s.kind)).length, no_std: db.pr_line.filter(l => !l.name_std).length,
           suppliers: isAm() ? new Set(db.pr_source.map(s => norm(s.supplier)).filter(Boolean)).size : null,
           last_sync: (db.am_setting || []).find?.(x => x.key === 'pr_last_sync')?.value || db.pr_last_sync || null, base_url: 'https://jvc.sharepoint.com/sites/AM/QUOTES/' }; };
RPC.pr_save_source = ({ p_source: p, p_lines }) => { if (!isAm()) err('Không có quyền "create" trên "price".');
  let s = p.id && db.pr_source.find(x => x.id === p.id); if (!s) { s = { id: db.seq++, kind: p.kind || 'quote', created_at: now() }; db.pr_source.push(s); }
  Object.assign(s, { kind: p.kind || 'quote', ref: p.ref, supplier: p.supplier || null, contact: p.contact, quote_date: p.quote_date || null, project_code: p.project_code || null, project_name: p.project_name,
    currency: p.currency || 'VND', fx_rate: +p.fx_rate || 1, vat_included: !!p.vat_included, won: p.won ?? null, delivery_term: p.delivery_term, install_term: p.install_term, payment_term: p.payment_term,
    file_name: p.file_name, file_url: p.file_url || null, note: p.note });
  if (p_lines) { db.pr_line = db.pr_line.filter(l => l.source_id !== s.id); put(s.id, p_lines); } refresh(s.id); return s.id; };
RPC.pr_delete_source = ({ p_id }) => { db.pr_source = db.pr_source.filter(s => s.id !== p_id); db.pr_line = db.pr_line.filter(l => l.source_id !== p_id); return null; };
RPC.pr_import_legacy = ({ p_import, p_file, p_sources }) => { let imp = p_import; if (!imp) { imp = db.seq++; db.pr_import.push({ id: imp, kind: 'legacy', file_name: p_file }); }
  let ns = 0, nl = 0;
  for (const q of p_sources) { let s = db.pr_source.find(x => x.origin_key === 'legacy:' + q.ref);
    if (!s) { s = { id: db.seq++, kind: 'legacy', origin_key: 'legacy:' + q.ref, fx_rate: 1, currency: 'VND', vat_included: false, won: null }; db.pr_source.push(s); }
    Object.assign(s, { ref: q.ref, supplier: q.supplier || null, contact: q.contact, quote_date: q.quote_date || s.quote_date || null, project_name: q.project_name, file_name: q.file_name,
      delivery_term: q.delivery_term, install_term: q.install_term, payment_term: q.payment_term, import_id: imp });
    db.pr_line = db.pr_line.filter(l => l.source_id !== s.id); nl += put(s.id, q.lines); refresh(s.id); ns++; }
  return { import: imp, sources: ns, lines: nl }; };
RPC.pr_set_std = ({ p_lines, p_std }) => { const names = new Set(db.pr_line.filter(l => p_lines.includes(l.id)).map(l => norm(l.name_raw)));
  for (const n of names) { db.pr_alias = db.pr_alias.filter(a => a.name_norm !== n); db.pr_alias.push({ name_norm: n, name_std: p_std }); }
  for (const l of db.pr_line) if (p_lines.includes(l.id) || (!l.name_std && names.has(norm(l.name_raw)))) l.name_std = p_std;
  refresh(null); return p_lines.length; };
RPC.pr_sync = () => { const auto = ['qc', 'mc_hist', 'mc_market', 'po', 'tender', 'intake']; const gone = new Set(db.pr_source.filter(s => auto.includes(s.kind)).map(s => s.id));
  db.pr_source = db.pr_source.filter(s => !gone.has(s.id)); db.pr_line = db.pr_line.filter(l => !gone.has(l.source_id)); const r = { qc: 0, mc: 0, po: 0, tender: 0, intake: 0 };
  for (const d of db.pm_doc.filter(d => d.doc_type === 'QC' && d.status !== 'cancelled')) (d.data.vendors || []).forEach((v, i) => { if (!v.name) return;
    const id = db.seq++; db.pr_source.push({ id, kind: 'qc', origin_key: `qc:${d.id}:${i}`, ref: d.doc_no, supplier: v.name, quote_date: d.data.date || String(d.created_at).slice(0, 10), project_code: d.project_code,
      won: d.status === 'approved' ? i === 0 : null, fx_rate: 1, currency: 'VND' });
    put(id, (d.data.qlines || []).map((q, j) => ({ name: q.item, qty: q.qty, unit: q.unit, unit_price: (v.prices || {})[j] })).filter(x => x.unit_price != null)); r.qc++; });
  for (const d of db.pm_doc.filter(d => d.doc_type === 'PO' && d.status !== 'cancelled')) { const id = db.seq++;
    db.pr_source.push({ id, kind: 'po', origin_key: `po:${d.id}`, ref: d.doc_no, supplier: d.data.supplier, quote_date: d.data.order_date || String(d.created_at).slice(0, 10), project_code: d.project_code, won: d.status === 'approved' ? true : null, fx_rate: 1, currency: 'VND' });
    put(id, (d.data.lines || []).map(l => ({ name: l.asset_item, qty: l.qty, unit: l.unit, unit_price: l.unit_price, brand: (l.spec || {}).brand, model: (l.spec || {}).model })).filter(x => x.unit_price != null)); r.po++; }
  refresh(null); db.pr_last_sync = now(); return r; };
RPC.pr_search = ({ p_q, p_f = {} }) => {
  const w = norm(p_q).split(' ').filter(Boolean), full = isAm(), yr = new Date().getFullYear();
  let out = [];
  for (const l of db.pr_line) { const s = db.pr_source.find(x => x.id === l.source_id); if (!s) continue;
    const hay = (l.search_norm || '') + ' ' + (full ? norm(s.supplier) : '') + ' ' + norm(s.project_name);
    if (w.some(x => !hay.includes(x))) continue;
    if ((p_f.kinds || []).length && !p_f.kinds.includes(s.kind)) continue;
    if (p_f.year_from && (!s.quote_date || s.quote_date < `${p_f.year_from}-01-01`)) continue;
    if (p_f.year_to && (!s.quote_date || s.quote_date > `${p_f.year_to}-12-31`)) continue;
    if (p_f.won_only && !s.won) continue; if (p_f.goods_only && l.line_kind !== 'goods') continue;
    const rk = w.filter(x => norm(l.name_std || l.name_raw).includes(x)).length * 10 + w.filter(x => (l.search_norm || '').includes(x)).length;
    out.push({ rk, r: { id: l.id, source_id: s.id, kind: s.kind, ref: full ? s.ref : null, date: s.quote_date, won: s.won, project_code: s.project_code, project_name: s.project_name,
      supplier: full ? s.supplier : null, file_name: full ? s.file_name : null, file_url: full ? s.file_url : null, name: l.name_raw, name_std: l.name_std, section: l.section, line_kind: l.line_kind,
      brand: l.brand, model: l.model, origin: l.origin, qty: l.qty, unit_raw: l.unit_raw, unit: l.unit, unit_price: l.unit_price, labor_price: l.labor_price, currency: s.currency, price_vnd: l.price_vnd,
      price_today: l.price_vnd != null && s.quote_date ? Math.round(l.price_vnd * Math.pow(1.046, Math.max(0, yr - Number(s.quote_date.slice(0, 4))))) : null, note: l.note } }); }
  out.sort((a, b) => b.rk - a.rk || String(b.r.date || '').localeCompare(String(a.r.date || '')));
  return out.slice(0, p_f.limit || 200).map(x => x.r); };
})();
window.__TERMS = [{"std_vi":"Máy lạnh","std_en":"Air conditioner","grp":"HVAC","kind":"goods","patterns":["may lanh","dieu hoa","may dhkk","dhkk packaged","may dieu hoa","air conditioner"],"sort":10},{"std_vi":"FCU","std_en":"Fan coil unit","grp":"HVAC","kind":"goods","patterns":["fcu","fan coil"],"sort":20},{"std_vi":"AHU","std_en":"Air handling unit","grp":"HVAC","kind":"goods","patterns":["ahu","air handling unit"],"sort":30},{"std_vi":"Dàn lạnh PAU","std_en":"PAU unit","grp":"HVAC","kind":"goods","patterns":["dan lanh pau","pau"],"sort":40},{"std_vi":"Máy nén","std_en":"Compressor","grp":"HVAC","kind":"goods","patterns":["may nen","may nen lanh","compressor"],"sort":50},{"std_vi":"Bầu giải nhiệt","std_en":"Heat exchanger","grp":"HVAC","kind":"goods","patterns":["bau giai nhiet","heat exchanger"],"sort":60},{"std_vi":"Van tiết lưu","std_en":"Expansion valve","grp":"HVAC","kind":"goods","patterns":["van tiet luu","expansion valve"],"sort":70},{"std_vi":"Phin lọc gas","std_en":"Filter drier","grp":"HVAC","kind":"goods","patterns":["phin loc gas","phin loc"],"sort":80},{"std_vi":"Lắc lạnh","std_en":"Refrigerant shaker valve","grp":"HVAC","kind":"goods","patterns":["lac lanh"],"sort":90},{"std_vi":"Nạp gas lạnh","std_en":"Refrigerant charging","grp":"HVAC","kind":"service","patterns":["nap gas","sac gas","charge gas","nap gas bo sung"],"sort":100},{"std_vi":"Thử kín hệ thống","std_en":"Leak test (nitrogen)","grp":"HVAC","kind":"service","patterns":["nen nito","thu kin"],"sort":110},{"std_vi":"Bộ ổn nhiệt","std_en":"Thermostat","grp":"HVAC","kind":"goods","patterns":["thermostat","themostat","thermkostac","bo on nhiet","bo chinh nhiet do"],"sort":120},{"std_vi":"Ống gió chống cháy","std_en":"Fire-rated air duct","grp":"HVAC","kind":"goods","patterns":["ong gio chong chay"],"sort":130},{"std_vi":"Ống gió","std_en":"Air duct","grp":"HVAC","kind":"goods","patterns":["ong gio","duong ong gio","he thong duong ong gio","ong gio g i"],"sort":140},{"std_vi":"Ống gió mềm","std_en":"Flexible duct","grp":"HVAC","kind":"goods","patterns":["ong gio mem"],"sort":150},{"std_vi":"Co ống gió","std_en":"Duct elbow","grp":"HVAC","kind":"goods","patterns":["co ong gio"],"sort":160},{"std_vi":"Chân rẽ ống gió","std_en":"Duct branch","grp":"HVAC","kind":"goods","patterns":["chan re"],"sort":170},{"std_vi":"Nối vuông tròn","std_en":"Duct transition","grp":"HVAC","kind":"goods","patterns":["noi vuong tron"],"sort":180},{"std_vi":"Miệng gió","std_en":"Air grille, diffuser","grp":"HVAC","kind":"goods","patterns":["mieng gio","cua gio"],"sort":190},{"std_vi":"Box gió","std_en":"Plenum box","grp":"HVAC","kind":"goods","patterns":["box gio","hop box ket noi ong gio","hop gio"],"sort":200},{"std_vi":"Van gió ngăn cháy","std_en":"Fire damper","grp":"HVAC","kind":"goods","patterns":["van gio ngan chay","van chong chay"],"sort":210},{"std_vi":"Phụ kiện ống gió","std_en":"Duct accessories","grp":"HVAC","kind":"goods","patterns":["phu kien ket noi ong gio","bo ti treo","ti treo","simili chong chay"],"sort":220},{"std_vi":"Ống đồng máy lạnh","std_en":"Copper refrigerant pipe","grp":"HVAC","kind":"goods","patterns":["ong dong","noi dong"],"sort":230},{"std_vi":"Bọc cách nhiệt","std_en":"Insulation","grp":"HVAC","kind":"goods","patterns":["boc cach nhiet","cach nhiet","bao on","superlon","supperlon","maxilite"],"sort":240},{"std_vi":"Bơm nước ngưng","std_en":"Condensate pump","grp":"HVAC","kind":"goods","patterns":["bom nuoc ngung"],"sort":250},{"std_vi":"Ống nước ngưng","std_en":"Condensate pipe","grp":"HVAC","kind":"goods","patterns":["ong nuoc ngung"],"sort":260},{"std_vi":"Quạt thông gió","std_en":"Ventilation fan","grp":"HVAC","kind":"goods","patterns":["quat thong gio","ventilator","fan"],"sort":270},{"std_vi":"Tấm tản nhiệt tháp giải nhiệt","std_en":"Cooling tower fill","grp":"HVAC","kind":"goods","patterns":["tam tan nhiet","thap giai nhiet"],"sort":280},{"std_vi":"Hệ thống hút khói, cấp gió","std_en":"Smoke extraction, pressurisation system","grp":"HVAC","kind":"goods","patterns":["he thong hut khoi","he thong cap bu gio","hut khoi"],"sort":290},{"std_vi":"Cải tạo kho lạnh","std_en":"Cold room renovation","grp":"HVAC","kind":"goods","patterns":["kho lanh","cold room","cold storage","freezer","renovation of freezer","renew evaporator","renew control cabinet"],"sort":300},{"std_vi":"Đèn kho lạnh","std_en":"Cold room light","grp":"HVAC","kind":"goods","patterns":["den kho lanh","den led kho lanh","lamp of cold storage"],"sort":310},{"std_vi":"Vệ sinh dàn nóng, dàn lạnh","std_en":"Coil cleaning","grp":"HVAC","kind":"service","patterns":["ve sinh dan nong","cleaning condenser","hoa chat ve sinh dan"],"sort":320},{"std_vi":"Ống PPR","std_en":"PPR pipe","grp":"PLB","kind":"goods","patterns":["ong ppr","ong nhua ppr","ong nuoc nong ppr","ong nuoc lanh ppr","ong nuoc nong pprr"],"sort":330},{"std_vi":"Ống PVC","std_en":"PVC pipe","grp":"PLB","kind":"goods","patterns":["ong pvc","ong nhua pvc","ong nuoc pvc","ong cung pvc","ong nhua xam"],"sort":340},{"std_vi":"Ống thép tráng kẽm","std_en":"Galvanised steel pipe","grp":"PLB","kind":"goods","patterns":["ong sat trang kem","ong thep trang kem","ong kem","ong thep","he thong duong ong sat","ong sat","dn 32 thk"],"sort":350},{"std_vi":"Co, cút","std_en":"Elbow fitting","grp":"PLB","kind":"goods","patterns":["co","co kem","co ppr","co 45","co 90","elbow"],"sort":360},{"std_vi":"Tê","std_en":"Tee fitting","grp":"PLB","kind":"goods","patterns":["te","te deu","te giam","te kem","te ppr","t ppr"],"sort":370},{"std_vi":"Nối ống","std_en":"Pipe coupling","grp":"PLB","kind":"goods","patterns":["noi ong","noi ppr","noi chan","noi"],"sort":380},{"std_vi":"Giảm, côn thu","std_en":"Reducer","grp":"PLB","kind":"goods","patterns":["giam","giam han"],"sort":390},{"std_vi":"Mặt bích","std_en":"Flange","grp":"PLB","kind":"goods","patterns":["mat bich"],"sort":400},{"std_vi":"Rắc co","std_en":"Union","grp":"PLB","kind":"goods","patterns":["rac co"],"sort":410},{"std_vi":"Kép hai đầu ren","std_en":"Threaded nipple","grp":"PLB","kind":"goods","patterns":["hai dau ren"],"sort":420},{"std_vi":"Phụ kiện đường ống","std_en":"Pipe fittings","grp":"PLB","kind":"goods","patterns":["phu kien duong ong","fitting","phu kien han","pipe","duong ong va van"],"sort":430},{"std_vi":"Khớp nối mềm","std_en":"Flexible joint","grp":"PLB","kind":"goods","patterns":["khop noi mem"],"sort":440},{"std_vi":"Van cổng","std_en":"Gate valve","grp":"PLB","kind":"goods","patterns":["van cong"],"sort":450},{"std_vi":"Van bướm","std_en":"Butterfly valve","grp":"PLB","kind":"goods","patterns":["van buom"],"sort":460},{"std_vi":"Van một chiều","std_en":"Check valve","grp":"PLB","kind":"goods","patterns":["van 1 chieu","van mot chieu"],"sort":470},{"std_vi":"Van an toàn","std_en":"Safety valve","grp":"PLB","kind":"goods","patterns":["van an toan","pressure relief valve"],"sort":480},{"std_vi":"Cụm van giảm áp","std_en":"Pressure reducing valve set","grp":"PLB","kind":"goods","patterns":["cum van giam ap","van giam ap"],"sort":490},{"std_vi":"Cụm van FCU","std_en":"FCU valve set","grp":"PLB","kind":"goods","patterns":["cum van"],"sort":500},{"std_vi":"Van điện từ, van ON-OFF","std_en":"Motorised valve","grp":"PLB","kind":"goods","patterns":["van dien tu","on off"],"sort":510},{"std_vi":"Van PICV","std_en":"PICV valve","grp":"PLB","kind":"goods","patterns":["van picv","picv"],"sort":520},{"std_vi":"Van cửa PPR","std_en":"PPR stop valve","grp":"PLB","kind":"goods","patterns":["van cua ppr"],"sort":530},{"std_vi":"Lọc Y","std_en":"Y-strainer","grp":"PLB","kind":"goods","patterns":["loc y"],"sort":540},{"std_vi":"Bơm chìm nước thải","std_en":"Submersible sewage pump","grp":"PLB","kind":"goods","patterns":["bom chim","may bom chim","bom nuoc thai","bom chim nuoc thai"],"sort":550},{"std_vi":"Lắp đặt bơm \u0026 đường ống","std_en":"Pump \u0026 piping installation","grp":"PLB","kind":"service","patterns":["lap dat he thong gom 2 bom","lap dat ong va van cho cum 2 bom"],"sort":560},{"std_vi":"Lò xo giảm chấn","std_en":"Vibration isolator","grp":"PLB","kind":"goods","patterns":["lo xo giam chan","bo ti treo chong rung"],"sort":570},{"std_vi":"Cùm treo ống","std_en":"Pipe clamp","grp":"PLB","kind":"goods","patterns":["cum treo","kep ong"],"sort":580},{"std_vi":"Ty ren, bulong","std_en":"Threaded rod, bolt","grp":"PLB","kind":"goods","patterns":["ty ren","bulong","bu long","tac ke","tan long den"],"sort":590},{"std_vi":"Giá đỡ ống","std_en":"Pipe support","grp":"PLB","kind":"goods","patterns":["he thong gia do","vat tu support"],"sort":600},{"std_vi":"Phễu thoát sàn","std_en":"Floor drain","grp":"PLB","kind":"goods","patterns":["phieu thoat","pheu thoat","phieu thu","ga thoat nuoc san"],"sort":610},{"std_vi":"Vĩ thoát sàn inox","std_en":"Stainless floor grating","grp":"PLB","kind":"goods","patterns":["vi thoat san"],"sort":620},{"std_vi":"Di dời đường ống nước","std_en":"Water pipe relocation","grp":"PLB","kind":"service","patterns":["di doi duong ong","di lai ong nuoc","cat ong hien huu"],"sort":630},{"std_vi":"Cáp điện","std_en":"Power cable","grp":"ELE","kind":"goods","patterns":["cap cap nguon","cap dien","cap dong luc","cadivi"],"sort":640},{"std_vi":"Dây điện","std_en":"Electric wire","grp":"ELE","kind":"goods","patterns":["day dien","day nguon","day dien nguon","day cap"],"sort":650},{"std_vi":"Cáp điều khiển","std_en":"Control cable","grp":"ELE","kind":"goods","patterns":["cap dieu khien","day dien dieu khien","he thong day dien dieu khien","day dien remote"],"sort":660},{"std_vi":"Công tắc","std_en":"Light switch","grp":"ELE","kind":"goods","patterns":["cong tac","double pole switch"],"sort":670},{"std_vi":"Ổ cắm điện","std_en":"Socket outlet","grp":"ELE","kind":"goods","patterns":["o cam","o cam dien"],"sort":680},{"std_vi":"Ổ cắm mạng, điện thoại","std_en":"Data, phone outlet","grp":"ELE","kind":"goods","patterns":["o cam mang","o cam dien thoai"],"sort":690},{"std_vi":"Đế âm","std_en":"Back box","grp":"ELE","kind":"goods","patterns":["de am"],"sort":700},{"std_vi":"Aptomat MCB, RCBO","std_en":"Circuit breaker","grp":"ELE","kind":"goods","patterns":["mcb","rcbo","cb"],"sort":710},{"std_vi":"Contactor","std_en":"Contactor","grp":"ELE","kind":"goods","patterns":["contactor"],"sort":720},{"std_vi":"Relay trung gian","std_en":"Relay","grp":"ELE","kind":"goods","patterns":["relay","replay","relay board"],"sort":730},{"std_vi":"Tủ điện","std_en":"Electrical panel","grp":"ELE","kind":"goods","patterns":["tu dien","renew control cabinet","sua chua tu dien"],"sort":740},{"std_vi":"Ống luồn dây điện","std_en":"Electrical conduit","grp":"ELE","kind":"goods","patterns":["ong luon","ong luong","ong dien","ong cung"],"sort":750},{"std_vi":"Ruột gà luồn dây","std_en":"Flexible conduit","grp":"ELE","kind":"goods","patterns":["ruot ga","ong ruot ga"],"sort":760},{"std_vi":"Máng cáp, trunking","std_en":"Cable trunking","grp":"ELE","kind":"goods","patterns":["trunking","trunkin","trung kinh","mang cap"],"sort":770},{"std_vi":"Nẹp nhựa","std_en":"Plastic cable trim","grp":"ELE","kind":"goods","patterns":["nep nhua"],"sort":780},{"std_vi":"Đèn LED âm trần","std_en":"LED downlight","grp":"ELE","kind":"goods","patterns":["bong den led am tran","den led","den am tran"],"sort":790},{"std_vi":"Đèn trang trí, đèn thả","std_en":"Decorative light","grp":"ELE","kind":"goods","patterns":["bong den","den pha ray","den tha","phu kien ket noi den"],"sort":800},{"std_vi":"Chuông cửa phòng","std_en":"Door bell","grp":"ELE","kind":"goods","patterns":["chuong phong","chuong"],"sort":810},{"std_vi":"Bộ nút chuông \u0026 đèn báo phòng","std_en":"Doorbell \u0026 DND panel","grp":"ELE","kind":"goods","patterns":["bo nut nhan chuong"],"sort":820},{"std_vi":"Ắc quy","std_en":"Battery","grp":"ELE","kind":"goods","patterns":["ac quy","acquy","rbc55","pin du phong","bao gia acquy"],"sort":830},{"std_vi":"Bộ lưu điện (UPS)","std_en":"UPS","grp":"ELE","kind":"goods","patterns":["bo luu dien","ups","santak","c3k"],"sort":840},{"std_vi":"Thanh ổ điện (PDU)","std_en":"Power distribution unit","grp":"ELE","kind":"goods","patterns":["thanh o dien"],"sort":850},{"std_vi":"Hệ thống điện (thi công)","std_en":"Electrical works","grp":"ELE","kind":"service","patterns":["thi cong cap nguon","ket noi he thong dien","he thong dien","thi cong lai he thong dien","ket noi cap dong luc"],"sort":860},{"std_vi":"Vật tư điện","std_en":"Electrical materials","grp":"ELE","kind":"goods","patterns":["vat tu thi cong lai he thong dien","phu kien ong dien","phu kien lap dat cong tac","phu kien dau noi lap dat tu dien","bam cos"],"sort":870},{"std_vi":"Máy tính xách tay","std_en":"Laptop","grp":"ICT","kind":"goods","patterns":["may tinh xach tay","laptop","probook","elitebook"],"sort":880},{"std_vi":"Máy tính để bàn","std_en":"Desktop PC","grp":"ICT","kind":"goods","patterns":["may tinh de ban","may tinh ban","may tinh mini","may vi tinh lap rap","may tinh pc","imac","mini ops computer","ops computer"],"sort":890},{"std_vi":"Máy trạm","std_en":"Workstation","grp":"ICT","kind":"goods","patterns":["workstation"],"sort":900},{"std_vi":"Máy tính bảng","std_en":"Tablet","grp":"ICT","kind":"goods","patterns":["may tinh bang","ipad","ipda","tablets","tablet"],"sort":910},{"std_vi":"Màn hình máy tính","std_en":"Computer monitor","grp":"ICT","kind":"goods","patterns":["man hinh may tinh","man hinh vi tinh","man hinh hp","monitor"],"sort":920},{"std_vi":"Máy in","std_en":"Printer","grp":"ICT","kind":"goods","patterns":["may in","printer","laserjet"],"sort":930},{"std_vi":"Máy chủ","std_en":"Server","grp":"ICT","kind":"goods","patterns":["may chu","server","hpe dl"],"sort":940},{"std_vi":"Linh kiện máy chủ","std_en":"Server component","grp":"ICT","kind":"goods","patterns":["power supply","*b21","*l21","ssd","network module","stack power cable","stacking cable","stack module","power cord","power cable"],"sort":950},{"std_vi":"Switch mạng","std_en":"Network switch","grp":"ICT","kind":"goods","patterns":["switch","catalyst"],"sort":960},{"std_vi":"Tường lửa","std_en":"Firewall","grp":"ICT","kind":"goods","patterns":["ngfw","firewall","forcepoint","giai phap ngfw"],"sort":970},{"std_vi":"Bản quyền phần mềm","std_en":"Software licence","grp":"ICT","kind":"goods","patterns":["license","licence","ban quyen","windows","office ltsc","microsoft 365","phan mem ban quyen"],"sort":980},{"std_vi":"Phần mềm, dịch vụ cloud","std_en":"Software, cloud subscription","grp":"ICT","kind":"goods","patterns":["phan mem","cloud","saas","subscription","infrasys","oracle","opera","simphony","sunsystems","infor","cong thong tin nhan vien","tinh luong","quan ly bua an","cham cong","phan he"],"sort":990},{"std_vi":"Dịch vụ triển khai phần mềm","std_en":"Software implementation","grp":"ICT","kind":"service","patterns":["interface","setup","set up","configuration","implementation","training","report build","manday","customisation","tich hop","ho tro tich","data export","upgrade services","vas report","value added services","tinh chinh"],"sort":1000},{"std_vi":"Hỗ trợ \u0026 bảo hành phần mềm, thiết bị","std_en":"Support \u0026 extended warranty","grp":"ICT","kind":"service","patterns":["support","extended warranty","sntc","maintenance","css","live support","trg","phi quan ly thiet bi","phi dich vu"],"sort":1010},{"std_vi":"Cáp mạng","std_en":"Network cable","grp":"ICT","kind":"goods","patterns":["cap mang","day cap mang","day mang","cable mang"],"sort":1020},{"std_vi":"Đầu mạng RJ45","std_en":"RJ45 connector","grp":"ICT","kind":"goods","patterns":["dau bam","dau mang","rj45","dau chup mang"],"sort":1030},{"std_vi":"Tủ mạng","std_en":"Network rack","grp":"ICT","kind":"goods","patterns":["tu mang"],"sort":1040},{"std_vi":"Camera IP","std_en":"IP camera","grp":"ICT","kind":"goods","patterns":["camera ip","camera"],"sort":1050},{"std_vi":"Đầu ghi hình","std_en":"NVR","grp":"ICT","kind":"goods","patterns":["dau ghi hinh","nvr"],"sort":1060},{"std_vi":"Ổ cứng","std_en":"Hard disk","grp":"ICT","kind":"goods","patterns":["o cung","thiet bi luu tru data"],"sort":1070},{"std_vi":"Máy chấm công","std_en":"Time attendance device","grp":"ICT","kind":"goods","patterns":["may cham cong","thiet bi may cham cong","dung luong luu tru","dung luong du tru"],"sort":1080},{"std_vi":"Máy quét hộ chiếu, CCCD","std_en":"Passport, ID scanner","grp":"ICT","kind":"goods","patterns":["passport scanner","scanner","id card reading","e passport"],"sort":1090},{"std_vi":"Két tiền","std_en":"Cash drawer","grp":"ICT","kind":"goods","patterns":["cash drawer"],"sort":1100},{"std_vi":"Thẻ nhân viên, thẻ POS","std_en":"Staff card","grp":"ICT","kind":"goods","patterns":["employee cards","staff card"],"sort":1110},{"std_vi":"Tivi","std_en":"Television","grp":"ICT","kind":"goods","patterns":["tivi","hotel tv","smart tivi","tv","samsung hg55"],"sort":1120},{"std_vi":"Apple TV","std_en":"Apple TV","grp":"ICT","kind":"goods","patterns":["apple tv"],"sort":1130},{"std_vi":"Màn hình quảng cáo","std_en":"Digital signage","grp":"ICT","kind":"goods","patterns":["man hinh quang cao","digital signage"],"sort":1140},{"std_vi":"Máy chiếu","std_en":"Projector","grp":"ICT","kind":"goods","patterns":["may chieu","projector","lcd projectors"],"sort":1150},{"std_vi":"Ống kính máy chiếu","std_en":"Projector lens","grp":"ICT","kind":"goods","patterns":["ong lens","zoom lens"],"sort":1160},{"std_vi":"Màn hình tương tác","std_en":"Interactive flat panel","grp":"ICT","kind":"goods","patterns":["interactive flat panel"],"sort":1170},{"std_vi":"Thiết bị hội nghị","std_en":"Conference equipment","grp":"ICT","kind":"goods","patterns":["conference mic","speakerphone","webcam","camera 4k","smart pen","wireless mirroring","amx controller","neutrik"],"sort":1180},{"std_vi":"Giá treo màn hình","std_en":"Screen bracket, stand","grp":"ICT","kind":"goods","patterns":["mobile bracket","gia treo","adjustable stand","gia do may tinh bang","carrying pouch"],"sort":1190},{"std_vi":"Cáp HDMI","std_en":"HDMI cable","grp":"ICT","kind":"goods","patterns":["cap hdmi"],"sort":1200},{"std_vi":"Cáp truyền hình","std_en":"TV cable","grp":"ICT","kind":"goods","patterns":["day cap tivi"],"sort":1210},{"std_vi":"Balo, phụ kiện máy tính","std_en":"Computer accessory","grp":"ICT","kind":"goods","patterns":["balo laptop"],"sort":1220},{"std_vi":"Tủ mát","std_en":"Upright chiller","grp":"KIT","kind":"goods","patterns":["tu mat","upright chiller","bao gia tu mat"],"sort":1230},{"std_vi":"Tủ minibar","std_en":"Minibar","grp":"KIT","kind":"goods","patterns":["tu minibar","mini bar"],"sort":1240},{"std_vi":"Máy làm đá","std_en":"Ice machine","grp":"KIT","kind":"goods","patterns":["may lam da","scotsman","scotman"],"sort":1250},{"std_vi":"Bếp chiên phẳng","std_en":"Griddle","grp":"KIT","kind":"goods","patterns":["bep chien phang","smooth plate"],"sort":1260},{"std_vi":"Bếp điện","std_en":"Electric range","grp":"KIT","kind":"goods","patterns":["bep dien","electric range","hot plate","4 hot plate"],"sort":1270},{"std_vi":"Bếp nướng than","std_en":"Char broiler","grp":"KIT","kind":"goods","patterns":["bep nuong","char rock broiler"],"sort":1280},{"std_vi":"Lò hấp nướng đa năng","std_en":"Combi oven","grp":"KIT","kind":"goods","patterns":["lo hap nuong","lo nuong","oven"],"sort":1290},{"std_vi":"Bếp","std_en":"Cooking range","grp":"KIT","kind":"goods","patterns":["bep","bao gia bep"],"sort":1300},{"std_vi":"Máy rửa bát","std_en":"Dishwasher","grp":"KIT","kind":"goods","patterns":["may rua bat","dishwasher","under counter dishwasher"],"sort":1310},{"std_vi":"Máy ép trái cây","std_en":"Juicer","grp":"KIT","kind":"goods","patterns":["may ep trai cay","may ep"],"sort":1320},{"std_vi":"Chậu rửa chén","std_en":"Kitchen sink","grp":"KIT","kind":"goods","patterns":["chau chen","chau rua chen","bon rua"],"sort":1330},{"std_vi":"Vòi bếp","std_en":"Kitchen tap","grp":"KIT","kind":"goods","patterns":["voi bep"],"sort":1340},{"std_vi":"Bàn inox","std_en":"Stainless steel table","grp":"KIT","kind":"goods","patterns":["ban inox"],"sort":1350},{"std_vi":"Mặt kính ceramic bếp","std_en":"Ceramic glass plate","grp":"KIT","kind":"goods","patterns":["ceramic glass plate"],"sort":1360},{"std_vi":"Thanh nhiệt","std_en":"Heating element","grp":"KIT","kind":"goods","patterns":["heating element","fin heatingnelement"],"sort":1370},{"std_vi":"Vỉ lưới inox bồn rửa","std_en":"Sink grating","grp":"KIT","kind":"goods","patterns":["vi inox bon rua","vi luoi inox"],"sort":1380},{"std_vi":"Lưới lọc rác bồn rửa","std_en":"Sink strainer","grp":"KIT","kind":"goods","patterns":["luoi loc","loc rac bon rua"],"sort":1390},{"std_vi":"Hệ thống chữa cháy bếp","std_en":"Kitchen fire suppression","grp":"FPS","kind":"goods","patterns":["ansul","fire suppression","fire extinguish system","banquet","bistro","canteen"],"sort":1400},{"std_vi":"Máy sấy công nghiệp","std_en":"Industrial dryer","grp":"KIT","kind":"goods","patterns":["may say","industrial dryer","girbau"],"sort":1410},{"std_vi":"Máy giặt sấy","std_en":"Washer-dryer","grp":"KIT","kind":"goods","patterns":["washer dryer","stack washer","may giat","long giat"],"sort":1420},{"std_vi":"Máy phun rửa áp lực","std_en":"Pressure washer","grp":"KIT","kind":"goods","patterns":["may phun rua","karcher"],"sort":1430},{"std_vi":"UV lamp chụp hút","std_en":"Hood UV lamp","grp":"KIT","kind":"goods","patterns":["uv lamp"],"sort":1440},{"std_vi":"Cửa thép chống cháy","std_en":"Fire-rated steel door","grp":"DOR","kind":"goods","patterns":["cua thep chong chay","cua di 1 canh","cua di 2 canh","cua chong chay"],"sort":1450},{"std_vi":"Ô kính chống cháy","std_en":"Fire-rated glass panel","grp":"DOR","kind":"goods","patterns":["o kinh chong chay","o kinh luoi chong chay"],"sort":1460},{"std_vi":"Cửa tự động","std_en":"Automatic door","grp":"DOR","kind":"goods","patterns":["cua tu dong","bo cua tu dong","cua truot tu dong","bo tu dong","bo dieu khien cua truot","khoa chuyen dung cho cua tu dong","cam bien an toan","es200","kyk"],"sort":1470},{"std_vi":"Cửa nhôm kính","std_en":"Aluminium glass door","grp":"DOR","kind":"goods","patterns":["cua nhom","cua mo","xingfa","canh cua khung bao nhom","ma d1a","ma d1b"],"sort":1480},{"std_vi":"Vách kính cường lực","std_en":"Tempered glass partition","grp":"DOR","kind":"goods","patterns":["vach kinh","cua truot bao gom"],"sort":1490},{"std_vi":"Kính cường lực","std_en":"Tempered glass","grp":"DOR","kind":"goods","patterns":["kinh cuong luc","kinh trong","tempered glass","kinh thuy"],"sort":1500},{"std_vi":"Kính ghép","std_en":"Laminated glass","grp":"DOR","kind":"goods","patterns":["kinh ghep"],"sort":1510},{"std_vi":"Phim cách nhiệt","std_en":"Window film","grp":"DOR","kind":"goods","patterns":["phim cach nhiet","bang bao gia phim","kha nang truyen sang","solar energy"],"sort":1520},{"std_vi":"Bản lề","std_en":"Hinge","grp":"DOR","kind":"goods","patterns":["ban le","cabinet door hinge"],"sort":1530},{"std_vi":"Bản lề kính","std_en":"Glass door hinge","grp":"DOR","kind":"goods","patterns":["ban le kinh"],"sort":1540},{"std_vi":"Kẹp kính, bát kính","std_en":"Glass clamp","grp":"DOR","kind":"goods","patterns":["kep kinh","bat kinh","thanh treo kinh"],"sort":1550},{"std_vi":"Tay nắm cửa","std_en":"Door handle","grp":"DOR","kind":"goods","patterns":["tay nam","bang day","bang keo push","bang keo pull"],"sort":1560},{"std_vi":"Khóa cửa","std_en":"Door lock","grp":"DOR","kind":"goods","patterns":["khoa cua","khoa tay gat","khoa tay nam gat","khoa lien ket","khoa tu","cabinet door lock","khoa dien"],"sort":1570},{"std_vi":"Chốt âm cửa","std_en":"Flush bolt","grp":"DOR","kind":"goods","patterns":["chot am"],"sort":1580},{"std_vi":"Tay co thủy lực, tay đẩy hơi","std_en":"Door closer","grp":"DOR","kind":"goods","patterns":["tay co thuy luc","tay day hoi"],"sort":1590},{"std_vi":"Thanh thoát hiểm","std_en":"Panic bar","grp":"DOR","kind":"goods","patterns":["thanh thoat hiem"],"sort":1600},{"std_vi":"Ron, gioăng cửa","std_en":"Door seal","grp":"DOR","kind":"goods","patterns":["ron cua","roong","roong tu"],"sort":1610},{"std_vi":"Ngạch cửa inox","std_en":"Stainless door sill","grp":"DOR","kind":"goods","patterns":["door sill","doorsill"],"sort":1620},{"std_vi":"Hàng rào sắt","std_en":"Steel fence","grp":"DOR","kind":"goods","patterns":["hang rao sat","hang rao"],"sort":1630},{"std_vi":"Thanh ray","std_en":"Track rail","grp":"DOR","kind":"goods","patterns":["thanh ray","dan huong banh xe"],"sort":1640},{"std_vi":"Sơn nước","std_en":"Emulsion painting","grp":"FIN","kind":"service","patterns":["son moi","son nuoc","son tuong","son moi tran","dam va son","son mat dung","son dau","son lai","son chi","son mau","tret bot","bao gom tret bot"],"sort":1650},{"std_vi":"Sơn gỗ, sơn PU","std_en":"Wood coating","grp":"FIN","kind":"service","patterns":["son pu","son phu go","son san go","son moi cua","son ban","son ghe","son ke","son khung","sua chua va son"],"sort":1660},{"std_vi":"Sơn (vật tư)","std_en":"Paint material","grp":"FIN","kind":"goods","patterns":["dulux","su dung son","pud gloss","son dulux"],"sort":1670},{"std_vi":"Giấy dán tường","std_en":"Wallpaper","grp":"FIN","kind":"goods","patterns":["giay dan tuong","dan giay","thay giay","thao bo giay","su dung giay","korea 6805"],"sort":1680},{"std_vi":"Trần thạch cao","std_en":"Gypsum ceiling","grp":"FIN","kind":"goods","patterns":["tran thach cao","dong tran","cat va tran","thao va tran","vinh tuong"],"sort":1690},{"std_vi":"Vách thạch cao","std_en":"Gypsum partition","grp":"FIN","kind":"goods","patterns":["vach thach cao","khung thep v4","hoa sen z8"],"sort":1700},{"std_vi":"Trần nhôm","std_en":"Aluminium ceiling","grp":"FIN","kind":"goods","patterns":["tran nhom"],"sort":1710},{"std_vi":"Sàn gỗ","std_en":"Wooden flooring","grp":"FIN","kind":"goods","patterns":["san go"],"sort":1720},{"std_vi":"Sàn nhựa SPC","std_en":"SPC flooring","grp":"FIN","kind":"goods","patterns":["san nhua"],"sort":1730},{"std_vi":"Thảm trải sàn","std_en":"Carpet","grp":"FIN","kind":"goods","patterns":["tham lot san","tham","trai lot"],"sort":1740},{"std_vi":"Gạch ốp lát","std_en":"Tiling","grp":"FIN","kind":"goods","patterns":["gach","lat gach","op gach","don nen bang gach"],"sort":1750},{"std_vi":"Ốp lát đá","std_en":"Stone cladding","grp":"FIN","kind":"goods","patterns":["op da","op lat da","lat da","dan da","da granite"],"sort":1760},{"std_vi":"Ngạch, chỉ đá chặn nước","std_en":"Stone threshold","grp":"FIN","kind":"goods","patterns":["nguong da","ngach da","lat nguong","chi da chan nuoc","lat ngach da"],"sort":1770},{"std_vi":"Ron gạch","std_en":"Tile grout","grp":"FIN","kind":"service","patterns":["ron gach","lam moi ron","keo cha ron","cao bo lop ron","ron nha ve sinh"],"sort":1780},{"std_vi":"Chống thấm","std_en":"Waterproofing","grp":"FIN","kind":"service","patterns":["chong tham","gia cuong goc","gia cuong truoc khi","xu ly chong tham","xu li chan tuong"],"sort":1790},{"std_vi":"Trám khe, silicone","std_en":"Joint sealing","grp":"FIN","kind":"service","patterns":["bom chat tram","bom sealant","xu ly cac mep noi","xu li cac mep noi","ron kinh","thi cong xu ly ron kinh"],"sort":1800},{"std_vi":"Cán nền","std_en":"Floor screed","grp":"FIN","kind":"service","patterns":["can nen","lam phang be mat san","phu gia","xoa mat nen","dong ron xoa"],"sort":1810},{"std_vi":"Tô trát, xây tường","std_en":"Plastering \u0026 brickwork","grp":"FIN","kind":"service","patterns":["to trat","to can vua","to lai","xay tuong","xay dung to","xay tro","xay lai tuong","xay trat","tuong hang rao xay","dam va lai tuong","chi phi thay gach"],"sort":1820},{"std_vi":"Bê tông, cốt thép","std_en":"Concrete \u0026 rebar","grp":"FIN","kind":"goods","patterns":["be tong","mac 250","cot thep","sat hoa phat","sika grout"],"sort":1830},{"std_vi":"Vữa, gạch xây","std_en":"Mortar \u0026 bricks","grp":"FIN","kind":"goods","patterns":["vua xi mang","gach ong"],"sort":1840},{"std_vi":"Len chân tường","std_en":"Skirting","grp":"FIN","kind":"goods","patterns":["len chan tuong","chan len tuong"],"sort":1850},{"std_vi":"Chỉ phào","std_en":"Cornice moulding","grp":"FIN","kind":"goods","patterns":["chi phao"],"sort":1860},{"std_vi":"Nẹp inox","std_en":"Stainless trim","grp":"FIN","kind":"goods","patterns":["nep inox","nep l inox","u inox","v inox"],"sort":1870},{"std_vi":"Vách ngăn compact","std_en":"Compact partition","grp":"FIN","kind":"goods","patterns":["vach ngan compact"],"sort":1880},{"std_vi":"Ốp veneer, vách lam","std_en":"Veneer \u0026 slat cladding","grp":"FIN","kind":"goods","patterns":["veneer","vach lam","xu ly vach veneer"],"sort":1890},{"std_vi":"Inox tấm, ốp inox","std_en":"Stainless sheet cladding","grp":"FIN","kind":"goods","patterns":["inox tam","inox 304","inox op","tam inox","inox cover","op inox","thay toan bo bang inox","mat san inox","xuong gia co","khung inox","chan chiu luc","chan inox","mat tren"],"sort":1900},{"std_vi":"Rèm","std_en":"Curtain","grp":"FIN","kind":"goods","patterns":["rem"],"sort":1910},{"std_vi":"Decal dán","std_en":"Decal film","grp":"FIN","kind":"goods","patterns":["dan de can"],"sort":1920},{"std_vi":"Bồn cầu","std_en":"Toilet","grp":"SAN","kind":"goods","patterns":["bon cau"],"sort":1930},{"std_vi":"Bồn tiểu","std_en":"Urinal","grp":"SAN","kind":"goods","patterns":["bon tieu","van tieu","van cam ung tieu"],"sort":1940},{"std_vi":"Bồn tắm","std_en":"Bathtub","grp":"SAN","kind":"goods","patterns":["bon tam","thay bon tam"],"sort":1950},{"std_vi":"Sen tắm","std_en":"Shower set","grp":"SAN","kind":"goods","patterns":["sen tam","than cay sen","cu sen","voi sen"],"sort":1960},{"std_vi":"Vòi chậu lavabo","std_en":"Basin tap","grp":"SAN","kind":"goods","patterns":["voi nong lanh","voi chau"],"sort":1970},{"std_vi":"Vòi xịt","std_en":"Bidet spray","grp":"SAN","kind":"goods","patterns":["voi xit"],"sort":1980},{"std_vi":"Chậu lavabo, bàn đá","std_en":"Basin \u0026 vanity","grp":"SAN","kind":"goods","patterns":["lavabo","chau rua mat","ong thoat cho chau"],"sort":1990},{"std_vi":"Gương","std_en":"Mirror","grp":"SAN","kind":"goods","patterns":["guong"],"sort":2000},{"std_vi":"Phụ kiện phòng tắm","std_en":"Bathroom accessories","grp":"SAN","kind":"goods","patterns":["hop de giay","moc ao","day phoi"],"sort":2010},{"std_vi":"Thiết bị vệ sinh (sửa chữa)","std_en":"Sanitary works","grp":"SAN","kind":"service","patterns":["thiet bi ve sinh","thiet bi nha ve sinh","tbvs","phu kien lap dat bon cau"],"sort":2020},{"std_vi":"Bàn","std_en":"Table","grp":"FUR","kind":"goods","patterns":["ban tron","ban tiec","foldaway round table","alize low table","ban ghe"],"sort":2030},{"std_vi":"Ghế, bục ghế","std_en":"Seating","grp":"FUR","kind":"goods","patterns":["ghe","buc ghe","che op simili","sunlounger","headrest"],"sort":2040},{"std_vi":"Kệ, tủ gỗ","std_en":"Cabinet","grp":"FUR","kind":"goods","patterns":["ke tu","ke duoi tivi","ke trang diem","ke","tu quan ao","van mdf","khung go"],"sort":2050},{"std_vi":"Quầy","std_en":"Counter","grp":"FUR","kind":"goods","patterns":["quay pha che"],"sort":2060},{"std_vi":"Xe làm phòng, xe đẩy","std_en":"Trolley","grp":"FUR","kind":"goods","patterns":["xe lam phong","xe van chuyen"],"sort":2070},{"std_vi":"Sửa chữa nội thất","std_en":"Furniture repair","grp":"FUR","kind":"service","patterns":["sua chua noi that","sua chua va son moi noi that"],"sort":2080},{"std_vi":"Hệ thống PCCC","std_en":"Fire protection","grp":"FPS","kind":"goods","patterns":["chong chay lan","bao chay","pccc","hochiki"],"sort":2090},{"std_vi":"Hồ sơ PCCC, kiểm định","std_en":"Fire permit \u0026 inspection","grp":"FPS","kind":"service","patterns":["ho so pccc","tham duyet","kiem dinh","lap trinh he thong bao chay","nhuom chat chong chay"],"sort":2100},{"std_vi":"Tháo dỡ, phá dỡ","std_en":"Demolition \u0026 removal","grp":"SRV","kind":"service","patterns":["thao do","thao go","thao bo","thao may","thao cua","thao lap","duc bo","duc pha","pha do","dap tuong","dap bo","cong viec dap pha","nhan cong duc bo","nhan cong cat duc","cat mau nho","thao va lap","chi phi duc tuong","duc tuong"],"sort":2110},{"std_vi":"Vận chuyển xà bần","std_en":"Debris removal","grp":"SRV","kind":"service","patterns":["xa ban","van chuyen rac","rac thai","thu gom xu ly rac","do rac","van chuyen xa ban","xe xa ban"],"sort":2120},{"std_vi":"Vận chuyển","std_en":"Delivery","grp":"SRV","kind":"service","patterns":["van chuyen","delivery","freight","shipping","giao hang","customer clearance","cong viec van chuyen"],"sort":2130},{"std_vi":"Che chắn bảo vệ","std_en":"Protection works","grp":"SRV","kind":"service","patterns":["che chan","bao che","bat che","equipment cover","bao ve be mat","cong viec che chan","hop bao ve"],"sort":2140},{"std_vi":"Vệ sinh bàn giao","std_en":"Final cleaning","grp":"SRV","kind":"service","patterns":["ve sinh ban giao","ve sinh don dep","ve sinh sau","ve sinh hoan tra","cleanup after work","ve sinh hut bui","ve sinh lam moi","lam lai mat bang"],"sort":2150},{"std_vi":"Nhân công lắp đặt","std_en":"Installation labour","grp":"SRV","kind":"service","patterns":["nhan cong","cong lap dat","lap dat","installation","chi phi lap dat","chi phi thay the lap dat","phi nhan cong","chi phi thuc hien","nhan cong thuc hien"],"sort":2160},{"std_vi":"Chi phí quản lý","std_en":"Management fee","grp":"SRV","kind":"service","patterns":["chi phi quan ly","chi phi quan li","quan ly giam sat","nhan su","chi phi nhan su"],"sort":2170},{"std_vi":"Vật tư phụ","std_en":"Consumables","grp":"SRV","kind":"goods","patterns":["vat tu phu","phu kien","sub materials","supplies and accessories","chi phi vat tu phu","vat tu trien khai","vat tu thi cong","special discount for consumables","chi phi vat tu silicone","vat tu silicone"],"sort":2180},{"std_vi":"Giàn giáo, tời","std_en":"Scaffolding \u0026 hoist","grp":"SRV","kind":"service","patterns":["gian giao","su dung toi"],"sort":2190},{"std_vi":"Tư vấn, thiết kế","std_en":"Design consultancy","grp":"SRV","kind":"service","patterns":["dich vu tu van","thiet ke","ban ve","design","xay dung ho so","hop kick off"],"sort":2200},{"std_vi":"Khảo sát, chuẩn bị","std_en":"Survey \u0026 preparation","grp":"SRV","kind":"service","patterns":["khao sat","cong viec chuan bi","chuan bi be mat","di doi cac thiet bi"],"sort":2210},{"std_vi":"Đi lại, công tác phí","std_en":"Travel expenses","grp":"SRV","kind":"service","patterns":["di lai","an o","travel"],"sort":2220},{"std_vi":"Bảo hành, bảo trì","std_en":"Warranty \u0026 maintenance","grp":"SRV","kind":"service","patterns":["bao hanh","bao tri","ve sinh va bao tri","dich vu thay ac quy"],"sort":2230},{"std_vi":"Thi công ngoài giờ","std_en":"Night, restricted works","grp":"SRV","kind":"service","patterns":["thi cong tranh tieng on"],"sort":2240},{"std_vi":"Giấy phép thi công","std_en":"Works permit","grp":"SRV","kind":"service","patterns":["xin giay phep"],"sort":2250},{"std_vi":"Sửa chữa chung","std_en":"General repair","grp":"SRV","kind":"service","patterns":["sua chua","sua chua thay the","sua chua gan","sua chua cua"],"sort":2260},{"std_vi":"Chiết khấu","std_en":"Discount","grp":"OTH","kind":"other","patterns":["discount","chiet khau","phieu mua hang"],"sort":2270},{"std_vi":"Bảo hiểm","std_en":"Insurance","grp":"OTH","kind":"other","patterns":["bao hiem"],"sort":2280},{"std_vi":"Tổng cộng, tiêu đề","std_en":"Heading, total","grp":"OTH","kind":"heading","patterns":["grand total","cong viec khac","phan xay dung","phan mep","he thong nuoc","he gio lanh","he dien dieu khien","cong tac khac","included","toilet lobby","noi dung"],"sort":2290},{"std_vi":"Khoan, đục lỗ","std_en":"Drilling \u0026 coring","grp":"SRV","kind":"service","patterns":["khoan duc","khoan khoet","khoan"],"sort":2300},{"std_vi":"Keo dán gạch, đá","std_en":"Tile adhesive","grp":"FIN","kind":"goods","patterns":["keo dan","su dung keo dan"],"sort":2310},{"std_vi":"Công tắc thẻ phòng","std_en":"Key card switch","grp":"ELE","kind":"goods","patterns":["hop doc the","key card"],"sort":2320},{"std_vi":"Điều khiển từ xa","std_en":"Remote control","grp":"ICT","kind":"goods","patterns":["remote 4 chuc nang","remote"],"sort":2330},{"std_vi":"Bạt che","std_en":"Tarpaulin","grp":"SRV","kind":"goods","patterns":["bat mem"],"sort":2340},{"std_vi":"Ống (chung)","std_en":"Pipe (general)","grp":"PLB","kind":"goods","patterns":["ong"],"sort":2350},{"std_vi":"Khung sắt, thép","std_en":"Steel frame","grp":"FIN","kind":"goods","patterns":["khung sat","su dung khung sat"],"sort":2360},{"std_vi":"Hoàn thiện kiến trúc","std_en":"Architectural finishing","grp":"FIN","kind":"service","patterns":["cong viec hoan thien"],"sort":2370}];

;(() => {
// Fake of the standard-name engine of 32_price_db.sql (same rules, in JS).
const { db, RPC, save, me, now } = FK;
if (!db.pr_term || !db.pr_term.length) db.pr_term = (window.__TERMS || []).map((x, i) => Object.assign({ id: i + 1, active: true }, x));
const amNorm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
const words = p => ' ' + amNorm(String(p ?? '').toLowerCase().replace(/công tác/g, 'cong viec')).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const strip = w => ' ' + (w.trim() + ' ').replace(/^((\d+|i|ii|iii|iv|v|a|b) )?(bao gia san pham |bao gia thiet bi |bao gia |cung cap va lap dat |cung cap lap dat |cung cap va lap |cung cap thay the |cung cap |thay the |thay moi |thay |su dung |gan )/, '');
const find = w => { let best = null;
  for (const t of db.pr_term.filter(t => t.active)) for (const p0 of t.patterns || []) { const any = p0[0] === '*', p = p0.replace(/^\*/, ''); if (!p) continue;
    const pos = w.indexOf(' ' + p + ' '); if (pos < 0 || (p.length <= 3 && !any && pos > 0)) continue;
    if (!best || pos < best.pos || (pos === best.pos && (p.length > best.len || (p.length === best.len && t.sort < best.t.sort)))) best = { t, pos, len: p.length }; }
  return best ? best.t : null; };
const variant = p => { const m = String(p || '').match(/([Dd][Nn] ?\d+|[Pp]hi ?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)? ?[xX*×] ?\d+(?:[.,]\d+)?(?: ?[xX*×] ?\d+(?:[.,]\d+)?)?|\d+(?:[.,]\d+)? ?(?:mm|ly|cm|HP|hp|Hp|kW|KW|kw|BTU|btu|KVA|kVA|VA|inch)(?![a-zA-Z])|[Cc]at ?\.?[56]e?)/g); return m ? m.slice(0, 4).join(' · ') : null; };
const SPEC = /^((dim|model|mode|kich thuoc|kt|capacity|thong so|thong tin ki|nhan hieu|han hieu|hang san xuat|xuat xu|chat lieu|cong suat|dung tich|nhiet do|dien ap|size|voltage|with|the|power|external)\b|dn ?\d|\d)/;
const autoStd = (sid, limit) => { let n = 0;
  for (const l of db.pr_line.filter(l => l.std_src == null && (sid == null || l.source_id === sid))) { if (limit && n >= limit) break;
    const a = db.pr_alias.find(a => a.name_norm === amNorm(l.name_raw));
    if (a) { Object.assign(l, { name_std: a.name_std, term_id: a.term_id || null, std_src: 'alias', variant: variant(l.name_raw), grp: (db.pr_term.find(t => t.id === a.term_id) || {}).grp || null }); n++; continue; }
    const w = words(l.name_raw); let t = null;
    if (SPEC.test(w.trim()) && (l.section || '').trim()) { t = find(strip(words(l.section))); if (!t || t.kind === 'heading') { const t2 = find(strip(w)); if (t2) t = t2; } }
    else { t = find(strip(w)); if (!t && (l.section || '').trim()) t = find(strip(words(l.section))); }
    if (!t && /^bao gia/.test(w.trim())) t = db.pr_term.find(x => x.kind === 'heading');
    Object.assign(l, { term_id: t ? t.id : null, std_src: t ? 'rule' : 'none', variant: variant(l.name_raw), name_std: t ? `${t.std_vi}/${t.std_en}` : null, grp: t ? t.grp : null }); n++; }
  return n; };
const kindFix = sid => { for (const l of db.pr_line.filter(l => sid == null || l.source_id === sid)) { const t = db.pr_term.find(x => x.id === l.term_id);
  if (t && (t.kind === 'other' || t.kind === 'heading')) l.line_kind = 'other'; else if (l.line_kind === 'lump') {} else if (t && t.kind === 'service') l.line_kind = 'service'; else if (t) l.line_kind = 'goods';
  l.search_norm = amNorm([l.name_raw, l.name_std, l.brand, l.model, l.section].filter(Boolean).join(' ')); } };
// wrap the refreshing RPCs: after their own work, name the new lines and fix the kinds
for (const fn of ['pr_save_source', 'pr_import_legacy', 'pr_sync']) { const base = RPC[fn]; RPC[fn] = a => { const r = base(a); autoStd(null); kindFix(null); save(); return r; }; }
RPC.pr_set_std = ({ p_lines, p_std }) => {
  const names = new Set(db.pr_line.filter(l => p_lines.includes(l.id)).map(l => amNorm(l.name_raw)));
  if (!p_std) { db.pr_alias = db.pr_alias.filter(a => !names.has(a.name_norm)); for (const l of db.pr_line) if (names.has(amNorm(l.name_raw))) Object.assign(l, { std_src: null, name_std: null, term_id: null, grp: null }); }
  else { const t = db.pr_term.find(t => `${t.std_vi}/${t.std_en}`.toLowerCase() === p_std.toLowerCase() || t.std_vi.toLowerCase() === p_std.toLowerCase());
    const std = t ? `${t.std_vi}/${t.std_en}` : p_std;
    for (const n of names) { db.pr_alias = db.pr_alias.filter(a => a.name_norm !== n); db.pr_alias.push({ name_norm: n, name_std: std, term_id: t ? t.id : null }); }
    for (const l of db.pr_line) { if (p_lines.includes(l.id)) Object.assign(l, { name_std: std, term_id: t ? t.id : null, std_src: 'manual', grp: t ? t.grp : null });
      else if (l.std_src !== 'manual' && names.has(amNorm(l.name_raw))) Object.assign(l, { name_std: std, term_id: t ? t.id : null, std_src: 'alias', grp: t ? t.grp : null }); } }
  autoStd(null); kindFix(null); save(); return p_lines.length; };
RPC.pr_term_save = ({ p }) => { const pats = (Array.isArray(p.patterns) ? p.patterns : String(p.patterns || '').split(';')).map(x => (x.trim()[0] === '*' ? '*' : '') + words(x.replace(/^\s*\*/, '')).trim()).filter(x => x.replace('*', ''));
  if (String(p.std_vi || '').includes('/')) throw new Error('Tên tiếng Việt không dùng dấu "/".');
  let t = p.id && db.pr_term.find(x => x.id === p.id); if (!t) { t = { id: Math.max(0, ...db.pr_term.map(x => x.id)) + 1, sort: 5000 }; db.pr_term.push(t); }
  Object.assign(t, { std_vi: p.std_vi, std_en: p.std_en, grp: p.grp, kind: p.kind, patterns: pats, active: p.active !== false });
  for (const l of db.pr_line.filter(l => l.term_id === t.id)) Object.assign(l, { name_std: `${t.std_vi}/${t.std_en}`, grp: t.grp }); save(); return t.id; };
RPC.pr_std_run = ({ p_reset, p_limit }) => { if (p_reset) for (const l of db.pr_line) if (l.std_src !== 'manual') Object.assign(l, { std_src: null, term_id: null, name_std: null, grp: null });
  autoStd(null, p_limit); const left = db.pr_line.filter(l => l.std_src == null).length; if (!left) kindFix(null); save(); return { left }; };
// search: add the naming columns and filters
const baseSearch = RPC.pr_search;
RPC.pr_search = a => { const f = a.p_f || {}; let rows = baseSearch(Object.assign({}, a, { p_f: Object.assign({}, f, { limit: 5000 }) }));
  rows = rows.map(r => { const l = db.pr_line.find(x => x.id === r.id) || {}; return Object.assign(r, { grp: l.grp, variant: l.variant, std_src: l.std_src, term_id: l.term_id, line_kind: l.line_kind, name_std: l.name_std }); })
    .filter(r => (!f.grp || r.grp === f.grp) && (!f.term_id || r.term_id === f.term_id) && (!f.goods_only || r.line_kind === 'goods'));
  return rows.slice(0, f.limit || 200); };
const baseOv = RPC.pr_overview;
RPC.pr_overview = () => { const o = baseOv(); const named = {}; for (const l of db.pr_line) named[l.std_src || 'pending'] = (named[l.std_src || 'pending'] || 0) + 1;
  return Object.assign(o, { named, lines: db.pr_line.length, no_std: db.pr_line.filter(l => !l.name_std && l.line_kind !== 'other').length }); };
})();

;(() => {
// Fake 33_meetings.sql: same rules as the SQL functions, enough to drive the screens.
const { db, RPC, save, me, now, users } = FK;
const err = m => { throw new Error(m); };
for (const k of ['pm_mt_topic', 'pm_mt_meeting', 'pm_mt_entry', 'pm_mt_action', 'pm_notice']) db[k] = db[k] || [];
const role = (...rs) => me().roles.some(([x]) => rs.includes(x));
const base = RPC.app_me;
RPC.app_me = () => { const r = base(); const am = role('AM_COORD', 'AM_EXEC', 'SYS_ADMIN');
  r.perms = Object.assign({}, r.perms, { meeting: { view: true, create: am, edit: am, approve: false, admin: role('AM_COORD', 'SYS_ADMIN') } }); return r; };
const need = a => { const am = role('AM_COORD', 'AM_EXEC', 'SYS_ADMIN'); if (a === 'admin' ? !role('AM_COORD', 'SYS_ADMIN') : !am) err(`Không có quyền "${a}" trên "meeting".`); };
const nm = () => me().full_name;
const uname = id => (users.find(u => u.id === id) || {}).full_name || null;
const id = () => db.seq++;
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
const notify = (uids, kind, no, type, comment) => { for (const u of new Set(uids)) if (u && u !== me().id)
  db.pm_notice.push({ id: id(), user_id: u, kind, doc_no: no, doc_type: type, project_code: null, actor_email: me().email, comment: comment || null, created_at: now(), read_at: null }); };
const nextNo = d => { const b = 'MT-' + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10); let v = b, n = 1; while (db.pm_mt_meeting.some(m => m.no === v)) v = b + '-' + (++n); return v; };
const nz = v => v == null || String(v).trim() === '' ? null : v;
RPC.mt_people = () => { need('create'); return users.filter(u => u.active).map(u => ({ id: u.id, name: u.full_name || u.email, email: u.email })); };
RPC.mt_save_topic = ({ p }) => { need('create');
  if (!nz(p.title_vi) && !nz(p.title_en)) err('Chủ đề cần có tên. / A topic needs a title.');
  let t = p.id && db.pm_mt_topic.find(x => x.id === p.id);
  if (!t) { t = { id: id(), status: 'open', sort: Math.max(0, ...db.pm_mt_topic.map(x => x.sort)) + 10, source: 'app', created_name: nm(), created_at: now() }; db.pm_mt_topic.push(t); }
  Object.assign(t, { title_vi: nz(p.title_vi) || p.title_en.trim(), title_en: nz(p.title_en), project_code: nz(p.project_code), status: p.status || t.status, note: p.note || null, updated_at: now() });
  return t.id; };
RPC.mt_save_meeting = ({ p }) => { need('create');
  let m = p.id && db.pm_mt_meeting.find(x => x.id === p.id);
  if (!m) { if (!p.meeting_date) err('Cần ngày họp.'); m = { id: id(), no: nextNo(p.meeting_date), status: 'draft', source: 'app', created_name: nm(), created_at: now(), attendees: [] }; db.pm_mt_meeting.push(m); }
  Object.assign(m, { meeting_date: p.meeting_date || m.meeting_date, title_vi: p.title_vi ?? null, title_en: p.title_en ?? null, place: p.place ?? null,
    attendees: p.attendees || m.attendees, file_url: nz(p.file_url), note: p.note ?? null, updated_at: now() });
  return m.id; };
RPC.mt_delete_meeting = ({ p_id }) => { need('edit'); const m = db.pm_mt_meeting.find(x => x.id === p_id); if (m && m.status === 'issued') need('admin');
  db.pm_mt_meeting = db.pm_mt_meeting.filter(x => x.id !== p_id); db.pm_mt_entry = db.pm_mt_entry.filter(x => x.meeting_id !== p_id); db.pm_mt_action = db.pm_mt_action.filter(x => x.meeting_id !== p_id); };
RPC.mt_save_entry = ({ p }) => { need('create');
  let e = p.id && db.pm_mt_entry.find(x => x.id === p.id);
  if (!e) { if (!p.meeting_id || !p.topic_id) err('Cần cuộc họp và chủ đề.'); e = { id: id(), meeting_id: p.meeting_id, topic_id: p.topic_id, sort: Math.max(0, ...db.pm_mt_entry.filter(x => x.meeting_id === p.meeting_id).map(x => x.sort)) + 10 }; db.pm_mt_entry.push(e); }
  for (const f of ['stage', 'progress', 'discussion', 'decision', 'note']) for (const l of ['vi', 'en']) e[`${f}_${l}`] = p[`${f}_${l}`] ?? null;
  Object.assign(e, { updated_name: nm(), updated_at: now() }); return e.id; };
RPC.mt_delete_entry = ({ p_id }) => { need('edit'); db.pm_mt_action = db.pm_mt_action.filter(a => !(a.entry_id === p_id && a.status === 'open')); db.pm_mt_entry = db.pm_mt_entry.filter(x => x.id !== p_id); };
RPC.mt_save_action = ({ p }) => { need('create');
  let a = p.id && db.pm_mt_action.find(x => x.id === p.id), old = a ? a.pic_user : null;
  if (!a) { a = { id: id(), meeting_id: p.meeting_id, topic_id: p.topic_id, entry_id: p.entry_id || null, status: 'open', created_at: now(), sort: 0 }; db.pm_mt_action.push(a); }
  Object.assign(a, { text_vi: p.text_vi ?? null, text_en: p.text_en ?? null, pic_user: p.pic_user || null, pic_name: nz(p.pic_name) || uname(p.pic_user),
    due_date: p.due_date || null, due_text: nz(p.due_text), updated_at: now() });
  const m = db.pm_mt_meeting.find(x => x.id === a.meeting_id);
  if (m && m.status === 'issued' && a.pic_user && a.pic_user !== old) notify([a.pic_user], 'todo', m.no, 'MA', a.text_vi || a.text_en);
  return a.id; };
RPC.mt_delete_action = ({ p_id }) => { need('edit'); db.pm_mt_action = db.pm_mt_action.filter(x => x.id !== p_id); };
RPC.mt_action_set = ({ p_id, p_status, p_note, p_meeting }) => {
  const a = db.pm_mt_action.find(x => x.id === p_id); if (!a) err('Không thấy việc.');
  if (!(role('AM_COORD', 'AM_EXEC', 'SYS_ADMIN') || a.pic_user === me().id)) err('Chỉ nhóm QLTS hoặc người phụ trách mới đổi được việc này.');
  if (!['open', 'done', 'dropped'].includes(p_status)) err('Trạng thái không hợp lệ');
  const op = p_status === 'open';
  Object.assign(a, { status: p_status, done_at: op ? null : now(), done_name: op ? null : nm(), done_note: op ? null : (p_note ?? a.done_note), closed_meeting_id: op ? null : p_meeting || null, updated_at: now() }); };
RPC.mt_issue = ({ p_id }) => { need('edit'); const m = db.pm_mt_meeting.find(x => x.id === p_id); if (!m) err('Không thấy cuộc họp.');
  Object.assign(m, { status: 'issued', issued_at: now(), issued_name: nm() });
  const att = (m.attendees || []).map(x => x.user_id).filter(u => u && u !== me().id);
  const pic = db.pm_mt_action.filter(a => a.meeting_id === p_id && a.status === 'open' && a.pic_user).map(a => a.pic_user).filter(u => !att.includes(u) && u !== me().id);
  notify(att, 'todo', m.no, 'MT', m.title_vi); notify(pic, 'todo', m.no, 'MA');
  return new Set(att).size + new Set(pic).size; };
RPC.mt_unissue = ({ p_id }) => { need('admin'); db.pm_mt_meeting.find(x => x.id === p_id).status = 'draft'; };
const COLS = { topic: ['pm_mt_topic', ['title_vi', 'title_en']], meeting: ['pm_mt_meeting', ['title_vi', 'title_en']], action: ['pm_mt_action', ['text_vi', 'text_en']],
  entry: ['pm_mt_entry', ['stage', 'progress', 'discussion', 'decision', 'note'].flatMap(f => [f + '_vi', f + '_en'])] };
RPC.mt_apply_text = ({ p_items }) => { need('create'); let n = 0;
  for (const x of p_items || []) { const c = COLS[x.t]; if (!c || !c[1].includes(x.f)) continue; const r = db[c[0]].find(y => y.id === Number(x.id)); if (!r) continue; r[x.f] = nz(x.v); n++; }
  return n; };
RPC.mt_import = ({ p_rows, p_reset }) => { need('admin'); let nm_ = 0, ne = 0, na = 0;
  if (p_reset) { const ids = db.pm_mt_meeting.filter(m => m.source === 'import').map(m => m.id);
    db.pm_mt_meeting = db.pm_mt_meeting.filter(m => m.source !== 'import'); db.pm_mt_entry = db.pm_mt_entry.filter(e => !ids.includes(e.meeting_id)); db.pm_mt_action = db.pm_mt_action.filter(a => !ids.includes(a.meeting_id));
    db.pm_mt_topic = db.pm_mt_topic.filter(t => t.source !== 'import' || db.pm_mt_entry.some(e => e.topic_id === t.id)); }
  for (const r of p_rows || []) {
    if (!r.date || !(nz(r.topic_vi) || nz(r.topic_en))) continue;
    let m = db.pm_mt_meeting.find(x => x.meeting_date === r.date && x.source === 'import');
    if (!m) { m = { id: id(), no: nextNo(r.date), meeting_date: r.date, title_vi: 'Họp định kỳ dự án Capex', title_en: 'Capex projects progress meeting', status: 'issued', issued_at: r.date, issued_name: nm(), source: 'import', attendees: [], created_name: nm() }; db.pm_mt_meeting.push(m); nm_++; }
    const tv = nz(r.topic_vi) || r.topic_en;
    let t = db.pm_mt_topic.find(x => norm(x.title_vi) === norm(tv));
    if (!t) { t = { id: id(), title_vi: tv, title_en: nz(r.topic_en), status: 'open', sort: r.topic_sort || 0, source: 'import', created_name: nm() }; db.pm_mt_topic.push(t); }
    const e = { id: id(), meeting_id: m.id, topic_id: t.id, sort: r.sort || 0, updated_name: nm() };
    for (const f of ['stage', 'progress', 'discussion', 'note']) for (const l of ['vi', 'en']) e[`${f}_${l}`] = nz(r[`${f}_${l}`]);
    db.pm_mt_entry.push(e); ne++;
    for (const a of r.actions || []) { db.pm_mt_action.push({ id: id(), meeting_id: m.id, topic_id: t.id, entry_id: e.id, text_vi: nz(a.vi), text_en: nz(a.en), pic_name: nz(r.pic),
      due_date: r.due_date || null, due_text: nz(r.due_text), status: 'historical', sort: na }); na++; }
  }
  return { meetings: nm_, entries: ne, actions: na }; };
})();

;(() => {
// Fake 34_contracts.sql: same rules as the SQL functions, enough to drive the screens.
const { db, RPC, save, me, now, users } = FK;
const err = m => { throw new Error(m); };
for (const k of ['pm_contract', 'pm_contract_file', 'pm_notice']) db[k] = db[k] || [];
db.ct_seq = db.ct_seq || 0;
if (!users.some(u => u.id === 'u12')) users.push({ id: 'u12', email: 'legal@x', full_name: 'Pháp chế', active: true, roles: [['LEGAL', 'PHCL']] });
if (!users.some(u => u.id === 'u13')) users.push({ id: 'u13', email: 'jgm2@x', full_name: 'JVC GM', active: true, roles: [['JVC_GM', 'PHCL']] });
const has = (...rs) => me().roles.some(([x]) => rs.includes(x));
const VIEW = ['PURCHASING', 'DEPT_HEAD', 'DOF', 'HOTEL_GM', 'CP_HEAD', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM', 'LEGAL', 'SYS_ADMIN'];
const W = ['PURCHASING', 'AM_COORD', 'AM_EXEC', 'SYS_ADMIN'];
const base = RPC.app_me;
RPC.app_me = () => { const r = base(); r.perms = Object.assign({}, r.perms, { contract: { view: has(...VIEW), create: has(...W), edit: has(...W), approve: has(...VIEW), admin: has('AM_COORD', 'SYS_ADMIN') } }); return r; };
const need = a => { const ok = a === 'view' ? has(...VIEW) : a === 'admin' ? has('AM_COORD', 'SYS_ADMIN') : has(...W); if (!ok) err(`Không có quyền "${a}" trên "contract".`); };
const org = c => db.am_org.find(o => o.code === c);
const covers = (scope, dept) => { if (org(scope) && !org(scope).parent_code) return true; let o = org(dept), g = 0; while (o && g++ < 10) { if (o.code === scope) return true; o = org(o.parent_code); } return false; };
const isActor = (roles, dept, u = me()) => u.roles.some(([r, s]) => roles.includes(r) && covers(s, dept));
const entity = dept => { let o = org(dept); while (o) { if (o.code === 'SOF') return 'SSP'; if (o.code === 'CP') return 'CP'; if (o.code === 'JVC') return 'JVC'; o = org(o.parent_code); } return 'SSP'; };
const see = dept => has('PURCHASING', 'DOF', 'HOTEL_GM', 'CP_HEAD', 'AM_COORD', 'AM_EXEC', 'CHIEF_ACC', 'JVC_DGM', 'JVC_GM', 'LEGAL', 'SYS_ADMIN') || (dept && isActor(['DEPT_HEAD'], dept));
const notify = (uids, kind, no, dept, comment) => { for (const u of new Set(uids)) if (u && u !== me().id) db.pm_notice.push({ id: db.seq++, user_id: u, kind, doc_no: no, doc_type: 'HD', project_code: dept, actor_email: me().email, comment: comment || null, created_at: now(), read_at: null }); };
const actors = (roles, dept) => users.filter(u => isActor(roles, dept, u)).map(u => u.id);
const nz = v => v == null || String(v).trim() === '' ? null : v;
const n = v => nz(v) == null ? null : Number(v);
const addMonths = (d, m) => { if (!d || m == null) return null; const x = new Date(d); x.setMonth(x.getMonth() + Number(m)); return x.toISOString().slice(0, 10); };
const ROUTE = { SSP: { hotel: ['DEPT_HEAD', 'DOF', 'HOTEL_GM'], jvc: ['AM_COORD', 'CHIEF_ACC', 'JVC_GM'] }, CP: { hotel: ['CP_HEAD'], jvc: ['AM_COORD', 'CHIEF_ACC', 'JVC_GM'] }, JVC: { hotel: [], jvc: ['AM_COORD', 'CHIEF_ACC', 'JVC_GM'] } };
const steps = c => { const r = ROUTE[c.entity || entity(c.dept_code)] || ROUTE.SSP; const s = r.hotel.map((x, i) => ({ key: 'h' + (i + 1), side: 'hotel', roles: [x], dept: c.dept_code }));
  const amt = (Number(c.value_pre_vat ?? c.value_total) || 0) * (Number(c.fx_rate) || 1);
  if (amt >= 1e9 || !s.length) { s.push({ key: 'legal', side: 'legal', roles: ['LEGAL'], dept: c.dept_code }); r.jvc.forEach((x, i) => s.push({ key: 'j' + (i + 1), side: 'jvc', roles: [x], dept: c.dept_code })); }
  return s; };
const get = id => { const c = db.pm_contract.find(x => x.id === id); if (!c) err('Không có hợp đồng ' + id); return c; };
RPC.pm_ct_save = ({ p }) => { need('create');
  let c = p.id && db.pm_contract.find(x => x.id === p.id);
  if (!c) { c = { id: db.seq++, no: `HD-2026-${String(++db.ct_seq).padStart(4, '0')}`, status: 'draft', source: p.source || 'app', created_by: me().id, created_name: me().full_name, created_at: now(),
    dept_code: nz(p.dept_code), entity: entity(p.dept_code), currency: 'VND', fx_rate: 1, pay_terms: [], bonds: [], terms_pages: {}, auto_renew: false, kind: 'supply', scope: 'capex' }; db.pm_contract.push(c); }
  if (c.status === 'cancelled') err('Đã huỷ');
  if (!see(c.dept_code)) err('Không có quyền với hợp đồng này.');
  const open = ['draft', 'returned'].includes(c.status) || has('AM_COORD', 'SYS_ADMIN');
  for (const f of ['contract_no', 'title', 'project_code', 'po_no', 'vendor_code', 'supplier', 'supplier_tax', 'signed_date', 'start_date', 'end_date', 'delivery_due', 'delivery_text',
                   'warranty_start', 'handover_date', 'penalty_text', 'summary', 'legal_ref']) c[f] = nz(p[f]);
  if (p.kind) c.kind = p.kind; if (p.scope) c.scope = p.scope; if (p.doc_id) c.doc_id = p.doc_id;
  if (p.pay_terms) c.pay_terms = p.pay_terms; if (p.bonds) c.bonds = p.bonds; if (p.terms_pages) c.terms_pages = p.terms_pages; if (p.terms_src) c.terms_src = p.terms_src;
  if (p.auto_renew != null) c.auto_renew = !!p.auto_renew;
  c.warranty_months = n(p.warranty_months); c.notice_days = n(p.notice_days);
  c.warranty_until = nz(p.warranty_until) || addMonths(c.handover_date, c.warranty_months);
  if (open) { if (nz(p.dept_code)) { c.dept_code = p.dept_code; c.entity = entity(p.dept_code); } if (p.currency) c.currency = p.currency;
    c.value_pre_vat = n(p.value_pre_vat); c.vat_pct = n(p.vat_pct); c.value_total = n(p.value_total) ?? (c.value_pre_vat != null ? Math.round(c.value_pre_vat * (1 + (c.vat_pct || 0) / 100)) : null); }
  c.updated_at = now(); return c.id; };
RPC.pm_ct_file_add = ({ p }) => { need('create'); const c = get(p.contract_id); if (!see(c.dept_code)) err('no');
  const f = { id: db.seq++, contract_id: c.id, kind: p.kind || 'contract', name: nz(p.name), source: p.source, storage_path: nz(p.storage_path), url: nz(p.url), size_bytes: n(p.size_bytes), pages: n(p.pages), ocr: {}, uploaded_name: me().full_name, created_at: now() };
  if (f.source === 'link' && !/^https:\/\//i.test(f.url || '')) err('link'); db.pm_contract_file.push(f); return f.id; };
RPC.pm_ct_file_del = ({ p_id }) => { need('edit'); const f = db.pm_contract_file.find(x => x.id === p_id); db.pm_contract_file = db.pm_contract_file.filter(x => x.id !== p_id); return f ? f.storage_path : null; };
RPC.pm_ct_ocr_save = ({ p_file, p_pages }) => { need('create'); const f = db.pm_contract_file.find(x => x.id === p_file); if (f) { f.ocr = Object.assign({}, f.ocr, p_pages); f.pages = f.pages || n(p_pages._pages); } };
RPC.pm_ct_submit = ({ p_id }) => { need('create'); const c = get(p_id);
  if (!['draft', 'returned'].includes(c.status)) err('Không ở trạng thái nháp'); if (!c.dept_code) err('Chọn bộ phận của hợp đồng trước khi gửi duyệt.');
  if (c.value_pre_vat == null && c.value_total == null) err('Ghi giá trị hợp đồng trước khi gửi duyệt.');
  const s = steps(c); Object.assign(c, { status: 'review', route: s, cur: 0, submitted_at: now(), needs_legal: s.some(x => x.side === 'legal') });
  notify(actors(s[0].roles, s[0].dept), 'todo', c.no, c.dept_code, c.title); };
RPC.pm_ct_act = ({ p_id, p_action, p_comment }) => { need('view'); const c = get(p_id);
  if (c.status !== 'review') err('Không chờ duyệt'); const st = c.route[c.cur];
  if (!isActor(st.roles, st.dept)) err('Bước này không phải của bạn.');
  if (p_action !== 'approve' && !nz(p_comment)) err('Ghi lý do trả lại / từ chối.');
  Object.assign(st, { by: me().id, name: me().full_name, at: now(), action: p_action, comment: p_comment || null });
  const last = c.cur === c.route.length - 1;
  if (p_action === 'return') { Object.assign(c, { status: 'returned', cur: null }); notify([c.created_by], 'returned', c.no, c.dept_code, p_comment); }
  else if (p_action === 'reject') { Object.assign(c, { status: 'rejected', cur: null }); notify([c.created_by], 'rejected', c.no, c.dept_code, p_comment); }
  else if (last) { Object.assign(c, { status: 'approved', cur: null, approved_at: now() }); notify([c.created_by], 'approved', c.no, c.dept_code, p_comment); }
  else { c.cur++; const nx = c.route[c.cur]; notify(actors(nx.roles, nx.dept), 'todo', c.no, c.dept_code, c.title); }
  return c.status; };
RPC.pm_ct_inbox = () => db.pm_contract.filter(c => c.status === 'review' && isActor(c.route[c.cur].roles, c.route[c.cur].dept) && c.created_by !== me().id);
RPC.pm_ct_set_status = ({ p_id, p_status, p_comment }) => { need('edit'); const c = get(p_id);
  if (p_status === 'active' && !['approved', 'completed'].includes(c.status) && !(c.source === 'import' && ['draft', 'returned'].includes(c.status)) && !has('AM_COORD', 'SYS_ADMIN')) err('Hợp đồng chưa được duyệt ký.');
  c.status = p_status; if (p_comment) (c.route = c.route || []).push({ key: p_status, name: me().full_name, at: now(), action: p_status, comment: p_comment }); };
RPC.pm_ct_alerts = () => { need('view'); const today = new Date().toISOString().slice(0, 10), dd = d => Math.round((new Date(d) - new Date(today)) / 864e5); const out = [];
  for (const c of db.pm_contract.filter(x => ['approved', 'active', 'completed'].includes(x.status) && see(x.dept_code))) {
    const add = (kind, due, detail, lim) => { if (!due) return; const d = dd(due); if (d <= lim && (['delivery', 'payment'].includes(kind) || d >= -30)) out.push({ contract_id: c.id, no: c.no, title: c.title, kind, due, days: d, detail: detail || null }); };
    if (c.status !== 'completed') add('end', c.end_date, null, 60); add('warranty', c.warranty_until, null, 30);
    if (!c.handover_date && c.status !== 'completed') add('delivery', c.delivery_due, null, 7);
    for (const b of c.bonds || []) add('bond', b.expiry, b.kind, 60);
    for (const t0 of c.pay_terms || []) if (/^\d{4}-\d{2}-\d{2}$/.test(t0.due || '') && !t0.paid) add('payment', t0.due, t0.milestone, 7); }
  return out.sort((a, b) => a.due.localeCompare(b.due)); };
})();

;(() => {
// Fake 35_vendor_photo_count.sql.
const { db, RPC, save, me, now } = FK;
db.pm_vendor = db.pm_vendor || [];
RPC.pm_vendor_import = ({ p_rows, p_all_codes }) => { let a = 0, u = 0, s = 0, d = 0;
  for (const r of p_rows || []) { const code = String(r.code || '').trim().toUpperCase(); if (!code || !r.name) { s++; continue; }
    const v = db.pm_vendor.find(x => x.code === code);
    const nz = x => (x == null || String(x).trim() === '' ? null : String(x).trim());
    if (!v) { db.pm_vendor.push({ code, name: r.name, tax_code: nz(r.tax_code), address: nz(r.address), phone: nz(r.phone), active: true, acc_synced_at: now() }); a++; }
    else if (v.name !== r.name || v.tax_code !== nz(r.tax_code) || v.address !== nz(r.address) || v.phone !== nz(r.phone) || !v.active) { Object.assign(v, { name: r.name, tax_code: nz(r.tax_code), address: nz(r.address), phone: nz(r.phone), active: true, acc_synced_at: now() }); u++; }
    else v.acc_synced_at = now(); }
  if (p_all_codes) for (const v of db.pm_vendor) if (v.active && v.acc_synced_at && !p_all_codes.includes(v.code)) { v.active = false; d++; }
  return { added: a, updated: u, skipped: s, deactivated: d }; };
RPC.am_asset_set_avatar = ({ p_asset, p_photo }) => { const a = db.am_asset.find(x => x.id === p_asset); a.avatar_photo_id = p_photo; };
RPC.am_count_photo = ({ p_line, p_photo, p_avatar }) => { const l = db.am_count_line.find(x => x.id === p_line); const c = db.am_count.find(x => x.id === l.count_id);
  if (c.status !== 'open') throw new Error('Đợt không mở');
  Object.assign(l, { photo_id: p_photo, found: l.found == null ? true : l.found, qty_found: l.qty_found ?? l.qty_book, loc_found: l.found == null ? l.loc_book : l.loc_found,
    by_name: l.by_name || me().full_name, at: l.at || now() });
  if (p_avatar) db.am_asset.find(x => x.id === l.asset_id).avatar_photo_id = p_photo; };
const baseOpen = RPC.am_count_open;
if (baseOpen) RPC.am_count_open = a => { const n = baseOpen(a); for (const l of db.am_count_line) if (l.asset_id && l.group_code == null) { const x = db.am_asset.find(y => y.id === l.asset_id); if (x) { l.group_code = x.group_code; l.category_code = x.category_code; } } save(); return n; };
// Trigger am_photo_avatar_auto: after a photo row is inserted.
const f0 = window.fetch;
window.fetch = async (url, opts = {}) => {
  const r = await f0(url, opts);
  if (String(url).includes('/rest/v1/am_asset_photo') && (opts.method || 'GET').toUpperCase() === 'POST') {
    for (const p of [].concat(JSON.parse(opts.body))) {
      const row = db.am_asset_photo.find(x => x.storage_path === p.storage_path && x.asset_id === p.asset_id);
      if (row && row.source === 'storage' && ['overall', 'count', 'avatar'].includes(row.kind)) { const a = db.am_asset.find(x => x.id === row.asset_id); if (a && (!a.avatar_photo_id || row.kind === 'avatar')) a.avatar_photo_id = row.id; }
      if (row) row.taken_at = row.taken_at || now();
    }
    save();
  }
  return r;
};
})();
;(() => {
// Fake 36_demo_mode.sql + DEMO_SETUP am_demo_reset.
const { db, RPC, me, now } = FK;
const mode = localStorage.getItem('fkmode') || 'live';
db.am_setting = (db.am_setting || []).filter(r => !['app_mode', 'demo_cfg', 'feedback_button'].includes(r.key));
db.am_setting.push({ key: 'app_mode', value: mode, note: 'mode' }, { key: 'demo_cfg', value: mode === 'live' ? { url: 'https://fake.supabase.co', key: 'demo-anon' } : {}, note: 'cfg' },
                   { key: 'feedback_button', value: false, note: 'fb' });
db.app_feedback = db.app_feedback || [
  { id: 901, created_at: '2026-09-26T09:12:00Z', email: 'demo.staff@plaza-demo.test', kind: 'bug', view: 'register — Asset register', text: 'Bấm Xuất Excel khi lọc theo vị trí thì file trống.', app_version: '20260927b', lang: 'vi', status: 'new' },
  { id: 902, created_at: '2026-09-26T10:40:00Z', email: 'demo.gm@plaza-demo.test', kind: 'idea', view: 'pmdash — Dashboard', text: 'Would like a chart of capex spent vs budget by month.', app_version: '20260927b', lang: 'en', status: 'planned', reply: 'Next release', handled_by: 'Admin', handled_at: '2026-09-26T11:00:00Z' },
  { id: 903, created_at: '2026-09-27T08:05:00Z', email: 'demo.kithead@plaza-demo.test', kind: 'praise', view: 'stockcount — Stock-take', text: 'Chụp ảnh kiểm kê rất tiện!', app_version: '20260927b', lang: 'vi', status: 'done' }];
db.app_user = [
  { email: 'demo.admin@plaza-demo.test', full_name: 'Quản trị Demo', active: true, 'app_user_role(role_code)': [{ role_code: 'SYS_ADMIN' }] },
  { email: 'demo.staff@plaza-demo.test', full_name: 'Nguyễn Minh Anh (NV Bếp)', active: true, 'app_user_role(role_code)': [{ role_code: 'DEPT_STAFF' }] }];
RPC.am_demo_reset = () => { if (mode !== 'demo') throw new Error('Đây không phải project demo'); window.__resetN = (window.__resetN || 0) + 1;
  return { assets: 1200, vendors: 60, projects: 66, contracts: 42, meetings: 6 }; };
})();
