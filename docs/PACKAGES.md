# WuxianPi Packages and Market

## Product boundary

WuxianPi Hub is the public catalog, submission, review, and immutable release
index. The device remains the authority for installation, local modification,
assistant bindings, activation, and runtime data.

```text
Author GitHub / Release
        |
        v
WuxianPi Hub: metadata, review, approved commit, install plan
        |
        v
Local Package Manager: fetch, merge, build, test, bind, activate
        |
        +--> Pi Resource Loader
        +--> MCP adapter
        +--> WuxianPi Web extension host
        +--> OpenHouse
        +--> service-manager
```

The Hub normally does not proxy source or artifact bytes. Devices try the
original GitHub source first and then true Git mirrors from the install plan.
Large files use GitHub Releases and external mirrors.

## Market types

The market presents seven user-facing categories:

| Category | Typical contents |
| --- | --- |
| App | OpenHouse apps, Web apps, and background services |
| Assistant | Main-AI and functional-assistant templates |
| Capability | Tools, Pi extensions, MCP, and external integrations |
| Skill | Workflows and reusable operating knowledge |
| Interface | Pages, panels, renderers, and themes |
| Knowledge & Experience | Context, knowledge, and maintained experience feeds |
| Solution | A ready-to-use composition of several contribution types |

All categories use the same Composite Package manifest and installer. A single
Package may appear in several categories.

## Hub implementation

The Hub contains:

```text
Public catalog and search
Publisher submissions
Commit/ref resolver
Static verification worker
Review and revocation controls
Immutable Release registry
Install-plan API
Source availability metadata
```

Its persistent records include publishers, packages, submissions, releases,
Git sources, artifacts, contribution summaries, verification reports, review
decisions, and revocations.

The Hub freezes the submitted Git object ID. A tag is only an author-friendly
input. Mirrors are accepted only when the same commit can be fetched. The Hub
does not modify author repositories or create market-specific commits.

Public API details are frozen in
`packages/contracts/HUB_API.md`. Package authoring is frozen in
`packages/contracts/PACKAGE_CONTRACT.md` and
`packages/contracts/wuxianpi-package.schema.json`.

## Local storage

A suitable local layout is:

```text
~/.wuxianpi/package-manager/
├── packages/<package-id>/
│   ├── source/             # long-lived Git workspace
│   ├── revisions/          # validated runtime revisions
│   ├── artifacts/          # digest-verified downloads
│   ├── data/               # mutable data and credentials
│   └── logs/
├── catalog-cache/
├── dependency-cache/
├── active-registry.json
└── state.json
```

Termux does not need user-visible symlinks. Runtime adapters resolve logical
contribution IDs to the active revision's physical path. Package files and
dependencies exist once even when several assistants use them.

## Local install flow

```text
Read install plan
-> acquire the exact approved commit from GitHub or a mirror
-> verify commit and manifest digest
-> validate manifest, paths, IDs, references, and host requirements
-> download and verify artifacts
-> build and test an isolated candidate when declared
-> create a runtime revision
-> register contributions
-> enable the selected global or assistant bindings
-> reload the relevant adapter or ask service-manager to start a service
```

The active revision is not the mutable source workspace. Downloading, merging,
building, and testing cannot partially overwrite the currently working code.

## Local update and merge

Local AI and user changes are real Git commits. The Package Manager records:

```text
baseCommit
localHead
targetCommit
```

It applies the official `baseCommit..targetCommit` change to `localHead` using a
three-way merge. A clean Package can advance directly to `targetCommit`.
Conflicts remain in the candidate source for the user or AI to resolve. Only a
fully validated candidate becomes active.

This approach intentionally reuses upstream work. It does not add compatibility
patches merely to preserve obsolete implementations, and it does not build a
SemVer dependency solver. Package dependencies name exact approved commits.

## Activation and assistant binding

The active registry maps logical contribution IDs to one Package and validated
revision. Assistant records contain only enabled logical IDs. They do not own
copies of Skills, extensions, MCP dependencies, or Web assets.

Pi resources are supplied to the Resource Loader as additional active paths.
MCP entries retain Package ownership and are included only for assistants that
enable them. Web contributions are discovered from the active registry instead
of scanning every installed directory. Background services are registered and
controlled through the existing service-manager API.

Experience contributions are also bound by logical ID. Their
`experienceSpaceId` determines whether two assistants share locally verified
corrections or keep them isolated. Runtime resolution always prefers local
verified corrections, then the current online mainstream experience, then the
Package base. Mainstream updates use a three-way merge and preserve the local
overlay.

Static ID conflicts and absent host capabilities fail before activation. One
Package ID and one logical contribution ID have only one active implementation.

## Artifact policy

Source, Skills, manifests, and mergeable text belong in Git. ARM binaries,
large archives, models, and generated bundles should use GitHub Releases or
external mirrors. Each artifact has a required SHA-256 digest and can list
several candidate download URLs.

The device does not need to compile native ARM software when a matching,
verified artifact exists. Pure Skill, context, and static interface Packages
require no build at all.

## Operations involving the current system

Most market operations use ordinary logs. A special maintenance record is
written only when an operation may break the interface or process performing
the operation itself, for example the active renderer, market UI, Package
Loader, Runtime, `pi-agent`, or service-manager control path.

The record states what was about to change, the previous commit/configuration,
planned actions, log locations, and a recovery hint. It is stored under
`~/.smallphoneai/maintenance/`, outside the potentially affected Web UI.

This is not a general automatic rollback state machine. If the operation breaks
WuxianPi, the independent native maintenance assistant reads the pending record,
inspects Git and service-manager, and chooses whether to complete, repair,
disable, or revert the change.

## First-release scope

The first complete release should include:

- GitHub submission and exact-commit approval;
- public search and Package detail pages;
- GitHub-first and true-mirror fallback download;
- manifest, path, reference, and artifact validation;
- local Git commits and three-way updates;
- isolated build/test and readable logs;
- contribution registry and assistant bindings;
- Pi Extension, Skill, Prompt, Theme, MCP, Web extension, renderer, assistant
  template, context, experience, OpenHouse app, service, and artifact
  contributions;
- service-manager integration for services;
- self-related operation handoff records.

The first release does not need Git hosting, SemVer solving, cloud storage for
private memories, automatic merge-conflict resolution, Rescue packaging, or
Android-native dynamic plugins.
