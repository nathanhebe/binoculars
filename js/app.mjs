import { angleDiff, apparentAngle, compass, distance, horizonAlong, lineOfSight } from './geo.mjs';
import { Terrain } from './terrain.mjs';
import { KINDS, dedupe, detailFor, isMajor, loadMajorPlaces, loadPlaces, nameKey, withMajor } from './places.mjs';
import { finerPlan, loadFinerTile, loadTilePlaces, tilePlan } from './tiles.mjs';
import { loadDetails, loadPoiTile, poiPlan, poiRange } from './pois.mjs';
import { countryAt, loadCountries } from './countries.mjs';
import { axesFrom, cameraAxes, direction, headingOf, pitchOf, turn } from './orientation.mjs';

const RANGE_KM = 150;
const HORIZON_STEP = 0.25; // degrees between skyline rays
const DEMO = { lat: 36.5068, lon: -4.886, heading: 215, pitch: 0.3 }; // Marbella seafront, facing the Strait

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------- settings (per viewer, survives reloads) ----------
const SETTINGS_KEY = 'binoculars:settings:v1';
// The point-of-interest categories, each a chip above the controls; all off at first.
const CATS = ['food', 'shops', 'travel', 'sights'];
const settings = { hag: 2, fov: 64, showHidden: false, showSkyline: true, calibHeading: 0, calibPitch: 0 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {});
} catch {}
settings.cats = Object.fromEntries(CATS.map((c) => [c, settings.cats?.[c] === true]));
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

// ---------- world state ----------
const terrain = new Terrain();
// pois: points of interest measured from here (computePois), like places.
const world = { lat: null, lon: null, eye: 0, places: [], pois: [], horizon: [], skylineCountry: new Map(), home: null, gen: 0, placesDone: false };
const view = {
  sensor: false, // true once real orientation events arrive
  axes: axesFrom(0, 0),
  offset: 0, // degrees added to the sensor heading to make it true-north
  offsetKnown: false,
  heading: 0, // manual mode
  pitch: 0,
  zoom: 1, // what is drawn; it eases toward zoomTarget
  zoomTarget: 1,
  aligning: false,
  compassAccuracy: null,
};

// ---------- start-up ----------
function show(id, on = true) {
  $(id).hidden = !on;
  // While a sheet is open the controls and the card step out of the way (see style.css).
  document.body.classList.toggle('sheet-open', !$('info').hidden || !$('settings').hidden);
}
function toast(msg, ms = 5000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  if (ms) toast.timer = setTimeout(() => (t.hidden = true), ms);
}
// The slim line above the controls: parts loaded so far, 'failed' for Retry, or null to hide.
function placeStatus(state) {
  const s = $('status');
  s.hidden = !state;
  if (!state) return;
  const failed = state === 'failed';
  s.classList.toggle('failed', failed);
  $('status-retry').hidden = !failed;
  if (failed) {
    $('status-text').textContent = "Couldn't load all place names ·";
    return;
  }
  const { done, total } = state;
  $('status-text').textContent = done ? `Finding more names… ${done}/${total}` : 'Finding more names…';
  $('status-bar').firstElementChild.style.width = `${total ? (100 * done) / total : 0}%`;
}
function loading(text) {
  $('loading-text').textContent = text;
}

async function start(fixed) {
  // iOS only grants motion sensors from inside the tap, so ask before anything awaits.
  const motion = requestMotion();
  const camera = params.has('nocam') ? Promise.resolve() : startCamera();
  show('start', false);
  show('start-error', false);
  show('loading');
  loading('Finding you…');
  if (fixed) {
    view.heading = fixed.heading ?? 0;
    view.pitch = fixed.pitch ?? 0;
  }
  await motion;
  listenOrientation();
  // Ask for location only after the camera prompt is answered; a demo or a fixed place needs
  // no location, so it carries on while the camera prompt is still open.
  if (!fixed) await camera;
  let pos = fixed;
  if (!pos) {
    try {
      pos = await locate();
    } catch (err) {
      loading('');
      show('loading', false);
      show('start');
      // The browser's own wording ("User denied Geolocation") goes to the console only.
      console.warn('location failed:', err.message);
      show('start-error');
      return;
    }
  }
  await loadWorld(pos.lat, pos.lon);
  show('loading', false);
  ['banner', 'reticle', 'hud', 'chips'].forEach((id) => show(id));
  setZoom(1);
  if (!fixed) watchMoves();
  requestAnimationFrame(frame);
}

async function requestMotion() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try {
      const r = await DOE.requestPermission();
      if (r !== 'granted') toast('Motion access was refused — drag the view to look around instead.');
    } catch {
      toast('Motion access unavailable — drag the view to look around instead.');
    }
  }
}

// Why the camera is off, in words a user can act on; anything else shows the browser's own name.
const CAMERA_REASONS = {
  NotAllowedError: 'access refused (Settings › Safari › Camera)',
  NotFoundError: 'no camera found',
  NotReadableError: 'in use by another app',
  NoMediaDevices: 'this browser gives no camera here',
};

async function startCamera() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'NoMediaDevices' });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    const v = $('video');
    v.srcObject = stream;
    await v.play().catch(() => {});
    show('cam-off', false);
  } catch (err) {
    console.warn('camera failed:', err.name, err.message);
    $('cam-off-text').textContent = `Camera off · ${CAMERA_REASONS[err.name] ?? err.name} ·`;
    show('cam-off');
  }
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('not supported'));
    let best = null;
    const done = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      best ? resolve(best) : reject(new Error('timed out'));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.accuracy)
          best = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
        if (best.accuracy <= 50) done();
      },
      (err) => {
        if (!best) {
          navigator.geolocation.clearWatch(id);
          clearTimeout(timer);
          reject(new Error(err.message || 'denied'));
        }
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
    );
    const timer = setTimeout(done, 12000);
  });
}

function watchMoves() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    async (p) => {
      const { latitude: lat, longitude: lon } = p.coords;
      const km = Math.hypot((lat - world.lat) * 111, (lon - world.lon) * 111 * Math.cos((lat * Math.PI) / 180));
      if (km > 2 && !world.busy) {
        toast('You have moved — updating the view…');
        await loadWorld(lat, lon);
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 60000 }
  );
}

