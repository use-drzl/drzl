/**
 * Which procedures a table gets, and what each one takes.
 *
 * The oRPC generator answers "how do I address one row" with `z.object({ id: z.number() })` for
 * every table, whatever its primary key is or whether it has one. That is wrong three ways: it
 * names a column that need not exist, types a uuid key as a number, and hands a composite key one
 * of its two halves. Each case below is a table that generator would have got wrong.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRPCGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  memberships,
  posts,
  users,
} from './fixtures';

/**
 * Emitted with the formatter off, so every assertion below reads the generator's own output.
 *
 * Prettier reflows a short chain onto one line and a long one across five, and rewrites quotes,
 * so an assertion against formatted text is really an assertion about prettier's line budget:
 * adding a column to a fixture would move an unrelated expectation. That the formatter still runs
 * at all is asserted in formatting.spec.ts, which is the only place it should be.
 */
async function router(t = users, opts: Record<string, unknown> = {}) {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-trpc-proc-'));
  await new TRPCGenerator(analysis([t])).generate({
    outputDir,
    format: { enabled: false },
    ...opts,
  } as never);
  return fs.readFile(path.join(outputDir, `${t.tsName}.ts`), 'utf8');
}

/** The procedure keys the router object declares, in order. */
function procedures(source: string): string[] {
  const body = source.slice(source.indexOf('= router({'));
  return [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*|"[^"]+"): (?:public|db)Procedure\b/gm)].map(
    (m) => m[1].replace(/"/g, '')
  );
}

