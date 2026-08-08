/**
 * Two tables of the same name in different SQL schemas, addressed by one document.
 *
 * A path is the one place in this generator where the *database* name is load-bearing rather than
 * decorative, and it was the one surface that already knew multi-schema was coming: `claim` threw
 * on the duplicate rather than emitting a document where one table silently overwrote the other.
 * Throwing was right while there was nothing better to spell. There is now.
 *
 * The default schema keeps `/users`, byte for byte, because that is what every existing document
 * says and because Drizzle refuses `pgSchema('public')` outright, so a bare table has no other
 * name it could take. A schema-qualified table takes `/reporting/users`.
 */
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/index';
import { col, serial, table, users } from './fixtures';

const reportingUsers = () =>
  table({
    name: 'users',
    tsName: 'reportingUsers',
    schema: 'reporting',
    columns: [serial('id'), col('label')],
    primaryKey: { columns: ['id'] },
  });

const reportingNotes = () =>
  table({
    name: 'notes',
    tsName: 'reportingNotes',
    schema: 'reporting',
    columns: [serial('id'), serial('userId')],
    primaryKey: { columns: ['id'] },
    foreignKeys: [
      {
        columns: ['userId'],
        foreignTable: 'users',
        foreignSchema: 'reporting',
        foreignColumns: ['id'],
      },
    ],
  });

/** The same child, pointing at `public.users` instead. */
const publicNotes = () =>
  table({
    name: 'notes_pub',
    tsName: 'publicNotes',
    columns: [serial('id'), serial('userId')],
    primaryKey: { columns: ['id'] },
    foreignKeys: [{ columns: ['userId'], foreignTable: 'users', foreignColumns: ['id'] }],
  });

const doc = (tables: unknown[], opts = {}) => openApiDocument(tables as never, opts) as any;

describe('paths', () => {
  it('emits both tables rather than refusing the document', () => {
    const paths = Object.keys(doc([users(), reportingUsers()]).paths);
    expect(paths).toContain('/users');
    expect(paths).toContain('/reporting/users');
  });

  it('leaves a schema-less table exactly where it was', () => {
    expect(Object.keys(doc([users()]).paths)).toEqual(['/users', '/users/{id}']);
  });

  it('gives the qualified table its own item path', () => {
    const paths = Object.keys(doc([users(), reportingUsers()]).paths);
    expect(paths).toContain('/users/{id}');
    expect(paths).toContain('/reporting/users/{id}');
  });

  it('percent-encodes a schema name that is not path safe', () => {
    const t = table({
      name: 'users',
      tsName: 'oddUsers',
      schema: 'a b',
      columns: [serial('id')],
      primaryKey: { columns: ['id'] },
    });
    expect(Object.keys(doc([t]).paths)).toContain('/a%20b/users');
  });
});

describe('tags', () => {
  it('names each table by its qualified name, so the two do not merge', () => {
    const d = doc([users(), reportingUsers()]);
    expect(d.tags.map((t: any) => t.name)).toEqual(['users', 'reporting.users']);
  });

  it('tags every operation with the qualified name', () => {
    const d = doc([users(), reportingUsers()]);
    expect(d.paths['/reporting/users'].get.tags).toEqual(['reporting.users']);
    expect(d.paths['/users'].get.tags).toEqual(['users']);
  });
});

describe('a nested path from a foreign key', () => {
  it('follows the key into its own schema and not the other one', () => {
    const paths = Object.keys(
      doc([users(), reportingUsers(), reportingNotes()], { includeRelations: true }).paths
    );
    expect(paths).toContain('/reporting/users/{id}/reporting/notes');
    expect(paths).not.toContain('/users/{id}/reporting/notes');
  });

  it('follows a key into the default schema the same way', () => {
    const paths = Object.keys(
      doc([users(), reportingUsers(), publicNotes()], { includeRelations: true }).paths
    );
    expect(paths).toContain('/users/{id}/notes_pub');
    expect(paths).not.toContain('/reporting/users/{id}/notes_pub');
  });
});

describe('a genuine path clash', () => {
  /**
   * A table whose *own* name contains a slash cannot reach the two-segment path, because each
   * half is encoded separately: `reporting/users` becomes the single segment
   * `reporting%2Fusers`. So splitting on the schema did not open a new way for two tables to want
   * one path, which was the thing worth checking before taking the guard's job away from it.
   */
  it('does not let a slash in a table name reach a schema path', () => {
    const odd = table({
      name: 'reporting/users',
      tsName: 'odd',
      columns: [serial('id')],
      primaryKey: { columns: ['id'] },
    });
    const paths = Object.keys(doc([reportingUsers(), odd]).paths);
    expect(paths).toContain('/reporting/users');
    expect(paths).toContain('/reporting%2Fusers');
  });

  it('still refuses two exports of one table name in one schema', () => {
    // Drizzle allows it, and one path names one resource, so the guard is still the only thing
    // between that schema and a document where the second table silently replaces the first.
    const twin = table({
      name: 'users',
      tsName: 'usersAgain',
      columns: [serial('id')],
      primaryKey: { columns: ['id'] },
    });
    expect(() => doc([users(), twin])).toThrow(/claimed twice/);
  });
});
