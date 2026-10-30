// Place names from OpenFreeMap's vector tiles (OpenStreetMap data in the OpenMapTiles schema):
// static files, so they answer in a fraction of a second where Overpass takes minutes.
// Only point features and their tags are read; lines and polygons are skipped.
import { distance } from './geo.mjs';

// The tile address changes with each weekly build, so it is read from here.
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const LAYERS = ['place', 'mountain_peak', 'aerodrome_label'];
const PARALLEL = 4;
const TILE_TIMEOUT = 15; // seconds

// ---------- a minimal Mapbox Vector Tile reader ----------
// Protocol buffers: each field starts with a varint key (field number << 3 | wire type).
function reader(buf) {
  let pos = 0;
  const varint = () => {
    // Multiplication, not bit shifts, so ids past 2^31 stay right.
    let v = 0;
    let mul = 1;
    let b;
    do {
      b = buf[pos++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  };
  const skip = (type) => {
    if (type === 0) varint();
    else if (type === 1) pos += 8;
    else if (type === 2) pos += varint();
    else if (type === 5) pos += 4;
    else throw new Error(`bad wire type ${type}`);
  };
  // Calls fn(field, type) for each field up to `end`; fn returns true if it consumed the value.
  const fields = (end, fn) => {
    while (pos < end) {
      const key = varint();
      if (!fn(key >> 3, key & 7)) skip(key & 7);
    }
  };
  const bytes = () => {
    const n = varint();
    const start = pos;
    pos += n;
    return [start, pos];
  };
  const text = new TextDecoder();
  const string = () => {
    const [a, b] = bytes();
    return text.decode(buf.subarray(a, b));
  };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const float = () => ((pos += 4), view.getFloat32(pos - 4, true));
  const double = () => ((pos += 8), view.getFloat64(pos - 8, true));
  return { varint, fields, bytes, string, float, double, get pos() { return pos; }, set pos(p) { pos = p; } };
}

const zigzag = (v) => (v % 2 ? -(v + 1) / 2 : v / 2);

// Layer value message: string, float, double, int64, uint64, sint64 or bool.
function readValue(r, end) {
  let v = null;
  r.fields(end, (f) => {
    if (f === 1) v = r.string();
    else if (f === 2) v = r.float();
    else if (f === 3) v = r.double();
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = zigzag(r.varint());
    else if (f === 7) v = !!r.varint();
    else return false;
    return true;
  });
  return v;
}

// Every point feature in the named layers of one tile: { layer, id, lat, lon, tags }.
// A feature with several points gives its first.
export function decodeTile(buf, z, x, y, layers) {
  const r = reader(buf);
  const out = [];
  const n = 2 ** z;
  r.fields(buf.length, (f, type) => {
    if (f !== 3 || type !== 2) return false;
    const [start, end] = r.bytes();
    const after = r.pos;
    r.pos = start;
    let name = null;
    let extent = 4096;
    const keys = [];
    const values = [];
    const feats = [];
    r.fields(end, (lf) => {
      if (lf === 1) name = r.string();
      else if (lf === 3) keys.push(r.string());
      else if (lf === 4) {
        const [a, b] = r.bytes();
        const back = r.pos;
        r.pos = a;
        values.push(readValue(r, b));
        r.pos = back;
      } else if (lf === 5) extent = r.varint();
      else if (lf === 2) feats.push(r.bytes());
      else return false;
      return true;
    });
    if (layers.includes(name)) {
      for (const [a, b] of feats) {
        r.pos = a;
        let id = 0;
        let kind = 0;
        let tags = null;
        let geom = null;
        r.fields(b, (ff) => {
          if (ff === 1) id = r.varint();
          else if (ff === 2) tags = r.bytes();
          else if (ff === 3) kind = r.varint();
          else if (ff === 4) geom = r.bytes();
          else return false;
          return true;
        });
        if (kind !== 1 || !geom) continue;
        r.pos = geom[0];
        const cmd = r.varint();
        if ((cmd & 7) !== 1 || cmd >> 3 < 1) continue;
        const px = zigzag(r.varint());
        const py = zigzag(r.varint());
        const t = {};
        if (tags) {
          r.pos = tags[0];
          while (r.pos < tags[1]) {
            const k = keys[r.varint()];
            t[k] = values[r.varint()];
          }
        }
        const lon = ((x + px / extent) / n) * 360 - 180;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) * 180) / Math.PI;
        out.push({ layer: name, id, lat, lon, tags: t });
      }
    }
    r.pos = after;
    return true;
  });
  return out;
}

