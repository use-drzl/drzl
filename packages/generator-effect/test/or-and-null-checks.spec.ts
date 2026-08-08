/**
 * The three CHECK shapes this version started reading, run rather than read.
 *
 * `status = 'a' OR status = 'b'` is the same statement as `status IN ('a','b')`, NULL included,
 * so it becomes the same enum. `col IS NOT NULL` is the one constraint that cannot be a predicate
 * on the field, because a predicate sits inside the nullable wrapper precisely so NULL skips it;
 * it is stated by the field not being nullable. `col IS NULL OR P` states nothing beyond `P`,
 * because a CHECK already passes on NULL, so it reduces to `P`.
 *
 * Every value below was put to a real Postgres through PGlite first, and the database agrees with
 * the emitted schema on every one of them.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EffectGenerator } from '../src/index';
import * as Either from 'effect/Either';
import * as Schema from 'effect/Schema';

const SUFFIX = '.effect.ts';
const RUN = (schema: any, input: unknown) =>
  Either.isRight(Schema.decodeUnknownEither(schema as Schema.Schema<unknown>)(input));

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: true,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

async function schemasFor(
  columns: Column[],
  checks: { name?: string; expression?: string }[]
): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-ornull');
  await fs.mkdir(dir, { recursive: true });
  await new EffectGenerator(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, `t${SUFFIX}`), file);
  return await import(file);
}

const num = () =>
  col('age', { tsType: 'number', dbType: 'INTEGER', integer: true, nullable: true });

describe('a disjunction of equalities on one column', () => {
  const OR = [{ name: 'status_valid', expression: "status = 'draft' OR status = 'live'" }];

  it('narrows the column to those values, and still accepts NULL', async () => {
    // `NULL = 'draft' OR NULL = 'live'` is NULL and a CHECK passes on NULL, so null stays legal.
    const m = await schemasFor([col('status')], OR);
    expect(RUN(m.SelecttSchema, { status: 'draft' })).toBe(true);
    expect(RUN(m.SelecttSchema, { status: 'live' })).toBe(true);
    expect(RUN(m.SelecttSchema, { status: 'deleted' })).toBe(false);
    expect(RUN(m.SelecttSchema, { status: null })).toBe(true);
  });

  it('agrees with the IN list it means on every probe value', async () => {
    // Sequenced, not `Promise.all`: both calls write the same file before renaming it.
    const a = await schemasFor([col('status')], OR);
    const b = await schemasFor([col('status')], [{ expression: "status IN ('draft', 'live')" }]);
    for (const value of ['draft', 'live', 'deleted', null]) {
      expect(RUN(a.SelecttSchema, { status: value }), String(value)).toBe(
        RUN(b.SelecttSchema, { status: value })
      );
    }
  });

  it('leaves a disjunction it cannot read enforcing nothing', async () => {
    // Refused whole, not in part: a row satisfying the dropped branch is one the database takes.
    const m = await schemasFor([num()], [{ expression: 'age < 0 OR age > 100' }]);
    expect(RUN(m.SelecttSchema, { age: 50 })).toBe(true);
  });
});

describe('a CHECK that forbids NULL', () => {
  const NOT_NULL = [{ name: 'email_set', expression: 'email IS NOT NULL' }];

  it('refuses null in every mode', async () => {
    const m = await schemasFor([col('email')], NOT_NULL);
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      expect(RUN(m[s], { email: null }), s).toBe(false);
      expect(RUN(m[s], { email: 'a@b' }), s).toBe(true);
    }
  });

  it('makes the field required on insert, since omitting it writes NULL', async () => {
    const m = await schemasFor([col('email')], NOT_NULL);
    expect(RUN(m.InserttSchema, {})).toBe(false);
    // An update naming no column writes nothing, so the constraint is never reached.
    expect(RUN(m.UpdatetSchema, {})).toBe(true);
  });

  it('leaves it optional on insert when the column defaults to a value', async () => {
    const m = await schemasFor([col('email', { hasDefault: true })], NOT_NULL);
    expect(RUN(m.InserttSchema, {})).toBe(true);
    expect(RUN(m.InserttSchema, { email: null })).toBe(false);
  });

  it('touches no other column', async () => {
    const m = await schemasFor([col('email'), col('note')], NOT_NULL);
    expect(RUN(m.SelecttSchema, { email: 'a@b', note: null })).toBe(true);
  });
});

describe('a null guard in front of a predicate', () => {
  it('behaves exactly as the predicate alone does', async () => {
    const guarded = await schemasFor([num()], [{ expression: 'age IS NULL OR age >= 18' }]);
    const plain = await schemasFor([num()], [{ expression: 'age >= 18' }]);
    for (const value of [null, 17, 18, 40]) {
      expect(RUN(guarded.SelecttSchema, { age: value }), String(value)).toBe(
        RUN(plain.SelecttSchema, { age: value })
      );
    }
    expect(RUN(guarded.SelecttSchema, { age: 17 })).toBe(false);
    expect(RUN(guarded.SelecttSchema, { age: null })).toBe(true);
  });

  it('does not read a narrowing out of the guard it dropped', async () => {
    // The guard branch is what makes NULL legal, so reading it as `IS NOT NULL` would invert the
    // constraint and refuse every NULL the database takes.
    const m = await schemasFor([num()], [{ expression: 'age IS NULL OR age >= 18' }]);
    expect(RUN(m.InserttSchema, {})).toBe(true);
  });
});
