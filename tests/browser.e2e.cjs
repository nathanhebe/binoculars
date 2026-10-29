// End-to-end checks of the user paths in a real Chromium, phone-sized. Terrain comes from the
// live server; place names come from tests/fixtures/marbella-overpass.json, because the public
// Overpass servers often take minutes or refuse. Run from the repo root:
//   python3 -m http.server 8765 &
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/browser.e2e.cjs <screenshot dir>
const { chromium } = require('playwright');
const FIXTURE = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/marbella-overpass.json'), 'utf8');
const FIXTURE_COUNT = JSON.parse(FIXTURE).elements.length;
const OUT = process.argv[2];
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail); };

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2, hasTouch: true });
  await ctx.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: FIXTURE }));
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && !/status of 50\d|status of 429/.test(m.text()) && errors.push(m.text()));
  };
  let p = await ctx.newPage(); watch(p);
  const st = (q, arg) => p.evaluate(q, arg);
  const readout = () => p.textContent('#heading');
  const labels = () => p.$$eval('.label:not([hidden])', (ls) => ls.map((l) => l.querySelector('.n').textContent));
  const ready = async () => {
    await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
    await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 420000, polling: 1000 });
    await p.waitForTimeout(600);
  };

  // Pages sites under one github.io account share an origin: the offline helper must leave
  // other sites' caches alone (fault: it deletes every cache that isn't its own).
  // A bare SVG page has no icon link, so Chromium asks for /favicon.ico; the app's pages don't.
  await p.route(/\/favicon\.ico$/, (r) => r.fulfill({ status: 204 }));
  await p.goto(BASE + 'icons/icon.svg');
  await p.evaluate(() => caches.open('another-site-v1'));
  await p.unroute(/\/favicon\.ico$/);

  // 1. Marbella seafront facing Jebel Musa.
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=215&pitch=0.3&nocam=1&autostart=1');
  // The app registers it only over https; register it here so the local server runs it too.
  await p.evaluate(async (u) => { await navigator.serviceWorker.register(u); await navigator.serviceWorker.ready; }, BASE + 'sw.js');
  check("offline helper keeps other sites' caches", await p.evaluate(() => caches.has('another-site-v1')));
  await ready();
  const bannerText = (pg) => pg.$$eval(['#banner-continent', '#banner-country', '#banner-note'].join(','), (d) => d.map((x) => x.textContent));
  const banner = await bannerText(p);
  check('banner says Africa / Morocco facing Jebel Musa', banner[0] === 'Africa' && banner[1] === 'Morocco', banner.join(' | '));
  let ls = await labels();
  // Jebel Musa sits under the reticle, so the card names it and its own label steps aside.
  const aimed = await st(() => document.querySelector('#target:not([hidden]) .t-name')?.textContent ?? '');
  check('reticle card names Jebel Musa, Rock of Gibraltar labelled', aimed === 'Jebel Musa' && !ls.includes('Jebel Musa') && ls.includes('Rock of Gibraltar'), `card ${aimed} :: ${ls.join(', ')}`);
  check('no duplicate labels', new Set(ls).size === ls.length, ls.join(', '));
  // Fault: labels are heavy dark boxes, all one size, that pop on and off. Each label must be
  // bare text on a halo, sized and dimmed by distance (under 20 km, 20–80 km, beyond), fading.
  const labelLook = () => st(() => [...document.querySelectorAll('.label:not([hidden])')].map((l) => {
    const place = window.__binoculars.world.places.find((x) => x.name === l.querySelector('.n').textContent);
    const cs = getComputedStyle(l);
    const n = getComputedStyle(l.querySelector('.n'));
    const m = getComputedStyle(l.querySelector('.m'));
    const want = place.d < 20000 ? [16, 1] : place.d < 80000 ? [14, 0.9] : [12, 0.75];
    if (l.classList.contains('hidden-place')) want[1] *= 0.6;
    const got = [parseFloat(n.fontSize), parseFloat(cs.opacity)];
    const ok = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.textShadow !== 'none' && got[0] === want[0] &&
      Math.abs(got[1] - want[1]) < 0.01 && m.fontSize === '11px' && m.textTransform === 'uppercase' &&
      /opacity/.test(cs.transitionProperty);
    return `${place.name} ${Math.round(place.d / 1000)} km ${got.join('/')}${ok ? '' : ' WRONG'}`;
  }));
  const look215 = await labelLook();
  check('labels are bare text on a halo, sized and dimmed by distance, and fade', look215.length > 0 && look215.every((x) => !/WRONG/.test(x)), look215.join(', '));
  await p.screenshot({ path: `${OUT}/1-africa.png` });

  // Save what loaded into the app's own cache so later loads are instant.
  const n = await st(() => {
    const w = window.__binoculars.world;
    const items = w.places.map(({ id, name, kind, lat, lon, ele, height, population, wikipedia }) => ({ id, name, kind, lat, lon, ele, height, population, wikipedia }));
    localStorage.setItem('binoculars:places:v1', JSON.stringify({ t: Date.now(), lat: w.lat, lon: w.lon, range: 150, items }));
    return items.length;
  });
  check('every test place within range loaded', n >= FIXTURE_COUNT, `${n} places, ${FIXTURE_COUNT} in the test data`);

  // 2. Arrow keys and drag pan.
  const h0 = await readout();
  for (let i = 0; i < 5; i++) await p.keyboard.press('ArrowRight');
  // The readout redraws on the next frame, so wait for it rather than reading it at once.
  const turned = await p.waitForFunction((h) => document.getElementById('heading').textContent !== h, h0, { timeout: 5000 }).then(() => true, () => false);
  check('arrow keys turn the view', turned, `${h0} -> ${await readout()}`);
  const before = await st(() => window.__binoculars.view.heading);
  await p.mouse.move(300, 500); await p.mouse.down(); await p.mouse.move(150, 500, { steps: 8 }); await p.mouse.up();
  const after = await st(() => window.__binoculars.view.heading);
  check('dragging left turns the view right', ((after - before + 360) % 360) > 5 && ((after - before + 360) % 360) < 60, `${before.toFixed(1)} -> ${after.toFixed(1)}`);

  // 3. Zoom: one round button that steps 1×, 2×, 4×, 8× and back, the picture easing to each
  // step rather than jumping; pinch still works. (Fault: four zoom pills crowd the bar and snap.)
  const zoomText = () => st(() => document.getElementById('zoom-btn')?.textContent ?? null);
  const zoomed = (z) => p.waitForFunction((z) => window.__binoculars.view.zoom === z, z, { timeout: 3000 }).then(() => true, () => false);
  const zoomTo = async (label) => {
    for (let i = 0; i < 4 && (await zoomText()) !== label && (await p.$('#zoom-btn')); i++) await p.click('#zoom-btn');
  };
  const steps = [];
  for (let i = 0; i < 4 && (await p.$('#zoom-btn')); i++) {
    await p.click('#zoom-btn');
    steps.push(await zoomText());
  }
  const pills = await st(() => document.querySelectorAll('#zooms, [data-zoom]').length);
  check('one zoom button steps 2×, 4×, 8×, back to 1×, and the pills are gone', steps.join(' ') === '2× 4× 8× 1×' && pills === 0, `${steps.join(' ')}; ${pills} pills`);
  await zoomed(1);
  await zoomTo('2×');
  const mid = await st(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__binoculars.view.zoom)))));
  const at2 = await zoomed(2);
  check('the picture eases to the new zoom', mid > 1 && mid < 2 && at2, `two frames in: ${mid}; reached 2×: ${at2}`);
  await zoomTo('4×');
  const at4 = await zoomed(4);
  const z4 = await st(() => [window.__binoculars.view.zoom, document.getElementById('video').style.transform, document.getElementById('zoom-btn')?.textContent]);
  check('4× zooms the picture and the button says so', at4 && z4[1] === 'scale(4)' && z4[2] === '4×', z4.join(' '));
  await p.screenshot({ path: `${OUT}/2-zoom4.png` });
  await zoomTo('1×');
  await zoomed(1);
  const pinched = await st(() => {
    const ev = (type, id, x) => document.elementFromPoint(x, 500).dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: 500, bubbles: true }));
    ev('pointerdown', 11, 180); ev('pointerdown', 12, 250);
    ev('pointermove', 11, 110); ev('pointermove', 12, 320);
    ev('pointerup', 11, 110); ev('pointerup', 12, 320);
    return window.__binoculars.view.zoomTarget;
  });
  const pinchLabel = await zoomText();
  const settled = await zoomed(pinched);
  check('pinch out zooms in', pinched > 2.5 && pinched < 3.5 && settled && pinchLabel === `${Math.round(pinched * 10) / 10}×`, `zoom ${pinched}, button ${pinchLabel}, settled ${settled}`);
  await zoomTo('1×');
  await zoomed(1);

  // 4. Tap a label: info sheet. Faced a few degrees off Jebel Musa so the reticle is not on it
  // and it keeps its label.
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=222&pitch=0.3&nocam=1&autostart=1');
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
  // Fault: changing height threw away the loaded place names and fetched them all again, which
  // on first use (nothing saved yet) blanks the labels for minutes. Edge: no saved list.
  const saved = await st(() => {
    const s = localStorage.getItem('binoculars:places:v1');
    localStorage.removeItem('binoculars:places:v1');
    return s;
  });
  let overpass = 0;
  const countOverpass = (r) => /\/interpreter/.test(r.url()) && overpass++;
  p.on('request', countOverpass);
  // Fault: a label kept the place it was first drawn with, so after a height change tapping it
  // still gave the old answer. Edge: a place that only comes into view from higher up.
  await p.check('#show-hidden');
  await p.waitForTimeout(300);
  const eye0 = await st(() => window.__binoculars.world.eye);
  const vis0 = await st(() => window.__binoculars.world.places.filter((x) => x.visible).length);
  const hidden0 = await st(() => window.__binoculars.world.places.filter((x) => !x.visible).map((x) => x.id));
  await p.$eval('#hag', (el) => { el.value = 300; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  await p.waitForFunction((e) => window.__binoculars.world.eye > e + 200 && !window.__binoculars.world.busy, eye0, { timeout: 120000 });
  await p.waitForTimeout(500);
  const kept = await st(() => window.__binoculars.world.places.length);
  check('changing height keeps the loaded place names', overpass === 0 && kept >= FIXTURE_COUNT, `${overpass} place-name requests, ${kept} places`);
  const vis1 = await st(() => window.__binoculars.world.places.filter((x) => x.visible).length);
  check('raising height above ground lets you see more', vis1 > vis0, `eye ${eye0.toFixed(0)} m: ${vis0} visible; +298 m: ${vis1} visible`);
  const card = await st((h0) => {
    for (const x of window.__binoculars.world.places) {
      if (!x.visible || !h0.includes(x.id)) continue;
      const el = [...document.querySelectorAll('.label:not([hidden]):not(.hidden-place)')].find((l) => l.querySelector('.n').textContent === x.name);
      if (!el) continue;
      el.click();
      return `${x.name}: ${document.getElementById('info-visible').textContent}`;
    }
    return 'no place on screen came into view';
  }, hidden0);
  check('tapping a place that came into view says it is visible', /: Yes/.test(card), card);
  await p.click('#info .close');
  await p.click('#settings-btn');
  await p.uncheck('#show-hidden');
  p.off('request', countOverpass);
  await st((s) => localStorage.setItem('binoculars:places:v1', s), saved);
  await p.$eval('#fov', (el) => { el.value = 80; el.dispatchEvent(new Event('input')); });
  check('field of view setting applies', await st(() => window.__binoculars.settings.fov === 80));
  await p.click('#reset-align');
  check('reset alignment confirms', (await p.textContent('#toast')) === 'Alignment reset.');
  // Fault: messages sit over the country banner at the top, and under any open sheet.
  const placed = await st(() => {
    const t = document.getElementById('toast').getBoundingClientRect();
    const hud = document.getElementById('hud').getBoundingClientRect();
    const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
    return { gap: Math.round(hud.top - t.bottom), onTop: !!hit?.closest('#toast') };
  });
  check('messages sit just above the controls, in front of the open settings', placed.gap >= 0 && placed.gap <= 48 && placed.onTop, JSON.stringify(placed));
  await p.$eval('#hag', (el) => { el.value = 2; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  await p.$eval('#fov', (el) => { el.value = 64; el.dispatchEvent(new Event('input')); });
  await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 120000 });
  await p.click('#settings .close');

  // 6. Looking north from the same spot: Spain.
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=0&pitch=2&nocam=1&autostart=1');
  await ready();
  const bn = await bannerText(p);
  ls = await labels();
  check('looking north: Europe / Spain with Spanish places', bn[0] === 'Europe' && bn[1] === 'Spain' && ls.length > 0, `${bn.join(' | ')} :: ${ls.join(', ')}`);
  const lookN = await labelLook();
  check('near labels north are larger, styled as above', lookN.some((x) => / 16\/1$/.test(x)) && lookN.every((x) => !/WRONG/.test(x)), lookN.join(', '));
  await p.screenshot({ path: `${OUT}/5-north.png` });

  // Fault: labels are kept out of a fixed 96 px at the top, so on a phone with a notch, where
  // the banner sits lower, they run under it. Edge: a 47 px notch, labels pushed to the top.
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=70&pitch=-6&nocam=1&autostart=1');
  await p.addStyleTag({ content: ':root { --safe-top: 47px; }' });
  await ready();
  await st(() => (window.__binoculars.settings.showHidden = true));
  await p.waitForTimeout(500);
  const clear = await st(() => {
    const bottom = document.getElementById('banner').getBoundingClientRect().bottom;
    const tops = [...document.querySelectorAll('.label:not([hidden])')].map((l) => Math.round(l.getBoundingClientRect().top));
    return { bottom: Math.round(bottom), tops };
  });
  await st(() => (window.__binoculars.settings.showHidden = false));
  check('labels stay below the banner on a phone with a notch', clear.tops.length > 0 && clear.tops.every((t) => t >= clear.bottom), JSON.stringify(clear));

  // Fault: a view with nothing visible to name is just blank, with no word that the hills hide
  // places there. Edges: places in frame all hidden (east, inland), and none at all (open sea).
  const emptyNote = () => st(() => {
    const e = document.getElementById('empty');
    if (!e || e.hidden) return null;
    const show = document.getElementById('empty-show');
    return { text: document.getElementById('empty-text').textContent, show: !show.hidden, under: e.getBoundingClientRect().top >= document.getElementById('banner').getBoundingClientRect().bottom };
  });
  await p.goto(BASE + '?lat=36.5068&lon=-4.886&heading=70&pitch=0.3&nocam=1&autostart=1');
  await ready();
  const inland = await emptyNote();
  check('an empty view says so and counts the places hills hide', !!inland && /^Nothing named in sight this way · \d+ hidden by hills$/.test(inland.text) && inland.show && inland.under, JSON.stringify(inland));
  if (inland?.show) await p.click('#empty-show');
  await p.waitForTimeout(400);
  const shown = await st(() => ({
    on: window.__binoculars.settings.showHidden,
    saved: JSON.parse(localStorage.getItem('binoculars:settings:v1') || '{}').showHidden === true,
    labels: document.querySelectorAll('.label.hidden-place:not([hidden])').length,
    note: !document.getElementById('empty')?.hidden,
  }));
  check('Show turns hidden places on, and the note goes', shown.on && shown.saved && shown.labels > 0 && !shown.note, JSON.stringify(shown));
  await st(() => {
    window.__binoculars.settings.showHidden = false;
    const s = JSON.parse(localStorage.getItem('binoculars:settings:v1') || '{}');
    localStorage.setItem('binoculars:settings:v1', JSON.stringify({ ...s, showHidden: false }));
  });
  await st(() => (window.__binoculars.view.heading = 150));
  await p.waitForTimeout(700);
  const sea = await emptyNote();
  check('over open sea it says so, with nothing hidden to offer', !!sea && sea.text === 'Nothing named in sight this way' && !sea.show, JSON.stringify(sea));
  await p.screenshot({ path: `${OUT}/6-empty-sea.png` });

  // 7. Demo button from a cold start.
  await p.goto(BASE + '?nocam=1');
  await p.click('#demo-btn');
  await ready();
  ls = await labels();
  const demo = await st(() => [document.querySelector('#target:not([hidden]) .t-name')?.textContent ?? '', document.getElementById('banner-country').textContent]);
  check('demo button opens facing Africa with Jebel Musa under the reticle', demo[0] === 'Jebel Musa' && demo[1] === 'Morocco', `card ${demo[0]}, banner ${demo[1]} :: ${ls.join(', ')}`);

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
  const iosBanner = await bannerText(ios);
  check('iPhone path: banner Africa / Morocco', iosBanner[0] === 'Africa' && iosBanner[1] === 'Morocco', iosBanner.join(' | '));
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
