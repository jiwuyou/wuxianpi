# OpenHouse Desktop runtimes

Build the production Vite Web UI and the independent WuxianPi Node runtime,
then create two complete runtime directories:

```text
npm run desktop:runtime -- --output release/desktop-runtime
```

The output contains `wuxianpi-normal` and `wuxianpi-repair`. Each contains its
own `runtime` (compiled `runtime/wuxianpi-node` plus production dependencies)
and `web` (compiled `apps/web`) directory. They keep separate agent
directories, ports, sessions and profile state when launched by OpenHouse
Desktop.

The root-level legacy Next.js application is not part of this build.
