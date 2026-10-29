// Zooming in from Marbella towards Morocco: the towns beyond the horizon over the sea, and
// what hides the places that are left out.
// Map tiles come from tests/fixtures/ofm, Overpass from tests/fixtures/marbella-overpass.json;
// terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/zoom.e2e.cjs <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
const PLACES = fs.readFileSync(path.join(__dirname, 'fixtures/marbella-overpass.json'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const MARBELLA = 'lat=36.5068&lon=-4.886';
const SETTLEMENT = ['city', 'town', 'village', 'hamlet'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};

async function open(b, viewport, heading) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: PLACES }));
  await routeTiles(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}?${MARBELLA}&heading=${heading}&pitch=0.3&nocam=1&autostart=1`);
  await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
  await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 240000, polling: 500 });
  await p.waitForTimeout(800);
  return { ctx, p, errors };
}
const look = (p, heading, zoom) =>
  p.evaluate(([h, z]) => {
    const { view } = window.__binoculars;
    Object.assign(view, { heading: h, pitch: 0.3, zoomTarget: z, zoom: z });
  }, [heading, zoom]);
// Labels on screen now, with the place each one stands for.
const labels = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('.label.on:not([hidden])')].map((el) => ({
      name: el.querySelector('.n').textContent,
      meta: el.querySelector('.m').textContent,
      kind: (el.className.match(/\bk-(\w+)/) || [])[1],
      country: el._p?.country ?? null,
      visible: !!el._p?.visible,
      blockedBy: el._p?.blockedBy ?? null,
    }))
  );
const show = (z, ls) => console.log(`  ${z}x: ${ls.map((l) => `${l.name} [${l.kind}${l.blockedBy ? ' ' + l.blockedBy : ''}] ${l.meta}`).join(' | ')}`);

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const errors = [];

  // 1. Facing Morocco across the Strait, the setting for hidden places off.
  {
    const { ctx, p, errors: e } = await open(b, { width: 375, height: 667 }, 215);
    const seen = {};
    for (const z of [1, 2, 4, 8]) {
      await look(p, 215, z);
      await p.waitForTimeout(2500);
      seen[z] = await labels(p);
      await p.screenshot({ path: path.join(OUT, `z${z}.png`) });
      show(z, seen[z]);
    }
    // Jbel Chendir is in sight, a little left of centre, at every zoom: greyed places beyond the
    // horizon must never take its place.
    const chendir = [1, 2, 4, 8].filter((z) => !seen[z].some((l) => l.name === 'Jbel Chendir' && l.visible));
    check('a place in sight keeps its label at every zoom, ahead of places beyond the horizon', chendir.length === 0, chendir.length ? `missing at ${chendir.join(', ')}x` : '');
    const hiddenOff = await p.evaluate(() => !window.__binoculars.settings.showHidden);
    const terrain = [1, 2, 4, 8].flatMap((z) => seen[z].filter((l) => l.blockedBy === 'terrain').map((l) => `${z}x ${l.name}`));
    check('places behind hills stay hidden at every zoom while the setting is off', hiddenOff && terrain.length === 0, terrain.join(', '));

    // Tétouan, M'Diq, Ceuta, Fnideq and Anjra (202-212°) are past the curve of the earth, right
    // of Jebel Musa, which zoomed to 4x is out of frame.
    await look(p, 207, 1);
    await p.waitForTimeout(1500);
    const at1 = await labels(p);
    show('207° 1', at1);
    const curve1 = at1.filter((l) => l.blockedBy === 'curve').map((l) => l.name);
    check('at 1x places below the horizon stay out while the setting is off', curve1.length === 0, curve1.join(', '));
    await look(p, 207, 4);
    await p.waitForTimeout(1500);
    const at4 = await labels(p);
    show('207° 4', at4);
    await p.screenshot({ path: path.join(OUT, 'beyond-4x.png') });
    const moroccan = at4.filter((l) => l.country === 'Morocco' && SETTLEMENT.includes(l.kind) && l.blockedBy === 'curve').map((l) => l.name);
    check('at 4x the Moroccan towns past the curve of the earth are labelled', moroccan.length >= 2, moroccan.join(', ') || 'none');
    const curve4 = at4.filter((l) => l.blockedBy === 'curve');
    check('each is greyed and tagged beyond the horizon',
      curve4.length > 0 && curve4.every((l) => /^Beyond horizon · /.test(l.meta)), curve4.map((l) => `${l.name}: ${l.meta}`).join(' | ') || 'none');
    const grey = await p.evaluate(() => [...document.querySelectorAll('.label.on:not([hidden])')].filter((el) => el._p?.blockedBy === 'curve').every((el) => el.classList.contains('hidden-place')));
    check('places beyond the horizon are drawn greyed, like other hidden places', curve4.length > 0 && grey);
    errors.push(...e);
    await ctx.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
