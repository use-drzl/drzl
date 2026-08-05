/**
 * A view, generated and then run against the database it describes.
 *
 * On drizzle-orm 0.4x a view answers no `drizzle:Columns` and no `drizzle:Name`, so the analyzer
 * saw none of them and the generators emitted nothing at all for one: no module, no export in the
 * barrel, and no issue saying so. The repo pins ^0.45.2 for itself, so that was the default.
 *
 * Every other view test in this repo hand-builds an `Analysis` object, which passes on both
 * majors while the feature is dead on one. This one builds a real Drizzle schema, runs the real
 * analyzer over it, emits with the real generator, imports what was emitted, and hands it a row
 * SQLite actually returned.
 *
 * Requires a build, like the other e2e specs here: it imports `@drzl/analyzer` and
 * `@drzl/generator-zod` as packages, which resolve to their `dist`. CI builds before testing;
 * locally, run `pnpm build` first.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ZodGenerator } from '@drzl/generator-zod';

// Under this package rather than os.tmpdir(): the schema imports drizzle-orm and the emitted
// module imports zod, and Node resolves both by walking parents for node_modules.
const workdir = path.join(__dirname, '.tmp-views-e2e');

const SCHEMA = `
import { sqliteTable, sqliteView, integer, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

export const activeUsers = sqliteView('active_users').as((qb) => qb.select().from(users));
`;

/** The same objects, in a real SQLite, plus the row the view really returns. */
function realRow() {
  const db = new DatabaseSync(':memory:');
  db.exec(`create table users (id integer primary key, name text not null)`);
  db.exec(`insert into users values (1, 'ann')`);
  db.exec(`create view active_users as select id, name from users`);
  const row = db.prepare('select * from active_users').get() as Record<string, unknown>;
  let writeError = '';
  try {
    db.exec(`insert into active_users values (2, 'bob')`);
  } catch (e) {
    writeError = (e as Error).message;
  }
  db.close();
  return { row, writeError };
}

let emitted: Record<string, any> | undefined;
let barrel: string;
let files: string[];

/** The emitted module, or a failure naming the file that was never written. */
function moduleUnderTest(): Record<string, any> {
  if (!emitted) throw new Error(`no activeUsers.zod.ts was emitted; got: ${files.join(', ')}`);
  return emitted;
}

beforeAll(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
  await fs.mkdir(workdir, { recursive: true });
  const schemaFile = path.join(workdir, 'schema.mjs');
  await fs.writeFile(schemaFile, SCHEMA, 'utf8');

  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schemaFile)).analyze({});
  await new ZodGenerator(analysis).generate({ outDir: workdir } as never);

  files = (await fs.readdir(workdir)).sort();
  barrel = await fs.readFile(path.join(workdir, 'index.ts'), 'utf8');
  // Renamed so a rerun cannot be served the previous parse out of the module cache. Absent when
  // the view was never analysed, which is the defect; the cases below say so rather than every
  // one of them dying in here.
  if (files.includes('activeUsers.zod.ts')) {
    const stable = path.join(workdir, `activeUsers-${process.pid}.ts`);
    await fs.rename(path.join(workdir, 'activeUsers.zod.ts'), stable);
    emitted = await import(stable);
  }
}, 120_000);

describe('a view reaches the emitted output at all', () => {
  it('gets its own module and a line in the barrel', async () => {
    // Before the fix this directory held index.ts and users.zod.ts, and nothing else.
    expect(files).toContain('activeUsers.zod.ts');
    expect(files).toContain('users.zod.ts');
    expect(barrel).toContain('activeUsers.zod');
  });
});

describe('the emitted schema, run against what SQLite returns', () => {
  it('accepts the row the view really produced', () => {
    const { row } = realRow();
    expect(row).toEqual({ id: 1, name: 'ann' });
    const parsed = moduleUnderTest().SelectactiveUsersSchema.safeParse(row);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('describes the columns rather than waving them through', () => {
    // A column the analyzer cannot describe comes out `unknown` and is emitted as `z.unknown()`,
    // which accepts everything, so an emitted module proves nothing by existing. Handing it a
    // value of the wrong type is what separates a described column from a waved-through one.
    const bad = moduleUnderTest().SelectactiveUsersSchema.safeParse({ id: 'one', name: 'ann' });
    expect(bad.success).toBe(false);
  });

  it('offers no way to write to it, because SQLite refuses every write to a view', () => {
    const { writeError } = realRow();
    expect(writeError).toMatch(/cannot modify active_users because it is a view/);
    expect(moduleUnderTest().InsertactiveUsersSchema).toBeUndefined();
    expect(moduleUnderTest().UpdateactiveUsersSchema).toBeUndefined();
    // The base table keeps all three; only the view is refused.
    expect(moduleUnderTest().SelectactiveUsersSchema).toBeDefined();
  });
});
