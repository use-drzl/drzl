import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaAnalyzer } from '../src/index';

// This test simulates MySQL column classes by name and ensures
// the analyzer's coarse MySQL inference does not return `unknown`.
describe('Analyzer MySQL coarse type inference', () => {
  it('maps common MySQL column constructors to ts types', async () => {
    const dir = path.resolve(__dirname, 'fixtures');
    await fs.mkdir(dir, { recursive: true });
    const schema = path.join(dir, 'mysql-types.mjs');
    const code = `
// Simulate a Drizzle table-like export with MySQL column constructor names
class MySqlVarchar {}
class MySqlInt {}
class MySqlBigInt53 {}
class MySqlBigInt64 {}
class MySqlBoolean {}
class MySqlTimestamp {}
class MySqlTimestampString {}
class MySqlDate {}
class MySqlDateString {}
class MySqlDateTime {}
class MySqlDateTimeString {}
class MySqlTime {}
class MySqlYear {}
class MySqlJson {}
class MySqlBlob {}
class MySqlBinary {}
class MySqlVarBinary {}
class MySqlDouble {}
class MySqlReal {}

const table = {};
table[Symbol.for('drizzle:Name')] = 'users_table';
table[Symbol.for('drizzle:Columns')] = {
  id: new MySqlInt(),
  name: new MySqlVarchar(),
  age: new MySqlInt(),
  isActive: new MySqlBoolean(),
  createdAt: new MySqlTimestamp(),
  createdAtStr: new MySqlTimestampString(),
  dateCol: new MySqlDate(),
  dateStr: new MySqlDateString(),
  dtCol: new MySqlDateTime(),
  dtStr: new MySqlDateTimeString(),
  timeCol: new MySqlTime(),
  yearCol: new MySqlYear(),
  big53: new MySqlBigInt53(),
  big64: new MySqlBigInt64(),
  dbl: new MySqlDouble(),
  rl: new MySqlReal(),
  payload: new MySqlJson(),
  data: new MySqlBlob(),
  bin: new MySqlBinary(),
  vbin: new MySqlVarBinary(),
};

export { table as users };
`;
    await fs.writeFile(schema, code, 'utf8');
    const a = new SchemaAnalyzer(schema);
    const res = await a.analyze();
    const t = res.tables.find((t) => t.name === 'users_table');
    expect(t).toBeTruthy();
    const map = new Map(t!.columns.map((c) => [c.name, c.tsType]));
    expect(map.get('id')).toBe('number');
    expect(map.get('name')).toBe('string');
    expect(map.get('age')).toBe('number');
    expect(map.get('isActive')).toBe('boolean');
    expect(map.get('createdAt')).toBe('Date');
    expect(map.get('createdAtStr')).toBe('string');
    expect(map.get('dateCol')).toBe('Date');
    expect(map.get('dateStr')).toBe('string');
    expect(map.get('dtCol')).toBe('Date');
    expect(map.get('dtStr')).toBe('string');
    expect(map.get('timeCol')).toBe('string');
    expect(map.get('yearCol')).toBe('number');
    expect(map.get('big53')).toBe('number');
    expect(map.get('big64')).toBe('bigint');
    expect(map.get('dbl')).toBe('number');
    expect(map.get('rl')).toBe('number');
    expect(map.get('payload')).toBe('any');
    expect(map.get('data')).toBe('Uint8Array');
    expect(map.get('bin')).toBe('Uint8Array');
    expect(map.get('vbin')).toBe('Uint8Array');
  });
});
