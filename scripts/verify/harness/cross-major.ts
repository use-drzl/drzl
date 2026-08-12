import { readFileSync } from 'node:fs';

/**
 * The same three schema files, analyzed under both drizzle majors, have to describe the same
 * columns.
 *
 * This is the systematic form of the bug that prompted the stage: the analyzer read v1's array
 * signal and not 0.4x's, so `.array()` columns were `unknown` on the version most people have.
 * A per-field diff catches every instance of that shape at once, including the ones nobody has
 * thought to write a test for.
 *
 * Two maps, because two different things are being said about a difference:
 *
 *   ALLOWED  the majors really do differ here, and DRZL reflects each one correctly.
 *   DEFECTS  the analyzer reads one major and not the other. Filed rather than fixed, and
 *            reported on every run.
 *
 * An entry in either that suppresses nothing fails this stage, so fixing a defect forces its
 * entry out instead of leaving a sentence behind that describes something nobody can observe.
 *
 * What it cannot catch is both majors being wrong the same way, which is why the unnamed-column
 * check below is separate rather than folded in. Measured, in both directions, because the
 * sentence that used to stand here was false: deleting the analyzer's `PgEnumColumn` arm does
 * *not* go unnoticed here, since v1 reads its enums through `describeV1Column` and keeps saying
 * `string` while 0.4x starts saying `unknown`, which is ten differences on this fixture.
 *
 * The state where it does go quiet takes deleting the v1 path as well. With `describeV1Column`
 * returning null on top of that deletion, five enum columns read `unknown` on both sides and
 * this comparison says nothing about any of them; that mutation is not silent overall, since
 * dropping the v1 path also drops v1's `arrayDimensions` and leaves two differences on the two
 * enum *array* columns, but the enum defect itself is invisible here and the check below names
 * all five. The old sentence read as measured because it was: against a run comparing 0.45.2
 * with itself, where every mutation stays silent.
 */
const ALLOWED: Record<string, string> = {
  // `.array().array()` is two dimensions in 0.4x and one in v1, and DRZL repeats each major
  // faithfully rather than choosing. v1's `array()` takes the depth as a string, so
  // `.array('[][]')` is the 2D spelling and a chained `.array()` sets `'[]'.length / 2 = 1`
  // however often it is repeated. Confirmed against the first-party validator of each major on
  // this exact column: drizzle-zod 0.8.3 on 0.45.2 accepts [['a']] and rejects ['a'], and
  // drizzle-orm/zod on 1.0.0-rc.4 does the opposite. v1 also infers `string[]`, not `string[][]`.
  'rows.grid.arrayDimensions': "v1 spells 2D `.array('[][]')`; chaining `.array()` stays at 1",
  // `sqlType` follows `arrayDimensions` for the same reason and on the same column: 0.4x's PgArray
  // answers `text[][]` for a chained `.array().array()`, while v1 stays one dimension deep and
  // answers the bare `text`, which the analyzer suffixes to `text[]`. Each is the type of the
  // schema that major actually produces, so this is the divergence already recorded above showing
  // up in a second field rather than a new one.
  'rows.grid.sqlType': "v1 spells 2D `.array('[][]')`; chaining `.array()` stays at 1",
};

/**
 * Differences that are DRZL defects rather than differences between the majors.
 *
 * Every one of these is the analyzer describing a column correctly under one major and not the
 * other, so they are exactly what this stage was built to surface. They are named rather than
 * fixed here because this stage is a diff, and a diff cannot say which side is right.
 *
 * The gate that can is the 0.4x parity stage further down, which measures DRZL's emitted
 * validators against the first-party modules for 0.45.2 the way the stage near the top of this
 * file does for v1. It carries three of these columns in its own DEFECTS map, so a fix has to
 * clear an entry there as well as here. That gate is what made the first fixes possible: the
 * float bounds and the point and line tuples were filed here for a round because nothing could
 * show that changing the 0.4x path was right, and both left this map through it.
 */
