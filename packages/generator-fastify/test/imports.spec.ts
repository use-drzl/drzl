/**
 * Every emitted module imports what it uses, and nothing else.
 *
 * For this generator that is one thing: the `FastifyPluginAsync` type, imported type-only, so
 * the emitted tree adds zero runtime imports of its own. The schemas are inlined data, there is
 * no middleware module, and no validator package to import: Fastify's own AJV is the validator.
 * An unused or runtime-reaching import would not be cosmetic: `noUnusedLocals` fails on unused
 * ones, and a runtime import of `fastify` from every route module would load the framework once
 * per module in tools that do not dedupe.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FastifyGenerator } from '../src';
import { analysis, auditLog, dailyTotals, users } from './fixtures';
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
  await new FastifyGenerator(analysis(tables)).generate({ outputDir: dir, ...opts } as never);
  return (name: string) => fs.readFile(path.join(dir, name), 'utf8');
}

/**
 * Every module specifier the file imports from.
 *
 * Spans lines, because prettier wraps a long named-import list and a single-line pattern then
 * reports no import at all for exactly the file with the most names in it.
 */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
}

describe('a route module', () => {
  it('imports fastify and nothing else', async () => {
    const read = await emit([users]);
    expect(importsOf(await read('users.ts'))).toEqual(['fastify']);
  });

  it('imports it type-only, so nothing loads at runtime', async () => {
    const read = await emit([users]);
    expect(await read('users.ts')).toContain(
      `import type { FastifyPluginAsync } from 'fastify';`
    );
  });

  it('imports the same one thing when it validates nothing at all', async () => {
    // The read-only keyless table has one route taking no input; its plugin is still a plugin.
    const read = await emit([dailyTotals]);
    expect(importsOf(await read('dailyTotals.ts'))).toEqual(['fastify']);
  });
});

describe('the barrel', () => {
  it('imports fastify and each route module, and nothing else', async () => {
    const read = await emit([users, auditLog]);
    expect(importsOf(await read('index.ts'))).toEqual(['fastify', './users.js', './auditLog.js']);
  });

  it('spells its relative specifiers the way importExtension asks', async () => {
    const read = await emit([users], { importExtension: 'none' });
    expect(importsOf(await read('index.ts'))).toEqual(['fastify', './users']);
  });

  it('imports fastify type-only too', async () => {
    const read = await emit([users]);
    expect(await read('index.ts')).toContain(
      `import type { FastifyPluginAsync } from 'fastify';`
    );
  });
});
