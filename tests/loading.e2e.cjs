// Loading faults: place names that never come, place names that fail, and location refused.
// 1. Until OpenStreetMap answers there are no place names at all, so on a slow or dead server
// the view stays empty for minutes. Here it never answers; towns and cities from the bundled
// file must still be labelled within 15 s of start.
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
  const pill = await p.evaluate(() => {
    const s = document.getElementById('status');
    return s && !s.hidden && s.getBoundingClientRect().height > 0 ? s.textContent.trim() : '';
  });
  check('a slim line says more names are on the way', /^Finding more names…/.test(pill), pill);
  await p.screenshot({ path: `${OUT}/loading-held.png` });
  for (const r of held.splice(0)) await r.abort().catch(() => {});
  await p.unroute(/\/interpreter/);

  // 2. Fault: when every server fails, a message says so and then goes, with no way to try
  // again short of finding Reload in settings. Here every server answers 503.
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push(String(e)));
  let asked = 0;
  await p2.route(/\/interpreter/, (r) => { asked++; r.fulfill({ status: 503, body: 'busy' }); });
  await p2.goto(BASE + '?nocam=1');
  await p2.evaluate(() => localStorage.removeItem('binoculars:places:v1'));
  await p2.goto(BASE + '?lat=36.5068&lon=-4.886&heading=215&pitch=0.3&nocam=1&autostart=1');
  const retry = await p2.waitForSelector('#status-retry', { state: 'visible', timeout: 90000 }).then(() => true, () => false);
  const failText = retry ? (await p2.textContent('#status')).trim() : '';
  check('a lasting line offers Retry when place names fail', retry && /^Couldn't load all place names/.test(failText), failText);
  if (retry) {
    await p2.screenshot({ path: `${OUT}/loading-failed.png` });
    await p2.waitForTimeout(6000);
    const visibleLater = await p2.isVisible('#status-retry');
    const before = asked;
    await p2.click('#status-retry');
    const t1 = Date.now();
    while (asked === before && Date.now() - t1 < 10000) await p2.waitForTimeout(100);
    check('Retry stays up and asks the servers again', visibleLater && asked > before, `${before} requests before, ${asked} after`);
    // Fault: the lasting line sits in front of open sheets and covers their rows on a short
    // phone. Edge: the line is up when the settings sheet opens, and comes back when it closes.
    await p2.waitForSelector('#status-retry', { state: 'visible', timeout: 90000 }).catch(() => {});
    await p2.click('#settings-btn');
    const overSheet = await p2.isVisible('#status');
    await p2.click('#settings [data-close]');
    const afterClose = await p2.isVisible('#status');
    check('the place-name line steps aside while a sheet is open', !overSheet && afterClose, JSON.stringify({ overSheet, afterClose }));
  }

  // 3. Fault: when location is refused or unavailable, the browser's own error text appears in
  // a passing message instead of plain advice on the start screen. The page's geolocation is
  // replaced so each refusal is the same every run.
  const ADVICE = 'Binoculars needs your location to know what\'s around you. Turn on Location for this site, then tap Start — or try the demo.';
  for (const [code, raw] of [[1, 'User denied Geolocation'], [2, 'Position update is unavailable']]) {
    const c3 = await b.newContext({ viewport: { width: 430, height: 860 } });
    await c3.addInitScript(([code, raw]) => {
      const fail = (ok, err) => setTimeout(() => err({ code, message: raw }), 50);
      Object.defineProperty(navigator, 'geolocation', {
        value: { watchPosition: (ok, err) => (fail(ok, err), 1), getCurrentPosition: fail, clearWatch() {} },
      });
    }, [code, raw]);
    const p3 = await c3.newPage();
    p3.on('pageerror', (e) => errors.push(String(e)));
    await p3.goto(BASE + '?nocam=1&autostart=1');
    const said = await p3
      .waitForFunction((advice) => {
        const start = document.getElementById('start');
        if (start.hidden) return false;
        return [...start.querySelectorAll('[role=alert]')].some((el) => !el.hidden && el.textContent.trim() === advice);
      }, ADVICE, { timeout: 10000 })
      .then(() => true, () => false);
    const seen = await p3.evaluate(() => document.body.innerText);
    check(`start screen explains a location failure in plain words (code ${code})`, said && !seen.includes(raw) && (await p3.isHidden('#toast')),
      said ? '' : seen.replace(/\s+/g, ' ').slice(0, 300));
    if (code === 1) await p3.screenshot({ path: `${OUT}/location-refused.png` });
    await c3.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
