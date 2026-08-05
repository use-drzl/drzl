---
'@drzl/analyzer': minor
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-json-schema': patch
---

A MySQL or SingleStore `binary(n)`/`varbinary(n)` column is a string, and its schemas stop rejecting
every row.

The same wrong answer took two forms, one per drizzle major. On 0.4x the analyzer read the word
"Binary" out of the class name and typed all four column builders as `Uint8Array`; on v1 it read the
`string binary` dataType those columns share with a Postgres `bit(n)` and gave them a bit string, so
all five generators emitted `^[01]*$` capped at n. Both are wrong about the same thing, and it was
settled by asking a live MySQL 8.4 through drizzle on both majors rather than by reading any of the
three layers in between:

```
raw mysql2          vbin -> Buffer <00 ff 41>
drizzle 0.45.2      vbin -> string, 3 code points, instanceof Uint8Array false
drizzle 1.0.0-rc.4  vbin -> string, identical
```

Measured through the emitted modules against that server, before and after, on both majors: the old
schemas rejected **every** row the column returned in zod, valibot, arktype and typebox, and the new
ones accept every one of them. The JSON Schema generator accepted them on 0.4x only by accident,
because `contentEncoding: 'base64'` is an annotation no validator enforces.

The declared width means two different things depending on direction, and both were measured:

- **out**, the decode is lossy, so n bytes become at most n code points. `<ff ff ff>` stored in a
  `varbinary(3)` comes back as 3 characters that re-encode to 9 UTF-8 bytes, so a byte cap on a
  select schema refuses a row the column itself returned.
- **in**, the server counts the encoded bytes. A `varbinary(8)` takes 8 ascii characters and refuses
  9, and takes 2 emoji (8 bytes) and refuses 3 (12 bytes), so a character cap on an insert schema
  promises a write the server refuses.

So the column now carries a `{ kind: 'byteString', length }` shape and each generator picks the
measurement its mode needs: characters on select, bytes on insert and update. Over a pool of writes
against the live server, the four typed generators went from 16 disagreements with it to 0 on each
major.

**What changes for you.** A select schema for one of these columns now accepts the string your
driver hands you and rejects a `Uint8Array`, which is the opposite of the 0.4x behaviour. An insert
schema accepts any string inside the byte budget, including the empty string and anything that is
not a run of `0` and `1`, and rejects one that is too long in bytes. `Column.tsType` for these four
builders is `'string'` and `Column.dbType` is `'BINARY'` on both majors, where 0.4x used to say
`Uint8Array`/`BLOB`; the declared width moved off `maxLength` and onto the shape.

**What does not change.** A Postgres `bit(n)` and a Cockroach `bit(n)`/`varbit(n)` keep the bit
string, which is correct for them. MSSQL `binary`/`varbinary` report `object buffer` and were never
on this path. Gel `bytes` really does hand back a Buffer and stays a `Uint8Array`. The JSON Schema
generator states the code-point cap in every mode, since JSON Schema has no keyword that counts
bytes; that is a necessary condition on insert rather than the whole one.

`drizzle-orm/zod` emits a bare unbounded string for these columns on 0.4x and the same rejects-every-row
bit string on v1, so this output is deliberately neither.