/** The chain for one procedure: from its key to wherever the next one starts. */
function chain(source: string, name: string): string {
  const body = source.slice(source.indexOf('= router({'));
  const start = body.search(new RegExp(`^ {2}"?${name}"?: `, 'm'));
  expect(start, `no procedure named ${name} in:\n${source}`).toBeGreaterThanOrEqual(0);
  const rest = body.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z_$"]/m);
  return body.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe('the CRUD set', () => {
  it('is list, byId, create, update, delete for an ordinary table', async () => {
    expect(procedures(await router())).toEqual(['list', 'byId', 'create', 'update', 'delete']);
  });

  it('reads with query and writes with mutation', async () => {
    const source = await router();
    // A query is what a tRPC client caches and batches over GET; a mutation is what it will not
    // put on a GET, which matters because a proxy may cache one and never the other.
    expect(chain(source, 'list')).toContain('.query(');
    expect(chain(source, 'byId')).toContain('.query(');
    for (const write of ['create', 'update', 'delete']) {
      expect(chain(source, write), write).toContain('.mutation(');
    }
  });

  it('takes no input on list and the insert schema on create', async () => {
    const source = await router();
    expect(chain(source, 'list')).not.toContain('.input(');
    expect(chain(source, 'create')).toContain('.input(InsertusersSchema)');
  });

  it('takes the update schema under `data`, beside the key, on update', async () => {
    expect(chain(await router(), 'update')).toContain(
      '.input(z.object({ id: z.number(), data: UpdateusersSchema }))'
    );
  });

  it('declares an output schema on every procedure', async () => {
    const source = await router();
    expect(chain(source, 'list')).toContain('.output(z.array(SelectusersSchema))');
    expect(chain(source, 'byId')).toContain('.output(SelectusersSchema.nullable())');
    expect(chain(source, 'create')).toContain('.output(SelectusersSchema)');
    expect(chain(source, 'update')).toContain('.output(SelectusersSchema)');
    expect(chain(source, 'delete')).toContain('.output(z.boolean())');
  });
});

describe('the primary key', () => {
  it('is read off the schema rather than assumed to be a number called id', async () => {
    const source = await router(books);
    expect(chain(source, 'byId')).toContain('.input(z.object({ isbn: z.string() }))');
    expect(chain(source, 'delete')).toContain('.input(z.object({ isbn: z.string() }))');
    expect(source).not.toContain('z.number()');
  });

  it('carries every column of a composite key', async () => {
    const source = await router(memberships);
    const expected = '.input(z.object({ orgId: z.number(), userId: z.number() }))';
    expect(chain(source, 'byId')).toContain(expected);
    expect(chain(source, 'delete')).toContain(expected);
    // Still called byId: a caller holding the key does not care how many parts it has, and a
    // client whose procedure names change with the shape of a key is worse than a long input.
    expect(procedures(source)).toContain('byId');
  });

  it('takes the whole composite key beside the patch on update', async () => {
    expect(chain(await router(memberships), 'update')).toContain(
      '.input(z.object({ orgId: z.number(), userId: z.number(), data: UpdatemembershipsSchema }))'
    );
  });
});

describe('a table with no primary key', () => {
  it('loses exactly the procedures that would have needed one', async () => {
    // Not `list` and not `create`: reading every row and inserting a new one need no way to
    // address an existing one.
    expect(procedures(await router(auditLog))).toEqual(['list', 'create']);
  });

  it('invents no id column to stand in for the key it does not have', async () => {
    const source = await router(auditLog);
    expect(source).not.toContain('byId');
    expect(source).not.toMatch(/\bid\b/);
  });
});

describe('a read-only relation', () => {
  it('gets no write procedures, because the database refuses every write to one', async () => {
    expect(procedures(await router(activeUsers))).toEqual(['list', 'byId']);
  });

  it('declares no insert or update schema for rows that can never be written', async () => {
    const source = await router(activeUsers);
    expect(source).not.toContain('InsertactiveUsersSchema');
    expect(source).not.toContain('UpdateactiveUsersSchema');
    expect(source).toContain('SelectactiveUsersSchema');
  });
});

describe('relation lookups', () => {
  it('are absent unless asked for', async () => {
    expect(procedures(await router(posts))).not.toContain('listByAuthorId');
  });

  it('add one query per single-column foreign key, named after the column', async () => {
    const source = await router(posts, { includeRelations: true });
    expect(procedures(source)).toContain('listByAuthorId');
    const lookup = chain(source, 'listByAuthorId');
    expect(lookup).toContain('.input(z.object({ authorId: z.number() }))');
    expect(lookup).toContain('.output(z.array(SelectpostsSchema))');
    expect(lookup).toContain('.query(');
  });

  it('leaves the CRUD set exactly as it was', async () => {
    // Appended, never substituted, so the client surface is the same with the flag on and off
    // apart from the additions.
    expect(procedures(await router(posts, { includeRelations: true }))).toEqual([
      ...procedures(await router(posts)),
      'listByAuthorId',
    ]);
  });
});

describe('stubs', () => {
  it('throw from create and update rather than returning the input', async () => {
    // The input is the insert or update shape, where generated and defaulted columns are
    // optional; `.output()` declares the select shape, where they are required. tRPC typechecks a
    // handler's return against its output parser, so returning the input is a compile error and
    // not a loose placeholder. A body that only throws has type `never`.
    const source = await router();
    for (const name of ['create', 'update']) {
      expect(chain(source, name), name).toMatch(/throw new Error\(/);
      expect(chain(source, name), name).not.toMatch(/return\s+_?input/);
    }
  });

  it('answer the reads that have a valid empty answer', async () => {
    const source = await router();
    expect(chain(source, 'list')).toContain('return [];');
    expect(chain(source, 'byId')).toContain('return null;');
    expect(chain(source, 'delete')).toContain('return true;');
  });
});

describe('naming', () => {
  it('applies procedureCase to the procedure keys', async () => {
    const source = await router(users, { naming: { procedureCase: 'snake' } });
    expect(procedures(source)).toContain('by_id');
  });

  it('quotes a key that is not an identifier rather than emitting invalid syntax', async () => {
    const source = await router(users, { naming: { procedureCase: 'kebab' } });
    expect(source).toContain('"by-id":');
  });
});

describe('a column DRZL cannot type', () => {
  it('gets a validator that accepts anything, and the file says so', async () => {
    const wide = {
      ...posts,
      columns: [...posts.columns, { ...posts.columns[2], name: 'meta', tsType: 'Buffer' }],
    };
    const source = await router(wide as never);
    expect(source).toContain('meta: z.unknown()');
    expect(source).toContain('No validated type for this column: meta.');
  });

  it('says nothing when every column is typed', async () => {
    expect(await router()).not.toContain('No validated type');
  });
});
