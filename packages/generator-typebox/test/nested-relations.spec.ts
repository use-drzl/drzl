/**
 * Nested relation schemas, checked by running them.
 *
 * A caller inserting a parent and its children in one payload has nothing to validate it against:
 * every first-party Drizzle validator emits column keys only, and `db.insert` drops the relation
 * key silently rather than refusing it, so the children are never written and nothing says so.
 *
 * Every assertion here imports the emitted module and checks real payloads against it, through
 * both `Value.Check` and `TypeCompiler`. The two are separate implementations of the same
 * question in TypeBox and they have disagreed here before: a `$ref` that cannot be resolved
 * constructs happily, passes nothing, and throws out of `Value.Check`.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import type { Analysis, Column, Relation, Table } from '@drzl/analyzer';
import { TypeBoxGenerator } from '../src/index';

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

const table = (name: string, cols: Column[], over: Partial<Table> = {}): Table =>
  ({ name, tsName: name, columns: cols, unique: [], indexes: [], checks: [], ...over }) as Table;

const users = table('users', [
  col('id', { tsType: 'number', dbType: 'INTEGER', integer: true, isGenerated: true }),
  col('name'),
]);
const posts = table(
  'posts',
  [
    col('id', { tsType: 'number', dbType: 'INTEGER', integer: true, isGenerated: true }),
    col('authorId', { tsType: 'number', dbType: 'INTEGER', integer: true }),
    col('title'),
  ],
  { foreignKeys: [{ columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] }] }
);
const comments = table(
  'comments',
  [
    col('id', { tsType: 'number', dbType: 'INTEGER', integer: true, isGenerated: true }),
    col('postId', { tsType: 'number', dbType: 'INTEGER', integer: true }),
    col('body'),
  ],
  { foreignKeys: [{ columns: ['postId'], foreignTable: 'posts', foreignColumns: ['id'] }] }
);
/** The cycle that really happens: a table pointing at itself. */
const staff = table(
  'staff',
  [
    col('id', { tsType: 'number', dbType: 'INTEGER', integer: true, isGenerated: true }),
    col('managerId', { tsType: 'number', dbType: 'INTEGER', integer: true, nullable: true }),
    col('label'),
  ],
  { foreignKeys: [{ columns: ['managerId'], foreignTable: 'staff', foreignColumns: ['id'] }] }
);

const RELATIONS: Relation[] = [
  { kind: 'one', from: 'posts', to: 'users' },
  { kind: 'many', from: 'users', to: 'posts' },
  { kind: 'one', from: 'comments', to: 'posts' },
  { kind: 'many', from: 'posts', to: 'comments' },
  { kind: 'one', from: 'staff', to: 'staff' },
  { kind: 'many', from: 'staff', to: 'staff' },
];

const analysis = (): Analysis => ({
  dialect: 'postgres',
  tables: [users, posts, comments, staff],
  enums: [],
  relations: RELATIONS,
  issues: [],
});

let seq = 0;

/** Emit the whole fixture and import one table's module. */
async function emit(
  opts: Record<string, unknown>,
  which = 'users'
): Promise<{ mod: Record<string, any>; text: string; dir: string }> {
  const dir = path.join(__dirname, '.tmp-nested', `run-${process.pid}-${seq++}`);
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis()).generate({ outDir: dir, ...opts } as never);
  const file = path.join(dir, `${which}.typebox.ts`);
  return { mod: await import(file), text: await fs.readFile(file, 'utf8'), dir };
}

/**
 * Whether a payload passes, asked of both checkers, which must agree.
 *
 * They are separate code paths: `Value.Check` walks the schema and `TypeCompiler` generates a
 * function from it. A disagreement is a defect whichever way it points, so it fails here rather
 * than being resolved in favour of one of them.
 */
const ok = (schema: any, value: unknown): boolean => {
  const walked = Value.Check(schema, value);
  const compiled = TypeCompiler.Compile(schema).Check(value);
  expect(compiled, 'TypeCompiler and Value.Check disagree').toBe(walked);
  return walked;
};

describe('off by default', () => {
  it('emits nothing nested and no extra bytes', async () => {
    const plain = await emit({});
    expect(Object.keys(plain.mod).some((k) => k.startsWith('Nested'))).toBe(false);
    expect(plain.text).not.toContain('Nested');
    // Byte-for-byte identical to a run that named the option and turned it off, which is the
    // claim the output-size budget in verify-packed.sh relies on.
    const explicitOff = await emit({ nestedSchemas: false });
    expect(explicitOff.text).toBe(plain.text);
  });
});

