/**
 * The emitted document, put in front of a real OpenAPI validator.
 *
 * Nothing here asserts on the shape of the object, for the same reason `against-ajv.spec.ts`
 * asserts on nothing: a document that looks like OpenAPI and is not is exactly what this format
 * makes easy to produce. `@seriousme/openapi-schema-validator` compiles the document against the
 * official OpenAPI JSON Schemas with ajv, and it is one of the few that has a real 3.1 schema
 * rather than validating 3.1 documents against the 3.0 one.
 *
 * The 3.0 half is not a formality. OpenAPI 3.0's Schema Object is closed: its meta-schema sets
 * `additionalProperties: false` and allows only `^x-` beside the keywords it lists, so a keyword
 * from a later draft is a validation error rather than something a reader ignores. `const` and
 * `contentEncoding` both went in that way and both were caught here.
 */
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { openApiDocument, type JsonSchemaTarget } from '../src/index';
import { activeUsers, col, events, orgMembers, posts, sessions, table, users } from './fixtures';

/** Every column shape the generator has a branch for, so the document carries all of them. */
const wide = () =>
  table({
    name: 'wide',
    columns: [
      col('id', { tsType: 'number', dbType: 'INTEGER', integer: true }),
      col('raw', { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never }),
      col('meta', { tsType: 'unknown', dbType: 'JSONB', shape: { kind: 'json' } as never }),
      col('at', { tsType: 'Date', dbType: 'TIMESTAMP' }),
      col('big', { tsType: 'bigint', dbType: 'BIGINT' }),
      col('ok', { tsType: 'boolean', dbType: 'BOOLEAN' }),
      col('tags', { arrayDimensions: 1 }),
      col('loc', {
        tsType: 'number[]',
        dbType: 'POINT',
        shape: { kind: 'tuple', length: 2 } as never,
      }),
      col('xy', {
        tsType: 'object',
        dbType: 'POINT',
        shape: { kind: 'numberObject', fields: ['x', 'y'] } as never,
      }),
      col('vec', {
        tsType: 'number[]',
        dbType: 'VECTOR',
        shape: { kind: 'numberVector', length: 3 } as never,
      }),
      col('bits', { dbType: 'BIT', shape: { kind: 'bitstring', length: 4, exact: true } as never }),
      col('bin', { dbType: 'VARBINARY', shape: { kind: 'byteString', length: 8 } as never }),
      col('note', { maxBytes: 255 }),
      col('grade', { enumValues: ['a', 'b'] }),
      col('tier', { nullable: true }),
      col('score', { tsType: 'number', dbType: 'REAL', min: '0', max: '100' }),
    ],
    primaryKey: { columns: ['id'] },
    checks: [
      { name: 'tier_is_gold', expression: `tier = 'gold'` },
      { name: 'ordered', expression: 'id < score' },
    ],
  });

const ALL = () => [users(), posts(), sessions(), orgMembers(), events(), activeUsers(), wide()];

async function verdict(target: JsonSchemaTarget, opts: Record<string, unknown> = {}) {
  const doc = openApiDocument(ALL(), { target, includeRelations: true, ...opts });
  const res = await new Validator().validate(structuredClone(doc) as never);
  return { doc, res };
}

describe('a real OpenAPI validator', () => {
  it('accepts the 3.1 document', async () => {
    const { res } = await verdict('openapi-3.1');
    expect(JSON.stringify(res.errors ?? [], null, 2)).toBe('[]');
    expect(res.valid).toBe(true);
  });

  it('accepts the 3.0 document', async () => {
    const { res } = await verdict('openapi-3.0');
    expect(JSON.stringify(res.errors ?? [], null, 2)).toBe('[]');
    expect(res.valid).toBe(true);
  });

  it('accepts the 2020-12 target, which is emitted as 3.1', async () => {
    const { res } = await verdict('draft-2020-12');
    expect(res.valid).toBe(true);
  });

  it('accepts a document with servers and a caller-supplied info block', async () => {
    const { res } = await verdict('openapi-3.1', {
      info: { title: 'Shop', version: '1.4.0', description: 'x' },
      servers: [{ url: 'https://api.example.com/v1', description: 'production' }],
    });
    expect(res.valid).toBe(true);
  });

  it('accepts an empty schema, which is a document with no tables', async () => {
    const res = await new Validator().validate(openApiDocument([]) as never);
    expect(res.valid).toBe(true);
  });
});

describe('every $ref resolves', () => {
  it.each(['openapi-3.1', 'openapi-3.0'] as const)('inside the %s document', async (target) => {
    const { doc } = await verdict(target);
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        else walk(v);
      }
    };
    walk(doc);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/'), ref).toBe(true);
      let cursor: unknown = doc;
      for (const seg of ref.slice(2).split('/')) {
        cursor = (cursor as Record<string, unknown>)?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
      }
      expect(cursor, `${ref} resolves to nothing`).toBeTruthy();
    }
  });

  it('references no component schema that is not there, and carries none nothing points at', async () => {
    const { doc } = await verdict('openapi-3.1');
    const declared = new Set(Object.keys((doc as any).components.schemas));
    const used = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') used.add(v.split('/').pop()!);
        else walk(v);
      }
    };
    walk((doc as any).paths);
    expect([...used].filter((n) => !declared.has(n))).toEqual([]);
    expect([...declared].filter((n) => !used.has(n))).toEqual([]);
  });
});

describe('the validator is actually looking', () => {
  it('rejects a document with a keyword OpenAPI 3.0 does not have', async () => {
    // Proof the 3.0 pass above is a measurement rather than a green light nobody earned. This is
    // the exact defect the generator carried: `contentEncoding` reached a 3.0 document and made it
    // invalid, and a validator that only knew 3.1 would have said nothing.
    const doc = openApiDocument([users()], { target: 'openapi-3.0' }) as any;
    doc.components.schemas.usersSelect.properties.email = {
      type: 'string',
      contentEncoding: 'base64',
    };
    const res = await new Validator().validate(doc as never);
    expect(res.valid).toBe(false);
    expect(JSON.stringify(res.errors)).toContain('contentEncoding');
  });

  it('rejects a path whose parameter is not declared', async () => {
    const doc = openApiDocument([users()], { target: 'openapi-3.1' }) as any;
    delete doc.paths['/users/{id}'].parameters;
    doc.paths['/users/{id}'].get.responses = {};
    const res = await new Validator().validate(doc as never);
    expect(res.valid).toBe(false);
  });
});
