---
'@drzl/validation-core': minor
'@drzl/generator-arktype': minor
'@drzl/generator-effect': minor
'@drzl/generator-json-schema': minor
'@drzl/generator-typebox': minor
'@drzl/generator-valibot': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

Enforce `CHECK (octet_length(col) <= n)`, which is a byte budget rather than a character count

`parseCheck` refused `octet_length` outright, on the recorded grounds that a byte count "depends on
the encoding and cannot be derived from a JavaScript string without choosing one". Both halves of
that are answerable: the encoding is UTF-8, and a `bytea` column does not arrive as a string at all.
The constraint is now read and routed into the byte-cap machinery MySQL's TEXT family already used.

```ts
// check('body_bytes', sql`octet_length(${t.body}) <= 5`)      // on a text column
body: z.string().refine((v) => new TextEncoder().encode(v).length <= 5, {
  message: 'body_bytes: octet_length(body) <= 5',
}),

// check('blob_bytes', sql`octet_length(${t.blob}) <= 5`)      // on a bytea column
blob: z.instanceof(Uint8Array).refine((v) => v.length <= 5, {
  message: 'blob_bytes: octet_length(blob) <= 5',
}),
```

**Three counts, and no two of them agree.** Measured on PostgreSQL 17.5 through PGlite, on a `text`
holding three emoji and a `bytea` holding six bytes:

| expression        | `text` | `bytea`        | JavaScript                                  |
| ----------------- | ------ | -------------- | ------------------------------------------- |
| `octet_length(x)` | 12     | 6              | `new TextEncoder().encode(v).length`        |
| `length(x)`       | 3      | 6              | `[...v].length`, or `v.length` on the array |
| `char_length(x)`  | 3      | does not exist | `[...v].length`                             |

`v.length` on a string is none of them: it counts UTF-16 units, which is 6 for those same three
emoji. So `length` is a character count on a text column and a byte count on a bytea one, and a
parser that read `octet_length` as one more spelling of `length` would put a character cap on a byte
budget. Measured on the real constraint: `CHECK (octet_length(t) <= 5)` accepts `'hello'` and one
emoji and refuses `'hellos'` and two emoji, and it is the last of those, two characters and eight
bytes, that a character cap takes and the column does not.

The parser now carries a `unit` on `LengthCheck`, and `lengthMeasure(column, check)` turns that plus
the column into one of three JavaScript expressions. It lives in `@drzl/validation-core` so the five
validation generators, the constraint ledger, `meta` and `drzl doctor` cannot disagree about what is
enforced.

**JSON Schema.** No draft has a byte-length keyword, so the same trade the MySQL byte budget already
made applies: the ceiling becomes `maxLength`, which counts characters and therefore refuses nothing
the column accepts, and the part it cannot catch is stated in `description`. A `bytea` travels as
base64, so its cap is the encoded length, `4 * ceil(n / 3)`, which is the padded length of a full
value and an upper bound on the unpadded one, measured over n = 0 to 20. That also gives a MySQL
`tinyblob` a bound it never had: 255 bytes is `maxLength: 340`, where the document previously said
nothing. A byte _floor_ reaches no keyword in either case.

**What is still refused, and now says so.** A count on a MySQL `binary(n)`/`varbinary(n)` cannot be
answered: the value arrives as a string from a lossy decode, so neither its characters nor their
re-encoding is the server's byte count. `drzl doctor` reports that as a new finding kind,
`check-uncountable`, rather than dropping it silently, and the ledger marks it unenforced with the
reason. The doctor's note that count clauses were "unreachable from a working schema" was true of
Postgres and is not true of MySQL, which has `OCTET_LENGTH` and a column whose bytes JavaScript
cannot see.
