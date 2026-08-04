/**
 * A bigint column's range in ArkType output.
 *
 * This generator emitted a bare `bigint` and nothing else, so a `bigint({ mode: 'bigint' })`
 * column accepted `2n ** 70n`: a value no int64 column can hold, that zod, valibot and typebox
 * all reject, and that `drizzle-orm/arktype` rejects too. It was waived on all three dialects in
 * the packed gate rather than fixed.
 *
 * Being looser than the first-party validator is not by itself the thing that made it wrong, and
 * an earlier version of this sentence said it was "the one direction this project says generated
 * output must never take". The gate counts its looser waivers and most of them run that way, some
 * because the database backs DRZL. What made this one wrong is that no `int64` column can hold
 * `2n ** 70n`, so the schema promised a write the database refuses.
 *
 * The reason recorded for the waiver was half true. ArkType's *string DSL* genuinely cannot state
 * it: `type('bigint >= -9223372036854775808n')` throws "Comparator >= must be followed by a
 * corresponding literal", and writing the bound as a number rounds, since 9223372036854775807 is
 * not representable as a double. But `.narrow` can hold it, and this generator already uses
 * `.narrow` for every character cap.
 *
 * Every case but the last runs the emitted module. An expression ArkType cannot parse throws at
 * import rather than validating loosely, so "the source looks right" is not enough. The last case
 * says at its own site why it is the exception.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { type } from 'arktype';

const INT64_MIN = '-9223372036854775808';
const INT64_MAX = '9223372036854775807';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'bigint',
    dbType: 'BIGINT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    min: INT64_MIN,
    max: INT64_MAX,
    ...over,
  }) as Column;

async function schemasFor(
  columns: Column[],
  opts: { checks?: { name?: string; expression?: string }[]; applyDefaults?: boolean } = {}
) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [
      { name: 't', tsName: 't', columns, unique: [], indexes: [], checks: opts.checks ?? [] },
    ] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-atbig-'));
  await new ArkTypeGenerator(analysis).generate({
    outDir,
    applyDefaults: opts.applyDefaults ?? false,
  } as never);
  const file = path.join(outDir, 't.arktype.ts');
  const source = await fs.readFile(file, 'utf8');
  // Loading is separate and explicit, because it is itself an assertion: an expression ArkType
  // cannot parse throws here rather than validating loosely. One case below deliberately does not
  // load, and says why.
  return { source, load: () => import(file) };
}

const ok = (schema: any, value: unknown) => !(schema({ n: value }) instanceof type.errors);

describe('an int64 column', () => {
  it('rejects a value no int64 can hold, in every mode', async () => {
    const mod = await (await schemasFor([col('n')])).load();
    for (const name of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      const s = mod[name];
      expect(ok(s, 1n), `${name} accepts a small bigint`).toBe(true);
      expect(ok(s, BigInt(INT64_MAX)), `${name} accepts the maximum`).toBe(true);
      expect(ok(s, BigInt(INT64_MIN)), `${name} accepts the minimum`).toBe(true);
      expect(ok(s, 2n ** 70n), `${name} rejects above the maximum`).toBe(false);
      expect(ok(s, -(2n ** 70n)), `${name} rejects below the minimum`).toBe(false);
    }
  });

  it('still takes null when the column is nullable', async () => {
    const mod = await (await schemasFor([col('n', { nullable: true })])).load();
    expect(ok(mod.SelecttSchema, null)).toBe(true);
    expect(ok(mod.SelecttSchema, 2n ** 70n)).toBe(false);
  });

  it('bounds the element of an array column rather than the array', async () => {
    const mod = await (await schemasFor([col('n', { arrayDimensions: 1 })])).load();
    expect(ok(mod.SelecttSchema, [1n])).toBe(true);
    expect(ok(mod.SelecttSchema, [2n ** 70n])).toBe(false);
  });
});

describe('a CHECK on a bigint column', () => {
  it('narrows the declared range', async () => {
    const mod = await (
      await schemasFor([col('n')], { checks: [{ name: 'n_min', expression: 'n >= 10' }] })
    ).load();
    expect(ok(mod.SelecttSchema, 10n)).toBe(true);
    expect(ok(mod.SelecttSchema, 9n)).toBe(false);
    expect(ok(mod.SelecttSchema, 2n ** 70n)).toBe(false);
  });
});

describe('a bound ArkType could only state wrongly', () => {
  it('is left off rather than emitted as a syntax error', async () => {
    // `1.5n` does not parse, and an emitted module that does not parse throws at import and takes
    // whatever imported it down. A column claiming a fractional bigint bound is nonsense the
    // analyzer should never produce, so the only requirement is that it stays loadable.
    const { source, load } = await schemasFor([col('n', { min: '1.5', max: '9.5' })]);
    expect(source).not.toContain('1.5n');
    const mod = await load();
    expect(ok(mod.SelecttSchema, 1n)).toBe(true);
  });
});

describe('a bigint column carrying an applied default', () => {
  /**
   * The bound is dropped on a field that carries an applied default, because a defaultable
   * definition is only valid as an object property: `type("(bigint | null) = null").narrow(...)`
   * throws at import. Remove the guard in the generator and this test fails by not loading.
   *
   * It is checked by loading rather than by reading the source, because the source cannot show
   * the part that matters: the module loads, and its insert schema is unbounded while select and
   * update are bounded. An earlier version of this test asserted on the text and claimed no such
   * module could load at all, which was wrong and unfalsifiable in that form.
   *
   * `null` is the only default value that reaches this state. `.default(7)` on a bigint is
   * refused by ArkType as "Default for n must be a bigint", and a bigint-valued default crashes
   * the generator on `JSON.stringify`. Both are applyDefaults defects tracked separately, and
   * fixing them, or moving the default onto the Type where `.default()` keeps the narrow, should
   * turn the first expectation below into `false` and this comment into history.
   */
  it('loads, and is unbounded on insert alone, which is the cost of the guard', async () => {
    const { load } = await schemasFor(
      [col('n', { nullable: true, hasDefault: true, defaultValue: null as never })],
      { applyDefaults: true }
    );
    const mod = await load();
    expect(ok(mod.InserttSchema, 2n ** 70n), 'insert: the bound the guard drops').toBe(true);
    expect(ok(mod.SelecttSchema, 2n ** 70n), 'select: bounded as usual').toBe(false);
    expect(ok(mod.UpdatetSchema, 2n ** 70n), 'update: bounded as usual').toBe(false);
    expect(ok(mod.InserttSchema, 1n), 'insert still accepts a valid value').toBe(true);
  });
});

