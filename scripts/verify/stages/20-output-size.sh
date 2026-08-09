# ---------------------------------------------------------------------------------------------
# What the output costs.
#
# Generated code lands in the consumer's bundle, and every constraint added this cycle made it
# bigger. Nothing measured that, so a change that doubled the output would have shipped as
# silently as one that halved it.
#
# The budget is per column, not per file, so adding a table to the fixture does not blow it. The
# numbers are ceilings with room above today's figure, chosen to catch a step change rather than
# to police a byte.
# ---------------------------------------------------------------------------------------------
report_size() {
  local dir="$1" lib="$2" budget="$3"
  local bytes cols per
  bytes=$(cat "$dir"/*.ts | wc -c)
  # Every column declaration in the fixture, not just one table's. Counting only the `c_` prefix
  # meant adding a second table grew the numerator and left the denominator alone, so the budget
  # fired on a change that made the output smaller per column, not bigger.
  cols=$(grep -cE '^\s+[a-z][a-z0-9_]*: ' src/schema.ts)
  per=$(( bytes / cols ))
  printf '    %-8s %6d bytes over %2d columns = %4d/column (budget %d)\n' "$lib" "$bytes" "$cols" "$per" "$budget"
  if [ "$per" -gt "$budget" ]; then
    echo "FAIL: the $lib generator emits $per bytes per column, over its $budget budget." >&2
    echo "      Generated code ships in the consumer's bundle. Raise the budget deliberately," >&2
    echo "      in a commit that says what the extra bytes buy." >&2
    return 1
  fi
}

echo "==> generated output size"
size_fail=0
# Roughly 1.35x today's figure: loose enough that adding a constraint to one column type does not
# trip it, tight enough that doubling the output does. A budget with 4x headroom catches nothing,
# which was the first draft of this.
#
# Raised once, when the fixture gained thirteen columns that each carry a CHECK. That is the
# densest output the generators produce, so the per-column average rose without any generator
# emitting more for the same input.
#
# Raised again for arktype only, 240 to 280, when the fixture gained the two-column `arrays`
# table. That raise was measured rather than guessed, because a budget raised to make a number fit
# is worth nothing, and the working is kept below.
#
# The working is arithmetic about one past edit and describes no run since. It was taken at
# `9e75c84`, against the fixture as it stood there, before the `nullable` table this branch added
# widened it, and every figure in it went stale in that one edit. What this run measures is
# printed by the lines below rather than restated here, and if the two disagree the printed ones
# are the live ones.
#
#   as measured at 9e75c84   arktype emitted 223 bytes per column over the 62 columns the fixture
#                            had then, up from 213, and those ten bytes are the bigint bound and
#                            the array element walk, both of them constraints that were missing.
#                            The two new columns cost 1803 bytes of module, about 900 each, four
#                            times the average, because a nullable capped array is the longest
#                            thing this generator emits and it is emitted once per mode. So the
#                            mixed average moved to 244 without any generator emitting more for
#                            the same input, which is the same effect recorded above for the CHECK
#                            columns, and the figures reconciled: 13827 without the table, plus
#                            1803 for the module and the 37-byte barrel line naming it, was the
#                            15667 the script printed at that revision.
report_size src/gen/pg/zod      zod      420  || size_fail=1
report_size src/gen/pg/valibot  valibot  540  || size_fail=1
# Raised 280 to 310 when the fixture gained the two mode-string bigint columns (matrix and
# checked). Measured, not nudged: 22572/82 = 275 became 24486/84 = 291, so the pair costs 1914
# bytes, about 957 each, which is the same "longest thing this generator emits, once per mode"
# effect recorded above rather than drift. 310 keeps the headroom the note below argues for.
report_size src/gen/pg/arktype  arktype  310  || size_fail=1
# Raised from 430 to 460, deliberately and with the measurement written down rather than nudged up
# until the run went quiet. Giving the other three generators an epoch-number branch (BC) costs
# TypeBox 17 bytes per column, 427 to 444, because it cannot state a predicate declaratively and
# pays for a registered kind per date column where valibot and arktype pay for a pipe step or a
# widened narrow. That is the cost of the feature in this generator, not drift.
#
# 460 and not 444. An alternative was measured, folding both coerced branches under one outer
# intersect carrying a single predicate, and it lands at exactly 430: it would pass with zero
# margin, which makes the next change to any date column fail for no reason of its own. A budget
# with no headroom stops being a tripwire and becomes a tax on the next edit. Note arktype sits at
# 275 against 280 for the same reason, and is the one to watch next.
# Raised 460 to 490 for the same two columns: 36584/82 = 446 became 38945/84 = 463, the pair
# costing 2361 bytes, about 1180 each. zod (294 against 420) and valibot (368 against 540) absorb
# the pair without a raise.
report_size src/gen/pg/typebox  typebox  490  || size_fail=1
# No effect budget here. These paths are the parity tree, which cannot hold effect at all: see the
# note on its npm install above. Measured at 438 bytes per column on this fixture, within five
# bytes of TypeBox and for the same reason, so a budget of 460 is the right number the day that
# tree can carry it.
[ "$size_fail" = 0 ] || exit 1
