# These run under a heading of their own because a missing emitted file is not a disagreement
# between explain and doctor, which is the stage that would otherwise be named for it.
echo "==> every generator kind emitted a file, with the relation lookups on it"
BARREL="src/generated/zod/index.ts"
[ -f "$BARREL" ] || { echo "FAIL: no barrel emitted at $BARREL" >&2; exit 1; }
for f in src/generated/zod/users.zod.ts src/generated/zod/posts.zod.ts; do
  [ -f "$f" ] || { echo "FAIL: expected emitted file missing: $f" >&2; exit 1; }
done

# One representative file per generator kind, so a kind that silently emitted nothing is caught
# here rather than by the typecheck passing over an empty directory.
for f in src/generated/valibot/index.ts src/generated/arktype/index.ts \
         src/generated/services/postService.ts src/generated/api/posts.ts; do
  [ -f "$f" ] || { echo "FAIL: expected emitted file missing: $f" >&2; exit 1; }
done

# The relation endpoint the foreign key above should have produced.
grep -q 'listByAuthorId' src/generated/api/posts.ts || {
  echo "FAIL: includeRelations did not emit a lookup for the authorId foreign key." >&2
  exit 1
}
grep -q 'listByAuthorId' src/generated/trpc/posts.ts || {
  echo "FAIL: the tRPC router emitted no relation lookup for the authorId foreign key." >&2
  exit 1
}

# The addressing procedures have to take the table's real key. The sibling oRPC generator emits
# `z.object({ id: z.number() })` for every table whatever its key is, which names a column that
# need not exist and types a uuid as a number, and this is the check that stops the tRPC one
# regressing to the same shape. `books` is keyed on a varchar `isbn` in the dialect fixture
# below, so a hardcoded numeric `id` fails there rather than here; here it is enough that the
# key columns reach the router at all.
grep -q 'byId' src/generated/trpc/posts.ts || {
  echo "FAIL: the tRPC router emitted no byId procedure for a table that has a primary key." >&2
  exit 1
}
