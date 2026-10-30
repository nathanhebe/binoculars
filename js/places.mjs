// Named places around the viewer from OpenStreetMap, via the Overpass API, plus towns, cities
// and mountains bundled with the app to show while those servers answer.
import { distance } from './geo.mjs';

export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const PART_TIMEOUT = 25; // seconds each server gets for one part
const CACHE_KEY = 'binoculars:places:v1';
const CACHE_MAX_AGE = 30 * 24 * 3600 * 1000;

// What a place counts as, how much it matters when labels compete for room, and how tall it
// stands above the ground (buildings, towers) for the line-of-sight check.
export const KINDS = {
  city: { rank: 100, rise: 30, label: 'City' },
  town: { rank: 75, rise: 20, label: 'Town' },
  island: { rank: 65, rise: 10, label: 'Island' },
  lighthouse: { rank: 55, rise: 20, label: 'Lighthouse' },
  airport: { rank: 50, rise: 5, label: 'Airport' },
  cape: { rank: 50, rise: 5, label: 'Cape' },
  castle: { rank: 45, rise: 15, label: 'Castle / fort' },
  peak: { rank: 40, rise: 0, label: 'Peak' },
  village: { rank: 40, rise: 12, label: 'Village' },
  viewpoint: { rank: 25, rise: 2, label: 'Viewpoint' },
  marina: { rank: 20, rise: 3, label: 'Marina' },
  hamlet: { rank: 15, rise: 8, label: 'Hamlet' },
  // Points of interest from the map tiles (pois.mjs), shown by category.
  food: { rank: 45, rise: 5, label: 'Food' },
  shops: { rank: 40, rise: 5, label: 'Shop' },
  travel: { rank: 50, rise: 5, label: 'Travel' },
  sights: { rank: 50, rise: 8, label: 'Sight' },
  stay: { rank: 40, rise: 10, label: 'Stay' },
};

// How much detail each zoom shows: the least score a place needs to be labelled (KINDS' rank,
// plus height for a peak and population for a town, less distance for a village or hamlet; see
// app.mjs), at most how many labels, and how many may stack above one another. At 1× cities,
// towns, landmarks and peaks of 250 m or more; from 2× every peak and villages within 20 km;
// from 4× villages at any distance and viewpoints; at 8× everything, hamlets too. A pinch a
// little short of a step counts as the step.
const DETAIL = [
  { zoom: 8, minScore: 0, cap: 16, rows: 5 },
  { zoom: 4, minScore: 22, cap: 16, rows: 5 },
  { zoom: 2, minScore: 35, cap: 14, rows: 4 },
  { zoom: 1, minScore: 45, cap: 12, rows: 3 },
];
export const detailFor = (zoom) => DETAIL.find((d) => zoom >= d.zoom - 0.05) ?? DETAIL[DETAIL.length - 1];

function bbox(lat, lon, km) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return `${(lat - dLat).toFixed(4)},${(lon - dLon).toFixed(4)},${(lat + dLat).toFixed(4)},${(lon + dLon).toFixed(4)}`;
}

// Only what the map tiles (tiles.mjs) lack: towns, villages, peaks, islands and airports come
// from there. The public servers are slow when busy and time out on one big query, so ask in
// two small parts.
function queries(lat, lon, rangeKm) {
  const far = bbox(lat, lon, rangeKm);
  const near = bbox(lat, lon, Math.min(rangeKm, 40));
  const close = bbox(lat, lon, Math.min(rangeKm, 12));
  return [
    `nwr["man_made"="lighthouse"](${far});
  node["natural"="cape"]["name"](${far});`,
    `nwr["historic"~"^(castle|fort|tower)$"]["name"](${near});
  nwr["leisure"="marina"]["name"](${near});
  nwr["tourism"="viewpoint"]["name"](${close});`,
  ].map((q) => `[out:json][timeout:${PART_TIMEOUT}];\n(\n  ${q}\n);\nout center tags;`);
}

