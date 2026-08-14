# Seed data

`@drzl/generator-seed` emits seed rows from your Drizzle schema, built to satisfy every `CHECK` the
analyzer parsed rather than found by retrying.

## The gap this fills

The incumbent is [`drizzle-seed`](https://orm.drizzle.team/docs/seed-overview), and the gap is not a
matter of degree. It reads a Drizzle schema for column types and generates plausible values for
them; it does not read `CHECK` constraints at all. Measured against `drizzle-seed@0.3.1` on
2026-08-11: nothing in the package looks at a table's checks, and its only `checks` member is an
internal count of how many distinct values a generator can still produce.

So a table declaring `CHECK (quantity BETWEEN 1 AND 999)` gets seeded with whatever an unbounded
integer generator returns, and the insert fails against the database that declared the rule. The
usual answer is to retry until a row happens to pass, which does not terminate for a narrow
constraint and never satisfies a comparison between two columns.

DRZL already parses those expressions, for the schemas it emits. This generator reads the same parse
and *constructs* values inside the permitted region:

| Constraint      | Example                            | What happens                          |
| --------------- | ---------------------------------- | ------------------------------------- |
| A bound         | `quantity >= 1 AND quantity <= 999` | Picks within the intersected range     |
| A set           | `status IN ('draft', 'live')`       | Picks a member, and types the field as the union |
| A length        | `length(name) > 3`                  | Builds a string of a permitted length  |
| A row comparison | `price > cost`                     | Orders the pair after generating both  |

Every one is satisfied by construction, so there is no retry loop.

## Setup

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

This is the one generator that reads nothing from a validation generator. Its constraints come from
the analysis directly, so there is no `validation` block and no sibling to point it at.

## What is emitted

One module per table, plus `rng.ts` and a barrel:

```ts
import { seedProducts } from './seed';

await db.insert(products).values(seedProducts(50));
```

Each row type is precise. A column constrained by an `IN` set is typed as that union rather than as
`string`, because the value really is one of them:

```ts
export interface ProductsSeedRow {
  name: string;
  status: 'draft' | 'live' | 'archived';
  quantity: number;
  price: number;
}
```

The barrel adds `seedAll(count, seed)` and an `insertOrder`, which is a topological sort of the
foreign keys, so a table never appears before one it references. A cycle keeps declaration order and
says so, because no ordering satisfies a cycle and quietly picking one would look correct.

## Three details worth knowing

**It is deterministic.** The same `seed` gives the same rows. A fixture that changes between runs
turns a failing test into a coin toss, so the default is reproducible and the randomness is opt-in
by passing a different seed.

**A generated column is left out entirely.** The database computes it and refuses a value, so a row
carrying one cannot be inserted.

**A column nothing constrains is drawn from a readable window, not its full range.** An `integer`
with no `CHECK` is bounded only by its SQL type, and drawing from that gave a price of
`4283991245827361`: satisfying every stated constraint and useless to look at. Nothing declares a
bound there, so nothing is violated by choosing one a human can read. Every declared bound still
wins.

## What it does not claim

An expression the parser cannot read is named in the emitted module rather than silently dropped:

```
 * Not satisfied by construction, because the parser could not read them. A row from here
 * may violate these, and the database will say so:
 *   weird: lower(a::text) SIMILAR TO %handwave%
```

The alternative is a seed module that looks complete and produces rows the database rejects, with
nothing anywhere saying which rule was not considered.

## Options

| Option                 | Default  | What it does                                       |
| ---------------------- | -------- | ---------------------------------------------------- |
| `path`                 | `outDir` | Where the modules are written                       |
| `count`                | `10`     | How many rows each function returns by default      |
| `naming.routerSuffix`  | none     | Appended to each module name and function name      |
| `naming.procedureCase` | none     | Casing for file names and identifiers               |
