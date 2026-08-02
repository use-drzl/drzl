---
'@drzl/generator-valibot': minor
'@drzl/generator-arktype': minor
---

CHECK constraints are now enforced by the Valibot and ArkType generators too, matching what the
Zod generator gained in the previous release. No official Drizzle validator module enforces them
in any library.

**Valibot** adds them as pipeline actions:

```ts
age: v.pipe(v.number(), v.integer(), v.minValue(-2147483648), v.maxValue(2147483647),
            v.check((val) => val >= 18, "age_adult: age >= 18")),
```

**ArkType** folds them into the type expression instead, which is the better result rather than a
workaround: one statement about the type, not a bound plus an opaque predicate.

```ts
age:   "18 <= number <= 2147483647",   // CHECK (age >= 18) narrowing a smallint
score: "(0 <= number <= 100 | null)",  // CHECK (score BETWEEN 0 AND 100)
tier:  "'gold'",                       // CHECK (tier = 'gold')
```

An exclusive comparison stays exclusive, so `CHECK (n > 0)` yields `0 < number`. An equality on a
string becomes a literal type.

Both use the same `parseCheck` from `@drzl/validation-core`, so all three generators refuse
exactly the same things: cross-column comparisons, compound predicates, function calls and regex
matches are skipped rather than guessed at. And both place the constraint on the inner schema so
nullability wraps it, reproducing SQL's rule that a CHECK passes on TRUE or NULL.

Every ArkType form emitted here is executed against arktype itself in the test suite, parsing a
valid value and rejecting an invalid one. An expression ArkType cannot parse throws on import and
takes the importing module with it, so "it looks right" is not a sufficient check.
