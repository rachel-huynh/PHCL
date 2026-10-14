/* ============================================================ DEMO / TRAINING MODE
   (36_demo_mode.sql + sql/demo/DEMO_SETUP.sql) — user 27/09/2026.

   The demo is a SEPARATE Supabase project filled with made-up data of the same
   nature as the real thing (DEMO_SETUP.sql). Real data never sits next to it,
   so "Refresh demo data" cannot touch it and testers may press every button.
   This file is the browser side:

     · banner   a striped bar on every screen (and on the sign-in box) while
                this browser talks to the demo project. The database has the
                last word: am_setting app_mode = 'demo'. A link that CLAIMS to
                be a demo but reaches a live project gets a red warning instead.
     · switch   Admin tools → "Demo / training mode": the admin saves the demo
                project's URL + anon key (am_setting demo_cfg) once, then
                switches this browser over and back. The live project and its
                session wait in localStorage (LIVE_KEY) meanwhile.
     · link     the demo link (#sbcfg=… with demo:1) to send testers, with an
                invitation text listing the demo accounts.
     · reset    am_demo_reset(): wipe and regenerate the demo data (admin).
     · feedback the 💬 button (always on the demo; on live when feedback_button
                is true) → app_feedback; the admin reads, answers, exports.

   Loaded after app.js; uses its helpers (el, msg, t, can, SB, CFG, LS_KEY,
   SESS_KEY, SESS, ME, VIEW, APP_VERSION, LANG, fmtDateTime). */

const LIVE_KEY = 'asset-intake.sb.live';   // { cfg, sess } of the live project while this browser visits the demo
const DM = { mode: null, fbOn: false, cfg: {}, fb: [], fbFilter: 'open', people: null };
const DM_KINDS = ['bug', 'idea', 'question', 'praise'];
const DM_STATUS = ['new', 'seen', 'planned', 'done', 'wontfix'];
const dmLiveSaved = () => { try { return JSON.parse(localStorage.getItem(LIVE_KEY) || 'null'); } catch { return null; } };
const dmIsDemo = () => DM.mode === 'demo' || (DM.mode === null && !!CFG.demo);
const dmCfgLink = c => location.origin + location.pathname + '#sbcfg='
  + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify({ url: c.url, key: c.key, demo: 1 })))));

/* Called by loadCfg() when an address-bar link brings a project. Opening a demo
   link in a browser that is signed in to the live project keeps the live side
   aside (so "Back to real data" works) instead of sending the live token to
   the demo project; any other change of project drops the old session. */
function dmOnLink(prev, next) {
  if (!prev || !prev.url || prev.url === next.url) return;
  if (next.demo && !prev.demo) {
    let sess = null;
    try { sess = JSON.parse(localStorage.getItem(SESS_KEY) || 'null'); } catch {}
    try { localStorage.setItem(LIVE_KEY, JSON.stringify({ cfg: prev, sess })); } catch {}
  }
  try { localStorage.removeItem(SESS_KEY); } catch {}
}

/* The bar across the top. Before sign-in only the link's flag is known; after
   sign-in dmCheck() asks the database. */
function dmBar() {
  const bar = $('#demoBar');
  if (!bar) return;
  const demo = dmIsDemo(), clash = !!CFG.demo && DM.mode === 'live';
  document.body.classList.toggle('demo', demo);
  document.body.classList.toggle('democlash', clash);
  bar.hidden = !demo && !clash;
  bar.innerHTML = '';
  if (bar.hidden) return;
  bar.className = 'demobar' + (clash ? ' clash' : '');
  bar.append(el('b', { textContent: clash ? t('dm.bar.clash') : t('dm.bar') }),
             el('span', { textContent: clash ? t('dm.bar.clashSub') : t('dm.bar.sub') }));
  if (demo && dmLiveSaved()) {
    bar.append(el('button', { type: 'button', className: 'lnk', textContent: t('dm.back'), onclick: dmBack }));
  }
}

// After sign-in: which kind of project this is, and whether the feedback button shows.
async function dmCheck() {
  try {
    const rows = await SB.select('am_setting', 'select=key,value&key=in.(app_mode,feedback_button,demo_cfg)');
    const v = k => (rows.find(r => r.key === k) || {}).value;
    DM.mode = v('app_mode') === 'demo' ? 'demo' : 'live';
    DM.fbOn = v('feedback_button') === true || v('feedback_button') === 'true';
    DM.cfg = (v('demo_cfg') && typeof v('demo_cfg') === 'object') ? v('demo_cfg') : {};
  } catch { DM.mode = 'live'; DM.fbOn = false; }   // 36 not run yet: a live project without feedback
  dmBar();
  dmFbButton();
}

