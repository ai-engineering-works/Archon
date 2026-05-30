---
title: CodeGraph
description: Configuration schema, CLI commands, and operational reference for the CodeGraph integration.
category: reference
area: clients
audience: [user, developer]
status: current
sidebar:
  order: 9
---

CodeGraph reference — for the getting-started guide, see [Getting started → CodeGraph](/getting-started/codegraph/).

## Configuration

CodeGraph configuration lives under the `codegraph` block in `~/.archon/config.yaml`:

```yaml
codegraph:
  enabled: true        # default: false
  autoIndex: true      # default: true — run `codegraph init -i` on codebase register
  watchDebounceMs: 2000  # default: 2000; clamped to [100, 60000]
```

### Resolution order

The effective per-node flag resolves through three tiers:

```
node.codegraph ?? workflow.codegraph ?? config.codegraph.enabled ?? false
```

This mirrors how Archon's `provider` and `model` resolve today.

### Environment variable override

```bash
ARCHON_CODEGRAPH_ENABLED=true
```

Takes precedence over the YAML `codegraph.enabled` when present. The setup wizard writes both.

## CLI commands

```bash
archon codegraph index [<path>]   # build the index (codegraph init -i)
archon codegraph sync  [<path>]   # incremental sync
archon codegraph status [<path>]  # show index health
```

When no path is given, the command runs in the current working directory. Use `--cwd <path>` (top-level flag) to scope from elsewhere.

## Worktree integration

`.codegraph` should be in your `worktree.copyFiles` so each worktree gets a pre-warmed index:

```yaml
worktree:
  copyFiles:
    - .codegraph
```

The setup wizard adds this automatically. Without it, the first MCP connect in a new worktree rebuilds the index from scratch (slower but correct — codegraph's connect-time reconciliation handles it).

## Log catalog

All codegraph-related events use the `codegraph.` prefix:

| Event | Level | When it fires |
|---|---|---|
| `codegraph.binary_detected` | info | First successful `codegraph --version` probe in this process. |
| `codegraph.binary_missing` | warn | Detection failed; logged at most once per process (with `phase` field). |
| `codegraph.binary_probe_failed` | debug | Non-ENOENT detection error (permission denied, timeout, etc.). |
| `codegraph.index_started` | info | `codegraph init -i` spawned. |
| `codegraph.index_completed` | info | Index built. Includes `durationMs`. |
| `codegraph.index_failed` | error | `init -i` exited non-zero. Includes `stderr`. |
| `codegraph.index_timeout` | error | `init -i` killed after 10 minutes (elapsed-time heuristic, not just `killed: true`). |
| `codegraph.mcp_attached` | info | Extension produced an MCP entry for a Claude node. |
| `codegraph.bootstrap_skipped` | warn | `loadConfig` threw during codebase registration. Includes `phase: 'registration'`. |

## Doctor

```bash
archon doctor
```

The codegraph row reports:
- **pass** — binary present, version reported.
- **skip** — user not opted in (neither env var nor YAML enabled).
- **fail** — opted in but binary missing; install hint included.

The doctor invalidates the detection cache before probing so a freshly-installed binary shows up immediately.

## Error handling

CodeGraph integration always fails open:

| Condition | Behavior |
|---|---|
| Binary missing | Extension returns no MCP entry; warn once. |
| Index build fails | Codebase registration succeeds. Recovery: `archon codegraph index <path>`. |
| Index build times out | Killed after 10 min. Same recovery. |
| Worktree copy fails | Worktree creation succeeds (existing `worktree.copyFiles` machinery handles it). |
| MCP daemon crashes mid-node | Claude SDK falls back to Read/Grep. Node continues. |

## Constraints (v1)

- **Claude only.** Codex and Pi workflows do not load the MCP extension. `config.codegraph.enabled` has no effect on them.
- **One binary on PATH.** The detection probes `codegraph` (no path override). If multiple installs exist, the first one on PATH wins.
