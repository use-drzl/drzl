# Constraint Data and Form Error Maps

Emit `constraints.ts` beside the schemas: every CHECK, unique constraint, primary key and foreign
key on each table, as plain data, plus `constraintForIssue`, which turns a validation issue back
into the constraint that caused it.

```ts
{ kind: 'zod', path: 'src/validators/zod', constraints: true }
```

Available on the zod and valibot generators, off by default. With it off the emitted output is
byte-for-byte what it was before: this adds a file and changes nothing in the schemas.

A whole config:

```ts
export default {
  schema: 'src/db/schema.ts',
  outDir: 'src/api',
  generators: [
    { kind: 'zod', path: 'src/validators/zod', constraints: true },
    { kind: 'valibot', path: 'src/validators/valibot', constraints: { errorMap: false } },
  ],
};
```

## Why a schema is not enough

A validator says what a value must look like. It never says **which constraint said so**, and two
of a table's constraints are not in it at all.

- A failed parse hands a form a message and no way to attribute it. Zod's wording for a broken
  `age_adult` never mentions `age_adult`, so a form cannot look up its own phrasing for that rule,
  cannot highlight the field the rule is really about, and cannot tell that failure apart from the
  column's own type bound.
- **Uniqueness and foreign keys are absent in every form.** Whether a value is already taken, and
  whether the row it points at exists, are facts about the table rather than about the row, so no
  per-row schema can carry them. A form that wants to check a handle's availability, or render a
  picker for a foreign key, has nowhere to read them from.

## What it emits

For a table with a length cap, a few CHECKs, a unique constraint and a foreign key:

```ts
export const eventsConstraints: DrzlTableConstraints = {
  table: 'events',
  constraints: [
    {
      id: 'events_pkey',
      name: 'events_pkey',
      kind: 'primaryKey',
      columns: ['id'],
      rule: 'PRIMARY KEY (id)',
      enforced: false,
    },
    {
      id: 'events_name_key',
      name: 'events_name_key',
      kind: 'unique',
      columns: ['name'],
      rule: 'UNIQUE (name)',
      enforced: false,
    },
    {
      id: 'events_owner_fk',
      name: 'events_owner_fk',
      kind: 'foreignKey',
      columns: ['ownerId'],
      rule: 'FOREIGN KEY (ownerId) REFERENCES users (id) ON DELETE cascade',
      enforced: false,
      references: { table: 'users', columns: ['id'], onDelete: 'cascade' },
    },
    {
      id: 'age_adult',
      name: 'age_adult',
      kind: 'check',
      columns: ['age'],
      rule: 'CHECK (age >= 18)',
      enforced: true,
      bounds: [{ column: 'age', operator: '>=', value: '18' }],
    },
    {
      id: 'status_valid',
      name: 'status_valid',
      kind: 'check',
      columns: ['status'],
      rule: "CHECK (status IN ('draft', 'live'))",
      enforced: true,
      values: { column: 'status', values: ['draft', 'live'], kind: 'string' },
    },
    {
      id: 'email_len',
      name: 'email_len',
      kind: 'check',
      columns: ['email'],
      rule: 'CHECK (length(email) >= 3)',
      enforced: true,
      messages: ['email_len: length(email) >= 3'],
    },
    {
      id: 'events_name_maxlength',
      kind: 'maxLength',
      columns: ['name'],
      rule: 'at most 10 characters',
      enforced: true,
      messages: ['at most 10 characters'],
    },
  ],
};

export const constraintsByTable: Record<string, DrzlTableConstraints> = {
  events: eventsConstraints,
};
```

Nothing in the file imports anything. It is data, so a form builder, a server route or a one-off
script can read it without pulling a validator in.

## Mapping an issue back to its constraint

```ts
import { SelecteventsSchema, constraintForIssue } from './validators/zod';

const result = SelecteventsSchema.safeParse(row);
if (!result.success) {
  for (const issue of result.error.issues) {
    const hit = constraintForIssue('events', issue);
    if (hit) {
      form.setError(hit.column, { message: myMessages[hit.constraint.id] ?? hit.constraint.rule });
    }
  }
}
```

