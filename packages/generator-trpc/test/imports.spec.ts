/**
 * Every emitted module imports what it uses, and nothing else.
 *
 * Two defects in this repository were modules that threw on import, and an import of a package a
 * consumer did not install throws at load rather than when the unused thing is touched. An unused
 * import is also a hard error under `noUnusedLocals`, and `verbatimModuleSyntax` keeps it, so a
 * spare specifier is not cosmetic in the tree this output lands in.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import { activeUsers, analysis, auditLog, users } from './fixtures';

async function emit(tables: unknown[], opts: Record<string, unknown> = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-trpc-imp-'));
  await new TRPCGenerator(analysis(tables as never)).generate({
    outputDir,
    format: { enabled: false },
    ...opts,
  } as never);
  const read = (name: string) => fs.readFile(path.join(outputDir, name), 'utf8');
  return read;
}

/** The names an import statement binds, across every import in the file. */
function imported(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import (?:type )?\{([^}]*)\} from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  for (const m of source.matchAll(/import \* as (\w+) from/g)) names.push(m[1]);
  return names;
}

/** Whether a binding is referenced anywhere other than the line that imports it. */
function isUsed(source: string, name: string): boolean {
  const withoutImports = source.replace(/^import .*$/gm, '');
  return new RegExp(`\\b${name}\\b`).test(withoutImports);
}

describe('the base module', () => {
  it('imports TRPCError only when the database middleware needs it', async () => {
    const plain = await (await emit([users]))('trpc.ts');
    expect(imported(plain)).toEqual(['initTRPC']);

    const injected = await (
      await emit([users], { databaseInjection: { enabled: true, databaseType: 'Database' } })
    )('trpc.ts');
    expect(imported(injected)).toEqual(['initTRPC', 'TRPCError']);
    expect(injected).toContain('new TRPCError(');
  });

  it('imports the database type when one is configured', async () => {
    const source = await (
      await emit([users], {
        databaseInjection: {
          enabled: true,
          databaseType: 'Database',
          databaseTypeImport: { name: 'Database', from: '../db/client.js' },
        },
      })
    )('trpc.ts');
    expect(source).toContain("import type { Database } from '../db/client.js';");
    expect(source).toContain('db?: Database;');
  });
});

describe('a router module', () => {
  it('binds nothing it does not reference', async () => {
    for (const table of [users, activeUsers, auditLog]) {
      const source = await (await emit([table]))(`${table.tsName}.ts`);
      const unused = imported(source).filter((n) => !isUsed(source, n));
      expect(unused, `${table.name} imports these and never uses them`).toEqual([]);
    }
  });

  it('imports only the shared schemas it mentions', async () => {
    // A read-only relation has no insert or update schema: the validation generators do not emit
    // one, because the database refuses every write it would describe. Importing them would be an
    // import that resolves to nothing.
    const read = await emit([activeUsers], {
      validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
    });
    const source = await read('activeUsers.ts');
    expect(source).toContain('import { SelectactiveUsersSchema } from');
    expect(source).not.toContain('InsertactiveUsersSchema');
    expect(source).not.toContain('UpdateactiveUsersSchema');
  });

  it('renames on import only when the affix renamed something', async () => {
    // With no affix the exported name already is the local alias, and `X as X` is noise in a file
    // someone reads. The oRPC generator emits it unconditionally.
    const plain = await (
      await emit([users], {
        validation: { useShared: true, library: 'zod', importPath: '../validators/zod' },
      })
    )('users.ts');
    expect(plain).not.toMatch(/(\w+) as \1\b/);

    const renamed = await (
      await emit([users], {
        validation: {
          useShared: true,
          library: 'zod',
          importPath: '../validators/zod',
          affix: { tableCase: 'pascal' },
        },
      })
    )('users.ts');
    expect(renamed).toContain('SelectUsersSchema as SelectusersSchema');
  });

  it('leaves out the validation library when no expression uses it', async () => {
    // A read-only table with no primary key has exactly one procedure, `list`, whose output under
    // arktype is `Select.array()`: built entirely from the imported schema, so nothing in the file
    // says `type(`.
    const readOnlyNoKey = { ...auditLog, readOnly: true };
    const read = await emit([readOnlyNoKey], {
      validation: { useShared: true, library: 'arktype', importPath: '../validators/arktype' },
    });
    const source = await read('auditLog.ts');
    expect(source).not.toContain("from 'arktype'");
    expect(imported(source).filter((n) => !isUsed(source, n))).toEqual([]);
  });

  it('still imports the library when an expression does use it', async () => {
    const read = await emit([users], {
      validation: { useShared: true, library: 'arktype', importPath: '../validators/arktype' },
    });
    const source = await read('users.ts');
    expect(source).toContain("import { type } from 'arktype';");
    expect(source).toContain('type({ id: "number" })');
  });

  it('binds the procedure builder the file actually uses', async () => {
    const plain = await (await emit([users]))('users.ts');
    expect(plain).toContain("import { publicProcedure, router } from './trpc.js';");
    expect(plain).not.toContain('dbProcedure');

    const injected = await (
      await emit([users], { databaseInjection: { enabled: true, databaseType: 'Database' } })
    )('users.ts');
    expect(injected).toContain("import { dbProcedure, router } from './trpc.js';");
    expect(injected).not.toContain('publicProcedure');
  });
});
