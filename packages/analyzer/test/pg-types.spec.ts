import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('Analyzer Postgres coarse type inference', () => {
  it('maps common Pg constructor names to ts types', async () => {
    const dir = path.resolve(__dirname, 'fixtures');
    await fs.mkdir(dir, { recursive: true });
    const schema = path.join(dir, 'pg-types.mjs');
    const code = `
class PgInteger {}
class PgSmallInt {}
class PgBigInt {}
class PgSerial {}
class PgSmallSerial {}
class PgBigSerial {}
class PgText {}
class PgVarchar {}
class PgChar {}
class PgUUID {}
class PgInet {}
class PgCidr {}
class PgMacaddr {}
class PgMacaddr8 {}
class PgPoint {}
class PgLine {}
class PgJson {}
class PgJsonb {}
class PgReal {}
class PgDoublePrecision {}
class PgNumeric {}
class PgDate {}
class PgDateString {}
class PgTimestamp {}
class PgTimestampString {}
class PgTimestamptz {}
class PgTime {}
class PgInterval {}

const table = {};
table[Symbol.for('drizzle:Name')] = 'pg_table';
table[Symbol.for('drizzle:Columns')] = {
  i: new PgInteger(),
  si: new PgSmallInt(),
  bi: new PgBigInt(),
  s: new PgSerial(),
  ss: new PgSmallSerial(),
  bs: new PgBigSerial(),
  t: new PgText(),
  v: new PgVarchar(),
  c: new PgChar(),
  u: new PgUUID(),
  inet: new PgInet(),
  cidr: new PgCidr(),
  mac: new PgMacaddr(),
  mac8: new PgMacaddr8(),
  p: new PgPoint(),
  l: new PgLine(),
  j: new PgJson(),
  jb: new PgJsonb(),
  r: new PgReal(),
  d: new PgDoublePrecision(),
  n: new PgNumeric(),
  dateCol: new PgDate(),
  dateStr: new PgDateString(),
  ts: new PgTimestamp(),
  tsStr: new PgTimestampString(),
  tstz: new PgTimestamptz(),
  timeCol: new PgTime(),
  ivl: new PgInterval(),
};

export { table as pg_table };
`;
    await fs.writeFile(schema, code, 'utf8');
    const a = new SchemaAnalyzer(schema);
    const res = await a.analyze();
    const t = res.tables.find((t) => t.name === 'pg_table');
    expect(t).toBeTruthy();
    const get = (n: string) => new Map(t!.columns.map((c) => [c.name, c.tsType])).get(n);
    expect(get('i')).toBe('number');
    expect(get('si')).toBe('number');
    expect(get('bi')).toBe('bigint');
    expect(get('s')).toBe('number');
    expect(get('ss')).toBe('number');
    expect(get('bs')).toBe('number');
    expect(get('t')).toBe('string');
    expect(get('v')).toBe('string');
    expect(get('c')).toBe('string');
    expect(get('u')).toBe('string');
    expect(get('inet')).toBe('string');
    expect(get('cidr')).toBe('string');
    expect(get('mac')).toBe('string');
    expect(get('mac8')).toBe('string');
    expect(get('p')).toBe('string');
    expect(get('l')).toBe('string');
    expect(get('j')).toBe('any');
    expect(get('jb')).toBe('any');
    expect(get('r')).toBe('number');
    expect(get('d')).toBe('number');
    expect(get('n')).toBe('number');
    expect(get('dateCol')).toBe('Date');
    expect(get('dateStr')).toBe('string');
    expect(get('ts')).toBe('Date');
    expect(get('tsStr')).toBe('string');
    expect(get('tstz')).toBe('Date');
    expect(get('timeCol')).toBe('string');
    expect(get('ivl')).toBe('string');
  });
});

