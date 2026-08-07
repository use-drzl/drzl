/**
 * `template: 'service'`, which wires the routers to the classes `@drzl/generator-service` writes.
 *
 * That generator types its key parameter as exactly one `number`, in both of its modes:
 * `getById(id: number)`, `update(id, data)`, `delete(id)`. So a call built from a composite key,
 * or from a `varchar` primary key, does not typecheck against it. Emitting that call anyway is
 * how a generator ships output that reads correctly and does not compile, which is the failure
 * this repository keeps finding after release.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import { analysis, books, memberships, posts, users } from './fixtures';

async function router(t = users, opts: Record<string, unknown> = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-trpc-svc-'));
  await new TRPCGenerator(analysis([t])).generate({
    outputDir,
    template: 'service',
    format: { enabled: false },
    ...opts,
  } as never);
  return fs.readFile(path.join(outputDir, `${t.tsName}.ts`), 'utf8');
}

describe('a numeric single-column key', () => {
  it('reaches the service for every procedure', async () => {
    const source = await router();
    expect(source).toContain('return await UserService.getAll();');
    expect(source).toContain('return await UserService.getById(input.id);');
    expect(source).toContain('return await UserService.create(input);');
    expect(source).toContain('return await UserService.update(input.id, input.data);');
    expect(source).toContain('return await UserService.delete(input.id);');
  });

  /**
   * Both directories are project-relative, so this runs from a project root rather than from a
   * temp output directory: the specifier is what `path.relative` makes of the two, and pointing
   * one of them at /tmp measures the distance to this package instead.
   */
  async function fromProjectRoot(opts: Record<string, unknown> = {}) {
    const cwd = process.cwd();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-trpc-proj-'));
    try {
      process.chdir(root);
      await new TRPCGenerator(analysis([users])).generate({
        outputDir: 'src/api',
        template: 'service',
        format: { enabled: false },
        ...opts,
      } as never);
      return await fs.readFile(path.join(root, 'src', 'api', 'users.ts'), 'utf8');
    } finally {
      process.chdir(cwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('imports the singular service module the service generator writes', async () => {
    // `users` produces `userService.ts` exporting `UserService`. A specifier without `./` is a
    // bare one, which Node resolves in node_modules and never next door.
    expect(await fromProjectRoot()).toContain(
      "import { UserService } from '../services/userService.js';"
    );
  });

  it('follows servicesDir rather than assuming src/services', async () => {
    expect(await fromProjectRoot({ servicesDir: 'src/data' })).toContain(
      "from '../data/userService.js'"
    );
  });

  it('keeps a leading ./ when the services sit inside the output directory', async () => {
    // `path.relative` returns a bare `services` here, which is a *package* specifier to Node.
    expect(await fromProjectRoot({ servicesDir: 'src/api/services' })).toContain(
      "from './services/userService.js'"
    );
  });

  it('destructures only what the handler reads', async () => {
    const source = await router();
    // No `ctx` without injection: the service reaches its own database.
    expect(source).not.toContain('{ ctx');
    expect(source).toContain('.query(async () => {');
  });
});

describe('database injection', () => {
  it('passes the handle from context as the first argument', async () => {
    const source = await router(users, {
      databaseInjection: { enabled: true, databaseType: 'Database' },
    });
    expect(source).toContain('return await UserService.getAll(ctx.db);');
    expect(source).toContain('return await UserService.getById(ctx.db, input.id);');
    expect(source).toContain('return await UserService.update(ctx.db, input.id, input.data);');
    expect(source).toContain('.query(async ({ ctx }) => {');
    expect(source).toContain('.mutation(async ({ ctx, input }) => {');
  });

  it('builds every procedure on the guarded builder', async () => {
    const source = await router(users, {
      databaseInjection: { enabled: true, databaseType: 'Database' },
    });
    expect(source).not.toContain('publicProcedure');
    expect(source.match(/dbProcedure/g)?.length).toBeGreaterThan(1);
  });
});

describe('a key the service layer cannot express', () => {
  it('falls back to a throwing stub for a composite key, and says why', async () => {
    const source = await router(memberships);
    // list and create still reach the service: neither needs a key.
    expect(source).toContain('return await MembershipService.getAll();');
    expect(source).toContain('return await MembershipService.create(input);');
    for (const method of ['getById', 'update(', 'delete(']) {
      expect(source, method).not.toContain(`MembershipService.${method}`);
    }
    expect(source).toContain('has a composite primary key (orgId, userId)');
    expect(source).toMatch(/throw new Error\('Not implemented: byId memberships\.'\)/);
  });

  it('does the same for a non-numeric key', async () => {
    const source = await router(books);
    expect(source).toContain('has a non-numeric primary key (isbn)');
    expect(source).not.toContain('BookService.getById');
    expect(source).toContain('return await BookService.getAll();');
  });

  it('keeps the client surface the same shape either way', async () => {
    // The procedures are still there and still take the real key. Only the body differs, which
    // is what keeps one table's client from looking different to another's.
    const source = await router(books);
    expect(source).toContain('.input(z.object({ isbn: z.string() }))');
    expect(source).toContain('.output(SelectbooksSchema.nullable())');
  });
});

describe('relation lookups in service mode', () => {
  it('say they are unimplemented rather than answering with no rows', async () => {
    // Every other procedure in this file really does reach the database, so an empty array from a
    // lookup would read as "no matching rows". In standard mode everything is a stub and `[]` is
    // consistent with `list`.
    const wired = await router(posts, { includeRelations: true });
    expect(wired).toMatch(/throw new Error\('Not implemented: listByAuthorId posts\.'\)/);

    const stub = await router(posts, { includeRelations: true, template: 'standard' });
    expect(stub).not.toContain('Not implemented: listByAuthorId');
    expect(stub).toContain('return [];');
  });
});
