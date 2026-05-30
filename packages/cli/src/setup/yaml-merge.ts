/**
 * Read-merge-write a YAML config file.
 *
 * - Creates the file (and any missing parent directories) when absent.
 * - Deep-merges plain objects; appends to arrays without introducing duplicates
 *   (string-compare via JSON.stringify for primitive items).
 * - Writes a `.bak.<ISO timestamp>` backup next to the file before overwriting.
 *
 * Uses Bun's native YAML parser. Bun does not ship a YAML emitter as of 1.3,
 * so we serialize via a minimal YAML writer that handles the shapes Archon
 * uses (top-level scalars, nested plain objects, arrays of primitives).
 * The contract: `Bun.YAML.parse(stringifyYaml(x))` equals the deep-merged value.
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
  patch: Record<string, Json>
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

  const header =
    '# Archon configuration\n# Managed by `archon setup` — edits preserved on merge.\n';
  await writeFile(filePath, header + stringifyYaml(merged), 'utf-8');
}

function stringifyYaml(value: Json, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (value === null) return 'null\n';
  if (typeof value === 'boolean' || typeof value === 'number') {
    return `${String(value)}\n`;
  }
  if (typeof value === 'string') return `${quoteIfNeeded(value)}\n`;

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n';
    let out = '\n';
    for (const item of value) {
      if (isObject(item) || Array.isArray(item)) {
        out += `${pad}- ${stringifyYaml(item, indent + 1).trimStart()}`;
      } else {
        out += `${pad}- ${quoteIfNeeded(item)}\n`;
      }
    }
    return out;
  }

  if (isObject(value)) {
    if (Object.keys(value).length === 0) return '{}\n';
    let out = indent === 0 ? '' : '\n';
    for (const [k, v] of Object.entries(value)) {
      if (isObject(v) || Array.isArray(v)) {
        out += `${pad}${k}:${stringifyYaml(v, indent + 1)}`;
      } else {
        out += `${pad}${k}: ${quoteIfNeeded(v)}\n`;
      }
    }
    return out;
  }

  return '';
}

function quoteIfNeeded(v: string | number | boolean | null): string {
  if (typeof v !== 'string') return String(v);
  // Safe-character subset → no quotes needed
  if (/^[A-Za-z0-9_\-./]+$/.test(v)) return v;
  return JSON.stringify(v);
}
