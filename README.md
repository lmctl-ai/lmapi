# lmapi — the API for the LLM era

REST and OpenAPI defined how software talks to web services: an HTTP server, a URL per
resource, a document that describes it, and client libraries generated from that document.
lmapi does the same for the LLM era with one change of substrate. The server is a command-line
process, not a host: nothing is deployed, nothing listens, the process starts, answers one
request as JSON, and exits. The document that describes it is `cli.schema.v1`, published by the
tool itself with `<tool> --schema`, written for software and for language models; the human
`--help` is derived from it. An LLM therefore needs exactly one capability to act in the world,
"run this command line", and the command it writes is validated against the schema and gated by
operator policy before anything executes. The tool carries its own validation and security
awareness; the model only produces text.

## 1. The picture

```
                 brain                         hands (lmapi servers)
   ┌──────────────────────────┐        ┌──────────────────────────────┐
   │ any LLM / provider       │ text   │  lmgit   lmgh   lmaws  ...   │
   │ (via lmctl or miniplayer)│ ─────► │  each: <tool> --schema       │
   └──────────────────────────┘  one   │        <tool> <op> --flags   │
              ▲                 command│        <tool> <op> --input-json
              │                        │  JSON out, exit code, envelope│
              │ validated, classified, └──────────────────────────────┘
              │ gated, run as argv                    ▲
   ┌──────────┴───────────────┐                       │ spawn(argv), never a shell
   │ client / automation      │ ──────────────────────┘
   │ lmscript · lmts SDK ·    │
   │ an agent host            │   operator policy: which tools, read-only floors,
   └──────────────────────────┘   confirm rules, trust pins — on this side, never the model's
```

Who is what:
- **Server:** the CLI process (`git2`, soon `lmgit`). It publishes the schema, validates every
  input form, enforces policy, prints JSON.
- **Client:** whatever runs commands on behalf of a brain or a workflow: `lmscript` (automation
  of LLMs and external services), the `lmts` SDK embedded in an agent host, or an operator's
  script. The client validates against the published schema before spawning.
- **Brain:** any model through any provider. `lmctl` lets any provider talk to any other;
  `miniplayer` is a one-shot caller that "does not invoke tools or stream individual tokens"
  (its README) and does no validation. Neither needs provider-native function calling: the
  model's output is a command line.

## 2. Design principles, each tied to a protocol rule

1. **The process is the server.** `<tool> --schema` "must execute instantly without requiring
   network access, filesystem initialization, repository discovery, or authentication tokens"
   and exit 0 (`docs/protocol.md` §2). There is no daemon, port, or deployment; discovery is a
   process start.
2. **Schema first; help is derived.** `cli.schema.v1` is "the published machine-readable contract
   for software and LLMs"; "`--help` is secondary: derived from the schema for human readers,
   never the source of truth" (`durable-memory/index.md`). `--explain <op> --format text`
   renders one operation's help from the same document.
3. **Security on the server side; the operator is the authority.** Policy lives in the tool and
   its environment, not in the provider: `--readonly` refuses writes with exit 6
   (`READONLY_VIOLATION`), `--dryrun` returns a synthetic result without executing, `--confirm`
   is required for dangerous operations (exit 9 otherwise). `<TOOL>_READONLY=1` and
   `<TOOL>_DRYRUN=1` are **floors**: the runner ORs environment and flag
   (`readOnly = flag === true || readOnlyFromEnv(tool)`, `lmts/src/server/cli.ts:394-395`), so
   `--readonly=false` or `--no-readonly` under `GIT2_READONLY=1` still exits 6 (verified on
   `git2 commit`). The model cannot loosen what the operator set.
4. **Text is the interface.** The model writes one command line; the client tokenizes it with
   POSIX quoting and refuses every shell construct (`SHELL_SYNTAX`: unquoted `; & | < > ( ) { }
   $ \``, newlines, globs `* ? [`, leading `~`, `#` comments, leading `NAME=value`, `$` or
   backtick even inside double quotes; `lmts/src/interpret.ts:49-276`). The result is an argv
   array executed directly, "no shell process (`sh -c`, `bash -c`, or `cmd.exe /c`) is ever
   invoked" (`protocol.md` §8.4).
