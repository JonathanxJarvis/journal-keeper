/* The screens: Journals (shelf, search), one journal (read / arrange),
   Timeline (every journal in date order), Scan, Settings, and the page details editor. */

const ui = {
  tab: 'library',
  journalId: null,        // journal open in the journal view ('*' = pages saved for the book)
  mode: 'read',           // 'read' | 'arrange'
  pageList: [],           // pages the details editor steps through with ‹ ›
  pageBack: 'library',    // where the details editor returns to
  tlHidden: new Set(),    // journals switched off in the timeline
  sortable: null,
};
let journalReader, timelineReader;

/* ---------- sections ---------- */
const TAB_OF = { library: 'library', journal: 'library', timeline: 'timeline', scan: 'scan', settings: 'settings', page: null, adjust: 'scan' };

function showTab(name) {
  if (state.currentId) savePage({ quiet: true });
  state.currentId = null;
  ui.tab = name;
  showView(name);
  paintTabs(name);
  if (name === 'library') renderLibrary();
  else if (name === 'timeline') renderTimeline();
  else if (name === 'scan') renderScan();
  else if (name === 'settings') { renderStats(); showSpent(); }
}
function paintTabs(view) {
  const t = TAB_OF[view] || ui.tab;
  for (const b of $$('.tab')) b.classList.toggle('on', b.dataset.tab === t);
}

/* ---------- Journals (shelf + search) ---------- */
function filtering() {
  const f = state.filters;
  return !!(state.query.trim() || f.journal || f.year || f.tags.size || f.review || f.star);
}

function statusBadge(p) {
  if (p.ocr && p.ocr.status === 'waiting') return `<span class="badge busy">${p.ocr.note ? 'Paused, see Settings' : 'Waiting to be read'}</span>`;
  if (p.ocr && p.ocr.status === 'reading') return `<span class="badge busy">${esc(readProgress.get(p.id) || 'Being read…')}</span>`;
  if (p.ocr && p.ocr.status === 'error') return '<span class="badge warn">Could not read</span>';
  return '';
}

function itemHTML(r) {
  const p = r.p;
  const j = journalById(p.journalId);
  const badges = [statusBadge(p)];
  if (p.starred) badges.push('<span class="badge star">★ For the book</span>');
  for (const t of (p.tags || []).slice(0, 4)) badges.push(`<span class="badge">${esc(t)}</span>`);
  const title = p.title ? highlight(p.title, r.hits) : '<span class="muted">Untitled page</span>';
  const snip = snippet(p, r.hits);
  return `<li><button class="item" data-id="${esc(p.id)}" style="--jc:${j ? j.color : '#888'}">
    <img src="${thumbURL(p)}" alt="" loading="lazy">
    <span class="item-body">
      <span class="item-title">${title}</span>
      <span class="item-meta"><i class="dot"></i>${esc(journalName(p.journalId))}, page ${p.seq} · ${esc(placeOf(p).label)}</span>
      ${snip ? `<span class="item-snip">${snip}</span>` : ''}
      <span class="badges">${badges.join('')}</span>
    </span>
  </button></li>`;
}

function journalCardHTML(j) {
  const pages = pagesOf(j.id);
  const span = Chrono.span(pages, state.chrono);
  const waiting = pages.filter((p) => p.ocr && (p.ocr.status === 'waiting' || p.ocr.status === 'reading')).length;
  const undated = pages.filter((p) => placeOf(p).kind === 'none').length;
  const cover = pages[0] ? `<img src="${thumbURL(pages[0])}" alt="" loading="lazy">` : '';
  return `<li><button class="jcard" data-id="${esc(j.id)}" style="--jc:${j.color}">
    <span class="jcover">${cover}<span class="jspine"></span><span class="jlabel">${esc(j.name)}</span></span>
    <span class="jinfo">
      <span class="jname">${esc(j.name)}</span>
      <span class="jspan">${span ? esc(span) : 'No dates yet'}</span>
      <span class="muted">${pages.length} page${pages.length === 1 ? '' : 's'}${waiting ? ` · ${waiting} being read` : ''}${undated && undated === pages.length && pages.length ? '' : ''}</span>
    </span>
  </button></li>`;
}

