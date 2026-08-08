/**
 * The emitted schema is built by the real graphql-js and executed, not pattern-matched.
 *
 * `makeExecutableSchema` builds the emitted `typeDefs` + `resolvers` pair, `assertValidSchema`
 * passes it, and every claim is then a `graphql({ schema, source })` execution: a stub resolver
 * throwing is the 500-equivalent that proves the field exists and resolves; a wrong-typed input
 * is rejected by GraphQL itself with the path named; explicit null and absent are distinguished
 * by the runtime, not by a validator DRZL wrote. The scalar hooks are exercised through
 * variables AND inline literals, because parseValue and parseLiteral are different code paths
 * (and on graphql 17 they are different *hook names*, which is exactly the kind of thing only
 * execution can see).
 *
 * Where a test needs to see what a resolver received, the emitted stub is replaced the way a
 * consumer replaces it: spread the emitted resolvers and override one field. That the stub
 * throws, and that the override slots in, are both part of the contract.
 *
 * `importExtension: 'none'` because this module graph is loaded by vite, which resolves
 * `./users` to `./users.ts`. The `.js` default is the form a real tsc resolves, compiled in
 * output-typechecks.spec.ts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertValidSchema,
  buildSchema,
  getIntrospectionQuery,
  graphql,
  parse,
  validate,
  version as graphqlVersion,
  type GraphQLSchema,
} from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLGenerator } from '../src';
import {
  activeUsers,
  analysis,
  auditLog,
  books,
  dailyTotals,
  events,
  memberships,
  metrics,
  tasks,
  users,
} from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const out = path.join(pkgRoot, 'test', 'tmp', 'runtime', 'api');

interface Emitted {
  typeDefs: string;
  resolvers: {
    Query: Record<string, unknown>;
    Mutation?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

let emitted: Emitted;
let schema: GraphQLSchema;

/** The emitted resolvers with test-side overrides, merged the way the docs show a consumer merging. */
function withResolvers(over: {
  Query?: Record<string, unknown>;
  Mutation?: Record<string, unknown>;
}): GraphQLSchema {
  const resolvers = {
    ...emitted.resolvers,
    Query: { ...emitted.resolvers.Query, ...(over.Query ?? {}) },
    Mutation: { ...(emitted.resolvers.Mutation ?? {}), ...(over.Mutation ?? {}) },
  };
  // `as never` because the merged object is typed through this spec's loose Emitted interface,
  // not because the value is loose: the unmerged emitted resolvers pass IResolvers as-is, and
  // output-typechecks.spec.ts compiles the documented consumer merge against the real types.
  return makeExecutableSchema({ typeDefs: emitted.typeDefs, resolvers: resolvers as never });
}

beforeAll(async () => {
  await fs.rm(path.join(pkgRoot, 'test', 'tmp', 'runtime'), { recursive: true, force: true });
  await new GraphQLGenerator(
    analysis([users, books, memberships, auditLog, activeUsers, dailyTotals, events, tasks, metrics])
  ).generate({ outputDir: out, importExtension: 'none' });
  emitted = (await import(pathToFileURL(path.join(out, 'index.ts')).href)) as Emitted;
  // The cast is about this spec's loose Emitted view, not the artifact; see withResolvers.
  schema = makeExecutableSchema({
    typeDefs: emitted.typeDefs,
    resolvers: emitted.resolvers as never,
  });
});

afterAll(async () => {
  await fs.rm(path.join(pkgRoot, 'test', 'tmp', 'runtime'), { recursive: true, force: true });
});

describe('the schema builds', () => {
  it('is measured against the graphql major the registry serves as latest', () => {
    // The mapping decisions in this suite were measured on 17.0.2 (and separately on 16.14.2 in
    // graphql16.spec.ts). A future major moving under the tests should fail loudly, not drift.
    expect(graphqlVersion.split('.')[0]).toBe('17');
  });

  it('makeExecutableSchema accepts the emitted typeDefs and resolvers, and the schema is valid', () => {
    expect(() => assertValidSchema(schema)).not.toThrow();
  });

  it('buildSchema accepts the same SDL, the plain graphql-js path', () => {
    // No resolvers on this path: buildSchema proves the SDL stands alone as a parseable,
    // valid schema document, which is what "consumable by any server" requires of the text.
    expect(() => assertValidSchema(buildSchema(emitted.typeDefs))).not.toThrow();
  });

  it('answers the full introspection query', async () => {
    const res = await graphql({ schema, source: getIntrospectionQuery() });
    expect(res.errors).toBeUndefined();
    const data = res.data as { __schema: { types: Array<{ name: string }> } };
    const names = data.__schema.types.map((t) => t.name);
    for (const expected of ['Users', 'CreateUsersInput', 'UpdateUsersInput', 'TasksStatusEnum', 'DateTime', 'BigInt', 'JSON']) {
      expect(names, expected).toContain(expected);
    }
  });
});

