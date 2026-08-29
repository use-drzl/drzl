---
---

Read the nightly's parity failure for what it was: zod 4.5 started counting code points.

zod 4.5.0 (2026-08-28, colinhacks/zod#6441) changed `.min()`, `.max()` and `.length()` to count
Unicode code points rather than UTF-16 units. The parity gate had waived, for all four libraries,
that the official `char(n)` cap refuses three emoji DRZL and the database accept. The official zod
module's `.max(4)` now takes them, so zod fell out of the divergence, the waiver's signature stopped
matching, and the 08-29 nightly failed on the same commit the 08-28 nightly had passed. The parity
tree installs the validator libraries at `latest`, so every pull request would have failed the same
way from then on.

The waiver now names the three libraries whose official modules still count UTF-16 units, and says
why zod is not among them. Narrowed rather than deleted, because valibot, arktype and typebox still
need it. The banner the gate prints now carries the installed version of all four libraries beside
drizzle-orm's, so the next run of this shape can be attributed from the log rather than from a day of
side-by-side installs.

DRZL's emitted code is unchanged. Every generator already counts code points with an explicit
`[...v].length` predicate, and that predicate reads the same on every zod the package supports, so
it stays. What changes is prose: a source comment in the zod generator, the `CODEPOINT_LENGTH`
rationale in validation-core, a test docstring and the zod docs page all stated "`.max` counts
UTF-16 units" as a present-tense fact. Each now says which zod that was true of.

The lockfile moves zod from 4.4.3 to 4.5.2, so the repository's own tests run on the zod a user
installs. That is what surfaced the three test failures fixed alongside, none of which the nightly
could reach because it fails earlier.

Two published numbers move with it, for one reason. The ground-truth stage's `agree with the
database` line goes from `drizzle-orm 1041` to `1042`, because the official zod module's `.max(4)`
now accepts the three-emoji probe a real Postgres accepts, and the tally beneath it goes from `DRZL
closer than drizzle-orm on 62` to `61`, because that is the probe official caught up on. The
per-column divergence counts, 60 with 30 accepting on the v1 line and 54 with 27 on 0.4x, do not
move, since narrowing which libraries a waiver names does not change how many columns it covers.
