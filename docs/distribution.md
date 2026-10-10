# CLI Schema Distribution & Module Convention

This document specifies how `lmapi` tools publish their schema contracts and how client environments (such as LMScript and language SDKs) resolve, download, verify, and cache them locally.

For the core protocol governing server CLI processes and JSON schemas, see [`protocol.md`](protocol.md).

---

## 1. Overview & Distribution Model

In the `lmapi` architecture, command-line tools publish a machine-readable schema (`cli.schema.v1`) that defines their commands, parameters, types, and execution policies. 

To enable seamless automation and agent execution without manual tool installation:
1. Tool authors publish two authoritative schema documents at the root of their repository's default branch: `cli.schema.latest.json` and `cli.schema.dev.json`.
2. Clients import tools using a repository and channel specifier: `@<owner>/<repo>` or `@<owner>/<repo>#(latest|dev)`.
3. The client or SDK downloads the schema directly over HTTPS from GitHub raw content default branch (`HEAD`), verifies its structure and integrity, and stores it in a secure local cache.
4. Execution checks, dry-run preflights, and offline analysis validate against the cached schema document without requiring network calls.

---

## 2. Dual Schema Files & Release Workflow

Every published tool repository (e.g. `lmgit`, `lmgh`, `lmaws`) publishes two schema files at the root of its default branch:

```text
cli.schema.latest.json   # Contract of the last stable release
cli.schema.dev.json      # Current development contract (drift-checked)
```

The document inside both files declares `"schema": "cli.schema.v1"` (the invariant format specification version).

### Release Copy Workflow

1. **Development & Drift Prevention**:
   - As new features and operations are developed, `cli.schema.dev.json` is updated.
   - Tool repositories maintain an automated test (e.g. `tests/schema-file.test.ts`) ensuring `cli.schema.dev.json` is byte-for-byte identical to `bun src/cli.ts --schema`.
2. **Releasing a Tool Version**:
   - Releasing a wrapper consists of copying `cli.schema.dev.json` to `cli.schema.latest.json` in the exact commit that tags or releases the new tool version.
   - Tests assert that `cli.schema.latest.json` is valid JSON and declares the same tool identifier as `cli.schema.dev.json`.

---

## 3. Module Specifier Grammar

Modules are referenced using a GitHub repository specifier with an optional channel:

```text
@<owner>/<repo>[#<channel>]
```

### Supported Channels

- When `#<channel>` is omitted, clients default to the **`latest`** channel (`@owner/repo#latest`).
- Explicit channels allowed are **`latest`** and **`dev`**:
  - `@owner/repo#latest`: The released, stable contract.
  - `@owner/repo#dev`: The active development contract.
- Any other `#...` (such as git tags `#v1.0.0`, branches `#main`, commit SHAs, empty `#`, or subpaths) is rejected with error code `SPEC_CHANNEL` and message:
  `"only the latest and dev channels are supported"`.

### Syntax Rules

- **Owner**: `^[A-Za-z0-9][A-Za-z0-9._-]*$`
  - Must begin with an alphanumeric character.
  - May contain dots, underscores, or hyphens.
  - Cannot be `.` or `..`.
- **Repo**: `^[A-Za-z0-9][A-Za-z0-9._-]*$`
  - Must begin with an alphanumeric character.
  - May contain dots, underscores, or hyphens.
  - Cannot be `.` or `..`.
- Missing `@` prefix or illegal characters are rejected with `SPEC_SYNTAX`.

### Moving Channels & Evergreen Freshness

- Both channels (`latest` and `dev`) are **moving**: they reflect the state of the default branch on GitHub.
- The local cache serves as an **evergreen freshness cache** rather than an immutable pin.
- Cache entries younger than the TTL (default 6 hours) are reused immediately with zero network overhead.
- Stale entries are conditionally revalidated against GitHub raw content using `If-None-Match` HTTP headers, falling back gracefully to the existing cached schema on any failure.
- Explicit upgrades (`lmbee module upgrade` or SDK `upgrade`) force a refresh immediately, ignoring TTL, and report changes.

---

## 4. Local Cache Directory Layout

Schemas are cached locally under a single user-level directory hierarchy:

```text
${LMCTL_HOME:-~/.lmctl}/modules/
└── github.com/
    └── <owner>/
        └── <repo>/
            └── <channel>/
                ├── cli.schema.<channel>.json
                └── meta.json
```

### Layout Properties

1. **Cache Root Resolution**:
   - If the `LMCTL_HOME` environment variable is defined and non-empty, cache root is `${LMCTL_HOME}/modules`.
   - Otherwise, cache root is `${HOME}/.lmctl/modules`.
2. **Namespace Hierarchy**:
   - The top-level directory under cache root is `github.com`.
   - Each module entry resides in a strictly 4-level directory structure: `github.com/<owner>/<repo>/<channel>`.
   - For example, `@lmctl-ai/lmgit#dev` is stored under `.../lmctl-ai/lmgit/dev/`.
3. **Download URL**:
   - Schemas are fetched from:
     `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/cli.schema.<channel>.json`
4. **Filesystem Permissions**:
   - Directory permissions must be `0700` (`rwx------`).
   - File permissions must be `0600` (`rw-------`).

---

## 5. Metadata File (`meta.json`)

Along with the cached schema file (`cli.schema.<channel>.json`), every entry directory contains a `meta.json` file recording provenance, freshness, and integrity information:

