/**
 * The Gel dialect end to end: a real `gelTable`, the real analyzer, and the real zod generator.
 *
 * Gel was the one dialect in the public `Dialect` union with **no generator-side test at all**.
 * `mssql` and `cockroach` have four and three specs between the generators, `singlestore` has two,
 * and Gel had none, so what the emitted schemas look like for it was a claim nobody had checked.
 *
 * It is also the only one that cannot be reached from drizzle v1: `gel-core` exists in 0.45.x and
 * not in `1.0.0-rc.4`, where `mssql-core` and `cockroach-core` were added and `gel-core` was
 * dropped. So this file resolves plain `drizzle-orm`, and the mssql and cockroach specs beside it
 * resolve `drizzle-orm-v1`. No single install has all four.
 *
 * The finding this pins is that six of Gel's eighteen column types have no type DRZL can describe,
 * so their schemas accept anything. That is the documented stance for a column the analyzer cannot
 * read, and each one raises `DRZL_ANL_UNKNOWN_COLUMN`, which `doctor` surfaces. Both halves are
 * asserted: silently narrowing one of them later would be a change worth noticing, and silently
 * dropping the warning would be worse.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Analysis } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

const dir = path.join(__dirname, '.tmp-gel');

/**
 * Every column builder `gel-core` exports, so a hole cannot hide in a type nobody listed.
 *
 * `bigint` and `bigintT` are separate builders and are both here for that reason: the first is a
 * 53-bit integer as a `number`, the second Gel's arbitrary-precision `edgedbt.bigint_t`.
 */
const SOURCE = `
  import {
    gelTable, bigint, bigintT, boolean, bytes, dateDuration, decimal, doublePrecision,
    duration, integer, json, localDate, localTime, real, relDuration, smallint, text,
    timestamp, timestamptz, uuid,
  } from 'drizzle-orm/gel-core';

  export const everything = gelTable('everything', {
    id: integer('id').primaryKey(),
    aBigint: bigint('a_bigint'),
    aBigintT: bigintT('a_bigint_t'),
    aBoolean: boolean('a_boolean'),
    aBytes: bytes('a_bytes'),
    aDateDuration: dateDuration('a_date_duration'),
    aDecimal: decimal('a_decimal'),
    aDouble: doublePrecision('a_double'),
    aDuration: duration('a_duration'),
    aJson: json('a_json'),
    aLocalDate: localDate('a_local_date'),
    aLocalTime: localTime('a_local_time'),
    aReal: real('a_real'),
    aRelDuration: relDuration('a_rel_duration'),
    aSmallint: smallint('a_smallint'),
    aText: text('a_text'),
    aTimestamp: timestamp('a_timestamp'),
    aTimestamptz: timestamptz('a_timestamptz'),
    aUuid: uuid('a_uuid'),
  });
`;

let analysis: Analysis;
let emitted: string;
/** Every column, by its TypeScript property name. */
let byName: Map<string, { tsType: string; sqlType?: string }>;

beforeAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const schemaPath = path.join(dir, 'schema.ts');
  await fs.writeFile(schemaPath, SOURCE, 'utf8');

  analysis = await new SchemaAnalyzer(schemaPath).analyze({});
  byName = new Map(
    analysis.tables[0]!.columns.map((c) => [c.name, { tsType: c.tsType, sqlType: c.sqlType }])
  );

  const out = path.join(dir, 'zod');
  await new ZodGenerator(analysis).generate({ outDir: out } as never);
  emitted = await fs.readFile(path.join(out, 'everything.zod.ts'), 'utf8');
}, 120_000);

describe('the dialect itself', () => {
  it('is recognised as gel', () => {
    expect(analysis.dialect).toBe('gel');
  });

  it('reads every column the table declares', () => {
    expect(analysis.tables[0]!.columns).toHaveLength(19);
  });
});

