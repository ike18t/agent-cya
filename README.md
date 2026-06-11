# agent-cya

A second-LLM permission reviewer for AI coding assistants (Claude Code, OpenCode).

## Why

You're usually choosing between two bad options: `--dangerously-skip-permissions` lets the agent rip but auto-approves anything it dreams up, while the default permission flow buries you in a prompt for every other command. agent-cya is the middle path — a separate LLM reviews each tool call (and reads the contents of scripts it's about to execute) and decides `allow` / `deny` / `ask` on the merits, so the agent keeps moving on routine work and only pulls you in when the risk actually warrants it.

## How It Works

agent-cya sits between the coding assistant and execution. The decision pipeline is:

```
stdin JSON → Hard deny? → File enrichment (Bash) → LLM review → stdout JSON + audit log
```

1. **Hard deny** — Hardcoded regex patterns catch obviously destructive commands (`rm -rf /`, `curl | bash`, `sudo`, etc.). Blocked immediately, no LLM call.
2. **File enrichment** — When a Bash command runs a script (`bash foo.sh`, `node x.js`, `./run`, `python3 script.py`), agent-cya reads the script from disk and includes its contents in the LLM prompt. The reviewer sees what's actually about to execute, not just the invocation — which closes the create-then-execute loophole where a write step slips past unreviewed.
3. **LLM review** — Everything else is sent to the `claude` or `opencode` CLI binary (spawned locally, no HTTP) for a security assessment.
4. **Audit log** — Every decision is appended to `~/.agent-cya/audit.log`.

## Quick Start

```bash
npm install

# Manual review:
echo '{"toolType":"Bash","command":"ls"}' | \
  node src/main.ts review --platform claude
```

Node 23.9+ is required for native `.ts` execution. No compilation step — source runs directly.

## Usage

### As a Claude Code Hook

Add a `PermissionRequest` hook to `~/.claude/settings.json` that points at `hooks/claude-hook.sh`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/agent-cya/hooks/claude-hook.sh",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to/agent-cya` with where you cloned this repo. The hook reviews via the `claude` CLI by default; prepend `AGENT_CYA_PLATFORM=opencode` to the command to use OpenCode instead. To gate file edits too, widen the matcher to `"Bash|Write|Edit"`.

The hook only fires when Claude Code would otherwise prompt for permission — already-allowlisted commands skip it. agent-cya's `allow` / `deny` / `ask` decisions map directly to `PermissionRequest` behaviors; `ask` falls through to Claude Code's standard permission dialog.

> ⚠️ **Watch out for "autopilot accept" on fallback prompts.** When the reviewer LLM is unreachable or times out, agent-cya falls back to `ask`. Claude Code then surfaces its **standard approval prompt** — visually identical to any routine permission ask, with no agent-cya reasoning attached. It's easy to muscle-memory click "Yes" and approve a command the LLM would have caught if it had been responsive. Two specific failure modes:
>
> 1. **Clicking "Yes"** runs the command once. Annoying but recoverable — the audit log captures what got through.
> 2. **Clicking "Yes, and don't ask again for X"** adds the command pattern to your allowlist, which **bypasses the hook entirely** for future matches. Worse than #1 and silent.
>
> If you see an unexpected approval prompt while agent-cya is installed, treat it as a signal that the reviewer isn't reaching the LLM — check `~/.local/state/agent-cya/claude-hook.log` for the cause before accepting.
>
> The `timeout` value above is in **seconds** (the Claude Code default is already 600s, so most users won't need to tune it). Lower it to fail fast when the reviewer is unresponsive; raise it only for unusually slow local models.

### As an OpenCode Plugin

Use `hooks/opencode-plugin.ts` as an OpenCode `tool.execute.before` plugin. It spawns agent-cya as a subprocess with a 30s timeout and throws on deny/ask decisions.

Configure the LLM backend via `AGENT_CYA_PLATFORM` (defaults to `opencode`):

```bash
export AGENT_CYA_PLATFORM=opencode
```

## CLI

```
agent-cya review --platform <platform>
```

| Flag         | Description                                                                 |
| ------------ | --------------------------------------------------------------------------- |
| `--platform` | Required. `claude` or `opencode` — which CLI binary to spawn for LLM review |

## Input/Output Format

### Input (stdin)

```json
{
  "toolType": "Bash",
  "command": "rm -rf /tmp/build",
  "fileContent": null,
  "workingDirectory": "/Users/dev/project"
}
```

- `toolType` — name of the tool (e.g., `Bash`, `Write`, `Edit`)
- `command` — the command or file path being acted on
- `fileContent` — optional file content or edit diff
- `workingDirectory` — optional working directory context

### Output (stdout)

```json
{
  "decision": "deny",
  "reason": "Command matches denied pattern: rm\\s+-rf\\s+\\*"
}
```

### Exit Codes

- `0` — allow or ask (proceed)
- `1` — deny or error

## Architecture

```
src/
├── main.ts        # Entry point: imports program from cli.ts, calls program.parse()
├── cli.ts         # Commander.js CLI, stdin parse → hard deny → enrich → LLM → stdout JSON
├── rules.ts       # Hardcoded deny regex patterns, evaluateHardDeny()
├── file-enrich.ts # For Bash commands that run a script, reads file contents from disk
├── prompt.ts      # buildSystemPrompt() + buildUserPrompt() with XML sections
├── llm.ts         # Spawns claude/opencode CLI binary, 90s timeout, JSON extractor
└── audit-log.ts   # Always-on JSON-lines writer at ~/.agent-cya/audit.log
```

```
hooks/
├── claude-hook.sh     # Claude Code PermissionRequest adapter (jq transform, exit 2 on deny)
└── opencode-plugin.ts # OpenCode tool.execute.before plugin (30s spawn timeout)
```

Key design decisions:

- **No config file** — deny patterns are hardcoded, not user-configurable
- **No HTTP, no API keys** — LLM review shells out to the `claude` or `opencode` CLI binary via `child_process.spawn`
- **No compilation** — runs directly with `node`; all imports use `.ts` extensions

## Tech Stack

- TypeScript (no compilation — `node`)
- Commander.js — CLI framework
- Vitest — Testing

## License

ISC
