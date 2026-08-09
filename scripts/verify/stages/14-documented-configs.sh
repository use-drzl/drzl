# ---------------------------------------------------------------------------------------------
# Every config the documentation tells a reader to write.
#
# Two rounds of defects were "the docs show a config that does not work", both found by hand:
# the getting-started guide emitted three imports resolving to nothing, and validation-mix.md
# had the same shape. Anything a reader can copy is run here instead.
# ---------------------------------------------------------------------------------------------
echo "==> running every documented config"
node "$ROOT/scripts/extract-doc-configs.mjs" "$ROOT/docs" > /tmp/doc-configs.json
doc_total="$(node -e "process.stdout.write(String(require('/tmp/doc-configs.json').length))")"
[ "$doc_total" -gt 0 ] || { echo "FAIL: no runnable configs found in docs; the extractor is broken." >&2; exit 1; }

# Each config gets a probe directory of its own and they are run four at a time. They shared
# one directory and ran in sequence, which was the whole reason they had to: the stage cost
# 29 seconds of a run that is otherwise 154. Nothing here is shared between two configs bar the
# extracted JSON they all read.
#
# The verdicts are printed afterwards in index order rather than as they arrive, so the stage
# says the same thing in the same order however the four workers interleave.
DOC_OUT="$WORK/docs-out"
rm -rf "$DOC_OUT" docs-probe && mkdir -p "$DOC_OUT"
export DOC_OUT FIXTURES HARNESS
if ! seq 0 $((doc_total - 1)) | xargs -n 1 -P 4 bash "$VERIFY/doc-config-probe.sh"; then
  echo "FAIL: a documented-config probe exited non-zero without recording a verdict, so this" >&2
  echo "      stage cannot say which configs work." >&2
  exit 1
fi

doc_failed=0
for i in $(seq 0 $((doc_total - 1))); do
  cat "$DOC_OUT/$i.out"
  if [ -e "$DOC_OUT/$i.failed" ]; then doc_failed=$((doc_failed + 1)); fi
done
rm -rf docs-probe

if [ "$doc_failed" -ne 0 ]; then
  echo "FAIL: $doc_failed of $doc_total documented configs do not work as written." >&2
  echo "      A config a reader can copy has to produce code that compiles." >&2
  exit 1
fi
quoted "    all $doc_total documented configs generate and typecheck"
