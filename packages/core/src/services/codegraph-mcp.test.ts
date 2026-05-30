import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spyOn } from 'bun:test';
import {
  collectClaudeMcpExtensions,
  resetClaudeMcpExtensionsForTests,
} from '@archon/providers/claude/mcp-extensions';
import * as detectModule from './codegraph-detect';
import { codegraphMcpExtension, resetCodegraphMcpForTests } from './codegraph-mcp';
import { registerClaudeMcpExtension } from '@archon/providers/claude/mcp-extensions';

const baseCtx = {
  workflow: {} as { codegraph?: boolean },
  node: { id: 'n1' } as { codegraph?: boolean; id: string },
  config: { codegraph: { enabled: true, watchDebounceMs: 2000 } },
  cwd: '/tmp/worktree',
};

describe('codegraphMcpExtension', () => {
  beforeEach(() => {
    resetClaudeMcpExtensionsForTests();
    resetCodegraphMcpForTests();
    registerClaudeMcpExtension(codegraphMcpExtension);
  });

  afterEach(() => {
    resetClaudeMcpExtensionsForTests();
  });

  it('returns no entry when effective flag is false (config off, no overrides)', () => {
    const result = collectClaudeMcpExtensions({
      ...baseCtx,
      config: { codegraph: { enabled: false } },
    });
    expect(result).toEqual({});
  });

  it('returns no entry when binary cache is null (detection has not run)', () => {
    const spy = spyOn(detectModule, 'getCachedCodegraphDetection').mockReturnValue(null);
    const result = collectClaudeMcpExtensions(baseCtx);
    expect(result).toEqual({});
    spy.mockRestore();
  });

  it('returns no entry when binary cache reports found:false', () => {
    const spy = spyOn(detectModule, 'getCachedCodegraphDetection').mockReturnValue({
      found: false,
    });
    const result = collectClaudeMcpExtensions(baseCtx);
    expect(result).toEqual({});
    spy.mockRestore();
  });

  it('returns a codegraph stdio entry when enabled + binary cached', () => {
    const spy = spyOn(detectModule, 'getCachedCodegraphDetection').mockReturnValue({
      found: true,
      path: '/usr/local/bin/codegraph',
      version: '0.18.3',
    });
    const result = collectClaudeMcpExtensions(baseCtx);
    expect(result.codegraph).toBeDefined();
    expect(result.codegraph).toMatchObject({
      type: 'stdio',
      command: '/usr/local/bin/codegraph',
      args: ['serve', '--mcp'],
      cwd: '/tmp/worktree',
    });
    expect(result.codegraph.env?.CODEGRAPH_WATCH_DEBOUNCE_MS).toBe('2000');
    spy.mockRestore();
  });

  it('node.codegraph=true overrides config.enabled=false', () => {
    const spy = spyOn(detectModule, 'getCachedCodegraphDetection').mockReturnValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const result = collectClaudeMcpExtensions({
      ...baseCtx,
      node: { id: 'n1', codegraph: true },
      config: { codegraph: { enabled: false } },
    });
    expect(result.codegraph).toBeDefined();
    spy.mockRestore();
  });

  it('node.codegraph=false overrides config.enabled=true', () => {
    const spy = spyOn(detectModule, 'getCachedCodegraphDetection').mockReturnValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const result = collectClaudeMcpExtensions({
      ...baseCtx,
      node: { id: 'n1', codegraph: false },
    });
    expect(result).toEqual({});
    spy.mockRestore();
  });

  it('defaults watchDebounceMs to 2000 when config.codegraph.watchDebounceMs is missing', () => {
    const spy = spyOn(detectModule, 'getCachedCodegraphDetection').mockReturnValue({
      found: true,
      path: 'codegraph',
      version: '0.18.3',
    });
    const result = collectClaudeMcpExtensions({
      ...baseCtx,
      config: { codegraph: { enabled: true } }, // no watchDebounceMs
    });
    expect(result.codegraph.env?.CODEGRAPH_WATCH_DEBOUNCE_MS).toBe('2000');
    spy.mockRestore();
  });
});
