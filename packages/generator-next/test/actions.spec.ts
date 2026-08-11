/**
 * The emitted text, for the decisions a running action cannot show.
 *
 * What a submission does is asserted against real `FormData` in runtime.spec.ts, which is the
 * stronger test. What is left here is the shape of the tree: which files exist, which reader each
 * column is routed through, and what a config that cannot work is told.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NextGenerator, BARREL_MODULE, HELPERS_MODULE } from '../src';
import { analysis, auditLog, books, col, dailyTotals, profile, table, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'actions');

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

const SHARED = { useShared: true, importPath: 'src/validators/zod' } as const;

async function emit(label: string, tables = [users], opts: Record<string, unknown> = {}) {
  const out = path.join(workRoot, label);
  await fs.rm(out, { recursive: true, force: true });
  const { files } = await new NextGenerator(analysis(tables)).generate({
    outputDir: path.relative(process.cwd(), out),
    validation: { library: 'zod', ...SHARED },
    // Off, so the assertions below are against the bytes this generator writes rather than
    // against whatever quote style prettier found a config for. A project without prettier
    // installed reads exactly these bytes.
    format: { enabled: false },
    ...opts,
  } as never);
  const contents = new Map<string, string>();
  for (const f of files) contents.set(path.basename(f), await fs.readFile(f, 'utf8'));
  return {
    names: [...contents.keys()].sort(),
    read(name: string) {
      const found = contents.get(name);
      if (found === undefined) throw new Error(`no ${name} in ${[...contents.keys()].join(', ')}`);
      return found;
    },
  };
}

describe('the emitted files', () => {
  it('writes one module per writable table, the shared state and a barrel', async () => {
    const out = await emit('layout', [users, books]);
    expect(out.names).toEqual(['books.ts', 'form-state.ts', 'index.ts', 'users.ts']);
  });

  it('writes the shared state and a barrel even when no table is writable', async () => {
    const out = await emit('all-readonly', [dailyTotals]);
    expect(out.names).toEqual([`${HELPERS_MODULE}.ts`, `${BARREL_MODULE}.ts`]);
    expect(out.read(`${BARREL_MODULE}.ts`)).toContain('no actions to re-export');
  });

  it('gives a keyless table a create and nothing that addresses a row', async () => {
    const out = await emit('keyless', [auditLog]);
    const text = out.read('auditLog.ts');
    expect(text).toContain('export async function createAuditLog');
    expect(text).not.toContain('updateAuditLog');
    expect(text).not.toContain('deleteAuditLog');
  });

  it('gives a keyed table all three', async () => {
    const text = (await emit('keyed', [users])).read('users.ts');
    for (const name of ['createUsers', 'updateUsers', 'deleteUsers']) {
      expect(text).toContain(`export async function ${name}`);
    }
  });

  it('addresses a row by every column of a composite key', async () => {
    const composite = table('memberships', {
      columns: [col('orgId', 'number'), col('userId', 'number'), col('role', 'string')],
      primaryKey: { columns: ['orgId', 'userId'] },
    });
    const text = (await emit('composite', [composite])).read('memberships.ts');
    expect(text).toContain('orgId: numberField(data, "orgId")');
    expect(text).toContain('userId: numberField(data, "userId")');
  });
});

describe('the reader each column is routed through', () => {
  it('matches what the browser posts for that input, not the column type', async () => {
    const text = (await emit('readers', [profile])).read('profile.ts');
    const expected: Record<string, string> = {
      handle: 'textField',
      bio: 'nullableTextField',
      age: 'numberField',
      rating: 'nullableNumberField',
      active: 'booleanField',
      bornOn: 'dateField',
      seenAt: 'nullableDateField',
      // A select posts one of its option values, so an enum is text.
      status: 'textField',
    };
    for (const [column, reader] of Object.entries(expected)) {
      expect(text, column).toContain(`${column}: ${reader}(data, "${column}")`);
    }
  });

  it('imports only the readers the table uses', async () => {
    const text = (await emit('reader-imports', [books])).read('books.ts');
    // `books` is two string columns, so nothing numeric, boolean or date is referenced.
    expect(text).toContain('textField');
    for (const unused of ['numberField', 'booleanField', 'dateField']) {
      expect(text, unused).not.toContain(unused);
    }
  });

  it('keeps a bigint as the digit string its schema checks', async () => {
    // A bigint past 2^53 does not survive a trip through `Number`, so it is never converted.
    const big = table('ledger', {
      columns: [col('id', 'bigint'), col('amount', 'bigint')],
      primaryKey: { columns: ['id'] },
    });
    const text = (await emit('bigint', [big])).read('ledger.ts');
    expect(text).toContain('amount: textField(data, "amount")');
    expect(text).not.toContain('numberField');
  });
});

describe('the update action', () => {
  it('sends only the fields the form posted', async () => {
    const text = (await emit('patch', [users])).read('users.ts');
    expect(text).toContain('const input: Record<string, unknown> = {};');
    expect(text).toContain('if (data.has("email")) input["email"] = textField(data, "email");');
  });

  it('reads the key from the same form, so a hidden input carries it', async () => {
    const text = (await emit('patch-key', [users])).read('users.ts');
    expect(text).toContain('const where = {');
    expect(text).toContain('id: numberField(data, "id")');
  });
});

describe('a config that cannot work', () => {
  it('refuses to run without a validation generator to import from', async () => {
    // This generator emits no schemas of its own: the whole point is parsing the constrained ones
    // a sibling wrote, so there is nothing to fall back to.
    const out = path.join(workRoot, 'no-schemas');
    await expect(
      new NextGenerator(analysis([users])).generate({
        outputDir: path.relative(process.cwd(), out),
      } as never)
    ).rejects.toThrow(/validation\.useShared/);
  });

  it('names the fix in the message', async () => {
    const err = await new NextGenerator(analysis([users]))
      .generate({ outputDir: 'unused' } as never)
      .catch((e: Error) => e);
    expect(String(err)).toContain('validation.importPath');
    expect(String(err)).toMatch(/"zod", "valibot" or "arktype"/);
  });

  it('refuses a table whose module would overwrite the shared state', async () => {
    const clash = table('form-state', { tsName: 'form-state', columns: [col('id', 'number')] });
    await expect(
      new NextGenerator(analysis([clash])).generate({
        outputDir: path.relative(process.cwd(), path.join(workRoot, 'clash')),
        validation: { library: 'zod', ...SHARED },
      } as never)
    ).rejects.toThrow(/naming\.routerSuffix/);
  });

  it('refuses a table whose module would overwrite the barrel', async () => {
    const clash = table('index', { columns: [col('id', 'number')] });
    await expect(
      new NextGenerator(analysis([clash])).generate({
        outputDir: path.relative(process.cwd(), path.join(workRoot, 'clash2')),
        validation: { library: 'zod', ...SHARED },
      } as never)
    ).rejects.toThrow(/index\.ts/);
  });
});