const DEFECTS: Record<string, string> = {
  // ---- 0.4x names the SQL type coarsely, and once v1 does ------------------------------------
  // 0.4x carries no `codec`, so the analyzer maps these off the class name, and that table folds
  // PgVarchar, PgChar and PgSmallInt into TEXT and INTEGER, PgDate into TIMESTAMP, and
  // PgInet/PgCidr/PgMacaddr into TEXT. `c_serial` runs the other way: 0.4x says SERIAL and v1
  // says INTEGER.
  //
  // A label, and nothing more, on this fixture. `dbType` is read in exactly one place outside the
  // analyzer, `isIntegerColumn`, which prefers the `integer` flag and only falls back to
  // `dbType === 'INTEGER'`. Measured by changing it rather than by reading the output: setting all
  // seventeen of the labels this group then held to the value v1 reports, in the analysis of the
  // 0.4x tree, and regenerating all three fixtures with the zod and JSON Schema generators
  // produces 29 byte-identical files. Reading the diff of the two majors' output instead would
  // have been wrong, and `matrix.c_real.dbType` is why: it sat in this group and in the float
  // group, so its output did change, for the float bounds rather than for the label. It is gone
  // from both now, because `PgReal` reaches an arm of its own and is named REAL on 0.4x too.
  'rows.small.dbType': 'label only: PgSmallInt is named INTEGER on 0.4x',
  'rows.name.dbType': 'as rows.small.dbType, PgVarchar as TEXT',
  'rows.code.dbType': 'as rows.small.dbType, PgChar as TEXT',
  'rows.day.dbType': 'as rows.small.dbType, PgDate as TIMESTAMP',
  'arrays.a_varchar_arr_null.dbType': 'as rows.name.dbType',
  'matrix.c_varchar.dbType': 'as rows.name.dbType',
  'matrix.c_char.dbType': 'as rows.code.dbType',
  'matrix.c_smallint.dbType': 'as rows.small.dbType',
  'matrix.c_serial.dbType': 'label only, the other way: 0.4x says SERIAL and v1 says INTEGER',
  'matrix.c_date_d.dbType': 'as rows.day.dbType',
  'matrix.c_date_s.dbType': 'as rows.day.dbType',
  'matrix.c_varchar_arr.dbType': 'as rows.name.dbType',
  'nullable.n_varchar.dbType': 'as rows.name.dbType',
  'matrix.c_inet.dbType': 'label only: PgInet is named TEXT on 0.4x',
  'matrix.c_cidr.dbType': 'as matrix.c_inet.dbType',
  'matrix.c_macaddr.dbType': 'as matrix.c_inet.dbType',
  'mtext.id.dbType': 'as rows.name.dbType, on MySQL: MySqlVarChar is named TEXT on 0.4x',

  // ---- a numeric column is unchecked on 0.4x -------------------------------------------------
  // The numeric pattern is DRZL's own, kept because a bare string accepts 'hello' for a column
  // Postgres refuses it in, which the ALLOWED entry in the parity harness records as verified
  // through PGlite. It is attached in the v1 arm only, so on 0.4x these three columns emit a bare
  // string and take 'hello' back.
  'rows.amount.format': 'the numeric pattern is attached on v1 only',
  'matrix.c_numeric.format': 'as rows.amount.format',
  'matrix.c_decimal.format': 'as rows.amount.format',

  // ---- geometry, bit and vector are unnamed on 0.4x ------------------------------------------
  // `c_geometry`, `c_bit`, `c_vector` and their nullable twins used to sit here, eighteen entries,
  // all of them the class-name path having no arm for the column. Every one is named now, the two
  // majors agree, and this stage retired them by name three columns at a time as the arms landed.
  //
  // The bit half is worth remembering rather than only recording: the first version of that arm
  // returned `dbType: 'TEXT'` where v1's codec says `BIT`, and this check left exactly
  // `c_bit.dbType` and `nullable.n_bit.dbType` standing while the other ten went stale. A ledger
  // asserted in both directions tells a fix from a half fix without anybody looking for the
  // difference.

  // ---- MySQL's text family carries no character cap on 0.4x ----------------------------------
  // v1's `MySqlText` states `length` equal to the type's cap, 255 for `tinytext` and 65535 for
  // `text`; 0.4x's leaves it undefined. The analyzer reads the declared length the same way on
  // both, at packages/analyzer/src/index.ts:907, with no dialect gate and no cap table, so the
  // difference is in the column object rather than in the reading of it.
  //
  // That is why this sat in ALLOWED for a round, and it is the wrong home, because the majors'
  // own validators do not differ here. drizzle-zod 0.8.3 on drizzle-orm 0.45.2 emits `max_length`
  // 255 / 65535 / 16777215 / 4294967295 on all four, off the text subtype (`column.textType`)
  // rather than off `length`, which is the same place DRZL's own 0.4x path gets `maxBytes` from.
  // So DRZL on 0.4x is looser than official on 0.4x here, and that is worth recording because the
  // column has a cap and DRZL's 0.4x answer claims it does not, not because looser is a direction
  // this map forbids: the parity passes count their looser entries and most run that way.
  //
  // Measured on the emitted files, since ALLOWED also claimed nothing was accepted on one side
  // and refused on the other. All five generators emit different source, and one differs in
  // verdict:
  //
  //   zod, valibot, arktype, typebox   v1 gains a code-point check of the same number as the
  //                                    byte check both majors emit, and it can never be the
  //                                    deciding one. UTF-8 spends at least one byte per code
  //                                    point, so bytes(v) >= codePoints(v) for every string, and
  //                                    a lone surrogate encodes as U+FFFD, three bytes for one
  //                                    code point, which leans the same way. The two caps are the
  //                                    same number on all four columns. So anything inside the
  //                                    byte cap is inside the character cap, and the check v1
  //                                    adds refuses nothing the check both majors emit accepts.
  //                                    That argument needs `maxBytes <= maxLength`, which is a
  //                                    property of the column rather than of the encoding, and
  //                                    the stage below asserts it instead of leaving it to luck.
  //
  //                                    Same verdicts, not the same behaviour. The two majors
  //                                    describe a rejection differently, so this is invisible
  //                                    only to a caller that reads the boolean. On 256 ascii into
  //                                    `t_tiny`: zod and valibot report one issue on 0.4x ("at
  //                                    most 255 bytes") and two on v1 (the character one first,
  //                                    then the byte one), arktype reports one on each and names
  //                                    the character cap on v1 where 0.4x names the byte cap, and
  //                                    typebox reports two against three under `Value.Errors`.
  //                                    Anything rendering validation errors sees a difference.
  //   json-schema                      no byte check to fall back on. v1 carries `maxLength` and
  //                                    0.4x carries no cap of any kind, so a 256 character
  //                                    `t_tiny` is accepted by the 0.4x document and refused by
  //                                    the v1 one. Official drizzle-zod refuses it on 0.4x too.
  //
  // Two defects meet in that last line. `maxBytes` is right on both majors; the JSON Schema
  // generator ignores it entirely, which is what leaves the 0.4x document with no cap at all,
  // and that gap is filed already from the round that measured it. The number 0.4x's `maxBytes`
  // carries is the number v1's `maxLength` carries on all four columns, so closing it would put
  // the same cap on both sides; the description would still differ and these four entries stay.
  //
  // Recorded alongside, since it means the v1 side is not the obviously correct one either:
  // v1's `length` on a MySqlText is a byte budget worn as a character length, which is what
  // packages/analyzer/src/index.ts:95 says `maxLength` cannot express. On v1's JSON Schema it is
  // the only cap and it is counted in characters, so a 64 emoji `t_tiny` is 256 bytes, over the
  // type's budget, and that document accepts it. Measured under ajv.
  'mtext.t_text.maxLength': 'no character cap on 0.4x, which official drizzle-zod does emit there',
  'mtext.t_tiny.maxLength': 'as mtext.t_text.maxLength',
  'mtext.t_medium.maxLength': 'as mtext.t_text.maxLength',
  'mtext.t_long.maxLength': 'as mtext.t_text.maxLength',
};

