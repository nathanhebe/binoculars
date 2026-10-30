// Turn device orientation angles into where the back camera points.
// World frame: x = east, y = north, z = up. Device frame (W3C): x = right edge, y = top edge,
// z = out of the screen, so the back camera looks along -z.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// W3C DeviceOrientation: R = Rz(alpha) * Rx(beta) * Ry(gamma).
function rotation(alpha, beta, gamma) {
  const [ca, sa] = [Math.cos(rad(alpha)), Math.sin(rad(alpha))];
  const [cb, sb] = [Math.cos(rad(beta)), Math.sin(rad(beta))];
  const [cg, sg] = [Math.cos(rad(gamma)), Math.sin(rad(gamma))];
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
}

const apply = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];

// Camera axes in the world frame: forward (where it looks), up and right as on screen.
// `screenAngle` is screen.orientation.angle (0 in portrait).
export function cameraAxes(alpha, beta, gamma, screenAngle = 0) {
  const m = rotation(alpha, beta, gamma);
  const s = rad(screenAngle);
  const right = apply(m, [Math.cos(s), -Math.sin(s), 0]);
  const up = apply(m, [Math.sin(s), Math.cos(s), 0]);
  const forward = apply(m, [0, 0, -1]);
  return { forward, up, right };
}

// Axes for a camera pointing at `heading` (degrees from north) and `pitch` (degrees above level),
// held level — used when there are no sensors (desktop) and to build test views.
export function axesFrom(heading, pitch) {
  const h = rad(heading);
  const p = rad(pitch);
  return {
    forward: [Math.cos(p) * Math.sin(h), Math.cos(p) * Math.cos(h), Math.sin(p)],
    up: [-Math.sin(p) * Math.sin(h), -Math.sin(p) * Math.cos(h), Math.cos(p)],
    right: [Math.cos(h), -Math.sin(h), 0],
  };
}

export const headingOf = (v) => (deg(Math.atan2(v[0], v[1])) + 360) % 360;
export const pitchOf = (v) => deg(Math.asin(Math.max(-1, Math.min(1, v[2]))));

// Spin all three axes about the vertical by `d` degrees clockwise (compass correction).
export function turn(axes, d) {
  const c = Math.cos(rad(d));
  const s = Math.sin(rad(d));
  const r = (v) => [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
  return { forward: r(axes.forward), up: r(axes.up), right: r(axes.right) };
}

// Unit vector towards a point at compass bearing `az` and `el` degrees above level.
export function direction(az, el) {
  const a = rad(az);
  const e = rad(el);
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}
