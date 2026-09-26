/* ============================================================ PROJECT MEETINGS
   (33_meetings.sql) — the bi-weekly Owner / Operator meeting on the Capex
   projects, recorded BY PROJECT across meetings so anyone can look back at what
   was discussed, what was decided and who has to do what. Replaces the
   "Meeting Recap - CAPEX Tracker" workbook (user 26/09/2026).

     meetings  the meetings, newest first; one meeting = its attendees and, per
               topic, progress · discussion · decision / direction · notes, and
               the action items. A draft meeting lists every OPEN topic with
               what was said last time and the actions still open, so the
               agenda writes itself. Issue → bell notice to the attendees and
               the people in charge; bilingual PDF minutes; e-mail.
     topics    one line per project / topic; open one for its whole history.
               The search box looks through every discussion and decision.
     actions   the action tracker: open / done / dropped / historical, by
               person in charge, overdue first. The person in charge ticks
               their own actions (also listed in their To-do list).
     import    the old workbook (VIE + ENG sheets, one per snapshot).

   Bilingual (user decision): type in ONE language; "Translate with Claude"
   copies a prompt, the JSON answer pasted back fills the other language. No
   Claude API. Rights: everyone reads (meeting.view); the AM team writes
   (meeting.create / edit). Loaded after app.js and assetops.js; uses their
   helpers (el, msg, t, can, SB, lqbHead / lqbBi / lqbSigns, aoCapture). */

const MT = { tab: 'meetings', meetings: [], topics: [], entries: [], actions: [], people: null, projects: null,
             open: null, topic: null, edit: null, q: '', tq: '', tstat: 'open',
             af: { status: 'open', pic: '', q: '', late: false }, flash: null, parsed: null };
const MT_FIELDS = ['stage', 'progress', 'discussion', 'decision', 'note'];
const MT_SIDES = ['owner', 'operator', 'other'];
const mtW = () => can('meeting', 'create');
const mtEd = () => can('meeting', 'edit');
const mtAdm = () => can('meeting', 'admin');
const mtMissing = e => /pm_mt_|mt_[a-z_]+|PGRST20[25]|does not exist|404/.test(String(e && e.message));
const mtErr = (out, e) => msg(out, 'err', mtMissing(e) ? t('mt.notInstalled') : e.message);
const mtOther = () => (LANG === 'vi' ? 'en' : 'vi');
// Typing in either language: a text is filed under the language it is written in (Vietnamese letters → vi, else en).
const mtLangOf = s => (mtViText(s) ? 'vi' : 'en');
// The slot a field is edited from: the reading language's text if there is one, else the other.
const mtSrcLang = (o, base) => (o[`${base}_${LANG}`] ? LANG : o[`${base}_${mtOther()}`] ? mtOther() : LANG);
// An edited text back into its slot; emptied → the slot it came from is emptied.
const mtPut = (p, base, from, v) => { if (!v) p[`${base}_${from}`] = null; else p[`${base}_${mtLangOf(v)}`] = v; };
// A bilingual column in the reading language, else the other one (marked as not translated yet).
const mtVal = (o, base) => { const a = o && o[`${base}_${LANG}`], b = o && o[`${base}_${mtOther()}`];
  return a ? [a, false] : b ? [b, true] : ['', false]; };
const mtText = (o, base, cls = '') => { const [v, fb] = mtVal(o, base);
  return el('div', { className: 'mttext ' + cls + (fb ? ' fb' : ''), textContent: v, title: fb ? t('mt.notTranslated') : '' }); };
const mtTopic = id => MT.topics.find(x => x.id === id) || {};
const mtMeeting = id => MT.meetings.find(x => x.id === id) || {};
const mtTopicName = tp => mtVal(tp, 'title')[0] || '—';
const mtChip = (cls, text) => el('span', { className: 'mtst ' + cls, textContent: text });
const mtStChip = m => mtChip(m.status === 'issued' ? 's-issued' : 's-draft', t('mt.st.' + m.status));
const mtLate = a => a.status === 'open' && a.due_date && a.due_date < aoToday();
const mtActChip = a => mtChip('a-' + (mtLate(a) ? 'late' : a.status), mtLate(a) ? t('mt.a.late') : t('mt.a.' + a.status));
const mtCanSet = a => a.status !== 'historical' && (mtW() || (ME && a.pic_user === ME.id));
const mtDue = a => a.due_date ? fmtDate(a.due_date) : a.due_text || '';

async function mtLoad() {
  const out = $('#mtMsg');
  msg(out, 'info', t('table.loading'));
  try {
    const [meetings, topics, entries, actions] = await Promise.all([
      SB.select('pm_mt_meeting', 'select=*&order=meeting_date.desc,id.desc'),
      SB.select('pm_mt_topic', 'select=*&order=sort,id'),
      SB.select('pm_mt_entry', 'select=*&order=sort,id&limit=20000'),
      SB.select('pm_mt_action', 'select=*&order=sort,id&limit=20000')]);
    Object.assign(MT, { meetings, topics, entries, actions });
    if (MT.pendingNo) { const m = meetings.find(x => x.no === MT.pendingNo); if (m) { MT.tab = 'meetings'; MT.open = m.id; } MT.pendingNo = null; }
    if (!MT.projects) MT.projects = await SB.select('pm_project', 'select=code,name,year&order=code').catch(() => []);
    if (mtW() && !MT.people) MT.people = await SB.rpc('mt_people').catch(() => []);
    msg(out, MT.flash ? 'ok' : '', MT.flash || ''); MT.flash = null;
    mtRender();
  } catch (e) { $('#mtBody').innerHTML = ''; mtErr(out, e); }
}
// Reload after a change, keeping the screen; a message to show once it is back.
async function mtReload(flash) { MT.flash = flash || null; await mtLoad(); }

function mtRender() {
  const tabs = $('#mtTabs'), body = $('#mtBody');
  if (!tabs) return;
  const mine = MT.actions.filter(a => a.status === 'open' && ME && a.pic_user === ME.id).length;
  const open = MT.actions.filter(a => a.status === 'open').length;
  const list = [['meetings', t('mt.t.meetings')], ['topics', t('mt.t.topics')], ['actions', t('mt.t.actions', { n: open }) + (mine ? ' · ' + t('mt.t.mine', { n: mine }) : '')]];
  if (mtAdm()) list.push(['import', t('mt.t.import')]);
  if (!list.some(x => x[0] === MT.tab)) MT.tab = 'meetings';
  tabs.innerHTML = '';
  for (const [v, label] of list) {
    const b = el('button', { type: 'button', textContent: label });
    b.classList.toggle('on', MT.tab === v);
    b.onclick = () => { MT.tab = v; MT.open = null; MT.topic = null; MT.edit = null; mtRender(); };
    tabs.append(b);
  }
  body.innerHTML = '';
  if (MT.tab === 'meetings') return MT.open ? mtMeetingView(body, mtMeeting(MT.open)) : mtMeetingList(body);
  if (MT.tab === 'topics') return MT.topic ? mtTopicView(body, mtTopic(MT.topic)) : mtTopicList(body);
  if (MT.tab === 'actions') return mtActionsTab(body);
  if (MT.tab === 'import') return mtImportTab(body);
}

