import { afterEach, describe, expect, it, spyOn } from 'bun:test';

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

  it('deduplicates concurrent in-flight calls to a single execFileAsync invocation', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: '0.18.3\n',
      stderr: '',
    } as any);

    // Both launched before either await resolves — both share the inflight Promise.
    const [r1, r2] = await Promise.all([detectCodegraphBinary(), detectCodegraphBinary()]);
    expect(r1).toEqual({ found: true, path: 'codegraph', version: '0.18.3' });
    expect(r2).toEqual({ found: true, path: 'codegraph', version: '0.18.3' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('returns { found: false } when --version output is not a semver shape', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: 'codegraph: hello world\n',
      stderr: '',
    } as any);

    const result = await detectCodegraphBinary();
    expect(result).toEqual({ found: false });
    spy.mockRestore();
  });

  it('parses a v-prefixed semver: v0.18.3 → 0.18.3', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: 'v0.18.3\n',
      stderr: '',
    } as any);

    const result = await detectCodegraphBinary();
    expect(result).toEqual({ found: true, path: 'codegraph', version: '0.18.3' });
    spy.mockRestore();
  });
});