const a = JSON.parse(readFileSync(process.env.OLD_JSON!, 'utf8'));
const b = JSON.parse(readFileSync(process.env.NEW_JSON!, 'utf8'));

// Nothing is compared until the two sides prove they came from different majors. Each file
// carries the version read out of the tree that produced it, so this cannot be satisfied by
// believing an install line: it is the only reason the stage below is a comparison at all.
const major = (v: unknown) => (typeof v === 'string' && v ? v.split('.')[0] : '');
if (!major(a.drizzle) || !major(b.drizzle) || major(a.drizzle) === major(b.drizzle)) {
  console.error('    FAIL: this stage compares two drizzle-orm majors, and the two sides report');
  console.error(`          ${JSON.stringify(a.drizzle)} and ${JSON.stringify(b.drizzle)}.`);
  console.error('          A diff of one version against itself is green for the same reason a');
  console.error('          diff of a file against itself is.');
  process.exit(1);
}

const used = new Set<string>();
const diffs: string[] = [];
const suppressed: Array<{ key: string; defect: boolean }> = [];

/**
 * Fields this fixture can never fill in, so the guard below would name them every run.
 *
 * Each is a promise that nothing can populate the field, not that nobody has bothered, and it
 * dies the moment something does.
 */
const EMPTY_OK: Record<string, string> = {
  'table:meta': 'the analyzer writes `meta: {}` at one site and never puts anything in it',
  'column:defaultExpression': 'the analyzer writes `defaultExpression: undefined` and never sets it',
};
const emptyOkUsed = new Set<string>();

