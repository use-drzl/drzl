/**
 * An omitted column, checked against what the emitted schemas actually *do*.
 *
 * The unit tests assert on the narrowed `Analysis`, and the emitted text can be grepped, but
 * neither answers the question that matters: after `omit`, is the column genuinely gone from what
 * a parse hands back, or merely missing from a source file while the value still flows through?
 * Those are different, and which one you get is the validator's own policy about undeclared keys,
 * not DRZL's. So this runs the real analyzer over a real Drizzle schema, applies the real filter,
 * emits with the real generators, imports what was written, and parses a row that still carries
 * the omitted column.
 *
 * Two directories because two things have to resolve. The schema imports `drizzle-orm`, which
 * resolves from `packages/cli`; the emitted modules import `zod`, `valibot` and `arktype`, and the
 * one place all three resolve from is `packages/generator-trpc`. Both are `test/.tmp-*`, which is
 * gitignored for every package.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '@drzl/analyzer';
import type { Analysis } from '@drzl/analyzer';
import { ZodGenerator } from '@drzl/generator-zod';
import { ValibotGenerator } from '@drzl/generator-valibot';
import { ArkTypeGenerator } from '@drzl/generator-arktype';
import { filterColumns } from '../src/column-filter';

const SCHEMA_DIR = path.join(__dirname, '.tmp-column-filter-e2e');
const EMIT_DIR = path.join(
  __dirname,
  '..',
  '..',
  'generator-trpc',
  'test',
  `.tmp-column-filter-e2e-${process.pid}`
);

const SCHEMA = `
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  bio: text('bio'),
});
`;

/** A row as the database really hands it back: the omitted column is still in it. */
const ROW = { id: 1, email: 'ann@example.com', passwordHash: 'argon2:xxx', bio: null };

let warnings: string[] = [];
let zod: Record<string, any>;
let valibot: Record<string, any>;
let arktype: Record<string, any>;
let v: { parse: (schema: unknown, value: unknown) => unknown };
let emittedZodSource: string;
let emittedArkTypeSource: string;

beforeAll(async () => {
  await fs.rm(SCHEMA_DIR, { recursive: true, force: true });
  await fs.rm(EMIT_DIR, { recursive: true, force: true });
  await fs.mkdir(SCHEMA_DIR, { recursive: true });
  await fs.mkdir(EMIT_DIR, { recursive: true });

  const schemaFile = path.join(SCHEMA_DIR, 'schema.mjs');
  await fs.writeFile(schemaFile, SCHEMA, 'utf8');

  const analysis: Analysis = await new SchemaAnalyzer(
    path.relative(process.cwd(), schemaFile)
  ).analyze({});

  const narrowed = filterColumns(analysis.tables, { users: { omit: ['passwordHash'] } });
  warnings = narrowed.warnings;
  analysis.tables = narrowed.tables;

  await new ZodGenerator(analysis).generate({ outDir: EMIT_DIR } as never);
  await new ValibotGenerator(analysis).generate({ outDir: EMIT_DIR } as never);
  await new ArkTypeGenerator(analysis).generate({ outDir: EMIT_DIR } as never);

  // valibot is reached through a file in the emitted directory rather than imported here: this
  // package does not depend on it, and the emitted module resolves it from exactly this location.
  await fs.writeFile(path.join(EMIT_DIR, 'valibot-runtime.mjs'), `export * from 'valibot';\n`);

  emittedZodSource = await fs.readFile(path.join(EMIT_DIR, 'users.zod.ts'), 'utf8');
  emittedArkTypeSource = await fs.readFile(path.join(EMIT_DIR, 'users.arktype.ts'), 'utf8');
  zod = await import(path.join(EMIT_DIR, 'users.zod.ts'));
  valibot = await import(path.join(EMIT_DIR, 'users.valibot.ts'));
  arktype = await import(path.join(EMIT_DIR, 'users.arktype.ts'));
  v = (await import(path.join(EMIT_DIR, 'valibot-runtime.mjs'))) as never;
}, 120_000);

afterAll(async () => {
  await fs.rm(SCHEMA_DIR, { recursive: true, force: true });
  await fs.rm(EMIT_DIR, { recursive: true, force: true });
});

describe('the analysis the generators were handed', () => {
  it('warns that the database requires the column that was dropped', () => {
    expect(warnings.join('\n')).toMatch(/passwordHash/);
    expect(warnings.join('\n')).toMatch(/NOT NULL/);
  });
});

describe('the emitted zod module', () => {
  it('does not mention the column at all', () => {
    expect(emittedZodSource).not.toMatch(/passwordHash/);
    // The columns that were kept are still there, so this is a narrowing and not an empty file.
    expect(emittedZodSource).toMatch(/email/);
    expect(emittedZodSource).toMatch(/bio/);
  });

  it('drops the key from a parsed select row, rather than passing it through', () => {
    const out = zod.SelectusersSchema.parse(ROW);
    expect(Object.keys(out).sort()).toEqual(['bio', 'email', 'id']);
    expect('passwordHash' in out).toBe(false);
  });

  it('drops it from a parsed insert payload', () => {
    const out = zod.InsertusersSchema.parse({ id: 1, email: 'a@b.c', passwordHash: 'x' });
    expect('passwordHash' in out).toBe(false);
    expect(out.email).toBe('a@b.c');
  });

  it('drops it from a parsed update payload', () => {
    const out = zod.UpdateusersSchema.parse({ email: 'a@b.c', passwordHash: 'x' });
    expect('passwordHash' in out).toBe(false);
    expect(out.email).toBe('a@b.c');
  });

  it('still accepts a row that does not carry it', () => {
    expect(zod.SelectusersSchema.safeParse({ id: 1, email: 'a@b.c', bio: null }).success).toBe(
      true
    );
  });
});

describe('the emitted valibot module', () => {
  it('drops the key from a parsed select row', () => {
    const out = v.parse(valibot.SelectusersSchema, ROW) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['bio', 'email', 'id']);
  });

  it('drops it from a parsed insert payload', () => {
    const out = v.parse(valibot.InsertusersSchema, {
      id: 1,
      email: 'a@b.c',
      passwordHash: 'x',
    }) as Record<string, unknown>;
    expect('passwordHash' in out).toBe(false);
  });

  it('drops it from a parsed update payload', () => {
    const out = v.parse(valibot.UpdateusersSchema, {
      email: 'a@b.c',
      passwordHash: 'x',
    }) as Record<string, unknown>;
    expect('passwordHash' in out).toBe(false);
  });
});

describe('the emitted arktype module', () => {
  /**
   * Measured rather than asserted from the docs, and recorded because it is the one answer that
   * differs. arktype's default for an undeclared key is to leave it where it is: the schema no
   * longer *describes* the column, and a value carrying it still validates and comes back
   * carrying it. That is arktype's policy about undeclared keys and not something DRZL sets, so
   * the honest thing is to state which half of the guarantee holds.
   */
  it('no longer describes the column', () => {
    expect(emittedArkTypeSource).not.toMatch(/passwordHash/);
    expect(emittedArkTypeSource).toMatch(/email/);
  });

  it('says whether the value survives a parse', () => {
    const out = arktype.SelectusersSchema(ROW) as Record<string, unknown>;
    // Whichever it is, it is written down. A change here is a change in arktype's behaviour and
    // should be read as one rather than silently absorbed.
    expect('passwordHash' in out).toBe(true);
  });
});