function dmFbButton() {
  const b = $('#fbBtn');
  if (!b) return;
  b.hidden = !ME || !(DM.mode === 'demo' || DM.fbOn);
  b.textContent = t('dm.fb.btn');
  b.onclick = dmFbOpen;
}

/* ------------------------------------------------------------- switching */
function dmGo(cfg) {
  try {
    localStorage.setItem(LIVE_KEY, JSON.stringify({ cfg: { url: CFG.url, key: CFG.key }, sess: SESS }));
    localStorage.setItem(LS_KEY, JSON.stringify({ url: cfg.url, key: cfg.key, demo: true }));
    localStorage.removeItem(SESS_KEY);
  } catch (e) { return alert(e.message); }
  location.reload();
}

function dmBack() {
  const s = dmLiveSaved();
  try {
    if (s && s.cfg && s.cfg.url) {
      localStorage.setItem(LS_KEY, JSON.stringify({ url: s.cfg.url, key: s.cfg.key }));
      if (s.sess) localStorage.setItem(SESS_KEY, JSON.stringify(s.sess)); else localStorage.removeItem(SESS_KEY);
    } else {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(SESS_KEY);
    }
    localStorage.removeItem(LIVE_KEY);
  } catch (e) { return alert(e.message); }
  location.reload();
}

