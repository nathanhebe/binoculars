// Fault: a height change made while the last one is still recomputing is dropped, so the
// view stays worked out for the old height. Edge: the second change comes straight after the first.
// Place names are faked; terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/height.e2e.cjs
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const p = await b.newPage({ viewport: { width: 430, height: 860 } });
  await p.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }));
  await routeTiles(p, { empty: true });
  const base = process.env.BASE_URL || 'http://localhost:8765/';
  await p.goto(base + '?nocam=1');
  await p.evaluate(() => localStorage.clear());
  await p.goto(base + '?lat=36.5068&lon=-4.886&heading=215&nocam=1&autostart=1');
  await p.waitForFunction(() => window.__binoculars?.world.placesDone && !window.__binoculars.world.busy, null, { timeout: 300000, polling: 500 });
  const ground = await p.evaluate(() => window.__binoculars.world.eye - window.__binoculars.settings.hag);
  await p.evaluate(() => {
    const h = document.getElementById('hag');
    for (const v of [40, 300]) {
      h.value = v;
      h.dispatchEvent(new Event('input'));
      h.dispatchEvent(new Event('change'));
    }
  });
  await p.waitForFunction(() => !window.__binoculars.world.busy, null, { timeout: 120000, polling: 100 });
  const eye = await p.evaluate(() => window.__binoculars.world.eye);
  const ok = Math.abs(eye - ground - 300) < 0.01;
  console.log(`eye height above ground after changes to 40 then 300 m: ${(eye - ground).toFixed(1)} m`);
  console.log(ok ? 'PASS the last height change is used' : 'FAIL the second height change was dropped');
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
