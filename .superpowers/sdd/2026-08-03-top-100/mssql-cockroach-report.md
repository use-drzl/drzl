# mssql and cockroach lose their boolean and string families to `unknown`

Branch `fix/mssql-cockroach-types`. Status: **fixed**, with two further defects measured and filed
rather than fixed.

There was no salvaged measurement for this one, so everything below was measured first. Two real
servers were run in Docker and asked directly: **SQL Server 2022** (`mcr.microsoft.com/mssql/server:2022-latest`)
and **CockroachDB v24.3** (`cockroachdb/cockroach:latest-v24.3`). Both dialects exist only on
drizzle-orm v1, so the tables were built against `drizzle-orm@1.0.0-rc.4`.

---

## 1. The measurement, before any change

A real `mssqlTable` with 23 columns and a real `cockroachTable` with 27 columns, run through the
real `SchemaAnalyzer`. Every field the analyzer states is recorded; fields it does not state are
omitted rather than shown as absent.

### mssql, 23 columns, **7 `unknown`**

| column | builder | tsType | dbType | nullable | other |
|---|---|---|---|---|---|
| i | `int` | number | INTEGER | true | min -2147483648, max 2147483647, integer true |
| ti | `tinyint` | number | NUMERIC | true | min -9007199254740991, max 9007199254740991, **integer false** |
| si | `smallint` | number | SMALLINT | true | min -32768, max 32767, integer true |
| b53 | `bigint({mode:'number'})` | number | BIGINT | true | min -9007199254740991, max 9007199254740991, integer true |
| b64 | `bigint({mode:'bigint'})` | bigint | BIGINT | true | min -9223372036854775808, max 9223372036854775807, integer true |
| **flag** | `bit` | **unknown** | **UNKNOWN** | true | |
| price | `decimal` | string | NUMERIC | true | format numeric |
| num | `numeric` | string | NUMERIC | true | format numeric |
| fl | `float` | number | DOUBLE | true | integer false |
| rl | `real` | number | REAL | true | min/max +/-340282346638528859811704183484516925440, integer false |
| **name** | `varchar(120)` | **unknown** | **UNKNOWN** | true | maxLength 120 |
| **nname** | `nvarchar(120)` | **unknown** | **UNKNOWN** | true | maxLength 120 |
| **code** | `char(4)` | **unknown** | **UNKNOWN** | true | maxLength 4 |
| **ncode** | `nchar(4)` | **unknown** | **UNKNOWN** | true | maxLength 4 |
| **body** | `text` | **unknown** | **UNKNOWN** | true | |
| **nbody** | `ntext` | **unknown** | **UNKNOWN** | true | |
| d | `date` | Date | DATE | true | |
| dt | `datetime` | Date | DATE | true | |
| dt2 | `datetime2` | Date | DATE | true | |
| dto | `datetimeoffset` | Date | DATE | true | |
| tm | `time` | Date | DATE | true | |
| bin | `binary(16)` | Buffer | BYTEA | true | shape `{kind:'buffer'}` |
| vbin | `varbinary(32)` | Buffer | BYTEA | true | shape `{kind:'buffer'}` |

No column carries `arrayDimensions` or `enumValues`; `mssql-core` exports no array or enum builder.
Seven `DRZL_ANL_UNKNOWN_COLUMN` warnings were raised, one per unknown column.

### cockroach, 27 columns, **6 `unknown`**

