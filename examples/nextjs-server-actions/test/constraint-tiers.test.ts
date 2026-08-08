/**
 * Which tier answered, per constraint.
 *
 * The action only ever renders a message, so nothing above this file can tell a message match from
 * a bound match. They are not interchangeable: `matchedBy: 'message'` is an exact lookup on a
 * string the emitted schema itself wrote and cannot be wrong, and the other two are inferences.
 * This is the test that says which one each constraint in this example's schema actually gets, so
 * a change that quietly demotes one is visible.
 */
import { describe, expect, it } from 'vitest';
import {
  InsertAuthorsSchema,
  InsertPostsSchema,
  constraintForIssue,
  constraintsByTable,
} from '../src/validators/zod';

const AUTHOR = { handle: 'ada', email: 'ada@example.com', age: 36 };
const POST = { authorId: 1, title: 'first light', status: 'draft' };

function matchAuthor(row: Record<string, unknown>) {
  const result = InsertAuthorsSchema.safeParse({ ...AUTHOR, ...row });
  expect(result.success).toBe(false);
  return result.error!.issues.map((issue) => constraintForIssue('authors', issue));
}

describe('constraintForIssue', () => {
  it('matches a length CHECK by the message the schema wrote', () => {
    const [hit] = matchAuthor({ handle: 'ad' });

    expect(hit).toMatchObject({ column: 'handle', matchedBy: 'message' });
    expect(hit?.constraint.id).toBe('handle_len');
  });

  it('matches the declared width by the message the schema wrote', () => {
    const [hit] = matchAuthor({ handle: 'a'.repeat(21) });

    expect(hit).toMatchObject({ column: 'handle', matchedBy: 'message' });
    expect(hit?.constraint.id).toBe('authors_handle_maxlength');
  });

  it('matches a folded numeric CHECK by its bound, the name being gone', () => {
    const [hit] = matchAuthor({ age: 15 });

    expect(hit).toMatchObject({ column: 'age', matchedBy: 'bound' });
    expect(hit?.constraint.id).toBe('author_adult');
  });

  it('matches a folded set CHECK by its column, there being neither message nor bound', () => {
    const result = InsertPostsSchema.safeParse({ ...POST, status: 'archived' });
    expect(result.success).toBe(false);
    const [hit] = result.error!.issues.map((issue) => constraintForIssue('posts', issue));

    expect(hit).toMatchObject({ column: 'status', matchedBy: 'column' });
    expect(hit?.constraint.id).toBe('status_valid');
  });

  it('answers nothing for the column type failing, rather than blaming the nearest CHECK', () => {
    expect(matchAuthor({ age: 'thirty' })).toEqual([undefined]);
    expect(matchAuthor({ age: 2147483648 })).toEqual([undefined]);
  });
});

describe('the ledger', () => {
  // These two are the reason the ledger is not just a second copy of what the schemas already
  // enforce: a per-row validator cannot see either, so `enforced: false` is the honest answer and
  // the server has to do the checking itself.
  it('carries the unique constraint and the foreign key, marked unenforced', () => {
    const authors = constraintsByTable.authors!.constraints;
    const posts = constraintsByTable.posts!.constraints;

    expect(authors.find((c) => c.id === 'authors_handle_key')).toMatchObject({
      kind: 'unique',
      columns: ['handle'],
      enforced: false,
    });
    expect(posts.find((c) => c.id === 'posts_authorId_fkey')).toMatchObject({
      kind: 'foreignKey',
      enforced: false,
      references: { table: 'authors', columns: ['id'] },
    });
  });
});
