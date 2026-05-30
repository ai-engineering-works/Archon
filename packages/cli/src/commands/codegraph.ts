/**
 * `archon codegraph index|sync|status [<codebase>]`
 *
 * Thin wrappers around the `codegraph` binary. Scoped to a codebase source
 * path; defaults to the current process directory when no codebase argument
 * is provided.
 *
 * The binary is invoked directly via `execFileAsync`. If the binary is not
 * on PATH, we print an install hint and exit 1.
 */
import { execFileAsync } from '@archon/git';

export interface CodegraphCommandOptions {
  args: string[];
  log: (msg: string) => void;
  exit: (code: number) => never;
  cwd?: string;
}

const USAGE = `Usage:
  archon codegraph index [<codebase>]   - build the index (codegraph init -i)
  archon codegraph sync  [<codebase>]   - incremental sync (codegraph sync)
  archon codegraph status [<codebase>]  - show index health (codegraph status)
`;

const INSTALL_HINT =
  '`codegraph` binary not found on PATH. Install via: ' +
  'curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh';

export async function runCodegraphCommand(opts: CodegraphCommandOptions): Promise<void> {
  const sub = opts.args[0];
  if (!sub) {
    opts.log(USAGE);
    opts.exit(1);
    return;
  }

  const codebase = opts.args[1]; // optional positional
  const targetCwd = codebase ?? opts.cwd ?? process.cwd();

  const cgArgs = ((): string[] | null => {
    switch (sub) {
      case 'index':
        return ['init', '-i'];
      case 'sync':
        return ['sync'];
      case 'status':
        return ['status'];
      default:
        return null;
    }
  })();

  if (!cgArgs) {
    opts.log(`Unknown subcommand: ${sub}\n\n${USAGE}`);
    opts.exit(1);
    return;
  }

  try {
    const { stdout } = await execFileAsync('codegraph', cgArgs, { cwd: targetCwd });
    const trimmed = stdout.trim();
    if (trimmed) opts.log(trimmed);
  } catch (err) {
    const errorObj = err as NodeJS.ErrnoException & { stderr?: string };
    if (errorObj.code === 'ENOENT') {
      opts.log(INSTALL_HINT);
      opts.exit(1);
      return;
    }
    opts.log(`codegraph ${sub} failed: ${errorObj.message}\n${errorObj.stderr ?? ''}`);
    opts.exit(1);
  }
}
