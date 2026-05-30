# CodeGraph Integration — Engine-Level Design

**Date**: 2026-05-30
**Author**: brainstormed with Selvakumar Esra (selvakumar.esra@gmail.com)
**Status**: Design — pending implementation
**Scope**: Engine-level extension to `@archon/core`, `@archon/workflows`, `@archon/providers`, and `@archon/cli`. Plus a new opt-in step in the `archon setup` wizard. **`@archon/isolation` is not touched** — codegraph rides on the existing `worktree.copyFiles` config.

---

## Overview

Extend Archon so that every Claude-flavored workflow node can transparently use
[CodeGraph](https://github.com/colbymchenry/codegraph) — a local tree-sitter +
SQLite + FTS5 code knowledge graph — as an MCP server. The goal is to capture
codegraph's reported gains (~25% cheaper, ~57% fewer tokens, ~62% fewer tool
calls) on Archon's Claude workflows without requiring workflow authors to
hand-wire MCP entries on every node.

Configuration follows the three-tier resolution Archon already uses for
provider and model: `node.codegraph ?? workflow.codegraph ?? config.codegraph.enabled`.
The default is `false` (additive, non-breaking) and the `archon setup` wizard
offers to install the codegraph binary and flip the default to `true`.

### Goals

1. **Zero-friction default**: turning on `codegraph.enabled: true` in
   `.archon/config.yaml` (or accepting the prompt during `archon setup`) makes
   every Claude node in every workflow benefit automatically.
2. **Surgical override**: a workflow or a single node can opt out
   (`codegraph: false`) without touching global config.
3. **Worktree-correct freshness**: codegraph sees the worktree the workflow is
   editing — not the source repo — so its watcher and connect-time
   reconciliation absorb both intra-run and inter-run edits.
4. **Fail open**: missing binary, failed index build, copy errors, daemon
   crashes — none of these stop a workflow run. They downgrade silently with
   structured warn/error logs.
5. **Provider-agnostic contract**: the `codegraph` flag lives on
   `SendQueryOptions`; only `ClaudeProvider` acts on it today. Other providers
   simply ignore it.

### Non-Goals (v1)

1. **Codex / Pi support**. Both lack Archon-side MCP wiring. Adding them means
   building a pre-baked-context pipeline, which loses the "agent queries
   directly" property that codegraph's own docs flag as the source of its
   benchmark wins.
2. **Min-files threshold to auto-disable on tiny repos**. YAGNI; revisit if
   users report regressions.
3. **Custom codegraph tool allowlist**. Claude's existing `allowed_tools` /
   `denied_tools` already accept `mcp__codegraph__*` patterns.
4. **Per-workflow shared daemon across nodes**. Codegraph's connect-time
   reconciliation is fast; sharing a daemon is premature optimization.
5. **Cross-codebase index sharing**. Each codebase keeps its own `.codegraph/`.
6. **Web UI panel for codegraph status**. CLI (`archon codegraph status`) is
   sufficient for v1.
7. **Telemetry for per-tool codegraph usage**. Requires deeper hooks into the
   Claude SDK response stream.
8. **Encrypting `.codegraph/`**. Filesystem permissions are sufficient.

---

## Architecture

### Package boundaries (no new packages, no new cycles)

```
┌─────────────────────────────────────────────────────────────────┐
│ @archon/core         config schema, codebase bootstrap service │
│    └── codegraph: { enabled, autoIndex, watchDebounceMs }      │
│    └── bootstrapCodegraphIndex(codebase)                       │
│    └── detectCodegraphBinary() [process-cached]                │
├─────────────────────────────────────────────────────────────────┤
│ @archon/workflows    workflow + node schema gain optional       │
│    `codegraph?: boolean`. Resolution helper exported.           │
│    (dag-executor is a pass-through — no codegraph branches.)    │
├─────────────────────────────────────────────────────────────────┤
│ @archon/providers/claude                                        │
│    NEW: mcp-extensions.ts (registry)                            │
│    NEW: codegraph-mcp.ts (registers via the registry)           │
│    EDIT: provider.ts — one-time loop over registered extensions │
│          collectClaudeMcpExtensions(ctx) → merge into mcpServers│
│    Future MCP integrations register themselves; no more edits.  │
├─────────────────────────────────────────────────────────────────┤
│ @archon/isolation   UNCHANGED                                   │
│    Codegraph rides on existing `worktree.copyFiles` config.     │
├─────────────────────────────────────────────────────────────────┤
│ @archon/cli                                                     │
│    archon codegraph index|sync|status [<codebase>]              │
│    archon setup  — new prompt: install codegraph + enable      │
│    archon doctor — codegraph binary + index checks              │
│    NEW: setup/yaml-merge.ts — small util to write config.yaml   │
└─────────────────────────────────────────────────────────────────┘
```