| column | builder | tsType | dbType | nullable | other |
|---|---|---|---|---|---|
| i | `int4` | number | INTEGER | true | min -2147483648, max 2147483647, integer true |
| si | `smallint` | number | SMALLINT | true | min -32768, max 32767, integer true |
| b53 | `bigint({mode:'number'})` | number | BIGINT | true | min/max safe-integer, integer true |
| b64 | `bigint({mode:'bigint'})` | bigint | BIGINT | true | min/max 64 bit, integer true |
| **flag** | `boolean` | **unknown** | **UNKNOWN** | true | |
| dec | `decimal` | string | NUMERIC | true | format numeric |
| num | `numeric` | string | NUMERIC | true | format numeric |
| rl | `real` | number | REAL | true | min/max +/-340282346638528859811704183484516925440, integer false |
| fl | `float` | number | DOUBLE | true | integer false |
| dp | `doublePrecision` | number | DOUBLE | true | integer false |
| **name** | `varchar(120)` | **unknown** | **UNKNOWN** | true | maxLength 120 |
| **code** | `char(4)` | **unknown** | **UNKNOWN** | true | maxLength 4 |
| **body** | `text` | **unknown** | **UNKNOWN** | true | |
| **str** | `string` | **unknown** | **UNKNOWN** | true | |
| u | `uuid` | string | UUID | true | format uuid |
| payload | `jsonb` | any | JSON | true | shape `{kind:'json'}` |
| d | `date` | string | DATE | true | |
| ts | `timestamp` | Date | DATE | true | |
| tm | `time` | string | TIME | true | |
| iv | `interval` | string | INTERVAL | true | |
| ip | `inet` | string | INET | true | |
| bt | `bit({dimensions:3})` | string | BINARY | true | shape `{kind:'bitstring',length:1,exact:false}` |
| vb | `varbit({dimensions:8})` | string | BINARY | true | shape `{kind:'bitstring',exact:false}` |
| g | `geometry({type:'point'})` | [number, number] | GEOMETRY | true | shape `{kind:'tuple',length:2}` |
| vec | `vector({dimensions:3})` | number[] | VECTOR | true | shape `{kind:'numberVector',length:3}` |
| m | `cockroachEnum` | string | TEXT | true | enumValues ['sad','ok','happy'] |
| **tags** | `text().array()` | **unknown** | **UNKNOWN** | true | arrayDimensions 1 |

Six `DRZL_ANL_UNKNOWN_COLUMN` warnings. Dialect detection worked on both: `mssql` and `cockroach`.

**13 unknown columns, all of them booleans or strings.** `tags` is the string hole wearing an
array: its element is the same `CockroachString` that `body` is.

---

## 2. Why

`describeV1Column` recognised a v1 column two ways, `codec` or the semantic half of `dataType`, and
mssql and cockroach columns have neither. Swept across **every column builder both cores export**,
22 for mssql and 27 for cockroach:

- **Not one states a `codec`.** Zero of 49.
- Thirteen state a bare `dataType` with no semantic half: `bit` says `boolean`; `varchar`,
  `nvarchar`, `char`, `nchar`, `text`, `ntext`, `string`, `bool`, `boolean` all say `boolean` or
  `string`.

`{ dataType: 'string' }` with no codec is exactly what a Drizzle 0.4x column looks like, so the gate
sent all thirteen to the class-name fallback, which carries arms for `Pg*`, `MySql*`,
`SingleStore*` and `Gel*` and none for these two. They fell off the end to `unknown`/`UNKNOWN`.

Every other dataType in both cores carries a semantic half and already passed the gate, which is
why the failure is exactly the boolean and string families and nothing else.

---

## 3. Ground truth, from the servers

Rows inserted through drizzle's own drivers (`drizzle-orm/node-mssql`, `drizzle-orm/cockroach`) and
read back.

### SQL Server 2022

```
bit           -> JS true / false                  ('yes' refused: "Conversion failed when
                                                    converting the varchar value 'yes' to bit")
varchar(120)  -> JS string   'hello'              (121 chars refused: "String or binary data
                                                    would be truncated", 120 accepted)
nvarchar(120) -> JS string
char(4)       -> JS string   'ab  '  (space padded to the declared width)
nchar(4)      -> JS string   'cd  '
text / ntext  -> JS string
tinyint       -> JS number   0..255               (256 refused, -1 refused, both "Arithmetic
                                                    overflow error for data type tinyint")
real          -> 3.4028234663852886e38 stored and returned exactly;
                 3.4028235677973366e38 refused, "Arithmetic overflow error for type real"
```

