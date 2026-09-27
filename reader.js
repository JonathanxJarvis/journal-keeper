/* Handwriting reading helpers for Journal Keeper:
   - findLines: splits a page photo into one picture per line of writing
   - HTR: talks to the background handwriting reader (htr-worker.js)
   - Learner: remembers Dad's corrections and applies them to later pages */
'use strict';

/* =========================================================
   Line finding
   Works on a reduced copy of the page: evens out the lighting, marks dark
   "ink" pixels, ignores printed ruling and margin lines, then looks for
   horizontal bands of ink. Returns crops from the full-size image.
   ========================================================= */
/* Draw the page small and mark which pixels are ink */
function analyse(src) {
  const s = Math.min(1, 1000 / src.width);
  const w = Math.round(src.width * s), h = Math.round(src.height * s);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // Paper brightness estimate (blurred copy) so shadows don't count as ink
  const bw = Math.max(8, Math.round(w / 24)), bh = Math.max(8, Math.round(h / 24));
  const small = document.createElement('canvas');
  small.width = bw; small.height = bh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(cv, 0, 0, bw, bh);
  const bg = sctx.getImageData(0, 0, bw, bh).data;

  const dark = new Uint8Array(w * h);
  const blue = new Uint8Array(w * h);
  const rule = new Uint8Array(w * h);
  let nDark = 0, nBlue = 0;
  for (let y = 0; y < h; y++) {
    const by = Math.min(bh - 1, Math.floor(y * bh / h));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bx = Math.min(bw - 1, Math.floor(x * bw / w));
      const j = (by * bw + bx) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const bl = Math.max(40, 0.299 * bg[j] + 0.587 * bg[j + 1] + 0.114 * bg[j + 2]);
      // Printed ruling is fainter than pen: catch it with a looser test
      if (l / bl < 0.85 && !(b - r > 14 && b - g > 6)) rule[y * w + x] = 1;
      if (l / bl < 0.66) {
        dark[y * w + x] = 1; nDark++;
        // Blue or coloured pen, as opposed to grey printed ruling
        if (b - r > 14 && b - g > 6) { blue[y * w + x] = 1; nBlue++; }
      }
    }
  }
  let ink;
  if (nBlue > nDark * 0.25) {
    // Coloured pen: keep only coloured pixels, which drops the ruled lines and the edge of the notebook
    ink = blue;
  } else {
    // Black or pencil: remove long, thin horizontal runs (ruled lines)
    ink = dark;
    const minRun = Math.round(w * 0.12);
    const tmp = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x;
      tmp[k] = dark[k] | dark[k - w] | dark[k + w];
    }
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!tmp[y * w + x]) { x++; continue; }
        let e = x;
        while (e < w && tmp[y * w + e]) e++;
        if (e - x >= minRun) {
          // only erase where the stroke is thin (a rule), keep thick writing
          for (let t = x; t < e; t++) {
            let th = 0;
            for (let d = -4; d <= 4; d++) { const yy = y + d; if (yy >= 0 && yy < h && dark[yy * w + t]) th++; }
            if (th <= 3) ink[y * w + t] = 0;
          }
        }
        x = e;
      }
    }
  }
  return { w, h, s, ink, rule, coloured: nBlue > nDark * 0.25 };
}

/* Positions (rows) of printed ruled lines, or null if the paper is not ruled */
function findRules({ w, h, rule }) {
  const x0 = Math.round(w * 0.2), x1 = Math.round(w * 0.8);
  const prof = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (rule[y * w + x] || (y > 0 && rule[(y - 1) * w + x]) || (y < h - 1 && rule[(y + 1) * w + x])) c++;
    prof[y] = c / (x1 - x0);
  }
  // Spacing of the ruling: strongest repeat in the profile
  let mean = 0;
  for (let y = 0; y < h; y++) mean += prof[y];
  mean /= h;
  let g = 0, bestC = -Infinity;
  for (let lag = Math.max(10, Math.round(h / 60)); lag <= Math.round(h / 8); lag++) {
    let c = 0;
    for (let y = 0; y + lag < h; y++) c += (prof[y] - mean) * (prof[y + lag] - mean);
    c /= (h - lag);
    if (c > bestC) { bestC = c; g = lag; }
  }
  if (!g) return null;
  // Strongest rows first, each claiming the space around it
  const sortedP = Array.from(prof).sort((a, b) => a - b);
  const floor = Math.max(0.12, sortedP[Math.floor(h * 0.98)] * 0.35);
  const order = Array.from({ length: h }, (_, i) => i).filter((y) => prof[y] >= floor).sort((p, q) => prof[q] - prof[p]);
  const claimed = new Uint8Array(h);
  const reach = Math.round(g * 0.6);
  const rows = [];
  for (const y of order) {
    if (claimed[y]) continue;
    rows.push(y);
    for (let d = -reach; d <= reach; d++) if (y + d >= 0 && y + d < h) claimed[y + d] = 1;
  }
  rows.sort((p, q) => p - q);
  if (rows.length < 5) return null;
  const keep = rows.filter((y, i) => rows.some((z, j) => j !== i && Math.abs(Math.abs(z - y) - g) < g * 0.25));
  return keep.length >= 5 ? { rows: keep, gap: g } : null;
}

