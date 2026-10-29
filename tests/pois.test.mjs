import test from 'node:test';
import assert from 'node:assert/strict';
import { poiPlan, poiRange, poisOf, safeWebsite } from '../js/pois.mjs';

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

// Fault: a website tag from OpenStreetMap becomes a link that runs script (javascript:), opens
// another app (mailto:, data:), or points nowhere. Edge: several values, a bare domain.
test('only a real web address becomes a website link', () => {
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.com', 'ftp://example.com', 'localhost', '', null, undefined, 'https://', 'not a url'])
    assert.equal(safeWebsite(bad), null, String(bad));
  assert.equal(safeWebsite('https://example.com/casa'), 'https://example.com/casa');
  assert.equal(safeWebsite('http://example.com'), 'http://example.com/');
  assert.equal(safeWebsite('www.example.es'), 'https://www.example.es/', 'a bare domain gets https');
  assert.equal(safeWebsite('https://a.example.com; https://b.example.com'), 'https://a.example.com/', 'the first of several');
});

// Fault: hotels, hostels and guest houses are dropped, so zooming on a seafront names nothing.
// Edge: a nameless hotel, and a camp site, which is not somewhere people look for a room.
test('hotels, hostels and guest houses count as places to stay', () => {
  const out = poisOf([
    feature(11, 'lodging', 'hotel', 'Puente Romano'),
    feature(21, 'lodging', 'hostel', 'Apartamentos Marina'),
    feature(31, 'lodging', 'guest_house', 'Casa Azul'),
    feature(41, 'lodging', 'hotel', null),
    feature(51, 'campsite', 'camp_site', 'Camping Marbella'),
  ]);
  assert.deepEqual(out.map((p) => [p.name, p.kind, p.type]), [
    ['Puente Romano', 'stay', 'Hotel'],
    ['Apartamentos Marina', 'stay', 'Hostel'],
    ['Casa Azul', 'stay', 'Guest house'],
  ]);
});

// Fault: zoomed in, points of interest stop at 8 km, so a stretch of coast 10–16 km off names
// nothing; or the wedge stays 5° wider than the view whatever the zoom and fetches a fan of
// tiles nobody is looking at. Edge: 8×, the furthest and narrowest view.
test('zoomed in, the plan reaches 16 km down a narrow wedge', () => {
  assert.equal(poiRange(1), 4);
  assert.equal(poiRange(4), 16);
  assert.equal(poiRange(8), 16);
  // 8× on a phone: the view is about 4° wide either side.
  const plan = poiPlan(36.5068, -4.886, 268, 4 / 8 + 5 / 8, 8);
  assert.ok(Math.max(...plan.map((t) => t.d)) > 14, 'reaches past 14 km');
  assert.ok(plan.length <= 12, `${plan.length} tiles`);
});
