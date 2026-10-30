# binoculars

A static phone web app: no build step, plain ES modules, served from GitHub Pages.

## Checks

- Unit tests: `node --test tests/*.test.mjs`
- Browser tests need Playwright with Chromium installed outside this repository. Serve the
  repository root with `python3 -m http.server 8765`, then run
  `NODE_PATH=<dir with playwright installed>/node_modules node tests/<name>.e2e.cjs <screenshot dir outside the repo>`
  for each file in `tests/` ending `.e2e.cjs` (`BASE_URL` overrides the address)

## Merge authority

The line below lets Claude merge its own pull requests here once its review and proofs pass.
Codex's own rules do not use it: Codex still needs Nathan's approval for each pull request.

Agent autonomous merge: allowed
