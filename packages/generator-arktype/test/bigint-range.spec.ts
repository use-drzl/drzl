/**
 * A bigint column's range in ArkType output.
 *
 * This generator emitted a bare `bigint` and nothing else, so a `bigint({ mode: 'bigint' })`
 * column accepted `2n ** 70n`: a value no int64 column can hold, that zod, valibot and typebox
 * all reject, and that `drizzle-orm/arktype` rejects too. Looser than the first-party validator
 * is the one direction this project says generated output must never take, and it was waived on
 * all three dialects in the packed gate rather than fixed.
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
   * Asserted on the source rather than by running it, which this file otherwise never does.
   *
   * The module cannot be loaded today, for a reason that predates the bound and is not fixed
   * here: `applyDefaults` renders the default with `JSON.stringify`, so a bigint column emits
   * `bigint = 7` and ArkType refuses it with "Default for n must be a bigint (was a number)". A
   * bigint-valued default fails even earlier, in the generator, with "Do not know how to
   * serialize a BigInt". Both are reported separately.
   *
   * What is checked here is only that this change does not add a second reason it cannot load:
   * `type("bigint = 7").narrow(...)` would throw "Defaultable definitions ... are only valid as
   * properties", which is what the guard at the call site exists to avoid.
   */
  it('keeps the bound off the defaulted field, which cannot carry a narrow', async () => {
    const { source } = await schemasFor([col('n', { hasDefault: true, defaultValue: 7 as never })], {
      applyDefaults: true,
    });
    const insert = source.match(/InserttSchema = type\(\{([\s\S]*?)\n\}\)/)?.[1];
    expect(insert, `no insert schema in:\n${source}`).toBeTruthy();
    expect(insert).toContain('= 7');
    expect(insert).not.toContain('narrow');
    // Select carries no default, so the bound is on it as usual. This is the positive control:
    // without it, a generator that emitted no bound at all would pass the two lines above.
    const select = source.match(/SelecttSchema = type\(\{([\s\S]*?)\n\}\)/)?.[1];
    expect(select).toContain('narrow');
  });
});
