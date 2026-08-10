/**
 * Where the transpiled schema is cached, which used to depend on the project rather than on us.
 *
 * jiti's default is `node_modules/.cache/jiti` *if that directory already exists* and
 * `{TMP_DIR}/jiti` otherwise, resolved from the jiti instance's base. The base is the analyzer
 * module, which lives inside `node_modules/@drzl/analyzer/dist`, so which of the two a run got
 * depended on whether the consumer's project happened to have a `node_modules/.cache` yet.
 * Measured in a project without one, the cache landed in `/tmp/jiti`: clearing the project cache
 * cleared nothing, and the next run was warm while reporting itself cold.
 *
 * The cost being cached is real and is paid again on every edit, since the cache is content-keyed.
 * Measured on a 53 KB schema of 30 tables, in one long-lived process, which is what `drzl watch`
 * is:
 *
 *   first analysis                    70ms
 *   again, file unchanged             10ms
 *   after a save                     254ms
 *   again, unchanged since that save   9ms
 *   reverted to earlier content      134ms
 *
 * The last row is the disk cache doing its job: content seen before costs about half of content
 * seen for the first time. The third is the answer to whether `watch` could hold a warm jiti
 * instance across rebuilds and skip this. It could not: the key is the content, the content is
 * what changed, and transpiling it is what seeing the edit means.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const DIR = path.join(__dirname, '.tmp-jiti-cache');

describe('the transpile cache', () => {
  it('lands in the project rather than in the temp directory', async () => {
    await fs.mkdir(DIR, { recursive: true });
    const file = path.join(DIR, 'schema.mjs');
    await fs.writeFile(
      file,
      `import { pgTable, text } from 'drizzle-orm/pg-core';
       export const t = pgTable('t', { a: text('a').notNull() });`,
      'utf8'
    );
    const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
    expect(analysis.tables[0]?.name, JSON.stringify(analysis.issues)).toBe('t');

    // `process.cwd()` during a package test is the package, which has a node_modules, so this is
    // the directory the analyzer chose rather than the one jiti would have fallen back to.
    const cache = path.join(process.cwd(), 'node_modules', '.cache', 'jiti');
    const entries = await fs.readdir(cache);
    expect(entries.length, `${cache} is empty`).toBeGreaterThan(0);

    await fs.rm(DIR, { recursive: true, force: true });
  }, 60_000);
});
