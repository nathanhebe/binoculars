# binoculars

A static phone web app: no build step, plain ES modules, served from GitHub Pages.

## Checks

- Unit tests: `node --test tests/*.test.mjs`
- Browser tests need Playwright with Chromium installed outside this repository. Serve the
  repository root with `python3 -m http.server 8765`, then run
  `NODE_PATH=<dir with playwright installed>/node_modules node tests/<name>.e2e.cjs <screenshot dir outside the repo>`
  for each file in `tests/` ending `.e2e.cjs` (`BASE_URL` overrides the address)

## Merge authority

The line below lets Claude merge pull requests here without Nathan's approval for each one. The
merge check does not look at who wrote a pull request, so the line covers pull requests from
forks too; Nathan accepted that. Codex's own rules do not use the line: Codex still needs
Nathan's approval for each pull request.

Agent autonomous merge: allowed
