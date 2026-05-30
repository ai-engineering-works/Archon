/**
 * Codegraph MCP extension for ClaudeProvider.
 *
 * Lives in @archon/core (not @archon/providers/claude) because it depends on
 * detection helpers in this package — and @archon/providers must not depend on
 * @archon/core per the package layering invariant in CLAUDE.md.
 *
 * Self-registers via @archon/providers/claude's extension registry at module
 * load. @archon/core/src/index.ts performs a side-effect import to trigger
 * registration on first import of the core package.
 *
 * The function is also exported by name so tests can register it manually
 * via `registerClaudeMcpExtension(codegraphMcpExtension)` after calling
 * `resetClaudeMcpExtensionsForTests()`.
 */
import {
  registerClaudeMcpExtension,
  type ClaudeMcpCtx,
  type ClaudeMcpEntry,
} from '@archon/providers/claude/mcp-extensions';
import { getCachedCodegraphDetection } from './codegraph-detect';
import { createLogger } from '@archon/paths';

const log = createLogger('codegraph');

// One-shot warning state — log the missing binary at most once per process.
let warnedMissing = false;

/**
 * Resolve the effective codegraph flag for this query.
 *
 * Three-tier chain mirrors @archon/workflows/utils/resolve-codegraph. Inlined
 * rather than imported to avoid a @archon/core → @archon/workflows dependency
 * for three lines of logic.
 */
function resolveEffective(ctx: ClaudeMcpCtx): boolean {
  return ctx.node.codegraph ?? ctx.workflow.codegraph ?? ctx.config.codegraph?.enabled ?? false;
}

/**
 * Codegraph extension function. Returns a single `{ codegraph: {...} }` entry
 * when the effective flag is on AND the binary is detected; otherwise `null`.
 *
 * Reads detection from the module-level cache populated by `bootstrapCodegraphIndex`
 * or the first call to `detectCodegraphBinary()`. If the cache is empty here, we
 * conservatively return `null` (the registry treats null as "this extension
 * does not apply") and log a one-time warning. The next codebase register or
 * explicit detection call will populate the cache.
 */
export const codegraphMcpExtension = (ctx: ClaudeMcpCtx): Record<string, ClaudeMcpEntry> | null => {
  if (!resolveEffective(ctx)) return null;

  const detection = getCachedCodegraphDetection();
  if (!detection?.found) {
    if (!warnedMissing) {
      warnedMissing = true;
      log.warn({ phase: 'claude_node' }, 'codegraph.binary_missing');
    }
    return null;
  }

  const debounce = String(ctx.config.codegraph?.watchDebounceMs ?? 2000);

  log.info({ nodeId: ctx.node.id, cwd: ctx.cwd }, 'codegraph.mcp_attached');

  return {
    codegraph: {
      type: 'stdio',
      command: detection.path,
      args: ['serve', '--mcp'],
      cwd: ctx.cwd,
      env: { CODEGRAPH_WATCH_DEBOUNCE_MS: debounce },
    },
  };
};

// Self-register on module load. Production code triggers this via the
// side-effect import in @archon/core/src/index.ts. Tests call
// `resetClaudeMcpExtensionsForTests()` and then re-register manually if they
// want a clean slate.
registerClaudeMcpExtension(codegraphMcpExtension);
