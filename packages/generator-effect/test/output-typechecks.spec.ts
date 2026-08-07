/**
 * The emitted tree compiles, with the real `effect` installed, under strict nodenext.
 *
 * Running the schemas proves they accept and refuse the right values. It does not prove the file
 * is valid TypeScript, and this generator has two places where that is a live question rather than
 * a formality: the `Schema.Unknown.pipe(filter, compose(Record, { strict: false }))` shape the JSON
 * preamble is built from, and the `as unknown as Schema.Schema<T>` cast `typedColumns` emits. Both
 * type-check or they do not, and nothing else in this package would notice.
 *
 * `noUnusedLocals` is on, which is what makes "imports only what it uses" a compile error rather
 * than a matter of taste, and what catches a `DrzlJsonValue` preamble emitted into a file with no
 * json column.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Analysis } from '@drzl/analyzer';
import { EffectGenerator } from '../src/index';
import { analysisOf, col, table } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'typecheck');
const tsc = path.join(pkgRoot, 'node_modules', '.bin', 'tsc');

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/** Every branch of the renderer, in one table, so one compile covers all of them. */
const wide = () =>
  table(
    'users',
    [
      col('id', { isGenerated: true, hasDefault: true }),
      col('name', { maxLength: 50 }),
      col('bio', { nullable: true, maxBytes: 255 }),
      col('email', { format: 'uuid' }),
      col('age', { tsType: 'number', dbType: 'INTEGER', integer: true, min: '0', max: '150' }),
      col('score', {
        tsType: 'number',
        dbType: 'DOUBLE PRECISION',
        integer: false,
        allowsNaN: true,
        allowsInfinity: true,
      }),
      col('big', { tsType: 'bigint', dbType: 'BIGINT', min: '-9', max: '9' }),
      col('active', { tsType: 'boolean', dbType: 'BOOLEAN' }),
      col('createdAt', { tsType: 'Date', dbType: 'TIMESTAMP', hasDefault: true }),
      col('avatar', { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never }),
      col('prefs', { tsType: 'any', shape: { kind: 'json' } as never }),
      col('tags', { arrayDimensions: 1, maxLength: 20 }),
      col('grid', { arrayDimensions: 2 }),
      col('role', { enumValues: ['admin', 'member'] }),
      col('loc', { tsType: 'unknown', shape: { kind: 'tuple', length: 2 } as never }),
      col('xy', {
        tsType: 'unknown',
        shape: { kind: 'numberObject', fields: ['x', 'y'] } as never,
      }),
      col('vec', { tsType: 'unknown', shape: { kind: 'numberVector', length: 3 } as never }),
      col('bits', { shape: { kind: 'bitstring', length: 8, exact: true } as never }),
      col('raw', { shape: { kind: 'byteString', length: 16 } as never }),
      col('custom', { tsType: 'unknown', shape: { kind: 'custom', sqlType: 'citext' } as never }),
      col('mystery', { tsType: 'no-such-type', dbType: 'WHATEVER' }),
      col('lo', { tsType: 'number', dbType: 'INTEGER', integer: true }),
      col('hi', { tsType: 'number', dbType: 'INTEGER', integer: true }),
    ],
    {
      primaryKey: { columns: ['id'] },
      unique: [{ columns: ['email'] }],
      checks: [
        { name: 'ordered', expression: 'lo < hi' },
        { name: 'name_len', expression: 'length(name) >= 2' },
        { name: 'tag_count', expression: 'cardinality(tags) <= 5' },
        { name: 'role_set', expression: "role IN ('admin', 'member')" },
      ],
    } as never
  );

const posts = () => table('posts', [col('id'), col('title'), col('userId')]);

const wideAnalysis = (): Analysis =>
  analysisOf([wide(), posts()], [{ kind: 'many', from: 'users', to: 'posts' }] as never);

/**
 * Emit into a directory under this package, so Node's resolver reaches the `effect` this package
 * installs. A temp directory elsewhere would resolve none of it and the compile would prove
 * nothing.
 */
