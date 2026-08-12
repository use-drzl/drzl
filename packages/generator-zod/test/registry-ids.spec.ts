/**
 * What a registry id buys, run against real zod rather than asserted on the emitted text.
 *
 * The emit spec can say the module contains `"id": "usersSelect"`. Only running it shows what that
 * id does, and the two things it does are the whole feature: `z.toJSONSchema` emits a `$ref` to a
 * named definition instead of inlining a copy, and `z.toJSONSchema(z.globalRegistry)` returns a
 * bundle keyed by those names. Measured against zod 4.4.3.
 *
 * The collision is run too. Two schemas sharing an id do not last-write-wins, they throw, and that
 * is why `metaSchemaId` is built from the qualified table name.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { metaSchemaId } from '@drzl/validation-core';
import type { Table } from '@drzl/analyzer';

const table = (name: string, schema?: string): Table =>
  ({ name, tsName: name, unique: [], indexes: [], columns: [], ...(schema ? { schema } : {}) }) as Table;

/** A fresh registry per test, so one case cannot see another's ids. */
const registry = () => z.registry<{ id?: string }>();

describe('what an id does to toJSONSchema', () => {
  it('turns a referenced schema into a $ref rather than an inlined copy', () => {
    const author = z.object({ id: z.number() }).meta({ id: metaSchemaId(table('users'), 'select') });
    const post = z.object({ author }).meta({ id: metaSchemaId(table('posts'), 'select') });

    const json = JSON.stringify(z.toJSONSchema(post));
    expect(json).toContain('"$ref":"#/$defs/usersSelect"');
    expect(json).toContain('"$defs"');
  });

  it('inlines it when there is no id, which is the behaviour without this option', () => {
    const author = z.object({ id: z.number() });
    const post = z.object({ author });
    const json = JSON.stringify(z.toJSONSchema(post));
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$defs');
  });
});

describe('the collision the qualified name avoids', () => {
  /**
   * MUST FIRE, and worse than a throw: measured on zod 4.4.3, a registry dump with two schemas
   * under one id keeps the last and **silently drops the other**. Two tables, one entry, no
   * warning and nothing a consumer can check. This is the failure `metaSchemaId` exists to prevent.
   */
  it('silently drops one of two schemas sharing an id', () => {
    const r = registry();
    r.add(z.object({ x: z.number() }), { id: 'usersSelect' });
    r.add(z.object({ y: z.string() }), { id: 'usersSelect' });
    const out = z.toJSONSchema(r) as { schemas: Record<string, unknown> };
    expect(Object.keys(out.schemas), 'the collision was reported rather than silent').toEqual([
      'usersSelect',
    ]);
    // The first schema is gone, and only its absence says so.
    expect(JSON.stringify(out)).toContain('"y"');
    expect(JSON.stringify(out)).not.toContain('"x"');
  });

  // zod also has a "Duplicate schema id detected during JSON Schema conversion" error, seen once
  // while probing. It is deliberately not asserted here: it could not be reproduced on demand, and
  // a test for a path nobody can trigger reliably is a test that will one day fail for an unrelated
  // reason and be deleted without anyone knowing what it meant. The silent drop above reproduces
  // every time, is the worse outcome, and is on its own reason enough for the qualified id.

  it('does not throw for two tables of the same bare name in different SQL schemas', () => {
    const r = registry();
    r.add(z.object({ x: z.number() }), { id: metaSchemaId(table('users'), 'select') });
    r.add(z.object({ y: z.string() }), { id: metaSchemaId(table('users', 'reporting'), 'select') });
    const out = z.toJSONSchema(r) as { schemas: Record<string, unknown> };
    expect(Object.keys(out.schemas).sort()).toEqual(['reporting_usersSelect', 'usersSelect']);
  });
});

describe('the bundle', () => {
  it('files every schema under the name the generator gave it', () => {
    const r = registry();
    for (const mode of ['insert', 'update', 'select']) {
      r.add(z.object({ id: z.number() }), { id: metaSchemaId(table('users'), mode) });
    }
    const out = z.toJSONSchema(r) as { schemas: Record<string, unknown> };
    expect(Object.keys(out.schemas).sort()).toEqual(['usersInsert', 'usersSelect', 'usersUpdate']);
  });
});
