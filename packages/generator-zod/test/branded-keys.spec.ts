/**
 * Branded primary and foreign keys.
 *
 * The feature is entirely type-level, so the assertions here split cleanly in two and neither
 * half can stand in for the other:
 *
 *   the text     where `.brand()` lands in the chain, which is the only decision that can be
 *                wrong in a way that compiles. Placing it after `.nullable()` deletes the null
 *                arm from the inferred type, measured on zod 4.4.3, and no parse would notice.
 *
 *   the run      that parsing is *unchanged*. A brand that altered what a schema accepts would
 *                be a validation change wearing a type feature's name.
 *
 * The proof that a `posts.id` is refused where a `users.id` is wanted needs `tsc` and lives in
 * `test/branded-keys.types.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'number',
    dbType: 'INTEGER',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const table = (tsName: string, over: Partial<Table> = {}): Table =>
  ({ name: tsName, tsName, columns: [], unique: [], indexes: [], checks: [], ...over }) as Table;

/** users(id PK, email), posts(id PK, authorId -> users.id, title) */
function schema(over: { authorNullable?: boolean } = {}): Table[] {
  return [
    table('users', {
      columns: [col('id'), col('email', { tsType: 'string', dbType: 'TEXT' })],
      primaryKey: { columns: ['id'] },
    }),
    table('posts', {
      columns: [
        col('id'),
        col('authorId', {
          nullable: !!over.authorNullable,
          references: { table: 'users', column: 'id' },
        }),
        col('title', { tsType: 'string', dbType: 'TEXT' }),
      ],
      primaryKey: { columns: ['id'] },
    }),
  ];
}

async function emit(
  tables: Table[],
  opts: Record<string, unknown>
): Promise<Record<string, string>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: tables as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-branded-'));
  await new ZodGenerator(analysis).generate({ outDir: dir, ...opts } as never);
  const out: Record<string, string> = {};
  for (const t of tables)
    out[t.tsName] = await fs.readFile(path.join(dir, `${t.tsName}.zod.ts`), 'utf8');
  await fs.rm(dir, { recursive: true, force: true });
  return out;
}

/** The one field's expression, collapsed to a single line the way it would be written by hand. */
const field = (src: string, schemaName: string, name: string): string => {
  // `z\n  .object({` when prettier wraps the chain, which it does as soon as `.meta()` is on it.
  const block =
    src.match(new RegExp(`${schemaName} = z\\s*\\.object\\(\\{([\\s\\S]*?)\\n\\s*\\}\\)`))?.[1] ??
    '';
  const flat = block.replace(/\s+/g, ' ').replace(/\s+\./g, '.').replace(/\(\s+/g, '(');
  const at = flat.indexOf(`${name}: `);
  if (at === -1) return '';
  let i = at + `${name}: `.length;
  let depth = 0;
  const from = i;
  for (; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) break;
  }
  return flat.slice(from, i).trim();
};

