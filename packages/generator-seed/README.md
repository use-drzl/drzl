# @drzl/generator-seed

Generate seed rows from a Drizzle schema, built to satisfy every `CHECK` the analyzer parsed rather
than found by retrying.

## The gap this fills

`drizzle-seed` reads a Drizzle schema for column types and generates plausible values for them; it
does not read `CHECK` constraints at all. Measured against `drizzle-seed@0.3.1` on 2026-08-11:
nothing in the package looks at a table's checks, and its only `checks` member is an internal count
of how many distinct values a generator can still produce.

So a table declaring `CHECK (quantity BETWEEN 1 AND 999)` gets seeded with whatever an unbounded
integer generator returns, and the insert fails. The usual answer is to retry until a row passes,
which does not terminate for a narrow constraint and never satisfies a comparison between two
columns.

DRZL already parses those expressions. This generator reads the same parse and constructs values
inside the permitted region: a bound picks within the intersected range, a set picks a member, a
length builds a string of a permitted length, and a row comparison orders the pair after generating
both.

## Install

```bash
npm install -D @drzl/generator-seed
```

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [{ kind: 'seed', path: 'src/seed' }],
};
```

```ts
import { seedProducts } from './seed';

await db.insert(products).values(seedProducts(50));
```

## Three details worth knowing

It is deterministic: the same `seed` gives the same rows, because a fixture that changes between runs
turns a failing test into a coin toss.

A generated column is left out entirely, since the database computes it and refuses a value.

A column nothing constrains is drawn from a readable window rather than its full numeric range.
Nothing declares a bound there, so nothing is violated by choosing one a human can read, and every
declared bound still wins.

An expression the parser cannot read is named in the emitted module rather than silently dropped.

Full documentation: https://drzl.dev/generators/seed

## Licence

Apache-2.0. Generated output is yours under your own project's licence.