describe('the nested insert payload', () => {
  it('accepts a parent and its children in one object', async () => {
    const { mod } = await emit({ nestedSchemas: true });
    const S = mod.NestedInsertusersSchema;
    expect(S, 'the nested insert schema is exported').toBeTruthy();
    expect(ok(S, { name: 'ada', posts: [{ title: 'first' }] })).toBe(true);
    // The children are kept rather than stripped, which is the failure mode a plain object has.
    // TypeBox validates rather than transforms, so the payload is checked in place.
    expect(ok(S, { name: 'ada', posts: [{ title: 'first' }, { title: 'second' }] })).toBe(true);
  });

  it('rejects an invalid child', async () => {
    const { mod } = await emit({ nestedSchemas: true });
    const S = mod.NestedInsertusersSchema;
    expect(ok(S, { name: 'ada', posts: [{ title: 5 }] }), 'a child with the wrong type').toBe(
      false
    );
    expect(ok(S, { name: 'ada', posts: [{}] }), 'a child missing a required column').toBe(false);
    expect(ok(S, { name: 'ada', posts: {} }), 'an object where an array belongs').toBe(false);
  });

  it('does not ask for the foreign key the parent supplies', async () => {
    const { mod } = await emit({ nestedSchemas: true });
    const S = mod.NestedInsertusersSchema;
    // `authorId` cannot be known before the user is written. A schema demanding it is unusable.
    expect(ok(S, { name: 'ada', posts: [{ title: 'x' }] })).toBe(true);
    expect(Object.keys(S.properties.posts.items.properties)).toEqual(['title']);
    // And the plain insert schema still requires it, so the nesting weakened nothing.
    expect(ok(mod.InsertusersSchema, {})).toBe(false);
  });

  it('leaves the relation key optional, so a childless parent still validates', async () => {
    const { mod } = await emit({ nestedSchemas: true });
    expect(ok(mod.NestedInsertusersSchema, { name: 'ada' })).toBe(true);
  });

  it('carries no `one` relation', async () => {
    const { mod } = await emit({ nestedSchemas: true }, 'posts');
    const S = mod.NestedInsertpostsSchema;
    expect(Object.keys(S.properties).sort()).toEqual(['authorId', 'comments', 'title']);
    expect(
      S.properties.users,
      'a `one` arm would weaken authorId on the post itself'
    ).toBeUndefined();
  });

  it('emits no nested update schema in any form', async () => {
    const { mod, text } = await emit({ nestedSchemas: true });
    expect(Object.keys(mod).filter((k) => k.startsWith('NestedUpdate'))).toEqual([]);
    expect(text).not.toContain('NestedUpdate');
  });
});

describe('the nested select payload', () => {
  it('carries every relation kind, each one optional', async () => {
    const { mod } = await emit({ nestedSchemas: true }, 'posts');
    const S = mod.NestedSelectpostsSchema;
    expect(Object.keys(S.properties).sort()).toEqual([
      'authorId',
      'comments',
      'id',
      'title',
      'users',
    ]);
    const row = { id: 1, authorId: 2, title: 't' };
    expect(ok(S, row), 'a row from a query that asked for no relations').toBe(true);
    expect(ok(S, { ...row, users: { id: 2, name: 'ada' } }), 'with: { author: true }').toBe(true);
    expect(ok(S, { ...row, comments: [{ id: 9, postId: 1, body: 'hi' }] })).toBe(true);
  });

  it('accepts null for a to-one, which a relational query really returns', async () => {
    const { mod } = await emit({ nestedSchemas: true }, 'posts');
    expect(ok(mod.NestedSelectpostsSchema, { id: 1, authorId: 2, title: 't', users: null })).toBe(
      true
    );
  });

  it('still rejects a row whose related object is wrong', async () => {
    const { mod } = await emit({ nestedSchemas: true }, 'posts');
    const S = mod.NestedSelectpostsSchema;
    expect(ok(S, { id: 1, authorId: 2, title: 't', users: { id: 'two', name: 'ada' } })).toBe(
      false
    );
    expect(ok(S, { id: 1, authorId: 2, title: 't', comments: [{ id: 9 }] })).toBe(false);
  });

  it('keeps every column of the related row, since a read returns them all', async () => {
    const { mod } = await emit({ nestedSchemas: true });
    const child = mod.NestedSelectusersSchema.properties.posts.items;
    expect(Object.keys(child.properties).sort()).toEqual(['authorId', 'id', 'title']);
  });
});