/* Tilt (in degrees) that lines the writing up best with the rows */
function bestAngle({ w, h, ink }) {
  let best = 0, bestScore = -1;
  const pts = [];
  // Only the middle of the page: edges, covers and the next page would dominate otherwise
  for (let y = Math.round(h * 0.05); y < h * 0.95; y += 2) for (let x = Math.round(w * 0.15); x < w * 0.85; x += 2) if (ink[y * w + x]) pts.push(x, y);
  if (pts.length < 200) return 0;
  for (let a = -8; a <= 8; a += 0.25) {
    const t = Math.tan(a * Math.PI / 180);
    const hist = new Float32Array(h + w);
    for (let i = 0; i < pts.length; i += 2) {
      const yy = Math.round(pts[i + 1] - (pts[i] - w / 2) * t) + (w >> 1);
      if (yy >= 0 && yy < hist.length) hist[yy]++;
    }
    let sc = 0;
    for (let i = 0; i < hist.length; i++) sc += hist[i] * hist[i];
    if (sc > bestScore) { bestScore = sc; best = a; }
  }
  return best;
}

function rotated(bmp, deg) {
  const r = -deg * Math.PI / 180;
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2);
  x.rotate(r);
  x.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  return c;
}

async function findLines(blob) {
  const bmp = await createImageBitmap(blob);
  // 1. Straighten: find the tilt that makes the lines of writing most distinct
  const probe = analyse(bmp, 0);
  const angle = bestAngle(probe.coloured ? { ...probe, ink: probe.rule } : probe) || bestAngle(probe);
  const src = angle ? rotated(bmp, angle) : bmp;
  const page = angle ? analyse(src, 0) : probe;
  const { w, h, s, ink } = page;

  // Ignore margin lines and page edges: columns that are "ink" most of the way down
  const colSum = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) colSum[x] += ink[y * w + x];
  const badCol = new Uint8Array(w);
  for (let x = 0; x < w; x++) if (colSum[x] > h * 0.45) badCol[x] = 1;
  // spread a little so a slightly slanted margin line is fully ignored
  const badCol2 = badCol.slice();
  for (let x = 0; x < w; x++) if (badCol[x]) for (let d = -3; d <= 3; d++) if (x + d >= 0 && x + d < w) badCol2[x + d] = 1;

  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) if (ink[y * w + x] && !badCol2[x]) c++;
    // A row that is dark almost all the way across is a printed rule or edge, not writing
    rows[y] = c > w * 0.4 ? 0 : c;
  }

  const ruled = findRules(page);
  if (ruled) return cropLines(src, s, w, h, ink, badCol2, rulesToLines(ruled, rows, w, h), ruled.gap, true);

  // Lines of writing repeat at a steady spacing (especially on ruled paper).
  // Find that spacing, then find each line's centre.
  const smooth = (arr, k) => {
    const o = new Float32Array(arr.length);
    let acc = 0;
    const q = [];
    for (let y = 0; y < arr.length + k; y++) {
      if (y < arr.length) { acc += arr[y]; q.push(arr[y]); }
      if (q.length > 2 * k + 1) acc -= q.shift();
      const c = y - k;
      if (c >= 0 && c < arr.length) o[c] = acc / q.length;
    }
    return o;
  };
  const sm = smooth(rows, Math.max(1, Math.round(h / 400)));
  let mean = 0;
  for (let y = 0; y < h; y++) mean += sm[y];
  mean /= h;
  if (mean <= 0) return [];
  let period = 0, bestC = -Infinity;
  const minLag = Math.max(8, Math.round(h / 60)), maxLag = Math.round(h / 5);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    for (let y = 0; y + lag < h; y++) c += (sm[y] - mean) * (sm[y + lag] - mean);
    c /= (h - lag);
    if (c > bestC) { bestC = c; period = lag; }
  }
  // Prefer the shortest spacing that fits nearly as well (avoids picking every other line)
  for (let div = 3; div >= 2; div--) {
    const lag = Math.round(period / div);
    if (lag < minLag) continue;
    let c = 0;
    for (let y = 0; y + lag < h; y++) c += (sm[y] - mean) * (sm[y + lag] - mean);
    c /= (h - lag);
    if (c > bestC * 0.7) { period = lag; break; }
  }

  const wide = smooth(rows, Math.max(1, Math.round(period / 5)));
  const peaks = [];
  const gapMin = Math.round(period * 0.6);
  const order = Array.from({ length: h }, (_, i) => i).sort((p, q) => wide[q] - wide[p]);
  const taken = new Uint8Array(h);
  const top = wide[order[0]];
  for (const y of order) {
    if (wide[y] < top * 0.12) break;
    if (taken[y]) continue;
    peaks.push(y);
    for (let d = -gapMin; d <= gapMin; d++) if (y + d >= 0 && y + d < h) taken[y + d] = 1;
  }
  peaks.sort((p, q) => p - q);

  // Boundaries: the quietest row between neighbouring centres
  const lines = [];
  for (let i = 0; i < peaks.length; i++) {
    const cut = (a, b) => {
      let best = Math.round((a + b) / 2), v = Infinity;
      for (let y = a + Math.round((b - a) * 0.25); y <= b - Math.round((b - a) * 0.25); y++) if (sm[y] < v) { v = sm[y]; best = y; }
      return best;
    };
    const a = i ? cut(peaks[i - 1], peaks[i]) : Math.max(0, peaks[i] - Math.round(period * 0.6));
    const b = i < peaks.length - 1 ? cut(peaks[i], peaks[i + 1]) : Math.min(h, peaks[i] + Math.round(period * 0.6));
    let total = 0;
    for (let y = a; y < b; y++) total += rows[y];
    if (total < w * 0.03) continue;
    lines.push([a, b]);
  }
  const mh = period;

  return cropLines(src, s, w, h, ink, badCol2, lines, mh, false);
}

