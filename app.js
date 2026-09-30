/* Journal Keeper: scan handwritten journals, have Claude read them, and keep
   every page in order by journal and by date. Pages are stored on this device.
   This file holds the core (storage, scanning, reading, search, files);
   library.js draws the screens and reader-view.js the page-turning viewer. */
'use strict';

const APP_VERSION = '3.1.0';
const MAX_SIDE = 2200;      // longest edge of a stored page image, in pixels
const THUMB_SIDE = 360;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* =========================================================
   Storage (IndexedDB)
   pages:    metadata + text + small thumbnail (fast to list)
   images:   full page image, keyed by page id
   journals: the notebooks pages belong to (name, colour, order)
   ========================================================= */
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('journal-keeper', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
        // line pictures from an earlier version; no longer used, kept so older data still opens
        if (!db.objectStoreNames.contains('lines')) db.createObjectStore('lines');
        if (!db.objectStoreNames.contains('journals')) db.createObjectStore('journals', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(fn(t)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage was interrupted'));
    });
  }
  const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    allPages: () => tx(['pages'], 'readonly', (t) => req2p(t.objectStore('pages').getAll())),
    getPage: (id) => tx(['pages'], 'readonly', (t) => req2p(t.objectStore('pages').get(id))),
    putPage: (p) => tx(['pages'], 'readwrite', (t) => { t.objectStore('pages').put(p); }),
    putPages: (ps) => tx(['pages'], 'readwrite', (t) => { for (const p of ps) t.objectStore('pages').put(p); }),
    allJournals: () => tx(['journals'], 'readonly', (t) => req2p(t.objectStore('journals').getAll())),
    putJournal: (j) => tx(['journals'], 'readwrite', (t) => { t.objectStore('journals').put(j); }),
    deleteJournal: (id) => tx(['journals'], 'readwrite', (t) => { t.objectStore('journals').delete(id); }),
    getImage: (id) => tx(['images'], 'readonly', (t) => req2p(t.objectStore('images').get(id))),
    putPageWithImage: (p, img) => tx(['pages', 'images'], 'readwrite', (t) => {
      t.objectStore('pages').put(p);
      t.objectStore('images').put(img, p.id);
    }),
    deletePage: (id) => tx(['pages', 'images', 'lines'], 'readwrite', (t) => {
      t.objectStore('pages').delete(id);
      t.objectStore('images').delete(id);
      t.objectStore('lines').delete(id);
    }),
  };
})();

/* =========================================================
   App state
   ========================================================= */
const state = {
  pages: [],               // all page records (no full images)
  journals: [],            // [{ id, name, color, order, created }]
  chrono: new Map(),       // page id -> place in time (see chrono.js)
  scanJournal: '',         // journal new scans go into
  filters: { journal: '', year: '', tags: new Set(), review: false, star: false, sort: 'time-asc' },
  query: '',
  results: [],
  currentId: null,
  thumbURLs: new Map(),
};