function renderLibrary() {
  const searching = filtering();
  $('#results-wrap').hidden = !searching;
  $('#shelf-wrap').hidden = searching;
  renderFilterOptions();
  if (searching) {
    state.results = searchPages();
    const n = state.results.length;
    $('#list').innerHTML = n
      ? state.results.slice(0, 400).map(itemHTML).join('')
      : '<li class="empty"><p class="empty-title">Nothing found</p><p>Try fewer words, or clear the filters.</p></li>';
    $('#result-count').textContent = `${n} page${n === 1 ? '' : 's'} found${n > 400 ? ' (showing the first 400)' : ''}`;
    $('#btn-pdf-results').hidden = !n;
    return;
  }
  const js = sortedJournals();
  const starred = state.pages.filter((p) => p.starred).length;
  let html = js.map(journalCardHTML).join('');
  if (starred) {
    html += `<li><button class="jcard book" data-id="*" style="--jc:#b4532a">
      <span class="jcover"><span class="jspine"></span><span class="jlabel">For the book</span></span>
      <span class="jinfo"><span class="jname">For the book</span><span class="jspan">Pages you starred</span><span class="muted">${starred} page${starred === 1 ? '' : 's'}, in date order</span></span>
    </button></li>`;
  }
  $('#shelf').innerHTML = html;
  $('#empty').hidden = js.length > 0;
}

function renderFilterOptions() {
  const f = state.filters;
  const years = [...new Set(state.pages.map(yearOf).filter(Boolean))].sort();
  const tagCount = new Map();
  for (const p of state.pages) for (const t of p.tags || []) {
    const k = t.toLowerCase();
    tagCount.set(k, (tagCount.get(k) || 0) + 1);
  }
  $('#f-journal').innerHTML = '<option value="">All journals</option>' +
    sortedJournals().map((j) => `<option value="${esc(j.id)}"${j.id === f.journal ? ' selected' : ''}>${esc(j.name)}</option>`).join('');
  $('#f-year').innerHTML = '<option value="">Any year</option>' + years.map((y) => `<option${y === f.year ? ' selected' : ''}>${y}</option>`).join('');
  const tags = [...tagCount.keys()].sort();
  $('#f-tags').innerHTML = tags.length
    ? tags.map((t) => `<button class="chip${f.tags.has(t) ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${f.tags.has(t)}">${esc(t)} (${tagCount.get(t)})</button>`).join('')
    : '<span class="muted small">Topics Claude finds, and tags you add, show up here.</span>';
}

/* ---------- One journal ---------- */
function journalPages(id) {
  if (id === '*') return timelineOrder(state.pages.filter((p) => p.starred));
  return pagesOf(id);
}

