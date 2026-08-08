/**
 * Branded primary and foreign keys, for valibot.
 *
 * A brand is a type-level marker with no runtime existence, so this file is in two parts and
 * neither substitutes for the other. The text assertions pin *where* the brand lands, which is
 * the only decision that can be wrong in a way that still compiles: a brand applied outside the
 * nullable wrapper is an intersection with `null`, which is `never`, so the null arm vanishes
 * from the inferred type while parsing keeps accepting null.
 *
 * The rest runs the compiler over generated modules. `proof.ts` holds the accepting and the
 * rejecting cases together with the rejections marked `@ts-expect-error`, and must produce no
 * diagnostic at all; `control.ts` holds the same rejections without the directive and must
 * produce one each; `plain-control.ts` makes the same calls against unbranded output and must
 * produce none, which is what attributes the rejection to the brand.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ValibotGenerator } from '../src/index';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'number',
    dbType: 'INTEGER',
    integer: true,
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const table = (tsName: string, over: Partial<Table> = {}): Table =>
  ({ name: tsName, tsName, columns: [], unique: [], indexes: [], checks: [], ...over }) as Table;

const TABLES: Table[] = [
  table('users', { columns: [col('id')], primaryKey: { columns: ['id'] } }),
  table('posts', {
    columns: [
      col('id'),
      col('authorId', { references: { table: 'users', column: 'id' } }),
      col('editorId', { nullable: true, references: { table: 'users', column: 'id' } }),
      col('title', { tsType: 'string', dbType: 'TEXT', integer: undefined }),
    ],
    primaryKey: { columns: ['id'] },
  }),
];

const analysis = (): Analysis => ({
  dialect: 'postgres',
  tables: TABLES as never,
  enums: [],
  relations: [],
  issues: [],
});

async function emit(opts: Record<string, unknown>): Promise<Record<string, string>> {
  const dir = await fs.mkdtemp(path.join(__dirname, '.tmp-branded-'));
  await new ValibotGenerator(analysis()).generate({ outDir: dir, ...opts } as never);
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    out[t.tsName] = await fs.readFile(path.join(dir, `${t.tsName}.valibot.ts`), 'utf8');
  }
  await fs.rm(dir, { recursive: true, force: true });
  return out;
}

/** One field's value, collapsed the way it would be written by hand. */
const field = (src: string, schemaName: string, name: string): string => {
  const start = src.indexOf(`export const ${schemaName} =`);
  if (start === -1) return '';
  const block = src.slice(start, src.indexOf('\nexport ', start + 1));
  const flat = block
    .replace(/\s+/g, ' ')
    .replace(/,\s*\)/g, ')')
    .replace(/\(\s+/g, '(');
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
    if (depth < 0) break;
  }
  return flat.slice(from, i).trim();
};

describe('what the emitted schema says', () => {
  it('brands nothing unless asked', async () => {
    const out = await emit({});
    expect(out.posts).not.toContain('v.brand(');
  });

  it('brands a primary key with its own token', async () => {
    const out = await emit({ branded: true });
    expect(field(out.posts, 'SelectpostsSchema', 'id')).toBe(
      "v.pipe(v.number(), v.integer(), v.brand('posts.id'))"
    );
  });

  it('brands a foreign key with the token of the table it points at', async () => {
    const out = await emit({ branded: true });
    expect(field(out.posts, 'SelectpostsSchema', 'authorId')).toBe(
      "v.pipe(v.number(), v.integer(), v.brand('users.id'))"
    );
  });

  it('leaves an ordinary column alone', async () => {
    const out = await emit({ branded: true });
    expect(field(out.posts, 'SelectpostsSchema', 'title')).not.toContain('v.brand(');
  });

  it('puts the brand inside the nullable wrapper, not outside it', async () => {
    const out = await emit({ branded: true });
    expect(field(out.posts, 'SelectpostsSchema', 'editorId')).toBe(
      "v.nullable(v.pipe(v.number(), v.integer(), v.brand('users.id')))"
    );
  });

  it('exports an alias for the key it owns and none for a key it borrows', async () => {
    const out = await emit({ branded: true });
    expect(out.users).toContain(
      "export type UsersId = InferOutput<typeof SelectusersSchema>['id'];"
    );
    expect(out.posts).not.toContain('UsersId');
  });

  it('can brand keys without branding foreign keys', async () => {
    const out = await emit({ branded: { foreignKeys: false } });
    expect(field(out.posts, 'SelectpostsSchema', 'id')).toContain('posts.id');
    expect(field(out.posts, 'SelectpostsSchema', 'authorId')).toBe(
      'v.pipe(v.number(), v.integer())'
    );
  });
});