/* ------------------------------------------------------------ meetings list */
function mtMeetingList(body) {
  const card = el('div', { className: 'card' });
  const head = el('div', { className: 'chead' }, [el('h2', { textContent: t('mt.listH', { n: MT.meetings.length }) })]);
  if (mtW()) head.append(el('div', { className: 'row' }, el('button', { className: 'btn pri', type: 'button', textContent: '+ ' + t('mt.new'), onclick: mtNew })));
  card.append(head);
  if (!MT.meetings.length) { card.append(el('div', { className: 'dim', textContent: t('mt.noneYet') })); body.append(card); return; }
  const tb = el('table', { className: 'lqbt' });
  tb.append(el('tr', {}, [['mt.c.no'], ['mt.c.date'], ['mt.c.title'], ['mt.c.topics', 'num'], ['mt.c.actions', 'num'], ['mt.c.status']]
    .map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
  for (const m of MT.meetings) {
    const ents = MT.entries.filter(e => e.meeting_id === m.id), acts = MT.actions.filter(a => a.meeting_id === m.id);
    const tr = el('tr', { className: 'aoclick' }, [el('td', {}, el('code', { textContent: m.no })), el('td', { textContent: fmtDate(m.meeting_date) }),
      el('td', { className: 'aowrap', textContent: mtVal(m, 'title')[0] || t('mt.defTitle') }),
      el('td', { className: 'num', textContent: fmtInt(new Set(ents.map(e => e.topic_id)).size) }),
      el('td', { className: 'num', textContent: acts.length ? `${fmtInt(acts.filter(a => a.status === 'open').length)} / ${fmtInt(acts.length)}` : '' }),
      el('td', {}, mtStChip(m))]);
    tr.onclick = () => { MT.open = m.id; MT.edit = null; mtRender(); };
    tb.append(tr);
  }
  card.append(el('div', { className: 'wrap' }, tb));
  body.append(card);
}

async function mtNew() {
  // The same attendees as last time, so a regular meeting needs no typing.
  const last = MT.meetings.find(m => m.source === 'app') || null;
  try {
    const id = await SB.rpc('mt_save_meeting', { p: { meeting_date: aoToday(), title_vi: 'Họp định kỳ dự án Capex', title_en: 'Capex projects progress meeting',
      place: last ? last.place : '', attendees: last ? last.attendees : [] } });
    MT.open = id; MT.edit = 'head';
    await mtReload(t(last ? 'mt.created' : 'mt.createdNew'));
  } catch (e) { mtErr('#mtMsg', e); }
}

/* ------------------------------------------------------------ one meeting */
// The topics a meeting shows: those it wrote about, and — while a draft — every open topic (the agenda).
function mtAgenda(m) {
  const used = new Set([...MT.entries.filter(e => e.meeting_id === m.id).map(e => e.topic_id), ...MT.actions.filter(a => a.meeting_id === m.id).map(a => a.topic_id)]);
  const added = MT.shown && MT.shown.mid === m.id ? MT.shown.ids : new Set();
  return MT.topics.filter(tp => used.has(tp.id) || added.has(tp.id) || (m.status === 'draft' && tp.status === 'open'));
}
// A topic brought into the meeting by hand (a closed one, or into an issued meeting) stays on it while it is open.
const mtShow = (m, id) => { if (!MT.shown || MT.shown.mid !== m.id) MT.shown = { mid: m.id, ids: new Set() }; MT.shown.ids.add(id); };
// Open actions from earlier meetings, carried forward on this topic.
const mtCarried = (m, topicId) => MT.actions.filter(a => a.topic_id === topicId && a.status === 'open' && a.meeting_id !== m.id
  && (mtMeeting(a.meeting_id).meeting_date || '') <= m.meeting_date);
// What was said on the topic at the meeting before.
function mtLastTime(m, topicId) {
  const prev = MT.entries.filter(e => e.topic_id === topicId && e.meeting_id !== m.id && (mtMeeting(e.meeting_id).meeting_date || '') < m.meeting_date);
  if (!prev.length) return null;
  const d = prev.map(e => mtMeeting(e.meeting_id).meeting_date).sort().pop();
  return { date: d, entries: prev.filter(e => mtMeeting(e.meeting_id).meeting_date === d) };
}

function mtMeetingView(body, m) {
  if (!m.id) { MT.open = null; return mtMeetingList(body); }
  const out = el('div');
  const acts = [el('button', { className: 'btn', type: 'button', textContent: '← ' + t('mt.back'), onclick: () => { MT.open = null; MT.edit = null; mtRender(); } })];
  if (mtW()) acts.push(el('button', { className: 'btn', type: 'button', textContent: '✎ ' + t('mt.editHead'), onclick: () => { MT.edit = MT.edit === 'head' ? null : 'head'; mtRender(); } }),
                      el('button', { className: 'btn', type: 'button', textContent: '🌐 ' + t('mt.translate'), onclick: () => mtTranslate(card, m) }));
  acts.push(...aoPdfBtns(() => mtMinutes(m), () => `${m.no} ${t('mt.pdfName')}`, out),
            el('button', { className: 'btn tiny', type: 'button', textContent: '✉ ' + t('mt.email'), onclick: () => mtEmail(m, out) }));
  if (mtEd() && m.status === 'draft') acts.push(el('button', { className: 'btn pri', type: 'button', textContent: '📣 ' + t('mt.issue'), onclick: () => mtIssue(m, out) }));
  if (mtAdm() && m.status === 'issued') acts.push(el('button', { className: 'btn tiny', type: 'button', textContent: t('mt.unissue'), onclick: async () => {
    try { await SB.rpc('mt_unissue', { p_id: m.id }); await mtReload(t('mt.unissued')); } catch (e) { mtErr(out, e); } } }));
  if ((mtEd() && m.status === 'draft') || mtAdm()) acts.push(el('button', { className: 'btn danger tiny', type: 'button', textContent: t('mt.delete'), onclick: async () => {
    if (!confirm(t('mt.deleteQ', { no: m.no }))) return;
    try { await SB.rpc('mt_delete_meeting', { p_id: m.id }); MT.open = null; await mtReload(t('mt.deleted', { no: m.no })); } catch (e) { mtErr(out, e); } } }));
  const card = el('div', { className: 'card' }, [
    el('div', { className: 'chead' }, [el('h2', {}, [document.createTextNode(`${m.no} · ${fmtDate(m.meeting_date)} `), mtStChip(m)])]),
    el('div', { className: 'row mtacts' }, acts), out]);
  if (MT.edit === 'head' && mtW()) card.append(mtHeadForm(m));
  else card.append(mtHeadView(m));
  body.append(card);
  const agenda = mtAgenda(m);
  if (!agenda.length) body.append(el('div', { className: 'card dim', textContent: t('mt.noTopics') }));
  for (const tp of agenda) body.append(mtTopicCard(m, tp));
  if (mtW()) body.append(mtAddTopic(m));
}

function mtHeadView(m) {
  const dl = el('dl', { className: 'aodl' });
  const add = (k, v) => { if (v) dl.append(el('dt', { textContent: t(k) }), el('dd', {}, v)); };
  add('mt.f.title', mtVal(m, 'title')[0] || t('mt.defTitle'));
  add('mt.f.place', m.place);
  for (const s of MT_SIDES) {
    const who = (m.attendees || []).filter(a => (a.side || 'other') === s);
    if (who.length) add('mt.side.' + s, who.map(a => a.name + (a.position ? ` (${a.position})` : '')).join(' · '));
  }
  if (m.file_url) add('mt.f.file', el('a', { href: m.file_url, target: '_blank', rel: 'noopener', textContent: t('mt.openFile') }));
  if (m.status === 'issued') add('mt.f.issued', `${m.issued_name || ''} · ${fmtDateTime(m.issued_at)}`);
  if (m.source === 'import') add('mt.f.source', t('mt.fromImport'));
  return dl;
}

// The people list: app users first, free names allowed.
function mtPeopleList() {
  let dl = document.getElementById('mtPeople');
  if (!dl) { dl = el('datalist', { id: 'mtPeople' }); document.body.append(dl); }
  dl.innerHTML = '';
  const names = new Set([...(MT.people || []).map(p => p.name), ...MT.actions.map(a => a.pic_name).filter(Boolean),
    ...MT.meetings.flatMap(m => (m.attendees || []).map(a => a.name))]);
  for (const n of [...names].filter(Boolean).sort()) dl.append(el('option', { value: n }));
  return 'mtPeople';
}
const mtUserByName = n => (MT.people || []).find(p => p.name.toLowerCase() === String(n || '').trim().toLowerCase()) || null;

function mtHeadForm(m) {
  const lk = mtSrcLang(m, 'title');
  const date = el('input', { type: 'date', value: m.meeting_date || '' }), place = el('input', { value: m.place || '' });
  const title = el('input', { value: m[`title_${lk}`] || '' }), file = el('input', { value: m.file_url || '', placeholder: 'https://…' });
  const rows = el('div', { className: 'mtatt' }), list = mtPeopleList();
  const addRow = a => {
    const side = el('select'); selFill(side, MT_SIDES.map(s => [s, t('mt.side.' + s)])); side.value = a.side || 'owner';
    const name = el('input', { value: a.name || '', placeholder: t('mt.f.namePh') }); name.setAttribute('list', list);
    const pos = el('input', { value: a.position || '', placeholder: t('mt.f.position') });
    const x = el('button', { className: 'xbtn', type: 'button', textContent: '✕', onclick: () => r.remove() });
    const r = el('div', { className: 'mtattrow' }, [side, name, pos, x]);
    rows.append(r);
  };
  for (const a of m.attendees || []) addRow(a);
  if (!(m.attendees || []).length) addRow({ side: 'owner' });
  const out = el('div');
  const save = async () => {
    const attendees = [...rows.children].map(r => { const [s, n, p] = r.querySelectorAll('select,input');
      const u = mtUserByName(n.value); return { side: s.value, name: n.value.trim(), position: p.value.trim(), user_id: u ? u.id : null }; }).filter(a => a.name);
    const p = { id: m.id, meeting_date: date.value, place: place.value.trim(), file_url: file.value.trim(), note: m.note,
                title_vi: m.title_vi, title_en: m.title_en, attendees };
    mtPut(p, 'title', lk, title.value.trim());
    try { await SB.rpc('mt_save_meeting', { p }); MT.edit = null; await mtReload(t('mt.saved')); } catch (e) { mtErr(out, e); }
  };
  return el('div', { className: 'mtform' }, [
    el('div', { className: 'row' }, [el('div', { className: 'fld' }, [el('label', { textContent: t('mt.c.date') }), date]),
      el('div', { className: 'fld grow' }, [el('label', { textContent: t('mt.f.title') }), title]),
      el('div', { className: 'fld grow' }, [el('label', { textContent: t('mt.f.place') }), place])]),
    el('label', { textContent: t('mt.f.attendees') }), el('div', { className: 'tdnote', textContent: t('mt.f.attHint') }), rows,
    el('div', { className: 'row' }, [el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('mt.f.addPerson'), onclick: () => addRow({ side: 'operator' }) })]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('mt.f.file') }), file]),
    el('div', { className: 'row' }, [el('button', { className: 'btn', type: 'button', textContent: t('mt.cancel'), onclick: () => { MT.edit = null; mtRender(); } }),
      el('button', { className: 'btn pri', type: 'button', textContent: t('tool.save'), onclick: save })]), out]);
}