// ---------- the expensive part: terrain, places, and what is visible ----------
const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

async function loadWorld(lat, lon, { fresh = false } = {}) {
  world.busy = true;
  try {
    // Retry and Reload load the same spot again: what is on screen stays right until the new
    // list replaces it. After a move it is measured from the wrong place, so it goes.
    const moved = lat !== world.lat || lon !== world.lon;
    world.lat = lat;
    world.lon = lon;
    loading('Loading terrain…');
    const gen = ++world.gen;
    // Bundled towns and cities, so there are names in seconds whatever the server does.
    const majorReady = loadMajorPlaces(lat, lon, RANGE_KM);
    // After a move, show the places already loaded from the new position until fresh ones arrive.
    // The bundled ones are for the old position; this load brings its own.
    const prev = (world.items ?? []).filter((x) => !isMajor(x));
    if (moved) {
      world.places = [];
      world.pois = [];
      finer.raw.clear();
      finer.tiles = new Set(tilePlan(lat, lon, RANGE_KM).map((t) => `${t.z}/${t.x}/${t.y}`));
    }
    world.items = prev;
    world.placesDone = false;
    // Place names come from a slow public server, so they stream in after the view is up.
    let ready;
    const terrainReady = new Promise((r) => (ready = r));
    // Each step runs after the last, and only while this is still the latest load.
    let chain = terrainReady;
    const then = (fn) => (chain = chain.then(() => gen === world.gen && fn()));
    let major = [];
    // Names come from map tiles (fast, and the progress shown); lighthouses, capes, castles,
    // marinas and viewpoints, which the tiles lack, from Overpass without holding anything up.
    let named = null;
    let extras = null;
    const refresh = () =>
      then(async () => {
        // Keep the earlier places alongside the new ones until both sources have loaded.
        const items = [...(named?.items ?? []), ...(extras?.items ?? [])];
        const ids = new Set(items.map((x) => x.id));
        const complete = named?.settled && !named.failed && extras?.settled && !extras.failed;
        const shown = withMajor(complete ? items : [...items, ...prev.filter((x) => !ids.has(x.id))], major);
        world.items = shown;
        await computePlaces(shown, gen);
      });
    then(() => placeStatus({ done: 0, total: 0 }));
    then(async () => (major = await majorReady));
    refresh();
    const tilesDone = loadTilePlaces(lat, lon, RANGE_KM, {
      onPart: (items, done, total, failed) => {
        // A load for an earlier position can still be answering after a move.
        if (gen !== world.gen) return;
        named = { items, failed };
        refresh();
        if (done < total) then(() => placeStatus({ done, total }));
      },
    }).then(
      (items) => (named = { items, failed: named?.failed ?? 0, settled: true }),
      (err) => {
        console.warn(err);
        named = { items: [], failed: true, settled: true };
      }
    );
    // The line tracks the map tiles only: once they are in it goes, whatever Overpass is doing.
    tilesDone.then(() => gen === world.gen && then(() => placeStatus(named.failed ? 'failed' : null)));
    const extrasDone = loadPlaces(lat, lon, RANGE_KM, {
      fresh,
      onPart: (items, done, total, failed) => {
        if (gen !== world.gen) return;
        extras = { items, failed };
        refresh();
      },
    }).then(
      (items) => (extras = { items, failed: extras?.failed ?? 0, settled: true }),
      (err) => {
        console.warn(err); // Overpass is often busy; the tiles have the names that matter
        extras = { items: [], failed: true, settled: true };
      }
    );
    Promise.all([tilesDone, extrasDone]).then(() => {
      if (gen !== world.gen) return;
      refresh();
      then(() => {
        world.placesDone = true;
        placeStatus(named.failed ? 'failed' : null);
      });
    });
    const [, tiles] = await Promise.all([
      loadCountries(),
      terrain.load(lat, lon, (n, total) => loading(`Loading terrain ${n} / ${total}…`)),
    ]);
    if (tiles.failed > tiles.total / 2) toast('Most terrain failed to load — hills will not hide anything.', 8000);

    world.eye = terrain.elev(lat, lon) + settings.hag;
    world.home = countryAt(lat, lon);
    await computeHorizon();
    world.measuredGen = gen;
    computePois();
    ready();
  } finally {
    world.busy = false;
  }
}

async function computeHorizon() {
  loading('Tracing the skyline…');
  const n = Math.round(360 / HORIZON_STEP);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = horizonAlong(terrain.elev, world.lat, world.lon, world.eye, i * HORIZON_STEP, RANGE_KM * 1000);
    if (i % 90 === 89) await yieldToUI();
  }
  world.horizon = out;
  world.skylineCountry.clear();
}

// Distance, direction, angle, whether hills or the curve hide it, and how much it matters
// (score, which decides who gets a label at each zoom: detailFor); null when out of range.
function measurePlace(p) {
  const ground = terrain.elev(p.lat, p.lon);
  const k = KINDS[p.kind];
  const top =
    p.kind === 'peak' ? Math.max(p.ele ?? 0, ground) : Math.max(ground, p.ele ?? 0) + (p.height ?? k.rise);
  const los = lineOfSight(terrain.elev, world.lat, world.lon, world.eye, p.lat, p.lon, top, { peak: p.kind === 'peak' });
  if (los.d > RANGE_KM * 1000) return null;
  const c = countryAt(p.lat, p.lon);
  let score = k.rank;
  if (p.kind === 'peak') score += Math.min(40, top / 50);
  if (p.population) score += Math.min(25, Math.log10(p.population) * 4);
  if (p.kind === 'village' || p.kind === 'hamlet') score -= Math.min(15, los.d / 4000);
  return { ...p, ...los, top, country: c?.country ?? null, continent: c?.continent ?? null, score };
}

const byScore = (a, b) => b.score - a.score;

async function computePlaces(places, gen) {
  const out = [];
  for (let i = 0; i < places.length; i++) {
    const m = measurePlace(places[i]);
    if (m) out.push(m);
    if (i % 150 === 149) await yieldToUI();
  }
  // With the places from finer tiles loaded while zoomed in, up to this moment (addFiner adds
  // the ones after).
  const ids = new Set(places.map((p) => p.id));
  for (const p of finer.raw.values()) {
    const m = !ids.has(p.id) && measurePlace(p);
    if (m) out.push(m);
  }
  const unique = dedupe(out.sort(byScore));
  // A newer part or a height change may have finished first; only the latest list wins.
  if (gen === world.gen && places === world.items) world.places = unique;
}

