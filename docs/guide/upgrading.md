# Upgrade notes

Changes that altered what generated output **means**, rather than what it can do. Each one names the
version it landed in, shows the emitted code on both sides, and ends with a check you can run
against your own repository.

Both notes on this page shipped in the same release, published 2026-08-02.

| Package                   | Last version with the old behaviour | First version with the new |
| ------------------------- | ----------------------------------- | -------------------------- |
| `@drzl/analyzer`          | 1.13.0                              | **1.14.0**                 |
| `@drzl/validation-core`   | 3.13.0                              | **3.14.0**                 |
| `@drzl/generator-zod`     | 3.14.1                              | **3.15.0**                 |
| `@drzl/generator-valibot` | 3.13.0                              | **3.14.0**                 |
| `@drzl/generator-arktype` | 3.9.0                               | **3.10.0**                 |
| `@drzl/generator-typebox` | 0.7.0                               | **0.8.0**                  |
| `@drzl/cli`               | 4.13.1                              | **4.14.0**                 |

## Read the analyzer's version, not the CLI's

`@drzl/cli` **imports** `@drzl/analyzer` rather than bundling it, at a caret range, so the analyzer
your CLI loaded is whichever version your lockfile resolved. `drzl --version` prints the CLI's own
version and nothing else, and two packages whose output was affected by the first note below,
`@drzl/generator-service` and `@drzl/generator-orpc`, did not change version across the fix at all:
both sat at 2.1.2 and 2.5.0 on either side of it, because the defect was never in their code.

So a version number is the wrong instrument here. Read the resolved analyzer:

```bash
npm ls @drzl/analyzer
```

and then use the behavioural checks below, which do not depend on getting that arithmetic right.

## A table-level `unique()` was read as the primary key

**Affected:** `@drzl/analyzer` 1.4.0 through 1.13.0. **Fixed in 1.14.0.**

### Whether this reaches you at all

Only a table that declares a constraint with the table-level `unique(...)` builder, in the
extra-config callback:

```ts
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    org: integer('org').notNull(),
    handle: text('handle').notNull(),
  },
  (t) => [unique('org_handle').on(t.org, t.handle)] // this line
);
```

A `.unique()` **on a column** builds a different object and was never affected. Measured on both
sides of the fix: a schema whose only uniqueness is `text('email').notNull().unique()` gets
`primaryKey: { columns: ['id'] }` from 1.13.0 and from 1.20.1 alike.

### What went wrong

Drizzle's extra-config callback hands back builder objects, and the analyzer told them apart by
their shape. An index builder keeps its data under `.config` and carries a `unique` flag; a primary
key builder keeps `columns` on the instance and has no such flag. The rule was therefore "no
`unique` flag means this is the primary key".

`UniqueConstraintBuilder` also keeps `columns` on the instance, and also has no `unique` flag. You
can see the collision without any DRZL code, against drizzle-orm 0.45.2:

```ts
import { pgTable, serial, text, integer, unique, primaryKey } from 'drizzle-orm/pg-core';

const t = pgTable('users', {
  id: serial('id').primaryKey(),
  org: integer('org').notNull(),
  handle: text('handle').notNull(),
});

for (const e of [
  unique('org_handle').on(t.org, t.handle),
  primaryKey({ columns: [t.org, t.handle] }),
]) {
  const kind = String(e?.constructor?.[Symbol.for('drizzle:entityKind')]);
  const cfg = e?.config ?? e;
  console.log(kind, 'cfg.unique =', cfg?.unique);
}
```

```
PgUniqueConstraintBuilder cfg.unique = undefined
PgPrimaryKeyBuilder       cfg.unique = undefined
```

Worse than losing the constraint: the branch **replaced** the key it had already found. Builders are
told apart by `drizzle:entityKind` now, matched on the suffix because the dialect prefix varies and
the symbol survives minification.

### What your generated files look like

The same schema, analyzed by both versions:

```
@drzl/analyzer 1.13.0
  primaryKey: {"columns":["org","handle"]}
  unique:     []

@drzl/analyzer 1.14.0 and later
  primaryKey: {"columns":["id"]}
  unique:     [{"columns":["org","handle"],"name":"org_handle"}]
```

`@drzl/generator-service` reads `primaryKey` to build its lookups, so every addressing method
filtered on the wrong column. This is the file it wrote:

```ts
// @drzl/generator-service 2.1.2, on @drzl/analyzer 1.13.0
type Updateusers = Partial<Omit<typeof users.$inferInsert, 'org'>>;

export class UserService {
  static async getById(id: number): Promise<Selectusers | null> {
    const rows = await db.select().from(users).where(eq(users.org, id)).limit(1);
    return rows[0] ?? null;
  }
  static async update(id: number, data: Updateusers): Promise<Selectusers> {
    const rows = await db.update(users).set(data).where(eq(users.org, id)).returning();
    return rows[0];
  }
  static async delete(id: number): Promise<boolean> {
    await db.delete(users).where(eq(users.org, id));
    return true;
  }
}
```

