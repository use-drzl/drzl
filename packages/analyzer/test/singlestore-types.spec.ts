import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';

describe('Analyzer SingleStore coarse type inference', () => {
  it('maps common SingleStore constructor names to ts types', async () => {
    const dir = path.resolve(__dirname, 'fixtures');
    await fs.mkdir(dir, { recursive: true });
    const schema = path.join(dir, 'singlestore-types.mjs');
    const code = `
class SingleStoreVarchar {}
class SingleStoreInt {}
class SingleStoreTinyInt {}
class SingleStoreSmallInt {}
class SingleStoreMediumInt {}
class SingleStoreSerial {}
class SingleStoreBigInt53 {}
class SingleStoreBigInt64 {}
class SingleStoreBoolean {}
class SingleStoreDecimal {}
class SingleStoreDouble {}
class SingleStoreReal {}
class SingleStoreDate {}
class SingleStoreDateTime {}
class SingleStoreTimestamp {}
class SingleStoreDateString {}
class SingleStoreDateTimeString {}
class SingleStoreTimestampString {}
class SingleStoreTime {}
class SingleStoreYear {}
class SingleStoreJson {}
class SingleStoreBlob {}
class SingleStoreBinary {}
class SingleStoreVarBinary {}
class SingleStoreVector {}

const table = {};
table[Symbol.for('drizzle:Name')] = 'things';
table[Symbol.for('drizzle:Columns')] = {
  id: new SingleStoreInt(),
  tiny: new SingleStoreTinyInt(),
  small: new SingleStoreSmallInt(),
  medium: new SingleStoreMediumInt(),
  serial: new SingleStoreSerial(),
  big53: new SingleStoreBigInt53(),
  big64: new SingleStoreBigInt64(),
  flag: new SingleStoreBoolean(),
  price: new SingleStoreDecimal(),
  dbl: new SingleStoreDouble(),
  rl: new SingleStoreReal(),
  name: new SingleStoreVarchar(),
  dateCol: new SingleStoreDate(),
  dtCol: new SingleStoreDateTime(),
  tsCol: new SingleStoreTimestamp(),
  dateStr: new SingleStoreDateString(),
  dtStr: new SingleStoreDateTimeString(),
  tsStr: new SingleStoreTimestampString(),
  timeCol: new SingleStoreTime(),
  yearCol: new SingleStoreYear(),
  payload: new SingleStoreJson(),
  bin: new SingleStoreBinary(),
  vbin: new SingleStoreVarBinary(),
  blob: new SingleStoreBlob(),
  vec: new SingleStoreVector(),
};

export { table as things };
`;
    await fs.writeFile(schema, code, 'utf8');
    const a = new SchemaAnalyzer(schema);
    const res = await a.analyze();
    const t = res.tables.find((t) => t.name === 'things');
    expect(t).toBeTruthy();
    const get = (n: string) => new Map(t!.columns.map((c) => [c.name, c.tsType])).get(n);
    expect(get('id')).toBe('number');
    expect(get('tiny')).toBe('number');
    expect(get('small')).toBe('number');
    expect(get('medium')).toBe('number');
    expect(get('serial')).toBe('number');
    expect(get('big53')).toBe('number');
    expect(get('big64')).toBe('bigint');
    expect(get('flag')).toBe('boolean');
    // `decimal()` with no mode builds a `SingleStoreDecimal`, and its driver value is a string.
    // The other two mode classes are not in this hand-written list at all, which is why
    // `decimal-modes.spec.ts` builds them from `singlestoreTable` instead.
    expect(get('price')).toBe('string');
    expect(get('dbl')).toBe('number');
    expect(get('rl')).toBe('number');
    expect(get('name')).toBe('string');
    expect(get('dateCol')).toBe('Date');
    expect(get('dtCol')).toBe('Date');
    expect(get('tsCol')).toBe('Date');
    expect(get('dateStr')).toBe('string');
    expect(get('dtStr')).toBe('string');
    expect(get('tsStr')).toBe('string');
    expect(get('timeCol')).toBe('string');
    expect(get('yearCol')).toBe('number');
    expect(get('payload')).toBe('any');
    expect(get('bin')).toBe('Uint8Array');
    expect(get('vbin')).toBe('Uint8Array');
    expect(get('blob')).toBe('Uint8Array');
    expect(get('vec')).toBe('any');
  });
});