describe('what the emitted schema does', () => {
  /** Emit into the package so the validator resolves, then import the modules and use them. */
  async function load(branded: boolean) {
    const dir = path.join(__dirname, '.tmp-branded-run');
    await fs.mkdir(dir, { recursive: true });
    await new ValibotGenerator(analysis()).generate({
      outDir: dir,
      ...(branded ? { branded: true } : {}),
    } as never);
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const mods: Record<string, any> = {};
    for (const t of TABLES) {
      const file = path.join(dir, `${t.tsName}-${stamp}.ts`);
      await fs.rename(path.join(dir, `${t.tsName}.valibot.ts`), file);
      mods[t.tsName] = await import(file);
    }
    return mods;
  }

  it('parses exactly what it parsed before, and hands the value back unchanged', async () => {
    // The whole point of a brand is that this assertion holds. Anything it changed at runtime
    // would be a validation change wearing a type feature's name.
    const branded = await load(true);
    const plain = await load(false);
    const v = await import('valibot');
    const row = { id: 7, authorId: 3, editorId: null, title: 'x' };
    expect(v.parse(branded.posts.SelectpostsSchema, row)).toEqual(
      v.parse(plain.posts.SelectpostsSchema, row)
    );
    expect(v.parse(branded.posts.SelectpostsSchema, row).authorId).toBe(3);
    expect(v.safeParse(branded.posts.SelectpostsSchema, { ...row, authorId: 'no' }).success).toBe(
      false
    );
  });
});

const PROOF = `
import type { SelectusersOutput, UsersId } from './branded/users.valibot.js';
import type { SelectpostsOutput, PostsId } from './branded/posts.valibot.js';

declare const user: SelectusersOutput;
declare const post: SelectpostsOutput;
declare function loadUser(id: UsersId): void;
declare function loadPost(id: PostsId): void;

loadUser(user.id);
// The payoff: a foreign key carries the brand of the table it points at.
loadUser(post.authorId);

// @ts-expect-error a posts.id is not a users.id
loadUser(post.id);
// @ts-expect-error a users.id is not a posts.id
loadPost(user.id);
// @ts-expect-error a bare number is not a users.id
loadUser(1);

// One way: a branded id is still a number, which is why a service typed \`getById(id: number)\`
// still compiles against one.
const asNumber: number = post.authorId;

// A nullable foreign key keeps its null arm, which is what the placement above buys.
const maybe: UsersId | null = post.editorId;
// @ts-expect-error the column is nullable, so it is not a UsersId on its own
const notMaybe: UsersId = post.editorId;

export { asNumber, maybe, notMaybe };
`;

const CONTROL = `
import type { SelectusersOutput, UsersId } from './branded/users.valibot.js';
import type { SelectpostsOutput, PostsId } from './branded/posts.valibot.js';

declare const user: SelectusersOutput;
declare const post: SelectpostsOutput;
declare function loadUser(id: UsersId): void;
declare function loadPost(id: PostsId): void;

loadUser(post.id);
loadPost(user.id);
loadUser(1);
`;

const PLAIN_CONTROL = `
import type { SelectusersOutput } from './plain/users.valibot.js';
import type { SelectpostsOutput } from './plain/posts.valibot.js';

declare const user: SelectusersOutput;
declare const post: SelectpostsOutput;
declare function loadUser(id: SelectusersOutput['id']): void;

// Unbranded, all three are ordinary numbers and all three compile.
loadUser(post.id);
loadUser(user.id);
loadUser(1);
`;

interface Diagnostic {
  file: string;
  line: number;
  code: string;
}

let diagnostics: Diagnostic[] = [];
let rawOutput = '';

beforeAll(async () => {
  const dir = path.join(__dirname, '.tmp-branded-types');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  await new ValibotGenerator(analysis()).generate({
    outDir: path.join(dir, 'branded'),
    branded: true,
  } as never);
  await new ValibotGenerator(analysis()).generate({ outDir: path.join(dir, 'plain') } as never);

  await fs.writeFile(path.join(dir, 'proof.ts'), PROOF, 'utf8');
  await fs.writeFile(path.join(dir, 'control.ts'), CONTROL, 'utf8');
  await fs.writeFile(path.join(dir, 'plain-control.ts'), PLAIN_CONTROL, 'utf8');
  await fs.writeFile(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['*.ts', 'branded/**/*.ts', 'plain/**/*.ts'],
      },
      null,
      2
    ),
    'utf8'
  );

  const tsc = path.join(__dirname, '..', 'node_modules', 'typescript', 'bin', 'tsc');
  const run = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], {
    encoding: 'utf8',
  });
  rawOutput = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  diagnostics = rawOutput
    .split(/\r?\n/)
    .map((l) => /^(.+?)\((\d+),\d+\): error (TS\d+)/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ file: path.basename(m[1]!), line: Number(m[2]), code: m[3]! }));
}, 180_000);

describe('a branded key is nominal, proved by tsc', () => {
  it('ran the compiler at all', () => {
    expect(diagnostics.length, rawOutput).toBeGreaterThan(0);
  });

  it('accepts the right ids and refuses the wrong ones, with no unused directive', () => {
    expect(
      diagnostics.filter((d) => d.file === 'proof.ts'),
      rawOutput
    ).toEqual([]);
  });

  it('really does reject them, with the directives removed', () => {
    const inControl = diagnostics.filter((d) => d.file === 'control.ts');
    expect(
      inControl.map((d) => d.line),
      rawOutput
    ).toEqual([10, 11, 12]);
    expect(new Set(inControl.map((d) => d.code))).toEqual(new Set(['TS2345']));
  });

  it('is the brand doing it, and not something else about the emitted schema', () => {
    expect(
      diagnostics.filter((d) => d.file === 'plain-control.ts'),
      rawOutput
    ).toEqual([]);
  });
});
