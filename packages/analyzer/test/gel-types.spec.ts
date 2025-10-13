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
    expect(get('ts')).toBe('string');
    expect(get('tstz')).toBe('Date');
    expect(get('ld')).toBe('string');
    expect(get('lt')).toBe('string');
    expect(get('dd')).toBe('string');
    expect(get('rd')).toBe('string');
    expect(get('d')).toBe('string');
  });
});

