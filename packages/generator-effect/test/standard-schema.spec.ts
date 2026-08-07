/**
 * The Standard Schema form, which is what lets an Effect schema back a router.
 *
 * TypeBox was excluded from the tRPC and oRPC generators because nothing in `@sinclair/typebox`
 * implements the spec at all. Effect is not in that position: `Schema.standardSchemaV1(T)` returns
 * a real `~standard`, so the hole is a wiring job rather than a dead end. The generator therefore
 * emits both forms, and these tests pin what each one is for.
 */
import { describe, it, expect } from 'vitest';
import { accepts, analysisOf, col, emit, emitText, table } from './fixtures';

type Standard = {
  '~standard': {
    version: number;
    vendor: string;
    validate: (v: unknown) => { value?: unknown; issues?: Array<{ message: string }> };
  };
};

describe('every schema is emitted twice', () => {
  it('as a bare Struct and as a Standard Schema wrapper', async () => {
    const m = await emit(analysisOf([table('t', [col('n')])]));
    for (const name of ['InserttSchema', 'UpdatetSchema', 'SelecttSchema']) {
      expect(m[name], name).toBeDefined();
      expect(m[`Standard${name}`], `Standard${name}`).toBeDefined();
    }
  });

  it('the wrapper carries a version 1 ~standard from the effect vendor', async () => {
    const m = await emit(analysisOf([table('t', [col('n')])]));
    const std = m.StandardSelecttSchema as Standard;
    expect(std['~standard'].version).toBe(1);
    expect(std['~standard'].vendor).toBe('effect');
  });

  it('and validates the same values the bare form does, both ways', async () => {
    const m = await emit(analysisOf([table('t', [col('n', { maxLength: 3 })])]));
    const std = m.StandardSelecttSchema as Standard;
    const good = std['~standard'].validate({ n: 'abc' });
    expect(good.value).toEqual({ n: 'abc' });
    expect(good.issues).toBeUndefined();
    const bad = std['~standard'].validate({ n: 'abcd' });
    expect(bad.issues?.length).toBeGreaterThan(0);
    expect(accepts(m.SelecttSchema, { n: 'abcd' }), 'the bare form agrees').toBe(false);
  });

  it('the bare form keeps `fields`, which is what composes', async () => {
    // `Schema.pick`, `Schema.omit` and spreading into a wider Struct all read `fields`, and the
    // wrapper does not have it. That is the whole reason both are exported rather than only one.
    const m = await emit(analysisOf([table('t', [col('n')])]));
    expect((m.SelecttSchema as { fields?: unknown }).fields).toBeDefined();
    expect((m.StandardSelecttSchema as { fields?: unknown }).fields).toBeUndefined();
  });

  it('a row-level check survives into the wrapper', async () => {
    const m = await emit(
      analysisOf([
        table(
          't',
          [
            col('lo', { tsType: 'number', dbType: 'INTEGER', integer: true }),
            col('hi', { tsType: 'number', dbType: 'INTEGER', integer: true }),
          ],
          { checks: [{ name: 'ordered', expression: 'lo < hi' }] } as never
        ),
      ])
    );
    const std = m.StandardSelecttSchema as Standard;
    expect(std['~standard'].validate({ lo: 1, hi: 2 }).issues).toBeUndefined();
    expect(std['~standard'].validate({ lo: 3, hi: 2 }).issues?.length).toBeGreaterThan(0);
  });

  it('a nested schema gets one too', async () => {
    const m = await emit(
      analysisOf([table('users', [col('id')]), table('posts', [col('id'), col('userId')])], [
        { kind: 'many', from: 'users', to: 'posts' },
      ] as never),
      { nestedSchemas: true },
      'users'
    );
    expect(m.NestedSelectusersSchema).toBeDefined();
    expect(m.StandardNestedSelectusersSchema).toBeDefined();
    const std = m.StandardNestedSelectusersSchema as Standard;
    expect(std['~standard'].vendor).toBe('effect');
  });
});

describe('the emitted module', () => {
  it('imports only what it uses and does not throw on load', async () => {
    // Loading is what the assertions above already did. This is about the import line: a module
    // that named a helper it never imported would be a compile error, and one that imported a
    // helper it never used is what the lint rule catches.
    const text = await emitText(analysisOf([table('t', [col('n')])]));
    expect(text).toContain("import * as Schema from 'effect/Schema';");
    expect(text).not.toContain('@effect/schema');
    expect(text.match(/^import /gm)?.length, 'one import line').toBe(1);
  });
});
