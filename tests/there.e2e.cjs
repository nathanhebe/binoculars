// Zooming in on a stretch of coast names what is there — hotels and the like — with no category
// chip on, and lists the things near the middle of the view, nearest first.
// Map tiles come from tests/fixtures/ofm (zoom 14 tile 7968/6405 holds the 16 named hotels and
// hostels on the seafront 1-3.6 km west of the viewer, 264-283 degrees), Overpass from
// tests/fixtures/marbella-overpass.json; terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/there.e2e.cjs <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
const PLACES = fs.readFileSync(path.join(__dirname, 'fixtures/marbella-overpass.json'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const HOTELS = ['Alanda Marbella', 'Hotel Thailandia', 'NH Hoteles', 'Puente Romano', 'Puente Romano Marbella', 'Nobu',
  'Marbella Club Hotel', 'Hotel Bluebelle Marbella', 'Beach Club', 'Hotel NH Marbella', 'Guadalpin',
  'Hotel Senator Marbella Spa', 'Apartamentos Marina mariola', 'Hotel Sultán', 'Hotel Gran Meliá Don Pepe', 'Hapimag Marbella'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};
const z14 = (asked) => asked.filter((t) => /\/14\/\d+\/\d+\.pbf$/.test(t));

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2 });
  await ctx.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: PLACES }));
  const asked = await routeTiles(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}?lat=36.5068&lon=-4.886&heading=274&pitch=0.3&nocam=1&autostart=1`);
  await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
  await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 240000, polling: 500 });
  await p.waitForTimeout(1500);
  const list = () =>
    p.evaluate(() => {
      const el = document.getElementById('there');
      const shown = !!el && !el.hidden && el.getBoundingClientRect().height > 0;
      return { shown, items: shown ? [...el.querySelectorAll('button')].map((x) => x.textContent) : [], box: el?.getBoundingClientRect().toJSON() ?? null };
    });
  const hotelLabels = () =>
    p.evaluate((names) => [...document.querySelectorAll('.label.on:not([hidden]) .n')].map((n) => n.textContent).filter((n) => names.includes(n)), HOTELS);

  // 1. Fault: at 1x the detailed tiles load anyway and cost data nobody asked for. Edge: every chip off.
  const chipsOn = await p.evaluate(() => [...document.querySelectorAll('#chips button')].filter((c) => c.getAttribute('aria-pressed') === 'true').length);
  let l = await list();
  check('at 1x with every chip off no detailed tiles are asked for', chipsOn === 0 && z14(asked).length === 0, `${chipsOn} chips on, ${z14(asked).length} asked`);
  check('at 1x there is no "what\'s there" list', !l.shown, JSON.stringify(l));

  // 2. Fault: zooming on the seafront shows only the hill line (hotels need a chip, and there is
  // no category for them). Edge: 2x, the first zoom step, every chip still off.
  await p.evaluate(() => Object.assign(window.__binoculars.view, { zoomTarget: 2, zoom: 2 }));
  const seen = await p
    .waitForFunction((names) => [...document.querySelectorAll('.label.on:not([hidden]) .n')].some((n) => names.includes(n.textContent)), HOTELS, { timeout: 15000, polling: 250 })
    .then(() => true, () => false);
  const hl = await hotelLabels();
  check('zoomed to 2x with no chip on, the seafront hotels are labelled', seen && hl.length > 0, JSON.stringify(hl));
  await p.waitForTimeout(800);
  l = await list();
  const chips = await p.evaluate(() => document.getElementById('chips').getBoundingClientRect().toJSON());
  const kms = l.items.map((t) => { const m = /· ([\d.]+) (k?m)$/.exec(t); return m ? Number(m[1]) * (m[2] === 'km' ? 1 : 0.001) : NaN; });
  check('at 2x a list above the chips names hotels near the middle of the view',
    l.shown && l.items.some((t) => HOTELS.some((h) => t.startsWith(`${h} · `))) && l.box.bottom <= chips.top + 1, JSON.stringify(l));
  check('the list holds at most 6, nearest first, each "name · type · distance"',
    l.items.length > 0 && l.items.length <= 6 && kms.every((k, i) => !isNaN(k) && (i === 0 || k >= kms[i - 1])), JSON.stringify(l.items));
  await p.screenshot({ path: `${OUT}/there-2x.png` });

  // 3. Tapping an item opens its sheet.
  const first = l.items.find((t) => HOTELS.some((h) => t.startsWith(`${h} · `)));
  const opened = first
    ? await p.click(`#there button:text-is("${first}")`, { timeout: 3000 })
        .then(() => p.waitForFunction(() => !document.getElementById('info').hidden, null, { timeout: 3000 }))
        .then(() => p.evaluate(() => [document.getElementById('info-name')?.textContent, document.getElementById('info-kind')?.textContent]), (e) => String(e).split('\n')[0])
    : 'no hotel in the list';
  check('tapping a hotel in the list opens its sheet, which says it is a place to stay',
    Array.isArray(opened) && first.startsWith(`${opened[0]} · `) && /Stay · Hotel|Stay · Hostel/.test(opened[1] || ''), JSON.stringify(opened));
  await p.screenshot({ path: `${OUT}/there-sheet.png` });

  // 4. Fault: after a height change the list keeps its old buttons, so a tapped item's sheet says
  // hidden or visible from the old height. Edge: an item whose visibility the change flips, its
  // name and distance unchanged.
  await p.click('#info [data-close]');
  const seenAt = () => p.evaluate(() => {
    const ws = [...window.__binoculars.world.pois, ...window.__binoculars.world.places];
    return [...document.querySelectorAll('#there button')].map((x) => {
      const w = ws.find((q) => x.textContent.startsWith(`${q.name} · `));
      return { text: x.textContent, visible: w ? !!w.visible : null };
    });
  });
  // From 5 m the seafront hotels are hidden; from 10 m the same list's hotels are in view.
  const setHeight = async (m) => {
    await p.evaluate((m) => {
      const h = document.getElementById('hag');
      h.value = m;
      h.dispatchEvent(new Event('input'));
      h.dispatchEvent(new Event('change'));
    }, m);
    await p.waitForFunction((m) => window.__binoculars.settings.hag === m && !window.__binoculars.world.busy, m, { timeout: 120000, polling: 100 });
    await p.waitForTimeout(800);
    return seenAt();
  };
  const before = await setHeight(5);
  const after = await setHeight(10);
  const same = after.map((a) => a.text).join() === before.map((x) => x.text).join();
  const flipped = same && after.find((a) => before.some((x) => x.text === a.text && x.visible !== a.visible));
  const sheet = flipped
    ? await p.click(`#there button:text-is("${flipped.text}")`, { timeout: 3000 })
        .then(() => p.waitForFunction(() => !document.getElementById('info').hidden, null, { timeout: 3000 }))
        .then(() => p.textContent('#info-visible'))
    : null;
  check('after a height change a listed place\'s sheet says what is visible from the new height',
    flipped && /^Yes/.test(sheet) === flipped.visible, JSON.stringify({ flipped, sheet, before, after }));

  // 5. Fault: on a phone held sideways, or a short one, the list reaches up over the reticle and
  // the card under it, and the labels are pushed above it off the top. Edge: 390 px tall, where
  // there is no room for even one row, and 667 px, where there is room for a few.
  for (const [w, h] of [[844, 390], [375, 667]]) {
    const c = await b.newContext({ viewport: { width: w, height: h } });
    await c.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: PLACES }));
    await routeTiles(c);
    const q = await c.newPage();
    q.on('pageerror', (e) => errors.push(String(e)));
    await q.goto(`${BASE}?lat=36.5068&lon=-4.886&heading=274&pitch=0.3&nocam=1&autostart=1`);
    await q.waitForFunction(() => window.__binoculars?.world.placesDone, null, { timeout: 240000, polling: 500 });
    await q.evaluate(() => Object.assign(window.__binoculars.view, { zoomTarget: 2, zoom: 2 }));
    await q.waitForFunction(() => window.__binoculars.world.pois.length > 0, null, { timeout: 30000, polling: 250 }).catch(() => {});
    await q.waitForTimeout(2500);
    const lay = await q.evaluate(() => {
      const box = (id) => { const el = document.getElementById(id); const r = el.getBoundingClientRect(); return !el.hidden && r.height > 0 ? r.toJSON() : null; };
      return { there: box('there'), reticle: box('reticle'), target: box('target'), labels: document.querySelectorAll('.label.on:not([hidden])').length };
    });
    const over = (a, b2) => !!(a && b2 && a.top < b2.bottom && b2.top < a.bottom && a.left < b2.right && b2.left < a.right);
    check(`at ${w}x${h} the list stays off the reticle and its card, and places are labelled`,
      !over(lay.there, lay.reticle) && !over(lay.there, lay.target) && lay.labels > 0, JSON.stringify(lay));
    await q.screenshot({ path: `${OUT}/there-${w}x${h}.png` });
    await c.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  const failed = results.filter((r) => !r).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
