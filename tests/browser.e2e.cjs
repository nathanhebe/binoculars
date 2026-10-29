// End-to-end checks of the user paths in a real Chromium, phone-sized, against the live map
// servers (place names take a few minutes to arrive). Run from the repo root:
//   python3 -m http.server 8765 &
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/browser.e2e.cjs <screenshot dir>
const { chromium } = require('playwright');
const OUT = process.argv[2];
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2, hasTouch: true });
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && !/status of 50\d|status of 429/.test(m.text()) && errors.push(m.text()));
  };
  let p = await ctx.newPage(); watch(p);
  const st = (q) => p.evaluate(q);
  const readout = () => p.textContent('#heading');
  const labels = () => p.$$eval('.label:not([hidden])', (ls) => ls.map((l) => l.querySelector('.n').textContent));
  const ready = async () => {
    await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
    await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 420000, polling: 1000 });
    await p.waitForTimeout(600);
  };

  // Pages sites under one github.io account share an origin: the offline helper must leave
  // other sites' caches alone (fault: it deletes every cache that isn't its own).
  await p.goto(BASE + 'icons/icon.svg');
  await p.evaluate(() => caches.open('another-site-v1'));

  // 1. Real network: Marbella seafront facing Jebel Musa.
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=215&pitch=0.3&nocam=1&autostart=1');
  // The app registers it only over https; register it here so the local server runs it too.
  await p.evaluate(async (u) => { await navigator.serviceWorker.register(u); await navigator.serviceWorker.ready; }, BASE + 'sw.js');
  check("offline helper keeps other sites' caches", await p.evaluate(() => caches.has('another-site-v1')));
  await ready();
  const banner = await p.$$eval('#banner > div', (d) => d.map((x) => x.textContent));
  check('banner says Africa / Morocco facing Jebel Musa', banner[0] === 'AFRICA' && banner[1] === 'Morocco', banner.join(' | '));
  let ls = await labels();
  check('Jebel Musa and Rock of Gibraltar labelled', ls.includes('Jebel Musa') && ls.includes('Rock of Gibraltar'), ls.join(', '));
  check('no duplicate labels', new Set(ls).size === ls.length, ls.join(', '));
  await p.screenshot({ path: `${OUT}/1-africa.png` });

  // Save what loaded into the app's own cache so later loads are instant.
  const n = await st(() => {
    const w = window.__binoculars.world;
    const items = w.places.map(({ id, name, kind, lat, lon, ele, height, population, wikipedia }) => ({ id, name, kind, lat, lon, ele, height, population, wikipedia }));
    localStorage.setItem('binoculars:places:v1', JSON.stringify({ t: Date.now(), lat: w.lat, lon: w.lon, range: 150, items }));
    return items.length;
  });
  check('places loaded from the live server', n > 500, `${n} places`);

  // 2. Arrow keys and drag pan.
  const h0 = await readout();
  for (let i = 0; i < 5; i++) await p.keyboard.press('ArrowRight');
  check('arrow keys turn the view', (await readout()) !== h0, `${h0} -> ${await readout()}`);
  const before = await st(() => window.__binoculars.view.heading);
  await p.mouse.move(300, 500); await p.mouse.down(); await p.mouse.move(150, 500, { steps: 8 }); await p.mouse.up();
  const after = await st(() => window.__binoculars.view.heading);
  check('dragging left turns the view right', ((after - before + 360) % 360) > 5 && ((after - before + 360) % 360) < 60, `${before.toFixed(1)} -> ${after.toFixed(1)}`);

  // 3. Zoom buttons and pinch.
  await p.click('#zooms button[data-zoom="4"]');
  const z4 = await st(() => [window.__binoculars.view.zoom, document.getElementById('video').style.transform, document.querySelector('#zooms .on')?.textContent]);
  check('4× button zooms', z4[0] === 4 && z4[1] === 'scale(4)' && z4[2] === '4×', z4.join(' '));
  await p.screenshot({ path: `${OUT}/2-zoom4.png` });
  await p.click('#zooms button[data-zoom="1"]');
  const pinched = await st(() => {
    const ev = (type, id, x) => document.elementFromPoint(x, 500).dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: 500, bubbles: true }));
    ev('pointerdown', 11, 180); ev('pointerdown', 12, 250);
    ev('pointermove', 11, 110); ev('pointermove', 12, 320);
    ev('pointerup', 11, 110); ev('pointerup', 12, 320);
    return window.__binoculars.view.zoom;
  });
  check('pinch out zooms in', pinched > 2.5 && pinched < 3.5, `zoom ${pinched.toFixed(2)}`);
  await p.click('#zooms button[data-zoom="1"]');

  // 4. Tap a label: info sheet.
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=215&pitch=0.3&nocam=1&autostart=1');
  await ready();
  const musa = p.locator('.label:not([hidden])', { hasText: 'Jebel Musa' }).first();
  await musa.click();
  const info = await st(() => ({
    open: !document.getElementById('info').hidden,
    name: document.getElementById('info-name').textContent,
    dist: document.getElementById('info-distance').textContent,
    vis: document.getElementById('info-visible').textContent,
    map: document.getElementById('info-map').href,
    wiki: document.getElementById('info-wiki').hidden ? null : document.getElementById('info-wiki').href,
  }));
  check('tapping a label opens its details', info.open && info.name === 'Jebel Musa' && /km/.test(info.dist) && /google/.test(info.map), JSON.stringify(info));
  await p.screenshot({ path: `${OUT}/3-info.png` });
  await p.click('#info .close');
  check('details close', await st(() => document.getElementById('info').hidden));

  // 5. Settings.
  await p.click('#settings-btn');
  check('settings open', await st(() => !document.getElementById('settings').hidden));
  await p.screenshot({ path: `${OUT}/4-settings.png` });
  const hiddenBefore = await p.$$eval('.label.hidden-place:not([hidden])', (l) => l.length);
  await p.check('#show-hidden');
  await p.waitForTimeout(300);
  const hiddenAfter = await p.$$eval('.label.hidden-place:not([hidden])', (l) => l.length);
  check('"show hidden places" shows greyed-out places', hiddenBefore === 0 && hiddenAfter > 0, `${hiddenBefore} -> ${hiddenAfter}`);
  await p.uncheck('#show-hidden');
  await p.uncheck('#show-skyline');
  check('skyline toggle saves', await st(() => JSON.parse(localStorage.getItem('binoculars:settings:v1')).showSkyline === false));
  await p.check('#show-skyline');
  const eye0 = await st(() => window.__binoculars.world.eye);
  const vis0 = await st(() => window.__binoculars.world.places.filter((x) => x.visible).length);
  await p.$eval('#hag', (el) => { el.value = 300; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  await p.waitForFunction((e) => window.__binoculars.world.eye > e + 200 && window.__binoculars.world.placesDone, eye0, { timeout: 120000 });
  await p.waitForTimeout(500);
  const vis1 = await st(() => window.__binoculars.world.places.filter((x) => x.visible).length);
  check('raising height above ground lets you see more', vis1 > vis0, `eye ${eye0.toFixed(0)} m: ${vis0} visible; +298 m: ${vis1} visible`);
  await p.$eval('#fov', (el) => { el.value = 80; el.dispatchEvent(new Event('input')); });
  check('field of view setting applies', await st(() => window.__binoculars.settings.fov === 80));
  await p.click('#reset-align');
  check('reset alignment confirms', (await p.textContent('#toast')) === 'Alignment reset.');
  await p.$eval('#hag', (el) => { el.value = 2; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  await p.$eval('#fov', (el) => { el.value = 64; el.dispatchEvent(new Event('input')); });
  await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 120000 });
  await p.click('#settings .close');

  // 6. Looking north from the same spot: Spain.
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=0&pitch=2&nocam=1&autostart=1');
  await ready();
  const bn = await p.$$eval('#banner > div', (d) => d.map((x) => x.textContent));
  ls = await labels();
  check('looking north: Europe / Spain with Spanish places', bn[0] === 'EUROPE' && bn[1] === 'Spain' && ls.length > 0, `${bn.join(' | ')} :: ${ls.join(', ')}`);
  await p.screenshot({ path: `${OUT}/5-north.png` });

  // 7. Demo button from a cold start.
  await p.goto(BASE + '?nocam=1');
  await p.click('#demo-btn');
  await ready();
  ls = await labels();
  check('demo button opens the Marbella view facing Africa', ls.includes('Jebel Musa'), ls.join(', '));

  // 8. Android compass path: absolute orientation events steer the view.
  await p.evaluate(() => {
    const fire = (alpha) => { const e = new DeviceOrientationEvent('deviceorientationabsolute', { alpha, beta: 90, gamma: 0, absolute: true }); dispatchEvent(e); };
    for (let i = 0; i < 30; i++) fire(90);
  });
  await p.waitForTimeout(300);
  const android = await readout();
  check('Android: phone upright, alpha 90 → facing west', /W 27\d°/.test(android) || android.startsWith('W '), android);
  await p.click('#align-btn');
  check('Align mode turns on with a compass', await st(() => window.__binoculars.view.aligning === true));
  await p.mouse.move(300, 400); await p.mouse.down(); await p.mouse.move(250, 400, { steps: 5 }); await p.mouse.up();
  const cal = await st(() => window.__binoculars.settings.calibHeading);
  await p.click('#align-done');
  check('dragging in Align mode nudges the calibration and saves it', cal > 1 && (await st(() => JSON.parse(localStorage.getItem('binoculars:settings:v1')).calibHeading)) === cal, `calib ${cal.toFixed(2)}°`);
  await p.click('#settings-btn'); await p.click('#reset-align'); await p.click('#settings .close');

  // 9. iPhone compass path: relative alpha corrected by webkitCompassHeading.
  const ios = await ctx.newPage(); watch(ios);
  await ios.addInitScript(() => { delete Window.prototype.ondeviceorientationabsolute; delete window.ondeviceorientationabsolute; });
  await ios.goto(BASE + '?nocam=1');
  await ios.click('#demo-btn');
  await ios.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
  await ios.evaluate(() => {
    for (let i = 0; i < 80; i++) {
      const e = new DeviceOrientationEvent('deviceorientation', { alpha: 40, beta: 90, gamma: 0 });
      Object.defineProperty(e, 'webkitCompassHeading', { value: 215 });
      Object.defineProperty(e, 'webkitCompassAccuracy', { value: 10 });
      dispatchEvent(e);
    }
  });
  await ios.waitForTimeout(300);
  const iosHead = await ios.textContent('#heading');
  check('iPhone: compass heading 215 → view faces SW 215°', /SW 21[4-6]°/.test(iosHead), iosHead);
  await ios.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 60000 });
  await ios.waitForTimeout(500);
  const iosBanner = await ios.$$eval('#banner > div', (d) => d.map((x) => x.textContent));
  check('iPhone path: banner Africa / Morocco', iosBanner[1] === 'Morocco', iosBanner.join(' | '));
  await ios.screenshot({ path: `${OUT}/6-iphone-sensor.png` });

  // 10. Install files.
  const man = await p.request.get(BASE + 'manifest.webmanifest');
  const mj = await man.json();
  check('manifest serves with icons', man.ok() && mj.icons.length >= 2, mj.icons.map((i) => i.sizes).join(','));
  for (const f of ['sw.js', 'icons/icon-180.png', 'icons/icon-512.png', 'assets/countries.json']) {
    const r = await p.request.get(BASE + f);
    check(`${f} served`, r.ok(), String(r.status()));
  }
  const sw = await (await p.request.get(BASE + 'sw.js')).text();
  const missing = [];
  for (const m of sw.matchAll(/'(\.\/[^']+|[a-z][^']+\.(?:mjs|css|html|json|png|svg|webmanifest))'/g)) {
    const r = await p.request.get(new URL(m[1], BASE).href);
    if (!r.ok()) missing.push(m[1]);
  }
  check('every file the offline cache lists exists', missing.length === 0, missing.join(','));

  check('no page errors', errors.length === 0, errors.join(' || '));
  await b.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
