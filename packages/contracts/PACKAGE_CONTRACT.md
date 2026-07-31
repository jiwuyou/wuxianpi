# WuxianPi Composite Package Contract v1

This document is normative for `wuxianpi-package.json`. The JSON Schema in
`wuxianpi-package.schema.json` is the machine-readable form of the same
contract.

## 1. Distribution unit

The only installable unit is a **Composite Package**. Market categories are
discovery metadata; they do not create different installers or stores.

The frozen categories are:

```text
app
assistant
capability
skill
interface
knowledge-experience
solution
```

A Package can contribute any combination of:

```text
pi.extension
pi.skill
pi.prompt
pi.theme
mcp.server
wuxianpi.webExtension
wuxianpi.renderer
wuxianpi.assistantTemplate
wuxianpi.context
wuxianpi.experience
openhouse.app
service-manager.service
artifact
```

The manifest MUST be named `wuxianpi-package.json` and MUST be located at the
repository root selected by the Hub submission.

## 2. Package and release identity

`id` is the stable Package identity. It uses a lower-case, reverse-domain-style
namespace such as `io.wuxianpi.cloudflare-operations`. Renaming it creates a
different Package.

`version` is a human-facing label only. WuxianPi MUST NOT solve dependencies or
select code using a SemVer range.

A published release is identified by:

```text
packageId + approvedCommit
```

The Hub resolves the submitted ref to a full commit, validates that exact
commit, and publishes it as `approvedCommit`. A published Release is immutable.
Moving a branch or tag cannot change it. A correction is a new Release.

The author manifest does not contain `approvedCommit` or Git source URLs. Those
are Hub release metadata, because the manifest is itself stored inside the Git
commit being approved.

## 3. Source contract

An install plan lists one GitHub source and may list true Git mirrors. A true
mirror preserves Git objects, so the same full commit ID can be fetched from
every listed source.

The client MUST:

1. Fetch the exact `approvedCommit` from a candidate source.
2. Verify that the fetched object ID equals `approvedCommit`.
3. Try another source if the object is absent or verification fails.
4. Never substitute a source's default branch, tag, or latest commit.

The market is an index and verification authority. GitHub and mirrors carry the
normal source download traffic.

## 4. Requirements

`requires.hostCapabilities` contains exact host contract pairs:

```json
{ "id": "wuxianpi.web-extension", "contractVersion": 1 }
```

The host MUST advertise that exact contract version before activation.

`requires.packages` contains exact Package dependencies. Each dependency names
an immutable `approvedCommit`; version ranges are forbidden. The optional
`requiredContributionIds` list states which logical contributions are actually
needed. The Package Manager installs dependencies before the dependent Package
and rejects dependency cycles.

## 5. Contributions and logical IDs

Every contribution has a globally stable logical ID. It MUST begin with the
containing Package ID followed by `/`:

```text
io.wuxianpi.cloudflare-operations/skill.operations
```

The schema validates ID syntax. The Hub and local validator additionally check
the Package-prefix rule, uniqueness within the manifest, referenced files, and
cross-references to artifacts and bindings.

Logical IDs, rather than filesystem paths, are stored in assistant bindings and
the active contribution registry. A Package and its dependencies are installed
once. Binding the same contribution to several assistants MUST NOT copy its
source tree or dependency directory.

### Contribution mapping

| Type | Required payload | Runtime owner |
| --- | --- | --- |
| `pi.extension` | `path` | Pi Resource Loader |
| `pi.skill` | `path` | Pi Resource Loader |
| `pi.prompt` | `path` | Pi Resource Loader |
| `pi.theme` | `path` | Pi Resource Loader |
| `mcp.server` | `config` | WuxianPi MCP adapter |
| `wuxianpi.webExtension` | `manifest` | WuxianPi Web extension host |
| `wuxianpi.renderer` | `manifest`, `contentTypes` | WuxianPi message renderer host |
| `wuxianpi.assistantTemplate` | `manifest`, `kind`, `defaultBindings` | Assistant manager |
| `wuxianpi.context` | `path`, `format` | Assistant context loader |
| `wuxianpi.experience` | `experienceSpaceId`, `basePath`, `mainstream`, `updatePolicy` | Experience loader |
| `openhouse.app` | `manifest` | OpenHouse registry |
| `service-manager.service` | `manifest` | service-manager bridge |
| `artifact` | `artifactId`, `purpose` | Artifact manager |

Package paths are forward-slash relative paths. Absolute paths, backslashes,
and parent traversal are forbidden.

## 6. Assistant bindings

An assistant template can declare `defaultBindings`. Installing a template does
not silently mutate existing assistants. When a user creates an assistant from
the template, WuxianPi copies the logical IDs into the new assistant's local
binding record.

The local binding shape is:

```json
{
  "assistantId": "cloudflare-operator",
  "enabledContributionIds": [
    "io.wuxianpi.cloudflare-operations/skill.operations",
    "io.wuxianpi.cloudflare-operations/mcp.cloudflare"
  ],
  "experienceSpaces": {
    "io.wuxianpi.cloudflare-operations/experience.operations": "cloudflare.operations.shared"
  }
}
```

Enabling and disabling a contribution only changes this registry. It does not
move Package files into `.pi` directories and does not duplicate dependencies.
New sessions consume the updated registry. Existing sessions reload only where
their contribution contract explicitly supports reload.

