# ---------------------------------------------------------------------------------------------
# The consumer who has no formatter at all.
#
# prettier used to be bundled into three packages, 11 MB each, so formatting could not fail to be
# available. It is an optional peer now, which makes "no formatter installed" an ordinary and
# supported state rather than a broken install. The whole run happens after every file has been
# rendered, so an unhandled rejection there would lose a completed generation at the last step.
#
# Hidden rather than uninstalled, because npm would take the tarballs with it.
# ---------------------------------------------------------------------------------------------
echo "==> generating with no formatter installed"
mv node_modules/prettier node_modules/.prettier-hidden
cp "$FIXTURES/unformatted.drzl.config.ts" drzl.config.ts
if ! npx drzl generate >/dev/null; then
  mv node_modules/.prettier-hidden node_modules/prettier
  echo "FAIL: drzl generate does not survive prettier being absent. It is an optional peer," >&2
  echo "      so this is a normal install, and the failure would come after every file was" >&2
  echo "      already rendered." >&2
  exit 1
fi
mv node_modules/.prettier-hidden node_modules/prettier

# Unformatted has to still mean complete and valid. Single quotes are what the generator emits
# before a formatter sees it, so this also confirms nothing formatted the file behind our backs
# and made the check vacuous.
grep -q "export \* from './users.zod.js';" src/unformatted/zod/index.ts || {
  echo "FAIL: the unformatted barrel is not what the generator emits. Was:" >&2
  cat src/unformatted/zod/index.ts >&2
  exit 1
}
# The tRPC entry point is not a barrel: it calls `router()` and exports `type AppRouter`, which
# is the entire contract a typed client infers its API from. So the check is on that, not on a
# re-export line, and it is the exact unformatted bytes for the same reason as above.
grep -q "export type AppRouter = typeof appRouter;" src/unformatted/trpc/index.ts || {
  echo "FAIL: the unformatted tRPC entry point does not export the router type. Was:" >&2
  cat src/unformatted/trpc/index.ts >&2
  exit 1
}
cat > tsconfig.unformatted.json <<'EOF'
{
  "compilerOptions": {
    "strict": true, "noEmit": true, "target": "es2022",
    "module": "nodenext", "moduleResolution": "nodenext", "skipLibCheck": true
  },
  "include": ["src/unformatted/**/*.ts", "src/db/**/*.ts"]
}
EOF
if ! npx tsc -p tsconfig.unformatted.json; then
  echo "FAIL: output emitted without a formatter does not typecheck. Formatting is cosmetic," >&2
  echo "      so anything broken here was broken before prettier tidied it." >&2
  exit 1
fi
echo "    unformatted output is complete and typechecks"
