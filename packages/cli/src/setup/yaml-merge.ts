/**
 * Read-merge-write a YAML config file.
 *
 * - Creates the file (and any missing parent directories) when absent.
 * - Deep-merges plain objects; appends to arrays without introducing duplicates
 *   (string-compare via JSON.stringify for primitive items).
 * - Writes a `.bak.<ISO timestamp>` backup next to the file before overwriting.
 *
 * Uses Bun's native YAML parser and emitter (`Bun.YAML.parse` /
 * `Bun.YAML.stringify`, available in Bun 1.3+). The contract:
 * `Bun.YAML.parse(Bun.YAML.stringify(x))` equals the deep-merged value
 * for the shapes Archon uses.
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(target: Json, source: Json): Json {
  if (isObject(target) && isObject(source)) {
    const out: Record<string, Json> = { ...target };
    for (const [k, v] of Object.entries(source)) {
      const current = out[k];
      if (current === undefined) {
        out[k] = v;
      } else {
        out[k] = deepMerge(current, v);
      }
    }
    return out;
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    const out = [...target];
    for (const item of source) {
      const exists = out.some(existing => JSON.stringify(existing) === JSON.stringify(item));
      if (!exists) out.push(item);
    }
    return out;
  }
  // For all other type-mismatch cases, source wins. This is conservative —
  // a user who has a string where the patch wants an object accepts the
  // patch shape (which is the wizard's intent).
  return source;
}

export async function mergeYamlConfig(
  filePath: string,
  patch: Record<string, Json>,
  header = '# Archon configuration\n# Managed by `archon setup` — edits preserved on merge.\n'
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  let existing: Record<string, Json> = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = Bun.YAML.parse(raw);
    if (isObject(parsed)) existing = parsed;

    // File existed and parsed — write a backup before we overwrite.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(filePath, `${filePath}.bak.${ts}`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
    // First-create case — no backup needed.
  }

  const merged = deepMerge(existing as Json, patch as Json) as Record<string, Json>;

  await writeFile(filePath, header + Bun.YAML.stringify(merged), 'utf-8');
}