function openJournal(id, startPageId) {
  ui.journalId = id;
  const book = id === '*';
  const j = book ? { name: 'For the book', color: '#b4532a' } : journalById(id);
  if (!j) return showTab('library');
  const pages = journalPages(id);
  $('#jr-name').textContent = j.name;
  $('#jr-swatch').style.background = j.color;
  const span = Chrono.span(pages, state.chrono);
  $('#jr-meta').textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}${span ? ' · ' + span : ''}`;
  $('#jr-edit').hidden = book;
  $$('#view-journal .seg-btn')[1].hidden = book;
  if (book) ui.mode = 'read';
  showView('journal');
  paintTabs('journal');
  setMode(ui.mode, startPageId);
}

function setMode(mode, startPageId) {
  ui.mode = mode;
  for (const b of $$('#view-journal .seg-btn')) b.classList.toggle('on', b.dataset.mode === mode);
  $('#jr-reader').hidden = mode !== 'read';
  $('#jr-arrange').hidden = mode !== 'arrange';
  const pages = journalPages(ui.journalId);
  if (mode === 'read') {
    journalReader.show(pages, startPageId);
    journalReader.focus();
  } else {
    renderArrange(pages);
  }
}

function arrangeItemHTML(p, i) {
  const place = placeOf(p);
  return `<li class="tile" data-id="${esc(p.id)}">
    <label class="tile-check"><input type="checkbox" aria-label="Tick page ${i + 1}"></label>
    <img src="${thumbURL(p)}" alt="" loading="lazy" draggable="false">
    <span class="tile-no">${i + 1}</span>
    <span class="tile-date ${place.kind}${place.odd ? ' odd' : ''}">${esc(place.short)}</span>
  </li>`;
}

function renderArrange(pages) {
  const list = $('#arrange');
  list.innerHTML = pages.map(arrangeItemHTML).join('');
  $('#ar-target').innerHTML = '<option value="">Move ticked pages to…</option>' +
    sortedJournals().filter((j) => j.id !== ui.journalId).map((j) => `<option value="${esc(j.id)}">${esc(j.name)}</option>`).join('');
  updateTicks();
  if (ui.sortable) ui.sortable.destroy();
  if (window.Sortable) {
    ui.sortable = Sortable.create(list, {
      animation: 150,
      delay: 180, delayOnTouchOnly: true,     // on a phone: press and hold, then drag
      filter: '.tile-check', preventOnFilter: false,
      onEnd: saveArrangeOrder,
    });
  }
}

async function saveArrangeOrder() {
  const ids = $$('#arrange .tile').map((li) => li.dataset.id);
  const changed = [];
  ids.forEach((id, i) => {
    const p = state.pages.find((x) => x.id === id);
    if (p && p.seq !== i + 1) { p.seq = i + 1; p.updated = Date.now(); changed.push(stored(p)); }
  });
  if (!changed.length) return;
  await DB.putPages(changed);
  recompute();
  // refresh numbers and in-between dates in place
  $$('#arrange .tile').forEach((li, i) => {
    const p = state.pages.find((x) => x.id === li.dataset.id);
    const place = placeOf(p);
    li.querySelector('.tile-no').textContent = i + 1;
    const d = li.querySelector('.tile-date');
    d.textContent = place.short;
    d.className = `tile-date ${place.kind}${place.odd ? ' odd' : ''}`;
  });
  toast('New page order saved');
}

function updateTicks() {
  const n = $$('#arrange input:checked').length;
  $('#ar-count').textContent = n ? `${n} ticked` : 'None ticked';
  $('#ar-move').disabled = !n || !$('#ar-target').value;
}

async function moveTicked() {
  const target = $('#ar-target').value;
  const ids = $$('#arrange .tile').filter((li) => li.querySelector('input').checked).map((li) => li.dataset.id);
  if (!target || !ids.length) return;
  const changed = [];
  for (const id of ids) {
    const p = state.pages.find((x) => x.id === id);
    p.seq = nextSeq(target);
    p.journalId = target;
    p.updated = Date.now();
    changed.push(stored(p));
  }
  // close the gap left behind
  pagesOf(ui.journalId).forEach((p, i) => { if (p.seq !== i + 1) { p.seq = i + 1; changed.push(stored(p)); } });
  await DB.putPages(changed);
  recompute();
  toast(`Moved ${ids.length} page${ids.length === 1 ? '' : 's'} to ${journalName(target)}`);
  openJournal(ui.journalId);
}

/* ---------- Journal name & colour dialog ---------- */
let dlgJournal = null;
function journalDialog(j, after) {
  dlgJournal = j;
  $('#jdlg-title').textContent = j ? 'Rename journal' : 'New journal';
  $('#jdlg-name').value = j ? j.name : '';
  const current = j ? j.color : JOURNAL_COLORS[state.journals.length % JOURNAL_COLORS.length];
  $('#jdlg-colors').innerHTML = JOURNAL_COLORS.map((c) =>
    `<button type="button" class="swatch-btn${c === current ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="Colour ${c}" aria-pressed="${c === current}"></button>`).join('');
  const count = j ? pagesOf(j.id).length : 0;
  $('#jdlg-delete').hidden = !j;
  $('#jdlg-delete').textContent = count ? `Delete this journal (move its ${count} pages first)` : 'Delete this journal';
  $('#jdlg-delete').disabled = count > 0;
  $('#jdlg').hidden = false;
  $('#jdlg-name').focus();
  $('#jdlg').onsubmit = null;
  $('#jdlg-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#jdlg-name').value.trim();
    if (!name) return;
    const color = ($('#jdlg-colors .on') || {}).dataset?.c || current;
    let out = j;
    if (j) { j.name = name; j.color = color; await DB.putJournal(j); }
    else out = await addJournal(name, color);
    $('#jdlg').hidden = true;
    if (after) after(out);
  };
}

/* ---------- Timeline ---------- */
function renderTimeline(startId) {
  const js = sortedJournals();
  $('#tl-journals').innerHTML = js.map((j) =>
    `<button class="chip jchip${ui.tlHidden.has(j.id) ? '' : ' on'}" data-id="${esc(j.id)}" style="--jc:${j.color}" aria-pressed="${!ui.tlHidden.has(j.id)}"><i class="dot"></i>${esc(j.name)}</button>`).join('');
  const pages = timelineOrder(state.pages.filter((p) => !ui.tlHidden.has(p.journalId)));
  timelineReader.show(pages, startId || timelineReader.currentId());
  timelineReader.focus();
}

/* ---------- Scan ---------- */
function rememberScanJournal(id) {
  state.scanJournal = id;
  try { localStorage.setItem('jk-scan-journal', id); } catch { /* not important */ }
}

