echo "==> the barrel a consumer with a formatter installed gets"
# Exit code alone is not enough: a generator that writes an empty barrel still exits 0.
#
# Double quotes deliberately, and they are load-bearing twice over. The generator emits single
# quotes; the double ones are prettier's defaults rewriting them, so this line is also the only
# end-to-end proof in the whole run that formatting actually happened through a real install of
# the optional peer. Nothing else here would notice formatting silently stopping, which is not
# hypothetical: the CJS bundle formatted nothing at all for as long as it existed and every gate
# stayed green. The single-quoted form is asserted further down, with prettier hidden.
grep -q 'export \* from "./users.zod.js";' "$BARREL" || {
  echo "FAIL: the barrel is not what a consumer with prettier installed should get. Either the" >&2
  echo "      .js specifier is missing, so the output will not resolve under moduleResolution" >&2
  echo "      node16 or nodenext, or the optional peer stopped being used and nothing was" >&2
  echo "      formatted. Barrel was:" >&2
  cat "$BARREL" >&2
  exit 1
}