// Screens register here to hear about changes made in the background (reading, saving).
const hooks = { pageChanged: () => {}, pagesChanged: () => {} };

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* =========================================================
   Small UI helpers
   ========================================================= */
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(msg) {
  if (msg === false) { $('#busy').hidden = true; return; }
  $('#busy-text').textContent = msg || 'Working…';
  $('#busy').hidden = false;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showView(name) {
  for (const v of $$('.view')) v.hidden = v.id !== 'view-' + name;
  window.scrollTo(0, 0);
}
function fmtDate(iso) {
  return Chrono.format(iso);
}
function parseTags(s) {
  const seen = new Set();
  return String(s || '').split(',').map((t) => t.trim()).filter((t) => {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
async function dataURLToBlob(url) {
  return (await fetch(url)).blob();
}
function canvasToBlob(canvas, type = 'image/jpeg', q = 0.85) {
  return new Promise((res) => canvas.toBlob(res, type, q));
}
function safeFileName(s) {
  return String(s || 'Journal').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Journal';
}

/* Hand a finished file to the person: the phone's share menu when it has one
   (lets them "Save to Files", email it, etc.), otherwise a download button. */
const IN_PREVIEW = (() => { try { return window.top !== window.self; } catch { return true; } })();

async function deliverFile(blob, filename) {
  if (IN_PREVIEW) {
    // Inside the claude.ai preview, files are saved through the viewer.
    const downloads = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
    if (!downloads) {
      toast('Saving files works once the app is on the phone.', 5000);
      return;
    }
    try {
      await downloads.save({ filename, data: blob });
    } catch (e) {
      if (e?.code !== 'declined') toast('The file could not be saved here. It will work once the app is on the phone.', 5000);
    }
    return;
  }
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = $('#sheet-link');
  a.href = url;
  a.download = filename;
  $('#sheet-text').textContent = `${filename} is ready.`;
  $('#sheet').hidden = false;
  $('#sheet-close').onclick = () => { $('#sheet').hidden = true; setTimeout(() => URL.revokeObjectURL(url), 60000); };
}

/* =========================================================
   Image handling: load, rotate, crop, "clean scan" look
   ========================================================= */
async function loadImage(file) {
  // createImageBitmap applies the photo's EXIF rotation in current browsers.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    return img;
  }
}

/* Draw source into a canvas, turned by quarter-turns and cropped to rect
   (rect in 0..1 fractions of the turned image), scaled so the long edge <= maxSide. */
function renderPage(src, turns, rect, maxSide) {
  const sw = src.width, sh = src.height;
  const rw = turns % 2 ? sh : sw;   // size after turning
  const rh = turns % 2 ? sw : sh;
  const turned = document.createElement('canvas');
  turned.width = rw; turned.height = rh;
  const tc = turned.getContext('2d');
  tc.translate(rw / 2, rh / 2);
  tc.rotate((turns * Math.PI) / 2);
  tc.drawImage(src, -sw / 2, -sh / 2);

  const cx = Math.round(rect.x0 * rw), cy = Math.round(rect.y0 * rh);
  const cw = Math.max(1, Math.round((rect.x1 - rect.x0) * rw));
  const ch = Math.max(1, Math.round((rect.y1 - rect.y0) * rh));
  const scale = Math.min(1, maxSide / Math.max(cw, ch));
  const out = document.createElement('canvas');
  out.width = Math.round(cw * scale); out.height = Math.round(ch * scale);
  const oc = out.getContext('2d');
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(turned, cx, cy, cw, ch, 0, 0, out.width, out.height);
  turned.width = turned.height = 0;
  return out;
}

/* "Clean scan": evens out shadows by dividing by a blurred copy of the
   page (the paper), then darkens the ink, keeping the pen colour. Makes pages easier to read and helps
   the handwriting reader. */
function cleanScan(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const bgW = Math.max(8, Math.round(w / 28)), bgH = Math.max(8, Math.round(h / 28));
  const small = document.createElement('canvas');
  small.width = bgW; small.height = bgH;
  const sc = small.getContext('2d');
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(canvas, 0, 0, bgW, bgH);
  // Soften the small copy a second time so ink strokes don't show in it
  const tiny = document.createElement('canvas');
  tiny.width = Math.max(4, bgW >> 2); tiny.height = Math.max(4, bgH >> 2);
  tiny.getContext('2d').drawImage(small, 0, 0, tiny.width, tiny.height);
  sc.drawImage(tiny, 0, 0, bgW, bgH);
  const big = document.createElement('canvas');
  big.width = w; big.height = h;
  const bc = big.getContext('2d');
  bc.imageSmoothingQuality = 'high';
  bc.drawImage(small, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const bg = bc.getImageData(0, 0, w, h).data;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Each colour channel divided by the paper's own colour: paper turns white,
    // shadows vanish, and blue or black ink keeps its colour.
    for (let c = 0; c < 3; c++) {
      let v = Math.min(1, d[i + c] / Math.max(bg[i + c] * 0.94, 1));
      v = Math.pow(v, 1.8);
      d[i + c] = v > 0.95 ? 255 : Math.round(v * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  big.width = big.height = 0;
  return canvas;
}

function makeThumb(canvas) {
  const s = Math.min(1, THUMB_SIDE / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.round(canvas.width * s); t.height = Math.round(canvas.height * s);
  const c = t.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(canvas, 0, 0, t.width, t.height);
  return canvasToBlob(t, 'image/jpeg', 0.75);
}

/* =========================================================
   Adjust screen (turn, crop, look) for newly scanned photos
   ========================================================= */
const adjust = {
  queue: [], src: null, turns: 0, rect: null, look: 'clean', dragging: null,
};

async function startAdjust(files) {
  adjust.queue = Array.from(files).filter((f) => f.type.startsWith('image/') || !f.type);
  if (!adjust.queue.length) return;
  await nextInQueue();
}

async function nextInQueue() {
  const file = adjust.queue.shift();
  if (!file) { showTab('scan'); return; }
  busy('Opening photo…');
  try {
    adjust.src = await loadImage(file);
  } catch {
    busy(false);
    toast('That photo could not be opened. Try taking it again.');
    return nextInQueue();
  }
  busy(false);
  adjust.turns = 0;
  adjust.rect = { x0: 0, y0: 0, x1: 1, y1: 1 };   // whole photo, so no writing is cut off
  const left = adjust.queue.length;
  $('#adj-title').textContent = left ? `Adjust the page (${left} more after this)` : 'Adjust the page';
  $('#adj-save').textContent = left ? 'Save this one, adjust the next' : 'Save page';
  $('#adj-save').className = left ? 'btn ghost' : 'btn primary big';
  $('#adj-save-rest').textContent = `Save all ${left + 1} as they are`;
  $('#adj-save-rest').className = 'btn primary big';
  $('#adj-save-rest').hidden = !left;
  showView('adjust');
  drawAdjust();
}

function drawAdjust() {
  const src = adjust.src;
  const cv = $('#adj-canvas');
  const turned = adjust.turns % 2 === 1;
  const w = turned ? src.height : src.width;
  const h = turned ? src.width : src.height;
  // Preview size: fit the stage width and at most ~60% of screen height
  const stage = $('#crop-stage');
  const maxW = Math.min(stage.parentElement.clientWidth, 728);
  const maxH = window.innerHeight * 0.6;
  const s = Math.min(maxW / w, maxH / h);
  const pw = Math.round(w * s), ph = Math.round(h * s);
  stage.style.width = pw + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(pw * dpr); cv.height = Math.round(ph * dpr);
  cv.style.width = pw + 'px'; cv.style.height = ph + 'px';
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.scale(cv.width / w, cv.height / h);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((adjust.turns * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  if (adjust.look === 'clean') {
    // cheap preview of the clean look on the small canvas
    cleanScan(cv);
  }
  placeCropRect();
}

function placeCropRect() {
  const r = adjust.rect;
  const el = $('#crop-rect');
  el.style.left = r.x0 * 100 + '%';
  el.style.top = r.y0 * 100 + '%';
  el.style.width = (r.x1 - r.x0) * 100 + '%';
  el.style.height = (r.y1 - r.y0) * 100 + '%';
}

function setupCropHandles() {
  const stage = $('#crop-stage');
  const MIN = 0.1;
  stage.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.h');
    if (!h) return;
    e.preventDefault();
    adjust.dragging = h.dataset.h;
    h.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!adjust.dragging) return;
    const b = stage.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
    const y = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
    const r = adjust.rect;
    if (adjust.dragging.includes('l')) r.x0 = Math.min(x, r.x1 - MIN);
    if (adjust.dragging.includes('r')) r.x1 = Math.max(x, r.x0 + MIN);
    if (adjust.dragging.includes('t')) r.y0 = Math.min(y, r.y1 - MIN);
    if (adjust.dragging.includes('b')) r.y1 = Math.max(y, r.y0 + MIN);
    placeCropRect();
  });
  const end = () => { adjust.dragging = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

async function saveAdjusted(src, turns, rect, look) {
  const canvas = renderPage(src, turns, rect, MAX_SIDE);
  if (look === 'clean') cleanScan(canvas);
  const [image, thumb] = await Promise.all([canvasToBlob(canvas, 'image/jpeg', 0.85), makeThumb(canvas)]);
  const now = Date.now();
  const page = {
    id: uid(),
    created: now,
    updated: now,
    title: '',
    dateWritten: '',
    journalId: state.scanJournal,
    seq: nextSeq(state.scanJournal),
    starred: false,
    tags: [],
    text: '',
    reviewed: false,
    ocr: { status: 'waiting' },
    thumb,
    w: canvas.width,
    h: canvas.height,
  };
  canvas.width = canvas.height = 0;
  await DB.putPageWithImage(page, image);
  state.pages.push(page);
  requestPersistentStorage();
  recompute();
  OCR.enqueue(page.id);
  hooks.pagesChanged();
  return page;
}

// Stand a saved page upright (Claude noticed it was sideways or upside down)
async function turnStored(page, turns) {
  const blob = await DB.getImage(page.id);
  if (!blob) return;
  const src = await loadImage(blob);
  const canvas = renderPage(src, turns, { x0: 0, y0: 0, x1: 1, y1: 1 }, MAX_SIDE);
  const [image, thumb] = await Promise.all([canvasToBlob(canvas, 'image/jpeg', 0.9), makeThumb(canvas)]);
  const fresh = (await DB.getPage(page.id)) || stored(page);
  Object.assign(fresh, { thumb, w: canvas.width, h: canvas.height, imgAt: Date.now() });
  canvas.width = canvas.height = 0;
  await DB.putPageWithImage(fresh, image);
  Object.assign(page, fresh);
}

let persistAsked = false;
async function requestPersistentStorage() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  try { await navigator.storage.persist(); } catch { /* best effort */ }
}

/* =========================================================
   Reading the pages: each photo is sent to Claude (claude-reader.js),
   one at a time, and the typed text comes back and is saved here.
   ========================================================= */
const readProgress = new Map();   // page id -> what is happening now
const OCR = (() => {
  let running = false;
  const queue = [];

  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    pump();
  }

  // Keep pages waiting (no key yet, no internet, no credit) and stop for now.
  async function pause(msg) {
    for (const q of queue.splice(0)) {
      const w = state.pages.find((x) => x.id === q);
      if (w) { w.ocr = { status: 'waiting', note: msg }; await DB.putPage(stored(w)).catch(() => {}); hooks.pageChanged(q); }
    }
    showReaderNote(msg, 8000);
  }

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const id = queue.shift();
      const page = state.pages.find((p) => p.id === id);
      if (!page) continue;
      page.ocr = { status: 'reading' };
      readProgress.set(id, 'Claude is reading this page…');
      hooks.pageChanged(id);
      try {
        const blob = await DB.getImage(id);
        let meta;
        try {
          const before = pagesOf(page.journalId).filter((x) => x.seq < page.seq && Chrono.valid(x.dateWritten));
          const prev = before.length ? before[before.length - 1].dateWritten : '';
          meta = await ClaudeReader.read(blob, { journal: journalName(page.journalId), prevDate: prev ? Chrono.format(prev) : '' });
        } catch (e) {
          if (e.kind !== 'page') {
            readProgress.delete(id);
            page.ocr = { status: 'waiting', note: e.message };
            await DB.putPage(stored(page)).catch(() => {});
            hooks.pageChanged(id);
            await pause(e.message);
            break;
          }
          throw e;
        }
        readProgress.delete(id);
        if (meta.turns) await turnStored(page, meta.turns);
        // If this page is open, keep what has been typed so far
        if (state.currentId === id) await savePage({ quiet: true });
        const fresh = (await DB.getPage(id)) || page;
        // Keep anything the person typed; an earlier reading nobody touched is simply replaced.
        const had = (fresh.text || '').trim();
        const untouched = !had || had === (fresh.readText || '').trim();
        fresh.text = untouched ? meta.text : had + '\n\n' + meta.text;
        if (meta.title && (!fresh.title || fresh.title === guessTitle(had))) fresh.title = meta.title;
        if (meta.date && !fresh.dateWritten && Chrono.valid(meta.date)) fresh.dateWritten = meta.date;
        fresh.tags = [...new Set([...(fresh.tags || []), ...meta.tags])];
        if (!fresh.title) fresh.title = guessTitle(meta.text);
        fresh.readText = meta.text;
        fresh.ocr = { status: 'done', engine: 'claude' };
        fresh.updated = Date.now();
        await DB.putPage(fresh);
        Object.assign(page, fresh);
        recompute();
      } catch (e) {
        console.error(e);
        readProgress.delete(id);
        page.ocr = { status: 'error', note: String(e && e.message || e) };
        await DB.putPage(stored(page)).catch(() => {});
      }
      hooks.pageChanged(id);
      if (state.currentId === id) fillPageForm(page);
    }
    running = false;
    hooks.pagesChanged();
  }

  // On start-up, pick up any pages that were waiting when the app was closed.
  function resume() {
    for (const p of state.pages) {
      if (p.ocr && (p.ocr.status === 'waiting' || p.ocr.status === 'reading')) enqueue(p.id);
    }
  }

  return { enqueue, resume, isBusy: () => running || queue.length > 0, waiting: () => queue.length + (running ? 1 : 0) };
})();

function tidyText(t) {
  return t
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function guessTitle(text) {
  const line = (text.split('\n').find((l) => l.replace(/[^A-Za-z]/g, '').length >= 3) || '').trim();
  return line.length > 60 ? line.slice(0, 57).trim() + '…' : line;
}

/* =========================================================
   Search
   - every word must appear (in the title, text, tags or journal name)
   - "quoted phrases" must appear exactly
   - words of 5+ letters also match when one letter is off, to forgive
     small handwriting-reading mistakes
   ========================================================= */
// The year a page belongs to: its own date, or the date before it in the journal
function yearOf(p) {
  const k = placeOf(p).key;
  return k === '9999' ? '' : k.slice(0, 4);
}
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function parseQuery(q) {
  const phrases = [];
  const words = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1]) { const p = norm(m[1]).trim(); if (p) phrases.push(p); }
    else {
      const w = norm(m[2]).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (w) words.push(w);
    }
  }
  return { phrases, words };
}
function within1(a, b) {
  // true if a and b differ by at most one edit (a is the search word)
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}
function haystack(p) {
  if (!p._hay || p._hayAt !== p.updated) {
    p._hay = norm([p.title, journalName(p.journalId), (p.tags || []).join(' '), p.text].join('\n'));
    p._words = p._hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    p._hayAt = p.updated;
  }
  return p;
}
function matchWord(p, w) {
  if (p._hay.includes(w)) return { exact: true };
  if (w.length >= 5) {
    for (const x of p._words) {
      if (Math.abs(x.length - w.length) <= 1 && within1(w, x)) return { exact: false, word: x };
      if (x.length > w.length && within1(w, x.slice(0, w.length))) return { exact: false, word: x.slice(0, w.length) };
    }
  }
  return null;
}
function searchPages() {
  const { phrases, words } = parseQuery(state.query);
  const f = state.filters;
  const out = [];
  for (const p of state.pages) {
    if (f.journal && p.journalId !== f.journal) continue;
    if (f.year && yearOf(p) !== f.year) continue;
    if (f.star && !p.starred) continue;
    if (f.review && p.reviewed) continue;
    if (f.tags.size) {
      const tags = new Set((p.tags || []).map((t) => t.toLowerCase()));
      let ok = true;
      for (const t of f.tags) if (!tags.has(t)) { ok = false; break; }
      if (!ok) continue;
    }
    haystack(p);
    let ok = true;
    let score = 0;
    const hits = [];
    for (const ph of phrases) {
      if (!p._hay.includes(ph)) { ok = false; break; }
      score += 3; hits.push(ph);
    }
    if (!ok) continue;
    for (const w of words) {
      const m = matchWord(p, w);
      if (!m) { ok = false; break; }
      score += m.exact ? 2 : 1;
      hits.push(m.exact ? w : m.word);
      if (norm(p.title).includes(w) || (p.tags || []).some((t) => norm(t) === w)) score += 2;
    }
    if (!ok) continue;
    out.push({ p, score, hits });
  }
  // Results always read in date order (or newest scans first), so a search reads like a story.
  const rank = new Map(timelineOrder(out.map((r) => r.p)).map((p, i) => [p.id, i]));
  out.sort((a, b) => {
    if (f.sort === 'scanned-desc') return b.p.created - a.p.created;
    const d = rank.get(a.p.id) - rank.get(b.p.id);
    return f.sort === 'time-desc' ? -d : d;
  });
  return out;
}

function snippet(p, hits) {
  const text = p.text || '';
  if (!text) return '';
  const low = norm(text);
  let at = -1;
  for (const h of hits) { at = low.indexOf(h); if (at >= 0) break; }
  let start = 0;
  if (at > 60) start = low.lastIndexOf(' ', at - 50) + 1;
  let s = text.slice(start, start + 220).replace(/\s+/g, ' ');
  if (start > 0) s = '…' + s;
  if (start + 220 < text.length) s += '…';
  return highlight(s, hits);
}
function highlight(s, hits) {
  // norm() keeps string length for most Latin text, so positions line up
  let html = '';
  const low = norm(s);
  const marks = [];
  for (const h of hits) {
    if (!h) continue;
    let i = 0;
    while ((i = low.indexOf(h, i)) >= 0) { marks.push([i, i + h.length]); i += h.length; }
  }
  marks.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    html += esc(s.slice(pos, a)) + '<mark>' + esc(s.slice(a, b)) + '</mark>';
    pos = b;
  }
  return html + esc(s.slice(pos));
}

/* =========================================================
   Journals and order in time
   ========================================================= */
const JOURNAL_COLORS = ['#8c2f2b', '#23413c', '#2d4a7a', '#b4532a', '#5b3f6e', '#6b5d1f', '#3c6e8f', '#7a4a2e', '#4d6b3a', '#444444'];

function journalById(id) {
  return state.journals.find((j) => j.id === id) || null;
}
function journalName(id) {
  const j = journalById(id);
  return j ? j.name : 'Unsorted';
}
function sortedJournals() {
  return [...state.journals].sort((a, b) => a.order - b.order || a.created - b.created);
}
// A journal's pages in book order
function pagesOf(jid) {
  return state.pages.filter((p) => p.journalId === jid).sort((a, b) => a.seq - b.seq || a.created - b.created);
}
function nextSeq(jid) {
  let max = 0;
  for (const p of state.pages) if (p.journalId === jid && p.seq > max) max = p.seq;
  return max + 1;
}
async function addJournal(name, color) {
  const now = Date.now();
  const order = state.journals.reduce((m, j) => Math.max(m, j.order), 0) + 1;
  const j = { id: uid(), name: name.trim() || 'Journal', color: color || JOURNAL_COLORS[state.journals.length % JOURNAL_COLORS.length], order, created: now };
  await DB.putJournal(j);
  state.journals.push(j);
  return j;
}

// Work out where every page sits in time (after any change to dates or order)
function recompute() {
  const m = new Map();
  const ids = new Set(state.journals.map((j) => j.id));
  for (const j of state.journals) for (const [k, v] of Chrono.annotate(pagesOf(j.id))) m.set(k, v);
  const loose = state.pages.filter((p) => !ids.has(p.journalId)).sort((a, b) => a.created - b.created);
  for (const [k, v] of Chrono.annotate(loose)) m.set(k, v);
  state.chrono = m;
}
function placeOf(p) {
  return state.chrono.get(p.id) || { kind: 'none', label: 'No date yet', short: 'no date', key: '9999' };
}
// Every page given, merged across journals into one line of time
function timelineOrder(pages) {
  const jOrder = new Map(sortedJournals().map((j, i) => [j.id, i]));
  return [...pages].sort((a, b) => {
    const ka = placeOf(a).key, kb = placeOf(b).key;
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ja = jOrder.has(a.journalId) ? jOrder.get(a.journalId) : 999;
    const jb = jOrder.has(b.journalId) ? jOrder.get(b.journalId) : 999;
    return ja - jb || a.seq - b.seq || a.created - b.created;
  });
}

// Pages from before journals existed: put them in journals named after their old "notebook"
async function migrate() {
  const byName = new Map(state.journals.map((j) => [j.name.toLowerCase(), j]));
  const ids = new Set(state.journals.map((j) => j.id));
  const changed = [];
  for (const p of [...state.pages].sort((a, b) => a.created - b.created)) {
    if (p.journalId && ids.has(p.journalId) && typeof p.seq === 'number') continue;
    if (!p.journalId || !ids.has(p.journalId)) {
      const name = (p.notebook || '').trim() || 'Unsorted pages';
      let j = byName.get(name.toLowerCase());
      if (!j) { j = await addJournal(name); byName.set(name.toLowerCase(), j); ids.add(j.id); }
      p.journalId = j.id;
    }
    p.seq = nextSeq(p.journalId);
    if (typeof p.starred !== 'boolean') p.starred = false;
    changed.push(stored(p));
  }
  if (changed.length) await DB.putPages(changed);
}

function stored(p) {
  const rec = { ...p };
  delete rec._hay; delete rec._words; delete rec._hayAt;
  return rec;
}

function thumbURL(p) {
  if (!p.thumb) return '';
  let u = state.thumbURLs.get(p.id);
  if (!u || u.blob !== p.thumb) {
    if (u) URL.revokeObjectURL(u.url);
    u = { url: URL.createObjectURL(p.thumb), blob: p.thumb };
    state.thumbURLs.set(p.id, u);
  }
  return u.url;
}

/* =========================================================
   PDFs
   ========================================================= */
function pdfFormat() {
  return /^en-(US|CA)|^es-(MX|US)/.test(navigator.language || '') ? 'letter' : 'a4';
}
// jsPDF's built-in font only covers Western European letters
function pdfSafe(s) {
  return String(s || '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\n\x20-\x7E\xA0-\xFF]/g, '');
}

async function buildPDF(pages, { includeText = true } = {}) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: pdfFormat(), compress: true });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 36;
  let first = true;
  const newPage = () => { if (!first) doc.addPage(); first = false; };

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    busy(`Making PDF… page ${i + 1} of ${pages.length}`);
    const blob = await DB.getImage(p.id);
    if (blob) {
      newPage();
      const dataURL = await blobToDataURL(blob);
      const s = Math.min((W - 2 * M) / p.w, (H - 2 * M) / p.h);
      const iw = p.w * s, ih = p.h * s;
      doc.addImage(dataURL, 'JPEG', (W - iw) / 2, (H - ih) / 2, iw, ih, undefined, 'FAST');
    }
    if (includeText && (p.text || p.title)) {
      newPage();
      let y = M + 10;
      doc.setFont('times', 'bold'); doc.setFontSize(18);
      for (const line of doc.splitTextToSize(pdfSafe(p.title || 'Untitled page'), W - 2 * M)) {
        doc.text(line, M, y); y += 22;
      }
      const meta = [placeOf(p).label, `${journalName(p.journalId)}, page ${p.seq}`, (p.tags || []).join(', ')].filter(Boolean).join('   |   ');
      if (meta) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90);
        for (const line of doc.splitTextToSize(pdfSafe(meta), W - 2 * M)) { doc.text(line, M, y); y += 14; }
        doc.setTextColor(0);
      }
      y += 10;
      doc.setFont('times', 'normal'); doc.setFontSize(12);
      for (const line of doc.splitTextToSize(pdfSafe(p.text), W - 2 * M)) {
        if (y > H - M) { doc.addPage(); y = M + 10; }
        doc.text(line, M, y); y += 16;
      }
    }
    await new Promise((r) => setTimeout(r, 0)); // let the screen update
  }
  return doc.output('blob');
}

