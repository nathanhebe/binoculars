// Speed: on a cold start, with every place-name server slow or dead, names must still be up
// within seconds, and a second visit must not fetch again what it already has.
// Terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/speed.e2e.cjs [outdir]
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const MARBELLA = '?lat=36.5068&lon=-4.886&heading=215&pitch=0.3&nocam=1&autostart=1';
const PLACE_HOSTS = /\/interpreter|tiles\.openfreemap\.org/;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};
// The names on screen now, and which of them are bundled mountains.
const onScreen = (p) =>
  p.evaluate(() => {
    const w = window.__binoculars?.world;
    // Small labels, and the name under the crosshair.
    const names = [...document.querySelectorAll('.label:not([hidden]) .n, #target:not([hidden]) .t-name')].map((l) => l.textContent);
    const peaks = new Set((w?.places ?? []).filter((x) => x.kind === 'peak' && x.id.startsWith('nep')).map((x) => x.name));
    return { names, peaks: names.filter((n) => peaks.has(n)) };
  });

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const errors = [];

  // 1. Fault: with every place-name server held, mountains have no name until OpenStreetMap
  // answers. Edge: nothing from Overpass or the map tiles ever answers, on a cold start.
  {
    const ctx = await b.newContext({ viewport: { width: 430, height: 860 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    const held = [];
    await p.route(PLACE_HOSTS, (r) => held.push(r));
    const t0 = Date.now();
    await p.goto(BASE + MARBELLA);
    let seen = { names: [], peaks: [] };
    while (Date.now() - t0 < 5000 && !(seen.peaks.length && seen.names.length > seen.peaks.length)) {
      await p.waitForTimeout(200);
      seen = await onScreen(p);
    }
    check('towns and a bundled mountain labelled within 5 s with every place server held',
      seen.peaks.length > 0 && seen.names.length > seen.peaks.length,
      `${((Date.now() - t0) / 1000).toFixed(1)} s, ${held.length} requests held, labels: ${seen.names.join(', ')}`);
    await p.screenshot({ path: `${OUT}/speed-held.png` });
    for (const r of held.splice(0)) await r.abort().catch(() => {});
    await ctx.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})();
