# Service Generator

Generates typed CRUD service classes per table (Drizzle or stub).

Key options:

- `outDir`, `dataAccess`, `dbImportPath`, `schemaImportPath`
- `databaseInjection`: make services accept a database instance (serverless‑friendly)

See the [package README](https://github.com/use-drzl/drzl/blob/master/packages/generator-service/README.md) for details.

## Database Injection (serverless)

Pass a database into service methods instead of importing a global singleton.

```ts
export default defineConfig({
  generators: [
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle',
      schemaImportPath: 'src/db/schema',
      databaseInjection: {
        enabled: true,
        databaseType: 'Database',
        databaseTypeImport: { name: 'Database', from: 'src/db/db' },
      },
    },
  ],
});
```

Generated methods (example):

```ts
import type { Database } from 'src/db/db';

export class UserService {
  static async getAll(db: Database) {
    /* ... */
  }
  static async getById(db: Database, id: number) {
    /* ... */
  }
}
```

This aligns with Cloudflare Workers/Astro patterns where a db is created per request/context.

## Methods and key typing

Every key parameter is typed from the table's primary key, read column by column at each
column's real TypeScript type. `id: number` is what an integer key produces, not a fixed
spelling: a `varchar` key makes the same parameter a `string`, and `eq(table.key, id)` then
compiles against the real column. A composite key becomes one parameter per key column, in key
order, named after the columns (the function-signature analogue of a router's
`/:orgId/:userId`), and every method addresses the row with `and(eq(...), eq(...))` over the
whole key. A table with no primary key cannot address a row at all, so it loses the methods
that would have needed one, exactly as the route generators drop those routes.

| Primary key                    | Emitted methods beside `getAll(...)` and `create(input)`                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `integer` / `serial`           | `getById(id: number)`, `update(id: number, data)`, `delete(id: number)`                              |
| `varchar` / `text` / `uuid`    | `getById(id: string)`, `update(id: string, data)`, `delete(id: string)`                              |
| `bigint({ mode: 'bigint' })`   | `getById(id: bigint)`, `update(id: bigint, data)`, `delete(id: bigint)`                              |
| enum                           | `getById(id: 'draft' \| 'live')`, and the same union on `update`/`delete`                            |
| `timestamp({ mode: 'date' })`  | `getById(id: Date)`, `update(id: Date, data)`, `delete(id: Date)`                                    |
| composite `(orgId, userId)`    | `getById(orgId: number, userId: string)`, `update(orgId, userId, data)`, `delete(orgId, userId)`     |
| column DRZL cannot type        | drizzle mode types it `Select<T>['col']` (exact by construction); the stub spells `unknown`          |
| none                           | nothing else: `getById`/`update`/`delete` are not emitted, and no `eq` import is left behind         |

`Update<T>` omits every primary-key column, so a patch cannot move a row to another key: for a
composite key that is `Omit<..., 'orgId' | 'userId'>`, not just the first column. In
`databaseInjection` mode the `db` parameter stays first, ahead of the key columns.

## Examples

### Drizzle mode

```ts
export default defineConfig({
  schema: 'src/db/schemas/index.ts',
  generators: [
    {
      kind: 'service',
      path: 'src/services',
      dataAccess: 'drizzle',
      dbImportPath: 'src/db/connection',
      schemaImportPath: 'src/db/schemas',
    },
  ],
});
```

Produces services using `table.$inferSelect` / `$inferInsert` types and CRUD methods.

### Stub mode

```ts
export default defineConfig({
  generators: [{ kind: 'service', path: 'src/services', dataAccess: 'stub' }],
});
```

Stubs return sample values for quick prototyping.

## MySQL and SingleStore

These dialects have no `RETURNING`, and drizzle's MySQL and SingleStore builders have no
`.returning()` method, so `dataAccess: 'drizzle'` emits a different body for them. The dialect
comes from the analyzed schema; you configure nothing. Method signatures are identical to every
other dialect. The behavior is measured on MySQL 8.4.11 through mysql2, identically on
drizzle-orm 0.45.x and 1.0.0 rc:

- `create` inserts through drizzle's `$returningId()`, which reports an `AUTO_INCREMENT` or
  `$defaultFn` primary key as `[{ id }]`; a caller-supplied key it reports nothing for, and the
  input already carries the value. Either way the created row is then read back by that key and
  returned, so `create` still resolves to the full row.
- A composite key never goes through `$returningId()` (it reports nothing for one): `create`
  inserts, then reads the row back by every key column the input carries.
- `update` writes, then reads the row back by its key and returns it.
- `delete` is unchanged; it never used `RETURNING` on any dialect.
- A table with no primary key has nothing to read a created row back by, so its `create`
  throws with an explanation, the same way a `generatedAlwaysAs(...)` key's does. On dialects
  with `RETURNING`, keyless `create` works and returns the row.

Two divergences from the `RETURNING` dialects are worth knowing:

- `create` and `update` are two statements here (write, then read back) with no transaction
  around them, where Postgres and SQLite do one atomic statement. If another writer can race you
  on the same key, wrap the call in `db.transaction`.
- A `generatedAlwaysAs(...)` primary key cannot be round-tripped at all: the database computes
  the key and reports nothing back. `create` for such a table throws with an explanation; every
  other method works.

One corner degrades quietly: a primary key whose default is computed in SQL, such as
``.default(sql`(uuid())`)``, is reported by neither `$returningId()` nor the input, so `create`
inserts the row and resolves to `undefined`. A defaulted member of a composite key that the
caller omitted degrades the same way, because a composite key is read back from the input
alone. Use `$defaultFn` when a generated single-column key must come back from `create`; for a
composite key, supply every key column in the input.

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize

::: tip Need something else?
If this generator doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
