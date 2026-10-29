import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupe, loadPlaces, withMajor } from '../js/places.mjs';

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

// Fault: one summit labelled twice because two mappers spelt it differently ("Jbel Musa",
// "Jebel Musa"). Edges: 2.9 km apart still collapses, the same name 5 km away is a different
// place, an accent, capitals or a "Pico" prefix make no difference, and a bare "Monte" stays.
test('near-identical names within 3 km collapse to the better one', () => {
  const at = (id, name, km) => ({ id, name, lat: 35.9 + km / 111.2, lon: -5.4 });
  const best = [
    at('a', 'Jebel Musa', 0),
    at('b', 'Jbel Musa', 1),
    at('c', 'Djebel Musa', 2.9),
    at('d', 'Jebel Musa', 5),
    at('e', 'Pico Veleta', 10),
    at('f', 'Veleta', 11),
    at('g', 'Málaga', 20),
    at('h', 'MALAGA', 20.5),
    at('i', 'Musa', 0.5), // no prefix stripped from a bare name: still the same mountain
    at('j', 'Monte', 30), // a prefix with nothing after it is a name of its own
    at('k', 'Mount Monte', 30.2),
  ];
  assert.deepEqual(dedupe(best).map((p) => p.id), ['a', 'd', 'e', 'g', 'j']);
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

// Fault: Overpass is still asked for towns, villages and peaks, which the map tiles already
// give in seconds, so a busy server spends minutes on them. Edge: every part asked for.
test('Overpass is asked only for what the map tiles lack', async (t) => {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, { body }) => {
    asked.push(decodeURIComponent(body));
    return { ok: true, json: async () => ({ elements: [] }) };
  };
  t.after(() => (globalThis.fetch = realFetch));
  await loadPlaces(36.5, -4.9, 150, { fresh: true });
  const all = asked.join('\n');
  assert.doesNotMatch(all, /"place"|"natural"~|aerodrome/);
  for (const what of ['lighthouse', 'cape', 'castle', 'marina', 'viewpoint']) assert.match(all, new RegExp(what));
});

// Fault: a town from the map tiles is shown twice when its English name differs from the
// bundled one ("Málaga City", "Málaga"), and it ranks lower for having no population.
test('a bundled town gives way to the same town under another spelling, and lends its population', () => {
  const tiles = [{ id: 't1', name: 'Málaga City', names: ['Málaga'], lat: 36.7213, lon: -4.4214, population: null }];
  const major = [{ id: 'ne1', name: 'Malaga', lat: 36.7196, lon: -4.42, population: 574654 }];
  const out = withMajor(tiles, major);
  assert.deepEqual(out.map((p) => [p.id, p.population]), [['t1', 574654]]);
});

// Fault: one mountain labelled twice, as Wikidata and OpenStreetMap spell it ("Jebel Moussa",
// "Jebel Musa"). Edges: a mapped peak 1.4 km away takes over; one 1.6 km away does not, and
// neither does a town close by.
test('a bundled peak gives way to a mapped peak within 1.5 km whatever its spelling', () => {
  const at = (id, name, kind, km) => ({ id, name, kind, lat: 35.9 + km / 111.2, lon: -5.4 });
  const mapped = [at('t1', 'Jebel Musa', 'peak', 0), at('t2', 'Pico Mijas', 'peak', 10), at('t3', 'Benzú', 'village', 20)];
  const major = [at('nep1', 'Jebel Moussa', 'peak', 0.03), at('nep2', 'Sierra de Mijas', 'peak', 11.6), at('nep3', 'Bullones', 'peak', 20.1), at('nep4', 'Mijas', 'peak', 8.6)];
  assert.deepEqual(withMajor(mapped, major).map((p) => p.id), ['t1', 't2', 't3', 'nep2', 'nep3']);
});