// ---------- which tiles, and what in them counts as a place ----------
const latinOnly = (s) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}'’\-]+$/u.test(s);

// English where the map has it, else a name in Latin script: Tangier's local name mixes three
// scripts. Tiles fill name_en with the local name when there is no English one.
export function nameOf(t) {
  for (const n of [t['name:en'], t.name_en, t['name:latin'], t.name])
    if (typeof n === 'string' && n.trim() && (n === t['name:en'] || latinOnly(n))) return n.trim().slice(0, 80);
  return typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 80) : null;
}

function kindOf(layer, t) {
  if (layer === 'place') return ['city', 'town', 'village', 'hamlet', 'island'].includes(t.class) ? t.class : null;
  if (layer === 'mountain_peak') return t.class === 'peak' || t.class === 'volcano' ? 'peak' : null;
  if (layer === 'aerodrome_label') return t.iata ? 'airport' : null; // big enough to have a code
  return null;
}

// Decoded tile features as places, before any choice by distance (so they can be kept per tile).
export function placesOf(features) {
  const out = [];
  for (const { layer, id, lat, lon, tags } of features) {
    const kind = kindOf(layer, tags);
    const name = kind && nameOf(tags);
    if (!name) continue;
    const ele = Number(tags.ele);
    // Other spellings, so a bundled twin ("Málaga" for "Málaga City") is recognised.
    const names = [...new Set([tags.name, tags.name_en, tags['name:latin'], tags.name_int])]
      .filter((n) => typeof n === 'string' && n !== name && latinOnly(n))
      .map((n) => n.slice(0, 80));
    out.push({ id: `t${id}`, name, kind, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
      ele: Number.isFinite(ele) && ele > 0 ? ele : null, height: null, population: null, wikipedia: null, names });
  }
  return out;
}

// Hamlets only within 30 km, and far peaks only when they have a height. Villages count at any
// distance: zoomed in across the sea, the villages of the far shore are what there is to name.
const REACH = { hamlet: 30 };
function near(p, lat, lon, rangeKm) {
  const km = distance(lat, lon, p.lat, p.lon) / 1000;
  if (p.kind === 'peak' && p.ele == null) return km <= 40;
  return km <= Math.min(rangeKm, REACH[p.kind] ?? rangeKm);
}

const tileLat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

// The tiles at zoom z that reach within km of the viewer, nearest first.
function tilesAround(lat, lon, km, z) {
  const n = 2 ** z;
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  const tx = (lo) => Math.floor(((lo + 180) / 360) * n);
  const ty = (la) => Math.floor(((1 - Math.asinh(Math.tan((Math.min(85, Math.max(-85, la)) * Math.PI) / 180)) / Math.PI) / 2) * n);
  const out = [];
  for (let x = tx(lon - dLon); x <= tx(lon + dLon); x++)
    for (let y = Math.max(0, ty(lat + dLat)); y <= Math.min(n - 1, ty(lat - dLat)); y++) {
      const west = (x / n) * 360 - 180;
      const east = ((x + 1) / n) * 360 - 180;
      const nLat = Math.min(tileLat(y, n), Math.max(tileLat(y + 1, n), lat));
      const nLon = Math.min(east, Math.max(west, lon));
      const d = distance(lat, lon, nLat, nLon) / 1000;
      if (d <= km) out.push({ z, x: ((x % n) + n) % n, y, d });
    }
  return out.sort((a, b) => a.d - b.d);
}

// Cities, towns and the best known peaks over the whole range first (zoom 8), then villages
// (zoom 9, 60 km) and hamlets (zoom 11, 12 km), nearest first.
export function tilePlan(lat, lon, rangeKm) {
  const detail = [...tilesAround(lat, lon, Math.min(rangeKm, 60), 9), ...tilesAround(lat, lon, Math.min(rangeKm, 12), 11)];
  return [...tilesAround(lat, lon, rangeKm, 8), ...detail.sort((a, b) => a.d - b.d)];
}

