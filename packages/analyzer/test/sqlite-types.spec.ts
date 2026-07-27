import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('Analyzer SQLite coarse type inference', () => {
  it('maps common SQLite constructor names to ts types', async () => {
    const dir = path.resolve(__dirname, 'fixtures');
    await fs.mkdir(dir, { recursive: true });
    const schema = path.join(dir, 'sqlite-types.mjs');
    const code = `
class SQLiteInteger { constructor(){ this.config = {}; } }
class SQLiteText {}
class SQLiteReal {}
class SQLiteBlob {}
class SQLiteNumeric {}
class SQLiteBoolean {}

const tsInt = new SQLiteInteger();
tsInt.config.mode = 'timestamp';

const table = {};
table[Symbol.for('drizzle:Name')] = 'sq_table';
table[Symbol.for('drizzle:Columns')] = {
  i: new SQLiteInteger(),
  t: new SQLiteText(),
  r: new SQLiteReal(),
  b: new SQLiteBlob(),
  n: new SQLiteNumeric(),
  bool: new SQLiteBoolean(),
  createdAt: tsInt,
};

export { table as sq_table };
`;
    await fs.writeFile(schema, code, 'utf8');
    const a = new SchemaAnalyzer(schema);
    const res = await a.analyze();
    const t = res.tables.find((t) => t.name === 'sq_table');
    expect(t).toBeTruthy();
    const get = (n: string) => new Map(t!.columns.map((c) => [c.name, c.tsType])).get(n);
    expect(get('i')).toBe('number');
    expect(get('t')).toBe('string');
    expect(get('r')).toBe('number');
    expect(get('b')).toBe('Uint8Array');
    // numeric is a string, matching what Drizzle returns.
    expect(get('n')).toBe('string');
    expect(get('bool')).toBe('boolean');
    expect(get('createdAt')).toBe('Date');
  });
});

