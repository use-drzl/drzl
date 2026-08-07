/**
 * Shared scaffolding for the Effect generator's tests.
 *
 * Every spec here runs the emitted module rather than reading its text, so the helpers below all
 * end at a live import: `emit` returns the module namespace, and the assertions push real values
 * through the schemas it exports. Reading the text proves the generator wrote what the generator
 * meant to write, which is the thing least in doubt.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Analysis, Column, Relation, Table } from '@drzl/analyzer';
import * as Either from 'effect/Either';
import * as Schema from 'effect/Schema';
import { EffectGenerator } from '../src/index';

export const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

export const table = (tsName: string, columns: Column[], over: Partial<Table> = {}): Table =>
  ({
    name: tsName,
    tsName,
    columns,
    unique: [],
    indexes: [],
    checks: [],
    ...over,
  }) as never as Table;

export const analysisOf = (tables: Table[], relations: Relation[] = []): Analysis =>
  ({
    dialect: 'postgres',
    tables,
    enums: [],
    relations,
    issues: [],
  }) as never as Analysis;

let seq = 0;

/**
 * A fresh output directory inside this package.
 *
 * Inside, not under `os.tmpdir()`, for two reasons that both bite silently. Node's resolver walks
 * up from the emitted file to find `effect`, and a directory outside the package finds nothing.
 * Prettier resolves its config the same way, so output written elsewhere comes back with double
 * quotes and every assertion about the emitted text fails on punctuation.
 */
async function workDir(): Promise<string> {
  return fs.mkdtemp(path.join(import.meta.dirname, '.tmp-run-'));
}

/**
 * Generate a whole output directory and import one table's module out of it.
 *
 * The file is renamed to a fresh name per call because an ES module is cached by URL: two tests
 * generating different schemas into `t.effect.ts` would both see whichever ran first, and the
 * second one would pass while asserting against the first one's output.
 */
export async function emit(
  analysis: Analysis,
  opts: Record<string, unknown> = {},
  tsName = analysis.tables[0]!.tsName
): Promise<Record<string, unknown>> {
  const dir = await workDir();
  await new EffectGenerator(analysis).generate({ outDir: dir, ...opts } as never);
  const suffix = (opts.fileSuffix as string) ?? '.effect.ts';
  const from = path.join(dir, `${tsName}${suffix}`);
  const to = path.join(dir, `m${process.pid}-${seq++}.ts`);
  await fs.rename(from, to);
  try {
    return (await import(to)) as Record<string, unknown>;
  } finally {
    // Removed once the module is loaded, which it is by here. A generated file left under `test/`
    // is typechecked by this package's tsconfig and linted by the repo config, and one emitted
    // with a `schemaPath` names a schema module that was never written, so a stray directory turns
    // an unrelated `pnpm typecheck` red.
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** One table of one column, imported. The shape most of these tests need. */
export async function emitColumn(
  c: Column,
  checks: Array<{ name?: string; expression: string }> = [],
  opts: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return emit(analysisOf([table('t', [c], { checks } as never)]), opts);
}

/** The generated text, for the few assertions that really are about what was written. */
export async function emitText(
  analysis: Analysis,
  opts: Record<string, unknown> = {},
  tsName = analysis.tables[0]!.tsName
): Promise<string> {
  const dir = await workDir();
  await new EffectGenerator(analysis).generate({ outDir: dir, ...opts } as never);
  const suffix = (opts.fileSuffix as string) ?? '.effect.ts';
  try {
    return await fs.readFile(path.join(dir, `${tsName}${suffix}`), 'utf8');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Whether a schema accepts a value, as a boolean, with no Effect vocabulary at the call site. */
export const accepts = (schema: unknown, value: unknown): boolean =>
  Either.isRight(Schema.decodeUnknownEither(schema as Schema.Schema<unknown>)(value));

/** What a schema returns for a value it accepts, for the tests about defaults. */
export const decoded = (schema: unknown, value: unknown): unknown => {
  const r = Schema.decodeUnknownEither(schema as Schema.Schema<unknown>)(value);
  if (Either.isLeft(r)) throw new Error(`rejected: ${JSON.stringify(value)}`);
  return r.right;
};

export { workDir };

/** A thumbs-up: one code point, two UTF-16 units. The character-count trap in one character. */
export const EMOJI = '\u{1F44D}';
