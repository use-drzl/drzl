/**
 * One place that decides what a generated module is called, on disk and in an import.
 *
 * The three validation generators used to name the file from `fileSuffix` but hardcode the
 * default suffix in the barrel, so any custom `fileSuffix` produced `export * from
 * './users.zod'` next to a file called `users.schema.ts` and the consumer's build failed on
 * an unresolved import. Both halves are derived here from the same value now.
 */

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
