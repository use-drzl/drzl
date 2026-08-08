/**
 * CHECK literals reconciled with the column's wire by the database's comparison semantics,
 * run against the exact strings the driver returns (plan addendum BL).
 *
 * GROUND TRUTH, measured on PostgreSQL 17.5 through PGlite, raw and through both drizzle majors
 * (1.0.0-rc.4 and 0.45.2 over the pglite driver, byte for byte identical), and on MySQL 8.4.11
 * through mysql2 for decimal. The driver spells one admitted value by the column's declared
 * scale:
 *
 *   stored                 numeric        numeric(10,2)   numeric(20,10)    mysql decimal(10,2)
 *   1                      '1'            '1.00'          '1.0000000000'    '1.00'
 *   1.5                    '1.5'          '1.50'          '1.5000000000'    '1.50'
 *   1.000000               '1.000000'    (a bare numeric keeps the insert's own zeros)
 *   99999999999999999999   exact, all 20 digits
 *
 * The database compares scale insensitively: `1 = 1.00` is true, `1.000000 IN (1, 2)` is true,
 * and `numeric(10,2) CHECK (n IN (1, 2))` admitted 1, 1.00 and '1.000000' while refusing 3 and
 * 1.5, returning every admitted row as '1.00'. So `z.union([z.literal(1), z.literal(2)])`
 * rejected every row this column ever returns, and the exact strings '1'/'2' would too. Quoted
 * literals point the same way from the other side: `bigint CHECK (big IN ('1','2'))` admitted 1
 * and refused 3, and `integer CHECK (age IN ('18'))` admitted 18, because the literal is coerced
 * to the column's type before comparing; `z.enum(["1","2"])` rejected every `1n` the driver
 * returns. MySQL 8.4.11 agrees on every admission probed.
 *
 * The repair is one canonical decimal spelling, emitted inline as `DrzlNumericCanon`: exact at
 * any precision, where `Number()` merges 99999999999999999998 with ...99. The members no such
 * compare can state fall back to leniency, never to rejection: Postgres *creates*
 * `numeric CHECK (n IN ('1e3', '2'))` and admits rows for it, and MySQL creates
 * `varchar CHECK (s IN (1, 2))` and admits '1.00' through double coercion, so both shapes are
 * left unenforced and the ledger says why.
 *
 * Official drizzle-orm/zod at 1.0.0-rc.4, measured beside this: numeric select is a bare
 * `z.string()` that accepts 'hello', and a CHECK is invisible to it ('3.00' passes with the IN
 * declared), so every assertion here is DRZL being stricter than official, never looser than
 * the database.
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

/** `numeric({ precision: 10, scale: 2 })`, default string mode: the driver returns '1.00'. */
const numS2 = (name = 'n') =>
  col(name, {
    tsType: 'string',
    dbType: 'NUMERIC',
    format: 'numeric',
    integer: false,
    min: '-99999999.99',
    max: '99999999.99',
  });

/** A bare `numeric()`: arbitrary precision, no declared scale, still a string wire. */
const numBare = (name = 'n') =>
  col(name, { tsType: 'string', dbType: 'NUMERIC', format: 'numeric' });

/** `bigint({ mode: 'bigint' })`: the driver returns `1n`. */
const bigB = (name = 'big') =>
  col(name, {
    tsType: 'bigint',
    dbType: 'BIGINT',
    integer: true,
    min: '-9223372036854775808',
    max: '9223372036854775807',
  });

/** `bigint({ mode: 'string' })` on v1: the driver returns '1'. */
const bigS = (name = 'big') => col(name, { tsType: 'string', dbType: 'BIGINT' });

/** A plain `integer()`: the driver returns 18. */
const intC = (name = 'age') =>
  col(name, {
    tsType: 'number',
    dbType: 'INTEGER',
    integer: true,
    min: '-2147483648',
    max: '2147483647',
  });

let seq = 0;

async function emit(
  columns: Column[],
  checks: { name?: string; expression?: string }[]
): Promise<{ modules: Record<string, any>; text: string }> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-numeric-wire');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const text = await fs.readFile(path.join(dir, 't.zod.ts'), 'utf8');
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return { modules: await import(file), text };
}

