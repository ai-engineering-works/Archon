/**
 * Detect the `codegraph` binary on PATH.
 *
 * Probes `codegraph --version`. Result is cached at module scope for the
 * lifetime of the process — one probe per Archon run, not per Claude node.
 *
 * Returns { found: false } on any failure (missing binary, non-zero exit,
 * unparseable version). Callers must handle the not-found case by skipping
 * codegraph integration with a one-time warn — they must NOT throw.
 */
import { execFileAsync } from '@archon/git';
import { createLogger } from '@archon/paths';

const log = createLogger('codegraph');

export type CodegraphDetection = { found: true; path: string; version: string } | { found: false };

let cache: CodegraphDetection | null = null;
let inflight: Promise<CodegraphDetection> | null = null;

export async function detectCodegraphBinary(): Promise<CodegraphDetection> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async (): Promise<CodegraphDetection> => {
    try {
      const { stdout } = await execFileAsync('codegraph', ['--version']);
      const raw = stdout.trim();
      // Accept "X.Y.Z" or "vX.Y.Z" at the start; treat anything else as "wrong shape"
      const match = /^v?(\d+\.\d+\.\d+)/.exec(raw);
      if (!match) {
        cache = { found: false };
      } else {
        cache = { found: true, path: 'codegraph', version: match[1] };
        log.info({ version: match[1] }, 'codegraph.binary_detected');
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        // Non-ENOENT means the binary exists but is unusable — log for diagnostics.
        log.debug({ err: e.message, code: e.code }, 'codegraph.binary_probe_failed');
      }
      cache = { found: false };
    }
    inflight = null;
    return cache;
  })();

  return inflight;
}

/** Test-only: reset the module-level cache. Production code MUST NOT call this. */
export function resetCodegraphDetectionForTests(): void {
  cache = null;
  inflight = null;
}
