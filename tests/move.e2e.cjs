// Fault: a place-name load for the first position, still answering after a move of over 2 km,
// overwrites the new position's place list. The first position's replies are held until the
// second load finishes, then released; a height change follows.
// Place names are faked; terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/move.e2e.cjs
const { chromium } = require('playwright');
const A = { latitude: 36.5068, longitude: -4.886 };
const B = { latitude: 36.55, longitude: -4.886 }; // ~4.8 km north
(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, geolocation: A, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  let phase = 'A';
  const held = [];
  const reply = (r, name) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [
    { type: 'node', id: Math.floor(Math.random() * 1e9), lat: 36.45, lon: -4.95, tags: { place: 'town', name } }] }) });
  await p.route(/\/interpreter/, (r) => {
    if (phase === 'A') return held.push(r);
    if (phase === 'B') return reply(r, 'Newtown');
    return reply(r, 'Oldtown');
  });
  const base = process.env.BASE_URL || "http://localhost:8765/";
  await p.goto(base + '?nocam=1');
  await p.evaluate(() => localStorage.removeItem('binoculars:places:v1'));
  await p.goto(base + '?nocam=1&heading=215&autostart=1');
  await p.waitForFunction(() => window.__binoculars?.world.horizon.length && !window.__binoculars.world.busy, null, { timeout: 300000, polling: 500 });
  phase = 'B';
  await ctx.setGeolocation(B);
  await p.waitForFunction(() => window.__binoculars.world.gen === 2 && window.__binoculars.world.placesDone, null, { timeout: 300000, polling: 500 });
  phase = 'late';
  for (const r of held) await reply(r, 'Oldtown');
  await p.waitForTimeout(3000);
  await p.evaluate(() => { const h = document.getElementById('hag'); h.value = 40; h.dispatchEvent(new Event('input')); h.dispatchEvent(new Event('change')); });
  await p.waitForFunction(() => !window.__binoculars.world.busy, null, { timeout: 120000, polling: 200 });
  await p.waitForTimeout(500);
  const names = await p.evaluate(() => ({ items: window.__binoculars.world.items.map((x) => x.name), places: window.__binoculars.world.places.map((x) => x.name) }));
  console.log('held from first position:', held.length, JSON.stringify(names));
  const ok = names.items.includes('Newtown') && !names.items.includes('Oldtown') && names.places.includes('Newtown');
  console.log(ok ? 'PASS new position kept its places' : 'FAIL old position overwrote the places');
  await ctx.close();
  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
