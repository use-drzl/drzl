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
 * the emitted schema on every one of them. The probe table is in the changeset.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

describe('a disjunction of equalities on one column', () => {
  const OR = [{ name: 'status_valid', expression: "status = 'draft' OR status = 'live'" }];

  it('narrows the column to those values', async () => {
    const m = await schemasFor([col('status')], OR);
    expect(m.SelecttSchema.safeParse({ status: 'draft' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ status: 'live' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });

  it('still accepts NULL, which the database does', async () => {
    // `NULL = 'draft' OR NULL = 'live'` is NULL, and a CHECK passes on NULL. Measured.
    const m = await schemasFor([col('status')], OR);
    expect(m.SelecttSchema.safeParse({ status: null }).success).toBe(true);
  });

  it('emits exactly what the IN list it means emits', async () => {
    // Sequenced, not `Promise.all`: both calls write the same `t.zod.ts` before renaming it.
    const a = await schemasFor([col('status')], OR);
    const b = await schemasFor([col('status')], [{ expression: "status IN ('draft', 'live')" }]);
    for (const v of ['draft', 'live', 'deleted', null]) {
      expect(a.SelecttSchema.safeParse({ status: v }).success, String(v)).toBe(
        b.SelecttSchema.safeParse({ status: v }).success
      );
    }
  });

  it('leaves a disjunction it cannot read enforcing nothing', async () => {
    // Refused whole, not in part. A row satisfying the branch that was dropped is a row the
    // database accepts, and enforcing the other branch would turn it away.
    const m = await schemasFor(
      [col('n', { tsType: 'number', dbType: 'INTEGER' })],
      [{ expression: 'n < 0 OR n > 100' }]
    );
    expect(m.SelecttSchema.safeParse({ n: 50 }).success).toBe(true);
  });
});

describe('a CHECK that forbids NULL', () => {
  const NOT_NULL = [{ name: 'email_set', expression: 'email IS NOT NULL' }];

  it('refuses null in every mode', async () => {
    const m = await schemasFor([col('email')], NOT_NULL);
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      expect(m[s].safeParse({ email: null }).success, s).toBe(false);
      expect(m[s].safeParse({ email: 'a@b' }).success, s).toBe(true);
    }
  });

  it('makes the field required on insert, since omitting it writes NULL', async () => {
    const m = await schemasFor([col('email')], NOT_NULL);
    expect(m.InserttSchema.safeParse({}).success).toBe(false);
    // An update naming no column writes nothing, so the constraint is not reached.
    expect(m.UpdatetSchema.safeParse({}).success).toBe(true);
  });

  it('leaves it optional on insert when the column defaults to a value', async () => {
    // Omitting it writes the default, which is not NULL, so the constraint holds.
    const m = await schemasFor([col('email', { hasDefault: true })], NOT_NULL);
    expect(m.InserttSchema.safeParse({}).success).toBe(true);
    expect(m.InserttSchema.safeParse({ email: null }).success).toBe(false);
  });

  it('touches no other column', async () => {
    const m = await schemasFor([col('email'), col('note')], NOT_NULL);
    expect(m.SelecttSchema.safeParse({ email: 'a@b', note: null }).success).toBe(true);
  });

  it('reaches an array column, which is either there or not like anything else', async () => {
    const m = await schemasFor(
      [col('tags', { arrayDimensions: 1 })],
      [{ expression: 'tags IS NOT NULL' }]
    );
    expect(m.SelecttSchema.safeParse({ tags: null }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ tags: ['a'] }).success).toBe(true);
  });
});

describe('a null guard in front of a predicate', () => {
  const num = () => col('age', { tsType: 'number', dbType: 'INTEGER', integer: true });

  it('behaves exactly as the predicate alone does', async () => {
    const guarded = await schemasFor([num()], [{ expression: 'age IS NULL OR age >= 18' }]);
    const plain = await schemasFor([num()], [{ expression: 'age >= 18' }]);
    for (const v of [null, 17, 18, 40]) {
      expect(guarded.SelecttSchema.safeParse({ age: v }).success, String(v)).toBe(
        plain.SelecttSchema.safeParse({ age: v }).success
      );
    }
    expect(guarded.SelecttSchema.safeParse({ age: 17 }).success).toBe(false);
    expect(guarded.SelecttSchema.safeParse({ age: null }).success).toBe(true);
  });

  it('does not read a narrowing out of the guard it dropped', async () => {
    // The guard branch is what makes NULL legal, so taking it as `IS NOT NULL` would invert the
    // constraint and refuse every NULL the database takes.
    const m = await schemasFor([num()], [{ expression: 'age IS NULL OR age >= 18' }]);
    expect(m.InserttSchema.safeParse({}).success).toBe(true);
  });
});

describe('IS DISTINCT FROM', () => {
  it('emits byte for byte what the <> it reduces to emits', async () => {
    // `NULL IS DISTINCT FROM 'x'` is TRUE and `NULL <> 'x'` is NULL, and a CHECK passes on both,
    // so the two constrain the same rows. Asserted on the emitted text rather than only on
    // behaviour, because equal output is what makes the reduction cost nothing to review.
    const dir = path.join(__dirname, '.tmp-ornull');
    await fs.mkdir(dir, { recursive: true });
    const emit = async (expression: string) => {
      const analysis: Analysis = {
        dialect: 'postgres',
        tables: [
          {
            name: 't',
            tsName: 't',
            columns: [col('tier')],
            unique: [],
            indexes: [],
            checks: [{ name: 'tier_ok', expression }],
          },
        ] as never,
        enums: [],
        relations: [],
        issues: [],
      };
      await new ZodGenerator(analysis).generate({ outDir: dir } as never);
      return fs.readFile(path.join(dir, 't.zod.ts'), 'utf8');
    };
    expect(await emit("tier IS DISTINCT FROM 'banned'")).toBe(await emit("tier <> 'banned'"));
  });
});