/* ------------------------------------------------------------ admin card */
async function dmCard() {
  const card = $('#adDemoCard'), box = $('#adDemoBox');
  if (!card) return;
  card.hidden = !can('system', 'view');
  if (card.hidden) return;
  if (DM.mode === null) await dmCheck();
  box.innerHTML = '';
  $('#adDemoMsg').innerHTML = '';
  const edit = can('system', 'edit');
  const demo = DM.mode === 'demo';
  box.append(el('div', { className: 'msg ' + (demo ? 'warn' : 'info'), textContent: demo ? t('dm.now.demo') : t('dm.now.live') }));

  if (!demo) {
    box.append(el('p', { className: 'adedit', innerHTML: t('dm.lead_html') }));
    const url = el('input', { type: 'password', value: DM.cfg.url || '', placeholder: 'https://xxxxxxxx.supabase.co', spellcheck: false, disabled: !edit });
    const key = el('input', { type: 'password', value: DM.cfg.key || '', placeholder: 'eyJhbGciOi…', spellcheck: false, disabled: !edit });
    const show = el('button', { type: 'button', className: 'btn', textContent: t('setup.show') });
    show.onclick = () => { const on = url.type === 'password'; url.type = key.type = on ? 'text' : 'password'; show.textContent = t(on ? 'setup.hide' : 'setup.show'); };
    const read = () => ({ url: url.value.trim().replace(/\/+$/, ''), key: key.value.trim() });
    const bad = c => !/^https:\/\/[^/]+$/.test(c.url) || !c.key ? t('dm.err.cfg')
      : c.url === CFG.url ? t('dm.err.same') : '';
    const save = el('button', { type: 'button', className: 'btn', textContent: t('dm.save'), disabled: !edit });
    save.onclick = async () => {
      const c = read(), e = bad(c);
      if (e) return msg('#adDemoMsg', 'err', e);
      try {
        await SB.patch('am_setting', 'key=eq.demo_cfg', { value: c, updated_at: new Date().toISOString() });
        DM.cfg = c;
        msg('#adDemoMsg', 'ok', t('dm.saved'));
      } catch (er) { msg('#adDemoMsg', 'err', er.message); }
    };
    const go = el('button', { type: 'button', className: 'btn pri', textContent: t('dm.go') });
    go.onclick = () => {
      const c = read(), e = bad(c);
      if (e) return msg('#adDemoMsg', 'err', e);
      if (confirm(t('dm.go.confirm'))) dmGo(c);
    };
    const link = el('button', { type: 'button', className: 'btn', textContent: t('dm.link') });
    link.onclick = () => {
      const c = read(), e = bad(c);
      if (e) return msg('#adDemoMsg', 'err', e);
      dmCopy(dmCfgLink(c), t('dm.linkCopied'));
    };
    box.append(
      el('div', { className: 'row', style: 'margin-top:10px;flex-wrap:wrap;align-items:flex-end' }, [
        el('div', { className: 'fld grow' }, [el('label', { textContent: t('dm.url') }), url]),
        el('div', { className: 'fld grow' }, [el('label', { textContent: t('dm.key') }), key]), show]),
      el('div', { className: 'row', style: 'margin-top:10px;flex-wrap:wrap' }, [save, go, link]));
    const fbSw = el('input', { type: 'checkbox', checked: DM.fbOn, disabled: !edit });
    fbSw.onchange = async () => {
      try {
        await SB.patch('am_setting', 'key=eq.feedback_button', { value: fbSw.checked, updated_at: new Date().toISOString() });
        DM.fbOn = fbSw.checked; dmFbButton();
        msg('#adDemoMsg', 'ok', t('dm.saved'));
      } catch (er) { fbSw.checked = !fbSw.checked; msg('#adDemoMsg', 'err', er.message); }
    };
    box.append(el('label', { className: 'chk', style: 'margin-top:12px' }, [fbSw, el('span', { textContent: t('dm.fbLive') })]));
  } else {
    box.append(el('p', { className: 'adedit', innerHTML: t('dm.leadDemo_html') }));
    const acts = el('div', { className: 'row', style: 'margin-top:10px;flex-wrap:wrap;align-items:flex-end' });
    if (dmLiveSaved()) acts.append(el('button', { type: 'button', className: 'btn pri', textContent: t('dm.back'), onclick: dmBack }));
    const pw = el('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: t('dm.pw.ph'), style: 'width:190px' });
    const inv = el('button', { type: 'button', className: 'btn', textContent: t('dm.invite') });
    inv.onclick = () => dmInvite(pw.value.trim());
    acts.append(el('div', { className: 'fld' }, [el('label', { textContent: t('dm.pw') }), pw]), inv);
    box.append(acts);
    if (can('override', 'admin')) {
      const word = el('input', { spellcheck: false, autocomplete: 'off', style: 'width:120px' });
      const reset = el('button', { type: 'button', className: 'btn danger', textContent: t('dm.reset'), disabled: true });
      word.oninput = () => { reset.disabled = word.value.trim().toUpperCase() !== 'DEMO'; };
      reset.onclick = () => dmReset(reset);
      box.append(el('h3', { textContent: t('dm.reset.h') }),
        el('p', { className: 'adedit', textContent: t('dm.reset.p') }),
        el('div', { className: 'row', style: 'flex-wrap:wrap;align-items:flex-end' }, [
          el('div', { className: 'fld' }, [el('label', { textContent: t('dm.reset.type') }), word]), reset]));
      // The sample project: every form filled, to look at (user 14/10/2026).
      const fin = el('button', { type: 'button', className: 'btn', textContent: t('dm.sample.btn') });
      fin.onclick = () => dmSample(fin);
      box.append(el('h3', { textContent: t('dm.sample.h') }), el('p', { className: 'adedit', textContent: t('dm.sample.p') }),
        el('div', { className: 'row', style: 'flex-wrap:wrap' }, [
          el('button', { type: 'button', className: 'btn pri', textContent: t('dm.sample.open'), onclick: () => { PM.prj.open = DM_SAMPLE; showView('projects'); } }), fin]));
    }
  }
  await dmFbList();
}

function dmCopy(text, okMsg) {
  navigator.clipboard?.writeText(text).catch(() => {});
  const out = msg('#adDemoMsg', 'ok', okMsg);
  out.append(el('textarea', { className: 'dminv', readOnly: true, value: text, rows: Math.min(18, text.split('\n').length + 1),
                              onfocus: e => e.target.select() }));
}

// The invitation: the link, what to expect, the demo accounts. The password is typed here, never stored.
async function dmInvite(pw) {
  if (!DM.people) {
    try {
      DM.people = await SB.select('app_user', 'select=email,full_name,active,app_user_role(role_code)&email=like.*%40plaza-demo.test&active=is.true&order=email');
    } catch { DM.people = []; }
  }
  // The demo administrator has its own password and is not handed to testers.
  const testers = DM.people.filter(p => !(p.app_user_role || []).some(r => r.role_code === 'SYS_ADMIN'));
  const lines = testers.map(p => `  • ${p.email} — ${p.full_name || ''}`
    + ((p.app_user_role || []).length ? ` (${p.app_user_role.map(r => r.role_code).join(', ')})` : ''));
  const text = t('dm.invite.text', { link: dmCfgLink(CFG), accounts: lines.join('\n') || '  —', pw: pw || t('dm.invite.pwAsk') });
  dmCopy(text, t('dm.inviteCopied'));
}

async function dmReset(btn) {
  if (!confirm(t('dm.reset.confirm'))) return;
  btn.disabled = true;
  msg('#adDemoMsg', 'info', t('dm.reset.running'));
  try {
    const r = await SB.rpc('am_demo_reset');
    const parts = r && typeof r === 'object' ? Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
    msg('#adDemoMsg', 'ok', t('dm.reset.done') + (parts ? ' ' + parts : ''));
    // The sample project was rebuilt with stand-in signatures and file paths only: finish it now.
    if (r && r.sample_project === DM_SAMPLE) await dmSample(null, t('dm.reset.done') + ' ');
  } catch (e) {
    msg('#adDemoMsg', 'err', /am_demo_reset|PGRST202|404/.test(e.message) ? t('dm.reset.missing') : e.message);
  } finally { btn.disabled = false; }
}

/* ---------------------------------------------------------- sample project
   The sample project (am_demo_sample, DEMO_SETUP.sql 3b — user 14/10/2026) goes through every step on
   the server with a stand-in signature and file paths only. This finishes it in the browser: each demo
   person's signature, drawn in a handwriting style, goes into the boxes they signed; every attachment it
   refers to gets a sample scan (PDF) or photo, so the forms, the document viewer and the photos look like
   the real thing. Runs by itself after "Refresh demo data"; the button is for a demo built from the SQL Editor. */
const DM_SAMPLE = 'FFE.KIT.07.2026';
async function dmSample(btn, lead = '') {
  if (btn) btn.disabled = true;
  const out = '#adDemoMsg';
  msg(out, 'info', lead + t('dm.sample.running'));
  try {
    const people = await SB.select('app_user', 'select=email,full_name&email=like.*%40plaza-demo.test');
    const sigs = Object.fromEntries(people.map(p => [p.email, dmSigPng(p.full_name || p.email)]));
    const s = await SB.rpc('am_demo_sample_finish', { p_sigs: sigs });
    const files = (await SB.rpc('am_demo_sample_files')) || [];
    let n = 0, bad = 0;
    for (const f of files) {
      msg(out, 'info', lead + t('dm.sample.files', { n: n + bad + 1, of: files.length }));
      try { await dmPut(f.bucket, f.path, await dmSampleFile(f)); n++; } catch (e) { bad++; console.warn('sample file', f.path, e); }
    }
    msg(out, bad ? 'warn' : 'ok', lead + t('dm.sample.done', { s: (s && s.signatures) || 0, n, bad }));
  } catch (e) {
    msg(out, 'err', /am_demo_sample|PGRST202/.test(e.message) ? t('dm.sample.missing') : e.message);
  } finally { if (btn) btn.disabled = false; }
}

// A signature in a handwriting style: the given name and an initial, a flourish under it.
function dmSigPng(fullName) {
  const base = String(fullName).replace(/\s*\(.*$/, '').trim(), w = base.split(/\s+/);
  const latin = w.length === 2 && !/[À-ỹĐđ]/.test(base);
  const txt = latin ? `${w[0][0]}. ${w[1]}` : `${w[w.length - 1]} ${w[0][0]}.`;
  let seed = [...base].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 233280, 7);
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const c = el('canvas', { width: 220, height: 70 }), g = c.getContext('2d');
  g.strokeStyle = g.fillStyle = '#1d3a8a'; g.lineWidth = 1.8; g.lineCap = 'round';
  g.font = 'italic 30px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
  g.save(); g.translate(12 + rnd() * 6, 44); g.rotate(-0.04 - rnd() * 0.05); g.fillText(txt, 0, 0); g.restore();
  const tw = Math.min(195, g.measureText(txt).width);
  g.beginPath(); g.moveTo(8 + rnd() * 10, 56); g.bezierCurveTo(60, 64 + rnd() * 5, 110 + rnd() * 30, 44, 16 + tw, 50 + rnd() * 8); g.stroke();
  return c.toDataURL('image/png');
}

async function dmPut(bucket, path, blob) {
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/${bucket}/${String(path).split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok, 'Content-Type': blob.type }, body: blob });
  if (!r.ok && r.status !== 409) throw new Error(r.status + ' ' + (await r.text()).slice(0, 120));
}