describe('stubs and validation', () => {
  it('resolves a valid query into the stub throw, with the field path named', async () => {
    const res = await graphql({ schema, source: '{ users { id email } }' });
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.path).toEqual(['users']);
    expect(res.errors?.[0]?.message).toContain('Not implemented');
    expect(res.errors?.[0]?.message).toContain('users');
  });

  it('rejects an unknown field at validation, before any resolver runs', async () => {
    const errs = validate(schema, parse('{ nope }'));
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('nope');
    const res = await graphql({ schema, source: '{ users { zzz } }' });
    expect(res.errors?.[0]?.message).toContain('zzz');
  });

  it('rejects a wrong-typed mutation input BY GRAPHQL, naming the path', async () => {
    const res = await graphql({
      schema,
      source: 'mutation($in: CreateUsersInput!) { createUsers(input: $in) { id } }',
      variableValues: { in: { email: 7, bio: null } },
    });
    expect(res.errors?.[0]?.message).toContain('email');
    expect(res.errors?.[0]?.message).toContain('String');
  });

  it('rejects a missing required input field, naming it', async () => {
    const res = await graphql({
      schema,
      source: 'mutation($in: CreateUsersInput!) { createUsers(input: $in) { id } }',
      variableValues: { in: { bio: 'no email' } },
    });
    expect(res.errors?.[0]?.message).toContain('email');
  });

  it('has no byId field for the keyless table and no mutations for the read-only one', async () => {
    expect(validate(schema, parse('{ auditLogById { at } }'))[0]?.message).toContain('auditLogById');
    expect(
      validate(schema, parse('mutation { createActiveUsers(input: {}) { id } }'))[0]?.message
    ).toContain('createActiveUsers');
    expect(
      validate(schema, parse('mutation { updateAuditLog(input: {}) { at } }'))[0]?.message
    ).toContain('updateAuditLog');
  });

  it('addresses the composite key through named arguments, each type-checked', async () => {
    const ok = await graphql({
      schema: withResolvers({
        Query: {
          membershipsById: (_p: unknown, a: { orgId: number; userId: number }) => ({
            orgId: a.orgId,
            userId: a.userId,
            role: 'x',
          }),
        },
      }),
      source: '{ membershipsById(orgId: 1, userId: 2) { orgId userId } }',
    });
    expect(ok.errors).toBeUndefined();
    expect(ok.data).toEqual({ membershipsById: { orgId: 1, userId: 2 } });
    const bad = await graphql({
      schema,
      source: 'query($u: Int!) { membershipsById(orgId: 1, userId: $u) { orgId } }',
      variableValues: { u: 'nope' },
    });
    expect(bad.errors?.[0]?.message).toContain('Int');
  });

  it('returns null for a byId miss without an error, the nullable-result contract', async () => {
    const res = await graphql({
      schema: withResolvers({ Query: { usersById: () => null } }),
      source: '{ usersById(id: 1) { id } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ usersById: null });
  });
});

describe('explicit null vs absent, through a real executed mutation', () => {
  const echo = (_p: unknown, a: { input: Record<string, unknown> }) => {
    // The emitted create returns Users!, so echo through a row and smuggle the presence facts
    // into string fields the selection can read.
    return {
      id: 1,
      email: 'has=' + Object.prototype.hasOwnProperty.call(a.input, 'bio') + ' val=' + String(a.input.bio),
      bio: null,
      role: 'admin',
    };
  };

  it('distinguishes them through variables', async () => {
    const s = withResolvers({ Mutation: { createUsers: echo } });
    const q = 'mutation($in: CreateUsersInput!) { createUsers(input: $in) { email } }';
    const withNull = await graphql({
      schema: s,
      source: q,
      variableValues: { in: { email: 'x', bio: null } },
    });
    expect(withNull.data).toEqual({ createUsers: { email: 'has=true val=null' } });
    const absent = await graphql({
      schema: s,
      source: q,
      variableValues: { in: { email: 'x' } },
    });
    expect(absent.data).toEqual({ createUsers: { email: 'has=false val=undefined' } });
  });

  it('distinguishes them through inline literals too', async () => {
    const s = withResolvers({ Mutation: { createUsers: echo } });
    const withNull = await graphql({
      schema: s,
      source: 'mutation { createUsers(input: { email: "x", bio: null }) { email } }',
    });
    expect(withNull.data).toEqual({ createUsers: { email: 'has=true val=null' } });
    const absent = await graphql({
      schema: s,
      source: 'mutation { createUsers(input: { email: "x" }) { email } }',
    });
    expect(absent.data).toEqual({ createUsers: { email: 'has=false val=undefined' } });
  });
});

describe('the enum, both directions at execution', () => {
  it('serializes the database value to the mangled GraphQL name on output', async () => {
    const res = await graphql({
      schema: withResolvers({
        Query: { tasks: () => [{ id: 1, status: 'in-progress', mood: 'a b' }] },
      }),
      source: '{ tasks { status mood } }',
    });
    expect(res.errors).toBeUndefined();
    // The value map turns the row's database spelling into the GraphQL member name, and the
    // String-fallback column carries its unrepresentable value verbatim.
    expect(res.data).toEqual({ tasks: [{ status: 'IN_PROGRESS', mood: 'a b' }] });
  });

  it('coerces the GraphQL name back to the database value, variable and literal alike', async () => {
    const seen: unknown[] = [];
    const s = withResolvers({
      Mutation: {
        createTasks: (_p: unknown, a: { input: { status: string } }) => {
          seen.push(a.input.status);
          return { id: 1, status: a.input.status, mood: null };
        },
      },
    });
    const viaVariable = await graphql({
      schema: s,
      source: 'mutation($in: CreateTasksInput!) { createTasks(input: $in) { id } }',
      variableValues: { in: { status: 'IN_PROGRESS' } },
    });
    expect(viaVariable.errors).toBeUndefined();
    const viaLiteral = await graphql({
      schema: s,
      source: 'mutation { createTasks(input: { status: _2FA }) { id } }',
    });
    expect(viaLiteral.errors).toBeUndefined();
    expect(seen).toEqual(['in-progress', '2fa']);
  });

  it('rejects an outsider and rejects the database spelling where the name belongs', async () => {
    const q = 'mutation($in: CreateTasksInput!) { createTasks(input: $in) { id } }';
    const outsider = await graphql({ schema, source: q, variableValues: { in: { status: 'BOSS' } } });
    expect(outsider.errors?.[0]?.message).toContain('TasksStatusEnum');
    const dbSpelling = await graphql({
      schema,
      source: q,
      variableValues: { in: { status: 'in-progress' } },
    });
    expect(dbSpelling.errors?.[0]?.message).toContain('in-progress');
  });
});

describe('the DateTime scalar at execution', () => {
  it('parses the strict ISO form through a variable into a real Date', async () => {
    let got: unknown;
    const s = withResolvers({
      Mutation: {
        createEvents: (_p: unknown, a: { input: { at: unknown } }) => {
          got = a.input.at;
          return row();
        },
      },
    });
    const res = await graphql({
      schema: s,
      source: 'mutation($in: CreateEventsInput!) { createEvents(input: $in) { id } }',
      variableValues: { in: { at: '2026-01-02T03:04:05.000Z', flag: true, big: '1', tags: [], point: [1, 2] } },
    });
    expect(res.errors).toBeUndefined();
    expect(got).toBeInstanceOf(Date);
    expect((got as Date).toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('parses an inline literal through the other code path', async () => {
    let got: unknown;
    const s = withResolvers({
      Mutation: {
        createEvents: (_p: unknown, a: { input: { at: unknown } }) => {
          got = a.input.at;
          return row();
        },
      },
    });
    const res = await graphql({
      schema: s,
      source:
        'mutation { createEvents(input: { at: "2026-01-02T03:04:05.000Z", flag: true, big: "1", tags: [], point: [1, 2] }) { id } }',
    });
    expect(res.errors).toBeUndefined();
    expect(got).toBeInstanceOf(Date);
  });

  it('refuses the spellings new Date() would misread, on both paths', async () => {
    const base = { flag: true, big: '1', tags: [], point: [1, 2] };
    for (const at of ['garbage', '1', '2026-01-02']) {
      const res = await graphql({
        schema,
        source: 'mutation($in: CreateEventsInput!) { createEvents(input: $in) { id } }',
        variableValues: { in: { ...base, at } },
      });
      expect(res.errors?.[0]?.message, at).toContain('DateTime');
    }
    const literal = await graphql({
      schema,
      source: 'mutation { createEvents(input: { at: 20260102, flag: true, big: "1", tags: [], point: [1, 2] }) { id } }',
    });
    expect(literal.errors?.[0]?.message).toContain('DateTime');
  });

  it('serializes a Date the resolver returned into its ISO string', async () => {
    const res = await graphql({
      schema: withResolvers({ Query: { events: () => [row()] } }),
      source: '{ events { at } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ events: [{ at: '2026-01-02T03:04:05.000Z' }] });
  });
});

describe('the BigInt scalar at execution', () => {
  it('round-trips digits through a variable, exactly', async () => {
    let got: unknown;
    const s = withResolvers({
      Mutation: {
        createEvents: (_p: unknown, a: { input: { big: unknown } }) => {
          got = a.input.big;
          return row();
        },
      },
    });
    const res = await graphql({
      schema: s,
      source: 'mutation($in: CreateEventsInput!) { createEvents(input: $in) { id } }',
      variableValues: {
        in: { at: '2026-01-02T03:04:05.000Z', flag: true, big: '9007199254740993', tags: [], point: [1, 2] },
      },
    });
    expect(res.errors).toBeUndefined();
    expect(got).toBe('9007199254740993');
  });

  it('takes an inline integer literal losslessly, because the AST carries raw digits', async () => {
    // A JSON number variable of 2^53+1 is rounded by JSON.parse before GraphQL ever sees it;
    // an inline IntValue literal is a string in the AST, so parseLiteral hands the digits over
    // exactly. Measured on 16.14.2 and 17.0.2.
    let got: unknown;
    const s = withResolvers({
      Mutation: {
        createEvents: (_p: unknown, a: { input: { big: unknown } }) => {
          got = a.input.big;
          return row();
        },
      },
    });
    const res = await graphql({
      schema: s,
      source:
        'mutation { createEvents(input: { at: "2026-01-02T03:04:05.000Z", flag: true, big: 9007199254740993, tags: [], point: [1, 2] }) { id } }',
    });
    expect(res.errors).toBeUndefined();
    expect(got).toBe('9007199254740993');
  });

  it('refuses a JSON number through a variable, which has already been rounded', async () => {
    const res = await graphql({
      schema,
      source: 'mutation($in: CreateEventsInput!) { createEvents(input: $in) { id } }',
      variableValues: {
        in: { at: '2026-01-02T03:04:05.000Z', flag: true, big: 9007199254740993, tags: [], point: [1, 2] },
      },
    });
    expect(res.errors?.[0]?.message).toContain('BigInt');
  });

  it('serializes a real bigint and a digit string alike, to the digits', async () => {
    const res = await graphql({
      schema: withResolvers({
        Query: { events: () => [{ ...row(), big: 9007199254740993n }, { ...row(), id: 2 }] },
      }),
      source: '{ events { big } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ events: [{ big: '9007199254740993' }, { big: '9007199254740993' }] });
  });
});

describe('lists, JSON and Float, the read path', () => {
  it('serializes an array with a NULL element, which [String!] would have refused whole', async () => {
    const res = await graphql({
      schema: withResolvers({ Query: { events: () => [{ ...row(), tags: ['a', null, 'b'] }] } }),
      source: '{ events { tags } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ events: [{ tags: ['a', null, 'b'] }] });
  });

  it('passes a JSON column through untouched', async () => {
    const res = await graphql({
      schema: withResolvers({
        Query: { auditLog: () => [{ at: 'x', what: 'y', payload: { deep: [1, null, { a: true }] } }] },
      }),
      source: '{ auditLog { payload } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ auditLog: [{ payload: { deep: [1, null, { a: true }] } }] });
  });

  it('carries a 64-bit-range integer column through Float, which Int would refuse', async () => {
    // 2^40: a value SQLite's integer really returns, and the measured Int boundary refuses at
    // serialize with an error, nulling the field. Float carries it.
    const res = await graphql({
      schema: withResolvers({
        Query: {
          metrics: () => [
            { id: 1099511627776, big53: 2, ratio: 1.5, amount: '1.25', ref: 'r', day: 'd' },
          ],
        },
      }),
      source: '{ metrics { id ratio amount } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ metrics: [{ id: 1099511627776, ratio: 1.5, amount: '1.25' }] });
  });

  it('maps the renamed column back to the row property through the emitted field resolver', async () => {
    const res = await graphql({
      schema: withResolvers({
        Query: { books: () => [{ isbn: '1', title: 't', 'cover url': 'http://c' }] },
      }),
      source: '{ books { cover_url } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ books: [{ cover_url: 'http://c' }] });
  });
});

/** One valid events row for overrides that only care about a single field. */
function row() {
  return {
    id: 1,
    at: new Date('2026-01-02T03:04:05.000Z'),
    flag: true,
    big: '9007199254740993',
    tags: [],
    point: [1, 2],
    note: null,
  };
}
