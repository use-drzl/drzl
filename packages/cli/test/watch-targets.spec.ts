/**
 * What `drzl watch` hands to chokidar.
 *
 * It handed it a glob: `<schema dir>/**\/*.{ts,tsx,js}`. Chokidar removed glob support in v4
 * (September 2024) and treats such a string as a literal path, so it watched a directory named
 * `**` that does not exist, no event ever fired, and `watch` did an initial build and then sat
 * there forever. The command has been inert since the v4 upgrade.
 *
 * Nothing caught it because `watch` had no test at all, and the initial build makes a manual
 * check look like it worked.
 *
 * Chokidar v4 watches a directory recursively on its own, so targets must be real paths.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { computeWatchTargets, CONFIG_FILE_NAMES } from '../src/config';

const cwd = path.resolve('/project');
const cfg = (over: Record<string, unknown> = {}) =>
  ({
    schema: 'src/db/schemas/index.ts',
    outDir: 'src/api',
    generators: [{ kind: 'zod', path: 'src/validators/zod' }],
    analyzer: {},
    ...over,
  }) as never;

describe('watch targets', () => {
  it('contains no globs, which chokidar v4 cannot expand', () => {
    for (const t of computeWatchTargets(cfg(), cwd)) {
      expect(t, `glob in watch target: ${t}`).not.toMatch(/[*?{}[\]]/);
    }
  });

  it('watches the directory holding the schema, which chokidar recurses into', () => {
    expect(computeWatchTargets(cfg(), cwd)).toContain(path.resolve(cwd, 'src/db/schemas'));
  });

  it('still watches every config filename', () => {
    // Iterated from the loader's own list rather than spelled out again. The list here was a
    // second copy of the four names in `computeWatchTargets`, and both copies were missing
    // `drzl.config.json`: a JSON config loads fine and then `drzl watch` never reloads it,
    // because nothing was watching the file. Two enumerations agreeing with each other is not
    // the same as either agreeing with the loader.
    const targets = computeWatchTargets(cfg(), cwd);
    for (const name of CONFIG_FILE_NAMES) {
      expect(targets, `not watching ${name}`).toContain(path.resolve(cwd, name));
    }
  });

  it('watches the schema directory even when the schema is a bare filename', () => {
    expect(computeWatchTargets(cfg({ schema: 'schema.ts' }), cwd)).toContain(path.resolve(cwd));
  });

  it('returns absolute paths', () => {
    for (const t of computeWatchTargets(cfg(), cwd)) {
      expect(path.isAbsolute(t), t).toBe(true);
    }
  });
});