// Whether a value says anything at all. Two sides agreeing on `[]`, `{}`, `false` or nothing at
// all is not a comparison of that field, it is a comparison of its absence.
const meaningful = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === '' ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
  );
// Seeded from the field names each side reported producing, so a field that is `undefined`
// everywhere and therefore absent from the JSON is still held to the rule below.
const seen = new Map<string, boolean>();
for (const side of [a, b]) {
  if (!side.fields?.table?.length || !side.fields?.column?.length) {
    console.error('    FAIL: a description arrived without the field names it produced, so the');
    console.error('          guard below would have had nothing to check and would have passed.');
    process.exit(1);
  }
  for (const kind of ['table', 'column'] as const) {
    for (const f of side.fields[kind]) seen.set(`${kind}:${f}`, false);
  }
}

const compare = (kind: string, label: string, l: Record<string, unknown>, r: Record<string, unknown>) => {
  // The union of both sides' keys, so a field only one major produces is a difference rather
  // than something the loop never looks at. Reading `Object.keys(l)` alone is how a v1-only
  // field would go unexamined forever.
  for (const f of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const field = `${kind}:${f}`;
    seen.set(field, (seen.get(field) ?? false) || meaningful(l[f]) || meaningful(r[f]));
    const lv = JSON.stringify(l[f]);
    const rv = JSON.stringify(r[f]);
    if (lv === rv) continue;
    const key = `${label}.${f}`;
    if (ALLOWED[key] || DEFECTS[key]) {
      used.add(key);
      suppressed.push({ key, defect: !ALLOWED[key] });
      continue;
    }
    diffs.push(`${key}: 0.4x ${lv}, v1 ${rv}`);
  }
};

let compared = 0;
const names = [...new Set([...Object.keys(a.columns), ...Object.keys(b.columns)])];
for (const n of names) {
  const l = a.columns[n];
  const r = b.columns[n];
  if (!l || !r) {
    diffs.push(`${n}: present on ${l ? '0.4x' : 'v1'} only`);
    continue;
  }
  compared++;
  compare('column', n, l, r);
}

// Everything the analyzer says about the table rather than about one column: its primary key,
// its uniques, its indexes, its foreign keys and its parsed CHECK expressions. All of it is
// identical across the majors today, and none of it was compared before.
const tables = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])];
for (const t of tables) {
  const l = a.tables[t];
  const r = b.tables[t];
  if (!l || !r) {
    diffs.push(`table ${t}: present on ${l ? '0.4x' : 'v1'} only`);
    continue;
  }
  compare('table', `table:${t}`, l, r);
}

