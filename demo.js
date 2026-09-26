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
  const lines = DM.people.map(p => `  • ${p.email} — ${p.full_name || ''}`
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
  } catch (e) {
    msg('#adDemoMsg', 'err', /am_demo_reset|PGRST202|404/.test(e.message) ? t('dm.reset.missing') : e.message);
  } finally { btn.disabled = false; }
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
