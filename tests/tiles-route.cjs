// Answers the app's place-name map tiles (OpenFreeMap) from tests/fixtures/ofm instead of the
// live server, so browser checks never depend on it. The fixture tiles are real tiles around
// Marbella cut down to the place, mountain_peak and aerodrome_label layers, plus three zoom-14
// tiles holding a few real points of interest in and by Marbella's old town and the hotels on
// the seafront west of it (poi layer); any
// other tile is empty. Options: empty (every tile empty), status (answer every request with it), delay (ms
// before answering). Returns the list of paths asked for, which grows as requests arrive.
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'fixtures', 'ofm');
const CORS = { 'access-control-allow-origin': '*' };

module.exports = async function routeTiles(target, { empty = false, status = 200, delay = 0 } = {}) {
  const asked = [];
  await target.route(/tiles\.openfreemap\.org/, async (r) => {
    const { pathname } = new URL(r.request().url());
    asked.push(pathname);
    if (delay) await new Promise((ok) => setTimeout(ok, delay));
    if (status !== 200) return r.fulfill({ status, headers: CORS, body: 'busy' }).catch(() => {});
    if (pathname === '/planet')
      return r.fulfill({ headers: CORS, contentType: 'application/json', body: fs.readFileSync(path.join(DIR, 'planet.json')) }).catch(() => {});
    const m = /\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(pathname);
    const file = m && path.join(DIR, m[1], m[2], `${m[3]}.pbf`);
    const body = !empty && file && fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
    return r.fulfill({ headers: CORS, contentType: 'application/x-protobuf', body }).catch(() => {});
  });
  return asked;
};