// One topic inside a meeting: what was said last time, the actions still open, this meeting's notes.
function mtTopicCard(m, tp) {
  const card = el('div', { className: 'card mttopic' });
  const title = el('h2', {}, [document.createTextNode(mtTopicName(tp))]);
  if (tp.project_code) title.append(el('code', { className: 'mtprj', textContent: tp.project_code }));
  card.append(el('div', { className: 'chead' }, [title, el('div', { className: 'row' }, [el('button', { className: 'btn tiny', type: 'button', textContent: t('mt.history'),
    onclick: () => { MT.tab = 'topics'; MT.topic = tp.id; mtRender(); } })])]));
  const last = mtLastTime(m, tp.id);
  if (last) {
    const box = el('div', { className: 'mtlast' }, [el('div', { className: 'mtlbl', textContent: t('mt.lastTime', { d: fmtDate(last.date) }) })]);
    for (const e of last.entries) { const [d] = mtVal(e, 'decision'), [s] = mtVal(e, 'discussion'), [p] = mtVal(e, 'progress');
      const v = d || s || p; if (v) box.append(el('div', { className: 'mttext', textContent: (mtVal(e, 'stage')[0] ? mtVal(e, 'stage')[0] + ': ' : '') + v })); }
    if (box.children.length > 1) card.append(box);
  }
  const carried = mtCarried(m, tp.id);
  if (carried.length) card.append(el('div', { className: 'mtlbl', textContent: t('mt.carried', { n: carried.length }) }), mtActionList(carried, m));
  for (const e of MT.entries.filter(x => x.meeting_id === m.id && x.topic_id === tp.id)) {
    card.append(MT.edit === 'e' + e.id && mtW() ? mtEntryForm(m, tp, e) : mtEntryView(m, tp, e));
  }
  const loose = MT.actions.filter(a => a.meeting_id === m.id && a.topic_id === tp.id && !MT.entries.some(e => e.id === a.entry_id));
  if (loose.length) card.append(mtActionList(loose, m));
  if (MT.edit === 'new' + tp.id && mtW()) card.append(mtEntryForm(m, tp, null));
  else if (mtW()) card.append(el('div', { className: 'row' }, el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('mt.addEntry'),
    onclick: () => { MT.edit = 'new' + tp.id; mtRender(); } })));
  return card;
}

function mtEntryView(m, tp, e) {
  const box = el('div', { className: 'mtentry' });
  const [stage] = mtVal(e, 'stage');
  const head = el('div', { className: 'mtehead' }, [el('b', { textContent: stage || t('mt.general') })]);
  // ✎ opens the entry in its meeting, where it is edited (also from a topic's history or a search).
  if (mtW()) head.append(el('button', { className: 'btn tiny', type: 'button', textContent: '✎', title: t('mt.editEntry'),
    onclick: () => { MT.tab = 'meetings'; MT.open = m.id; MT.topic = null; MT.q = ''; MT.edit = 'e' + e.id; mtRender(); } }));
  box.append(head);
  const grid = el('div', { className: 'mtgrid' });
  for (const f of ['progress', 'discussion', 'decision', 'note']) {
    if (!mtVal(e, f)[0]) continue;
    grid.append(el('div', { className: 'mtcell' + (f === 'decision' ? ' dec' : '') }, [el('div', { className: 'mtlbl', textContent: t('mt.f.' + f) }), mtText(e, f)]));
  }
  if (grid.children.length) box.append(grid);
  const acts = MT.actions.filter(a => a.entry_id === e.id);
  if (acts.length) box.append(mtActionList(acts, m));
  return box;
}

// Actions as a small table: what, who, when, state, and the tick for whoever may tick it.
function mtActionList(acts, m, withTopic) {
  const tb = el('table', { className: 'lqbt mtacttbl' });
  tb.append(el('tr', {}, [...(withTopic ? [['mt.c.topic']] : []), ['mt.c.action'], ['mt.c.pic'], ['mt.c.due'], ['mt.c.from'], ['mt.c.status'], ['']]
    .map(([k]) => el('th', { textContent: k ? t(k) : '' }))));
  for (const a of acts) {
    const from = mtMeeting(a.meeting_id), closed = a.closed_meeting_id ? mtMeeting(a.closed_meeting_id) : null;
    const btns = el('td', { className: 'nowrap' });
    if (mtCanSet(a)) {
      const set = async (s) => {
        const note = s === 'open' ? null : prompt(t('mt.a.noteQ'), a.done_note || '');
        if (note === null && s !== 'open') return;
        try { await SB.rpc('mt_action_set', { p_id: a.id, p_status: s, p_note: note || null, p_meeting: m ? m.id : null });
              await mtReload(t('mt.a.set.' + s)); } catch (e) { mtErr('#mtMsg', e); } };
      if (a.status === 'open') btns.append(el('button', { className: 'btn tiny', type: 'button', textContent: '✓ ' + t('mt.a.do.done'), onclick: () => set('done') }),
                                          el('button', { className: 'btn tiny', type: 'button', textContent: t('mt.a.do.dropped'), onclick: () => set('dropped') }));
      else btns.append(el('button', { className: 'btn tiny', type: 'button', textContent: '↺ ' + t('mt.a.do.open'), onclick: () => set('open') }));
    }
    const state = el('td', { className: 'aowrap mtstate' }, [mtActChip(a)]);
    if (a.done_at) state.append(el('div', { className: 'dim', textContent: `${a.done_name || ''} · ${fmtDate(String(a.done_at).slice(0, 10))}${closed && closed.no ? ' · ' + closed.no : ''}` }));
    if (a.done_note) state.append(el('div', { className: 'dim', textContent: '“' + a.done_note + '”' }));
    tb.append(el('tr', { className: mtLate(a) ? 'mtlate' : '' }, [...(withTopic ? [el('td', { className: 'aowrap', textContent: mtTopicName(mtTopic(a.topic_id)) })] : []),
      el('td', { className: 'aowrap' }, mtText(a, 'text')), el('td', { textContent: a.pic_name || '' }), el('td', { className: 'nowrap', textContent: mtDue(a) }),
      el('td', { className: 'nowrap' }, from.no ? el('a', { className: 'aolink', href: '#', textContent: from.no, onclick: ev => { ev.preventDefault(); MT.tab = 'meetings'; MT.open = from.id; MT.edit = null; mtRender(); } }) : ''),
      state, btns]));
  }
  return el('div', { className: 'wrap mtacts-wrap' }, tb);
}

