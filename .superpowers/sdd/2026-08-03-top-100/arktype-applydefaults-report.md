# `applyDefaults` in the ArkType generator emits modules that throw at import

Branch `fix/arktype-applydefaults`. Status: **fixed**, with one further class measured and filed
rather than fixed.

Everything below was measured first. There was no prior measurement to salvage. The arbiter is the
runtime: a real Drizzle table, the real `SchemaAnalyzer`, the real `ArkTypeGenerator`, and then the
emitted module **imported and executed**. Nothing here reads generated text for a verdict.

Versions: `arktype@2.2.3`, `drizzle-orm@0.45.2`, Node v22.22.0.

---

## 0. Why importing is the whole story

ArkType checks a default **against its own type when the module is built**, not when a row arrives.
Measured directly:

```
type({ x: 'string = "hello"' })                  -> {} parses to { x: 'hello' }
type('string = "GB"')                            -> ParseError: Defaultable definitions like
                                                    'number = 0' are only valid as properties in
                                                    an object or tuple
type({ x: type('string').default(5) })           -> ParseError: Default must be a string (was a number)
type({ x: type('string[]').default(() => [1]) }) -> ParseError: Default value at [0] must be a string
```

So a default ArkType cannot hold is not a wrong verdict on a row. It is **no verdict at all**: the
file throws on import and every module importing it goes down with it.

---

## 1. The measurement, before any change

One `pgTable` per shape, each with a `name` column and one `x` column, run through the real
analyzer and the real generator with `applyDefaults: true`, then imported.

| # | column | analyzer `defaultValue` | emitted insert field | import |
|---|---|---|---|---|
| 1 | `text().default('hello')` | `"hello"` | `'string = "hello"'` | OK, fills `hello` |
| 2 | `varchar(2).default('GB')` | `"GB"` | `type('string = "GB"').narrow(...)` | **THROWS** |
| 3 | `varchar(2).default(null)` nullable | `null` | `type("(string \| null) = null").narrow(...)` | **THROWS** |
| 4 | `jsonb().default({a:1})` | `{"a":1}` | `'number \| object \| string \| boolean \| null = {"a":1}'` | **THROWS** |
| 5 | `text().array().default(['a'])` | `["a"]` | `'string[] = ["a"]'` | **THROWS** |
| 6 | `timestamp().default(new Date(...))` | `"2020-01-01T00:00:00.000Z"` | `'Date = "2020-01-01T00:00:00.000Z"'` under `coerceDates: 'none'` | **THROWS** |
| 7 | `doublePrecision().default(Infinity)` | `Infinity` | `'number = null'` | **THROWS** |
| 8 | `bigint({mode:'bigint'}).default(7n)` | `7n` | none written | **GENERATOR CRASH** |
| 9 | `bigint({mode:'bigint'}).default(null)` nullable | `null` | `"(bigint \| null) = null"` | OK, **but unbounded** |
| 10 | ``text().default(sql`'eu'`)`` | absent | `"string?"` | OK, left optional |
| 11 | `timestamp().defaultNow()` | absent | `"Date \| string?"` | OK, left optional |
| 12 | `text().$defaultFn(...)` | absent | `"string?"` | OK, left optional |
| 13 | `smallint().default(3)` | `3` | `"-32768 <= number.integer <= 32767 = 3"` | OK, bound kept |
| 14 | `integer().default(5)` | `5` | `"-2147483648 <= number.integer <= 2147483647 = 5"` | OK, bound kept |
| 15 | `bigint({mode:'number'}).default(7)` | `7` | `"-9007199254740991 <= number.integer <= 9007199254740991 = 7"` | OK |
| 16 | `boolean().default(false)` | `false` | `"boolean = false"` | OK, falsy kept |
| 17 | `text().default(null)` nullable | `null` | `"(string \| null) = null"` | OK |
| 18 | `mood().default('ok')` | `"ok"` | `"'sad' \| 'ok' \| 'happy' = \"ok\""` | OK |
| 19 | `uuid().default('0000-...')` | `"0000-..."` | `'string.uuid = "0000-..."'` | OK |
| 20 | `numeric().default('1.5')` | `"1.5"` | `'string = "1.5"'` | OK |
| 21 | `doublePrecision().default(1.5)` | `1.5` | `"number = 1.5"` | OK |

The exact thrown messages:

```
2, 3   ParseError: Defaultable definitions like 'number = 0' are only valid as properties in an
       object or tuple
4      ParseError: '{"a"' is unresolvable
5      ParseError: Expected an expression before '["a"]'
6      ParseError: Default for x must be a Date (was string)
7      ParseError: Default for x must be a number (was null)
8      TypeError: Do not know how to serialize a BigInt      (thrown by the generator, at
       src/index.ts:254, before any file was written)
```

The analyzer's part was confirmed too, and it was already right: the shapes are told apart by
structure, not by helper name. `defaultNow()` and `` .default(sql`'eu'`) `` both leave a SQL object
carrying `queryChunks` and are dropped; `$defaultFn` leaves `default` undefined and sets
`defaultFn`; only a literal survives into `Column.defaultValue`.