Per the engineering principles in `CLAUDE.md`:

- **SRP**: each touched module owns one concern (config schema, lifecycle,
  provider option, worktree copy, CLI).
- **YAGNI**: no abstraction layer for "other code-graph backends". One concrete
  integration. If a second backend appears, refactor then.
- **Fail fast at boundaries, fail open at runtime**: Zod rejects malformed
  config at load time; missing binary at runtime warns and degrades.
- **Reproducibility**: codegraph's own deterministic indexing + Archon's
  worktree copy semantics keep behavior consistent across runs.

### Resolution order

```
node.codegraph  ?? workflow.codegraph  ?? config.codegraph.enabled  ?? false
```

Identical to how `provider` and `model` resolve today, so the mental model is
already familiar to Archon users.

---

## Components

### New files

| Path | Owns |
|---|---|
| `packages/core/src/schemas/codegraph-config.ts` | Zod `codegraphConfigSchema` — `{ enabled, autoIndex, watchDebounceMs }`. Re-exported via `packages/core/src/schemas/index.ts`. |
| `packages/core/src/services/codegraph-bootstrap.ts` | `bootstrapCodegraphIndex(codebase)` — runs `codegraph init -i` against `<source>` when enabled + binary present. |
| `packages/core/src/services/codegraph-detect.ts` | `detectCodegraphBinary()` — probes `codegraph --version`; module-level cached result; returns `{ found, path, version } \| null`. |
| `packages/workflows/src/utils/resolve-codegraph.ts` | `resolveCodegraph(node, workflow, config)` — pure 3-tier `??` helper. |
| `packages/providers/src/claude/codegraph-mcp.ts` | `buildCodegraphMcpEntry(opts)` — returns the synthesized stdio MCP server entry. **Self-registers** with `mcp-extensions.ts` at module load. Pure. |
| `packages/providers/src/claude/mcp-extensions.ts` | **Extension registry**: a tiny module exposing `registerClaudeMcpExtension(fn)` and `collectClaudeMcpExtensions(ctx)`. `ClaudeProvider` calls the collector once per `sendQuery()`. New MCP integrations register themselves here without touching `provider.ts` ever again. |
| `packages/cli/src/commands/codegraph.ts` | `archon codegraph index\|sync\|status [<codebase>]` — thin wrappers over the binary, scoped to a codebase's source path. |
| `packages/cli/src/setup/codegraph-step.ts` | New step in the setup wizard: detect, offer install, run install, verify, write enable flags. |
| `packages/cli/src/setup/yaml-merge.ts` | Tiny utility to read-merge-write `~/.archon/config.yaml` (load YAML, deep-merge the new keys, preserve user-added keys, write back with timestamped backup). Used by the codegraph step to set `worktree.copyFiles` — and available for any future wizard step that needs YAML writes. |

### Touched files (minimized for upstream-merge friendliness)

