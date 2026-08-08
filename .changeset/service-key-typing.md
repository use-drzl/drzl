---
'@drzl/generator-service': patch
---

Service key parameters are typed from the primary key instead of a hardcoded `id: number`

Every emitted `getById`/`update`/`delete` spelled its key parameter as `id: number` whatever
the primary key's type, so a varchar key made `eq(books.isbn, id)` TS2769 on every dialect
including Postgres: the generator was unusable on natural-key tables, invisible only because
the packed gate's fixture collapses builders through `db = {} as any`. The key is now read the
way every route generator reads it: every column of `primaryKey`, at its real type. A single
column keeps the parameter name `id` at the column's type (`string`, `bigint`, `Date`, an
enum's literal union; a column DRZL cannot type falls back to `Select<T>['col']`, exact by
construction). A composite key becomes one parameter per key column in key order, addressed
with `and(eq(...), eq(...))`, where it previously matched, updated and deleted by the FIRST
key column alone, touching every row that shared it, and `Update<T>` now omits every key
column rather than the first. A keyless table loses the methods that need a key rather than
addressing a fictional `id`, on MySQL its create throws with an explanation (nothing can read
the row back without RETURNING), and a composite create on MySQL skips `$returningId()`, which
reports nothing for one, and reads the row back by the input's key columns. Integer-key
emissions are byte-identical to before, proved by running the previous generator beside this
one over the same analyses (96 file pairs, the 18 that differ are exactly the natural,
composite and keyless ones). Stub-mode signatures follow the same policy, so an oRPC router
from `@drzl/template-orpc-service` over a stub service now fails tsc on non-integer keys
instead of compiling against a fictional `id: number` that addressed nothing; the oRPC
surface's own hardcoded key inputs are filed as their own defect. Red-first: 29 failing tests
including a live MySQL run where composite create returned the sibling row; green after
against real typed database objects on both drizzle majors, better-sqlite3 and MySQL 8.4.11.
