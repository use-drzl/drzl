/**
 * The pure halves of items 78 and 79: how a key path is written, what is shown of the value that
 * was found there, and which levels of the config schema an unknown key is dropped at.
 *
 * These are here rather than in the end-to-end spec because each of them has a case that costs a
 * whole spawned process to reach through a config file and is one line to state directly: a
 * non-finite number, a 400-character string, a union with two object branches. The end-to-end
 * spec pins the sentences a user reads; this one pins the rules that build them.
 */
import { describe, expect, it } from 'vitest';
import { buildConfigJsonSchema } from '../src/config';
import {
  CONFIG_INVALID_CODE,
  describeValue,
  editDistance,
  formatConfigProblems,
  nearestKey,
  renderConfigPath,
  unknownConfigKeys,
  unknownKeyWarnings,
} from '../src/config-errors';

const SHAPE = buildConfigJsonSchema();

describe('renderConfigPath', () => {
  it('writes an array entry the way a config file spells it', () => {
    expect(renderConfigPath(['generators', 1, 'validation', 'library'])).toBe(
      'generators[1].validation.library'
    );
  });

  it('brackets a key that is not an identifier', () => {
    // `columns` is keyed by table pattern, and `columns.app_*` reads as though `*` were part of
    // the path language rather than part of the key.
    expect(renderConfigPath(['columns', 'app_*', 'omit'])).toBe('columns["app_*"].omit');
  });

  it('names the root when there is no path at all', () => {
    expect(renderConfigPath([])).toBe('(root)');
  });
});

describe('describeValue', () => {
  it('states a non-finite number as itself', () => {
    // `JSON.stringify(NaN)` is the four characters `null`, and so is `JSON.stringify(Infinity)`.
    // Reporting `nestedDepth: NaN` as `null` would name a different mistake with a different fix.
    expect(describeValue(NaN)).toBe('NaN');
    expect(describeValue(Infinity)).toBe('Infinity');
    expect(describeValue(-Infinity)).toBe('-Infinity');
    expect(describeValue(0)).toBe('0');
  });

  it('quotes a string and truncates a long one', () => {
    expect(describeValue('zod')).toBe('"zod"');
    const long = 'x'.repeat(400);
    const shown = describeValue(long);
    expect(shown).toContain('(400 characters)');
    expect(shown!.length).toBeLessThan(120);
  });

  it('shows a small object and declines a large one', () => {
    expect(describeValue({ enabled: true })).toBe('{"enabled":true}');
    expect(
      describeValue({ kind: 'zod', path: 'src/validators/zod', typedJson: true, meta: true })
    ).toBe(null);
  });

  it('distinguishes the three empty things', () => {
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(null)).toBe('null');
    expect(describeValue('')).toBe('""');
  });
});

