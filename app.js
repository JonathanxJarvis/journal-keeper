/* Journal Keeper: scan handwritten journal pages, have Claude read them,
   search them, and save them as PDFs. Pages are stored on this device. */
'use strict';

const APP_VERSION = '2.0.0';
const MAX_SIDE = 2200;      // longest edge of a stored page image, in pixels
const THUMB_SIDE = 360;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* =========================================================
   Storage (IndexedDB)
   pages:  metadata + text + small thumbnail (fast to list)
   images: full page image, keyed by page id
   ========================================================= */
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('journal-keeper', 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
        // line pictures from an earlier version; no longer used, kept so older data still opens
        if (!db.objectStoreNames.contains('lines')) db.createObjectStore('lines');
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
    getLines: (id) => tx(['lines'], 'readonly', (t) => req2p(t.objectStore('lines').get(id))),
    putLines: (id, items) => tx(['lines'], 'readwrite', (t) => { t.objectStore('lines').put(items, id); }),
    allLines: () => tx(['lines'], 'readonly', (t) => req2p(t.objectStore('lines').getAll())),
  };
})();

/* =========================================================
   App state
   ========================================================= */
const state = {
  pages: [],               // all page records (no full images)
  filters: { notebook: '', year: '', tags: new Set(), review: false, sort: 'written-asc' },
  query: '',
  results: [],
  currentId: null,
  thumbURLs: new Map(),
};

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
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return '';
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
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
  if (!file) { showView('list'); render(); return; }
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
  adjust.rect = { x0: 0.03, y0: 0.03, x1: 0.97, y1: 0.97 };
  const left = adjust.queue.length;
  $('#adj-title').textContent = left ? `Adjust the page (${left} more after this)` : 'Adjust the page';
  $('#adj-save').textContent = left ? 'Save and go to next' : 'Save page';
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
    notebook: lastNotebook(),
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
  OCR.enqueue(page.id);
  return page;
}

