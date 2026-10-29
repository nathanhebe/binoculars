// The heads-up display: what the centre of the screen is pointing at.
// Place names come from tests/fixtures/marbella-overpass.json; terrain comes from the live server.
// Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/hud.e2e.cjs <screenshot dir>
const { chromium } = require('playwright');
const FIXTURE = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/marbella-overpass.json'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const MARBELLA = 'lat=36.5068&lon=-4.886';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, deviceScaleFactor: 2 });
  await ctx.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: FIXTURE }));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  const ready = async () => {
    await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
    await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 240000, polling: 500 });
    await p.waitForTimeout(800);
  };
  // What the card under the reticle says, and which loaded place (if any) it names.
  const card = () =>
    p.evaluate(() => {
      const el = document.getElementById('target');
      const name = el?.querySelector('.t-name')?.textContent ?? '';
      const place = window.__binoculars.world.places.find((x) => x.name === name);
      return {
        shown: !!el && !el.hidden,
        name,
        text: el ? [...el.children].map((c) => c.textContent).filter(Boolean).join(' / ') : '',
        country: place?.country ?? null,
        locked: document.getElementById('reticle').classList.contains('locked'),
        ownLabel: [...document.querySelectorAll('.label:not([hidden]) .n')].some((n) => n.textContent === name),
      };
    });

  // 1. Marbella seafront, pointing at Jebel Musa across the Strait.
  await p.goto(`${BASE}?${MARBELLA}&heading=215&pitch=0.3&nocam=1&autostart=1`);
  await ready();
  let c = await card();
  check('facing 215° the card under the reticle names a Moroccan place', c.shown && c.country === 'Morocco' && /Morocco · Africa/.test(c.text), c.text);
  check('the reticle locks on and the place\'s own label steps aside', c.locked && !c.ownLabel, JSON.stringify({ locked: c.locked, ownLabel: c.ownLabel }));
  await p.screenshot({ path: `${OUT}/hud-215.png` });
  if (c.shown) {
    await p.click('#target');
    const info = await p.evaluate(() => [!document.getElementById('info').hidden, document.getElementById('info-name').textContent]);
    check('tapping the card opens that place\'s details', info[0] && info[1] === c.name, info.join(' '));
    await p.click('#info .close');
  } else check('tapping the card opens that place\'s details', false, 'no card');

  // 2. Same spot, facing the hills inland.
  await p.goto(`${BASE}?${MARBELLA}&heading=90&nocam=1&autostart=1`);
  await ready();
  c = await card();
  check('facing the hills at 90° the card does not claim Morocco', c.shown && c.text && !/Morocco/.test(c.text), c.text);
  await p.screenshot({ path: `${OUT}/hud-90.png` });

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
