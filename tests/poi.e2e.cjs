// Points of interest: the Food, Shops, Travel and Sights chips above the bottom bar, the places
// they bring into view, and what the card and the details sheet say about one.
// Map tiles come from tests/fixtures/ofm (zoom 14 holds a few real places in Marbella's old
// town, about 400 m north of the viewer); Overpass from tests/fixtures/marbella-overpass.json.
// Terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/poi.e2e.cjs <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
const PLACES = fs.readFileSync(path.join(__dirname, 'fixtures/marbella-overpass.json'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const MARBELLA = 'lat=36.5068&lon=-4.886';
const FOOD = ['El Cortijo', 'Casa del Corregidor', 'Taberna El Bordón Marbella', 'Café Simone'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};
// A check whose page step may be missing altogether (no chips at all, say) fails, not crashes.
const attempt = (fn) => fn().catch((e) => `error: ${e.message.split('\n')[0]}`);

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2 });
  await ctx.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: PLACES }));
  const tiles = await routeTiles(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  const ready = async () => {
    await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
    await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 240000, polling: 500 });
    await p.waitForTimeout(800);
  };
  const chips = () =>
    p.evaluate(() =>
      [...document.querySelectorAll('#chips button')].map((c) => ({
        text: c.textContent.trim(),
        on: c.getAttribute('aria-pressed') === 'true',
        box: c.getBoundingClientRect().toJSON(),
      }))
    );
  const chip = (name) => p.click(`#chips button:text-is("${name}")`, { timeout: 3000 });
  // Labels on screen now: name, meta line and box.
  const labels = () =>
    p.evaluate(() =>
      [...document.querySelectorAll('.label.on:not([hidden])')].map((el) => ({
        name: el.querySelector('.n').textContent,
        meta: el.querySelector('.m').textContent,
        box: el.getBoundingClientRect().toJSON(),
      }))
    );
  const foodLabels = async () => (await labels()).filter((l) => FOOD.includes(l.name));
  const waitFood = (want) =>
    p
      .waitForFunction((names) => [...document.querySelectorAll('.label.on:not([hidden]) .n')].some((n) => names.includes(n.textContent)), FOOD, { timeout: 15000, polling: 200 })
      .then(() => true, () => false)
      .then(async (seen) => (want ? seen : (await p.waitForTimeout(1500), (await foodLabels()).length === 0)));

  // 1. Facing the old town, a little to its right so no restaurant sits under the reticle.
  await p.goto(`${BASE}?${MARBELLA}&heading=20&pitch=1&nocam=1&autostart=1`);
  await ready();
  let cs = await chips();
  check('four chips, Food, Shops, Travel and Sights, all off at first',
    cs.map((c) => c.text).join(',') === 'Food,Shops,Travel,Sights' && cs.every((c) => !c.on), JSON.stringify(cs.map((c) => [c.text, c.on])));
  const geom = await p.evaluate(() => {
    const r = (id) => document.getElementById(id)?.getBoundingClientRect();
    return { chips: r('chips')?.toJSON(), hud: r('hud').toJSON(), reticle: r('reticle').toJSON(), w: innerWidth };
  });
  check('the chips sit just above the bottom bar, on screen, clear of the reticle',
    geom.chips && geom.chips.bottom <= geom.hud.top + 8 && geom.chips.top > geom.reticle.bottom + 100 &&
    geom.chips.left >= 0 && geom.chips.right <= geom.w, JSON.stringify(geom.chips));
  check('with Food off no restaurant is labelled', (await foodLabels()).length === 0, JSON.stringify(await foodLabels()));
  await p.screenshot({ path: `${OUT}/poi-oldtown-chips-off.png` });

  let r = await attempt(() => chip('Food'));
  cs = await chips();
  check('tapping Food turns it on', r === undefined && cs.find((c) => c.text === 'Food')?.on, r ?? '');
  const shown = await waitFood(true);
  const food = await foodLabels();
  const chipTop = geom.chips?.top ?? 0;
  check('with Food on a restaurant in view is labelled, with its type, above the chips',
    shown && food.some((l) => /^Restaurant · /.test(l.meta) && l.box.bottom <= chipTop && l.box.left >= 0 && l.box.right <= geom.w),
    JSON.stringify(food));
  const asked = tiles.filter((t) => /^\/[^/]+\/14\//.test(t) || /\/14\/\d+\/\d+\.pbf$/.test(t));
  check('only zoom-14 tiles in the direction looked at are asked for', asked.length > 0 && asked.length <= 6, JSON.stringify(asked));
  await p.screenshot({ path: `${OUT}/poi-oldtown-food-on.png` });

  // 2. The choice is remembered.
  await p.reload();
  await ready();
  cs = await chips();
  check('Food stays on after a reload', cs.find((c) => c.text === 'Food')?.on, JSON.stringify(cs.map((c) => [c.text, c.on])));
  check('and the restaurants come back', await waitFood(true));

  // 3. Food off again hides them.
  r = await attempt(() => chip('Food'));
  check('with Food turned off the restaurants go', r === undefined && (await waitFood(false)), JSON.stringify(await foodLabels()));
  await p.screenshot({ path: `${OUT}/poi-oldtown-food-off.png` });

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
