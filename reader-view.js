/* The page viewer: pages side by side like an open book, turned sideways.
   Two pages at a time on a computer or tablet, one on a phone.
   Turn pages with the arrow keys, a swipe, the mouse wheel, the side buttons,
   or jump anywhere with the slider (which is marked with the years). */
function createReader(host, opts) {
  const o = Object.assign({ onDetails: () => {}, onStar: () => {}, showJournal: false, empty: 'No pages yet.' }, opts);
  host.innerHTML = `
    <div class="reader">
      <div class="rd-bar">
        <button class="icon-btn rd-prev" aria-label="Previous pages"><svg><use href="#i-back"/></svg></button>
        <div class="rd-where"><span class="rd-pos"></span><span class="rd-when"></span></div>
        <button class="btn ghost small rd-text" aria-pressed="false" aria-label="Show the typed text"><svg><use href="#i-text"/></svg><span>Typed text</span></button>
        <button class="icon-btn rd-next" aria-label="Next pages"><svg><use href="#i-next"/></svg></button>
      </div>
      <div class="rd-track" tabindex="0" aria-label="Pages. Use the arrow keys to turn."></div>
      <div class="rd-empty empty" hidden></div>
      <div class="rd-scrub">
        <div class="rd-years"></div>
        <input type="range" class="rd-range" min="0" max="0" value="0" aria-label="Jump through the pages">
      </div>
    </div>`;
  const root = host.firstElementChild;
  const track = root.querySelector('.rd-track');
  const range = root.querySelector('.rd-range');
  const years = root.querySelector('.rd-years');
  let pages = [];
  let index = 0;
  const full = new Map();          // page id -> object URL of the full image (a few dozen kept)

  const perView = () => (track.clientWidth >= 820 ? 2 : 1);
  const leafW = () => track.clientWidth / perView();

  function leafHTML(p, i) {
    const place = placeOf(p);
    const j = journalById(p.journalId);
    const reading = p.ocr && (p.ocr.status === 'waiting' || p.ocr.status === 'reading');
    const text = p.text && p.text.trim()
      ? esc(p.text)
      : `<span class="muted">${reading ? 'Claude is reading this page…' : 'No typed text yet.'}</span>`;
    return `<article class="leaf" data-id="${esc(p.id)}" data-i="${i}" style="--jc:${j ? j.color : '#888'}">
      <div class="leaf-sheet">
        <img class="leaf-img" alt="Page ${p.seq} of ${esc(j ? j.name : 'journal')}" src="${thumbURL(p)}" draggable="false">
        <div class="leaf-text">${p.title ? `<p class="leaf-title">${esc(p.title)}</p>` : ''}${text}</div>
      </div>
      <div class="leaf-cap">
        <span class="leaf-info">
          <span class="leaf-date ${place.kind}${place.odd ? ' odd' : ''}" title="${place.odd ? 'This date is earlier than a date before it in the journal. Check the date or the page order.' : ''}">${esc(place.label)}</span>
          <span class="leaf-where">${o.showJournal && j ? `<i class="dot"></i>${esc(j.name)}, ` : ''}page ${p.seq}</span>
        </span>
        <span class="leaf-acts">
          <button class="icon-btn small leaf-star${p.starred ? ' on' : ''}" aria-pressed="${!!p.starred}" aria-label="${p.starred ? 'Saved for the book' : 'Save for the book'}" title="Save for the book"><svg><use href="#${p.starred ? 'i-star' : 'i-star-o'}"/></svg></button>
          <button class="btn ghost small leaf-details">Details</button>
        </span>
      </div>
    </article>`;
  }

  // Full-size pictures only for the pages on screen and their neighbours
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) loadFull(e.target);
  }, { root: track, rootMargin: '0px 150% 0px 150%' }) : null;

  async function loadFull(leaf) {
    const id = leaf.dataset.id;
    const img = leaf.querySelector('.leaf-img');
    if (full.has(id)) { img.src = full.get(id); return; }
    const blob = await DB.getImage(id).catch(() => null);
    if (!blob || !leaf.isConnected) return;
    const url = URL.createObjectURL(blob);
    full.set(id, url);
    img.src = url;
    if (full.size > 40) {
      const [oldId, oldUrl] = full.entries().next().value;
      full.delete(oldId);
      const old = track.querySelector(`.leaf[data-id="${CSS.escape(oldId)}"] .leaf-img`);
      const p = pages.find((x) => x.id === oldId);
      if (old && p) old.src = thumbURL(p);
      URL.revokeObjectURL(oldUrl);
    }
  }

  function drawYears() {
    years.innerHTML = '';
    const n = pages.length;
    if (n < 2) return;
    let lastYear = '', lastPos = -100;
    pages.forEach((p, i) => {
      const y = yearOf(p);
      if (!y || y === lastYear) return;
      lastYear = y;
      const pos = (i / (n - 1)) * 100;
      if (pos - lastPos < 7) return;   // keep labels from overlapping
      lastPos = pos;
      const b = document.createElement('button');
      b.className = 'rd-year';
      b.textContent = y;
      b.style.left = pos + '%';
      b.onclick = () => go(i, true);
      years.appendChild(b);
    });
  }

  function show(list, startId) {
    for (const u of full.values()) URL.revokeObjectURL(u);
    full.clear();
    pages = list;
    root.querySelector('.rd-empty').hidden = pages.length > 0;
    root.querySelector('.rd-empty').innerHTML = `<p>${o.empty}</p>`;
    track.hidden = !pages.length;
    root.querySelector('.rd-scrub').hidden = pages.length < 2;
    track.innerHTML = pages.map(leafHTML).join('');
    if (io) { io.disconnect(); for (const l of track.children) io.observe(l); }
    range.max = String(Math.max(0, pages.length - 1));
    drawYears();
    const at = startId ? Math.max(0, pages.findIndex((p) => p.id === startId)) : index;
    requestAnimationFrame(() => go(Math.min(at, Math.max(0, pages.length - 1)), true));
  }

  // Make the pages as tall as the window allows, keeping the slider in view
  function fit() {
    if (!root.offsetParent) return;
    const top = track.getBoundingClientRect().top + window.scrollY;
    const below = root.querySelector('.rd-scrub').offsetHeight + 24 + (window.innerWidth < 900 ? 84 : 0);
    track.style.height = Math.max(340, window.innerHeight - top - below) + 'px';
  }

  function go(i, instant) {
    const n = pages.length;
    if (!n) return;
    fit();
    const pv = perView();
    i = Math.max(0, Math.min(n - 1, i));
    if (pv === 2) i -= i % 2;        // keep pages in pairs, like a real open book
    index = i;
    track.scrollTo({ left: i * leafW(), behavior: instant ? 'auto' : 'smooth' });
    status();
  }

  function status() {
    const n = pages.length;
    if (!n) { root.querySelector('.rd-pos').textContent = ''; root.querySelector('.rd-when').textContent = ''; return; }
    const pv = perView();
    const last = Math.min(n, index + pv);
    root.querySelector('.rd-pos').textContent = pv === 2 && last > index + 1 ? `Pages ${index + 1}–${last} of ${n}` : `Page ${index + 1} of ${n}`;
    root.querySelector('.rd-when').textContent = placeOf(pages[index]).label;
    range.value = String(index);
    root.querySelector('.rd-prev').disabled = index <= 0;
    root.querySelector('.rd-next').disabled = index + pv >= n;
  }

  let scrollRAF = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollRAF);
    scrollRAF = requestAnimationFrame(() => {
      const i = Math.round(track.scrollLeft / leafW());
      if (i !== index) { index = Math.max(0, Math.min(pages.length - 1, i)); status(); }
    });
  });

  // A mouse wheel turns the pages too: one notch, one spread.
  let wheelAcc = 0, wheelAt = 0;
  track.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;    // trackpad sideways swipes scroll by themselves
    e.preventDefault();
    const now = Date.now();
    if (now - wheelAt > 250) wheelAcc = 0;
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) > 40 && now - wheelAt > 250) {
      go(index + Math.sign(wheelAcc) * perView());
      wheelAcc = 0; wheelAt = now;
    }
  }, { passive: false });

  range.addEventListener('input', () => go(+range.value, true));
  root.querySelector('.rd-prev').onclick = () => go(index - perView());
  root.querySelector('.rd-next').onclick = () => go(index + perView());
  const textBtn = root.querySelector('.rd-text');
  function toggleText(on) {
    on = on === undefined ? !root.classList.contains('show-text') : on;
    root.classList.toggle('show-text', on);
    textBtn.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('jk-show-text', on ? '1' : ''); } catch { /* not important */ }
  }
  try { if (localStorage.getItem('jk-show-text')) toggleText(true); } catch { /* not important */ }
  textBtn.onclick = () => toggleText();

  track.addEventListener('click', (e) => {
    const leaf = e.target.closest('.leaf');
    if (!leaf) return;
    const p = pages.find((x) => x.id === leaf.dataset.id);
    if (!p) return;
    if (e.target.closest('.leaf-details')) o.onDetails(p, pages);
    else if (e.target.closest('.leaf-star')) o.onStar(p);
    else if (e.target.closest('.leaf-img')) { $('#zoom-img').src = e.target.closest('.leaf-img').src; $('#zoom').hidden = false; loadZoom(p); }
  });
  async function loadZoom(p) {
    const blob = await DB.getImage(p.id).catch(() => null);
    if (blob && !$('#zoom').hidden) $('#zoom-img').src = URL.createObjectURL(blob);
  }

  // Keyboard: works whenever this viewer is on screen and nobody is typing
  document.addEventListener('keydown', (e) => {
    if (!root.offsetParent || !pages.length || !$('#zoom').hidden) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) go(index + perView());
    else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) go(index - perView());
    else if (k === 'Home') go(0);
    else if (k === 'End') go(pages.length - 1);
    else if (k === 't' || k === 'T') toggleText();
    else return;
    e.preventDefault();
  });

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (root.offsetParent) go(index, true); }, 120);
  });

  // Redraw one page (after reading, a date change or a star)
  function refresh(id) {
    const i = pages.findIndex((p) => p.id === id);
    const old = i >= 0 && track.querySelector(`.leaf[data-id="${CSS.escape(id)}"]`);
    if (!old) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = leafHTML(pages[i], i);
    const leaf = tmp.firstElementChild;
    if (full.has(id)) leaf.querySelector('.leaf-img').src = full.get(id);
    old.replaceWith(leaf);
    if (io) io.observe(leaf);
    if (i === index) status();
  }

  return {
    show,
    refresh,
    has: (id) => pages.some((p) => p.id === id),
    currentId: () => (pages[index] ? pages[index].id : null),
    focus: () => track.focus({ preventScroll: true }),
  };
}
