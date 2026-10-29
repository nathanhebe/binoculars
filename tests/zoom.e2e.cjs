// Zooming in from Marbella towards Morocco: the towns beyond the horizon over the sea, and
// what hides the places that are left out.
// Map tiles come from tests/fixtures/ofm, Overpass from tests/fixtures/marbella-overpass.json;
// terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/zoom.e2e.cjs <screenshot dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const routeTiles = require('./tiles-route.cjs');
const PLACES = fs.readFileSync(path.join(__dirname, 'fixtures/marbella-overpass.json'), 'utf8');
const BASE = process.env.BASE_URL || 'http://localhost:8765/';
const OUT = process.argv[2] || '.';
const MARBELLA = 'lat=36.5068&lon=-4.886';
const SETTLEMENT = ['city', 'town', 'village', 'hamlet'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};

async function open(b, viewport, heading) {
  const ctx = await b.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.route(/\/interpreter/, (r) => r.fulfill({ contentType: 'application/json', body: PLACES }));
  const asked = await routeTiles(ctx);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(`${BASE}?${MARBELLA}&heading=${heading}&pitch=0.3&nocam=1&autostart=1`);
  await p.waitForFunction(() => !document.getElementById('hud').hidden, null, { timeout: 240000 });
  await p.waitForFunction(() => window.__binoculars.world.placesDone, null, { timeout: 240000, polling: 500 });
  await p.waitForTimeout(800);
  return { ctx, p, errors, asked };
}
// The detail each zoom shows: the least score a place needs for a label, and at most how many
// labels (js/places.mjs DETAIL); the map tile zoom asked for, zoomed in, to find smaller places
// (js/tiles.mjs FINER_Z).
const DETAIL = { 1: [45, 12], 2: [35, 14], 4: [22, 16], 8: [0, 16] };
const FINER_Z = { 2: 10, 4: 11, 8: 12 };
const POI = ['food', 'shops', 'travel', 'sights'];
const tileZ = (path) => Number((/\/(\d+)\/\d+\/\d+\.pbf$/.exec(path) || [])[1]);
const look = (p, heading, zoom) =>
  p.evaluate(([h, z]) => {
    const { view } = window.__binoculars;
    Object.assign(view, { heading: h, pitch: 0.3, zoomTarget: z, zoom: z });
  }, [heading, zoom]);
// Labels on screen now, with the place each one stands for.
const labels = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('.label.on:not([hidden])')].map((el) => ({
      name: el.querySelector('.n').textContent,
      meta: el.querySelector('.m').textContent,
      kind: (el.className.match(/\bk-(\w+)/) || [])[1],
      country: el._p?.country ?? null,
      visible: !!el._p?.visible,
      blockedBy: el._p?.blockedBy ?? null,
      score: el._p?.score ?? null,
    }))
  );
const show = (z, ls) => console.log(`  ${z}x: ${ls.map((l) => `${l.name} [${l.kind}${l.blockedBy ? ' ' + l.blockedBy : ''}] ${l.meta}`).join(' | ')}`);

