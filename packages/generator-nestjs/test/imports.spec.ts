/**
 * Every emitted module imports what it uses, and nothing else.
 *
 * A table module needs two things: the configured validation library, and the pipe module's
 * `StandardSchema` type, imported type-only so it vanishes at build time. The pipe module needs
 * `@nestjs/common` alone, with its two types inline `type` so `verbatimModuleSyntax` keeps the
 * one value import. The barrel imports nothing: it only re-exports. An unused or extra import
 * would not be cosmetic: `noUnusedLocals` fails on unused ones, and a runtime import of a
 * package the consumer did not install throws on load.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NestJSGenerator } from '../src';
import { analysis, dailyTotals, users } from './fixtures';
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
  await new NestJSGenerator(analysis(tables)).generate({ outputDir: dir, ...opts } as never);
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

describe('a table module', () => {
  it('imports the library and the pipe module type, and nothing else', async () => {
    const read = await emit([users]);
    expect(importsOf(await read('users.ts'))).toEqual(['zod', './validation.js']);
  });

  it('imports the pipe module type-only, so nothing loads at runtime', async () => {
    const read = await emit([users]);
    expect(await read('users.ts')).toContain(
      `import type { StandardSchema } from './validation.js';`
    );
  });

  it('imports the configured library instead when one is configured', async () => {
    const read = await emit([users], { validation: { library: 'arktype' } });
    expect(importsOf(await read('users.ts'))).toEqual(['arktype', './validation.js']);
  });

  it('imports the same two things for a read-only keyless table', async () => {
    // The entity still carries a schema, so the library import stays.
    const read = await emit([dailyTotals]);
    expect(importsOf(await read('dailyTotals.ts'))).toEqual(['zod', './validation.js']);
  });
});

describe('the pipe module', () => {
  it('imports @nestjs/common and nothing else', async () => {
    const read = await emit([users]);
    expect(importsOf(await read('validation.ts'))).toEqual(['@nestjs/common']);
  });

  it('spells its type imports inline, surviving verbatimModuleSyntax', async () => {
    const read = await emit([users]);
    const src = await read('validation.ts');
    expect(src).toContain('type ArgumentMetadata');
    expect(src).toContain('type PipeTransform');
    expect(src).toContain('BadRequestException');
  });
});

describe('the barrel', () => {
  it('imports nothing: it only re-exports', async () => {
    const read = await emit([users]);
    const src = await read('index.ts');
    expect(importsOf(src)).toEqual([]);
    expect(src).toContain(`export * from './users.js';`);
    expect(src).toContain(`export * from './validation.js';`);
  });
});