and this is the same file today:

```ts
// @drzl/generator-service 2.4.0, on @drzl/analyzer 1.20.1
type Updateusers = Partial<Omit<typeof users.$inferInsert, 'id'>>;

export class UserService {
  static async getById(id: number): Promise<Selectusers | null> {
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }
  static async update(id: number, data: Updateusers): Promise<Selectusers> {
    const rows = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return rows[0];
  }
  static async delete(id: number): Promise<boolean> {
    await db.delete(users).where(eq(users.id, id));
    return true;
  }
}
```

`eq(users.org, id)` **compiles**, because `org` is an integer column and `id` is a number. Nothing
fails at build time. `getById` returns some row from the org; `update` and `delete` reach **every
row sharing that value**, silently, at runtime.

The stub emission (no `dataAccess: 'drizzle'`) has no WHERE clause and was never wrong in this way.
The row types were, in both modes: the columns mistaken for the key were dropped from the insert and
update interfaces, and the real key was added to them.

```ts
// on @drzl/analyzer 1.13.0
export interface Insertusers {
  id?: number;
}
```

```ts
// on @drzl/analyzer 1.14.0 and later
export interface Insertusers {
  org: number;
  handle: string;
}
```

The four validation generators read `primaryKey` through `@drzl/validation-core` when they build
**update** schemas, so an update schema dropped the wrong columns and kept the real key.

`@drzl/generator-orpc` did not read `primaryKey` at all when this shipped, so its routes were not
reached by this defect. The release note for the fix says "the service and router generators build
their lookups from that", which was true of the service generator and forward-looking about the
routers: oRPC only started addressing rows by the table's real key later, and until that landed it
addressed every table by a hardcoded `id`.

### Three ways to check your own repository

**Read the service you already have.** No install, no upgrade. Open your generated service and look
at what `getById` filters on:

```bash
grep -n 'where(eq(' src/services/*.ts
```

If the column named there is not that table's primary key, that file was generated by an affected
version and is wrong.

**Ask the CLI what the key is.** [`drzl explain`](/cli/explain) prints a `Keys` block, and needs no
config: it finds the schema itself.

```bash
npx @drzl/cli explain users
```

```
Keys
  PRIMARY KEY (id)  filled in by the database
  UNIQUE (org, handle)  org_handle
  INDEX (id)
```

A table whose `PRIMARY KEY` line names the columns you wrote a `unique(...)` over, with no `UNIQUE`
line beside it, is the shape of the defect. `drzl explain users --json` carries the same two facts as
`table.primaryKey` and `table.unique` if you would rather assert on them in a script.

**Regenerate and see whether anything moves.** [`drzl generate --check`](/cli/generate) rewrites
nothing and exits 2 with a unified diff when the committed output differs from what the current
version produces.

```bash
npx @drzl/cli generate --check
```

### If you were hit

Update `@drzl/analyzer` to 1.14.0 or later (`npm install @drzl/analyzer@latest`, or refresh the
lockfile entry), regenerate, and read the diff. A diff that moves `getById`, `update` and `delete`
onto a different column is this defect, and any call site that passed a non-key value as `id` was
addressing rows by a column that does not identify one.

## `varchar(n)` counts characters, and MySQL `TEXT` counts bytes

**Affected:** `@drzl/generator-typebox` 0.7.0 and earlier, `@drzl/generator-arktype` 3.9.0 and
earlier. **New shape in 0.8.0 and 3.10.0.** The Zod and Valibot output already counted code points
and did not change shape.

Two facts about the databases, neither of which the old output matched:

- `varchar(10)` counts **characters** in Postgres and in MySQL. Ten astral characters are a valid
  row. `Type.String({ maxLength: 10 })` and `"string <= 10"` both count UTF-16 code units, so both
  **refused a row the database accepts**.
- MySQL's `TEXT` family counts **bytes**. `tinytext` holds 255 ascii characters and 63 thumbs-up
  ones, and refuses the 64th at 256 bytes. Nothing counted bytes, so the emitted schema **accepted
  rows MySQL refuses**.

A character cap and a byte cap are now separate facts on the column, `maxLength` and `maxBytes`, and
a MySQL `TEXT` column carries both. See [Analyzer](/packages/analyzer) for the per-type table.

### TypeBox

Same column, `varchar('title', { length: 10 })`:

```ts
// @drzl/generator-typebox 0.7.0
import { Type } from '@sinclair/typebox';

export const InsertnotesSchema = Type.Object({
  title: Type.String({ maxLength: 10 }),
});
```