(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const errors = [];

  // 1. Facing Morocco across the Strait, the setting for hidden places off.
  {
    const { ctx, p, errors: e, asked } = await open(b, { width: 375, height: 667 }, 215);
    const seen = {};
    const tiles = {};
    for (const z of [1, 2, 4, 8]) {
      const before = asked.length;
      await look(p, 215, z);
      await p.waitForTimeout(2500);
      seen[z] = await labels(p);
      tiles[z] = asked.slice(before).filter((a) => a.endsWith('.pbf'));
      await p.screenshot({ path: path.join(OUT, `z${z}.png`) });
      show(z, seen[z]);
    }
    // Jbel Chendir is in sight, a little left of centre: from 2×, where places beyond the horizon
    // are greyed in, they must never take its place. (At 1× none are drawn, and the towns and the
    // taller peaks beside it, a size larger there, may crowd it out.)
    const chendir = [2, 4, 8].filter((z) => !seen[z].some((l) => l.name === 'Jbel Chendir' && l.visible));
    check('a place in sight keeps its label when zoomed in, ahead of places beyond the horizon', chendir.length === 0, chendir.length ? `missing at ${chendir.join(', ')}x` : '');

    // Detail grows with zoom: each zoom labels only places that matter enough for it, no more
    // than its cap, by the same rule the app uses.
    const rule = await p.evaluate(() => {
      const f = window.__binoculars.detailFor;
      return f ? [1, 2, 4, 8].map((z) => [f(z).minScore, f(z).cap]) : null;
    });
    const sameRule = JSON.stringify(rule) === JSON.stringify([1, 2, 4, 8].map((z) => DETAIL[z]));
    const over = [1, 2, 4, 8].flatMap((z) => {
      const [minScore, cap] = DETAIL[z];
      const low = seen[z].filter((l) => !POI.includes(l.kind) && !(l.score >= minScore));
      return [
        ...(seen[z].length > cap || seen[z].length === 0 ? [`${z}x: ${seen[z].length} labels`] : []),
        ...low.map((l) => `${z}x: ${l.name} scores ${l.score}`),
      ];
    });
    check('each zoom labels between one and its cap, only places that matter enough for it', sameRule && over.length === 0,
      sameRule ? over.join(', ') : `the app's rule is ${JSON.stringify(rule)}`);
    const kinds1 = new Set(seen[1].map((l) => l.kind));
    const newKinds = [...new Set(seen[8].map((l) => l.kind))].filter((k) => !kinds1.has(k));
    check('at 8x a kind of place is labelled that 1x does not show', newKinds.length > 0,
      `1x ${[...kinds1].join(', ')}; 8x ${[...new Set(seen[8].map((l) => l.kind))].join(', ')}`);
    // Finer map tiles are asked for only zoomed in, at most 12 a step, for the view's wedge.
    const finer = [1, 2, 4, 8].map((z) => {
      const zs = tiles[z].map(tileZ);
      const ok = z === 1 ? zs.length === 0 : zs.length >= 1 && zs.length <= 12 && zs.every((t) => t === FINER_Z[z]);
      return { z, ok, text: `${z}x: ${zs.length ? zs.join(',') : 'none'}` };
    });
    check('zoomed in, up to 12 finer map tiles are asked for at each step, none at 1x', finer.every((f) => f.ok), finer.map((f) => f.text).join(' | '));
    const hiddenOff = await p.evaluate(() => !window.__binoculars.settings.showHidden);
    const terrain = [1, 2, 4, 8].flatMap((z) => seen[z].filter((l) => l.blockedBy === 'terrain').map((l) => `${z}x ${l.name}`));
    check('places behind hills stay hidden at every zoom while the setting is off', hiddenOff && terrain.length === 0, terrain.join(', '));

    // Tétouan, M'Diq, Ceuta, Fnideq and Anjra (202-212°) are past the curve of the earth, right
    // of Jebel Musa, which zoomed to 4x is out of frame.
    await look(p, 207, 1);
    await p.waitForTimeout(1500);
    const at1 = await labels(p);
    show('207° 1', at1);
    const curve1 = at1.filter((l) => l.blockedBy === 'curve').map((l) => l.name);
    check('at 1x places below the horizon stay out while the setting is off', curve1.length === 0, curve1.join(', '));
    await look(p, 207, 4);
    await p.waitForTimeout(1500);
    const at4 = await labels(p);
    show('207° 4', at4);
    await p.screenshot({ path: path.join(OUT, 'beyond-4x.png') });
    const moroccan = at4.filter((l) => l.country === 'Morocco' && SETTLEMENT.includes(l.kind) && l.blockedBy === 'curve').map((l) => l.name);
    check('at 4x the Moroccan towns past the curve of the earth are labelled', moroccan.length >= 2, moroccan.join(', ') || 'none');
    const curve4 = at4.filter((l) => l.blockedBy === 'curve');
    check('each is greyed and tagged beyond the horizon',
      curve4.length > 0 && curve4.every((l) => /^Beyond horizon · /.test(l.meta)), curve4.map((l) => `${l.name}: ${l.meta}`).join(' | ') || 'none');
    const grey = await p.evaluate(() => [...document.querySelectorAll('.label.on:not([hidden])')].filter((el) => el._p?.blockedBy === 'curve').every((el) => el.classList.contains('hidden-place')));
    check('places beyond the horizon are drawn greyed, like other hidden places', curve4.length > 0 && grey);

    // At 8x, a little right of Jebel Musa (215°), the villages of the far shore: Eddalya, Hassana
    // and Mliech at 218-220°, 85 to 100 km off. At 215° itself the only one in frame that is not
    // behind a hill is Rehana.
    await look(p, 218, 8);
    await p.waitForTimeout(2500);
    const at8 = await labels(p);
    show('218° 8', at8);
    await p.screenshot({ path: path.join(OUT, 'villages-8x.png') });
    const towns8 = at8.filter((l) => l.country === 'Morocco' && SETTLEMENT.includes(l.kind)).map((l) => l.name);
    check('at 8x Moroccan villages across the sea are labelled, the setting for hidden places off', hiddenOff && towns8.length >= 2, towns8.join(', ') || 'none');

    // Names said once. Gibraltar (226°, 58 km, past the curve) is a city in a country of the
    // same name, so its label and its info card leave the country out; the Rock of Gibraltar
    // beside it still names it. San Pedro de Alcántara comes from both the map tiles and
    // Overpass, spelt with and without "de", and is one place.
    await look(p, 226, 2);
    await p.waitForTimeout(2000);
    const at226 = await labels(p);
    show('226° 2', at226);
    const gib = at226.find((l) => l.name === 'Gibraltar');
    const rock = at226.find((l) => l.name === 'Rock of Gibraltar');
    check('a place named like its country does not repeat the name on its label',
      gib && !/Gibraltar/.test(gib.meta) && rock && /Gibraltar/.test(rock.meta),
      `${gib ? gib.meta : 'no Gibraltar label'} | ${rock ? rock.meta : 'no Rock of Gibraltar label'}`);
    const lead = await p.evaluate(() => {
      const el = [...document.querySelectorAll('.label.on:not([hidden])')].find((x) => x._p?.name === 'Gibraltar');
      if (!el) return null;
      el.click();
      return document.getElementById('info').hidden ? null : document.getElementById('info-lead').textContent;
    });
    check('nor in its info card', lead && !/in Gibraltar/.test(lead) && /in Europe/.test(lead), lead ?? 'no info card');
    await p.evaluate(() => document.querySelector('[data-close="info"]').click());
    const sanPedro = await p.evaluate(() => window.__binoculars.world.places.filter((q) => /^San Pedro/.test(q.name)).map((q) => q.name));
    check('one San Pedro de Alcántara, not one for each spelling', sanPedro.length === 1, sanPedro.join(', '));
    errors.push(...e);
    await ctx.close();
  }

  // 2. Scan hints: facing due south at 1x nothing is under the reticle, so the nearest place
  // worth turning to just out of view on each side is named at that edge, with its distance,
  // clear of the banner, the card, the chips and the bar, on a small phone and a large one.
  const HINT = /^‹ \S.* \d+(\.\d)? km$|^\S.* \d+(\.\d)? km ›$/;
  for (const vp of [{ width: 375, height: 667 }, { width: 430, height: 860 }]) {
    const { ctx, p, errors: e } = await open(b, vp, 180);
    await look(p, 180, 1);
    await p.waitForTimeout(1500);
    const hintState = () => p.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
      const shown = (el) => el && !el.hidden && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
      return {
        locked: document.getElementById('reticle').classList.contains('locked'),
        hints: [...document.querySelectorAll('.edge-hint')].filter(shown).map((el) => ({ text: el.textContent, box: box(el) })),
        others: ['banner', 'target', 'chips', 'hud', 'empty'].map((id) => document.getElementById(id)).filter(shown).map((el) => ({ id: el.id, box: box(el) })),
      };
    });
    const s = await hintState();
    await p.screenshot({ path: path.join(OUT, `hints-${vp.width}.png`) });
    console.log(`  ${vp.width}x${vp.height} 180° 1x: ${s.locked ? 'locked; ' : ''}${s.hints.map((h) => h.text).join(' | ') || 'no hints'}`);
    const bad = s.hints.filter((h) => !HINT.test(h.text)).map((h) => `"${h.text}"`);
    const off = s.hints.filter(({ box: [l, t, r, bt] }) => l < 0 || t < 0 || r > vp.width || bt > vp.height).map((h) => `${h.text} off screen`);
    const hits = s.hints.flatMap((h) => s.others
      .filter(({ box: o }) => h.box[0] < o[2] && h.box[2] > o[0] && h.box[1] < o[3] && h.box[3] > o[1])
      .map((o) => `${h.text} over #${o.id}`));
    const sides = s.hints.map((h) => (h.text.startsWith('‹') ? 'left' : 'right'));
    check(`at ${vp.width}x${vp.height}, nothing locked, the nearest place out of view each side is named at that edge`,
      !s.locked && s.hints.length >= 1 && new Set(sides).size === sides.length && !bad.length && !off.length && !hits.length,
      [s.locked ? 'locked' : '', `${s.hints.length} hints`, ...bad, ...off, ...hits].filter(Boolean).join(', '));
    if (vp.width === 375) {
      await look(p, 215, 1);
      await p.waitForTimeout(1500);
      const t = await hintState();
      check('with a place under the reticle there are no edge hints', t.locked && t.hints.length === 0, `${t.locked ? 'locked' : 'not locked'}; ${t.hints.map((h) => h.text).join(' | ')}`);
    }
    errors.push(...e);
    await ctx.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));
  await b.close();
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
