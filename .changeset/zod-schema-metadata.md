---
'@drzl/analyzer': minor
'@drzl/validation-core': minor
'@drzl/generator-zod': minor
'@drzl/cli': minor
---

Emitted zod schemas can now carry the facts they cannot state about themselves.

`{ kind: 'zod', path: 'src/validators/zod', meta: true }` attaches zod's own `.meta()` to every
field and every table schema: the declared SQL type, the primary key, the unique constraints, the
dialect, whether the database generates or defaults the value, the declared width, and the CHECK
constraints, including the ones DRZL does not enforce.

```ts
bio: z.string().nullable().meta({ sqlType: 'text' }),
```

```ts
SelectusersSchema.shape.bio.meta(); // { sqlType: 'text' }
SelectusersSchema.meta().primaryKey; // ['id']
```

`z.toJSONSchema` copies the keys through, so the same option is what gets a declared width into an
OpenAPI document: DRZL enforces `varchar(254)` as a `.refine()`, and `toJSONSchema` drops every
refinement **in silence**, so without this the document says the column is an unbounded string and
nothing in it says otherwise. `maxLength` is the JSON Schema keyword, so a validator acts on it.

Off by default. On a ten-column table it costs about 48 bytes per field and 156 per schema, and
roughly doubles the emitted module; generated code ships in your bundle.

**Where it attaches is the whole design problem, and it is measured rather than reasoned about.**
`.meta()` returns a clone carrying the entry, so an operation that clones keeps it and one that
wraps does not. On zod 4.4.3, `.refine()`, `.min()`, `.describe()` and `.brand()` all preserve it,
while `.nullable()`, `.optional()`, `.default()`, `z.array()` and `.pipe()` each build a new schema
whose own `.meta()` answers `undefined`, reachable only at `.def.innerType`. DRZL wraps every
nullable column, every array, every optional-on-insert column and every field of an update schema,
so attaching to the base type would lose the metadata for most of the output. It is therefore
attached last, after every wrapper, which is also the position `z.toJSONSchema` reads as the
property's own keywords rather than as one arm of its `anyOf`.

Every key had to say something the schema does not already say. `nullable` is deliberately absent
for that reason: `.nullable()` is in the chain and `anyOf: [..., { "type": "null" }]` is in the
JSON Schema, so it would be a second copy of an answer the consumer already has. `hasDefault` is
present because a defaulted column and a nullable one are both `.optional()` on insert and the
wrapper cannot tell them apart. `unenforcedChecks` is present because nothing else in the emitted
module mentions a CHECK that DRZL declined; `drzl doctor` was the only place it appeared.

`{ meta: { description: true } }` additionally writes a `description`, which `toJSONSchema` maps to
the JSON Schema keyword of that name and which is the only key here any OpenAPI viewer renders
without being taught. It is separate because it is prose repeating the machine-readable keys beside
it, and prose is the most expensive thing in the output.

**There are no column comments to carry, and this was measured before the feature was scoped.**
`drizzle-orm` exposes none at all on either major: no comment-ish own key or prototype method on a
built column, and `pg.text('a', { comment: 'hello' })` is refused by TypeScript as an excess
property and, when passed through a variable, dropped at runtime with the string unreachable from
the built column by any path. Every key above is therefore a fact the analyzer derived, never text
the user wrote. The zod generator's documentation states this outright, because expecting it to
work is reasonable.

zod only, deliberately. The other four validation generators are not passed the option rather than
being passed it and ignoring it: each has a metadata facility of its own, and where the metadata
has to attach is exactly what had to be measured here. TypeBox is the obvious next one, because a
TypeBox schema is a JSON Schema and there is no placement question at all. The `json-schema`
generator does not read this either: it builds from the same analysis rather than from a zod schema,
so there is nothing to read.

`@drzl/analyzer` gains `Column.sqlType`, the column's type as the database declares it, from
Drizzle's own `getSQLType()`: `varchar(255)`, `numeric(10, 2)`, `timestamp with time zone`,
`text[]`, or an enum's type name. `dbType` could not answer this and was never meant to; it is a
label with exactly one consumer, `isIntegerColumn`, and it calls `varchar`, `char` and `text` all
`TEXT`. The two Drizzle majors disagree about an array and are reconciled: 0.4x wraps the column in
a `PgArray` whose own answer is already `text[]`, while v1 leaves the class alone and raises
`dimensions`, so the suffix is added from `arrayDimensions` when the type does not carry one. The
field is absent, never guessed, where a builder cannot answer.
