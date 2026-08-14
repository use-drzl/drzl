# ---------------------------------------------------------------------------------------------
# Does the troubleshooting page still describe errors DRZL actually produces?
#
# The page names error codes and quotes text beside each. Nothing produced any of them on any gate
# run, so it was free to rot exactly the way the benchmark numbers did before they were gated: a
# renamed code, a reworded message or a deleted branch would each leave the page confidently
# describing something that no longer happens.
#
# Writing this found one straight away. `DRZL_ANL_NOFILE`, an error-level issue reading
# "Schema file not found", was emitted by the analyzer and mentioned nowhere on the page: a user who
# mistyped a path got a code with nothing to look up.
#
# Three checks. The first two are greps and catch a rename or an undocumented addition. The third
# actually produces errors and reads what comes out, which is the only one that catches a rewording.
# ---------------------------------------------------------------------------------------------
echo "==> the troubleshooting page describes errors that still happen"
DOC="$ROOT/docs/guide/troubleshooting.md"
[ -f "$DOC" ] || { echo "FAIL: no troubleshooting page at $DOC" >&2; exit 1; }

# Every @drzl dist, not just the CLI's. Four of the documented codes are the analyzer's, and a check
# that looked only at the CLI reported all four as undocumented, which is the wrong direction of
# wrong: it would have had someone delete a correct doc entry.
DISTS=$(find "$APP/node_modules/@drzl" -maxdepth 2 -name dist -type d 2>/dev/null)
[ -n "$DISTS" ] || { echo "FAIL: found no packed @drzl dists under $APP." >&2; exit 1; }

