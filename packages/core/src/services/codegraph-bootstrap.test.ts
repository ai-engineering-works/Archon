import { afterEach, describe, expect, it } from 'bun:test';
import { spyOn } from 'bun:test';
import * as detectModule from './codegraph-detect';
import { bootstrapCodegraphIndex } from './codegraph-bootstrap';

describe('bootstrapCodegraphIndex', () => {
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

    const gitModule = await import('@archon/git');
    const spawnSpy = spyOn(gitModule, 'execFileAsync').mockResolvedValue({
      stdout: 'OK',
      stderr: '',
    } as any);

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

    const gitModule = await import('@archon/git');
    const spawnSpy = spyOn(gitModule, 'execFileAsync').mockRejectedValue(
      Object.assign(new Error('exit 1'), { code: 1, stderr: 'broken' })
    );

    const result = await bootstrapCodegraphIndex('/some/source/path');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('index_failed');

    spawnSpy.mockRestore();
    detectSpy.mockRestore();
  });
});
