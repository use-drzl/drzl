# ---------------------------------------------------------------------------------------------
# What is inside each tarball, against what its own manifest promises is there.
#
# `files` is a list of directories, not of entry points, so the two are only ever connected by
# hand. A `types` field naming a file the build never emitted, or an `exports` subpath pointing
# somewhere outside `dist`, both pack cleanly and fail only later: in a consumer's editor, which
# just goes quiet, or at their first import. Nothing in the workspace can see either, because in a
# working tree every one of those paths has `src` sitting next to `dist` to fall back on.
#
# The manifest is read out of the tarball rather than off disk, because the tarball's copy is the
# one npm serves and it is not the same file: pnpm rewrites `workspace:` ranges into it on the way
# past.
# ---------------------------------------------------------------------------------------------
echo "==> what each tarball contains"
if ! node "$HARNESS/inspect-tarballs.mjs" "$TARS"; then
  exit 1
fi
