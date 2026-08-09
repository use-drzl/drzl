echo "==> packing publishable packages"
count=0
for dir in "$ROOT"/packages/*/; do
  name="$(node -e "
    const p = require('$dir/package.json');
    process.stdout.write(p.private ? '' : p.name);
  " 2>/dev/null || true)"
  [ -z "$name" ] && continue
  (cd "$dir" && pnpm pack --pack-destination "$TARS" >/dev/null)
  count=$((count + 1))
done
quoted "    packed $count package(s)"
if [ "$count" -eq 0 ]; then
  echo "FAIL: nothing was packed. A build that emits nothing must not pass silently." >&2
  exit 1
fi

# What each package weighs on the wire, which is the only number a user pays.
#
# Three of these shipped at 2.8 MB packed and 11 MB unpacked, because `await import('prettier')`
# is a specifier tsup can resolve and esbuild inlined the whole formatter behind it. Installing
# @drzl/cli pulled in roughly 32 MB of duplicated prettier parsers. Nothing in the workspace could
# see it: the source was right, the tests passed, and only the artefact was wrong.
#
# The ceiling is per tarball and deliberately far above the real figures, which are tens of
# kilobytes. It is a tripwire for a dependency that got bundled, not a byte budget. Raising it is
# not how you fix a build that started inlining one.
TARBALL_CEILING=1000000
size_over=0
for tgz in "$TARS"/*.tgz; do
  bytes=$(wc -c < "$tgz")
  if [ "$bytes" -gt "$TARBALL_CEILING" ]; then
    echo "FAIL: $(basename "$tgz") is $bytes bytes packed, over the ${TARBALL_CEILING} ceiling." >&2
    echo "      Something is being bundled that should be external." >&2
    size_over=1
  fi
done
[ "$size_over" = 0 ] || exit 1
