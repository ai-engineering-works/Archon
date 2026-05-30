# CodeGraph Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in CodeGraph MCP integration so Claude-flavored Archon
workflow nodes get ~25% cheaper / ~57% fewer tokens / ~62% fewer tool calls
on code-structural queries — without workflow authors having to wire MCP
manually.

**Architecture:** Three-tier resolution (`node.codegraph ?? workflow.codegraph
?? config.codegraph.enabled ?? false`) mirroring how `provider` / `model`
resolve today. The Claude provider gets a one-time MCP-extensions registry
loop; the codegraph extension registers itself at module load.
`@archon/isolation` is **not touched** — `.codegraph/` rides on the existing
`worktree.copyFiles` config.

**Tech Stack:** TypeScript (strict), Bun 1.3.x, `@hono/zod-openapi` for Zod
schemas, Pino for logs, native `child_process` for the `codegraph` binary,
codegraph 0.x as an external CLI/MCP server.

**Spec:** [`docs/superpowers/specs/2026-05-30-codegraph-integration-design.md`](../specs/2026-05-30-codegraph-integration-design.md)

---

## File Structure

### New files
| Path | Purpose |
|---|---|
| `packages/core/src/services/codegraph-detect.ts` | Detect the `codegraph` binary (process-cached) |
| `packages/core/src/services/codegraph-detect.test.ts` | Tests |
| `packages/core/src/services/codegraph-bootstrap.ts` | `bootstrapCodegraphIndex(codebase)` — runs `codegraph init -i` against `<source>` |
| `packages/core/src/services/codegraph-bootstrap.test.ts` | Tests |
| `packages/workflows/src/utils/resolve-codegraph.ts` | Pure 3-tier `??` helper |
| `packages/workflows/src/utils/resolve-codegraph.test.ts` | Tests |
| `packages/providers/src/claude/mcp-extensions.ts` | Extension registry |
| `packages/providers/src/claude/mcp-extensions.test.ts` | Tests |
| `packages/providers/src/claude/codegraph-mcp.ts` | Codegraph extension that registers via the registry |
| `packages/providers/src/claude/codegraph-mcp.test.ts` | Tests |
| `packages/cli/src/commands/codegraph.ts` | `archon codegraph index\|sync\|status [codebase]` |
| `packages/cli/src/commands/codegraph.test.ts` | Tests |
| `packages/cli/src/setup/yaml-merge.ts` | Read-merge-write `~/.archon/config.yaml` |
| `packages/cli/src/setup/yaml-merge.test.ts` | Tests |
| `packages/cli/src/setup/codegraph-step.ts` | Setup wizard step |
| `packages/cli/src/setup/codegraph-step.test.ts` | Tests |
| `packages/workflows/src/__tests__/codegraph-integration.test.ts` | Skippable integration smoke |

### Touched files (additive only)
| Path | Edit shape |
|---|---|
| `packages/core/src/config/config-types.ts` | Add `codegraph` to `GlobalConfig`, `RepoConfig`, `MergedConfig` |
| `packages/core/src/config/config-loader.ts` | Add codegraph defaults; merge global + repo; env-var override `ARCHON_CODEGRAPH_ENABLED` |
| `packages/core/src/config/config-loader.test.ts` | Tests for the new merge + override paths |
| `packages/workflows/src/schemas/workflow.ts` | Add `codegraph: z.boolean().optional()` to `workflowBaseSchema` |
| `packages/workflows/src/schemas/dag-node.ts` | Add `codegraph: z.boolean().optional()` to the raw node schema |
| `packages/providers/src/claude/provider.ts` | One-time loop calling `collectClaudeMcpExtensions(ctx)` |
| `packages/providers/src/claude/provider.test.ts` | Tests for the extension-loop wiring |
| `packages/core/src/services/codebases.ts` | One conditional call to `bootstrapCodegraphIndex` after register |
| `packages/cli/src/commands/doctor.ts` | One row in output for codegraph status |
| `packages/cli/src/commands/doctor.test.ts` | Test for the row |
| `packages/cli/src/commands/setup.ts` | Invoke `codegraph-step` after the assistant step (conditional on `claude`) |
| `packages/cli/src/cli.ts` | One `case 'codegraph':` in the dispatch switch |

### Existing patterns to follow (read before starting)

- **Zod schemas**: `packages/workflows/src/schemas/workflow.ts` and `dag-node.ts`. Import `z` from `@hono/zod-openapi` (not `zod` directly). Use `.optional()` for additive fields. Record schemas need explicit key type: `z.record(z.string(), valueSchema)`.
- **Config interfaces** (NOT Zod): `packages/core/src/config/config-types.ts` uses plain TS interfaces. Codegraph follows the same pattern — `GlobalConfig` + `RepoConfig` + `MergedConfig` extensions, then loader merge + env override.
- **Pino logger**: `import { createLogger } from '@archon/paths'` → `const log = createLogger('codegraph')`. Event naming: `{domain}.{action}_{state}` — e.g. `codegraph.index_started`, `codegraph.binary_missing`.
- **Test isolation rule** (CRITICAL): Bun's `mock.module()` is process-wide and irreversible. Do NOT add a new `mock.module()` in a file that lives in a `bun test` batch where another file already mocks the same module differently. Read `CLAUDE.md` "Test isolation (mock.module pollution)" before writing test files. Prefer `spyOn()` for internal modules.

### Commands you'll run repeatedly

- Run one test file: `bun test packages/<pkg>/src/path/to/file.test.ts`
- Run all tests for a package: `bun --filter '@archon/<pkg>' test`
- Type check: `bun run type-check`
- Lint: `bun run lint`
- Pre-PR validation: `bun run validate` — must pass before opening a PR
- **Never run `bun test` from the repo root** — process-global mock pollution will fail ~135 tests. Always use `bun run test` (which uses `--filter '*'`) or per-package invocations.

---

## Task 1: Codegraph in config types + defaults + env override

**Files:**
- Modify: `packages/core/src/config/config-types.ts`
- Modify: `packages/core/src/config/config-loader.ts`
- Modify: `packages/core/src/config/config-loader.test.ts`

- [ ] **Step 1: Read current config types**

Read `packages/core/src/config/config-types.ts` end to end. You'll be adding to three interfaces (`GlobalConfig`, `RepoConfig`, `MergedConfig`) and one safe-projection interface (`SafeConfig`).

- [ ] **Step 2: Add `CodegraphConfig` interface to `config-types.ts`**

Right above the `GlobalConfig` interface (after the `AssistantDefaults` block), add:

```ts
/**
 * Codegraph integration settings.
 *
 * `enabled` makes ClaudeProvider attach the codegraph MCP server on every
 * Claude node unless overridden at workflow or node level.
 *
 * `autoIndex` makes codebase registration run `codegraph init -i` on the
 * source repo (so worktrees can copy the prebuilt index).
 *
 * `watchDebounceMs` is forwarded to the spawned `codegraph serve --mcp`
 * child as `CODEGRAPH_WATCH_DEBOUNCE_MS`. Codegraph itself clamps it.
 */
export interface CodegraphConfig {
  enabled?: boolean;
  autoIndex?: boolean;
  watchDebounceMs?: number;
}
```

- [ ] **Step 3: Add `codegraph` field to `GlobalConfig`, `RepoConfig`, `MergedConfig`**

In `GlobalConfig` and `RepoConfig`, add inside the existing interface body:

```ts
  /**
   * Codegraph integration. Defaults to disabled.
   */
  codegraph?: CodegraphConfig;
```

In `MergedConfig`, add as a non-optional field with the resolved shape:

```ts
  codegraph: {
    enabled: boolean;
    autoIndex: boolean;
    watchDebounceMs: number;
  };
```

- [ ] **Step 4: Write the failing test for defaults**

In `packages/core/src/config/config-loader.test.ts`, add a new test block:

```ts
describe('codegraph defaults', () => {
  it('defaults to disabled with autoIndex on and 2000ms debounce', async () => {
    const cfg = await loadConfig();
    expect(cfg.codegraph).toEqual({
      enabled: false,
      autoIndex: true,
      watchDebounceMs: 2000,
    });
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
bun test packages/core/src/config/config-loader.test.ts -t "codegraph defaults"
```

Expected: FAIL — `Cannot read property 'enabled' of undefined` or similar.

- [ ] **Step 6: Add defaults to `getDefaults()` in config-loader.ts**