// Writing one topic's notes in the reading language; the other language shows underneath, read-only.
function mtEntryForm(m, tp, e) {
  const src = e || {};
  const box = el('div', { className: 'mtentry mtform' });
  const inputs = {}, from = {};
  // Each field is edited in the language it was written in; the translation shows underneath, read-only.
  const fld = (f, big) => {
    const lk = from[f] = mtSrcLang(src, f), ok = lk === 'vi' ? 'en' : 'vi';
    const i = big ? el('textarea', { rows: f === 'discussion' ? 4 : 2, value: src[`${f}_${lk}`] || '' }) : el('input', { value: src[`${f}_${lk}`] || '' });
    inputs[f] = i;
    return el('div', { className: 'fld grow mtfld' + (f === 'decision' ? ' dec' : '') }, [el('label', { textContent: t('mt.f.' + f) }), i,
      src[`${f}_${ok}`] ? el('div', { className: 'mtotherl', textContent: `${ok.toUpperCase()}: ${src[`${f}_${ok}`]}` }) : '']);
  };
  box.append(el('div', { className: 'tdnote', textContent: t('mt.langHint') }),
    el('div', { className: 'row' }, [fld('stage')]),
    el('div', { className: 'mtgrid' }, [fld('progress', true), fld('discussion', true), fld('decision', true), fld('note', true)]));
  // Actions of this entry.
  const list = mtPeopleList();
  const rows = el('div', { className: 'mtactrows' });
  const gone = [];
  const addAct = a => {
    const text = el('input', { value: a[`text_${mtSrcLang(a, 'text')}`] || '', placeholder: t('mt.c.action') });
    const pic = el('input', { value: a.pic_name || '', placeholder: t('mt.c.pic') }); pic.setAttribute('list', list);
    const due = el('input', { type: 'date', value: a.due_date || '' }), dueT = el('input', { value: a.due_text || '', placeholder: t('mt.f.dueText') });
    const x = el('button', { className: 'xbtn', type: 'button', textContent: '✕', onclick: () => { if (a.id) gone.push(a.id); r.remove(); } });
    const r = el('div', { className: 'mtactrow' }, [text, pic, due, dueT, x]);
    r._a = a; r._f = { text, pic, due, dueT };
    rows.append(r);
  };
  for (const a of e ? MT.actions.filter(a => a.entry_id === e.id && a.status !== 'historical') : []) addAct(a);
  box.append(el('label', { textContent: t('mt.f.actions') }), el('div', { className: 'mtactrow mthead' }, [t('mt.c.action'), t('mt.c.pic'), t('mt.c.due'), t('mt.f.dueText'), ''].map(s => el('span', { textContent: s }))),
    rows, el('div', { className: 'row' }, el('button', { className: 'btn tiny', type: 'button', textContent: '+ ' + t('mt.f.addAction'), onclick: () => addAct({}) })));
  const out = el('div');
  const save = async () => {
    const p = Object.assign({}, src, { meeting_id: m.id, topic_id: tp.id });
    for (const f of MT_FIELDS) mtPut(p, f, from[f], inputs[f].value.trim());
    try {
      const id = await SB.rpc('mt_save_entry', { p });
      for (const aid of gone) await SB.rpc('mt_delete_action', { p_id: aid });
      for (const r of rows.children) {
        const f = r._f, a = r._a;
        if (!f.text.value.trim()) { if (a.id) await SB.rpc('mt_delete_action', { p_id: a.id }); continue; }
        const u = mtUserByName(f.pic.value);
        const q = { id: a.id || null, meeting_id: m.id, topic_id: tp.id, entry_id: id, text_vi: a.text_vi || null, text_en: a.text_en || null,
                    pic_user: u ? u.id : null, pic_name: f.pic.value.trim(), due_date: f.due.value || null, due_text: f.dueT.value.trim() };
        mtPut(q, 'text', mtSrcLang(a, 'text'), f.text.value.trim());
        await SB.rpc('mt_save_action', { p: q });
      }
      MT.edit = null; await mtReload(t('mt.entrySaved'));
    } catch (err) { mtErr(out, err); }
  };
  const acts = [el('button', { className: 'btn', type: 'button', textContent: t('mt.cancel'), onclick: () => { MT.edit = null; mtRender(); } })];
  if (e && mtEd()) acts.unshift(el('button', { className: 'btn danger tiny', type: 'button', textContent: t('mt.delEntry'), onclick: async () => {
    if (!confirm(t('mt.delEntryQ'))) return;
    try { await SB.rpc('mt_delete_entry', { p_id: e.id }); MT.edit = null; await mtReload(t('mt.entryDeleted')); } catch (err) { mtErr(out, err); } } }));
  acts.push(el('button', { className: 'btn pri', type: 'button', textContent: t('tool.save'), onclick: save }));
  box.append(el('div', { className: 'row' }, acts), out);
  return box;
}

// Another topic into this meeting: an existing one (closed topics too) or a new one.
function mtAddTopic(m) {
  const shown = new Set(mtAgenda(m).map(x => x.id));
  const pick = el('select');
  selFill(pick, [['', t('mt.pickTopic')], ...MT.topics.filter(x => !shown.has(x.id)).map(x => [String(x.id), mtTopicName(x) + (x.status === 'closed' ? ` (${t('mt.tst.closed')})` : '')]),
    ['new', '+ ' + t('mt.newTopic')]]);
  const out = el('div'), form = el('div');
  pick.onchange = () => {
    form.innerHTML = '';
    if (pick.value === 'new') form.append(mtTopicForm({}, async id => { mtShow(m, id); MT.edit = 'new' + id; await mtReload(t('mt.topicSaved')); }));
    else if (pick.value) { mtShow(m, Number(pick.value)); MT.edit = 'new' + pick.value; mtRender(); }
  };
  return el('div', { className: 'card' }, [el('h2', { textContent: t('mt.addTopicH') }), el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, pick)]), form, out]);
}

// A topic's title (both languages here — it is short) and its project.
function mtTopicForm(tp, done) {
  const vi = el('input', { value: tp.title_vi || '' }), en = el('input', { value: tp.title_en || '' });
  let dl = document.getElementById('mtPrjList');
  if (!dl) { dl = el('datalist', { id: 'mtPrjList' }); document.body.append(dl); }
  dl.innerHTML = ''; for (const p of MT.projects || []) dl.append(el('option', { value: p.code, label: `${p.year} · ${p.name || ''}` }));
  const prj = el('input', { value: tp.project_code || '', placeholder: 'FFE.ENG.19.2026' }); prj.setAttribute('list', 'mtPrjList');
  const st = el('select'); selFill(st, [['open', t('mt.tst.open')], ['closed', t('mt.tst.closed')]]); st.value = tp.status || 'open';
  const out = el('div');
  const save = async () => {
    if (prj.value.trim() && !(MT.projects || []).some(p => p.code === prj.value.trim())) return msg(out, 'err', t('mt.noProject', { c: prj.value.trim() }));
    try { const id = await SB.rpc('mt_save_topic', { p: { id: tp.id || null, title_vi: vi.value.trim(), title_en: en.value.trim(), project_code: prj.value.trim(), status: st.value, note: tp.note } });
          await done(id); } catch (e) { mtErr(out, e); }
  };
  return el('div', { className: 'mtform' }, [el('div', { className: 'row' }, [
    el('div', { className: 'fld grow' }, [el('label', { textContent: t('mt.f.titleVi') }), vi]), el('div', { className: 'fld grow' }, [el('label', { textContent: t('mt.f.titleEn') }), en]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('mt.f.project') }), prj]), el('div', { className: 'fld' }, [el('label', { textContent: t('mt.c.status') }), st]),
    el('button', { className: 'btn pri', type: 'button', textContent: t('tool.save'), onclick: save })]), out]);
}

async function mtIssue(m, out) {
  const n = MT.entries.filter(e => e.meeting_id === m.id).length;
  if (!n && !confirm(t('mt.issueEmptyQ'))) return;
  if (!confirm(t('mt.issueQ', { no: m.no }))) return;
  try { const k = await SB.rpc('mt_issue', { p_id: m.id }); await mtReload(t('mt.issued', { n: fmtInt(k || 0) })); }
  catch (e) { mtErr(out, e); }
}

