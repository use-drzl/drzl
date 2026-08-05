/**
 * The `/^Gel/i` name-matching arm, driven by hand-written classes.
 *
 * This file is deliberately NOT the coverage that matters. It builds a table out of
 * `class GelInteger {}` and friends, so all it can ever show is that the arm agrees with a class
 * list someone typed out, and a type drizzle ships that nobody thought to type out is invisible
 * to it: `GelBoolean` was missing here for exactly that reason, and a real `boolean()` column
 * came back `unknown`. `uncovered-dialects.spec.ts` runs the same arm against a real `gelTable`
 * and is where an expectation traced to a live server lives. What is left here is the ordering
 * of the regexes, which a class list does exercise: `GelTimestampTz` must not be caught by the
 * `Timestamp` case, and `GelLocalDateString` must not be caught by the `Text` one.
 */
import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('Analyzer Gel (EdgeDB) coarse type inference', () => {
  it('maps common Gel constructor names to ts types', async () => {
    const dir = path.resolve(__dirname, 'fixtures');
    await fs.mkdir(dir, { recursive: true });
    const schema = path.join(dir, 'gel-types.mjs');
    const code = `
class GelInteger {}
class GelSmallInt {}
class GelInt53 {}
class GelBigInt64 {}
class GelText {}
class GelUUID {}
class GelJson {}
class GelReal {}
class GelDoublePrecision {}
class GelDecimal {}
class GelBytes {}
class GelBoolean {}
class GelTimestamp {}
class GelTimestampTz {}
class GelLocalDateString {}
class GelLocalTime {}
class GelDateDuration {}
class GelRelDuration {}
class GelDuration {}

const table = {};
table[Symbol.for('drizzle:Name')] = 'gel_table';
table[Symbol.for('drizzle:Columns')] = {
  i: new GelInteger(),
  si: new GelSmallInt(),
  i53: new GelInt53(),
  bi64: new GelBigInt64(),
  t: new GelText(),
  u: new GelUUID(),
  j: new GelJson(),
  r: new GelReal(),
  dp: new GelDoublePrecision(),
  dec: new GelDecimal(),
  b: new GelBytes(),
  flag: new GelBoolean(),
  ts: new GelTimestamp(),
  tstz: new GelTimestampTz(),
  ld: new GelLocalDateString(),
  lt: new GelLocalTime(),
  dd: new GelDateDuration(),
  rd: new GelRelDuration(),
  d: new GelDuration(),
};

export { table as gel_table };
`;
    await fs.writeFile(schema, code, 'utf8');
    const a = new SchemaAnalyzer(schema);
    const res = await a.analyze();
    const t = res.tables.find((t) => t.name === 'gel_table');
    expect(t).toBeTruthy();
    const get = (n: string) => new Map(t!.columns.map((c) => [c.name, c.tsType])).get(n);
    expect(get('i')).toBe('number');
    expect(get('si')).toBe('number');
    expect(get('i53')).toBe('number');
    expect(get('bi64')).toBe('bigint');
    expect(get('t')).toBe('string');
    expect(get('u')).toBe('string');
    expect(get('j')).toBe('any');
    expect(get('r')).toBe('number');
    expect(get('dp')).toBe('number');
    expect(get('dec')).toBe('string');
    expect(get('b')).toBe('Uint8Array');
    expect(get('flag')).toBe('boolean');
    // `GelTimestampTz` is a `Date` and must be matched before the `Timestamp` case, which is why
    // both are here and not just one.
    expect(get('tstz')).toBe('Date');
    // The `cal::` and duration family. Each one's value is an instance of a class from the `gel`
    // package, which DRZL cannot import and therefore cannot check; see the live-server
    // measurement in `uncovered-dialects.spec.ts` for what each one really returns.
    expect(get('ts')).toBe('unknown');
    expect(get('ld')).toBe('unknown');
    expect(get('lt')).toBe('unknown');
    expect(get('dd')).toBe('unknown');
    expect(get('rd')).toBe('unknown');
    expect(get('d')).toBe('unknown');
  });
});

