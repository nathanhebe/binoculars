// Fault: until OpenStreetMap answers there are no place names at all, so on a slow or dead
// server the view stays empty for minutes. Here it never answers; towns and cities from the
// bundled file must still be labelled within 15 s of start.
// Terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/loading.e2e.cjs [outdir]
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  // 1. Overpass never answers.
  const held = [];
  await p.route(/\/interpreter/, (r) => held.push(r));
  await p.goto(BASE + '?nocam=1');
  await p.evaluate(() => localStorage.clear());
  const t0 = Date.now();
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=215&pitch=0.3&nocam=1&autostart=1');
  const shown = await p
    .waitForFunction(() => {
      const w = window.__binoculars?.world;
      const names = (w?.places ?? []).map((x) => x.name);
      return names.includes('Tangier') && names.includes('Málaga') && document.querySelectorAll('.label:not([hidden])').length > 0;
    }, null, { timeout: 15000, polling: 200 })
    .then(() => true, () => false);
  const labels = await p.$$eval('.label:not([hidden]) .n', (ls) => ls.map((l) => l.textContent));
  check('bundled towns labelled while place names never answer', shown,
    `${((Date.now() - t0) / 1000).toFixed(1)} s, ${held.length} requests held, labels: ${labels.join(', ')}`);
  await p.screenshot({ path: `${OUT}/loading-held.png` });
  for (const r of held.splice(0)) await r.abort().catch(() => {});
  await p.unroute(/\/interpreter/);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