function renderScan() {
  const js = sortedJournals();
  if (!journalById(state.scanJournal)) state.scanJournal = js.length ? js[0].id : '';
  $('#scan-journals').innerHTML = js.length
    ? js.map((j) => `<button class="jpick${j.id === state.scanJournal ? ' on' : ''}" data-id="${esc(j.id)}" style="--jc:${j.color}" aria-pressed="${j.id === state.scanJournal}">
        <i class="dot"></i><span>${esc(j.name)}</span><span class="muted small">${pagesOf(j.id).length} pages</span></button>`).join('')
    : '<p class="muted">Add a journal first, for example "Red journal".</p>';
  const j = journalById(state.scanJournal);
  const last = j ? pagesOf(j.id).slice(-1)[0] : null;
  $('#scan-where').textContent = !j ? 'Choose or add a journal above first.'
    : last ? `New pages go after page ${last.seq} of ${j.name} (${lowerFirst(placeOf(last))}).`
      : `These will be the first pages of ${j.name}.`;
  for (const b of ['#btn-scan', '#btn-pick']) $(b).disabled = !j;
  renderScanStatus();
}

function lowerFirst(place) {
  if (place.kind === 'dated') return 'dated ' + place.label;
  return place.label.charAt(0).toLowerCase() + place.label.slice(1);
}

function renderScanStatus() {
  if ($('#view-scan').hidden) return;
  const waiting = state.pages.filter((p) => p.ocr && (p.ocr.status === 'waiting' || p.ocr.status === 'reading'));
  const paused = waiting.find((p) => p.ocr.note);
  const failed = state.pages.filter((p) => p.ocr && p.ocr.status === 'error').length;
  $('#scan-status').textContent = !ClaudeReader.ready()
    ? 'Add your Claude API key in Settings first. Pages you scan now will wait and be read once it is added.'
    : paused ? paused.ocr.note
      : waiting.length ? `Claude is reading: ${waiting.length} page${waiting.length === 1 ? '' : 's'} to go. You can keep scanning.`
        : `All pages are typed up.${failed ? ` ${failed} could not be read; open them to try again.` : ''}`;
  const recent = state.journals.length ? pagesOf(state.scanJournal).slice(-12).reverse() : [];
  $('#scan-recent').innerHTML = recent.map((p) => `<li><button class="strip-item" data-id="${esc(p.id)}">
      <img src="${thumbURL(p)}" alt="Page ${p.seq}" loading="lazy"><span>Page ${p.seq}</span>${statusBadge(p) || `<span class="badge">${esc(placeOf(p).short)}</span>`}</button></li>`).join('');
}

// Photos are added in the order they were taken (file names count up: IMG_0001, IMG_0002…)
function inTakenOrder(files) {
  return Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.lastModified - b.lastModified);
}

/* ---------- Page details ---------- */
let pageImgURL = null;

async function openPage(id, list, back) {
  const p = state.pages.find((x) => x.id === id);
  if (!p) return;
  if (state.currentId && state.currentId !== id) await savePage({ quiet: true });
  state.currentId = id;
  ui.pageList = (list || pagesOf(p.journalId)).map((x) => x.id);
  if (back) ui.pageBack = back;
  $('#pg-confirm').hidden = true;
  fillPageForm(p);
  showView('page');
  paintTabs('page');
  const img = await DB.getImage(id);
  if (pageImgURL) URL.revokeObjectURL(pageImgURL);
  pageImgURL = img ? URL.createObjectURL(img) : '';
  $('#pg-img').src = pageImgURL || thumbURL(p);
}

