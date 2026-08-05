/**
 * Gel columns, from a real `gelTable` through the real analyzer and the real zod generator into
 * an emitted module that is imported and run.
 *
 * It lives in this package because this is the only one where `drizzle-orm` and `zod` both
 * resolve, so the whole chain can be exercised in one file rather than split across a
 * hand-written `Column[]` in the generator package and a type assertion in the analyzer package.
 * Requires a build, like the other end-to-end files here: CI builds before testing.
 *
 * GROUND TRUTH. A live Gel 7.1 (`geldata/gel:7`, `sys::get_version_as_str()` -> `7.1+08db576`),
 * with a `T` object type carrying one property per Gel scalar, read back through
 * `drizzle-orm/gel` 0.45.2 on `gel@2.2.0`. `constructor.name` of every value in the row:
 *
 *   column  gel-core/columns/*.d.ts declares   the server hands back
 *   flag    boolean                            boolean            true
 *   name    string                             string             'hello'
 *   dec     string                             string             '12.34'
 *   ts      LocalDateTime                      LocalDateTime      2020-01-01T12:00:00
 *   tstz    Date                               Date               2020-01-01T12:00:00.000Z
 *   ld      LocalDate                          LocalDate          2020-01-01
 *   lt      LocalTime                          LocalTime          12:00:00
 *   dd      DateDuration                       RelativeDuration   P1Y2M3D
 *   rd      RelativeDuration                   RelativeDuration   P1Y2M3DT4H
 *   d       Duration                           RelativeDuration   PT4H5M
 *
 * The last two lines are the server disagreeing with drizzle's own declaration, and the server
 * is the arbiter. Insert goes the other way on the same two: the same server took a
 * `DateDuration` into `dd` and a `Duration` into `d` and refused a `RelativeDuration` for
 * either, so the round trip is genuinely asymmetric.
 *
 * The string DRZL used to demand is refused on insert by all six, measured on that server:
 * `'2020-01-01T12:00:00'`, `'2020-01-01'`, `'01:02:03'`, `'P1Y'`, `'P1Y'` and `'PT1H'` were each
 * rejected outright, and the matching class instance accepted. So `string` was not merely a
 * loose answer for these six, it was refused in both directions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Analysis } from '@drzl/analyzer';
import { ZodGenerator } from '@drzl/generator-zod';

const DIR = path.join(__dirname, '.tmp-gel');

const SCHEMA = `
import {
  gelTable, boolean, text, decimal, timestamp, timestamptz,
  localDate, localTime, dateDuration, relDuration, duration,
} from 'drizzle-orm/gel-core';
export const t = gelTable('t', {
  flag: boolean('flag').notNull(),
  name: text('name').notNull(),
  dec: decimal('dec').notNull(),
  ts: timestamp('ts').notNull(),
  tstz: timestamptz('tstz').notNull(),
  ld: localDate('ld').notNull(),
  lt: localTime('lt').notNull(),
  dd: dateDuration('dd').notNull(),
  rd: relDuration('rd').notNull(),
  d: duration('d').notNull(),
});
`;

/**
 * A stand-in for one of the `gel` classes above.
 *
 * `gel` is a peer of `drizzle-orm` and is not a dependency of this repo, so the real class is
 * not importable here. What an emitted schema can observe about the real value is that it is an
 * object and not a string, which is exactly what this reproduces; the class identity is recorded
 * in the header, where the server that produced it is named. Constructed through a computed key
 * so `constructor.name` really is the name passed in, rather than a comment claiming it is.
 */
function driverInstance(className: string, printed: string): object {
  const holder = {
    [className]: class {
      toString() {
        return printed;
      }
      toJSON() {
        return printed;
      }
    },
  };
  return new holder[className]!();
}

/** One value per column, as the live server handed it back. */
const FROM_SERVER: Record<string, unknown> = {
  flag: true,
  name: 'hello',
  dec: '12.34',
  tstz: new Date('2020-01-01T12:00:00Z'),
  ts: driverInstance('LocalDateTime', '2020-01-01T12:00:00'),
  ld: driverInstance('LocalDate', '2020-01-01'),
  lt: driverInstance('LocalTime', '12:00:00'),
  dd: driverInstance('RelativeDuration', 'P1Y2M3D'),
  rd: driverInstance('RelativeDuration', 'P1Y2M3DT4H'),
  d: driverInstance('RelativeDuration', 'PT4H5M'),
};

