// Fault: a place-name load for the first position, still answering after a move of over 2 km,
// overwrites the new position's place list. The first position's replies are held until the
// second load finishes, then released; a height change follows.
// Fault 2: every move of over 2 km blanks the labels until the new names arrive. A third
// position's replies are held, and the labels must still show while they are.
// Place names are faked; terrain comes from the live server. Run like browser.e2e.cjs:
//   NODE_PATH=<dir with playwright installed>/node_modules node tests/move.e2e.cjs
const { chromium } = require('playwright');
const A = { latitude: 36.5068, longitude: -4.886 };
const B = { latitude: 36.55, longitude: -4.886 }; // ~4.8 km north
const C = { latitude: 36.5932, longitude: -4.886 }; // ~4.8 km further
(async () => {
  const b = await chromium.launch({ channel: 'chromium' });
  const ctx = await b.newContext({ viewport: { width: 430, height: 860 }, geolocation: A, permissions: ['geolocation'] });
  const p = await ctx.newPage();
  let phase = 'A';
  const held = [];
  const heldC = [];
  const reply = (r, name, lat = 36.45) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ elements: [
    { type: 'node', id: Math.floor(Math.random() * 1e9), lat, lon: -4.95, tags: { place: 'town', name } }] }) });
  await p.route(/\/interpreter/, (r) => {
    if (phase === 'A') return held.push(r);
    if (phase === 'B') return reply(r, 'Newtown');
    if (phase === 'C') return heldC.push(r);
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

  const atB = await p.evaluate(() => window.__binoculars.world.places.find((x) => x.name === 'Newtown')?.d);
  phase = 'C';
  await ctx.setGeolocation(C);
  await p.waitForFunction(() => window.__binoculars.world.gen === 3 && !window.__binoculars.world.busy, null, { timeout: 300000, polling: 200 });
  await p.waitForTimeout(1000);
  const atC = await p.evaluate(() => window.__binoculars.world.places.find((x) => x.name === 'Newtown')?.d);
  console.log('names held after second move:', heldC.length, 'Newtown distance from B, then C:', atB, atC);
  const ok2 = heldC.length > 0 && atC > 0 && Math.abs(atC - atB) > 3000;
  console.log(ok2 ? 'PASS labels stay up, measured from the new position' : 'FAIL labels blank while new names load');

  // Fault 3: the first new part to land replaces the kept list, so labels from the other parts
  // go blank. Edge: one part of four lands, the rest are still held.
  await reply(heldC.shift(), 'Fresh', 36.4);
  await p.waitForFunction(() => window.__binoculars.world.places.some((x) => x.name === 'Fresh'), null, { timeout: 60000, polling: 200 });
  const atC1 = await p.evaluate(() => window.__binoculars.world.places.map((x) => x.name));
  const ok3 = atC1.includes('Newtown');
  console.log('places after one new part lands:', JSON.stringify([...new Set(atC1)]));
  console.log(ok3 ? 'PASS kept labels stay up while other parts load' : 'FAIL first part dropped the kept labels');
  for (const r of heldC) await r.abort();
  await ctx.close();
  await b.close();
  process.exit(ok && ok2 && ok3 ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
