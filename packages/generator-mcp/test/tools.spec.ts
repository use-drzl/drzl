/**
 * The emitted text, for the decisions a running server cannot show.
 *
 * Everything a client can observe is asserted against a real server in runtime.spec.ts, which is
 * the stronger test and the one to reach for first. What is left here is the shape of the files
 * themselves: which ones exist, what a refused config does before writing any of them, and whether
 * an import is emitted only where it is used, none of which a `tools/list` can answer.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MCPGenerator, SERVER_MODULE, STDIO_MODULE } from '../src';
import { analysis, auditLog, books, dailyTotals, events, table, col, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'tools');

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

interface Emitted {
  files: string[];
  read(name: string): string;
  names: string[];
}

async function emit(label: string, tables = [users], opts: Record<string, unknown> = {}) {
  const out = path.join(workRoot, label);
  await fs.rm(out, { recursive: true, force: true });
  const gen = new MCPGenerator(analysis(tables));
  const { files } = await gen.generate({
    outputDir: path.relative(process.cwd(), out),
    ...opts,
  } as never);
  const contents = new Map<string, string>();
  for (const f of files) contents.set(path.basename(f), await fs.readFile(f, 'utf8'));
  const emitted: Emitted = {
    files,
    names: [...contents.keys()].sort(),
    read: (name) => {
      const found = contents.get(name);
      if (found === undefined) throw new Error(`no ${name} in ${[...contents.keys()].join(', ')}`);
      return found;
    },
  };
  return emitted;
}

describe('the emitted files', () => {
  it('writes one module per table, a barrel and a stdio entry point', async () => {
    const out = await emit('layout', [users, books]);
    expect(out.names).toEqual(['books.ts', 'index.ts', 'stdio.ts', 'users.ts']);
  });

  it('omits the stdio entry point when it is turned off', async () => {
    const out = await emit('no-stdio', [users], { stdio: false });
    expect(out.names).toEqual(['index.ts', 'users.ts']);
  });

  it('names the modules the barrel is built from', async () => {
    const out = await emit('barrel', [users, books]);
    const barrel = out.read(`${SERVER_MODULE}.ts`);
    expect(barrel).toContain("import { registerUsersTools } from './users.js';");
    expect(barrel).toContain("import { registerBooksTools } from './books.js';");
    expect(barrel).toContain('registerUsersTools(server);');
    expect(barrel).toContain('registerBooksTools(server);');
  });

  it('carries the server identity into the barrel', async () => {
    const out = await emit('identity', [users], {
      serverName: 'shop-db',
      serverVersion: '2.3.4',
    });
    expect(out.read(`${SERVER_MODULE}.ts`)).toContain(
      "new McpServer({ name: 'shop-db', version: '2.3.4' })"
    );
  });

  it('still produces a usable barrel for an analysis with no tables', async () => {
    const out = await emit('empty', []);
    const barrel = out.read(`${SERVER_MODULE}.ts`);
    expect(barrel).toContain('export function createServer()');
    expect(barrel).toContain('nothing to register');
  });

  it('points the stdio entry at the barrel and at nothing else', async () => {
    const out = await emit('stdio-entry', [users]);
    const stdio = out.read(`${STDIO_MODULE}.ts`);
    expect(stdio).toContain("import { createServer } from './index.js';");
    expect(stdio).toContain('new StdioServerTransport()');
    expect(stdio).toContain("from '@modelcontextprotocol/server/stdio'");
  });

  it('imports the v1 transport when the v1 SDK is asked for', async () => {
    const out = await emit('v1', [users], { sdk: 'v1' });
    expect(out.read(`${STDIO_MODULE}.ts`)).toContain(
      "from '@modelcontextprotocol/sdk/server/stdio.js'"
    );
    expect(out.read(`${SERVER_MODULE}.ts`)).toContain(
      "from '@modelcontextprotocol/sdk/server/mcp.js'"
    );
  });
});

describe('tool names', () => {
  it('keeps only the characters SEP-986 allows', async () => {
    // Read from the SDK's own TOOL_NAME_REGEX: /^[A-Za-z0-9._-]{1,128}$/. The two sets do not
    // nest: `$` is legal in the TypeScript identifier `tsName` always is, and illegal in a tool
    // name, so `users$archive` is a real table that would otherwise produce a name some clients
    // refuse outright.
    const odd = table('users_archive', {
      tsName: 'users$archive',
      columns: [col('id', 'number')],
      primaryKey: { columns: ['id'] },
    });
    const out = await emit('sanitised', [odd]);
    const text = out.read('users$archive.ts');
    const names = [...text.matchAll(/registerTool\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(names).toContain('users_archive_list');
  });

  it('applies a tool prefix so two schemas can share one server', async () => {
    const out = await emit('prefix', [users], { naming: { toolPrefix: 'shop.' } });
    expect(out.read('users.ts')).toContain("'shop.users_list'");
  });

  it('sanitises the prefix too, since it comes from a config rather than from the schema', async () => {
    const out = await emit('prefix-odd', [users], { naming: { toolPrefix: 'my shop/' } });
    const names = [...out.read('users.ts').matchAll(/registerTool\(\s*'([^']+)'/g)].map(
      (m) => m[1]
    );
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(names).toContain('my_shop_users_list');
  });

  it('follows procedureCase into the tool name', async () => {
    const out = await emit('case', [auditLog], { naming: { procedureCase: 'snake' } });
    expect(out.read('audit_log.ts')).toContain("'audit_log_list'");
  });
});

describe('imports', () => {
  it('emits the library import only when the module uses it', async () => {
    // A read-only, keyless table still declares a list-input schema, so it does use the library.
    // The case worth checking is the opposite direction: no module imports a package it never
    // mentions, which `noUnusedLocals` would otherwise turn into a compile error.
    const out = await emit('lib-import', [users, dailyTotals]);
    expect(out.read('users.ts')).toContain("import { z } from 'zod';");
    expect(out.read('daily_totals.ts')).toContain("import { z } from 'zod';");
  });

  it('imports the valibot JSON Schema wrapper only for valibot', async () => {
    const zod = await emit('wrapper-zod', [users], { validation: { library: 'zod' } });
    expect(zod.read('users.ts')).not.toContain('toStandardJsonSchema');

    const valibot = await emit('wrapper-valibot', [users], { validation: { library: 'valibot' } });
    expect(valibot.read('users.ts')).toContain(
      "import { toStandardJsonSchema } from '@valibot/to-json-schema';"
    );
    expect(valibot.read('users.ts')).toContain('inputSchema: toStandardJsonSchema(');
  });

  it('defines the valibot json value space in the one module that needs it', async () => {
    const out = await emit('json-space', [users, events], { validation: { library: 'valibot' } });
    expect(out.read('events.ts')).toContain('const DrzlJsonValue');
    expect(out.read('users.ts')).not.toContain('const DrzlJsonValue');
    // Without `v.finite()` and without the plain-object guard, neither of which can be converted
    // to JSON Schema. See the constant's comment for why that is not a weaker check here.
    expect(out.read('events.ts')).not.toContain('v.finite()');
    expect(out.read('events.ts')).not.toContain('v.custom');
  });

  it('imports only the shared schemas a module actually names', async () => {
    const out = await emit('shared', [users, dailyTotals], {
      validation: { library: 'zod', useShared: true, importPath: 'src/validators/zod' },
    });
    const usersModule = out.read('users.ts');
    expect(usersModule).toMatch(/import \{[^}]*InsertusersSchema[^}]*\} from/);
    expect(usersModule).toMatch(/import \{[^}]*SelectusersSchema[^}]*\} from/);
    expect(usersModule).not.toContain('export const InsertusersSchema =');
    // A read-only table has no insert or update schema to import, and the validation generators
    // do not emit one for it, so importing it would import nothing.
    const readOnly = out.read('daily_totals.ts');
    expect(readOnly).not.toContain('Insertdaily_totalsSchema');
    expect(readOnly).not.toContain('Updatedaily_totalsSchema');
  });
});

describe('a config that cannot work', () => {
  it('refuses the v1 SDK with a non-zod library, before writing anything', async () => {
    const out = path.join(workRoot, 'refused');
    await fs.rm(out, { recursive: true, force: true });
    const gen = new MCPGenerator(analysis([users]));
    await expect(
      gen.generate({
        outputDir: path.relative(process.cwd(), out),
        sdk: 'v1',
        validation: { library: 'arktype' },
      } as never)
    ).rejects.toThrow(/sdk "v1" cannot carry arktype/);
    // Nothing half-written: the check runs before the output directory is even created.
    await expect(fs.stat(out)).rejects.toThrow();
  });

  it('says what to do about it', async () => {
    const gen = new MCPGenerator(analysis([users]));
    const err = await gen
      .generate({ outputDir: 'unused', sdk: 'v1', validation: { library: 'valibot' } } as never)
      .catch((e: Error) => e);
    expect(String(err)).toContain('@modelcontextprotocol/server');
    expect(String(err)).toContain('validation.library');
  });

  it('allows the v1 SDK with zod', async () => {
    const out = await emit('v1-zod', [users], { sdk: 'v1', validation: { library: 'zod' } });
    expect(out.names).toContain('users.ts');
  });

  it('refuses a table whose module would overwrite the barrel', async () => {
    const clash = table('index', { columns: [col('id', 'number')] });
    const gen = new MCPGenerator(analysis([clash]));
    await expect(
      gen.generate({
        outputDir: path.relative(process.cwd(), path.join(workRoot, 'clash')),
      } as never)
    ).rejects.toThrow(/naming\.routerSuffix/);
  });

  it('refuses a table whose module would overwrite the stdio entry point', async () => {
    const clash = table('stdio', { columns: [col('id', 'number')] });
    const gen = new MCPGenerator(analysis([clash]));
    await expect(
      gen.generate({
        outputDir: path.relative(process.cwd(), path.join(workRoot, 'clash-stdio')),
      } as never)
    ).rejects.toThrow(/stdio\.ts/);
  });

  it('lets that same table through once the stdio entry point is off', async () => {
    const clash = table('stdio', { columns: [col('id', 'number')] });
    const gen = new MCPGenerator(analysis([clash]));
    const out = path.join(workRoot, 'clash-allowed');
    await fs.rm(out, { recursive: true, force: true });
    const { files } = await gen.generate({
      outputDir: path.relative(process.cwd(), out),
      stdio: false,
    } as never);
    expect(files.map((f) => path.basename(f)).sort()).toEqual(['index.ts', 'stdio.ts']);
  });
});
