import { angleDiff, apparentAngle, compass, distance, horizonAlong, lineOfSight } from './geo.mjs';
import { Terrain } from './terrain.mjs';
import { KINDS, loadPlaces } from './places.mjs';
import { countryAt, loadCountries } from './countries.mjs';
import { axesFrom, cameraAxes, direction, headingOf, pitchOf, turn } from './orientation.mjs';

const RANGE_KM = 150;
const HORIZON_STEP = 0.25; // degrees between skyline rays
const MAX_LABELS = 28;
const DEMO = { lat: 36.5068, lon: -4.886, heading: 222, pitch: 0.3 }; // Marbella seafront, facing the Strait

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------- settings (per viewer, survives reloads) ----------
const SETTINGS_KEY = 'binoculars:settings:v1';
const settings = { hag: 2, fov: 64, showHidden: false, showSkyline: true, calibHeading: 0, calibPitch: 0 };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {});
} catch {}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

// ---------- world state ----------
const terrain = new Terrain();
const world = { lat: null, lon: null, eye: 0, places: [], horizon: [], skylineCountry: new Map(), home: null, gen: 0, placesDone: false };
const view = {
  sensor: false, // true once real orientation events arrive
  axes: axesFrom(0, 0),
  offset: 0, // degrees added to the sensor heading to make it true-north
  offsetKnown: false,
  heading: 0, // manual mode
  pitch: 0,
  zoom: 1,
  aligning: false,
  compassAccuracy: null,
};

// ---------- start-up ----------
function show(id, on = true) {
  $(id).hidden = !on;
}
function toast(msg, ms = 5000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  if (ms) toast.timer = setTimeout(() => (t.hidden = true), ms);
}
function loading(text) {
  $('loading-text').textContent = text;
}

