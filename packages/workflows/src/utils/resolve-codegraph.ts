/**
 * Resolve the effective `codegraph` flag for a Claude node.
 *
 * Three-tier resolution mirrors how `provider` and `model` resolve in Archon:
 *   node.codegraph  ??  workflow.codegraph  ??  config.codegraph.enabled  ??  false
 *
 * Kept as a pure function so it can be unit-tested without setup.
 */

/**
 * Minimal config shape required for resolution. Defined locally to avoid an
 * import cycle from @archon/workflows → @archon/core.
 */
export interface ResolveCodegraphConfig {
  codegraph?: { enabled?: boolean };
}

/**
 * Resolve the effective codegraph flag using a 3-tier precedence chain.
 *
 * TODO(task-6): tighten `node` param to `Pick<DagNode, 'codegraph'>` and
 * `workflow` param to `Pick<WorkflowDefinition, 'codegraph'>` once Task 6
 * adds the `codegraph` field to DagNode. WorkflowDefinition.codegraph
 * already exists (Task 5 landed).
 */
export function resolveCodegraph(
  node: { codegraph?: boolean },
  workflow: { codegraph?: boolean },
  config: ResolveCodegraphConfig
): boolean {
  return node.codegraph ?? workflow.codegraph ?? config.codegraph?.enabled ?? false;
}