// A comparison that compared nothing must fail rather than print a reassuring number.
//
// Both fixtures have to have loaded on both sides, and every field either of them produces has
// to have carried a real value somewhere. The second half is the general form of a specific
// check that used to sit here for CHECK expressions alone, and it is here because the specific
// one was not enough: `unique`, `foreignKeys` and every column's `references` were `[]` or
// absent across the whole fixture, and this stage called them facts that agree across the
// majors.
//
// It holds every field the analyzer *assigns*, including the ones it assigns `undefined` to on
// every column, because the field names come from what it produced rather than from what
// survived serialisation. It cannot hold a field that is spread in conditionally and never
// fires, which is this analyzer's usual style for an optional one. Measured with a control
// either way: a field written `...(false ? { probe: 1 } : {})` never reaches the field list and
// this stage stays green, while the same field written `probe: undefined` is named and it fails.
//
// One field is outside it today:
//
//   readOnly   packages/analyzer/src/index.ts:1414, set for a materialized view. Adding one
//              covers the v1 side alone: `pgMaterializedView` answers a `drizzle:Columns`
//              lookup on 1.0.0-rc.4 and returns undefined on 0.45.2, so the analyzer sees no
//              0.4x view of any kind as a relation, and this stage would report the table as
//              present on v1 only. Covering `readOnly` means dealing with that first.
//
// `maxBytes` was the other, on the claim that no fixture this stage could carry would produce
// one, since the MySQL parity fixture cannot be imported under 0.45.2. That was an impossibility
// argued from a different fixture, and it was false: `src/mysql-text.ts` above uses the text
// family alone, imports on both majors and carries a cap on four columns, through
// packages/analyzer/src/index.ts:478 on v1 and the conditional spread at :1302 on 0.4x. Both
// sites are MySQL-gated, so "set only on MySQL" is the part of the old sentence that held.
const REQUIRED = [
  'rows', 'parents', 'children', 'pairs', 'notes', 'mtext', 'matrix', 'arrays', 'defaulted',
  'checked', 'nullable', 'guarded',
];
const missing = REQUIRED.filter((t) => !a.tables[t] || !b.tables[t]);
if (missing.length) {
  diffs.push(`these tables are missing from one side or both: ${missing.join(', ')}`);
}
if (!compared) diffs.push('no column was described on both sides, so nothing was compared');
// Kept specific as well as general. The rule below is satisfied by any table carrying a CHECK,
// and `checked` is the table whose entire purpose is to carry them. The two say the same thing
// only for as long as it is the only such table, and the general rule alone would let this one
// stop parsing them while something else went on carrying one.
if (!(a.tables.checked?.checks ?? []).length) {
  diffs.push('the checked table parsed no CHECK expressions, so nothing was compared');
}
// The same specific-as-well-as-general rule for row-level security, and for the same reason: the
// vacuity rule below is satisfied by any table carrying a policy, and `guarded` is the table whose
// entire purpose is to carry them. Its two policies between them cover every optional field the
// analyzer normalises, so an empty list here is a fixture that stopped testing the normalisation
// rather than a schema that stopped having policies.
if (!(a.tables.guarded?.policies ?? []).length) {
  diffs.push('the guarded table parsed no policies, so nothing was compared');
}
for (const [field, sawValue] of seen) {
  const noun = field.startsWith('table:') ? 'table' : 'column';
  if (sawValue) continue;
  if (EMPTY_OK[field]) {
    emptyOkUsed.add(field);
    continue;
  }
  diffs.push(
    `${field} was empty on both sides of every ${noun}, so comparing it proves nothing. ` +
      'Give the fixture one that carries a value.'
  );
}

