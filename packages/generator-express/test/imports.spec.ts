/**
 * Every emitted module imports what it uses, and nothing else.
 *
 * An unused import is not cosmetic. `noUnusedLocals` fails on it, `verbatimModuleSyntax` keeps it,
 * and a module that imports a package the consumer did not install throws on load rather than when
 * the unused thing is touched. The file-set version of the same rule is tested here too: the
 * middleware module is emitted only when some route imports it, because a consumer's tsconfig
 * compiles whatever is in the output directory whether or not anything imports it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ExpressGenerator } from '../src';
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
  await new ExpressGenerator(analysis(tables)).generate({ outputDir: dir, ...opts } as never);
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

describe('a route module that validates something', () => {
  it('imports the library, express, and the emitted middleware', async () => {
    const read = await emit([users]);
    expect(importsOf(await read('users.ts'))).toEqual(['zod', 'express', './validation.js']);
  });

  it('imports json from express only where a body is read', async () => {
    const read = await emit([users]);
    const withWrites = await read('users.ts');
    expect(withWrites).toMatch(/import \{ Router, json, type Response \} from 'express';/);
  });
});

describe('a route module that validates nothing', () => {
  it('imports no middleware, so the set compiles without one being emitted', async () => {
    const read = await emit([dailyTotals], { validation: { useShared: true, importPath: 'v' } });
    const source = await read('dailyTotals.ts');
    expect(source).not.toContain('./validation');
    expect(source).not.toContain('validate(');
    expect(source).not.toContain('json()');
  });

  it('still imports express, which it cannot do without', async () => {
    const read = await emit([dailyTotals], { validation: { useShared: true, importPath: 'v' } });
    expect(await read('dailyTotals.ts')).toContain(`from 'express';`);
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
  it('imports express and each route module, and nothing else', async () => {
    const read = await emit([users, auditLog]);
    expect(importsOf(await read('index.ts'))).toEqual(['express', './users.js', './auditLog.js']);
  });

  it('spells its relative specifiers the way importExtension asks', async () => {
    const read = await emit([users], { importExtension: 'none' });
    expect(importsOf(await read('index.ts'))).toEqual(['express', './users']);
    expect(await read('users.ts')).toContain(`from './validation';`);
  });
});

describe('the emitted middleware module', () => {
  it('imports express type-only, so it adds nothing at runtime', async () => {
    const read = await emit([users]);
    expect(await read('validation.ts')).toContain(`import type { RequestHandler } from 'express';`);
  });

  it('imports no validation library, because Standard Schema is the whole interface', async () => {
    // Its comment names the libraries it serves; what must be absent is any import of one, since
    // this module is shared by all three and a consumer installs only theirs.
    const read = await emit([users]);
    expect(importsOf(await read('validation.ts'))).toEqual(['express']);
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
    // nothing else.
    const read = await emit([users], { validation: { library: 'arktype' } });
    const source = await read('users.ts');
    expect(source).toContain(`id: 'string.numeric.parse'`);
    expect(source).not.toContain(`"'string.numeric.parse'"`);
  });
});