function fillPageForm(p) {
  const note = $('#pg-ocr-note');
  note.className = 'note';
  if (p.ocr && (p.ocr.status === 'waiting' || p.ocr.status === 'reading')) {
    note.className = 'note info';
    note.textContent = p.ocr.status === 'waiting' && p.ocr.note
      ? p.ocr.note
      : 'Claude is reading this page. The words will appear below in a moment. You can fill in the other details now.';
    note.hidden = false;
  } else if (p.ocr && p.ocr.status === 'error') {
    note.textContent = `${p.ocr.note || 'This page could not be read.'} You can type the words below, or tap "Read this page again".`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  const i = ui.pageList.indexOf(p.id);
  $('#pg-heading').textContent = `${journalName(p.journalId)}, page ${p.seq}`;
  $('#pg-prev').disabled = i <= 0;
  $('#pg-next').disabled = i < 0 || i >= ui.pageList.length - 1;
  $('#pg-journal').innerHTML = sortedJournals().map((j) => `<option value="${esc(j.id)}"${j.id === p.journalId ? ' selected' : ''}>${esc(j.name)}</option>`).join('');
  $('#pg-date').value = p.dateWritten ? Chrono.format(p.dateWritten) : '';
  dateHint(p);
  $('#pg-text').value = p.text || '';
  $('#pg-title').value = p.title || '';
  $('#pg-tags').value = (p.tags || []).join(', ');
  $('#pg-reviewed').checked = !!p.reviewed;
  $('#pg-star').checked = !!p.starred;
}

function dateHint(p) {
  const typed = $('#pg-date').value.trim();
  const hint = $('#pg-date-hint');
  if (typed && !Chrono.normalize(typed)) { hint.textContent = 'Not sure what date that is. Try "12 June 1984", "June 1984" or "1984".'; hint.className = 'tip warn-text'; return; }
  hint.className = 'tip';
  const place = placeOf(p);
  hint.textContent = !typed && place.kind !== 'dated' && place.kind !== 'none'
    ? `No date written. Its place: ${lowerFirst(place)}.`
    : place.odd ? 'This date is earlier than a date before it in the journal. Check the date or the page order.' : '';
}

async function savePage({ quiet = false } = {}) {
  const p = state.pages.find((x) => x.id === state.currentId);
  if (!p) return;
  const typed = $('#pg-date').value.trim();
  const date = typed ? Chrono.normalize(typed) : '';
  p.title = $('#pg-title').value.trim();
  if (!typed || date) p.dateWritten = date;
  p.tags = parseTags($('#pg-tags').value);
  p.text = $('#pg-text').value;
  p.reviewed = $('#pg-reviewed').checked;
  p.starred = $('#pg-star').checked;
  const jid = $('#pg-journal').value;
  if (jid && jid !== p.journalId) {
    const from = p.journalId;
    p.journalId = jid;
    p.seq = nextSeq(jid);
    const gap = pagesOf(from);
    gap.forEach((x, i) => { x.seq = i + 1; });
    await DB.putPages(gap.map(stored));
  }
  p.updated = Date.now();
  await DB.putPage(stored(p));
  recompute();
  if (!quiet) toast('Saved');
}

async function leavePage() {
  await savePage({ quiet: true });
  const p = state.pages.find((x) => x.id === state.currentId);
  state.currentId = null;
  if (ui.pageBack === 'journal' && ui.journalId && (ui.journalId === '*' || journalById(ui.journalId))) openJournal(ui.journalId, p && p.id);
  else if (ui.pageBack === 'timeline') { showView('timeline'); paintTabs('timeline'); ui.tab = 'timeline'; renderTimeline(p && p.id); }
  else showTab(ui.pageBack || 'library');
}

async function stepPage(d) {
  const i = ui.pageList.indexOf(state.currentId);
  const next = ui.pageList[i + d];
  if (!next) return;
  await savePage({ quiet: true });
  openPage(next, ui.pageList.map((id) => state.pages.find((x) => x.id === id)).filter(Boolean));
}

async function toggleStar(p) {
  p.starred = !p.starred;
  p.updated = Date.now();
  await DB.putPage(stored(p));
  toast(p.starred ? 'Saved for the book' : 'Removed from the book');
  hooks.pageChanged(p.id);
}

/* ---------- Claude settings ---------- */
function claudeNote(msg) { const n = $('#claude-note'); n.textContent = msg; n.hidden = !msg; }
function showSpent() {
  const s = ClaudeReader.spent();
  $('#claude-spent').textContent = s.pages
    ? `Read by Claude on this device so far: ${s.pages} page${s.pages === 1 ? '' : 's'}, about $${s.usd.toFixed(2)} (average ${(100 * s.usd / s.pages).toFixed(1)} cents a page).`
    : 'No pages read by Claude yet.';
}

/* ---------- background changes ---------- */
let redrawT;
hooks.pageChanged = (id) => {
  if (!id) return hooks.pagesChanged();
  if (journalReader && journalReader.has(id)) journalReader.refresh(id);
  if (timelineReader && timelineReader.has(id)) timelineReader.refresh(id);
  const btn = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  const p = state.pages.find((x) => x.id === id);
  if (btn && p) btn.parentElement.outerHTML = itemHTML({ p, hits: [] });
  renderScanStatus();
  if (state.currentId === id && p && !$('#view-page').hidden && document.activeElement && !document.activeElement.closest('#view-page .form')) fillPageForm(p);
};
hooks.pagesChanged = () => {
  clearTimeout(redrawT);
  redrawT = setTimeout(() => {
    if (!$('#view-library').hidden) renderLibrary();
    if (!$('#view-scan').hidden) renderScan();
  }, 100);
};

/* ---------- wiring ---------- */
function wire() {
  journalReader = createReader($('#jr-reader'), {
    onDetails: (p, list) => openPage(p.id, list, 'journal'),
    onStar: toggleStar,
    empty: 'No pages in this journal yet. Add some in <b>Scan</b>.',
  });
  timelineReader = createReader($('#tl-reader'), {
    onDetails: (p, list) => openPage(p.id, list, 'timeline'),
    onStar: toggleStar,
    showJournal: true,
    empty: 'No pages yet. Scan some pages first.',
  });

  for (const b of $$('.tab')) b.onclick = () => showTab(b.dataset.tab);

  // Journals shelf
  $('#shelf').addEventListener('click', (e) => {
    const b = e.target.closest('.jcard');
    if (b) openJournal(b.dataset.id);
  });
  $('#btn-new-journal').onclick = () => journalDialog(null, () => renderLibrary());
  $('#btn-sample').onclick = async () => {
    if (!state.journals.length) rememberScanJournal((await addJournal('Sample journal')).id);
    startAdjust([await samplePhoto()]);
  };

  // Search
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.query = e.target.value; renderLibrary(); }, 150);
  });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (!b) return;
    const p = state.pages.find((x) => x.id === b.dataset.id);
    if (p) openJournal(p.journalId, p.id);
  });
  $('#btn-filters').onclick = () => {
    const f = $('#filters');
    f.hidden = !f.hidden;
    $('#btn-filters').setAttribute('aria-expanded', String(!f.hidden));
  };
  $('#f-journal').onchange = (e) => { state.filters.journal = e.target.value; renderLibrary(); };
  $('#f-year').onchange = (e) => { state.filters.year = e.target.value; renderLibrary(); };
  $('#f-sort').onchange = (e) => { state.filters.sort = e.target.value; renderLibrary(); };
  $('#f-review').onchange = (e) => { state.filters.review = e.target.checked; renderLibrary(); };
  $('#f-star').onchange = (e) => { state.filters.star = e.target.checked; renderLibrary(); };
  $('#f-tags').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const t = c.dataset.tag;
    if (state.filters.tags.has(t)) state.filters.tags.delete(t); else state.filters.tags.add(t);
    renderLibrary();
  });
  $('#btn-clear-filters').onclick = () => {
    Object.assign(state.filters, { journal: '', year: '', review: false, star: false });
    state.filters.tags.clear();
    $('#f-review').checked = false; $('#f-star').checked = false;
    renderLibrary();
  };
  $('#btn-pdf-results').onclick = () => {
    const name = state.query.trim() ? `Journals - ${state.query.replace(/"/g, '')}` : 'Journals - selected pages';
    exportPDF(state.results.map((r) => r.p), name);
  };

  // One journal
  $('#jr-back').onclick = () => showTab('library');
  for (const b of $$('#view-journal .seg-btn')) b.onclick = () => setMode(b.dataset.mode);
  $('#jr-edit').onclick = () => {
    const j = journalById(ui.journalId);
    if (j) journalDialog(j, () => openJournal(j.id));
  };
  $('#arrange').addEventListener('change', updateTicks);
  $('#ar-target').onchange = updateTicks;
  $('#ar-move').onclick = moveTicked;
  $('#arrange').addEventListener('dblclick', (e) => {
    const li = e.target.closest('.tile');
    if (li) openPage(li.dataset.id, journalPages(ui.journalId), 'journal');
  });
  $('#jr-pdf').onclick = () => exportPDF(journalPages(ui.journalId), journalName(ui.journalId));

  // Journal dialog
  $('#jdlg-colors').addEventListener('click', (e) => {
    const b = e.target.closest('.swatch-btn');
    if (!b) return;
    for (const x of $$('#jdlg-colors .swatch-btn')) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); }
  });
  $('#jdlg-cancel').onclick = () => { $('#jdlg').hidden = true; };
  $('#jdlg-delete').onclick = async () => {
    if (!dlgJournal || pagesOf(dlgJournal.id).length) return;
    await DB.deleteJournal(dlgJournal.id);
    state.journals = state.journals.filter((j) => j.id !== dlgJournal.id);
    $('#jdlg').hidden = true;
    toast('Journal deleted');
    showTab('library');
  };

  // Timeline
  $('#tl-journals').addEventListener('click', (e) => {
    const c = e.target.closest('.jchip');
    if (!c) return;
    const id = c.dataset.id;
    if (ui.tlHidden.has(id)) ui.tlHidden.delete(id); else ui.tlHidden.add(id);
    renderTimeline();
  });

  // Scan
  $('#scan-journals').addEventListener('click', (e) => {
    const b = e.target.closest('.jpick');
    if (!b) return;
    rememberScanJournal(b.dataset.id);
    renderScan();
  });
  $('#scan-new-journal').onclick = () => journalDialog(null, (j) => { rememberScanJournal(j.id); renderScan(); });
  $('#btn-scan').onclick = () => $('#in-camera').click();
  $('#btn-pick').onclick = () => $('#in-photos').click();
  for (const id of ['#in-camera', '#in-photos']) {
    $(id).addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length) startAdjust(inTakenOrder(files));
      e.target.value = '';
    });
  }
  const dz = $('#dropzone');
  const scanView = $('#view-scan');
  scanView.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  scanView.addEventListener('dragleave', (e) => { if (!scanView.contains(e.relatedTarget)) dz.classList.remove('over'); });
  scanView.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (!journalById(state.scanJournal)) { toast('Choose which journal these pages are from first.'); return; }
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) startAdjust(inTakenOrder(files));
  });
  $('#scan-recent').addEventListener('click', (e) => {
    const b = e.target.closest('.strip-item');
    if (b) openPage(b.dataset.id, pagesOf(state.scanJournal), 'scan');
  });

  // Adjust (crop and turn each new photo)
  setupCropHandles();
  $('#adj-rotate').onclick = () => {
    adjust.turns = (adjust.turns + 1) % 4;
    const r = adjust.rect; // turn the crop box with the page
    adjust.rect = { x0: 1 - r.y1, y0: r.x0, x1: 1 - r.y0, y1: r.x1 };
    drawAdjust();
  };
  for (const b of $$('#view-adjust .seg-btn')) {
    b.onclick = () => {
      adjust.look = b.dataset.look;
      for (const x of $$('#view-adjust .seg-btn')) x.classList.toggle('on', x === b);
      drawAdjust();
    };
  }
  $('#adj-save').onclick = async () => {
    busy('Saving page…');
    try {
      await saveAdjusted(adjust.src, adjust.turns, adjust.rect, adjust.look);
      busy(false);
      toast(adjust.queue.length ? 'Saved. Next photo…' : 'Saved. Claude is reading it now.');
      await nextInQueue();
    } catch (e) {
      console.error(e);
      busy(false);
      toast('The page could not be saved. The device may be out of space.', 5000);
    }
  };
  $('#adj-save-rest').onclick = async () => {
    try {
      await saveAdjusted(adjust.src, adjust.turns, adjust.rect, adjust.look);
      const rest = adjust.queue.splice(0);
      for (let i = 0; i < rest.length; i++) {
        busy(`Saving pages… ${i + 2} of ${rest.length + 1}`);
        const src = await loadImage(rest[i]);
        await saveAdjusted(src, 0, { x0: 0, y0: 0, x1: 1, y1: 1 }, adjust.look);
      }
      busy(false);
      toast(`Saved ${rest.length + 1} pages. Claude is reading them now.`);
    } catch (e) {
      console.error(e);
      busy(false);
      toast('Some pages could not be saved.', 4000);
    }
    showTab('scan');
  };
  $('#adj-cancel').onclick = () => { adjust.queue = []; showTab('scan'); };
  window.addEventListener('resize', () => { if (!$('#view-adjust').hidden && adjust.src) drawAdjust(); });

  // Page details
  $('#pg-back').onclick = leavePage;
  $('#pg-save').onclick = async () => { await savePage(); leavePage(); };
  $('#pg-prev').onclick = () => stepPage(-1);
  $('#pg-next').onclick = () => stepPage(1);
  $('#pg-date').addEventListener('input', () => {
    const p = state.pages.find((x) => x.id === state.currentId);
    if (p) dateHint(p);
  });
  $('#pg-pdf').onclick = async () => {
    await savePage({ quiet: true });
    const p = state.pages.find((x) => x.id === state.currentId);
    exportPDF([p], `${journalName(p.journalId)} - page ${p.seq}`);
  };
  $('#pg-reocr').onclick = async () => {
    const p = state.pages.find((x) => x.id === state.currentId);
    if (!p) return;
    await savePage({ quiet: true });
    // Replace the text only if nobody has marked it as checked
    if (!p.reviewed) { p.text = ''; $('#pg-text').value = ''; p.readText = ''; }
    p.ocr = { status: 'waiting' };
    await DB.putPage(stored(p));
    fillPageForm(p);
    OCR.enqueue(p.id);
    toast(p.reviewed ? 'Reading again. New words will be added below yours.' : 'Claude is reading the page again…');
  };
  $('#pg-delete').onclick = () => { $('#pg-confirm').hidden = false; $('#pg-confirm').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#pg-delete-no').onclick = () => { $('#pg-confirm').hidden = true; };
  $('#pg-delete-yes').onclick = async () => {
    const id = state.currentId;
    const p = state.pages.find((x) => x.id === id);
    await DB.deletePage(id);
    state.pages = state.pages.filter((x) => x.id !== id);
    if (p) { const rest = pagesOf(p.journalId); rest.forEach((x, i) => { x.seq = i + 1; }); await DB.putPages(rest.map(stored)); }
    recompute();
    state.currentId = null;
    toast('Page deleted');
    leavePage();
  };
  $('#pg-zoom').onclick = () => { $('#zoom-img').src = $('#pg-img').src; $('#zoom').hidden = false; };
  $('#pg-img').onclick = () => $('#pg-zoom').click();
  $('#zoom-close').onclick = () => { $('#zoom').hidden = true; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#zoom').hidden = true; $('#jdlg').hidden = true; } });

  // Claude reader settings
  $('#claude-key').value = ClaudeReader.key();
  $('#claude-model').value = ClaudeReader.model();
  $('#claude-hint').value = ClaudeReader.hint();
  $('#claude-model').onchange = (e) => ClaudeReader.setModel(e.target.value);
  $('#claude-hint').onchange = (e) => ClaudeReader.setHint(e.target.value);
  $('#btn-claude-save').onclick = async () => {
    ClaudeReader.setKey($('#claude-key').value);
    ClaudeReader.setHint($('#claude-hint').value);
    claudeNote('Checking the key…');
    try {
      await ClaudeReader.test();
      claudeNote('The key works. Every page you scan will now be read by Claude.');
      OCR.resume();   // read any pages that were waiting for the key
    } catch (e) {
      claudeNote(e.message);
    }
  };
  $('#btn-claude-all').onclick = async () => {
    if (!ClaudeReader.ready()) { claudeNote('Add and test your Claude API key first.'); return; }
    const todo = state.pages.filter((p) => !p.reviewed && !(p.ocr && p.ocr.engine === 'claude' && p.ocr.status === 'done'));
    if (!todo.length) { claudeNote('Every page has already been read by Claude or checked by hand.'); return; }
    const m = ClaudeReader.MODELS[ClaudeReader.model()];
    const est = todo.length * (m.inPerM * 2600 + m.outPerM * 900) / 1e6;
    claudeNote(`Reading ${todo.length} page${todo.length === 1 ? '' : 's'}, roughly $${est.toFixed(2)}. Keep the app open and online.`);
    for (const p of todo) {
      p.ocr = { status: 'waiting' };
      await DB.putPage(stored(p)).catch(() => {});
      OCR.enqueue(p.id);
    }
  };

  // Files
  $('#btn-pdf-all').onclick = () => exportPDF(timelineOrder(state.pages), 'Journals - every page in date order');
  $('#btn-text-all').onclick = () => exportText(state.pages, 'Journals - all text in date order.txt');
  $('#btn-text-star').onclick = () => exportText(state.pages.filter((p) => p.starred), 'Journals - pages for the book.txt');
  $('#btn-backup').onclick = () => makeBackup();
  $('#btn-restore').onclick = () => $('#in-restore').click();
  $('#in-restore').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) restoreBackup(f);
    e.target.value = '';
  });
  $('#version').textContent = `Journal Keeper ${APP_VERSION}. Pages are kept on this device; each photo is sent only to Claude to be read.`;

  // Save typing if the app is closed or switched away from a page
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.currentId) savePage({ quiet: true });
  });
}

async function init() {
  wire();
  try {
    const [journals, pages] = await Promise.all([DB.allJournals(), DB.allPages()]);
    state.journals = journals;
    state.pages = pages;
    await migrate();
  } catch (e) {
    console.error(e);
    toast('This browser is blocking storage. Open Journal Keeper normally, not in a private window.', 8000);
  }
  try { state.scanJournal = localStorage.getItem('jk-scan-journal') || ''; } catch { /* not important */ }
  recompute();
  showTab('library');
  OCR.resume();
  // Pages that waited for internet carry on as soon as it is back
  window.addEventListener('online', () => OCR.resume());
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Always check for a newer version, and reload once when it takes over, so updates show straight away.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded && !OCR.isBusy() && !state.currentId) { reloaded = true; location.reload(); }
    });
  }
}

init();
