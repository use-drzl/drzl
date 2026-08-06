---
'@drzl/generator-arktype': patch
---

`applyDefaults` emits a module that loads, for every shape a Drizzle default comes in.

ArkType checks a default against its own type when the module is built, not when a row arrives, so
a default it cannot hold is a `ParseError` at import: not a wrong verdict on a row but no verdict
at all, and every file that imports the schema goes down with it. Five ordinary column shapes did
exactly that, and one killed the generator before it wrote anything:

```
varchar(2).default('GB')            ParseError: Defaultable definitions like 'number = 0' are
                                    only valid as properties in an object or tuple
varchar(2).default(null)            the same
jsonb().default({ a: 1 })           ParseError: '{"a"' is unresolvable
text().array().default(['a'])       ParseError: Expected an expression before '["a"]'
timestamp().default(new Date(...))  ParseError: Default for x must be a Date (was string),
                                    under coerceDates: 'none'
doublePrecision().default(Infinity) ParseError: Default for x must be a number (was null),
                                    because JSON.stringify(Infinity) is the string "null"
bigint({ mode: 'bigint' }).default(7n)
                                    TypeError: Do not know how to serialize a BigInt, thrown by
                                    the generator itself
```

The first two are the common case: **any** capped string column with a literal default, which is
what `varchar(n)` with a `DEFAULT` is. One 23-column table with `applyDefaults: true` produced a
file that could not be imported at all.

A default now goes where ArkType can hold it. It stays in the string DSL when the field is a plain
DSL string and the value is a literal the DSL can spell; otherwise it moves to `.default()` on the
Type, after the narrows rather than inside the string, where an object and an array arrive as
`() => (...)` and a Date as `() => new Date(...)`.

Moving it there also closes a silent hole. A bigint column states its range through a narrow,
because the DSL cannot carry a bigint bound at all, and that narrow used to be dropped whenever a
default was applied: `bigint({ mode: 'bigint' }).default(null)` accepted `2n ** 70n` on insert and
refused it on select and update. The same value now gets the same answer from all three, and the
insert schema is the one that runs before a write.

A literal that cannot be written down exactly is left out rather than approximated, and the key
stays merely optional, which is what an `sql` default and a `$defaultFn` have always done.

With `applyDefaults` off the emitted text is byte-identical to before, checked over a 23-column
table carrying caps, bigints, arrays, enums and CHECK constraints.
