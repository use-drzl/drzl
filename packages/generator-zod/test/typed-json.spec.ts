/**
 * Typing json columns from the schema.
 *
 * `.$type<T>()` is a compile-time cast. Drizzle's implementation is `$type() { return this }`, so
 * nothing about the declared type survives to runtime and every runtime-derived validator is
 * blind to it: `drizzle-orm/zod` types a json column as its generic `Json` no matter what you
 * wrote. It is the highest-reaction open issue on that repo.
 *
 * A generator can do better without resolving any types itself, because Drizzle already did the
 * work. `typeof settings.$inferSelect['prefs']` *is* the declared type, resolved by TypeScript at
 * the point of use, which is why this handles generics, unions and imported interfaces alike:
 * the cases that defeat approaches which parse the source and try to rebuild the type.
 *
 * That the emitted type is genuinely precise rather than `any` is proved by compiling it, in the
 * end-to-end fixture rather than here, since only a real tsc can answer that.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'any',
    dbType: 'JSON',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

async function emit(opts: Record<string, unknown>, columns?: Column[]) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [
      {
        name: 'settings',
        tsName: 'settings',
        columns: columns ?? [col('prefs'), col('name', { tsType: 'string', dbType: 'TEXT' })],
        unique: [],
        indexes: [],
      },
    ] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-tj-'));
  await new ZodGenerator(analysis).generate({ outDir, ...opts } as never);
  return fs.readFile(path.join(outDir, 'settings.zod.ts'), 'utf8');
}

describe('when off, which is the default', () => {
  it('leaves json wide and imports nothing from the schema', async () => {
    const src = await emit({ schemaPath: 'src/db/schema.ts' });
    expect(src).toContain('z.any()');
    expect(src).not.toContain('$infer');
    expect(src).not.toMatch(/import type \{ settings \}/);
  });
});

describe('when on', () => {
  it('references the type Drizzle inferred rather than restating it', async () => {
    const src = await emit({ typedJson: true, schemaPath: 'src/db/schema.ts' });
    expect(src).toMatch(/z\.custom<\(typeof settings\.\$inferSelect\)\["prefs"\]>\(\)/);
    expect(src).not.toContain('z.any()');
  });

  it('uses the insert inference for insert and update, which can differ', async () => {
    // A json column with a default is optional on insert, so its inferred type is not the same
    // as on select. Using one for both would be subtly wrong.
    const src = await emit({ typedJson: true, schemaPath: 'src/db/schema.ts' });
    const insert = src.match(/InsertsettingsSchema[\s\S]*?\n\}\)/)![0];
    const select = src.match(/SelectsettingsSchema[\s\S]*?\n\}\)/)![0];
    expect(insert).toContain('$inferInsert');
    expect(select).toContain('$inferSelect');
  });

  it('imports the table type-only, so nothing is added at runtime', async () => {
    const src = await emit({ typedJson: true, schemaPath: 'src/db/schema.ts' });
    // `import type` is erased at build time, so this cannot create a runtime cycle between the
    // validators and the schema.
    expect(src).toMatch(/^import type \{ settings \} from/m);
  });

  it('spells the schema specifier so it resolves from the output directory', async () => {
    const src = await emit({ typedJson: true, schemaPath: 'src/db/schema.ts' });
    const spec = src.match(/import type \{ settings \} from ['"]([^'"]+)['"]/)![1];
    expect(spec.startsWith('.'), `expected a relative specifier, got ${spec}`).toBe(true);
    expect(spec).toMatch(/\.js$/);
  });

  it('leaves columns that already have a real type alone', async () => {
    const src = await emit({ typedJson: true, schemaPath: 'src/db/schema.ts' });
    // Prettier drops the quotes around a key that is a valid identifier.
    expect(src).toMatch(/"?name"?:\s*z\.string\(\)/);
  });

  it('does nothing, and says so, when the schema path is unknown', async () => {
    // Without it there is nothing to import, and silently emitting the wide type would leave
    // the user wondering why the option did not take.
    const warn = console.warn;
    const seen: string[] = [];
    console.warn = (m?: unknown) => void seen.push(String(m));
    try {
      const src = await emit({ typedJson: true });
      expect(src).toContain('z.any()');
      expect(seen.join(' ')).toMatch(/typedJson/);
    } finally {
      console.warn = warn;
    }
  });
});