async function exportPDF(pages, name) {
  if (!pages.length) return;
  try {
    const blob = await buildPDF(pages);
    busy(false);
    await deliverFile(blob, safeFileName(name) + '.pdf');
  } catch (e) {
    console.error(e);
    busy(false);
    toast('The PDF could not be made. If there are many pages, try fewer at a time.', 5000);
  }
}

/* =========================================================
   Backup / restore / text export
   ========================================================= */
async function makeBackup() {
  busy('Preparing backup…');
  try {
    const parts = [`{"app":"journal-keeper","version":2,"exported":${JSON.stringify(new Date().toISOString())},"journals":${JSON.stringify(state.journals)},"pages":[`];
    for (let i = 0; i < state.pages.length; i++) {
      const p = state.pages[i];
      busy(`Preparing backup… ${i + 1} of ${state.pages.length}`);
      const img = await DB.getImage(p.id);
      const rec = {
        id: p.id, created: p.created, updated: p.updated, title: p.title, dateWritten: p.dateWritten,
        journalId: p.journalId, seq: p.seq, starred: !!p.starred,
        tags: p.tags, text: p.text, readText: p.readText, reviewed: p.reviewed, ocr: p.ocr, w: p.w, h: p.h,
        image: img ? await blobToDataURL(img) : null,
        thumb: p.thumb ? await blobToDataURL(p.thumb) : null,
      };
      parts.push((i ? ',' : '') + JSON.stringify(rec));
    }
    parts.push(']}');
    const blob = new Blob(parts, { type: 'application/json' });
    busy(false);
    const d = new Date().toISOString().slice(0, 10);
    await deliverFile(blob, `Journal Keeper backup ${d}.json`);
  } catch (e) {
    console.error(e);
    busy(false);
    toast('The backup could not be made.', 4000);
  }
}

