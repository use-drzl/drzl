---
'@drzl/generator-hono': patch
'@drzl/generator-express': patch
'@drzl/generator-trpc': patch
'@drzl/generator-orpc': patch
'@drzl/template-orpc-service': patch
'@drzl/validation-core': patch
'@drzl/generator-valibot': patch
---

The route generators stop calling a json, bigint or binary column `unknown`

A json column was `z.unknown()` in every router, and so were a bigint and a `bytea`. The same three
columns are typed by every standalone validator generator, so DRZL gave one column two answers
depending on which generator wrote it, and the router's answer was the widest thing a schema can
say. Anything at all passed validation there, including values the database refuses.

Each now states its wire form, which is the rule the Date entry beside it already followed:

```ts
// before, in every router
prefs: z.unknown(),  blob: z.unknown(),  big: z.unknown(),

// after
prefs: z.json(),
blob: z.base64().transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))),
big: z.string().regex(/^-?\d+$/),
```

Measured through the emitted schemas rather than read off them. A real body is accepted, the blob
arrives as a `Uint8Array`, and a bigint past 2^53 survives exactly: `'9007199254740993'` parses back
to the same digits. Five values the old schemas accepted are now refused, each of them one no
database column would take: `undefined` and a `Date` for the json column, a non-base64 string for
the binary one, and a number or `'12.5'` for the bigint.

The read side differs where the value differs. A handler returns a real `Uint8Array`, so the select
schema keeps `z.instanceof(Uint8Array)`; a bigint stays digits on both sides, because
`JSON.stringify(1n)` throws on the way out.

Valibot and ArkType get the same three, in their own spellings: the recursive json value, the base64
pipe, `TypedArray.Uint8` on the read side. The json value schema now lives in
`@drzl/validation-core` rather than being copied, since the standalone generator and the routers
need the same text.

A **bigint primary key is now wired** rather than stubbed. The oRPC service template refused to call
a service for one, because the input carried `unknown` and the service's parameter is a real
`bigint`. The input carries digits now and the pattern makes `BigInt()` total, so the call is
written: `LedgerService.getById(BigInt(input.seq))`.

The Express validation middleware also stops casting to `never`. It writes per slot instead, so the
body lands with no cast at all and the params cast names `typeof req.params`.

What is still `unknown` after this: a `customType` column with no `$type<T>()`, which nothing can
type and which `typedColumns` recovers. That one is honest.