/* ------------------------------------------------------------ translate with Claude */
// Every bilingual text of the meeting that has one language only (or all of them, to redo).
function mtTransItems(m, all) {
  const items = [];
  const push = (tt, o, base) => {
    const vi = o[`${base}_vi`], en = o[`${base}_en`];
    if (all ? (vi || en) : (!!vi !== !!en)) {
      const from = vi && (!en || LANG === 'vi') ? 'vi' : 'en';
      items.push({ t: tt, id: o.id, f: `${base}_${from === 'vi' ? 'en' : 'vi'}`, from, src: from === 'vi' ? vi : en });
    }
  };
  push('meeting', m, 'title');
  for (const tp of mtAgenda(m)) push('topic', tp, 'title');
  for (const e of MT.entries.filter(x => x.meeting_id === m.id)) for (const f of MT_FIELDS) push('entry', e, f);
  for (const a of MT.actions.filter(x => x.meeting_id === m.id)) push('action', a, 'text');
  return items;
}
function mtTranslate(anchor, m) {
  const old = document.getElementById('mtTrans'); if (old) { old.remove(); return; }
  const all = el('input', { type: 'checkbox' }), out = el('div'), ta = el('textarea', { rows: 6, className: 'prjson', placeholder: t('mt.tr.pastePh') });
  const info = el('div', { className: 'tdnote' });
  const build = () => {
    const items = mtTransItems(m, all.checked);
    info.textContent = t('mt.tr.hint', { n: items.length });
    return items;
  };
  build(); all.onchange = build;
  const box = el('div', { className: 'card prdraft', id: 'mtTrans' }, [el('h3', { textContent: t('mt.tr.h') }), info,
    el('label', { className: 'chk' }, [all, el('span', { textContent: t('mt.tr.all') })]),
    el('div', { className: 'row' }, [el('button', { className: 'btn', type: 'button', textContent: t('pr.copyPrompt'), onclick: async () => {
      const items = build();
      if (!items.length) return msg(out, 'ok', t('mt.tr.nothing'));
      const prompt = 'You translate the minutes of a hotel owner / operator meeting on capital-expenditure (Capex) projects between Vietnamese and English. ' +
        'Keep the meaning, the figures, names, codes and bullet points ("- ") exactly; use the usual project terms (BOQ, tender, contractor, acceptance, PIC). ' +
        'Translate each item\'s "src" from its "from" language into the other one. Answer with JSON only, no prose:\n' +
        '{"items":[{"t":"<t as given>","id":<id as given>,"f":"<f as given>","v":"<translation>"}]}\n\nITEMS:\n' +
        JSON.stringify(items.map(x => ({ t: x.t, id: x.id, f: x.f, from: x.from, src: x.src })), null, 1);
      try { await navigator.clipboard.writeText(prompt); msg(out, 'ok', t('pr.copied')); } catch { ta.value = prompt; msg(out, 'warn', t('pr.copyFail')); } } })]),
    ta, el('div', { className: 'row' }, [el('button', { className: 'btn pri', type: 'button', textContent: t('mt.tr.apply'), onclick: async () => {
      try {
        const j = JSON.parse(String(ta.value).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
        const allowed = new Set(mtTransItems(m, true).map(x => `${x.t}:${x.id}:${x.f}`));
        const items = (j.items || []).filter(x => x && allowed.has(`${x.t}:${x.id}:${x.f}`) && String(x.v || '').trim());
        if (!items.length) return msg(out, 'err', t('mt.tr.none'));
        const n = await SB.rpc('mt_apply_text', { p_items: items.map(x => ({ t: x.t, id: x.id, f: x.f, v: x.v })) });
        await mtReload(t('mt.tr.done', { n: fmtInt(n) }));
      } catch (e) { msg(out, 'err', t('pr.jsonBad', { e: e.message })); } } })]), out]);
  anchor.after(box);
}

/* ------------------------------------------------------------ minutes (PDF, e-mail) */
// A text in both languages for the paper: Vietnamese, the English in italics under it.
// The same text in both (a name, "BOQ") prints once.
const mtBi = (o, base) => { const vi = o[`${base}_vi`], en = o[`${base}_en`];
  return [vi ? el('div', { textContent: vi }) : '', en && en !== vi ? el('div', { className: 'en', textContent: en }) : ''].filter(Boolean); };
// Rough height of a row in lines, to fill each A4 page without shrinking it.
const mtLines = (s, w) => String(s || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / w)), 0);
function mtMinutes(m) {
  const agenda = mtAgenda(m);
  const rows = [];
  for (const tp of agenda) {
    const ents = MT.entries.filter(e => e.meeting_id === m.id && e.topic_id === tp.id);
    const acts = MT.actions.filter(a => a.meeting_id === m.id && a.topic_id === tp.id);
    if (!ents.length && !acts.length) continue;
    rows.push({ grp: tp });
    for (const e of ents) rows.push({ e, acts: acts.filter(a => a.entry_id === e.id) });
    const loose = acts.filter(a => !ents.some(e => e.id === a.entry_id));
    if (loose.length) rows.push({ e: {}, acts: loose });
  }
  const carried = MT.actions.filter(a => a.status === 'open' && a.meeting_id !== m.id && (mtMeeting(a.meeting_id).meeting_date || '') < m.meeting_date);
  const actTxt = a => [a.text_vi, a.text_en ? '— ' + a.text_en : '', [a.pic_name, mtDue(a)].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
  const weight = r => r.grp ? 2 : Math.max(mtLines([r.e.stage_vi, r.e.stage_en].join('\n'), 22), mtLines([r.e.progress_vi, r.e.progress_en].join('\n'), 26),
    mtLines([r.e.discussion_vi, r.e.discussion_en].join('\n'), 40), mtLines([r.e.decision_vi, r.e.decision_en].join('\n'), 30), mtLines(r.acts.map(actTxt).join('\n'), 34)) + 1;
  const cols = [['Chủ đề / Topic', '15%'], ['Tiến độ / Progress', '16%'], ['Thảo luận / Discussion', '27%'], ['Kết luận – chỉ đạo / Decision – direction', '20%'], ['Việc cần làm · PIC · hạn / Actions · PIC · due', '22%']];
  const table = list => {
    const tb = el('table', { className: 'lqt mtlqt' });
    tb.append(el('colgroup', {}, cols.map(c => el('col', { style: `width:${c[1]}` }))), el('tr', {}, cols.map(c => el('th', { textContent: c[0] }))));
    for (const r of list) {
      if (r.grp) { tb.append(el('tr', { className: 'mtgrp' }, el('td', { colSpan: 5 }, [el('b', { textContent: r.grp.title_vi || r.grp.title_en || '' }),
        r.grp.title_en && r.grp.title_vi && r.grp.title_en !== r.grp.title_vi ? el('span', { className: 'en', textContent: ' / ' + r.grp.title_en }) : '', r.grp.project_code ? el('span', { textContent: ' · ' + r.grp.project_code }) : '']))); continue; }
      tb.append(el('tr', {}, [el('td', {}, mtBi(r.e, 'stage')), el('td', {}, mtBi(r.e, 'progress')), el('td', {}, [...mtBi(r.e, 'discussion'), ...mtBi(r.e, 'note')]),
        el('td', { className: 'dec' }, mtBi(r.e, 'decision')),
        el('td', {}, r.acts.map(a => el('div', { className: 'mtpa' }, [...mtBi(a, 'text'), el('div', { className: 'who', textContent: [a.pic_name, mtDue(a)].filter(Boolean).join(' · ') })])))]));
    }
    return tb;
  };
  const side = s => (m.attendees || []).filter(a => (a.side || 'other') === s).map(a => a.name + (a.position ? ` (${a.position})` : '')).join('; ');
  // A title of its own under the heading; the standard one would only repeat it.
  const ownTitle = (m.title_vi || m.title_en) && m.title_vi !== t2vi('mt.defTitle') && m.title_en !== t2en('mt.defTitle');
  const head = [lqbHead(null, 'BIÊN BẢN HỌP ĐỊNH KỲ DỰ ÁN CAPEX', 'CAPEX PROJECTS PROGRESS MEETING — MINUTES', m.no, m.meeting_date,
      ownTitle ? [m.title_vi || '', m.title_en || ''] : null),
    lqbSec('I. Thông tin cuộc họp', 'Meeting information'),
    lqbBi(`Địa điểm: ${m.place || '…………'}`, `Venue: ${m.place || '…………'}`),
    ...MT_SIDES.filter(side).map(s => lqbBi(`${t2vi('mt.side.' + s)}: ${side(s)}`, `${t2en('mt.side.' + s)}: ${side(s)}`)),
    lqbSec('II. Nội dung cuộc họp', 'Discussion by project')];
  const foot = [
    ...(carried.length ? [lqbSec('III. Việc còn mở từ các cuộc họp trước', 'Open actions carried forward'),
      lqbTable([['STT / No.', (a, i) => i + 1, 'c', '6%'], ['Chủ đề / Topic', a => mtTopic(a.topic_id).title_vi || mtTopic(a.topic_id).title_en || '', '', '20%'],
        ['Việc / Action', a => [a.text_vi, a.text_en].filter(Boolean).join(' / '), '', '44%'], ['PIC', a => a.pic_name || '', '', '14%'],
        ['Hạn / Due', a => mtDue(a), 'c', '8%'], ['Từ / From', a => mtMeeting(a.meeting_id).no || '', 'c', '8%']], carried)] : []),
    lqbSigns([['Đại diện Chủ đầu tư', 'Owner representative', ''], ['Đại diện Operator', 'Operator representative', ''],
              ['Người lập', 'Prepared by', String(m.created_name || '').toUpperCase()]])];
  // Pages by weight: the first carries the head (fewer lines), the last the foot.
  const pages = [], FIRST = 44, NEXT = 62;
  let cur = [], budget = FIRST;
  for (const r of rows) {
    const w = weight(r);
    if (cur.length && w > budget) { pages.push(cur); cur = []; budget = NEXT; }
    cur.push(r); budget -= w;
  }
  pages.push(cur);
  return pages.map((list, i) => el('div', { className: 'fpage lqpage land' }, [...(i ? [el('div', { className: 'lqcont', textContent: t('lqb.cont') })] : head),
    list.length ? table(list) : el('div', { className: 'bi', textContent: '…' }), ...(i === pages.length - 1 ? foot : [])]));
}
// Labels for the bilingual paper, whatever the reading language.
const t2vi = k => (I18N.vi || {})[k] || k;
const t2en = k => (I18N.en || {})[k] || k;

// E-mail: the PDF is saved first (a browser cannot attach it), then the mail program opens
// addressed to the attendees who have an app account, with the decisions and actions as text.
async function mtEmail(m, out) {
  await aoCapture(() => mtMinutes(m), `${m.no} ${t('mt.pdfName')}`, 'pdf', out);
  const people = MT.people || [];
  const to = (m.attendees || []).map(a => (people.find(p => p.id === a.user_id) || {}).email).filter(Boolean);
  const lines = [`${t('mt.mail.hello')}`, '', t('mt.mail.intro', { no: m.no, d: fmtDate(m.meeting_date) }), ''];
  for (const tp of mtAgenda(m)) {
    const ents = MT.entries.filter(e => e.meeting_id === m.id && e.topic_id === tp.id), acts = MT.actions.filter(a => a.meeting_id === m.id && a.topic_id === tp.id);
    if (!ents.length && !acts.length) continue;
    lines.push('■ ' + mtTopicName(tp));
    for (const e of ents) { const [d] = mtVal(e, 'decision'); if (d) lines.push(`  ${t('mt.f.decision')}: ${d}`); }
    for (const a of acts) lines.push(`  → ${mtVal(a, 'text')[0]}${a.pic_name ? ' — ' + a.pic_name : ''}${mtDue(a) ? ' (' + mtDue(a) + ')' : ''}`);
  }
  lines.push('', t('mt.mail.attach'));
  let bodyTxt = lines.join('\n');
  if (bodyTxt.length > 1600) bodyTxt = bodyTxt.slice(0, 1600) + '\n…\n' + t('mt.mail.attach');
  const href = `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(`${m.no} — ${mtVal(m, 'title')[0] || t('mt.defTitle')} (${fmtDate(m.meeting_date)})`)}&body=${encodeURIComponent(bodyTxt)}`;
  location.href = href;
  msg(out, 'ok', t('mt.mail.opened', { n: to.length }));
}

/* ------------------------------------------------------------ topics & history */
function mtTopicList(body) {
  const q = el('input', { value: MT.q, placeholder: t('mt.searchPh'), spellcheck: false });
  const st = el('select'); selFill(st, [['open', t('mt.tst.open')], ['closed', t('mt.tst.closed')], ['', t('pm.f.all')]]); st.value = MT.tstat;
  q.onkeydown = ev => { if (ev.key === 'Enter') { MT.q = q.value.trim(); mtRender(); } };
  st.onchange = () => { MT.tstat = st.value; mtRender(); };
  const head = el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, [el('label', { textContent: t('mt.search') }), q]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('mt.c.status') }), st]),
    el('button', { className: 'btn', type: 'button', textContent: t('mt.find'), onclick: () => { MT.q = q.value.trim(); mtRender(); } })]);
  if (mtW()) head.append(el('button', { className: 'btn pri', type: 'button', textContent: '+ ' + t('mt.newTopic'), onclick: () => { MT.edit = MT.edit === 'topic' ? null : 'topic'; mtRender(); } }));
  const card = el('div', { className: 'card' }, [head]);
  if (MT.edit === 'topic') card.append(mtTopicForm({}, async () => { MT.edit = null; await mtReload(t('mt.topicSaved')); }));
  body.append(card);
  if (MT.q) return mtSearchResults(body, MT.q);
  const tb = el('table', { className: 'lqbt' });
  tb.append(el('tr', {}, [['mt.c.topic'], ['mt.f.project'], ['mt.c.last', ''], ['mt.c.meetings', 'num'], ['mt.c.open', 'num'], ['mt.c.status']]
    .map(([k, c]) => el('th', { className: c || '', textContent: t(k) }))));
  const rows = MT.topics.filter(tp => !MT.tstat || tp.status === MT.tstat);
  for (const tp of rows) {
    const ms = new Set(MT.entries.filter(e => e.topic_id === tp.id).map(e => e.meeting_id));
    const last = [...ms].map(id => mtMeeting(id).meeting_date).filter(Boolean).sort().pop();
    const open = MT.actions.filter(a => a.topic_id === tp.id && a.status === 'open').length;
    const tr = el('tr', { className: 'aoclick' }, [el('td', { className: 'aowrap' }, [el('b', { textContent: mtTopicName(tp) })]),
      el('td', {}, tp.project_code ? el('code', { textContent: tp.project_code }) : ''), el('td', { textContent: last ? fmtDate(last) : '' }),
      el('td', { className: 'num', textContent: fmtInt(ms.size) }), el('td', { className: 'num', textContent: open ? fmtInt(open) : '' }),
      el('td', {}, mtChip('t-' + tp.status, t('mt.tst.' + tp.status)))]);
    tr.onclick = () => { MT.topic = tp.id; MT.edit = null; mtRender(); };
    tb.append(tr);
  }
  body.append(el('div', { className: 'card' }, rows.length ? el('div', { className: 'wrap' }, tb) : el('div', { className: 'dim', textContent: t('pm.none.filter') })));
}