/**
 * Array columns, where the constraint describes the element and the column's nullability
 * describes the whole list.
 *
 * These are one family with the character caps rather than a bigint concern, and they are here
 * because a bigint array is how the defect was found. The generator used to derive the element by
 * stripping a trailing `[]` off the rendered type string, which is correct only when nothing else
 * is wrapped around it. A nullable array renders as `(bigint[] | null)`, so the whole union became
 * the "element" and `.array()` wrapped that: `[[1n]]` and `[null]` were accepted, `null` and
 * `[1n]` were refused, and for bigint the emitted TypeScript did not compile, because `>=` cannot
 * be applied to `bigint[]`. The same shape was silently wrong for a capped string array on master,
 * where it compiled and only misvalidated.
 */
describe('an array column', () => {
  const cases: [string, Column][] = [
    ['bigint, not null', col('n', { arrayDimensions: 1 })],
    ['bigint, nullable', col('n', { arrayDimensions: 1, nullable: true })],
  ];
  for (const [label, column] of cases) {
    it(`${label}: bounds the element and lets the column's own nullability stand`, async () => {
      const mod = await (await schemasFor([column])).load();
      const s = mod.SelecttSchema;
      expect(ok(s, [1n]), 'a list of valid elements').toBe(true);
      expect(ok(s, []), 'an empty list').toBe(true);
      expect(ok(s, [2n ** 70n]), 'an element above the maximum').toBe(false);
      expect(ok(s, [[1n]]), 'a list of lists, one dimension too many').toBe(false);
      expect(ok(s, [null]), 'a null element').toBe(false);
      expect(ok(s, 1n), 'a bare element where a list belongs').toBe(false);
      expect(ok(s, null), `null itself`).toBe(column.nullable === true);
    });
  }

  it('a nullable capped-string array bounds the element too', async () => {
    // The pre-existing instance of the same defect, which compiled and so was never noticed.
    const column = {
      ...col('n', { arrayDimensions: 1, nullable: true }),
      tsType: 'string',
      dbType: 'TEXT',
      maxLength: 5,
      min: undefined,
      max: undefined,
    } as Column;
    const mod = await (await schemasFor([column])).load();
    const s = mod.SelecttSchema;
    expect(ok(s, ['ab']), 'a list of short strings').toBe(true);
    expect(ok(s, null), 'null, which the column allows').toBe(true);
    expect(ok(s, ['abcdef']), 'an element over the cap').toBe(false);
    expect(ok(s, [['ab']]), 'a list of lists').toBe(false);
  });

  it('bounds the element of a two-dimensional array at the right depth', async () => {
    const mod = await (await schemasFor([col('n', { arrayDimensions: 2 })])).load();
    const s = mod.SelecttSchema;
    expect(ok(s, [[1n]])).toBe(true);
    expect(ok(s, [[2n ** 70n]])).toBe(false);
    expect(ok(s, [1n]), 'one dimension too few').toBe(false);
  });
});
