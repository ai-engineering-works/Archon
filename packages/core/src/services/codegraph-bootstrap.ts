/**
 * Run `codegraph init -i` against a codebase source directory.
 *
 * Failure is never thrown — the caller (codebase registration) must not
 * be blocked by codegraph problems. Always returns a discriminated union.
 *
 * Timeout: 10 minutes. Big repos can legitimately take a while to index.
 */
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';
import { detectCodegraphBinary } from './codegraph-detect';

const log = createLogger('codegraph');

const INDEX_TIMEOUT_MS = 10 * 60 * 1000;

export type BootstrapResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: 'binary_missing' | 'index_failed' | 'index_timeout'; detail?: string };

export async function bootstrapCodegraphIndex(sourcePath: string): Promise<BootstrapResult> {
  const detection = await detectCodegraphBinary();
  if (!detection.found) {
    log.warn({ phase: 'bootstrap' }, 'codegraph.binary_missing');
    return { ok: false, reason: 'binary_missing' };
  }

  log.info({ sourcePath }, 'codegraph.index_started');
  const startedAt = Date.now();

  try {
    await execFileAsync(detection.path, ['init', '-i'], {
      cwd: sourcePath,
      timeout: INDEX_TIMEOUT_MS,
    });
    const durationMs = Date.now() - startedAt;
    log.info({ sourcePath, durationMs }, 'codegraph.index_completed');
    return { ok: true, durationMs };
  } catch (err) {
    const errorObj = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    const durationMs = Date.now() - startedAt;

    // Real timeouts fire near INDEX_TIMEOUT_MS. External SIGTERM (parent
    // shutdown, pkill) produces the same `killed: true` flag with arbitrary
    // elapsed time — so we use elapsed-time proximity to disambiguate.
    // Allow 500ms slack for SIGTERM delivery jitter.
    const looksLikeTimeout = errorObj.killed === true && durationMs >= INDEX_TIMEOUT_MS - 500;

    if (looksLikeTimeout) {
      log.error({ sourcePath, durationMs }, 'codegraph.index_timeout');
      return { ok: false, reason: 'index_timeout' };
    }

    log.error(
      { sourcePath, durationMs, stderr: errorObj.stderr, err: errorObj.message },
      'codegraph.index_failed'
    );
    return { ok: false, reason: 'index_failed', detail: errorObj.stderr ?? errorObj.message };
  }
}
