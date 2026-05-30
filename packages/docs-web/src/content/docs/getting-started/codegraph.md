---
title: CodeGraph
description: Enable CodeGraph for token-efficient code exploration in Claude workflows.
category: getting-started
area: clients
audience: [user]
status: current
sidebar:
  order: 5
---

CodeGraph is a local code knowledge graph — tree-sitter + SQLite + FTS5 — that Claude Code workflows can query as an MCP server. It indexes your codebase once and answers structural questions ("who calls X?", "what does Y reach?") in one tool call instead of dozens of `grep` / `Read` rounds.

**Benchmark numbers** (from CodeGraph's own tests across 7 open-source codebases):
- ~25% cheaper per workflow run
- ~57% fewer tokens
- ~62% fewer tool calls
- 100% local — no API keys, no external services

CodeGraph is **Claude-only in v1**. Codex and Pi workflows are unaffected.

## Quick start

### 1. Re-run `archon setup`

The fastest path is the wizard:

```bash
archon setup
```

Pick Claude as one of your assistants. After the assistant step, you'll be asked whether to install CodeGraph and whether to enable it by default for new codebases. Accept both prompts and the wizard:

1. Runs the CodeGraph installer (`--target=none --yes` — CodeGraph does **not** register itself in `~/.claude.json`; Archon owns the MCP attach).
2. Writes `ARCHON_CODEGRAPH_ENABLED=true` to `~/.archon/.env`.
3. Merges `codegraph.enabled: true` into `~/.archon/config.yaml`.
4. Appends `.codegraph` to `worktree.copyFiles` so the index travels with each worktree.

### 2. Manual install (alternative)

If you prefer not to re-run the wizard:

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh -s -- --target=none --yes
```

**Windows (PowerShell):**

```powershell
& { irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex } --target=none --yes
```

Then enable it for Archon:

```bash
echo "ARCHON_CODEGRAPH_ENABLED=true" >> ~/.archon/.env
```

Add the YAML entries manually if you want CodeGraph to bootstrap newly-registered codebases. See the [reference page](/reference/codegraph/) for the config schema.

### 3. Index existing codebases

For each codebase you've already registered with Archon:

```bash
archon codegraph index path/to/codebase
```

This runs `codegraph init -i` against the source path so the next workflow run has a prebuilt index to copy from.

### 4. Verify

```bash
archon doctor
```

You should see a line like `✓ codegraph: codegraph (v0.18.x)`.

## When to opt out

CodeGraph is on by default once enabled. To opt out for a specific workflow:

```yaml
name: my-workflow
codegraph: false
nodes: [...]
```

Or for a single node:

```yaml
nodes:
  - id: my-node
    prompt: "..."
    codegraph: false
```

The 3-tier resolution (`node ?? workflow ?? config.codegraph.enabled`) mirrors Archon's existing `provider` / `model` resolution.

## What this changes for your workflows

Once enabled, your Claude workflows will see additional MCP tools prefixed with `mcp__codegraph__*` — `codegraph_search`, `codegraph_callers`, `codegraph_context`, etc. The Claude SDK injects them automatically; no per-node configuration needed. Existing `mcp:` entries in your nodes still take precedence on key collisions.

## Next steps

- [CodeGraph reference](/reference/codegraph/) — full config schema, CLI commands, log catalog, error handling.
- [Configuration reference](/reference/configuration/) — where the new `codegraph` block fits in `config.yaml`.
