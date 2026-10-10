# CLI Tool Protocol Specification (`cli.schema.v1`)

This document defines the interface and wire protocol for building schema-driven CLI tools. It is language-agnostic and intended for implementers building compatible CLI servers and client SDKs in Go, Rust, Python, TypeScript, C++, or any other language.

---

## 1. Architectural Model

A compliant CLI tool acts as a **structured server**, while caller software (such as `lmscript`, agent runtimes, or LLM host environments) acts as the **client**:
- **Stdout is machine-readable**: All standard command output MUST be valid JSON.
- **Stderr is for non-critical logging**: Structured communication and error envelopes are never written to stderr alone.
- **Zero-setup schema discovery**: Tools must describe their entire API statically on demand.

---

## 2. Schema Discovery: `<tool> --schema`

Every compliant tool must implement the `--schema` flag at the root invocation level:

```console
$ <tool> --schema
```

### Constraints
1. **Immediate Execution**: Must execute instantly without requiring network access, filesystem initialization, repository discovery, or authentication tokens.
2. **Stdout Output**: Emits a single JSON document matching schema tag `cli.schema.v1`.
3. **Exit Code**: Must exit with code `0`.

### Schema Document Format (`cli.schema.v1`)

```json
{
  "schema": "cli.schema.v1",
  "tool": "mytool",
  "version": "1.0.0",
  "policy": {
    "dryrun": true,
    "readonly": true
  },
  "inputs": ["flags", "json", "graphql"],
  "globals": [
    {
      "name": "dryrun",
      "type": "boolean",
      "occurs": "?",
      "aliases": ["dry-run"],
      "description": "Simulate write operations without making changes"
    },
    {
      "name": "readonly",
      "type": "boolean",
      "occurs": "?",
      "aliases": ["read-only"],
      "description": "Refuse write operations"
    },
    {
      "name": "confirm",
      "type": "boolean",
      "occurs": "?",
      "aliases": ["i-understand"],
      "description": "Confirm dangerous or destructive operations"
    }
  ],
  "operations": [
    {
      "name": "status",
      "access": "read",
      "returns": "object",
      "description": "Show system status",
      "params": [
        {
          "name": "path",
          "type": "string",
          "occurs": "?",
          "default": ".",
          "description": "Target directory"
        }
      ]
    },
    {
      "name": "deploy",
      "access": "write",
      "returns": "object",
      "description": "Deploy build artifacts",
      "params": [
        {
          "name": "environment",
          "type": "string",
          "occurs": "1",
          "description": "Deployment environment"
        }
      ]
    }
  ]
}
```

### Parameter Cardinality (`occurs`)
Cardinalities represent presence and multiplicity:
- `'1'`: Exactly one value required (default if omitted).
- `'?'`: Zero or one value (optional).
- `'+'`: One or more values (required list/array).
- `'*'`: Zero or more values (optional list/array).

### Parameter Types
- `'string'`: UTF-8 string.
- `'number'`: IEEE 754 float or integer.
- `'boolean'`: Boolean `true` or `false`.
- `'object'`: Key-value map.
- `'array'`: Homogeneous array of primitive or object items (item type specified in `items`).
- `'json'`: Arbitrary JSON value.

### Identifier Syntax & Reserved Names
- **Tool and Operation Names**: Must match `^[a-z][a-z0-9_]*$`.
- **Parameter Names**: Must match `^[A-Za-z_]\w*$`.
- **Reserved Names**: The names `__proto__`, `constructor`, and `prototype` are strictly forbidden for tool, operation, parameter, alias, and global names. Operations must not declare a parameter named `dryrun` (reserved for runner policy).

---

## 3. Input Forms & Transport

Every declared operation accepts arguments through three interchangeable transport representations:

### 3.1. Command-Line Flags Form
Arguments are passed as standard CLI arguments:
```console
$ mytool deploy --environment production --confirm
```
- Short flags (`-h`) and long flags (`--flag <val>`) are supported.
- Boolean flags take no value (`--confirm` implies true, `--no-confirm` implies false).
- Repeated flags accumulate into lists for `occurs: '+'` or `'*'`.
- Arguments following `--` are treated strictly as positional parameters.

### 3.2. JSON Document Form
Arguments are passed in a single JSON payload via `--input-json` or `--input-file`:
```console
$ mytool deploy --input-json '{"environment": "production"}' --confirm
```
The JSON document may optionally use an envelope `{ "op": "deploy", "params": { ... } }` or provide the parameter object directly `{ "environment": "production" }`.

### 3.3. GraphQL Document Form
Arguments are passed in GraphQL query/mutation syntax via `--input-graphql`:
```console
$ mytool deploy --input-graphql 'mutation { deploy(environment: "production") }' --confirm
```