async function start(fixed) {
  // iOS only grants motion sensors from inside the tap, so ask before anything awaits.
  const motion = requestMotion();
  const camera = params.has('nocam') ? Promise.resolve() : startCamera();
  show('start', false);
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
      toast(`Couldn't get your location (${err.message}). Allow location for this site, or try the demo.`, 0);
      return;
    }
  }
  await loadWorld(pos.lat, pos.lon);
  show('loading', false);
  ['banner', 'reticle', 'hud'].forEach((id) => show(id));
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

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    const v = $('video');
    v.srcObject = stream;
    await v.play().catch(() => {});
  } catch {
    toast('No camera — showing labels on a plain background.');
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
    world.lat = lat;
    world.lon = lon;
    loading('Loading terrain…');
    const gen = ++world.gen;
    // After a move, show the places already loaded from the new position until fresh ones arrive.
    const prev = world.items ?? [];
    world.places = [];
    world.items = prev;
    world.placesDone = false;
    // Place names come from a slow public server, so they stream in after the view is up.
    let ready;
    const terrainReady = new Promise((r) => (ready = r));
    // Each step runs after the last, and only while this is still the latest load.
    let chain = terrainReady;
    const then = (fn) => (chain = chain.then(() => gen === world.gen && fn()));
    then(() => toast('Loading place names…', 0));
    then(() => computePlaces(prev, gen));
    loadPlaces(lat, lon, RANGE_KM, {
      fresh,
      onPart: (items, done, total, failed) => {
        // A load for an earlier position can still be answering after a move.
        if (gen !== world.gen) return;
        // Keep the earlier places alongside each part until every part has loaded.
        const ids = new Set(items.map((x) => x.id));
        const shown = done < total || failed ? [...items, ...prev.filter((x) => !ids.has(x.id))] : items;
        world.items = shown;
        then(async () => {
          await computePlaces(shown, gen);
          if (done < total) toast(`Loading place names ${done} / ${total}…`, 0);
          else if (failed) toast("Some place names didn't load — try Reload map data in settings.", 8000);
          else toast('Place names loaded.', 2000);
        });
      },
    })
      .catch((err) => {
        console.warn(err);
        then(() => toast("Couldn't load place names right now — showing the skyline and countries only.", 8000));
      })
      .finally(() => then(() => (world.placesDone = true)));
    const [, tiles] = await Promise.all([
      loadCountries(),
      terrain.load(lat, lon, (n, total) => loading(`Loading terrain ${n} / ${total}…`)),
    ]);
    if (tiles.failed > tiles.total / 2) toast('Most terrain failed to load — hills will not hide anything.', 8000);

    world.eye = terrain.elev(lat, lon) + settings.hag;
    world.home = countryAt(lat, lon);
    await computeHorizon();
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

async function computePlaces(places, gen) {
  const out = [];
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    const ground = terrain.elev(p.lat, p.lon);
    const k = KINDS[p.kind];
    const top =
      p.kind === 'peak' ? Math.max(p.ele ?? 0, ground) : Math.max(ground, p.ele ?? 0) + (p.height ?? k.rise);
    const los = lineOfSight(terrain.elev, world.lat, world.lon, world.eye, p.lat, p.lon, top, { peak: p.kind === 'peak' });
    if (los.d > RANGE_KM * 1000) continue;
    const c = countryAt(p.lat, p.lon);
    let score = k.rank;
    if (p.kind === 'peak') score += Math.min(40, top / 50);
    if (p.population) score += Math.min(25, Math.log10(p.population) * 4);
    if (p.kind === 'village' || p.kind === 'hamlet') score -= Math.min(15, los.d / 4000);
    out.push({ ...p, ...los, top, country: c?.country ?? null, continent: c?.continent ?? null, score });
    if (i % 150 === 149) await yieldToUI();
  }
  out.sort((a, b) => b.score - a.score);
  // OpenStreetMap sometimes maps one summit or town twice; keep the best-scored of each name
  // within 2 km.
  const seen = new Map();
  const unique = out.filter((p) => {
    const twins = seen.get(p.name) ?? [];
    if (twins.some((q) => distance(p.lat, p.lon, q.lat, q.lon) < 2000)) return false;
    seen.set(p.name, [...twins, p]);
    return true;
  });
  // A newer part or a height change may have finished first; only the latest list wins.
  if (gen === world.gen && places === world.items) world.places = unique;
}

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
  const bits = [formatKm(p.d)];
  if (p.kind === 'peak' && p.top) bits.push(`${Math.round(p.top)} m`);
  if (p.country && p.country !== world.home?.country) bits.push(p.country);
  m.textContent = bits.join(' · ');
  el._w = Math.max(64, Math.max(p.name.length * 8.2, m.textContent.length * 6.4) + 18);
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

  const axes = currentAxes();
  const f = focal(W, H);
  const project = projector(axes, f, W, H);
  const heading = headingOf(axes.forward);
  const pitch = pitchOf(axes.forward) - settings.calibPitch;

  if (settings.showSkyline || view.aligning) drawSkyline(project, W);
  drawLabels(project, W, H);
  updateReadout(heading, pitch);
  requestAnimationFrame(frame);
}

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

