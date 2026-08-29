---
'@drzl/cli': patch
---

Name the lowercase mode keys again when an affix block capitalises them, on zod 4.5.

A config carrying `affix: { type: { prefix: { Insert: 'Create' } } }` is meant to be refused with a
message naming `"insert"`, `"update"` and `"select"`, the mode names drzl uses everywhere else. That
message was attached to the `z.union` that accepts either a string or that object. zod 4.4 reported
every failure of the union with the union's own message; zod 4.5.0 surfaces a strict object's
`unrecognized_keys` issue through the union instead, so anyone on a current zod got zod's bare
`Unrecognized key: "Insert"` and no hint about the case. `@drzl/cli` depends on `zod: ^4.4.3`, which
resolves to 4.5.2 today, so that is what every fresh install printed.

The same message now sits on the strict object as well. Measured on 4.4.3 and 4.5.2: the unknown-key
case names the keys on both, a value that is neither string nor object still gets the union's
message, and a bad child field still gets its own. The test that pins the message runs on 4.5.2 now.

`drzl.config.schema.json`, generated from the config's zod schema at build time, is regenerated on
zod 4.5.2. Where 4.4 spelled a union of primitives as `anyOf: [{ type: 'boolean' }, { type:
'string' }]`, 4.5 spells it `type: ['boolean', 'string']`. Same schema, and editors read both; the
committed copy under `docs/public` moves so that its drift test against a fresh generation passes.