describe('CHECK (n IN (1, 2)) on the numeric string wire', () => {
  const IN = [{ name: 'n_valid', expression: 'n IN (1, 2)' }];

  it('accepts every driver spelling of an admitted value and rejects the rest, in every mode', async () => {
    const { modules: m } = await emit([numS2()], IN);
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      // Measured driver returns for the admitted rows of exactly this CHECK.
      expect(m[s].safeParse({ n: '1.00' }).success, `${s} '1.00'`).toBe(true);
      expect(m[s].safeParse({ n: '2.00' }).success, `${s} '2.00'`).toBe(true);
      expect(m[s].safeParse({ n: '1' }).success, `${s} '1'`).toBe(true);
      expect(m[s].safeParse({ n: '1.000000' }).success, `${s} '1.000000'`).toBe(true);
      // Values the database refuses into this CHECK.
      expect(m[s].safeParse({ n: '3' }).success, `${s} '3'`).toBe(false);
      expect(m[s].safeParse({ n: '3.00' }).success, `${s} '3.00'`).toBe(false);
      expect(m[s].safeParse({ n: '1.5' }).success, `${s} '1.5'`).toBe(false);
      // The wire carries strings: the number 1 is not a value this column ever returns.
      expect(m[s].safeParse({ n: 1 }).success, `${s} number 1`).toBe(false);
      // NaN is a value a bare numeric stores, and NaN IN (1, 2) is false in the database.
      expect(m[s].safeParse({ n: 'NaN' }).success, `${s} 'NaN'`).toBe(false);
    }
  });

  it('still accepts NULL, which the database does', async () => {
    const { modules: m } = await emit([numS2()], IN);
    expect(m.SelecttSchema.safeParse({ n: null }).success).toBe(true);
  });

  it('keeps a 20 digit member exact instead of rounding it through a double', async () => {
    // Number() merges these two spellings; the canonical compare must not.
    const { modules: m } = await emit(
      [numBare()],
      [{ expression: 'n IN (99999999999999999999)' }]
    );
    expect(m.SelecttSchema.safeParse({ n: '99999999999999999999' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '99999999999999999998' }).success).toBe(false);
  });
});

describe('the OR fold of the same constraint', () => {
  it('emits byte for byte what the IN list it means emits', async () => {
    const a = await emit([numS2()], [{ name: 'n_valid', expression: 'n = 1 OR n = 2' }]);
    const b = await emit([numS2()], [{ name: 'n_valid', expression: 'n IN (1, 2)' }]);
    expect(a.text).toBe(b.text);
  });

  it('accepts the padded returns and rejects 3 like the IN it folds to', async () => {
    const { modules: m } = await emit([numS2()], [{ expression: 'n = 1 OR n = 2' }]);
    expect(m.SelecttSchema.safeParse({ n: '1.00' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '2.00' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '3.00' }).success).toBe(false);
  });
});

describe('equality and inequality on the numeric string wire', () => {
  it('CHECK (n = 1) accepts the scale padded return and rejects 2', async () => {
    // The database admitted 1.00 into exactly this CHECK and returned '1.00'.
    const { modules: m } = await emit([numS2()], [{ expression: 'n = 1' }]);
    expect(m.SelecttSchema.safeParse({ n: '1.00' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '1' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '2.00' }).success).toBe(false);
  });

  it('CHECK (n <> 1) rejects every spelling of 1 and accepts 2', async () => {
    const { modules: m } = await emit([numS2()], [{ expression: 'n <> 1' }]);
    expect(m.SelecttSchema.safeParse({ n: '1.00' }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ n: '1' }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ n: '2.00' }).success).toBe(true);
  });

  it("a quoted equality, CHECK (n = '2.50'), meets the same padded wire", async () => {
    const { modules: m } = await emit([numS2()], [{ expression: "n = '2.50'" }]);
    expect(m.SelecttSchema.safeParse({ n: '2.5' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '2.50' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '2.55' }).success).toBe(false);
  });
});

describe('quoted literals on the numeric string wire', () => {
  it("CHECK (n IN ('1', '2.5')) accepts the padded spellings of both members", async () => {
    const { modules: m } = await emit([numS2()], [{ expression: "n IN ('1', '2.5')" }]);
    expect(m.SelecttSchema.safeParse({ n: '1.00' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '2.50' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '2.5' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '3' }).success).toBe(false);
  });
});