describe('what the emitted schema says', () => {
  it('brands nothing unless asked', async () => {
    const out = await emit(schema(), {});
    expect(out.users).not.toContain('.brand<');
    expect(out.posts).not.toContain('.brand<');
  });

  it('brands a primary key with its own token', async () => {
    const out = await emit(schema(), { branded: true });
    expect(field(out.users, 'SelectusersSchema', 'id')).toBe(
      "z.number().int().brand<'users.id'>()"
    );
  });

  it('brands a foreign key with the token of the table it points at', async () => {
    const out = await emit(schema(), { branded: true });
    expect(field(out.posts, 'SelectpostsSchema', 'authorId')).toBe(
      "z.number().int().brand<'users.id'>()"
    );
  });

  it('leaves an ordinary column alone', async () => {
    const out = await emit(schema(), { branded: true });
    expect(field(out.posts, 'SelectpostsSchema', 'title')).toBe('z.string()');
  });

  it('brands the insert and update schemas too', async () => {
    const out = await emit(schema(), { branded: true });
    expect(field(out.posts, 'InsertpostsSchema', 'authorId')).toContain(".brand<'users.id'>()");
    expect(field(out.posts, 'UpdatepostsSchema', 'authorId')).toContain(".brand<'users.id'>()");
  });

  it('puts the brand inside the nullable wrapper, not outside it', async () => {
    // The order that matters. `.nullable().brand()` infers `number & $brand<'users.id'>` on zod
    // 4.4.3, with the null arm silently gone, while the schema still parses null.
    const out = await emit(schema({ authorNullable: true }), { branded: true });
    expect(field(out.posts, 'SelectpostsSchema', 'authorId')).toBe(
      "z.number().int().brand<'users.id'>().nullable()"
    );
  });

  it('puts the brand inside the optional wrapper as well', async () => {
    const out = await emit(schema(), { branded: true });
    expect(field(out.posts, 'UpdatepostsSchema', 'authorId')).toBe(
      "z.number().int().brand<'users.id'>().optional()"
    );
  });

  it('exports an alias for the key it owns and none for a key it borrows', async () => {
    const out = await emit(schema(), { branded: true });
    expect(out.users).toContain("export type UsersId = z.output<typeof SelectusersSchema>['id'];");
    expect(out.posts).toContain("export type PostsId = z.output<typeof SelectpostsSchema>['id'];");
    expect(out.posts).not.toContain('UsersId');
  });

  it('can brand keys without branding foreign keys', async () => {
    const out = await emit(schema(), { branded: { foreignKeys: false } });
    expect(field(out.posts, 'SelectpostsSchema', 'id')).toContain(".brand<'posts.id'>()");
    expect(field(out.posts, 'SelectpostsSchema', 'authorId')).toBe('z.number().int()');
  });

  it('can brand without exporting aliases', async () => {
    const out = await emit(schema(), { branded: { aliases: false } });
    expect(out.users).toContain(".brand<'users.id'>()");
    expect(out.users).not.toContain('export type UsersId');
  });

  it('drops the typedColumns pipe on a branded column and keeps it elsewhere', async () => {
    // Both narrow the same column's static type and whichever runs second wins, so they cannot
    // both apply. The brand does, and the reference is not emitted rather than emitted dead.
    const out = await emit(schema(), {
      branded: true,
      typedColumns: true,
      schemaPath: 'src/db/schema.ts',
    });
    expect(field(out.posts, 'SelectpostsSchema', 'authorId')).toBe(
      "z.number().int().brand<'users.id'>()"
    );
    expect(field(out.posts, 'SelectpostsSchema', 'title')).toContain('.pipe(z.custom<');
  });

  it('keeps the metadata call last, after the brand', async () => {
    const tables = [
      table('users', {
        columns: [col('id', { sqlType: 'integer' })],
        primaryKey: { columns: ['id'] },
      }),
    ];
    const out = await emit(tables, { branded: true, meta: true });
    const f = field(out.users, 'SelectusersSchema', 'id');
    expect(f.indexOf('.brand<')).toBeLessThan(f.indexOf('.meta('));
  });

  it('brands the columns of a nested schema as well', async () => {
    const analysis: Analysis = {
      dialect: 'postgres',
      tables: schema() as never,
      enums: [],
      relations: [{ kind: 'many', from: 'users', to: 'posts' }],
      issues: [],
    };
    const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-branded-nested-'));
    await new ZodGenerator(analysis).generate({
      outDir: dir,
      branded: true,
      nestedSchemas: true,
    } as never);
    const src = await fs.readFile(path.join(dir, 'users.zod.ts'), 'utf8');
    await fs.rm(dir, { recursive: true, force: true });
    const nested = src.slice(src.indexOf('NestedSelectusersSchema'));
    expect(nested).toContain(".brand<'users.id'>()");
  });
});

describe('what the emitted schema does', () => {
  /** Emit into the package so `zod` resolves, then import the module and use it for real. */
  async function load(tables: Table[], opts: Record<string, unknown>) {
    const analysis: Analysis = {
      dialect: 'postgres',
      tables: tables as never,
      enums: [],
      relations: [],
      issues: [],
    };
    const dir = path.join(__dirname, '.tmp-branded-run');
    await fs.mkdir(dir, { recursive: true });
    await new ZodGenerator(analysis).generate({ outDir: dir, ...opts } as never);
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const mods: Record<string, any> = {};
    for (const t of tables) {
      const file = path.join(dir, `${t.tsName}-${stamp}.ts`);
      await fs.rename(path.join(dir, `${t.tsName}.zod.ts`), file);
      mods[t.tsName] = await import(file);
    }
    return mods;
  }

  it('parses exactly what it parsed before, and hands the value back unchanged', async () => {
    const branded = await load(schema(), { branded: true });
    const plain = await load(schema(), {});
    const row = { id: 7, authorId: 3, title: 'x' };
    expect(branded.posts.SelectpostsSchema.parse(row)).toEqual(
      plain.posts.SelectpostsSchema.parse(row)
    );
    // The point of the whole feature: at runtime there is no such thing as a UserId.
    expect(branded.posts.SelectpostsSchema.parse(row).authorId).toBe(3);
    expect(branded.posts.SelectpostsSchema.safeParse({ ...row, authorId: 'nope' }).success).toBe(
      false
    );
  });

  it('still admits null on a nullable branded column', async () => {
    // The half a wrongly-ordered brand would leave working: the runtime is fine either way, and
    // only the inferred type is wrong. That is why this assertion is not the proof.
    const m = await load(schema({ authorNullable: true }), { branded: true });
    expect(m.posts.SelectpostsSchema.parse({ id: 1, authorId: null, title: 'x' })).toEqual({
      id: 1,
      authorId: null,
      title: 'x',
    });
  });
});
