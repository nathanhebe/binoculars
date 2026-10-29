import test from 'node:test';
import assert from 'node:assert/strict';

// Imported this way so that, before finerPlan existed, this fails on its assertion rather than
// on the import.
const T = await import('../js/tiles.mjs');

// Fault: zooming in asks for no finer map tiles, so the villages and hamlets they name never
// appear, or it asks for the whole circle round the viewer, or far tiles first, or the heaviest
// zoom-14 tiles. Edge: 1×, where nothing extra is wanted, and the tile behind the viewer.
test('zoomed in, finer tiles are planned for the view only, nearest first', () => {
  assert.equal(typeof T.finerPlan, 'function', 'there is a plan for finer tiles');
  const key = (t) => `${t.z}/${t.x}/${t.y}`;
  const at = (heading, half, step) => T.finerPlan(36.5068, -4.886, heading, half, step, 150);
  assert.deepEqual(at(215, 20, 1), [], 'none at 1×');
  for (const [step, z] of [[2, 10], [4, 11], [8, 12]]) {
    const plan = at(215, 20 / step + 2, step);
    assert.ok(plan.length > 0, `some at ${step}×`);
    assert.ok(plan.every((t) => t.z === z), `zoom ${z} tiles at ${step}×`);
    assert.deepEqual(plan.map((t) => t.d), [...plan.map((t) => t.d)].sort((a, b) => a - b), `nearest first at ${step}×`);
  }
  const n = 2 ** 11;
  const under = `11/${Math.floor(((-4.886 + 180) / 360) * n)}/${Math.floor(((1 - Math.asinh(Math.tan((36.5068 * Math.PI) / 180)) / Math.PI) / 2) * n)}`;
  const south = at(215, 7, 4).map(key);
  assert.equal(south[0], under, 'the tile under the viewer comes first');
  const north = at(35, 7, 4).map(key);
  const behind = south.filter((k) => k !== under && north.includes(k));
  assert.deepEqual(behind, [], 'looking south asks for nothing that looking north does, beyond the tile underfoot');
});
