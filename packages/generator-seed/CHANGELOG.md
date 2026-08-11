# @drzl/generator-seed

## 0.2.0

### Minor Changes

- a451292: Add `@drzl/generator-seed`: seed rows generated from a Drizzle schema, built to satisfy every `CHECK`
  the analyzer parsed rather than found by retrying.

  The incumbent is `drizzle-seed`, and the gap is not a matter of degree. It reads a Drizzle schema for
  column types and generates plausible values for them; it does not read `CHECK` constraints at all.
  Measured against `drizzle-seed@0.3.1` on 2026-08-11: nothing in the package looks at a table's
  checks, and its only `checks` member is an internal count of how many distinct values a generator can
  still produce. So a table declaring `CHECK (quantity BETWEEN 1 AND 999)` gets seeded with whatever an
  unbounded integer generator returns, and the insert fails against the database that declared the
  rule.

  DRZL already parses those expressions, for the schemas it emits. This generator reads the same parse
  and constructs values inside the permitted region: a bound picks within the intersected range, a set
  picks a member, a length builds a string of a permitted length, and a row comparison orders the pair
  after generating both. Every one is satisfied by construction, so there is no retry loop and no
  failure mode where a narrow constraint spins. A row comparison is the one no per-column generator can
  satisfy at all, because neither value alone can be chosen to make `price > cost` hold.

  The tests are runtime rather than compile, because the claims are about values: 300 rows are
  generated and every constraint is checked against them by assertions written independently of the
  generator, so a bug in the window arithmetic cannot make both sides agree.

  Three things the emitted modules get right that are easy to miss. A generated column is left out
  entirely, since the database computes it and refuses a value. A column a row comparison names is
  never null, because the comparison cannot hold if either side is missing, which is an interaction
  between two independent rules that neither one's own test would catch. And a column nothing
  constrains is drawn from a readable window rather than its full numeric range: an `integer` with no
  `CHECK` is bounded only by its SQL type, and drawing from that gave a price of `4283991245827361`,
  satisfying every stated constraint and useless to look at.

  A column constrained by an `IN` set is typed as that union rather than as `string`, since the value
  really is one of them. The barrel adds `insertOrder`, a topological sort of the foreign keys, and a
  cycle keeps declaration order and says so rather than quietly picking an order that cannot work. An
  expression the parser cannot read is named in the emitted module rather than silently dropped, so a
  seed module never looks more complete than it is.

  Deterministic: the same seed gives the same rows, because a fixture that changes between runs turns
  a failing test into a coin toss.

  `@drzl/cli` gains the `seed` kind and a `count` option. This is the one generator that reads nothing
  from a validation generator, so it has no `validation` block and no sibling to derive a path from.
