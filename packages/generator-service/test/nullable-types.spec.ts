/**
 * Nullable columns in the generated service types.
 *
 * These were emitted as optional, `balance?: number`, which admits `undefined` and not `null`.
 * A nullable column can be null: reading a row back failed to match `Select<T>`, and passing
 * `null` to update was a type error. The validation generators had it right all along, emitting
 * `z.number().nullable()`, so the two halves of the same generated project disagreed.
 *
 * Optional and nullable are different things and a column can be either, both, or neither:
 *
 *   nullable         -> the value may be null
 *   has a default    -> the key may be absent on insert
 *   generated        -> the key must be absent on insert
 */
import { describe, it, expect } from 'vitest';
import { ServiceGenerator } from '../src';
import type { Analysis } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const col = (name: string, tsType: string, extra: Record<string, unknown> = {}) => ({
  name,
  tsType,
  dbType: tsType === 'number' ? 'REAL' : 'TEXT',
  nullable: false,
  hasDefault: false,
  isGenerated: false,
  ...extra,
});

const analysis: Analysis = {
  dialect: 'sqlite',
  tables: [
    {
      name: 'users',
      tsName: 'users',
      columns: [
        col('id', 'number', { isGenerated: true, hasDefault: true }),
        col('email', 'string'), // required, not nullable
        col('balance', 'number', { nullable: true }), // nullable, no default
        col('nickname', 'string', { nullable: true, hasDefault: true }), // nullable AND defaulted
        col('country', 'string', { hasDefault: true }), // defaulted, not nullable
      ],
      primaryKey: { columns: ['id'] },
      unique: [],
      indexes: [],
    },
  ] as any,
  enums: [],
  relations: [],
  issues: [],
};

async function emitted(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-svc-'));
  await new ServiceGenerator(analysis).generate({ outDir } as any);
  // The interfaces live in types/<table>.ts. Matching loosely on the table name also hits
  // userService.ts, which declares none of them.
  return fs.readFile(path.join(outDir, 'types', 'users.ts'), 'utf8');
}

/** The declared type of one field inside one interface. */
function fieldOf(source: string, iface: string, field: string): string {
  const block = source.match(new RegExp(`interface ${iface}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1];
  expect(block, `no interface ${iface} in:\n${source}`).toBeTruthy();
  const line = block!.split('\n').find((l) => new RegExp(`\\b${field}\\??\\s*:`).test(l));
  expect(line, `no field ${field} in interface ${iface}:\n${block}`).toBeTruthy();
  return line!.trim().replace(/;$/, '');
}

describe('Select', () => {
  it('types a nullable column as nullable, and keeps it required', async () => {
    // Every column is present on a row read back. Nullable means the value may be null, which
    // is not the same as the key being absent, so `balance?: number` was wrong twice over.
    expect(fieldOf(await emitted(), 'Selectusers', 'balance')).toBe('balance: number | null');
  });

  it('leaves a non-nullable column alone', async () => {
    expect(fieldOf(await emitted(), 'Selectusers', 'email')).toBe('email: string');
  });

  it('does not make a defaulted column optional, since it is always present once read', async () => {
    expect(fieldOf(await emitted(), 'Selectusers', 'country')).toBe('country: string');
  });
});

describe('Insert', () => {
  it('makes a nullable column optional and admits null', async () => {
    expect(fieldOf(await emitted(), 'Insertusers', 'balance')).toBe('balance?: number | null');
  });

  it('makes a defaulted column optional without admitting null', async () => {
    expect(fieldOf(await emitted(), 'Insertusers', 'country')).toBe('country?: string');
  });

  it('keeps a required column required', async () => {
    expect(fieldOf(await emitted(), 'Insertusers', 'email')).toBe('email: string');
  });

  it('omits the generated primary key', async () => {
    const source = await emitted();
    const block = source.match(/interface Insertusers\b[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(block).not.toMatch(/\bid\??\s*:/);
  });
});

describe('Update', () => {
  it('makes every column optional and admits null where the column is nullable', async () => {
    const source = await emitted();
    expect(fieldOf(source, 'Updateusers', 'balance')).toBe('balance?: number | null');
    expect(fieldOf(source, 'Updateusers', 'email')).toBe('email?: string');
  });

  it('handles a column that is both nullable and defaulted', async () => {
    expect(fieldOf(await emitted(), 'Updateusers', 'nickname')).toBe('nickname?: string | null');
  });
});
