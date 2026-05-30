/**
 * Codegraph step of the `archon setup` wizard.
 *
 * Runs immediately after the AI assistant step. Skipped unless the user
 * selected Claude (codegraph is Claude-only in v1).
 *
 * Behavior:
 *   1. Detect `codegraph` binary.
 *   2a. If found: ask whether to enable codegraph for new codebases.
 *   2b. If missing: ask whether to install. If yes, run the platform installer
 *       (`--target=none --yes` so codegraph does NOT register globally in
 *       ~/.claude.json — Archon's per-node MCP attach is the source of truth).
 *       Then re-detect and ask the enable question.
 *   3. On enable: append ARCHON_CODEGRAPH_ENABLED=true to ~/.archon/.env AND
 *      merge codegraph.enabled=true + .codegraph into worktree.copyFiles into
 *      ~/.archon/config.yaml.
 *   4. Any install / install-verify failure → warn, continue setup.
 *
 * The function is dependency-injected (prompts + log as callables) so it can
 * be unit-tested with spyOn rather than mock.module.
 */
import { appendFile, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  detectCodegraphBinary,
  resetCodegraphDetectionForTests,
} from '@archon/core/services/codegraph-detect';
import { execFileAsync } from '@archon/git';
import { mergeYamlConfig } from './yaml-merge';

export interface CodegraphStepOptions {
  hasClaude: boolean;
  envPath: string;
  configPath: string;
  /** Called after detection. true = user wants codegraph enabled. */
  promptEnable: (version: string | undefined) => Promise<boolean>;
  /** Called when binary missing. true = user wants installer to run. */
  promptInstall: () => Promise<boolean>;
  log: (msg: string) => void;
}

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

function getInstallCommand(): { shell: string; shellArgs: string[] } {
  if (process.platform === 'win32') {
    return {
      shell: 'powershell',
      shellArgs: [
        '-Command',
        'irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex',
      ],
    };
  }
  return {
    shell: 'sh',
    shellArgs: [
      '-c',
      'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh -s -- --target=none --yes',
    ],
  };
}

async function appendEnvLine(envPath: string, line: string): Promise<void> {
  const key = line.split('=')[0];
  // If the file exists and already contains the key, replace in-place for idempotency.
  if (existsSync(envPath)) {
    const existing = await readFile(envPath, 'utf-8');
    if (existing.split('\n').some(l => l.startsWith(key + '='))) {
      const updated = existing
        .split('\n')
        .map(l => (l.startsWith(key + '=') ? line : l))
        .join('\n');
      await writeFile(envPath, updated, 'utf-8');
      return;
    }
    await appendFile(envPath, (existing.endsWith('\n') ? '' : '\n') + line + '\n', 'utf-8');
    return;
  }
  await writeFile(envPath, line + '\n', 'utf-8');
}

export async function runCodegraphSetupStep(opts: CodegraphStepOptions): Promise<void> {
  if (!opts.hasClaude) return;

  let detection = await detectCodegraphBinary();

  if (!detection.found) {
    const wantsInstall = await opts.promptInstall();
    if (!wantsInstall) return;

    try {
      opts.log('Installing CodeGraph…');
      const { shell, shellArgs } = getInstallCommand();
      await execFileAsync(shell, shellArgs, { timeout: INSTALL_TIMEOUT_MS });

      // Detection cache may have cached found:false. Reset and re-probe.
      // resetCodegraphDetectionForTests is the canonical cache-clear function —
      // after a fresh install, the world has changed and we must re-probe.
      resetCodegraphDetectionForTests();
      detection = await detectCodegraphBinary();

      if (!detection.found) {
        opts.log(
          'CodeGraph installer ran but `codegraph --version` still fails. Skipping enable step.'
        );
        return;
      }
      opts.log(`CodeGraph ${detection.version} installed.`);
    } catch (err) {
      opts.log(
        `CodeGraph install failed: ${(err as Error).message}. Continuing without it; you can run \`archon setup\` again later or install manually.`
      );
      return;
    }
  }

  const version = detection.found ? detection.version : undefined;
  const wantsEnable = await opts.promptEnable(version);
  if (!wantsEnable) return;

  // Write env override (idempotent)
  await appendEnvLine(opts.envPath, 'ARCHON_CODEGRAPH_ENABLED=true');

  // Merge YAML config (two patches — codegraph block + worktree.copyFiles)
  await mergeYamlConfig(opts.configPath, { codegraph: { enabled: true } });
  await mergeYamlConfig(opts.configPath, { worktree: { copyFiles: ['.codegraph'] } });

  opts.log('CodeGraph enabled. Claude nodes in your workflows will use it automatically.');
}
