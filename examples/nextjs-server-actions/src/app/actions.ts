'use server';

/**
 * The two server actions the page posts to.
 *
 * Both do the same three things, and the middle one is the point: read the form, parse it with a
 * schema DRZL generated from the Drizzle schema, and only then write. Nothing here restates a
 * constraint. `age >= 18`, the 20-character handle and the `draft | live` set are declared once,
 * in `src/db/schema.ts`, and reach this file through the emitted schemas.
 *
 * Only async functions may be exported from a `'use server'` file, so the state type and the
 * error mapping live in `src/lib`.
 */
import { handleIsTaken, insertAuthor, insertAuthorWithPosts, type NewPost } from '../db/store';
import { fieldErrorsFor, messageForConstraint } from '../lib/field-errors';
import type { FormState } from '../lib/form-state';
import { InsertAuthorsSchema, NestedInsertAuthorsSchema } from '../validators/zod';

/**
 * A form posts strings. `age` is a number in the schema, so it is converted here rather than by
 * coercing inside the validator: an empty box would coerce to `0` and be reported as "you have to
 * be 18", which is a confident answer to a question nobody asked. `NaN` is refused as a number,
 * which is the truth about an empty box.
 */
function numberField(data: FormData, name: string): number {
  const raw = data.get(name);
  return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
}

function textField(data: FormData, name: string): string {
  const raw = data.get(name);
  return typeof raw === 'string' ? raw : '';
}

/** The repeated post rows, dropping the ones the user left blank. */
function postFields(data: FormData): NewPost[] {
  const titles = data.getAll('postTitle').map(String);
  const statuses = data.getAll('postStatus').map(String);
  return titles
    .map((title, i) => ({ title, status: statuses[i] ?? '' }))
    .filter((post) => post.title.trim() !== '' || post.status.trim() !== '');
}

export async function createAuthor(_prev: FormState, data: FormData): Promise<FormState> {
  const parsed = InsertAuthorsSchema.safeParse({
    handle: textField(data, 'handle'),
    email: textField(data, 'email'),
    age: numberField(data, 'age'),
  });

  if (!parsed.success) {
    return { status: 'rejected', errors: fieldErrorsFor('authors', parsed.error.issues) };
  }

  // `UNIQUE (handle)` is a fact about the table rather than about the row, so no per-row schema
  // carries it and the parse above could not have caught it. The ledger still names it, which is
  // what lets this branch report it in the same vocabulary as everything the schema did catch.
  if (handleIsTaken(parsed.data.handle)) {
    return {
      status: 'rejected',
      errors: { handle: [messageForConstraint('authors', 'authors_handle_key')] },
    };
  }

  const author = insertAuthor(parsed.data);
  return { status: 'created', errors: {}, created: author.handle };
}

export async function createAuthorWithPosts(_prev: FormState, data: FormData): Promise<FormState> {
  const posts = postFields(data);
  const parsed = NestedInsertAuthorsSchema.safeParse({
    handle: textField(data, 'handle'),
    email: textField(data, 'email'),
    age: numberField(data, 'age'),
    // The relation key is the child table's Drizzle export name, and the children carry no
    // `authorId`: there is no value to supply until the parent exists.
    posts,
  });

  if (!parsed.success) {
    return { status: 'rejected', errors: fieldErrorsFor('authors', parsed.error.issues) };
  }

  if (handleIsTaken(parsed.data.handle)) {
    return {
      status: 'rejected',
      errors: { handle: [messageForConstraint('authors', 'authors_handle_key')] },
    };
  }

  const { posts: children, ...author } = parsed.data;
  const written = insertAuthorWithPosts(author, children ?? []);
  return { status: 'created', errors: {}, created: written.handle };
}