// ---------- finer place names when zoomed in ----------
// Zoomed in, the map tiles a level or more finer than the first load (tiles.mjs: finerPlan)
// name smaller places in the direction looked at: at most FINER_MAX tiles a view, nearest
// first, once the view has settled for a moment, like the points of interest below.
const FINER_WORKERS = 2;
const FINER_MAX = 12;
// raw: id → place as its tile gave it; tiles: 'z/x/y' asked for from here (the first load's
// own tiles included, so none is asked twice).
const finer = { raw: new Map(), tiles: new Set(), key: '', timer: null, queue: [], busy: 0 };

// Called each frame; plans again when the heading moves 5° or the zoom passes a step.
function planFiner(heading, halfDeg) {
  const step = detailFor(view.zoomTarget).zoom;
  const gen = world.gen;
  const key = step > 1 && world.measuredGen === gen ? `${gen}|${Math.round(heading / 5)}|${step}` : '';
  if (key === finer.key) return;
  finer.key = key;
  clearTimeout(finer.timer);
  finer.queue = [];
  if (!key) return;
  finer.timer = setTimeout(() => {
    if (gen !== world.gen) return;
    finer.queue = finerPlan(world.lat, world.lon, heading, halfDeg / step + 2, step, RANGE_KM)
      .filter((t) => !finer.tiles.has(`${t.z}/${t.x}/${t.y}`))
      .slice(0, FINER_MAX)
      .map((t) => ({ ...t, gen }));
    for (let i = finer.busy; i < FINER_WORKERS; i++) finerWorker();
  }, POI_WAIT_MS);
}
async function finerWorker() {
  finer.busy++;
  try {
    while (finer.queue.length) {
      const t = finer.queue.shift();
      const k = `${t.z}/${t.x}/${t.y}`;
      if (t.gen !== world.gen || finer.tiles.has(k)) continue;
      finer.tiles.add(k);
      try {
        const list = await loadFinerTile(t, world.lat, world.lon, RANGE_KM);
        if (t.gen !== world.gen) continue; // moved meanwhile: measured from the wrong place
        for (const p of list) finer.raw.set(p.id, p);
        addFiner(list);
      } catch (err) {
        console.warn(err);
        if (t.gen === world.gen) finer.tiles.delete(k); // asked for again on the next look this way
      }
    }
  } finally {
    finer.busy--;
  }
}
function addFiner(list) {
  const have = new Set(world.places.map((p) => p.id));
  const fresh = list.filter((p) => !have.has(p.id)).map(measurePlace).filter(Boolean);
  if (fresh.length) world.places = dedupe([...world.places, ...fresh].sort(byScore));
}

// ---------- points of interest: restaurants, shops, stations, sights ----------
// They come from the most detailed map tiles, about 2 km each, so only the tiles in the
// direction looked at are fetched, nearest first, once the view has settled for a moment.
const POI_WORKERS = 2;
const POI_WAIT_MS = 350;
const POI_MAX_KM = poiRange(10);
const CAT_COLOURS = { food: '#ff8a5c', shops: '#d08cff', travel: '#5cc8ff', sights: '#7ee08a' };
const isPoi = (p) => CATS.includes(p.kind);
// A kind of place the chips ask for is labelled (greyed) and lockable even when terrain hides
// it: the elevation data is too coarse to judge a few hundred metres of town, and the point
// of asking for restaurants is to find which way they are.
const asked = (p) => isPoi(p) && settings.cats[p.kind];
const poiTiles = new Map(); // 'x/y' → 'loading' or 'done'
const poiRaw = new Map(); // id → point of interest as the tile gave it
const poiLoad = { key: '', timer: null, waiting: false, queue: [], busy: 0 };

// Distance, direction, angle and whether hills or the curve hide it, as computePlaces does.
function measurePoi(p) {
  const k = KINDS[p.kind];
  const top = terrain.elev(p.lat, p.lon) + k.rise;
  const los = lineOfSight(terrain.elev, world.lat, world.lon, world.eye, p.lat, p.lon, top);
  const c = countryAt(p.lat, p.lon);
  return { ...p, ...los, top, country: c?.country ?? null, continent: c?.continent ?? null, score: k.rank - Math.min(25, los.d / 200) };
}
const nearPoi = (p) => distance(world.lat, world.lon, p.lat, p.lon) <= POI_MAX_KM * 1000;
// Every loaded point of interest, measured again from here (after a move or a height change).
function computePois() {
  world.pois = [...poiRaw.values()].filter(nearPoi).map(measurePoi);
}
function addPois(list) {
  if (world.measuredGen !== world.gen) return; // terrain for a new position is loading; computePois follows
  const have = new Set(world.pois.map((p) => p.id));
  const fresh = list.filter((p) => !have.has(p.id) && nearPoi(p)).map(measurePoi);
  if (fresh.length) world.pois = [...world.pois, ...fresh];
}

// Called each frame; plans again when the heading moves 5°, the zoom or the chips change.
function planPois(heading, halfDeg) {
  const zoom = view.zoomTarget;
  const wanted = CATS.some((c) => settings.cats[c]);
  const key = wanted && world.measuredGen === world.gen ? `${world.gen}|${Math.round(heading / 5)}|${zoom}` : '';
  if (key === poiLoad.key) return;
  poiLoad.key = key;
  clearTimeout(poiLoad.timer);
  poiLoad.queue = [];
  poiLoad.waiting = !!key;
  if (!key) return;
  poiLoad.timer = setTimeout(() => {
    poiLoad.waiting = false;
    poiLoad.queue = poiPlan(world.lat, world.lon, heading, halfDeg / zoom + 5, zoom).filter((t) => !poiTiles.has(`${t.x}/${t.y}`));
    for (let i = poiLoad.busy; i < POI_WORKERS; i++) poiWorker();
  }, POI_WAIT_MS);
}
async function poiWorker() {
  poiLoad.busy++;
  try {
    while (poiLoad.queue.length) {
      const t = poiLoad.queue.shift();
      const k = `${t.x}/${t.y}`;
      if (poiTiles.has(k)) continue;
      poiTiles.set(k, 'loading');
      try {
        const list = await loadPoiTile(t);
        for (const p of list) poiRaw.set(p.id, p);
        poiTiles.set(k, 'done');
        addPois(list);
      } catch (err) {
        console.warn(err);
        poiTiles.delete(k); // asked for again on the next look this way
      }
    }
  } finally {
    poiLoad.busy--;
  }
}

