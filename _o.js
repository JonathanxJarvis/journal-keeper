const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await (await b.newContext({ serviceWorkers: 'block' })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://localhost:8765/?' + Date.now()); await p.waitForTimeout(400);
  let ok = 0, bad = [];
  for (const n of 'dad,d_top,d_bot,d_small,d_tilt,d_mid,d_gray,bg,synth,p0,p1,p2,p3,p4'.split(',')) for (const a of [0, 1, 2, 3]) {
    const r = await p.evaluate(async ([u, a]) => {
      const src = await loadImage(await (await fetch(u)).blob());
      const img = a ? renderPage(src, 4 - a, {x0:0,y0:0,x1:1,y1:1}, 4000) : src;  // turn it the wrong way by a quarter-turns
      const t0 = performance.now(); const t = pageTurns(img); return [t, Math.round(performance.now() - t0)];
    }, [`/ud/${n}.jpg`, a]);
    if (r[0] % 4 === a) ok++; else bad.push(`${n} needs ${a}, got ${r[0]}`);
    if (n === 'dad') console.log('time ms', r[1]);
  }
  console.log('right:', ok, 'of 56', bad, errs);
  await b.close();
})();