// Every meeting that wrote about the topic, newest first: the history to look back on.
function mtTopicView(body, tp) {
  if (!tp.id) { MT.topic = null; return mtTopicList(body); }
  const head = el('div', { className: 'card' }, [el('div', { className: 'chead' }, [el('h2', {}, [document.createTextNode(mtTopicName(tp) + ' '), mtChip('t-' + tp.status, t('mt.tst.' + tp.status))]),
    el('div', { className: 'row' }, [el('button', { className: 'btn', type: 'button', textContent: '← ' + t('mt.back'), onclick: () => { MT.topic = null; MT.edit = null; mtRender(); } }),
      ...(mtW() ? [el('button', { className: 'btn', type: 'button', textContent: '✎ ' + t('mt.editTopic'), onclick: () => { MT.edit = MT.edit === 'topic' ? null : 'topic'; mtRender(); } })] : [])])])]);
  if (tp.project_code) {
    const p = (MT.projects || []).find(x => x.code === tp.project_code);
    head.append(el('div', {}, [document.createTextNode(t('mt.f.project') + ': '), el('a', { className: 'aolink', href: '#', textContent: `${tp.project_code}${p ? ' — ' + (p.name || '') : ''}`,
      onclick: ev => { ev.preventDefault(); PM.prj.open = tp.project_code; showView('projects'); } })]));
  }
  if (MT.edit === 'topic') head.append(mtTopicForm(tp, async () => { MT.edit = null; await mtReload(t('mt.topicSaved')); }));
  body.append(head);
  const open = MT.actions.filter(a => a.topic_id === tp.id && a.status === 'open');
  if (open.length) body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('mt.openActs', { n: open.length }) }), mtActionList(open, null)]));
  const byM = new Map();
  for (const e of MT.entries.filter(x => x.topic_id === tp.id)) (byM.get(e.meeting_id) || byM.set(e.meeting_id, []).get(e.meeting_id)).push(e);
  const ms = [...byM.keys()].map(mtMeeting).sort((a, b) => String(b.meeting_date).localeCompare(String(a.meeting_date)));
  const tl = el('div', { className: 'mttl' });
  for (const m of ms) {
    const item = el('div', { className: 'mtev' }, [el('div', { className: 'mtdate' }, [el('b', { textContent: fmtDate(m.meeting_date) }),
      el('a', { className: 'aolink', href: '#', textContent: m.no, onclick: ev => { ev.preventDefault(); MT.tab = 'meetings'; MT.open = m.id; MT.edit = null; mtRender(); } })])]);
    const col = el('div', { className: 'mtevb' });
    for (const e of byM.get(m.id)) col.append(mtEntryView(m, tp, e));
    item.append(col);
    tl.append(item);
  }
  body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('mt.historyH', { n: ms.length }) }), ms.length ? tl : el('div', { className: 'dim', textContent: t('mt.noHistory') })]));
}