### 3.4. Transport Exclusivity & Mixed Input Rules
An invocation must use exactly one input form for operation parameters. Passing operation flags alongside `--input-json` or `--input-graphql` is rejected with error code `MIXED_INPUT`. Global flags (`--dryrun`, `--readonly`, `--confirm`) are permitted alongside document inputs.

---

## 4. Execution Policy & Global Flags

Tools provide standard policy enforcement flags:

### 4.1. Dry-Run (`--dryrun`, `--dry-run`)
When `--dryrun` is present, the runner simulates write operations without committing changes:
- Read operations execute normally.
- Write and dynamic operations validate all arguments and policy checks, then return a synthetic success envelope without performing mutations:
  ```json
  {
    "success": true,
    "data": {
      "dryrun": true,
      "simulated": true,
      "operation": "deploy"
    }
  }
  ```

### 4.2. Read-Only (`--readonly`, `--read-only`)
When `--readonly` is present:
- Read operations (`access: 'read'`) execute normally.
- Write or dynamic operations are immediately refused with exit code `6` (`READONLY_VIOLATION`).

### 4.3. Confirmation (`--confirm`, `--i-understand`)
Operations marked as requiring confirmation fail with exit code `9` (`MISSING_CONFIRMATION`) unless `--confirm` is provided.

### 4.4. Product Compatibility
A published schema may declare an optional `product` metadata block defining compatibility requirements for the underlying system executable (e.g. `git`, `gh`, `aws`):
```json
{
  "product": {
    "name": "git",
    "supported": ">=2.43.0 <3.0.0",
    "detect": {
      "argv": ["git", "--version"],
      "pattern": "(\\d+\\.\\d+\\.\\d+)"
    }
  }
}
```
The wrapper CLI (server) resolves `argv[0]` on the system `PATH` (using absolute PATH entries only), executes `detect.argv` once per process (cached), extracts the semver string matching the regular expression `pattern`, and validates that the extracted version satisfies the `supported` version conjunction range.

If the product executable is not found on PATH or its version falls outside the `supported` range, the wrapper refuses all operation execution and exits with exit code `10` (`UNSUPPORTED_PRODUCT_VERSION`).
The error envelope emitted to stdout is:
```json
{
  "success": false,
  "error": {
    "code": "UNSUPPORTED_PRODUCT_VERSION",
    "message": "Product \"git\" version 1.8.0 does not satisfy supported range \">=2.43.0 <3.0.0\"",
    "data": {
      "product": "git",
      "found": "1.8.0",
      "supported": ">=2.43.0 <3.0.0"
    }
  }
}
```
When detection fails or the executable is missing on PATH, `found` is `null`.

**Inspection Exemption**: Informational and inspection commands (`--schema`, `--list`, `--help`, `--explain`) are never blocked by product compatibility checks, allowing clients to inspect schemas offline and without the underlying tool installed.

---

## 5. Output Envelopes & Error Reporting

### 5.1. Success Output
All successful operations output a valid JSON document to stdout and exit `0`.

