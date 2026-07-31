# WuxianPi Hub HTTP API v1

Base URL:

```text
https://wuxianpihub.webefficacy.com/api/v1
```

All JSON responses use UTF-8. IDs placed in URL segments are percent-encoded.
Successful list responses may include an opaque `nextCursor`. Errors use:

```json
{
  "error": {
    "code": "release_not_found",
    "message": "The requested release does not exist."
  }
}
```

The frozen API separates public discovery, publisher submission, and
administrative release decisions. Publishing a Release never changes an
existing Release record.

## Public API

### `GET /packages`

Query parameters:

| Name | Meaning |
| --- | --- |
| `q` | Full-text search |
| `category` | One frozen Package category |
| `contributionType` | One frozen contribution type |
| `cursor` | Opaque pagination cursor |
| `limit` | Page size, `1..100` |

Response:

```json
{
  "packages": [
    {
      "id": "io.wuxianpi.cloudflare-operations",
      "name": "Cloudflare Operations",
      "summary": "Operate Cloudflare through MCP with guided workflows.",
      "categories": ["capability", "skill", "solution"],
      "latestReleaseId": "rel_01JCFOPS",
      "updatedAt": "2026-07-31T12:00:00Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /packages/{packageId}`

Response:

```json
{
  "package": {
    "id": "io.wuxianpi.cloudflare-operations",
    "name": "Cloudflare Operations",
    "summary": "Operate Cloudflare through MCP with guided workflows.",
    "description": "A composite Package for Cloudflare operations.",
    "license": "MIT",
    "categories": [
      "assistant",
      "capability",
      "skill",
      "interface",
      "knowledge-experience",
      "solution"
    ],
    "publisher": {
      "id": "pub_example",
      "name": "Example Publisher",
      "profileUrl": "https://wuxianpihub.webefficacy.com/publishers/pub_example"
    },
    "links": [
      {
        "id": "source",
        "kind": "source",
        "label": "Source",
        "url": "https://github.com/example/wuxianpi-cloudflare-operations",
        "source": "manifest"
      },
      {
        "id": "support",
        "kind": "support",
        "label": "Issues",
        "url": "https://github.com/example/wuxianpi-cloudflare-operations/issues",
        "source": "publisher"
      }
    ],
    "screenshots": [
      {
        "id": "cloudflare-result",
        "alt": "Cloudflare operation result rendered in WuxianPi",
        "mediaType": "image/webp",
        "width": 1280,
        "height": 720,
        "sha256": "6411c45fcd8196dfb2b9cd7bb481b5879833fe4dcf67c48e86f88a1a2a1f3119",
        "source": "publisher",
        "downloadSources": [
          {
            "kind": "github",
            "url": "https://raw.githubusercontent.com/example/wuxianpi-cloudflare-operations/4e9f8c18973e30c8a0ed896a78bd88e8803f84e8/media/result.webp",
            "priority": 100
          },
          {
            "kind": "mirror",
            "url": "https://downloads.example.net/cloudflare-operations/result.webp",
            "priority": 80
          }
        ]
      }
    ],
    "contributionTypes": [
      "pi.skill",
      "mcp.server",
      "wuxianpi.webExtension",
      "wuxianpi.renderer",
      "wuxianpi.assistantTemplate",
      "wuxianpi.context",
      "wuxianpi.experience"
    ],
    "latestRelease": {
      "releaseId": "rel_01JCFOPS",
      "version": "1.0.0",
      "approvedCommit": "4e9f8c18973e30c8a0ed896a78bd88e8803f84e8",
      "publishedAt": "2026-07-31T12:00:00Z",
      "status": "approved"
    },
    "review": {
      "status": "approved",
      "reviewedAt": "2026-07-31T11:58:00Z"
    },
    "createdAt": "2026-07-31T11:00:00Z",
    "updatedAt": "2026-07-31T12:00:00Z"
  }
}
```

`links[].kind` is one of `homepage`, `source`, `documentation`, `support`, or
`license`. `links[].source` and `screenshots[].source` are one of `manifest`,
`publisher`, or `hub` and state who declared the metadata. They are not download
hosts. Screenshot bytes are acquired from `downloadSources`, whose `kind` is
`github` or `mirror`; clients verify `sha256` before display or caching.