```ts
// @drzl/generator-typebox 0.8.0 and later
import { Type, Kind, TypeRegistry } from '@sinclair/typebox';

TypeRegistry.Set('DrzlRowCheck', (schema, value) =>
  (schema as { assert(v: unknown): boolean }).assert(value)
);

export const InsertnotesSchema = Type.Object({
  title: Type.Intersect([
    Type.String(),
    Type.Unsafe<unknown>({
      [Kind]: 'DrzlRowCheck',
      description: 'at most 10 characters',
      assert: (v: unknown) => typeof v !== 'string' || [...v].length <= 10,
    }),
  ]),
});
```

A MySQL `tinytext` column emits the same shape with the byte counter in it:

```ts
      description: 'at most 255 bytes',
      assert: (v: unknown) => typeof v !== 'string' || new TextEncoder().encode(v).length <= 255,
```

Three consequences, each measured:

**The verdict changed in both directions.** Ten thumbs-up characters into `varchar(10)`: refused by
0.7.0, accepted from 0.8.0, which is what both databases do. Sixty-four thumbs-up characters into a
MySQL `tinytext`, 256 bytes: accepted by 0.7.0, refused from 0.8.0, which is again what MySQL does.
Eleven ascii characters into `varchar(10)` are refused by both, and 255 ascii into `tinytext` are
accepted by both.

**The cap no longer survives `JSON.stringify`.** It is a `Kind`-registered `Type.Unsafe`, and a
registered kind is a function, so serialising the schema keeps only its description:

```
0.7.0 : {"maxLength":10,"type":"string"}
0.8.0+: {"allOf":[{"type":"string"},{"description":"at most 10 characters"}]}
```

If you were feeding DRZL's TypeBox output to AJV, to Fastify's schema compiler or into an OpenAPI
document, the width is not in the serialised form any more. TypeBox's own `Value.Check` and the
`Static<>` type are unaffected, and the emitted module still validates the cap when you run it. Use
the [JSON Schema generator](/generators/json-schema) where you need the cap as a keyword.

**The module gained a top-level side effect.** A file with any capped column now imports `Kind` and
`TypeRegistry` and calls `TypeRegistry.Set('DrzlRowCheck', ...)` when it loads.

### ArkType

```ts
// @drzl/generator-arktype 3.9.0
export const InsertnotesSchema = type({
  title: 'string <= 10',
});

export const UpdatenotesSchema = type({
  title: 'string <= 10?',
});
```

```ts
// @drzl/generator-arktype 3.10.0 and later
export const InsertnotesSchema = type({
  title: type('string').narrow(
    (v, ctx) => v == null || [...v].length <= 10 || ctx.mustBe('at most 10 characters')
  ),
});

export const UpdatenotesSchema = type({
  'title?': type('string').narrow(
    (v, ctx) => v == null || [...v].length <= 10 || ctx.mustBe('at most 10 characters')
  ),
});
```

The verdicts changed the same way TypeBox's did. Two shape changes matter beyond that:

- A capped field's value is a `Type` instance now, not a DSL string. Anything reading, rewriting or
  string-matching the emitted source will not find `string <= 10` any more.
- **The optional marker moved from the value to the key.** `"title": "string <= 10?"` became
  `"title?": type(...)`, because a `?` cannot be appended to a narrowed type. Both accept a missing
  `title`, so the behaviour is the same, but the emitted text is not.

### Three later changes on the same feature

If you are moving further than 0.8.0 or 3.10.0, these moved again:

- **`@drzl/generator-arktype` 3.11.0.** An array column's cap moved from the element to the whole
  value: `type('string[]').narrow((v, ctx) => ... v.every((e1) => ...))`.
- **`@drzl/generator-typebox` 0.12.0.** The predicate's guard changed from `v == null` to
  `typeof v !== 'string'`.
- **`@drzl/generator-json-schema` 0.4.1.** This generator ignored `maxBytes` entirely until then, so
  0.3.0 and 0.4.0 emitted no byte cap for a MySQL `TEXT` column. It now emits the cap as a
  `maxLength` with a description saying the real budget is bytes, which JSON Schema has no keyword
  for.

### The check

The caps are read off the column, so ask the analyzer what it sees before comparing any emitted
file. This needs no config:

```bash
npx @drzl/cli explain notes
```

The **What the generators read off each column** section names each cap in the units it is counted
in, `at most 10 characters` or `at most 255 bytes`, and marks a cap that nothing states with the
reason. Then regenerate:

```bash
npx @drzl/cli generate --check
```

Every capped string column in TypeBox or ArkType output will appear in that diff. That is expected,
and the diff is the whole migration: there is nothing to hand-edit.

## See also

- [drizzle-orm 0.4x and v1](/guide/drizzle-majors), for differences that come from the ORM rather
  than from a DRZL release
- [How it is verified](/guide/verification), for what the gate measures on every run
- [Compared with the first-party validators](/guide/comparison), including where DRZL is still wrong
