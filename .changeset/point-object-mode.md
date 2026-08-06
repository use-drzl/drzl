---
'@drzl/analyzer': minor
'@drzl/generator-zod': minor
'@drzl/generator-valibot': minor
'@drzl/generator-typebox': minor
'@drzl/generator-arktype': minor
'@drzl/generator-json-schema': minor
'@drzl/generator-service': minor
'@drzl/generator-orpc': minor
---

`point({ mode: 'xy' })` and `line({ mode: 'abc' })` are described as the objects they are, on both
drizzle-orm majors.

**`minor`, not `patch`.** The emitted TypeScript type of an object-mode `point` changes from
`string` (0.4x) or `[number, number]` (v1) to `{ x: number; y: number }`, and of an object-mode
`line` to `{ a: number; b: number; c: number }`. Code written against the old output does not
compile against the new. `CONTRIBUTING.md` asks for a bump above patch to be called out, and this is
the call-out.

**What changes for a user, in one sentence.** If you have a `point({ mode: 'xy' })`,
`line({ mode: 'abc' })` or `geometry({ mode: 'xy' })` column, your select schema stops rejecting
every row the driver returns, and your insert schema stops accepting a value the database refuses.
Nothing else moves: the tuple modes of the same three builders are untouched, and no other column
type reaches the code that changed.

### It was wrong on both majors, in two different ways

The two modes of these builders return different JavaScript values, and neither major's description
separated them.

On 0.4x there is no `codec` to read, so the column reaches the analyzer by class name, and a coarse
`/Point|Line/i` answered `string`. That regex was written for the two tuple classes and was catching
four: swept over every builder `pg-core` exports on 0.45.2, in every mode, it matches
`PgPointTuple`, `PgLineTuple`, `PgPointObject` and `PgLineABC`, and `string` is wrong for all four.
The tuple pair was fixed in `@drzl/analyzer@1.15.0`; this is the other half, and the regex is now
gone rather than narrowed.

On v1 the column states `dataType: 'object point'` while the tuple mode beside it states
`'array point'`, and the analyzer read only the second word. Both modes reached one arm and came
back as tuples, so a v1 select schema for an object-mode column rejected every row.

### The database settles it, not the first-party module

Asked of a real Postgres through PGlite, on drizzle 0.45.2 and again on 1.0.0-rc.4, on a `point`
and a `line` column:

| value passed to insert | rendered by drizzle    | server                                     |
| ---------------------- | ---------------------- | ------------------------------------------ |
| `{ x: 1.5, y: -2.25 }` | `(1.5,-2.25)`          | stored, and read back as `{ x, y }`        |
| `{ a: 1, b: 2, c: 3 }` | `{1,2,3}`              | stored, and read back as `{ a, b, c }`     |
| `[1, 2]`               | `(undefined,undefined)`| `invalid input syntax for type point`      |
| `'1,2'`                | `(undefined,undefined)`| `invalid input syntax for type point`      |
| `{ x: 1 }`             | `(1,undefined)`        | `invalid input syntax for type point`      |
| `{ x: 1, y: 2, z: 3 }` | `(1,2)`                | stored: the unlisted key is ignored        |

`mapToDriverValue` reads `.x`/`.y` off whatever it is handed, which is why a tuple and a string are
not rejected in JavaScript but produce a literal the server refuses.

So every named field is required and unlisted keys are not refused: the emitted object is
`z.object`/`v.object`/`Type.Object` rather than the strict form, which would turn away a write the
column accepts.

### What each generator emits

| generator     | emitted for `point({ mode: 'xy' })`                   |
| ------------- | ----------------------------------------------------- |
| zod           | `z.object({ x: z.number(), y: z.number() })`          |
| valibot       | `v.object({ x: v.number(), y: v.number() })`          |
| typebox       | `Type.Object({ x: Type.Number(), y: Type.Number() })` |
| arktype       | `type({ "x": "number", "y": "number" })`              |
| JSON Schema   | `type: 'object'` with both fields `required`          |
| service types | `{ x: number; y: number }`                            |
| oRPC          | the zod or valibot form above; `unknown` for arktype   |

ArkType is the one that is not a string. Its definition DSL cannot state an object at all,
`type({ p: '{ x: number, y: number }' })` throws `'{' is unresolvable`, and it throws at import, so
the field is emitted as a `type(...)` instance with `.array()`, `.or("null")` and an optional key
around it. In the oRPC generator, where every field value is a quoted DSL fragment that has to
compose with the nullable and optional wrappers, ArkType keeps `unknown` for the same measured
reason it already keeps it for a tuple.

### Still not stated

Postgres refuses a line whose A and B are both zero, `invalid line specification`, and accepts
`{ a: 0, b: 1, c: 0 }` beside it. No column shape carries a cross-field rule, so the insert schema
still promises that one write. It is pinned as a measured gap in
`packages/cli/test/point-object-mode.e2e.spec.ts` rather than left as a remark.