/* Writing sits on the ruled lines: each gap between two rules is one line slot */
function rulesToLines({ rows: r, gap }, inkRows, w, h) {
  const slots = [[Math.max(0, r[0] - gap), r[0]]];
  for (let i = 1; i < r.length; i++) {
    const d = r[i] - r[i - 1];
    const n = Math.max(1, Math.round(d / gap));   // a rule may have been missed
    for (let k = 0; k < n; k++) slots.push([Math.round(r[i - 1] + d * k / n), Math.round(r[i - 1] + d * (k + 1) / n)]);
  }
  slots.push([r[r.length - 1], Math.min(h, r[r.length - 1] + gap)]);
  const lines = [];
  for (const [a, b] of slots) {
    // The body of the letters sits just above the lower rule; tails from the line above don't count
    let body = 0;
    for (let y = a + Math.round((b - a) * 0.4); y < b; y++) body += inkRows[y] || 0;
    if (body > w * 0.03) lines.push([a, b]);
  }
  return lines;
}

function cropLines(src, s, w, h, ink, badCol, lines, mh, ruled) {
  const out = [];
  for (let li = 0; li < lines.length; li++) {
    const [a, b] = lines[li];
    const top = Math.max(0, a - Math.round(mh * (ruled ? 0.15 : 0.12)));
    const bot = Math.min(h, b + Math.round(mh * (ruled ? 0.22 : 0.12)));
    let x0 = w, x1 = 0;
    for (let y = a; y < b; y++) {
      for (let x = 0; x < w; x++) {
        if (ink[y * w + x] && !badCol[x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      }
    }
    if (x1 <= x0) continue;
    const padX = Math.round(mh * 0.5);
    x0 = Math.max(0, x0 - padX); x1 = Math.min(w, x1 + padX);
    const sx = Math.round(x0 / s), sy = Math.round(top / s);
    const sw = Math.round((x1 - x0) / s), sh = Math.round((bot - top) / s);
    // TrOCR looks at a 384x384 picture, so a line about 96 px tall keeps enough detail
    const scale = Math.min(1, 96 / sh);
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(sw * scale)); c.height = Math.max(8, Math.round(sh * scale));
    const cc = c.getContext('2d');
    cc.imageSmoothingQuality = 'high';
    cc.fillStyle = '#fff'; cc.fillRect(0, 0, c.width, c.height);
    cc.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    out.push(c);
  }
  return out;
}

/* =========================================================
   Background handwriting reader client
   ========================================================= */
const HTR = (() => {
  let worker = null;
  let failed = null;       // last load error, so we can fall back
  let nextId = 1;
  const waiting = new Map();
  const listeners = new Set();

  function start() {
    if (worker) return worker;
    worker = new Worker('htr-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'download' || data.type === 'ready') {
        for (const fn of listeners) fn(data);
        return;
      }
      const w = waiting.get(data.id);
      if (data.type === 'error' && data.id == null) {
        failed = data.message;
        for (const fn of listeners) fn({ type: 'failed', message: data.message });
        return;
      }
      if (!w) return;
      waiting.delete(data.id);
      if (data.type === 'result') w.resolve(data.text);
      else { failed = data.message; w.reject(new Error(data.message)); }
    };
    worker.onerror = (e) => {
      failed = (e && e.message) || 'The handwriting reader could not start';
      for (const w of waiting.values()) w.reject(new Error(failed));
      waiting.clear();
      worker = null;
      for (const fn of listeners) fn({ type: 'failed', message: failed });
    };
    return worker;
  }

  function readLine(canvas) {
    const c = canvas.getContext('2d');
    const { data } = c.getImageData(0, 0, canvas.width, canvas.height);
    const rgb = new Uint8ClampedArray(canvas.width * canvas.height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      start().postMessage({ type: 'read', id, buffer: rgb.buffer, width: canvas.width, height: canvas.height }, [rgb.buffer]);
    });
  }

  return {
    readLine,
    warm: () => start().postMessage({ type: 'warm' }),
    onEvent: (fn) => listeners.add(fn),
    lastError: () => failed,
    supported: () => typeof Worker !== 'undefined' && typeof createImageBitmap !== 'undefined',
  };
})();

