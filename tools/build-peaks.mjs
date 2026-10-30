// One-off: builds assets/peaks-major.json, the mountains named with no network at all, from
// Wikidata (CC0): mountains, summits and volcanoes with a height, a position, an English name
// and Wikipedia articles in at least three languages. The number of articles stands in for how
// well known a peak is. Run from the repo root:
//   node tools/build-peaks.mjs [path to a saved CSV of the query below]
// With no path it asks the Wikidata query service (about ten seconds).
import { readFile, writeFile } from 'node:fs/promises';

const QUERY = `SELECT ?item ?label ?coord ?ele ?links WHERE {
  VALUES ?type { wd:Q8502 wd:Q207326 wd:Q8072 }
  ?item wdt:P31 ?type; wikibase:sitelinks ?links; wdt:P625 ?coord;
        p:P2044/psn:P2044/wikibase:quantityAmount ?ele.
  FILTER(?links >= 2)
  ?item rdfs:label ?label FILTER(lang(?label) = "en")
}`;
const CELL = 0.5; // degrees: keep the best known few in each cell so no range is left bare
const PER_CELL = 2;
const MIN_LINKS = 3; // Wikipedia languages; two lets in thousands of minor hills
const MAX_ROWS = 7800; // about 300 KB

async function source() {
  if (process.argv[2]) return readFile(process.argv[2], 'utf8');
  const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}`;
  const res = await fetch(url, { headers: { Accept: 'text/csv', 'User-Agent': 'binoculars-build-peaks/1.0' } });
  if (!res.ok) throw new Error(`Wikidata: HTTP ${res.status}`);
  return res.text();
}

// RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks.
function csv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n') row.push(field), rows.push(row), (row = []), (field = '');
    else if (c !== '\r') field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows;
}

const [head, ...body] = csv(await source());
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const byItem = new Map();
for (const r of body) {
  const m = /^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(r[col.coord] ?? '');
  const ele = Number(r[col.ele]);
  const name = String(r[col.label] ?? '').replace(/\p{Cf}/gu, '').trim();
  // An item can carry several heights or positions; the first row stands for it.
  if (!m || !name || !Number.isFinite(ele) || ele < 1 || Number(r[col.links]) < MIN_LINKS || byItem.has(r[col.item])) continue;
  const [lon, lat] = [Number(m[1]), Number(m[2])];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
  byItem.set(r[col.item], { name, lat, lon, ele, links: Number(r[col.links]) });
}

const cells = new Map();
for (const p of byItem.values()) {
  const k = `${Math.floor(p.lat / CELL)},${Math.floor(p.lon / CELL)}`;
  cells.set(k, [...(cells.get(k) ?? []), p]);
}
// The best known peak of every cell is kept; the runners-up fill the rest of the budget, best
// known first, so the file stays small without leaving any range bare.
const firsts = [];
const rest = [];
for (const list of cells.values()) {
  list.sort((a, b) => b.links - a.links || b.ele - a.ele);
  firsts.push(list[0]);
  rest.push(...list.slice(1, PER_CELL));
}
rest.sort((a, b) => b.links - a.links || b.ele - a.ele);
const rows = [...firsts, ...rest.slice(0, Math.max(0, MAX_ROWS - firsts.length))].map((p) => [
  p.name,
  Math.round(p.lat * 1e4) / 1e4,
  Math.round(p.lon * 1e4) / 1e4,
  Math.round(p.ele),
]);
rows.sort((a, b) => a[1] - b[1] || a[2] - b[2]);

const out = JSON.stringify({ fields: ['name', 'lat', 'lon', 'ele'], source: 'Wikidata (CC0)', rows });
await writeFile(new URL('../assets/peaks-major.json', import.meta.url), out + '\n');
console.log(`${rows.length} peaks of ${byItem.size}, ${(out.length / 1024).toFixed(0)} KB`);
