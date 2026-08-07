import type { ImportExtension } from '@drzl/validation-core';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import { analysis, posts, users } from './fixtures';

/** Every `from '...'` specifier a file imports from, in order. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

async function generateInto(importExtension?: ImportExtension, tables = [users]) {
  const dir = await mkdtemp(join(tmpdir(), 'drzl-trpc-barrel-'));
  await new TRPCGenerator(analysis(tables)).generate({
    outputDir: dir,
    importExtension,
    format: { enabled: false },
  });
  return {
    dir,
    barrel: await readFile(join(dir, 'index.ts'), 'utf8'),
    router: await readFile(join(dir, `${tables[0].tsName}.ts`), 'utf8'),
  };
}

describe('the app router', () => {
  it('is a real router rather than an object literal', async () => {
    // oRPC's index file exports a plain object, which is all oRPC needs. A nested tRPC router has
    // to be built by `router()`, and `typeof appRouter` is the entire client contract: without it
    // the generated tree is a server nothing can be typed against.
    const { barrel } = await generateInto(undefined, [users, posts]);
    expect(barrel).toContain('export const appRouter = router({');
    expect(barrel).toContain('export type AppRouter = typeof appRouter;');
    expect(barrel).toContain('  users: usersRouter,');
    expect(barrel).toContain('  posts: postsRouter,');
  });

  it('re-exports what a consumer needs to stand a server up', async () => {
    const { barrel } = await generateInto();
    expect(barrel).toContain('export { createCallerFactory, publicProcedure, router }');
    expect(barrel).toContain("export type { Context } from './trpc.js'");
  });

  it('re-exports the database procedure only when there is one', async () => {
    const { barrel } = await generateInto();
    expect(barrel).not.toContain('dbProcedure');

    const dir = await mkdtemp(join(tmpdir(), 'drzl-trpc-barrel-db-'));
    await new TRPCGenerator(analysis([users])).generate({
      outputDir: dir,
      format: { enabled: false },
      databaseInjection: { enabled: true, databaseType: 'Database' },
    });
    expect(await readFile(join(dir, 'index.ts'), 'utf8')).toContain('export { dbProcedure }');
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the table name as written for the client namespace', async () => {
    // This key is the public API: `trpc.userProfiles.list.query()`. The oRPC barrel lowercases
    // it, which turns `userProfiles` into `userprofiles`; harmless in an object nobody reads, and
    // not harmless when a typed client is spelled through it.
    const profiles = { ...users, name: 'user_profiles', tsName: 'userProfiles' };
    const { barrel } = await generateInto(undefined, [profiles as never]);
    expect(barrel).toContain('  userProfiles: userProfilesRouter,');
  });
});

describe('import extensions', () => {
  const cases: [ImportExtension | undefined, string, string][] = [
    // Unset has to behave exactly like 'js'.
    [undefined, './trpc.js', './users.js'],
    ['js', './trpc.js', './users.js'],
    ['none', './trpc', './users'],
    ['ts', './trpc.ts', './users.ts'],
  ];

  for (const [importExtension, base, router] of cases) {
    it(`spells both the base and the router with ${importExtension ?? 'unset'}`, async () => {
      const { dir, barrel, router: routerFile } = await generateInto(importExtension);
      try {
        // The barrel reaches the base and every router; a router reaches only the base.
        expect(specifiers(barrel)).toEqual([base, router, base, base]);
        expect(specifiers(routerFile)).toContain(base);
        // Whatever a specifier spells, it has to land on a file that exists.
        expect(existsSync(join(dir, 'trpc.ts'))).toBe(true);
        expect(existsSync(join(dir, 'users.ts'))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('emits the .js form the default promises', async () => {
    const { dir, barrel } = await generateInto();
    try {
      expect(barrel).toContain("from './users.js'");
      expect(barrel).not.toContain("from './users'");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
