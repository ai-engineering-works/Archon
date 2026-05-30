import { describe, expect, it } from 'bun:test';
import { spyOn } from 'bun:test';
import * as exec from '@archon/git';
import { runCodegraphCommand } from './codegraph';

describe('archon codegraph CLI', () => {
  it('prints usage and exits 1 with no subcommand', async () => {
    const log: string[] = [];
    let exitCode: number | undefined;
    await expect(
      runCodegraphCommand({
        args: [],
        log: m => log.push(m),
        exit: ((c: number) => {
          exitCode = c;
          throw new Error(`exit:${c}`);
        }) as (code: number) => never,
      })
    ).rejects.toThrow('exit:1');
    expect(exitCode).toBe(1);
    expect(log.some(m => m.toLowerCase().includes('usage'))).toBe(true);
  });

  it('runs `codegraph init -i` for `archon codegraph index`', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: 'OK',
      stderr: '',
    } as never);

    await runCodegraphCommand({
      args: ['index'],
      log: () => {},
      exit: () => undefined as never,
    });
    expect(spy).toHaveBeenCalledWith('codegraph', ['init', '-i'], expect.any(Object));
    spy.mockRestore();
  });

  it('runs `codegraph sync` for `archon codegraph sync`', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: '',
      stderr: '',
    } as never);

    await runCodegraphCommand({
      args: ['sync'],
      log: () => {},
      exit: () => undefined as never,
    });
    expect(spy).toHaveBeenCalledWith('codegraph', ['sync'], expect.any(Object));
    spy.mockRestore();
  });

  it('runs `codegraph status` for `archon codegraph status` and prints stdout', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: 'indexed: yes\nfiles: 100\n',
      stderr: '',
    } as never);

    const log: string[] = [];
    await runCodegraphCommand({
      args: ['status'],
      log: m => log.push(m),
      exit: () => undefined as never,
    });
    expect(log.join('\n')).toContain('indexed: yes');
    spy.mockRestore();
  });

  it('rejects unknown subcommand and exits 1', async () => {
    const log: string[] = [];
    let exitCode: number | undefined;
    await expect(
      runCodegraphCommand({
        args: ['unknown-thing'],
        log: m => log.push(m),
        exit: ((c: number) => {
          exitCode = c;
          throw new Error(`exit:${c}`);
        }) as (code: number) => never,
      })
    ).rejects.toThrow('exit:1');
    expect(exitCode).toBe(1);
    expect(log.some(m => m.toLowerCase().includes('unknown'))).toBe(true);
  });

  it('prints a clear error and exits 1 when binary is missing', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    );

    const log: string[] = [];
    let exitCode: number | undefined;
    await expect(
      runCodegraphCommand({
        args: ['index'],
        log: m => log.push(m),
        exit: ((c: number) => {
          exitCode = c;
          throw new Error(`exit:${c}`);
        }) as (code: number) => never,
      })
    ).rejects.toThrow();
    expect(exitCode).toBe(1);
    expect(log.some(m => m.toLowerCase().includes('not found'))).toBe(true);
    spy.mockRestore();
  });

  it('passes a custom cwd via the second positional arg', async () => {
    const spy = spyOn(exec, 'execFileAsync').mockResolvedValue({
      stdout: '',
      stderr: '',
    } as never);

    await runCodegraphCommand({
      args: ['index', '/some/repo'],
      log: () => {},
      exit: () => undefined as never,
    });
    expect(spy).toHaveBeenCalledWith(
      'codegraph',
      ['init', '-i'],
      expect.objectContaining({ cwd: '/some/repo' })
    );
    spy.mockRestore();
  });
});