### CockroachDB v24.3

```
bool          -> JS true / false                  (1 refused: "value type int doesn't match
                                                    type bool of column")
varchar(120)  -> JS string                        (121 chars refused: "value too long for
                                                    type VARCHAR(120)")
char(4)       -> JS string   'ab  '
string / text -> JS string
string[]      -> JS string[]  ['a','b'] and []    ('a' refused: "could not parse \"a\" as
                                                    type string[]")
real          -> information_schema crdb_sql_type FLOAT4.
                 Insert 340282346638528859811704183484516925440 (the largest finite float32)
                 and the column hands back 3.4028235e+38, which as a double is
                 3.4028235e38 > 3.4028234663852886e38. Larger magnitudes are not refused;
                 the column saturates to infinity.
```

---

## 4. What the generated validators did, executed

All five generators, run over the analyzer's real output, emitted module imported and executed.
Each probe value is one a server returned or refused.

| | probes | wrong before | wrong after |
|---|---|---|---|
| mssql, 5 generators x (flag, name, body) | 50 | **25** | **0** |
| cockroach, 5 generators x (flag, name, tags) | 60 | **25** | **0** |

Identical five ways: zod, valibot, arktype, typebox and JSON Schema (compiled and run under ajv)
each accepted `'yes'` for a `bit`, `1` for a `bool`, a 121-character string for a `varchar(120)`,
`12345` for a `varchar`, `{a:1}` for a `text` and `[1,2]` for a `string[]`. The JSON Schema
generator emitted the property as literally `{}`, which is a valid schema that accepts every
instance.

The array wrapper was the one thing already working: `arrayDimensions` was read even while the
element type was not, so a bare `'a'` was refused for `tags` before the fix. Only the element was
open.

---

## 5. The fix

`packages/analyzer/src/index.ts`, three hunks inside `describeV1Column` and its preamble.

1. A third v1 marker, `V1_ONLY_ENTITY_KINDS = /^(?:MsSql|Cockroach)/`, checked on
   `drizzle:entityKind`. Sound for exactly these two because `mssql-core` and `cockroach-core` ship
   only on v1: grepping the whole installed `drizzle-orm@0.45.2` package finds the strings `MsSql`
   and `Cockroach` in none of its files, so no 0.4x column can reach it. `drizzle:entityKind`
   rather than `constructor.name` because it survives minification, which is what the rest of this
   function already uses.
2. The gate becomes `if (typeof codec !== 'string' && !semantic && !V1_ONLY_ENTITY_KINDS.test(entityKind)) return null;`.
   Past it, the existing `default:` arm already handles `js === 'boolean'` and `js === 'string'`
   correctly, and `maxLength` was already arriving from `columnConstraints`.
3. The `float` arm picks Postgres's 4 byte bound for cockroach, keeping MySQL's for mssql and
   singlestore. See addendum V below.

Everything the fix did **not** need to touch stayed untouched: the `default:` arm's body, the
`numeric` arm and the class-name fallback are unchanged, so the diff does not overlap the regions
other agents are working in.

The 13 columns now read:

```
mssql       flag boolean/BOOLEAN;  name nname string maxLength 120;  code ncode string maxLength 4;
            body nbody string, no maxBytes (MySQL's TEXT caps are a MySQL fact; SQL Server's
            text holds 2 GB, so borrowing 65535 would refuse rows this server stores)
cockroach   flag boolean/BOOLEAN;  name string maxLength 120;  code string maxLength 4;
            body str string;  tags string + arrayDimensions 1
```

