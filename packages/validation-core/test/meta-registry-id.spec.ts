/**
 * The registry id, and the collision it exists to avoid.
 *
 * An `id` in a zod schema's metadata is not decoration: measured against zod 4.4.3, it makes
 * `z.toJSONSchema` emit `$ref: '#/$defs/<id>'` wherever one schema references another rather than
 * inlining a copy, and it gives `z.toJSONSchema(z.globalRegistry)` a name to file each schema under.
 * That is what "self-describing" means here.
 *
 * It is also the one metadata key with a failure mode. Two schemas sharing an id do not last-write-
 * wins, they throw:
 *
 *     Duplicate schema id "usersSelect" detected during JSON Schema conversion.
 *
 * DRZL can produce that collision on any schema with two SQL schemas, because `table.name` is the
 * bare name and two tables can share it. So the id is built from the qualified name, and the
 * must-fire test below is the one that would catch a change back to the bare one.
 */
import { describe, expect, it } from 'vitest';
import type { Table } from '@drzl/analyzer';
import { metaSchemaId, tableMetaFacts } from '../src/meta.js';

const table = (name: string, schema?: string): Table =>
  ({
    name,
    tsName: name,
    unique: [],
    indexes: [],
    columns: [],
    ...(schema ? { schema } : {}),
  }) as Table;

describe('metaSchemaId', () => {
  it('is the bare name for a table in the default schema, as anyone would write it', () => {
    expect(metaSchemaId(table('users'), 'select')).toBe('usersSelect');
    expect(metaSchemaId(table('users'), 'insert')).toBe('usersInsert');
  });

  /** MUST FIRE. Bare names collide, and zod throws on the collision rather than picking a winner. */
  it('tells two tables of the same bare name apart by their SQL schema', () => {
    const a = metaSchemaId(table('users'), 'select');
    const b = metaSchemaId(table('users', 'reporting'), 'select');
    expect(b).toBe('reporting_usersSelect');
    expect(a, 'two tables in two schemas produced the same registry id').not.toBe(b);
  });

  it('keeps the id usable as a JSON Pointer segment', () => {
    // The id lands in `$ref: '#/$defs/<id>'`, where `/` and `~` mean something else entirely.
    const id = metaSchemaId(table('odd/name~here'), 'select');
    expect(id).not.toMatch(/[/~]/);
    expect(id).toBe('odd_name_hereSelect');
  });

  it('separates the modes, so the three schemas of one table are three entries', () => {
    const ids = ['insert', 'update', 'select'].map((m) => metaSchemaId(table('users'), m));
    expect(new Set(ids).size).toBe(3);
  });
});

describe('the facts carrying it', () => {
  it('leaves the id out unless it is asked for', () => {
    const facts = tableMetaFacts(table('users'), { mode: 'select' });
    expect('id' in facts).toBe(false);
  });

  it('puts it in when it is', () => {
    const facts = tableMetaFacts(table('users'), {
      mode: 'select',
      id: metaSchemaId(table('users'), 'select'),
    });
    expect(facts.id).toBe('usersSelect');
    // And the rest of the facts are untouched by it.
    expect(facts.table).toBe('users');
    expect(facts.mode).toBe('select');
  });
});
