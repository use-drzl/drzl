/**
 * One place that decides what a generated module is called, on disk and in an import.
 *
 * The three validation generators used to name the file from `fileSuffix` but hardcode the
 * default suffix in the barrel, so any custom `fileSuffix` produced `export * from
 * './users.zod'` next to a file called `users.schema.ts` and the consumer's build failed on
 * an unresolved import. Both halves are derived here from the same value now.
 */

import nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * How a relative import of a generated file spells its extension.
 *
 * Generated files land in the consumer's own source tree, so the consumer's
 * `moduleResolution` decides which forms resolve. Measured against tsc 5.9.2 and 7.0.2, for
 * a specifier pointing at a sibling `.ts` file:
 *
 * | form            | bundler | node10 | node16 / nodenext (CJS) | node16 / nodenext (ESM) |
 * | --------------- | ------- | ------ | ----------------------- | ----------------------- |
 * | `'js'`          | yes     | yes    | yes                     | yes                     |
 * | `'none'`        | yes     | yes    | yes                     | **no**                  |
 * | `'ts'`          | flag    | flag   | flag                    | flag                    |
 *
 * `'js'` is the default because it is the only form that needs no compiler flag and still
 * resolves in every cell. `'none'` is what drzl emitted before 2.0 and is what a pipeline
 * that cannot map `.js` back to `.ts` wants (webpack without `resolve.extensionAlias`,
 * ts-jest without a `moduleNameMapper`). `'ts'` needs `allowImportingTsExtensions`, and is
 * the only form Node's own type stripping accepts, so it suits a project that runs the
 * generated `.ts` unbuilt.
 */
export type ImportExtension = (typeof IMPORT_EXTENSIONS)[number];

/**
 * Every value `ImportExtension` accepts, in the order documentation lists them. The type is
 * derived from this tuple rather than declared alongside it, so a config schema built from
 * it accepts exactly what the type allows and the two cannot drift.
 */
export const IMPORT_EXTENSIONS = ['js', 'none', 'ts'] as const;

/** What `importExtension` means when nothing sets it. */
export const DEFAULT_IMPORT_EXTENSION: ImportExtension = 'js';

/**
 * A TypeScript source extension paired with what an import specifier has to spell to reach
 * it, per `ImportExtension`. Verified against tsc with `moduleResolution` set to `bundler`,
 * `node10`, `node16` and `nodenext`:
 *
 *  - an extensionless specifier reaches `.ts` and `.tsx` under `bundler` and `node10`, and
 *    under `node16`/`nodenext` only while the importing file is CommonJS. In an ES module it
 *    reaches nothing, which is what `tsc --init` has produced by default since TypeScript
 *    5.9 and what every `@tsconfig/node*` base selects
 *  - an extensionless specifier never reaches `.mts` or `.cts` under any of the four, so
 *    those take their output extension even under `'none'`
 *  - a `.js`/`.mjs`/`.cjs` specifier reaches `.ts`/`.tsx`, `.mts` and `.cts` under all four,
 *    in both module systems, with no compiler flag
 *  - a `.ts`/`.tsx`/`.mts`/`.cts` specifier reaches its own file under all four, but only
 *    with `allowImportingTsExtensions` set
 *
 * Order does not matter here because no entry is a suffix of another.
 */
const TS_EXTENSIONS: readonly {
  readonly ext: string;
  readonly js: string;
  readonly none: string;
}[] = [
  { ext: '.mts', js: '.mjs', none: '.mjs' },
  { ext: '.cts', js: '.cjs', none: '.cjs' },
  { ext: '.tsx', js: '.js', none: '' },
  { ext: '.ts', js: '.js', none: '' },
];

/** Name of the file a table is written to, e.g. `users.zod.ts`. */
export function moduleFileName(tsName: string, fileSuffix: string): string {
  return `${tsName}${fileSuffix}`;
}

/**
 * Rewrite the extension of a relative path naming a generated file into the form an import
 * specifier has to spell, e.g. `./users.zod.ts` -> `./users.zod.js`.
 *
 * A path that ends in no TypeScript extension is left whole: such a file cannot be imported
 * at all, and naming a neighbour that does not exist would only hide that.
 */
export function importSpecifier(
  relativePath: string,
  importExtension: ImportExtension = DEFAULT_IMPORT_EXTENSION
): string {
  for (const { ext, js, none } of TS_EXTENSIONS) {
    if (!relativePath.endsWith(ext)) continue;
    const stem = relativePath.slice(0, -ext.length);
    if (importExtension === 'ts') return relativePath;
    return `${stem}${importExtension === 'none' ? none : js}`;
  }
  return relativePath;
}

