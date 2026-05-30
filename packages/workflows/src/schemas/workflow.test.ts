import { describe, expect, it } from 'bun:test';
import { workflowDefinitionSchema } from './workflow';

describe('workflow schema: codegraph field', () => {
  const baseWorkflow = {
    name: 'test-wf',
    description: 'test',
    nodes: [],
  };

  it('accepts codegraph: true', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.codegraph).toBe(true);
  });

  it('accepts codegraph: false', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.codegraph).toBe(false);
  });

  it('accepts omitted codegraph', () => {
    const result = workflowDefinitionSchema.safeParse(baseWorkflow);
    expect(result.success).toBe(true);
  });

  it('rejects codegraph as non-boolean string', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects codegraph as a number', () => {
    const result = workflowDefinitionSchema.safeParse({ ...baseWorkflow, codegraph: 1 });
    expect(result.success).toBe(false);
  });
});