In the `return { ... }` block of `getDefaults()` (around line 280), add (alphabetical-ish ordering between existing fields is fine — the codebase doesn't enforce alphabetical):

```ts
    codegraph: {
      enabled: false,
      autoIndex: true,
      watchDebounceMs: 2000,
    },
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
bun test packages/core/src/config/config-loader.test.ts -t "codegraph defaults"
```

Expected: PASS.

- [ ] **Step 8: Write failing tests for global + repo merge**

Add to the same `describe('codegraph defaults', …)` block:

```ts
  it('global config can flip codegraph.enabled to true', async () => {
    const cfg = await loadConfig(undefined, {
      global: { codegraph: { enabled: true } },
    });
    expect(cfg.codegraph.enabled).toBe(true);
    expect(cfg.codegraph.autoIndex).toBe(true);
  });

  it('repo config overrides global for codegraph.enabled', async () => {
    const cfg = await loadConfig(undefined, {
      global: { codegraph: { enabled: true } },
      repo: { codegraph: { enabled: false } },
    });
    expect(cfg.codegraph.enabled).toBe(false);
  });

  it('clamps watchDebounceMs to [100, 60000]', async () => {
    const low = await loadConfig(undefined, {
      global: { codegraph: { watchDebounceMs: 10 } },
    });
    expect(low.codegraph.watchDebounceMs).toBe(100);

    const high = await loadConfig(undefined, {
      global: { codegraph: { watchDebounceMs: 999_999 } },
    });
    expect(high.codegraph.watchDebounceMs).toBe(60_000);
  });
```

**Note**: the existing `loadConfig` may not accept a test-injection object. If it doesn't, instead temporarily set fixture files at `~/.archon/config.yaml` (use the existing test helper if there is one, or write to `tmpdir` and override env var). Look at the existing `config-loader.test.ts` to see how other merge tests are set up — match that pattern. **Do not change `loadConfig`'s signature.**

- [ ] **Step 9: Run to verify failure**

```bash
bun test packages/core/src/config/config-loader.test.ts -t "codegraph"
```

Expected: the three new tests FAIL (no merge logic yet).

- [ ] **Step 10: Add merge logic to `mergeGlobalConfig`**

Find `mergeGlobalConfig(defaults, global)` in `config-loader.ts` (around line 366). Inside the body, after the existing field merges, add:

```ts
  if (global.codegraph) {
    result.codegraph = {
      enabled: global.codegraph.enabled ?? result.codegraph.enabled,
      autoIndex: global.codegraph.autoIndex ?? result.codegraph.autoIndex,
      watchDebounceMs: clampDebounce(
        global.codegraph.watchDebounceMs ?? result.codegraph.watchDebounceMs
      ),
    };
  }
```

At the top of the file (after the existing helpers), add:

```ts
function clampDebounce(ms: number): number {
  if (ms < 100) return 100;
  if (ms > 60_000) return 60_000;
  return ms;
}
```

- [ ] **Step 11: Add merge logic to `mergeRepoConfig`**

Find `mergeRepoConfig(merged, repo)` (around line 415). After existing merges, add the same pattern:

```ts
  if (repo.codegraph) {
    result.codegraph = {
      enabled: repo.codegraph.enabled ?? result.codegraph.enabled,
      autoIndex: repo.codegraph.autoIndex ?? result.codegraph.autoIndex,
      watchDebounceMs: clampDebounce(
        repo.codegraph.watchDebounceMs ?? result.codegraph.watchDebounceMs
      ),
    };
  }
```

- [ ] **Step 12: Write the failing env-override test**

Add to the codegraph describe block:

```ts
  it('ARCHON_CODEGRAPH_ENABLED=true overrides config.enabled=false', async () => {
    process.env.ARCHON_CODEGRAPH_ENABLED = 'true';
    try {
      const cfg = await loadConfig();
      expect(cfg.codegraph.enabled).toBe(true);
    } finally {
      delete process.env.ARCHON_CODEGRAPH_ENABLED;
    }
  });

  it('ARCHON_CODEGRAPH_ENABLED=false overrides config.enabled=true', async () => {
    process.env.ARCHON_CODEGRAPH_ENABLED = 'false';
    try {
      const cfg = await loadConfig(undefined, {
        global: { codegraph: { enabled: true } },
      });
      expect(cfg.codegraph.enabled).toBe(false);
    } finally {
      delete process.env.ARCHON_CODEGRAPH_ENABLED;
    }
  });
```

- [ ] **Step 13: Run to verify failure**

```bash
bun test packages/core/src/config/config-loader.test.ts -t "ARCHON_CODEGRAPH_ENABLED"
```

Expected: FAIL.

- [ ] **Step 14: Add env override to `applyEnvOverrides`**

Find `applyEnvOverrides(config)` in `config-loader.ts` (around line 311). After the existing overrides, add:

```ts
  const envCodegraph = process.env.ARCHON_CODEGRAPH_ENABLED;
  if (envCodegraph !== undefined) {
    config.codegraph.enabled = envCodegraph === 'true' || envCodegraph === '1';
  }
```

- [ ] **Step 15: Run all codegraph tests to verify pass**

```bash
bun test packages/core/src/config/config-loader.test.ts -t "codegraph"
bun test packages/core/src/config/config-loader.test.ts -t "ARCHON_CODEGRAPH_ENABLED"
```

Expected: PASS for all six tests.

- [ ] **Step 16: Type-check the package**

```bash
bun --filter '@archon/core' run type-check
```

Expected: no errors.

- [ ] **Step 17: Commit**

```bash
git add packages/core/src/config/config-types.ts \
        packages/core/src/config/config-loader.ts \
        packages/core/src/config/config-loader.test.ts
git commit -m "feat(core): add codegraph config schema + env override

Adds CodegraphConfig interface to GlobalConfig/RepoConfig/MergedConfig with
defaults enabled=false, autoIndex=true, watchDebounceMs=2000. Adds
ARCHON_CODEGRAPH_ENABLED env override. watchDebounceMs is clamped to
[100, 60000] to match codegraph's own clamp.

Refs spec: docs/superpowers/specs/2026-05-30-codegraph-integration-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: detectCodegraphBinary helper

**Files:**
- Create: `packages/core/src/services/codegraph-detect.ts`
- Create: `packages/core/src/services/codegraph-detect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/services/codegraph-detect.test.ts`:

```ts
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { spyOn } from 'bun:test';

// detectCodegraphBinary uses execFileAsync from @archon/git
import * as exec from '@archon/git';
import { detectCodegraphBinary, resetCodegraphDetectionForTests } from './codegraph-detect';

describe('detectCodegraphBinary', () => {
  afterEach(() => {
    resetCodegraphDetectionForTests();
  });

  it('returns { found: true, path, version } when codegraph --version succeeds', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: '0.18.3\n',
      stderr: '',
    } as any);

    const result = await detectCodegraphBinary();
    expect(result).toEqual({ found: true, path: 'codegraph', version: '0.18.3' });
    spy.mockRestore();
  });

  it('returns { found: false } when the binary is missing', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    const result = await detectCodegraphBinary();
    expect(result).toEqual({ found: false });
    spy.mockRestore();
  });

  it('returns { found: false } when --version exits non-zero', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockRejectedValue(
      Object.assign(new Error('exit 1'), { code: 1 })
    );

    const result = await detectCodegraphBinary();
    expect(result).toEqual({ found: false });
    spy.mockRestore();
  });

  it('caches the result across calls in the same process', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: '0.18.3\n',
      stderr: '',
    } as any);

    await detectCodegraphBinary();
    await detectCodegraphBinary();
    await detectCodegraphBinary();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/core/src/services/codegraph-detect.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `codegraph-detect.ts`**

Create `packages/core/src/services/codegraph-detect.ts`:

```ts
/**
 * Detect the `codegraph` binary on PATH.
 *
 * Probes `codegraph --version`. Result is cached at module scope for the
 * lifetime of the process — one probe per Archon run, not per Claude node.
 *
 * Returns { found: false } on any failure (missing binary, non-zero exit,
 * unparseable version). Callers must handle the not-found case by skipping
 * codegraph integration with a one-time warn — they must NOT throw.
 */
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';

const log = createLogger('codegraph');

export type CodegraphDetection = { found: true; path: string; version: string } | { found: false };

let cache: CodegraphDetection | null = null;
let inflight: Promise<CodegraphDetection> | null = null;

export async function detectCodegraphBinary(): Promise<CodegraphDetection> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { stdout } = await execFileAsync('codegraph', ['--version']);
      const version = stdout.trim();
      if (!version) {
        cache = { found: false };
      } else {
        cache = { found: true, path: 'codegraph', version };
        log.info({ version }, 'codegraph.binary_detected');
      }
    } catch {
      cache = { found: false };
    }
    inflight = null;
    return cache;
  })();

  return inflight;
}

/** Test-only: reset the module-level cache. Production code MUST NOT call this. */
export function resetCodegraphDetectionForTests(): void {
  cache = null;
  inflight = null;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
bun test packages/core/src/services/codegraph-detect.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Type-check and lint**

```bash
bun --filter '@archon/core' run type-check
bun --filter '@archon/core' run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/codegraph-detect.ts \
        packages/core/src/services/codegraph-detect.test.ts
git commit -m "feat(core): add detectCodegraphBinary helper

Probes \`codegraph --version\` once per process; caches result. Returns
{ found: false } on any failure so callers can gracefully degrade without
throwing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: bootstrapCodegraphIndex service

**Files:**
- Create: `packages/core/src/services/codegraph-bootstrap.ts`
- Create: `packages/core/src/services/codegraph-bootstrap.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/services/codegraph-bootstrap.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'bun:test';
import { spyOn } from 'bun:test';
import { execFile } from 'child_process';
import * as detectModule from './codegraph-detect';
import { bootstrapCodegraphIndex } from './codegraph-bootstrap';

describe('bootstrapCodegraphIndex', () => {
  afterEach(() => {
    // spies will be restored individually in each test
  });

  it('skips silently when codegraph binary is missing', async () => {
    const detectSpy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: false,
    });

    const result = await bootstrapCodegraphIndex('/some/source/path');
    expect(result).toEqual({ ok: false, reason: 'binary_missing' });
    detectSpy.mockRestore();
  });

  it('runs `codegraph init -i` when binary is found', async () => {
    const detectSpy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });

    // Use a temp dir for the source; codegraph init won't actually run here
    // because we mock execFileAsync at the bootstrap call site.
    const spawnSpy = spyOn(
      await import('@archon/git'),
      'execFileAsync'
    ).mockResolvedValue({ stdout: 'OK', stderr: '' } as any);

    const result = await bootstrapCodegraphIndex('/some/source/path');
    expect(result.ok).toBe(true);
    expect(spawnSpy).toHaveBeenCalledWith(
      'codegraph',
      ['init', '-i'],
      expect.objectContaining({ cwd: '/some/source/path' })
    );
    spawnSpy.mockRestore();
    detectSpy.mockRestore();
  });

  it('returns ok: false with reason: index_failed on non-zero exit', async () => {
    const detectSpy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });

    const spawnSpy = spyOn(
      await import('@archon/git'),
      'execFileAsync'
    ).mockRejectedValue(Object.assign(new Error('exit 1'), { code: 1, stderr: 'broken' }));

    const result = await bootstrapCodegraphIndex('/some/source/path');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('index_failed');

    spawnSpy.mockRestore();
    detectSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/core/src/services/codegraph-bootstrap.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `codegraph-bootstrap.ts`**

Create `packages/core/src/services/codegraph-bootstrap.ts`:

```ts
/**
 * Run `codegraph init -i` against a codebase source directory.
 *
 * Failure is never thrown — the caller (codebase registration) must not
 * be blocked by codegraph problems. Always returns a discriminated union.
 *
 * Timeout: 10 minutes. Big repos can legitimately take a while to index.
 */
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';
import { detectCodegraphBinary } from './codegraph-detect';

const log = createLogger('codegraph');

const INDEX_TIMEOUT_MS = 10 * 60 * 1000;

export type BootstrapResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: 'binary_missing' | 'index_failed' | 'index_timeout'; detail?: string };

export async function bootstrapCodegraphIndex(sourcePath: string): Promise<BootstrapResult> {
  const detection = await detectCodegraphBinary();
  if (!detection.found) {
    log.warn({ phase: 'bootstrap' }, 'codegraph.binary_missing');
    return { ok: false, reason: 'binary_missing' };
  }

  log.info({ sourcePath }, 'codegraph.index_started');
  const startedAt = Date.now();

  try {
    await execFileAsync('codegraph', ['init', '-i'], {
      cwd: sourcePath,
      timeout: INDEX_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;
    log.info({ sourcePath, durationMs }, 'codegraph.index_completed');
    return { ok: true, durationMs };
  } catch (err) {
    const errorObj = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const durationMs = Date.now() - startedAt;

    if (errorObj.killed || errorObj.code === 'ETIMEDOUT') {
      log.error({ sourcePath, durationMs }, 'codegraph.index_timeout');
      return { ok: false, reason: 'index_timeout' };
    }

    log.error(
      { sourcePath, durationMs, stderr: errorObj.stderr, err: errorObj.message },
      'codegraph.index_failed'
    );
    return { ok: false, reason: 'index_failed', detail: errorObj.message };
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
bun test packages/core/src/services/codegraph-bootstrap.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Re-export from package index (so external consumers can import)**

Open `packages/core/src/index.ts`. Find the existing `export * from` block for services. Add:

```ts
export {
  bootstrapCodegraphIndex,
  type BootstrapResult,
} from './services/codegraph-bootstrap';
export {
  detectCodegraphBinary,
  type CodegraphDetection,
} from './services/codegraph-detect';
```

- [ ] **Step 6: Type-check + lint**

```bash
bun --filter '@archon/core' run type-check
bun --filter '@archon/core' run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/services/codegraph-bootstrap.ts \
        packages/core/src/services/codegraph-bootstrap.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core): add bootstrapCodegraphIndex service

