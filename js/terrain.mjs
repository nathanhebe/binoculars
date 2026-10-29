// Ground height from Terrarium elevation tiles (free, no key, served by AWS Open Data).
// Three detail levels: sharp close up, coarse out to the edge of the view range.

const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const LEVELS = [
  { z: 12, radius: 8000 },
  { z: 10, radius: 40000 },
  { z: 9, radius: 160000 },
];

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function loadTile(z, x, y) {
  const res = await fetch(TILE_URL(z, x, y), { mode: 'cors' });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, 256, 256).data;
  const h = new Float32Array(256 * 256);
  for (let i = 0; i < h.length; i++) {
    // Terrarium encoding; below sea level is sea, which we treat as the water surface.
    const v = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    h[i] = v > 0 ? v : 0;
  }
  return h;
}

export class Terrain {
  constructor() {
    this.tiles = new Map(); // "z/x/y" -> Float32Array
    this.elev = this.elev.bind(this);
  }

  // Fetch every tile needed around (lat, lon). Failed tiles read as sea level.
  async load(lat, lon, onProgress = () => {}) {
    const jobs = [];
    for (const { z, radius } of LEVELS) {
      const dLat = radius / 111320;
      const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
      const x0 = Math.floor(lonToX(lon - dLon, z));
      const x1 = Math.floor(lonToX(lon + dLon, z));
      const y0 = Math.floor(latToY(lat + dLat, z));
      const y1 = Math.floor(latToY(lat - dLat, z));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([z, x, y]);
    }
    let done = 0;
    let failed = 0;
    const queue = jobs.filter(([z, x, y]) => !this.tiles.has(`${z}/${x}/${y}`));
    const worker = async () => {
      while (queue.length) {
        const [z, x, y] = queue.shift();
        try {
          this.tiles.set(`${z}/${x}/${y}`, await loadTile(z, x, y));
        } catch {
          failed++;
        }
        onProgress(++done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return { total: jobs.length, failed };
  }

  // Ground height in metres at (lat, lon) from the most detailed tile loaded there.
  elev(lat, lon) {
    for (const { z } of LEVELS) {
      const fx = lonToX(lon, z);
      const fy = latToY(lat, z);
      const tx = Math.floor(fx);
      const ty = Math.floor(fy);
      const t = this.tiles.get(`${z}/${tx}/${ty}`);
      if (!t) continue;
      const px = Math.min(255, Math.max(0, (fx - tx) * 256 - 0.5));
      const py = Math.min(255, Math.max(0, (fy - ty) * 256 - 0.5));
      const ix = Math.min(254, Math.floor(px));
      const iy = Math.min(254, Math.floor(py));
      const ax = px - ix;
      const ay = py - iy;
      const i = iy * 256 + ix;
      return (
        t[i] * (1 - ax) * (1 - ay) + t[i + 1] * ax * (1 - ay) + t[i + 256] * (1 - ax) * ay + t[i + 257] * ax * ay
      );
    }
    return 0;
  }
}
