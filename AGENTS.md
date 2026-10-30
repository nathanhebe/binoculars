# binoculars

A static phone web app: no build step, plain ES modules, served from GitHub Pages.

## Checks

- Unit tests: `node --test tests/*.test.mjs`
- Browser tests: serve the repository root with `python3 -m http.server 8765`, then run
  `node tests/<name>.e2e.cjs` for each file in `tests/` ending `.e2e.cjs`
  (`BASE_URL` overrides the address)

## Merge authority

Agent autonomous merge: allowed
