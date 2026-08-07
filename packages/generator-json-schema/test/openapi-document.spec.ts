/**
 * The document around the schemas: paths, verbs, bodies and status codes.
 *
 * `componentsDocument` already produces the half of an OpenAPI document that describes rows. This
 * is the other half, and almost every decision in it is about keys, because a path is how a
 * document addresses a row and the schema is the only thing that says whether one can be addressed
 * at all.
 */
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/index';
import { activeUsers, col, events, orgMembers, posts, sessions, users } from './fixtures';

const doc = (tables = [users()], opts = {}) => openApiDocument(tables, opts) as any;

describe('the document itself', () => {
  it('declares 3.1 for the 3.1 target and 3.0 for the 3.0 one', () => {
    expect(doc([users()], { target: 'openapi-3.1' }).openapi).toBe('3.1.1');
    expect(doc([users()], { target: 'openapi-3.0' }).openapi).toBe('3.0.3');
  });

  it('treats the plain 2020-12 target as 3.1, which is the dialect it already is', () => {
    // The two differ only by `$schema`, which a document has to drop anyway, so there is no third
    // spelling of an OpenAPI document to emit.
    expect(doc([users()], { target: 'draft-2020-12' }).openapi).toBe('3.1.1');
    expect(doc([users()], { target: 'draft-2020-12' }).components).toEqual(
      doc([users()], { target: 'openapi-3.1' }).components
    );
  });

  it('carries the required info fields, and says where the document came from', () => {
    const info = doc().info;
    expect(info.title).toBe('API');
    expect(info.version).toBe('0.0.0');
    expect(info.description).toMatch(/DRZL/);
  });

  it('takes info from the caller when given', () => {
    const info = doc([users()], { info: { title: 'Shop', version: '2.1.0' } }).info;
    expect(info.title).toBe('Shop');
    expect(info.version).toBe('2.1.0');
  });

  it('emits no servers, because the schema does not say where the API is served', () => {
    // An empty or absent `servers` means a single server at `/`, which is the true statement:
    // the document is relative to wherever it is being served from.
    expect(doc()).not.toHaveProperty('servers');
    expect(doc([users()], { servers: [{ url: 'https://api.example.com' }] }).servers).toEqual([
      { url: 'https://api.example.com' },
    ]);
  });

  it('gives every table a tag, and every operation carries it', () => {
    const d = doc([users(), posts()]);
    expect(d.tags.map((t: any) => t.name)).toEqual(['users', 'posts']);
    for (const item of Object.values<any>(d.paths)) {
      for (const [verb, op] of Object.entries<any>(item)) {
        if (verb === 'parameters') continue;
        expect(op.tags, verb).toHaveLength(1);
      }
    }
  });
});

