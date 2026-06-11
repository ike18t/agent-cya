# AGENTS.md

TypeScript CLI that reviews AI coding assistant tool calls before execution. No compilation step — runs directly with `node`.

## Quick Start

```bash
npm install
npm test                           # run all tests (vitest)
npm run lint                       # tsc + eslint + prettier + knip
node src/main.ts review --help   # run CLI
```

Node 23.9+ required for native `.ts` execution.

## Commands

| Command                                                                                                             | Purpose                        |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `npm test`                                                                                                          | Run all tests                  |
| `npm run lint`                                                                                                      | tsc + eslint + prettier + knip |
| `npm test -- src/cli.test.ts`                                                                                       | Run single test file           |
| `echo '{"toolType":"Bash","command":"ls"}' \| node src/main.ts review --platform claude` | Manual review                  |

## Critical Gotchas

- **No compilation step**: Source runs directly with `node`. No `dist/` or `build/`. The bin script (`bin/agent-cya`) shells out to `node src/main.ts`.
- **`.ts` imports in `.ts` files**: All internal imports use `.ts` extensions (native Node ESM). Adding new modules requires `.ts` in the import path.
- **Tests included in tsconfig**: `src/**/*.test.ts` files are included in `tsconfig.json`. Running `npm run lint` type-checks both source and test files. `vitest/globals` is in the `types` array so LSP resolves `describe`/`it`/`expect`, but tests must still import from `"vitest"` explicitly.
- **`cli.test.ts` mocks `node:child_process`**: Must mock at top of file before importing `./cli.ts`, since `spawn` is used transitively.
- **No HTTP, no API keys**: LLM review shells out to `claude` or `opencode` CLI binaries via `child_process.spawn(binary, ["-p", prompt])`. No `fetch`, no OpenAI API.
- **`runReview` returns `number`**: Returns `0` (allow/ask) or `1` (deny/error). Caller in `program.action()` passes to `process.exit()`.

## Architecture

**Entry point**: `src/main.ts` → imports `program` from `src/cli.ts` → `program.parse(process.argv)`.

**Decision pipeline** (in order):

1. Parse stdin JSON → `src/cli.ts` (`parseInput`)
2. Hard deny (regex pattern match) → `src/rules.ts`
3. LLM review (binary spawn) → `src/llm.ts` → `src/prompt.ts`
4. Audit log (always on) → `src/audit-log.ts`

**5 source files**:

- `src/rules.ts` — 11 hardcoded deny regex patterns, `evaluateHardDeny()`
- `src/prompt.ts` — `buildSystemPrompt()` + `buildUserPrompt()` with XML sections and escaping
- `src/llm.ts` — `spawn` wrapper for `claude`/`opencode` binaries, 30s timeout, JSON extractor
- `src/cli.ts` — Commander.js CLI, stdin JSON → hard deny → LLM review → stdout JSON
- `src/audit-log.ts` — always-on JSON-lines writer at `~/.agent-cya/audit.log`

**Hooks** (not part of `src/`, external entry points):

- `hooks/claude-hook.sh` — Claude Code PermissionRequest adapter (single jq call, exit 2 on deny)
- `hooks/opencode-plugin.ts` — OpenCode `tool.execute.before` plugin (30s spawn timeout)

**Input/Output**: JSON over stdin/stdout. Exit code `0` = allow/ask, `1` = deny/error.

**Platform flag**: `--platform claude` spawns `claude` binary; `--platform opencode` spawns `opencode` binary.

## Testing

- Framework: Vitest with `globals: true`
- Colocated tests: `src/rules.test.ts`, `src/prompt.test.ts`, `src/llm.test.ts`, `src/cli.test.ts`, `src/audit-log.test.ts`
- `llm.test.ts` and `cli.test.ts` mock `node:child_process.spawn`
- No integration tests: LLM calls are always mocked

## No CI/CD

No GitHub Actions, no pre-commit hooks, no release pipeline. Fully manual.