function drawLabels(project, W, H) {
  const placed = [];
  const used = new Set();
  const top = 96; // keep clear of the country banner
  for (const p of world.places) {
    if (placed.length >= MAX_LABELS) break;
    if (!p.visible && !settings.showHidden) continue;
    const pt = project(p.brg, p.angle);
    if (!pt) continue;
    const [sx, sy] = pt;
    if (sx < -20 || sx > W + 20 || sy < top - 40 || sy > H - 70) continue;
    const el = labelEl(p);
    const w = el._w;
    const h = 38;
    const x = Math.min(Math.max(4, sx - w / 2), W - w - 4);
    let spot = null;
    for (let row = 0; row < 7 && !spot; row++) {
      const y = sy - 22 - h - row * (h + 4);
      if (y < top) break;
      const box = [x, y, x + w, y + h];
      const hit = placed.some((b) => box[0] < b[2] + 4 && box[2] > b[0] - 4 && box[1] < b[3] && box[3] > b[1]);
      if (!hit) spot = box;
    }
    if (!spot) continue;
    placed.push(spot);
    used.add(p.id);
    el.hidden = false;
    el.classList.toggle('hidden-place', !p.visible);
    el.style.transform = `translate(${spot[0]}px, ${spot[1]}px)`;
    ctx.strokeStyle = p.visible ? 'rgba(255, 255, 255, 0.8)' : 'rgba(160, 170, 190, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx, spot[3]);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.fillStyle = p.visible ? '#ffcf4a' : '#8a93a6';
    ctx.beginPath();
    ctx.arc(sx, sy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const [id, el] of labelEls) if (!used.has(id)) el.hidden = true;
}

let lastBannerKey = '';
function updateReadout(heading, pitch) {
  $('heading').textContent = `${compass(heading)} ${Math.round(heading)}°`;
  $('pitch').textContent = `${pitch >= 0 ? '↑' : '↓'} ${Math.abs(pitch).toFixed(1)}°`;
  if (!world.horizon.length) return;
  const s = skylineAt(heading);
  const key = `${s.land?.country}|${s.beyond?.country}|${Math.round(s.d / 1000)}`;
  if (key === lastBannerKey) return;
  lastBannerKey = key;
  let continent = '';
  let country = '';
  let note = '';
  if (s.land) {
    continent = s.land.continent?.toUpperCase() ?? '';
    country = s.land.country;
    note = `Skyline ${formatKm(s.d)} away`;
  } else if (s.h > 2) {
    country = 'Land';
    note = `Skyline ${formatKm(s.d)} away`;
  } else {
    country = 'Sea horizon';
    note = `${formatKm(s.d)} away`;
  }
  if (s.beyond && s.beyond.country !== s.land?.country) {
    note += ` · ${s.beyond.country} lies beyond, ${formatKm(s.landD)} away, out of sight`;
  }
  if (view.sensor && view.compassAccuracy != null && (view.compassAccuracy < 0 || view.compassAccuracy > 25)) {
    note += ' · Compass unsure: wave the phone in a figure-8';
  }
  $('banner-continent').textContent = continent;
  $('banner-country').textContent = country;
  $('banner-note').textContent = note;
}

// ---------- info card ----------
function openInfo(p) {
  $('info-name').textContent = p.name;
  const kind = KINDS[p.kind].label;
  $('info-kind').textContent = [kind, p.country].filter(Boolean).join(' · ');
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
  show('settings', false);
  show('info');
}

// ---------- gestures: drag to look (no sensors) or to align, pinch to zoom ----------
const pointers = new Map();
let dragMoved = false;
let pinchStart = null;

function setZoom(z) {
  view.zoom = Math.min(10, Math.max(1, z));
  $('video').style.transform = `scale(${view.zoom})`;
  document.querySelectorAll('#zooms button').forEach((b) => {
    b.classList.toggle('on', Math.abs(Number(b.dataset.zoom) - view.zoom) < 0.05);
  });
}

addEventListener('pointerdown', (e) => {
  if (e.target.closest('.sheet, #hud, #align-hint, .sheet-full')) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  dragMoved = false;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: view.zoom };
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
document.querySelectorAll('#zooms button').forEach((b) => b.addEventListener('click', () => setZoom(Number(b.dataset.zoom))));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => show(b.dataset.close, false)));

function setAligning(on) {
  view.aligning = on;
  $('align-btn').classList.toggle('on', on);
  show('align-hint', on);
  if (!on) saveSettings();
}
$('align-btn').addEventListener('click', () => {
  if (!view.sensor) {
    toast('Align fine-tunes the compass on a phone. Here, just drag to look around.');
    return;
  }
  setAligning(!view.aligning);
});
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
    }
  } finally {
    world.busy = false;
  }
  renderSettingValues();
  lastBannerKey = '';
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
  toast('Alignment reset.');
});
$('reload-data').addEventListener('click', async () => {
  if (world.lat == null || world.busy) return;
  show('settings', false);
  toast('Reloading map data…', 0);
  await loadWorld(world.lat, world.lon, { fresh: true });
  lastBannerKey = '';
  toast('Map data reloaded.');
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Test hook: ?autostart starts straight away (fixed location if lat/lon given).
if (params.has('autostart')) $('start-btn').click();

// Exposed for automated checks only.
window.__binoculars = { world, view, settings, apparentAngle };