Runs \`codegraph init -i\` against a source path with a 10-min timeout.
Returns a discriminated union; never throws. Failure modes: binary_missing
(when detection fails), index_failed (non-zero exit), index_timeout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: resolveCodegraph helper (pure)

**Files:**
- Create: `packages/workflows/src/utils/resolve-codegraph.ts`
- Create: `packages/workflows/src/utils/resolve-codegraph.test.ts`

- [ ] **Step 1: Write the failing test (8-case truth table)**

Create `packages/workflows/src/utils/resolve-codegraph.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { resolveCodegraph } from './resolve-codegraph';

describe('resolveCodegraph', () => {
  const cfgOn = { codegraph: { enabled: true } } as any;
  const cfgOff = { codegraph: { enabled: false } } as any;

  it('node=true → true (overrides everything)', () => {
    expect(resolveCodegraph({ codegraph: true } as any, { codegraph: false } as any, cfgOff)).toBe(true);
  });

  it('node=false → false (overrides everything)', () => {
    expect(resolveCodegraph({ codegraph: false } as any, { codegraph: true } as any, cfgOn)).toBe(false);
  });

  it('workflow=true (node unset) → true', () => {
    expect(resolveCodegraph({} as any, { codegraph: true } as any, cfgOff)).toBe(true);
  });

  it('workflow=false (node unset) → false', () => {
    expect(resolveCodegraph({} as any, { codegraph: false } as any, cfgOn)).toBe(false);
  });

  it('config.enabled=true (node + workflow unset) → true', () => {
    expect(resolveCodegraph({} as any, {} as any, cfgOn)).toBe(true);
  });

  it('config.enabled=false (node + workflow unset) → false', () => {
    expect(resolveCodegraph({} as any, {} as any, cfgOff)).toBe(false);
  });

  it('nothing set anywhere → false', () => {
    expect(resolveCodegraph({} as any, {} as any, { codegraph: {} } as any)).toBe(false);
  });

  it('undefined config gracefully degrades to false', () => {
    expect(resolveCodegraph({} as any, {} as any, {} as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/workflows/src/utils/resolve-codegraph.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/workflows/src/utils/resolve-codegraph.ts`:

```ts
/**
 * Resolve the effective `codegraph` flag for a Claude node.
 *
 * Three-tier resolution mirrors how `provider` and `model` resolve in Archon:
 *   node.codegraph  ??  workflow.codegraph  ??  config.codegraph.enabled  ??  false
 *
 * Kept as a pure function so it can be unit-tested without setup.
 */
import type { DagNode } from '../schemas/dag-node';
import type { WorkflowDefinition } from '../schemas/workflow';

/**
 * Minimal config shape required for resolution. Defined locally to avoid an
 * import cycle from @archon/workflows → @archon/core.
 */
export interface ResolveCodegraphConfig {
  codegraph?: { enabled?: boolean };
}

export function resolveCodegraph(
  node: Pick<DagNode, 'codegraph'> | { codegraph?: boolean },
  workflow: Pick<WorkflowDefinition, 'codegraph'> | { codegraph?: boolean },
  config: ResolveCodegraphConfig
): boolean {
  return (
    (node as { codegraph?: boolean }).codegraph ??
    (workflow as { codegraph?: boolean }).codegraph ??
    config.codegraph?.enabled ??
    false
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
bun test packages/workflows/src/utils/resolve-codegraph.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Type-check + lint**

```bash
bun --filter '@archon/workflows' run type-check
bun --filter '@archon/workflows' run lint
```

Expected: no errors. (The `Pick<DagNode, 'codegraph'>` and `Pick<WorkflowDefinition, 'codegraph'>` types will fail to compile until Tasks 5 + 6 add the field. **Expected**: revisit this file's types after Task 6. For now, the `| { codegraph?: boolean }` fallback keeps the types valid via the union arm.)

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/utils/resolve-codegraph.ts \
        packages/workflows/src/utils/resolve-codegraph.test.ts
git commit -m "feat(workflows): add resolveCodegraph helper

Pure 3-tier resolution helper (node → workflow → config) mirroring how
provider and model resolve today. 8-case truth table tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add codegraph field to workflow schema

**Files:**
- Modify: `packages/workflows/src/schemas/workflow.ts`
- Modify: `packages/workflows/src/schemas/__tests__/workflow.test.ts` (or wherever workflow-schema tests live; check `find packages/workflows -name 'workflow.test.ts'`)

- [ ] **Step 1: Locate existing workflow schema tests**

```bash
find packages/workflows -name 'workflow.test.ts' -o -name 'schemas.test.ts' 2>/dev/null
```

If a test file exists, extend it. If not, create `packages/workflows/src/schemas/workflow.test.ts`.

- [ ] **Step 2: Write failing tests**

Add to the workflow schema test file (or create with the imports at top):

```ts
import { describe, expect, it } from 'bun:test';
import { workflowDefinitionSchema } from './workflow';

describe('workflow schema: codegraph field', () => {
  const baseWorkflow = {
    name: 'test-wf',
    description: 'test',
    nodes: [],
  };

  it('accepts codegraph: true', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: true });
    expect(result.success).toBe(true);
  });

  it('accepts codegraph: false', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: false });
    expect(result.success).toBe(true);
  });

  it('accepts omitted codegraph', () => {
    const result = workflowDefinitionSchema.safeParse(baseWorkflow);
    expect(result.success).toBe(true);
  });

  it('rejects codegraph as non-boolean', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: 'yes' });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
bun test packages/workflows/src/schemas/workflow.test.ts -t "codegraph"
```

Expected: the "rejects codegraph as non-boolean" test PASSES (Zod is strict) but the "accepts codegraph: true" test should also pass even without the field if the schema doesn't strict-mode-block extras. Run and check actual behavior; you may need to also add a positive assertion that `result.data.codegraph === true`:

```ts
  it('parses codegraph: true into the output', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.codegraph).toBe(true);
  });
```

This last test will fail until the field is added.

- [ ] **Step 4: Add the field to `workflowBaseSchema`**

Open `packages/workflows/src/schemas/workflow.ts`. Find `workflowBaseSchema = z.object({ ... })` (around line 55). Add a new field in the object, near the other Claude-related optional flags:

```ts
  /**
   * When true, Claude nodes in this workflow get the codegraph MCP server
   * auto-attached (subject to config + binary availability). Node-level
   * `codegraph` overrides this.
   */
  codegraph: z.boolean().optional(),
```

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/workflows/src/schemas/workflow.test.ts -t "codegraph"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/schemas/workflow.ts \
        packages/workflows/src/schemas/workflow.test.ts
git commit -m "feat(workflows): add workflow-level codegraph schema field

Optional boolean field on workflowBaseSchema. Drives the workflow-level
arm of the 3-tier resolution implemented in Task 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add codegraph field to dag-node schema

**Files:**
- Modify: `packages/workflows/src/schemas/dag-node.ts`
- Modify: `packages/workflows/src/schemas/dag-node.test.ts` (likely exists; check)

- [ ] **Step 1: Locate dag-node tests**

```bash
find packages/workflows -name 'dag-node.test.ts' 2>/dev/null
```

- [ ] **Step 2: Write failing tests**

Add to the dag-node test file:

```ts
describe('dag-node schema: codegraph field', () => {
  it('accepts codegraph: true on a prompt node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n1',
      prompt: 'hello',
      codegraph: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as any).codegraph).toBe(true);
  });

  it('accepts codegraph: false on a command node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n2',
      command: 'investigate',
      codegraph: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts omitted codegraph', () => {
    const result = dagNodeSchema.safeParse({ id: 'n3', prompt: 'hello' });
    expect(result.success).toBe(true);
  });

  it('rejects codegraph as a string', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n4',
      prompt: 'hello',
      codegraph: 'yes',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
bun test packages/workflows/src/schemas/dag-node.test.ts -t "codegraph"
```

Expected: the parse-into-output assertion FAILS.

- [ ] **Step 4: Add the field to the raw dag-node schema**

Open `packages/workflows/src/schemas/dag-node.ts`. Find the raw object schema that lists all the per-node fields (look for the schema before the `.superRefine(...)` call). Add:

```ts
  /**
   * Per-node override for codegraph MCP attach. Wins over the workflow-level
   * `codegraph` flag and the global `config.codegraph.enabled` default.
   * Claude-only; ignored by non-Claude providers.
   */
  codegraph: z.boolean().optional(),
```

The exact location depends on the existing layout — put it adjacent to other Claude-only optional fields like `effort`, `thinking`, `betas`, `sandbox`.

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/workflows/src/schemas/dag-node.test.ts -t "codegraph"
```

Expected: PASS.

- [ ] **Step 6: Type-check**

```bash
bun --filter '@archon/workflows' run type-check
```

Expected: no errors. The earlier `resolveCodegraph.ts` `Pick<DagNode, 'codegraph'>` now compiles cleanly because `codegraph` is part of the dag-node type.

- [ ] **Step 7: Commit**

```bash
git add packages/workflows/src/schemas/dag-node.ts \
        packages/workflows/src/schemas/dag-node.test.ts
git commit -m "feat(workflows): add node-level codegraph schema field

Optional boolean override at the node level. Resolves first in the 3-tier
chain (node → workflow → config). Claude-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Claude MCP extension registry

**Files:**
- Create: `packages/providers/src/claude/mcp-extensions.ts`
- Create: `packages/providers/src/claude/mcp-extensions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/providers/src/claude/mcp-extensions.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'bun:test';
import {
  registerClaudeMcpExtension,
  collectClaudeMcpExtensions,
  resetClaudeMcpExtensionsForTests,
  type ClaudeMcpCtx,
} from './mcp-extensions';

const fakeCtx: ClaudeMcpCtx = {
  workflow: {} as any,
  node: {} as any,
  config: {} as any,
  cwd: '/tmp/wt',
};

describe('ClaudeMcpExtensions registry', () => {
  afterEach(() => resetClaudeMcpExtensionsForTests());

  it('returns empty object when no extensions are registered', () => {
    const result = collectClaudeMcpExtensions(fakeCtx);
    expect(result).toEqual({});
  });

  it('collects entries from one registered extension', () => {
    registerClaudeMcpExtension(() => ({ foo: { type: 'stdio', command: 'foo', args: [] } }));
    const result = collectClaudeMcpExtensions(fakeCtx);
    expect(Object.keys(result)).toEqual(['foo']);
  });

  it('skips extensions that return null', () => {
    registerClaudeMcpExtension(() => null);
    registerClaudeMcpExtension(() => ({ bar: { type: 'stdio', command: 'bar', args: [] } }));
    const result = collectClaudeMcpExtensions(fakeCtx);
    expect(Object.keys(result)).toEqual(['bar']);
  });

  it('shallow-merges entries — later extensions overwrite same-key entries', () => {
    registerClaudeMcpExtension(() => ({ foo: { type: 'stdio', command: 'first', args: [] } }));
    registerClaudeMcpExtension(() => ({ foo: { type: 'stdio', command: 'second', args: [] } }));
    const result = collectClaudeMcpExtensions(fakeCtx);
    expect((result.foo as any).command).toBe('second');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/providers/src/claude/mcp-extensions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/providers/src/claude/mcp-extensions.ts`:

```ts
/**
 * Claude MCP extension registry.
 *
 * The ClaudeProvider calls `collectClaudeMcpExtensions(ctx)` once per
 * `sendQuery()` to merge any registered extensions' MCP server entries
 * into the Claude SDK `mcpServers` map.
 *
 * New MCP integrations (codegraph and anything else) register themselves
 * here at module load. The provider source never needs another edit.
 */
import type { DagNode, WorkflowDefinition } from '@archon/workflows/schemas';

// Caveat: we deliberately use `unknown` for `config` to avoid a circular
// import from @archon/providers → @archon/core. The extension function
// narrows `config` to whatever shape it expects via a Pick.
export interface ClaudeMcpCtx {
  workflow: Pick<WorkflowDefinition, 'codegraph'>;
  node: Pick<DagNode, 'codegraph' | 'id'>;
  config: { codegraph?: { enabled?: boolean; watchDebounceMs?: number } };
  cwd: string;
}

export type ClaudeMcpEntry = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type ClaudeMcpExtension = (ctx: ClaudeMcpCtx) => Record<string, ClaudeMcpEntry> | null;

const extensions: ClaudeMcpExtension[] = [];

export function registerClaudeMcpExtension(fn: ClaudeMcpExtension): void {
  extensions.push(fn);
}

export function collectClaudeMcpExtensions(ctx: ClaudeMcpCtx): Record<string, ClaudeMcpEntry> {
  const merged: Record<string, ClaudeMcpEntry> = {};
  for (const fn of extensions) {
    const entries = fn(ctx);
    if (!entries) continue;
    Object.assign(merged, entries);
  }
  return merged;
}

/** Test-only. Resets the in-process registry. Production code MUST NOT call this. */
export function resetClaudeMcpExtensionsForTests(): void {
  extensions.length = 0;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
bun test packages/providers/src/claude/mcp-extensions.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Re-export from `@archon/providers/claude` package entry**

Open `packages/providers/src/claude/index.ts` (or whatever the claude subpath barrel is). Add:

```ts
export {
  registerClaudeMcpExtension,
  collectClaudeMcpExtensions,
  type ClaudeMcpCtx,
  type ClaudeMcpEntry,
  type ClaudeMcpExtension,
} from './mcp-extensions';
```

- [ ] **Step 6: Type-check + lint**

```bash
bun --filter '@archon/providers' run type-check
bun --filter '@archon/providers' run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/providers/src/claude/mcp-extensions.ts \
        packages/providers/src/claude/mcp-extensions.test.ts \
        packages/providers/src/claude/index.ts
git commit -m "feat(providers): add Claude MCP extension registry

Tiny module exposing registerClaudeMcpExtension(fn) and
collectClaudeMcpExtensions(ctx). The ClaudeProvider will call the collector
once per sendQuery() (Task 9). New MCP integrations register themselves
without needing further provider.ts edits — the extension point lands once.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Codegraph Claude extension

**Files:**
- Create: `packages/providers/src/claude/codegraph-mcp.ts`
- Create: `packages/providers/src/claude/codegraph-mcp.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/providers/src/claude/codegraph-mcp.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  collectClaudeMcpExtensions,
  resetClaudeMcpExtensionsForTests,
  type ClaudeMcpCtx,
} from './mcp-extensions';
import * as detectModule from '@archon/core/services/codegraph-detect';
import './codegraph-mcp'; // self-registers

const baseCtx: ClaudeMcpCtx = {
  workflow: {},
  node: { id: 'n1' } as any,
  config: { codegraph: { enabled: true, watchDebounceMs: 2000 } },
  cwd: '/tmp/worktree',
};

describe('codegraph-mcp extension', () => {
  beforeEach(() => {
    resetClaudeMcpExtensionsForTests();
    // re-import to re-register after reset
    delete require.cache?.[require.resolve('./codegraph-mcp')];
    require('./codegraph-mcp');
  });

  afterEach(() => resetClaudeMcpExtensionsForTests());

  it('returns null when binary is missing', async () => {
    const spy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: false,
    });
    // Note: the extension fn itself is sync, but reads a cached detection.
    // Force a synchronous code path by warming the cache first.
    await detectModule.detectCodegraphBinary();

    const result = collectClaudeMcpExtensions(baseCtx);
    expect(result).toEqual({});
    spy.mockRestore();
  });

  it('returns null when effective flag resolves to false', async () => {
    const spy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    await detectModule.detectCodegraphBinary();

    const result = collectClaudeMcpExtensions({
      ...baseCtx,
      config: { codegraph: { enabled: false } },
    });
    expect(result).toEqual({});
    spy.mockRestore();
  });

  it('returns a codegraph stdio entry when enabled + binary present', async () => {
    const spy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    await detectModule.detectCodegraphBinary();

    const result = collectClaudeMcpExtensions(baseCtx);
    expect(result.codegraph).toBeDefined();
    expect(result.codegraph).toMatchObject({
      type: 'stdio',
      command: 'codegraph',
      args: ['serve', '--mcp'],
      cwd: '/tmp/worktree',
    });
    expect(result.codegraph.env?.CODEGRAPH_WATCH_DEBOUNCE_MS).toBe('2000');
    spy.mockRestore();
  });

  it('uses node.codegraph as the highest-priority override', async () => {
    const spy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    await detectModule.detectCodegraphBinary();

    // config off, node on → should produce an entry
    const result = collectClaudeMcpExtensions({
      ...baseCtx,
      node: { id: 'n1', codegraph: true } as any,
      config: { codegraph: { enabled: false, watchDebounceMs: 2000 } },
    });
    expect(result.codegraph).toBeDefined();
    spy.mockRestore();
  });
});
```

**IMPORTANT** about the `beforeEach` re-import trick: Bun's module cache may not actually re-run the `import` for `codegraph-mcp`. If the tests still pass without it, fine. If they fail because the registration only happens once, you may need to restructure `codegraph-mcp.ts` to expose its handler function separately (named export `codegraphMcpExtension`) and register it via `registerClaudeMcpExtension(codegraphMcpExtension)` once at module load, while tests can register it manually. Adjust if needed during implementation.

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/providers/src/claude/codegraph-mcp.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/providers/src/claude/codegraph-mcp.ts`:

```ts
/**
 * Codegraph MCP extension for ClaudeProvider.
 *
 * Self-registers via `mcp-extensions.ts` at module load. Reads the
 * cached detection from `@archon/core/services/codegraph-detect` — the
 * cache is populated at process start by codebase registration or first
 * Claude node, so reading it here is synchronous in practice.
 *
 * Resolution: node.codegraph ?? workflow.codegraph ?? config.codegraph.enabled
 */
import { resolveCodegraph } from '@archon/workflows/utils/resolve-codegraph';
import { registerClaudeMcpExtension, type ClaudeMcpCtx, type ClaudeMcpEntry } from './mcp-extensions';
import { createLogger } from '@archon/paths';

const log = createLogger('codegraph');

// Detection is read from a cached snapshot maintained by codegraph-detect.
// We call the sync getter (added below) rather than the async detect so the
// extension function can return a value, not a promise.
import { getCachedCodegraphDetection } from '@archon/core/services/codegraph-detect';

let warnedMissing = false;

export const codegraphMcpExtension = (ctx: ClaudeMcpCtx): Record<string, ClaudeMcpEntry> | null => {
  const effective = resolveCodegraph(ctx.node, ctx.workflow, ctx.config);
  if (!effective) return null;

  const detection = getCachedCodegraphDetection();
  if (!detection || !detection.found) {
    if (!warnedMissing) {
      warnedMissing = true;
      log.warn({ phase: 'claude_node' }, 'codegraph.binary_missing');
    }
    return null;
  }

  const debounce = String(ctx.config.codegraph?.watchDebounceMs ?? 2000);

  log.info({ nodeId: ctx.node.id, cwd: ctx.cwd }, 'codegraph.mcp_attached');

  return {
    codegraph: {
      type: 'stdio',
      command: detection.path,
      args: ['serve', '--mcp'],
      cwd: ctx.cwd,
      env: { CODEGRAPH_WATCH_DEBOUNCE_MS: debounce },
    },
  };
};

registerClaudeMcpExtension(codegraphMcpExtension);
```

- [ ] **Step 4: Add `getCachedCodegraphDetection` to codegraph-detect.ts**

Open `packages/core/src/services/codegraph-detect.ts` and append:

```ts
/**
 * Synchronous read of the cached detection result.
 *
 * Returns `null` when the cache is empty (detection has not yet run). Callers
 * that need a guaranteed answer must `await detectCodegraphBinary()` first.
 */
export function getCachedCodegraphDetection(): CodegraphDetection | null {
  return cache;
}
```

Update the index export in `packages/core/src/index.ts` to include this:

```ts
export {
  detectCodegraphBinary,
  getCachedCodegraphDetection,
  type CodegraphDetection,
} from './services/codegraph-detect';
```

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/providers/src/claude/codegraph-mcp.test.ts
```

Expected: PASS — 4 tests. If the registration-during-re-import trick from Step 1 doesn't work in Bun's test runner, refactor the test to import `codegraphMcpExtension` directly and call `registerClaudeMcpExtension(codegraphMcpExtension)` in `beforeEach`.

- [ ] **Step 6: Type-check + lint**

```bash
bun --filter '@archon/providers' run type-check
bun --filter '@archon/core' run type-check
bun --filter '@archon/providers' run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/providers/src/claude/codegraph-mcp.ts \
        packages/providers/src/claude/codegraph-mcp.test.ts \
        packages/core/src/services/codegraph-detect.ts \
        packages/core/src/index.ts
git commit -m "feat(providers): add codegraph Claude MCP extension

Self-registers via the extension registry from Task 7. Resolves the
effective flag via resolveCodegraph (Task 4) and reads cached detection
from @archon/core. Returns null whenever the flag is off or the binary
is missing — provider treats null as 'no entry to add'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire extension registry into ClaudeProvider

**Files:**
- Modify: `packages/providers/src/claude/provider.ts`
- Modify: `packages/providers/src/claude/provider.test.ts`

- [ ] **Step 1: Read the existing `sendQuery` to understand where mcpServers is built**

```bash
grep -n "mcpServers\|sendQuery" packages/providers/src/claude/provider.ts | head -20
```

Find the spot where the Claude SDK options object is assembled (specifically where `mcpServers` is finalized just before passing to `query(...)`).

- [ ] **Step 2: Write failing tests**

In `packages/providers/src/claude/provider.test.ts`, add a new describe block:

```ts
import { resetClaudeMcpExtensionsForTests, registerClaudeMcpExtension } from './mcp-extensions';

describe('ClaudeProvider: MCP extensions are merged into mcpServers', () => {
  beforeEach(() => resetClaudeMcpExtensionsForTests());
  afterEach(() => resetClaudeMcpExtensionsForTests());

  it('extension entry is merged into the final mcpServers passed to Claude SDK', async () => {
    registerClaudeMcpExtension(() => ({
      testExt: { type: 'stdio', command: 'foo', args: ['bar'] },
    }));

    // Run a minimal sendQuery (or whichever wrapper the existing tests use)
    // and assert the captured mcpServers contains 'testExt'.
    // Match the existing test pattern in provider.test.ts — likely involves
    // a spy on the Claude SDK `query` function.
    // ... implementation depends on existing test scaffolding ...
  });

  it('existing node.mcp entries are preserved when an extension entry is added', async () => {
    // ... similar pattern ...
  });

  it('node.mcp key wins if it collides with an extension key', async () => {
    // ... similar pattern ...
  });
});
```

**Critical**: open `provider.test.ts` and study the existing test scaffolding (spy on `query`, what setup is needed, what context object is built). Match those patterns precisely.

- [ ] **Step 3: Run to verify failure**

```bash
bun test packages/providers/src/claude/provider.test.ts -t "MCP extensions"
```

Expected: FAIL — extension entries not in mcpServers.

- [ ] **Step 4: Add the extension loop to `provider.ts`**

In `provider.ts`, find the assembly site of the final `mcpServers` map (after `node.mcp` is processed, before passing to the SDK). Add:

```ts
import { collectClaudeMcpExtensions } from './mcp-extensions';

// ... inside sendQuery, after building baseMcpServers from node.mcp ...

const extensionEntries = collectClaudeMcpExtensions({
  workflow,
  node,
  config,
  cwd,
});

// User-specified node.mcp entries win over extension entries (no surprise overrides).
const mcpServers = { ...extensionEntries, ...baseMcpServers };
```

The exact variable names depend on the existing function's locals — match them. The key invariant is: **extension entries first, user `node.mcp` entries second.** This means user-supplied node MCP entries with the same key override extension entries (caller wins).

- [ ] **Step 5: Import codegraph-mcp so it self-registers**

In `provider.ts` (top imports, after the imports block), add:

```ts
import './codegraph-mcp'; // self-registers as a Claude MCP extension
```

This is a side-effect import. ESLint may flag it — add an inline ESLint directive if the project's config demands it:

```ts
// eslint-disable-next-line import/no-unassigned-import
import './codegraph-mcp'; // self-registers
```

(Use this only if ESLint actually complains. The project's `CLAUDE.md` is strict about disable directives — if `import/no-unassigned-import` isn't enabled, no directive needed.)

- [ ] **Step 6: Run to verify pass**

```bash
bun test packages/providers/src/claude/provider.test.ts -t "MCP extensions"
```

Expected: PASS — 3 tests.

- [ ] **Step 7: Run the full provider test suite (regression check)**

```bash
bun --filter '@archon/providers' test
```

Expected: all tests PASS. If you broke something, fix it before continuing.

- [ ] **Step 8: Type-check + lint**

```bash
bun --filter '@archon/providers' run type-check
bun --filter '@archon/providers' run lint
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/providers/src/claude/provider.ts \
        packages/providers/src/claude/provider.test.ts
git commit -m "feat(providers): wire MCP extension registry into ClaudeProvider

One-time edit to sendQuery: merges collectClaudeMcpExtensions(ctx) result
with the per-node mcp config. User-supplied node.mcp entries win on key
collision. Future MCP integrations register via the registry without
further provider.ts edits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Bootstrap call in codebase registration

**Files:**
- Modify: `packages/core/src/services/codebases.ts`
- Modify: `packages/core/src/services/codebases.test.ts`

- [ ] **Step 1: Find the register-codebase function**

```bash
grep -n "register\|clone\|sourcePath" packages/core/src/services/codebases.ts | head -10
```

Locate the function that runs after a successful clone (or symlink). The bootstrap call belongs at the end of that flow.

- [ ] **Step 2: Write failing test**

In `packages/core/src/services/codebases.test.ts`, add:

```ts
import { spyOn } from 'bun:test';
import * as bootstrap from './codegraph-bootstrap';

describe('codebase registration: codegraph bootstrap', () => {
  it('calls bootstrapCodegraphIndex when config.codegraph.enabled && autoIndex', async () => {
    const bootstrapSpy = spyOn(bootstrap, 'bootstrapCodegraphIndex').mockResolvedValue({
      ok: true,
      durationMs: 100,
    });

    // Set up a test codebase registration with codegraph enabled in config.
    // Match the existing test pattern in this file.
    // ... call register function with a config { codegraph: { enabled: true, autoIndex: true } } ...

    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
    bootstrapSpy.mockRestore();
  });

  it('does NOT call bootstrap when codegraph.enabled is false', async () => {
    const bootstrapSpy = spyOn(bootstrap, 'bootstrapCodegraphIndex');

    // ... call register function with codegraph disabled ...

    expect(bootstrapSpy).not.toHaveBeenCalled();
    bootstrapSpy.mockRestore();
  });

  it('does NOT call bootstrap when autoIndex is false', async () => {
    const bootstrapSpy = spyOn(bootstrap, 'bootstrapCodegraphIndex');

    // ... codegraph.enabled: true, autoIndex: false ...

    expect(bootstrapSpy).not.toHaveBeenCalled();
    bootstrapSpy.mockRestore();
  });

  it('registration still succeeds when bootstrap returns ok: false', async () => {
    const bootstrapSpy = spyOn(bootstrap, 'bootstrapCodegraphIndex').mockResolvedValue({
      ok: false,
      reason: 'binary_missing',
    });

    // ... call register; assert it returns success ...

    bootstrapSpy.mockRestore();
  });
});
```

**Match the existing test patterns**: open `codebases.test.ts` and see how other tests construct codebases and configs. Adjust the placeholders above to fit.

- [ ] **Step 3: Run to verify failure**

```bash
bun test packages/core/src/services/codebases.test.ts -t "codegraph bootstrap"
```

Expected: FAIL.

- [ ] **Step 4: Add the bootstrap call**

In `codebases.ts`, at the end of the successful-register code path (after the source is in place), add:

```ts
import { bootstrapCodegraphIndex } from './codegraph-bootstrap';

// ... at the end of the register/clone success path, after we know sourcePath:

if (config.codegraph?.enabled && config.codegraph?.autoIndex) {
  // Fire-and-forget; never block registration on codegraph success.
  // The bootstrap service logs internally.
  await bootstrapCodegraphIndex(sourcePath);
}
```

If the existing function is fully synchronous in its happy path, prefer `await`-ing here so logs are emitted in order; the bootstrap function itself doesn't throw.

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/core/src/services/codebases.test.ts -t "codegraph bootstrap"
```

Expected: PASS — 4 tests.

- [ ] **Step 6: Run the full core test suite (regression check)**

```bash
bun --filter '@archon/core' test
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/services/codebases.ts \
        packages/core/src/services/codebases.test.ts
git commit -m "feat(core): bootstrap codegraph index on codebase register

After successful clone/link, if config.codegraph.enabled && autoIndex,
runs codegraph init -i on the source repo. Failure never blocks
registration — bootstrap returns a discriminated union and logs internally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `archon codegraph` CLI command

**Files:**
- Create: `packages/cli/src/commands/codegraph.ts`
- Create: `packages/cli/src/commands/codegraph.test.ts`
- Modify: `packages/cli/src/cli.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/cli/src/commands/codegraph.test.ts`:

```ts
import { describe, expect, it, spyOn } from 'bun:test';
import { runCodegraphCommand } from './codegraph';
import * as exec from '@archon/git';

describe('archon codegraph CLI', () => {
  it('prints usage and exits 1 with no subcommand', async () => {
    const log: string[] = [];
    const exit = (code: number) => {
      throw new Error(`exit:${code}`);
    };
    await expect(
      runCodegraphCommand({ args: [], log: (m) => log.push(m), exit: exit as any })
    ).rejects.toThrow('exit:1');
    expect(log.some((m) => m.toLowerCase().includes('usage'))).toBe(true);
  });

  it('runs `codegraph init -i` for `archon codegraph index`', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: 'OK',
      stderr: '',
    } as any);

    await runCodegraphCommand({ args: ['index'], log: () => {}, exit: () => {} as any });
    expect(spy).toHaveBeenCalledWith('codegraph', ['init', '-i'], expect.any(Object));
    spy.mockRestore();
  });

  it('runs `codegraph sync` for `archon codegraph sync`', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: '',
      stderr: '',
    } as any);

    await runCodegraphCommand({ args: ['sync'], log: () => {}, exit: () => {} as any });
    expect(spy).toHaveBeenCalledWith('codegraph', ['sync'], expect.any(Object));
    spy.mockRestore();
  });

  it('runs `codegraph status` for `archon codegraph status`', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: 'indexed: yes',
      stderr: '',
    } as any);

    const log: string[] = [];
    await runCodegraphCommand({
      args: ['status'],
      log: (m) => log.push(m),
      exit: () => {} as any,
    });
    expect(log.some((m) => m.includes('indexed: yes'))).toBe(true);
    spy.mockRestore();
  });

  it('prints a clear error when binary is missing', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    const log: string[] = [];
    let exitCode: number | undefined;
    await expect(
      runCodegraphCommand({
        args: ['index'],
        log: (m) => log.push(m),
        exit: ((c: number) => {
          exitCode = c;
          throw new Error(`exit:${c}`);
        }) as any,
      })
    ).rejects.toThrow();
    expect(exitCode).toBe(1);
    expect(log.some((m) => m.toLowerCase().includes('not found'))).toBe(true);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/cli/src/commands/codegraph.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/cli/src/commands/codegraph.ts`:

```ts
/**
 * `archon codegraph index|sync|status [<codebase>]`
 *
 * Thin wrappers around the `codegraph` binary, scoped to a codebase source
 * path. When no codebase is given, run against the current working directory.
 */
import { execFileAsync } from '@archon/git';

export interface CodegraphCommandOptions {
  args: string[];
  log: (msg: string) => void;
  exit: (code: number) => never;
  cwd?: string;
}

const USAGE = `Usage:
  archon codegraph index [<codebase>]   — build the index (codegraph init -i)
  archon codegraph sync  [<codebase>]   — incremental sync (codegraph sync)
  archon codegraph status [<codebase>]  — show index health (codegraph status)
`;

export async function runCodegraphCommand(opts: CodegraphCommandOptions): Promise<void> {
  const sub = opts.args[0];
  if (!sub) {
    opts.log(USAGE);
    opts.exit(1);
    return;
  }

  const codebase = opts.args[1]; // optional positional
  const targetCwd = codebase ?? opts.cwd ?? process.cwd();

  const cgArgs = (() => {
    switch (sub) {
      case 'index':
        return ['init', '-i'];
      case 'sync':
        return ['sync'];
      case 'status':
        return ['status'];
      default:
        return null;
    }
  })();

  if (!cgArgs) {
    opts.log(`Unknown subcommand: ${sub}\n\n${USAGE}`);
    opts.exit(1);
    return;
  }

  try {
    const { stdout } = await execFileAsync('codegraph', cgArgs, { cwd: targetCwd });
    if (stdout.trim()) opts.log(stdout.trim());
  } catch (err) {
    const errorObj = err as NodeJS.ErrnoException & { stderr?: string };
    if (errorObj.code === 'ENOENT') {
      opts.log(
        '`codegraph` binary not found on PATH. Install via: ' +
          'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh'
      );
      opts.exit(1);
      return;
    }
    opts.log(`codegraph ${sub} failed: ${errorObj.message}\n${errorObj.stderr ?? ''}`);
    opts.exit(1);
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
bun test packages/cli/src/commands/codegraph.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Wire into `cli.ts` dispatch**

Open `packages/cli/src/cli.ts`. In the existing switch on the first argument (around line 348+ — look for `case 'serve':` for the pattern), add:

```ts
      case 'codegraph': {
        const { runCodegraphCommand } = await import('./commands/codegraph');
        await runCodegraphCommand({
          args: rest,
          log: (m) => console.log(m),
          exit: (c) => process.exit(c),
        });
        break;
      }
```

(`rest` should be whatever the existing switch uses for the subcommand args — match the local naming.)

- [ ] **Step 6: Smoke-test the CLI**

```bash
archon codegraph 2>&1 | head -5
```

Expected: prints usage and exits 1. Verify with `echo $?`.

```bash
archon codegraph status 2>&1 | head -5
```

If codegraph is installed, prints status. Otherwise, prints the "binary not found" message and exits 1.

- [ ] **Step 7: Type-check + lint**

```bash
bun --filter '@archon/cli' run type-check
bun --filter '@archon/cli' run lint
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/codegraph.ts \
        packages/cli/src/commands/codegraph.test.ts \
        packages/cli/src/cli.ts
git commit -m "feat(cli): add \`archon codegraph index|sync|status\` command

Thin wrappers over the codegraph binary, scoped to a codebase source path
(defaults to cwd). Clear error message + exit 1 when the binary is missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: YAML merge utility

**Files:**
- Create: `packages/cli/src/setup/yaml-merge.ts`
- Create: `packages/cli/src/setup/yaml-merge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/cli/src/setup/yaml-merge.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeYamlConfig } from './yaml-merge';

describe('mergeYamlConfig', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'archon-yaml-merge-'));
    path = join(dir, 'config.yaml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file when it does not exist', async () => {
    await mergeYamlConfig(path, { codegraph: { enabled: true } });
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('codegraph:');
    expect(content).toContain('enabled: true');
  });

  it('preserves user-added keys', async () => {
    writeFileSync(path, 'botName: MyBot\nassistant: codex\n', 'utf-8');
    await mergeYamlConfig(path, { codegraph: { enabled: true } });
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('botName: MyBot');
    expect(content).toContain('assistant: codex');
    expect(content).toContain('codegraph:');
  });

  it('deep-merges nested objects without removing siblings', async () => {
    writeFileSync(
      path,
      'worktree:\n  baseBranch: main\n  copyFiles:\n    - .env\n',
      'utf-8'
    );
    await mergeYamlConfig(path, { worktree: { copyFiles: ['.codegraph'] } });
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('baseBranch: main');
    expect(content).toMatch(/copyFiles:[\s\S]*\.env/);
    expect(content).toMatch(/copyFiles:[\s\S]*\.codegraph/);
  });

  it('does not duplicate array entries on repeated merges', async () => {
    writeFileSync(path, 'worktree:\n  copyFiles:\n    - .codegraph\n', 'utf-8');
    await mergeYamlConfig(path, { worktree: { copyFiles: ['.codegraph'] } });
    const content = readFileSync(path, 'utf-8');
    const matches = content.match(/\.codegraph/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('writes a timestamped backup before overwriting an existing file', async () => {
    writeFileSync(path, 'botName: Original\n', 'utf-8');
    await mergeYamlConfig(path, { botName: 'Updated' });

    // Backup file should exist alongside, with a .bak.<timestamp> suffix
    const files = require('fs').readdirSync(dir);
    const backup = files.find((f: string) => f.startsWith('config.yaml.bak.'));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dir, backup!), 'utf-8')).toContain('Original');
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test packages/cli/src/setup/yaml-merge.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/cli/src/setup/yaml-merge.ts`:

```ts
/**
 * Read-merge-write a YAML config file.
 *
 * - Creates the file (and parent dirs) when missing.
 * - Deep-merges plain objects; appends to arrays without introducing
 *   duplicates (string-compare).
 * - Writes a timestamped `.bak.<ts>` backup before overwriting.
 *
 * Uses Bun's native YAML parser. Bun's YAML emitter doesn't preserve
 * comments, so for the first-create case we emit a minimal header so users
 * know which file they're looking at.
 */
import { mkdir, readFile, writeFile, copyFile } from 'fs/promises';
import { dirname } from 'path';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(target: Json, source: Json): Json {
  if (isObject(target) && isObject(source)) {
    const out: Record<string, Json> = { ...target };
    for (const [k, v] of Object.entries(source)) {
      out[k] = deepMerge(out[k] ?? (isObject(v) ? {} : Array.isArray(v) ? [] : v), v);
    }
    return out;
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    const out = [...target];
    for (const item of source) {
      // Dedup primitives via JSON equality; skip if already present.
      const exists = out.some((existing) => JSON.stringify(existing) === JSON.stringify(item));
      if (!exists) out.push(item);
    }
    return out;
  }
  return source;
}

export async function mergeYamlConfig(filePath: string, patch: Record<string, Json>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  let existing: Record<string, Json> = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = Bun.YAML.parse(raw);
    if (isObject(parsed)) existing = parsed;

    // Backup before overwrite.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(filePath, `${filePath}.bak.${ts}`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
    // First-create case — no backup needed.
  }

  const merged = deepMerge(existing as Json, patch as Json) as Record<string, Json>;

  // Bun has no YAML emitter — assemble manually using YAML's safe subset.
  const header = `# Archon configuration\n# Managed by \`archon setup\` — edits preserved on merge.\n`;
  await writeFile(filePath, header + stringifyYaml(merged), 'utf-8');
}

function stringifyYaml(value: Json, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (value === null) return 'null\n';
  if (typeof value === 'boolean' || typeof value === 'number') return `${value}\n`;
  if (typeof value === 'string') return `${quoteIfNeeded(value)}\n`;

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n';
    let out = '\n';
    for (const item of value) {
      if (isObject(item) || Array.isArray(item)) {
        out += `${pad}- ${stringifyYaml(item, indent + 1).trimStart()}`;
      } else {
        out += `${pad}- ${quoteIfNeeded(item as string | number | boolean | null)}\n`;
      }
    }
    return out;
  }

  if (isObject(value)) {
    if (Object.keys(value).length === 0) return '{}\n';
    let out = indent === 0 ? '' : '\n';
    for (const [k, v] of Object.entries(value)) {
      if (isObject(v) || Array.isArray(v)) {
        out += `${pad}${k}:${stringifyYaml(v, indent + 1)}`;
      } else {
        out += `${pad}${k}: ${quoteIfNeeded(v as string | number | boolean | null)}\n`;
      }
    }
    return out;
  }

  return '';
}

function quoteIfNeeded(v: string | number | boolean | null): string {
  if (typeof v !== 'string') return String(v);
  if (/^[A-Za-z0-9_\-./]+$/.test(v)) return v;
  return JSON.stringify(v);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
bun test packages/cli/src/setup/yaml-merge.test.ts
```

Expected: PASS — 5 tests. If serialization fails any test, study the output format Bun's `Bun.YAML.parse` accepts on re-parse and adjust `stringifyYaml`. The contract: parse(stringifyYaml(x)) === x for the shapes Archon uses.

- [ ] **Step 5: Type-check + lint**

```bash
bun --filter '@archon/cli' run type-check
bun --filter '@archon/cli' run lint
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/setup/yaml-merge.ts \
        packages/cli/src/setup/yaml-merge.test.ts
git commit -m "feat(cli): add yaml-merge utility for setup wizard

Read-merge-write helper for ~/.archon/config.yaml: creates the file when
missing, preserves user-added keys, deep-merges nested objects, dedupes
array entries on append, writes a timestamped backup before overwriting.
Used by the codegraph setup step (Task 13) and available for any future
wizard step needing YAML writes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Codegraph setup-wizard step

**Files:**
- Create: `packages/cli/src/setup/codegraph-step.ts`
- Create: `packages/cli/src/setup/codegraph-step.test.ts`
- Modify: `packages/cli/src/commands/setup.ts`

- [ ] **Step 1: Read existing setup wizard structure**

```bash
sed -n '1,80p' packages/cli/src/commands/setup.ts
```

Identify: (a) how steps are sequenced, (b) how user input is collected (likely a prompt helper), (c) how `.env` writes happen.

- [ ] **Step 2: Write failing tests**

Create `packages/cli/src/setup/codegraph-step.test.ts`. Match the test shape used by other setup tests (`packages/cli/src/commands/setup.test.ts`). Key behaviors to cover:

```ts
import { describe, expect, it, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCodegraphSetupStep } from './codegraph-step';
import * as detect from '@archon/core/services/codegraph-detect';
import * as exec from '@archon/git';
import * as yaml from './yaml-merge';

describe('codegraph-step', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'archon-cg-step-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing when assistant is not claude', async () => {
    const detectSpy = spyOn(detect, 'detectCodegraphBinary');
    await runCodegraphSetupStep({
      assistant: 'codex',
      envPath: join(dir, '.env'),
      configPath: join(dir, 'config.yaml'),
      prompt: async () => true,
      log: () => {},
    });
    expect(detectSpy).not.toHaveBeenCalled();
    detectSpy.mockRestore();
  });

  it('prompts to enable when binary is already installed', async () => {
    const detectSpy = spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const yamlSpy = spyOn(yaml, 'mergeYamlConfig').mockResolvedValue();

    const prompts: string[] = [];
    await runCodegraphSetupStep({
      assistant: 'claude',
      envPath: join(dir, '.env'),
      configPath: join(dir, 'config.yaml'),
      prompt: async (q) => {
        prompts.push(q);
        return true; // accept
      },
      log: () => {},
    });

    expect(prompts.some((p) => p.toLowerCase().includes('enable'))).toBe(true);
    expect(yamlSpy).toHaveBeenCalled();
    detectSpy.mockRestore();
    yamlSpy.mockRestore();
  });

  it('writes ARCHON_CODEGRAPH_ENABLED=true to .env on accept', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    spyOn(yaml, 'mergeYamlConfig').mockResolvedValue();

    const envPath = join(dir, '.env');
    await runCodegraphSetupStep({
      assistant: 'claude',
      envPath,
      configPath: join(dir, 'config.yaml'),
      prompt: async () => true,
      log: () => {},
    });

    const env = require('fs').readFileSync(envPath, 'utf-8');
    expect(env).toContain('ARCHON_CODEGRAPH_ENABLED=true');
  });

  it('appends .codegraph to worktree.copyFiles in YAML', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const yamlSpy = spyOn(yaml, 'mergeYamlConfig').mockResolvedValue();

    await runCodegraphSetupStep({
      assistant: 'claude',
      envPath: join(dir, '.env'),
      configPath: join(dir, 'config.yaml'),
      prompt: async () => true,
      log: () => {},
    });

    const patches = yamlSpy.mock.calls.map((c: any) => c[1]);
    const worktreePatch = patches.find((p: any) => p.worktree);
    expect(worktreePatch.worktree.copyFiles).toContain('.codegraph');
  });

  it('offers install when binary is missing, runs the installer on accept', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({ found: false });
    const execSpy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: 'installed',
      stderr: '',
    } as any);
    spyOn(yaml, 'mergeYamlConfig').mockResolvedValue();

    const prompts: string[] = [];
    await runCodegraphSetupStep({
      assistant: 'claude',
      envPath: join(dir, '.env'),
      configPath: join(dir, 'config.yaml'),
      prompt: async (q) => {
        prompts.push(q);
        return true; // accept install + enable
      },
      log: () => {},
    });

    expect(prompts.some((p) => p.toLowerCase().includes('install'))).toBe(true);
    // execSpy should have been called at least once (the installer)
    expect(execSpy).toHaveBeenCalled();
    execSpy.mockRestore();
  });

  it('continues without writing when install fails', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({ found: false });
    spyOn(exec, 'execFileAsync').mockRejectedValue(new Error('network down'));
    const yamlSpy = spyOn(yaml, 'mergeYamlConfig').mockResolvedValue();

    await expect(
      runCodegraphSetupStep({
        assistant: 'claude',
        envPath: join(dir, '.env'),
        configPath: join(dir, 'config.yaml'),
        prompt: async () => true,
        log: () => {},
      })
    ).resolves.not.toThrow();
    expect(yamlSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
bun test packages/cli/src/setup/codegraph-step.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `packages/cli/src/setup/codegraph-step.ts`:

```ts
/**
 * Codegraph step of the `archon setup` wizard.
 *
 * Runs immediately after the AI assistant step. Skipped unless the selected
 * assistant is `claude` (codegraph is Claude-only in v1).
 *
 * Behavior:
 *   1. Detect `codegraph` binary.
 *   2a. If found: ask whether to enable codegraph for new codebases.
 *   2b. If missing: ask whether to install. If yes, run the platform installer
 *       (`--target=none --yes` so codegraph does NOT register globally in
 *       ~/.claude.json). Then re-detect.
 *   3. On enable: write ARCHON_CODEGRAPH_ENABLED=true to ~/.archon/.env AND
 *      merge codegraph.enabled=true + worktree.copyFiles=['.codegraph'] into
 *      ~/.archon/config.yaml.
 *   4. Any install/install-verify failure → warn, continue setup.
 */
import { execFileAsync } from '@archon/git';
import { appendFile } from 'fs/promises';
import { detectCodegraphBinary } from '@archon/core/services/codegraph-detect';
import { mergeYamlConfig } from './yaml-merge';

export interface CodegraphStepOptions {
  assistant: string;
  envPath: string;
  configPath: string;
  prompt: (question: string) => Promise<boolean>;
  log: (msg: string) => void;
}

const INSTALL_CMD_DARWIN_LINUX = 'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh -s -- --target=none --yes';
const INSTALL_CMD_WIN = 'irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex';

export async function runCodegraphSetupStep(opts: CodegraphStepOptions): Promise<void> {
  if (opts.assistant !== 'claude') return;

  let detection = await detectCodegraphBinary();

  if (!detection.found) {
    const wantsInstall = await opts.prompt(
      'CodeGraph is a local code knowledge graph that reduces token usage on Claude workflows by ~25%. Install it now?'
    );
    if (!wantsInstall) return;

    try {
      opts.log('Installing CodeGraph…');
      const cmd = process.platform === 'win32' ? INSTALL_CMD_WIN : INSTALL_CMD_DARWIN_LINUX;
      await execFileAsync('sh', ['-c', cmd], { timeout: 5 * 60 * 1000 });

      // re-detect (cache may have a 'not found' answer)
      // Force a fresh probe by importing the test-reset (acceptable: same process)
      const { resetCodegraphDetectionForTests } = await import(
        '@archon/core/services/codegraph-detect'
      );
      resetCodegraphDetectionForTests();
      detection = await detectCodegraphBinary();

      if (!detection.found) {
        opts.log('CodeGraph installer ran but `codegraph --version` still fails. Skipping enable step.');
        return;
      }
      opts.log(`CodeGraph ${detection.version} installed.`);
    } catch (err) {
      const e = err as Error;
      opts.log(`CodeGraph install failed: ${e.message}. Continuing without it; you can run \`archon setup\` again later.`);
      return;
    }
  }

  const wantsEnable = await opts.prompt(
    `Enable CodeGraph by default for new codebases? You can toggle per-workflow later. (CodeGraph version: ${detection.version})`
  );
  if (!wantsEnable) return;

  // Write env override
  await appendFile(opts.envPath, '\nARCHON_CODEGRAPH_ENABLED=true\n', 'utf-8');

  // Merge YAML config
  await mergeYamlConfig(opts.configPath, {
    codegraph: { enabled: true },
  });
  await mergeYamlConfig(opts.configPath, {
    worktree: { copyFiles: ['.codegraph'] },
  });

  opts.log('CodeGraph enabled. Claude nodes in your workflows will use it automatically.');
}
```

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/cli/src/setup/codegraph-step.test.ts
```

Expected: PASS — 6 tests.

- [ ] **Step 6: Wire into `setup.ts`**

Open `packages/cli/src/commands/setup.ts`. Find the step where the AI assistant is selected. After it (and after the existing `.env` write for the assistant), add:

```ts
import { runCodegraphSetupStep } from '../setup/codegraph-step';

// ... after assistant selection + write, before platform tokens step ...

await runCodegraphSetupStep({
  assistant: selectedAssistant, // match local var name
  envPath: homeArchonEnvPath,   // match local var name
  configPath: homeArchonConfigPath, // match local var name; compute if needed
  prompt: (q) => promptYesNo(q, /* default */ true), // match existing prompt helper
  log: console.log,
});
```

The exact variable names depend on the existing setup function's locals — open `setup.ts` and match them. Make sure `homeArchonConfigPath` resolves to `~/.archon/config.yaml`; if no such local exists, derive it from `getArchonConfigPath()` (re-exported from `@archon/paths` — check the existing imports in `config-loader.ts` for the helper name).

- [ ] **Step 7: Run the full setup-command test**

```bash
bun test packages/cli/src/commands/setup.test.ts
```

Expected: all tests PASS. Any failure means the step integration broke an existing assumption — read the failing assertion, fix in `setup.ts`, re-run.

- [ ] **Step 8: Type-check + lint**

```bash
bun --filter '@archon/cli' run type-check
bun --filter '@archon/cli' run lint
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/src/setup/codegraph-step.ts \
        packages/cli/src/setup/codegraph-step.test.ts \
        packages/cli/src/commands/setup.ts
git commit -m "feat(cli): add codegraph step to archon setup wizard

Conditional on assistant=claude. Detects \`codegraph\` binary; offers install
when missing (\`--target=none --yes\` so codegraph does NOT register in
~/.claude.json); on enable, writes ARCHON_CODEGRAPH_ENABLED=true to
~/.archon/.env AND merges codegraph.enabled=true + .codegraph into
worktree.copyFiles in ~/.archon/config.yaml.

Install failure → warn + continue setup (fail open).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Doctor codegraph row

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/src/commands/doctor.test.ts`

- [ ] **Step 1: Read existing doctor output structure**

```bash
sed -n '1,80p' packages/cli/src/commands/doctor.ts
```

Match the existing row format (likely `[PASS] / [FAIL] / [WARN]` prefix + description).

- [ ] **Step 2: Write failing test**

In `packages/cli/src/commands/doctor.test.ts`, add:

```ts
import { spyOn } from 'bun:test';
import * as detect from '@archon/core/services/codegraph-detect';

describe('doctor: codegraph row', () => {
  it('reports PASS with version when binary is present', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const log: string[] = [];
    await runDoctor({ log: (m) => log.push(m) }); // match existing test fixture
    const cgRow = log.find((m) => m.includes('codegraph'));
    expect(cgRow).toBeDefined();
    expect(cgRow!).toContain('PASS');
    expect(cgRow!).toContain('0.18.3');
  });

  it('reports FAIL with install hint when binary is missing', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({ found: false });
    const log: string[] = [];
    await runDoctor({ log: (m) => log.push(m) });
    const cgRow = log.find((m) => m.includes('codegraph'));
    expect(cgRow).toBeDefined();
    expect(cgRow!).toContain('FAIL');
  });
});
```

Adjust `runDoctor` call shape to match the existing test scaffolding.

- [ ] **Step 3: Run to verify failure**

```bash
bun test packages/cli/src/commands/doctor.test.ts -t "codegraph row"
```

Expected: FAIL.

- [ ] **Step 4: Add the row to `doctor.ts`**

In `doctor.ts`, after the existing checks (find a similar pattern like the gh-auth check), add:

```ts
import { detectCodegraphBinary } from '@archon/core/services/codegraph-detect';

// ... in the run function, alongside other checks ...
const cgDetection = await detectCodegraphBinary();
if (cgDetection.found) {
  log(`[PASS] codegraph: ${cgDetection.version} (${cgDetection.path})`);
} else {
  log(
    '[FAIL] codegraph: binary not found on PATH. Install via: ' +
      'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh'
  );
}
```

Match the formatting style of the existing rows.

- [ ] **Step 5: Run to verify pass**

```bash
bun test packages/cli/src/commands/doctor.test.ts -t "codegraph row"
```

Expected: PASS.

- [ ] **Step 6: Smoke-test**

```bash
archon doctor 2>&1 | grep -i codegraph
```

Expected: a single line — either `[PASS] codegraph: ...` or `[FAIL] codegraph: ...`.

- [ ] **Step 7: Type-check + lint**

```bash
bun --filter '@archon/cli' run type-check
bun --filter '@archon/cli' run lint
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/commands/doctor.ts \
        packages/cli/src/commands/doctor.test.ts
git commit -m "feat(cli): add codegraph row to \`archon doctor\` output

Reports PASS with version + path when the binary is present, FAIL with
install hint when missing. One additive row in the existing output stream.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Integration smoke test (skippable)

**Files:**
- Create: `packages/workflows/src/__tests__/codegraph-integration.test.ts`
- Create: `packages/workflows/src/__fixtures__/codegraph-smoke.yaml`
- Create: `packages/workflows/src/__fixtures__/codegraph-smoke-fixture-repo/` (tiny test repo)

- [ ] **Step 1: Create the fixture repo**

```bash
mkdir -p packages/workflows/src/__fixtures__/codegraph-smoke-fixture-repo
cd packages/workflows/src/__fixtures__/codegraph-smoke-fixture-repo
git init -q
```

Create 5 tiny TypeScript files with simple cross-imports. Example contents:

```ts
// foo.ts
export function foo(): string {
  return bar() + '_foo';
}
import { bar } from './bar';
```

```ts
// bar.ts
export function bar(): string { return 'bar'; }
```

```ts
// baz.ts
export function baz(): number { return 42; }
```

```ts
// main.ts
import { foo } from './foo';
import { baz } from './baz';
console.log(foo(), baz());
```

```ts
// types.ts
export type Maybe<T> = T | null;
```

Commit:

```bash
git add . && git commit -q -m "fixture repo"
cd -
```

- [ ] **Step 2: Create the smoke workflow YAML**

Create `packages/workflows/src/__fixtures__/codegraph-smoke.yaml`:

```yaml
name: codegraph-smoke
description: Smoke test for the codegraph MCP attachment. Asks Claude to find callers of `bar`.
codegraph: true
nodes:
  - id: find-callers
    prompt: "Use codegraph tools to find all callers of the function `bar` in this repository. Reply with the function names that call `bar`."
```

- [ ] **Step 3: Write the integration test**

Create `packages/workflows/src/__tests__/codegraph-integration.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const codegraphAvailable = (() => {
  try {
    execFileSync('codegraph', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const fixtureRepo = join(
  __dirname,
  '..',
  '__fixtures__',
  'codegraph-smoke-fixture-repo'
);

describe('codegraph integration smoke', () => {
  it.skipIf(!codegraphAvailable)('runs codegraph-smoke workflow and finds callers', async () => {
    const { mkdirSync, copyFileSync, existsSync } = await import('fs');
    const { join } = await import('path');

    // Copy the smoke workflow into the fixture repo so the CLI discovers it
    const workflowsDir = join(fixtureRepo, '.archon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    copyFileSync(
      join(__dirname, '..', '__fixtures__', 'codegraph-smoke.yaml'),
      join(workflowsDir, 'codegraph-smoke.yaml')
    );

    // Build the codegraph index
    execFileSync('codegraph', ['init', '-i'], { cwd: fixtureRepo, stdio: 'pipe' });
    expect(existsSync(join(fixtureRepo, '.codegraph'))).toBe(true);

    // Run the workflow via the archon CLI
    const output = execFileSync(
      'archon',
      ['workflow', 'run', 'codegraph-smoke', '--no-worktree', 'find callers of bar'],
      { cwd: fixtureRepo, encoding: 'utf-8', stdio: 'pipe', timeout: 5 * 60 * 1000 }
    );

    // The agent should mention `foo` because foo.ts calls bar()
    expect(output.toLowerCase()).toContain('foo');
  });
});
```

The test is intentionally skipped when codegraph isn't installed locally — this allows CI lanes without the binary to still pass.

- [ ] **Step 4: Run the test**

```bash
bun test packages/workflows/src/__tests__/codegraph-integration.test.ts
```

Expected: SKIP (binary not present locally — that's OK) OR PASS (if binary is present).

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/__tests__/codegraph-integration.test.ts \
        packages/workflows/src/__fixtures__/codegraph-smoke.yaml \
        packages/workflows/src/__fixtures__/codegraph-smoke-fixture-repo/
git commit -m "test(workflows): add codegraph smoke integration test

Skipped when codegraph binary not on PATH (CI lanes without it still pass).
Tiny 5-file TS fixture repo + a smoke workflow that asks Claude to find
callers of \`bar\`. Asserts the run completes and codegraph tools were used.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Documentation updates

**Files:**
- Create: `packages/docs-web/src/content/docs/getting-started/codegraph.md`
- Create: `packages/docs-web/src/content/docs/reference/codegraph.md`
- Modify: `packages/docs-web/src/content/docs/reference/configuration.md` (add codegraph section)

- [ ] **Step 1: Read existing docs structure**

```bash
ls packages/docs-web/src/content/docs/getting-started/
ls packages/docs-web/src/content/docs/reference/
```

Match the existing frontmatter and tone.

- [ ] **Step 2: Write the getting-started guide**

Create `packages/docs-web/src/content/docs/getting-started/codegraph.md`. Content outline (write actual content, not placeholders):

- What CodeGraph is (1 paragraph)
- Why we integrated it (link to benchmark, ~25% etc.)
- One-command setup via `archon setup` re-run
- Manual install path: `curl … | sh` + `archon codegraph index <codebase>`
- Per-workflow opt-out: `codegraph: false`
- Quick verification: `archon doctor`

- [ ] **Step 3: Write the reference page**

Create `packages/docs-web/src/content/docs/reference/codegraph.md`. Cover:

- Config schema (`codegraph.enabled`, `autoIndex`, `watchDebounceMs`)
- Env override `ARCHON_CODEGRAPH_ENABLED`
- Workflow-level + node-level overrides
- Resolution order
- CLI commands: `archon codegraph index|sync|status`
- Failure modes (fail open, log catalog)

- [ ] **Step 4: Update configuration reference**

In `packages/docs-web/src/content/docs/reference/configuration.md`, add a `codegraph` subsection under the global config schema. Link to the dedicated reference page.

- [ ] **Step 5: Verify docs build**

```bash
bun --filter '@archon/docs-web' run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/docs-web/src/content/docs/getting-started/codegraph.md \
        packages/docs-web/src/content/docs/reference/codegraph.md \
        packages/docs-web/src/content/docs/reference/configuration.md
git commit -m "docs: add CodeGraph getting-started + reference pages

Covers what codegraph is, why we integrated it, the one-command setup path,
the manual install path, per-workflow opt-out, config schema, resolution
order, CLI commands, and the failure-mode log catalog.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Final validation + PR

**Files:**
- None (validation only)

- [ ] **Step 1: Run the full validation suite**

```bash
bun run validate
```

Expected: all seven checks pass — `check:bundled`, `check:bundled-skill`, `check:bundled-schema`, type-check, lint, format check, and tests.

- [ ] **Step 2: Test the end-to-end flow manually**

```bash
# 1. Install codegraph if not present (mac/linux)
which codegraph || curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# 2. Run setup wizard with the new step (in a separate terminal so prompts work)
archon setup

# 3. After completing the wizard:
archon doctor | grep codegraph

# 4. Run a workflow against a codegraph-indexed codebase
archon workflow run archon-assist --branch test/cg "What does the orchestrator do? Use codegraph if available."
```

Expected: doctor reports PASS; workflow runs successfully; logs include `codegraph.mcp_attached`.

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat: add CodeGraph MCP integration for Claude nodes" --body "$(cat <<'EOF'
## Summary

- Engine-level CodeGraph integration for Claude-flavored workflow nodes
- Three-tier resolution (node → workflow → config), defaults to disabled
- New `mcp-extensions.ts` registry in @archon/providers/claude — codegraph self-registers; provider.ts edited once and never again
- Zero touch to @archon/isolation (rides on existing worktree.copyFiles)
- New `archon codegraph index|sync|status` CLI command
- New `archon doctor` row for codegraph status
- New step in `archon setup` wizard that optionally installs codegraph (`--target=none --yes` so it doesn't register in ~/.claude.json) and writes both env override + YAML config

Spec: `docs/superpowers/specs/2026-05-30-codegraph-integration-design.md`
Plan: `docs/superpowers/plans/2026-05-30-codegraph-integration.md`

Closes #<issue-number-if-applicable>

## Test plan

- [ ] `bun run validate` passes (all 7 checks)
- [ ] `archon doctor` reports codegraph status correctly
- [ ] `archon setup` flows through the codegraph step on a clean install
- [ ] A Claude workflow with `codegraph: true` produces a `codegraph.mcp_attached` log line
- [ ] A Claude workflow with `codegraph: false` does NOT produce that log line
- [ ] Worktree creation copies `.codegraph/` from source (via `worktree.copyFiles`)
- [ ] `archon codegraph status` reports the expected output on a codebase with an index

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for CI**

```bash
gh pr checks
```

Expected: all checks PASS. If anything fails, read the CI output, fix the issue, push, re-run.

---

## Summary

After all 17 tasks:

- **6 new files** under `@archon/core`, `@archon/workflows`, `@archon/providers/claude`, `@archon/cli`
- **8 existing files** touched with additive edits only
- **Zero touches** to `@archon/isolation` (rides on existing `worktree.copyFiles`)
- **One-time** edit to `provider.ts` — future MCP integrations slot in via `registerClaudeMcpExtension(...)` without further edits
- **~30 unit tests** + **1 skippable integration test**
- **2 new docs pages** + **1 docs update**
- **17 commits** with `[codegraph]`-style scoping, suitable for `git rebase --onto upstream` during periodic syncs

The feature is fully opt-in (defaults to disabled) and fails open everywhere (missing binary, failed index, copy errors → log + continue).
