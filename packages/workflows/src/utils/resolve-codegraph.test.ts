import { describe, expect, it } from 'bun:test';
import { resolveCodegraph } from './resolve-codegraph';

describe('resolveCodegraph', () => {
  const cfgOn = { codegraph: { enabled: true } } as any;
  const cfgOff = { codegraph: { enabled: false } } as any;

  it('node=true → true (overrides everything)', () => {
    expect(resolveCodegraph({ codegraph: true } as any, { codegraph: false } as any, cfgOff)).toBe(
      true
    );
  });

  it('node=false → false (overrides everything)', () => {
    expect(resolveCodegraph({ codegraph: false } as any, { codegraph: true } as any, cfgOn)).toBe(
      false
    );
  });

  it('workflow=true (node unset) → true', () => {
    expect(resolveCodegraph({} as any, { codegraph: true } as any, cfgOff)).toBe(true);
  });

  it('workflow=false (node unset) → false', () => {
    expect(resolveCodegraph({} as any, { codegraph: false } as any, cfgOn)).toBe(false);
  });

  it('config.enabled=true (node + workflow unset) → true', () => {
    expect(resolveCodegraph({} as any, {} as any, cfgOn)).toBe(true);
  });

  it('config.enabled=false (node + workflow unset) → false', () => {
    expect(resolveCodegraph({} as any, {} as any, cfgOff)).toBe(false);
  });

  it('nothing set anywhere → false', () => {
    expect(resolveCodegraph({} as any, {} as any, { codegraph: {} } as any)).toBe(false);
  });

  it('undefined config gracefully degrades to false', () => {
    expect(resolveCodegraph({} as any, {} as any, {} as any)).toBe(false);
  });
});
