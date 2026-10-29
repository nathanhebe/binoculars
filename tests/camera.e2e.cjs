// Camera fault: when the camera is refused or missing, a five-second toast says "No camera"
// with no reason and no way to ask again, so on an iPhone the view is a plain background with
// nothing to explain it. Edge: the first request is refused (NotAllowedError) and a second,
// made from the Try again tap, succeeds.
// Terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/camera.e2e.cjs [outdir]
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
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
  await ctx.addInitScript(() => {
    window.__camCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.__camCalls += 1;
      if (window.__camCalls === 1) throw new DOMException('Permission denied', 'NotAllowedError');
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 48;
      c.getContext('2d').fillRect(0, 0, 64, 48);
      return c.captureStream(5);
    };
  });
  const p = await ctx.newPage();
  await p.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }));
  await routeTiles(p, { empty: true });
  await p.goto(BASE);
  await p.click('#demo-btn');
  await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 300000, polling: 300 });
  await p.waitForTimeout(6000); // past the old toast's five seconds
  const off = await p.evaluate(() => {
    const el = document.getElementById('cam-off');
    return el && !el.hidden ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  check('a refused camera says so, with the reason, and stays', !!off && /refused/i.test(off) && /try again/i.test(off), JSON.stringify(off));
  await p.screenshot({ path: `${OUT}/camera-refused.png` });

  const retry = await p.$('#cam-retry');
  if (retry) await retry.click();
  const back = await p
    .waitForFunction(() => document.getElementById('cam-off').hidden && document.getElementById('video').srcObject, null, { timeout: 5000 })
    .then(() => true, () => false);
  const calls = await p.evaluate(() => window.__camCalls);
  check('Try again asks for the camera again, and the message goes when it works', back && calls === 2, `calls ${calls}`);

  await ctx.close();
  await b.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
