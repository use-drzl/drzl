/**
 * A materialized view cannot be written to.
 *
 * `INSERT INTO mv ...` fails with `cannot change materialized view`, verified against Postgres,
 * so an insert or update schema for one describes an operation the database will always refuse.
 *
 * An ordinary view is different and is deliberately left alone: Postgres auto-updatable views
 * accept inserts, and whether a given view qualifies depends on its query, which the schema file
 * does not say. Emitting insert schemas for those is correct.
 */
import { describe, it, expect } from 'vitest';
import { isReadOnlyRelation } from '../src/index';

/** A table, a view and a materialized view, identified the way Drizzle marks them. */
const table = { [Symbol.for('drizzle:Name')]: 't' };
const view = {
  [Symbol.for('drizzle:IsDrizzleView')]: true,
  [Symbol.for('drizzle:PgViewConfig')]: {},
};
const materialized = {
  [Symbol.for('drizzle:IsDrizzleView')]: true,
  [Symbol.for('drizzle:PgMaterializedViewConfig')]: {},
};

describe('recognising what cannot be written to', () => {
  it('marks a materialized view', () => {
    expect(isReadOnlyRelation(materialized)).toBe(true);
  });

  it('leaves an ordinary view alone', () => {
    // Postgres accepts an INSERT into a simple auto-updatable view, and whether a view qualifies
    // depends on its query rather than on anything the schema file states.
    expect(isReadOnlyRelation(view)).toBe(false);
  });

  it('leaves a table alone', () => {
    expect(isReadOnlyRelation(table)).toBe(false);
    expect(isReadOnlyRelation(null)).toBe(false);
    expect(isReadOnlyRelation({})).toBe(false);
  });
});
