// Fault: the demo waits for the camera prompt, so on a computer where nobody answers it the
// loading screen never goes. The camera request here never answers; the demo must still load.
// Place names are faked; terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/demo.e2e.cjs
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const p = await b.newPage({ viewport: { width: 430, height: 860 } });
  await p.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
  });
  await p.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }));
  await routeTiles(p, { empty: true });
  await p.goto(process.env.BASE_URL || 'http://localhost:8765/');
  await p.click('#demo-btn');
  const ok = await p
    .waitForFunction(() => window.__binoculars?.world.horizon.length > 0, null, { timeout: 120000, polling: 500 })
    .then(() => true, () => false);
  console.log(ok ? 'PASS demo loads while the camera prompt is unanswered' : 'FAIL demo stuck on the loading screen');
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