describe('quoted literals on the bigint wire', () => {
  const QIN = [{ expression: "big IN ('1', '2')" }];

  it('accepts the bigints the driver returns and rejects strings and numbers', async () => {
    // The database admitted 1 and refused 3 into exactly this CHECK: quoting does not make the
    // comparison textual.
    const { modules: m } = await emit([bigB()], QIN);
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 2n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 3n }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ big: 1 }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ big: '1' }).success).toBe(false);
  });

  it('emits byte for byte what the unquoted IN emits', async () => {
    const a = await emit([bigB()], [{ name: 'c', expression: "big IN ('1', '2')" }]);
    const b = await emit([bigB()], [{ name: 'c', expression: 'big IN (1, 2)' }]);
    expect(a.text).toBe(b.text);
  });

  it("CHECK (big = '1') accepts 1n and rejects 2n", async () => {
    const { modules: m } = await emit([bigB()], [{ expression: "big = '1'" }]);
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 2n }).success).toBe(false);
  });

  it("CHECK (big <> '1') rejects 1n and accepts 2n", async () => {
    const { modules: m } = await emit([bigB()], [{ expression: "big <> '1'" }]);
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ big: 2n }).success).toBe(true);
  });
});

describe('quoted literals on the integer wire', () => {
  it("CHECK (age IN ('18')) accepts the number 18 the driver returns", async () => {
    const { modules: m } = await emit([intC()], [{ expression: "age IN ('18')" }]);
    expect(m.SelecttSchema.safeParse({ age: 18 }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ age: 19 }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ age: '18' }).success).toBe(false);
  });

  it("a quoted range, CHECK (age >= '18'), binds like its unquoted twin", async () => {
    const { modules: m } = await emit([intC()], [{ expression: "age >= '18'" }]);
    expect(m.SelecttSchema.safeParse({ age: 18 }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ age: 17 }).success).toBe(false);
  });
});

describe('the v1 bigint mode string wire', () => {
  it('CHECK (big IN (1, 2)) accepts the digit strings the driver returns', async () => {
    const { modules: m } = await emit([bigS()], [{ expression: 'big IN (1, 2)' }]);
    expect(m.SelecttSchema.safeParse({ big: '1' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: '2' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: '3' }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(false);
  });
});

describe('members no exact compare can state fall back to leniency, never rejection', () => {
  it("CHECK (n IN ('1e3', '2')) enforces nothing rather than rejecting admitted rows", async () => {
    // Postgres creates this table and admits 1000, returned as '1000' or '1000.00'. A canonical
    // decimal compare cannot say that '1e3' names the same value, so the whole set is left to
    // the base schema and the constraint ledger reports it unenforced.
    const { modules: m } = await emit([numBare()], [{ expression: "n IN ('1e3', '2')" }]);
    expect(m.SelecttSchema.safeParse({ n: '1000' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '1000.00' }).success).toBe(true);
    // Leniency, pinned: the base schema also takes what the CHECK would refuse.
    expect(m.SelecttSchema.safeParse({ n: '7' }).success).toBe(true);
    // The numeric format still holds underneath.
    expect(m.SelecttSchema.safeParse({ n: 'hello' }).success).toBe(false);
  });

  it('CHECK (s IN (1, 2)) on a text wire enforces nothing rather than rejecting rows', async () => {
    // Postgres refuses this DDL outright; MySQL creates it and admits '1.00', '1' and '2.0'
    // through double coercion, refusing 'x'. No exact compare states that coercion, so nothing
    // is enforced and the ledger says why.
    const { modules: m } = await emit([col('s')], [{ expression: 's IN (1, 2)' }]);
    expect(m.SelecttSchema.safeParse({ s: '1.00' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ s: 'x' }).success).toBe(true);
  });
});

describe('ranges on the numeric string wire', () => {
  it('CHECK (n >= 1) compares numerically and is spelled type clean', async () => {
    const { modules: m, text } = await emit([numS2()], [{ expression: 'n >= 1' }]);
    expect(m.SelecttSchema.safeParse({ n: '1.00' }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ n: '0.99' }).success).toBe(false);
    // `v >= 1` on a string is a TS2365 in a consumer's build and hides the coercion; the
    // emitted compare says what it does.
    expect(text).toContain('Number(');
  });
});

describe('what the emitted module carries', () => {
  it('emits the canonical helper once and keys the compare on it', async () => {
    const { text } = await emit([numS2()], [{ name: 'n_valid', expression: 'n IN (1, 2)' }]);
    expect(text).toContain('DrzlNumericCanon');
    expect(text.split('const DrzlNumericCanon').length).toBe(2);
    // The message keeps the SQL spelling, which is what the constraint ledger keys on.
    expect(text).toContain('n_valid: n IN (1, 2)');
  });

  it('emits no helper where no column needs it', async () => {
    const { text } = await emit([intC()], [{ expression: 'age IN (18, 21)' }]);
    expect(text).not.toContain('DrzlNumericCanon');
  });
});