// Search: every entry and action whose text holds all the words, newest first.
function mtSearchResults(body, q) {
  const words = hnorm(q).split(/\s+/).filter(Boolean);
  const hit = s => { const h = hnorm(s); return words.every(w => h.includes(w)); };
  const ents = MT.entries.filter(e => hit([mtTopicName(mtTopic(e.topic_id)), ...MT_FIELDS.flatMap(f => [e[f + '_vi'], e[f + '_en']]),
    ...MT.actions.filter(a => a.entry_id === e.id).flatMap(a => [a.text_vi, a.text_en, a.pic_name])].join(' ')))
    .sort((a, b) => String(mtMeeting(b.meeting_id).meeting_date).localeCompare(String(mtMeeting(a.meeting_id).meeting_date)));
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('mt.found', { n: ents.length, q }) })]);
  for (const e of ents.slice(0, 200)) {
    const m = mtMeeting(e.meeting_id), tp = mtTopic(e.topic_id);
    card.append(el('div', { className: 'mtev' }, [el('div', { className: 'mtdate' }, [el('b', { textContent: fmtDate(m.meeting_date) }),
      el('a', { className: 'aolink', href: '#', textContent: mtTopicName(tp), onclick: ev => { ev.preventDefault(); MT.topic = tp.id; MT.q = ''; mtRender(); } })]),
      el('div', { className: 'mtevb' }, mtEntryView(m, tp, e))]));
  }
  body.append(card);
}

/* ------------------------------------------------------------ action tracker */
function mtActionsTab(body) {
  const f = MT.af;
  const st = el('select'); selFill(st, [['open', t('mt.a.open')], ['late', t('mt.a.late')], ['done', t('mt.a.done')], ['dropped', t('mt.a.dropped')], ['historical', t('mt.a.historical')], ['', t('pm.f.all')]]);
  st.value = f.status;
  const pics = [...new Set(MT.actions.map(a => a.pic_name).filter(Boolean))].sort();
  const pic = el('select'); selFill(pic, [['', t('mt.anyPic')], ...(ME ? [['@me', t('mt.mine')]] : []), ...pics.map(p => [p, p])]); pic.value = f.pic;
  const q = el('input', { value: f.q, placeholder: t('mt.c.action') + '…' });
  const go = () => { Object.assign(f, { status: st.value, pic: pic.value, q: q.value.trim() }); mtRender(); };
  st.onchange = go; pic.onchange = go; q.onkeydown = ev => { if (ev.key === 'Enter') go(); };
  body.append(el('div', { className: 'card' }, el('div', { className: 'row' }, [el('div', { className: 'fld' }, [el('label', { textContent: t('mt.c.status') }), st]),
    el('div', { className: 'fld' }, [el('label', { textContent: t('mt.c.pic') }), pic]), el('div', { className: 'fld grow' }, [el('label', { textContent: t('mt.search') }), q])])));
  const words = hnorm(f.q).split(/\s+/).filter(Boolean);
  const rows = MT.actions.filter(a => (!f.status || (f.status === 'late' ? mtLate(a) : a.status === f.status))
      && (!f.pic || (f.pic === '@me' ? ME && a.pic_user === ME.id : a.pic_name === f.pic))
      && (!words.length || words.every(w => hnorm([a.text_vi, a.text_en, a.pic_name, mtTopicName(mtTopic(a.topic_id))].join(' ')).includes(w))))
    .sort((a, b) => (mtLate(b) - mtLate(a)) || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999'))
      || String(mtMeeting(b.meeting_id).meeting_date).localeCompare(String(mtMeeting(a.meeting_id).meeting_date)));
  const card = el('div', { className: 'card' }, [el('h2', { textContent: t('mt.actsH', { n: rows.length }) })]);
  card.append(rows.length ? mtActionList(rows.slice(0, 500), null, true) : el('div', { className: 'dim', textContent: t('pm.none.filter') }));
  body.append(card);
}

// To-do list rows: my open actions (app.js adds them to the list).
async function mtTodos() {
  if (!ME || !can('meeting', 'view')) return [];
  const acts = await SB.select('pm_mt_action', `select=*&pic_user=eq.${ME.id}&status=eq.open`);
  if (!acts.length) return [];
  const [ms, tps] = await Promise.all([SB.select('pm_mt_meeting', `select=id,no,meeting_date&id=in.(${[...new Set(acts.map(a => a.meeting_id))].join(',')})`),
    SB.select('pm_mt_topic', `select=id,title_vi,title_en,project_code&id=in.(${[...new Set(acts.map(a => a.topic_id))].join(',')})`)]);
  return acts.map(a => { const m = ms.find(x => x.id === a.meeting_id) || {}, tp = tps.find(x => x.id === a.topic_id) || {};
    return { kind: 'mtact', mt_action: a.id, doc_no: m.no, project_code: tp.project_code || '', project_name: `${mtTopicName(tp)} — ${mtVal(a, 'text')[0]}`,
             dept_code: '', submitted_at: m.meeting_date, due: a.due_date }; });
}
function mtOpenActions() { MT.tab = 'actions'; MT.af = { status: 'open', pic: '@me', q: '' }; MT.open = null; showView('meetings'); }
function mtOpenNo(no) { const m = MT.meetings.find(x => x.no === no); MT.tab = 'meetings'; MT.open = m ? m.id : null; MT.pendingNo = m ? null : no; showView('meetings'); }

// The project panel: what the meetings said about this project lately.
async function mtProjectPanel(p, card) {
  if (!can('meeting', 'view')) return;
  const tps = await SB.select('pm_mt_topic', `select=*&project_code=eq.${encodeURIComponent(p.code)}`);
  if (!tps.length) return;
  const ids = tps.map(x => x.id).join(',');
  const [ents, acts] = await Promise.all([SB.select('pm_mt_entry', `select=*&topic_id=in.(${ids})`), SB.select('pm_mt_action', `select=*&topic_id=in.(${ids})&status=eq.open`)]);
  const mids = [...new Set(ents.map(e => e.meeting_id))];
  const ms = mids.length ? await SB.select('pm_mt_meeting', `select=id,no,meeting_date&id=in.(${mids.join(',')})`) : [];
  const date = e => (ms.find(m => m.id === e.meeting_id) || {}).meeting_date || '';
  const last = ents.sort((a, b) => date(b).localeCompare(date(a))).slice(0, 4);
  const box = el('div', { className: 'mtpanel' }, [el('h2', { style: 'margin-top:14px', textContent: t('mt.panelH') })]);
  for (const e of last) {
    const [d] = mtVal(e, 'decision'), [s] = mtVal(e, 'discussion'), [pr] = mtVal(e, 'progress');
    box.append(el('div', { className: 'mtev' }, [el('div', { className: 'mtdate' }, [el('b', { textContent: fmtDate(date(e)) })]),
      el('div', { className: 'mtevb' }, [mtVal(e, 'stage')[0] ? el('b', { textContent: mtVal(e, 'stage')[0] }) : '', el('div', { className: 'mttext' + (d ? ' dec' : ''), textContent: d || s || pr })])]));
  }
  if (acts.length) box.append(el('div', { className: 'mtlbl', textContent: t('mt.openActs', { n: acts.length }) }),
    ...acts.slice(0, 6).map(a => el('div', { className: 'mttext', textContent: `→ ${mtVal(a, 'text')[0]}${a.pic_name ? ' — ' + a.pic_name : ''}${mtDue(a) ? ' (' + mtDue(a) + ')' : ''}` })));
  box.append(el('div', { className: 'row' }, el('button', { className: 'btn tiny', type: 'button', textContent: t('mt.history'), onclick: () => {
    ppDrawerClose(); MT.tab = 'topics'; MT.topic = tps[0].id; MT.open = null; showView('meetings'); } })));
  card.append(box);
}

/* ------------------------------------------------------------ import the old workbook */
function mtImportTab(body) {
  const file = el('input', { type: 'file', accept: '.xlsx,.xlsm,.xls' }), out = el('div'), prev = el('div');
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    msg(out, 'info', t('table.loading'));
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellStyles: true, cellDates: false });
      MT.parsed = mtParseBook(wb); MT.parsed.file = f.name;
      msg(out, '', ''); mtImportPreview(prev);
    } catch (e) { msg(out, 'err', e.message); }
  };
  body.append(el('div', { className: 'card' }, [el('h2', { textContent: t('mt.imp.h') }), el('p', { textContent: t('mt.imp.hint') }),
    el('div', { className: 'row' }, [el('div', { className: 'fld grow' }, file)]), out, prev]));
  if (MT.parsed) mtImportPreview(prev);
}

