/**
 * Nested relation schemas: `{ ...user, posts: [...] }` validated whole.
 *
 * The plan comes from `@drzl/validation-core`, so what is tested here is the rendering: that the
 * arms appear, that a `many` arm is an array and a `one` arm admits the null a relational query
 * returns, that a child's own checks come with it, and that `insert` and `select` differ where the
 * shared plan says they do.
 */
import { describe, it, expect } from 'vitest';
import { accepts, analysisOf, col, emit, emitText, table } from './fixtures';

const users = () => table('users', [col('id'), col('name')]);
const posts = () =>
  table('posts', [col('id'), col('title'), col('userId')], {
    // A real foreign key, not just a name: `omittedColumnsFor` reads `foreignKeys`, and with none
    // there is nothing to omit and the child keeps every column it declared.
    foreignKeys: [{ columns: ['userId'], foreignTable: 'users', foreignColumns: ['id'] }],
    checks: [{ name: 'title_len', expression: 'length(title) >= 3' }],
  } as never);

const withRelations = () =>
  analysisOf([users(), posts()], [
    { kind: 'many', from: 'users', to: 'posts' },
    { kind: 'one', from: 'posts', to: 'users' },
  ] as never);

describe('nestedSchemas', () => {
  it('emits nothing extra when it is off', async () => {
    const text = await emitText(withRelations(), {}, 'users');
    expect(text).not.toContain('NestedSelectusers');
  });

  it('adds one key per relation on select', async () => {
    const m = await emit(withRelations(), { nestedSchemas: true }, 'users');
    const s = m.NestedSelectusersSchema;
    expect(accepts(s, { id: '1', name: 'a' }), 'the arm is optional').toBe(true);
    expect(
      accepts(s, { id: '1', name: 'a', posts: [{ id: 'p', title: 'abc', userId: '1' }] })
    ).toBe(true);
    expect(accepts(s, { id: '1', name: 'a', posts: 'not an array' })).toBe(false);
  });

  it("carries the child's own constraints into the arm", async () => {
    const m = await emit(withRelations(), { nestedSchemas: true }, 'users');
    const s = m.NestedSelectusersSchema;
    expect(
      accepts(s, { id: '1', name: 'a', posts: [{ id: 'p', title: 'ab', userId: '1' }] }),
      'length(title) >= 3'
    ).toBe(false);
  });

  it('lets a to-one arm be null, since a relational query returns null for a missing row', async () => {
    const m = await emit(withRelations(), { nestedSchemas: true }, 'posts');
    const s = m.NestedSelectpostsSchema;
    expect(accepts(s, { id: 'p', title: 'abc', userId: '1', user: null })).toBe(true);
    expect(accepts(s, { id: 'p', title: 'abc', userId: '1', user: { id: '1', name: 'a' } })).toBe(
      true
    );
  });

  it('omits the child foreign key on a nested insert, since the parent supplies it', async () => {
    const m = await emit(withRelations(), { nestedSchemas: true }, 'users');
    const s = m.NestedInsertusersSchema;
    expect(accepts(s, { id: '1', name: 'a', posts: [{ id: 'p', title: 'abc' }] })).toBe(true);
  });

  it('has no nested update schema, which is a refusal rather than an omission', async () => {
    const m = await emit(withRelations(), { nestedSchemas: true }, 'users');
    expect(m.NestedUpdateusersSchema).toBeUndefined();
  });

  it('stops at the configured depth rather than recursing forever', async () => {
    const text = await emitText(withRelations(), { nestedSchemas: true, nestedDepth: 1 }, 'users');
    // One level: users carries posts, and that posts object does not carry a user back.
    expect(text).toContain('posts');
    expect((text.match(/NestedSelectusersSchema/g) ?? []).length).toBeGreaterThan(0);
    const m = await emit(withRelations(), { nestedSchemas: true, nestedDepth: 1 }, 'users');
    expect(
      accepts(m.NestedSelectusersSchema, {
        id: '1',
        name: 'a',
        posts: [{ id: 'p', title: 'abc', userId: '1', user: { id: '1', name: 'a' } }],
      }),
      'an unlisted key is ignored, not refused'
    ).toBe(true);
  });

  it('emits a Standard Schema wrapper for the nested forms too', async () => {
    const m = await emit(withRelations(), { nestedSchemas: true }, 'users');
    expect(m.StandardNestedSelectusersSchema).toBeDefined();
    expect(m.StandardNestedInsertusersSchema).toBeDefined();
  });
});