function lastNotebook() {
  try { return localStorage.getItem('jk-last-notebook') || ''; } catch { return ''; }
}
function rememberNotebook(nb) {
  try { localStorage.setItem('jk-last-notebook', nb || ''); } catch { /* not important */ }
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
      if (w) { w.ocr = { status: 'waiting', note: msg }; await DB.putPage(stored(w)).catch(() => {}); refreshItem(q); }
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
      refreshItem(id);
      try {
        const blob = await DB.getImage(id);
        let meta;
        try {
          meta = await ClaudeReader.read(blob);
        } catch (e) {
          if (e.kind !== 'page') {
            readProgress.delete(id);
            page.ocr = { status: 'waiting', note: e.message };
            await DB.putPage(stored(page)).catch(() => {});
            refreshItem(id);
            await pause(e.message);
            break;
          }
          throw e;
        }
        readProgress.delete(id);
        // If this page is open, keep what has been typed so far
        if (state.currentId === id) await savePage({ quiet: true });
        const fresh = (await DB.getPage(id)) || page;
        // Keep anything the person typed; an earlier reading nobody touched is simply replaced.
        const had = (fresh.text || '').trim();
        const untouched = !had || had === (fresh.readText || '').trim();
        fresh.text = untouched ? meta.text : had + '\n\n' + meta.text;
        if (meta.title && (!fresh.title || fresh.title === guessTitle(had))) fresh.title = meta.title;
        if (meta.date && !fresh.dateWritten && meta.date.length === 10) fresh.dateWritten = meta.date;
        fresh.tags = [...new Set([...(fresh.tags || []), ...meta.tags])];
        if (!fresh.title) fresh.title = guessTitle(meta.text);
        fresh.readText = meta.text;
        fresh.ocr = { status: 'done', engine: 'claude' };
        fresh.updated = Date.now();
        await DB.putPage(fresh);
        Object.assign(page, fresh);
      } catch (e) {
        console.error(e);
        readProgress.delete(id);
        page.ocr = { status: 'error', note: String(e && e.message || e) };
        await DB.putPage(stored(page)).catch(() => {});
      }
      refreshItem(id);
      if (state.currentId === id) fillPageForm(page);
    }
    running = false;
    render();
  }

  // On start-up, pick up any pages that were waiting when the app was closed.
  function resume() {
    for (const p of state.pages) {
      if (p.ocr && (p.ocr.status === 'waiting' || p.ocr.status === 'reading')) enqueue(p.id);
    }
  }

  return { enqueue, resume, isBusy: () => running || queue.length > 0 };
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
   - every word must appear (in the title, text, tags or notebook)
   - "quoted phrases" must appear exactly
   - words of 5+ letters also match when one letter is off, to forgive
     small handwriting-reading mistakes
   ========================================================= */
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
    p._hay = norm([p.title, p.notebook, (p.tags || []).join(' '), p.text].join('\n'));
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
    if (f.notebook && (p.notebook || '') !== f.notebook) continue;
    if (f.year && (p.dateWritten || '').slice(0, 4) !== f.year) continue;
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
  const hasQuery = phrases.length || words.length;
  const byWritten = (a, b) => (a.p.dateWritten || '9999').localeCompare(b.p.dateWritten || '9999') || a.p.created - b.p.created;
  out.sort((a, b) => {
    if (hasQuery && b.score !== a.score) return b.score - a.score;
    if (f.sort === 'written-desc') return -byWritten(a, b);
    if (f.sort === 'scanned-desc') return b.p.created - a.p.created;
    return byWritten(a, b);
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
   Notes list
   ========================================================= */
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

function itemHTML(r) {
  const p = r.p;
  const meta = [fmtDate(p.dateWritten), p.notebook].filter(Boolean).map(esc).join(' · ');
  const badges = [];
  if (p.ocr?.status === 'waiting') badges.push(`<span class="badge busy">${p.ocr.note ? 'Paused, see menu' : 'Waiting to read'}</span>`);
  else if (p.ocr?.status === 'reading') badges.push(`<span class="badge busy">${esc(readProgress.get(p.id) || 'Reading handwriting…')}</span>`);
  else if (p.ocr?.status === 'error') badges.push('<span class="badge warn">Could not read, tap to type it</span>');
  else if (!p.reviewed) badges.push('<span class="badge warn">Needs checking</span>');
  for (const t of (p.tags || []).slice(0, 4)) badges.push(`<span class="badge">${esc(t)}</span>`);
  const title = p.title ? highlight(p.title, r.hits) : '<span class="muted">Untitled page</span>';
  const snip = snippet(p, r.hits);
  return `<li><button class="item" data-id="${esc(p.id)}">
    <img src="${thumbURL(p)}" alt="" loading="lazy">
    <span class="item-body">
      <span class="item-title">${title}</span>
      ${meta ? `<span class="item-meta">${meta}</span>` : ''}
      ${snip ? `<span class="item-snip">${snip}</span>` : ''}
      ${badges.length ? `<span class="badges">${badges.join('')}</span>` : ''}
    </span>
  </button></li>`;
}

function render() {
  state.results = searchPages();
  const list = $('#list');
  list.innerHTML = state.results.map(itemHTML).join('');
  const total = state.pages.length;
  const n = state.results.length;
  const filtering = state.query.trim() || state.filters.notebook || state.filters.year || state.filters.tags.size || state.filters.review;
  $('#empty').hidden = total > 0;
  $('#result-count').textContent = !total ? '' : filtering
    ? `${n} of ${total} page${total === 1 ? '' : 's'} match`
    : `${total} page${total === 1 ? '' : 's'}`;
  $('#btn-pdf-results').hidden = !n;
  $('#btn-pdf-results').textContent = filtering ? 'Make a PDF of these' : 'Make a PDF of all';
  if (filtering && !n) {
    list.innerHTML = '<li class="empty"><p class="empty-title">Nothing found</p><p>Try fewer words, or clear the filters.</p></li>';
  }
  renderFilterOptions();
}

function refreshItem(id) {
  const btn = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  const r = state.results.find((x) => x.p.id === id);
  if (btn && r) btn.parentElement.outerHTML = itemHTML(r);
}

function renderFilterOptions() {
  const f = state.filters;
  const notebooks = [...new Set(state.pages.map((p) => p.notebook).filter(Boolean))].sort();
  const years = [...new Set(state.pages.map((p) => (p.dateWritten || '').slice(0, 4)).filter(Boolean))].sort();
  const tagCount = new Map();
  for (const p of state.pages) for (const t of p.tags || []) {
    const k = t.toLowerCase();
    tagCount.set(k, (tagCount.get(k) || 0) + 1);
  }
  const fill = (sel, first, vals, cur) => {
    sel.innerHTML = `<option value="">${first}</option>` + vals.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  };
  fill($('#f-notebook'), 'All notebooks', notebooks, f.notebook);
  fill($('#f-year'), 'Any year', years, f.year);
  $('#notebook-list').innerHTML = notebooks.map((n) => `<option value="${esc(n)}">`).join('');
  const tags = [...tagCount.keys()].sort();
  $('#f-tags').innerHTML = tags.length
    ? tags.map((t) => `<button class="chip${f.tags.has(t) ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${f.tags.has(t)}">${esc(t)} (${tagCount.get(t)})</button>`).join('')
    : '<span class="muted small">Tags you add to pages will show up here.</span>';
}

/* =========================================================
   Page detail
   ========================================================= */
let pageImgURL = null;
async function openPage(id) {
  const p = state.pages.find((x) => x.id === id);
  if (!p) return;
  state.currentId = id;
  $('#pg-confirm').hidden = true;
  fillPageForm(p);
  showView('page');
  const img = await DB.getImage(id);
  if (pageImgURL) URL.revokeObjectURL(pageImgURL);
  pageImgURL = img ? URL.createObjectURL(img) : '';
  $('#pg-img').src = pageImgURL || thumbURL(p);
}

function fillPageForm(p) {
  const note = $('#pg-ocr-note');
  note.className = 'note';
  if (p.ocr?.status === 'waiting' || p.ocr?.status === 'reading') {
    note.className = 'note info';
    note.textContent = p.ocr?.status === 'waiting' && p.ocr.note
      ? p.ocr.note
      : 'Claude is reading this page. The words will appear below in a moment. You can fill in the other details now.';
    note.hidden = false;
  } else if (p.ocr?.status === 'error') {
    note.textContent = `${p.ocr.note || 'This page could not be read.'} You can type or dictate the words below, or tap "Read this page again".`;
    note.hidden = false;
  } else if (!p.reviewed && p.ocr?.note) {
    note.textContent = p.ocr.note;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  $('#pg-text').value = p.text || '';
  $('#pg-title').value = p.title || '';
  $('#pg-date').value = p.dateWritten || '';
  $('#pg-notebook').value = p.notebook || '';
  $('#pg-tags').value = (p.tags || []).join(', ');
  $('#pg-reviewed').checked = !!p.reviewed;
}

function stored(p) {
  const rec = { ...p };
  delete rec._hay; delete rec._words; delete rec._hayAt;
  return rec;
}

async function savePage({ quiet = false } = {}) {
  const p = state.pages.find((x) => x.id === state.currentId);
  if (!p) return;
  p.title = $('#pg-title').value.trim();
  p.dateWritten = $('#pg-date').value;
  p.notebook = $('#pg-notebook').value.trim();
  p.tags = parseTags($('#pg-tags').value);
  p.text = $('#pg-text').value;
  p.reviewed = $('#pg-reviewed').checked;
  p.updated = Date.now();
  rememberNotebook(p.notebook);
  await DB.putPage(stored(p));
  if (!quiet) toast('Saved');
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
      const meta = [fmtDate(p.dateWritten), p.notebook, (p.tags || []).join(', ')].filter(Boolean).join('   |   ');
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
    const parts = [`{"app":"journal-keeper","version":1,"exported":${JSON.stringify(new Date().toISOString())},"pages":[`];
    for (let i = 0; i < state.pages.length; i++) {
      const p = state.pages[i];
      busy(`Preparing backup… ${i + 1} of ${state.pages.length}`);
      const img = await DB.getImage(p.id);
      const rec = {
        id: p.id, created: p.created, updated: p.updated, title: p.title, dateWritten: p.dateWritten,
        notebook: p.notebook, tags: p.tags, text: p.text, reviewed: p.reviewed, ocr: p.ocr, w: p.w, h: p.h,
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
    const have = new Map(state.pages.map((p) => [p.id, p]));
    let added = 0, updated = 0;
    for (let i = 0; i < data.pages.length; i++) {
      busy(`Restoring… ${i + 1} of ${data.pages.length}`);
      const r = data.pages[i];
      const old = have.get(r.id);
      if (old && old.updated >= r.updated) continue; // this phone has the newer copy
      const image = r.image ? await dataURLToBlob(r.image) : null;
      const thumb = r.thumb ? await dataURLToBlob(r.thumb) : null;
      const page = {
        id: r.id, created: r.created, updated: r.updated, title: r.title || '', dateWritten: r.dateWritten || '',
        notebook: r.notebook || '', tags: r.tags || [], text: r.text || '', reviewed: !!r.reviewed,
        ocr: r.ocr || { status: 'done' }, w: r.w, h: r.h, thumb,
      };
      if (image) await DB.putPageWithImage(page, image); else await DB.putPage(page);
      if (old) { Object.assign(old, page); old._hayAt = null; updated++; } else { state.pages.push(page); added++; }
    }
    busy(false);
    render(); renderStats();
    toast(`Restored: ${added} new page${added === 1 ? '' : 's'}${updated ? `, ${updated} updated` : ''}.`, 4000);
    requestPersistentStorage();
  } catch (e) {
    console.error(e);
    busy(false);
    toast('That file is not a Journal Keeper backup.', 4000);
  }
}

async function exportAllText() {
  const pages = searchPagesAll();
  const out = pages.map((p) => {
    const head = [p.title || 'Untitled page', [fmtDate(p.dateWritten), p.notebook].filter(Boolean).join(' · '),
      (p.tags || []).length ? 'Tags: ' + p.tags.join(', ') : ''].filter(Boolean).join('\n');
    return head + '\n\n' + (p.text || '').trim();
  }).join('\n\n\n* * *\n\n\n');
  const blob = new Blob([out], { type: 'text/plain' });
  await deliverFile(blob, 'Journal Keeper - all text.txt');
}

function searchPagesAll() {
  return [...state.pages].sort((a, b) => (a.dateWritten || '9999').localeCompare(b.dateWritten || '9999') || a.created - b.created);
}

async function renderStats() {
  const n = state.pages.length;
  const checked = state.pages.filter((p) => p.reviewed).length;
  let space = '';
  try {
    if (navigator.storage?.estimate) {
      const { usage } = await navigator.storage.estimate();
      if (usage) space = ` Using about ${(usage / 1048576).toFixed(0)} MB on this phone.`;
    }
  } catch { /* optional */ }
  $('#stats').textContent = `${n} page${n === 1 ? '' : 's'} saved, ${checked} checked.${space}`;
  $('#btn-pdf-all').disabled = !n;
  $('#btn-text-all').disabled = !n;
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

/* =========================================================
   Wiring
   ========================================================= */
function wire() {
  // Scan
  $('#btn-scan').onclick = () => $('#in-camera').click();
  $('#btn-pick').onclick = () => $('#in-photos').click();
  for (const id of ['#in-camera', '#in-photos']) {
    $(id).addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length) startAdjust(files);
      e.target.value = '';
    });
  }

  $('#btn-sample').onclick = async () => startAdjust([await samplePhoto()]);

  // Adjust
  setupCropHandles();
  $('#adj-rotate').onclick = () => {
    adjust.turns = (adjust.turns + 1) % 4;
    const r = adjust.rect; // turn the crop box with the page
    adjust.rect = { x0: 1 - r.y1, y0: r.x0, x1: 1 - r.y0, y1: r.x1 };
    drawAdjust();
  };
  for (const b of $$('.seg-btn')) {
    b.onclick = () => {
      adjust.look = b.dataset.look;
      for (const x of $$('.seg-btn')) x.classList.toggle('on', x === b);
      drawAdjust();
    };
  }
  $('#adj-save').onclick = async () => {
    busy('Saving page…');
    try {
      await saveAdjusted(adjust.src, adjust.turns, adjust.rect, adjust.look);
      busy(false);
      toast(adjust.queue.length ? 'Saved. Next photo…' : 'Saved. Reading the handwriting now.');
      if (!adjust.queue.length) { showView('list'); render(); } else await nextInQueue();
    } catch (e) {
      console.error(e);
      busy(false);
      toast('The page could not be saved. The phone may be out of space.', 5000);
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
      toast(`Saved ${rest.length + 1} pages. Reading the handwriting now.`);
    } catch (e) {
      console.error(e);
      busy(false);
      toast('Some pages could not be saved.', 4000);
    }
    showView('list'); render();
  };
  $('#adj-cancel').onclick = () => { adjust.queue = []; showView('list'); render(); };
  window.addEventListener('resize', () => { if (!$('#view-adjust').hidden && adjust.src) drawAdjust(); });

  // List
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.query = e.target.value; render(); }, 150);
  });
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#list').addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (b) openPage(b.dataset.id);
  });
  $('#btn-filters').onclick = () => {
    const f = $('#filters');
    f.hidden = !f.hidden;
    $('#btn-filters').setAttribute('aria-expanded', String(!f.hidden));
  };
  $('#f-notebook').onchange = (e) => { state.filters.notebook = e.target.value; render(); };
  $('#f-year').onchange = (e) => { state.filters.year = e.target.value; render(); };
  $('#f-sort').onchange = (e) => { state.filters.sort = e.target.value; render(); };
  $('#f-review').onchange = (e) => { state.filters.review = e.target.checked; render(); };
  $('#f-tags').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const t = c.dataset.tag;
    if (state.filters.tags.has(t)) state.filters.tags.delete(t); else state.filters.tags.add(t);
    render();
  });
  $('#btn-clear-filters').onclick = () => {
    Object.assign(state.filters, { notebook: '', year: '', review: false });
    state.filters.tags.clear();
    $('#f-review').checked = false;
    render();
  };
  $('#btn-pdf-results').onclick = () => {
    const name = state.query.trim() ? `Journal - ${state.query.replace(/"/g, '')}` : 'Journal - all pages';
    exportPDF(state.results.map((r) => r.p), name);
  };

  // Page
  $('#pg-back').onclick = async () => {
    await savePage({ quiet: true });
    state.currentId = null;
    showView('list'); render();
  };
  $('#pg-save').onclick = async () => {
    await savePage();
    state.currentId = null;
    showView('list'); render();
  };
  $('#pg-pdf').onclick = async () => {
    await savePage({ quiet: true });
    const p = state.pages.find((x) => x.id === state.currentId);
    exportPDF([p], `Journal - ${p.title || fmtDate(p.dateWritten) || 'page'}`);
  };
  $('#pg-reocr').onclick = async () => {
    const p = state.pages.find((x) => x.id === state.currentId);
    if (!p) return;
    await savePage({ quiet: true });
    // Replace the text only if the person hasn't marked it as checked
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
    await DB.deletePage(id);
    state.pages = state.pages.filter((p) => p.id !== id);
    state.currentId = null;
    toast('Page deleted');
    showView('list'); render();
  };
  $('#pg-zoom').onclick = () => { $('#zoom-img').src = $('#pg-img').src; $('#zoom').hidden = false; };
  $('#pg-img').onclick = () => $('#pg-zoom').click();
  $('#zoom-close').onclick = () => { $('#zoom').hidden = true; };

  // Claude reader settings
  const claudeNote = (msg) => { const n = $('#claude-note'); n.textContent = msg; n.hidden = !msg; };
  const showSpent = () => {
    const s = ClaudeReader.spent();
    $('#claude-spent').textContent = s.pages
      ? `Read by Claude on this phone so far: ${s.pages} page${s.pages === 1 ? '' : 's'}, about $${s.usd.toFixed(2)} (average ${(100 * s.usd / s.pages).toFixed(1)} cents a page).`
      : 'No pages read by Claude yet.';
  };
  $('#claude-key').value = ClaudeReader.key();
  $('#claude-model').value = ClaudeReader.model();
  $('#claude-hint').value = ClaudeReader.hint();
  $('#claude-model').onchange = (e) => ClaudeReader.setModel(e.target.value);
  $('#claude-hint').onchange = (e) => ClaudeReader.setHint(e.target.value);
  showSpent();
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
    claudeNote(`Reading ${todo.length} page${todo.length === 1 ? '' : 's'}, roughly $${est.toFixed(2)}. Keep the app open and on Wi-Fi; you can watch the list fill in.`);
    for (const p of todo) {
      p.ocr = { status: 'waiting' };
      await DB.putPage(stored(p)).catch(() => {});
      OCR.enqueue(p.id);
    }
  };

  // Menu
  $('#btn-menu').onclick = () => { renderStats(); showSpent(); showView('menu'); };
  $('#menu-back').onclick = () => { showView('list'); render(); };
  $('#btn-pdf-all').onclick = () => exportPDF(searchPagesAll(), 'Journal - all pages');
  $('#btn-text-all').onclick = () => exportAllText();
  $('#btn-backup').onclick = () => makeBackup();
  $('#btn-restore').onclick = () => $('#in-restore').click();
  $('#in-restore').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) restoreBackup(f);
    e.target.value = '';
  });
  $('#version').textContent = `Journal Keeper ${APP_VERSION}. Your pages are kept on this phone; each photo is sent only to Claude to be read.`;

  // Save typing if the app is closed or switched away from a page
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.currentId) savePage({ quiet: true });
  });
}

async function init() {
  wire();
  try {
    state.pages = await DB.allPages();
  } catch (e) {
    console.error(e);
    toast('This browser is blocking storage. Open Journal Keeper from the Home Screen, not a private window.', 8000);
  }
  render();
  OCR.resume();
  // Pages that waited for internet carry on as soon as it is back
  window.addEventListener('online', () => OCR.resume());
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // Always check for a newer version, and reload once when it takes over, so updates show straight away.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded && !OCR.isBusy()) { reloaded = true; location.reload(); }
    });
  }
}

init();