`hit.constraint.id` is the stable identifier: the SQL constraint name where the declaration has
one, and a derived name (`events_name_maxlength`) where SQL leaves it anonymous. Keying your own
messages on it is what turns "the row is bad" into "you have to be 18".

The same call works on a valibot issue. The two libraries report a failure differently enough that
the shapes have almost nothing in common, and the map reads both.

## What each library reports, measured

The same table, the same failing rows, on zod 4.4.3 and valibot 1.4.2. `mapped` is what
`constraintForIssue` answers.

| the row breaks                        | zod issue                                 | valibot issue                                     | mapped                                        |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| `CHECK (age >= 18)`                   | `too_small`, `minimum: 18`, zod's wording | `min_value`, `requirement: 18`, valibot's wording | `age_adult`, by the bound                     |
| `varchar(10)`                         | `custom`, `at most 10 characters`         | `check`, `at most 10 characters`                  | `events_name_maxlength`, by the message       |
| `CHECK (length(...))`                 | `custom`, `email_len: length(email) >= 3` | `check`, `email_len: length(email) >= 3`          | `email_len`, by the message                   |
| `CHECK (status IN ...)`               | `invalid_value`, zod's wording            | `picklist`, valibot's wording                     | `status_valid`, by the column                 |
| `CHECK (starts < ends)`               | `custom`, `path: ['starts']`              | `check`, **`path: []`**                           | `window_ok`, column recovered from the ledger |
| the value is not a number             | `invalid_type`                            | `number`                                          | nothing, which is correct                     |
| above the column's own `int4` ceiling | `too_big`, `maximum: 2147483647`          | `max_value`, `requirement: 2147483647`            | nothing, which is correct                     |

Two rows there are the whole design.

**The row check.** Valibot puts a check on the object and names no column at all, so a map keying
only on the path would have a message and nowhere to put it. The column comes out of the ledger
instead, and it is the same column zod chose.

**The column's own bound.** `age >= 18` is deliberately folded into the column's range rather than
emitted as a predicate, so DRZL writes no message for it and the constraint name is nowhere in the
issue. That fold is worth keeping: it gives the library's own machine-readable bound instead of a
sentence DRZL wrote. What it costs is exactly what the last row shows: a failure against the
column's `int4` ceiling arrives on the same column with the same family of code. The map answers
that one with nothing rather than blaming the nearest CHECK.

## How the match is made

Three tiers, in order, and the answer says which one hit.

1. **`matchedBy: 'message'`.** An exact lookup on a string these schemas wrote. Every constraint
   stated as a predicate carries one, and the ledger holds it verbatim, so this tier cannot be
   wrong. It is also asserted per generator: every message in the ledger has to appear in the
   emitted schema, byte for byte.
2. **`matchedBy: 'bound'`.** For a folded numeric CHECK. Both libraries put the bound on the issue
   as data, so the ledger's recorded bound is matched against it. A bound that belongs to the
   column's type matches nothing and gets no answer.
3. **`matchedBy: 'column'`.** For a folded set constraint, which becomes an enum and leaves neither
   a message nor a bound. Safe only because a column carries at most one.

The two folds are kept apart rather than pooled, and that is what stops the third tier
over-claiming: a folded bound **always** reports its bound, so an issue on that column carrying no
bound is not that constraint, it is the field failing to be a number at all.

The column is read from the **last** key on the path, so an issue inside an array column names the
column rather than the index. One case is not handled: an issue from a
[nested relation schema](/generators/nested-relations) belongs to a child table, and
`constraintForIssue` is told which table to look in by its caller. Pass the child's name for a
child's issue, or the answer will be whatever the parent happens to have under that column name.

## Constraints the database enforces and no schema does

A CHECK DRZL declines to translate is in the ledger, marked, with the parser's own reason:

```ts
{
  id: 'unparseable',
  name: 'unparseable',
  kind: 'check',
  columns: [],
  rule: 'CHECK (my_fn(name) > now())',
  enforced: false,
  unenforced: [
    { part: 'unparseable: my_fn(name) > now()',
      reason: 'not a single comparison this version understands' },
  ],
}
```