describe('the types Gel shares with Postgres', () => {
  const expected: Array<[string, string, string]> = [
    // column,        tsType,       sqlType
    ['id', 'number', 'integer'],
    ['aBigint', 'number', 'bigint'],
    ['aBoolean', 'boolean', 'boolean'],
    ['aDecimal', 'string', 'numeric'],
    ['aDouble', 'number', 'double precision'],
    ['aReal', 'number', 'real'],
    ['aSmallint', 'number', 'smallint'],
    ['aText', 'string', 'text'],
    ['aUuid', 'string', 'uuid'],
  ];

  for (const [name, tsType, sqlType] of expected) {
    it(`types ${name} as ${tsType}`, () => {
      expect(byName.get(name)).toEqual({ tsType, sqlType });
    });
  }

  /** `bytes` is Gel's binary column, and Postgres's own name for the type leaks through. */
  it('types bytes as a Uint8Array, under the bytea it reports', () => {
    expect(byName.get('aBytes')).toEqual({ tsType: 'Uint8Array', sqlType: 'bytea' });
  });

  /**
   * `bigintT` is not `bigint`.
   *
   * The first is a 53-bit integer drizzle hands back as a `number`; the second is Gel's
   * arbitrary-precision type, which is a real `bigint`. Emitting the same schema for both would
   * lose precision on one of them silently.
   */
  it('keeps bigintT apart from bigint', () => {
    expect(byName.get('aBigint')?.tsType).toBe('number');
    expect(byName.get('aBigintT')?.tsType).toBe('bigint');
    expect(byName.get('aBigintT')?.sqlType).toBe('edgedbt.bigint_t');
  });

  it('types timestamptz as a Date, which is the one temporal type it can read', () => {
    expect(byName.get('aTimestamptz')).toEqual({ tsType: 'Date', sqlType: 'datetime' });
  });
});

describe('the six types DRZL cannot describe', () => {
  /**
   * These hold classes from the `gel` driver, not primitives, so there is nothing a plain schema
   * can check them against without importing that driver.
   *
   * `unknown` accepts anything, which is permissive rather than merely honest, and the warning
   * beside it is what makes that visible. Both are asserted: a later version narrowing one of these
   * would be an improvement worth noticing, and one that stopped warning would be a regression.
   */
  const wide: Array<[string, string]> = [
    ['aDateDuration', 'dateDuration'],
    ['aDuration', 'duration'],
    ['aLocalDate', 'cal::local_date'],
    ['aLocalTime', 'cal::local_time'],
    ['aRelDuration', 'edgedbt.relative_duration_t'],
    // Gel's `timestamp` is a *local* datetime, unlike Postgres's. `timestamptz` is the one with an
    // instant behind it, and that one does read as a Date.
    ['aTimestamp', 'cal::local_datetime'],
  ];

  for (const [name, sqlType] of wide) {
    it(`leaves ${name} wide, and says which SQL type it could not read`, () => {
      expect(byName.get(name)).toEqual({ tsType: 'unknown', sqlType });
    });
  }

  it('raises one warning per wide column, so doctor can report them', () => {
    const unknown = analysis.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    expect(unknown).toHaveLength(wide.length);
    expect(unknown.every((i) => i.level === 'warn')).toBe(true);
    for (const [name] of wide) {
      expect(
        unknown.some((i) => i.path === `everything.${name}`),
        `no warning for ${name}`
      ).toBe(true);
    }
  });

  /** `json` is wide too, and deliberately: a json column really does hold any json value. */
  it('does not count json among them, because any is the right answer there', () => {
    expect(byName.get('aJson')?.tsType).toBe('any');
    const unknown = analysis.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    expect(unknown.some((i) => i.path === 'everything.aJson')).toBe(false);
  });
});

describe('the emitted zod', () => {
  it('types the readable columns rather than widening them', () => {
    expect(emitted).toMatch(/aText:\s*z\.string\(\)/);
    expect(emitted).toMatch(/aBoolean:\s*z\.boolean\(\)/);
    expect(emitted).toMatch(/aUuid:\s*z\.(uuid|string)\(\)/);
  });

  it('emits an unknown for each column the analyzer could not read', () => {
    for (const name of ['aDuration', 'aLocalDate', 'aLocalTime', 'aTimestamp']) {
      expect(emitted, name).toMatch(new RegExp(`${name}:\\s*z\\.unknown\\(\\)`));
    }
  });

  it('carries the bigint through as a bigint rather than a number', () => {
    // Whatever spelling the generator picks, it must not be `z.number()`: that would accept a value
    // the column cannot hold and reject one it can.
    const line = emitted.split('\n').find((l) => l.includes('aBigintT:')) ?? '';
    expect(line).not.toMatch(/z\.number\(\)/);
  });
});
