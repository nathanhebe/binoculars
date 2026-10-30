// Pure geometry: distances, bearings, and what the earth's curve and terrain hide.

export const EARTH_RADIUS = 6371008.8;
// Standard atmospheric refraction coefficient: light bends round the curve a little,
// so the earth looks flatter than it is (effective radius R / (1 - k)).
export const REFRACTION = 0.13;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Initial great-circle bearing, degrees clockwise from true north, 0..360.
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Signed smallest difference a - b in degrees, in (-180, 180].
export function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// Angle above (+) or below (-) level, in degrees, of a point `h` metres above sea level at
// `d` metres away, seen from an eye `eye` metres above sea level, allowing for curvature
// and refraction.
export function apparentAngle(eye, h, d) {
  const drop = (d * d * (1 - REFRACTION)) / (2 * EARTH_RADIUS);
  return deg(Math.atan2(h - drop - eye, d));
}

// Sample spacing along a ray: fine close up, coarser far away (terrain detail shrinks with distance).
export function stepFor(d) {
  return Math.max(25, d * 0.008);
}

// A ray stepper using a local flat projection; over 150 km its error is far smaller than
// the terrain data's resolution.
function rayDeltas(lat, brg) {
  const b = rad(brg);
  const dLat = deg(Math.cos(b) / EARTH_RADIUS);
  const dLon = deg(Math.sin(b) / (EARTH_RADIUS * Math.cos(rad(lat))));
  return [dLat, dLon];
}

// Walk outward along `brg` from the viewer to `maxD` metres and report the skyline:
// the highest apparent angle and where it is. `elev(lat, lon)` gives ground height in metres
// (sea = 0). Also reports the farthest land on the ray, seen or not.
export function horizonAlong(elev, lat, lon, eye, brg, maxD, startD = 60) {
  const [dLat, dLon] = rayDeltas(lat, brg);
  let best = -90;
  let bestD = startD;
  let bestH = 0;
  let landD = 0;
  for (let d = startD; d <= maxD; d += stepFor(d)) {
    const h = elev(lat + dLat * d, lon + dLon * d);
    const a = apparentAngle(eye, h, d);
    if (a > best) {
      best = a;
      bestD = d;
      bestH = h;
    }
    if (h > 2) landD = d;
  }
  return {
    angle: best,
    d: bestD,
    h: bestH,
    lat: lat + dLat * bestD,
    lon: lon + dLon * bestD,
    landD,
    landLat: lat + dLat * landD,
    landLon: lon + dLon * landD,
  };
}

// Is a target `top` metres above sea level at (tLat, tLon) visible from the viewer?
// Returns its apparent angle, whether it clears everything in front of it, and the height of
// whatever blocks it (sea level means the earth's curve hides it).
export function lineOfSight(elev, lat, lon, eye, tLat, tLon, top, { peak = false, startD = 60 } = {}) {
  const d = distance(lat, lon, tLat, tLon);
  const brg = bearing(lat, lon, tLat, tLon);
  const angle = apparentAngle(eye, top, d);
  // Stop short of the target so its own slopes don't count as blocking it. A summit's tagged
  // height can sit below the coarse terrain around it, so peaks get a wider gap.
  const end = peak ? Math.min(d * 0.97, d - 150) : d - 150;
  const [dLat, dLon] = rayDeltas(lat, brg);
  let block = -90;
  let blockH = 0;
  for (let s = startD; s < end; s += stepFor(s)) {
    const h = elev(lat + dLat * s, lon + dLon * s);
    const a = apparentAngle(eye, h, s);
    if (a > block) {
      block = a;
      blockH = h;
    }
  }
  const visible = d < 200 || angle >= block - 0.02;
  return { d, brg, angle, visible, blockedBy: visible ? null : blockH <= 2 ? 'curve' : 'terrain' };
}

export function compass(brg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((brg % 360) + 360) % 360) / 22.5) % 16];
}