`dbType` for the string family is `TEXT` rather than `VARCHAR`/`CHAR`, because those two spellings
are keyed off a codec neither dialect states. That matches what a Postgres `varchar` already
reports on the class-name path (`case 'PgVarchar': return { tsType: 'string', dbType: 'TEXT' }`),
and `dbType` feeds exactly one decision anywhere in the repo, `isIntegerColumn`'s
`dbType === 'INTEGER'` fallback, which a string column never reaches.

Unknown counts after: **0 of 23 and 0 of 27**, and zero `DRZL_ANL_UNKNOWN_COLUMN` issues.

## 6. The test

`packages/generator-zod/test/mssql-cockroach-types.spec.ts`, 14 tests. Written first; all 10
substantive ones failed for the right reasons before the fix (the 3 that passed are the dialect
name, the column counts and the mssql float bound, which the fix must not move).

It builds real `mssqlTable` and `cockroachTable` modules, runs the **real** `SchemaAnalyzer` over
them, feeds the **real** analysis to the **real** `ZodGenerator`, then imports the emitted module
and executes it. Nothing reads emitted text.

Reaching drizzle v1 needed a dependency: `packages/generator-zod` gains a devDependency
`"drizzle-orm-v1": "npm:drizzle-orm@1.0.0-rc.4"`. Aliased, so `import 'drizzle-orm'` everywhere
else still resolves to the 0.45.2 the workspace measures against, and devDependencies are not
published. It lives in `generator-zod` rather than `analyzer` because the analyzer cannot import a
generator (the dependency runs the other way), and this file needs both halves in one process.

The fourteenth test guards the near-miss the new marker creates: `MySqlVarChar` and `MsSqlVarChar`
differ by one letter, and a 0.45.2 MySQL column presents the exact shape the marker was added to
admit, `dataType: 'string'` with no codec. Catching it would send every 0.4x MySQL string and
boolean down the v1 path and past the byte caps the class-name path applies. Checked against the
real package rather than reasoned about: a real `varchar`, `boolean` and `text` from
`drizzle-orm@0.45.2/mysql-core` all still return `null` from `describeV1Column`.

Both the test and the fix were mutation-checked rather than trusted:

| mutation | result |
|---|---|
| the fix removed entirely (the branch base) | 10 of the 13 fail, each naming its column |
| `/^(?:MsSql\|Cockroach)/` -> `/Sql\|Cockroach/` | the near-miss test fails, **and** so does `analyzer/test/floats-and-tuples-0.4x.spec.ts` independently |
| `/^(?:MsSql\|Cockroach)/` -> the same with `/i` | **nothing fails, and nothing should**: `MsSql` and `MySql` differ at position 1 in the letter itself, not in its case, so that edit changes no answer. Recorded because it was the first mutation tried and a green run on it would have looked like a vacuous test |

## 7. Verification

```
pnpm build           pass
pnpm -r test         pass, 945 tests across 12 packages, 0 failures. 14 of those are new here.
pnpm typecheck       pass
pnpm lint            pass
pnpm verify:packed   pass, exit 0, and byte-identical to the same run on the branch base
```

`scripts/verify-packed.sh` was not touched and was run read-only, from this worktree.

**No count and no ledger in it moved, measured rather than reasoned.** It was run twice: once with
the analyzer reverted to the branch base and once with the fix, and the two logs were compared line
by line. Both exit 0. Ignoring the shell echoes, timings and temp paths that differ between any two
runs, the two are **424 lines each and identical**, the only difference being the exit marker this
branch appended to each log to tell them apart. All **144 parity lines match one for one**, same
dialects, same generators, same modes, same `n/n cols compared`, same waived counts.

That is what should have happened: the script contains no reference to `mssql` or `cockroach`
anywhere, so it has no fixture that can reach either dialect, and the new marker matches only class
names those two cores own. The point of running it both ways is that "cannot reach" is an argument
and this is a measurement.

