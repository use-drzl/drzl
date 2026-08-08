/**
 * drizzle-kit interop: read the schema path from `drizzle.config.ts`, so a drizzle-kit user
 * does not have to state it a second time in `drzl.config.ts`.
 *
 * Everything here mirrors drizzle-kit's measured behavior, read from the published dist of
 * drizzle-kit 0.31.10 rather than from its docs or from memory:
 *
 *   - `Config.schema` is `string | string[]` and entries may be glob patterns (`index.d.mts`).
 *   - The CLI's default config candidates are `drizzle.config.ts`, then `.js`, then `.json`,
 *     in that order and nothing else (`drizzleConfigFromFile` in `bin.cjs`); a custom path can
 *     be anything its `--config` flag can name, which `drizzleKit: '<path>'` mirrors.
 *   - `prepareFilenames` (bin.cjs) expands each entry with glob.sync, expands a directory
 *     match one level with readdir rather than recursively, unions the results, and hard-errors
 *     when nothing matched. It also computes the list of code extensions (.ts .js .cjs .mjs
 *     .mts .cts) into a variable it never reads, and then requires every match; DRZL applies
 *     that filter for real, which is strictly friendlier than crashing on a README.md sitting
 *     in the schema directory.
 *   - `defineConfig` is the identity function (`index.mjs`), so evaluating the config module
 *     yields the plain object and no drizzle-kit installation is needed to read it.
 *
 * Globs are expanded with `node:fs.globSync`, present since Node 22.0 and quiet on the CLI's
 * `engines` floor (measured: `*`, `**`, `{a,b}` and literal paths all behave; no
 * ExperimentalWarning on stderr on 22.22). No new dependency, and the config itself is loaded
 * through the same jiti path as `drzl.config.ts` (`importFreshConfigModule`), so the two
 * config files cannot drift onto different loaders.
 */
import type { Dialect } from '@drzl/analyzer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { importFreshConfigModule } from './config.js';

/** The default candidates drizzle-kit's own CLI tries, in its order. `.mjs`/`.cjs` are not
 * candidates because they are not drizzle-kit's; a project using one names it explicitly via
 * `drizzleKit: './drizzle.config.mjs'`, exactly as it must pass `--config` to kit itself. */
export const DRIZZLE_KIT_CONFIG_CANDIDATES = [
  'drizzle.config.ts',
  'drizzle.config.js',
  'drizzle.config.json',
] as const;

/** The extensions drizzle-kit's `prepareFilenames` names as schema code. */
const CODE_EXTENSIONS = new Set(['.ts', '.js', '.cjs', '.mjs', '.mts', '.cts']);

export interface DrizzleKitConfig {
  /** Absolute path of the file this came from. */
  path: string;
  schema?: string | string[];
  dialect?: string;
  casing?: string;
}

/**
 * Where the schema will be read from, decided once and handed to both `generate` and `watch`,
 * so the two commands cannot resolve differently.
 */
export interface ResolvedSchemaSource {
  source: 'drzl' | 'drizzle-kit';
  /**
   * What `SchemaAnalyzer` is constructed with: the drzl config's `schema` string verbatim, or
   * the expanded, sorted, absolute file list from the drizzle-kit config.
   */
  schema: string | string[];
  /**
   * Absolute directories that must be watched for schema edits. For a glob this is its static
   * base, so a file created later that matches the pattern still raises an event; a missing
   * entry here is the infinite-blindness half of the watch-loop rules.
   */
  watchDirs: string[];
  /** Absolute path of the drizzle-kit config consulted, when source is 'drizzle-kit'. */
  drizzleKitConfigPath?: string;
  /** The dialect that config declares, verbatim, for the post-analysis cross-check. */
  drizzleKitDialect?: string;
  warnings: string[];
}

