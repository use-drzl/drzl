/**
 * The database, for a value of "database" that is an array in a module.
 *
 * PGlite would give this example a real Postgres in about two and a half seconds, and it was
 * deliberately not used. What is being demonstrated here is a request body being validated before
 * anything touches storage, and every constraint in the schema either lands in the emitted zod
 * schemas or is checked below against rows this file already holds. A real engine would add a wasm
 * dependency and an async init to a page render without moving a single assertion.
 *
 * The row types still come from the Drizzle schema, so a column renamed there stops this file
 * compiling.
 */
import type { authors, posts } from './schema';

export type Author = typeof authors.$inferSelect;
export type Post = typeof posts.$inferSelect;

export interface NewAuthor {
  handle: string;
  email: string;
  age: number;
}

export interface NewPost {
  title: string;
  status: string;
}

interface Store {
  authors: Author[];
  posts: Post[];
  nextAuthorId: number;
  nextPostId: number;
}

const store: Store = { authors: [], posts: [], nextAuthorId: 1, nextPostId: 1 };

export function resetStore(): void {
  store.authors = [];
  store.posts = [];
  store.nextAuthorId = 1;
  store.nextPostId = 1;
}

export function listAuthors(): readonly Author[] {
  return store.authors;
}

export function listPosts(authorId: number): readonly Post[] {
  return store.posts.filter((p) => p.authorId === authorId);
}

/**
 * Whether `UNIQUE (handle)` would reject this row.
 *
 * No per-row schema can answer this, which is exactly why the ledger carries the constraint by
 * name: the server checks the table and then looks the wording up under `authors_handle_key`,
 * the same way it looks up a CHECK that a parse rejected.
 */
export function handleIsTaken(handle: string): boolean {
  return store.authors.some((a) => a.handle === handle);
}

export function insertAuthor(row: NewAuthor): Author {
  const author: Author = { id: store.nextAuthorId++, ...row };
  store.authors.push(author);
  return author;
}

/**
 * The nested write the nested insert schema describes: parent first, then each child with the
 * foreign key the parent just minted. That column is absent from the payload because there was no
 * value to put in it until this line ran, which is why the emitted `NestedInsertAuthorsSchema`
 * drops it.
 */
export function insertAuthorWithPosts(row: NewAuthor, children: readonly NewPost[]): Author {
  const author = insertAuthor(row);
  for (const child of children) {
    store.posts.push({ id: store.nextPostId++, authorId: author.id, ...child });
  }
  return author;
}