// The precondition the four `mtext` entries above are argued from, made executable.
//
// That argument has two halves. One is a property of UTF-8 and cannot change. The other is
// `maxBytes <= maxLength` on the column, which is a property of what the analyzer read, and
// nothing held it: a column whose byte cap is above its character cap makes v1's character check
// the deciding one. With a 20 byte cap and a 10 character cap, 15 ascii characters pass the byte
// check and fail the other, so v1 refuses a value 0.4x takes and those entries stop describing a
// difference in wording alone.
//
// Nothing in this fixture can do that today, and the reason is drizzle's rather than the schema's:
// handing `text()` a `{ length: 10 }` moves neither major, because v1 overwrites it with the
// type's own cap and 0.4x carries no length on a text column at all. Both measured, at runtime, on
// the column object the analyzer reads. A choice that release makes is not a rule, which is why
// this is a check rather than one more sentence.
//
// A column carrying only one of the two caps is outside this: with no `maxLength` there is no
// character check to bind, and with no `maxBytes` there is no byte check to bind first.
const capChecked: string[] = [];
const capBroken: string[] = [];
for (const [side, doc] of [['0.4x', a], ['v1', b]] as const) {
  const cols = doc.columns as Record<string, Record<string, unknown>>;
  for (const [name, col] of Object.entries(cols)) {
    const bytes = col.maxBytes;
    const chars = col.maxLength;
    if (typeof bytes !== 'number' || typeof chars !== 'number') continue;
    capChecked.push(`${side} ${name}`);
    if (bytes > chars) capBroken.push(`${side} ${name}: maxBytes ${bytes} over maxLength ${chars}`);
  }
}

const defects = suppressed.filter((s) => s.defect);
const columnsWithDefects = [...new Set(defects.map((s) => s.key.replace(/\.[^.]+$/, '')))];
console.log(
  `    ${compared} columns and ${tables.length} tables compared, ` +
    `drizzle-orm ${a.drizzle} against ${b.drizzle}`
);
console.log(
  `    ${suppressed.length - defects.length} documented difference(s) between the majors, ` +
    `${defects.length} known-defect field(s) on ${columnsWithDefects.length} column(s)`
);
if (columnsWithDefects.length) {
  console.log(`    described differently per major: ${columnsWithDefects.join(', ')}`);
}
console.log(`    ${capChecked.length} column(s) carry both a byte cap and a character cap`);

// A waiver that suppresses nothing is a sentence claiming a difference exists, sitting next to
// the ones that do. Both maps are held to it, so fixing a defect fails this stage until its
// entry goes, which is the only thing keeping the DEFECTS map from becoming a place to put
// failures.
const dead = [
  ...Object.keys(ALLOWED).filter((k) => !used.has(k)).map((k) => `ALLOWED[${k}]`),
  ...Object.keys(DEFECTS).filter((k) => !used.has(k)).map((k) => `DEFECTS[${k}]`),
  // An EMPTY_OK entry is used by the field staying empty. One that is no longer needed means
  // the field now carries a value somewhere, which is the good outcome and still has to be
  // recorded by deleting the entry.
  ...Object.keys(EMPTY_OK).filter((k) => !emptyOkUsed.has(k)).map((k) => `EMPTY_OK[${k}]`),
];
if (dead.length) {
  console.error('    FAIL: these entries suppressed nothing on this run. If the analyzer was');
  console.error('          fixed, delete them; they now describe something nobody can observe:');
  for (const k of dead) console.error(`      ${k}`);
}

if (diffs.length) {
  console.error('    FAIL: the analyzer describes the same schema differently per major:');
  for (const d of diffs) console.error(`      ${d}`);
  console.error('\n    A generator reads these fields, so a difference here is a different schema.');
}

if (!capChecked.length) {
  console.error('    FAIL: no column carries both a byte cap and a character cap, so the rule');
  console.error('          above compared nothing. The four mtext entries are argued from it, so');
  console.error('          give the fixture a column carrying both or drop the argument.');
}
if (capBroken.length) {
  console.error('    FAIL: a byte cap is above the character cap on the same column, so the code');
  console.error('          point check v1 adds can refuse a value the byte check accepts, and the');
  console.error('          mtext entries above no longer describe a difference in wording alone:');
  for (const c of capBroken) console.error(`      ${c}`);
}

if (diffs.length || dead.length || capBroken.length || !capChecked.length) process.exit(1);
