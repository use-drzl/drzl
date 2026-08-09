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
    fi
  done
done
[ "$missing" = 0 ] || exit 1
echo "    every @drzl dependency resolves on npm"
