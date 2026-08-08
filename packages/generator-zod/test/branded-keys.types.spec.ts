/**
 * The proof, by `tsc`, that a branded key is nominal.
 *
 * A brand exists only in the type system. `.brand()` on zod 4.4.3 returns the same schema object
 * it was called on, and a `users.id` and a `posts.id` both holding `1` are `===`. So there is no
 * runtime assertion anywhere that can show this feature works or fails, and a test that read the
 * emitted text would only show that a string was written.
 *
 * What runs here is the compiler, over generated modules, in three parts:
 *
 *   proof.ts          the accepting and the rejecting cases together, the rejections marked with
 *                     `@ts-expect-error`. tsc must report nothing at all in this file.
 *
 *   control.ts        the same rejections with the directive removed. tsc must report each one,
 *                     which is what makes `proof.ts` a measurement rather than a comment: an
 *                     unused `@ts-expect-error` is itself an error, so a rejection that silently
 *                     stopped happening would fail `proof.ts`, and a rejection that never
 *                     happened at all would fail here.
 *
 *   plain-control.ts  the identical call against modules generated *without* branding, with no
 *                     directive. tsc must report nothing, which is what attributes the rejection
 *                     to the brand rather than to anything else about the emitted schema.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

const TABLES: Table[] = [
  table('users', {
    columns: [col('id'), col('email', { tsType: 'string', dbType: 'TEXT' })],
    primaryKey: { columns: ['id'] },
  }),
  table('posts', {
    columns: [
      col('id'),
      col('authorId', { references: { table: 'users', column: 'id' } }),
      col('editorId', { nullable: true, references: { table: 'users', column: 'id' } }),
      col('title', { tsType: 'string', dbType: 'TEXT' }),
    ],
    primaryKey: { columns: ['id'] },
  }),
];

const PROOF = `
import type { SelectusersOutput, UsersId } from './branded/users.zod.js';
import type { SelectpostsOutput, PostsId } from './branded/posts.zod.js';
import { SelectpostsSchema } from './branded/posts.zod.js';

declare const user: SelectusersOutput;
declare const post: SelectpostsOutput;
declare function loadUser(id: UsersId): void;
declare function loadPost(id: PostsId): void;

// A UserId is accepted where a UserId is wanted.
loadUser(user.id);

// The payoff: a foreign key carries the brand of the table it points at, so the id read off a
// post is the id the user loader wants, with no cast anywhere.
loadUser(post.authorId);

// A PostId is refused there.
// @ts-expect-error a posts.id is not a users.id
loadUser(post.id);

// And in the other direction.
// @ts-expect-error a users.id is not a posts.id
loadPost(user.id);

// A plain number is refused too, which is the half that makes the brand nominal rather than an
// alias for number.
// @ts-expect-error a bare number is not a users.id
loadUser(1);

// The brand is one-way: a branded id is still a number, so nothing that took a number before
// stops working. This is why a generated service typed \`getById(id: number)\` still compiles.
const asNumber: number = post.authorId;

// A nullable foreign key keeps its null arm. The brand goes inside the wrapper for exactly this
// reason: \`.nullable().brand()\` infers \`number & $brand\` with no null in it, on zod 4.4.3.
const maybe: UsersId | null = post.editorId;
// @ts-expect-error the column is nullable, so it is not a UsersId on its own
const notMaybe: UsersId = post.editorId;

// The parsed value of the schema is branded too, not only the exported type.
const parsed = SelectpostsSchema.parse({} as unknown);
loadUser(parsed.authorId);

// The insert type stays unbranded, because zod's \`.brand()\` marks the output type and DRZL
// names the insert type from \`z.input\`. A caller building a payload writes plain numbers.
import type { InsertpostsInput } from './branded/posts.zod.js';
const payload: InsertpostsInput = { id: 1, authorId: 2, editorId: null, title: 'x' };

export { asNumber, maybe, notMaybe, parsed, payload };
`;

const CONTROL = `
import type { SelectusersOutput, UsersId } from './branded/users.zod.js';
import type { SelectpostsOutput, PostsId } from './branded/posts.zod.js';

declare const user: SelectusersOutput;
declare const post: SelectpostsOutput;
declare function loadUser(id: UsersId): void;
declare function loadPost(id: PostsId): void;

loadUser(post.id);
loadPost(user.id);
loadUser(1);
`;

const PLAIN_CONTROL = `
import type { SelectusersOutput } from './plain/users.zod.js';
import type { SelectpostsOutput } from './plain/posts.zod.js';

declare const user: SelectusersOutput;
declare const post: SelectpostsOutput;
declare function loadUser(id: SelectusersOutput['id']): void;

// Without branding every one of these is an ordinary number, so all three compile. That is the
// behaviour the feature changes, stated here so the change is attributed to it.
loadUser(post.id);
loadUser(user.id);
loadUser(1);
`;

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['*.ts', 'branded/**/*.ts', 'plain/**/*.ts'],
};

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

  const analysis: Analysis = {
    dialect: 'postgres',
    tables: TABLES as never,
    enums: [],
    relations: [],
    issues: [],
  };
  await new ZodGenerator(analysis).generate({
    outDir: path.join(dir, 'branded'),
    branded: true,
  } as never);
  await new ZodGenerator(analysis).generate({ outDir: path.join(dir, 'plain') } as never);

  await fs.writeFile(path.join(dir, 'proof.ts'), PROOF, 'utf8');
  await fs.writeFile(path.join(dir, 'control.ts'), CONTROL, 'utf8');
  await fs.writeFile(path.join(dir, 'plain-control.ts'), PLAIN_CONTROL, 'utf8');
  await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2), 'utf8');

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
}, 120_000);

describe('a branded key is nominal, proved by tsc', () => {
  it('ran the compiler at all', () => {
    // A run that produced nothing because the config matched no files would pass every
    // assertion below. This is what says the measurement happened.
    expect(diagnostics.length, rawOutput).toBeGreaterThan(0);
  });

  it('accepts the right ids and refuses the wrong ones, with no unused directive', () => {
    // Every `@ts-expect-error` in proof.ts is used, and nothing else in it is an error. Both
    // halves are this one assertion: an unused directive is TS2578, reported in this file.
    const inProof = diagnostics.filter((d) => d.file === 'proof.ts');
    expect(inProof, rawOutput).toEqual([]);
  });

  it('really does reject them, with the directives removed', () => {
    const inControl = diagnostics.filter((d) => d.file === 'control.ts');
    // Three calls, three rejections, each an argument-type error rather than anything else.
    expect(inControl.map((d) => d.line)).toEqual([10, 11, 12]);
    expect(new Set(inControl.map((d) => d.code))).toEqual(new Set(['TS2345']));
  });

  it('is the brand doing it, and not something else about the emitted schema', () => {
    expect(diagnostics.filter((d) => d.file === 'plain-control.ts')).toEqual([]);
  });

  it('names the two brands in the message it prints', () => {
    expect(rawOutput).toContain('posts.id');
    expect(rawOutput).toContain('users.id');
  });
});
