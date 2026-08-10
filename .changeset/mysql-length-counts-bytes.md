---
'@drzl/analyzer': patch
'@drzl/validation-core': patch
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-effect': patch
'@drzl/cli': patch
---

`CHECK (LENGTH(col) <= n)` on MySQL is a byte budget, and is now read as one

The CHECK parser is one parser for every engine, and `length()` is not one function:

```
            length()      char_length()   octet_length()
Postgres    characters    characters      bytes
SQLite      characters    characters      bytes
MySQL       BYTES         characters      bytes
```

So `CHECK (LENGTH(name) <= 5)` on a MySQL `varchar` was read as a five-character cap where the
server enforces five bytes. Measured on 8.4.11 on utf8mb4 through a real constraint: `'一'` is
accepted at three bytes and `'一二'` is refused at six bytes and two characters, while the schema
accepted the second. The error ran in the safe direction, since five bytes can never be more than
five characters, so no valid row was ever turned away; it under-enforced, which is the half a
validator exists for.

Verified end to end after the fix, the emitted schema against the server that enforces the CHECK:
six values covering ASCII, CJK and emoji, at and over the bound, and the two agree on every row.

`Table` now carries the engine it was declared for. That is the same kind of duplication `Column`
already has, where `maxBytes`, `allowsNaN` and `format` are dialect-derived facts stamped on so
nothing downstream has to know which server it is looking at; the shared check helpers take a
`Table` rather than an `Analysis`, and `length()` is the one thing they could not read without it.
`parseCheck` takes the dialect as an optional third argument, and absent still means the Postgres
reading, so a caller that does not know its engine keeps the answer it already had.

`LengthCheck` also carries the function as written. The label the constraint ledger matches an
issue's message against is built from it, and deriving the name back from the unit would have
relabelled a user's `length(name) <= 5` as `octet_length(name) <= 5`: a constraint they did not
write, in the one string two surfaces compare exactly. `char_length` is still printed as `length`,
which Postgres treats as the same function.

SingleStore is MySQL wire-compatible and is deliberately not claimed, for the reason the analyzer
gives everywhere else: no server of its own was measured.