describe('nearestKey', () => {
  const known = ['outDir', 'include', 'exclude', 'columns', 'generators', 'schema'];

  it('suggests a one-edit typo', () => {
    expect(nearestKey('outDirr', known)).toBe('outDir');
    expect(nearestKey('column', known)).toBe('columns');
  });

  it('says nothing about a word that is not a typo of any of them', () => {
    expect(nearestKey('database', known)).toBeUndefined();
    expect(nearestKey('abc', ['kind', 'path'])).toBeUndefined();
  });

  it('holds a short key to one edit and a longer one to two', () => {
    // `pat` to `path` is one edit and suggested; `pa` to `path` is two, which on a two-character
    // key is a different word entirely.
    expect(nearestKey('pat', ['path'])).toBe('path');
    expect(nearestKey('pa', ['path'])).toBeUndefined();
    expect(nearestKey('typedJsn', ['typedJson', 'typedColumns'])).toBe('typedJson');
  });

  it('suggests nothing for a key that is already known', () => {
    expect(nearestKey('outDir', known)).toBeUndefined();
  });

  it('breaks a tie towards the earlier key, so a run is repeatable', () => {
    expect(nearestKey('pick', ['pica', 'pico'])).toBe('pica');
  });

  it('measures the distance it claims to', () => {
    expect(editDistance('library', 'librari')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('unknownConfigKeys', () => {
  it('finds a key at the root, in a generator entry and in a nested object at once', () => {
    const found = unknownConfigKeys(
      {
        outDirr: 'x',
        generators: [{ kind: 'zod', typedJsn: true, validation: { librari: 'zod' } }],
      },
      SHAPE
    );
    expect(found.map((f) => `${renderConfigPath(f.path)}:${f.key}`)).toEqual([
      '(root):outDirr',
      'generators[0]:typedJsn',
      'generators[0].validation:librari',
    ]);
  });

  it("says nothing about a record key, because those are the user's own names", () => {
    // `columns` is keyed by table pattern and `templateOptions` by whatever the template reads.
    expect(
      unknownConfigKeys(
        {
          columns: { 'app_*': { omit: ['deleted_at'] } },
          generators: [{ kind: 'orpc', templateOptions: { anything: 1 } }],
        },
        SHAPE
      )
    ).toEqual([]);
  });

  it('says nothing about a strict object, which zod refuses before this runs', () => {
    // `ColumnRulesSchema` is `.strict()`, so `ommit` never reaches a successful parse. Reporting
    // it here as well would print the same mistake twice in two different shapes.
    expect(unknownConfigKeys({ columns: { users: { ommit: ['a'] } } }, SHAPE)).toEqual([]);
  });

  it('says nothing about $schema, which an editor needs and the schema declares', () => {
    expect(unknownConfigKeys({ $schema: './drzl.config.schema.json' }, SHAPE)).toEqual([]);
  });

  it('declines a union whose branches cannot be told apart', () => {
    // Two object branches means guessing which one the value was written against, and a wrong
    // guess reports keys that are perfectly valid.
    const ambiguous = {
      type: 'object',
      properties: {
        thing: {
          anyOf: [
            { type: 'object', properties: { a: {} } },
            { type: 'object', properties: { b: {} } },
          ],
        },
      },
    };
    expect(unknownConfigKeys({ thing: { zzz: 1 } }, ambiguous)).toEqual([]);
  });

  it('follows a union with exactly one object branch', () => {
    // `meta`, `constraints`, `branded` and `document` all take this shape: a boolean shorthand
    // beside an object. The object branch is the only one a key can live in.
    const found = unknownConfigKeys(
      { generators: [{ kind: 'zod', outputHeader: { enabled: true, txt: 'x' } }] },
      SHAPE
    );
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('txt');
    expect(found[0].suggestion).toBe('text');
  });

  it('phrases the warning so the key and the place are both in it', () => {
    expect(unknownKeyWarnings({ outDirr: 'x' }, SHAPE)).toEqual([
      'drzl config: unknown key "outDirr" at the top level; it is ignored. Did you mean "outDir"?',
    ]);
    expect(unknownKeyWarnings({ nonsenseKeyName: 1 }, SHAPE)).toEqual([
      'drzl config: unknown key "nonsenseKeyName" at the top level; it is ignored.',
    ]);
  });
});

describe('formatConfigProblems', () => {
  it('counts the problems and names every key', () => {
    const text = formatConfigProblems(
      'drzl.config.ts',
      [
        {
          code: 'invalid_type',
          path: ['outDir'],
          message: 'Invalid input: expected string, received number',
        },
        {
          code: 'invalid_type',
          path: ['generators', 0, 'nestedDepth'],
          message: 'Invalid input: expected number, received string',
        },
      ],
      { outDir: 123, generators: [{ nestedDepth: 'deep' }] },
      SHAPE
    );
    expect(text).toBe(
      [
        `drzl.config.ts is not valid (${CONFIG_INVALID_CODE}). 2 problems:`,
        '  - outDir: expected string, received number (found 123)',
        '  - generators[0].nestedDepth: expected number, received string (found "deep")',
      ].join('\n')
    );
  });

  it("gives a strict object's refusal the same key path and a suggestion", () => {
    const text = formatConfigProblems(
      'drzl.config.ts',
      [{ code: 'unrecognized_keys', path: ['columns', 'users'], keys: ['ommit'], message: 'x' }],
      { columns: { users: { ommit: [] } } },
      SHAPE
    );
    expect(text).toContain('columns.users: unrecognized key "ommit". Did you mean "omit"?');
  });

  it('says "1 problem" rather than "1 problems"', () => {
    const text = formatConfigProblems(
      'drzl.config.ts',
      [{ code: 'invalid_type', path: ['outDir'], message: 'Invalid input: expected string' }],
      { outDir: 1 },
      SHAPE
    );
    expect(text).toContain('. 1 problem:');
  });

  it('caps a long list and counts the rest', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({
      code: 'invalid_type',
      path: ['generators', i, 'path'],
      message: 'Invalid input: expected string, received number',
    }));
    const text = formatConfigProblems('drzl.config.ts', issues, {}, SHAPE);
    expect(text).toContain('. 12 problems:');
    expect(text).toContain('  ... and 4 more');
    expect(text.split('\n')).toHaveLength(10);
  });

  it('omits the value when the config does not hold one at that path', () => {
    // A `required` issue points at a key that is not there, and "(found undefined)" restates the
    // message it would be appended to.
    const text = formatConfigProblems(
      'drzl.config.ts',
      [{ code: 'invalid_type', path: ['generators'], message: 'Invalid input: expected array' }],
      {},
      SHAPE
    );
    expect(text).toContain('  - generators: expected array');
    expect(text).not.toContain('found');
  });
});