// Places plus the points of interest the chips ask for, best first. A point of interest that is also a named place within
// 500 m is left to the place. Worked out again only when one of those changes.
const shown = { places: null, pois: null, key: '', list: [] };
function shownPlaces() {
  const key = CATS.map((c) => +settings.cats[c]).join('');
  if (shown.places === world.places && shown.pois === world.pois && shown.key === key) return shown.list;
  const byName = new Map();
  for (const p of world.places) {
    const k = nameKey(p.name);
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const pois = world.pois.filter(
    (p) =>
      settings.cats[p.kind] &&
      !(byName.get(nameKey(p.name)) ?? []).some((q) => distance(p.lat, p.lon, q.lat, q.lon) < 500)
  );
  const list = pois.length ? [...world.places, ...pois].sort((a, b) => b.score - a.score) : world.places;
  Object.assign(shown, { places: world.places, pois: world.pois, key, list });
  return list;
}

// A chip is on but none of its places is in the picture: say so, rather than leave the user
// wondering whether the chip works. While tiles this way are still coming, say it is looking.
const HINT_DELAY_MS = 400;
const CAT_WORDS = { food: 'food places', shops: 'shops', travel: 'travel stops', sights: 'sights' };
let hintSince = null;
function updateChipHint(heading, halfDeg, now) {
  const el = $('chip-hint');
  const reach = poiRange(view.zoom) * 1000;
  const missing = CATS.filter(
    (c) => settings.cats[c] && !world.pois.some((p) => p.kind === c && p.d <= reach && Math.abs(angleDiff(p.brg, heading)) <= halfDeg)
  );
  if (!missing.length || $('chips').hidden) {
    hintSince = null;
    el.hidden = true;
    return;
  }
  hintSince ??= now;
  if (now - hintSince < HINT_DELAY_MS) return;
  const words = missing.map((c) => CAT_WORDS[c]).join(' or ');
  const looking = world.measuredGen !== world.gen || poiLoad.waiting || poiLoad.busy > 0;
  const text = looking ? `Looking for ${words}…` : `No ${words} this way`;
  if (el.textContent !== text) el.textContent = text;
  el.hidden = false;
}

function renderChips() {
  for (const b of document.querySelectorAll('#chips button')) b.setAttribute('aria-pressed', String(settings.cats[b.dataset.cat]));
}
for (const b of document.querySelectorAll('#chips button'))
  b.addEventListener('click', () => {
    settings.cats[b.dataset.cat] = !settings.cats[b.dataset.cat];
    saveSettings();
    renderChips();
  });
renderChips();

function skylineAt(az) {
  const n = world.horizon.length;
  const i = ((Math.round(az / HORIZON_STEP) % n) + n) % n;
  const h = world.horizon[i];
  if (!world.skylineCountry.has(i)) {
    const land = h.h > 2 ? countryAt(h.lat, h.lon) : null;
    const beyond = h.landD > h.d + 500 ? countryAt(h.landLat, h.landLon) : null;
    world.skylineCountry.set(i, { land, beyond });
  }
  return { ...h, ...world.skylineCountry.get(i) };
}

// ---------- orientation ----------
function listenOrientation() {
  const absolute = 'ondeviceorientationabsolute' in window;
  window.addEventListener(absolute ? 'deviceorientationabsolute' : 'deviceorientation', (e) => {
    if (e.alpha == null && e.webkitCompassHeading == null) return;
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    const raw = cameraAxes(e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0, angle);
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: alpha starts from an arbitrary direction; the compass heading is true-ish north
      // for the back camera when upright, or for the top edge when flat.
      const upright = Math.abs(raw.forward[2]) < 0.75;
      const ref = upright ? raw.forward : cameraAxes(e.alpha ?? 0, e.beta ?? 0, e.gamma ?? 0, 0).up;
      const target = angleDiff(e.webkitCompassHeading, headingOf(ref));
      view.offset = view.offsetKnown ? view.offset + angleDiff(target, view.offset) * 0.08 : target;
      view.offsetKnown = true;
      view.compassAccuracy = e.webkitCompassAccuracy;
    } else if (!absolute && !e.absolute) {
      return; // relative-only orientation with no compass: useless for pointing
    }
    view.sensor = true;
    // Fixing labels nudges the compass, so it is offered only once there is one.
    $('align-btn').hidden = false;
    view.axes = smoothAxes(view.axes, raw, view.rawSeen ? 0.3 : 1);
    view.rawSeen = true;
  });
}

