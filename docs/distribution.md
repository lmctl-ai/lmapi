# CLI Schema Distribution & Module Convention

This document specifies how `lmapi` tools publish their schema contracts and how client environments (such as LMScript and language SDKs) resolve, download, verify, and cache them locally.

For the core protocol governing server CLI processes and JSON schemas, see [`protocol.md`](protocol.md).

---

## 1. Overview & Distribution Model

In the `lmapi` architecture, command-line tools publish a machine-readable schema (`cli.schema.v1`) that defines their commands, parameters, types, and execution policies. 

To enable seamless automation and agent execution without manual tool installation:
1. Tool authors publish their authoritative schema document at the root of their source repository.
2. Clients import tools using a repository specifier: `@<owner>/<repo>[#<ref>]`.
3. The client or SDK downloads the schema directly over HTTPS from GitHub raw content, verifies its structure and integrity, and stores it in a secure local cache.
4. Execution checks and dry-run preflights validate against the cached schema document without requiring network calls.

---

## 2. Root `cli.schema.v1.json` Requirement

Every published tool repository (e.g. `lmgit`, `lmgh`, `lmaws`) must commit its published schema at the repository root:

```text
cli.schema.v1.json
```

### Invariants

1. **Byte-for-byte Equivalence**:
   - The contents of root `cli.schema.v1.json` must be byte-for-byte identical to the output produced by running `<tool> --schema` (formatted as 2-space indented JSON with a trailing newline).
2. **Version Alignment**:
   - The top-level `version` field in `cli.schema.v1.json` must match the release version defined in the repository's package metadata (e.g. `package.json`).
3. **Drift Prevention**:
   - Tool repositories must include an automated test (e.g. `tests/schema-file.test.ts`) ensuring that the committed root `cli.schema.v1.json` does not drift from `<tool> --schema`.

---

## 3. Module Specifier Grammar

Modules are referenced using a GitHub repository specifier with an optional git ref:

```text
@<owner>/<repo>[#<ref>]
```

### Syntax Rules

- **Owner**: `^[A-Za-z0-9][A-Za-z0-9._-]*$`
  - Must begin with an alphanumeric character.
  - May contain dots, underscores, or hyphens.
  - Cannot be `.` or `..`.
- **Repo**: `^[A-Za-z0-9][A-Za-z0-9._-]*$`
  - Must begin with an alphanumeric character.
  - May contain dots, underscores, or hyphens.
  - Cannot be `.` or `..`.
- **Ref** (optional): `^[A-Za-z0-9._/-]+$`
  - When omitted, clients default to `HEAD`.
  - Leading slashes, trailing slashes, and consecutive slashes (`//`) are strictly forbidden.
  - Path segments within ref cannot be `.` or `..`.
  - Violations must be rejected as invalid syntax (`SPEC_SYNTAX` or `SPEC_REF`).

### Immutability & Hash Pinning

Refs are categorized into two classes:
- **Immutable Refs**:
  - Semantic version tags: `vX.Y.Z` or `X.Y.Z` (e.g. `v1.0.0`, `2.1.0-alpha.1`).
  - Git commit SHAs: Exact 40-character hexadecimal strings (`^[0-9a-fA-F]{40}$`).
  - *Invariant*: Once installed and verified in cache, immutable refs are permanent and never re-fetched or replaced during general upgrades.
- **Moving Refs**:
  - Branch names (`main`, `master`, `feature/my-branch`) or omitted ref (`HEAD`).
  - *Policy*: May be updated when an upgrade is explicitly requested by an operator or script.

---

## 4. Local Cache Directory Layout

Schemas are cached locally under a single user-level directory hierarchy:

```text
${LMCTL_HOME:-~/.lmctl}/modules/
└── github.com/
    └── <owner>/
        └── <repo>/
            └── <encodedRef>/
                ├── cli.schema.v1.json
                └── meta.json
```

### Layout Properties

1. **Cache Root Resolution**:
   - If the `LMCTL_HOME` environment variable is defined and non-empty, cache root is `${LMCTL_HOME}/modules`.
   - Otherwise, cache root is `${HOME}/.lmctl/modules`.
2. **Namespace Hierarchy**:
   - The top-level directory under cache root is `github.com`.
   - Each module entry resides in a strictly 4-level directory structure: `github.com/<owner>/<repo>/<encodedRef>`.
3. **Encoded Ref Path Segments**:
   - To preserve directory tree hierarchy and prevent nested filesystem collisions, slashes (`/`) in refs are URL-encoded (`encodeURIComponent`).
   - For example, `@owner/repo#feature/v1` is stored under `.../owner/repo/feature%2Fv1/`.
4. **Filesystem Permissions**:
   - Directory permissions must be `0700` (`rwx------`).
   - File permissions must be `0600` (`rw-------`).

---

## 5. Metadata File (`meta.json`)

Along with the raw schema, every cached entry must contain a `meta.json` file recording provenance and integrity information:

```json
{
  "spec": "@lmctl-ai/lmgit#v1.0.0",
  "url": "https://raw.githubusercontent.com/lmctl-ai/lmgit/v1.0.0/cli.schema.v1.json",
  "sha256": "4a7d1ed9923c8a98f121d51a66b9d6283ff1c4f42013f707f5979bb95015e197",
  "fetched_at": "2026-10-10T12:00:00.000Z",
  "ref": "v1.0.0",
  "tool": "lmgit",
  "version": "1.0.0",
  "bytes": 14205
}
```

### Required Fields

- `spec`: The normalized module specifier string.
- `url`: The exact HTTPS raw URL from which the schema was downloaded.
- `sha256`: Hexadecimal SHA-256 digest of the downloaded `cli.schema.v1.json`.
- `fetched_at`: ISO 8601 UTC timestamp of installation.
- `tool`: The tool identifier declared in the schema's `tool` property.
- `version`: The semantic version declared in the schema's `version` property.
- `bytes`: File size of `cli.schema.v1.json` in bytes.
- `ref`: The git ref if explicitly specified in the spec.

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
   - When loading cached modules (`resolveCached`), clients must compute the SHA-256 digest of `cli.schema.v1.json` and verify it against the recorded `sha256` in `meta.json`.
   - Mismatches must be rejected as `CACHE_CORRUPT` without executing or validating untrusted content.
5. **Schema Validation**:
   - Downloaded and cached schemas must conform to the [`cli.schema.v1` specification](protocol.md) and pass validation before being accepted.
6. **Binary Execution via PATH**:
   - Executing operations declared by a module must never execute code downloaded inside the schema directory.
   - Binary resolution must look up the declared `tool` executable exclusively via absolute entries on the host's `PATH`.