describe('the path set', () => {
  it('names the resource after the database table name', () => {
    // `include`/`exclude` in the config already match on the database name, so that is the name a
    // DRZL user already thinks of a table by.
    expect(Object.keys(doc([orgMembers()]).paths)[0]).toBe('/org_members');
  });

  it('is a collection and an item path per table', () => {
    expect(Object.keys(doc([users()]).paths)).toEqual(['/users', '/users/{id}']);
  });

  it('refuses two tables that would claim the same path', () => {
    const a = users();
    const b = { ...users(), tsName: 'people' };
    expect(() => openApiDocument([a, b as never])).toThrow(/users/);
  });

  it('gives every operation a unique operationId', () => {
    const d = doc([users(), posts(), sessions(), orgMembers(), events(), activeUsers()]);
    const ids: string[] = [];
    for (const item of Object.values<any>(d.paths)) {
      for (const [verb, op] of Object.entries<any>(item)) {
        if (verb === 'parameters') continue;
        ids.push(op.operationId);
      }
    }
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('keys', () => {
  it('names the path parameter after the key column, not after "id"', () => {
    // The oRPC generator emits `z.object({ id: z.number() })` for every table, which names a
    // column that may not exist and types it as a number when it is a uuid. The tRPC generator
    // reads the real primary key instead, and this follows that one.
    const d = doc([sessions()]);
    expect(Object.keys(d.paths)).toEqual(['/sessions', '/sessions/{token}']);
    const [p] = d.paths['/sessions/{token}'].parameters;
    expect(p).toMatchObject({ name: 'token', in: 'path', required: true });
    expect(p.schema).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('types the path parameter from the column rather than assuming a number', () => {
    const [p] = doc([users()]).paths['/users/{id}'].parameters;
    expect(p.schema).toMatchObject({ type: 'integer' });
  });

  it('gives a composite key one segment per column', () => {
    const d = doc([orgMembers()]);
    expect(Object.keys(d.paths)).toEqual(['/org_members', '/org_members/{orgId}/{userId}']);
    const names = d.paths['/org_members/{orgId}/{userId}'].parameters.map((p: any) => p.name);
    expect(names).toEqual(['orgId', 'userId']);
  });

  it('emits no item path at all for a table nothing addresses', () => {
    const d = doc([events()]);
    expect(Object.keys(d.paths)).toEqual(['/events']);
    expect(Object.keys(d.paths['/events'])).toEqual(['get', 'post']);
  });

  it('says in the tag why a keyless table has no item path', () => {
    const [tag] = doc([events()]).tags;
    expect(tag.description).toMatch(/no primary key/i);
  });
});

describe('verbs and bodies', () => {
  it('lists on GET and creates on POST at the collection', () => {
    const item = doc([users()]).paths['/users'];
    expect(Object.keys(item)).toEqual(['get', 'post']);
    expect(item.get.responses['200'].content['application/json'].schema).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/usersSelect' },
    });
    expect(item.post.requestBody).toMatchObject({ required: true });
    expect(item.post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/usersInsert',
    });
  });

  it('reads, patches and deletes at the item path', () => {
    const item = doc([users()]).paths['/users/{id}'];
    expect(Object.keys(item)).toEqual(['parameters', 'get', 'patch', 'delete']);
    expect(item.get.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/usersSelect',
    });
    expect(item.patch.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/usersUpdate',
    });
    expect(item.patch.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/usersSelect',
    });
  });

  it('has no request body on a read or a delete', () => {
    const item = doc([users()]).paths['/users/{id}'];
    expect(item.get).not.toHaveProperty('requestBody');
    expect(item.delete).not.toHaveProperty('requestBody');
  });

  it('emits nothing that writes to a read-only table', () => {
    const d = doc([activeUsers()]);
    expect(Object.keys(d.paths['/active_users'])).toEqual(['get']);
    expect(Object.keys(d.paths['/active_users/{id}'])).toEqual(['parameters', 'get']);
    // The insert and update schemas describe rows the database will never accept, so nothing
    // references them and they are not carried.
    expect(Object.keys(d.components.schemas)).not.toContain('activeUsersInsert');
    expect(Object.keys(d.components.schemas)).not.toContain('activeUsersUpdate');
  });

  it('still creates on a keyless table, since inserting needs no address', () => {
    expect(doc([events()]).paths['/events'].post).toBeTruthy();
  });
});

