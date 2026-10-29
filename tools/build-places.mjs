// One-off: builds assets/places-major.json, the towns and cities shown while OpenStreetMap is
// still answering, from Natural Earth's populated places (public domain). Run from the repo root:
//   node tools/build-places.mjs [path to ne_10m_populated_places_simple.geojson]
// With no path it downloads the file.
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson';
const src = process.argv[2];
const geo = JSON.parse(src ? await readFile(src, 'utf8') : await (await fetch(SOURCE)).text());

const rows = [];
for (const f of geo.features) {
  const p = f.properties;
  // Research stations are not places anyone would point at.
  if (!/capital|populated|historic/i.test(p.featurecla)) continue;
  // Some names carry invisible direction marks.
  const name = String(p.name || p.nameascii || '').replace(/\p{Cf}/gu, '').trim();
  const [lon, lat] = f.geometry.coordinates;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const pop = p.pop_max > 0 ? p.pop_max : null;
  const city = /^Admin-0 capital/.test(p.featurecla) || pop >= 100000;
  rows.push([name, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4, pop, city ? 'c' : 't']);
}

const out = JSON.stringify({ fields: ['name', 'lat', 'lon', 'population', 'kind: c city, t town'], rows });
await writeFile(new URL('../assets/places-major.json', import.meta.url), out + '\n');
console.log(`${rows.length} places, ${(out.length / 1024).toFixed(0)} KB`);