/** The first existing default candidate, in drizzle-kit's own order, or null. */
export function findDrizzleKitConfig(cwd: string): string | null {
  for (const name of DRIZZLE_KIT_CONFIG_CANDIDATES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Load and narrow a drizzle-kit config file. Throws with the file named on anything wrong. */
export async function loadDrizzleKitConfig(p: string): Promise<DrizzleKitConfig> {
  let raw: unknown;
  try {
    raw = await importFreshConfigModule(p);
  } catch (e) {
    throw new Error(
      `drzl config: failed to load the drizzle-kit config at ${p}: ${(e as any)?.message ?? e}`
    );
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error(`drzl config: ${p} did not export a drizzle-kit config object.`);
  }
  const record = raw as Record<string, unknown>;
  const schema = record.schema;
  if (
    schema !== undefined &&
    typeof schema !== 'string' &&
    !(Array.isArray(schema) && schema.every((s) => typeof s === 'string'))
  ) {
    throw new Error(
      `drzl config: "schema" in ${p} must be a string or an array of strings, matching ` +
        `drizzle-kit's own Config type.`
    );
  }
  return {
    path: p,
    schema: schema as string | string[] | undefined,
    dialect: typeof record.dialect === 'string' ? record.dialect : undefined,
    casing: typeof record.casing === 'string' ? record.casing : undefined,
  };
}

/** Whether glob would treat any part of this entry as a pattern rather than a name. */
function hasGlobMagic(entry: string): boolean {
  return /[*?{}[\]]/.test(entry) || /[!@+]\(/.test(entry);
}

/**
 * The longest leading run of pattern-free path segments, as an absolute directory: what a
 * watcher can actually watch on behalf of a glob.
 */
function staticGlobBase(entry: string, cwd: string): string {
  const segments = entry.split('/');
  const kept: string[] = [];
  for (const s of segments) {
    if (hasGlobMagic(s)) break;
    kept.push(s);
  }
  // The last static segment before the magic may itself be a filename prefix; treating it as a
  // directory is still right, because resolve of `src/db` under a pattern `src/db/*.ts` IS the
  // directory. An entirely magic entry watches the cwd.
  const joined = kept.join('/');
  const base = path.resolve(cwd, joined || '.');
  // `src/*.ts` keeps `src`; `schema-*.ts` keeps nothing and must not watch a file named after
  // the prefix, so anything that is not an existing directory falls back to its dirname.
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) return base;
  return path.dirname(base);
}

/** One level of a directory, files only: exactly what kit's `prepareFilenames` does. */
function filesOneLevel(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.lstatSync(full).isDirectory()) out.push(full);
  }
  return out;
}

/**
 * Expand drizzle-kit `schema` entries into concrete files plus the directories a watcher
 * needs. Deterministic: the file list is deduplicated and sorted, so everything downstream
 * (first-wins export merging in the analyzer above all) is stable across runs.
 */
export function expandSchemaPaths(
  entries: string | string[],
  cwd: string
): { files: string[]; watchDirs: string[] } {
  const list = typeof entries === 'string' ? [entries] : entries;
  const files = new Set<string>();
  const watchDirs = new Set<string>();

  for (const entry of list) {
    if (hasGlobMagic(entry)) {
      watchDirs.add(staticGlobBase(entry, cwd));
      for (const match of fs.globSync(entry, { cwd })) {
        const full = path.resolve(cwd, match);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
          for (const f of filesOneLevel(full)) files.add(f);
        } else {
          files.add(full);
        }
      }
      continue;
    }
    const full = path.resolve(cwd, entry);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(full);
    } catch {
      // A missing literal entry contributes nothing, exactly as glob.sync returns [] for it in
      // kit; the caller's "matched no schema files" check is what reports an all-typo config.
      // Its directory is still watched, so creating the file later wakes the watcher.
      watchDirs.add(path.dirname(full));
      continue;
    }
    if (stat.isDirectory()) {
      watchDirs.add(full);
      for (const f of filesOneLevel(full)) files.add(f);
    } else {
      watchDirs.add(path.dirname(full));
      files.add(full);
    }
  }

  const kept = [...files].filter((f) => CODE_EXTENSIONS.has(path.extname(f).toLowerCase()));
  return { files: kept.sort(), watchDirs: [...watchDirs] };
}

/**
 * drizzle-kit's dialect vocabulary mapped onto the analyzer's, `null` when there is no
 * confident mapping (in which case the cross-check stays quiet rather than guessing).
 * `turso` is libsql, which is SQLite on the wire, which is what the analyzer detects.
 */
export function mapDrizzleKitDialect(declared: string | undefined): Dialect | null {
  if (!declared) return null;
  const map: Record<string, Dialect> = {
    postgresql: 'postgres',
    mysql: 'mysql',
    sqlite: 'sqlite',
    turso: 'sqlite',
    singlestore: 'singlestore',
    gel: 'gel',
  };
  if (declared in map) return map[declared];
  // A future kit dialect that already speaks the analyzer's name (say, 'cockroach') maps to
  // itself rather than silently losing the cross-check.
  const analyzerDialects: readonly Dialect[] = [
    'sqlite',
    'postgres',
    'mysql',
    'singlestore',
    'mssql',
    'cockroach',
    'gel',
  ];
  return (analyzerDialects as readonly string[]).includes(declared) ? (declared as Dialect) : null;
}

