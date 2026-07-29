# Release Output

Generated release files belong in `release/dist/` and are not source inputs.
Run `packaging/termux/build-release.sh` after the Web, Runtime, and base staging
directories are ready.

`runtime-manifest.json` is the Android Host entry point. Artifact URLs are
relative to the manifest URL by default, so a release can be served directly
from one directory.

