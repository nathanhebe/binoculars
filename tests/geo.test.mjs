import test from 'node:test';
import assert from 'node:assert/strict';
import { apparentAngle, bearing, compass, distance, horizonAlong, lineOfSight } from '../js/geo.mjs';

// Marbella beach to the summit of Jebel Musa, Morocco.
const MARBELLA = [36.5075, -4.8833];
const JEBEL_MUSA = [35.8986, -5.4097];

test('distance and bearing match known values', () => {
  const d = distance(...MARBELLA, ...JEBEL_MUSA);
  assert.ok(Math.abs(d - 82300) < 1500, `distance ${d}`);
  const b = bearing(...MARBELLA, ...JEBEL_MUSA);
  assert.ok(Math.abs(b - 215) < 2, `bearing ${b}`);
  assert.equal(compass(b), 'SW');
});

test('a far peak tall enough clears the curve from the beach', () => {
  // Jebel Musa is 851 m; from a 2 m eye at 82 km the curve hides ~450 m of it, not all.
  const sea = () => 0;
  const los = lineOfSight(sea, ...MARBELLA, 2, ...JEBEL_MUSA, 851);
  assert.equal(los.visible, true);
});

test('the curve hides a sea-level target 20 km away from a 2 m eye', () => {
  const sea = () => 0;
  const target = [MARBELLA[0] - 0.18, MARBELLA[1]]; // ~20 km south, over the sea
  const los = lineOfSight(sea, ...MARBELLA, 2, ...target, 0);
  assert.equal(los.visible, false);
  assert.equal(los.blockedBy, 'curve');
  // ...and a 300 m cliff at the same spot is plainly visible.
  assert.equal(lineOfSight(sea, ...MARBELLA, 2, ...target, 300).visible, true);
});

test('a ridge hides a town behind it, but not one in front', () => {
  // A 500 m ridge running east-west 5 km north of the viewer.
  const [lat0, lon0] = [37, -4];
  const ridgeLat = lat0 + 5000 / 111320;
  const ground = (lat) => (Math.abs(lat - ridgeLat) < 0.004 ? 500 : 0);
  const behind = lineOfSight(ground, lat0, lon0, 2, lat0 + 10000 / 111320, lon0, 50);
  assert.equal(behind.visible, false);
  assert.equal(behind.blockedBy, 'terrain');
  const before = lineOfSight(ground, lat0, lon0, 2, lat0 + 3000 / 111320, lon0, 50);
  assert.equal(before.visible, true);
});

// Fault: the line of sight stops 3% short for every place, so a far town just behind a ridge
// shows as visible. Edge: a ridge 1 km in front of a village 50 km away (inside the 1.5 km gap).
test('a far village close behind a ridge is hidden', () => {
  const [lat0, lon0] = [37, -4];
  const vLat = lat0 + 50000 / 111320;
  const ridge = (lat) => (Math.abs(lat - (vLat - 1000 / 111320)) < 0.002 ? 900 : 100);
  const los = lineOfSight(ridge, lat0, lon0, 600, vLat, lon0, 112);
  assert.equal(los.visible, false);
  assert.equal(los.blockedBy, 'terrain');
});

test('a summit is not hidden by the terrain data right beside it', () => {
  // Coarse terrain data often puts the ground just in front of a summit a little above the
  // summit's tagged height; that must not count as hiding it.
  const [lat0, lon0] = [37, -4];
  const summitLat = lat0 + 10000 / 111320;
  const ground = (lat) => (lat > summitLat - 100 / 111320 ? 1015 : 0);
  assert.equal(lineOfSight(ground, lat0, lon0, 2, summitLat, lon0, 1000, { peak: true }).visible, true);
});

test('skyline over open sea sits just below level, at the geometric horizon', () => {
  const sea = () => 0;
  const h = horizonAlong(sea, ...MARBELLA, 2, 180, 150000);
  // With refraction the dip from 2 m is about 0.043 degrees.
  assert.ok(h.angle < 0 && h.angle > -0.1, `angle ${h.angle}`);
  assert.equal(h.landD, 0);
  assert.ok(Math.abs(apparentAngle(2, 0, 100000)) > Math.abs(h.angle) - 1e-9);
});
