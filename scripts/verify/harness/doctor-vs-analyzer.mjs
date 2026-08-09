/**
 * `drzl doctor`, against the analyzer it is reporting on.
 *
 * Reads the two JSON reports the stage has already produced from the packed CLI: argv[2] is
 * `drzl analyze --json`, argv[3] is `drzl doctor --json`.
 */
import { readFile } from 'node:fs/promises';
const analysis = JSON.parse(await readFile(process.argv[2], 'utf8'));
const report = JSON.parse(await readFile(process.argv[3], 'utf8'));

const fromAnalyzer = new Set(
  (analysis.issues ?? []).filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN').map((i) => i.path)
);
// Doctor splits the analyzer's dotted path into a table field and a column field, which is the
// better shape for a consumer and means the two sides are not directly comparable. Rejoining here
// rather than asking doctor to carry both: a report with two spellings of one fact is a report
// where they can disagree.
//
// This was a double-quoted `node -e` argument in the shell until the split, where a backtick is
// command substitution: a comment mentioning one ran the real /usr/bin/column, which blocked
// reading stdin and hung the whole run with no output and no error. Being a file is what retires
// that hazard, and it is written down because the same shape is still live in every `node -e` and
// `node -p` the gate has left.
const fromDoctor = new Set(
  (report.findings ?? [])
    .filter((f) => f.kind === 'unknown-column')
    .map((f) => [f.table, f.column].filter(Boolean).join('.'))
);

const missing = [...fromAnalyzer].filter((x) => !fromDoctor.has(x));
const invented = [...fromDoctor].filter((x) => !fromAnalyzer.has(x));
if (missing.length || invented.length) {
  if (missing.length) console.error('    FAIL: the analyzer cannot type these and doctor is silent about them:');
  for (const m of missing) console.error('      ' + m);
  if (invented.length) console.error('    FAIL: doctor reports these and the analyzer typed them fine:');
  for (const i of invented) console.error('      ' + i);
  process.exit(1);
}
// Both empty compares equal, so the equality alone is satisfied by a fixture with nothing wrong
// and by a doctor that reports nothing whatever it is given. The fixture above guarantees one
// untypeable column; this is what notices if it ever stops doing so.
if (fromAnalyzer.size === 0) {
  console.error('    FAIL: the fixture produced no untypeable column, so the comparison above');
  console.error('          compared two empty sets and proved nothing.');
  process.exit(1);
}
const declined = (report.findings ?? []).filter((f) => f.kind === 'check-declined');
if (declined.length === 0) {
  console.error('    FAIL: the fixture CHECK uses OR, which no generator translates, and doctor');
  console.error('          did not report it. Silence about an unenforced constraint is the');
  console.error('          failure this command exists to prevent.');
  process.exit(1);
}
console.log(
  '    ' + fromDoctor.size + ' untypeable column(s) named identically by both, and ' +
    declined.length + ' unenforced CHECK(s) reported'
);
