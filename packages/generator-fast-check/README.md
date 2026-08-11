# @drzl/generator-fast-check

Generate [fast-check](https://fast-check.dev) arbitraries from a Drizzle schema, one per table,
bounded by every `CHECK` the analyzer parsed.

## The bug a hand-written arbitrary has

Nothing in `fc.integer()` knows the column carries `CHECK (quantity BETWEEN 1 AND 999)`, so a property
test spends most of its runs on rows the database would refuse.

Worse, and this is why the generator is worth having: **explicit bounds do not exclude NaN**. Measured
against `fast-check@4.9.0`, `fc.double({ min: 0, max: 100 })` produced 86 NaN in 30,000 samples, about
one in 350, with nothing outside the range. So a bounded float column gets a NaN every few hundred
runs, the database refuses it, and the failure lands in CI on a case that does not reproduce locally.
Nothing about writing the bounds suggests `noNaN` is also needed.

Always passing `noNaN: true` is the obvious correction and is also wrong, because some columns really
do store NaN. DRZL answers this per column, measured against real servers, and the emitted arbitrary
follows it: a column that cannot hold a NaN never gets one, and a column that can, still does.

## Install

```bash
npm install -D @drzl/generator-fast-check
npm install -D fast-check
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [{ kind: 'fast-check', path: 'src/arbitraries' }],
};
```

```ts
import fc from 'fast-check';
import { productsArbitrary } from './arbitraries';

fc.assert(fc.property(productsArbitrary, (row) => applyDiscount(row).price > row.cost));
```

## Why a map rather than a filter

A row comparison like `price > cost` cannot be a per-column arbitrary. `fc.pre` or `.filter` is the
shorter way to express it and makes shrinking worse: a filter shrinks towards values the constraint
excludes and then discards them, so the counterexample drifts away from anything the database would
accept. The emitted code draws both independently and orders the pair with a `.map`, which is total,
so every shrink step is still a legal row.

## One deliberate difference from the seed generator

An unconstrained column stays unconstrained here. `@drzl/generator-seed` narrows an unbounded numeric
to a readable window because a fixture is there to be looked at; a property test wants the awkward
values, so only what the column genuinely cannot hold is excluded.

Full documentation: https://drzl.dev/generators/fast-check

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
