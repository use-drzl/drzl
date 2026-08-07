import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import { analysis, col, table, users } from './fixtures';

async function emit(tables = [users], opts: Record<string, unknown> = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-trpc-'));
  const { files } = await new TRPCGenerator(analysis(tables)).generate({
    outputDir,
    ...opts,
  } as never);
  const read = (name: string) => fs.readFile(path.join(outputDir, name), 'utf8');
  return { outputDir, files, read };
}

describe('@drzl/generator-trpc', () => {
  it('emits the shared base, one router per table and the app router', async () => {
    const { files, read } = await emit();
    expect(files.map((f) => path.basename(f))).toEqual(['trpc.ts', 'users.ts', 'index.ts']);

    // The base is what makes the tree one tRPC application rather than several. A router built
    // from its own initTRPC instance has its own context type, so merging is unsound and
    // middleware cannot be shared.
    const base = await read('trpc.ts');
    expect(base).toContain('initTRPC.context<Context>().create()');
    expect(base).toContain('export const router = t.router;');
    expect(base).toContain('export const publicProcedure = t.procedure;');

    const router = await read('users.ts');
    expect(router).toContain('export const usersRouter = router({');
    expect(router).toMatch(/from ['"]\.\/trpc\.js['"]/);
  });

  it('declares its own schemas when validation is not shared', async () => {
    const { read } = await emit();
    const router = await read('users.ts');
    expect(router).toContain('export const InsertusersSchema');
    expect(router).toContain('export const UpdateusersSchema');
    expect(router).toContain('export const SelectusersSchema');
  });

  it('imports shared validation schemas under the configured affix', async () => {
    const userProfiles = table('user_profiles', {
      tsName: 'userProfiles',
      columns: [
        col('id', 'number', { hasDefault: true, isGenerated: true }),
        col('email', 'string'),
      ],
      primaryKey: { columns: ['id'] },
    });
    const { read } = await emit([userProfiles], {
      validation: {
        useShared: true,
        library: 'zod',
        importPath: '../validators/zod',
        affix: { tableCase: 'pascal', schema: { prefix: { insert: 'Create' }, suffix: 'Doc' } },
      },
    });
    const router = await read('userProfiles.ts');
    expect(router).toContain('CreateUserProfilesDoc as InsertuserProfilesSchema');
    expect(router).toContain('UpdateUserProfilesDoc as UpdateuserProfilesSchema');
    expect(router).toContain('SelectUserProfilesDoc as SelectuserProfilesSchema');
    // Local aliases never leave the file, so an affix change cannot rewrite the router body.
    expect(router).not.toContain('export const InsertuserProfilesSchema');
  });

  it('resolves a project-relative importPath against the output directory', async () => {
    // Emitted verbatim, `src/validators/zod` is a *bare* specifier: Node looks for a package of
    // that name and never considers the directory. The same defect was found and fixed in the
    // oRPC generator, and is the reason this goes through resolveConfiguredImport.
    const cwd = process.cwd();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-trpc-rel-'));
    try {
      process.chdir(root);
      await fs.mkdir(path.join(root, 'src', 'validators', 'zod'), { recursive: true });
      await new TRPCGenerator(analysis([users])).generate({
        outputDir: 'src/api',
        validation: { useShared: true, library: 'zod', importPath: 'src/validators/zod' },
      });
      const router = await fs.readFile(path.join(root, 'src', 'api', 'users.ts'), 'utf8');
      expect(router).toMatch(/from ["']\.\.\/validators\/zod\/index\.js["']/);
    } finally {
      process.chdir(cwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('emits a usable app router when the schema has no tables', async () => {
    const { files, read } = await emit([]);
    expect(files.map((f) => path.basename(f))).toEqual(['trpc.ts', 'index.ts']);
    const barrel = await read('index.ts');
    expect(barrel).toContain('export const appRouter = router({});');
    expect(barrel).toContain('export type AppRouter = typeof appRouter;');
  });

  it('names the router export after the table, with the router suffix', async () => {
    // The file keeps the oRPC spelling, `users.ts`, so the two generators lay their output out
    // the same way. The export does not: `export const users = router({...})` inside `users.ts`
    // reads as a table, and `usersRouter` is what every tRPC codebase calls this. The suffix is
    // therefore applied to the export whether or not it was configured, and once when it was.
    expect(await (await emit()).read('users.ts')).toContain('export const usersRouter');
    const suffixed = await emit([users], { naming: { routerSuffix: 'Router' } });
    expect(await suffixed.read('usersRouter.ts')).toContain('export const usersRouter =');
  });

  it('refuses to overwrite its own base module with a router', async () => {
    // A table called `trpc` would otherwise silently clobber the file every other router imports.
    const trpcTable = table('trpc', { columns: [col('id', 'number')] });
    await expect(emit([trpcTable])).rejects.toThrow(/shared tRPC base module/);
    // And the escape hatch named in the message has to actually work.
    const { read } = await emit([trpcTable], { naming: { routerSuffix: 'Router' } });
    expect(await read('trpcRouter.ts')).toContain('export const trpcRouter =');
  });
});
