/**
 * The emitted router is driven through real oRPC calls, addressing a natural-key row and a
 * composite-key row end to end.
 *
 * Typechecking proves the call composes; only running it proves the input schema actually
 * admits a varchar key, that `Service.getById(input.isbn)` reaches the service with the right
 * value, and that the composite input's two columns arrive as two arguments in key order.
 * Under the old hardcoded `{ id: z.number() }` every one of these calls was unmakeable: the
 * schema refused `{ isbn: ... }` outright, so no natural-key row could be addressed at all.
 *
 * `call` is @orpc/server's own in-process invoker, so the whole procedure pipeline runs:
 * input validation, handler, output validation.
 *
 * `importExtension: 'none'` because this module graph is loaded by vite, which resolves
 * `./books` to `./books.ts`. The `.js` default is the one a real tsc resolves, and it is
 * compiled in output-compile.spec.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from '@orpc/server';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { ORPCGenerator } from '../src';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workDir = path.join('test', 'tmp', 'runtime');
const absWork = path.join(pkgRoot, workDir);

function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

const books: Table = {
  name: 'books',
  tsName: 'books',
  columns: [col('isbn', 'string'), col('title', 'string')],
  primaryKey: { columns: ['isbn'] },
  unique: [],
  indexes: [],
} as Table;

const memberships: Table = {
  name: 'memberships',
  tsName: 'memberships',
  columns: [col('orgId', 'number'), col('userId', 'string'), col('role', 'string')],
  primaryKey: { columns: ['orgId', 'userId'] },
  unique: [],
  indexes: [],
} as Table;

const analysis: Analysis = {
  dialect: 'sqlite',
  tables: [books, memberships],
  enums: [],
  relations: [],
  issues: [],
};

/** In-memory stand-ins with exactly the signatures `@drzl/generator-service` emits post-BP. */
const BOOK_SERVICE = `
export interface Book { isbn: string; title: string }
const rows: Book[] = [];

export class BookService {
  static async getAll(): Promise<Book[]> {
    return rows;
  }
  static async getById(id: string): Promise<Book | null> {
    return rows.find((r) => r.isbn === id) ?? null;
  }
  static async create(input: Book): Promise<Book> {
    rows.push({ ...input });
    return { ...input };
  }
  static async update(id: string, data: Partial<Omit<Book, 'isbn'>>): Promise<Book> {
    const row = rows.find((r) => r.isbn === id);
    if (!row) throw new Error('no such row');
    Object.assign(row, data);
    return { ...row };
  }
  static async delete(id: string): Promise<boolean> {
    const at = rows.findIndex((r) => r.isbn === id);
    if (at !== -1) rows.splice(at, 1);
    return at !== -1;
  }
}
`;

const MEMBERSHIP_SERVICE = `
export interface Membership { orgId: number; userId: string; role: string }
const rows: Membership[] = [];

export class MembershipService {
  static async getAll(): Promise<Membership[]> {
    return rows;
  }
  static async getById(orgId: number, userId: string): Promise<Membership | null> {
    return rows.find((r) => r.orgId === orgId && r.userId === userId) ?? null;
  }
  static async create(input: Membership): Promise<Membership> {
    rows.push({ ...input });
    return { ...input };
  }
  static async update(
    orgId: number,
    userId: string,
    data: Partial<Omit<Membership, 'orgId' | 'userId'>>
  ): Promise<Membership> {
    const row = rows.find((r) => r.orgId === orgId && r.userId === userId);
    if (!row) throw new Error('no such row');
    Object.assign(row, data);
    return { ...row };
  }
  static async delete(orgId: number, userId: string): Promise<boolean> {
    const at = rows.findIndex((r) => r.orgId === orgId && r.userId === userId);
    if (at !== -1) rows.splice(at, 1);
    return at !== -1;
  }
}
`;

/** Every call and its answer, printed when the suite runs with DRZL_ORPC_TRANSCRIPT set. */
const transcript: string[] = [];

let router: Record<string, Record<string, never>>;

