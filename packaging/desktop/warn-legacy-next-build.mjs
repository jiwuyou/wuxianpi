console.warn(`
WARNING: the root Next.js build is deprecated.
It only builds the legacy root web application and is not a production
WuxianPi runtime or an OpenHouse Desktop distribution.

Use the production build instead:
  npm run desktop:runtime -- --output release/desktop-runtime

That command builds apps/web and runtime/wuxianpi-node, then creates the
normal and repair runtime directories used by OpenHouse Desktop.
`);