describe('depth', () => {
  it('stops one level down by default', async () => {
    const { mod } = await emit({ nestedSchemas: true });
    const child = mod.NestedInsertusersSchema.properties.posts.items;
    expect(child.properties.comments, 'depth 1 goes no further').toBeUndefined();
  });

  it('goes deeper when asked, and validates the grandchild', async () => {
    const { mod } = await emit({ nestedSchemas: true, nestedDepth: 2 });
    const S = mod.NestedInsertusersSchema;
    const payload = {
      name: 'ada',
      posts: [{ title: 'first', comments: [{ body: 'hi' }] }],
    };
    expect(ok(S, payload)).toBe(true);
    expect(ok(S, { name: 'ada', posts: [{ title: 'x', comments: [{ body: 5 }] }] })).toBe(false);
    // The grandchild's own foreign key is omitted too.
    expect(
      ok(S, { name: 'ada', posts: [{ title: 'x', comments: [{ body: 'hi', postId: 1 }] }] })
    ).toBe(true);
  });
});

describe('a cycle', () => {
  it('loads, validates, and stops at the depth rather than recursing', async () => {
    const { mod } = await emit({ nestedSchemas: true, nestedDepth: 2 }, 'staff');
    const S = mod.NestedInsertstaffSchema;
    expect(ok(S, { label: 'root', staff: [{ label: 'a', staff: [{ label: 'b' }] }] })).toBe(true);
    // Past the depth the key is not declared. TypeBox's object is not strict, so the extra level
    // is ignored rather than refused, and neither checker recurses forever over it.
    expect(
      ok(S, {
        label: 'root',
        staff: [{ label: 'a', staff: [{ label: 'b', staff: [{ label: 'c' }] }] }],
      })
    ).toBe(true);
    // The self-referencing foreign key is what the parent supplies, so it is gone at every level.
    expect(mod.NestedInsertstaffSchema.properties.staff.items.properties.managerId).toBeUndefined();
  });
});

describe('the emitted module', () => {
  it('imports nothing new and exports the types beside the schemas', async () => {
    const { text } = await emit({ nestedSchemas: true });
    // Nesting is expanded inline, so no module reaches for a sibling and no import cycle exists.
    // Two modules that referenced each other would be a real hazard here: the initialiser runs at
    // load, so the second one to evaluate reads an uninitialised binding and throws on import.
    expect(text.match(/^import .*$/gm)).toEqual([
      "import { Type } from '@sinclair/typebox';",
      "import type { Static } from '@sinclair/typebox';",
    ]);
    expect(text).toContain('export type NestedInsertusersInput');
    expect(text).toContain('export type NestedSelectusersOutput');
  });

  it('emits only the modes a table actually has relations for', async () => {
    // `comments` is a child and nothing else: it has a `one` to posts and no `many` at all, so a
    // nested insert would be a byte-for-byte copy of the insert schema beside it.
    const { mod } = await emit({ nestedSchemas: true }, 'comments');
    expect(mod.NestedInsertcommentsSchema).toBeUndefined();
    expect(mod.NestedSelectcommentsSchema).toBeTruthy();
    expect(ok(mod.NestedSelectcommentsSchema, { id: 1, postId: 2, body: 'hi' })).toBe(true);
  });
});

describe('the emitted nested code compiles', () => {
  /**
   * Run `tsc` over the emitted directory.
   *
   * Not covered by `pnpm typecheck`, and that was measured rather than assumed: the generator
   * tsconfigs include `test`, and TypeScript's wildcard include skips any directory whose name
   * starts with a dot, which every `.tmp-*` output directory here does. A deliberate type error
   * written into an emitted file left `tsc -p tsconfig.json` at zero errors. So this points the
   * compiler at the directory itself, under the `nodenext` resolution the emitted `.js`
   * specifiers exist for.
   */
  it('under strict nodenext', async () => {
    const { dir } = await emit({ nestedSchemas: true, nestedDepth: 2 });
    const cfg = path.join(dir, 'tsconfig.json');
    await fs.writeFile(
      cfg,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2021',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
        include: ['.'],
      }),
      'utf8'
    );
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const { stdout } = await promisify(execFile)(process.execPath, [tsc, '-p', cfg], {
      maxBuffer: 20 * 1024 * 1024,
    }).catch((e: any) => ({ stdout: e.stdout || String(e) }));
    expect(stdout.trim()).toBe('');
  }, 60_000);
});