function smoothAxes(prev, next, k) {
  const mix = (a, b) => {
    const v = a.map((x, i) => x + (b[i] - x) * k);
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  return { forward: mix(prev.forward, next.forward), up: mix(prev.up, next.up), right: mix(prev.right, next.right) };
}

function currentAxes() {
  if (view.sensor) return turn(view.axes, view.offset + settings.calibHeading);
  return axesFrom(view.heading, view.pitch);
}

// ---------- drawing ----------
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const labelEls = new Map();
const FONT = getComputedStyle(document.body).fontFamily;
const TIERS = [
  { upTo: 20000, size: 16, alpha: 1, cls: '' },
  { upTo: 80000, size: 14, alpha: 0.9, cls: 'mid' },
  { upTo: Infinity, size: 12, alpha: 0.75, cls: 'far' },
];
const LABEL_FADE_MS = 150;
// −1 for a size up, +1 for a size down; points of interest are sized by distance alone.
const importance = (p) => (isPoi(p) ? 0 : p.score >= 75 ? -1 : p.score < 35 ? 1 : 0);

function focal(W, H) {
  const v = $('video');
  const half = Math.tan((settings.fov * Math.PI) / 360);
  if (v.videoWidth) {
    const scale = Math.max(W / v.videoWidth, H / v.videoHeight);
    return ((Math.max(v.videoWidth, v.videoHeight) / 2 / half) * scale) * view.zoom;
  }
  return (Math.max(W, H) / 2 / half) * view.zoom;
}

function projector(axes, f, W, H) {
  const { forward: F, up: U, right: R } = axes;
  return (az, el) => {
    const d = direction(az, el + settings.calibPitch);
    const z = d[0] * F[0] + d[1] * F[1] + d[2] * F[2];
    if (z < 0.05) return null;
    const x = d[0] * R[0] + d[1] * R[1] + d[2] * R[2];
    const y = d[0] * U[0] + d[1] * U[1] + d[2] * U[2];
    return [W / 2 + (f * x) / z, H / 2 - (f * y) / z];
  };
}

function formatKm(m) {
  return m < 1000 ? `${Math.round(m)} m` : m < 20000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`;
}

function labelEl(p) {
  let el = labelEls.get(p.id);
  // A move or a height change recomputes every place, so refresh the text and what a tap opens.
  if (el && el._p === p) return el;
  if (!el) {
    el = document.createElement('button');
    el.className = `label k-${p.kind}`;
    el.hidden = true; // until placed, so it fades in
    const n = document.createElement('span');
    n.className = 'n';
    el.append(n, Object.assign(document.createElement('span'), { className: 'm' }));
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!dragMoved) openInfo(el._p);
    });
    $('labels').append(el);
    labelEls.set(p.id, el);
  }
  el._p = p;
  const [n, m] = el.children;
  n.textContent = p.name;
  // A point of interest says what it is first: "Restaurant · 470 m". A place past the curve of
  // the earth says so before anything else.
  const bits = isPoi(p) ? [p.type, formatKm(p.d)] : [formatKm(p.d)];
  if (!p.visible && p.blockedBy === 'curve') bits.unshift('Beyond horizon');
  if (p.kind === 'peak' && p.top) bits.push(`${Math.round(p.top)} m`);
  if (p.country && p.country !== world.home?.country) bits.push(p.country);
  m.textContent = bits.join(' · ');
  // Nearer places are larger and brighter: under 20 km, 20–80 km, beyond. A place that matters
  // more (a city, a high peak) is a size up, a small one (a far village, a hamlet) a size down.
  const t = TIERS[Math.min(TIERS.length - 1, Math.max(0, TIERS.findIndex((x) => p.d < x.upTo) + importance(p)))];
  el.classList.remove('mid', 'far');
  if (t.cls) el.classList.add(t.cls);
  el._alpha = t.alpha;
  // Size the box from the text itself, measured in the label's fonts (meta is tracked capitals).
  ctx.font = `600 ${t.size}px ${FONT}`;
  const nw = ctx.measureText(p.name).width;
  ctx.font = `11px ${FONT}`;
  const mw = ctx.measureText(m.textContent.toUpperCase()).width + m.textContent.length * 0.66;
  // A point of interest's name has a coloured dot before it (style.css), 8 px and a 5 px gap.
  el._w = Math.ceil(Math.max(nw + (isPoi(p) ? 13 : 0), mw)) + 10;
  el._h = Math.ceil(t.size * 1.2) + 14 + 4;
  return el;
}

function frame() {
  const W = innerWidth;
  const H = innerHeight;
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (view.zoom !== view.zoomTarget) {
    view.zoom += (view.zoomTarget - view.zoom) * ZOOM_EASE;
    if (Math.abs(view.zoomTarget - view.zoom) < 0.001) view.zoom = view.zoomTarget;
    $('video').style.transform = `scale(${view.zoom})`;
  }
  const axes = currentAxes();
  const f = focal(W, H);
  const project = projector(axes, f, W, H);
  const heading = headingOf(axes.forward);
  const pitch = pitchOf(axes.forward) - settings.calibPitch;

  const now = performance.now();
  // Keep labels below the banner, however tall it is on this phone.
  const top = $('banner').getBoundingClientRect().bottom + 8;
  // ...and their dots above the chips.
  const chips = $('chips');
  const bottom = chips.hidden ? H - 70 : Math.min(H - 70, chips.getBoundingClientRect().top - 8);
  if (settings.showSkyline || view.aligning) drawSkyline(project, W);
  // Half the width of the view in degrees at 1×, for which map tiles to ask for.
  const half1 = (Math.atan(W / 2 / (f / view.zoom)) * 180) / Math.PI;
  planPois(heading, half1);
  planFiner(heading, half1);
  const places = shownPlaces();
  const target = pickTarget(places, project, W, H, now);
  const cardY = placeReticle(target, W, H);
  // Keep labels off the card under the reticle.
  const { drawn, hiddenHere } = drawLabels(places, project, W, H, target, [W / 2 - 140, cardY - 4, W / 2 + 140, cardY + 66], top, bottom, now);
  updateEmpty(!drawn.length && !target && world.placesDone, hiddenHere, top, now);
  updateChipHint(heading, (Math.atan(W / 2 / f) * 180) / Math.PI, now);
  updateReadout(heading, pitch);
  if (world.horizon.length) {
    const scan = scanSkyline(heading);
    updateCard(target, scan);
    updateBanner(target, scan);
  }
  requestAnimationFrame(frame);
}

// ---------- target lock: what the reticle is pointing at ----------
const LOCK_PX = 56; // how near the centre a place's dot must be, at 1×
const LOCK_HOLD_MS = 300;
const lock = { id: null, p: null, pt: null, since: 0, seen: 0 };

// The visible place whose dot is nearest the centre, within LOCK_PX (a little more when zoomed
// in, though less in degrees). A target is kept for LOCK_HOLD_MS unless another is clearly
// closer, so a shaking hand does not make it flicker between two.
function pickTarget(places, project, W, H, now) {
  const r = LOCK_PX * Math.sqrt(view.zoom);
  const reach = poiRange(view.zoom) * 1000;
  let best = null;
  let bestPt = null;
  let bestD = Infinity;
  let cur = null;
  let curPt = null;
  let curD = Infinity;
  for (const p of places) {
    if (!(p.visible || asked(p)) || (isPoi(p) && p.d > reach)) continue;
    const pt = project(p.brg, p.angle);
    if (!pt) continue;
    const d = Math.hypot(pt[0] - W / 2, pt[1] - H / 2);
    if (p.id === lock.id) [cur, curPt, curD] = [p, pt, d];
    if (d < bestD) [best, bestPt, bestD] = [p, pt, d];
  }
  if (cur && curD <= r) lock.seen = now;
  const held = cur && now - lock.seen < LOCK_HOLD_MS;
  const better =
    best && bestD <= r && best.id !== lock.id &&
    (!held || bestD < curD * 0.6 || (now - lock.since > LOCK_HOLD_MS && bestD < curD * 0.85));
  if (better) Object.assign(lock, { id: best.id, p: best, pt: bestPt, since: now, seen: now });
  else if (held) Object.assign(lock, { p: cur, pt: curPt });
  else Object.assign(lock, { id: null, p: null, pt: null });
  return lock.id ? lock : null;
}

// Ring at the centre, or brackets round the target's dot; returns where the card goes.
let lockedId = null;
function placeReticle(target, W, H) {
  const el = $('reticle');
  const id = target?.id ?? null;
  if (id !== lockedId) {
    lockedId = id;
    el.classList.remove('locked');
    if (id) {
      void el.offsetWidth; // restart the snap for each new target
      el.classList.add('locked');
    }
  }
  const [x, y] = target ? target.pt : [W / 2, H / 2];
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  if (target) {
    ctx.fillStyle = '#ffcf4a';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const cardY = Math.max(H / 2 + 24, y + 24);
  $('target').style.top = `${cardY}px`;
  return cardY;
}

// The skyline under the reticle, widened by ±3° (less when zoomed) so a wobbling hand does not
// flip the answer: the highest land ray in that window, and the ray straight ahead.
function scanSkyline(heading) {
  const span = 3 / view.zoom;
  let land = null;
  for (let a = -span; a <= span + 1e-9; a += HORIZON_STEP) {
    const s = skylineAt(heading + a);
    if (s.h > 2 && (!land || s.angle > land.angle)) land = s;
  }
  return { land, ahead: skylineAt(heading) };
}

// Card under the reticle: the target place, or failing that the land or sea straight ahead.
let lastCardKey = '';
function updateCard(target, scan) {
  const el = $('target');
  let lines;
  if (target) {
    const p = target.p;
    const meta = [isPoi(p) ? p.type : KINDS[p.kind].label];
    if (p.kind === 'peak' && p.top) meta.push(`${Math.round(p.top)} m`);
    meta.push(formatKm(p.d));
    lines = [p.name, meta.join(' · '), [p.country, p.continent].filter(Boolean).join(' · ')];
  } else if (scan.land) {
    const s = scan.land;
    const c = s.land?.country;
    const far = c && (c !== world.home?.country || s.d >= 20000);
    lines = [`${far ? c : s.h > 1500 ? 'Mountains' : 'Hills'} · ${formatKm(s.d)}`, '', ''];
  } else {
    lines = [`Open sea · horizon ${formatKm(scan.ahead.d)}`, '', ''];
  }
  const key = `${target ? 'p' : 's'}|${lines.join('|')}`;
  if (key === lastCardKey) return;
  lastCardKey = key;
  el.classList.toggle('sky', !target);
  [...el.children].forEach((span, i) => (span.textContent = lines[i]));
  el.hidden = false;
}
$('target').addEventListener('click', () => {
  if (lock.p && !dragMoved) openInfo(lock.p);
});

function drawSkyline(project, W) {
  ctx.strokeStyle = view.aligning ? 'rgba(255, 207, 74, 0.95)' : 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = view.aligning ? 2.5 : 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  let last = null;
  const n = world.horizon.length;
  for (let i = 0; i <= n; i++) {
    const h = world.horizon[i % n];
    const pt = project((i % n) * HORIZON_STEP, h.angle);
    if (pt && last && Math.abs(pt[0] - last[0]) < W) ctx.lineTo(pt[0], pt[1]);
    else if (pt) ctx.moveTo(pt[0], pt[1]);
    last = pt;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

// Zoomed in to 2× or more, places past the curve of the earth are drawn greyed and tagged
// "Beyond horizon" whatever the hidden-places setting: across the sea they are all there is to
// name. Places behind hills still follow the setting.
const BEYOND_ZOOM = 2;
const beyond = (p) => !p.visible && p.blockedBy === 'curve' && view.zoom >= BEYOND_ZOOM - 0.05;

function drawLabels(places, project, W, H, target, reserved, top, bottom, now) {
  const placed = [reserved];
  const drawn = [];
  // Fewer, bigger names at 1×; smaller places as the zoom narrows the view (detailFor).
  const { minScore, cap: max, rows } = detailFor(view.zoom);
  // Points of interest only so far: a few km by eye, further zoomed in.
  const reach = poiRange(view.zoom) * 1000;
  // Hidden places in frame, counted only while nothing is labelled: the empty-view note offers them.
  const hiddenHere = { curve: 0, terrain: 0 };
  // Places beyond the horizon go in a second pass, so they only fill the room left over.
  for (const later of [false, true]) for (const p of places) {
    if (drawn.length >= max) break;
    if (beyond(p) !== later) continue;
    if (p.id === target?.id) continue; // the card under the reticle names it
    if (isPoi(p) ? p.d > reach : p.score < minScore) continue;
    const skip = !p.visible && !settings.showHidden && !asked(p) && !beyond(p);
    if (skip && drawn.length) continue;
    const pt = project(p.brg, p.angle);
    if (!pt) continue;
    const [sx, sy] = pt;
    if (sx < -20 || sx > W + 20 || sy < top - 40 || sy > bottom) continue;
    if (skip) {
      hiddenHere[p.blockedBy === 'curve' ? 'curve' : 'terrain']++;
      continue;
    }
    const el = labelEl(p);
    const w = el._w;
    const h = el._h;
    const x = Math.min(Math.max(4, sx - w / 2), W - w - 4);
    let spot = null;
    for (let row = 0; row < rows && !spot; row++) {
      const y = sy - 22 - h - row * (h + 4);
      if (y < top) break;
      const box = [x, y, x + w, y + h];
      const hit = placed.some((b) => box[0] < b[2] + 4 && box[2] > b[0] - 4 && box[1] < b[3] && box[3] > b[1]);
      if (!hit) spot = box;
    }
    if (!spot) continue;
    placed.push(spot);
    drawn.push({ p, el, sx, sy, spot });
  }
  // Leader lines and dots first, with every label's box cut out, so a line never runs through
  // another label's text.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  for (const { spot } of drawn) ctx.rect(spot[0], spot[1], spot[2] - spot[0], spot[3] - spot[1]);
  ctx.clip('evenodd');
  ctx.lineWidth = 1;
  for (const { p, el, sx, sy, spot } of drawn) {
    ctx.strokeStyle = p.visible ? `rgba(255, 255, 255, ${0.8 * el._alpha})` : `rgba(160, 170, 190, ${0.5 * el._alpha})`;
    ctx.beginPath();
    ctx.moveTo(sx, spot[3]);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }
  ctx.restore();
  for (const { p, sx, sy } of drawn) {
    ctx.fillStyle = p.visible ? (CAT_COLOURS[p.kind] ?? '#ffcf4a') : '#8a93a6';
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const used = new Set();
  for (const { p, el, spot } of drawn) {
    used.add(p.id);
    el._off = null;
    el.classList.toggle('hidden-place', !p.visible);
    el.style.transform = `translate(${spot[0]}px, ${spot[1]}px)`;
    if (el.hidden) {
      el.hidden = false;
      void el.offsetWidth; // start from transparent so it fades in
    }
    el.classList.add('on');
  }
  // Fade out, then hide once faded.
  for (const [id, el] of labelEls) {
    if (used.has(id) || el.hidden) continue;
    el.classList.remove('on');
    el._off ??= now;
    if (now - el._off > LABEL_FADE_MS) el.hidden = true;
  }
  return { drawn, hiddenHere };
}

// With nothing labelled this way, say so under the banner, and offer the hidden places, naming
// what hides them: the curve of the earth or hills. It waits a moment before showing, so sweeping
// past a gap stays quiet.
const EMPTY_DELAY_MS = 400;
let emptySince = null;
function updateEmpty(empty, { curve, terrain }, top, now) {
  const el = $('empty');
  if (!empty) {
    emptySince = null;
    el.hidden = true;
    return;
  }
  emptySince ??= now;
  if (now - emptySince < EMPTY_DELAY_MS) return;
  const text = `Nothing named in sight this way${curve ? ` · ${curve} below the horizon` : ''}${terrain ? ` · ${terrain} behind hills` : ''}`;
  if ($('empty-text').textContent !== text) $('empty-text').textContent = text;
  $('empty-show').hidden = !(curve + terrain);
  el.style.top = `${top}px`;
  el.hidden = false;
}
$('empty-show').addEventListener('click', () => {
  settings.showHidden = true;
  $('show-hidden').checked = true;
  saveSettings();
  $('empty').hidden = true;
});

function updateReadout(heading, pitch) {
  $('heading').textContent = `${compass(heading)} ${Math.round(heading)}°`;
  $('pitch').textContent = `${pitch >= 0 ? '↑' : '↓'} ${Math.abs(pitch).toFixed(1)}°`;
}

// Continent big, then the country and at most one short note. It agrees with the card: the
// target's country when one is locked, else the highest land within the reticle's window.
let lastBannerKey = '';
function updateBanner(target, { land, ahead }) {
  let continent;
  let country;
  if (target?.p.country) {
    continent = target.p.continent ?? '';
    country = target.p.country;
  } else if (land) {
    continent = land.land?.continent ?? '';
    country = land.land?.country ?? 'Land';
  } else {
    continent = 'Open sea';
    country = '';
  }
  if (!continent) [continent, country] = [country, ''];
  const beyond = (land ?? ahead).beyond?.country;
  let note = '';
  if (view.sensor && view.compassAccuracy != null && (view.compassAccuracy < 0 || view.compassAccuracy > 25)) {
    note = 'Compass unsure: wave phone in a figure-8';
  } else if (beyond && beyond !== country && beyond !== continent && beyond !== target?.p.country) {
    note = `${beyond} beyond · below the horizon`;
  } else if (land && land.d > 5000) {
    note = `Skyline ${formatKm(land.d)}`;
  }
  const key = `${continent}|${country}|${note}`;
  if (key === lastBannerKey) return;
  lastBannerKey = key;
  $('banner-continent').textContent = continent;
  $('banner-country').textContent = country;
  $('banner-note').textContent = note;
}

// ---------- info card ----------
let infoFor = null;
function openInfo(p) {
  // One plain sentence first: "Jebel Musa, a peak in Morocco, Africa — 82 km SW. You can see it
  // from here." The details follow below it.
  $('info-name').textContent = p.name;
  const poi = isPoi(p);
  const kind = (poi ? p.type : KINDS[p.kind].label.split(' /')[0]).toLowerCase();
  $('info-kind').textContent = poi ? `${KINDS[p.kind].label} · ${p.type}` : KINDS[p.kind].label;
  $('info-height-row').hidden = poi;
  const where = [p.country, p.continent].filter(Boolean).join(', ');
  const seen = p.visible ? 'You can see it from here.' : p.blockedBy === 'curve' ? 'Below the horizon.' : 'Hidden behind hills.';
  $('info-lead-rest').textContent =
    `, ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}${where ? ` in ${where}` : ''} — ${formatKm(p.d)} ${compass(p.brg)}. ${seen}`;
  $('info-distance').textContent = formatKm(p.d);
  $('info-bearing').textContent = `${compass(p.brg)} (${Math.round(p.brg)}°)`;
  $('info-height').textContent = `${Math.round(p.top)} m above sea level`;
  $('info-visible').textContent = p.visible
    ? 'Yes — nothing in the way'
    : p.blockedBy === 'curve'
      ? "No — it's below the horizon (the earth's curve hides it)"
      : 'No — hills in front of it hide it';
  const wiki = $('info-wiki');
  const m = p.wikipedia && /^([a-z-]{2,12}):(.+)$/.exec(p.wikipedia);
  wiki.hidden = !m;
  if (m) wiki.href = `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`;
  $('info-map').href = `https://www.google.com/maps/search/?api=1&query=${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  // Opening hours and website arrive a moment later, for a map point of interest only.
  const site = $('info-website');
  $('info-hours-row').hidden = true;
  site.hidden = true;
  site.removeAttribute('href');
  infoFor = p.id;
  if (poi && p.osm)
    loadDetails(p.osm).then((d) => {
      if (!d || infoFor !== p.id || $('info').hidden) return;
      if (d.hours) {
        $('info-hours').textContent = d.hours;
        $('info-hours-row').hidden = false;
      }
      if (d.website) {
        site.href = d.website;
        site.textContent = new URL(d.website).hostname.replace(/^www\./, '');
        site.hidden = false;
      }
    });
  show('settings', false);
  show('info');
}

