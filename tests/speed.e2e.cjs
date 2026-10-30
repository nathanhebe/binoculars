// Speed: on a cold start, with every place-name server slow or dead, names must still be up
// within seconds, and a second visit must not fetch again what it already has.
// Terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/speed.e2e.cjs [outdir]
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const MARBELLA = '?lat=36.5068&lon=-4.886&heading=215&pitch=0.3&nocam=1&autostart=1';
const PLACE_HOSTS = /\/interpreter|tiles\.openfreemap\.org/;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};
// The names on screen now, and which of them are bundled mountains.
const onScreen = (p) =>
  p.evaluate(() => {
    const w = window.__binoculars?.world;
    // Small labels, and the name under the crosshair.
    const names = [...document.querySelectorAll('.label:not([hidden]) .n, #target:not([hidden]) .t-name')].map((l) => l.textContent);
    const peaks = new Set((w?.places ?? []).filter((x) => x.kind === 'peak' && x.id.startsWith('nep')).map((x) => x.name));
    return { names, peaks: names.filter((n) => peaks.has(n)) };
  });

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const errors = [];
  // Terrain comes from a live server whose speed is not under test: each 5 s clock starts when
  // the terrain is in and the view can be drawn. TERRAIN_DELAY_MS slows it to prove that.
  const DELAY = +process.env.TERRAIN_DELAY_MS || 0;
  const nc = b.newContext.bind(b);
  b.newContext = async (o) => {
    const c = await nc(o);
    if (DELAY) await c.route(/elevation-tiles-prod/, async (r) => { await new Promise((k) => setTimeout(k, DELAY)); r.continue().catch(() => {}); });
    return c;
  };
  const terrainIn = (p) =>
    p.waitForFunction(() => { const w = window.__binoculars?.world; return w && w.gen > 0 && w.measuredGen === w.gen; }, null, { timeout: 120000, polling: 100 });

  // 1. Fault: with every place-name server held, mountains have no name until OpenStreetMap
  // answers. Edge: nothing from Overpass or the map tiles ever answers, on a cold start.
  {
    const ctx = await b.newContext({ viewport: { width: 430, height: 860 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    const held = [];
    await p.route(PLACE_HOSTS, (r) => held.push(r));
    await p.goto(BASE + MARBELLA);
    await terrainIn(p);
    const t0 = Date.now();
    let seen = { names: [], peaks: [] };
    while (Date.now() - t0 < 5000 && !(seen.peaks.length && seen.names.length > seen.peaks.length)) {
      await p.waitForTimeout(200);
      seen = await onScreen(p);
    }
    check('towns and a bundled mountain labelled within 5 s with every place server held',
      seen.peaks.length > 0 && seen.names.length > seen.peaks.length,
      `${((Date.now() - t0) / 1000).toFixed(1)} s, ${held.length} requests held, labels: ${seen.names.join(', ')}`);
    await p.screenshot({ path: `${OUT}/speed-held.png` });
    for (const r of held.splice(0)) await r.abort().catch(() => {});
    await ctx.close();
  }

  // 2. Fault: names beyond the bundled ones wait for Overpass, which takes minutes when busy.
  // Edge: Overpass never answers; the map tiles answer, each after 400 ms, on a cold start.
  {
    const ctx = await b.newContext({ viewport: { width: 430, height: 860 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    const held = [];
    await p.route(/\/interpreter/, (r) => held.push(r));
    const asked = await routeTiles(p, { delay: 400 });
    await p.goto(BASE + MARBELLA);
    await terrainIn(p);
    const t0 = Date.now();
    let seen = [];
    while (Date.now() - t0 < 5000 && !seen.length) {
      await p.waitForTimeout(200);
      seen = await p.evaluate(() => {
        const tiles = new Set((window.__binoculars?.world.places ?? []).filter((x) => x.id.startsWith('t')).map((x) => x.name));
        return [...document.querySelectorAll('.label:not([hidden]) .n, #target:not([hidden]) .t-name')]
          .map((l) => l.textContent).filter((n) => tiles.has(n));
      });
    }
    const known = await p.evaluate(() => (window.__binoculars?.world.places ?? []).filter((x) => x.id.startsWith('t')).length);
    check('names from the map tiles labelled within 5 s while Overpass never answers', seen.length > 0,
      `${((Date.now() - t0) / 1000).toFixed(1)} s, ${known} tile places, on screen: ${seen.join(', ')}`);
    check('the tile under the viewer is asked for first', asked.find((a) => a.endsWith('.pbf')) === '/planet/20261025_080012_pt/8/124/100.pbf',
      asked.slice(0, 4).join(' '));
    await p.screenshot({ path: `${OUT}/speed-tiles.png` });
    // Fault: the line keeps saying "Finding more names…" for minutes after the last tile, while
    // Overpass (lighthouses, castles and the like) is still out.
    const cleared = await p
      .waitForFunction(() => document.getElementById('status').hidden, null, { timeout: 20000, polling: 200 })
      .then(() => true, () => false);
    const line = await p.evaluate(() => document.getElementById('status').textContent.replace(/\s+/g, ' ').trim());
    check('the line goes once every map tile is in, with Overpass still out', cleared && held.length > 0,
      `${asked.filter((a) => a.endsWith('.pbf')).length} tiles asked, ${held.length} Overpass requests held${cleared ? '' : `, line: ${line}`}`);
    for (const r of held.splice(0)) await r.abort().catch(() => {});
    await ctx.close();
  }

  // 3. Fault: every visit fetches every tile again, so a second look from the same spot waits as
  // long as the first. Edge: the same spot again in the same browser, Overpass never answering;
  // then the saved tiles made 31 days old, past their limit.
  {
    const ctx = await b.newContext({ viewport: { width: 430, height: 860 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    const held = [];
    await p.route(/\/interpreter/, (r) => held.push(r));
    const asked = await routeTiles(p, { delay: 400 });
    const tilesIn = () => p.waitForFunction(() => window.__binoculars?.world.horizon.length && document.getElementById('status').hidden, null, { timeout: 60000, polling: 200 });
    const tileNames = () => p.evaluate(() => {
      const tiles = new Set((window.__binoculars?.world.places ?? []).filter((x) => x.id.startsWith('t')).map((x) => x.name));
      return [...document.querySelectorAll('.label:not([hidden]) .n, #target:not([hidden]) .t-name')].map((l) => l.textContent).filter((n) => tiles.has(n));
    });
    await p.goto(BASE + MARBELLA);
    await tilesIn();
    const first = asked.length;
    await p.goto(BASE + MARBELLA);
    await terrainIn(p);
    const t0 = Date.now();
    let seen = [];
    while (Date.now() - t0 < 5000 && !seen.length) {
      await p.waitForTimeout(200);
      seen = await tileNames();
    }
    await tilesIn();
    check('a second look from the same spot asks for no map tiles and names them within 5 s', first > 0 && asked.length === first && seen.length > 0,
      `${first} requests the first time, ${asked.length - first} the second; ${((Date.now() - t0) / 1000).toFixed(1)} s, on screen: ${seen.join(', ')}`);
    const aged = await p.evaluate(async () => {
      let n = 0;
      for (const name of await caches.keys()) {
        if (!/places/.test(name)) continue;
        const c = await caches.open(name);
        for (const req of await c.keys()) {
          const body = await (await c.match(req)).json();
          body.t -= 31 * 24 * 3600 * 1000;
          await c.put(req, new Response(JSON.stringify(body)));
          n++;
        }
      }
      return n;
    });
    const second = asked.length;
    await p.goto(BASE + MARBELLA);
    await tilesIn();
    check('tiles saved over 30 days ago are asked for again', aged > 0 && asked.length > second,
      `${aged} saved tiles aged, ${asked.length - second} requests after`);
    for (const r of held.splice(0)) await r.abort().catch(() => {});
    await ctx.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  process.exit(results.every(Boolean) ? 0 : 1);
})();
