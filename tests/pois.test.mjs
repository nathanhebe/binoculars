import test from 'node:test';
import assert from 'node:assert/strict';
import { poiPlan, poisOf } from '../js/pois.mjs';

// Fault: points of interest from the zoom-14 map tiles come through as the wrong category, or
// things nobody scans a view for (nightclubs, kiosks, bus stops, nameless places) get labels.
const feature = (id, cls, subclass, name, extra = {}) => ({
  layer: 'poi', id, lat: 36.511, lon: -4.885, tags: { class: cls, subclass, ...(name ? { name } : {}), ...extra },
});

test('map points of interest are sorted into food, shops, travel and sights', () => {
  const out = poisOf([
    feature(23537546291, 'restaurant', 'restaurant', 'El Cortijo'),
    feature(23537538421, 'clothing_store', 'clothes', 'Jacaranda'),
    feature(98557142051, 'ferry_terminal', 'ferry_terminal', 'Ferry to Puerto Banus'),
    feature(44283336511, 'castle', 'castle', 'Castillo de Marbella'),
    feature(1263038742, 'bus', 'bus_station', 'Estación de autobuses'),
    feature(93555192601, 'bar', 'nightclub', 'Taok'),
    feature(7159006892, 'shop', 'kiosk', 'Quiosco de la Iglesia'),
    feature(5, 'bus', 'bus_stop', 'Parada'),
    feature(6, 'restaurant', 'restaurant', null),
  ]);
  const by = Object.fromEntries(out.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(by).sort(), ['Castillo de Marbella', 'El Cortijo', 'Estación de autobuses', 'Ferry to Puerto Banus', 'Jacaranda']);
  assert.equal(by['El Cortijo'].kind, 'food');
  assert.equal(by['El Cortijo'].type, 'Restaurant');
  assert.deepEqual(by['El Cortijo'].osm, { type: 'node', id: 2353754629 });
  assert.equal(by.Jacaranda.kind, 'shops');
  assert.equal(by.Jacaranda.type, 'Clothes shop');
  assert.equal(by['Ferry to Puerto Banus'].kind, 'travel');
  assert.equal(by['Estación de autobuses'].kind, 'travel');
  assert.deepEqual(by['Estación de autobuses'].osm, { type: 'way', id: 126303874 });
  assert.equal(by['Castillo de Marbella'].kind, 'sights');
  // Castles and ferry ports show when zoomed in without a category chosen; restaurants never do.
  assert.equal(by['Castillo de Marbella'].landmark, true);
  assert.equal(by['Ferry to Puerto Banus'].landmark, true);
  assert.equal(by['El Cortijo'].landmark, false);
});

// Fault: tiles are fetched for the whole circle round the viewer, or far ones first, instead of
// the narrow wedge being looked at, nearest first. Edge: the tile behind the viewer.
test('only the tiles in the direction looked at are planned, nearest first', () => {
  const key = (t) => `${t.z}/${t.x}/${t.y}`;
  const north = poiPlan(36.5068, -4.886, 10, 20, 1);
  assert.equal(key(north[0]), '14/7969/6405', 'the tile under the viewer comes first');
  assert.ok(north.map(key).includes('14/7969/6404'), 'the old town to the north is planned');
  assert.deepEqual(north.map((t) => t.d), [...north.map((t) => t.d)].sort((a, b) => a - b));
  const south = poiPlan(36.5068, -4.886, 190, 20, 1);
  assert.ok(!south.map(key).includes('14/7969/6404'), 'the tile behind the viewer is not planned');
  assert.ok(poiPlan(36.5068, -4.886, 10, 20, 8).length > north.length, 'further when zoomed in');
});