/**
 * Relative specifier a sibling module needs to import a table's file, e.g.
 * `./users.zod.js`.
 */
export function moduleSpecifier(
  tsName: string,
  fileSuffix: string,
  importExtension: ImportExtension = DEFAULT_IMPORT_EXTENSION
): string {
  return importSpecifier(`./${moduleFileName(tsName, fileSuffix)}`, importExtension);
}

/**
 * Turn a configured module path into a specifier the generated file can actually import.
 *
 * Options like `validation.importPath`, `dbImportPath` and `schemaImportPath` get written as
 * project-relative paths, `src/validators/zod`, because that is how the rest of the config
 * names directories. Emitted verbatim that is a *bare* specifier: Node and tsc look for a
 * package of that name in node_modules and never consider the local file. The config in the
 * getting-started guide produced three such imports, none of which resolved.
 *
 * Two questions have to be answered, and neither can be guessed from the string alone.
 *
 * **Package or path?** `zod` and `@acme/schemas` are package names and pass through untouched.
 * A path containing a separator, or starting with `.`, is a path.
 *
 * **File or directory?** `src/db/connection` is usually a file and `src/validators/zod` a
 * directory holding a barrel, and they look identical. So the filesystem is asked. Where the
 * target does not exist yet, which happens when this generator runs before the one that writes
 * it, an extensionless path is taken to be a directory, since these options name directories by
 * convention and the one path that can be missing is a generated barrel.
 *
 * A path already relative keeps its own spelling and only has its extension corrected, so
 * anyone who followed the older guidance and wrote `../validators/zod/index.js` is unaffected.
 *
 * @param configured  what the user put in the config
 * @param outDirAbs   absolute directory the importing file is written to
 * @param cwd         project root a non-relative path is resolved against
 */
export function resolveConfiguredImport(
  configured: string,
  outDirAbs: string,
  cwd: string,
  importExtension: ImportExtension = DEFAULT_IMPORT_EXTENSION
): string {
  if (isPackageSpecifier(configured)) return configured;

  const targetAbs = nodePath.isAbsolute(configured)
    ? configured
    : nodePath.resolve(configured.startsWith('.') ? outDirAbs : cwd, configured);

  const withIndex = pointsAtDirectory(targetAbs) ? `${configured}/index` : configured;

  // A path the user already wrote relative keeps its own spelling; only the extension moves.
  if (configured.startsWith('.')) {
    return importSpecifier(withTsExtension(withIndex), importExtension);
  }

  const resolved = pointsAtDirectory(targetAbs) ? nodePath.join(targetAbs, 'index') : targetAbs;
  const rel = nodePath.relative(outDirAbs, resolved).split(nodePath.sep).join('/');
  const prefixed = !rel ? '.' : rel.startsWith('.') ? rel : `./${rel}`;
  return importSpecifier(withTsExtension(prefixed), importExtension);
}

/** `zod`, `@acme/schemas`, `node:path`: resolved from node_modules, not from disk. */
function isPackageSpecifier(p: string): boolean {
  if (p.startsWith('.') || nodePath.isAbsolute(p)) return false;
  if (p.startsWith('@') || p.includes(':')) return true;
  return !p.includes('/');
}

/**
 * Directories get `/index` appended. Asked of the filesystem, because `src/db/connection` and
 * `src/validators/zod` are indistinguishable as strings and are usually a file and a directory
 * respectively. A path that does not exist yet is a barrel this run has not written, so an
 * extensionless one is treated as a directory.
 */
function pointsAtDirectory(absPath: string): boolean {
  try {
    return nodeFs.statSync(absPath).isDirectory();
  } catch {
    // Nothing at that exact path. `src/db/connection` names `connection.ts`, so look for the
    // module the author actually wrote before concluding it must be a directory.
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']) {
      if (nodeFs.existsSync(`${absPath}${ext}`)) return false;
    }
    // Genuinely absent: a barrel this run has not written yet. These options name directories
    // by convention, so an extensionless path is one.
    return !/\.[a-z]+$/i.test(nodePath.basename(absPath));
  }
}

/**
 * `importSpecifier` rewrites the extension of a TypeScript path, so give it one to rewrite. A
 * path already ending in a JavaScript extension is normalised first, so `index.js` is understood
 * as the module rather than treated as extensionless and turned into `index.js.js`.
 */
function withTsExtension(p: string): string {
  if (/\.(ts|tsx|mts|cts)$/.test(p)) return p;
  if (/\.(js|mjs|cjs)$/.test(p)) return p.replace(/\.(js|mjs|cjs)$/, '.ts');
  return `${p}.ts`;
}
