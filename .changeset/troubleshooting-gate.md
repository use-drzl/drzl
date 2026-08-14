---
---

Check the troubleshooting page against the errors DRZL actually produces, on every gate run.

The page names error codes and quotes the text beside each. Nothing produced any of them on any gate
run, so it was free to rot the way the benchmark numbers did before they were gated: a renamed code,
a reworded message or a deleted branch would each leave the page confidently describing something
that no longer happens.

It had already rotted. Two codes were emitted and documented nowhere, and both are now written up:

- `DRZL_ANL_NOFILE`, error level, "Schema file not found". A user who mistyped a path got a code with
  nothing to look up. Its entry also records something worth knowing: `generate` refuses and exits
  non-zero, while `analyze` prints a complete document with empty `tables`, the error in `issues`,
  and exit 1. A script reading `tables` and ignoring the status cannot tell a missing file from an
  empty one.
- `DRZL_ANL_POLICY_UNLINKED`, a `pgPolicy` linked to a table the schema does not export. Added three
  days ago with the row-level policy work and never documented.

The stage checks three things. Every code the page names exists in a shipped package, and every code
a shipped package can emit is on the page, which catches a rename or an undocumented addition in
either direction. Then it produces three real errors and reads what comes out, which is the only one
of the three that catches a rewording.

The quoted generator-kind list is checked against what the CLI actually offers, because that is the
text most likely to drift: every generator added changes it, the page is a separate file nobody has
to touch, and it went stale twice during the run that added these generators.

Gate and docs only. No package is bumped.
