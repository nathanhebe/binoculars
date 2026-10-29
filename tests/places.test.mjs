import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaces, withMajor } from '../js/places.mjs';

// Fault: the saved place list is reused after the viewer has moved far enough that nearby
// hamlets and viewpoints (only asked for within 12 km) fall outside it. Edge: a few km move.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  return { ok: true, json: async () => ({ elements: [] }) };
};

const saveAt = (lat, lon) =>
  store.set('binoculars:places:v1', JSON.stringify({ t: Date.now(), lat, lon, range: 150, items: [{ id: 'n1' }] }));

test('saved places are reused when the viewer has barely moved', async () => {
  saveAt(36.5, -4.9);
  fetches = 0;
  const items = await loadPlaces(36.504, -4.9, 150); // ~0.4 km north
  assert.equal(fetches, 0);
  assert.deepEqual(items, [{ id: 'n1' }]);
});

test('saved places are fetched again after a move of a few km', async () => {
  saveAt(36.5, -4.9);
  fetches = 0;
  await loadPlaces(36.527, -4.9, 150); // ~3 km north
  assert.ok(fetches > 0, 'stale list reused');
});

// Fault: a bundled town shows twice once OpenStreetMap has it too, because the two spell it
// differently ("Tétouan", "Tetouan"). Edge: a same-named place 10 km away is a different place.
test('a bundled town gives way to the same town from OpenStreetMap', () => {
  const osm = [{ id: 'n1', name: 'Tetouan', lat: 35.5785, lon: -5.3684 }];
  const major = [
    { id: 'ne1', name: 'Tétouan', lat: 35.5704, lon: -5.3724 }, // ~1 km away
    { id: 'ne2', name: 'Tangier', lat: 35.7473, lon: -5.8270 },
    { id: 'ne3', name: 'Tetouan', lat: 35.6685, lon: -5.3684 }, // ~10 km away
  ];
  assert.deepEqual(withMajor(osm, major).map((p) => p.id), ['n1', 'ne2', 'ne3']);
});

// Fault: a server that accepts the request and never answers holds that part for over two
// minutes before the next server is tried. Edge: it never answers at all.
test('a server that never answers is given up on after 25 s for the next one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, { body, signal }) => {
    asked.push({ url, body: decodeURIComponent(body) });
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  };
  t.after(() => (globalThis.fetch = realFetch));
  loadPlaces(36.5, -4.9, 150, { fresh: true });
  const settle = () => new Promise((r) => setImmediate(r));
  await settle();
  assert.equal(new Set(asked.map((a) => a.url)).size, 1, 'both parts start on the first server');
  t.mock.timers.tick(24999);
  await settle();
  assert.equal(asked.length, 2, 'gave up before 25 s');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(asked.length, 4, 'still waiting on the first server after 25 s');
  assert.equal(new Set(asked.map((a) => a.url)).size, 2);
  assert.ok(asked.every((a) => a.body.includes('[timeout:25]')), 'server told to give up after 25 s too');
});

// Fault: the first part asked for also carries islands and capes, so on a busy server the
// towns and peaks people point at wait behind them. Edge: the very first request.
test('the first part asked for is the small one: towns, cities and nearby peaks', async (t) => {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, { body }) => {
    asked.push(decodeURIComponent(body));
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  t.after(() => (globalThis.fetch = realFetch));
  await loadPlaces(36.5, -4.9, 150, { fresh: true });
  assert.match(asked[0], /"place"~"\^\(city\|town\)\$"/);
  assert.match(asked[0], /"natural"~"\^\(peak\|volcano\)\$"/);
  assert.doesNotMatch(asked[0], /island|cape|village|lighthouse/);
});
