/**
 * An OpenAPI components document, not just a pile of schemas.
 *
 * The per-table modules are the useful unit for a TypeScript program. An OpenAPI document wants
 * one object under `components.schemas`, keyed by name, with every `$ref` resolving inside it.
 * Assembling that by hand is the step everyone repeats, and getting the `$id`/`$ref` relationship
 * wrong is easy to do quietly.
 *
 * Emitted as its own module so nothing changes for anyone not asking for it.
 */
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Table } from '@drzl/analyzer';
import { componentsDocument } from '../src/index';

const table = (name: string): Table =>
  ({
    name,
    tsName: name,
    columns: [
      { name: 'id', tsType: 'number', dbType: 'INTEGER', nullable: false, hasDefault: true, isGenerated: false, integer: true },
      { name: 'label', tsType: 'string', dbType: 'TEXT', nullable: true, hasDefault: false, isGenerated: false },
    ],
    unique: [],
    indexes: [],
    checks: [],
  }) as never;

describe('the components document', () => {
  it('keys every mode of every table under components.schemas', () => {
    const doc = componentsDocument([table('users'), table('posts')], {});
    expect(Object.keys(doc.schemas).sort()).toEqual([
      'postsInsert',
      'postsSelect',
      'postsUpdate',
      'usersInsert',
      'usersSelect',
      'usersUpdate',
    ]);
  });

  it('drops the $schema declaration, which does not belong inside a document', () => {
    // A schema nested under components.schemas inherits the document's dialect. Leaving a
    // per-schema $schema in is not merely noise: OpenAPI 3.1 treats it as a dialect switch.
    const doc = componentsDocument([table('users')], {});
    for (const s of Object.values(doc.schemas)) {
      expect((s as any).$schema).toBeUndefined();
    }
  });

  it('carries no $id, because the map key is the identity', () => {
    // The obvious first attempt set `$id` to `#/components/schemas/<name>`, and ajv refused the
    // schema outright: a draft 2020-12 `$id` may not contain a fragment. In OpenAPI the `$ref`
    // is written by whatever points at the schema, not by the schema itself.
    const doc = componentsDocument([table('users')], {});
    for (const [name, s] of Object.entries(doc.schemas)) {
      expect((s as any).$id, name).toBeUndefined();
    }
  });

  it('produces schemas a validator still accepts', () => {
    const doc = componentsDocument([table('users')], {});
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv as never);
    const v = ajv.compile(doc.schemas.usersSelect as never);
    expect(v({ id: 1, label: null })).toBe(true);
    expect(v({ id: 1.5, label: null })).toBe(false);
    expect(v({ label: null }), 'id is required on select').toBe(false);
  });

  it('honours the target, so a 3.0 document gets 3.0 spellings', () => {
    const doc = componentsDocument([table('users')], { target: 'openapi-3.0' });
    expect((doc.schemas.usersSelect as any).properties.label).toMatchObject({
      type: 'string',
      nullable: true,
    });
  });
});