### The three filed defects, against the measurement

- **A. A default on a narrowed field throws at import.** Rows 2 and 3. Reached by *every* capped
  string column with a literal default, which is what `varchar(n) DEFAULT ...` is. The cap is not
  expressible in ArkType's DSL, so the field is emitted as a `type(...)` call, and a defaultable
  string is not a type ArkType will build on its own.
- **B. A default whose value the DSL cannot carry throws at import.** Rows 4, 5, 6, 7, and the
  generator crash at 8. `JSON.stringify` was used as if it were an ArkType literal printer. It is
  not: it renders an object and an array as syntax the DSL has no place for, a Date as a string the
  `Date` type refuses, `Infinity` as `null`, and it throws on a bigint.
- **C. A bigint column silently loses its range on insert.** Row 9. The range rides a `.narrow()`,
  because the DSL cannot state a bigint bound at all, and that narrow was dropped whenever a
  default was applied. The three schemas of one column then disagreed about the same value:

  ```
  Insert with x = 2n ** 70n -> ACCEPTED
  Update with x = 2n ** 70n -> REJECTED: x must be between -9223372036854775808 and 9223372036854775807
  Select with x = 2n ** 70n -> REJECTED: x must be between -9223372036854775808 and 9223372036854775807
  ```

  The loose one is the one that runs before a write.

### One table, not one column

An ordinary 23-column `pgTable` (caps, bigints, arrays, enums, json, CHECK constraints) generated
with `applyDefaults: true`:

```
old   IMPORT THREW ParseError: Defaultable definitions like 'number = 0' are only valid as
      properties in an object or tuple
```

Not one field degraded. The whole file was unloadable.

---

## 2. The zod trap, asked of ArkType

In zod, `.default()` must **replace** `.optional()`, because an optional short-circuits on an
absent key and the default is never reached. ArkType's version of the same trap is louder:

```
type({ 'x?': 'string = "a"' })                 -> ParseError: Only required keys may specify
                                                  default values, e.g. { value: 'number = 0' }
type({ 'x?': type('string').default('a') })    -> the same ParseError
```

So in ArkType the stack does not silently misbehave, it refuses to build. The generator already got
this right in the DSL branch and the fix keeps it right in the builder branch: the `?` is suppressed
whenever a default is applied, wherever the default is finally written. `test/apply-defaults-shapes.spec.ts`
pins it by running the emitted module rather than by reading it.

---

## 3. The fix

`packages/generator-arktype/src/index.ts`. A default now goes where ArkType can hold it:

- It stays in the string DSL when the field is a plain DSL string **and** the value is a literal the
  DSL can spell. That is the common case and its output is unchanged: `country: "string = 'GB'"`.
- It moves to `.default()` on the Type, **after** the narrows, when the field carries a narrow at
  all, or when the value has no DSL literal. An object and an array arrive as `() => (...)` and a
  Date as `() => new Date("...")`, because ArkType refuses a non-primitive default given by value:
  "Non-primitive default must be specified as a function like `() => ({my: 'object'})`". A thunk is
  also what keeps two parses from sharing one object, which is asserted.
- A value that cannot be written down exactly is left out and the key stays merely optional, which
  is what an `sql` default and a `$defaultFn` have always done. `Infinity` is the one that looks
  like a literal and is not.
- Because the default no longer lives inside the string, the bigint narrow is no longer dropped, and
  C closes as a consequence of A rather than as a special case.

Kind matching is structural: `atDefaultFits` walks the array dimensions, then the column's shape,
then its `tsType`. All seven `ColumnShape` kinds are named; a `buffer` column is `TypedArray.Uint8`
and nothing reconstructible from JSON satisfies it, so it abstains.

## 4. After

Every one of the 21 shapes imports, and the values are what the database would have written:

```
varchar(2).default('GB')     type("string").narrow(...).default("GB")
                             absent -> "GB";  "TOOLONG" -> rejected;  "👍👍" -> accepted (2 chars)
varchar(2).default(null)     type("(string | null)").narrow(...).default(null)   absent -> null
jsonb().default({a:1})       type("number | object | ...").default(() => ({ a: 1 }))
                             absent -> { a: 1 }, a fresh object per parse
text().array().default(['a']) type("string[]").default(() => ["a"])              absent -> ["a"]
timestamp().default(date)    type("Date | string").default(() => new Date("2020-01-01T00:00:00.000Z"))
                             absent -> a Date, under coerceDates none, input and all alike
doublePrecision(Infinity)    left optional; absent -> key absent
bigint().default(7n)         type("bigint").narrow(...).default(7n)              absent -> 7n
bigint().default(null)       insert, update and select all reject 2n ** 70n
```

The 23-column table now loads and fills 13 defaults in:

```
new   IMPORT OK   insert({body:'hello'}) -> { body:'hello', day:2020-01-01T00:00:00.000Z,
      payload:{a:1}, tags:['a'], n_num:'1.5', code:'AAAA', name:'anon', m:'ok', n_int:0,
      n_dbl:1.5, n_small:3, big53:7, flag:false, big:null }
```