### Experience spaces and updates

An experience contribution has a default `experienceSpaceId`. Two assistants
that bind it to the same space share their locally verified corrections. An
assistant can bind the contribution to a different space to isolate its
experience. Conversation transcripts and private memory never become Package or
mainstream experience data.

`basePath` is the Package's immutable base experience. `mainstream` identifies
an independently updateable Git or HTTPS JSON source. Local corrections live in
runtime data outside Git, keyed by `experienceSpaceId`.

The effective priority is frozen as:

```text
local verified correction
> current mainstream experience
> Package base experience
```

Updating mainstream experience is a three-way merge using the previously
applied mainstream revision, the newly fetched mainstream revision, and the
local correction overlay. Local corrections are preserved and remain highest
priority. A conflict is retained for the local AI or user to resolve; it must
not silently replace the local correction.

## 7. MCP contribution files

An `mcp.server` contribution points to one normalized Runtime MCP server JSON
object. The child file is validated against `$defs.mcpServerConfig` in the
Package Schema. Supported fields are:

```text
id, name, transport, command, args, cwd, url,
env, envSecretRefs, headers, headerSecretRefs,
timeoutMs, lifecycle, auth, enabled
```

`stdio` requires `command` and forbids `url`. `streamable-http` requires an HTTP
or HTTPS `url` and forbids `command`, `args`, and `cwd`. Authentication is the
Runtime field:

```json
{ "auth": "oauth" }
```

Its allowed values are `"oauth"`, `"bearer"`, and `false`. Secret values are
not embedded in Package files; `envSecretRefs` and `headerSecretRefs` identify
the local secret entries.

## 8. Build modes

`build.mode` has exactly three values:

- `none`: resources are ready to load. An optional `test` command may still be
  declared.
- `local`: the device runs the declared `build` command in an isolated
  candidate checkout. `install` and `test` are optional.
- `artifact`: the device downloads every declared `artifactId`; an optional
  `test` command verifies the unpacked candidate.

Build and test commands run only against the candidate source/revision, never
against the active runtime directory. A failed command leaves the current
active revision unchanged and preserves its log.

The Hub performs manifest and path validation for arbitrary public Packages. It
does not need to execute untrusted Package commands. Build/test execution is a
publisher verification policy and a local activation decision.

## 9. Artifacts

An artifact has one immutable SHA-256 digest and one or more candidate sources.
Normal sources are GitHub Releases followed by external mirrors. The client may
choose sources using priority and recent availability, but it MUST verify the
digest before unpacking or activation.

Large binaries, archives, models, and generated Web assets SHOULD be artifacts
instead of Git objects. Credentials, conversations, memories, and mutable
runtime data MUST NOT be artifacts.

## 10. Local Git and update semantics

The Package source is a long-lived Git workspace. User or AI changes are local
commits. Updating uses three explicit points:

```text
baseCommit    last installed official approved commit
localHead     current local commit, including local changes
targetCommit  new official approved commit
```

The candidate is produced by a real three-way merge of the official change
`baseCommit..targetCommit` into `localHead`. No-local-change updates may use the
target commit directly. Conflicts remain in the candidate workspace for an AI
or user to resolve. The active revision is not replaced until merge, artifact,
build, test, contract, and activation checks pass.

Package code MUST NOT run `git pull` against its own active directory. Runtime
data lives outside Git and is never overwritten by an update.

## 11. Activation and conflicts

The local Package Manager owns install state and the active contribution
registry. Pi resource discovery, MCP, Web UI, OpenHouse, and service-manager are
adapters of that registry; Git does not activate anything.

Only one active implementation of a Package ID and logical contribution ID is
allowed. Activation is rejected before any registry change when IDs conflict or
required host contracts are missing.

Renderer messages MUST retain structured data, schema version, and fallback
text. A renderer failure falls back to the host renderer and must not make the
conversation or Package controls unavailable.

## 12. Self-related operation registration

This is deliberately **not** a journal for every market operation.

Before an operation modifies the currently executing control path, it writes a
small maintenance handoff record. Covered targets include the active WuxianPi
Web UI, current renderer, Package Loader, Runtime, `pi-agent`, current market
control UI, or service-manager control files.

The record contains:

```text
actor
intent
targets
before commit/config
planned actions
command and log locations
recovery hint
status
```

It is stored independently of the potentially affected WuxianPi UI:

```text
~/.smallphoneai/maintenance/pending-self-operation.json
~/.smallphoneai/maintenance/self-operations.jsonl
```

Successful completion marks the record complete. If the operation breaks its
own interface or runtime, the native maintenance assistant reads the pending
record and decides whether to continue, repair, disable, or revert it. Ordinary
Package installs, updates, enables, and disables only use normal operation logs
and MUST NOT create a self-operation record unless they affect the current
control path.

## 13. Validation beyond JSON Schema

Schema validation is necessary but not sufficient. Hub and local validators
also enforce:

- contribution and artifact IDs are unique and Package-prefixed;
- every relative path exists inside the approved commit;
- every `defaultBindings` and `artifactId` reference resolves;
- artifact build IDs identify declared artifacts;
- exact Package dependencies do not form a cycle;
- MCP, service, renderer, and other contribution-specific manifests validate;
- source commits and artifact digests match the install plan.
