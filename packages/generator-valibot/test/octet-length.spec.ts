/**
 * `CHECK (octet_length(col) <= 5)` in valibot output.
 *
 * See the zod generator's file of the same name for the PGlite measurements this is written
 * against. The row that matters is two emoji: two characters and eight bytes, refused by Postgres
 * and accepted by any cap that counts characters.
 */
import { describe, it, expect } from 'vitest';
import { ValibotGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import * as v from 'valibot';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const GRIN = '\u{1F600}';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const blob = (name = 'blob') =>
  col(name, { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never });

let seq = 0;
let lastFile = '';

async function schemasFor(columns: Column[], checks: unknown[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-octets');
  await fs.mkdir(dir, { recursive: true });
  await new ValibotGenerator(analysis).generate({ outDir: dir } as never);
  lastFile = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.valibot.ts'), lastFile);
  return await import(lastFile);
}

const ok = (schema: any, value: unknown) => v.safeParse(schema, value).success;

describe('a byte budget on a text column', () => {
  it('accepts and refuses exactly what Postgres did', async () => {
    const m = await schemasFor([col('body')], [{ expression: 'octet_length(body) <= 5' }]);
    expect(ok(m.SelecttSchema, { body: 'hello' }), 'five ascii').toBe(true);
    expect(ok(m.SelecttSchema, { body: 'hellos' }), 'six ascii').toBe(false);
    expect(ok(m.SelecttSchema, { body: GRIN }), 'one emoji, four bytes').toBe(true);
    expect(ok(m.SelecttSchema, { body: GRIN.repeat(2) }), 'two emoji, eight bytes').toBe(false);
  });

  it('names the constraint in the failure, exactly as the ledger records it', async () => {
    const m = await schemasFor(
      [col('body')],
      [{ name: 'body_bytes', expression: 'octet_length(body) <= 5' }]
    );
    const r = v.safeParse(m.SelecttSchema, { body: 'hellos' });
    expect(r.success).toBe(false);
    expect(r.issues![0].message).toBe('body_bytes: octet_length(body) <= 5');
  });
});

describe('a byte budget on a bytea column', () => {
  it('counts the array, which is what Postgres counted', async () => {
    const m = await schemasFor([blob()], [{ expression: 'octet_length(blob) <= 5' }]);
    expect(ok(m.SelecttSchema, { blob: new Uint8Array(5) })).toBe(true);
    expect(ok(m.SelecttSchema, { blob: new Uint8Array(6) })).toBe(false);
  });

  it('pipes the count onto the shaped schema rather than replacing it', async () => {
    const m = await schemasFor([blob()], [{ expression: 'octet_length(blob) <= 5' }]);
    // The instance check survives, so a string of five characters is still not a bytea.
    expect(ok(m.SelecttSchema, { blob: 'hello' })).toBe(false);
    expect(await fs.readFile(lastFile, 'utf8')).toContain('v.instance(Uint8Array)');
  });
});

describe('a byte budget on a column that cannot answer one', () => {
  it('emits nothing for a MySQL varbinary', async () => {
    const bin = col('bin', {
      dbType: 'VARBINARY',
      shape: { kind: 'byteString', length: 8 } as never,
    });
    await schemasFor([bin], [{ expression: 'octet_length(bin) <= 5' }]);
    expect(await fs.readFile(lastFile, 'utf8')).not.toContain('octet_length(bin)');
  });
});
