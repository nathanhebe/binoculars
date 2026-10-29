# Binoculars

Point your phone at a view and see which towns, peaks, landmarks and countries you're looking at,
allowing for hills and the curve of the earth. Standing on the Costa del Sol looking out to sea?
It tells you whether that is Gibraltar or Morocco.

**Open it:** https://nathanhebe.github.io/binoculars/ on your phone. Add it to your home screen for
full screen.

## Using it

- **Start** asks for your camera, motion sensors and location. Hold the phone upright, pointing at
  the view.
- The banner at the top names the continent and country you're pointing at, and a country hidden
  beyond the horizon. Labels show places you can actually see; things hidden by hills or the curve
  of the earth are left out (Settings → *Also show places hidden behind hills* greys them in).
  Zoomed in to 2× or more, places past the curve of the earth are greyed in anyway, tagged
  "Beyond horizon" — looking across the sea to Morocco, that is what there is to name — while
  places behind hills still follow the setting. When nothing is labelled the way you face, a note
  under the banner says so and how many places are below the horizon or behind hills, with
  **Show** to grey them in.
- Point the centre ring at a place and it locks on, with the place named in a card underneath.
  Tap the card, or any label, for its distance, height and links to Wikipedia and Google Maps.
- The round button in the bottom-right corner zooms: each tap steps 1×, 2×, 4×, 8× and back to
  1×. Pinch works too.
- If labels sit a little off the real thing, tap **Fix labels**, drag until the dotted skyline lies on
  the real one, then **Done**. The correction is remembered.
- The chips above the bottom bar — **Food**, **Shops**, **Travel**, **Sights** — add those places
  within a few km of you (4 km at 1×, 8 km from 2× up), each with a coloured dot and
  its type ("Restaurant · 350 m"). A place a chip asks for is greyed in even when a hill hides it,
  so you can see which way it is. Zooming alone fetches none of these. Chips start off and are remembered. When a chip is on and none of
  its places is in the picture, a note says so ("No food places this way"). Tap one of these places for its
  opening hours and website, when OpenStreetMap has them.
- On a balcony or tower, raise *Your height above the ground* in Settings.
- No phone? **Try the demo: Spain → Africa** looks from Marbella across to Morocco; drag or use
  the arrow keys to look around.

## How it works

A static web app with no build step. On start it loads, for 150 km around you:

- elevation tiles (Mapzen Terrarium on AWS) to trace the skyline and test each place's line of
  sight, with earth curvature and standard refraction;
- place names (towns, villages, peaks, airports) from OpenStreetMap through OpenFreeMap's
  vector map tiles: 25 or so tiles, the one under you first, four at a time, each shown as it
  arrives, with "Finding more names… n/N" until they are all in (`js/tiles.mjs`); each tile's
  names are saved on the phone for 30 days, so a second look from nearby asks only for tiles it
  has not seen;
- restaurants, shops, stations and sights from the same map tiles' most detailed level (zoom 14,
  about 2 km a tile; `js/pois.mjs`), only once a chip is on, out to 8 km, and only the tiles
  in the direction you face, nearest first, a moment after you stop turning; saved like the
  place names for 30 days. The tiles hold no opening hours or websites, so tapping one asks the
  Overpass API for that one place's tags; a website is linked only when it is an http(s) address;
- lighthouses, capes, castles, marinas and viewpoints, which the map tiles leave out, from the
  public Overpass API in two parts; they appear when it answers and are saved on the phone for
  30 days while you stay within 2 km, and nothing waits for them if it is busy;
- towns and cities bundled with the app (`assets/places-major.json`, from Natural Earth's
  populated places), shown in seconds while the map tiles load; rebuild it with
  `node tools/build-places.mjs`;
- about 7,800 well-known mountains bundled the same way (`assets/peaks-major.json`, from
  Wikidata: the best known in each half-degree square, judged by how many Wikipedias have an
  article), so ranges such as the Alps, the Sierra Nevada and the Rif are named with no network;
  rebuild it with `node tools/build-peaks.mjs`;
- country borders from Natural Earth (`assets/countries.json`).

Compass: `webkitCompassHeading` on iPhone, absolute device orientation on Android.

## Developing

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765/?lat=36.5068&lon=-4.886&heading=215&nocam=1&autostart=1`
(`nocam` skips the camera, `heading`/`pitch` set the view).

Tests:

```bash
node --test tests/*.test.mjs
```

The browser checks (`tests/browser.e2e.cjs`, `tests/move.e2e.cjs`, `tests/demo.e2e.cjs`,
`tests/height.e2e.cjs`, `tests/loading.e2e.cjs`, `tests/speed.e2e.cjs`, `tests/poi.e2e.cjs`,
`tests/zoom.e2e.cjs`) need Playwright; see the top of each file.

Data © OpenStreetMap contributors; map tiles by OpenFreeMap © OpenMapTiles; terrain from Mapzen /
AWS Terrain Tiles; borders from Natural
Earth; mountain names from Wikidata (CC0).
