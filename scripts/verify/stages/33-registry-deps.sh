# ---------------------------------------------------------------------------------------------
# Can the published packages actually be installed?
#
# `@drzl/cli@4.13.0` shipped with a hard dependency on a package added in the same release, whose
# first publish failed because npm trusted publishing has nothing to authenticate against for a
# name that has never existed. Every gate here was green: the tarballs were correct, the
# workspace resolved, and `npm install @drzl/cli` failed with a 404 for everyone.
#
# The rule that would have caught it: a workspace dependency that is not yet on the registry has
# to be optional, because an unresolvable optional dependency is skipped rather than failing the
# install. Once it is published it can become a hard dependency like the rest.
# ---------------------------------------------------------------------------------------------
echo "==> workspace dependencies exist on the registry"
cd "$ROOT"
missing=0
for pkg in packages/*/package.json; do
  owner=$(node -p "require('./$pkg').name")
  deps=$(node -p "Object.keys(require('./$pkg').dependencies||{}).filter(d=>d.startsWith('@drzl/')).join(' ')")
  for dep in $deps; do
    if ! npm view "$dep" version >/dev/null 2>&1; then
      echo "    FAIL: $owner depends on $dep, which is not on the registry." >&2
      echo "          A package awaiting its first publish must be an optionalDependency, or" >&2
      echo "          installing $owner fails outright for everyone." >&2
      missing=1
      continue
    fi
    # Existing on the registry is not the same as being installable from it. A package published
    # by hand rather than through `changeset publish` keeps `workspace:^` in its own manifest,
    # because npm publish does not rewrite that protocol and pnpm publish does. npm then refuses
    # it with EUNSUPPORTEDPROTOCOL, so a dependency on one breaks `npm i` for everyone while
    # `npm view` above answers perfectly happily.
    #
    # Measured 2026-08-10: seven generators were hand-published to clear the first-publish
    # deadlock, all seven kept `workspace:^`, and `npm install @drzl/cli` exited 1 from that
    # moment until the next pipeline release replaced them. The check above could not see it.
    #
    # awk rather than grep, because grep here is a shell function wrapping ugrep.
    if npm view "$dep" dependencies --json 2>/dev/null \
      | awk 'index($0, "workspace:") { found = 1 } END { exit !found }'; then
      echo "    FAIL: $dep is on the registry carrying a workspace: range in its own manifest," >&2
      echo "          so npm cannot install it and anything depending on it fails to install." >&2
      echo "          It was published outside changeset publish. Republish it through the" >&2
      echo "          pipeline, or by hand with pnpm publish, which rewrites the protocol." >&2
      missing=1
    fi
  done
done
[ "$missing" = 0 ] || exit 1
echo "    every @drzl dependency resolves on npm and installs from it"