`latestRelease` is `null` when the Package has no approved, non-revoked Release.
All arrays are present and use `[]` when empty. `license`, `description`, and
`publisher.profileUrl` are `null` when absent rather than being omitted.

### `GET /packages/{packageId}/releases`

Query parameters are `cursor` and `limit`. Releases are returned newest first.

Response:

```json
{
  "packageId": "io.wuxianpi.cloudflare-operations",
  "releases": [
    {
      "releaseId": "rel_01JCFOPS",
      "version": "1.0.0",
      "approvedCommit": "4e9f8c18973e30c8a0ed896a78bd88e8803f84e8",
      "submittedRef": "v1.0.0",
      "manifest": {
        "path": "wuxianpi-package.json",
        "sha256": "531d311391c0e16751233ccddceb24617661000e2e6c4b7d9dd0ae9eee877826"
      },
      "contributionTypes": [
        "pi.skill",
        "mcp.server",
        "wuxianpi.webExtension",
        "wuxianpi.renderer",
        "wuxianpi.assistantTemplate",
        "wuxianpi.context",
        "wuxianpi.experience"
      ],
      "verification": {
        "status": "passed",
        "verifiedAt": "2026-07-31T11:55:00Z",
        "checks": ["commit", "manifest-schema", "paths", "references"]
      },
      "status": "approved",
      "publishedAt": "2026-07-31T12:00:00Z",
      "revocation": null,
      "installPlanUrl": "/api/v1/packages/io.wuxianpi.cloudflare-operations/install-plan?releaseId=rel_01JCFOPS"
    },
    {
      "releaseId": "rel_01JCEARLIER",
      "version": "0.9.0",
      "approvedCommit": "208e3cb5a69169f569293e7295050210c43c8840",
      "submittedRef": "v0.9.0",
      "manifest": {
        "path": "wuxianpi-package.json",
        "sha256": "1f4049f6dfcdf164f1503e5f4194e5a2b80826391838167b862ced8bb9a1ee5f"
      },
      "contributionTypes": ["pi.skill", "mcp.server"],
      "verification": {
        "status": "passed",
        "verifiedAt": "2026-07-20T09:55:00Z",
        "checks": ["commit", "manifest-schema", "paths", "references"]
      },
      "status": "revoked",
      "publishedAt": "2026-07-20T10:00:00Z",
      "revocation": {
        "reason": "The upstream OAuth endpoint changed incompatibly.",
        "revokedAt": "2026-07-25T08:00:00Z"
      },
      "installPlanUrl": "/api/v1/packages/io.wuxianpi.cloudflare-operations/install-plan?releaseId=rel_01JCEARLIER"
    }
  ],
  "nextCursor": null
}
```

`status` is `approved` or `revoked`. `revocation` is required and is either
`null` or the shown object. Revoked Releases remain visible so installed devices
can explain their state, but their install-plan endpoint rejects normal new
installs with `410 release_revoked`.

### `GET /packages/{packageId}/install-plan`

Returns the latest compatible, approved, non-revoked Release. Optional query
parameters:

- `releaseId`: request a particular immutable Release.
- `hostCapability`: repeatable `id@contractVersion` capability advertised by
  the client.

If no compatible Release exists, the Hub returns `409 incompatible_host`.

The install-plan response is:

```json
{
  "schemaVersion": 1,
  "packageId": "io.wuxianpi.cloudflare-operations",
  "releaseId": "rel_01JCFOPS",
  "version": "1.0.0",
  "approvedCommit": "4e9f8c18973e30c8a0ed896a78bd88e8803f84e8",
  "manifestPath": "wuxianpi-package.json",
  "manifestDigest": "531d311391c0e16751233ccddceb24617661000e2e6c4b7d9dd0ae9eee877826",
  "gitSources": [
    {
      "kind": "github",
      "url": "https://github.com/example/wuxianpi-cloudflare-operations.git",
      "priority": 100
    },
    {
      "kind": "mirror",
      "url": "https://gitcode.com/example/wuxianpi-cloudflare-operations.git",
      "priority": 80
    }
  ],
  "artifacts": [],
  "compatibility": {
    "hostCapabilities": [
      { "id": "wuxianpi.package", "contractVersion": 1 }
    ],
    "packages": []
  },
  "verification": {
    "status": "passed",
    "verifiedAt": "2026-07-31T11:55:00Z",
    "checks": ["commit", "manifest-schema", "paths", "references"]
  },
  "revoked": false
}
```