5. **Provider-agnostic.** No provider function-calling schema is consulted; `describeForPrompt`
   renders the tools as plain text with three rules ("one simple command", "quote values with
   spaces", "no shell operators") for any model's system prompt (`interpret.ts:516-561`).
6. **Language-neutral.** The schema is plain JSON; "a consumer needs only a JSON parser". The
   protocol document is written for "Go, Rust, Python, C++, or any other language"
   (`protocol.md` §1); lmapi ships that document plus conformance vectors so `lmts`, `lmrust`
   and `lmpython` agree byte for byte on validation issues, envelopes and exit codes.
7. **Small and strict.** Cardinality is `1 ? + *` and nothing finer: "Ranges, string limits, or
   business validation logic are intentionally excluded from the schema contract" (`lmts`
   README). Unknown parameter keys such as `min`, `max`, `conflicts` are rejected by
   `parsePublishedSchema`. Names `__proto__`, `constructor`, `prototype` are reserved
   everywhere (`RESERVED_NAME`); parsed records have a null prototype.

## 3. What an lmapi tool must implement

Checklist; the normative text is `lmts/docs/protocol.md` (to move into the `lmapi` repo).

- [ ] `<tool> --schema` prints one `cli.schema.v1` JSON document to stdout, exit 0, no
      network/credentials/cwd requirements. Fields: `schema`, `tool` (`^[a-z][a-z0-9_]*$`),
      `version` (real package version), `policy {dryrun, readonly}`, `inputs`, `globals`,
      `operations[]` with `name`, `access`, `returns`, `description`, `params[]`
      (`name`, `type ∈ string|number|boolean|object|array|json`, `occurs ∈ 1|?|+|*`,
      `default`, `enum`, `positional`, `items`, `aliases`, `description`).
- [ ] Three input forms resolving to one validator: flags (`--k v`, `--k=v`, `--k`/`--no-k`,
      repeats for `+`/`*`, `--` terminator, positionals), JSON (`--input-json '{…}'`,
      `--input-file PATH`, envelope `{op, params}` when `op` is present), GraphQL
      (`--input-graphql`, inline literals only, no variables).
- [ ] Global flags, declared in `globals`: `--dryrun|--dry-run`, `--readonly|--read-only`,
      `--confirm|--i-understand`, `--help`, `--list`, `--schema`, `--explain`, `--format`,
      `--input-json|--input-file|--input-graphql`. Globals may precede the operation name and
      may accompany a document input; operation flags may not (`MIXED_INPUT`, exit 2).
- [ ] Output: success is the operation's JSON on stdout, exit 0. Every failure is the envelope
      `{"success": false, "error": {"code", "message", "data": {"op", "issues": [...]}}}` on
      stdout, never prose; each issue carries `code`, `message`, `synopsis`, `usage`.
- [ ] Exit codes: 0 ok · 1 command/internal · 2 invalid request/validation · 3 document parse ·
      4 not found · 5 conflict · 6 forbidden/read-only · 7 timeout · 8 service unavailable ·
      9 missing confirmation · 127 binary not found (`protocol.md` §6).
