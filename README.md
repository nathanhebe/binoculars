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
  of the earth are left out (Settings → *Show hidden places* greys them in).
- Tap a label for its distance, height and links to Wikipedia and Google Maps.
- **1× – 8×** zooms the picture; pinch works too.
- If labels sit a little off the real thing, tap **Align**, drag until the dotted skyline lies on
  the real one, then **Done**. The correction is remembered.
- On a balcony or tower, raise *Your height above the ground* in Settings.
- No phone? **Try it from Marbella** shows the demo; drag or use the arrow keys to look around.

## How it works

A static web app with no build step. On start it loads, for 150 km around you:

- elevation tiles (Mapzen Terrarium on AWS) to trace the skyline and test each place's line of
  sight, with earth curvature and standard refraction;
- place names from OpenStreetMap through the public Overpass API, in four parts that stream in
  as they arrive (about three minutes when the servers are busy) and, once all four have loaded,
  are saved on the phone for 30 days and reused while you stay within 2 km of where they loaded;
- towns and cities bundled with the app (`assets/places-major.json`, from Natural Earth's
  populated places), shown in seconds while OpenStreetMap answers; rebuild it with
  `node tools/build-places.mjs`;
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
`tests/height.e2e.cjs`, `tests/loading.e2e.cjs`) need Playwright; see the top of each file.

Data © OpenStreetMap contributors; terrain from Mapzen / AWS Terrain Tiles; borders from Natural
Earth.
