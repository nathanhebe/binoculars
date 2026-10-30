// Which country (and continent) a point lies in, from Natural Earth borders (public domain),
// simplified to keep the download small.

let features = null;

export async function loadCountries(url = 'assets/countries.json') {
  const geo = await (await fetch(url)).json();
  features = geo.features.map((f) => {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const poly of polys)
      for (const [x, y] of poly[0]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    return { name: f.properties.NAME, continent: f.properties.CONTINENT, polys, bbox: [minX, minY, maxX, maxY] };
  });
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function exact(lat, lon) {
  for (const f of features) {
    const [minX, minY, maxX, maxY] = f.bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    for (const poly of f.polys) {
      if (!inRing(poly[0], lon, lat)) continue;
      if (poly.slice(1).some((hole) => inRing(hole, lon, lat))) continue;
      return f;
    }
  }
  return null;
}

// The Canaries are Spain but in Africa; Natural Earth files Spain under Europe. Ceuta and Melilla
// are too small for the simplified outlines to hold, so this rule never sees them.
function continentOf(f, lat) {
  if (f.name === 'Spain' && lat < 35.95) return 'Africa';
  return f.continent;
}

// `{ country, continent }`, or null at sea. Simplified coastlines are a few hundred metres out,
// so a point that just misses tries nearby points before giving up.
export function countryAt(lat, lon) {
  if (!features) return null;
  let f = exact(lat, lon);
  for (const r of [0.01, 0.03]) {
    if (f) break;
    for (const [dy, dx] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      f = exact(lat + dy, lon + dx);
      if (f) break;
    }
  }
  return f ? { country: f.name, continent: continentOf(f, lat) } : null;
}
