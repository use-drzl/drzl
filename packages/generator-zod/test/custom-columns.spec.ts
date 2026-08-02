/**
 * `customType` columns.
 *
 * A custom column carries nothing checkable at runtime. `getSQLType()` reports the declared SQL
 * type, but that is the database side: `fromDriver` may map it to anything, so a
 * `numeric(12,2)` custom column can hand back a `number` where a plain numeric hands back a
 * string. Guessing from the SQL type would reject the real value, which is the failure mode this
 * package keeps finding, so nothing is guessed.
 *
 * What can be recovered is the *type*, from Drizzle's own inference. `drizzle-orm/zod` recovers
 * neither: it emits `z.any()`, which loses the type and also loses the narrowing that `unknown`
 * would force at the call site.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'unknown',
    dbType: 'NUMERIC(12,2)',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    shape: { kind: 'custom', sqlType: 'numeric(12,2)' },
    ...over,
  }) as Column;

async function emit(typedJson: boolean): Promise<string> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [
      { name: 't', tsName: 't', columns: [col('balance')], unique: [], indexes: [], checks: [] },
    ] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-custom-'));
  await new ZodGenerator(analysis).generate({
    outDir: dir,
    // `schemaPath` is what `typedJson` needs in order to import the table back and reference the
    // type Drizzle inferred for the column.
    ...(typedJson ? { typedJson: true, schemaPath: path.join(dir, '..', 'db', 'schema.ts') } : {}),
  } as never);
  const src = await fs.readFile(path.join(dir, 't.zod.ts'), 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return src;
}

describe('by default', () => {
  it('emits unknown rather than a guess from the SQL type', async () => {
    const src = await emit(false);
    expect(src).toContain('z.unknown()');
    // The declared SQL type is `numeric`, which a plain numeric column maps to a string. Emitting
    // that here would reject the number this column really carries.
    expect(src).not.toContain('z.string()');
    expect(src).not.toContain('z.number()');
  });

  it('does not emit any(), which is what the official module uses', async () => {
    // `unknown` and `any` accept the same values; only `unknown` forces the caller to narrow.
    const src = await emit(false);
    expect(src).not.toContain('z.any()');
  });
});

describe('with typedJson', () => {
  it('takes the type from Drizzle rather than inventing one', async () => {
    const src = await emit(true);
    // Quote style is prettier's to decide, so the assertion accepts either.
    expect(src).toMatch(/z\.custom<\(typeof t\.\$inferSelect\)\[['"]balance['"]\]>\(\)/);
    expect(src).toMatch(/z\.custom<\(typeof t\.\$inferInsert\)\[['"]balance['"]\]>\(\)/);
    // Insert and select reference their own inference, since the two can differ.
    expect(src).toMatch(/import type \{ t \} from ['"][^'"]*schema\.js['"]/);
  });
});
