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
 * TODO(task-5-6): tighten parameter types to `Pick<DagNode, 'codegraph'>` and
 * `Pick<WorkflowDefinition, 'codegraph'>` once Tasks 5 and 6 add the `codegraph`
 * field to those schemas.
 *
 * Parameters use the minimal `{ codegraph?: boolean }` shape rather than
 * `Pick<DagNode, 'codegraph'>` / `Pick<WorkflowDefinition, 'codegraph'>`
 * because those schemas do not yet have a codegraph field — that lands in
 * Tasks 5 and 6. Once those fields are added the param types can be tightened.
 */
export function resolveCodegraph(
  node: { codegraph?: boolean },
  workflow: { codegraph?: boolean },
  config: ResolveCodegraphConfig
): boolean {
  return node.codegraph ?? workflow.codegraph ?? config.codegraph?.enabled ?? false;
}
