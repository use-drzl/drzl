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
- `update` writes, then reads the row back by its key and returns it.
- `delete` is unchanged; it never used `RETURNING` on any dialect.

Two divergences from the `RETURNING` dialects are worth knowing:

- `create` and `update` are two statements here (write, then read back) with no transaction
  around them, where Postgres and SQLite do one atomic statement. If another writer can race you
  on the same key, wrap the call in `db.transaction`.
- A `generatedAlwaysAs(...)` primary key cannot be round-tripped at all: the database computes
  the key and reports nothing back. `create` for such a table throws with an explanation; every
  other method works.

One corner degrades quietly: a primary key whose default is computed in SQL, such as
``.default(sql`(uuid())`)``, is reported by neither `$returningId()` nor the input, so `create`
inserts the row and resolves to `undefined`. Use `$defaultFn` when a generated key must come
back from `create`.

## Generated Output License

- You own the generated output. DRZL grants you a worldwide, royalty‑free, irrevocable license to use, copy, modify, and distribute the generated files under your project’s license.
- A short header is added by default. Configure via `outputHeader` in `drzl.config.ts`:
  - `outputHeader.enabled = false` to disable
  - `outputHeader.text = '...'` to customize

::: tip Need something else?
If this generator doesn't cover what you need, DM me on X (https://x.com/omardulaimidev) and we can scope it together.
:::
