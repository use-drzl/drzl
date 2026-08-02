---
'@drzl/generator-zod': patch
---

Fold a numeric CHECK into zod's range instead of adding a predicate beside it

`CHECK (age >= 18)` on an integer column emitted
`.gte(-2147483648).lte(2147483647).refine((v) => v >= 18)`: a bound that can never fail, plus a
closure saying what the bound should have said. It is now `.gte(18).lte(2147483647)`, which is
what the arktype and typebox generators already did.

Three things improve, and only one of them is speed. The error becomes zod's own, `Too small,
expected number to be >=18`, with the bound machine-readable on the issue rather than inside a
string this generator wrote. The output shrinks, and generated code ships in the consumer's
bundle. On the benchmark table that is 28% fewer bytes and 20% more parses per second, closing
most of the gap to a validator that enforces none of these constraints.

`length()` still uses a predicate, deliberately: `.min(n)` counts UTF-16 units and SQL counts
characters, so `length(name) >= 2` is not `.min(2)`.
