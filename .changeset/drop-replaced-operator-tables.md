---
'@drzl/generator-zod': patch
'@drzl/generator-valibot': patch
'@drzl/generator-arktype': patch
'@drzl/generator-typebox': patch
'@drzl/generator-effect': patch
---

Delete the operator tables the shared length comparison replaced

`measureCompare` took over the SQL-to-JavaScript operator mapping for length checks, because that
mapping and the question of which short-circuits are sound for which operator belong together. Four
generators kept their now-unused copy of the six-entry table it replaced, and the Effect generator
kept an import of `CODEPOINT_LENGTH`, the fixed-variable spelling it no longer uses.

No emitted output changes: every one of these was already unreachable. `pnpm lint` goes from five
warnings back to zero.