/** The six whose value is a class instance from the `gel` package. */
const INSTANCE_COLUMNS = ['ts', 'ld', 'lt', 'dd', 'rd', 'd'] as const;

let analysis: Analysis;
let mod: Record<string, any>;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const schemaFile = path.join(DIR, 'schema.ts');
  await fs.writeFile(schemaFile, SCHEMA, 'utf8');

  analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schemaFile)).analyze({});
  expect(analysis.dialect, 'a real gelTable is analyzed as gel').toBe('gel');

  await new ZodGenerator(analysis).generate({ outDir: DIR } as never);
  const emitted = path.join(DIR, 't.zod.ts');
  expect(existsSync(emitted), `no module was emitted at ${emitted}`).toBe(true);
  // Imported under a unique name so a rerun is never served from the module cache, the same
  // guard `structured-columns.spec.ts` uses.
  const unique = path.join(DIR, `t-${process.pid}.zod.ts`);
  await fs.rename(emitted, unique);
  mod = await import(unique);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

describe('a Gel boolean column', () => {
  it('is a boolean, and refuses what a boolean is not', () => {
    // `GelBoolean` matched no case in the analyzer's `/^Gel/i` arm and fell off the end to
    // `unknown`, so the emitted field was `z.unknown()` and the column that a database can only
    // ever put `true` or `false` in accepted every one of the values below.
    const f = mod.SelecttSchema.shape.flag;
    expect(accepts(f, true), 'true').toBe(true);
    expect(accepts(f, false), 'false').toBe(true);
    expect(accepts(f, 'yes'), "'yes'").toBe(false);
    expect(accepts(f, 12345), '12345').toBe(false);
    expect(accepts(f, { a: 1 }), 'an object').toBe(false);
    expect(accepts(f, null), 'null on a NOT NULL column').toBe(false);
  });
});

describe('the six Gel columns whose value is a class from the gel package', () => {
  it.each(INSTANCE_COLUMNS)('accepts the value the server returns for %s', (name) => {
    // Before: `z.string()`, so the select schema refused every row the database returned.
    const f = mod.SelecttSchema.shape[name];
    expect(accepts(f, FROM_SERVER[name])).toBe(true);
  });

  it.each(INSTANCE_COLUMNS)('accepts the value the server takes on insert for %s', (name) => {
    // The same class instance is what the server accepted on INSERT, and the string DRZL asked
    // for was refused. Both halves measured; see the header.
    const f = mod.InserttSchema.shape[name];
    expect(accepts(f, FROM_SERVER[name])).toBe(true);
  });

  it('says outright that it cannot type them, naming the Gel type', () => {
    // The honest half of the fix. DRZL has no way to state "an instance of a class from a
    // package I cannot import", so it states nothing and warns, and the warning carries
    // `getSQLType()` so the column is identifiable. An absence reported as an absence.
    const warned = analysis.issues
      .filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')
      .map((i) => i.message);
    for (const name of INSTANCE_COLUMNS) {
      expect(
        warned.some((m) => m.includes(`"${name}"`)),
        `no unknown-column warning for ${name}`
      ).toBe(true);
    }
    // And the boolean is no longer among them, because it is now typed.
    expect(warned.some((m) => m.includes('"flag"'))).toBe(false);
    // The Gel type reaches the message, so the warning identifies the column type rather than
    // only the column name.
    expect(warned.join('\n')).toContain('cal::local_datetime');
  });
});

describe('the Gel columns that were already right', () => {
  // A control. Widening everything would pass every assertion above, and these fail if it does.
  it('keeps timestamptz a Date and refuses a string for it', () => {
    const f = mod.SelecttSchema.shape.tstz;
    expect(accepts(f, FROM_SERVER.tstz), 'a Date').toBe(true);
    expect(accepts(f, '2020-01-01T12:00:00Z'), 'a string').toBe(false);
  });

  it('keeps decimal a string and refuses a number for it', () => {
    // Gel's `decimal` really does arrive as a string, measured in the same row.
    const f = mod.SelecttSchema.shape.dec;
    expect(accepts(f, '12.34'), "'12.34'").toBe(true);
    expect(accepts(f, 12.34), '12.34').toBe(false);
  });

  it('keeps text a string and refuses a number for it', () => {
    const f = mod.SelecttSchema.shape.name;
    expect(accepts(f, 'hello'), "'hello'").toBe(true);
    expect(accepts(f, 42), '42').toBe(false);
  });
});