### With `applyDefaults` off, nothing moved

Generated the same 23-column table through the master build and this build, `applyDefaults: false`:

```
applyDefaults=false: BYTE IDENTICAL
```

That matters for `scripts/verify-packed.sh`, which runs `applyDefaults` through the **zod** generator
only (`kind: 'zod'`, pg dialect, line 3519). The arktype output that gate compares, counts and
ledgers is generated with defaults off, so **no count and no ledger entry moves**. The file was run
read-only and not edited.

### The emitted TypeScript still compiles, and its type did not change

`tsc --strict` over the emitted 23-column module: clean. And the two forms of default infer the same
thing, so moving one to the builder does not change a published type:

```ts
const a: (typeof dsl)['inferIn'] = {};       // omitting a defaulted key: legal in both forms
const b: (typeof builder)['inferIn'] = {};
const d: (typeof dsl)['infer'] = { x: 'GB' }; // present after parsing: required in both forms
const e: (typeof builder)['infer'] = { x: 'GB' };
```

---

## 5. Filed, not fixed: a default the column's own constraints refuse

ArkType validates a default against the constraints as well as the kind, at import:

```
type({ x: `'sad' | 'ok' | 'happy' = "zzz"` })            ParseError: Default for x must be
                                                         "happy", "ok" or "sad" (was "zzz")
type({ x: 'string.uuid = "nope"' })                      ParseError: Default for x must be a UUID
type({ x: '-32768 <= number.integer <= 32767 = 99999' }) ParseError: Default for x must be at
                                                         most 32767 (was 99999)
type('string').narrow(len <= 2).default('TOOLONG')       ParseError: Default must be at most 2
                                                         characters (was "TOOLONG")
```

So a schema whose DEFAULT contradicts its own column still emits a module that throws at import.
This is a different class from the three fixed here: the generator is not choosing a wrong
representation, the schema is self-contradictory, and Postgres refuses such a row at insert time
too. Policing it means re-implementing every emitted constraint at generation time (enum membership,
format regexes, numeric ranges, character and byte caps, CHECK constraints) and answering what to do
when one fails, since there is no warning channel in a generator. Left as it is, deliberately, and
recorded here rather than hidden: before this change **every** capped column with a default threw,
now only one whose default the column itself cannot hold does.

Two neighbours seen while measuring, both out of scope and neither introduced here:

- The same `JSON.stringify`-as-literal-printer assumption is in the zod generator
  (`packages/generator-zod/src/index.ts:371`), where a bigint-valued default crashes the run
  identically. Not touched: another agent owns that package this round.
- A nullable json column renders `(number | object | string | boolean | null | null)`, with `null`
  twice. Cosmetic, pre-existing, unrelated to defaults.

---

## 6. Verification

| gate | result |
|---|---|
| `pnpm build` | pass |
| `pnpm -r test` | pass, 12 packages, 1089 tests; arktype 97 (12 files) |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm verify:packed` | **pass** in 2m2s with `NO_COLOR=1`; see below |

`verify:packed` was run read-only and the script was not edited. Without `NO_COLOR=1` it reports
three FAILs in the carve-probe check (`scripts/verify-packed.sh:3707-3728`), all of the form

```
FAIL: src/carve-probe/pg-c_numeric.ts fails, but not with the TS2589 this carve-out exists for:
  <esc>[96msrc/carve-probe/pg-c_numeric.ts<esc>[0m:...<esc>[91merror<esc>[0m<esc>[90m TS2589: ...
```

which is the TS2589 the carve-out does exist for, coloured. The sandbox installs `typescript` from
npm, which is now **7.0.2**, and it colours diagnostics unconditionally, so the shell glob at line
3711, `*"error TS2589"*`, no longer matches its own output. Measured on that same TypeScript with an
unrelated one-line error:

```
FORCE_COLOR=3   substring-match: NO MATCH
FORCE_COLOR=0   substring-match: NO MATCH
TERM=dumb       substring-match: NO MATCH
NO_COLOR=1      substring-match: MATCHES
```

Unrelated to this change: the three probes are `matrix` columns carrying no default at all
(`"c_text": "string"`), and this branch's output with `applyDefaults` off is byte-identical to
master's. Reported rather than fixed because the controller owns that file. The narrow fix would be
`NO_COLOR=1` on those `npx tsc` invocations, or matching `"TS2589"` alone.

## 7. What changed

```
packages/generator-arktype/src/index.ts             the fix
packages/generator-arktype/test/apply-defaults-shapes.spec.ts   new, 19 cases over a real Drizzle
                                                    schema, every one importing the emitted module
packages/generator-arktype/test/bigint-range.spec.ts  the case that pinned defect C as intentional
                                                    now pins the bound being kept, plus a new case
                                                    for the bigint-valued default that used to
                                                    crash the generator
packages/generator-arktype/package.json             drizzle-orm as a devDependency, so the new spec
pnpm-lock.yaml                                      can build its fixtures from real Drizzle tables
docs/generators/arktype.md                          the `applyDefaults` section, which showed only
                                                    the DSL form
.changeset/arktype-applydefaults-loadable.md        patch
```
