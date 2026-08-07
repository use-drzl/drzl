/**
 * The two SQLite classes the 0.4x class-name path could not name.
 *
 * Both came back `unknown`, so every generator emitted a schema that accepts any value at all,
 * and on TypeBox a nullable one also let the key go missing from a select row. v1 answers both
 * correctly from its `dataType`, so these expectations are v1's own answers rather than new
 * opinions, and the last test here asserts that by analyzing the same source under both majors.
 *
 * Measured against drizzle's own mappers on 0.45.2 rather than inferred from the class names:
 *
 *   blob({ mode: 'buffer' })       SQLiteBlobBuffer   mapFromDriverValue hands back a Buffer
 *   blob()                         SQLiteBlobBuffer   the same class, so the same answer
 *   integer({ mode: 'timestamp' })     SQLiteTimestamp   hands back a Date
 *   integer({ mode: 'timestamp_ms' })  SQLiteTimestamp   hands back a Date
 *
 * The two integer modes are one class and one type. They differ in the scale of the number on
 * the wire, seconds against milliseconds, which `mapFromDriverValue` consumes and no validator
 * ever sees, so an arm keyed on the class covers both and an arm keyed on the mode string could
 * not. The old code was keyed on the mode string and named only `timestamp`.
 *
 * A bare `blob()` is `SQLiteBlobBuffer` on 0.45.2 and `SQLiteBlobJson` on 1.0.0-rc.4, so the two
 * majors genuinely disagree about that one column and DRZL repeats each of them. That is why the
 * cross-major assertion below names the explicit modes only.
 */
import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function analysed(mod: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-sqlite-blob-'));
  const file = path.join(dir, 'schema.mjs');
  await fs.writeFile(
    file,
    `
import { sqliteTable, blob, integer } from '${mod}';
export const t = sqliteTable('t', {
  s_blob: blob('s_blob'),
  s_blob_buf: blob('s_blob_buf', { mode: 'buffer' }),
  s_blob_json: blob('s_blob_json', { mode: 'json' }),
  s_blob_bigint: blob('s_blob_bigint', { mode: 'bigint' }),
  s_int: integer('s_int'),
  s_int_ts: integer('s_int_ts', { mode: 'timestamp' }),
  s_int_ts_ms: integer('s_int_ts_ms', { mode: 'timestamp_ms' }),
  s_int_bool: integer('s_int_bool', { mode: 'boolean' }),
});
`,
    'utf8'
  );
  const res = await new SchemaAnalyzer(file).analyze();
  return {
    byName: new Map(res.tables[0].columns.map((c) => [c.name, c])),
    issues: res.issues,
  };
}

const OLD = 'drizzle-orm/sqlite-core';
const NEW = 'drizzle-orm-v1/sqlite-core';

describe('a SQLite buffer blob on drizzle-orm 0.4x', () => {
  it('describes blob({ mode: buffer }) as the Buffer the driver hands back', async () => {
    const { byName } = await analysed(OLD);
    expect(byName.get('s_blob_buf')?.tsType).toBe('Buffer');
    expect(byName.get('s_blob_buf')?.dbType).toBe('BYTEA');
    expect(byName.get('s_blob_buf')?.shape).toEqual({ kind: 'buffer' });
  });

  it('describes a bare blob() the same way, because 0.4x builds the same class', async () => {
    const { byName } = await analysed(OLD);
    expect(byName.get('s_blob')?.shape).toEqual({ kind: 'buffer' });
  });

  it('leaves the other two blob modes alone', async () => {
    const { byName } = await analysed(OLD);
    expect(byName.get('s_blob_json')?.shape).toEqual({ kind: 'json' });
    expect(byName.get('s_blob_bigint')?.tsType).toBe('bigint');
  });
});

describe('a SQLite timestamp integer on drizzle-orm 0.4x', () => {
  it('describes mode timestamp_ms as a Date, which mode timestamp already was', async () => {
    const { byName } = await analysed(OLD);
    expect(byName.get('s_int_ts_ms')?.tsType).toBe('Date');
    expect(byName.get('s_int_ts')?.tsType).toBe('Date');
  });

  it('gives the two modes the same SQL label, since they are one class', async () => {
    const { byName } = await analysed(OLD);
    expect(byName.get('s_int_ts_ms')?.dbType).toBe(byName.get('s_int_ts')?.dbType);
  });

  it('leaves a plain and a boolean integer alone', async () => {
    const { byName } = await analysed(OLD);
    expect(byName.get('s_int')?.tsType).toBe('number');
    expect(byName.get('s_int_bool')?.tsType).toBe('boolean');
  });
});

describe('the untyped-column warning', () => {
  it('names none of these columns on 0.4x any more', async () => {
    const { issues } = await analysed(OLD);
    const warned = issues
      .filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN')
      .map((i) => i.message.match(/"(\w+)"/)?.[1]);
    expect(warned).toEqual([]);
  });
});

describe('the two majors', () => {
  it('describe the two explicit modes identically', async () => {
    const [oldSide, newSide] = await Promise.all([analysed(OLD), analysed(NEW)]);
    for (const name of ['s_blob_buf', 's_int_ts', 's_int_ts_ms']) {
      expect(oldSide.byName.get(name), `${name} on 0.4x`).toEqual(newSide.byName.get(name));
    }
  });
});
