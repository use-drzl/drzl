# ---------------------------------------------------------------------------------------------
# duplicateFinder must cover the primary key.
#
# Found by item 58: explicit primary keys are the norm in seed fixtures (so foreign keys can
# reference known rows), and the finder consulted only Table.unique, so a natural-PK table
# emitted no finder at all and an explicit-key collision passed silently while the database
# refused the batch with 23505. This file had zero duplicateFinder coverage; this stage is the
# must-fire control from that fix made permanent. Runs in the same install tree, executing the
# emitted finder through jiti (a dependency of the installed analyzer), in a child process so
# its chdir cannot leak into this shell.
echo "==> duplicateFinder covers the primary key"
cp "$HARNESS/dupfinder-probe.mjs" dupfinder-probe.mjs
node dupfinder-probe.mjs || { echo "FAIL: duplicateFinder primary-key stage" >&2; exit 1; }
rm -f dupfinder-probe.mjs