// Excel cell → text / ISO date.
const mtCell = (ws, r, c) => { const x = ws[XLSX.utils.encode_cell({ r, c })]; return x ? x : null; };
const mtStr = x => x == null || x.v == null ? '' : String(x.v).replace(/\r/g, '').trim();
function mtIso(x) {
  if (!x || x.v == null || x.v === '') return null;
  if (typeof x.v === 'number' && x.v > 20000 && x.v < 80000) { const d = new Date(Math.round((x.v - 25569) * 864e5)); return d.toISOString().slice(0, 10); }
  const m = String(x.v).trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
const mtFill = x => { const s = x && x.s; const c = s && (s.fgColor || (s.fill && s.fill.fgColor)); return c ? String(c.rgb || '').toUpperCase() : ''; };
const mtViText = s => (String(s).match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹáàãéèíìóòõúùý]/gi) || []).length;
// One sheet → topics (navy heading rows), groups (other heading rows), data rows with their date carried down.
function mtParseSheet(ws) {
  const rg = XLSX.utils.decode_range(ws['!ref'] || 'A1:H1');
  const out = { topics: [], rows: [] };
  let topic = -1, group = '', label = '', date = null;
  for (let r = 1; r <= rg.e.r; r++) {
    const v = [0, 1, 2, 3, 4, 5, 6, 7].map(c => mtCell(ws, r, c));
    const s = v.map(mtStr);
    if (!s.some(Boolean)) continue;
    const heading = s[0] && !s.slice(1).some(Boolean);
    if (heading) {
      const fill = mtFill(v[0]);
      // Navy (#002060) = a project; another fill = a stage group. Without style information: a group when it reads like one.
      const isTopic = fill ? /002060/.test(fill) : !/^(hạng mục|đấu thầu|thi công|design|construction|bidding)/i.test(s[0]);
      if (isTopic || topic < 0) { out.topics.push(s[0]); topic = out.topics.length - 1; group = ''; label = ''; }
      else { group = s[0]; label = ''; }
      continue;
    }
    if (topic < 0) { out.topics.push('—'); topic = 0; }
    if (s[0]) label = s[0];
    const d = mtIso(v[1]); if (d) date = d;
    if (!date) continue;
    out.rows.push({ topic, date, stage: [group, label].filter(Boolean).join(' › '), progress: s[2], discussion: s[3], action: s[4],
                    due: v[5], note: s[6], pic: s[7], sig: [2, 3, 4, 5, 7].map(c => s[c] ? 1 : 0).join('') });
  }
  return out;
}
// Bullet lines "- a / - b" → one action each.
const mtBullets = s => { const ls = String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
  const items = []; for (const l of ls) { if (/^[-–•]/.test(l) || !items.length) items.push(l.replace(/^[-–•]\s*/, '')); else items[items.length - 1] += '\n' + l; }
  return items; };
function mtParseBook(wb) {
  const names = wb.SheetNames;
  const used = new Set(), groups = [];
  for (const n of names) {
    if (used.has(n)) continue;
    const base = n.replace(/\((VIE|VI|ENG|EN)\)/i, '').trim();
    const mate = names.find(x => x !== n && !used.has(x) && x.replace(/\((VIE|VI|ENG|EN)\)/i, '').trim() === base);
    used.add(n); if (mate) used.add(mate);
    const pair = [n, mate].filter(Boolean).map(x => ({ name: x, sh: mtParseSheet(wb.Sheets[x]) }));
    const score = p => p.sh.rows.reduce((k, r) => k + mtViText(r.discussion + r.action + r.progress), 0);
    // Which sheet is which: by its name "(VIE)" / "(ENG)", else by the Vietnamese letters in it.
    let vi, en;
    if (pair.length === 2) { vi = pair.find(p => /\((VIE|VI)\)/i.test(p.name)) || pair.slice().sort((a, b) => score(b) - score(a))[0]; en = pair.find(p => p !== vi); }
    else if (score(pair[0]) > 0 || !/\((ENG|EN)\)/i.test(pair[0].name)) { vi = pair[0]; en = null; }
    else { vi = null; en = pair[0]; }
    groups.push({ vi, en, name: pair.map(p => p.name).join(' + ') });
  }
  const rows = [];
  let sort = 0;
  for (const g of groups) {
    const V = g.vi ? g.vi.sh : null, E = g.en ? g.en.sh : null;
    const enUsed = new Set();
    const pick = rv => {
      if (!E) return null;
      const cand = E.rows.map((re, i) => ({ re, i })).filter(({ re, i }) => !enUsed.has(i) && re.topic === rv.topic && re.date === rv.date);
      const c = cand.find(({ re }) => re.sig === rv.sig) || cand[0];
      if (!c) return null; enUsed.add(c.i); return c.re;
    };
    const mk = (rv, re) => {
      const aV = mtBullets(rv ? rv.action : ''), aE = mtBullets(re ? re.action : '');
      const actions = aV.length === aE.length ? aV.map((x, i) => ({ vi: x, en: aE[i] }))
        : [{ vi: aV.join('\n'), en: aE.join('\n') }].filter(a => a.vi || a.en);
      const base = rv || re, due = base.due;
      const tvi = V ? V.topics[base.topic] || '' : '', ten = E ? E.topics[base.topic] || '' : '';
      return { date: base.date, topic_vi: tvi || ten, topic_en: ten, topic_sort: (base.topic + 1) * 10 + groups.indexOf(g) * 1000,
               stage_vi: rv ? rv.stage : '', stage_en: re ? re.stage : '', progress_vi: rv ? rv.progress : '', progress_en: re ? re.progress : '',
               discussion_vi: rv ? rv.discussion : '', discussion_en: re ? re.discussion : '', note_vi: rv ? rv.note : '', note_en: re ? re.note : '',
               due_date: mtIso(due), due_text: mtIso(due) ? '' : mtStr(due), pic: (rv && rv.pic) || (re && re.pic) || '', actions, sort: ++sort };
    };
    for (const rv of V ? V.rows : []) rows.push(mk(rv, pick(rv)));
    if (E) E.rows.forEach((re, i) => { if (!enUsed.has(i)) rows.push(mk(null, re)); });
  }
  return { rows: rows.filter(r => [r.progress_vi, r.progress_en, r.discussion_vi, r.discussion_en, r.note_vi, r.note_en].some(Boolean) || r.actions.length),
           sheets: groups.map(g => g.name) };
}
function mtImportPreview(prev) {
  const P = MT.parsed; prev.innerHTML = '';
  if (!P) return;
  const dates = [...new Set(P.rows.map(r => r.date))].sort();
  const topics = new Map(); for (const r of P.rows) { const k = r.topic_vi || r.topic_en; topics.set(k, (topics.get(k) || 0) + 1); }
  const nAct = P.rows.reduce((k, r) => k + r.actions.length, 0);
  const tb = el('table', { className: 'lqbt' }, [el('tr', {}, [el('th', { textContent: t('mt.c.topic') }), el('th', { className: 'num', textContent: t('mt.imp.rows') })]),
    ...[...topics].map(([k, n]) => el('tr', {}, [el('td', { textContent: k }), el('td', { className: 'num', textContent: fmtInt(n) })]))]);
  const out = el('div');
  const go = async () => {
    if (!confirm(t('mt.imp.q'))) return;
    try {
      const tot = { meetings: 0, entries: 0, actions: 0 };
      for (let i = 0; i < P.rows.length; i += 120) {
        msg(out, 'info', t('mt.imp.running', { i: Math.min(i + 120, P.rows.length), n: P.rows.length }));
        const r = await SB.rpc('mt_import', { p_rows: P.rows.slice(i, i + 120), p_reset: i === 0 });
        for (const k in tot) tot[k] += Number((r || {})[k] || 0);
      }
      MT.parsed = null; MT.tab = 'meetings';
      await mtReload(t('mt.imp.done', { m: fmtInt(tot.meetings), e: fmtInt(tot.entries), a: fmtInt(tot.actions) }));
    } catch (e) { mtErr(out, e); }
  };
  prev.append(el('div', { className: 'msg info', textContent: t('mt.imp.sum', { f: P.file || '', s: P.sheets.join(' · '), m: dates.length, d1: fmtDate(dates[0] || ''), d2: fmtDate(dates[dates.length - 1] || ''),
    t: topics.size, e: P.rows.length, a: nAct }) }), el('div', { className: 'wrap' }, tb),
    el('div', { className: 'row' }, el('button', { className: 'btn pri', type: 'button', textContent: t('mt.imp.go'), onclick: go })), out);
}

window.mtLoad = mtLoad;
window.mtTodos = mtTodos;
window.mtOpenActions = mtOpenActions;
window.mtOpenNo = mtOpenNo;
window.mtProjectPanel = mtProjectPanel;
