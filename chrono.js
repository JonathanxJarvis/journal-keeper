/* Dates and order.
   A page's date can be a full day (1984-06-12), a month (1984-06) or a year (1984).
   Pages without a date get their place from the dated pages around them in the
   same journal: "between 3 March 1984 and 12 June 1984". */
const Chrono = (() => {
  const RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
  const LONG = { year: 'numeric', month: 'long', day: 'numeric' };

  function valid(s) {
    const m = RE.exec(String(s || '').trim());
    if (!m) return false;
    if (m[2] && (+m[2] < 1 || +m[2] > 12)) return false;
    if (m[3] && (+m[3] < 1 || +m[3] > 31)) return false;
    return true;
  }

  // Turn what a person types ("12 June 1984", "6/1984", "1984") into YYYY[-MM[-DD]], or '' if unclear.
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function normalize(input) {
    const s = String(input || '').trim().toLowerCase();
    if (!s) return '';
    if (valid(s)) return s;
    const pad = (n) => String(n).padStart(2, '0');
    let m;
    if ((m = /^(\d{4})[/.](\d{1,2})(?:[/.](\d{1,2}))?$/.exec(s))) {
      return m[3] ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : `${m[1]}-${pad(m[2])}`;
    }
    if ((m = /^(\d{1,2})[/.-](\d{4})$/.exec(s))) return `${m[2]}-${pad(m[1])}`;
    if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) {
      // Day first unless that can't be right (European order; 06/12/1984 = 6 December)
      let d = +m[1], mo = +m[2];
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];
      return `${m[3]}-${pad(mo)}-${pad(d)}`;
    }
    const words = s.replace(/[,.]/g, ' ').split(/\s+/).filter(Boolean);
    let y = '', mo = '', d = '';
    for (const w of words) {
      if (/^\d{4}$/.test(w)) y = w;
      else if (/^\d{1,2}(st|nd|rd|th)?$/.test(w)) d = pad(parseInt(w, 10));
      else {
        const i = MONTHS.indexOf(w.slice(0, 3));
        if (i >= 0) mo = pad(i + 1);
      }
    }
    if (!y) return '';
    const out = mo ? (d ? `${y}-${mo}-${d}` : `${y}-${mo}`) : y;
    return valid(out) ? out : '';
  }

  function format(s) {
    if (!valid(s)) return '';
    const [y, m, d] = s.split('-').map(Number);
    if (!m) return String(y);
    const dt = new Date(y, m - 1, d || 1);
    if (!d) return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    return dt.toLocaleDateString(undefined, LONG);
  }

  const year = (s) => (valid(s) ? s.slice(0, 4) : '');

  /* For one journal's pages in page order, work out each page's place in time.
     Returns Map id -> { kind, label, short, key, from, to, odd }
       kind: 'dated' | 'between' | 'after' | 'before' | 'none'
       key:  sort key used to merge journals into one timeline
       odd:  true when a written date is earlier than a date before it in the book */
  function annotate(pages) {
    const out = new Map();
    const dated = [];
    pages.forEach((p, i) => { if (valid(p.dateWritten)) dated.push(i); });
    let prev = -1;
    let lastDate = '';
    let di = 0;
    pages.forEach((p, i) => {
      if (di < dated.length && dated[di] === i) {
        const d = p.dateWritten;
        out.set(p.id, {
          kind: 'dated', label: format(d), short: format(d), key: d, from: d, to: d,
          odd: !!lastDate && d < lastDate.slice(0, d.length),
        });
        lastDate = d;
        prev = i; di++;
        return;
      }
      const before = prev >= 0 ? pages[prev].dateWritten : '';
      const after = di < dated.length ? pages[dated[di]].dateWritten : '';
      let info;
      if (before && after) {
        info = before === after
          ? { kind: 'between', label: `Also ${format(before)}`, short: `~ ${format(before)}` }
          : { kind: 'between', label: `Between ${format(before)} and ${format(after)}`, short: `${format(before)} – ${format(after)}` };
      } else if (before) {
        info = { kind: 'after', label: `After ${format(before)}`, short: `after ${format(before)}` };
      } else if (after) {
        info = { kind: 'before', label: `Before ${format(after)}`, short: `before ${format(after)}` };
      } else {
        info = { kind: 'none', label: 'No date yet', short: 'no date' };
      }
      // Undated pages sort right after the dated page before them (or just before the next one).
      info.key = before || after || '9999';
      info.from = before; info.to = after; info.odd = false;
      out.set(p.id, info);
    });
    return out;
  }

  // Years a list of annotated pages covers, e.g. "1978 – 1985"
  function span(pages, info) {
    let lo = '', hi = '';
    for (const p of pages) {
      const i = info.get(p.id);
      if (!i || i.kind !== 'dated') continue;
      const y = i.key.slice(0, 4);
      if (!lo || y < lo) lo = y;
      if (!hi || y > hi) hi = y;
    }
    if (!lo) return '';
    return lo === hi ? lo : `${lo} – ${hi}`;
  }

  return { valid, normalize, format, year, annotate, span };
})();
if (typeof module !== 'undefined') module.exports = Chrono;