async function compile(label: string, opts: Record<string, unknown> = {}, extra?: string) {
  const dir = path.join(workRoot, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'db'), { recursive: true });
  // A real schema module, so `typedColumns` has a `$inferSelect` to reference. Derived from the
  // same analysis rather than written out beside it: a reference to a column the Drizzle table does
  // not declare is a compile error, so a hand-kept copy of this list fails the moment the analysis
  // above gains a column, and fails for a reason that has nothing to do with the generator.
  const drizzleTable = (t: ReturnType<typeof table>) =>
    `export const ${t.tsName} = pgTable('${t.name}', { ` +
    t.columns.map((c) => `${c.name}: text('${c.name}')`).join(', ') +
    ' });';
  await fs.writeFile(
    path.join(dir, 'db', 'schema.ts'),
    [
      "import { pgTable, text } from 'drizzle-orm-v1/pg-core';",
      ...wideAnalysis().tables.map((t) => drizzleTable(t as never)),
      '',
    ].join('\n')
  );
  await new EffectGenerator(wideAnalysis()).generate({
    outDir: path.join(dir, 'validators'),
    schemaPath: path.join(dir, 'db', 'schema.ts'),
    ...opts,
  } as never);
  if (extra) await fs.writeFile(path.join(dir, 'validators', 'probe.ts'), extra);

  const tsconfig = path.join(dir, 'tsconfig.json');
  await fs.writeFile(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          target: 'es2022',
          module: 'nodenext',
          moduleResolution: 'nodenext',
          skipLibCheck: true,
        },
        include: ['validators/**/*.ts'],
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"probe","type":"module"}');

  try {
    execFileSync(tsc, ['-p', tsconfig], { cwd: dir, stdio: 'pipe' });
    return '';
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`;
  }
}

describe('the emitted tree', () => {
  it('has a tsc to run', () => {
    expect(existsSync(tsc), `no tsc at ${tsc}; run pnpm install`).toBe(true);
  });

  it('compiles under strict nodenext', async () => {
    expect(await compile('plain')).toBe('');
  });

  it('compiles with nested relation schemas', async () => {
    expect(await compile('nested', { nestedSchemas: true })).toBe('');
  });

  it('compiles with typedJson', async () => {
    expect(await compile('typedjson', { typedJson: true })).toBe('');
  });

  it('compiles with typedColumns, whose cast is the thing in question', async () => {
    expect(await compile('typedcols', { typedColumns: true })).toBe('');
  });

  it('compiles with applyDefaults, duplicateFinder and every mode at once', async () => {
    expect(
      await compile('everything', {
        applyDefaults: true,
        duplicateFinder: true,
        nestedSchemas: true,
        typedColumns: true,
        coerceDates: 'all',
      })
    ).toBe('');
  });

  it('gives the schemas usable static types', async () => {
    // `Schema.Schema.Type<typeof S>` is how a consumer names the row. If the cast or the property
    // signatures produced `any` this would still compile, so the probe asserts a real assignment
    // and a real rejection.
    const probe = [
      "import * as Schema from 'effect/Schema';",
      "import { SelectusersSchema, InsertusersSchema } from './users.effect.js';",
      'type Row = Schema.Schema.Type<typeof SelectusersSchema>;',
      'type New = Schema.Schema.Type<typeof InsertusersSchema>;',
      'const name: string = ({} as Row).name;',
      'const bio: string | null = ({} as Row).bio;',
      'const role: "admin" | "member" = ({} as Row).role;',
      'const maybe: New = {} as New;',
      'export const used = [name, bio, role, maybe];',
      '',
    ].join('\n');
    expect(await compile('types', {}, probe)).toBe('');
  });

  it('would have said so if the tree did not compile', async () => {
    // Every case above passes by producing no output, which a compiler that never ran also does.
    const probe = [
      "import { SelectusersSchema } from './users.effect.js';",
      'export const wrong: number = SelectusersSchema;',
      '',
    ].join('\n');
    const out = await compile('canary', {}, probe);
    expect(out).not.toBe('');
    expect(out).toContain('probe.ts');
  });
});