// ---------- gestures: drag to look (no sensors) or to align, pinch to zoom ----------
const pointers = new Map();
let dragMoved = false;
let pinchStart = null;

// The picture eases toward the chosen zoom, this fraction of the way each frame.
const ZOOM_EASE = 0.18;
const ZOOM_STEPS = [1, 2, 4, 8];
function setZoom(z) {
  view.zoomTarget = Math.min(10, Math.max(1, z));
  $('zoom-btn').textContent = `${Math.round(view.zoomTarget * 10) / 10}×`;
}
// Each tap goes to the next step up, and from 8× (or beyond) back to 1×.
$('zoom-btn').addEventListener('click', () => setZoom(ZOOM_STEPS.find((z) => z > view.zoomTarget + 0.05) ?? 1));

addEventListener('pointerdown', (e) => {
  if (e.target.closest('.sheet, #hud, #align-hint, #notices, .sheet-full, #empty')) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  dragMoved = false;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: view.zoomTarget };
  }
});
addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const cur = [e.clientX, e.clientY];
  pointers.set(e.pointerId, cur);
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    setZoom((pinchStart.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinchStart.dist);
    dragMoved = true;
    return;
  }
  const dx = cur[0] - prev[0];
  const dy = cur[1] - prev[1];
  if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
  const degPerPx = 180 / Math.PI / focal(innerWidth, innerHeight);
  if (view.sensor) {
    if (!view.aligning) return;
    // Move the labels with the finger.
    settings.calibHeading -= dx * degPerPx;
    settings.calibPitch -= dy * degPerPx;
  } else {
    // Move the scene with the finger, like a photo.
    view.heading = (view.heading - dx * degPerPx + 360) % 360;
    view.pitch = Math.max(-60, Math.min(60, view.pitch + dy * degPerPx));
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
};
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);
addEventListener('keydown', (e) => {
  if (view.sensor) return;
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft') view.heading = (view.heading - step + 360) % 360;
  if (e.key === 'ArrowRight') view.heading = (view.heading + step) % 360;
  if (e.key === 'ArrowUp') view.pitch += step / 2;
  if (e.key === 'ArrowDown') view.pitch -= step / 2;
});

