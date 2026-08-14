---
'@drzl/generator-pothos': patch
---

Correct the nullability note the Pothos generator writes into every emitted `builder.ts`.

The comment said a builder with a v4 generic "already defaults to non-null". It does not. The probe
in `test/schema.spec.ts` builds exactly that shape, exposes a bare field and asserts the printed SDL,
and it prints `bare: String`, nullable, on every run. The comment had been contradicted by a passing
test in the same package for as long as it existed.

This is the second wrong turn on the same question. The first measured the `objectRef` shape, which
this generator does not emit, and was retracted in the changelog at the time. The retraction fixed
the docs page and the README and left this comment saying the opposite, where it was copied into the
generated output of every project using the generator.

Nothing about the emitted schema changes. Every field already states its own `nullable` and still
does, which is the right shape precisely because `defaultFieldNullability: false` types as `never`
on a v4 generic: the central switch is unavailable exactly where it would help. Only the prose in
the emitted file changes, which is why this is a patch.
