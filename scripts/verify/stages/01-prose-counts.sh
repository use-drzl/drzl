# ---------------------------------------------------------------------------------------------
# Prose in this gate that writes down a quantity a declaration in it already holds.
#
# The whole design here is that quantities are asserted against a run or printed by one, and the
# gate has still collected sentences restating a ledger size, a rejection count or the length of
# the pool. They go stale as a group rather than one at a time: adding a handful of pool values
# falsified more than a dozen of them in a single edit, and each of the two rounds that swept them
# out wrote a fresh one into the very paragraph doing the sweeping.
#
# A warning and not a gate, and that is measured rather than preferred. The broad formulation, a
# cardinal standing next to a ledger noun, flags dozens of comment blocks here with the
# sweep already done, almost all of them ordinary prose, and it still misses the survivors that
# read "the counts printed below are N of M" and "N ALLOWED entries", because neither puts a
# cardinal next to a noun such a pattern knows. A gate at that hit rate is waived into a no-op
# within a week. This gate already carries one warning that cries wolf, on columns the analyzer
# cannot name, and it is filed as a defect rather than trusted.
#
# So what runs is the closed set of idioms these sentences are actually written in, and it is
# deliberately not exhaustive. The form "the six columns in that state" is outside it, and was
# left outside rather than covered at the cost of flagging every paragraph containing a number
# word. Each hit is printed with its line range and the words that matched, so a reader settles it
# rather than counts it, and nothing here is waivable: an idiom nobody wants flagged is a sentence
# to rewrite, not an exemption to declare.
#
# Both directions were run rather than argued, and both are recorded in the round-4 section of
# `.superpowers/sdd/2026-08-03-top-100/task-9-report.md`: a planted sentence of the species is
# named inside the block it was planted in, and on the corpus as it stands this prints a short list
# rather than nothing, with a verdict recorded there for every entry on it.
# ---------------------------------------------------------------------------------------------
echo "==> prose that writes down a number a declaration already holds"
# The corpus is every file this gate is written in: the entry point, the stage bodies, the
# harnesses and the fixtures. Derived from the directory rather than enumerated, because a
# list of files is the thing that silently stops covering a file somebody adds.
prose_files=("$ROOT/scripts/verify-packed.sh")
while IFS= read -r prose_file; do prose_files+=("$prose_file"); done < <(find "$VERIFY" -type f | sort)
# Never a gate, including when node itself fails: a warning that can abort the run is a gate with
# an undeclared failure mode, and this one runs before anything has been built.
node "$HARNESS/prose-counts.mjs" "${prose_files[@]}" || true