```json
{
  "spec": "@lmctl-ai/lmgit#latest",
  "channel": "latest",
  "url": "https://raw.githubusercontent.com/lmctl-ai/lmgit/HEAD/cli.schema.latest.json",
  "sha256": "4a7d1ed9923c8a98f121d51a66b9d6283ff1c4f42013f707f5979bb95015e197",
  "fetched_at": "2026-10-10T12:00:00.000Z",
  "last_checked": "2026-10-10T12:00:00.000Z",
  "etag": "\"4a7d1ed9923c8a98f121d51a66b9d6283ff1c4f4\"",
  "tool": "lmgit",
  "version": "1.0.0",
  "bytes": 14205
}
```

### Required & Optional Fields

- `spec`: The normalized module specifier string (e.g. `@owner/repo#latest`).
- `channel`: The channel name (`latest` or `dev`).
- `url`: The exact HTTPS raw URL from which the schema was downloaded.
- `sha256`: Hexadecimal SHA-256 digest of the downloaded schema file.
- `fetched_at`: ISO 8601 UTC timestamp of initial installation or full replacement.
- `last_checked`: ISO 8601 UTC timestamp of the most recent freshness check or revalidation.
- `etag`: (Optional) Upstream HTTP entity tag (`ETag` header) preserved for conditional revalidation (`If-None-Match`).
- `tool`: The tool identifier declared in the schema's `tool` property.
- `version`: The semantic version declared in the schema's `version` property.
- `bytes`: File size of the schema file in bytes.

---

## 6. Security Invariants & SDK Requirements

Any SDK or tool implementing the Module Store must uphold the following security and integrity guarantees:

1. **Path Traversal Protection**:
   - Spec parsing and directory resolution must verify that target directories cannot escape the resolved cache root or the `github.com` namespace directory.
   - Any path resolving outside these boundaries must be rejected immediately (`PATH_TRAVERSAL`).
2. **Download Streaming Cap**:
   - Schemas must be downloaded with a strict size cap (`MAX_SCHEMA_BYTES = 2 MiB`). If the stream exceeds this limit, downloading must terminate and return an `OUTPUT_LIMIT` error.
3. **Atomic Writes**:
   - To prevent corrupted or partially-written cache entries, schemas and metadata must be written to temporary files (`.tmp.*`) and renamed atomically into place (`fs.rename`).
   - If writing fails at any step, temporary files must be unlinked.
4. **Tamper Detection & Verification**:
   - When loading cached modules (`resolveCached`), clients must compute the SHA-256 digest of the schema file and verify it against the recorded `sha256` in `meta.json`.
   - Mismatches must be rejected as `CACHE_CORRUPT` without executing or validating untrusted content.
5. **Schema Validation**:
   - Downloaded and cached schemas must conform to the [`cli.schema.v1` specification](protocol.md) and pass validation before being accepted.
6. **Binary Execution via PATH**:
   - Executing operations declared by a module must never execute code downloaded inside the schema directory.
   - Binary resolution must look up the declared `tool` executable exclusively via absolute entries on the host's `PATH`.

---

## 7. Evergreen Refresh

Modules resolve using the browser auto-upgrade model: end users run the latest wrapper contract, while product version compatibility is enforced by the wrapper itself via `UNSUPPORTED_PRODUCT_VERSION`. Therefore, the local cache functions as a **freshness cache**, not an immutable pin.

### Resolution & Refresh Algorithm (`ensure`)

1. **TTL Freshness Check**:
   - Freshness TTL defaults to 6 hours (`ttlMs = 21,600,000` ms).
   - An entry younger than TTL is resolved immediately from cache with **zero network requests** (`source: 'cache'`).
2. **Conditional Revalidation**:
   - If an entry is older than TTL and updates are enabled (`update = true`), the client sends a single conditional HTTP GET with `If-None-Match: <etag>` (3 s timeout, capped stream).
   - **`304 Not Modified`**: Schema is current. Metadata `last_checked` is atomically updated (`source: 'network'`).
   - **`200 OK`**: Upstream schema changed. The response is validated against `cli.schema.v1` and atomically replaces the cached schema and `meta.json` with updated `sha256`, `etag`, and timestamps (`source: 'network'`).
3. **Fail-Safe Fallback**:
   - Any failure during revalidation (network error, DNS failure, timeout, non-2xx status, oversized payload, JSON parse error, schema validation failure, or atomic write error) falls back to the existing cached module (`source: 'stale-cache'`) with a descriptive warning.
   - The on-disk cache files remain byte-identical. Network issues never break existing execution.
4. **Cache Misses & Corruption**:
   - A missing module with `install = true` downloads and installs the entry (`source: 'installed'`).
   - If `install = false`, a missing entry returns `NOT_INSTALLED` with diagnostic suggestion: `run: lmbee module install <key>`.
   - A corrupt cache entry (hash mismatch or unreadable metadata) returns `CACHE_CORRUPT` and is never silently refetched. The user is instructed: `run: lmbee module install <key> --force`.
5. **Non-Executing Modes**:
   - Non-executing phases (`--check`, `--lint`, `--dry-run`, `help`) resolve strictly from local cache and never touch the network.

---

## 8. Evolution Rules for Wrappers

To ensure that evergreen schema auto-refresh is safe for all consumers, wrappers follow these evolution rules:

- **Additive Changes on `latest`**: `latest` changes are additive: new operations and new optional params are fine.
- **No Incompatible Changes**: Never remove or rename an operation or a required param; never change a param's type or an operation's `access` in a weaker direction.
- **Deprecation Lifecycle**: To retire something, mark it `deprecated` in its description for at least one release and remove it only after that.
- **Freedom on `dev`**: `dev` may change freely.
- **Breaking Changes Under New Names**: A wrapper that must break compatibility ships the break under a new operation name.
- **Product-Version Independence**: Product-version incompatibilities are not the schema's concern: the wrapper refuses with `UNSUPPORTED_PRODUCT_VERSION`.

