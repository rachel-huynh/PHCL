/* In-app document viewer (user 29/09/2026): a file opens in a window over the app instead of
   being downloaded first. Several documents — a payment request's letter and invoice, the
   contract, the project's approved forms — are merged into one PDF shown at once: the list on
   the left jumps to each; a file the browser cannot show (Excel, Word, zip) stays in the list
   with its own download button, a OneDrive link opens in a new tab.
   dvOpen(title, items) — items: [{ label, sub, name, get: async () => Blob }] or [{ label, sub, url }]. */
async function dvLib() {
  if (window.PDFLib) return window.PDFLib;
  await new Promise((ok, no) => {
    const s = el('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js' });
    s.onload = ok; s.onerror = () => no(new Error('pdf-lib')); document.head.append(s);
  });
  return window.PDFLib;
}
// A file of a private bucket, read with the signed-in person's rights.
async function dvStored(bucket, path) {
  const tok = await authToken();
  const r = await fetch(`${CFG.url}/storage/v1/object/authenticated/${bucket}/${String(path).split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: CFG.key, Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
  return r.blob();
}
// By the file's extension first (a stored file may come back with a generic type), else by its type.
function dvKind(blob, name) {
  const x = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
  if (x) return /^pdf$/i.test(x) ? 'pdf' : /^(png|jpe?g)$/i.test(x) ? 'img' : /^(webp|gif|bmp)$/i.test(x) ? 'img2' : 'other';
  return /pdf/i.test(blob.type) ? 'pdf' : /image\/(png|jpe?g)/i.test(blob.type) ? 'img' : /^image\//i.test(blob.type) ? 'img2' : 'other';
}
function dvSave(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = el('a', { href: u, download: name || 'file' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
// A picture the PDF cannot take as it is (webp, gif…): redrawn as PNG.
async function dvPng(blob) {
  const u = URL.createObjectURL(blob);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image')); i.src = u; });
    const c = el('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
  } finally { URL.revokeObjectURL(u); }
}
// One stored file in the viewer (the links of the tendering and payment screens).
const dvFile = (f, bucket) => dvOpen(f.name || 'file', [{ label: f.name || 'file', name: f.name, get: () => dvStored(bucket, f.path) }]);

async function dvOpen(title, items) {
  $('#dvWin')?.remove();
  const list = el('ol', { className: 'dvlist' });
  const stage = el('div', { className: 'dvstage' }, el('div', { className: 'dim dvwait', textContent: t('dv.loading') }));
  const info = el('span', { className: 'dim dvinfo' });
  const dl = el('button', { className: 'btn tiny', type: 'button', textContent: '⬇ ' + t('dv.download'), disabled: true });
  const close = el('button', { className: 'dbtn', type: 'button', textContent: '✕', title: t('pm.prj.close') });
  const win = el('div', { id: 'dvWin', className: 'capprev dvwin', role: 'dialog', 'aria-label': title }, [
    el('div', { className: 'dhead' }, [el('h2', { textContent: title }), info, el('span', { style: 'flex:1' }), dl, close]),
    el('div', { className: 'dvbody' + (items.length > 1 ? '' : ' one') }, [el('div', { className: 'dvside' }, list), stage])]);
  let url = null, gone = false;
  const esc = e => { if (e.key === 'Escape') shut(); };
  const shut = () => { gone = true; win.remove(); if (url) URL.revokeObjectURL(url); document.removeEventListener('keydown', esc); };
  close.onclick = shut;
  document.addEventListener('keydown', esc);
  document.body.append(win);
  const rows = items.map(it => {
    const li = el('li', { className: 'wait' }, [el('b', { textContent: it.label }), it.sub ? el('small', { className: 'dim', textContent: it.sub }) : '',
      el('small', { className: 'dvst dim', textContent: t('dv.loading') })]);
    list.append(li);
    return li;
  });
  // A new frame for each jump: the browser's viewer opens the merged file at that page.
  const show = page => {
    stage.innerHTML = '';
    stage.append(el('iframe', { src: `${url}#page=${page}&view=FitH`, title }));
    for (const r of rows) r.classList.toggle('on', Number(r.dataset.page) === page);
  };
  try {
    const L = await dvLib();
    const out = await L.PDFDocument.create();
    const blobs = [];
    for (let i = 0; i < items.length && !gone; i++) {
      const it = items[i], li = rows[i], st = li.querySelector('.dvst');
      const off = text => { st.textContent = text; li.classList.remove('wait'); li.classList.add('off'); };
      if (it.url) {
        off(t('dv.link'));
        li.append(el('a', { className: 'btn tiny', href: it.url, target: '_blank', rel: 'noopener noreferrer', textContent: '↗', title: t('dv.openLink') }));
        continue;
      }
      try {
        const blob = await it.get();
        if (!blob) { off(t('dv.none')); continue; }
        blobs[i] = blob;
        li.append(el('button', { className: 'btn tiny', type: 'button', textContent: '⬇', title: t('dv.downloadOne'),
          onclick: e => { e.stopPropagation(); dvSave(blob, it.name || it.label); } }));
        const k = dvKind(blob, it.name), from = out.getPageCount() + 1;
        if (k === 'pdf') {
          const src = await L.PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { ignoreEncryption: true });
          for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
        } else if (k === 'img' || k === 'img2') {
          // A photo or a scan: a page of its own, portrait or landscape as the picture.
          const png = k === 'img2' || /png/i.test(blob.type) || /\.png$/i.test(it.name || '');
          const bytes = k === 'img2' ? await dvPng(blob) : new Uint8Array(await blob.arrayBuffer());
          const im = png ? await out.embedPng(bytes) : await out.embedJpg(bytes);
          const land = im.width > im.height, W = land ? 841.89 : 595.28, H = land ? 595.28 : 841.89, m = 18;
          const s = Math.min((W - 2 * m) / im.width, (H - 2 * m) / im.height);
          out.addPage([W, H]).drawImage(im, { x: (W - im.width * s) / 2, y: (H - im.height * s) / 2, width: im.width * s, height: im.height * s });
        } else { off(t('dv.noPreview')); continue; }
        const to = out.getPageCount();
        li.dataset.page = String(from);
        li.classList.remove('wait');
        st.textContent = to > from ? t('dv.pages', { a: from, b: to }) : t('dv.page', { a: from });
        li.onclick = () => { if (url) show(from); };
      } catch (e) { off(t('dv.fail', { e: (e && e.message) || e })); }
    }
    if (gone) return;
    const n = out.getPageCount();
    if (!n) { stage.innerHTML = ''; stage.append(el('div', { className: 'dim dvwait', textContent: t('dv.nothing') })); return; }
    const merged = new Blob([await out.save()], { type: 'application/pdf' });
    url = URL.createObjectURL(merged);
    info.textContent = items.length > 1 ? t('dv.total', { n: items.length, p: n }) : t('dv.nPages', { p: n });
    // One file: the original is downloaded; several: the merged PDF.
    const one = items.length === 1 && blobs[0];
    dl.disabled = false;
    dl.onclick = () => one ? dvSave(one, items[0].name || items[0].label) : dvSave(merged, title.replace(/[\\/:*?"<>|]/g, '-') + '.pdf');
    show(1);
  } catch (e) { stage.innerHTML = ''; stage.append(el('div', { className: 'msg err', textContent: (e && e.message) || String(e) })); }
}