// ---------- controls ----------
$('start-btn').addEventListener('click', () => {
  const lat = parseFloat(params.get('lat'));
  const lon = parseFloat(params.get('lon'));
  const fixed =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? { lat, lon, heading: parseFloat(params.get('heading')) || 0, pitch: parseFloat(params.get('pitch')) || 0 }
      : null;
  start(fixed);
});
$('demo-btn').addEventListener('click', () => start({ ...DEMO }));
// A fresh tap, so the browser may show its camera prompt again.
$('cam-retry').addEventListener('click', () => startCamera());
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => show(b.dataset.close, false)));

function setAligning(on) {
  view.aligning = on;
  $('align-btn').classList.toggle('on', on);
  show('align-hint', on);
  if (!on) saveSettings();
}
$('align-btn').addEventListener('click', () => setAligning(!view.aligning));
$('align-done').addEventListener('click', () => setAligning(false));

$('settings-btn').addEventListener('click', () => {
  $('hag').value = settings.hag;
  $('fov').value = settings.fov;
  $('show-hidden').checked = settings.showHidden;
  $('show-skyline').checked = settings.showSkyline;
  renderSettingValues();
  show('info', false);
  show('settings');
});
function renderSettingValues() {
  $('hag-val').textContent = `${settings.hag} m`;
  $('fov-val').textContent = `${settings.fov}°`;
  $('eye-val').textContent = `${Math.round(world.eye)} m`;
}
$('fov').addEventListener('input', (e) => {
  settings.fov = Number(e.target.value);
  renderSettingValues();
  saveSettings();
});
$('hag').addEventListener('input', (e) => {
  settings.hag = Number(e.target.value);
  renderSettingValues();
  saveSettings();
});
// Height changes only what is visible, so recompute from the places already loaded once the
// slider is let go.
$('hag').addEventListener('change', async () => {
  if (world.lat == null || world.busy) return;
  world.busy = true;
  try {
    // Repeat if the height was changed again while this was working.
    while (world.eye !== terrain.elev(world.lat, world.lon) + settings.hag) {
      world.eye = terrain.elev(world.lat, world.lon) + settings.hag;
      await computeHorizon();
      await computePlaces(world.items, world.gen);
      computePois();
    }
  } finally {
    world.busy = false;
  }
  renderSettingValues();
});
$('show-hidden').addEventListener('change', (e) => {
  settings.showHidden = e.target.checked;
  saveSettings();
});
$('show-skyline').addEventListener('change', (e) => {
  settings.showSkyline = e.target.checked;
  saveSettings();
});
$('reset-align').addEventListener('click', () => {
  settings.calibHeading = 0;
  settings.calibPitch = 0;
  saveSettings();
  toast('Label fix undone.');
});
// Reload and Retry say at once that names are on the way. If the view is still being worked out
// (a height change, a move), the load waits for it; taps while one is waiting or loading add nothing.
let reloading = false;
async function reloadPlaces() {
  if (world.lat == null || reloading) return;
  placeStatus({ done: 0, total: 0 });
  reloading = true;
  try {
    while (world.busy) await new Promise((r) => setTimeout(r, 100));
    await loadWorld(world.lat, world.lon, { fresh: true });
  } finally {
    reloading = false;
  }
}
$('reload-data').addEventListener('click', () => {
  show('settings', false);
  // The place-name line shows progress, then goes or offers Retry; terrain returning first is
  // not the names being done.
  reloadPlaces();
});
$('status-retry').addEventListener('click', reloadPlaces);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Test hook: ?autostart starts straight away (fixed location if lat/lon given).
if (params.has('autostart')) $('start-btn').click();

// Exposed for automated checks only.
window.__binoculars = { world, view, settings, apparentAngle, detailFor };
