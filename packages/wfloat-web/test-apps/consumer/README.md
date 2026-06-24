# Wfloat Web consumer fixture

This app is a minimal browser consumer fixture for `@wfloat/wfloat-web`.

It should behave like a user app:

- The package under test is installed from a packed tarball by
  `scripts/package-browser-smoke.mjs`.
- The app imports `@wfloat/wfloat-web` through Vite.
- The app should not import from the local package source tree.

Keep this fixture boring. It exists to catch packaging, browser bundling, and
worker/runtime packaging regressions before publishing.