### 5.2. Error Output Envelope
Any failure, invalid argument, or policy violation MUST emit a JSON error envelope to stdout:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "invalid arguments for \"deploy\"",
    "data": {
      "op": "deploy",
      "issues": [
        {
          "code": "MISSING_REQUIRED",
          "message": "missing required parameter: environment",
          "param": "environment",
          "synopsis": "--environment <string>",
          "usage": "mytool deploy --environment <string>"
        }
      ]
    }
  }
}
```

Every validation issue must contain non-empty `code`, `message`, `synopsis`, and `usage`.

---

## 6. Exit Code Specification

Implementations must map internal error classifications to standard exit codes:

| Exit Code | Error Code | Description |
|---|---|---|
| `0` | *(Success)* | Operation completed successfully |
| `1` | `COMMAND_FAILED` | Underlying subprocess or external command failed |
| `1` | `INTERNAL_ERROR` | Unhandled internal exception or invariant failure |
| `1` | `UNKNOWN_ERROR` | Generic unexpected error |
| `2` | `INVALID_REQUEST` | Missing operation name, unknown operation, or invalid CLI flag usage |
| `2` | `VALIDATION_ERROR` | Parameter validation failure (`UNKNOWN_PARAM`, `TYPE_MISMATCH`, `MISSING_REQUIRED`, `ENUM_VIOLATION`, `FORM_NOT_ALLOWED`, `MISSING_VALUE`, `EXTRA_POSITIONAL`, `DOCUMENT_PARSE`, `OP_MISMATCH`, `MIXED_INPUT`, `DUPLICATE_FLAG`, `RESERVED_NAME`) |
| `3` | `PARSE_ERROR` | Malformed JSON document, GraphQL syntax error, or unreadable document input |
| `4` | `NOT_FOUND` | Requested entity, branch, revision, or file not found |
| `5` | `CONFLICT` | State conflict (e.g. merge conflict, existing branch, conflicting resource) |
| `6` | `FORBIDDEN` | Access denied or permission error |
| `6` | `READONLY_VIOLATION`| Attempted write operation while running under `--readonly` |
| `7` | `TIMEOUT` | Operation exceeded deadline or execution timeout |
| `8` | `SERVICE_UNAVAILABLE`| Remote service, daemon, or network connection unavailable |
| `9` | `MISSING_CONFIRMATION` | Dangerous operation attempted without `--confirm` or `--i-understand` |
| `10` | `UNSUPPORTED_PRODUCT_VERSION` | Wrapper refuses all operations because the underlying product is missing or its version falls outside the supported range |
| `127`| `COMMAND_NOT_FOUND` | Required external binary not found on system PATH |

---

## 7. Zero-Dependency Client Guidelines

Client implementations consume only the published schema document:
1. Load schema via `<tool> --schema`.
2. Inspect `operations` and their `params`.
3. Validate user inputs against declared `type`, `occurs`, and `enum` constraints before invoking the tool binary.
4. Serialize input into either `--input-json` or CLI flags.
5. Execute `<tool>` with serialized arguments and parse JSON output from stdout.

---

## 8. Interpreting an LLM-Produced Command Line

When an LLM (brain) interacts with CLI tools (hands) through a text command line, the host runtime must validate and execute the call securely without shell evaluation.

### 8.1. Tokenizer Grammar

The tokenizer parses a single command line without invoking a shell:
- **Single Quotes (`'...'`)**: Completely literal. No characters are escaped. Shell operators inside single quotes are treated as plain text.
- **Double Quotes (`"..."`)**: Backslash escaping is permitted ONLY for `"` and `\`. Any occurrence of `$` (variable expansion or command substitution) or `` ` `` (backticks) inside double quotes is strictly refused (`SHELL_SYNTAX`).
- **Outside Quotes**:
  - Whitespace (` ` and `\t`) separates words.
  - Backslash escapes spaces (`\ `), quotes, and backslashes.
  - Adjacent quoted and unquoted fragments concatenate into a single token (e.g. `--message="hello "'world'` -> `--message=hello world`).
  - Empty string quotes (`""` or `''`) emit distinct empty string tokens (`""`).

### 8.2. Refusal Codes & Security Constraints

The interpreter strictly refuses any shell features with specific issue codes:
- **`SHELL_SYNTAX`**:
  - Unquoted chaining and backgrounding operators: `;`, `&`, `&&`, `|`, `||`.
  - Unquoted subshell and redirection operators: `<`, `>`, `>>`, `<<`, `(`, `)`, `{`, `}`.
  - Unquoted expansion and substitutions: `$`, `$(...)`, `` `...` ``.
  - Newlines and control characters: `\n`, `\r`, `\0`.
  - Unquoted glob wildcards: `*`, `?`, `[`.
  - Tilde expansion: A word starting with unquoted `~` (e.g. `~` or `~/path`). Note: `~` within a word (e.g. `HEAD~1`) is allowed.
  - Shell comments: `#` starting a word. Note: `#` within a word (e.g. `issue#12`) is allowed.
  - Leading environment variable assignments: First token matching `^[a-zA-Z_][a-zA-Z0-9_]*=`.
  - Unterminated single or double quotes.
- **`UNKNOWN_TOOL`**: First token does not match any registered schema's `tool` identifier. Returns known tool list and edit-distance suggestion (distance <= 2).
- **`UNKNOWN_OPERATION`**: Second token does not match any operation name in the tool's schema. Returns available operations and edit-distance suggestion (distance <= 2).
- **`FLAG_BEFORE_OP`**: A flag (e.g. `--schema` or `-h`) was supplied where an operation name was expected. Operations must precede flags.

### 8.3. Effect Classification

Operations are classified deterministically based on declared access:
- **`'read'`**: Only when `op.access === 'read'`.
- **`'effectful'`**: When `op.access` is `'write'`, `'dynamic'`, undefined, or omitted.

**Safety Invariant**: A schema cannot upgrade itself to read-only. Dynamic access operations may perform state modifications depending on parameters, so they are always treated as effectful.

### 8.4. Execution Model

No shell process (`sh -c`, `bash -c`, or Windows `cmd.exe /c`) is ever invoked.
The interpreter produces an `argv` array of strings:
```
result = interpretCommand(schemas, commandLine)
if result.ok:
  # Direct execution with array arguments — zero shell interpretation
  binary = result.value.argv[0]
  args = result.value.argv[1..]
  executeProcess(binary, args)
```
All arguments are passed directly to OS `execve` / `CreateProcess`, preventing command injection, argument splitting, or shell injection vulnerabilities.
