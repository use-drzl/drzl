/**
 * Two keywords the `openapi-3.0` target used to emit that OpenAPI 3.0 does not have.
 *
 * The generator already knew that 3.0 is a different dialect rather than an older superset, and it
 * already translated three things: `nullable`, the boolean exclusive bounds, and `prefixItems`.
 * It did not translate these two, and they are the same class of defect.
 *
 * Where this one bites harder than the documented "an unknown keyword is ignored" case: OpenAPI
 * 3.0's meta-schema closes the Schema Object with `additionalProperties: false`, allowing only
 * `^x-` alongside the keywords it lists. So a 2020-12 keyword in a 3.0 document does not get
 * quietly ignored, it makes the whole document fail validation. Measured against the official 3.0
 * schema in `openapi-validated.spec.ts`.
 */
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { tableSchemas } from '../src/index';
import { col, table } from './fixtures';

const binary = () =>
  table({
    name: 'b',
    columns: [
      col('raw', { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never }),
      col('blob', { tsType: 'Uint8Array', dbType: 'BLOB' }),
    ],
  });

const fixed = () =>
  table({
    name: 'f',
    columns: [col('tier'), col('rank', { tsType: 'number', dbType: 'INTEGER', integer: true })],
    checks: [
      { name: 'tier_gold', expression: `tier = 'gold'` },
      { name: 'rank_one', expression: 'rank = 1' },
    ],
  });

const select = (t: ReturnType<typeof binary>, target: 'openapi-3.0' | 'openapi-3.1') =>
  tableSchemas(t, { target }).select as any;

describe('base64, in each dialect', () => {
  it('is contentEncoding under 2020-12 and 3.1', () => {
    const s = select(binary(), 'openapi-3.1');
    expect(s.properties.raw).toEqual({ type: 'string', contentEncoding: 'base64' });
    expect(s.properties.blob).toEqual({ type: 'string', contentEncoding: 'base64' });
  });

  it('is format: byte under 3.0, which is the only spelling that dialect has', () => {
    const s = select(binary(), 'openapi-3.0');
    expect(s.properties.raw).toEqual({ type: 'string', format: 'byte' });
    expect(s.properties.blob).toEqual({ type: 'string', format: 'byte' });
  });
});

describe('a CHECK that pins one value, in each dialect', () => {
  it('is const under 2020-12 and 3.1', () => {
    const s = select(fixed(), 'openapi-3.1');
    expect(s.properties.tier).toEqual({ const: 'gold' });
    expect(s.properties.rank).toEqual({ const: 1 });
  });

  it('is a one-value enum under 3.0, which has no const', () => {
    const s = select(fixed(), 'openapi-3.0');
    expect(s.properties.tier).toEqual({ enum: ['gold'] });
    expect(s.properties.rank).toEqual({ enum: [1] });
  });
});

describe('the 3.0 spelling still means the same thing', () => {
  // The point of the translation is that the constraint survives it. A one-value `enum` and a
  // `const` accept the same single value, and a validator is asked rather than trusted.
  const compile = (schema: unknown) => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv as never);
    return ajv.compile(schema as never);
  };

  it('accepts only the pinned value', () => {
    const v = compile(select(fixed(), 'openapi-3.0'));
    expect(v({ tier: 'gold', rank: 1 })).toBe(true);
    expect(v({ tier: 'silver', rank: 1 })).toBe(false);
    expect(v({ tier: 'gold', rank: 2 })).toBe(false);
  });

  it('still describes a string for a binary column', () => {
    const v = compile(select(binary(), 'openapi-3.0'));
    expect(v({ raw: 'aGVsbG8=', blob: 'aGVsbG8=' })).toBe(true);
    expect(v({ raw: 1, blob: 'aGVsbG8=' })).toBe(false);
  });
});
