# The generated routers have to import each other without deadlocking on module initialisation.
# Cross-table lookups reference another router's schema, which is circular the moment both
# directions exist, and an eager reference throws "Cannot access X before initialization" at
# import time while typechecking perfectly. Only loading the graph catches it.
echo "==> loading the generated router graph"
cp "$HARNESS/load-probe.mjs" load-probe.mjs
if ! npx tsx load-probe.mjs; then
  echo "FAIL: the generated routers could not be imported. A circular reference between them" >&2
  echo "      is evaluated at module scope rather than deferred." >&2
  exit 1
fi
rm -f load-probe.mjs
