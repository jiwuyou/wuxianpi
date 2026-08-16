# WuxianPi Hub

Public catalog, publisher submission service, immutable Release registry, and
fallback Support Issue tracker for WuxianPi Composite Packages.

```bash
npm ci
npm run dev
```

Configuration:

```text
HUB_HOST                 Listen host, default 127.0.0.1
HUB_PORT                 Listen port, default 20878
HUB_DB_PATH              SQLite file, default ./data/hub.sqlite
HUB_ASSET_DIR            Verified screenshot cache, default ./data/assets
HUB_PUBLIC_URL           Public origin used in publisher links
HUB_ADMIN_TOKEN          Bearer token for administrative routes
HUB_PUBLISHER_TOKENS     JSON object keyed by publisher ID
HUB_GITHUB_CLIENT_ID     GitHub OAuth App client ID for Device Flow (optional)
HUB_SESSION_DAYS         Hub session lifetime, default 30 days
HUB_PACKAGE_SCHEMA       Path to wuxianpi-package.schema.json
HUB_PUBLIC_DIR           Static marketplace assets
HUB_VERIFY_MAX_BYTES     Maximum downloaded verification object size
HUB_MIRROR_SERVICE_URL   Optional OpenHouse Git Mirror service origin
HUB_MIRROR_SERVICE_TOKEN Bearer token shared with the mirror service
```

`HUB_PUBLISHER_TOKENS` accepts either token strings or records:

```json
{
  "pub_example": {
    "token": "publisher-secret",
    "name": "Example Publisher",
    "profileUrl": "https://example.com"
  }
}
```

The Hub performs static verification only. It never runs commands declared by
third-party Packages. Support Issues use client-generated reporter tokens; the
Hub does not store GitHub credentials or submit GitHub Issues on a user's behalf.

Build the container with `apps/hub` as the context:

```bash
docker build -t wuxianpi-hub apps/hub
```

`contracts/wuxianpi-package.schema.json` is the frozen v1 Schema shipped with
the Hub image. Contract changes must update it together with the repository's
canonical Schema.