| Path | What changes | Edit shape |
|---|---|---|
| `packages/core/src/config/` (loader + types) | Slot `codegraph` into `MergedConfig`. Defaults: `{ enabled: false, autoIndex: true, watchDebounceMs: 2000 }`. | Additive Zod field + default. |
| `packages/workflows/src/schemas/workflow.ts` | Add `codegraph: z.boolean().optional()` at workflow level. | One Zod field. |
| `packages/workflows/src/schemas/dag-node.ts` | Add `codegraph: z.boolean().optional()` at node level. | One Zod field. |
| `packages/workflows/src/dag-executor.ts` | Pass through the full options bag (workflow, node, config) to provider. **No codegraph-specific logic here.** Resolution happens inside the provider. | Pass-through only — no codegraph branch in the executor. |
| `packages/providers/src/types.ts` | `SendQueryOptions` already accepts the node and workflow context; no new field needed. Provider does resolution internally. | No edit if context is already passed; one field otherwise. |
| `packages/providers/src/claude/provider.ts` | **One-time edit**: after building the base `mcpServers`, call `collectClaudeMcpExtensions(ctx)` and merge the result. Future MCP integrations (codegraph + anything else) register themselves with the extension module — `provider.ts` is never edited again. | One small loop, then frozen. |
| `packages/core/src/services/codebases.ts` (or registration handler) | After successful clone/link, if `config.codegraph.enabled && config.codegraph.autoIndex`, call `bootstrapCodegraphIndex(codebase)`. | One call site. |
| `packages/cli/src/commands/doctor.ts` | Add a codegraph row: binary present + version + index exists per codebase. | Additive row in output. |
| `packages/cli/src/commands/setup.ts` | Invoke the new `codegraph-step` immediately after the AI assistant step. The step is skipped unless the selected assistant is `claude` (codegraph is Claude-only in v1). | One conditional step insertion. |

**Eliminated:** `packages/isolation/src/providers/worktree.ts` — no longer touched. Codegraph relies on the existing `worktree.copyFiles` config option (documented in `CLAUDE.md`), and the setup wizard writes `.codegraph` into that list automatically. **Zero new code in the isolation package.**

### What doesn't change

- **No new provider**. CodeGraph is an MCP server inside Claude, not a peer of
  Claude/Codex/Pi.
- **No new node type**. Same `command` / `prompt` / `bash` / `script` / `loop` /
  `approval` / `cancel`. Just an optional flag.
- **No DB schema change**. The codegraph state lives on disk in `.codegraph/`
  per worktree.
- **No new env precedence rules**. `CODEGRAPH_*` env vars are set on the
  spawned MCP child only; Archon does not load them itself.

---

## Data Flow

### A. Setup wizard (one-time per machine)

```
archon setup
       │
       ▼
[database step]
       │
       ▼
[AI assistant step] → selectedAssistant: 'claude' | 'codex' | ...
       │
       ├─ selectedAssistant !== 'claude' → skip codegraph-step entirely
       │
       └─ selectedAssistant === 'claude'
              │
              ▼
codegraph-step:
       │
       ▼
detectCodegraphBinary()
       │ found      → ask: "Enable codegraph for new codebases? [Y/n]"
       │ not found  → ask: "Install codegraph now? [Y/n]"
       │              ├─ yes → platform-specific install:
       │              │       macOS/Linux: curl -fsSL <install.sh> | sh
       │              │                    OR: bunx -y @colbymchenry/codegraph install --target=none --yes
       │              │       Windows:      irm <install.ps1> | iex
       │              │       → re-probe `codegraph --version` to verify
       │              │       → on success: ask the enable question above
       │              └─ no  → skip, leave config default (enabled: false)
       ▼
if enabled chosen:
       (1) write ARCHON_CODEGRAPH_ENABLED=true into ~/.archon/.env
           (existing .env merge utility — keeps backwards compatibility)
       (2) yaml-merge ~/.archon/config.yaml:
              codegraph: { enabled: true }
              worktree:  { copyFiles: ['.codegraph'] }
           (codegraph rides on the existing worktree.copyFiles mechanism)
```

Config loader reads `ARCHON_CODEGRAPH_ENABLED` as an override on top of
`config.codegraph.enabled` — matches Archon's existing "env vars override
matching `config.yaml` values" rule. The wizard writes to **both** the env
file and the YAML so each surface stays self-consistent: a user who later
edits `config.yaml` by hand sees the codegraph setting where they expect it,
and a user who unsets the env var sees the YAML value take over.