// Zoomed in, finer tiles name smaller places, so the tiles at FINER_Z[step] inside the wedge
// heading ± halfDeg out to rangeKm are asked for, nearest first; d is the distance in km at
// which the wedge first enters each. None at 1×. They stop at zoom 11, 8× sharing 4×'s tiles:
// hamlets are in the tiles from zoom 11, zoom 12 added few names for four times the tiles, and
// zoom 14, the heaviest, is fetched only for the chips (pois.mjs).
const FINER_Z = { 2: 10, 4: 11, 8: 11 };
const tileXY = (lat, lon, n) => ({
  x: Math.floor(((lon + 180) / 360) * n),
  y: Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n),
});
export function finerPlan(lat, lon, heading, halfDeg, step, rangeKm) {
  const z = FINER_Z[step];
  if (!z) return [];
  const n = 2 ** z;
  const tileKm = (40075 * Math.cos((lat * Math.PI) / 180)) / n;
  const stepKm = tileKm / 4;
  const cos = Math.cos((lat * Math.PI) / 180);
  const seen = new Map();
  for (let d = stepKm; d <= rangeKm; d += stepKm) {
    // Bearing steps no wider than a quarter tile at this distance, so no tile is stepped over.
    const da = Math.min(halfDeg, ((stepKm / d) * 180) / Math.PI);
    for (let a = -halfDeg; a <= halfDeg + 1e-9; a += da) {
      const b = ((heading + a) * Math.PI) / 180;
      const t = tileXY(lat + (d * Math.cos(b)) / 111.32, lon + (d * Math.sin(b)) / (111.32 * cos), n);
      const key = `${z}/${t.x}/${t.y}`;
      if (!seen.has(key)) seen.set(key, { z, x: t.x, y: t.y, d });
    }
  }
  return [...seen.values()].sort((p, q) => p.d - q.d);
}

// ---------- fetching ----------
async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT * 1000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

let template = null;
function tileUrl({ z, x, y }) {
  if (!template) {
    template = get(TILEJSON)
      .then((r) => r.json())
      .then((j) => {
        const t = j?.tiles?.[0];
        if (typeof t !== 'string' || !t.startsWith('https://tiles.openfreemap.org/')) throw new Error('OpenFreeMap: no tile address');
        return t;
      });
    template.catch(() => (template = null)); // ask again next time
  }
  return template.then((t) => t.replace('{z}', z).replace('{x}', x).replace('{y}', y));
}

// Each tile's places are saved on the phone for 30 days, so a second look from nearby needs no
// network. Kept by the app, not the service worker, which never stores place names. Bump the
// name here and in sw.js's KEEP if what placesOf (or pois.mjs's poisOf) returns changes, so old
// entries are deleted.
const SAVED = 'binoculars-places-v1';
const SAVED_MAX_AGE = 30 * 24 * 3600 * 1000;

async function readSaved(key) {
  try {
    const hit = await (await caches.open(SAVED)).match(key);
    const body = hit && (await hit.json());
    return body && Date.now() - body.t < SAVED_MAX_AGE && Array.isArray(body.places) ? body.places : null;
  } catch {
    return null; // no Cache API (private mode, old browser) or a bad entry: fetch it
  }
}

async function save(key, places) {
  try {
    const body = JSON.stringify({ t: Date.now(), places });
    await (await caches.open(SAVED)).put(key, new Response(body, { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    // Storage full or blocked: fine, it is fetched again next time.
  }
}

// OpenFreeMap asks for at most four requests at once; place names and points of interest share them.
let active = 0;
const waiting = [];
async function limited(fn) {
  while (active >= PARALLEL) await new Promise((go) => waiting.push(go));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// One tile's features from the named layers, turned into a list by convert and saved under
// `${what}/z/x/y`.
export async function loadTile(t, what, layers, convert) {
  const key = `${what}/${t.z}/${t.x}/${t.y}`;
  const saved = await readSaved(key);
  if (saved) return saved;
  const buf = await limited(async () => new Uint8Array(await (await get(await tileUrl(t))).arrayBuffer()));
  const out = convert(decodeTile(buf, t.z, t.x, t.y, layers));
  save(key, out);
  return out;
}

const fetchTile = (t) => loadTile(t, 'places', LAYERS, placesOf);

// One finer tile's places (see finerPlan), kept to the same reach as the rest.
export const loadFinerTile = async (t, lat, lon, rangeKm) => (await fetchTile(t)).filter((p) => near(p, lat, lon, rangeKm));

// Resolves with every place found; calls onPart(placesSoFar, tilesDone, tilesTotal, tilesFailed)
// as each tile lands. Throws only if no tile loaded.
export async function loadTilePlaces(lat, lon, rangeKm, { onPart = () => {} } = {}) {
  const queue = tilePlan(lat, lon, rangeKm);
  const total = queue.length;
  const byId = new Map();
  let done = 0;
  let failed = 0;
  let lastErr;
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      try {
        for (const p of await fetchTile(t)) if (near(p, lat, lon, rangeKm)) byId.set(p.id, p);
      } catch (err) {
        lastErr = err;
        failed++;
      }
      done++;
      onPart([...byId.values()], done, total, failed);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (failed === total) throw lastErr;
  return [...byId.values()];
}