Its opening stage still prints its standing WARN about four comment blocks in `verify-packed.sh`
itself that state a quantity in the idiom a restated one is written in. That WARN is identical in
both runs. The stage reads only `scripts/verify-packed.sh`, which this branch did not edit, so
those four are that file's to settle and the controller's to touch. Read by hand for this branch's
own prose instead: the counts in the new comments and in the changeset are measurements taken
against the servers and the builder sweep, not restatements of a declaration sitting beside them.

Its opening stage still prints its standing WARN about four comment blocks in `verify-packed.sh`
itself that state a quantity in the idiom a restated one is written in. That stage reads only
`scripts/verify-packed.sh`, which this branch did not edit, so those four are exactly the four that
were there before; they are that file's to settle and the controller's to touch. Read for this
branch's own prose: the counts in the new comments and in the changeset are measurements taken
against the servers and the sweep, not restatements of a declaration sitting beside them.

---

## 8. Filed, not fixed

### Addendum V, closed: cockroach `real` bound. **Fixed here.**

The filing was right and is now measured. CockroachDB's `real` is a `FLOAT4`
(`information_schema.columns.crdb_sql_type`) spoken over the Postgres wire, so it carries the
Postgres read-back this package already documents at `PG_FLOAT4_RANGE`: insert the largest finite
float32 and the column hands back `3.4028235e+38`, a *larger* double, so a select schema bounded at
MySQL's edge, which is that float32 exactly, refused a row the column had just returned. Now
bounded at `PG_FLOAT4_RANGE`.

MSSQL, which the same filing grouped with it, turns out to be right where it was. SQL Server 2022
stops a `real` exactly at the largest finite float32 and refuses the next candidate up with an
arithmetic overflow, which is MySQL's bound, which is where falling through already put it. That is
now asserted so a future cockroach change cannot drag it along.

One thing no range describes either way: CockroachDB does not refuse a magnitude at all, saturating
to infinity instead. That is the same open `Infinity`/`NaN` gap this package already records for
Postgres.

### New: mssql `tinyint` is unsigned, and DRZL calls it a wide non-integer

`tinyint` states `dataType: 'number uint8'`, and `uint8` is not in the width table in
`describeV1Column` (`int8` through `int64` plus `uint53` are). It falls through to the bare-number
arm and comes out `dbType: 'NUMERIC'`, `integer: false`, `min: '-9007199254740991'`,
`max: '9007199254740991'`.

Measured on SQL Server 2022: the column takes 0 and 255, and refuses 256 and -1, both with
"Arithmetic overflow error for data type tinyint". It is unsigned, 0..255, and it is an integer.
Fractions are truncated rather than refused, measured on the same server:

```
insert 1.5  -> stored 1
insert 2.5  -> stored 2
insert 2.4  -> stored 2
```

so a select never returns a fraction either. The emitted schema today accepts `-1`, `256`, `1e15`
and `1.5` for a column that stores none of them.

The fix is two lines, `uint8: ['0', '255']` in the same range map plus its `dbType`, but it is a
different defect from the one this branch was given and the map is a region other agents are
editing. Filed with the measurement rather than folded in.

### Not a defect, checked: mssql `time` typed as `Date`

`MsSqlTime` states `dataType: 'object date'`, so the analyzer answers `tsType: 'Date'`, where every
other dialect in this repo types a `time` column as a string. That looked like an inconsistency
worth filing, so it was probed instead of assumed. Inserting `'13:45:30'` into a `time` column on
SQL Server 2022 and reading it back through the `mssql` driver returns a real `Date` instance
(epoch day, time of day set), so `Date` is the correct type and the difference from the other
dialects is a real difference in the drivers. The offset the driver applies to the time of day is a
separate question this branch did not investigate.

### Not a defect, checked: the `char(n)` cap

Both servers space-pad a `char(4)` to exactly four characters, so `maxLength: 4` and a
code-point-count check accept what comes back. Probed through the emitted schema with the exact
padded strings both servers returned.
