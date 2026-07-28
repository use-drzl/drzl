/**
 * One place that decides what a generated module is called, on disk and in an import.
 *
 * The three validation generators used to name the file from `fileSuffix` but hardcode the
 * default suffix in the barrel, so any custom `fileSuffix` produced `export * from
 * './users.zod'` next to a file called `users.schema.ts` and the consumer's build failed on
 * an unresolved import. Both halves are derived here from the same value now.
 */

/**
 * A TypeScript source extension paired with what an import specifier has to spell to reach
 * it. Verified against tsc with `moduleResolution` set to `bundler`, `node10` and `node16`:
 *
 *  - an extensionless specifier reaches `.ts` and `.tsx` under `bundler` and `node10`, and
 *    reaches nothing at all under `node16`, which is what the barrel has always emitted
 *  - an extensionless specifier never reaches `.mts` or `.cts` under any of the three, while
 *    `.mjs` and `.cjs` reach them under all three
 *
 * So `.mts` and `.cts` take their output extension and everything else goes extensionless.
 * Order does not matter here because no entry is a suffix of another.
 */
const TS_EXTENSIONS: readonly (readonly [ext: string, specifierExt: string])[] = [
  ['.mts', '.mjs'],
  ['.cts', '.cjs'],
  ['.tsx', ''],
  ['.ts', ''],
];

/** Name of the file a table is written to, e.g. `users.zod.ts`. */
export function moduleFileName(tsName: string, fileSuffix: string): string {
  return `${tsName}${fileSuffix}`;
}

/**
 * Relative specifier a sibling module needs to import that file, e.g. `./users.zod`.
 *
 * A `fileSuffix` that ends in no TypeScript extension is left whole: such a file cannot be
 * imported at all, and naming a neighbour that does not exist would only hide that.
 */
export function moduleSpecifier(tsName: string, fileSuffix: string): string {
  const file = moduleFileName(tsName, fileSuffix);
  for (const [ext, specifierExt] of TS_EXTENSIONS) {
    if (file.endsWith(ext)) return `./${file.slice(0, -ext.length)}${specifierExt}`;
  }
  return `./${file}`;
}