function kindOf(t) {
  if (t.place === 'city' || t.place === 'town' || t.place === 'village' || t.place === 'hamlet') return t.place;
  if (t.place === 'island' || t.place === 'islet') return 'island';
  if (t.natural === 'peak' || t.natural === 'volcano') return 'peak';
  if (t.natural === 'cape') return 'cape';
  if (t.man_made === 'lighthouse') return 'lighthouse';
  if (t.aeroway === 'aerodrome') return 'airport';
  if (t.historic) return 'castle';
  if (t.leisure === 'marina') return 'marina';
  if (t.tourism === 'viewpoint') return 'viewpoint';
  return null;
}

const latinOnly = (s) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}'’\-]+$/u.test(s);

// English name where OSM has one, else the local name if it's in Latin script (most of
// Europe), else a French or international name (e.g. Moroccan names in Arabic script).
function displayName(t) {
  if (t['name:en']) return t['name:en'];
  if (t.name && latinOnly(t.name)) return t.name;
  return t['name:fr'] || t.int_name || t.name || t['name:es'] || null;
}

export function parse(json) {
  const out = [];
  for (const e of json.elements || []) {
    const t = e.tags || {};
    const kind = kindOf(t);
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    let name = displayName(t);
    if (!name && kind === 'lighthouse') name = 'Lighthouse';
    if (!kind || !name || typeof lat !== 'number' || typeof lon !== 'number') continue;
    const ele = parseFloat(t.ele);
    out.push({
      id: `${e.type[0]}${e.id}`,
      name: String(name).slice(0, 80),
      kind,
      lat,
      lon,
      ele: Number.isFinite(ele) ? ele : null,
      height: parseFloat(t.height) || null,
      population: parseInt(t.population, 10) || null,
      wikipedia: typeof t.wikipedia === 'string' ? t.wikipedia : null,
    });
  }
  return out;
}

// Places bundled with the app, shown with no network at all: towns and cities from
// assets/places-major.json (tools/build-places.mjs) and well-known mountains from
// assets/peaks-major.json (tools/build-peaks.mjs), within range.
// Never throws: without a file the app just waits for the network as before.
const bundles = new Map();
function bundle(file) {
  if (!bundles.has(file)) {
    const rows = fetch(new URL(`../assets/${file}`, import.meta.url)).then((r) => {
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return r.json();
    });
    bundles.set(file, rows);
    rows.catch(() => bundles.delete(file)); // try again next time
  }
  return bundles.get(file);
}

export async function loadMajorPlaces(lat, lon, rangeKm) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const near = (pLat, pLon) => Math.hypot((pLat - lat) * 111.32, (pLon - lon) * 111.32 * cosLat) <= rangeKm;
  const out = [];
  const [towns, peaks] = await Promise.allSettled([bundle('places-major.json'), bundle('peaks-major.json')]);
  if (towns.status === 'fulfilled')
    towns.value.rows.forEach(([name, pLat, pLon, population, k], i) => {
      if (near(pLat, pLon))
        out.push({ id: `ne${i}`, name, kind: k === 'c' ? 'city' : 'town', lat: pLat, lon: pLon, ele: null, height: null, population, wikipedia: null });
    });
  else console.warn(towns.reason);
  if (peaks.status === 'fulfilled')
    peaks.value.rows.forEach(([name, pLat, pLon, ele], i) => {
      if (near(pLat, pLon))
        out.push({ id: `nep${i}`, name, kind: 'peak', lat: pLat, lon: pLon, ele, height: null, population: null, wikipedia: null });
    });
  else console.warn(peaks.reason);
  return out;
}

// OpenStreetMap ids start n, w or r and a digit, so this marks the bundled entries.
export const isMajor = (p) => p.id.startsWith('ne');

