import { describe, expect, it } from 'bun:test';
import { resolveCodegraph, type ResolveCodegraphConfig } from './resolve-codegraph';

describe('resolveCodegraph', () => {
  const cfgOn: ResolveCodegraphConfig = { codegraph: { enabled: true } };
  const cfgOff: ResolveCodegraphConfig = { codegraph: { enabled: false } };

  it('node=true → true (overrides everything)', () => {
    expect(resolveCodegraph({ codegraph: true }, { codegraph: false }, cfgOff)).toBe(true);
  });

  it('node=false → false (overrides everything)', () => {
    expect(resolveCodegraph({ codegraph: false }, { codegraph: true }, cfgOn)).toBe(false);
  });

  it('workflow=true (node unset) → true', () => {
    expect(resolveCodegraph({}, { codegraph: true }, cfgOff)).toBe(true);
  });

  it('workflow=false (node unset) → false', () => {
    expect(resolveCodegraph({}, { codegraph: false }, cfgOn)).toBe(false);
  });

  it('config.enabled=true (node + workflow unset) → true', () => {
    expect(resolveCodegraph({}, {}, cfgOn)).toBe(true);
  });

  it('config.enabled=false (node + workflow unset) → false', () => {
    expect(resolveCodegraph({}, {}, cfgOff)).toBe(false);
  });

  it('nothing set anywhere → false', () => {
    expect(resolveCodegraph({}, {}, { codegraph: {} })).toBe(false);
  });

  it('undefined config gracefully degrades to false', () => {
    expect(resolveCodegraph({}, {}, {})).toBe(false);
  });
});