### Install-plan invariants

- `approvedCommit` is a full immutable Git commit and is the only source code
  revision the client may install.
- The first Git source is normally the original GitHub repository. Remaining
  sources are true Git mirrors containing the same object IDs.
- A failed source never permits fallback to its latest branch or tag.
- `manifestPath` identifies the Package manifest inside the approved commit.
  `manifestDigest` is the lower-case SHA-256 of those exact bytes.
- Every artifact repeats the Package manifest's immutable `sha256`, size,
  platform and candidate source list.
- `verification.status` must be `passed` before a normal client installs it.

## Publisher API

Publisher routes require a publisher access token. A publisher can only mutate
submissions owned by that publisher. Published Releases are immutable.

### `POST /publisher/submissions`

```json
{
  "repositoryUrl": "https://github.com/example/wuxianpi-cloudflare-operations.git",
  "ref": "v1.0.0",
  "mirrorUrls": [
    "https://gitcode.com/example/wuxianpi-cloudflare-operations.git"
  ],
  "metadata": {
    "links": [
      {
        "id": "support",
        "kind": "support",
        "label": "Issues",
        "url": "https://github.com/example/wuxianpi-cloudflare-operations/issues",
        "source": "publisher"
      }
    ],
    "screenshots": [
      {
        "id": "cloudflare-result",
        "alt": "Cloudflare operation result rendered in WuxianPi",
        "mediaType": "image/webp",
        "width": 1280,
        "height": 720,
        "sha256": "6411c45fcd8196dfb2b9cd7bb481b5879833fe4dcf67c48e86f88a1a2a1f3119",
        "source": "publisher",
        "downloadSources": [
          {
            "kind": "github",
            "url": "https://raw.githubusercontent.com/example/wuxianpi-cloudflare-operations/4e9f8c18973e30c8a0ed896a78bd88e8803f84e8/media/result.webp",
            "priority": 100
          },
          {
            "kind": "mirror",
            "url": "https://downloads.example.net/cloudflare-operations/result.webp",
            "priority": 80
          }
        ]
      }
    ]
  }
}
```

The Hub resolves `ref` to a full commit immediately and records both values.
Mirror acceptance requires fetching the same commit from each mirror.
`metadata.links` and `metadata.screenshots` are the concrete publisher write
path for Package presentation metadata. Both arrays are required inside
`metadata`, may be empty, and replace no previously published Release.

Response: `202 Accepted`

```json
{
  "submission": {
    "submissionId": "sub_01JCFOPS",
    "repositoryUrl": "https://github.com/example/wuxianpi-cloudflare-operations.git",
    "requestedRef": "v1.0.0",
    "resolvedCommit": "4e9f8c18973e30c8a0ed896a78bd88e8803f84e8",
    "mirrorUrls": [
      "https://gitcode.com/example/wuxianpi-cloudflare-operations.git"
    ],
    "metadata": {
      "links": [
        {
          "id": "support",
          "kind": "support",
          "label": "Issues",
          "url": "https://github.com/example/wuxianpi-cloudflare-operations/issues",
          "source": "publisher"
        }
      ],
      "screenshots": [
        {
          "id": "cloudflare-result",
          "alt": "Cloudflare operation result rendered in WuxianPi",
          "mediaType": "image/webp",
          "width": 1280,
          "height": 720,
          "sha256": "6411c45fcd8196dfb2b9cd7bb481b5879833fe4dcf67c48e86f88a1a2a1f3119",
          "source": "publisher",
          "downloadSources": [
            {
              "kind": "github",
              "url": "https://raw.githubusercontent.com/example/wuxianpi-cloudflare-operations/4e9f8c18973e30c8a0ed896a78bd88e8803f84e8/media/result.webp",
              "priority": 100
            },
            {
              "kind": "mirror",
              "url": "https://downloads.example.net/cloudflare-operations/result.webp",
              "priority": 80
            }
          ]
        }
      ]
    },
    "status": "queued",
    "diagnostics": [],
    "createdAt": "2026-07-31T11:50:00Z",
    "updatedAt": "2026-07-31T11:50:00Z"
  }
}
```

