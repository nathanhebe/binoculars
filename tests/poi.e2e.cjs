// Points of interest: the Food, Shops, Travel and Sights chips above the bottom bar, the places
// they bring into view, and what the card and the details sheet say about one.
// Map tiles come from tests/fixtures/ofm (zoom 14 holds a few real places in Marbella's old
// town, about 400 m north of the viewer); Overpass from tests/fixtures/marbella-overpass.json,
// and one place's opening hours and website from tests/fixtures/poi-details.json. Terrain comes
// from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/poi.e2e.cjs <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
const PLACES = fs.readFileSync(path.join(__dirname, 'fixtures/marbella-overpass.json'), 'utf8');
const DETAILS = fs.readFileSync(path.join(__dirname, 'fixtures/poi-details.json'), 'utf8');
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
  // One place's details ("out tags;") get the details fixture; the area queries get the places.
  await ctx.route(/\/interpreter/, (r) => {
    const q = decodeURIComponent(r.request().postData() || '');
    r.fulfill({ contentType: 'application/json', body: /out tags;/.test(q) ? DETAILS : PLACES });
  });
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
  check('five chips, Food, Shops, Travel, Sights and Stay, all off at first',
    cs.map((c) => c.text).join(',') === 'Food,Shops,Travel,Sights,Stay' && cs.every((c) => !c.on), JSON.stringify(cs.map((c) => [c.text, c.on])));
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

  // 3. A restaurant's details: its type, hours, and a website only when it is a real web address.
  const open = (name) =>
    attempt(async () => {
      // Face the place so it is the one under the reticle, then tap its card.
      await p.evaluate((n) => {
        const x = window.__binoculars.world.pois?.find((q) => q.name === n);
        if (x) Object.assign(window.__binoculars.view, { heading: x.brg, pitch: x.angle });
      }, name);
      await p.waitForFunction((n) => document.querySelector('#target .t-name')?.textContent === n, name, { timeout: 5000 });
      await p.click('#target', { timeout: 3000 });
      await p.waitForFunction(() => !document.getElementById('info').hidden, null, { timeout: 3000 });
      // Hours and website come from OpenStreetMap after the sheet opens.
      await p.waitForFunction(() => !document.getElementById('info-hours-row')?.hidden, null, { timeout: 8000 }).catch(() => {});
      return p.evaluate(() => {
        const t = (id) => document.getElementById(id)?.textContent ?? '';
        const site = document.getElementById('info-website');
        return {
          lead: t('info-lead'),
          kind: t('info-kind'),
          hours: t('info-hours'),
          links: [...document.querySelectorAll('#info a')].map((a) => [a.textContent, a.getAttribute('href'), a.rel, a.hidden]),
          siteShown: !!site && !site.closest('[hidden]') && !site.hidden,
          siteHref: site?.getAttribute('href') ?? null,
        };
      });
    });
  let info = await open('El Cortijo');
  check('the sheet says what kind of place it is', typeof info === 'object' && /a restaurant/.test(info.lead) && /Food · Restaurant/.test(info.kind), JSON.stringify(info));
  check('the sheet shows its opening hours', typeof info === 'object' && info.hours === 'Mo-Su 12:00-23:30', JSON.stringify(info?.hours ?? info));
  check('a javascript: website is not shown as a link',
    typeof info === 'object' && !info.siteShown && !info.links.some(([, href]) => /^javascript:/i.test(href || '')), JSON.stringify(info?.links ?? info));
  await p.screenshot({ path: `${OUT}/poi-sheet-el-cortijo.png` });
  await p.click('#info .close').catch(() => {});
  info = await open('Casa del Corregidor');
  check('a web address is a link that opens in a new tab with rel=noopener',
    typeof info === 'object' && info.siteShown && info.siteHref === 'https://example.com/casa-del-corregidor' &&
    info.links.some(([, href, rel]) => href === info.siteHref && /noopener/.test(rel)), JSON.stringify(info?.links ?? info));
  await p.screenshot({ path: `${OUT}/poi-sheet-corregidor.png` });
  await p.click('#info .close').catch(() => {});

  // 4. The card under the reticle: point straight at El Cortijo.
  const cortijo = await p.evaluate(() => window.__binoculars.world.pois?.find((x) => x.name === 'El Cortijo') ?? null);
  if (cortijo) {
    await p.evaluate(([brg, angle]) => Object.assign(window.__binoculars.view, { heading: brg, pitch: angle }), [cortijo.brg, cortijo.angle]);
    await p.waitForFunction(() => /^Restaurant · /.test(document.querySelector('#target .t-meta')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  }
  const cardMeta = await p.evaluate(() => [document.querySelector('#target .t-name')?.textContent, document.querySelector('#target .t-meta')?.textContent]);
  check('the card under the reticle says "Restaurant · distance"', FOOD.includes(cardMeta[0]) && /^Restaurant · \d+ m$/.test(cardMeta[1] || ''), JSON.stringify(cardMeta));
  await p.screenshot({ path: `${OUT}/poi-card.png` });

  // 5. Facing the sea there is no food: a short note says so; facing the old town it goes.
  await p.evaluate(() => Object.assign(window.__binoculars.view, { heading: 215, pitch: 0.3 }));
  const hint = await p
    .waitForFunction(() => {
      const el = document.getElementById('chip-hint');
      // "Looking for food places…" may come first while the tiles this way load.
      return el && !el.hidden && !/^Looking/.test(el.textContent) && el.textContent;
    }, null, { timeout: 8000 })
    .then((h) => h.jsonValue(), () => null);
  check('facing the sea with Food on, a note says "No food places this way"', hint === 'No food places this way', String(hint));
  await p.screenshot({ path: `${OUT}/poi-215-food-on-hint.png` });
  await p.evaluate(() => Object.assign(window.__binoculars.view, { heading: 20, pitch: 1 }));
  const gone = await p
    .waitForFunction(() => document.getElementById('chip-hint')?.hidden, null, { timeout: 5000 })
    .then(() => true, () => false);
  check('facing the old town the note goes', gone);

  // 6. Food off again hides them.
  await p.evaluate(() => Object.assign(window.__binoculars.view, { heading: 20, pitch: 1 }));
  r = await attempt(() => chip('Food'));
  check('with Food turned off the restaurants go', r === undefined && (await waitFood(false)), JSON.stringify(await foodLabels()));
  await p.screenshot({ path: `${OUT}/poi-oldtown-food-off.png` });

  // 7. Fault: zooming in names nothing but hills unless a chip is on; or zooming, alone or with a
  // chip, fetches a wide fan of detailed tiles (45-140 KB each in a town) rather than the narrow
  // wedge looked at out to 16 km; or, as the wedge is planned again every 5/zoom°, a slow turn
  // asks for a fresh wedge at each step; or a budget per place stops the detailed tiles partway
  // round, so the last directions faced name nothing, even one set so high that only a few of
  // them do. Edge: a full turn at 8x in 5° steps,
  // settling at each, in a fresh browser; the 16 km circle round Marbella holds 239 tiles, of
  // which a turn in 5° steps asks 238, so any wider wedge asks all 239.
  for (const food of [false, true]) {
    const ctx2 = await b.newContext({ viewport: { width: 430, height: 860 } });
    await ctx2.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: PLACES }));
    const asked2 = await routeTiles(ctx2);
    const q = await ctx2.newPage();
    const z14 = () => asked2.filter((t) => /\/14\/\d+\/\d+\.pbf$/.test(t)).length;
    let lastQuarter = 0;
    const sweep = async () => {
      for (let h = 0; h < 360; h += 5) {
        if (h === 270) lastQuarter = z14();
        await q.evaluate((deg) => Object.assign(window.__binoculars.view, { heading: deg, pitch: 0.3 }), h);
        await q.waitForTimeout(700);
      }
      lastQuarter = z14() - lastQuarter;
    };
    await q.goto(`${BASE}?${MARBELLA}&heading=0&pitch=0.3&nocam=1&autostart=1`);
    await q.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 240000, polling: 500 });
    await q.evaluate(() => { window.__binoculars.view.zoomTarget = 8; window.__binoculars.view.zoom = 8; });
    if (food) await q.click('#chips button:text-is("Food")');
    const before = z14();
    await sweep();
    const n = z14() - before;
    check(`at 8x ${food ? 'with Food on' : 'with every chip off'} a full turn asks for 220 to 238 detailed tiles (16 km)`, n >= 220 && n <= 238, `${n} asked`);
    check(`at 8x ${food ? 'with Food on' : 'with every chip off'} the last quarter of a full turn still asks for detailed tiles`, lastQuarter > 0, `${lastQuarter} asked`);
    await ctx2.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