- [ ] Access classification per operation: `read`, `write`, or `dynamic`. A missing `access`
      **is effectful** ("Only operations explicitly declaring `access: 'read'` are
      non-effectful", §2). `--dryrun` and `--readonly` act on everything that is not `read`.
- [ ] Reserved names refused in the document and in input: `__proto__`, `constructor`,
      `prototype`; no parameter named `dryrun`, `readonly`, `confirm`.
- [ ] Dangerous operations (per call site, not in the schema) require `--confirm`.

## 4. What a client does

1. **Pin the schema.** Obtain it once (`<tool> --schema > tool.cli.schema.v1.json`) or import it remotely via the [distribution convention](docs/distribution.md) (`@owner/repo[#ref]`), and read it from disk; never run the tool to discover it during checking or dry runs.
2. **Validate before spawning.** `validate(op, params)` from the schema alone: unknown param with
   an edit-distance suggestion, missing required, type, enum, cardinality, reserved names. All
   issues are collected, not just the first.
3. **Classify.** `classifyOperation(op)` is `read` only for `access: 'read'`; `write`,
   `dynamic` and missing access are `effectful`. "A schema cannot upgrade itself to read-only."
4. **Interpret a model's command line** with `interpretCommand(schemas, line)`: tokenize
   (refusals above), match the tool exactly (`UNKNOWN_TOOL` with suggestion), match the
   operation (`UNKNOWN_OPERATION`, `FLAG_BEFORE_OP`), parse flags against the schema, validate,
   classify. Output is `{tool, op, argv, params, positionals, globals, effect, access}`.
5. **Run as an argv array, never a shell.** `spawn(binary, args)` with `shell:false`; the binary
   is the schema's `tool` name resolved on PATH from absolute entries only, never a path from
   the document. Parameters travel in one `--input-json` argument (or `--input-file` above
   100 KB). Output is parsed JSON; a `{success:false}` envelope is a result, not an exception.
6. **Operator trust and the dry pass** (the `lmscript` rules, `clitools.md` and design 007):
   effectful operations are never spawned in a dry pass or preflight (synthetic result, no
   `--dryrun` sent; the tool is not trusted to honour it); a `read` operation runs in the dry
   pass only when the operator has pinned that schema content and resolved binary; real runs
   execute under the same gate as any process the script could start.
7. **Return structured results.** In `lmscript`, operational failures (tool missing, non-zero
   exit, timeout, invalid JSON, envelope error) come back as a status map, never a thrown error;
   malformed calls fail at check time.

## 5. Comparison

| | REST / OpenAPI | MCP | Provider function calling | lmapi |
|---|---|---|---|---|
| Server | hosted HTTP service | long-lived process over stdio/HTTP, JSON-RPC | the provider's API | a CLI process per call |
| Contract | OpenAPI document | tool list from `tools/list`, JSON Schema per tool | per-provider JSON schema in the request | `cli.schema.v1`, published by the tool, pinned as a file |
| Who validates | server, generated clients | server; host may re-validate | provider checks shape; server validates | tool (always) and client (before spawn), same rules |
| Policy | auth/ACL at the service | host-level consent prompts | provider-side permissions | operator: env floors, `--readonly`/`--dryrun`, `--confirm`, read trust pins |
| Model coupling | none | protocol-specific host | provider-specific | none; the model emits a command line |
| Good at | network services, multi-tenant APIs | rich sessions, resources, prompts, streaming | lowest-friction calls on one provider | local/CI tools, shell-level automation, auditability |
| lmapi deliberately does not | host anything | keep sessions, stream, expose resources/prompts | depend on a provider's tool protocol | model ranges/limits, run a shell, trust `--dryrun` in a dry pass |

Honest notes: MCP's sessions and streaming are real advantages for interactive hosts; lmapi is
one request per process and relies on the shell-free interpreter for safety. Function calling is
simpler when one provider is fixed; lmapi pays a tokenizer and a schema for provider freedom.
OpenAPI expresses far richer constraints; lmapi keeps structure and cardinality only, by design.

## 6. Ecosystem

| Component | Role | Status |
|---|---|---|
| `lmapi` (this repo) | the specification: protocol document, distribution convention, `cli.schema.v1` JSON Schema, conformance vectors | [`docs/protocol.md`](docs/protocol.md), [`docs/distribution.md`](docs/distribution.md), [`schema/`](schema/cli.schema.v1.schema.json), [`conformance/`](conformance/) |
| [`lmts`](https://github.com/lmctl-ai/lmts) | TypeScript SDK: `./validate` (client, zero dependencies), `./server` (`runCli`, `checkPolicy`, `spawnCommand`), interpreter, classifier and prompt renderer | exists; runs every conformance vector |
| `lmrust`, `lmpython` | SDKs for other languages | planned; they must pass the same vectors |
| `git2`, `gh2`, `aws2` | reference tools for git, GitHub and AWS, built on the `lmts` server runtime | exist; every operation has an authored schema |
| `lmscript` | automation language; a client of lmapi tools | exists; consumes a published `git2` schema today |
| `lmctl` | coordinates provider CLIs and carries the brain-to-brain conversation | exists |
| `miniplayer` | one-shot model call with a model pool and failover; no tools, no validation | exists |

## 7. Known gaps and open decisions

- **Operator-side confirm policy.** `--confirm` is a flag the caller sends, so a model writing
  `--confirm` attests to its own confirmation. The operator must be able to require
  confirmation out of band, by denying `--confirm` from interpreted commands or by allowlisting
  the operations that may be confirmed.
- **Operator operation allowlist.** Beyond read-only floors, an operator should be able to
  restrict which tools and operations a client may run. The interpreter already knows the tool
  and operation before anything spawns.
- **Loosening flags must be refused by the interpreter.** A server treats `--no-readonly` and
  `--readonly=false` as no-ops under an environment floor, but the interpreter still parses them
  as valid booleans. A client should reject any negative form of a policy global.
- **Importing a schema as a script module.** A script imports `x.cli.schema.v1.json` and gets a
  namespaced module (`git2.lm_status`), with results as status maps and read-only trust
  granted by the operator, not by the schema. This is designed and not yet implemented.
- **Schema versioning.** `cli.schema.v1` is the only tag. What counts as a breaking change, and
  how a client reports a stale pinned schema beyond a version hint, are open.

## License

MIT. See [LICENSE](LICENSE).