# Every grep here tolerates no matches. The gate runs under `set -euo pipefail`, where a grep that
# matches nothing returns 1 and kills the whole run inside a command substitution, with no message
# at all. That is exactly how the first version of this stage failed: the heading printed and the
# gate stopped, silently, because one packed dist happened to contain no error codes.
raw_doc=$(grep -ohE 'DRZL_[A-Z0-9_]+' "$DOC" | sort -u || true)
src_codes=$(for d in $DISTS; do grep -ohE 'DRZL_[A-Z0-9_]+' "$d"/*.js 2>/dev/null || true; done | sort -u || true)

# `DRZL_SCHEMA_` appears in prose as a family prefix rather than as a code. Any token that is a
# strict prefix of another documented token is prose in the same way, so it is dropped rather than
# looked up. Doing it by shape means a later family added the same way needs no edit here.
doc_codes=""
for code in $raw_doc; do
  stripped=${code%_}
  is_prefix=0
  for other in $raw_doc; do
    [ "$other" = "$code" ] && continue
    case "$other" in "$stripped"_*) is_prefix=1; break ;; esac
  done
  [ "$is_prefix" -eq 0 ] && doc_codes="$doc_codes $stripped"
done
doc_codes=$(printf '%s\n' $doc_codes | sort -u)

[ -n "$doc_codes" ] || { echo "FAIL: the page names no error codes at all." >&2; exit 1; }
[ -n "$src_codes" ] || { echo "FAIL: found no error codes in the packed dists." >&2; exit 1; }

missing=0
for code in $doc_codes; do
  printf '%s\n' "$src_codes" | grep -qx "$code" || {
    echo "FAIL: the page documents $code and no shipped package can emit it." >&2
    missing=1
  }
done
[ "$missing" -eq 0 ] || exit 1
echo "    every one of $(printf '%s\n' $doc_codes | wc -l | tr -d ' ') documented codes exists in a shipped package"

# The other direction. A code a package can emit and the page never mentions is a user reading a
# code with nothing to look up. Exemptions are named here rather than assumed, so adding one is a
# decision visible in a diff.
#
#   DRZL_CLI_*         per-command wrappers, whose text is the underlying error's. The page
#                      documents the underlying codes, which is what a reader sees quoted.
#   DRZL_HIDE_SPONSOR  an environment variable, not an error code.
undocumented=0
for code in $src_codes; do
  case "$code" in
    DRZL_CLI_*|DRZL_HIDE_SPONSOR) continue ;;
  esac
  printf '%s\n' "$doc_codes" | grep -qx "$code" || {
    echo "FAIL: $code can be emitted and the troubleshooting page never mentions it." >&2
    undocumented=1
  }
done
[ "$undocumented" -eq 0 ] || exit 1
echo "    every code a shipped package can emit is on the page"

# ---------------------------------------------------------------------------------------------
# And the half a grep cannot do: produce the errors and read what comes out.
# ---------------------------------------------------------------------------------------------
cd "$APP"
PROBE="$APP/.troubleshooting-probe"
rm -rf "$PROBE"; mkdir -p "$PROBE"

# A path that is not there. This is the one the check above found undocumented.
out=$(npx drzl analyze "$PROBE/not-here.ts" 2>&1 || true)
printf '%s' "$out" | grep -q 'DRZL_ANL_NOFILE' || {
  echo "FAIL: a missing schema file no longer reports DRZL_ANL_NOFILE. It said:" >&2
  printf '%s\n' "$out" >&2; exit 1
}
echo "    a missing schema file still reports DRZL_ANL_NOFILE"

# A schema module that cannot be imported, through both commands.
#
# The two answer differently and the page documents both, which is the point of checking both:
# `analyze` reports the analyzer's own `DRZL_ANL_IMPORT` in its issues and exits non-zero, while
# `generate` refuses with the CLI's `DRZL_SCHEMA_001`. Asserting only one of them is how the first
# version of this stage failed, against a CLI that was behaving correctly.
printf "import { nope } from 'a-package-that-does-not-exist';\nexport const t = nope;\n" \
  > "$PROBE/broken.ts"
out=$(npx drzl analyze "$PROBE/broken.ts" 2>&1 || true)
printf '%s' "$out" | grep -q 'DRZL_ANL_IMPORT' || {
  echo "FAIL: analyze on an unimportable schema no longer reports DRZL_ANL_IMPORT. It said:" >&2
  printf '%s\n' "$out" >&2; exit 1
}
cat > "$PROBE/broken.config.ts" <<'CFG'
export default { schema: './.troubleshooting-probe/broken.ts', generators: [{ kind: 'zod' }] };
CFG
out=$(npx drzl generate --config "$PROBE/broken.config.ts" 2>&1 || true)
printf '%s' "$out" | grep -q 'DRZL_SCHEMA_001' || {
  echo "FAIL: generate on an unimportable schema no longer reports DRZL_SCHEMA_001. It said:" >&2
  printf '%s\n' "$out" >&2; exit 1
}
echo "    an unimportable schema still reports DRZL_ANL_IMPORT to analyze and DRZL_SCHEMA_001 to generate"

# The generator-kind list, which is the quoted text most likely to drift: every generator added
# changes it, and the page is a separate file nobody has to touch.
cat > "$PROBE/bad.config.ts" <<'CFG'
export default { schema: './x.ts', generators: [{ kind: 'zed' }] };
CFG
out=$(npx drzl generate --config "$PROBE/bad.config.ts" 2>&1 || true)
quoted=$(grep -oE '"[a-z-]+"\|' "$DOC" | tr -d '"|' | sort -u || true)
[ -n "$quoted" ] || { echo "FAIL: the page quotes no generator-kind list to compare." >&2; exit 1; }
for kind in $quoted; do
  printf '%s' "$out" | grep -q "\"$kind\"" || {
    echo "FAIL: the page lists '$kind' as a generator kind and the CLI no longer offers it." >&2
    printf '%s\n' "$out" >&2; exit 1
  }
done
echo "    the quoted generator-kind list matches what the CLI offers ($(printf '%s\n' $quoted | wc -l | tr -d ' ') kinds)"

rm -rf "$PROBE"
cd "$ROOT"
