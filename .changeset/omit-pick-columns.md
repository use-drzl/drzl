---
'@drzl/cli': minor
---

Generate for a subset of a table's columns, without post-processing the output.

`include`/`exclude` is all or nothing per table, and the column that should not appear in a
generated schema is usually sitting in a table you do want: a `passwordHash` on `users`, an internal
note beside the public fields, a `tenantId` the server sets from the session. The only previous
answer was to edit the emitted file, which the next `drzl generate` overwrites.

```ts
columns: {
  users: { omit: ['passwordHash'] },
  'app_*': { omit: ['deleted_at'] },
  audit_log: { pick: ['id', 'action', 'created_at'] },
},
```

The key is a table pattern in the same language `include`/`exclude` already uses, sharing the same
implementation rather than a second copy of it: the database table name, anchored, with `*` as the
only metacharacter. Column patterns are that language again. Every matching entry applies in the
order written, and within one entry `pick` narrows before `omit` removes, so `omit` wins, which is
the precedence `exclude` already has over `include`.

Four decisions worth knowing:

- **It narrows the analysis, once, before any generator is constructed**, at the same seam
  `filterTables` already uses. Not in `@drzl/analyzer`, which reads a schema module and has no
  config: `drzl analyze` has to keep printing what is really there. And not in each generator, of
  which there are nine plus two template packages: the one that forgot would emit a schema silently
  wider than the config asked for. Narrowing the analysis is also what keeps the validators, the
  OpenAPI document, the emitted `.meta()` facts and the service layer describing the same columns,
  since all of them read that one object.

- **A pattern that matches nothing is an error, not a no-op.** `omit: ['passwrodHash']` treated as a
  no-op leaves the column exactly where it was while reading like a fix, and nothing downstream can
  tell that apart from a column that was never there. A table pattern matching no table and a
  column pattern matching no column both stop the run before anything is written, with every such
  problem in one message. A column pattern has to match in at least one of the tables its entry
  matched, not in all of them, which is what makes a wildcard table key usable.

- **Omitting a primary key column is refused.** The generated `getById`, `update` and `delete`
  address rows by that key and every generator reads it differently, so the consequence would
  depend on which generators happened to be configured: the tRPC generator resolves the key against
  the columns and silently drops those three procedures, the oRPC generator never reads the key and
  keeps emitting them typed `{ id: number }`, the service generator falls back to a column literally
  named `id` and emits `eq(users.id, id)`, and the OpenAPI document drops its `/{id}` paths. One
  config, four outcomes, none announced. Refusing is also the reversible direction: an error can be
  relaxed to a warning later without breaking a config that works.

- **Omitting a NOT NULL column with no default is a warning, and generates.** It really does produce
  an insert schema that cannot describe a whole row, and it is also the normal multi-tenant shape: an
  insert schema describes a request body, not a row, and the server fills in the rest. The warning
  says who has to supply the column. A CHECK naming an omitted column warns too, since nothing DRZL
  emits can enforce it any more, though the database still does.

There is deliberately no per-mode form: a column cannot be kept in `select` and dropped from
`insert`. The service generator's `Update<Table>` is `Partial<Omit<typeof users.$inferInsert, 'id'>>`
taken from Drizzle's own types rather than from the analysis, so a per-mode narrowing would be
invisible in half the generated tree.

The narrowing covers more than the column list, because a table names its columns again in
`primaryKey`, `unique`, `indexes`, `foreignKeys` and `checks`. `unique` reaches emitted TypeScript
verbatim through `findDuplicate<Table>`, so a stale name there is a generated file that does not
compile; `unique`, `indexes` and `foreignKeys` are narrowed with the columns. `checks` deliberately
is not: the generators already skip a row check naming a column the mode does not carry, and leaving
it lets `meta` keep listing the constraint as unenforced, which is the true answer.

Measured, because a schema that stops describing a column and a schema that stops carrying its value
are different claims. Pushing a row that still holds the omitted column through the emitted select,
insert and update schemas: zod 4.4.3, valibot 1.4.2 and Effect 3.22.1 strip the key; TypeBox 0.34.52
strips it under `Value.Parse` and `Value.Clean` while `Value.Check` alone still returns `true`;
arktype 2.2.3 leaves it in place; and the JSON Schema output emits `additionalProperties: false`, so
a validator rejects the payload instead of trimming it. Those are the validators' own policies about
undeclared keys, not something DRZL sets.