**Critical**: writing `.codegraph` into `worktree.copyFiles` is how the
codegraph index travels from source → worktree. This avoids any edit to
`packages/isolation/src/providers/worktree.ts` — the existing
`worktree.copyFiles` machinery already does the copy.

The install always uses `--target=none --yes` so codegraph does **not**
register itself in `~/.claude.json`. Archon's per-node MCP injection is the
single source of truth for when codegraph is active during workflows. The
user's interactive Claude Code sessions remain untouched.

### B. Codebase registration (one-time per repo)

```
user → POST /api/codebases  OR  archon CLI register
       │
       ▼
codebases.ts
       │  clone or symlink → ~/.archon/workspaces/<repo>/source/
       ▼
config.codegraph.enabled && config.codegraph.autoIndex ?
       │ no  → return
       │ yes
       ▼
detectCodegraphBinary()
       │ not found → log.warn('codegraph.binary_missing'), return
       │ found
       ▼
bootstrapCodegraphIndex(codebase)
       │  spawn: codegraph init -i  (cwd = <source>)
       │  blocking with 10 min timeout; progress streamed to logs
       ▼
log.info({ durationMs, files, symbols }, 'codegraph.index_completed')
```

Registration is **not** blocked by codegraph failure. User can rerun via
`archon codegraph index <codebase>`.

### C. Worktree creation (every workflow run)

**No new code in `@archon/isolation`.** The integration leverages the existing
`worktree.copyFiles` machinery, which the setup wizard populated with
`.codegraph` in step A.

```
worktree.create(codebase, branch)
       │  git worktree add ... <worktree>
       ▼
EXISTING: worktree.copyFiles iteration
       │  for each entry in config.worktree.copyFiles:
       │     if entry exists in <source>: copy to <worktree>
       │     else: skip (existing behavior)
       │
       │  '.codegraph' is just one of these entries — same code path as any
       │  other file/dir the user wants copied. No special-casing.
       ▼
EXISTING log: worktree creation completed
```

Codegraph's connect-time reconciliation handles the divergence between source
and worktree on the first MCP call.

If `.codegraph` is not in `worktree.copyFiles` (codegraph disabled, user
hand-edited config), the copy doesn't happen and codegraph will build the
index fresh on first MCP connect — slower but correct.

### D. Claude node execution

**dag-executor.ts contains no codegraph branches.** It passes the
`{ workflow, node, config, cwd }` context to the provider it already passes
today. All resolution happens inside Claude's provider via the extension
registry.

```
dag-executor.ts → ClaudeProvider.sendQuery({ workflow, node, config, cwd, ... })
       │
       │  (executor is unchanged — no codegraph-specific logic)
       ▼
ClaudeProvider.sendQuery:
       │  build baseMcpServers from node.mcp (existing behavior)
       │  build ctx = { workflow, node, config, cwd }
       │  extensionEntries = collectClaudeMcpExtensions(ctx)
       │  claudeMcpServers = { ...baseMcpServers, ...extensionEntries }
       │
       └─ Claude SDK call with merged mcpServers (existing call shape)
                │
                ▼
        (provider.ts edit ends here. Codegraph isn't named in this file.)
```

Inside `mcp-extensions.ts`, the codegraph module registered itself at load:

```
codegraph-mcp.ts:
   registerClaudeMcpExtension((ctx) => {
       const effective = resolveCodegraph(ctx.node, ctx.workflow, ctx.config);
       if (!effective) return null;
       if (!detectCodegraphBinary()) {
           log.warn.once('codegraph.binary_missing');
           return null;
       }
       return {
         codegraph: {
           type: 'stdio',
           command: detectCodegraphBinary().path,
           args: ['serve', '--mcp'],
           cwd: ctx.cwd,                                  // the worktree
           env: { CODEGRAPH_WATCH_DEBOUNCE_MS: String(ctx.config.codegraph.watchDebounceMs) },
         },
       };
   });
```

