# ---------------------------------------------------------------------------------------------
# The numbers the published documentation quotes, against the run that produced them.
#
# Until this existed nothing in the project checked a number in the documentation. Measured rather
# than assumed: `9.9999999999999999e42` substituted for the float4 bound in the shipped TypeBox
# page left `pnpm lint`, `pnpm typecheck`, every package test, `pnpm -C docs build` and
# `scripts/extract-doc-configs.mjs` all at exit 0, and that last one is the only docs-aware stage
# in the whole gate: it reads runnable config blocks and cannot see a table or a paragraph.
#
# It is not a documentation test framework, and it does not try to be. It covers exactly one
# thing, the block in benchmarks.md that quotes this gate's own output, which is the only prose
# in the docs whose numbers this run also computes. That block was stale when this check was
# written: it claimed `DRZL 1007, drizzle-orm 979` and `closer on 28` for a run that had been
# printing 1012 and 33 since the commit that changed the float bounds, and five rounds of review
# had read the same branch without noticing. Every other number in the docs is still unchecked and
# still has nothing behind it.
#
# The comparison is line by line and literal, so a fabricated digit fails rather than a fabricated
# sentence. Lines about MySQL are skipped, by name and out loud, when no MYSQL_URL is set: that
# stage did not run, so this run has nothing to compare them with.
#
# Both controls were run against a captured run log before this shipped. `DRZL 1048` changed to
# `DRZL 9999` in the page exits 1 naming that line. The vacuity control matters more, because this
# check finds its block by a phrase in the prose above it: editing "three real databases" to
# "three actual databases" makes the extraction return nothing, and the count guard below exits 1
# rather than reporting that everything matched.
echo "==> the numbers the documentation quotes, against this run"
# The corpus is $WORK/printed.log, which every stage a documented page may quote appends to: the
# six database-truth harnesses, both parity passes and the cross-major pass. A page quoting a line
# from a stage that does not append there cannot be checked, and the per-block guard below would
# report it as a dead anchor rather than as an unquotable line, so keep the two in step.
# Each entry is <file>|<phrase>: the first fenced block after <phrase> in that file is compared.
# The phrase is matched with awk's index() rather than as a pattern, so a phrase carrying
# punctuation cannot quietly become a regex that matches somewhere else.
DOC_BLOCKS=(
  "docs/guide/benchmarks.md|three real databases"
  "docs/guide/verification.md|Lines from the run behind this page"
  "docs/guide/comparison.md|the run behind this page printed"
)
# The defect table further down comparison.md is deliberately not here. It is assembled from this
# script's own DEFECTS ledger rather than quoted from output: the run prints the counts and stays
# silent about the columns themselves, because a ledgered defect reproducing is the quiet case.
# Listing it here would fail every run over lines no run ever prints.
doc_missing=0
doc_checked=0
doc_skipped=0
for doc_entry in "${DOC_BLOCKS[@]}"; do
  doc_rel="${doc_entry%%|*}"
  doc_phrase="${doc_entry#*|}"
  doc_seen=0
  while IFS= read -r doc_line; do
    doc_trim="$(printf '%s' "$doc_line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$doc_trim" ] && continue
    doc_seen=$((doc_seen + 1))
    if [ -z "${MYSQL_URL:-}" ] && printf '%s' "$doc_trim" | grep -q 'MySQL'; then
      doc_skipped=$((doc_skipped + 1))
      echo "    not compared, that stage did not run without MYSQL_URL: $doc_trim"
      continue
    fi
    if [ "$DRIZZLE_PINS_OVERRIDDEN" = 1 ] && printf '%s' "$doc_trim" | grep -q 'drizzle-orm'; then
      doc_skipped=$((doc_skipped + 1))
      echo "    not compared, this run overrode the drizzle-orm pins: $doc_trim"
      continue
    fi
    doc_checked=$((doc_checked + 1))
    if ! grep -Fq -- "$doc_trim" "$WORK/printed.log"; then
      if [ "$doc_missing" -eq 0 ]; then
        echo "    FAIL: the documentation quotes this script's output, and this run did not"
        echo "          print these lines. Paste what the run printed, or say what changed:"
      fi
      echo "      $doc_rel: $doc_trim"
      doc_missing=$((doc_missing + 1))
    fi
  done < <(awk -v p="$doc_phrase" 'index($0,p)>0{found=1} found && /^```$/{n++; next} found && n==1' "$ROOT/$doc_rel")
  # Per block, not once at the end. A dead anchor in one file would otherwise hide behind another
  # file's matches and the run would report that everything matched. Counted on lines extracted
  # rather than lines compared, so a block that is entirely MySQL lines does not read as dead on a
  # run without MYSQL_URL.
  if [ "$doc_seen" -eq 0 ]; then
    echo "    FAIL: found no quoted lines in $doc_rel after the phrase \"$doc_phrase\", so this" >&2
    echo "          check measured nothing there. The prose above the block was probably edited." >&2
    exit 1
  fi
done
if [ "$doc_missing" -gt 0 ]; then
  echo "FAIL: the documentation quotes numbers this run did not produce." >&2
  exit 1
fi
echo "    $doc_checked line(s) across ${#DOC_BLOCKS[@]} documented block(s) matched this run's output, $doc_skipped not compared"
