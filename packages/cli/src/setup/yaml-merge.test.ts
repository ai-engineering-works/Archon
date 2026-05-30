import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  it('creates the file (and parent dirs) when it does not exist', async () => {
    const newPath = join(dir, 'sub', 'nested', 'config.yaml');
    await mergeYamlConfig(newPath, { codegraph: { enabled: true } });
    const content = readFileSync(newPath, 'utf-8');
    expect(content).toContain('codegraph:');
    expect(content).toContain('enabled: true');
  });

  it('preserves user-added top-level keys', async () => {
    writeFileSync(path, 'botName: MyBot\nassistant: codex\n', 'utf-8');
    await mergeYamlConfig(path, { codegraph: { enabled: true } });
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('botName: MyBot');
    expect(content).toContain('assistant: codex');
    expect(content).toContain('codegraph:');
    expect(content).toContain('enabled: true');
  });

  it('deep-merges nested objects without removing siblings', async () => {
    writeFileSync(path, 'worktree:\n  baseBranch: main\n  copyFiles:\n    - .env\n', 'utf-8');
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

    const files = readdirSync(dir);
    const backup = files.find(f => f.startsWith('config.yaml.bak.'));
    expect(backup).toBeDefined();
    expect(readFileSync(join(dir, backup!), 'utf-8')).toContain('Original');
  });

  it('round-trips: written YAML can be re-parsed and merged again', async () => {
    await mergeYamlConfig(path, { codegraph: { enabled: true, watchDebounceMs: 2000 } });
    await mergeYamlConfig(path, { worktree: { copyFiles: ['.codegraph'] } });
    const content = readFileSync(path, 'utf-8');
    // Round-trip via Bun.YAML.parse
    const parsed = Bun.YAML.parse(content) as Record<string, unknown>;
    expect((parsed.codegraph as { enabled: boolean }).enabled).toBe(true);
    expect((parsed.codegraph as { watchDebounceMs: number }).watchDebounceMs).toBe(2000);
    expect((parsed.worktree as { copyFiles: string[] }).copyFiles).toContain('.codegraph');
  });

  it('handles top-level boolean / number / string scalar values', async () => {
    await mergeYamlConfig(path, {
      botName: 'Archon',
      maxConcurrent: 10,
      streaming: { telegram: 'stream', discord: 'batch' },
    });
    const parsed = Bun.YAML.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(parsed.botName).toBe('Archon');
    expect(parsed.maxConcurrent).toBe(10);
    expect((parsed.streaming as Record<string, string>).telegram).toBe('stream');
  });

  it('round-trips string values that look like YAML scalars (true, false, null, numbers)', async () => {
    await mergeYamlConfig(path, {
      botName: 'true', // string, not bool
      description: 'null', // string, not null
      version: '1.0', // string, not number
      hex: '0x1a', // string, not int
    });
    const parsed = Bun.YAML.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(parsed.botName).toBe('true'); // string preserved, not boolean
    expect(parsed.description).toBe('null'); // string preserved, not null
    expect(parsed.version).toBe('1.0'); // string preserved, not number
    expect(parsed.hex).toBe('0x1a'); // string preserved, not int
  });

  it('accepts a custom header parameter, falling back to the default when omitted', async () => {
    // Default header
    await mergeYamlConfig(path, { foo: 'bar' });
    expect(readFileSync(path, 'utf-8')).toContain('# Managed by');

    // Custom header
    const path2 = join(dir, 'other.yaml');
    await mergeYamlConfig(path2, { foo: 'bar' }, '# my custom header\n');
    const content2 = readFileSync(path2, 'utf-8');
    expect(content2).toContain('# my custom header');
    expect(content2).not.toContain('# Managed by');
  });
});
