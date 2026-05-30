import { describe, expect, it, spyOn } from 'bun:test';
import * as detectModule from './codegraph-detect';
import * as gitModule from '@archon/git';
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

    const spawnSpy = spyOn(gitModule, 'execFileAsync').mockRejectedValue(
      Object.assign(new Error('exit 1'), { code: 1, stderr: 'broken' })
    );

    const result = await bootstrapCodegraphIndex('/some/source/path');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('index_failed');

    spawnSpy.mockRestore();
    detectSpy.mockRestore();
  });

  it('returns ok: false with reason: index_timeout when child is killed after >= timeout window', async () => {
    const detectSpy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });

    // Simulate a SIGTERM that fires AFTER the timeout would have elapsed.
    // Flip the phase to 'after' before throwing so that Date.now() in the
    // catch block returns the "post-timeout" timestamp.
    const spawnSpy = spyOn(gitModule, 'execFileAsync').mockImplementation(async () => {
      phase = 'after';
      throw Object.assign(new Error('Command failed: codegraph init -i'), {
        killed: true,
        code: null,
        signal: 'SIGTERM',
      });
    });

    // Stub Date.now() with fixed timestamps so that:
    //   - pino's "index_started" log call + `startedAt = Date.now()` both
    //     return T0 (the "before" phase).
    //   - `durationMs = Date.now() - startedAt` in the catch block and pino's
    //     error log call return T0 + INDEX_TIMEOUT_MS (the "after" phase).
    //
    // The execFileAsync mock sets `phase = 'after'` just before it throws, so
    // the transition happens at the right point regardless of how many times
    // pino calls Date.now() internally before vs. after the spawn.
    const T0 = 1_000_000;
    const INDEX_TIMEOUT_MS = 10 * 60 * 1000;
    let phase: 'before' | 'after' = 'before';
    const dateSpy = spyOn(Date, 'now').mockImplementation(() =>
      phase === 'before' ? T0 : T0 + INDEX_TIMEOUT_MS
    );

    const result = await bootstrapCodegraphIndex('/some/source/path');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('index_timeout');

    dateSpy.mockRestore();
    spawnSpy.mockRestore();
    detectSpy.mockRestore();
  });

  it('classifies a SIGTERM that fires BEFORE the timeout window as index_failed (external kill)', async () => {
    const detectSpy = spyOn(detectModule, 'detectCodegraphBinary').mockResolvedValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });

    // SIGTERM immediately, no elapsed time → external kill, not a timeout
    const spawnSpy = spyOn(gitModule, 'execFileAsync').mockRejectedValue(
      Object.assign(new Error('Command failed: codegraph init -i'), {
        killed: true,
        code: null,
        signal: 'SIGTERM',
      })
    );

    const result = await bootstrapCodegraphIndex('/some/source/path');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('index_failed');

    spawnSpy.mockRestore();
    detectSpy.mockRestore();
  });
});