async function restoreBackup(file) {
  busy('Reading backup…');
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'journal-keeper' || !Array.isArray(data.pages)) throw new Error('not a backup');
    for (const j of data.journals || []) {
      const old = journalById(j.id);
      if (old) continue;
      const rec = { id: j.id, name: j.name || 'Journal', color: j.color || JOURNAL_COLORS[0], order: j.order || state.journals.length + 1, created: j.created || Date.now() };
      await DB.putJournal(rec);
      state.journals.push(rec);
    }
    const have = new Map(state.pages.map((p) => [p.id, p]));
    let added = 0, updated = 0;
    for (let i = 0; i < data.pages.length; i++) {
      busy(`Restoring… ${i + 1} of ${data.pages.length}`);
      const r = data.pages[i];
      const old = have.get(r.id);
      if (old && old.updated >= r.updated) continue; // this device has the newer copy
      const image = r.image ? await dataURLToBlob(r.image) : null;
      const thumb = r.thumb ? await dataURLToBlob(r.thumb) : null;
      const page = {
        id: r.id, created: r.created, updated: r.updated, title: r.title || '', dateWritten: r.dateWritten || '',
        journalId: r.journalId || '', seq: typeof r.seq === 'number' ? r.seq : undefined, starred: !!r.starred, notebook: r.notebook || '',
        tags: r.tags || [], text: r.text || '', readText: r.readText || '', reviewed: !!r.reviewed,
        ocr: r.ocr || { status: 'done' }, w: r.w, h: r.h, thumb,
      };
      if (image) await DB.putPageWithImage(page, image); else await DB.putPage(page);
      if (old) { Object.assign(old, page); old._hayAt = null; updated++; } else { state.pages.push(page); added++; }
    }
    await migrate();   // older backups: pages without a journal
    recompute();
    busy(false);
    hooks.pagesChanged();
    toast(`Restored: ${added} new page${added === 1 ? '' : 's'}${updated ? `, ${updated} updated` : ''}.`, 4000);
    requestPersistentStorage();
  } catch (e) {
    console.error(e);
    busy(false);
    toast('That file is not a Journal Keeper backup.', 4000);
  }
}