const dmBlob = (c, type, q) => new Promise(ok => c.toBlob(ok, type, q));
async function dmSampleFile(f) {
  if (String(f.kind).startsWith('photo-')) return dmBlob(dmPhoto(f), 'image/jpeg', 0.8);
  // A scan: the page drawn on a canvas (any language shows), placed on an A4 PDF page.
  const jpg = await dmBlob(dmScan(f), 'image/jpeg', 0.72);
  const L = await dvLib(), doc = await L.PDFDocument.create();
  const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
  doc.addPage([595.28, 841.89]).drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

const DM_TITLES = {
  quotation: 'BÁO GIÁ / QUOTATION', vendor_letter: 'THƯ ĐỀ NGHỊ THANH TOÁN / PAYMENT REQUEST', invoice: 'HOÁ ĐƠN GIÁ TRỊ GIA TĂNG / VAT INVOICE',
  contract: 'HỢP ĐỒNG MUA BÁN / SALES CONTRACT', other: 'BIÊN BẢN NGHIỆM THU / ACCEPTANCE MINUTES', minutes: 'BIÊN BẢN HỌP HỘI ĐỒNG THANH LÝ (02)',
  decision: 'QUYẾT ĐỊNH THANH LÝ TÀI SẢN (03)', sitecheck: 'BIÊN BẢN KIỂM TRA HIỆN TRƯỜNG (04)', reval: 'BIÊN BẢN ĐÁNH GIÁ LẠI (05)',
  award: 'KẾT QUẢ BÁN THANH LÝ (06)', handover: 'BIÊN BẢN GIAO NHẬN / HANDOVER MINUTES', gatepass: 'GATE PASS — PHIẾU RA CỔNG' };
// One scanned page: letterhead, title, faint text lines, a small table, signatures and a red stamp.
function dmScan(f) {
  const W = 1240, H = 1754, c = el('canvas', { width: W, height: H }), g = c.getContext('2d');
  let seed = [...String(f.path)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 233280, 11);
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  g.fillStyle = '#fbfaf5'; g.fillRect(0, 0, W, H);
  g.save(); g.translate(W / 2, H / 2); g.rotate((rnd() - 0.5) * 0.008); g.translate(-W / 2, -H / 2);
  g.fillStyle = '#222'; g.font = 'bold 30px Arial'; g.fillText(f.label || 'PLAZA HOTEL', 110, 150);
  g.font = '22px Arial'; g.fillStyle = '#555'; g.fillText('Số / No: ' + String(f.path).split('/').pop().replace(/\.\w+$/, '').toUpperCase(), 110, 190);
  g.strokeStyle = '#444'; g.lineWidth = 2; g.beginPath(); g.moveTo(110, 215); g.lineTo(W - 110, 215); g.stroke();
  g.textAlign = 'center'; g.fillStyle = '#111'; g.font = 'bold 38px Arial'; g.fillText(DM_TITLES[f.kind] || DM_TITLES.other, W / 2, 300);
  g.font = 'italic 24px Arial'; g.fillStyle = '#444'; g.fillText(f.name || '', W / 2, 345); g.textAlign = 'left';
  g.fillStyle = '#c9c6bd';
  for (let i = 0; i < 9; i++) g.fillRect(110, 410 + i * 42, (W - 220) * (0.55 + rnd() * 0.45), 12);
  const ty = 810, cols = [110, 200, 640, 800, 960, W - 110];
  g.strokeStyle = '#777'; g.lineWidth = 1.5;
  for (let r = 0; r <= 5; r++) { g.beginPath(); g.moveTo(cols[0], ty + r * 50); g.lineTo(cols[5], ty + r * 50); g.stroke(); }
  for (const x of cols) { g.beginPath(); g.moveTo(x, ty); g.lineTo(x, ty + 250); g.stroke(); }
  g.fillStyle = '#bdb9ae';
  for (let r = 0; r < 5; r++) for (let k = 0; k < 5; k++) g.fillRect(cols[k] + 14, ty + r * 50 + 20, (cols[k + 1] - cols[k] - 28) * (0.4 + rnd() * 0.5), 10);
  g.fillStyle = '#c9c6bd';
  for (let i = 0; i < 4; i++) g.fillRect(110, 1110 + i * 42, (W - 220) * (0.5 + rnd() * 0.5), 12);
  g.fillStyle = '#222'; g.font = 'bold 24px Arial';
  g.fillText('ĐẠI DIỆN BÊN A', 170, 1360); g.fillText('ĐẠI DIỆN BÊN B', 790, 1360);
  g.strokeStyle = '#1d3a8a'; g.lineWidth = 3;
  for (const x0 of [190, 810]) { g.beginPath(); g.moveTo(x0, 1470); for (let i = 1; i < 9; i++) g.lineTo(x0 + i * 26, 1450 + (rnd() - 0.5) * 50); g.stroke(); }
  // Red company stamp, half over the right-hand signature.
  const sx = 900, sy = 1450;
  g.strokeStyle = 'rgba(200,30,30,.78)'; g.fillStyle = 'rgba(200,30,30,.78)';
  g.lineWidth = 6; g.beginPath(); g.arc(sx, sy, 105, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.arc(sx, sy, 72, 0, Math.PI * 2); g.stroke();
  g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.fillText('★', sx, sy - 18); g.font = 'bold 22px Arial'; g.fillText('[DEMO]', sx, sy + 14);
  g.font = 'bold 15px Arial'; g.fillText('CÔNG TY', sx, sy + 40); g.textAlign = 'left';
  g.restore();
  // "Sample document" across the page, faint.
  g.save(); g.translate(W / 2, H / 2); g.rotate(-0.6); g.textAlign = 'center'; g.font = 'bold 92px Arial'; g.fillStyle = 'rgba(200,40,40,.10)';
  g.fillText('TÀI LIỆU MẪU — DEMO', 0, 0); g.restore();
  return c;
}

// A sample photo: the label close up, the whole asset, or its worn condition (for the liquidation request).
function dmPhoto(f) {
  const W = 1200, H = 900, c = el('canvas', { width: W, height: H }), g = c.getContext('2d');
  const what = String(f.label || ''), code = String(f.name || '');
  let seed = [...code + f.kind].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 233280, 5);
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const steel = (x, y, w, h) => { const gr = g.createLinearGradient(x, y, x + w, y); gr.addColorStop(0, '#9aa3ab'); gr.addColorStop(0.5, '#e4e8eb'); gr.addColorStop(1, '#8c959d'); g.fillStyle = gr; g.fillRect(x, y, w, h); };
  if (f.kind === 'photo-label') {
    steel(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,.08)'; for (let i = 0; i < 30; i++) g.fillRect(0, i * 31, W, 2);
    g.save(); g.translate(W / 2, H / 2); g.rotate(-0.03); g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(-372, -182, 760, 380); g.fillStyle = '#fff'; g.fillRect(-380, -190, 760, 380);
    g.fillStyle = '#0b1f3a'; g.font = 'bold 34px Arial'; g.fillText('PLAZA HOTEL — ASSET', -340, -130);
    g.font = 'bold 40px Consolas, monospace'; g.fillText(code, -340, -70);
    for (let i = 0, x = -340; x < 340; i++) { const w = 2 + Math.floor(rnd() * 6); if (i % 2 === 0) g.fillRect(x, -30, w, 150); x += w + 2; }
    g.font = '26px Arial'; g.fillText(what.split(' · ')[0], -340, 160); g.restore();
  } else {
    // Kitchen: tiles, floor, then the asset.
    g.fillStyle = '#e9ecef'; g.fillRect(0, 0, W, H * 0.72);
    g.strokeStyle = '#d3d8dd'; g.lineWidth = 2;
    for (let x = 0; x < W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H * 0.72); g.stroke(); }
    for (let y = 0; y < H * 0.72; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.fillStyle = '#7d858c'; g.fillRect(0, H * 0.72, W, H * 0.28);
    if (/Chảo|Pan/i.test(what)) {
      steel(150, 470, 900, 30);
      for (let i = 0; i < 6; i++) { const x = 230 + i * 140; g.fillStyle = '#2b2f33'; g.beginPath(); g.ellipse(x, 430, 62, 26, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = '#4a5056'; g.fillRect(x + 55, 424, 70, 10); }
    } else if (/Tủ lạnh|Refrigerator/i.test(what)) {
      steel(420, 110, 360, 560); g.strokeStyle = '#6c757d'; g.lineWidth = 4; g.strokeRect(420, 110, 360, 560); g.beginPath(); g.moveTo(600, 110); g.lineTo(600, 670); g.stroke();
      g.fillStyle = '#495057'; g.fillRect(580, 300, 8, 150); g.fillRect(612, 300, 8, 150);
    } else {
      steel(170, 330, 860, 340); g.strokeStyle = '#6c757d'; g.lineWidth = 4; g.strokeRect(170, 330, 860, 340);
      g.fillStyle = '#ced4da'; g.fillRect(150, 300, 900, 34);
      for (const x of [200, 610]) { g.strokeRect(x, 370, 390, 270); g.fillStyle = '#495057'; g.fillRect(x + 20, 390, 120, 10); }
      g.fillStyle = '#222'; g.fillRect(960, 350, 50, 24); g.fillStyle = '#4caf50'; g.font = 'bold 18px Consolas, monospace'; g.fillText('3°C', 963, 368);
    }
    if (f.kind === 'photo-condition') {
      for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(${120 + rnd() * 60},${60 + rnd() * 30},20,${0.35 + rnd() * 0.3})`; g.beginPath(); g.ellipse(200 + rnd() * 800, 340 + rnd() * 320, 8 + rnd() * 30, 5 + rnd() * 18, rnd() * 3, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = 'rgba(40,30,20,.18)'; g.fillRect(0, 0, W, H);
    } else {
      g.fillStyle = '#fff'; g.fillRect(890, 560, 120, 46); g.fillStyle = '#0b1f3a'; g.font = 'bold 13px Consolas, monospace'; g.fillText(code.slice(0, 15), 896, 590);
    }
  }
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, H - 54, W, 54);
  g.fillStyle = '#fff'; g.font = '24px Arial'; g.fillText(`ẢNH MẪU — DEMO · ${what}`, 20, H - 18);
  return c;
}

/* -------------------------------------------------------------- feedback */
function dmFbOpen() {
  const old = $('#fbModal');
  if (old) old.remove();
  let kind = 'idea';
  const seg = el('div', { className: 'seg dmkinds' }, DM_KINDS.map(k => {
    const b = el('button', { type: 'button', textContent: t('dm.k.' + k), className: k === kind ? 'on' : '' });
    b.dataset.k = k;
    b.onclick = () => { kind = k; seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.k === k)); };
    return b;
  }));
  const where = ($('#pageTitle') && $('#pageTitle').textContent) || VIEW;
  const txt = el('textarea', { rows: 6, maxLength: 4000, placeholder: t('dm.fb.ph') });
  const out = el('div');
  const close = () => modal.remove();
  const send = el('button', { type: 'button', className: 'btn pri', textContent: t('dm.fb.send') });
  send.onclick = async () => {
    const s = txt.value.trim();
    if (!s) { txt.focus(); return msg(out, 'err', t('dm.fb.empty')); }
    send.disabled = true;
    try {
      await SB.insert('app_feedback', [{ kind, text: s, view: `${VIEW} — ${where}`.slice(0, 200), app_version: APP_VERSION,
                                         lang: LANG, email: (ME && ME.email) || null }]);
      msg(out, 'ok', t('dm.fb.thanks'));
      setTimeout(close, 1200);
    } catch (e) {
      send.disabled = false;
      msg(out, 'err', /app_feedback|PGRST20[25]|404/.test(e.message) ? t('dm.fb.missing') : e.message);
    }
  };
  const modal = el('div', { className: 'login sigmodal', id: 'fbModal' }, el('div', { className: 'sigbox dmfb' }, [
    el('h2', { textContent: t('dm.fb.h') }),
    el('p', { className: 'siglead', textContent: t('dm.fb.lead', { where }) }),
    seg, txt, out,
    el('div', { className: 'row', style: 'justify-content:flex-end;margin-top:10px' }, [
      el('button', { type: 'button', className: 'btn', textContent: t('auth.cancel'), onclick: close }), send])]));
  modal.onclick = e => { if (e.target === modal) close(); };
  document.body.append(modal);
  txt.focus();
}

async function dmFbList() {
  const box = $('#adFbBox');
  if (!box) return;
  box.innerHTML = '';
  const edit = can('system', 'edit');
  try {
    DM.fb = await SB.select('app_feedback', 'select=*&order=created_at.desc&limit=1000');
  } catch (e) {
    return msg(box, 'info', /app_feedback|PGRST20[25]|404/.test(e.message) ? t('dm.fb.missing') : e.message);
  }
  const open = r => !['done', 'wontfix'].includes(r.status);
  const rows = DM.fb.filter(r => DM.fbFilter === 'all' || (DM.fbFilter === 'open' ? open(r) : r.kind === DM.fbFilter));
  const filt = el('select', {}, ['open', 'all', ...DM_KINDS].map(k => el('option', { value: k, textContent: t('dm.f.' + k), selected: k === DM.fbFilter })));
  filt.onchange = () => { DM.fbFilter = filt.value; dmFbList(); };
  const xls = el('button', { type: 'button', className: 'btn', textContent: t('dm.fb.xls'), disabled: !DM.fb.length, onclick: dmFbXls });
  const cnt = k => DM.fb.filter(r => r.kind === k).length;
  box.append(el('div', { className: 'row', style: 'align-items:center;flex-wrap:wrap;gap:10px' }, [
    el('h3', { style: 'margin:0', textContent: t('dm.fb.list') }),
    el('span', { className: 'dim', textContent: t('dm.fb.counts', { n: DM.fb.length, open: DM.fb.filter(open).length,
      bug: cnt('bug'), idea: cnt('idea'), question: cnt('question'), praise: cnt('praise') }) }),
    el('span', { style: 'flex:1' }), filt, xls]));
  if (!rows.length) return box.append(el('div', { className: 'msg info', style: 'margin-top:8px', textContent: t('dm.fb.none') }));
  const tb = el('table', { className: 'adtbl dmfbt' });
  tb.append(el('tr', {}, ['dm.c.when', 'dm.c.who', 'dm.c.kind', 'dm.c.view', 'dm.c.text', 'dm.c.status', 'dm.c.reply']
    .map(k => el('th', { textContent: t(k) }))));
  for (const r of rows) {
    const st = el('select', { disabled: !edit }, DM_STATUS.map(s => el('option', { value: s, textContent: t('dm.s.' + s), selected: s === r.status })));
    const rp = el('input', { value: r.reply || '', disabled: !edit, placeholder: t('dm.c.replyPh') });
    const save = async () => {
      if (st.value === r.status && rp.value.trim() === (r.reply || '')) return;
      try {
        const [n] = await SB.patch('app_feedback', `id=eq.${r.id}`, { status: st.value, reply: rp.value.trim() || null,
          handled_by: (ME && (ME.full_name || ME.email)) || null, handled_at: new Date().toISOString() });
        Object.assign(r, n || { status: st.value, reply: rp.value.trim() || null });
        st.closest('tr').className = 'st-' + r.status;
      } catch (e) { msg('#adDemoMsg', 'err', e.message); }
    };
    st.onchange = save; rp.onchange = save;
    tb.append(el('tr', { className: 'st-' + r.status }, [
      el('td', { className: 'nowrap', textContent: fmtDateTime(r.created_at) }),
      el('td', { textContent: r.email || '' }),
      el('td', {}, el('span', { className: 'dmk k-' + r.kind, textContent: t('dm.k.' + r.kind) })),
      el('td', { className: 'dim', textContent: r.view || '' }),
      el('td', { className: 'dmtxt', textContent: r.text }),
      el('td', {}, st),
      el('td', {}, [rp, r.handled_by ? el('small', { className: 'dim', textContent: `${r.handled_by} · ${fmtDateTime(r.handled_at)}` }) : ''])]));
  }
  box.append(el('div', { className: 'wrap', style: 'margin-top:8px' }, tb));
}

function dmFbXls() {
  const rows = DM.fb.map(r => ({ [t('dm.c.when')]: fmtDateTime(r.created_at), [t('dm.c.who')]: r.email || '',
    [t('dm.c.kind')]: t('dm.k.' + r.kind), [t('dm.c.view')]: r.view || '', [t('dm.c.text')]: r.text,
    [t('dm.c.status')]: t('dm.s.' + r.status), [t('dm.c.reply')]: r.reply || '', [t('dm.c.by')]: r.handled_by || '',
    [t('dm.c.ver')]: r.app_version || '', Lang: r.lang || '' }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [16, 28, 10, 28, 70, 12, 40, 20, 12, 5].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Feedback');
  XLSX.writeFile(wb, `${DM.mode === 'demo' ? 'Demo' : 'Live'} feedback ${new Date().toISOString().slice(0, 10)}.xlsx`);
}
