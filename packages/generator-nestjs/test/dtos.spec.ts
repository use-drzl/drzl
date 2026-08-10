/**
 * The emitted source, read as text: which classes and schemas each table module carries, the
 * presence rule on insert, the primary key excluded from update, and the options that shape
 * file names and specifiers. The runtime spec executes the same output; this file is where the
 * exact emitted spellings are pinned.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NestJSGenerator } from '../src';
import type { Table } from '@drzl/analyzer';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
  memberships,
  table,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const workRoot = path.join(pkgRoot, 'test', 'tmp', 'dtos');

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

let n = 0;
async function emit(tables: Table[], opts: Record<string, unknown> = {}) {
  const dir = path.join(workRoot, `case-${n++}`);
  await fs.rm(dir, { recursive: true, force: true });
  await new NestJSGenerator(analysis(tables)).generate({ outputDir: dir, ...opts } as never);
  return {
    read: (name: string) => fs.readFile(path.join(dir, name), 'utf8'),
    list: () => fs.readdir(dir),
  };
}

describe('a table module', () => {
  it('exports the three mode schemas, the params schema, and the four classes', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    for (const name of [
      'export const InsertusersSchema',
      'export const UpdateusersSchema',
      'export const SelectusersSchema',
      'export const UsersParamsSchema',
      'export class CreateUsersDto',
      'export class UpdateUsersDto',
      'export class UsersParamsDto',
      'export class UsersEntity',
    ]) {
      expect(src).toContain(name);
    }
  });

  it('pairs every class with its schema through the typed static, so drift is a compile error', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    expect(src).toContain(
      'static readonly schema: StandardSchema<CreateUsersDto> = InsertusersSchema;'
    );
    expect(src).toContain(
      'static readonly schema: StandardSchema<UpdateUsersDto> = UpdateusersSchema;'
    );
    expect(src).toContain(
      'static readonly schema: StandardSchema<UsersParamsDto> = UsersParamsSchema;'
    );
    expect(src).toContain('static readonly schema: StandardSchema<UsersEntity> = SelectusersSchema;');
  });

  it('lets a nullable no-default column be omitted on insert, as the database does', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    // bio is nullable with no default, so it is optional at its nullable type: an INSERT that
    // omits it stores NULL, which a real Postgres accepts. email is NOT NULL with no default and
    // stays required, which is what makes this a rule about what the database can fill in rather
    // than a blanket loosening. Both regions are sliced out first: a lazy match run against the
    // whole file bridges into the select schema, where the required spelling legitimately lives,
    // and passes whatever the insert schema says.
    const insert = src.slice(src.indexOf('InsertusersSchema'), src.indexOf('UpdateusersSchema'));
    expect(insert).toContain('bio: z.string().nullable().optional(),');
    expect(insert).toContain('email: z.string(),');
    expect(insert).toMatch(/role: z\.enum\(\['admin', 'member'\] as const\)\.optional\(\)/);
    const createDto = src.slice(src.indexOf('class CreateUsersDto'), src.indexOf('class UpdateUsersDto'));
    expect(createDto).toContain('bio?: string | null;');
    expect(createDto).toContain('email!: string;');
    expect(createDto).toContain("role?: 'admin' | 'member';");
  });

  it('keeps the required spelling where it belongs: the select schema and its entity', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    // The counter-check for the slicing above. On select the database guarantees the column is
    // there, so bio is nullable and NOT optional, and the entity states the same.
    const select = src.slice(src.indexOf('SelectusersSchema'));
    expect(select).toContain('bio: z.string().nullable(),');
    const entity = src.slice(src.indexOf('class UsersEntity'));
    expect(entity).toContain('bio!: string | null;');
  });

  it('excludes the primary key from the update DTO', async () => {
    const { read } = await emit([users, memberships]);
    const src = await read('users.ts');
    const update = src.slice(src.indexOf('UpdateusersSchema'), src.indexOf('SelectusersSchema'));
    expect(update).not.toContain('id:');
    const m = await read('memberships.ts');
    const mUpdate = m.slice(m.indexOf('UpdatemembershipsSchema'), m.indexOf('SelectmembershipsSchema'));
    expect(mUpdate).not.toContain('orgId');
    expect(mUpdate).not.toContain('userId');
    expect(mUpdate).toContain('role');
  });

  it('makes every update field optional and keeps nullability', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    expect(src).toMatch(/UpdateusersSchema = z\.object\(\{[\s\S]*?bio: z\.string\(\)\.nullable\(\)\.optional\(\),/);
    expect(src).toMatch(/class UpdateUsersDto \{[\s\S]*?email\?: string;/);
    expect(src).toMatch(/class UpdateUsersDto \{[\s\S]*?bio\?: string \| null;/);
  });

  it('emits entity fields for every column at select shape', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    expect(src).toMatch(/class UsersEntity \{[\s\S]*?id!: number;[\s\S]*?email!: string;[\s\S]*?bio!: string \| null;[\s\S]*?role!: 'admin' \| 'member';/);
  });

  it('spells the wire shape of Date and bigint columns', async () => {
    const { read } = await emit([events]);
    const src = await read('events.ts');
    // Insert: a JSON body cannot carry a Date instance, so the schema takes the strict ISO
    // string and hands the controller a Date. bigint crosses as its decimal digits and stays a
    // string on both sides.
    expect(src).toContain("at: z.iso.datetime().transform((s) => new Date(s))");
    expect(src).toMatch(/big: z\.string\(\)\.regex\(\/\^-\?\\d\+\$\/\)/);
    expect(src).toMatch(/class CreateEventsDto \{[\s\S]*?at!: Date;/);
    expect(src).toMatch(/class CreateEventsDto \{[\s\S]*?big!: string;/);
    // Select: the entity states what a handler returns; a Drizzle row carries a real Date.
    expect(src).toMatch(/SelecteventsSchema = z\.object\(\{[\s\S]*?at: z\.date\(\),/);
    expect(src).toMatch(/class EventsEntity \{[\s\S]*?at!: Date;/);
    expect(src).toMatch(/class EventsEntity \{[\s\S]*?big!: string;/);
  });

  it('validates a shaped or untypeable column as unknown, and says so for the untypeable one', async () => {
    const { read } = await emit([auditLog, events]);
    const audit = await read('auditLog.ts');
    expect(audit).toContain('payload: z.unknown()');
    expect(audit).toContain('// No validated type for this column: payload.');
    const ev = await read('events.ts');
    expect(ev).toContain('point: z.unknown()');
    // A tuple shape is a shape, not an analyzer failure, so it carries no note.
    expect(ev).not.toContain('No validated type');
  });

  it('quotes a column name that is not an identifier, in the schema and the class alike', async () => {
    const { read } = await emit([books]);
    const src = await read('books.ts');
    // Prettier normalises the emitted double-quoted key to single quotes; both spellings are
    // the same quoted key, and what matters is that it is quoted at all.
    expect(src).toContain("'cover url': z.string().nullable()");
    expect(src).toContain("'cover url'!: string | null;");
  });
});

describe('what a table loses', () => {
  it('read-only: no insert or update schema, no create or update DTO', async () => {
    const { read } = await emit([activeUsers]);
    const src = await read('activeUsers.ts');
    expect(src).not.toContain('InsertactiveUsersSchema');
    expect(src).not.toContain('UpdateactiveUsersSchema');
    expect(src).not.toContain('CreateActiveUsersDto');
    expect(src).not.toContain('UpdateActiveUsersDto');
    expect(src).toContain('export class ActiveUsersEntity');
    expect(src).toContain('export class ActiveUsersParamsDto');
  });

  it('keyless: no params schema and no params DTO', async () => {
    const { read } = await emit([auditLog]);
    const src = await read('auditLog.ts');
    expect(src).not.toContain('ParamsSchema');
    expect(src).not.toContain('ParamsDto');
    expect(src).toContain('export class CreateAuditLogDto');
  });

  it('read-only and keyless: the entity alone', async () => {
    const { read } = await emit([dailyTotals]);
    const src = await read('dailyTotals.ts');
    expect(src).toContain('export class DailyTotalsEntity');
    expect(src).not.toContain('Dto');
  });
});

describe('the params DTO', () => {
  it('parses a numeric key strictly and types the field number', async () => {
    const { read } = await emit([users]);
    const src = await read('users.ts');
    // Whitespace-tolerant: prettier wraps the chain across lines.
    expect(src).toMatch(
      /id: z\s*\.string\(\)\s*\.regex\(\/\^-\?\\d\+\(\\\.\\d\+\)\?\$\/\)\s*\.transform\(Number\)/
    );
    expect(src).toMatch(/class UsersParamsDto \{[\s\S]*?id!: number;/);
  });

  it('keeps a string key a string and a composite key whole', async () => {
    const { read } = await emit([books, memberships]);
    const b = await read('books.ts');
    expect(b).toMatch(/BooksParamsSchema = z\.object\(\{ isbn: z\.string\(\) \}\)/);
    const m = await read('memberships.ts');
    expect(m).toMatch(/MembershipsParamsSchema = z\.object\(\{\s*orgId: [\s\S]*?userId: /);
    expect(m).toMatch(/class MembershipsParamsDto \{[\s\S]*?orgId!: number;[\s\S]*?userId!: number;/);
  });
});

describe('the other libraries', () => {
  it('valibot: same classes, valibot spellings, omissible nullable on insert', async () => {
    const { read } = await emit([users, events], { validation: { library: 'valibot' } });
    const src = await read('users.ts');
    expect(src).toContain("import * as v from 'valibot';");
    const insert = src.slice(src.indexOf('InsertusersSchema'), src.indexOf('UpdateusersSchema'));
    expect(insert).toContain('bio: v.optional(v.nullable(v.string())),');
    expect(src).toContain('static readonly schema: StandardSchema<CreateUsersDto> = InsertusersSchema;');
    const ev = await read('events.ts');
    expect(ev).toContain('v.isoTimestamp()');
    expect(ev).toMatch(/big: v\.pipe\(v\.string\(\), v\.regex\(\/\^-\?\\d\+\$\/\)\)/);
  });

  it('arktype: same classes, and objects strip undeclared keys like the other two libraries', async () => {
    const { read } = await emit([users], { validation: { library: 'arktype' } });
    const src = await read('users.ts');
    expect(src).toContain("import { type } from 'arktype';");
    expect(src).toContain(".onUndeclaredKey('delete')");
    const createDto = src.slice(src.indexOf('class CreateUsersDto'), src.indexOf('class UpdateUsersDto'));
    expect(createDto).toContain('bio?: string | null;');
  });
});

describe('naming and options', () => {
  it('applies routerSuffix and procedureCase to file names only', async () => {
    const { list, read } = await emit([users], {
      naming: { routerSuffix: 'Dto', procedureCase: 'kebab' },
    });
    expect((await list()).sort()).toEqual(['index.ts', 'users-dto.ts', 'validation.ts']);
    const src = await read('users-dto.ts');
    expect(src).toContain('export class CreateUsersDto');
  });

  it('refuses a table that would overwrite the barrel or the validation module', async () => {
    for (const name of ['index', 'validation']) {
      await expect(emit([table(name, { columns: [] })])).rejects.toThrow(/naming\.routerSuffix/);
    }
  });

  it('spells relative specifiers the way importExtension asks', async () => {
    const js = await emit([users]);
    expect(await js.read('index.ts')).toContain("export * from './users.js';");
    expect(await js.read('users.ts')).toContain("from './validation.js';");
    const none = await emit([users], { importExtension: 'none' });
    expect(await none.read('index.ts')).toContain("export * from './users';");
    expect(await none.read('users.ts')).toContain("from './validation';");
  });

  it('honours the output header options', async () => {
    const custom = await emit([users], { outputHeader: { text: 'hello world' } });
    expect(await custom.read('users.ts')).toContain('// hello world');
    const off = await emit([users], { outputHeader: { enabled: false } });
    expect(await off.read('users.ts')).not.toContain('Generated by DRZL');
  });
});

describe('the barrel and the validation module', () => {
  it('re-exports every table module and the validation module', async () => {
    const { read } = await emit([users, auditLog]);
    const src = await read('index.ts');
    expect(src).toContain("export * from './users.js';");
    expect(src).toContain("export * from './auditLog.js';");
    expect(src).toContain("export * from './validation.js';");
  });

  it('emits the pipe even for an empty schema, so consumer imports stay stable', async () => {
    const { read, list } = await emit([]);
    expect((await list()).sort()).toEqual(['index.ts', 'validation.ts']);
    expect(await read('index.ts')).toContain("export * from './validation.js';");
    expect(await read('index.ts')).toContain('No tables detected');
  });

  it('names the ValidationPipe options story in the pipe module', async () => {
    const { read } = await emit([users]);
    const src = await read('validation.ts');
    expect(src).toContain('export class SchemaValidationPipe');
    expect(src).toContain("'~standard'");
    expect(src).toContain('BadRequestException');
  });
});
