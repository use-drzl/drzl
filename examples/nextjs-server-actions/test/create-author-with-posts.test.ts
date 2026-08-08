/**
 * The nested payload, `{ ...author, posts: [...] }`, through the same action shape.
 *
 * `db.insert(authors).values({ ..., posts: [...] })` drops the `posts` key silently on both
 * Drizzle majors, so nothing in the ORM refuses this payload and nothing describes it either.
 * `NestedInsertAuthorsSchema` is what describes it, and this is the test that it does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthorWithPosts } from '../src/app/actions';
import { EMPTY_FORM_STATE } from '../src/lib/form-state';
import { listAuthors, listPosts, resetStore } from '../src/db/store';
import { MESSAGES } from '../src/lib/field-errors';
import { NestedInsertAuthorsSchema } from '../src/validators/zod';

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  }
  return data;
}

const GOOD = {
  handle: 'ada',
  email: 'ada@example.com',
  age: '36',
  postTitle: ['first light', 'second light'],
  postStatus: ['draft', 'live'],
};

beforeEach(() => {
  resetStore();
});

describe('createAuthorWithPosts', () => {
  it('writes the parent and its children, minting the foreign key in between', async () => {
    const state = await createAuthorWithPosts(EMPTY_FORM_STATE, form(GOOD));

    expect(state.status).toBe('created');
    expect(listAuthors()).toHaveLength(1);
    expect(listPosts(1)).toEqual([
      { id: 1, authorId: 1, title: 'first light', status: 'draft' },
      { id: 2, authorId: 1, title: 'second light', status: 'live' },
    ]);
  });

  it('puts a child issue on the child field, having asked the child table', async () => {
    const state = await createAuthorWithPosts(
      EMPTY_FORM_STATE,
      form({ ...GOOD, postStatus: ['archived', 'live'] })
    );

    expect(state.status).toBe('rejected');
    expect(state.errors).toEqual({ 'posts[0].status': [MESSAGES.status_valid] });
    expect(listAuthors()).toEqual([]);
  });

  it('carries the declared width of a child column', async () => {
    const state = await createAuthorWithPosts(
      EMPTY_FORM_STATE,
      form({ ...GOOD, postTitle: ['ok', 'x'.repeat(81)] })
    );

    expect(state.errors).toEqual({ 'posts[1].title': [MESSAGES.posts_title_maxlength] });
  });

  it('rejects the parent and the child in one pass', async () => {
    const state = await createAuthorWithPosts(
      EMPTY_FORM_STATE,
      form({ ...GOOD, age: '15', postStatus: ['archived', 'live'] })
    );

    expect(Object.keys(state.errors).sort()).toEqual(['age', 'posts[0].status']);
  });

  it('writes nothing at all when one child is bad', async () => {
    await createAuthorWithPosts(EMPTY_FORM_STATE, form({ ...GOOD, postStatus: ['archived', 'x'] }));

    expect(listAuthors()).toEqual([]);
    expect(listPosts(1)).toEqual([]);
  });

  it('describes a child without its foreign key, because there is no value to supply', () => {
    const parsed = NestedInsertAuthorsSchema.parse({
      handle: 'ada',
      email: 'ada@example.com',
      age: 36,
      posts: [{ title: 'first light', status: 'draft', authorId: 999 }],
    });

    expect(parsed.posts?.[0]).toEqual({ title: 'first light', status: 'draft' });
  });
});
