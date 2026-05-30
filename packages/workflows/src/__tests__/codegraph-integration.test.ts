import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Skippable integration smoke test for the codegraph MCP integration.
 *
 * Runs the full chain: archon CLI -> workflow loader -> codegraph extension
 * registers -> Claude SDK spawns codegraph serve --mcp -> codegraph reads the
 * indexed worktree. The test SKIPS when `codegraph` is not on PATH so CI
 * environments without codegraph (the default) still pass.
 *
 * When run with codegraph installed, the test:
 *  1. Builds a fresh tmpdir from the static fixture files.
 *  2. Runs `git init` + initial commit so worktree-isolation works.
 *  3. Runs `codegraph init -i` to build the index.
 *  4. Copies the smoke workflow into .archon/workflows/.
 *  5. Runs `archon workflow run codegraph-smoke --no-worktree ...` against it.
 *  6. Asserts the workflow run completes (exit code 0) and the agent's
 *     output mentions `foo` (since foo.ts calls bar()).
 *
 * The --no-worktree flag is critical: workflow runs by default create a
 * worktree, but the fixture repo lives in a tmpdir that isn't already
 * registered as a codebase. Running in-place avoids the worktree creation.
 */

const codegraphAvailable = (() => {
  try {
    execFileSync('codegraph', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const archonAvailable = (() => {
  try {
    execFileSync('archon', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const FIXTURE_REPO_SRC = join(__dirname, '..', '__fixtures__', 'codegraph-smoke-fixture-repo');
const SMOKE_WORKFLOW_SRC = join(__dirname, '..', '__fixtures__', 'codegraph-smoke.yaml');

describe('codegraph integration smoke', () => {
  const skipReason = !codegraphAvailable
    ? 'codegraph binary not on PATH'
    : !archonAvailable
      ? 'archon binary not on PATH (run `bun link` in packages/cli)'
      : null;

  it.skipIf(skipReason !== null)(
    'runs codegraph-smoke workflow against a fixture repo and the agent identifies foo as a caller of bar',
    () => {
      // Set up a fresh fixture repo in a tmpdir.
      const workDir = mkdtempSync(join(tmpdir(), 'archon-codegraph-smoke-'));
      try {
        // Copy fixture TS files into the tmpdir.
        for (const file of readdirSync(FIXTURE_REPO_SRC)) {
          copyFileSync(join(FIXTURE_REPO_SRC, file), join(workDir, file));
        }

        // Initialize as a git repo (worktree-isolation expects it; we run with
        // --no-worktree but the CLI still enforces "be inside a git repo").
        execFileSync('git', ['init', '-q'], { cwd: workDir });
        execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: workDir });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir });
        execFileSync('git', ['add', '.'], { cwd: workDir });
        execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: workDir });

        // Build the codegraph index.
        execFileSync('codegraph', ['init', '-i'], { cwd: workDir, stdio: 'pipe' });
        expect(existsSync(join(workDir, '.codegraph'))).toBe(true);

        // Copy the smoke workflow into .archon/workflows/.
        const workflowsDir = join(workDir, '.archon', 'workflows');
        mkdirSync(workflowsDir, { recursive: true });
        copyFileSync(SMOKE_WORKFLOW_SRC, join(workflowsDir, 'codegraph-smoke.yaml'));

        // Run the workflow via archon CLI. The --no-worktree flag prevents
        // worktree creation (the fixture repo isn't a registered codebase).
        // We set ARCHON_CODEGRAPH_ENABLED=true to ensure the codegraph extension
        // attaches even though the global config has it off by default.
        const output = execFileSync(
          'archon',
          ['workflow', 'run', 'codegraph-smoke', '--no-worktree', 'find callers of bar'],
          {
            cwd: workDir,
            encoding: 'utf-8',
            stdio: 'pipe',
            timeout: 5 * 60 * 1000,
            env: { ...process.env, ARCHON_CODEGRAPH_ENABLED: 'true' },
          }
        );

        // The agent should mention `foo` because foo.ts calls bar().
        expect(output.toLowerCase()).toContain('foo');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    /* timeout */ 10 * 60 * 1000
  );

  it('exposes a clear skip reason when codegraph or archon binaries are missing (sanity)', () => {
    // This always-running test just verifies the skip logic is exercising the
    // right environment probes. It's mostly a guard against the skipIf
    // accidentally turning into an always-pass.
    if (codegraphAvailable && archonAvailable) {
      expect(skipReason).toBeNull();
    } else {
      expect(skipReason).not.toBeNull();
    }
  });
});