// All typed text in date order, with where each page comes from: the raw material for the book
async function exportText(pages, filename) {
  let lastYear = '';
  const out = [];
  for (const p of timelineOrder(pages)) {
    const y = yearOf(p);
    if (y && y !== lastYear) { out.push(`\n\n==================== ${y} ====================\n`); lastYear = y; }
    const head = [p.title || 'Untitled page', `${placeOf(p).label} · ${journalName(p.journalId)}, page ${p.seq}`,
      (p.tags || []).length ? 'Tags: ' + p.tags.join(', ') : ''].filter(Boolean).join('\n');
    out.push(head + '\n\n' + (p.text || '').trim() + '\n\n* * *\n');
  }
  await deliverFile(new Blob([out.join('\n')], { type: 'text/plain' }), filename);
}

async function renderStats() {
  const n = state.pages.length;
  const checked = state.pages.filter((p) => p.reviewed).length;
  const starred = state.pages.filter((p) => p.starred).length;
  let space = '';
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage } = await navigator.storage.estimate();
      if (usage) space = ` Using about ${(usage / 1048576).toFixed(0)} MB on this device.`;
    }
  } catch { /* optional */ }
  $('#stats').textContent = `${n} page${n === 1 ? '' : 's'} in ${state.journals.length} journal${state.journals.length === 1 ? '' : 's'}, ${checked} checked, ${starred} saved for the book.${space}`;
  $('#btn-pdf-all').disabled = !n;
  $('#btn-text-all').disabled = !n;
  $('#btn-text-star').disabled = !starred;
  $('#btn-backup').disabled = !n;
}

