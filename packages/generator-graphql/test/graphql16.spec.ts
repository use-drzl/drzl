/**
 * The other side of the registry split: graphql 16, the major Apollo Server and graphql-yoga
 * still pin, loaded here through the `graphql-16` install alias.
 *
 * What this file proves in-package: the emitted SDL parses and validates on 16, executes
 * against stubs, and the emitted scalar configs' legacy-named hooks are what 16 reads (the
 * dual naming exists for 17, whose renamed hooks the main runtime spec exercises). The
 * resolver-map path on 16 goes through @graphql-tools/schema, whose peer pnpm binds to this
 * package's graphql 17, so the 16-with-tools pairing is not constructible here; it was
 * measured out-of-repo (2026-08-08, graphql 16.14.2 + @graphql-tools/schema 10.0.38 +
 * graphql-yoga 5.21.2: plain scalar configs and enum value maps work through createSchema over
 * HTTP), and the docs carry that grid.
 *
 * buildSchema attaches no behaviour, so the scalar hooks are attached the way the docs
 * describe for plain graphql-js consumers: Object.assign of the emitted config onto the built
 * scalar type. Measured: on 16 the legacy names are live after assignment; on 17 that patch
 * does NOT take for variables, which is one of the reasons the docs steer custom-scalar users
 * to a resolver-accepting builder.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertValidSchema,
  buildSchema,
  graphql,
  parse,
  validate,
  version as graphql16Version,
  type GraphQLSchema,
  type GraphQLScalarType,
} from 'graphql-16';
import { GraphQLGenerator } from '../src';
import { analysis, auditLog, events, memberships, users } from './fixtures';

const pkgRoot = path.resolve(import.meta.dirname, '..');
const out = path.join(pkgRoot, 'test', 'tmp', 'runtime16', 'api');

interface Emitted {
  typeDefs: string;
  DateTimeScalar: Record<string, unknown>;
  BigIntScalar: Record<string, unknown>;
}

let emitted: Emitted;
let schema: GraphQLSchema;

beforeAll(async () => {
  await fs.rm(path.join(pkgRoot, 'test', 'tmp', 'runtime16'), { recursive: true, force: true });
  await new GraphQLGenerator(analysis([users, memberships, auditLog, events])).generate({
    outputDir: out,
    importExtension: 'none',
  });
  emitted = (await import(pathToFileURL(path.join(out, 'index.ts')).href)) as Emitted;
  schema = buildSchema(emitted.typeDefs);
  // The docs' plain graphql-js attachment: the emitted configs assigned onto the built types.
  Object.assign(schema.getType('DateTime') as GraphQLScalarType, emitted.DateTimeScalar);
  Object.assign(schema.getType('BigInt') as GraphQLScalarType, emitted.BigIntScalar);
});

afterAll(async () => {
  await fs.rm(path.join(pkgRoot, 'test', 'tmp', 'runtime16'), { recursive: true, force: true });
});

describe('graphql 16 accepts the emitted SDL', () => {
  it('is really the 16 line', () => {
    expect(graphql16Version.split('.')[0]).toBe('16');
  });

  it('buildSchema parses it and assertValidSchema passes', () => {
    expect(() => assertValidSchema(schema)).not.toThrow();
  });

  it('rejects an unknown field the same way', () => {
    expect(validate(schema, parse('{ nope }'))[0]?.message).toContain('nope');
  });
});

describe('execution on 16', () => {
  it('runs a query against a stub through rootValue, and the throw carries the path', async () => {
    const res = await graphql({
      schema,
      source: '{ users { id } }',
      rootValue: {
        users: () => {
          throw new Error('Not implemented: Query.users.');
        },
      },
    });
    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.path).toEqual(['users']);
    expect(res.errors?.[0]?.message).toContain('Not implemented');
  });

  it('parses a DateTime variable through the legacy parseValue after attachment', async () => {
    const res = await graphql({
      schema,
      source: 'mutation($in: CreateEventsInput!) { createEvents(input: $in) { id } }',
      rootValue: {
        createEvents: (args: { input: { at: unknown } }) => {
          if (!(args.input.at instanceof Date)) throw new Error('not a Date: ' + typeof args.input.at);
          return { id: 1, at: args.input.at, flag: true, big: '1', tags: [], point: [1, 2], note: null };
        },
      },
      variableValues: {
        in: { at: '2026-01-02T03:04:05.000Z', flag: true, big: '1', tags: [], point: [1, 2] },
      },
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ createEvents: { id: 1 } });
  });

  it('refuses a loose DateTime spelling on 16 too', async () => {
    const res = await graphql({
      schema,
      source: 'mutation($in: CreateEventsInput!) { createEvents(input: $in) { id } }',
      variableValues: { in: { at: '1', flag: true, big: '1', tags: [], point: [1, 2] } },
    });
    expect(res.errors?.[0]?.message).toContain('DateTime');
  });

  it('takes a BigInt inline integer literal losslessly through the legacy parseLiteral', async () => {
    let got: unknown;
    const res = await graphql({
      schema,
      source:
        'mutation { createEvents(input: { at: "2026-01-02T03:04:05.000Z", flag: true, big: 9007199254740993, tags: [], point: [1, 2] }) { id } }',
      rootValue: {
        createEvents: (args: { input: { big: unknown } }) => {
          got = args.input.big;
          return { id: 1, at: new Date(), flag: true, big: args.input.big, tags: [], point: [1, 2], note: null };
        },
      },
    });
    expect(res.errors).toBeUndefined();
    expect(got).toBe('9007199254740993');
  });

  it('distinguishes explicit null from absent on 16 as well', async () => {
    const res = await graphql({
      schema,
      source: 'mutation { createUsers(input: { email: "x", bio: null }) { email } }',
      rootValue: {
        createUsers: (args: { input: Record<string, unknown> }) => ({
          id: 1,
          email:
            'has=' +
            Object.prototype.hasOwnProperty.call(args.input, 'bio') +
            ' val=' +
            String(args.input.bio),
          bio: null,
          role: 'admin',
        }),
      },
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ createUsers: { email: 'has=true val=null' } });
  });
});