```
Claude SDK starts stdio child (when extension produced a non-null entry):
       codegraph serve --mcp   cwd = <worktree>
            │
            ▼
       Codegraph: connect-time (mtime+hash) reconciliation → watcher armed →
                  tools available to the agent.
            │
            ▼
       Agent uses codegraph_context/explore/callers/... directly.
       Edits the agent makes are caught by the watcher, debounced, and
       reflected in the next tool call (⚠️ staleness banner during window).
            │
            ▼
       Node returns → stdio child exits with Claude SDK call.
       No persistent daemon to manage.
```

**The shape of `mcp-extensions.ts`:**

```ts
// packages/providers/src/claude/mcp-extensions.ts
type ClaudeMcpCtx = { workflow: WorkflowDefinition; node: DagNode; config: MergedConfig; cwd: string };
type ClaudeMcpExtension = (ctx: ClaudeMcpCtx) => Record<string, McpServerEntry> | null;

const extensions: ClaudeMcpExtension[] = [];
export function registerClaudeMcpExtension(fn: ClaudeMcpExtension): void { extensions.push(fn); }
export function collectClaudeMcpExtensions(ctx: ClaudeMcpCtx): Record<string, McpServerEntry> {
  return Object.assign({}, ...extensions.map((fn) => fn(ctx)).filter(Boolean));
}
```

That's the entirety of `provider.ts`'s contract with the integration. Future
MCP integrations (linter graphs, dependency-vuln scanners, anything) follow
the same `registerClaudeMcpExtension` pattern. `provider.ts` is touched
**once**, ever.

### Freshness properties (preserved by design)

| Property | How it's preserved |
|---|---|
| Freshness intra-run | codegraph's file watcher (`CODEGRAPH_WATCH_DEBOUNCE_MS`) |
| Freshness inter-node | each node spawns a fresh stdio child → connect-time reconciliation |
| Freshness inter-run | new worktree → fresh copy from source → reconciliation against worktree state |
| Isolation across worktrees | each worktree has its own `.codegraph/`; parallel workflows cannot collide |
| Source repo cleanliness | only `<source>/.codegraph/` added; existing copy-on-create excludes it from `git status` |

---

## Error Handling

All paths fail open. **No silent swallowing — every degraded path logs a
structured warn/error.** Event names follow Archon's `{domain}.{action}_{state}`
convention from `CLAUDE.md`.

### Surface 1 — `codegraph` binary missing or unusable

| Trigger | Behavior |
|---|---|
| Setup wizard: install declined | Config default stays `enabled: false`. Nothing else happens. |
| Setup wizard: install fails (network, permission denied) | `log.warn('codegraph.install_failed', { err })`. Setup continues. User can rerun later. |
| Binary not on PATH at codebase register | `log.warn('codegraph.binary_missing', { phase: 'bootstrap' })` once per Archon process. Skip indexing. Registration succeeds. |
| Binary not on PATH at Claude node execute | `log.warn('codegraph.binary_missing', { phase: 'claude_node', nodeId, workflow })` once per process. Skip MCP attach. Node runs without codegraph. |
| Binary exists but `codegraph --version` fails or wrong shape | Same as missing. Treat as unusable. |
| `archon doctor` | Reports `[FAIL] codegraph: binary not found on PATH` plus the install hint. |

Detection is cached at module scope (`codegraph-detect.ts`) — one probe per
Archon process.

### Surface 2 — Index lifecycle errors

| Trigger | Behavior |
|---|---|
| `codegraph init -i` exits non-zero at registration | `log.error('codegraph.index_failed', { stderr, durationMs })`. Registration succeeds. Recovery: `archon codegraph index <codebase>`. |
| `codegraph init -i` times out (10 min) | Kill child, `log.error('codegraph.index_timeout')`. Same recovery. |
| `<source>/.codegraph` missing when worktree is created | Existing `worktree.copyFiles` machinery skips silently. Codegraph will build fresh in the worktree on first MCP connect — slower but correct. No codegraph-specific log; the existing worktree-copy logger already covers this. |
| `worktree.copyFiles` copy of `.codegraph` fails (permission denied, disk full) | Existing worktree-copy error path applies. Worktree create succeeds (existing behavior). First MCP connect rebuilds from scratch. No codegraph-specific code involved. |

**Never fail a worktree create because of codegraph.** Worktrees are precious;
codegraph is an optimization.

