---
'@drzl/generator-typebox': patch
'@drzl/analyzer': patch
---

A TypeBox select schema stops accepting a row that never mentions a column it declares, and two
SQLite classes the drizzle-orm 0.4x path could not name are named.

**The hole was a kind check, not a missing `required`.** Measured on TypeBox 0.34.52 rather than
reasoned about: `Value.Check` on an object visits every property named in `required` with
`value[key]`, which is `undefined` when the key is absent, and `Type.Unknown()` accepts `undefined`
along with everything else. The only thing that then refuses the row is a guard beside that visit,
`ExtendsUndefinedCheck(property) || IsAnyOrUnknown(property)`, and `IsAnyOrUnknown` reads the
property's `Kind`. So a bare `Type.Unknown()` keeps its key and
`Type.Union([Type.Unknown(), Type.Null()])` does not: its kind is `Union`, the guard never fires,
and the union's own check passes on `undefined` through the unknown arm. `TypeCompiler` agrees with
`Value.Check` on every case, so neither entry point caught it.

The `required` array named the key the whole time. Both the emitted source and the serialised JSON
Schema said the key was required, and one of them was not, which is why this was invisible to
anything that read the output instead of running it.

**What changes in the generator.** A nullable column whose type nothing can name no longer gets the
null union. `Type.Unknown()` already accepts `null`, so the union added no value and took the key
away. This reaches a `customType`, a column the analyzer could not name, an `any` column and a
typed json one, each alone or inside the `Type.Unsafe<T>` that `typedJson` and `typedColumns` emit,
since `Type.Unsafe` copies the wrapped schema's kind. Nothing is lost: the runtime check admits the
same set of values, and the static type does too, because a bare unknown already includes `null` and
a narrowed one takes its type from drizzle's own `$inferSelect`, which spells a nullable column
`T | null` on its own.

A nullable **array** of unknowns keeps its union, because `Type.Array(...)` has its own kind and
never had the hole. `insert` and `update` are unaffected: an absent key there is legitimate and is
decided by `Type.Optional`, which lets the key go missing over an unknown exactly as it should. The
emitted field shrinks from `Type.Union([Type.Unknown(), Type.Null()])` to `Type.Unknown()`.

The zod, valibot, ArkType and JSON Schema generators do not change. All four already required the
key for their own nullable unknown.

**What changes in the analyzer.** Two SQLite classes fell off the end of the 0.4x class-name path
and came back `unknown`, so every generator emitted a schema that accepts any value at all. Both
answers are taken from drizzle's own mappers on 0.45.2 and both match what v1 already says about the
same column:

- `blob({ mode: 'buffer' })` builds a `SQLiteBlobBuffer`, whose `mapFromDriverValue` hands the
  driver's Buffer straight back, so it is described as a buffer. A bare `blob()` is the same class
  on this major and is described the same way; on v1 a bare `blob()` builds a `SQLiteBlobJson`
  instead, and each major is reported as it is.
- `integer({ mode: 'timestamp' })` and `integer({ mode: 'timestamp_ms' })` are one class,
  `SQLiteTimestamp`, and one type: both hand back a `Date`, differing only in the scale of the
  integer on the wire, which `mapFromDriverValue` consumes and no validator ever sees. The arm that
  used to answer this tested `config.mode === 'timestamp'` and named only the first, so the second
  was unknown. Keying on the class covers both.

A `SQLiteBlob` class does not exist on either major, which is why a real `blob()` reached neither
that arm nor anything else.

Naming those two closes the TypeBox key hole for them as a side effect. It does not close it in
general, which is why the generator changed as well: a nullable `customType` has no runtime shape to
read on either major and is unnameable by design.
