echo "==> building"
# A file in every dist that no build produces, checked for afterwards.
#
# `files: ["dist"]` packs whatever is in the directory, and tsup does not clean it unless told to,
# so anything a previous build left behind is published. That is not theoretical: @drzl/cli's dist
# held 46 files totalling 950 KB where a clean build produces 16 and 417 KB, 30 stale
# content-hashed chunks from three different dates, and validation-core held two full generations
# of prettier's parser chunks. CI checks out fresh and never sees it; a maintainer running
# `pnpm release` locally publishes it. The size ceiling below cannot catch this, because stale
# chunks are small.
#
# A canary rather than a file-list comparison, because it costs one build instead of two and
# fails for exactly one reason: this package's build does not clean its output.
CANARY='stale-canary.js'
for dir in "$ROOT"/packages/*/; do
  mkdir -p "$dir/dist"
  echo '// seeded by verify-packed; a build that cleans its output removes this' > "$dir/dist/$CANARY"
done

# `build:packages`, not `build`: the workspace also contains the docs site, whose vitepress
# build is slow and cannot affect a tarball. This is the same filtered, topologically sorted
# build the release workflow runs, so what gets packed here is what gets packed there.
(cd "$ROOT" && pnpm build:packages >/dev/null)

stale=""
for dir in "$ROOT"/packages/*/; do
  [ -e "$dir/dist/$CANARY" ] && stale="$stale $(basename "$dir")"
  rm -f "$dir/dist/$CANARY"
done
if [ -n "$stale" ]; then
  echo "FAIL: these builds do not clean their output dir, so stale files from a previous" >&2
  echo "      build get published:$stale" >&2
  echo "      Add --clean to the tsup invocation in each package's build script." >&2
  exit 1
fi
echo "    every build cleans its output dir"