### Surface 3 — Runtime daemon errors

| Trigger | Behavior |
|---|---|
| `codegraph serve --mcp` child crashes mid-node | Claude SDK surfaces the MCP disconnect. Agent gets normal MCP-unavailable behavior (falls back to Read/Grep). `log.error('codegraph.mcp_disconnected', { nodeId, runId })`. |
| Connect-time reconciliation slow (>30 s on big diff) | No special handling — codegraph's own concern. We do not wrap in a timeout. |
| Stale index referenced by agent (file edited mid-window) | Codegraph's own `⚠️` staleness banner instructs the agent to `Read` directly. No Archon intervention. |

### Schema / config validation (load time, fail-fast)

| Trigger | Behavior |
|---|---|
| `codegraph:` set to non-boolean in workflow YAML | Zod rejects. Surfaced in `archon workflow list` errors. |
| `codegraph.watch_debounce_ms` outside `[100, 60000]` | Zod refinement clamps with `log.warn` and uses the clamped value. (Matches codegraph's own clamp.) |
| `codegraph.autoIndex: true` but no source repo | Bootstrap skipped, `log.warn('codegraph.bootstrap_skipped', { reason: 'no_source' })`. |

### What we deliberately don't do

- **Don't retry codegraph operations from Archon.** Codegraph has its own retry
  and reconciliation semantics; double-wrapping causes pathological behavior.
- **Don't auto-`codegraph sync` between nodes.** The watcher + connect-time
  reconciliation already covers every edit path.
- **Don't fail workflows because codegraph fails.** Token efficiency is an
  optimization; agentic execution is the product.

### Log event catalog

```
codegraph.install_started / .install_completed / .install_failed
codegraph.binary_missing
codegraph.index_started / .index_completed / .index_failed / .index_timeout
codegraph.mcp_attached / .mcp_disconnected
codegraph.bootstrap_skipped
```

Standard Pino fields throughout (`{ codebaseId, runId, nodeId, err, durationMs }`).

---

## Testing

Test isolation follows Archon's per-package `bun --filter '*' test` model. Any
new `mock.module()` slot piggybacks on an existing batch in the relevant
package's `package.json` to avoid expanding the matrix.

### Unit tests

| Package | File | Coverage |
|---|---|---|
| `@archon/core` | `schemas/codegraph-config.test.ts` | Zod schema: defaults, valid + invalid `enabled` / `autoIndex` / `watchDebounceMs`, clamp boundaries (`100`, `60000`). |
| `@archon/core` | `services/codegraph-detect.test.ts` | `detectCodegraphBinary()` — found / missing / unusable; module-level cache hit on second call. Mocks `execFileAsync`. |
| `@archon/core` | `services/codegraph-bootstrap.test.ts` | Bootstrap happy path; binary missing → warn + skip; non-zero exit → error logged + registration still succeeds; timeout → kill + error logged. |
| `@archon/workflows` | `utils/resolve-codegraph.test.ts` | Resolution table — every combination of node / workflow / config flag → expected effective value (8 cases). Pure function. |
| `@archon/workflows` | `schemas/workflow.test.ts` (extend) | `codegraph: true / false / undefined / "yes"` → valid / valid / valid / reject. |
| `@archon/workflows` | `schemas/dag-node.test.ts` (extend) | Same matrix at node level. |
| `@archon/providers` | `claude/codegraph-mcp.test.ts` | `buildCodegraphMcpEntry()` shape (when called by the registered extension) — stdio command, args, cwd, `CODEGRAPH_WATCH_DEBOUNCE_MS` passthrough. Pure. Also covers the registration side: codegraph-mcp registers itself via `mcp-extensions.ts` at module load. |
| `@archon/providers` | `claude/mcp-extensions.test.ts` | Registry mechanics — `registerClaudeMcpExtension` accumulates handlers; `collectClaudeMcpExtensions(ctx)` merges results; handlers returning `null` are skipped; multiple handlers' entries shallow-merge with later wins. Pure. |
| `@archon/providers` | `claude/provider.test.ts` (extend) | The extension-loop edit in `provider.ts`: registry is consulted; returned entries are merged after `node.mcp`; existing entries preserved; user node mcp entries with the same key as an extension entry win (caller takes precedence). |
| `@archon/cli` | `commands/codegraph.test.ts` | `archon codegraph index\|sync\|status` — argv parsing, binary missing → exit code + message, happy path → spawn + exit 0. |
| `@archon/cli` | `setup/codegraph-step.test.ts` | Setup wizard step — detection branches; install accepted → install spawned with correct args; install declined → no spawn; install failure → warn + setup continues. Mocks the platform installer. Verifies both `.env` (`ARCHON_CODEGRAPH_ENABLED=true`) and `config.yaml` (`codegraph.enabled: true` + `worktree.copyFiles` contains `.codegraph`) are written when user accepts. |
| `@archon/cli` | `setup/yaml-merge.test.ts` | YAML merge utility — preserves user-added keys, deep-merges nested objects, appends to arrays without dupes, writes timestamped backup before overwrite. |
| `@archon/cli` | `commands/doctor.test.ts` (extend) | Codegraph row present; FAIL when binary missing; PASS with version when present. |

### Integration test

| File | Coverage |
|---|---|
| `packages/workflows/src/__tests__/codegraph-integration.test.ts` | Skipped when `codegraph` binary not present. Spins up a tiny fixture repo (5 TS files, 2 importing each other), runs a smoke workflow, asserts: (1) `.codegraph/` exists in the worktree, (2) the workflow run completes successfully, (3) the structured log includes `codegraph.mcp_attached`. |

Fixture workflow `codegraph-smoke.yaml` lives under
`packages/workflows/src/__fixtures__/` — not a default, just a test artifact.

### Manual smoke (developer + CI matrix)

A single advisory script added to `bun run validate` precheck:

```bash
# scripts/check-codegraph-smoke.sh
test -x "$(command -v codegraph)" || { echo "skip: codegraph not on PATH"; exit 0; }
test -d ~/.archon/workspaces/<test-fixture>/source/.codegraph \
  || archon codegraph index <test-fixture>
archon workflow run codegraph-smoke --branch ci/codegraph "trace foo"
```

Exit 0 when codegraph absent so CI lanes without it still pass; the lane with
codegraph asserts the run succeeded.

### What we deliberately don't test

- **Codegraph's own correctness** — their test suite.
- **Token-saving claims** — non-deterministic; would flake. Documented in
  codegraph's benchmarks, trusted here.
- **MCP protocol details** — Claude SDK handles MCP.
- **Concurrent worktree parity** — per-directory isolation is a design
  property, not something a single test would meaningfully validate.

### Budget

| Layer | Est. count | Est. added runtime |
|---|---|---|
| Unit | ~25–30 small tests | < 5 s |
| Integration | 1 skippable test | < 30 s when run |
| Manual smoke | 1 advisory script | < 1 min when run |

Stays within Archon's existing per-package test budgets. No flaky-timing
risks: all signals are exit codes or stdout markers; no `setTimeout` polling.

---

## Open Questions / Future Work

These are deferred but tracked for re-evaluation:

| Item | Re-evaluate when |
|---|---|
| Codex / Pi support via pre-baked context node | Demand surfaces; OR Archon adds first-class MCP support for non-Claude providers. |
| Min-files threshold to auto-disable on tiny repos | Users report regressions on small codebases. |
| Web UI panel showing codegraph status per codebase | First user request for a visual. |
| Anonymous telemetry on per-tool codegraph usage | Telemetry redesign happens for unrelated reasons. |
| Multi-language project tuning (force which languages to index) | Codegraph exposes Archon-relevant config knobs. |
| Pluggable code-graph backends (abstract behind an interface) | A credible second backend appears. |

---

## Upstream Merge Strategy

This design was deliberately shaped to minimize merge conflicts with the
upstream `coleam00/Archon` repository. The principles:

1. **New behavior lives in new files.** Six of the eight code units in this
   feature are net-new files. Upstream cannot conflict with files it doesn't
   know about.
2. **Existing files take additive edits only.** Every edit to an existing
   file is a small additive change (a Zod field, a default in a config, a row
   in a CLI command's output) — not a refactor of existing logic.
3. **Use existing extension points wherever they exist.** Codegraph rides on
   `worktree.copyFiles` instead of editing the worktree provider. Zero touch
   to `@archon/isolation`.
4. **Build a new extension point where one doesn't exist, then never edit
   again.** The Claude provider gets a one-time `mcp-extensions.ts` registry
   loop. After that single edit, any future MCP integration — codegraph or
   otherwise — slots in via `registerClaudeMcpExtension(...)` without
   touching `provider.ts`.
5. **Push resolution into the provider, not the executor.** The DAG
   executor remains agnostic of codegraph. Provider-internal resolution
   means `dag-executor.ts` doesn't grow a codegraph-shaped branch.

### Conflict-risk audit (after refactor)

| Touched file | Edit shape | Expected upstream conflict rate |
|---|---|---|
| `packages/core/src/config/` | One Zod field + default | Low — config shape rarely refactored |
| `packages/workflows/src/schemas/workflow.ts` | One optional Zod field | Low — additive |
| `packages/workflows/src/schemas/dag-node.ts` | One optional Zod field | Low — additive |
| `packages/workflows/src/dag-executor.ts` | None (pass-through only) | None — no edit |
| `packages/providers/src/claude/provider.ts` | One-time extension-loop edit | Low after one edit; zero on subsequent integrations |
| `packages/core/src/services/codebases.ts` | One conditional call | Low |
| `packages/cli/src/commands/doctor.ts` | One row in output | Low — output is additive |
| `packages/cli/src/commands/setup.ts` | One conditional step insertion | Low — matches existing setup pattern |

**No `Hot` rows remain after refactor.** Compare with the pre-refactor design,
which had three hot rows (`dag-executor.ts`, `claude/provider.ts`,
`worktree.ts`).

### Recommended fork-maintenance practice

1. **Commit boundaries**: one commit per touched file with a `[codegraph]`
   prefix in the subject. Makes `git rebase --onto upstream/main` mechanical.
2. **`git rerere`**: enable so any conflict resolution is remembered for the
   next sync.
3. **Periodic upstream merges into `dev`**: don't let drift accumulate.
4. **No surprise refactors**: keep the touched files' edits surgical — never
   bundle a refactor into a codegraph commit.

### Future fork-friendly refinement

If upstream ever accepts a generic "provider extension point" abstraction,
the `mcp-extensions.ts` module could be moved to `@archon/providers/types`
(or a new `@archon/extensions` package) and become a first-class API. Until
then, it lives inside `@archon/providers/claude` as a Claude-specific
detail.

---

## Rollout

1. **Land schema + config + detect/bootstrap helpers** in `@archon/core` +
   `@archon/workflows`. Defaults to `false`, no behavior change. Ship as a
   patch.
2. **Land the extension registry + codegraph extension** in
   `@archon/providers/claude` (new `mcp-extensions.ts` + `codegraph-mcp.ts` +
   the one-time `provider.ts` loop). Still gated by the flag; existing
   behavior unchanged when off.
3. **Land codebase-register bootstrap call** in `@archon/core`. One conditional
   call in registration.
4. **Land CLI codegraph command + `doctor` row**.
5. **Land setup-wizard step + yaml-merge utility**. End-user-visible behavior
   first lights up here.
6. **Update docs** at `packages/docs-web/` — a new "CodeGraph" guide under
   `getting-started/` and a reference page under `reference/`.

Each step is independently reversible (delete the new files, revert the touched
files). The whole feature can be disabled at any time by setting
`codegraph.enabled: false` in config — no migration required.

---

## References

- CodeGraph repo: <https://github.com/colbymchenry/codegraph>
- CodeGraph docs: <https://colbymchenry.github.io/codegraph/>
- Archon CLAUDE.md — engineering principles, schema conventions, test isolation
  rules.
- Archon `.claude/skills/archon/references/dag-advanced.md` — existing per-node
  MCP wiring (the pattern we extend).