/**
 * The warning for a drizzle-kit config whose `dialect` contradicts what the analyzer measured,
 * or null when there is nothing to say: agreement, an unmappable declaration, or an analysis
 * that could not identify a dialect at all (which already warned as DRZL_ANL_DIALECT).
 */
export function dialectMismatchWarning(args: {
  configPath: string;
  declared: string | undefined;
  analyzed: Dialect;
}): string | null {
  const expected = mapDrizzleKitDialect(args.declared);
  if (!expected) return null;
  if (args.analyzed === 'unknown') return null;
  if (args.analyzed === expected) return null;
  return (
    `drzl: ${args.configPath} declares dialect "${args.declared}", but the schema analyzed ` +
    `as "${args.analyzed}". DRZL follows the schema; if the schema files are the right ones, ` +
    `the dialect in that config is stale.`
  );
}

/**
 * Decide where the schema comes from. Precedence, in order:
 *
 *   1. `schema` in the drzl config wins outright. If `drizzleKit` is also set to something
 *      that would read a file, that is two sources for one fact, so it warns and reads only
 *      `schema`; this config parser has shipped silently-dead keys twice before.
 *   2. Otherwise `drizzleKit` decides: `false` refuses the fallback, a string names the file,
 *      and `true` or unset searches drizzle-kit's own default candidates. Unset behaving like
 *      `true` is deliberate: `schema` was required until this feature existed, so no
 *      pre-existing config can reach the fallback, and the CLI announces the file it read.
 *   3. Neither yielding a schema is an error that names both files and what to do.
 */
export async function resolveSchemaSource(
  cfg: { schema?: string; drizzleKit?: boolean | string },
  cwd = process.cwd()
): Promise<ResolvedSchemaSource> {
  if (cfg.schema) {
    const warnings: string[] = [];
    if (cfg.drizzleKit === true || typeof cfg.drizzleKit === 'string') {
      warnings.push(
        `drzl config: both "schema" and "drizzleKit" are set. "schema" wins, so the ` +
          `drizzle-kit config was not read; remove one of the two to silence this.`
      );
    }
    return {
      source: 'drzl',
      schema: cfg.schema,
      watchDirs: [path.dirname(path.resolve(cwd, cfg.schema))],
      warnings,
    };
  }

  if (cfg.drizzleKit === false) {
    throw new Error(
      `drzl config: no "schema" is set and "drizzleKit" is false, so the drizzle-kit fallback ` +
        `is disabled. Set "schema".`
    );
  }

  let configPath: string;
  if (typeof cfg.drizzleKit === 'string') {
    configPath = path.resolve(cwd, cfg.drizzleKit);
    if (!fs.existsSync(configPath)) {
      throw new Error(`drzl config: "drizzleKit" points at ${configPath}, which does not exist.`);
    }
  } else {
    const found = findDrizzleKitConfig(cwd);
    if (!found) {
      const looked = DRIZZLE_KIT_CONFIG_CANDIDATES.join(', ');
      throw new Error(
        cfg.drizzleKit === true
          ? `drzl config: "drizzleKit" is set, but no drizzle-kit config was found (looked ` +
              `for ${looked} in ${cwd}). Create one, or point "drizzleKit" at its path.`
          : `drzl config: no "schema" is set and no drizzle-kit config was found (looked for ` +
              `${looked} in ${cwd}). Set "schema" in your drzl config, or add "drizzleKit" ` +
              `naming your drizzle-kit config file.`
      );
    }
    configPath = found;
  }

  const kit = await loadDrizzleKitConfig(configPath);
  if (kit.schema === undefined) {
    throw new Error(
      `drzl config: ${configPath} has no "schema" entry, so there is nothing to analyze. Set ` +
        `"schema" there, or set "schema" in your drzl config.`
    );
  }
  const { files, watchDirs } = expandSchemaPaths(kit.schema, cwd);
  if (!files.length) {
    const shown = (typeof kit.schema === 'string' ? [kit.schema] : kit.schema)
      .map((s) => JSON.stringify(s))
      .join(', ');
    throw new Error(
      `drzl config: the "schema" patterns in ${configPath} matched no schema files: ${shown}. ` +
        `DRZL expands them the way drizzle-kit does; check them against your tree.`
    );
  }
  return {
    source: 'drizzle-kit',
    schema: files,
    watchDirs,
    drizzleKitConfigPath: configPath,
    drizzleKitDialect: kit.dialect,
    warnings: [],
  };
}
