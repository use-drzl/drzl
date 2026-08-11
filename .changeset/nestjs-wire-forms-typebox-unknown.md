---
'@drzl/generator-nestjs': patch
'@drzl/generator-typebox': patch
---

NestJS stops calling a json or binary column `unknown`, and TypeBox's predicates take `unknown`

The NestJS DTOs had the hole the routers just lost: a json column and a `bytea` were `z.unknown()`,
so the schema accepted anything and the DTO field said `unknown` to the controller. Each states its
wire form now, and the class field states what the pipe hands over:

```ts
prefs: z.json(),                       // DrzlJsonValue, not unknown
blob: z.base64().transform(...),       // Uint8Array on the way in
big:  z.string().regex(/^-?\d+$/),     // unchanged
```

The read side keeps a real `Uint8Array`, which is what a controller returns. ArkType's write side is
the one exception and it is stated rather than papered over: it has no base64 decoder
(`string.base64.parse` throws on 2.2.3), so it validates the string and the DTO field says `string`.

The fixture family gained both columns, so the emitted tree is now compiled with them and the
runtime suite posts them: a base64 blob is decoded, `'not base64!!'` and a number are refused, and a
json column takes every shape a body can carry. The json half is a type-level win rather than a
runtime one, and the test says so: a body has been through `JSON.parse`, so no request can tell
`z.json()` from `z.unknown()` at runtime.

TypeBox's emitted predicates now take `unknown` where they narrow themselves, which is all six of
the single-value ones, and the type registry callback infers its parameters instead of taking two
`any`s. The two predicates that index a row keep `any`, and the reason now lives in the generator
rather than in every generated file: the output-size budget failed when it was written into the
emitted output, at 510 bytes per column against 490, which is the gate making the case better than
the comment did.
