# drizzle-orm 0.4x and v1

DRZL reads your schema by importing it, so the drizzle-orm that decides what your columns are is the
one in **your** project, not one DRZL ships. Every DRZL package declares `drizzle-orm` as a dev
dependency only.

The two majors do not describe the same schema the same way. Where they differ, DRZL reports what
drizzle actually built, so the same source line can produce different generated output on either
side. This page is the list of those differences that reach emitted files, with a check you can run
for each.

## The versions

| Tag      | Version      | What it is                                     |
| -------- | ------------ | ---------------------------------------------- |
| `latest` | `0.45.2`     | what `npm install drizzle-orm` gives you today |
| `rc`     | `1.0.0-rc.4` | the v1 release candidate                       |

Both are analyzed on every CI run, over the same fixtures, and every difference between them either
fails the run or is named in a ledger with the reason. See
[How it is verified](/guide/verification#both-drizzle-orm-majors) for what that stage prints.

## Running both side by side

Every check on this page uses the same setup: install the other major under an alias, so one project
can import both.

```bash
npm install --save-dev drizzle-orm-v1@npm:drizzle-orm@1.0.0-rc.4
```

Write the column twice, once from each, and ask the analyzer:

```js
// probe.mjs, run as: node probe.mjs src/db/schema.ts
import { SchemaAnalyzer } from '@drzl/analyzer';

const a = await new SchemaAnalyzer(process.argv[2]).analyze({});
for (const c of a.tables[0].columns) {
  console.log(c.name, JSON.stringify({ tsType: c.tsType, sqlType: c.sqlType, dbType: c.dbType }));
}
```

Changing `from 'drizzle-orm/pg-core'` to `from 'drizzle-orm-v1/pg-core'` in the schema file is the
whole difference between the two runs. [`drzl explain`](/cli/explain) answers the same question with
more of the picture, and takes the schema path on `-s`.

## Differences that reach your generated output

### `bigint({ mode: 'string' })` exists only on v1, and 0.4x does not complain

0.45.2 spells the config as `'number' | 'bigint'`, so `mode: 'string'` is a type error there. At
runtime it is not an error at all: the branch tests only for `'number'`, so it falls through and
builds the **bigint-mode** column, whose driver mapping really does return a bigint. Nothing throws
and nothing warns.

DRZL describes what was built, so one source line produces two different validators:

```ts
bigint('n', { mode: 'string' }).notNull();
```

```ts
// drizzle-orm 0.45.2
"n": z.bigint().gte(-9223372036854775808n).lte(9223372036854775807n),

// drizzle-orm 1.0.0-rc.4
"n": z.string().regex(new RegExp("^\\s*[+-]?(\\d(_?\\d)*|0[xX]_?[\\da-fA-F](_?[\\da-fA-F])*|0[oO]_?[0-7](_?[0-7])*|0[bB]_?[01](_?[01])*)\\s*$")),
```

This is the difference to know about if you are moving a schema **down** from v1 to 0.4x, because
the type error is the only signal and a `// @ts-expect-error` or a cast removes it. The pattern on
the v1 side is the input syntax that dialect's server parses, and it differs between Postgres and
MySQL; a bare string accepted 14 values Postgres rejects.

### A `.array().array()` is two dimensions on 0.4x and one on v1

v1's `array()` takes its depth as a string, so `.array('[][]')` is the two-dimensional spelling and
chaining `.array()` stays at one however often you repeat it. v1 infers `string[]` for the column
below; 0.45.2 infers `string[][]`.

```ts
text('n').array().array();
```

```ts
// drizzle-orm 0.45.2
"n": z.array(z.array(z.string())).nullable().optional(),

// drizzle-orm 1.0.0-rc.4
"n": z.array(z.string()).nullable().optional(),
```

Both are right about their own major. Checked against each major's own first-party validator on this
exact column: `drizzle-zod` 0.8.3 on 0.45.2 accepts `[['a']]` and rejects `['a']`, and
`drizzle-orm/zod` on 1.0.0-rc.4 does the opposite.

### A bare `blob()` on SQLite is a different column

The two explicit modes agree across the majors. A bare `blob()` does not: 0.45.2 builds the buffer
column and 1.0.0-rc.4 builds the JSON one.

```ts
// drizzle-orm 0.45.2
"n": z.instanceof(Uint8Array).nullable().optional(),

// drizzle-orm 1.0.0-rc.4
"n": z.json().nullable().optional(),
```

### `numeric` and `decimal` carry their format only on v1

On 0.45.2 the column reports no format, so the emitted schema is a bare string and accepts
`'hello'`. This one is **DRZL's defect rather than a difference to live with**: it is in the gate's
`DEFECTS` ledger, named on every run, and filed rather than fixed.

```ts
numeric('n', { precision: 10, scale: 2 });
```

```ts
// drizzle-orm 0.45.2
"n": z.string().nullable().optional(),

// drizzle-orm 1.0.0-rc.4
"n": z.string().regex(new RegExp("^\\s*([+-]?(0[xX][0-9a-fA-F]...")).nullable().optional(),
```

### MySQL's `TEXT` family carries a character cap only on v1

v1 states a `length` equal to the type's own cap; 0.45.2 leaves it undefined. Both majors get the
**byte** cap, which DRZL derives from the SQL type rather than from drizzle:

```
drizzle-orm 0.45.2      body {"maxBytes":255,"sqlType":"tinytext"}
drizzle-orm 1.0.0-rc.4  body {"maxLength":255,"maxBytes":255,"sqlType":"tinytext"}
```

UTF-8 spends at least one byte per code point, so the byte cap is never the looser of the two, and
the character cap v1 adds can never be the deciding check. What changes is the **error report**: on
256 ascii characters into a `tinytext`, Zod and Valibot report one issue on 0.45.2 and two on
1.0.0-rc.4, ArkType names the byte cap on one major and the character cap on the other, and TypeBox
reports two errors against three. Anything that renders validation messages sees a difference. The
JSON Schema output is byte-identical on both majors: it carries `maxLength: 255` with a description
saying the real budget is bytes, which JSON Schema has no keyword for.

This one is in the `DEFECTS` ledger, and DRZL on 0.4x is **looser than the first-party validator for
0.4x**: `drizzle-zod` 0.8.3 emits the cap off its own text-subtype table rather than off `length`.

### Types 0.4x does not export at all

Not a difference in description, a difference in what compiles. A schema using any of these cannot be
imported under 0.45.2:

| Export                                                                     | 0.45.2       | 1.0.0-rc.4 |
| -------------------------------------------------------------------------- | ------------ | ---------- |
| `bytea` from `drizzle-orm/pg-core`                                         | not exported | function   |
| `blob`, `tinyblob`, `mediumblob`, `longblob` from `drizzle-orm/mysql-core` | not exported | function   |
| `tinytext`, `text`, `mediumtext`, `longtext` from `drizzle-orm/mysql-core` | function     | function   |

### The first-party TypeBox module on v1

If you are comparing DRZL's TypeBox output against drizzle's own on 1.0.0-rc.4: `drizzle-orm/typebox`
targets the newer `typebox` package rather than `@sinclair/typebox`, and fails on import against the
released one. `drizzle-orm/typebox-legacy` is the same module built for `@sinclair/typebox`, which is
what DRZL's TypeBox generator emits for, and it imports cleanly. The gate's parity stage uses
`typebox-legacy` for exactly this reason.

## Differences that used to reach your output and no longer do

Listed with the version boundary, because a lockfile older than one of these still has it.

| What                                                                 | Fixed in                                |
| -------------------------------------------------------------------- | --------------------------------------- |
| Every array column came back `unknown` on 0.4x                       | `@drzl/analyzer` 1.13.0                 |
| An enum column came back `unknown` on 0.4x                           | `@drzl/analyzer` 1.13.0                 |
| A view produced no schemas at all on 0.x                             | `@drzl/analyzer` 1.16.0                 |
| Unsigned integer columns got the signed range, differently per major | on `master`, not in a published release |

**Views** are the one worth checking a lockfile over. On every 0.x release a view answers `undefined`
to `drizzle:Columns`, `drizzle:Name` and `drizzle:Schema`, and its columns live only under
`Symbol.for('drizzle:ViewBaseConfig')`. The analyzer identified a table-like export by asking for
`drizzle:Columns`, so on 0.x it skipped every view and said nothing about it, while generating for
the same view normally on v1. Probed on 0.29.5, 0.33.0, 0.36.4, 0.39.3, 0.44.7, 0.45.0 and 0.45.2,
invisible on all of them, and on 1.0.0-beta.1, beta.24, rc.1 and rc.4, visible on all of them.
`pgView`, `pgMaterializedView`, `mysqlView` and `sqliteView` were all affected, in their
query-builder, explicit-column-list, `.existing()` and schema-qualified forms alike.

**Unsigned integers** were wrong on both majors and in different ways, which is why the fix is listed
here rather than as a difference: 0.4x gave every unsigned width the signed range and gave `serial`
no range at all, while v1 dropped `uint16`, `uint24` and `uint32` into an implicit-decimal path and
returned nothing for `uint64`. Both majors now answer with the type's own range, and the gate proves
they agree. The fix is on `master` and has not yet been published, so a released version still has
the old behaviour:

```ts
int('u', { unsigned: true });
// both majors: {"tsType":"number","sqlType":"int unsigned","min":"0","max":"4294967295"}
```

## Where DRZL is still wrong on 0.4x

Every one of these is in a ledger in `scripts/verify-packed.sh`, counted and named on every run, and
an entry that stops reproducing fails the run as loudly as an unledgered difference.

- **17 columns get a coarser `dbType` label**, because 0.4x carries no codec: `varchar`, `char` and
  `smallint` fold to `TEXT` or `INTEGER`, `date` to `TIMESTAMP`, `inet`, `cidr` and `macaddr` to
  `TEXT`. Setting all seventeen to the v1 value and regenerating produced 29 byte-identical files, so
  this label does not reach emitted output.
- **`numeric` and `decimal` accept any string**, on 3 columns. See above.
- **MySQL `TEXT` carries no character cap**, on 4 columns. See above.

A second group comes from the other direction, where the first-party validator **for 0.45.2** is
right and DRZL is not: MySQL `year`, SQLite `integer()` and SQLite `blob({ mode: 'bigint' })`, plus
their nullable twins, six columns in all. None of the six reproduces on 1.0.0-rc.4.
[Compared with the first-party validators](/guide/comparison#where-drzl-is-worse) lists them with
what each side emits. `integer()` is the one to know the shape of, because the two majors also
disagree about it:

```ts
// drizzle-orm 0.45.2
"n": z.number().int().gte(-9223372036854775808).lte(9223372036854775807).nullable().optional(),

// drizzle-orm 1.0.0-rc.4
"n": z.number().int().gte(-9007199254740991).lte(9007199254740991).nullable().optional(),
```

The emitted bound differs in all four libraries, but the **verdict** differs in three of them: zod's
own `.int()` refuses a number outside the safe-integer range without being asked, so the zod output
reaches the right answer despite the wrong bound.

## What is not measured

- **The cross-major comparison covers Postgres and the MySQL text family.** SQLite is compared
  against the first-party 0.4x validators but is not in the cross-major diff, so a difference that
  shows up only between the two majors on SQLite would not be caught there. The `integer()` bound
  above is one such difference, and it is caught by the parity pass instead.
- **Views are outside the diff's field guard**, deliberately: `pgMaterializedView` answers on
  1.0.0-rc.4 and returns undefined on 0.45.2, so the stage would report a whole table as v1-only.
  They are covered by the analyzer's own tests instead.
- **Nothing on this page is a claim about drizzle-orm's intent.** These are measurements of what each
  major builds, taken by importing it.

## See also

- [Upgrade notes](/guide/upgrading), for changes that came from a DRZL release rather than the ORM
- [How it is verified](/guide/verification)
- [Analyzer](/packages/analyzer), for the per-type facts the generators read