Publisher metadata rules are frozen as follows:

- `links[].id` and `screenshots[].id` are unique within their arrays.
- Link `kind` is `homepage`, `source`, `documentation`, `support`, or
  `license`.
- Publisher writes MUST send `source: "publisher"`; the Hub rejects another
  value with `400 invalid_metadata_source`.
- Screenshot `mediaType` is `image/png`, `image/jpeg`, or `image/webp`.
- `width` and `height` are positive integers; `sha256` is 64 lower-case hex
  characters.
- Every screenshot has at least one `downloadSources` entry. Its `kind` is
  `github` or `mirror`, its URL is HTTPS, and `priority` is `0..1000`.
- The Hub verifies screenshot digest and media metadata during submission
  verification. It does not silently rewrite publisher URLs or attribution.

### `GET /publisher/submissions/{submissionId}`

Returns the same `submission` object as `POST`, including the stored metadata,
resolution, validation, review state, timestamps, and diagnostics.
States are:

```text
queued -> verifying -> awaiting_review -> approved
                     -> rejected
                     -> failed
```

### `PATCH /publisher/submissions/{submissionId}`

Updates publisher-controlled fields while a submission is `queued`, `failed`,
`rejected`, or `awaiting_review`. Published Release data is immutable.

Request:

```json
{
  "ref": "v1.0.1",
  "mirrorUrls": [
    "https://gitcode.com/example/wuxianpi-cloudflare-operations.git"
  ],
  "metadata": {
    "links": [],
    "screenshots": []
  }
}
```

All three fields are optional. When supplied, `mirrorUrls`, `metadata.links`,
and `metadata.screenshots` replace their stored arrays; omission preserves the
stored value. Changing `ref` clears `resolvedCommit` until the Hub resolves and
verifies the new ref. The response is `200 OK` with the complete `submission`
object shown above. An approved submission returns `409 immutable_submission`.

### `POST /publisher/submissions/{submissionId}/sync`

Creates a new submission from the repository's configured release ref. It does
not alter the old submission or published Release. The new submission copies
the current publisher metadata and source attribution unless the publisher later
changes it through `PATCH`. The response is the same complete `submission`
object as creation.

## Administrative API

Administrative routes require a Hub administrator token and create an audit
record.

### `POST /admin/submissions/{submissionId}/approve`

```json
{
  "notes": "Manifest and static contract checks passed."
}
```

Creates one immutable Release and returns its `releaseId`, Package ID, and
`approvedCommit`. Approval is rejected unless the resolved commit and required
verification checks are unchanged and passing.

### `POST /admin/submissions/{submissionId}/reject`

```json
{
  "reason": "Contribution paths escape the repository root."
}
```

### `POST /admin/releases/{releaseId}/revoke`

```json
{
  "reason": "The upstream artifact was removed."
}
```

Revocation prevents new normal installations. It does not rewrite or delete the
Release. Clients that already installed it can show the reason and choose a
different approved commit.

## Artifact entry in an install plan

```json
{
  "id": "io.example.package/runtime.arm64",
  "fileName": "runtime-arm64.tar.zst",
  "sha256": "a9eb5b86cfcf2e131c8eaa4b8905e551cff6633a9d885460a8f13ab6223f504e",
  "sizeBytes": 12432890,
  "archive": "tar.zst",
  "platforms": [{ "os": "android", "arch": "arm64" }],
  "sources": [
    {
      "kind": "github-release",
      "url": "https://github.com/example/package/releases/download/v1.0.0/runtime-arm64.tar.zst",
      "priority": 100
    },
    {
      "kind": "mirror",
      "url": "https://downloads.example.net/package/runtime-arm64.tar.zst",
      "priority": 80
    }
  ]
}
```

The client may reorder equal-policy sources using recent reachability, but it
must verify `sizeBytes` and `sha256` before unpacking.
