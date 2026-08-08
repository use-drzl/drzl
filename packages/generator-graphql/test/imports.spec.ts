/**
 * The zero-import discipline, asserted.
 *
 * The module doc in src/index.ts derives it from the registry: apollo-server pins graphql 16
 * while latest is 17, and emitted code importing graphql would pick a side and risk the
 * two-realms error. So a table module and the scalars module import NOTHING, and the barrel
 * imports only the modules this generator itself wrote. An import appearing here is not
 * cosmetic: it is a new dependency for every consumer and a realm to collide with.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GraphQLGenerator } from '../src';
import { analysis, dailyTotals, events, tasks, users } from './fixtures';
import type { Table } from '@drzl/analyzer';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'imports');

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

let n = 0;
async function emit(tables: Table[], opts: Record<string, unknown> = {}) {
  const dir = path.join(workRoot, `case-${n++}`);
  await fs.rm(dir, { recursive: true, force: true });
  await new GraphQLGenerator(analysis(tables)).generate({ outputDir: dir, ...opts } as never);
  return (name: string) => fs.readFile(path.join(dir, name), 'utf8');
}

/** Every module specifier the file imports from, across wrapped lines. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
}

describe('a table module', () => {
  it('imports nothing, whatever the table holds', async () => {
    const read = await emit([users, events, tasks, dailyTotals]);
    for (const name of ['users.ts', 'events.ts', 'tasks.ts', 'dailyTotals.ts']) {
      expect(importsOf(await read(name)), name).toEqual([]);
    }
  });
});

describe('the scalars module', () => {
  it('imports nothing: the AST node is typed structurally', async () => {
    const read = await emit([events]);
    expect(importsOf(await read('scalars.ts'))).toEqual([]);
  });
});

describe('the barrel', () => {
  it('imports only what this generator wrote, and only the scalars the schema uses', async () => {
    const read = await emit([users, events]);
    expect(importsOf(await read('index.ts'))).toEqual([
      './scalars.js',
      './users.js',
      './events.js',
    ]);
  });

  it('imports no scalar module when no column reaches for one', async () => {
    const read = await emit([users]);
    // users is Int/String/Boolean/enum territory: no DateTime, BigInt or JSON.
    expect(importsOf(await read('index.ts'))).toEqual(['./users.js']);
    // The scalars module is still emitted and re-exported for a stable surface.
    expect(await read('index.ts')).toContain("export * from './scalars.js';");
  });
});
