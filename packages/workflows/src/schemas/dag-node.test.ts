import { describe, expect, it } from 'bun:test';
import { dagNodeSchema } from './dag-node';

describe('dag-node schema: codegraph field', () => {
  it('accepts codegraph: true on a prompt node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n1',
      prompt: 'hello',
      codegraph: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // The transform produces a typed variant; codegraph should be accessible
      // on the result data (cast through unknown if the TS type doesn't expose it directly).
      const data = result.data as { codegraph?: boolean };
      expect(data.codegraph).toBe(true);
    }
  });

  it('accepts codegraph: false on a command node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n2',
      command: 'investigate',
      codegraph: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts omitted codegraph', () => {
    const result = dagNodeSchema.safeParse({ id: 'n3', prompt: 'hello' });
    expect(result.success).toBe(true);
  });

  it('rejects codegraph as a string', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n4',
      prompt: 'hello',
      codegraph: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('rejects codegraph as a number', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n5',
      prompt: 'hello',
      codegraph: 1,
    });
    expect(result.success).toBe(false);
  });
});