It is present rather than dropped because a form still wants to know the rule exists: the server
can reject a row this form accepted, and a form that knows it can say so instead of promising
otherwise. It can never produce a validation issue, so it never comes back from
`constraintForIssue`.

`drzl doctor` reports the same set as a checklist for a human. This is the machine-readable half of
that report, sitting next to the schemas rather than in terminal output.

A CHECK that **is** enforced but leaves nothing on the issue to match on carries neither `messages`
nor `bounds` nor `values`. `CHECK (email IS NOT NULL)` is the case: it is enforced by the field not
being nullable, so the failure is the library's own "expected string, received null" and no string
DRZL wrote appears in it. The entry says `enforced: true` and offers no message, rather than
offering one no emitted module ever writes:

```ts
{
  id: 'email_set',
  name: 'email_set',
  kind: 'check',
  columns: ['email'],
  rule: 'CHECK (email IS NOT NULL)',
  enforced: true,
}
```

## How this differs from `meta`

Both exist, and they answer different questions.

|              | `meta`                                         | `constraints`                              |
| ------------ | ---------------------------------------------- | ------------------------------------------ |
| describes    | a **field**                                    | a **table's constraints**                  |
| shape        | prose: `'age_adult: age >= 18'`                | data: `{ operator: '>=', value: '18' }`    |
| foreign keys | absent                                         | present, with the target and its actions   |
| unique       | column groups, names dropped                   | named, which is what the error map keys on |
| addressed by | holding the schema object, per field, per mode | a record keyed by table                    |
| destination  | `z.toJSONSchema`, then an OpenAPI viewer       | your own code                              |

Turn on `meta` when you want the emitted schemas to carry their provenance into a JSON Schema
document. Turn on `constraints` when something in your application has to reason about the
constraints themselves. They share one classification internally, so the two can never disagree
about which CHECKs are enforced.

`meta` remains the place to read a **column's** facts: its SQL type, whether the database defaults
the value, its declared width. Those are not repeated here.

## zod and valibot only, for now

Not a shortfall of effort, and the boundary was measured. The ledger claims two things about each
constraint: that the schemas enforce it, and the exact message they use when they reject a row.
Both are true of zod and valibot, which enforce the same constraints in the same words.

ArkType is why this is a per-generator capability rather than a global one. Measured on 2.2.3
against the same table: it folds `cardinality(tags) > 0` into its own DSL, moves a `length()` check
onto the object so the issue names no column, puts DRZL's wording in `expected` rather than in
`message`, and emits nothing at all for `name <> 'x'`. A ledger claiming that last constraint is
enforced would be wrong, and wrong in silence. TypeBox and Effect were not measured, so they are
not claimed.

## What it costs

For a table with twelve constraints, one primary key, one unique constraint, one foreign key, seven
CHECKs and a declared width:

| what             | source   | minified | minified and gzipped |
| ---------------- | -------- | -------- | -------------------- |
| data and the map | 10,110 B | 2,831 B  | 1,117 B              |
| data alone       | 5,291 B  | 1,855 B  | 708 B                |

Most of the source is doc comments and type declarations, and both vanish at build time. Use
`{ errorMap: false }` for the data without the matcher, which is the split between plan items 39
and 40 expressed as a flag.

The ledger is one module for the whole output directory, not one per table, so a consumer
importing one table's constraints pulls the record for all of them. That is the trade for
`constraintForIssue` being a single function that takes a table name.

## Options

```ts
{ kind: 'zod', path: 'src/validators/zod', constraints: true }
{ kind: 'zod', path: 'src/validators/zod', constraints: { enabled: true, errorMap: false } }
```

| option     | default | what it does                                        |
| ---------- | ------- | --------------------------------------------------- |
| `enabled`  | `false` | emit `constraints.ts` and export it from the barrel |
| `errorMap` | `true`  | also emit `constraintForIssue` and its types        |

`true` is the shorthand for `{ enabled: true }`.
