---
'@drzl/generator-typebox': patch
'@drzl/cli': minor
---

One options builder for every validation generator, and a default that was being dropped.

Each of the four generator branches in the CLI hand-built its own options object. Three documented
options had already been found silently dead that way: `typedJson` never reached typebox, and
`coerceDates` and `applyDefaults` never reached anything but zod. Fixing each instance did not
address the shape of the problem, so the four now share one builder and an option added once
reaches everything that can act on it.

What stays per-generator is a real capability rather than an oversight, and it is named as one:
ArkType does not receive the schema-import options, because it emits one string per field and a
TypeScript type reference has nowhere to live inside a string DSL.

### The default that was being dropped

Auditing the result immediately turned up another: with `typedColumns` **and** `applyDefaults`
both on, the typebox generator emitted no default at all.

```ts
// before
country: Type.Optional(Type.Unsafe<(typeof users.$inferInsert)['country']>(Type.String())),
// after
country: Type.Optional(Type.Unsafe<(typeof users.$inferInsert)['country']>(Type.String({ default: 'GB' }))),
```

The default was being applied after the `Type.Unsafe` wrapper, where it lands on the wrapper
rather than the schema, and the helper that attaches it declines anything that is not a bare
`Type.X(...)`. So it returned the expression untouched and the default vanished without a word.
It now goes on the schema before anything wraps it.

Neither option is on by default, so this only affects a project that had turned both on.
