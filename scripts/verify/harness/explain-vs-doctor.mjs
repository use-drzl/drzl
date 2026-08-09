/**
 * `drzl explain`, against the `drzl doctor` that reports the same silences.
 *
 * argv[2] is `drzl doctor --json`, argv[3] is `drzl explain --json`, both already produced by the
 * stage from the packed CLI.
 */
import { readFile } from 'node:fs/promises';
const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
const doc = JSON.parse(await readFile(process.argv[3], 'utf8'));

const gaps = doc.table.gaps ?? [];
const columns = new Set(gaps.filter((g) => g.kind === 'column').map((g) => g.subject));
const checks = new Set(gaps.filter((g) => g.kind === 'check').map((g) => g.subject));

const mine = (kind) => (report.findings ?? []).filter((f) => f.kind === kind && f.table === 'invoices');
const doctorColumns = new Set(mine('unknown-column').map((f) => f.column));
const doctorChecks = new Set(mine('check-declined').map((f) => f.constraint));

// Sets rather than lists: doctor reports one finding per declined clause and explain one gap per
// unenforced part, so the two can differ in count for one constraint while naming the same one.
// The question here is which constraints and columns each names, and that has one answer.
const differ = (a, b) => a.size !== b.size || [...a].some((x) => !b.has(x));
if (differ(columns, doctorColumns) || differ(checks, doctorChecks)) {
  console.error('    FAIL: doctor and explain disagree about the invoices table.');
  console.error('      doctor columns: ' + JSON.stringify([...doctorColumns]));
  console.error('      explain columns: ' + JSON.stringify([...columns]));
  console.error('      doctor checks: ' + JSON.stringify([...doctorChecks]));
  console.error('      explain checks: ' + JSON.stringify([...checks]));
  process.exit(1);
}
// Both empty compares equal, so the equality above is satisfied by a fixture with nothing wrong
// and by an explain that reports nothing whatever it is given. The fixture guarantees one of each.
if (!columns.size || !checks.size) {
  console.error('    FAIL: the fixture produced no untypeable column or no declined CHECK, so the');
  console.error('          comparison above compared empty sets and proved nothing.');
  process.exit(1);
}
// A verdict with no reason under it is a report that says a constraint is missing and leaves the
// reader no way to act. The reason comes off the shared parser, so an empty one here means explain
// has stopped carrying what that parser said rather than that the parser has stopped saying it.
const unreasoned = (doc.table.constraints ?? [])
  .flatMap((c) => (c.unenforced ?? []).map((u) => [c.id, u.reason]))
  .filter(([, reason]) => !reason || !String(reason).trim());
if (unreasoned.length) {
  console.error('    FAIL: explain reported these constraints as unenforced and gave no reason:');
  for (const [id] of unreasoned) console.error('      ' + id);
  process.exit(1);
}
console.log(
  '    ' + columns.size + ' untypeable column(s) and ' + checks.size +
    ' unenforced CHECK(s), named identically by doctor and explain'
);
