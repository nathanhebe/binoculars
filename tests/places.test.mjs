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
