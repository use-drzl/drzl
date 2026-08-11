# fast-check arbitraries

`@drzl/generator-fast-check` emits [fast-check](https://fast-check.dev) arbitraries from your Drizzle
schema, one per table, bounded by every `CHECK` the analyzer parsed.

## The bug a hand-written arbitrary has

A property test is only as good as the values it draws, and writing the arbitrary by hand goes wrong
twice.

The obvious way first: nothing in `fc.integer()` knows the column carries
`CHECK (quantity BETWEEN 1 AND 999)`, so the test spends most of its runs on rows the database would
refuse, and the property under test is barely exercised.

The second is worse, because the code looks right. **Explicit bounds do not exclude NaN.** Measured
against `fast-check@4.9.0` on 2026-08-11:

```
fc.double({ min: 0, max: 100 })                    NaN 86   Inf 0   out-of-bounds 0
fc.double({ min: 0, max: 100, noNaN: true })       NaN  0   Inf 0   out-of-bounds 0
```

86 NaN in 30,000 samples, about one in 350. So a bounded float column gets a NaN every few hundred
runs, the database refuses it, and the failure lands in CI on a case that does not reproduce locally.
Nothing about writing `{ min, max }` suggests `noNaN` is also needed.

## And the half a blanket fix gets wrong

Always passing `noNaN: true` would be the obvious correction and it is also wrong, because some
columns really do store NaN. DRZL's analyzer answers this per column, measured against real servers:
Postgres stores NaN and both infinities in `real` and `double precision`, a `numeric(10,2)` takes NaN
and refuses either infinity, and `integer`/`bigint` refuse all three.

So the emitted arbitrary sets `noNaN` and `noDefaultInfinity` from what the column actually accepts.
A column that cannot hold a NaN never gets one; a column that can, still does.

## Setup

```ts
// drzl.config.ts
export default {
  schema: './src/db/schema.ts',
  generators: [{ kind: 'fast-check', path: 'src/arbitraries' }],
};
```

Like the [seed generator](/generators/seed), this reads nothing from a validation generator. Its
constraints come from the analysis directly.

## What is emitted

One module per table, plus a barrel keying them by table:

```ts
import fc from 'fast-check';
import { productsArbitrary } from './arbitraries';

test('a discount never inverts the margin', () => {
  fc.assert(
    fc.property(productsArbitrary, (row) => {
      const discounted = applyDiscount(row);
      return discounted.price > discounted.cost;
    })
  );
});
```

Every row drawn is one the database would accept, so a failure is a failure of your code rather than
of the fixture.

## How each constraint is expressed

| Constraint       | Example                             | Emitted as                              |
| ---------------- | ----------------------------------- | --------------------------------------- |
| A bound          | `quantity >= 1 AND quantity <= 999` | `fc.integer({ min: 1, max: 999 })`      |
| A set            | `status IN ('draft', 'live')`        | `fc.constantFrom('draft', 'live')`      |
| A length         | `length(name) > 3`                  | `fc.string({ minLength: 4 })`           |
| A row comparison | `price > cost`                      | A `.map` over the record, ordering the pair |

The row comparison cannot be a per-column arbitrary at all: neither value alone can be chosen to make
it hold. Both are drawn independently and the pair is ordered afterwards.

## Why a map rather than a filter

`fc.pre` or `.filter` is the shorter way to express a row comparison, and it makes shrinking worse.
A filter shrinks towards values the constraint excludes and then discards them, so the reported
counterexample drifts away from anything the database would accept, and a narrow constraint can
exhaust the run before finding anything at all. A `.map` is total: every shrink step is still a legal
row.

## Two details worth knowing

**An unconstrained column stays unconstrained.** This is the one place this generator deliberately
differs from the seed generator, which narrows an unbounded numeric to a readable window. A fixture
is there to be looked at; a property test wants the awkward values, so only what the column genuinely
cannot hold is excluded.

**A generated column is left out.** The database computes it, so no drawn row carries one.

An expression the parser cannot read is named in the emitted module rather than silently dropped, so
an arbitrary never looks more constrained than it is.

## Options

| Option                 | Default  | What it does                                  |
| ---------------------- | -------- | ----------------------------------------------- |
| `path`                 | `outDir` | Where the modules are written                  |
| `naming.routerSuffix`  | none     | Appended to each module name and identifier    |
| `naming.procedureCase` | none     | Casing for file names and identifiers          |
