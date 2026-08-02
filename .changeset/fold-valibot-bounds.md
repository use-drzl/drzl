---
'@drzl/generator-valibot': patch
---

Fold a numeric CHECK into valibot's range instead of adding an action beside it

`CHECK (age >= 18)` on an integer column emitted `v.minValue(-2147483648), v.maxValue(2147483647),
v.check((val) => val >= 18)`: a bound that can never fail, plus a closure saying what the bound
should have said. It is now `v.minValue(18), v.maxValue(2147483647)`, matching the fix already
applied to the zod generator.

valibot has the exclusive forms natively, so `> 0` becomes `v.gtValue(0)` and `< 10` becomes
`v.ltValue(10)` rather than closures. The issue valibot raises then carries `requirement: 0` as
data instead of a sentence this generator wrote, which is what a client needs in order to render
its own message.

The pg fixture's valibot output falls from 397 to 360 bytes per column.