// Same name ignoring accents and case: Natural Earth writes "Tétouan", OpenStreetMap "Tetouan".
export const nameKey = (s) => s.normalize('NFD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase();

// The places plus each bundled one that OpenStreetMap has not also given (same name within
// 3 km; a place's other spellings in `names` count). A town from the map tiles has no
// population, so it takes its bundled twin's, which ranks it as before.
export function withMajor(items, major) {
  const byName = new Map();
  for (const p of items)
    for (const k of new Set([p.name, ...(p.names ?? [])].map(nameKey))) byName.set(k, [...(byName.get(k) ?? []), p]);
  const extra = [];
  const population = new Map();
  // Wikidata and OpenStreetMap often spell a mountain differently ("Jebel Moussa", "Jebel Musa"),
  // so a bundled peak also gives way to any mapped peak within 1.5 km.
  const peaks = items.filter((p) => p.kind === 'peak');
  for (const m of major) {
    const twin =
      (byName.get(nameKey(m.name)) ?? []).find((p) => distance(m.lat, m.lon, p.lat, p.lon) < 3000) ??
      (m.kind === 'peak' ? peaks.find((p) => distance(m.lat, m.lon, p.lat, p.lon) < 1500) : undefined);
    if (!twin) extra.push(m);
    else if (m.population && !twin.population) population.set(twin, m.population);
  }
  return [...items.map((p) => (population.has(p) ? { ...p, population: population.get(p) } : p)), ...extra];
}

// "Jbel Musa", "Jebel Musa" and "Musa" are one mountain: drop a leading word for mountain.
// "San Pedro de Alcántara" and "San Pedro Alcántara" are one town: drop joining words and
// hyphens, unless nothing else is left ("La", "El").
const JOINING = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);
const twinKey = (s) => {
  const words = nameKey(s).replace(/^\s*(jbel|jebel|djebel|pico|monte|mount|mt\.?)\s+(?=\S)/, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = words.filter((w) => !JOINING.has(w));
  return (kept.length ? kept : words).join(' ');
};

// OpenStreetMap sometimes maps one summit or town twice, spelt a little differently; keep the
// first (best) of each name within 3 km. `places` must be sorted best first.
export function dedupe(places) {
  const seen = new Map();
  return places.filter((p) => {
    const k = twinKey(p.name);
    const twins = seen.get(k) ?? [];
    if (twins.some((q) => distance(p.lat, p.lon, q.lat, q.lon) < 3000)) return false;
    seen.set(k, [...twins, p]);
    return true;
  });
}

function readCache(lat, lon) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!c || Date.now() - c.t > CACHE_MAX_AGE) return null;
    const km = Math.hypot((c.lat - lat) * 111, (c.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180));
    // Hamlets and viewpoints are only asked for within 12 km, so a bigger move needs a refetch.
    return km < 2 && c.range >= 150 ? c.items : null;
  } catch {
    return null;
  }
}

function writeCache(lat, lon, range, items) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), lat, lon, range, items }));
  } catch {
    // Storage full or blocked (private mode): fine, we fetch again next time.
  }
}

async function fetchPart(q) {
  const body = 'data=' + encodeURIComponent(q);
  let lastErr;
  for (const url of ENDPOINTS) {
    const ctrl = new AbortController();
    // A server that has not answered in 25 s rarely does, so try the next one.
    const timer = setTimeout(() => ctrl.abort(), PART_TIMEOUT * 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return parse(await res.json());
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Resolves with every place found; calls onPart(placesSoFar, partsDone, partsTotal, partsFailed) as each
// part lands. Throws only if no part loaded. Two parts at a time: servers allow two per user.
export async function loadPlaces(lat, lon, rangeKm, { fresh = false, onPart = () => {} } = {}) {
  if (!fresh) {
    const cached = readCache(lat, lon);
    if (cached) {
      onPart(cached, 1, 1);
      return cached;
    }
  }
  const parts = queries(lat, lon, rangeKm);
  const total = parts.length;
  // Busy servers refuse at random, so a part that fails everywhere goes to the back of the
  // queue for one more try.
  const queue = parts.map((q) => ({ q, tries: 0 }));
  const byId = new Map();
  let done = 0;
  let failed = 0;
  let lastErr;
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      try {
        for (const p of await fetchPart(job.q)) byId.set(p.id, p);
      } catch (err) {
        lastErr = err;
        if (++job.tries < 2) {
          await new Promise((r) => setTimeout(r, 5000));
          queue.push(job);
          continue;
        }
        failed++;
      }
      done++;
      onPart([...byId.values()], done, total, failed);
    }
  }
  await Promise.all([worker(), worker()]);
  if (failed === total) throw lastErr;
  const items = [...byId.values()];
  if (!failed) writeCache(lat, lon, rangeKm, items);
  return items;
}
