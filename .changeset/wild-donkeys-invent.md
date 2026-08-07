---
'@drzl/generator-typebox': minor
'@drzl/cli': minor
---

TypeBox schemas can now back a tRPC or oRPC router.

`{ kind: 'typebox', path: 'src/validators/typebox', standardSchema: true }` gives every emitted
schema a `~standard` key, so `t.procedure.input(InsertusersSchema)` and
`os.input(InsertusersSchema)` both typecheck, validate, and infer the real shape on the client.

TypeBox was the one validator DRZL emits with no route to Standard Schema, which is the stated
reason both router generators exclude it. Measured on `@sinclair/typebox` 0.34.52: a bare
`Type.Object()` has own keys `type,required,properties` and no `~standard`, and the package exports
nothing matching `/standard/i` from its root or from `value`. zod 4.4.3, valibot 1.4.2 and arktype
2.2.3 all carry one already, so the option exists on this generator alone and is not passed to the
others.

Implemented against `@standard-schema/spec` v1 as published in 1.1.0: `version` fixed at the
literal `1`, a `vendor` string, and a `validate` that returns a result rather than throwing, plus
the optional `types` that carries the input and output types. `validate` is synchronous, which the
spec permits and which keeps an input check off the microtask queue.

Four decisions worth knowing:

- **The key is attached to the schema, not exported beside it.** A TypeBox schema is a plain
  extensible object, so the wrapper is the same object and nothing is dropped. It is defined
  non-enumerably, so `JSON.stringify` still produces the same JSON Schema document byte for byte,
  `Object.keys` still lists only JSON Schema keywords, and `Value.Check`, `TypeCompiler` and
  `Static<typeof X>` all see what they saw before. This is the difference from the Effect
  generator, which must export a second `Standard<Name>` form because
  `Schema.standardSchemaV1` returns a different object that has dropped `.fields`.
- **The vendor is `drzl/typebox`, not `typebox`.** DRZL implements this and TypeBox does not, so
  claiming TypeBox's name would mislead anything that special-cases a vendor and would collide
  with a first-party implementation whose issues are not shaped like these.
- **The implementation is emitted, not imported.** One `standard-schema.ts` per output directory,
  exported from the barrel and imported by each table module. Generated code in DRZL has never
  depended on a `@drzl/*` package at runtime and this does not start; a new package could not
  publish by npm OIDC on its first version anyway, and a generated tree that cannot resolve an
  import is the worst place to find that out.
- **Off by default**, like `duplicateFinder`, because generated code ships in your bundle.

Also fixes a latent defect the option surfaced. The character and byte cap predicates guarded only
against `null`, on the assumption that the `Type.String()` beside them in the intersection had
already passed. `Value.Check` does stop an intersection at its first failing branch, so that held;
`Value.Errors` does not, so building an issue list for `{ email: 123 }` reached `[...123]` and
threw. A real tRPC route answered `v is not iterable` with a 400 instead of naming the type it
wanted. The predicates now guard on `typeof`, as the three other predicates this generator emits
already did, and the wrapper keeps whatever it collected if a predicate throws anyway. Null and
undefined still pass the branch exactly as before. Costs 12 bytes per cap branch.

A union reports one summary error in TypeBox and hangs the branch failures off it, so a nullable
capped column produced `Expected union value` where the useful message was one level down. The
wrapper reports the branch failures in place of the summary, and a constraint TypeBox can only
state as a registered kind reports what the constraint says rather than `Expected kind
'DrzlRowCheck'`. Array indices in `path` are reported as numbers, matching zod, valibot and
arktype, so code that switches on `typeof segment` behaves the same whichever generator wrote the
schema.

`validation.library` on the `orpc` and `trpc` generators still takes `zod`, `valibot` or
`arktype`. Those generators invent arguments, such as a lookup by primary key, and have no TypeBox
spelling for them; that is separate work from the Standard Schema gap this closes.
