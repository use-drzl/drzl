import { createAuthor, createAuthorWithPosts } from './actions';
import { AuthorForm } from './author-form';
import { listAuthors, listPosts } from '../db/store';

// The store is an array in a module, so a page baked at build time would show an empty list
// forever. Nothing about DRZL requires this; it is what "the database is an array" costs.
export const dynamic = 'force-dynamic';

export default function Page() {
  const authors = listAuthors();

  return (
    <main>
      <h1>Schema to validated server actions</h1>
      <p>
        Every rule enforced below is declared once, in <code>src/db/schema.ts</code>, and reaches
        these forms through the zod schemas <code>drzl generate</code> wrote into{' '}
        <code>src/validators/zod</code>. Nothing in <code>src/app</code> or <code>src/lib</code>{' '}
        restates a constraint.
      </p>

      <h2>One author</h2>
      <p>
        Parsed with <code>InsertAuthorsSchema</code>. Try an age under 18, a handle of two
        characters, or the same handle twice.
      </p>
      <AuthorForm action={createAuthor} />

      <h2>An author and their first posts</h2>
      <p>
        Parsed with <code>NestedInsertAuthorsSchema</code>, which is the only thing that describes
        this payload: <code>db.insert</code> drops the <code>posts</code> key silently rather than
        refusing it. A post is <code>draft</code> or <code>live</code>.
      </p>
      <AuthorForm action={createAuthorWithPosts} withPosts />

      <h2>Rows</h2>
      {authors.length === 0 ? (
        <p>Nothing saved yet.</p>
      ) : (
        <ul>
          {authors.map((author) => (
            <li key={author.id}>
              <strong>{author.handle}</strong> ({author.email}, {author.age})
              <ul>
                {listPosts(author.id).map((post) => (
                  <li key={post.id}>
                    {post.title} [{post.status}]
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