/* =========================================================
   Learning from corrections
   When a page is saved, the words Dad changed are compared with what the
   reader produced. Each "read X, meant Y" pair is remembered and applied to
   future pages. Words he uses often also help fix near-misses.
   ========================================================= */
const Learner = (() => {
  const key = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  const words = (t) => String(t || '').split(/\s+/).filter(Boolean);

  // Word-level alignment (longest common subsequence), returns replaced pairs
  function diffPairs(machine, fixed) {
    const a = words(machine), b = words(fixed);
    if (!a.length || !b.length || a.length * b.length > 4e6) return [];
    const ka = a.map(key), kb = b.map(key);
    const n = a.length, m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i][j] = ka[i] === kb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const pairs = [];
    let i = 0, j = 0, ra = [], rb = [];
    const flush = () => {
      if (ra.length && ra.length === rb.length) {
        for (let t = 0; t < ra.length; t++) {
          const x = key(ra[t]), y = key(rb[t]);
          if (x && y && x !== y) pairs.push([x, rb[t].replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')]);
        }
      }
      ra = []; rb = [];
    };
    while (i < n && j < m) {
      if (ka[i] === kb[j]) { flush(); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) ra.push(a[i++]);
      else rb.push(b[j++]);
    }
    while (i < n) ra.push(a[i++]);
    while (j < m) rb.push(b[j++]);
    flush();
    return pairs;
  }

  let fixes = new Map();   // machine word -> Map(corrected word -> count)
  let vocab = new Map();   // word -> count, from checked pages

  function rebuild(pages) {
    fixes = new Map(); vocab = new Map();
    for (const p of pages) {
      for (const [x, y] of p.learned || []) {
        if (!fixes.has(x)) fixes.set(x, new Map());
        const m = fixes.get(x);
        m.set(y, (m.get(y) || 0) + 1);
      }
      if (p.reviewed) for (const w of words(p.text)) {
        const k = key(w);
        if (k.length >= 3) vocab.set(k, (vocab.get(k) || 0) + 1);
      }
    }
  }

  function within1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, e = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++e > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return e + (a.length - i) + (b.length - j) <= 1;
  }

  function matchCase(orig, rep) {
    if (orig === orig.toUpperCase() && orig.length > 1) return rep.toUpperCase();
    if (orig[0] && orig[0] === orig[0].toUpperCase() && orig[0] !== orig[0].toLowerCase()) return rep[0].toUpperCase() + rep.slice(1);
    return rep;
  }

  function fixWord(tok) {
    const m = tok.match(/^([^\p{L}\p{N}']*)(.*?)([^\p{L}\p{N}']*)$/u);
    if (!m || !m[2]) return tok;
    const [, pre, core, post] = m;
    const k = core.toLowerCase();
    const opts = fixes.get(k);
    if (opts) {
      const ranked = [...opts.entries()].sort((a, b) => b[1] - a[1]);
      if (!ranked[1] || ranked[0][1] > ranked[1][1]) return pre + matchCase(core, ranked[0][0]) + post;
    }
    if (k.length >= 6 && !vocab.has(k)) {
      let best = null, bestN = 1;
      for (const [v, n] of vocab) if (n > bestN && within1(k, v)) { best = v; bestN = n; }
      if (best) return pre + matchCase(core, best) + post;
    }
    return tok;
  }

  function apply(text) {
    return String(text || '').split('\n').map((line) => line.split(/(\s+)/).map((t) => (/\s/.test(t) || !t ? t : fixWord(t))).join('')).join('\n');
  }

  return { diffPairs, rebuild, apply, count: () => fixes.size };
})();
