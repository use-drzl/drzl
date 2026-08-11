# @drzl/generator-fast-check

## 0.2.0

### Minor Changes

- 617d917: Add `@drzl/generator-fast-check`: fast-check arbitraries generated from a Drizzle schema, one per
  table, bounded by every `CHECK` the analyzer parsed.

  A property test is only as good as the values it draws, and a hand-written arbitrary for a
  constrained column goes wrong twice. The obvious way first: nothing in `fc.integer()` knows the
  column carries `CHECK (quantity BETWEEN 1 AND 999)`, so the test spends most of its runs on rows the
  database would refuse.

  The second is worse, because the code looks right. **Explicit bounds do not exclude NaN.** Measured
  against `fast-check@4.9.0`: `fc.double({ min: 0, max: 100 })` produced 86 NaN in 30,000 samples,
  about one in 350, with nothing outside the range and no infinities. `noNaN: true` removes them. So a
  bounded float column gets a NaN every few hundred runs, the database refuses it, and the failure
  lands in CI on a case that does not reproduce locally.

  Always passing `noNaN: true` would be the obvious correction and is also wrong, because some columns
  really do store NaN. DRZL's analyzer answers this per column, measured against real servers: Postgres
  stores NaN and both infinities in `real` and `double precision`, a `numeric(10,2)` takes NaN and
  refuses either infinity, and `integer`/`bigint` refuse all three. The emitted arbitrary follows the
  column, and both directions are asserted: a column that cannot hold a NaN never gets one, and a
  column that can, still does.

  A row comparison cannot be a per-column arbitrary at all, since neither value alone can be chosen to
  make `price > cost` hold. Both are drawn independently and the pair is ordered by a `.map` over the
  finished record, rather than by `fc.pre` or `.filter`, because a filter shrinks towards values the
  constraint excludes and then discards them: the reported counterexample drifts away from anything the
  database would accept. A `.map` is total, so every shrink step is still a legal row.

  One defect found during the build, and it was flaky rather than reproducible. The first draft
  separated two equal values with `hi + 1`, and `Number.MAX_VALUE + 1 === Number.MAX_VALUE`, so a row
  drawing that value for both sides came out equal and violated the constraint the map exists to keep.
  `fc.double()` reaches that value on an unconstrained column, so it failed on some seeds and not
  others. The emitted helper now scales the step to the magnitude and chooses its direction, because
  lowering overflows at `-Number.MAX_VALUE` and raising overflows at `Number.MAX_VALUE`, both measured.
  It is pinned by tests that drive the emitted helper at both extremes directly, rather than by hoping
  a draw lands there.

  This shares its constraint reading with `@drzl/generator-seed` and deliberately differs in one place:
  an unconstrained column stays unconstrained here. A fixture is there to be looked at, so the seed
  generator narrows an unbounded numeric to a readable window; a property test wants the awkward
  values, so only what the column genuinely cannot hold is excluded.

  `@drzl/cli` gains the `fast-check` kind. Like the `seed` generator it reads nothing from a validation
  generator, so it has no `validation` block and no sibling to derive a path from.
