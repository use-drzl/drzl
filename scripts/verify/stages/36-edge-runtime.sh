# ---------------------------------------------------------------------------------------------
# Does the emitted code run on an edge runtime?
#
# Cloudflare Workers, D1 and Turso are first-class drizzle targets, and a Worker has no Node
# builtins: an `import 'node:crypto'` is a deploy-time failure there, not a runtime one, so it is
# not something a consumer's tests would catch either. DRZL emits nothing of the sort today, and
# that was true by construction rather than by check, which is the difference this stage closes.
#
# The generators themselves import `node:path` and `node:fs` freely, and must: they run at build
# time on Node. What matters is the text they *write*, which is what this looks at.
#
# `nodejs_compat` exists and many Workers projects enable it. This still holds the emitted output to
# the stricter bar, because a generator has no way to know whether a given consumer turned it on,
# and emitting something that needs a flag nobody asked for is the kind of requirement that
# surfaces on someone's first deploy rather than in their editor.
# ---------------------------------------------------------------------------------------------
echo "==> emitted code imports no Node builtin"

# Static imports, dynamic imports and requires alike. `node:` is the unambiguous spelling; the bare
# names are checked separately below because `path` and `fs` are also ordinary package names.
if grep -rnE "(from|import|require)\s*\(?\s*['\"]node:" src/generated/ 2>/dev/null; then
  echo "FAIL: emitted code imports a Node builtin, which does not exist on an edge runtime." >&2
  exit 1
fi

# The bare spellings, which resolve to the builtin on Node and to nothing on a Worker. Anchored to
# a quote on both sides so `node_modules/path-to-regexp` and a local `./path` are not matched.
BARE="assert|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel"
BARE="$BARE|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks"
BARE="$BARE|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls"
BARE="$BARE|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib"
if grep -rnE "(from|import|require)\s*\(?\s*['\"]($BARE)['\"]" src/generated/ 2>/dev/null; then
  echo "FAIL: emitted code imports a Node builtin by its bare name." >&2
  exit 1
fi

# The check is only worth anything if it looked at something. A stage that greps an empty tree
# passes exactly as loudly as one that greps a clean one.
EMITTED=$(find src/generated -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
if [ "$EMITTED" -lt 20 ]; then
  echo "FAIL: only $EMITTED emitted files found under src/generated; the scan proved nothing." >&2
  exit 1
fi
echo "    $EMITTED emitted file(s) scanned, no Node builtin among them"

# And a control, so a broken pattern cannot pass by matching nothing. This writes a file that must
# be caught, greps for it with the same expression, and removes it either way.
PROBE="src/generated/.edge-probe.ts"
printf "import { createHash } from 'node:crypto';\nexport const h = createHash;\n" > "$PROBE"
if grep -rqnE "(from|import|require)\s*\(?\s*['\"]node:" "$PROBE" 2>/dev/null; then
  rm -f "$PROBE"
else
  rm -f "$PROBE"
  echo "FAIL: the Node-builtin pattern did not match a file that plainly imports one." >&2
  exit 1
fi
echo "    the pattern was checked against a file that does import one"