async function invoke(procedure: string, input?: unknown): Promise<unknown> {
  const [ns, name] = procedure.split('.');
  try {
    const out = await call(router[ns][name], input);
    transcript.push(`call ${procedure} ${JSON.stringify(input)}\n  -> ${JSON.stringify(out)}`);
    return out;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    transcript.push(
      `call ${procedure} ${JSON.stringify(input)}\n  -> threw ${err.code ?? ''} ${err.message ?? e}`
    );
    throw e;
  }
}

beforeAll(async () => {
  await fs.rm(absWork, { recursive: true, force: true });
  await fs.mkdir(path.join(absWork, 'services'), { recursive: true });
  await fs.writeFile(path.join(absWork, 'services', 'bookService.ts'), BOOK_SERVICE, 'utf8');
  await fs.writeFile(
    path.join(absWork, 'services', 'membershipService.ts'),
    MEMBERSHIP_SERVICE,
    'utf8'
  );

  await new ORPCGenerator(analysis).generate({
    outputDir: path.join(workDir, 'api'),
    template: '@drzl/template-orpc-service',
    servicesDir: path.join(workDir, 'services'),
    importExtension: 'none',
  });

  const barrel = pathToFileURL(path.join(absWork, 'api', 'index.ts')).href;
  // `any` because the module is generated at run time: its real types are compiled by tsc in
  // output-compile.spec.ts; this suite is about behavior.
  ({ router } = (await import(/* @vite-ignore */ barrel)) as { router: unknown } as never);
}, 60_000);

afterAll(async () => {
  if (process.env.DRZL_ORPC_TRANSCRIPT) console.log(transcript.join('\n'));
  await fs.rm(absWork, { recursive: true, force: true });
});

describe('a natural-key row, end to end', () => {
  it('creates, addresses, patches and deletes by the varchar key', async () => {
    expect(await invoke('books.list')).toEqual([]);
    const created = await invoke('books.create', { isbn: '978-3', title: 'SICP' });
    expect(created).toEqual({ isbn: '978-3', title: 'SICP' });

    expect(await invoke('books.get', { isbn: '978-3' })).toEqual(created);
    expect(await invoke('books.get', { isbn: 'no-such' })).toBeNull();

    expect(await invoke('books.update', { isbn: '978-3', data: { title: 'SICP 2e' } })).toEqual({
      isbn: '978-3',
      title: 'SICP 2e',
    });

    expect(await invoke('books.delete', { isbn: '978-3' })).toBe(true);
    expect(await invoke('books.get', { isbn: '978-3' })).toBeNull();
  });

  it('rejects a payload the key schema refuses, before the handler runs', async () => {
    // The old hardcoded input would have *required* this shape. Now it is the one that fails.
    await expect(invoke('books.get', { id: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(invoke('books.get', { isbn: 42 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('a composite-key row, end to end', () => {
  it('tells two rows sharing a key column apart by the full key', async () => {
    await invoke('memberships.create', { orgId: 1, userId: 'a', role: 'admin' });
    await invoke('memberships.create', { orgId: 1, userId: 'b', role: 'viewer' });

    expect(await invoke('memberships.get', { orgId: 1, userId: 'b' })).toEqual({
      orgId: 1,
      userId: 'b',
      role: 'viewer',
    });

    expect(
      await invoke('memberships.update', { orgId: 1, userId: 'b', data: { role: 'editor' } })
    ).toEqual({ orgId: 1, userId: 'b', role: 'editor' });
    expect(await invoke('memberships.get', { orgId: 1, userId: 'a' })).toEqual({
      orgId: 1,
      userId: 'a',
      role: 'admin',
    });

    expect(await invoke('memberships.delete', { orgId: 1, userId: 'a' })).toBe(true);
    expect(await invoke('memberships.get', { orgId: 1, userId: 'a' })).toBeNull();
    expect(await invoke('memberships.get', { orgId: 1, userId: 'b' })).not.toBeNull();
  });

  it('refuses a partial key', async () => {
    await expect(invoke('memberships.get', { orgId: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