describe('status codes', () => {
  it('answers a POST with 201 and the row that was created', () => {
    const post = doc([users()]).paths['/users'].post;
    expect(post.responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/usersSelect',
    });
    expect(post.responses).not.toHaveProperty('200');
  });

  it('answers a DELETE with 204 and no body', () => {
    // Returning the deleted row is the alternative, and it is not true on every dialect DRZL
    // supports: RETURNING is Postgres and SQLite, and MySQL has no such clause.
    const del = doc([users()]).paths['/users/{id}'].delete;
    expect(Object.keys(del.responses).sort()).toEqual(['204', '400', '404']);
    expect(del.responses['204']).not.toHaveProperty('content');
    expect(del.responses['204'].description).toBeTruthy();
  });

  it('answers a 404 on every path that names a row and on none that does not', () => {
    const d = doc([users()]);
    for (const verb of ['get', 'patch', 'delete']) {
      expect(Object.keys(d.paths['/users/{id}'][verb].responses), verb).toContain('404');
    }
    expect(Object.keys(d.paths['/users'].get.responses)).not.toContain('404');
    expect(Object.keys(d.paths['/users'].post.responses)).not.toContain('404');
  });

  it('answers the validation failure the schemas exist to cause', () => {
    // A schema that rejects a body is only half a contract: the document has to say what the
    // server sends back when it does.
    const d = doc([users()]);
    expect(Object.keys(d.paths['/users'].post.responses)).toContain('400');
    expect(Object.keys(d.paths['/users/{id}'].patch.responses)).toContain('400');
    // A path parameter is validated too, so a malformed one answers the same way.
    expect(Object.keys(d.paths['/users/{id}'].get.responses)).toContain('400');
    // A list takes nothing, so nothing about it can fail validation.
    expect(Object.keys(d.paths['/users'].get.responses)).toEqual(['200']);
  });

  it('lets the caller move the validation failure to 422', () => {
    const d = doc([users()], { validationStatus: 422 });
    const codes = Object.keys(d.paths['/users'].post.responses);
    expect(codes).toContain('422');
    expect(codes).not.toContain('400');
  });

  it('answers a 409 where a unique constraint can collide, and names it', () => {
    const post = doc([users()]).paths['/users'].post;
    expect(post.responses['409'].description).toMatch(/users_email_key|email/);
  });

  it('gives each document its own Error schema rather than one shared object', () => {
    // Every other part of the document is built per call. One object aliased into every document a
    // process produces is a document that changes when somebody edits an unrelated one.
    const a = doc();
    const b = doc();
    a.components.schemas.Error.properties.message = { type: 'number' };
    expect(b.components.schemas.Error.properties.message).toEqual({ type: 'string' });
  });

  it('points every error response at one Error schema', () => {
    const d = doc([users()]);
    expect(d.components.schemas.Error).toBeTruthy();
    for (const code of ['400', '409']) {
      expect(d.paths['/users'].post.responses[code].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/Error',
      });
    }
  });
});

describe('relations', () => {
  it('emits no sub-resource path unless asked', () => {
    const d = doc([users(), posts()]);
    expect(Object.keys(d.paths)).toEqual(['/users', '/users/{id}', '/posts', '/posts/{id}']);
  });

  it('emits a read-only sub-resource path for a child that names its parent', () => {
    const d = doc([users(), posts()], { includeRelations: true });
    expect(Object.keys(d.paths)).toContain('/users/{id}/posts');
    const item = d.paths['/users/{id}/posts'];
    expect(Object.keys(item)).toEqual(['parameters', 'get']);
    expect(item.get.responses['200'].content['application/json'].schema).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/postsSelect' },
    });
    expect(Object.keys(item.get.responses)).toContain('404');
  });

  it('emits nothing for a child with two keys back to the same parent', () => {
    const child = {
      ...posts(),
      columns: [...posts().columns, col('editorId', { tsType: 'number', dbType: 'INTEGER' })],
      foreignKeys: [
        { columns: ['authorId'], foreignTable: 'users', foreignColumns: ['id'] },
        { columns: ['editorId'], foreignTable: 'users', foreignColumns: ['id'] },
      ],
    };
    const d = doc([users(), child as never], { includeRelations: true });
    expect(Object.keys(d.paths)).not.toContain('/users/{id}/posts');
  });

  it('emits nothing for a self reference, which a path cannot name a direction for', () => {
    const employees = {
      ...users(),
      name: 'employees',
      tsName: 'employees',
      columns: [...users().columns, col('managerId', { tsType: 'number', dbType: 'INTEGER' })],
      foreignKeys: [{ columns: ['managerId'], foreignTable: 'employees', foreignColumns: ['id'] }],
    };
    const d = doc([employees as never], { includeRelations: true });
    expect(Object.keys(d.paths)).toEqual(['/employees', '/employees/{id}']);
  });

  it('hangs no sub-resource off a parent that cannot be addressed', () => {
    const child = {
      ...posts(),
      foreignKeys: [{ columns: ['authorId'], foreignTable: 'events', foreignColumns: ['kind'] }],
    };
    const d = doc([events(), child as never], { includeRelations: true });
    expect(Object.keys(d.paths).filter((p) => p.includes('{'))).toEqual(['/posts/{id}']);
  });
});
