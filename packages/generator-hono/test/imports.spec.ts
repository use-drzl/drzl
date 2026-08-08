/**
 * Every emitted module imports what it uses, and nothing else.
 *
 * An unused import is not cosmetic. `noUnusedLocals` fails on it, `verbatimModuleSyntax` keeps it,
 * and a module that imports a package the consumer did not install throws on load rather than when
 * the unused thing is touched. That last one is the reason this file exists: a route module for a
 * read-only keyless table takes no input at all, so an unconditional
 * `import { sValidator } from '@hono/standard-validator'` would make loading it fail in a project
 * that installed only `hono`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HonoGenerator } from '../src';
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
  await new HonoGenerator(analysis(tables)).generate({ outputDir: dir, ...opts } as never);
  return (name: string) => fs.readFile(path.join(dir, name), 'utf8');
}

/**
 * Every module specifier the file imports from.
 *
 * Spans lines, because prettier wraps a long named-import list and the single-line form of this
 * helper reported *no* shared-schema import at all for the one case that has three names in it.
 */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';$/gm)].map((m) => m[1]);
}

describe('a route module that validates something', () => {
  it('imports Hono, the middleware and the validation library', async () => {
    const read = await emit([users]);
    expect(importsOf(await read('users.ts'))).toEqual(['zod', 'hono', '@hono/standard-validator']);
  });

  it('imports the zod-specific middleware when that is what it emits', async () => {
    const read = await emit([users], { validator: 'zod' });
    const source = await read('users.ts');
    expect(source).toContain(`import { zValidator } from '@hono/zod-validator';`);
    expect(source).not.toContain('@hono/standard-validator');
  });
});

describe('a route module that validates nothing', () => {
  it('imports no validator middleware, so it loads without one installed', async () => {
    const read = await emit([dailyTotals], { validation: { useShared: true, importPath: 'v' } });
    const source = await read('dailyTotals.ts');
    expect(source).not.toContain('@hono/standard-validator');
    expect(source).not.toContain('sValidator');
  });

  it('still imports Hono, which it cannot do without', async () => {
    const read = await emit([dailyTotals], { validation: { useShared: true, importPath: 'v' } });
    expect(await read('dailyTotals.ts')).toContain(`import { Hono } from 'hono';`);
  });
});

describe('shared validation schemas', () => {
  it('imports only the modes the file mentions', async () => {
    // A read-only table never references an insert or update schema, and the validation
    // generators do not emit those for one, so importing them would import nothing.
    const read = await emit([dailyTotals], {
      validation: { useShared: true, importPath: 'src/validators/zod' },
    });
    const source = await read('dailyTotals.ts');
    expect(source).toContain('SelectdailyTotalsSchema');
    expect(source).not.toContain('InsertdailyTotalsSchema');
  });

  it('resolves the configured path against the output directory', async () => {
    // Emitting `src/validators/zod` verbatim would be a *bare* specifier naming a package that
    // does not exist.
    const read = await emit([users], {
      validation: { useShared: true, importPath: 'src/validators/zod' },
    });
    const spec = importsOf(await read('users.ts')).find((s) => s.includes('validators'));
    expect(spec).toBeDefined();
    expect(spec?.startsWith('.')).toBe(true);
    expect(spec?.endsWith('/src/validators/zod/index.js')).toBe(true);
  });

  it('aliases an export only when the affix actually renames it', async () => {
    const plain = await emit([users], {
      validation: { useShared: true, importPath: 'src/validators/zod' },
    });
    expect(await plain('users.ts')).not.toMatch(/InsertusersSchema as InsertusersSchema/);

    const affixed = await emit([users], {
      validation: {
        useShared: true,
        importPath: 'src/validators/zod',
        affix: { tableCase: 'pascal' },
      },
    });
    expect(await affixed('users.ts')).toContain('InsertUsersSchema as InsertusersSchema');
  });
});

describe('the barrel', () => {
  it('imports Hono and each route module, and nothing else', async () => {
    const read = await emit([users, auditLog]);
    expect(importsOf(await read('index.ts'))).toEqual(['hono', './users.js', './auditLog.js']);
  });

  it('spells its relative specifiers the way importExtension asks', async () => {
    const read = await emit([users], { importExtension: 'none' });
    expect(importsOf(await read('index.ts'))).toEqual(['hono', './users']);
  });
});

describe('the arktype dialect', () => {
  it('imports arktype where the row type needs it', async () => {
    const read = await emit([users], { validation: { library: 'arktype' } });
    expect(await read('users.ts')).toContain(`import { type } from 'arktype';`);
  });

  it('emits its keywords as keywords, not as string literal types', async () => {
    // `'string.numeric.parse'` returned pre-quoted from the dialect arrives as
    // `"'string.numeric.parse'"`, which ArkType reads as a literal matching that one sentence and
    // nothing else. It rejected every request until it was returned bare.
    const read = await emit([users], { validation: { library: 'arktype' } });
    const source = await read('users.ts');
    expect(source).toContain(`id: 'string.numeric.parse'`);
    expect(source).not.toContain(`"'string.numeric.parse'"`);
  });
});
