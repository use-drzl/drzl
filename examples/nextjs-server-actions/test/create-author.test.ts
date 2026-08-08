/**
 * The validation a server action does, exercised by calling the action.
 *
 * A server action is a function. Next's contribution is that a form post reaches it, and nothing
 * in this file needs that: the payload a browser would send is a `FormData`, which is a global,
 * so the whole validation path runs with no browser, no server and no Next runtime.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthor } from '../src/app/actions';
import { EMPTY_FORM_STATE } from '../src/lib/form-state';
import { listAuthors, resetStore } from '../src/db/store';
import { constraintsByTable } from '../src/validators/zod';
import { MESSAGES } from '../src/lib/field-errors';

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
  }
  return data;
}

const GOOD = { handle: 'ada', email: 'ada@example.com', age: '36' };

beforeEach(() => {
  resetStore();
});

describe('createAuthor', () => {
  it('writes the row when every constraint holds', async () => {
    const state = await createAuthor(EMPTY_FORM_STATE, form(GOOD));

    expect(state.status).toBe('created');
    expect(state.errors).toEqual({});
    expect(listAuthors()).toEqual([{ id: 1, handle: 'ada', email: 'ada@example.com', age: 36 }]);
  });

  it('rejects an under-age author on the age field, from the folded bound', async () => {
    const state = await createAuthor(EMPTY_FORM_STATE, form({ ...GOOD, age: '15' }));

    expect(state.status).toBe('rejected');
    expect(state.errors).toEqual({ age: [MESSAGES.author_adult] });
    expect(listAuthors()).toEqual([]);
  });

  it('rejects a short handle, from the message the emitted schema writes', async () => {
    const state = await createAuthor(EMPTY_FORM_STATE, form({ ...GOOD, handle: 'ad' }));

    expect(state.errors).toEqual({ handle: [MESSAGES.handle_len] });
  });

  it('rejects a handle past the declared width, on the derived constraint id', async () => {
    const state = await createAuthor(EMPTY_FORM_STATE, form({ ...GOOD, handle: 'a'.repeat(21) }));

    expect(state.errors).toEqual({ handle: [MESSAGES.authors_handle_maxlength] });
  });

  it('reports every broken field at once, rather than the first', async () => {
    const state = await createAuthor(
      EMPTY_FORM_STATE,
      form({ handle: 'ad', email: 'ada@example.com', age: '15' })
    );

    expect(Object.keys(state.errors).sort()).toEqual(['age', 'handle']);
  });

  it('falls back to the library wording when no constraint caused the issue', async () => {
    const state = await createAuthor(EMPTY_FORM_STATE, form({ ...GOOD, age: 'not a number' }));

    expect(state.errors.age).toHaveLength(1);
    expect(state.errors.age?.[0]).toMatch(/number/i);
    // Attributing this to `author_adult` would be the map over-claiming: the field failed to be a
    // number at all, and no CHECK said so.
    expect(state.errors.age).not.toEqual([MESSAGES.author_adult]);
  });

  it('rejects a duplicate handle, which no per-row schema can see', async () => {
    await createAuthor(EMPTY_FORM_STATE, form(GOOD));
    const state = await createAuthor(
      EMPTY_FORM_STATE,
      form({ ...GOOD, email: 'other@example.com' })
    );

    expect(state.status).toBe('rejected');
    expect(state.errors).toEqual({ handle: [MESSAGES.authors_handle_key] });
    expect(listAuthors()).toHaveLength(1);
  });
});

describe('the message book', () => {
  // Every key below is a constraint id out of the emitted ledger. Rename a CHECK in the schema,
  // regenerate, and the lookup would quietly fall back to the raw SQL rule instead of the wording
  // this app wrote. That is the failure this test is here to make loud.
  it('keys only on constraint ids the emitted ledger actually carries', () => {
    const known = new Set(
      Object.values(constraintsByTable).flatMap((t) => t.constraints.map((c) => c.id))
    );

    expect(Object.keys(MESSAGES).filter((id) => !known.has(id))).toEqual([]);
  });
});
