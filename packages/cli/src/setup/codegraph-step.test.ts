import { describe, expect, it, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as detect from '@archon/core/services/codegraph-detect';
import * as exec from '@archon/git';
import * as yamlMerge from './yaml-merge';
import { runCodegraphSetupStep } from './codegraph-step';

describe('runCodegraphSetupStep', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'archon-cg-step-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips entirely when assistant is not claude', async () => {
    const detectSpy = spyOn(detect, 'detectCodegraphBinary');
    await runCodegraphSetupStep({
      hasClaude: false,
      envPath: join(dir, '.env'),
      configPath: join(dir, 'config.yaml'),
      promptEnable: async () => true,
      promptInstall: async () => true,
      log: () => {},
    });
    expect(detectSpy).not.toHaveBeenCalled();
    detectSpy.mockRestore();
  });

  it('prompts to enable when binary already installed; on accept, writes env + yaml', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const yamlSpy = spyOn(yamlMerge, 'mergeYamlConfig').mockResolvedValue();
    const envPath = join(dir, '.env');

    let installPrompted = false;
    let enablePrompted = false;
    await runCodegraphSetupStep({
      hasClaude: true,
      envPath,
      configPath: join(dir, 'config.yaml'),
      promptEnable: async () => {
        enablePrompted = true;
        return true;
      },
      promptInstall: async () => {
        installPrompted = true;
        return true;
      },
      log: () => {},
    });

    expect(installPrompted).toBe(false); // binary already present, no install prompt
    expect(enablePrompted).toBe(true);
    expect(readFileSync(envPath, 'utf-8')).toContain('ARCHON_CODEGRAPH_ENABLED=true');
    expect(yamlSpy).toHaveBeenCalled();
    const patches = yamlSpy.mock.calls.map(c => c[1]);
    // codegraph.enabled merged
    expect(
      patches.some(p => (p as { codegraph?: { enabled?: boolean } }).codegraph?.enabled === true)
    ).toBe(true);
    // .codegraph added to worktree.copyFiles
    expect(
      patches.some(p => {
        const wt = (p as { worktree?: { copyFiles?: unknown[] } }).worktree;
        return Array.isArray(wt?.copyFiles) && wt!.copyFiles.includes('.codegraph');
      })
    ).toBe(true);
    yamlSpy.mockRestore();
  });

  it('declining enable does not write env or yaml', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const yamlSpy = spyOn(yamlMerge, 'mergeYamlConfig').mockResolvedValue();
    const envPath = join(dir, '.env');

    await runCodegraphSetupStep({
      hasClaude: true,
      envPath,
      configPath: join(dir, 'config.yaml'),
      promptEnable: async () => false,
      promptInstall: async () => true,
      log: () => {},
    });

    expect(yamlSpy).not.toHaveBeenCalled();
    const envContent = await import('node:fs').then(fs =>
      fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : ''
    );
    expect(envContent).not.toContain('ARCHON_CODEGRAPH_ENABLED');
    yamlSpy.mockRestore();
  });

  it('offers install when binary missing; accepted install runs the installer + then re-detects', async () => {
    const detectSpy = spyOn(detect, 'detectCodegraphBinary')
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({ found: true, path: 'codegraph', version: '0.18.3' });

    // The implementation calls resetCodegraphDetectionForTests between detections
    // OR re-imports — verify the test still works given the cache-reset strategy.
    // Match whatever strategy you used in the impl.

    const execSpy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: '',
      stderr: '',
    } as never);
    const yamlSpy = spyOn(yamlMerge, 'mergeYamlConfig').mockResolvedValue();
    const envPath = join(dir, '.env');

    let installPromptCount = 0;
    await runCodegraphSetupStep({
      hasClaude: true,
      envPath,
      configPath: join(dir, 'config.yaml'),
      promptEnable: async () => true,
      promptInstall: async () => {
        installPromptCount++;
        return true;
      },
      log: () => {},
    });

    expect(installPromptCount).toBe(1);
    expect(execSpy).toHaveBeenCalled(); // installer ran
    // After successful install + re-detect, enable path runs:
    expect(readFileSync(envPath, 'utf-8')).toContain('ARCHON_CODEGRAPH_ENABLED=true');

    execSpy.mockRestore();
    detectSpy.mockRestore();
    yamlSpy.mockRestore();
  });

  it('install failure warns and continues without writing anything', async () => {
    const detectSpy = spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({ found: false });
    const execSpy2 = spyOn(exec, 'execFileAsync').mockRejectedValue(new Error('network down'));
    const yamlSpy = spyOn(yamlMerge, 'mergeYamlConfig').mockResolvedValue();
    const envPath = join(dir, '.env');

    const logged: string[] = [];
    await runCodegraphSetupStep({
      hasClaude: true,
      envPath,
      configPath: join(dir, 'config.yaml'),
      promptEnable: async () => true,
      promptInstall: async () => true,
      log: m => logged.push(m),
    });

    expect(yamlSpy).not.toHaveBeenCalled();
    expect(logged.some(m => m.toLowerCase().includes('install'))).toBe(true);
    yamlSpy.mockRestore();
    execSpy2.mockRestore();
    detectSpy.mockRestore();
  });

  it('declined install (binary missing, user says no) skips silently', async () => {
    spyOn(detect, 'detectCodegraphBinary').mockResolvedValue({ found: false });
    const execSpy = spyOn(exec, 'execFileAsync').mockResolvedValue({} as never);
    const yamlSpy = spyOn(yamlMerge, 'mergeYamlConfig').mockResolvedValue();

    await runCodegraphSetupStep({
      hasClaude: true,
      envPath: join(dir, '.env'),
      configPath: join(dir, 'config.yaml'),
      promptEnable: async () => true,
      promptInstall: async () => false,
      log: () => {},
    });

    expect(execSpy).not.toHaveBeenCalled();
    expect(yamlSpy).not.toHaveBeenCalled();
    execSpy.mockRestore();
    yamlSpy.mockRestore();
  });
});
