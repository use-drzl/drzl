import { SchemaAnalyzer } from '@drzl/analyzer';

/**
 * What the analyzer makes of the 0.4x tree on its own, with no other major to compare against.
 *
 * The diff above is relative: it can only see the two majors disagreeing. This one is absolute,
 * and it is what still fires when they agree about something wrong. Measured: deleting both the
 * `PgEnumColumn` arm and the v1 path makes five enum columns `unknown` on both sides at once,
 * where the comparison above has nothing to say and this reports every one of them.
 */

/**
 * Columns 0.4x cannot name today. Filed, not tolerated: naming one makes its entry dead and
 * fails this check, so a fix cannot land quietly. When this map had entries, each carried one in
 * the DEFECTS map above too, which is the relative half of the same finding. It is empty now, and
 * the closing summary of this gate no longer claims otherwise.
 */
const KNOWN_UNNAMED: Record<string, string> = {
  // Empty, and that is a result rather than a reason to delete this check. Every Postgres class the
  // 0.4x path could not name has an arm now: `c_vector` and `n_vector` went first, then
  // `c_geometry`, `c_bit` and their nullable twins. Each entry died the moment its arm landed and
  // this stage named it.
  //
  // It still fails on the first column that comes back unnamed, which is the direction that matters
  // from here, and an empty map is the strongest form of that claim rather than the weakest.
};

// `npm init -y` leaves the project CommonJS, where tsx refuses a top-level await.
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

async function main() {
let bad = 0;

// The reason the matrix fixture loses a column on the way in. Asserted rather than trusted,
// because the whole justification for editing that file is that this export does not exist
// here, and a pin that moves to a release carrying it should say so instead of quietly
// analyzing 40 columns where the parity stage analyzes 41.
const pgCore: Record<string, unknown> = await import('drizzle-orm/pg-core');
if (typeof pgCore.bytea === 'function') {
  console.error('    FAIL: this drizzle-orm exports `bytea`, so the matrix fixture no longer has');
  console.error('          to have it stripped. Drop the edit in the stage above and let this');
  console.error('          fixture carry the column.');
  bad++;
}

const cols: Array<{ table: string; name: string; tsType: string; dbType: string; arrayDimensions?: number }> = [];
for (const file of ['src/schema.ts', 'src/matrix.ts', 'src/mysql-text.ts']) {
  const a = await new SchemaAnalyzer(file).analyze({});
  for (const t of a.tables) {
    for (const c of t.columns) cols.push({ table: t.name, ...c });
  }
}
if (!cols.length) {
  console.error('FAIL: no columns analyzed on drizzle-orm 0.4x at all.');
  process.exit(1);
}

// A column the analyzer cannot name is the shape this failure takes: nothing throws, the
// generators emit `z.unknown()`, and every row validates.
const named = (c: { table: string; name: string }) => `${c.table}.${c.name}`;
const usedKnown = new Set<string>();
const vague = cols.filter((c) => {
  if (c.tsType !== 'unknown' && c.dbType !== 'UNKNOWN') return false;
  if (KNOWN_UNNAMED[named(c)]) {
    usedKnown.add(named(c));
    return false;
  }
  return true;
});
const arrays = cols.filter((c) => c.name.match(/^(tags|scores|moods|grid|c_text_arr|c_int_arr|c_enum_arr|c_varchar_arr)$/));
const notArrays = arrays.filter((c) => !c.arrayDimensions);

console.log(
  `    ${cols.length} columns analyzed on drizzle-orm 0.4x, ${vague.length} unnamed ` +
    `beyond the ${Object.keys(KNOWN_UNNAMED).length} filed as defects`
);

if (vague.length) {
  console.error('    FAIL: analyzed as unknown on 0.4x:');
  for (const c of vague) console.error(`      ${named(c)} (${c.dbType})`);
  bad++;
}
const deadKnown = Object.keys(KNOWN_UNNAMED).filter((k) => !usedKnown.has(k));
if (deadKnown.length) {
  console.error('    FAIL: these columns are named on 0.4x now, so their entries describe a');
  console.error('          defect that no longer happens. Delete them, here and in the DEFECTS');
  console.error('          map of the comparison above:');
  for (const k of deadKnown) console.error(`      ${k}`);
  bad++;
}
if (!arrays.length) {
  console.error('    FAIL: the fixture has no array columns, so nothing was checked for one.');
  bad++;
}
if (notArrays.length) {
  console.error('    FAIL: an .array() column carries no dimension:');
  for (const c of notArrays) console.error(`      ${named(c)}`);
  bad++;
}
const grid = cols.find((c) => c.name === 'grid');
if (!grid || grid.arrayDimensions !== 2) {
  console.error(`    FAIL: text().array().array() reported ${grid?.arrayDimensions} dimensions, not 2`);
  bad++;
}
if (bad) process.exit(1);
}
