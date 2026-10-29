// Points of interest (restaurants, shops, stations, sights) from the same OpenFreeMap tiles as
// the place names. They exist only at the tiles' most detailed zoom (14, about 2 km a tile),
// so only the tiles in the direction looked at are fetched, nearest first.
import { loadTile, nameOf } from './tiles.mjs';
import { ENDPOINTS } from './places.mjs';

const Z = 14;

// How far points of interest are shown, in km: a few km by eye, further through the zoom.
export const poiRange = (zoom) => Math.min(8, 4 * zoom);

// What each map class or subclass counts as. Things nobody scans a view for (nightclubs,
// kiosks, bus stops) are left out.
const FOOD = new Set(['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'biergarten', 'ice_cream', 'food_court']);
const SHOP_CLASSES = new Set(['shop', 'grocery', 'clothing_store', 'alcohol_shop']);
const SHOP_SUBCLASSES = new Set(['bakery', 'butcher']);
const TRAVEL = new Set(['ferry_terminal', 'bus_station', 'marina']);
const SIGHT_CLASSES = new Set(['attraction', 'castle', 'art_gallery']);
const SIGHTS = new Set(['attraction', 'museum', 'viewpoint', 'gallery', 'castle', 'monument', 'ruins', 'fort', 'lighthouse']);

const TYPES = {
  clothes: 'Clothes shop', fast_food: 'Fast food', ice_cream: 'Ice cream', ferry_terminal: 'Ferry port',
  bus_station: 'Bus station', station: 'Railway station', halt: 'Railway halt', convenience: 'Corner shop',
  biergarten: 'Beer garden', supermarket: 'Supermarket', alcohol: 'Off-licence', art_gallery: 'Gallery',
};

function categoryOf(cls, sub) {
  if (FOOD.has(sub)) return 'food';
  if (sub !== 'kiosk' && (SHOP_CLASSES.has(cls) || SHOP_SUBCLASSES.has(sub))) return 'shops';
  if (TRAVEL.has(sub) || (cls === 'railway' && (sub === 'station' || sub === 'halt'))) return 'travel';
  if (SIGHTS.has(sub) || SIGHT_CLASSES.has(cls)) return 'sights';
  return null;
}

function typeOf(cls, sub) {
  const s = typeof sub === 'string' && sub ? sub : String(cls ?? '');
  if (TYPES[s]) return TYPES[s];
  const words = s.replace(/_/g, ' ').trim().slice(0, 40);
  return words ? words[0].toUpperCase() + words.slice(1) : 'Place';
}

// Map tile ids are OpenStreetMap ids times ten plus 1 (node), 2 (way) or 3 (relation).
const OSM_TYPES = { 1: 'node', 2: 'way', 3: 'relation' };

// Decoded poi-layer features as labelled places, one per feature that has a name and a category.
export function poisOf(features) {
  const out = [];
  for (const { layer, id, lat, lon, tags } of features) {
    if (layer !== 'poi') continue;
    const kind = categoryOf(tags.class, tags.subclass);
    const name = kind && nameOf(tags);
    if (!name) continue;
    const osmType = OSM_TYPES[id % 10];
    out.push({
      id: `p${id}`, name, kind, type: typeOf(tags.class, tags.subclass),
      osm: osmType ? { type: osmType, id: Math.floor(id / 10) } : null,
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
      ele: null, height: null, population: null, wikipedia: null,
    });
  }
  return out;
}

const tileOf = (lat, lon) => {
  const n = 2 ** Z;
  const r = (lat * Math.PI) / 180;
  return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n) };
};

// The zoom-14 tiles inside the wedge heading ± halfDeg out to poiRange(zoom), plus the one
// underfoot, nearest first; d is the distance in km at which the wedge first enters each.
export function poiPlan(lat, lon, heading, halfDeg, zoom) {
  const km = poiRange(zoom);
  const here = tileOf(lat, lon);
  const seen = new Map([[`${here.x}/${here.y}`, { z: Z, x: here.x, y: here.y, d: 0 }]]);
  const cos = Math.cos((lat * Math.PI) / 180);
  for (let d = 0.25; d <= km; d += 0.25) {
    // Bearing steps no wider than about 250 m at this distance, so no tile is stepped over.
    const step = Math.min(halfDeg, ((0.25 / d) * 180) / Math.PI);
    for (let a = -halfDeg; a <= halfDeg + 1e-9; a += step) {
      const b = ((heading + a) * Math.PI) / 180;
      const t = tileOf(lat + (d * Math.cos(b)) / 111.32, lon + (d * Math.sin(b)) / (111.32 * cos));
      const key = `${t.x}/${t.y}`;
      if (!seen.has(key)) seen.set(key, { z: Z, x: t.x, y: t.y, d });
    }
  }
  return [...seen.values()].sort((p, q) => p.d - q.d);
}

export const loadPoiTile = (t) => loadTile(t, 'pois', ['poi'], poisOf);

// A website tag as an http(s) address safe to link to, or null. OpenStreetMap text is anyone's:
// it may be javascript:, mailto: or junk. A bare domain gets https; of several, the first.
export function safeWebsite(s) {
  if (typeof s !== 'string') return null;
  let v = s.split(';')[0].trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.')) return null;
  return u.href;
}

// Opening hours and website are not in the map tiles, so they are asked of OpenStreetMap (one
// small Overpass query) when a place's sheet opens. Kept for the session; a failure is forgotten
// so the next tap tries again.
const details = new Map();
export function loadDetails(osm) {
  const key = `${osm.type}/${osm.id}`;
  if (!details.has(key)) details.set(key, fetchDetails(osm).catch(() => (details.delete(key), null)));
  return details.get(key);
}

async function fetchDetails({ type, id }) {
  const body = 'data=' + encodeURIComponent(`[out:json][timeout:10];${type}(${id});out tags;`);
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const el = (await res.json()).elements?.find((e) => e.type === type && e.id === id);
      const tags = el?.tags ?? {};
      const hours = typeof tags.opening_hours === 'string' ? tags.opening_hours.slice(0, 200) : null;
      return { hours, website: safeWebsite(tags.website ?? tags['contact:website']) };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
