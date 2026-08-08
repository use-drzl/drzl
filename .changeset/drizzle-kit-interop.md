---
'@drzl/cli': minor
'@drzl/analyzer': minor
---

drizzle-kit interop: the schema path can come from drizzle.config.ts, so it is written once

A drizzle-kit project already names its schema in `drizzle.config.ts`, and DRZL demanded the
same path again in `drzl.config.ts`; two files stating one fact is how the copies drift. Now
`schema` is optional: when omitted, DRZL reads kit's config instead, trying
`drizzle.config.ts`, `.js`, `.json` in kit's own candidate order (measured on drizzle-kit
0.31.10), announcing the file it read, and honouring kit's whole `schema` surface: a string, an
array, glob patterns, and a directory expanded one level exactly as kit expands it. The new
`drizzleKit` key pins it down when wanted: a path mirrors kit's `--config` flag, `true` makes a
missing kit config an error, `false` disables the fallback. `schema` always wins when both are
set, with a warning; neither yielding a schema is an error naming both files. The `dialect` the
kit config declares is cross-checked against what the analyzer measures and a contradiction
warns, since a stale dialect line usually means the config points somewhere it should not.
`watch` treats it all as config surface: the resolved directories are watched (glob bases
included, so a new file matching the pattern rebuilds), and editing `drizzle.config.ts`
re-resolves the schema. `SchemaAnalyzer` now takes `string | string[]` so a barrel-less
multi-file schema analyzes as one schema; duplicate export names are judged by what Drizzle
says they are (table name, SQL schema, columns), so the ordinary re-export pattern stays
silent and a genuine disagreement warns as `DRZL_ANL_DUP_EXPORT`, keeping the first file's
export deterministically.
