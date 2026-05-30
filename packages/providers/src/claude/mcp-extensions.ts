/**
 * Claude MCP extension registry.
 *
 * The ClaudeProvider calls `collectClaudeMcpExtensions(ctx)` once per
 * `sendQuery()` to merge any registered extensions' MCP server entries
 * into the Claude SDK `mcpServers` map.
 *
 * New MCP integrations (codegraph and anything else) register themselves
 * here at module load. The provider source never needs another edit.
 */

/**
 * Context passed to each extension function on every `sendQuery()` invocation.
 *
 * `workflow` and `node` use inline structural types rather than `Pick<WorkflowDefinition, ...>`
 * / `Pick<DagNode, ...>` to keep this package from depending on @archon/workflows.
 * TypeScript's structural typing means real WorkflowDefinition / DagNode values still
 * pass through cleanly. See packages/workflows/src/utils/resolve-codegraph.ts for the
 * same pattern.
 *
 * `config` uses a narrow shape (just the codegraph slice) to avoid an import
 * cycle from @archon/providers → @archon/core. Extensions that need other
 * config fields can widen this interface as they're added — keep it minimal.
 */
export interface ClaudeMcpCtx {
  workflow: { codegraph?: boolean };
  node: { codegraph?: boolean; id: string };
  config: { codegraph?: { enabled?: boolean; watchDebounceMs?: number } };
  cwd: string;
}

/**
 * Shape of a Claude SDK stdio MCP server entry. Intentionally narrow — the
 * Claude SDK accepts a broader shape (HTTP/SSE), but stdio is what every
 * Archon-registered extension uses today.
 */
export interface ClaudeMcpEntry {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Extension function: receives the per-query context, returns a map of
 * MCP server entries to add (or `null` if this extension doesn't apply to
 * this context — e.g., flag is off, binary is missing).
 */
export type ClaudeMcpExtension = (ctx: ClaudeMcpCtx) => Record<string, ClaudeMcpEntry> | null;

const extensions: ClaudeMcpExtension[] = [];

/**
 * Register a new extension. Call this at module load (side-effect import) so
 * the extension is in place by the time the first `sendQuery()` runs.
 */
export function registerClaudeMcpExtension(fn: ClaudeMcpExtension): void {
  extensions.push(fn);
}

/**
 * Collect all registered extensions' entries for the given context. Returns
 * a fresh merged object; the caller is responsible for further merging with
 * any user-supplied `node.mcp` config.
 *
 * Later registrations overwrite earlier registrations on key collision
 * (shallow merge via `Object.assign`).
 *
 * If an extension function throws, the error propagates immediately to the
 * caller — consistent with the Fail-Fast principle. Extensions are expected
 * to handle their own degradation (e.g., return null on missing dependencies).
 */
export function collectClaudeMcpExtensions(ctx: ClaudeMcpCtx): Record<string, ClaudeMcpEntry> {
  const merged: Record<string, ClaudeMcpEntry> = {};
  for (const fn of extensions) {
    const entries = fn(ctx);
    if (!entries) continue;
    Object.assign(merged, entries);
  }
  return merged;
}

/**
 * Test-only: empties the registry. Production code MUST NOT call this.
 */
export function resetClaudeMcpExtensionsForTests(): void {
  extensions.length = 0;
}