let readerNoteTimer;
function showReaderNote(msg, hideAfter) {
  for (const el of $$('.reader-note')) { el.textContent = msg; el.hidden = false; }
  clearTimeout(readerNoteTimer);
  if (hideAfter) readerNoteTimer = setTimeout(() => { for (const el of $$('.reader-note')) el.hidden = true; }, hideAfter);
}

/* A made-up journal photo so the app can be tried without a real page */
async function samplePhoto() {
  const c = document.createElement('canvas');
  c.width = 1500; c.height = 1900;
  const x = c.getContext('2d');
  x.fillStyle = '#6b4b2e'; x.fillRect(0, 0, c.width, c.height);
  x.save(); x.translate(750, 950); x.rotate(0.02);
  const g = x.createLinearGradient(-620, 0, 620, 0);
  g.addColorStop(0, '#d9d2c0'); g.addColorStop(1, '#f7f3e8');
  x.fillStyle = g; x.fillRect(-620, -820, 1240, 1640);
  x.fillStyle = '#20315a'; x.font = 'italic 56px Georgia, serif';
  ['June 12, 1984', 'Drove to the lake house with', 'Mother and Uncle Walter. The', 'fishing was poor but the',
    'sunset over the water was the', 'finest I have ever seen.'].forEach((l, i) => x.fillText(l, -540, -620 + i * 108));
  x.restore();
  const blob = await canvasToBlob(c, 'image/jpeg', 0.9);
  return new File([blob], 'sample-page.jpg', { type: 'image/jpeg' });
}
