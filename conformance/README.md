# CLI Schema & Protocol Conformance Vectors

This directory contains language-neutral JSON test vectors for validating SDK implementations (TypeScript, Go, Rust, Python, etc.) against the `cli.schema.v1` specification.

## Core Rule

An SDK passes the conformance test suite if and only if it reproduces the `expect` outcome for every case:
- When `expect.ok === true`: The SDK must validate or parse successfully and produce equivalent parameter/return values.
- When `expect.ok === false`: The SDK must fail with issues matching the expected issue `code` and (where specified) `param` or `op` identity.
- **Message Text Exemption**: Implementations compare issue **`code`** and target parameter/operation identity, **not** human-readable message text strings.

## Directory Structure & Formats

### 1. `validate/*.json`
Tests parameter validation against an `OperationSchema` using the three input forms (`flags`, `json`, `graphql`):
```json
{
  "name": "case description",
  "schema": { "name": "op", "params": [ ... ] },
  "form": "flags" | "json" | "graphql", // optional, defaults to flags
  "input": { "key": "value" },
  "expect": {
    "ok": true,
    "params": { "key": "value" }
  } // OR
  "expect": {
    "ok": false,
    "issues": [
      { "code": "TYPE_MISMATCH", "param": "key", "suggestion": "..." }
    ]
  }
}
```

### 2. `argv/*.json`
Tests command-line flag token parsing (`parseArgvForm`):
```json
{
  "name": "case description",
  "schema": { "name": "op", "params": [ ... ] },
  "globals": [ ... ], // optional global flags
  "argv": ["--flag", "val"],
  "expect": {
    "ok": true,
    "params": { ... },
    "positionals": [ ... ],
    "globals": { ... }
  } // OR
  "expect": {
    "ok": false,
    "issues": [
      { "code": "DUPLICATE_FLAG", "param": "..." }
    ]
  }
}
```

### 3. `interpret/*.json`
Tests command line lexical tokenization, security refusal, and full dispatch (`interpretCommand`):
```json
{
  "name": "case description",
  "schemas": "fixtures/git2.cli.schema.v1.json", // path relative to conformance/
  "line": "git2 commit --message \"msg\"",
  "expect": {
    "ok": true,
    "tool": "git2",
    "op": "commit",
    "argv": ["git2", "commit", "--message", "msg"],
    "params": { "message": "msg" },
    "effect": "read" | "effectful"
  } // OR
  "expect": {
    "ok": false,
    "issues": [
      { "code": "SHELL_SYNTAX" }
    ]
  }
}
```

### 4. `publish/*.json`
Tests structural parsing and validation of published `cli.schema.v1` documents (`parsePublishedSchema`):
```json
{
  "name": "case description",
  "document": { ... },
  "expect": {
    "ok": true
  } // OR
  "expect": {
    "ok": false,
    "issues": [
      { "code": "RESERVED_NAME", "param": "prototype" }
    ]
  }
}
```

### 5. `prompt/`
Tests deterministic LLM prompt text rendering (`describeForPrompt`):
- `git2.prompt.txt`: Golden expected output for `fixtures/git2.cli.schema.v1.json`.
- `cases.json`: Index linking fixture schemas to golden text files.

### 6. `fixtures/`
Shared schema fixtures used by multi-tool and interpreter test vectors.
- `git2.cli.schema.v1.json`: The complete published schema fixture for the `git2` tool.
