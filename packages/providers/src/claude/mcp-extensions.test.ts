import { afterEach, describe, expect, it } from 'bun:test';
import {
  registerClaudeMcpExtension,
  collectClaudeMcpExtensions,
  resetClaudeMcpExtensionsForTests,
  type ClaudeMcpCtx,
} from './mcp-extensions';

const fakeCtx: ClaudeMcpCtx = {
  workflow: {},
  node: { id: 'n1' },
  config: { codegraph: { enabled: false } },
  cwd: '/tmp/wt',
};

describe('ClaudeMcpExtensions registry', () => {
  afterEach(() => resetClaudeMcpExtensionsForTests());

  it('returns an empty object when no extensions are registered', () => {
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
    expect(result.foo.command).toBe('second');
  });

  it('preserves registration order across multiple non-colliding extensions', () => {
    registerClaudeMcpExtension(() => ({ a: { type: 'stdio', command: 'a', args: [] } }));
    registerClaudeMcpExtension(() => ({ b: { type: 'stdio', command: 'b', args: [] } }));
    registerClaudeMcpExtension(() => ({ c: { type: 'stdio', command: 'c', args: [] } }));
    const result = collectClaudeMcpExtensions(fakeCtx);
    expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
  });
});
